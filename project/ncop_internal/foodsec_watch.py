# project/ncop_internal/foodsec_watch.py
# ---------------------------------------------------------------------------
# Digest behind the "National Food Security & Agriculture Watch" story
# (frontend/src/modules/story-food-security-watch.js). One small JSON built
# in the background and cached, so the story makes a single request:
#
#   ipc      IPC acute food insecurity — Pakistan areas (phase, population by
#            phase, bbox/centroid, province), national totals, analysis
#            history (2017→), hotspot outlines (simplified), Afghanistan &
#            Bangladesh totals for regional context.   [existing /api/ipc/ views]
#   crops    PBS crop production — national series for the staples, latest
#            vs previous year and 5-year average, provincial breakdown,
#            top wheat districts with bboxes/outlines.   [existing /api/crops/ views]
#   prices   WFP retail market prices (HDX, CC BY 4.0) for 5 markets —
#            latest month, YoY / 3-month change, wage purchasing power
#            (kg of wheat flour per daily wage) and an INDICATIVE 1-3 month
#            path: the median seasonal month-to-month movement of the last
#            5 years applied to the latest price, with a 10-90 % range.
#   ews      early-warning layer: district levels, two-line IPC count, water,
#            supply, shocks, households, price outlook with its test results,
#            data checks, source health, actions   [foodsec_ews / foodsec_sources]
#   outlook  next ~30 days by province from the bias-corrected GEFS district
#            outlook vs the 2001-2025 normals (gefs_calibration model), and
#            the crop calendar for the coming two months.
#
# Each section is built independently: a failing upstream leaves that
# section null and the story narrates around it. Never runs in a request:
# requests read the cached digest (202 while the first build runs).
# ---------------------------------------------------------------------------

import json
import logging
import os
import re
import statistics
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone

from django.conf import settings
from django.test import RequestFactory

logger = logging.getLogger(__name__)

TTL_S = 6 * 3600
STAPLES = [  # (PBS crop id, name, unit)
    (4, "Wheat", "000 t"), (2, "Rice", "000 t"), (1, "Maize", "000 t"),
    (3, "Sugarcane", "000 t"), (5, "Cotton", "000 bales"),
]
PRICE_ITEMS = [  # WFP commodity names (retail, PKR)
    "Wheat flour", "Wheat", "Rice (coarse)", "Rice (basmati, broken)", "Sugar", "Milk", "Eggs",
    "Poultry", "Oil (cooking)", "Ghee (artificial)", "Lentils (masur)", "Lentils (gram)",
    "Fuel (diesel)", "Wage (non-qualified labour, non-agricultural)",
]
WAGE = "Wage (non-qualified labour, non-agricultural)"
# FAO GIEWS crop calendar for Pakistan (typical windows), by month 1-12.
CROP_CALENDAR = [
    {"crop": "Wheat (rabi)", "sowing": [10, 11, 12], "growing": [1, 2, 3], "harvest": [4, 5]},
    {"crop": "Rice (kharif)", "sowing": [5, 6, 7], "growing": [8, 9], "harvest": [10, 11]},
    {"crop": "Cotton (kharif)", "sowing": [4, 5, 6], "growing": [7, 8], "harvest": [9, 10, 11, 12]},
    {"crop": "Maize (kharif)", "sowing": [6, 7, 8], "growing": [9], "harvest": [10, 11]},
    {"crop": "Sugarcane", "sowing": [2, 3, 9, 10], "growing": [4, 5, 6, 7, 8], "harvest": [11, 12, 1, 2, 3, 4]},
]

_lock = threading.Lock()
_state = {"thread": None, "doc": None, "loaded_at": 0.0}


class FoodsecBuilding(Exception):
    pass


def _root():
    p = os.path.join(settings.MEDIA_ROOT, "foodsec")
    os.makedirs(p, exist_ok=True)
    return p


def _path():
    return os.path.join(_root(), "watch.json")


# ------------------------------------------------------------------ helpers
_rf = RequestFactory()


def _call(view_cls, path, **kwargs):
    """Call an existing NCOP view in-process (reuses its upstream cache)."""
    resp = view_cls.as_view()(_rf.get(path), **kwargs)
    if resp.status_code != 200:
        raise RuntimeError(f"{path}: HTTP {resp.status_code}")
    return json.loads(resp.content)


def _norm(name):
    s = str(name or "").lower().replace("_", " ")
    s = re.sub(r"\b(district|agency|tribal|division|city)\b", " ", s)
    s = re.sub(r"[^a-z ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return {"d i khan": "dera ismail khan", "d g khan": "dera ghazi khan", "t t singh": "toba tek singh"}.get(s, s)


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _match(lookup, name):
    """District record for an IPC / PBS area name, tolerating word-order
    variants ("Kohistan Lower" = "Lower Kohistan", "Kolai Palas Kohistan")."""
    n = _norm(name)
    cands = [n]
    w = n.split()
    if len(w) >= 2 and w[-1] in ("upper", "lower", "central", "north", "south", "east", "west"):
        cands.append(" ".join([w[-1]] + w[:-1]))
    if len(w) >= 3:
        cands.append(" ".join(w[:-1]))
    for c in cands:
        if c in lookup:
            return lookup[c]
    # Last resort: a unique district whose name contains the first word
    # ("Chitral Upper" -> "Upper Chitral" / "Chitral").
    if w:
        hits = [v for k, v in lookup.items() if w[0] in k.split()]
        if len({h["province"] for h in hits}) == 1 and hits:
            return hits[0]
    return None


def _district_lookup():
    """normalised district name -> {name, province, centroid, bbox} (GEFS index)."""
    try:
        from . import gefs_districts as gd
        if not gd.ensure_index(block=False):
            return {}
        _, meta = gd._load_index()
        return {_norm(d["name"]): d for d in meta}
    except Exception:
        return {}


def _geom_info(geometry, simplify=None):
    """(bbox [w,s,e,n], centroid [lon,lat], simplified GeoJSON or None)."""
    from osgeo import ogr

    g = ogr.CreateGeometryFromJson(json.dumps(geometry))
    if g is None:
        return None, None, None
    minx, maxx, miny, maxy = g.GetEnvelope()
    c = g.Centroid()
    simple = None
    if simplify:
        s = g.SimplifyPreserveTopology(simplify)
        simple = json.loads(s.ExportToJson()) if s is not None else None
    return ([round(minx, 4), round(miny, 4), round(maxx, 4), round(maxy, 4)],
            [round(c.GetX(), 4), round(c.GetY(), 4)], simple)


# --------------------------------------------------------------------- IPC
def _ipc_section(lookup):
    from .views import IpcFoodSecurityAPIView, IpcHistoryAPIView

    fc = _call(IpcFoodSecurityAPIView, "/api/ipc/pakistan/", country="pakistan")
    areas = []
    for f in fc.get("features", []):
        p = f.get("properties") or {}
        pops = {k: int(_num(p.get(f"phase{k}_population")) or 0) for k in range(1, 6)}
        total = int(_num(p.get("estimated_population")) or sum(pops.values()))
        bbox, centroid, _ = _geom_info(f.get("geometry")) if f.get("geometry") else (None, None, None)
        d = _match(lookup, p.get("title"))
        areas.append({"title": p.get("title"), "phase": int(_num(p.get("overall_phase")) or 0),
                      "color": p.get("color"), "period": p.get("ipc_period"), "pop": total,
                      "p": pops, "p3plus": pops[3] + pops[4] + pops[5],
                      "p3plus_pct": round((pops[3] + pops[4] + pops[5]) / total, 3) if total else None,
                      "confidence": p.get("confidence_level"), "prolonged": bool(p.get("prolonged_crisis")),
                      "province": d["province"] if d else None, "bbox": bbox, "centroid": centroid,
                      "_geom": f.get("geometry")})
    totals = {"areas": len(areas), "pop": sum(a["pop"] for a in areas),
              "p": {k: sum(a["p"][k] for a in areas) for k in range(1, 6)},
              "phase_counts": {k: sum(1 for a in areas if a["phase"] == k) for k in range(1, 6)}}
    totals["p3plus"] = totals["p"][3] + totals["p"][4] + totals["p"][5]
    totals["p3plus_pct"] = round(totals["p3plus"] / totals["pop"], 3) if totals["pop"] else None
    prov = {}
    for a in areas:
        key = a["province"] or "Other"
        r = prov.setdefault(key, {"province": key, "areas": 0, "pop": 0, "p3plus": 0, "p4": 0})
        r["areas"] += 1
        r["pop"] += a["pop"]
        r["p3plus"] += a["p3plus"]
        r["p4"] += a["p"][4]
    provinces = sorted(prov.values(), key=lambda r: -r["p3plus"])
    for r in provinces:
        r["p3plus_pct"] = round(r["p3plus"] / r["pop"], 3) if r["pop"] else None
    hot = sorted(areas, key=lambda a: (-a["p"][4], -a["p3plus"]))[:6]
    hotspots = []
    for a in hot:
        _, _, simple = _geom_info(a["_geom"], simplify=0.01) if a.get("_geom") else (None, None, None)
        hotspots.append({**{k: v for k, v in a.items() if k != "_geom"}, "outline": simple})
    for a in areas:
        a.pop("_geom", None)
    history = []
    try:
        h = _call(IpcHistoryAPIView, "/api/ipc/pakistan/history/", country="pakistan")
        history = [{k: a.get(k) for k in ("date", "title", "period", "analyzed_pop", "phase3plus_pop", "phase3plus_pct",
                                           "phase4_pop")} for a in h.get("analyses", [])]
    except Exception:
        logger.warning("foodsec: IPC history unavailable", exc_info=True)
    neighbours = {}
    for c in ("afghanistan", "bangladesh"):
        try:
            nf = _call(IpcFoodSecurityAPIView, f"/api/ipc/{c}/", country=c)
            pp = {k: 0 for k in range(1, 6)}
            tot = 0
            for f in nf.get("features", []):
                p = f.get("properties") or {}
                for k in range(1, 6):
                    pp[k] += int(_num(p.get(f"phase{k}_population")) or 0)
                tot += int(_num(p.get("estimated_population")) or 0)
            neighbours[c] = {"areas": len(nf.get("features", [])), "pop": tot, "p": pp,
                             "p3plus": pp[3] + pp[4] + pp[5],
                             "p3plus_pct": round((pp[3] + pp[4] + pp[5]) / tot, 3) if tot else None,
                             "analysis_id": (nf.get("meta") or {}).get("analysis_id")}
        except Exception:
            logger.warning("foodsec: IPC %s unavailable", c, exc_info=True)
    return {"analysis_id": (fc.get("meta") or {}).get("analysis_id"), "totals": totals, "provinces": provinces,
            "areas": sorted(areas, key=lambda a: -a["p3plus"]), "hotspots": hotspots, "history": history,
            "neighbours": neighbours}


# ------------------------------------------------------------------- crops
def harvest_label(crop, crop_year):
    """PBS crop year ("2024-25") -> when it was actually harvested. Crop years and
    USDA marketing years differ, so the bare label is never used to join them."""
    m = re.match(r"(\d{4})", str(crop_year))
    if not m:
        return None
    y = int(m.group(1))
    return {"Wheat": f"spring {y + 1}", "Sugarcane": f"winter {y}-{str(y + 1)[2:]}"}.get(crop, f"autumn {y}")


def _crops_section(lookup):
    from .views import CropGeoJSONAPIView, CropMapAPIView, CropYearlyAPIView

    staples = []
    latest_year = None
    for cid, name, unit in STAPLES:
        rows = _call(CropYearlyAPIView, f"/api/crops/yearly/?crop={cid}").get("data", [])
        series = [{"year": str(r.get("fiscalyear", "")).strip(), "production": _num(r.get("production")),
                   "area": _num(r.get("area")), "yield": _num(r.get("yield"))} for r in rows]
        series = [s for s in series if s["year"] and s["production"]]
        if not series:
            continue
        last, prev = series[-1], series[-2] if len(series) > 1 else None
        avg5 = statistics.mean(s["production"] for s in series[-6:-1]) if len(series) >= 6 else None
        latest_year = latest_year or last["year"]
        staples.append({"id": cid, "name": name, "unit": unit, "series": series[-20:], "latest": last, "prev": prev,
                        "source_crop_label": last["year"], "harvest": harvest_label(name, last["year"]),
                        "avg5": avg5,
                        "change_pct": round((last["production"] / prev["production"] - 1) * 100, 1) if prev else None,
                        "vs_avg5_pct": round((last["production"] / avg5 - 1) * 100, 1) if avg5 else None})
    provinces = {}
    for s in staples:
        try:
            rows = _call(CropMapAPIView, f"/api/crops/map/?crop={s['id']}&year={s['latest']['year']}&level=11").get("data", [])
            provinces[s["id"]] = sorted([{"name": r.get("name", "").title(), "production": _num(r.get("production")),
                                          "area": _num(r.get("area")), "yield": _num(r.get("yield"))}
                                         for r in rows if _num(r.get("production"))], key=lambda r: -r["production"])
        except Exception:
            logger.warning("foodsec: crop map %s unavailable", s["id"], exc_info=True)
    districts = []
    wheat = next((s for s in staples if s["id"] == 4), None)
    if wheat:
        try:
            gj = _call(CropGeoJSONAPIView, f"/api/crops/geojson/?crop=4&year={wheat['latest']['year']}&level=13")
            feats = [f for f in gj.get("features", []) if (f.get("properties") or {}).get("has_data")]
            feats.sort(key=lambda f: -(_num(f["properties"].get("production")) or 0))
            for f in feats[:8]:
                p = f["properties"]
                bbox, centroid, simple = _geom_info(f.get("geometry"), simplify=0.01)
                d = _match(lookup, p.get("name"))
                districts.append({"name": str(p.get("name", "")).replace(" DISTRICT", "").title(),
                                  "province": d["province"] if d else None, "production": _num(p.get("production")),
                                  "area": _num(p.get("area")), "yield": _num(p.get("yield")),
                                  "bbox": bbox, "centroid": centroid, "outline": simple})
        except Exception:
            logger.warning("foodsec: wheat district geometry unavailable", exc_info=True)
    return {"latest_year": latest_year, "staples": staples, "provinces": provinces, "wheat_districts": districts}


# ------------------------------------------------------------------ prices
def _month_add(ym, n):
    y, m = ym
    k = y * 12 + (m - 1) + n
    return (k // 12, k % 12 + 1)


def _prices_section(wfp):
    """wfp: the compact WFP document of foodsec_sources."""
    d = wfp["data"]
    markets = d["markets"]
    # commodity -> {(y,m): {market: price}}
    data = {c: {(int(m[:4]), int(m[5:])): v for m, v in by.items()} for c, by in d["prices"].items()}
    latest = max(ym for c in data.values() for ym in c)
    items = []
    for name in PRICE_ITEMS:
        by = data.get(name)
        if not by:
            continue
        nat = {ym: statistics.mean(v.values()) for ym, v in by.items() if len(v) >= max(3, len(markets) - 2)}
        if latest not in nat:
            continue
        months = sorted(m for m in nat if m >= _month_add(latest, -24))
        series = [{"month": f"{y}-{m:02d}", "price": round(nat[(y, m)], 1)} for y, m in months]
        yoy = nat.get(_month_add(latest, -12))
        m3 = nat.get(_month_add(latest, -3))
        # Indicative seasonal path: median month-to-month ratio over the last
        # 5 years for each calendar transition, applied to the latest price.
        path, cur, lo, hi = [], nat[latest], nat[latest], nat[latest]
        for k in range(1, 4):
            a, b = _month_add(latest, k - 1), _month_add(latest, k)
            ratios = []
            for yb in range(1, 6):
                pa, pb = nat.get((a[0] - yb, a[1])), nat.get((b[0] - yb, b[1]))
                if pa and pb:
                    ratios.append(pb / pa)
            if len(ratios) < 3:
                break
            ratios.sort()
            med = statistics.median(ratios)
            q10 = ratios[max(0, int(0.1 * (len(ratios) - 1)))]
            q90 = ratios[min(len(ratios) - 1, int(round(0.9 * (len(ratios) - 1))))]
            cur, lo, hi = cur * med, lo * q10, hi * q90
            path.append({"month": f"{b[0]}-{b[1]:02d}", "mid": round(cur, 1), "lo": round(lo, 1), "hi": round(hi, 1)})
        items.append({"commodity": name, "unit": None, "latest": round(nat[latest], 1),
                      "by_market": {mk: round(v, 1) for mk, v in sorted(by.get(latest, {}).items())},
                      "yoy_pct": round((nat[latest] / yoy - 1) * 100, 1) if yoy else None,
                      "m3_pct": round((nat[latest] / m3 - 1) * 100, 1) if m3 else None,
                      "series": series, "outlook": path})
    for it in items:
        it["unit"] = f"PKR/{(d['units'].get(it['commodity']) or ['unit'])[0]}"
    # Purchasing power: kg of wheat flour bought by one day's unskilled wage.
    tot = None
    w, f = data.get(WAGE), data.get("Wheat flour")
    if w and f:
        def kg(ym):
            mk = [m for m in (w.get(ym) or {}) if m in (f.get(ym) or {})]
            return statistics.mean(w[ym][m] / f[ym][m] for m in mk) if mk else None
        cur = kg(latest)
        tot = {"latest": round(cur, 1) if cur else None,
               "year_ago": round(kg(_month_add(latest, -12)), 1) if kg(_month_add(latest, -12)) else None,
               "by_market": {m: round(w[latest][m] / f[latest][m], 1) for m in (w.get(latest) or {}) if m in (f.get(latest) or {})},
               "series": [{"month": f"{y}-{m:02d}", "kg": round(kg((y, m)), 1)}
                          for y, m in sorted(k for k in w if k >= _month_add(latest, -24)) if kg((y, m))]}
        prior = [kg((latest[0] - yb, latest[1])) for yb in range(1, 6)]
        prior = [x for x in prior if x]
        tot["avg5_same_month"] = round(statistics.mean(prior), 1) if prior else None
    return {"source": "WFP VAM market monitoring via HDX (CC BY-IGO)", "latest_month": f"{latest[0]}-{latest[1]:02d}",
            "markets": sorted(markets.values(), key=lambda m: m["market"]), "items": items, "terms_of_trade": tot}


# ----------------------------------------------------------------- outlook
def _outlook_section():
    from . import gefs_calibration as gcal
    from . import gefs_districts as gd

    today = datetime.now(timezone.utc).date()
    months = [((today.month - 1 + k) % 12) + 1 for k in range(3)]
    stage_names = {"sowing": "sowing", "growing": "in the field", "harvest": "harvest"}
    calendar = []
    for c in CROP_CALENDAR:
        stages = []
        for m in months:
            st = next((stage_names[s] for s in ("sowing", "growing", "harvest") if m in c[s]), None)
            stages.append(st)
        calendar.append({"crop": c["crop"], "stages": stages})
    out = {"months": [date(2000, m, 1).strftime("%b") for m in months], "calendar": calendar, "weather": None}
    try:
        p, t = gd.district_stats("precip"), gd.district_stats("t2m")
        m = gcal.load()
        n_days = min(30, p["days"])
        start = date.fromisoformat(p["dates"][0])
        # 2001-2025 normals (stored in the calibration model, same district order)
        cp = m.get("clim_precip") if m else None
        ct = m.get("clim_t2m") if m else None
        normals = None
        if cp is not None and ct is not None and cp.shape[0] == len(p["districts"]):
            days = [start + timedelta(days=k) for k in range(n_days)]
            rain_n = sum(gcal.daily_normal(cp, d) for d in days)             # [district] mm over the window
            temp_n = sum(gcal.daily_normal(ct, d) for d in days) / n_days    # [district] deg C mean
            normals = (rain_n, temp_n)
        prov = {}
        for i, (dp, dt) in enumerate(zip(p["districts"], t["districts"])):
            temp = [v for v in dt["t2m"][:n_days] if v is not None]
            r = prov.setdefault(dp["province"], {"province": dp["province"], "n": 0, "rain": 0.0, "temp": 0.0,
                                                 "rain_normal": 0.0, "temp_normal": 0.0})
            r["n"] += 1
            r["rain"] += sum(v or 0 for v in dp["precip"][:n_days])
            r["temp"] += sum(temp) / len(temp) if temp else 0.0
            if normals is not None:
                r["rain_normal"] += float(normals[0][i])
                r["temp_normal"] += float(normals[1][i])
        rows = []
        for r in prov.values():
            n = r["n"]
            rows.append({"province": r["province"].replace("_", " "), "districts": n,
                         "rain_mm": round(r["rain"] / n, 1), "temp_c": round(r["temp"] / n, 1),
                         "rain_normal_mm": round(r["rain_normal"] / n, 1) if normals is not None else None,
                         "temp_normal_c": round(r["temp_normal"] / n, 1) if normals is not None else None})
        rows.sort(key=lambda x: -x["districts"])
        out["weather"] = {"days": n_days, "from": p["dates"][0], "to": p["dates"][n_days - 1], "run": p["run"],
                          "calibrated": bool(p.get("calibration")), "provinces": rows}
    except Exception:
        logger.warning("foodsec: GEFS outlook unavailable", exc_info=True)
    return out


def _ews_section(docs):
    from . import foodsec_ews as ews
    from . import gefs_districts as gd

    meta = gd._load_index()[1] if gd.ensure_index(block=False) else []
    return ews.build(docs, meta)


def _use_tested_outlook(doc):
    """The flour outlook comes from the tested model; other items keep the seasonal baseline."""
    po = (doc.get("ews") or {}).get("price_outlook")
    if not po:
        return
    for it in (doc.get("prices") or {}).get("items", []):
        if it["commodity"] == po["item"] and po["month"] == doc["prices"]["latest_month"]:
            it["baseline"] = it["outlook"]
            it["outlook"] = po["path"]


# ------------------------------------------------------------------ build
def build():
    t0 = time.time()
    lookup = _district_lookup()
    doc = {"generated_at": datetime.now(timezone.utc).isoformat()}
    from . import foodsec_sources as fs
    docs = fs.fetch_all()
    for key, fn in (("ipc", lambda: _ipc_section(lookup)), ("crops", lambda: _crops_section(lookup)),
                    ("prices", lambda: _prices_section(docs["wfp"])), ("outlook", _outlook_section),
                    ("ews", lambda: _ews_section(docs))):
        try:
            doc[key] = fn()
        except Exception:
            logger.warning("foodsec: section %s failed", key, exc_info=True)
            doc[key] = None
    _use_tested_outlook(doc)
    doc["build_seconds"] = round(time.time() - t0, 1)
    tmp = _path() + f".tmp{uuid.uuid4().hex[:6]}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, _path())
    with _lock:
        _state.update(doc=doc, loaded_at=time.time())
    logger.info("foodsec: digest built in %.1fs", doc["build_seconds"])
    return doc


def _build_async():
    with _lock:
        t = _state["thread"]
        if t and t.is_alive():
            return
        t = threading.Thread(target=lambda: _safe(build), name="foodsec-build", daemon=True)
        _state["thread"] = t
    t.start()


def _safe(fn):
    try:
        fn()
    except Exception:
        logger.warning("foodsec: build failed", exc_info=True)


def building():
    t = _state["thread"]
    return bool(t and t.is_alive())


def watch():
    """Cached digest; stale-while-revalidate. Raises FoodsecBuilding if none yet."""
    with _lock:
        doc = _state["doc"]
    if doc is None and os.path.exists(_path()):
        try:
            with open(_path(), encoding="utf-8") as f:
                doc = json.load(f)
            with _lock:
                _state.update(doc=doc, loaded_at=os.path.getmtime(_path()))
        except (OSError, ValueError):
            doc = None
    age = time.time() - _state["loaded_at"] if doc else None
    if doc is None:
        _build_async()
        raise FoodsecBuilding()
    if age > TTL_S:
        _build_async()
    return {**doc, "age_s": round(age), "refreshing": building()}


# ------------------------------------------------------------------- view
from django.http import JsonResponse  # noqa: E402
from rest_framework.throttling import AnonRateThrottle  # noqa: E402
from rest_framework.views import APIView  # noqa: E402


class FoodsecThrottle(AnonRateThrottle):
    scope = "gefs_api"            # same light read-only budget as the outlook endpoints


class FoodSecurityWatchView(APIView):
    """GET /api/foodsec/watch/ — 202 while the first digest builds."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [FoodsecThrottle]

    def get(self, request):
        try:
            doc = watch()
        except FoodsecBuilding:
            resp = JsonResponse({"status": "building", "retry_after": 10}, status=202)
            resp["Retry-After"] = "10"
            resp["Cache-Control"] = "no-store"
            return resp
        except Exception:
            logger.exception("foodsec: watch failed")
            return JsonResponse({"error": "data unavailable"}, status=503)
        resp = JsonResponse(doc, json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
        resp["Cache-Control"] = "public, max-age=600"
        return resp
