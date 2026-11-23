# project/ncop_internal/gefs_calibration.py
# ---------------------------------------------------------------------------
# Bias correction of the GEFS 35-day DISTRICT values (accuracy phase 2).
#
# Why: the backtest (gefs_verify.py) showed GEFS runs systematically warm and
# dry over Pakistan's districts; removing a season- and lead-dependent bias
# cut the cross-validated error by up to a third (week-1 temperature).
#
# Method (standard reforecast-style calibration, cf. Hamill et al.; CPC):
#   - Training cases: past GEFS runs (NOAA archive) scored against NASA POWER
#     daily observations (IMERG-based precipitation, MERRA-2 temperature),
#     both as district area means, aggregated per lead week.
#   - Season: only cases whose start date lies within +-WINDOW_DAYS of the
#     target day-of-year (any year) are used — 24 half-month bins.
#   - Temperature: additive bias (forecast - observed), weekly means.
#     Precipitation: ratio of weekly totals in log space with a small
#     regulariser (ALPHA mm), clipped to [RATIO_MIN, RATIO_MAX].
#   - Per-district estimates are shrunk toward the national value with
#     weight K/(n+K) so districts with few/noisy cases stay sensible.
#   - Each variable x lead week is switched on only if blocked
#     cross-validation shows it lowers the error (gefs_calibrate command).
#
# Damping (phase 3): at long leads GEFS has little skill beyond the
# seasonal normal over Pakistan; where blocked CV proves it reliably helps
# (same >=5 % / 97.5 % rule), the corrected value is blended toward the
# 2001-2025 NASA POWER normal: v = (1 - a) v + a normal, a in DAMP_ALPHAS.
# The district normals are stored in the model file (no runtime download).
#
# Runtime cost: one small .npz (~200 KB) read once per process, then one
# add/multiply per district-day when a run's district table is built.
# Map frames and the click popup keep the raw GEFS values.
# ---------------------------------------------------------------------------

import hashlib
import json
import logging
import os
import threading
import uuid
from datetime import date

import numpy as np

from . import gefs_client as gc

logger = logging.getLogger(__name__)

MODEL_VERSION = 1
MODEL_FILE = f"_calibration_v{MODEL_VERSION}.npz"
N_BINS = 24                     # half-month seasonal bins
# Tuned by blocked cross-validation on 158 cases (Nov 2024 - Oct 2026):
WINDOW_DAYS = 60                # temperature: cases within +-60 days of the target day-of-year
WINDOW_DAYS_PRECIP = 30         # precipitation: +-30 days (rain regimes change faster)
SHRINK_K = 4.0                  # pseudo-cases pulling a district toward the national value
ALPHA = 2.0                     # mm per week regulariser of the precipitation ratio
SHRINK_K_PRECIP = 4.0           # precipitation shrinkage toward the national ratio
DRY_MM = 5.0                    # mm/week: below this mean weekly rain, no precipitation scaling
SEASONS = ((12, 1, 2), (3, 4, 5), (6, 7, 8), (9, 10, 11))   # DJF, MAM, JJA, SON: per-season switch
SEASON_NAMES = ("Dec-Feb", "Mar-May", "Jun-Aug", "Sep-Nov")
RATIO_MIN, RATIO_MAX = 0.5, 2.0
T_MAX_SHIFT = 5.0               # deg C cap on any temperature correction
N_WEEKS = 5
DAMP_ALPHAS = (0.25, 0.5)
# Confidence (per district x season x lead week), from the cross-validated
# error of the FINAL served value vs the error of the seasonal normal:
#   skill = 1 - MAE_forecast / MAE_normal
#   High   : skill >= CONF_HIGH, or a typical error below ERR_SMALL
#   Medium : skill >= CONF_MED
#   Low    : otherwise (little better than the seasonal normal)
CONF_HIGH, CONF_MED = 0.35, 0.10
ERR_SMALL = {"t2m": 1.0, "precip": 1.0}         # deg C (weekly mean) / mm per week
CONF_SHRINK_K = 8.0                             # pseudo-cases toward the national value
_cache = {"mtime": None, "model": None}
_lock = threading.Lock()


def bin_centres():
    return np.array([(i + 0.5) * 365.0 / N_BINS for i in range(N_BINS)])


def _doy(d):
    return d.timetuple().tm_yday


def _circ(a, b):
    x = np.abs(np.asarray(a, float) - np.asarray(b, float)) % 365.0
    return np.minimum(x, 365.0 - x)


def districts_hash(meta):
    names = "|".join(f"{d['province']}/{d['name']}" for d in meta)
    return hashlib.sha1(names.encode()).hexdigest()[:12]


# ------------------------------------------------------------------ fitting
def fit_bias(fc, ob, case_doy, target_doy, var, train_mask=None, pool="district"):
    """Correction for one target day-of-year from training cases.
    fc, ob: [case, district, week] weekly mean (t2m) or weekly total (precip).
    Returns [district, week]: additive bias (t2m) or multiplicative ratio (precip)."""
    n_case = fc.shape[0]
    m = np.ones(n_case, bool) if train_mask is None else np.asarray(train_mask, bool)
    win = m & (_circ(case_doy, target_doy) <= (WINDOW_DAYS_PRECIP if var == "precip" else WINDOW_DAYS))
    ok = np.isfinite(fc) & np.isfinite(ob)

    def agg(sel):
        s = sel[:, None, None] & ok
        cnt = s.sum(0).astype(float)                                    # [district, week]
        if var == "t2m":
            d = np.where(s, fc - ob, 0.0).sum(0)
            return d, cnt
        f = np.where(s, fc, 0.0).sum(0)
        o = np.where(s, ob, 0.0).sum(0)
        return (f, o), cnt

    if var == "t2m":
        dsum_w, n_w = agg(win)
        dsum_a, n_a = agg(m)
        nat_w = dsum_w.sum(0) / np.maximum(n_w.sum(0), 1)               # [week]
        nat_a = dsum_a.sum(0) / np.maximum(n_a.sum(0), 1)
        nat = np.where(n_w.sum(0) > 0, nat_w, nat_a)
        if pool == "national":
            out = np.broadcast_to(nat, n_w.shape).copy()
        else:
            out = (dsum_w + SHRINK_K * nat[None, :]) / (n_w + SHRINK_K)
        return np.clip(out, -T_MAX_SHIFT, T_MAX_SHIFT).astype(np.float32)

    (f_w, o_w), n_w = agg(win)
    (f_a, o_a), n_a = agg(m)
    nat_w = np.log((o_w.sum(0) + ALPHA * np.maximum(n_w.sum(0), 1)) / (f_w.sum(0) + ALPHA * np.maximum(n_w.sum(0), 1)))
    nat_a = np.log((o_a.sum(0) + ALPHA * np.maximum(n_a.sum(0), 1)) / (f_a.sum(0) + ALPHA * np.maximum(n_a.sum(0), 1)))
    nat = np.where(n_w.sum(0) > 0, nat_w, nat_a)
    if pool == "national":
        lr = np.broadcast_to(nat, n_w.shape).copy()
    else:
        lr_d = np.log((o_w + ALPHA * np.maximum(n_w, 1)) / (f_w + ALPHA * np.maximum(n_w, 1)))
        k = SHRINK_K_PRECIP
        lr = (n_w * lr_d + k * nat[None, :]) / (n_w + k)
        # Dry districts/seasons: a ratio of near-zero totals is noise -> no scaling.
        wet = (o_w + f_w) / (2 * np.maximum(n_w, 1)) >= DRY_MM
        lr = np.where(wet, lr, 0.0)
    return np.clip(np.exp(lr), RATIO_MIN, RATIO_MAX).astype(np.float32)


def season_of(d):
    return next(i for i, ms in enumerate(SEASONS) if d.month in ms)


def daily_normal(monthly, day):
    """Daily normal [district] from monthly normals [district, 12] by linear
    interpolation between mid-month values."""
    mids = np.array([15.5 + 30.42 * i for i in range(12)])
    x = np.concatenate([[mids[-1] - 365.0], mids, [mids[0] + 365.0]])
    y = np.concatenate([monthly[:, 11:12], monthly, monthly[:, 0:1]], axis=1)
    doy = day.timetuple().tm_yday
    j = int(np.searchsorted(x, doy)) - 1
    t = (doy - x[j]) / (x[j + 1] - x[j])
    return (y[:, j] * (1 - t) + y[:, j + 1] * t).astype(np.float32)


def weekly_normals(monthly, init_day, var, weeks=((1, 7), (8, 14), (15, 21), (22, 28), (29, 35))):
    """[district, week] normal weekly means (t2m) or totals (precip)."""
    from datetime import timedelta
    cols = []
    for a, b in weeks:
        m = np.mean([daily_normal(monthly, init_day + timedelta(days=L - 1)) for L in range(a, b + 1)], axis=0)
        cols.append(m * (b - a + 1) if var == "precip" else m)
    return np.stack(cols, axis=1)


def confidence_tables(final, ob, cl, seasons):
    """Typical error and skill vs the seasonal normal per [season, district,
    week], shrunk toward the national value. Inputs [case, district, week]."""
    n_d, n_w = final.shape[1], final.shape[2]
    err = np.zeros((len(SEASONS), n_d, n_w), np.float32)
    skill = np.zeros((len(SEASONS), n_d, n_w), np.float32)
    ae_f, ae_c = np.abs(final - ob), np.abs(cl - ob)
    for si in range(len(SEASONS)):
        sel = seasons == si
        if not sel.any():
            sel = np.ones_like(seasons, bool)
        f, c = ae_f[sel], ae_c[sel]
        ok = np.isfinite(f) & np.isfinite(c)
        n = ok.sum(0).astype(float)
        mf = np.where(ok, f, 0).sum(0) / np.maximum(n, 1)
        mc = np.where(ok, c, 0).sum(0) / np.maximum(n, 1)
        nat_f = np.where(ok, f, 0).sum((0, 1)) / np.maximum(n.sum(0), 1)
        nat_c = np.where(ok, c, 0).sum((0, 1)) / np.maximum(n.sum(0), 1)
        mf = (n * mf + CONF_SHRINK_K * nat_f) / (n + CONF_SHRINK_K)
        mc = (n * mc + CONF_SHRINK_K * nat_c) / (n + CONF_SHRINK_K)
        err[si] = mf
        skill[si] = 1.0 - mf / np.maximum(mc, 1e-6)
    return err, skill


def confidence_level(err, skill, var):
    """2 = High, 1 = Medium, 0 = Low (arrays of any shape)."""
    lvl = np.where(skill >= CONF_HIGH, 2, np.where(skill >= CONF_MED, 1, 0))
    return np.where(err < ERR_SMALL[var], 2, lvl).astype(np.int8)


def correct(fc, corr, var):
    return fc - corr if var == "t2m" else fc * corr


def cross_validate(fc, ob, init_dates, var, pool, block_days=35):
    """Blocked leave-one-out: a test case's correction is trained only on
    cases started more than block_days away (no overlapping verification
    periods). Returns corrected weekly forecasts [case, district, week]."""
    doy = np.array([_doy(d) for d in init_dates])
    ords = np.array([d.toordinal() for d in init_dates])
    out = np.empty_like(fc)
    for c in range(fc.shape[0]):
        train = np.abs(ords - ords[c]) > block_days
        out[c] = correct(fc[c], fit_bias(fc, ob, doy, doy[c], var, train, pool), var)
    return out


def errors(fc, ob):
    ok = np.isfinite(fc) & np.isfinite(ob)
    d = np.where(ok, fc - ob, np.nan)
    return {"mae": np.nanmean(np.abs(d), axis=(0, 1)), "rmse": np.sqrt(np.nanmean(d * d, axis=(0, 1))),
            "bias": np.nanmean(d, axis=(0, 1))}


def reliable_gain(raw_c, cv_c, ob_c, min_gain=0.05, confidence=0.975, n_boot=2000, seed=0):
    """Per lead week: is the CV gain both large enough and statistically
    reliable? Cases are resampled (bootstrap); a week is switched on only
    if the mean MAE gain >= min_gain AND the gain is > 0 in >= `confidence`
    of the resamples. Inputs [case, district, week]."""
    ae_raw = np.nanmean(np.abs(raw_c - ob_c), axis=1)          # [case, week]
    ae_cv = np.nanmean(np.abs(cv_c - ob_c), axis=1)
    rng = np.random.default_rng(seed)
    n = ae_raw.shape[0]
    idx = rng.integers(0, n, size=(n_boot, n))
    boot_raw = np.nanmean(ae_raw[idx], axis=1)                  # [boot, week]
    boot_cv = np.nanmean(ae_cv[idx], axis=1)
    p_better = np.mean(boot_cv < boot_raw, axis=0)
    gain = 1.0 - np.nanmean(ae_cv, 0) / np.nanmean(ae_raw, 0)
    return (gain >= min_gain) & (p_better >= confidence), gain, p_better


def train(fc_by_var, ob_by_var, init_dates, meta, min_gain=0.05, clim_monthly=None):
    """Choose pooling and enabled weeks per variable by blocked CV, then fit
    the final tables on all cases. Returns (model dict, report dict)."""
    doy = np.array([_doy(d) for d in init_dates])
    model = {"version": MODEL_VERSION, "districts_hash": districts_hash(meta), "bins": bin_centres(),
             "trained_from": min(init_dates).isoformat(), "trained_to": max(init_dates).isoformat(),
             "n_cases": len(init_dates)}
    report = {"n_cases": len(init_dates), "vars": {}}
    for var in ("t2m", "precip"):
        fc, ob = fc_by_var[var], ob_by_var[var]
        raw = errors(fc, ob)
        best = None
        variants = {}
        for pool in ("district", "national"):
            cv = errors(cross_validate(fc, ob, init_dates, var, pool), ob)
            variants[pool] = cv
            score = float(np.nansum(cv["mae"]))
            if best is None or score < best[0]:
                best = (score, pool)
        pool = best[1]
        cv_fc = cross_validate(fc, ob, init_dates, var, pool)
        cv = errors(cv_fc, ob)
        gain = 1.0 - cv["mae"] / raw["mae"]
        # Switch on per season x lead week only where blocked CV shows a gain.
        seas = np.array([season_of(d) for d in init_dates])
        enabled = np.zeros((len(SEASONS), N_WEEKS), bool)
        season_gain = {}
        for si in range(len(SEASONS)):
            sel = seas == si
            if sel.sum() < 8:
                continue
            r, c = errors(fc[sel], ob[sel]), errors(cv_fc[sel], ob[sel])
            ok, g, p_b = reliable_gain(fc[sel], cv_fc[sel], ob[sel], min_gain)
            enabled[si] = ok & (c["rmse"] <= r["rmse"] * 1.001)
            season_gain[SEASON_NAMES[si]] = {"gain_pct": np.round(100 * g, 1).tolist(), "p_better": np.round(p_b, 2).tolist()}
        gated = cv_fc.copy()
        for si in range(len(SEASONS)):
            sel = seas == si
            gated[sel] = np.where(enabled[si][None, None, :], cv_fc[sel], fc[sel])
        final = errors(gated, ob)
        # Damping toward the seasonal normal, per lead week, only if reliable.
        damp = np.zeros(N_WEEKS, np.float32)
        damp_report = {}
        if clim_monthly is not None and var in clim_monthly:
            cl = np.stack([weekly_normals(clim_monthly[var], d, var) for d in init_dates])
            for wk in range(N_WEEKS):
                best_a, best_g = 0.0, 0.0
                for a in DAMP_ALPHAS:
                    mix = (1 - a) * gated[:, :, wk:wk + 1] + a * cl[:, :, wk:wk + 1]
                    ok, g, p = reliable_gain(gated[:, :, wk:wk + 1], mix, ob[:, :, wk:wk + 1], min_gain)
                    damp_report[f"week{wk + 1}_a{a}"] = {"gain_pct": round(100 * float(g[0]), 1), "p_better": round(float(p[0]), 3)}
                    if ok[0] and g[0] > best_g:
                        best_a, best_g = a, float(g[0])
                damp[wk] = best_a
            dm = gated.copy()
            for wk in range(N_WEEKS):
                if damp[wk] > 0:
                    dm[:, :, wk] = (1 - damp[wk]) * gated[:, :, wk] + damp[wk] * cl[:, :, wk]
            final = errors(dm, ob)
            model[f"clim_{var}"] = np.asarray(clim_monthly[var], np.float32)
            err_t, skill_t = confidence_tables(dm, ob, cl, seas)
            model[f"{var}_err"], model[f"{var}_skill"] = err_t, skill_t
            lv = confidence_level(err_t, skill_t, var)
            report_conf = {SEASON_NAMES[i]: {"high_pct_by_week": np.round(100 * np.mean(lv[i] == 2, axis=0), 0).tolist(),
                                             "low_pct_by_week": np.round(100 * np.mean(lv[i] == 0, axis=0), 0).tolist()}
                           for i in range(len(SEASONS))}
        else:
            report_conf = None
        model[f"{var}_damp"] = damp
        tables = np.stack([fit_bias(fc, ob, doy, b, var, None, pool) for b in model["bins"]])   # [bin, district, week]
        model[f"{var}_table"] = tables
        model[f"{var}_enabled"] = enabled
        model[f"{var}_pool"] = pool
        report["vars"][var] = {"pool": pool,
                               "enabled": {SEASON_NAMES[i]: [int(w) + 1 for w in np.where(enabled[i])[0]] for i in range(len(SEASONS))},
                               "season_mae_gain_pct": season_gain,
                               "damping": {"alpha_by_week": damp.tolist(), "tests": damp_report},
                               "confidence": report_conf,
                               "final": {k: np.round(v, 3).tolist() for k, v in final.items()},
                               "final_mae_gain_pct": np.round(100 * (1 - final["mae"] / raw["mae"]), 1).tolist(),
                               "raw": {k: np.round(v, 3).tolist() for k, v in raw.items()},
                               "cv": {p: {k: np.round(v, 3).tolist() for k, v in e.items()} for p, e in variants.items()},
                               "mae_gain_pct": np.round(100 * gain, 1).tolist()}
    return model, report


def save(model, report):
    path = os.path.join(gc._root(), MODEL_FILE)
    tmp = path + f".tmp{uuid.uuid4().hex[:6]}.npz"
    meta = {k: model[k] for k in ("version", "districts_hash", "trained_from", "trained_to", "n_cases",
                                  "t2m_pool", "precip_pool")}
    extra = {k: model[k] for k in ("t2m_damp", "precip_damp", "clim_t2m", "clim_precip",
                                   "t2m_err", "t2m_skill", "precip_err", "precip_skill") if k in model}
    np.savez_compressed(tmp, bins=model["bins"], t2m_table=model["t2m_table"], precip_table=model["precip_table"],
                        t2m_enabled=model["t2m_enabled"], precip_enabled=model["precip_enabled"], **extra,
                        meta=np.array(json.dumps(meta)), report=np.array(json.dumps(report)))
    os.replace(tmp, path)
    with _lock:
        _cache.update(mtime=None, model=None)
    return path


# ------------------------------------------------------------------ runtime
def load():
    """The trained model, or None (cached per process; reloads if replaced)."""
    path = os.path.join(gc._root(), MODEL_FILE)
    try:
        mtime = (path, os.path.getmtime(path))
    except OSError:
        return None
    with _lock:
        if _cache["mtime"] == mtime:
            return _cache["model"]
        try:
            with np.load(path) as z:
                m = {k: z[k] for k in ("bins", "t2m_table", "precip_table", "t2m_enabled", "precip_enabled")}
                for var in ("t2m", "precip"):                     # damping: optional (older models have none)
                    m[f"{var}_damp"] = z[f"{var}_damp"] if f"{var}_damp" in z.files else np.zeros(N_WEEKS, np.float32)
                    m[f"clim_{var}"] = z[f"clim_{var}"] if f"clim_{var}" in z.files else None
                    m[f"{var}_err"] = z[f"{var}_err"] if f"{var}_err" in z.files else None
                    m[f"{var}_skill"] = z[f"{var}_skill"] if f"{var}_skill" in z.files else None
                m["meta"] = json.loads(str(z["meta"]))
                m["report"] = json.loads(str(z["report"]))
            m["tag"] = f"v{MODEL_VERSION}-{int(mtime[1])}"
        except Exception:
            logger.warning("gefs_calibration: model unreadable, serving raw values", exc_info=True)
            m = None
        _cache.update(mtime=mtime, model=m)
        return m


def status():
    """Small summary for the health endpoint."""
    m = load()
    if not m:
        return {"loaded": False}
    return {"loaded": True, "tag": m["tag"], **{k: m["meta"].get(k) for k in ("trained_from", "trained_to", "n_cases")},
            "damping_alpha_by_week": {v: m[f"{v}_damp"].tolist() for v in ("t2m", "precip")},
            "switched_on": {var: {SEASON_NAMES[i]: [int(w) + 1 for w in np.where(m[f"{var}_enabled"][i])[0]]
                                  for i in range(len(SEASONS))} for var in ("t2m", "precip")}}


def tag():
    m = load()
    return m["tag"] if m else None


def apply(stats, init_day, meta):
    """Correct a run's district arrays in place. stats: dict of
    [district, 35] arrays (precip_mean, precip_max, t2m_mean, t2m_min,
    t2m_max). Returns a provenance dict, or None when no model applies."""
    m = load()
    if not m or m["meta"].get("districts_hash") != districts_hash(meta):
        return None
    b = int(np.argmin(_circ(m["bins"], _doy(init_day))))
    si = season_of(init_day)
    n_days = stats["t2m_mean"].shape[1]
    week = np.minimum(np.arange(n_days) // 7, N_WEEKS - 1)
    t_on, p_on = m["t2m_enabled"][si][week], m["precip_enabled"][si][week]   # [day]
    t_corr = np.where(t_on[None, :], m["t2m_table"][b][:, week], 0.0)         # [district, day]
    p_corr = np.where(p_on[None, :], m["precip_table"][b][:, week], 1.0)
    for k in ("t2m_mean", "t2m_min", "t2m_max"):
        stats[k] = (stats[k] - t_corr).astype(np.float32)
    for k in ("precip_mean", "precip_max"):
        stats[k] = (stats[k] * p_corr).astype(np.float32)
    # Damping toward the seasonal normal (district means; cell extremes move with them).
    damped = {}
    for var, mean_k, extra in (("t2m", "t2m_mean", ("t2m_min", "t2m_max")), ("precip", "precip_mean", ("precip_max",))):
        alpha = m[f"{var}_damp"][week]                                        # [day]
        clim = m.get(f"clim_{var}")
        if clim is None or clim.shape[0] != stats[mean_k].shape[0] or not np.any(alpha > 0):
            continue
        from datetime import timedelta
        normal = np.stack([daily_normal(clim, init_day + timedelta(days=d)) for d in range(n_days)], axis=1)
        old = stats[mean_k]
        new = ((1 - alpha)[None, :] * old + alpha[None, :] * normal).astype(np.float32)
        for k in extra:
            if var == "t2m":
                stats[k] = (stats[k] + (new - old)).astype(np.float32)
            else:
                stats[k] = np.where(old > 0.05, stats[k] * new / np.maximum(old, 0.05), np.maximum(stats[k], new)).astype(np.float32)
        stats[mean_k] = new
        damped[var] = [int(w) + 1 for w in np.where(m[f"{var}_damp"] > 0)[0]]
    # Confidence per district and day (typical error, skill, level).
    for var in ("t2m", "precip"):
        e, sk = m.get(f"{var}_err"), m.get(f"{var}_skill")
        if e is None or sk is None or e.shape[1] != stats["t2m_mean"].shape[0]:
            continue
        ed, sd = e[si][:, week], sk[si][:, week]                              # [district, day]
        stats[f"{var}_err"] = ed.astype(np.float32)
        stats[f"{var}_skill"] = sd.astype(np.float32)
        stats[f"{var}_conf"] = confidence_level(ed, sd, var)
    return {"tag": m["tag"], "season": SEASON_NAMES[si],
            "t2m_weeks": [int(i) + 1 for i in np.where(m["t2m_enabled"][si])[0]],
            "precip_weeks": [int(i) + 1 for i in np.where(m["precip_enabled"][si])[0]],
            "trained_from": m["meta"]["trained_from"], "trained_to": m["meta"]["trained_to"],
            "n_cases": m["meta"]["n_cases"], "reference": "NASA POWER (IMERG precipitation, MERRA-2 temperature)",
            "damped_toward_normal": damped}
