# project/ncop_internal/gefs_views.py
# ---------------------------------------------------------------------------
# NCOP endpoints for the NOAA GEFS 35-day outlook layers — thin wrappers
# over gefs_client.py, which owns download, aggregation, rendering and the
# on-disk run cache. Requests only ever read a built run; when none exists
# yet a background build starts and the API answers 202 {"status":
# "building"} (the frontend loader retries), so no request waits on NOAA.
#
#   GET /api/gefs/frames/?var=precip|t2m       35 daily frames (image sources)
#   GET /api/gefs/point/?var=&day=&lat=&lon=   value at a point for one day
#   GET /api/gefs/health/                      built runs + build state
#   GET /api/gefs/districts/?var=precip|t2m    35-day values per district of Pakistan
# ---------------------------------------------------------------------------

import logging

from django.conf import settings
from django.http import JsonResponse
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import gefs_calibration as gcal
from . import gefs_client as gc
from . import gefs_districts as gd

logger = logging.getLogger(__name__)


class GefsThrottle(AnonRateThrottle):
    scope = "gefs_api"


class _GefsView(APIView):
    authentication_classes = []
    permission_classes = []
    throttle_classes = [GefsThrottle]
    max_age = 300

    def respond(self, fn, *args):
        try:
            resp = JsonResponse(fn(*args), json_dumps_params={"ensure_ascii": False})
            resp["Cache-Control"] = f"public, max-age={self.max_age}"
            return resp
        except ValueError as e:
            return JsonResponse({"error": str(e)}, status=400)
        except gc.GefsUnavailable:
            gc.refresh_async()
            resp = JsonResponse({"status": "building", "retry_after": 15,
                                 "detail": "The GEFS outlook is being prepared; retry shortly."}, status=202)
            resp["Retry-After"] = "15"
            resp["Cache-Control"] = "no-store"
            return resp
        except gd.DistrictsUnavailable:
            raise                                   # GefsDistrictsView answers 202/503 itself
        except Exception:
            logger.exception("gefs_views: %s failed", type(self).__name__)
            return JsonResponse({"error": "data unavailable"}, status=503)


class GefsFramesView(_GefsView):
    def get(self, request):
        def build_url(name):
            return f"{settings.MEDIA_URL}{gc._SUBDIR}/{name}"
        return self.respond(gc.frames, request.GET.get("var", "precip"), build_url)


class GefsPointView(_GefsView):
    max_age = 600

    def get(self, request):
        q = request.GET
        if not all(q.get(k) for k in ("var", "day", "lat", "lon")):
            return JsonResponse({"error": "var, day, lat and lon are required"}, status=400)
        try:
            day, lat, lon = int(q["day"]), float(q["lat"]), float(q["lon"])
        except ValueError:
            return JsonResponse({"error": "day must be an integer, lat/lon numbers"}, status=400)
        return self.respond(gc.point_value, q["var"], day, lat, lon)


class GefsHealthView(_GefsView):
    max_age = 30

    def get(self, request):
        return self.respond(lambda: {**gc.health(), "district_calibration": gcal.status()})


class GefsDistrictsView(_GefsView):
    """Area-weighted daily values for every district (gefs_districts.py).
    202 while the one-time district index is prepared, 503 if the district
    boundary service is unreachable (retried after a backoff)."""
    max_age = 600

    def get(self, request):
        try:
            return self.respond(gd.district_stats, request.GET.get("var", "precip"))
        except gd.DistrictsUnavailable as e:
            building = gd.index_building()
            resp = JsonResponse({"status": "building" if building else "unavailable", "retry_after": 15, "detail": str(e)},
                                status=202 if building else 503)
            resp["Retry-After"] = "15"
            resp["Cache-Control"] = "no-store"
            return resp
