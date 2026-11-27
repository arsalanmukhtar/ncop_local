# project/ncop_internal/flood_store.py
# ---------------------------------------------------------------------------
# FFD river readings for the National Flood Watch early-warning layer.
#
#   history   NCOP's FFD history service -> one compact file
#             (media/floodwatch/ffd_v1.npz, ~150 KB): for every station and
#             day the reading nearest 06:00 PKT and the day's highest, inflow
#             and outflow, 2015-12 ->. First fill reads everything once
#             (14 MB upstream); afterwards only the last days are read.
#   live      NCOP's FFD feed (get-ffd-waterlevels); if that is down, FFD's
#             public river-status summary.
#   limits    FFD's published flood limits and highest recorded peaks.
#
# Quality rules (a value that fails is held back, never turned into 0):
#   - above 1.10 x the highest flow FFD has ever recorded at the station;
#   - an isolated one-day jump (1.8 x both neighbouring days) when no
#     neighbouring station on the river reaches 65% of it within two days. Corroborated jumps are kept: the
#     August 2025 Chenab flood was exactly such a one-day jump, and real.
#   - missing stays missing. Zero is kept as zero: closed barrages report it.
# ---------------------------------------------------------------------------

import json
import logging
import os
import re
import threading
import uuid
from datetime import date, datetime, timedelta, timezone

import numpy as np
import requests
from django.conf import settings

logger = logging.getLogger(__name__)

HISTORY_URL = "http://172.18.7.35:8000/proxy_api_daily/api/history-all"
LIVE_URL = "http://172.18.7.21:8000/get-ffd-waterlevels/"
FFD_STATUS_URL = "https://ffd.pmd.gov.pk/home/river-status"
UA = {"User-Agent": "Mozilla/5.0 (compatible; open-data-client/1.0)"}
PKT = timezone(timedelta(hours=5))
DAY0 = date(2015, 12, 1)
LAC = 100_000
JUMP, CORROBORATE = 1.8, 0.65
# No neighbour can confirm a jump here: the dam below absorbs it, or hill torrents join just above
# (Rasul, 17 July 2025, was a real flash flood).
NO_NEIGHBOUR_CHECK = {"tarbela", "mangla", "rasul", "nowshera"}

# id: (name, river, history keys, live names, limits low/med/high/very high/exceptional in lacs, design lacs,
#      highest recorded peak cusecs, its year). Limits and peaks: ffd.pmd.gov.pk/flood-limits and /historical-peaks, read 24 Nov 2026.
STATIONS = {
    "skardu": ("Skardu", "Indus", ["SKARDU"], ["Skardu"], None, None, None, None),
    "partab": ("Partab Bridge", "Indus", ["PARTAB BRIDGE (BUNJI)"], ["Partab Bridge"], None, None, None, None),
    "besham": ("Besham", "Indus", ["BESHAM"], ["Besham"], None, None, None, None),
    "tarbela": ("Tarbela", "Indus", ["TARBELA"], ["Tarbela Dam"], (2.5, 3.75, 5, 6.5, 8), 15, 832_000, 2010),
    "nowshera": ("Nowshera", "Kabul", ["NOWSHERA"], ["Nowshera"], (0.6, 0.9, 1.4, 2, None), None, 391_300, 1990),
    "kalabagh": ("Kalabagh", "Indus", ["KALABAGH"], ["Kala Bagh"], (2.5, 3.75, 5, 6.5, 8), 9.5, 950_005, 1942),
    "chashma": ("Chashma", "Indus", ["CHASHMA"], ["Chashma"], (2.5, 3.75, 5, 6.5, 8), 9.5, 1_038_873, 2010),
    "taunsa": ("Taunsa", "Indus", ["TAUNSA"], ["Taunsa"], (2.5, 3.75, 5, 6.5, 8), 10, 959_991, 2010),
    "guddu": ("Guddu", "Indus", ["GUDDU"], ["Guddu"], (2, 3.5, 5, 7, 9), 12, 1_199_672, 1976),
    "sukkur": ("Sukkur", "Indus", ["SUKKUR"], ["Sukkur"], (2, 3.5, 5, 7, 9), 9, 1_166_574, 1986),
    "kotri": ("Kotri", "Indus", ["KOTRI"], ["Kotri"], (2, 3, 4.5, 6.5, 8), 8.75, 980_329, 1956),
    "mangla": ("Mangla", "Jhelum", ["MANGLA"], ["Mangla Dam"], (0.75, 1.1, 1.5, 2.25, 3), 10.6, 1_090_000, 1992),
    "rasul": ("Rasul", "Jhelum", ["RASUL"], ["New Rasul"], (0.75, 1.1, 1.5, 2.25, 3), 8.5, 952_170, 1992),
    "marala": ("Marala", "Chenab", ["MARALA"], ["Marala"], (1, 1.5, 2, 4, 6), 11, 1_100_000, 1957),
    "khanki": ("Khanki", "Chenab", ["KHANKI"], ["Khanki"], (1, 1.5, 2, 4, 6), 11, 1_086_410, 1959),
    "qadirabad": ("Qadirabad", "Chenab", ["QADIRABAD"], ["Qadirabad"], (1, 1.5, 2, 4, 6), 9, 1_077_952, 2025),
    "trimmu": ("Trimmu", "Chenab", ["TRIMMU"], ["Trimmu"], (1.5, 2, 3, 4.5, 6), 8.75, 944_333, 1928),
    "panjnad": ("Panjnad", "Chenab", ["PANJNAD"], ["Panjnad"], (1.5, 2.5, 4, 5.5, 7), 8.65, 802_516, 1973),
    "jassar": ("Jassar", "Ravi", ["JASSAR"], ["Jassar"], (0.5, 0.75, 1, 1.5, 2), 2.75, 680_000, 1955),
    "shahdara": ("Shahdara", "Ravi", ["SHAHDARA"], ["Shahdara"], (0.4, 0.65, 0.9, 1.35, 1.8), 2.5, 576_000, 1988),
    "balloki": ("Balloki", "Ravi", ["BALLOKI"], ["Balloki"], (0.4, 0.65, 0.9, 1.35, 1.8), 3.8, 389_845, 1988),
    "sidhnai": ("Sidhnai", "Ravi", ["SIDHNAI"], ["Sidhnai"], (0.3, 0.46, 0.6, 0.9, 1.3), 1.5, 330_210, 1988),
    "gswala": ("Ganda Singh Wala", "Sutlej", ["G.S WALA*", "GANDA SINGH WALA"], ["Ganda Singh Wala"], (0.5, 0.8, 1.2, 1.75, 2.25), None, 837_000, 1955),
    "sulemanki": ("Sulemanki", "Sutlej", ["SULEMANKI"], ["Sulemanki"], (0.5, 0.8, 1.2, 1.75, 2.25), 3.25, 598_872, 1955),
    "islam": ("Islam", "Sutlej", ["ISLAM"], ["Islam"], (0.5, 0.8, 1.2, 1.75, 2.25), 3, 492_581, 1955),
}
IDS = list(STATIONS)
RIVERS = ["Indus", "Kabul", "Jhelum", "Chenab", "Ravi", "Sutlej"]
TIERS = ["normal", "low", "medium", "high", "very_high", "exceptional"]
TIER_LABEL = {"normal": "Normal flow", "low": "Low flood", "medium": "Medium flood", "high": "High flood",
              "very_high": "Very high flood", "exceptional": "Exceptionally high flood"}
# downstream station -> [(upstream, travel hours)] as published in FFD's own feed ("from", "lag_hours");
# the three marked lines have no published time and use neighbouring FFD values.
UPSTREAM = {
    "kalabagh": [("nowshera", 20)],                      # marked
    "chashma": [("kalabagh", 12)], "taunsa": [("chashma", 58)],
    "guddu": [("taunsa", 84), ("panjnad", 52)], "sukkur": [("guddu", 32)], "kotri": [("sukkur", 173)],
    "rasul": [("mangla", 12)],                           # marked
    "khanki": [("marala", 9)], "qadirabad": [("khanki", 6)],   # marked (Qadirabad)
    "trimmu": [("qadirabad", 64), ("rasul", 64)], "panjnad": [("trimmu", 81), ("sidhnai", 63), ("islam", 74)],
    "shahdara": [("jassar", 22)], "balloki": [("shahdara", 19)], "sidhnai": [("balloki", 48)],
    "sulemanki": [("gswala", 53)], "islam": [("sulemanki", 60)],
}

_lock = threading.Lock()
_memo = {"mtime": None, "doc": None}


def limits(sid):
    """{tier: cusecs} for the five flood tiers (None where FFD publishes none)."""
    t = STATIONS[sid][4]
    return None if t is None else {k: (None if v is None else round(v * LAC)) for k, v in zip(TIERS[1:], t)}


def design(sid):
    d = STATIONS[sid][5]
    return None if d is None else round(d * LAC)


def tier(sid, q):
    """0 normal .. 5 exceptional by FFD limits; None without a value or limits."""
    lim = limits(sid)
    if q is None or lim is None or not np.isfinite(q):
        return None
    return max([0] + [i + 1 for i, k in enumerate(TIERS[1:]) if lim[k] is not None and q >= lim[k]])


# ------------------------------------------------------------------ history
def root():
    p = os.path.join(settings.MEDIA_ROOT, "floodwatch")
    os.makedirs(p, exist_ok=True)
    return p


def _path():
    return os.path.join(root(), "ffd_v1.npz")


def day_index(d):
    return (d - DAY0).days


def index_day(i):
    return DAY0 + timedelta(days=int(i))


def parse_time(x):
    """'24-Nov-2026 06:00 PKT' -> datetime (PKT); None if unreadable."""
    try:
        return datetime.strptime(str(x)[:17], "%d-%b-%Y %H:%M").replace(tzinfo=PKT)
    except ValueError:
        return None


def grid(stations, first, last):
    """{"in6","inmax","out6","outmax"}: [station, day] arrays from a history payload."""
    n = last - first + 1
    out = {k: np.full((len(IDS), n), np.nan, np.float32) for k in ("in6", "inmax", "out6", "outmax")}
    best = {k: np.full((len(IDS), n), 99.0) for k in ("in", "out")}
    for s, sid in enumerate(IDS):
        for key in STATIONS[sid][2]:
            rec = stations.get(key) or {}
            for kind, pre in (("inflow", "in"), ("outflow", "out")):
                for q in rec.get(kind) or []:
                    t, v = parse_time(q.get("x")), q.get("y")
                    if t is None or not isinstance(v, (int, float)) or v < 0:
                        continue
                    i = day_index(t.date()) - first
                    if not 0 <= i < n:
                        continue
                    gap = abs(t.hour + t.minute / 60 - 6)
                    if gap < best[pre][s, i]:
                        best[pre][s, i] = gap
                        out[f"{pre}6"][s, i] = v
                    m = out[f"{pre}max"][s, i]
                    out[f"{pre}max"][s, i] = v if np.isnan(m) else max(m, v)
    return out


def _neighbours(sid):
    up = [u for u, _ in UPSTREAM.get(sid, [])]
    return up + [d for d, us in UPSTREAM.items() if sid in [u for u, _ in us]]


def clean(raw):
    """Apply the quality rules; returns (clean copy, [(station, day index, value, reason)])."""
    a = {k: v.copy() for k, v in raw.items()}
    issues = []
    for k in a:
        for s, sid in enumerate(IDS):
            peak = STATIONS[sid][6]
            v = a[k][s]
            if peak:
                for i in np.flatnonzero(v > 1.10 * peak):
                    issues.append((sid, int(i), float(v[i]), "above the highest flow ever recorded"))
                    v[i] = np.nan
    for k in a:
        for s, sid in enumerate(IDS):
            v = a[k][s]
            if sid in NO_NEIGHBOUR_CHECK:
                continue
            floor = (limits(sid) or {}).get("low") or 1e9
            for i in range(1, v.size - 1):
                w = v[i - 1:i + 2]
                if not np.isfinite(w).all() or w[1] < floor or w[1] <= JUMP * max(w[0], w[2]):
                    continue
                near = []
                for o in _neighbours(sid):
                    j = IDS.index(o)
                    for kk in ("inmax", "outmax"):
                        z = raw[kk][j, max(0, i - 2):i + 3]
                        pk = STATIONS[o][6]
                        z = z[np.isfinite(z) & (z <= 1.10 * pk if pk else True)]
                        near += list(z)
                if not near or max(near) < CORROBORATE * w[1]:
                    issues.append((sid, int(i), float(w[1]), "isolated jump that no neighbouring station shows"))
                    v[i] = np.nan
    return a, issues


def load():
    """{"start": day index, "in6": .., ...} (cleaned) or None."""
    p = _path()
    if not os.path.exists(p):
        return None
    mt = os.path.getmtime(p)
    with _lock:
        if _memo["mtime"] == mt:
            return _memo["doc"]
    with np.load(p, allow_pickle=False) as z:
        if json.loads(str(z["ids"])) != IDS:
            return None
        doc = {"start": int(z["start"]), "updated": str(z["updated"]), "raw": {k: z[k] for k in ("in6", "inmax", "out6", "outmax")}}
    doc["clean"], doc["issues"] = clean(doc["raw"])
    with _lock:
        _memo.update(mtime=mt, doc=doc)
    return doc


def _save(start, raw):
    tmp = _path() + f".{uuid.uuid4().hex[:6]}.tmp.npz"
    np.savez_compressed(tmp, start=start, ids=json.dumps(IDS), updated=datetime.now(timezone.utc).isoformat(),
                        **{k: v.astype(np.float32) for k, v in raw.items()})
    os.replace(tmp, _path())


def refresh(full=False):
    """Fill once, then extend by re-reading the last few days."""
    cur = None if full else load()
    today = day_index(datetime.now(PKT).date())
    days = 4000 if cur is None else max(10, today - (cur["start"] + cur["raw"]["in6"].shape[1] - 1) + 5)
    r = requests.get(HISTORY_URL, params={"days": days}, timeout=240, headers=UA)
    r.raise_for_status()
    st = r.json().get("stations") or {}
    if len(st) < 15:
        raise ValueError(f"history service returned only {len(st)} stations")
    if cur is None:
        _save(0, grid(st, 0, today))
        return
    first = today - days + 2
    new = grid(st, first, today)
    raw = {}
    for k, old in cur["raw"].items():
        a = np.full((len(IDS), today - cur["start"] + 1), np.nan, np.float32)
        a[:, :old.shape[1]] = old[:, :a.shape[1]]
        w = new[k]
        lo = first - cur["start"]
        seg = a[:, lo:lo + w.shape[1]]
        seg[np.isfinite(w)] = w[np.isfinite(w)]
        raw[k] = a
    _save(cur["start"], raw)


# --------------------------------------------------------------------- live
def _num(v):
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d[\d,]*\.?\d*", str(v or ""))
    return float(m.group().replace(",", "")) if m else None


def parse_live_time(x, now=None):
    """'24-Nov 06 PKT' (no year) -> datetime."""
    now = now or datetime.now(PKT)
    m = re.match(r"\s*(\d{1,2})-([A-Za-z]{3})(?:-(\d{4}))?\s+(\d{1,2})(?::(\d{2}))?", str(x or ""))
    if not m:
        return None
    y = int(m.group(3) or now.year)
    try:
        t = datetime.strptime(f"{m.group(1)}-{m.group(2)}-{y} {int(m.group(4)):02d}:{m.group(5) or '00'}", "%d-%b-%Y %H:%M").replace(tzinfo=PKT)
    except ValueError:
        return None
    return t.replace(year=y - 1) if not m.group(3) and t > now + timedelta(days=2) else t


def live(now=None):
    """({station id: reading}, source) with inflow, outflow, level, trend, FFD status, time, coordinates."""
    now = now or datetime.now(PKT)
    by_name = {re.sub(r"\W", "", n).lower(): sid for sid, s in STATIONS.items() for n in s[3]}
    out = {}
    try:
        j = requests.get(LIVE_URL, timeout=30, headers=UA).json()
        for f in j.get("features", []):
            p = f.get("properties") or {}
            sid = by_name.get(re.sub(r"\W", "", str(p.get("name"))).lower())
            if not sid:
                continue
            g = p.get("gauges")
            try:
                g = json.loads(g) if isinstance(g, str) else (g or [])
            except ValueError:
                g = []
            gi = next((x for x in g if str(x.get("type", "")).upper().startswith("IN")), {})
            go = next((x for x in g if str(x.get("type", "")).upper().startswith("OUT")), {})
            t = parse_live_time(p.get("recording_time"), now)
            out[sid] = {"inflow": _num(gi.get("discharge")), "outflow": _num(go.get("discharge")) if go else _num(p.get("discharge")),
                        "trend": (gi or go).get("trend"), "level_ft": _num(p.get("level")), "ffd_status": p.get("status"),
                        "ffd_forecast": p.get("forecast_status") or p.get("forecast_qual"), "ffd_forecast_quant": p.get("forecast_quant"),
                        "time": t.isoformat() if t else None, "lon": f["geometry"]["coordinates"][0], "lat": f["geometry"]["coordinates"][1],
                        "peak_year": _num(p.get("cyp_discharge")), "peak_year_date": p.get("cyp_date")}
        if len(out) >= 15:
            return out, "NCOP FFD feed"
        raise ValueError(f"only {len(out)} stations")
    except Exception as e:
        logger.warning("flood_store: live feed failed (%s); using FFD public summary", e)
    j = requests.get(FFD_STATUS_URL, timeout=30, headers=UA).json()
    out = {}
    for name, p in (j.get("nodes") or {}).items():
        sid = by_name.get(re.sub(r"\W", "", name).lower())
        if sid:
            t = parse_live_time(p.get("time"), now)
            out[sid] = {"inflow": None, "outflow": _num(p.get("discharge")), "trend": {"up": "Rising", "down": "Falling", "right": "Steady"}.get(p.get("trend")),
                        "level_ft": _num(p.get("level")), "ffd_status": p.get("label"), "ffd_forecast": None, "ffd_forecast_quant": None,
                        "time": t.isoformat() if t else None, "lon": p.get("lon"), "lat": p.get("lat"), "peak_year": None, "peak_year_date": None}
    if not out:
        raise ValueError("no live FFD readings")
    return out, "FFD public river status"
