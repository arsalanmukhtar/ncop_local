# project/ncop_internal/landslide_regional_comparison.py
# ---------------------------------------------------------------------------
# An independent spatial cross-check of our own AHP susceptibility raster
# against 4 real, regionally-produced landslide-susceptibility rasters the
# user pointed at (KP/Balochistan/AJK/GB) on a SECOND GeoServer instance
# (settings.NCOP_LANDSLIDE_GEOSERVER_HOST, formerly 172.18.1.100:8080) — a completely separate host from every other data
# source this app already uses. Direct investigation (WMS/WCS
# GetCapabilities + DescribeCoverage, all live, not assumed) found these 4
# are WCS raster COVERAGES, not WFS vectors — real GeoTIFFs at 10m/px
# native resolution, each in its own native CRS (KP/Balochistan in
# EPSG:32642, AJK/GB in EPSG:32643), independently produced from ours (no
# shared code path, no shared weight table) — a genuine second opinion,
# not a circular check.
#
# Deliberately comparison-only, per explicit scope confirmation: this
# module NEVER feeds its own result back into AHP weights or the
# susceptibility score itself — it only reports an honest agreement
# number. See landslide_model.py's own L3/LOCO framework for where real
# calibration happens (Frequency-Ratio, fit against real ground truth,
# never against these regional products).
#
# Every GDAL/reprojection technique here reuses an existing, already-
# proven function verbatim:
#   - flood_model._warp_to_grid — reprojects+resamples an arbitrary-CRS
#     source raster onto our own reference raster's exact grid in ONE
#     gdal.Warp call (already handles the CRS transform internally via
#     dstSRS="EPSG:4326" — no manual reprojection math needed here).
#   - flood_model._read_raster_array / flood_model._gdal_lock — the same
#     raw ReadRaster/struct + GDAL-call-serialization discipline every
#     other raster read in this codebase already follows.
# The only genuinely new GDAL work is the WCS GetCoverage fetch itself
# (a real external protocol none of this app's existing fetchers use yet).
# ---------------------------------------------------------------------------

import hashlib
import logging
import os

import numpy as np
from django.conf import settings

from . import flood_model, landslide_model

logger = logging.getLogger(__name__)

_MEDIA_SUBDIR = os.path.join("landslide_model", "regional_comparison")

_GEOSERVER_HOST = getattr(settings, "NCOP_LANDSLIDE_GEOSERVER_HOST", "172.18.1.113:8080")
_WORKSPACE = "landslide"
_WCS_TIMEOUT_SECONDS = 60  # a real GeoTIFF subset fetch, generous but bounded (matches this app's other external-fetch convention)

# Coverage id / native CRS / native bounds (E/N, i.e. easting/northing in
# that CRS) — all 4 confirmed live via WCS DescribeCoverage this session,
# not guessed or copied from the user's own WMS preview URLs (whose own
# bbox/srs params are request-time reprojection targets, not necessarily
# the coverage's real native extent — GB's own `LSM` coverage in
# particular is natively EPSG:32643, even though the user's own WMS
# preview URL requested it reprojected to EPSG:4326).
_REGIONS = {
    "kp": {
        "coverage_id": "kp_LS_susceptibiility", "epsg": 32642,
        "bounds": (520820.1198915791, 3434901.5057707, 1024310.119891579, 4111221.5057707),
    },
    "balochistan": {
        "coverage_id": "LS_Susc_Bal", "epsg": 32642,
        "bounds": (-295661.9669901304, 2752415.6569107124, 627768.0330098696, 3550625.6569107124),
    },
    "ajk": {
        "coverage_id": "AJK_LS_susceptibiility", "epsg": 32643,
        "bounds": (318533.84375, 3582735.75, 486971.34375, 3926210.75),
    },
    "gb": {
        "coverage_id": "LSM", "epsg": 32643,
        "bounds": (271136.89419540006, 3818747.519223538, 759711.8941954001, 4108722.519223538),
    },
}

# A standard, commonly-cited descriptive scale for correlation-coefficient
# strength (not this project's own invention, and NOT the AUC bands
# reused elsewhere — a Spearman r is a different statistic and needed its
# own, honestly-labelled scale rather than borrowing one that doesn't
# apply). Thresholds on |r|.
_CORRELATION_BANDS = (
    (0.7, "strong"),
    (0.5, "moderate"),
    (0.3, "weak"),
    (0.0, "negligible"),
)


def _interpret_correlation(r):
    if r is None or (isinstance(r, float) and np.isnan(r)):
        return "undefined"
    abs_r = abs(r)
    for threshold, label in _CORRELATION_BANDS:
        if abs_r >= threshold:
            return label
    return "negligible"


def _region_bounds_4326(region_key):
    """Reprojects a region's own native-CRS bounds to EPSG:4326 (its 4
    corners, not just 2, since a UTM->geographic reprojection is not
    axis-aligned in general) — used only for the cheap bbox-overlap test
    below, computed once per call (these coordinates never change)."""
    from pyproj import Transformer

    region = _REGIONS[region_key]
    minx, miny, maxx, maxy = region["bounds"]
    transformer = Transformer.from_crs(f"EPSG:{region['epsg']}", "EPSG:4326", always_xy=True)
    corners = [(minx, miny), (minx, maxy), (maxx, miny), (maxx, maxy)]
    lons, lats = zip(*(transformer.transform(x, y) for x, y in corners))
    return min(lons), min(lats), max(lons), max(lats)


def _bbox_overlap_area(a, b):
    """Plain rectangle-intersection area (degrees^2) — 0 if disjoint.
    Only used to pick the best-overlapping region for a catchment, not
    for anything requiring geodetic precision."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    return (ix1 - ix0) * (iy1 - iy0)


def _best_overlapping_region(bbox_4326):
    """Returns the region_key that best represents `bbox_4326`, or None
    if no region overlaps at all.

    A real bug found and fixed during live testing, not theoretical: a
    naive "pick whichever region's own bounding RECTANGLE overlaps the
    catchment most" test picked "kp" for `ajk_muzaffarabad` — confirmed
    live, both regions' own reprojected 4326 bounding rectangles fully
    contain that catchment's bbox (each gives the exact same 0.09 deg^2
    overlap = full containment), because a UTM-zone coverage's
    axis-aligned bounding rectangle, once reprojected to geographic
    coordinates, is a loose superset that spills well outside the real
    province it covers (KP's own reprojected rectangle spans a huge
    69.2-74.9E/30.9-37.1N — engulfing AJK's real territory too, not just
    KP's own). Plain overlap AREA can't tell these apart when a
    catchment sits inside the loose one's engulfed portion.

    Fixed by preferring, among every region whose rectangle (near-)fully
    CONTAINS the catchment bbox (>=99% of its own area), the one with the
    SMALLEST own bounding-rectangle area — a tighter, more specific
    rectangle containing the catchment is a stronger, more specific
    signal of being the real matching province than a much larger, looser
    one that merely also happens to span that area. Confirmed live this
    correctly resolves ajk_muzaffarabad -> "ajk" (AJK's own rectangle is
    ~5.8 deg^2 vs. KP's ~35.3 deg^2).

    Falls back to whichever region has the single largest overlap
    FRACTION (of the catchment's own area) when no region fully contains
    it — the real, expected shape for a catchment straddling a
    provincial boundary (besham_chilas_kkh spans KP/GB)."""
    cminx, cminy, cmaxx, cmaxy = bbox_4326
    cbbox_area = (cmaxx - cminx) * (cmaxy - cminy)
    if cbbox_area <= 0:
        return None

    candidates = []  # (region_key, overlap_fraction, region_rect_area)
    for region_key in _REGIONS:
        region_bounds = _region_bounds_4326(region_key)
        overlap = _bbox_overlap_area(bbox_4326, region_bounds)
        if overlap <= 0:
            continue
        rminx, rminy, rmaxx, rmaxy = region_bounds
        region_rect_area = (rmaxx - rminx) * (rmaxy - rminy)
        candidates.append((region_key, overlap / cbbox_area, region_rect_area))

    if not candidates:
        return None

    fully_containing = [c for c in candidates if c[1] >= 0.99]
    if fully_containing:
        return min(fully_containing, key=lambda c: c[2])[0]
    return max(candidates, key=lambda c: c[1])[0]


def _regional_cache_dir():
    out_dir = os.path.join(settings.MEDIA_ROOT, _MEDIA_SUBDIR)
    os.makedirs(out_dir, exist_ok=True)
    return out_dir


def _fetch_regional_coverage_for_bbox(region_key, bbox_4326, force=False):
    """WCS GetCoverage for `region_key`, subset to (a small pad around)
    `bbox_4326` reprojected into the coverage's own native CRS — never
    pulls the full ~50,000x67,000px raster, only the small pilot-
    catchment-sized window actually needed. Disk-cached per (region,
    bbox) like every other expensive external fetch in this codebase.

    Returns the cached GeoTIFF path, or None if the WCS fetch failed or
    the requested bbox doesn't actually intersect this region's own real
    coverage bounds (degrades gracefully — never raises)."""
    import requests
    from pyproj import Transformer

    region = _REGIONS[region_key]
    digest = hashlib.sha256(f"{tuple(round(v, 4) for v in bbox_4326)}".encode()).hexdigest()[:12]
    cache_path = os.path.join(_regional_cache_dir(), f"{region_key}_{digest}.tif")
    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        return cache_path

    transformer = Transformer.from_crs("EPSG:4326", f"EPSG:{region['epsg']}", always_xy=True)
    minx, miny, maxx, maxy = bbox_4326
    corners = [(minx, miny), (minx, maxy), (maxx, miny), (maxx, maxy)]
    xs, ys = zip(*(transformer.transform(x, y) for x, y in corners))
    req_minx, req_maxx = min(xs), max(xs)
    req_miny, req_maxy = min(ys), max(ys)

    rminx, rminy, rmaxx, rmaxy = region["bounds"]
    sub_minx, sub_maxx = max(req_minx, rminx), min(req_maxx, rmaxx)
    sub_miny, sub_maxy = max(req_miny, rminy), min(req_maxy, rmaxy)
    if sub_maxx <= sub_minx or sub_maxy <= sub_miny:
        logger.info("landslide_regional_comparison: bbox %r does not intersect region %r's own real coverage bounds", bbox_4326, region_key)
        return None

    url = (
        f"http://{_GEOSERVER_HOST}/geoserver/{_WORKSPACE}/wcs"
        f"?service=WCS&version=2.0.1&request=GetCoverage"
        f"&coverageId={_WORKSPACE}__{region['coverage_id']}"
        f"&format=image/tiff"
        f"&subset=E({sub_minx},{sub_maxx})&subset=N({sub_miny},{sub_maxy})"
    )
    try:
        resp = requests.get(url, timeout=_WCS_TIMEOUT_SECONDS)
        resp.raise_for_status()
        if len(resp.content) < 200:
            # A real, undersized/error response (WCS returns an XML
            # ExceptionReport with a 200 status in some GeoServer
            # configurations) — treat as a failure, not a valid GeoTIFF.
            raise RuntimeError(f"suspiciously small WCS response ({len(resp.content)} bytes)")
    except Exception:
        logger.warning("landslide_regional_comparison: WCS fetch failed for region %r, bbox %r (degraded)", region_key, bbox_4326, exc_info=True)
        return None

    tmp_path = f"{cache_path}.tmp{os.getpid()}"
    with open(tmp_path, "wb") as f:
        f.write(resp.content)
    os.replace(tmp_path, cache_path)
    return cache_path


def compare_ahp_to_regional_susceptibility(catchment_key, lite=True, force=False):
    """The main entry point: fetches whichever regional WCS coverage best
    overlaps `catchment_key`'s own bbox, warps it onto our own AHP
    susceptibility raster's exact grid (flood_model._warp_to_grid,
    reused unmodified), and computes a real Spearman rank correlation
    between the two classified rasters over their shared valid area.

    Returns {"region", "n_valid_pixels", "spearman_r", "interpretation"}
    on success; {"region": None, "note": "..."} if no regional coverage
    overlaps this catchment at all; {"region": <key>, "error": "..."} if
    a region overlaps but the fetch/comparison itself failed — never
    raises past this function, matching this codebase's established
    external-data degrade convention."""
    import struct
    from osgeo import gdal

    landslide_model.ensure_registered_with_flood_model(catchment_key)
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    region_key = _best_overlapping_region(bbox)
    if region_key is None:
        return {"region": None, "note": "no regional coverage overlaps this catchment's bbox"}

    coverage_path = _fetch_regional_coverage_for_bbox(region_key, bbox, force=force)
    if coverage_path is None:
        return {"region": region_key, "error": "regional coverage fetch failed or did not intersect (see logs)"}

    # `force` here only busts THIS module's own regional-coverage cache
    # (above) — our own susceptibility raster is always taken from
    # whatever's already cached (force=False), never force-rebuilt.
    # Real bug found live: passing force=True through to this call
    # propagates all the way to flood_model.build_hand_pipeline's own DEM
    # fetch, which then hit a real 60s Earth Engine read-timeout on a
    # live test — an expensive, slow, unrelated risk this comparison
    # utility has no business triggering. A caller wanting a genuinely
    # fresh AHP score should rebuild it via landslide_model directly, not
    # implicitly through this comparison call.
    susceptibility = landslide_model.build_landslide_susceptibility_raster(catchment_key, lite=lite, force=False)
    score_path = susceptibility["score_path"]

    with flood_model._gdal_lock():
        ref_ds = gdal.Open(score_path)
        if ref_ds is None:
            return {"region": region_key, "error": f"could not open our own susceptibility raster at {score_path!r}"}
        ref_gt = ref_ds.GetGeoTransform()
        ref_w, ref_h = ref_ds.RasterXSize, ref_ds.RasterYSize
        ref_ds = None

    warped_path = os.path.join(_regional_cache_dir(), f"{region_key}_{catchment_key}_{'lite' if lite else 'full'}_warped.tif")
    try:
        with flood_model._gdal_lock():
            flood_model._warp_to_grid(coverage_path, warped_path, ref_gt, ref_w, ref_h, resample_alg="near")
    except Exception:
        logger.warning("landslide_regional_comparison: warp-to-grid failed for %r/%r", region_key, catchment_key, exc_info=True)
        return {"region": region_key, "error": "could not reproject the regional coverage onto our own grid (see logs)"}

    our_arr, _, _, our_nodata, w, h = flood_model._read_raster_array(score_path)

    with flood_model._gdal_lock():
        their_ds = gdal.Open(warped_path)
        their_band = their_ds.GetRasterBand(1)
        their_nodata = their_band.GetNoDataValue()
        raw_rows = [their_band.ReadRaster(0, row, w, 1, buf_type=gdal.GDT_Float32) for row in range(h)]
        their_ds = None
    their_arr = np.array([struct.unpack(f"<{w}f", row) for row in raw_rows], dtype=np.float64)

    valid = np.ones((h, w), dtype=bool)
    if our_nodata is not None:
        valid &= (our_arr != our_nodata)
    # The warp's own destination nodata for an out-of-source-extent pixel
    # is 0 by GDAL's own default when the source band declares none —
    # exclude both a real declared nodata value AND exact 0 (never a real
    # susceptibility class in any of these 4 products), a defensive,
    # explicitly-stated choice, not silent.
    if their_nodata is not None:
        valid &= (their_arr != their_nodata)
    valid &= (their_arr != 0)

    n_valid = int(np.sum(valid))
    if n_valid < 30:
        return {
            "region": region_key, "n_valid_pixels": n_valid,
            "error": "too few overlapping valid pixels for a meaningful correlation (<30)",
        }

    our_valid = our_arr[valid]
    their_valid = their_arr[valid]

    # Spearman rank correlation via pandas' own average-tie-rank ranking
    # (scipy is not a project dependency — confirmed live this session —
    # pandas already is) + a plain Pearson correlation on the ranks,
    # which IS the definition of Spearman's rho.
    import pandas as pd
    our_ranks = pd.Series(our_valid).rank().to_numpy()
    their_ranks = pd.Series(their_valid).rank().to_numpy()
    spearman_r = float(np.corrcoef(our_ranks, their_ranks)[0, 1])

    return {
        "region": region_key,
        "n_valid_pixels": n_valid,
        "spearman_r": round(spearman_r, 4),
        "interpretation": _interpret_correlation(spearman_r),
    }
