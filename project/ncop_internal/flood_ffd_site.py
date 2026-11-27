# project/ncop_internal/flood_ffd_site.py
# ---------------------------------------------------------------------------
# What the Flood Forecasting Division publishes openly on ffd.pmd.gov.pk, read
# at most every few hours and kept in media/floodwatch/ffd_site.json:
#
#   status     river status right now (all year): headline, stations by level
#   daily      FFD's daily flood report (all year, about 10:00): date, level line
#   bulletin   latest Daily Flood Bulletin: situation, outlook, official 24-h
#              forecast per station, reservoir levels and live storage,
#              season peaks, catchment rain
#   advisory   latest Flood Advisory (what, where, when, expected impacts)
#   storage    Tarbela / Mangla inflow volume forecast (MAF)
#   season     flood season 15 June - 15 October: open or closed
#
# Only open pages are read. FFD protects its river-state and Flood Watch data
# services with tokens ("anti-scraping"); those are not touched: NCOP has its
# own FFD feed for readings (flood_store). FFD's bulletins carry "all rights
# reserved": facts are quoted with attribution, texts are shown as short
# quotations, and a written data agreement with FFD is recommended.
# ---------------------------------------------------------------------------

import html
import json
import logging
import os
import re
import time
import uuid
from datetime import date, datetime, timedelta

import requests

from . import flood_store as fs

logger = logging.getLogger(__name__)

BASE = "https://ffd.pmd.gov.pk/"
PAGES = {"status": "home/river-status", "daily": "notifications", "bulletin": "bulletin/bulletin", "advisory": "bulletin/advisory", "storage": "maf-forecast"}
SEASONAL = {"bulletin"}                  # read off-season only once a day: nothing new appears
SEASON = ((6, 15), (10, 15))


def season(today=None):
    """FFD's flood season: daily bulletins from 15 June to 15 October."""
    d = today or datetime.now(fs.PKT).date()
    a, b = date(d.year, *SEASON[0]), date(d.year, *SEASON[1])
    opened = a <= d <= b
    nxt = a if d < a else date(d.year + 1, *SEASON[0])
    return {"open": opened, "from": a.isoformat(), "to": b.isoformat(), "next": nxt.isoformat(), "days_to_next": 0 if opened else (nxt - d).days}


def text_of(page):
    """Visible text, one line per row/paragraph, table cells separated by ' | '."""
    t = re.sub(r"<(script|style|svg|noscript)\b.*?</\1>", " ", page, flags=re.S | re.I)
    t = re.sub(r"</(tr|p|div|li|h\d|table)>|<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"</t[dh]>", " | ", t, flags=re.I)
    t = html.unescape(re.sub(r"<[^>]+>", " ", t))
    t = re.sub(r"[ \t\xa0‎‏]+", " ", t)
    return re.sub(r"\n\s*\n+", "\n", t)


def _between(t, start, *ends):
    m = re.search(start, t)
    if not m:
        return None
    rest = t[m.end():]
    cut = min([x.start() for e in ends for x in [re.search(e, rest)] if x] or [600])
    s = re.sub(r"\s+", " ", rest[:cut]).strip(" |:")
    return s[:600] or None


def _date(s):
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(\d{4})", s or "")
    try:
        return datetime.strptime(f"{m.group(1)} {m.group(2)} {m.group(3)}", "%d %b %Y").date().isoformat() if m else None
    except ValueError:
        return None


_STN = {re.sub(r"\W", "", n).lower(): sid for sid, s in fs.STATIONS.items() for n in (s[0], *s[3])}
_STN.update({"punjnad": "panjnad", "kalabagh": "kalabagh", "gswala": "gswala", "suleimanki": "sulemanki", "rasul": "rasul", "mangla": "mangla", "tarbela": "tarbela"})


def _f(s):
    m = re.search(r"-?\d+(?:\.\d+)?", (s or "").replace(",", ""))
    return float(m.group()) if m else None


def parse_bulletin(page):
    t = text_of(page)
    if "BULLETIN No" not in t:
        return None
    t = t[t.index("BULLETIN No"):]
    end = re.search(r"Publication History", t)
    t = t[:end.start()] if end else t
    head = t[:400]
    out = {"number": (re.search(r"BULLETIN No:\s*([\w/]+)", t) or [None, None])[1], "date": _date(_between(t, r"Dated:", r"Time:") or ""),
           "time": (re.search(r"Time:\s*([\d:]+)", head) or [None, None])[1],
           "situation": _between(t, r"HYDROLOGICAL SITUATION[^\n]*", r"IV\.", r"HYDROLOGICAL OUTLOOK"),
           "outlook": _between(t, r"HYDROLOGICAL OUTLOOK", r"V\.\s", r"WEATHER FORECAST"),
           "weather": _between(t, r"METEOROLOGICAL FEATURES", r"II\.\s", r"METEOROLOGICAL OUTLOOK"),
           "weather_outlook": _between(t, r"METEOROLOGICAL OUTLOOK", r"III\.\s", r"HYDROLOGICAL SITUATION"),
           "week_rain": _between(t, r"RAINFALL OUTLOOK\s*\n", r"II\.\s", r"FLOOD OUTLOOK"),
           "week_flood": _between(t, r"II\. FLOOD OUTLOOK", r"Page break", r"\n\s*3\."),
           "note": _between(t, r"Note:", r"RAINFALL FORECAST", r"RIVERS SITUATION"),
           "stations": {}, "reservoirs": {}, "rivers": {}, "rain": []}
    m = re.search(r"RIVERS AT A GLANCE\s*(.*?)FLOOD SEVERITY", t, re.S)
    if m:
        out["rivers"] = {r.title(): s.strip() for r, s in re.findall(r"(INDUS|KABUL|JHELUM|CHENAB|RAVI|SUTLEJ)\s+([A-Za-z ]+?)\s*\|", m[1])}
    row = re.compile(r"^\s*(INDUS|KABUL|JHELUM|CHENAB|RAVI|SUTLEJ)\s*\|\s*([A-Za-z .]+?)\s*\|\s*([\d.,]+|-)\s*\|\s*([\d.,]+|-)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|", re.M)
    for x in row.finditer(t):
        sid = _STN.get(re.sub(r"\W", "", x[2]).lower())
        if not sid:
            continue
        fc = x[5].strip()
        rng = re.match(r"([\d.]+)\s*[-–]\s*([\d.]+)", fc)
        k = lambda s: None if _f(s) is None else round(_f(s) * 1000)
        out["stations"][sid] = {"inflow": k(x[3]), "outflow": k(x[4]), "forecast_text": fc,
                                "forecast": [round(float(rng[1]) * 1000), round(float(rng[2]) * 1000)] if rng else None,
                                "no_change": bool(re.search(r"no\.?\s*sig", fc, re.I)), "forecast_level": x[6].strip(),
                                "record_peak": k(x[7]), "season_peak": k(x[9])}
    for dam in ("TARBELA", "MANGLA"):
        m = re.search(dam + r"[\s|]*\n.*?Level\s*\|\s*([\d.]+)\s*ft.*?([\d.]+)\s*dead\s*\S+\s*([\d.]+)\s*max.*?Storage\s*\|\s*([\d.]+)%\s*live.*?([\d.]+)\s*dead\s*\+\s*([\d.]+)\s*/\s*([\d.]+)\s*MAF", t, re.S)
        if m:
            out["reservoirs"][dam.title()] = {"level_ft": float(m[1]), "dead_ft": float(m[2]), "max_ft": float(m[3]), "live_pct": float(m[4]),
                                              "live_maf": float(m[6]), "live_max_maf": float(m[7])}
    for river in fs.RIVERS:
        m = re.search(rf"^\s*{river}:\s*(.+)$", t, re.M)
        if m:
            vals = [(n.strip(" ,&[("), float(v)) for n, v in re.findall(r"([A-Za-z.\- ]+?)\s*=\s*(\d+)", m[1])]
            if vals:
                out["rain"].append({"river": river, "stations": len(vals), "top": max(vals, key=lambda z: z[1])})
    return out if out["stations"] or out["situation"] else None


def parse_advisory(page):
    t = text_of(page)
    m = re.search(r"Flood Advisory\s*[—–-].*?\n", t)
    i = re.search(r"Issued:\s*(\d{1,2} \w{3} \d{4}),?\s*(\d{1,2}:\d{2})", t)
    if not i:
        return None
    body = t[i.start():]
    stop = re.search(r"Publication History", body)
    body = body[:stop.start()] if stop else body
    issued = datetime.strptime(f"{i[1]} {i[2]}", "%d %b %Y %H:%M").replace(tzinfo=fs.PKT)
    title = (re.search(r"Flood Advisory\s*[—–-]\s*([^|\n]+)", body) or re.search(r"(Flash Flood Advisory[^|\n]*)", body) or (m, m and m[0]))[1]
    river = re.search(r"\n\s*(River [A-Z][a-z]+)\s*\|", body)
    impacts = {}
    for k, pat in (("rivers", r"Rivers & reaches"), ("people", r"Communities & population"), ("farming", r"Agriculture & livestock"), ("transport", r"Infrastructure & transport")):
        x = re.search(pat + r"\s*\|\s*([^|]+)\|", body)
        if x:
            impacts[k] = re.sub(r"\s+", " ", x[1]).strip()[:420]
    cell = lambda k: (lambda x: re.sub(r"\s+", " ", x[1]).strip()[:420] if x else None)(re.search(rf"\n\s*{k}\s*\|\s*([^|]+)\|", body))
    valid = re.search(r"Valid:\s*([^|\n]+)", body)
    return {"title": re.sub(r"\s+", " ", title or "Flood advisory").strip(), "river": river[1] if river else None, "issued": issued.isoformat(),
            "valid": valid[1].strip() if valid else None, "what": cell("What"), "where": cell("Where"), "when": cell("When"), "impacts": impacts}


def parse_storage(page):
    t = re.sub(r"\s+", " ", text_of(page))
    i = t.find("Forecast period:")
    if i < 0:
        return None
    t = t[i:i + 500]
    per = re.search(r"Forecast period:\s*(\d{1,2} \w{3} \d{4})\s*to\s*(\d{1,2} \w{3} \d{4})", t)
    dams = {}
    for d in ("Tarbela", "Mangla"):
        x = re.search(d + r"\s*([\d.]+)\s*[-–]\s*([\d.]+)\s*MAF\s*Normal:\s*([\d.]+)\s*MAF", t)
        if x:
            lo, hi, n = map(float, x.groups())
            dams[d] = {"lo": lo, "hi": hi, "normal": n, "pct": round(100 * (lo + hi) / 2 / n) if n else None}
    up = re.search(r"Updated:\s*(\d{1,2} \w{3} \d{4})", t)
    return {"from": _date(per[1]) if per else None, "to": _date(per[2]) if per else None, "updated": _date(up[1]) if up else None, "dams": dams} if dams else None


def parse_status(text):
    """FFD's own river-status summary (JSON)."""
    j = json.loads(text)
    c = j.get("counts") or {}
    return {"at": j["updated_iso"], "headline": (j.get("headline") or {}).get("en") or (j.get("national") or {}).get("label"), "stations": j.get("stations"),
            "counts": {k: int(v) for k, v in c.items()}, "rivers": {r["river"]: r.get("label") for r in j.get("rivers") or []}}


def parse_daily(page):
    """Newest entry of FFD's daily flood report (Urdu): its time and whether every reporting site is normal."""
    t = text_of(page)
    m = re.search(r"(\d{1,2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}) PKT\s*(.{0,260})", t, re.S)
    if not m:
        return None
    at = datetime.strptime(m[1], "%d-%b-%Y %H:%M").replace(tzinfo=fs.PKT)
    body = re.sub(r"\s+", " ", m[2])
    return {"at": at.isoformat(), "all_normal": "معمول کے مطابق" in body}


def _path():
    return os.path.join(fs.root(), "ffd_site.json")


def load():
    try:
        with open(_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def refresh(force=False):
    """Read each page when due: every hour (the seasonal bulletin once a day off-season). Keeps the last good copy."""
    doc = load()
    read = doc.setdefault("read", {})
    parsers = {"status": parse_status, "daily": parse_daily, "bulletin": parse_bulletin, "advisory": parse_advisory, "storage": parse_storage}
    errors = {}
    for k, p in PAGES.items():
        ttl = 24 * 3600 if k in SEASONAL and not season()["open"] else 3600
        if not force and k in doc and time.time() - read.get(k, 0) < ttl:
            continue
        try:
            r = requests.get(BASE + p, timeout=40, headers=fs.UA)
            r.raise_for_status()
            got = parsers[k](r.text)
            if got is None:
                raise ValueError("page layout not recognised")
            read[k] = time.time()
            doc[k] = {**got, "read_at": datetime.now(fs.PKT).isoformat(), "url": BASE + p}
        except Exception as e:
            errors[k] = type(e).__name__
            logger.warning("flood_ffd_site: %s not read: %s", k, e)
        time.sleep(1.5)
    doc.update(checked=time.time(), errors=errors)
    tmp = _path() + f".{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, _path())
    return doc


def bulletin_age_days(doc, today=None):
    d = (doc.get("bulletin") or {}).get("date")
    return None if not d else ((today or datetime.now(fs.PKT).date()) - date.fromisoformat(d)).days


def advisory_in_force(adv, now=None):
    """Advisories state a validity in hours or days; 24 h is assumed when it cannot be read."""
    if not adv:
        return False
    now = now or datetime.now(fs.PKT)
    m = re.findall(r"(\d+)\s*(?:hours|hrs)", adv.get("valid") or "", re.I)
    d = re.findall(r"(\d+)\s*days", adv.get("valid") or "", re.I)
    h = max([int(x) for x in m] + [24 * int(x) for x in d] or [24])
    return now - datetime.fromisoformat(adv["issued"]) <= timedelta(hours=max(h, 6))
