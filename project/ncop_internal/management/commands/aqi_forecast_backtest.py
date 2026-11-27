"""Backtest of the station-adjusted AQI forecast (aqi_watch.forecast_city).

    python manage.py aqi_forecast_backtest [--days 37] [--cities 22] [--json out.json]

Observed: city median of station 24-h PM2.5 means (>= 18 h, >= 2 stations).
Model: CAMS hourly PM2.5 from Open-Meteo's archive, which is nearer to an
analysis than to a true multi-day forecast, so this is an upper bound on skill
at longer leads. Prints the figures kept in aqi_watch.FC_SKILL.
"""

import json
import math

from django.core.management.base import BaseCommand

from ncop_internal import aqi_engine as ae
from ncop_internal import aqi_watch as aw
from ncop_internal import hawanama_client as hc


class Command(BaseCommand):
    help = "Backtest the station-adjusted 24-hour AQI forecast"

    def add_arguments(self, p):
        p.add_argument("--days", type=int, default=37)
        p.add_argument("--cities", type=int, default=22)
        p.add_argument("--json")

    def handle(self, *a, **o):
        dates = hc.tile_dates(limit=o["days"] + 3)["dates"][-o["days"]:]
        obs, pos = {}, {}
        for d in dates:
            try:
                feats = hc.stations_daily_geojson(d)["features"]
            except hc.HawanamaUnavailable:
                continue
            g = {}
            for f in feats:
                p = f["properties"]
                v = ae._finite(p.get("pm25"))
                if v and v < 1500 and (p.get("valid_hours") or 0) >= ae.MIN_HOURS_24H and p.get("city"):
                    g.setdefault(p["city"], []).append((v, *f["geometry"]["coordinates"]))
            for c, rows in g.items():
                if len(rows) >= 2:
                    obs.setdefault(c, {})[d] = aw._median([r[0] for r in rows])
                    pos.setdefault(c, []).extend((r[1], r[2]) for r in rows)
        names = sorted((c for c in obs if len(obs[c]) >= 20), key=lambda c: -len(obs[c]))[:o["cities"]]
        if not names:
            self.stderr.write("not enough archived station days")
            return
        cities = [{"city": c, "lon": sum(x[0] for x in pos[c]) / len(pos[c]), "lat": sum(x[1] for x in pos[c]) / len(pos[c])} for c in names]
        model = aw.cams_days(cities, past_days=min(92, len(dates) + 3), forecast_days=1)
        res = {k: {m: [] for m in ("blend", "raw", "persist")} for k in aw.FC_SKILL}
        ratios = {k: [] for k in aw.FC_SKILL}
        for c in names:
            mod = {d: ae.mean_24h(v["pm25"]) for d, v in model.get(c, {}).items()}
            for j, last in enumerate(dates):
                hist = {d: v for d, v in obs[c].items() if d <= last}
                if last not in hist:
                    continue
                targets = [aw._date_add(last, k) for k in aw.FC_SKILL]
                r = aw.forecast_city(hist, mod, targets)
                if not r:
                    continue
                for k, d, row in zip(aw.FC_SKILL, targets, r[0]):
                    if not row or d not in obs[c]:
                        continue
                    t = obs[c][d]
                    ratios[k].append(t / row["pm25"])
                    for m, v in (("blend", row["pm25"]), ("raw", mod[d]), ("persist", hist[last])):
                        ci = ae.CATEGORY_KEYS.index(ae.category(ae.sub_index("pm25_24h", v)))
                        ct = ae.CATEGORY_KEYS.index(ae.category(ae.sub_index("pm25_24h", t)))
                        res[k][m].append((abs(v - t), ci == ct, abs(ci - ct) <= 1))
        out = {}
        for k, bym in res.items():
            for m, rows in bym.items():
                if not rows:
                    continue
                n = len(rows)
                out.setdefault(k, {})[m] = {"n": n, "mae": round(sum(r[0] for r in rows) / n, 1), "hit": round(100 * sum(r[1] for r in rows) / n),
                                            "within1": round(100 * sum(r[2] for r in rows) / n)}
            if ratios[k]:
                out[k]["q10"], out[k]["q90"] = round(aw._pct(ratios[k], 0.1), 2), round(aw._pct(ratios[k], 0.9), 2)
                out[k]["gmean_ratio"] = round(math.exp(sum(math.log(x) for x in ratios[k]) / len(ratios[k])), 3)
            self.stdout.write(f"lead {k}: {out.get(k)}")
        if o["json"]:
            with open(o["json"], "w", encoding="utf-8") as f:
                json.dump({"dates": [dates[0], dates[-1]], "cities": names, "leads": out}, f, indent=1)
