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
#
# get_pmd_daily_forecast follows the exact same "wrap an existing view"
# shape (PmdDailyForecastProAPIView, NCOP-native). get_ffd_bulletins /
# get_nwfc_weekly_outlook cover data NCOP's OWN backend never independently
# fetches — the PMD tab's browser JS (weather-report-control.js, via
# gcop-api-cache.js) pulls it directly from GCOP, cross-origin, with no
# NCOP Django view in between. Rather than inventing a new server-side
# integration, both reuse the ONE existing precedent for a backend-side
# GCOP call already living in this codebase — NwfcRainfallReportAPIView's
# own `_RAINFALL_GCOP_BASE_URL` (views.py) — hitting the identical GCOP
# endpoint URLs the frontend already calls, never a new upstream source.
# ---------------------------------------------------------------------------

import json
import logging
import re

logger = logging.getLogger(__name__)

_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(text):
    """Collapses a raw HTML fragment (e.g. PmdDailyForecastProAPIView's
    per-province `text` field) down to plain prose for the LLM — tags
    stripped, common entities unescaped, whitespace collapsed."""
    text = _HTML_TAG_RE.sub(" ", text or "")
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    return " ".join(text.split())


_GCOP_TIMEOUT = 15  # matches NwfcRainfallReportAPIView's own TIMEOUT for the same host


def _run_gcop_get(path):
    """GET `{GCOP_BASE_URL}{path}` server-side — same GCOP host/paths the
    frontend already calls directly (see gcop-api-cache.js), reusing
    NwfcRainfallReportAPIView's already-proven `_RAINFALL_GCOP_BASE_URL`
    constant rather than hardcoding a second copy of it. Returns the
    parsed JSON body, or None on any failure (timeout, unreachable host,
    non-JSON response) — GCOP is a separate live system this dev
    environment may not always reach, so every caller must degrade
    gracefully, same convention as `_run_view_get`."""
    try:
        import requests
        from .views import _RAINFALL_GCOP_BASE_URL
        r = requests.get(f"{_RAINFALL_GCOP_BASE_URL}{path}", timeout=_GCOP_TIMEOUT)
        r.raise_for_status()
        return r.json()
    except Exception:
        logger.exception("assistant_tools: GCOP GET %s failed", path)
        return None

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

GET_PMD_DAILY_FORECAST_TOOL = {
    "type": "function",
    "function": {
        "name": "get_pmd_daily_forecast",
        "description": (
            "Fetch PMD's current provincial daily forecast — a short narrative "
            "forecast for each of Pakistan's provinces/regions (Punjab, Sindh, "
            "KPk, Balochistan, GB, Kashmir, Islamabad). Use this for questions "
            "about the general weather forecast/outlook for a province or the "
            "country, as distinct from a specific city's live conditions "
            "(get_heatwave_monitoring) or current rainfall totals "
            "(get_rainfall_report)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "province": {
                    "type": "string",
                    "description": "A specific province/region (e.g. 'Punjab', 'Sindh', 'KPk', 'Balochistan', 'GB', 'Kashmir', 'Islamabad'). Omit for all provinces.",
                },
            },
        },
    },
}

GET_FFD_BULLETINS_TOOL = {
    "type": "function",
    "function": {
        "name": "get_ffd_bulletins",
        "description": (
            "Fetch the Flood Forecasting Division's (FFD, ffd.pmd.gov.pk) most "
            "recent flood bulletins and advisories — river/barrage flood-level "
            "warnings and outlook text. Use this when the user asks about flood "
            "bulletins, FFD advisories, or barrage/river flood status/warnings."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
}

GET_NWFC_WEEKLY_OUTLOOK_TOOL = {
    "type": "function",
    "function": {
        "name": "get_nwfc_weekly_outlook",
        "description": (
            "Fetch NWFC's published day-by-day weekly hazard outlook (rain/"
            "wind/thundershower/heat expectations by region, several days "
            "ahead). Use this for questions about the outlook/forecast over "
            "the COMING WEEK, as distinct from today's live conditions or the "
            "current daily forecast."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
}

GET_WEATHER_FORECAST_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather_forecast",
        "description": (
            "Fetch a multi-day (up to 16-day) daily weather forecast — max/min "
            "temperature and precipitation — for a specific Pakistani city. "
            "Use this for ANY forward-looking question about a city's weather "
            "over the next several days (e.g. 'what will the weather in "
            "Lahore be like this week'), as distinct from get_heatwave_monitoring "
            "(today's live/current conditions only)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "A specific Pakistani city name (e.g. 'Islamabad'). Required.",
                },
                "days": {
                    "type": "integer",
                    "description": "How many days ahead to return (1-16). Defaults to 5.",
                },
            },
            "required": ["city"],
        },
    },
}

ALL_TOOLS = [
    GET_RAINFALL_REPORT_TOOL,
    GET_HEATWAVE_MONITORING_TOOL,
    GET_PMD_DAILY_FORECAST_TOOL,
    GET_FFD_BULLETINS_TOOL,
    GET_NWFC_WEEKLY_OUTLOOK_TOOL,
    GET_WEATHER_FORECAST_TOOL,
]
DATA_TOOL_NAMES = {
    "get_rainfall_report",
    "get_heatwave_monitoring",
    "get_pmd_daily_forecast",
    "get_ffd_bulletins",
    "get_nwfc_weekly_outlook",
    "get_weather_forecast",
}


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
        # The source PDF this report was parsed from — lets the assistant
        # point the user at the actual document, not just the numbers
        # pulled out of it.
        "pdf_url": data.get("source_url"),
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
        coords = ((feat.get("geometry") or {}).get("coordinates")) or [None, None]
        cities.append({
            "name": props.get("name"),
            "temperature_c": props.get("temperature"),
            "feels_like_c": props.get("apparent_temperature"),
            "humidity_pct": props.get("humidity"),
            # The view's own field is "alert_level", not "alert" — matched
            # exactly here (was previously reading a key that never existed
            # in the view's response, silently returning None for every city).
            "alert": props.get("alert_level"),
            # GeoJSON order is [lon, lat] — kept private (not surfaced to the
            # LLM's summary below) purely to build map_location for a single
            # unambiguous match, below.
            "_lon": coords[0], "_lat": coords[1],
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
            result = {
                "requested_city": requested_city,
                "matches": [{k: v for k, v in c.items() if not k.startswith("_")} for c in matches],
            }
            # Only fly the map when the request resolved to exactly ONE
            # city — flying to an arbitrary pick among several ambiguous
            # matches would be more confusing than not moving the camera.
            if len(matches) == 1 and matches[0]["_lat"] is not None:
                result["map_location"] = {"name": matches[0]["name"], "lat": matches[0]["_lat"], "lon": matches[0]["_lon"]}
            return result
        return {"error": f"No live data for a city matching \"{args.get('city')}\".", "requested_city": requested_city}

    # No specific city asked about — hottest first, most likely what a
    # general "current heatwave conditions" question wants surfaced. No
    # map_location here — a 15-city list has no single unambiguous place
    # to fly the camera to.
    cities.sort(key=lambda c: c["temperature_c"] if isinstance(c["temperature_c"], (int, float)) else -999, reverse=True)
    visible = [{k: v for k, v in c.items() if not k.startswith("_")} for c in cities[:15]]
    return {"cities": visible, "total_cities_monitored": len(cities)}


def run_get_pmd_daily_forecast(args):
    from .views import PmdDailyForecastProAPIView
    data = _run_view_get(PmdDailyForecastProAPIView)
    if not data:
        return {"error": "PMD daily forecast is currently unavailable."}

    provinces = [p for p in (data.get("provinces") or []) if not p.get("empty")]
    requested = (args.get("province") or "").strip().lower()
    if requested:
        matches = [p for p in provinces if requested in (p.get("title") or "").lower()]
        if not matches:
            return {"error": f"No forecast text for a province matching \"{args.get('province')}\".", "requested_province": requested}
        provinces = matches

    return {
        "generated_at": data.get("generated_at"),
        "provinces": [
            {"title": p.get("title"), "forecast": _strip_html(p.get("text"))}
            for p in provinces
        ],
    }


def run_get_ffd_bulletins(_args):
    data = _run_gcop_get("/get-ffd-bulletins/")
    items = (data or {}).get("items") or []
    if not items:
        return {"error": "FFD bulletins are currently unavailable."}

    bulletins = []
    for it in items[:8]:
        bulletins.append({
            # Same field-name fallback chain weather-report-control.js's own
            # #reportLinkRow already uses for this exact data — GCOP's shape
            # isn't perfectly uniform across item kinds.
            "title": it.get("title") or it.get("name") or it.get("subject") or "FFD Bulletin",
            "date": it.get("issued") or it.get("date") or it.get("published") or "",
            "kind": it.get("kind") or "bulletin",
            "url": it.get("url") or it.get("download_url") or it.get("link") or "",
        })
    return {"bulletins": bulletins}


def run_get_nwfc_weekly_outlook(_args):
    data = _run_gcop_get("/api/pmd/nwfc/weekly-outlook/")
    days = (data or {}).get("days") or []
    if not days:
        return {"error": "NWFC weekly outlook is currently unavailable."}

    return {
        "issue_date": (data or {}).get("issue_date"),
        "days": [
            {"date": d.get("date"), "outlook": d.get("outlook")}
            for d in days[:7]
        ],
    }


def run_get_weather_forecast(args):
    """Wraps the EXISTING HeatwaveDetailView(type=forecast) — the same
    Open-Meteo-backed 16-day forecast endpoint the heatwave popup charts
    on the map already call — rather than adding a second, separate
    Open-Meteo integration. That view reads lat/lon off request.GET, so
    (unlike the other _run_view_get-wrapped tools, whose views ignore
    `request` entirely) a real GET-style request is built via Django's own
    RequestFactory instead of passing None."""
    from .views import HeatwaveDetailView, PAKISTAN_HEATWAVE_CITIES

    city_query = (args.get("city") or "").strip().lower()
    if not city_query:
        return {"error": "A city name is required."}
    match = next((c for c in PAKISTAN_HEATWAVE_CITIES if city_query in c["name"].lower()), None)
    if not match:
        return {"error": f"No forecast location matching \"{args.get('city')}\" — try a major Pakistani city.", "requested_city": city_query}

    try:
        from django.test import RequestFactory
        request = RequestFactory().get("/", {"lat": match["lat"], "lon": match["lon"], "type": "forecast"})
        response = HeatwaveDetailView().get(request)
        data = json.loads(response.content)
    except Exception:
        logger.exception("assistant_tools: weather forecast fetch failed for %s", match["name"])
        return {"error": "Weather forecast is currently unavailable."}

    # HeatwaveDetailView wraps the upstream Open-Meteo payload one level
    # deeper, under "data" (see its own get(): returns {type, lat, lon,
    # data: {..., "daily": {...}}}) — confirmed live against the running
    # endpoint, not guessed from the URLS/params it builds.
    daily = ((data or {}).get("data") or {}).get("daily") or {}
    dates = daily.get("time") or []
    tmax = daily.get("temperature_2m_max") or []
    tmin = daily.get("temperature_2m_min") or []
    precip = daily.get("precipitation_sum") or []
    if not dates:
        return {"error": "Weather forecast is currently unavailable."}

    requested_days = args.get("days")
    n = requested_days if isinstance(requested_days, int) and 1 <= requested_days <= 16 else 5
    n = min(n, len(dates))

    return {
        "city": match["name"],
        "province": match.get("province"),
        "days": [
            {
                "date": dates[i],
                "temp_max_c": tmax[i] if i < len(tmax) else None,
                "temp_min_c": tmin[i] if i < len(tmin) else None,
                "precipitation_mm": precip[i] if i < len(precip) else None,
            }
            for i in range(n)
        ],
        "map_location": {"name": match["name"], "lat": match["lat"], "lon": match["lon"]},
    }


TOOL_EXECUTORS = {
    "get_rainfall_report": run_get_rainfall_report,
    "get_heatwave_monitoring": run_get_heatwave_monitoring,
    "get_pmd_daily_forecast": run_get_pmd_daily_forecast,
    "get_ffd_bulletins": run_get_ffd_bulletins,
    "get_nwfc_weekly_outlook": run_get_nwfc_weekly_outlook,
    "get_weather_forecast": run_get_weather_forecast,
}
