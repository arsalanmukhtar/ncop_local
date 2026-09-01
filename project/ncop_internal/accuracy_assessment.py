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

# Global Flood Database (Tellman et al. 2021, Nature — "Satellite imaging
# reveals increased proportion of population exposed to floods"; hosted
# publicly as a Google Earth Engine ImageCollection). See methodology doc
# §0.20 for the full research trail: this is a genuinely INDEPENDENT
# ground-truth source from fetch_flood_extent_presence() above (real
# MODIS satellite observations of actual historical floods, 2000-2018,
# not a hazard model), reusing this app's EXISTING Earth Engine plumbing
# (the same initialize_earth_engine() side effect flood_model.py's own
# DEM fetch already depends on) — zero new dependency, zero scraping.
#
# LICENSE: CC BY-NC 4.0 (non-commercial). NCOP is a government/public
# disaster-monitoring platform, not a commercial product — flagged
# explicitly here, not just in the methodology doc, since any future
# commercial reuse of THESE TWO FUNCTIONS specifically would need a
# different source.
#
# CONFIRMED LIVE (§0.20): unlike the 20 existing hydrological_global WFS
# layers (which do NOT overlap Nullah Lai at all — see
# fetch_flood_extent_presence's own docstring), several real GFD events
# DO have actual MODIS-observed flooded pixels within the Nullah Lai
# bbox specifically — e.g. event 2641 (March 2005, "Heavy rain," listed
# countries Pakistan/Afghanistan): 70 flooded pixels within the bbox, ~59
# of them NOT also flagged as permanent water (jrc_perm_water), vectorizing
# into 31 real polygon clusters spread across the catchment (33.55-33.77°N),
# not one artifact cluster. This is the first real, geographically-
# overlapping ground truth found for this catchment all session.
GFD_GEE_COLLECTION = "GLOBAL_FLOOD_DB/MODIS_EVENTS/V1"
_GFD_NATIVE_SCALE_M = 250  # MODIS native resolution — never upsampled


def list_gfd_events(bbox, max_events=20):
    """Lists real Global Flood Database events whose footprint has ACTUAL
    flooded pixels within `bbox` — not just events whose broad continental
    footprint happens to overlap it (CONFIRMED LIVE: 34 events overlap the
    Nullah Lai bbox's footprint, but only a subset have any real flooded
    pixels there — filtering server-side in Earth Engine on
    flooded_pixel_count > 0, one round trip, not 34 sequential ones).
    Sorted by flooded_pixel_count descending, so callers/operators can see
    which event is the strongest local signal at a glance.

    Returns a list of dicts: {id, countries, dfo_main_cause, dfo_severity,
    dfo_dead, dfo_displaced, flooded_pixel_count, system_time_start_ms,
    system_time_end_ms} — empty on any GEE/network failure, matching this
    module's own established convention (never raises)."""
    from . import views  # noqa: F401 — import side effect: initializes Earth Engine
    import ee

    region = ee.Geometry.Rectangle(bbox)
    coll = ee.ImageCollection(GFD_GEE_COLLECTION).filterBounds(region)

    def _add_flooded_count(image):
        count = image.select("flooded").selfMask().reduceRegion(
            reducer=ee.Reducer.count(), geometry=region, scale=_GFD_NATIVE_SCALE_M,
            maxPixels=1e8, bestEffort=True,
        ).get("flooded")
        return image.set("flooded_pixel_count", count)

    coll = coll.map(_add_flooded_count).filter(ee.Filter.gt("flooded_pixel_count", 0))
    coll = coll.sort("flooded_pixel_count", False).limit(max_events)

    try:
        info = coll.getInfo()
    except Exception:
        logger.warning(
            "accuracy_assessment: GFD event listing failed for bbox %r (degraded — "
            "treated as empty)", bbox, exc_info=True,
        )
        return []

    events = []
    for feat in info.get("features", []) or []:
        p = feat.get("properties", {})
        events.append({
            "id": p.get("id"),
            "countries": p.get("countries"),
            "dfo_main_cause": p.get("dfo_main_cause"),
            "dfo_severity": p.get("dfo_severity"),
            "dfo_dead": p.get("dfo_dead"),
            "dfo_displaced": p.get("dfo_displaced"),
            "flooded_pixel_count": p.get("flooded_pixel_count"),
            "system_time_start_ms": p.get("system:time_start"),
            "system_time_end_ms": p.get("system:time_end"),
        })
    return events


_CHIRPS_GEE_COLLECTION = "UCSB-CHG/CHIRPS/DAILY"
_CHIRPS_NATIVE_SCALE_M = 5566  # ~0.05 degree native resolution

# How far BEFORE a GFD event's own catalogued start date to search for
# the causative storm — see fetch_peak_event_rainfall's own docstring:
# CONFIRMED LIVE (§0.21) that a real event's peak rainfall day can
# precede its MODIS-observed flood date by a few days (runoff/routing +
# antecedent-saturation lag, e.g. event 2641's own peak rain on
# 2005-03-17/18 vs. flood observed 2005-03-20 to 03-24) — searching only
# WITHIN the DFO-catalogued window would miss the actual causative storm
# for events like this one.
_EVENT_RAINFALL_LOOKBACK_DAYS = 5


def fetch_peak_event_rainfall(bbox, event_start_ms, event_end_ms,
                               lookback_days=_EVENT_RAINFALL_LOOKBACK_DAYS,
                               window_days_options=(1, 2, 3)):
    """Finds the peak short-duration rainfall accumulation within a real
    historical flood event's own date window — CHIRPS daily precipitation
    (GEE, ~5.5km resolution, 1981-present, confirmed live to cover every
    GFD event this catchment has). See methodology doc §0.21 for why this
    exists: a DFO/GFD event's own `system_time_start`/`system_time_end`
    span the ENTIRE flood PERIOD, which for a monsoon event can be
    MONTHS (confirmed live: event 3696 spans 111 days) — summing rainfall
    over that whole window and feeding it as a single-storm 'rainfall_mm'
    to flood_discharge.py's SCS-CN/SCS-UH chain (which assumes ONE storm
    with a duration in HOURS/a few DAYS, not a season) would badly
    misrepresent the actual causative event. This instead finds whichever
    short window (1-3 days, via `window_days_options`) within
    [event_start - lookback_days, event_end] had the HIGHEST accumulated
    rainfall — a defensible proxy for "the storm that actually caused
    this flood," not the whole season's total.

    Fetches the whole window's daily series via ONE Earth Engine round
    trip (`.map()` + `reduceRegion`, the same batched pattern
    list_gfd_events() already established — not N sequential calls), then
    does the rolling-window max search in plain Python (bounded: at most
    a few hundred days even for the longest real event found so far).

    Returns {"rainfall_mm", "duration_hr", "window_days", "peak_start_date"}
    for the best window found, or None if CHIRPS has no data for this
    window or the GEE call fails — matching this module's own established
    "degrade to nothing, never raise" convention for every ground-truth
    fetcher."""
    from . import views  # noqa: F401 — import side effect: initializes Earth Engine
    import datetime
    import ee

    start_dt = datetime.datetime.utcfromtimestamp(event_start_ms / 1000) - datetime.timedelta(days=lookback_days)
    end_dt = datetime.datetime.utcfromtimestamp(event_end_ms / 1000) + datetime.timedelta(days=1)

    region = ee.Geometry.Rectangle(bbox)
    coll = (
        ee.ImageCollection(_CHIRPS_GEE_COLLECTION)
        .filterDate(start_dt.strftime("%Y-%m-%d"), end_dt.strftime("%Y-%m-%d"))
        .filterBounds(region)
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
            "accuracy_assessment: CHIRPS rainfall fetch failed for window %s..%s "
            "(degraded — no event-matched rainfall available)",
            start_dt.date(), end_dt.date(), exc_info=True,
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
    series.sort(key=lambda t: t[0])

    if not series:
        logger.info(
            "accuracy_assessment: no CHIRPS data for window %s..%s — no event-matched "
            "rainfall available (a real, confirmed condition, not a bug)",
            start_dt.date(), end_dt.date(),
        )
        return None

    values = [v for _, v in series]
    best_total, best_window, best_start_ts = None, None, None
    for window in window_days_options:
        if window > len(values):
            continue
        for i in range(len(values) - window + 1):
            total = sum(values[i:i + window])
            if best_total is None or total > best_total:
                best_total, best_window, best_start_ts = total, window, series[i][0]

    if best_total is None:
        return None

    peak_start = datetime.datetime.utcfromtimestamp(best_start_ts / 1000).date().isoformat()
    return {
        "rainfall_mm": round(best_total, 1),
        "duration_hr": float(best_window * 24),
        "window_days": best_window,
        "peak_start_date": peak_start,
    }


def fetch_gfd_flood_extent(bbox, event_id=None):
    """Real, satellite-observed flood extent polygons from the Global
    Flood Database for one event overlapping `bbox` — a drop-in
    alternative presence_geoms source for assess_raster_auc() below, SAME
    shape fetch_flood_extent_presence() returns (a list of shapely
    (Multi)Polygons in WGS84), so callers don't need to special-case
    which source they used.

    `event_id`, if given, fetches that specific GFD event's flooded band
    (a DFO event id, e.g. from list_gfd_events()). If omitted, picks the
    event with the MOST flooded pixels within `bbox` automatically (via
    list_gfd_events(bbox, max_events=1)) — a reasonable default for "just
    give me the strongest available local signal," though a caller who
    wants a SPECIFIC historical event (e.g. to compare against a named
    flood) should pass event_id explicitly.

    Vectorized server-side via Image.reduceToVectors — the flooded band
    is already a clean binary mask, so this avoids a raster-export+GDAL-
    polygonize round trip entirely (CONFIRMED LIVE: 31 polygons back from
    one getInfo() call for the Nullah Lai bbox's own top event).

    Degrades to an empty list on any GEE/network failure, an unknown
    event_id, or no event having any real flooded pixels in bbox —
    matching this module's own established convention (never raises)."""
    from . import views  # noqa: F401
    import ee
    from shapely.geometry import shape as shapely_shape

    if event_id is None:
        top = list_gfd_events(bbox, max_events=1)
        if not top:
            logger.info(
                "accuracy_assessment: no GFD event has any flooded pixels within bbox "
                "%r — returning no ground truth (a real, confirmed condition, not a bug)",
                bbox,
            )
            return []
        event_id = top[0]["id"]

    region = ee.Geometry.Rectangle(bbox)
    image = ee.ImageCollection(GFD_GEE_COLLECTION).filter(ee.Filter.eq("id", event_id)).first()
    flooded = ee.Image(image).select("flooded").selfMask().clip(region)

    try:
        vectors = flooded.reduceToVectors(
            geometry=region, scale=_GFD_NATIVE_SCALE_M, geometryType="polygon",
            eightConnected=True, maxPixels=1e8, bestEffort=True,
        )
        info = vectors.getInfo()
    except Exception:
        logger.warning(
            "accuracy_assessment: GFD flood-extent fetch/vectorize failed for event %r, "
            "bbox %r (degraded — treated as empty)", event_id, bbox, exc_info=True,
        )
        return []

    geoms = []
    for feat in info.get("features", []) or []:
        geom = shapely_shape(feat["geometry"])
        if not geom.is_valid:
            geom = geom.buffer(0)
        if geom.is_empty:
            continue
        geoms.append(geom)
    return geoms


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


def youden_j_optimal_threshold(presence_vals, absence_vals, ascending=True):
    """Standard Youden's J statistic (J = sensitivity + specificity - 1,
    maximized over a threshold sweep) — the literature-standard, ROC-
    based optimal-cutoff method already named in this project's own
    original Phase 2.5.5 plan, built here for the first time.

    `presence_vals`/`absence_vals` are raw continuous score values at
    real, sampled ground-truth points (the exact same shape
    accuracy_assessment._sample_and_score already returns — reused
    directly, not a new sampling method). `ascending=True` (matching
    this project's AHP score convention: higher = more hazardous) means
    a candidate threshold T classifies "score >= T" as the positive
    (hazardous) prediction; pass False for the opposite convention (e.g.
    raw HAND, where LOWER is more hazardous).

    Every distinct value actually observed in the pooled sample is
    tried as a candidate threshold (not a fixed grid) — exact, not an
    approximation, and cheap here since ground-truth sample counts are
    small (hundreds, not millions).

    Returns {"threshold", "j", "sensitivity", "specificity",
    "n_presence", "n_absence"} — or None if either class has zero
    samples (matching compute_auc's own "undefined without both
    classes present" posture, never a crash)."""
    presence_vals = np.asarray(presence_vals, dtype=float)
    absence_vals = np.asarray(absence_vals, dtype=float)
    if presence_vals.size == 0 or absence_vals.size == 0:
        return None

    candidates = np.unique(np.concatenate([presence_vals, absence_vals]))
    best = None
    for t in candidates:
        if ascending:
            tp = np.sum(presence_vals >= t)
            fp = np.sum(absence_vals >= t)
        else:
            tp = np.sum(presence_vals <= t)
            fp = np.sum(absence_vals <= t)
        sensitivity = tp / presence_vals.size
        specificity = 1.0 - (fp / absence_vals.size)
        j = sensitivity + specificity - 1.0
        if best is None or j > best["j"]:
            best = {
                "threshold": float(t), "j": float(j),
                "sensitivity": float(sensitivity), "specificity": float(specificity),
            }
    best["n_presence"] = int(presence_vals.size)
    best["n_absence"] = int(absence_vals.size)
    return best


def calibrate_hierarchical_thresholds(presence_vals, absence_vals, ascending=True):
    """Two-stage Youden's J calibration for a 3-CLASS (Low/Medium/High)
    scheme from BINARY (presence/absence) ground truth — Youden's J
    itself only ever produces one optimal cutoff (it is fundamentally a
    binary-classification method), so a genuine 3-class calibration
    needs a second, honest step, not an invented shortcut:

    Stage 1 (T2, the Medium/High boundary): the single overall Youden's-
    J-optimal cutoff on the FULL pooled sample — the most defensible
    "is this genuinely elevated risk" separator ground truth can give.

    Stage 2 (T1, the Low/Medium boundary): Youden's J again, but
    restricted to the SUBSET of already-sampled points with score < T2
    — a real, standard hierarchical/recursive partitioning approach
    (the same idea decision trees use to split repeatedly), not a guess
    at a second cutoff. If fewer than 2 points of either class remain
    below T2 (a real possibility for a catchment whose ground truth is
    concentrated near the top of the score range), T1 falls back to
    the midpoint between the score minimum and T2 — a neutral, stated
    fallback, not a silent failure.

    Returns {"t1", "t2", "stage2_diagnostics", "stage1_diagnostics"} or
    None if stage 1 itself is undefined (no ground truth at all)."""
    stage1 = youden_j_optimal_threshold(presence_vals, absence_vals, ascending=ascending)
    if stage1 is None:
        return None
    t2 = stage1["threshold"]

    presence_vals = np.asarray(presence_vals, dtype=float)
    absence_vals = np.asarray(absence_vals, dtype=float)
    if ascending:
        sub_presence = presence_vals[presence_vals < t2]
        sub_absence = absence_vals[absence_vals < t2]
    else:
        sub_presence = presence_vals[presence_vals > t2]
        sub_absence = absence_vals[absence_vals > t2]

    stage2 = youden_j_optimal_threshold(sub_presence, sub_absence, ascending=ascending)
    if stage2 is not None and stage2["n_presence"] >= 2 and stage2["n_absence"] >= 2:
        t1 = stage2["threshold"]
    else:
        all_vals = np.concatenate([presence_vals, absence_vals])
        score_min = float(all_vals.min())
        t1 = (score_min + t2) / 2.0
        stage2 = {"fallback": True, "reason": "insufficient sub-threshold samples for a second Youden's J stage"}

    # T1/T2 must be strictly ordered — a degenerate stage-2 result
    # (e.g. sub-threshold ground truth is a single tied value) could in
    # principle produce t1 >= t2; guard against ever emitting an
    # inverted or degenerate 3-class scheme.
    if t1 >= t2:
        t1 = (t2 + (t2 - 1e-6)) / 2.0 if t2 > 1e-6 else t2 - 1e-6

    return {"t1": round(t1, 4), "t2": round(t2, 4), "stage1_diagnostics": stage1, "stage2_diagnostics": stage2}


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


def _sample_and_score(raster_path, presence_geoms, aoi_bbox, n_samples):
    """Shared core of assess_raster_auc() below and
    assess_pooled_multi_raster_auc() (§0.21) — samples presence/absence
    points against presence_geoms's union and scores them from
    raster_path, returning the RAW, un-inverted (presence_vals,
    absence_vals) lists so a multi-scenario caller can pool several
    DIFFERENT (raster, geoms) pairs into one combined AUC computation
    before inverting/labeling.

    PRESENCE points are rejection-sampled from presence_union's OWN
    bounding box (clamped to aoi_bbox), not the full aoi_bbox — a
    statistically NEUTRAL efficiency fix, not a semantic change: any
    point satisfying prepared_presence.intersects() must already lie
    within presence_union's own bounds, so tightening the CANDIDATE
    region can only change how fast valid points are found, never which
    points are valid or their distribution once accepted (still uniform
    within presence_union, still filtered by the exact same .intersects()
    test). This matters in practice — CONFIRMED LIVE (§0.21): several of
    Nullah Lai's own real GFD ground-truth polygons are a single ~250m
    MODIS pixel (~0.0625 km²) inside a bbox of ~444 km², where the OLD
    whole-bbox rejection sampling found ZERO presence points within its
    own bounded attempt budget for 3 of 10 real events — not because
    those events have no real signal, but because the sampler was
    wasting nearly all its attempts on points that could never land in
    such a small target. ABSENCE points still sample the full aoi_bbox
    (excluding presence) — unchanged, correctly so, since "not flooded"
    genuinely spans the whole AOI, not a small sub-region.

    Returns ([], []) immediately if presence_geoms is empty."""
    if not presence_geoms:
        return [], []

    from shapely.ops import unary_union
    from shapely.prepared import prep

    presence_union = unary_union(presence_geoms)
    prepared_presence = prep(presence_union)

    aoi_minx, aoi_miny, aoi_maxx, aoi_maxy = aoi_bbox
    pu_minx, pu_miny, pu_maxx, pu_maxy = presence_union.bounds
    presence_candidate_bbox = (
        max(pu_minx, aoi_minx), max(pu_miny, aoi_miny),
        min(pu_maxx, aoi_maxx), min(pu_maxy, aoi_maxy),
    )

    presence_points = _sample_points(n_samples, presence_candidate_bbox, prepared_presence.intersects)
    absence_points = _sample_points(
        n_samples, aoi_bbox, lambda pt: not prepared_presence.intersects(pt)
    )

    presence_vals, _ = _read_raster_values_at_points(raster_path, presence_points)
    absence_vals, _ = _read_raster_values_at_points(raster_path, absence_points)
    return presence_vals, absence_vals


# ---------------------------------------------------------------------------
# Binary-mask accuracy (§R4) — AUC (above) needs a CONTINUOUS score to
# rank; it does not naturally apply to an already-binary prediction (e.g.
# flood_connectivity.connected_flood_fill's own flooded/not-flooded mask,
# used by the riverine model after the original uniform-HAND-threshold
# approach was replaced). For a binary prediction, the standard metric
# family is a confusion-matrix (contingency-table) comparison — the SAME
# family this project's own literature review found used for "HAND vs
# FEMA hazard map" validation (hit rate / critical success index /
# proportion correct — 80.1%/76.3% reported there). Reuses
# _sample_and_score/_sample_points UNCHANGED — only the scoring at the end
# differs (a confusion-matrix tally instead of a rank-sum).
# ---------------------------------------------------------------------------

def assess_binary_mask_accuracy(mask_path, presence_geoms, aoi_bbox, n_samples=200, flood_value=1.0):
    """Samples presence/absence points (SAME method _sample_and_score
    already uses) and scores a BINARY mask raster (flood_value = the
    raster's own "flooded" pixel value, e.g. connected_flood_fill's own
    boolean mask written as 1.0/0.0) via a confusion matrix.

    Returns {"hit_rate", "csi", "f1", "proportion_correct", "n_presence",
    "n_absence", "tp", "fn", "fp", "tn", "interpretation"} — never raises
    for missing/insufficient ground truth (matches assess_raster_auc's own
    convention); "interpretation" reuses interpret_auc's own band labels
    applied to CSI (a reasonable, literature-consistent proxy — CSI and
    AUC are on a similar 0-1 "how much better than chance" scale, unlike
    hit_rate/proportion_correct which are not directly comparable to an
    AUC-style band without accounting for base rate)."""
    if not presence_geoms:
        return {
            "hit_rate": float("nan"), "csi": float("nan"), "f1": float("nan"),
            "proportion_correct": float("nan"), "n_presence": 0, "n_absence": 0,
            "tp": 0, "fn": 0, "fp": 0, "tn": 0, "interpretation": "no_ground_truth",
        }

    presence_vals, absence_vals = _sample_and_score(mask_path, presence_geoms, aoi_bbox, n_samples)
    if not presence_vals or not absence_vals:
        return {
            "hit_rate": float("nan"), "csi": float("nan"), "f1": float("nan"),
            "proportion_correct": float("nan"),
            "n_presence": len(presence_vals), "n_absence": len(absence_vals),
            "tp": 0, "fn": 0, "fp": 0, "tn": 0, "interpretation": "insufficient_samples",
        }

    tp = sum(1 for v in presence_vals if v == flood_value)
    fn = len(presence_vals) - tp
    fp = sum(1 for v in absence_vals if v == flood_value)
    tn = len(absence_vals) - fp

    hit_rate = tp / (tp + fn) if (tp + fn) > 0 else float("nan")
    csi = tp / (tp + fn + fp) if (tp + fn + fp) > 0 else float("nan")
    f1 = (2 * tp) / (2 * tp + fp + fn) if (2 * tp + fp + fn) > 0 else float("nan")
    proportion_correct = (tp + tn) / (tp + fn + fp + tn)

    return {
        "hit_rate": round(hit_rate, 4) if hit_rate == hit_rate else hit_rate,
        "csi": round(csi, 4) if csi == csi else csi,
        "f1": round(f1, 4) if f1 == f1 else f1,
        "proportion_correct": round(proportion_correct, 4),
        "n_presence": len(presence_vals), "n_absence": len(absence_vals),
        "tp": tp, "fn": fn, "fp": fp, "tn": tn,
        "interpretation": interpret_auc(csi),
    }


def assess_binary_mask_accuracy_stable(mask_path, presence_geoms, aoi_bbox, n_samples=200,
                                        flood_value=1.0, n_trials=5):
    """Multi-trial wrapper around assess_binary_mask_accuracy — same
    motivation as assess_raster_auc_stable's own docstring (§0.22): a
    single trial's sampled points are a noisy estimate for a small
    ground-truth set; repeating and reporting the mean (with observed
    min/max spread) is the reliable number, not any one draw.

    Returns {"csi_mean", "csi_min", "csi_max", "hit_rate_mean", "f1_mean",
    "n_trials", "n_trials_used", "interpretation" (based on csi_mean),
    "trials": [...]}."""
    trials = [
        assess_binary_mask_accuracy(mask_path, presence_geoms, aoi_bbox, n_samples, flood_value)
        for _ in range(n_trials)
    ]
    valid = [t for t in trials if t["csi"] == t["csi"]]
    if not valid:
        return {
            "csi_mean": float("nan"), "csi_min": float("nan"), "csi_max": float("nan"),
            "hit_rate_mean": float("nan"), "f1_mean": float("nan"),
            "n_trials": n_trials, "n_trials_used": 0,
            "interpretation": trials[0]["interpretation"] if trials else "no_ground_truth",
            "trials": trials,
        }
    csis = [t["csi"] for t in valid]
    return {
        "csi_mean": round(sum(csis) / len(csis), 4),
        "csi_min": round(min(csis), 4),
        "csi_max": round(max(csis), 4),
        "hit_rate_mean": round(sum(t["hit_rate"] for t in valid) / len(valid), 4),
        "f1_mean": round(sum(t["f1"] for t in valid) / len(valid), 4),
        "n_trials": n_trials, "n_trials_used": len(valid),
        "interpretation": interpret_auc(sum(csis) / len(csis)),
        "trials": trials,
    }


def assess_raster_vs_raster_agreement(mask_path, presence_geoms, aoi_bbox, flood_value=1.0):
    """`aoi_bbox` is accepted but not used internally — kept only for
    call-site symmetry with assess_raster_auc/assess_binary_mask_
    accuracy above (every caller in this ecosystem already has a
    (raster, presence_geoms, aoi_bbox) triple on hand; both rasters
    compared here already carry their own real geotransform, so no
    bbox is needed to rasterize or compare them).

    Phase 2.5.6's own genuinely different accuracy check: a real,
    full pixel-grid confusion matrix between an already-binary mask
    raster (e.g. flood_sar.build_sar_flood_extent's own Sentinel-1-
    derived extent) and a second ground-truth source given as real-
    world polygons (e.g. fetch_gfd_flood_extent's own vectorized GFD
    extent) — rasterized onto the FIRST raster's exact grid, then
    compared PIXEL FOR PIXEL. Every other accuracy function in this
    module (assess_raster_auc, assess_binary_mask_accuracy above) is
    raster-vs-POINT-SAMPLES (a few hundred rejection-sampled points,
    not the whole grid) — this is deliberately not that, built for
    comparing two independently-derived spatial EXTENTS against each
    other directly, with no sampling step at all.

    Returns {"agreement_rate", "iou", "kappa", "tp", "fp", "fn", "tn",
    "n_pixels", "interpretation"} — "interpretation" reuses interpret_
    auc's own band labels applied to IoU (the standard remote-sensing
    metric for comparing two flood extents), the same "0-1, chance-
    corrected-ish" reuse already established for CSI in assess_binary_
    mask_accuracy above. Returns {"error": ...} on any failure (no
    ground truth, unreadable raster, a rasterize/GDAL failure) — never
    raises, matching every other function in this module."""
    if not presence_geoms:
        return {"error": "no_ground_truth"}

    try:
        import struct
        from osgeo import gdal, ogr, osr

        ds = gdal.Open(mask_path)
        if ds is None:
            return {"error": f"could not open raster at {mask_path!r}"}
        band = ds.GetRasterBand(1)
        w, h = ds.RasterXSize, ds.RasterYSize
        gt = ds.GetGeoTransform()
        proj_wkt = ds.GetProjection()
        nodata = band.GetNoDataValue()

        # Read the mask the project's own established way — raw
        # ReadRaster/struct, never Band.ReadAsArray (see flood_model.py's
        # own GDAL/NumPy ABI-mismatch note; _read_raster_array's own
        # docstring explains this in full).
        mask_rows = []
        for row in range(h):
            raw = band.ReadRaster(0, row, w, 1, buf_type=gdal.GDT_Float32)
            mask_rows.append(struct.unpack(f"<{w}f", raw))
        mask_arr = np.array(mask_rows, dtype=np.float64)
        ds = None

        # Rasterize the ground-truth polygons onto the SAME grid.
        srs = osr.SpatialReference()
        srs.ImportFromWkt(proj_wkt)
        mem_vec_ds = ogr.GetDriverByName("Memory").CreateDataSource("")
        layer = mem_vec_ds.CreateLayer("gt", srs=srs, geom_type=ogr.wkbPolygon)
        for geom in presence_geoms:
            feat = ogr.Feature(layer.GetLayerDefn())
            feat.SetGeometry(ogr.CreateGeometryFromWkb(geom.wkb))
            layer.CreateFeature(feat)
            feat = None

        gt_ds = gdal.GetDriverByName("MEM").Create("", w, h, 1, gdal.GDT_Byte)
        gt_ds.SetGeoTransform(gt)
        gt_ds.SetProjection(proj_wkt)
        gdal.RasterizeLayer(gt_ds, [1], layer, burn_values=[1])
        gt_band = gt_ds.GetRasterBand(1)
        gt_rows = []
        for row in range(h):
            raw = gt_band.ReadRaster(0, row, w, 1, buf_type=gdal.GDT_Float32)
            gt_rows.append(struct.unpack(f"<{w}f", raw))
        gt_arr = np.array(gt_rows, dtype=np.float64)
        gt_ds = None

        valid = np.ones((h, w), dtype=bool)
        if nodata is not None:
            valid &= (mask_arr != nodata)

        pred_flood = valid & (mask_arr == flood_value)
        gt_flood = valid & (gt_arr >= 0.5)

        tp = int(np.sum(pred_flood & gt_flood))
        fp = int(np.sum(pred_flood & ~gt_flood))
        fn = int(np.sum(~pred_flood & gt_flood))
        tn = int(np.sum(~pred_flood & ~gt_flood & valid))
        n_pixels = tp + fp + fn + tn

        if n_pixels == 0:
            return {"error": "no_valid_pixels"}

        agreement_rate = (tp + tn) / n_pixels
        iou = tp / (tp + fp + fn) if (tp + fp + fn) > 0 else float("nan")

        # Cohen's kappa — accounts for chance agreement, the standard
        # measure for comparing two independent classifiers/rasters
        # (here: SAR-derived vs. GFD-derived, two independent sources).
        po = agreement_rate
        p_pred_flood = (tp + fp) / n_pixels
        p_gt_flood = (tp + fn) / n_pixels
        pe = p_pred_flood * p_gt_flood + (1 - p_pred_flood) * (1 - p_gt_flood)
        kappa = (po - pe) / (1 - pe) if (1 - pe) != 0 else float("nan")

        return {
            "agreement_rate": round(agreement_rate, 4),
            "iou": round(iou, 4) if iou == iou else iou,
            "kappa": round(kappa, 4) if kappa == kappa else kappa,
            "tp": tp, "fp": fp, "fn": fn, "tn": tn, "n_pixels": n_pixels,
            "interpretation": interpret_auc(iou) if iou == iou else "insufficient_data",
        }
    except Exception:
        logger.warning(
            "accuracy_assessment: raster-vs-raster agreement failed for %r (degraded)",
            mask_path, exc_info=True,
        )
        return {"error": "internal_failure"}


def assess_vector_overlap(geoms_a, geoms_b):
    """Phase 3's own shape-similarity check (FLASH_FLOOD_EARLY_WARNING_
    METHODOLOGY.md §0.35): a real, pure-vector overlap between two
    (Multi)Polygon geometry lists, e.g. our own riverine/AHP zone output
    vs. one severity band from fetch_flood_extent_presence's own 20
    existing hydrological_global flood-extent layers. Unlike assess_
    raster_vs_raster_agreement above, NEITHER side here needs
    rasterizing — both are already real vector polygons — so this is a
    direct shapely intersection/union area computation, simpler and
    more precise than routing through a raster grid for a purely
    geometric question.

    Reports THREE numbers, not just IoU, because IoU alone can't
    distinguish "these disagree" from "one is a strict subset of the
    other" — a real, useful distinction for a shape-similarity check:
      - "iou": intersection / union (the standard symmetric overlap measure)
      - "coverage_of_b": intersection / area(b) — how much of geoms_b
        (e.g. the existing flood-extent band) our own geoms_a covers
      - "coverage_of_a": intersection / area(a) — how much of geoms_a
        (our own zone) the existing band covers

    Returns {"iou", "coverage_of_a", "coverage_of_b", "area_a_km2",
    "area_b_km2", "intersection_km2"} or {"error": ...} if either input
    is empty — never raises, matching every sibling function's
    convention in this module."""
    if not geoms_a or not geoms_b:
        return {"error": "empty_input", "n_geoms_a": len(geoms_a or []), "n_geoms_b": len(geoms_b or [])}

    try:
        from shapely.ops import unary_union

        union_a = unary_union(geoms_a)
        union_b = unary_union(geoms_b)
        if not union_a.is_valid:
            union_a = union_a.buffer(0)
        if not union_b.is_valid:
            union_b = union_b.buffer(0)

        intersection = union_a.intersection(union_b)
        union_total = union_a.union(union_b)

        area_a = union_a.area
        area_b = union_b.area
        inter_area = intersection.area
        union_area = union_total.area

        if union_area == 0:
            return {"error": "degenerate_geometry"}

        # Areas are in decimal-degree^2 (WGS84) — converted to a rough
        # km^2 for a human-readable figure using this project's own
        # already-established deg->m approximation (matches flood_sar.py's
        # own deg_per_250m conversion, same latitude-independent order-of-
        # magnitude estimate, not survey-grade — fine for a sanity-check
        # headline number, not a billed area).
        deg2_to_km2 = (111.32) ** 2

        return {
            "iou": round(inter_area / union_area, 4),
            "coverage_of_a": round(inter_area / area_a, 4) if area_a > 0 else float("nan"),
            "coverage_of_b": round(inter_area / area_b, 4) if area_b > 0 else float("nan"),
            "area_a_km2": round(area_a * deg2_to_km2, 2),
            "area_b_km2": round(area_b * deg2_to_km2, 2),
            "intersection_km2": round(inter_area * deg2_to_km2, 2),
        }
    except Exception:
        logger.warning("accuracy_assessment: vector overlap check failed (degraded)", exc_info=True)
        return {"error": "internal_failure"}


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

    presence_vals, absence_vals = _sample_and_score(raster_path, presence_geoms, aoi_bbox, n_samples)

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


def assess_raster_auc_stable(raster_path, presence_geoms, aoi_bbox, n_samples=500,
                              invert_score=True, n_trials=5):
    """Multi-trial wrapper around assess_raster_auc() — see methodology
    doc §0.22 for why this exists: CONFIRMED LIVE that a SINGLE
    assess_raster_auc() call's AUC can vary meaningfully run-to-run for a
    small ground-truth sample (Nullah Lai's own real GFD ground truth is
    only a few hundred presence pixels total) — five single-trial runs
    against the exact same raster and ground truth ranged 0.605-0.661 in
    one real test, enough spread to flip the reported literature-
    interpretation band (§0.7) depending purely on which random draw
    happened to run. A single trial is NOT a reliable accuracy estimate
    for a ground-truth set this small; repeating and reporting the mean
    (with the observed min/max spread, not hidden) is.

    Calls assess_raster_auc() `n_trials` times with the SAME arguments
    (no forced seed — letting the ambient random state advance naturally
    between calls, so each trial draws genuinely different samples, not
    a repeat of the same one) and aggregates. assess_raster_auc() itself
    is completely UNCHANGED — this only calls it repeatedly and averages,
    the exact same "extract, don't rewrite" discipline already used for
    _sample_and_score's own extraction.

    Returns {"auc_mean", "auc_min", "auc_max", "n_trials", "interpretation"
    (based on auc_mean), "trials": [each trial's own full assess_raster_auc
    result]} — trials that come back NaN (no_ground_truth/
    insufficient_samples) are excluded from the mean/min/max but still
    listed in "trials", and "n_trials_used" reports how many actually
    contributed. Returns interpretation "no_ground_truth" with auc_mean
    NaN if EVERY trial failed (matches assess_raster_auc's own
    degradation, never raises)."""
    trials = [
        assess_raster_auc(raster_path, presence_geoms, aoi_bbox, n_samples, invert_score)
        for _ in range(n_trials)
    ]
    valid_aucs = [t["auc"] for t in trials if t["auc"] == t["auc"]]  # drop NaN trials
    if not valid_aucs:
        return {
            "auc_mean": float("nan"), "auc_min": float("nan"), "auc_max": float("nan"),
            "n_trials": n_trials, "n_trials_used": 0,
            "interpretation": trials[0]["interpretation"] if trials else "no_ground_truth",
            "trials": trials,
        }
    auc_mean = sum(valid_aucs) / len(valid_aucs)
    return {
        "auc_mean": round(auc_mean, 4),
        "auc_min": round(min(valid_aucs), 4),
        "auc_max": round(max(valid_aucs), 4),
        "n_trials": n_trials,
        "n_trials_used": len(valid_aucs),
        "interpretation": interpret_auc(auc_mean),
        "trials": trials,
    }


def assess_pooled_multi_raster_auc(scenarios, n_samples_per_scenario=200, min_presence_samples=1):
    """Pools MULTIPLE (raster_path, presence_geoms, aoi_bbox, invert_score)
    scenarios into ONE combined AUC — see methodology doc §0.21 for why
    this exists: assess_raster_auc() alone assumes ONE raster is the
    right comparison for ALL ground truth, which is correct for a STATIC
    raster (e.g. raw HAND) but wrong for a SCENARIO-DEPENDENT raster
    (e.g. flood_model's discharge-margin raster) being validated against
    MULTIPLE real historical events that each had their OWN actual
    rainfall — pooling against one arbitrary fixed scenario compares
    apples to oranges. This function scores each scenario against its
    OWN raster and OWN ground truth first (via the same _sample_and_score
    core assess_raster_auc uses — not a different sampling method), THEN
    combines every scenario's (scores, labels) into one array before
    computing AUC ONCE — a single, statistically pooled measure across
    however many event-matched scenarios were actually usable.

    `scenarios` is a list of dicts: {"raster_path", "presence_geoms",
    "aoi_bbox", "invert_score" (default True), "label" (optional, for
    the per_scenario breakdown only)}. A scenario with no presence_geoms
    or insufficient samples is skipped (not treated as a zero/failure)
    and reported in "skipped", so a caller can see exactly how many of
    the requested scenarios actually contributed.

    `min_presence_samples` (default 1 — i.e. off) is a RELIABILITY
    FLOOR, not a way to inflate the pooled number: a scenario whose own
    presence-point count is below this threshold is excluded from the
    POOL (moved to `reliability_skipped`, distinct from the ordinary
    `skipped` bucket) BEFORE the pooled AUC is computed. This exists
    because CONFIRMED LIVE (§0.21): a scenario with only 1-2 presence
    points can score a perfect or near-perfect individual AUC purely by
    chance (a single sampled point landing on one side of the raster's
    own value distribution proves nothing about real discriminative
    power) — raising `min_presence_samples` makes the pooled result MORE
    conservative by removing exactly this kind of fragile, easily-
    misleading contribution, never less so. The default of 1 preserves
    this function's own prior behavior exactly (every scenario with any
    real presence sample counts) for any existing caller that doesn't
    pass this argument.

    Returns {"auc", "n_presence", "n_absence", "interpretation",
    "n_scenarios_used", "n_scenarios_skipped", "n_scenarios_reliability_skipped",
    "per_scenario": [...]} — same never-raises posture as
    assess_raster_auc."""
    all_scores = []
    all_labels = []
    per_scenario = []
    n_skipped = 0
    n_reliability_skipped = 0

    for sc in scenarios:
        geoms = sc.get("presence_geoms")
        if not geoms:
            n_skipped += 1
            continue
        presence_vals, absence_vals = _sample_and_score(
            sc["raster_path"], geoms, sc["aoi_bbox"], n_samples_per_scenario,
        )
        if not presence_vals or not absence_vals:
            n_skipped += 1
            continue
        if len(presence_vals) < min_presence_samples:
            n_reliability_skipped += 1
            continue
        invert = sc.get("invert_score", True)
        scores = np.array(presence_vals + absence_vals, dtype=float)
        if invert:
            scores = -scores
        labels = np.array([1] * len(presence_vals) + [0] * len(absence_vals), dtype=float)

        # Per-scenario AUC recorded for transparency (so a caller can see
        # the spread across events, not just the pooled number) — same
        # "report the pooled result, not the best-looking individual one"
        # discipline §0.20 already established for the multi-event GFD test.
        scenario_auc = compute_auc(scores, labels)
        per_scenario.append({
            "label": sc.get("label"),
            "auc": round(scenario_auc, 4) if scenario_auc == scenario_auc else scenario_auc,
            "n_presence": len(presence_vals),
            "n_absence": len(absence_vals),
        })

        all_scores.append(scores)
        all_labels.append(labels)

    if not all_scores:
        return {
            "auc": float("nan"), "n_presence": 0, "n_absence": 0,
            "interpretation": "no_ground_truth", "n_scenarios_used": 0,
            "n_scenarios_skipped": n_skipped,
            "n_scenarios_reliability_skipped": n_reliability_skipped, "per_scenario": [],
        }

    pooled_scores = np.concatenate(all_scores)
    pooled_labels = np.concatenate(all_labels)
    auc = compute_auc(pooled_scores, pooled_labels)
    n_presence = int((pooled_labels == 1).sum())
    n_absence = int((pooled_labels == 0).sum())
    return {
        "auc": round(auc, 4) if auc == auc else auc,
        "n_presence": n_presence,
        "n_absence": n_absence,
        "interpretation": interpret_auc(auc),
        "n_scenarios_used": len(all_scores),
        "n_scenarios_skipped": n_skipped,
        "n_scenarios_reliability_skipped": n_reliability_skipped,
        "per_scenario": per_scenario,
    }


def assess_pooled_multi_raster_auc_stable(scenarios, n_samples_per_scenario=200,
                                           min_presence_samples=1, n_trials=5):
    """Multi-trial wrapper around assess_pooled_multi_raster_auc() — same
    motivation as assess_raster_auc_stable's own docstring (§0.22):
    CONFIRMED LIVE that a single pooled-AUC run's result can swing by a
    wide margin (0.75-0.86 observed across single trials for the SAME
    scenarios/ground truth in real testing) purely from which random
    points happened to be drawn — not a reliable basis for a reported
    accuracy figure on its own.

    Calls assess_pooled_multi_raster_auc() `n_trials` times with the SAME
    `scenarios` list (already-built raster paths + ground truth — the
    EXPENSIVE part, GEE queries and discharge-raster construction, is
    done ONCE by the caller before this function ever runs; only the
    random point sampling repeats, which is cheap) and aggregates.
    assess_pooled_multi_raster_auc() itself is completely UNCHANGED.

    Returns {"auc_mean", "auc_min", "auc_max", "n_trials", "n_trials_used",
    "interpretation" (based on auc_mean), "trials": [...]}, same shape
    convention as assess_raster_auc_stable."""
    trials = [
        assess_pooled_multi_raster_auc(scenarios, n_samples_per_scenario, min_presence_samples)
        for _ in range(n_trials)
    ]
    valid_aucs = [t["auc"] for t in trials if t["auc"] == t["auc"]]
    if not valid_aucs:
        return {
            "auc_mean": float("nan"), "auc_min": float("nan"), "auc_max": float("nan"),
            "n_trials": n_trials, "n_trials_used": 0,
            "interpretation": trials[0]["interpretation"] if trials else "no_ground_truth",
            "trials": trials,
        }
    auc_mean = sum(valid_aucs) / len(valid_aucs)
    return {
        "auc_mean": round(auc_mean, 4),
        "auc_min": round(min(valid_aucs), 4),
        "auc_max": round(max(valid_aucs), 4),
        "n_trials": n_trials,
        "n_trials_used": len(valid_aucs),
        "interpretation": interpret_auc(auc_mean),
        "trials": trials,
    }
