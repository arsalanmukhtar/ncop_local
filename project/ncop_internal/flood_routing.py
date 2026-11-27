# project/ncop_internal/flood_routing.py
# ---------------------------------------------------------------------------
# NCOP river outlook: flow at FFD stations 1, 2 and 3 days ahead, from
#   - the station's own reading and how it is changing;
#   - FFD readings upstream, shifted by FFD's own travel times (the water that
#     will arrive has usually already been measured upstream);
#   - for the stations near the mountains, rain: satellite rain up to the day
#     before yesterday (it is published about 28 hours late), yesterday's rain
#     as GFS forecast it the morning before, and the GFS forecast of that
#     morning. Nothing is used in training that was not available at the time.
# Linear ridge model per station and lead; trained on June-October of every
# season since 2016, with the season being judged left out (so every score
# below is for a season the model never saw). Plain numpy, about a second.
#
# It does not know gate operations, breaches or water released across the
# border before it reaches a gauge. A station/lead is used only if it beats
# "tomorrow equals today" and reaches a minimum skill; otherwise it is shown
# as not skilful. FFD's official forecast always comes first.
# ---------------------------------------------------------------------------

import json
import logging
import os
import uuid
from datetime import date

import numpy as np

from . import flood_store as fs

logger = logging.getLogger(__name__)

VERSION = "route-5"
LEADS = (1, 2, 3)
# stations with rain as a predictor -> catchments feeding them
RAIN = {"marala": ["Chenab"], "khanki": ["Chenab"], "qadirabad": ["Chenab"], "mangla": ["Mangla"], "rasul": ["Mangla"],
        "jassar": ["Ravi"], "shahdara": ["Ravi"], "balloki": ["Ravi"], "sidhnai": ["Ravi"], "sulemanki": ["Sutlej"], "kalabagh": ["Kabul", "Tarbela"],
        "chashma": ["Kabul"], "trimmu": ["Chenab"], "nowshera": ["Kabul"], "tarbela": ["Tarbela"]}
TARGETS = [s for s in fs.IDS if s not in ("skardu", "partab", "besham", "gswala")]
MIN_DAYS, MIN_NSE = 350, 0.5
PROB_TIERS = ("low", "medium", "high", "very_high", "exceptional")


def series(store):
    """Daily 'arriving' flow (inflow, else outflow) and 'leaving' flow per station; 06:00 reading."""
    c = store["clean"]
    arr = np.where(np.isfinite(c["in6"]), c["in6"], c["out6"]).astype(float)
    lev = np.where(np.isfinite(c["out6"]), c["out6"], c["in6"]).astype(float)
    return arr, lev


def _at(a, x):
    """Linear interpolation of a daily series at fractional days; NaN where not covered."""
    i = np.floor(x).astype(int)
    f = x - i
    r = np.full(x.shape, np.nan)
    ok = (i >= 0) & (i < a.size)
    r[ok] = a[i[ok]]
    m = ok & (f > 1e-9)
    j = np.clip(i + 1, 0, a.size - 1)
    r[m] = a[i[m]] * (1 - f[m]) + a[j[m]] * f[m]
    r[m & (i + 1 >= a.size)] = np.nan
    return r


def features(sid, h, arr, lev, eo, t):
    """Predictor matrix for station `sid`, lead h (days), at day indices t (float array)."""
    s = fs.IDS.index(sid)
    y = arr[s]
    now = _at(y, t)
    X = [np.ones_like(t), now, now - _at(y, t - 1)]
    for u, hours in fs.UPSTREAM.get(sid, []):
        q = lev[fs.IDS.index(u)]
        lag = hours / 24
        src = np.minimum(t + h - lag, t)                 # what will arrive, as far as it is already measured
        X += [_at(q, src), _at(q, t) - _at(q, t - 1), _at(q, src) - _at(q, t - lag)]
    if sid in RAIN and eo is not None:
        from .flood_eo import CATCHMENTS
        n = min(eo["obs"].shape[1], eo["gfs"].shape[2])
        for c in RAIN[sid]:
            k = CATCHMENTS.index(c)

            def pick(a, i):
                i = i.astype(int)
                r = np.full(i.shape, np.nan)
                ok = (i >= 0) & (i < n)
                r[ok] = a[i[ok]]
                return r
            o, g = eo["obs"][k], eo["gfs"][:, k]

            def rain(day):                               # satellite rain of a past day, GFS's own figure if it is late
                v = pick(o, day)
                return np.where(np.isfinite(v), v, pick(g[0], day))

            def ahead(j):                                # forecast for day j+1; the run of the day before if today's is not in yet
                v = pick(g[j], t)
                return np.where(np.isfinite(v), v, pick(g[j + 1], t - 1)) if j + 1 < g.shape[0] else v
            y1 = pick(g[0], t - 1)                       # yesterday, as forecast
            y2, y34 = rain(t - 2), rain(t - 3) + rain(t - 4)
            fc = [ahead(j) for j in range(h)]
            fsum = np.sum(fc, axis=0)
            wet = y1 + y2 + y34
            X += [y1, y2, y34, fsum, fc[0] ** 1.5, fsum * np.sqrt(np.maximum(wet, 0))]   # wet ground runs off more
    return np.array(X).T


def _solve(X, d, lam=0.004):
    sc = X.std(0)
    sc[sc < 1e-6] = 1.0
    sc[0] = 1.0
    A = X / sc
    L = np.eye(A.shape[1]) * lam * len(A)
    L[0, 0] = 0
    return np.linalg.solve(A.T @ A + L, A.T @ d) / sc


def _calendar(n):
    d = [fs.index_day(i) for i in range(n)]
    return np.array([x.year for x in d]), np.array([x.month for x in d])


def _scores(o, p, per, lim):
    """Skill of forecast p (and of 'no change' per) against observed o."""
    sse = lambda a: float(((o - a) ** 2).sum())
    var = float(((o - o.mean()) ** 2).sum())

    def kge(a):
        r = np.corrcoef(o, a)[0, 1]
        return float(1 - np.sqrt((r - 1) ** 2 + (a.std() / o.std() - 1) ** 2 + (a.mean() / o.mean() - 1) ** 2))

    def events(a):
        ev, al = o >= lim, a >= lim
        hit, miss, false = int((ev & al).sum()), int((ev & ~al).sum()), int((~ev & al).sum())
        return {"events": int(ev.sum()), "hits": hit, "missed": miss, "false": false,
                "pod": round(hit / (hit + miss), 2) if hit + miss else None, "far": round(false / (hit + false), 2) if hit + false else None,
                "csi": round(hit / (hit + miss + false), 2) if hit + miss + false else None}
    out = {"days": int(o.size), "nse": round(1 - sse(p) / var, 2), "nse_same": round(1 - sse(per) / var, 2), "kge": round(kge(p), 2),
           "mae": round(float(np.abs(o - p).mean())), "rmse": round(float(np.sqrt(((o - p) ** 2).mean()))), "mae_same": round(float(np.abs(o - per).mean()))}
    if lim:
        ev = events(p)
        new = (o >= lim) & (per < lim)                   # floods not already under way
        ev["onsets"], ev["onsets_caught"] = int(new.sum()), int((new & (p >= lim)).sum())
        out["flood"], out["flood_same"] = ev, events(per)
    return out


REL_EDGES = (0.0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001)


def spread_of(pred, err, err_big, big_from):
    """Possible flows around one forecast, from past relative errors of forecasts of the same size."""
    e = np.asarray(err_big if pred >= big_from else err)
    return pred + e * max(pred, 5000)


def probability_scores(o, p, base, year, lim):
    """Brier score and reliability of 'the Low-flood limit will be reached'.

    Each season is scored with error samples from the other seasons, so the chances are as honest as the flows.
    Rivals: the usual frequency in the other seasons, and 'same side of the limit as today' said with certainty."""
    pr, clim, ok = np.full(o.size, np.nan), np.full(o.size, np.nan), np.zeros(o.size, bool)
    for y in np.unique(year):
        te, tr = year == y, year != y
        if tr.sum() < 100:
            continue
        rel = (o[tr] - p[tr]) / np.maximum(p[tr], 5000)
        cut = np.quantile(p[tr], 0.7)
        qs = np.linspace(0.02, 0.98, 49)
        e, eb = np.quantile(rel, qs), np.quantile(rel[p[tr] >= cut], qs)
        pr[te] = [float((spread_of(v, e, eb, cut) >= lim).mean()) for v in p[te]]
        clim[te] = (o[tr] >= lim).mean()
        ok |= te
    if not ok.any():
        return None
    y = (o >= lim)[ok].astype(float)
    pr, clim, same = pr[ok], clim[ok], (base >= lim)[ok].astype(float)
    b = lambda f: float(((f - y) ** 2).mean())
    bins = []
    for a, c in zip(REL_EDGES, REL_EDGES[1:]):
        m = (pr >= a) & (pr < c)
        bins.append([int(m.sum()), round(float(pr[m].sum()), 2), int(y[m].sum())])
    return {"n": int(y.size), "floods": int(y.sum()), "brier": round(b(pr), 4), "brier_usual": round(b(clim), 4), "brier_same": round(b(same), 4),
            "bss": round(1 - b(pr) / b(clim), 2) if b(clim) > 0 and y.sum() else None, "bss_same": round(1 - b(pr) / b(same), 2) if b(same) > 0 else None, "bins": bins}


def train(store, eo):
    """Leave-one-season-out skill, final coefficients and error samples for every station and lead."""
    arr, lev = series(store)
    n = arr.shape[1]
    yr, mo = _calendar(n)
    t = np.arange(n, dtype=float)
    out = {}
    for sid in TARGETS:
        s = fs.IDS.index(sid)
        lim = (fs.limits(sid) or {}).get("low")
        for h in LEADS:
            X = features(sid, h, arr, lev, eo, t)
            Y = np.full(n, np.nan)
            Y[:n - h] = arr[s][h:]
            base = X[:, 1]
            ok = np.isfinite(X).all(1) & np.isfinite(Y) & (mo >= 6) & (mo <= 10)
            seasons = [y for y in np.unique(yr[ok]) if (ok & (yr == y)).sum() >= 30]
            if ok.sum() < MIN_DAYS or len(seasons) < 3:
                out[f"{sid}:{h}"] = {"usable": False, "why": "fewer than three seasons of readings", "days": int(ok.sum())}
                continue
            pred = np.full(n, np.nan)
            for y in seasons:
                tr, te = ok & (yr != y), ok & (yr == y)
                pred[te] = np.maximum(base[te] + X[te] @ _solve(X[tr], Y[tr] - base[tr]), 0)
            m = np.isfinite(pred)
            sk = _scores(Y[m], pred[m], base[m], lim)
            # better than "no change" on large errors (NSE) and not worse on the typical day (MAE)
            use = sk["nse"] >= MIN_NSE and sk["nse"] > sk["nse_same"] and sk["mae"] <= 1.05 * sk["mae_same"]
            fl = sk.get("flood") or {}
            blind = fl.get("events", 0) >= 8 and (fl.get("pod") or 0) < 0.3      # good on quiet days, misses the floods
            use = use and not blind
            prob = probability_scores(Y[m], pred[m], base[m], yr[m], lim) if lim else None
            # relative errors by size of the forecast, used for ranges and probabilities
            rel = (Y[m] - pred[m]) / np.maximum(pred[m], 5000)
            big = pred[m] >= np.quantile(pred[m], 0.7)
            q = lambda e: [round(float(np.quantile(e, k)), 4) for k in np.linspace(0.02, 0.98, 49)]
            out[f"{sid}:{h}"] = {"usable": bool(use), "why": None if use else "misses most floods" if blind else "does not beat 'no change' by enough", "skill": sk, "prob": prob, "seasons": [int(y) for y in seasons],
                                 "coef": [float(c) for c in _solve(X[ok], Y[ok] - base[ok])],
                                 "err": q(rel), "err_big": q(rel[big]), "big_from": round(float(np.quantile(pred[m], 0.7)))}
    return out


def _path():
    return os.path.join(fs.root(), "routing.json")


def model(store, eo, force=False):
    """Trained model, rebuilt when a new month of data has come in."""
    key = f"{VERSION}|{date.today().strftime('%Y-%m')}|{'eo' if eo is not None else 'no-eo'}"
    if not force:
        try:
            with open(_path(), encoding="utf-8") as f:
                d = json.load(f)
            if d["key"] == key:
                return d
        except (OSError, ValueError, KeyError):
            pass
    d = {"key": key, "trained": date.today().isoformat(), "models": train(store, eo)}
    tmp = _path() + f".{uuid.uuid4().hex[:6]}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, separators=(",", ":"))
    os.replace(tmp, _path())
    return d


def forecast(store, eo, mdl, at=None):
    """Per station: flow now and 1-3 days ahead with a 10-90% range and the chance of reaching each FFD level."""
    arr, lev = series(store)
    last = arr.shape[1] - 1 if at is None else at
    out = {}
    for sid in TARGETS:
        s = fs.IDS.index(sid)
        # latest morning reading, at most two days old
        base = next((i for i in range(last, last - 3, -1) if i >= 0 and np.isfinite(arr[s, i])), None)
        if base is None:
            out[sid] = {"status": "no reading in the last two days", "leads": []}
            continue
        lim = fs.limits(sid)
        rows = []
        for h in LEADS:
            m = mdl["models"].get(f"{sid}:{h}") or {}
            if not m.get("usable"):
                rows.append({"lead": h, "date": fs.index_day(base + h).isoformat(), "status": "not skilful", "why": m.get("why")})
                continue
            x = features(sid, h, arr, lev, eo, np.array([float(base)]))[0]
            if not np.isfinite(x).all():
                rows.append({"lead": h, "date": fs.index_day(base + h).isoformat(), "status": "input missing"})
                continue
            q = max(float(x[1] + x @ np.array(m["coef"])), 0.0)
            spread = spread_of(q, m["err"], m["err_big"], m["big_from"])
            rows.append({"lead": h, "date": fs.index_day(base + h).isoformat(), "status": "ok", "q": round(q),
                         "lo": round(max(0.0, float(np.quantile(spread, 0.1)))), "hi": round(float(np.quantile(spread, 0.9))),
                         "tier": fs.tier(sid, q),
                         "prob": {k: round(float((spread >= lim[k]).mean()), 2) for k in PROB_TIERS if lim and lim[k] is not None}})
        out[sid] = {"status": "ok", "from": fs.index_day(base).isoformat(), "now": round(float(arr[s, base])), "leads": rows}
    return out
