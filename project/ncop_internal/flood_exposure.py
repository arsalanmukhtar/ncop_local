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
# Generous, but bounded — confirmed live this fetch takes ~225s for one
# pilot-catchment bbox; NOT a per-request budget, a one-time-per-catchment
# background cost (see module docstring).
_OVERTURE_FETCH_TIMEOUT_SECONDS = 300
_OVERTURE_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="overture-fetch")
_overture_release_cache = None

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
# Overture) — confirmed live in §0.9's research this call takes 1.6-7.4s
# depending on geometry complexity, so 30s is generous headroom, not a
# tight budget. A dedicated single-worker executor (not a fresh one per
# call) both bounds wait time AND keeps this app from firing many
# concurrent Earth Engine calls against Google's own API quota at once —
# an API-quota-fairness reason, not a CPU one, but the same shape as
# _OVERTURE_EXECUTOR's own reasoning.
_POPULATION_TIMEOUT_SECONDS = 30
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


def _vectorize_flood_zone(mask_path):
    """gdal.Polygonize the binary mask (never touches gdal_array) into an
    in-memory OGR layer, keeps only the flood-prone (val=1) polygons, and
    dissolves them into a single shapely (Multi)Polygon via unary_union.
    Returns None if the catchment has no flood-prone cells at all (a
    legitimate, if unlikely, outcome — not an error).

    Two simplification passes, both confirmed necessary live (not
    speculative): raw Polygonize output for the Nullah Lai pilot produced
    2,720 disconnected single/few-pixel sliver polygons (72,522 total
    vertices) — a noisy HAND threshold boundary genuinely does look like
    that, it is not a bug. Intersecting a geometry that fragmented against
    a real district polygon (Rawalpindi's WFS boundary alone carries
    53,250 vertices) made a single shapely .intersection() call hang for
    minutes in this phase's own testing. Fixed by (1) dropping slivers
    below a minimum-mapping-unit of 9 pixels (a standard remote-sensing
    speckle-filter convention) BEFORE the dissolve, and (2) simplifying
    the dissolved result to ~1 pixel of tolerance — both cheap relative to
    the raster's own 30m resolution, neither changes the flood zone's real
    extent in any way a user could perceive."""
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

    min_area_deg2 = 9 * (pixel_size_deg ** 2)  # 9-pixel minimum mapping unit
    polys = []
    layer.ResetReading()
    for feat in layer:
        if feat.GetField("val") == 1:
            geom = feat.GetGeometryRef()
            if geom is not None:
                shp = shapely_wkb.loads(bytes(geom.ExportToWkb()))
                if shp.area >= min_area_deg2:
                    polys.append(shp)

    ds = None
    mem_ds = None

    if not polys:
        return None
    dissolved = unary_union(polys)
    # Polygonize can produce slivers with self-touching rings on a noisy
    # threshold boundary — buffer(0) is the standard shapely idiom to
    # repair that without changing the geometry's actual extent.
    if not dissolved.is_valid:
        dissolved = dissolved.buffer(0)
    dissolved = dissolved.simplify(pixel_size_deg, preserve_topology=True)
    return dissolved


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
        future = _OVERTURE_EXECUTOR.submit(_fetch_overture_buildings_raw, bbox)
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
        for i, (key, q) in enumerate(queries.items()):
            if i > 0:
                _time.sleep(1.5)  # polite spacing between sequential queries on a shared public instance
            result = _overpass_query(q)
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
        tmp_path = f"{cache_path}.tmp{os.getpid()}"
        with open(tmp_path, "w") as f:
            json.dump(cache_data, f)
        os.replace(tmp_path, cache_path)

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
        elements = result.get("elements", []) if result else []
        cache_data = [
            {"geometry": el["geometry"], "highway": (el.get("tags") or {}).get("highway")}
            for el in elements if el.get("geometry") and len(el["geometry"]) >= 2
        ]
        tmp_path = f"{cache_path}.tmp{os.getpid()}"
        with open(tmp_path, "w") as f:
            json.dump(cache_data, f)
        os.replace(tmp_path, cache_path)

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


def _fetch_population_raw(flood_zone_geom, elderly_cutoff_age):
    """The actual Earth Engine call — always run through the bounded
    executor below, never called directly, matching every other external
    call in this module."""
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

    combined = ee.Image.cat([total, under5, elderly])
    return combined.reduceRegion(
        reducer=ee.Reducer.sum(), geometry=ee_geom, scale=100, maxPixels=1e9,
    ).getInfo()


def fetch_population_exposure(flood_zone_geom, elderly_cutoff_age=65):
    """Population, under-5, and elderly (>=elderly_cutoff_age) counts
    inside the flood-prone zone — confirmed live in §0.9's research
    against this exact pilot: 425,116 / 47,137 / 16,759, a figure that
    cross-checked almost exactly against the buildings (~13%) and area
    (~13%) exposure fractions found elsewhere in this pipeline.

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
    future = _POPULATION_EXECUTOR.submit(_fetch_population_raw, flood_zone_geom, elderly_cutoff_age)
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

    return {
        "total": round(stats.get("total") or 0),
        "under5": round(stats.get("under5") or 0),
        "elderly": round(stats.get("elderly") or 0),
        "elderly_cutoff_age": elderly_cutoff_age,
        "year": _WORLDPOP_YEAR,
    }


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
        elements = result.get("elements", []) if result else []
        cache_data = [
            {"geometry": el["geometry"], "subtype": (el.get("tags") or {}).get("waterway")}
            for el in elements if el.get("geometry") and len(el["geometry"]) >= 2
        ]
        tmp_path = f"{cache_path}.tmp{os.getpid()}"
        with open(tmp_path, "w") as f:
            json.dump(cache_data, f)
        os.replace(tmp_path, cache_path)

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

    _report_stage("Vectorizing flood-prone zone")
    with flood_model._gdal_lock():
        flood_zone_geom = _vectorize_flood_zone(mask_path)

    if flood_zone_geom is None or flood_zone_geom.is_empty:
        return {
            "catchment": catchment_key,
            "threshold_m": threshold_m,
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
    population = fetch_population_exposure(flood_zone_geom)

    return {
        "catchment": catchment_key,
        "threshold_m": threshold_m,
        "flood_zone_km2": round(zone_km2, 3),
        "administrative_context": admin_context,
        "infrastructure": infra,
        "buildings": buildings,
        "osm_infrastructure": osm_infra,
        "roads": roads,
        "drainage": drainage,
        "population": population,
    }
