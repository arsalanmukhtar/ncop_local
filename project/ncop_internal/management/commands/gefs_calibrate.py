# project/ncop_internal/management/commands/gefs_calibrate.py
# ---------------------------------------------------------------------------
# Train the GEFS district bias correction (gefs_calibration.py) from the
# archived runs fetched by `gefs_backtest fetch` and NASA POWER truth.
#
#   python manage.py gefs_calibrate                     train + cross-validate + save
#   python manage.py gefs_calibrate --dry-run           report only, keep current model
#   python manage.py gefs_calibrate --start 2024-11-20 --end 2026-11-20
#
# Re-run every few months (or after a GEFS upgrade) to refresh the tables;
# the served district table picks a new model up automatically.
# ---------------------------------------------------------------------------

import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

import numpy as np
from django.core.management.base import BaseCommand, CommandError

from ncop_internal import gefs_calibration as gcal
from ncop_internal import gefs_districts as gd
from ncop_internal import gefs_verify as gv


def load_cases(start, end, weights, meta):
    """All archived runs whose 35 days are covered by truth -> weekly arrays."""
    n = len(meta)
    truth = {v: gv.district_truth(v, gv.fetch_truth(v, start, end), weights, n) for v in ("precip", "t2m")}
    idx = {v: {d: i for i, d in enumerate(truth[v][0])} for v in truth}
    fc = {"precip": [], "t2m": []}
    ob = {"precip": [], "t2m": []}
    inits = []
    for run in sorted(os.listdir(gv.root())):
        if not (run.isdigit() and len(run) == 10 and os.path.exists(os.path.join(gv.root(), run, "districts.npz"))):
            continue
        d0 = date(int(run[:4]), int(run[4:6]), int(run[6:8]))
        if d0 < start or d0 + timedelta(days=34) > end:
            continue
        series = gv.district_forecast(run, weights, meta)
        rows = {}
        for vi, v in enumerate(("precip", "t2m")):
            cols = [idx[v].get(d0 + timedelta(days=k)) for k in range(35)]
            if any(c is None for c in cols):
                break
            o = truth[v][1][:, cols]
            f = series[vi]
            fw = np.stack([np.nanmean(f[:, a - 1:b], 1) for a, b in gv.WEEKS], 1)
            ow = np.stack([np.nanmean(o[:, a - 1:b], 1) for a, b in gv.WEEKS], 1)
            if v == "precip":
                k = np.array([b - a + 1 for a, b in gv.WEEKS])
                fw, ow = fw * k, ow * k
            rows[v] = (fw, ow)
        if len(rows) == 2:
            inits.append(d0)
            for v in rows:
                fc[v].append(rows[v][0])
                ob[v].append(rows[v][1])
    return inits, {v: np.stack(fc[v]) for v in fc}, {v: np.stack(ob[v]) for v in ob}


ANCHOR = date(2024, 11, 20)        # weekly training cadence (every 7 days from here)
WINDOW_DAYS = 730                  # rolling 2-year training window
POWER_LATENCY_DAYS = 3             # NASA POWER daily data lag


class Command(BaseCommand):
    help = "Train and cross-validate the GEFS district bias correction."

    def add_arguments(self, parser):
        parser.add_argument("--start", default="2024-11-20")
        parser.add_argument("--end", default="2026-11-20")
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--json")
        parser.add_argument("--update", action="store_true",
                            help="rolling retrain: fetch any missing weekly runs of the last 2 years "
                                 "(district series only), refresh truth, retrain, prune old data")

    def handle(self, *args, **o):
        if not gd.ensure_index(block=True):
            raise CommandError("district index unavailable")
        weights, meta = gd._load_index()
        start, end = date.fromisoformat(o["start"]), date.fromisoformat(o["end"])
        if o["update"]:
            start, end = self.update(weights, meta)
        inits, fc, ob = load_cases(start, end, weights, meta)
        if len(inits) < 20:
            raise CommandError(f"only {len(inits)} verifiable cases — fetch more runs first")
        months = sorted({d.month for d in inits})
        self.stdout.write(f"{len(inits)} cases {inits[0]} .. {inits[-1]} (months covered: {months})")
        clim = {v: gv.district_climatology(v, weights, len(meta)) for v in ("t2m", "precip")}   # 2001-2025 normals
        model, report = gcal.train(fc, ob, inits, meta, clim_monthly=clim)
        for var, unit in (("t2m", "deg C"), ("precip", "mm/week")):
            r = report["vars"][var]
            self.stdout.write(f"\n{var} ({unit}) - pooling: {r['pool']}; switched on (season: weeks): {r['enabled']}")
            self.stdout.write(f"  CV gain % by season: {r['season_mae_gain_pct']}")
            self.stdout.write(f"  MAE raw        {r['raw']['mae']}")
            for p, e in r["cv"].items():
                self.stdout.write(f"  MAE CV {p:9} {e['mae']}")
            self.stdout.write(f"  RMSE raw       {r['raw']['rmse']}")
            self.stdout.write(f"  RMSE CV chosen {r['cv'][r['pool']]['rmse']}")
            self.stdout.write(f"  bias raw       {r['raw']['bias']}")
            self.stdout.write(f"  bias CV chosen {r['cv'][r['pool']]['bias']}")
            self.stdout.write(f"  MAE gain % (all on)  {r['mae_gain_pct']}")
            self.stdout.write(f"  damping alpha/week   {r['damping']['alpha_by_week']}")
            self.stdout.write(f"  MAE final (gated)    {r['final']['mae']}")
            self.stdout.write(f"  MAE gain % (gated)   {r['final_mae_gain_pct']}")
        if o["json"]:
            with open(o["json"], "w", encoding="utf-8") as f:
                json.dump(report, f, indent=1)
        if o["dry_run"]:
            self.stdout.write("\n(dry run: model not saved)")
            return
        path = gcal.save(model, report)
        self.stdout.write(f"\nmodel saved: {path}")

    def update(self, weights, meta):
        """Rolling 2-year window ending at the newest verifiable day."""
        end = date.today() - timedelta(days=POWER_LATENCY_DAYS)
        start = end - timedelta(days=WINDOW_DAYS)
        first = ANCHOR + timedelta(days=7 * max(0, -(-(start - ANCHOR).days // 7)))
        last_init = end - timedelta(days=34)
        inits = [first + timedelta(days=7 * i) for i in range((last_init - first).days // 7 + 1)]
        runs = [d.strftime("%Y%m%d") + "00" for d in inits]
        missing = [r for r in runs if not os.path.exists(os.path.join(gv.root(), r, "districts.npz"))]
        self.stdout.write(f"rolling window {start} .. {end}: {len(runs)} weekly cases, {len(missing)} to fetch")

        def job(r):
            gv.fetch_run(r)
            gv.compact_run(r, weights, meta)

        with ThreadPoolExecutor(max_workers=3) as ex:
            futs = {ex.submit(job, r): r for r in missing}
            for f in as_completed(futs):
                try:
                    f.result()
                except Exception as e:                 # a missing archive day must not stop the retrain
                    self.stdout.write(f"  {futs[f]} skipped: {e}")
        keep = {os.path.basename(gv.fetch_truth(v, start, end)) for v in ("precip", "t2m")}
        for name in os.listdir(gv.root()):            # bounded disk: drop data outside the window
            p = os.path.join(gv.root(), name)
            if name.startswith("truth_") and name not in keep:
                os.remove(p)
            elif name.isdigit() and len(name) == 10 and date(int(name[:4]), int(name[4:6]), int(name[6:8])) < start:
                shutil.rmtree(p, ignore_errors=True)
        return start, end
