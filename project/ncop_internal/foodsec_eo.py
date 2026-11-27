# project/ncop_internal/foodsec_eo.py
# ---------------------------------------------------------------------------
# Satellite/model drought indicators per district for the Food Security &
# Agriculture Watch. Monthly district means are computed by Google Earth
# Engine (server side) and kept in ONE small file (media/foodsec/eo_v1.npz,
# ~2 MB); requests and the digest build only ever read that file.
#
#   rain   CHIRPS v3 pentads (UCSB-CHC), mm per month, 1981 ->
#   soil   FLDAS Noah 10-40 cm soil moisture (NASA), m3/m3, 1982 ->
#   ndvi   MODIS MOD13A2 v6.1 NDVI over cropland (MCD12Q1 classes 12 and 14;
#          the whole district where it has no mapped cropland), 2000 ->
#
# Indicators, always against the same calendar month(s) of other years:
#   SPI-1/3/6  standardised precipitation, non-parametric: Gringorten plotting
#              position -> standard normal (Farahmand & AghaKouchak 2015).
#              Withheld in dry seasons, where it is not meaningful: mean below
#              MIN_RAIN_MM or more than 25% of years dry.
#   soil percentile   rank among the same month of other years
#   VCI   100 (NDVI - min) / (max - min) over the same month of the other
#         years within the last VCI_YEARS (irrigation and new varieties have
#         greened Pakistan steadily, so a longer record would hide stress)
#
# Fill and refresh: `manage.py foodsec_eo --backfill` once, then
# `manage.py foodsec_eo --update` monthly (about 10 s).
# ---------------------------------------------------------------------------

import json
import logging
import os
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import date
from statistics import NormalDist

import numpy as np
import requests
from django.conf import settings

logger = logging.getLogger(__name__)

VARS = {
    "rain": {"first": 1981, "source": "CHIRPS v3 (UCSB Climate Hazards Center)", "unit": "mm/month", "scale": 5566},
    "soil": {"first": 1982, "source": "FLDAS Noah LSM, 10-40 cm (NASA)", "unit": "m3/m3", "scale": 11132},
    "ndvi": {"first": 2001, "source": "MODIS MOD13A2 v6.1 over MCD12Q1 cropland (NASA)", "unit": "NDVI", "scale": 1000},
}
# Fixed per district: people (modelled, JRC GHSL 2025) and share of land that is cropland (MCD12Q1).
STATIC = ("population", "cropland")
MIN_RAIN_MM = 30.0      # mean rain of the window below which SPI is withheld
MAX_DRY_SHARE = 0.25    # share of reference years with < 1 mm
MIN_YEARS = 20
VCI_YEARS = 15
CHUNK_MONTHS = {"rain": 24, "soil": 24, "ndvi": 12}
_lock = threading.Lock()
_memo = {"mtime": None, "doc": None}


class EoUnavailable(Exception):
    pass


def _path():
    root = os.path.join(settings.MEDIA_ROOT, "foodsec")
    os.makedirs(root, exist_ok=True)
    return os.path.join(root, "eo_v1.npz")


def month_index(y, m):
    return y * 12 + (m - 1)


def ym(i):
    return i // 12, i % 12 + 1


# ------------------------------------------------------------------ store
def load():
    """{"districts": [{name, province}], var: (start month index, array [district, month])} or None."""
    p = _path()
    if not os.path.exists(p):
        return None
    mt = os.path.getmtime(p)
    with _lock:
        if _memo["mtime"] == mt:
            return _memo["doc"]
    with np.load(p, allow_pickle=False) as z:
        doc = {"districts": json.loads(str(z["districts"])), "updated": str(z["updated"])}
        for v in VARS:
            if v in z.files:
                doc[v] = (int(z[f"{v}_start"]), z[v])
        for v in STATIC:
            if v in z.files:
                doc[v] = z[v]
    with _lock:
        _memo.update(mtime=mt, doc=doc)
    return doc


def save(doc):
    out = {"districts": json.dumps(doc["districts"]), "updated": doc["updated"]}
    for v in VARS:
        if v in doc:
            out[f"{v}_start"], out[v] = doc[v]
    for v in STATIC:
        if v in doc:
            out[v] = doc[v]
    tmp = _path() + f".{uuid.uuid4().hex[:6]}.tmp.npz"
    np.savez_compressed(tmp, **out)
    os.replace(tmp, _path())


# ------------------------------------------------------------- Earth Engine
def _ee():
    import ee
    try:
        ee.Number(1).getInfo()
    except Exception:
        ee.Initialize(project=getattr(settings, "GEE_PROJECT_ID", None))
    return ee


def districts_fc(ee):
    """(feature collection, [{name, province}]) from NCOP's own district layer."""
    from osgeo import ogr

    from . import gefs_districts as gd
    tmp = os.path.join(tempfile.gettempdir(), f"foodsec-dist-{uuid.uuid4().hex[:6]}.zip")
    try:
        r = requests.get(gd.wfs_url(), timeout=120)
        r.raise_for_status()
        with open(tmp, "wb") as f:
            f.write(r.content)
        shp = next(n for n in zipfile.ZipFile(tmp).namelist() if n.lower().endswith(".shp"))
        ds = ogr.Open(f"/vsizip/{tmp.replace(os.sep, '/')}/{shp}")
        layer = ds.GetLayer()
        defn = layer.GetLayerDefn()
        names = [defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())]
        low = {n.lower(): n for n in names}
        fn = next(low[k] for k in ("name", "district", "district_n", "dist_name", "adm2_en") if k in low)
        fp = next(low[k] for k in ("province", "province_n", "prov_name", "adm1_en") if k in low)
        feats, meta = [], []
        for i, f in enumerate(layer):
            g = f.GetGeometryRef()
            s = g.SimplifyPreserveTopology(0.02) if g is not None else None
            if s is None or s.IsEmpty():
                continue
            s.FlattenTo2D()
            feats.append(ee.Feature(ee.Geometry(json.loads(s.ExportToJson()), None, False), {"i": len(meta)}))
            meta.append({"name": f.GetField(fn), "province": f.GetField(fp)})
        ds = None
        return ee.FeatureCollection(feats), meta
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _month_image(ee, var, i, cropmask):
    y, m = ym(i)
    start = ee.Date.fromYMD(y, m, 1)
    end = start.advance(1, "month")
    name = f"v{i}"
    if var == "rain":
        return ee.ImageCollection("UCSB-CHC/CHIRPS/V3/PENTAD").filterDate(start, end).sum().rename(name)
    if var == "soil":
        return ee.ImageCollection("NASA/FLDAS/NOAH01/C/GL/M/V001").select("SoilMoi10_40cm_tavg").filterDate(start, end).mean().rename(name)
    img = ee.ImageCollection("MODIS/061/MOD13A2").select("NDVI").filterDate(start, end).mean().multiply(0.0001).rename(name)
    return img.updateMask(cropmask) if cropmask is not None else img


def available_until(ee, var):
    """Last COMPLETE month index the upstream collection covers."""
    cid, per_month = {"rain": ("UCSB-CHC/CHIRPS/V3/PENTAD", 6), "soil": ("NASA/FLDAS/NOAH01/C/GL/M/V001", 1),
                      "ndvi": ("MODIS/061/MOD13A2", 1)}[var]
    t = date.today()
    for back in range(0, 8):
        i = month_index(t.year, t.month) - back
        y, m = ym(i)
        s = ee.Date.fromYMD(y, m, 1)
        n = ee.ImageCollection(cid).filterDate(s, s.advance(1, "month")).size().getInfo()
        if n >= per_month and (var != "ndvi" or back > 0 or n >= 2):
            return i
    raise EoUnavailable(f"{var}: nothing recent upstream")


def _fetch(ee, fc, n, var, months, log=None):
    """[district, month] means for the given month indices."""
    cropmask = None
    if var == "ndvi":
        lc = ee.ImageCollection("MODIS/061/MCD12Q1").sort("system:time_start", False).first().select("LC_Type1")
        cropmask = lc.eq(12).Or(lc.eq(14))
    out = np.full((n, len(months)), np.nan, np.float32)
    step = CHUNK_MONTHS[var]
    for k in range(0, len(months), step):
        part = months[k:k + step]
        for pass_mask in ((cropmask, None) if var == "ndvi" else (None,)):
            img = ee.Image.cat([_month_image(ee, var, i, pass_mask) for i in part])
            for attempt in range(3):
                try:
                    feats = img.reduceRegions(fc, ee.Reducer.mean(), VARS[var]["scale"], tileScale=4).select([".*"], None, False).getInfo()["features"]
                    break
                except Exception:
                    if attempt == 2:
                        raise
                    time.sleep(4 * (attempt + 1))
            for f in feats:
                p = f["properties"]
                for j, i in enumerate(part):
                    # A one-band image comes back as "mean", several as band names.
                    v = p.get(f"v{i}", p.get("mean") if len(part) == 1 else None)
                    if v is not None and np.isnan(out[p["i"], k + j]):
                        out[p["i"], k + j] = v
            if var == "ndvi" and not np.isnan(out[:, k:k + len(part)]).all(axis=1).any():
                break
        if log:
            y, m = ym(part[-1])
            log(f"{var}: through {y}-{m:02d}")
    return out


def _statics(ee, fc, n):
    pop = ee.Image("JRC/GHSL/P2023A/GHS_POP/2025").select("population_count")
    lc = ee.ImageCollection("MODIS/061/MCD12Q1").sort("system:time_start", False).first().select("LC_Type1")
    crop = lc.eq(12).Or(lc.eq(14))
    out = {}
    for key, img, red, scale in (("population", pop, ee.Reducer.sum(), 100), ("cropland", crop, ee.Reducer.mean(), 500)):
        arr = np.full(n, np.nan, np.float32)
        for f in img.rename("x").reduceRegions(fc, red, scale, tileScale=8).select([".*"], None, False).getInfo()["features"]:
            p = f["properties"]
            v = p.get("sum", p.get("mean", p.get("x")))
            if v is not None:
                arr[p["i"]] = v
        out[key] = arr
    return out


def refresh(backfill=False, log=None):
    """Create or extend the store. Idempotent; re-reads the last 3 months, which
    upstream revises. Raises on failure and leaves the stored file untouched."""
    ee = _ee()
    fc, meta = districts_fc(ee)
    cur = None if backfill else load()
    if cur and [d["name"] for d in cur["districts"]] != [d["name"] for d in meta]:
        cur = None                          # district layer changed: rebuild
    doc = {"districts": meta, "updated": date.today().isoformat()}
    for var, cfg in VARS.items():
        last = available_until(ee, var)
        start0 = month_index(cfg["first"], 1)
        if cur and var in cur:
            s, arr = cur[var]
            have = s + arr.shape[1] - 1
            first = max(s, min(have + 1, last + 1) - 3)
            new = _fetch(ee, fc, len(meta), var, list(range(first, last + 1)), log) if last >= first else None
            keep = arr[:, :first - s]
            doc[var] = (s, np.concatenate([keep, new], axis=1) if new is not None else arr)
        else:
            doc[var] = (start0, _fetch(ee, fc, len(meta), var, list(range(start0, last + 1)), log))
    doc.update({k: cur[k] for k in STATIC} if cur and all(k in cur for k in STATIC) else _statics(ee, fc, len(meta)))
    save(doc)
    return {v: f"{ym(doc[v][0] + doc[v][1].shape[1] - 1)}" for v in VARS}


# --------------------------------------------------------------- indicators
_N = NormalDist()


def spi_value(sample, x):
    """Non-parametric SPI of x against `sample` (other years, same months).
    Ties (zero rain) take their mid-rank. None when there is too little data."""
    s = np.asarray(sample, float)
    s = s[np.isfinite(s)]
    if x is None or not np.isfinite(x) or s.size < MIN_YEARS:
        return None
    n = s.size + 1
    rank = float((s < x).sum()) + 0.5 * float((s == x).sum()) + 1.0
    p = (rank - 0.44) / (n + 0.12)
    return float(_N.inv_cdf(min(max(p, 1e-4), 1 - 1e-4)))


def spi(series, start, i, window):
    """SPI-`window` ending at month index i for one district series."""
    k = i - start
    if k - window + 1 < 0 or k >= len(series):
        return None
    tot = np.convolve(series, np.ones(window), "valid")     # tot[j] ends at j+window-1
    cur = k - window + 1
    same = tot[cur % 12::12]
    years = np.arange(cur % 12, len(tot), 12)
    ref = same[years != cur]
    ref = ref[np.isfinite(ref)]
    if ref.size < MIN_YEARS or not np.isfinite(tot[cur]):
        return None
    if ref.mean() < MIN_RAIN_MM or (ref < 1.0).mean() > MAX_DRY_SHARE:
        return None                                         # dry season: SPI means nothing here
    return spi_value(ref, tot[cur])


def same_month(series, start, i):
    """(value, values of the same calendar month in other years)."""
    k = i - start
    if k < 0 or k >= len(series):
        return None, np.array([])
    idx = np.arange(k % 12, len(series), 12)
    other = np.asarray(series)[idx[idx != k]]
    return float(series[k]) if np.isfinite(series[k]) else None, other[np.isfinite(other)]


def percentile(series, start, i):
    v, other = same_month(series, start, i)
    if v is None or other.size < MIN_YEARS:
        return None
    return float(100 * ((other < v).sum() + 0.5 * (other == v).sum()) / other.size)


def vci(series, start, i):
    k = i - start
    if k < 0 or k >= len(series) or not np.isfinite(series[k]):
        return None
    idx = np.arange(k % 12, len(series), 12)
    idx = idx[(idx != k) & (np.abs(idx - k) <= 12 * VCI_YEARS)]
    other = np.asarray(series)[idx]
    other = other[np.isfinite(other)]
    if other.size < 10:
        return None
    v = float(series[k])
    lo, hi = float(other.min()), float(other.max())
    return None if hi - lo < 0.02 else float(np.clip(100 * (v - lo) / (hi - lo), 0, 100))


def indicators(doc=None, at=None):
    """Per district: spi1/spi3/spi6, rain %, soil percentile, vci, with the month
    each refers to. `at` (month index) replays the past using only earlier data
    in the "current" value (the reference years stay as they are)."""
    doc = doc or load()
    if not doc:
        raise EoUnavailable("no EO store: run manage.py foodsec_eo --backfill")
    out = []
    ends = {v: doc[v][0] + doc[v][1].shape[1] - 1 for v in VARS if v in doc}
    use = {v: min(e, at) if at is not None else e for v, e in ends.items()}
    for d, info in enumerate(doc["districts"]):
        row = {"name": info["name"], "province": info["province"]}
        for k, nd in (("population", 0), ("cropland", 3)):
            v = doc[k][d] if k in doc else np.nan
            row[k] = None if not np.isfinite(v) else (int(v) if nd == 0 else round(float(v), nd))
        s, a = doc["rain"]
        i = use["rain"]
        for w in (1, 3, 6):
            v = spi(a[d], s, i, w)
            row[f"spi{w}"] = None if v is None else round(v, 2)
        k = i - s
        if k >= 2:
            tot = np.convolve(a[d], np.ones(3), "valid")
            ref = tot[(k - 2) % 12::12]
            m = float(np.nanmean(ref)) if ref.size else np.nan
            row["rain3_mm"] = round(float(tot[k - 2]), 1) if np.isfinite(tot[k - 2]) else None
            row["rain3_normal_mm"] = round(m, 1) if np.isfinite(m) else None
        s, a = doc["soil"]
        v = percentile(a[d], s, use["soil"])
        row["soil_pct"] = None if v is None else round(v)
        s, a = doc["ndvi"]
        v = vci(a[d], s, use["ndvi"])
        row["vci"] = None if v is None else round(v)
        out.append(row)
    return {"months": {v: "%d-%02d" % ym(i) for v, i in use.items()}, "districts": out, "updated": doc["updated"],
            "sources": {v: VARS[v]["source"] for v in VARS}}
