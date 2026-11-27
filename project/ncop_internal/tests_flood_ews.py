# Unit tests for the National Flood Watch early-warning layer
# (flood_store, flood_ffd_site, flood_routing, flood_ews). No network, no Earth Engine.
#   python manage.py test ncop_internal.tests_flood_ews
import json
import tempfile
from datetime import date, datetime, timedelta, timezone
from unittest import mock

import numpy as np
from django.test import RequestFactory, SimpleTestCase, override_settings

from . import flood_ews as fw
from . import flood_ffd_site as site
from . import flood_routing as fr
from . import flood_store as fs

NOW = datetime(2026, 8, 10, 6, 0, tzinfo=timezone.utc)

BULLETIN = """<div>BULLETIN No: 60/26 </div><div>Dated: 10th August-2026 </div><div>Time: 11:00 hours (PST)</div>
<p>RIVERS AT A GLANCE</p><table><tr><td>INDUS Low</td><td>KABUL Below Low</td><td>CHENAB High</td></tr></table><p>FLOOD SEVERITY SCALE</p>
<p>III. HYDROLOGICAL SITUATION at 0600 PST</p><p>River Chenab at Marala is in High Flood.</p>
<p>IV. HYDROLOGICAL OUTLOOK</p><p>Chenab may rise.</p><p>V. WEATHER FORECAST FOR 24-HOUR</p>
<table><tr><td>TARBELA</td></tr><tr><td></td></tr><tr><td>Level</td><td>1518.80 ft</td></tr><tr><td>1380.00 dead → 1550.00 max cons.</td></tr>
<tr><td>Storage</td><td>69.44% live</td></tr><tr><td>0.960 dead + 3.875 / 6.511 MAF live</td></tr></table>
<table><tr><td>INDUS</td><td>Tarbela</td><td>44.0</td><td>55.2</td><td>40 - 45</td><td>Below Low</td><td>832.0</td><td>EH (2010)</td><td>343.0</td></tr>
<tr><td>CHENAB</td><td>Marala</td><td>212.9</td><td>204.0</td><td>250 - 300</td><td>High</td><td>1100.0</td><td>EH (1957)</td><td>275.6</td></tr>
<tr><td>CHENAB</td><td>Punjnad</td><td>8.4</td><td>0.0</td><td>No sig. change</td><td>Below Low</td><td>802.5</td><td>EH (1973)</td><td>146.6</td></tr></table>
<p>Publication History</p>"""


class SiteTests(SimpleTestCase):
    def test_bulletin(self):
        b = site.parse_bulletin(BULLETIN)
        self.assertEqual((b["number"], b["date"]), ("60/26", "2026-08-10"))
        self.assertEqual(b["stations"]["marala"]["forecast"], [250000, 300000])
        self.assertEqual(b["stations"]["marala"]["inflow"], 212900)
        self.assertTrue(b["stations"]["panjnad"]["no_change"])
        self.assertIsNone(b["stations"]["panjnad"]["forecast"])
        self.assertEqual(b["reservoirs"]["Tarbela"]["live_pct"], 69.44)
        self.assertEqual(b["rivers"]["Chenab"], "High")
        self.assertIn("Marala", b["situation"])
        self.assertIsNone(site.parse_bulletin("<p>maintenance</p>"))

    def test_storage(self):
        s = site.parse_storage("<p>Forecast period: 21 Nov 2026 to 30 Nov 2026</p><p>Tarbela 0.47-0.49 MAF Normal: 0.49 MAF</p><p>Mangla 0.09-0.11 MAF Normal: 0.19 MAF</p><p>Updated: 20 Nov 2026</p>")
        self.assertEqual((s["dams"]["Mangla"]["pct"], s["to"]), (53, "2026-11-30"))
        self.assertIsNone(site.parse_storage("nothing"))

    def test_daily_report_and_status(self):
        d = site.parse_daily("<p>سیلابی صورتحال رپورٹ</p><p>🕒 24-Nov-2026 06:00 PKT</p><p>✅ تمام اطلاع دہندہ مقامات پر بہاؤ معمول کے مطابق ہے۔</p>")
        self.assertEqual((d["at"], d["all_normal"]), ("2026-11-24T06:00:00+05:00", True))
        self.assertIsNone(site.parse_daily("<p>nothing</p>"))
        s = site.parse_status(json.dumps({"updated_iso": "2026-11-24T06:00:00+05:00", "headline": {"en": "All major rivers at normal flow"}, "stations": 25,
                                          "counts": {"normal": 25, "low": 0}, "rivers": [{"river": "Indus", "label": "Normal flow"}]}))
        self.assertEqual((s["headline"], s["counts"]["normal"], s["rivers"]["Indus"]), ("All major rivers at normal flow", 25, "Normal flow"))

    def test_season_and_advisory_validity(self):
        self.assertTrue(site.season(date(2026, 8, 1))["open"])
        s = site.season(date(2026, 11, 24))
        self.assertEqual((s["open"], s["days_to_next"]), (False, 203))
        adv = {"issued": NOW.isoformat(), "valid": "Next 6–8 hours"}
        self.assertTrue(site.advisory_in_force(adv, NOW + timedelta(hours=7)))
        self.assertFalse(site.advisory_in_force(adv, NOW + timedelta(hours=9)))
        self.assertFalse(site.advisory_in_force(None))

    def test_protected_services_are_never_called(self):
        self.assertEqual(set(site.PAGES.values()), {"home/river-status", "notifications", "bulletin/bulletin", "bulletin/advisory", "maf-forecast"})


def _hist(sid, kind, days):
    return {fs.STATIONS[sid][2][0]: {kind: [{"x": f"{fs.index_day(i).strftime('%d-%b-%Y')} 06:00 PKT", "y": v} for i, v in days.items()]}}


class StoreTests(SimpleTestCase):
    def test_limits_and_tiers(self):
        self.assertEqual(fs.tier("marala", 99_999), 0)
        self.assertEqual([fs.tier("marala", q) for q in (100_000, 150_000, 200_000, 400_000, 600_000)], [1, 2, 3, 4, 5])
        self.assertIsNone(fs.tier("marala", None))
        self.assertIsNone(fs.tier("besham", 300_000))                       # FFD publishes no limits there

    def test_missing_stays_missing_and_zero_stays_zero(self):
        g = fs.grid(_hist("kotri", "outflow", {100: 0.0, 102: 5000}), 100, 103)
        s = fs.IDS.index("kotri")
        self.assertEqual(g["out6"][s, 0], 0.0)
        self.assertTrue(np.isnan(g["out6"][s, 1]))

    def _clean(self, values):
        raw = {k: np.full((len(fs.IDS), 12), np.nan, np.float32) for k in ("in6", "inmax", "out6", "outmax")}
        for sid, v in values.items():
            for k in raw:
                raw[k][fs.IDS.index(sid)] = v
        return fs.clean(raw)

    def test_uncorroborated_jump_is_held_back_but_a_real_flood_is_kept(self):
        base = [60_000.0] * 12
        jump = base[:5] + [900_000.0] + base[6:]
        a, issues = self._clean({"marala": jump, "khanki": base})
        self.assertTrue(np.isnan(a["inmax"][fs.IDS.index("marala"), 5]))
        self.assertTrue(issues)
        a, issues = self._clean({"marala": jump, "khanki": base[:6] + [1_000_000.0] + base[7:]})     # August 2025
        self.assertEqual(a["inmax"][fs.IDS.index("marala"), 5], 900_000)
        self.assertFalse(issues)

    def test_above_record_is_held_back(self):
        a, issues = self._clean({"chashma": [50_000.0] * 5 + [2_614_432.0] + [50_000.0] * 6})
        self.assertIn("ever recorded", issues[0][3])

    def test_live_time_without_year(self):
        t = fs.parse_live_time("24-Nov 06 PKT", datetime(2026, 11, 24, 12, tzinfo=fs.PKT))
        self.assertEqual(t.isoformat(), "2026-11-24T06:00:00+05:00")
        self.assertEqual(fs.parse_live_time("31-Dec 18 PKT", datetime(2027, 1, 1, 3, tzinfo=fs.PKT)).year, 2026)
        self.assertIsNone(fs.parse_live_time("soon"))


def _store(years=range(2019, 2027)):
    """Taunsa 600k wave reaches Guddu 84 h later, every season different."""
    n = fs.day_index(date(2026, 10, 31)) + 1
    arr = {k: np.full((len(fs.IDS), n), np.nan, np.float32) for k in ("in6", "inmax", "out6", "outmax")}
    rng = np.random.default_rng(3)
    up, pj, dn = (fs.IDS.index(s) for s in ("taunsa", "panjnad", "guddu"))
    for y in years:
        a, b = fs.day_index(date(y, 6, 1)), fs.day_index(date(y, 10, 31))
        t = np.arange(b - a + 1)
        x = 120e3 + 180e3 * np.exp(-((t - rng.integers(40, 110)) / 12.0) ** 2) + np.cumsum(rng.normal(0, 4e3, t.size)) * 0.6
        x = np.maximum(x, 30e3)
        g = np.interp(t - 3.5, t, x) * 0.9 + 25e3
        for k in arr:
            arr[k][up, a:b + 1] = x
            arr[k][pj, a:b + 1] = 20e3
            arr[k][dn, a:b + 1] = g
    return {"start": 0, "clean": arr, "raw": arr, "issues": []}


class RoutingTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.store = _store()
        cls.models = fr.train(cls.store, None)

    def test_routed_station_beats_no_change(self):
        m = self.models["guddu:3"]
        self.assertTrue(m["usable"])
        self.assertGreater(m["skill"]["nse"], m["skill"]["nse_same"])

    def test_stations_without_data_are_not_usable(self):
        self.assertFalse(self.models["tarbela:1"]["usable"])
        self.assertIsNotNone(self.models["tarbela:1"]["why"])

    def test_forecast_states(self):
        f = fr.forecast(self.store, None, {"models": self.models})
        g = {x["lead"]: x for x in f["guddu"]["leads"]}
        self.assertEqual(g[3]["status"], "ok")
        self.assertLessEqual(g[3]["lo"], g[3]["q"])
        self.assertGreaterEqual(g[3]["hi"], g[3]["q"])
        self.assertTrue(0 <= g[3]["prob"]["low"] <= 1)
        self.assertEqual(f["tarbela"]["leads"], [])

    def test_no_future_information_in_the_predictors(self):
        arr, lev = fr.series(self.store)
        t = np.array([float(fs.day_index(date(2024, 8, 1)))])
        a = fr.features("guddu", 3, arr, lev, None, t)
        arr2, lev2 = arr.copy(), lev.copy()
        arr2[:, int(t[0]) + 1:] += 1e6
        lev2[:, int(t[0]) + 1:] += 1e6
        np.testing.assert_allclose(a, fr.features("guddu", 3, arr2, lev2, None, t))

    def test_rain_published_late_is_not_used(self):
        arr, lev = fr.series(self.store)
        n = arr.shape[1]
        rng = np.random.default_rng(0)
        eo = {"obs": rng.gamma(1, 5, (6, n)), "gfs": rng.gamma(1, 5, (7, 6, n))}
        i = fs.day_index(date(2024, 8, 1))
        t = np.array([float(i)])
        a = fr.features("marala", 2, arr, lev, eo, t)
        eo2 = {"obs": eo["obs"].copy(), "gfs": eo["gfs"].copy()}
        eo2["obs"][:, i - 1:] += 100                                     # yesterday's satellite rain is not out yet
        eo2["gfs"][:, :, i + 1:] += 100                                  # nor tomorrow's forecast
        np.testing.assert_allclose(a, fr.features("marala", 2, arr, lev, eo2, t))
        eo2["obs"][:, i - 2] += 100
        self.assertFalse(np.allclose(a, fr.features("marala", 2, arr, lev, eo2, t), equal_nan=True))
        eo3 = {"obs": eo["obs"], "gfs": eo["gfs"].copy()}
        eo3["gfs"][:, :, i] = np.nan                                     # today's run late: yesterday's run is used instead
        np.testing.assert_equal(np.isnan(fr.features("marala", 2, arr, lev, eo3, t)), np.isnan(a))

    def test_warn_ready_needs_floods_caught_and_few_false_alarms(self):
        self.assertFalse(fw.warn_ready(None))
        self.assertFalse(fw.warn_ready({"flood": {"events": 20, "pod": 0.1, "far": 0.7}}))
        self.assertFalse(fw.warn_ready({"flood": {"events": 3, "pod": 1.0, "far": 0.0}}))
        self.assertTrue(fw.warn_ready({"flood": {"events": 20, "pod": 0.9, "far": 0.1}}))


def _live(**kw):
    out = {s: {"inflow": 20_000.0, "outflow": 18_000.0, "trend": "Steady", "level_ft": None, "ffd_status": "NORMAL", "ffd_forecast": None, "ffd_forecast_quant": None,
               "time": (NOW - timedelta(hours=3)).isoformat(), "lon": 70.0 + i * 0.6, "lat": 30.0, "peak_year": None, "peak_year_date": None} for i, s in enumerate(fs.IDS)}
    for k, v in kw.items():
        out[k].update(v)
    return out


class LevelTests(SimpleTestCase):
    gl0, fh0 = {"status": "stale", "points": []}, {"status": "valid", "gauges": []}

    def _run(self, live, outlook=None, mdl=None, bul=None, bul_fresh=False, adv=None, on=False, gl=None, fh=None):
        hist = {s: {"normal": None, "percentile": None, "days30": [], "days30_from": "2026-07-12", "season_peaks": []} for s in fs.IDS}
        rows = fw.stations(live, outlook or {}, mdl or {"models": {}}, bul, bul_fresh, adv or {}, on, gl or self.gl0, fh or self.fh0, hist, NOW)
        return {r["id"]: r for r in rows}

    def test_observed_flood_sets_the_level(self):
        r = self._run(_live(marala={"inflow": 210_000.0}, khanki={"inflow": 450_000.0}, guddu={"inflow": 210_000.0}))
        self.assertEqual([r[s]["watch"] for s in ("marala", "khanki", "guddu", "kotri")], [3, 4, 1, 0])
        self.assertEqual(r["marala"]["confidence"], "High")

    def test_stale_reading_is_not_normal(self):
        r = self._run(_live(marala={"inflow": 210_000.0, "time": (NOW - timedelta(hours=40)).isoformat()}))["marala"]
        self.assertEqual((r["state"], r["tier"], r["watch"]), ("stale", None, 0))

    def test_old_bulletin_forecast_does_not_count(self):
        b = {"stations": {"marala": {"forecast": [250_000, 300_000], "forecast_text": "250 - 300", "forecast_level": "High"}}}
        self.assertEqual(self._run(_live(), bul=b, bul_fresh=False)["marala"]["watch"], 0)
        self.assertEqual(self._run(_live(), bul=b, bul_fresh=True)["marala"]["watch"], 3)

    def _models(self, good=True):
        return {"models": {f"guddu:{h}": {"skill": {"flood": {"events": 50, "pod": 0.95 if good else 0.2, "far": 0.05}}} for h in (1, 2, 3)}}

    _out = {"guddu": {"leads": [{"lead": 2, "status": "ok", "q": 4e5, "prob": {"low": 0.95, "medium": 0.8, "high": 0.1}}]}}

    def test_assisting_sources_are_capped(self):
        live = _live()
        self.assertEqual(self._run(live, self._out, self._models())["guddu"]["watch"], 1)                        # one source: ELEVATED only
        self.assertEqual(self._run(live, self._out, self._models(False))["guddu"]["watch"], 0)                   # unskilful model: nothing
        p = live["guddu"]
        gl = {"status": "valid", "points": [{"lon": p["lon"], "lat": p["lat"], "state": "valid", "worst": "extreme", "worst_date": "2026-08-12"}]}
        self.assertEqual(self._run(live, self._out, self._models(), gl=gl)["guddu"]["watch"], 2)                 # two agree: ALERT, never more
        gl["points"][0]["state"] = "stale"
        self.assertEqual(self._run(live, self._out, self._models(), gl=gl)["guddu"]["watch"], 1)                 # a stale one does not count

    def test_glofas_view_drops_past_days_and_separates_states(self):
        g = {"forecast_date": "2026-08-09", "lead_dates": {str(i): (date(2026, 8, 9) + timedelta(days=i)).isoformat() for i in range(1, 16)},
             "points": [{"id": 1, "lon": 70, "lat": 30, "quality": "ok", "s": ["extreme"] + ["normal"] * 14, "q": [9.0] + [1.0] * 14},
                        {"id": 2, "lon": 71, "lat": 30, "quality": "unreliable", "s": ["normal"] * 15, "q": [0] * 15},
                        {"id": 3, "lon": 72, "lat": 30, "quality": "ok", "s": [], "q": []}]}
        g["lead_dates"]["1"] = "2026-08-08"                                        # already over
        v = fw.glofas_view(g, NOW)
        self.assertEqual([p["state"] for p in v["points"]], ["valid", "unreliable", "no forecast"])
        self.assertEqual((v["above"], v["status"]), (0, "valid"))
        self.assertEqual(fw.glofas_view({**g, "forecast_date": "2026-08-04"}, NOW)["status"], "stale")
        self.assertEqual(fw.glofas_view(None, NOW)["status"], "not available")

    def test_newer_glofas_run_is_used_with_iwmi_points_and_levels(self):
        from . import flood_glofas as fg
        iwmi = {"forecast_date": "2026-08-04", "lead_dates": {str(k): (date(2026, 8, 4) + timedelta(days=k)).isoformat() for k in range(1, 16)},
                "points": [{"id": 1, "lon": 70, "lat": 30, "river": "Indus", "quality": "ok", "warning": 100.0, "danger": 200.0, "extreme": 400.0, "q": [50.0] * 15},
                           {"id": 2, "lon": 71, "lat": 30, "river": None, "quality": "unreliable", "warning": 5.0, "q": [0.0] * 15}]}
        days = [(date(2026, 8, 9) + timedelta(days=k)).isoformat() for k in range(17)]
        cell = lambda v, la: {"latitude": la, "longitude": 70.0, "daily": {"time": list(iwmi["lead_dates"].values()), "river_discharge": [v] * 15}}
        self.assertEqual(fg.match_cell(iwmi["points"][0], iwmi["lead_dates"], [cell(0.0, 29.9), cell(50.2, 30.0), cell(80.0, 30.1)])[0], 30.0)
        self.assertIsNone(fg.match_cell(iwmi["points"][0], iwmi["lead_dates"], [cell(0.0, 29.9), cell(80.0, 30.1)]))        # no cell agrees: not used
        reply = {"daily": {"time": days, **{f"river_discharge_member{m:02d}": [(250.0 if m <= 20 else 120.0) if d == "2026-08-12" else 60.0 for d in days] for m in range(1, 51)}}}
        g = fg.build(iwmi, ["1"], [reply], "2026-08-09T00:00:00+00:00")
        p = next(x for x in g["points"] if x["id"] == 1)
        self.assertEqual((p["status"], p["s"][2], p["s"][3], p["peak_lead"]), ("danger", "danger", "normal", 3))              # 40% of members above 200
        self.assertEqual((g["unreliable"], g["counts"]["danger"], g["forecast_date"]), (1, 1, "2026-08-09"))
        v = fw.glofas_view({**g}, NOW)
        self.assertEqual((v["status"], v["above"], v["via"]), ("valid", 1, "Open-Meteo"))

    def test_old_bulletin_storage_is_not_shown(self):
        b = {"date": "2026-10-15", "reservoirs": {"Tarbela": {"level_ft": 1518.8, "dead_ft": 1380.0, "max_ft": 1550.0, "live_pct": 69.4}}}
        live = {"tarbela": {"level_ft": 1475.9, "time": NOW.isoformat(), "inflow": 1, "outflow": 1}}
        sto = {"to": "2026-08-05", "dams": {"Tarbela": {"pct": 98}}}
        r = fw.reservoirs(live, b, sto, NOW, fresh=False)[0]
        self.assertEqual((r["bulletin"], r["inflow_outlook"], r["level_ft"]), (None, None, 1475.9))
        self.assertEqual(fw.reservoirs(live, b, {**sto, "to": "2026-08-12"}, NOW, fresh=True)[0]["bulletin"]["live_pct"], 69.4)

    def test_floodhub_missing_is_not_no_flooding(self):
        h = {"issued_time": NOW.isoformat(), "gauges": [{"id": "a", "lon": 1, "lat": 1, "severity": "NO_FLOODING"}, {"id": "b", "lon": 1, "lat": 1, "severity": None}]}
        v = fw.floodhub_view(h, NOW)
        self.assertEqual((v["counts"]["valid"], v["counts"]["no forecast"], v["flooding"]), (1, 1, 0))
        self.assertEqual(fw.floodhub_view({**h, "issued_time": (NOW - timedelta(days=3)).isoformat()}, NOW)["counts"]["stale"], 2)

    def test_district_keeps_its_own_level(self):
        st = [r for r in self._run(_live(marala={"inflow": 450_000.0})).values()]
        rain = {"status": "valid", "rows": [{"name": "Sialkot", "province": "Punjab", "kind": "plain", "level": 0, "max3": 2},
                                            {"name": "Kech", "province": "Balochistan", "kind": "torrent", "level": 1, "max3": 41}]}
        ds = {d["name"]: d for d in fw.districts(st, rain, None, {"alerts": []}, NOW)}
        self.assertEqual((ds["Sialkot"]["level"], ds["Kech"]["level"]), (4, 1))
        ds = {d["name"]: d for d in fw.districts(st, {**rain, "status": "stale"}, None, {}, NOW)}
        self.assertEqual(ds["Kech"]["level"], 0)                                   # an old rain outlook raises nothing

    def test_offline_glof_labels_are_not_alerts(self):
        j = {"features": [{"properties": {"name": "x", "city": "Hunza", "alert_label": "WARNING", "connectivity": "OFFLINE"}}]}
        with mock.patch("requests.get", return_value=mock.Mock(json=lambda: j)):
            g = fw.glof_status(NOW)
        self.assertEqual((g["status"], g["alerts"], g["offline_with_label"]), ("not available", [], 1))

    def test_every_reach_district_and_station_exists(self):
        self.assertTrue(set(fw.REACH) <= set(fs.IDS))
        for d, us in fs.UPSTREAM.items():
            self.assertIn(d, fs.IDS)
            for u, h in us:
                self.assertIn(u, fs.IDS)
                self.assertTrue(0 < h < 200)


class IssueAndViewTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ov = override_settings(MEDIA_ROOT=self.tmp.name)
        ov.enable()
        self.addCleanup(ov.disable)
        fw._state.update(doc=None, loaded_at=0.0, thread=None, eo=None)

    def _doc(self, day, q):
        return {"generated_at": f"{day}T06:00:00+00:00", "national": {"level": 0, "stations": {"tiers": {}}}, "stations": [{"id": "marala", "q": q}], "districts": []}

    def test_issue_log_and_changes(self):
        a = fw.log_issue(self._doc("2026-08-09", 50_000))
        self.assertEqual((a["number"], a["changes"]), (1, None))
        self.assertEqual(fw.log_issue(self._doc("2026-08-09", 52_000))["revisions"], 1)
        b = fw.log_issue(self._doc("2026-08-10", 104_000))
        self.assertEqual((b["number"], b["changes"]["up"]), (2, [["Marala", 100]]))

    def test_forecast_runs_are_kept_not_overwritten(self):
        o = {"guddu": {"from": "2026-08-10", "now": 1, "leads": [{"lead": 1, "status": "ok", "q": 2, "lo": 1, "hi": 3}]}}
        doc = {"national": {"level": 0}}
        fw.archive_run(doc, o, NOW)
        fw.archive_run(doc, o, NOW)                                                # same origin: once
        o["guddu"]["from"] = "2026-08-11"
        fw.archive_run(doc, o, NOW + timedelta(days=1))
        with open(f"{fs.root()}/runs-202608.jsonl", encoding="utf-8") as f:
            self.assertEqual(len(f.readlines()), 2)

    def test_view_202_then_200(self):
        rq = RequestFactory().get("/api/flood/watch/")
        with mock.patch.object(fw, "_build_async") as kick:
            self.assertEqual(fw.FloodEwsView.as_view()(rq).status_code, 202)
            kick.assert_called_once()
        with open(fw._path(), "w", encoding="utf-8") as f:
            json.dump({"season": {"open": False}, "national": {}}, f)
        with mock.patch.object(fw, "_build_async") as kick:
            self.assertEqual(fw.FloodEwsView.as_view()(rq).status_code, 200)
            kick.assert_not_called()
