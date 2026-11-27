# project/ncop_internal/flood_inertial.py
# ---------------------------------------------------------------------------
# Two-dimensional flood spreading: the local inertial form of the shallow
# water equations (Bates, Horritt & Fewtrell 2010, J. Hydrology 387, 33-45;
# q-centred damping of de Almeida et al. 2012, Water Resources Research 48,
# W05528). Same published equations LISFLOOD-FP uses; own code, numpy only, no
# licence or binary needed.
#
# Only the wet window of the grid is computed, so a 250,000-cell valley takes
# minutes. Water volume is conserved to rounding (tested). Used offline by
# flood_hydraulic.py; nothing in the app calls it during a request.
# ---------------------------------------------------------------------------

import numpy as np

G = 9.81
WET = 1e-3


def simulate(z, n, dx, dy, inflow, src, hours, theta=0.8, alpha=0.65, arrive=0.1):
    """z, n: bed level (m) and Manning n per cell. inflow(t s) -> m3/s spread over the `src` cells.
    Returns maximum depth (m), hour of first water deeper than `arrive`, maximum speed (m/s) and the volume balance."""
    z = z.astype(np.float32)
    n = n.astype(np.float32)
    ny, nx = z.shape
    h = np.zeros_like(z)
    qx, qy = np.zeros((ny, nx + 1), np.float32), np.zeros((ny + 1, nx), np.float32)
    depth, speed, first = np.zeros_like(z), np.zeros_like(z), np.full_like(z, np.nan)
    area = dx * dy
    sr, sc = np.array([s[0] for s in src]), np.array([s[1] for s in src])
    r0, r1, c0, c1 = max(sr.min() - 4, 0), min(sr.max() + 5, ny), max(sc.min() - 4, 0), min(sc.max() + 5, nx)
    t, end, steps, vin, vout = 0.0, hours * 3600.0, 0, 0.0, 0.0
    while t < end:
        H, Z, N = h[r0:r1, c0:c1], z[r0:r1, c0:c1], n[r0:r1, c0:c1]
        dt = min(alpha * min(dx, dy) / float(np.sqrt(G * max(float(H.max()), 0.3))), end - t, 300.0)
        eta = Z + H
        for q, ax, d in ((qx[r0:r1, c0 + 1:c1], 1, dx), (qy[r0 + 1:r1, c0:c1], 0, dy)):
            a = (slice(None), slice(1, None)) if ax else (slice(1, None), slice(None))
            b = (slice(None), slice(None, -1)) if ax else (slice(None, -1), slice(None))
            hf = np.maximum(eta[a], eta[b]) - np.maximum(Z[a], Z[b])
            m = hf > WET
            hf = np.where(m, hf, 1.0)
            qo = q.copy()
            qc = qo.copy()
            i, j, k = ((slice(None), slice(1, -1)), (slice(None), slice(None, -2)), (slice(None), slice(2, None))) if ax else (slice(1, -1), slice(None, -2), slice(2, None))
            qc[i] = theta * qo[i] + (1 - theta) / 2 * (qo[j] + qo[k])
            nf = 0.5 * (N[a] + N[b])
            new = (qc - G * hf * dt * (eta[a] - eta[b]) / d) / (1 + G * dt * nf * nf * np.abs(qo) / hf ** (7 / 3))
            lim = hf * np.sqrt(G * hf)                          # never faster than a free overfall
            q[:] = np.where(m, np.clip(new, -lim, lim), 0)
        fx, fy = qx[r0:r1, c0:c1 + 1], qy[r0:r1 + 1, c0:c1]
        # a cell cannot give away more water than it holds
        out = (np.maximum(fx[:, 1:], 0) - np.minimum(fx[:, :-1], 0)) * dt / dx + (np.maximum(fy[1:], 0) - np.minimum(fy[:-1], 0)) * dt / dy
        k = np.where(out > H, H / np.maximum(out, 1e-9), 1.0).astype(np.float32)
        if (k < 1).any():
            kx, ky = np.ones_like(fx), np.ones_like(fy)
            kx[:, 1:] = np.where(fx[:, 1:] > 0, k, 1)
            kx[:, :-1] = np.where(fx[:, :-1] < 0, k, kx[:, :-1])
            ky[1:] = np.where(fy[1:] > 0, k, 1)
            ky[:-1] = np.where(fy[:-1] < 0, k, ky[:-1])
            fx *= kx
            fy *= ky
        H += dt * ((fx[:, :-1] - fx[:, 1:]) / dx + (fy[:-1] - fy[1:]) / dy)
        Q = float(inflow(t))
        vin += Q * dt
        h[sr, sc] += Q * dt / (area * sr.size)
        for edge in ((slice(None), 0), (slice(None), -1), (0, slice(None)), (-1, slice(None))):      # open outer edges
            vout += float(h[edge].sum(dtype=np.float64)) * area
            h[edge] = 0
        np.maximum(H, 0, out=H)
        t += dt
        steps += 1
        np.maximum(depth[r0:r1, c0:c1], H, out=depth[r0:r1, c0:c1])
        f = first[r0:r1, c0:c1]
        f[np.isnan(f) & (H > arrive)] = t / 3600
        if steps % 20 == 0:
            v = np.where(H > 0.1, np.hypot(0.5 * (fx[:, 1:] + fx[:, :-1]), 0.5 * (fy[1:] + fy[:-1])) / np.maximum(H, 0.1), 0)
            np.maximum(speed[r0:r1, c0:c1], v, out=speed[r0:r1, c0:c1])
            wet = h > WET
            rr, cc = np.flatnonzero(wet.any(1)), np.flatnonzero(wet.any(0))
            if rr.size:
                r0, r1 = max(min(r0, rr[0] - 25), 0), min(max(r1, rr[-1] + 26), ny)
                c0, c1 = max(min(c0, cc[0] - 25), 0), min(max(c1, cc[-1] + 26), nx)
    return {"depth": depth, "arrive": first, "speed": speed, "h": h, "steps": steps, "vin": vin, "vout": vout, "stored": float(h.sum(dtype=np.float64)) * area}


def hydrograph(peak, base, rise_h=36.0, hold_h=12.0, half_h=48.0):
    """Design flood wave (m3/s): straight rise, short hold, then halving every `half_h` towards the base flow."""
    def q(t):
        x = t / 3600
        if x <= rise_h:
            return base + (peak - base) * x / rise_h
        if x <= rise_h + hold_h:
            return peak
        return base + (peak - base) * 0.5 ** ((x - rise_h - hold_h) / half_h)
    return q


def series(ts, qs):
    """Observed hydrograph: seconds and m3/s."""
    return lambda t: float(np.interp(t, ts, qs))


def job(args):
    """Process-pool entry: one simulation from plain arrays."""
    z, n, dx, dy, spec, src, hours = args
    flow = hydrograph(*spec[1:]) if spec[0] == "design" else series(spec[1], spec[2])
    r = simulate(z, n, dx, dy, flow, src, hours)
    r.pop("h")
    return r
