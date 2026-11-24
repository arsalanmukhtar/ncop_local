# project/ncop_internal/foodsec_ews.py
# ---------------------------------------------------------------------------
# Early-warning layer of the Food Security & Agriculture Watch.
#
#   indicators -> four scored pillars per district (0 normal ... 3 alert)
#              -> district level -> national picture -> actions
#
# Pillars scored at district level, from data that still describe the present:
#   hunger   FEWS NET area classification (an outcome)
#   market   flour price, flour against daily wage, flour-to-wheat spread, in
#            the WFP market(s) of the same province
#   water    rain (SPI-3/SPI-6), root-zone soil moisture, crop greenness (VCI)
#            for rain-fed districts; canal-water availability and crop
#            greenness for the irrigated ones (local rain says little there)
#   shocks   abnormally heavy rain; recorded displacement
# Shown, but NOT scored at district level because no fresh open district data
# exist: nutrition, public stocks, response capacity (the report's data gaps).
#
# Rules (illustrative, from the NCOP implementation guide; back-tested below):
#   Warning   two or more pillars at 2+
#   Alert     one pillar at 3 with Medium/High confidence, or two pillars at 3
#   Watch     any pillar at 1+
#   A level falls only after two consecutive months below it.
# This is an analytical overlay. It is not an IPC classification.
#
# Pure computation on the compact stores (foodsec_eo, foodsec_sources); no
# network access here. Runs inside foodsec_watch's background build.
# ---------------------------------------------------------------------------

import hashlib
import json
import logging
import math
import os
import statistics
import uuid
from datetime import date, datetime, timezone

import numpy as np
from django.conf import settings

from . import foodsec_eo as eo
from . import foodsec_sources as fs

logger = logging.getLogger(__name__)

VERSION = "ews-3"
LEVELS = ["Normal", "Watch", "Warning", "Alert"]
FLOUR, WHEAT = "Wheat flour", "Wheat"
WAGE = "Wage (non-qualified labour, non-agricultural)"
# [watch, warning, alert]; "up" = larger is worse, "down" = smaller is worse.
THRESHOLDS = {
    "fews_phase": ("up", [2, 3, 4], "FEWS NET area phase"),
    "flour_m3": ("up", [5, 10, 15], "Flour price, change over 3 months (%)"),
    "spread": ("up", [10, 20, 30], "Flour-to-wheat price ratio against its 5-year average (%)"),
    "kg_wage": ("down", [-10, -15, -25], "Flour bought by a day's wage, against the 5-year average (%)"),
    "spi": ("down", [-1.0, -1.5, -2.0], "Rain index (SPI, worse of 3 and 6 months)"),
    "soil": ("down", [20, 10, 5], "Root-zone soil moisture (percentile)"),
    "vci": ("down", [35, 25, 15], "Crop greenness (VCI)"),
    "canal": ("down", [-10, -20, -30], "Canal water against normal (%)"),
    "wet": ("up", [1.5, 2.0, 99], "Abnormally heavy rain (SPI-1)"),
    "displaced": ("up", [1, 1000, 10000], "People newly displaced in 90 days"),
}
PILLARS = {"hunger": "Food insecurity", "market": "Food prices and wages", "water": "Water and crops", "shocks": "Shocks"}
MARKET_PROVINCE = {"Punjab": ["Lahore", "Multan"], "Sindh": ["Karachi"], "Khyber Pakhtunkhwa": ["Peshawar"], "Balochistan": ["Quetta"]}
# Rain-fed parts of the two canal-irrigated provinces (Potohar plateau; Thar).
RAINFED = {"attock", "chakwal", "talagang", "rawalpindi", "jhelum", "murree", "tharparkar", "islamabad"}
KARACHI = {"central karachi", "east karachi", "south karachi", "west karachi", "korangi", "malir", "keamari"}
# Districts newer than FEWS NET's map take the class of the district they were cut from.
PARENT = {"Hub": "Lasbela", "Usta Muhammad": "Jaffarabad", "Keamari": "West Karachi"}
MIN_CROPLAND = 0.05
# 7th Population and Housing Census 2023 (PBS). District split: JRC GHSL 2025.
CENSUS_2023 = {"Punjab": 127_688_922, "Sindh": 55_696_147, "Khyber Pakhtunkhwa": 40_856_097, "Balochistan": 14_894_402,
               "Federal Capital": 2_363_863}
OUTSIDE = "Indian_Illegally_Occupied_Jammu_Kashmir"
# HIES 2024-25 (PBS), Tables 7.1-7.2: households with food insecurity, %.
HIES = {"year": "2024-25", "moderate_or_severe": 24.35, "severe": 5.04, "prev_year": "2018-19", "prev_moderate_or_severe": 15.92,
        "prev_severe": 2.37, "urban": 20.58, "rural": 26.72, "poorest": 45.97, "richest": 8.95,
        "provinces": {"Punjab": 22.58, "Sindh": 29.42, "Khyber Pakhtunkhwa": 21.54, "Balochistan": 30.26}}


def score(ind, value):
    if value is None or not math.isfinite(value):
        return None
    way, cuts, _ = THRESHOLDS[ind]
    v, c = (value, cuts) if way == "up" else (-value, [-x for x in cuts])
    # soil and VCI thresholds read "below"; the rest "at or beyond"
    strict = ind in ("soil", "vci")
    return sum(1 for x in c if (v > x if strict else v >= x - 1e-9))


# ------------------------------------------------------------------- months
def mi(s):
    return int(s[:4]) * 12 + int(s[5:7]) - 1


def ms(i):
    return f"{i // 12}-{i % 12 + 1:02d}"


# ------------------------------------------------------------------ market
class Prices:
    """Month x market matrices of the WFP retail series (NaN where missing)."""

    def __init__(self, wfp):
        self.markets = sorted(wfp["markets"])
        self.by = {}
        for c, d in wfp["prices"].items():
            lo, hi = mi(min(d)), mi(max(d))
            a = np.full((hi - lo + 1, len(self.markets)), np.nan)
            for m, row in d.items():
                for k, v in row.items():
                    a[mi(m) - lo, self.markets.index(k)] = v
            self.by[c] = (lo, a)
        self.last = max(lo + a.shape[0] - 1 for lo, a in self.by.values())

    def at(self, c, i, cols=None):
        """Mean price at month i over the given markets (all by default); NaN if fewer than half reported."""
        if c not in self.by:
            return np.nan
        lo, a = self.by[c]
        if not 0 <= i - lo < a.shape[0]:
            return np.nan
        r = a[i - lo] if cols is None else a[i - lo, cols]
        ok = np.isfinite(r)
        return float(r[ok].mean()) if ok.sum() * 2 >= r.size and ok.any() else np.nan

    def national(self, c):
        """(first month, array) of the all-market mean."""
        lo, a = self.by[c]
        ok = np.isfinite(a)
        n = ok.sum(1)
        s = np.where(ok, a, 0).sum(1) / np.maximum(n, 1)
        s[n < max(3, a.shape[1] - 2)] = np.nan
        return lo, s

    def cols(self, names):
        return [self.markets.index(n) for n in names if n in self.markets]

    def wage_still_since(self, col, i):
        """Months the wage in one market has stayed within 0.2% of its value at i."""
        lo, a = self.by.get(WAGE, (0, np.empty((0, 0))))
        if not 0 <= i - lo < a.shape[0] or not np.isfinite(a[i - lo, col]):
            return None
        v, n = a[i - lo, col], 0
        for k in range(i - lo - 1, -1, -1):
            if np.isfinite(a[k, col]) and abs(a[k, col] / v - 1) > 0.002:
                break
            n += 1
        return n


def kg_per_wage(px, i, cols=None):
    cols = list(range(len(px.markets))) if cols is None else cols
    vals = []
    for c in cols:
        w, f = px.at(WAGE, i, [c]), px.at(FLOUR, i, [c])
        if np.isfinite(w) and np.isfinite(f):
            vals.append(w / f)
    return float(np.mean(vals)) if vals else np.nan


def _pct(a, b):
    return (a / b - 1) * 100 if np.isfinite(a) and np.isfinite(b) and b else np.nan


def market_indicators(px, i, names=None):
    """Indicators at month i for one province's market(s), or the national mean."""
    cols = px.cols(names) if names else None
    if names and not cols:
        return {}
    f = px.at(FLOUR, i, cols)
    out = {"flour": f, "flour_m3": _pct(f, px.at(FLOUR, i - 3, cols)), "flour_y1": _pct(f, px.at(FLOUR, i - 12, cols))}
    same = [px.at(FLOUR, i - 12 * k, cols) for k in range(1, 6)]
    same = [x for x in same if np.isfinite(x)]
    if len(same) >= 4 and np.std(same, ddof=1) > 0:
        out["flour_z"] = (f - np.mean(same)) / np.std(same, ddof=1)      # shown, not scored (see report)
    kg = kg_per_wage(px, i, cols)
    prior = [kg_per_wage(px, i - 12 * k, cols) for k in range(1, 6)]
    prior = [x for x in prior if np.isfinite(x)]
    out["kg"] = kg
    out["kg_avg5"] = float(np.mean(prior)) if len(prior) >= 3 else np.nan
    out["kg_wage"] = _pct(kg, out["kg_avg5"])

    def ratio(j):
        fl, wh = px.at(FLOUR, j, cols), px.at(WHEAT, j, cols)
        return fl / wh if np.isfinite(fl) and np.isfinite(wh) and wh else np.nan
    base = [ratio(i - k) for k in range(1, 61)]
    base = [x for x in base if np.isfinite(x)]
    out["spread"] = _pct(ratio(i), float(np.mean(base))) if len(base) >= 36 else np.nan
    return {k: (None if not np.isfinite(v) else round(float(v), 2)) for k, v in out.items()}


def market_pillar(px, i, names):
    """One or two city markets stand in for a whole province, so confidence is Medium
    only in the market's own district (see assess) and Low elsewhere."""
    m = market_indicators(px, i, names)
    sc = {k: score(k, m.get(k)) for k in ("flour_m3", "spread", "kg_wage")}
    have = {k: v for k, v in sc.items() if v is not None}
    if not have:
        return None
    top = max(have.values())
    why = [k for k, v in have.items() if v == top and top > 0]
    cols = px.cols(names)
    still = [px.wage_still_since(c, i) for c in cols]
    stale_wage = any(s is not None and s >= 12 for s in still)
    conf = "Low" if top and why == ["kg_wage"] and stale_wage else "Medium"
    return {"score": top, "why": why, "conf": conf, "values": m, "stale_wage": stale_wage}


# ------------------------------------------------------------------- water
def water_pillar(row, canal, irrigated):
    """row: one district of eo.indicators(); canal: % against normal canal water, or None.
    Irrigated districts are judged on canal water and crop greenness; local rain says little there."""
    spis = [row[k] for k in ("spi3", "spi6") if row.get(k) is not None]
    vals = {"spi": min(spis) if spis else None, "soil": row.get("soil_pct"),
            "vci": row.get("vci") if (row.get("cropland") or 0) >= MIN_CROPLAND else None}
    sc = {k: score(k, vals[k]) for k in (("vci",) if irrigated else ("spi", "soil", "vci"))}
    if canal is not None and (row.get("cropland") or 0) >= MIN_CROPLAND:
        sc["canal"] = score("canal", canal)
        vals["canal"] = canal
    have = {k: v for k, v in sc.items() if v is not None}
    if not have:
        return None
    top = max(have.values())
    why = [k for k, v in have.items() if v == top and top > 0]
    support = sum(1 for v in have.values() if v >= max(top - 1, 1))
    conf = "Medium" if top == 0 or support >= 2 or why == ["canal"] else "Low"
    return {"score": top, "why": why, "conf": conf, "values": vals, "irrigated": irrigated}


def is_irrigated(name, province):
    return province in ("Punjab", "Sindh") and str(name).lower() not in RAINFED


# ------------------------------------------------------------------ levels
def district_level(pillars):
    """(level 0-3, confidence, pillars that set it) from {pillar: {"score","conf"}}."""
    p = {k: v for k, v in pillars.items() if v}
    at = {n: [k for k, v in p.items() if v["score"] >= n] for n in (1, 2, 3)}
    solid3 = [k for k in at[3] if p[k]["conf"] in ("Medium", "High")]
    if len(at[3]) >= 2 or solid3:
        lvl, by = 3, (at[3] if len(at[3]) >= 2 else solid3)
    elif len(at[2]) >= 2:
        lvl, by = 2, at[2]
    elif at[1]:
        lvl, by = 1, at[1]
    else:
        lvl, by = 0, list(p)
    order = {"Low": 0, "Medium": 1, "High": 2}
    conf = min((p[k]["conf"] for k in by), key=order.get) if by else "Low"
    if len(p) < 3:
        conf = "Low"                                   # too few pillars have data
    return lvl, conf, by


def effective(now, before):
    """Hysteresis: a level falls only after two consecutive periods below it."""
    return now if before is None else max(now, before)


def _fews_index(pack, scen, match):
    out = {}
    for u in (pack or {}).get("units", []):
        if u.get(scen) is None:
            continue
        hit = match(u["name"])
        if hit:
            out.setdefault(hit, []).append(u[scen])
    return {k: max(v) for k, v in out.items()}


def matcher(rows):
    """Area name -> district index list of our own district layer (foodsec_watch's tolerant matching)."""
    from . import foodsec_watch as fw
    lookup = {fw._norm(r["name"]): {"name": r["name"], "province": r["province"]} for r in rows}
    alias = {"qambar shahdadkot": "kambar shahdad kot", "leiah": "layyah", "umer kot": "umerkot", "tor ghar": "torghar",
             "d i khan": "dera ismail khan", "kambar shahdad kot": "qambar shahdadkot", "shaheed sikandarabad": "surab",
             "jhelum valley": "hattian", "neelum": "neelam valley", "rondu": "roundu", "mirpur khas": "mirpurkhas",
             "chitral lower": "chitral", "kohistan lower": "lower kohistan", "kohistan upper": "upper kohistan",
             "chitral upper": "upper chitral", "batagram": "battagram", "kolai palas kohistan": "kolai palas",
             "central karachi": "karachi central", "east karachi": "karachi east", "south karachi": "karachi south",
             "west karachi": "karachi west", "malir karachi": "malir", "korangi karachi": "korangi",
             "naushahro feroze": "naushehro feroze", "kashmore": "kashmor", "kachhi": "bolan"}

    def key(name):
        n = fw._norm(name)
        for c in (n, alias.get(n)):
            if c and c in lookup:
                return lookup[c]["name"]
        for k, v in alias.items():
            if v == n and k in lookup:
                return lookup[k]["name"]
        n2 = n.replace(" ", "")
        for k, v in lookup.items():
            if k.replace(" ", "") == n2:
                return v["name"]
        hit = fw._match(lookup, name)
        return hit["name"] if hit and fw._norm(hit["name"]).split()[0] in n.split() else None
    return key


# -------------------------------------------------------------------- build
def _population(rows):
    """Census-2023 provincial totals split by the GHSL district pattern."""
    tot = {}
    for r in rows:
        tot[r["province"]] = tot.get(r["province"], 0) + (r.get("population") or 0)
    for r in rows:
        c = CENSUS_2023.get(r["province"])
        if c and tot[r["province"]]:
            r["population"] = round((r.get("population") or 0) * c / tot[r["province"]])
    return rows


def _displaced(idmc, rows, meta, today):
    """People newly displaced in the last 90 days per district (nearest centroid inside the bbox)."""
    out = {}
    if not idmc or not fs.fresh("idmc", idmc, today):
        return None
    for e in idmc["data"]["events"]:
        if (today - date.fromisoformat(e["date"])).days > 90 or e["lat"] is None:
            continue
        if "ADM2" not in e["accuracy"] and "ADM3" not in e["accuracy"] and "Point" not in e["accuracy"]:
            continue
        best = None
        for m in meta:
            w, s, ea, n = m["bbox"]
            if w <= e["lon"] <= ea and s <= e["lat"] <= n:
                d = (m["centroid"][0] - e["lon"]) ** 2 + (m["centroid"][1] - e["lat"]) ** 2
                if best is None or d < best[0]:
                    best = (d, m["name"])
        if best:
            out[best[1]] = out.get(best[1], 0) + e["n"]
    return out


def canal_now(reg):
    e = next((x for x in reg if x.get("value_pct") is not None and x["state"] == "current"), None)
    return (e["value_pct"], set(e["provinces"])) if e else (None, set())


def _is_market(name):
    return str(name).lower() in {"lahore", "multan", "peshawar", "quetta"} | KARACHI


def assess(eo_now, px, i_px, fews, displaced, canal):
    """One month's raw pillars and levels for every district."""
    mk = {p: market_pillar(px, i_px, names) for p, names in MARKET_PROVINCE.items()} if px else {}
    out = {}
    for r in eo_now["districts"]:
        if r["province"] == OUTSIDE:
            continue
        irr = is_irrigated(r["name"], r["province"])
        m = mk.get(r["province"])
        if m and not _is_market(r["name"]):
            m = {**m, "conf": "Low"}
        pillars = {"market": m, "water": water_pillar(r, canal[0] if irr and r["province"] in canal[1] else None, irr)}
        ph = fews.get(r["name"]) or fews.get(PARENT.get(r["name"]))
        pillars["hunger"] = {"score": score("fews_phase", ph), "why": ["fews_phase"] if ph >= 2 else [], "conf": "Medium",
                             "values": {"phase": ph}} if ph else None
        sh = {}
        if r.get("spi1") is not None:
            sh["wet"] = min(score("wet", r["spi1"]), 2)
        nd = (displaced or {}).get(r["name"])
        if nd:
            sh["displaced"] = score("displaced", nd)
        top = max(sh.values()) if sh else 0
        pillars["shocks"] = {"score": top, "why": [k for k, v in sh.items() if v == top and top], "conf": "Medium" if nd else "Low",
                             "values": {"spi1": r.get("spi1"), "displaced": nd}}
        lvl, conf, by = district_level(pillars)
        out[r["name"]] = {"level": lvl, "conf": conf, "by": by, "pillars": pillars}
    return out


def _round(x, n=1):
    return None if x is None or not np.isfinite(x) else round(float(x), n)


def build(docs, meta, today=None):
    """The "ews" section of the digest."""
    today = today or date.today()
    reg = fs.register(today)
    store = eo.load()
    if not store:
        raise eo.EoUnavailable("no EO store")
    wfp = docs.get("wfp")
    px = Prices(wfp["data"]) if wfp else None
    cur = eo.indicators(store)
    _population(cur["districts"])
    end = min(store[v][0] + store[v][1].shape[1] - 1 for v in eo.VARS)
    match = matcher(cur["districts"])
    fd = (docs.get("fews") or {}).get("data")
    fews_ok = fs.fresh("fews", docs.get("fews"), today)
    f_now = _fews_index(fd["current"], "now", match) if fd and fews_ok else {}
    f_next = _fews_index(fd["current"], "next", match) if fd and fews_ok else {}
    f_later = _fews_index(fd["current"], "later", match) if fd and fews_ok else {}
    f_prev = _fews_index(fd["previous"], "next", match) if fd and fd.get("previous") else {}
    disp = _displaced(docs.get("idmc"), cur["districts"], meta, today)
    canal = canal_now(reg)
    px_fresh = px if px and fs.fresh("wfp", wfp, today) else None
    raw = assess(cur, px_fresh, px.last if px else 0, f_now, disp, canal)
    before = assess(eo.indicators(store, end - 1), px_fresh, px.last - 1 if px else 0, f_prev or f_now, None, canal)
    before2 = assess(eo.indicators(store, end - 2), px_fresh, px.last - 2 if px else 0, f_prev or f_now, None, canal)

    pres = {}
    for d in ((docs.get("presence") or {}).get("data") or {}).get("districts", []):
        k = match(d["name"])
        if k:
            pres[k] = {"food": d["food"], "nutrition": d["nutrition"]}
    ipc = latest_ipc(docs, match)
    geo = {m["name"]: m for m in meta}
    rows = []
    for r in cur["districts"]:
        a = raw.get(r["name"])
        if not a:
            continue
        b, b2 = before[r["name"]], before2[r["name"]]
        was = effective(b["level"], b2["level"])
        lvl = effective(a["level"], b["level"])
        held = lvl != a["level"]
        g = geo.get(r["name"], {})
        rows.append({
            "name": r["name"], "province": r["province"], "population": r.get("population"), "bbox": g.get("bbox") if lvl >= 2 else None,
            "centroid": g.get("centroid") if lvl >= 2 else None, "level": lvl, "raw_level": a["level"], "prev_level": was, "held": held,
            "held_why": sorted({w for k in b["by"] for w in (b["pillars"].get(k) or {}).get("why", [])}) if held else [],
            "confidence": a["conf"] if not held else b["conf"], "by": (a if not held else b)["by"],
            "pillars": {k: (None if not v else [v["score"], v["why"], v["conf"]]) for k, v in a["pillars"].items()},
            "fews": [f.get(r["name"]) or f.get(PARENT.get(r["name"])) for f in (f_now, f_next, f_later)],
            "spi1": r["spi1"], "spi3": r["spi3"], "spi6": r["spi6"], "soil_pct": r["soil_pct"],
            "vci": r["vci"] if (r.get("cropland") or 0) >= MIN_CROPLAND else None,
            "irrigated": is_irrigated(r["name"], r["province"]),
            "ipc": ipc["by"].get(r["name"]), "presence": pres.get(r["name"])})
    national = _national(rows)
    out = {"version": VERSION, "as_of": today.isoformat(),
           "periods": {"prices": ms(px.last) if px else None, "eo": cur["months"], "fews": (fd or {}).get("current", {}).get("periods"),
                       "fews_round": (fd or {}).get("current", {}).get("round")},
           "thresholds": {k: {"way": w, "cuts": c, "label": lab} for k, (w, c, lab) in THRESHOLDS.items()},
           "levels": LEVELS, "pillars": PILLARS, "national": national, "districts": rows, "provinces": _provinces(rows),
           "rankings": _rankings(ipc, rows), "ipc": ipc["summary"], "needs": next((e for e in reg if e["id"] == "needs2026"), None)}
    out["market"] = {p: market_indicators(px, px.last, n) for p, n in MARKET_PROVINCE.items()} if px else {}
    if px:
        out["market"]["Pakistan"] = market_indicators(px, px.last)
    out["market_scores"] = {p: _trim(market_pillar(px, px.last, n)) for p, n in MARKET_PROVINCE.items()} if px else {}
    out["water"] = _water_panel(store, cur, docs, reg)
    out["supply"] = _supply(docs)
    out["shocks"] = _shocks_panel(docs, today)
    out["household"] = {"hies": HIES, "diet": ((docs.get("diet") or {}).get("data") or {}), "poverty": ((docs.get("poverty") or {}).get("data") or {}),
                        "undernourished": ((docs.get("undernourished") or {}).get("data") or {})}
    out["register"] = reg
    out["price_outlook"] = price_outlook(px) if px else None
    out["issues"] = quality(docs, px, today, fd)
    out["health"] = fs.health(docs, today)
    out["health"].append({"id": "eo", "name": "Satellite drought indicators (CHIRPS v3, FLDAS, MODIS)", "type": "Modelled",
                          "url": "https://earthengine.google.com", "licence": "Open data", "period": min(cur["months"].values()),
                          "valid_to": None, "retrieved": cur["updated"], "checksum": None,
                          "state": "current" if mi(today.isoformat()) - mi(min(cur["months"].values())) <= 2 else "out of date"})
    out["actions"] = actions(out)
    out["calendar"] = calendar(today)
    out["backtest"] = backtest(px, store) if px else None
    out["changes"] = _changes(rows, px)
    out["issue"] = log_issue(out)
    return out


def _trim(p):
    return None if not p else {k: p[k] for k in ("score", "why", "conf", "stale_wage")}


def _national(rows):
    n, pop = len(rows), sum(r["population"] or 0 for r in rows)
    c = {k: sum(1 for r in rows if r["level"] == k) for k in range(4)}
    p = {k: sum(r["population"] or 0 for r in rows if r["level"] == k) for k in range(4)}
    hi = (p[2] + p[3]) / pop if pop else 0
    # Headline only; the counts are the result. Stated in the report.
    lvl = 3 if p[3] / max(pop, 1) >= 0.25 else 2 if hi >= 0.25 else 1 if (c[1] + c[2] + c[3]) / max(n, 1) >= 0.25 else 0
    why = {}
    for r in rows:
        if r["level"] >= 2:
            for k in r["by"]:
                why[k] = why.get(k, 0) + 1
    conf = {k: sum(1 for r in rows if r["level"] >= 2 and r["confidence"] == k) for k in ("High", "Medium", "Low")}
    return {"level": lvl, "districts": n, "population": pop, "count": c, "people": p,
            "warning_plus": {"districts": c[2] + c[3], "people": p[2] + p[3], "share_people": round(hi, 3),
                             "share_districts": round((c[2] + c[3]) / max(n, 1), 3)},
            "why": dict(sorted(why.items(), key=lambda x: -x[1])), "confidence": conf,
            "raised": sum(1 for r in rows if r["level"] > r["prev_level"]), "lowered": sum(1 for r in rows if r["level"] < r["prev_level"])}


def _provinces(rows):
    out = {}
    for r in rows:
        o = out.setdefault(r["province"], {"province": r["province"], "districts": 0, "population": 0, "count": [0, 0, 0, 0], "people2": 0})
        o["districts"] += 1
        o["population"] += r["population"] or 0
        o["count"][r["level"]] += 1
        if r["level"] >= 2:
            o["people2"] += r["population"] or 0
    return sorted(out.values(), key=lambda o: -(o["count"][3] * 1000 + o["count"][2]))


def latest_ipc(docs, match):
    """The two IPC lines behind the old single headline, with their own dates, plus district values."""
    doc = docs.get("ipc")
    if not doc:
        return {"summary": None, "by": {}, "areas": []}
    a = doc["data"]
    new, old = a[0], (a[1] if len(a) > 1 else None)
    lines = []
    shared = {g["name"]: g for g in (old or {}).get("groups", [])}
    added = [g for g in new["groups"] if g["name"] not in shared]
    same = old and added and all(g["name"] in {x["name"] for x in new["groups"]} for g in old["groups"])
    if same:
        lines.append({"label": f"{sum(g['areas'] for g in old['groups'])} districts of " + ", ".join(g["name"] for g in old["groups"]),
                      "analysis": old["title"], "date": old["date"], "url": old["url"], "periods": old["periods"], **old["totals"]})
        for g in added:
            lines.append({"label": f"{g['areas']} districts of {g['name']}", "analysis": new["title"], "date": new["date"], "url": new["url"],
                          "periods": new["periods"], "current": g["current"], "projected": g["projected"]})
    else:
        lines.append({"label": f"{len(new['areas'])} districts", "analysis": new["title"], "date": new["date"], "url": new["url"],
                      "periods": new["periods"], **new["totals"]})
    by, areas = {}, []
    ends = max(p["to"] for p in new["periods"].values())
    for x in new["areas"]:
        v = x.get("projected") or x.get("current")
        if not v:
            continue
        areas.append({"name": x["name"], "group": x["group"], **v})
        k = match(x["name"])
        if k:
            by[k] = {"phase": v["phase"], "p3plus": v["p3plus"], "p3plus_pct": v["p3plus_pct"], "p4": v["p4"]}
    hist = []
    for an in a:
        for k in ("current", "projected"):
            t, p = an["totals"].get(k), an["periods"].get(k)
            if t and p:
                hist.append({"title": an["title"], "kind": k, "from": p["from"], "to": p["to"], "areas": len(an["areas"]),
                             "provinces": [g["name"] for g in an["groups"]], **t})
    tot = sum((ln["projected"] or {}).get("p3plus", 0) for ln in lines)
    return {"summary": {"lines": lines, "valid_to": ends, "expired": date.today().isoformat() > ends, "sum_projected": tot,
                        "sum_current": sum((ln["current"] or {}).get("p3plus", 0) for ln in lines), "history": hist,
                        "districts": len(new["areas"])}, "by": by, "areas": areas}


def _rankings(ipc, rows):
    """Two rankings of the last official IPC counts: where most people are, and where the share is highest."""
    a = ipc["areas"]
    pick = lambda x: {k: x[k] for k in ("name", "group", "pop", "p3plus", "p3plus_pct", "p4", "phase")}
    lv = {r["name"]: r for r in rows}
    concern = sorted((r for r in rows if r["level"] >= 2), key=lambda r: (-r["level"], -r["raw_level"], -sum(v[0] if v else 0 for v in r["pillars"].values()),
                                                                         -(r["population"] or 0)))
    return {"burden": [pick(x) for x in sorted(a, key=lambda x: -x["p3plus"])[:10]],
            "prevalence": [pick(x) for x in sorted(a, key=lambda x: (-x["p3plus_pct"], -x["p3plus"]))[:10]],
            "level": [r["name"] for r in concern[:24]], "known": len(lv)}


def _water_panel(store, cur, docs, reg):
    prov = {}
    s, a = store["rain"]
    end = s + a.shape[1] - 1
    # monsoon (Jun-Sep) rain of the latest complete season against other years, by province
    y = end // 12 if end % 12 >= 8 else end // 12 - 1
    for k, info in enumerate(store["districts"]):
        if info["province"] != OUTSIDE:
            prov.setdefault(info["province"], []).append(k)
    out = []
    for p, ks in prov.items():
        years = range(s // 12, y + 1)
        tot = np.array([[a[k, eo.month_index(yy, 6) - s:eo.month_index(yy, 9) - s + 1].sum() for yy in years] for k in ks]).mean(0)
        norm = tot[[i for i, yy in enumerate(years) if 1991 <= yy <= 2020]].mean()
        row = [r for r in cur["districts"] if r["province"] == p]
        med = lambda f: (lambda v: round(float(np.median(v)), 1) if v else None)([r[f] for r in row if r[f] is not None])
        out.append({"province": p, "monsoon_year": y, "monsoon_mm": round(float(tot[-1])), "monsoon_normal_mm": round(float(norm)),
                    "monsoon_pct": round(float((tot[-1] / norm - 1) * 100)) if norm else None,
                    "dry_rank": int((tot[:-1] < tot[-1]).sum()) + 1, "years": len(tot), "spi6": med("spi6"), "soil_pct": med("soil_pct"),
                    "vci": med("vci")})
    e = docs.get("enso")
    en = None
    if e:
        o = e["data"]["oni"][-1]
        en = {"oni": o["oni"], "season": f"{o['season']} {o['year']}", "weekly": e["data"]["weekly"],
              "state": "El Niño" if o["oni"] >= 0.5 else "La Niña" if o["oni"] <= -0.5 else "neutral",
              "strength": None if abs(o["oni"]) < 0.5 else "very strong" if abs(o["oni"]) >= 2 else "strong" if abs(o["oni"]) >= 1.5
              else "moderate" if abs(o["oni"]) >= 1 else "weak", "series": [x["oni"] for x in e["data"]["oni"][-18:]]}
    res = docs.get("reservoirs")
    rs = None
    if res and fs.fresh("reservoirs", res):
        rs = {"recorded": res["data"]["recorded"],
              "dams": [{"name": k, **v, "range_pct": round(100 * (v["level_ft"] - v["dead_ft"]) / (v["max_ft"] - v["dead_ft"]))}
                       for k, v in res["data"]["now"].items()]}
    c = canal_now(reg)
    return {"provinces": sorted(out, key=lambda r: (r["monsoon_pct"] if r["monsoon_pct"] is not None else 0)), "enso": en, "reservoirs": rs,
            "canal_pct": c[0], "canal_provinces": sorted(c[1])}


def _supply(docs):
    d = docs.get("psd")
    out = {"wheat": None}
    if d:
        w = d["data"]["wheat"]
        rows = []
        for x in w[-12:]:
            if x.get("use"):
                rows.append({"marketing_year": f"{x['marketing_year']}/{str(x['marketing_year'] + 1)[2:]}", "harvest_year": x["marketing_year"],
                             "production": x.get("production"), "imports": x.get("imports"), "exports": x.get("exports"), "use": x["use"],
                             "end_stocks": x.get("end_stocks"), "cover_days": round(365 * (x.get("end_stocks") or 0) / x["use"])})
        out["wheat"] = {"release": d["period"], "rows": rows}
    p = docs.get("pink")
    if p:
        q = {}
        for k, s in p["data"].items():
            m = sorted(s)
            q[k] = {"month": m[-1], "value": s[m[-1]], "y1_pct": _round(_pct(s[m[-1]], s.get(ms(mi(m[-1]) - 12), np.nan))),
                    "m3_pct": _round(_pct(s[m[-1]], s.get(ms(mi(m[-1]) - 3), np.nan)))}
        out["world"] = q
    if docs.get("fx"):
        out["pkr_per_usd"] = docs["fx"]["data"]["pkr_per_usd"]
        hrw = (out.get("world") or {}).get("wheat_hrw")
        if hrw:
            # Reference only: US hard wheat at the US Gulf, before freight, insurance, duty and handling.
            out["world_wheat_pkr_kg"] = round(hrw["value"] * out["pkr_per_usd"] / 1000, 1)
    return out


def _shocks_panel(docs, today):
    c, i = docs.get("conflict"), docs.get("idmc")
    out = {"conflict": None, "displacement": None}
    if c:
        m = c["data"]["months"]
        k = sorted(m)
        prior = [m[x]["events"] for x in k[-13:-1]]
        out["conflict"] = {"month": k[-1], **m[k[-1]], "avg12": round(statistics.mean(prior)) if prior else None,
                           "series": [{"month": x, **m[x]} for x in k[-18:]]}
    if i and i["data"]["events"]:
        yr = {}
        for e in i["data"]["events"]:
            yr.setdefault(e["date"][:4], {}).setdefault(e["kind"], 0)
            yr[e["date"][:4]][e["kind"]] += e["n"]
        out["displacement"] = {"through": i["period"], "by_year": yr}
    return out


# ----------------------------------------------------------- price outlook
def _features(logp, wheat, diesel, t):
    """Predictors known at month t for the change ahead."""
    def d(s, k):
        return s[t] - s[t - k] if t - k >= 0 and np.isfinite(s[t]) and np.isfinite(s[t - k]) else 0.0
    sp = logp[t] - wheat[t]
    base = logp[max(0, t - 36):t] - wheat[max(0, t - 36):t]
    base = base[np.isfinite(base)]
    return np.array([1.0, d(logp, 1), d(logp, 3), d(wheat, 3), d(diesel, 3),
                     (sp - base.mean()) if np.isfinite(sp) and base.size else 0.0])


def _seasonal(logp, t, h):
    """Median same-season change over the previous five years (the baseline)."""
    v = [logp[t - 12 * y + h] - logp[t - 12 * y] for y in range(1, 6) if t - 12 * y >= 0]
    v = [x for x in v if np.isfinite(x)]
    return float(np.median(v)) if len(v) >= 3 else 0.0


MODELS = ("no_change", "seasonal", "momentum", "drivers", "blend")
FIRST_ORIGIN, TEST_FROM = 84, "2021-01"


def _predict(logp, wheat, diesel, t, h, coef):
    sea = _seasonal(logp, t, h)
    m3 = (logp[t] - logp[t - 3]) / 3 if t >= 3 and np.isfinite(logp[t - 3]) else 0.0
    mom = m3 * sum(0.5 ** k for k in range(1, h + 1))
    drv = float(_features(logp, wheat, diesel, t) @ coef) if coef is not None else 0.0
    return {"no_change": 0.0, "seasonal": sea, "momentum": mom, "drivers": drv, "blend": (sea + mom + drv) / 3}


def _fit(logp, wheat, diesel, t, h, cache):
    """Ridge fit using only months whose outcome was already known at t."""
    key = (t, h)
    if key in cache:
        return cache[key]
    rows = [(i, logp[i + h] - logp[i]) for i in range(37, t - h + 1) if np.isfinite(logp[i + h]) and np.isfinite(logp[i])]
    if len(rows) < 36:
        cache[key] = None
        return None
    for i, _ in rows:
        if ("x", i) not in cache:
            cache[("x", i)] = _features(logp, wheat, diesel, i)
    X = np.array([cache[("x", i)] for i, _ in rows])
    y = np.array([v for _, v in rows])
    lam = np.diag([0.0] + [0.02 * len(rows) * float(np.var(X[:, k]) + 1e-9) for k in range(1, X.shape[1])])
    cache[key] = np.linalg.solve(X.T @ X + lam + 1e-9 * np.eye(X.shape[1]), X.T @ y)
    return cache[key]


def _pinball(q, actual, pred):
    d = actual - pred
    return max(q * d, (q - 1) * d)


def price_outlook(px, item=FLOUR):
    """1-3 month outlook with a rolling-origin test. At every past month the model with
    the smallest error over the 36 months before it makes the forecast ("chosen"), and
    the range comes from that model's errors known by then, so nothing sees the future."""
    lo, p = px.national(item)
    n = len(p)
    logp = np.log(p)

    def aligned(c):
        if c not in px.by:
            return np.full(n, np.nan)
        l2, s = px.national(c)
        return np.array([np.log(s[lo + k - l2]) if 0 <= lo + k - l2 < len(s) else np.nan for k in range(n)])
    wheat, diesel = aligned(WHEAT), aligned("Fuel (diesel)")
    cache, err = {}, {m: {h: [] for h in (1, 2, 3)} for m in MODELS}
    for t in range(FIRST_ORIGIN, n):
        if not np.isfinite(logp[t]):
            continue
        for h in (1, 2, 3):
            if t + h >= n or not np.isfinite(logp[t + h]):
                continue
            pr = _predict(logp, wheat, diesel, t, h, _fit(logp, wheat, diesel, t, h, cache))
            for m in MODELS:
                err[m][h].append((lo + t, logp[t + h] - logp[t] - pr[m], p[t], p[t + h]))
    split = mi(TEST_FROM)
    # errors indexed by origin, so "what was known at month u" is a simple filter
    E = {m: {h: {x[0]: x[1] for x in err[m][h]} for h in (1, 2, 3)} for m in MODELS}

    def known(m, u, back):
        return [e for h in (1, 2, 3) for o, e in E[m][h].items() if u - back <= o and o + h <= u]

    def choose(u):
        """The model with the smallest error over the 36 months up to u."""
        sc = {m: float(np.mean(np.abs(k))) for m in MODELS if len(k := known(m, u, 36)) >= 60}
        return min(sc, key=sc.get) if sc else "seasonal"

    def band(m, h, u):
        e = [x for o, x in E[m][h].items() if u - 60 <= o and o + h <= u]
        return (float(np.quantile(e, 0.1)), float(np.quantile(e, 0.9))) if len(e) >= 24 else None
    pick = {o: choose(o) for o in E["seasonal"][1] if o >= split}

    def test(model):
        ape, pin, inside, byh = [], [], [], {1: [], 2: [], 3: []}
        for o in pick:
            m = pick[o] if model == "chosen" else model
            for h in (1, 2, 3):
                e = E[m][h].get(o)
                if e is None:
                    continue
                v = abs(1 - math.exp(-e))
                ape.append(v)
                byh[h].append(v)
                q = band(m, h, o)
                if q:
                    inside.append(q[0] <= e <= q[1])
                    pin.append(50 * (_pinball(0.1, e, q[0]) + _pinball(0.9, e, q[1])))
        return {"mape": _round(100 * float(np.mean(ape)), 1), "coverage80": _round(100 * float(np.mean(inside)), 0) if inside else None,
                "pinball": _round(float(np.mean(pin)), 2) if pin else None,
                "by_horizon": {str(h): _round(100 * float(np.mean(v)), 1) for h, v in byh.items() if v}}
    if not pick:
        return None
    t = n - 1
    best = choose(lo + t)
    path = []
    for h in (1, 2, 3):
        d = _predict(logp, wheat, diesel, t, h, _fit(logp, wheat, diesel, t, h, cache))[best]
        q = band(best, h, lo + t)
        path.append({"month": ms(lo + t + h), "mid": round(float(p[t] * math.exp(d)), 1),
                     "lo": round(float(p[t] * math.exp(d + min(q[0], 0))), 1) if q else None,
                     "hi": round(float(p[t] * math.exp(d + max(q[1], 0))), 1) if q else None})
    skill = [{"model": m, "used": m == best, **test(m)} for m in (*MODELS, "chosen")]
    return {"item": item, "latest": round(float(p[t]), 1), "month": ms(lo + t), "model": best, "path": path, "skill": skill,
            "test_from": TEST_FROM, "origins": len(pick), "y1_pct": _round(_pct(p[t], p[t - 12])), "m3_pct": _round(_pct(p[t], p[t - 3]))}


# --------------------------------------------------------------- back-test
EPISODES = [
    # id, label, kind, month the harm peaked or was recognised, window searched for a signal
    ("flood2022", "2022 floods (Sindh and Balochistan)", "wet", "2022-08", ("2022-06", "2022-09"), ("Sindh", "Balochistan")),
    ("infl2023", "2023 food-inflation peak (May 2023)", "market", "2023-05", ("2022-06", "2023-05"), None),
    ("wheat2024", "2024 wheat price fall (should stay quiet)", "quiet", "2024-05", ("2024-03", "2024-08"), None),
    ("flood2025", "2025 floods (Punjab)", "wet", "2025-08", ("2025-06", "2025-09"), ("Punjab",)),
    ("flour2025", "2025-26 flour price surge", "market", "2025-09", ("2025-06", "2026-03"), None),
    ("dry2026", "2026 weak monsoon (Sindh and Balochistan)", "dry", "2026-09", ("2026-07", "2026-10"), ("Sindh", "Balochistan")),
]


def backtest(px, store):
    """Replays the indicators month by month. Recomputed only when the data change."""
    key = f"{VERSION}|{px.last}|{store['updated']}"
    path = os.path.join(settings.MEDIA_ROOT, "foodsec", "backtest.json")
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if d.get("key") == key:
            return d
    except (OSError, ValueError):
        pass
    first = mi("2012-01")
    nat = {}
    for i in range(first, px.last + 1):
        m = market_indicators(px, i)
        s = {k: score(k, m.get(k)) for k in ("flour_m3", "spread", "kg_wage")}
        nat[i] = {"score": max([v for v in s.values() if v is not None] or [0]), "s": s, "z": m.get("flour_z"), "flour": m.get("flour")}
    # Skill of the market signal: does flour rise 10% or more within the next 3 months?
    lo, p = px.national(FLOUR)

    def surge(i):
        k = i - lo
        w = p[k + 1:k + 4]
        return bool(np.isfinite(w).any() and np.nanmax(w) >= 1.10 * p[k]) if k + 3 < len(p) else None

    def skill(pred):
        hit = miss = false = quiet = 0
        for i, r in nat.items():
            o = surge(i)
            if o is None:
                continue
            f = pred(r)
            hit += f and o
            miss += (not f) and o
            false += f and not o
            quiet += (not f) and not o
        n = hit + miss + false + quiet
        return {"months": n, "surges": hit + miss, "warned": hit + false, "hits": hit, "false_alarms": false, "missed": miss,
                "base_rate": round((hit + miss) / n, 2) if n else None, "precision": round(hit / (hit + false), 2) if hit + false else None,
                "recall": round(hit / (hit + miss), 2) if hit + miss else None}
    market = {"watch": skill(lambda r: r["score"] >= 1), "warning": skill(lambda r: r["score"] >= 2), "alert": skill(lambda r: r["score"] >= 3),
              "flour_m3_only": skill(lambda r: (r["s"]["flour_m3"] or 0) >= 2),
              "z_on_share": round(float(np.mean([r["z"] >= 1 for r in nat.values() if r["z"] is not None])), 2)}
    # Satellite side: share of districts dry (2+) or very wet per month, by province group.
    prov = [d["province"] for d in store["districts"]]
    end = min(store[v][0] + store[v][1].shape[1] - 1 for v in eo.VARS)
    sat = {}
    for i in range(mi("2012-01"), end + 1):
        r = eo.indicators(store, i)["districts"]
        dry, wet, watch = [], [], []
        for x in r:
            w = water_pillar(x, None, False)
            dry.append(bool(w and w["score"] >= 2 and w["conf"] != "Low"))
            watch.append(bool(w and w["score"] >= 1))
            wet.append(bool(x["spi1"] is not None and x["spi1"] >= 1.5))
        sat[i] = (dry, wet, watch)

    def share(i, k, provs):
        sel = [j for j, q in enumerate(prov) if q != OUTSIDE and (provs is None or q in provs)]
        return float(np.mean([sat[i][k][j] for j in sel]))
    calm = {k: round(float(np.mean([share(i, j, None) >= 0.2 for i in sat])), 2) for k, j in (("dry", 0), ("wet", 1))}
    rows = []
    for eid, label, kind, peak, (a, b), provs in EPISODES:
        first_at, best, mild = None, 0.0, 0.0
        for i in range(mi(a), min(mi(b), px.last if kind in ("market", "quiet") else end) + 1):
            if kind in ("market", "quiet"):
                v, on = nat[i]["score"], nat[i]["score"] >= 2
            else:
                v = share(i, 0 if kind == "dry" else 1, provs)
                on = v >= 0.25
                if kind == "dry":
                    mild = max(mild, share(i, 2, provs))
            best = max(best, v)
            if on and first_at is None:
                first_at = i
        lead = mi(peak) - first_at if first_at is not None else None
        # A month's value is only known after it ends (prices about 3 weeks, satellite about 4 weeks later).
        rows.append({"id": eid, "label": label, "kind": kind, "peak": peak, "first_signal": ms(first_at) if first_at is not None else None,
                     "known_lead_months": (lead - 1) if lead is not None else None, "strength": round(best, 2),
                     "watch_share": round(mild, 2) if kind == "dry" else None})
    d = {"key": key, "market": market, "episodes": rows, "months": len(nat), "from": "2012-01", "to": ms(px.last), "wide_signal_share": calm}
    _atomic(path, d)
    return d


# -------------------------------------------------------------- data gates
CROSS = [  # published figures for the same quantity, used as an independent check
    {"what": "Wheat flour, September 2026 (Rs per kg)", "other": 2688 / 20, "other_name": "PBS weekly prices, quoted by FEWS NET", "ref": "fewsOct", "month": "2026-09", "item": FLOUR},
    {"what": "Wheat flour, change on a year earlier, October 2026 (%)", "other": 34.27, "other_name": "PBS consumer prices, quoted by Khaleej Times", "ref": "khaleej", "month": "2026-10", "item": FLOUR, "yoy": True},
]


def quality(docs, px, today, fews):
    out = []

    def add(kind, text, action):
        out.append({"kind": kind, "text": text, "action": action})
    d = docs.get("ipc")
    if d:
        for a in d["data"][:2]:
            for per in ("current", "projected"):
                t = a["totals"].get(per)
                if t:
                    s = sum(x[per]["p3plus"] for x in a["areas"] if x.get(per))
                    if abs(s - t["p3plus"]) > 0.005 * t["p3plus"]:
                        add("sum", f"IPC {a['title']} ({per}): districts add up to {s:,}, the stated total is {t['p3plus']:,}.", "Both shown")
    if px:
        for c, u in (docs["wfp"]["data"].get("units") or {}).items():
            if len(u) > 1:
                add("unit", f"{c}: prices arrive in several units ({', '.join(u)}).", "Held back")
        col = {k: px.wage_still_since(i, px.last) for i, k in enumerate(px.markets)}
        still = [k for k, v in col.items() if v is not None and v >= 12]
        if still:
            add("stale", f"The daily wage reported for {', '.join(still)} has not changed for a year or more.", "Wage results for these cities marked low confidence")
        w = [(k, px.at(WAGE, px.last, [i])) for i, k in enumerate(px.markets)]
        w = [(k, v) for k, v in w if np.isfinite(v)]
        med = statistics.median(v for _, v in w) if w else None
        for k, v in w:
            if med and abs(v / med - 1) > 0.25:
                add("outlier", f"{k}: daily wage Rs {v:,.0f}, against Rs {med:,.0f} in the middle market.", "Shown by city, not used alone for a level")
        for x in CROSS:
            j = mi(x["month"])
            mine = px.at(x["item"], j)
            mine = _pct(mine, px.at(x["item"], j - 12)) if x.get("yoy") else mine
            if np.isfinite(mine):
                gap = mine - x["other"] if x.get("yoy") else _pct(mine, x["other"])
                x2 = {"kind": "cross", "ok": abs(gap) <= 10, "text": f"{x['what']}: WFP five-city mean {mine:.1f}; {x['other_name']} {x['other']:.1f}.",
                      "action": "Agree within 10" + (" points" if x.get("yoy") else "%") if abs(gap) <= 10 else "Different city sets; both shown"}
                out.append(x2)
    if d and fs.SOURCES and not fs.fresh("ipc", d, today):
        add("expired", f"The IPC projections ended on {d['period_end']}. No newer IPC analysis of Pakistan is published.", "Shown as the last official count; not used for today's level")
    for sid, (_, name, *_rest) in fs.SOURCES.items():
        if not docs.get(sid):
            add("missing", f"{name}: not obtained.", "Left out and listed as a gap")
        elif not docs[sid].get("ok", True):
            add("failed", f"{name}: the last download failed; the previous copy is used.", "Retry in 2 hours")
    return out


# ------------------------------------------------------------ actions, calendar
OWNERS = {"Normal": "NCOP analysts", "Watch": "NCOP, PDMAs", "Warning": "PDMAs, provincial food departments, BISP, WFP, UNICEF, FAO",
          "Alert": "NDMA/NEOC, provincial governments, partners"}
MATRIX = [
    {"level": "Normal", "lead": "Routine", "actions": "Monthly monitoring.", "owners": OWNERS["Normal"]},
    {"level": "Watch", "lead": "8 to 12 weeks", "actions": "Check the data, brief provincial food and agriculture departments, update scenarios.", "owners": OWNERS["Watch"]},
    {"level": "Warning", "lead": "4 to 8 weeks", "actions": "Joint field check; ready food stocks and cash plans; act on prices and markets; screen children for malnutrition.", "owners": OWNERS["Warning"]},
    {"level": "Alert", "lead": "0 to 4 weeks", "actions": "Release public stocks; scale up cash or food aid; emergency nutrition response; watch daily.", "owners": OWNERS["Alert"]},
]


def actions(doc):
    """Three priority actions drawn from what is actually driving the levels."""
    nat, rows = doc["national"], doc["districts"]
    out = []
    hot = [r for r in rows if r["level"] == 3] or [r for r in rows if r["level"] == 2]
    lv = LEVELS[max((r["level"] for r in rows), default=0)]
    per = {p: sum(1 for r in hot if r["province"] == p) for p in {r["province"] for r in hot}}
    top = [f"{p} ({per[p]})" for p in sorted(per, key=lambda p: -per[p])[:3]]
    if hot:
        out.append({"title": f"Check the {len(hot)} {lv}-level districts on the ground",
                    "text": f"In {_and(top)}. Confirm hunger, prices and stocks with district officials before money or food moves.",
                    "owner": "PDMAs with provincial food departments, WFP and FAO", "by": "within 2 weeks"})
    if nat["why"].get("market"):
        worst = max(doc["market_scores"].items(), key=lambda kv: (kv[1] or {}).get("score", 0))
        out.append({"title": "Act on flour prices and the cash that buys flour",
                    "text": f"Price pressure is highest in {worst[0]}. Review wheat release prices and volumes and import arrivals, and check that BISP payments still cover basic food.",
                    "owner": "Provincial food departments, Ministry of National Food Security, BISP", "by": "before January, the lean season"})
    if nat["why"].get("hunger"):
        n = [r for r in rows if (r["fews"][1] or 0) >= 3]
        out.append({"title": f"Prepare food, cash and nutrition support for {len(n)} districts expected in Crisis",
                    "text": "FEWS NET expects the greatest need from January to March 2027. Place stocks before snow closes mountain roads and start child-nutrition screening.",
                    "owner": "NDMA, PDMAs, BISP, WFP, UNICEF", "by": "before mid-December"})
    if doc["water"]["canal_pct"] is not None:
        out.append({"title": "Protect the wheat crop from the canal-water shortage",
                    "text": f"Canal water for {_and(doc['water']['canal_provinces'])} is planned {abs(doc['water']['canal_pct'])}% below normal. Publish rotation plans early and favour wheat at its water-critical stages.",
                    "owner": "IRSA, provincial irrigation and agriculture departments", "by": "now to March"})
    return out[:4]


def _and(x):
    x = list(x)
    return x[0] if len(x) == 1 else ", ".join(x[:-1]) + " and " + x[-1] if x else ""


CALENDAR = [
    ((6, 7, 8, 9), "June to September", "Monsoon floods, heat, water stress for summer crops", "Monsoon outlook, river flow forecasts, reservoir levels"),
    ((10, 11, 12), "October to December", "Wheat sowing; poor families run down their stocks", "Area sown, fertiliser and diesel prices, canal water, import arrivals"),
    ((1, 2, 3), "January to March", "Lean season: families who buy their food are hit hardest", "Flour prices, hunger surveys, cash coverage"),
    ((3, 4, 5), "March to May", "Grain filling and harvest; heat waves", "Hot days, crop greenness, purchase price and volume"),
]


def calendar(today):
    rows = [{"window": w, "risk": r, "watch": x, "now": today.month in m} for m, w, r, x in CALENDAR]
    rows.append({"window": "Ramadan (about 8 February 2027, moon-sighting)", "risk": "More demand for flour, oil, pulses and dates",
                 "watch": "Weekly prices", "now": False})
    return rows


# ---------------------------------------------------- issue log / revisions
def _atomic(path, doc):
    tmp = f"{path}.{uuid.uuid4().hex[:6]}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        logger.warning("foodsec: %s not written", path, exc_info=True)


def _changes(rows, px):
    up = [r["name"] for r in rows if r["level"] > r["prev_level"]]
    dn = [r["name"] for r in rows if r["level"] < r["prev_level"]]
    f = px.national(FLOUR)[1] if px else []
    return {"raised": up[:15], "raised_n": len(up), "lowered": dn[:15], "lowered_n": len(dn), "held_n": sum(1 for r in rows if r["held"]),
            "flour_m1_pct": _round(_pct(f[-1], f[-2])) if len(f) > 1 else None}


def log_issue(out):
    """Freeze the key results once per set of input periods; a different result for the
    same periods is recorded as a revision, so nothing changes silently."""
    path = os.path.join(settings.MEDIA_ROOT, "foodsec", "issues.json")
    try:
        with open(path, encoding="utf-8") as f:
            log = json.load(f)
    except (OSError, ValueError):
        log = []
    periods = json.dumps(out["periods"], sort_keys=True) + "|" + VERSION
    n = out["national"]
    key = {"count": n["count"], "people": n["people"], "level": n["level"],
           "flour": (out["market"].get("Pakistan") or {}).get("flour"), "kg": (out["market"].get("Pakistan") or {}).get("kg"),
           "price_next": (out["price_outlook"] or {}).get("path"), "levels": "".join(str(r["level"]) for r in out["districts"])}
    sig = hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:12]
    last = log[-1] if log else None
    now = datetime.now(timezone.utc).isoformat()
    if not last or last["periods"] != periods:
        log.append({"issue": (last["issue"] + 1) if last else 1, "at": now, "periods": periods, "sig": sig, "key": key, "revisions": []})
    elif last["sig"] != sig and not any(r["sig"] == sig for r in last["revisions"]):
        last["revisions"].append({"at": now, "sig": sig, "key": key})
    else:
        return _issue_view(log)
    log = log[-36:]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _atomic(path, log)
    return _issue_view(log)


def _issue_view(log):
    last, prev = log[-1], (log[-2] if len(log) > 1 else None)
    return {"number": last["issue"], "first_at": last["at"], "revisions": len(last["revisions"]), "id": last["sig"],
            "previous": {"at": prev["at"], "count": prev["key"]["count"], "people": prev["key"]["people"], "flour": prev["key"]["flour"]} if prev else None}
