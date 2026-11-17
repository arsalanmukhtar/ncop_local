# project/ncop_internal/iwmi_flood_client.py
# ---------------------------------------------------------------------------
# IWMI ENSO Outlook flood-forecasting data for NCOP's Flood Monitoring
# accordion (https://enso.iwmi.org/map → "Flood Forecasting"):
#   - CEMS GloFAS flood-alert reference points (status per point, 45-day
#     discharge series: 30 days of recent day-1 forecasts + 15 forecast days
#     with ensemble mean, +/-1 SD band and per-day exceedance probabilities);
#   - Google Flood Forecasting (Flood Hub) river gauges, gauge discharge and
#     inundation extent (CC BY 4.0).
# Attribution travels on every response (ATTRIBUTION_* below).
#
# Region: settings.IWMI_FLOOD_COUNTRIES (ISO3), fetched country by country
# (IWMI's API is per-iso3; its global gauge query returns nothing) and
# merged into one regional response.
#
# Enrichment over IWMI's own payload:
#   - data quality: a GloFAS point whose 45-day series never reaches
#     _UNRELIABLE_MAX_RATIO of its warning threshold is flagged
#     "unreliable" (confirmed 2026-11-17: Pakistan points 1446/1449 are
#     flat zero with thresholds in the thousands — snapped to a dry grid
#     cell — and 1452/1463 never exceed 3%; such points can only ever show
#     "Normal", so they are drawn as unreliable, not as green);
#   - GloFAS run age + stale flag (the 2026-11-17 run was dated 11-12);
#   - river names from NCOP's own `major_rivers` layer where IWMI has none
#     (all of Pakistan's points and gauges).
#
# Same cache/fallback policy as the Hawanama integration (cached_fetch.py).
# ---------------------------------------------------------------------------

import logging
import math
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

from django.conf import settings

from .cached_fetch import CachedJsonClient, Unavailable

logger = logging.getLogger(__name__)

ATTRIBUTION_GLOFAS = "CEMS GloFAS (Copernicus) via IWMI ENSO Outlook"
ATTRIBUTION_FLOODHUB = "Google Flood Forecasting, CC BY 4.0 (via IWMI ENSO Outlook)"

DEFAULT_COUNTRIES = ("PAK", "IND", "BGD", "LKA", "AFG", "MMR", "THA", "VNM", "KHM", "LAO", "IDN", "PHL", "MYS")
_ISO3_RE = re.compile(r"^[A-Z]{3}$")
_GAUGE_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{3,64}$")

# GloFAS alert rule (IWMI method.thresholds.prob_cutoff, mirrors GloFAS's
# own reporting-point rule): worst level whose exceedance prob >= 0.3.
PROB_CUTOFF = 0.3
GLOFAS_STATUS_ORDER = ["normal", "warning", "danger", "extreme"]
GLOFAS_STATUS_LABEL = {"normal": "Normal", "warning": "Warning", "danger": "Severe", "extreme": "Extreme"}
GLOFAS_COLORS = {"extreme": "#640000", "danger": "#E2683C", "warning": "#E7B416", "normal": "#3FA34D"}
FLOODHUB_SEVERITY_ORDER = ["NO_FLOODING", "ABOVE_NORMAL", "SEVERE", "EXTREME"]

_UNRELIABLE_MAX_RATIO = 0.03       # series max < 3% of the warning level
_GLOFAS_STALE_DAYS = 3             # run older than this is flagged stale
_RIVER_MATCH_KM = 8.0              # nearest NCOP river within this distance
_SERIES_PREFETCH_WORKERS = 4

client = CachedJsonClient(
    name="iwmi_flood_client",
    base_url=lambda: getattr(settings, "IWMI_ENSO_API_BASE_URL", "https://enso.iwmi.org/ENSO_api/api/v1"),
    ttl_seconds={
        "glofas_points": 3600,
        "glofas_series": 7 * 24 * 3600,     # keyed by forecast date: a run's series never changes
        "floodhub_gauges": 1800,
        "floodhub_discharge": 1800,
        "inundation": 1800,
        "rivers": 30 * 24 * 3600,
    },
    cache_subdir="iwmi_flood_cache",
    user_agent="NCOP-NDMA/1.0 (National Common Operating Picture; flood-monitoring layers)",
    timeout_seconds=40,
    backoff_seconds=300,
)


def countries():
    raw = getattr(settings, "IWMI_FLOOD_COUNTRIES", DEFAULT_COUNTRIES)
    if isinstance(raw, str):
        raw = raw.split(",")
    return [c.strip().upper() for c in raw if _ISO3_RE.match(c.strip().upper())]


def _iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fetch_all_countries(fn):
    """Runs fn(iso3) per configured country in parallel. Returns
    (results_by_country, failed_countries, any_stale)."""
    results, failed, stale = {}, [], False
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {c: pool.submit(fn, c) for c in countries()}
        for c, fut in futures.items():
            try:
                payload, meta = fut.result()
                results[c] = payload
                stale = stale or meta["stale"]
            except Unavailable:
                failed.append(c)
            except Exception:
                logger.warning("iwmi_flood_client: %s failed for %s", getattr(fn, "__name__", fn), c, exc_info=True)
                failed.append(c)
    return results, failed, stale


def _fc_valid(p):
    return isinstance(p, dict) and isinstance(p.get("features"), list)


# ---------------------------------------------------------------------------
# River names from NCOP's own major_rivers layer
# ---------------------------------------------------------------------------

_rivers = {"tree": None, "geoms": None, "names": None, "loaded": False}
_rivers_lock = threading.Lock()


def _load_rivers():
    with _rivers_lock:
        if _rivers["loaded"]:
            return
        _rivers["loaded"] = True
        try:
            from shapely import STRtree
            from shapely.geometry import shape
            import requests
            url = ("http://172.18.7.21:8080/geoserver/hydrological_global/ows?service=WFS&version=1.0.0"
                   "&request=GetFeature&typeName=hydrological_global:major_rivers&outputFormat=application/json")
            cached = client.peek("rivers:major_rivers")
            if cached is None:
                resp = requests.get(url, timeout=60)
                resp.raise_for_status()
                cached = resp.json()
                client._write_disk("rivers:major_rivers", cached)
            geoms, names = [], []
            for f in cached.get("features", []):
                name = (f.get("properties") or {}).get("name")
                if name and f.get("geometry"):
                    geoms.append(shape(f["geometry"]))
                    names.append(name)
            if geoms:
                _rivers.update({"tree": STRtree(geoms), "geoms": geoms, "names": names})
        except Exception:
            logger.warning("iwmi_flood_client: NCOP major_rivers unavailable — no river-name enrichment", exc_info=True)


def nearest_river(lon, lat):
    """Name of the nearest NCOP major river within _RIVER_MATCH_KM, else None."""
    _load_rivers()
    tree = _rivers["tree"]
    if tree is None:
        return None
    from shapely.geometry import Point
    pt = Point(lon, lat)
    idx = tree.nearest(pt)
    if idx is None:
        return None
    d_deg = _rivers["geoms"][int(idx)].distance(pt)
    if d_deg * 111.32 * max(math.cos(math.radians(lat)), 0.3) > _RIVER_MATCH_KM:
        return None
    return _rivers["names"][int(idx)]


# ---------------------------------------------------------------------------
# GloFAS reference points
# ---------------------------------------------------------------------------

def _run_age_days(forecast_date):
    try:
        return (date.today() - date.fromisoformat(forecast_date)).days
    except (TypeError, ValueError):
        return None


def series_key(point_id, forecast_date):
    return f"glofas_series:{point_id}:{forecast_date}"


def _cached_series(point_id, forecast_date):
    return client.peek(series_key(point_id, forecast_date))


def series_quality(series_payload):
    """("ok"|"unreliable", ratio) from a point's discharge payload."""
    thr = (series_payload or {}).get("thresholds") or {}
    warn = thr.get("warning")
    meds = [s.get("median") for s in series_payload.get("series", []) if s.get("median") is not None]
    if not meds or not warn:
        return "unreliable", None
    ratio = max(meds) / warn
    return ("unreliable" if ratio < _UNRELIABLE_MAX_RATIO else "ok"), round(ratio, 4)


def glofas_points_geojson():
    """Every configured country's GloFAS reference points, enriched."""
    def fetch(iso3):
        return client.get(f"glofas_points:{iso3}", "forecasts/glofas/reference-points", {"iso3": iso3},
                          validate=_fc_valid)

    by_country, failed, stale = _fetch_all_countries(fetch)
    if not by_country:
        raise Unavailable("no GloFAS points for any configured country")
    features, missing_series, run_dates = [], [], set()
    for iso3, fc in by_country.items():
        for f in fc["features"]:
            p = dict(f.get("properties") or {})
            coords = (f.get("geometry") or {}).get("coordinates") or [None, None]
            fd = p.get("forecast_date")
            run_dates.add(fd)
            thr = p.get("thresholds") or {}
            river = p.get("river") or nearest_river(coords[0], coords[1])
            series = _cached_series(p.get("id"), fd)
            if series is None:
                quality, ratio = "unchecked", None
                missing_series.append((p.get("id"), fd))
            else:
                quality, ratio = series_quality(series)
            status = p.get("status") or "normal"
            features.append({"type": "Feature",
                             "geometry": {"type": "Point", "coordinates": [round(coords[0], 5), round(coords[1], 5)]},
                             "properties": {
                                 "id": p.get("id"), "iso3": p.get("iso3") or iso3, "river": river,
                                 "river_source": "iwmi" if p.get("river") else ("ncop_major_rivers" if river else None),
                                 "site_name": p.get("siteName"), "status": status,
                                 "status_label": GLOFAS_STATUS_LABEL.get(status, p.get("status_label")),
                                 "color": GLOFAS_COLORS.get(status, p.get("color")),
                                 "peak_prob": p.get("peak_prob"), "peak_lead": p.get("peak_lead"),
                                 "warning": thr.get("warning"), "danger": thr.get("danger"), "extreme": thr.get("extreme"),
                                 "forecast_date": fd, "quality": quality, "max_to_warning_ratio": ratio,
                             }})
    if missing_series:
        prefetch_series_async(missing_series)
    run_date = max((d for d in run_dates if d), default=None)
    age = _run_age_days(run_date)
    return {"type": "FeatureCollection", "features": features, "metadata": {
        "attribution": ATTRIBUTION_GLOFAS, "fetched_at": _iso_now(), "countries": sorted(by_country),
        "failed_countries": sorted(failed), "cache_stale": stale, "forecast_date": run_date,
        "run_age_days": age, "run_stale": age is not None and age > _GLOFAS_STALE_DAYS,
        "stale": bool(stale or failed or (age is not None and age > _GLOFAS_STALE_DAYS)),
        "count": len(features), "unchecked": len(missing_series),
        "prob_cutoff": PROB_CUTOFF,
        "quality_rule": f"unreliable = 45-day discharge never reaches {int(_UNRELIABLE_MAX_RATIO * 100)}% of the warning level",
    }}


def glofas_point_discharge(point_id):
    """One point's 45-day series (IWMI payload) plus quality. Cached per
    point + forecast date, so a run's series is fetched once."""
    point_id = int(point_id)
    if point_id <= 0:
        raise ValueError("invalid point id")
    fd = None
    for c in countries():
        fc = client.peek(f"glofas_points:{c}")
        if fc:
            for f in fc.get("features", []):
                if (f.get("properties") or {}).get("id") == point_id:
                    fd = f["properties"].get("forecast_date")
                    break
        if fd:
            break
    key = series_key(point_id, fd or "latest")
    data, meta = client.get(key, f"forecasts/glofas/point/{point_id}/discharge", ttl_name="glofas_series",
                            validate=lambda p: isinstance(p, dict) and isinstance(p.get("series"), list))
    quality, ratio = series_quality(data)
    river = data.get("river")
    if not river:
        for c in countries():
            fc = client.peek(f"glofas_points:{c}")
            for f in (fc or {}).get("features", []):
                if (f.get("properties") or {}).get("id") == point_id:
                    lon, lat = f["geometry"]["coordinates"]
                    river = nearest_river(lon, lat)
    return {
        "id": point_id, "iso3": data.get("iso3"), "river": river, "site_name": data.get("siteName"),
        "unit": "m³/s", "status": data.get("status"), "status_label": GLOFAS_STATUS_LABEL.get(data.get("status")),
        "peak_prob": data.get("peak_prob"), "peak_lead": data.get("peak_lead"), "peak_date": data.get("peak_date"),
        "forecast_date": data.get("forecast_date"), "thresholds": data.get("thresholds"),
        "series": [{k: s.get(k) for k in ("lead_day", "valid_date", "median", "lo", "hi", "p_warn", "p_danger", "p_extreme")}
                   for s in data["series"]],
        "quality": quality, "max_to_warning_ratio": ratio,
        "notes": [
            "Lead days <= 0 are each past run's day-1 forecast (recent forecasts), not observed discharge.",
            "Band = ensemble mean +/-1 SD. Exceedance probabilities are estimated from mean and SD, not counted from members.",
        ],
        "metadata": {"attribution": ATTRIBUTION_GLOFAS, "fetched_at": _iso_now(), "cache_stale": meta["stale"],
                     "stale": meta["stale"]},
    }


_prefetch_lock = threading.Lock()
_prefetch_running = {"active": False}


def prefetch_series(pairs, workers=_SERIES_PREFETCH_WORKERS):
    """Fetches (point_id, forecast_date) series not yet cached. Returns
    (ok, failed) counts. Used by the background prefetch and the warm job."""
    todo = [(pid, fd) for pid, fd in pairs if pid is not None and _cached_series(pid, fd) is None]

    def one(pair):
        pid, fd = pair
        try:
            client.get(series_key(pid, fd), f"forecasts/glofas/point/{pid}/discharge", ttl_name="glofas_series",
                       validate=lambda p: isinstance(p, dict) and isinstance(p.get("series"), list))
            return True
        except Exception:
            return False

    ok = failed = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for good in pool.map(one, todo):
            ok, failed = ok + good, failed + (not good)
    return ok, failed


def prefetch_series_async(pairs):
    """One background prefetch at a time; requests never wait on it."""
    with _prefetch_lock:
        if _prefetch_running["active"]:
            return
        _prefetch_running["active"] = True

    def run():
        try:
            ok, failed = prefetch_series(pairs)
            logger.info("iwmi_flood_client: background series prefetch %d ok, %d failed", ok, failed)
        finally:
            with _prefetch_lock:
                _prefetch_running["active"] = False

    threading.Thread(target=run, name="iwmi-series-prefetch", daemon=True).start()


def status_for_lead(row):
    """GloFAS status for one forecast day from its exceedance probabilities."""
    for level, key in (("extreme", "p_extreme"), ("danger", "p_danger"), ("warning", "p_warn")):
        p = row.get(key)
        if p is not None and p >= PROB_CUTOFF:
            return level
    return "normal"


def glofas_forecast_days_geojson():
    """Phase 4 slider data: every point with a cached series, its status on
    each forecast day 1..15 as properties s_1..s_15 (worst level with
    exceedance probability >= PROB_CUTOFF that day). Points whose series is
    not cached yet are counted in metadata.missing and fetched in the
    background; unreliable points carry quality="unreliable"."""
    points = glofas_points_geojson()
    features, missing, lead_dates = [], [], {}
    for f in points["features"]:
        p = f["properties"]
        series = _cached_series(p["id"], p["forecast_date"])
        if series is None:
            missing.append((p["id"], p["forecast_date"]))
            continue
        props = {k: p[k] for k in ("id", "iso3", "river", "site_name", "quality", "warning", "danger", "extreme")}
        for row in series.get("series", []):
            lead = row.get("lead_day")
            if lead is None or lead < 1:
                continue
            props[f"s_{lead}"] = status_for_lead(row)
            props[f"q_{lead}"] = row.get("median")
            lead_dates.setdefault(lead, row.get("valid_date"))
        features.append({"type": "Feature", "geometry": f["geometry"], "properties": props})
    if missing:
        prefetch_series_async(missing)
    leads = sorted(lead_dates)
    return {"type": "FeatureCollection", "features": features, "metadata": {
        **{k: points["metadata"][k] for k in ("attribution", "forecast_date", "run_age_days", "run_stale", "stale",
                                                "countries", "failed_countries")},
        "fetched_at": _iso_now(), "leads": leads, "lead_dates": {str(k): lead_dates[k] for k in leads},
        "count": len(features), "missing": len(missing), "prob_cutoff": PROB_CUTOFF,
    }}


# ---------------------------------------------------------------------------
# Google Flood Hub (via IWMI)
# ---------------------------------------------------------------------------

def floodhub_gauges_geojson(include_low_confidence=False):
    lc = "true" if include_low_confidence else "false"

    def fetch(iso3):
        return client.get(f"floodhub_gauges:{iso3}:{lc}", "flood/gauges", {"iso3": iso3, "low_confidence": lc},
                          validate=_fc_valid)

    by_country, failed, stale = _fetch_all_countries(fetch)
    if not by_country:
        raise Unavailable("no Flood Hub gauges for any configured country")
    features, issued = [], []
    for iso3, fc in by_country.items():
        for f in fc["features"]:
            p = dict(f.get("properties") or {})
            coords = (f.get("geometry") or {}).get("coordinates") or [None, None]
            if coords[0] is None:
                continue
            thr = p.get("thresholds") or {}
            rng = p.get("forecastTimeRange") or {}
            river = p.get("river") or nearest_river(coords[0], coords[1])
            if p.get("issuedTime"):
                issued.append(p["issuedTime"])
            features.append({"type": "Feature",
                             "geometry": {"type": "Point", "coordinates": [round(coords[0], 5), round(coords[1], 5)]},
                             "properties": {
                                 "gauge_id": p.get("gaugeId"), "iso3": iso3, "river": river or None,
                                 "site_name": p.get("siteName") or None, "severity": p.get("severity"),
                                 "severity_label": p.get("severity_label"), "color": p.get("color"),
                                 "trend": p.get("forecastTrend"), "quality_verified": bool(p.get("qualityVerified")),
                                 "has_model": bool(p.get("hasModel")), "issued_time": p.get("issuedTime"),
                                 "forecast_start": rng.get("start"), "forecast_end": rng.get("end"),
                                 "warning": thr.get("warningLevel"), "danger": thr.get("dangerLevel"),
                                 "extreme": thr.get("extremeDangerLevel"), "unit": p.get("unit"),
                             }})
    return {"type": "FeatureCollection", "features": features, "metadata": {
        "attribution": ATTRIBUTION_FLOODHUB, "fetched_at": _iso_now(), "countries": sorted(by_country),
        "failed_countries": sorted(failed), "cache_stale": stale, "stale": bool(stale or failed),
        "issued_time": max(issued) if issued else None, "count": len(features),
        "low_confidence_included": include_low_confidence,
    }}


def floodhub_gauge_discharge(gauge_id):
    if not _GAUGE_ID_RE.match(gauge_id or ""):
        raise ValueError("invalid gauge id")
    data, meta = client.get(f"floodhub_discharge:{gauge_id}", f"flood/gauge/{gauge_id}/discharge",
                            validate=lambda p: isinstance(p, dict) and ("history" in p or "forecast" in p))
    unit = data.get("unit")
    return {
        "gauge_id": gauge_id, "unit": "m³/s" if unit == "CUBIC_METERS_PER_SECOND" else unit,
        "issued_time": data.get("issuedTime"), "thresholds": data.get("thresholds"),
        "history": [{"t": r.get("t"), "v": r.get("v")} for r in data.get("history") or []],
        "forecast": [{"t": r.get("t"), "v": r.get("v")} for r in data.get("forecast") or []],
        "metadata": {"attribution": ATTRIBUTION_FLOODHUB, "fetched_at": _iso_now(), "cache_stale": meta["stale"],
                     "stale": meta["stale"]},
    }


def floodhub_inundation_geojson():
    def fetch(iso3):
        return client.get(f"inundation:{iso3}", "flood/inundation", {"iso3": iso3}, validate=_fc_valid)

    by_country, failed, stale = _fetch_all_countries(fetch)
    if not by_country:
        raise Unavailable("no inundation data for any configured country")
    features = []
    for iso3, fc in by_country.items():
        for f in fc["features"]:
            if f.get("geometry"):
                features.append({"type": "Feature", "geometry": f["geometry"],
                                 "properties": {**(f.get("properties") or {}), "iso3": iso3}})
    return {"type": "FeatureCollection", "features": features, "metadata": {
        "attribution": ATTRIBUTION_FLOODHUB, "fetched_at": _iso_now(), "countries": sorted(by_country),
        "failed_countries": sorted(failed), "cache_stale": stale, "stale": bool(stale or failed),
        "count": len(features),
        "note": "Polygons exist only for gauges currently flooding in Google's high-resolution modelled regions; "
                "an empty layer normally means no modelled flooding.",
    }}


# ---------------------------------------------------------------------------
# Regional status summary
# ---------------------------------------------------------------------------

def _worst(values, order):
    ranks = [order.index(v) for v in values if v in order]
    return order[max(ranks)] if ranks else None


def regional_status():
    out = {"countries": {}, "fetched_at": _iso_now(),
           "attribution": f"{ATTRIBUTION_GLOFAS}; {ATTRIBUTION_FLOODHUB}"}
    glofas_meta = floodhub_meta = None
    top = []  # every alerting point/gauge, trimmed to the worst few below
    try:
        g = glofas_points_geojson()
        glofas_meta = g["metadata"]
        for f in g["features"]:
            p = f["properties"]
            c = out["countries"].setdefault(p["iso3"], {})
            gs = c.setdefault("glofas", {"points": 0, "alerts": 0, "unreliable": 0, "statuses": []})
            gs["points"] += 1
            gs["unreliable"] += p["quality"] == "unreliable"
            if p["quality"] != "unreliable":
                gs["statuses"].append(p["status"])
                gs["alerts"] += p["status"] != "normal"
                if p["status"] != "normal":
                    top.append({"source": "glofas", "iso3": p["iso3"], "river": p.get("river"), "id": p["id"],
                                "level": p["status"], "rank": GLOFAS_STATUS_ORDER.index(p["status"]),
                                "peak_prob": p.get("peak_prob"), "peak_lead": p.get("peak_lead")})
    except Unavailable:
        pass
    try:
        h = floodhub_gauges_geojson()
        floodhub_meta = h["metadata"]
        for f in h["features"]:
            p = f["properties"]
            c = out["countries"].setdefault(p["iso3"], {})
            fs = c.setdefault("floodhub", {"gauges": 0, "flooding": 0, "severities": []})
            fs["gauges"] += 1
            fs["severities"].append(p["severity"])
            fs["flooding"] += p["severity"] in ("ABOVE_NORMAL", "SEVERE", "EXTREME")
            if p["severity"] in ("ABOVE_NORMAL", "SEVERE", "EXTREME"):
                top.append({"source": "floodhub", "iso3": p["iso3"], "river": p.get("river"), "id": p["gauge_id"],
                            "level": p["severity"], "rank": FLOODHUB_SEVERITY_ORDER.index(p["severity"]),
                            "trend": p.get("trend")})
    except Unavailable:
        pass
    # Per-class counts alongside the worst level: GloFAS over RELIABLE points
    # only (unreliable points are counted separately), Flood Hub over all.
    for c in out["countries"].values():
        if "glofas" in c:
            statuses = c["glofas"].pop("statuses")
            c["glofas"]["worst"] = _worst(statuses, GLOFAS_STATUS_ORDER) or "normal"
            c["glofas"]["counts"] = {k: statuses.count(k) for k in GLOFAS_STATUS_ORDER}
        if "floodhub" in c:
            sev = c["floodhub"].pop("severities")
            c["floodhub"]["worst"] = _worst(sev, FLOODHUB_SEVERITY_ORDER) or "NO_FLOODING"
            c["floodhub"]["counts"] = {k: sev.count(k) for k in FLOODHUB_SEVERITY_ORDER}
    totals = {"glofas_points": 0, "glofas_reliable": 0, "glofas_alerts": 0, "floodhub_gauges": 0, "floodhub_flooding": 0}
    for c in out["countries"].values():
        if "glofas" in c:
            totals["glofas_points"] += c["glofas"]["points"]
            totals["glofas_reliable"] += c["glofas"]["points"] - c["glofas"]["unreliable"]
            totals["glofas_alerts"] += c["glofas"]["alerts"]
        if "floodhub" in c:
            totals["floodhub_gauges"] += c["floodhub"]["gauges"]
            totals["floodhub_flooding"] += c["floodhub"]["flooding"]
    out["totals"] = totals
    top.sort(key=lambda t: (-t["rank"], t["source"] != "glofas", -(t.get("peak_prob") or 0)))
    out["top_alerts"] = [{k: v for k, v in t.items() if k != "rank"} for t in top[:6]]
    out["glofas"] = None if glofas_meta is None else {k: glofas_meta.get(k) for k in
                                                       ("forecast_date", "run_age_days", "run_stale", "count", "unchecked")}
    out["floodhub"] = None if floodhub_meta is None else {k: floodhub_meta.get(k) for k in ("issued_time", "count")}
    if glofas_meta is None and floodhub_meta is None:
        raise Unavailable("neither GloFAS nor Flood Hub data available")
    return out


def health():
    return {"countries": countries(), **client.cache_state(exclude_prefixes=("glofas_series:", "floodhub_discharge:"))}
