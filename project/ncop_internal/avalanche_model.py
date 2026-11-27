# project/ncop_internal/avalanche_model.py
# ---------------------------------------------------------------------------
# Snow avalanche susceptibility (methodology doc §3.8) — a mechanically
# DISTINCT hazard from both the soil-slide model (landslide_model.py) and
# rockfall (landslide_model.build_rockfall_susceptibility_flag): governed
# by snowpack accumulation/wind-loading/temperature, not rainfall/soil-
# saturation at all — entirely separate from the rainfall-triggered
# ID-threshold check (landslide_trigger.py/L4), never combined with it.
#
# Elevation/slope/aspect/curvature factors + a lighter-rigor AHP-style
# weighting, grounded in a real, directly-matched Pakistan study set in
# the Hunza Valley/Batura Glacier area — "Snow Avalanche Hazard Mapping
# Using a GIS-Based AHP Approach: A Case of Glaciers in Northern Pakistan
# from 2012 to 2022", Remote Sensing (MDPI), doi:10.3390/rs15225375 — the
# exact corridor already named as this project's own L6 second pilot
# (methodology doc §10/§13-L6).
#
# HONEST GAP, stated plainly, not hidden: this weighting is NOT Saaty-CR-
# validated the way landslide_ahp.py's own table is — a real, smaller
# rigor gap versus the main slide model, not silently presented as
# equally rigorous. Real future work: a genuine avalanche_ahp.py with the
# same CR-validation discipline, once a dedicated high-elevation pilot
# (L6) makes this a load-bearing layer rather than a screening one.
#
# Zero new fetch code: reuses flood_model.build_hand_pipeline's own DEM
# (elevation), flood_model.build_twi_curvature_rasters (slope/curvature),
# and landslide_model.build_aspect_raster (aspect) directly.
# ---------------------------------------------------------------------------

import json
import logging
import os

import numpy as np
from django.conf import settings

from . import flood_model, landslide_model

logger = logging.getLogger(__name__)

_AVALANCHE_MEDIA_SUBDIR = "avalanche_model"

# Elevation gate: seasonal-snow-relevant, not the region's own permanent
# snowline (confirmed live this session, ~4,700-5,170m for Hunza/
# Shimshal — much higher than where real Pakistani winter-avalanche road
# closures are routinely reported: KKH/Naran-Kaghan/Neelum corridors,
# commonly 2,000-3,000m). This project's own reasoned threshold, not an
# independently-cited fitted value — see methodology doc §3.8.
AVALANCHE_ELEVATION_GATE_M = 2500.0

# Standard, general avalanche-science slope range (not Pakistan-specific
# — see methodology doc §3.8): release zones most commonly 25-50deg,
# activity peaking in a narrower 30-45deg sub-band. The full 25-50 range
# is the HARD GATE (below/above this, avalanche release is mechanically
# atypical); the narrower 30-45 band is weighted higher within the
# scoring below, not used as a second hard gate.
AVALANCHE_SLOPE_GATE_MIN_DEG = 25.0
AVALANCHE_SLOPE_GATE_MAX_DEG = 50.0
AVALANCHE_SLOPE_PEAK_MIN_DEG = 30.0
AVALANCHE_SLOPE_PEAK_MAX_DEG = 45.0

# Lighter-rigor factor weights (see module docstring's own honest-gap
# note) — elevation/slope/aspect/curvature, informed by the Hunza/
# Batura AHP paper's own factor SELECTION (it uses exactly these four),
# not its own unpublished numeric weights (not confirmed live this
# session) — this project's own reasoned split, weighting slope highest
# since it is both the gating AND the single most literature-consistent
# release-zone discriminator across avalanche literature generally.
AVALANCHE_FACTOR_WEIGHTS = {
    "slope": 0.40,
    "elevation": 0.25,
    "aspect": 0.20,
    "curvature": 0.15,
}


def build_avalanche_susceptibility_raster(catchment_key, force=False):
    """Elevation- and slope-gated avalanche-susceptibility score
    ([0,1], NOT the [1,5] AHP scale landslide_model.py's own slide score
    uses — a deliberate difference, signaling this is a different,
    lighter-rigor layer, not a directly-comparable susceptibility
    number). Pixels outside the gate (elevation < AVALANCHE_ELEVATION_
    GATE_M or slope outside [GATE_MIN, GATE_MAX]) are NODATA, not a
    fabricated low score — a catchment mostly below the gate (e.g.
    Murree/Galyat) correctly, honestly returns a mostly-empty raster,
    not a wrong "low avalanche risk everywhere" claim.

    Returns {"score_path", "gate_applied_fraction"} — gate_applied_
    fraction is the fraction of the catchment's own valid area that
    falls INSIDE the elevation/slope gate, i.e. the real, honest "how
    much of this catchment is even avalanche-relevant terrain" figure,
    cached in a small JSON sidecar alongside the raster so a cache hit
    doesn't need to re-read/recompute anything to report it."""
    landslide_model.ensure_registered_with_flood_model(catchment_key)

    out_dir = os.path.join(settings.MEDIA_ROOT, _AVALANCHE_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "avalanche_score.tif")
    meta_path = os.path.join(out_dir, "avalanche_score_meta.json")

    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0 and os.path.exists(meta_path):
        with open(meta_path, "r") as f:
            meta = json.load(f)
        return {"score_path": out_path, "gate_applied_fraction": meta["gate_applied_fraction"]}

    pipeline = flood_model.build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]
    twi_paths = flood_model.build_twi_curvature_rasters(catchment_key, force=force)
    aspect_path = landslide_model.build_aspect_raster(catchment_key, force=force)

    with flood_model._gdal_lock():
        elev_arr, dem_gt, dem_proj, elev_nodata, w, h = flood_model._read_raster_array(dem_path)
        slope_arr, _, _, slope_nodata, sw, sh = flood_model._read_raster_array(twi_paths["slope_deg"])
        curv_arr, _, _, curv_nodata, cw, ch = flood_model._read_raster_array(twi_paths["curvature"])
        aspect_arr, _, _, aspect_nodata, aw, ah = flood_model._read_raster_array(aspect_path)

    if (sw, sh) != (w, h) or (cw, ch) != (w, h) or (aw, ah) != (w, h):
        raise RuntimeError(f"avalanche_model: factor raster dims mismatch for {catchment_key!r}")

    valid = np.ones((h, w), dtype=bool)
    for arr, nodata in ((elev_arr, elev_nodata), (slope_arr, slope_nodata),
                        (curv_arr, curv_nodata), (aspect_arr, aspect_nodata)):
        if nodata is not None:
            valid &= (arr != nodata)

    gate = (
        valid
        & (elev_arr >= AVALANCHE_ELEVATION_GATE_M)
        & (slope_arr >= AVALANCHE_SLOPE_GATE_MIN_DEG)
        & (slope_arr <= AVALANCHE_SLOPE_GATE_MAX_DEG)
    )
    gate_fraction = round(float(np.sum(gate)) / max(int(np.sum(valid)), 1), 4)

    # Slope sub-score: peaks in the 30-45deg "activity peak" band,
    # tapers linearly toward the gate's own 25/50deg edges — a simple,
    # real, literature-consistent shape (not a step function at the
    # gate boundary, which would be a false-precision cliff).
    slope_score = np.where(
        slope_arr < AVALANCHE_SLOPE_PEAK_MIN_DEG,
        (slope_arr - AVALANCHE_SLOPE_GATE_MIN_DEG) / (AVALANCHE_SLOPE_PEAK_MIN_DEG - AVALANCHE_SLOPE_GATE_MIN_DEG),
        np.where(
            slope_arr > AVALANCHE_SLOPE_PEAK_MAX_DEG,
            1.0 - (slope_arr - AVALANCHE_SLOPE_PEAK_MAX_DEG) / (AVALANCHE_SLOPE_GATE_MAX_DEG - AVALANCHE_SLOPE_PEAK_MAX_DEG),
            1.0,
        ),
    )
    slope_score = np.clip(slope_score, 0.0, 1.0)

    # Elevation sub-score: min-max stretch over the GATED area's own
    # real range (higher elevation = more seasonal snow accumulation =
    # higher hazard, within the gate) — same catchment-relative
    # normalization convention landslide_model.py's own continuous
    # factors already use.
    gated_elev = elev_arr[gate]
    if gated_elev.size:
        elo, ehi = float(np.min(gated_elev)), float(np.max(gated_elev))
        espan = (ehi - elo) or 1.0
        elevation_score = np.clip((elev_arr - elo) / espan, 0.0, 1.0)
    else:
        elevation_score = np.zeros((h, w), dtype=np.float64)

    # Aspect sub-score: the Hunza/Batura paper's own real, non-monotonic
    # finding — BOTH south and north aspects more avalanche-prone (wind-
    # loading on lee slopes), not landslide_model.py's own simple
    # "southness" transform. Modeled as distance from the EAST-WEST axis
    # (90/270deg) rather than distance from north/south — peaks at due
    # north AND due south alike, troughs at due east/west.
    aspect_rad = np.radians(aspect_arr)
    aspect_score = np.abs(np.cos(aspect_rad))  # 1.0 at N(0)/S(180), 0.0 at E(90)/W(270)

    # Curvature sub-score: convex (ridge-like, positive) terrain sheds
    # snow, concave (bowl/gully-like, negative) terrain ACCUMULATES it —
    # the standard avalanche-starting-zone concept (a loaded concave
    # slope), inverted from a simple magnitude read. Normalized over the
    # gated area's own real range, same convention as elevation above.
    gated_curv = curv_arr[gate]
    if gated_curv.size:
        clo, chi = float(np.min(gated_curv)), float(np.max(gated_curv))
        cspan = (chi - clo) or 1.0
        curvature_score = 1.0 - np.clip((curv_arr - clo) / cspan, 0.0, 1.0)
    else:
        curvature_score = np.zeros((h, w), dtype=np.float64)

    score = (
        AVALANCHE_FACTOR_WEIGHTS["slope"] * slope_score
        + AVALANCHE_FACTOR_WEIGHTS["elevation"] * elevation_score
        + AVALANCHE_FACTOR_WEIGHTS["aspect"] * aspect_score
        + AVALANCHE_FACTOR_WEIGHTS["curvature"] * curvature_score
    )
    score = np.where(gate, score, flood_model._DISCHARGE_STAGE_NODATA)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, score, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)

    tmp_meta = f"{meta_path}.tmp{os.getpid()}"
    with open(tmp_meta, "w") as f:
        json.dump({"gate_applied_fraction": gate_fraction}, f)
    os.replace(tmp_meta, meta_path)

    return {"score_path": out_path, "gate_applied_fraction": gate_fraction}
