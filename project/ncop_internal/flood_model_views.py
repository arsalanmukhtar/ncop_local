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
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import flood_exposure, flood_model

logger = logging.getLogger(__name__)

_JOB_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="flood-model-job")
_JOB_LOCK = threading.Lock()
_JOBS = {}  # job_id (str) -> dict, see _run_flood_model_job for the shape

_JOB_TTL_SECONDS = 3600
_MAX_TRACKED_JOBS = 200

_MIN_THRESHOLD_M = 0.1
_MAX_THRESHOLD_M = 50.0  # generous — Phase 1's own testing only ever explored 2-8m


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


def _run_flood_model_job(job_id, catchment_key, threshold_m):
    """Runs entirely inside _JOB_EXECUTOR's worker thread — never called
    directly from a request-handling thread. Calls flood_model.py/
    flood_exposure.py exactly as they already exist (build_exposure_
    report's new progress_callback parameter is optional/additive — see
    its own docstring — every OTHER caller still passes nothing and
    behaves identically); this is a thin orchestration wrapper only."""
    with _JOB_LOCK:
        if job_id not in _JOBS:
            return  # purged before it got a chance to run — nothing to update
        _JOBS[job_id]["status"] = "running"
        _JOBS[job_id]["started_at"] = time.time()
    try:
        _mark_stage(job_id, "Fetching elevation & computing terrain hydrology (HAND)")
        zone_payload = flood_model.render_flood_prone_zones(catchment_key, threshold_m=threshold_m)
        exposure_payload = flood_exposure.build_exposure_report(
            catchment_key, threshold_m=threshold_m,
            progress_callback=lambda stage: _mark_stage(job_id, stage),
        )
        result = {"flood_zone": zone_payload, "exposure": exposure_payload}
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


class FloodModelRunThrottle(AnonRateThrottle):
    scope = "flood_model_run"


class FloodModelStatusThrottle(AnonRateThrottle):
    scope = "flood_model_status"


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
        if not catchment_key or catchment_key not in flood_model.PILOT_CATCHMENTS:
            return JsonResponse(
                {"error": f"Unknown or missing 'catchment' — known: {list(flood_model.PILOT_CATCHMENTS)}"},
                status=400,
            )

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

        # Validation passed — NOW the request is actually going to submit
        # a real, expensive job, so the throttle budget applies from here
        # on. self.check_throttles() raises rest_framework.exceptions.
        # Throttled on failure, which dispatch()'s own exception handling
        # (post() runs inside the same try/except block) converts to a
        # 429 exactly as if it had fired automatically — same production
        # behavior, just correctly scoped to real job submissions only.
        self.check_throttles(request)

        _purge_old_jobs()

        job_id = uuid.uuid4().hex
        with _JOB_LOCK:
            _JOBS[job_id] = {
                "status": "pending",
                "catchment": catchment_key,
                "threshold_m": threshold_m,
                "created_at": time.time(),
                "result": None,
                "error": None,
                "current_stage": None,
                "completed_stages": [],
            }
        _JOB_EXECUTOR.submit(_run_flood_model_job, job_id, catchment_key, threshold_m)

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

        payload = {
            "status": job["status"],
            "catchment": job["catchment"],
            "threshold_m": job["threshold_m"],
            "current_stage": job.get("current_stage"),
            "completed_stages": job.get("completed_stages", []),
        }
        if job["status"] == "done":
            payload["result"] = job["result"]
        elif job["status"] == "error":
            payload["error"] = job["error"]
        return JsonResponse(payload)
