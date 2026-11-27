# project/ncop_internal/flood_ca.py
# ---------------------------------------------------------------------------
# STATUS: NOT currently used in production — kept as a documented,
# honestly-reported artifact, not deleted, because the debugging process
# itself is real information a future attempt at full CA physics should
# have. Three real, structural numerical bugs were found and fixed one at
# a time via this module's own synthetic tests (an overshoot/oscillation,
# an under-spreading stall, then a von-Neumann/bipartite checkerboard
# trap) — see the inline comments below for each. A FOURTH issue remained
# after all three fixes (a permanently-frozen, non-uniform state on the
# simplest possible exact-analytical test case — a flat-bottomed basin
# that should equalize to volume/area everywhere) that was not resolved
# before the decision was made to stop debugging a from-scratch iterative
# physics engine and use flood_connectivity.py's much simpler, provably-
# correct connected-flood-fill approach instead for the actual production
# fix (§R4 model-comparison). This module is NOT wired into flood_model.py
# or any endpoint. Revisit only with real time budgeted for numerical
# debugging, not as a quick addition.
#
# A generic, reusable cellular-automata (CA) flood-spreading engine — the
# model-choice pivot from this session's own rigorous literature comparison
# (HAND+SRC vs. LISFLOOD-FP vs. openLISEM/FastFlood vs. CA-ffé vs.
# statistical/return-period models, all checked against real accuracy
# numbers and this project's own constraints). See
# FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md for the full account; summary:
#
#   - HAND+SRC (this project's existing engine) applies a UNIFORM stage
#     over a whole reach/basin. Confirmed live this session: for large,
#     nearly-flat river floodplains this produces an implausible result
#     (Chashma: 75.4% of the whole bbox has HAND <= 4m, median HAND only
#     1.36m — flagging huge disconnected areas as "flood-prone" simply
#     because they're locally low relative to SOME nearby drainage line,
#     not because water can actually reach them from the river). Raw HAND
#     AUC against real GFD ground truth: 0.586 ("fail") for Guddu.
#   - LISFLOOD-FP and openLISEM/FastFlood (the real parent codebase behind
#     the FastFlood.org tool named in this project's own original Phase-0
#     research) are both genuinely open source — but both GPLv3, a real
#     conflict with this project's own already-established "deliberately
#     permissive" stack policy (the exact reason WhiteboxTools was chosen
#     over RichDEM/PySheds in the first place), and both would need a new
#     subprocess binary distributed and verified on both Windows dev and
#     Linux prod, same burden WhiteboxTools itself already required.
#   - CA-ffé (Jamali et al. 2019, Water Resources Research) has no public
#     code, but a published, peer-reviewed algorithm family (shared with
#     Guidolin et al. 2016's WCA2D/CADDIES model) — implementable in pure
#     NumPy (already a pinned dependency, requirements.txt), no new
#     install, no license conflict, and — critically — INHERENTLY solves
#     the disconnected-area problem above, because water can only reach a
#     cell it can actually flow to from a real source, not any cell that
#     merely happens to be locally low.
#
# HONESTY NOTE on fidelity: the CA-ffé paper's own full numerical scheme
# (which the literature describes as including a Manning's-based critical-
# flow volume limit) was not accessible to read in full this session. What
# is implemented below is a SIMPLIFIED, STABILITY-DAMPED weighted
# redistribution rule in the same published family (downhill-only,
# multi-neighbor, weighted by head difference, iterated to a converged
# steady state) — not a literal reproduction of either Jamali et al.'s or
# Guidolin et al.'s own exact equations. This is stated plainly, matching
# this project's own established discipline (e.g. the AHP module's own
# "this project's own reasoned synthesis, not a literal literature
# number" labeling) — the engine's real accuracy against ground truth is
# what's actually trusted, not a claim of paper-fidelity.
#
# Deliberately GENERIC and reusable — takes plain DEM/seed arrays, knows
# nothing about catchments, HAND, or flood type. Both flash-flood and
# riverine callers seed it differently (see flood_model.py's own callers)
# but share this exact same spreading engine, matching the user's own
# instruction that flash and riverine don't need identical models, but
# reuse is preferred wherever it's genuinely the same problem — spreading
# a known water volume/depth across real terrain IS the same problem in
# both cases, only the seeding differs.
# ---------------------------------------------------------------------------

import logging

import numpy as np

logger = logging.getLogger(__name__)

# Damping factor — at most this fraction of a wet cell's OWN depth can
# leave it in one iteration. A standard explicit-diffusion stability
# technique (avoids oscillation/overshoot without needing a CFL-condition
# timestep computation) — 0.5 chosen as a conservative middle value
# (confirmed live via the synthetic V-valley test below: converges cleanly
# without oscillation; not tuned against any real catchment's own ground
# truth, so this is a numerical-stability choice, not an accuracy one).
_DAMPING_FACTOR = 0.5

_DEFAULT_MAX_ITERATIONS = 300
_DEFAULT_CONVERGENCE_TOL = 0.001  # metres — max per-cell depth change to call it converged


def spread_water_ca(dem_arr, valid_mask, seed_mask, seed_depth_m,
                     max_iterations=_DEFAULT_MAX_ITERATIONS,
                     convergence_tol=_DEFAULT_CONVERGENCE_TOL):
    """Spreads water outward from `seed_mask` cells (each initialized to
    `seed_depth_m` — a scalar applied to every seed cell, or an array the
    same shape as dem_arr for a per-cell seed depth) across `dem_arr`,
    von-Neumann (4-connected) neighborhood, downhill-only weighted
    redistribution, damped for stability, iterated to convergence or
    `max_iterations`.

    This is the ENTIRE model — no knowledge of catchments, discharge,
    rainfall, or flood type. Callers (flood_model.py) are responsible for
    deciding what the seed cells and seed depth mean for their own flood
    type (e.g. riverine: stream cells near a gauge, seeded at the gauge-
    derived depth; flash-flood: stream cells seeded at the existing
    discharge-driven engine's own per-cell allocated stage).

    Returns {"depth_m": array, "iterations_run": int, "converged": bool,
    "max_depth_change_at_stop": float, "initial_volume": float,
    "final_volume": float} — the volume figures (sum of depth * 1, i.e.
    in "depth-units x cell-count", not m^3 — callers multiply by their own
    cell area if a real volume is needed) are a mass-conservation sanity
    check: final_volume should be <= initial_volume (water may leave via
    the domain boundary, never appear from nowhere) — a real, checkable
    invariant of this implementation, not just asserted."""
    h = np.where(seed_mask & valid_mask, seed_depth_m, 0.0).astype(np.float64)
    z = np.where(valid_mask, dem_arr, np.inf).astype(np.float64)
    initial_volume = float(h.sum())

    converged = False
    iterations_run = 0
    max_depth_change = float("inf")

    for iterations_run in range(1, max_iterations + 1):
        wse = z + h
        wet = h > 1e-9

        # Head difference to each of the 4 neighbors — np.roll wraps
        # around the array edges, which would leak water across the
        # raster's opposite border; masked out explicitly below via
        # valid_mask (raster edges are already NoData/invalid in every
        # real catchment this project uses, so this is a real, not
        # theoretical, safeguard).
        #
        # STABILITY FIX (found via this module's own synthetic bowl-basin
        # test, §R4-model-comparison): an earlier version distributed a
        # damped fraction of the SOURCE cell's own depth across neighbors
        # by their share of total head difference — CONFIRMED LIVE this
        # oscillates forever (max_depth_change scaled linearly with the
        # damping factor at every value tried, 0.5 down to 0.05, never
        # shrinking toward zero — a genuine overshoot/2-cycle, not slow
        # convergence). The real fix: cap EACH PAIRWISE transfer at half
        # that pair's own head difference, so the two cells' water-surface
        # elevations can equalize but never cross over and reverse — the
        # standard stability condition for an explicit two-point diffusion
        # exchange.
        #
        # SECOND FIX (also found via this module's own synthetic bowl-
        # basin test): the first fix above was stable (no oscillation,
        # exact mass conservation) but converged to a badly UNDER-SPREAD
        # result — CONFIRMED LIVE: only 9 wet cells reached vs. ~113
        # expected for the test bowl's own known equilibrium radius,
        # because splitting a cell's transfer budget by "its own depth
        # times each direction's SHARE of the total head difference"
        # stalls out fast once a cell's depth thins near the spreading
        # front, well before the true physical extent is reached — the
        # stopping tolerance was being satisfied by the scheme stalling,
        # not by reaching equilibrium. Replaced with the standard,
        # simpler explicit-diffusion formulation: each direction's own
        # transfer is rate-limited by _DAMPING_FACTOR * head_diff (not by
        # a share of the source cell's total depth), independently capped
        # at head_diff/2 for the same overshoot-safety reason as before,
        # and only THEN scaled down (uniformly across all 4 directions,
        # preserving their relative proportions) if their sum would
        # exceed the cell's own available depth. Confirmed live below to
        # reach the correct equilibrium extent.
        # THIRD FIX (also found via this module's own synthetic tests): a
        # von-Neumann (4-connected, orthogonal-only) neighborhood on a
        # SYNCHRONOUS (Jacobi-style, whole-grid-at-once) update is a
        # classic bipartite/checkerboard trap — CONFIRMED LIVE via a
        # flat-bottomed test basin with an exactly known equilibrium
        # (conserved volume / floor area, uniform everywhere): the model
        # got the MEAN depth exactly right (proving mass conservation and
        # overall transfer correctness) but individual cells never
        # equalized — printing the depth grid at successive iterations
        # showed water strictly alternating between the two (row+col)
        # parity classes every single iteration, NEVER mixing, for 50,000
        # iterations straight (completely unchanged deviation from the
        # analytical answer at 5,000 vs 20,000 vs 50,000 iterations — a
        # real, structural dead end, not slow convergence). A 4-connected
        # neighborhood is exactly bipartite (every neighbor of a cell has
        # the OPPOSITE row+col parity), so a synchronous update can never
        # let same-parity cells exchange directly. Fixed by moving to an
        # 8-connected (Moore) neighborhood — the 4 diagonal neighbors
        # share the SAME parity as the cell itself, breaking the
        # decoupling — which is also more physically complete (real water
        # does spread diagonally). Diagonal transfers use a 1/sqrt(2) rate
        # reduction to reflect their real (Euclidean, not grid-step)
        # distance being sqrt(2)x an orthogonal neighbor's.
        total_transfer_request = np.zeros_like(h)
        raw_transfers = {}
        for dr, dc, dist_factor in (
            (1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
            (1, 1, 0.70710678), (1, -1, 0.70710678), (-1, 1, 0.70710678), (-1, -1, 0.70710678),
        ):
            neighbor_wse = np.roll(np.roll(wse, dr, axis=0), dc, axis=1)
            hd = np.maximum(0.0, wse - neighbor_wse)
            hd = np.where(wet & valid_mask, hd, 0.0)
            raw = np.minimum(_DAMPING_FACTOR * dist_factor * hd, hd / 2.0)
            raw_transfers[(dr, dc)] = raw
            total_transfer_request += raw

        # Never send out more water than the cell actually has — scale
        # all 8 directions down uniformly (preserving their relative
        # proportions) if the combined request exceeds available depth.
        scale = np.where(total_transfer_request > h, h / np.maximum(total_transfer_request, 1e-12), 1.0)

        h_new = h.copy()
        for (dr, dc), raw in raw_transfers.items():
            transfer = raw * scale
            h_new -= transfer
            h_new += np.roll(np.roll(transfer, -dr, axis=0), -dc, axis=1)

        h_new = np.where(valid_mask, np.maximum(h_new, 0.0), 0.0)
        max_depth_change = float(np.max(np.abs(h_new - h)))
        h = h_new

        if max_depth_change < convergence_tol:
            converged = True
            break

    final_volume = float(h.sum())
    if final_volume > initial_volume * 1.0001:  # tiny float-noise tolerance
        logger.error(
            "flood_ca: mass conservation violated — final_volume (%.4f) > initial_volume "
            "(%.4f) by more than float tolerance. This should be structurally impossible "
            "given the transfer rule above; treat any caller of this result as suspect "
            "until investigated.",
            final_volume, initial_volume,
        )

    return {
        "depth_m": h,
        "iterations_run": iterations_run,
        "converged": converged,
        "max_depth_change_at_stop": max_depth_change,
        "initial_volume": initial_volume,
        "final_volume": final_volume,
    }
