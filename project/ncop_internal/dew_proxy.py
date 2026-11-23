# project/ncop_internal/dew_proxy.py
# ---------------------------------------------------------------------------
# Same-origin pass-through for the DEW (Disaster Early Warning) exposures
# service, which runs on a separate internal host (DEW_EXPOSURES_URL).
#
# The browser used to call that host directly; when it is down every open of
# the "DEW Exposures" dropdown logged `net::ERR_CONNECTION_REFUSED` (browsers
# always log refused connections; page code cannot silence them). Going
# through NCOP's own server keeps the browser talking to one origin only:
#
#   GET /api/dew/exposures/                    list of exposures (array)
#   GET /api/dew/exposures/?exposure_id=<id>   one exposure (GeoJSON)
#
# Upstream responses are passed through unchanged (status, body, type).
# When the upstream host is unreachable the list answers 200 [] with
# `X-NCOP-Upstream: unavailable` (the sidebar shows "service unavailable"),
# and a short outage memo answers repeat requests instantly instead of
# waiting on the dead host again.
# ---------------------------------------------------------------------------

import logging
import time

import requests
from django.conf import settings
from django.http import HttpResponse, JsonResponse
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

logger = logging.getLogger(__name__)

_TIMEOUT = (3.0, 20.0)          # connect, read
_OUTAGE_MEMO_S = 30             # don't retry a dead host more often than this
_state = {"down_until": 0.0}


def upstream_url():
    return getattr(settings, "DEW_EXPOSURES_URL", "http://172.18.1.108:8000/get-exposures/")


class DewThrottle(AnonRateThrottle):
    scope = "dew_api"


def _unavailable(is_list):
    if is_list:
        resp = JsonResponse([], safe=False)
    else:
        resp = JsonResponse({"error": "DEW exposures service unavailable"}, status=503)
    resp["X-NCOP-Upstream"] = "unavailable"
    resp["Cache-Control"] = "no-store"
    return resp


class DewExposuresView(APIView):
    authentication_classes = []
    permission_classes = []
    throttle_classes = [DewThrottle]

    def get(self, request):
        exposure_id = request.GET.get("exposure_id")
        is_list = not exposure_id
        if exposure_id is not None and not str(exposure_id).strip().isalnum():
            return JsonResponse({"error": "invalid exposure_id"}, status=400)
        if time.time() < _state["down_until"]:
            return _unavailable(is_list)
        try:
            r = requests.get(upstream_url(), params={"exposure_id": exposure_id} if exposure_id else None, timeout=_TIMEOUT)
        except requests.RequestException as e:
            _state["down_until"] = time.time() + _OUTAGE_MEMO_S
            logger.warning("dew_proxy: upstream unreachable (%s)", type(e).__name__)
            return _unavailable(is_list)
        _state["down_until"] = 0.0
        resp = HttpResponse(r.content, status=r.status_code,
                            content_type=r.headers.get("Content-Type", "application/json"))
        resp["Cache-Control"] = "no-store"
        return resp
