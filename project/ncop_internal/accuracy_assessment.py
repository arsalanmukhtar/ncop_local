# project/ncop_internal/accuracy_assessment.py
# ---------------------------------------------------------------------------
# AUC (Area Under the Curve) accuracy assessment for flood hazard/
# susceptibility rasters — see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md §0.7
# for the full research and design behind every choice below.
#
# Deliberately standalone/reusable — NOT imported by or coupled to
# flood_model.py or flood_exposure.py. Phase 1's HAND raster is the first
# consumer, but Phase 2.5's AHP susceptibility score (and any future
# continuous hazard/susceptibility raster) calls the exact same
# compute_auc()/assess_raster_auc(), so this module knows nothing about
# HAND, catchments, or pilot bboxes specifically.
#
# Pure NumPy — no scipy/scikit-learn (neither is a dependency in this app;
# confirmed directly against requirements.txt in §0.7's own research). AUC
# is computed via the Mann-Whitney U rank-sum identity: O(n log n) via one
# np.argsort, not the naive O(n_pos x n_neg) pairwise comparison.
#
# Crash-safety / production notes:
#   - Raster reads use raw ReadRaster/struct.unpack, never
#     Band.ReadAsArray/gdal_array — the same NumPy/GDAL ABI mismatch this
#     whole app already works around (see flood_model.py's own docstring).
#   - The ground-truth WFS fetch (the 20 existing flood-extent layers,
#     §0.5) degrades to an empty list on any network/parsing failure,
#     never raises past this module — matching flood_exposure.py's own
#     established convention for external calls.
#   - Point sampling (_sample_points) is bounded by a maximum attempt
#     count, not an unbounded while-loop — a presence polygon that's tiny
#     relative to the AOI bbox degrades to fewer samples than requested
#     rather than spinning forever.
# ---------------------------------------------------------------------------

import logging
import random

import numpy as np

logger = logging.getLogger(__name__)

# Same GeoServer host/workspace the methodology doc's own Phase-0/0.7
# research already confirmed live for the 20 existing flood-extent layers
# — a DIFFERENT host from flood_exposure.py's gcop workspace (172.18.7.35),
# not a typo.
_FLOOD_EXTENT_WFS_HOST = "172.18.7.21:8080"
_FLOOD_EXTENT_WFS_WORKSPACE = "hydrological_global"
_WFS_TIMEOUT_SECONDS = 30

# Matches the literature's own convention (§0.7): >=0.9 excellent down to
# <0.6 fail (no better than chance, or worse).
_AUC_INTERPRETATION_BANDS = (
    (0.9, "excellent"),
    (0.8, "good"),
    (0.7, "fair"),
    (0.6, "poor"),
)

# Every {river_prefix}{severity}fex layer key this project's own audit
# (§0.5) confirmed exists in the hydrological_global workspace — Jhelum is
# the one system without a Medium band, matching map-layers.js's own
# buildFloodExtents() table exactly.
FLOOD_EXTENT_RIVER_SYSTEMS = {
    "upper_indus": {"prefix": "ui", "severities": ("h", "m", "l")},
    "lower_indus": {"prefix": "li", "severities": ("h", "m", "l")},
    "jhelum":      {"prefix": "j",  "severities": ("h", "l")},
    "chenab":      {"prefix": "c",  "severities": ("h", "m", "l")},
    "ravi":        {"prefix": "r",  "severities": ("h", "m", "l")},
    "sutlej":      {"prefix": "s",  "severities": ("h", "m", "l")},
    "kabul":       {"prefix": "k",  "severities": ("h", "m", "l")},
}


def interpret_auc(auc):
    """Maps a raw AUC value to the literature's own band labels. NaN (the
    "can't compute" sentinel compute_auc returns when one class has zero
    samples) maps to "undefined", not silently treated as a score."""
    if auc != auc:  # NaN != NaN is the standard float NaN check
        return "undefined"
    for threshold, label in _AUC_INTERPRETATION_BANDS:
        if auc >= threshold:
            return label
    return "fail"


def compute_auc(scores, labels):
    """AUC via the rank-sum (Mann-Whitney U) identity — O(n log n), one
    np.argsort, no scipy/sklearn (see module docstring). `labels` is 1 for
    a flood-presence sample, 0 for absence; `scores` is any continuous
    score where higher means 'more flood-prone'. Tied scores (common on a
    quantized raster) are handled via average-rank, not left/right-biased
    — verified against a hand-computed example in this module's own tests.
    Returns NaN (not a crash) if either class has zero samples — AUC is
    undefined without both classes present."""
    scores = np.asarray(scores, dtype=float)
    labels = np.asarray(labels, dtype=float)
    if scores.shape != labels.shape:
        raise ValueError(
            f"scores and labels must be the same shape, got {scores.shape} vs {labels.shape}"
        )
    if scores.size == 0:
        return float("nan")

    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(len(scores))
    ranks[order] = np.arange(1, len(scores) + 1)
    # Average tied ranks so exact-tie scores don't bias the result toward
    # whichever class happened to sort first for a given value.
    _, inverse, counts = np.unique(scores, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts))
    np.add.at(sums, inverse, ranks)
    ranks = (sums / counts)[inverse]

    n_pos = float(labels.sum())
    n_neg = float(len(labels) - n_pos)
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    rank_sum_pos = ranks[labels == 1].sum()
    u_stat = rank_sum_pos - n_pos * (n_pos + 1) / 2
    return float(u_stat / (n_pos * n_neg))


def fetch_flood_extent_presence(river_system, bbox, severities=None):
    """Ground-truth presence polygons from the 20 existing flood-extent
    layers (§0.5) for one named river system (a key of
    FLOOD_EXTENT_RIVER_SYSTEMS, e.g. "chenab"), bbox-filtered. Returns a
    list of shapely geometries — empty if the system is unknown, the WFS
    call fails, or (as CONFIRMED LIVE for the Nullah Lai pilot in §0.7's
    own research) the bbox simply doesn't overlap any of that system's
    polygons; never raises."""
    if river_system not in FLOOD_EXTENT_RIVER_SYSTEMS:
        logger.warning(
            "accuracy_assessment: unknown river_system %r - known: %s",
            river_system, list(FLOOD_EXTENT_RIVER_SYSTEMS),
        )
        return []
    cfg = FLOOD_EXTENT_RIVER_SYSTEMS[river_system]
    sevs = severities if severities is not None else cfg["severities"]

    import requests
    from shapely.geometry import shape as shapely_shape

    minx, miny, maxx, maxy = bbox
    geoms = []
    for sev in sevs:
        if sev not in cfg["severities"]:
            continue  # e.g. Jhelum has no "m" band — silently skip, not an error
        layer_key = f"{cfg['prefix']}{sev}fex"
        url = (
            f"http://{_FLOOD_EXTENT_WFS_HOST}/geoserver/{_FLOOD_EXTENT_WFS_WORKSPACE}/ows"
            f"?service=WFS&version=2.0.0&request=GetFeature"
            f"&typeNames={_FLOOD_EXTENT_WFS_WORKSPACE}:{layer_key}&outputFormat=application/json"
            f"&bbox={minx},{miny},{maxx},{maxy},EPSG:4326"
        )
        try:
            resp = requests.get(url, timeout=_WFS_TIMEOUT_SECONDS)
            resp.raise_for_status()
            data = resp.json()
        except Exception:
            logger.warning(
                "accuracy_assessment: WFS fetch failed for layer %r (degraded — treated as empty)",
                layer_key, exc_info=True,
            )
            continue
        for feat in data.get("features", []) or []:
            geom = shapely_shape(feat["geometry"])
            if not geom.is_valid:
                geom = geom.buffer(0)
            geoms.append(geom)
    return geoms


def _sample_points(n, bbox, predicate, max_attempts_multiplier=200):
    """Rejection-samples up to n (lon, lat) shapely Points inside bbox
    satisfying predicate(point) -> bool. Bounded by n * multiplier total
    attempts — a predicate that's rarely true (e.g. a small presence
    polygon relative to a large bbox) degrades to fewer than n points and
    logs a warning, rather than looping indefinitely."""
    from shapely.geometry import Point

    minx, miny, maxx, maxy = bbox
    points = []
    max_attempts = max(n * max_attempts_multiplier, 1000)
    attempts = 0
    while len(points) < n and attempts < max_attempts:
        attempts += 1
        pt = Point(random.uniform(minx, maxx), random.uniform(miny, maxy))
        if predicate(pt):
            points.append(pt)
    if len(points) < n:
        logger.warning(
            "accuracy_assessment: only sampled %d/%d requested points within %d attempts "
            "(the target region is likely small relative to the bbox)",
            len(points), n, attempts,
        )
    return points


def _read_raster_values_at_points(raster_path, points):
    """Reads `raster_path`'s band-1 value at each point's pixel location
    via raw ReadRaster/struct (never Band.ReadAsArray/gdal_array — see
    module docstring). Points outside the raster's own pixel extent, or
    landing on a NoData pixel, are silently dropped — returns (values,
    kept_points) so the caller's label list can be filtered in lockstep."""
    import struct
    from osgeo import gdal

    ds = gdal.Open(raster_path)
    if ds is None:
        raise RuntimeError(f"gdal.Open could not read raster at {raster_path}")
    band = ds.GetRasterBand(1)
    gt = ds.GetGeoTransform()
    w, h = ds.RasterXSize, ds.RasterYSize
    nodata = band.GetNoDataValue()

    values, kept_points = [], []
    for pt in points:
        col = int((pt.x - gt[0]) / gt[1])
        row = int((pt.y - gt[3]) / gt[5])
        if not (0 <= col < w and 0 <= row < h):
            continue
        raw = band.ReadRaster(col, row, 1, 1, buf_type=gdal.GDT_Float32)
        val = struct.unpack("<f", raw)[0]
        if nodata is not None and val == nodata:
            continue
        values.append(val)
        kept_points.append(pt)
    ds = None
    return values, kept_points


def assess_raster_auc(raster_path, presence_geoms, aoi_bbox, n_samples=500, invert_score=True):
    """The actual deliverable — combines sampling + raster scoring +
    compute_auc() into one call. `presence_geoms` is a list of shapely
    (Multi)Polygons (typically from fetch_flood_extent_presence(), but
    deliberately source-agnostic — any presence-polygon source works,
    including a future real-historical-observation dataset). Presence
    points are sampled inside the union of presence_geoms; absence points
    are sampled inside aoi_bbox but outside that same union.
    `invert_score=True` (the default, correct for HAND: lower HAND = more
    flood-prone, so score = -HAND) flips the raster's raw values before
    scoring; pass False for a raster where higher already means more
    flood-prone (e.g. a future AHP susceptibility index, §0.7's own note).

    Returns {"auc", "n_presence", "n_absence", "interpretation"} — never
    raises for a missing/insufficient ground truth (a real, confirmed-live
    condition for the Nullah Lai pilot specifically, per §0.7); returns a
    clearly-labelled "no_ground_truth"/"insufficient_samples"
    interpretation instead."""
    if not presence_geoms:
        return {"auc": float("nan"), "n_presence": 0, "n_absence": 0, "interpretation": "no_ground_truth"}

    from shapely.ops import unary_union
    from shapely.prepared import prep

    presence_union = unary_union(presence_geoms)
    prepared_presence = prep(presence_union)

    presence_points = _sample_points(n_samples, aoi_bbox, prepared_presence.intersects)
    absence_points = _sample_points(
        n_samples, aoi_bbox, lambda pt: not prepared_presence.intersects(pt)
    )

    presence_vals, _ = _read_raster_values_at_points(raster_path, presence_points)
    absence_vals, _ = _read_raster_values_at_points(raster_path, absence_points)

    if not presence_vals or not absence_vals:
        return {
            "auc": float("nan"),
            "n_presence": len(presence_vals),
            "n_absence": len(absence_vals),
            "interpretation": "insufficient_samples",
        }

    scores = np.array(presence_vals + absence_vals, dtype=float)
    if invert_score:
        scores = -scores
    labels = np.array([1] * len(presence_vals) + [0] * len(absence_vals), dtype=float)

    auc = compute_auc(scores, labels)
    return {
        "auc": round(auc, 4) if auc == auc else auc,
        "n_presence": len(presence_vals),
        "n_absence": len(absence_vals),
        "interpretation": interpret_auc(auc),
    }
