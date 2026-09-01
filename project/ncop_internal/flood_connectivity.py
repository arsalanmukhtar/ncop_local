# project/ncop_internal/flood_connectivity.py
# ---------------------------------------------------------------------------
# Connected flood-fill (geodesic dilation) — the model fix that actually
# shipped from this session's rigorous model comparison (§R4), after
# flood_ca.py's from-scratch cellular-automata physics engine hit real,
# time-consuming numerical bugs (see that module's own status note).
#
# THE PROBLEM THIS SOLVES (confirmed live, §R4): applying a single uniform
# HAND threshold across a whole riverine reach flags any cell that is
# LOCALLY low relative to SOME nearby drainage line, even if that cell is
# nowhere near the actual river reach being modeled and water could never
# really reach it — the classic "leaky bathtub" problem. Confirmed live at
# Chashma: 75.4% of the entire bbox has HAND <= 4m (median HAND only
# 1.36m across the whole raster), producing an implausible 669.866 km2
# "flood-prone zone" for a real 4m gauge-derived threshold.
#
# THE FIX: don't test each cell against the threshold independently.
# Instead, flood a cell ONLY if it is reachable from a real seed (the
# stream network near the gauge/basin outlet) through an unbroken CHAIN of
# cells that are ALL at or below the target water level — a standard,
# simple, well-established technique (geodesic dilation / morphological
# reconstruction, and the same principle every real hydrodynamic and
# HAND-FIM connectivity-filtering step uses). A cell that's locally low
# but topologically cut off by higher ground in between structurally
# CANNOT be reached, by construction — no iterative physics, no
# convergence risk, no tunable numerical-stability parameters. Confirmed
# live below via a synthetic disconnected-basin test (exactly the
# scenario that broke the uniform-threshold approach).
#
# GENERIC: works for a SCALAR target level (riverine mode — the real
# gauge water-surface elevation applies uniformly across a short reach,
# the same standard simplification flood_model.compute_riverine_
# threshold_m's own docstring already documents) or a per-cell ARRAY
# target level (e.g. flash-flood's own existing allocated_stage raster,
# for a future comparison against the discharge-driven mode's current
# HAND<=stage test — not wired in this pass, per the explicit instruction
# not to touch that already-working code without further testing/sign-off).
# ---------------------------------------------------------------------------

import logging

import numpy as np

logger = logging.getLogger(__name__)

_DEFAULT_MAX_ITERATIONS = 5000


def connected_flood_fill(dem_arr, valid_mask, seed_mask, target_level,
                          max_iterations=_DEFAULT_MAX_ITERATIONS):
    """Floods every cell reachable from `seed_mask` through an unbroken
    8-connected chain of cells at or below `target_level` (a scalar
    applied everywhere, or an array the same shape as dem_arr for a
    per-cell target).

    Algorithm: start from `flooded = seed_mask & (dem <= target_level)`,
    then repeatedly grow `flooded` to include any 8-connected neighbor
    that ALSO satisfies `dem <= target_level`, until nothing new is added
    (a fixed point — guaranteed to terminate, since `flooded` only ever
    grows and is bounded by the raster's own cell count). This is
    "reconstruction by dilation," a standard image-processing/morphology
    technique — not a novel invention — chosen specifically because it
    has NO iterative-physics convergence risk, unlike flood_ca.py's own
    from-scratch CA engine (see that module's status note for the real
    numerical bugs found and not fully resolved there).

    Returns {"flooded_mask": bool array, "iterations_run": int,
    "converged": bool} — `converged=False` (hit max_iterations before the
    fixed point) would mean the flood region is still growing every
    iteration, which for any real, bounded catchment raster should not
    happen well before max_iterations; treated as a real, loud signal if
    it ever does, not silently accepted."""
    dem = np.asarray(dem_arr, dtype=np.float64)
    eligible = valid_mask & (dem <= target_level)

    flooded = seed_mask & eligible
    converged = False
    iterations_run = 0

    for iterations_run in range(1, max_iterations + 1):
        grown = flooded.copy()
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            grown |= np.roll(np.roll(flooded, dr, axis=0), dc, axis=1)
        new_flooded = grown & eligible

        if np.array_equal(new_flooded, flooded):
            converged = True
            break
        flooded = new_flooded

    if not converged:
        logger.error(
            "flood_connectivity: connected_flood_fill did not reach a fixed point within "
            "%d iterations — the flooded region was still growing every iteration up to the "
            "cap. For any real, bounded catchment raster this should not happen; treat the "
            "returned mask as a lower bound, not a final answer, and investigate.",
            max_iterations,
        )

    return {
        "flooded_mask": flooded,
        "iterations_run": iterations_run,
        "converged": converged,
    }


# ---------------------------------------------------------------------------
# Chamfer distance transform — the AHP distance-to-stream fix (Phase 2.5.2).
#
# THE PROBLEM THIS SOLVES (confirmed live): WhiteboxTools v2.4.0's dedicated
# distance tools are unreliable for this exact use case. `euclidean_distance`
# run directly on the streams raster returned an all-zero result everywhere
# (confirmed live on Nullah Lai's real streams raster). The documented
# workaround of allocating each stream cell's own X/Y coordinate via the
# separately-confirmed-working `euclidean_allocation`, then computing
# Euclidean distance in NumPy from the allocated coordinates, ALSO failed: a
# reproducible, data-independent bug where stream cells themselves come back
# NoData in the allocation output instead of propagating their own value —
# confirmed on ~3% of cells across all 4 pilot catchments, and confirmed
# NOT a value-magnitude artifact (an offset-to-small-range hypothesis was
# tested and falsified: identical failure count with raw longitude values
# ~72-73 and with the same values offset to ~0.0002-0.1999).
#
# THE FIX: reuse the exact same 8-connected multi-source expansion technique
# already proven correct above in connected_flood_fill, but track real
# accumulated distance instead of a boolean reachability flag — the
# standard "chamfer distance transform" (Borgefors 1986), a well-established
# approximation of the true Euclidean distance transform (orthogonal steps
# cost 1 cell, diagonal steps cost sqrt(2) cells, the classic weighting).
# No new external tool dependency, no per-cell magnitude sensitivity, 100%
# raster coverage by construction (every valid cell is reachable from SOME
# seed on a connected raster, unlike a coordinate-allocation scheme that can
# leave cells unallocated for reasons that were never fully explained).
# ---------------------------------------------------------------------------

def chamfer_distance_km(seed_mask, valid_mask, step_km_row, step_km_col,
                         max_iterations=_DEFAULT_MAX_ITERATIONS):
    """Multi-source approximate-Euclidean distance (km) from every True cell
    in `seed_mask` to every cell in `valid_mask`, via 8-connected chamfer
    expansion. `step_km_row`/`step_km_col` are the real real-world cell size
    in km along each raster axis (allowed to differ, e.g. latitude vs.
    longitude degree-to-km conversion at the catchment's own latitude) —
    the diagonal step cost is sqrt(step_km_row**2 + step_km_col**2), the
    correct anisotropic generalization of the classic sqrt(2) chamfer
    weighting.

    Returns a float64 array the same shape as seed_mask; cells inside
    `seed_mask` are exactly 0.0, cells outside `valid_mask` are np.inf.
    Converges to a fixed point (matching connected_flood_fill's own
    termination discipline) — logs an error and returns the best-so-far
    array if max_iterations is hit first, which for any real, bounded
    catchment raster should not happen."""
    dist = np.where(seed_mask, 0.0, np.inf)
    diag_km = float(np.hypot(step_km_row, step_km_col))
    steps = (
        (1, 0, step_km_row), (-1, 0, step_km_row),
        (0, 1, step_km_col), (0, -1, step_km_col),
        (1, 1, diag_km), (1, -1, diag_km), (-1, 1, diag_km), (-1, -1, diag_km),
    )

    converged = False
    for iterations_run in range(1, max_iterations + 1):
        new_dist = dist.copy()
        for dr, dc, step in steps:
            neighbor_dist = np.roll(np.roll(dist, dr, axis=0), dc, axis=1) + step
            new_dist = np.minimum(new_dist, neighbor_dist)
        new_dist = np.where(valid_mask, new_dist, np.inf)

        if np.array_equal(new_dist, dist):
            converged = True
            break
        dist = new_dist

    if not converged:
        logger.error(
            "flood_connectivity: chamfer_distance_km did not reach a fixed point within "
            "%d iterations — treat the returned distances as a lower bound, not a final "
            "answer, and investigate.",
            max_iterations,
        )

    return dist


def local_drainage_density(stream_mask, radius_cells, cell_size_km):
    """Local drainage density (km of stream per km^2) in a
    (2*radius_cells+1)^2 window centered on every cell — the standard
    Horton drainage-density measure (total channel length / basin area),
    computed at a MOVING-WINDOW scale rather than per-whole-basin, since
    this is an AHP per-pixel factor, not a single basin-level number.

    Approximates total stream length in each window as
    (stream-cell count in window) * cell_size_km — each stream cell
    stands in for roughly one cell-width of channel, a standard
    simplification consistent with how stream_mask itself was derived
    (extract_streams' own flow-accumulation threshold, one cell wide).

    Implementation: a 2D summed-area table (integral image) — O(1) per
    cell after one O(n) pass — computed in pure NumPy specifically to
    avoid adding scipy as a new dependency for a single box-filter
    operation, matching this project's own "avoid installs that aren't
    needed" discipline where a NumPy-only alternative is this simple.
    Edge cells get a smaller true window (zero-padded, not wrapped —
    unlike connected_flood_fill/chamfer_distance_km's np.roll-based
    expansion, wrapping would incorrectly pull in stream cells from the
    raster's opposite edge into a window near this edge)."""
    h, w = stream_mask.shape
    r = int(radius_cells)
    win = 2 * r + 1

    padded = np.pad(stream_mask.astype(np.float64), r, mode="constant", constant_values=0.0)
    s = np.cumsum(np.cumsum(padded, axis=0), axis=1)
    s = np.pad(s, ((1, 0), (1, 0)), mode="constant", constant_values=0.0)

    stream_cell_count = (
        s[win:win + h, win:win + w] - s[0:h, win:win + w]
        - s[win:win + h, 0:w] + s[0:h, 0:w]
    )

    # True window area per cell, accounting for edge clipping (a cell in
    # the corner has a smaller real window than win*win) — built the
    # same way, by box-summing an all-ones array, so the edge correction
    # is exact rather than approximate.
    ones_padded = np.pad(np.ones((h, w)), r, mode="constant", constant_values=0.0)
    s_ones = np.cumsum(np.cumsum(ones_padded, axis=0), axis=1)
    s_ones = np.pad(s_ones, ((1, 0), (1, 0)), mode="constant", constant_values=0.0)
    window_cell_count = (
        s_ones[win:win + h, win:win + w] - s_ones[0:h, win:win + w]
        - s_ones[win:win + h, 0:w] + s_ones[0:h, 0:w]
    )

    window_area_km2 = window_cell_count * (cell_size_km ** 2)
    stream_length_km = stream_cell_count * cell_size_km
    return np.where(window_area_km2 > 0, stream_length_km / window_area_km2, 0.0)


def box_mean_filter(arr, valid_mask, radius_cells):
    """Mean of `arr` within a (2*radius_cells+1)^2 window centered on
    every cell, counting only valid cells — the general-purpose sibling
    of local_drainage_density's own summed-area-table technique (same
    O(1)-per-cell-after-one-O(n)-pass method, same edge handling: zero-
    padded not wrapped, exact edge-window-size correction), generalized
    from "count of a boolean mask" to "mean of any continuous array".

    Built for flood_model.build_ahp_zone_geometries: a per-pixel AHP
    score is a weighted combination of several already-noisy, per-
    catchment-quantile-reclassified factors, and reclassifying that
    directly into discrete zone classes produces a boundary that
    "chatters" between classes at pixel granularity — confirmed live,
    this was found to make the resulting zone polygons too large/complex
    to serve even after aggressive post-hoc sieve+simplify (guddu_indus:
    doubling sieve/simplify 6 times only brought output from 5.5MB to
    2.9MB, not converging). Smoothing the CONTINUOUS score before
    classification (this function) is the standard, literature-
    consistent fix for exactly this class-boundary-noise problem —
    smoothing discrete class labels after the fact cannot remove
    genuine per-pixel classification noise the way smoothing the
    underlying continuous field first does.

    Invalid cells (outside `valid_mask`) do not contribute to the mean
    and do not themselves get a value assigned (caller applies
    valid_mask separately, matching every other reclassification
    function in this codebase)."""
    h, w = arr.shape
    r = int(radius_cells)
    win = 2 * r + 1

    masked_arr = np.where(valid_mask, arr, 0.0)
    padded_sum = np.pad(masked_arr.astype(np.float64), r, mode="constant", constant_values=0.0)
    s_sum = np.cumsum(np.cumsum(padded_sum, axis=0), axis=1)
    s_sum = np.pad(s_sum, ((1, 0), (1, 0)), mode="constant", constant_values=0.0)
    window_sum = (
        s_sum[win:win + h, win:win + w] - s_sum[0:h, win:win + w]
        - s_sum[win:win + h, 0:w] + s_sum[0:h, 0:w]
    )

    padded_count = np.pad(valid_mask.astype(np.float64), r, mode="constant", constant_values=0.0)
    s_count = np.cumsum(np.cumsum(padded_count, axis=0), axis=1)
    s_count = np.pad(s_count, ((1, 0), (1, 0)), mode="constant", constant_values=0.0)
    window_count = (
        s_count[win:win + h, win:win + w] - s_count[0:h, win:win + w]
        - s_count[win:win + h, 0:w] + s_count[0:h, 0:w]
    )

    return np.where(window_count > 0, window_sum / window_count, arr)
