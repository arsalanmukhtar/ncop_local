# project/ncop_internal/landslide_lhasa2_scan.py
# ---------------------------------------------------------------------------
# Turns the LHASA2 (Meteoblue) daily nowcast — already shown as a display-
# only raster tile layer in the Landslide tab's "Cross-check layers" section
# (map-layers.js's mbx_lhasa2_latest, toggled by landslide-model-control.js)
# — into something actionable: fetch the real tile pixels for Pakistan,
# classify them, vectorize the elevated-probability areas into real
# polygons, and run the SAME exposure machinery (buildings/roads/population)
# every other hazard already uses against those polygons.
#
# Deliberately its own module, not folded into landslide_model.py: this is a
# genuinely separate concern (a live nowcast scan, not the AHP/infinite-
# slope susceptibility pipeline) — same split-by-concern discipline as
# accuracy_assessment.py/landslide_trigger.py already follow.
#
# Nothing here changes the existing display layer, the AHP/infinite-slope
# pipeline, or any of the 3 existing job modes — this only ADDS a 4th,
# independent capability, reusing every heavy-lifting function unmodified:
#   - flood_model.register_custom_aoi / landslide_model.register_custom_
#     landslide_aoi (bbox+polygon -> a real, cached PILOT_CATCHMENTS entry)
#   - flood_exposure._vectorize_multiclass_raster (raster -> real polygons)
#   - flood_exposure._build_exposure_from_geom (geometry -> real buildings/
#     roads/drainage/population exposure)
#
# The one hard architectural constraint this design is built around:
# flood_model.MAX_CATCHMENT_BBOX_DEG2 (0.30 deg^2) caps every AOI in this
# app — Pakistan's own bbox is ~230 deg^2, ~750x over that cap. The whole
# country can NEVER be pushed through the exposure pipeline as one AOI.
# Exposure therefore runs once per extracted, individually-small blob (each
# well under the cap), never once for the national extent — this bounds
# both correctness (register_custom_aoi would just reject an oversized AOI)
# and cost (flood_exposure._OVERTURE_EXECUTOR is a single-worker executor;
# an unbounded blob count would serialize into an unbounded wait, which is
# exactly the "heavy on performance" outcome this feature must avoid).
# ---------------------------------------------------------------------------

import hashlib
import json
import logging
import math
import os
import re
import struct

import numpy as np
from django.conf import settings

from . import flood_exposure, flood_model, landslide_model

logger = logging.getLogger(__name__)

_MEDIA_SUBDIR = os.path.join("landslide_model", "lhasa2_scan")

# Pakistan's own approximate national extent — used ONLY to bound the tile-
# FETCH region (cheap to overshoot; harmless waste, not a correctness
# concern there). Widened from an initial (60.8, 23.5, 77.9, 37.2) after a
# real, live-confirmed gap: the REAL national boundary polygon fetched by
# _fetch_pakistan_boundary() below has its own real bounds out to ~79.31E
# (the eastern/Kashmir extent GeoServer's own national_boundary layer
# carries) — the original 77.9E cap was silently clipping off real
# Pakistani-claimed territory before the real-boundary intersection ever
# got a chance to run. That real boundary polygon (not this bbox) is what
# actually decides which extracted blobs get reported — see its own
# docstring for why a bbox alone is never enough by itself.
_PAKISTAN_BBOX = (60.8, 23.5, 79.6, 37.2)

# The EXACT 11 contourSteps stops baked into the tile URL this app already
# requests client-side — generateMBX_MeteoblueLHASA2LatestLayer,
# frontend/src/modules/time-functions.js (~line 2795). Each pixel's color
# IS its probability bin under Meteoblue's own "contourSteps" renderer (a
# stepped/discrete color ramp, not a smooth gradient) — classification here
# is a nearest-RGB match against this literal stop list, not a decode of a
# raw value channel (the tile format has none). MUST stay byte-identical to
# that frontend string; if that ramp is ever changed there, mirror it here
# too, or this module's classification silently goes stale.
_LHASA2_COLOR_STOPS = (
    (0, (251, 251, 242)),
    (5, (255, 255, 224)),
    (10, (236, 252, 163)),
    (20, (226, 244, 111)),
    (30, (227, 229, 67)),
    (40, (237, 208, 27)),
    (50, (255, 179, 0)),
    (60, (255, 138, 11)),
    (70, (253, 104, 32)),
    (80, (246, 80, 53)),
    (90, (236, 71, 76)),
    (100, (223, 79, 108)),
)
_ALPHA_NODATA_THRESHOLD = 128  # below this, treated as "outside the tile's real data", not a low-probability reading
_NODATA_BYTE = 255  # never a real class value (max real stop is 100), safe sentinel for GDT_Byte

_TILE_SIZE_PX = 512  # matches generateMBX_MeteoblueLHASA2LatestLayer's own source.tileSize
_ZOOM = 6  # the source's own maxzoom (generateMBX_MeteoblueLHASA2LatestLayer) — finest real detail available
_WEB_MERCATOR_HALF_WORLD_M = 20037508.342789244

_METEOBLUE_TIMEOUT_SECONDS = 30  # matches this app's other bounded-external-call convention (flood_exposure._WFS_TIMEOUT_SECONDS)

# Bounds how many extracted blobs get a full exposure pass (Overture/OSM/
# roads/drainage/population, each a real network round-trip) — see module
# docstring's "single-worker executor" note. The rest are still reported,
# by footprint only, honestly labeled as not assessed.
_DEFAULT_MAX_EXPOSURE_BLOBS = 20
_DEFAULT_THRESHOLD_PCT = 50  # the ramp's own visual "elevated" midpoint — a stated heuristic, not a validated cutoff


def _scan_cache_dir():
    out_dir = os.path.join(settings.MEDIA_ROOT, _MEDIA_SUBDIR)
    os.makedirs(out_dir, exist_ok=True)
    return out_dir


def _fetch_lhasa2_latest_time():
    """Server-side twin of time-functions.js's getLatestMeteoblueTimeSync +
    extractLatestMeteoblueTimeValue: same endpoint, same "walk every value,
    keep any 8-10 digit run, take the last one found" extraction (that
    function's own docstring-equivalent comment explains why: the payload
    shape isn't documented, but the latest date always shows up as an
    8-10 digit token somewhere in it). Falls back to yesterday's UTC date
    (same fallback the frontend uses) on any failure — never raises."""
    import requests

    fallback = (
        __import__("datetime").datetime.utcnow() - __import__("datetime").timedelta(days=1)
    ).strftime("%Y%m%d")
    url = (
        f"https://maps-api-cdn.meteoblue.com/v1/time/daily/LHASA2"
        f"?lang=en&apikey={settings.METEOBLUE_TOKEN}"
    )
    try:
        resp = requests.get(url, timeout=_METEOBLUE_TIMEOUT_SECONDS)
        resp.raise_for_status()
        payload = resp.json()
    except Exception:
        logger.warning("landslide_lhasa2_scan: latest-time lookup failed (falling back to %s)", fallback, exc_info=True)
        return fallback

    candidates = []

    def _walk(node):
        if node is None:
            return
        if isinstance(node, list):
            for item in node:
                _walk(item)
        elif isinstance(node, dict):
            for item in node.values():
                _walk(item)
        else:
            for m in re.findall(r"\d{8,10}", str(node)):
                candidates.append(m)

    _walk(payload)
    return candidates[-1] if candidates else fallback


# LANDSLIDE_EARLY_WARNING_METHODOLOGY.md §3.2.3 already scoped this exact
# pipeline and named `mercantile` (already pinned in requirements.txt) as
# the natural tile-math library — the two small functions below are a
# direct, dependency-free implementation of the same standard XYZ/Web-
# Mercator formulas mercantile.tile()/mercantile.xy_bounds() wrap — kept
# as a direct, standard-formula implementation rather than the library
# call, so the exact tile-to-meters math used for georeferencing the
# mosaic is visible in this file rather than one level removed.
def _lonlat_to_tile(lon, lat, zoom):
    n = 2 ** zoom
    x = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def _tile_origin_merc(x, y, zoom):
    """Top-left corner of tile (x, y, zoom) in EPSG:3857 meters."""
    n = 2 ** zoom
    tile_size_m = (2 * _WEB_MERCATOR_HALF_WORLD_M) / n
    x0 = -_WEB_MERCATOR_HALF_WORLD_M + x * tile_size_m
    y0 = _WEB_MERCATOR_HALF_WORLD_M - y * tile_size_m
    return x0, y0, tile_size_m


def _classify_rgba_array(rgba):
    """rgba: (H, W, 4) uint8 array. Returns (H, W) uint8 array of class
    values (one of the 11 real _LHASA2_COLOR_STOPS values, or _NODATA_BYTE).

    Nearest-RGB match against the literal stop list, vectorized (one
    distance computation per stop across the whole tile, not a per-pixel
    Python loop — 12 stops x a few hundred thousand pixels is cheap either
    way, but there's no reason to pay the interpreter overhead)."""
    rgb = rgba[..., :3].astype(np.int32)
    alpha = rgba[..., 3]

    stop_values = np.array([v for v, _ in _LHASA2_COLOR_STOPS], dtype=np.uint8)
    stop_colors = np.array([c for _, c in _LHASA2_COLOR_STOPS], dtype=np.int32)  # (12, 3)

    # (12, H, W) squared distance to each stop's color
    dists = np.sum((rgb[None, ...] - stop_colors[:, None, None, :]) ** 2, axis=-1)
    nearest_idx = np.argmin(dists, axis=0)  # (H, W)
    classified = stop_values[nearest_idx]

    classified = np.where(alpha < _ALPHA_NODATA_THRESHOLD, _NODATA_BYTE, classified)
    return classified.astype(np.uint8)


def _fetch_and_classify_mosaic(bbox, latest_time, force=False):
    """Downloads every LHASA2 tile covering `bbox` at _ZOOM, classifies
    each pixel by nearest-stop-color, stitches into one EPSG:3857 GeoTIFF,
    disk-cached by (latest_time, zoom, bbox) so a same-day re-scan never
    re-fetches/re-decodes tiles. Returns the cached raster path.

    Memory footprint stays small by construction: Pakistan's bbox spans a
    handful of tiles at zoom 6 (n=64, ~5.6 deg/tile) — a few thousand x a
    few thousand pixels, single-band uint8 once classified, nowhere near a
    memory concern."""
    from osgeo import gdal

    digest = hashlib.sha256(f"{tuple(round(v, 3) for v in bbox)}|{_ZOOM}".encode()).hexdigest()[:12]
    out_path = os.path.join(_scan_cache_dir(), f"mosaic_{latest_time}_z{_ZOOM}_{digest}.tif")
    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path

    minx, miny, maxx, maxy = bbox
    x0f, y0f = _lonlat_to_tile(minx, maxy, _ZOOM)  # top-left (max lat, min lon)
    x1f, y1f = _lonlat_to_tile(maxx, miny, _ZOOM)  # bottom-right (min lat, max lon)
    n = 2 ** _ZOOM
    tx0, tx1 = max(0, int(math.floor(x0f))), min(n - 1, int(math.floor(x1f)))
    ty0, ty1 = max(0, int(math.floor(y0f))), min(n - 1, int(math.floor(y1f)))

    cols = tx1 - tx0 + 1
    rows = ty1 - ty0 + 1
    if cols <= 0 or rows <= 0 or cols * rows > 400:
        # A real safety bound, not expected to trigger for a Pakistan-sized
        # bbox at zoom 6 (~12-16 tiles observed) — guards against a caller
        # passing a much larger bbox by mistake blowing up the fetch.
        raise ValueError(f"bbox {bbox!r} at zoom {_ZOOM} resolves to {cols}x{rows} tiles — refusing (too large)")

    mosaic_w = cols * _TILE_SIZE_PX
    mosaic_h = rows * _TILE_SIZE_PX
    mosaic = np.full((mosaic_h, mosaic_w), _NODATA_BYTE, dtype=np.uint8)

    tile_url_tmpl = (
        f"https://maps-api-cdn.meteoblue.com/v1/map/raster/LHASA2/{latest_time}"
        "/963~sfc~daily~none~contourSteps"
        "~-0.1~rgba(251,251,242,1.0)~5.0~rgba(255,255,224,1.0)~10.0~rgba(236,252,163,1.0)"
        "~20.0~rgba(226,244,111,1.0)~30.0~rgba(227,229,67,1.0)~40.0~rgba(237,208,27,1.0)"
        "~50.0~rgba(255,179,0,1.0)~60.0~rgba(255,138,11,1.0)~70.0~rgba(253,104,32,1.0)"
        "~80.0~rgba(246,80,53,1.0)~90.0~rgba(236,71,76,1.0)~100.0~rgba(223,79,108,1.0)"
        "/{z}/{x}/{y}"
        "?temperatureUnit=C&velocityUnit=km%2Fh&lengthUnit=metric&energyUnit=watts"
        f"&internal=true&apikey={settings.METEOBLUE_TOKEN}"
    )

    import requests
    from PIL import Image
    from io import BytesIO

    n_ok, n_missing = 0, 0
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            url = tile_url_tmpl.format(z=_ZOOM, x=tx, y=ty)
            row_off = (ty - ty0) * _TILE_SIZE_PX
            col_off = (tx - tx0) * _TILE_SIZE_PX
            try:
                resp = requests.get(url, timeout=_METEOBLUE_TIMEOUT_SECONDS)
                resp.raise_for_status()
                img = Image.open(BytesIO(resp.content)).convert("RGBA")
                if img.size != (_TILE_SIZE_PX, _TILE_SIZE_PX):
                    img = img.resize((_TILE_SIZE_PX, _TILE_SIZE_PX))
                tile_arr = np.asarray(img, dtype=np.uint8)
                mosaic[row_off:row_off + _TILE_SIZE_PX, col_off:col_off + _TILE_SIZE_PX] = _classify_rgba_array(tile_arr)
                n_ok += 1
            except Exception:
                # A missing/failed tile just stays nodata in the mosaic — an
                # honest gap, not a fabricated reading, and not fatal to the
                # rest of the scan (matches this app's established "an
                # external fetch degrades, it doesn't take the whole
                # feature down" convention).
                n_missing += 1
                logger.warning("landslide_lhasa2_scan: tile z=%d x=%d y=%d fetch/decode failed", _ZOOM, tx, ty, exc_info=True)

    if n_ok == 0:
        raise RuntimeError(f"landslide_lhasa2_scan: all {n_ok + n_missing} LHASA2 tiles failed to fetch — cannot scan")
    if n_missing:
        logger.warning("landslide_lhasa2_scan: %d/%d tiles missing in this scan (treated as nodata)", n_missing, n_ok + n_missing)

    ox0, oy0, tile_size_m = _tile_origin_merc(tx0, ty0, _ZOOM)
    px_size_m = tile_size_m / _TILE_SIZE_PX
    gt = (ox0, px_size_m, 0, oy0, 0, -px_size_m)

    from osgeo import osr
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        ds = gdal.GetDriverByName("GTiff").Create(tmp_path, mosaic_w, mosaic_h, 1, gdal.GDT_Byte)
        if ds is None:
            raise RuntimeError(f"gdal driver.Create failed for {tmp_path}")
        ds.SetGeoTransform(gt)
        ds.SetProjection(srs.ExportToWkt())
        band = ds.GetRasterBand(1)
        band.SetNoDataValue(_NODATA_BYTE)
        for row_idx in range(mosaic_h):
            raw = struct.pack(f"<{mosaic_w}B", *mosaic[row_idx].tolist())
            band.WriteRaster(0, row_idx, mosaic_w, 1, raw, buf_type=gdal.GDT_Byte)
        band.FlushCache()
        ds = None
    os.replace(tmp_path, out_path)
    return out_path


def _reproject_3857_to_4326(geom):
    from pyproj import Transformer
    from shapely.ops import transform as shapely_transform

    transformer = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    reprojected = shapely_transform(transformer.transform, geom)
    return _ensure_valid(reprojected)


def _ensure_valid(geom):
    """A coordinate-wise reprojection (pyproj/shapely.ops.transform) can
    turn an already-valid polygon technically invalid at the margins
    (numerical precision, not a real self-intersection in the source data)
    — confirmed live: a real scan hit GEOSException "side location
    conflict" on .intersects() without this. Same buffer(0) repair
    _vectorize_multiclass_raster's own docstring already documents using
    for the same class of issue, applied here after reprojection too."""
    return geom if geom.is_valid else geom.buffer(0)


_BOUNDARY_SIMPLIFY_TOLERANCE_DEG = 0.001  # ~100m — same order as flood_exposure._ADMIN_BOUNDARY_SIMPLIFY_TOLERANCE_DEG's own reasoning (a real district boundary carries 50k+ vertices; coarse enough for a blob-intersection test, not for a precision cadastral use)


def _fetch_pakistan_boundary(force=False):
    """The REAL national outline (GeoServer's own `national_boundary`
    layer, the exact layer frontend/src/modules/map-layers.js's own
    "National Boundary" catalog entry renders, fetched here via WFS
    through flood_exposure._wfs_get_geojson — same host/workspace/
    degrade-to-empty-on-failure convention that function's own docstring
    already establishes, reused unmodified).

    Why this matters and a plain rectangular `_PAKISTAN_BBOX` is not
    enough on its own: Pakistan's real shape is narrow in the north and
    wide in the south — a bounding rectangle over it also covers large
    parts of India (Punjab/Himachal Pradesh/Kashmir), Afghanistan, Iran,
    and China. CONFIRMED LIVE this is not a hypothetical: an early,
    bbox-only-clipped test run's own single LARGEST extracted feature
    (763 km^2, centroid ~77.52E/30.78N) sat squarely in Himachal Pradesh,
    India, not Pakistan at all — the exact same class of problem this
    project's own OSM ground-truth research already found and reported
    honestly (§L3.5's "17 raw features, 1 real Pakistan point" finding).
    `_PAKISTAN_BBOX` stays as the (cheap, coarse, harmless-to-overshoot)
    tile-FETCH region; this real polygon is what actually decides which
    extracted blobs are reported at all.

    Disk-cached indefinitely (a national border does not change day to
    day) at media/landslide_model/lhasa2_scan/pakistan_boundary.geojson;
    `force=True` refetches. Returns a shapely (Multi)Polygon, or None if
    the WFS is unreachable — the caller degrades to the bbox-only clip
    in that case (an honest, coarser fallback, not a hard failure)."""
    import shapely.geometry as shapely_geometry
    from shapely.ops import unary_union

    cache_path = os.path.join(_scan_cache_dir(), "pakistan_boundary.geojson")
    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                return _ensure_valid(shapely_geometry.shape(json.load(f)))
        except Exception:
            logger.warning("landslide_lhasa2_scan: cached national boundary unreadable — refetching", exc_info=True)

    features = flood_exposure._wfs_get_geojson("national_boundary", _PAKISTAN_BBOX)
    if not features:
        logger.warning("landslide_lhasa2_scan: national_boundary WFS returned nothing — "
                        "falling back to the plain bbox clip (coarser, may include neighboring countries)")
        return None

    geoms = [shapely_geometry.shape(f["geometry"]) for f in features]
    boundary = _ensure_valid(unary_union(geoms)).simplify(_BOUNDARY_SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(shapely_geometry.mapping(boundary), f)
    except Exception:
        logger.warning("landslide_lhasa2_scan: could not cache national boundary (non-fatal)", exc_info=True)
    return boundary


def extract_and_assess_lhasa2_features(
    threshold_pct=_DEFAULT_THRESHOLD_PCT,
    max_exposure_blobs=_DEFAULT_MAX_EXPOSURE_BLOBS,
    force=False,
    progress_callback=None,
):
    """The main entry point: real LHASA2 tiles -> classified raster ->
    vectorized "probable landslide" polygons -> real exposure (buildings/
    roads/drainage/population) for the largest `max_exposure_blobs` of
    them. Everything reused unmodified per this module's own docstring.

    `threshold_pct` — a class is "probable" if its value >= this. A stated
    heuristic (the color ramp's own visual "elevated" midpoint), NOT a
    literature-validated cutoff for this specific product's 0-100 scale —
    reported honestly in the result, not presented as calibrated.

    Returns {"latest_time", "threshold_pct", "n_features_total",
    "n_features_assessed", "features": [...], "totals": {...}} — see
    inline comments below for exactly what each feature/total carries."""
    def _stage(name):
        if progress_callback:
            try:
                progress_callback(name)
            except Exception:
                logger.warning("landslide_lhasa2_scan: progress_callback raised (ignored)", exc_info=True)

    _stage("Fetching latest LHASA2 nowcast")
    latest_time = _fetch_lhasa2_latest_time()
    mosaic_path = _fetch_and_classify_mosaic(_PAKISTAN_BBOX, latest_time, force=force)

    _stage("Classifying & vectorizing probable-landslide areas")
    class_labels = {v: f"{v}-{v + 10 if v < 100 else 100}%" for v, _ in _LHASA2_COLOR_STOPS if v >= threshold_pct}
    if not class_labels:
        raise ValueError(f"threshold_pct={threshold_pct!r} excludes every real class (valid stops: "
                          f"{[v for v, _ in _LHASA2_COLOR_STOPS]})")

    polys_by_class_merc = flood_exposure._vectorize_multiclass_raster(
        mosaic_path, class_labels, sieve_threshold_px=9,
    )
    if not polys_by_class_merc:
        return {
            "latest_time": latest_time, "threshold_pct": threshold_pct,
            "n_features_total": 0, "n_features_assessed": 0,
            "features": [], "totals": _empty_totals(),
            "note": "No pixels reached the elevated-probability threshold in this scan — a real, honest zero, not a fetch failure.",
        }

    polys_by_class = {v: _reproject_3857_to_4326(g) for v, g in polys_by_class_merc.items()}

    from shapely.geometry import box

    # Clip to the REAL national outline when reachable, not just the
    # bounding rectangle (see _fetch_pakistan_boundary's own docstring —
    # a rectangle over Pakistan also covers real chunks of India/
    # Afghanistan/Iran/China; confirmed live to matter, not theoretical).
    pk_geom = _fetch_pakistan_boundary(force=force) or box(*_PAKISTAN_BBOX)

    # Real bug found and fixed during live testing (not theoretical): an
    # earlier version unioned every class's geometry together FIRST, then
    # split the result into blobs purely by spatial connectivity, then
    # labelled each blob with the HIGHEST class touching it anywhere. At
    # low thresholds the near-ubiquitous low-probability class is
    # contiguous with almost everything else, so this glued the whole
    # country into one "blob" and mislabelled it with whatever elevated
    # class happened to touch it anywhere in the country — confirmed live:
    # a 980,191 km^2 "feature" got reported as "class >= 30%" even though
    # 30% real class-30 area anywhere in Pakistan was only 12.4 km^2. Fixed
    # by NEVER unioning across classes: each class's own (already correct,
    # already dissolved-within-itself) geometry from
    # flood_exposure._vectorize_multiclass_raster is split into its own
    # connected parts and each part keeps ITS OWN real class — adjacent
    # patches of DIFFERENT classes are intentionally reported as separate
    # features (each accurately labelled), never merged into one blob
    # carrying a neighbor's class.
    blobs = []  # list of (class_pct, shapely geometry)
    for v, geom in polys_by_class.items():
        clipped = _ensure_valid(geom).intersection(pk_geom)
        if clipped.is_empty:
            continue
        parts = list(clipped.geoms) if hasattr(clipped, "geoms") else [clipped]
        for p in parts:
            if not p.is_empty and p.area > 0:
                blobs.append((v, p))
    # Largest first — exposure is spent on the biggest/most-established
    # extents first when the per-scan cap bites, not an arbitrary order.
    blobs.sort(key=lambda vp: vp[1].area, reverse=True)

    _stage(f"Assessing exposure for {min(len(blobs), max_exposure_blobs)} of {len(blobs)} features")
    features = []
    totals = _empty_totals()
    for i, (peak_class, blob) in enumerate(blobs):
        area_km2 = round(flood_exposure._geom_area_km2(blob), 3)
        centroid = [round(blob.centroid.x, 5), round(blob.centroid.y, 5)]
        feature = {
            "id": f"lhasa2_{i}",
            "area_km2": area_km2,
            "centroid": centroid,
            "probability_class_min_pct": peak_class,
            "geometry": json.loads(_shapely_to_geojson(blob)),
            "assessed": False,
            "exposure": None,
        }

        if i < max_exposure_blobs:
            assess_geom = blob
            minx, miny, maxx, maxy = blob.bounds
            bbox_area = (maxx - minx) * (maxy - miny)
            clipped = False
            if bbox_area > flood_model.MAX_CATCHMENT_BBOX_DEG2:
                # Real, documented safety clamp (see module docstring) —
                # not expected in practice at this tile resolution, but a
                # blob must never be allowed to exceed the same AOI cap
                # every other feature in this app respects. Clips the GEOM
                # itself (not just the bbox) so exposure counts and the
                # displayed shape stay consistent with each other.
                half_side = math.sqrt(flood_model.MAX_CATCHMENT_BBOX_DEG2) / 2.0
                cx, cy = blob.centroid.x, blob.centroid.y
                cap_box = box(cx - half_side, cy - half_side, cx + half_side, cy + half_side)
                assess_geom = blob.intersection(cap_box)
                clipped = True
            bbox = list(assess_geom.bounds)
            try:
                catchment_key = landslide_model.register_custom_landslide_aoi(
                    bbox, polygon_geojson=json.loads(_shapely_to_geojson(assess_geom)),
                )
                exposure = flood_exposure._build_exposure_from_geom(
                    catchment_key, bbox, assess_geom, force, lambda s: None,
                )
                feature["assessed"] = True
                feature["clipped_to_aoi_cap"] = clipped
                feature["exposure"] = exposure
                _accumulate_totals(totals, exposure)
            except Exception:
                logger.warning("landslide_lhasa2_scan: exposure assessment failed for blob %d (area=%.3f km^2)", i, area_km2, exc_info=True)

        features.append(feature)

    return {
        "latest_time": latest_time,
        "threshold_pct": threshold_pct,
        "n_features_total": len(blobs),
        "n_features_assessed": sum(1 for f in features if f["assessed"]),
        "features": features,
        "totals": totals,
    }


def _empty_totals():
    return {
        "buildings_in_zone": 0,
        "total_buildings_in_aoi": 0,
        "roads_length_in_zone_km": 0.0,
        "population_in_zone": 0,
        "note": "Sums across ASSESSED features only — never extrapolated to unassessed ones.",
    }


def _accumulate_totals(totals, exposure):
    buildings = exposure.get("buildings") or {}
    roads = exposure.get("roads") or {}
    population = exposure.get("population") or {}
    totals["buildings_in_zone"] += buildings.get("buildings_in_flood_zone", 0) or 0
    totals["total_buildings_in_aoi"] += buildings.get("total_buildings_in_aoi", 0) or 0
    totals["roads_length_in_zone_km"] = round(
        totals["roads_length_in_zone_km"] + (roads.get("length_in_flood_zone_km", 0.0) or 0.0), 2,
    )
    totals["population_in_zone"] += population.get("total", 0) or 0


def _shapely_to_geojson(geom):
    from shapely.geometry import mapping
    return json.dumps(mapping(geom))
