# project/ncop_internal/flood_ews.py
# ---------------------------------------------------------------------------
# Early-warning and decision-support layer of the National Flood Watch.
#
# Order of authority
#   1. FFD (readings, limits, advisories, official forecast)      up to SEVERE
#   2. NCOP river outlook, GloFAS, Google Flood Hub (assisting)   up to ALERT,
#      and only ELEVATED unless two of them agree
#   3. NCOP district rain outlook (GEFS, bias-corrected), for flash floods,
#      hill torrents and cities                                   up to ALERT
# A missing, stale or unreliable source is reported as such. It never counts
# as "no flood", and it never raises a level.
#
# Levels are an NCOP overlay for preparedness; they are not FFD or PMD
# warnings. Every district keeps its own level: a severe local threat stays
# visible whatever the national picture.
#
# watch() is what the story and the report read: one cached JSON, built in a
# background thread (a few seconds; Earth Engine is only called from
# flood_eo.refresh, at most every 6 h).
# ---------------------------------------------------------------------------

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import flood_eo as fe
from . import flood_ffd_site as site
from . import flood_ops as ops
from . import flood_routing as fr
from . import flood_store as fs

logger = logging.getLogger(__name__)

VERSION = "flood-ews-3"
LEVELS = ["NORMAL", "ELEVATED", "ALERT", "WARNING", "SEVERE"]
TIER_LEVEL = [0, 1, 2, 3, 4, 4]                 # FFD tier -> level
FRESH_H = {"ffd": 30, "ffd_season": 14, "glofas": 72, "floodhub": 36, "gefs": 36, "imerg": 72, "nwp": 48}
# Districts along the river below each station (down to the next one).
REACH = {
    "skardu": ["Skardu", "Gilgit"], "partab": ["Diamir", "Astore"], "besham": ["Upper Kohistan", "Lower Kohistan", "Shangla", "Batagram", "Tor Ghar"],
    "tarbela": ["Swabi", "Haripur", "Attock"], "nowshera": ["Nowshera", "Charsadda", "Peshawar"], "kalabagh": ["Mianwali", "Dera Ismail Khan", "Bhakkar"],
    "chashma": ["Dera Ismail Khan", "Bhakkar", "Layyah"], "taunsa": ["Layyah", "Muzaffargarh", "Dera Ghazi Khan", "Rajanpur"],
    "guddu": ["Rahim Yar Khan", "Rajanpur", "Kashmore", "Ghotki", "Jacobabad", "Shikarpur"],
    "sukkur": ["Sukkur", "Khairpur", "Larkana", "Naushahro Feroze", "Dadu", "Shaheed Benazir Abad", "Matiari", "Jamshoro", "Hyderabad"],
    "kotri": ["Hyderabad", "Jamshoro", "Thatta", "Sujawal", "Tando Muhammad Khan"],
    "mangla": ["Mirpur", "Jhelum", "Gujrat"], "rasul": ["Mandi Bahauddin", "Khushab", "Sargodha", "Jhang"],
    "marala": ["Sialkot", "Gujrat"], "khanki": ["Gujranwala", "Hafizabad", "Gujrat", "Mandi Bahauddin"], "qadirabad": ["Hafizabad", "Mandi Bahauddin", "Chiniot", "Sargodha", "Jhang"],
    "trimmu": ["Jhang", "Khanewal", "Multan", "Muzaffargarh"], "panjnad": ["Muzaffargarh", "Bahawalpur", "Rahim Yar Khan"],
    "jassar": ["Narowal", "Sheikhupura"], "shahdara": ["Lahore", "Sheikhupura", "Nankana Sahib", "Kasur"], "balloki": ["Nankana Sahib", "Okara", "Sahiwal", "Faisalabad", "Toba Tek Singh"],
    "sidhnai": ["Khanewal", "Toba Tek Singh"], "gswala": ["Kasur", "Okara"], "sulemanki": ["Pakpattan", "Bahawalnagar", "Vehari", "Okara"], "islam": ["Vehari", "Lodhran", "Bahawalpur", "Bahawalnagar"],
}
# Foothill districts where short heavy rain turns into hill torrents.
TORRENT = {"Dera Ghazi Khan", "Rajanpur", "Dera Ismail Khan", "Tank", "Barkhan", "Musakhel", "Zhob", "Sherani", "Loralai", "Kohlu", "Dera Bugti", "Sibi", "Kachhi",
           "Jhal Magsi", "Nasirabad", "Khuzdar", "Lasbela", "Awaran", "Killa Saifullah", "Duki", "Ziarat", "Harnai", "Qambar Shahdadkot", "Dadu", "Jamshoro",
           "Lakki Marwat", "Bannu", "Karak", "Kohat", "Lehri", "Kech", "Gwadar"}
CITY = {"Lahore", "Central Karachi", "East Karachi", "Korangi", "Malir", "Keamari", "South Karachi", "West Karachi", "Rawalpindi", "Islamabad", "Peshawar", "Hyderabad",
        "Faisalabad", "Gujranwala", "Sialkot", "Multan", "Quetta"}
# Rain in one day, mm (highest value inside the district). PMD/FFD classes: heavy > 30, very heavy > 70, extremely heavy > 150.
RAIN_CUTS = {"plain": (70, 150), "torrent": (30, 70), "city": (50, 100)}
GLOF_SEASON = (5, 6, 7, 8, 9)
GLOF_DISTRICTS = ["Hunza", "Nagar", "Gilgit", "Ghizer", "Gupis-Yasin", "Diamir", "Astore", "Skardu", "Shigar", "Ghanche", "Kharmang", "Roundu", "Chitral", "Upper Dir", "Swat", "Upper Kohistan"]
TTL_S, TTL_OFF_S = 1800, 3600
EO_MAX_AGE_H = 6


# ------------------------------------------------------------------ helpers
def _age_h(iso, now):
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return (now - t).total_seconds() / 3600
    except (TypeError, ValueError):
        return None


def _median(a):
    a = [x for x in a if x is not None and np.isfinite(x)]
    return float(np.median(a)) if a else None


def today_store(store, live):
    """The cleaned history with this morning's live reading added (so the outlook starts from now)."""
    c = {k: v.copy() for k, v in store["clean"].items()}
    n = c["in6"].shape[1]
    for sid, r in live.items():
        if not r.get("time"):
            continue
        t = datetime.fromisoformat(r["time"])
        i = fs.day_index(t.date())
        if not 0 <= i < n + 3 or t.hour > 10:
            continue
        if i >= n:
            grow = i - n + 1
            c = {k: np.concatenate([v, np.full((v.shape[0], grow), np.nan, v.dtype)], axis=1) for k, v in c.items()}
            n = i + 1
        s = fs.IDS.index(sid)
        for key, v in (("in6", r.get("inflow")), ("out6", r.get("outflow"))):
            peak = fs.STATIONS[sid][6]
            if v is not None and not (peak and v > 1.1 * peak) and np.isnan(c[key][s, i]):
                c[key][s, i] = v
    return {**store, "clean": c}


def flow_history(store, sid):
    """Same-date comparison, last 30 days, this and last season's highest."""
    c = store["clean"]
    s = fs.IDS.index(sid)
    q = np.where(np.isfinite(c["in6"][s]), c["in6"][s], c["out6"][s])
    mx = np.where(np.isfinite(c["inmax"][s]), c["inmax"][s], c["outmax"][s])
    mx = np.fmax(mx, q)
    last = q.size - 1
    d = fs.index_day(last)
    ref = [q[i] for i in range(last - 360) if np.isfinite(q[i]) and abs((fs.index_day(i).timetuple().tm_yday - d.timetuple().tm_yday + 182) % 365 - 182) <= 7]
    cur = next((float(q[i]) for i in range(last, last - 3, -1) if np.isfinite(q[i])), None)
    out = {"days30": [None if not np.isfinite(v) else round(float(v)) for v in q[-30:]],
           "days30_from": fs.index_day(last - 29).isoformat(),
           "percentile": round(100 * float(np.mean(np.array(ref) < cur))) if cur is not None and len(ref) >= 30 else None,
           "normal": round(float(np.median(ref))) if len(ref) >= 30 else None, "season_peaks": []}
    for y in range(2016, d.year + 1):
        a, b = fs.day_index(date(y, 6, 1)), min(fs.day_index(date(y, 10, 31)), last)
        if b <= a:
            continue
        w = mx[a:b + 1]
        if np.isfinite(w).sum() >= 45:
            k = int(np.nanargmax(w))
            tiers = [fs.tier(sid, v) for v in w if np.isfinite(v)]
            out["season_peaks"].append({"year": y, "q": round(float(w[k])), "date": fs.index_day(a + k).isoformat(), "tier": fs.tier(sid, float(w[k])),
                                        "flood_days": sum(1 for t in tiers if t), "high_days": sum(1 for t in tiers if t and t >= 3)})
    return out


# --------------------------------------------------------- assisting sources
def glofas_view(g, now):
    """GloFAS points with only the days still ahead; stale runs and unreliable points are marked, not scored."""
    if not g:
        return {"status": "not available", "points": []}
    age = (now.date() - date.fromisoformat(g["forecast_date"])).days
    fresh = age * 24 <= FRESH_H["glofas"]
    today = now.astimezone(fs.PKT).date().isoformat()
    pts = []
    for p in g.get("points") or []:
        ahead = [(d, i) for i, d in enumerate(g.get("lead_dates", {}).values() if isinstance(g.get("lead_dates"), dict) else []) if d >= today]
        s, q = p.get("s") or [], p.get("q") or []
        order = ["normal", "warning", "danger", "extreme"]
        st = [(s[i], d) for d, i in ahead if i < len(s) and s[i] in order]
        qs = [(q[i], d) for d, i in ahead if i < len(q) and q[i] is not None]
        worst = max(st, key=lambda x: order.index(x[0])) if st else (None, None)
        pk = max(qs, key=lambda x: x[0]) if qs else (None, None)
        state = "unreliable" if p.get("quality") == "unreliable" else "no forecast" if not st else "stale" if not fresh else "valid"
        pts.append({"id": p["id"], "river": p.get("river"), "lon": p["lon"], "lat": p["lat"], "state": state, "worst": worst[0], "worst_date": worst[1],
                    "peak_q": pk[0], "peak_date": pk[1], "warning": p.get("warning"), "danger": p.get("danger"), "extreme": p.get("extreme"),
                    "peak_prob": p.get("peak_prob")})
    cnt = {k: sum(1 for p in pts if p["state"] == k) for k in ("valid", "stale", "unreliable", "no forecast")}
    ok = [p for p in pts if p["state"] in ("valid", "stale")]
    return {"status": "valid" if fresh else "stale", "via": "Open-Meteo" if g.get("feed") == "open-meteo" else "IWMI", "run": g["forecast_date"], "received": g.get("received_at") or g.get("fetched_at"), "to": max((g.get("lead_dates") or {}).values(), default=None), "age_days": age, "days_ahead": sum(1 for d in (g.get("lead_dates") or {}).values() if d >= today),
            "counts": cnt, "above": sum(1 for p in ok if p["worst"] not in (None, "normal")), "points": pts}


def floodhub_view(h, now):
    if not h:
        return {"status": "not available", "gauges": []}
    age = _age_h(h.get("issued_time"), now)
    fresh = age is not None and age <= FRESH_H["floodhub"]
    gs = []
    for g in h.get("gauges") or []:
        sev = g.get("severity")
        gs.append({"id": g["id"], "river": g.get("river"), "lon": g["lon"], "lat": g["lat"], "severity": sev, "trend": g.get("trend"), "verified": bool(g.get("verified")),
                   "state": "stale" if not fresh else "no forecast" if sev not in ("NO_FLOODING", "ABOVE_NORMAL", "SEVERE", "EXTREME") else "valid"})
    return {"status": "valid" if fresh else "stale", "issued": h.get("issued_time"), "age_h": None if age is None else round(age, 1),
            "counts": {k: sum(1 for g in gs if g["state"] == k) for k in ("valid", "stale", "no forecast")},
            "flooding": sum(1 for g in gs if g["state"] == "valid" and g["severity"] != "NO_FLOODING"), "verified": sum(1 for g in gs if g["verified"]), "gauges": gs}


def _km(a, b):
    r = np.pi / 180
    h = np.sin((b[1] - a[1]) * r / 2) ** 2 + np.cos(a[1] * r) * np.cos(b[1] * r) * np.sin((b[0] - a[0]) * r / 2) ** 2
    return 12742 * np.arcsin(np.sqrt(h))


def _near(points, lon, lat, km=40):
    return [p for p in points if _km((lon, lat), (p["lon"], p["lat"])) <= km]


# ------------------------------------------------------------------ stations
def warn_ready(skill):
    """May this station/lead raise a level? It must have caught most floods in the test without too many false alarms."""
    f = (skill or {}).get("flood") or {}
    return f.get("events", 0) >= 8 and (f.get("pod") or 0) >= 0.6 and (f.get("far") if f.get("far") is not None else 1) <= 0.4


def stations(live, outlook, mdl, bulletin, bul_fresh, adv, adv_on, gl, fh, hist, now):
    season = site.season(now.astimezone(fs.PKT).date())["open"]
    rows = []
    for sid in fs.IDS:
        name, river = fs.STATIONS[sid][:2]
        r = live.get(sid) or {}
        age = _age_h(r.get("time"), now)
        state = "no reading" if r.get("inflow") is None and r.get("outflow") is None else "time unknown" if age is None else "stale" if age > FRESH_H["ffd_season" if season else "ffd"] else "current"
        flows = [v for v in (r.get("inflow"), r.get("outflow")) if v is not None]
        q = max(flows) if flows else None
        obs = fs.tier(sid, q) if state == "current" else None
        reasons, lv, conf = [], 0, "High" if state == "current" else "Low"
        if obs:
            lv = TIER_LEVEL[obs]
            reasons.append({"who": "FFD reading", "text": f"{fs.TIER_LABEL[fs.TIERS[obs]]} now"})
        # official forecast: the feed's own, else the bulletin when it is today's or yesterday's
        b = (bulletin or {}).get("stations", {}).get(sid) if bul_fresh else None
        ftier = None
        if r.get("ffd_forecast"):
            ftier = _tier_from_label(r["ffd_forecast"])
        if ftier is None and b and b.get("forecast"):
            ftier = fs.tier(sid, b["forecast"][1])
        if ftier is None and b:
            ftier = _tier_from_label(b.get("forecast_level"))
        if ftier:
            flv = min(TIER_LEVEL[ftier], 3)
            if flv > lv:
                lv, conf = flv, "Medium"
            reasons.append({"who": "FFD forecast", "text": f"{fs.TIER_LABEL[fs.TIERS[ftier]]} expected in 24 hours"})
        if adv_on and adv.get("river") and river.lower() in adv["river"].lower():
            if lv < 2:
                lv, conf = 2, "Medium"
            reasons.append({"who": "FFD advisory", "text": adv["title"].capitalize()})
        # assisting sources
        assist = []
        o = outlook.get(sid) or {}
        for x in o.get("leads", []):
            if x.get("status") != "ok" or not warn_ready((mdl["models"].get(f"{sid}:{x['lead']}") or {}).get("skill")):
                continue
            p = x.get("prob") or {}
            s = 2 if max(p.get("medium", 0), p.get("high", 0)) >= 0.5 else 1 if p.get("low", 0) >= 0.5 else 0
            if s and (not assist or assist[0][1] < s):
                assist = [("NCOP river outlook", s, f"{round(100 * max(p.get('medium', 0) if s == 2 else p.get('low', 0), 0))}% chance of {'medium' if s == 2 else 'low'} flood in {x['lead']} day{'s' if x['lead'] > 1 else ''}")]
        if r.get("lon") is not None:
            g = [p for p in _near(gl["points"], r["lon"], r["lat"]) if p["state"] == "valid" and p["worst"] not in (None, "normal")]
            if g:
                w = max(g, key=lambda p: ["normal", "warning", "danger", "extreme"].index(p["worst"]))
                assist.append(("GloFAS", 1 if w["worst"] == "warning" else 2, f"{w['worst']} level around {w['worst_date']}"))
            k = [p for p in _near(fh["gauges"], r["lon"], r["lat"], 25) if p["state"] == "valid" and p["severity"] != "NO_FLOODING"]
            if k:
                w = max(k, key=lambda p: ["NO_FLOODING", "ABOVE_NORMAL", "SEVERE", "EXTREME"].index(p["severity"]))
                assist.append(("Google Flood Hub", 1 if w["severity"] == "ABOVE_NORMAL" else 2, w["severity"].replace("_", " ").lower()))
        strong = sum(1 for a in assist if a[1] >= 2)
        alv = 2 if strong >= 2 else 1 if assist else 0
        if alv > lv:
            lv, conf = alv, "Medium" if len(assist) >= 2 else "Low"
        reasons += [{"who": a[0], "text": a[2]} for a in assist]
        lim, des = fs.limits(sid), fs.design(sid)
        h = hist[sid]
        rows.append({"id": sid, "name": name, "river": river, "lon": r.get("lon"), "lat": r.get("lat"), "state": state, "time": r.get("time"),
                     "inflow": r.get("inflow"), "outflow": r.get("outflow"), "q": q, "trend": r.get("trend"), "tier": obs, "ffd_status": r.get("ffd_status"),
                     "level_ft": r.get("level_ft"), "limits": lim, "design": des, "of_low": round(q / lim["low"], 2) if q is not None and lim else None,
                     "record": fs.STATIONS[sid][6], "record_year": fs.STATIONS[sid][7], "normal": h["normal"], "percentile": h["percentile"],
                     "days30": h["days30"], "days30_from": h["days30_from"], "peaks": h["season_peaks"][-4:],
                     "bulletin": None if not b else {k: b[k] for k in ("forecast", "forecast_text", "forecast_level")},
                     "outlook": o, "up": [[u, hrs] for u, hrs in fs.UPSTREAM.get(sid, [])], "districts": REACH.get(sid, []),
                     "watch": lv, "confidence": conf, "reasons": reasons})
    return rows


def _tier_from_label(s):
    s = str(s or "").lower()
    if not s or "below low" in s or "normal" in s:
        return 0 if s else None
    for i, k in ((5, "exceptional"), (4, "very high"), (3, "high"), (2, "medium"), (1, "low")):
        if k in s:
            return i
    return None


# ------------------------------------------------------------------ rain
def rain_outlook(now):
    """District rain for the next 7 days (NCOP bias-corrected GEFS) and what it means for flash floods."""
    from . import gefs_districts as gd
    p = gd.district_stats("precip")
    age = _age_h(p["init_time"], now)
    rows = []
    for d in p["districts"]:
        if d["province"] == "Indian_Illegally_Occupied_Jammu_Kashmir":
            continue
        mean = [v for v in (d.get("precip") or [])[:7]]
        mx = [v for v in (d.get("precip_max") or d.get("precip") or [])[:7]]
        if not mean:
            continue
        kind = "torrent" if d["name"] in TORRENT else "city" if d["name"] in CITY else "plain"
        lo, hi = RAIN_CUTS[kind]
        days3 = mx[:3]
        top = max(days3) if days3 else 0
        wk = max(range(len(mx)), key=lambda i: mx[i]) if mx else 0
        lv = 2 if top >= hi else 1 if top >= lo else 0
        rows.append({"name": d["name"], "province": d["province"], "kind": kind, "max3": round(top, 1), "sum3": round(sum(mean[:3]), 1), "sum7": round(sum(mean), 1),
                     "peak_mm": round(mx[wk], 1) if mx else None, "peak_day": p["dates"][wk] if mx else None, "level": lv})
    fresh = age is not None and age <= FRESH_H["gefs"] + 24
    return {"status": "valid" if fresh else "stale", "run": p["run"], "init": p["init_time"], "received": _stats_time(gd, p["run"]), "age_h": None if age is None else round(age), "from": p["dates"][0], "dates": p["dates"][:7], "rows": rows}


def _stats_time(gd, run):
    """When NCOP finished processing this GEFS run."""
    try:
        return datetime.fromtimestamp(os.path.getmtime(os.path.join(gd.gc._root(), run, gd._STATS_FILE)), timezone.utc).isoformat()
    except (OSError, AttributeError):
        return None


def catchments(eo, now):
    """Rain fallen, rain expected (two models), soil wetness and snow for the six river catchments."""
    if eo is None:
        return {"status": "not available", "rows": []}
    end = int(eo["last_obs"])
    rows = []
    age = (now.date() - fs.index_day(end)).days
    # newest GFS run present
    gi = next((i for i in range(eo["gfs"].shape[2] - 1, -1, -1) if np.isfinite(eo["gfs"][:3, :, i]).all()), None)
    for k, name in enumerate(fe.CATCHMENTS):
        r = {"name": name}
        for w in (1, 3, 7, 30):
            tot, pct = fe.rain_percentile(eo, k, end, w)
            r[f"r{w}"], r[f"p{w}"] = None if tot is None else round(tot, 1), pct
        if eo.get("roll_end"):                       # totals to the last half hour replace those to the last full UTC day
            for j, w in enumerate((1, 3, 7, 30)):
                if np.isfinite(eo["roll"][k, j]):
                    r[f"r{w}"] = round(float(eo["roll"][k, j]), 1)
        v, pct = fe.soil_percentile(eo, k)
        r["soil"], r["soil_pct"] = None if v is None else round(v, 2), pct
        r["snow"] = fe.snow_now(eo, k) if name in ("Tarbela", "Kabul", "Mangla", "Chenab") else None
        for key, a, run in (("gfs", eo["gfs_now"][k] if eo.get("gfs_run") else eo["gfs"][:, k, gi] if gi is not None else None, eo.get("gfs_run") or (fs.index_day(gi).isoformat() if gi is not None else None)),
                            ("ecmwf", eo["ifs"][:, k] if eo.get("ifs_run") else None, eo.get("ifs_run"))):
            old = (_age_h(run, now) or 0) > FRESH_H["nwp"]               # an old forecast is left out, not shown as today's
            r[key] = None if old or a is None or not np.isfinite(a).all() else {"d1_3": round(float(np.maximum(a[:3], 0).sum()), 1), "d4_7": round(float(np.maximum(a[3:], 0).sum()), 1)}
        rows.append(r)
    return {"status": "valid" if age * 24 <= FRESH_H["imerg"] else "stale", "rain_to": eo.get("roll_end") or fs.index_day(end).isoformat(), "snow_to": eo.get("snow_to") or None, "soil_to": fs.index_day(int(eo["last_smap"])).isoformat(),
            "gfs_run": eo.get("gfs_run") or (fs.index_day(gi).isoformat() if gi is not None else None), "ecmwf_run": eo.get("ifs_run") or None, "rows": rows}


def glof_status(now):
    """PMD glacier-lake stations. Labels of stations that send no data are not treated as alerts."""
    import requests
    try:
        j = requests.get("http://172.18.7.21:8000/api/pmd/monitor/glof-obs/", timeout=30).json()
        f = [x["properties"] for x in j.get("features", [])]
    except Exception as e:
        return {"status": "not available", "why": type(e).__name__, "stations": 0}
    on = [p for p in f if str(p.get("connectivity", "")).upper() == "ONLINE"]
    al = [p for p in on if str(p.get("alert_label", "")).upper() not in ("NORMAL", "")]
    return {"status": "valid" if on else "not available", "stations": len(f), "online": len(on),
            "alerts": [{"name": p["name"], "city": p.get("city"), "label": p["alert_label"]} for p in al][:20],
            "offline_with_label": sum(1 for p in f if p not in on and str(p.get("alert_label", "")).upper() not in ("NORMAL", "")),
            "in_season": now.month in GLOF_SEASON}


def station_rain(now):
    """Rain measured at PMD stations and FFD's automatic stations, only readings of the last 36 hours."""
    import requests
    rows, used, seen = [], 0, 0
    limit = now.astimezone(fs.PKT).replace(tzinfo=None) - timedelta(hours=36)
    for url, name, val, when in (("http://172.18.7.21:8000/api/pmd/nwfc/observations/", "name", "rain_24h", lambda p: str(p.get("obs_time") or "")),
                                 ("http://172.18.7.21:8000/get-weather-pmdffd-data/", "name", "rain_daily", lambda p: f"{p.get('rain_daily_date') or ''} {p.get('rain_daily_time') or ''}")):
        try:
            fts = requests.get(url, timeout=40).json().get("features", [])
        except Exception:
            continue
        seen += len(fts)
        for f in fts:
            p = f["properties"]
            t = "".join(ch for ch in when(p) if ch.isdigit())
            try:
                at = datetime.strptime(t[:12].ljust(12, "0"), "%Y%m%d%H%M")
            except ValueError:
                continue
            v = p.get(val)
            if at < limit or v is None or not 0 <= float(v) < 700:
                continue
            used += 1
            if float(v) > 0:
                rows.append({"name": str(p[name]).title(), "mm": float(v)})
    rows.sort(key=lambda r: -r["mm"])
    return {"status": "valid" if used >= 20 else "not available", "stations": used, "listed": seen, "wet": len(rows), "top": rows[:6], "heavy": sum(1 for r in rows if r["mm"] > 30)}


def pmd_rain_warnings():
    import requests
    try:
        j = requests.get("http://172.18.7.21:8000/api/pmd/monitor/warnings/", timeout=60).json()
    except Exception as e:
        return {"status": "not available", "why": type(e).__name__, "count": None}
    p = [x.get("properties") or {} for x in j.get("features", [])]
    rain = [x for x in p if any(k in (str(x.get("element")) + str(x.get("element_label"))).upper() for k in ("RAIN", "PRECIP", "THUNDER", "FLOOD", "TP"))]
    return {"status": "valid", "count": len(rain), "all": len(p), "levels": {k: sum(1 for x in rain if x.get("level") == k) for k in ("blue", "yellow", "orange", "red")}}


# ---------------------------------------------------------------- districts
def districts(st, rain, atlas, glof, now):
    by = {}
    ok_rain = rain and rain["status"] == "valid"
    for r in (rain or {}).get("rows", []):
        by[r["name"]] = {"name": r["name"], "province": r["province"], "level": 0, "hazards": []}
        if ok_rain and r["level"]:
            kind = {"torrent": "Hill torrent / flash flood", "city": "City flooding", "plain": "Heavy rain"}[r["kind"]]
            by[r["name"]]["hazards"].append({"hazard": kind, "level": r["level"], "confidence": "Low",
                                             "why": f"up to {r['max3']:.0f} mm in a day expected in the next 3 days"})
    for s in st:
        if s["watch"]:
            for d in s["districts"]:
                by.setdefault(d, {"name": d, "province": None, "level": 0, "hazards": []})["hazards"].append(
                    {"hazard": f"River {s['river']} at {s['name']}", "level": s["watch"], "confidence": s["confidence"],
                     "why": "; ".join(x["text"] for x in s["reasons"][:2]), "station": s["id"]})
    for a in (glof or {}).get("alerts", []):
        hit = next((d for d in GLOF_DISTRICTS if str(a.get("city", "")).lower() in d.lower()), None)
        if hit and hit in by:
            by[hit]["hazards"].append({"hazard": "Glacier-lake flood", "level": 2, "confidence": "Medium", "why": f"PMD station {a['name']}: {a['label'].lower()}"})
    ex = {r["name"]: r for r in (atlas or {}).get("districts", [])}
    out = []
    for d in by.values():
        d["level"] = max([h["level"] for h in d["hazards"]] or [0])
        e = ex.get(d["name"])
        d["province"] = d["province"] or (e or {}).get("province")
        d["hazards"].sort(key=lambda h: -h["level"])
        if d["level"] and e:
            river = any(h.get("station") for h in d["hazards"])
            zone = "once" if d["level"] >= 3 else "often"
            d["exposure"] = {"zone": zone, "river": river, "people": e["people"], "people_zone": e[zone]["people"], "crop_km2": e[zone]["crop_km2"],
                             "places": e.get("places"), "often": e["often"]["people"], "once": e["once"]["people"], "rp100": e["rp100"]["people"]}
        out.append(d)
    return sorted(out, key=lambda d: (-d["level"], -len(d["hazards"]), d["name"]))


def planning(atlas, n=12):
    """Where the most people stand on flood plains, whatever today's level."""
    if not atlas:
        return None
    rows = atlas["districts"]
    ys = atlas["observed_years"]
    flooded = lambda r: sum(1 for y in ys if (r.get("seen", {}).get(y) or {}).get("km2", 0) >= max(25, 0.02 * max(r["km2"], 1)))
    pick = lambda r: {"name": r["name"], "province": r["province"], "people": r["people"], "once": r["once"]["people"], "often": r["often"]["people"],
                      "rp100": r["rp100"]["people"], "crop_km2": r["once"]["crop_km2"], "years_flooded": flooded(r), "places": r.get("places")}
    tot = lambda k: sum(r[k]["people"] for r in rows)
    places = {}
    for k in ("schools", "health", "bridges", "settlements"):
        v = [r["places"][k] for r in rows if k in (r.get("places") or {})]
        if v:
            places[k] = [sum(x[i] for x in v) for i in range(3)]
    return {"built": atlas["built"], "years": ys, "people": {k: tot(k) for k in ("once", "often", "rp10", "rp100", "rp500")},
            "km2": {k: sum(r[k]["km2"] for r in rows) for k in ("once", "often", "rp10", "rp100")}, "crop_km2": sum(r["once"]["crop_km2"] for r in rows), "places": places,
            "observed": {y: {"people": sum((r.get("seen", {}).get(y) or {}).get("people", 0) for r in rows), "km2": sum((r.get("seen", {}).get(y) or {}).get("km2", 0) for r in rows)} for y in ys},
            "by_people": [pick(r) for r in sorted(rows, key=lambda r: -r["once"]["people"])[:n]],
            "by_share": [pick(r) for r in sorted((r for r in rows if r["people"] >= 100_000), key=lambda r: -r["once"]["people"] / max(r["people"], 1))[:n]],
            "often": [pick(r) for r in sorted(rows, key=lambda r: (-flooded(r), -r["often"]["people"]))[:n]]}


# -------------------------------------------------------------- reservoirs
def reservoirs(live, bulletin, storage, now, fresh=True):
    """Level now from FFD. Stored volume only when FFD's bulletin is of today or yesterday."""
    out = []
    for sid, dam in (("tarbela", "Tarbela"), ("mangla", "Mangla")):
        r, b = live.get(sid) or {}, ((bulletin or {}).get("reservoirs") or {}).get(dam)
        lo, hi = (b["dead_ft"], b["max_ft"]) if b else ((1380.0, 1550.0) if dam == "Tarbela" else (1040.0, 1242.0))
        lev = r.get("level_ft")
        out.append({"name": dam, "level_ft": lev, "dead_ft": lo, "max_ft": hi, "time": r.get("time"), "room_ft": round(hi - lev, 1) if lev else None,
                    "range_pct": round(100 * (lev - lo) / (hi - lo)) if lev else None, "inflow": r.get("inflow"), "outflow": r.get("outflow"),
                    "bulletin": None if not (b and fresh) else {**b, "date": bulletin["date"]}, "inflow_outlook": ((storage or {}).get("dams") or {}).get(dam) if (storage or {}).get("to", "") >= now.astimezone(fs.PKT).date().isoformat() else None})
    return out


# ------------------------------------------------------------------ issues
def data_issues(store, live, gl, fh, glof, bulletin_age, cat, season, mdl, now):
    out = []
    add = lambda kind, text, act: out.append({"kind": kind, "text": text, "action": act})
    recent = [i for i in store["issues"] if store["start"] + i[1] >= fs.day_index(now.date()) - 400]
    for sid, i, v, why in recent[:6]:
        add("held back", f"{fs.STATIONS[sid][0]}, {fs.index_day(store['start'] + i).isoformat()}: {v:,.0f} cusecs, {why}.", "Not used")
    miss = [fs.STATIONS[s][0] for s in fs.IDS if s not in live]
    if miss:
        add("no reading", f"No live reading: {', '.join(miss)}.", "Shown as missing, not as normal")
    zero = [fs.STATIONS[s][0] for s, r in live.items() if r.get("outflow") == 0]
    if zero:
        add("zero flow", f"Zero outflow reported at {', '.join(zero)}. In winter barrages often pass nothing downstream.", "Kept as reported")
    if gl["status"] == "stale":
        add("stale", f"The GloFAS run is {gl['age_days']} days old (limit 3).", "Shown with its date; not used for any level")
    elif gl["status"] == "not available":
        add("missing", "GloFAS could not be read.", "Not counted as 'no flood'")
    if gl.get("counts", {}).get("unreliable"):
        add("unreliable", f"{gl['counts']['unreliable']} GloFAS points sit on the wrong model cell.", "Left out of every count")
    if fh["status"] != "valid":
        add(fh["status"], "Google Flood Hub is not current.", "Not counted as 'no flood'")
    if glof.get("stations") and not glof.get("online"):
        add("offline", f"All {glof['stations']} PMD glacier-lake stations are offline; {glof['offline_with_label']} still carry a 'warning' label.", "Labels not used; glacier-lake status is 'not known'")
    if season["open"] and (bulletin_age is None or bulletin_age > 1):
        add("late", f"FFD's daily bulletin is {bulletin_age if bulletin_age is not None else 'not'} days old in the flood season.", "FFD readings used; forecast part left out")
    if cat["status"] != "valid":
        add(cat["status"], "Catchment rain and soil data are not current.", "Left out of the outlook")
    bad = sum(1 for m in mdl["models"].values() if not m.get("usable"))
    add("model", f"The NCOP river outlook is not skilful for {bad} of {len(mdl['models'])} station-day pairs.", "Those are shown as 'not skilful'")
    return out


def source_health(live_src, live, gl, fh, rain, cat, sdoc, glof, pmd, atlas, store, now, stn, hyd=None, sus=None):
    newest = max([r["time"] for r in live.values() if r.get("time")] or [None], key=lambda x: x or "")
    b, adv, mf, sts, day = (sdoc.get(k) for k in ("bulletin", "advisory", "storage", "status", "daily"))
    row = lambda n, t, per, st, lic: {"name": n, "type": t, "period": per, "state": st, "licence": lic}
    recent = lambda iso, h: "current" if iso and (_age_h(iso, now) or 1e9) <= h else "out of date" if iso else "missing"
    in_season = site.season(now.astimezone(fs.PKT).date())["open"]
    rows = [row(f"FFD river readings ({live_src})", "Observed", newest, "current" if newest and (_age_h(newest, now) or 99) <= FRESH_H["ffd"] else "out of date", "PMD/FFD"),
            row("FFD river status", "Observed", (sts or {}).get("at"), recent((sts or {}).get("at"), FRESH_H["ffd"]), "PMD/FFD"),
            row("FFD daily flood report", "Observed", (day or {}).get("at"), recent((day or {}).get("at"), FRESH_H["ffd"]), "PMD/FFD"),
            row("FFD flood advisories", "Forecast", (adv or {}).get("read_at"), "in force" if site.advisory_in_force(adv) else "none in force", "PMD/FFD")]
    if in_season:                                   # FFD issues its bulletin only from 15 June to 15 October
        rows.append(row("FFD daily bulletin", "Observed, Forecast", (b or {}).get("date"), "current" if site.bulletin_age_days(sdoc) in (0, 1) else "out of date", "PMD/FFD, all rights reserved"))
    return rows + [
            row("FFD reservoir inflow outlook", "Forecast", (mf or {}).get("to"), "current" if mf and (mf.get("to") or "") >= now.date().isoformat() else "out of date", "PMD/FFD"),
            row("FFD reading history (NCOP)", "Observed", fs.index_day(store["start"] + store["raw"]["in6"].shape[1] - 1).isoformat(), "current", "PMD/FFD"),
            row(f"GloFAS (Copernicus), via {gl.get('via') or 'IWMI'}", "Forecast", gl.get("run"), {"valid": "current", "stale": "out of date"}.get(gl["status"], "missing"), "Copernicus"),
            row("Google Flood Hub, via IWMI", "Forecast", (fh.get("issued") or "")[:10] or None, {"valid": "current", "stale": "out of date"}.get(fh["status"], "missing"), "CC BY 4.0"),
            row("NCOP GEFS district rain", "Forecast", (lambda x: f"{x[:4]}-{x[4:6]}-{x[6:8]}" if x else None)((rain or {}).get("run")), {"valid": "current", "stale": "out of date"}.get((rain or {}).get("status"), "missing"), "NOAA open data"),
            row("PMD and FFD station rain", "Observed", now.date().isoformat() if stn.get("status") == "valid" else None, "current" if stn.get("status") == "valid" else "missing", "PMD"),
            row("GPM IMERG catchment rain", "Modelled (satellite)", cat.get("rain_to"), {"valid": "current", "stale": "out of date"}.get(cat["status"], "missing"), "NASA open data"),
            row("SMAP root-zone wetness", "Modelled (satellite)", cat.get("soil_to"), "current" if cat.get("soil_to") else "missing", "NASA open data"),
            row("GFS and ECMWF catchment rain", "Forecast", cat.get("gfs_run"), "current" if cat.get("gfs_run") else "missing", "NOAA / ECMWF CC BY 4.0"),
            row("PMD glacier-lake stations", "Observed", None, "current" if glof.get("online") else "offline", "PMD"),
            row("PMD weather warnings", "Forecast", now.date().isoformat() if pmd["status"] == "valid" else None, "current" if pmd["status"] == "valid" else "missing", "PMD"),
            row("Flood-plain atlas (JRC, NCOP flood extents, GHSL)", "Modelled, Observed", (atlas or {}).get("built"), "current" if atlas else "missing", "CC BY 4.0 / NCOP"),
            row("Depth and arrival catalogue (NCOP)", "Modelled", (hyd or {}).get("built"), "current" if hyd else "missing", "NCOP; terrain CC BY-NC-SA"),
            row("Flood-susceptibility map (NCOP)", "Modelled", (sus or {}).get("built"), "current" if sus else "missing", "NCOP; terrain CC BY-NC")]


# ------------------------------------------------------------------ actions
MATRIX = [
    ("NORMAL", "Routine", "Keep watching; fix gauges, embankments and contact lists.", "FFD, NCOP, irrigation departments"),
    ("ELEVATED", "1 to 3 days", "Check readings and upstream stations; tell PDMAs and technical teams.", "FFD, NCOP, PDMAs"),
    ("ALERT", "12 to 72 hours", "Review evacuation and relief plans; inspect weak embankments; move stocks and boats forward.", "PDMAs, DDMAs, irrigation departments"),
    ("WARNING", "6 to 48 hours", "Warn people through authorised channels; prepare shelters and transport; protect hospitals, roads and bridges.", "PDMAs, DDMAs, Rescue 1122, NHA"),
    ("SEVERE", "Now", "Evacuate and rescue where authorised; open shelters; daily damage reporting.", "NDMA/NEOC, provincial governments, armed forces, Rescue 1122"),
]


def actions(nat, st, ds, res, glof, season, plan, rain, issues):
    """Priority actions. Each has a fixed id, the rule that opened it, and what closes it."""
    out = []

    def add(aid, title, text, owner, by, trigger, closes):
        out.append({"id": aid, "title": title, "text": text, "owner": owner, "by": by, "trigger": trigger, "closes": closes})
    hot = [s for s in st if s["watch"] >= 1]
    for river in sorted({s["river"] for s in hot}, key=lambda r: -max(s["watch"] for s in hot if s["river"] == r))[:2]:
        w = max((s for s in hot if s["river"] == river), key=lambda s: s["watch"])
        lim = w.get("limits") or {}
        fired = f"{w['name']} at {w['q']:,.0f} cusecs (Low limit {lim['low']:,.0f})" if w.get("q") and lim.get("low") else "; ".join(x["who"] for x in w["reasons"][:2])
        add(f"river-{river.lower()}", f"{LEVELS[w['watch']].capitalize()} on the {w['river']}: act below {w['name']}",
            f"{'; '.join(x['who'] + ': ' + x['text'] for x in w['reasons'][:2])}. Districts below: {', '.join(w['districts'][:6])}. {MATRIX[w['watch']][2]}",
            MATRIX[w["watch"]][3], MATRIX[w["watch"]][1], f"{LEVELS[w['watch']].capitalize()} level on the {river}: {fired}", "every station on the river is back to Normal")
    wet = [d for d in ds if d["level"] >= 1 and any("station" not in h for h in d["hazards"])]
    if wet:
        add("flash-rain", f"Prepare {len(wet)} districts for flash or city flooding", f"Heavy rain is expected in {', '.join(d['name'] for d in wet[:6])}. Check nullahs, underpasses and hill-torrent crossings.",
            "DDMAs, municipal services, Rescue 1122", "within 24 hours", f"Rain limit reached in {len(wet)} districts within 3 days", "no district reaches the limit")
    if glof.get("stations") and not glof.get("online"):
        add("glof-stations", f"Bring the {glof['stations']} glacier-lake stations back online", "No station is sending data, so a glacier-lake flood would come without this warning. Repair before May.",
            "PMD, GB and KP disaster authorities", "before May" if not glof.get("in_season") else "now", f"0 of {glof['stations']} stations online", "at least one station sends data")
    if not season["open"]:
        add("pre-season", f"Use the {season['days_to_next']} days before the flood season", "Repair embankments and gauges, agree evacuation routes and stocks, and rehearse. FFD's daily bulletins restart on 15 June.",
            "Provincial irrigation departments, PDMAs, DDMAs", "before 15 June", "Flood season closed", "15 June")
        if plan:
            top = [r["name"] for r in plan["by_people"][:4]]
            add("pre-season-districts", "Start with the districts where most people live on land that has flooded", f"{', '.join(top)}. About {plan['people']['once'] / 1e6:.0f} million people nationwide live on land mapped as flooded at least once since 2010.",
                "NDMA, PDMAs, DDMAs", "plans reviewed by April", "Flood season closed; districts ranked by people on land that has flooded", "15 June")
    full = [r for r in res if r["range_pct"] is not None and r["range_pct"] >= 95]
    if full:
        add(f"dam-{full[0]['name'].lower()}", f"{full[0]['name']} is nearly full: agree release plans", "Little room is left to hold back a flood. Share release times with downstream districts.", "WAPDA, IRSA, FFD, PDMAs", "now",
            f"{full[0]['name']} at {full[0]['range_pct']}% of its range (limit 95%)", "level below 95% of the range")
    if any(i["kind"] == "stale" for i in issues):
        add("stale-forecast", "Refresh the global forecasts", "At least one assisting forecast is too old to use. Check the feed before relying on quiet maps.", "NCOP data team", "today", "An assisting forecast is past its limit", "the forecast is current again")
    return out[:6]


CALENDAR = [((6, 7, 8, 9), "June to September", "Monsoon river floods, flash floods, city flooding, glacier-lake floods", "FFD bulletins, river outlook, rain forecasts"),
            ((10, 11), "October to November", "Late monsoon tail; repairs", "Damage surveys, embankment repairs"),
            ((12, 1, 2), "December to February", "Low flow; western-weather rain and snow", "Snow build-up, reservoir levels, gauge repairs"),
            ((3, 4, 5), "March to May", "Snow-melt, hail and flash floods in the west and north; first glacier-lake risk", "Snow cover, temperature, hill torrents")]


# ------------------------------------------------------------------- build
def build(now=None):
    from . import flood_atlas, flood_glofas, flood_hydraulic, flood_suscept, iwmi_flood_client as iw
    now = now or datetime.now(timezone.utc)
    t0 = time.time()
    try:
        fs.refresh()
    except Exception as e:
        logger.warning("flood_ews: history not refreshed (%s)", e)
    store = fs.load()
    if store is None:
        raise RuntimeError("no FFD history store: run manage.py flood_watch_data --backfill")
    live, live_src = fs.live()
    sdoc = site.refresh()
    season = site.season(now.astimezone(fs.PKT).date())
    bul, adv = sdoc.get("bulletin"), sdoc.get("advisory")
    bage = site.bulletin_age_days(sdoc)
    eo = fe.load()
    mdl = fr.model(store, eo)
    cur = today_store(store, live)
    outlook = fr.forecast(cur, eo, mdl)

    def part(fn, default):
        try:
            return fn()
        except Exception as e:
            logger.warning("flood_ews: part failed (%s)", e)
            return default
    iwmi = part(lambda: iw.flood_watch("PAK"), {})
    feed = part(lambda: flood_glofas.newest(iwmi.get("glofas")), iwmi.get("glofas"))
    gl, fh = glofas_view(feed, now), floodhub_view(iwmi.get("floodhub"), now)
    stn_rain = part(lambda: station_rain(now), {"status": "not available", "stations": 0})
    rain = part(lambda: rain_outlook(now), None)
    cat = catchments(eo, now)
    glof, pmd = glof_status(now), pmd_rain_warnings()
    atlas = flood_atlas.load()
    hist = {sid: flow_history(cur, sid) for sid in fs.IDS}
    st = stations(live, outlook, mdl, bul, bage is not None and bage <= 1, adv or {}, site.advisory_in_force(adv), gl, fh, hist, now)
    ds = districts(st, rain, atlas, glof, now)
    plan = planning(atlas)
    bul_fresh = bage is not None and bage <= 1
    cata, sus = flood_hydraulic.load(), flood_suscept.load()
    hyd = part(lambda: flood_hydraulic.pick(cata, st), None)
    res = reservoirs(live, bul, sdoc.get("storage"), now, bul_fresh)
    issues = data_issues(store, live, gl, fh, glof, bage, cat, season, mdl, now)
    known = [s for s in st if s["state"] == "current"]
    lv = max([d["level"] for d in ds] + [s["watch"] for s in st] + [0])
    cnt = {k: sum(1 for d in ds if d["level"] == i) for i, k in enumerate(LEVELS)}
    tiers = {k: sum(1 for s in known if s["tier"] == i) for i, k in enumerate(fs.TIERS)}
    # Quiet only counts as quiet when most FFD stations have a current reading.
    known_enough = len(known) >= 0.6 * len(st)
    nat = {"level": lv, "label": LEVELS[lv] if lv or known_enough else "NOT KNOWN", "known": bool(lv or known_enough), "districts": cnt, "stations": {"total": len(st), "current": len(known), "no_limits": sum(1 for s in st if not s["limits"]), "tiers": tiers},
           "assist": {"glofas": gl["status"], "floodhub": fh["status"]}, "river_levels": {r: max([s["watch"] for s in st if s["river"] == r] or [0]) for r in fs.RIVERS}}
    doc = {"version": VERSION, "generated_at": now.isoformat(), "levels": LEVELS, "tiers": [fs.TIER_LABEL[t] for t in fs.TIERS], "season": season, "national": nat, "stations": st,
           "districts": [d for d in ds if d["level"]][:60], "reservoirs": res, "catchments": cat, "rain": None if not rain else {**{k: v for k, v in rain.items() if k != "rows"},
           "top": sorted(rain["rows"], key=lambda r: -r["max3"])[:12], "wet": sum(1 for r in rain["rows"] if r["level"]), "week_top": sorted(rain["rows"], key=lambda r: -(r["peak_mm"] or 0))[:8]},
           "glofas": {k: v for k, v in gl.items() if k != "points"}, "floodhub": {k: v for k, v in fh.items() if k != "gauges"}, "glof": glof, "pmd_rain": pmd,
           "ffd_status": sdoc.get("status"), "ffd_daily": sdoc.get("daily"), "station_rain": stn_rain, "glofas_feed": feed,
           "bulletin": None if not (bul and bul_fresh) else {**{k: bul.get(k) for k in ("number", "date", "time", "situation", "outlook", "week_rain", "week_flood", "rivers", "url", "note", "weather_outlook")},
                                             "age_days": bage, "season_peaks": {k: v["season_peak"] for k, v in bul["stations"].items()}},
           "advisory": {**adv, "in_force": True} if site.advisory_in_force(adv) else {"in_force": False, "checked": (adv or {}).get("read_at")} if adv else None,
           "storage": sdoc.get("storage") if (sdoc.get("storage") or {}).get("to", "") >= now.astimezone(fs.PKT).date().isoformat() else None, "inundation": iwmi.get("inundation"),
           "skill": skill_table(mdl), "events": replay(store, eo), "plan": plan, "issues": issues,
           "health": source_health(live_src, live, gl, fh, rain, cat, sdoc, glof, pmd, atlas, store, now, stn_rain, hyd, sus), "matrix": MATRIX,
           "reliability": reliability(mdl), "hydraulic": hyd, "susceptibility": None if not sus else {k: sus[k] for k in ("built", "bbox", "classes", "colors", "shares", "auc", "auc_mean", "flooded_share", "captured", "weights", "top")},
           "timing": ops.timing(now, {"reading": FRESH_H["ffd_season" if season["open"] else "ffd"], "glofas": FRESH_H["glofas"], "floodhub": FRESH_H["floodhub"], "gefs": FRESH_H["gefs"] + 24, "nwp": FRESH_H["nwp"]}, live, sdoc, gl,
                                (iwmi.get("floodhub") or {}).get("issued_time"), iwmi.get("generated_at"), (rain or {}).get("init"), (rain or {}).get("received"), eo, outlook),
           "register": ops.register(), "briefs": part(lambda: ops.briefs(st, ds, rain, atlas, sus, hyd, REACH, TORRENT, CITY, set(GLOF_DISTRICTS)), []),
           "calendar": [{"window": w, "risk": r, "watch": x, "now": now.month in m} for m, w, r, x in CALENDAR], "rain_cuts": RAIN_CUTS, "fresh_h": FRESH_H}
    doc["actions"] = actions(nat, st, ds, res, glof, season, plan, rain, issues)
    doc["closed_actions"] = part(lambda: ops.track(doc["actions"], now), [])
    doc["issue"] = log_issue(doc)
    archive_run(doc, outlook, now)
    doc["build_seconds"] = round(time.time() - t0, 1)
    _atomic(_path(), doc)
    with _lock:
        _state.update(doc=doc, loaded_at=time.time())
    return doc


def reliability(mdl):
    """All stations where the outlook is used, pooled: of the cases given about x%, how many reached the Low-flood limit."""
    out = []
    for h in fr.LEADS:
        ps = [m["prob"] for k, m in mdl["models"].items() if k.endswith(f":{h}") and m.get("usable") and m.get("prob")]
        if not ps:
            continue
        n = sum(p["n"] for p in ps)
        bins = np.sum([p["bins"] for p in ps], axis=0)
        mean = lambda k: sum(p[k] * p["n"] for p in ps) / n
        out.append({"lead": h, "stations": len(ps), "n": n, "floods": sum(p["floods"] for p in ps), "brier": round(mean("brier"), 4), "brier_usual": round(mean("brier_usual"), 4), "brier_same": round(mean("brier_same"), 4),
                    "bins": [{"from": fr.REL_EDGES[i], "to": min(fr.REL_EDGES[i + 1], 1.0), "n": int(b[0]), "said": round(float(b[1] / b[0]), 3) if b[0] else None, "seen": round(float(b[2] / b[0]), 3) if b[0] else None} for i, b in enumerate(bins)]})
    return out


def skill_table(mdl):
    out = []
    for sid in fr.TARGETS:
        r = {"id": sid, "name": fs.STATIONS[sid][0], "river": fs.STATIONS[sid][1], "leads": []}
        for h in fr.LEADS:
            m = mdl["models"].get(f"{sid}:{h}") or {}
            s = m.get("skill") or {}
            r["leads"].append({"lead": h, "usable": bool(m.get("usable")), "warn": warn_ready(s), "why": m.get("why"), **{k: s.get(k) for k in ("days", "nse", "nse_same", "kge", "mae", "mae_same", "rmse")},
                               "flood": s.get("flood"), "prob": {k: v for k, v in (m.get("prob") or {}).items() if k != "bins"} or None})
        out.append(r)
    return out


EVENTS = [("2022 floods, lower Indus", "sukkur", 2022), ("2022 floods, Kotri", "kotri", 2022), ("2023 Sutlej flood", "islam", 2023),
          ("2025 floods, Chenab at Qadirabad", "qadirabad", 2025), ("2025 floods, Trimmu", "trimmu", 2025), ("2025 floods, Panjnad", "panjnad", 2025), ("2025 floods, Guddu", "guddu", 2025)]


def replay(store, eo):
    """Past floods: what the outlook (trained without that season) said 1-3 days before the peak. Cached per month."""
    path = os.path.join(fs.root(), "replay.json")
    key = f"{fr.VERSION}|{date.today().strftime('%Y-%m')}|{'eo' if eo is not None else 'no'}"
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if d["key"] == key:
            return d["rows"]
    except (OSError, ValueError, KeyError):
        pass
    arr, lev = fr.series(store)
    n = arr.shape[1]
    yr, mo = fr._calendar(n)
    t = np.arange(n, dtype=float)
    rows = []
    for label, sid, year in EVENTS:
        s = fs.IDS.index(sid)
        w = np.flatnonzero((yr == year) & (mo >= 6) & (mo <= 10) & np.isfinite(arr[s]))
        if not w.size:
            continue
        pk = int(w[np.argmax(arr[s][w])])
        row = {"label": label, "station": fs.STATIONS[sid][0], "date": fs.index_day(pk).isoformat(), "peak": round(float(arr[s][pk])), "tier": fs.tier(sid, float(arr[s][pk])), "said": []}
        for h in fr.LEADS:
            X = fr.features(sid, h, arr, lev, eo, t)
            Y = np.full(n, np.nan)
            Y[:n - h] = arr[s][h:]
            ok = np.isfinite(X).all(1) & np.isfinite(Y) & (mo >= 6) & (mo <= 10) & (yr != year)
            x = X[pk - h]
            if ok.sum() < 200 or not np.isfinite(x).all():
                row["said"].append({"lead": h, "q": None})
                continue
            q = max(float(x[1] + x @ fr._solve(X[ok], Y[ok] - X[ok][:, 1])), 0)
            row["said"].append({"lead": h, "q": round(q), "tier": fs.tier(sid, q), "then": round(float(x[1]))})
        rows.append(row)
    _atomic(path, {"key": key, "rows": rows})
    return rows


# ------------------------------------------------- snapshots and run archive
def _atomic(path, doc):
    tmp = f"{path}.{uuid.uuid4().hex[:6]}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        logger.warning("flood_ews: %s not written", path, exc_info=True)


def archive_run(doc, outlook, now):
    """One line per forecast origin, never overwritten: what was forecast, when, with which data."""
    line = {"made": now.isoformat(), "version": fr.VERSION, "level": doc["national"]["level"],
            "q": {sid: [o.get("from"), o.get("now"), [[x["lead"], x.get("q"), x.get("lo"), x.get("hi")] for x in o.get("leads", []) if x.get("status") == "ok"]] for sid, o in outlook.items() if o.get("leads")}}
    path = os.path.join(fs.root(), f"runs-{now:%Y%m}.jsonl")
    origin = json.dumps({k: v[0] for k, v in line["q"].items()}, sort_keys=True)
    mark = os.path.join(fs.root(), "runs-last.txt")
    try:
        with open(mark, encoding="utf-8") as f:
            if f.read() == origin:
                return
    except OSError:
        pass
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, separators=(",", ":")) + "\n")
        with open(mark, "w", encoding="utf-8") as f:
            f.write(origin)
    except OSError:
        logger.warning("flood_ews: run not archived", exc_info=True)


def log_issue(doc):
    path = os.path.join(fs.root(), "issues.json")
    try:
        with open(path, encoding="utf-8") as f:
            log = json.load(f)
    except (OSError, ValueError):
        log = []
    key = {"day": doc["generated_at"][:10], "level": doc["national"]["level"], "tiers": doc["national"]["stations"]["tiers"],
           "q": {s["id"]: s["q"] for s in doc["stations"]}, "districts": {d["name"]: d["level"] for d in doc["districts"]}}
    sig = hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:12]
    last = log[-1] if log else None
    if not last or last["key"]["day"] != key["day"]:
        log.append({"issue": (last["issue"] + 1) if last else 1, "at": doc["generated_at"], "sig": sig, "key": key, "revisions": 0})
    elif last["sig"] != sig:
        last.update(sig=sig, key=key, revisions=last["revisions"] + 1)
    _atomic(path, log[-60:])
    cur, prev = log[-1], (log[-2] if len(log) > 1 else None)
    ch = None
    if prev:
        a, b = prev["key"], cur["key"]
        moved = [(n, b["q"].get(n), a["q"].get(n)) for n in b["q"] if b["q"].get(n) and a["q"].get(n)]
        up = sorted([(n, q / p - 1) for n, q, p in moved if p > 2000 and q / p > 1.25], key=lambda x: -x[1])[:4]
        dn = sorted([(n, q / p - 1) for n, q, p in moved if p > 2000 and q / p < 0.75], key=lambda x: x[1])[:4]
        ch = {"since": prev["at"], "level_before": a["level"], "up": [[fs.STATIONS[n][0], round(100 * r)] for n, r in up], "down": [[fs.STATIONS[n][0], round(100 * r)] for n, r in dn],
              "new_districts": [n for n, v in b["districts"].items() if v > a["districts"].get(n, 0)][:8]}
    return {"number": cur["issue"], "id": cur["sig"], "revisions": cur["revisions"], "changes": ch}


# ------------------------------------------------------------ cache and view
_lock = threading.Lock()
_state = {"doc": None, "loaded_at": 0.0, "thread": None, "eo": None}


class FloodBuilding(Exception):
    pass


def _path():
    return os.path.join(fs.root(), "watch.json")


def _eo_async():
    """Refresh rain and soil data when older than 12 h; at most one run at a time."""
    eo = fe.load()
    age = _age_h(eo["updated"], datetime.now(timezone.utc)) if eo is not None else None
    if eo is None or (age is not None and age < EO_MAX_AGE_H):
        return
    with _lock:
        t = _state["eo"]
        if t and t.is_alive():
            return
        t = threading.Thread(target=lambda: _safe(fe.refresh), name="flood-eo", daemon=True)
        _state["eo"] = t
    t.start()


def _safe(fn):
    try:
        fn()
    except Exception:
        logger.warning("flood_ews: background job failed", exc_info=True)


def _build_async():
    with _lock:
        t = _state["thread"]
        if t and t.is_alive():
            return
        t = threading.Thread(target=lambda: _safe(build), name="flood-ews", daemon=True)
        _state["thread"] = t
    t.start()
    _safe(_eo_async)


def watch():
    """Cached document; stale-while-revalidate. FloodBuilding if none exists yet."""
    with _lock:
        doc, at = _state["doc"], _state["loaded_at"]
    if doc is None:
        try:
            at = os.path.getmtime(_path())
            with open(_path(), encoding="utf-8") as f:
                doc = json.load(f)
            with _lock:
                _state.update(doc=doc, loaded_at=at)
        except (OSError, ValueError):
            doc = None
    if doc is None:
        _build_async()
        raise FloodBuilding()
    if time.time() - at > (TTL_S if (doc.get("season") or {}).get("open") else TTL_OFF_S):
        _build_async()
    t = _state["thread"]
    return {**doc, "age_s": round(time.time() - at), "refreshing": bool(t and t.is_alive())}


from django.http import JsonResponse  # noqa: E402
from rest_framework.throttling import AnonRateThrottle  # noqa: E402
from rest_framework.views import APIView  # noqa: E402


class FloodEwsThrottle(AnonRateThrottle):
    scope = "gefs_api"


class FloodEwsView(APIView):
    """GET /api/flood/watch/ - 202 while the first document builds."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [FloodEwsThrottle]

    def get(self, request):
        try:
            doc = watch()
        except FloodBuilding:
            r = JsonResponse({"status": "building", "retry_after": 8}, status=202)
            r["Retry-After"] = "8"
            r["Cache-Control"] = "no-store"
            return r
        except Exception:
            logger.exception("flood_ews: watch failed")
            return JsonResponse({"error": "data unavailable"}, status=503)
        r = JsonResponse(doc, json_dumps_params={"ensure_ascii": False, "separators": (",", ":")})
        r["Cache-Control"] = "public, max-age=300"
        return r


class FloodMapView(APIView):
    """GET /api/flood/watch/map/<name>.png - a ready-made picture (susceptibility, or one simulated flood wave)."""
    authentication_classes = []
    permission_classes = []
    throttle_classes = [FloodEwsThrottle]

    def get(self, request, name):
        from django.http import FileResponse

        from . import flood_hydraulic as fh_, flood_suscept
        path = None
        if name == "susceptibility":
            path = flood_suscept._png_path()
        else:
            sid, _, sc = name.partition("-")
            if sid in fh_.REACHES and sc in fh_.SCENARIOS:                 # nothing from the request reaches the file system
                path = os.path.join(fh_.directory(), f"{sid}-{sc}.png")
        try:
            r = FileResponse(open(path, "rb"), content_type="image/png")
        except (OSError, TypeError):
            return JsonResponse({"error": "no such map"}, status=404)
        r["Cache-Control"] = "public, max-age=86400"
        return r


__all__ = ["build", "watch", "timedelta"]
