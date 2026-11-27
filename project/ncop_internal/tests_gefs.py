# Unit tests for the NOAA GEFS 35-day outlook (gefs_client.py / gefs_views.py).
# No network and no database: downloads and GRIB decoding are mocked.
#   python manage.py test ncop_internal.tests_gefs
import io
import json
import os
import tempfile
from unittest import mock

import numpy as np
from django.test import RequestFactory, SimpleTestCase, override_settings

from . import gefs_client as gc
from . import gefs_districts as gd
from . import gefs_views as gv

IDX = (
    "1:0:d=2026111900:HGT:10 mb:240 hour fcst:ens mean\n"
    "2:100:d=2026111900:TMP:2 m above ground:{h} hour fcst:ens mean\n"
    "3:300:d=2026111900:APCP:surface:{a}-{h} hour acc fcst:ens mean\n"
    "4:400:d=2026111900:CSNOW:surface:x\n"
)
HR_SHAPE, LR_SHAPE = gc._grid_shape(gc._HR), gc._grid_shape(gc._LR)


def _fake_step(run, lead):
    # precip 1 mm per 6 h everywhere; temperature = lead/24 deg C
    shape = gc._grid_shape(gc._product(lead))
    return lead, np.full(shape, 1.0, np.float32), np.full(shape, lead / 24.0, np.float32)


class _Tmp(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        ov = override_settings(MEDIA_ROOT=self.tmp.name)
        ov.enable()
        self.addCleanup(ov.disable)
        gc._values_cache.update(run=None, data=None)
        gc._state.update(listing_at=0.0, latest=None)
        # Clock pinned to 1 h after the test run's init (no past days).
        from datetime import datetime, timezone
        clock = mock.patch.object(gc, "_now", return_value=datetime(2026, 11, 19, 1, tzinfo=timezone.utc))
        self.now = clock.start()
        self.addCleanup(clock.stop)
        # Tiny frames keep the suite fast; geometry/logic are unchanged.
        for p in (mock.patch.dict(gc._HR, upscale=1), mock.patch.dict(gc._LR, upscale=1)):
            p.start()
            self.addCleanup(p.stop)

    def _build(self, run="2026111900"):
        with mock.patch.object(gc, "fetch_step", side_effect=_fake_step):
            self.assertTrue(gc.build_run(run))


class ParsingTests(SimpleTestCase):
    def test_region_grids(self):
        self.assertEqual(HR_SHAPE, (205, 389))     # 0.25 deg, 44-141 E, 11 S-40 N
        self.assertEqual(LR_SHAPE, (103, 195))     # 0.5 deg
        self.assertEqual(len(gc._LEADS), 140)
        self.assertEqual(gc._product(240), gc._HR)
        self.assertEqual(gc._product(246), gc._LR)

    def test_byte_range_finds_record_and_end(self):
        idx = IDX.format(h=240, a=234)
        self.assertEqual(gc._byte_range(idx, ":APCP:surface:")[:2], (300, 399))
        self.assertEqual(gc._byte_range(idx, ":TMP:2 m above ground:")[:2], (100, 299))
        with self.assertRaises(ValueError):
            gc._byte_range(idx, ":PRMSL:")

    def test_fetch_step_rejects_non_6h_bucket_and_wrong_grid(self):
        class R:
            def __init__(self, text="", content=b""):
                self.text, self.content = text, content

        def get(a):
            return lambda url, headers=None: R(text=IDX.format(h=12, a=a)) if url.endswith(".idx") else R(content=b"x")

        good = np.ones(HR_SHAPE, np.float32)
        with mock.patch.object(gc, "_get", side_effect=get(0)), mock.patch.object(gc, "decode_window", return_value=good):
            with self.assertRaises(ValueError):            # 0-12 h is not a 6 h bucket
                gc.fetch_step("2026111900", 12)
        with mock.patch.object(gc, "_get", side_effect=get(6)), \
             mock.patch.object(gc, "decode_window", return_value=np.ones(LR_SHAPE, np.float32)):
            with self.assertRaises(ValueError):            # 0.5 deg grid where 0.25 deg expected
                gc.fetch_step("2026111900", 12)
        with mock.patch.object(gc, "_get", side_effect=get(6)), mock.patch.object(gc, "decode_window", return_value=good) as dec:
            lead, p, t = gc.fetch_step("2026111900", 12)
        self.assertEqual((lead, p.shape, dec.call_count), (12, HR_SHAPE, 2))


class AggregationRenderTests(SimpleTestCase):
    def test_daily_totals_and_means_across_grids(self):
        acc = gc.DailyAccumulator()
        for h in gc._LEADS:
            shape = gc._grid_shape(gc._product(h))
            acc.add(h, np.full(shape, 1.5, np.float32), np.full(shape, float(h), np.float32))
        acc.finish()
        self.assertAlmostEqual(float(gc.day_grid(acc.precip, 1)[0, 0]), 6.0)
        self.assertEqual(gc.day_grid(acc.precip, 10).shape, HR_SHAPE)
        self.assertEqual(gc.day_grid(acc.precip, 11).shape, LR_SHAPE)
        self.assertAlmostEqual(float(gc.day_grid(acc.t2m, 1)[0, 0]), (6 + 12 + 18 + 24) / 4)
        self.assertAlmostEqual(float(gc.day_grid(acc.t2m, 35)[0, 0]), (822 + 828 + 834 + 840) / 4)

    def test_missing_step_rejected(self):
        acc = gc.DailyAccumulator()
        for h in gc._LEADS[:-1]:
            shape = gc._grid_shape(gc._product(h))
            acc.add(h, np.zeros(shape, np.float32), np.zeros(shape, np.float32))
        with self.assertRaises(ValueError):
            acc.finish()

    def test_classes_and_dry_or_nan_transparent(self):
        sc = gc.COLORSCALES["precip"]
        self.assertEqual(len(sc["colors"]), len(sc["bounds"]) + 1)
        self.assertEqual(len(gc.COLORSCALES["t2m"]["colors"]), len(gc.COLORSCALES["t2m"]["bounds"]) + 1)
        self.assertEqual(list(gc.classify(np.array([0.2, 0.5, 9.9, 10, 500], np.float32), sc)), [0, 1, 6, 7, 14])
        rgba = gc.colorize(np.array([0.2, 10.0, np.nan], np.float32), sc, edges=False)
        self.assertEqual((rgba[0, 3], rgba[2, 3]), (0, 0))
        self.assertEqual(tuple(rgba[1, :3]), gc._hex_rgb(sc["colors"][7]))

    def test_class_boundaries_are_outlined(self):
        field = np.array([[1.5, 1.5, 12.0, 12.0]] * 3, np.float32)
        rgba = gc.colorize(field, gc.COLORSCALES["precip"])
        self.assertEqual(rgba[0, 1, 3], 255)                       # boundary pixel: opaque, darker
        self.assertLess(int(rgba[0, 1, :3].sum()), int(rgba[0, 0, :3].sum()))
        self.assertEqual(rgba[0, 0, 3], gc._CLASS_ALPHA)

    def test_render_palette_png_size_and_corners(self):
        from PIL import Image
        png, coords = gc.render_png(np.full((20, 30), 20.0, np.float32), "t2m", 0.25, 4)
        img = Image.open(io.BytesIO(png))
        self.assertEqual((img.mode, img.size), ("P", (120, 80)))
        self.assertEqual(coords[0], [43.875, 40.125])
        self.assertEqual(coords[2], [141.125, -11.125])
        rgba = np.asarray(img.convert("RGBA"))
        self.assertEqual(rgba[40, 60, 3], gc._CLASS_ALPHA)          # alpha survives the palette


class BuildTests(_Tmp):
    def test_build_publishes_atomically_and_prunes(self):
        for run in ("2026111500", "2026111600", "2026111700", "2026111800", "2026111900"):
            self._build(run)
        self.assertEqual(gc.built_runs(), ["2026111600", "2026111700", "2026111800", "2026111900"])   # keeps 4 (lag)
        m = gc.manifest()
        self.assertEqual((m["run"], m["data_version"]), ("2026111900", gc.DATA_VERSION))
        fr = m["frames"]["precip"]
        self.assertEqual(len(fr), 35)
        self.assertEqual((fr[9]["resolution_deg"], fr[10]["resolution_deg"]), (0.25, 0.5))
        self.assertNotEqual(fr[9]["coordinates"], fr[10]["coordinates"])
        self.assertTrue(fr[14]["extended"] and not fr[13]["extended"])
        self.assertEqual(fr[0]["stats"]["mean"], 4.0)                       # 4 x 1 mm
        self.assertFalse([d for d in os.listdir(gc._root()) if d.startswith((".tmp-", ".old-"))])

    def test_failed_download_never_publishes(self):
        with mock.patch.object(gc, "fetch_step", side_effect=RuntimeError("down")):
            with self.assertRaises(RuntimeError):
                gc.build_run("2026111900")
        self.assertEqual(gc.built_runs(), [])
        self.assertFalse(os.path.exists(gc._lock_path()))                   # lock released
        with self.assertRaises(gc.GefsUnavailable):
            gc.manifest()

    def test_lock_blocks_parallel_build(self):
        open(gc._lock_path(), "w").close()
        with mock.patch.object(gc, "fetch_step", side_effect=_fake_step) as f:
            self.assertFalse(gc.build_run("2026111900"))
        f.assert_not_called()

    def test_old_layout_serves_until_rebuilt_then_pruned(self):
        old = os.path.join(gc._root(), "2026111900")
        os.makedirs(old)
        json.dump({"run": "2026111900", "init_time": "2026-11-19T00:00:00+00:00", "days": 35, "daily_skill_days": 14,
                   "coordinates": [[59.75, 38.25], [78.25, 38.25], [78.25, 22.75], [59.75, 22.75]],
                   "colorscales": {"precip": {"unit": "mm/day"}, "t2m": {"unit": "°C"}},
                   "frames": {"precip": [{"day": 1, "file": "precip_d01.png"}], "t2m": []}},
                  open(os.path.join(old, "manifest.json"), "w", encoding="utf-8"))
        self.assertEqual(gc.built_runs(), [])                               # not current layout
        with mock.patch.object(gc, "refresh_async") as ra:
            d = gc.frames("precip", lambda n: "/media/gefs/" + n)
        ra.assert_called()                                                  # rebuild kicked off
        self.assertTrue(d["building_newer"])
        self.assertEqual(d["frames"][0]["coordinates"][0], [59.75, 38.25])  # legacy run still served
        self._build("2026111900")                                           # same run id, new layout
        self.assertEqual(gc.manifest()["data_version"], gc.DATA_VERSION)
        self.assertEqual(gc.built_runs(current_only=False), ["2026111900"])

    def test_outdated_render_is_redrawn_from_values(self):
        self._build()
        d = os.path.join(gc._root(), "2026111900")
        m = gc.manifest()
        old = os.path.join(d, "precip_d01_old.png")
        open(old, "wb").close()
        m["render_version"] = 1
        m["frames"]["precip"][0]["file"] = "precip_d01_old.png"
        json.dump(m, open(os.path.join(d, "manifest.json"), "w", encoding="utf-8"))
        self.assertTrue(gc.rerender_run("2026111900"))
        m2 = gc.manifest()
        self.assertEqual(m2["render_version"], gc.RENDER_VERSION)
        self.assertTrue(os.path.exists(os.path.join(d, m2["frames"]["precip"][0]["file"])))
        self.assertFalse(os.path.exists(old))                               # superseded frame removed
        self.assertFalse(gc.rerender_run("2026111900"))                     # already current

    def test_point_value_both_grids_and_week_total(self):
        self._build()
        lahore = gc.point_value("precip", 2, 31.55, 74.34)
        self.assertEqual((lahore["value"], lahore["week_total"], lahore["resolution_deg"]), (4.0, 28.0, 0.25))
        dhaka = gc.point_value("t2m", 20, 23.8, 90.4)
        self.assertEqual(dhaka["resolution_deg"], 0.5)
        self.assertTrue(dhaka["extended"])
        self.assertAlmostEqual(dhaka["value"], (462 + 468 + 474 + 480) / 4 / 24, places=1)
        self.assertEqual(gc.point_value("precip", 8, 6.9, 79.9)["week_total"], 28.0)   # Colombo, week spans both grids
        self.assertIsNone(gc.point_value("t2m", 1, 50, 10)["value"])
        with self.assertRaises(ValueError):
            gc.point_value("t2m", 36, 30, 70)

    def test_run_complete_needs_every_file_of_both_products(self):
        names = set()
        for prod in gc._PRODUCTS:
            prefix = f"gefs.20261119/00/atmos/{prod['path']}.f"
            for h in prod["leads"]:
                names |= {f"{prefix}{h:03d}", f"{prefix}{h:03d}.idx"}
        with mock.patch.object(gc, "_listing", return_value=names):
            self.assertTrue(gc.run_complete("2026111900"))
        missing = {n for n in names if not n.endswith("pgrb2a.0p50.f840.idx")}
        with mock.patch.object(gc, "_listing", return_value=missing):
            self.assertFalse(gc.run_complete("2026111900"))


class ViewTests(_Tmp):
    def _get(self, view, path):
        with mock.patch.object(view, "check_throttles"):
            return view.as_view()(RequestFactory().get(path))

    def test_frames_202_while_building_then_200(self):
        with mock.patch.object(gc, "refresh_async") as ra:
            res = self._get(gv.GefsFramesView, "/api/gefs/frames/?var=precip")
        self.assertEqual(res.status_code, 202)
        ra.assert_called()
        self._build()
        gc._state["listing_at"] = 1e18                                      # no background check in this test
        res = self._get(gv.GefsFramesView, "/api/gefs/frames/?var=t2m")
        self.assertEqual(res.status_code, 200)
        d = json.loads(res.content)
        self.assertEqual(len(d["frames"]), 35)
        self.assertTrue(d["frames"][0]["url"].endswith(f"/gefs/2026111900/t2m_d01_r{gc.RENDER_VERSION}_{gc._product_tag()}.png"))
        self.assertEqual(d["frames"][0]["resolution_deg"], 0.25)

    def test_bad_params_400(self):
        self.assertEqual(self._get(gv.GefsFramesView, "/api/gefs/frames/?var=wind").status_code, 400)
        self.assertEqual(self._get(gv.GefsPointView, "/api/gefs/point/?var=t2m&day=x&lat=1&lon=2").status_code, 400)


def _square_district(raster, lr_col, lr_row):
    """Mark fine pixels of exactly one 0.5 deg cell (global LR col/row) as district 1."""
    gx0, gy0 = gd._fine_offsets()
    x, y = lr_col * 20 - gx0, lr_row * 20 - gy0
    raster[y:y + 20, x:x + 20] = 1


class DistrictTests(_Tmp):
    META = [{"name": "Testabad", "province": "Punjab", "division": "X", "bbox": [70, 30, 70.5, 30.5], "centroid": [70.25, 30.25]}]

    def setUp(self):
        super().setUp()
        gd._state.update(failed_at=0.0, thread_alive=False)
        self.raster = np.zeros(gd._window_shape(), np.int16)
        # LR cell centred at 70.0 E, 30.0 N
        self.col, self.row = int((70.0 - gc.REGION["west"]) / 0.5), int((gc.REGION["north"] - 30.0) / 0.5)
        _square_district(self.raster, self.col, self.row)

    def test_weights_exact_on_both_grids(self):
        w = gd.build_weights(self.raster, 1)
        lr_nx = gc._grid_shape(gc._LR)[1]
        self.assertEqual(w["lr"]["cell"].tolist(), [self.row * lr_nx + self.col])
        self.assertAlmostEqual(float(w["lr"]["weight"][0]), 1.0, places=6)
        # A 0.5 deg cell overlaps 3 x 3 quarter-degree cells (5/10/5 pixel strips)
        self.assertEqual(len(w["hr"]["cell"]), 9)
        self.assertAlmostEqual(float(w["hr"]["weight"].sum()), 1.0, places=5)
        self.assertAlmostEqual(float(w["hr"]["weight"].max()), 0.25, places=5)

    def test_stats_per_day_and_view(self):
        self._build()
        gd.save_index(gd.build_weights(self.raster, 1), self.META)
        p = gd.district_stats("precip")
        self.assertEqual(len(p["dates"]), gc.DAYS)
        x = p["districts"][0]
        self.assertEqual(x["name"], "Testabad")
        self.assertEqual(x["precip"], [4.0] * gc.DAYS)      # 4 x 1 mm buckets per day
        self.assertNotIn("t2m", x)
        t = gd.district_stats("t2m")["districts"][0]
        # daily mean of leads 24d-18, -12, -6, 24d hours / 24  ->  d - 0.375
        self.assertAlmostEqual(t["t2m"][0], 0.625, delta=0.06)
        self.assertAlmostEqual(t["t2m"][34], 34.625, delta=0.06)
        self.assertEqual(t["t2m_min"][5], t["t2m_max"][5])
        r = gv.GefsDistrictsView.as_view()(RequestFactory().get("/api/gefs/districts/", {"var": "t2m"}))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(json.loads(r.content)["districts"][0]["province"], "Punjab")

    def test_no_index_202_while_building_503_when_down(self):
        self._build()
        with mock.patch.object(gd, "build_index", side_effect=lambda: __import__("time").sleep(0.3)):
            r = gv.GefsDistrictsView.as_view()(RequestFactory().get("/api/gefs/districts/", {"var": "precip"}))
            self.assertEqual(r.status_code, 202)
        gd._state.update(failed_at=__import__("time").time(), thread_alive=False)
        r = gv.GefsDistrictsView.as_view()(RequestFactory().get("/api/gefs/districts/", {"var": "precip"}))
        self.assertEqual(r.status_code, 503)
        r = gv.GefsDistrictsView.as_view()(RequestFactory().get("/api/gefs/districts/", {"var": "wind"}))
        self.assertIn(r.status_code, (400, 503))


class TodayWindowTests(_Tmp):
    def test_past_days_dropped_from_frames_and_districts(self):
        from datetime import datetime, timezone
        self._build()
        self.now.return_value = datetime(2026, 11, 22, 5, tzinfo=timezone.utc)   # 3 days later
        f = gc.frames("precip", lambda n: n)
        self.assertEqual((f["first_day"], f["days"], len(f["frames"])), (4, 32, 32))
        self.assertEqual(f["frames"][0]["day"], 4)                               # run day kept for point lookups
        self.assertTrue(f["frames"][0]["valid_start"].startswith("2026-11-22"))
        raster = np.zeros(gd._window_shape(), np.int16)
        _square_district(raster, int((70.0 - gc.REGION["west"]) / 0.5), int((gc.REGION["north"] - 30.0) / 0.5))
        gd.save_index(gd.build_weights(raster, 1), DistrictTests.META)
        d = gd.district_stats("t2m")
        self.assertEqual((d["days"], d["run_day_offset"], d["dates"][0]), (32, 3, "2026-11-22"))
        self.assertEqual(len(d["districts"][0]["t2m"]), 32)
        self.assertEqual(d["daily_skill_days"], 11)
        # Far in the future: the last day is always kept
        self.now.return_value = datetime(2027, 1, 30, tzinfo=timezone.utc)
        self.assertEqual(len(gc.frames("precip", lambda n: n)["frames"]), 1)


def _fake_step_offset(offset):
    """Like _fake_step but every value is shifted, so runs are distinguishable."""
    def step(run, lead):
        shape = gc._grid_shape(gc._product(lead))
        return lead, np.full(shape, 1.0 + offset, np.float32), np.full(shape, offset, np.float32)
    return step


class LagTests(_Tmp):
    def test_lag_blend_alignment_weights_and_horizon(self):
        ny, nx = 2, 3
        newest = np.full((25, ny, nx), 10.0, np.float32)
        older = np.stack([np.full((ny, nx), 100.0 + i, np.float32) for i in range(25)])   # value = 100 + local index
        out = gc.lag_blend(newest, {1: older}, weights=(1.0, 1.0), from_day=11)
        # newest local day i (day 11+i) pairs with older local index i+1
        self.assertAlmostEqual(float(out[0, 0, 0]), (10.0 + 101.0) / 2, places=4)
        self.assertAlmostEqual(float(out[23, 0, 0]), (10.0 + 124.0) / 2, places=4)
        self.assertAlmostEqual(float(out[24, 0, 0]), 10.0, places=4)          # older run has no day 36
        # from_day later than 11: first days untouched
        out = gc.lag_blend(newest, {1: older}, weights=(1.0, 1.0), from_day=15)
        self.assertAlmostEqual(float(out[3, 0, 0]), 10.0, places=4)
        self.assertAlmostEqual(float(out[4, 0, 0]), (10.0 + 105.0) / 2, places=4)
        # NaN cells and missing runs drop out; weights renormalise
        older2 = older.copy()
        older2[1, 0, 0] = np.nan
        out = gc.lag_blend(newest, {1: older2, 2: None}, weights=(3.0, 1.0, 1.0), from_day=11)
        self.assertAlmostEqual(float(out[0, 0, 0]), 10.0, places=4)
        self.assertAlmostEqual(float(out[0, 0, 1]), (3 * 10.0 + 101.0) / 4, places=4)

    def test_build_with_lag_uses_previous_runs_and_keeps_raw(self):
        with mock.patch.object(gc, "fetch_step", side_effect=_fake_step_offset(0.0)):
            self.assertTrue(gc.build_run("2026111800"))
        with mock.patch.object(gc, "LAG_WEIGHTS", (1.0, 1.0)), \
             mock.patch.object(gc, "fetch_step", side_effect=_fake_step_offset(2.0)):
            self.assertTrue(gc.build_run("2026111900"))
            m = gc.manifest()
            self.assertEqual(m["product"]["runs"], ["2026111900", "2026111800"])
            self.assertTrue(gc._product_current(m))
            d = os.path.join(gc._root(), "2026111900")
            raw, prod = gc._load_values(d), gc._load_product(d)
            # days 1-10 untouched; day 11+ = mean of the two runs' temperatures (2 and 0)
            self.assertAlmostEqual(float(gc.day_grid(prod["t2m"], 10)[5, 5]), float(gc.day_grid(raw["t2m"], 10)[5, 5]))
            self.assertAlmostEqual(float(gc.day_grid(raw["t2m"], 20)[5, 5]), 2.0, places=2)
            self.assertAlmostEqual(float(gc.day_grid(prod["t2m"], 20)[5, 5]), 1.0, places=2)
            self.assertAlmostEqual(float(gc.day_grid(prod["t2m"], 35)[5, 5]), 2.0, places=2)   # older run ends at day 34
            v = gc.point_value("t2m", 20, 30.0, 70.0)
            self.assertAlmostEqual(v["value"], 1.0, places=1)

    def test_served_run_upgraded_when_recipe_changes(self):
        for i, run in enumerate(("2026111800", "2026111900")):
            with mock.patch.object(gc, "fetch_step", side_effect=_fake_step_offset(2.0 * i)):
                self.assertTrue(gc.build_run(run))
        self.assertTrue(gc._product_current(gc.manifest()))
        with mock.patch.object(gc, "LAG_WEIGHTS", (1.0, 1.0)):
            self.assertFalse(gc._product_current(gc.manifest()))
            gc._upgrade_served()
            m = gc.manifest()
            self.assertTrue(gc._product_current(m))
            self.assertEqual(m["render_version"], gc.RENDER_VERSION)
            prod = gc._load_product(os.path.join(gc._root(), "2026111900"))
            self.assertAlmostEqual(float(gc.day_grid(prod["t2m"], 20)[5, 5]), 1.0, places=2)
            for fr in m["frames"]["t2m"]:
                self.assertTrue(os.path.exists(os.path.join(gc._root(), "2026111900", fr["file"])))
        # switching lagging off again removes the lag files
        gc._upgrade_served()
        self.assertFalse(os.path.exists(os.path.join(gc._root(), "2026111900", "t2m_lr_lag.npy")))


class VerifyTests(SimpleTestCase):
    def test_lagged_series_and_scores(self):
        from . import gefs_verify as gv
        newest = np.zeros((2, 35), np.float32)
        older = np.tile(np.arange(35, dtype=np.float32), (2, 1))
        out = gv.lagged([newest, older], [1.0, 1.0], first_lag_day=11)
        self.assertEqual(float(out[0, 9]), 0.0)                     # day 10: newest only
        self.assertEqual(float(out[0, 10]), (0.0 + 11.0) / 2)       # day 11 <- older day 12
        self.assertEqual(float(out[0, 34]), 0.0)                    # older has no day 36
        rng = np.random.default_rng(0)
        obs = rng.normal(size=(6, 2, 35)).astype(np.float32)
        perfect = gv.score([(o, o, None) for o in obs], "t2m")
        self.assertEqual(perfect["weekly"][0]["mae"], 0.0)
        self.assertAlmostEqual(perfect["weekly"][0]["acc"], 1.0, places=5)
        biased = gv.score([(o + 2, o, None) for o in obs], "t2m")
        self.assertAlmostEqual(biased["daily"][0]["bias"], 2.0, places=5)


class CalibrationTests(_Tmp):
    def _synthetic(self, n_case=60, n_d=3, t_bias=1.5, p_ratio=0.5, seed=1):
        from datetime import date, timedelta
        rng = np.random.default_rng(seed)
        inits = [date(2025, 1, 1) + timedelta(days=7 * i) for i in range(n_case)]
        ob_t = rng.normal(15, 3, (n_case, n_d, 5))
        ob_p = rng.gamma(4.0, 6.0, (n_case, n_d, 5))
        fc_t = ob_t + t_bias + rng.normal(0, 0.3, ob_t.shape)
        fc_p = ob_p * p_ratio * np.exp(rng.normal(0, 0.1, ob_p.shape))
        return inits, {"t2m": fc_t, "precip": fc_p}, {"t2m": ob_t, "precip": ob_p}

    def test_fit_recovers_known_bias_and_respects_limits(self):
        from . import gefs_calibration as gcal
        inits, fc, ob = self._synthetic()
        doy = np.array([d.timetuple().tm_yday for d in inits])
        b = gcal.fit_bias(fc["t2m"], ob["t2m"], doy, 100, "t2m")
        self.assertTrue(np.allclose(b, 1.5, atol=0.25))
        r = gcal.fit_bias(fc["precip"], ob["precip"], doy, 100, "precip")
        self.assertTrue(np.all(r <= gcal.RATIO_MAX) and np.all(r > 1.5), r)       # ~2x, regularised
        dry = gcal.fit_bias(fc["precip"] * 0.02, ob["precip"] * 0.04, doy, 100, "precip")
        self.assertTrue(np.all(dry == 1.0))                                       # below DRY_MM: no scaling
        huge = gcal.fit_bias(fc["t2m"] + 50, ob["t2m"], doy, 100, "t2m")
        self.assertTrue(np.all(huge <= gcal.T_MAX_SHIFT))
        wet = gcal.fit_bias(fc["precip"] * 0.01, ob["precip"], doy, 100, "precip")
        self.assertTrue(np.all(wet <= gcal.RATIO_MAX))

    def test_blocked_cv_never_trains_on_overlapping_cases(self):
        from . import gefs_calibration as gcal
        inits, fc, ob = self._synthetic(n_case=12)
        seen = []
        real = gcal.fit_bias

        def spy(f, o, doy, target, var, train_mask=None, pool="district"):
            seen.append(np.asarray(train_mask).copy())
            return real(f, o, doy, target, var, train_mask, pool)

        with mock.patch.object(gcal, "fit_bias", side_effect=spy):
            gcal.cross_validate(fc["t2m"], ob["t2m"], inits, "t2m", "district")
        ords = np.array([d.toordinal() for d in inits])
        for c, mask in enumerate(seen):
            self.assertFalse(mask[c])
            self.assertTrue(np.all(np.abs(ords[mask] - ords[c]) > 35))

    def test_train_enables_helpful_weeks_and_apply_corrects(self):
        from datetime import date
        from . import gefs_calibration as gcal
        inits, fc, ob = self._synthetic()
        meta = [{"name": f"D{i}", "province": "P"} for i in range(3)]
        model, report = gcal.train(fc, ob, inits, meta)
        for season, weeks in report["vars"]["t2m"]["enabled"].items():
            self.assertEqual(weeks, [1, 2, 3, 4, 5], season)
        for season, weeks in report["vars"]["precip"]["enabled"].items():
            self.assertEqual(weeks, [1, 2, 3, 4, 5], season)
        gcal.save(model, report)
        st = {k: np.full((3, 35), 10.0, np.float32) for k in ("t2m_mean", "t2m_min", "t2m_max", "precip_mean", "precip_max")}
        prov = gcal.apply(st, date(2025, 4, 10), meta)
        self.assertIsNotNone(prov)
        self.assertTrue(np.allclose(st["t2m_mean"], 8.5, atol=0.3))
        self.assertTrue(np.all(st["precip_mean"] > 16))
        # a different district set (index rebuilt) -> model not applied
        st2 = {k: np.full((3, 35), 10.0, np.float32) for k in st}
        self.assertIsNone(gcal.apply(st2, date(2025, 4, 10), [{"name": "X", "province": "Y"}] * 3))
        self.assertTrue(np.all(st2["t2m_mean"] == 10.0))

    def test_unhelpful_correction_stays_off(self):
        from . import gefs_calibration as gcal
        inits, fc, ob = self._synthetic(n_case=120, t_bias=0.0, p_ratio=1.0)
        meta = [{"name": f"D{i}", "province": "P"} for i in range(3)]
        _, report = gcal.train(fc, ob, inits, meta)
        # 40 season x week decisions at 97.5 % confidence: at most a stray one or two
        on = sum(len(w) for v in ("t2m", "precip") for w in report["vars"][v]["enabled"].values())
        self.assertLessEqual(on, 2)

    def test_district_table_rebuilt_when_model_changes(self):
        from . import gefs_calibration as gcal
        self._build()
        raster = np.zeros(gd._window_shape(), np.int16)
        _square_district(raster, int((70.0 - gc.REGION["west"]) / 0.5), int((gc.REGION["north"] - 30.0) / 0.5))
        gd.save_index(gd.build_weights(raster, 1), DistrictTests.META)
        raw = gd.district_stats("t2m")
        self.assertIsNone(raw["calibration"])
        inits, fc, ob = self._synthetic(n_d=1)
        model, report = gcal.train(fc, ob, inits, DistrictTests.META)
        gcal.save(model, report)
        cal = gd.district_stats("t2m")
        self.assertIsNotNone(cal["calibration"])
        self.assertIn("bias-corrected", cal["method"])
        self.assertLess(cal["districts"][0]["t2m"][5], raw["districts"][0]["t2m"][5] - 1.0)


class DampingTests(_Tmp):
    def test_damping_chosen_for_skill_less_forecast_and_applied(self):
        from datetime import date, timedelta
        from . import gefs_calibration as gcal
        rng = np.random.default_rng(3)
        n_case, n_d = 104, 3
        inits = [date(2025, 1, 1) + timedelta(days=7 * i) for i in range(n_case)]
        clim = np.tile(np.array([10, 12, 16, 21, 26, 29, 30, 29, 27, 22, 16, 11], np.float32), (n_d, 1))
        normal = np.stack([gcal.weekly_normals(clim, d, "t2m") for d in inits])       # [case, district, week]
        ob = normal + rng.normal(0, 1.0, normal.shape)
        fc = ob.copy()
        fc[:, :, 3:] = normal[:, :, 3:] + rng.normal(0, 3.0, fc[:, :, 3:].shape)    # weeks 4-5: no skill
        meta = [{"name": f"D{i}", "province": "P"} for i in range(n_d)]
        model, report = gcal.train({"t2m": fc, "precip": np.abs(fc)}, {"t2m": ob, "precip": np.abs(ob)}, inits, meta,
                                   clim_monthly={"t2m": clim})
        a = report["vars"]["t2m"]["damping"]["alpha_by_week"]
        self.assertEqual(a[:3], [0.0, 0.0, 0.0])                     # skilful weeks: untouched
        self.assertGreater(min(a[3:]), 0.0)                           # skill-less weeks: damped
        gcal.save(model, report)
        st = {k: np.full((n_d, 35), 40.0, np.float32) for k in ("t2m_mean", "t2m_min", "t2m_max", "precip_mean", "precip_max")}
        init = date(2026, 1, 10)
        prov = gcal.apply(st, init, meta)
        self.assertEqual(prov["damped_toward_normal"].get("t2m"), [i + 1 for i in range(5) if a[i] > 0])
        normal_d30 = gcal.daily_normal(clim, init + timedelta(days=29))[0]
        bias30 = float(model["t2m_table"][int(np.argmin(gcal._circ(model["bins"], init.timetuple().tm_yday)))][0, 4]) \
            if model["t2m_enabled"][gcal.season_of(init)][4] else 0.0
        expect = (1 - a[4]) * (40.0 - bias30) + a[4] * normal_d30
        self.assertAlmostEqual(float(st["t2m_mean"][0, 29]), expect, places=3)
        self.assertAlmostEqual(float(st["t2m_max"][0, 29] - st["t2m_mean"][0, 29]), 0.0, places=3)   # extremes move with mean

    def test_model_without_damping_still_loads(self):
        from datetime import date
        from . import gefs_calibration as gcal
        inits = [date(2025, 1, 1)] * 0
        meta = [{"name": "D0", "province": "P"}]
        path = os.path.join(gc._root(), gcal.MODEL_FILE)
        z = np.zeros((gcal.N_BINS, 1, 5), np.float32)
        np.savez_compressed(path, bins=gcal.bin_centres(), t2m_table=z, precip_table=z + 1,
                            t2m_enabled=np.zeros((4, 5), bool), precip_enabled=np.zeros((4, 5), bool),
                            meta=np.array(json.dumps({"districts_hash": gcal.districts_hash(meta), "trained_from": "x",
                                                      "trained_to": "y", "n_cases": 0})), report=np.array("{}"))
        st = {k: np.full((1, 35), 5.0, np.float32) for k in ("t2m_mean", "t2m_min", "t2m_max", "precip_mean", "precip_max")}
        prov = gcal.apply(st, date(2026, 1, 1), meta)
        self.assertEqual(prov["damped_toward_normal"], {})
        self.assertTrue(np.all(st["t2m_mean"] == 5.0))


class ConfidenceTests(SimpleTestCase):
    def test_levels_follow_skill_vs_normal(self):
        from . import gefs_calibration as gcal
        rng = np.random.default_rng(5)
        n_case, n_d = 80, 2
        seasons = np.array([i % 4 for i in range(n_case)])
        ob = rng.normal(20, 4, (n_case, n_d, 5))
        cl = np.full_like(ob, 20.0)                                        # normal = long-run mean
        fc = ob.copy()
        fc[:, :, 0] += rng.normal(0, 0.3, (n_case, n_d))                   # week 1: excellent
        fc[:, :, 2] = 0.5 * ob[:, :, 2] + 0.5 * cl[:, :, 2]                # week 3: half-way skilful
        fc[:, :, 4] = cl[:, :, 4] + rng.normal(0, 1.0, (n_case, n_d))      # week 5: no skill
        err, skill = gcal.confidence_tables(fc, ob, cl, seasons)
        lv = gcal.confidence_level(err, skill, "t2m")
        self.assertTrue(np.all(lv[:, :, 0] == 2))
        self.assertTrue(np.all(lv[:, :, 2] == 2))                          # skill ~0.5 >= CONF_HIGH
        self.assertTrue(np.all(lv[:, :, 4] == 0))
        self.assertTrue(np.all(err[:, :, 0] < 0.5))
        # tiny absolute error is High even without skill (e.g. dry-season rain)
        self.assertEqual(int(gcal.confidence_level(np.array([0.4]), np.array([-0.2]), "precip")[0]), 2)
        self.assertEqual(int(gcal.confidence_level(np.array([3.0]), np.array([0.2]), "precip")[0]), 1)
