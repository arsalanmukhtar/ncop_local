# project/ncop_internal/tests_aqi.py — AQI engine and Air Quality Watch AQI block.
# Reference values: US EPA TAD EPA-403/B-26-003 (May 2026) worked examples and
# 40 CFR 58 App. G Table 2 edges. No network, no database.

import time
from datetime import datetime, timedelta, timezone
from unittest import mock

from django.test import SimpleTestCase

from . import aqi_engine as ae
from . import aqi_watch as aw
from . import hawanama_client as hc


class EngineTests(SimpleTestCase):
    def test_epa_worked_examples(self):
        self.assertEqual(ae.sub_index("o3_8h", 0.07853333), 126)
        self.assertEqual(ae.sub_index("pm25_24h", 35.9), 102)
        self.assertEqual(ae.sub_index("co_8h", 8.4), 90)
        # The TAD prints 148 for 0.162 ppm; Equation 1 gives 147.49 -> 147
        # (the error reported to EPA as RFC 26004).
        self.assertEqual(ae.sub_index("o3_1h", 0.162), 147)
        self.assertEqual(ae.overall({"o3": 126, "pm25": 102, "co": 90}), (126, "o3"))

    def test_every_breakpoint_edge_maps_to_its_aqi_edge(self):
        for key, (_, _, rows) in ae.STANDARDS["us_epa_2024"]["breakpoints"].items():
            for (ilo, ihi), row in zip(ae._AQI_RANGES, rows):
                if row:
                    self.assertEqual(ae.sub_index(key, row[0]), ilo, (key, row))
                    self.assertEqual(ae.sub_index(key, row[1]), ihi, (key, row))

    def test_truncation_not_rounding(self):
        self.assertEqual(ae.sub_index("pm25_24h", 9.09), 50)     # 9.0
        self.assertEqual(ae.sub_index("pm25_24h", 35.49), 100)   # 35.4
        self.assertEqual(ae.sub_index("pm10_24h", 54.9), 50)
        self.assertEqual(ae.truncate(35.4, 1), 35.4)

    def test_above_500_is_extrapolated_and_truncated_scales_stop(self):
        self.assertEqual(ae.sub_index("pm25_24h", 325.4), 500)
        self.assertGreater(ae.sub_index("pm25_24h", 400), 500)
        self.assertIsNone(ae.sub_index("o3_8h", 0.25))           # defined by 1-h O3 only
        self.assertIsNone(ae.sub_index("so2_1h", 400))           # defined by 24-h SO2 only
        self.assertIsNone(ae.sub_index("o3_1h", 0.104))          # blank in the table

    def test_missing_is_none_never_zero(self):
        for v in (None, float("nan"), -1, "x"):
            self.assertIsNone(ae.sub_index("pm25_24h", v))
        self.assertEqual(ae.overall({"pm25": None, "o3": None}), (None, None))
        self.assertIsNone(ae.category(None))

    def test_overall_is_the_maximum_not_the_mean(self):
        self.assertEqual(ae.overall({"pm25": 180, "pm10": 60, "o3": 20, "no2": None}), (180, "pm25"))

    def test_categories(self):
        for v, k in ((0, "good"), (50, "good"), (51, "moderate"), (150, "usg"), (151, "unhealthy"), (200, "unhealthy"),
                     (201, "very_unhealthy"), (300, "very_unhealthy"), (301, "hazardous"), (650, "hazardous")):
            self.assertEqual(ae.category(v), k)

    def test_unknown_standard(self):
        with self.assertRaises(ValueError):
            ae.get_standard("nope")
        with self.settings(AQI_STANDARD="nope"), self.assertRaises(ValueError):
            ae.get_standard()

    def test_nowcast(self):
        self.assertAlmostEqual(ae.nowcast_pm([40] * 12), 40)
        # Rising fast: weight factor floors at 0.5 -> close to the latest hours.
        rising = [10] * 9 + [100, 150, 200]
        num = sum(0.5 ** i * v for i, v in enumerate(reversed(rising)))
        den = sum(0.5 ** i for i in range(12))
        self.assertAlmostEqual(ae.nowcast_pm(rising), num / den)
        self.assertIsNone(ae.nowcast_pm([50] * 10 + [None, None]))        # 1 of the last 3
        self.assertIsNotNone(ae.nowcast_pm([None] * 9 + [50, None, 60]))  # 2 of the last 3
        self.assertEqual(ae.nowcast_pm([0] * 12), 0)

    def test_completeness(self):
        self.assertIsNone(ae.mean_24h([10] * 17 + [None] * 7))
        self.assertEqual(ae.mean_24h([10] * 18 + [None] * 6), 10)
        self.assertIsNone(ae.max_8h([5] * 5 + [None] * 19))
        self.assertEqual(ae.max_8h([1] * 16 + [9] * 8), 9)

    def test_daily_subindices_units_and_averaging(self):
        day = {"pm25": [60] * 24, "pm10": [70] * 24, "o3": [100] * 24, "co": [3000] * 24, "no2": [50] * 24, "so2": [20] * 24}
        s = ae.daily_subindices(day)
        self.assertEqual(s["pm25"]["aqi"], ae.sub_index("pm25_24h", 60))
        self.assertAlmostEqual(s["o3"]["conc"], round(100 * 24.45 / 48 / 1000, 3))
        self.assertEqual(s["o3"]["avg"], "max 8-h mean")
        self.assertEqual(s["no2"]["unit"], "ppb")
        self.assertEqual(s["co"]["aqi"], ae.sub_index("co_8h", 3000 * 24.45 / 28.01 / 1000))
        # 1-h SO2 at 305 ppb or more with a low 24-h mean is fixed at 200 (TAD p.16).
        spike = [0] * 23 + [305 * 64.066 / 24.45 + 1]
        self.assertEqual(ae.daily_subindices({"so2": spike})["so2"]["aqi"], 200)

    def test_describe_is_pending_by_default(self):
        d = ae.describe()
        self.assertFalse(d["approved"])
        self.assertEqual([c["label"] for c in d["categories"]][-1], "Hazardous")
        self.assertEqual(d["categories"][1]["pm25_24h"], [9.1, 35.4])


def _st(city, pm, hours=24, lon=74.0, lat=31.0, sid=None):
    return {"geometry": {"coordinates": [lon, lat]}, "properties": {"city": city, "pm25": pm, "valid_hours": hours, "id": sid}}


class ObservedTests(SimpleTestCase):
    def test_incomplete_station_days_are_excluded(self):
        o = aw.observed_daily([(f"2026-11-2{i}", [_st("A", 60), _st("A", 80), _st("A", 400, hours=10), _st("B", None)]) for i in range(3)])
        d = o["days"][0]
        self.assertEqual((d["n_reporting"], d["n_valid"]), (3, 2))
        self.assertEqual((d["share_above_who24"], d["share_above_neqs24"]), (1.0, 1.0))   # valid station-days only
        a = o["cities"][0]
        self.assertEqual(a["series"][0]["pm25"], 70.0)
        self.assertEqual(a["series"][0]["aqi"], ae.sub_index("pm25_24h", 70))
        self.assertEqual([c["city"] for c in o["cities"]], ["A"])

    def test_one_faulty_sensor_does_not_set_the_city(self):
        o = aw.observed_daily([(f"2026-11-2{i}", [_st("A", 50), _st("A", 52), _st("A", 900)]) for i in range(3)])
        self.assertEqual(o["cities"][0]["last"], ae.sub_index("pm25_24h", 52))
        self.assertGreater(o["cities"][0]["series"][0]["max"], 500)

    def test_worst_city_prefers_two_or_more_stations(self):
        o = aw.observed_daily([(f"2026-11-2{i}", [_st("Solo", 500), _st("Pair", 90), _st("Pair", 100)]) for i in range(3)])
        self.assertEqual(o["days"][0]["worst_city"], "Pair")
        # City-balanced middle: each city counts once, however many stations it has.
        self.assertEqual(o["days"][0]["n_cities"], 2)
        self.assertEqual(o["days"][0]["median_city_aqi"], round((ae.sub_index("pm25_24h", 500) + ae.sub_index("pm25_24h", 95)) / 2))

    def test_missing_day_is_a_gap(self):
        days = [("2026-11-20", [_st("A", 60), _st("B", 20)]), ("2026-11-21", [_st("B", 20)]), ("2026-11-22", [_st("A", 70), _st("B", 20)])]
        a = next(c for c in aw.observed_daily(days)["cities"] if c["city"] == "A")
        self.assertIsNone(a["series"][1])
        self.assertEqual((a["days_valid"], a["n_days"]), (2, 3))
        self.assertEqual(a["trend"], "insufficient data")

    def test_trend_and_confidence_rules(self):
        self.assertEqual(aw._trend([100, 110, 120]), "worsening")
        self.assertEqual(aw._trend([200, None, 190, 180]), "improving")
        self.assertEqual(aw._trend([100, 105, 108]), "stable")
        self.assertEqual(aw.confidence(3, 6, 7, 0.2), "high")
        self.assertEqual(aw.confidence(3, 6, 7, 0.6), "medium")
        self.assertEqual(aw.confidence(2, 4, 7, None), "medium")
        self.assertEqual(aw.confidence(1, 7, 7, None), "low")
        self.assertEqual(aw.confidence(0, 7, 7, 0.1), "low")


class NowTests(SimpleTestCase):
    END = datetime(2026, 11, 24, 6, tzinfo=timezone.utc)

    def _hours(self, vals, lag=0):
        # vals: newest last; lag = hours between END and the newest value
        out = {}
        for i, v in enumerate(reversed(vals)):
            if v is not None:
                out[(self.END - timedelta(hours=lag + i)).strftime("%Y-%m-%dT%H:%M:%SZ")] = v
        return out

    def test_nowcast_per_station_and_city(self):
        feats = [_st("A", 1, sid="s1"), _st("A", 1, sid="s2"), _st("B", 1, sid="s3"), _st("C", 1, sid="s4")]
        hourly = {"s1": self._hours([60] * 12), "s2": self._hours([80] * 12, lag=1),
                  "s3": self._hours([50] * 12, lag=5),                # too old
                  "s4": self._hours([50] * 9 + [None, None, 50])}     # 1 of last 3
        n = aw.now_from_hourly(feats, hourly, self.END)
        self.assertEqual(n["n_valid"], 2)
        self.assertEqual([c["city"] for c in n["cities"]], ["A"])
        self.assertEqual(n["cities"][0]["aqi"], ae.sub_index("pm25_24h", 70))
        self.assertEqual(sum(n["category_counts"].values()), 2)

    def test_flagged_and_implausible_rows_are_dropped(self):
        rows = [{"station_id": "s", "timestamp_utc": "t1", "pm25": 50, "qc_state": "raw"},
                {"station_id": "s", "timestamp_utc": "t2", "pm25": 50, "qc_state": "SPIKE"},
                {"station_id": "s", "timestamp_utc": "t3", "pm25": 5000, "qc_state": "OK"},
                {"station_id": "s", "timestamp_utc": "t4", "pm25": None, "qc_state": "OK"}]
        resp = mock.Mock()
        resp.json.return_value = {"rows": rows}
        with mock.patch.object(hc, "_sess") as s:
            s.return_value.get.return_value = resp
            out, _, flagged, failed = aw._bulk_hourly(["s"])
        self.assertEqual(out, {"s": {"t1": 50.0}})
        self.assertEqual((flagged, failed), (1, 0))

    def test_bulk_chunks_and_total_failure(self):
        with mock.patch.object(hc, "_sess") as s:
            s.return_value.get.side_effect = OSError("down")
            with self.assertRaises(RuntimeError):
                aw._bulk_hourly([f"s{i}" for i in range(60)])
            self.assertEqual(s.return_value.get.call_count, 3)   # 25 + 25 + 10


class ForecastTests(SimpleTestCase):
    DATES = [f"2026-11-{d:02d}" for d in range(17, 24)]

    def test_bias_adjustment_blend_and_range(self):
        obs = {d: 160.0 for d in self.DATES}
        model = {d: 80.0 for d in self.DATES}
        model.update({"2026-11-24": 80.0, "2026-11-25": 100.0})
        rows, ratio, n = aw.forecast_city(obs, model, ["2026-11-24", "2026-11-25", "2026-11-26"])
        self.assertEqual((ratio, n), (2.0, 7))
        self.assertAlmostEqual(rows[0]["pm25"], 160.0)                       # model steady -> persistence = adjusted
        self.assertAlmostEqual(rows[1]["pm25"], round((160 * 200) ** 0.5, 1))   # lead 2: half and half
        self.assertIsNone(rows[2])                                           # no model value: no forecast
        self.assertLess(rows[0]["lo"], rows[0]["aqi"])
        self.assertGreater(rows[0]["hi"], rows[0]["aqi"])

    def test_too_few_days_or_too_far_ahead_gives_nothing(self):
        obs = {d: 100.0 for d in self.DATES[-4:]}
        self.assertIsNone(aw.forecast_city(obs, {d: 50.0 for d in self.DATES}, ["2026-11-24"]))
        self.assertIsNone(aw.forecast_city({}, {}, ["2026-11-24"]))
        full = {d: 100.0 for d in self.DATES}
        rows, _, _ = aw.forecast_city(full, {**full, "2026-11-30": 100.0}, ["2026-11-30"])
        self.assertEqual(rows, [None])                                       # lead 7: no skill figure, no forecast

    def test_ratio_is_limited(self):
        obs = {d: 500.0 for d in self.DATES}
        rows, ratio, _ = aw.forecast_city(obs, {**{d: 10.0 for d in self.DATES}, "2026-11-24": 10.0}, ["2026-11-24"])
        self.assertEqual(ratio, 4.0)

    def test_forecast_is_capped_at_one_and_a_half_recent_maxima(self):
        obs = {d: 100.0 for d in self.DATES}
        rows, _, _ = aw.forecast_city(obs, {**{d: 50.0 for d in self.DATES}, "2026-11-26": 500.0}, ["2026-11-26"])
        self.assertEqual(rows[0]["pm25"], 150.0)

    def _observed(self):
        return aw.observed_daily([(d, [_st("Lahore", 160), _st("Lahore", 170), _st("Karachi", 60, lon=67, lat=24.9), _st("Karachi", 62, lon=67, lat=24.9)]) for d in self.DATES])

    def test_outlook_keeps_measured_and_modelled_apart(self):
        day = {"pm25": [80.0] * 24, "pm10": [90.0] * 24, "o3": [200.0] * 24, "no2": [20.0] * 24, "so2": [5.0] * 24, "co": [300.0] * 24}
        dates = self.DATES + ["2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]
        with mock.patch.object(aw, "cams_days", side_effect=lambda cs: {c["city"]: {d: day for d in dates} for c in cs}):
            out = aw.outlook(self._observed(), now=datetime(2026, 11, 24, 10, tzinfo=aw.PKT))
        fc = out["forecast"]
        self.assertEqual(fc["targets"][0], "2026-11-24")
        self.assertEqual([d["lead"] for d in fc["days"]], [1, 2, 3, 4])
        self.assertEqual(fc["days"][0]["n_cities"], 2)
        khi = next(c for c in out["pollutants"]["cities"] if c["city"] == "Karachi")
        self.assertEqual(khi["last"]["pm25_station_aqi"], ae.sub_index("pm25_24h", 61))   # station, not raw CAMS
        self.assertEqual(khi["last"]["dominant"], "o3")      # modelled ozone can exceed measured PM2.5
        self.assertFalse(out["pollutants"]["measured"]["o3"])

    def test_build_degrades_per_part(self):
        feats = {"features": [_st("Lahore", 160), _st("Lahore", 170)]}
        with mock.patch.object(hc, "stations_daily_geojson", return_value=feats), \
             mock.patch.object(aw, "current", side_effect=RuntimeError("x")), \
             mock.patch.object(aw, "cams_days", side_effect=OSError("y")), \
             mock.patch.object(aw, "_snapshot", return_value="abc"):
            p = aw.build(self.DATES)
        self.assertIsNone(p["now"])
        self.assertIsNone(p["forecast"])
        self.assertEqual(set(p["errors"]), {"now", "forecast"})
        self.assertEqual(len(p["observed"]["days"]), 7)
        with mock.patch.object(hc, "stations_daily_geojson", side_effect=hc.HawanamaUnavailable("x")):
            with self.assertRaises(hc.HawanamaUnavailable):
                aw.build(self.DATES)


class WatchRefreshTests(SimpleTestCase):
    def setUp(self):
        self.memo = dict(hc._watch_memo)
        self.addCleanup(lambda: hc._watch_memo.update(self.memo))

    def test_stale_digest_is_served_and_rebuilt_in_background(self):
        hc._watch_memo.update({"at": time.time() - 3600, "key": 7, "payload": {"old": True}})
        with mock.patch.object(hc, "_watch_refresh_async") as ref:
            self.assertEqual(hc.air_quality_watch(7), {"old": True})
        ref.assert_called_once_with(7)

    def test_too_old_digest_is_rebuilt_in_the_request(self):
        hc._watch_memo.update({"at": time.time() - 4 * 3600, "key": 7, "payload": {"old": True}})
        with mock.patch.object(hc, "_build_watch", return_value={"new": True}) as b:
            self.assertEqual(hc.air_quality_watch(7), {"new": True})
        b.assert_called_once()

    def test_background_refresh_failure_leaves_the_old_digest(self):
        hc._watch_memo.update({"at": time.time() - 3600, "key": 7, "payload": {"old": True}})
        with mock.patch.object(hc, "_build_watch", side_effect=RuntimeError("x")):
            hc._watch_refresh_async(7)
            end = time.time() + 5
            while hc._watch_refreshing["on"] and time.time() < end:
                time.sleep(0.01)
        self.assertFalse(hc._watch_refreshing["on"])
        self.assertEqual(hc._watch_memo["payload"], {"old": True})
