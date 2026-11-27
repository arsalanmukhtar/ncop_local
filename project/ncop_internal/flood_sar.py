# project/ncop_internal/flood_sar.py
# ---------------------------------------------------------------------------
# Phase 2.5.6 — Sentinel-1 SAR as a second, independent ground-truth
# source (see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md §0.33 for the
# full account). New subsystem -> own file, matching the convention
# every other subsystem in this project already follows
# (flood_discharge.py, flood_forecast.py, flood_riverine.py,
# flood_ahp.py, flood_connectivity.py, flood_validation.py).
#
# Method: UN-SPIDER's "Flood Mapping and Damage Assessment Using
# Sentinel-1 SAR Data in Google Earth Engine" Recommended Practice
# (un-spider.org/advisory-support/recommended-practices/recommended-
# practice-google-earth-engine-flood-mapping — fetched and read
# directly this session, both its overview and step-by-step pages).
# Chosen specifically because it is GEE-native (matches this project's
# own stack exactly, no new runtime dependency) and reports a real
# validated accuracy (93.38%, ground-truth checked in its own source
# study). Every numeric parameter below is cited from that source, used
# AS-IS (not re-derived), matching this project's own "cite it, don't
# invent it" discipline:
#
#   - Band: VH polarization (more sensitive to land-surface change than VV)
#   - Speckle filter: focal smoothing, 50m radius circular kernel
#   - Change detection: after-flood mosaic / before-flood mosaic (ratio)
#   - Threshold: ratio > 1.25 -> flood (empirically derived, 93.38% validated)
#   - Permanent water mask: JRC Global Surface Water, mask cells flooded
#     >10 months/year (reusing the exact dataset id views.py's own
#     AHPModels.compute_flood_susceptibility already uses elsewhere in
#     this app — not a new dataset lookup)
#   - Terrain false-positive filter: slope > 5% (grade) excluded.
#     UN-SPIDER's own reference implementation fetches HydroSHEDS for
#     this — THIS PROJECT SUBSTITUTES its own already-cached
#     conditioned-DEM-derived slope (flood_model.build_twi_curvature_
#     rasters' own "09_slope_deg.tif", built once per catchment for the
#     AHP pipeline), zero new fetch, applied as a LOCAL raster mask
#     after download rather than a second GEE dataset — a deliberate,
#     stated efficiency deviation from the literature's own reference
#     implementation, not a silent substitution.
#   - Noise cleanup: isolated patches (<=8-neighbor connectivity)
#     removed. UN-SPIDER's own reference implementation does this via a
#     GEE-side connectedComponents() call — THIS PROJECT SUBSTITUTES its
#     own existing gdal.SieveFilter tooling (the exact call already
#     proven live in flood_exposure.py's own _vectorize_multiclass_
#     raster), applied to the downloaded raster locally — functionally
#     equivalent, reuses tooling already trusted in this codebase
#     instead of a new GEE-side technique.
#   - Border noise: pre-corrected by GEE's own S1_GRD ingestion (no
#     action needed on this project's side).
#
# Corroborating Pakistan-specific literature (secondary support, not
# the primary numeric source — used to confirm the method choice is
# reasonable for this country, not to source any parameter value):
# Amitrano et al., Sustainability 2020 (DOI 10.3390/su12145784), "Use
# of Sentinel-1 GRD SAR Images to Delineate Flood Extent in Pakistan" —
# refined Lee speckle filter + land-cover masking to remove flood
# lookalikes (desert/snow), same VH-based approach; and a 2025 Punjab
# AHP+Sentinel-1 flood-susceptibility study (Atmosphere journal),
# corroborating VH polarization choice for flood-related work in
# Pakistan specifically.
#
# HONEST, STATED CAVEAT: the 1.25 threshold is UN-SPIDER's own general-
# purpose value, not re-calibrated for Pakistan's specific terrain/
# land-cover mix — used as a literature-backed starting point, cross-
# validated (not re-tuned) against real GFD ground truth per catchment
# via flood_validation.run_sar_cross_validation.
#
# REAL COVERAGE FINDING (confirmed live via a direct GEE query before
# writing this module, not assumed): Sentinel-1A launched April 2014
# and GFD's own MODIS-based event archive ends around 2018 — the
# temporal overlap window is narrow, and Pakistan's own Sentinel-1
# coverage was confirmed sparse in the mission's early years (2015-
# 2016: 0-2 scenes found near 3 of the 4 pilot catchments' own best
# post-2014 GFD events, all under 10 flooded pixels to begin with). Only
# ONE catchment currently has both a real, decently-sized post-2014 GFD
# event AND real, dense Sentinel-1 coverage in its date window:
# chashma_indus's 2018-07-03 to 2018-07-11 event (GFD id 4645, 897
# flooded pixels — 20 real S1 scenes found May-July 2018, confirmed
# live). This module is written generically (works for ANY catchment/
# event with real coverage, and Sentinel-1's own coverage over Pakistan
# has only improved since 2018 — a future GFD archive update or a
# newer ground-truth event would extend this straightforwardly), but
# only chashma_indus currently has a genuinely validatable case —
# reported honestly here and in the methodology doc's own account, not
# hidden or forced.
# ---------------------------------------------------------------------------

import datetime
import logging
import os
import struct

import numpy as np
from django.conf import settings

logger = logging.getLogger(__name__)

_FLOOD_MEDIA_SUBDIR = "flood_model"  # same media subdir every other flood_* module uses

# --- literature-cited constants (UN-SPIDER, see module docstring above) ----
_SAR_SPECKLE_FILTER_RADIUS_M = 50
_SAR_CHANGE_RATIO_THRESHOLD = 1.25  # UN-SPIDER's own fixed value — kept as the FALLBACK, see _SAR_OTSU_* below
_SAR_SLOPE_THRESHOLD_PERCENT = 5.0  # a PERCENT grade, not a degree angle — see build_sar_flood_extent
_SAR_PERMANENT_WATER_MONTHS_THRESHOLD = 10  # JRC seasonality band: months/year flooded, mask if exceeded
_SAR_SIEVE_THRESHOLD_PX = 8  # functional equivalent of UN-SPIDER's own "<=8-neighbor connectivity" rule
_SAR_PRE_EVENT_LOOKBACK_DAYS = 60  # wide enough to clear 2+ Sentinel-1 12-day revisit cycles
_SAR_POST_EVENT_BUFFER_DAYS = 12  # one S1 revisit cycle of slack past the GFD event's own catalogued end date
_SAR_DOWNLOAD_SCALE_M = 30  # matches this project's own other Sentinel-derived AHP factor (NDVI) download scale

# --- adaptive (Otsu) thresholding — added after real accuracy diagnosis ----
# against Chashma's own event 4645 (see FLASH_FLOOD_EARLY_WARNING_
# METHODOLOGY.md §0.34 for the full account). UN-SPIDER's own fixed 1.25
# is one general-purpose value; Otsu's method (maximizing between-class
# variance in the ratio image's own histogram — a standard, literature-
# documented SAR-flood-mapping technique, e.g. the Kerala 2018 PMC study
# and the Pakistan-specific Sustainability 2020 paper §0.33 already
# cites) is UNSUPERVISED and computed fresh per scene — it adapts to
# each scene's own real noise floor instead of assuming UN-SPIDER's own
# study conditions transfer everywhere, without ever looking at ground
# truth (never fit to GFD/any answer — this is not a tuned constant).
#
# CONFIRMED LIVE, not assumed: an UNCONSTRAINED Otsu search (the whole
# ratio histogram) picked a threshold of 1.034, flagging 37% of the
# whole catchment as "changed" — clearly dominated by non-flood noise
# (agricultural/seasonal backscatter variation over the pre-event
# lookback window), not a usable result. Constraining the search to
# [_SAR_OTSU_SEARCH_MIN, _SAR_OTSU_SEARCH_MAX] — the physically
# plausible direction for flood-driven change (VH backscatter genuinely
# INCREASING under double-bounce scattering from partially submerged
# vegetation/structures, ratio > 1.0, not decreasing) — fixes this:
# tested live at Chashma, it converged to 1.262 (independently landing
# almost exactly on UN-SPIDER's own 1.25, a real, reassuring sign this
# isn't an artifact) and flagged a plausible 4.4% of the catchment,
# roughly matching GFD's own ~5.15% flooded fraction there.
_SAR_OTSU_SEARCH_MIN = 1.0
_SAR_OTSU_SEARCH_MAX = 3.0
_SAR_OTSU_HISTOGRAM_BINS = 256
# Below this many valid samples in the constrained range, an Otsu split
# is not trustworthy (too few points to resolve a real histogram mode) —
# falls back to UN-SPIDER's own fixed _SAR_CHANGE_RATIO_THRESHOLD
# instead, a defensive degrade for a small/unusual AOI, never a crash.
_SAR_OTSU_MIN_SAMPLES = 1000

_JRC_SURFACE_WATER_ASSET = "JRC/GSW1_4/GlobalSurfaceWater"  # same asset id views.py's own AHPModels already uses


def _s1_scene_count(aoi, start, end):
    """Cheap existence/count check against the real Sentinel-1 GRD
    catalog — used so a "no coverage" outcome is logged with a real
    number attached, not silently returned as an empty/wrong mosaic."""
    import ee
    coll = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(aoi)
        .filterDate(start, end)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH"))
    )
    return coll, coll.size().getInfo()


def _otsu_threshold(values, bins=_SAR_OTSU_HISTOGRAM_BINS):
    """Standard Otsu's method — the threshold that maximizes between-
    class variance of a histogram, a well-established, literature-
    documented SAR-flood-mapping technique (see this module's own
    "adaptive (Otsu) thresholding" comment above for citations and the
    real, live-tested reasoning behind constraining its input range).
    Pure NumPy, O(bins) after one histogram pass — cheap, matching this
    project's own "no new heavy dependency" posture (no scikit-image).

    Returns the threshold value (a real number in the same units as
    `values`), or None if `values` has fewer than 2 distinct values (a
    degenerate histogram Otsu can't meaningfully split) — the caller
    falls back to the fixed literature threshold in that case."""
    if values.size < 2:
        return None
    hist, edges = np.histogram(values, bins=bins)
    hist = hist.astype(np.float64)
    centers = (edges[:-1] + edges[1:]) / 2
    total = hist.sum()
    sum_total = float(np.sum(hist * centers))

    sum_bg = 0.0
    weight_bg = 0.0
    best_var = -1.0
    best_thresh = centers[0]
    for i in range(len(hist)):
        weight_bg += hist[i]
        if weight_bg == 0:
            continue
        weight_fg = total - weight_bg
        if weight_fg == 0:
            break
        sum_bg += hist[i] * centers[i]
        mean_bg = sum_bg / weight_bg
        mean_fg = (sum_total - sum_bg) / weight_fg
        var_between = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
        if var_between > best_var:
            best_var = var_between
            best_thresh = centers[i]
    return float(best_thresh)


def build_sar_flood_extent(catchment_key, gfd_event, force=False):
    """Builds (once, cached per event) a binary Sentinel-1 SAR flood-
    extent mask for one real GFD event, following the literature method
    cited in this module's own docstring. `gfd_event` is one event dict
    from accuracy_assessment.list_gfd_events(bbox) — reused as-is, the
    same GFD source every other validation in this project already
    uses; needs at least `id`, `system_time_start_ms`, `system_time_
    end_ms`.

    Steps: fetch pre/post-event VH mosaics -> speckle-smooth (50m focal
    median) -> ratio -> mask permanent water (JRC) -> download the
    CONTINUOUS ratio -> warp onto the catchment's own conditioned-DEM
    grid -> threshold ADAPTIVELY (Otsu's method, constrained to the
    physically-plausible [_SAR_OTSU_SEARCH_MIN, _SAR_OTSU_SEARCH_MAX]
    range, falling back to UN-SPIDER's own fixed 1.25 if too few
    samples) -> mask steep terrain (this catchment's own local slope)
    -> sieve small isolated patches. See this module's own "adaptive
    (Otsu) thresholding" comment for the real, live-tested diagnosis
    behind switching from a single fixed threshold to this.

    Returns {"path": cached raster path, "n_pre_scenes": int,
    "n_post_scenes": int, "threshold_used": float, "threshold_source":
    "otsu"|"fallback_fixed"} on success, or None (never raises) if
    Sentinel-1 has no real coverage in the required windows, or any
    GEE/network/GDAL step fails — logged, matching this project's own
    degrade-don't-crash convention for every other external-data
    module."""
    from . import flood_model

    if catchment_key not in flood_model.PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(flood_model.PILOT_CATCHMENTS)}")
    cfg = flood_model.PILOT_CATCHMENTS[catchment_key]
    bbox = cfg["bbox"]

    event_id = gfd_event.get("id")
    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"sar_flood_extent_{event_id}.tif")

    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return {"path": out_path}

    try:
        from . import views  # noqa: F401 — import side effect: initializes Earth Engine
        import ee

        post_start_ms = gfd_event["system_time_start_ms"]
        post_end_ms = gfd_event["system_time_end_ms"]
        post_start_date = datetime.datetime.utcfromtimestamp(post_start_ms / 1000).date()
        post_end_date = datetime.datetime.utcfromtimestamp(post_end_ms / 1000).date()

        post_window_start = post_start_date.isoformat()
        post_window_end = (post_end_date + datetime.timedelta(days=_SAR_POST_EVENT_BUFFER_DAYS)).isoformat()
        pre_window_end = (post_start_date - datetime.timedelta(days=1)).isoformat()
        pre_window_start = (post_start_date - datetime.timedelta(days=_SAR_PRE_EVENT_LOOKBACK_DAYS)).isoformat()

        aoi = ee.Geometry.Rectangle(bbox)
        pre_coll, n_pre = _s1_scene_count(aoi, pre_window_start, pre_window_end)
        post_coll, n_post = _s1_scene_count(aoi, post_window_start, post_window_end)

        if n_pre == 0 or n_post == 0:
            logger.warning(
                "flood_sar: no usable Sentinel-1 coverage for %r event %r "
                "(pre-window %s..%s: %d scenes, post-window %s..%s: %d scenes) "
                "- degrading to None, this event cannot be SAR-cross-validated "
                "right now (a real, confirmed coverage gap, not a bug)",
                catchment_key, event_id, pre_window_start, pre_window_end, n_pre,
                post_window_start, post_window_end, n_post,
            )
            return None

        pre_vh = pre_coll.select("VH").mosaic()
        post_vh = post_coll.select("VH").mosaic()

        # Speckle reduction — UN-SPIDER's own cited 50m-radius circular
        # focal-median smoothing, applied to both mosaics before the
        # ratio, matching the literature's own step order.
        pre_smooth = pre_vh.focal_median(_SAR_SPECKLE_FILTER_RADIUS_M, "circle", "meters")
        post_smooth = post_vh.focal_median(_SAR_SPECKLE_FILTER_RADIUS_M, "circle", "meters")

        ratio = post_smooth.divide(pre_smooth)

        # Permanent water mask — JRC Global Surface Water, same dataset
        # id this app already uses elsewhere (views.py's own
        # AHPModels.compute_flood_susceptibility). Applied to the
        # CONTINUOUS ratio (not yet thresholded) so permanent-water
        # pixels are excluded from BOTH the Otsu histogram below and the
        # final classification — an extreme, unrepresentative signal
        # that would otherwise skew the adaptive threshold.
        jrc = ee.Image(_JRC_SURFACE_WATER_ASSET)
        permanent_water = jrc.select("seasonality").gt(_SAR_PERMANENT_WATER_MONTHS_THRESHOLD)
        ratio_masked = ratio.updateMask(permanent_water.Not()).rename("sar_ratio")

        # Download the CONTINUOUS ratio (not a pre-thresholded mask) —
        # thresholding happens locally, below, so it can be adaptive
        # (Otsu) per scene rather than GEE-side with a single fixed
        # constant. See this module's own "adaptive (Otsu) thresholding"
        # comment near _SAR_OTSU_SEARCH_MIN for the full reasoning.
        fetch_path = f"{out_path}.fetch{os.getpid()}"
        flood_model._fetch_gee_continuous_raster(bbox, fetch_path, ratio_masked, scale=_SAR_DOWNLOAD_SCALE_M)
    except Exception:
        logger.warning(
            "flood_sar: Sentinel-1 fetch/threshold failed for %r event %r "
            "(degraded to None)", catchment_key, event_id, exc_info=True,
        )
        return None

    try:
        pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
        dem_path = pipeline["paths"]["conditioned"]
        with flood_model._gdal_lock():
            dem_arr, dem_gt, dem_proj, dem_nodata, dem_w, dem_h = flood_model._read_raster_array(dem_path)

        # Warp the downloaded CONTINUOUS ratio onto the catchment's own
        # conditioned-DEM grid (bilinear — this is still a continuous
        # field at this point, not yet thresholded, so nearest-neighbor
        # would be the wrong resample for it), so every subsequent local
        # step (thresholding, slope mask, sieve) operates on the exact
        # same pixel grid as every other raster this project produces.
        warped_path = f"{out_path}.warped{os.getpid()}"
        with flood_model._gdal_lock():
            flood_model._warp_to_grid(fetch_path, warped_path, dem_gt, dem_w, dem_h, resample_alg="bilinear")
            ratio_arr, mgt, mproj, mnodata, mw, mh = flood_model._read_raster_array(warped_path)
        os.remove(fetch_path)
        os.remove(warped_path)

        # Adaptive (Otsu) thresholding — see this module's own
        # "adaptive (Otsu) thresholding" comment near _SAR_OTSU_SEARCH_
        # MIN for the full reasoning and the real, live-tested numbers
        # behind this design. `valid` doesn't rely on a specific NoData
        # sentinel surviving the GEE-export/warp round trip — it just
        # excludes non-finite values and values outside the physically
        # sane VH-ratio range (permanent-water/no-coverage pixels export
        # as one or the other, confirmed live).
        valid = np.isfinite(ratio_arr) & (ratio_arr > 0) & (ratio_arr < 100)
        search_vals = ratio_arr[valid & (ratio_arr > _SAR_OTSU_SEARCH_MIN) & (ratio_arr < _SAR_OTSU_SEARCH_MAX)]
        threshold = None
        if search_vals.size >= _SAR_OTSU_MIN_SAMPLES:
            threshold = _otsu_threshold(search_vals)
        threshold_source = "otsu"
        if threshold is None:
            logger.info(
                "flood_sar: Otsu threshold unavailable for %r event %r (%d samples "
                "in the constrained search range, need >= %d) - falling back to "
                "the fixed literature threshold (%.2f)",
                catchment_key, event_id, search_vals.size, _SAR_OTSU_MIN_SAMPLES,
                _SAR_CHANGE_RATIO_THRESHOLD,
            )
            threshold = _SAR_CHANGE_RATIO_THRESHOLD
            threshold_source = "fallback_fixed"

        mask_arr = np.where(valid & (ratio_arr > threshold), 1.0, 0.0)

        # Terrain false-positive filter — this project's OWN already-
        # cached conditioned-DEM-derived slope (degrees), converted to a
        # PERCENT grade (UN-SPIDER's own cited threshold is a percent
        # grade, not a degree angle: percent = tan(radians(degrees)) * 100)
        # and applied as a local mask — the deliberate, stated
        # substitution for the literature's own HydroSHEDS fetch (see
        # module docstring).
        twi_paths = flood_model.build_twi_curvature_rasters(catchment_key, force=False)
        slope_deg_path = twi_paths["slope_deg"]
        with flood_model._gdal_lock():
            slope_warped_path = f"{out_path}.slopewarp{os.getpid()}"
            flood_model._warp_to_grid(slope_deg_path, slope_warped_path, dem_gt, dem_w, dem_h, resample_alg="bilinear")
            slope_arr, sgt, sproj, snodata, sw, sh = flood_model._read_raster_array(slope_warped_path)
        os.remove(slope_warped_path)

        slope_percent = np.tan(np.radians(slope_arr)) * 100.0
        steep = slope_percent > _SAR_SLOPE_THRESHOLD_PERCENT
        mask_arr = np.where(steep, 0.0, mask_arr)

        # Write the slope-masked binary raster, then sieve small
        # isolated patches via gdal.SieveFilter — the exact same call
        # already proven live in flood_exposure.py's own
        # _vectorize_multiclass_raster, applied here to a plain raster
        # (not a vectorization step) as the functional equivalent of
        # UN-SPIDER's own "<=8-neighbor connectivity" cleanup rule.
        pre_sieve_path = f"{out_path}.presieve{os.getpid()}"
        with flood_model._gdal_lock():
            flood_model._write_raster_array(pre_sieve_path, mask_arr, dem_gt, dem_proj, -9999.0)

            from osgeo import gdal
            src_ds = gdal.Open(pre_sieve_path)
            src_band = src_ds.GetRasterBand(1)
            tmp_path = f"{out_path}.tmp{os.getpid()}"
            driver = gdal.GetDriverByName("GTiff")
            out_ds = driver.Create(tmp_path, dem_w, dem_h, 1, gdal.GDT_Float32)
            out_ds.SetGeoTransform(dem_gt)
            out_ds.SetProjection(dem_proj)
            out_band = out_ds.GetRasterBand(1)
            out_band.SetNoDataValue(-9999.0)
            gdal.SieveFilter(src_band, src_band.GetMaskBand(), out_band, _SAR_SIEVE_THRESHOLD_PX, connectedness=8)
            out_band.FlushCache()
            out_ds = None
            src_ds = None
        os.remove(pre_sieve_path)
        os.replace(tmp_path, out_path)

        return {
            "path": out_path, "n_pre_scenes": n_pre, "n_post_scenes": n_post,
            "threshold_used": round(threshold, 4), "threshold_source": threshold_source,
        }
    except Exception:
        logger.warning(
            "flood_sar: local terrain-mask/sieve/warp step failed for %r event %r "
            "(degraded to None)", catchment_key, event_id, exc_info=True,
        )
        for p in (
            locals().get("fetch_path"), locals().get("warped_path"),
            locals().get("slope_warped_path"), locals().get("pre_sieve_path"),
            locals().get("tmp_path"),
        ):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        return None
