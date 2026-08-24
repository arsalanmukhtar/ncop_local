# project/ncop_internal/flood_model.py
# ---------------------------------------------------------------------------
# Phase 1 of the lightweight flash-flood early-warning system (see
# FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md at the repo root for the full
# architecture/reasoning). This module builds a static HAND (Height Above
# Nearest Drainage) flood-prone-zones layer for a pilot catchment —
# terrain-only, no rainfall coupling yet (that's Phase 2).
#
# Pipeline: GEE Copernicus DEM (COPERNICUS/DEM/GLO30_2024_1 — the
# non-deprecated collection, see the methodology doc's Phase-0 section) ->
# WhiteboxTools hydrological conditioning (fill_single_cell_pits ->
# breach_depressions_least_cost) -> D8 flow direction/accumulation ->
# stream extraction -> elevation_above_stream (HAND) -> threshold ->
# colorized PNG, served through the same warp/colorize/cache convention
# _mon_pred_convert_step already established for PMD prediction rasters.
#
# Crash-safety, all lessons already paid for elsewhere in this app or in
# this feature's own Phase 0 verification:
#   - WhiteboxTools's OWN return code is not trustworthy (confirmed live
#     in Phase 0: a Rust-side panic still reported exit 0 with no output
#     produced) — every step's OUTPUT FILE is verified to exist and be
#     non-empty after the call, never the return code alone.
#   - The library exposes no subprocess timeout of its own — every call
#     is wrapped in a bounded ThreadPoolExecutor.result(timeout=...) so a
#     hung WhiteboxTools process can never hang the calling
#     request/command indefinitely (the underlying OS process may be
#     orphaned in that case — a timeout is a last resort, not expected in
#     normal operation, exactly like every other bounded external call in
#     this app).
#   - GDAL raster I/O uses raw WriteRaster/ReadRaster (struct-packed
#     bytes), never Band.ReadAsArray()/WriteArray() — this venv's GDAL
#     wheel has a NumPy 2.x ABI mismatch on that path, confirmed live in
#     Phase 0 (same issue already documented on
#     PmdMonitorPredictionValueAPIView elsewhere in views.py).
#   - Every GDAL touch-point is serialized under the SAME
#     _MON_PRED_GDAL_LOCK views.py already uses — GDAL/PROJ are not
#     thread-safe for concurrent access (the reproduced, fixed crash class
#     this project's incident history is built on).
#   - WhiteboxTools calls are ALSO serialized under their own lock
#     (_WBT_LOCK) — not for crash-safety (subprocess isolation already
#     covers that on its own) but so multiple overlapping catchment
#     computations never contend for CPU on the shared production VM at
#     once, the same reasoning translate.py's own lock already documents
#     for NLLB inference.
#   - Every cached output written via temp-file + os.replace() — the same
#     atomic-write fix that resolved the temp2m.txt ramp-file corruption
#     bug earlier this session.
# ---------------------------------------------------------------------------

import contextlib
import json
import logging
import math
import os
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FutureTimeoutError

from django.conf import settings

logger = logging.getLogger(__name__)

_FLOOD_MEDIA_SUBDIR = "flood_model"
_WBT_TIMEOUT_SECONDS = 180  # generous for a pilot-catchment-sized raster, still bounded
_WBT_LOCK = threading.Lock()
_WBT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="wbt-call")

_wbt_singleton = None

# Pilot catchments — bbox is [minLon, minLat, maxLon, maxLat], WGS84. Only
# one so far (see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md's "open items" —
# Nullah Lai chosen for Phase 0/1: small, urban, well-documented flash-flood
# history, in NDMA's own operational area).
#
# bbox CORRECTED (see methodology doc §0.17) to the Lai Nullah Basin's own
# published boundary — "33°33'-33°46' North and 72°55'-73°07' East" (Rahman
# et al., "Lai Nullah Basin Flood Problem Islamabad," WMO/APFM Associated
# Programme on Flood Management case study,
# http://www.floodmanagement.info/publications/casestudies/cs_pakistan_nullah_full.pdf,
# catchment area 234.9 km2 corroborated separately by Farooq et al. 2019,
# "Simulation of the impacts of land-use change on surface runoff of Lai
# Nullah Basin," Journal of Environmental Management). The ORIGINAL bbox
# ([72.95, 33.50, 73.20, 33.78]) was a rough guess, never checked against
# the basin's own published extent — confirmed live it implied ~721 km2,
# roughly 3x the real 234.9 km2 basin, and visibly included drainage
# networks well outside Nullah Lai's actual catchment once rendered on a
# real map. This correction is a genuine core-logic change, not cosmetic —
# every cached output for this catchment is now stale and must be rebuilt.
PILOT_CATCHMENTS = {
    "nullah_lai": {
        "label": "Nullah Lai (Rawalpindi/Islamabad)",
        "bbox": [72.9167, 33.55, 73.1167, 33.7667],
    },
}

# AOI size guard — none existed before this pass; only the one hardcoded
# pilot catchment above has ever been exercised, but Phase 1.6 will make
# the AOI user-controllable (a drawn bbox or a custom upload), and nothing
# currently stops a much larger bbox from being requested. Rejecting
# outright (not silently downsampling the AOI the way
# MAX_INPUT_PX_BEFORE_DOWNSAMPLE handles an oversized RASTER elsewhere in
# this app — cropping a user's requested AREA without telling them is a
# worse silent surprise than a raster is) is deliberate: a bbox defines
# what the user actually asked for, and quietly serving a smaller area
# than requested would misrepresent the result.
#
# Cap set with real numbers from THIS project's own confirmed-live
# timings, not a guess: the Nullah Lai pilot (0.0700 deg^2, ~721 km^2 at
# this latitude) already costs ~225-270s for Overture's buildings fetch
# and ~40-80s for road-network exposure (flood_exposure.py, §0.11 of the
# methodology doc) — both already near the edge of what a bounded,
# backend-only pipeline should take on. 0.30 deg^2 gives roughly 4x
# headroom for a modestly larger future catchment without inviting an
# AOI that would blow those costs out by an order of magnitude.
MAX_CATCHMENT_BBOX_DEG2 = 0.30


def _validate_catchment_bbox(bbox):
    """Raises ValueError with a clear message for an oversized or
    malformed bbox — called once, at the top of build_hand_pipeline, so
    every downstream caller (flood_exposure.py's build_exposure_report
    included, since it always calls build_hand_pipeline first) fails fast
    before any GEE/network/compute cost is spent, not partway through."""
    minx, miny, maxx, maxy = bbox
    if maxx <= minx or maxy <= miny:
        raise ValueError(f"Malformed bbox {bbox!r} - max must exceed min on both axes")
    area_deg2 = (maxx - minx) * (maxy - miny)
    if area_deg2 > MAX_CATCHMENT_BBOX_DEG2:
        raise ValueError(
            f"Catchment bbox {bbox!r} is too large ({area_deg2:.4f} deg^2 > "
            f"{MAX_CATCHMENT_BBOX_DEG2} deg^2 cap) - this pipeline is sized for "
            f"pilot-catchment-scale AOIs, not a much larger area. See "
            f"MAX_CATCHMENT_BBOX_DEG2's own comment for the confirmed-live "
            f"timings this cap is based on."
        )

# Starting value, NOT calibrated for this catchment — see methodology doc
# §0.17 for the full research trail. Correcting an earlier, imprecise
# claim: there is no fixed "operational" HAND threshold in the literature
# to cite — NOAA's own National Water Model FIM service derives HAND
# cutoffs from a rating curve fed by an actual FEMA discharge value per
# reach (Zheng et al. 2018, "Two-dimensional hydraulic modeling and
# rating curve development... for a HAND-based flood inundation mapping
# framework," NOAA; see also the North Carolina HAND-parameter-
# optimization study, Frontiers in Water, 2023,
# https://doi.org/10.3389/frwa.2023.1296434) — i.e. a real, defensible
# threshold needs a rainfall/discharge SCENARIO as input, which is
# exactly Phase 2's job (dynamic PMD coupling), not yet built. 3.0m is
# kept as an EXPLORATORY default, chosen from the geographically closer
# comparison available: Bhatt & Srinivasa Rao (2018), "HAND (height
# above nearest drainage) tool and satellite-based geospatial analysis of
# Hyderabad (India) urban floods, September 2016," Arabian Journal of
# Geosciences 11(19):600 (https://doi.org/10.1007/s12517-018-3952-1),
# which reports HAND 1-5m spanning "very high to very low" flood
# susceptibility for a comparable South Asian urban catchment — 3.0m
# sits mid-range in that band, not picked in isolation. That same
# literature (see the HAND-vs-hydrodynamic-model comparative review,
# Earth Science Informatics, 2023, https://doi.org/10.1007/s12145-023-01218-x)
# also documents HAND UNDERESTIMATING inundation by up to 40% in flat,
# heavily channelized urban settings — a real, named caveat for Lai
# Nullah specifically, which is exactly that kind of channel through
# much of its urban reach, not a generic disclaimer.
#
# Confirmed live via a 2/3/5/8m sweep on this catchment (pre-bbox-
# correction figures, kept for the monotonic-curve shape, not the
# absolute percentages): 9.8% / 13.8% / 22.0% / 34.2% of the AOI flagged
# flood-prone — a sensible, monotonically increasing curve, re-run and
# reconfirmed after the bbox fix (§0.17): 49.752 km^2 flood-prone at
# 3.0m post-correction, vs. 95.405 km^2 pre-correction on the same
# threshold — the earlier oversized bbox, not the threshold itself, was
# the dominant error source.
HAND_FLOOD_PRONE_THRESHOLD_M = 3.0
# For a 30m DEM, 500 contributing cells ~= 0.45 km^2 of upstream drainage
# area — a reasonable starting definition of "this cell is part of a
# stream" for a small/steep pilot catchment.
STREAM_FLOW_ACCUM_THRESHOLD = 500


_GDAL_LOCK_WARN_THRESHOLD_SECONDS = 1.0


@contextlib.contextmanager
def _gdal_lock():
    """Reuses the EXACT same lock views.py's own PMD prediction pipeline
    uses — see that lock's own extensive comment for the reproduced,
    fixed native crash this exists to prevent. Imported lazily (not at
    module level) to avoid a circular import, matching this module's own
    "nothing heavy at import time" posture.

    Wrapped as a context manager (rather than just returning the raw
    lock object) so every acquisition through THIS module is timed —
    logs a WARNING if a caller waited more than
    _GDAL_LOCK_WARN_THRESHOLD_SECONDS, turning "worth watching lock wait
    times once this is live" from an assumption into actual production
    observability. Correctness is unchanged: still the exact same
    underlying threading.Lock, still fully mutually exclusive, still used
    identically by every existing `with flood_model._gdal_lock():`
    caller — this only adds timing/logging around acquire()/release()."""
    from .views import _MON_PRED_GDAL_LOCK
    t0 = time.monotonic()
    _MON_PRED_GDAL_LOCK.acquire()
    wait_seconds = time.monotonic() - t0
    if wait_seconds > _GDAL_LOCK_WARN_THRESHOLD_SECONDS:
        logger.warning(
            "flood_model: _gdal_lock() acquisition waited %.2fs - contention with "
            "PMD prediction rendering or another flood_model/flood_exposure caller",
            wait_seconds,
        )
    try:
        yield
    finally:
        _MON_PRED_GDAL_LOCK.release()


def _wbt_client():
    """Lazy singleton — the (slow, one-time) binary resolution only
    happens once per process. set_whitebox_dir() is called explicitly
    rather than trusting whitebox's own auto-detection: confirmed live in
    Phase 0 that its default detection is broken on this Windows install
    (a real path bug in the package's OWN installer — it downloads the
    correct binary but fails to move it into the location it later looks
    for it in). Falls back to the untouched default (whatever
    auto-detection finds) if the expected WBT/ subfolder isn't there,
    e.g. on a machine where the installer bug doesn't reproduce."""
    global _wbt_singleton
    if _wbt_singleton is None:
        import whitebox
        wbt = whitebox.WhiteboxTools()
        wbt_dir = os.path.join(os.path.dirname(whitebox.__file__), "WBT")
        if os.path.isdir(wbt_dir):
            wbt.set_whitebox_dir(wbt_dir)
        wbt.set_verbose_mode(False)
        _wbt_singleton = wbt
    return _wbt_singleton


def _run_wbt(tool_name, kwargs, output_path):
    """Calls one WhiteboxTools tool method by name, serialized under
    _WBT_LOCK and bounded by _WBT_TIMEOUT_SECONDS, then verifies the
    output file actually exists and is non-empty — confirmed live in
    Phase 0 that WhiteboxTools' own return code cannot be trusted (a
    Rust-side panic still reported exit 0 with no output produced).
    Raises RuntimeError with a clear message on any failure rather than
    silently returning a missing/stale/corrupt file."""
    def _call():
        with _WBT_LOCK:
            method = getattr(_wbt_client(), tool_name)
            return method(**kwargs)

    future = _WBT_EXECUTOR.submit(_call)
    try:
        future.result(timeout=_WBT_TIMEOUT_SECONDS)
    except _FutureTimeoutError:
        raise RuntimeError(
            f"WhiteboxTools '{tool_name}' did not finish within {_WBT_TIMEOUT_SECONDS}s"
        )
    if not (os.path.exists(output_path) and os.path.getsize(output_path) > 0):
        raise RuntimeError(f"WhiteboxTools '{tool_name}' produced no output at {output_path}")
    return output_path


def _fetch_dem(bbox, out_path):
    """Exports Copernicus GLO-30 (2024 release, non-deprecated — see the
    methodology doc's Phase-0 section) for `bbox` from the existing GEE
    integration, writes it to `out_path`. Reuses the SAME
    initialize_earth_engine() side effect views.py's own DEM-dependent
    layers already depend on (imported lazily here for the same reason —
    avoid a heavy/network-touching import at module load time)."""
    from . import views  # noqa: F401 — import side effect: initializes Earth Engine
    import ee
    import requests

    region = ee.Geometry.Rectangle(bbox)
    dem = ee.ImageCollection("COPERNICUS/DEM/GLO30_2024_1").select("DEM").mosaic().clip(region)
    url = dem.getDownloadURL({"region": region, "scale": 30, "format": "GEO_TIFF"})
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    raw_path = f"{out_path}.raw{os.getpid()}"
    with open(raw_path, "wb") as f:
        f.write(resp.content)

    # GEE's own GeoTIFF export uses a compression tag (confirmed live:
    # TIFF compression code 32946) that WhiteboxTools' Rust GeoTIFF
    # decoder rejects outright — "only supports PACKBITS, LZW, and
    # DEFLATE" — even though 32946 IS a form of deflate; a real decoder
    # compatibility gap, not a corrupt file. gdal.Translate (pure GDAL
    # utility, never touches gdal_array/numpy — safe under this venv's
    # ABI mismatch) re-writes it uncompressed so every raster this module
    # ever hands to WhiteboxTools is guaranteed readable, not just the
    # one that happened to be tested.
    try:
        from osgeo import gdal
        tmp_path = f"{out_path}.tmp{os.getpid()}"
        # format="GTiff" passed explicitly — confirmed live that letting
        # gdal.Translate guess the driver from the destination filename
        # fails ("Cannot guess driver") once that filename carries a
        # non-.tif temp suffix, which every atomic-write path in this
        # module needs.
        src_ds = gdal.Open(raw_path)
        if src_ds is None:
            raise RuntimeError(f"gdal.Open could not read the GEE DEM export at {raw_path}")
        out_ds = gdal.Translate(
            tmp_path, src_ds,
            format="GTiff", creationOptions=["COMPRESS=NONE"],
        )
        if out_ds is None:
            raise RuntimeError("gdal.Translate returned None re-writing the GEE DEM export")
        out_ds = None
        src_ds = None  # release the open handle BEFORE the finally block's os.remove — Windows
                        # holds a lock on an open GDAL dataset's file handle (same gotcha already
                        # documented elsewhere in views.py); dropping the reference here, not just
                        # letting GC eventually collect it, is what actually releases it in time.
        os.replace(tmp_path, out_path)
    finally:
        # Best-effort — same "cleanup failure must never crash the whole
        # operation" convention _mon_pred_convert_step's own finally block
        # already uses. If Windows still hasn't released the handle by
        # here for some reason, the leftover .raw file is harmless scratch,
        # not a correctness problem — never worth failing the whole DEM
        # fetch over.
        try:
            if os.path.exists(raw_path):
                os.remove(raw_path)
        except OSError:
            logger.warning("flood_model: could not remove scratch file %s (non-fatal)", raw_path)
    return out_path


def _read_pixel(path, col, row):
    """Point-read via raw ReadRaster/struct (never Band.ReadAsArray —
    see this module's own docstring on the NumPy/GDAL ABI mismatch)."""
    from osgeo import gdal
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    raw = band.ReadRaster(col, row, 1, 1, buf_type=gdal.GDT_Float32)
    return struct.unpack("<f", raw)[0]


def _raster_stats(path):
    """Min/max/mean via GetStatistics — this does NOT go through
    gdal_array (confirmed safe in Phase 0's own testing), unlike
    ReadAsArray."""
    from osgeo import gdal
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    mn, mx, mean, std = band.GetStatistics(False, True)
    return {"min": mn, "max": mx, "mean": mean, "std": std,
            "width": ds.RasterXSize, "height": ds.RasterYSize}


def build_hand_pipeline(catchment_key, force=False):
    """Runs the full Phase-1 pipeline for one pilot catchment and returns
    a dict of every intermediate + final raster path, plus basic stats
    for each — so a caller (a management command, a diagnostic script)
    can sanity-check every stage, not just trust the final output blindly.

    Steps: DEM export -> fill_single_cell_pits -> breach_depressions
    (least-cost) -> D8 pointer -> D8 flow accumulation -> stream
    extraction -> elevation_above_stream (HAND). All intermediate files
    are cached on disk (same directory, deterministic names keyed by
    catchment) — reruns with force=False skip already-completed steps,
    matching _mon_pred_convert_step's own disk-cache convention.
    """
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]
    _validate_catchment_bbox(cfg["bbox"])

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)

    paths = {
        "dem":            os.path.join(out_dir, "01_dem.tif"),
        "pits_fixed":     os.path.join(out_dir, "02_pits_fixed.tif"),
        "conditioned":    os.path.join(out_dir, "03_conditioned.tif"),
        "d8_pointer":     os.path.join(out_dir, "04_d8_pointer.tif"),
        "flow_accum":     os.path.join(out_dir, "05_flow_accum.tif"),
        "streams":        os.path.join(out_dir, "06_streams.tif"),
        "hand":           os.path.join(out_dir, "07_hand.tif"),
    }

    def _needed(key):
        return force or not (os.path.exists(paths[key]) and os.path.getsize(paths[key]) > 0)

    results = {}

    def _stats_locked(key):
        # _raster_stats() is the only part of each step that touches
        # OUR in-process GDAL (gdal.Open/GetStatistics) — WhiteboxTools
        # itself runs as an independent subprocess and never does.
        # Locking only this, not the WhiteboxTools call around it, keeps
        # the (potentially slow) subprocess work from blocking every
        # OTHER GDAL-using feature in the app (e.g. PMD prediction
        # rendering) for the pipeline's whole duration — GDAL/PROJ's
        # thread-safety problem is about concurrent IN-PROCESS calls,
        # nothing outside that needs to be inside this lock.
        with _gdal_lock():
            results[key] = _raster_stats(paths[key])

    if _needed("dem"):
        with _gdal_lock():  # _fetch_dem's own gdal.Translate re-write touches GDAL too
            _fetch_dem(cfg["bbox"], paths["dem"])
    _stats_locked("dem")

    if _needed("pits_fixed"):
        _run_wbt("fill_single_cell_pits",
                 {"dem": paths["dem"], "output": paths["pits_fixed"]},
                 paths["pits_fixed"])
    _stats_locked("pits_fixed")

    if _needed("conditioned"):
        _run_wbt("breach_depressions_least_cost",
                 {"dem": paths["pits_fixed"], "output": paths["conditioned"],
                  "dist": 100, "fill": True},
                 paths["conditioned"])
    _stats_locked("conditioned")

    if _needed("d8_pointer"):
        _run_wbt("d8_pointer",
                 {"dem": paths["conditioned"], "output": paths["d8_pointer"]},
                 paths["d8_pointer"])
    _stats_locked("d8_pointer")

    if _needed("flow_accum"):
        _run_wbt("d8_flow_accumulation",
                 {"i": paths["conditioned"], "output": paths["flow_accum"],
                  "out_type": "cells"},
                 paths["flow_accum"])
    _stats_locked("flow_accum")

    if _needed("streams"):
        _run_wbt("extract_streams",
                 {"flow_accum": paths["flow_accum"], "output": paths["streams"],
                  "threshold": STREAM_FLOW_ACCUM_THRESHOLD},
                 paths["streams"])
    _stats_locked("streams")

    if _needed("hand"):
        _run_wbt("elevation_above_stream",
                 {"dem": paths["conditioned"], "streams": paths["streams"],
                  "output": paths["hand"]},
                 paths["hand"])
    _stats_locked("hand")

    return {"paths": paths, "stats": results}


def _flood_zone_ramp_file(threshold_m):
    """Builds (once, cached) a GDAL color-relief ramp for the flood-prone
    -zones layer: dark blue right at the stream (HAND=0, most flood-prone)
    fading to a lighter blue at the threshold, then fully transparent for
    anything above it — matching the general ramp-file approach
    _mon_pred_ramp_file already uses for PMD prediction layers, kept as
    its own small function here rather than shared, since that one is
    keyed by PMD's own element_key vocabulary, not this feature's."""
    ramp_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, "_ramps")
    os.makedirs(ramp_dir, exist_ok=True)
    path = os.path.join(ramp_dir, f"hand_flood_zones_{threshold_m}.txt")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    half = threshold_m / 2
    just_above = threshold_m + max(0.01, threshold_m * 0.001)
    lines = [
        "nv 0 0 0 0",
        f"0 0 0 139 255",
        f"{half} 30 100 200 255",
        f"{threshold_m} 100 180 255 180",
        f"{just_above} 100 180 255 0",
    ]
    tmp_path = f"{path}.tmp{os.getpid()}"
    with open(tmp_path, "w") as f:
        f.write("\n".join(lines))
    os.replace(tmp_path, path)
    return path


def render_flood_prone_zones(catchment_key, threshold_m=HAND_FLOOD_PRONE_THRESHOLD_M, force=False):
    """Colorizes the HAND raster (built by build_hand_pipeline, called
    here if not already cached) into a servable PNG — the actual Phase-1
    deliverable: a "flood-prone zones" layer, HAND below `threshold_m`
    shown in blue, everything else transparent. Reuses the exact
    warp/colorize/atomic-write/post-write-validation conventions
    _mon_pred_convert_step already established for PMD prediction
    rasters, so this layer can be served/cached the same way once wired
    into a view (Phase 1's remaining step, not done in this pass).

    Returns {"png_url", "bounds": [[minx,miny],[maxx,maxy]]} — same shape
    PmdMonitorPredictionsAPIView's own per-step payload uses, for a
    consistent frontend integration story later."""
    pipeline = build_hand_pipeline(catchment_key, force=force)
    hand_path = pipeline["paths"]["hand"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    png_path = os.path.join(out_dir, f"flood_prone_zones_{threshold_m}.png")

    if not force and os.path.exists(png_path) and os.path.getsize(png_path) >= 512:
        return _flood_zone_payload(png_path, hand_path)

    ramp = _flood_zone_ramp_file(threshold_m)
    tmp_png = f"{png_path}.tmp{os.getpid()}"
    with _gdal_lock():
        from osgeo import gdal
        colored_ds = gdal.DEMProcessing(
            tmp_png, hand_path, "color-relief",
            colorFilename=ramp, format="PNG", addAlpha=True,
        )
        if colored_ds is None:
            raise RuntimeError("gdal.DEMProcessing (color-relief) returned None for flood-prone zones")
        colored_ds = None
        # Post-write validation — same "an empty-looking but technically
        # valid PNG can slip through" concern _mon_pred_convert_step's own
        # comment documents (observed there when a Warp silently landed on
        # NoData). Cheap enough to just re-open and confirm real pixel
        # dimensions before trusting the file.
        check_ds = gdal.Open(tmp_png)
        if check_ds is None or check_ds.RasterXSize <= 0 or check_ds.RasterYSize <= 0:
            raise RuntimeError("flood-prone zones PNG failed post-write validation")
        check_ds = None
    os.replace(tmp_png, png_path)
    # GDAL writes its own PAM sidecar (.aux.xml) next to whatever file it
    # opens for the post-write validation above — that sidecar was
    # created against the TEMP filename, so os.replace() (which only
    # moves the one path we told it to) leaves it behind as an orphan.
    # Harmless (small XML, no correctness impact) but worth not leaking
    # one per render.
    stray_aux = f"{tmp_png}.aux.xml"
    if os.path.exists(stray_aux):
        try:
            os.remove(stray_aux)
        except OSError:
            pass
    return _flood_zone_payload(png_path, hand_path)


def _flood_zone_payload(png_path, hand_path):
    from osgeo import gdal
    with _gdal_lock():
        ds = gdal.Open(hand_path)
        gt = ds.GetGeoTransform()
        w, h = ds.RasterXSize, ds.RasterYSize
    # Corner-based WGS84 bounds would need a reprojection pass (the HAND
    # raster is in the DEM's native geographic CRS already here, unlike
    # PMD's own EPSG:3857-warped rasters) — kept as plain projected-unit
    # corners for now; reprojecting to WGS84 bounds is part of the
    # frontend-wiring step this function deliberately doesn't do yet.
    minx, maxy = gt[0], gt[3]
    maxx, miny = gt[0] + gt[1] * w, gt[3] + gt[5] * h
    rel_path = os.path.relpath(png_path, settings.MEDIA_ROOT).replace(os.sep, "/")
    return {
        "png_url": f"{settings.MEDIA_URL.rstrip('/')}/{rel_path}",
        "bounds": [[minx, miny], [maxx, maxy]],
    }
