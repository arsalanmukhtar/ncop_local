# project/ncop_internal/hawanama_client.py
# ---------------------------------------------------------------------------
# Hawanama (Pakistan Air Quality Initiative, https://hawanama.org) client
# for NCOP's Air Quality layers. Data licence: CC BY 4.0, attribution
# "Pakistan Air Quality Initiative (Hawanama)" — see ATTRIBUTION below,
# which every response this module builds carries.
#
# Why a server-side proxy, not direct browser calls:
#   - Hawanama sends no CORS headers, so the browser cannot call it.
#   - Several routes used here (/api/v1/ops/...) are the site's own
#     pipeline routes, not a published API, and can change; one module
#     owning every URL, shape check and fallback keeps a change there to
#     a one-file fix and lets every layer degrade to "data unavailable"
#     instead of breaking.
#   - Caching here means one upstream request per TTL for all NCOP users.
#
# Caching / failure policy (same pattern as accuracy_assessment's NCOP
# landslide-inventory cache):
#   - every JSON endpoint has a TTL (_TTL_SECONDS); a fresh in-memory or
#     on-disk copy is served without contacting Hawanama;
#   - when a refresh fails, the last good copy is served with
#     meta.stale=True, and that endpoint is not retried for
#     _RETRY_BACKOFF_SECONDS, so an outage costs one timeout per key, not
#     one per request;
#   - with no copy at all, callers get HawanamaUnavailable and views
#     return 503 "data unavailable".
#   - daily PM2.5 estimate tiles are immutable once a date is complete,
#     so they are cached on disk permanently.
# ---------------------------------------------------------------------------

import hashlib
import io
import json
import logging
import math
import os
import re
import threading
import time

import numpy as np
import requests
from django.conf import settings

logger = logging.getLogger(__name__)

ATTRIBUTION = "PM2.5 data: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0"
_USER_AGENT = "NCOP-NDMA/1.0 (National Common Operating Picture; air-quality layers; contact via PAQI)"
_TIMEOUT_SECONDS = 25
_RETRY_BACKOFF_SECONDS = 300
_CACHE_SUBDIR = "hawanama_cache"
_TILE_SUBDIR = "hawanama_tiles"
_FORECAST_SUBDIR = "hawanama_forecast"

_TTL_SECONDS = {
    "stations": 600,
    "providers": 6 * 3600,
    "nowcast": 1800,
    "forecast_index": 1800,
    "forecast_lead": 1800,
    "tile_dates": 6 * 3600,
    "point": 6 * 3600,
    "stations_daily": 6 * 3600,
    "fires_outlook": 1800,
    "fires_seasons": 6 * 3600,
    "station_history": 600,
    "freshness": 300,
}

# Data-age thresholds behind meta.data_stale (separate from the cache's
# own "the last refresh failed" stale flag): the payload itself is old.
_DATA_STALE_HOURS = {"stations": 3, "nowcast": 9, "forecast": 18, "fires_outlook": 30}

# Daily PM2.5 estimate tiles (from the tilejson): Pakistan only, z0-12.
TILE_BOUNDS = (60.45, 23.25, 77.95, 37.35)
TILE_MIN_ZOOM, TILE_MAX_ZOOM = 0, 12
COLORSCALE = {"name": "turbo", "vmin": 20.0, "vmax": 180.0, "unit": "µg/m³"}

# Coarse rectangle used only when the real national boundary is
# unavailable (and as a cheap pre-filter before the polygon test).
_PAKISTAN_BBOX = (60.5, 23.5, 79.6, 37.2)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_STATION_ID_RE = re.compile(r"^[0-9a-f]{8,32}$")
FIRE_SEASON_REGIONS = ("punjab", "indian-punjab")
FIRE_SEASONS = ("rice",)


class HawanamaUnavailable(Exception):
    """No fresh or cached copy of the requested Hawanama data exists."""


# ---------------------------------------------------------------------------
# HTTP + cache core
# ---------------------------------------------------------------------------

_session = None
_session_lock = threading.Lock()
_mem_cache = {}            # key -> (fetched_at, payload)
_mem_lock = threading.Lock()
_last_failure = {}         # key -> time.time() of last failed refresh
_key_locks = {}
_key_locks_guard = threading.Lock()


def base_url():
    return getattr(settings, "HAWANAMA_BASE_URL", "https://hawanama.org").rstrip("/")


def _sess():
    global _session
    with _session_lock:
        if _session is None:
            s = requests.Session()
            s.headers.update({"User-Agent": _USER_AGENT, "Accept": "application/json"})
            _session = s
        return _session


def _media_dir(sub):
    path = os.path.join(settings.MEDIA_ROOT, sub)
    os.makedirs(path, exist_ok=True)
    return path


def _cache_file(key):
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", key)
    if len(safe) > 120:
        safe = safe[:80] + "_" + hashlib.sha1(key.encode()).hexdigest()[:16]
    return os.path.join(_media_dir(_CACHE_SUBDIR), f"{safe}.json")


def _key_lock(key):
    with _key_locks_guard:
        lock = _key_locks.get(key)
        if lock is None:
            lock = _key_locks[key] = threading.Lock()
        return lock


def _http_get(path, params=None, binary=False):
    resp = _sess().get(f"{base_url()}/{path.lstrip('/')}", params=params, timeout=_TIMEOUT_SECONDS)
    resp.raise_for_status()
    return resp.content if binary else resp.json()


def _read_disk(key):
    path = _cache_file(key)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return os.path.getmtime(path), json.load(f)
    except (OSError, ValueError):
        logger.warning("hawanama_client: unreadable cache file %s", path, exc_info=True)
        return None


def _write_disk(key, payload):
    path = _cache_file(key)
    tmp = f"{path}.tmp{os.getpid()}.{threading.get_ident()}"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, path)
    except OSError:
        logger.warning("hawanama_client: could not write cache file %s", path, exc_info=True)


def cached_json(key, path, params=None, ttl_name=None, validate=None):
    """GET `path` as JSON through the cache. Returns (payload, meta) where
    meta = {"fetched_at": epoch, "stale": bool, "source": "memory"|"disk"|
    "upstream"}. `validate(payload)` must return True for a response to be
    accepted (guards against an upstream shape change being cached as if
    it were good data). Raises HawanamaUnavailable when there is neither a
    fresh fetch nor any cached copy."""
    ttl = _TTL_SECONDS[ttl_name or key.split(":", 1)[0]]
    now = time.time()

    with _mem_lock:
        hit = _mem_cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1], {"fetched_at": hit[0], "stale": False, "source": "memory"}

    with _key_lock(key):  # one upstream refresh per key at a time
        with _mem_lock:
            hit = _mem_cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1], {"fetched_at": hit[0], "stale": False, "source": "memory"}
        if hit is None:
            disk = _read_disk(key)
            if disk is not None:
                with _mem_lock:
                    _mem_cache[key] = disk
                hit = disk
                if time.time() - disk[0] < ttl:
                    return disk[1], {"fetched_at": disk[0], "stale": False, "source": "disk"}

        recently_failed = time.time() - _last_failure.get(key, 0) < _RETRY_BACKOFF_SECONDS
        if not recently_failed:
            try:
                payload = _http_get(path, params)
                if validate is not None and not validate(payload):
                    raise ValueError(f"unexpected response shape for {path}")
            except Exception:
                _last_failure[key] = time.time()
                logger.warning("hawanama_client: refresh failed for %s (%s)", key, path, exc_info=True)
            else:
                _last_failure.pop(key, None)
                fetched = time.time()
                with _mem_lock:
                    _mem_cache[key] = (fetched, payload)
                _write_disk(key, payload)
                return payload, {"fetched_at": fetched, "stale": False, "source": "upstream"}

        if hit is not None:
            return hit[1], {"fetched_at": hit[0], "stale": True, "source": "stale-cache"}
        raise HawanamaUnavailable(f"Hawanama data unavailable for {key}")


def _meta_out(meta, data_time=None, data_stale_hours=None):
    """The `metadata` block every NCOP Hawanama response carries."""
    out = {
        "attribution": ATTRIBUTION,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(meta["fetched_at"])),
        "cache_stale": meta["stale"],
    }
    if data_time:
        out["data_time"] = data_time
        if data_stale_hours is not None:
            age = _age_hours(data_time)
            out["data_age_hours"] = None if age is None else round(age, 1)
            out["data_stale"] = age is not None and age > data_stale_hours
    out["stale"] = bool(out["cache_stale"] or out.get("data_stale"))
    return out


def _parse_iso(ts):
    if not ts:
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def _age_hours(ts):
    t = _parse_iso(ts)
    return None if t is None else (time.time() - t) / 3600.0


def _r5(v):
    return None if v is None else round(float(v), 5)


# ---------------------------------------------------------------------------
# Pakistan boundary filter
# ---------------------------------------------------------------------------

_boundary = {"geom": None, "prepared": None, "loaded": False}
_boundary_lock = threading.Lock()


def _pakistan_filter():
    """Callable (lon, lat) -> bool using the real national boundary
    (landslide_lhasa2_scan's disk-cached GeoServer outline, which
    includes AJK/GB), falling back to the coarse bbox if unavailable."""
    with _boundary_lock:
        if not _boundary["loaded"]:
            try:
                from shapely.prepared import prep
                from . import landslide_lhasa2_scan
                geom = landslide_lhasa2_scan._fetch_pakistan_boundary()
                if geom is not None:
                    _boundary["geom"] = geom
                    _boundary["prepared"] = prep(geom.buffer(0.02))  # ~2 km: border-town stations
            except Exception:
                logger.warning("hawanama_client: national boundary unavailable, using bbox filter", exc_info=True)
            _boundary["loaded"] = True
        prepared = _boundary["prepared"]

    minx, miny, maxx, maxy = _PAKISTAN_BBOX
    if prepared is None:
        return lambda lon, lat: minx <= lon <= maxx and miny <= lat <= maxy
    from shapely.geometry import Point
    return lambda lon, lat: (minx <= lon <= maxx and miny <= lat <= maxy) and prepared.contains(Point(lon, lat))


# ---------------------------------------------------------------------------
# Stations (live) — point layer
# ---------------------------------------------------------------------------

def _valid_stations(p):
    return isinstance(p, dict) and isinstance(p.get("stations"), list)


def _providers():
    try:
        data, _ = cached_json("providers", "station-providers.json", {"v": 3},
                              validate=lambda p: isinstance(p, dict) and "by_station_id" in p)
        return data
    except HawanamaUnavailable:
        return {}


def _network_for(st, providers):
    by_id = providers.get("by_station_id") or {}
    by_nc = providers.get("by_name_city") or {}
    by_name = providers.get("by_name") or {}
    name, city = st.get("name") or st.get("station_name"), st.get("city")
    sid = st.get("id") or st.get("station_id")
    return by_id.get(sid) or by_nc.get(f"{name}|{city}") or by_name.get(name) or "Other"


def stations_geojson():
    """Live Hawanama stations inside Pakistan as GeoJSON points."""
    data, meta = cached_json("stations", "api/v1/stations", validate=_valid_stations)
    providers = _providers()
    inside = _pakistan_filter()
    features, newest = [], None
    for st in data["stations"]:
        lon, lat = st.get("longitude"), st.get("latitude")
        if lon is None or lat is None or not inside(lon, lat):
            continue
        last = st.get("last_reading")
        if last and (newest is None or last > newest):
            newest = last
        age = _age_hours(last)
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [_r5(lon), _r5(lat)]},
            "properties": {
                "id": st.get("id"), "name": st.get("name"), "city": st.get("city"),
                "pm25": st.get("pm25"), "aqi": st.get("aqi_raw"), "aqi_category": st.get("aqi_category"),
                "temp": st.get("temp"), "hum": st.get("hum"), "network": _network_for(st, providers),
                "qc_state": st.get("qc_state"), "last_reading": last,
                "age_hours": None if age is None else round(age, 1),
                "reading_stale": age is not None and age > _DATA_STALE_HOURS["stations"],
            },
        })
    return {"type": "FeatureCollection", "features": features,
            "metadata": {**_meta_out(meta, newest, _DATA_STALE_HOURS["stations"]), "count": len(features)}}


def station_history(station_id, hours=48, days=30):
    if not _STATION_ID_RE.match(station_id or ""):
        raise ValueError("invalid station id")
    hours = max(1, min(int(hours), 168))
    days = max(1, min(int(days), 90))
    hourly, m1 = cached_json(f"station_history:{station_id}:h{hours}",
                             f"api/v1/dashboard/stations/{station_id}/history/pm25", {"hours": hours},
                             validate=lambda p: isinstance(p, list))
    try:
        daily, _ = cached_json(f"station_history:{station_id}:d{days}",
                               f"api/v1/dashboard/stations/{station_id}/history/pm25/daily", {"days": days},
                               validate=lambda p: isinstance(p, list))
    except HawanamaUnavailable:
        daily = []
    return {
        "station_id": station_id,
        "hourly": [{"t": r.get("timestamp_utc") or r.get("timestamp"), "pm25": r.get("pm25")} for r in hourly],
        "daily": [{"date": (r.get("timestamp_pk") or r.get("timestamp_utc") or "")[:10], "pm25": r.get("pm25"),
                   "pm25_min": r.get("pm25_min"), "pm25_max": r.get("pm25_max")} for r in daily],
        "metadata": _meta_out(m1),
    }


# ---------------------------------------------------------------------------
# Daily PM2.5 estimate — tiles on temp-slider1
# ---------------------------------------------------------------------------

def tile_dates(limit=365):
    limit = max(1, min(int(limit), 365))
    data, meta = cached_json(f"tile_dates:{limit}", "api/v1/ops/pipeline/tiles/dates", {"limit": limit},
                             ttl_name="tile_dates",
                             validate=lambda p: isinstance(p, dict) and isinstance(p.get("details"), list))
    dates = [d["date"] for d in data["details"] if d.get("complete") and _DATE_RE.match(d.get("date", ""))]
    dates.sort()
    return {"dates": dates, "today_pkt": data.get("today_pkt"), "colorscale": COLORSCALE,
            "bounds": list(TILE_BOUNDS), "minzoom": TILE_MIN_ZOOM, "maxzoom": TILE_MAX_ZOOM,
            "metadata": _meta_out(meta)}


def _tile_lonlat_bounds(z, x, y):
    n = 2 ** z
    lon_w = x / n * 360.0 - 180.0
    lon_e = (x + 1) / n * 360.0 - 180.0
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return lon_w, lat_s, lon_e, lat_n


def tile_in_coverage(z, x, y):
    if not (TILE_MIN_ZOOM <= z <= TILE_MAX_ZOOM) or not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
        return False
    w, s, e, n = _tile_lonlat_bounds(z, x, y)
    bw, bs, be, bn = TILE_BOUNDS
    return not (e < bw or w > be or n < bs or s > bn)


_EMPTY_TILE = None


def empty_tile_png():
    """A transparent 256x256 PNG for tiles outside coverage (built once)."""
    global _EMPTY_TILE
    if _EMPTY_TILE is None:
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGBA", (256, 256), (0, 0, 0, 0)).save(buf, format="PNG", optimize=True)
        _EMPTY_TILE = buf.getvalue()
    return _EMPTY_TILE


def tile_png(date, z, x, y):
    """Returns (png_bytes, cacheable). Out-of-coverage tiles are an empty
    PNG without any upstream call. Tiles for a COMPLETE date are cached on
    disk permanently (they never change); today's are not cached.
    Raises HawanamaUnavailable if the upstream tile cannot be fetched."""
    if not _DATE_RE.match(date or ""):
        raise ValueError("invalid date")
    if not tile_in_coverage(z, x, y):
        return empty_tile_png(), True
    path = os.path.join(_media_dir(_TILE_SUBDIR), date, str(z), str(x), f"{y}.png")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as f:
            return f.read(), True

    key = f"tile:{date}"
    if time.time() - _last_failure.get(key, 0) < 60:
        raise HawanamaUnavailable("tile upstream recently failed")
    try:
        png = _http_get(f"api/v1/ops/pipeline/tiles/{date}/{z}/{x}/{y}.png", {"smoothed": "true"}, binary=True)
        if not png.startswith(b"\x89PNG"):
            raise ValueError("upstream tile is not a PNG")
    except Exception:
        _last_failure[key] = time.time()
        logger.warning("hawanama_client: tile fetch failed %s/%s/%s/%s", date, z, x, y, exc_info=True)
        raise HawanamaUnavailable("tile unavailable")
    _last_failure.pop(key, None)

    try:
        complete = date in tile_dates()["dates"]
    except HawanamaUnavailable:
        complete = False
    if complete:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp{os.getpid()}.{threading.get_ident()}"
        with open(tmp, "wb") as f:
            f.write(png)
        os.replace(tmp, path)
    return png, complete


def point_value(date, lat, lon):
    if not _DATE_RE.match(date or ""):
        raise ValueError("invalid date")
    lat, lon = round(float(lat), 3), round(float(lon), 3)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("invalid coordinates")
    data, meta = cached_json(f"point:{date}:{lat}:{lon}", f"api/v1/ops/pipeline/tiles/{date}/point",
                             {"lat": lat, "lon": lon}, ttl_name="point",
                             validate=lambda p: isinstance(p, dict) and "pm25" in p)
    return {"date": date, "lat": lat, "lon": lon, "pm25": data.get("pm25"), "unit": COLORSCALE["unit"],
            "metadata": _meta_out(meta)}


def stations_daily_geojson(date):
    """Daily station means for `date` (Pakistan) — the archive point
    layer synced to the daily estimate's slider date."""
    if not _DATE_RE.match(date or ""):
        raise ValueError("invalid date")
    data, meta = cached_json(f"stations_daily:{date}", f"api/v1/ops/pipeline/stations/daily/{date}",
                             {"min_hours": 6, "country": "Pakistan"}, ttl_name="stations_daily",
                             validate=_valid_stations)
    providers = _providers()
    inside = _pakistan_filter()
    feats = []
    for st in data["stations"]:
        lon, lat = st.get("lon"), st.get("lat")
        if lon is None or lat is None or not inside(lon, lat):
            continue
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [_r5(lon), _r5(lat)]},
                      "properties": {"id": st.get("station_id"), "name": st.get("name"), "city": st.get("city"),
                                     "pm25": st.get("pm25"), "valid_hours": st.get("valid_hours"),
                                     "complete": st.get("complete"), "network": _network_for(st, providers),
                                     "date": date}})
    return {"type": "FeatureCollection", "features": feats,
            "metadata": {**_meta_out(meta), "date": date, "count": len(feats)}}


# ---------------------------------------------------------------------------
# Forecast grid (+3..+72 h) — rendered to PNG frames for temp-slider1
# ---------------------------------------------------------------------------

# Google "Turbo" colormap, polynomial approximation (Mikhailov 2019),
# matching Hawanama's own turbo scale so NCOP reads the same colours.
_TURBO_R = (0.13572138, 4.61539260, -42.66032258, 132.13108234, -152.94239396, 59.28637943)
_TURBO_G = (0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604)
_TURBO_B = (0.10667330, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973)


def turbo_rgb(t):
    """t in [0,1] (array) -> uint8 (...,3) RGB."""
    t = np.clip(np.asarray(t, dtype=np.float64), 0.0, 1.0)
    powers = np.stack([t ** i for i in range(6)], axis=-1)
    rgb = np.stack([powers @ np.array(_TURBO_R), powers @ np.array(_TURBO_G), powers @ np.array(_TURBO_B)], axis=-1)
    return (np.clip(rgb, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def _merc_y(lat):
    return np.log(np.tan(np.pi / 4.0 + np.radians(lat) / 2.0))


def render_grid_png(values, shape, bounds, row_order="south_to_north", vmin=None, vmax=None, upscale=4):
    """Renders a regular lat/lon grid of PM2.5 to an RGBA PNG positioned for
    a Mapbox image source. Mapbox stretches an image source linearly in
    Web Mercator between its corners, so rows are resampled to equal
    Mercator spacing (nearest), otherwise mid-latitude rows would sit up
    to ~0.1 deg off. NaN/None -> transparent. Returns (png_bytes, coords)
    with coords = [[w,n],[e,n],[e,s],[w,s]] (cell edges)."""
    from PIL import Image

    vmin = COLORSCALE["vmin"] if vmin is None else vmin
    vmax = COLORSCALE["vmax"] if vmax is None else vmax
    rows, cols = int(shape[0]), int(shape[1])
    arr = np.array([np.nan if v is None else v for v in values], dtype=np.float64).reshape(rows, cols)
    if row_order == "south_to_north":
        arr = arr[::-1]  # image row 0 = north
    res_lat = (bounds["north"] - bounds["south"]) / max(rows - 1, 1)
    res_lon = (bounds["east"] - bounds["west"]) / max(cols - 1, 1)
    north, south = bounds["north"] + res_lat / 2, bounds["south"] - res_lat / 2
    west, east = bounds["west"] - res_lon / 2, bounds["east"] + res_lon / 2

    out_rows, out_cols = rows * upscale, cols * upscale
    my = np.linspace(_merc_y(north), _merc_y(south), out_rows, endpoint=False) + (_merc_y(south) - _merc_y(north)) / out_rows / 2
    lat = np.degrees(2.0 * np.arctan(np.exp(my)) - np.pi / 2.0)
    src_r = np.clip(((north - lat) / (north - south) * rows).astype(int), 0, rows - 1)
    src_c = np.clip((np.arange(out_cols) + 0.5) / upscale, 0, cols - 1).astype(int)
    grid = arr[src_r][:, src_c]

    valid = np.isfinite(grid)
    rgba = np.zeros(grid.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = turbo_rgb((np.where(valid, grid, vmin) - vmin) / (vmax - vmin))
    rgba[..., 3] = np.where(valid, 255, 0)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG", optimize=True)
    coords = [[round(west, 5), round(north, 5)], [round(east, 5), round(north, 5)],
              [round(east, 5), round(south, 5)], [round(west, 5), round(south, 5)]]
    return buf.getvalue(), coords


def forecast_frames(build_url):
    """Gridded PM2.5 forecast (Hawanama, beta) as image frames. Each lead
    is rendered once per forecast run (keyed by init_time) and cached on
    disk; `build_url(filename)` turns a cached file name into the URL the
    browser loads (MEDIA_URL-based, decided by the view)."""
    index, meta = cached_json("forecast_index", "api/v1/forecast-grid/latest",
                              validate=lambda p: isinstance(p, dict) and isinstance(p.get("leads"), list))
    init = index.get("init_time") or ""
    run_tag = re.sub(r"[^0-9]", "", init)[:12] or "unknown"
    out_dir = _media_dir(_FORECAST_SUBDIR)
    frames = []
    for lead in index["leads"]:
        lead_h = int(lead.get("lead_h"))
        name = f"pm25_fc_{run_tag}_{lead_h:03d}.png"
        meta_name = f"{name}.json"
        png_path, meta_path = os.path.join(out_dir, name), os.path.join(out_dir, meta_name)
        coords = None
        if os.path.exists(png_path) and os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    coords = json.load(f)["coordinates"]
            except (OSError, ValueError, KeyError):
                coords = None
        if coords is None:
            try:
                grid, _ = cached_json(f"forecast_lead:{run_tag}:{lead_h}", f"api/v1/forecast-grid/latest/{lead_h}",
                                      ttl_name="forecast_lead",
                                      validate=lambda p: isinstance(p, dict) and isinstance(p.get("pm25"), list))
                png, coords = render_grid_png(grid["pm25"], grid["grid"]["shape"], grid["grid"]["bounds"],
                                              grid["grid"].get("row_order", "south_to_north"))
            except Exception:
                logger.warning("hawanama_client: forecast lead %s render failed", lead_h, exc_info=True)
                continue
            tmp = f"{png_path}.tmp{os.getpid()}"
            with open(tmp, "wb") as f:
                f.write(png)
            os.replace(tmp, png_path)
            with open(meta_path, "w") as f:
                json.dump({"coordinates": coords}, f)
        frames.append({"lead_h": lead_h, "valid_time": lead.get("valid_time"), "url": build_url(name),
                       "coordinates": coords, "stats": lead.get("stats")})
    _prune_forecast_dir(out_dir, keep_run=run_tag)
    return {"init_time": init, "model_tag": index.get("model_tag"), "beta": bool(index.get("beta", True)),
            "colorscale": COLORSCALE, "frames": frames,
            "metadata": _meta_out(meta, init, _DATA_STALE_HOURS["forecast"])}


def _prune_forecast_dir(out_dir, keep_run, keep_runs=4):
    """Keeps the newest `keep_runs` forecast runs' frames on disk."""
    try:
        runs = sorted({m.group(1) for m in (re.match(r"pm25_fc_(\d+)_", n) for n in os.listdir(out_dir)) if m})
        for old in runs[:-keep_runs]:
            if old == keep_run:
                continue
            for n in os.listdir(out_dir):
                if n.startswith(f"pm25_fc_{old}_"):
                    os.remove(os.path.join(out_dir, n))
    except OSError:
        logger.warning("hawanama_client: forecast cache prune failed", exc_info=True)


# ---------------------------------------------------------------------------
# Station nowcast (+3/6/12/24 h) — temporal point layer
# ---------------------------------------------------------------------------

def nowcast_geojson():
    data, meta = cached_json("nowcast", "api/v1/nowcast/latest",
                             validate=lambda p: isinstance(p, dict) and isinstance(p.get("stations"), list))
    inside = _pakistan_filter()
    leads = [int(x) for x in data.get("leads") or []]
    feats = []
    for st in data["stations"]:
        lon, lat = st.get("longitude"), st.get("latitude")
        if lon is None or lat is None or not inside(lon, lat):
            continue
        props = {"id": st.get("station_id"), "name": st.get("station_name"), "city": st.get("city"),
                 "basis": st.get("basis"), "forecastable": bool(st.get("forecastable")),
                 "last_obs": st.get("last_obs"), "obs_age_h": st.get("obs_age_h")}
        for ld in st.get("leads") or []:
            h = int(ld.get("lead_hours"))
            props[f"pm25_{h}"] = ld.get("pm25")
            props[f"q75_{h}"] = ld.get("q75")
            props[f"q90_{h}"] = ld.get("q90")
            props[f"valid_{h}"] = ld.get("valid_time")
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [_r5(lon), _r5(lat)]},
                      "properties": props})
    valid_times = {}
    for st in data["stations"]:
        for ld in st.get("leads") or []:
            valid_times.setdefault(int(ld.get("lead_hours")), ld.get("valid_time"))
    return {"type": "FeatureCollection", "features": feats,
            "metadata": {**_meta_out(meta, data.get("init_time"), _DATA_STALE_HOURS["nowcast"]),
                         "init_time": data.get("init_time"), "model_tag": data.get("model_tag"),
                         "leads": leads, "valid_times": {str(k): v for k, v in valid_times.items()},
                         "count": len(feats)}}


# ---------------------------------------------------------------------------
# Fires — smoke-source outlook (points) and rice-season statistics (chart)
# ---------------------------------------------------------------------------

def fires_outlook_geojson():
    data, meta = cached_json("fires_outlook", "api/v1/fires/outlook",
                             validate=lambda p: isinstance(p, dict) and isinstance(p.get("cities"), list))
    feats = []
    for c in data["cities"]:
        d1 = c.get("d1") or {}
        if c.get("lon") is None or c.get("lat") is None:
            continue
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [_r5(c["lon"]), _r5(c["lat"])]},
                      "properties": {"city": c.get("city"), "province": c.get("province"), "band": d1.get("band"),
                                     "upwind_load_mw": d1.get("upwind_load_mw"),
                                     "fires_in_cone": d1.get("fires_in_cone"), "from_compass": d1.get("from_compass"),
                                     "by_country": json.dumps(d1.get("by_country") or {})}})
    defs = data.get("definitions") or {}
    return {"type": "FeatureCollection", "features": feats,
            "metadata": {**_meta_out(meta, data.get("generated_at"), _DATA_STALE_HOURS["fires_outlook"]),
                         "model": data.get("model"), "lead": (data.get("summary") or {}).get("lead"),
                         "fires_as_of": data.get("fires_as_of"),
                         "not_pm25": defs.get("not_pm25"), "not_causation": defs.get("not_causation"),
                         "bands": defs.get("bands"), "bands_status": defs.get("bands_status"),
                         "caveats": data.get("caveats") or []}}


def fire_season(region, season="rice"):
    if region not in FIRE_SEASON_REGIONS or season not in FIRE_SEASONS:
        raise ValueError("unsupported region/season")
    data, meta = cached_json(f"fires_seasons:{region}:{season}", "api/v1/fires/seasons",
                             {"region": region, "season": season, "basis": "all"},
                             validate=lambda p: isinstance(p, dict) and isinstance(p.get("years"), list))
    years = [{"year": y.get("year"), "role": y.get("role"), "cum": y.get("cum"), "r7": y.get("r7"),
              "total_to_date": y.get("total_to_date"), "complete": y.get("complete")} for y in data["years"]]
    return {"region": data.get("region"), "season": data.get("season"), "days": data.get("days"),
            "today_index": data.get("today_index"), "years": years, "headline": data.get("headline"),
            "caveats": data.get("caveats") or [], "metadata": _meta_out(meta)}


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def health():
    """Hawanama's own source freshness plus NCOP's cache state per key."""
    try:
        data, meta = cached_json("freshness", "api/v1/health/freshness",
                                 validate=lambda p: isinstance(p, dict) and "sources" in p)
        upstream = [{k: s.get(k) for k in ("source", "status", "age_min", "threshold_min", "latest_ts")}
                    for s in data.get("sources") or []]
        upstream_meta = _meta_out(meta)
    except HawanamaUnavailable:
        upstream, upstream_meta = None, {"stale": True, "attribution": ATTRIBUTION}
    now = time.time()
    with _mem_lock:
        cache = {k: {"age_s": round(now - v[0]), "ttl_s": _TTL_SECONDS.get(k.split(":", 1)[0])}
                 for k, v in _mem_cache.items() if not k.startswith(("point:", "station_history:"))}
    failing = {k: round(now - t) for k, t in _last_failure.items() if now - t < _RETRY_BACKOFF_SECONDS}
    return {"upstream_sources": upstream, "upstream_metadata": upstream_meta, "ncop_cache": cache,
            "failing_keys_seconds_ago": failing}
