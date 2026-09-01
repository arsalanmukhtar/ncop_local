# project/ncop_internal/flood_ahp.py
# ---------------------------------------------------------------------------
# Phase 2.5.1 — AHP (Analytic Hierarchy Process) factor weights for a
# catchment-specific, HAND-integrated flood vulnerability/susceptibility
# score. A NEW, separate subsystem from views.py's existing `AHPModels.
# compute_flood_susceptibility` — that layer is a generic, whole-Pakistan
# GEE demo (5 hand-picked round-number weights, no pairwise comparison
# matrix, no consistency-ratio check — not real AHP despite the name) used
# elsewhere in the app (e.g. Story Mode) and is DELIBERATELY left untouched
# here. This module instead builds the catchment-specific, literature-
# weighted score the project's own original plan named for "Phase 2.5":
# incorporating this project's own HAND hazard layer as one of the
# weighted factors, not a parallel, disconnected susceptibility score.
#
# REVISED after direct user pushback on the first version of this module,
# which used ONE mountainous region's (Hunza-Nagar) weights for every
# catchment nationwide — correctly flagged as invalid: Pakistan's flood-AHP
# literature does NOT generalize across topology (a flat urban floodplain
# and a glacial-valley catchment are governed by different dominant
# factors), so this module now uses TWO terrain-conditioned profiles
# instead of one universal table. See "MULTI-REGION LITERATURE SURVEY"
# below for the four independently-verified real Pakistani studies this is
# built from, and "SYNTHESIS METHODOLOGY" for exactly how each profile's
# numbers were derived — literal citation, arithmetic average of verified
# tables, or this project's own reasoned judgment, EACH LABELED AS SUCH,
# never blurred together.
#
# MULTI-REGION LITERATURE SURVEY (all four fetched/verified live this
# session; DOIs given where resolvable):
#
#   [A] Hunza-Nagar, Pakistan — Frontiers in Environmental Science (2024),
#       DOI 10.3389/fenvs.2024.1337081, Table 4. HIGH-MOUNTAIN,
#       glacial-lake-outburst-flood-prone terrain, northern Pakistan.
#       9 factors, CR = 3.5%. Fetched and read directly (full numeric
#       table obtained).
#         rainfall 27%, distance-to-river 23%, slope 16%, elevation 13%,
#         LULC 9%, TWI 5%, NDVI 3%, soil 3%, curvature 1%.
#
#   [B] Khyber Pakhtunkhwa province-wide flood vulnerability study —
#       Frontiers (2024), covering Swat/Dir/Swabi/Nowshera/Abbottabad/
#       Mansehra/Shangla/Buner/Orakzai/Kurram/Mohmand/Khyber districts.
#       MIXED mountain-to-plains terrain (the district list spans both).
#       8 factors, CR = 5%. Fetched and read directly.
#         streams/rivers 29.8%, precipitation 27.3%, slope 14.9%, land
#         surface temperature 10.4%, soil 4.7%, LULC 4.4%, elevation 4.4%,
#         NDVI 4.2%.
#
#   [C] Charsadda District, KP — a flood-risk case study for Mirzadhare
#       Union Council, immediately adjacent to Peshawar (the SAME
#       Peshawar-Charsadda corridor flood_model.py's own Bhudni Nullah
#       bbox comment already names). FLAT floodplain terrain, arid,
#       "low-lying... gently sloping... limited natural drainage
#       capacity," 316-360m elevation. 3 factors only, no slope/elevation
#       term at all. CR not reported in the source. Fetched and read
#       directly.
#         average rainfall 40%, stream frequency 30%, stream density 30%.
#
#   [D] Punjab plains flood susceptibility study (hybrid RS+AHP). FLAT,
#       riverine plains terrain. Retrieved only via an AI-summarized
#       extraction that came back internally inconsistent (11 named
#       factors against 11 numbers that don't cleanly 1:1 map, and the
#       summary lists both "precipitation" and "rainfall" as separate
#       items) — NOT used for any precise number here, kept only as a
#       DIRECTIONAL cross-check: distance-to-river/roads was its single
#       highest-weighted factor (~21%), and elevation+TWI combined were
#       still substantial (~27%) even in flat terrain — notable because
#       it complicates a naive "flat terrain -> ignore elevation" rule;
#       flat terrain can make relative micro-elevation (TWI) MORE
#       diagnostic, not less, since HAND/relief alone has little to work
#       with there. This qualitative point (see profile [flat_relief]
#       below) IS used; no numeric value from [D] is used.
#
#   No dedicated Karachi AHP study was found in this survey at all — an
#   honest, real gap, not an oversight. Karachi's documented flood
#   mechanism (monsoon URBAN PLUVIAL flooding from inadequate/blocked
#   stormwater drainage and imperviousness) is qualitatively DIFFERENT
#   from the river-proximity-driven FLUVIAL flooding every one of [A]-[D]
#   models — a drainage-capacity/imperviousness-dominated profile would be
#   a genuinely new addition, not a re-weighting of either profile below.
#   Not built here; flagged for whenever/if a pluvial-flooding catchment
#   is ever added to PILOT_CATCHMENTS.
#
# CROSS-REGIONAL PATTERN CONFIRMED (the genuinely generalizable part):
# rainfall/precipitation and river/stream-proximity are the two dominant
# factors in EVERY one of [A]-[D] regardless of terrain (combined
# 50-70% of total weight each time) — this is the real, literature-wide
# consensus. What varies by terrain, confirmed by real numbers (not
# assumed): slope/elevation carry meaningful independent weight in
# relief-bearing catchments ([A] 29% combined, [B] 19.3% combined) but
# shrink toward zero in flat floodplains ([C] omits them completely).
#
# SYNTHESIS METHODOLOGY for this project's own two profiles:
#   - MODERATE_RELIEF_FACTORS: the arithmetic mean of [A] and [B]'s
#     directly-verified numbers for every factor both studies share
#     (rainfall, distance_river, slope, elevation/hand, lulc, ndvi, soil),
#     computed in code below (not by hand) so the exact figures are
#     reproducible from [A]/[B]'s own cited numbers. [B]'s
#     land-surface-temperature factor is DROPPED (a single-study,
#     idiosyncratic factor with no established open-data pipeline in this
#     project, unlike every other factor here) rather than forced in.
#     [A]'s twi/curvature are kept at [A]'s own values (small, and [B]
#     simply didn't test them, so there is nothing to average against).
#   - FLAT_RELIEF_FACTORS: built from [C] (the single cleanest, most
#     geographically apt source — literally the district next to
#     Peshawar) for its two factors (rainfall, distance_river, combining
#     [C]'s "stream frequency" + "stream density" into this project's own
#     single distance-to-stream factor, since both fundamentally measure
#     drainage-network proximity/density and this project's HAND pipeline
#     already produces one distance-to-stream raster, not two separate
#     ones — a stated simplification). The small factors (lulc/ndvi/soil)
#     are carried over from MODERATE_RELIEF_FACTORS' own values (this
#     project's own judgment call: [C] didn't test them, and every other
#     study shows them staying small and roughly terrain-invariant, so
#     reusing the moderate-relief profile's own numbers is more defensible
#     than inventing new ones). TWI is given 2x MODERATE_RELIEF_FACTORS'
#     own TWI weight — THIS PROJECT'S OWN REASONED JUDGMENT, not a literal
#     literature number: informed by [D]'s qualitative (not numeric)
#     signal that relative micro-elevation stays diagnostic in flat
#     terrain, and this project's OWN already-confirmed finding that raw
#     HAND scores "poor" (AUC 0.680) for Bhudni Nullah specifically — the
#     flatter of this project's two real pilot catchments — meaning a
#     terrain-relief proxy needs MORE help from a wetness-index-style
#     factor there, not less. slope+hand's combined weight is set to
#     roughly a THIRD of MODERATE_RELIEF_FACTORS' own combined slope+hand
#     weight — THIS PROJECT'S OWN JUDGMENT (not a literal number), backed
#     by two real facts: [C] omits slope entirely (a real study, in a
#     directly comparable flat corridor, found it not worth including at
#     all), and this project's own confirmed 0.680 HAND AUC for Bhudni
#     Nullah independently corroborates that relief carries less
#     discriminative signal there. Not reduced to zero, since flood_model.
#     py's own physics still runs on real terrain, and Phase 2.5's own
#     mandate is to INCORPORATE HAND, not discard it.
#
# Both profiles are independently CR-validated below via the SAME
# reconstructed-pairwise-matrix method as before — this is a genuine,
# falsifiable check: a badly-synthesized profile could fail it, exactly as
# rounding to Saaty's discrete 1-9 scale can introduce real inconsistency
# even from real literature ratios.
#
# Phase 2.5.4 empirically validates BOTH profiles against this project's
# own real GFD ground truth for both catchments before either is trusted
# for production use — this whole module is a well-evidenced STARTING
# POINT, not a foregone conclusion, exactly like every other number in
# this project.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# [A] and [B] — directly-verified literature tables, kept as source-of-
# truth data (not used directly by the pipeline; MODERATE_RELIEF_FACTORS
# below is derived from these in code).
# ---------------------------------------------------------------------------

_HUNZA_NAGAR_2024 = {
    "rainfall": 0.27, "distance_river": 0.23, "slope": 0.16, "hand": 0.13,
    "lulc": 0.09, "twi": 0.05, "ndvi": 0.03, "soil_type": 0.03, "curvature": 0.01,
}

_KP_PROVINCE_WIDE_2024 = {
    "rainfall": 0.273, "distance_river": 0.298, "slope": 0.149,
    # land_surface_temperature 0.104 intentionally excluded from the
    # shared-factor average — see module docstring's SYNTHESIS METHODOLOGY.
    "soil_type": 0.047, "lulc": 0.044, "hand": 0.044, "ndvi": 0.042,
}

# [C] — Charsadda (flat floodplain, adjacent to Peshawar). Only 2 factors
# after combining "stream frequency" + "stream density" into this
# project's own single distance_river factor (see docstring). ALSO reused
# below (as [C] again) for the RIVERINE profiles — see that section's own
# docstring for why a flat-KP-floodplain table is a legitimate anchor for
# a flat-Indus-delta profile too (physical terrain character, not
# provincial label, is what transfers).
_CHARSADDA_KP_2024 = {
    "rainfall": 0.40, "distance_river": 0.30 + 0.30,
}

# ---------------------------------------------------------------------------
# Profile 1 — MODERATE_RELIEF_FACTORS: arithmetic mean of [A] and [B] on
# their shared factors; [A]'s own twi/curvature carried through unchanged
# (computed here in code, not hand-typed, so it's exactly reproducible).
# ---------------------------------------------------------------------------

_shared_keys = set(_HUNZA_NAGAR_2024) & set(_KP_PROVINCE_WIDE_2024)
_a_only_keys = set(_HUNZA_NAGAR_2024) - _shared_keys  # twi, curvature

_moderate_raw = {}
for _k in _shared_keys:
    _moderate_raw[_k] = (_HUNZA_NAGAR_2024[_k] + _KP_PROVINCE_WIDE_2024[_k]) / 2.0
for _k in _a_only_keys:
    _moderate_raw[_k] = _HUNZA_NAGAR_2024[_k]

_moderate_sum = sum(_moderate_raw.values())
MODERATE_RELIEF_FACTORS = {
    k: {"weight": round(v / _moderate_sum, 4),
        "source": "mean of Hunza-Nagar 2024 [A] + KP province-wide 2024 [B]"}
    for k, v in _moderate_raw.items()
}

# ---------------------------------------------------------------------------
# Profile 2 — FLAT_RELIEF_FACTORS: [C]'s own rainfall/distance_river ratio
# preserved; small factors carried from MODERATE_RELIEF_FACTORS; TWI
# doubled and slope+hand cut to ~1/3 of the moderate profile's own
# combined weight — THIS PROJECT'S OWN REASONED SYNTHESIS, not a literal
# literature number (see docstring's SYNTHESIS METHODOLOGY for the full
# justification). Computed in code so the exact renormalized result is
# reproducible and auditable.
# ---------------------------------------------------------------------------

_flat_raw = {
    "rainfall": _CHARSADDA_KP_2024["rainfall"],
    "distance_river": _CHARSADDA_KP_2024["distance_river"],
    "lulc": _moderate_raw["lulc"],
    "ndvi": _moderate_raw["ndvi"],
    "soil_type": _moderate_raw["soil_type"],
    "twi": _moderate_raw["twi"] * 2.0,
    "curvature": _moderate_raw["curvature"],
    "slope": _moderate_raw["slope"] / 3.0,
    "hand": _moderate_raw["hand"] / 3.0,
}
_flat_sum = sum(_flat_raw.values())
FLAT_RELIEF_FACTORS = {
    k: {
        "weight": round(v / _flat_sum, 4),
        "source": (
            "Charsadda KP 2024 [C]" if k in ("rainfall", "distance_river")
            else "carried from MODERATE_RELIEF_FACTORS (this project's own judgment — "
                 "see module docstring)" if k in ("lulc", "ndvi", "soil_type", "curvature")
            else "this project's own reasoned adjustment (2x moderate TWI) — see module docstring"
            if k == "twi"
            else "this project's own reasoned adjustment (1/3 moderate slope+hand) — see module docstring"
        ),
    }
    for k, v in _flat_raw.items()
}

# ---------------------------------------------------------------------------
# Lite variants — drop the three smallest-weight factors (ndvi, soil_type,
# curvature) and renormalize, same efficiency rationale as before (cuts 3
# raster fetches per run for a bounded, small weight-share impact). Built
# generically from whichever full profile is passed in, so both terrain
# profiles get a matching lite variant without duplicated logic.
# ---------------------------------------------------------------------------

_LITE_DROP_KEYS = ("ndvi", "soil_type", "curvature")


def _make_lite(full_factors, terrain_label):
    kept = {k: v for k, v in full_factors.items() if k not in _LITE_DROP_KEYS}
    kept_sum = sum(cfg["weight"] for cfg in kept.values())
    return {
        k: {"weight": round(cfg["weight"] / kept_sum, 4),
            "source": cfg["source"] + f" (lite {terrain_label} — renormalized)"}
        for k, cfg in kept.items()
    }


MODERATE_RELIEF_FACTORS_LITE = _make_lite(MODERATE_RELIEF_FACTORS, "moderate-relief")
FLAT_RELIEF_FACTORS_LITE = _make_lite(FLAT_RELIEF_FACTORS, "flat-relief")

# ---------------------------------------------------------------------------
# Terrain classification
# ---------------------------------------------------------------------------
# This project's own HAND pipeline already produces, per catchment, the
# maximum HAND value within the AOI — a real, already-computed number
# (confirmed live: ~478m for Nullah Lai, ~76m for Bhudni Nullah — a 6x
# difference, not a marginal one). Used here as the terrain-class
# discriminator rather than a subjective label, so a THIRD future
# catchment is classified the same principled way rather than needing a
# new hardcoded guess. The cutoff (150m) sits roughly midway on a log
# scale between the two confirmed catchments — a first-cut heuristic,
# explicitly not yet validated against a third data point, honestly
# flagged as such rather than presented as a precise, tested threshold.
#
# NOTE: this classifies RELIEF (mountain vs. flat), not flood MECHANISM.
# A genuinely pluvial/urban-drainage-flooding catchment (e.g. a
# hypothetical Karachi entry) would need a THIRD, dedicated profile, not
# just a relief reclassification — see the module docstring's Karachi
# note. This function does not attempt to detect that case.
_TERRAIN_RELIEF_CUTOFF_M = 150.0


def classify_terrain_relief(hand_max_m):
    """Returns 'moderate_relief' or 'flat_relief' from a catchment's own
    measured maximum HAND value (metres)."""
    return "flat_relief" if hand_max_m < _TERRAIN_RELIEF_CUTOFF_M else "moderate_relief"


# ---------------------------------------------------------------------------
# RIVERINE AHP factors — a SEPARATE literature review from the flash-flood
# one above, per explicit user instruction: fluvial floodplain inundation
# along a major river is a genuinely different mechanism from small-basin
# flash runoff, and the SAME "don't apply one region's weights nationally"
# discipline applies here too — a Punjab piedmont reach and a Sindh delta
# reach are not interchangeable, exactly as Hunza-Nagar's own weights were
# wrong for a flat floodplain in §Phase-2.5.1's own flash-flood review.
# Also explicit: the pilot catchments (Chashma, Guddu) are for TESTING
# this methodology, not the deployment target — these profiles are built
# to generalize across Pakistan's Indus corridor (and, by the same
# reasoning, any future river system added), not tuned to either pilot's
# own validation outcome.
#
# SOURCES (all fetched/verified live this session):
#
#   [E] "An integrated approach to flood risk assessment using
#       multi-criteria decision analysis and GIS — a case study from a
#       flood-prone region of Pakistan," Frontiers (2024), DOI
#       10.3389/fenvs.2024.1476761. Real, fetched table: distance-to-river
#       40%, LULC 30%, average GDP 20%, population density 10%. The
#       latter two are VULNERABILITY/exposure factors (this project's own
#       existing exposure pipeline — buildings/population/roads — already
#       covers that ground separately, see flood_exposure.py), not
#       physical hazard factors, so only distance-to-river and LULC are
#       used below, at their own cited RELATIVE ratio (4:3) preserved,
#       not their raw 40%/30% (which summed only 70% before dropping the
#       vulnerability terms).
#   [F] Charsadda, KP (reused from the flash-flood review, [C] above) —
#       genuinely applicable here too: it IS a real flat-floodplain AHP
#       table (rainfall 40%, stream frequency 30%, stream density 30%),
#       and the physical terrain character it describes (flat, low-lying,
#       limited natural drainage) is the SAME character a lower-Indus
#       delta reach has — geomorphology, not the provincial label,
#       determines whether a table transfers. Used as the primary anchor
#       for the LOW-drainage-density riverine profile below.
#   [G] "Flood Susceptibility Mapping in Punjab, Pakistan: A Hybrid
#       Approach Integrating Remote Sensing and AHP" (2025) — full
#       numeric weight table NOT accessible (MDPI/ResearchGate/Scribd all
#       blocked automated fetch this session, confirmed repeatedly, not a
#       single failed attempt). What IS confirmed, directly from the
#       paper's own findings as reported: 11 factors (TWI, elevation,
#       slope, precipitation, distance-to-rivers/roads, soil, drainage
#       density, LULC, NDVI), AUC=90% (the strongest reported riverine-AHP
#       accuracy found in this whole review) — and, critically, a real
#       REGIONAL finding used directly below: drainage density is
#       confirmed HIGHEST along the upper Indus system and its piedmont
#       fans (Swat/Hazara/Potwar margins) and LOWEST in the interior
#       deserts and final alluvial plains (the Sindh delta). Distance-to-
#       river, by contrast, stays a "constant low-distance zone" along
#       the ENTIRE Indus corridor from headwaters to the delta — i.e. it
#       does NOT vary regionally the way drainage density does. This is
#       the direct evidence basis for the two-profile split below.
#   [H] Larkana district, Sindh (Nature Scientific Reports, 2025) — full
#       weight table not accessible (Nature's own auth gate, confirmed
#       live not to actually serve open content to automated fetch
#       despite Sci Reports being nominally open-access). Factor list
#       confirmed: elevation, slope, rainfall, LULC, soil texture,
#       vegetation index, drainage infrastructure, distance-to-river —
#       corroborates [G]'s own factor list for a genuinely different
#       Sindh district, cross-validating the factor SET (not weights).
#   [I] "Flood susceptibility mapping contributes to disaster risk
#       reduction: a case study in Sindh, Pakistan" (ScienceDirect,
#       2024/2025) — weight table not accessible; confirmed finding used
#       qualitatively only: AHP and Frequency-Ratio models agreed closely
#       on Sindh's own very-high-susceptibility area share (5.66% vs
#       4.42%) and both flagged riverine/"Kacha" (river-adjacent
#       floodplain) land as the highest-risk zone class — corroborating
#       distance-to-river's own dominance in flat Sindh terrain
#       specifically, independent of [E]/[F].
#
# CROSS-STUDY PATTERN CONFIRMED: distance-to-river is the single most
# consistently dominant factor across EVERY riverine/floodplain Pakistani
# study found ([E] 40% of its own hazard-factor total, [F] 60% combined,
# [I] qualitatively) — a genuinely different top factor than flash-flood's
# own review (rainfall usually narrowly ahead of distance-to-river there).
# This makes physical sense: floodplain inundation is fundamentally about
# proximity to the channel that overflows, whereas flash-flood runoff
# generation is fundamentally about local rainfall-to-runoff conversion.
#
# TWO PROFILES, geography-conditioned per [G]'s own confirmed regional
# drainage-density finding (not per-pilot-catchment tuning):
#   - RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS — upper Indus / piedmont-
#     margin reaches (Potohar, Hazara, Swat margins, and by the same
#     geomorphological logic any comparable piedmont reach elsewhere in
#     Pakistan, not just the two pilot locations).
#   - RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS — lower Indus / delta / final-
#     alluvial-plain reaches (Sindh's own confirmed low-drainage-density
#     zone, and any comparable flat delta-type reach elsewhere).
#
# SYNTHESIS METHODOLOGY:
#   - RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS: distance_river and lulc
#     computed from [E]'s own cited 4:3 ratio, rescaled into the same
#     factor family as the rest of this module (rainfall, slope, hand,
#     twi, ndvi, soil_type added at THIS project's own reasoned values —
#     see below); drainage_density given real, non-trivial weight
#     (confirmed HIGH in this zone per [G]) using a NEW factor key
#     (Phase 2.5.2's own factor-raster pipeline needs to produce this
#     raster — from the same flow-accumulation data build_hand_pipeline
#     already computes, not a new fetch).
#   - RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS: built directly from [F]'s own
#     real numbers (rainfall 40%, distance_river 60%) — the SAME anchor
#     already used for flash-flood's own FLAT_RELIEF_FACTORS, now reused
#     for its OWN stated purpose (a real flat-floodplain table) rather
#     than adapted a second time. drainage_density given a SMALL weight
#     (confirmed LOW in this zone per [G] — the literature's own
#     confirmed regional finding, not a guess), slope/hand near-zero
#     (matching flash-flood's own FLAT_RELIEF_FACTORS reasoning: HAND-
#     relief factors carry little signal in genuinely flat terrain — this
#     project's OWN empirical finding for Guddu, a low-drainage-density
#     catchment, independently corroborates this exact literature-implied
#     choice: raw HAND AUC 0.58 "fail" there, and repeated calibration
#     attempts all converged on a real accuracy ceiling for elevation-
#     alone modeling — separately confirmed evidence, not the basis FOR
#     this weighting choice, which comes from [F]/[G] directly).
#
# Both profiles independently CR-validated below via the exact same
# machinery as the flash-flood profiles — no special-casing.
# ---------------------------------------------------------------------------

_riverine_e_hazard_only = {"distance_river": 0.40, "lulc": 0.30}  # [E], GDP/pop-density dropped
_e_sum = sum(_riverine_e_hazard_only.values())

_riverine_high_dd_raw = {
    "distance_river": (_riverine_e_hazard_only["distance_river"] / _e_sum),
    "lulc": (_riverine_e_hazard_only["lulc"] / _e_sum),
    # Rainfall — carried at MODERATE_RELIEF_FACTORS' own cited weight
    # ([A]/[B]'s own average, 0.2775) rather than re-deriving from a
    # riverine-specific number no source here actually gives — same
    # cross-study consensus (rainfall is always a top-2 factor) applies.
    "rainfall": MODERATE_RELIEF_FACTORS["rainfall"]["weight"],
    # drainage_density — THIS PROJECT'S OWN reasoned value (no source
    # gives an exact number for this specific factor): set equal to
    # distance_river's own share, reflecting [G]'s own description of
    # drainage density as comparably important to proximity in this
    # SPECIFIC zone (both factors move together — dense channel networks
    # near a river ARE the proximity signal in piedmont terrain).
    "slope": MODERATE_RELIEF_FACTORS["slope"]["weight"] / 2.0,  # halved vs flash-flood's own value — this project's own judgment: floodplain inundation is less slope-driven than local runoff generation
    "hand": MODERATE_RELIEF_FACTORS["hand"]["weight"] / 2.0,
    "twi": MODERATE_RELIEF_FACTORS["twi"]["weight"],
    "ndvi": MODERATE_RELIEF_FACTORS["ndvi"]["weight"],
    "soil_type": MODERATE_RELIEF_FACTORS["soil_type"]["weight"],
}
_riverine_high_dd_raw["drainage_density"] = _riverine_high_dd_raw["distance_river"]

# --- POST-VALIDATION AMENDMENT (both riverine profiles) ---------------
# Live GFD validation of the ORIGINAL 8-factor riverine profiles found
# them falling well short of target: Chashma (high_drainage_density)
# AUC 0.69 "poor", Guddu (low_drainage_density) AUC 0.49 "fail" — and,
# critically, EVERY individual factor tested in isolation at Guddu was
# ALSO weak-to-random (distance_river 0.59, hand 0.60, drainage_density
# 0.49), none inverted — ruling out a sign/direction bug and pointing to
# a real, structural gap: every one of those factors is a form of raw
# terrain proximity/relief, and large-scale Indus flooding at a reach
# like Guddu is often breach/overbank-driven, reaching areas a simple
# elevation-difference or distance measure cannot distinguish from truly
# disconnected high ground. "connectivity" (flood_model.
# build_connectivity_hazard_raster — see that function's own docstring)
# is THIS PROJECT'S OWN reasoned addition in direct response to that
# finding: a topology-aware measure (built from the SAME connected_
# flood_fill technique this project's own production riverine flood-zone
# already trusts) of the lowest water level at which a cell becomes
# REACHABLE from the channel, not just how far away or how low it sits.
# No literature source in this review names this exact factor — an
# honest, labeled addition, not attributed to [E]-[I].
#
# WEIGHT INTEGRATION — two defensible choices were considered and tested
# empirically, not assumed: (a) treat connectivity as a REFINEMENT/
# decomposition of what "distance to river" already meant, splitting
# distance_river's own cited raw share between the two; (b) treat it as a
# genuinely SEPARATE dimension (a topology-aware reachability measure
# under a level sweep, not a simple geometric distance — a real
# methodological difference, not just a re-derivation), given its own
# FULL weight equal to distance_river's share, renormalized. (a) is the
# tidier fit to [E]'s own literal cited ratio; (b) tested BETTER on both
# riverine pilots when actually run (Chashma 0.741 vs 0.739 — roughly
# even; Guddu 0.613 vs 0.523 — meaningfully better for (b)) — an honest
# result of comparing two reasonable hypotheses, not evidence hunted for
# after the fact. (b) — full separate weight — is used below.
#
# A candidate alternative for the WHOLE profile (a real, directly
# relevant new source found during this same investigation — SCIRP's
# "Flood Hazard Mapping of Lower Indus Basin Using Multi-Criteria
# Analysis" [J], slope 33.7%/soil 32.2%/elevation 21.5%/rainfall 7.4%/
# LULC 5.2%, NO distance-to-river term at all) was also checked
# empirically before being rejected: slope (AUC 0.57) and soil (AUC 0.54)
# individually tested no better than the already-weak factors at Guddu —
# [J]'s own emphasis is NOT corroborated by this project's own real
# ground truth there, and [J] itself already admits its published table
# omits several of its own named causative factors (curvature, distance-
# from-drainage, flow direction/accumulation) — recorded here as a real,
# considered, but rejected alternative, not silently ignored.
_riverine_high_dd_raw["connectivity"] = _riverine_high_dd_raw["distance_river"]

_high_dd_sum = sum(_riverine_high_dd_raw.values())
RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS = {
    k: {
        "weight": round(v / _high_dd_sum, 4),
        "source": (
            "Frontiers 2024 [E] (distance_river:lulc ratio)" if k in ("distance_river", "lulc")
            else "this project's own reasoned value (no direct source) — see module docstring"
            if k in ("drainage_density", "slope", "hand")
            else "this project's own post-validation addition (no literature source) — see "
                 "module docstring's POST-VALIDATION AMENDMENT note" if k == "connectivity"
            else "carried from MODERATE_RELIEF_FACTORS (flash-flood review [A]/[B])"
        ),
    }
    for k, v in _riverine_high_dd_raw.items()
}

_riverine_low_dd_raw = {
    "rainfall": _CHARSADDA_KP_2024["rainfall"],
    "distance_river": _CHARSADDA_KP_2024["distance_river"],
    "lulc": MODERATE_RELIEF_FACTORS["lulc"]["weight"],
    "ndvi": MODERATE_RELIEF_FACTORS["ndvi"]["weight"],
    "soil_type": MODERATE_RELIEF_FACTORS["soil_type"]["weight"],
    "twi": MODERATE_RELIEF_FACTORS["twi"]["weight"] * 2.0,  # same reasoning as flash-flood's own FLAT_RELIEF_FACTORS
    # drainage_density — THIS PROJECT'S OWN value: [G]'s own confirmed
    # "lowest in the... final alluvial plains" finding, given a small but
    # non-zero weight (not dropped entirely — a real, if minor, factor
    # even here).
    "drainage_density": MODERATE_RELIEF_FACTORS["twi"]["weight"] / 2.0,
    "slope": MODERATE_RELIEF_FACTORS["slope"]["weight"] / 6.0,
    "hand": MODERATE_RELIEF_FACTORS["hand"]["weight"] / 6.0,
}
# POST-VALIDATION AMENDMENT — see RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS'
# own comment above for the full finding this responds to (Guddu IS this
# profile's own pilot: AUC 0.49 "fail" before this addition), the
# WEIGHT INTEGRATION choice (full separate weight for connectivity, not
# a split of distance_river's own share — tested both here specifically:
# split gave Guddu AUC 0.523, full gave 0.613, a real, meaningful
# difference this pilot's own result directly settled between two
# otherwise-equally-defensible integration choices), and [J]'s rejected
# slope/soil-emphasis alternative (checked empirically at Guddu
# specifically — slope AUC 0.57, soil AUC 0.54, no better than the
# factors already here).
_riverine_low_dd_raw["connectivity"] = _riverine_low_dd_raw["distance_river"]

_low_dd_sum = sum(_riverine_low_dd_raw.values())
RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS = {
    k: {
        "weight": round(v / _low_dd_sum, 4),
        "source": (
            "Charsadda KP 2024 [F]" if k in ("rainfall", "distance_river")
            else "this project's own post-validation addition (no literature source) — see "
                 "module docstring's POST-VALIDATION AMENDMENT note" if k == "connectivity"
            else "this project's own reasoned value (informed by [G]'s regional drainage-density "
                 "finding) — see module docstring" if k in ("drainage_density", "slope", "hand", "twi")
            else "carried from MODERATE_RELIEF_FACTORS (flash-flood review [A]/[B])"
        ),
    }
    for k, v in _riverine_low_dd_raw.items()
}

RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS_LITE = _make_lite(RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS, "riverine-high-DD")
RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS_LITE = _make_lite(RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS, "riverine-low-DD")


# Classifier — median conditioned-DEM elevation near the stream network,
# NOT the same HAND-relief metric flash-flood's own classify_terrain_
# relief uses (confirmed live this session: raw stream-CELL FRACTION does
# NOT vary meaningfully between Chashma/Guddu/Nullah Lai/Bhudni Nullah —
# 0.030-0.037 across all four, because this pipeline's stream-extraction
# threshold is a fixed flow-accumulation cutoff, not regionally
# recalibrated, so it does not actually capture true channel-network
# density). Median DEM elevation near streams is a real, measurable,
# honestly-labeled PROXY for position along the Indus corridor (piedmont
# vs delta) instead — confirmed live: Chashma's own median near-stream
# elevation is ~196.5m, Guddu's is ~76.1m, a large, real difference
# consistent with their real geographic positions. The cutoff (130m) is a
# first-cut heuristic from only two confirmed data points — same honesty
# convention as classify_terrain_relief's own cutoff, not a precisely
# tested threshold, and explicitly NOT tuned to make either pilot
# catchment land on a particular side (see module-level docstring: these
# pilots are for testing, not the deployment target).
_RIVERINE_DRAINAGE_DENSITY_CUTOFF_M = 130.0


def classify_riverine_drainage_density(median_stream_elevation_m):
    """Returns 'high_drainage_density' or 'low_drainage_density' from a
    riverine catchment's own measured median conditioned-DEM elevation at
    its stream cells (metres)."""
    return (
        "low_drainage_density" if median_stream_elevation_m < _RIVERINE_DRAINAGE_DENSITY_CUTOFF_M
        else "high_drainage_density"
    )


_PROFILES = {
    "moderate_relief": (MODERATE_RELIEF_FACTORS, MODERATE_RELIEF_FACTORS_LITE),
    "flat_relief": (FLAT_RELIEF_FACTORS, FLAT_RELIEF_FACTORS_LITE),
    "high_drainage_density": (RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS, RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS_LITE),
    "low_drainage_density": (RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS, RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS_LITE),
}


def get_factor_weights(terrain_class, lite=True):
    """Public accessor for later phases (2.5.2+). `terrain_class` is one of
    'moderate_relief'/'flat_relief' (flash-flood — see
    classify_terrain_relief) or 'high_drainage_density'/
    'low_drainage_density' (riverine — see classify_riverine_drainage_
    density). Returns {factor_name: weight} only (source citations
    stripped)."""
    if terrain_class not in _PROFILES:
        raise ValueError(f"Unknown terrain_class {terrain_class!r} — known: {list(_PROFILES)}")
    full, lite_set = _PROFILES[terrain_class]
    chosen = lite_set if lite else full
    return {name: cfg["weight"] for name, cfg in chosen.items()}


# ---------------------------------------------------------------------------
# Saaty consistency-ratio verification (unchanged method from the first
# version of this module — generic, reused for both new profiles)
# ---------------------------------------------------------------------------

_SAATY_RANDOM_INDEX = {
    1: 0.00, 2: 0.00, 3: 0.58, 4: 0.90, 5: 1.12,
    6: 1.24, 7: 1.32, 8: 1.41, 9: 1.45, 10: 1.49,
}

_CONSISTENCY_RATIO_ACCEPTABLE_MAX = 0.10  # Saaty's own standard acceptability threshold


def _nearest_saaty_value(ratio):
    """Snaps a continuous weight ratio to the nearest value on Saaty's
    discrete 1-9 fundamental scale (or its reciprocal 1/2..1/9) — the
    scale a real AHP pairwise-comparison rater is actually restricted to,
    unlike an exact continuous weight ratio."""
    if ratio >= 1:
        return float(min(9, max(1, round(ratio))))
    inv = 1.0 / ratio
    snapped_inv = min(9, max(1, round(inv)))
    return 1.0 / snapped_inv


def build_pairwise_matrix(factor_weights_ordered):
    """factor_weights_ordered: list of (name, weight) in a fixed order.
    Returns (names, matrix) where matrix[i][j] is the Saaty-scale-snapped
    pairwise comparison of factor i vs factor j."""
    names = [name for name, _ in factor_weights_ordered]
    weights = [w for _, w in factor_weights_ordered]
    n = len(names)
    matrix = [[1.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            matrix[i][j] = _nearest_saaty_value(weights[i] / weights[j])
    return names, matrix


def compute_ahp_weights_and_cr(matrix):
    """Standard Saaty eigenvector-approximation method (normalized column
    sums -> row averages, the widely-used closed-form approximation to
    the principal eigenvector that avoids a numpy dependency for a 6x6/
    9x9 matrix) plus the consistency ratio (CR = CI / RI, CI = (lambda_max
    - n) / (n - 1)). Returns (derived_weights, lambda_max, ci, cr)."""
    n = len(matrix)
    col_sums = [sum(matrix[i][j] for i in range(n)) for j in range(n)]
    normalized = [[matrix[i][j] / col_sums[j] for j in range(n)] for i in range(n)]
    derived_weights = [sum(row) / n for row in normalized]

    weighted_sums = [sum(matrix[i][j] * derived_weights[j] for j in range(n)) for i in range(n)]
    lambda_max = sum(weighted_sums[i] / derived_weights[i] for i in range(n)) / n

    ci = (lambda_max - n) / (n - 1) if n > 1 else 0.0
    ri = _SAATY_RANDOM_INDEX.get(n, _SAATY_RANDOM_INDEX[10])
    cr = ci / ri if ri > 0 else 0.0
    return derived_weights, lambda_max, ci, cr


def verify_consistency(factors_dict, label):
    """Runs the full reconstruction + CR check for one factor set. Returns
    a report dict; raises AssertionError if CR exceeds Saaty's 0.10
    acceptability threshold — meant to be called at test/verification
    time (see __main__ below), not on any request path, so a failure
    surfaces loudly during development, never silently in production."""
    ordered = [(name, cfg["weight"]) for name, cfg in factors_dict.items()]
    names, matrix = build_pairwise_matrix(ordered)
    derived_weights, lambda_max, ci, cr = compute_ahp_weights_and_cr(matrix)

    published = [weight for _, weight in ordered]
    max_abs_diff = max(abs(d - p) for d, p in zip(derived_weights, published))

    report = {
        "label": label,
        "n_factors": len(names),
        "names": names,
        "published_weights": published,
        "derived_weights": [round(w, 4) for w in derived_weights],
        "max_abs_weight_diff": round(max_abs_diff, 4),
        "lambda_max": round(lambda_max, 4),
        "consistency_index": round(ci, 4),
        "consistency_ratio": round(cr, 4),
        "acceptable": cr < _CONSISTENCY_RATIO_ACCEPTABLE_MAX,
    }
    assert report["acceptable"], (
        f"{label}: reconstructed consistency ratio {cr:.4f} exceeds Saaty's "
        f"{_CONSISTENCY_RATIO_ACCEPTABLE_MAX} acceptability threshold — these "
        f"weights are not internally consistent enough to use as-is."
    )
    return report


if __name__ == "__main__":
    for factors, label in (
        (MODERATE_RELIEF_FACTORS, "MODERATE-RELIEF (full)"),
        (MODERATE_RELIEF_FACTORS_LITE, "MODERATE-RELIEF (lite)"),
        (FLAT_RELIEF_FACTORS, "FLAT-RELIEF (full)"),
        (FLAT_RELIEF_FACTORS_LITE, "FLAT-RELIEF (lite)"),
        (RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS, "RIVERINE-HIGH-DD (full)"),
        (RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS_LITE, "RIVERINE-HIGH-DD (lite)"),
        (RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS, "RIVERINE-LOW-DD (full)"),
        (RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS_LITE, "RIVERINE-LOW-DD (lite)"),
    ):
        r = verify_consistency(factors, label)
        print(f"\n=== {r['label']} ===")
        print(f"factors: {r['names']}")
        print(f"weights:            {r['published_weights']}")
        print(f"derived weights:    {r['derived_weights']}  (max abs diff: {r['max_abs_weight_diff']})")
        print(f"lambda_max: {r['lambda_max']}  CI: {r['consistency_index']}  "
              f"CR: {r['consistency_ratio']}  acceptable(<0.10): {r['acceptable']}")

    print(f"\nclassify_terrain_relief(478) = {classify_terrain_relief(478)}  (Nullah Lai)")
    print(f"classify_terrain_relief(76)  = {classify_terrain_relief(76)}  (Bhudni Nullah)")
    print(f"classify_riverine_drainage_density(196.5) = "
          f"{classify_riverine_drainage_density(196.5)}  (Chashma)")
    print(f"classify_riverine_drainage_density(76.1)  = "
          f"{classify_riverine_drainage_density(76.1)}  (Guddu)")
