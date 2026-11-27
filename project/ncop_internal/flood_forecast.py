# project/ncop_internal/flood_forecast.py
# ---------------------------------------------------------------------------
# Real rainfall input sources for the discharge-driven flood mode
# (flood_model.build_discharge_driven_flood_zone, §0.19-§0.25). Additive to
# that mode, NOT a replacement for its manual rainfall_mm/duration_hr path
# (explicit user instruction: manual entry stays available; this module adds
# three more ways to arrive at the same {rainfall_mm, duration_hr} pair the
# existing, unmodified SCS-CN/Kirpich/SCS-UH chain already consumes):
#
#   "chirps"        — CHIRPS satellite-estimated rainfall actually observed
#                      over the catchment in the last 1-3 days (GEE,
#                      ~5.5km). Same collection accuracy_assessment.py
#                      already uses for event-matched historical validation
#                      (§0.21) — reused here for a "what fell recently"
#                      nowcast instead of a historical-event lookup.
#   "pmd_forecast"  — WRFPRS precipitation-accumulation FORECAST from PMD
#                      Monitor, sampled at the catchment's own centroid.
#                      Reuses the exact helper functions views.py's own
#                      PmdMonitorPredictionValueAPIView already calls
#                      (_mon_get/_mon_cached/_mon_pred_select_steps/
#                      _mon_pred_ensure_warped/_mon_pred_sample) — this
#                      module calls them directly (no HTTP round-trip to
#                      this same server) rather than duplicating PMD
#                      Monitor's session/auth/caching logic.
#   "live_observed" — PMD's own daily rainfall report (NWFC), aggregated to
#                      district level, already parsed/cached by
#                      NwfcRainfallReportAPIView. Genuinely OBSERVED (not
#                      forecast/satellite-estimated) ground rainfall over
#                      the report's own rolling window (2 days currently).
#
# Every fetcher here follows this project's own established "degrade to
# None, never raise past this module" convention (matching
# accuracy_assessment.fetch_peak_event_rainfall) — a data source being
# temporarily unreachable is a real, expected condition, not a bug. The
# dispatcher (resolve_rainfall_scenario) is the one place that turns a None
# into a ValueError, so the view layer gets one clear, catchable failure
# mode regardless of which source was requested.
# ---------------------------------------------------------------------------

import datetime
import logging

logger = logging.getLogger(__name__)

_CHIRPS_GEE_COLLECTION = "UCSB-CHG/CHIRPS/DAILY"
_CHIRPS_NATIVE_SCALE_M = 5566  # ~0.05 degree native resolution — matches accuracy_assessment.py

RAINFALL_SOURCES = ("manual", "chirps", "pmd_forecast", "live_observed")

# element_key -> duration_hr, mirrors views.py's _MON_PRED_ELEMENTS accumulation
# windows exactly (HOURTPE=3h/SIXTPE=6h/TWELVETPE=12h/DAYTPE=24h precipitation).
PMD_FORECAST_ELEMENTS = {
    "hourtpe": 3.0,
    "sixtpe": 6.0,
    "twelvetpe": 12.0,
    "daytpe": 24.0,
}


def _bbox_centroid(bbox):
    min_lon, min_lat, max_lon, max_lat = bbox
    return (min_lat + max_lat) / 2.0, (min_lon + max_lon) / 2.0  # (lat, lon)


def fetch_chirps_recent_rainfall(bbox, days=1):
    """Sums the `days` MOST RECENTLY AVAILABLE CHIRPS daily images' mean
    precipitation over `bbox` — a real, satellite-estimated rainfall
    figure, not a manual guess. This is deliberately NOT called a
    "nowcast": CHIRPS/DAILY's GEE-hosted publication latency was measured
    LIVE while building this (§0.26) at ~27 days (last available image
    2026-07-31 checked on 2026-08-27) — far worse than the ~1-2 days a
    first assumption expected, and CHIRPS/PENTAD (checked as a lower-
    latency alternative) was found EVEN MORE stale (2026-07-26). No
    lower-latency CHIRPS product is available through this project's GEE
    access. The returned "end_date" is therefore load-bearing, not
    cosmetic — callers/UI MUST surface it so this is never presented as
    "right now" rainfall. Given this real latency, a wide 60-day search
    window is used (not a tight "last few days" one) so a genuinely
    reachable image is actually found rather than spuriously returning
    None because of a too-narrow assumption about how fresh CHIRPS is.

    Returns {"rainfall_mm", "duration_hr", "days", "end_date", "source"} or
    None if CHIRPS has no data at all in the window or the GEE call fails
    — matching accuracy_assessment.fetch_peak_event_rainfall's own
    degrade-to-None convention."""
    from . import views  # noqa: F401 — import side effect: initializes Earth Engine
    import ee

    days = int(days)
    now = datetime.datetime.utcnow()
    region = ee.Geometry.Rectangle(bbox)
    coll = (
        ee.ImageCollection(_CHIRPS_GEE_COLLECTION)
        .filterDate((now - datetime.timedelta(days=60)).strftime("%Y-%m-%d"),
                    (now + datetime.timedelta(days=1)).strftime("%Y-%m-%d"))
        .filterBounds(region)
        .sort("system:time_start", False)  # newest first
        .limit(days)
    )

    def _stamp_precip(image):
        val = image.reduceRegion(
            reducer=ee.Reducer.mean(), geometry=region,
            scale=_CHIRPS_NATIVE_SCALE_M, bestEffort=True,
        ).get("precipitation")
        return image.set("_precip_mm", val)

    try:
        info = coll.map(_stamp_precip).getInfo()
    except Exception:
        logger.warning(
            "flood_forecast: CHIRPS recent-rainfall fetch failed for bbox %s (degraded — "
            "no CHIRPS scenario available)", bbox, exc_info=True,
        )
        return None

    series = []
    for feat in info.get("features", []) or []:
        p = feat.get("properties", {})
        precip = p.get("_precip_mm")
        ts = p.get("system:time_start")
        if precip is None or ts is None:
            continue
        series.append((ts, float(precip)))

    if not series:
        logger.info(
            "flood_forecast: no recent CHIRPS data for bbox %s — no CHIRPS scenario "
            "available (a real, confirmed condition, not a bug)", bbox,
        )
        return None

    series.sort(key=lambda t: t[0])
    total_mm = sum(mm for _, mm in series)
    end_date = datetime.datetime.utcfromtimestamp(series[-1][0] / 1000).date().isoformat()

    return {
        "rainfall_mm": round(total_mm, 2),
        "duration_hr": float(len(series) * 24),
        "days": len(series),
        "end_date": end_date,
        "source": "chirps",
    }


def fetch_pmd_forecast_rainfall(bbox, element_key="daytpe"):
    """Samples PMD Monitor's WRFPRS precipitation-accumulation FORECAST at
    the catchment's own centroid — the nearest available forecast step
    (step_index=0), matching PmdMonitorPredictionValueAPIView's own default
    when no step_index/date is given. Calls that view's own helper
    functions directly (same module, no HTTP round-trip to this server).

    Returns {"rainfall_mm", "duration_hr", "element_key", "forecast_time",
    "source"} or None on any failure (unreachable PMD Monitor, no forecast
    steps, point outside the raster/nodata) — matching this module's own
    degrade-to-None convention."""
    if element_key not in PMD_FORECAST_ELEMENTS:
        raise ValueError(
            f"Unknown PMD forecast element_key {element_key!r} — known: "
            f"{list(PMD_FORECAST_ELEMENTS)}"
        )

    from . import views

    cfg = views._MON_PRED_ELEMENTS.get(element_key)
    if not cfg:
        return None
    data_type, element = cfg["data_type"], cfg["element"]
    lat, lon = _bbox_centroid(bbox)

    try:
        def _latest_run():
            resp = views._mon_get("/api/modelTimeList", {"data_type": data_type, "element": element})
            times = (resp or {}).get("data") or []
            if not times:
                raise ValueError("no model runs available")
            return times[0]["data_time"]

        run = views._mon_cached(f"pmd_pred_run_{element_key}", 1800,
                                 _latest_run, f"pmd_pred_run_{element_key}_last")

        def _frames():
            resp = views._mon_get("/api/model", {"data_type": data_type, "element": element, "date_time": run})
            return (resp or {}).get("ds") or []

        frame_list = views._mon_cached(
            f"pmd_pred_frames_{element_key}_{run}", 10800,
            _frames, f"pmd_pred_frames_{element_key}_{run}_last",
        )

        selected = views._mon_pred_select_steps(frame_list)
        if not selected:
            return None
        item = selected[0]  # nearest available forecast step

        warped_path = views._mon_pred_ensure_warped(element_key, item)
        if not warped_path:
            return None

        value = views._mon_pred_sample(warped_path, lat, lon)
    except Exception:
        logger.warning(
            "flood_forecast: PMD forecast fetch failed for element_key=%s bbox=%s "
            "(degraded — no PMD forecast scenario available)", element_key, bbox, exc_info=True,
        )
        return None

    if value is None:
        logger.info(
            "flood_forecast: PMD forecast point (%.4f, %.4f) is nodata/outside raster for "
            "element_key=%s — no PMD forecast scenario available", lat, lon, element_key,
        )
        return None

    return {
        "rainfall_mm": round(float(value), 2),
        "duration_hr": PMD_FORECAST_ELEMENTS[element_key],
        "element_key": element_key,
        "forecast_time": item.get("forecast_time"),
        "source": "pmd_forecast",
    }


def fetch_live_observed_rainfall(district_names):
    """Looks up the most recent NWFC daily-rainfall report's district-level
    multi-day total (already parsed/cached by NwfcRainfallReportAPIView —
    called directly here, not over HTTP) for whichever of `district_names`
    it finds a match for. Genuinely OBSERVED ground rainfall, not a
    forecast or satellite estimate.

    `district_names` — ordered list of acceptable district-name matches for
    a catchment (e.g. ["Islamabad", "Rawalpindi"]); the first one found in
    the report wins. Matching is case-insensitive substring match against
    the report's own district names (station-name-derived, see
    views._merge_rainfall_reports).

    Returns {"rainfall_mm", "duration_hr", "matched_district", "source"} or
    None if the report is unreachable or none of district_names appear in
    it — matching this module's own degrade-to-None convention.

    IMPORTANT, confirmed live (§0.26): the NWFC daily rainfall PDF only
    lists stations/districts that actually RECORDED measurable rain that
    day — a dry district is simply ABSENT from the report, not listed
    with 0mm (confirmed live on 2026-08-27: the report had exactly one
    district, "Kasur & Lahore (Airport)" — Islamabad/Rawalpindi/Peshawar
    were genuinely absent, matching CHIRPS's and PMD Forecast's own
    dry-period reading for the same catchments/dates, not a lookup bug).
    This means "not found" is genuinely ambiguous between "this district
    had no measurable rain" and "this district's station didn't report at
    all" — the dataset does not distinguish the two. This function
    deliberately does NOT synthesize a 0mm reading for a missing district
    (that would be guessing, not observing); callers see "no
    live_observed scenario available" in both cases, an honest
    insufficient-data result rather than an assumed zero."""
    from . import views

    try:
        view = views.NwfcRainfallReportAPIView()
        daily_payloads = view._fetch_recent_daily_payloads()
        merged = views._merge_rainfall_reports(daily_payloads)
    except Exception:
        logger.warning(
            "flood_forecast: NWFC rainfall report unreachable — no live_observed scenario "
            "available", exc_info=True,
        )
        return None

    districts = merged.get("districts") or []
    window_hours = 24 * len(daily_payloads)

    for wanted in district_names:
        wanted_lower = wanted.strip().lower()
        for d in districts:
            if wanted_lower in (d.get("name") or "").strip().lower():
                return {
                    "rainfall_mm": round(float(d["mm_total"]), 2),
                    "duration_hr": float(window_hours),
                    "matched_district": d["name"],
                    "source": "live_observed",
                }

    logger.info(
        "flood_forecast: none of %s found in latest NWFC report's %d districts — no "
        "live_observed scenario available (a real, confirmed condition, not a bug)",
        district_names, len(districts),
    )
    return None


def resolve_rainfall_scenario(catchment_key, source, chirps_days=1, pmd_element="daytpe"):
    """Dispatcher used by flood_model_views.py. `catchment_key` must already
    be validated against flood_model.PILOT_CATCHMENTS by the caller.

    Raises ValueError (never returns None) — the one place a fetcher's
    degrade-to-None result becomes a hard failure the view layer can turn
    into a clean 502, so every caller gets one consistent failure mode
    regardless of which source was requested."""
    from . import flood_model

    if source not in RAINFALL_SOURCES or source == "manual":
        raise ValueError(f"resolve_rainfall_scenario: invalid source {source!r}")

    cfg = flood_model.PILOT_CATCHMENTS[catchment_key]
    bbox = cfg["bbox"]

    if source == "chirps":
        result = fetch_chirps_recent_rainfall(bbox, days=chirps_days)
        if result is None:
            raise ValueError(
                "CHIRPS has no recent rainfall data available for this catchment right now."
            )
        return result

    if source == "pmd_forecast":
        result = fetch_pmd_forecast_rainfall(bbox, element_key=pmd_element)
        if result is None:
            raise ValueError(
                "PMD Forecast is currently unavailable for this catchment (unreachable, no "
                "forecast steps, or the catchment centroid falls outside the forecast grid)."
            )
        return result

    if source == "live_observed":
        district_names = cfg.get("district_names") or []
        if not district_names:
            raise ValueError(
                f"Catchment {catchment_key!r} has no district_names configured — "
                "live_observed rainfall needs at least one district name to match against."
            )
        result = fetch_live_observed_rainfall(district_names)
        if result is None:
            raise ValueError(
                "No live/observed rainfall recorded for this catchment's district(s) in PMD's "
                "latest daily rainfall report — either no measurable rain fell there, or the "
                "report is temporarily unreachable. The report only lists districts that "
                "recorded rain, so this is expected during dry periods, not necessarily an error."
            )
        return result

    raise ValueError(f"resolve_rainfall_scenario: unhandled source {source!r}")
