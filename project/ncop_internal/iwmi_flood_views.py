# project/ncop_internal/iwmi_flood_views.py
# ---------------------------------------------------------------------------
# NCOP proxy endpoints for IWMI ENSO Outlook flood forecasting (GloFAS
# reference points + Google Flood Hub) — thin wrappers over
# iwmi_flood_client.py, which owns every upstream URL, cache, enrichment
# and fallback. Every response carries attribution and stale flags; when
# IWMI is down and nothing is cached, endpoints answer 503
# {"error": "data unavailable"} so map layers degrade instead of breaking.
#
#   GET /api/iwmi/glofas/points/                   GloFAS flood-alert points (GeoJSON)
#   GET /api/iwmi/glofas/points/<id>/discharge/    one point's 45-day series
#   GET /api/iwmi/glofas/forecast-days/            per-forecast-day status (slider)
#   GET /api/iwmi/floodhub/gauges/?low_confidence= Flood Hub gauges (GeoJSON)
#   GET /api/iwmi/floodhub/gauges/<id>/discharge/  gauge history + forecast
#   GET /api/iwmi/floodhub/inundation/             inundation polygons (GeoJSON)
#   GET /api/iwmi/status/                          per-country summary
#   GET /api/iwmi/health/                          cache state
# ---------------------------------------------------------------------------

import logging

from django.http import JsonResponse
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import iwmi_flood_client as ic
from .cached_fetch import Unavailable

logger = logging.getLogger(__name__)


class IwmiFloodThrottle(AnonRateThrottle):
    scope = "iwmi_flood_api"


class _IwmiView(APIView):
    authentication_classes = []
    permission_classes = []
    throttle_classes = [IwmiFloodThrottle]
    max_age = 120

    def handle_data(self, fn, *args, **kwargs):
        try:
            payload = fn(*args, **kwargs)
        except ValueError as e:
            return JsonResponse({"error": str(e)}, status=400)
        except Unavailable:
            return JsonResponse({"error": "data unavailable"}, status=503)
        except Exception:
            logger.exception("iwmi_flood_views: %s failed", type(self).__name__)
            return JsonResponse({"error": "data unavailable"}, status=503)
        resp = JsonResponse(payload, json_dumps_params={"ensure_ascii": False})
        resp["Cache-Control"] = f"public, max-age={self.max_age}"
        return resp


class IwmiGlofasPointsView(_IwmiView):
    max_age = 300

    def get(self, request):
        return self.handle_data(ic.glofas_points_geojson)


class IwmiGlofasPointDischargeView(_IwmiView):
    max_age = 900

    def get(self, request, point_id):
        return self.handle_data(ic.glofas_point_discharge, point_id)


class IwmiGlofasForecastDaysView(_IwmiView):
    max_age = 300

    def get(self, request):
        return self.handle_data(ic.glofas_forecast_days_geojson)


class IwmiFloodhubGaugesView(_IwmiView):
    max_age = 300

    def get(self, request):
        low_conf = request.GET.get("low_confidence", "false").lower() in ("1", "true", "yes")
        return self.handle_data(ic.floodhub_gauges_geojson, include_low_confidence=low_conf)


class IwmiFloodhubGaugeDischargeView(_IwmiView):
    max_age = 600

    def get(self, request, gauge_id):
        return self.handle_data(ic.floodhub_gauge_discharge, gauge_id)


class IwmiFloodhubInundationView(_IwmiView):
    max_age = 300

    def get(self, request):
        return self.handle_data(ic.floodhub_inundation_geojson)


class IwmiStatusView(_IwmiView):
    max_age = 300

    def get(self, request):
        return self.handle_data(ic.regional_status)


class IwmiHealthView(_IwmiView):
    max_age = 30

    def get(self, request):
        return self.handle_data(ic.health)
