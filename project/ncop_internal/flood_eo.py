# project/ncop_internal/flood_eo.py
# ---------------------------------------------------------------------------
# Daily catchment conditions for the National Flood Watch, computed by Google
# Earth Engine for NCOP's own six watershed polygons (GeoServer water_shed)
# and kept in one small file (media/floodwatch/eo_v1.npz, < 300 KB). Requests
# and the digest build only read that file.
#
#   obs    GPM IMERG V07 satellite rain, mm per day (UTC day), Jun 2016 ->
#   gfs    NOAA GFS 00Z run of that day: forecast rain for day 1..7, mm
#          (2016 -> for days 1-3, so the river model is trained on the
#          forecasts that were really available, not on perfect hindsight)
#   ifs    ECMWF IFS open forecast, day 1..7 (latest run only: a second opinion)
#   smap   NASA SMAP L4 root-zone soil wetness, daily, Apr 2015 ->
#   snow   MODIS snow-cover share, 8-day steps, 2001 -> (Indus, Kabul, Jhelum)
#
# Fill: `manage.py flood_watch_data --backfill` (once, ~10 min);
# refresh: `--update` (every 6-12 h, under a minute).
# ---------------------------------------------------------------------------

import json
import logging
import os
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone

import numpy as np
import requests
from django.conf import settings

from .flood_store import DAY0, day_index, index_day, root

logger = logging.getLogger(__name__)

CATCHMENTS = ["Tarbela", "Kabul", "Mangla", "Chenab", "Ravi", "Sutlej"]
WFS = "http://172.18.7.35:8080/geoserver/wfs"
LEADS = 7
TRAIN_FROM = date(2016, 6, 1)
SEASON = (6, 7, 8, 9, 10)            # training months; live updates run all year
_lock = threading.Lock()
_memo = {"mtime": None, "doc": None}


def _path():
    return os.path.join(root(), "eo_v1.npz")


def load():
    p = _path()
    if not os.path.exists(p):
        return None
    mt = os.path.getmtime(p)
    with _lock:
        if _memo["mtime"] == mt:
            return _memo["doc"]
    with np.load(p, allow_pickle=False) as z:
        doc = {k: z[k] for k in z.files}
    doc["updated"] = str(doc["updated"])
    for k in ("ifs_run", "roll_end", "snow_to", "gfs_run"):
        doc[k] = str(doc.get(k, ""))
    with _lock:
        _memo.update(mtime=mt, doc=doc)
    return doc


def _save(doc):
    tmp = _path() + f".{uuid.uuid4().hex[:6]}.tmp.npz"
    np.savez_compressed(tmp, **{k: v for k, v in doc.items() if k != "updated"}, updated=datetime.now(timezone.utc).isoformat())
    os.replace(tmp, _path())


# ------------------------------------------------------------- Earth Engine
def _ee():
    import ee
    try:
        ee.Number(1).getInfo()
    except Exception:
        ee.Initialize(project=getattr(settings, "GEE_PROJECT_ID", None))
    return ee


def _fc(ee):
    from shapely.geometry import mapping, shape
    j = requests.get(WFS, params={"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": "gcop:water_shed",
                                  "outputFormat": "application/json", "srsName": "EPSG:4326"}, timeout=120).json()
    got = {f["properties"]["name"].replace(" Catchment", ""): shape(f["geometry"]).buffer(0).simplify(0.03) for f in j["features"]}
    miss = [c for c in CATCHMENTS if c not in got]
    if miss:
        raise ValueError(f"watershed layer lacks {miss}")
    return ee.FeatureCollection([ee.Feature(ee.Geometry(json.loads(json.dumps(mapping(got[c]))), None, False), {"i": i})
                                 for i, c in enumerate(CATCHMENTS)])


def _means(ee, fc, images, scale):
    """[catchment, image] means; images already exist server-side."""
    out = np.full((len(CATCHMENTS), len(images)), np.nan, np.float32)
    if not images:
        return out
    stack = ee.Image.cat([im.rename(f"b{k}") for k, im in enumerate(images)])
    for attempt in range(3):
        try:
            feats = stack.reduceRegions(fc, ee.Reducer.mean(), scale, tileScale=4).select([".*"], None, False).getInfo()["features"]
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    for f in feats:
        p = f["properties"]
        for k in range(len(images)):
            v = p.get(f"b{k}", p.get("mean") if len(images) == 1 else None)
            if v is not None:
                out[p["i"], k] = v
    return out


def _run(ee, fc, days, make, scale, chunk):
    out = np.full((len(CATCHMENTS), len(days)), np.nan, np.float32)
    for a in range(0, len(days), chunk):
        part = days[a:a + chunk]
        out[:, a:a + len(part)] = _means(ee, fc, [make(d) for d in part], scale)
    return out


def _imerg(ee):
    col = ee.ImageCollection("NASA/GPM_L3/IMERG_V07").select(["precipitation"], ["r"])
    none = ee.ImageCollection([ee.Image.constant(0).toFloat().rename("r").updateMask(0)])

    def make(d):
        s = ee.Date(d.isoformat())
        return col.filterDate(s, s.advance(1, "day")).merge(none).sum().multiply(0.5)
    return make


def _gfs(ee, k):
    """Forecast rain of day k of the 00Z run: the sum of its four 6-hour totals. (Checked against
    satellite rain over the whole archive: the band restarts every 6 hours in all years.)"""
    col = ee.ImageCollection("NOAA/GFS0P25").select(["total_precipitation_surface"], ["r"])
    none = ee.ImageCollection([ee.Image.constant(0).toFloat().rename("r").updateMask(0)])     # keeps a (masked) band when a run lacks that hour

    def make(d):
        s = ee.Date(d.isoformat())
        run = col.filter(ee.Filter.eq("creation_time", s.millis()))
        at = lambda hours: run.filter(ee.Filter.inList("forecast_hours", hours)).merge(none).sum()
        return at([24 * (k - 1) + h for h in (6, 12, 18, 24)])
    return make


def _smap(ee):
    col = ee.ImageCollection("NASA/SMAP/SPL4SMGP/008").select(["sm_rootzone_wetness"], ["r"]).map(lambda i: i.toFloat())
    none = ee.ImageCollection([ee.Image.constant(0).toFloat().rename("r").updateMask(0)])

    def make(d):
        s = ee.Date(d.isoformat())
        return col.filterDate(s, s.advance(1, "day")).merge(none).mean()
    return make


def _snow(ee):
    col = ee.ImageCollection("MODIS/061/MOD10A1").select(["NDSI_Snow_Cover"], ["r"]).map(lambda i: i.toFloat())
    none = ee.ImageCollection([ee.Image.constant(0).toFloat().rename("r").updateMask(0)])

    def make(d):
        s = ee.Date(d.isoformat())
        im = col.filterDate(s, s.advance(8, "day")).merge(none).max()      # clearest view in 8 days
        return im.gte(40).multiply(100)
    return make


def _latest(ee, cid, days=12):
    t = date.today()
    col = ee.ImageCollection(cid).filterDate((t - timedelta(days=days)).isoformat(), (t + timedelta(days=1)).isoformat())
    return datetime.fromtimestamp(col.aggregate_max("system:time_start").getInfo() / 1000, timezone.utc)


def _season_days(a, b):
    return [d for d in (a + timedelta(days=k) for k in range((b - a).days + 1)) if d.month in SEASON]


def refresh(backfill=False, log=lambda s: None):
    """Create or extend the store. Safe to run often; a broken first fill continues where it stopped."""
    ee = _ee()
    fc = _fc(ee)
    today = datetime.now(timezone.utc).date()
    n = day_index(today) + 1
    cur = load()
    doc = {}

    def grown(key, shape):
        a = np.full(shape, np.nan, np.float32)
        if cur is not None and key in cur:
            o = cur[key]
            a[..., :o.shape[-1]] = o[..., :a.shape[-1]]
        return a

    obs, gfs, smap = grown("obs", (6, n)), grown("gfs", (LEADS, 6, n)), grown("smap", (6, n))
    have = lambda a: int(np.isfinite(a).sum())
    hist = {"obs": have(obs) >= 6 * 1000, "smap": have(smap) >= 6 * 300, "snow": cur is not None and "snow" in cur and have(cur["snow"]) >= 6 * 500}
    if not backfill and not all(hist.values()):
        raise RuntimeError("no history yet: run manage.py flood_watch_data --backfill")
    last_obs = (_latest(ee, "NASA/GPM_L3/IMERG_V07") - timedelta(hours=23, minutes=20)).date()     # last complete UTC day
    last_smap = (_latest(ee, "NASA/SMAP/SPL4SMGP/008") - timedelta(hours=21)).date()

    def checkpoint():
        _save({**(cur or {}), "obs": obs, "gfs": gfs, "smap": smap, "start": 0, "last_obs": day_index(last_obs), "last_smap": day_index(last_smap),
               "snow": snow, "ifs": np.full((LEADS, 6), np.nan, np.float32), "ifs_run": ""})

    # snow: one value per calendar 8-day step, years x 46
    years = list(range(2001, today.year + 1))
    snow = np.full((6, len(years), 46), np.nan, np.float32)
    if cur is not None and "snow" in cur:
        o = cur["snow"]
        snow[:, :o.shape[1]] = o
    if not hist["obs"]:
        days = _season_days(TRAIN_FROM, last_obs)
        obs[:, [day_index(d) for d in days]] = _run(ee, fc, days, _imerg(ee), 11132, 30)
        log(f"rain observed: {len(days)} days")
        checkpoint()
    need = [d for d in (last_obs - timedelta(days=k) for k in range(45, -1, -1))
            if np.isnan(obs[:, day_index(d)]).any() or d >= last_obs - timedelta(days=3)]
    obs[:, [day_index(d) for d in need]] = _run(ee, fc, need, _imerg(ee), 11132, 30)
    log(f"rain observed through {last_obs}")

    if backfill:
        for k in (1, 2, 3):
            days = [d for d in _season_days(TRAIN_FROM, today - timedelta(days=1)) if np.isnan(gfs[k - 1][:, day_index(d)]).any()]
            if len(days) < 60:                        # the runs NOAA never archived stay missing
                continue
            gfs[k - 1][:, [day_index(d) for d in days]] = _run(ee, fc, days, _gfs(ee, k), 27830, 25)
            log(f"GFS day {k}: {len(days)} runs")
            checkpoint()
    for d in (today - timedelta(days=k) for k in range(4, -1, -1)):
        i = day_index(d)
        if np.isnan(gfs[:, :, i]).any():
            try:
                gfs[:, :, i] = _means(ee, fc, [_gfs(ee, k)(d) for k in range(1, LEADS + 1)], 27830).T
            except Exception as e:                    # the run of the day may not have arrived yet
                log(f"GFS {d}: {type(e).__name__}")
    log("GFS forecasts done")

    if not hist["smap"]:
        days = [d for d in (date(2015, 12, 1) + timedelta(days=5 * k) for k in range(2000)) if d <= last_smap]
        smap[:, [day_index(d) for d in days]] = _run(ee, fc, days, _smap(ee), 11000, 40)
        log(f"soil wetness: {len(days)} days")
        checkpoint()
    i = day_index(last_smap)
    if np.isnan(smap[:, i]).any():
        smap[:, i] = _run(ee, fc, [last_smap], _smap(ee), 11000, 1)[:, 0]

    steps = [(y, s) for y in years for s in range(46) if date(y, 1, 1) + timedelta(days=8 * s + 8) <= today - timedelta(days=2)]
    if not hist["snow"]:
        todo = steps
    else:
        todo = [x for x in steps[-3:] if np.isnan(snow[:, x[0] - 2001, x[1]]).any()]
    for a in range(0, len(todo), 40):
        part = todo[a:a + 40]
        m = _means(ee, fc, [_snow(ee)(date(y, 1, 1) + timedelta(days=8 * s)) for y, s in part], 4000)
        for k, (y, s) in enumerate(part):
            snow[:, y - 2001, s] = m[:, k]
    if not hist["snow"]:
        log("snow cover done")

    # ECMWF open forecast: latest 00Z/12Z run, days 1..7 (tp accumulates in metres)
    ifs, ifs_run = np.full((LEADS, 6), np.nan, np.float32), ""
    try:
        col = ee.ImageCollection("ECMWF/NRT_FORECAST/IFS/OPER").select("total_precipitation_sfc")
        rec = col.filterDate((today - timedelta(days=2)).isoformat(), (today + timedelta(days=1)).isoformat())
        runs = sorted(rec.filter(ee.Filter.eq("forecast_hours", 168)).aggregate_array("creation_time").distinct().getInfo())
        if runs:
            r = runs[-1]
            acc = [rec.filter(ee.Filter.eq("creation_time", r)).filter(ee.Filter.eq("forecast_hours", 24 * k)).first() for k in range(1, LEADS + 1)]
            m = _means(ee, fc, [ee.Image(x) for x in acc], 27830) * 1000
            ifs = np.diff(np.concatenate([np.zeros((6, 1), np.float32), m], axis=1), axis=1).T.astype(np.float32)
            ifs_run = datetime.fromtimestamp(r / 1000, timezone.utc).isoformat()
    except Exception as e:
        log(f"ECMWF: {type(e).__name__} {str(e)[:80]}")
    # right now: rain totals ending at the last half-hour image, and the clearest snow view of the last 8 days
    gfs_now, gfs_run = np.full((6, LEADS), np.nan, np.float32), ""
    roll, roll_end, snow_now_, snow_to = np.full((6, 4), np.nan, np.float32), "", np.full(6, np.nan, np.float32), ""
    try:
        end = _latest(ee, "NASA/GPM_L3/IMERG_V07") + timedelta(minutes=30)
        col = ee.ImageCollection("NASA/GPM_L3/IMERG_V07").select(["precipitation"], ["r"])
        e = ee.Date(end.isoformat())
        roll = _means(ee, fc, [col.filterDate(e.advance(-d, "day"), e).sum().multiply(0.5) for d in (1, 3, 7, 30)], 11132)
        roll_end = end.isoformat()
        last = _latest(ee, "MODIS/061/MOD10A1").date()
        s = ee.Date((last - timedelta(days=7)).isoformat())
        im = ee.ImageCollection("MODIS/061/MOD10A1").select(["NDSI_Snow_Cover"], ["r"]).map(lambda i: i.toFloat()).filterDate(s, s.advance(8, "day")).max()
        snow_now_, snow_to = _means(ee, fc, [im.gte(40).multiply(100)], 4000)[:, 0], last.isoformat()
        # the newest GFS run of any hour (the model training keeps to the 00Z runs)
        g = ee.ImageCollection("NOAA/GFS0P25").filterDate((today - timedelta(days=2)).isoformat(), (today + timedelta(days=1)).isoformat())
        run = max(g.filter(ee.Filter.eq("forecast_hours", 168)).aggregate_array("creation_time").distinct().getInfo())
        g = g.filter(ee.Filter.eq("creation_time", run)).select(["total_precipitation_surface"], ["r"])
        gfs_now = _means(ee, fc, [g.filter(ee.Filter.inList("forecast_hours", [24 * k + h for h in (6, 12, 18, 24)])).sum() for k in range(LEADS)], 27830)
        gfs_run = datetime.fromtimestamp(run / 1000, timezone.utc).isoformat()
    except Exception as ex:
        log(f"latest rain/snow: {type(ex).__name__} {str(ex)[:80]}")
    doc.update(obs=obs, gfs=gfs, roll=roll, roll_end=roll_end, snow_now=snow_now_, snow_to=snow_to, gfs_now=gfs_now, gfs_run=gfs_run, smap=smap, snow=snow, ifs=ifs, ifs_run=ifs_run, start=0,
               last_obs=day_index(last_obs), last_smap=day_index(last_smap))
    _save(doc)
    return {"rain": last_obs.isoformat(), "soil": last_smap.isoformat(), "ifs": ifs_run}


# --------------------------------------------------------------- indicators
def rain_percentile(doc, c, end, window):
    """(total mm, percentile among the same +/-10 calendar days of other years), or (total, None)."""
    a = doc["obs"][c]
    if end - window + 1 < 0:
        return None, None
    seg = a[end - window + 1:end + 1]
    if not np.isfinite(seg).all():
        return None, None
    tot = float(seg.sum())
    d = index_day(end)
    ref = []
    for y in range(2016, d.year):
        for off in range(-10, 11, 2):
            try:
                e = day_index(date(y, d.month, min(d.day, 28)) + timedelta(days=off))
            except ValueError:
                continue
            s = a[max(0, e - window + 1):e + 1]
            if s.size == window and np.isfinite(s).all():
                ref.append(float(s.sum()))
    if len(ref) < 25:
        return tot, None
    return tot, round(100 * float(np.mean(np.array(ref) < tot)))


def soil_percentile(doc, c):
    i = int(doc["last_smap"])
    a = doc["smap"][c]
    if not np.isfinite(a[i]):
        return None, None
    d = index_day(i)
    ref = [a[k] for k in range(a.size) if np.isfinite(a[k]) and index_day(k).year < d.year
           and min((index_day(k).timetuple().tm_yday - d.timetuple().tm_yday) % 365, (d.timetuple().tm_yday - index_day(k).timetuple().tm_yday) % 365) <= 15]
    return float(a[i]), round(100 * float(np.mean(np.array(ref) < a[i]))) if len(ref) >= 25 else None


def snow_now(doc, c):
    """Snow share of the last 8 days and the mean of earlier years at the same time; else the last stored 8-day step."""
    if doc.get("snow_to") and np.isfinite(doc["snow_now"][c]):
        last = date.fromisoformat(doc["snow_to"])
        k = max(0, (last - timedelta(days=7)).timetuple().tm_yday - 1) // 8
        ref = doc["snow"][c][:last.year - 2001, min(k, 45)]
        ref = ref[np.isfinite(ref)]
        return {"share": round(float(doc["snow_now"][c])), "normal": round(float(ref.mean())) if ref.size >= 10 else None, "to": last.isoformat()}
    s = doc["snow"][c]
    ok = np.argwhere(np.isfinite(s))
    if not ok.size:
        return None
    y, k = max((int(a), int(b)) for a, b in ok)
    ref = s[:y, k]
    ref = ref[np.isfinite(ref)]
    return {"share": round(float(s[y, k])), "normal": round(float(ref.mean())) if ref.size >= 10 else None,
            "to": (date(2001 + y, 1, 1) + timedelta(days=8 * k + 7)).isoformat()}


__all__ = ["CATCHMENTS", "DAY0", "load", "refresh"]
