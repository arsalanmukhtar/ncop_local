# project/ncop_internal/foodsec_sources.py
# ---------------------------------------------------------------------------
# Open-data adapters for the Food Security early-warning layer (foodsec_ews).
#
# One small function per source: it downloads, keeps only the few Pakistan
# numbers that are used, and returns them with the period they describe.
# get() stores that compact result in media/foodsec/sources/<id>.json with
# provenance (url, licence, retrieval time, checksum, period) and re-downloads
# only when the source's own refresh interval has passed and, where the
# publisher states a last-modified time, only when that has changed. A failed
# download keeps the last good copy and is reported as failed.
#
# Nothing here runs in a request: foodsec_watch.build() calls fetch_all() in
# its background thread (small thread pool; about 1 MB kept on disk).
#
# NEWS_REGISTER holds the few facts that are only published as text
# (water-board decisions, border status ...). Each has a source, an as-of date
# and an expiry date, after which it is shown as out of date.
# ---------------------------------------------------------------------------

import csv
import hashlib
import io
import json
import logging
import os
import re
import tempfile
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

UA = {"User-Agent": "Mozilla/5.0 (compatible; open-data-client/1.0)", "Accept": "*/*"}
HDX = "https://data.humdata.org/api/3/action/package_show?id="
MAX_BYTES = 16 * 1024 * 1024
WFP_FROM = 2004


class Unchanged(Exception):
    """The publisher's last-modified stamp equals the stored one."""


def _get(url, timeout=60, tries=3, stream=False):
    for k in range(tries):
        try:
            r = requests.get(url, headers=UA, timeout=timeout, stream=stream)
            if r.status_code in (429, 500, 502, 503, 504) and k + 1 < tries:
                r.close()
                time.sleep(3 * (k + 1))
                continue
            r.raise_for_status()
            if r.status_code != 200:            # HDX answers 202 with an empty body when it throttles a client
                raise ValueError(f"HTTP {r.status_code}")
            return r
        except (requests.ConnectionError, requests.Timeout):
            if k + 1 == tries:
                raise
            time.sleep(3 * (k + 1))


def _download(url, timeout=120):
    """(temporary file, checksum). Size-capped; spills to disk beyond 2 MB."""
    f = tempfile.SpooledTemporaryFile(max_size=2 * 1024 * 1024)
    h, n = hashlib.sha256(), 0
    with _get(url, timeout=timeout, stream=True) as r:
        for chunk in r.iter_content(256 * 1024):
            n += len(chunk)
            if n > MAX_BYTES:
                raise ValueError(f"{url}: larger than {MAX_BYTES} bytes")
            h.update(chunk)
            f.write(chunk)
    if not n:
        raise ValueError(f"{url}: empty body")
    f.seek(0)
    return f, h.hexdigest()[:16]


def _f(v):
    try:
        x = float(v)
        return x if x == x else None
    except (TypeError, ValueError):
        return None


_packages = {}                    # package listings of this run, so a package is asked for once
_hdx_lock = threading.Lock()      # one HDX request at a time


def _hdx(package, match, prev):
    """(text reader, checksum, last_modified) for the first matching resource."""
    with _hdx_lock:
        at, pk = _packages.get(package, (0, None))
        if time.time() - at > 600:
            pk = _get(HDX + package).json()["result"]
            _packages[package] = (time.time(), pk)
        res = next(r for r in pk["resources"] if match(r))
        mod = res.get("last_modified") or pk.get("last_modified")
        if prev and prev.get("upstream_modified") == mod:
            raise Unchanged()
        f, sha = _download(res["url"])
    return io.TextIOWrapper(f, encoding="utf-8-sig", errors="replace", newline=""), sha, mod


# ------------------------------------------------------------------ adapters
# fn(prev) -> {"data", "period", "period_end" (iso date), "sha"?, "upstream_modified"?}
def parse_ipc(j):
    def d(s):
        return (s or "")[:10] or None

    def tot(t):
        return {"pop": t["analyzedPopulation"], "p3plus": t["phase3PlusPopulation"], "p3": t["phase3Population"],
                "p4": t["phase4Population"], "p5": t["phase5Population"],
                "p3plus_pct": t["phase3PlusPercentage"]} if t else None
    out = []
    for a in sorted(j["data"], key=lambda a: a["analysis_date"], reverse=True):
        per = {"current" if p["period_code"] == "current" else "projected": {"from": d(p["from_date"]), "to": d(p["thru_date"])}
               for p in a["periods"] if p["period_code"] in ("current", "projected-1")}
        totals = {"current" if k == "current" else "projected": tot(v) for k, v in a["totals"].items() if k in ("current", "projected-1")}
        groups, areas = [], []
        for g in a["groups"] or []:
            gt = a.get("groupTotals", {}).get(g["group_id"], {})
            name = re.sub(r"\bfinal\b", "", g["group_name"], flags=re.I).strip().title().replace("Pakhtunkhawa", "Pakhtunkhwa")
            if g["areas"]:
                groups.append({"name": name, "areas": len(g["areas"]),
                               "current": tot(gt.get("current")), "projected": tot(gt.get("projected-1"))})
            areas += [(x, name) for x in g["areas"]]
        areas += [(x, "") for x in a.get("areas") or []]
        rows = []
        for x, g in areas:
            row = {"name": x["area"], "group": g}
            for code, key in (("current", "current"), ("projected-1", "projected")):
                p = (x.get("periods") or {}).get(code)
                if p and p.get("estimated_population"):
                    pop = int(float(p["estimated_population"]))
                    row[key] = {"pop": pop, "phase": p["overall_phase_value"], "p3plus": p["phase3_plus_population"],
                                "p3plus_pct": p["phase3_plus_percentage"], "p4": p["phase4_population"],
                                "p4_pct": p["phase4_percentage"]}
            rows.append(row)
        out.append({"id": a["anl_id"], "title": a["title"], "date": d(a["analysis_date"]), "url": a.get("public_map_link"),
                    "country_population": a.get("country_population"), "periods": per, "totals": totals, "groups": groups, "areas": rows})
    return out


def _ipc(prev):
    y = date.today().year
    r = _get(f"https://gsu-prod.ipc.codes/api/ptt/data-with-meta/{y - 10},{y + 1}?country=PK&limit=100", timeout=90)
    out = parse_ipc(r.json())
    ends = [p["to"] for a in out[:2] for p in a["periods"].values()]
    return {"data": out, "period": out[0]["date"], "period_end": max(ends), "sha": hashlib.sha256(r.content).hexdigest()[:16]}


def _fews(prev):
    """FEWS NET area classification (IPC-compatible), latest two full rounds."""
    start = (date.today() - timedelta(days=200)).replace(day=1).isoformat()
    url = f"https://fdw.fews.net/api/ipcphase.json?country_code=PK&start_date={start}&page_size=100"
    rows, n = [], 0
    while url and n < 1000:                     # anonymous paging stops at 1000 rows
        j = _get(url, timeout=90).json()
        n += len(j["results"])
        rows += [r for r in j["results"] if r["unit_type"] == "fsc_admin" and r["value"] is not None]
        url = j["next"]
    out = parse_fews(rows)
    cur = out["current"]["periods"]
    return {"data": out, "period": out["current"]["round"], "period_end": (cur.get("next") or cur["now"])[1]}


def parse_fews(rows):
    by = {}
    for r in rows:
        by.setdefault(r["reporting_date"], []).append(r)
    full = [d for d in sorted(by) if len({r["geographic_unit_name"] for r in by[d]}) >= 120][-2:]
    if not full:
        raise ValueError("FEWS NET: no complete round")

    def pack(d, keep):
        units, periods = {}, {}
        for r in by[d]:
            s = r["scenario_name"].strip()
            s = "now" if s.startswith("Current") else "next" if s.startswith("Near") else "later"
            name, prov = (r["geographic_unit_full_name"].split(", ") + [""])[:2]
            if s in keep:
                units.setdefault((name, prov), {})[s] = int(r["value"])
                periods[s] = [r["projection_start"], r["projection_end"]]
        return {"round": d, "periods": periods, "units": [{"name": k[0], "province": k[1], **v} for k, v in sorted(units.items())]}
    return {"current": pack(full[-1], ("now", "next", "later")),
            "previous": pack(full[0], ("now", "next")) if len(full) > 1 else None}


def _wfp(prev):
    """WFP retail prices: {commodity: {"YYYY-MM": {market: price}}}, units, markets."""
    from .foodsec_watch import PRICE_ITEMS
    tr, sha, mod = _hdx("wfp-food-prices-for-pakistan", lambda r: "Food Prices" in r.get("name", ""), prev)
    out = parse_wfp(tr, PRICE_ITEMS)
    last = max(m for c in out["prices"].values() for m in c)
    return {"data": out, "period": last, "period_end": f"{last}-28", "sha": sha, "upstream_modified": mod}


def parse_wfp(lines, keep):
    keep = set(keep)
    data, markets, units, flags = {}, {}, {}, {}
    for r in csv.DictReader(lines):
        if r.get("pricetype") != "Retail" or r.get("commodity") not in keep or not (r.get("date") or "")[:4].isdigit():
            continue
        p = _f(r["price"])
        if p is None or p <= 0 or int(r["date"][:4]) < WFP_FROM:
            continue
        data.setdefault(r["commodity"], {}).setdefault(r["date"][:7], {})[r["market"]] = round(p, 2)
        units.setdefault(r["commodity"], set()).add(r["unit"])
        flags[r.get("priceflag", "")] = flags.get(r.get("priceflag", ""), 0) + 1
        markets[r["market"]] = {"market": r["market"], "province": r["admin1"].title(), "lon": _f(r["longitude"]), "lat": _f(r["latitude"])}
    return {"prices": data, "markets": markets, "units": {k: sorted(v) for k, v in units.items()}, "flags": flags}


def _psd(prev):
    """USDA PSD: wheat, rice, maize balance (marketing years, thousand tonnes)."""
    f, sha = _download("https://apps.fas.usda.gov/psdonline/downloads/psd_grains_pulses_csv.zip", timeout=240)
    want = {"Wheat": "wheat", "Rice, Milled": "rice", "Corn": "maize"}
    attr = {"Production": "production", "Imports": "imports", "Exports": "exports", "Ending Stocks": "end_stocks",
            "Beginning Stocks": "begin_stocks", "Domestic Consumption": "use", "Area Harvested": "area_kha"}
    out, rel = {}, ""
    with zipfile.ZipFile(f) as z, z.open(z.namelist()[0]) as fh:
        for r in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace")):
            if r["Country_Name"] != "Pakistan":
                continue
            c, a = want.get(r["Commodity_Description"].strip()), attr.get(r["Attribute_Description"].strip())
            if c and a and int(r["Market_Year"]) >= 2005:
                out.setdefault(c, {}).setdefault(int(r["Market_Year"]), {})[a] = _f(r["Value"])
                if a == "production":
                    rel = max(rel, f"{r['Calendar_Year']}-{max(int(r['Month']), 1):02d}")
    if not out.get("wheat"):
        raise ValueError("PSD: no Pakistan wheat rows")
    data = {c: [{"marketing_year": y, **v} for y, v in sorted(d.items())] for c, d in out.items()}
    return {"data": data, "period": rel, "period_end": f"{rel}-28", "sha": sha}


def _enso(prev):
    """NOAA CPC Oceanic Nino Index (3-month) and weekly Nino3.4 anomaly."""
    oni = []
    for line in _get("https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt").text.splitlines()[1:]:
        p = line.split()
        if len(p) == 4:
            oni.append({"season": p[0], "year": int(p[1]), "oni": float(p[3])})
    wk = _get("https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for").text.strip().splitlines()[-1]
    wd, anom = parse_weekly_sst(wk)
    return {"data": {"oni": oni[-36:], "weekly": {"date": wd.isoformat(), "nino34_anom": anom}},
            "period": f"{oni[-1]['season']} {oni[-1]['year']}", "period_end": wd.isoformat()}


def parse_weekly_sst(line):
    """(date, Nino3.4 anomaly) from one fixed-width row: sst/anomaly pairs for Nino 1+2, 3, 3.4, 4."""
    m = re.match(r"\s*(\d{2}[A-Z]{3}\d{4})\s*(.*)", line)
    nums = re.findall(r"-?\d+\.\d", m.group(2))
    return datetime.strptime(m.group(1).title(), "%d%b%Y").date(), float(nums[5])


def _pink(prev):
    """World Bank Pink Sheet: world prices that feed Pakistan's food costs."""
    import openpyxl
    page = _get("https://www.worldbank.org/en/research/commodity-markets").text
    url = re.search(r"https://thedocs\.worldbank\.org/[^\"'\s]+CMO-Historical-Data-Monthly\.xlsx", page).group(0)
    f, sha = _download(url, timeout=120)
    want = {"wheat, us hrw": "wheat_hrw", "palm oil": "palm_oil", "dap": "dap", "urea": "urea", "rice, thai 5%": "rice_thai5"}
    cols, out = None, {}
    wb = openpyxl.load_workbook(f, read_only=True, data_only=True)
    try:
        for row in wb["Monthly Prices"].iter_rows(values_only=True):
            if cols is None:
                names = [str(c or "").replace("*", "").strip().lower() for c in row]
                if "palm oil" in names:
                    cols = {v: names.index(k) for k, v in want.items() if k in names}
                continue
            m = re.match(r"(\d{4})M(\d{2})$", str(row[0] or ""))
            if m and int(m.group(1)) >= 2015:
                for k, i in cols.items():
                    if _f(row[i]) is not None:
                        out.setdefault(k, {})[f"{m.group(1)}-{m.group(2)}"] = round(float(row[i]), 1)
    finally:
        wb.close()
    if "palm_oil" not in out:
        raise ValueError("Pink Sheet: layout changed")
    last = max(out["palm_oil"])
    return {"data": out, "period": last, "period_end": f"{last}-28", "sha": sha}


def _fx(prev):
    j = _get("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json").json()
    return {"data": {"pkr_per_usd": round(float(j["usd"]["pkr"]), 2)}, "period": j["date"], "period_end": j["date"]}


def _idmc(prev):
    """IDMC internal-displacement updates: recommended figures, last 24 months."""
    tr, sha, mod = _hdx("pak-idmc-idu-events", lambda r: r["format"].upper() == "CSV", prev)
    since = (date.today() - timedelta(days=730)).isoformat()
    ev, last = [], ""
    for r in csv.DictReader(tr):
        when = (r.get("displacement_date") or "")[:10]
        if not (r.get("role") or "").startswith("Recommended") or not when[:4].isdigit():
            continue
        last = max(last, when)
        if when >= since and _f(r["figure"]):
            ev.append({"date": when, "n": int(float(r["figure"])), "kind": r["displacement_type"],
                       "type": r.get("type") or r.get("category"), "lat": _f(r["latitude"]), "lon": _f(r["longitude"]),
                       "place": (r.get("locations_name") or "")[:60], "accuracy": (r.get("locations_accuracy") or "")[:40]})
    return {"data": {"events": ev}, "period": last, "period_end": last, "sha": sha, "upstream_modified": mod}


def _hapi(word):
    return lambda r: word in r["name"].lower() and r["format"].upper() == "CSV"


def _conflict(prev):
    """ACLED monthly national totals as published on HDX by HAPI."""
    tr, sha, mod = _hdx("hdx-hapi-pak", _hapi("conflict"), prev)
    m, through = {}, ""
    for r in csv.DictReader(tr):
        if r.get("admin_level") == "0" and r["event_type"] == "political_violence":
            m[r["reference_period_start"][:7]] = {"events": int(_f(r["events"]) or 0), "fatalities": int(_f(r["fatalities"]) or 0)}
            through = max(through, r["reference_period_end"][:10])
    if not m:
        raise ValueError("HAPI conflict: no national rows")
    # The newest month is incomplete until it has ended.
    full = [k for k in m if k < date.today().strftime("%Y-%m")]
    last = max(full)
    return {"data": {"months": {k: m[k] for k in sorted(full)[-36:]}}, "period": last, "period_end": f"{last}-28",
            "sha": sha, "upstream_modified": mod}


def _presence(prev):
    """OCHA 3W: organisations working on food security / nutrition per district."""
    tr, sha, mod = _hdx("hdx-hapi-pak", _hapi("presence"), prev)
    d, end = {}, ""
    for r in csv.DictReader(tr):
        if r["sector_code"] in ("FSC", "NUT") and (r.get("admin2_name") or r.get("provider_admin2_name")):
            k = (r["admin2_name"] or r["provider_admin2_name"], r["admin1_name"])
            d.setdefault(k, {}).setdefault(r["sector_code"], set()).add(r["org_acronym"] or r["org_name"])
            end = max(end, r["reference_period_end"][:10])
    return {"data": {"districts": [{"name": k[0], "province": k[1], "food": len(v.get("FSC", ())), "nutrition": len(v.get("NUT", ()))}
                                   for k, v in sorted(d.items())]},
            "period": end, "period_end": end, "sha": sha, "upstream_modified": mod}


def _poverty(prev):
    tr, sha, mod = _hdx("hdx-hapi-pak", _hapi("poverty rate"), prev)
    p = {}
    for r in csv.DictReader(tr):
        k = "Pakistan" if r["admin_level"] == "0" else r["admin1_name"]      # admin1 rows without a code are former FATA
        if k:
            if r["reference_period_end"] >= p.get(k, {}).get("end", ""):
                p[k] = {"mpi_poor_pct": _f(r["headcount_ratio"]), "end": r["reference_period_end"][:10]}
    end = max(v["end"] for v in p.values())
    return {"data": p, "period": end[:4], "period_end": end, "sha": sha, "upstream_modified": mod}


def _diet(prev):
    """World Bank / FAO: cost and affordability of a healthy diet."""
    j = _get("https://api.worldbank.org/v2/sources/88/country/PAK/series/CoHD_headcount;CoHD_LCU;CoHD_unafford_n/"
             "classification/all/time/all?format=json&per_page=200").json()
    names = {"CoHD_headcount": "cannot_afford_pct", "CoHD_LCU": "cost_pkr_day", "CoHD_unafford_n": "cannot_afford_m"}
    out = {}
    for x in j["source"]["data"]:
        v = {a["concept"]: a["id"] for a in x["variable"]}
        if x["value"] is not None:
            out.setdefault(v["Time"][2:], {})[names[v["Series"]]] = x["value"]
    last = max(out)
    return {"data": out, "period": last, "period_end": f"{last}-12-31"}


def _undernourished(prev):
    j = _get("https://api.worldbank.org/v2/country/PAK/indicator/SN.ITK.DEFC.ZS?format=json&per_page=30").json()[1]
    s = {x["date"]: x["value"] for x in j if x["value"] is not None}
    return {"data": s, "period": max(s), "period_end": f"{max(s)}-12-31"}


def _reservoirs(prev):
    """Tarbela / Mangla level today, from the Flood Forecasting Division feed NCOP already uses."""
    j = _get("http://172.18.7.21:8000/get-ffd-waterlevels/", timeout=25, tries=2).json()
    lims = {"Tarbela": (1402.0, 1550.0), "Mangla": (1050.0, 1242.0)}     # dead and maximum conservation level, ft
    out, when = {}, ""
    for ft in j["features"]:
        p = ft["properties"]
        for k, (lo, hi) in lims.items():
            if str(p.get("name", "")).startswith(k):
                m = re.search(r"\d+(\.\d+)?", str(p.get("level") or "").replace(",", ""))
                if m and lo - 60 <= float(m.group()) <= hi + 10:
                    out[k] = {"level_ft": float(m.group()), "dead_ft": lo, "max_ft": hi}
                    when = p.get("recording_time") or when
    if not out:
        raise ValueError("FFD feed: no reservoir levels")
    today = date.today().isoformat()
    hist = dict(((prev or {}).get("data") or {}).get("history") or {})    # one row a day, builds its own baseline
    hist[today] = {k: v["level_ft"] for k, v in out.items()}
    return {"data": {"now": out, "recorded": when, "history": dict(sorted(hist.items())[-800:])}, "period": today, "period_end": today}


SOURCES = {
    # id: (adapter, name, page, licence, refresh hours, days after the period before it is stale, value type)
    "ipc": (_ipc, "IPC: acute food insecurity analyses", "https://www.ipcinfo.org", "IPC terms of use", 24, 0, "Modelled"),
    "fews": (_fews, "FEWS NET: area classification", "https://fews.net/asia/pakistan", "Public", 24, 0, "Modelled"),
    "wfp": (_wfp, "WFP: retail food prices and wages", "https://data.humdata.org/dataset/wfp-food-prices-for-pakistan", "CC BY-IGO", 12, 60, "Observed"),
    "psd": (_psd, "USDA: grain supply and stocks", "https://apps.fas.usda.gov/psdonline", "US public domain", 168, 75, "Modelled"),
    "enso": (_enso, "NOAA: El Niño indices", "https://www.cpc.ncep.noaa.gov", "US public domain", 24, 21, "Observed"),
    "pink": (_pink, "World Bank: world commodity prices", "https://www.worldbank.org/en/research/commodity-markets", "CC BY 4.0", 168, 60, "Observed"),
    "fx": (_fx, "Currency feed: rupees per US dollar", "https://github.com/fawazahmed0/exchange-api", "CC0", 24, 7, "Observed"),
    "idmc": (_idmc, "IDMC: internal displacement", "https://data.humdata.org/dataset/pak-idmc-idu-events", "CC BY-IGO", 24, 90, "Modelled"),
    "conflict": (_conflict, "ACLED (via HDX): conflict events", "https://data.humdata.org/dataset/hdx-hapi-pak", "ACLED terms", 24, 60, "Observed"),
    "presence": (_presence, "OCHA 3W (via HDX): partner presence", "https://data.humdata.org/dataset/hdx-hapi-pak", "CC BY-IGO", 168, 365, "Observed"),
    "poverty": (_poverty, "OPHI (via HDX): multidimensional poverty", "https://data.humdata.org/dataset/hdx-hapi-pak", "CC BY-SA", 720, 1095, "Survey"),
    "diet": (_diet, "World Bank / FAO: cost of a healthy diet", "https://www.worldbank.org/en/programs/icp/brief/foodpricesfornutrition", "CC BY 4.0", 720, 550, "Modelled"),
    "undernourished": (_undernourished, "FAO (via World Bank): undernourishment", "https://data.worldbank.org/indicator/SN.ITK.DEFC.ZS", "CC BY 4.0", 720, 900, "Modelled"),
    "reservoirs": (_reservoirs, "PMD Flood Forecasting Division: reservoir levels", "https://ffd.pmd.gov.pk", "Government of Pakistan", 12, 3, "Observed"),
}


# Facts published only as text. Update by hand; each expires by itself.
NEWS_REGISTER = [
    {"id": "monsoon2026", "topic": "Weather", "as_of": "2026-09-30", "expires": "2027-06-30", "type": "Observed", "ref": "nationMonsoon",
     "text": "The 2026 monsoon gave 19% less rain than normal nationally. Sindh was 51% below normal and Balochistan 34% below; Punjab was close to normal (4% below)."},
    {"id": "irsa2026", "topic": "Irrigation water", "as_of": "2026-10-07", "expires": "2027-03-31", "type": "Forecast", "ref": "dawnIrsa",
     "severity": 2, "value_pct": -22, "provinces": ["Punjab", "Sindh"],
     "text": "The water regulator (IRSA) planned for 22% less canal water than usual for Punjab and Sindh this winter-crop season; its first estimate was 26%."},
    {"id": "border2026", "topic": "Trade route", "as_of": "2026-10-31", "expires": "2027-05-31", "type": "Observed", "ref": "fewsOct",
     "provinces": ["Khyber Pakhtunkhwa", "Balochistan"],
     "text": "The Afghan border has been closed to trade since October 2025, and FEWS NET expects this to continue through May 2027. It cuts work and income in border districts."},
    {"id": "imports2026", "topic": "Supply", "as_of": "2026-11-20", "expires": "2027-02-28", "type": "Observed", "ref": "khaleej",
     "text": "Wheat imports have restarted (about 51,000 tonnes reached Karachi in late October) and Sindh cut its official wheat release price from Rs5,000 to Rs4,500 per 40 kg on 4 November."},
    {"id": "fertiliser2026", "topic": "Farm costs", "as_of": "2026-11-20", "expires": "2027-02-28", "type": "Observed", "ref": "khaleej",
     "text": "DAP fertiliser rose from Rs14,009 to Rs17,183 a bag (50 kg), 23% more, at wheat-sowing time."},
    {"id": "harvest2026", "topic": "Harvest", "as_of": "2026-10-31", "expires": "2027-04-30", "type": "Modelled", "ref": ["fca", "psd", "dawnIrsa", "cereal"],
     "text": "Estimates of the last wheat harvest disagree: Federal Committee on Agriculture 29.3 million tonnes, USDA 29.0, Dawn (October) around 27.5, flour-trade estimate about 26. Dawn puts the need at 31.9."},
    {"id": "needs2026", "topic": "People in need", "as_of": "2026-10-31", "expires": "2027-03-31", "type": "Forecast", "ref": "fewsOct",
     "text": "FEWS NET expects 18 to 19 million people to need food help at the peak, January to March 2027."},
    {"id": "winter2026", "topic": "Weather outlook", "as_of": "2026-10-31", "expires": "2027-04-30", "type": "Forecast", "ref": "fewsOct",
     "text": "Winter rain is forecast average to above average (above average in KP and Gilgit-Baltistan in December and January), which would help rain-fed wheat."},
    {"id": "malnutrition2026", "topic": "Nutrition", "as_of": "2026-04-20", "expires": "2026-09-30", "type": "Modelled", "ref": "ipcAmn",
     "text": "About 2.7 million children under five in 45 districts were acutely malnourished or expected to be (October 2025 to September 2026), 706,000 of them severely."},
]


def register(today=None):
    t = (today or date.today()).isoformat()
    return [{**e, "state": "current" if t <= e["expires"] else "out of date"} for e in NEWS_REGISTER]


# --------------------------------------------------------------------- store
def _dir():
    p = os.path.join(settings.MEDIA_ROOT, "foodsec", "sources")
    os.makedirs(p, exist_ok=True)
    return p


def _read(sid):
    try:
        with open(os.path.join(_dir(), f"{sid}.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write(sid, doc):
    p = os.path.join(_dir(), f"{sid}.json")
    tmp = f"{p}.{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"))
    os.replace(tmp, p)


def _now():
    return datetime.now(timezone.utc)


def get(sid, force=False):
    """Compact document for one source, refreshed when due; None if never obtained."""
    fn, _, _, _, ttl, _, _ = SOURCES[sid]
    prev = _read(sid)
    if prev and not force:
        age_h = (_now() - datetime.fromisoformat(prev["checked_at"])).total_seconds() / 3600
        if age_h < (ttl if prev.get("ok", True) else min(ttl, 2)):
            return prev
    now = _now().isoformat()
    try:
        try:
            asked = {**prev, "upstream_modified": None} if prev and force else prev
            doc = {"id": sid, "retrieved_at": now, "checked_at": now, "ok": True, "error": None, **fn(asked)}
        except Unchanged:
            doc = {**prev, "checked_at": now, "ok": True, "error": None}
    except Exception as e:
        logger.warning("foodsec source %s failed: %s", sid, e)
        if not prev:
            return None
        doc = {**prev, "checked_at": now, "ok": False, "error": type(e).__name__}
    try:
        _write(sid, doc)
    except OSError:
        logger.warning("foodsec source %s: could not be stored", sid, exc_info=True)
    return doc


def fetch_all(force=False):
    with ThreadPoolExecutor(4) as ex:
        return dict(zip(SOURCES, ex.map(lambda s: get(s, force), SOURCES)))


def fresh(sid, doc, today=None):
    """Does this source still describe the present (period end + its grace days)?"""
    if not doc or not doc.get("period_end"):
        return False
    end = date.fromisoformat(doc["period_end"][:10])
    return ((today or date.today()) - end).days <= SOURCES[sid][5]


def health(docs, today=None):
    """Source-health rows for the report's data-freshness panel."""
    out = []
    for sid, (_, name, page, lic, _, _, kind) in SOURCES.items():
        d = docs.get(sid)
        state = ("missing" if not d else "failed" if not d.get("ok", True)
                 else "current" if fresh(sid, d, today) else "out of date")
        out.append({"id": sid, "name": name, "url": page, "licence": lic, "type": kind, "state": state,
                    "period": d.get("period") if d else None, "valid_to": d.get("period_end") if d else None,
                    "retrieved": d["retrieved_at"][:10] if d else None, "checksum": d.get("sha") if d else None})
    return out
