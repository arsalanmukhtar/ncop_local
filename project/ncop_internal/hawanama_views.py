# project/ncop_internal/hawanama_views.py
# ---------------------------------------------------------------------------
# NCOP proxy endpoints for Hawanama (Pakistan Air Quality Initiative) air
# quality data — thin HTTP wrappers over hawanama_client.py, which owns
# every upstream URL, cache and fallback. Every JSON response carries a
# `metadata` block with the CC BY 4.0 attribution and stale flags; when
# Hawanama is down and nothing is cached, endpoints answer 503
# {"error": "data unavailable"} so map layers degrade instead of breaking.
#
#   GET /api/hawanama/stations/                     live stations (GeoJSON)
#   GET /api/hawanama/stations/<id>/history/        48 h + 30 day series
#   GET /api/hawanama/stations/daily/<date>/        daily station means (GeoJSON)
#   GET /api/hawanama/tiles/dates/                  dates with daily estimate tiles
#   GET /api/hawanama/tiles/<date>/<z>/<x>/<y>.png  daily PM2.5 estimate tile
#   GET /api/hawanama/point/?date=&lat=&lon=        estimate value at a point
#   GET /api/hawanama/forecast/                     forecast frames (image sources)
#   GET /api/hawanama/nowcast/                      station nowcast (GeoJSON)
#   GET /api/hawanama/fires/outlook/                smoke-source outlook (GeoJSON)
#   GET /api/hawanama/fires/season/?region=         rice-season fire statistics
#   GET /api/hawanama/health/                       upstream + cache freshness
#   GET /api/hawanama/watch/?days=7                 National Air Quality Watch story digest
# ---------------------------------------------------------------------------

import logging

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from rest_framework.exceptions import Throttled
from rest_framework.throttling import AnonRateThrottle
from rest_framework.views import APIView

from . import hawanama_client as hc

logger = logging.getLogger(__name__)

_UNAVAILABLE = {"error": "data unavailable", "attribution": hc.ATTRIBUTION}


class HawanamaApiThrottle(AnonRateThrottle):
    scope = "hawanama_api"


class HawanamaTileThrottle(AnonRateThrottle):
    scope = "hawanama_tiles"


def _json(payload, max_age=60, status=200):
    resp = JsonResponse(payload, status=status, json_dumps_params={"ensure_ascii": False})
    resp["Cache-Control"] = f"public, max-age={max_age}"
    return resp


class _HawanamaView(APIView):
    authentication_classes = []
    permission_classes = []
    throttle_classes = [HawanamaApiThrottle]
    max_age = 60

    def handle_data(self, fn, *args, **kwargs):
        try:
            return _json(fn(*args, **kwargs), self.max_age)
        except ValueError as e:
            return JsonResponse({"error": str(e)}, status=400)
        except hc.HawanamaUnavailable:
            return JsonResponse(_UNAVAILABLE, status=503)
        except Exception:
            logger.exception("hawanama_views: %s failed", type(self).__name__)
            return JsonResponse(_UNAVAILABLE, status=503)


class HawanamaStationsView(_HawanamaView):
    max_age = 120

    def get(self, request):
        return self.handle_data(hc.stations_geojson)


class HawanamaStationHistoryView(_HawanamaView):
    max_age = 300

    def get(self, request, station_id):
        try:
            hours = int(request.GET.get("hours", 48))
            days = int(request.GET.get("days", 30))
        except ValueError:
            return JsonResponse({"error": "hours/days must be integers"}, status=400)
        return self.handle_data(hc.station_history, station_id, hours=hours, days=days)


class HawanamaStationsDailyView(_HawanamaView):
    max_age = 3600

    def get(self, request, date):
        return self.handle_data(hc.stations_daily_geojson, date)


class HawanamaTileDatesView(_HawanamaView):
    max_age = 900

    def get(self, request):
        try:
            limit = int(request.GET.get("limit", 365))
        except ValueError:
            return JsonResponse({"error": "limit must be an integer"}, status=400)
        return self.handle_data(hc.tile_dates, limit)


class HawanamaTileView(APIView):
    authentication_classes = []
    permission_classes = []
    throttle_classes = [HawanamaTileThrottle]

    def handle_exception(self, exc):
        # Rate-limited: answer with an uncached transparent tile instead of
        # a 429, so the map shows a brief gap (re-requested on the next
        # pan/zoom) rather than a burst of tile-load errors.
        if isinstance(exc, Throttled):
            resp = HttpResponse(hc.empty_tile_png(), content_type="image/png")
            resp["Cache-Control"] = "no-store"
            return resp
        return super().handle_exception(exc)

    def get(self, request, date, z, x, y):
        try:
            png, immutable = hc.tile_png(date, int(z), int(x), int(y))
        except ValueError as e:
            return JsonResponse({"error": str(e)}, status=400)
        except hc.HawanamaUnavailable:
            # Transparent tile, briefly cached: the map shows a gap, not a
            # broken-image error, and retries within minutes.
            resp = HttpResponse(hc.empty_tile_png(), content_type="image/png")
            resp["Cache-Control"] = "public, max-age=120"
            return resp
        resp = HttpResponse(png, content_type="image/png")
        resp["Cache-Control"] = ("public, max-age=2592000, immutable" if immutable else "public, max-age=900")
        return resp


class HawanamaPointView(_HawanamaView):
    max_age = 3600

    def get(self, request):
        date, lat, lon = request.GET.get("date"), request.GET.get("lat"), request.GET.get("lon")
        if not (date and lat and lon):
            return JsonResponse({"error": "date, lat and lon are required"}, status=400)
        try:
            lat, lon = float(lat), float(lon)
        except ValueError:
            return JsonResponse({"error": "lat/lon must be numbers"}, status=400)
        return self.handle_data(hc.point_value, date, lat, lon)


class HawanamaForecastView(_HawanamaView):
    max_age = 300

    def get(self, request):
        def build_url(name):
            return f"{settings.MEDIA_URL}{hc._FORECAST_SUBDIR}/{name}"
        return self.handle_data(hc.forecast_frames, build_url)


class HawanamaNowcastView(_HawanamaView):
    max_age = 300

    def get(self, request):
        return self.handle_data(hc.nowcast_geojson)


class HawanamaFiresOutlookView(_HawanamaView):
    max_age = 600

    def get(self, request):
        return self.handle_data(hc.fires_outlook_geojson)


class HawanamaFireSeasonView(_HawanamaView):
    max_age = 3600

    def get(self, request):
        return self.handle_data(hc.fire_season, request.GET.get("region", "punjab"), request.GET.get("season", "rice"))


class HawanamaHealthView(_HawanamaView):
    max_age = 30

    def get(self, request):
        return self.handle_data(hc.health)


class HawanamaWatchView(_HawanamaView):
    max_age = 300

    def get(self, request):
        return self.handle_data(hc.air_quality_watch, request.GET.get("days", "7"))
