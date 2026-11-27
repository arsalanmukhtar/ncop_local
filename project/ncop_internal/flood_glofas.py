# project/ncop_internal/flood_glofas.py
# ---------------------------------------------------------------------------
# The newest GloFAS forecast for NCOP's Pakistan points.
#
# IWMI's copy of GloFAS can lag several days. Open-Meteo serves the same
# GloFAS v4 runs daily (50 members, CC BY 4.0), so the newer of the two is
# used. Points, warning levels and the status rule stay IWMI's: status = the
# worst level that at least 30% of members reach.
#
# Open-Meteo answers with the nearest model cell, which can be a neighbour of
# the river cell. Each point's cell is therefore found once by comparing the
# nine cells around it with IWMI's own series for the same days; only a match
# within 5% is accepted (checked 24 Nov 2026: 13 of 13 within 1%).
#
# Cached in media/floodwatch/glofas_feed.json; the forecast is read again only
# when a new run is announced.
# ---------------------------------------------------------------------------

import json
import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone

import numpy as np
import requests

from . import flood_store as fs

logger = logging.getLogger(__name__)

API = "https://flood-api.open-meteo.com/v1/flood"
META = "https://flood-api.open-meteo.com/data/glofas_forecast_v4/static/meta.json"
ATTRIBUTION = "GloFAS v4 (Copernicus) via Open-Meteo, CC BY 4.0; points and warning levels via IWMI"
ORDER = ["normal", "warning", "danger", "extreme"]
CUTOFF, MATCH_ERR, STEP = 0.3, 0.05, 0.05
LEADS = 15


def _file(name):
    return os.path.join(fs.root(), name)


def _read(name):
    try:
        with open(_file(name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(name, doc):
    tmp = _file(name) + f".{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, _file(name))


def _get(url, params=None):
    r = requests.get(url, params=params, timeout=60, headers=fs.UA)
    r.raise_for_status()
    return r.json()


def match_cell(point, lead_dates, candidates):
    """(lat, lon, error) of the candidate cell whose series equals IWMI's for the same days, or None."""
    best = None
    for c in candidates:
        m = dict(zip(c["daily"]["time"], c["daily"]["river_discharge"]))
        pairs = [(m.get(lead_dates.get(str(k))), point["q"][k - 1]) for k in range(1, 11) if k - 1 < len(point["q"])]
        pairs = [(a, b) for a, b in pairs if a is not None and b is not None]
        if len(pairs) < 4 or sum(b for _, b in pairs) <= 0:
            continue
        err = sum(abs(a - b) for a, b in pairs) / sum(b for _, b in pairs)
        if best is None or err < best[2]:
            best = (c["latitude"], c["longitude"], err)
    return best if best and best[2] <= MATCH_ERR else None


def _cells(iwmi):
    """{point id: [lat, lon]}; unknown points are looked up at most once a day."""
    doc = _read("glofas_cells.json") or {"cells": {}, "tried": ""}
    today = date.today().isoformat()
    todo = [p for p in iwmi["points"] if p.get("quality") != "unreliable" and str(p["id"]) not in doc["cells"]]
    if todo and doc["tried"] != today:
        la, lo = [], []
        for p in todo:
            for dy in (-STEP, 0, STEP):
                for dx in (-STEP, 0, STEP):
                    la.append(round(p["lat"] + dy, 4))
                    lo.append(round(p["lon"] + dx, 4))
        got = _get(API, {"latitude": ",".join(map(str, la)), "longitude": ",".join(map(str, lo)), "daily": "river_discharge",
                         "models": "forecast_v4", "past_days": 12, "forecast_days": 16})
        got = got if isinstance(got, list) else [got]
        for i, p in enumerate(todo):
            hit = match_cell(p, iwmi["lead_dates"], got[9 * i:9 * i + 9])
            if hit:
                doc["cells"][str(p["id"])] = [hit[0], hit[1], round(hit[2], 4)]
        doc["tried"] = today
        _write("glofas_cells.json", doc)
    return doc["cells"]


def build(iwmi, cells, replies, run):
    """IWMI's digest structure filled with the newer run. replies: one Open-Meteo ensemble answer per cell, in the order of `cells`."""
    run_d = date.fromisoformat(run[:10])
    lead_dates = {str(k): (run_d + timedelta(days=k)).isoformat() for k in range(1, LEADS + 1)}
    by = dict(zip(cells, replies))
    points, counts = [], {k: 0 for k in ORDER}
    day_counts = [{"lead": k, "date": lead_dates[str(k)], **{s: 0 for s in ORDER}} for k in range(1, LEADS + 1)]
    unreliable = 0
    for p in iwmi["points"]:
        base = {k: p.get(k) for k in ("id", "lon", "lat", "river", "site", "warning", "danger", "extreme")}
        r = by.get(str(p["id"]))
        if p.get("quality") == "unreliable":
            unreliable += 1
            points.append({**base, "quality": "unreliable", "status": "normal", "q": [], "s": [], "peak_prob": None, "peak_lead": None, "max_q": None, "max_lead": None, "headroom_ratio": None})
            continue
        if not r:
            points.append({**base, "quality": "ok", "status": "normal", "q": [], "s": [], "peak_prob": None, "peak_lead": None, "max_q": None, "max_lead": None, "headroom_ratio": None})
            continue
        dd = r["daily"]
        idx = {t: i for i, t in enumerate(dd["time"])}
        mem = np.array([[np.nan if v is None else v for v in dd[k]] for k in dd if k.startswith("river_discharge")], float)     # control + 50 members
        q, s, pw = [], [], []
        for k in range(1, LEADS + 1):
            i = idx.get(lead_dates[str(k)])
            col = mem[:, i] if i is not None else np.array([])
            col = col[np.isfinite(col)]
            if col.size < 20:
                q.append(None)
                s.append(None)
                pw.append(None)
                continue
            q.append(round(float(col.mean()), 1))
            lv = "normal"
            for name in ("warning", "danger", "extreme"):
                if p.get(name) and (col >= p[name]).mean() >= CUTOFF:
                    lv = name
            s.append(lv)
            pw.append(round(float((col >= p["warning"]).mean()), 2) if p.get("warning") else None)
            day_counts[k - 1][lv] += 1
        fin = [(v, k + 1) for k, v in enumerate(q) if v is not None]
        mq = max(fin) if fin else (None, None)
        pk = max([(v, k + 1) for k, v in enumerate(pw) if v is not None] or [(None, None)], key=lambda x: x[0] or 0)
        st = max([x for x in s if x] or ["normal"], key=ORDER.index)
        counts[st] += 1 if fin else 0
        points.append({**base, "quality": "ok", "status": st, "q": q, "s": s, "peak_prob": pk[0], "peak_lead": pk[1], "max_q": mq[0], "max_lead": mq[1],
                       "headroom_ratio": round(mq[0] / p["warning"], 3) if mq[0] is not None and p.get("warning") else None})
    points.sort(key=lambda x: (x["quality"] == "unreliable", -ORDER.index(x["status"]), -(x["headroom_ratio"] or 0)))
    return {"forecast_date": run[:10], "feed": "open-meteo", "prob_cutoff": CUTOFF, "leads": list(range(1, LEADS + 1)), "lead_dates": lead_dates, "points": points, "counts": counts,
            "unreliable": unreliable, "day_counts": day_counts, "missing_series": sum(1 for p in points if p["quality"] == "ok" and not p["q"]), "attribution": ATTRIBUTION}


def newest(iwmi):
    """The fresher of IWMI's GloFAS digest and the same model through Open-Meteo, with its age."""
    out = iwmi
    try:
        if iwmi:
            meta = _get(META)
            run = datetime.fromtimestamp(meta["last_run_initialisation_time"], timezone.utc).isoformat()
            if run[:10] > iwmi["forecast_date"]:
                kept = _read("glofas_feed.json")
                if kept and kept.get("forecast_date") == run[:10] and len(kept["points"]) == len(iwmi["points"]):
                    out = kept
                else:
                    cells = _cells(iwmi)
                    if cells:
                        ids = list(cells)
                        got = _get(API, {"latitude": ",".join(str(cells[i][0]) for i in ids), "longitude": ",".join(str(cells[i][1]) for i in ids),
                                         "daily": "river_discharge", "ensemble": "true", "models": "forecast_v4", "past_days": 3, "forecast_days": 16})
                        out = build(iwmi, ids, got if isinstance(got, list) else [got], run)
                        out["received_at"] = datetime.now(timezone.utc).isoformat()
                        _write("glofas_feed.json", out)
    except Exception as e:
        logger.warning("flood_glofas: newer run not read (%s); using IWMI's", e)
        kept = _read("glofas_feed.json")
        if kept and iwmi and kept["forecast_date"] > iwmi["forecast_date"]:
            out = kept
    if not out:
        return None
    age = (datetime.now(timezone.utc).date() - date.fromisoformat(out["forecast_date"])).days
    return {**out, "run_age_days": age, "run_stale": age > 3}

