# project/ncop_internal/flood_model_views.py
# ---------------------------------------------------------------------------
# Phase 1.6's first real HTTP endpoints for the flash-flood early-warning
# system (see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md §7 "Phase 1.6" for
# the full design). Deliberately a NEW file, not added to views.py — same
# "new subsystem gets its own file" precedent chatbot.py/translate.py
# already established in this app.
#
# Async job-id polling, not a single blocking request — this is no longer
# a hypothetical precaution, it's a confirmed requirement: build_exposure_
# report() alone measured 64-85s even warm (§0.12/§0.13/§0.14 of the
# methodology doc), and Overture's own cold fetch is 225-270s. Any of
# that run synchronously inside a Waitress worker thread would tie up the
# worker for the duration and risk the exact nginx 504 class this project
# already hit once with translation earlier this session.
#
# POST /api/flood-model/run/            -> {"job_id": ..., "status": "pending"}, 202
# GET  /api/flood-model/status/<job_id>/ -> {"status": "pending"|"running"|"done"|"error", ...}
#
# Crash-safety / production notes:
#   - The job registry is a plain in-process dict guarded by a threading
#     .Lock — matches this app's own confirmed reality (§0.14's settings
#     review): no shared cache backend anywhere, Waitress is architecturally
#     single-process. A per-process job registry is therefore NOT a
#     per-worker limitation the way it would be under a multi-process
#     server — it's the whole picture, for this deployment.
#   - Job execution runs through a SEPARATE, dedicated single-worker
#     ThreadPoolExecutor (_JOB_EXECUTOR) — distinct from flood_model.py's
#     _WBT_EXECUTOR, flood_exposure.py's _OVERTURE_EXECUTOR/
#     _POPULATION_EXECUTOR. Those bound individual EXTERNAL calls inside
#     one report; this one bounds how many full end-to-end jobs run at
#     once. max_workers=1 deliberately: build_exposure_report() already
#     serializes internally on the GDAL lock/WBT lock/etc., so "concurrent"
#     jobs would just queue behind those anyway — a second job-level
#     worker would only add thread overhead, not real parallelism.
#   - Every existing PILOT_CATCHMENTS bbox is already validated by
#     flood_model._validate_catchment_bbox() (the AOI size guard from
#     §0.12) the first time build_hand_pipeline() runs for it — this view
#     layer does its OWN cheap validation (catchment key exists,
#     threshold_m is a sane number) before ever touching the executor, so
#     a malformed request fails in milliseconds, not after queuing a job.
#   - CSRF: authentication_classes/permission_classes are both emptied
#     out, not just @csrf_exempt — matching a real bug chatbot.py's own
#     NcopAssistantChatView already hit and fixed in this exact app:
#     csrf_exempt alone does not stop DRF's SessionAuthentication from
#     separately enforcing CSRF whenever the requester happens to be a
#     logged-in NCOP user. This endpoint is open/unauthenticated by
#     design, like every other API in this app — DRF must never attempt
#     session auth (and its CSRF side effect) here at all.
#   - Job registry has both a TTL (1 hour) and a hard count cap (200),
#     purged on every new job submission — bounded memory growth even if
#     a deploy runs for a long time without a restart, never relying on
#     TTL cleanup alone.
# ---------------------------------------------------------------------------

import json
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import flood_exposure, flood_forecast, flood_model, flood_validation

logger = logging.getLogger(__name__)

_JOB_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="flood-model-job")
_JOB_LOCK = threading.Lock()
_JOBS = {}  # job_id (str) -> dict, see _run_flood_model_job for the shape

_JOB_TTL_SECONDS = 3600
_MAX_TRACKED_JOBS = 200

_MIN_THRESHOLD_M = 0.1
_MAX_THRESHOLD_M = 50.0  # generous — Phase 1's own testing only ever explored 2-8m

# Discharge-driven mode (§0.19) bounds — generous but bounded, same
# "reject outright, never silently clamp" posture as threshold_m above.
# 1000mm is a very extreme multi-day monsoon total for this region (a
# single-storm input, not accumulated); 72h covers a multi-day event.
_MIN_RAINFALL_MM = 0.1
_MAX_RAINFALL_MM = 1000.0
_MIN_DURATION_HR = 0.1
_MAX_DURATION_HR = 72.0


def _purge_old_jobs():
    """Bounded memory, not just a TTL comment — a hard count cap runs
    alongside the age-based purge in case TTL cleanup ever lags (e.g. a
    burst of jobs submitted faster than they finish). Called on every new
    job submission, never on a timer thread — no new background thread to
    reason about, piggybacks on request traffic that's already happening."""
    now = time.time()
    with _JOB_LOCK:
        expired = [jid for jid, j in _JOBS.items() if now - j["created_at"] > _JOB_TTL_SECONDS]
        for jid in expired:
            del _JOBS[jid]
        if len(_JOBS) > _MAX_TRACKED_JOBS:
            by_age = sorted(_JOBS.items(), key=lambda kv: kv[1]["created_at"])
            for jid, _ in by_age[: len(_JOBS) - _MAX_TRACKED_JOBS]:
                del _JOBS[jid]


def _mark_stage(job_id, stage_name):
    """Records the current stage + appends it to the completed-so-far list
    — the SAME stage name is used for both "now running" (while it's the
    most recent entry with no successor yet) and "done" (once a later
    stage is appended), so the frontend can render a simple checklist
    without a separate boolean per stage. Purely additive to the job
    dict; a status poll that predates this field just won't have it."""
    with _JOB_LOCK:
        if job_id not in _JOBS:
            return
        _JOBS[job_id]["current_stage"] = stage_name
        _JOBS[job_id]["completed_stages"].append(stage_name)


def _run_flood_model_job(job_id, catchment_key, threshold_m, discharge_scenario=None):
    """Runs entirely inside _JOB_EXECUTOR's worker thread — never called
    directly from a request-handling thread. Calls flood_model.py/
    flood_exposure.py exactly as they already exist (build_exposure_
    report's new progress_callback parameter is optional/additive — see
    its own docstring — every OTHER caller still passes nothing and
    behaves identically); this is a thin orchestration wrapper only.

    `discharge_scenario`, if given, is a {"rainfall_mm", "duration_hr"}
    dict — switches this job to Phase-2's discharge-driven mode
    (flood_model.build_discharge_driven_flood_zone, §0.19) instead of
    the fixed-threshold mode. §0.24 wired this mode to a full exposure
    report too (flood_exposure.build_discharge_exposure_report) —
    vectorizing the discharge model's own per-pixel-varying mask
    (flood_model.build_discharge_binary_mask) into a geometry and
    running it through the SAME buildings/roads/drainage/population
    pipeline the fixed-threshold mode already uses, unmodified. A
    discharge-driven run's response now has a real, non-null exposure
    breakdown, same shape as the fixed-threshold one (plus its own
    "scenario" field instead of "threshold_m")."""
    with _JOB_LOCK:
        if job_id not in _JOBS:
            return  # purged before it got a chance to run — nothing to update
        _JOBS[job_id]["status"] = "running"
        _JOBS[job_id]["started_at"] = time.time()
    try:
        if discharge_scenario is not None:
            _mark_stage(job_id, "Fetching elevation & computing terrain hydrology (HAND)")

            # §0.36 — a custom AOI has no hand-researched composite_cn/
            # basin_length_km the way the 4 curated pilots do. Auto-
            # derive both (flood_model.derive_composite_cn/derive_basin_
            # length_km — real TR-55/distance_to_outlet methods, cached
            # like every other per-catchment artifact) and inject into
            # the transient PILOT_CATCHMENTS entry BEFORE the discharge
            # model runs, so build_discharge_driven_flood_zone's own
            # existing cfg["composite_cn"] lookup finds a real value —
            # zero changes needed to that function itself. Runs INSIDE
            # this async job worker, not the view layer — a cold
            # derivation is real, non-trivial work (LULC/soil fetch +
            # a WhiteboxTools call), and this project's own standing
            # discipline is that nothing potentially slow ever blocks
            # the HTTP request/response cycle (see this file's own
            # module docstring on why the whole job-id pattern exists).
            cfg = flood_model.PILOT_CATCHMENTS.get(catchment_key, {})
            if cfg.get("is_custom_aoi") and cfg.get("composite_cn") is None:
                _mark_stage(job_id, "Auto-deriving runoff/channel parameters (land cover, soil, flow path)")
                cn_result = flood_model.derive_composite_cn(catchment_key)
                length_result = flood_model.derive_basin_length_km(catchment_key)
                cfg["composite_cn"] = cn_result["composite_cn"]
                cfg["basin_length_km"] = length_result["basin_length_km"]
                logger.info(
                    "flood_model_views: auto-derived composite_cn=%r, basin_length_km=%r for custom AOI %r",
                    cfg["composite_cn"], cfg["basin_length_km"], catchment_key,
                )

            _mark_stage(job_id, "Computing rainfall-driven discharge & spatially-varying flood stage")
            zone_payload = flood_model.build_discharge_driven_flood_zone(
                catchment_key,
                rainfall_mm=discharge_scenario["rainfall_mm"],
                duration_hr=discharge_scenario["duration_hr"],
            )
            exposure_payload = flood_exposure.build_discharge_exposure_report(
                catchment_key,
                rainfall_mm=discharge_scenario["rainfall_mm"],
                duration_hr=discharge_scenario["duration_hr"],
                progress_callback=lambda stage: _mark_stage(job_id, stage),
            )
            result = {"flood_zone": zone_payload, "exposure": exposure_payload, "mode": "discharge_driven"}
        else:
            _mark_stage(job_id, "Fetching elevation & computing terrain hydrology (HAND)")
            zone_payload = flood_model.render_flood_prone_zones(catchment_key, threshold_m=threshold_m)
            exposure_payload = flood_exposure.build_exposure_report(
                catchment_key, threshold_m=threshold_m,
                progress_callback=lambda stage: _mark_stage(job_id, stage),
            )
            result = {"flood_zone": zone_payload, "exposure": exposure_payload, "mode": "fixed_threshold"}
        with _JOB_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["status"] = "done"
                _JOBS[job_id]["result"] = result
                _JOBS[job_id]["finished_at"] = time.time()
    except Exception as exc:
        logger.exception("flood_model_views: job %s failed", job_id)
        with _JOB_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["status"] = "error"
                _JOBS[job_id]["error"] = str(exc)
                _JOBS[job_id]["finished_at"] = time.time()


def _run_riverine_flood_model_job(job_id, catchment_key):
    """Riverine mode's job runner — mirrors _run_flood_model_job's own
    structure exactly (running inside _JOB_EXECUTOR's worker thread,
    marking stages, writing status/result/error back into _JOBS under
    _JOB_LOCK), but calls flood_model.build_riverine_flood_zone (§R4,
    rebuilt to use connected_flood_fill after the original uniform-
    threshold approach was confirmed to leak into disconnected terrain —
    see that function's own docstring for the full account) and
    flood_exposure.build_riverine_exposure_report (its own dedicated
    counterpart to build_discharge_exposure_report, reusing the same
    shared exposure core every mode uses)."""
    with _JOB_LOCK:
        if job_id not in _JOBS:
            return
        _JOBS[job_id]["status"] = "running"
        _JOBS[job_id]["started_at"] = time.time()
    try:
        _mark_stage(job_id, "Fetching elevation & computing terrain hydrology (HAND)")
        _mark_stage(job_id, "Reading live river gauge & computing connected flood extent")
        zone_payload = flood_model.build_riverine_flood_zone(catchment_key)
        exposure_payload = flood_exposure.build_riverine_exposure_report(
            catchment_key,
            progress_callback=lambda stage: _mark_stage(job_id, stage),
        )

        # §0.35 — real shape comparison against the app's own 20 EXISTING
        # hydrological_global flood-extent layers (a completely separate
        # ground truth from GFD). Never raises (degrades to an {"error":
        # ...} dict for a catchment with no wfs_river_system mapping,
        # e.g. nullah_lai — confirmed to have zero real overlap) — the
        # frontend checks for that key rather than assuming success.
        _mark_stage(job_id, "Comparing against existing flood-extent hazard layers")
        shape_comparison = flood_validation.run_flood_extent_shape_comparison(catchment_key)

        result = {
            "flood_zone": zone_payload, "exposure": exposure_payload,
            "shape_comparison": shape_comparison, "mode": "riverine",
        }
        with _JOB_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["status"] = "done"
                _JOBS[job_id]["result"] = result
                _JOBS[job_id]["finished_at"] = time.time()
    except Exception as exc:
        logger.exception("flood_model_views: riverine job %s failed", job_id)
        with _JOB_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["status"] = "error"
                _JOBS[job_id]["error"] = str(exc)
                _JOBS[job_id]["finished_at"] = time.time()


def _run_ahp_susceptibility_job(job_id, catchment_key, lite=True):
    """AHP susceptibility mode's job runner — mirrors _run_riverine_flood_
    model_job's own structure. Works for EITHER flood type (flash or
    riverine) — flood_model.build_ahp_susceptibility_raster's own
    terrain-class dispatch already picks the right literature-conditioned
    weight profile per catchment, so this runner doesn't need to branch
    on flood_type at all, unlike the fixed-threshold/discharge-driven vs.
    riverine split above (those have genuinely different INPUT shapes —
    a rainfall scenario vs. a live gauge reading — while the AHP score
    has none: every factor feeding it is catchment-static, see that
    function's own docstring).

    Now also builds the 3-class susceptibility ZONES (flood_model.
    build_ahp_zone_geometries) and their own classified exposure report
    (flood_exposure.build_ahp_zone_exposure_report) — the AHP-zonation
    follow-on work. Uses the SAME progress_callback delegation pattern
    every other mode's own job runner already uses for its exposure
    step (this runner previously made its own inline _mark_stage calls
    only, since it had no exposure step at all — now that it does,
    delegating keeps it consistent with the other 3 modes instead of
    diverging)."""
    with _JOB_LOCK:
        if job_id not in _JOBS:
            return
        _JOBS[job_id]["status"] = "running"
        _JOBS[job_id]["started_at"] = time.time()
    try:
        _mark_stage(job_id, "Fetching elevation & computing terrain hydrology (HAND)")
        _mark_stage(job_id, "Building AHP factor rasters (distance-to-river, TWI, LULC, soil, rainfall, NDVI, connectivity...)")
        _mark_stage(job_id, "Combining factors via literature-weighted overlay")
        susceptibility_payload = flood_model.render_ahp_susceptibility_png(catchment_key, lite=lite)

        _mark_stage(job_id, "Building susceptibility zone boundaries (low/medium/high)")
        zones_payload = flood_model.build_ahp_zone_geometries(catchment_key, lite=lite)
        susceptibility_payload["zones"] = zones_payload["geojson"]
        # §0.43 — real, live Frequency-Ratio-vs-AHP AUC comparison, only
        # ever populated for a custom AOI with real GFD ground truth
        # nearby (see compute_frequency_ratio_ensemble's own docstring);
        # None for every curated pilot and for a custom AOI with no
        # nearby ground truth — the frontend degrades that to the same
        # honest "no accuracy result" messaging it already has.
        susceptibility_payload["custom_aoi_accuracy"] = zones_payload.get("custom_aoi_accuracy")

        exposure_payload = flood_exposure.build_ahp_zone_exposure_report(
            catchment_key, lite=lite,
            progress_callback=lambda stage: _mark_stage(job_id, stage),
        )

        _mark_stage(job_id, "Building classified map layers (schools, bridges, roads, drainage)")
        map_layers_payload = flood_exposure.build_ahp_zone_classified_map_layers(catchment_key, lite=lite)

        # §0.35 — see the matching comment in _run_riverine_flood_model_job.
        # Cached, so this is a cheap cache-hit if the riverine job already
        # ran it for the same catchment.
        _mark_stage(job_id, "Comparing against existing flood-extent hazard layers")
        shape_comparison = flood_validation.run_flood_extent_shape_comparison(catchment_key)

        result = {
            "susceptibility": susceptibility_payload,
            "zone_exposure": exposure_payload,
            "zone_map_layers": map_layers_payload,
            "shape_comparison": shape_comparison,
            "mode": "ahp_susceptibility",
        }
        with _JOB_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["status"] = "done"
                _JOBS[job_id]["result"] = result
                _JOBS[job_id]["finished_at"] = time.time()
    except Exception as exc:
        logger.exception("flood_model_views: AHP susceptibility job %s failed", job_id)
        with _JOB_LOCK:
            if job_id in _JOBS:
                _JOBS[job_id]["status"] = "error"
                _JOBS[job_id]["error"] = str(exc)
                _JOBS[job_id]["finished_at"] = time.time()


class FloodModelRunThrottle(AnonRateThrottle):
    scope = "flood_model_run"


class FloodModelStatusThrottle(AnonRateThrottle):
    scope = "flood_model_status"


class FloodModelBuildingsViewThrottle(AnonRateThrottle):
    scope = "flood_model_buildings_view"


class FloodModelPrewarmThrottle(AnonRateThrottle):
    scope = "flood_model_prewarm"


class FloodModelExportThrottle(AnonRateThrottle):
    scope = "flood_model_export"


@method_decorator(csrf_exempt, name="dispatch")
class FloodModelRunView(APIView):
    # See module docstring's CSRF note — matches NcopAssistantChatView's
    # own already-fixed pattern exactly, not a new invention.
    authentication_classes = []
    permission_classes = []
    throttle_classes = [FloodModelRunThrottle]

    def initial(self, request, *args, **kwargs):
        # Deliberately does NOT call super().initial(), which would run
        # self.check_throttles(request) automatically before post() ever
        # sees the request. Confirmed live during this view's own testing:
        # DRF's automatic dispatch-time throttle check fires before ANY
        # validation, so a malformed catchment or bad JSON body — free,
        # instant, never touches the job executor — would consume the
        # same tight 3/min budget as a real, expensive job submission. A
        # user who fat-fingers a couple of requests would then be locked
        # out of submitting a genuine run for the rest of that minute.
        # Fixed by checking auth/permissions here as normal, but deferring
        # the throttle check to post() itself, AFTER validation passes —
        # see the explicit self.check_throttles() call below.
        self.perform_authentication(request)
        self.check_permissions(request)

    def post(self, request):
        try:
            body = json.loads(request.body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "Malformed JSON body."}, status=400)

        catchment_key = body.get("catchment")

        # §0.36 — custom-AOI support: catchment: "custom" + a real,
        # user-drawn bbox, instead of one of the hand-curated pilot
        # keys. register_custom_aoi (flood_model.py) validates the bbox
        # (the SAME _validate_catchment_bbox already written for this
        # exact purpose) and synthesizes a transient PILOT_CATCHMENTS
        # entry — from here on, `catchment_key` is reassigned to the
        # real, content-addressed key it returns, and every line below
        # (unchanged) treats it exactly like any of the 4 curated
        # pilots, since the underlying pipeline was already confirmed
        # bbox-generic.
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
            custom_flood_type = body.get("flood_type", "flash")
            if custom_flood_type not in ("flash", "riverine"):
                return JsonResponse(
                    {"error": "'flood_type' for a custom area must be 'flash' or 'riverine'."},
                    status=400,
                )
            # §0.37 — the user's own real drawn polygon (not just its
            # bbox), so the rendered result clips to the actual shape
            # instead of the whole bounding rectangle (a real, confirmed
            # bug). Optional and validated loosely — a missing/malformed
            # polygon degrades to bbox-only behavior (still correct,
            # just less precise), never a hard error, since a bbox-only
            # submission was already a valid request shape before this.
            polygon_raw = body.get("polygon")
            polygon_geojson = None
            if isinstance(polygon_raw, dict) and polygon_raw.get("type") in ("Polygon", "MultiPolygon"):
                polygon_geojson = polygon_raw
            elif polygon_raw is not None:
                logger.warning(
                    "flood_model_views: ignoring malformed 'polygon' in custom-AOI request "
                    "(expected a GeoJSON Polygon/MultiPolygon geometry) - falling back to bbox-only",
                )
            try:
                catchment_key = flood_model.register_custom_aoi(
                    bbox, flood_type=custom_flood_type, polygon_geojson=polygon_geojson,
                )
            except ValueError as e:
                return JsonResponse({"error": str(e)}, status=400)

        if not catchment_key or catchment_key not in flood_model.PILOT_CATCHMENTS:
            return JsonResponse(
                {"error": f"Unknown or missing 'catchment' — known: {list(flood_model.PILOT_CATCHMENTS)}"},
                status=400,
            )

        # Flood-type selection — a property of the CATCHMENT's own
        # physical character (flood_model.PILOT_CATCHMENTS' own
        # "flood_type" field), not an independent request-body toggle: a
        # small nullah basin cannot meaningfully be run as "riverine" and
        # a major-river reach cannot meaningfully be run as a local
        # SCS-CN discharge scenario. Riverine catchments skip every
        # flash-flood-specific parameter below entirely (rejected if
        # provided, not silently ignored) — see build_riverine_flood_zone
        # (flood_model.py) for why this mode needs none of them: its own
        # threshold is derived live from a real FFD gauge reading, not a
        # rainfall scenario or a manually-typed cutoff.
        catchment_cfg = flood_model.PILOT_CATCHMENTS[catchment_key]
        is_riverine = catchment_cfg.get("flood_type") == "riverine"

        # AHP susceptibility mode — opt-in via 'mode', checked BEFORE the
        # flash/riverine branching below since it works identically for
        # EITHER flood type (flood_model.build_ahp_susceptibility_raster's
        # own terrain-class dispatch already picks the right profile per
        # catchment — see _run_ahp_susceptibility_job's own docstring for
        # why this doesn't need the flash/riverine split every other mode
        # does). Every flash/riverine-specific param is rejected here too,
        # same posture as the riverine branch below — this mode has NO
        # scenario input of its own (see build_ahp_susceptibility_raster's
        # own docstring: every factor is catchment-static).
        if body.get("mode") == "ahp_susceptibility":
            scenario_only_params = [
                p for p in ("threshold_m", "rainfall_mm", "duration_hr", "rainfall_source",
                            "chirps_days", "pmd_element")
                if body.get(p) is not None
            ]
            if scenario_only_params:
                return JsonResponse(
                    {"error": f"AHP susceptibility mode takes no scenario input — "
                              f"{scenario_only_params} do not apply (every factor is "
                              f"catchment-static, not scenario-driven)."},
                    status=400,
                )
            lite = body.get("lite", True)
            if not isinstance(lite, bool):
                return JsonResponse({"error": "'lite' must be a boolean."}, status=400)
            self.check_throttles(request)
            return self._submit_ahp_susceptibility_job(catchment_key, lite=lite)

        # §0.44 — a custom riverine AOI is genuinely supported now
        # (flood_model.build_riverine_flood_zone derives a water level
        # via GeoGLOWS + a synthetic rating curve when there's no real
        # ffd_station mapping — see that function's own docstring) — no
        # longer hard-rejected here. A GENUINE failure (no GeoGLOWS reach
        # found near this specific area, or the service unreachable
        # right now) still surfaces as a clear job "error" status from
        # the job runner's own try/except, matching every other mode's
        # existing error-handling convention — not a silent success.

        if is_riverine:
            flash_only_params = [
                p for p in ("threshold_m", "rainfall_mm", "duration_hr", "rainfall_source",
                            "chirps_days", "pmd_element")
                if body.get(p) is not None
            ]
            if flash_only_params:
                return JsonResponse(
                    {"error": f"{catchment_key!r} is a riverine catchment — "
                              f"{flash_only_params} do not apply to it (its threshold is derived "
                              f"live from a real river gauge reading, not a rainfall scenario or a "
                              f"manually-typed cutoff)."},
                    status=400,
                )
            threshold_m = None
            discharge_scenario = None
            rainfall_source = "manual"
            self.check_throttles(request)
            return self._submit_riverine_job(catchment_key)

        threshold_m = body.get("threshold_m", flood_model.HAND_FLOOD_PRONE_THRESHOLD_M)
        try:
            threshold_m = float(threshold_m)
        except (TypeError, ValueError):
            return JsonResponse({"error": "'threshold_m' must be a number."}, status=400)
        if not (_MIN_THRESHOLD_M <= threshold_m <= _MAX_THRESHOLD_M):
            return JsonResponse(
                {"error": f"'threshold_m' must be between {_MIN_THRESHOLD_M} and {_MAX_THRESHOLD_M} metres."},
                status=400,
            )

        # Discharge-driven mode (§0.19) — OPT-IN via 'rainfall_mm'/
        # 'duration_hr' in the body, OR via 'rainfall_source' (§0.26) for a
        # real forecasted/observed value instead of a manually-typed one.
        # threshold_m above is simply ignored when this mode is used (still
        # validated first, for a consistent error-shape regardless of
        # which mode a malformed request was aiming for).
        discharge_scenario = None
        rainfall_mm_raw = body.get("rainfall_mm")
        duration_hr_raw = body.get("duration_hr")
        rainfall_source = body.get("rainfall_source", "manual")

        if rainfall_source not in flood_forecast.RAINFALL_SOURCES:
            return JsonResponse(
                {"error": f"Unknown 'rainfall_source' — known: {list(flood_forecast.RAINFALL_SOURCES)}"},
                status=400,
            )

        if rainfall_source != "manual":
            # A real-data source is mutually exclusive with manually typed
            # values — accepting both silently would leave it ambiguous
            # which one actually drove the run. The actual fetch (a real
            # external network call — GEE/PMD Monitor/NWFC PDF, NOT cheap
            # like the checks above) is deliberately deferred until AFTER
            # self.check_throttles() below, for the same reason job
            # submission itself is deferred there: an unthrottled path
            # here would let repeated non-manual requests spend external-
            # API budget before ever being rate-limited.
            if rainfall_mm_raw is not None or duration_hr_raw is not None:
                return JsonResponse(
                    {"error": "'rainfall_mm'/'duration_hr' must not be provided together with a "
                              "non-manual 'rainfall_source'."},
                    status=400,
                )
            # chirps_days/pmd_element are client-controlled inputs to the
            # fetch below — bounded here for the same reason as
            # rainfall_mm/duration_hr are for manual mode: an unvalidated
            # chirps_days (e.g. 50) wouldn't crash anything downstream (no
            # hard bound exists past this point) but would silently feed a
            # scientifically-invalid multi-week "single storm" duration
            # into SCS-CN/SCS-UH, which assumes one storm event, not a
            # season — the same reasoning accuracy_assessment.
            # fetch_peak_event_rainfall's own docstring documents for why
            # a GFD event's full multi-month window can't be summed
            # wholesale into one rainfall_mm either.
            chirps_days_raw = body.get("chirps_days", 1)
            try:
                chirps_days = int(chirps_days_raw)
            except (TypeError, ValueError):
                return JsonResponse({"error": "'chirps_days' must be an integer."}, status=400)
            if not (1 <= chirps_days <= 3):
                return JsonResponse({"error": "'chirps_days' must be between 1 and 3."}, status=400)

            pmd_element = body.get("pmd_element", "daytpe")
            if pmd_element not in flood_forecast.PMD_FORECAST_ELEMENTS:
                return JsonResponse(
                    {"error": f"Unknown 'pmd_element' — known: {list(flood_forecast.PMD_FORECAST_ELEMENTS)}"},
                    status=400,
                )
        elif rainfall_mm_raw is not None or duration_hr_raw is not None:
            if rainfall_mm_raw is None or duration_hr_raw is None:
                return JsonResponse(
                    {"error": "'rainfall_mm' and 'duration_hr' must both be provided together."},
                    status=400,
                )
            try:
                rainfall_mm = float(rainfall_mm_raw)
                duration_hr = float(duration_hr_raw)
            except (TypeError, ValueError):
                return JsonResponse(
                    {"error": "'rainfall_mm' and 'duration_hr' must both be numbers."}, status=400,
                )
            if not (_MIN_RAINFALL_MM <= rainfall_mm <= _MAX_RAINFALL_MM):
                return JsonResponse(
                    {"error": f"'rainfall_mm' must be between {_MIN_RAINFALL_MM} and {_MAX_RAINFALL_MM}."},
                    status=400,
                )
            if not (_MIN_DURATION_HR <= duration_hr <= _MAX_DURATION_HR):
                return JsonResponse(
                    {"error": f"'duration_hr' must be between {_MIN_DURATION_HR} and {_MAX_DURATION_HR}."},
                    status=400,
                )
            discharge_scenario = {
                "rainfall_mm": rainfall_mm, "duration_hr": duration_hr, "rainfall_source": "manual",
            }

        # Validation passed — NOW the request is actually going to submit
        # a real, expensive job, so the throttle budget applies from here
        # on. self.check_throttles() raises rest_framework.exceptions.
        # Throttled on failure, which dispatch()'s own exception handling
        # (post() runs inside the same try/except block) converts to a
        # 429 exactly as if it had fired automatically — same production
        # behavior, just correctly scoped to real job submissions only.
        self.check_throttles(request)

        if rainfall_source != "manual":
            try:
                fetched = flood_forecast.resolve_rainfall_scenario(
                    catchment_key, rainfall_source,
                    chirps_days=chirps_days,
                    pmd_element=pmd_element,
                )
            except ValueError as e:
                return JsonResponse({"error": str(e)}, status=502)
            discharge_scenario = {
                "rainfall_mm": fetched["rainfall_mm"],
                "duration_hr": fetched["duration_hr"],
                "rainfall_source": rainfall_source,
                "source_meta": fetched,
            }

        _purge_old_jobs()

        job_id = uuid.uuid4().hex
        with _JOB_LOCK:
            _JOBS[job_id] = {
                "status": "pending",
                "catchment": catchment_key,
                "threshold_m": threshold_m,
                "discharge_scenario": discharge_scenario,
                "created_at": time.time(),
                "result": None,
                "error": None,
                "current_stage": None,
                "completed_stages": [],
            }

        # A fetched (non-manual) rainfall value can genuinely be a "dry"
        # reading — confirmed live (§0.26): PMD Forecast and the NWFC
        # observed report both routinely return 0mm for a catchment during
        # a real dry spell. build_discharge_driven_flood_zone itself hard-
        # requires rainfall_mm > 0 (a genuine, confirmed-live requirement
        # of its SCS-CN math, not merely a manual-input sanity gate) — so
        # rather than let that surface as a confusing "must be positive"
        # job error for what is actually a perfectly normal real-world
        # result, short-circuit here: resolve the job immediately as
        # "done" with an honest no-flood-expected result, without ever
        # spinning up the expensive HAND/discharge pipeline for an outcome
        # that's already known. Manual-mode requests still go through
        # FloodModelRunView's own _MIN_RAINFALL_MM validation above and so
        # can never reach this branch with a sub-floor value.
        if (
            discharge_scenario is not None
            and discharge_scenario.get("rainfall_source") != "manual"
            and discharge_scenario["rainfall_mm"] < _MIN_RAINFALL_MM
        ):
            no_flood_result = {
                "flood_zone": None,
                "exposure": None,
                "mode": "discharge_driven",
                "no_flood_expected": True,
                "message": (
                    f"Fetched rainfall ({discharge_scenario['rainfall_mm']}mm over "
                    f"{discharge_scenario['duration_hr']}h from {rainfall_source}) is too low to "
                    "drive the discharge model — no flood risk currently indicated by this source."
                ),
            }
            with _JOB_LOCK:
                _JOBS[job_id]["status"] = "done"
                _JOBS[job_id]["result"] = no_flood_result
                _JOBS[job_id]["finished_at"] = time.time()
            return JsonResponse({"job_id": job_id, "status": "pending"}, status=202)

        _JOB_EXECUTOR.submit(_run_flood_model_job, job_id, catchment_key, threshold_m, discharge_scenario)

        return JsonResponse({"job_id": job_id, "status": "pending"}, status=202)

    def _submit_riverine_job(self, catchment_key):
        """Riverine mode's own job submission — separate from the main
        flash-flood body above (fixed-threshold/discharge-driven share one
        code path; riverine's inputs and job runner are different enough
        to warrant their own, rather than threading a third case through
        every line of the flash-flood validation block)."""
        _purge_old_jobs()
        job_id = uuid.uuid4().hex
        with _JOB_LOCK:
            _JOBS[job_id] = {
                "status": "pending",
                "catchment": catchment_key,
                "threshold_m": None,
                "discharge_scenario": None,
                "flood_type": "riverine",
                "created_at": time.time(),
                "result": None,
                "error": None,
                "current_stage": None,
                "completed_stages": [],
            }
        _JOB_EXECUTOR.submit(_run_riverine_flood_model_job, job_id, catchment_key)
        return JsonResponse({"job_id": job_id, "status": "pending"}, status=202)

    def _submit_ahp_susceptibility_job(self, catchment_key, lite=True):
        """AHP susceptibility mode's own job submission — mirrors
        _submit_riverine_job's own structure exactly."""
        _purge_old_jobs()
        job_id = uuid.uuid4().hex
        with _JOB_LOCK:
            _JOBS[job_id] = {
                "status": "pending",
                "catchment": catchment_key,
                "threshold_m": None,
                "discharge_scenario": None,
                "flood_type": "ahp_susceptibility",
                "created_at": time.time(),
                "result": None,
                "error": None,
                "current_stage": None,
                "completed_stages": [],
            }
        _JOB_EXECUTOR.submit(_run_ahp_susceptibility_job, job_id, catchment_key, lite)
        return JsonResponse({"job_id": job_id, "status": "pending"}, status=202)


@method_decorator(csrf_exempt, name="dispatch")
class FloodModelStatusView(APIView):
    authentication_classes = []
    permission_classes = []
    throttle_classes = [FloodModelStatusThrottle]

    def get(self, request, job_id):
        with _JOB_LOCK:
            job = _JOBS.get(job_id)
        if job is None:
            return JsonResponse({"error": "Unknown job_id (it may have expired)."}, status=404)

        # §0.37 — a real, honest elapsed-time figure (not fabricated),
        # for the redesigned checklist's own per-stage timing display.
        # started_at was already being stored on every job (used
        # internally for nothing but logging) — just never surfaced
        # here before.
        started_at = job.get("started_at")
        elapsed_seconds = round(time.time() - started_at, 1) if started_at else None

        payload = {
            "status": job["status"],
            "catchment": job["catchment"],
            "threshold_m": job["threshold_m"],
            "discharge_scenario": job.get("discharge_scenario"),
            "flood_type": job.get("flood_type", "flash"),
            "current_stage": job.get("current_stage"),
            "completed_stages": job.get("completed_stages", []),
            "elapsed_seconds": elapsed_seconds,
        }
        if job["status"] == "done":
            payload["result"] = job["result"]
        elif job["status"] == "error":
            payload["error"] = job["error"]
        return JsonResponse(payload)


def _build_zone_export_geojson(catchment_key, result):
    """§0.47 — non-AHP modes (fixed_threshold/discharge_driven/riverine)
    all share ONE result shape (`{"flood_zone": {..., "mask_path"},
    "exposure": {...}, "mode": ...}` — confirmed by direct code read of
    every job runner above), so one function covers all three. Re-
    vectorizes the ALREADY-cached binary mask (flood_exposure._
    vectorize_flood_zone — cheap, deterministic, no new artifact ever
    written) into ONE Feature, carrying the full exposure report
    (buildings/population/roads/drainage/administrative context — the
    SAME numbers already shown in the results panel, not recomputed or
    summarized down) as its own GeoJSON `properties`, plus the run's own
    scenario (threshold_m / rainfall+duration / gauge reading, whichever
    applies) so the file is self-describing without the original job
    context. Returns an EMPTY FeatureCollection (not an error) if this
    scenario genuinely had zero flood-prone cells — a real, valid
    outcome some scenarios produce."""
    zone_payload = result.get("flood_zone") or {}
    mask_path = zone_payload.get("mask_path")
    if not mask_path or not os.path.exists(mask_path):
        raise RuntimeError(f"no cached flood-zone mask available for catchment {catchment_key!r}")

    with flood_model._gdal_lock():
        geom = flood_exposure._vectorize_flood_zone(mask_path)
    if geom is None:
        return {
            "type": "FeatureCollection",
            "features": [],
            "metadata": {"note": "This scenario had no flood-prone cells — nothing to export."},
        }

    properties = {
        "catchment": catchment_key,
        "mode": result.get("mode"),
        "threshold_m": result.get("threshold_m") or zone_payload.get("threshold_m"),
        "scenario": zone_payload.get("scenario"),
        **(result.get("exposure") or {}),
    }
    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "geometry": geom.__geo_interface__, "properties": properties}],
    }


def _build_ahp_export_geojson(catchment_key, result):
    """§0.47 — AHP mode reuses its own already-vectorized zone
    geometries (susceptibility.zones, from build_ahp_zone_geometries'
    own cache — no re-vectorization needed) directly: one Feature per
    zone class actually present (a catchment with no "high" zone simply
    has 2 features, matching that function's own established
    convention), each carrying ITS OWN zone's exposure breakdown
    (zone_exposure.by_zone[zone_class] — buildings/population/roads/
    drainage/infrastructure specific to that class, not the catchment
    overall) as GeoJSON `properties`. Catchment-level context (AHP
    weights actually used, auto-selected terrain class, per-admin-region
    dominant-zone tagging) doesn't belong on any ONE zone's own feature —
    carried instead in the FeatureCollection's own top-level
    `metadata` (a real, if non-standard, GeoJSON extension — every
    modern GIS tool tolerates unrecognized top-level keys)."""
    susceptibility = result.get("susceptibility") or {}
    zones_geojson = susceptibility.get("zones") or {"type": "FeatureCollection", "features": []}
    zone_exposure_report = result.get("zone_exposure") or {}
    by_zone = zone_exposure_report.get("by_zone", {})

    features = []
    for feat in zones_geojson.get("features", []):
        zone_class = (feat.get("properties") or {}).get("zone_class")
        properties = {
            **(feat.get("properties") or {}),
            "catchment": catchment_key,
            "mode": "ahp_susceptibility",
            **(by_zone.get(zone_class) or {}),
        }
        features.append({"type": "Feature", "geometry": feat["geometry"], "properties": properties})

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "weights": susceptibility.get("weights"),
            "terrain_class": susceptibility.get("terrain_class"),
            "administrative_zone_context": zone_exposure_report.get("administrative_zone_context"),
        },
    }


@method_decorator(csrf_exempt, name="dispatch")
class FloodModelExportView(APIView):
    """GET /api/flood-model/export/<job_id>/

    §0.47 — downloads a FINISHED job's own result as a real, self-
    contained GeoJSON file: the flood-zone/AHP-zone geometry the panel
    already rendered, each feature carrying the SAME exposure numbers
    (buildings/population/roads/drainage/administrative context) already
    computed and shown in the results panel, attached as real GeoJSON
    feature `properties` — directly openable in QGIS/ArcGIS/geopandas,
    no separate lookup needed to connect a zone to its own numbers.

    Reads `_JOBS[job_id]["result"]` directly (the SAME in-memory,
    already-computed payload FloodModelStatusView itself already
    returns) rather than re-deriving anything from catchment_key —
    exports exactly what the user already saw, nothing recomputed,
    nothing that could drift from the displayed result. Available for
    the same _JOB_TTL_SECONDS (1 hour) every other job-id lookup in this
    file already uses — a real, stated limit, not indefinite. Works
    identically for a curated pilot or a custom AOI (drawn or uploaded,
    flash or riverine) — every mode's own result already carries the
    same shape this reads, regardless of where the catchment came from.

    Same CSRF-safety posture as every other flood-model endpoint
    (authentication_classes/permission_classes both emptied — see
    module docstring)."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [FloodModelExportThrottle]

    def get(self, request, job_id):
        with _JOB_LOCK:
            job = _JOBS.get(job_id)
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
        mode = result.get("mode")
        catchment_key = job.get("catchment")

        try:
            if mode == "ahp_susceptibility":
                feature_collection = _build_ahp_export_geojson(catchment_key, result)
            else:
                feature_collection = _build_zone_export_geojson(catchment_key, result)
        except Exception:
            logger.exception(
                "flood_model_views: export failed for job %s (catchment=%r, mode=%r)",
                job_id, catchment_key, mode,
            )
            return JsonResponse({"error": "Could not build the export file for this result."}, status=502)

        filename = re.sub(r"[^a-zA-Z0-9_\-]+", "_", f"flood_model_{catchment_key}_{mode}") or "flood_model_export"
        response = JsonResponse(feature_collection)
        response["Content-Disposition"] = f'attachment; filename="{filename}.geojson"'
        return response


# Hard reject ceiling for the requested viewport, AFTER clamping to the
# catchment's own bbox — a defense against a stray/malicious request
# trying to pull an entire catchment's buildings through what's meant to
# be a small, already-zoomed-in viewport path. 0.2 degrees (~20km at
# Pakistan's latitudes) is generous headroom above any real viewport at
# AHP_BUILDINGS_MINZOOM (frontend, ~0.01-0.05deg at zoom 15+) while still
# well below every pilot catchment's own bbox span (Nullah Lai's own
# ~0.2 x 0.22deg bbox is itself right at this edge — deliberately so,
# this ceiling is meant to catch "the whole catchment", not bite a real
# tight-zoom viewport).
_BUILDINGS_VIEWPORT_MAX_DEGREES = 0.2


@method_decorator(csrf_exempt, name="dispatch")
class FloodModelAhpBuildingsInViewView(APIView):
    """GET /api/flood-model/ahp-buildings-in-view/?catchment=<key>&bbox=minx,miny,maxx,maxy

    Sub-phase 5 — viewport-bounded buildings-on-zoom, the piece
    deliberately deferred out of the AHP-zonation Sub-phase 4 work (see
    flood_exposure.py's own module comment above get_buildings_in_
    viewport for the full "why"). Synchronous, not job-id/polling based
    like FloodModelRunView — bounded by flood_exposure._get_cached_
    buildings_index's own STRtree-build timeout on a cold cache, and
    genuinely fast (an in-memory STRtree query) on every request after.

    Same CSRF-safety posture as every other flood-model endpoint
    (authentication_classes/permission_classes both emptied — see
    FloodModelRunView/module docstring for the full reasoning)."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [FloodModelBuildingsViewThrottle]

    def get(self, request):
        catchment_key = (request.GET.get("catchment") or "").strip()
        if catchment_key not in flood_model.PILOT_CATCHMENTS:
            return JsonResponse(
                {"error": f"Unknown catchment {catchment_key!r} - known: {list(flood_model.PILOT_CATCHMENTS)}"},
                status=400,
            )

        bbox_raw = (request.GET.get("bbox") or "").strip()
        try:
            parts = [float(v) for v in bbox_raw.split(",")]
            if len(parts) != 4:
                raise ValueError("bbox must have exactly 4 components")
            req_minx, req_miny, req_maxx, req_maxy = parts
            if req_minx >= req_maxx or req_miny >= req_maxy:
                raise ValueError("bbox min must be less than max on both axes")
        except (ValueError, TypeError):
            return JsonResponse({"error": "bbox must be 'minx,miny,maxx,maxy' in WGS84."}, status=400)

        # Clamp to the catchment's own bbox — never trust a client-
        # supplied viewport blindly, even though the frontend only ever
        # sends the current map view.
        cat_minx, cat_miny, cat_maxx, cat_maxy = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]
        minx = max(req_minx, cat_minx)
        miny = max(req_miny, cat_miny)
        maxx = min(req_maxx, cat_maxx)
        maxy = min(req_maxy, cat_maxy)
        if minx >= maxx or miny >= maxy:
            # Requested viewport doesn't overlap this catchment at all —
            # a real, expected case (e.g. the map panned away), not an
            # error.
            return JsonResponse({"type": "FeatureCollection", "features": []})

        if (maxx - minx) > _BUILDINGS_VIEWPORT_MAX_DEGREES or (maxy - miny) > _BUILDINGS_VIEWPORT_MAX_DEGREES:
            return JsonResponse(
                {"error": "Requested viewport is too large for the individual-buildings layer - zoom in further."},
                status=400,
            )

        try:
            zones_result = flood_model.build_ahp_zone_geometries(catchment_key, lite=True, force=False)
            from shapely.geometry import shape as shapely_shape
            zone_geoms = {
                feat["properties"]["zone_class"]: shapely_shape(feat["geometry"])
                for feat in zones_result["geojson"]["features"]
            }
            payload = flood_exposure.get_buildings_in_viewport(catchment_key, (minx, miny, maxx, maxy), zone_geoms)
        except Exception:
            logger.warning(
                "flood_model_views: buildings-in-view failed for catchment=%r bbox=%r "
                "- degrading to an empty layer rather than a 500 (this is a visual "
                "nice-to-have, not core hazard data)",
                catchment_key, (minx, miny, maxx, maxy), exc_info=True,
            )
            return JsonResponse({"type": "FeatureCollection", "features": [], "degraded": True})

        return JsonResponse(payload)


@method_decorator(csrf_exempt, name="dispatch")
class FloodModelPrewarmCustomAoiView(APIView):
    """POST /api/flood-model/prewarm-custom-aoi/ {"bbox": [...],
    "flood_type": "flash", "polygon": {...}}

    §0.37 — a real, safe fire-and-forget prewarm, called by the frontend
    right after a user finishes drawing a custom-AOI polygon (well
    before they click "Run"). Registers the AOI (flood_model.register_
    custom_aoi — fast, no network, idempotent) then TRIGGERS the
    coalescing-safe Overture buildings fetch (flood_exposure.
    _submit_coalesced) WITHOUT ever calling .result() on it — this
    request returns immediately regardless of how long the real S3 scan
    takes. The real "Run" job's own LATER call to flood_exposure.fetch_
    overture_buildings_exposure (unchanged) will find this SAME future
    already registered under the SAME catchment_key and join it,
    waiting only the REMAINING time (or find the cache already fully
    warm) — NOT resubmit and redo the whole slow scan, the real race
    this whole mechanism exists to avoid (see _submit_coalesced's own
    docstring for the full account).

    Deliberately does NOT ALSO prewarm the HAND/DEM pipeline — that
    exact same class of race exists there too (confirmed during this
    same investigation) but isn't wired through the coalescing registry
    yet; prewarming it here would risk the identical double-fetch
    problem this endpoint exists to prevent. Overture alone is still
    the dominant real cost (confirmed live: ~225-270s, once ~6 minutes
    for a genuinely new custom AOI, versus HAND's own few-second-to-
    ~2-minute range) — the highest-value, lowest-risk piece to prewarm.

    A pure optimization, never required for correctness — the real Run
    flow works identically (just slower) whether or not this was ever
    called, or if it fails for any reason. No response body is load-
    bearing for anything; the caller can safely ignore failures."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [FloodModelPrewarmThrottle]

    def post(self, request):
        try:
            body = json.loads(request.body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JsonResponse({"error": "Malformed JSON body."}, status=400)

        bbox_raw = body.get("bbox")
        if not (isinstance(bbox_raw, list) and len(bbox_raw) == 4):
            return JsonResponse({"error": "'bbox' must be [minLon, minLat, maxLon, maxLat]."}, status=400)
        try:
            bbox = [float(v) for v in bbox_raw]
        except (TypeError, ValueError):
            return JsonResponse({"error": "'bbox' values must all be numbers."}, status=400)

        flood_type = body.get("flood_type", "flash")
        if flood_type not in ("flash", "riverine"):
            flood_type = "flash"

        polygon_raw = body.get("polygon")
        polygon_geojson = (
            polygon_raw if isinstance(polygon_raw, dict) and polygon_raw.get("type") in ("Polygon", "MultiPolygon")
            else None
        )

        try:
            catchment_key = flood_model.register_custom_aoi(
                bbox, flood_type=flood_type, polygon_geojson=polygon_geojson,
            )
        except ValueError as e:
            return JsonResponse({"error": str(e)}, status=400)

        try:
            flood_exposure._submit_coalesced(
                flood_exposure._OVERTURE_EXECUTOR, catchment_key,
                flood_exposure._fetch_overture_buildings_raw, tuple(bbox),
            )
        except Exception:
            # A prewarm is a pure optimization — never let a failure to
            # even SUBMIT the background work turn into a 500 for what
            # the frontend treats as a fire-and-forget call.
            logger.warning(
                "flood_model_views: prewarm submission failed for %r (non-fatal — "
                "the real Run job will simply do its own full fetch)",
                catchment_key, exc_info=True,
            )

        return JsonResponse({"catchment": catchment_key, "status": "prewarming"}, status=202)
