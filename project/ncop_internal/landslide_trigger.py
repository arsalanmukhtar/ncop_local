# project/ncop_internal/landslide_trigger.py
# ---------------------------------------------------------------------------
# L4 — Rainfall-triggered dynamic early warning (LANDSLIDE_EARLY_WARNING_
# METHODOLOGY.md §6/§13-L4). A new, small, standalone module — mirrors
# flood_forecast.py's own "one hazard-specific module, not folded into the
# main model file" convention, not the model/AHP files.
#
# Two real, complementary inputs combined via a decision matrix (a lookup,
# not a solver, per §6's own framing):
#   1. A live/forecast/observed rainfall reading, via flood_forecast.
#      resolve_rainfall_scenario — reused COMPLETELY UNMODIFIED (zero new
#      fetch code; the same CHIRPS/PMD-Forecast/live-observed dispatcher
#      flood's own discharge-driven mode already uses).
#   2. L1's own static susceptibility class, via landslide_model.
#      static_susceptibility_summary.
#
# The ID-threshold curve itself: I = 73.90 * D^-0.79 (Kashmir Himalaya,
# 193 rainfall-associated landslides — see methodology doc §3.5),
# explicitly a REGIONALLY-TRANSFERRED default, not independently re-fit
# for Murree/Galyat specifically — the same honesty this project's own
# flood work already applied to every literature-transferred parameter
# (CN values, HSG assumptions) it used.
#
# Production-readiness note (§12, checked against the real nginx conf):
# run_landslide_trigger() calls resolve_rainfall_scenario, a REAL external
# network fetch (CHIRPS/GEE, PMD Monitor, or NWFC depending on `source`)
# — never call this synchronously from a request handler once L5 wires
# it up, the same async-job-first requirement every other L1-L3 function
# in this hazard's own module tree already carries.
# ---------------------------------------------------------------------------

import logging

logger = logging.getLogger(__name__)

# Kashmir Himalaya intensity-duration threshold curve (§3.5): fitted from
# 193 rainfall-associated landslides. I in mm/hr, D in hours. The closest
# confirmed regional match to Murree/Galyat/AJK of anything found in this
# session's literature review — a real improvement over the global Caine
# (1980) envelope, but still regionally-transferred, not re-derived for
# this exact pilot catchment.
_KASHMIR_ID_CURVE_COEFF = 73.90
_KASHMIR_ID_CURVE_EXPONENT = -0.79

# The source paper's own dataset is real triggering EVENTS, not an
# arbitrary duration range - extrapolating the curve to a near-zero
# duration produces an unbounded, physically-meaningless intensity
# (D^-0.79 -> infinity as D -> 0), and extrapolating to a very long
# duration eventually produces a threshold below what could ever fall as
# genuine rain. Bounded to a broad, literature-plausible storm-duration
# window (0.5-240h, i.e. 30 minutes to 10 days) rather than left
# unbounded - a real, named engineering guard, not a claim this range
# itself is independently cited.
_ID_CURVE_MIN_DURATION_HR = 0.5
_ID_CURVE_MAX_DURATION_HR = 240.0


def kashmir_id_threshold_mm_hr(duration_hr):
    """The Kashmir Himalaya ID-threshold curve's own intensity value
    (mm/hr) for a given storm duration (hr): I = 73.90 * D^-0.79.

    Raises ValueError for a duration outside the bounded, literature-
    plausible window (see _ID_CURVE_MIN_DURATION_HR/_MAX's own comment)
    — this is a deliberate guard against a meaningless extrapolation,
    not a silently-clamped value."""
    if duration_hr is None or duration_hr <= 0:
        raise ValueError(f"duration_hr must be positive, got {duration_hr!r}")
    if not (_ID_CURVE_MIN_DURATION_HR <= duration_hr <= _ID_CURVE_MAX_DURATION_HR):
        raise ValueError(
            f"duration_hr={duration_hr} is outside the ID curve's bounded, "
            f"literature-plausible window [{_ID_CURVE_MIN_DURATION_HR}, "
            f"{_ID_CURVE_MAX_DURATION_HR}]h — refusing to extrapolate further"
        )
    return _KASHMIR_ID_CURVE_COEFF * (duration_hr ** _KASHMIR_ID_CURVE_EXPONENT)


def evaluate_id_threshold(rainfall_mm, duration_hr):
    """The actual trigger check: intensity_mm_hr = rainfall_mm /
    duration_hr, compared against kashmir_id_threshold_mm_hr(duration_hr).

    Returns {"intensity_mm_hr", "threshold_mm_hr", "exceeded" (bool),
    "ratio" (intensity/threshold — >=1.0 means exceeded, a continuous
    "how close" figure a caller can use beyond the bare bool)}."""
    if rainfall_mm is None or rainfall_mm < 0:
        raise ValueError(f"rainfall_mm must be non-negative, got {rainfall_mm!r}")
    threshold = kashmir_id_threshold_mm_hr(duration_hr)
    intensity = rainfall_mm / duration_hr
    return {
        "intensity_mm_hr": round(intensity, 3),
        "threshold_mm_hr": round(threshold, 3),
        "exceeded": intensity >= threshold,
        "ratio": round(intensity / threshold, 3),
    }


# Decision matrix (§6): (dominant static-susceptibility class,
# ID-threshold exceeded) -> advisory level. A lookup, not a solver,
# mirroring how Pakistan's own PMD/NDMA public advisories already
# structure their messaging (§6's own framing) — this project's own
# reasoned combination, not itself a cited literature table (no
# published Pakistani landslide EWS decision matrix was found live,
# see methodology doc §3.7's own "no competing operational system
# found" finding). Even a LOW-susceptibility catchment crossing the
# real regional ID threshold is deliberately not "Normal" — rainfall
# intensity alone is a real trigger signal worth a Watch, not silently
# suppressed just because the static layer is low.
LANDSLIDE_ADVISORY_MATRIX = {
    ("high", True): "Warning",
    ("high", False): "Watch",
    ("medium", True): "Watch",
    ("medium", False): "Normal",
    ("low", True): "Watch",
    ("low", False): "Normal",
}


def run_landslide_trigger(catchment_key, source, lite=True, force=False,
                           chirps_days=1, pmd_element="daytpe"):
    """L4 deliverable: combines a real rainfall reading (flood_forecast.
    resolve_rainfall_scenario, reused unmodified) with the Kashmir
    Himalaya ID-threshold check and L1's own static susceptibility class
    into one decision-matrix advisory.

    `source` is one of flood_forecast.RAINFALL_SOURCES minus "manual"
    ("chirps"/"pmd_forecast"/"live_observed") — the same three real
    sources flood's own discharge-driven mode already uses, same
    dispatcher, zero new fetch code.

    Raises ValueError if the rainfall source itself has no data right
    now — matching resolve_rainfall_scenario's own convention (the one
    place a fetcher's degrade-to-None becomes a hard, catchable
    failure), never silently fabricating an advisory from missing data.
    A source having no data right now is a real, expected condition for
    at least one of the three sources at any given moment (see each
    fetcher's own docstring in flood_forecast.py) — a caller wiring this
    into a UI (L5) should let the user pick a different source, not
    treat this as a crash.

    Never call synchronously from a request handler once L5 wires this
    up — resolve_rainfall_scenario is a real external network call.

    Returns {"catchment", "source", "rainfall": {...resolve_rainfall_
    scenario's own result...}, "id_threshold": {...evaluate_id_
    threshold's own result...}, "static_susceptibility": {...static_
    susceptibility_summary's own result...}, "advisory"}."""
    from . import flood_forecast, landslide_model

    landslide_model.ensure_registered_with_flood_model(catchment_key)

    rainfall = flood_forecast.resolve_rainfall_scenario(
        catchment_key, source, chirps_days=chirps_days, pmd_element=pmd_element,
    )
    id_result = evaluate_id_threshold(rainfall["rainfall_mm"], rainfall["duration_hr"])
    static = landslide_model.static_susceptibility_summary(catchment_key, lite=lite, force=force)

    advisory = LANDSLIDE_ADVISORY_MATRIX[(static["dominant_class"], id_result["exceeded"])]

    return {
        "catchment": catchment_key,
        "source": source,
        "rainfall": rainfall,
        "id_threshold": id_result,
        "static_susceptibility": static,
        "advisory": advisory,
    }
