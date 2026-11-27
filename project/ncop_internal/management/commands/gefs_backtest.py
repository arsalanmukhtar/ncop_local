# project/ncop_internal/management/commands/gefs_backtest.py
# ---------------------------------------------------------------------------
# Offline backtest of the GEFS 35-day district outlook (gefs_verify.py).
#
#   python manage.py gefs_backtest fetch  [--dates YYYY-MM-DD,...]   archived runs (+3 lag days each)
#   python manage.py gefs_backtest truth  [--start ...] [--end ...]  NASA POWER district truth
#   python manage.py gefs_backtest score  [--json path]               compare methods
#
# Default case set: 17 init dates spread over Dec 2025 - Oct 2026 (winter,
# pre-monsoon, monsoon, post-monsoon), every one fully verifiable (35 days
# of truth) by 20 Nov 2026.
# ---------------------------------------------------------------------------

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

import numpy as np
from django.core.management.base import BaseCommand, CommandError

from ncop_internal import gefs_districts as gd
from ncop_internal import gefs_verify as gv

DEFAULT_DATES = ["2025-12-01", "2025-12-15", "2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15", "2026-03-01",
                 "2026-04-01", "2026-05-01", "2026-06-15", "2026-07-01", "2026-07-15", "2026-08-01", "2026-08-15",
                 "2026-09-15", "2026-10-01", "2026-10-15"]
TRUTH_START, TRUTH_END = "2025-12-01", "2026-11-20"

# Methods compared (weights for lag 0..3; first day on which lags apply).
METHODS = {
    "newest_only": ([1.0], 1),
    "lag2_eq_from_d11": ([1.0, 1.0], 11),
    "lag3_eq_from_d11": ([1.0, 1.0, 1.0], 11),
    "lag4_eq_from_d11": ([1.0, 1.0, 1.0, 1.0], 11),
    "lag4_decay_from_d11": ([1.0, 0.75, 0.5, 0.25], 11),
    "lag4_eq_from_d8": ([1.0, 1.0, 1.0, 1.0], 8),
    "lag4_eq_from_d1": ([1.0, 1.0, 1.0, 1.0], 1),
}


class Command(BaseCommand):
    help = "Backtest the GEFS 35-day district outlook against NASA POWER observations."

    def add_arguments(self, parser):
        parser.add_argument("action", choices=["fetch", "truth", "score", "compact"])
        parser.add_argument("--no-lag", action="store_true", help="fetch only the init-date runs (no lag runs)")
        parser.add_argument("--weekly", help="START,END: one init date every 7 days (calibration training set)")
        parser.add_argument("--dates", default=",".join(DEFAULT_DATES))
        parser.add_argument("--start", default=TRUTH_START)
        parser.add_argument("--end", default=TRUTH_END)
        parser.add_argument("--parallel-runs", type=int, default=2)
        parser.add_argument("--json")

    def handle(self, *args, **o):
        dates = [date.fromisoformat(s.strip()) for s in o["dates"].split(",") if s.strip()]
        if o["weekly"]:
            a, b = (date.fromisoformat(x) for x in o["weekly"].split(","))
            dates = [date.fromordinal(d) for d in range(a.toordinal(), b.toordinal() + 1, 7)]
        if o["action"] == "compact":
            weights, meta = gd._load_index()
            import os
            runs = [r for r in sorted(os.listdir(gv.root())) if r.isdigit() and len(r) == 10]
            for r in runs:
                gv.compact_run(r, weights, meta)
            self.stdout.write(f"compacted {len(runs)} runs")
            return
        if o["action"] == "fetch":
            if not gd.ensure_index(block=True):
                raise CommandError("district index unavailable")
            weights, meta = gd._load_index()
            runs = gv.runs_for(dates, 0 if o["no_lag"] else gv.MAX_LAG)

            def job(r):
                gv.fetch_run(r)
                gv.compact_run(r, weights, meta)
            self.stdout.write(f"{len(runs)} archived runs to fetch")
            t0, done = time.time(), 0
            with ThreadPoolExecutor(max_workers=max(1, o["parallel_runs"])) as ex:
                futs = {ex.submit(job, r): r for r in runs}
                for f in as_completed(futs):
                    done += 1
                    try:
                        f.result()
                        self.stdout.write(f"[{done}/{len(runs)}] {futs[f]} ok  ({time.time() - t0:.0f}s)")
                    except Exception as e:
                        self.stdout.write(f"[{done}/{len(runs)}] {futs[f]} FAILED: {e}")
            return
        start, end = date.fromisoformat(o["start"]), date.fromisoformat(o["end"])
        if o["action"] == "truth":
            for var in ("precip", "t2m"):
                self.stdout.write(f"truth {var}: {gv.fetch_truth(var, start, end)}")
            return
        report = self.score(dates, start, end)
        if o["json"]:
            with open(o["json"], "w", encoding="utf-8") as f:
                json.dump(report, f, indent=1)
        self.print_report(report)

    # ------------------------------------------------------------------
    def score(self, dates, start, end):
        if not gd.ensure_index(block=True):
            raise CommandError("district index unavailable")
        weights, meta = gd._load_index()
        n = len(meta)
        truth = {}
        for var in ("precip", "t2m"):
            tdates, tvals = gv.district_truth(var, gv.fetch_truth(var, start, end), weights, n)
            truth[var] = ({d: i for i, d in enumerate(tdates)}, tvals)
        fc_cache = {}

        def fc(run):
            if run not in fc_cache:
                try:
                    fc_cache[run] = gv.district_forecast(run, weights, meta)
                except (OSError, ValueError, KeyError):
                    fc_cache[run] = None
            return fc_cache[run]

        report = {"cases": [], "methods": {}}
        for name, (wts, first) in gv_methods().items():
            cases = {"precip": [], "t2m": []}
            for d0 in dates:
                runs = [(d0.toordinal() - k) for k in range(len(wts))]
                runs = [date.fromordinal(r).strftime("%Y%m%d") + "00" for r in runs]
                if fc(runs[0]) is None:
                    continue
                for vi, var in enumerate(("precip", "t2m")):
                    series = [fc(r)[vi] if fc(r) is not None else None for r in runs]
                    f = gv.lagged(series, wts, first)
                    idx, tv = truth[var]
                    obs = np.full_like(f, np.nan)
                    for dd in range(f.shape[1]):
                        j = idx.get(date.fromordinal(d0.toordinal() + dd))
                        if j is not None:
                            obs[:, dd] = tv[:, j]
                    cases[var].append((f, obs, d0))
            report["methods"][name] = {var: gv.score(cases[var], var) for var in cases if cases[var]}
            report["methods"][name]["n_cases"] = len(cases["precip"])
        report["cases"] = [d.isoformat() for d in dates if fc(d.strftime("%Y%m%d") + "00") is not None]
        return report

    def print_report(self, rep):
        self.stdout.write(f"cases: {len(rep['cases'])}")
        for var, unit in (("precip", "mm/week"), ("t2m", "deg C")):
            self.stdout.write(f"\n=== {var}: weekly-mean scores ({unit}) — MAE / RMSE / bias / ACC ===")
            self.stdout.write(f"{'method':24}" + "".join(f"{'week ' + str(i + 1):>26}" for i in range(5)))
            for name, m in rep["methods"].items():
                if var not in m:
                    continue
                row = "".join(f"{s['mae']:6.2f}{s['rmse']:6.2f}{s['bias']:7.2f}{(s['acc'] or 0):7.2f}" if s else f"{'-':>26}"
                              for s in m[var]["weekly"])
                self.stdout.write(f"{name:24}{row}")


def gv_methods():
    return METHODS
