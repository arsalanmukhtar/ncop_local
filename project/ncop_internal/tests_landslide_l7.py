# Unit tests for the §L7 landslide work (calibration, geology crosswalk,
# debris-flow screening, ground-truth precision filtering, pipeline
# coalescing, run-view validation). No database and no network: every
# external call is mocked, so these run with
#   python manage.py test ncop_internal.tests_landslide_l7
import json
import math
import os
import tempfile
import threading
import time
from unittest import mock

import numpy as np
from django.test import RequestFactory, SimpleTestCase, override_settings

from . import accuracy_assessment as aa
from . import debris_flow_model, flood_model, landslide_calibration as lc, landslide_model as lm


class GeologyCrosswalkTests(SimpleTestCase):
    def test_previously_unresolved_codes_now_have_group_values(self):
        for code in ("P", "Pz", "Tr", "MPv", "Mpv", "M"):
            self.assertIn(code, lm._GEOLOGY_CODE_HAZARD_CLASS, code)
            self.assertIn(code, lm._GEOLOGY_CODE_COHESION_KPA, code)
        self.assertEqual(lm._GEOLOGY_CODE_HAZARD_CLASS["MPv"], 2)  # crystalline
        self.assertEqual(lm._GEOLOGY_CODE_HAZARD_CLASS["Tr"], 3)   # Mesozoic sedimentary

    def test_explicit_entries_are_not_overwritten_by_groups(self):
        self.assertEqual(lm._GEOLOGY_CODE_HAZARD_CLASS["Tk"], 5)
        self.assertEqual(lm._GEOLOGY_CODE_HAZARD_CLASS["TM"], 5)
        self.assertEqual(lm._GEOLOGY_CODE_COHESION_KPA["Q"], 5.0)

    def test_only_quaternary_unconsolidated_is_non_rock(self):
        self.assertFalse(lm._GEOLOGY_CODE_IS_ROCK["Q"])
        self.assertFalse(lm._GEOLOGY_CODE_IS_ROCK["Qf"])
        self.assertTrue(lm._GEOLOGY_CODE_IS_ROCK["Qp"])
        self.assertTrue(lm._GEOLOGY_CODE_IS_ROCK["Pz"])

    def test_lookup_prefers_exact_case_then_falls_back(self):
        table = {"M": 3, "m": 2, "gg": 2}
        self.assertEqual(lm._lookup_code_value(table, "M", 9), 3)
        self.assertEqual(lm._lookup_code_value(table, "m", 9), 2)
        self.assertEqual(lm._lookup_code_value(table, "GG", 9), 2)
        self.assertEqual(lm._lookup_code_value(table, "As", 9), 9)

    def test_case_variants_resolve_through_real_tables(self):
        # "M" (Mesozoic, sedimentary) and "m" (igneous) must stay distinct.
        self.assertEqual(lm._lookup_code_value(lm._GEOLOGY_CODE_HAZARD_CLASS, "M", 0), 3)
        self.assertEqual(lm._lookup_code_value(lm._GEOLOGY_CODE_HAZARD_CLASS, "m", 0), 2)


class DebrisFlowClassificationTests(SimpleTestCase):
    def test_wilford_thresholds(self):
        c = debris_flow_model.classify_watershed
        self.assertEqual(c(0.8, 2.0), debris_flow_model.CLASS_DEBRIS_FLOW)
        self.assertEqual(c(0.8, 3.0), debris_flow_model.CLASS_DEBRIS_FLOOD)
        self.assertEqual(c(0.45, 1.0), debris_flow_model.CLASS_DEBRIS_FLOOD)
        self.assertEqual(c(0.3, 1.0), debris_flow_model.CLASS_DEBRIS_FLOOD)
        self.assertEqual(c(0.29, 1.0), debris_flow_model.CLASS_FLOOD)
        self.assertEqual(c(float("nan"), 1.0), debris_flow_model.CLASS_FLOOD)


class PointPrecisionTests(SimpleTestCase):
    def test_gfld_area_to_radius(self):
        r = aa._gfld_uncertainty_m({"Precision_": math.pi * 1000.0 ** 2})
        self.assertAlmostEqual(r, 1000.0, places=6)
        self.assertIsNone(aa._gfld_uncertainty_m({"Precision_": None}))
        self.assertIsNone(aa._gfld_uncertainty_m({"Precision_": 0}))

    def test_glc_accuracy_classes(self):
        self.assertEqual(aa._glc_uncertainty_m({"location_accuracy": "exact"}), 0.0)
        self.assertEqual(aa._glc_uncertainty_m({"location_accuracy": "1km"}), 1000.0)
        self.assertIsNone(aa._glc_uncertainty_m({"location_accuracy": "unknown"}))

    def test_keep_and_buffer(self):
        self.assertTrue(aa._keep_point(800.0, 1000.0))
        self.assertFalse(aa._keep_point(5000.0, 1000.0))
        self.assertFalse(aa._keep_point(None, 1000.0))
        self.assertTrue(aa._keep_point(None, None))
        # Buffer is the larger of the floor and the point's own uncertainty.
        self.assertAlmostEqual(aa._point_buffer_deg(800.0, 250.0, 1000.0) * aa._DEG_TO_M_APPROX, 800.0)
        self.assertAlmostEqual(aa._point_buffer_deg(0.0, 250.0, 1000.0) * aa._DEG_TO_M_APPROX, 250.0)
        self.assertAlmostEqual(aa._point_buffer_deg(9000.0, 250.0, None) * aa._DEG_TO_M_APPROX, 250.0)

    def test_gfld_fetch_filters_imprecise_points(self):
        events = [
            {"attributes": {"Precision_": 1e6}, "lon": 73.4, "lat": 34.0},     # r ~564m: kept
            {"attributes": {"Precision_": 1.4e10}, "lon": 73.4, "lat": 34.0},  # district: dropped
        ]
        with mock.patch.object(aa, "list_gfld_events", return_value=events):
            geoms = aa.fetch_gfld_presence_geoms([73, 33.5, 74, 34.5])
            self.assertEqual(len(geoms), 1)
            unfiltered = aa.fetch_gfld_presence_geoms([73, 33.5, 74, 34.5], max_location_uncertainty_m=None)
            self.assertEqual(len(unfiltered), 2)


class NcopInventoryCacheTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        aa._ncop_landslide_last_failure.clear()
        aa._ncop_landslide_memory_cache.clear()

    def _feature(self, lon, lat):
        return {"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [lon, lat]}}

    def test_fetch_once_then_filter_locally_and_serve_stale_when_down(self):
        feats = [self._feature(73.5, 34.4), self._feature(74.7, 36.3)]
        with override_settings(MEDIA_ROOT=self.tmp.name):
            with mock.patch.object(aa, "_ncop_landslide_fetch_national", return_value=feats) as fetch:
                got = aa._ncop_landslide_wfs_get_geojson("Landslide_inventory_overall", [73.35, 34.25, 73.65, 34.55], 10)
                self.assertEqual(len(got), 1)
                aa._ncop_landslide_wfs_get_geojson("Landslide_inventory_overall", [74.5, 36.1, 74.9, 36.5], 10)
                self.assertEqual(fetch.call_count, 1)  # second bbox served from the national cache
            # Age the cache past its TTL and make the server fail: stale copy served, one attempt only.
            path = aa._ncop_landslide_cache_path("Landslide_inventory_overall")
            old = time.time() - aa._NCOP_LANDSLIDE_CACHE_TTL_SECONDS - 10
            os.utime(path, (old, old))
            with mock.patch.object(aa, "_ncop_landslide_fetch_national", return_value=None) as fetch:
                got = aa._ncop_landslide_wfs_get_geojson("Landslide_inventory_overall", [73.35, 34.25, 73.65, 34.55], 10)
                got2 = aa._ncop_landslide_wfs_get_geojson("Landslide_inventory_overall", [73.35, 34.25, 73.65, 34.55], 10)
                self.assertEqual(len(got), 1)
                self.assertEqual(len(got2), 1)
                self.assertEqual(fetch.call_count, 1)  # backoff: no retry within the window

    def test_no_cache_and_server_down_degrades_to_empty(self):
        with override_settings(MEDIA_ROOT=self.tmp.name):
            with mock.patch.object(aa, "_ncop_landslide_fetch_national", return_value=None):
                self.assertEqual(aa._ncop_landslide_wfs_get_geojson("2025_Landslide_Events", [73, 34, 74, 35], 10), [])


class CalibrationMathTests(SimpleTestCase):
    def test_digitize_and_aspect_sectors(self):
        cls = lc._digitize(np.array([5.0, 10.0, 25.0, 55.0]), lc.FACTOR_BIN_EDGES["slope"])
        self.assertEqual(cls.tolist(), [0, 1, 2, 5])
        sectors = lc._aspect_sector(np.array([0.0, 359.0, 44.0, 180.0, 300.0]))
        self.assertEqual(sectors.tolist(), [0, 0, 1, 4, 7])

    def test_categorical_index_unknown_goes_to_neutral(self):
        idx = lc._categorical_index(np.array([1.0, 5.0, 9.0]), "lulc")
        self.assertEqual(idx.tolist(), [0, 4, 2])  # 9 -> class "3" position
        idx = lc._categorical_index(np.array([0.0, 6.0, 42.0]), "lithology_group")
        self.assertEqual(idx.tolist(), [0, 6, 0])

    def test_design_matrix_one_hot_and_missing_factor(self):
        classes = {"slope": np.array([0, 5, -1], dtype=np.int16)}
        X, cols = lc.design_matrix(classes, ["slope"])
        self.assertEqual(X.shape, (3, 6))
        self.assertEqual(X[0].tolist(), [1, 0, 0, 0, 0, 0])
        self.assertEqual(X[1].tolist(), [0, 0, 0, 0, 0, 1])
        self.assertEqual(X[2].sum(), 0)  # unavailable factor contributes nothing
        self.assertEqual(cols[0], ("slope", 0))

    def test_logistic_fit_recovers_signal(self):
        rng = np.random.default_rng(0)
        n = 4000
        cls = rng.integers(0, 6, n).astype(np.int16)
        p = 1 / (1 + np.exp(-(-2.0 + 0.8 * cls)))  # higher class -> more presence
        y = (rng.random(n) < p).astype(float)
        X, _ = lc.design_matrix({"slope": cls}, ["slope"])
        b0, coef = lc.fit_logistic(X, y, np.ones(n), l2=0.1)
        self.assertTrue(np.all(np.diff(coef) > 0), coef)
        auc = lc._auc(lc.predict_logit(b0, coef, X), y)
        self.assertGreater(auc, 0.75)

    def test_training_weights_balance_classes_per_catchment(self):
        y = np.array([1, 0, 0, 0, 1, 1, 0], dtype=float)
        idx = np.array([0, 0, 0, 0, 1, 1, 1])
        w = lc._training_weights(y, idx, {0: 4, 1: 100})
        self.assertAlmostEqual(w[(idx == 0) & (y == 1)].sum(), w[(idx == 0) & (y == 0)].sum())
        share0 = w[idx == 0].sum()
        share1 = w[idx == 1].sum()
        self.assertAlmostEqual(share1 / share0, math.sqrt(100) / math.sqrt(4))

    def test_infinite_slope_fs_matches_default_formula(self):
        slope = np.array([10.0, 35.0, 60.0])
        twi = np.array([0.0, 0.5, 1.0])
        c, phi, g = np.full(3, 15.0), np.full(3, 28.0), np.full(3, 19.5)
        fs = lc.infinite_slope_fs(slope, twi, c, phi, g, lc.FS_DEFAULT_PARAMS)
        th, ph, z = np.radians(slope), np.radians(phi), 1.5
        expected = (c + (g - twi * 9.81) * z * np.cos(th) ** 2 * np.tan(ph)) / (g * z * np.sin(th) * np.cos(th))
        np.testing.assert_allclose(fs, np.clip(expected, 0, 10))
        self.assertTrue(fs[2] < fs[1] < fs[0])  # steeper -> less stable

    def test_rank_normalize(self):
        r = lc._rank_normalize(np.array([5.0, 1.0, 3.0]))
        self.assertEqual(r.tolist(), [1.0, 0.0, 0.5])

    def test_spatial_blocks_quadrants(self):
        rc = np.array([[0, 0], [0, 99], [99, 0], [99, 99]])
        self.assertEqual(lc._spatial_blocks(rc, (100, 100)).tolist(), [0, 1, 2, 3])


def _synthetic_table(n_catchments=4, n_per=600, seed=1, events=40):
    """A training table shaped like build_training_table's output where
    slope class genuinely drives presence and the 'AHP' score is noise."""
    rng = np.random.default_rng(seed)
    factors = sorted({f for fs in lc.FEATURE_SETS.values() for f in fs})
    parts, meta, offset = [], {}, 0
    for i in range(n_catchments):
        slope_cls = rng.integers(0, 6, n_per).astype(np.int16)
        p = 1 / (1 + np.exp(-(-3.0 + 1.0 * slope_cls)))
        y = (rng.random(n_per) < p).astype(float)
        classes = {f: rng.integers(0, lc.factor_class_count(f), n_per).astype(np.int16) for f in factors}
        classes["slope"] = slope_cls
        fs_inputs = {"slope_deg": rng.uniform(5, 60, n_per), "twi_norm": rng.random(n_per),
                     "cohesion": np.full(n_per, 15.0), "friction": np.full(n_per, 28.0), "gamma": np.full(n_per, 19.5)}
        parts.append({"classes": classes, "y": y, "idx": np.full(n_per, i), "ahp": rng.random(n_per),
                      "rc": np.column_stack([rng.integers(0, 100, n_per), rng.integers(0, 100, n_per)]), "fs": fs_inputs})
        meta[f"c{i}"] = {"idx": i, "bbox": [0, 0, 1, 1], "rows": slice(offset, offset + n_per), "n_events": events,
                         "n_events_by_source": {"ncop_inventory": events}, "n_presence_px": int(y.sum()),
                         "n_absence_px": int((1 - y).sum()), "shape": (100, 100)}
        offset += n_per
    return {
        "catchments": meta, "factors": factors,
        "classes": {f: np.concatenate([p["classes"][f] for p in parts]) for f in factors},
        "y": np.concatenate([p["y"] for p in parts]),
        "catchment_idx": np.concatenate([p["idx"] for p in parts]),
        "row_col": np.concatenate([p["rc"] for p in parts]),
        "ahp": np.concatenate([p["ahp"] for p in parts]),
        "fs_inputs": {k: np.concatenate([p["fs"][k] for p in parts]) for k in parts[0]["fs"]},
        "skipped": [],
    }


class CalibrationPipelineTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        lc._invalidate_model_cache()
        self.addCleanup(lc._invalidate_model_cache)

    def test_loco_beats_noise_baseline_and_reports_every_fold(self):
        table = _synthetic_table()
        ev = lc.evaluate_loco(table)
        self.assertEqual(len(ev["per_fold"]), 4)
        self.assertGreater(ev["pooled"]["calibrated_ahp_factors"]["auc"], 0.75)
        self.assertLess(abs(ev["pooled"]["ahp"]["auc"] - 0.5), 0.08)
        self.assertIn("c0", ev["spatial_cv"])  # 40 events >= _SPATIAL_CV_MIN_EVENTS

    def test_calibrate_approves_only_with_enough_evidence(self):
        with override_settings(MEDIA_ROOT=self.tmp.name):
            with mock.patch.object(lc, "build_training_table", return_value=_synthetic_table(events=40)):
                model = lc.calibrate(save=True)
            self.assertTrue(model["approval"]["susceptibility"]["approved"], model["approval"])
            self.assertIsNotNone(lc.approved_susceptibility_model())
            self.assertEqual(lc.load_model()["model_id"], model["model_id"])

            with mock.patch.object(lc, "build_training_table", return_value=_synthetic_table(events=5)):
                model = lc.calibrate(save=True)
            approval = model["approval"]["susceptibility"]
            self.assertFalse(approval["approved"])
            self.assertTrue(any("insufficient ground truth" in r for r in approval["not_approved_reasons"]))
            self.assertIsNone(lc.approved_susceptibility_model())

    def test_resolve_method(self):
        with override_settings(MEDIA_ROOT=self.tmp.name):
            self.assertEqual(lm.resolve_susceptibility_method("auto"), ("ahp", None))
            self.assertEqual(lm.resolve_susceptibility_method("ahp"), ("ahp", None))
            with self.assertRaises(ValueError):
                lm.resolve_susceptibility_method("calibrated")
            with self.assertRaises(ValueError):
                lm.resolve_susceptibility_method("bogus")
            with mock.patch.object(lc, "build_training_table", return_value=_synthetic_table(events=40)):
                model = lc.calibrate(save=True)
            resolved, m = lm.resolve_susceptibility_method(None, "c0")
            self.assertEqual(resolved, "calibrated")
            self.assertEqual(lm._score_tag(True, None, "c0"), f"cal_{model['model_id']}")
            self.assertEqual(lm._score_tag(True, "ahp"), "lite")


class LocalApprovalTests(SimpleTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        lc._invalidate_model_cache()
        self.addCleanup(lc._invalidate_model_cache)

    def _cv(self, n_events, cal, ahp, block_wins):
        name = f"calibrated_{lc.LOCAL_FEATURE_SET}"
        blocks = [{"block": i, "n_presence": 50, "auc": {"ahp": 0.6, name: 0.7 if i < block_wins else 0.5}} for i in range(4)]
        return {"n_events": n_events, "n_blocks_used": 4, "blocks": blocks,
                "methods": {"ahp": {"auc": ahp}, name: {"auc": cal}}}

    def test_rules(self):
        table = _synthetic_table(n_catchments=2)
        spatial = {
            "good": self._cv(700, 0.76, 0.67, 3),
            "thin": self._cv(20, 0.90, 0.60, 4),        # too few events
            "small_gain": self._cv(80, 0.68, 0.67, 3),  # gain < 0.02
            "split": self._cv(80, 0.80, 0.60, 2),       # wins only 2/4 quadrants
        }
        local = lc._calibrate_local(table, spatial)
        self.assertEqual(list(local["approved_catchments"]), ["good"])
        self.assertFalse(local["evidence"]["thin"]["approved"])
        self.assertFalse(local["evidence"]["small_gain"]["approved"])
        self.assertFalse(local["evidence"]["split"]["approved"])
        self.assertNotIn("rainfall", local["factors"])
        self.assertEqual(local["factors"], lc.FEATURE_SETS[lc.LOCAL_FEATURE_SET])
        for fs in lc.LOCAL_CANDIDATE_SETS:
            self.assertNotIn("rainfall", lc.FEATURE_SETS[fs])
            self.assertNotIn("pga", lc.FEATURE_SETS[fs])

    def test_scoring_model_selection(self):
        model = {"model_id": "abc", "feature_set": "ahp_factors", "factors": ["slope"], "intercept": 0.0,
                 "coef": [0.0] * 6, "columns": [["slope", i] for i in range(6)], "factor_importance": {},
                 "approval": {"susceptibility": {"approved": False}},
                 "local": {"feature_set": "local_terrain", "factors": ["slope"], "intercept": 0.0, "coef": [0.0] * 6,
                           "columns": [["slope", i] for i in range(6)], "factor_importance": {},
                           "approved_catchments": {"ajk": {"spatial_cv_auc": 0.75, "ahp_spatial_cv_auc": 0.67}},
                           "evidence": {"ajk": {}, "hunza": {}}}}
        with mock.patch.object(lc, "load_model", return_value=model):
            self.assertEqual(lc.scoring_model_for("ajk")["scope"], "local")
            self.assertEqual(lc.scoring_model_for("ajk")["model_id"], "abcL")
            self.assertIsNone(lc.scoring_model_for("murree"))
            self.assertEqual(lc.scoring_model_for("hunza", require_approved=False)["scope"], "local")
            self.assertEqual(lc.scoring_model_for("murree", require_approved=False)["scope"], "global")
            self.assertEqual(lm.resolve_susceptibility_method("auto", "murree"), ("ahp", None))
            self.assertEqual(lm.resolve_susceptibility_method("auto", "ajk")[0], "calibrated")
            self.assertEqual(lm._score_tag(True, None, "ajk"), "cal_abcL")
            self.assertEqual(lm._score_tag(True, None, "murree"), "lite")
            model["approval"]["susceptibility"]["approved"] = True
            self.assertEqual(lc.scoring_model_for("murree")["scope"], "global")


class HandPipelineCoalescingTests(SimpleTestCase):
    def test_concurrent_callers_share_one_build(self):
        calls = []
        started = threading.Event()

        def fake_impl(key, force=False):
            calls.append(force)
            started.set()
            time.sleep(0.2)
            return {"paths": {}, "stats": {}}

        with mock.patch.object(flood_model, "_build_hand_pipeline_impl", side_effect=fake_impl):
            t1 = threading.Thread(target=flood_model.build_hand_pipeline, args=("k_coalesce",), kwargs={"force": True})
            t1.start()
            started.wait(2)
            flood_model.build_hand_pipeline("k_coalesce", force=True)
            t1.join()
        self.assertEqual(calls, [True, False])  # the waiter re-entered without force


class RunViewValidationTests(SimpleTestCase):
    def _post(self, body):
        from .landslide_model_views import LandslideModelRunView
        req = RequestFactory().post("/api/landslide-model/run/", data=json.dumps(body), content_type="application/json")
        return LandslideModelRunView.as_view()(req)

    def test_bad_method_rejected(self):
        res = self._post({"mode": "susceptibility", "catchment": "murree_galyat", "method": "magic"})
        self.assertEqual(res.status_code, 400)
        self.assertIn("method", json.loads(res.content)["error"])

    def test_calibrated_without_model_rejected(self):
        with mock.patch.object(lc, "load_model", return_value=None):
            res = self._post({"mode": "susceptibility", "catchment": "murree_galyat", "method": "calibrated"})
        self.assertEqual(res.status_code, 400)

    def test_calibrate_mode_accepted_without_catchment(self):
        from . import landslide_model_views as views
        with mock.patch.object(views._LANDSLIDE_JOB_EXECUTOR, "submit") as submit, \
                mock.patch.object(views.LandslideModelRunView, "check_throttles"):
            res = self._post({"mode": "calibrate"})
        self.assertEqual(res.status_code, 202)
        self.assertIs(submit.call_args[0][0], views._run_landslide_calibration_job)
