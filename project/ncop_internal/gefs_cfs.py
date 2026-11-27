# project/ncop_internal/gefs_cfs.py
# ---------------------------------------------------------------------------
# NOAA CFSv2 as the free, open 45-day source for extending the GEFS outlook
# beyond day 35 (accuracy/extension phase 3).
#
# Why CFSv2: free on NOAA Open Data (AWS, no key), archive back to at least
# 2023 (so it can be backtested), 4 runs a day with 4 members each, every
# member >= 45 days, per-file .idx so only the two fields are downloaded.
# (ECMWF's 46-day ensemble is CC-BY but not in the free online tier;
# GEFSv12 stops at 35 days.)
#
# Data path: 6-hourly flux files (flxf), PRATE (kg m-2 s-1 -> mm/day) and
# TMP 2 m (deg C) on CFS's ~0.94 deg Gaussian grid, resampled bilinearly
# onto the GEFS 0.5 deg grid of REGION so districts and frames reuse the
# GEFS machinery. Day L = lead hours (24(L-1), 24L], like GEFS.
#
# Per member and day: 4 steps x 2 fields x ~60 KB = ~0.5 MB downloaded.
# Nothing global is kept: each field is resampled and added to a small
# daily accumulator immediately.
# ---------------------------------------------------------------------------

import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

import numpy as np

from . import gefs_client as gc

logger = logging.getLogger(__name__)

CFS_BASE = "https://noaa-cfs-pds.s3.amazonaws.com"
CFS_MEMBERS = ("01", "02", "03", "04")          # the 00Z cycle: all four run >= 45 days
_FIELDS = (("precip", ":PRATE:surface:"), ("t2m", ":TMP:2 m above ground:"))


def cfs_url(init_day, member, valid):
    d = init_day.strftime("%Y%m%d")
    return f"{CFS_BASE}/cfs.{d}/00/6hrly_grib_{member}/flxf{valid:%Y%m%d%H}.{member}.{d}00.grb2"


def warp_to_lr(grib_bytes):
    """Decode one CFSv2 GRIB2 message and resample it bilinearly onto the
    GEFS 0.5 deg grid of REGION. Returns float32 [ny, nx]."""
    from osgeo import gdal

    src = f"/vsimem/cfs_{uuid.uuid4().hex}.grb2"
    gdal.FileFromMemBuffer(src, grib_bytes)
    try:
        ny, nx = gc._grid_shape(gc._LR)
        r = gc._LR["res"]
        R = gc.REGION
        ds = gdal.Warp("", src, format="MEM",
                       outputBounds=(R["west"] - r / 2, R["south"] - r / 2, R["east"] + r / 2, R["north"] + r / 2),
                       width=nx, height=ny, resampleAlg="bilinear", dstSRS="EPSG:4326", outputType=gdal.GDT_Float32)
        if ds is None:
            raise ValueError("CFS resample failed")
        band = ds.GetRasterBand(1)
        a = np.frombuffer(band.ReadRaster(buf_type=gdal.GDT_Float32), np.float32).reshape(ny, nx).copy()
        nd = band.GetNoDataValue()
        if nd is not None:
            a[a == nd] = np.nan
        ds = None
        return a
    finally:
        gdal.Unlink(src)


def fetch_step(init_day, member, lead_h):
    """(precip mm/day, t2m degC) on the 0.5 deg grid for one 6-hourly step."""
    valid = datetime(init_day.year, init_day.month, init_day.day) + timedelta(hours=lead_h)
    url = cfs_url(init_day, member, valid)
    idx = gc._get(url + ".idx").text
    out = {}
    for key, pat in _FIELDS:
        st, en, _ = gc._byte_range(idx, pat)
        a = warp_to_lr(gc._get(url, headers={"Range": f"bytes={st}-{'' if en is None else en}"}).content)
        out[key] = np.clip(a * 86400.0, 0, None) if key == "precip" else a
    return out["precip"], out["t2m"]


def fetch_daily(init_day, first_day, last_day, members=CFS_MEMBERS, workers=8):
    """Member-mean daily grids {var: [day, ny, nx]} for lead days
    first_day..last_day of the 00Z CFSv2 run of init_day. Memory: two
    accumulators of (days x 103 x 195) float32 (~0.8 MB per 10 days)."""
    n_days = last_day - first_day + 1
    shape = (n_days,) + gc._grid_shape(gc._LR)
    acc = {k: np.zeros(shape, np.float32) for k, _ in _FIELDS}
    cnt = np.zeros(n_days, np.int16)
    jobs = [(m, L, h) for m in members for L in range(first_day, last_day + 1)
            for h in (24 * L - 18, 24 * L - 12, 24 * L - 6, 24 * L)]
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="cfs") as ex:
        futs = {ex.submit(fetch_step, init_day, m, h): L for m, L, h in jobs}
        try:
            for f in as_completed(futs):
                L = futs[f]
                p, t = f.result()
                acc["precip"][L - first_day] += p
                acc["t2m"][L - first_day] += t
                cnt[L - first_day] += 1
        except Exception:
            for f in futs:
                f.cancel()
            raise
    expect = 4 * len(members)
    if np.any(cnt != expect):
        raise ValueError(f"incomplete CFS days: {cnt.tolist()} (expected {expect} steps each)")
    for k in acc:
        acc[k] /= expect
    return acc


def district_means(grids, weights, n_districts):
    """[day, ny, nx] grid series -> [district, day] area means (LR weights)."""
    w = weights["lr"]
    flat = grids.reshape(grids.shape[0], -1)[:, w["cell"]]
    den = np.bincount(w["district"], weights=w["weight"], minlength=n_districts)
    out = np.stack([np.bincount(w["district"], weights=flat[d] * w["weight"], minlength=n_districts)
                    for d in range(grids.shape[0])], axis=1)
    return (out / np.maximum(den, 1e-9)[:, None]).astype(np.float32)
