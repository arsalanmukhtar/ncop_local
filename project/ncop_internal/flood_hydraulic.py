# project/ncop_internal/flood_hydraulic.py
# ---------------------------------------------------------------------------
# Catalogue of simulated river floods: how deep, how far and how soon.
#
# Built OFFLINE, once (`manage.py flood_watch_data --hydraulic`): for every
# priority reach below an FFD station the wave of a High, Very high and
# Exceptional flood is spread over the valley with the local inertial model
# (flood_inertial.py). The app only looks a scenario up: the station's FFD
# level now, or FFD's forecast level, picks the scenario. Same idea as the
# pre-computed map catalogue of GloFAS rapid flood mapping (Dottori et al.
# 2017, NHESS 17, 1111-1126).
#
#   terrain   FABDEM v1-2 (buildings and trees removed), 0.005 degree (~500 m);
#             the river's own cells use the lower part of the terrain
#   flows     FFD's official flood limits; wave shape is a design assumption
#   "likely"  chosen per river from tests on nine real floods (LIKELY below):
#             Chenab, Jhelum, Kabul: simulated water on land satellites have
#               mapped as flooded before (embankments hold where they held)
#             Ravi, Sutlej: all simulated water (2025 flooded new land there)
#             Indus: simulated water on land flooded in 2 or more mapped years;
#               the big Indus embankments are not in the terrain, so even
#               this spreads too far (agreement only 0.30-0.33: trust "Low")
#   "upper"   all simulated water: every embankment overtopped
#
# Tested on real floods with FFD's own hydrographs; the tested year's satellite
# map is left out of "likely". August-September 2025 below Qadirabad: 91% of
# the flooded land found, 26% of the marked land stayed dry (CSI 0.69); the
# upper limit finds 94% but 49% stayed dry.
#
# A wave that cannot leave its valley on the 500 m grid (gorge narrower than
# a cell) ponds and gives false depths; such reaches are left out: Nowshera to
# Attock was tried and dropped, and build() drops any reach where less than
# MIN_OUT of the water has left or where it ponds (kept in "dropped").
#
# Not in the model: embankments, gates, breaches, rain on the plain, drains.
# Depth is to a 500 m average ground level: use it as a band, not a survey.
# ---------------------------------------------------------------------------

import io
import json
import logging
import os
import time
import uuid
from concurrent.futures import ProcessPoolExecutor
from datetime import date, datetime

import numpy as np
import requests

from . import flood_atlas as fa
from . import flood_inertial as fi
from . import flood_store as fs

logger = logging.getLogger(__name__)

RES = 0.005
CFS = 35.3147
SCENARIOS = ("high", "very_high", "exceptional")
LABEL = {"high": "High flood", "very_high": "Very high flood", "exceptional": "Exceptionally high flood"}
# station -> (next station or place below, lon, lat of the end, hours simulated)
REACHES = {
    "kalabagh": ("Chashma", 71.38, 32.43, 168), "chashma": ("Taunsa", 70.84, 30.52, 264), "taunsa": ("Guddu", 69.71, 28.42, 312),
    "guddu": ("Sukkur", 68.85, 27.68, 264), "sukkur": ("Kotri", 68.32, 25.44, 384), "kotri": ("the sea", 67.75, 24.20, 312),
    "rasul": ("Trimmu", 72.15, 31.14, 288), "marala": ("Khanki", 73.97, 32.41, 144), "qadirabad": ("Trimmu", 72.15, 31.14, 312), "trimmu": ("Panjnad", 71.02, 29.35, 336),
    "shahdara": ("Balloki", 73.86, 31.22, 192), "balloki": ("Sidhnai", 72.16, 30.57, 312), "sulemanki": ("Islam", 72.55, 29.83, 264), "islam": ("Panjnad", 71.02, 29.35, 288),
}
POS = {"kalabagh": (71.5219, 32.9187), "chashma": (71.3794, 32.4359), "taunsa": (70.8367, 30.5185), "guddu": (69.7114, 28.4201), "sukkur": (68.8462, 27.679),
       "kotri": (68.3151, 25.4428), "rasul": (73.5186, 32.6832), "marala": (74.4113, 32.6606), "qadirabad": (73.6851, 32.3209), "trimmu": (72.146, 31.1448), "shahdara": (74.2956, 31.6085),
       "balloki": (73.8596, 31.2222), "sulemanki": (73.8663, 30.3777), "islam": (72.5485, 29.8263)}
# real floods used as tests: (station, year, first day, last day, flow kind)
TESTS = [("qadirabad", 2025, "2025-08-24", "2025-09-08", "out"), ("trimmu", 2025, "2025-08-26", "2025-09-12", "out"), ("shahdara", 2025, "2025-08-24", "2025-09-08", "out"),
         ("sulemanki", 2025, "2025-08-20", "2025-09-10", "out"), ("taunsa", 2022, "2022-08-15", "2022-09-05", "out"),
         ("guddu", 2025, "2025-09-01", "2025-09-24", "out"), ("sukkur", 2025, "2025-09-03", "2025-10-04", "out"), ("balloki", 2025, "2025-08-26", "2025-09-12", "out"), ("islam", 2025, "2025-08-24", "2025-09-18", "out")]
DEPTHS = [(0.3, 1.0, "#a6cee3", "0.3 to 1 m"), (1.0, 2.0, "#4292c6", "1 to 2 m"), (2.0, 4.0, "#08519c", "2 to 4 m"), (4.0, 99.0, "#4a1486", "over 4 m")]
PAD = 0.32
# river -> past flood years needed for "likely" (0 = all simulated water); from the tests, see header
LIKELY = {"Chenab": 1, "Jhelum": 1, "Kabul": 1, "Ravi": 0, "Sutlej": 0, "Indus": 2}
MODEL_KEY = "inertial-1"           # change when the solver or terrain changes: cached runs are then redone
MIN_OUT = 0.10


def directory():
    p = os.path.join(fs.root(), "hydraulic")
    os.makedirs(p, exist_ok=True)
    return p


def load():
    try:
        with open(os.path.join(directory(), "catalogue.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def box(sid):
    lon, lat = POS[sid]
    _, elon, elat, _ = REACHES[sid]
    w, e, s, n = min(lon, elon) - PAD, max(lon, elon) + PAD, min(lat, elat) - PAD, max(lat, elat) + PAD
    snap = lambda v: round(round(v / RES) * RES, 6)
    return snap(w), snap(s), snap(e), snap(n)


def _terrain(ee, sid):
    """Terrain, water share, people and cropland on the reach grid."""
    w, s, e, n = box(sid)
    nx, ny = round((e - w) / RES), round((n - s) / RES)
    p = ee.Projection("EPSG:4326", [RES, 0, w, 0, -RES, n])
    col = ee.ImageCollection("projects/sat-io/open-datasets/FABDEM")
    fab = col.mosaic().setDefaultProjection(col.first().projection())
    z = fab.reduceResolution(ee.Reducer.percentile([20, 50]), True, 1024).reproject(p).rename(["z20", "z50"])
    wet = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence").unmask(0).gte(30).reduceResolution(ee.Reducer.mean(), True, 1024).reproject(p).rename("water")
    pop = ee.Image("JRC/GHSL/P2023A/GHS_POP/2025").select("population_count").reduceResolution(ee.Reducer.sum().unweighted(), True, 256).reproject(p).rename("pop")
    lc = ee.ImageCollection("MODIS/061/MCD12Q1").sort("system:time_start", False).first().select("LC_Type1")
    crop = lc.eq(12).Or(lc.eq(14)).reproject(p).rename("crop")
    out = {}
    for img, names in ((z, ["z20", "z50"]), (wet, ["water"]), (pop, ["pop"]), (crop, ["crop"])):
        for attempt in range(3):
            try:
                u = img.toFloat().unmask(0).getDownloadURL({"format": "NPY", "crs": "EPSG:4326", "crs_transform": [RES, 0, w, 0, -RES, n], "dimensions": [nx, ny]})
                r = requests.get(u, timeout=300)
                r.raise_for_status()
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(6)
        a = np.load(io.BytesIO(r.content), allow_pickle=False)
        for k in names:
            out[k] = a[k].astype(np.float32)
    return out


def _terrain_cached(ee, sid):
    """Terrain of a reach, read from Earth Engine once and kept on disk (same box, same sources)."""
    path = os.path.join(directory(), "runs", f"terrain-{sid}-{'_'.join(f'{v:.3f}' for v in box(sid))}.npz")
    if os.path.exists(path):
        with np.load(path) as d:
            return {k: d[k] for k in d.files}
    t = _terrain(ee, sid)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path[:-4] + f".{uuid.uuid4().hex[:6]}.npz"
    np.savez_compressed(tmp, **t)
    os.replace(tmp, path)
    return t


def _wms(layers, b, nx, ny):
    from PIL import Image
    m = np.zeros((ny, nx), bool)
    for layer in layers:
        r = requests.get(f"{fa.GEOSERVER}/gcop/wms", timeout=300, params={
            "service": "WMS", "version": "1.1.1", "request": "GetMap", "sld_body": fa._FILL.format(layer=f"gcop:{layer}"), "srs": "EPSG:4326",
            "bbox": ",".join(f"{x:.6f}" for x in b), "width": nx, "height": ny, "format": "image/png", "transparent": "true"})
        r.raise_for_status()
        m |= np.array(Image.open(io.BytesIO(r.content)).convert("RGBA"))[..., 3] >= 90
    return m


def _model(sid, T):
    """Bed, roughness, cell size and source cells of one reach."""
    w, s, e, n = box(sid)
    river = T["water"] > 0.3
    z = np.where(river, T["z20"], T["z50"])
    man = np.where(river, 0.03, 0.045).astype(np.float32)
    lat = (s + n) / 2
    dx, dy = RES * 111_320 * np.cos(np.radians(lat)), RES * 110_900
    lon0, lat0 = POS[sid]
    r, c = int((n - lat0) / RES), int((lon0 - w) / RES)
    src = [(r + a, c + b) for a in (-1, 0, 1) for b in (-1, 0, 1)]
    return z, man, float(dx), float(dy), src


def _observed(sid, first, last, kind):
    """FFD hydrograph as (seconds, m3/s) from the cleaned store (daily maximum)."""
    st = fs.load()
    a, b = fs.day_index(date.fromisoformat(first)), fs.day_index(date.fromisoformat(last))
    q = st["clean"][f"{kind}max"][fs.IDS.index(sid), a:b + 1].astype(float) / CFS
    ok = np.isfinite(q)
    t = np.arange(q.size)[ok] * 86400.0
    return t, q[ok]


def scores(sim, obs, near):
    h, m, f = int((sim & obs & near).sum()), int((~sim & obs & near).sum()), int((sim & ~obs & near).sum())
    return {"csi": round(h / max(h + m + f, 1), 2), "found": round(h / max(h + m, 1), 2), "dry": round(f / max(h + f, 1), 2)}


def likely_mask(sid, deep, floods, river, leave_out=None):
    """The river's rule (LIKELY) applied to simulated water; `leave_out` = a test year whose map must not be used."""
    need = LIKELY.get(fs.STATIONS[sid][1], 1)
    if not need:
        return deep
    cnt = np.sum([v for y, v in floods.items() if y != leave_out], axis=0)
    return deep & ((cnt >= need) | river)


def test_row(sid, year, r, floods, river):
    """One real flood: simulated land against that year's satellite map, which is left out of 'likely'."""
    _, s, _, n = box(sid)
    deep = r["depth"] > 0.3
    others = np.any([v for y, v in floods.items() if y != year], axis=0)
    near = _grow(np.isfinite(r["arrive"]), 6)
    return {"station": fs.STATIONS[sid][0], "river": fs.STATIONS[sid][1], "year": int(year), "upper": scores(deep, floods[year], near),
            "likely": scores(likely_mask(sid, deep, floods, river, year), floods[year], near),
            "past_floods_only": scores(others, floods[year], near), "mapped_km2": round(float((floods[year] & near).sum()) * (RES * 111.0) ** 2 * np.cos(np.radians((s + n) / 2)))}


def trust(river, tests):
    """Trust grade of a river's waves from its own tests: High from agreement 0.6, Medium from 0.45, else Low; Low when untested."""
    c = [t["likely"]["csi"] for t in tests if t["river"] == river]
    if not c:
        return {"grade": "Low", "why": "not tested on a real flood"}
    m = float(np.mean(c))
    return {"grade": "High" if m >= 0.6 else "Medium" if m >= 0.45 else "Low", "csi": round(m, 2), "tests": len(c)}


def _run_path(sid, tag, job):
    """Cached result of one simulation, named by everything that changes it."""
    import hashlib
    z, man, dx, dy, spec, src, hours = job
    h = hashlib.sha1(MODEL_KEY.encode())
    for a in (z, man, np.asarray(src), *[np.asarray(x, float) for x in spec[1:]]):
        h.update(np.ascontiguousarray(a).tobytes())
    h.update(repr((dx, dy, hours, spec[0])).encode())
    d = os.path.join(directory(), "runs")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{sid}-{tag}-{h.hexdigest()[:10]}.npz")


def _save_run(path, r):
    tmp = path[:-4] + f".{uuid.uuid4().hex[:6]}.npz"
    np.savez_compressed(tmp, depth=r["depth"], arrive=r["arrive"], speed=r["speed"], v=np.array([r["vin"], r["vout"], r["stored"]]))
    os.replace(tmp, path)


def _load_run(path):
    with np.load(path) as d:
        vin, vout, stored = d["v"]
        return {"depth": d["depth"], "arrive": d["arrive"], "speed": d["speed"], "vin": float(vin), "vout": float(vout), "stored": float(stored)}


def _grow(a, k):
    for _ in range(k):
        a = a | np.roll(a, 1, 0) | np.roll(a, -1, 0) | np.roll(a, 1, 1) | np.roll(a, -1, 1)
    return a


def mercator_rows(s, n, ny):
    """Source row for each output row so a lat/lon picture lies straight on a web map."""
    y = lambda la: np.log(np.tan(np.pi / 4 + np.radians(la) / 2))
    ys = np.linspace(y(n), y(s), ny * 2 + 1)[1::2]
    la = np.degrees(2 * np.arctan(np.exp(ys)) - np.pi / 2)
    return np.clip(((n - la) / (n - s) * ny).astype(int), 0, ny - 1)


def picture(sid, sc, depth, likely, grid, names, path):
    """Depth map: solid colours = likely, pale = upper limit only; district lines and names."""
    from PIL import Image, ImageDraw, ImageFont
    w, s, e, n = box(sid)
    ny, nx = depth.shape
    rgba = np.zeros((ny, nx, 4), np.uint8)
    for lo, hi, col, _ in DEPTHS:
        m = (depth >= lo) & (depth < hi)
        rgb = [int(col[j:j + 2], 16) for j in (1, 3, 5)]
        rgba[m & likely] = rgb + [235]
        rgba[m & ~likely] = [253, 190, 110, 110]
    edge = (grid != np.roll(grid, 1, 0)) | (grid != np.roll(grid, 1, 1))
    edge[0], edge[:, 0] = False, False
    rgba[edge] = [60, 60, 60, 160]
    rgba = rgba[mercator_rows(s, n, ny)]
    k = max(1, round(900 / nx))
    im = Image.fromarray(rgba).resize((nx * k, ny * k), Image.NEAREST)
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.load_default(size=15)
    except TypeError:
        font = ImageFont.load_default()
    rows = mercator_rows(s, n, ny)
    for i in np.unique(grid):
        if i == 0:
            continue
        rr, cc = np.nonzero(grid == i)
        if rr.size < 250:
            continue
        y = int(np.searchsorted(rows, int(np.median(rr)))) * k
        d.text((int(np.median(cc)) * k, y), names[i - 1], fill=(40, 40, 40, 255), font=font, anchor="mm", stroke_width=2, stroke_fill=(255, 255, 255, 220))
    r, c = int((n - POS[sid][1]) / RES), int((POS[sid][0] - w) / RES)
    y = int(np.searchsorted(rows, r)) * k
    d.ellipse([c * k - 6, y - 6, c * k + 6, y + 6], fill=(220, 38, 38, 255), outline=(255, 255, 255, 255))
    tmp = path + f".{uuid.uuid4().hex[:6]}.png"
    im.quantize(48).save(tmp, optimize=True)
    os.replace(tmp, path)


def build(log=lambda s: None, workers=4, only=None):
    """Simulate the whole catalogue and test it on real floods (about an hour on 4 cores; finished runs are cached on disk,
    so a stopped build resumes). Memory stays small: each result goes to disk as it arrives and is read back one at a time."""
    from .flood_eo import _ee
    ee = _ee()
    big, meta = fa._districts()
    names = [m["name"] for m in meta]
    ids = [s for s in REACHES if only is None or s in only]
    T = {}
    for sid in ids:
        T[sid] = _terrain_cached(ee, sid)
        log(f"terrain {sid}: {T[sid]['z50'].shape}")
    points = {}
    for kind in ("schools", "health"):
        try:
            points[kind] = fa._points(fa.POINTS[kind][0])
        except Exception as ex:
            log(f"{kind}: {type(ex).__name__}")
    jobs, tags = [], []
    for sid in ids:
        z, man, dx, dy, src = _model(sid, T[sid])
        lim = fs.limits(sid)
        for sc in SCENARIOS:
            if lim.get(sc) is None:
                continue
            jobs.append((z, man, dx, dy, ("design", lim[sc] / CFS, 0.4 * lim["low"] / CFS), src, REACHES[sid][3]))
            tags.append((sid, sc))
    for sid, year, a, b, kind in TESTS:
        if sid not in ids:
            continue
        t, q = _observed(sid, a, b, kind)
        if t.size < 8:
            log(f"test {sid} {year}: too few readings")
            continue
        z, man, dx, dy, src = _model(sid, T[sid])
        jobs.append((z, man, dx, dy, ("observed", t, q), src, float(t[-1] / 3600)))
        tags.append((sid, f"test{year}"))
    log(f"{len(jobs)} simulations")
    out = {sid: {"station": fs.STATIONS[sid][0], "river": fs.STATIONS[sid][1], "to": REACHES[sid][0], "bbox": None, "scenarios": {}} for sid in ids}
    tests, dropped = [], set()
    os.environ["OMP_NUM_THREADS"] = "1"
    obs_cache = {}

    def observed_floods(sid):
        if sid not in obs_cache:
            b = box(sid)
            ny, nx = T[sid]["z50"].shape
            obs_cache[sid] = {y: _wms(ls, b, nx, ny) for y, ls in fa.OBSERVED.items()}
        return obs_cache[sid]
    from concurrent.futures import as_completed
    paths = [_run_path(sid, tag, j) for (sid, tag), j in zip(tags, jobs)]
    todo = [i for i, pth in enumerate(paths) if not os.path.exists(pth)]
    log(f"{len(jobs) - len(todo)} runs reused from disk, {len(todo)} to simulate on {workers} cores")
    with ProcessPoolExecutor(workers) as ex:
        futs = {ex.submit(fi.job, jobs[i]): i for i in todo}
        for f in as_completed(futs):
            i = futs.pop(f)
            _save_run(paths[i], f.result())
            log(f"simulated {tags[i][0]} {tags[i][1]}")
    del jobs
    order = sorted(range(len(tags)), key=lambda i: not tags[i][1].startswith("test"))     # tests first: trust grades need them
    for i in order:
        (sid, tag), r = tags[i], _load_run(paths[i])
        w, s, e, n = box(sid)
        ny, nx = T[sid]["z50"].shape
        floods = observed_floods(sid)
        bal = (r["stored"] + r["vout"]) / max(r["vin"], 1) - 1
        deep = r["depth"] > 0.3
        if tag.startswith("test"):
            year = tag[4:]
            tests.append(test_row(sid, year, r, floods, T[sid]["water"] > 0.3))
            log(f"test {sid} {year}: {tests[-1]['likely']} (upper {tests[-1]['upper']})")
            continue
        river = T[sid]["water"] > 0.3
        likely = likely_mask(sid, np.ones_like(river), floods, river)
        # district index on the reach grid
        rr = ((fa.N - (n - (np.arange(ny) + 0.5) * RES)) / fa.RES).astype(int).clip(0, fa.NY - 1)
        cc = ((w + (np.arange(nx) + 0.5) * RES - fa.W) / fa.RES).astype(int).clip(0, fa.NX - 1)
        grid = big[rr][:, cc]
        dry = deep & ~river
        km2 = (RES * 111.32) ** 2 * np.cos(np.radians((s + n) / 2))
        pf = census_factor(meta)
        rows = []
        for i in np.unique(grid[dry]):
            if i == 0 or meta[i - 1]["province"] == fa.OUTSIDE:
                continue
            m = dry & (grid == i)
            lk = m & likely
            arr = r["arrive"][lk] if lk.any() else r["arrive"][m]
            d50 = float(np.median(r["depth"][lk if lk.any() else m]))
            rows.append({"name": names[i - 1], "people": int(round(float((T[sid]["pop"] * lk).sum()) * pf.get(i, 1.0))), "people_upper": int(round(float((T[sid]["pop"] * m).sum()) * pf.get(i, 1.0))),
                         "km2": round(float(lk.sum()) * km2), "km2_upper": round(float(m.sum()) * km2), "crop_km2": round(float((T[sid]["crop"] * lk).sum()) * km2),
                         "first_h": round(float(np.nanpercentile(arr, 2))), "half_h": round(float(np.nanmedian(arr))), "depth_m": round(d50, 1), "deep_people": int(round(float((T[sid]["pop"] * (lk & (r["depth"] > 1.5))).sum()) * pf.get(i, 1.0)))})
        rows = [x for x in rows if x["km2_upper"] >= 3]
        rows.sort(key=lambda x: x["first_h"])
        places = {}
        for kind, (px, py) in points.items():
            c, q = ((px - w) / RES).astype(int), ((n - py) / RES).astype(int)
            ok = (c >= 0) & (c < nx) & (q >= 0) & (q < ny)
            places[kind] = int((dry & likely)[q[ok], c[ok]].sum())
        ponds = float((r["depth"][dry] > 4).mean()) if dry.any() else 0.0
        if r["vout"] < MIN_OUT * r["vin"] and ponds > 0.25:          # trapped AND standing deep: a blocked gorge, not a wide plain
            dropped.add(sid)
            log(f"{sid} {tag}: only {r['vout'] / r['vin']:.0%} of the water left and {ponds:.0%} of the land is over 4 m deep; reach dropped")
        name = f"{sid}-{tag}.png"
        picture(sid, tag, np.where(dry, r["depth"], np.where(deep & river, r["depth"], 0)), likely, grid, names, os.path.join(directory(), name))
        out[sid]["bbox"] = [w, s, e, n]
        out[sid]["scenarios"][tag] = {
            "flow": fs.limits(sid)[tag], "label": LABEL[tag], "people": sum(x["people"] for x in rows), "people_upper": sum(x["people_upper"] for x in rows), "deep_people": sum(x["deep_people"] for x in rows),
            "km2": sum(x["km2"] for x in rows), "km2_upper": sum(x["km2_upper"] for x in rows), "crop_km2": sum(x["crop_km2"] for x in rows), "places": places, "districts": rows[:14], "map": name,
            "speed": round(float(np.quantile(r["speed"][dry & likely], 0.9)), 1) if (dry & likely).any() else None, "balance": round(bal, 5), "left": round(r["vout"] / r["vin"], 2)}
        log(f"{sid} {tag}: {out[sid]['scenarios'][tag]['people']:,} people likely, {out[sid]['scenarios'][tag]['km2']} km2, balance {bal:.1e}")
    out = {sid: {**r, "trust": trust(r["river"], tests)} for sid, r in out.items() if sid not in dropped}
    doc = {"dropped": [fs.STATIONS[s][0] for s in sorted(dropped)], "built": datetime.now().date().isoformat(), "reaches": out, "tests": tests, "grid_deg": RES, "depth_classes": [[lo, hi, c, t] for lo, hi, c, t in DEPTHS],
           "wave": "rises over 36 h, holds 12 h, then halves every 48 h", "likely_rule": LIKELY}
    tmp = os.path.join(directory(), f"c{uuid.uuid4().hex[:6]}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, os.path.join(directory(), "catalogue.json"))
    return {"reaches": len(out), "tests": [(t["station"], t["year"], t["likely"]) for t in tests]}


def census_factor(meta):
    """District index -> 2023 census total of its province over the GHSL 2025 total of the same province."""
    from .foodsec_ews import CENSUS_2023
    ghsl = {"Punjab": 136.7e6, "Sindh": 56.8e6, "Khyber Pakhtunkhwa": 39.6e6, "Balochistan": 8.2e6, "Federal Capital": 2.3e6}
    return {i + 1: CENSUS_2023[m["province"]] / ghsl[m["province"]] if m["province"] in ghsl else 1.0 for i, m in enumerate(meta)}


def scenario_for(tier):
    """FFD tier (0..5) -> catalogue scenario, or None below High."""
    return {3: "high", 4: "very_high", 5: "exceptional"}.get(tier)


def pick(cat, stations):
    """Scenarios that apply now (observed or FFD-forecast level), else the planning view of the reaches with most people."""
    if not cat:
        return None
    now = []
    for s in stations:
        r = cat["reaches"].get(s["id"])
        sc = scenario_for(max(s.get("tier") or 0, s.get("ffd_tier") or 0))
        while sc and r and sc not in r["scenarios"]:
            sc = {"exceptional": "very_high", "very_high": "high"}.get(sc)
        if r and sc:
            now.append({"id": s["id"], "scenario": sc, "why": "FFD reading" if (s.get("tier") or 0) >= (s.get("ffd_tier") or 0) else "FFD 24-hour forecast"})
    plan = sorted(((sid, r["scenarios"].get("very_high") or r["scenarios"].get("high")) for sid, r in cat["reaches"].items() if r["scenarios"]), key=lambda x: -x[1]["people"])
    return {"built": cat["built"], "wave": cat["wave"], "depth_classes": cat["depth_classes"], "dropped": cat.get("dropped") or [], "tests": cat["tests"], "now": now[:4], "plan": [sid for sid, _ in plan],
            "reaches": {sid: {**{k: r.get(k) for k in ("station", "river", "to", "bbox", "trust")},
                              "scenarios": {k: ({**v, "districts": v["districts"][:8]} if any(n["id"] == sid and n["scenario"] == k for n in now) or k == "very_high" else {x: v[x] for x in ("flow", "label", "people", "people_upper", "km2", "map")})
                                            for k, v in r["scenarios"].items()}} for sid, r in cat["reaches"].items()}}
