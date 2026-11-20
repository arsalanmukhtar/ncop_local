# project/ncop_internal/gefs_districts.py
# ---------------------------------------------------------------------------
# District statistics for the NOAA GEFS 35-day outlook (gefs_client.py):
# area-weighted values for every district of Pakistan, every day, both
# variables — the data behind the Weather Report panel's GEFS view.
#
# District index (built once, kept on disk):
#   - District polygons come from NCOP's own GeoServer layer
#     gcop:district_boundary (the same layer the map draws), fetched as a
#     zipped shapefile and read feature by feature with OGR (the full-detail
#     GeoJSON is ~175 MB; the shapefile streams with almost no memory).
#   - Each district is rasterised onto a 0.025 deg grid (~2.7 km) aligned so
#     every 0.25 deg GEFS cell is exactly 10 x 10 fine pixels and every 0.5
#     deg cell 20 x 20. Counting fine pixels per GEFS cell gives each
#     district's area weight on both grids — small districts that cover
#     only part of a cell still get a correct, area-weighted value.
#   - Result: a few thousand (district, cell, weight) entries per grid.
#
# Per run: for days 1-35 — precipitation area-mean and wettest-cell value,
# temperature area-mean, min and max — written once as districts.json.
# ---------------------------------------------------------------------------

import json
import logging
import os
import threading
import time
import uuid

import numpy as np
import requests
from django.conf import settings

from . import gefs_client as gc

logger = logging.getLogger(__name__)

INDEX_VERSION = 1
_INDEX_FILE = f"_district_index_v{INDEX_VERSION}.npz"
_META_FILE = f"_district_meta_v{INDEX_VERSION}.json"
_STATS_FILE = "districts.json"
_FINE = 0.025
# Fine-grid origin = the 0.5 deg grid's north-west cell edge, so both GEFS
# grids' cell edges fall exactly on fine-pixel edges (0.25 deg cells are
# offset by 0.125 = 5 fine pixels).
_ORIGIN_LON = gc.REGION["west"] - 0.25
_ORIGIN_LAT = gc.REGION["north"] + 0.25
# Window covering Pakistan (incl. AJK and Gilgit-Baltistan), on fine edges.
_WIN = {"west": 60.25, "east": 78.25, "south": 23.25, "north": 37.75}
_RETRY_BACKOFF = 900
_state = {"failed_at": 0.0}
_lock = threading.Lock()


def wfs_url():
    return getattr(settings, "NCOP_DISTRICTS_SHAPE_URL",
                   "http://172.18.7.35:8080/geoserver/gcop/ows?service=WFS&version=1.0.0&request=GetFeature"
                   "&typeName=gcop:district_boundary&outputFormat=SHAPE-ZIP")


class DistrictsUnavailable(Exception):
    """The district index could not be built (boundary service unreachable)."""


def _paths():
    root = gc._root()
    return os.path.join(root, _INDEX_FILE), os.path.join(root, _META_FILE)


def _window_shape():
    w = int(round((_WIN["east"] - _WIN["west"]) / _FINE))
    h = int(round((_WIN["north"] - _WIN["south"]) / _FINE))
    return h, w


def _fine_offsets():
    """Global fine-grid (col, row) of the window's top-left pixel."""
    return (int(round((_WIN["west"] - _ORIGIN_LON) / _FINE)), int(round((_ORIGIN_LAT - _WIN["north"]) / _FINE)))


def _rasterize(shp_path):
    """Rasterise every district (burn value = index + 1) onto the fine
    window, streaming features one by one. Returns (raster, meta list)."""
    from osgeo import gdal, ogr, osr

    src = ogr.Open(shp_path)
    if src is None:
        raise DistrictsUnavailable("district shapefile unreadable")
    lyr = src.GetLayer(0)
    h, w = _window_shape()
    drv = gdal.GetDriverByName("MEM")
    ds = drv.Create("", w, h, 1, gdal.GDT_Int16)
    ds.SetGeoTransform((_WIN["west"], _FINE, 0, _WIN["north"], 0, -_FINE))
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ds.SetProjection(srs.ExportToWkt())
    mem_drv = ogr.GetDriverByName("Memory")
    meta = []
    feat = lyr.GetNextFeature()
    while feat is not None:
        geom = feat.GetGeometryRef()
        if geom is not None and not geom.IsEmpty():
            i = len(meta)
            minx, maxx, miny, maxy = geom.GetEnvelope()
            c = geom.Centroid()
            meta.append({"name": (feat.GetField("name") or "").strip(), "province": (feat.GetField("province") or "").strip(),
                         "division": (feat.GetField("division") or "").strip(),
                         "bbox": [round(minx, 4), round(miny, 4), round(maxx, 4), round(maxy, 4)],
                         "centroid": [round(c.GetX(), 4), round(c.GetY(), 4)]})
            mem = mem_drv.CreateDataSource("d")
            ml = mem.CreateLayer("d", srs, geom.GetGeometryType())
            f2 = ogr.Feature(ml.GetLayerDefn())
            f2.SetGeometry(geom)
            ml.CreateFeature(f2)
            gdal.RasterizeLayer(ds, [1], ml, burn_values=[i + 1])
            f2 = ml = mem = None
        feat = lyr.GetNextFeature()
    band = ds.GetRasterBand(1)
    raster = np.frombuffer(band.ReadRaster(0, 0, w, h, buf_type=gdal.GDT_Int16), np.int16).reshape(h, w).copy()
    ds = src = None
    return raster, meta


def build_weights(raster, n_districts):
    """Per grid ('hr', 'lr'): arrays (district, flat cell index, weight).
    Weight = share of the district's fine pixels falling in that cell."""
    gx0, gy0 = _fine_offsets()
    rows, cols = np.nonzero(raster > 0)
    did = raster[rows, cols].astype(np.int32) - 1
    gx, gy = cols + gx0, rows + gy0
    out = {}
    for key, prod, shift, block in (("hr", gc._HR, 5, 10), ("lr", gc._LR, 0, 20)):
        ny, nx = gc._grid_shape(prod)
        cx, cy = (gx - shift) // block, (gy - shift) // block
        ok = (cx >= 0) & (cx < nx) & (cy >= 0) & (cy < ny)
        flat = cy[ok] * nx + cx[ok]
        d = did[ok]
        pair = d.astype(np.int64) * (ny * nx) + flat
        uniq, counts = np.unique(pair, return_counts=True)
        dist, cell = (uniq // (ny * nx)).astype(np.int32), (uniq % (ny * nx)).astype(np.int32)
        totals = np.bincount(dist, weights=counts, minlength=n_districts)
        out[key] = {"district": dist, "cell": cell, "weight": (counts / totals[dist]).astype(np.float32)}
    return out


def save_index(weights, meta):
    idx_path, meta_path = _paths()
    tmp_idx = idx_path + f".tmp{uuid.uuid4().hex[:6]}.npz"
    np.savez_compressed(tmp_idx, **{f"{k}_{f}": v[f] for k, v in weights.items() for f in ("district", "cell", "weight")})
    with open(meta_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"version": INDEX_VERSION, "region": gc.REGION, "built_at": time.time(), "districts": meta}, f)
    os.replace(tmp_idx, idx_path)
    os.replace(meta_path + ".tmp", meta_path)


def build_index():
    """Download the district shapefile once, rasterise and save the index."""
    tmp_zip = os.path.join(gc._root(), f".districts-{uuid.uuid4().hex[:6]}.zip")
    try:
        t0 = time.time()
        with requests.get(wfs_url(), stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(tmp_zip, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        import zipfile
        with zipfile.ZipFile(tmp_zip) as z:
            shp = next(n for n in z.namelist() if n.lower().endswith(".shp"))
        raster, meta = _rasterize(f"/vsizip/{tmp_zip.replace(os.sep, '/')}/{shp}")
        if not meta:
            raise DistrictsUnavailable("no district features")
        save_index(build_weights(raster, len(meta)), meta)
        logger.info("gefs_districts: index of %d districts built in %.1fs", len(meta), time.time() - t0)
    finally:
        try:
            os.remove(tmp_zip)
        except OSError:
            pass


def ensure_index(block=True):
    """True when the index exists. Builds it (once; backoff after failure)."""
    idx_path, meta_path = _paths()
    if os.path.exists(idx_path) and os.path.exists(meta_path):
        return True
    if not block or time.time() - _state["failed_at"] < _RETRY_BACKOFF:
        return False
    with _lock:
        if os.path.exists(idx_path) and os.path.exists(meta_path):
            return True
        try:
            build_index()
            return True
        except Exception:
            _state["failed_at"] = time.time()
            logger.warning("gefs_districts: district index build failed", exc_info=True)
            return False


def ensure_index_async():
    """Start the one-time index build in the background (no-op if present,
    already running or in failure backoff)."""
    if ensure_index(block=False) or _state.get("thread_alive"):
        return
    if time.time() - _state["failed_at"] < _RETRY_BACKOFF:
        return

    def _run():
        try:
            ensure_index(block=True)
        finally:
            _state["thread_alive"] = False

    _state["thread_alive"] = True
    threading.Thread(target=_run, name="gefs-district-index", daemon=True).start()


def index_building():
    return bool(_state.get("thread_alive"))


def _load_index():
    idx_path, meta_path = _paths()
    with np.load(idx_path) as z:
        w = {k: {f: z[f"{k}_{f}"] for f in ("district", "cell", "weight")} for k in ("hr", "lr")}
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)["districts"]
    return w, meta


def compute_stats(run_dir, weights, meta):
    """Per district and day: precip mean + wettest cell; t2m mean, min, max."""
    values = gc._load_values(run_dir)
    n = len(meta)
    out = {"precip_mean": np.zeros((n, gc.DAYS), np.float32), "precip_max": np.zeros((n, gc.DAYS), np.float32),
           "t2m_mean": np.zeros((n, gc.DAYS), np.float32), "t2m_min": np.zeros((n, gc.DAYS), np.float32),
           "t2m_max": np.zeros((n, gc.DAYS), np.float32)}
    for day in range(1, gc.DAYS + 1):
        k = "hr" if day <= gc._HR_DAYS else "lr"
        w = weights[k]
        for var in ("precip", "t2m"):
            flat = np.asarray(gc.day_grid(values[var], day), np.float32).ravel()[w["cell"]]
            ok = np.isfinite(flat)
            mean = np.bincount(w["district"][ok], weights=flat[ok] * w["weight"][ok], minlength=n)
            wsum = np.bincount(w["district"][ok], weights=w["weight"][ok], minlength=n)
            mean = np.where(wsum > 0, mean / np.maximum(wsum, 1e-9), np.nan)
            hi = np.full(n, -np.inf, np.float32)
            np.maximum.at(hi, w["district"][ok], flat[ok])
            if var == "precip":
                out["precip_mean"][:, day - 1] = mean
                out["precip_max"][:, day - 1] = np.where(np.isfinite(hi), hi, np.nan)
            else:
                lo = np.full(n, np.inf, np.float32)
                np.minimum.at(lo, w["district"][ok], flat[ok])
                out["t2m_mean"][:, day - 1] = mean
                out["t2m_min"][:, day - 1] = np.where(np.isfinite(lo), lo, np.nan)
                out["t2m_max"][:, day - 1] = np.where(np.isfinite(hi), hi, np.nan)
    return out


def _r(a):
    return [None if not np.isfinite(v) else round(float(v), 1) for v in a]


def district_stats(var):
    """Cached per-run district table for one variable (built on first use)."""
    if var not in ("precip", "t2m"):
        raise ValueError("var must be precip or t2m")
    runs = gc.built_runs()
    if not runs:
        raise gc.GefsUnavailable("no current GEFS run built yet")
    run = runs[-1]
    run_dir = os.path.join(gc._root(), run)
    path = os.path.join(run_dir, _STATS_FILE)
    if not os.path.exists(path):
        if not ensure_index(block=False):
            ensure_index_async()
            raise DistrictsUnavailable("district index is being prepared" if index_building()
                                       else "district boundaries unavailable")
        with _lock:
            if not os.path.exists(path):
                weights, meta = _load_index()
                st = compute_stats(run_dir, weights, meta)
                m = gc._read_manifest(run) or {}
                dates = [fr["valid_start"][:10] for fr in m.get("frames", {}).get("precip", [])]
                doc = {"run": run, "init_time": m.get("init_time"), "days": gc.DAYS, "dates": dates,
                       "daily_skill_days": gc._DAILY_SKILL_DAYS, "hr_days": gc._HR_DAYS,
                       "districts": [{**d, "precip": _r(st["precip_mean"][i]), "precip_max": _r(st["precip_max"][i]),
                                      "t2m": _r(st["t2m_mean"][i]), "t2m_min": _r(st["t2m_min"][i]),
                                      "t2m_max": _r(st["t2m_max"][i])} for i, d in enumerate(meta)]}
                tmp = path + f".tmp{uuid.uuid4().hex[:6]}"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(doc, f, separators=(",", ":"))
                os.replace(tmp, path)
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    keep = ("precip", "precip_max") if var == "precip" else ("t2m", "t2m_min", "t2m_max")
    return {**{k: doc[k] for k in ("run", "init_time", "days", "dates", "daily_skill_days", "hr_days")},
            "var": var, "unit": gc.COLORSCALES[var]["unit"],
            "colorscale": {k: gc.COLORSCALES[var][k] for k in ("bounds", "colors")},
            "districts": [{**{k: d[k] for k in ("name", "province", "division", "bbox", "centroid")},
                           **{k: d[k] for k in keep}} for d in doc["districts"]],
            "method": "Area-weighted mean over each district polygon (0.025° rasterisation of gcop:district_boundary)",
            "attribution": gc.ATTRIBUTION}
