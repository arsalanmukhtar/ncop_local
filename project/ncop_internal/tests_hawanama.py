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
    hc._watch_memo.update({"at": 0.0, "key": None, "payload": None})
    hc._prefetched_dates.clear()


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


def _pt(city, lon, lat, pm25, **extra):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"city": city, "pm25": pm25, **extra}}


class WatchDigestTests(_TmpMediaTest):
    """National Air Quality Watch story digest (hawanama_client.air_quality_watch)."""

    GRID = {"pm25": [10, 20, 30, 40, 50, 60, 70, 80, 90], "grid": {
        "shape": [3, 3], "bounds": {"south": 30.0, "north": 32.0, "west": 70.0, "east": 72.0},
        "row_order": "south_to_north"}}

    def test_epa_category_breakpoints(self):
        self.assertEqual(hc.epa_category(9.0), "good")
        self.assertEqual(hc.epa_category(9.1), "moderate")
        self.assertEqual(hc.epa_category(55.5), "unhealthy")
        self.assertEqual(hc.epa_category(225.5), "hazardous")
        self.assertIsNone(hc.epa_category(None))

    def test_sample_grid_rows_and_neighbourhood(self):
        # Centre cell (71, 31) with its 3x3 neighbourhood = mean of all nine.
        self.assertEqual(hc.sample_grid(self.GRID, 71.0, 31.0), 50.0)
        # South-west corner, single cell: neighbours (10,20,40,50) -> 30.
        self.assertEqual(hc.sample_grid(self.GRID, 70.0, 30.0), 30.0)
        self.assertEqual(hc.sample_grid(self.GRID, 70.0, 30.0, radius_cells=0), 10.0)
        self.assertEqual(hc.sample_grid(self.GRID, 70.0, 32.0, radius_cells=0), 70.0)  # north row
        self.assertIsNone(hc.sample_grid(self.GRID, 80.0, 31.0))
        north_first = {**self.GRID, "grid": {**self.GRID["grid"], "row_order": "north_to_south"}}
        self.assertEqual(hc.sample_grid(north_first, 70.0, 32.0, radius_cells=0), 10.0)

    def test_digest_aggregates_cities_live_and_forecast(self):
        dates = ["2026-11-14", "2026-11-15", "2026-11-16"]
        daily = {
            "2026-11-14": [_pt("A", 71, 31, 100), _pt("A", 71.02, 31, 120), _pt("B", 70, 30, 10)],
            "2026-11-15": [_pt("A", 71, 31, 200), _pt("B", 70, 30, 20)],
            "2026-11-16": [_pt("A", 71, 31, 50), _pt("B", 70, 30, None), _pt("C", 72, 32, 40)],
        }
        live = {"type": "FeatureCollection", "metadata": {"data_time": "2026-11-17T10:00:00Z"}, "features": [
            _pt("A", 71, 31, 60, reading_stale=False), _pt("A", 71, 31, 80, reading_stale=False),
            _pt("B", 70, 30, 5, reading_stale=True)]}
        index = {"init_time": "2026-11-17T09:00:00+00:00", "beta": True, "leads": [
            {"lead_h": 3, "valid_time": "t3", "stats": {"mean": 50}}, {"lead_h": 24, "valid_time": "t24", "stats": {"mean": 40}}]}

        def fake_cached(key, path, params=None, ttl_name=None, validate=None):
            if key == "forecast_index":
                return index, {"fetched_at": time.time(), "stale": False, "source": "memory"}
            if key.endswith(":24"):
                return {**self.GRID, "pm25": [v * 2 for v in self.GRID["pm25"]]}, {}
            return self.GRID, {}

        with mock.patch.object(hc, "tile_dates", return_value={"dates": dates}),              mock.patch.object(hc, "stations_daily_geojson", side_effect=lambda d: {"features": daily[d]}),              mock.patch.object(hc, "stations_geojson", return_value=live),              mock.patch.object(hc, "cached_json", side_effect=fake_cached), \
             mock.patch.object(hc, "_drivers", return_value={"dates": dates}), \
             mock.patch.object(hc, "prefetch_estimate_tiles", return_value=3) as prefetch:
            d = hc.air_quality_watch(days=3)
        prefetch.assert_called_once_with(dates)
        self.assertEqual(d["errors"], {})
        pw = d["past_week"]
        self.assertEqual(pw["dates"], dates)
        a = next(c for c in pw["cities"] if c["city"] == "A")
        self.assertEqual(a["series"], [110.0, 200.0, 50.0])       # day 1 = mean of two stations
        self.assertEqual((a["mean"], a["peak"], a["peak_date"]), (120.0, 200.0, "2026-11-15"))
        self.assertEqual((a["days_above_neqs24"], a["n_stations"]), (3, 2))
        self.assertNotIn("C", [c["city"] for c in pw["cities"]])   # 1 of 3 days: below the 2-day minimum
        self.assertEqual(pw["cities"][0]["city"], "A")             # sorted worst first
        self.assertEqual(d["live"]["n_fresh"], 2)
        self.assertEqual(d["live"]["category_counts"]["unhealthy"], 2)
        fa = next(c for c in d["forecast"]["cities"] if c["city"] == "A")
        self.assertEqual(fa["peak_lead_h"], 24)
        self.assertEqual(fa["series"][1], 2 * fa["series"][0])
        self.assertEqual(d["standards"]["neqs_24h"], 35.0)

    def test_prefetch_tiles_once_per_date(self):
        tiles = hc.tiles_for_bounds(5)
        self.assertTrue(tiles)
        self.assertTrue(all(hc.tile_in_coverage(5, x, y) for x, y in tiles))
        calls = []

        with mock.patch.object(hc, "tile_png", side_effect=lambda *a: calls.append(a)):
            self.assertEqual(hc.prefetch_estimate_tiles(["2026-11-15", "bad"], zooms=(5,)), 1)
            self.assertEqual(hc.prefetch_estimate_tiles(["2026-11-15"], zooms=(5,)), 0)  # already queued
            deadline = time.time() + 10
            while len(calls) < len(tiles) and time.time() < deadline:
                time.sleep(0.02)
        self.assertEqual(len(calls), len(tiles))
        self.assertTrue(all(c[0] == "2026-11-15" and c[1] == 5 for c in calls))

    def test_fires_daily_from_cumulative_series(self):
        season = {"days": ["11-14", "11-15", "11-16"], "years": [
            {"role": "last", "cum": [1, 2, 3]}, {"role": "current", "cum": [100, 130, 190]}],
            "headline": {"fires": 190, "window": {"start": "2026-09-15", "end": "2026-11-16"},
                         "last_year": {"year": 2025, "fires": 150, "pct_change": 27}}}
        with mock.patch.object(hc, "fire_season", return_value=season):
            out = hc._fires_daily(["2026-11-15", "2026-11-16", "2026-11-20"])
        self.assertEqual(out["regions"]["punjab"], [30, 60, None])
        self.assertEqual(out["season"]["punjab"]["pct_change"], 27)

    def test_met_daily_averages_points(self):
        def loc(w, b):
            return {"hourly": {"time": ["2026-11-15T00:00", "2026-11-15T12:00", "2026-11-16T00:00"],
                               "wind_speed_10m": [w, w + 2, 9], "boundary_layer_height": [b, b * 10, 50],
                               "precipitation": [0, 1, 0], "temperature_2m": [10, 20, 12]}}
        resp = mock.Mock()
        resp.json.return_value = [loc(2, 20), loc(4, 40)]
        resp.raise_for_status.return_value = None
        with mock.patch.object(hc, "_sess") as sess:
            sess.return_value.get.return_value = resp
            out = hc._met_daily(["2026-11-15"])
        self.assertEqual(set(out), {"2026-11-15"})
        day = out["2026-11-15"]
        self.assertEqual(day["wind_kmh"], 4.0)        # mean of 3 and 5
        self.assertEqual(day["blh_max_m"], 300.0)     # mean of 200 and 400
        self.assertEqual(day["blh_min_m"], 30.0)
        self.assertEqual(day["precip_mm"], 1.0)

    def test_throttled_tile_is_transparent_png_not_429(self):
        from rest_framework.exceptions import Throttled
        req = RequestFactory().get("/x")
        with mock.patch.object(hv.HawanamaTileView, "check_throttles", side_effect=Throttled()):
            res = hv.HawanamaTileView.as_view()(req, date="2026-11-16", z="6", x="44", y="26")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res["Content-Type"], "image/png")
        self.assertEqual(res["Cache-Control"], "no-store")

    def test_digest_degrades_per_part(self):
        with mock.patch.object(hc, "tile_dates", side_effect=hc.HawanamaUnavailable("x")),              mock.patch.object(hc, "stations_geojson", return_value={"features": [], "metadata": {}}),              mock.patch.object(hc, "cached_json", side_effect=hc.HawanamaUnavailable("y")):
            d = hc.air_quality_watch()
        self.assertIsNone(d["past_week"])
        self.assertIsNone(d["forecast"])
        self.assertIsNotNone(d["live"])
        self.assertEqual(set(d["errors"]), {"past_week", "drivers", "forecast"})
        with mock.patch.object(hc, "tile_dates", side_effect=hc.HawanamaUnavailable("x")),              mock.patch.object(hc, "stations_geojson", side_effect=hc.HawanamaUnavailable("x")),              mock.patch.object(hc, "cached_json", side_effect=hc.HawanamaUnavailable("y")):
            hc._watch_memo.update({"at": 0.0, "key": None, "payload": None})
            with self.assertRaises(hc.HawanamaUnavailable):
                hc.air_quality_watch()
