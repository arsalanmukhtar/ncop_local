# project/ncop_internal/flood_suscept.py
# ---------------------------------------------------------------------------
# National flood-susceptibility map for the Flood Watch report: the Flood
# Model panel's own method (flood_ahp.py: literature-weighted AHP, plus the
# Frequency-Ratio ensemble of flood_model.py section 0.43), applied once to the
# whole country on a 0.005 degree grid (about 500 m).
#
#   factors   HAND, slope, distance to river, wetness index, monsoon rain, land
#             cover. Each is cut into five national classes, as the panel does.
#   AHP       flood_ahp weights, "flat" or "moderate relief" chosen per cell
#   FR        how much more often each class flooded than average, learned from
#             NCOP's mapped floods 2010-2025
#   ensemble  half AHP, half FR (panel's rule)
#   plains    the same test on flat land only: mountains rarely flood, which
#             makes the national score look easy
#   test      every flood year is predicted by an ensemble that never saw it;
#             the area under the ROC curve (AUC) is published. 0.5 is a coin
#             toss, 1 is perfect.
#
# One-off: `manage.py flood_watch_data --maps`. Keeps a ~100 KB picture and a
# small JSON; requests and the report only read those.
# ---------------------------------------------------------------------------

import json
import logging
import os
import uuid
from datetime import date

import numpy as np

from . import flood_ahp
from . import flood_atlas as fa
from . import flood_store as fs

logger = logging.getLogger(__name__)

RES = 0.005
NX, NY = round((fa.E - fa.W) / RES), round((fa.N - fa.S) / RES)
FACTORS = {"hand": False, "slope": False, "distance_river": False, "twi": True, "rainfall": True, "lulc": True}      # True: larger = more prone
CLASSES = ["Very low", "Low", "Moderate", "High", "Very high"]
COLORS = ["#1a9850", "#a6d96a", "#ffffbf", "#fdae61", "#d73027"]
SHARES = (0.30, 0.25, 0.20, 0.15, 0.10)           # share of land per class, lowest first


def _png_path():
    return os.path.join(fs.root(), "susceptibility.png")


def load():
    try:
        with open(os.path.join(fs.root(), "susceptibility.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _grid(ee, image, reducer, dtype=np.float32, native=None):
    """One band averaged onto the map grid."""
    import io
    import time

    import requests
    p = ee.Projection("EPSG:4326", [RES, 0, fa.W, 0, -RES, fa.N])
    img = image.reduceResolution(reducer, True, 1024).reproject(p) if native is None else image.reproject(p)
    out = np.zeros((NY, NX), dtype)
    step = NY // 4
    for top in range(0, NY, step):
        h = min(step, NY - top)
        tf = [RES, 0, fa.W, 0, -RES, fa.N - top * RES]
        for attempt in range(3):
            try:
                url = img.rename("b").toFloat().unmask(-9999).getDownloadURL({"format": "NPY", "crs": "EPSG:4326", "crs_transform": tf, "dimensions": [NX, h]})
                r = requests.get(url, timeout=400)
                r.raise_for_status()
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(8)
        out[top:top + h] = np.load(io.BytesIO(r.content), allow_pickle=False)["b"].astype(dtype)
    return np.where(out <= -9998, np.nan, out)


def _coarse(ee, image, res=0.05):
    """A 0.05 degree field (CHIRPS) read at its own resolution, then repeated onto the map grid."""
    import io

    import requests
    nx, ny = round((fa.E - fa.W) / res), round((fa.N - fa.S) / res)
    url = image.rename("b").toFloat().unmask(-9999).getDownloadURL({"format": "NPY", "crs": "EPSG:4326", "crs_transform": [res, 0, fa.W, 0, -res, fa.N], "dimensions": [nx, ny]})
    r = requests.get(url, timeout=600)
    r.raise_for_status()
    a = np.load(io.BytesIO(r.content), allow_pickle=False)["b"].astype(np.float32)
    k = round(res / RES)
    a = np.repeat(np.repeat(a, k, 0), k, 1)[:NY, :NX]
    return np.where(a <= -9998, np.nan, a)


def classes(a, valid, ascending):
    """1 (least prone) to 5, equal-count classes over the valid cells (the panel's quantile rule)."""
    v = a[valid & np.isfinite(a)]
    q = np.quantile(v, [0.2, 0.4, 0.6, 0.8])
    c = np.searchsorted(q, np.nan_to_num(a, nan=float(np.median(v))), side="right") + 1
    c = c if ascending else 6 - c
    return np.where(np.isfinite(a), c, 3).astype(np.uint8)


def auc(score, flooded):
    """Area under the ROC curve from ranks (ties share their mean rank)."""
    s, y = score.ravel(), flooded.ravel().astype(bool)
    n1, n0 = int(y.sum()), int((~y).sum())
    if not n1 or not n0:
        return None
    vals, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    ranks = np.cumsum(cnt) - (cnt - 1) / 2
    return float((ranks[inv][y].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def frequency_ratio(cls, flooded):
    """{factor: [ratio of class 1..5]} where 1 = floods as often as average."""
    base = flooded.mean()
    out = {}
    for k, c in cls.items():
        r = []
        for v in range(1, 6):
            m = c == v
            r.append(float(flooded[m].mean() / base) if m.any() and base else 1.0)
        out[k] = r
    return out


def fr_score(cls, fr):
    return sum(np.asarray([0.0] + fr[k])[c] for k, c in cls.items())


def distance(mask, limit=120):
    """Distance to the nearest True cell, in cells (chamfer by repeated growth, capped)."""
    d = np.where(mask, 0.0, np.inf).astype(np.float32)
    for _ in range(limit):
        n = d.copy()
        for dy, dx, c in ((0, 1, 1.0), (0, -1, 1.0), (1, 0, 1.0), (-1, 0, 1.0), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)):
            np.minimum(n, np.roll(d, (dy, dx), (0, 1)) + c, out=n)
        if np.array_equal(n, d):
            break
        d = n
    return np.where(np.isfinite(d), d, limit)


def _norm(a):
    lo, hi = np.quantile(a, [0.001, 0.999])
    return np.clip((a - lo) / max(hi - lo, 1e-9), 0, 1)


def ahp_score(cls, flat):
    w = {}
    for name in ("flat_relief", "moderate_relief"):
        t = flood_ahp.get_factor_weights(name, lite=True)
        t = {k: v for k, v in t.items() if k in cls}
        s = sum(t.values())
        w[name] = {k: v / s for k, v in t.items()}
    a = sum(w["flat_relief"].get(k, 0) * c for k, c in cls.items())
    b = sum(w["moderate_relief"].get(k, 0) * c for k, c in cls.items())
    return np.where(flat, a, b), w


def build(log=lambda s: None):
    from PIL import Image

    from .flood_eo import _ee
    ee = _ee()
    big, meta = fa._districts()
    k = round(RES / fa.RES)
    dist = big[k // 2::k, k // 2::k][:NY, :NX]
    outside = [i + 1 for i, m in enumerate(meta) if m["province"] == fa.OUTSIDE]
    land = (dist > 0) & ~np.isin(dist, outside)
    merit = ee.Image("MERIT/Hydro/v1_0_1")
    raw = {"hand": _grid(ee, merit.select("hnd"), ee.Reducer.mean())}
    elv, upa = _grid(ee, merit.select("elv"), ee.Reducer.mean()), np.nan_to_num(_grid(ee, merit.select("upa"), ee.Reducer.max()), nan=0)
    # slope and wetness on the map's own grid: enough to separate plains from hills at 500 m
    m = RES * 111_000
    gy, gx = np.gradient(np.nan_to_num(elv, nan=0), m, m * 0.87)
    raw["slope"] = np.degrees(np.arctan(np.hypot(gx, gy)))
    raw["twi"] = np.log(np.maximum(upa, 0.1) * 1e6 / m / np.tan(np.radians(np.maximum(raw["slope"], 0.02))))
    log("HAND, slope and wetness")
    raw["distance_river"] = distance(upa >= 500)
    log("distance to river")
    rain = ee.ImageCollection("UCSB-CHC/CHIRPS/V3/PENTAD").filterDate("2001-01-01", "2021-01-01").filter(ee.Filter.calendarRange(6, 9, "month")).sum().divide(20)
    raw["rainfall"] = _coarse(ee, rain)
    log("rain")
    lc = ee.ImageCollection("MODIS/061/MCD12Q1").sort("system:time_start", False).first().select("LC_Type1")
    # proneness of land cover, 1-5: water/wetland, cropland, urban, grass/bare, shrub, forest
    lulc = lc.remap([17, 11, 12, 14, 13, 10, 16, 9, 8, 7, 6, 5, 4, 3, 2, 1, 15], [5, 5, 4, 4, 4, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1], 3)
    raw["lulc"] = _grid(ee, lulc, None, native=True)
    log("land cover")
    valid = land & np.isfinite(raw["hand"])
    cls = {f: (np.clip(np.nan_to_num(raw[f], nan=3), 1, 5).astype(np.uint8) if f == "lulc" else classes(raw[f], valid, asc)) for f, asc in FACTORS.items()}
    flat = np.nan_to_num(raw["slope"], nan=9) < 1.5
    seen = {}
    for y, layers in fa.OBSERVED.items():
        m = fa._wms_mask(layers)
        seen[y] = m[:NY * k, :NX * k].reshape(NY, k, NX, k).mean(axis=(1, 3)) >= 0.5
        log(f"flood {y}")
    v = valid.ravel()
    C = {f: c.ravel()[v] for f, c in cls.items()}
    A, weights = ahp_score(C, flat.ravel()[v])
    Y = {y: m.ravel()[v] for y, m in seen.items()}
    F = flat.ravel()[v]                                     # the plains alone: the harder half of the test
    test = {}
    for y in Y:
        others = np.any([Y[o] for o in Y if o != y], axis=0)
        ens = 0.5 * _norm(A) + 0.5 * _norm(fr_score(C, frequency_ratio(C, others)))
        test[y] = {"ahp": round(auc(A, Y[y]), 3), "ensemble": round(auc(ens, Y[y]), 3), "hand": round(auc(-np.nan_to_num(raw["hand"].ravel()[v], nan=999), Y[y]), 3), "plains": round(auc(ens[F], Y[y][F]) or 0, 3)}
        log(f"AUC {y}: {test[y]}")
    ever = np.any(list(Y.values()), axis=0)
    fr = frequency_ratio(C, ever)
    ens = 0.5 * _norm(A) + 0.5 * _norm(fr_score(C, fr))
    cuts = np.quantile(ens, np.cumsum(SHARES)[:-1])
    zone = np.zeros(NY * NX, np.uint8)
    zone[v] = np.searchsorted(cuts, ens, side="right") + 1
    z = zone.reshape(NY, NX)
    # how often each class really flooded (leave-one-out would be similar; stated as fitted)
    cap = [round(float(ever[zone[v] == i].mean()), 3) for i in range(1, 6)]
    grab = [round(float((ever & (zone[v] == i)).sum() / max(ever.sum(), 1)), 3) for i in range(1, 6)]
    n = np.bincount(dist[valid], minlength=len(meta) + 1)
    rows = []
    for i, m in enumerate(meta):
        if m["province"] == fa.OUTSIDE or not n[i + 1]:
            continue
        c = np.bincount(z[valid & (dist == i + 1)], minlength=6)[1:]
        rows.append({"name": m["name"], "province": m["province"], "high_pct": round(100 * float(c[3] + c[4]) / float(c.sum())), "very_high_pct": round(100 * float(c[4]) / float(c.sum()))})
    rgba = np.zeros((NY, NX, 4), np.uint8)
    for i, h in enumerate(COLORS):
        rgba[z == i + 1] = [int(h[j:j + 2], 16) for j in (1, 3, 5)] + [235]
    edge = land & ((dist != np.roll(dist, 1, 0)) | (dist != np.roll(dist, 1, 1)))
    rgba[edge] = [70, 70, 70, 130]
    ys, xs = np.flatnonzero(land.any(1)), np.flatnonzero(land.any(0))
    r0, r1, c0, c1 = ys[0], ys[-1] + 1, xs[0], xs[-1] + 1
    from .flood_hydraulic import mercator_rows             # straight on a web map
    rgba = rgba[r0:r1, c0:c1][mercator_rows(fa.N - r1 * RES, fa.N - r0 * RES, r1 - r0)]
    im = Image.fromarray(rgba).resize(((c1 - c0) * 2 // 5, (r1 - r0) * 2 // 5), Image.LANCZOS)
    tmp = _png_path() + f".{uuid.uuid4().hex[:6]}.png"
    im.quantize(64).save(tmp, optimize=True)
    os.replace(tmp, _png_path())
    doc = {"built": date.today().isoformat(), "bbox": [fa.W + c0 * RES, fa.N - r1 * RES, fa.W + c1 * RES, fa.N - r0 * RES], "classes": CLASSES, "colors": COLORS, "shares": SHARES,
           "auc": test, "auc_mean": {k: round(float(np.mean([t[k] for t in test.values()])), 3) for k in ("ahp", "ensemble", "hand", "plains")},
           "flooded_share": cap, "captured": grab, "weights": weights, "frequency_ratio": {f: [round(x, 2) for x in r] for f, r in fr.items()},
           "top": sorted(rows, key=lambda r: -r["high_pct"])[:14], "districts": rows}
    tmp = os.path.join(fs.root(), f"s{uuid.uuid4().hex[:6]}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, os.path.join(fs.root(), "susceptibility.json"))
    return {"auc": doc["auc_mean"], "captured": grab, "png_kb": os.path.getsize(_png_path()) // 1024}
