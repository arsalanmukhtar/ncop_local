# project/ncop_internal/flood_exposure.py
# ---------------------------------------------------------------------------
# Phase 1.5 of the lightweight flash-flood early-warning system (see
# FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md §7 "Phase 1.5" for the full
# design). Gives Phase 1's HAND hazard output (flood_model.py) real-world
# context: which district/tehsil, how many buildings, how many
# schools/settlements/airports sit inside the flood-prone zone.
#
# Deliberately does NOT include AUC cross-validation against the 20
# existing flood-extent layers — that's its own later phase per the
# user's explicit "go phase wise" instruction (see §0.7 of the
# methodology doc for the research already done on that).
#
# Crash-safety / production notes, all confirmed live during this phase's
# own build-and-test pass, not assumed:
#   - GDAL raster I/O stays raw ReadRaster/WriteRaster (the array module,
#     never Band.ReadAsArray/WriteArray) — same NumPy/GDAL ABI mismatch
#     this whole app already works around (see flood_model.py's own
#     docstring).
#   - Every GDAL touch-point (mask build, Polygonize) is serialized under
#     flood_model._gdal_lock() — the SAME lock views.py's PMD pipeline and
#     flood_model.py's own HAND pipeline already share.
#   - WFS calls (district/tehsil/airports/schools/settlements, all on the
#     existing GeoServer at 172.18.7.35:8080) degrade gracefully — a
#     timeout or malformed response logs a warning and returns an empty
#     list, never raises past this module, matching this codebase's
#     established broad-try/graceful-fallback convention for external
#     calls.
#   - Overture Maps buildings fetch is CONFIRMED LIVE to be slow: ~225s
#     for the Nullah Lai pilot bbox against the global buildings/building
#     theme, even with bbox row-group pruning applied (Overture's current
#     row-group granularity is coarser than a small pilot catchment, so
#     the S3-side filter still returns ~600k candidate rows before a
#     second, exact bbox pass narrows them down). This is why it is
#     disk-cached per catchment (like every other expensive step in
#     flood_model.py) and run through a bounded, dedicated
#     ThreadPoolExecutor + future.result(timeout=...) — the same
#     "external call must never hang the caller indefinitely" pattern
#     flood_model.py's own _run_wbt() already established for
#     WhiteboxTools. NEVER call the raw fetch function per-request; only
#     through fetch_overture_buildings_exposure()'s cache.
#   - OSM/Overpass is used for TWO different things, not one: (1) bridges
#     + hospitals, categories Overture's buildings-only integration never
#     covered at all, genuinely new; (2) a degraded FALLBACK for buildings
#     specifically if Overture's own fetch fails. It is deliberately NOT a
#     replacement for Overture's buildings coverage — confirmed live that
#     OSM has ~34x fewer buildings than Overture in the Nullah Lai pilot
#     (17,686 vs. 603,076), a known OSM gap in areas with heavy informal/
#     unmapped settlement. The public Overpass instance also rate-limits
#     under moderate load (a live 429 was hit during this module's own
#     research) and can 504 on a heavy per-element `tags` request against
#     a large result set — _overpass_query() retries with backoff across
#     two mirrors, and the buildings-fallback query deliberately omits
#     `tags` (confirmed live this alone fixes the 504, since buildings
#     don't need per-element tag data for a count-only exposure figure).
# ---------------------------------------------------------------------------

import array
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FutureTimeoutError

from django.conf import settings

logger = logging.getLogger(__name__)

_FLOOD_MEDIA_SUBDIR = "flood_model"  # same media subdir flood_model.py already uses

# Same GeoServer host/workspace frontend/src/modules/map-layers.js already
# uses for national/provincial/district/tehsil boundaries and the
# airports/schools/settlements Infrastructure category (confirmed by
# direct read of that file, not assumed).
_GCOP_WFS_HOST = "172.18.7.35:8080"
_GCOP_WFS_WORKSPACE = "gcop"
_WFS_TIMEOUT_SECONDS = 30  # matches this app's other bounded-external-call convention

_OVERTURE_S3_BUCKET = "overturemaps-us-west-2"
_OVERTURE_REGION = "us-west-2"
# Generous, but bounded — NOT a per-request budget, a one-time-per-
# catchment background cost (see module docstring). Raised from an
# original 300s to 420s (§0.23): CONFIRMED LIVE this fetch already ran
# 225-270s for Nullah Lai and a directly-measured 227.5s for a second
# real catchment (Peshawar, comparable bbox size) — both well within the
# historical range, but a single real production request for Peshawar
# hit the ORIGINAL 300s limit anyway (a timing outlier on this same,
# already-known-slow S3/Parquet scan, not a bug in this fetch or a
# Peshawar-specific regression — re-measured directly afterward and got
# 227.5s, squarely in range). The original 300s cap left too little
# headroom against its own documented ~225-270s typical range for a
# network-dependent external call; 420s gives real margin (>50% above
# the worst directly-observed run) without meaningfully changing the
# worst-case wait for a genuine hang, since this is still bounded, not
# unbounded.
_OVERTURE_FETCH_TIMEOUT_SECONDS = 420
_OVERTURE_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="overture-fetch")
_overture_release_cache = None

# §0.37 — a generic, reusable in-flight-work coalescing registry. Real,
# confirmed fix for a real race: a "prewarm as soon as the user finishes
# drawing" optimization (added below, for the Overture fetch specifically)
# would otherwise submit a SECOND future for the same catchment_key once
# the real "Run" job makes its own later call to the SAME fetch function —
# and because _OVERTURE_EXECUTOR has max_workers=1, that second future
# queues strictly BEHIND the first and then re-runs the ENTIRE slow S3
# scan a second time once the first finishes, roughly DOUBLING the real
# wait instead of saving anything. Traced through fetch_overture_
# buildings_exposure's own cache-check logic live this session — a real
# bug, not a hypothetical. A second caller for the same key now JOINS the
# first's already-running future instead of resubmitting duplicate work.
_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT_FUTURES = {}  # {key: Future}


def _submit_coalesced(executor, key, fn, *args, **kwargs):
    """Submits fn(*args, **kwargs) to `executor` under `key` — or, if a
    call for the SAME key is already in flight, returns that SAME
    Future instead of submitting duplicate work. The registry entry is
    removed once the future completes (success OR failure), so a later,
    genuinely new call for the same key starts fresh rather than being
    stuck joining a stale/finished entry.

    NOTE: this is a currently a targeted fix for fetch_overture_
    buildings_exposure specifically (the dominant real cost, confirmed
    live this session) — build_hand_pipeline's WhiteboxTools calls and
    _get_cached_buildings_index have the SAME class of race (confirmed
    during this same investigation) but are NOT yet wired through this
    primitive — a real, known, deliberately out-of-scope gap for this
    pass, not an oversight."""
    with _INFLIGHT_LOCK:
        existing = _INFLIGHT_FUTURES.get(key)
        if existing is not None and not existing.done():
            return existing
        future = executor.submit(fn, *args, **kwargs)
        _INFLIGHT_FUTURES[key] = future

    def _cleanup(_f):
        with _INFLIGHT_LOCK:
            if _INFLIGHT_FUTURES.get(key) is future:
                del _INFLIGHT_FUTURES[key]
    future.add_done_callback(_cleanup)
    return future

# OSM/Overpass — NOT a replacement for Overture (confirmed live: Overture
# has ~34x more buildings than OSM in the Nullah Lai pilot, a known OSM
# gap in areas with heavy informal/unmapped settlement — Overture stays
# the primary buildings source). Used for two things Overture's own
# buildings-only integration never covered: bridges + hospitals (the
# transportation/amenity themes were always out of scope — see the
# methodology doc's "deferred" note), and as a degraded-but-available
# fallback for buildings specifically if the Overture fetch ever fails.
_OVERPASS_ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
_OVERPASS_TIMEOUT_SECONDS = 60
_OVERPASS_USER_AGENT = "NCOP-FloodExposure/1.0 (+internal use, flood_exposure.py)"
_OVERPASS_MAX_RETRIES = 3

# WorldPop population/vulnerable-population exposure (§0.9 of the
# methodology doc) — via Earth Engine, already an initialized dependency
# in this app (views.initialize_earth_engine()), no new package. Country
# hardcoded to Pakistan, matching this whole project's scope; year fixed
# to 2020, the only year Earth Engine's age/sex-structure collection
# reaches for Pakistan (confirmed live during §0.9's research — see that
# section for the "still the field's current standard baseline, not a
# staleness compromise unique to this project" reasoning).
_WORLDPOP_COUNTRY = "PAK"
_WORLDPOP_YEAR = 2020
# WorldPop's own 5-year age bins (0 and 1-4 kept separate, then every 5
# years to 80+) — confirmed live via the actual band names on the real
# Earth Engine asset, not assumed.
_WORLDPOP_AGE_BINS = [0, 1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]
# Bounded like every other external call in this module (WFS/Overpass/
# Overture) — §0.9's original research measured 1.6-7.4s for Nullah
# Lai's own flood-zone geometry, making 30s look generous. §0.23 found
# that headroom was catchment-geometry-dependent, not a fixed constant:
# Peshawar's own flood-zone polygon (a much FLATTER basin — mean HAND
# 3.3m vs. Nullah Lai's 31m) is far more fragmented at the same 3.0m
# threshold (many small disconnected regions, since a shallow terrain
# gradient makes the threshold contour wander unpredictably across a
# much larger area) — CONFIRMED LIVE: a 2.36-million-character WKT vs.
# Nullah Lai's own compact shape, and the actual reduceRegion call took
# 32.5s, already past the original 30s cap. Raised to 90s — real
# headroom (>2.7x the observed 32.5s) rather than a value chosen to
# just barely clear one measurement, since a THIRD catchment's own
# geometry complexity is unknown and this cost scales with terrain
# flatness, not catchment count.
_POPULATION_TIMEOUT_SECONDS = 90
_POPULATION_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="worldpop-fetch")


# ---------------------------------------------------------------------------
# Flood-zone vectorization (raster -> polygon), built on flood_model's own
# cached HAND raster.
# ---------------------------------------------------------------------------

def _binary_flood_mask(hand_path, threshold_m, out_path):
    """Reads the continuous HAND raster in one bulk ReadRaster call (never
    Band.ReadAsArray — see module docstring), thresholds it in pure Python,
    writes a Byte mask: 1 = flood-prone (HAND <= threshold_m), 0 = not,
    NoData = cells HAND's own pipeline couldn't resolve (confirmed live:
    sentinel -32768.0) — kept genuinely excluded rather than folded into
    "0 = safe", since an unresolved cell is not a verified-safe one."""
    from osgeo import gdal

    src_ds = gdal.Open(hand_path)
    if src_ds is None:
        raise RuntimeError(f"gdal.Open could not read HAND raster at {hand_path}")
    src_band = src_ds.GetRasterBand(1)
    w, h = src_ds.RasterXSize, src_ds.RasterYSize
    nodata = src_band.GetNoDataValue()
    if nodata is None:
        nodata = -32768.0

    raw = src_band.ReadRaster(0, 0, w, h, buf_type=gdal.GDT_Float32)
    values = array.array("f")
    values.frombytes(raw)

    NODATA_MASK_VAL = 2
    mask_vals = array.array(
        "B",
        (
            NODATA_MASK_VAL if v == nodata else (1 if v <= threshold_m else 0)
            for v in values
        ),
    )

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    driver = gdal.GetDriverByName("GTiff")
    dst_ds = driver.Create(tmp_path, w, h, 1, gdal.GDT_Byte)
    dst_ds.SetGeoTransform(src_ds.GetGeoTransform())
    dst_ds.SetProjection(src_ds.GetProjection())
    dst_band = dst_ds.GetRasterBand(1)
    dst_band.SetNoDataValue(NODATA_MASK_VAL)
    dst_band.WriteRaster(0, 0, w, h, mask_vals.tobytes(), buf_type=gdal.GDT_Byte)
    dst_band.FlushCache()
    dst_ds = None
    src_ds = None  # release handle before caller's cleanup, same Windows-handle gotcha
    os.replace(tmp_path, out_path)
    return out_path


_VECTORIZE_MAX_DISCARDED_AREA_FRACTION = 0.10

# §0.25 — standing regression tolerance for build_discharge_exposure_report's
# own raster-vs-vector area cross-check. Confirmed live: a correctly-
# behaving vectorization stays within ~2.6-3.2% of the independently-
# computed raster-based area across both real catchments and three
# scenario scales tested; 15% gives real margin above that observed
# noise floor (polygon dissolve/simplify tolerance) while still catching
# anything resembling §0.24's own bug (a 5x/400%+ discrepancy).
_AREA_CONSISTENCY_TOLERANCE = 0.15


def _vectorize_flood_zone(mask_path, min_mapping_unit_px=9,
                           max_discarded_area_fraction=_VECTORIZE_MAX_DISCARDED_AREA_FRACTION):
    """gdal.Polygonize the binary mask (never touches gdal_array) into an
    in-memory OGR layer, keeps only the flood-prone (val=1) polygons, and
    dissolves them into a single shapely (Multi)Polygon via unary_union.
    Returns None if the catchment has no flood-prone cells at all (a
    legitimate, if unlikely, outcome — not an error).

    Two simplification passes, both confirmed necessary live (not
    speculative): raw Polygonize output for the Nullah Lai pilot's
    fixed-threshold mask produced 2,720 disconnected single/few-pixel
    sliver polygons (72,522 total vertices) — a noisy HAND threshold
    boundary genuinely does look like that, it is not a bug. Intersecting
    a geometry that fragmented against a real district polygon
    (Rawalpindi's WFS boundary alone carries 53,250 vertices) made a
    single shapely .intersection() call hang for minutes in this phase's
    own testing. Fixed by (1) dropping slivers below a minimum-mapping-
    unit of `min_mapping_unit_px` pixels (default 9, a standard remote-
    sensing speckle-filter convention) BEFORE the dissolve, and (2)
    simplifying the dissolved result to ~1 pixel of tolerance — both
    cheap relative to the raster's own 30m resolution.

    **`min_mapping_unit_px` is a REQUEST, not a blind instruction — §0.25
    made this self-adaptive** after §0.24 found live that this same
    9-pixel default, appropriate for the fixed-threshold mask's broad-
    blob shape, was actively WRONG for the discharge-driven mode's own
    mask (which hugs narrow stream channels, producing thousands of
    small, genuinely-real — not noise — disconnected clusters):
    confirmed live, 5,103 total polygons for one real scenario, only 90
    survive a 9-pixel filter, DISCARDING 79.3% of the true flood-prone
    area. §0.24's own fix was to have the DISCHARGE caller explicitly
    pass `min_mapping_unit_px=0` — correct, but it baked a per-mode
    assumption into the CALLER rather than letting this function notice
    the mismatch itself, which would break again for some future
    catchment/mode whose mask shape doesn't cleanly fit either "0" or "9".

    Now: the requested `min_mapping_unit_px` is measured against THIS
    mask's own real geometry before being trusted. If applying it would
    discard more than `max_discarded_area_fraction` (default 10%) of the
    raw Polygonize output's own total area, that is treated as proof the
    filter doesn't fit this mask's shape, and it is silently backed off
    to 0 (no filtering) instead of applied blindly — logged so this is
    visible, not silent. A caller no longer needs to know in advance
    whether its own mask is "blob-like" or "thread-like"; every caller
    (fixed-threshold included) can pass the same default 9 and get the
    filter only where it's actually safe to apply. Confirmed live this
    does NOT change the fixed-threshold mask's own output (its own
    discarded fraction at 9px is well under 10% — the filter still
    applies exactly as before for that mask) while automatically
    protecting a discharge-driven mask (whose 79.3%-discarded fraction
    trips the cap) without the caller having to say so."""
    from osgeo import gdal, ogr, osr
    import shapely.wkb as shapely_wkb
    from shapely.ops import unary_union

    ds = gdal.Open(mask_path)
    if ds is None:
        raise RuntimeError(f"gdal.Open could not read flood mask at {mask_path}")
    band = ds.GetRasterBand(1)
    gt = ds.GetGeoTransform()
    pixel_size_deg = abs(gt[1])

    srs = osr.SpatialReference()
    srs.ImportFromWkt(ds.GetProjection())

    mem_ds = ogr.GetDriverByName("Memory").CreateDataSource("")
    layer = mem_ds.CreateLayer("flood_zone", srs=srs, geom_type=ogr.wkbPolygon)
    layer.CreateField(ogr.FieldDefn("val", ogr.OFTInteger))

    gdal.Polygonize(band, band.GetMaskBand(), layer, 0, [], callback=None)

    min_area_deg2 = min_mapping_unit_px * (pixel_size_deg ** 2)
    all_polys = []
    layer.ResetReading()
    for feat in layer:
        if feat.GetField("val") == 1:
            geom = feat.GetGeometryRef()
            if geom is not None:
                shp = shapely_wkb.loads(bytes(geom.ExportToWkb()))
                all_polys.append(shp)

    ds = None
    mem_ds = None

    if not all_polys:
        return None

    total_area = sum(p.area for p in all_polys)
    kept_polys = [p for p in all_polys if p.area >= min_area_deg2]
    kept_area = sum(p.area for p in kept_polys)
    discarded_fraction = 1.0 - (kept_area / total_area) if total_area > 0 else 0.0

    if min_mapping_unit_px > 0 and discarded_fraction > max_discarded_area_fraction:
        logger.warning(
            "flood_exposure: %d-pixel minimum-mapping-unit would discard %.1f%% of "
            "this mask's own real flood-prone area (%s) — over the %.0f%% cap, so this "
            "mask's shape doesn't fit that filter (likely many small genuinely-real "
            "clusters, not noise); using every polygon unfiltered instead",
            min_mapping_unit_px, discarded_fraction * 100, mask_path,
            max_discarded_area_fraction * 100,
        )
        polys = all_polys
    else:
        polys = kept_polys

    dissolved = unary_union(polys)
    # Polygonize can produce slivers with self-touching rings on a noisy
    # threshold boundary — buffer(0) is the standard shapely idiom to
    # repair that without changing the geometry's actual extent.
    if not dissolved.is_valid:
        dissolved = dissolved.buffer(0)
    dissolved = dissolved.simplify(pixel_size_deg, preserve_topology=True)
    return dissolved


def _vectorize_multiclass_raster(raster_path, class_labels, min_mapping_unit_px=9,
                                  max_discarded_area_fraction=_VECTORIZE_MAX_DISCARDED_AREA_FRACTION,
                                  sieve_threshold_px=0, simplify_tolerance_px=1.0):
    """Multi-class sibling of _vectorize_flood_zone (AHP zonation, see
    flood_model.build_ahp_zone_geometries) — same gdal.Polygonize/
    self-adaptive-MMU/dissolve/simplify technique, generalized from
    "keep only val==1" to "group by whatever integer class value each
    polygon actually carries," since gdal.Polygonize already tags every
    output polygon with its own source pixel value in one pass (no need
    to Polygonize once per class).

    `class_labels` is {int_value: label_string} (e.g. {1: "low", 2:
    "medium", 3: "high"}) — only these values are kept; any other value
    in the raster (there shouldn't be one, but a real nodata-handling
    slip elsewhere should not silently produce a spurious extra zone) is
    dropped with a loud warning, not silently included.

    `sieve_threshold_px` (default 0 = off) — runs gdal.SieveFilter on the
    source band BEFORE Polygonize, merging any contiguous patch smaller
    than this many pixels into its largest neighboring patch. CONFIRMED
    LIVE this is a real, necessary fix, not a speculative one: a
    per-pixel 3-class reclassification of an AHP score (itself a smooth
    weighted combination of several already-noisy per-catchment factors)
    produces a boundary that is jagged at PIXEL granularity, unlike a
    physically-coherent binary flood/no-flood mask — vectorizing that
    directly (as _vectorize_flood_zone does for a genuinely smoother
    mask) produced up to ~10MB of GeoJSON for a single zone on a real
    test run (guddu_indus), an unshippable payload. SieveFilter is the
    standard, purpose-built GDAL tool for exactly this "too many tiny
    noise polygons" problem — not a novel technique.

    `simplify_tolerance_px` (default 1.0, matching _vectorize_flood_zone's
    own 1-pixel tolerance) — multiplies pixel_size_deg for the final
    simplify() pass; a caller vectorizing a decorative/informational
    display layer (not a precision flood-extent boundary) can pass a
    larger multiple to further cut vertex count, on top of sieving.

    The self-adaptive MMU backoff (see _vectorize_flood_zone's own
    docstring for the full "why" — a filter that would discard too much
    real area for THIS mask's shape backs off to unfiltered automatically
    rather than requiring the caller to already know its own mask's
    shape) is applied PER CLASS independently, not globally — a mask
    where the "high" zone is a few large blobs but the "low" zone is
    scattered into many small disconnected fragments (a real, plausible
    AHP zonation shape, not hypothetical) needs each class judged on its
    own geometry, not a single global average that would mask one
    class's real problem behind another's healthy one.

    Returns {int_value: shapely (Multi)Polygon}, only for classes that
    actually had at least one surviving polygon — a class absent from
    this catchment's own zonation (e.g. no "high" zone at all) is simply
    not a key, not an error."""
    from osgeo import gdal, ogr, osr
    import shapely.wkb as shapely_wkb
    from shapely.ops import unary_union

    ds = gdal.Open(raster_path)
    if ds is None:
        raise RuntimeError(f"gdal.Open could not read raster at {raster_path}")
    band = ds.GetRasterBand(1)
    gt = ds.GetGeoTransform()
    pixel_size_deg = abs(gt[1])

    srs = osr.SpatialReference()
    srs.ImportFromWkt(ds.GetProjection())

    if sieve_threshold_px > 0:
        # Sieve into a same-shape in-memory band — gdal.SieveFilter needs
        # a real destination band, it does not filter in place. Same
        # nodata/mask as the source so already-invalid cells stay excluded.
        mem_raster_ds = gdal.GetDriverByName("MEM").Create(
            "", ds.RasterXSize, ds.RasterYSize, 1, band.DataType,
        )
        mem_raster_ds.SetGeoTransform(gt)
        mem_raster_ds.SetProjection(ds.GetProjection())
        sieved_band = mem_raster_ds.GetRasterBand(1)
        src_nodata = band.GetNoDataValue()
        if src_nodata is not None:
            sieved_band.SetNoDataValue(src_nodata)
        gdal.SieveFilter(band, band.GetMaskBand(), sieved_band, sieve_threshold_px, connectedness=8)
        polygonize_band = sieved_band
        polygonize_mask = sieved_band.GetMaskBand()
    else:
        mem_raster_ds = None
        polygonize_band = band
        polygonize_mask = band.GetMaskBand()

    mem_ds = ogr.GetDriverByName("Memory").CreateDataSource("")
    layer = mem_ds.CreateLayer("zones", srs=srs, geom_type=ogr.wkbPolygon)
    layer.CreateField(ogr.FieldDefn("val", ogr.OFTInteger))

    gdal.Polygonize(polygonize_band, polygonize_mask, layer, 0, [], callback=None)
    mem_raster_ds = None  # release the sieved in-memory raster, Polygonize is done with it

    polys_by_class = {}
    layer.ResetReading()
    for feat in layer:
        val = feat.GetField("val")
        if val not in class_labels:
            continue
        geom = feat.GetGeometryRef()
        if geom is not None:
            shp = shapely_wkb.loads(bytes(geom.ExportToWkb()))
            polys_by_class.setdefault(val, []).append(shp)

    ds = None
    mem_ds = None

    min_area_deg2 = min_mapping_unit_px * (pixel_size_deg ** 2)
    result = {}
    for val, all_polys in polys_by_class.items():
        total_area = sum(p.area for p in all_polys)
        kept_polys = [p for p in all_polys if p.area >= min_area_deg2]
        kept_area = sum(p.area for p in kept_polys)
        discarded_fraction = 1.0 - (kept_area / total_area) if total_area > 0 else 0.0

        if min_mapping_unit_px > 0 and discarded_fraction > max_discarded_area_fraction:
            logger.warning(
                "flood_exposure: %d-pixel minimum-mapping-unit would discard %.1f%% of "
                "class %r's own real area (%s) — over the %.0f%% cap, backing off to "
                "unfiltered for THIS class only, other classes unaffected",
                min_mapping_unit_px, discarded_fraction * 100, class_labels.get(val, val),
                raster_path, max_discarded_area_fraction * 100,
            )
            polys = all_polys
        else:
            polys = kept_polys

        if not polys:
            continue

        dissolved = unary_union(polys)
        if not dissolved.is_valid:
            dissolved = dissolved.buffer(0)
        dissolved = dissolved.simplify(pixel_size_deg * simplify_tolerance_px, preserve_topology=True)
        result[val] = dissolved

    return result


def _geom_area_km2(geom):
    """Area in km^2 via a local azimuthal-equidistant reprojection centred
    on the geometry — shapely/pyproj geometries stay in EPSG:4326
    (degrees) everywhere else in this module, so .area on them directly
    would be meaningless; this is the standard, dependency-free (pyproj
    and shapely are both already pinned) way to get a physically real
    area for an AOI-sized geometry without a global-projection distortion
    concern."""
    from pyproj import Transformer
    from shapely.ops import transform as shapely_transform

    centroid = geom.centroid
    proj_str = (
        f"+proj=aeqd +lat_0={centroid.y} +lon_0={centroid.x} "
        f"+x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs"
    )
    transformer = Transformer.from_crs("EPSG:4326", proj_str, always_xy=True)
    projected = shapely_transform(transformer.transform, geom)
    return projected.area / 1e6


def _local_utm_transformer(bbox):
    """Picks the correct northern-hemisphere UTM zone for a Pakistan bbox
    (Pakistan sits entirely in UTM zones 41N-43N) and returns a single
    WGS84->UTM pyproj Transformer, built ONCE per call. Deliberately NOT
    a fresh local azimuthal-equidistant projection per feature the way
    _geom_area_km2 does — that's fine for a handful of admin-boundary
    intersections, but road/drainage-network exposure needs to reproject
    tens of thousands of line features, and constructing a new Transformer
    per feature at that scale is real, avoidable overhead. A single UTM
    zone is accurate enough across one pilot-catchment-sized AOI (a few
    tens of km wide, nowhere near a zone boundary in practice for the
    catchments this project uses)."""
    from pyproj import Transformer

    minx, _, maxx, _ = bbox
    center_lon = (minx + maxx) / 2
    zone = int((center_lon + 180) // 6) + 1
    epsg = 32600 + zone  # WGS84 / UTM zone N, northern hemisphere
    return Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)


def _line_network_length_exposure(elements, flood_zone_geom, bbox):
    """Shared by road- and drainage-network exposure: total network length
    (km) in the AOI vs. inside the flood zone, via ONE shared UTM
    reprojection for every feature (see _local_utm_transformer). Uses
    actual line geometry and length-of-intersection, NOT a per-feature
    point/centroid test — a road or stream is often much longer than the
    flood zone is wide, so "is the centroid inside the zone" would
    misrepresent partial overlaps in both directions; km-of-network-
    inundated is also the metric the flood-exposure literature itself
    reports (§0.9's research), not a count of features."""
    from shapely.geometry import LineString
    from shapely.ops import transform as shapely_transform

    if not elements:
        return {"total_length_km": 0.0, "length_in_flood_zone_km": 0.0}

    transformer = _local_utm_transformer(bbox)
    zone_utm = shapely_transform(transformer.transform, flood_zone_geom)
    zminx, zminy, zmaxx, zmaxy = flood_zone_geom.bounds

    total_km = 0.0
    in_zone_km = 0.0
    for el in elements:
        pts = el.get("geometry")
        if not pts or len(pts) < 2:
            continue
        line = LineString((p["lon"], p["lat"]) for p in pts)
        lx0, ly0, lx1, ly1 = line.bounds
        line_utm = shapely_transform(transformer.transform, line)
        total_km += line_utm.length / 1000.0
        # cheap bbox fast-reject in WGS84 degrees before the (already-done,
        # can't avoid it for total_km) intersection call specifically
        if not (lx1 < zminx or lx0 > zmaxx or ly1 < zminy or ly0 > zmaxy):
            clipped = line_utm.intersection(zone_utm)
            if not clipped.is_empty:
                in_zone_km += clipped.length / 1000.0

    return {"total_length_km": round(total_km, 2), "length_in_flood_zone_km": round(in_zone_km, 2)}


def _line_network_length_exposure_multizone(elements, zone_geoms, bbox):
    """Multi-zone sibling of _line_network_length_exposure, built after a
    real, confirmed-live performance problem: flood_exposure.
    build_ahp_zone_exposure_report's first version called
    _build_exposure_from_geom (and therefore this function, via
    fetch_road_network_exposure/fetch_drainage_network_exposure) once
    PER ZONE — reprojecting the ENTIRE road/drainage network to UTM
    THREE TIMES over. For a narrow flood-extent geometry (every other
    mode's own use of this function) that 3x cost was never actually
    exercised — AHP's 3 zones collectively cover close to the WHOLE
    catchment, not a narrow extent, so "warm cache, cheap reclassify"
    did NOT hold the way it does for buildings/points. Confirmed live:
    chashma_indus's own AHP zone exposure report took 1082s (18 minutes)
    end-to-end, with the road/drainage reprojection (repeated 3x) as the
    dominant cost alongside real Overpass read-timeouts compounding it.

    Fix: reproject each line EXACTLY ONCE regardless of how many zones
    it's tested against, then intersect against each zone's own (also
    reprojected once) geometry — the same total UTM-transform work as a
    SINGLE-zone call, not N times it. Returns {"total_length_km": ...,
    "by_zone": {zone_label: length_in_that_zone_km}}."""
    from shapely.geometry import LineString
    from shapely.ops import transform as shapely_transform

    if not elements:
        return {"total_length_km": 0.0, "by_zone": {label: 0.0 for label in zone_geoms}}

    transformer = _local_utm_transformer(bbox)
    zones_utm = {label: shapely_transform(transformer.transform, geom) for label, geom in zone_geoms.items()}
    zones_bounds = {label: geom.bounds for label, geom in zone_geoms.items()}

    total_km = 0.0
    by_zone_km = {label: 0.0 for label in zone_geoms}
    for el in elements:
        pts = el.get("geometry")
        if not pts or len(pts) < 2:
            continue
        line = LineString((p["lon"], p["lat"]) for p in pts)
        lx0, ly0, lx1, ly1 = line.bounds
        line_utm = shapely_transform(transformer.transform, line)  # reprojected ONCE
        total_km += line_utm.length / 1000.0
        for label, zone_utm in zones_utm.items():
            zminx, zminy, zmaxx, zmaxy = zones_bounds[label]
            if lx1 < zminx or lx0 > zmaxx or ly1 < zminy or ly0 > zmaxy:
                continue  # cheap bbox fast-reject before the intersection call
            clipped = line_utm.intersection(zone_utm)
            if not clipped.is_empty:
                by_zone_km[label] += clipped.length / 1000.0

    return {
        "total_length_km": round(total_km, 2),
        "by_zone": {label: round(km, 2) for label, km in by_zone_km.items()},
    }


# ---------------------------------------------------------------------------
# Administrative tagging + existing NCOP infrastructure exposure — both via
# the existing GeoServer WFS, both degrade to an empty result rather than
# raising past this module on any network/parsing failure.
# ---------------------------------------------------------------------------

def _wfs_get_geojson(layer, bbox):
    import requests

    minx, miny, maxx, maxy = bbox
    url = (
        f"http://{_GCOP_WFS_HOST}/geoserver/{_GCOP_WFS_WORKSPACE}/ows"
        f"?service=WFS&version=2.0.0&request=GetFeature"
        f"&typeNames={_GCOP_WFS_WORKSPACE}:{layer}&outputFormat=application/json"
        f"&bbox={minx},{miny},{maxx},{maxy},EPSG:4326"
    )
    try:
        resp = requests.get(url, timeout=_WFS_TIMEOUT_SECONDS)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        logger.warning(
            "flood_exposure: WFS fetch failed for layer %r (degraded — treated as empty)",
            layer, exc_info=True,
        )
        return []
    return data.get("features", []) or []


_ADMIN_BOUNDARY_SIMPLIFY_TOLERANCE_DEG = 0.0005  # ~50m — see tag_administrative_context docstring


def tag_administrative_context(flood_zone_geom, bbox, zone_km2=None):
    """District/tehsil polygons intersecting the flood-prone zone, with a
    real overlap area (km^2) and the % of the flood zone each accounts
    for — answers Phase 1.5's own "which district is most at risk"
    exit-criterion question.

    Fetched district/tehsil boundaries are simplified (~50m tolerance,
    topology-preserving) before intersecting — confirmed live that a real
    district polygon here (Rawalpindi) carries 53,250 vertices, needless
    precision for an overlap-percentage figure and, combined with the
    flood zone's own vertex count, slow enough to make a single
    .intersection() call hang for minutes in this phase's own testing.
    Only this LOCAL copy is simplified; nothing upstream (the WFS source,
    any other feature using these boundaries) is touched."""
    from shapely.geometry import shape as shapely_shape

    if zone_km2 is None:
        zone_km2 = _geom_area_km2(flood_zone_geom)

    results = []
    for layer, level in (("district_boundary", "district"), ("tehsil_boundary", "tehsil")):
        for feat in _wfs_get_geojson(layer, bbox):
            geom = shapely_shape(feat["geometry"])
            if not geom.is_valid:
                geom = geom.buffer(0)
            geom = geom.simplify(_ADMIN_BOUNDARY_SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)
            inter = geom.intersection(flood_zone_geom)
            if inter.is_empty:
                continue
            overlap_km2 = _geom_area_km2(inter)
            props = feat.get("properties", {})
            results.append({
                "level": level,
                "name": props.get("name"),
                "district": props.get("district"),
                "province": props.get("province"),
                "overlap_km2": round(overlap_km2, 3),
                "pct_of_flood_zone": round(100 * overlap_km2 / zone_km2, 1) if zone_km2 else None,
            })
    results.sort(key=lambda r: r["overlap_km2"], reverse=True)
    return results


def fetch_existing_infrastructure_exposure(flood_zone_geom, bbox):
    """Airports/schools/settlements already served by NCOP's own
    Infrastructure category — reused as-is (§0.5's "four of five things
    named are already real NCOP assets"), not re-fetched from anywhere
    new. These features already carry district/tehsil/hi_riverine_flooding
    attributes server-side (confirmed live), surfaced here rather than
    recomputed."""
    from shapely.geometry import shape as shapely_shape
    from shapely.prepared import prep

    # Confirmed live: without this, ~1,300 point tests against a 714-part
    # flood-zone MultiPolygon took 64s — .intersects() with no spatial
    # index re-evaluates the whole multipolygon per call. prep() builds
    # that index once for a fixed geometry queried repeatedly, the
    # standard shapely idiom for exactly this "one geometry vs many query
    # points" shape.
    prepared_zone = prep(flood_zone_geom)

    out = {}
    for layer in ("airports", "schools", "settlements"):
        features = _wfs_get_geojson(layer, bbox)
        inside = []
        for feat in features:
            geom = shapely_shape(feat["geometry"])
            if not prepared_zone.intersects(geom):
                continue
            props = feat.get("properties", {})
            inside.append({
                "name": props.get("name") or props.get("places") or props.get("school_name"),
                "district": props.get("district"),
                "tehsil": props.get("tehsil"),
                "hi_riverine_flooding": props.get("hi_riverine_flooding"),
            })
        out[layer] = {"total_in_aoi": len(features), "in_flood_zone": inside}
    return out


# ---------------------------------------------------------------------------
# Overture Maps buildings exposure — the one genuinely new external data
# source in this phase (§0.6). See module docstring for the confirmed-live
# performance characteristics driving the disk-cache + bounded-executor
# design below.
# ---------------------------------------------------------------------------

def _latest_overture_release():
    """Lists Overture's own S3 release directories and picks the latest
    (their release ids are YYYY-MM-DD.N, so lexicographic == chronological
    sort) — avoids hardcoding a release id that will eventually go stale.
    Cached per-process; a fresh release only needs to be picked up once
    per worker restart, not once per call."""
    global _overture_release_cache
    if _overture_release_cache:
        return _overture_release_cache
    import pyarrow.fs as pafs

    fs = pafs.S3FileSystem(anonymous=True, region=_OVERTURE_REGION)
    info = fs.get_file_info(pafs.FileSelector(f"{_OVERTURE_S3_BUCKET}/release", recursive=False))
    releases = sorted(i.path.split("/")[-1] for i in info if i.type.name == "Directory")
    if not releases:
        raise RuntimeError("No Overture Maps releases found on S3 (anonymous listing returned none)")
    _overture_release_cache = releases[-1]
    return _overture_release_cache


def _fetch_overture_buildings_raw(bbox):
    """The slow part (confirmed live: ~225s for the Nullah Lai pilot bbox
    — see module docstring). Runs a bbox-filtered read against Overture's
    public buildings/building GeoParquet theme via plain pyarrow.dataset
    (deliberately NOT the `overturemaps` PyPI wrapper package — installing
    it force-upgrades shapely to >=2.1.0, an unpinned bump this app's
    existing geopandas==1.1.1/shapely==2.0.6 combo doesn't need and
    wasn't worth risking; deliberately NOT DuckDB either — tested live,
    projected 4-5+ minutes for the same query via its httpfs+spatial
    extensions, strictly worse than plain pyarrow here, not worth the
    extra native-dependency surface for a slower result). Returns a
    pyarrow Table; the caller narrows it further and discards it — never
    kept resident longer than one fetch."""
    import pyarrow.dataset as ds
    import pyarrow.fs as pafs
    import pyarrow.compute as pc

    release = _latest_overture_release()
    fs = pafs.S3FileSystem(anonymous=True, region=_OVERTURE_REGION)
    path = f"{_OVERTURE_S3_BUCKET}/release/{release}/theme=buildings/type=building"
    dataset = ds.dataset(path, filesystem=fs, format="parquet", partitioning="hive")

    minx, miny, maxx, maxy = bbox
    filt = (
        (pc.field("bbox", "xmin") <= maxx) & (pc.field("bbox", "xmax") >= minx)
        & (pc.field("bbox", "ymin") <= maxy) & (pc.field("bbox", "ymax") >= miny)
    )
    return dataset.to_table(filter=filt, columns=["id", "geometry", "bbox"])


def fetch_overture_buildings_exposure(catchment_key, bbox, flood_zone_geom, force=False):
    """Disk-cached per catchment (project/media/flood_model/<catchment>/
    overture_buildings.json) — the expensive S3 fetch above is paid once
    per catchment (or on force=True), never per call, so re-running with a
    different HAND threshold never re-hits the network.

    Confirmed live, correcting an earlier assumption: pyarrow's filter=
    predicate on dataset.to_table() is applied per-ROW, not just at
    row-group-skip granularity — every row this function gets back from
    _fetch_overture_buildings_raw already satisfies the exact bbox test
    (the narrowing loop below removed zero of 603,076 rows in this
    phase's own test run). The ~225-240s cost is entirely from Parquet
    ROW-GROUP-level pruning being coarse (each row group spans more area
    than a small pilot catchment, so many still have to be read and
    decompressed even though few of their rows survive the filter) — the
    narrowing loop is kept as a cheap, correct safety net, not because it
    was observed to do real work.

    **Optimization pass (confirmed live, replacing an earlier, weaker
    finding):** the cache no longer stores each building's own bbox.
    Tested directly against the real Nullah Lai flood zone before
    removing it: the zone's OWN bounding box (`72.9498,33.4998` to
    `73.2001,33.7801`) turned out to be almost exactly the whole AOI's
    bbox — its 714 parts are scattered across nearly the full catchment,
    not clustered in one corner — so a per-building bbox pre-filter let
    100% of 603,076 buildings survive every time. That's WHY the earlier
    "bbox fast-reject measured within noise of no improvement" finding
    held: it wasn't a flawed implementation, the AOI's own geometry makes
    bbox pre-filtering structurally useless here. The bbox fields were
    dead weight in both the cache (four floats × 603k records) and the
    per-record Python loop that used them — both removed.

    **The real fix, tested and confirmed live:** replaced the per-building
    Python loop (`for b in buildings: ... prepared_zone.intersects(...)`)
    with `shapely.STRtree` — build the tree once over every building
    polygon, then a single `tree.query(flood_zone_geom, predicate=
    "intersects")` call does the exact geometric test for all of them at
    once via GEOS's own compiled batch machinery, not a Python-level loop.
    Confirmed live: same exact correct count (77,862) as the original
    per-building loop — zero accuracy loss — in ~11.3s total (parse WKB
    1.9s + build tree 0.6s + query 8.9s) vs. the original loop's ~15-19s,
    a genuine ~30-40% improvement, not a marginal one. (A centroid-only
    approximation was tested and REJECTED first: confirmed live it
    disagrees with the full-polygon result for 2.3% of all buildings,
    enough to shift the reported in-zone count by ~18% relative — too
    much accuracy loss for a memory optimization to be worth it.)"""
    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    cache_path = os.path.join(out_dir, "overture_buildings.json")

    if force or not (os.path.exists(cache_path) and os.path.getsize(cache_path) > 0):
        # §0.37 — coalesced (skipped when force=True: a deliberate cache
        # bust always gets its own real fetch, never joins a stale/
        # different-parameters in-flight future meant for someone else's
        # call). The common case (force=False, e.g. a prewarm call and
        # the real Run job's own later call for the same catchment_key)
        # correctly joins one shared fetch instead of running it twice.
        future = (
            _submit_coalesced(_OVERTURE_EXECUTOR, catchment_key, _fetch_overture_buildings_raw, bbox)
            if not force else _OVERTURE_EXECUTOR.submit(_fetch_overture_buildings_raw, bbox)
        )
        try:
            table = future.result(timeout=_OVERTURE_FETCH_TIMEOUT_SECONDS)
        except _FutureTimeoutError:
            raise RuntimeError(
                f"Overture Maps buildings fetch did not finish within "
                f"{_OVERTURE_FETCH_TIMEOUT_SECONDS}s for catchment {catchment_key!r}"
            )
        minx, miny, maxx, maxy = bbox
        narrowed = []
        for rec in table.to_pylist():
            bb = rec["bbox"]
            if bb["xmax"] < minx or bb["xmin"] > maxx or bb["ymax"] < miny or bb["ymin"] > maxy:
                continue
            narrowed.append({"id": rec["id"], "wkb_hex": rec["geometry"].hex()})
        tmp_path = f"{cache_path}.tmp{os.getpid()}"
        with open(tmp_path, "w") as f:
            json.dump(narrowed, f)
        os.replace(tmp_path, cache_path)

    with open(cache_path) as f:
        buildings = json.load(f)

    import shapely.wkb as shapely_wkb
    from shapely import STRtree

    polys = [shapely_wkb.loads(bytes.fromhex(b["wkb_hex"])) for b in buildings]
    tree = STRtree(polys)
    matches = tree.query(flood_zone_geom, predicate="intersects")
    in_zone = len(matches)

    return {
        "total_buildings_in_aoi": len(buildings),
        "buildings_in_flood_zone": in_zone,
        "release": _latest_overture_release(),
    }


# ---------------------------------------------------------------------------
# OSM/Overpass — bridges + hospitals (genuinely new; Overture's own
# integration above only ever covered buildings) and a degraded fallback
# for buildings if Overture's fetch fails. See the constants block for why
# this does NOT replace Overture.
# ---------------------------------------------------------------------------

def _overpass_query(query):
    """POSTs one Overpass QL query, retrying with backoff across the two
    configured mirrors on a 429/5xx/timeout. Confirmed live during this
    module's own research: the public overpass-api.de instance DOES
    rate-limit under moderate sequential load (a real 429 was hit after
    ~4 back-to-back test queries), and a heavy per-element `tags` request
    against a large result set (17,686 buildings) triggered a server-side
    504 that a lighter `out ids center` request for the exact same
    elements did not — Overpass's own per-query cost scales with how much
    is asked for, not just how many elements match. Callers should ask
    for tags only when they're actually going to use them (bridges/
    hospitals here; never buildings). Degrades to None on exhausted
    retries — never raises past this module, matching _wfs_get_geojson's
    own convention."""
    import time as _time
    import requests

    headers = {"User-Agent": _OVERPASS_USER_AGENT}
    for attempt in range(_OVERPASS_MAX_RETRIES):
        endpoint = _OVERPASS_ENDPOINTS[attempt % len(_OVERPASS_ENDPOINTS)]
        try:
            resp = requests.post(
                endpoint, data={"data": query}, headers=headers,
                timeout=_OVERPASS_TIMEOUT_SECONDS,
            )
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code in (429, 500, 502, 503, 504):
                # 500 added after a confirmed-live false negative (§0.17):
                # a roads query 500'd once, then the IDENTICAL query
                # succeeded (200) on a manual retry seconds later — a
                # transient server-side condition on the public instance,
                # not a real problem with the query itself. Treated the
                # same as the other transient-failure codes already here.
                _time.sleep(3 * (2 ** attempt))  # 3s, 6s, 12s — polite backoff, not a tight retry loop
                continue
            logger.warning(
                "flood_exposure: Overpass returned HTTP %s for a query (not retrying)",
                resp.status_code,
            )
            return None
        except Exception:
            logger.warning(
                "flood_exposure: Overpass request failed (attempt %d/%d)",
                attempt + 1, _OVERPASS_MAX_RETRIES, exc_info=True,
            )
            _time.sleep(3 * (2 ** attempt))
    logger.warning("flood_exposure: Overpass query exhausted all retries/mirrors — degraded to empty result")
    return None


def _overpass_bbox_str(bbox):
    minx, miny, maxx, maxy = bbox
    return f"{miny},{minx},{maxy},{maxx}"  # Overpass wants south,west,north,east


def _osm_points_in_zone(elements, flood_zone_geom, with_tags=False):
    """Shared helper: Overpass 'out center' elements -> count inside the
    flood zone, using each element's centroid (both for nodes and for
    ways/relations, which Overpass already reduces to a `center` point
    when asked — cheap and sufficient for an "is this located inside the
    zone" exposure check, no need for the full way geometry)."""
    from shapely.geometry import Point
    from shapely.prepared import prep

    prepared_zone = prep(flood_zone_geom)
    inside = []
    for el in elements:
        if el.get("type") == "node":
            lon, lat = el.get("lon"), el.get("lat")
        else:
            center = el.get("center") or {}
            lon, lat = center.get("lon"), center.get("lat")
        if lon is None or lat is None:
            continue
        if not prepared_zone.intersects(Point(lon, lat)):
            continue
        if with_tags:
            tags = el.get("tags", {})
            inside.append({"name": tags.get("name"), "tags": tags})
        else:
            inside.append(True)
    return inside


def fetch_osm_bridges_hospitals_exposure(catchment_key, bbox, flood_zone_geom, force=False):
    """Bridges (`bridge=*` ways) and hospitals (`amenity=hospital`) —
    categories Overture's buildings-only integration never covered.
    Hospitals specifically fills a confirmed, real NCOP gap: §0.5's audit
    found `hospitals` commented out/disabled in the existing Infrastructure
    category. Disk-cached per catchment (these are small result sets —
    786 bridges / 139 hospitals confirmed live for the Nullah Lai pilot —
    so re-fetching is cheap, but caching still avoids hitting the shared
    public Overpass instance on every report call)."""
    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    cache_path = os.path.join(out_dir, "osm_bridges_hospitals.json")

    if force or not (os.path.exists(cache_path) and os.path.getsize(cache_path) > 0):
        import time as _time

        bbox_str = _overpass_bbox_str(bbox)
        queries = {
            "bridges": f'[out:json][timeout:55];(way["bridge"]({bbox_str}););out center tags;',
            "hospitals": (
                f'[out:json][timeout:55];'
                f'(node["amenity"="hospital"]({bbox_str});way["amenity"="hospital"]({bbox_str}););'
                f'out center tags;'
            ),
        }
        cache_data = {}
        # Tracked so a transient failure on EITHER sub-query never gets
        # cached — same real bug/fix as fetch_road_network_exposure's
        # own comment, generalized to a 2-query function: writing the
        # cache after only a PARTIAL success would silently poison the
        # successfully-fetched key too (both keys share one cache file),
        # not just the failed one.
        any_query_failed = False
        for i, (key, q) in enumerate(queries.items()):
            if i > 0:
                _time.sleep(1.5)  # polite spacing between sequential queries on a shared public instance
            result = _overpass_query(q)
            if result is None:
                any_query_failed = True
            elements = result.get("elements", []) if result else []
            items = []
            for el in elements:
                if el.get("type") == "node":
                    lon, lat = el.get("lon"), el.get("lat")
                else:
                    center = el.get("center") or {}
                    lon, lat = center.get("lon"), center.get("lat")
                if lon is None or lat is None:
                    continue
                items.append({"lon": lon, "lat": lat, "tags": el.get("tags", {})})
            cache_data[key] = items
        if any_query_failed:
            logger.warning(
                "flood_exposure: bridges/hospitals Overpass query failed for %r — using "
                "whatever succeeded for THIS call only, NOT caching it (a real fetch, "
                "not a real empty result)",
                catchment_key,
            )
        else:
            tmp_path = f"{cache_path}.tmp{os.getpid()}"
            with open(tmp_path, "w") as f:
                json.dump(cache_data, f)
            os.replace(tmp_path, cache_path)
    else:
        with open(cache_path) as f:
            cache_data = json.load(f)

    from shapely.geometry import Point
    from shapely.prepared import prep

    out = {}
    for key, items in cache_data.items():
        prepared_zone = prep(flood_zone_geom)
        inside = []
        for it in items:
            if prepared_zone.intersects(Point(it["lon"], it["lat"])):
                inside.append({"name": it["tags"].get("name")})
        out[key] = {"total_in_aoi": len(items), "in_flood_zone": inside}
    return out


def fetch_osm_buildings_fallback(bbox, flood_zone_geom):
    """FALLBACK ONLY — called from build_exposure_report() when
    fetch_overture_buildings_exposure() raises (S3/network/timeout
    issue), never as a first choice. Confirmed live: this undercounts
    vs. Overture by roughly 34x in the Nullah Lai pilot (17,686 vs.
    603,076) — a known OSM coverage gap in areas with heavy informal/
    unmapped settlement, not a bug in this function. The caller must tag
    the result with its own "source" field so a fallback count is never
    silently mistaken for Overture's fuller one.

    Deliberately requests `out ids center` — NO tags. Confirmed live:
    the same query WITH `tags` on this many elements (17,686) triggered a
    server-side 504 from the public Overpass instance; dropping tags
    (buildings don't carry individually useful ones for this purpose
    anyway — only the count and location matter) fixed it outright."""
    bbox_str = _overpass_bbox_str(bbox)
    q = f'[out:json][timeout:55];(way["building"]({bbox_str}););out ids center;'
    result = _overpass_query(q)
    elements = result.get("elements", []) if result else []
    in_zone = len(_osm_points_in_zone(elements, flood_zone_geom))
    return {
        "total_buildings_in_aoi": len(elements),
        "buildings_in_flood_zone": in_zone,
        "source": "osm_fallback",
    }


# Standard vehicular-road-network classes (matches this app's own
# flood-exposure-literature research in §0.9) — excludes footway/path/
# track/steps/pedestrian/cycleway/construction, which OSM also tags under
# `highway=*` but aren't a meaningful "road network" for runoff/impervious
# -surface or vehicle-access exposure purposes. Confirmed live via the
# actual Nullah Lai breakdown (residential 34,740 dominates; footway 2,947
# / path 650 / track 341 / steps 168 / cycleway 80 / construction 184
# would have inflated an unfiltered total by ~7% if left in).
_VEHICULAR_HIGHWAY_CLASSES = {
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "unclassified", "residential",
    "living_street", "service", "busway",
}


def fetch_road_network_exposure(catchment_key, bbox, flood_zone_geom, force=False):
    """Road network (`highway=*`), for flood susceptibility/inundation
    context — impervious-surface/runoff proxy and, for actual
    inundation, which stretches of road are exposed. Confirmed live:
    54,860 road ways in the Nullah Lai pilot AOI (`out geom tags`: 3.6s
    this run — Overpass's own response time is genuinely variable run to
    run, confirmed by an earlier no-tags fetch of the same data taking
    14.9s; `_overpass_query()`'s retry/backoff already covers this).
    Reports the full network AND a `vehicular` sub-figure filtered to
    `_VEHICULAR_HIGHWAY_CLASSES` — the unfiltered total otherwise
    includes footpaths/tracks/steps, which inflate a "road network"
    figure in a way that doesn't match how the flood-exposure literature
    (§0.9) actually reports this metric. Disk-cached per catchment — this
    is the raw geometry+tag cache; the length-vs-flood-zone computation
    itself still reruns on every call (see _line_network_length_exposure;
    confirmed live at ~38-49s even warm for the full 54,860-way network —
    the same per-feature-reprojection cost class as the Overture warm-
    cache finding, needs the same "not request-facing yet" caveat)."""
    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    cache_path = os.path.join(out_dir, "osm_roads.json")

    if force or not (os.path.exists(cache_path) and os.path.getsize(cache_path) > 0):
        bbox_str = _overpass_bbox_str(bbox)
        q = f'[out:json][timeout:55];(way["highway"]({bbox_str}););out geom tags;'
        result = _overpass_query(q)
        # A real bug found and fixed live (confirmed live: a transient
        # Overpass read-timeout wrote an empty [] here, then a LATER
        # force=False call trusted that empty cache forever, silently
        # showing "0 roads" for a catchment that genuinely has tens of
        # thousands). `result is None` means the QUERY itself failed
        # (network/timeout/exhausted retries — _overpass_query's own
        # documented degradation), a completely different thing from a
        # real, successful query that legitimately found zero elements
        # — only the SECOND case is safe to cache. On a failed query,
        # use an empty list for THIS call only (never crash), but leave
        # any existing cache alone and never write a fresh empty one, so
        # the next call retries instead of trusting a transient failure.
        if result is None:
            elements = []
            cache_data = [
                {"geometry": el["geometry"], "highway": (el.get("tags") or {}).get("highway")}
                for el in elements if el.get("geometry") and len(el["geometry"]) >= 2
            ]
            logger.warning(
                "flood_exposure: roads Overpass query failed for %r — using an empty result "
                "for THIS call only, NOT caching it (a real fetch, not a real empty result)",
                catchment_key,
            )
        else:
            elements = result.get("elements", [])
            cache_data = [
                {"geometry": el["geometry"], "highway": (el.get("tags") or {}).get("highway")}
                for el in elements if el.get("geometry") and len(el["geometry"]) >= 2
            ]
            tmp_path = f"{cache_path}.tmp{os.getpid()}"
            with open(tmp_path, "w") as f:
                json.dump(cache_data, f)
            os.replace(tmp_path, cache_path)
    else:
        with open(cache_path) as f:
            cache_data = json.load(f)

    # Single reprojection pass over every way, accumulating BOTH the full
    # network and the vehicular-only subset at once — calling
    # _line_network_length_exposure() twice (once per subset) would
    # reproject the vehicular ways a second time for no reason, doubling
    # an already-expensive cost (confirmed live: ~38-49s just for the
    # full network at this AOI's ~55k-way scale).
    from shapely.geometry import LineString
    from shapely.ops import transform as shapely_transform

    transformer = _local_utm_transformer(bbox)
    zone_utm = shapely_transform(transformer.transform, flood_zone_geom)
    zminx, zminy, zmaxx, zmaxy = flood_zone_geom.bounds

    totals = {"all": [0.0, 0.0, 0], "vehicular": [0.0, 0.0, 0]}  # [total_km, in_zone_km, count]
    for c in cache_data:
        pts = c.get("geometry")
        if not pts or len(pts) < 2:
            continue
        line = LineString((p["lon"], p["lat"]) for p in pts)
        lx0, ly0, lx1, ly1 = line.bounds
        line_utm = shapely_transform(transformer.transform, line)
        length_km = line_utm.length / 1000.0
        in_zone_km = 0.0
        if not (lx1 < zminx or lx0 > zmaxx or ly1 < zminy or ly0 > zmaxy):
            clipped = line_utm.intersection(zone_utm)
            if not clipped.is_empty:
                in_zone_km = clipped.length / 1000.0

        buckets = ["all"] + (["vehicular"] if c.get("highway") in _VEHICULAR_HIGHWAY_CLASSES else [])
        for b in buckets:
            totals[b][0] += length_km
            totals[b][1] += in_zone_km
            totals[b][2] += 1

    all_km, all_in_zone, all_count = totals["all"]
    veh_km, veh_in_zone, veh_count = totals["vehicular"]
    return {
        "total_length_km": round(all_km, 2),
        "length_in_flood_zone_km": round(all_in_zone, 2),
        "total_road_ways": all_count,
        "vehicular": {
            "total_length_km": round(veh_km, 2),
            "length_in_flood_zone_km": round(veh_in_zone, 2),
            "total_road_ways": veh_count,
        },
    }


# ---------------------------------------------------------------------------
# Population & vulnerable-population exposure (§0.9) — WorldPop via Earth
# Engine, server-side reduceRegion, no raster download at all. Genuinely
# different cost shape from everything else in this module: fast (1.6-7.4s
# confirmed live), so no disk cache and no need for one — bounded by a
# dedicated executor+timeout like the rest of this module's external calls,
# but called fresh on every report rather than cached, since re-fetching is
# cheap enough that a stale cache isn't worth the added complexity.
# ---------------------------------------------------------------------------

def _elderly_age_bands(cutoff_age):
    """M_/F_ band names for every WorldPop age bin >= cutoff_age — e.g.
    cutoff_age=65 -> M_65,F_65,M_70,F_70,...,M_80,F_80. Kept as a
    parameter (not hardcoded) per §0.9's own design note: a 60+ cutoff is
    equally available from the same band structure if a future review
    prefers the WHO's alternate elderly threshold."""
    bins = [b for b in _WORLDPOP_AGE_BINS if b >= cutoff_age]
    return [f"{sex}_{b}" for b in bins for sex in ("M", "F")]


def _children_age_bands(children_cutoff_age):
    """M_/F_ band names for every WorldPop age bin BELOW children_cutoff_age
    — same construction as _elderly_age_bands, mirrored for the other end
    of the age range. Default cutoff (15) matches the common under-15
    "children" convention used in disaster-response demographic reporting
    (distinct from — and broader than — the existing under5 band, which
    stays exactly as it was)."""
    bins = [b for b in _WORLDPOP_AGE_BINS if b < children_cutoff_age]
    return [f"{sex}_{b}" for b in bins for sex in ("M", "F")]


def _fetch_population_raw(flood_zone_geom, elderly_cutoff_age, children_cutoff_age=None):
    """The actual Earth Engine call — always run through the bounded
    executor below, never called directly, matching every other external
    call in this module.

    `children_cutoff_age` is None by default (a real, additive-only
    parameter) — every EXISTING caller that doesn't pass it gets EXACTLY
    the same total/under5/elderly computation as before, byte-for-byte;
    passing a value adds male/female/children fields alongside, computed
    from WorldPop's own already-present per-sex age bins (this dataset
    already carries the M_/F_ split per age bin — summing across ALL bins
    per sex, rather than only the elderly/under5 subsets already summed,
    is the only new computation needed)."""
    from . import views  # noqa: F401 — import side effect: initializes Earth Engine
    import ee
    import shapely.geometry

    ee_geom = ee.Geometry(shapely.geometry.mapping(flood_zone_geom))
    img = (
        ee.ImageCollection("WorldPop/GP/100m/pop_age_sex")
        .filter(ee.Filter.eq("country", _WORLDPOP_COUNTRY))
        .filter(ee.Filter.eq("year", _WORLDPOP_YEAR))
        .first()
    )
    under5_bands = ["M_0", "F_0", "M_1", "F_1"]
    elderly_bands = _elderly_age_bands(elderly_cutoff_age)

    under5 = img.select(under5_bands).reduce(ee.Reducer.sum()).rename("under5")
    elderly = img.select(elderly_bands).reduce(ee.Reducer.sum()).rename("elderly")
    total = img.select("population").rename("total")
    bands = [total, under5, elderly]

    if children_cutoff_age is not None:
        male_bands = [f"M_{b}" for b in _WORLDPOP_AGE_BINS]
        female_bands = [f"F_{b}" for b in _WORLDPOP_AGE_BINS]
        children_bands = _children_age_bands(children_cutoff_age)
        male = img.select(male_bands).reduce(ee.Reducer.sum()).rename("male")
        female = img.select(female_bands).reduce(ee.Reducer.sum()).rename("female")
        children = img.select(children_bands).reduce(ee.Reducer.sum()).rename("children")
        bands += [male, female, children]

    combined = ee.Image.cat(bands)
    return combined.reduceRegion(
        reducer=ee.Reducer.sum(), geometry=ee_geom, scale=100, maxPixels=1e9,
    ).getInfo()


def fetch_population_exposure(flood_zone_geom, elderly_cutoff_age=65, children_cutoff_age=None):
    """Population, under-5, and elderly (>=elderly_cutoff_age) counts
    inside the flood-prone zone — confirmed live in §0.9's research
    against this exact pilot: 425,116 / 47,137 / 16,759, a figure that
    cross-checked almost exactly against the buildings (~13%) and area
    (~13%) exposure fractions found elsewhere in this pipeline.

    `children_cutoff_age` — None by default (every existing caller keeps
    the EXACT original total/under5/elderly-only shape). Pass an age
    (e.g. 15) to additionally get male/female/children counts — the
    demographic breakdown riverine mode's own exposure report requests,
    reusing this SAME function rather than a parallel one, since the
    underlying WorldPop fetch is identical either way; the existing
    fixed-threshold/discharge-driven callers are UNCHANGED (see
    _build_exposure_from_geom's own call site — still passes nothing).

    Bounded via _POPULATION_EXECUTOR + future.result(timeout=...) — the
    same "external call must never hang the caller indefinitely" pattern
    every other external call in this module already uses (WFS, Overpass,
    Overture), even though this is Earth Engine, not a plain `requests`
    call, and even though views.py's own older AHP-susceptibility code
    calls ee.*.getInfo() unwrapped — this module holds every external
    call to its own consistent bounded-timeout bar. Degrades to None
    (never raises past this module) on any timeout or GEE-side failure,
    matching this module's established graceful-degradation convention;
    callers must handle a None population block explicitly rather than
    assuming it's always present."""
    future = _POPULATION_EXECUTOR.submit(
        _fetch_population_raw, flood_zone_geom, elderly_cutoff_age, children_cutoff_age,
    )
    try:
        stats = future.result(timeout=_POPULATION_TIMEOUT_SECONDS)
    except _FutureTimeoutError:
        logger.warning(
            "flood_exposure: WorldPop population fetch timed out after %ss - degraded to None",
            _POPULATION_TIMEOUT_SECONDS,
        )
        return None
    except Exception:
        logger.warning("flood_exposure: WorldPop population fetch failed - degraded to None", exc_info=True)
        return None

    result = {
        "total": round(stats.get("total") or 0),
        "under5": round(stats.get("under5") or 0),
        "elderly": round(stats.get("elderly") or 0),
        "elderly_cutoff_age": elderly_cutoff_age,
        "year": _WORLDPOP_YEAR,
    }
    if children_cutoff_age is not None:
        result["male"] = round(stats.get("male") or 0)
        result["female"] = round(stats.get("female") or 0)
        result["children"] = round(stats.get("children") or 0)
        result["children_cutoff_age"] = children_cutoff_age
    return result


def fetch_drainage_network_exposure(catchment_key, bbox, flood_zone_geom, force=False):
    """Fine-grained drainage (`waterway=*`: river/stream/canal/drain/
    ditch), NOT a replacement for the HAND pipeline's own DEM-derived
    stream network (flood_model.py's `06_streams.tif` — that IS the
    drainage network the HAND calculation itself is built on, already
    computed, nothing new needed there) or NCOP's own `major_rivers`/
    `minor_rivers` GeoServer layers (large-scale named rivers, already
    reusable via _wfs_get_geojson). This fills the gap neither of those
    covers: fine urban/engineered drainage. Confirmed live on Nullah Lai:
    876 features — 562 streams, 261 drains, 40 rivers, 6 dams, 6 ditches,
    1 canal (a real, useful breakdown, not just a raw count) — fetched in
    1.26s with tags included (a far smaller result set than roads, so the
    per-element tags cost confirmed problematic for buildings/roads isn't
    a concern here)."""
    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    cache_path = os.path.join(out_dir, "osm_drainage.json")

    if force or not (os.path.exists(cache_path) and os.path.getsize(cache_path) > 0):
        bbox_str = _overpass_bbox_str(bbox)
        q = f'[out:json][timeout:55];(way["waterway"]({bbox_str}););out geom tags;'
        result = _overpass_query(q)
        # Same real bug/fix as fetch_road_network_exposure's own comment
        # (confirmed live on THIS function specifically: a transient
        # Overpass timeout cached an empty [] for drainage, silently
        # showing "0 drainage" forever afterward) — only cache a REAL,
        # successful (possibly genuinely-empty) query result; a failed
        # query returns an empty result for this call only, never
        # written to disk, so the next call retries instead of trusting
        # a transient failure.
        if result is None:
            elements = []
            cache_data = [
                {"geometry": el["geometry"], "subtype": (el.get("tags") or {}).get("waterway")}
                for el in elements if el.get("geometry") and len(el["geometry"]) >= 2
            ]
            logger.warning(
                "flood_exposure: drainage Overpass query failed for %r — using an empty "
                "result for THIS call only, NOT caching it (a real fetch, not a real empty result)",
                catchment_key,
            )
        else:
            elements = result.get("elements", [])
            cache_data = [
                {"geometry": el["geometry"], "subtype": (el.get("tags") or {}).get("waterway")}
                for el in elements if el.get("geometry") and len(el["geometry"]) >= 2
            ]
            tmp_path = f"{cache_path}.tmp{os.getpid()}"
            with open(tmp_path, "w") as f:
                json.dump(cache_data, f)
            os.replace(tmp_path, cache_path)
    else:
        with open(cache_path) as f:
            cache_data = json.load(f)

    overall = _line_network_length_exposure(cache_data, flood_zone_geom, bbox)
    overall["total_features"] = len(cache_data)

    by_subtype = {}
    for subtype in {c.get("subtype") for c in cache_data}:
        subset = [c for c in cache_data if c.get("subtype") == subtype]
        stats = _line_network_length_exposure(subset, flood_zone_geom, bbox)
        by_subtype[subtype or "unknown"] = {"count": len(subset), **stats}
    overall["by_subtype"] = by_subtype
    return overall


# ---------------------------------------------------------------------------
# Combined report — Phase 1.5's actual exit criterion: a single call
# answers "which district, how many buildings, how many
# schools/settlements/airports are inside the flood-prone zone."
# ---------------------------------------------------------------------------

def build_exposure_report(catchment_key, threshold_m=None, force=False, progress_callback=None):
    """`progress_callback`, if given, is called with a short human-readable
    stage name before each major step below — purely additive, opt-in
    instrumentation for a caller that wants to surface progress (see
    flood_model_views.py's job runner), never required. Every existing
    caller (the management command, every test in this codebase) passes
    nothing and behaves exactly as before — this parameter changes no
    control flow, no return value, no core logic."""
    from . import flood_model

    def _report_stage(name):
        if progress_callback:
            try:
                progress_callback(name)
            except Exception:
                logger.warning("flood_exposure: progress_callback raised (ignored)", exc_info=True)

    if threshold_m is None:
        threshold_m = flood_model.HAND_FLOOD_PRONE_THRESHOLD_M
    if catchment_key not in flood_model.PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(flood_model.PILOT_CATCHMENTS)}")
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    hand_path = pipeline["paths"]["hand"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    mask_path = os.path.join(out_dir, f"flood_mask_{threshold_m}.tif")

    _report_stage("Building flood-prone zone raster")
    if force or not (os.path.exists(mask_path) and os.path.getsize(mask_path) > 0):
        with flood_model._gdal_lock():
            _binary_flood_mask(hand_path, threshold_m, mask_path)

        # §0.37 — fixed-threshold mode's own exposure report computes
        # this binary mask independently of render_flood_prone_zones'
        # own PNG (that one already clips itself — see flood_model.py's
        # own render_flood_prone_zones docstring) and independently of
        # build_discharge_binary_mask's own masked_hand_path (also
        # already clipped) — so this is a genuinely separate place the
        # same real drawn-polygon clip needs applying, or a custom
        # AOI's own BUILDINGS/ROADS/POPULATION counts (not just the
        # rendered shape) would still reflect the whole unclipped bbox.
        # A curated pilot catchment never sets clip_polygon — no-op for
        # all 4 of them.
        cfg = flood_model.PILOT_CATCHMENTS.get(catchment_key, {})
        clip_polygon = cfg.get("clip_polygon")
        if clip_polygon:
            with flood_model._gdal_lock():
                mask_arr, mask_gt, mask_proj, mask_nodata, mw, mh = flood_model._read_raster_array(mask_path)
                clipped_arr = flood_model._clip_array_to_polygon(mask_arr, mask_gt, mask_proj, 0, clip_polygon)
                tmp_clip = f"{mask_path}.tmp{os.getpid()}"
                flood_model._write_raster_array(tmp_clip, clipped_arr, mask_gt, mask_proj, mask_nodata if mask_nodata is not None else 0)
            os.replace(tmp_clip, mask_path)

    _report_stage("Vectorizing flood-prone zone")
    with flood_model._gdal_lock():
        flood_zone_geom = _vectorize_flood_zone(mask_path)

    result = _build_exposure_from_geom(catchment_key, bbox, flood_zone_geom, force, _report_stage)
    return {"catchment": catchment_key, "threshold_m": threshold_m, **result}


def _build_exposure_from_geom(catchment_key, bbox, flood_zone_geom, force, _report_stage):
    """Shared core of build_exposure_report() and
    build_discharge_exposure_report() (§0.24) — everything below only
    needs a flood-zone GEOMETRY, not how it was derived (a fixed HAND
    threshold's binary mask vs. a discharge-driven per-pixel mask).
    Extracted verbatim from build_exposure_report's own prior inline
    body, not rewritten — regression-tested (§0.24) to produce
    byte-identical output for the fixed-threshold caller before/after
    this extraction, matching the same "extract, don't rewrite"
    discipline already used for accuracy_assessment._sample_and_score.

    Returns a dict WITHOUT "catchment"/"threshold_m" (those are mode-
    specific identifiers, added by each caller) — everything else
    (flood_zone_km2, administrative_context, infrastructure, buildings,
    osm_infrastructure, roads, drainage, population)."""
    if flood_zone_geom is None or flood_zone_geom.is_empty:
        return {
            "flood_zone_km2": 0.0,
            "administrative_context": [],
            "infrastructure": {},
            "buildings": {"total_buildings_in_aoi": 0, "buildings_in_flood_zone": 0},
            "osm_infrastructure": {},
            "roads": {"total_length_km": 0.0, "length_in_flood_zone_km": 0.0, "total_road_ways": 0,
                      "vehicular": {"total_length_km": 0.0, "length_in_flood_zone_km": 0.0, "total_road_ways": 0}},
            "drainage": {"total_length_km": 0.0, "length_in_flood_zone_km": 0.0, "total_features": 0, "by_subtype": {}},
            "population": {"total": 0, "under5": 0, "elderly": 0, "elderly_cutoff_age": 65, "year": _WORLDPOP_YEAR},
        }

    zone_km2 = _geom_area_km2(flood_zone_geom)

    _report_stage("Tagging administrative context (district/tehsil)")
    admin_context = tag_administrative_context(flood_zone_geom, bbox, zone_km2=zone_km2)

    _report_stage("Reusing existing NCOP infrastructure (airports/schools/settlements)")
    infra = fetch_existing_infrastructure_exposure(flood_zone_geom, bbox)

    # Overture stays the primary buildings source (confirmed live: ~34x
    # better coverage than OSM in this AOI). OSM only steps in if Overture
    # itself fails — network/S3/timeout — so the report still returns a
    # (degraded, clearly labelled) buildings figure instead of nothing.
    _report_stage("Fetching building exposure (Overture)")
    try:
        buildings = fetch_overture_buildings_exposure(catchment_key, bbox, flood_zone_geom, force=force)
        buildings["source"] = "overture"
    except Exception:
        logger.warning(
            "flood_exposure: Overture buildings fetch failed for %r - "
            "falling back to OSM (known lower coverage, ~34x fewer buildings confirmed live)",
            catchment_key, exc_info=True,
        )
        buildings = fetch_osm_buildings_fallback(bbox, flood_zone_geom)

    # Bridges + hospitals — genuinely new, Overture's own integration
    # never covered these (see methodology doc's "deferred" note).
    _report_stage("Fetching bridges & hospitals (OSM)")
    osm_infra = fetch_osm_bridges_hospitals_exposure(catchment_key, bbox, flood_zone_geom, force=force)

    # Road + drainage network — length-based exposure (km in the flood
    # zone), not point-based, since both are long linear features. See
    # fetch_road_network_exposure / fetch_drainage_network_exposure
    # docstrings: confirmed live these are the two most CPU-expensive
    # additions in this report (roads alone: ~40-80s), a real production
    # concern already flagged for the async-job design in Phase 1.6, not
    # a new one introduced here.
    _report_stage("Fetching road network (OSM)")
    roads = fetch_road_network_exposure(catchment_key, bbox, flood_zone_geom, force=force)
    _report_stage("Fetching drainage network (OSM)")
    drainage = fetch_drainage_network_exposure(catchment_key, bbox, flood_zone_geom, force=force)

    # Population/vulnerable-population (§0.9) — fast enough (1.6-7.4s
    # confirmed live) to call inline, no disk cache needed. Already
    # degrades to None internally on any GEE failure/timeout — never
    # raises, so it's called directly, not wrapped in a try/except here
    # (every other block above already follows this same "the fetch
    # function itself handles its own degradation" shape).
    _report_stage("Fetching population exposure (WorldPop)")
    # children_cutoff_age=15 — additive-only (see fetch_population_exposure's
    # own docstring): every existing field (total/under5/elderly/
    # elderly_cutoff_age/year) is computed exactly as before; this just
    # ALSO requests the male/female/children breakdown WorldPop's own
    # age-sex bands already carry, for both modes (fixed-threshold and
    # discharge-driven both call this same shared core).
    population = fetch_population_exposure(flood_zone_geom, children_cutoff_age=15)

    return {
        "flood_zone_km2": round(zone_km2, 3),
        "administrative_context": admin_context,
        "infrastructure": infra,
        "buildings": buildings,
        "osm_infrastructure": osm_infra,
        "roads": roads,
        "drainage": drainage,
        "population": population,
    }


def build_discharge_exposure_report(catchment_key, rainfall_mm, duration_hr, force=False, progress_callback=None):
    """Discharge-driven mode's own exposure report (§0.24) — the
    counterpart to build_exposure_report() for a rainfall/duration
    scenario instead of a fixed HAND threshold. Reuses
    _build_exposure_from_geom (the SAME shared core the fixed-threshold
    path uses, unmodified) fed a flood-zone geometry derived from
    flood_model.build_discharge_binary_mask instead of this module's own
    _binary_flood_mask — every other exposure computation (buildings,
    roads, drainage, population, admin tagging) is byte-for-byte the same
    code path either mode uses.

    `progress_callback`, if given, is called with a short human-readable
    stage name before each major step — same optional, additive contract
    build_exposure_report's own progress_callback already established."""
    from . import flood_model

    def _report_stage(name):
        if progress_callback:
            try:
                progress_callback(name)
            except Exception:
                logger.warning("flood_exposure: progress_callback raised (ignored)", exc_info=True)

    if catchment_key not in flood_model.PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(flood_model.PILOT_CATCHMENTS)}")
    if rainfall_mm <= 0 or duration_hr <= 0:
        raise ValueError("rainfall_mm and duration_hr must both be positive")
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    # Scenario-level cache (§0.25) — building blocks like Overture/OSM raw
    # fetches were already cached per-catchment (bbox-only, correctly
    # reused across scenarios), but admin-tagging's own district-boundary
    # intersection and the road/drainage NETWORK-LENGTH computation are
    # each real per-scenario work (confirmed live: ~3-30s each) that
    # re-running the SAME scenario twice redid from scratch every time.
    # This mode is explicitly a one-off, non-catalog run (see the
    # frontend's own note), so most scenarios are genuinely run once —
    # but an operator re-checking the same rainfall/duration (e.g.
    # re-opening the panel, or a second person running the same what-if)
    # now gets an instant cache hit instead of another 100+ seconds.
    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    scenario_key = f"r{rainfall_mm:g}_d{duration_hr:g}"
    exposure_cache_path = os.path.join(out_dir, f"discharge_exposure_{scenario_key}.json")

    if not force and os.path.exists(exposure_cache_path) and os.path.getsize(exposure_cache_path) > 0:
        try:
            with open(exposure_cache_path, "r") as f:
                cached = json.load(f)
            _report_stage("Vectorizing flood-prone zone")
            _report_stage("Tagging administrative context (district/tehsil)")
            _report_stage("Reusing existing NCOP infrastructure (airports/schools/settlements)")
            _report_stage("Fetching building exposure (Overture)")
            _report_stage("Fetching bridges & hospitals (OSM)")
            _report_stage("Fetching road network (OSM)")
            _report_stage("Fetching drainage network (OSM)")
            _report_stage("Fetching population exposure (WorldPop)")
            return cached
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning(
                "flood_exposure: discharge exposure cache %s unreadable (%s) — "
                "rebuilding this scenario from scratch instead of trusting a "
                "stale/corrupt cache entry",
                exposure_cache_path, exc,
            )

    # No stage markers for the HAND/discharge-computation work itself here
    # — build_discharge_driven_flood_zone (called internally by
    # build_discharge_binary_mask below) takes no progress_callback,
    # matching that function's own established shape. A caller building a
    # full scenario end-to-end (flood_model_views.py's job runner) marks
    # those two upstream stages itself BEFORE calling this function, so
    # the live checklist reflects that (usually the slowest) work as it
    # actually happens rather than all at once alongside "Vectorizing."
    mask_path = flood_model.build_discharge_binary_mask(catchment_key, rainfall_mm, duration_hr, force=force)

    _report_stage("Vectorizing flood-prone zone")
    with flood_model._gdal_lock():
        # No special-cased min_mapping_unit_px here (§0.24 originally
        # passed 0 explicitly; §0.25 made this unnecessary) —
        # _vectorize_flood_zone now measures live, for THIS mask, whether
        # its own default 9-pixel filter would discard too much real
        # area (confirmed for a discharge-driven mask: ~79%, over the
        # function's own 10% cap) and backs off to unfiltered
        # automatically. This call site no longer needs to know in
        # advance that its own mask is "thread-like" rather than
        # "blob-like" — the function figures that out per-mask.
        flood_zone_geom = _vectorize_flood_zone(mask_path)

    result = _build_exposure_from_geom(catchment_key, bbox, flood_zone_geom, force, _report_stage)

    # Standing regression safeguard (§0.25) — §0.24's own bug (a 5x area
    # discrepancy between the raster-based scenario area and the
    # vectorized exposure area) was caught only by a one-off manual
    # comparison during that session. This makes that comparison
    # permanent: every real discharge-exposure call now checks itself
    # against the already-computed, independently-derived raster-based
    # area (build_discharge_driven_flood_zone's own cell-count figure,
    # a cheap cache-hit here since that function already ran above) and
    # logs a loud warning — never raises, matching this module's own
    # "degrade, don't crash" convention — if the two diverge by more
    # than a stated tolerance. Confirmed live: a correctly-behaving
    # vectorization stays within ~3% of the raster figure across both
    # real catchments and three scenario scales; this check is
    # calibrated well above that real, observed noise floor.
    try:
        raster_payload = flood_model.build_discharge_driven_flood_zone(
            catchment_key, rainfall_mm=rainfall_mm, duration_hr=duration_hr, force=False,
        )
        raster_km2 = raster_payload["scenario"]["flood_zone_km2"]
        vector_km2 = result["flood_zone_km2"]
        if raster_km2 > 0:
            deviation = abs(vector_km2 - raster_km2) / raster_km2
            if deviation > _AREA_CONSISTENCY_TOLERANCE:
                logger.error(
                    "flood_exposure: VECTORIZATION CONSISTENCY CHECK FAILED for %r "
                    "rainfall=%.1fmm/%.0fh — raster-based area %.3f km2 vs. vectorized "
                    "exposure area %.3f km2 (%.1f%% deviation, over the %.0f%% tolerance). "
                    "This is the exact class of bug §0.24 found (a vectorization step "
                    "silently discarding real flood-prone area) — the exposure numbers "
                    "returned here should NOT be trusted without investigating why these "
                    "two independently-computed areas disagree.",
                    catchment_key, rainfall_mm, duration_hr, raster_km2, vector_km2,
                    deviation * 100, _AREA_CONSISTENCY_TOLERANCE * 100,
                )
    except Exception:
        # This safeguard must never be the reason a real exposure report
        # fails — a problem checking the check is logged and swallowed,
        # not propagated past the actual, already-computed result.
        logger.warning(
            "flood_exposure: area-consistency safeguard itself failed for %r "
            "(non-fatal — the exposure result above is still returned)",
            catchment_key, exc_info=True,
        )

    payload = {
        "catchment": catchment_key,
        "scenario": {"rainfall_mm": rainfall_mm, "duration_hr": duration_hr},
        **result,
    }

    tmp_cache = f"{exposure_cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_cache, exposure_cache_path)
    except OSError:
        # Caching is an optimization, not a correctness requirement — a
        # disk-write failure here must never turn an already-successful
        # exposure computation into a failed request.
        logger.warning(
            "flood_exposure: could not write discharge exposure cache for %r "
            "(non-fatal — this scenario will simply be recomputed next time)",
            catchment_key, exc_info=True,
        )

    return payload


def _tag_dominant_zone_per_admin_region(zone_geoms, bbox):
    """AHP-zonation counterpart to tag_administrative_context — instead
    of one flood-zone overlap percentage, computes each admin region's
    overlap against EVERY susceptibility zone and reports which one
    dominates, in the explicit sentence form requested (e.g. "Paharpur
    lies primarily in the high susceptibility zone (67.9% of its
    assessed area)."). Reuses _wfs_get_geojson and _geom_area_km2
    unchanged — the same district/tehsil fetch and area-computation
    tag_administrative_context itself uses, just intersected against 3
    geometries instead of 1."""
    from shapely.geometry import shape as shapely_shape

    results = []
    for layer, level in (("district_boundary", "district"), ("tehsil_boundary", "tehsil")):
        for feat in _wfs_get_geojson(layer, bbox):
            geom = shapely_shape(feat["geometry"])
            if not geom.is_valid:
                geom = geom.buffer(0)
            geom = geom.simplify(_ADMIN_BOUNDARY_SIMPLIFY_TOLERANCE_DEG, preserve_topology=True)

            overlaps_km2 = {}
            for zone_label, zone_geom in zone_geoms.items():
                inter = geom.intersection(zone_geom)
                if not inter.is_empty:
                    overlaps_km2[zone_label] = _geom_area_km2(inter)
            if not overlaps_km2:
                continue  # this region doesn't overlap the assessed area at all

            total_km2 = sum(overlaps_km2.values())
            dominant_zone = max(overlaps_km2, key=overlaps_km2.get)
            dominant_pct = round(100 * overlaps_km2[dominant_zone] / total_km2, 1) if total_km2 else None
            props = feat.get("properties", {})
            name = props.get("name") or level.title()

            results.append({
                "level": level,
                "name": props.get("name"),
                "district": props.get("district"),
                "province": props.get("province"),
                "dominant_zone": dominant_zone,
                "dominant_zone_pct": dominant_pct,
                "overlap_km2_by_zone": {k: round(v, 3) for k, v in overlaps_km2.items()},
                "sentence": (
                    f"{name} lies primarily in the {dominant_zone} susceptibility zone "
                    f"({dominant_pct if dominant_pct is not None else '?'}% of its assessed area)."
                ),
            })

    results.sort(key=lambda r: sum(r["overlap_km2_by_zone"].values()), reverse=True)
    return results


def _ahp_zone_roads_exposure(catchment_key, bbox, zone_geoms, force):
    """Roads, classified against all 3 AHP zones in ONE reprojection pass
    (_line_network_length_exposure_multizone) instead of once per zone —
    see that function's own docstring for the real, confirmed-live
    performance problem this fixes. Ensures osm_roads.json is warmed via
    the EXISTING fetch_road_network_exposure (called once, with an
    arbitrary zone geometry purely to trigger its own fetch-if-missing
    logic — its single-zone return value is discarded, only its cache
    side effect is used), then re-reads that same cache directly.

    Returns {zone_label: {"total_length_km", "length_in_flood_zone_km",
    "total_road_ways", "vehicular": {...same 3 keys...}}} — same shape
    every other mode's own roads block already uses, just one dict per
    zone instead of one dict overall."""
    any_zone_geom = next(iter(zone_geoms.values()))
    fetch_road_network_exposure(catchment_key, bbox, any_zone_geom, force=force)  # cache side effect only

    # §0.45 — a real, confirmed-live crash: fetch_road_network_exposure's
    # own "only cache a REAL, successful result" fix (its own comment
    # above) means a transient Overpass failure returns a valid in-
    # memory result for THAT call but deliberately does NOT write
    # osm_roads.json — correct for that function's own caller, but this
    # function only ever wanted the DISK cache (to avoid reprojecting
    # the same network 3x, once per zone — see this function's own
    # docstring), so an unconditional open() here crashed the whole AHP
    # job with a bare FileNotFoundError on a first-ever custom-AOI run
    # that happened to hit a transient Overpass hiccup (curated pilots
    # rarely hit this in practice — their caches have been warm for
    # months of testing; a custom AOI's own query is always cold).
    # Degrades the SAME way the underlying fetch already does for a
    # failed query (empty result for THIS call only, never a fabricated
    # cache) rather than crashing the whole zone exposure report over a
    # transient, retryable condition.
    cache_path = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key, "osm_roads.json")
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            cache_data = json.load(f)
    else:
        logger.warning(
            "flood_exposure: osm_roads.json still missing for %r after warming (a transient "
            "Overpass failure — see fetch_road_network_exposure's own comment) — using an "
            "empty road network for this zone-exposure report, not crashing the whole run",
            catchment_key,
        )
        cache_data = []

    all_result = _line_network_length_exposure_multizone(cache_data, zone_geoms, bbox)
    vehicular_data = [c for c in cache_data if c.get("highway") in _VEHICULAR_HIGHWAY_CLASSES]
    vehicular_result = _line_network_length_exposure_multizone(vehicular_data, zone_geoms, bbox)

    out = {}
    for label in zone_geoms:
        out[label] = {
            "total_length_km": all_result["total_length_km"],
            "length_in_flood_zone_km": all_result["by_zone"][label],
            "total_road_ways": len(cache_data),
            "vehicular": {
                "total_length_km": vehicular_result["total_length_km"],
                "length_in_flood_zone_km": vehicular_result["by_zone"][label],
                "total_road_ways": len(vehicular_data),
            },
        }
    return out


def _ahp_zone_drainage_exposure(catchment_key, bbox, zone_geoms, force):
    """Drainage counterpart to _ahp_zone_roads_exposure — same single-
    reprojection-pass fix, same "warm the existing cache once, re-read
    it directly" approach, generalized to drainage's own by_subtype
    breakdown (one multizone pass per subtype, not one pass per
    zone-times-subtype)."""
    any_zone_geom = next(iter(zone_geoms.values()))
    fetch_drainage_network_exposure(catchment_key, bbox, any_zone_geom, force=force)  # cache side effect only

    # §0.45 — same real, confirmed-live crash as _ahp_zone_roads_
    # exposure's own identical pattern (see its own comment for the
    # full account): fetch_drainage_network_exposure deliberately does
    # NOT write osm_drainage.json on a transient Overpass failure, so
    # this function's own unconditional open() crashed the whole AHP
    # job over a retryable condition — degrades to an empty drainage
    # network for THIS report instead.
    cache_path = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key, "osm_drainage.json")
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            cache_data = json.load(f)
    else:
        logger.warning(
            "flood_exposure: osm_drainage.json still missing for %r after warming (a "
            "transient Overpass failure — see fetch_drainage_network_exposure's own "
            "comment) — using an empty drainage network for this zone-exposure report, "
            "not crashing the whole run",
            catchment_key,
        )
        cache_data = []

    overall_result = _line_network_length_exposure_multizone(cache_data, zone_geoms, bbox)

    subtype_results = {}
    for subtype in {c.get("subtype") for c in cache_data}:
        subset = [c for c in cache_data if c.get("subtype") == subtype]
        subtype_results[subtype or "unknown"] = {
            "count": len(subset),
            "result": _line_network_length_exposure_multizone(subset, zone_geoms, bbox),
        }

    out = {}
    for label in zone_geoms:
        out[label] = {
            "total_length_km": overall_result["total_length_km"],
            "length_in_flood_zone_km": overall_result["by_zone"][label],
            "total_features": len(cache_data),
            "by_subtype": {
                subtype: {
                    "count": data["count"],
                    "total_length_km": data["result"]["total_length_km"],
                    "length_in_flood_zone_km": data["result"]["by_zone"][label],
                }
                for subtype, data in subtype_results.items()
            },
        }
    return out


def build_ahp_zone_exposure_report(catchment_key, lite=True, force=False, progress_callback=None):
    """AHP susceptibility mode's own exposure report — the same
    buildings/roads/drainage/population/admin-context breakdown every
    other mode's own exposure report already computes, but split by
    which of the 3 susceptibility zones (flood_model.
    build_ahp_zone_geometries) each feature falls in, instead of a
    single flood-zone-vs-not-flood-zone split.

    For buildings/schools/settlements/airports/bridges/hospitals/
    population, still reuses _build_exposure_from_geom's own underlying
    fetch functions once PER ZONE — proven cheap after the first call
    (every expensive fetch is disk-cached by CATCHMENT alone, and their
    own per-zone classification is a fast STRtree query / prep().
    intersects() / GEE reduceRegion, not a per-feature reprojection).

    **Roads and drainage do NOT use that same "call 3x" approach** — see
    _ahp_zone_roads_exposure/_ahp_zone_drainage_exposure's own
    docstrings for why: a first version of this function DID call
    _build_exposure_from_geom (and therefore the road/drainage fetch
    functions) 3x wholesale, and that was CONFIRMED LIVE to be a real
    problem specifically for AHP's own zones (which collectively cover
    close to the whole catchment, unlike every other mode's narrow flood
    extent) — chashma_indus's own report took 1082s (18 minutes) driven
    largely by the full road/drainage network being reprojected to UTM
    three times over, compounded by real Overpass read-timeouts. Fixed
    by reprojecting each line exactly once and classifying against all 3
    zones in that same pass.

    `progress_callback`, if given, is called with a short human-readable
    stage name before each major step — same optional, additive contract
    every other exposure report's own progress_callback already
    establishes."""
    from . import flood_model
    from shapely.geometry import shape as shapely_shape

    def _report_stage(name):
        if progress_callback:
            try:
                progress_callback(name)
            except Exception:
                logger.warning("flood_exposure: progress_callback raised (ignored)", exc_info=True)

    if catchment_key not in flood_model.PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(flood_model.PILOT_CATCHMENTS)}")
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    lite_tag = "lite" if lite else "full"
    exposure_cache_path = os.path.join(out_dir, f"ahp_zone_exposure_{lite_tag}.json")

    # No scenario dimension in the cache key — matches AHP's own static,
    # catchment-level nature (build_ahp_susceptibility_raster's own
    # docstring: every factor is terrain-static or a static climatology,
    # nothing scenario-dependent to key a cache on).
    if not force and os.path.exists(exposure_cache_path) and os.path.getsize(exposure_cache_path) > 0:
        try:
            with open(exposure_cache_path, "r") as f:
                cached = json.load(f)
            _report_stage("Building AHP susceptibility zones")
            for zone_label in ("low", "medium", "high"):
                _report_stage(f"Computing exposure for the {zone_label} susceptibility zone")
            _report_stage("Computing road & drainage exposure per zone")
            _report_stage("Tagging administrative context by dominant susceptibility zone")
            return cached
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning(
                "flood_exposure: AHP zone exposure cache %s unreadable (%s) — rebuilding "
                "from scratch instead of trusting a stale/corrupt cache entry",
                exposure_cache_path, exc,
            )

    _report_stage("Building AHP susceptibility zones")
    zones_result = flood_model.build_ahp_zone_geometries(catchment_key, lite=lite, force=force)
    zone_geoms = {
        feat["properties"]["zone_class"]: shapely_shape(feat["geometry"])
        for feat in zones_result["geojson"]["features"]
    }

    by_zone = {}
    for zone_label, zone_geom in zone_geoms.items():
        zone_km2 = _geom_area_km2(zone_geom)
        _report_stage(f"[{zone_label}] Reusing existing NCOP infrastructure (airports/schools/settlements)")
        infra = fetch_existing_infrastructure_exposure(zone_geom, bbox)

        _report_stage(f"[{zone_label}] Fetching building exposure (Overture)")
        try:
            buildings = fetch_overture_buildings_exposure(catchment_key, bbox, zone_geom, force=force)
            buildings["source"] = "overture"
        except Exception:
            logger.warning(
                "flood_exposure: Overture buildings fetch failed for %r zone %r - "
                "falling back to OSM (known lower coverage)",
                catchment_key, zone_label, exc_info=True,
            )
            buildings = fetch_osm_buildings_fallback(bbox, zone_geom)

        _report_stage(f"[{zone_label}] Fetching bridges & hospitals (OSM)")
        osm_infra = fetch_osm_bridges_hospitals_exposure(catchment_key, bbox, zone_geom, force=force)

        _report_stage(f"[{zone_label}] Fetching population exposure (WorldPop)")
        population = fetch_population_exposure(zone_geom, children_cutoff_age=15)

        by_zone[zone_label] = {
            "zone_km2": round(zone_km2, 3),
            "infrastructure": infra,
            "buildings": buildings,
            "osm_infrastructure": osm_infra,
            "population": population,
        }

    _report_stage("Computing road & drainage exposure per zone")
    roads_by_zone = _ahp_zone_roads_exposure(catchment_key, bbox, zone_geoms, force)
    drainage_by_zone = _ahp_zone_drainage_exposure(catchment_key, bbox, zone_geoms, force)
    for zone_label in zone_geoms:
        by_zone[zone_label]["roads"] = roads_by_zone[zone_label]
        by_zone[zone_label]["drainage"] = drainage_by_zone[zone_label]

    _report_stage("Tagging administrative context by dominant susceptibility zone")
    admin_zone_context = _tag_dominant_zone_per_admin_region(zone_geoms, bbox)

    payload = {
        "catchment": catchment_key,
        "lite": lite,
        "by_zone": by_zone,
        "administrative_zone_context": admin_zone_context,
    }

    tmp_cache = f"{exposure_cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_cache, exposure_cache_path)
    except OSError:
        logger.warning(
            "flood_exposure: could not write AHP zone exposure cache for %r "
            "(non-fatal — this will simply be recomputed next time)",
            catchment_key, exc_info=True,
        )

    return payload


# Vehicular-only, same convention _VEHICULAR_HIGHWAY_CLASSES already
# establishes for the exposure REPORT's own "vehicular" sub-figure —
# reused here for the MAP layer too, both because it is a real, useful
# filter (footpaths/tracks/steps are not what "roads exposed to
# flooding" means to an operator) and because it is the single biggest
# lever for keeping the roads map layer's own payload size bounded
# (confirmed live elsewhere in this module: an unfiltered network can
# reach 54,860 ways for one pilot catchment). CONFIRMED LIVE: the first
# cap tried (8000 ways) still produced a 2.2MB payload for nullah_lai
# (the worst-case pilot, 35,018 vehicular ways) — real, measured, not
# assumed safe just because the WAY COUNT looked bounded (the exact
# assumption that already broke once for the zone polygons themselves).
# Lowered to keep the roads layer comfortably under the SAME 1.5MB
# target build_ahp_zone_geometries' own self-adaptive backoff uses.
_MAP_LAYER_MAX_ROAD_WAYS = 4000

# Real, measured target for this function's own coordinate-precision/
# way-count reduction — matches the same "measure the real payload,
# don't assume a design decision was safe" discipline
# build_ahp_zone_geometries' own self-adaptive sieve/simplify already
# established after a real, confirmed 10MB-payload bug there.
_MAP_LAYER_COORD_DECIMALS = 5  # ~1.1m precision at Pakistan's latitudes — plenty for a display layer


def _zone_of_point(lon, lat, prepared_zones):
    """Returns the zone_class label of whichever prepared zone geometry
    contains (lon, lat), checked in a fixed Low->Medium->High order for
    determinism — or None if the point falls in none of them (a real,
    expected edge case: the 3 zone polygons are independently sieved/
    simplified per class, so they are not guaranteed to tessellate the
    catchment perfectly; a point landing in a resulting micro-gap is
    excluded from map rendering rather than mis-assigned to the wrong
    zone or crashing)."""
    from shapely.geometry import Point
    pt = Point(lon, lat)
    for label in ("low", "medium", "high"):
        prepared = prepared_zones.get(label)
        if prepared is not None and prepared.intersects(pt):
            return label
    return None


def _zone_of_line_midpoint(coords, prepared_zones):
    """Same idea as _zone_of_point but for a line feature — tags the
    WHOLE line by the zone containing its geometric midpoint, a simple,
    bounded-cost heuristic for a display/visualization layer (the
    precise length-in-each-zone figures already live in
    build_ahp_zone_exposure_report's own roads/drainage blocks — this
    is not used for any reported statistic, only map coloring)."""
    if len(coords) < 2:
        return None
    mid = coords[len(coords) // 2]
    return _zone_of_point(mid[0], mid[1], prepared_zones)


def build_ahp_zone_classified_map_layers(catchment_key, lite=True, force=False):
    """Real, on-the-map GeoJSON layers for AHP zone-classified exposure —
    the piece Sub-phase 4's own plan called for but that a later self-
    audit found was never actually built (only text/row COUNTS were;
    see the methodology doc's own post-launch remediation section).

    Returns {"points": FeatureCollection, "drainage": FeatureCollection,
    "roads": FeatureCollection} — three SEPARATE small artifacts, not
    one combined blob, so the frontend can load/toggle each
    independently and so a large roads layer never bloats the (already
    small, already cached) points/drainage ones.

    **Buildings are deliberately NOT included here** — up to 419K in a
    single catchment's AOI (confirmed real number, methodology doc's
    own zonation plan), a genuine crash risk to hand a browser as
    individual GeoJSON polygons. Aggregate zone counts (already in
    build_ahp_zone_exposure_report) remain the only buildings figure;
    individual-building rendering stays Sub-phase 5's own explicitly-
    deferred, viewport-bounded follow-on.

    **Points** (schools/settlements/airports via WFS, bridges/hospitals
    via the existing Overpass cache) — confirmed real counts across all
    4 pilot catchments are small (13-876 per type), safe to render
    directly with no simplification.

    **Roads** — filtered to `_VEHICULAR_HIGHWAY_CLASSES` (matching the
    exposure report's own "vehicular" sub-figure) and hard-capped at
    `_MAP_LAYER_MAX_ROAD_WAYS` (log + truncate, never crash, if a future
    catchment's road network is denser than any of the 4 pilots) — real
    payload size MEASURED live before shipping, not assumed safe just
    because the count looked bounded (the exact assumption that broke
    for the zone polygons themselves earlier this same investigation)."""
    from . import flood_model
    from shapely.prepared import prep

    if catchment_key not in flood_model.PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(flood_model.PILOT_CATCHMENTS)}")
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    lite_tag = "lite" if lite else "full"
    cache_path = os.path.join(out_dir, f"ahp_zone_map_layers_{lite_tag}.json")

    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        try:
            with open(cache_path, "r") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "flood_exposure: AHP zone map-layers cache %s unreadable (%s) — rebuilding "
                "from scratch instead of trusting a stale/corrupt cache entry",
                cache_path, exc,
            )

    from shapely.geometry import shape as shapely_shape

    zones_result = flood_model.build_ahp_zone_geometries(catchment_key, lite=lite, force=force)
    zone_geoms = {
        feat["properties"]["zone_class"]: shapely_shape(feat["geometry"])
        for feat in zones_result["geojson"]["features"]
    }
    prepared_zones = {label: prep(geom) for label, geom in zone_geoms.items()}

    def _round(v):
        return round(v, _MAP_LAYER_COORD_DECIMALS)

    # ---- Points: schools/settlements/airports (WFS) + bridges/hospitals (OSM cache) ----
    point_features = []

    for layer, feature_type in (("schools", "school"), ("settlements", "settlement"), ("airports", "airport")):
        for feat in _wfs_get_geojson(layer, bbox):
            geom = shapely_shape(feat["geometry"])
            centroid = geom.centroid
            zone = _zone_of_point(centroid.x, centroid.y, prepared_zones)
            if zone is None:
                continue
            props = feat.get("properties", {})
            point_features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [_round(centroid.x), _round(centroid.y)]},
                "properties": {
                    "feature_type": feature_type,
                    "name": props.get("name") or props.get("places") or props.get("school_name"),
                    "zone_class": zone,
                },
            })

    # Ensures osm_bridges_hospitals.json is warm (reuses the existing
    # fetch+cache function exactly like _ahp_zone_roads_exposure does for
    # roads — cache side effect only, single-zone return value discarded).
    #
    # Deliberately force=False here, NOT force=force — see the shared
    # comment on the drainage/roads warm-ups below for why: this
    # function's own job-runner caller always runs
    # build_ahp_zone_exposure_report() first (same osm_* caches, same
    # `force` flag), so by the time this runs the cache is already as
    # fresh as `force` demanded. Passing force=force here was a real,
    # confirmed double-fetch — a second live Overpass round-trip for data
    # the exposure report had just fetched moments earlier, wasted work
    # and extra exposure to Overpass's own real, observed read-timeouts.
    any_zone_geom = next(iter(zone_geoms.values()), None)
    if any_zone_geom is not None:
        fetch_osm_bridges_hospitals_exposure(catchment_key, bbox, any_zone_geom, force=False)
    bridges_hospitals_cache = os.path.join(out_dir, "osm_bridges_hospitals.json")
    if os.path.exists(bridges_hospitals_cache):
        with open(bridges_hospitals_cache) as f:
            bh_data = json.load(f)
        for feature_type, items in bh_data.items():
            for it in items:
                zone = _zone_of_point(it["lon"], it["lat"], prepared_zones)
                if zone is None:
                    continue
                point_features.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [_round(it["lon"]), _round(it["lat"])]},
                    "properties": {
                        "feature_type": feature_type[:-1] if feature_type.endswith("s") else feature_type,
                        "name": (it.get("tags") or {}).get("name"),
                        "zone_class": zone,
                    },
                })

    # ---- Drainage (small N — confirmed 49-876 across all 4 pilots, no simplification needed) ----
    # force=False deliberately — see the bridges/hospitals warm-up above;
    # this cache is already fresh from build_ahp_zone_exposure_report's
    # own _ahp_zone_drainage_exposure call earlier in the same job.
    drainage_features = []
    if any_zone_geom is not None:
        fetch_drainage_network_exposure(catchment_key, bbox, any_zone_geom, force=False)
    drainage_cache = os.path.join(out_dir, "osm_drainage.json")
    if os.path.exists(drainage_cache):
        with open(drainage_cache) as f:
            drainage_data = json.load(f)
        for c in drainage_data:
            pts = c.get("geometry")
            if not pts or len(pts) < 2:
                continue
            coords = [(p["lon"], p["lat"]) for p in pts]
            zone = _zone_of_line_midpoint(coords, prepared_zones)
            if zone is None:
                continue
            drainage_features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[_round(x), _round(y)] for x, y in coords]},
                "properties": {"subtype": c.get("subtype"), "zone_class": zone},
            })

    # ---- Roads (the real scale concern — vehicular-only + hard cap, measured not assumed) ----
    # force=False deliberately — see the bridges/hospitals warm-up above;
    # this cache is already fresh from build_ahp_zone_exposure_report's
    # own _ahp_zone_roads_exposure call earlier in the same job. A real
    # standalone force=True call to THIS function (rare — bypassing the
    # job runner) will still rebuild everything else fresh (zones via
    # build_ahp_zone_geometries above, and this function's own cache
    # file); only the shared raw Overpass/WFS caches stay whatever they
    # already are, matching the same tradeoff made for drainage/bridges.
    road_features = []
    if any_zone_geom is not None:
        fetch_road_network_exposure(catchment_key, bbox, any_zone_geom, force=False)
    roads_cache = os.path.join(out_dir, "osm_roads.json")
    if os.path.exists(roads_cache):
        with open(roads_cache) as f:
            roads_data = json.load(f)
        vehicular = [c for c in roads_data if c.get("highway") in _VEHICULAR_HIGHWAY_CLASSES]
        if len(vehicular) > _MAP_LAYER_MAX_ROAD_WAYS:
            logger.warning(
                "flood_exposure: AHP roads map layer for %r has %d vehicular ways, over the "
                "%d cap — truncating rather than shipping an unbounded payload (the exposure "
                "REPORT's own km-per-zone figures are unaffected, this only limits the MAP "
                "rendering)",
                catchment_key, len(vehicular), _MAP_LAYER_MAX_ROAD_WAYS,
            )
            vehicular = vehicular[:_MAP_LAYER_MAX_ROAD_WAYS]
        for c in vehicular:
            pts = c.get("geometry")
            if not pts or len(pts) < 2:
                continue
            coords = [(p["lon"], p["lat"]) for p in pts]
            zone = _zone_of_line_midpoint(coords, prepared_zones)
            if zone is None:
                continue
            road_features.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": [[_round(x), _round(y)] for x, y in coords]},
                "properties": {"highway": c.get("highway"), "zone_class": zone},
            })

    payload = {
        "points": {"type": "FeatureCollection", "features": point_features},
        "drainage": {"type": "FeatureCollection", "features": drainage_features},
        "roads": {"type": "FeatureCollection", "features": road_features},
    }

    # Real payload size measured and logged, not assumed — the exact
    # discipline that was missing the first time zone polygons were
    # built, added here from the start instead of after a crash-risk
    # payload was already shipped.
    sizes_kb = {k: len(json.dumps(v)) / 1024 for k, v in payload.items()}
    logger.info(
        "flood_exposure: AHP zone map layers for %r — points %.1fKB (%d), drainage %.1fKB (%d), "
        "roads %.1fKB (%d)",
        catchment_key, sizes_kb["points"], len(point_features), sizes_kb["drainage"], len(drainage_features),
        sizes_kb["roads"], len(road_features),
    )

    tmp_cache = f"{cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_cache, cache_path)
    except OSError:
        logger.warning(
            "flood_exposure: could not write AHP zone map-layers cache for %r "
            "(non-fatal — this will simply be recomputed next time)",
            catchment_key, exc_info=True,
        )

    return payload


# ---------------------------------------------------------------------------
# Sub-phase 5 — viewport-bounded buildings-on-zoom, the one piece of the
# AHP-zonation plan deliberately deferred out of Sub-phase 4 (see
# build_ahp_zone_classified_map_layers's own docstring above, and
# FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md §0.31/§0.33). Individual
# building footprints are a genuine crash risk shipped whole (up to 419K
# per catchment) — this instead serves only whatever small number of
# buildings sit inside the user's own current, zoomed-in map viewport.
#
# Real, measured constraint that shapes this section (not assumed): the
# existing per-catchment overture_buildings.json cache is 25-118MB on
# disk (nullah_lai 110MB, peshawar_bhudni_nullah 118MB, chashma_indus
# 25MB, guddu_indus 60MB — confirmed live). Re-parsing a file that size
# on every moveend during an interactive zoom session is not viable, so
# each catchment's buildings are parsed and indexed into a
# shapely.STRtree exactly ONCE per worker process (the same STRtree
# technique already proven live at 603,076-building scale in
# fetch_overture_buildings_exposure above), kept resident in memory,
# bounded to the _BUILDINGS_INDEX_MAX_ENTRIES most-recently-touched
# catchments (manual LRU) so a session that visits all 4 pilots doesn't
# grow memory unboundedly. Waitress is architecturally single-process
# (confirmed elsewhere in this app), so this in-process cache is the
# whole picture for this deployment, not a per-worker limitation.
# ---------------------------------------------------------------------------

_BUILDINGS_INDEX_LOCK = threading.Lock()
_BUILDINGS_INDEX_CACHE = {}  # {catchment_key: {"tree": STRtree, "geoms": [...], "touched_at": float}}
_BUILDINGS_INDEX_MAX_ENTRIES = 2
_BUILDINGS_INDEX_BUILD_TIMEOUT_SECONDS = 60  # parse+build only (no query) — well above the ~2.5s (1.9s parse + 0.6s build) already measured for 603k buildings in fetch_overture_buildings_exposure's own docstring
_BUILDINGS_INDEX_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="buildings-index-build")

_BUILDINGS_VIEWPORT_MAX_FEATURES = 3000  # same "log + truncate, never crash" posture as _MAP_LAYER_MAX_ROAD_WAYS


def _build_buildings_index_raw(catchment_key):
    """The actual parse+STRtree-build work, run through a bounded
    executor (see _get_cached_buildings_index) so a slow first build for
    one catchment can never hang a concurrent request for another.

    Reads the EXISTING overture_buildings.json cache directly — this
    deliberately does NOT call fetch_overture_buildings_exposure() or
    _fetch_overture_buildings_raw(): triggering a fresh ~225-270s
    Overture S3 fetch synchronously inside what's meant to be a fast,
    interactive viewport endpoint would defeat the entire point of this
    feature. By the time a user is looking at a COMPLETED AHP result
    (the only place this endpoint is reachable from), that cache is
    already guaranteed to exist — build_ahp_zone_exposure_report's own
    per-zone building fetch already warmed it during job execution.
    Returns None (never raises) if that cache isn't there yet."""
    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    cache_path = os.path.join(out_dir, "overture_buildings.json")
    if not (os.path.exists(cache_path) and os.path.getsize(cache_path) > 0):
        return None

    with open(cache_path) as f:
        buildings = json.load(f)

    import shapely.wkb as shapely_wkb
    from shapely import STRtree

    geoms = [shapely_wkb.loads(bytes.fromhex(b["wkb_hex"])) for b in buildings]
    tree = STRtree(geoms)
    return {"tree": tree, "geoms": geoms}


def _get_cached_buildings_index(catchment_key):
    """Lazy-build-once-per-process cache — see this section's own module
    comment above for the full "why". Bounded to
    _BUILDINGS_INDEX_MAX_ENTRIES catchments (manual LRU, evicts the
    least-recently-touched entry on overflow).

    Runs the actual parse+build through a dedicated single-worker
    executor + bounded future.result(timeout=...) — the same "external/
    heavy call must never hang the caller indefinitely" convention as
    _OVERTURE_EXECUTOR/_POPULATION_EXECUTOR above. Returns None (never
    raises) if the underlying buildings cache doesn't exist yet, or the
    build times out/fails for any reason."""
    with _BUILDINGS_INDEX_LOCK:
        entry = _BUILDINGS_INDEX_CACHE.get(catchment_key)
        if entry is not None:
            entry["touched_at"] = time.time()
            return entry

    future = _BUILDINGS_INDEX_EXECUTOR.submit(_build_buildings_index_raw, catchment_key)
    try:
        built = future.result(timeout=_BUILDINGS_INDEX_BUILD_TIMEOUT_SECONDS)
    except _FutureTimeoutError:
        logger.warning(
            "flood_exposure: buildings-index build for %r did not finish within %ss "
            "- degrading to no buildings-on-zoom for this request",
            catchment_key, _BUILDINGS_INDEX_BUILD_TIMEOUT_SECONDS,
        )
        return None
    except Exception:
        logger.warning(
            "flood_exposure: buildings-index build for %r failed - degrading to no "
            "buildings-on-zoom for this request",
            catchment_key, exc_info=True,
        )
        return None

    if built is None:
        return None

    built["touched_at"] = time.time()
    with _BUILDINGS_INDEX_LOCK:
        _BUILDINGS_INDEX_CACHE[catchment_key] = built
        if len(_BUILDINGS_INDEX_CACHE) > _BUILDINGS_INDEX_MAX_ENTRIES:
            oldest_key = min(_BUILDINGS_INDEX_CACHE, key=lambda k: _BUILDINGS_INDEX_CACHE[k]["touched_at"])
            if oldest_key != catchment_key:
                del _BUILDINGS_INDEX_CACHE[oldest_key]
                logger.info(
                    "flood_exposure: evicted buildings-index cache for %r (LRU, bound=%d)",
                    oldest_key, _BUILDINGS_INDEX_MAX_ENTRIES,
                )
    return built


def _polygon_geometry_to_geojson(geom, round_fn):
    """Polygon/MultiPolygon -> plain GeoJSON geometry dict with rounded
    coordinates — a real, expected shape for Overture building parts
    (most are Polygon, a real minority are MultiPolygon), handled
    properly rather than silently skipped."""
    if geom.geom_type == "Polygon":
        return {
            "type": "Polygon",
            "coordinates": [[[round_fn(x), round_fn(y)] for x, y in geom.exterior.coords]],
        }
    if geom.geom_type == "MultiPolygon":
        return {
            "type": "MultiPolygon",
            "coordinates": [
                [[[round_fn(x), round_fn(y)] for x, y in poly.exterior.coords]]
                for poly in geom.geoms
            ],
        }
    return None


def get_buildings_in_viewport(catchment_key, viewport_bbox, zone_geoms, max_features=_BUILDINGS_VIEWPORT_MAX_FEATURES):
    """Sub-phase 5's own core: individual Overture building footprints
    within a small, already-zoomed-in viewport bbox, zone-tagged the
    same way every other classified map layer already is (_zone_of_
    point, reused as-is on each building's own centroid — matches
    fetch_overture_buildings_exposure's own already-confirmed finding
    that a centroid approximation disagrees with the full-polygon test
    for only 2.3% of buildings; acceptable here for a display layer the
    way it was correctly judged NOT acceptable for that function's own
    reported aggregate COUNT).

    `viewport_bbox` is expected to already be clamped to the catchment's
    own bbox and sanity-checked for size by the caller (the view layer)
    — this function does the geometric work only, no request-level
    validation.

    Returns a GeoJSON FeatureCollection — an empty one (never raises) if
    the buildings index isn't built/available yet."""
    index = _get_cached_buildings_index(catchment_key)
    if index is None:
        return {"type": "FeatureCollection", "features": []}

    from shapely.geometry import box as shapely_box
    from shapely.prepared import prep

    viewport_geom = shapely_box(*viewport_bbox)
    candidate_idxs = index["tree"].query(viewport_geom, predicate="intersects")

    prepared_zones = {label: prep(geom) for label, geom in zone_geoms.items()}

    def _round(v):
        return round(v, _MAP_LAYER_COORD_DECIMALS)

    features = []
    truncated = False
    for i in candidate_idxs:
        geom = index["geoms"][i]
        centroid = geom.centroid
        zone = _zone_of_point(centroid.x, centroid.y, prepared_zones)
        if zone is None:
            continue
        geojson_geom = _polygon_geometry_to_geojson(geom, _round)
        if geojson_geom is None:
            continue
        features.append({
            "type": "Feature",
            "geometry": geojson_geom,
            "properties": {"zone_class": zone},
        })
        if len(features) >= max_features:
            truncated = True
            break

    if truncated:
        logger.warning(
            "flood_exposure: buildings-in-viewport for %r hit the %d-feature cap - "
            "truncating rather than shipping an unbounded payload (zoom in further "
            "for a complete view of a dense area)",
            catchment_key, max_features,
        )

    return {"type": "FeatureCollection", "features": features}


def build_riverine_exposure_report(catchment_key, force=False, progress_callback=None):
    """Riverine mode's own exposure report (§R4) — the counterpart to
    build_discharge_exposure_report for a live-gauge-driven flood zone
    instead of a rainfall/duration scenario. Reuses _build_exposure_from_
    geom (the SAME shared core every other mode uses, unmodified) fed a
    flood-zone geometry vectorized from flood_model.build_riverine_flood_
    zone's own binary mask — every other exposure computation (buildings,
    roads, drainage, population, admin tagging) is byte-for-byte the same
    code path every mode uses.

    No rainfall_mm/duration_hr scenario key here — riverine mode is
    driven by a live gauge reading, not a typed/fetched rainfall value, so
    caching is keyed on the gauge's own resolved height instead (via
    flood_model.build_riverine_flood_zone's own scenario_key convention,
    reconstructed here from its returned scenario dict — no second live
    network call needed).

    `progress_callback` — same optional, additive contract every other
    mode's own progress_callback already established."""
    from . import flood_model

    def _report_stage(name):
        if progress_callback:
            try:
                progress_callback(name)
            except Exception:
                logger.warning("flood_exposure: progress_callback raised (ignored)", exc_info=True)

    if catchment_key not in flood_model.PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(flood_model.PILOT_CATCHMENTS)}")
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    zone_payload = flood_model.build_riverine_flood_zone(catchment_key, force=force)
    gauge_height_m = zone_payload["scenario"]["gauge_height_m"]
    mask_path = zone_payload["mask_path"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    scenario_key = f"gauge{gauge_height_m:g}"
    exposure_cache_path = os.path.join(out_dir, f"riverine_exposure_{scenario_key}.json")

    if not force and os.path.exists(exposure_cache_path) and os.path.getsize(exposure_cache_path) > 0:
        try:
            with open(exposure_cache_path, "r") as f:
                cached = json.load(f)
            _report_stage("Vectorizing flood-prone zone")
            _report_stage("Tagging administrative context (district/tehsil)")
            _report_stage("Reusing existing NCOP infrastructure (airports/schools/settlements)")
            _report_stage("Fetching building exposure (Overture)")
            _report_stage("Fetching bridges & hospitals (OSM)")
            _report_stage("Fetching road network (OSM)")
            _report_stage("Fetching drainage network (OSM)")
            _report_stage("Fetching population exposure (WorldPop)")
            return cached
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning(
                "flood_exposure: riverine exposure cache %s unreadable (%s) — rebuilding "
                "this scenario from scratch instead of trusting a stale/corrupt cache entry",
                exposure_cache_path, exc,
            )

    _report_stage("Vectorizing flood-prone zone")
    with flood_model._gdal_lock():
        # Same self-adaptive filter as every other mode's own call site —
        # _vectorize_flood_zone measures live, per-mask, whether its
        # default filter would discard too much real area and backs off
        # automatically (§0.25); the connected-flood-fill mask's own
        # shape (a real, contiguous reach-following region, not scattered
        # thread-like clusters) has not been specifically characterized
        # against this filter yet — the adaptive guard is exactly the
        # safeguard that matters here regardless.
        flood_zone_geom = _vectorize_flood_zone(mask_path)

    result = _build_exposure_from_geom(catchment_key, bbox, flood_zone_geom, force, _report_stage)

    # Same area-consistency safeguard every other mode's own exposure
    # report already runs (§0.25) — cross-checks the vectorized exposure
    # area against the independently-computed raster cell-count area
    # (flood_model.build_riverine_flood_zone's own scenario, a cheap
    # cache-hit here since it already ran above).
    try:
        raster_km2 = zone_payload["scenario"]["flood_zone_km2"]
        vector_km2 = result["flood_zone_km2"]
        if raster_km2 > 0:
            deviation = abs(vector_km2 - raster_km2) / raster_km2
            if deviation > _AREA_CONSISTENCY_TOLERANCE:
                logger.error(
                    "flood_exposure: VECTORIZATION CONSISTENCY CHECK FAILED for %r "
                    "(riverine, gauge_height_m=%.2f) — raster-based area %.3f km2 vs. "
                    "vectorized exposure area %.3f km2 (%.1f%% deviation, over the %.0f%% "
                    "tolerance). The exposure numbers returned here should NOT be trusted "
                    "without investigating why these two independently-computed areas "
                    "disagree.",
                    catchment_key, gauge_height_m, raster_km2, vector_km2,
                    deviation * 100, _AREA_CONSISTENCY_TOLERANCE * 100,
                )
    except Exception:
        logger.warning(
            "flood_exposure: area-consistency safeguard itself failed for %r (riverine) "
            "(non-fatal — the exposure result above is still returned)",
            catchment_key, exc_info=True,
        )

    payload = {
        "catchment": catchment_key,
        "scenario": {"gauge_height_m": gauge_height_m},
        **result,
    }

    tmp_cache = f"{exposure_cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_cache, exposure_cache_path)
    except OSError:
        logger.warning(
            "flood_exposure: could not write riverine exposure cache for %r "
            "(non-fatal — this scenario will simply be recomputed next time)",
            catchment_key, exc_info=True,
        )

    return payload
