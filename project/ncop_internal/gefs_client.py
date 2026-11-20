# project/ncop_internal/gefs_client.py
# ---------------------------------------------------------------------------
# NOAA GEFS (Global Ensemble Forecast System v12) 35-day outlook for NCOP's
# Weather Systems temporal layers: daily precipitation and daily-mean 2 m
# temperature over South and Southeast Asia (Iran to the Philippines, Nepal
# to Indonesia), days 1-35, from the ensemble mean.
#
# Source: NOAA Open Data on Azure (Microsoft Planetary Computer storage
# dataset "noaa-gefs"), public anonymous container
#   https://noaagefs.blob.core.windows.net/gefs/gefs.YYYYMMDD/00/atmos/...
# Accuracy: days 1-10 use the 0.25 deg product (pgrb2sp25, ~27 km); days
# 11-35 the 0.5 deg product (pgrb2ap5) — the only one that reaches 840 h.
# Only the 00Z run goes to 35 days. Days 15-35 are extended-range guidance
# (skill is in weekly patterns, not individual days); labelled as such.
#
# Efficiency (verified 2026-11-20):
#   - APCP is bucketed per 6 h at every fHHH divisible by 6 (f003 = 0-3 h,
#     f006 = 0-6 h, f009 = 6-9 h, f012 = 6-12 h ...) in both products, so the
#     140 steps f006..f840 give non-overlapping 6 h totals and the 2 m
#     temperature at the same steps; 3-hourly files are never read.
#   - Each file's .idx gives byte offsets: two HTTP range requests per step
#     (~0.9 MB at 0.25 deg, ~0.3 MB at 0.5 deg) instead of whole files.
#   - Records are decoded from memory (/vsimem/) with GDAL; only the region
#     window is read (ReadRaster: this env's gdal_array is NumPy-1 built).
#   - Steps are added into daily sums as they arrive: the build never holds
#     more than the 35 daily grids (~10 MB) plus the few steps in flight.
#   - Frames are 8-bit palette PNGs (lossless for banded data, several times
#     smaller than RGBA), classified in row strips to bound memory.
#   - Point values are float16 .npy files (~5 MB per run in memory), read
#     fully rather than memory-mapped so no file stays open and run
#     directories can always be replaced or deleted (Windows locks mapped files).
#
# Robustness: atomic build into a temp dir then rename; a cross-process
# lock prevents parallel builds; failed downloads are retried and an
# incomplete run is never published; the last good run keeps serving.
# ---------------------------------------------------------------------------

import io
import json
import logging
import math
import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import numpy as np
import requests
from django.conf import settings

logger = logging.getLogger(__name__)

ATTRIBUTION = "NOAA GEFS v12 ensemble mean (NOAA Open Data on Azure / Microsoft Planetary Computer)"
_SUBDIR = "gefs"
_TIMEOUT = 40
_RETRIES = 3
_WORKERS = 8
DAYS = 35
_DAILY_SKILL_DAYS = 14                      # beyond this: extended-range guidance
_LISTING_TTL = 1800                         # re-check for a newer run at most every 30 min
_LOCK_STALE_SECONDS = 1800
_KEEP_RUNS = 2
DATA_VERSION = 2                            # bump when region/grids change: forces a rebuild

# South & Southeast Asia: Iran (44 E) to the Philippines/Indonesia (141 E),
# Timor (11 S) to the Pamirs/Kashmir (40 N). Cell centres on both grids.
REGION = {"west": 44.0, "east": 141.0, "south": -11.0, "north": 40.0}

# Products: blob path, resolution, leads, upscale for rendering. Upscale
# gives ~2,330 px wide frames for both, so crispness is uniform.
_HR = {"key": "hr", "path": "pgrb2sp25/geavg.t00z.pgrb2s.0p25", "res": 0.25, "leads": list(range(6, 241, 6)), "upscale": 6}
_LR = {"key": "lr", "path": "pgrb2ap5/geavg.t00z.pgrb2a.0p50", "res": 0.5, "leads": list(range(246, 841, 6)), "upscale": 12}
_PRODUCTS = (_HR, _LR)
_HR_DAYS = 10                               # days 1-10 from 0.25 deg (f006..f240)
_LEADS = _HR["leads"] + _LR["leads"]        # 140 steps


def _product(lead):
    return _HR if lead <= 240 else _LR


def _day_product(day):
    return _HR if day <= _HR_DAYS else _LR


def _grid_shape(prod):
    res = prod["res"]
    return (int(round((REGION["north"] - REGION["south"]) / res)) + 1,
            int(round((REGION["east"] - REGION["west"]) / res)) + 1)


_RECORDS = {
    "precip": ":APCP:surface:",
    "t2m": ":TMP:2 m above ground:",
}


# Colour classes. Each scale has `bounds` b0..bK-1 and K+1 colours:
# class 0 = v < b0, class i = b[i-1] <= v < b[i], class K = v >= b[K-1].
# Discrete classes (not a smooth ramp) so every band is a clearly
# different colour; class boundaries are also outlined (render_png).
# The frontend legend (temporal-layer-legends.js) uses the same values.
# Precipitation: < 0.5 mm/day is transparent so dry areas show the basemap.
def _interp_colors(anchors, values):
    xs = [a[0] for a in anchors]
    out = []
    for v in values:
        rgb = [int(round(np.interp(v, xs, [int(a[1][k:k + 2], 16) for a in anchors]))) for k in (1, 3, 5)]
        out.append("#%02x%02x%02x" % tuple(rgb))
    return out


_T2M_BOUNDS = list(range(-27, 46, 3))                     # 25 bounds, 3 deg C classes
_T2M_CENTRES = [-28.5] + [b + 1.5 for b in _T2M_BOUNDS]   # 26 classes
_T2M_ANCHORS = [(-30, "#4a0a77"), (-21, "#3a2fc0"), (-12, "#2c6fe6"), (-4, "#25b5ee"), (1, "#5fe3d2"),
                (7, "#4fd26b"), (13, "#b7eb3c"), (19, "#ffe23a"), (25, "#ffac2a"), (31, "#f5612a"),
                (37, "#d4202a"), (43, "#8f0a2a"), (47, "#5a0620")]

COLORSCALES = {
    "precip": {
        "unit": "mm/day",
        "bounds": [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 40, 50, 75, 100],
        "colors": [None, "#c6ecff", "#8ad4ff", "#46a6ff", "#1f66e0", "#16a34a", "#7bd84b", "#f1e40c", "#ffb000",
                   "#ff7300", "#e6261f", "#a8002f", "#d22cc8", "#8a1fb0", "#ffd6ff"],
    },
    "t2m": {
        "unit": "°C",
        "bounds": _T2M_BOUNDS,
        "colors": _interp_colors(_T2M_ANCHORS, _T2M_CENTRES),
    },
}
_CLASS_ALPHA = 238          # near-opaque bands; the map layer adds its own opacity
_EDGE_DARKEN = 0.55         # class-boundary line = band colour x 0.55
_STRIP_ROWS = 256           # classification strip height (bounds memory)
RENDER_VERSION = 3          # bump when the look changes: runs are re-rendered from stored values

_RUN_RE = re.compile(r"^\d{10}$")
_state = {"listing_at": 0.0, "latest": None}
_state_lock = threading.Lock()
_build_thread = {"t": None}
_session_local = threading.local()


class GefsUnavailable(Exception):
    """No built GEFS run is available."""


def base_url():
    return getattr(settings, "GEFS_BLOB_BASE_URL", "https://noaagefs.blob.core.windows.net/gefs").rstrip("/")


def _sess():
    s = getattr(_session_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"User-Agent": "NCOP-NDMA/1.0 (National Common Operating Picture; GEFS outlook layers)"})
        _session_local.s = s
    return s


def _get(url, headers=None):
    last = None
    for attempt in range(_RETRIES):
        try:
            r = _sess().get(url, headers=headers or {}, timeout=_TIMEOUT)
            if r.status_code in (200, 206):
                return r
            last = RuntimeError(f"HTTP {r.status_code} for {url}")
            if r.status_code == 404:
                break
        except requests.RequestException as e:
            last = e
        time.sleep(0.8 * (attempt + 1))
    raise last


def _root():
    path = os.path.join(settings.MEDIA_ROOT, _SUBDIR)
    os.makedirs(path, exist_ok=True)
    return path


def _file_url(run, lead):
    return f"{base_url()}/gefs.{run[:8]}/00/atmos/{_product(lead)['path']}.f{lead:03d}"


# ---------------------------------------------------------------------------
# Run discovery
# ---------------------------------------------------------------------------

def _listing(prefix):
    names, marker = [], ""
    for _ in range(5):
        url = f"{base_url()}?restype=container&comp=list&prefix={prefix}&maxresults=5000" + (f"&marker={marker}" if marker else "")
        xml = _get(url).text
        names += re.findall(r"<Name>([^<]+)</Name>", xml)
        m = re.search(r"<NextMarker>([^<]+)</NextMarker>", xml)
        if not m:
            break
        marker = m.group(1)
    return set(names)


def run_complete(run):
    """True when every file this build needs (data + .idx, both products) is uploaded."""
    for prod in _PRODUCTS:
        prefix = f"gefs.{run[:8]}/00/atmos/{prod['path']}.f"
        names = _listing(prefix)
        need = {f"{prefix}{h:03d}" for h in prod["leads"]}
        if not (need <= names and {f"{n}.idx" for n in need} <= names):
            return False
    return True


def find_latest_complete_run(now=None, lookback_days=4):
    now = now or datetime.now(timezone.utc)
    for back in range(lookback_days + 1):
        run = (now - timedelta(days=back)).strftime("%Y%m%d") + "00"
        try:
            if run_complete(run):
                return run
        except Exception:
            logger.warning("gefs_client: listing failed for %s", run, exc_info=True)
    return None


# ---------------------------------------------------------------------------
# Fetch + decode one step
# ---------------------------------------------------------------------------

def _byte_range(idx_text, pattern):
    lines = [ln for ln in idx_text.strip().splitlines() if ln.strip()]
    for i, ln in enumerate(lines):
        if pattern in ln:
            start = int(ln.split(":")[1])
            end = int(lines[i + 1].split(":")[1]) - 1 if i + 1 < len(lines) else None
            return start, end, ln
    raise ValueError(f"record {pattern!r} not in index")


def decode_window(grib_bytes):
    """Decode one GRIB2 message from memory and read only the REGION window.
    Returns float32 (rows north->south, cols west->east). Temperature comes
    back in deg C (GDAL's GRIB driver normalises units)."""
    from osgeo import gdal

    path = f"/vsimem/gefs_{uuid.uuid4().hex}.grb2"
    gdal.FileFromMemBuffer(path, grib_bytes)
    try:
        ds = gdal.Open(path)
        if ds is None:
            raise ValueError("GRIB decode failed")
        gt = ds.GetGeoTransform()
        res = gt[1]
        x0 = int(round((REGION["west"] - (gt[0] + res / 2)) / res))
        x1 = int(round((REGION["east"] - (gt[0] + res / 2)) / res))
        y0 = int(round((REGION["north"] - (gt[3] + gt[5] / 2)) / gt[5]))
        y1 = int(round((REGION["south"] - (gt[3] + gt[5] / 2)) / gt[5]))
        w, h = x1 - x0 + 1, y1 - y0 + 1
        if x0 < 0 or y0 < 0 or x1 >= ds.RasterXSize or y1 >= ds.RasterYSize:
            raise ValueError("region outside grid")
        band = ds.GetRasterBand(1)
        buf = band.ReadRaster(x0, y0, w, h, buf_type=gdal.GDT_Float32)
        arr = np.frombuffer(buf, dtype=np.float32).reshape(h, w).copy()
        nodata = band.GetNoDataValue()
        if nodata is not None:
            arr[arr == nodata] = np.nan
        ds = None
        return arr
    finally:
        gdal.Unlink(path)


def fetch_step(run, lead):
    """(lead, precip_6h_mm, t2m_degC) for one forecast step."""
    url = _file_url(run, lead)
    idx = _get(url + ".idx").text
    out = {}
    for key, pattern in _RECORDS.items():
        start, end, line = _byte_range(idx, pattern)
        if key == "precip":
            m = re.search(r"(\d+)-(\d+) hour acc", line)
            if not m or int(m.group(2)) != lead or int(m.group(2)) - int(m.group(1)) != 6:
                raise ValueError(f"unexpected APCP bucket at f{lead:03d}: {line}")
        rng = f"bytes={start}-{'' if end is None else end}"
        out[key] = decode_window(_get(url, headers={"Range": rng}).content)
    expect = _grid_shape(_product(lead))
    for key, arr in out.items():
        if arr.shape != expect:
            raise ValueError(f"f{lead:03d} {key}: grid {arr.shape} != {expect}")
    return lead, out["precip"], out["t2m"]


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

class DailyAccumulator:
    """Running daily sums: precipitation total (4 x 6 h buckets) and the mean
    of the 4 six-hourly 2 m temperatures. Day d covers lead hours
    (24(d-1), 24d]; days 1-10 on the 0.25 deg grid, 11-35 on 0.5 deg."""

    def __init__(self):
        hr, lr = _grid_shape(_HR), _grid_shape(_LR)
        self.precip = {"hr": np.zeros((_HR_DAYS,) + hr, np.float32), "lr": np.zeros((DAYS - _HR_DAYS,) + lr, np.float32)}
        self.t2m = {"hr": np.zeros((_HR_DAYS,) + hr, np.float32), "lr": np.zeros((DAYS - _HR_DAYS,) + lr, np.float32)}
        self.count = np.zeros(DAYS, np.int16)

    def add(self, lead, precip6, t2m):
        day = (lead - 1) // 24                      # 0-based
        prod = _product(lead)
        i = day if prod is _HR else day - _HR_DAYS
        self.precip[prod["key"]][i] += precip6
        self.t2m[prod["key"]][i] += t2m / 4.0
        self.count[day] += 1

    def finish(self):
        bad = [d + 1 for d in range(DAYS) if self.count[d] != 4]
        if bad:
            raise ValueError(f"incomplete days: {bad}")
        for k in ("hr", "lr"):
            np.clip(self.precip[k], 0, None, out=self.precip[k])
        return self


def day_grid(store, day):
    """The grid for a 1-based day from {'hr': ..., 'lr': ...} storage."""
    return store["hr"][day - 1] if day <= _HR_DAYS else store["lr"][day - 1 - _HR_DAYS]


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _hex_rgb(h):
    return tuple(int(h[k:k + 2], 16) for k in (1, 3, 5))


def classify(values, scale):
    """Class index per value (see COLORSCALES) as uint8; 255 for NaN.
    Done in row strips so large frames never hold int64 temporaries."""
    v = np.asarray(values)
    bounds = np.asarray(scale["bounds"], v.dtype if v.dtype.kind == "f" else np.float64)
    out = np.empty(v.shape, np.uint8)
    vv, oo = (v[None, :], out[None, :]) if v.ndim == 1 else (v, out)
    for r in range(0, vv.shape[0], _STRIP_ROWS):
        s = vv[r:r + _STRIP_ROWS]
        ci = np.searchsorted(bounds, s, side="right").astype(np.uint8)
        ci[~np.isfinite(s)] = 255
        oo[r:r + _STRIP_ROWS] = ci
    return out


def _palette(scale):
    """(palette RGBA bytes, class->index LUT, edge offset). Index 0 is
    transparent, then one entry per coloured class, then the darker
    outline shade of each coloured class."""
    pal = [(0, 0, 0, 0)]
    lut = np.zeros(256, np.uint8)
    for c, color in enumerate(scale["colors"]):
        if color:
            lut[c] = len(pal)
            pal.append((*_hex_rgb(color), _CLASS_ALPHA))
    for color in scale["colors"]:
        if color:
            r, g, b = _hex_rgb(color)
            pal.append((int(r * _EDGE_DARKEN), int(g * _EDGE_DARKEN), int(b * _EDGE_DARKEN), 255))
    edge_offset = sum(1 for c in scale["colors"] if c)
    return bytes(x for p in pal for x in p), lut, edge_offset


def palette_indices(values, scale, edges=True):
    """uint8 palette indices for a value grid, class boundaries outlined."""
    pal_bytes, lut, edge_offset = _palette(scale)
    ci = classify(values, scale)
    idx = lut[ci]                                   # 255 (NaN) -> lut[255] = 0 (transparent)
    if edges and ci.ndim == 2:
        edge = np.zeros(ci.shape, bool)
        edge[:, :-1] |= ci[:, :-1] != ci[:, 1:]
        edge[:-1, :] |= ci[:-1, :] != ci[1:, :]
        edge &= idx > 0
        idx[edge] += edge_offset
    return idx, pal_bytes


def colorize(values, scale, edges=True):
    """RGBA rendering of palette_indices (previews/tests)."""
    idx, pal = palette_indices(values, scale, edges)
    return np.frombuffer(pal, np.uint8).reshape(-1, 4)[idx]


def _merc_y(lat):
    return np.log(np.tan(np.pi / 4.0 + np.radians(lat) / 2.0))


def _upsample(grid, W, H):
    """Bicubic upsample of a cell-centred grid to W x H (edge-to-edge over
    the cell-edge extent), NaN-safe, float32."""
    from PIL import Image

    g = np.asarray(grid, np.float32)
    finite = np.isfinite(g)
    fill = float(np.nanmean(g)) if finite.any() else 0.0
    up = np.asarray(Image.fromarray(np.where(finite, g, fill).astype(np.float32), "F").resize((W, H), Image.BICUBIC),
                    np.float32)
    if not finite.all():
        mask = np.asarray(Image.fromarray(finite.astype(np.uint8) * 255, "L").resize((W, H), Image.NEAREST)) > 0
        up = np.where(mask, up, np.nan)
    return up


def frame_coords(res):
    west, east = REGION["west"] - res / 2, REGION["east"] + res / 2
    north, south = REGION["north"] + res / 2, REGION["south"] - res / 2
    return [[west, north], [east, north], [east, south], [west, south]]


def render_png(grid, var, res, upscale):
    """Crisp banded 8-bit palette PNG positioned for a Mapbox image source.
    Values are bicubic-upsampled on the lat/lon grid (smooth contours), rows
    then picked at equal Web-Mercator spacing so the image registers when
    stretched between its corners, classified into colour bands, and class
    boundaries outlined. Returns (bytes, coords)."""
    from PIL import Image

    ny, nx = grid.shape
    W, H = nx * upscale, ny * upscale
    lin = _upsample(grid, W, H)                         # rows linear in latitude
    (west, north), _, (east, south), _ = frame_coords(res)
    my = np.linspace(_merc_y(north), _merc_y(south), H, endpoint=False) + (_merc_y(south) - _merc_y(north)) / H / 2
    lats = np.degrees(2.0 * np.arctan(np.exp(my)) - np.pi / 2.0)
    rows = np.clip(((north - lats) / (north - south) * H).astype(int), 0, H - 1)
    vals = lin[rows]
    del lin
    if var == "precip":
        np.clip(vals, 0, None, out=vals)                # bicubic overshoot never shows negative rain
    idx, pal = palette_indices(vals, COLORSCALES[var])
    del vals
    img = Image.fromarray(idx, "P")
    img.putpalette(pal, rawmode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), frame_coords(res)


def _stats(a):
    a = np.asarray(a, np.float32)
    f = a[np.isfinite(a)]
    if not f.size:
        return None
    return {"min": round(float(f.min()), 1), "mean": round(float(f.mean()), 1), "max": round(float(f.max()), 1)}


# ---------------------------------------------------------------------------
# Build / publish
# ---------------------------------------------------------------------------

def _lock_path():
    return os.path.join(_root(), ".build.lock")


def _acquire_lock():
    path = _lock_path()
    try:
        if os.path.exists(path) and time.time() - os.path.getmtime(path) > _LOCK_STALE_SECONDS:
            os.remove(path)  # a crashed build left it behind
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        return False


def _release_lock():
    try:
        os.remove(_lock_path())
    except OSError:
        pass


def _read_manifest(run):
    try:
        with open(os.path.join(_root(), run, "manifest.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def built_runs(current_only=True):
    """Published runs, oldest first. current_only: built with this DATA_VERSION
    (region/grids); older ones are still servable while a rebuild runs."""
    out = []
    for d in sorted(os.listdir(_root())):
        if not _RUN_RE.match(d):
            continue
        m = _read_manifest(d)
        if m and (not current_only or m.get("data_version") == DATA_VERSION):
            out.append(d)
    return out


def _scales_out():
    return {k: {"unit": v["unit"], "bounds": v["bounds"], "colors": v["colors"]} for k, v in COLORSCALES.items()}


def _save_values(dirpath, acc):
    for var, store in (("precip", acc.precip), ("t2m", acc.t2m)):
        for k, arr in store.items():
            np.save(os.path.join(dirpath, f"{var}_{k}.npy"), np.round(arr, 1).astype(np.float16))


def _load_values(dirpath):
    return {var: {k: np.load(os.path.join(dirpath, f"{var}_{k}.npy")) for k in ("hr", "lr")} for var in _RECORDS}


def _render_frames(dirpath, run, values):
    """Render all frames of a run into dirpath (one frame in memory at a time)."""
    init = datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    frames = {"precip": [], "t2m": []}
    for var in ("precip", "t2m"):
        for d in range(1, DAYS + 1):
            prod = _day_product(d)
            grid = np.asarray(day_grid(values[var], d), np.float32)
            png, coords = render_png(grid, var, prod["res"], prod["upscale"])
            name = f"{var}_d{d:02d}_r{RENDER_VERSION}.png"   # versioned: no stale browser cache
            with open(os.path.join(dirpath, name), "wb") as f:
                f.write(png)
            start = init + timedelta(days=d - 1)
            frames[var].append({"day": d, "file": name, "valid_start": start.isoformat(),
                                "valid_end": (start + timedelta(days=1)).isoformat(),
                                "extended": d > _DAILY_SKILL_DAYS, "resolution_deg": prod["res"],
                                "coordinates": coords, "stats": _stats(grid)})
    return frames


def _publish(tmp, run):
    """Move a finished build into place; replaces an older build of the same run."""
    final = os.path.join(_root(), run)
    old = None
    if os.path.exists(final):
        old = os.path.join(_root(), f".old-{run}-{uuid.uuid4().hex[:6]}")
        os.replace(final, old)
    os.replace(tmp, final)
    if old:
        shutil.rmtree(old, ignore_errors=True)


def build_run(run):
    """Download, aggregate, render and atomically publish one run.
    Returns True on success; False if another process holds the lock."""
    if not _RUN_RE.match(run or ""):
        raise ValueError("invalid run")
    if run in built_runs():
        return True
    if not _acquire_lock():
        return False
    tmp = os.path.join(_root(), f".tmp-{run}-{uuid.uuid4().hex[:6]}")
    try:
        t0 = time.time()
        acc = DailyAccumulator()
        with ThreadPoolExecutor(max_workers=_WORKERS, thread_name_prefix="gefs") as ex:
            futures = [ex.submit(fetch_step, run, h) for h in _LEADS]
            try:
                for fut in as_completed(futures):
                    lead, p, t = fut.result()
                    acc.add(lead, p, t)
            except Exception:
                for f in futures:
                    f.cancel()
                raise
        acc.finish()
        t_dl = time.time() - t0
        os.makedirs(tmp)
        _save_values(tmp, acc)
        del acc
        frames = _render_frames(tmp, run, _load_values(tmp))
        init = datetime.strptime(run, "%Y%m%d%H").replace(tzinfo=timezone.utc)
        manifest = {"run": run, "init_time": init.isoformat(), "days": DAYS, "daily_skill_days": _DAILY_SKILL_DAYS,
                    "hr_days": _HR_DAYS, "region": REGION, "frames": frames, "colorscales": _scales_out(),
                    "data_version": DATA_VERSION, "render_version": RENDER_VERSION,
                    "built_at": datetime.now(timezone.utc).isoformat(),
                    "download_seconds": round(t_dl, 1), "build_seconds": round(time.time() - t0, 1),
                    "attribution": ATTRIBUTION}
        with open(os.path.join(tmp, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f)
        _publish(tmp, run)
        logger.info("gefs_client: built run %s in %.1fs (download %.1fs)", run, time.time() - t0, t_dl)
        _prune()
        return True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        _release_lock()


def rerender_run(run):
    """Re-draw an already built run from its stored values (no download)
    when the rendering changed. Old frames are removed only after the new
    manifest is in place. Runs from an older DATA_VERSION are left alone
    (they are rebuilt instead)."""
    d = os.path.join(_root(), run)
    m = _read_manifest(run)
    if not m or m.get("data_version") != DATA_VERSION or m.get("render_version") == RENDER_VERSION:
        return False
    frames = _render_frames(d, run, _load_values(d))
    old = {fr["file"] for v in m["frames"].values() for fr in v}
    m.update(frames=frames, colorscales=_scales_out(), render_version=RENDER_VERSION)
    tmp = os.path.join(d, f".manifest-{uuid.uuid4().hex[:6]}.json")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f)
    os.replace(tmp, os.path.join(d, "manifest.json"))
    for name in old - {fr["file"] for v in frames.values() for fr in v}:
        try:
            os.remove(os.path.join(d, name))
        except OSError:
            pass
    logger.info("gefs_client: re-rendered run %s (render v%s)", run, RENDER_VERSION)
    return True


def _rerender_outdated():
    if not _acquire_lock():
        return
    try:
        for run in built_runs():
            try:
                rerender_run(run)
            except Exception:
                logger.warning("gefs_client: re-render of %s failed", run, exc_info=True)
    finally:
        _release_lock()


def _prune():
    root = _root()
    current = built_runs()
    keep = set(current[-_KEEP_RUNS:])
    for d in os.listdir(root):
        p = os.path.join(root, d)
        if _RUN_RE.match(d):
            # Older runs and older-layout runs go once a current run exists.
            if current and d not in keep:
                shutil.rmtree(p, ignore_errors=True)
        elif (d.startswith(".tmp-") or d.startswith(".old-")) and time.time() - os.path.getmtime(p) > _LOCK_STALE_SECONDS:
            shutil.rmtree(p, ignore_errors=True)   # leftovers of crashed builds


def _render_version(run):
    m = _read_manifest(run)
    return m.get("render_version") if m else None


def refresh(force_check=False):
    """Build the newest complete run if it is not built yet. Safe to call
    from a timer or a request thread; returns the run id now served."""
    with _state_lock:
        due = force_check or time.time() - _state["listing_at"] > _LISTING_TTL
        if due:
            _state["listing_at"] = time.time()
    if due:
        latest = find_latest_complete_run()
        with _state_lock:
            _state["latest"] = latest
    if any(_render_version(r) != RENDER_VERSION for r in built_runs()):
        _rerender_outdated()
    latest = _state["latest"]
    if latest and latest not in built_runs():
        build_run(latest)
    runs = built_runs()
    return runs[-1] if runs else None


def refresh_async():
    """Start a background refresh unless one is already running."""
    t = _build_thread["t"]
    if t and t.is_alive():
        return False
    t = threading.Thread(target=lambda: _safe(refresh), name="gefs-refresh", daemon=True)
    _build_thread["t"] = t
    t.start()
    return True


def _safe(fn):
    try:
        fn()
    except Exception:
        logger.warning("gefs_client: background refresh failed", exc_info=True)


def building():
    t = _build_thread["t"]
    return bool(t and t.is_alive()) or os.path.exists(_lock_path())


# ---------------------------------------------------------------------------
# Read side (what requests use)
# ---------------------------------------------------------------------------

def manifest(run=None):
    """Newest current-layout run; while none exists, the newest older one
    (still valid, smaller region) so the layer never goes blank."""
    runs = built_runs() or built_runs(current_only=False)
    if not runs:
        raise GefsUnavailable("no GEFS run built yet")
    m = _read_manifest(run or runs[-1])
    if not m:
        raise GefsUnavailable("manifest unreadable")
    return m


def frames(var, build_url):
    if var not in _RECORDS:
        raise ValueError("var must be precip or t2m")
    m = manifest()
    # Keep the served run fresh without blocking: a newer run (or a
    # re-render / new-layout rebuild) is prepared in the background and
    # picked up by the next request.
    stale_layout = m.get("data_version") != DATA_VERSION or m.get("render_version") != RENDER_VERSION
    if stale_layout or time.time() - _state["listing_at"] > _LISTING_TTL:
        refresh_async()
    run = m["run"]
    legacy = m.get("coordinates")
    return {
        "run": run, "init_time": m["init_time"], "var": var, "days": m["days"],
        "daily_skill_days": m["daily_skill_days"], "unit": m["colorscales"][var]["unit"],
        "colorscale": m["colorscales"][var], "region": m.get("region"),
        "frames": [{**fr, "coordinates": fr.get("coordinates") or legacy, "url": build_url(f"{run}/{fr['file']}")}
                   for fr in m["frames"][var]],
        "attribution": ATTRIBUTION, "building_newer": building() or stale_layout,
    }


_values_cache = {"run": None, "data": None}
_values_lock = threading.Lock()


def _cell_value(grid, res, lat, lon):
    fx = (lon - REGION["west"]) / res
    fy = (REGION["north"] - lat) / res
    ny, nx = grid.shape
    if not (-0.5 <= fx <= nx - 0.5 and -0.5 <= fy <= ny - 0.5):
        return None, None
    x, y = int(min(max(round(fx), 0), nx - 1)), int(min(max(round(fy), 0), ny - 1))
    v = float(grid[y, x])
    return (None if not math.isfinite(v) else round(v, 1)), {"lat": REGION["north"] - y * res, "lon": REGION["west"] + x * res}


def point_value(var, day, lat, lon):
    if var not in _RECORDS:
        raise ValueError("var must be precip or t2m")
    day = int(day)
    if not 1 <= day <= DAYS:
        raise ValueError("day out of range")
    lat, lon = float(lat), float(lon)
    runs = built_runs()
    if not runs:
        raise GefsUnavailable("no current GEFS run built yet")
    run = runs[-1]
    with _values_lock:
        if _values_cache["run"] != run:
            _values_cache.update(run=run, data=_load_values(os.path.join(_root(), run)))
        data = _values_cache["data"]
    unit = COLORSCALES[var]["unit"]
    prod = _day_product(day)
    value, cell = _cell_value(day_grid(data[var], day), prod["res"], lat, lon)
    if cell is None:
        return {"run": run, "var": var, "day": day, "value": None, "unit": unit, "note": "outside the GEFS window"}
    week = None
    if var == "precip":
        d0 = (day - 1) // 7 * 7 + 1
        vals = [_cell_value(day_grid(data["precip"], d), _day_product(d)["res"], lat, lon)[0] for d in range(d0, d0 + 7)]
        week = round(sum(v for v in vals if v is not None), 1)
    return {"run": run, "var": var, "day": day, "value": value, "unit": unit, "week_total": week, "cell": cell,
            "resolution_deg": prod["res"], "extended": day > _DAILY_SKILL_DAYS, "attribution": ATTRIBUTION}


def health():
    return {"built_runs": built_runs(current_only=False), "current_layout_runs": built_runs(), "building": building(),
            "latest_complete_upstream": _state["latest"], "region": REGION, "data_version": DATA_VERSION,
            "listing_age_s": round(time.time() - _state["listing_at"]) if _state["listing_at"] else None}
