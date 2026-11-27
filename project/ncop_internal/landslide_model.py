# project/ncop_internal/landslide_model.py
# ---------------------------------------------------------------------------
# Landslide Early Warning & Susceptibility — Phase L0/L1 foundation.
# See LANDSLIDE_EARLY_WARNING_METHODOLOGY.md (repo root) for the full,
# literature-backed plan this file implements piece by piece — every
# design decision below traces back to a specific §-numbered section
# there, not invented here.
#
# Mirrors flood_model.py's own role for this hazard (§5 of the
# methodology doc: "one hazard-specific module per hazard, sharing the
# generic fusion primitives" — flood_ahp.py sits alongside flood_model.py
# the same way landslide_ahp.py will sit alongside this file, not inside
# it). This module owns landslide's own PILOT_CATCHMENTS-equivalent
# registry and the landslide-specific factor fetches (geology/PGA) that
# have no flood analogue; everything reusable (DEM/HAND/TWI pipeline,
# AHP fusion engine, gap-free vectorization, exposure, AUC validation)
# is imported from the existing flood_* modules directly, per the
# methodology doc's own §1 reuse table — not reimplemented here.
#
# Status: Phase L1. PILOT_CATCHMENTS holds the one pilot entry. §13's
# L0 checklist (geology/PGA fetch+rasterize) is done and live-tested;
# this file now also builds every remaining L1 factor (aspect,
# distance-to-road, the geology/PGA hazard reclassification, landslide-
# specific LULC/soil reclassification) and wires them into
# build_landslide_susceptibility_raster() via landslide_ahp.py's
# CR-validated weight table.
#
# Production-readiness note (methodology doc §12, checked against the
# real live nginx conf): every function in this file is a plain library
# call — nothing here is wired to an HTTP endpoint yet (that's Phase
# L5). build_landslide_susceptibility_raster() alone can genuinely take
# minutes on a cold cache (a real DEM fetch + WhiteboxTools pipeline +
# several external fetches) — it must NEVER be called synchronously
# from a request handler once L5 wires it up; the async job pattern
# (§9/§12) is not optional for that endpoint, the same real lesson
# flood's own rainfall-fetch bug already taught this project once.
# Every external call already made here is independently bounded
# (flood_model._run_wbt's own _WBT_TIMEOUT_SECONDS, flood_exposure.
# _overpass_query's own retry/timeout, this file's own
# _GEOLOGICAL_WFS_TIMEOUT_SECONDS) — no new unbounded call is
# introduced.
# ---------------------------------------------------------------------------

import json
import logging
import math
import os
import threading

import numpy as np
from django.conf import settings

from . import flood_connectivity, flood_exposure, flood_model

logger = logging.getLogger(__name__)

_LANDSLIDE_MEDIA_SUBDIR = "landslide_model"

# ---------------------------------------------------------------------------
# Pilot catchment registry
# ---------------------------------------------------------------------------
# Same shape as flood_model.PILOT_CATCHMENTS entries (bbox + label), plus
# a "hazard" discriminator this dict's own consumers can branch on (there
# is only ever one hazard's worth of entries in THIS dict, but the field
# is added defensively — matches this module's own honest, non-flood
# framing rather than silently borrowing flood's "flood_type" field for
# a hazard it doesn't describe).
#
# Murree/Galyat corridor bbox — pinned per §13/L0 of the methodology doc,
# covering Murree town through the Nathiagali/Ayubia (Galyat) hill
# corridor. Built from known town coordinates (Murree ~33.907N 73.394E,
# Bhurban ~33.930N 73.373E, Ayubia ~34.017N 73.400E, Nathiagali
# ~34.067N 73.383E) with margin — NOT yet confirmed against the real
# rendered geology/PGA rasters. That confirmation IS this file's own
# first test (see the module-level self-check note below) — if the
# bbox is meaningfully off, the rasterized output will show it (empty
# or clearly-wrong formation/zone coverage), not silently succeed.
PILOT_CATCHMENTS = {
    "murree_galyat": {
        "label": "Murree — Galyat Corridor (Rawalpindi/Abbottabad)",
        "hazard": "landslide",
        "bbox": [73.25, 33.80, 73.55, 34.10],  # [minLon, minLat, maxLon, maxLat], EPSG:4326
        # Live-confirmed (L2's own real administrative_context result:
        # Rawalpindi 51.8%/Abbottabad 48.2% overlap of the high zone) —
        # the one entry below with an actually-verified pair, not a
        # best-effort guess like the new catchments' own district_names.
        "district_names": ["Rawalpindi", "Abbottabad"],
    },
    # ---- Added to cover more of Pakistan's real landslide-frequent
    # regions, per explicit instruction — every bbox below is built the
    # SAME way Murree/Galyat's own was (known town/valley coordinates,
    # margin-padded, honestly NOT independently surveyed — the live
    # rasterized geology/PGA/DEM output is each one's own real
    # confirmation, same as it was for Murree/Galyat at L0), and every
    # one is grounded in a REAL, session-confirmed literature source, not
    # picked without one. All under MAX_CATCHMENT_BBOX_DEG2's own 0.30
    # deg^2 cap (flood_model.py).
    "astore": {
        "label": "Astore Valley (Gilgit-Baltistan)",
        "hazard": "landslide",
        # Astore town ~35.34N 74.90E. Real AHP susceptibility literature
        # confirmed this session (§3.3/§0.1's own Astore-paper research);
        # also one of NDMA's own currently-named landslide-vulnerable
        # areas (§3.6's own live-advisory finding), not just an academic
        # pick.
        "bbox": [74.65, 35.15, 75.00, 35.55],
        # Best-effort, NOT independently confirmed against a live NWFC
        # report the way Murree/Galyat's own pair was — the district's
        # own real name, matching NWFC's own likely reporting unit.
        "district_names": ["Astore"],
    },
    "chitral_reshun": {
        "label": "Chitral / Reshun (Khyber Pakhtunkhwa)",
        "hazard": "landslide",
        # Reshun ~35.87N 71.75E, Chitral town ~35.85N 71.79E. Real
        # Frequency-Ratio susceptibility literature confirmed this
        # session (§3.4/§5's own Chitral/Reshun FR citation) — the
        # project's own named candidate for a future FR-fusion pilot,
        # not AHP/WoE like Murree/Galyat.
        "bbox": [71.55, 35.68, 71.95, 36.05],
        "district_names": ["Chitral"],  # best-effort, same caveat as Astore's own above
    },
    "hunza_nagar_karakoram": {
        "label": "Hunza-Nagar / Karakoram Highway Corridor (Gilgit-Baltistan)",
        "hazard": "landslide",
        # Karimabad/Hunza ~36.32N 74.65E, Nagar ~36.25N 74.75E, extending
        # toward the Batura Glacier area (~36.5N 74.5E). Real, direct,
        # multiply-confirmed literature this session: SBAS-InSAR
        # Karakoram Highway susceptibility mapping (§3.3), KKH rockfall/
        # debris-flow RHRS studies (§3.8), and — most directly — the
        # Hunza/Batura Glacier avalanche-AHP study (§3.8) whose own
        # factor selection avalanche_model.py already mirrors. Already
        # this project's own named L6 second-pilot corridor (§10) —
        # registering it here is real prep work for that phase, not
        # scope creep.
        "bbox": [74.55, 36.15, 74.95, 36.55],
        # Reuses flood_model.py's own already-established "Hunza"
        # district name for this exact corridor (its own Hunza-Nagar
        # flood pilot entry) rather than picking a new one independently.
        "district_names": ["Hunza"],
    },
    "ajk_muzaffarabad": {
        "label": "Muzaffarabad District (Azad Jammu & Kashmir)",
        "hazard": "landslide",
        # Muzaffarabad ~34.37N 73.47E. Real, direct literature confirmed
        # this session: a dedicated integrated-approach Muzaffarabad
        # susceptibility study, a Bagh District (AJK) hazard map, and —
        # most significant — the real 2005-Kashmir-earthquake landslide
        # inventory (2,252 landslides, ASTER-mapped, §3.6) centered on
        # exactly this district. The strongest independent ground-truth
        # candidate of any catchment in this registry, once that
        # inventory is integrated (§7's own "real future work" note).
        "bbox": [73.35, 34.25, 73.65, 34.55],
        "district_names": ["Muzaffarabad"],  # best-effort, same caveat as Astore's own above
    },
    "besham_chilas_kkh": {
        "label": "Besham-Chilas Corridor, Karakoram Highway (KP/Gilgit-Baltistan)",
        "hazard": "landslide",
        # A representative segment (centered near Dasu/Sazin, ~35.3N
        # 73.35E) of the real, directly-studied Besham-Chilas KKH
        # corridor (§3.8's own RHRS rockfall/debris-flow citations) —
        # NOT the full ~150km studied extent, which exceeds
        # MAX_CATCHMENT_BBOX_DEG2's own cap by a wide margin. Honestly a
        # sub-segment pick, not the whole corridor those papers cover —
        # named explicitly, not silently implied to be the full studied
        # area.
        "bbox": [73.20, 35.15, 73.55, 35.50],
        "district_names": ["Kohistan"],  # best-effort, same caveat as Astore's own above
    },
    # NOT yet added, honestly named rather than silently omitted: Diamer,
    # Darel, and Tangir — three of NDMA's own currently-named landslide-
    # vulnerable districts (§3.6) — have no catchment-specific academic
    # literature this session could confirm live (unlike the five
    # above), so no bbox is asserted for them yet rather than guessing
    # coordinates without a real source to anchor them.
}


# Derived-output cache version. Every landslide builder caches on file
# existence alone, so a change to a crosswalk table (e.g. §L7's national
# geology groups) would otherwise never reach an already-built catchment.
# Bumping this invalidates every DERIVED raster/sidecar in a catchment's
# landslide_model/ directory once, the first time that catchment is
# touched in a process; raw external fetches (geology/PGA WFS rasters and
# legends, aspect, distance-to-road, LULC/soil reclass) are kept because
# none of them depend on the tables that change between versions.
_DERIVED_CACHE_VERSION = 2
_DERIVED_CACHE_KEEP = frozenset({
    "geology.tif", "geology_legend.json", "pga_zones.tif", "pga_zones_legend.json",
    "aspect_deg.tif", "distance_road_km.tif", "lulc_hazard.tif", "soil_hazard.tif",
    "_cache_version.json",
})
_DERIVED_CACHE_CHECKED = set()
_DERIVED_CACHE_LOCK = threading.Lock()


def _ensure_derived_cache_version(catchment_key):
    with _DERIVED_CACHE_LOCK:
        if catchment_key in _DERIVED_CACHE_CHECKED:
            return
        out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
        stamp_path = os.path.join(out_dir, "_cache_version.json")
        current = None
        if os.path.exists(stamp_path):
            try:
                with open(stamp_path) as f:
                    current = json.load(f).get("version")
            except (OSError, ValueError):
                current = None
        if os.path.isdir(out_dir) and current != _DERIVED_CACHE_VERSION:
            removed = 0
            for name in os.listdir(out_dir):
                path = os.path.join(out_dir, name)
                if name in _DERIVED_CACHE_KEEP or not os.path.isfile(path):
                    continue
                try:
                    os.remove(path)
                    removed += 1
                except OSError:
                    logger.warning("landslide_model: could not remove stale cache file %s", path, exc_info=True)
            logger.info(
                "landslide_model: derived cache for %r was version %r, now %d - removed %d stale files",
                catchment_key, current, _DERIVED_CACHE_VERSION, removed,
            )
        os.makedirs(out_dir, exist_ok=True)
        tmp = f"{stamp_path}.tmp{os.getpid()}"
        with open(tmp, "w") as f:
            json.dump({"version": _DERIVED_CACHE_VERSION}, f)
        os.replace(tmp, stamp_path)
        _DERIVED_CACHE_CHECKED.add(catchment_key)


def ensure_registered_with_flood_model(catchment_key):
    """`flood_model.build_hand_pipeline` (and every other flood_model.py
    function keyed by catchment) validates against flood_model's OWN
    module-level PILOT_CATCHMENTS dict, not a parameter — there is no
    other way to make it accept a landslide catchment key without
    editing flood_model.py itself, which this integration deliberately
    never does (methodology doc §0/§9: reuse the existing functions
    unmodified).

    This is the SAME runtime-registration pattern flood_model.py's own
    register_custom_aoi already establishes for custom AOIs — adding one
    dict entry at call time, not a new mechanism. Deliberately
    setdefault, not overwrite: flood_model's own dict is authoritative
    once an entry exists there (e.g. if a future change gives it a
    richer, DEM-pipeline-specific shape for this same key).

    Landslide catchment keys are NOT surfaced in flood's own frontend
    catchment dropdown (a hardcoded, curated list in flood-model-
    control.js, confirmed not a live dump of this dict) and are never
    submitted through FloodModelRunView (a genuinely separate endpoint
    per methodology doc §9/§12) — the one, minor, accepted cosmetic
    side effect is that a landslide catchment key would appear in that
    view's own "unknown catchment, known: [...]" error-message listing
    if someone submitted a malformed flood request. Not a functional or
    security concern; named here rather than left implicit.

    A CUSTOM AOI key (from register_custom_landslide_aoi, which reuses
    flood_model.register_custom_aoi directly) is ALREADY a complete,
    clip_polygon-carrying entry in flood_model.PILOT_CATCHMENTS by the
    time any landslide function calls this — checked FIRST, before the
    curated-pilot lookup, so a custom key correctly short-circuits here
    with nothing more to do, rather than raising "Unknown landslide
    catchment" for a key that was never meant to be in this module's own
    curated PILOT_CATCHMENTS dict at all."""
    _ensure_derived_cache_version(catchment_key)
    if catchment_key in flood_model.PILOT_CATCHMENTS:
        return
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown landslide catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]
    flood_model.PILOT_CATCHMENTS[catchment_key] = {
        "label": cfg["label"],
        "bbox": cfg["bbox"],
        "flood_type": "flash",  # flood_model.py's own dispatch needs SOME value here; landslide code never reads it
        # district_names - used only by flood_forecast.fetch_live_observed_
        # rainfall (L4) to match this catchment against NWFC's daily
        # rainfall report, same convention as every flood pilot's own
        # entry (e.g. nullah_lai's "district_names" comment in
        # flood_model.py) - read from each catchment's OWN config now
        # (see each entry's own comment above for which are live-
        # confirmed vs. best-effort), not one hardcoded pair reused for
        # every catchment.
        "district_names": cfg.get("district_names", []),
    }


def register_custom_landslide_aoi(bbox, polygon_geojson=None):
    """Landslide's own custom-AOI entry point (user-drawn or uploaded-
    shapefile/KML area, not one of the curated catchments above) —
    reuses flood_model.register_custom_aoi DIRECTLY rather than
    reimplementing it: bbox validation (_validate_catchment_bbox),
    content-addressed key hashing (so drawing/uploading the same area
    twice reuses the same cache instead of a fresh cold build each
    time), clip_polygon storage, and cache pruning are all already
    fully generic, hazard-agnostic logic — confirmed by direct read of
    that function, not assumed.

    `flood_type` is fixed to "flash" purely to satisfy flood_model.
    build_hand_pipeline's own dispatch parameter — landslide code never
    reads this field, same as every curated landslide catchment's own
    registration above.

    The uploaded-shapefile/KML path itself needs ZERO new backend code
    either: NcopShapefileUploadView/NcopKmzUploadView (views.py) are
    already generic vector-file-to-GeoJSON converters, not flood-
    specific — a landslide frontend draw/upload tool calls the SAME
    existing `/upload-shapefile/`/`/upload-kmz/` endpoints flood's own
    already does, then passes the resulting polygon geometry here
    exactly like it would to flood_model.register_custom_aoi.

    Returns the SAME catchment_key shape flood's own custom AOIs use
    (e.g. "custom_3f9a1c2b7e8d4a10") — every landslide_model.py function
    already accepts it unchanged via ensure_registered_with_flood_
    model's own "already in flood_model.PILOT_CATCHMENTS" fast path
    above. Raises ValueError for a malformed/oversized bbox, matching
    flood's own convention exactly (caught by the view layer)."""
    return flood_model.register_custom_aoi(bbox, flood_type="flash", polygon_geojson=polygon_geojson)


# ---------------------------------------------------------------------------
# Geology / PGA factors — the two NCOP layers confirmed live in
# frontend/src/modules/map-layers.js (methodology doc §4), never fetched
# by flood. A DIFFERENT GeoServer instance from flood_exposure.py's own
# _GCOP_WFS_HOST/_GCOP_WFS_WORKSPACE (172.18.7.35:8080/gcop) — geology/
# pga_zones live on 172.18.7.21:8080/geological_global, confirmed
# directly from that layer config's own TMS tile URLs. A new, small,
# parameterized fetch helper, not a reuse of flood_exposure._wfs_get_
# geojson (which hardcodes the OTHER host/workspace) — same technique,
# different server.
# ---------------------------------------------------------------------------

_GEOLOGICAL_WFS_HOST = "172.18.7.21:8080"
_GEOLOGICAL_WFS_WORKSPACE = "geological_global"
_GEOLOGICAL_WFS_TIMEOUT_SECONDS = 30  # matches flood_exposure._WFS_TIMEOUT_SECONDS's own bounded-external-call convention

# Real, confirmed field names (methodology doc §4) — CORRECTED live
# during L0's own testing, not assumed: geology's own "name" property
# (what map-layers.js's frontend styling keys off, and what the
# methodology doc originally assumed for rasterization too) has REAL
# gaps — a live WFS fetch for the Murree/Galyat bbox returned several
# features whose "name" is literally the string "No" despite carrying
# distinct, real "code" values (e.g. "Tk", "Pc" — "Tk" plausibly the
# Kuldana Formation code, matching the Murree/Kuldana Formation context
# §3.3's own literature already confirmed). "code" is populated on
# EVERY feature fetched, "name" is not — code is the reliable
# rasterization key; name is kept as a secondary, human-readable label
# where it's actually meaningful, not the join key. pga_zones' own
# "pga" property is confirmed complete (5 real values, "Zone 1"
# .."Zone 4"/"Zone 2A"/"Zone 2B") — no equivalent issue found there.
GEOLOGY_LAYER = "geology"
GEOLOGY_ATTR_FIELD = "code"
GEOLOGY_LABEL_FIELD = "name"  # human-readable, real but incomplete — legend enrichment only, never the rasterization key
PGA_ZONES_LAYER = "pga_zones"
PGA_ZONES_ATTR_FIELD = "pga"


def _wfs_get_geojson_geological(layer, bbox, workspace=_GEOLOGICAL_WFS_WORKSPACE):
    """Same technique as flood_exposure._wfs_get_geojson (WFS 2.0.0
    GetFeature, bbox-filtered, GeoJSON output) against the geological_
    global GeoServer workspace instead of gcop. Same graceful-
    degradation convention: a fetch failure logs a warning and returns
    an empty list, never raises past this function — a landslide
    factor that can't be fetched right now degrades that ONE factor,
    it doesn't crash whatever's building the susceptibility raster."""
    import requests

    minx, miny, maxx, maxy = bbox
    url = (
        f"http://{_GEOLOGICAL_WFS_HOST}/geoserver/{workspace}/ows"
        f"?service=WFS&version=2.0.0&request=GetFeature"
        f"&typeNames={workspace}:{layer}&outputFormat=application/json"
        f"&bbox={minx},{miny},{maxx},{maxy},EPSG:4326"
    )
    try:
        resp = requests.get(url, timeout=_GEOLOGICAL_WFS_TIMEOUT_SECONDS)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        logger.warning(
            "landslide_model: WFS fetch failed for layer %r (degraded — treated as empty)",
            layer, exc_info=True,
        )
        return []
    return data.get("features", []) or []


def _rasterize_categorical_wfs_layer(layer, attr_field, bbox, out_path, pixel_size_deg=0.001, label_field=None):
    """Fetches `layer` for `bbox` and rasterizes it onto a fresh,
    standalone WGS84 grid (bbox + pixel_size_deg — NOT yet aligned to
    the DEM/HAND grid; that alignment happens in Phase L1 when this
    gets combined with the other factor rasters, per the methodology
    doc's own §13 L0/L1 split — L0's own job is just proving the
    fetch+rasterize technique works against the real server, cheaply
    and independently of the slower DEM/HAND pipeline).

    Each distinct value of `attr_field` (e.g. one of geology's 40 real
    formation names) becomes its own integer class, burned via a
    separate gdal.RasterizeLayer pass per class — the same
    RasterizeLayer technique flood_model._clip_array_to_polygon already
    uses, looped per-class since GDAL's own ATTRIBUTE= burn option
    needs a numeric OGR field already present, which WFS GeoJSON
    features don't carry for a string attribute like this.

    Returns (out_path, legend) where legend maps {class_int:
    attribute_value_string}, or (None, {}) if the fetch returned no
    features (a real, honest "nothing here" result — e.g. a bbox
    that doesn't intersect this layer at all — not an error)."""
    from osgeo import gdal, ogr, osr

    features = _wfs_get_geojson_geological(layer, bbox)
    if not features:
        logger.warning(
            "landslide_model: no %r features returned for bbox=%r — nothing to rasterize",
            layer, bbox,
        )
        return None, {}

    values = sorted({
        str((feat.get("properties") or {}).get(attr_field))
        for feat in features
        if (feat.get("properties") or {}).get(attr_field) is not None
    })
    value_to_class = {v: i + 1 for i, v in enumerate(values)}  # 0 reserved for nodata/no-class

    # Legend enrichment: pair each attr_field value with the first real
    # (non-empty, not the string "No") label_field value found for it —
    # a real gap confirmed live for geology's own "name" property (§4
    # correction above), not assumed complete. Falls back to the raw
    # attr_field value itself when no meaningful label exists, so the
    # legend is never missing an entry, just sometimes less readable.
    label_by_value = {}
    if label_field:
        for feat in features:
            props = feat.get("properties") or {}
            v, label = props.get(attr_field), props.get(label_field)
            if v is None or str(v) not in value_to_class:
                continue
            v = str(v)
            if v not in label_by_value and label and str(label).strip().lower() not in ("no", "none", ""):
                label_by_value[v] = str(label)
    legend = {
        class_int: {"value": v, "label": label_by_value.get(v, v)}
        for v, class_int in value_to_class.items()
    }

    minx, miny, maxx, maxy = bbox
    w = max(1, int(round((maxx - minx) / pixel_size_deg)))
    h = max(1, int(round((maxy - miny) / pixel_size_deg)))
    gt = (minx, pixel_size_deg, 0, maxy, 0, -pixel_size_deg)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    proj = srs.ExportToWkt()

    with flood_model._gdal_lock():
        out_ds = gdal.GetDriverByName("GTiff").Create(out_path, w, h, 1, gdal.GDT_Byte)
        if out_ds is None:
            raise RuntimeError(f"gdal driver.Create failed for {out_path}")
        out_ds.SetGeoTransform(gt)
        out_ds.SetProjection(proj)
        band = out_ds.GetRasterBand(1)
        band.SetNoDataValue(0)
        band.Fill(0)

        for value, class_int in value_to_class.items():
            mem_vec_ds = ogr.GetDriverByName("Memory").CreateDataSource("")
            mem_layer = mem_vec_ds.CreateLayer("class_subset", srs=srs, geom_type=ogr.wkbMultiPolygon)
            for feat in features:
                props = feat.get("properties") or {}
                if str(props.get(attr_field)) != value:
                    continue
                geom = ogr.CreateGeometryFromJson(json.dumps(feat["geometry"]))
                if geom is None:
                    continue
                ogr_feat = ogr.Feature(mem_layer.GetLayerDefn())
                ogr_feat.SetGeometry(geom)
                mem_layer.CreateFeature(ogr_feat)
                ogr_feat = None
            gdal.RasterizeLayer(out_ds, [1], mem_layer, burn_values=[class_int])
            mem_vec_ds = None

        band.FlushCache()
        out_ds = None

    return out_path, legend


def fetch_and_rasterize_geology_pga(catchment_key, force=False):
    """L0's own first real, testable deliverable (methodology doc §13):
    fetch geology + pga_zones for a pilot catchment's bbox and rasterize
    each to its own small GeoTIFF, cached under media/landslide_model/
    <catchment_key>/ the same disk-cache-by-catchment convention every
    flood_model.py fetch already uses. Returns
    {"geology": (path, legend), "pga_zones": (path, legend)} —
    either entry's path is None if that layer's own fetch came back
    empty (see _rasterize_categorical_wfs_layer's own docstring), not
    an exception — the caller decides whether a missing factor is
    fatal, this function never assumes so.

    force=True re-fetches/re-rasterizes even if cached files exist —
    same parameter-name convention every other flood_model.py fetch
    function already uses."""
    # ensure_registered_with_flood_model (not a direct `catchment_key not
    # in PILOT_CATCHMENTS` check) — a real, live-caught bug this fix
    # closes: a custom AOI key (register_custom_landslide_aoi) is
    # correctly never a member of this module's own curated
    # PILOT_CATCHMENTS dict, so the old direct check raised "Unknown
    # landslide catchment" for every custom AOI. bbox is read from
    # flood_model.PILOT_CATCHMENTS (not this module's own dict) for the
    # same reason — it's the ONE dict guaranteed to have an entry for
    # ANY registered catchment, curated or custom, after registration.
    ensure_registered_with_flood_model(catchment_key)
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)

    layer_specs = (
        (GEOLOGY_LAYER, GEOLOGY_ATTR_FIELD, GEOLOGY_LABEL_FIELD),
        (PGA_ZONES_LAYER, PGA_ZONES_ATTR_FIELD, None),
    )
    result = {}
    for layer, attr_field, label_field in layer_specs:
        out_path = os.path.join(out_dir, f"{layer}.tif")
        legend_path = os.path.join(out_dir, f"{layer}_legend.json")
        if not force and os.path.exists(out_path) and os.path.exists(legend_path):
            with open(legend_path) as f:
                legend = {int(k): v for k, v in json.load(f).items()}
            result[layer] = (out_path, legend)
            continue

        path, legend = _rasterize_categorical_wfs_layer(layer, attr_field, bbox, out_path, label_field=label_field)
        if path is not None:
            tmp_legend_path = f"{legend_path}.tmp{os.getpid()}"
            with open(tmp_legend_path, "w") as f:
                json.dump(legend, f)
            os.replace(tmp_legend_path, legend_path)
        result[layer] = (path, legend)

    return result


# ---------------------------------------------------------------------------
# Geology / PGA -> 1-5 landslide-hazard ordinal reclassification.
#
# Uses the SAME scale flood_model.py's own _WORLDCOVER_HAZARD_CLASS/
# _SOIL_TEXTURE_HAZARD_CLASS/_reclassify already establish (1=lowest
# hazard, 5=highest) — reused directly below, not reinvented.
#
# Every value here is either a real, cited literature finding or
# explicitly labeled as this project's own hedged judgment where the
# underlying formation identity wasn't independently confirmed — see
# LANDSLIDE_EARLY_WARNING_METHODOLOGY.md §13/L1 for the full account.
# Codes not in this dict fall back to flood_model._reclassify's own
# `default` (the scale's neutral midpoint), not a crash and not a
# silently-wrong guess — the real geology layer has ~40 formation codes
# nationwide; only the 7 confirmed present in the Murree/Galyat pilot
# bbox (L0's own live WFS test) are given a specific, reasoned class.
# ---------------------------------------------------------------------------

_GEOLOGY_CODE_HAZARD_CLASS = {
    "Tk": 5,   # Kuldana Formation (plausible code match) — Murree's own
               # confirmed dominant instability driver (methodology doc
               # §3.3's geological-controls citation): shale/siltstone/
               # sandstone, Main Boundary Thrust zone deformation.
    "Tep": 4,  # Eocene and Paleocene Sedimentary Rocks — regionally
               # shale/limestone-dominant sequences in this belt,
               # matching the confirmed 2005-Kashmir-earthquake
               # landslide-inventory finding that shale/clastic-
               # sediment/limestone lithologies are the highest-
               # susceptibility class (§3.6).
    "Q": 4,    # Alluvium — unconsolidated, genuinely low material
               # cohesion; the separate slope factor (not this one)
               # accounts for its typically-flat valley-bottom
               # occurrence, so this reflects intrinsic material
               # weakness, not terrain position.
    "DS": 3,   # Devonian and Silurian Rocks — HEDGED: real geological
               # identity (specific formation / degree of metamorphism)
               # not independently confirmed this session. Paleozoic
               # metasediments in this belt are plausibly phyllite/
               # slate-bearing (§3.6's own shale/slate finding), but
               # not confirmed — a real, moderate (not neutral-default)
               # class, explicitly flagged as hedged rather than
               # asserted with false precision.
    "gg": 2,   # Igneous, Metamorphic and Mafic Intrusive Rocks — hard,
               # well-consolidated crystalline rock; standard
               # geotechnical consensus as comparatively low-hazard
               # (fault/fracture-zone exceptions are the separate PGA
               # factor's job, not this one).
    "TM": 5,   # UPGRADED from an earlier neutral default — a real,
               # honest partial resolution, not a certain identification:
               # Pakistani geological-survey letter-codes follow a
               # period-prefix convention (confirmed by this exact
               # dataset's own "Tk" = Tertiary-Kuldana), so "TM"
               # plausibly denotes Tertiary-MURREE — the Murree
               # Formation itself, stratigraphically adjacent to and
               # sharing the same shale/siltstone/sandstone instability
               # mechanism as Kuldana (both late Paleocene-Eocene
               # foreland-basin molasse sequences). Given that
               # plausible identity, treated the same as Tk rather than
               # left at a fabricated-neutral default — a reasoned
               # inference, explicitly flagged as such, not a
               # confirmed fact.
    "Pc": 3,   # Formation identity UNRESOLVED — its own "name" property
               # returned the literal string "No" (§4's own L0 finding),
               # and no equivalent letter-code pattern match was found
               # for this one (unlike TM above). Explicitly defaulted
               # to the scale's neutral midpoint rather than guessed.
               # §L7 note: the dataset names combined units youngest-
               # first (DS, KJ, Jtr, Tep), so Pc reads as Permian-
               # Carboniferous OR (USGS "pC" convention) Precambrian —
               # in the Hazara/Murree belt plausibly the Precambrian
               # Hazara slates. Either reading is Paleozoic-or-older
               # (meta)sediment, the same group it is now placed in.
}

# ---------------------------------------------------------------------------
# §L7 — national lithology-group crosswalk. Every code the live
# `geological_global:geology` layer actually serves (66 distinct code/
# name pairs, fetched in full via WFS 2026-11-17 — not assumed) is
# assigned to one of six lithology groups, using the layer's OWN `name`
# labels wherever it has one (e.g. P = "Permian Sedimentary Rocks",
# Pz = "Paleozoic Rocks", Tr = "Triassic", M = "Mesozoic Rocks", Tm =
# "Miocene Sedimentary Rocks", TK = "Early Tertiary Rocks"). Before this,
# Hunza-Nagar's P/Pz/Tr, Astore/Chitral's Mpv/MPv/M, and every custom AOI
# outside the six pilots fell to the neutral default for ALL their
# geology-derived parameters.
#
# Codes whose own label is "No" are grouped by the dataset's own naming
# pattern (period letter prefix; combined units youngest-first, e.g. Kv =
# "Cretaceous Sedimentary and Volcanic Rocks"), so MPv/Mpv reads as
# Mesozoic-Paleozoic volcanics (the Kohistan-arc volcanic sequence that
# outcrops exactly in the Astore/Chilas/Chitral bboxes they appear in).
# This is an inference from the dataset's convention, flagged as such.
#
# Group parameters are literature-RANGE values in the same bands the
# per-code tables below already use (weak Tertiary molasse > Mesozoic/
# Paleozoic (meta)sediments > crystalline rock for landslide hazard;
# cohesion/friction ordered the same way), not new numbers. Explicit
# per-code entries above/below always win over the group value — the
# group only fills codes that previously had no entry at all.
# ---------------------------------------------------------------------------
_GEOLOGY_GROUP_PARAMS = {
    # group: (hazard_class, cohesion_kpa, friction_deg, unit_weight_knm3, is_rock)
    "quaternary_unconsolidated": (4, 5.0, 30.0, 18.0, False),
    "quaternary_weak_sedimentary": (4, 10.0, 28.0, 19.0, True),
    "tertiary_sedimentary": (4, 18.0, 27.0, 20.0, True),
    "mesozoic_sedimentary": (3, 20.0, 30.0, 21.0, True),
    "paleozoic_sedimentary": (3, 18.0, 29.0, 21.0, True),
    "crystalline": (2, 25.0, 33.0, 24.0, True),
}
_GEOLOGY_CODE_GROUP = {
    # Quaternary unconsolidated deposits (labels: Alluvium, Stream/
    # Streambed/Meander-belt/Piedmont/Eolian/Deltaic/Tidal deposits,
    # Valley Fill, Loess, Alluvium and Extrusive Mud).
    **{c: "quaternary_unconsolidated" for c in (
        "Q", "Qm", "Qmx", "Qf", "Qfx", "QFx", "Qbf", "Qcm", "QcM", "Qd", "Qdx", "Qes",
        "Qpd", "Qs", "Qsc", "Qt", "Qv", "QC", "QQ", "QS", "QSP",
    )},
    # Pleistocene/Pliocene sedimentary ROCKS (weakly consolidated
    # Siwalik-type conglomerate/sandstone — rock, but weak).
    **{c: "quaternary_weak_sedimentary" for c in ("Qp", "QP", "Qtp")},
    # Tertiary sedimentary rocks (Paleocene..Pliocene).
    **{c: "tertiary_sedimentary" for c in (
        "Tm", "TM", "Tk", "TK", "Tkf", "Tkm", "Te", "Tek", "Tep", "Tp", "To", "Toe",
        "Tmo", "Tpm", "Tpc",
    )},
    # Mesozoic sedimentary rocks (Triassic..Cretaceous), incl. the mixed
    # Cretaceous sedimentary+volcanic Kv unit (dominantly sedimentary).
    **{c: "mesozoic_sedimentary" for c in (
        "J", "Jf", "Jtr", "K", "KJ", "Kj", "Kbp", "Kpb", "Kpd", "Kpr", "Kv", "M", "Tr",
    )},
    # Paleozoic (and Precambrian) sedimentary/metasedimentary rocks.
    **{c: "paleozoic_sedimentary" for c in ("P", "p", "Pg", "C", "DS", "Pz", "PZ", "Pc", "PC", "pc", "Sp")},
    # Igneous/metamorphic/volcanic crystalline rock.
    **{c: "crystalline" for c in ("gg", "GG", "m", "MPv", "Mpv", "R")},
    # "As" (label "No", 4 features nationwide) has no period prefix this
    # dataset uses anywhere else — deliberately left ungrouped (neutral
    # default) rather than guessed.
}


def _fill_from_geology_groups(code_table, param_index):
    """Adds every grouped code that `code_table` has no explicit entry for,
    using its group's value at `param_index` of _GEOLOGY_GROUP_PARAMS.
    Explicit entries are never overwritten."""
    for code, group in _GEOLOGY_CODE_GROUP.items():
        if code not in code_table:
            code_table[code] = _GEOLOGY_GROUP_PARAMS[group][param_index]


_fill_from_geology_groups(_GEOLOGY_CODE_HAZARD_CLASS, 0)

# Pakistan Building Code seismic zoning — a real, official, standard
# ordinal ranking (Zone 1 lowest through Zone 4 highest, 2A/2B
# subdividing Zone 2). No ambiguity, unlike geology's own formation
# codes — every one of the layer's 5 real values is covered.
_PGA_ZONE_HAZARD_CLASS = {
    "Zone 1": 1,
    "Zone 2A": 2,
    "Zone 2B": 3,
    "Zone 3": 4,
    "Zone 4": 5,
}


def _lookup_code_value(value_to_hazard, value, default):
    """Exact-case match first, then case-insensitive. The exact pass
    matters since §L7's national crosswalk: the live layer has a few
    codes that differ ONLY by case but mean different things ("M" =
    Mesozoic Rocks vs "m" = Igneous/Metamorphic), so a purely
    case-insensitive dict would let one silently overwrite the other.
    The case-insensitive fallback keeps L5.5's own fix ("GG"/"gg",
    "Pc"/"pc" mixed casing for the same unit) working."""
    value = str(value)
    if value in value_to_hazard:
        return value_to_hazard[value]
    lowered = value.lower()
    for k, v in value_to_hazard.items():
        if str(k).lower() == lowered:
            return v
    return default


def _reclassify_legend_raster(class_int_path, legend, value_to_hazard, ref_gt, ref_w, ref_h, out_path, default=3):
    """Warps a class-int raster from _rasterize_categorical_wfs_layer's
    own standalone bbox+pixel_size_deg grid (L0's own grid — NOT
    necessarily the DEM's grid) onto the reference (DEM) grid, then
    reclassifies via the legend: class_int -> real code/value string ->
    hazard class. This indirection through the legend (rather than a
    fixed int->hazard dict the way flood_model.py's own WorldCover/
    soil-texture reclass tables work) is REQUIRED here and not a
    stylistic choice: this raster's own class integers are assigned
    dynamically per-catchment (sorted-unique-value order), unlike
    WorldCover/soil-texture's fixed, standard class codes — the same
    code (e.g. "Tk") could get a different integer in a different
    catchment's own bbox.

    Reuses flood_model._warp_to_grid and flood_model._reclassify
    directly (both fully generic already) — no new warp/reclass
    technique, just the legend-mediated crosswalk-building this
    specific data source needs.

    Matches `value` against `value_to_hazard` CASE-INSENSITIVELY — a
    real, live-caught data-quality fix, not a hypothetical concern:
    Astore's own geology WFS fetch returned "GG"/"pc" (mixed-case)
    alongside Murree/Galyat's own established "gg"/"Pc" — the SAME
    geological codes with inconsistent source-data casing across
    catchments. A plain, case-sensitive dict lookup would silently
    default 2 of Astore's 5 real geology codes to the neutral hazard
    class instead of their real, already-known values — caught during
    this session's own new-catchment testing, fixed here rather than
    left as a per-catchment accuracy gap."""
    warped_path = f"{out_path}.warped.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._warp_to_grid(class_int_path, warped_path, ref_gt, ref_w, ref_h, resample_alg="near")
        arr, gt, proj, nodata, w, h = flood_model._read_raster_array(warped_path)
    os.remove(warped_path)

    class_to_hazard = {}
    for class_int, entry in legend.items():
        value = entry["value"] if isinstance(entry, dict) else entry
        class_to_hazard[int(class_int)] = _lookup_code_value(value_to_hazard, value, default)

    hazard = flood_model._reclassify(arr, nodata, class_to_hazard, default=default)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, hazard, gt, proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)
    return out_path


def build_geology_pga_hazard_rasters(catchment_key, force=False):
    """L1 deliverable: geology/PGA -> the 1-5 hazard scale, co-registered
    onto the DEM's own conditioned grid so this can be combined with
    every other AHP factor pixel-for-pixel. Builds on L0's own fetch/
    rasterize step (fetch_and_rasterize_geology_pga) unchanged — this
    function only adds the warp-onto-DEM-grid + hazard-reclassify steps
    on top, it never re-fetches or re-derives the underlying WFS data.

    Returns {"geology": path, "pga_zones": path} — a factor whose own
    upstream WFS fetch came back empty (a real, honest "no coverage"
    result, not an error — see _rasterize_categorical_wfs_layer's own
    docstring) is OMITTED from the returned dict rather than included
    as None, so callers can use a plain dict-membership check."""
    ensure_registered_with_flood_model(catchment_key)
    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]
    with flood_model._gdal_lock():
        _, dem_gt, _, _, dem_w, dem_h = flood_model._read_raster_array(dem_path)

    raw = fetch_and_rasterize_geology_pga(catchment_key, force=force)
    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)

    specs = (
        (GEOLOGY_LAYER, _GEOLOGY_CODE_HAZARD_CLASS, "geology_hazard.tif"),
        (PGA_ZONES_LAYER, _PGA_ZONE_HAZARD_CLASS, "pga_zones_hazard.tif"),
    )
    result = {}
    for layer, value_to_hazard, out_name in specs:
        class_int_path, legend = raw.get(layer, (None, {}))
        if class_int_path is None:
            logger.warning(
                "landslide_model: no %r coverage for %r — omitted from hazard rasters, "
                "not defaulted to a fabricated value",
                layer, catchment_key,
            )
            continue
        out_path = os.path.join(out_dir, out_name)
        if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            result[layer] = out_path
            continue
        result[layer] = _reclassify_legend_raster(
            class_int_path, legend, value_to_hazard, dem_gt, dem_w, dem_h, out_path,
        )

    return result


# ---------------------------------------------------------------------------
# Aspect — the one new WhiteboxTools call §4 calls for, same subprocess/
# lock/timeout family as flood_model.build_twi_curvature_rasters's own
# `slope` call, reusing flood_model._run_wbt directly (already generic,
# bounded, verified — no new technique).
# ---------------------------------------------------------------------------

def build_aspect_raster(catchment_key, force=False):
    """Builds (once, cached) the aspect (slope direction, degrees)
    raster — the one landslide factor with no flood analogue among the
    DEM-derivable terrain factors. Same WhiteboxTools tool family as
    `slope` (flood_model.build_twi_curvature_rasters), same
    _run_wbt(...) call shape."""
    ensure_registered_with_flood_model(catchment_key)
    pipeline = flood_model.build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    out_path = os.path.join(out_dir, "aspect_deg.tif")
    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path

    flood_model._run_wbt("aspect", {"dem": dem_path, "output": out_path}, out_path)
    return out_path


# ---------------------------------------------------------------------------
# Distance to road — reuses flood_exposure's own Overpass helpers
# (_overpass_query/_overpass_bbox_str/_VEHICULAR_HIGHWAY_CLASSES,
# already bounded/timed-out, already proven live) and flood_connectivity.
# chamfer_distance_km (already generic) — the only genuinely new piece
# is rasterizing the fetched road LINES onto the DEM grid as a seed
# mask, which has no existing helper to reuse (flood's own distance-to-
# stream seed comes from the D8 pipeline's own internal stream-
# extraction array, not from external vector line data).
# ---------------------------------------------------------------------------

def _rasterize_line_features_to_mask(elements, ref_gt, ref_w, ref_h):
    """elements: raw Overpass `way` elements with a `geometry` list of
    {"lat","lon"} points (the exact shape flood_exposure.py's own
    _line_network_length_exposure already reads) -> a boolean seed mask
    on the reference grid, True wherever a road line passes through a
    cell. ALL_TOUCHED=TRUE (a standard GDAL rasterization option for
    thin line features — without it, a line that doesn't cross a cell's
    exact center can be missed entirely, which flood_model.py's own
    _clip_array_to_polygon has no equivalent concern for since it
    rasterizes area polygons, not 1-pixel-wide lines)."""
    from osgeo import gdal, ogr, osr

    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    mem_vec_ds = ogr.GetDriverByName("Memory").CreateDataSource("")
    layer = mem_vec_ds.CreateLayer("roads", srs=srs, geom_type=ogr.wkbLineString)
    for el in elements:
        pts = el.get("geometry")
        if not pts or len(pts) < 2:
            continue
        line = ogr.Geometry(ogr.wkbLineString)
        for p in pts:
            line.AddPoint(p["lon"], p["lat"])
        feat = ogr.Feature(layer.GetLayerDefn())
        feat.SetGeometry(line)
        layer.CreateFeature(feat)
        feat = None

    mask_ds = gdal.GetDriverByName("MEM").Create("", ref_w, ref_h, 1, gdal.GDT_Byte)
    mask_ds.SetGeoTransform(ref_gt)
    mask_ds.SetProjection(srs.ExportToWkt())
    gdal.RasterizeLayer(mask_ds, [1], layer, burn_values=[1], options=["ALL_TOUCHED=TRUE"])
    band = mask_ds.GetRasterBand(1)
    raw = band.ReadRaster(0, 0, ref_w, ref_h, buf_type=gdal.GDT_Byte)
    mask = np.frombuffer(raw, dtype=np.uint8).reshape(ref_h, ref_w) > 0
    mask_ds = None
    return mask


def build_distance_to_road_raster(catchment_key, force=False):
    """Builds (once, cached) a real distance-to-road raster in km — same
    chamfer_distance_km technique flood_model.build_distance_to_stream_
    raster already established for its own seed feature, applied to a
    genuinely different seed source (fetched OSM road lines, not an
    internally-derived stream array). A real, Pakistan-specific
    literature reason this factor matters more here than a generic
    global landslide-AHP survey would suggest: road-cut slope
    destabilization is a well-documented triggering mechanism in
    Murree/Galyat-type hill-road terrain (methodology doc §3.3's own
    [E7] citation)."""
    ensure_registered_with_flood_model(catchment_key)
    # flood_model.PILOT_CATCHMENTS, not this module's own PILOT_CATCHMENTS
    # — the same custom-AOI fix applied to fetch_and_rasterize_geology_
    # pga above (a custom key is correctly never in this module's own
    # curated dict).
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    pipeline = flood_model.build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    out_path = os.path.join(out_dir, "distance_road_km.tif")
    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path

    with flood_model._gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = flood_model._read_raster_array(dem_path)

    bbox_str = flood_exposure._overpass_bbox_str(bbox)
    q = f'[out:json][timeout:55];(way["highway"]({bbox_str}););out geom tags;'
    result = flood_exposure._overpass_query(q)
    elements = result.get("elements", []) if result else []
    vehicular = [el for el in elements if (el.get("tags") or {}).get("highway") in flood_exposure._VEHICULAR_HIGHWAY_CLASSES]

    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)

    if not vehicular:
        # A real, honest degraded result — no road data for this bbox
        # right now (Overpass down, or genuinely no roads) — never
        # crash the whole susceptibility build over one factor.
        # max-distance-everywhere is the correct "roads are irrelevant
        # here" signal for chamfer_distance_km's own downstream
        # reclassification, not a fabricated small number.
        logger.warning(
            "landslide_model: no vehicular road features for %r — distance-to-road "
            "degraded to a flat max-distance raster, not fabricated",
            catchment_key,
        )
        out_arr = np.where(valid, 999.0, flood_model._DISCHARGE_STAGE_NODATA)
    else:
        road_mask = _rasterize_line_features_to_mask(vehicular, dem_gt, w, h)
        _, miny, _, maxy = bbox
        lat_mid = (miny + maxy) / 2.0
        km_per_deg_lat = 111.32
        km_per_deg_lon = 111.32 * math.cos(math.radians(lat_mid))
        step_km_row = abs(dem_gt[5]) * km_per_deg_lat
        step_km_col = abs(dem_gt[1]) * km_per_deg_lon
        dist_km = flood_connectivity.chamfer_distance_km(road_mask, valid, step_km_row, step_km_col)
        out_arr = np.where(valid, dist_km, flood_model._DISCHARGE_STAGE_NODATA)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, out_arr, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)
    return out_path


# ---------------------------------------------------------------------------
# §L7 — distance to active faults. The factor L6 had to substitute with
# an inflated PGA weight ("no fault-line vector layer"), which in fact
# exists on the same GeoServer as geology/PGA: seismological_global:
# faultlines (named, status-tagged MultiLineStrings — confirmed live
# 2026-11-17: MBT in the Murree bbox, MKT in the AJK and Hunza bboxes).
# Literature: proximity to faults is the second control after lithology
# in the 2,252-landslide 2005-Kashmir inventory (Kamp et al. 2008) and
# one of the four dominant factors on the Karakoram Highway (§L6).
#
# Faults are fetched with a _FAULT_SEARCH_PAD_DEG margin so a fault just
# outside the bbox still sets the distance; distances are computed
# exactly (GEOS point-to-line) on a STRIDE-subsampled grid in a local
# equirectangular km frame and nearest-upsampled — <= ~85m error at
# stride 4 on the 30m DEM, far below the factor's own 1km first class.
# ---------------------------------------------------------------------------
FAULTLINES_WORKSPACE = "seismological_global"
FAULTLINES_LAYER = "faultlines"
_FAULT_SEARCH_PAD_DEG = 0.5
_FAULT_DISTANCE_STRIDE = 4
_FAULT_NONE_FOUND_KM = 999.0


def build_distance_to_fault_raster(catchment_key, force=False):
    """Distance (km) from every DEM cell to the nearest mapped fault line.
    Cached. With no fault within the padded search window the raster is
    a flat _FAULT_NONE_FOUND_KM ("far from any mapped fault"), logged,
    never fabricated. Returns the path."""
    import shapely
    from shapely.geometry import shape as shapely_shape
    from shapely.ops import transform as shapely_transform

    ensure_registered_with_flood_model(catchment_key)
    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "distance_fault_km.tif")
    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path

    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    with flood_model._gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = flood_model._read_raster_array(pipeline["paths"]["conditioned"])
    valid = np.ones_like(dem_arr, dtype=bool) if dem_nodata is None else (dem_arr != dem_nodata)

    minx, miny, maxx, maxy = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]
    pad = _FAULT_SEARCH_PAD_DEG
    features = _wfs_get_geojson_geological(FAULTLINES_LAYER, (minx - pad, miny - pad, maxx + pad, maxy + pad),
                                           workspace=FAULTLINES_WORKSPACE)
    lines = []
    for feat in features:
        try:
            geom = shapely_shape(feat.get("geometry"))
        except Exception:
            continue
        if not geom.is_empty:
            lines.append(geom)

    if not lines:
        logger.warning("landslide_model: no fault lines within %.1f deg of %r - distance-to-fault set to %.0f km",
                       pad, catchment_key, _FAULT_NONE_FOUND_KM)
        out_arr = np.where(valid, _FAULT_NONE_FOUND_KM, flood_model._DISCHARGE_STAGE_NODATA)
    else:
        lat0 = (miny + maxy) / 2.0
        kx, ky = 111.32 * math.cos(math.radians(lat0)), 111.32

        def to_km(x, y, z=None):
            return np.asarray(x) * kx, np.asarray(y) * ky

        faults_km = shapely.union_all([shapely_transform(to_km, g) for g in lines])
        stride = _FAULT_DISTANCE_STRIDE
        rows = np.arange(0, h, stride)
        cols = np.arange(0, w, stride)
        cc, rr = np.meshgrid(cols, rows)
        lon = dem_gt[0] + (cc + 0.5) * dem_gt[1]
        lat = dem_gt[3] + (rr + 0.5) * dem_gt[5]
        pts = shapely.points(lon.ravel() * kx, lat.ravel() * ky)
        coarse = shapely.distance(pts, faults_km).reshape(rr.shape)
        full = np.repeat(np.repeat(coarse, stride, axis=0), stride, axis=1)[:h, :w]
        out_arr = np.where(valid, full, flood_model._DISCHARGE_STAGE_NODATA)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, out_arr, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)
    return out_path


# ---------------------------------------------------------------------------
# Landslide-specific LULC / soil reclassification — §4's own explicit
# call-out: these need a DIFFERENT 1-5 hazard table than flood's own
# runoff-hazard one (flood_model._WORLDCOVER_HAZARD_CLASS/
# _SOIL_TEXTURE_HAZARD_CLASS), NOT the same table reused. Zero new
# fetch code either way — both reuse flood_model.build_lulc_raster/
# build_soil_texture_raster's own already-cached RAW (pre-reclassified)
# rasters directly, applying only a different reclassification on top.
# ---------------------------------------------------------------------------

# Dense tree cover = lowest landslide hazard (root reinforcement
# stabilizes slopes — a standard, well-established slope-stability
# finding, the OPPOSITE relative ranking from flood's own "trees =
# highest infiltration = lowest runoff hazard" logic, which happens to
# agree on tree cover's own rank here but for a different mechanism);
# bare/sparse vegetation = highest (no root reinforcement). Built-up is
# a real, standard "moderate-high" class in the landslide literature
# (anthropic slope modification / road-cut-adjacent construction), NOT
# the flood-runoff table's own "maximum hazard" ranking for
# imperviousness — a deliberately different value for the same class
# code, the exact case §4 flagged.
_WORLDCOVER_LANDSLIDE_HAZARD_CLASS = {
    10: 1,   # Tree cover
    20: 2,   # Shrubland
    30: 3,   # Grassland
    100: 3,  # Moss and lichen
    40: 3,   # Cropland — tilled, shallow-rooted
    60: 5,   # Bare / sparse vegetation — no root reinforcement
    70: 3,   # Snow and ice — not the focus of a monsoon-driven trigger
    50: 4,   # Built-up — anthropic slope modification, road cuts
    80: 1,   # Permanent water — not a slope-failure-relevant surface
    90: 2,   # Herbaceous wetland
    95: 1,   # Mangroves
}

# Clay-rich soils: low permeability -> pore-water-pressure buildup
# under sustained rainfall, and clay's own well-documented plasticity/
# strength loss when saturated is a standard shallow-landslide failure-
# surface mechanism — HIGH hazard here, the OPPOSITE of a simple
# "clay = most stable when dry" intuition. Coarse/sandy soils: higher
# permeability reduces pore-pressure buildup for a rainfall-triggered
# mechanism specifically — LOWER hazard, matching the standard "well-
# drained coarse soil = lower rainfall-triggered landslide risk"
# literature consensus. A real, genuinely more debated area than
# flood's own straightforward HSG-based runoff logic — flagged as such,
# not asserted with more confidence than the literature actually has.
_SOIL_TEXTURE_LANDSLIDE_HAZARD_CLASS = {
    1: 4, 2: 4, 3: 4,      # Clay, Silty Clay, Sandy Clay
    4: 4, 5: 4,            # Clay Loam, Silty Clay Loam
    6: 3, 7: 3, 8: 3,      # Sandy Clay Loam, Loam, Silty Loam
    9: 3, 10: 3,           # Sandy Loam, Silt
    11: 2, 12: 2,          # Loamy Sand, Sand
}


def build_landslide_lulc_hazard_raster(catchment_key, force=False):
    """Reuses flood_model.build_lulc_raster's own already-fetched RAW
    (un-reclassified) ESA WorldCover raster — zero new fetch — and
    applies THIS module's own landslide-specific hazard table instead
    of flood's runoff-hazard one."""
    ensure_registered_with_flood_model(catchment_key)
    flood_lulc = flood_model.build_lulc_raster(catchment_key, force=force)
    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    out_path = os.path.join(out_dir, "lulc_hazard.tif")
    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path

    with flood_model._gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = flood_model._read_raster_array(dem_path)
        lulc_arr, lulc_gt, lulc_proj, lulc_nodata, lw, lh = flood_model._read_raster_array(flood_lulc["raw_path"])
    hazard = flood_model._reclassify(lulc_arr, lulc_nodata, _WORLDCOVER_LANDSLIDE_HAZARD_CLASS, default=3)
    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    hazard = np.where(valid, hazard, flood_model._DISCHARGE_STAGE_NODATA)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, hazard, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)
    return out_path


def build_landslide_soil_hazard_raster(catchment_key, force=False):
    """Same reuse pattern as build_landslide_lulc_hazard_raster, for
    flood_model.build_soil_texture_raster's own raw OpenLandMap fetch."""
    ensure_registered_with_flood_model(catchment_key)
    flood_soil = flood_model.build_soil_texture_raster(catchment_key, force=force)
    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    out_path = os.path.join(out_dir, "soil_hazard.tif")
    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path

    with flood_model._gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = flood_model._read_raster_array(dem_path)
        soil_arr, soil_gt, soil_proj, soil_nodata, sw, sh = flood_model._read_raster_array(flood_soil["raw_path"])
    hazard = flood_model._reclassify(soil_arr, soil_nodata, _SOIL_TEXTURE_LANDSLIDE_HAZARD_CLASS, default=3)
    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    hazard = np.where(valid, hazard, flood_model._DISCHARGE_STAGE_NODATA)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, hazard, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)
    return out_path


# ---------------------------------------------------------------------------
# Terrain-class selector (methodology doc §5/§13-L6) — mean/90th-
# percentile slope, mean elevation, and dominant geology-formation
# class, NOT flood's own HAND-relief-based classify_terrain_relief.
# Real dispatch between two literature-distinct profiles as of L6
# (landslide_ahp.MODERATE_RELIEF_MONSOON_FACTORS / HIGH_RELIEF_
# KARAKORAM_FACTORS) — see _HIGH_RELIEF_MEAN_ELEVATION_GATE_M's own
# comment for the real, measured threshold this dispatch uses.
# ---------------------------------------------------------------------------

_HIGH_RELIEF_MEAN_ELEVATION_GATE_M = 2500.0
# Real, measured threshold, not an arbitrary round number picked in
# isolation — it's the SAME seasonal-snow-relevant elevation
# avalanche_model.AVALANCHE_ELEVATION_GATE_M already uses (a deliberate,
# cross-referenced consistency, not a coincidence), and it cleanly
# separates the real, live-measured mean elevations of every catchment
# registered so far (§13/L6): murree_galyat 1,480.8m / ajk_muzaffarabad
# 1,586.4m (both LOW) vs. besham_chilas_kkh 2,972.1m / astore 3,702.3m /
# hunza_nagar_karakoram 3,908.3m (all HIGH) — a genuine gap in the real
# data, not a threshold straddling ambiguous cases.


def classify_terrain_class(catchment_key):
    """Returns (terrain_class_str, stats_dict). Real, MEASURED dispatch
    between two literature-distinct profiles (landslide_ahp.py's own
    MODERATE_RELIEF_MONSOON_FACTORS / HIGH_RELIEF_KARAKORAM_FACTORS,
    §13/L6) — mean elevation is the discriminator (see
    _HIGH_RELIEF_MEAN_ELEVATION_GATE_M's own comment for why this
    specific value, and the real data it was checked against), not
    slope: mean slope alone does not cleanly separate the catchments
    registered so far (Astore 31.71° sits between Murree/Galyat's 25.2°
    and Hunza-Nagar's 33.38°, live-confirmed), while mean elevation does.
    A genuinely different THIRD profile would need its own real,
    measured discriminator, added here explicitly — never a silent
    fallback to one of these two for a terrain type neither literature
    base actually covers."""
    ensure_registered_with_flood_model(catchment_key)
    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    with flood_model._gdal_lock():
        dem_arr, _, _, dem_nodata, _, _ = flood_model._read_raster_array(pipeline["paths"]["conditioned"])
    valid_dem = dem_arr[dem_arr != dem_nodata] if dem_nodata is not None else dem_arr.ravel()
    mean_elevation = float(np.mean(valid_dem)) if valid_dem.size else 0.0

    twi_paths = flood_model.build_twi_curvature_rasters(catchment_key, force=False)
    with flood_model._gdal_lock():
        slope_arr, _, _, slope_nodata, _, _ = flood_model._read_raster_array(twi_paths["slope_deg"])
    valid_slope = slope_arr[slope_arr != slope_nodata] if slope_nodata is not None else slope_arr.ravel()
    mean_slope = float(np.mean(valid_slope)) if valid_slope.size else 0.0
    p90_slope = float(np.percentile(valid_slope, 90)) if valid_slope.size else 0.0

    geology_paths = build_geology_pga_hazard_rasters(catchment_key, force=False)
    dominant_code = None
    if "geology" in geology_paths:
        raw = fetch_and_rasterize_geology_pga(catchment_key, force=False)
        class_int_path, legend = raw.get(GEOLOGY_LAYER, (None, {}))
        if class_int_path is not None:
            with flood_model._gdal_lock():
                from osgeo import gdal
                ds = gdal.Open(class_int_path)
                band = ds.GetRasterBand(1)
                gw, gh = ds.RasterXSize, ds.RasterYSize
                raw_bytes = band.ReadRaster(0, 0, gw, gh, buf_type=gdal.GDT_Byte)
                counts = np.bincount(np.frombuffer(raw_bytes, dtype=np.uint8))
                ds = None
            counts = counts.copy()
            if len(counts) > 0:
                counts[0] = 0  # nodata/no-class
            if counts.any():
                dominant_class = int(np.argmax(counts))
                entry = legend.get(dominant_class) or legend.get(str(dominant_class))
                dominant_code = entry["value"] if isinstance(entry, dict) else entry

    stats = {
        "mean_slope_deg": round(mean_slope, 2),
        "p90_slope_deg": round(p90_slope, 2),
        "mean_elevation_m": round(mean_elevation, 1),
        "dominant_geology_code": dominant_code,
    }
    terrain_class = (
        "high_relief_karakoram" if mean_elevation >= _HIGH_RELIEF_MEAN_ELEVATION_GATE_M
        else "moderate_relief_monsoon"
    )
    logger.info("landslide_model: terrain stats for %r: %r -> %r", catchment_key, stats, terrain_class)
    return terrain_class, stats


# ---------------------------------------------------------------------------
# Main orchestrator.
# ---------------------------------------------------------------------------

def resolve_susceptibility_method(method=None, catchment_key=None):
    """Which susceptibility score a caller gets for `catchment_key` (§L7):
    - "ahp": the literature AHP weighted sum (L1), always available.
    - "calibrated": a calibrated model whether or not it passed approval
      (an explicit request) — the local model where this catchment has
      local evidence, else the global one; ValueError if none trained.
    - "auto" / None (default): a calibrated model ONLY where one was
      approved for this catchment (landslide_calibration.scoring_model_
      for), else AHP.
    Returns (resolved_method, scoring_view_or_None)."""
    from . import landslide_calibration

    method = method or "auto"
    if method == "ahp":
        return "ahp", None
    if method == "calibrated":
        if landslide_calibration.load_model() is None:
            raise ValueError("no calibrated landslide model has been trained yet (run the calibration job first)")
        return "calibrated", landslide_calibration.scoring_model_for(catchment_key, require_approved=False)
    if method != "auto":
        raise ValueError(f"unknown susceptibility method {method!r} - expected 'ahp', 'calibrated' or 'auto'")
    view = landslide_calibration.scoring_model_for(catchment_key, require_approved=True)
    return ("calibrated", view) if view is not None else ("ahp", None)


def _score_tag(lite, method=None, catchment_key=None):
    """Cache-file tag for the score a (lite, method, catchment) resolves
    to — a calibrated score is tagged with its model_id, so retraining
    can never serve a stale smoothed raster/zone file built from an
    older model."""
    resolved, model = resolve_susceptibility_method(method, catchment_key)
    if resolved == "calibrated":
        return f"cal_{model['model_id']}"
    return "lite" if lite else "full"


def build_landslide_susceptibility_raster(catchment_key, lite=True, force=False, method=None):
    """Combines every L1 factor via landslide_ahp.py's own CR-validated
    weight table into one continuous susceptibility score raster
    (weighted sum, same fusion shape flood_ahp.py's own AHP score
    combination uses). Real, cold-cache cost: a full DEM fetch +
    WhiteboxTools pipeline + several external fetches — expect minutes,
    not seconds, on first run for a new catchment (see this module's own
    production-readiness note at the top of the file). Never call this
    synchronously from a request handler.

    `method` — see resolve_susceptibility_method. The calibrated branch
    (§L7) writes its own score file and returns factor_importance as
    "weights" (the model's analogue of the AHP weight table).

    Returns {"score_path": path, "terrain_class": str, "weights": dict,
    "method": "ahp"|"calibrated", "model_id": str|None}."""
    from . import landslide_ahp

    ensure_registered_with_flood_model(catchment_key)
    terrain_class, terrain_stats = classify_terrain_class(catchment_key)
    resolved_method, model = resolve_susceptibility_method(method, catchment_key)
    if resolved_method == "calibrated":
        return _build_calibrated_susceptibility_raster(catchment_key, model, terrain_class, terrain_stats, force=force)
    weights = landslide_ahp.get_factor_weights(terrain_class, lite=lite)

    pipeline = flood_model.build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]
    twi_paths = flood_model.build_twi_curvature_rasters(catchment_key, force=force)

    factor_paths = {
        "slope": twi_paths["slope_deg"],
        "twi": twi_paths["twi"],
        "curvature": twi_paths["curvature"],
        "aspect": build_aspect_raster(catchment_key, force=force),
        "distance_road": build_distance_to_road_raster(catchment_key, force=force),
        "distance_drainage": flood_model.build_distance_to_stream_raster(catchment_key, force=force)["path"],
        "lulc": build_landslide_lulc_hazard_raster(catchment_key, force=force),
        "soil_type": build_landslide_soil_hazard_raster(catchment_key, force=force),
        # rainfall/NDVI (methodology doc §4: "None — already built") —
        # zero new fetch code, reusing flood_model's own CHIRPS mean-
        # annual climatology and Sentinel-2 NDVI composite unmodified.
        "rainfall": flood_model.build_rainfall_climatology_raster(catchment_key, force=force)["raw_path"],
        "ndvi": flood_model.build_ndvi_raster(catchment_key, force=force)["raw_path"],
    }
    geology_pga = build_geology_pga_hazard_rasters(catchment_key, force=force)
    if "geology" in geology_pga:
        factor_paths["lithology"] = geology_pga["geology"]
    if "pga_zones" in geology_pga:
        factor_paths["pga"] = geology_pga["pga_zones"]

    with flood_model._gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = flood_model._read_raster_array(dem_path)
    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)

    # Slope/aspect/curvature/distance rasters are CONTINUOUS (degrees or
    # km), not already on the 1-5 hazard scale the way lulc/soil/
    # lithology/pga already are — normalize each to that same 0-1..5
    # scale via a min-max stretch over the catchment's own real valid
    # range before combining, the same "everything on one comparable
    # scale before a weighted sum" principle flood_ahp.py's own score
    # combination already relies on.
    used_weights = {}
    score = np.zeros_like(dem_arr, dtype=np.float64)
    total_weight = 0.0
    _ALREADY_1_TO_5 = {"lulc", "soil_type", "lithology", "pga"}
    # Real correctness fix caught during this same testing pass (not
    # shipped-then-found): a plain min-max stretch implicitly assumes
    # "higher raw value = higher hazard" for every continuous factor,
    # which is backwards for these three — closer to a road/drainage
    # channel (SMALLER distance) is the higher-hazard condition (road-
    # cut destabilization / channel-toe saturation-erosion), and denser
    # vegetation (HIGHER NDVI) is LOWER hazard (root reinforcement).
    # Inverted after the same min-max stretch, not a different formula.
    _INVERT_CONTINUOUS = {"distance_road", "distance_drainage", "ndvi"}
    for factor, weight in weights.items():
        path = factor_paths.get(factor)
        if path is None:
            logger.warning("landslide_model: factor %r has a weight but no raster for %r — skipped, weights renormalized", factor, catchment_key)
            continue
        with flood_model._gdal_lock():
            arr, _, _, nodata, fw, fh = flood_model._read_raster_array(path)
        if (fw, fh) != (w, h):
            raise RuntimeError(f"landslide_model: factor {factor!r} raster dims {(fw, fh)} != DEM dims {(w, h)} for {catchment_key!r}")
        factor_valid = valid & (arr != nodata if nodata is not None else True)
        if factor in _ALREADY_1_TO_5:
            normalized = (arr - 1.0) / 4.0  # 1-5 -> 0-1
        elif factor == "aspect":
            # Circular variable (0-360deg compass direction) - a plain
            # min-max stretch is wrong in a DIFFERENT way than the
            # inversion issue above: it would treat 0deg and 360deg
            # (the same direction) as opposite ends of the scale. The
            # standard GIS "southness" transform (cos of the deviation
            # from due south) fixes the circularity correctly; south-
            # facing = higher solar exposure/weathering is used here as
            # the hazard direction, the standard convention in Northern-
            # Hemisphere terrain-hazard literature, though a genuinely
            # smaller and more hedged effect than any other factor in
            # this table (aspect's own weight, 0.02, reflects that).
            southness = np.cos(np.radians(arr - 180.0))  # -1 (north-facing) .. +1 (south-facing)
            normalized = (southness + 1.0) / 2.0
        else:
            vals = arr[factor_valid]
            lo, hi = (float(np.min(vals)), float(np.max(vals))) if vals.size else (0.0, 1.0)
            span = (hi - lo) or 1.0
            normalized = (arr - lo) / span
            if factor in _INVERT_CONTINUOUS:
                normalized = 1.0 - normalized
        normalized = np.clip(normalized, 0.0, 1.0)
        score = np.where(factor_valid, score + weight * normalized, score)
        used_weights[factor] = weight
        total_weight += weight

    if total_weight > 0:
        score = score / total_weight  # renormalize if any factor was skipped, so the score still spans ~0-1

    # Rescaled to flood_model.py's own AHP [1,5] convention (1=lowest,
    # 5=highest) rather than left on the internal [0,1] working scale —
    # a deliberate design choice, not cosmetic: flood_model._local_
    # natural_breaks/_classify_ahp_zones/_AHP_ZONE_LABELS are all
    # already built and calibrated around this exact [1,5] scale (its
    # own degenerate-case fallback, _AHP_ZONE_BREAKS = (2.33, 3.67), is
    # hardcoded to it) — reusing them UNMODIFIED for landslide zone
    # classification (§13/L1's own next step, immediately below)
    # requires matching their expected input scale, not just their
    # function signatures. This also makes the landslide score directly
    # comparable to flood's own AHP output in any future combined-
    # hazard display, a real secondary benefit.
    score_1_5 = 1.0 + 4.0 * score
    score_1_5 = np.where(valid, score_1_5, flood_model._DISCHARGE_STAGE_NODATA)

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    out_path = os.path.join(out_dir, f"susceptibility_score_{'lite' if lite else 'full'}.tif")
    tmp_path = f"{out_path}.tmp{os.getpid()}"
    score = score_1_5
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, score, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)

    return {"score_path": out_path, "terrain_class": terrain_class, "terrain_stats": terrain_stats,
            "weights": used_weights, "method": "ahp", "model_id": None}


def _build_calibrated_susceptibility_raster(catchment_key, model, terrain_class, terrain_stats, force=False):
    """§L7 calibrated score (landslide_calibration.score_catchment) on the
    same [1,5] scale and DEM grid as the AHP score, cached per model_id."""
    from . import landslide_calibration

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"susceptibility_score_cal_{model['model_id']}.tif")
    if force or not (os.path.exists(out_path) and os.path.getsize(out_path) > 0):
        score, _, gt, proj = landslide_calibration.score_catchment(catchment_key, model)
        tmp_path = f"{out_path}.tmp{os.getpid()}"
        with flood_model._gdal_lock():
            flood_model._write_raster_array(tmp_path, score, gt, proj, flood_model._DISCHARGE_STAGE_NODATA)
        os.replace(tmp_path, out_path)
    if model["scope"] == "local":
        # Local model: its held-out evidence is THIS catchment's own
        # spatial-block CV (other quadrants trained), not cross-catchment.
        held_out, ahp_held_out = model.get("spatial_cv_auc"), model.get("ahp_spatial_cv_auc")
    else:
        held_out, ahp_held_out = model.get("held_out_pooled_auc"), model.get("ahp_held_out_pooled_auc")
    return {
        "score_path": out_path, "terrain_class": terrain_class, "terrain_stats": terrain_stats,
        "weights": model.get("factor_importance", {}), "method": "calibrated", "model_id": model["model_id"],
        "model_summary": {
            "scope": model["scope"],
            "feature_set": model.get("feature_set"),
            "created_at": model.get("created_at"),
            "approved": bool(model.get("approved")),
            "held_out_auc": held_out,
            "ahp_held_out_auc": ahp_held_out,
        },
    }


# ---------------------------------------------------------------------------
# Zone classification + gap-free vectorization (methodology doc §13/L1
# step 9) — reuses flood_model.py's own generic machinery UNCHANGED:
# _local_natural_breaks (scale-agnostic 1-D k-means, but its own
# degenerate-case fallback is hardcoded to the [1,5] scale — the reason
# the score above is rescaled to [1,5] before this point, not a
# coincidence), _classify_ahp_zones, _AHP_ZONE_LABELS/_AHP_ZONE_COLORS,
# and _vectorize_ordinal_zones_gapfree (§0.51's gap-free-by-construction
# ordinal-cumulative-boundary technique) — the SAME adaptive sieve/
# simplify byte-budget backoff loop build_ahp_zone_geometries already
# established, applied here rather than re-derived, per §0.1's own
# explicit landslide-specific instruction: "use it directly... do not
# re-derive a sieve/simplify-tuning approach and re-discover the same
# three-round path."
# ---------------------------------------------------------------------------

def build_landslide_smoothed_score_raster(catchment_key, lite=True, force=False, method=None):
    """Smooths build_landslide_susceptibility_raster's own continuous
    [1,5] score before any zone classification/vectorization — reuses
    flood_connectivity.box_mean_filter directly, same radius_cells=8
    fixed window flood_model.build_ahp_smoothed_score_raster uses for
    every CURATED (non-custom-AOI) catchment.

    This is not an optional polish step: caught live, this exact
    session, on the raw (unsmoothed) landslide score — natural-breaks
    classification of a per-pixel weighted sum of several independently-
    noisy factors (slope/curvature/aspect chief among them, all high-
    spatial-frequency derivatives of a real DEM) "chatters" between
    classes at pixel granularity, producing a zone raster whose polygon
    count/complexity the adaptive sieve/simplify backoff loop cannot
    bring under budget even after its own maximum doubling iterations
    (confirmed live: 8.9MB after 6 iterations, vs. the smoothed-score
    fix's own already-proven flood-side precedent). Smoothing first
    removes that per-pixel chatter at its source, the same fix
    flood_model.py's own methodology doc already documents (§0.31/§0.41)
    — not re-derived here, applied directly.

    Returns {"path": cached smoothed-score raster path}."""
    from . import flood_connectivity

    ensure_registered_with_flood_model(catchment_key)
    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    lite_tag = _score_tag(lite, method, catchment_key)
    out_path = os.path.join(out_dir, f"susceptibility_smoothed_{lite_tag}.tif")

    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return {"path": out_path}

    susceptibility = build_landslide_susceptibility_raster(catchment_key, lite=lite, force=force, method=method)
    with flood_model._gdal_lock():
        score_arr, score_gt, score_proj, score_nodata, w, h = flood_model._read_raster_array(susceptibility["score_path"])
    valid = score_arr != score_nodata if score_nodata is not None else np.ones_like(score_arr, dtype=bool)

    # Fixed radius=8 (~17x17 cell window), matching flood's own curated-
    # pilot behavior exactly — this catchment is a single curated pilot,
    # not custom-AOI-capable yet (§9), so the adaptive-radius branch
    # flood_model.py needs for a small custom-drawn AOI has no landslide
    # analogue to reuse yet; if/when a custom-AOI landslide mode is ever
    # added, that same adaptive scaling would need porting here too.
    smoothed_score = flood_connectivity.box_mean_filter(score_arr, valid, radius_cells=8)
    out_arr = np.where(valid, smoothed_score, flood_model._DISCHARGE_STAGE_NODATA)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, out_arr, score_gt, score_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)

    return {"path": out_path}


def build_landslide_zone_geometries(catchment_key, lite=True, force=False, method=None):
    """Classifies build_landslide_smoothed_score_raster's own smoothed
    [1,5] score into 3 zones (low/medium/high) via Natural Breaks (this
    catchment's own local score distribution — no independent
    calibration data exists for landslide yet, the same "no basin-
    calibrated ground truth" situation _local_natural_breaks' own
    docstring already covers for a custom flood AOI) and vectorizes them
    gap-free. Classifies the SMOOTHED score, not the raw susceptibility
    raster directly — see build_landslide_smoothed_score_raster's own
    docstring for why (a real, live-confirmed non-convergence bug this
    fixes, not a stylistic choice).

    Returns {"geojson": FeatureCollection, "path": cache file path}."""
    ensure_registered_with_flood_model(catchment_key)

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    lite_tag = _score_tag(lite, method, catchment_key)
    cache_path = os.path.join(out_dir, f"zones_{lite_tag}.json")

    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        with open(cache_path, "r") as f:
            return {"geojson": json.load(f), "path": cache_path}

    smoothed = build_landslide_smoothed_score_raster(catchment_key, lite=lite, force=force, method=method)
    with flood_model._gdal_lock():
        score_arr, score_gt, score_proj, score_nodata, w, h = flood_model._read_raster_array(smoothed["path"])
    valid = score_arr != score_nodata if score_nodata is not None else np.ones_like(score_arr, dtype=bool)

    # Custom-AOI support: a drawn/uploaded polygon (flood_model.
    # register_custom_aoi's own clip_polygon, reused via register_
    # custom_landslide_aoi) — mirrors flood_model.build_ahp_zone_
    # geometries' own exact approach (its own §0.37 fix): Natural Breaks
    # is computed from cells actually INSIDE the drawn shape (not the
    # whole bbox rectangle), and the classified zone array is clipped
    # at the RASTER level BEFORE vectorization, not as a post-hoc
    # shapely intersection on the vectorized geoms — simpler, and
    # avoids jagged post-intersection edges. A curated catchment never
    # sets clip_polygon — a complete no-op for all of them.
    cfg = flood_model.PILOT_CATCHMENTS.get(catchment_key, {})
    clip_polygon = cfg.get("clip_polygon")
    if clip_polygon:
        clipped_for_breaks = flood_model._clip_array_to_polygon(
            score_arr, score_gt, score_proj, flood_model._DISCHARGE_STAGE_NODATA, clip_polygon,
        )
        sample_values = clipped_for_breaks[(clipped_for_breaks != flood_model._DISCHARGE_STAGE_NODATA) & valid]
    else:
        sample_values = score_arr[valid]

    breaks = flood_model._local_natural_breaks(sample_values)
    zone_arr = flood_model._classify_ahp_zones(score_arr, valid, breaks=breaks)
    zone_arr = np.where(valid, zone_arr, flood_model._DISCHARGE_STAGE_NODATA)
    if clip_polygon:
        zone_arr = flood_model._clip_array_to_polygon(
            zone_arr, score_gt, score_proj, flood_model._DISCHARGE_STAGE_NODATA, clip_polygon,
        )

    sieve_threshold_px = 1
    simplify_tolerance_px = 0.25
    min_mapping_unit_px = 0
    geojson = None
    total_bytes = None
    for _adapt_iter in range(flood_model._AHP_ZONE_MAX_ADAPT_ITERATIONS):
        geoms_by_class = flood_model._vectorize_ordinal_zones_gapfree(
            zone_arr, score_gt, score_proj, flood_model._AHP_ZONE_LABELS, out_dir,
            sieve_threshold_px, simplify_tolerance_px, min_mapping_unit_px,
        )
        features = [
            {
                "type": "Feature",
                "geometry": geom.__geo_interface__,
                "properties": {
                    "zone_class": flood_model._AHP_ZONE_LABELS[class_val],
                    "color": flood_model._AHP_ZONE_COLORS[flood_model._AHP_ZONE_LABELS[class_val]],
                },
            }
            for class_val, geom in geoms_by_class.items()
        ]
        geojson = {"type": "FeatureCollection", "features": features}
        total_bytes = len(json.dumps(geojson))
        if total_bytes <= flood_model._AHP_ZONE_MAX_GEOJSON_BYTES:
            break
        logger.info(
            "landslide_model: zone geometries for %r still %.1fKB (over the %.0fKB target) "
            "at sieve=%dpx/simplify=%.1fx — doubling both and retrying (iteration %d/%d)",
            catchment_key, total_bytes / 1024, flood_model._AHP_ZONE_MAX_GEOJSON_BYTES / 1024,
            sieve_threshold_px, simplify_tolerance_px, _adapt_iter + 1, flood_model._AHP_ZONE_MAX_ADAPT_ITERATIONS,
        )
        sieve_threshold_px *= 2
        simplify_tolerance_px *= 2
    else:
        logger.warning(
            "landslide_model: zone geometries for %r did not converge under %.0fKB within "
            "%d adaptive iterations (ended at %.1fKB) — serving the last, largest-simplification attempt",
            catchment_key, flood_model._AHP_ZONE_MAX_GEOJSON_BYTES / 1024, flood_model._AHP_ZONE_MAX_ADAPT_ITERATIONS,
            (total_bytes or 0) / 1024,
        )

    tmp_cache = f"{cache_path}.tmp{os.getpid()}"
    with open(tmp_cache, "w") as f:
        json.dump(geojson, f)
    os.replace(tmp_cache, cache_path)

    return {"geojson": geojson, "path": cache_path}


# ---------------------------------------------------------------------------
# Infinite-slope, physically-based layer (methodology doc §3.1) — a
# SEPARATE, complementary output, not fused into the AHP weighted-sum
# score above. Montgomery & Dietrich (1994)'s standard infinite-slope
# form, driven by this catchment's own real slope raster + a TWI-derived
# relative-saturation proxy + a literature-transferred, per-geology-code
# strength-parameter table. Deliberately kept out of
# build_landslide_susceptibility_raster's own fusion: an AHP weighted
# sum and a factor-of-safety calculation answer different questions
# (relative ranking vs. an absolute, if simplified, mechanics-based
# stability estimate) and conflating them into one number would hide
# which kind of evidence is doing the work — the same "don't silently
# blend genuinely different evidence types" discipline flood_model.py's
# own AHP/HAND-vs-discharge separation already follows.
# ---------------------------------------------------------------------------

# Effective cohesion (kPa), effective friction angle (degrees), and
# total unit weight (kN/m^3) per geology code — reusing the SAME
# _GEOLOGY_CODE_HAZARD_CLASS keys/identity findings above, not a
# separate lookup. Every value is labeled by its real provenance:
#
#   [ANCHOR]  a directly-cited, real geotechnical measurement for
#             materially the same rock type, found via literature
#             search this session (weathered shale: c'=15 kPa,
#             phi'=28deg, gamma=19.5 kN/m^3).
#   [RANGE]   a real, citable general range for the rock class (not
#             this specific formation) — sedimentary rock friction
#             angles ~25-30deg vs. igneous/metamorphic ~30-35deg,
#             found via literature search this session.
#   [HEDGED]  no anchor or range found for this exact code; an
#             engineering-judgment placeholder consistent with the
#             code's already-hedged hazard-class treatment above,
#             explicitly flagged, not presented as a citation.
#
# None of these are basin-calibrated (no local geotechnical borehole/
# lab-test data exists for this pilot catchment) — this is the same
# "literature-transferred, not locally calibrated" honesty caveat
# landslide_ahp.py's own module docstring already carries for its AHP
# weights, extended here to a physically-based layer's own parameters.
_GEOLOGY_CODE_COHESION_KPA = {
    "Tk": 15.0,   # [ANCHOR] weathered shale
    "TM": 15.0,   # [ANCHOR] same as Tk — plausible Murree Fm. identity (see hazard-class table above)
    "Tep": 20.0,  # [RANGE] shale/limestone sedimentary mix — slightly more cohesive than pure shale
    "Q": 5.0,     # [RANGE] unconsolidated alluvium — genuinely low cohesion, standard for loose granular/mixed fill
    "DS": 18.0,   # [HEDGED] Paleozoic metasediment, unresolved specifics
    "gg": 25.0,   # [RANGE] hard crystalline rock mass — a crude simplification (real rock-mass cohesion is
                  # controlled by discontinuities, not intact-rock strength) but conservative relative to the
                  # sedimentary classes, consistent with this code's already-low hazard class above
    "Pc": 18.0,   # [HEDGED] same treatment as DS — both unresolved, both defaulted, not two different guesses
}
_GEOLOGY_CODE_FRICTION_DEG = {
    "Tk": 28.0,   # [ANCHOR]
    "TM": 28.0,   # [ANCHOR] same as Tk
    "Tep": 27.0,  # [RANGE] sedimentary rock, 25-30deg band
    "Q": 30.0,    # [RANGE] granular alluvium — decent friction angle despite near-zero cohesion
    "DS": 29.0,   # [HEDGED]
    "gg": 33.0,   # [RANGE] igneous/metamorphic, 30-35deg band
    "Pc": 29.0,   # [HEDGED] same as DS
}
_GEOLOGY_CODE_UNIT_WEIGHT_KNM3 = {
    "Tk": 19.5,   # [ANCHOR]
    "TM": 19.5,   # [ANCHOR] same as Tk
    "Tep": 20.0,  # [RANGE]
    "Q": 18.0,    # [RANGE] loose, unconsolidated — lower bulk density than intact rock
    "DS": 21.0,   # [HEDGED]
    "gg": 24.0,   # [RANGE] dense crystalline rock
    "Pc": 21.0,   # [HEDGED] same as DS
}

# §L7 — every other code in the national layer gets its lithology group's
# value (see _GEOLOGY_GROUP_PARAMS); explicit entries above are kept.
_fill_from_geology_groups(_GEOLOGY_CODE_COHESION_KPA, 1)
_fill_from_geology_groups(_GEOLOGY_CODE_FRICTION_DEG, 2)
_fill_from_geology_groups(_GEOLOGY_CODE_UNIT_WEIGHT_KNM3, 3)

_WATER_UNIT_WEIGHT_KNM3 = 9.81  # standard value, not catchment-specific

# Assumed constant soil (regolith) depth in meters. No site-specific
# soil-depth survey exists for this pilot catchment; a constant is the
# standard simplification in infinite-slope/SHALSTAB-style screening
# applications absent one (Montgomery & Dietrich 1994's own original
# formulation and most follow-on shallow-landslide screening tools use
# a constant or crudely slope-scaled z in the 0.5-2m band for regolith-
# mantled terrain of this general relief class) — an explicit, named
# assumption, not a calibrated or measured value.
_INFINITE_SLOPE_SOIL_DEPTH_M = 1.5
# §L7: the full default parameter set (soil depth, a scale on the TWI
# saturation proxy, and a scale on every geology code's cohesion). These
# are replaced by landslide_calibration's fitted values ONLY once that
# fit's held-out AUC beat these defaults (see _active_infinite_slope_
# params); otherwise the literature defaults stay in use.
_INFINITE_SLOPE_DEFAULT_PARAMS = {"soil_depth_m": _INFINITE_SLOPE_SOIL_DEPTH_M, "saturation_scale": 1.0, "cohesion_scale": 1.0}


def _active_infinite_slope_params():
    from . import landslide_calibration
    approved = landslide_calibration.approved_infinite_slope_params()
    return dict(approved) if approved else dict(_INFINITE_SLOPE_DEFAULT_PARAMS)

# Factor-of-safety ceiling applied at (near-)zero slope, where the
# infinite-slope formula's own denominator (gamma*z*sin(theta)*cos(theta))
# approaches zero and FS is mathematically undefined, not physically
# meaningful — infinite-slope theory itself only applies to sloped
# terrain. Capped at a "clearly stable" ceiling rather than left as
# +inf/NaN, matching this module's own "never leave a factor as raw
# NaN/inf in a raster a caller might read" convention.
_INFINITE_SLOPE_FS_CEILING = 10.0


def build_infinite_slope_layer(catchment_key, force=False):
    """L1+ deliverable, methodology doc §3.1: a physically-based
    infinite-slope factor-of-safety (FS) raster, Montgomery & Dietrich
    (1994)'s standard form:

        FS = [C' + (gamma - m*gamma_w)*z*cos^2(theta)*tan(phi')]
             / [gamma*z*sin(theta)*cos(theta)]

    where theta is slope angle (from this catchment's own slope_deg
    raster), C'/phi'/gamma are literature-transferred per-geology-code
    parameters (see the tables above), z is the assumed constant soil
    depth, and m (relative saturation, 0-1) is a TWI-derived proxy: this
    catchment's own TWI values min-max stretched to [0,1] — an honest
    SIMPLIFICATION, not a calibrated soil-moisture measurement (a full
    steady-state-recharge form, e.g. O'Loughlin 1986/SHALSTAB's own
    w = (SCA/(z*sin(theta)))*(T/R), needs a soil transmissivity T and a
    rainfall recharge rate R this project has no calibrated values for —
    the same "don't fabricate a precision this project can't back up"
    discipline the AHP weights already follow). FS<1 indicates a
    theoretically unstable slope under this proxy's own saturation
    assumption; values are a screening indicator, not an engineering-
    grade slope-stability certification.

    Kept SEPARATE from build_landslide_susceptibility_raster's own AHP
    fusion — see this section's own module-level comment above.

    Returns {"fs_path": path, "class_path": path, "soil_depth_m": float,
    "params_used": {code: {"cohesion_kpa", "friction_deg",
    "unit_weight_knm3"} for every geology code actually present}}."""
    ensure_registered_with_flood_model(catchment_key)
    pipeline = flood_model.build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]
    twi_paths = flood_model.build_twi_curvature_rasters(catchment_key, force=force)

    with flood_model._gdal_lock():
        _, dem_gt, dem_proj, _, dem_w, dem_h = flood_model._read_raster_array(dem_path)

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    fs_path = os.path.join(out_dir, "infinite_slope_fs.tif")
    class_path = os.path.join(out_dir, "infinite_slope_class.tif")
    meta_path = os.path.join(out_dir, "infinite_slope_meta.json")
    fs_params = _active_infinite_slope_params()
    cached_meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r") as f:
                cached_meta = json.load(f)
        except (OSError, ValueError):
            cached_meta = {}
    # A cached FS raster built with different (default vs §L7-calibrated)
    # parameters is stale — rebuilt, never served. A pre-§L7 sidecar has
    # no "fs_params" and was built with the defaults.
    params_match = (cached_meta.get("fs_params") or _INFINITE_SLOPE_DEFAULT_PARAMS) == fs_params
    if not force and params_match and os.path.exists(fs_path) and os.path.getsize(fs_path) > 0 and os.path.exists(class_path):
        # params_used is real, cached detail (a small JSON sidecar,
        # avalanche_model.py's own metadata-caching pattern mirrored
        # exactly) — a cache hit no longer loses this real information,
        # a genuine gap live-tested and caught while wiring L5's own
        # susceptibility endpoint (a fresh raster's own first-ever build
        # predates this fix and has no sidecar yet; falls back to None
        # exactly like before rather than erroring on a missing file).
        return {
            "fs_path": fs_path, "class_path": class_path,
            "soil_depth_m": fs_params["soil_depth_m"],
            "fs_params": fs_params,
            "params_used": cached_meta.get("params_used"),
        }

    raw = fetch_and_rasterize_geology_pga(catchment_key, force=False)
    class_int_path, legend = raw.get(GEOLOGY_LAYER, (None, {}))
    params_used = {}
    if class_int_path is None:
        # No geology coverage at all for this catchment — degrade to the
        # single hedged (DS/Pc) parameter set uniformly rather than
        # fabricate per-pixel variation from nothing. Logged, not silent.
        logger.warning(
            "landslide_model: no geology coverage for %r — infinite-slope layer using a uniform "
            "hedged parameter set (DS/Pc-equivalent) for the whole catchment, not per-geology-code values",
            catchment_key,
        )
        cohesion_arr = np.full((dem_h, dem_w), _GEOLOGY_CODE_COHESION_KPA["DS"], dtype=np.float64)
        friction_arr = np.full((dem_h, dem_w), _GEOLOGY_CODE_FRICTION_DEG["DS"], dtype=np.float64)
        gamma_arr = np.full((dem_h, dem_w), _GEOLOGY_CODE_UNIT_WEIGHT_KNM3["DS"], dtype=np.float64)
        params_used["_uniform_fallback"] = {
            "cohesion_kpa": _GEOLOGY_CODE_COHESION_KPA["DS"],
            "friction_deg": _GEOLOGY_CODE_FRICTION_DEG["DS"],
            "unit_weight_knm3": _GEOLOGY_CODE_UNIT_WEIGHT_KNM3["DS"],
        }
    else:
        cohesion_path = os.path.join(out_dir, "geology_cohesion_kpa.tif")
        friction_path = os.path.join(out_dir, "geology_friction_deg.tif")
        gamma_path = os.path.join(out_dir, "geology_unit_weight_knm3.tif")
        # Reuses _reclassify_legend_raster UNCHANGED, three times, one
        # per parameter — it already does the legend-mediated warp +
        # crosswalk this needs; only the value_to_hazard dict and
        # default differ from the hazard-class use above (it is not
        # actually hazard-specific despite the name — any code:float
        # crosswalk works, including a real geotechnical property).
        _reclassify_legend_raster(class_int_path, legend, _GEOLOGY_CODE_COHESION_KPA,
                                   dem_gt, dem_w, dem_h, cohesion_path, default=_GEOLOGY_CODE_COHESION_KPA["DS"])
        _reclassify_legend_raster(class_int_path, legend, _GEOLOGY_CODE_FRICTION_DEG,
                                   dem_gt, dem_w, dem_h, friction_path, default=_GEOLOGY_CODE_FRICTION_DEG["DS"])
        _reclassify_legend_raster(class_int_path, legend, _GEOLOGY_CODE_UNIT_WEIGHT_KNM3,
                                   dem_gt, dem_w, dem_h, gamma_path, default=_GEOLOGY_CODE_UNIT_WEIGHT_KNM3["DS"])
        with flood_model._gdal_lock():
            cohesion_arr, _, _, _, _, _ = flood_model._read_raster_array(cohesion_path)
            friction_arr, _, _, _, _, _ = flood_model._read_raster_array(friction_path)
            gamma_arr, _, _, _, _, _ = flood_model._read_raster_array(gamma_path)
        # Resolved through the SAME exact-then-case-insensitive lookup the
        # rasters above used, so this report can never disagree with them
        # (the old exact-case set intersection silently omitted "GG"/"pc"
        # even though the rasters had resolved them). A code with no
        # entry at all is reported as using the default, not hidden.
        for entry in legend.values():
            code = str(entry["value"] if isinstance(entry, dict) else entry)
            resolved = _lookup_code_value(_GEOLOGY_CODE_COHESION_KPA, code, None) is not None
            params_used[code] = {
                "cohesion_kpa": _lookup_code_value(_GEOLOGY_CODE_COHESION_KPA, code, _GEOLOGY_CODE_COHESION_KPA["DS"]),
                "friction_deg": _lookup_code_value(_GEOLOGY_CODE_FRICTION_DEG, code, _GEOLOGY_CODE_FRICTION_DEG["DS"]),
                "unit_weight_knm3": _lookup_code_value(_GEOLOGY_CODE_UNIT_WEIGHT_KNM3, code, _GEOLOGY_CODE_UNIT_WEIGHT_KNM3["DS"]),
                "resolved": resolved,
            }

    with flood_model._gdal_lock():
        slope_arr, _, _, slope_nodata, sw, sh = flood_model._read_raster_array(twi_paths["slope_deg"])
        twi_arr, _, _, twi_nodata, tw, th = flood_model._read_raster_array(twi_paths["twi"])
    if (sw, sh) != (dem_w, dem_h) or (tw, th) != (dem_w, dem_h):
        raise RuntimeError(f"landslide_model: slope/TWI dims do not match DEM grid for {catchment_key!r}")

    valid = np.ones((dem_h, dem_w), dtype=bool)
    if slope_nodata is not None:
        valid &= (slope_arr != slope_nodata)
    if twi_nodata is not None:
        valid &= (twi_arr != twi_nodata)

    twi_valid_vals = twi_arr[valid]
    if twi_valid_vals.size:
        twi_lo, twi_hi = float(np.min(twi_valid_vals)), float(np.max(twi_valid_vals))
    else:
        twi_lo, twi_hi = 0.0, 1.0
    twi_span = (twi_hi - twi_lo) or 1.0
    m = np.clip((twi_arr - twi_lo) / twi_span, 0.0, 1.0)  # relative-saturation proxy, see docstring
    m = np.clip(m * fs_params["saturation_scale"], 0.0, 1.0)
    cohesion_arr = cohesion_arr * fs_params["cohesion_scale"]

    theta = np.radians(slope_arr)
    phi = np.radians(friction_arr)
    z = fs_params["soil_depth_m"]
    numerator = cohesion_arr + (gamma_arr - m * _WATER_UNIT_WEIGHT_KNM3) * z * np.cos(theta) ** 2 * np.tan(phi)
    denominator = gamma_arr * z * np.sin(theta) * np.cos(theta)
    with np.errstate(divide="ignore", invalid="ignore"):
        fs = np.where(np.abs(denominator) > 1e-9, numerator / denominator, _INFINITE_SLOPE_FS_CEILING)
    fs = np.clip(fs, 0.0, _INFINITE_SLOPE_FS_CEILING)
    fs = np.where(valid, fs, flood_model._DISCHARGE_STAGE_NODATA)

    # A simple, standard 3-class read of FS for quick interpretability
    # (1=unstable FS<1, 2=marginally stable 1<=FS<1.5, 3=stable FS>=1.5)
    # — a real, widely-used SHALSTAB-style threshold set, not this
    # project's own invention.
    stability_class = np.select(
        [fs < 1.0, fs < 1.5, fs >= 1.5],
        [1, 2, 3],
        default=3,
    ).astype(np.float64)
    stability_class = np.where(valid, stability_class, flood_model._DISCHARGE_STAGE_NODATA)

    fs_tmp = f"{fs_path}.tmp{os.getpid()}"
    class_tmp = f"{class_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(fs_tmp, fs, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
        flood_model._write_raster_array(class_tmp, stability_class, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(fs_tmp, fs_path)
    os.replace(class_tmp, class_path)

    tmp_meta = f"{meta_path}.tmp{os.getpid()}"
    with open(tmp_meta, "w") as f:
        json.dump({"params_used": params_used, "fs_params": fs_params}, f)
    os.replace(tmp_meta, meta_path)

    return {
        "fs_path": fs_path, "class_path": class_path,
        "soil_depth_m": fs_params["soil_depth_m"],
        "fs_params": fs_params,
        "params_used": params_used,
    }


# ---------------------------------------------------------------------------
# L2 — Exposure (methodology doc §13/L2). The smallest phase by design,
# entirely riding on flood_exposure._build_exposure_from_geom already
# being geometry-agnostic — its own docstring: "everything below only
# needs a...GEOMETRY, not how it was derived" (§0.24 of the flood doc's
# own refactor). Reused UNMODIFIED here, fed the landslide HIGH-
# susceptibility zone from L1's own build_landslide_zone_geometries
# instead of a flood-zone mask. Zero new exposure logic: buildings
# (Overture primary/OSM fallback), bridges/hospitals, road + drainage
# network length, population/vulnerable-population, and administrative-
# context tagging are all exactly the calls flood's own
# build_exposure_report already makes — only the wiring (which geometry
# feeds them) is new.
# ---------------------------------------------------------------------------

def build_landslide_exposure_report(catchment_key, lite=True, force=False, progress_callback=None, method=None):
    """L2 deliverable: exposure (buildings/roads/drainage/population/
    administrative context) for the landslide HIGH-susceptibility zone.

    Why "high" alone, not "high+medium" or the whole catchment: matches
    flood's own convention of reporting exposure for the single most
    severe zone class (its own fixed HAND threshold mask, not "medium
    value or above") — report the severe case plainly, don't blur it
    into a laxer one. A future caller wanting medium+high combined can
    trivially union those two features from build_landslide_zone_
    geometries's own GeoJSON — not built here since nothing today asks
    for it (§0's own "don't build unused generality" discipline).

    `progress_callback`, if given, is called with a short human-readable
    stage name before each major step — the exact same optional, additive
    contract flood_exposure.build_exposure_report's own progress_callback
    already established (a caller that passes nothing gets identical
    behavior either way).

    Real, cold-cache cost: dominated by the SAME external fetches flood's
    own exposure report already pays for (Overture buildings ~225-270s
    first run, Overpass roads/drainage/bridges each their own real
    network round-trip) — never call this synchronously from a request
    handler, same production-readiness note as build_landslide_
    susceptibility_raster's own module-level docstring above.

    Returns the SAME field shape as flood_exposure.build_exposure_report
    (administrative_context, infrastructure, buildings, osm_infrastructure,
    roads, drainage, population), plus "catchment", "lite", and
    "landslide_high_zone_km2" (renamed from the shared core's own generic
    "flood_zone_km2" key — this is a susceptibility zone, not a flood
    zone; every other field is already zone-agnostic by construction, no
    other renaming needed)."""
    def _report_stage(name):
        if progress_callback:
            try:
                progress_callback(name)
            except Exception:
                logger.warning("landslide_model: progress_callback raised (ignored)", exc_info=True)

    ensure_registered_with_flood_model(catchment_key)
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    _report_stage("Classifying landslide susceptibility zones")
    zones = build_landslide_zone_geometries(catchment_key, lite=lite, force=force, method=method)
    high_feature = next(
        (f for f in zones["geojson"]["features"] if f["properties"]["zone_class"] == "high"),
        None,
    )
    high_zone_geom = None
    if high_feature is not None:
        # Same GeoJSON-dict -> ogr -> shapely conversion flood_exposure.py's
        # own several existing call sites already use (e.g. its own WKB
        # round-trip at line ~336) - not a new technique.
        from osgeo import ogr
        import shapely.wkb as shapely_wkb
        ogr_geom = ogr.CreateGeometryFromJson(json.dumps(high_feature["geometry"]))
        if ogr_geom is not None:
            high_zone_geom = shapely_wkb.loads(bytes(ogr_geom.ExportToWkb()))
    else:
        logger.warning(
            "landslide_model: no 'high' susceptibility zone feature for %r - "
            "exposure report will be an honest all-zero result, not fabricated",
            catchment_key,
        )

    result = flood_exposure._build_exposure_from_geom(catchment_key, bbox, high_zone_geom, force, _report_stage)
    result["landslide_high_zone_km2"] = result.pop("flood_zone_km2")
    return {"catchment": catchment_key, "lite": lite, **result}


# ---------------------------------------------------------------------------
# L3 — Ground-truth validation (methodology doc §7/§13-L3). Happens
# BEFORE any weight-tuning temptation, not after — the explicit lesson
# both §0 and §7 draw from the flood system's own history. Every number
# below is reported exactly as computed, "poor" included — this project's
# own established honesty commitment (flood's own 0.614/0.570 "poor" AUC
# results were published as-is, not hidden or used to silently retune
# weights outside their cited literature source).
# ---------------------------------------------------------------------------

def validate_landslide_susceptibility(catchment_key, lite=True, force=False):
    """Runs assess_raster_auc_stable (accuracy_assessment.py, reused
    completely unmodified — "not extending the math", per §13/L3's own
    plan) against THREE real, independently-hosted ground-truth sources
    — not just COOLR (explicit instruction: "do not only rely on
    COOLR"). Each source is fetched and scored SEPARATELY (never
    silently blended into one number without the per-source breakdown
    also being available) — a caller wanting the single most complete
    figure uses the "pooled" result (all three sources' own real
    presence points unioned, since they are independent confirmations
    of the same real phenomenon, not competing/contradictory evidence);
    a caller auditing where a number actually came from uses "sources".

    - COOLR: currently unreachable (§7/§13-L3's own live-confirmed 404),
      kept wired unmodified so it contributes automatically once NASA's
      endpoint recovers — never removed just because it's down today.
    - GFLD (Global Fatal Landslide Database, University of Sheffield) —
      a live, independent ArcGIS FeatureServer (NOT NASA infrastructure
      — confirmed reachable even while every gis.earthdata.nasa.gov path
      is down), 257 real Pakistan points confirmed live this session.
    - GLC (NASA's own Global Landslide Catalog) — served as a stable,
      static CSV on data.nasa.gov (a different real access point onto
      materially the same underlying catalog COOLR's own broken REST
      endpoint would otherwise serve), 142 real Pakistan rows confirmed
      live this session.

    Runs against BOTH of L1's own hazard layers per source: the AHP
    weighted-sum score (build_landslide_susceptibility_raster,
    invert_score=False — higher score already means higher hazard on
    this project's own [1,5] convention) and the infinite-slope
    physically-based layer (build_infinite_slope_layer's own FS raster,
    invert_score=True — LOWER factor-of-safety means HIGHER hazard, the
    same polarity flood's own HAND raster already has).

    Returns {"catchment", "sources": {"coolr"/"gfld"/"glc": {"n_events",
    "ahp", "infinite_slope"}}, "pooled": {"n_events", "ahp",
    "infinite_slope"}, plus "n_coolr_events"/"ahp"/"infinite_slope" at
    the top level for backward compatibility with existing callers
    (landslide_model_views.py's job result, landslide_report_export.py's
    own _accuracy_rows) — pointed at the POOLED result now, the most
    complete real number available, not silently left at COOLR-only.
    A source returning zero events degrades to the honest "no_ground_
    truth" interpretation accuracy_assessment.py already defines —
    never fabricated, never silently skipped, for any of the three."""
    from . import accuracy_assessment

    ensure_registered_with_flood_model(catchment_key)
    bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

    sources = {
        "coolr": accuracy_assessment.fetch_coolr_presence_geoms(bbox),
        "gfld": accuracy_assessment.fetch_gfld_presence_geoms(bbox),
        "glc": accuracy_assessment.fetch_glc_presence_geoms(bbox),
        # §L6.6 — a real, much richer Pakistan-specific source (2,289
        # dated landslide extents + 31 recent incidents on a GeoServer
        # the user pointed at) found by direct investigation. Real
        # polygons for ncop_inventory (no synthetic buffer needed — see
        # its own docstring), point+buffer for ncop_recent like every
        # other point source above.
        "ncop_inventory": accuracy_assessment.fetch_ncop_landslide_inventory_presence_geoms(bbox),
        "ncop_recent": accuracy_assessment.fetch_ncop_recent_events_presence_geoms(bbox),
    }
    for name, geoms in sources.items():
        logger.info(
            "landslide_model: L3 validation for %r - %d %s presence geometries found",
            catchment_key, len(geoms), name.upper(),
        )
    pooled_geoms = [g for geoms in sources.values() for g in geoms]

    susceptibility = build_landslide_susceptibility_raster(catchment_key, lite=lite, force=force)
    infinite_slope = build_infinite_slope_layer(catchment_key, force=force)

    def _auc_for(geoms):
        return {
            "ahp": accuracy_assessment.assess_raster_auc_stable(
                susceptibility["score_path"], geoms, bbox, invert_score=False,
            ),
            "infinite_slope": accuracy_assessment.assess_raster_auc_stable(
                infinite_slope["fs_path"], geoms, bbox, invert_score=True,
            ),
        }

    per_source = {name: {"n_events": len(geoms), **_auc_for(geoms)} for name, geoms in sources.items()}
    pooled = {"n_events": len(pooled_geoms), **_auc_for(pooled_geoms)}

    return {
        "catchment": catchment_key,
        "sources": per_source,
        "pooled": pooled,
        "n_coolr_events": per_source["coolr"]["n_events"],
        "ahp": pooled["ahp"],
        "infinite_slope": pooled["infinite_slope"],
    }


# Reliability floor for the national-pooled assessment below — a
# catchment whose own local ground truth is thinner than this is
# EXCLUDED from the pool (not zeroed, not down-weighted — dropped
# entirely, matching assess_pooled_multi_raster_auc's own "reliability_
# skipped" mechanism), because CONFIRMED LIVE this session: single-
# catchment AUC with 1-3 REAL EVENTS swung from 0.87 ("good") to 0.26
# ("fail") for the exact SAME raster depending purely on which of
# COOLR/GFLD/GLC happened to have a point there — real evidence this
# project's own small-sample noise, not a genuine skill difference.
#
# HONEST CORRECTION, caught live while reviewing this same run's own
# results (not before): this threshold is checked against
# assess_pooled_multi_raster_auc's own `len(presence_vals)` — the
# number of SAMPLED PIXEL POINTS drawn from within the union of a
# catchment's own (buffered) presence geometries, NOT the number of
# real, distinct underlying events. Because each real event is buffered
# to a real ~250m-radius area (not a bare point — see fetch_coolr_
# presence_geoms's own docstring for why), even a small handful of real
# events can yield well over 100 sampled pixels if their buffers cover
# enough of the bbox — confirmed live: astore's own 4 real events still
# yielded up to 200/200 requested samples in some trials. This floor
# therefore does NOT reliably filter "too few real events" the way it
# was originally intended to here (unlike its own original flood-side
# use, where a scenario's presence_geoms were typically real polygons
# with materially different area characteristics) — it still correctly
# excludes a catchment whose combined presence area is small enough
# that few PIXELS could be sampled from it at all, just not "few real
# events" specifically. Left in place (a real, if imperfect, floor is
# better than none) but the gap is named here, not silently presented
# as a stronger guarantee than it actually provides. 5 is this
# project's own reasoned choice regardless (no universal citation sets
# a correct floor).
_NATIONAL_VALIDATION_MIN_PRESENCE_SAMPLES = 5


def validate_landslide_susceptibility_national(lite=True, force=False,
                                                 min_presence_samples=_NATIONAL_VALIDATION_MIN_PRESENCE_SAMPLES):
    """The real, thorough, "not only COOLR, and not just one thin
    catchment" accuracy estimate — pools EVERY registered catchment's
    own (AHP score raster, infinite-slope FS raster, pooled COOLR+GFLD+
    GLC presence points, its own bbox) into ONE statistically combined
    AUC via accuracy_assessment.assess_pooled_multi_raster_auc_stable,
    reused completely unmodified (the exact tool flood's own multi-
    event validation already built for this precise problem — pooling
    real, independent, per-scenario ground truth into one number with
    higher statistical power than any single scenario's own thin sample
    can support on its own).

    Real, cold-cache cost: builds the FULL susceptibility + infinite-
    slope pipeline for every registered catchment not already cached —
    several minutes per new catchment (the same real cost every other
    L1 build already has) — never call this synchronously from a
    request handler, same production-readiness note as every other
    expensive function in this module.

    Returns {"min_presence_samples", "ahp": {...pooled AUC result...},
    "infinite_slope": {...pooled AUC result...}, "per_catchment":
    {catchment_key: {"n_coolr", "n_gfld", "n_glc", "n_pooled"}}} — a
    catchment contributing zero usable presence points, or fewer than
    min_presence_samples, is visible in "per_catchment" (so it's never
    silently invisible) but excluded from the pooled AUC itself (see
    assess_pooled_multi_raster_auc's own "reliability_skipped"
    mechanism, surfaced here as "n_scenarios_reliability_skipped")."""
    from . import accuracy_assessment

    ahp_scenarios = []
    fs_scenarios = []
    per_catchment = {}

    for catchment_key in PILOT_CATCHMENTS:
        ensure_registered_with_flood_model(catchment_key)
        bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

        coolr = accuracy_assessment.fetch_coolr_presence_geoms(bbox)
        gfld = accuracy_assessment.fetch_gfld_presence_geoms(bbox)
        glc = accuracy_assessment.fetch_glc_presence_geoms(bbox)
        # §L6.6 — real, Pakistan-specific, much richer than the 3 above
        # (2,289 dated landslide extents + 31 recent incidents pooled
        # nationally). See accuracy_assessment.py's own section comment.
        ncop_inventory = accuracy_assessment.fetch_ncop_landslide_inventory_presence_geoms(bbox)
        ncop_recent = accuracy_assessment.fetch_ncop_recent_events_presence_geoms(bbox)
        pooled_geoms = coolr + gfld + glc + ncop_inventory + ncop_recent
        per_catchment[catchment_key] = {
            "n_coolr": len(coolr), "n_gfld": len(gfld), "n_glc": len(glc),
            "n_ncop_inventory": len(ncop_inventory), "n_ncop_recent": len(ncop_recent),
            "n_pooled": len(pooled_geoms),
        }
        logger.info(
            "landslide_model: national validation - %r: coolr=%d gfld=%d glc=%d ncop_inventory=%d ncop_recent=%d pooled=%d",
            catchment_key, len(coolr), len(gfld), len(glc), len(ncop_inventory), len(ncop_recent), len(pooled_geoms),
        )
        if not pooled_geoms:
            continue

        susceptibility = build_landslide_susceptibility_raster(catchment_key, lite=lite, force=force)
        infinite_slope = build_infinite_slope_layer(catchment_key, force=force)
        ahp_scenarios.append({
            "raster_path": susceptibility["score_path"], "presence_geoms": pooled_geoms,
            "aoi_bbox": bbox, "invert_score": False, "label": catchment_key,
        })
        fs_scenarios.append({
            "raster_path": infinite_slope["fs_path"], "presence_geoms": pooled_geoms,
            "aoi_bbox": bbox, "invert_score": True, "label": catchment_key,
        })

    ahp_result = accuracy_assessment.assess_pooled_multi_raster_auc_stable(
        ahp_scenarios, min_presence_samples=min_presence_samples,
    )
    fs_result = accuracy_assessment.assess_pooled_multi_raster_auc_stable(
        fs_scenarios, min_presence_samples=min_presence_samples,
    )

    # §L6.6 Part 2 — an INDEPENDENT spatial cross-check against 4 real
    # regional AHP susceptibility rasters, entirely separate from the AUC
    # figures above (own ground-truth-free comparison, never blended into
    # them). Local import: landslide_regional_comparison.py itself
    # imports this module, so a top-level import here would be circular
    # — same "import inside the function" convention already used for
    # accuracy_assessment/landslide_ahp elsewhere in this file. Every
    # catchment is attempted regardless of its own ground-truth count
    # (this comparison doesn't need presence points at all); a catchment
    # with no overlapping regional coverage is reported as such, not
    # silently omitted.
    from . import landslide_regional_comparison
    regional_comparison = {}
    for catchment_key in PILOT_CATCHMENTS:
        try:
            regional_comparison[catchment_key] = landslide_regional_comparison.compare_ahp_to_regional_susceptibility(
                catchment_key, lite=lite, force=force,
            )
        except Exception:
            logger.warning(
                "landslide_model: regional comparison failed for %r (degraded, not fatal to national validation)",
                catchment_key, exc_info=True,
            )
            regional_comparison[catchment_key] = {"region": None, "error": "regional comparison raised unexpectedly (see logs)"}

    return {
        "min_presence_samples": min_presence_samples,
        "ahp": ahp_result,
        "infinite_slope": fs_result,
        "per_catchment": per_catchment,
        "regional_comparison": regional_comparison,
    }


# ---------------------------------------------------------------------------
# L3.6 — Frequency-Ratio calibration with GENUINE held-out validation
# (leave-one-catchment-out cross-validation), per explicit instruction:
# "start on the local-calibration work... make sure that reach the
# 75-80% target." A real, load-bearing fact stated up front, not
# discovered after the fact: AUC is threshold-invariant — Youden's-J
# zone-BREAKPOINT calibration (flood's own _AHP_ZONE_BREAKS_CALIBRATED
# technique) changes which pixels get labeled low/medium/high, never the
# underlying score's own RANKING quality, so it cannot move this number
# even slightly. Only improving the score's own discriminative power
# can — Frequency Ratio (real, data-derived per-factor-class weights
# computed directly from the real ground truth L3.5 found) is the
# literature-standard technique for that.
#
# Reuses flood_model.py's own already-proven, fully generic primitives
# UNMODIFIED — _frequency_ratio_for_factor's own single-catchment math
# (pooled here across multiple catchments, see _pooled_frequency_ratio_
# for_factor's own docstring for why that's a real, necessary
# generalization, not a copy), _quantile_reclassify_hazard,
# _clip_array_to_polygon, _FR_HAZARD_CLASSES — not reimplemented.
#
# A REAL, deliberate methodological upgrade over flood_model.compute_
# frequency_ratio_ensemble's own established precedent, named
# explicitly here: that function fits FR weights AND evaluates AUC
# against the SAME presence points — a real, honest in-sample fit
# (never claimed otherwise there), but optimistic relative to genuine
# out-of-sample skill. With only ~40 real events total across 6
# catchments, that same-data approach here would risk reporting an
# inflated, non-generalizing number for exactly the situation this
# session's own explicit instruction asked to be trustworthy enough to
# test against. Leave-one-catchment-out (LOCO) cross-validation
# instead: FR weights are fit ONLY from the OTHER catchments' own
# pooled ground truth, then evaluated against the held-out catchment's
# own real events it never saw during fitting — repeated once per
# catchment, then pooled into one honest, held-out AUC via accuracy_
# assessment.assess_pooled_multi_raster_auc_stable (reused unmodified).
# ---------------------------------------------------------------------------

def _pooled_frequency_ratio_for_factor(class_arrs_and_masks, hazard_classes=None):
    """Real, statistically-correct multi-catchment generalization of
    flood_model._frequency_ratio_for_factor — pools real class_total/
    presence_total COUNTS across every TRAINING catchment given before
    computing each hazard class's own ratio (NOT averaging each
    catchment's own independently-computed ratio afterward, which would
    incorrectly treat a catchment with 2 presence points as equally
    informative as one with 20 — a real, meaningful correctness
    difference for this project's own genuinely uneven per-catchment
    ground-truth counts, §13/L3.5).

    `class_arrs_and_masks` — list of (hazard_arr, valid_mask,
    presence_mask) triples, one per training catchment, each already on
    that catchment's own real grid (arrays themselves are never mixed
    across catchments — only the resulting per-class COUNTS are pooled,
    the statistically valid way to combine different-shaped grids).

    Returns {class: fr_value}, or None if there's no real area/presence
    at all across every catchment given (matches flood_model._
    frequency_ratio_for_factor's own degrade-to-None convention)."""
    if hazard_classes is None:
        hazard_classes = flood_model._FR_HAZARD_CLASSES
    total_valid = 0
    total_presence = 0
    class_totals = {c: 0 for c in hazard_classes}
    class_presence = {c: 0 for c in hazard_classes}
    for hazard_arr, valid_mask, presence_mask in class_arrs_and_masks:
        total_valid += int(valid_mask.sum())
        total_presence += int((valid_mask & presence_mask).sum())
        for c in hazard_classes:
            class_mask = valid_mask & (hazard_arr == c)
            class_totals[c] += int(class_mask.sum())
            class_presence[c] += int((class_mask & presence_mask).sum())
    if total_valid == 0 or total_presence == 0:
        return None
    fr_by_class = {}
    for c in hazard_classes:
        if class_totals[c] == 0:
            fr_by_class[c] = 1.0
            continue
        presence_share = class_presence[c] / total_presence
        area_share = class_totals[c] / total_valid
        fr_by_class[c] = (presence_share / area_share) if area_share > 0 else 1.0
    return fr_by_class


# Continuous landslide factors -> their own quantile-reclassify
# direction, mirroring build_landslide_susceptibility_raster's own real,
# live-caught normalization-direction fix (§13/L1) — ascending=True
# means higher raw value -> higher hazard CLASS (a discrete analogue of
# that same [0,1]-stretch polarity, not a second, independently-derived
# convention). aspect is handled separately in _landslide_factor_hazard_
# array (its own southness transform first — a plain quantile split on
# a circular 0-360deg value would be wrong the same way a linear [0,1]
# stretch already was).
_LANDSLIDE_CONTINUOUS_FR_ASCENDING = {
    "slope": True,
    "twi": True,
    "curvature": True,
    "distance_road": False,
    "distance_drainage": False,
    "rainfall": True,
    "ndvi": False,
}


def _landslide_already_1_to_5_path(factor_key, catchment_key):
    """The real, already-1-to-5 landslide factor rasters — same set
    _ALREADY_1_TO_5 already names in build_landslide_susceptibility_
    raster, re-fetched here (cheap: every one of these is already disk-
    cached by its own builder, never re-fetched from an external
    source)."""
    if factor_key == "lulc":
        return build_landslide_lulc_hazard_raster(catchment_key, force=False)
    if factor_key == "soil_type":
        return build_landslide_soil_hazard_raster(catchment_key, force=False)
    if factor_key in ("lithology", "pga"):
        geology_pga = build_geology_pga_hazard_rasters(catchment_key, force=False)
        return geology_pga.get("geology" if factor_key == "lithology" else "pga_zones")
    return None


def _landslide_factor_hazard_array(catchment_key, factor_key, valid):
    """Landslide's own version of flood_model._factor_hazard_array —
    re-derives ONE AHP factor's own [1,5] hazard array, reusing every
    already-built landslide raster and flood_model's own generic
    _quantile_reclassify_hazard for the continuous ones — not a second,
    independently-invented classification technique.

    Returns (hazard_arr, factor_valid_mask), or (None, None) for an
    unrecognized factor_key."""
    if factor_key in ("lulc", "soil_type", "lithology", "pga"):
        path = _landslide_already_1_to_5_path(factor_key, catchment_key)
        if path is None:
            return None, None
        with flood_model._gdal_lock():
            arr, _, _, nodata, w, h = flood_model._read_raster_array(path)
        f_valid = valid & (arr != nodata) if nodata is not None else valid.copy()
        return arr, f_valid

    if factor_key == "aspect":
        aspect_path = build_aspect_raster(catchment_key, force=False)
        with flood_model._gdal_lock():
            arr, _, _, nodata, w, h = flood_model._read_raster_array(aspect_path)
        f_valid = valid & (arr != nodata) if nodata is not None else valid.copy()
        southness = np.cos(np.radians(arr - 180.0))
        return flood_model._quantile_reclassify_hazard(southness, f_valid, ascending=True), f_valid

    if factor_key in _LANDSLIDE_CONTINUOUS_FR_ASCENDING:
        twi_paths = flood_model.build_twi_curvature_rasters(catchment_key, force=False)
        path_map = {
            "slope": twi_paths["slope_deg"], "twi": twi_paths["twi"], "curvature": twi_paths["curvature"],
            "distance_road": build_distance_to_road_raster(catchment_key, force=False),
            "distance_drainage": flood_model.build_distance_to_stream_raster(catchment_key, force=False)["path"],
            "rainfall": flood_model.build_rainfall_climatology_raster(catchment_key, force=False)["raw_path"],
            "ndvi": flood_model.build_ndvi_raster(catchment_key, force=False)["raw_path"],
        }
        path = path_map[factor_key]
        with flood_model._gdal_lock():
            arr, _, _, nodata, w, h = flood_model._read_raster_array(path)
        f_valid = valid & (arr != nodata) if nodata is not None else valid.copy()
        ascending = _LANDSLIDE_CONTINUOUS_FR_ASCENDING[factor_key]
        return flood_model._quantile_reclassify_hazard(arr, f_valid, ascending=ascending), f_valid

    return None, None


def calibrate_landslide_frequency_ratio_loco(lite=True, force=False):
    """The real, held-out answer to "does local calibration actually
    reach 75-80%" — see this section's own module comment above for the
    full LOCO-cross-validation design and why it's used instead of
    flood's own in-sample FR-ensemble precedent.

    Real, substantial cold-cache cost: builds the full susceptibility
    pipeline for every catchment not already cached, same as
    validate_landslide_susceptibility_national — never call
    synchronously from a request handler.

    Returns {"method", "usable_catchments" (catchments with real ground
    truth — the rest are named, not silently dropped, but can neither
    train nor be tested on with zero real events), "per_fold": [{
    "test_catchment", "n_train_catchments", "n_test_events",
    "factors_used", "fr_auc", "ahp_auc"} — the SAME held-out test
    catchment scored by BOTH the newly-fit FR score and the original
    literature-AHP score, a real, honest "did local calibration
    actually help THIS catchment" comparison, not just the FR number
    alone], "pooled_fr_auc_held_out", "pooled_ahp_auc_held_out"} — both
    pooled figures computed ONLY from held-out predictions, never from
    data any fold's own fit ever saw."""
    from . import accuracy_assessment, landslide_ahp
    from shapely.ops import unary_union

    catchment_data = {}
    for catchment_key in PILOT_CATCHMENTS:
        ensure_registered_with_flood_model(catchment_key)
        bbox = flood_model.PILOT_CATCHMENTS[catchment_key]["bbox"]

        coolr = accuracy_assessment.fetch_coolr_presence_geoms(bbox)
        gfld = accuracy_assessment.fetch_gfld_presence_geoms(bbox)
        glc = accuracy_assessment.fetch_glc_presence_geoms(bbox)
        # §L6.6 — real, Pakistan-specific, much richer than the 3 above.
        ncop_inventory = accuracy_assessment.fetch_ncop_landslide_inventory_presence_geoms(bbox)
        ncop_recent = accuracy_assessment.fetch_ncop_recent_events_presence_geoms(bbox)
        pooled_geoms = coolr + gfld + glc + ncop_inventory + ncop_recent
        if not pooled_geoms:
            logger.info(
                "landslide_model: LOCO-FR - %r has zero real ground truth, excluded "
                "from both training and testing", catchment_key,
            )
            continue

        susceptibility = build_landslide_susceptibility_raster(catchment_key, lite=lite, force=force)
        terrain_class = susceptibility["terrain_class"]
        weights = landslide_ahp.get_factor_weights(terrain_class, lite=lite)

        pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
        with flood_model._gdal_lock():
            dem_arr, dem_gt, dem_proj, dem_nodata, w, h = flood_model._read_raster_array(pipeline["paths"]["conditioned"])
        valid = np.ones((h, w), dtype=bool)
        if dem_nodata is not None:
            valid &= (dem_arr != dem_nodata)

        with flood_model._gdal_lock():
            presence_mask_arr = flood_model._clip_array_to_polygon(
                np.ones((h, w), dtype=np.uint8), dem_gt, dem_proj, 0,
                unary_union(pooled_geoms).__geo_interface__,
            )
        presence_mask = presence_mask_arr.astype(bool) & valid

        factor_hazard_arrays = {}
        for factor_key in weights:
            hazard_arr, f_valid = _landslide_factor_hazard_array(catchment_key, factor_key, valid)
            if hazard_arr is not None:
                factor_hazard_arrays[factor_key] = (hazard_arr, f_valid)

        catchment_data[catchment_key] = {
            "bbox": bbox, "valid": valid, "dem_gt": dem_gt, "dem_proj": dem_proj,
            "presence_geoms": pooled_geoms, "presence_mask": presence_mask,
            "factor_hazard_arrays": factor_hazard_arrays, "n_events": len(pooled_geoms),
        }

    usable_keys = list(catchment_data.keys())
    if len(usable_keys) < 2:
        return {
            "error": "fewer than 2 catchments have real ground truth — cannot hold anything out",
            "usable_catchments": usable_keys,
        }

    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, "_loco_fr")
    os.makedirs(out_dir, exist_ok=True)
    lite_tag = "lite" if lite else "full"

    fold_results = []
    fr_scenarios = []
    ahp_scenarios = []
    for test_key in usable_keys:
        train_keys = [k for k in usable_keys if k != test_key]
        test = catchment_data[test_key]

        all_factors = set()
        for k in train_keys:
            all_factors |= set(catchment_data[k]["factor_hazard_arrays"].keys())

        fr_tables = {}
        for factor_key in all_factors:
            triples = [
                (*catchment_data[k]["factor_hazard_arrays"][factor_key], catchment_data[k]["presence_mask"])
                for k in train_keys if factor_key in catchment_data[k]["factor_hazard_arrays"]
            ]
            if not triples:
                continue
            fr = _pooled_frequency_ratio_for_factor(triples)
            if fr:
                fr_tables[factor_key] = fr

        fr_sum = np.zeros(test["valid"].shape, dtype=np.float64)
        used_factors = []
        for factor_key, fr_by_class in fr_tables.items():
            if factor_key not in test["factor_hazard_arrays"]:
                continue
            hazard_arr, f_valid = test["factor_hazard_arrays"][factor_key]
            factor_fr = np.ones_like(fr_sum)
            for cls, fr_val in fr_by_class.items():
                factor_fr = np.where(f_valid & (hazard_arr == cls), fr_val, factor_fr)
            fr_sum += factor_fr
            used_factors.append(factor_key)

        fr_out = np.where(test["valid"], fr_sum, flood_model._DISCHARGE_STAGE_NODATA)
        fr_score_path = os.path.join(out_dir, f"fr_loco_{test_key}_{lite_tag}.tif")
        tmp_path = f"{fr_score_path}.tmp{os.getpid()}"
        with flood_model._gdal_lock():
            flood_model._write_raster_array(tmp_path, fr_out, test["dem_gt"], test["dem_proj"], flood_model._DISCHARGE_STAGE_NODATA)
        os.replace(tmp_path, fr_score_path)

        susceptibility_test = build_landslide_susceptibility_raster(test_key, lite=lite, force=False)
        fr_auc = accuracy_assessment.assess_raster_auc_stable(
            fr_score_path, test["presence_geoms"], test["bbox"], invert_score=False,
        )
        ahp_auc = accuracy_assessment.assess_raster_auc_stable(
            susceptibility_test["score_path"], test["presence_geoms"], test["bbox"], invert_score=False,
        )

        fold_results.append({
            "test_catchment": test_key, "n_train_catchments": len(train_keys),
            "n_test_events": test["n_events"], "factors_used": used_factors,
            "fr_auc": fr_auc, "ahp_auc": ahp_auc,
        })
        fr_scenarios.append({
            "raster_path": fr_score_path, "presence_geoms": test["presence_geoms"],
            "aoi_bbox": test["bbox"], "invert_score": False, "label": test_key,
        })
        ahp_scenarios.append({
            "raster_path": susceptibility_test["score_path"], "presence_geoms": test["presence_geoms"],
            "aoi_bbox": test["bbox"], "invert_score": False, "label": test_key,
        })

    # min_presence_samples=1 here (not the national-validation function's
    # own 5) — every fold's own presence_geoms already passed a REAL
    # reliability gate simply by being the held-out set of a catchment
    # that had >=1 actual event; excluding a fold further here would
    # just shrink an already-small pooled result for no added honesty.
    pooled_fr = accuracy_assessment.assess_pooled_multi_raster_auc_stable(fr_scenarios, min_presence_samples=1)
    pooled_ahp = accuracy_assessment.assess_pooled_multi_raster_auc_stable(ahp_scenarios, min_presence_samples=1)

    return {
        "method": "leave_one_catchment_out_frequency_ratio",
        "usable_catchments": usable_keys,
        "per_fold": fold_results,
        "pooled_fr_auc_held_out": pooled_fr,
        "pooled_ahp_auc_held_out": pooled_ahp,
    }


# ---------------------------------------------------------------------------
# L4 — Rainfall-triggered dynamic mode, static-susceptibility half
# (methodology doc §6/§13-L4). The ID-threshold-curve half of L4 lives in
# the new landslide_trigger.py (mirrors flood_forecast.py's own separate-
# module convention) — this function supplies ONLY the "L1's static
# susceptibility class" input landslide_trigger.py's own decision matrix
# needs, reducing the per-pixel raster to one catchment-level summary,
# the same "PMD/NDMA's own real advisories are catchment/district-level,
# not per-pixel" framing §6 itself uses.
# ---------------------------------------------------------------------------

def static_susceptibility_summary(catchment_key, lite=True, force=False, method=None):
    """Reduces L1's own per-pixel classification to one catchment-level
    summary for L4's decision matrix. Deliberately reuses the EXACT same
    smoothed score + Natural Breaks classification build_landslide_zone_
    geometries already computes (flood_model._local_natural_breaks/
    _classify_ahp_zones/_AHP_ZONE_LABELS, unmodified) rather than
    deriving a second, independently-thresholded metric that could
    disagree with the zone polygons in an edge case (e.g. a bimodal
    score distribution where the raw MEAN lands in "medium" while most
    of the area is actually "high") — this recomputes the classification
    pass on the same cached raster (cheap: a local read + pure-NumPy
    breaks/classify, no new fetch), it does not re-derive a different
    threshold scheme.

    Returns {"dominant_class": "low"|"medium"|"high" (by pixel count),
    "class_pixel_fractions": {"low", "medium", "high"} (sum to ~1.0),
    "high_zone_km2"} (an approximate deg->km conversion, same "not
    survey-grade, fine for a real-but-approximate figure" convention
    flood_model.py's own _DEG_TO_KM already establishes — cross-checked
    live against L2's own build_landslide_exposure_report figure, which
    measures the SAME "high" zone a completely different way, via the
    real vectorized polygon area, not pixel counting)."""
    smoothed = build_landslide_smoothed_score_raster(catchment_key, lite=lite, force=force, method=method)
    with flood_model._gdal_lock():
        score_arr, score_gt, _, score_nodata, w, h = flood_model._read_raster_array(smoothed["path"])
    valid = score_arr != score_nodata if score_nodata is not None else np.ones_like(score_arr, dtype=bool)

    breaks = flood_model._local_natural_breaks(score_arr[valid])
    zone_arr = flood_model._classify_ahp_zones(score_arr, valid, breaks=breaks)
    valid_zone_vals = zone_arr[valid]

    counts = {
        flood_model._AHP_ZONE_LABELS[k]: int(np.sum(valid_zone_vals == k))
        for k in flood_model._AHP_ZONE_LABELS
    }
    total = sum(counts.values()) or 1
    fractions = {k: round(v / total, 4) for k, v in counts.items()}
    dominant = max(counts, key=counts.get)

    # deg->km approximation matching flood_model.py's own _DEG_TO_KM
    # convention (111.32 km/deg), squared for an area-in-km^2 figure.
    px_area_km2 = abs(score_gt[1]) * abs(score_gt[5]) * (111.32 ** 2)
    high_zone_km2 = round(counts.get("high", 0) * px_area_km2, 3)

    return {"dominant_class": dominant, "class_pixel_fractions": fractions, "high_zone_km2": high_zone_km2}


# ---------------------------------------------------------------------------
# Rockfall — a mechanically DISTINCT hazard from the soil-slide model
# above (methodology doc §3.8): bare/thinly-covered ROCK slope stability
# (joint/fracture detachment), not an infinite-slope soil-mechanics
# problem at all. A simple, RHRS-inspired (Pierson Rockfall Hazard
# Rating System — the real methodology Karakoram Highway rockfall
# studies use) screening flag, kept explicitly SEPARATE from the AHP/
# infinite-slope score — never blended into one number, the same
# discipline the infinite-slope layer's own module comment already
# establishes for a different mechanism.
# ---------------------------------------------------------------------------

# Which geology codes represent actual consolidated ROCK (rockfall-
# capable) vs. unconsolidated material (soil-slide territory, not
# rockfall) — a simple, defensible binary read of this dataset's own
# already-established codes (§13/L1): "Q" (alluvium) is loose,
# unconsolidated sediment — explicitly NOT rockfall terrain; every other
# code in this dataset is a named rock formation. An unresolved code
# (Pc/DS) defaults to True (assume rock) — the conservative, safer
# direction for a hazard-SCREENING flag, matching this project's own
# "when unsure, don't under-warn" posture already used for Pc/DS's own
# hazard-class defaults above.
_GEOLOGY_CODE_IS_ROCK = {
    "Tk": True, "TM": True, "Tep": True, "DS": True, "gg": True, "Pc": True,
    "Q": False,
}
# §L7 — national crosswalk: only the Quaternary unconsolidated deposits
# are non-rock; every other grouped code is a named rock unit.
_fill_from_geology_groups(_GEOLOGY_CODE_IS_ROCK, 4)

# General rockfall-mechanics threshold (NOT Karakoram-fitted — the live
# search this session found real KKH RHRS studies but not a single
# published Pakistan-specific slope-angle cutoff number): natural
# repose for loose material tops out around 30-35deg; rock terrain
# steeper than this becomes progressively more rockfall- (block
# detachment/toppling) than soil-slide-dominated. 45deg is a standard,
# defensible general engineering-geology threshold, labeled as such.
_ROCKFALL_SLOPE_THRESHOLD_DEG = 45.0


def build_rockfall_susceptibility_flag(catchment_key, force=False):
    """Pre-L5 deliverable (methodology doc §3.8): a simple binary
    rockfall-susceptibility flag raster (1 = susceptible, 0 = not) —
    slope >= _ROCKFALL_SLOPE_THRESHOLD_DEG AND actual rock geology (not
    unconsolidated alluvium). Deliberately NOT an AHP score or an FS
    value — a coarse screening flag, matching the real complexity this
    session's own literature search could actually verify (a full RHRS
    implementation needs joint/fracture-orientation field data this
    project has no source for).

    Returns {"flag_path", "susceptible_km2", "susceptible_fraction"} —
    cached via the flag raster's own presence; the summary stats are
    cheap enough (one raster read) to recompute on every call rather
    than needing a separate metadata sidecar."""
    ensure_registered_with_flood_model(catchment_key)
    out_dir = os.path.join(settings.MEDIA_ROOT, _LANDSLIDE_MEDIA_SUBDIR, catchment_key)
    flag_path = os.path.join(out_dir, "rockfall_flag.tif")

    if not force and os.path.exists(flag_path) and os.path.getsize(flag_path) > 0:
        with flood_model._gdal_lock():
            flag_arr, flag_gt, _, flag_nodata, fw, fh = flood_model._read_raster_array(flag_path)
        return _summarize_rockfall_flag(flag_arr, flag_gt, flag_nodata, flag_path)

    pipeline = flood_model.build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]
    twi_paths = flood_model.build_twi_curvature_rasters(catchment_key, force=force)

    with flood_model._gdal_lock():
        _, dem_gt, dem_proj, _, dem_w, dem_h = flood_model._read_raster_array(dem_path)
        slope_arr, _, _, slope_nodata, sw, sh = flood_model._read_raster_array(twi_paths["slope_deg"])
    if (sw, sh) != (dem_w, dem_h):
        raise RuntimeError(f"landslide_model: slope dims do not match DEM grid for {catchment_key!r}")

    valid = np.ones((dem_h, dem_w), dtype=bool)
    if slope_nodata is not None:
        valid &= (slope_arr != slope_nodata)

    raw = fetch_and_rasterize_geology_pga(catchment_key, force=False)
    class_int_path, legend = raw.get(GEOLOGY_LAYER, (None, {}))
    if class_int_path is None:
        logger.warning(
            "landslide_model: no geology coverage for %r - rockfall flag uses slope alone "
            "(conservatively assuming rock everywhere), not a fabricated geology read",
            catchment_key,
        )
        is_rock = np.ones((dem_h, dem_w), dtype=bool)
    else:
        rock_path = os.path.join(out_dir, "geology_is_rock.tif")
        _reclassify_legend_raster(
            class_int_path, legend,
            {k: (1.0 if v else 0.0) for k, v in _GEOLOGY_CODE_IS_ROCK.items()},
            dem_gt, dem_w, dem_h, rock_path, default=1.0,
        )
        with flood_model._gdal_lock():
            rock_arr, _, _, rock_nodata, _, _ = flood_model._read_raster_array(rock_path)
        is_rock = (rock_arr == 1.0)

    flag_arr = np.where(valid & is_rock & (slope_arr >= _ROCKFALL_SLOPE_THRESHOLD_DEG), 1.0, 0.0)
    flag_arr = np.where(valid, flag_arr, flood_model._DISCHARGE_STAGE_NODATA)

    tmp_path = f"{flag_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp_path, flag_arr, dem_gt, dem_proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, flag_path)

    return _summarize_rockfall_flag(flag_arr, dem_gt, flood_model._DISCHARGE_STAGE_NODATA, flag_path)


def _summarize_rockfall_flag(flag_arr, gt, nodata, flag_path):
    valid = flag_arr != nodata if nodata is not None else np.ones_like(flag_arr, dtype=bool)
    susceptible = valid & (flag_arr == 1.0)
    px_area_km2 = abs(gt[1]) * abs(gt[5]) * (111.32 ** 2)
    return {
        "flag_path": flag_path,
        "susceptible_km2": round(float(np.sum(susceptible)) * px_area_km2, 3),
        "susceptible_fraction": round(float(np.sum(susceptible)) / max(int(np.sum(valid)), 1), 4),
    }
