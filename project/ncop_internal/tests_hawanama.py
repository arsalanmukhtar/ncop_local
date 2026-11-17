# Unit tests for the Hawanama air-quality proxy (hawanama_client.py /
# hawanama_views.py). No network and no database: upstream calls are
# mocked. Run with
#   python manage.py test ncop_internal.tests_hawanama
import io
import json
import os
import tempfile
import time
from unittest import mock

import numpy as np
from django.test import RequestFactory, SimpleTestCase, override_settings

from . import hawanama_client as hc
from . import hawanama_views as hv


def _reset_client_state():
    hc._mem_cache.clear()
    hc._last_failure.clear()
    hc._boundary.update({"geom": None, "prepared": None, "loaded": False})


class _TmpMediaTest(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.override = override_settings(MEDIA_ROOT=self.tmp.name)
        self.override.enable()
        self.addCleanup(self.override.disable)
        _reset_client_state()
        self.addCleanup(_reset_client_state)
        # No live boundary fetch in tests: fall back to the coarse bbox.
        patcher = mock.patch("ncop_internal.landslide_lhasa2_scan._fetch_pakistan_boundary", return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)


class CacheTests(_TmpMediaTest):
    def test_fresh_then_cached_then_stale_fallback_with_backoff(self):
        with mock.patch.object(hc, "_http_get", return_value={"stations": [1]}) as get:
            p, m = hc.cached_json("stations", "api/v1/stations")
            self.assertEqual(m["source"], "upstream")
            p, m = hc.cached_json("stations", "api/v1/stations")
            self.assertEqual(m["source"], "memory")
            self.assertEqual(get.call_count, 1)
        # Expire, then make upstream fail: stale copy served, one attempt only.
        hc._mem_cache["stations"] = (time.time() - 10_000, {"stations": [1]})
        with mock.patch.object(hc, "_http_get", side_effect=OSError("down")) as get:
            p1, m1 = hc.cached_json("stations", "api/v1/stations")
            p2, m2 = hc.cached_json("stations", "api/v1/stations")
            self.assertTrue(m1["stale"] and m2["stale"])
            self.assertEqual(p1, {"stations": [1]})
            self.assertEqual(get.call_count, 1)

    def test_disk_copy_survives_restart(self):
        with mock.patch.object(hc, "_http_get", return_value={"stations": [2]}):
            hc.cached_json("stations", "api/v1/stations")
        hc._mem_cache.clear()  # simulate a process restart
        with mock.patch.object(hc, "_http_get", side_effect=AssertionError("must not refetch")):
            p, m = hc.cached_json("stations", "api/v1/stations")
        self.assertEqual(p, {"stations": [2]})
        self.assertEqual(m["source"], "disk")

    def test_bad_shape_is_not_cached_and_nothing_cached_raises(self):
        with mock.patch.object(hc, "_http_get", return_value={"unexpected": True}):
            with self.assertRaises(hc.HawanamaUnavailable):
                hc.cached_json("stations", "api/v1/stations", validate=hc._valid_stations)
        self.assertNotIn("stations", hc._mem_cache)


class StationTests(_TmpMediaTest):
    def _upstream(self, path, params=None, binary=False):
        if path.startswith("station-providers"):
            return {"by_station_id": {"aaaa1111": "PAQI"}, "by_name_city": {"Gulberg|Lahore": "Punjab EPA"},
                    "by_name": {}}
        return {"stations": [
            {"id": "aaaa1111", "name": "Korangi", "city": "Karachi", "latitude": 24.83, "longitude": 67.12,
             "pm25": 55.0, "aqi_raw": 150, "aqi_category": "unhealthy", "temp": 30, "hum": 40,
             "qc_state": "raw", "last_reading": time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime())},
            {"id": "bbbb2222", "name": "Gulberg", "city": "Lahore", "latitude": 31.5123456789, "longitude": 74.3412345678,
             "pm25": 120.0, "aqi_raw": 184, "aqi_category": "unhealthy", "last_reading": "2020-01-01T00:00:00Z"},
            {"id": "cccc3333", "name": "Dhaka", "city": "Dhaka", "latitude": 23.8, "longitude": 90.4, "pm25": 80.0},
            {"id": "dddd4444", "name": "No coords", "city": "X", "latitude": None, "longitude": None},
        ]}

    def test_geojson_filters_joins_networks_and_flags_staleness(self):
        with mock.patch.object(hc, "_http_get", side_effect=self._upstream):
            gj = hc.stations_geojson()
        names = [f["properties"]["name"] for f in gj["features"]]
        self.assertEqual(names, ["Korangi", "Gulberg"])  # Dhaka and null coords dropped
        korangi, gulberg = gj["features"]
        self.assertEqual(korangi["properties"]["network"], "PAQI")
        self.assertEqual(gulberg["properties"]["network"], "Punjab EPA")
        self.assertEqual(gulberg["geometry"]["coordinates"], [74.34123, 31.51235])  # 5 dp
        self.assertTrue(gulberg["properties"]["reading_stale"])
        self.assertFalse(korangi["properties"]["reading_stale"])
        self.assertIn("CC BY 4.0", gj["metadata"]["attribution"])
        self.assertEqual(gj["metadata"]["count"], 2)

    def test_history_validates_id(self):
        with self.assertRaises(ValueError):
            hc.station_history("../../etc")


class TileTests(_TmpMediaTest):
    def test_coverage(self):
        self.assertTrue(hc.tile_in_coverage(6, 44, 26))     # Punjab
        self.assertFalse(hc.tile_in_coverage(6, 10, 10))    # Atlantic
        self.assertFalse(hc.tile_in_coverage(13, 0, 0))     # beyond maxzoom
        self.assertFalse(hc.tile_in_coverage(3, 99, 0))     # invalid x

    def test_out_of_coverage_never_calls_upstream(self):
        with mock.patch.object(hc, "_http_get", side_effect=AssertionError("no upstream")):
            png, cacheable = hc.tile_png("2026-11-16", 6, 10, 10)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertTrue(cacheable)

    def test_complete_date_cached_on_disk_incomplete_not(self):
        png_bytes = b"\x89PNG\r\n\x1a\nfake"

        def upstream(path, params=None, binary=False):
            if "dates" in path:
                return {"details": [{"date": "2026-11-16", "complete": True}], "today_pkt": "2026-11-17"}
            return png_bytes

        with mock.patch.object(hc, "_http_get", side_effect=upstream) as get:
            _, cacheable = hc.tile_png("2026-11-16", 6, 44, 26)
            self.assertTrue(cacheable)
            hc.tile_png("2026-11-16", 6, 44, 26)  # served from disk
            tile_calls = [c for c in get.call_args_list if c.args[0].endswith(".png")]
            self.assertEqual(len(tile_calls), 1)
            _, cacheable = hc.tile_png("2026-11-17", 6, 44, 26)  # not a complete date yet
            self.assertFalse(cacheable)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, hc._TILE_SUBDIR, "2026-11-17")))

    def test_non_png_upstream_rejected(self):
        with mock.patch.object(hc, "_http_get", return_value=b"<html>error</html>"):
            with self.assertRaises(hc.HawanamaUnavailable):
                hc.tile_png("2026-11-16", 6, 44, 26)

    def test_invalid_date(self):
        with self.assertRaises(ValueError):
            hc.tile_png("2026-11-16/../../x", 6, 44, 26)


class RenderTests(SimpleTestCase):
    def test_turbo_endpoints(self):
        rgb = hc.turbo_rgb(np.array([0.15, 0.5, 1.0]))  # turbo's t=0 is near-black
        self.assertEqual(rgb.shape, (3, 3))
        self.assertTrue(rgb[0, 2] > rgb[0, 0])   # low end is blue-ish
        self.assertTrue(rgb[2, 0] > rgb[2, 2])   # high end is red-ish

    def test_grid_png_orientation_transparency_and_bounds(self):
        from PIL import Image
        # 3 rows south->north: south row low, north row high, one NaN cell.
        vals = [45, 45, 45,  100, None, 100,  180, 180, 180]
        bounds = {"west": 70.0, "east": 72.0, "south": 30.0, "north": 32.0}
        png, coords = hc.render_grid_png(vals, (3, 3), bounds, "south_to_north", upscale=2)
        img = np.array(Image.open(io.BytesIO(png)))
        self.assertEqual(img.shape, (6, 6, 4))
        self.assertTrue(img[0, 0, 0] > img[0, 0, 2])      # top (north) = high = red
        self.assertTrue(img[-1, 0, 2] > img[-1, 0, 0])    # bottom (south) = low = blue
        self.assertEqual(img[2:4, 2:4, 3].max(), 0)       # NaN cell transparent
        self.assertEqual(coords, [[69.5, 32.5], [72.5, 32.5], [72.5, 29.5], [69.5, 29.5]])


class ViewTests(_TmpMediaTest):
    def _get(self, view, path, **kwargs):
        req = RequestFactory().get(path)
        with mock.patch.object(view, "check_throttles"):
            return view.as_view()(req, **kwargs)

    def test_unavailable_returns_503_not_500(self):
        with mock.patch.object(hc, "_http_get", side_effect=OSError("down")):
            res = self._get(hv.HawanamaStationsView, "/api/hawanama/stations/")
        self.assertEqual(res.status_code, 503)
        self.assertIn("data unavailable", json.loads(res.content)["error"])

    def test_tile_failure_serves_transparent_png(self):
        with mock.patch.object(hc, "_http_get", side_effect=OSError("down")):
            res = self._get(hv.HawanamaTileView, "/x", date="2026-11-16", z="6", x="44", y="26")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res["Content-Type"], "image/png")
        self.assertIn("max-age=120", res["Cache-Control"])

    def test_point_requires_params(self):
        res = self._get(hv.HawanamaPointView, "/api/hawanama/point/?date=2026-11-16")
        self.assertEqual(res.status_code, 400)
