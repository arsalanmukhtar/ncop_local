# project/ncop_internal/assistant_tools.py
# ---------------------------------------------------------------------------
# NCOP Assistant (Phase 3) — live-data tools. Each tool wraps an EXISTING
# view class's own .get() method rather than re-implementing its fetch/
# cache/parse logic — the assistant can never disagree with what a real map
# click on the same feature would show, and every fix/behavior change made
# to those views is automatically inherited here. `request=None` is safe
# for both wrapped views: neither NwfcRainfallReportAPIView.get nor
# HeatwaveMonitoringView.get reads anything off `request` (confirmed by
# reading both — no query-param access, no request.user, etc.), so calling
# them directly with a throwaway request is equivalent to a real HTTP GET
# hitting the same view, just skipping the URL-routing/WSGI round trip.
#
# Each tool's summarizer trims the view's full JSON payload down to the
# handful of fields actually useful for a chat answer — the raw rainfall
# report alone carries a per-station breakdown for every district in
# Pakistan; feeding all of that back into the LLM as a second turn would
# both cost far more tokens than the question warrants and bury the
# genuinely relevant numbers in noise.
# ---------------------------------------------------------------------------

import json
import logging

logger = logging.getLogger(__name__)

GET_RAINFALL_REPORT_TOOL = {
    "type": "function",
    "function": {
        "name": "get_rainfall_report",
        "description": (
            "Fetch NCOP's current NWFC Daily Rainfall report — total rainfall "
            "(mm), the wettest provinces/districts, and top individual stations "
            "for the most recent published day. Use this when the user asks "
            "about CURRENT or recent rainfall/precipitation totals, not what a "
            "layer generally shows."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
}

GET_HEATWAVE_MONITORING_TOOL = {
    "type": "function",
    "function": {
        "name": "get_heatwave_monitoring",
        "description": (
            "Fetch NCOP's live weather/heatwave monitoring snapshot — current "
            "temperature, humidity, and heatwave alert tier (Normal/Elevated/"
            "High/Severe/Extreme) for major Pakistani cities. Use this for ANY "
            "question about current weather/temperature/conditions in a "
            "specific city (pass `city`) or across the country generally "
            "(omit `city` — returns the hottest cities)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "A specific Pakistani city name to look up (e.g. 'Islamabad'). Omit to get the hottest cities overall instead.",
                },
            },
        },
    },
}

ALL_TOOLS = [GET_RAINFALL_REPORT_TOOL, GET_HEATWAVE_MONITORING_TOOL]
DATA_TOOL_NAMES = {"get_rainfall_report", "get_heatwave_monitoring"}


def _run_view_get(view_cls):
    """Calls an existing View/APIView's .get(None) directly — see module
    docstring for why a throwaway request is safe for the two views this
    is used with. Returns the parsed JSON body, or None on any failure
    (network/upstream errors already produce a JsonResponse from the view
    itself, e.g. NwfcRainfallReportAPIView's own 502 fallback — this just
    guards against something unexpected, like a non-JSON response)."""
    try:
        response = view_cls().get(None)
        return json.loads(response.content)
    except Exception:
        logger.exception("assistant_tools: %s.get() failed", view_cls.__name__)
        return None


def run_get_rainfall_report(_args):
    from .views import NwfcRainfallReportAPIView
    data = _run_view_get(NwfcRainfallReportAPIView)
    if not data:
        return {"error": "Rainfall report is currently unavailable."}
    if data.get("error"):
        return {"error": data["error"]}
    return {
        "date": data.get("date"),
        "total_mm": data.get("total_mm"),
        "top_stations": (data.get("top_stations") or [])[:8],
        "provinces_multiday": (data.get("provinces_multiday") or [])[:8],
        "nil_provinces": data.get("nil_provinces"),
        "window_hours": data.get("window_hours"),
        "stale": bool(data.get("_stale")),
    }


def run_get_heatwave_monitoring(args):
    from .views import HeatwaveMonitoringView
    data = _run_view_get(HeatwaveMonitoringView)
    if not data or not data.get("features"):
        return {"error": "Heatwave/weather monitoring data is currently unavailable."}

    cities = []
    for feat in data["features"]:
        props = feat.get("properties") or {}
        cities.append({
            "name": props.get("name"),
            "temperature_c": props.get("temperature"),
            "feels_like_c": props.get("apparent_temperature"),
            "humidity_pct": props.get("humidity"),
            # The view's own field is "alert_level", not "alert" — matched
            # exactly here (was previously reading a key that never existed
            # in the view's response, silently returning None for every city).
            "alert": props.get("alert_level"),
        })

    requested_city = (args.get("city") or "").strip().lower()
    if requested_city:
        # Substring match against the FULL list — a specific city the user
        # actually asked about must never be silently dropped just because
        # it isn't among the hottest N right now (that's what previously
        # produced "Islamabad isn't among the cities returned", when it was
        # actually in the source data, just outside the hottest-15 cut).
        matches = [c for c in cities if c["name"] and requested_city in c["name"].lower()]
        if matches:
            return {"requested_city": requested_city, "matches": matches}
        return {"error": f"No live data for a city matching \"{args.get('city')}\".", "requested_city": requested_city}

    # No specific city asked about — hottest first, most likely what a
    # general "current heatwave conditions" question wants surfaced.
    cities.sort(key=lambda c: c["temperature_c"] if isinstance(c["temperature_c"], (int, float)) else -999, reverse=True)
    return {"cities": cities[:15], "total_cities_monitored": len(cities)}


TOOL_EXECUTORS = {
    "get_rainfall_report": run_get_rainfall_report,
    "get_heatwave_monitoring": run_get_heatwave_monitoring,
}
