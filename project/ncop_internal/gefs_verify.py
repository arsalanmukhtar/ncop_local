# project/ncop_internal/gefs_verify.py
# ---------------------------------------------------------------------------
# Verification / backtest harness for the GEFS 35-day district outlook.
# Offline tooling only — nothing here runs in a web request.
#
#   1. Archived GEFS runs (NOAA Open Data on AWS, same GEFSv12 model as the
#      live feed) are fetched with the live pipeline's own decode/aggregate
#      code into media/gefs_backtest/<run>/ (same file layout as live runs).
#   2. "Truth" = NASA POWER daily regional grids over Pakistan (UTC days):
#      PRECTOTCORR (IMERG-based precipitation, mm/day) and T2M (MERRA-2
#      daily-mean 2 m temperature, deg C). Cached once per period.
#   3. Forecast and truth are both reduced to the 163 district area means
#      (the district index of gefs_districts.py), then scored per lead day
#      and per lead week: bias, MAE, RMSE, and the correlation of anomalies
#      (forecast and truth minus their own mean per district and calendar
#      week across all cases — the standard S2S skill measure).
#
#   python manage.py gefs_backtest fetch   --dates 2026-01-15,...
#   python manage.py gefs_backtest truth   --start 2025-11-25 --end 2026-11-20
#   python manage.py gefs_backtest score   [--json out.json]
# ---------------------------------------------------------------------------

import json
import logging
import os
import re
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta

import numpy as np
from django.conf import settings

from . import gefs_client as gc
from . import gefs_districts as gd

logger = logging.getLogger(__name__)

ARCHIVE_BASE = "https://noaa-gefs-pds.s3.amazonaws.com"
POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/regional"
# Pakistan in 4 boxes (POWER regional requests are limited in size).
POWER_BOXES = [(60.0, 69.0, 23.0, 30.0), (69.0, 78.0, 23.0, 30.0), (60.0, 69.0, 30.0, 37.5), (69.0, 78.0, 30.0, 37.5)]
POWER_PARAMS = {"precip": "PRECTOTCORR", "t2m": "T2M"}
MAX_LAG = 3


def root():
    p = os.path.join(settings.MEDIA_ROOT, "gefs_backtest")
    os.makedirs(p, exist_ok=True)
    return p


# ------------------------------------------------------------ archive runs
def _archive_url(run, lead):
    return f"{ARCHIVE_BASE}/gefs.{run[:8]}/00/atmos/{gc._product(lead)['path']}.f{lead:03d}"


def _fetch_archive_step(run, lead):
    url = _archive_url(run, lead)
    idx = gc._get(url + ".idx").text
    out = {}
    for key, pattern in gc._RECORDS.items():
        start, end, line = gc._byte_range(idx, pattern)
        if key == "precip":
            m = re.search(r"(\d+)-(\d+) hour acc", line)
            if not m or int(m.group(2)) != lead or int(m.group(2)) - int(m.group(1)) != 6:
                raise ValueError(f"unexpected APCP bucket at f{lead:03d}: {line}")
        out[key] = gc.decode_window(gc._get(url, headers={"Range": f"bytes={start}-{'' if end is None else end}"}).content)
    return lead, out["precip"], out["t2m"]


def fetch_run(run, workers=8):
    """Fetch one archived run into media/gefs_backtest/<run>/ (resumable)."""
    dest = os.path.join(root(), run)
    if os.path.exists(os.path.join(dest, "done")):
        return dest
    tmp = dest + f".tmp{uuid.uuid4().hex[:6]}"
    os.makedirs(tmp)
    try:
        acc = gc.DailyAccumulator()
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for fut in as_completed([ex.submit(_fetch_archive_step, run, h) for h in gc._LEADS]):
                lead, p, t = fut.result()
                acc.add(lead, p, t)
        acc.finish()
        gc._save_values(tmp, acc)
        open(os.path.join(tmp, "done"), "w").close()
        shutil.rmtree(dest, ignore_errors=True)
        os.replace(tmp, dest)
        return dest
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def compact_run(run, weights, meta):
    """Keep only the district series of a fetched run (~50 KB instead of
    ~5 MB of grids); scoring and calibration need nothing else."""
    d = os.path.join(root(), run)
    district_forecast(run, weights, meta)
    for name in os.listdir(d):
        if name.endswith(".npy"):
            os.remove(os.path.join(d, name))


def runs_for(init_dates, max_lag=MAX_LAG):
    """Every run needed to score these init dates with up to max_lag lags."""
    out = set()
    for d in init_dates:
        for k in range(max_lag + 1):
            out.add((d - timedelta(days=k)).strftime("%Y%m%d") + "00")
    return sorted(out)


# ---------------------------------------------------------------- truth
def _power_box(param, box, start, end):
    import requests

    w, e, s, n = box
    for attempt in range(4):
        r = requests.get(POWER_URL, params={"parameters": param, "community": "AG", "longitude-min": w, "longitude-max": e,
                                            "latitude-min": s, "latitude-max": n, "start": start.strftime("%Y%m%d"),
                                            "end": end.strftime("%Y%m%d"), "time-standard": "UTC", "format": "JSON"},
                         timeout=300)
        if r.status_code == 200:
            return r.json()["features"]
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"POWER {param} {box}: HTTP {r.status_code} {r.text[:200]}")


def fetch_truth(var, start, end):
    """Daily POWER grid for Pakistan -> cached npz {lons, lats, dates, values[day, point]}."""
    path = os.path.join(root(), f"truth_{var}_{start:%Y%m%d}_{end:%Y%m%d}.npz")
    if os.path.exists(path):
        return path
    pts, series = [], []
    chunks, s = [], start
    while s <= end:                                   # POWER: <= 366 days per request
        e = min(end, s + timedelta(days=365))
        chunks.append((s, e))
        s = e + timedelta(days=1)
    by_point = {}
    for box in POWER_BOXES:
        for cs, ce in chunks:
            for f in _power_box(POWER_PARAMS[var], box, cs, ce):
                lon, lat = (round(c, 4) for c in f["geometry"]["coordinates"][:2])
                vals = f["properties"]["parameter"][POWER_PARAMS[var]]
                by_point.setdefault((lon, lat), {}).update(vals)
    dates = [(start + timedelta(days=i)) for i in range((end - start).days + 1)]
    keys = sorted(by_point)
    arr = np.full((len(dates), len(keys)), np.nan, np.float32)
    for j, k in enumerate(keys):
        d = by_point[k]
        for i, dt in enumerate(dates):
            v = d.get(dt.strftime("%Y%m%d"))
            if v is not None and v > -900:            # POWER fill value -999
                arr[i, j] = v
    np.savez_compressed(path, lons=np.array([k[0] for k in keys]), lats=np.array([k[1] for k in keys]),
                        dates=np.array([d.isoformat() for d in dates]), values=arr)
    return path


def district_truth(var, truth_path, weights, n_districts):
    """Truth area means per district: each 0.5 deg district cell takes the
    nearest POWER point; the district's LR cell weights then average them.
    Returns (dates[list of date], values[district, day])."""
    z = np.load(truth_path)
    lons, lats, vals = z["lons"], z["lats"], z["values"]
    dates = [date.fromisoformat(s) for s in z["dates"]]
    ny, nx = gc._grid_shape(gc._LR)
    w = weights["lr"]
    cy, cx = w["cell"] // nx, w["cell"] % nx
    clat = gc.REGION["north"] - cy * gc._LR["res"]
    clon = gc.REGION["west"] + cx * gc._LR["res"]
    d2 = (clat[:, None] - lats[None, :]) ** 2 + ((clon[:, None] - lons[None, :]) * np.cos(np.radians(clat[:, None]))) ** 2
    nearest = np.argmin(d2, axis=1)
    out = np.full((n_districts, len(dates)), np.nan, np.float32)
    for t in range(len(dates)):
        v = vals[t, nearest]
        ok = np.isfinite(v)
        num = np.bincount(w["district"][ok], weights=v[ok] * w["weight"][ok], minlength=n_districts)
        den = np.bincount(w["district"][ok], weights=w["weight"][ok], minlength=n_districts)
        out[:, t] = np.where(den > 0, num / np.maximum(den, 1e-9), np.nan)
    return dates, out


# --------------------------------------------------------------- forecasts
def district_forecast(run, weights, meta):
    """(precip[district, 35], t2m[district, 35]) area means for an archived run."""
    cache = os.path.join(root(), run, "districts.npz")
    if os.path.exists(cache):
        z = np.load(cache)
        return z["precip"], z["t2m"]
    st = gd.compute_stats(os.path.join(root(), run), weights, meta)
    tmp = cache + f".tmp{uuid.uuid4().hex[:6]}.npz"
    np.savez_compressed(tmp, precip=st["precip_mean"], t2m=st["t2m_mean"],
                        t2m_min=st["t2m_min"], t2m_max=st["t2m_max"], precip_max=st["precip_max"])
    os.replace(tmp, cache)
    return st["precip_mean"], st["t2m_mean"]


def lagged(series_by_lag, weights_by_lag, first_lag_day=1):
    """Combine district series of runs initialised k days earlier.
    series_by_lag[k] = array[district, 35] of the run from init-k (or None).
    Lead day d of the newest run = day d+k of run k. Days < first_lag_day
    use the newest run only. Missing runs / days drop out and the remaining
    weights are renormalised."""
    base = series_by_lag[0]
    n_d, n_t = base.shape
    num = np.zeros_like(base, dtype=np.float64)
    den = np.zeros((1, n_t))
    for k, s in enumerate(series_by_lag):
        if s is None or k >= len(weights_by_lag) or weights_by_lag[k] <= 0:
            continue
        for d in range(n_t):
            if k and d + 1 < first_lag_day:
                continue
            src = d + k
            if src >= s.shape[1]:
                continue
            num[:, d] += weights_by_lag[k] * s[:, src]
            den[0, d] += weights_by_lag[k]
    return (num / np.maximum(den, 1e-12)).astype(np.float32)


# ----------------------------------------------------------------- scoring
WEEKS = [(1, 7), (8, 14), (15, 21), (22, 28), (29, 35)]


def score(cases, var):
    """cases: list of (fc[district, 35], obs[district, 35], init_date).
    Daily and weekly-mean scores pooled over districts and cases.
    ACC uses anomalies about each district's mean for the same lead/week
    across cases (removes the climatological pattern, as in S2S skill)."""
    fc = np.stack([c[0] for c in cases])          # [case, district, day]
    ob = np.stack([c[1] for c in cases])
    res = {"daily": [], "weekly": []}

    def stats(f, o):
        ok = np.isfinite(f) & np.isfinite(o)
        f, o = f[ok], o[ok]
        if f.size < 10:
            return None
        return {"n": int(f.size), "bias": float(np.mean(f - o)), "mae": float(np.mean(np.abs(f - o))),
                "rmse": float(np.sqrt(np.mean((f - o) ** 2)))}

    def acc(f, o):                                 # f, o: [case, district]
        fa = f - np.nanmean(f, axis=0, keepdims=True)
        oa = o - np.nanmean(o, axis=0, keepdims=True)
        ok = np.isfinite(fa) & np.isfinite(oa)
        if ok.sum() < 10:
            return None
        a, b = fa[ok], oa[ok]
        den = np.sqrt(np.sum(a * a) * np.sum(b * b))
        return float(np.sum(a * b) / den) if den > 0 else None

    for d in range(fc.shape[2]):
        s = stats(fc[:, :, d], ob[:, :, d])
        if s:
            s["acc"] = acc(fc[:, :, d], ob[:, :, d])
        res["daily"].append(s)
    for a, b in WEEKS:
        f = np.nanmean(fc[:, :, a - 1:b], axis=2)
        o = np.nanmean(ob[:, :, a - 1:b], axis=2)
        if var == "precip":                         # weekly totals for rain
            f, o = f * (b - a + 1), o * (b - a + 1)
        s = stats(f, o)
        if s:
            s["acc"] = acc(f, o)
        res["weekly"].append(s)
    return res


# ---------------------------------------------------------------------------
# Phase 3 backtest: CFSv2 extension (days 29-46) and climatology baseline
# ---------------------------------------------------------------------------
CFS_FIRST, CFS_LAST = 29, 46


def cfs_case(init_day, weights, n_districts, members=None):
    """District series {var: [district, day CFS_FIRST..CFS_LAST]} of the CFSv2
    00Z member mean for init_day (cached; grids are never stored)."""
    from . import gefs_cfs as cfs

    members = members or cfs.CFS_MEMBERS
    path = os.path.join(root(), f"cfs_{init_day:%Y%m%d}_{CFS_FIRST}_{CFS_LAST}_m{len(members)}.npz")
    if os.path.exists(path):
        z = np.load(path)
        return {"precip": z["precip"], "t2m": z["t2m"]}
    grids = cfs.fetch_daily(init_day, CFS_FIRST, CFS_LAST, members)
    out = {k: cfs.district_means(v, weights, n_districts) for k, v in grids.items()}
    tmp = path + f".tmp{uuid.uuid4().hex[:6]}.npz"
    np.savez_compressed(tmp, **out)
    os.replace(tmp, path)
    return out


POWER_CLIM_URL = "https://power.larc.nasa.gov/api/temporal/climatology/regional"
_MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def fetch_climatology(var):
    """NASA POWER long-term (2001-2025) monthly normals, native grid (cached)."""
    import requests

    path = os.path.join(root(), f"clim_{var}.npz")
    if os.path.exists(path):
        return path
    seen = {}
    for (w, e, s_, n) in POWER_BOXES:
        r = requests.get(POWER_CLIM_URL, params={"parameters": POWER_PARAMS[var], "community": "AG", "longitude-min": w,
                                                 "longitude-max": e, "latitude-min": s_, "latitude-max": n,
                                                 "format": "JSON"}, timeout=300)
        r.raise_for_status()
        for f in r.json()["features"]:
            v = f["properties"]["parameter"][POWER_PARAMS[var]]
            lon, lat = f["geometry"]["coordinates"][:2]
            seen[(round(lon, 4), round(lat, 4))] = [v[m] for m in _MONTHS]
    keys = sorted(seen)
    tmp = path + f".tmp{uuid.uuid4().hex[:6]}.npz"
    np.savez_compressed(tmp, lons=np.array([k[0] for k in keys]), lats=np.array([k[1] for k in keys]),
                        monthly=np.array([seen[k] for k in keys], np.float32))
    os.replace(tmp, path)
    return path


def _nearest_cells(weights, lons, lats):
    ny, nx = gc._grid_shape(gc._LR)
    w = weights["lr"]
    cy, cx = w["cell"] // nx, w["cell"] % nx
    clat = gc.REGION["north"] - cy * gc._LR["res"]
    clon = gc.REGION["west"] + cx * gc._LR["res"]
    d2 = (clat[:, None] - lats[None, :]) ** 2 + ((clon[:, None] - lons[None, :]) * np.cos(np.radians(clat[:, None]))) ** 2
    return np.argmin(d2, axis=1)


def district_climatology(var, weights, n_districts):
    """Monthly normals per district [district, 12]."""
    z = np.load(fetch_climatology(var))
    near = _nearest_cells(weights, z["lons"], z["lats"])
    w = weights["lr"]
    den = np.bincount(w["district"], weights=w["weight"], minlength=n_districts)
    out = np.zeros((n_districts, 12), np.float32)
    for m in range(12):
        out[:, m] = np.bincount(w["district"], weights=z["monthly"][near, m] * w["weight"], minlength=n_districts)
    return out / np.maximum(den, 1e-9)[:, None]


def daily_normal(monthly, day):
    """Daily normal [district] by linear interpolation between mid-months."""
    mids = np.array([15.5 + 30.42 * i for i in range(12)])
    x = np.concatenate([[mids[-1] - 365.0], mids, [mids[0] + 365.0]])
    y = np.concatenate([monthly[:, 11:12], monthly, monthly[:, 0:1]], axis=1)
    doy = day.timetuple().tm_yday
    j = np.searchsorted(x, doy) - 1
    t = (doy - x[j]) / (x[j + 1] - x[j])
    return (y[:, j] * (1 - t) + y[:, j + 1] * t).astype(np.float32)
