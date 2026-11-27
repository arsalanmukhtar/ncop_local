# Unit tests for the Food Security early-warning layer (foodsec_ews / _eo / _sources).
# No network, no Earth Engine.
#   python manage.py test ncop_internal.tests_foodsec_ews
import json
import tempfile
from datetime import date
from unittest import mock

import numpy as np
from django.test import SimpleTestCase, override_settings

from . import foodsec_eo as eo
from . import foodsec_ews as ew
from . import foodsec_sources as fs


def _wfp(flour, wage=None, wheat=None, first=(2012, 1)):
    """Compact WFP document: five markets with the same price path."""
    mk = ["Karachi", "Lahore", "Multan", "Peshawar", "Quetta"]
    lo = first[0] * 12 + first[1] - 1

    def col(series):
        return {ew.ms(lo + k): {m: float(v) for m in mk} for k, v in enumerate(series)}
    n = len(flour)
    return {"prices": {ew.FLOUR: col(flour), ew.WAGE: col(wage if wage is not None else [1000.0 + k for k in range(n)]),
                       ew.WHEAT: col(wheat if wheat is not None else [f * 0.8 for f in flour])},
            "markets": {m: {"market": m} for m in mk}, "units": {ew.FLOUR: ["KG"]}}


class ScoreTests(SimpleTestCase):
    def test_guide_thresholds(self):
        for ind, pairs in {
            "flour_m3": [(4.9, 0), (5, 1), (10, 2), (15, 3)], "kg_wage": [(-9, 0), (-10, 1), (-15, 2), (-25, 3), (12, 0)],
            "spi": [(-0.9, 0), (-1, 1), (-1.5, 2), (-2.1, 3)], "soil": [(20, 0), (19, 1), (9, 2), (4, 3)],
            "vci": [(35, 0), (34, 1), (24, 2), (14, 3)], "canal": [(-9, 0), (-22, 2), (-30, 3)], "fews_phase": [(1, 0), (2, 1), (3, 2), (4, 3)],
        }.items():
            for v, want in pairs:
                self.assertEqual(ew.score(ind, v), want, (ind, v))
        self.assertIsNone(ew.score("spi", None))
        self.assertIsNone(ew.score("spi", float("nan")))

    def _p(self, **kw):
        return {k: {"score": s, "conf": c} for k, (s, c) in kw.items()}

    def test_level_rules(self):
        lv = lambda **kw: ew.district_level(self._p(**kw))[0]
        self.assertEqual(lv(a=(0, "High"), b=(0, "High"), c=(0, "High")), 0)
        self.assertEqual(lv(a=(1, "Low"), b=(0, "High"), c=(0, "High")), 1)
        self.assertEqual(lv(a=(2, "Medium"), b=(0, "High"), c=(1, "High")), 1)       # one pillar at 2 is not a Warning
        self.assertEqual(lv(a=(2, "Low"), b=(2, "Low"), c=(0, "High")), 2)
        self.assertEqual(lv(a=(3, "Low"), b=(0, "High"), c=(1, "High")), 1)          # low-confidence 3 alone cannot raise an Alert
        self.assertEqual(lv(a=(3, "Medium"), b=(0, "High"), c=(0, "High")), 3)
        self.assertEqual(lv(a=(3, "Low"), b=(3, "Low"), c=(0, "High")), 3)

    def test_confidence_is_the_lowest_that_triggered_and_drops_with_missing_pillars(self):
        self.assertEqual(ew.district_level(self._p(a=(2, "High"), b=(2, "Medium"), c=(0, "Low")))[1], "Medium")
        self.assertEqual(ew.district_level({"a": {"score": 2, "conf": "High"}, "b": {"score": 2, "conf": "High"}, "c": None})[1], "Low")
        self.assertEqual(ew.district_level({"a": None})[:2], (0, "Low"))

    def test_hysteresis(self):
        self.assertEqual(ew.effective(1, 2), 2)
        self.assertEqual(ew.effective(1, 1), 1)
        self.assertEqual(ew.effective(3, 1), 3)
        self.assertEqual(ew.effective(2, None), 2)


class WaterTests(SimpleTestCase):
    row = {"spi3": -1.6, "spi6": -0.2, "soil_pct": 50, "vci": 60, "cropland": 0.4}

    def test_rainfed_uses_rain_and_needs_support_for_medium_confidence(self):
        w = ew.water_pillar(self.row, None, False)
        self.assertEqual((w["score"], w["why"], w["conf"]), (2, ["spi"], "Low"))
        w = ew.water_pillar({**self.row, "soil_pct": 15}, None, False)
        self.assertEqual((w["score"], w["conf"]), (2, "Medium"))

    def test_irrigated_uses_canal_not_local_rain(self):
        w = ew.water_pillar(self.row, -22, True)
        self.assertEqual((w["score"], w["why"]), (2, ["canal"]))
        self.assertEqual(ew.water_pillar(self.row, None, True)["score"], 0)
        # a city with no cropland is not scored on canal water or crop greenness
        self.assertIsNone(ew.water_pillar({**self.row, "cropland": 0.0}, -22, True))


class MarketTests(SimpleTestCase):
    def test_indicators(self):
        flour = [100.0] * 80 + [100, 104, 108, 120]
        px = ew.Prices(_wfp(flour, wage=[1000.0] * 84))
        m = ew.market_indicators(px, px.last)
        self.assertAlmostEqual(m["flour_m3"], 20.0, places=1)
        self.assertAlmostEqual(m["kg"], 1000 / 120, places=2)
        self.assertAlmostEqual(m["kg_wage"], (100 / 120 - 1) * 100, places=1)
        p = ew.market_pillar(px, px.last, ["Karachi"])
        self.assertEqual(p["score"], 3)
        self.assertTrue(p["stale_wage"])
        self.assertEqual(ew.market_indicators(px, px.last, ["Nowhere"]), {})

    def test_unchanged_wage_alone_is_low_confidence(self):
        flour = [100.0 - k * 0.1 for k in range(60)] + [112.0] * 24      # dear against the past, flat now
        px = ew.Prices(_wfp(flour, wage=[1000.0] * 84, wheat=[90.0] * 60 + [100.8] * 24))
        p = ew.market_pillar(px, px.last, ["Quetta"])
        self.assertEqual(p["why"], ["kg_wage"])
        self.assertEqual(p["conf"], "Low")

    def test_market_confidence_only_in_its_own_district(self):
        px = ew.Prices(_wfp([100.0] * 81 + [105, 110, 120], wage=[1000.0 + k for k in range(84)]))
        base = {"spi1": None, "spi3": 0.0, "spi6": 0.0, "soil_pct": 50, "vci": 60, "cropland": 0.5}
        now = {"districts": [{"name": "Peshawar", "province": "Khyber Pakhtunkhwa", **base},
                             {"name": "Swat", "province": "Khyber Pakhtunkhwa", **base}]}
        out = ew.assess(now, px, px.last, {"Peshawar": 1, "Swat": 1}, None, (None, set()))
        self.assertEqual(out["Peshawar"]["level"], 3)
        self.assertEqual(out["Swat"]["level"], 1)                        # same price, but only a proxy there


class PriceOutlookTests(SimpleTestCase):
    def test_outlook_is_tested_and_ordered(self):
        rng = np.random.default_rng(1)
        lg = np.cumsum(rng.normal(0.006, 0.03, 178)) + np.log(40)
        po = ew.price_outlook(ew.Prices(_wfp(list(np.exp(lg)))))
        self.assertEqual([p["month"] for p in po["path"]], ["2026-11", "2026-12", "2027-01"])
        for p in po["path"]:
            self.assertLessEqual(p["lo"], p["mid"])
            self.assertGreaterEqual(p["hi"], p["mid"])
        self.assertEqual({s["model"] for s in po["skill"]}, {*ew.MODELS, "chosen"})
        self.assertEqual(sum(s["used"] for s in po["skill"]), 1)

    def test_fit_never_uses_outcomes_after_the_origin(self):
        lg = np.log(np.linspace(40, 120, 150))
        a = ew._fit(lg, lg - 0.2, lg * 0, 120, 3, {})
        lg2 = lg.copy()
        lg2[121:] += 5.0                                                  # change the future only
        b = ew._fit(lg2, lg2 - 0.2, lg2 * 0, 120, 3, {})
        np.testing.assert_allclose(a, b)

    def test_pinball(self):
        self.assertAlmostEqual(ew._pinball(0.9, 10, 8), 1.8)
        self.assertAlmostEqual(ew._pinball(0.9, 8, 10), 0.2)


class EoTests(SimpleTestCase):
    def _store(self, rain=None):
        months = 46 * 12
        rng = np.random.default_rng(0)
        r = rng.gamma(4, 20, (1, months)) if rain is None else rain
        return {"districts": [{"name": "X", "province": "Punjab"}], "updated": "2026-11-24", "rain": (eo.month_index(1981, 1), r),
                "soil": (eo.month_index(1981, 1), rng.normal(0.2, 0.03, (1, months))), "ndvi": (eo.month_index(1981, 1), rng.normal(0.5, 0.05, (1, months))),
                "population": np.array([1000.0]), "cropland": np.array([0.5])}

    def test_spi_sign_and_extremes(self):
        sample = list(range(40))
        self.assertGreater(eo.spi_value(sample, 100), 2.0)
        self.assertLess(eo.spi_value(sample, -1), -2.0)
        self.assertAlmostEqual(eo.spi_value(sample, 19.5), 0, delta=0.1)
        self.assertIsNone(eo.spi_value([1, 2, 3], 2))

    def test_spi_withheld_in_dry_season(self):
        d = self._store()
        r = d["rain"][1]
        r[0, 9::12] = 0.0                                                 # every October dry
        s = d["rain"][0]
        self.assertIsNone(eo.spi(r[0], s, s + 550 - (550 % 12) + 9 - 12, 1))

    def test_replay_does_not_depend_on_later_months_for_current_value(self):
        d = self._store()
        at = eo.month_index(2020, 8)
        a = eo.indicators(d, at)
        self.assertEqual(a["months"]["rain"], "2020-08")
        self.assertIsNotNone(a["districts"][0]["spi3"])

    def test_vci_bounds(self):
        d = self._store()
        v = eo.vci(d["ndvi"][1][0], d["ndvi"][0], eo.month_index(2025, 7))
        self.assertTrue(0 <= v <= 100)

    def test_store_round_trip(self):
        with tempfile.TemporaryDirectory() as t, override_settings(MEDIA_ROOT=t):
            eo._memo.update(mtime=None, doc=None)
            self.assertIsNone(eo.load())
            eo.save(self._store())
            back = eo.load()
            self.assertEqual(back["rain"][1].shape, (1, 552))
            self.assertEqual(float(back["population"][0]), 1000.0)
        eo._memo.update(mtime=None, doc=None)


class SourceTests(SimpleTestCase):
    def test_weekly_sst_row(self):
        d, a = fs.parse_weekly_sst(" 18NOV2026     27.5 5.7     29.8 4.7     30.1 3.3     30.0 1.4")
        self.assertEqual((d, a), (date(2026, 11, 18), 3.3))
        self.assertEqual(fs.parse_weekly_sst(" 02SEP1981     20.6-0.1     24.8-0.1     26.5-0.2     28.3-0.3")[1], -0.2)

    def test_fews_rounds_and_scenarios(self):
        rows = []
        for rd in ("2026-06-01", "2026-10-01", "2026-08-01"):
            n = 130 if rd != "2026-08-01" else 10                        # an incomplete round is ignored
            for k in range(n):
                for sc, v in (("Current Situation", 2), ("Near Term Projection ", 3)):
                    rows.append({"reporting_date": rd, "geographic_unit_name": f"D{k}", "geographic_unit_full_name": f"D{k}, Punjab, Pakistan",
                                 "scenario_name": sc, "value": float(v), "projection_start": rd, "projection_end": "2027-01-31"})
        out = fs.parse_fews(rows)
        self.assertEqual((out["current"]["round"], out["previous"]["round"]), ("2026-10-01", "2026-06-01"))
        self.assertEqual(out["current"]["units"][0]["next"], 3)

    def test_ipc_two_lines_are_kept_apart(self):
        def tot(p3):
            return {"analyzedPopulation": 1000, "phase3PlusPopulation": p3, "phase3Population": p3, "phase4Population": 0, "phase5Population": 0,
                    "phase3PlusPercentage": p3 / 1000}

        def an(aid, dt, groups):
            return {"anl_id": aid, "title": aid, "analysis_date": dt, "public_map_link": "", "country_population": 1,
                    "periods": [{"period_code": "current", "from_date": dt, "thru_date": "2026-03-31"},
                                {"period_code": "projected-1", "from_date": "2026-04-01", "thru_date": "2026-09-30"}],
                    "totals": {"current": tot(300), "projected-1": tot(200)},
                    "groups": [{"group_id": g, "group_name": g, "areas": [{"area": g + "1", "aar_id": "1", "periods": {}}]} for g in groups],
                    "groupTotals": {g: {"current": tot(100), "projected-1": tot(50)} for g in groups}}
        doc = {"data": fs.parse_ipc({"data": [an("old", "2025-12-08", ["SINDH final"]), an("new", "2026-03-02", ["SINDH final", "PUNJAB final"])]})}
        s = ew.latest_ipc({"ipc": doc}, lambda n: None)["summary"]
        self.assertEqual(len(s["lines"]), 2)
        self.assertEqual([ln["analysis"] for ln in s["lines"]], ["old", "new"])
        self.assertEqual(s["lines"][1]["projected"]["p3plus"], 50)
        self.assertEqual(s["valid_to"], "2026-09-30")

    def test_failed_download_keeps_last_good_copy(self):
        with tempfile.TemporaryDirectory() as t, override_settings(MEDIA_ROOT=t):
            ok = lambda prev: {"data": {"x": 1}, "period": "p", "period_end": date.today().isoformat()}
            with mock.patch.dict(fs.SOURCES, {"fx": (ok, *fs.SOURCES["fx"][1:])}):
                self.assertTrue(fs.get("fx")["ok"])

            def bad(prev):
                raise RuntimeError("down")
            with mock.patch.dict(fs.SOURCES, {"fx": (bad, *fs.SOURCES["fx"][1:])}):
                d = fs.get("fx", force=True)
            self.assertFalse(d["ok"])
            self.assertEqual(d["data"], {"x": 1})
            self.assertEqual([h["state"] for h in fs.health({"fx": d}) if h["id"] == "fx"], ["failed"])

    def test_throttled_202_is_a_failure(self):
        r = mock.Mock(status_code=202, raise_for_status=lambda: None)
        with mock.patch.object(fs.requests, "get", return_value=r), self.assertRaises(ValueError):
            fs._get("http://x")

    def test_register_expires(self):
        st = {e["id"]: e["state"] for e in fs.register(date(2027, 12, 31))}
        self.assertEqual(set(st.values()), {"out of date"})
        self.assertEqual(ew.canal_now(fs.register(date(2027, 12, 31))), (None, set()))
        self.assertEqual(ew.canal_now(fs.register(date(2026, 11, 24)))[0], -22)
        for e in fs.NEWS_REGISTER:
            self.assertTrue(e["as_of"] < e["expires"] and e["ref"] and e["type"])


class IssueLogTests(SimpleTestCase):
    def test_revision_is_recorded_not_overwritten(self):
        out = {"periods": {"prices": "2026-10"}, "national": {"count": {"0": 1}, "people": {"0": 1}, "level": 1}, "market": {"Pakistan": {"flour": 1, "kg": 1}},
               "price_outlook": None, "districts": [{"level": 1}]}
        with tempfile.TemporaryDirectory() as t, override_settings(MEDIA_ROOT=t):
            a = ew.log_issue(out)
            self.assertEqual((a["number"], a["revisions"]), (1, 0))
            self.assertEqual(ew.log_issue(out)["revisions"], 0)
            self.assertEqual(ew.log_issue({**out, "districts": [{"level": 2}]})["revisions"], 1)
            b = ew.log_issue({**out, "periods": {"prices": "2026-11"}})
            self.assertEqual(b["number"], 2)
            self.assertIsNotNone(b["previous"])
            with open(f"{t}/foodsec/issues.json", encoding="utf-8") as f:
                self.assertEqual(len(json.load(f)), 2)
