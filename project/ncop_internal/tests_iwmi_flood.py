# Unit tests for the IWMI flood-forecasting proxy (cached_fetch.py,
# iwmi_flood_client.py, iwmi_flood_views.py). No network, no database.
#   python manage.py test ncop_internal.tests_iwmi_flood
import json
import tempfile
import time
from unittest import mock

from django.test import RequestFactory, SimpleTestCase, override_settings

from . import iwmi_flood_client as ic
from . import iwmi_flood_views as iv
from .cached_fetch import CachedJsonClient, Unavailable


def _point(pid, iso3, lon, lat, status="normal", river=None, fd="2026-11-12"):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"id": pid, "iso3": iso3, "river": river, "siteName": f"GloFAS pt {pid}", "status": status,
                           "status_label": status.title(), "peak_prob": 0.5 if status != "normal" else 0.0, "peak_lead": 3,
                           "thresholds": {"warning": 1000.0, "danger": 2000.0, "extreme": 3000.0}, "forecast_date": fd}}


def _series(values, p_by_lead=None):
    rows = []
    for i, v in enumerate(values):
        lead = i - 29
        p = (p_by_lead or {}).get(lead, (0.0, 0.0, 0.0)) if lead >= 1 else (None, None, None)
        rows.append({"lead_day": lead, "valid_date": f"d{lead}", "median": v, "lo": None, "hi": None,
                     "p_warn": p[0], "p_danger": p[1], "p_extreme": p[2]})
    return {"id": 1, "iso3": "PAK", "series": rows, "thresholds": {"warning": 1000.0, "danger": 2000.0, "extreme": 3000.0},
            "forecast_date": "2026-11-12", "status": "normal"}


class _Base(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ov = override_settings(MEDIA_ROOT=self.tmp.name, IWMI_FLOOD_COUNTRIES=["PAK", "IND"])
        ov.enable()
        self.addCleanup(ov.disable)
        ic.client.reset()
        self.addCleanup(ic.client.reset)
        ic._rivers.update({"tree": None, "geoms": None, "names": None, "loaded": True})  # no live rivers
        self.addCleanup(lambda: ic._rivers.update({"loaded": False}))
        p = mock.patch.object(ic, "prefetch_series_async")  # never start background threads in tests
        p.start()
        self.addCleanup(p.stop)


class CachedFetchTests(SimpleTestCase):
    def test_ttl_stale_fallback_backoff_and_validation(self):
        with tempfile.TemporaryDirectory() as tmp, override_settings(MEDIA_ROOT=tmp):
            c = CachedJsonClient("t", "http://x", {"k": 60}, "t_cache", "ua", backoff_seconds=300)
            with mock.patch.object(c, "http_get", return_value={"ok": 1}) as get:
                self.assertEqual(c.get("k", "p")[1]["source"], "upstream")
                self.assertEqual(c.get("k", "p")[1]["source"], "memory")
                self.assertEqual(get.call_count, 1)
            c._mem["k"] = (time.time() - 1000, {"ok": 1})
            with mock.patch.object(c, "http_get", side_effect=OSError) as get:
                self.assertTrue(c.get("k", "p")[1]["stale"])
                self.assertTrue(c.get("k", "p")[1]["stale"])
                self.assertEqual(get.call_count, 1)
            with mock.patch.object(c, "http_get", return_value={"bad": 1}):
                with self.assertRaises(Unavailable):
                    c.get("k:other", "p", ttl_name="k", validate=lambda p: "ok" in p)


class QualityAndStatusTests(SimpleTestCase):
    def test_flat_zero_and_tiny_series_are_unreliable(self):
        self.assertEqual(ic.series_quality(_series([0.0] * 45))[0], "unreliable")
        self.assertEqual(ic.series_quality(_series([20.0] * 45))[0], "unreliable")  # 2% of warning
        q, ratio = ic.series_quality(_series([500.0] * 45))
        self.assertEqual((q, ratio), ("ok", 0.5))

    def test_status_for_lead_uses_worst_level_over_cutoff(self):
        self.assertEqual(ic.status_for_lead({"p_warn": 0.9, "p_danger": 0.31, "p_extreme": 0.1}), "danger")
        self.assertEqual(ic.status_for_lead({"p_warn": 0.29, "p_danger": 0.0, "p_extreme": 0.0}), "normal")
        self.assertEqual(ic.status_for_lead({"p_warn": None, "p_danger": None, "p_extreme": 0.5}), "extreme")


class GlofasPointsTests(_Base):
    def _upstream(self, path, params=None):
        if path == "forecasts/glofas/reference-points":
            if params["iso3"] == "PAK":
                return {"type": "FeatureCollection", "features": [_point(1446, "PAK", 71.7, 28.8),
                                                                 _point(1470, "PAK", 72.4, 33.9, "warning")]}
            raise OSError("IND down")
        if path.endswith("/discharge"):
            pid = int(path.split("/")[3])
            return _series([0.0] * 45) if pid == 1446 else _series([900.0] * 45, {2: (0.8, 0.4, 0.0)})
        raise AssertionError(path)

    def test_merge_quality_failed_countries_and_run_age(self):
        with mock.patch.object(ic.client, "http_get", side_effect=self._upstream):
            gj = ic.glofas_points_geojson()
            self.assertEqual(gj["metadata"]["failed_countries"], ["IND"])
            self.assertEqual(gj["metadata"]["unchecked"], 2)
            self.assertTrue(gj["metadata"]["stale"])  # a country failed
            ic.prefetch_series([(1446, "2026-11-12"), (1470, "2026-11-12")], workers=1)
            gj = ic.glofas_points_geojson()
        q = {f["properties"]["id"]: f["properties"]["quality"] for f in gj["features"]}
        self.assertEqual(q, {1446: "unreliable", 1470: "ok"})
        p1470 = next(f["properties"] for f in gj["features"] if f["properties"]["id"] == 1470)
        self.assertEqual((p1470["warning"], p1470["color"]), (1000.0, "#E7B416"))
        self.assertIsNotNone(gj["metadata"]["run_age_days"])

    def test_forecast_days_statuses(self):
        with mock.patch.object(ic.client, "http_get", side_effect=self._upstream):
            ic.prefetch_series([(1446, "2026-11-12"), (1470, "2026-11-12")], workers=1)
            fd = ic.glofas_forecast_days_geojson()
        props = {f["properties"]["id"]: f["properties"] for f in fd["features"]}
        self.assertEqual(props[1470]["s_2"], "danger")
        self.assertEqual(props[1470]["s_1"], "normal")
        self.assertEqual(fd["metadata"]["leads"][0], 1)
        self.assertEqual(fd["metadata"]["leads"][-1], 15)

    def test_point_id_validated(self):
        with self.assertRaises(ValueError):
            ic.glofas_point_discharge(0)


class FloodhubTests(_Base):
    def _upstream(self, path, params=None):
        if path == "flood/gauges":
            return {"type": "FeatureCollection", "features": [{
                "type": "Feature", "geometry": {"type": "Point", "coordinates": [68.25, 29.79]},
                "properties": {"gaugeId": f"hybas_{params['iso3']}", "severity": "SEVERE" if params["iso3"] == "IND" else "NO_FLOODING",
                               "severity_label": "x", "color": "#E2683C", "forecastTrend": "RISE", "river": "", "siteName": "",
                               "qualityVerified": True, "hasModel": True, "issuedTime": "2026-11-17T08:00:00Z",
                               "forecastTimeRange": {"start": "2026-11-18T00:00:00Z", "end": "2026-11-19T00:00:00Z"},
                               "thresholds": {"warningLevel": 10, "dangerLevel": 20, "extremeDangerLevel": 40},
                               "unit": "CUBIC_METERS_PER_SECOND"}}]}
        if path == "forecasts/glofas/reference-points":
            return {"type": "FeatureCollection", "features": []}
        raise AssertionError(path)

    def test_gauges_flattened_and_status_rollup(self):
        with mock.patch.object(ic.client, "http_get", side_effect=self._upstream):
            gj = ic.floodhub_gauges_geojson()
            st = ic.regional_status()
        self.assertEqual(len(gj["features"]), 2)
        p = gj["features"][0]["properties"]
        self.assertEqual((p["warning"], p["danger"], p["extreme"], p["trend"]), (10, 20, 40, "RISE"))
        self.assertIsNone(p["river"])  # blank IWMI river, no NCOP rivers loaded in tests
        self.assertEqual(st["countries"]["IND"]["floodhub"]["worst"], "SEVERE")
        self.assertEqual(st["countries"]["IND"]["floodhub"]["counts"]["SEVERE"], 1)
        self.assertEqual(st["totals"]["floodhub_flooding"], 1)
        self.assertEqual(st["top_alerts"][0]["iso3"], "IND")
        self.assertEqual(st["countries"]["PAK"]["floodhub"]["worst"], "NO_FLOODING")

    def test_gauge_id_validated(self):
        with self.assertRaises(ValueError):
            ic.floodhub_gauge_discharge("../../etc/passwd")


class ViewTests(_Base):
    def _get(self, view, **kw):
        req = RequestFactory().get("/x")
        with mock.patch.object(view, "check_throttles"):
            return view.as_view()(req, **kw)

    def test_upstream_down_gives_503(self):
        with mock.patch.object(ic.client, "http_get", side_effect=OSError("down")):
            for v in (iv.IwmiGlofasPointsView, iv.IwmiFloodhubGaugesView, iv.IwmiFloodhubInundationView, iv.IwmiStatusView):
                res = self._get(v)
                self.assertEqual(res.status_code, 503, v.__name__)
                self.assertEqual(json.loads(res.content)["error"], "data unavailable")

    def test_bad_gauge_id_gives_400(self):
        res = self._get(iv.IwmiFloodhubGaugeDischargeView, gauge_id="a b")
        self.assertEqual(res.status_code, 400)
