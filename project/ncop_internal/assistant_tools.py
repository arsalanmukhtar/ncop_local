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


def _run_gcop_get(path, retries=2):
    """GET `{GCOP_BASE_URL}{path}` server-side — same GCOP host/paths the
    frontend already calls directly (see gcop-api-cache.js), reusing
    NwfcRainfallReportAPIView's already-proven `_RAINFALL_GCOP_BASE_URL`
    constant rather than hardcoding a second copy of it. Returns the
    parsed JSON body, or None on any failure (timeout, unreachable host,
    non-JSON response) — GCOP is a separate live system this dev
    environment may not always reach, so every caller must degrade
    gracefully, same convention as `_run_view_get`.

    GCOP is known to blip transiently (see gcop-api-cache.js's own
    retry-with-backoff on the frontend); a single failed attempt here
    used to surface as a hard "unavailable" even when the map's own
    client-side retries succeeded moments later, so this retries a
    couple of times with a short backoff before giving up."""
    import time
    import requests
    from .views import _RAINFALL_GCOP_BASE_URL
    url = f"{_RAINFALL_GCOP_BASE_URL}{path}"
    last_exc = None
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, timeout=_GCOP_TIMEOUT)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_exc = e
            if attempt < retries:
                time.sleep(0.6 * (attempt + 1))
    logger.exception("assistant_tools: GCOP GET %s failed after %d attempt(s)", path, retries + 1, exc_info=last_exc)
    return None


_WEATHER_GOV_PK_TIMEOUT = 15


def _cached_html_fetch(cache_key, ttl, url):
    """GET a weather.gov.pk HTML page, cached via Django's cache framework
    (same LocMemCache every other in-process cache in this app already
    uses — no new infra). These two tools are the only ones in this module
    that scrape a page rather than call a JSON API, so unlike the GCOP/
    Open-Meteo tools (already cheap, already cached upstream or trivially
    cheap to re-fetch) they're the ones actually worth NOT re-fetching on
    every single chat message. Returns the HTML text, or None on failure —
    never raises, same degrade-gracefully contract as every other fetch
    helper here."""
    from django.core.cache import cache
    hit = cache.get(cache_key)
    if hit is not None:
        return hit
    try:
        import requests
        r = requests.get(url, timeout=_WEATHER_GOV_PK_TIMEOUT)
        r.raise_for_status()
        html = r.text
        cache.set(cache_key, html, ttl)
        return html
    except Exception:
        logger.exception("assistant_tools: fetch failed for %s", url)
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

GET_AIR_QUALITY_TOOL = {
    "type": "function",
    "function": {
        "name": "get_air_quality",
        "description": (
            "Fetch current air quality and a multi-day (up to 5-day) AQI "
            "outlook for a specific Pakistani city — US AQI plus PM2.5, "
            "PM10, ozone, NO2, SO2, and CO. Use this for ANY question about "
            "air quality, pollution, smog, or AQI for a city, whether "
            "asking about right now or the coming days — this is a live "
            "data lookup, not a description of the WAQI-Stations/CAMS map "
            "layers (mention those too if relevant, but always answer the "
            "actual numbers via this tool first)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "A specific Pakistani city name (e.g. 'Lahore'). Required.",
                },
                "days": {
                    "type": "integer",
                    "description": "How many days ahead to include in the outlook (1-5). Defaults to 5.",
                },
            },
            "required": ["city"],
        },
    },
}

GET_SEASONAL_FORECAST_TOOL = {
    "type": "function",
    "function": {
        "name": "get_seasonal_forecast",
        "description": (
            "Fetch a longer-range seasonal outlook (weekly mean temperature "
            "trend, several months ahead) for a specific Pakistani city. Use "
            "this for questions about the outlook over the coming MONTHS/"
            "SEASON — clearly beyond the ~2-week horizon of "
            "get_weather_forecast — e.g. 'how will the weather trend over "
            "the next few months in Karachi'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "A specific Pakistani city name (e.g. 'Karachi'). Required.",
                },
                "weeks": {
                    "type": "integer",
                    "description": "How many weeks ahead to include (1-27, ~6 months max). Defaults to 12.",
                },
            },
            "required": ["city"],
        },
    },
}

GET_CLIMATE_OUTLOOK_TOOL = {
    "type": "function",
    "function": {
        "name": "get_climate_outlook",
        "description": (
            "Fetch a multi-year climate projection (yearly mean/max "
            "temperature and total precipitation, ~5 years ahead) for a "
            "specific Pakistani city — a long-range CLIMATE trend, not a "
            "weather forecast. Use this only for genuinely long-horizon "
            "questions ('how is the climate expected to change', 'multi-"
            "year outlook'), never for a normal forecast question."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "A specific Pakistani city name. Required.",
                },
            },
            "required": ["city"],
        },
    },
}

GET_PAKISTAN_CLIMATE_REPORTS_TOOL = {
    "type": "function",
    "function": {
        "name": "get_pakistan_climate_reports",
        "description": (
            "List PMD's official published yearly \"Pakistan Climate\" "
            "outlook report PDFs (weather.gov.pk/cdpc/pakistan-climate) — "
            "PMD's own authored national climate summary for each year. Use "
            "this when the user asks for PMD's official climate report/"
            "publication, as distinct from a live Open-Meteo forecast/"
            "projection (get_seasonal_forecast / get_climate_outlook)."
        ),
        "parameters": {"type": "object", "properties": {}},
    },
}

GET_NWFC_PRESS_RELEASES_TOOL = {
    "type": "function",
    "function": {
        "name": "get_nwfc_press_releases",
        "description": (
            "Fetch PMD/NWFC's most recent official press releases (weather "
            "advisories/warnings such as rain-wind, heat wave, cold wave, "
            "smog, tsunami — weather.gov.pk/nwfc/all-press-releases). Use "
            "this when the user asks about recent PMD press releases, "
            "official advisories/warnings, or 'what has PMD announced "
            "recently'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "count": {
                    "type": "integer",
                    "description": "How many recent releases to return (1-6). Defaults to 6.",
                },
            },
        },
    },
}

GET_FFD_WATERLEVELS_TOOL = {
    "type": "function",
    "function": {
        "name": "get_ffd_waterlevels",
        "description": (
            "Fetch live river/barrage gauge readings from the Flood "
            "Forecasting Division — current water level and flood status "
            "per station nationwide (the same live points the FFD Data map "
            "layer shows). Use this for ANY question about current flood "
            "conditions, river levels, or a specific barrage/station's "
            "status — pairs well with get_ffd_bulletins for the narrative "
            "advisory text."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "station": {
                    "type": "string",
                    "description": "A specific station/barrage/river name to filter to (e.g. 'Tarbela'). Omit to get all stations currently at an elevated/flood status, or the first several if none are elevated.",
                },
            },
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
    GET_AIR_QUALITY_TOOL,
    GET_SEASONAL_FORECAST_TOOL,
    GET_CLIMATE_OUTLOOK_TOOL,
    GET_PAKISTAN_CLIMATE_REPORTS_TOOL,
    GET_NWFC_PRESS_RELEASES_TOOL,
    GET_FFD_WATERLEVELS_TOOL,
]
DATA_TOOL_NAMES = {
    "get_rainfall_report",
    "get_heatwave_monitoring",
    "get_pmd_daily_forecast",
    "get_ffd_bulletins",
    "get_nwfc_weekly_outlook",
    "get_weather_forecast",
    "get_air_quality",
    "get_seasonal_forecast",
    "get_climate_outlook",
    "get_pakistan_climate_reports",
    "get_nwfc_press_releases",
    "get_ffd_waterlevels",
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


# Unlike get_weather_forecast (which reuses HeatwaveDetailView, an EXISTING
# server-side Open-Meteo integration), no view anywhere in this app wraps
# Open-Meteo's separate air-quality-api host — the map's own WAQI-Stations/
# CAMS AQI layers are a different source entirely (the real WAQI network /
# Copernicus CAMS rasters, not Open-Meteo), so there was nothing to reuse.
# This is a genuinely new, small, self-contained integration, following the
# exact same "resolve city via PAKISTAN_HEATWAVE_CITIES, group hourly data
# into a daily outlook, surface map_location for auto-zoom" shape every
# other tool here already uses.
_AQI_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
_AQI_TIMEOUT = 10


def _aqi_bucket(us_aqi):
    """US-EPA AQI bands — identical breakpoints to the map's own WAQI
    popup badges (frontend/src/modules/layer-attribute-popup.js's
    waqiAqiBin), so a number reported here always matches the label a
    station click on the map would show."""
    if not isinstance(us_aqi, (int, float)):
        return None
    if us_aqi <= 50: return "Good"
    if us_aqi <= 100: return "Moderate"
    if us_aqi <= 150: return "Unhealthy for Sensitive Groups"
    if us_aqi <= 200: return "Unhealthy"
    if us_aqi <= 300: return "Very Unhealthy"
    return "Hazardous"


def run_get_air_quality(args):
    from .views import PAKISTAN_HEATWAVE_CITIES

    city_query = (args.get("city") or "").strip().lower()
    if not city_query:
        return {"error": "A city name is required."}
    match = next((c for c in PAKISTAN_HEATWAVE_CITIES if city_query in c["name"].lower()), None)
    if not match:
        return {"error": f"No air-quality location matching \"{args.get('city')}\" — try a major Pakistani city.", "requested_city": city_query}

    requested_days = args.get("days")
    days = requested_days if isinstance(requested_days, int) and 1 <= requested_days <= 5 else 5

    try:
        import requests
        r = requests.get(_AQI_URL, params={
            "latitude": match["lat"], "longitude": match["lon"],
            "current": "us_aqi,pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone",
            "hourly": "us_aqi",
            "forecast_days": days,
            "timezone": "Asia/Karachi",
        }, timeout=_AQI_TIMEOUT)
        r.raise_for_status()
        data = r.json()
    except Exception:
        logger.exception("assistant_tools: air quality fetch failed for %s", match["name"])
        return {"error": "Air quality data is currently unavailable."}

    current = data.get("current") or {}
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    aqi_series = hourly.get("us_aqi") or []
    if not current and not times:
        return {"error": "Air quality data is currently unavailable."}

    # Open-Meteo's air-quality endpoint only ever returns HOURLY series (no
    # native daily block the way the main forecast API has) — grouped here
    # by calendar date, keeping each day's WORST (max) reading, since the
    # peak-pollution moment is the actionable number for a health-risk
    # outlook, not a smoothed average.
    daily_max = {}
    for t, v in zip(times, aqi_series):
        if not isinstance(v, (int, float)):
            continue
        date = t[:10]
        daily_max[date] = max(daily_max.get(date, v), v)

    return {
        "city": match["name"],
        "province": match.get("province"),
        "current": {
            "us_aqi":      current.get("us_aqi"),
            "category":    _aqi_bucket(current.get("us_aqi")),
            "pm2_5":       current.get("pm2_5"),
            "pm10":        current.get("pm10"),
            "ozone":       current.get("ozone"),
            "nitrogen_dioxide": current.get("nitrogen_dioxide"),
            "sulphur_dioxide":  current.get("sulphur_dioxide"),
            "carbon_monoxide":  current.get("carbon_monoxide"),
        },
        "days": [
            {"date": d, "max_us_aqi": v, "category": _aqi_bucket(v)}
            for d, v in sorted(daily_max.items())
        ][:days],
        "map_location": {"name": match["name"], "lat": match["lat"], "lon": match["lon"]},
    }


def run_get_seasonal_forecast(args):
    """Wraps HeatwaveDetailView(type=seasonal) — same existing view as
    get_weather_forecast, different `type`. Open-Meteo's seasonal API
    returns per-member ensemble arrays (temperature_2m_max_member01..17,
    …) alongside plain unsuffixed keys that are ALREADY the ensemble
    mean/control run (confirmed live against the real endpoint) — only
    those unsuffixed keys are used here, never the raw members, which
    would be meaningless noise in a chat answer."""
    from .views import HeatwaveDetailView, PAKISTAN_HEATWAVE_CITIES

    city_query = (args.get("city") or "").strip().lower()
    if not city_query:
        return {"error": "A city name is required."}
    match = next((c for c in PAKISTAN_HEATWAVE_CITIES if city_query in c["name"].lower()), None)
    if not match:
        return {"error": f"No forecast location matching \"{args.get('city')}\" — try a major Pakistani city.", "requested_city": city_query}

    try:
        from django.test import RequestFactory
        request = RequestFactory().get("/", {"lat": match["lat"], "lon": match["lon"], "type": "seasonal"})
        response = HeatwaveDetailView().get(request)
        data = json.loads(response.content)
    except Exception:
        logger.exception("assistant_tools: seasonal forecast fetch failed for %s", match["name"])
        return {"error": "Seasonal forecast is currently unavailable."}

    weekly = ((data or {}).get("data") or {}).get("weekly") or {}
    dates = weekly.get("time") or []
    temps = weekly.get("temperature_2m_mean") or []
    if not dates:
        return {"error": "Seasonal forecast is currently unavailable."}

    requested_weeks = args.get("weeks")
    n = requested_weeks if isinstance(requested_weeks, int) and 1 <= requested_weeks <= 27 else 12
    n = min(n, len(dates))

    return {
        "city": match["name"],
        "province": match.get("province"),
        "horizon_weeks_available": len(dates),
        "weeks": [
            {"week_starting": dates[i], "mean_temp_c": temps[i] if i < len(temps) else None}
            for i in range(n)
        ],
        "map_location": {"name": match["name"], "lat": match["lat"], "lon": match["lon"]},
    }


def run_get_climate_outlook(args):
    """Wraps HeatwaveDetailView(type=climate) — same existing view. The raw
    upstream response is ~1800 DAILY entries spanning ~5 years (confirmed
    live), far too much for a chat turn — aggregated here into one row per
    calendar YEAR (mean of daily means, mean of daily maxes, sum of daily
    precipitation), which is what "climate outlook" actually means as a
    question, versus a day-by-day weather forecast."""
    from .views import HeatwaveDetailView, PAKISTAN_HEATWAVE_CITIES

    city_query = (args.get("city") or "").strip().lower()
    if not city_query:
        return {"error": "A city name is required."}
    match = next((c for c in PAKISTAN_HEATWAVE_CITIES if city_query in c["name"].lower()), None)
    if not match:
        return {"error": f"No climate location matching \"{args.get('city')}\" — try a major Pakistani city.", "requested_city": city_query}

    try:
        from django.test import RequestFactory
        request = RequestFactory().get("/", {"lat": match["lat"], "lon": match["lon"], "type": "climate"})
        response = HeatwaveDetailView().get(request)
        data = json.loads(response.content)
    except Exception:
        logger.exception("assistant_tools: climate outlook fetch failed for %s", match["name"])
        return {"error": "Climate outlook is currently unavailable."}

    daily = ((data or {}).get("data") or {}).get("daily") or {}
    dates = daily.get("time") or []
    means = daily.get("temperature_2m_mean") or []
    maxes = daily.get("temperature_2m_max") or []
    precs = daily.get("precipitation_sum") or []
    if not dates:
        return {"error": "Climate outlook is currently unavailable."}

    by_year = {}  # year -> {"mean_sum":, "mean_n":, "max_sum":, "max_n":, "precip_sum":}
    for i, date in enumerate(dates):
        year = date[:4]
        bucket = by_year.setdefault(year, {"mean_sum": 0.0, "mean_n": 0, "max_sum": 0.0, "max_n": 0, "precip_sum": 0.0})
        if i < len(means) and isinstance(means[i], (int, float)):
            bucket["mean_sum"] += means[i]; bucket["mean_n"] += 1
        if i < len(maxes) and isinstance(maxes[i], (int, float)):
            bucket["max_sum"] += maxes[i]; bucket["max_n"] += 1
        if i < len(precs) and isinstance(precs[i], (int, float)):
            bucket["precip_sum"] += precs[i]

    years = [
        {
            "year": year,
            "avg_mean_temp_c": round(b["mean_sum"] / b["mean_n"], 1) if b["mean_n"] else None,
            "avg_max_temp_c":  round(b["max_sum"] / b["max_n"], 1) if b["max_n"] else None,
            "total_precipitation_mm": round(b["precip_sum"], 1),
        }
        for year, b in sorted(by_year.items())
    ]

    return {
        "city": match["name"],
        "province": match.get("province"),
        "model": "MRI-AGCM3.2S (Open-Meteo Climate API)",
        "years": years,
        "map_location": {"name": match["name"], "lat": match["lat"], "lon": match["lon"]},
    }


_CLIMATE_REPORTS_URL = "https://weather.gov.pk/cdpc/pakistan-climate"
_CLIMATE_REPORTS_CACHE_KEY = "assistant_pakistan_climate_reports"
_CLIMATE_REPORTS_TTL = 24 * 60 * 60  # published once a year — safe to cache generously
_CLIMATE_PDF_RE = re.compile(
    r'href="(https://weather\.gov\.pk/storage/uploads/cdpc/pakistan_climates/pdf/[^"]*Pakistan_Climate_(\d{4})[^"]*\.pdf)"'
)


def run_get_pakistan_climate_reports(_args):
    html = _cached_html_fetch(_CLIMATE_REPORTS_CACHE_KEY, _CLIMATE_REPORTS_TTL, _CLIMATE_REPORTS_URL)
    if html is None:
        return {"error": "PMD's Pakistan Climate report page is currently unavailable."}

    seen = {}
    for url, year in _CLIMATE_PDF_RE.findall(html):
        seen[year] = url  # last match for a given year wins — harmless if the page ever lists a year twice
    if not seen:
        return {"error": "No Pakistan Climate report PDFs found on the page."}

    reports = [{"year": y, "pdf_url": u} for y, u in sorted(seen.items(), reverse=True)]
    return {"reports": reports, "source_page": _CLIMATE_REPORTS_URL}


_PRESS_RELEASES_URL = "https://weather.gov.pk/nwfc/all-press-releases"
_PRESS_RELEASES_CACHE_KEY = "assistant_nwfc_press_releases"
_PRESS_RELEASES_TTL = 30 * 60  # PMD posts these roughly daily-to-weekly
# One "Archive Press Releases" sidebar entry: a link to the release, its
# title, and its date — confirmed against the real page's actual markup
# (fetched live during development), not guessed. The archive list is
# already newest-first on the page itself.
_PRESS_RELEASE_ITEM_RE = re.compile(
    r'href="(https://weather\.gov\.pk/nwfc/all-press-releases/\d+[^"]*)"[^>]*>.*?'
    r'<h6[^>]*>\s*(.*?)\s*</h6>.*?'
    r'<small[^>]*>\s*(.*?)\s*</small>',
    re.DOTALL,
)


def run_get_nwfc_press_releases(args):
    html = _cached_html_fetch(_PRESS_RELEASES_CACHE_KEY, _PRESS_RELEASES_TTL, _PRESS_RELEASES_URL)
    if html is None:
        return {"error": "NWFC press releases page is currently unavailable."}

    requested = args.get("count")
    n = requested if isinstance(requested, int) and 1 <= requested <= 6 else 6

    releases = []
    for url, title, date in _PRESS_RELEASE_ITEM_RE.findall(html):
        releases.append({
            "title": _strip_html(title),
            "date": _strip_html(date),
            "url": url,
        })
        if len(releases) >= n:
            break
    if not releases:
        return {"error": "No press releases found on the page."}

    return {"releases": releases, "source_page": _PRESS_RELEASES_URL}


def run_get_ffd_waterlevels(args):
    data = _run_gcop_get("/get-ffd-waterlevels/")
    features = (data or {}).get("features") or []
    if not features:
        return {"error": "FFD water-level data is currently unavailable."}

    def _normalize(props):
        # Mirrors layer-attribute-popup.js's normalizeFfdProps EXACTLY (same
        # gauges-array-or-flat-fields fallback chain) so a number reported
        # here can never disagree with what clicking the real station on
        # the map would show.
        gauges = props.get("gauges")
        if isinstance(gauges, str) and gauges.strip().startswith("["):
            try:
                gauges = json.loads(gauges)
            except Exception:
                gauges = []
        if not isinstance(gauges, list):
            gauges = []
        by_type = {str(g.get("type") or "").upper(): g for g in gauges if isinstance(g, dict)}
        outflow = by_type.get("OUTFLOW", {})
        inflow = by_type.get("INFLOW", {})
        return {
            "name": props.get("name"),
            "status": props.get("status"),
            "inflow_discharge": props.get("inflow_discharge") or inflow.get("discharge"),
            "outflow_discharge": props.get("outflow_discharge") or outflow.get("discharge") or props.get("discharge"),
            "recording_time": props.get("recording_time"),
        }

    stations = [_normalize(f.get("properties") or {}) for f in features if f.get("properties")]

    requested_station = (args.get("station") or "").strip().lower()
    if requested_station:
        matches = [s for s in stations if s["name"] and requested_station in s["name"].lower()]
        if not matches:
            return {"error": f"No FFD station matching \"{args.get('station')}\".", "requested_station": requested_station}
        return {"stations": matches}

    # No specific station — surface whatever's currently elevated first
    # (the genuinely actionable subset for "what's the flood situation"),
    # falling back to the first several stations if nothing is elevated.
    elevated = [s for s in stations if (s["status"] or "").strip().upper() not in ("", "NORMAL")]
    result = elevated if elevated else stations[:10]
    return {"stations": result, "total_stations": len(stations), "elevated_count": len(elevated)}


TOOL_EXECUTORS = {
    "get_rainfall_report": run_get_rainfall_report,
    "get_heatwave_monitoring": run_get_heatwave_monitoring,
    "get_pmd_daily_forecast": run_get_pmd_daily_forecast,
    "get_ffd_bulletins": run_get_ffd_bulletins,
    "get_nwfc_weekly_outlook": run_get_nwfc_weekly_outlook,
    "get_weather_forecast": run_get_weather_forecast,
    "get_air_quality": run_get_air_quality,
    "get_seasonal_forecast": run_get_seasonal_forecast,
    "get_climate_outlook": run_get_climate_outlook,
    "get_pakistan_climate_reports": run_get_pakistan_climate_reports,
    "get_nwfc_press_releases": run_get_nwfc_press_releases,
    "get_ffd_waterlevels": run_get_ffd_waterlevels,
}
