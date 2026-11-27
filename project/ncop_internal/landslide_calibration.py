# project/ncop_internal/landslide_calibration.py
# ---------------------------------------------------------------------------
# §L7 — data-driven landslide susceptibility calibration, the follow-up
# L6.6 left open: once the much richer NCOP inventory was pooled in, the
# L3.7 LOCO Frequency-Ratio score fell to a held-out AUC of 0.55 and the
# literature-AHP score to 0.60. See LANDSLIDE_EARLY_WARNING_METHODOLOGY.md
# §L7 for the diagnosis and results; in short, three things were wrong
# with how the old calibration transferred between catchments:
#
# 1. Per-catchment QUANTILE classes. flood_model._quantile_reclassify_
#    hazard puts the steepest 20% of EACH catchment in class 5, so
#    "slope class 5" meant ~38deg in Murree and ~53deg in Hunza — an FR
#    weight learned on one catchment's class 5 was applied to a
#    physically different slope band in the held-out one. Every factor
#    here is binned on ABSOLUTE, physically-meaningful edges (degrees,
#    km, mm/yr, NDVI), identical in every catchment.
# 2. Linear min-max stretching in the AHP score. A single extreme pixel
#    (e.g. a 20km-from-road cell) compresses every other pixel's value
#    into a narrow band; the response to a factor is also rarely linear
#    (landslide frequency typically peaks at intermediate slopes). One-
#    hot classes let the model learn a non-monotonic response per factor.
# 3. Unweighted pooling. 510 AJK events vs 4 Murree events meant the FR
#    tables were AJK's tables. Training weights here give each catchment
#    a share proportional to sqrt(n_events) (more data = more say, but
#    not 100x more), with presence and absence balanced within each.
#
# The model is an L2-regularized logistic regression on those one-hot
# classes (Newton/IRLS in plain NumPy — scikit-learn/scipy are not
# project dependencies), the most widely used statistical landslide-
# susceptibility model in the literature alongside FR/WoE, and directly
# interpretable: each class gets one coefficient (its log-odds
# contribution), so per-factor importance is still reportable the way
# the AHP weights are.
#
# Every reported accuracy figure is HELD OUT: leave-one-catchment-out
# (the model never sees the test catchment), plus a spatial-block split
# inside any catchment with enough events to test "does local data
# help". The literature AHP score and the infinite-slope FS are scored on
# the exact SAME held-out pixels, so every comparison is like-for-like.
# The calibrated score is only switched on in production ("auto" method)
# when its pooled held-out AUC beats AHP's by _APPROVAL_MIN_AUC_GAIN — if
# calibration does not genuinely help, the literature AHP stays in use.
#
# Never call these synchronously from a request handler — a cold run
# builds every catchment's full factor stack (minutes per catchment).
# ---------------------------------------------------------------------------

import hashlib
import json
import logging
import math
import os
import threading
import time

import numpy as np
from django.conf import settings

from . import flood_model

logger = logging.getLogger(__name__)

_CALIBRATION_SUBDIR = os.path.join("landslide_model", "_calibration")
_MODEL_FILENAME = "susceptibility_model.json"
_MODEL_SCHEMA_VERSION = 1

# Absolute class edges (interior boundaries; n edges -> n+1 classes).
# Chosen to span the real ranges measured across the six pilots
# (methodology doc §L6 table: mean slope 25-33deg, p90 38-53deg; mean
# elevation 1,481-3,908m), on round physical values, never fitted.
FACTOR_BIN_EDGES = {
    "slope": [10.0, 20.0, 30.0, 40.0, 50.0],                       # degrees
    "elevation": [1000.0, 1500.0, 2000.0, 2500.0, 3000.0, 3500.0, 4000.0, 4500.0],  # m
    "twi": [4.0, 6.0, 8.0, 10.0],
    "curvature": [-0.002, -0.0005, 0.0005, 0.002],                  # profile curvature, 1/m
    "distance_road": [0.1, 0.25, 0.5, 1.0, 2.0, 5.0],               # km
    "distance_drainage": [0.05, 0.1, 0.25, 0.5, 1.0],               # km
    "distance_fault": [1.0, 2.0, 5.0, 10.0, 20.0],                  # km (landslide_model.build_distance_to_fault_raster)
    "rainfall": [400.0, 600.0, 800.0, 1000.0, 1300.0, 1600.0],      # mm/yr (CHIRPS climatology)
    "ndvi": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
}
# Already-ordinal factors: their own 1..5 hazard classes (lulc/soil/pga),
# or the §L7 lithology GROUP index (1..6, 0 = ungrouped code).
CATEGORICAL_FACTORS = {
    "lulc": [1, 2, 3, 4, 5],
    "soil_type": [1, 2, 3, 4, 5],
    "pga": [1, 2, 3, 4, 5],
    "lithology_group": [0, 1, 2, 3, 4, 5, 6],
}
# Aspect: 8 compass sectors (N, NE, ... NW). Circular, so neither a
# min-max stretch nor ordinal edges apply.
ASPECT_SECTORS = 8

# Candidate feature sets compared under LOCO. "ahp_factors" is exactly
# the literature AHP factor list (minus aspect's southness transform,
# replaced by sectors), so a win there is purely from calibration, not
# from extra information; "with_elevation" adds absolute elevation, a
# standard factor in the Pakistan LSM literature (§3.3) that the AHP
# tables never had.
FEATURE_SETS = {
    "ahp_factors": [
        "slope", "twi", "curvature", "aspect", "distance_road", "distance_drainage",
        "rainfall", "ndvi", "lulc", "soil_type", "pga", "lithology_group",
    ],
    "with_elevation": [
        "slope", "elevation", "twi", "curvature", "aspect", "distance_road", "distance_drainage",
        "rainfall", "ndvi", "lulc", "soil_type", "pga", "lithology_group",
    ],
    # with_elevation + distance to active faults — the second control
    # after lithology in the 2,252-landslide 2005-Kashmir inventory (Kamp
    # et al. 2008) and one of the four dominant factors on the Karakoram
    # Highway (§L6). Roads are kept in every set: a real control here
    # (Owen et al. 2008's road-construction setting) AND, per Steger et
    # al. (2016), a "bias-describing" predictor whose omission confounds
    # the others when an inventory is denser along roads.
    "with_elevation_fault": [
        "slope", "elevation", "twi", "curvature", "aspect", "distance_road", "distance_drainage",
        "distance_fault", "rainfall", "ndvi", "lulc", "soil_type", "pga", "lithology_group",
    ],
    # with_elevation without the ~5km CHIRPS rainfall climatology (see
    # LOCAL_CANDIDATE_SETS for why rainfall is excluded from local use).
    "terrain": [
        "slope", "elevation", "twi", "curvature", "aspect", "distance_road", "distance_drainage",
        "ndvi", "lulc", "soil_type", "lithology_group",
    ],
    # The same without the ~5km CHIRPS rainfall climatology, which acted
    # as a region identifier across catchments (top LOCO importance 0.28
    # — Steger et al.'s coarse-proxy confounding case). Kept as a
    # candidate so spatial CV decides; on 2026-11-17 it LOST to the
    # rainfall-bearing sets inside both AJK and Hunza (0.68/0.69 vs
    # 0.74/0.76), i.e. within a catchment rainfall carries real signal.
    "local_terrain": [
        "slope", "elevation", "twi", "curvature", "aspect", "distance_road", "distance_drainage",
        "distance_fault", "ndvi", "lulc", "soil_type", "lithology_group",
    ],
}
# Sets the LOCAL (per-catchment) model may use — chosen between by
# spatial CV in _calibrate_local. Scale rule: no regional ZONING or
# CLIMATOLOGY field far coarser than the 30m map — CHIRPS rainfall (~5km
# cells) and the building-code PGA zones (a handful of regional design
# polygons; inside Hunza the fitted model gave the HIGHER seismic zone
# the lower hazard, -4.3 log-odds, an artifact of where the zone boundary
# happens to fall). Mapped material units (lithology, soil, land cover)
# stay — they are the standard LSM factors. Both excluded fields stay in
# the literature AHP score at their cited weights. CHIRPS in detail: on 2026-11-17 the rainfall-bearing sets
# scored higher in spatial CV, but their rainfall coefficients jumped
# between adjacent bins (+4.7 / -1.4 / -4.5 / +2.6 log-odds), i.e. it
# was printing 5km CHIRPS cells onto the map — the "high AUC, implausible
# map" case of Steger et al. (2016). Rainfall stays in the literature
# AHP score at its cited weight.
LOCAL_CANDIDATE_SETS = ("terrain", "local_terrain")
# Fallback when spatial CV has no candidate to choose between.
LOCAL_FEATURE_SET = "terrain"

_N_PRESENCE_SAMPLES = 4000   # per catchment (pixels inside presence geometry)
_N_ABSENCE_SAMPLES = 8000    # per catchment (pixels outside it)
_L2_PENALTY = 1.0
_APPROVAL_MIN_AUC_GAIN = 0.02
# Minimum held-out evidence before ANY calibrated output can be switched
# on in production: a 0.02 AUC gain measured on a handful of events is
# noise (the L3.7 -> L6.6 reversal already showed this once). Both must
# hold, plus the calibrated score must beat the baseline in a majority of
# the LOCO folds, not just in the pooled figure.
_APPROVAL_MIN_TOTAL_EVENTS = 100
_APPROVAL_MIN_CATCHMENTS = 3
_SPATIAL_CV_MIN_EVENTS = 30
# Per-catchment ("local") approval needs more than the spatial-CV floor:
# the inventory-size literature finds statistical models stabilise only
# with several tens to hundreds of mapped landslides; 50 keeps both
# real candidates (AJK 708, Hunza 72) while excluding a thin catchment
# where one quadrant's AUC would be noise.
_LOCAL_MIN_EVENTS = 50
_SAMPLING_SEED = 20261117

# Infinite-slope parameter grid (§L7 — the "FR-equivalent calibration"
# L3.7 named as future work). Soil depth z and a saturation scale on the
# TWI proxy are the two parameters with no measured value anywhere in
# this project; cohesion is scaled as a whole (the per-geology RATIOS
# stay literature-transferred, only their overall level is fitted).
_FS_SOIL_DEPTH_GRID_M = (0.5, 1.0, 1.5, 2.0, 3.0)
_FS_SATURATION_SCALE_GRID = (0.0, 0.5, 1.0)
_FS_COHESION_SCALE_GRID = (0.5, 1.0, 2.0)
FS_DEFAULT_PARAMS = {"soil_depth_m": 1.5, "saturation_scale": 1.0, "cohesion_scale": 1.0}


def _calibration_dir():
    path = os.path.join(settings.MEDIA_ROOT, _CALIBRATION_SUBDIR)
    os.makedirs(path, exist_ok=True)
    return path


def model_path():
    return os.path.join(_calibration_dir(), _MODEL_FILENAME)


# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------

def _digitize(arr, edges):
    return np.digitize(arr, np.asarray(edges, dtype=np.float64), right=False).astype(np.int16)


def _aspect_sector(aspect_deg):
    width = 360.0 / ASPECT_SECTORS
    return (np.floor(((aspect_deg + width / 2.0) % 360.0) / width)).astype(np.int16)


def factor_class_count(factor):
    if factor in FACTOR_BIN_EDGES:
        return len(FACTOR_BIN_EDGES[factor]) + 1
    if factor == "aspect":
        return ASPECT_SECTORS
    if factor in CATEGORICAL_FACTORS:
        return len(CATEGORICAL_FACTORS[factor])
    raise KeyError(factor)


def _neutral_class(factor):
    """Class index used where a factor's own raster is nodata: the middle
    bin for binned/circular factors, the "3" (scale midpoint) class for
    1..5 categoricals, the "ungrouped" class for lithology_group."""
    if factor in CATEGORICAL_FACTORS:
        values = CATEGORICAL_FACTORS[factor]
        return values.index(0) if 0 in values else values.index(3)
    return factor_class_count(factor) // 2


def _categorical_index(arr, factor):
    """Maps a categorical raster's values onto 0..k-1 positions of
    CATEGORICAL_FACTORS[factor]; any value outside the list goes to the
    position of the neutral/unknown class (3 for 1..5 scales, 0 for the
    lithology group), never dropped."""
    values = CATEGORICAL_FACTORS[factor]
    out = np.full(arr.shape, _neutral_class(factor), dtype=np.int16)
    rounded = np.rint(arr).astype(np.int64)
    for i, v in enumerate(values):
        out[rounded == v] = i
    return out


def _read(path):
    with flood_model._gdal_lock():
        arr, gt, proj, nodata, w, h = flood_model._read_raster_array(path)
    return arr, gt, proj, nodata, w, h


def build_lithology_group_raster(catchment_key, force=False):
    """Per-pixel §L7 lithology group index (1..6 in _GEOLOGY_GROUP_PARAMS
    order, 0 = code with no group) on the DEM grid. Returns the path, or
    None when the catchment has no geology coverage at all."""
    from . import landslide_model as lm

    lm.ensure_registered_with_flood_model(catchment_key)
    out_dir = os.path.join(settings.MEDIA_ROOT, lm._LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    out_path = os.path.join(out_dir, "geology_group.tif")
    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path

    raw = lm.fetch_and_rasterize_geology_pga(catchment_key, force=False)
    class_int_path, legend = raw.get(lm.GEOLOGY_LAYER, (None, {}))
    if class_int_path is None:
        return None
    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    _, dem_gt, _, _, dem_w, dem_h = _read(pipeline["paths"]["conditioned"])
    group_names = list(lm._GEOLOGY_GROUP_PARAMS)
    code_to_group_idx = {code: group_names.index(group) + 1 for code, group in lm._GEOLOGY_CODE_GROUP.items()}
    return lm._reclassify_legend_raster(class_int_path, legend, code_to_group_idx, dem_gt, dem_w, dem_h, out_path, default=0)


def load_factor_classes(catchment_key, factors):
    """Builds (or reads from every builder's own disk cache) each factor's
    raster for `catchment_key` and converts it to class indices.

    Returns {"valid": bool (h,w), "classes": {factor: int16 (h,w)},
    "continuous": {"slope_deg", "twi_norm", "cohesion", "friction",
    "gamma"} (for the infinite-slope calibration), "gt", "proj", "shape"}.
    A factor whose source raster is unavailable for this catchment
    (e.g. no geology coverage) is omitted from "classes", not faked."""
    from . import landslide_model as lm

    lm.ensure_registered_with_flood_model(catchment_key)
    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    dem, gt, proj, dem_nd, w, h = _read(pipeline["paths"]["conditioned"])
    valid = np.ones((h, w), dtype=bool) if dem_nd is None else (dem != dem_nd)
    twi_paths = flood_model.build_twi_curvature_rasters(catchment_key, force=False)

    def _path_for(factor):
        if factor == "slope":
            return twi_paths["slope_deg"]
        if factor == "elevation":
            return pipeline["paths"]["conditioned"]
        if factor == "twi":
            return twi_paths["twi"]
        if factor == "curvature":
            return twi_paths["curvature"]
        if factor == "aspect":
            return lm.build_aspect_raster(catchment_key, force=False)
        if factor == "distance_road":
            return lm.build_distance_to_road_raster(catchment_key, force=False)
        if factor == "distance_drainage":
            return flood_model.build_distance_to_stream_raster(catchment_key, force=False)["path"]
        if factor == "distance_fault":
            return lm.build_distance_to_fault_raster(catchment_key, force=False)
        if factor == "rainfall":
            return flood_model.build_rainfall_climatology_raster(catchment_key, force=False)["raw_path"]
        if factor == "ndvi":
            return flood_model.build_ndvi_raster(catchment_key, force=False)["raw_path"]
        if factor == "lulc":
            return lm.build_landslide_lulc_hazard_raster(catchment_key, force=False)
        if factor == "soil_type":
            return lm.build_landslide_soil_hazard_raster(catchment_key, force=False)
        if factor == "pga":
            return lm.build_geology_pga_hazard_rasters(catchment_key, force=False).get("pga_zones")
        if factor == "lithology_group":
            return build_lithology_group_raster(catchment_key, force=False)
        raise KeyError(factor)

    classes = {}
    for factor in factors:
        path = _path_for(factor)
        if path is None:
            logger.info("landslide_calibration: %r has no %r raster — factor omitted for this catchment", catchment_key, factor)
            continue
        arr, _, _, nd, fw, fh = _read(path)
        if (fw, fh) != (w, h):
            raise RuntimeError(f"landslide_calibration: {factor!r} dims {(fw, fh)} != DEM dims {(w, h)} for {catchment_key!r}")
        f_valid = valid if nd is None else (arr != nd)
        if factor in FACTOR_BIN_EDGES:
            cls = _digitize(arr, FACTOR_BIN_EDGES[factor])
        elif factor == "aspect":
            # WhiteboxTools writes -1 for flat cells (no aspect); those get
            # sector 0 like any other — slope's own classes already carry
            # "flat", so this cannot leak a spurious signal.
            cls = _aspect_sector(np.where(arr < 0, 0.0, arr))
        else:
            cls = _categorical_index(arr, factor)
        # Pixels where a factor itself is nodata get the factor's most
        # neutral class instead of invalidating the whole pixel (one
        # missing NDVI pixel shouldn't remove a slope sample).
        if not np.all(f_valid[valid]):
            cls = np.where(f_valid, cls, _neutral_class(factor)).astype(np.int16)
        classes[factor] = cls

    continuous = _infinite_slope_inputs(catchment_key, valid, twi_paths)
    return {"valid": valid, "classes": classes, "continuous": continuous, "gt": gt, "proj": proj, "shape": (h, w)}


def _infinite_slope_inputs(catchment_key, valid, twi_paths):
    """slope (deg), TWI min-max-normalized to [0,1], and the per-pixel
    geology cohesion/friction/unit-weight rasters build_infinite_slope_
    layer already writes — the exact inputs its FS formula uses."""
    from . import landslide_model as lm

    slope, _, _, _, _, _ = _read(twi_paths["slope_deg"])
    twi, _, _, twi_nd, _, _ = _read(twi_paths["twi"])
    twi_valid = valid if twi_nd is None else (valid & (twi != twi_nd))
    vals = twi[twi_valid]
    lo, hi = (float(vals.min()), float(vals.max())) if vals.size else (0.0, 1.0)
    twi_norm = np.clip((twi - lo) / ((hi - lo) or 1.0), 0.0, 1.0)

    lm.build_infinite_slope_layer(catchment_key, force=False)
    out_dir = os.path.join(settings.MEDIA_ROOT, lm._LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    params = {}
    for key, name, default in (
        ("cohesion", "geology_cohesion_kpa.tif", lm._GEOLOGY_CODE_COHESION_KPA["DS"]),
        ("friction", "geology_friction_deg.tif", lm._GEOLOGY_CODE_FRICTION_DEG["DS"]),
        ("gamma", "geology_unit_weight_knm3.tif", lm._GEOLOGY_CODE_UNIT_WEIGHT_KNM3["DS"]),
    ):
        path = os.path.join(out_dir, name)
        if os.path.exists(path):
            arr, _, _, nd, _, _ = _read(path)
            params[key] = np.where(arr == nd, default, arr) if nd is not None else arr
        else:
            params[key] = np.full(valid.shape, default, dtype=np.float64)
    return {"slope_deg": slope, "twi_norm": twi_norm, **params}


def infinite_slope_fs(slope_deg, twi_norm, cohesion, friction, gamma, params):
    """Same Montgomery & Dietrich (1994) form as landslide_model.
    build_infinite_slope_layer, with that function's own fixed constants
    replaced by `params` (soil_depth_m, saturation_scale, cohesion_scale).
    Vectorized over arrays of any (matching) shape."""
    from . import landslide_model as lm

    z = float(params["soil_depth_m"])
    m = np.clip(twi_norm * float(params["saturation_scale"]), 0.0, 1.0)
    c = cohesion * float(params["cohesion_scale"])
    theta = np.radians(slope_deg)
    phi = np.radians(friction)
    numerator = c + (gamma - m * lm._WATER_UNIT_WEIGHT_KNM3) * z * np.cos(theta) ** 2 * np.tan(phi)
    denominator = gamma * z * np.sin(theta) * np.cos(theta)
    with np.errstate(divide="ignore", invalid="ignore"):
        fs = np.where(np.abs(denominator) > 1e-9, numerator / denominator, lm._INFINITE_SLOPE_FS_CEILING)
    return np.clip(fs, 0.0, lm._INFINITE_SLOPE_FS_CEILING)


# ---------------------------------------------------------------------------
# Ground truth + sampling
# ---------------------------------------------------------------------------

def gather_ground_truth(bbox, sources=None):
    """Every wired ground-truth source for `bbox`, kept separate so
    callers can report per-source counts. `sources` restricts which are
    fetched (None = all). Each fetcher already degrades to [] on failure."""
    from . import accuracy_assessment as aa

    fetchers = {
        "coolr": aa.fetch_coolr_presence_geoms,
        "gfld": aa.fetch_gfld_presence_geoms,
        "glc": aa.fetch_glc_presence_geoms,
        "ncop_inventory": aa.fetch_ncop_landslide_inventory_presence_geoms,
        "ncop_recent": aa.fetch_ncop_recent_events_presence_geoms,
    }
    return {name: fn(bbox) for name, fn in fetchers.items() if sources is None or name in sources}


def _presence_mask(geoms, gt, proj, shape):
    from shapely.ops import unary_union

    h, w = shape
    if not geoms:
        return np.zeros((h, w), dtype=bool)
    with flood_model._gdal_lock():
        mask = flood_model._clip_array_to_polygon(
            np.ones((h, w), dtype=np.uint8), gt, proj, 0, unary_union(geoms).__geo_interface__,
        )
    return mask.astype(bool)


def _sample_pixels(valid, presence, rng, n_presence=_N_PRESENCE_SAMPLES, n_absence=_N_ABSENCE_SAMPLES):
    """Flat pixel indices: presence = uniform inside presence∩valid,
    absence = uniform over valid pixels outside presence. Same design as
    accuracy_assessment._sample_and_score (presence within the presence
    union, absence anywhere else in the AOI), on the raster grid."""
    pres_idx = np.flatnonzero(presence & valid)
    abs_idx = np.flatnonzero(valid & ~presence)
    if pres_idx.size > n_presence:
        pres_idx = rng.choice(pres_idx, n_presence, replace=False)
    if abs_idx.size > n_absence:
        abs_idx = rng.choice(abs_idx, n_absence, replace=False)
    return pres_idx, abs_idx


def build_training_table(catchment_keys=None, lite=True, sources=None, factors=None):
    """Samples every catchment with ground truth into one table.

    Returns {"catchments": {key: {"n_events", "n_events_by_source",
    "rows": slice, "bbox"}}, "factors", "classes": {factor: int16 (N,)}
    (missing factor in a catchment = -1), "y" (N,), "catchment_idx" (N,),
    "row_col": (N, 2), "ahp" (N,), "fs_inputs": {name: (N,)},
    "skipped": [keys with zero ground truth]}."""
    from . import landslide_model as lm

    if catchment_keys is None:
        catchment_keys = list(lm.PILOT_CATCHMENTS)
    if factors is None:
        factors = sorted({f for fs in FEATURE_SETS.values() for f in fs})
    rng = np.random.default_rng(_SAMPLING_SEED)

    parts = []
    meta = {}
    skipped = []
    offset = 0
    for idx, key in enumerate(catchment_keys):
        lm.ensure_registered_with_flood_model(key)
        bbox = flood_model.PILOT_CATCHMENTS[key]["bbox"]
        gt_sources = gather_ground_truth(bbox, sources=sources)
        geoms = [g for gs in gt_sources.values() for g in gs]
        if not geoms:
            skipped.append(key)
            logger.info("landslide_calibration: %r has zero ground truth — not used for training or testing", key)
            continue

        stack = load_factor_classes(key, factors)
        presence = _presence_mask(geoms, stack["gt"], stack["proj"], stack["shape"]) & stack["valid"]
        if not presence.any():
            skipped.append(key)
            logger.info("landslide_calibration: %r ground truth does not overlap any valid pixel", key)
            continue
        pres_idx, abs_idx = _sample_pixels(stack["valid"], presence, rng)
        flat = np.concatenate([pres_idx, abs_idx])
        y = np.concatenate([np.ones(pres_idx.size), np.zeros(abs_idx.size)])

        ahp_path = lm.build_landslide_susceptibility_raster(key, lite=lite, method="ahp")["score_path"]
        ahp_arr, _, _, _, _, _ = _read(ahp_path)

        n = flat.size
        part = {
            "classes": {f: (stack["classes"][f].ravel()[flat] if f in stack["classes"] else np.full(n, -1, dtype=np.int16)) for f in factors},
            "y": y,
            "catchment_idx": np.full(n, idx, dtype=np.int32),
            "row_col": np.column_stack(np.unravel_index(flat, stack["shape"])),
            "ahp": ahp_arr.ravel()[flat].astype(np.float64),
            "fs_inputs": {k: np.asarray(v).ravel()[flat].astype(np.float64) for k, v in stack["continuous"].items()},
        }
        parts.append(part)
        meta[key] = {
            "idx": idx, "bbox": bbox, "rows": slice(offset, offset + n),
            "n_events": len(geoms), "n_events_by_source": {s: len(g) for s, g in gt_sources.items()},
            "n_presence_px": int(pres_idx.size), "n_absence_px": int(abs_idx.size),
            "shape": stack["shape"],
        }
        offset += n

    if not parts:
        return {"catchments": {}, "factors": factors, "skipped": skipped}
    return {
        "catchments": meta,
        "factors": factors,
        "classes": {f: np.concatenate([p["classes"][f] for p in parts]) for f in factors},
        "y": np.concatenate([p["y"] for p in parts]),
        "catchment_idx": np.concatenate([p["catchment_idx"] for p in parts]),
        "row_col": np.concatenate([p["row_col"] for p in parts]),
        "ahp": np.concatenate([p["ahp"] for p in parts]),
        "fs_inputs": {k: np.concatenate([p["fs_inputs"][k] for p in parts]) for k in parts[0]["fs_inputs"]},
        "skipped": skipped,
    }


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

def design_matrix(classes, factors):
    """One-hot columns for every (factor, class); a class index of -1
    (factor unavailable in that catchment) contributes no column, i.e. the
    factor is neutral (zero log-odds) for that sample. Returns (X, columns)
    where columns[i] = (factor, class_index)."""
    n = len(next(iter(classes.values())))
    columns = [(f, c) for f in factors for c in range(factor_class_count(f))]
    X = np.zeros((n, len(columns)), dtype=np.float64)
    col = 0
    for f in factors:
        k = factor_class_count(f)
        cls = classes[f]
        ok = cls >= 0
        X[np.flatnonzero(ok), col + cls[ok].astype(np.int64)] = 1.0
        col += k
    return X, columns


def fit_logistic(X, y, sample_weight, l2=_L2_PENALTY, max_iter=60, tol=1e-7):
    """L2-regularized logistic regression via Newton/IRLS. The intercept
    is fitted but not penalized. Returns (intercept, coef)."""
    n, p = X.shape
    Xa = np.hstack([np.ones((n, 1)), X])
    beta = np.zeros(p + 1)
    w = sample_weight / sample_weight.sum() * n  # mean weight 1, so l2 has a sample-size-independent meaning
    penalty = np.full(p + 1, l2)
    penalty[0] = 0.0
    for _ in range(max_iter):
        eta = np.clip(Xa @ beta, -35, 35)
        prob = 1.0 / (1.0 + np.exp(-eta))
        grad = Xa.T @ (w * (prob - y)) + penalty * beta
        hess_w = w * prob * (1.0 - prob)
        hess = (Xa * hess_w[:, None]).T @ Xa + np.diag(penalty + 1e-9)
        step = np.linalg.solve(hess, grad)
        beta -= step
        if np.max(np.abs(step)) < tol:
            break
    return float(beta[0]), beta[1:]


def _training_weights(y, catchment_idx, n_events_by_idx):
    """Per-catchment share ∝ sqrt(n_events), split equally between that
    catchment's presence and absence samples (see module comment, item 3)."""
    w = np.zeros_like(y, dtype=np.float64)
    for idx in np.unique(catchment_idx):
        share = math.sqrt(max(n_events_by_idx.get(int(idx), 1), 1))
        for label in (0.0, 1.0):
            sel = (catchment_idx == idx) & (y == label)
            if sel.any():
                w[sel] = share / 2.0 / sel.sum()
    return w


def predict_logit(intercept, coef, X):
    return intercept + X @ coef


def _auc(scores, y):
    from . import accuracy_assessment as aa
    return aa.compute_auc(scores, y)


def _auc_entry(scores, y):
    from . import accuracy_assessment as aa
    auc = _auc(scores, y)
    return {"auc": round(auc, 4) if auc == auc else None, "interpretation": aa.interpret_auc(auc),
            "n_presence": int(y.sum()), "n_absence": int((1 - y).sum())}


def _fit_on(table, rows, factors):
    X, columns = design_matrix({f: table["classes"][f][rows] for f in factors}, factors)
    n_events_by_idx = {m["idx"]: m["n_events"] for m in table["catchments"].values()}
    w = _training_weights(table["y"][rows], table["catchment_idx"][rows], n_events_by_idx)
    intercept, coef = fit_logistic(X, table["y"][rows], w)
    return intercept, coef, columns


def _score_rows(table, rows, factors, intercept, coef):
    X, _ = design_matrix({f: table["classes"][f][rows] for f in factors}, factors)
    return predict_logit(intercept, coef, X)


def _fs_scores(table, rows, params):
    fi = table["fs_inputs"]
    fs = infinite_slope_fs(fi["slope_deg"][rows], fi["twi_norm"][rows], fi["cohesion"][rows],
                           fi["friction"][rows], fi["gamma"][rows], params)
    return -fs  # lower FS = higher hazard


def _best_fs_params(table, rows):
    best, best_auc = None, -1.0
    y = table["y"][rows]
    for z in _FS_SOIL_DEPTH_GRID_M:
        for s in _FS_SATURATION_SCALE_GRID:
            for k in _FS_COHESION_SCALE_GRID:
                params = {"soil_depth_m": z, "saturation_scale": s, "cohesion_scale": k}
                auc = _auc(_fs_scores(table, rows, params), y)
                if auc == auc and auc > best_auc:
                    best, best_auc = params, auc
    return best or dict(FS_DEFAULT_PARAMS), best_auc


def _spatial_blocks(row_col, shape, n_side=2):
    """Assigns each sample to one of n_side x n_side spatial blocks of its
    catchment's grid (contiguous quadrants), for within-catchment
    spatial cross-validation (random pixel splits would leak: adjacent
    pixels of one landslide polygon are near-duplicates)."""
    h, w = shape
    rb = np.minimum(row_col[:, 0] * n_side // max(h, 1), n_side - 1)
    cb = np.minimum(row_col[:, 1] * n_side // max(w, 1), n_side - 1)
    return rb * n_side + cb


def evaluate_loco(table, feature_set_names=None):
    """Leave-one-catchment-out comparison of every candidate feature set's
    calibrated logistic model vs the literature AHP score vs the default
    and calibrated infinite-slope FS — all on the SAME held-out samples.

    Returns {"per_fold": [...], "pooled": {method: auc entry},
    "spatial_cv": {catchment: {...}}}."""
    if feature_set_names is None:
        feature_set_names = list(FEATURE_SETS)
    keys = list(table["catchments"])
    if len(keys) < 2:
        return {"error": "fewer than 2 catchments with ground truth — nothing can be held out", "usable_catchments": keys}

    y_all = table["y"]
    per_fold = []
    pooled_scores = {name: [] for name in ["ahp", "infinite_slope_default", "infinite_slope_calibrated",
                                           *[f"calibrated_{fs}" for fs in feature_set_names]]}
    pooled_y = []
    for test_key in keys:
        test_rows = np.zeros(y_all.shape, dtype=bool)
        test_rows[table["catchments"][test_key]["rows"]] = True
        train_rows = ~test_rows
        y_test = y_all[test_rows]
        fold = {"test_catchment": test_key, "n_test_events": table["catchments"][test_key]["n_events"],
                "train_catchments": [k for k in keys if k != test_key], "methods": {}}

        ahp = table["ahp"][test_rows]
        fold["methods"]["ahp"] = _auc_entry(ahp, y_test)
        pooled_scores["ahp"].append(_rank_normalize(ahp))

        fs_def = _fs_scores(table, test_rows, FS_DEFAULT_PARAMS)
        fold["methods"]["infinite_slope_default"] = _auc_entry(fs_def, y_test)
        pooled_scores["infinite_slope_default"].append(_rank_normalize(fs_def))

        fs_params, _ = _best_fs_params(table, train_rows)
        fs_cal = _fs_scores(table, test_rows, fs_params)
        fold["methods"]["infinite_slope_calibrated"] = {**_auc_entry(fs_cal, y_test), "params": fs_params}
        pooled_scores["infinite_slope_calibrated"].append(_rank_normalize(fs_cal))

        for fs_name in feature_set_names:
            factors = FEATURE_SETS[fs_name]
            intercept, coef, _ = _fit_on(table, train_rows, factors)
            scores = _score_rows(table, test_rows, factors, intercept, coef)
            fold["methods"][f"calibrated_{fs_name}"] = _auc_entry(scores, y_test)
            pooled_scores[f"calibrated_{fs_name}"].append(_rank_normalize(scores))
        pooled_y.append(y_test)
        per_fold.append(fold)

    y_cat = np.concatenate(pooled_y)
    pooled = {name: _auc_entry(np.concatenate(parts), y_cat) for name, parts in pooled_scores.items()}
    # Event-weighted mean of per-fold AUCs — a second, pooling-free summary
    # (pooled AUC above compares ranks ACROSS catchments too; this one
    # only ever compares pixels within the same held-out catchment).
    fold_mean = {}
    for name in pooled_scores:
        num = den = 0.0
        for fold in per_fold:
            auc = fold["methods"][name]["auc"]
            if auc is not None:
                wgt = math.sqrt(fold["n_test_events"])
                num += wgt * auc
                den += wgt
        fold_mean[name] = round(num / den, 4) if den else None

    return {"per_fold": per_fold, "pooled": pooled, "fold_mean_sqrt_event_weighted": fold_mean,
            "spatial_cv": evaluate_spatial_cv(table, feature_set_names)}


def _rank_normalize(scores):
    """Percentile ranks within one fold, so pooling held-out scores from
    different folds' models (or a catchment-relative AHP score) compares
    "how high within its own catchment" rather than raw scales that were
    never meant to be comparable."""
    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(len(scores), dtype=np.float64)
    ranks[order] = np.arange(len(scores))
    return ranks / max(len(scores) - 1, 1)


def evaluate_spatial_cv(table, feature_set_names):
    """For each catchment with >= _SPATIAL_CV_MIN_EVENTS events: hold out
    one spatial quadrant at a time; train on every OTHER catchment plus
    this catchment's other three quadrants. Answers whether local data
    improves on the transferred (LOCO) model for well-sampled areas."""
    out = {}
    for key, meta in table["catchments"].items():
        if meta["n_events"] < _SPATIAL_CV_MIN_EVENTS:
            continue
        rows_c = np.zeros(table["y"].shape, dtype=bool)
        rows_c[meta["rows"]] = True
        blocks = np.full(table["y"].shape, -1)
        blocks[rows_c] = _spatial_blocks(table["row_col"][rows_c], meta["shape"])
        results = {name: {"scores": [], "y": []} for name in ["ahp", *[f"calibrated_{fs}" for fs in feature_set_names]]}
        per_block = []
        for b in range(4):
            test_rows = rows_c & (blocks == b)
            y_test = table["y"][test_rows]
            if y_test.sum() < 20 or (1 - y_test).sum() < 20:
                continue
            train_rows = ~test_rows
            block = {"block": b, "n_presence": int(y_test.sum()), "auc": {"ahp": _auc(table["ahp"][test_rows], y_test)}}
            results["ahp"]["scores"].append(_rank_normalize(table["ahp"][test_rows]))
            results["ahp"]["y"].append(y_test)
            for fs_name in feature_set_names:
                factors = FEATURE_SETS[fs_name]
                intercept, coef, _ = _fit_on(table, train_rows, factors)
                scores = _score_rows(table, test_rows, factors, intercept, coef)
                block["auc"][f"calibrated_{fs_name}"] = _auc(scores, y_test)
                results[f"calibrated_{fs_name}"]["scores"].append(_rank_normalize(scores))
                results[f"calibrated_{fs_name}"]["y"].append(y_test)
            block["auc"] = {k: round(v, 4) for k, v in block["auc"].items()}
            per_block.append(block)
        if not per_block:
            out[key] = {"n_events": meta["n_events"], "note": "no quadrant had >=20 presence and absence samples"}
            continue
        out[key] = {"n_events": meta["n_events"], "n_blocks_used": len(per_block), "blocks": per_block, "methods": {
            name: _auc_entry(np.concatenate(r["scores"]), np.concatenate(r["y"])) for name, r in results.items()
        }}
    return out


def _factor_importance(coef, columns, factors):
    """Range of each factor's class coefficients (max - min log-odds),
    normalized to sum to 1 — the calibrated model's analogue of the AHP
    weight table, for display only."""
    ranges = {}
    for f in factors:
        vals = [coef[i] for i, (cf, _) in enumerate(columns) if cf == f]
        ranges[f] = float(max(vals) - min(vals)) if vals else 0.0
    total = sum(ranges.values()) or 1.0
    return {f: round(v / total, 4) for f, v in sorted(ranges.items(), key=lambda kv: -kv[1])}


def _class_labels(factor):
    if factor in FACTOR_BIN_EDGES:
        e = FACTOR_BIN_EDGES[factor]
        return [f"<{e[0]:g}"] + [f"{e[i]:g}-{e[i + 1]:g}" for i in range(len(e) - 1)] + [f">={e[-1]:g}"]
    if factor == "aspect":
        return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][:ASPECT_SECTORS]
    if factor == "lithology_group":
        from . import landslide_model as lm
        return ["ungrouped", *lm._GEOLOGY_GROUP_PARAMS]
    return [str(v) for v in CATEGORICAL_FACTORS[factor]]


def calibrate(lite=True, sources=None, save=True):
    """Full §L7 run: sample every catchment, evaluate every candidate
    under LOCO + spatial CV, pick the best calibrated feature set by
    pooled held-out AUC, fit it on ALL data, fit the global infinite-
    slope parameters, and (save=True) persist the model with its own
    held-out evidence and an approval decision.

    Returns the model dict (also what is written to model_path())."""
    started = time.time()
    table = build_training_table(lite=lite, sources=sources)
    usable = list(table["catchments"])
    if len(usable) < 2:
        result = {"error": "fewer than 2 catchments have ground truth — cannot hold anything out",
                  "usable_catchments": usable, "skipped": table.get("skipped", [])}
        return result

    evaluation = evaluate_loco(table)
    pooled = evaluation["pooled"]
    candidates = {fs: pooled[f"calibrated_{fs}"]["auc"] or 0.0 for fs in FEATURE_SETS}
    chosen = max(candidates, key=candidates.get)
    factors = FEATURE_SETS[chosen]

    all_rows = np.ones(table["y"].shape, dtype=bool)
    intercept, coef, columns = _fit_on(table, all_rows, factors)
    fs_params, fs_in_sample_auc = _best_fs_params(table, all_rows)

    ahp_auc = pooled["ahp"]["auc"] or 0.0
    cal_auc = pooled[f"calibrated_{chosen}"]["auc"] or 0.0
    fs_def_auc = pooled["infinite_slope_default"]["auc"] or 0.0
    fs_cal_auc = pooled["infinite_slope_calibrated"]["auc"] or 0.0

    total_events = sum(m["n_events"] for m in table["catchments"].values())
    evidence_ok = total_events >= _APPROVAL_MIN_TOTAL_EVENTS and len(usable) >= _APPROVAL_MIN_CATCHMENTS

    def _approval(method, baseline, cal, base):
        wins = sum(1 for f in evaluation["per_fold"]
                   if (f["methods"][method]["auc"] or 0) > (f["methods"][baseline]["auc"] or 0))
        n = len(evaluation["per_fold"])
        reasons = []
        if not evidence_ok:
            reasons.append(f"insufficient ground truth: {total_events} events in {len(usable)} catchments "
                           f"(need >= {_APPROVAL_MIN_TOTAL_EVENTS} events in >= {_APPROVAL_MIN_CATCHMENTS})")
        if cal < base + _APPROVAL_MIN_AUC_GAIN:
            reasons.append(f"pooled held-out AUC {cal:.3f} does not beat {base:.3f} by {_APPROVAL_MIN_AUC_GAIN}")
        if wins * 2 <= n:
            reasons.append(f"beats the baseline in only {wins}/{n} held-out catchments")
        return {"approved": not reasons, "not_approved_reasons": reasons, "folds_won": f"{wins}/{n}",
                "total_events": total_events}

    coefficients = {}
    for f in factors:
        labels = _class_labels(f)
        coefficients[f] = {labels[c]: round(float(coef[i]), 5) for i, (cf, c) in enumerate(columns) if cf == f}

    local = _calibrate_local(table, evaluation["spatial_cv"])

    model = {
        "schema_version": _MODEL_SCHEMA_VERSION,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "method": "l2_logistic_regression_one_hot_absolute_bins",
        "feature_set": chosen,
        "factors": factors,
        "bin_edges": {f: FACTOR_BIN_EDGES[f] for f in factors if f in FACTOR_BIN_EDGES},
        "intercept": intercept,
        "coef": [float(v) for v in coef],
        "columns": [[f, int(c)] for f, c in columns],
        "coefficients_by_class": coefficients,
        "factor_importance": _factor_importance(coef, columns, factors),
        "l2_penalty": _L2_PENALTY,
        "training": {
            "lite": lite,
            "sources": sources or "all",
            "catchments": {k: {kk: v for kk, v in m.items() if kk in ("n_events", "n_events_by_source", "n_presence_px", "n_absence_px")}
                           for k, m in table["catchments"].items()},
            "skipped_no_ground_truth": table["skipped"],
            "n_samples": int(table["y"].size),
        },
        "evaluation": evaluation,
        "candidate_pooled_auc": candidates,
        "approval": {
            "susceptibility": {
                **_approval(f"calibrated_{chosen}", "ahp", cal_auc, ahp_auc),
                "calibrated_pooled_auc": cal_auc, "ahp_pooled_auc": ahp_auc,
                "rule": (f"calibrated pooled held-out AUC >= AHP's + {_APPROVAL_MIN_AUC_GAIN}, wins a majority of "
                         f"LOCO folds, and >= {_APPROVAL_MIN_TOTAL_EVENTS} events in >= {_APPROVAL_MIN_CATCHMENTS} catchments"),
            },
            "infinite_slope": {
                **_approval("infinite_slope_calibrated", "infinite_slope_default", fs_cal_auc, fs_def_auc),
                "calibrated_pooled_auc": fs_cal_auc, "default_pooled_auc": fs_def_auc,
                "params": fs_params, "in_sample_auc": round(fs_in_sample_auc, 4),
                "rule": (f"calibrated pooled held-out AUC >= default's + {_APPROVAL_MIN_AUC_GAIN}, wins a majority of "
                         f"LOCO folds, and >= {_APPROVAL_MIN_TOTAL_EVENTS} events in >= {_APPROVAL_MIN_CATCHMENTS} catchments"),
            },
        },
        "local": local,
        "runtime_seconds": round(time.time() - started, 1),
    }
    model["model_id"] = hashlib.sha1(json.dumps([model["intercept"], model["coef"], model["columns"], fs_params,
                                                 local.get("coef"), sorted(local.get("approved_catchments", {}))],
                                                sort_keys=True).encode()).hexdigest()[:10]
    if save:
        path = model_path()
        tmp = f"{path}.tmp{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump(model, f, indent=1, default=_json_default)
        os.replace(tmp, path)
        _invalidate_model_cache()
        logger.info("landslide_calibration: saved model %s (%s, approved=%s, local catchments=%s)", model["model_id"],
                    chosen, model["approval"]["susceptibility"]["approved"], sorted(local.get("approved_catchments", {})))
    return json.loads(json.dumps(model, default=_json_default))


def _calibrate_local(table, spatial_cv):
    """Per-catchment ("local") approval — the deployment rule the §L7
    finalization adopts. Statistical landslide models transfer poorly
    between dissimilar regions (confirmed here by LOCO: AJK<->Hunza) but
    improve on a heuristic model where the area's OWN inventory is used,
    so the local model (factor set chosen by spatial CV), fitted on all ground truth including
    the catchment's own, is approved ONLY for each catchment where, in
    spatial-block CV (held-out quadrants of that same catchment):
      - the catchment has >= _LOCAL_MIN_EVENTS events,
      - pooled AUC beats AHP's by >= _APPROVAL_MIN_AUC_GAIN, and
      - it beats AHP in a majority of the usable quadrants.
    Everywhere else (no or thin inventory, custom AOIs) the literature
    AHP stays in use — the standard heuristic choice where inventories
    are missing (the operational norm in the zoning literature)."""
    # The local factor set is chosen by the same held-out evidence it is
    # approved on: mean spatial-CV AUC over the catchments eligible for
    # local approval. (Choosing on the evaluation data makes the winning
    # figure slightly optimistic; with 3-4 candidates the selection
    # effect is small next to the >= 0.02 margin and majority-of-
    # quadrants requirement.)
    eligible = [cv for cv in spatial_cv.values() if "methods" in cv and cv["n_events"] >= _LOCAL_MIN_EVENTS]
    candidates = [fs for fs in LOCAL_CANDIDATE_SETS
                  if eligible and all(f"calibrated_{fs}" in cv["methods"] for cv in eligible)]
    if candidates:
        feature_set = max(candidates, key=lambda fs: np.mean(
            [cv["methods"][f"calibrated_{fs}"]["auc"] or 0.0 for cv in eligible]))
    else:
        feature_set = LOCAL_FEATURE_SET
    name = f"calibrated_{feature_set}"
    evidence = {}
    approved = {}
    for key, cv in spatial_cv.items():
        if "methods" not in cv or name not in cv["methods"]:
            continue
        cal = cv["methods"][name]["auc"] or 0.0
        base = cv["methods"]["ahp"]["auc"] or 0.0
        blocks = cv.get("blocks", [])
        wins = sum(1 for b in blocks if b["auc"].get(name, 0) > b["auc"].get("ahp", 0))
        reasons = []
        if cv["n_events"] < _LOCAL_MIN_EVENTS:
            reasons.append(f"{cv['n_events']} events < {_LOCAL_MIN_EVENTS}")
        if cal < base + _APPROVAL_MIN_AUC_GAIN:
            reasons.append(f"spatial-CV AUC {cal:.3f} does not beat AHP {base:.3f} by {_APPROVAL_MIN_AUC_GAIN}")
        if wins * 2 <= len(blocks):
            reasons.append(f"beats AHP in only {wins}/{len(blocks)} held-out quadrants")
        evidence[key] = {"n_events": cv["n_events"], "spatial_cv_auc": cal, "ahp_spatial_cv_auc": base,
                         "quadrants_won": f"{wins}/{len(blocks)}", "approved": not reasons,
                         "not_approved_reasons": reasons}
        if not reasons:
            approved[key] = evidence[key]

    factors = FEATURE_SETS[feature_set]
    intercept, coef, columns = _fit_on(table, np.ones(table["y"].shape, dtype=bool), factors)
    return {
        "feature_set": feature_set,
        "candidate_spatial_cv_auc": {fs: round(float(np.mean([cv["methods"][f"calibrated_{fs}"]["auc"] or 0.0
                                                              for cv in eligible])), 4) for fs in candidates},
        "factors": factors,
        "bin_edges": {f: FACTOR_BIN_EDGES[f] for f in factors if f in FACTOR_BIN_EDGES},
        "intercept": intercept,
        "coef": [float(v) for v in coef],
        "columns": [[f, int(c)] for f, c in columns],
        "factor_importance": _factor_importance(coef, columns, factors),
        "approved_catchments": approved,
        "evidence": evidence,
        "rule": (f">= {_LOCAL_MIN_EVENTS} events in the catchment, spatial-CV AUC >= AHP's + {_APPROVAL_MIN_AUC_GAIN}, "
                 f"and beats AHP in a majority of held-out quadrants"),
    }


def _json_default(obj):
    if isinstance(obj, slice):
        return [obj.start, obj.stop]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, tuple):
        return list(obj)
    raise TypeError(f"not JSON serializable: {type(obj)}")


# ---------------------------------------------------------------------------
# Model persistence + production scoring
# ---------------------------------------------------------------------------

_MODEL_CACHE_LOCK = threading.Lock()
_model_cache = {"mtime": None, "model": None}


def _invalidate_model_cache():
    with _MODEL_CACHE_LOCK:
        _model_cache["mtime"] = None
        _model_cache["model"] = None


def load_model():
    """The saved model dict, or None if calibrate() has never been saved
    (or the file is unreadable / an older schema)."""
    path = model_path()
    if not os.path.exists(path):
        return None
    mtime = os.path.getmtime(path)
    with _MODEL_CACHE_LOCK:
        if _model_cache["mtime"] == mtime:
            return _model_cache["model"]
    try:
        with open(path) as f:
            model = json.load(f)
    except (OSError, ValueError):
        logger.warning("landslide_calibration: unreadable model file %s", path, exc_info=True)
        return None
    if model.get("schema_version") != _MODEL_SCHEMA_VERSION:
        return None
    with _MODEL_CACHE_LOCK:
        _model_cache["mtime"] = mtime
        _model_cache["model"] = model
    return model


def approved_susceptibility_model():
    model = load_model()
    if model and model.get("approval", {}).get("susceptibility", {}).get("approved"):
        return model
    return None


def _scoring_view(model, scope):
    """The minimal dict score_catchment needs, plus display metadata, for
    either the global model or its local (per-catchment) model."""
    if scope == "local":
        local = model["local"]
        return {"scope": "local", "model_id": f"{model['model_id']}L", "feature_set": local["feature_set"],
                "factors": local["factors"], "intercept": local["intercept"], "coef": local["coef"],
                "columns": local["columns"], "factor_importance": local["factor_importance"],
                "created_at": model.get("created_at"), "local_evidence": local.get("evidence", {})}
    approval = model.get("approval", {}).get("susceptibility", {})
    return {"scope": "global", "model_id": model["model_id"], "feature_set": model["feature_set"],
            "factors": model["factors"], "intercept": model["intercept"], "coef": model["coef"],
            "columns": model["columns"], "factor_importance": model["factor_importance"],
            "created_at": model.get("created_at"), "approved": bool(approval.get("approved")),
            "held_out_pooled_auc": approval.get("calibrated_pooled_auc"),
            "ahp_held_out_pooled_auc": approval.get("ahp_pooled_auc")}


def scoring_model_for(catchment_key, require_approved=True):
    """Which calibrated model (if any) scores `catchment_key`:
    1. the global model, if IT passed its own (cross-catchment) approval;
    2. else the local model, if this catchment is in its approved list;
    3. else None (caller falls back to AHP) — or, with
       require_approved=False (an explicit "calibrated" request), the
       local model where this catchment has local evidence, else the
       global one."""
    model = load_model()
    if model is None:
        return None
    if model.get("approval", {}).get("susceptibility", {}).get("approved"):
        return _scoring_view(model, "global")
    local = model.get("local") or {}
    if catchment_key in (local.get("approved_catchments") or {}):
        view = _scoring_view(model, "local")
        view["approved"] = True
        view.update({k: local["approved_catchments"][catchment_key][k] for k in ("spatial_cv_auc", "ahp_spatial_cv_auc")})
        return view
    if require_approved:
        return None
    if local and catchment_key in (local.get("evidence") or {}):
        view = _scoring_view(model, "local")
        view["approved"] = False
        return view
    return _scoring_view(model, "global")


def approved_infinite_slope_params():
    model = load_model()
    approval = (model or {}).get("approval", {}).get("infinite_slope", {})
    if approval.get("approved"):
        return {k: float(v) for k, v in approval["params"].items()}
    return None


def score_catchment(catchment_key, model):
    """Calibrated per-pixel score for one catchment on the [1,5] scale
    (1 + 4 * modeled probability under the balanced training prior), so
    every downstream consumer built around the AHP [1,5] convention —
    Natural Breaks zoning, smoothing, the trigger matrix — works
    unchanged. Returns (score_array, valid, gt, proj)."""
    factors = model["factors"]
    stack = load_factor_classes(catchment_key, factors)
    h, w = stack["shape"]
    valid = stack["valid"]
    coef = np.asarray(model["coef"], dtype=np.float64)
    columns = [(f, int(c)) for f, c in model["columns"]]
    offsets = {}
    for i, (f, c) in enumerate(columns):
        offsets.setdefault(f, i)

    logit = np.full((h, w), float(model["intercept"]), dtype=np.float64)
    for f in factors:
        if f not in stack["classes"]:
            continue  # unavailable here: neutral, exactly as in training
        k = factor_class_count(f)
        table = coef[offsets[f]:offsets[f] + k]
        logit += table[np.clip(stack["classes"][f], 0, k - 1)]
    prob = 1.0 / (1.0 + np.exp(-np.clip(logit, -35, 35)))
    score = np.where(valid, 1.0 + 4.0 * prob, flood_model._DISCHARGE_STAGE_NODATA)
    return score, valid, stack["gt"], stack["proj"]
