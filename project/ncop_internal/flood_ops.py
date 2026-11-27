# project/ncop_internal/flood_ops.py
# ---------------------------------------------------------------------------
# Operations part of the National Flood Watch:
#   register   every data source: owner, licence, access, delay, how often,
#              how fine, and what it cannot do
#   timing     when each forecast was made, received by NCOP, and when it is
#              too old
#   tracker    every action has the rule that opens and closes it and a status.
#              Opening and closing is automatic; "in progress" and "done" are
#              only ever what someone reported:
#                manage.py flood_watch_data --action ID --status done --by "PDMA Punjab" --note "..."
#   briefs     one page per district, from the same document as the report
# Pure functions plus one small JSON file (media/floodwatch/actions.json).
# ---------------------------------------------------------------------------

import json
import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone

from . import flood_store as fs

logger = logging.getLogger(__name__)

# name: owner, licence, how NCOP gets it, delay, how often, detail, main limits. Reviewed 24 Nov 2026 (REVIEWED).
REVIEWED = "2026-11-24"
REGISTER = [
    ("FFD river readings and reservoir levels", "Pakistan Meteorological Department (FFD)", "Government of Pakistan; no open licence stated", "NCOP's own FFD feed; FFD's public river status as reserve", "Hours", "Daily at 06:00, oftener in floods", "25 stations", "Readings by staff; no flow between stations; four upper stations have no flood limits"),
    ("FFD flood limits and record peaks", "Pakistan Meteorological Department (FFD)", "Government of Pakistan; no open licence stated", "Public pages, copied once", "None", "When FFD changes them", "21 stations", "Copied 24 November 2026; check every season"),
    ("FFD daily flood report, advisories, inflow outlook, bulletin", "Pakistan Meteorological Department (FFD)", "All rights reserved by FFD", "Public pages", "Minutes to hours", "Daily; bulletin 15 June to 15 October; inflow outlook every 10 days", "Rivers and stations", "Text can change layout; telemetry service is protected and not used"),
    ("FFD reading history", "Pakistan Meteorological Department (FFD), held by NCOP", "Government of Pakistan", "NCOP history service", "1 day", "Daily", "25 stations, since December 2015", "Gaps; a few wrong values, which are held back"),
    ("GloFAS v4 river forecast", "Copernicus Emergency Management Service (ECMWF, JRC)", "Copernicus, free with credit; Open-Meteo copy CC BY 4.0", "Open-Meteo and IWMI services", "About 1 day", "Daily", "About 5 km; 51 forecasts, 15 days; 13 usable points", "Does not know dams, barrages or canals; some points sit on the wrong cell and are left out"),
    ("Google Flood Hub", "Google Research", "CC BY 4.0 through IWMI", "IWMI service", "Hours", "Daily", "Gauges, 7 days", "Few gauges in Pakistan checked against real measurements; flood maps only during floods"),
    ("GEFS v12 district rain", "NOAA (USA)", "Open data", "NOAA cloud archive, processed by NCOP", "About 6 hours", "Daily run used", "About 25 to 50 km, district means and highs", "Misses small storms; corrected with NASA POWER, which is itself smooth"),
    ("GFS catchment rain", "NOAA (USA)", "Open data", "Google Earth Engine", "About 5 hours", "Every 6 hours", "About 28 km", "Mountain rain is uncertain; compared with ECMWF"),
    ("ECMWF open forecast", "ECMWF (Europe)", "CC BY 4.0", "Google Earth Engine", "About 8 hours", "Every 12 hours", "About 28 km", "Same limits as GFS"),
    ("GPM IMERG rain", "NASA (USA), JAXA (Japan)", "Open data", "Google Earth Engine", "About 28 hours on this route", "Every half hour", "About 10 km", "Weak on snow and in narrow valleys"),
    ("SMAP root-zone wetness", "NASA (USA)", "Open data", "Google Earth Engine", "2 to 3 days", "Every 3 hours", "About 9 km", "Model fed by satellite; weak under snow and dense crops"),
    ("MODIS snow cover", "NASA (USA)", "Open data", "Google Earth Engine", "1 to 7 days (cloud)", "Daily", "500 m", "Shows where snow lies, not how much water it holds"),
    ("PMD station rain and warnings, glacier-lake stations", "Pakistan Meteorological Department", "Government of Pakistan", "PMD services inside NCOP", "Minutes to hours", "3-hourly to daily", "Stations", "Few stations in Balochistan and the mountains; glacier-lake stations can be offline"),
    ("Flood-extent layers 2010 to 2025", "SUPARCO, NDMA GIS", "NCOP", "NCOP map server", "None", "After each flood", "10 to 250 m, by satellite", "Different satellites and dates; can mistake wet fields for floods; 2016 to 2021 and 2024 missing"),
    ("Population (GHSL 2025, census 2023)", "European Commission JRC; Pakistan Bureau of Statistics", "CC BY 4.0", "Google Earth Engine; published totals", "None", "Every few years", "100 m", "Modelled between censuses; night-time homes, not people on the move"),
    ("Schools, health posts, bridges, settlements", "NCOP", "NCOP", "NCOP map server", "None", "Irregular", "Points", "Some are missing or misplaced"),
    ("JRC flood hazard maps", "European Commission JRC", "CC BY 4.0", "Google Earth Engine", "None", "Fixed", "About 90 m", "No embankments: outer limit only"),
    ("FABDEM terrain", "University of Bristol (from Copernicus DEM)", "CC BY-NC-SA 4.0: not for commercial use", "Google Earth Engine", "None", "Fixed", "30 m, used at 500 m", "Embankments too narrow to appear; river bed below water not measured"),
    ("MERIT Hydro, CHIRPS v3, MODIS land cover, JRC surface water", "University of Tokyo; UC Santa Barbara; NASA; JRC", "CC BY-NC 4.0 or ODbL; open; open; open", "Google Earth Engine", "None", "Fixed or yearly", "90 m to 5 km", "Used for the susceptibility map only, at 500 m"),
]


def register():
    keys = ("name", "owner", "licence", "access", "delay", "frequency", "detail", "limits")
    return {"reviewed": REVIEWED, "rows": [dict(zip(keys, r)) for r in REGISTER]}


# ------------------------------------------------------------------- timing
def _t(x):
    try:
        d = datetime.fromisoformat(str(x).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def timing(now, limits_h, live, sdoc, gl, fh_made, fh_got, gefs_made, gefs_got, eo, outlook):
    """[{name, made, received, horizon, expires, state}], newest knowledge of every forecast in the report."""
    out = []

    def row(name, made, got, hours, until=None, fixed_expiry=None):
        m, g = _t(made), _t(got)
        e = fixed_expiry or (m + timedelta(hours=hours) if m and hours else None)
        out.append({"name": name, "made": m and m.isoformat(), "received": g and g.isoformat(), "covers_to": until, "expires": e and e.isoformat(),
                    "state": "missing" if m is None else "too old" if e and e < now else "valid"})
    newest = max([r["time"] for r in live.values() if r.get("time")] or [None], key=lambda x: x or "")
    d = _t(newest)
    row("FFD river readings", newest, now.isoformat(), limits_h["reading"])
    o = next((x for x in outlook.values() if any(v.get("status") == "ok" for v in x.get("leads", []))), None)
    row("NCOP river outlook (from the reading above)", newest, now.isoformat(), limits_h["reading"], max([v["date"] for x in outlook.values() for v in x.get("leads", []) if v.get("status") == "ok"] or [None], key=lambda x: x or "") if o else None)
    st = sdoc.get("storage") or {}
    if st.get("to"):
        end = datetime.combine(date.fromisoformat(st["to"]) + timedelta(days=1), datetime.min.time(), fs.PKT)
        row("FFD reservoir inflow outlook", st.get("updated"), st.get("read_at"), None, st["to"], end)
    b = sdoc.get("bulletin") or {}
    if b.get("date") and (now.astimezone(fs.PKT).date() - date.fromisoformat(b["date"])).days <= 1:
        row("FFD daily bulletin", b["date"], b.get("read_at"), 48)
    row("GloFAS river forecast", gl.get("run"), gl.get("received"), limits_h["glofas"], gl.get("to"))
    row("Google Flood Hub", fh_made, fh_got, limits_h["floodhub"], (_t(fh_made) + timedelta(days=7)).date().isoformat() if _t(fh_made) else None)
    row("GEFS district rain (NCOP)", gefs_made, gefs_got, limits_h["gefs"])
    if eo is not None:
        for name, k, days in (("GFS catchment rain", "gfs_run", 7), ("ECMWF catchment rain", "ifs_run", 7)):
            r = _t(eo.get(k))
            row(name, eo.get(k) or None, eo.get("updated"), limits_h["nwp"], (r + timedelta(days=days)).date().isoformat() if r else None)
    return out


# ------------------------------------------------------------------ tracker
STATUSES = ("open", "in progress", "done")


def _path():
    return os.path.join(fs.root(), "actions.json")


def _load():
    try:
        with open(_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"open": {}, "closed": []}


def _save(doc):
    tmp = _path() + f".{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, _path())


def track(actions, now):
    """Open new actions, close those whose trigger has ended, keep what people reported. Returns the closed list (last 8)."""
    doc = _load()
    ids = {a["id"] for a in actions}
    day = now.isoformat()
    for k in [k for k in doc["open"] if k not in ids]:
        e = doc["open"].pop(k)
        doc["closed"].append({**e, "id": k, "closed": day, "how": "trigger ended"})
    for a in actions:
        e = doc["open"].setdefault(a["id"], {"opened": day, "title": a["title"], "status": "open", "by": None, "note": None, "at": None})
        e["title"] = a["title"]
        a.update(status=e["status"], opened=e["opened"], by_whom=e["by"], note=e["note"], reported=e["at"])
    doc["closed"] = doc["closed"][-40:]
    try:
        _save(doc)
    except OSError:
        logger.warning("flood_ops: action log not written", exc_info=True)
    return [{k: c.get(k) for k in ("id", "title", "opened", "closed", "status", "by")} for c in doc["closed"][-8:]][::-1]


def report_status(action_id, status, by, note=None, now=None):
    """Record what an organisation reported about an open action."""
    if status not in STATUSES:
        raise ValueError(f"status must be one of {', '.join(STATUSES)}")
    if not by:
        raise ValueError("say who reported it")
    doc = _load()
    if action_id not in doc["open"]:
        raise KeyError(f"no open action {action_id}; open now: {', '.join(doc['open']) or 'none'}")
    doc["open"][action_id].update(status=status, by=str(by)[:80], note=str(note)[:200] if note else None, at=(now or datetime.now(timezone.utc)).isoformat())
    _save(doc)
    return doc["open"][action_id]


# ------------------------------------------------------------------- briefs
def readiness(kinds, level):
    """Plain checklist for a district, by the dangers it has. Timing follows the report's action matrix."""
    out = [("Before the season", "Walk the embankments, spurs and gauges; repair; write down the weak points."),
           ("Before the season", "Agree evacuation routes, shelters and boats for the people counted above; rehearse once.")]
    if "torrent" in kinds:
        out.append(("Before the season", "Clear hill-torrent crossings and culverts; put a watcher upstream with a phone or radio."))
    if "city" in kinds:
        out.append(("Before the season", "Clean drains and nullahs; test pumps; mark underpasses that fill."))
    if "glof" in kinds:
        out.append(("By May", "Check sirens and lake watchers; agree the climb-out paths with each village."))
    out += [("At Elevated", "Read the stations above you twice a day; warn teams; check fuel, boats, medicines."),
            ("At Alert", "Move stocks and boats; check weak points; tell people with poor mobility and hospitals first."),
            ("At Warning", "Warn people through the authorised channels; open shelters; move animals; close unsafe bridges and roads."),
            ("At Severe", "Evacuate and rescue as authorised; report numbers every day; do not return people until FFD says the flood has passed.")]
    return [{"when": a, "do": b} for a, b in out]


def briefs(stations, districts, rain, atlas, sus, hyd, reach, torrent, city, glof_d, n=8):
    """One page of facts per district: every raised district first, then those with most people on land that has flooded."""
    if not atlas:
        return []
    ex = {r["name"]: r for r in atlas["districts"]}
    years = atlas["observed_years"]
    lv = {d["name"]: d for d in districts if d["level"]}
    order = sorted((x for x in lv if x in ex), key=lambda x: (-lv[x]["level"], -ex[x]["once"]["people"]))[:n]
    order += [r["name"] for r in sorted(ex.values(), key=lambda r: -r["once"]["people"]) if r["name"] not in order][:max(0, n - len(order))]
    by = {s["id"]: s for s in stations}
    rr = {r["name"]: r for r in (rain or {}).get("rows", [])}
    sus_by = {r["name"]: r for r in (sus or {}).get("districts", [])}
    out = []
    for name in order:
        e = ex[name]
        rivers = []
        for sid, ds in reach.items():
            s = by.get(sid)
            if name not in ds or not s:
                continue
            rivers.append({"station": s["name"], "river": s["river"], "state": s["state"], "q": s["q"], "tier": s["tier"], "low": (s["limits"] or {}).get("low"), "of_low": s["of_low"],
                           "up": [[fs.STATIONS[u][0], h] for u, h in s.get("up", [])]})
        waves = []
        for sid, r in ((hyd or {}).get("reaches") or {}).items():
            sc = r["scenarios"].get("very_high")
            hit = next((x for x in (sc or {}).get("districts", []) if x["name"] == name), None)
            if hit:
                waves.append({"station": r["station"], "river": r["river"], "flow": sc["flow"], "trust": (r.get("trust") or {}).get("grade"), **{k: hit[k] for k in ("people", "people_upper", "first_h", "half_h", "depth_m", "deep_people")}})
        waves.sort(key=lambda w: -w["people"])
        kinds = (["river"] if rivers or waves else []) + (["torrent"] if name in torrent else []) + (["city"] if name in city else []) + (["glof"] if name in glof_d else [])
        seen = sorted(((y, (e.get("seen", {}).get(y) or {}).get("people", 0), (e.get("seen", {}).get(y) or {}).get("km2", 0)) for y in years), key=lambda x: -x[1])
        r = rr.get(name)
        out.append({"name": name, "province": e["province"], "level": lv[name]["level"] if name in lv else 0, "hazards": lv[name]["hazards"][:3] if name in lv else [], "kinds": kinds,
                    "people": e["people"], "once": e["once"]["people"], "often": e["often"]["people"], "crop_km2": e["once"]["crop_km2"], "places": e.get("places"),
                    "worst": [{"year": y, "people": p, "km2": k} for y, p, k in seen[:3] if k >= 25], "rivers": rivers[:4], "waves": waves[:3],
                    "sus": sus_by.get(name), "rain": None if not r else {"max3": r["max3"], "sum7": r["sum7"]}, "ready": readiness(kinds, lv[name]["level"] if name in lv else 0)})
    return out
