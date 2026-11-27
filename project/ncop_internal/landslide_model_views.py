# project/ncop_internal/landslide_model_views.py
# ---------------------------------------------------------------------------
# L5's first real HTTP endpoints for the landslide early-warning system —
# see LANDSLIDE_EARLY_WARNING_METHODOLOGY.md §9/§12/§13-L5 for the full
# design. Mirrors flood_model_views.py's own async job-id polling pattern
# EXACTLY (same shape, same CSRF handling, same throttle-after-validation
# fix) — deliberately NOT a shared job registry/executor with flood's own
# (§9/§12's explicit decision, named there, not silently copied): a
# landslide job and a flood job are unrelated failure/load domains, and
# sharing an executor would let one hazard's queue depth block the
# other's.
#
# POST /api/landslide-model/run/            -> {"job_id", "status": "pending"}, 202
# GET  /api/landslide-model/status/<job_id>/ -> {"status", ...}
#
# `mode` in the run body picks what kind of job runs:
#   "susceptibility" (default) — L1's full static pipeline (AHP score +
#       zones + infinite-slope layer + rockfall flag + avalanche layer)
#       plus L2's exposure report, optionally L3's COOLR validation.
#   "calibrate" — §L7: trains/re-tests the data-driven susceptibility
#       model (landslide_calibration.calibrate) and saves it; the model
#       is only used by "auto" susceptibility runs once it passes its own
#       held-out approval rule.
#   "trigger" — L4's rainfall-triggered dynamic check (a real external
#       rainfall fetch, so it goes through the SAME async job pattern,
#       never the request thread — landslide_trigger.py's own module
#       docstring already states this as a hard requirement).
#
# Every function this file calls is already independently bounded
# (flood_model._run_wbt's own timeout, flood_exposure._overpass_query's
# own retry/timeout, accuracy_assessment's own COOLR/WFS timeouts,
# flood_forecast's own CHIRPS/PMD/NWFC timeouts) — this file adds no new
# unbounded external call, only the async-job wrapper around calls that
# were already real, tested, bounded library functions through L0-L4.
# ---------------------------------------------------------------------------

import json
import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from django.core.exceptions import RequestDataTooBig
from django.http import HttpResponse, JsonResponse
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import (
    avalanche_model, debris_flow_model, landslide_calibration, landslide_lhasa2_scan, landslide_model,
    landslide_report_export, landslide_trigger,
)

logger = logging.getLogger(__name__)

# Own executor, own registry, own lock — never flood_model_views.py's
# own _JOB_EXECUTOR/_JOBS/_JOB_LOCK. max_workers=1 for the same reason
# flood's own job executor uses it: every landslide job already
# serializes internally on flood_model._gdal_lock()/_WBT_LOCK, so a
# second job-level worker would only add thread overhead, not real
# parallelism.
_LANDSLIDE_JOB_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="landslide-model-job")
_LANDSLIDE_JOB_LOCK = threading.Lock()
_LANDSLIDE_JOBS = {}  # job_id (str) -> dict

_LANDSLIDE_JOB_TTL_SECONDS = 3600
_LANDSLIDE_MAX_TRACKED_JOBS = 200

_VALID_MODES = ("susceptibility", "trigger", "national_validation", "lhasa2_exposure_scan", "calibrate")
_VALID_METHODS = ("auto", "ahp", "calibrated")


def _purge_old_landslide_jobs():
    """Same bounded-memory discipline as flood_model_views._purge_old_
    jobs — a hard count cap alongside the age-based purge, called on
    every new job submission, no separate background thread."""
    now = time.time()
    with _LANDSLIDE_JOB_LOCK:
        expired = [jid for jid, j in _LANDSLIDE_JOBS.items() if now - j["created_at"] > _LANDSLIDE_JOB_TTL_SECONDS]
        for jid in expired:
            del _LANDSLIDE_JOBS[jid]
        if len(_LANDSLIDE_JOBS) > _LANDSLIDE_MAX_TRACKED_JOBS:
            by_age = sorted(_LANDSLIDE_JOBS.items(), key=lambda kv: kv[1]["created_at"])
            for jid, _ in by_age[: len(_LANDSLIDE_JOBS) - _LANDSLIDE_MAX_TRACKED_JOBS]:
                del _LANDSLIDE_JOBS[jid]


def _mark_stage(job_id, stage_name):
    """Same "current stage + completed-so-far list" convention as
    flood_model_views._mark_stage — lets a frontend checklist render
    without a separate boolean per stage."""
    with _LANDSLIDE_JOB_LOCK:
        if job_id not in _LANDSLIDE_JOBS:
            return
        _LANDSLIDE_JOBS[job_id]["current_stage"] = stage_name
        _LANDSLIDE_JOBS[job_id]["completed_stages"].append(stage_name)


def _run_landslide_susceptibility_job(job_id, catchment_key, lite, include_validation, method="auto"):
    """Runs entirely inside _LANDSLIDE_JOB_EXECUTOR's worker thread.
    Calls landslide_model.py/avalanche_model.py exactly as they already
    exist and were live-tested through L0-L4/pre-L5 — this is a thin
    orchestration wrapper only, matching _run_flood_model_job's own
    role for flood.

    include_validation=True additionally runs L3's COOLR-based AUC
    check — off by default (not because it's slow: it degrades in
    ~1s when COOLR is unreachable, see accuracy_assessment.py's own
    live-confirmed 404 finding, §13/L3) but because it is meaningfully
    LESS useful than the other stages while that external dependency
    stays down, so a normal run does not pay even that small fixed
    cost by default."""
    with _LANDSLIDE_JOB_LOCK:
        if job_id not in _LANDSLIDE_JOBS:
            return
        _LANDSLIDE_JOBS[job_id]["status"] = "running"
        _LANDSLIDE_JOBS[job_id]["started_at"] = time.time()
    try:
        _mark_stage(job_id, "Fetching elevation & computing terrain hydrology (HAND)")
        _mark_stage(job_id, "Computing static susceptibility score")
        susceptibility = landslide_model.build_landslide_susceptibility_raster(catchment_key, lite=lite, method=method)

        _mark_stage(job_id, "Classifying & vectorizing susceptibility zones")
        zones = landslide_model.build_landslide_zone_geometries(catchment_key, lite=lite, method=method)

        _mark_stage(job_id, "Computing infinite-slope physical stability layer")
        infinite_slope = landslide_model.build_infinite_slope_layer(catchment_key)

        _mark_stage(job_id, "Screening rockfall susceptibility")
        rockfall = landslide_model.build_rockfall_susceptibility_flag(catchment_key)

        _mark_stage(job_id, "Screening snow-avalanche susceptibility")
        avalanche = avalanche_model.build_avalanche_susceptibility_raster(catchment_key)

        _mark_stage(job_id, "Screening debris-flow watersheds (Melton ratio)")
        try:
            debris_flow = debris_flow_model.build_debris_flow_screening(catchment_key)
        except Exception:
            # A screening layer failing must not sink the whole run (the
            # slide score, zones and exposure are still valid without it).
            logger.exception("landslide_model_views: debris-flow screening failed for %r (degraded)", catchment_key)
            debris_flow = None

        _mark_stage(job_id, "Computing exposure (buildings/roads/population)")
        exposure = landslide_model.build_landslide_exposure_report(
            catchment_key, lite=lite,
            progress_callback=lambda stage: _mark_stage(job_id, stage),
            method=method,
        )

        validation = None
        if include_validation:
            _mark_stage(job_id, "Validating against COOLR ground truth")
            validation = landslide_model.validate_landslide_susceptibility(catchment_key, lite=lite)

        result = {
            "susceptibility": {
                "terrain_class": susceptibility["terrain_class"],
                "terrain_stats": susceptibility["terrain_stats"],
                "weights": susceptibility["weights"],
                "method": susceptibility.get("method", "ahp"),
                "model_id": susceptibility.get("model_id"),
                "model_summary": susceptibility.get("model_summary"),
                "zones": zones["geojson"],
            },
            "infinite_slope": {
                "soil_depth_m": infinite_slope["soil_depth_m"],
                "fs_params": infinite_slope.get("fs_params"),
                "params_used": infinite_slope["params_used"],
            },
            "rockfall": {
                "susceptible_km2": rockfall["susceptible_km2"],
                "susceptible_fraction": rockfall["susceptible_fraction"],
            },
            "avalanche": {
                "gate_applied_fraction": avalanche["gate_applied_fraction"],
            },
            "debris_flow": None if debris_flow is None else {
                "summary": debris_flow["summary"],
                "top_watersheds": debris_flow["watersheds"][:20],
                "geojson": debris_flow["geojson"],
                "method": debris_flow["method"],
            },
            "exposure": exposure,
            "validation": validation,
        }
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "done"
                _LANDSLIDE_JOBS[job_id]["result"] = result
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()
    except Exception as exc:
        logger.exception("landslide_model_views: susceptibility job %s failed", job_id)
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "error"
                _LANDSLIDE_JOBS[job_id]["error"] = str(exc)
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()


def _run_landslide_national_validation_job(job_id, lite):
    """L3's real, thorough, multi-source accuracy assessment — TWO real
    figures, reported together, never just the flattering one:
    1. `simple_pooled` — landslide_model.validate_landslide_
       susceptibility_national: the literature-AHP score's own AUC
       against pooled COOLR+GFLD+GLC ground truth, no local fitting at
       all.
    2. `loco_calibrated` — landslide_model.calibrate_landslide_
       frequency_ratio_loco: a REAL, held-out (leave-one-catchment-out)
       Frequency-Ratio calibration — see that function's own module-
       level comment for why LOCO, not flood's own in-sample FR-
       ensemble precedent, given how thin this project's own ground
       truth still is. This is the number local calibration can
       actually move; (1) cannot (AUC is threshold-invariant to the
       zone-classification step alone, only the underlying score's own
       ranking power — see that same comment).

    Real, substantial cold-cache cost — builds the full susceptibility
    pipeline for every catchment not already cached — so this runs
    through the SAME async job pattern as every other expensive
    landslide operation, never the request thread."""
    with _LANDSLIDE_JOB_LOCK:
        if job_id not in _LANDSLIDE_JOBS:
            return
        _LANDSLIDE_JOBS[job_id]["status"] = "running"
        _LANDSLIDE_JOBS[job_id]["started_at"] = time.time()
    try:
        _mark_stage(job_id, "Fetching ground truth (COOLR/GFLD/GLC) for every registered catchment")
        _mark_stage(job_id, "Building susceptibility + infinite-slope rasters for every catchment")
        simple_pooled = landslide_model.validate_landslide_susceptibility_national(lite=lite)
        _mark_stage(job_id, "Fitting & held-out testing Frequency-Ratio calibration (leave-one-catchment-out)")
        loco_calibrated = landslide_model.calibrate_landslide_frequency_ratio_loco(lite=lite)
        result = {"simple_pooled": simple_pooled, "loco_calibrated": loco_calibrated}
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "done"
                _LANDSLIDE_JOBS[job_id]["result"] = result
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()
    except Exception as exc:
        logger.exception("landslide_model_views: national validation job %s failed", job_id)
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "error"
                _LANDSLIDE_JOBS[job_id]["error"] = str(exc)
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()


def _run_landslide_calibration_job(job_id, lite):
    """§L7 — trains and held-out-tests the calibrated susceptibility
    model (landslide_calibration.calibrate, saved to disk). Minutes on a
    cold cache (every catchment's factor stack), so job-only, never the
    request thread."""
    with _LANDSLIDE_JOB_LOCK:
        if job_id not in _LANDSLIDE_JOBS:
            return
        _LANDSLIDE_JOBS[job_id]["status"] = "running"
        _LANDSLIDE_JOBS[job_id]["started_at"] = time.time()
    try:
        _mark_stage(job_id, "Fetching ground truth and sampling every catchment's factor stack")
        _mark_stage(job_id, "Leave-one-catchment-out testing of calibrated vs literature AHP")
        model = landslide_calibration.calibrate(lite=lite, save=True)
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                if "error" in model:
                    _LANDSLIDE_JOBS[job_id]["status"] = "error"
                    _LANDSLIDE_JOBS[job_id]["error"] = model["error"]
                else:
                    _LANDSLIDE_JOBS[job_id]["status"] = "done"
                    _LANDSLIDE_JOBS[job_id]["result"] = model
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()
    except Exception as exc:
        logger.exception("landslide_model_views: calibration job %s failed", job_id)
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "error"
                _LANDSLIDE_JOBS[job_id]["error"] = str(exc)
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()


def _run_landslide_lhasa2_scan_job(job_id, threshold_pct, max_exposure_blobs):
    """A 4th, independent job type — see landslide_lhasa2_scan.py's own
    module docstring for the full design. Needs no catchment (same shape
    as national_validation's own early branch): it scans Pakistan's whole
    bbox and extracts its own small, capped set of AOIs internally, one
    per elevated-probability blob."""
    with _LANDSLIDE_JOB_LOCK:
        if job_id not in _LANDSLIDE_JOBS:
            return
        _LANDSLIDE_JOBS[job_id]["status"] = "running"
        _LANDSLIDE_JOBS[job_id]["started_at"] = time.time()
    try:
        result = landslide_lhasa2_scan.extract_and_assess_lhasa2_features(
            threshold_pct=threshold_pct, max_exposure_blobs=max_exposure_blobs,
            progress_callback=lambda stage: _mark_stage(job_id, stage),
        )
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "done"
                _LANDSLIDE_JOBS[job_id]["result"] = result
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()
    except Exception as exc:
        logger.exception("landslide_model_views: lhasa2 scan job %s failed", job_id)
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "error"
                _LANDSLIDE_JOBS[job_id]["error"] = str(exc)
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()


def _run_landslide_trigger_job(job_id, catchment_key, source, lite, chirps_days, pmd_element):
    """L4's own job runner — the real external rainfall fetch
    (landslide_trigger.run_landslide_trigger -> flood_forecast.
    resolve_rainfall_scenario) happens HERE, inside this worker thread,
    never on the request thread that submitted the job — the exact same
    fix flood_model_views._run_flood_model_job's own rainfall_fetch_spec
    branch already applies for flood, extended to landslide's own
    trigger. A genuine ValueError (no data from this source right now —
    a real, expected outcome, not a bug, see run_landslide_trigger's own
    docstring) is caught below and surfaces as a clean job "error"
    status, not a request-thread failure."""
    with _LANDSLIDE_JOB_LOCK:
        if job_id not in _LANDSLIDE_JOBS:
            return
        _LANDSLIDE_JOBS[job_id]["status"] = "running"
        _LANDSLIDE_JOBS[job_id]["started_at"] = time.time()
    try:
        _mark_stage(job_id, f"Fetching {source} rainfall data")
        result = landslide_trigger.run_landslide_trigger(
            catchment_key, source, lite=lite, chirps_days=chirps_days, pmd_element=pmd_element,
        )
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "done"
                _LANDSLIDE_JOBS[job_id]["result"] = result
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()
    except Exception as exc:
        logger.exception("landslide_model_views: trigger job %s failed", job_id)
        with _LANDSLIDE_JOB_LOCK:
            if job_id in _LANDSLIDE_JOBS:
                _LANDSLIDE_JOBS[job_id]["status"] = "error"
                _LANDSLIDE_JOBS[job_id]["error"] = str(exc)
                _LANDSLIDE_JOBS[job_id]["finished_at"] = time.time()


class LandslideModelRunThrottle(AnonRateThrottle):
    scope = "landslide_model_run"


class LandslideModelStatusThrottle(AnonRateThrottle):
    scope = "landslide_model_status"


class LandslideModelExportThrottle(AnonRateThrottle):
    scope = "landslide_model_export"


class LandslideModelReportExportThrottle(AnonRateThrottle):
    scope = "landslide_model_report_export"


@method_decorator(csrf_exempt, name="dispatch")
class LandslideModelRunView(APIView):
    # Same CSRF note as FloodModelRunView's own docstring: csrf_exempt
    # alone does not stop DRF's SessionAuthentication from separately
    # enforcing CSRF for a logged-in NCOP user — both authentication_
    # classes and permission_classes must be emptied too.
    authentication_classes = []
    permission_classes = []
    throttle_classes = [LandslideModelRunThrottle]

    def initial(self, request, *args, **kwargs):
        # Same fix as FloodModelRunView's own initial() override: defer
        # the throttle check until AFTER request-body validation passes
        # (see post()'s own explicit self.check_throttles() call below)
        # so a malformed request doesn't burn the same tight budget a
        # real job submission does.
        self.perform_authentication(request)
        self.check_permissions(request)

    def post(self, request):
        try:
            body = json.loads(request.body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "Malformed JSON body."}, status=400)

        mode = body.get("mode", "susceptibility")
        if mode not in _VALID_MODES:
            return JsonResponse({"error": f"'mode' must be one of {_VALID_MODES}"}, status=400)
        lite = bool(body.get("lite", True))

        # national_validation needs no catchment at all — it pools EVERY
        # registered catchment's own ground truth (landslide_model.
        # validate_landslide_susceptibility_national's own docstring).
        # Handled first, before any catchment parsing, so a request for
        # this mode never has to send a (meaningless, for this mode)
        # 'catchment' field.
        if mode in ("national_validation", "lhasa2_exposure_scan", "calibrate"):
            # Neither mode needs a catchment: national_validation pools
            # every registered catchment's own ground truth; lhasa2_
            # exposure_scan scans Pakistan's whole bbox and extracts its
            # own small, capped set of AOIs internally (see
            # landslide_lhasa2_scan.py's own module docstring).
            catchment_key = None
        else:
            catchment_key = body.get("catchment")
            # Custom-AOI support — mirrors FloodModelRunView.post()'s own
            # exact request shape (catchment: "custom" + bbox + optional
            # polygon), reusing landslide_model.register_custom_landslide_aoi
            # (itself a thin wrapper over flood_model.register_custom_aoi —
            # see that function's own docstring). A drawn polygon comes from
            # the frontend's own MapboxDraw tool; an uploaded shapefile/KML
            # is converted to the SAME GeoJSON polygon shape client-side via
            # the already-existing, hazard-agnostic /upload-shapefile/ or
            # /upload-kmz/ endpoints (views.py) before ever reaching here —
            # this view does not need to know which path produced it.
            if catchment_key == "custom":
                bbox_raw = body.get("bbox")
                if not (isinstance(bbox_raw, list) and len(bbox_raw) == 4):
                    return JsonResponse(
                        {"error": "'bbox' must be [minLon, minLat, maxLon, maxLat] for a custom area."},
                        status=400,
                    )
                try:
                    bbox = [float(v) for v in bbox_raw]
                except (TypeError, ValueError):
                    return JsonResponse({"error": "'bbox' values must all be numbers."}, status=400)
                polygon_raw = body.get("polygon")
                polygon_geojson = None
                if isinstance(polygon_raw, dict) and polygon_raw.get("type") in ("Polygon", "MultiPolygon"):
                    polygon_geojson = polygon_raw
                elif polygon_raw is not None:
                    logger.warning(
                        "landslide_model_views: ignoring malformed 'polygon' in custom-AOI request "
                        "(expected a GeoJSON Polygon/MultiPolygon geometry) - falling back to bbox-only",
                    )
                try:
                    catchment_key = landslide_model.register_custom_landslide_aoi(bbox, polygon_geojson=polygon_geojson)
                except ValueError as e:
                    return JsonResponse({"error": str(e)}, status=400)
            elif not catchment_key or catchment_key not in landslide_model.PILOT_CATCHMENTS:
                return JsonResponse(
                    {"error": f"Unknown or missing 'catchment' — known: {list(landslide_model.PILOT_CATCHMENTS)} "
                               "(or 'custom' with a 'bbox')"},
                    status=400,
                )

        if mode == "trigger":
            source = body.get("source")
            if source not in ("chirps", "pmd_forecast", "live_observed"):
                return JsonResponse(
                    {"error": "'source' must be one of 'chirps'/'pmd_forecast'/'live_observed' for mode='trigger'"},
                    status=400,
                )
            chirps_days = body.get("chirps_days", 1)
            pmd_element = body.get("pmd_element", "daytpe")
        elif mode == "susceptibility":
            include_validation = bool(body.get("include_validation", False))
            method = body.get("method", "auto")
            if method not in _VALID_METHODS:
                return JsonResponse({"error": f"'method' must be one of {_VALID_METHODS}"}, status=400)
            if method == "calibrated" and landslide_calibration.load_model() is None:
                return JsonResponse({"error": "No calibrated model has been trained yet - run mode='calibrate' first."},
                                    status=400)
        elif mode == "lhasa2_exposure_scan":
            threshold_pct = body.get("threshold_pct", landslide_lhasa2_scan._DEFAULT_THRESHOLD_PCT)
            max_exposure_blobs = body.get("max_exposure_blobs", landslide_lhasa2_scan._DEFAULT_MAX_EXPOSURE_BLOBS)
            try:
                threshold_pct = int(threshold_pct)
                max_exposure_blobs = int(max_exposure_blobs)
            except (TypeError, ValueError):
                return JsonResponse({"error": "'threshold_pct'/'max_exposure_blobs' must be integers."}, status=400)
            if not (0 <= threshold_pct <= 100):
                return JsonResponse({"error": "'threshold_pct' must be between 0 and 100."}, status=400)
            if not (1 <= max_exposure_blobs <= 50):
                return JsonResponse({"error": "'max_exposure_blobs' must be between 1 and 50."}, status=400)

        self.check_throttles(request)

        _purge_old_landslide_jobs()
        job_id = str(uuid.uuid4())
        job = {
            "job_id": job_id, "catchment": catchment_key, "mode": mode, "lite": lite,
            "status": "pending", "created_at": time.time(), "started_at": None, "finished_at": None,
            "current_stage": None, "completed_stages": [], "result": None, "error": None,
        }
        with _LANDSLIDE_JOB_LOCK:
            _LANDSLIDE_JOBS[job_id] = job

        if mode == "trigger":
            _LANDSLIDE_JOB_EXECUTOR.submit(
                _run_landslide_trigger_job, job_id, catchment_key, source, lite, chirps_days, pmd_element,
            )
        elif mode == "national_validation":
            _LANDSLIDE_JOB_EXECUTOR.submit(_run_landslide_national_validation_job, job_id, lite)
        elif mode == "lhasa2_exposure_scan":
            _LANDSLIDE_JOB_EXECUTOR.submit(
                _run_landslide_lhasa2_scan_job, job_id, threshold_pct, max_exposure_blobs,
            )
        elif mode == "calibrate":
            _LANDSLIDE_JOB_EXECUTOR.submit(_run_landslide_calibration_job, job_id, lite)
        else:
            _LANDSLIDE_JOB_EXECUTOR.submit(
                _run_landslide_susceptibility_job, job_id, catchment_key, lite, include_validation, method,
            )

        return JsonResponse({"job_id": job_id, "status": "pending"}, status=202)


class LandslideModelStatusView(APIView):
    authentication_classes = []
    permission_classes = []
    throttle_classes = [LandslideModelStatusThrottle]

    def get(self, request, job_id):
        with _LANDSLIDE_JOB_LOCK:
            job = _LANDSLIDE_JOBS.get(job_id)
        if job is None:
            return JsonResponse({"error": "Unknown job_id (it may have expired)."}, status=404)

        started_at = job.get("started_at")
        elapsed_seconds = round(time.time() - started_at, 1) if started_at else None

        payload = {
            "status": job["status"],
            "catchment": job["catchment"],
            "mode": job["mode"],
            "current_stage": job.get("current_stage"),
            "completed_stages": job.get("completed_stages", []),
            "elapsed_seconds": elapsed_seconds,
        }
        if job["status"] == "done":
            payload["result"] = job["result"]
        elif job["status"] == "error":
            payload["error"] = job["error"]
        return JsonResponse(payload)


def _build_susceptibility_export_geojson(catchment_key, result):
    """Mirrors flood_model_views._build_ahp_export_geojson's own shape:
    one Feature per zone class actually present, each carrying the
    SAME exposure numbers the results panel already showed as GeoJSON
    `properties` — but landslide's own exposure report only ever covers
    the HIGH zone (see build_landslide_exposure_report's own docstring:
    "report the severe case plainly, don't blur it into a laxer one"),
    so only the "high" feature gets exposure properties attached; low/
    medium features carry their own zone_class/color only, honestly —
    not a fabricated per-zone exposure split landslide's own pipeline
    doesn't compute."""
    susceptibility = result.get("susceptibility") or {}
    zones_geojson = susceptibility.get("zones") or {"type": "FeatureCollection", "features": []}
    exposure = result.get("exposure") or {}

    features = []
    for feat in zones_geojson.get("features", []):
        zone_class = (feat.get("properties") or {}).get("zone_class")
        properties = {**(feat.get("properties") or {}), "catchment": catchment_key, "mode": "susceptibility"}
        if zone_class == "high" and exposure:
            properties.update(exposure)
        features.append({"type": "Feature", "geometry": feat["geometry"], "properties": properties})
    debris_flow = result.get("debris_flow") or {}
    for feat in (debris_flow.get("geojson") or {}).get("features", []):
        features.append({"type": "Feature", "geometry": feat["geometry"],
                         "properties": {**(feat.get("properties") or {}), "catchment": catchment_key,
                                        "layer": "debris_flow_screening"}})

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "terrain_class": susceptibility.get("terrain_class"),
            "method": susceptibility.get("method"),
            "model_id": susceptibility.get("model_id"),
            "weights": susceptibility.get("weights"),
            "infinite_slope": result.get("infinite_slope"),
            "rockfall": result.get("rockfall"),
            "avalanche": result.get("avalanche"),
            "debris_flow": {k: v for k, v in (result.get("debris_flow") or {}).items() if k != "geojson"} or None,
            "validation": result.get("validation"),
        },
    }


def _build_trigger_export_geojson(catchment_key, result):
    """Trigger mode has no zone geometry of its own (L4 is a catchment-
    level advisory, not a per-pixel result — see landslide_trigger.
    run_landslide_trigger's own docstring) — exported as a single point
    Feature at the catchment's own bbox centroid, carrying the full
    rainfall/threshold/advisory payload as properties. A real, if
    unusual, GeoJSON shape for a non-spatial-zone result, not an error."""
    bbox = landslide_model.PILOT_CATCHMENTS.get(catchment_key, {}).get("bbox") \
        or landslide_model.flood_model.PILOT_CATCHMENTS.get(catchment_key, {}).get("bbox")
    if not bbox:
        raise RuntimeError(f"no bbox available for catchment {catchment_key!r}")
    minx, miny, maxx, maxy = bbox
    centroid = [(minx + maxx) / 2, (miny + maxy) / 2]
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": centroid},
            "properties": {"catchment": catchment_key, "mode": "trigger", **result},
        }],
    }


class LandslideModelExportView(APIView):
    """GET /api/landslide-model/export/<job_id>/

    Downloads a FINISHED job's own result as a real, self-contained
    GeoJSON file — mirrors FloodModelExportView's exact contract (reads
    _LANDSLIDE_JOBS[job_id]["result"] directly, exports exactly what the
    user already saw, available for the same _LANDSLIDE_JOB_TTL_SECONDS
    window)."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [LandslideModelExportThrottle]

    def get(self, request, job_id):
        with _LANDSLIDE_JOB_LOCK:
            job = _LANDSLIDE_JOBS.get(job_id)
        if job is None:
            return JsonResponse(
                {"error": "Unknown job_id (it may have expired — results are only kept for 1 hour)."},
                status=404,
            )
        if job["status"] != "done":
            return JsonResponse(
                {"error": f"This job isn't finished yet (status={job['status']!r}) — nothing to export."},
                status=400,
            )

        result = job.get("result") or {}
        mode = job.get("mode")
        catchment_key = job.get("catchment")

        # national_validation has no spatial zone/point geometry of its
        # own (it's a pooled accuracy figure across every catchment, not
        # a per-catchment result) — a plain JSON download of the same
        # result the status endpoint already returns is the honest
        # export for this mode, not a fabricated GeoJSON shape.
        if mode in ("national_validation", "calibrate"):
            response = JsonResponse(result)
            response["Content-Disposition"] = f'attachment; filename="landslide_{mode}.json"'
            return response

        # lhasa2_exposure_scan already carries real per-feature GeoJSON
        # geometry inside result["features"] — a plain JSON download of
        # exactly what the status endpoint already returned is the honest
        # export here too (its own shape, a features list with mixed
        # assessed/unassessed entries, doesn't map onto the single-
        # zone-class export shape the other modes use).
        if mode == "lhasa2_exposure_scan":
            response = JsonResponse(result)
            response["Content-Disposition"] = 'attachment; filename="landslide_lhasa2_exposure_scan.json"'
            return response

        try:
            if mode == "trigger":
                feature_collection = _build_trigger_export_geojson(catchment_key, result)
            else:
                feature_collection = _build_susceptibility_export_geojson(catchment_key, result)
        except Exception:
            logger.exception(
                "landslide_model_views: export failed for job %s (catchment=%r, mode=%r)",
                job_id, catchment_key, mode,
            )
            return JsonResponse({"error": "Could not build the export file for this result."}, status=502)

        filename = re.sub(r"[^a-zA-Z0-9_\-]+", "_", f"landslide_model_{catchment_key}_{mode}") or "landslide_model_export"
        response = JsonResponse(feature_collection)
        response["Content-Disposition"] = f'attachment; filename="{filename}.geojson"'
        return response


@method_decorator(csrf_exempt, name="dispatch")
class LandslideModelReportExportView(APIView):
    """POST /api/landslide-model/export-report/<job_id>/
    body (optional): {"map_image": "data:image/png;base64,..."}

    Downloads a FINISHED job's own result as a detailed .docx report —
    mirrors FloodModelReportExportView's exact contract (map snapshot +
    legend from the client-supplied map_image, scenario/accuracy
    summary, the same exposure numbers already shown, a data-driven
    mitigation-measures list — landslide_report_export.py, see its own
    module docstring). POST rather than GET for the same reason
    (map_image can run to several hundred KB, and this is a real user-
    initiated download, not something to cache/bookmark by URL)."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [LandslideModelReportExportThrottle]

    def post(self, request, job_id):
        # Same RequestDataTooBig guard as FloodModelReportExportView's
        # own — see that view's docstring for the full "why".
        try:
            raw_body = request.body
        except RequestDataTooBig:
            return JsonResponse(
                {"error": "Request body too large (the map snapshot image may be oversized) — "
                          "try exporting again, or without a map snapshot."},
                status=400,
            )
        try:
            body = json.loads(raw_body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "Malformed JSON body."}, status=400)

        with _LANDSLIDE_JOB_LOCK:
            job = _LANDSLIDE_JOBS.get(job_id)
        if job is None:
            return JsonResponse(
                {"error": "Unknown job_id (it may have expired — results are only kept for 1 hour)."},
                status=404,
            )
        if job["status"] != "done":
            return JsonResponse(
                {"error": f"This job isn't finished yet (status={job['status']!r}) — nothing to export."},
                status=400,
            )

        map_image = body.get("map_image")
        if map_image is not None and not isinstance(map_image, str):
            return JsonResponse({"error": "'map_image' must be a data URL string if provided."}, status=400)

        catchment_key = job.get("catchment")
        mode = job.get("mode")
        try:
            docx_bytes = landslide_report_export.build_landslide_model_docx_report(job, map_image_data_url=map_image)
        except Exception:
            logger.exception(
                "landslide_model_views: report export failed for job %s (catchment=%r, mode=%r)",
                job_id, catchment_key, mode,
            )
            return JsonResponse({"error": "Could not build the report for this result."}, status=502)

        filename = re.sub(r"[^a-zA-Z0-9_\-]+", "_", f"landslide_model_report_{catchment_key}_{mode}") or "landslide_model_report"
        response = HttpResponse(
            docx_bytes,
            content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        response["Content-Disposition"] = f'attachment; filename="{filename}.docx"'
        return response
