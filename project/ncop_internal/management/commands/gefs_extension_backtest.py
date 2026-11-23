# project/ncop_internal/management/commands/gefs_extension_backtest.py
# ---------------------------------------------------------------------------
# Phase 3 backtest: can a free source extend the district outlook from 35 to
# 45 days with real skill? Candidates for days 36-45 are scored against NASA
# POWER district truth in two 5-day blocks (days 36-40, 41-45):
#
#   cfs_raw        NOAA CFSv2 00Z 4-member mean
#   cfs_cal        CFSv2, season/lead bias-corrected (Phase 2 method)
#   cfs_seam       CFSv2 shifted to agree with GEFS on the overlap days 29-35
#                  (additive for temperature, ratio for rain), then corrected
#   gefs_persist   GEFS week-5 (days 29-35) mean held constant, corrected
#   climatology    NASA POWER 2001-2025 normals for the valid dates
#   cfs_clim_mix   50/50 of cfs_cal and climatology (damping toward normal)
#
# Corrections use blocked leave-one-out CV (no training case within 35
# days of the tested one), as in Phase 2. A candidate is worth shipping only
# if it beats climatology reliably (bootstrap over cases, 97.5 %).
#
#   python manage.py gefs_extension_backtest fetch [--every 2] [--parallel 2]
#   python manage.py gefs_extension_backtest score [--json out.json]
# ---------------------------------------------------------------------------

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

import numpy as np
from django.core.management.base import BaseCommand, CommandError

from ncop_internal import gefs_calibration as gcal
from ncop_internal import gefs_districts as gd
from ncop_internal import gefs_verify as gv

ANCHOR = date(2024, 11, 20)
TRUTH_START, TRUTH_END = date(2024, 11, 20), date(2026, 11, 20)
BLOCKS = [(36, 40), (41, 45)]
OVERLAP = (29, 35)


def case_dates(every):
    last = TRUTH_END - timedelta(days=45)
    out, d = [], ANCHOR
    while d <= last:
        out.append(d)
        d += timedelta(days=7 * every)
    return out


class Command(BaseCommand):
    help = "Backtest free 45-day extension candidates (NOAA CFSv2 vs baselines) for days 36-45."

    def add_arguments(self, parser):
        parser.add_argument("action", choices=["fetch", "score"])
        parser.add_argument("--every", type=int, default=2, help="use every Nth weekly case")
        parser.add_argument("--parallel", type=int, default=2)
        parser.add_argument("--json")

    def handle(self, *args, **o):
        if not gd.ensure_index(block=True):
            raise CommandError("district index unavailable")
        weights, meta = gd._load_index()
        dates = case_dates(o["every"])
        if o["action"] == "fetch":
            self.stdout.write(f"{len(dates)} CFSv2 cases ({dates[0]} .. {dates[-1]}), lead days {gv.CFS_FIRST}-{gv.CFS_LAST}")
            t0, done = time.time(), 0
            with ThreadPoolExecutor(max_workers=max(1, o["parallel"])) as ex:
                futs = {ex.submit(gv.cfs_case, d, weights, len(meta)): d for d in dates}
                for f in as_completed(futs):
                    done += 1
                    try:
                        f.result()
                        self.stdout.write(f"[{done}/{len(dates)}] {futs[f]} ok ({time.time() - t0:.0f}s)")
                    except Exception as e:
                        self.stdout.write(f"[{done}/{len(dates)}] {futs[f]} FAILED: {e}")
            return
        report = self.score(dates, weights, meta)
        if o["json"]:
            with open(o["json"], "w", encoding="utf-8") as f:
                json.dump(report, f, indent=1)

    # ------------------------------------------------------------------
    def score(self, dates, weights, meta):
        n = len(meta)
        truth = {v: gv.district_truth(v, gv.fetch_truth(v, TRUTH_START, TRUTH_END), weights, n) for v in ("precip", "t2m")}
        tidx = {v: {d: i for i, d in enumerate(truth[v][0])} for v in truth}
        clim = {v: gv.district_climatology(v, weights, n) for v in ("precip", "t2m")}
        rows = []
        for d0 in dates:
            run = d0.strftime("%Y%m%d") + "00"
            cpath = os.path.join(gv.root(), f"cfs_{d0:%Y%m%d}_{gv.CFS_FIRST}_{gv.CFS_LAST}_m4.npz")
            gpath = os.path.join(gv.root(), run, "districts.npz")
            if not (os.path.exists(cpath) and os.path.exists(gpath)):
                continue
            c = gv.cfs_case(d0, weights, n)
            g = gv.district_forecast(run, weights, meta)
            rows.append((d0, c, {"precip": g[0], "t2m": g[1]}))
        if len(rows) < 20:
            raise CommandError(f"only {len(rows)} complete cases — run fetch first")
        inits = [r[0] for r in rows]
        self.stdout.write(f"{len(inits)} cases {inits[0]} .. {inits[-1]}")
        report = {"cases": [d.isoformat() for d in inits], "vars": {}}

        def block(a, first, var, b):              # a: [district, day from `first`]
            lo, hi = b[0] - first, b[1] - first + 1
            m = np.nanmean(a[:, lo:hi], axis=1)
            return m * (b[1] - b[0] + 1) if var == "precip" else m

        for var in ("t2m", "precip"):
            obs, cfs_raw, seam, persist, climo = [], [], [], [], []
            for d0, c, g in rows:
                ob_days = []
                for L in range(OVERLAP[0], BLOCKS[-1][1] + 1):
                    j = tidx[var].get(d0 + timedelta(days=L - 1))
                    ob_days.append(truth[var][1][:, j] if j is not None else np.full(n, np.nan))
                ob = np.stack(ob_days, axis=1)                                   # [district, day 29..45]
                cf = c[var][:, : BLOCKS[-1][1] - gv.CFS_FIRST + 1]               # CFS days 29..45
                gw5 = np.nanmean(g[var][:, OVERLAP[0] - 1:OVERLAP[1]], axis=1)   # GEFS week-5 mean
                cw5 = np.nanmean(cf[:, : OVERLAP[1] - OVERLAP[0] + 1], axis=1)   # CFS same days
                if var == "t2m":
                    sm = cf + (gw5 - cw5)[:, None]
                else:
                    ratio = np.clip((gw5 + 0.3) / (cw5 + 0.3), 0.33, 3.0)
                    sm = cf * ratio[:, None]
                cn = np.stack([gv.daily_normal(clim[var], d0 + timedelta(days=L - 1))
                               for L in range(OVERLAP[0], BLOCKS[-1][1] + 1)], axis=1)
                f0 = OVERLAP[0]
                obs.append(np.stack([block(ob, f0, var, b) for b in BLOCKS], 1))
                cfs_raw.append(np.stack([block(cf, f0, var, b) for b in BLOCKS], 1))
                seam.append(np.stack([block(sm, f0, var, b) for b in BLOCKS], 1))
                persist.append(np.stack([(gw5 * (b[1] - b[0] + 1) if var == "precip" else gw5) for b in BLOCKS], 1))
                climo.append(np.stack([block(cn, f0, var, b) for b in BLOCKS], 1))
            ob = np.stack(obs)
            cands = {"cfs_raw": np.stack(cfs_raw), "seam_raw": np.stack(seam), "persist_raw": np.stack(persist),
                     "climatology": np.stack(climo)}
            # Blocked-CV bias correction (Phase 2 machinery; "weeks" = the 2 blocks)
            saved = gcal.N_WEEKS
            gcal.N_WEEKS = len(BLOCKS)
            try:
                for name in ("cfs_raw", "seam_raw", "persist_raw"):
                    cands[name.replace("_raw", "_cal")] = gcal.cross_validate(cands[name], ob, inits, var, "district")
            finally:
                gcal.N_WEEKS = saved
            cands["cfs_clim_mix"] = 0.5 * cands["cfs_cal"] + 0.5 * cands["climatology"]
            cands["seam_clim_mix"] = 0.5 * cands["seam_cal"] + 0.5 * cands["climatology"]
            ref = cands["climatology"]
            unit = "deg C" if var == "t2m" else "mm per 5 days"
            self.stdout.write(f"\n=== {var} ({unit}) — MAE per block (days 36-40, 41-45); gain vs climatology; P(beats climatology) ===")
            rep = {}
            for name, fc in cands.items():
                e = gcal.errors(fc, ob)
                ok, g, p = gcal.reliable_gain(ref, fc, ob, min_gain=0.0, confidence=0.975)
                rep[name] = {"mae": np.round(e["mae"], 3).tolist(), "rmse": np.round(e["rmse"], 3).tolist(),
                             "bias": np.round(e["bias"], 3).tolist(), "gain_vs_clim_pct": np.round(100 * g, 1).tolist(),
                             "p_beats_clim": np.round(p, 3).tolist()}
                self.stdout.write(f"  {name:14} MAE {np.round(e['mae'], 2)}  RMSE {np.round(e['rmse'], 2)}  "
                                  f"bias {np.round(e['bias'], 2)}  vs clim {np.round(100 * g, 1)}%  P {np.round(p, 2)}")
            report["vars"][var] = rep
        return report
