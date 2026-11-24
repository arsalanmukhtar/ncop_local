# project/ncop_internal/aqi_watch.py
# ---------------------------------------------------------------------------
# AQI part of the National Air Quality Watch digest (hawanama_client.
# air_quality_watch -> payload["aqi"]). Three kinds of AQI are built and kept
# strictly apart, because their inputs and averaging differ:
#   observed_daily  24-hour PM2.5 sub-index per station-day (Hawanama station
#                   daily means with >= 18 valid hours), summarised by city/day
#   now             EPA NowCast PM2.5 AQI per station (12 hourly readings)
#   forecast        24-hour PM2.5 AQI per city-day, from CAMS hourly PM2.5
#                   adjusted by the city's own stations (method below)
# plus modelled (never measured) sub-indices for the other five pollutants.
# All index arithmetic lives in aqi_engine.py.
#
# Only PM2.5 is measured by the ground stations available to NCOP inside
# Pakistan, so an observed "AQI" here is a PM2.5 sub-index and is labelled so.
#
# Forecast method (checked by `manage.py aqi_forecast_backtest`):
#   adj  = CAMS 24-h mean x r, r = exp(mean log(observed/CAMS)) over the last
#          7 days of that city, limited to 0.5-4 and needing 5 matched days
#   fc   = exp(w log(last observed day) + (1-w) log(adj)), w by lead below,
#          at most 1.5x the highest day observed in the last 7
# Raw CAMS reads the Punjab plain at a fraction of the station values (right
# category 24% of the time); this blend is right 71/65/61/61% for leads 1-4.
# ---------------------------------------------------------------------------

import hashlib
import json
import logging
import math
import os
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from django.conf import settings

from . import aqi_engine as ae

logger = logging.getLogger(__name__)

PKT = timezone(timedelta(hours=5))
# PM2.5 24-hour limits (concentrations, never AQI breakpoints): WHO AQG 2021;
# Pak-NEQS S.R.O. 1062(I)/2010, in force 1 January 2013.
WHO_24H, NEQS_24H = 15.0, 35.0
METROS = ("Lahore", "Karachi", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Quetta",
          "Gujranwala", "Hyderabad", "Sialkot", "Bahawalpur")
MAX_CITIES = 26               # cities given modelled pollutants and a forecast
TREND_STEP = 15               # AQI points between the first and last valid day
BULK_STATIONS = 25            # Hawanama limit per history request
BULK_WORKERS = 4
NOW_MAX_AGE_H = 3
QC_OK = {"ok", "raw", None, ""}

_CAMS_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
_CAMS_VARS = {"pm25": "pm2_5", "pm10": "pm10", "o3": "ozone", "no2": "nitrogen_dioxide",
              "so2": "sulphur_dioxide", "co": "carbon_monoxide"}
MODEL = {"name": "CAMS global atmospheric composition forecast via Open-Meteo", "resolution": "about 45 km (0.4°)",
         "attribution": "Copernicus Atmosphere Monitoring Service (CAMS) and Open-Meteo, CC BY 4.0"}

FC_RATIO_DAYS, FC_MIN_DAYS, FC_RATIO_CLIP = 7, 5, (0.5, 4.0)
# Forecasts up to 1.6x the last week's highest day were unbiased in the
# backtest (2,446 city-days); the few beyond it over-forecast by about 28%.
FC_MAX_STEP = 1.5
FC_PERSIST_WEIGHT = {1: 0.7, 2: 0.5, 3: 0.3, 4: 0.3}
# Backtest 18 Oct - 23 Nov 2026, 22 cities, 579-648 city-days per lead: share with
# the right category, share within one category, MAE (µg/m³), and the 10th/90th
# percentile of observed / forecast (the printed range).
FC_SKILL = {
    1: {"hit": 71, "within1": 99, "mae": 22.2, "q10": 0.74, "q90": 1.36},
    2: {"hit": 65, "within1": 98, "mae": 26.0, "q10": 0.71, "q90": 1.48},
    3: {"hit": 61, "within1": 99, "mae": 26.5, "q10": 0.73, "q90": 1.48},
    4: {"hit": 61, "within1": 98, "mae": 27.2, "q10": 0.72, "q90": 1.50},
}
FC_SKILL_NOTE = ("Backtest 18 Oct to 23 Nov 2026 over 22 cities (579 to 648 city-days per lead). It uses CAMS archive values, "
                 "which are closer to an analysis than to a true day-3 forecast, so real skill at longer leads may be lower.")

CONFIDENCE_RULES = {
    "high": "at least 3 stations with valid data on the latest day, valid data on at least 6 of 7 days, and the middle half of stations within 35% of the median",
    "medium": "at least 2 stations on the latest day and valid data on at least 4 of 7 days",
    "low": "anything less: a single station, few days, or no valid data on the latest day",
}
_SNAP_SUBDIR, _SNAP_KEEP = "aqi_snapshots", 60


def _median(v):
    return statistics.median(v) if v else None


def _pct(v, q):
    if not v:
        return None
    s = sorted(v)
    k = (len(s) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def _counts(values):
    out = {k: 0 for k in ae.CATEGORY_KEYS}
    for v in values:
        c = ae.category(v)
        if c:
            out[c] += 1
    return out


def _trend(series):
    """Direction between the first and last valid values of an AQI series."""
    v = [x for x in series if x is not None]
    if len(v) < 3:
        return "insufficient data"
    d = v[-1] - v[0]
    return "worsening" if d >= TREND_STEP else "improving" if d <= -TREND_STEP else "stable"


def confidence(n_latest, days_valid, n_days, spread):
    """Observation confidence by fixed rules (CONFIDENCE_RULES)."""
    need6, need4 = math.ceil(n_days * 6 / 7), math.ceil(n_days * 4 / 7)
    if n_latest >= 3 and days_valid >= need6 and spread is not None and spread <= 0.35:
        return "high"
    if n_latest >= 2 and days_valid >= need4:
        return "medium"
    return "low"


# ---------------------------------------------------------------------------
# Observed, 24-hour
# ---------------------------------------------------------------------------

def observed_daily(days):
    """`days`: [(date, station features)] oldest first. Station value = the
    24-h mean PM2.5; only station-days with >= 18 valid hours count. A city's
    daily index is the sub-index of its median station (a single faulty
    low-cost sensor must not set a city's level); min/max are kept."""
    out_days, per_city = [], {}
    for date, feats in days:
        aqis, pm, n_rep, city_pm = [], [], 0, {}
        for f in feats:
            p = f.get("properties") or {}
            v = ae._finite(p.get("pm25"))
            if v is None or v >= 1500:
                continue
            n_rep += 1
            if (p.get("valid_hours") or 0) < ae.MIN_HOURS_24H:
                continue
            aqis.append(ae.sub_index("pm25_24h", v))
            pm.append(v)
            city = (p.get("city") or "").strip()
            if city:
                lon, lat = (f.get("geometry") or {}).get("coordinates") or (None, None)
                city_pm.setdefault(city, []).append((v, lon, lat))
        if not aqis:
            continue
        cities = {}
        for c, rows in city_pm.items():
            vals = [r[0] for r in rows]
            m = _median(vals)
            a = ae.sub_index("pm25_24h", m)
            cities[c] = a
            per_city.setdefault(c, {})[date] = {
                "aqi": a, "pm25": round(m, 1), "n": len(vals), "min": ae.sub_index("pm25_24h", min(vals)),
                "max": ae.sub_index("pm25_24h", max(vals)), "pos": [(r[1], r[2]) for r in rows if r[1] is not None],
                "spread": ((_pct(vals, 0.75) - _pct(vals, 0.25)) / m) if m and len(vals) >= 3 else None,
                "complete_stations": len(vals)}
        multi = {c: a for c, a in cities.items() if len(city_pm[c]) >= 2}
        worst = max(multi or cities, key=(multi or cities).get) if cities else None
        med = _median(aqis)
        out_days.append({
            "date": date, "n_reporting": n_rep, "n_valid": len(aqis), "median_aqi": int(round(med)),
            "p10_aqi": int(round(_pct(aqis, 0.10))), "p90_aqi": int(round(_pct(aqis, 0.90))), "max_aqi": max(aqis),
            "category": ae.category(int(round(med))), "category_counts": _counts(aqis), "median_pm25": round(_median(pm), 1),
            "share_above_who24": round(sum(v > WHO_24H for v in pm) / len(pm), 3),
            "share_above_neqs24": round(sum(v > NEQS_24H for v in pm) / len(pm), 3),
            "median_city_aqi": int(round(_median(list(cities.values())))) if cities else None, "n_cities": len(cities),
            "worst_city": worst, "worst_city_aqi": cities.get(worst), "worst_city_n": len(city_pm.get(worst, []))})
    used = [d["date"] for d in out_days]
    cities = []
    for c, dd in per_city.items():
        series = [dd.get(d) for d in used]
        valid = [x for x in series if x]
        pos = [p for x in valid for p in x["pos"]]
        if len(valid) < max(2, (len(used) + 1) // 2) or not pos:
            continue
        peak = max(valid, key=lambda x: x["aqi"])
        last = series[-1]
        cities.append({
            "city": c, "lon": round(sum(p[0] for p in pos) / len(pos), 4), "lat": round(sum(p[1] for p in pos) / len(pos), 4),
            "n_stations": max(x["n"] for x in valid), "days_valid": len(valid), "n_days": len(used),
            "series": [{"aqi": x["aqi"], "pm25": x["pm25"], "n": x["n"], "min": x["min"], "max": x["max"]} if x else None for x in series],
            "peak": peak["aqi"], "peak_pm25": peak["pm25"], "peak_date": used[series.index(peak)],
            "peak_max": peak["max"], "last_max": last["max"] if last else None,
            "last": last["aqi"] if last else None, "last_n": last["n"] if last else 0,
            "median_aqi": int(round(_median([x["aqi"] for x in valid]))),
            "mean_pm25": round(sum(x["pm25"] for x in valid) / len(valid), 1),
            "days_by_category": _counts([x["aqi"] for x in valid]),
            "station_days": sum(x["n"] for x in valid), "trend": _trend([x["aqi"] if x else None for x in series]),
            "confidence": confidence(last["n"] if last else 0, len(valid), len(used), (last or {}).get("spread"))})
    # Rank by how many days were worst: the median daily AQI, then the peak.
    cities.sort(key=lambda x: (-x["median_aqi"], -x["peak"]))
    return {"label": "Daily AQI (PM2.5 sub-index, 24-hour)", "dates": used, "days": out_days, "cities": cities,
            "trend": _trend([d["median_aqi"] for d in out_days]), "trend_step": TREND_STEP}


# ---------------------------------------------------------------------------
# Current (NowCast)
# ---------------------------------------------------------------------------

def _bulk_hourly(ids, hours=13):
    """station id -> {hour label (UTC iso): PM2.5}, quality-flagged rows dropped."""
    from . import hawanama_client as hc
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = end - timedelta(hours=hours)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    out, flagged = {}, 0

    def one(chunk):
        r = hc._sess().get(f"{hc.base_url()}/api/v1/reports/stations/history", timeout=40, params={
            "station_ids": ",".join(chunk), "start": start.strftime(fmt), "end": end.strftime(fmt), "parameters": "pm25"})
        r.raise_for_status()
        return r.json().get("rows") or []

    chunks = [ids[i:i + BULK_STATIONS] for i in range(0, len(ids), BULK_STATIONS)]
    failed = 0
    with ThreadPoolExecutor(max_workers=BULK_WORKERS, thread_name_prefix="aqi-hourly") as ex:
        for fut in [ex.submit(one, c) for c in chunks]:
            try:
                rows = fut.result()
            except Exception:
                failed += 1
                continue
            for row in rows:
                v = ae._finite(row.get("pm25"))
                if v is None or v >= 1500:
                    continue
                if str(row.get("qc_state") or "").lower() not in QC_OK:
                    flagged += 1
                    continue
                out.setdefault(row.get("station_id"), {})[row.get("timestamp_utc")] = v
    if failed == len(chunks):
        raise RuntimeError("hourly station history unavailable")
    return out, end, flagged, failed


def now_from_hourly(features, hourly, end):
    """NowCast AQI per station -> per city and national summary."""
    labels = [(end - timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ") for h in range(12, -1, -1)]
    stations, newest = [], None
    for f in features:
        p = f.get("properties") or {}
        rows = hourly.get(p.get("id")) or {}
        present = [i for i, t in enumerate(labels) if t in rows]
        if not present:
            continue
        # Networks post with different delays: NowCast runs up to each
        # station's newest hour, which must itself be recent.
        last = present[-1]
        if len(labels) - 1 - last > NOW_MAX_AGE_H:
            continue
        window = [rows.get(labels[i]) if i >= 0 else None for i in range(last - 11, last + 1)]
        nc = ae.nowcast_pm(window)
        aqi = ae.sub_index("pm25_24h", nc)
        if aqi is None:
            continue
        newest = max(newest or labels[last], labels[last])
        lon, lat = (f.get("geometry") or {}).get("coordinates") or (None, None)
        stations.append({"city": (p.get("city") or "").strip(), "aqi": aqi, "pm25": nc, "lon": lon, "lat": lat, "time": labels[last],
                         "network": p.get("network"), "id": p.get("id"), "name": p.get("name")})
    aq = [s["aqi"] for s in stations]
    groups = {}
    for s in stations:
        if s["city"]:
            groups.setdefault(s["city"], []).append(s)
    cities = []
    for c, g in groups.items():
        m = _median([s["pm25"] for s in g])
        cities.append({"city": c, "aqi": ae.sub_index("pm25_24h", m), "pm25": round(m, 1), "n": len(g),
                       "min": min(s["aqi"] for s in g), "max": max(s["aqi"] for s in g), "time": max(s["time"] for s in g),
                       "lon": sum(s["lon"] for s in g) / len(g), "lat": sum(s["lat"] for s in g) / len(g)})
    cities.sort(key=lambda x: -x["aqi"])
    med = _median(aq)
    nets = {}
    for s in stations:
        nets[s["network"] or "Other"] = nets.get(s["network"] or "Other", 0) + 1
    return {"label": "Current AQI (EPA NowCast, PM2.5)", "n_valid": len(stations),
            "median_aqi": None if med is None else int(round(med)),
            "median_city_aqi": int(round(_median([c["aqi"] for c in cities]))) if cities else None, "n_cities": len(cities),
            "category": ae.category(None if med is None else int(round(med))),
            "category_counts": _counts(aq), "cities": cities, "data_time": newest, "networks": nets,
            "median_pm25": round(_median([s["pm25"] for s in stations]), 1) if stations else None}


def current():
    from . import hawanama_client as hc
    fc = hc.stations_geojson()
    feats = fc["features"]
    recent = [f for f in feats if not (f.get("properties") or {}).get("reading_stale")]
    hourly, end, flagged, failed = _bulk_hourly([f["properties"]["id"] for f in recent if f["properties"].get("id")])
    out = now_from_hourly(recent, hourly, end)
    out.update({"n_listed": len(feats), "n_recent": len(recent), "n_flagged_readings": flagged, "failed_requests": failed})
    return out


# ---------------------------------------------------------------------------
# CAMS: modelled pollutants and the station-adjusted PM2.5 forecast
# ---------------------------------------------------------------------------

def cams_days(cities, past_days=8, forecast_days=5):
    """city -> {PKT date: {pollutant: 24 hourly µg/m³ values}} for [{city, lat, lon}]."""
    from . import hawanama_client as hc
    r = hc._sess().get(_CAMS_URL, timeout=40, params={
        "latitude": ",".join(f"{c['lat']:.3f}" for c in cities), "longitude": ",".join(f"{c['lon']:.3f}" for c in cities),
        "hourly": ",".join(_CAMS_VARS.values()), "past_days": past_days, "forecast_days": forecast_days, "timezone": "Asia/Karachi"})
    r.raise_for_status()
    data = r.json()
    data = data if isinstance(data, list) else [data]
    out = {}
    for c, loc in zip(cities, data):
        h = loc.get("hourly") or {}
        days = {}
        for i, t in enumerate(h.get("time") or []):
            d = days.setdefault(t[:10], {p: [] for p in _CAMS_VARS})
            for p, var in _CAMS_VARS.items():
                arr = h.get(var) or []
                d[p].append(arr[i] if i < len(arr) else None)
        out[c["city"]] = days
    return out


def _date_add(d, n):
    return (datetime.strptime(d, "%Y-%m-%d") + timedelta(days=n)).strftime("%Y-%m-%d")


def forecast_city(obs, model, target_days):
    """obs/model: {date: 24-h PM2.5}. Returns (rows per target day, ratio, matched days) or None."""
    if not obs:
        return None
    last = max(obs)
    matched = [d for d in (_date_add(last, -k) for k in range(FC_RATIO_DAYS)) if obs.get(d) and model.get(d)]
    if len(matched) < FC_MIN_DAYS:
        return None
    ratio = math.exp(sum(math.log(obs[d] / model[d]) for d in matched) / len(matched))
    ratio = min(max(ratio, FC_RATIO_CLIP[0]), FC_RATIO_CLIP[1])
    ceiling = FC_MAX_STEP * max(obs[d] for d in matched)
    rows = []
    for d in target_days:
        lead = (datetime.strptime(d, "%Y-%m-%d") - datetime.strptime(last, "%Y-%m-%d")).days
        m = model.get(d)
        if not m or lead not in FC_SKILL:
            rows.append(None)
            continue
        w = FC_PERSIST_WEIGHT[lead]
        v = min(math.exp(w * math.log(obs[last]) + (1 - w) * math.log(m * ratio)), ceiling)
        sk = FC_SKILL[lead]
        a = ae.sub_index("pm25_24h", v)
        rows.append({"aqi": a, "category": ae.category(a), "pm25": round(v, 1), "lead": lead,
                     "lo": ae.sub_index("pm25_24h", v * sk["q10"]), "hi": ae.sub_index("pm25_24h", v * sk["q90"])})
    return rows, round(ratio, 2), len(matched)


def outlook(observed, now=None):
    """Forecast and modelled-pollutant parts for the cities in `observed`."""
    cities = [c for c in observed["cities"] if c["n_stations"] >= 2 or c["city"] in METROS]
    metros = [c for c in cities if c["city"] in METROS]
    rest = [c for c in cities if c["city"] not in METROS]
    use = (metros + rest)[:MAX_CITIES]
    if not use:
        raise RuntimeError("no city with enough observations")
    model = cams_days(use)
    today = (now or datetime.now(PKT)).strftime("%Y-%m-%d")
    targets = [_date_add(today, k) for k in range(4)]
    dates = observed["dates"]
    fc, pol = [], []
    for c in use:
        md = model.get(c["city"]) or {}
        obs = {d: s["pm25"] for d, s in zip(dates, c["series"]) if s and s["pm25"]}
        mod24 = {d: ae.mean_24h(v["pm25"]) for d, v in md.items()}
        r = forecast_city(obs, mod24, targets)
        if r and any(r[0]):
            rows, ratio, n = r
            valid = [x for x in rows if x]
            peak = max(valid, key=lambda x: x["aqi"])
            best = min(valid, key=lambda x: x["aqi"])
            fc.append({"city": c["city"], "lon": c["lon"], "lat": c["lat"], "days": rows, "ratio": ratio, "n_ratio_days": n,
                       "peak": peak["aqi"], "peak_date": targets[rows.index(peak)], "best": best["aqi"], "best_date": targets[rows.index(best)],
                       "trend": _trend([x["aqi"] for x in valid]) if len(valid) >= 3 else "insufficient data"})
        # Modelled sub-indices (raw CAMS) for the last complete day and for tomorrow.
        row = {"city": c["city"]}
        for name, d in (("last", dates[-1]), ("next", targets[1])):
            if d in md:
                subs = ae.daily_subindices(md[d])
                o3 = {p: x["aqi"] for p, x in subs.items()}
                # PM2.5 from the stations (observed) or the adjusted forecast, never raw CAMS.
                pm = (next((s["aqi"] for dd, s in zip(dates, c["series"]) if dd == d and s), None) if name == "last"
                      else (r[0][1] or {}).get("aqi") if r and len(r[0]) > 1 else None)
                gases = {p: v for p, v in o3.items() if p != "pm25"}
                _, dom = ae.overall({"pm25": pm, **gases}) if pm is not None else (None, None)
                row[name] = {"date": d, "sub": subs, "pm25_station_aqi": pm, "dominant": dom}
        pol.append(row)
    fc.sort(key=lambda x: -x["peak"])
    days = []
    for i, d in enumerate(targets):
        vals = [x["days"][i]["aqi"] for x in fc if x["days"][i]]
        if not vals:
            continue
        lead = next(x["days"][i]["lead"] for x in fc if x["days"][i])
        m = int(round(_median(vals)))
        days.append({"date": d, "n_cities": len(vals), "median_aqi": m, "category": ae.category(m), "category_counts": _counts(vals),
                     "max_aqi": max(vals), "lead": lead, "skill": FC_SKILL[lead]})
    return {
        "forecast": {"label": "Forecast daily AQI (PM2.5, 24-hour, station-adjusted CAMS)", "targets": targets, "today": today,
                     "days": days, "cities": fc, "skill_note": FC_SKILL_NOTE, "model": MODEL},
        "pollutants": {"model": MODEL, "cities": pol,
                       "measured": {"pm25": True, "pm10": False, "o3": False, "no2": False, "so2": False, "co": False}},
    }


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _snapshot(payload):
    """Store the digest the report was built from; returns its short id."""
    try:
        body = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
        sid = hashlib.sha1(body).hexdigest()[:12]
        d = os.path.join(settings.MEDIA_ROOT, _SNAP_SUBDIR)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, f"{time.strftime('%Y%m%dT%H%M', time.gmtime())}_{sid}.json")
        tmp = f"{path}.{threading.get_ident()}.tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
        old = sorted(x for x in os.listdir(d) if x.endswith(".json"))[:-_SNAP_KEEP]
        for x in old:
            try:
                os.remove(os.path.join(d, x))
            except OSError:
                pass
        return sid
    except Exception:
        logger.warning("aqi_watch: snapshot not stored", exc_info=True)
        return None


def build(dates):
    """The whole AQI block for the digest. Observed data are required; the
    current and forecast parts each degrade to None with the reason recorded."""
    from . import hawanama_client as hc
    days, errors = [], {}
    for d in dates:
        try:
            days.append((d, hc.stations_daily_geojson(d)["features"]))
        except hc.HawanamaUnavailable:
            continue
    observed = observed_daily(days)
    if not observed["days"]:
        raise hc.HawanamaUnavailable("no valid station-days for AQI")

    def part(name, fn, *a):
        try:
            return fn(*a)
        except Exception as e:
            logger.warning("aqi_watch: part %s unavailable (%s)", name, e)
            errors[name] = type(e).__name__
            return None

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="aqi-part") as ex:
        f_now, f_out = ex.submit(part, "now", current), ex.submit(part, "forecast", outlook, observed)
        now, out = f_now.result(), f_out.result()
    out = out or {}
    if now:
        # The same city order/confidence everywhere: attach observation confidence.
        conf = {c["city"]: c["confidence"] for c in observed["cities"]}
        for c in now["cities"]:
            c["confidence"] = conf.get(c["city"])
    payload = {
        "standard": ae.describe(None, getattr(settings, "AQI_STANDARD_APPROVED", False), getattr(settings, "AQI_ADVICE_APPROVED", False)),
        "observed": observed, "now": now, "forecast": out.get("forecast"), "pollutants": out.get("pollutants"),
        "confidence_rules": CONFIDENCE_RULES, "errors": errors,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    payload["snapshot_id"] = _snapshot(payload)
    return payload
