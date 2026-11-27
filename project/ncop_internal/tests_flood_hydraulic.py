# Unit tests for the flood-wave model, susceptibility helpers, probability scores,
# action tracker, timing, register and briefs. No network, no Earth Engine.
#   python manage.py test ncop_internal.tests_flood_hydraulic
import tempfile
from datetime import datetime, timedelta, timezone
from unittest import mock

import numpy as np
from django.test import RequestFactory, SimpleTestCase, override_settings

from . import flood_ews as fw
from . import flood_hydraulic as fh
from . import flood_inertial as fi
from . import flood_ops as ops
from . import flood_routing as fr
from . import flood_store as fs
from . import flood_suscept as su

NOW = datetime(2026, 8, 10, 6, 0, tzinfo=timezone.utc)


def _valley(ny=30, nx=80, slope=2e-4, dx=500.0):
    """A valley falling to the east with a channel down the middle."""
    x = np.arange(nx) * dx
    side = np.abs(np.arange(ny) - ny // 2) * 0.3
    return (100 - slope * x)[None, :] + side[:, None]


class InertialTests(SimpleTestCase):
    def test_closed_basin_keeps_every_drop_and_ends_level(self):
        z = np.full((20, 20), 5.0)
        z[2:-2, 2:-2] = 0.0                                                  # a bowl: nothing can leave
        z[10:-2, 2:-2] = 0.2
        r = fi.simulate(z, np.full_like(z, 0.03), 200, 200, lambda t: 1500.0 if t < 7200 else 0.0, [(9, 9)], 30)
        self.assertAlmostEqual(r["stored"] / r["vin"], 1.0, places=4)
        self.assertEqual(r["vout"], 0.0)
        eta = (z + r["h"])[r["h"] > 0.05]
        self.assertLess(float(eta.std()), 0.02)                              # the scheme keeps a ripple of about a centimetre

    def test_water_balance_with_outflow(self):
        z = _valley()
        r = fi.simulate(z, np.full_like(z, 0.04), 500, 500, fi.hydrograph(3000, 200), [(15, 3)], 60)
        self.assertGreater(r["vout"], 0)
        self.assertAlmostEqual((r["stored"] + r["vout"]) / r["vin"], 1.0, places=4)
        self.assertTrue(np.isfinite(r["depth"]).all() and (r["depth"] >= 0).all())

    def test_steady_flow_matches_manning(self):
        """A wide plane with uniform inflow settles at Manning's normal depth."""
        ny, nx, dx, s, n, q = 5, 120, 200.0, 1e-3, 0.05, 1.5                 # q m2/s
        z = np.repeat((50 - s * np.arange(nx) * dx)[None, :], ny, 0)
        wall = np.full((1, nx), 60.0)
        z = np.vstack([wall, z, wall])
        src = [(i, 1) for i in range(1, ny + 1)]
        z[:, 0] = 60.0
        r = fi.simulate(z, np.full_like(z, n), dx, dx, lambda t: q * dx * ny, src, 20)
        want = (q * n / s ** 0.5) ** 0.6
        self.assertAlmostEqual(float(r["h"][3, 50:70].mean()), want, delta=0.06 * want)

    def test_water_arrives_later_further_away_and_bigger_floods_go_deeper(self):
        z = _valley()
        n = np.full_like(z, 0.04)
        a = fi.simulate(z, n, 500, 500, fi.hydrograph(1500, 200), [(15, 3)], 60)
        b = fi.simulate(z, n, 500, 500, fi.hydrograph(6000, 200), [(15, 3)], 60)
        t = [a["arrive"][15, c] for c in (10, 30, 50)]
        self.assertTrue(t[0] < t[1] < t[2])
        self.assertGreater(b["depth"][15, 30], a["depth"][15, 30])
        self.assertGreater((b["depth"] > 0.3).sum(), (a["depth"] > 0.3).sum())

    def test_hydrograph_shape(self):
        q = fi.hydrograph(1000, 100)
        self.assertEqual([round(q(3600 * h)) for h in (0, 36, 48, 96)], [100, 1000, 1000, 550])


class CatalogueTests(SimpleTestCase):
    def test_reaches_are_consistent(self):
        for sid, (_, lon, lat, hours) in fh.REACHES.items():
            self.assertIn(sid, fs.IDS)
            self.assertIsNotNone(fs.limits(sid))
            w, s, e, n = fh.box(sid)
            for x, y in ((lon, lat), fh.POS[sid]):
                self.assertTrue(w < x < e and s < y < n)
            self.assertTrue(100 < hours < 500)
        for sid, *_ in fh.TESTS:
            self.assertIn(sid, fh.REACHES)

    def test_scores(self):
        a, b = np.zeros((10, 10), bool), np.zeros((10, 10), bool)
        a[:, :6], b[:, 2:8] = True, True
        self.assertEqual(fh.scores(a, b, np.ones((10, 10), bool)), {"csi": 0.5, "found": 0.67, "dry": 0.33})

    def test_mercator_rows_keep_the_ends(self):
        r = fh.mercator_rows(23.5, 37.0, 500)
        self.assertEqual((r[0], r[-1]), (0, 499))
        self.assertTrue((np.diff(r) >= 0).all())

    def _cat(self):
        sc = lambda p: {"flow": 400_000, "label": "x", "people": p, "people_upper": 2 * p, "deep_people": 1, "km2": 5, "km2_upper": 9, "map": "m.png", "districts": [{"name": "Jhang", "people": p, "people_upper": 2, "first_h": 10, "half_h": 20, "depth_m": 1.1, "deep_people": 1, "km2": 5}]}
        return {"built": "2026-11-24", "wave": "w", "depth_classes": [], "tests": [], "reaches": {
            "qadirabad": {"station": "Qadirabad", "river": "Chenab", "to": "Trimmu", "bbox": [0, 0, 1, 1], "scenarios": {"high": sc(10), "very_high": sc(50), "exceptional": sc(90)}},
            "nowshera": {"station": "Nowshera", "river": "Kabul", "to": "Attock", "bbox": [0, 0, 1, 1], "scenarios": {"high": sc(10), "very_high": sc(99)}}}}

    def test_pick_follows_ffd_and_falls_back_to_planning(self):
        st = [{"id": "qadirabad", "tier": 0}, {"id": "nowshera", "tier": 0}]
        p = fh.pick(self._cat(), st)
        self.assertEqual((p["now"], p["plan"]), ([], ["nowshera", "qadirabad"]))
        st = [{"id": "qadirabad", "tier": 3, "ffd_tier": 5}, {"id": "nowshera", "tier": 5}, {"id": "sukkur", "tier": 5}]
        p = fh.pick(self._cat(), st)
        self.assertEqual([(n["id"], n["scenario"], n["why"]) for n in p["now"]], [("qadirabad", "exceptional", "FFD 24-hour forecast"), ("nowshera", "very_high", "FFD reading")])
        self.assertIn("districts", p["reaches"]["qadirabad"]["scenarios"]["exceptional"])
        self.assertIsNone(fh.pick(None, st))

    def test_low_and_medium_floods_have_no_wave(self):
        self.assertEqual([fh.scenario_for(t) for t in range(6)], [None, None, None, "high", "very_high", "exceptional"])


class SusceptibilityTests(SimpleTestCase):
    def test_auc(self):
        y = np.array([0, 0, 1, 1])
        self.assertEqual(su.auc(np.array([1, 2, 3, 4.0]), y), 1.0)
        self.assertEqual(su.auc(np.array([4, 3, 2, 1.0]), y), 0.0)
        self.assertEqual(su.auc(np.array([1, 1, 1, 1.0]), y), 0.5)
        self.assertIsNone(su.auc(np.ones(4), np.zeros(4)))

    def test_classes_and_frequency_ratio(self):
        a = np.arange(100.0).reshape(10, 10)
        v = np.ones_like(a, bool)
        c = su.classes(a, v, True)
        self.assertEqual((c.min(), c.max()), (1, 5))
        self.assertTrue((su.classes(a, v, False) == 6 - c).all())
        flooded = a >= 80
        self.assertEqual(su.frequency_ratio({"x": c}, flooded)["x"], [0.0, 0.0, 0.0, 0.0, 5.0])

    def test_distance(self):
        m = np.zeros((9, 9), bool)
        m[4, 4] = True
        d = su.distance(m)
        self.assertEqual((d[4, 4], d[4, 7]), (0.0, 3.0))


class ProbabilityTests(SimpleTestCase):
    def test_brier_rewards_skill_and_bins_add_up(self):
        rng = np.random.default_rng(1)
        n = 1500
        yr = np.repeat(np.arange(2020, 2025), n // 5)
        o = np.exp(rng.normal(11.8, 0.6, n))
        good = fr.probability_scores(o, o * np.exp(rng.normal(0, 0.1, n)), o * np.exp(rng.normal(0, 0.4, n)), yr, 200_000)
        bad = fr.probability_scores(o, rng.permutation(o), o, yr, 200_000)
        self.assertGreater(good["bss"], 0.6)
        self.assertLess(bad["bss"], 0.1)
        self.assertEqual(sum(b[0] for b in good["bins"]), good["n"])
        self.assertEqual(sum(b[2] for b in good["bins"]), good["floods"])

    def test_no_floods_gives_no_skill(self):
        r = fr.probability_scores(np.full(400, 1e4), np.full(400, 1e4), np.full(400, 1e4), np.repeat([1, 2], 200), 2e5)
        self.assertIsNone(r["bss"])


class OpsTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ov = override_settings(MEDIA_ROOT=self.tmp.name)
        ov.enable()
        self.addCleanup(ov.disable)

    def test_action_opens_is_reported_and_closes_by_itself(self):
        a = [{"id": "river-chenab", "title": "Act"}]
        ops.track(a, NOW)
        self.assertEqual((a[0]["status"], a[0]["by_whom"]), ("open", None))                     # never assumed done
        ops.report_status("river-chenab", "done", "PDMA Punjab", "embankments checked", NOW)
        b = [{"id": "river-chenab", "title": "Act"}]
        ops.track(b, NOW + timedelta(hours=6))
        self.assertEqual((b[0]["status"], b[0]["by_whom"], b[0]["opened"]), ("done", "PDMA Punjab", NOW.isoformat()))
        closed = ops.track([], NOW + timedelta(days=2))
        self.assertEqual([c["id"] for c in closed], ["river-chenab"])
        c = [{"id": "river-chenab", "title": "Act"}]
        ops.track(c, NOW + timedelta(days=9))                                                    # a new flood starts open again
        self.assertEqual(c[0]["status"], "open")

    def test_bad_reports_are_refused(self):
        ops.track([{"id": "x", "title": "t"}], NOW)
        for args, err in ((("nope", "done", "A"), KeyError), (("x", "finished", "A"), ValueError), (("x", "done", ""), ValueError)):
            with self.assertRaises(err):
                ops.report_status(*args)

    def test_every_action_has_a_trigger_an_end_and_an_id(self):
        st = [{"id": "marala", "name": "Marala", "river": "Chenab", "watch": 3, "q": 210_000.0, "limits": fs.limits("marala"), "reasons": [{"who": "FFD reading", "text": "High flood now"}], "districts": ["Sialkot"]}]
        ds = [{"name": "Rajanpur", "level": 1, "hazards": [{"hazard": "Hill torrent"}]}]
        res = [{"name": "Tarbela", "range_pct": 97}]
        out = fw.actions({}, st, ds, res, {"stations": 3, "online": 0, "in_season": True}, {"open": True}, None, None, [{"kind": "stale"}])
        self.assertEqual(len({a["id"] for a in out}), len(out))
        for a in out:
            self.assertTrue(a["trigger"] and a["closes"] and a["owner"] and a["by"])
        self.assertIn("210,000", out[0]["trigger"])

    def test_timing_marks_old_and_missing(self):
        lim = {"reading": 14, "glofas": 72, "floodhub": 36, "gefs": 60, "nwp": 48}
        t = ops.timing(NOW, lim, {"marala": {"time": (NOW - timedelta(hours=2)).isoformat()}}, {}, {"run": "2026-08-04", "to": "2026-08-19"}, None, None, (NOW - timedelta(hours=10)).isoformat(), None, None, {})
        s = {r["name"]: r["state"] for r in t}
        self.assertEqual((s["FFD river readings"], s["GloFAS river forecast"], s["Google Flood Hub"], s["GEFS district rain (NCOP)"]), ("valid", "too old", "missing", "valid"))

    def test_register_is_complete(self):
        for r in ops.register()["rows"]:
            self.assertEqual(len(r), 8)
            self.assertTrue(all(str(v).strip() for v in r.values()))

    def test_briefs_put_raised_districts_first(self):
        d = lambda n, p: {"name": n, "province": "Punjab", "people": 2 * p, "once": {"people": p, "crop_km2": 5}, "often": {"people": 1}, "places": {"schools": [3, 2, 1]}, "seen": {"2025": {"people": p, "km2": 50}}}
        atlas = {"observed_years": ["2025"], "districts": [d("Lahore", 900), d("Jhang", 500), d("Narowal", 100)]}
        st = [{"id": "qadirabad", "name": "Qadirabad", "river": "Chenab", "state": "current", "q": 5.0, "tier": 0, "limits": fs.limits("qadirabad"), "of_low": 0.1, "up": [["khanki", 6]]}]
        hyd = fh.pick(CatalogueTests()._cat(), [])
        out = ops.briefs(st, [{"name": "Narowal", "level": 2, "hazards": []}], None, atlas, None, hyd, {"qadirabad": ["Jhang"]}, set(), {"Lahore"}, set(), n=2)
        self.assertEqual([b["name"] for b in out], ["Narowal", "Lahore"])
        j = next(b for b in ops.briefs(st, [], None, atlas, None, hyd, {"qadirabad": ["Jhang"]}, set(), set(), set(), n=3) if b["name"] == "Jhang")
        self.assertEqual(([w["station"] for w in j["waves"]], j["rivers"][0]["up"]), (["Nowshera", "Qadirabad"], [["Khanki", 6]]))     # most people first
        self.assertEqual(ops.briefs(st, [], None, None, None, None, {}, set(), set(), set()), [])


class MapViewTests(SimpleTestCase):
    def test_only_known_maps_are_served(self):
        with tempfile.TemporaryDirectory() as tmp, override_settings(MEDIA_ROOT=tmp):
            get = lambda n: fw.FloodMapView.as_view()(RequestFactory().get("/x"), name=n)
            self.assertEqual(get("susceptibility").status_code, 404)                              # not built yet
            with open(f"{fh.directory()}/marala-high.png", "wb") as f:
                f.write(b"\x89PNG")
            with open(f"{fh.directory()}/secret.png", "wb") as f:
                f.write(b"x")
            r = get("marala-high")
            self.assertEqual((r.status_code, r["Content-Type"]), (200, "image/png"))
            r.close()
            for n in ("secret", "marala-low", "..-high"):
                self.assertEqual(get(n).status_code, 404)

    def test_old_weather_runs_are_left_out(self):
        self.assertEqual(fw.FRESH_H["nwp"], 48)
        with mock.patch.object(fw.fe, "rain_percentile", return_value=(None, None)), mock.patch.object(fw.fe, "soil_percentile", return_value=(None, None)), mock.patch.object(fw.fe, "snow_now", return_value=None):
            eo = {"last_obs": fs.day_index(NOW.date()) - 1, "last_smap": fs.day_index(NOW.date()) - 2, "gfs": np.zeros((7, 6, 5)), "ifs": np.ones((7, 6)), "roll_end": "", "gfs_now": np.ones((6, 7)),
                  "gfs_run": (NOW - timedelta(hours=6)).isoformat(), "ifs_run": (NOW - timedelta(hours=80)).isoformat()}
            r = fw.catchments(eo, NOW)["rows"][0]
        self.assertIsNotNone(r["gfs"])
        self.assertIsNone(r["ecmwf"])


class LikelyRuleTests(SimpleTestCase):
    def test_rule_follows_the_river_and_leaves_the_test_year_out(self):
        deep = np.ones((1, 4), bool)
        river = np.array([[False, False, False, True]])
        floods = {"2010": np.array([[1, 1, 0, 0]], bool), "2022": np.array([[1, 0, 0, 0]], bool), "2025": np.array([[0, 0, 1, 0]], bool)}
        self.assertEqual(fh.likely_mask("qadirabad", deep, floods, river).tolist(), [[True, True, True, True]])          # Chenab: flooded once
        self.assertEqual(fh.likely_mask("qadirabad", deep, floods, river, "2025").tolist(), [[True, True, False, True]])  # test year not used
        self.assertEqual(fh.likely_mask("guddu", deep, floods, river).tolist(), [[True, False, False, True]])           # Indus: two years
        self.assertTrue(fh.likely_mask("islam", deep, floods, river).all())                                               # Sutlej: all water
        for sid in fh.REACHES:
            self.assertIn(fs.STATIONS[sid][1], fh.LIKELY)

    def test_trust_grades(self):
        t = lambda r, c: {"river": r, "likely": {"csi": c}}
        tests = [t("Chenab", 0.66), t("Chenab", 0.56), t("Indus", 0.3), t("Ravi", 0.5)]
        self.assertEqual([fh.trust(r, tests)["grade"] for r in ("Chenab", "Indus", "Ravi", "Jhelum")], ["High", "Low", "Medium", "Low"])
        self.assertEqual(fh.trust("Jhelum", tests)["why"], "not tested on a real flood")

    def test_runs_are_cached_by_their_inputs(self):
        with tempfile.TemporaryDirectory() as tmp, override_settings(MEDIA_ROOT=tmp):
            z = np.zeros((3, 3), np.float32)
            job = (z, z, 500.0, 500.0, ("design", 100.0, 10.0), [(1, 1)], 24)
            p = fh._run_path("marala", "high", job)
            self.assertEqual(p, fh._run_path("marala", "high", job))
            self.assertNotEqual(p, fh._run_path("marala", "high", (z, z, 500.0, 500.0, ("design", 200.0, 10.0), [(1, 1)], 24)))
            r = {"depth": z, "arrive": z, "speed": z, "vin": 5.0, "vout": 1.0, "stored": 4.0}
            fh._save_run(p, r)
            self.assertEqual(fh._load_run(p)["vout"], 1.0)
