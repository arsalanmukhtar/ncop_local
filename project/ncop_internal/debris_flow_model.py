# project/ncop_internal/debris_flow_model.py
# ---------------------------------------------------------------------------
# Debris-flow / debris-flood watershed screening (methodology doc §3.8 —
# the one landslide type the pre-L5 typology pass named and deferred
# because it is a per-WATERSHED, not per-pixel, mechanism).
#
# Method: Wilford et al. (2004), "Recognition of debris flow, debris
# flood and flood hazard through watershed morphometrics", Landslides
# 1:61-66 — the standard, widely-reused morphometric screen (also the
# basis of the debris-flow screening used for Karakoram/Hindu Kush fans).
# Each small watershed is classified from two numbers only:
#   Melton ratio  R = relief_km / sqrt(area_km2)
#   watershed length L (km) — longest flow path to the outlet
# with Wilford's published thresholds:
#   debris flow : R > 0.6  and  L <= 2.7 km
#   debris flood: 0.3 <= R <= 0.6, or R > 0.6 and L > 2.7 km
#   flood       : R < 0.3
# Thresholds are the published values (fitted in British Columbia), NOT
# re-fitted for Pakistan — the same "literature-transferred, labeled as
# such" status as the AHP weights.
#
# Watershed units are stream LINKS from the cached HAND pipeline (same
# streams.tif / D8 pointer every other module reads): each link's full
# upstream watershed is measured at the link's outlet cell (area from
# D8 flow accumulation, relief from WhiteboxTools max_upslope_value of
# the DEM, length from max_upslope_flowpath_length), and the class is
# painted onto that link's own local subbasin (WhiteboxTools subbasins)
# so the output is a wall-to-wall map of "what does the channel draining
# THIS area behave like". A screening product: it says a channel is
# morphometrically capable of debris flows, not that one is imminent —
# kept separate from the AHP slide score, never blended into it.
# ---------------------------------------------------------------------------

import json
import logging
import math
import os

import numpy as np
from django.conf import settings

from . import flood_model, landslide_model

logger = logging.getLogger(__name__)

_DEBRIS_MEDIA_SUBDIR = "debris_flow_model"

MELTON_DEBRIS_FLOW_MIN = 0.6
MELTON_FLOOD_MAX = 0.3
DEBRIS_FLOW_MAX_LENGTH_KM = 2.7

CLASS_FLOOD = 1
CLASS_DEBRIS_FLOOD = 2
CLASS_DEBRIS_FLOW = 3
CLASS_LABELS = {CLASS_FLOOD: "flood", CLASS_DEBRIS_FLOOD: "debris_flood", CLASS_DEBRIS_FLOW: "debris_flow"}
CLASS_COLORS = {"flood": "#4f9fe0", "debris_flood": "#f0a030", "debris_flow": "#c0392b"}

# Below this upstream area a "watershed" is a few hillslope cells, where
# Melton's ratio is dominated by DEM noise — such links are classified
# like their surroundings would be at the next scale up: not at all
# (left as flood/unclassified). 0.05 km^2 ~ 55 Copernicus 30m cells,
# well under the smallest watersheds in Wilford's own dataset.
_MIN_WATERSHED_AREA_KM2 = 0.05


def classify_watershed(melton_ratio, length_km):
    """Wilford et al. (2004) class for one watershed (see module comment)."""
    if melton_ratio is None or not math.isfinite(melton_ratio):
        return CLASS_FLOOD
    if melton_ratio > MELTON_DEBRIS_FLOW_MIN:
        return CLASS_DEBRIS_FLOW if length_km <= DEBRIS_FLOW_MAX_LENGTH_KM else CLASS_DEBRIS_FLOOD
    if melton_ratio >= MELTON_FLOOD_MAX:
        return CLASS_DEBRIS_FLOOD
    return CLASS_FLOOD


def _km_per_deg(gt, shape):
    """(km per pixel step in x, in y) at the grid's mid-latitude — the DEM
    grid is geographic (EPSG:4326), so cell sizes are degrees."""
    h, _ = shape
    lat_mid = gt[3] + gt[5] * h / 2.0
    km_y = abs(gt[5]) * 111.32
    km_x = abs(gt[1]) * 111.32 * math.cos(math.radians(lat_mid))
    return km_x, km_y


def build_debris_flow_screening(catchment_key, force=False):
    """Builds (cached) the per-watershed debris-flow screening for one
    catchment.

    Returns {"class_path", "watersheds": [{"link_id", "area_km2",
    "relief_m", "length_km", "melton_ratio", "class"}...] (only the
    debris_flow/debris_flood ones, largest first, capped at 200),
    "summary": {class: {"n_watersheds", "area_km2", "area_fraction"}},
    "geojson": FeatureCollection of the class polygons}."""
    from . import flood_exposure

    landslide_model.ensure_registered_with_flood_model(catchment_key)
    out_dir = os.path.join(settings.MEDIA_ROOT, _DEBRIS_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    class_path = os.path.join(out_dir, "debris_flow_class.tif")
    meta_path = os.path.join(out_dir, "debris_flow_meta.json")
    if not force and os.path.exists(class_path) and os.path.exists(meta_path):
        with open(meta_path) as f:
            return {"class_path": class_path, **json.load(f)}

    pipeline = flood_model.build_hand_pipeline(catchment_key, force=False)
    paths = pipeline["paths"]
    links_path = os.path.join(out_dir, "stream_links.tif")
    subbasins_path = os.path.join(out_dir, "subbasins.tif")
    maxup_path = os.path.join(out_dir, "max_upslope_elev.tif")
    flowlen_path = os.path.join(out_dir, "max_upslope_flowpath.tif")
    for tool, kwargs, out in (
        ("stream_link_identifier", {"d8_pntr": paths["d8_pointer"], "streams": paths["streams"], "output": links_path, "zero_background": True}, links_path),
        ("subbasins", {"d8_pntr": paths["d8_pointer"], "streams": paths["streams"], "output": subbasins_path}, subbasins_path),
        ("max_upslope_value", {"dem": paths["conditioned"], "values": paths["conditioned"], "output": maxup_path}, maxup_path),
        ("max_upslope_flowpath_length", {"dem": paths["conditioned"], "output": flowlen_path}, flowlen_path),
    ):
        if force or not (os.path.exists(out) and os.path.getsize(out) > 0):
            flood_model._run_wbt(tool, kwargs, out)

    with flood_model._gdal_lock():
        dem, gt, proj, dem_nd, w, h = flood_model._read_raster_array(paths["conditioned"])
        links, _, _, links_nd, _, _ = flood_model._read_raster_array(links_path)
        subb, _, _, subb_nd, _, _ = flood_model._read_raster_array(subbasins_path)
        maxup, _, _, _, _, _ = flood_model._read_raster_array(maxup_path)
        flowlen, _, _, _, _, _ = flood_model._read_raster_array(flowlen_path)
        acc, _, _, _, _, _ = flood_model._read_raster_array(paths["flow_accum"])
    valid = np.ones((h, w), dtype=bool) if dem_nd is None else (dem != dem_nd)

    km_x, km_y = _km_per_deg(gt, (h, w))
    cell_km2 = km_x * km_y
    # max_upslope_flowpath_length reports in the DEM's own horizontal
    # units; this grid is geographic, so convert degrees -> km with the
    # mean cell scale (a flow path wanders in x and y alike).
    flowlen_km = flowlen * math.sqrt(km_x * km_y) / abs(gt[1])

    link_ok = valid & (links > 0)
    if links_nd is not None:
        link_ok &= (links != links_nd)
    link_ids = links[link_ok].astype(np.int64)
    if link_ids.size == 0:
        raise RuntimeError(f"debris_flow_model: no stream links found for {catchment_key!r}")
    acc_vals = acc[link_ok]
    flat_idx = np.flatnonzero(link_ok)
    # Outlet of each link = its cell with the largest flow accumulation.
    order = np.lexsort((acc_vals, link_ids))
    last_of_link = np.r_[link_ids[order][1:] != link_ids[order][:-1], True]
    outlet_flat = flat_idx[order][last_of_link]
    outlet_link = link_ids[order][last_of_link]

    dem_f, maxup_f, len_f, acc_f = dem.ravel(), maxup.ravel(), flowlen_km.ravel(), acc.ravel()
    class_by_link = {}
    watersheds = []
    for lid, fi in zip(outlet_link.tolist(), outlet_flat.tolist()):
        area_km2 = float(acc_f[fi]) * cell_km2
        relief_m = float(maxup_f[fi] - dem_f[fi])
        length_km = float(len_f[fi])
        if area_km2 < _MIN_WATERSHED_AREA_KM2 or relief_m <= 0:
            class_by_link[lid] = CLASS_FLOOD
            continue
        melton = (relief_m / 1000.0) / math.sqrt(area_km2)
        cls = classify_watershed(melton, length_km)
        class_by_link[lid] = cls
        if cls != CLASS_FLOOD:
            watersheds.append({"link_id": int(lid), "area_km2": round(area_km2, 3), "relief_m": round(relief_m, 1),
                               "length_km": round(length_km, 3), "melton_ratio": round(melton, 3),
                               "class": CLASS_LABELS[cls]})

    subb_int = np.where(valid & (subb > 0) & ((subb != subb_nd) if subb_nd is not None else True), subb, 0).astype(np.int64)
    lut_size = int(max(subb_int.max(), max(class_by_link) if class_by_link else 0)) + 1
    lut = np.zeros(lut_size, dtype=np.float64)
    for lid, cls in class_by_link.items():
        if lid < lut_size:
            lut[lid] = cls
    class_arr = lut[subb_int]
    unmatched = valid & (subb_int > 0) & (class_arr == 0)
    if unmatched.any():
        logger.warning("debris_flow_model: %d subbasin cells in %r had no matching stream link id - classed as flood",
                       int(unmatched.sum()), catchment_key)
    class_arr = np.where(valid & (class_arr == 0), CLASS_FLOOD, class_arr)
    class_arr = np.where(valid, class_arr, flood_model._DISCHARGE_STAGE_NODATA)

    tmp = f"{class_path}.tmp{os.getpid()}"
    with flood_model._gdal_lock():
        flood_model._write_raster_array(tmp, class_arr, gt, proj, flood_model._DISCHARGE_STAGE_NODATA)
    os.replace(tmp, class_path)

    n_valid = int(valid.sum()) or 1
    summary = {}
    for cls, label in CLASS_LABELS.items():
        px = int(np.sum(class_arr == cls))
        summary[label] = {
            "n_watersheds": sum(1 for c in class_by_link.values() if c == cls),
            "area_km2": round(px * cell_km2, 3),
            "area_fraction": round(px / n_valid, 4),
        }

    geoms = flood_exposure._vectorize_multiclass_raster(
        class_path, {CLASS_DEBRIS_FLOOD: "debris_flood", CLASS_DEBRIS_FLOW: "debris_flow"},
        sieve_threshold_px=25, simplify_tolerance_px=2.5,
    )
    features = []
    for cls, geom in sorted(geoms.items()):
        label = CLASS_LABELS[cls]
        features.append({"type": "Feature", "geometry": geom.__geo_interface__,
                         "properties": {"debris_class": label, "color": CLASS_COLORS[label]}})
    geojson = json.loads(json.dumps({"type": "FeatureCollection", "features": features}))

    watersheds.sort(key=lambda r: -r["area_km2"])
    meta = {"watersheds": watersheds[:200], "summary": summary, "geojson": geojson,
            "method": "Wilford et al. (2004) Melton ratio + watershed length",
            "thresholds": {"melton_debris_flow_min": MELTON_DEBRIS_FLOW_MIN, "melton_flood_max": MELTON_FLOOD_MAX,
                           "debris_flow_max_length_km": DEBRIS_FLOW_MAX_LENGTH_KM}}
    tmp_meta = f"{meta_path}.tmp{os.getpid()}"
    with open(tmp_meta, "w") as f:
        json.dump(meta, f)
    os.replace(tmp_meta, meta_path)
    return {"class_path": class_path, **meta}
