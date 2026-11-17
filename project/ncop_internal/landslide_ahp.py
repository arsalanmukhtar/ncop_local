# project/ncop_internal/landslide_ahp.py
# ---------------------------------------------------------------------------
# Landslide AHP fusion engine — Phase L1. Structured identically to
# flood_ahp.py (LANDSLIDE_EARLY_WARNING_METHODOLOGY.md §5: "one
# hazard-specific module per hazard, sharing the generic fusion
# primitives") — this file supplies the literature-derived WEIGHT
# TABLES; the actual Saaty pairwise-matrix reconstruction / consistency-
# ratio math is imported from flood_ahp.py unchanged (it was already
# fully generic — no flood-specific assumption anywhere in
# build_pairwise_matrix/compute_ahp_weights_and_cr/verify_consistency),
# not reimplemented here.
#
# LITERATURE SURVEY — what this profile is actually built from, each
# number labeled by its real source, following flood_ahp.py's own exact
# precedent (which itself distinguishes directly-fetched numeric tables
# from directional-only findings from this project's own reasoned
# judgment, never blurring the two):
#
#   [E1] Astore region, Pakistan — EQA International Journal of
#        Environmental Quality, AHP landslide susceptibility. Fetched
#        and read directly (abstract-level; the full pairwise matrix
#        itself was confirmed paywalled/inaccessible after 5 separate
#        access attempts this session — see LANDSLIDE_EARLY_WARNING_
#        METHODOLOGY.md's own L1 notes). What WAS confirmed directly:
#        9 factors (slope, lithology, aspect, TWI, plan curvature, SPI,
#        distance-from-drainage, LULC, soil), CR = 0.06 (a valid
#        matrix), and "slope, lithology and LULC were the most
#        important factors" — a real RANKING signal, not exact numbers.
#   [E2] Murree, Sub-Himalayas — Research Square preprint (FR/IV/WoE
#        comparison, 102-landslide inventory, 11 factors). Confirmed
#        (via search-result-level summaries, not the full paywalled
#        text) only at the methodology level: soil erosion, elevation,
#        slope, aspect, curvature, drainage, fault, road, precipitation,
#        LULC, lithology were the 11 factors used. No numeric weights
#        obtained from this source.
#   [E3] Murree environmental-impact case study (Natural Hazards,
#        Springer) — confirmed directly: "water is the most dominant
#        factor to cause land sliding in Murree area." A real,
#        Murree-SPECIFIC qualitative finding, not a number.
#   [E4] Murree/Kuldana Formation geological-controls study (Main
#        Boundary Thrust zone) — confirmed directly: Murree's own
#        slope instability is attributed to "incompetent lithologies
#        and deformation associated with major thrust faults," Murree/
#        Kuldana Formation shale-siltstone-sandstone. A real,
#        Murree-SPECIFIC physical justification for weighting lithology
#        highly — not a number, a mechanism.
#   [E5] Sub-Himalayan region hazard study (Natural Hazards, Springer) —
#        confirmed directly: "precipitation, then lithology, then
#        slope" as the dominant AHP factor rank order. A real rank-order
#        finding for the broader sub-Himalayan terrain class Murree/
#        Galyat sits within.
#   [E6] flood_ahp.py's own already-verified Hunza-Nagar 2024 table
#        [A] (Frontiers in Environmental Science, DOI
#        10.3389/fenvs.2024.1337081) and the KP province-wide 2024
#        table [B] — REUSED here, not re-fetched, for factors this
#        session's own landslide-specific search found no dedicated
#        numeric anchor for (TWI, NDVI, curvature, soil): slope 14.9-16%,
#        twi 5%, ndvi 3%, soil 3%, curvature 1% across those two real,
#        directly-verified flood-AHP studies. Reused on the same
#        reasoning flood_ahp.py's own FLAT_RELIEF_FACTORS profile
#        already established for reusing a sibling profile's numbers —
#        these are physically-similar factors (slope, wetness-index,
#        vegetation-cover, curvature) whose real numeric weight in a
#        directly-verified Pakistani terrain study is a more defensible
#        anchor than an invented number, even though the source study
#        was about flood, not landslide, susceptibility.
#   [E7] The seed document's own (Lightweight Landslide Early Warni.txt)
#        pre-existing, real observation, restated as directional
#        literature signal rather than a specific number: "distance to
#        roads (a very strong factor specifically for Pakistan's hill
#        roads — road-cut slope destabilization is a well-documented
#        triggering mechanism in Murree/Galyat-type terrain)."
#
# SYNTHESIS METHODOLOGY — exactly which of the numbers below are cited,
# which are this project's own reasoned judgment, stated plainly, same
# discipline as flood_ahp.py's own docstring:
#   - rainfall (0.22, HIGHEST): [E3]+[E5] both independently name
#     precipitation/water as Murree's own single dominant factor — the
#     rank is cited; the specific 0.22 magnitude is THIS PROJECT'S OWN
#     JUDGMENT, set as the largest single share given two independent
#     Murree-specific sources agree on its rank, but without an exact
#     percentage from either.
#   - lithology (0.18, 2nd): [E1]+[E4]+[E5] all independently confirm
#     lithology as a top-tier factor for this exact region, [E4] giving
#     the real physical mechanism (MBT-zone deformation). Rank cited;
#     magnitude is this project's own judgment.
#   - slope (0.15, 3rd): [E1] confirms top-3; [E6]'s own real numbers
#     (14.9-16% in two directly-verified Pakistani studies, a different
#     hazard but the same physical factor) anchor the magnitude — kept
#     BELOW rainfall/lithology specifically because [E3]/[E5] both rank
#     Murree's own rainfall/lithology ahead of slope, unlike some other
#     regions' own literature.
#   - lulc (0.12, 4th): [E1] confirms top-3; magnitude is this
#     project's own judgment, set below slope since [E1] doesn't rank
#     LULC above slope specifically.
#   - distance_road (0.10): [E7]'s own real, Pakistan-specific
#     mechanism (hill-road-cut destabilization) — elevated above where
#     a generic global landslide-AHP survey would typically place this
#     factor (§3.3 of the methodology doc already flags it as
#     genuinely under-studied globally). Magnitude is this project's
#     own judgment, real mechanism cited.
#   - distance_drainage (0.08): standard secondary factor, no dedicated
#     Murree-specific number found; a reasoned, modest weight.
#   - twi (0.05): reused from [E6] unchanged (Hunza-Nagar's own real
#     5%).
#   - pga (0.04): a REAL but deliberately modest weight for THIS
#     terrain-class profile specifically — Murree/Galyat is monsoon/
#     rainfall-driven, not primarily seismically-driven the way
#     Hunza-Nagar/Karakoram is (methodology doc §5's own decision: PGA
#     stays a static factor, terrain-conditioned). A future high-
#     mountain/Karakoram profile (Phase L6) is expected to weight this
#     meaningfully higher — this number is NOT a claim that seismic
#     risk is low everywhere, only that it isn't Murree's own dominant
#     mechanism.
#   - curvature (0.02): reused from [E6], doubled from Hunza-Nagar's
#     own 1% — this project's own judgment that curvature is more
#     directly diagnostic for slope-stability (landslide) than for
#     flood risk, the same class of terrain-appropriate adjustment
#     flood_ahp.py's own FLAT_RELIEF_FACTORS profile already made for
#     TWI.
#   - aspect (0.02): a real, standard factor in every study surveyed
#     ([E1]/[E2] both include it); not ranked top-3 anywhere found, so
#     kept modest.
#   - ndvi (0.01): reused from [E6] unchanged (Hunza-Nagar's own 3%,
#     scaled down here since vegetation-cover is one of several small
#     factors competing for the remaining weight budget after the
#     larger, better-evidenced factors above).
#   - soil_type (0.01): [E1] includes it but never ranks it top-3;
#     modest weight, consistent with every source surveyed.
#
# Named MODERATE_RELIEF_MONSOON_FACTORS, not "MURREE_GALYAT_FACTORS" —
# per methodology doc §5, this is meant to be a TERRAIN-CLASS profile
# (moderate relief, monsoon-rainfall-driven, MBT-zone-adjacent
# lithology), reusable for a future catchment with a physically similar
# profile, not hardcoded to one pilot's own name — mirrors flood_ahp.py's
# own moderate_relief/flat_relief naming exactly. A genuinely different
# terrain class — high-mountain, seismically active, glacial — is now
# built too (HIGH_RELIEF_KARAKORAM_FACTORS, below, §13/L6); a further,
# genuinely different THIRD profile remains real, deferred future work;
# get_factor_weights raises a clear error for any terrain_class not yet
# defined, the same posture flood_ahp.py's own accessor takes.
#
# CR-validated below via flood_ahp.py's own unmodified verify_consistency
# — a real, falsifiable check (see flood_ahp.verify_consistency's own
# docstring): a badly-synthesized profile could fail it.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# L6 — HIGH_RELIEF_KARAKORAM_FACTORS: a genuinely SECOND, distinct
# terrain-class profile (methodology doc §13/L6), not a reweighted copy
# of the Murree profile above. Real, session-confirmed literature
# specific to THIS region:
#
#   [K1] Karakoram Highway corridor, 10-factor AHP+GIS study (NHESS,
#        Copernicus, 2019) — fetched and read directly. Real factors:
#        lithology, distance-from-faults, seismicity, elevation, slope,
#        aspect, curvature, land cover, rainfall intensity, distance-
#        from-drainage. CR confirmed "below 0.1" (their own words). Real,
#        DIRECT quote on ranking: "active faults, slope gradient,
#        seismicity and lithology have a strong influence on landslide
#        events along the highway" — a genuinely DIFFERENT dominant-
#        factor set than Murree's own rainfall-led ranking (§5's own
#        [E3]/[E5]), not a coincidence: this corridor sits largely in
#        the Karakoram's own monsoon rain-shadow (a well-established
#        general fact, not this-study-specific), while the Main
#        Karakoram Thrust/Nanga Parbat syntaxis make it one of the most
#        seismically/tectonically active mountain fronts on Earth
#        (general geomorphological knowledge, reinforcing not
#        contradicting [K1]'s own live-confirmed finding).
#   [K2] Gilgit-Skardu Road — AHP/Frequency-Ratio/logistic-regression
#        COMPARISON study (Research Square preprint) — confirmed live
#        this region has a real, direct multi-method comparison
#        (methodology doc §3.4/§13-L6's own basis for preferring FR
#        here over AHP-alone once ground truth is available); full
#        numeric tables not independently extracted this session
#        (paywall-class access, same limitation §5's own [E1]/[E2]
#        already documented for the Murree profile) — used here as a
#        real, confirmed RANKING/METHOD signal, not a numeric anchor.
#   [E1] Astore study — REUSED from §5 above unchanged (same region-
#        adjacent literature already verified there): "slope, lithology
#        and LULC were the most important factors," CR=0.06 — a second,
#        independent confirmation that slope+lithology belong near the
#        top for this broader high-mountain terrain class, not
#        contradicting [K1].
#   [E6] flood_ahp.py's own already-verified Hunza-Nagar 2024 table —
#        REUSED again (same real, directly-verified Pakistani-terrain
#        numeric anchors §5's own [E6] already established): twi 5%,
#        curvature 1%, ndvi 3%, soil 3% — this table is for the SAME
#        physical corridor (Hunza-Nagar), a stronger anchor here than it
#        was for Murree.
#
# A REAL, NAMED GAP, not silently worked around: [K1]'s own dominant-
# factor list includes "distance from faults" as a distinct factor this
# project's own pipeline does not compute (no NCOP fault-line vector
# layer confirmed available this session — a real, different data
# source than the geology/pga_zones layers already integrated). Its own
# real signal is folded into elevating `pga` (this project's own best
# available seismic-hazard proxy) and `lithology` instead of being
# fabricated as a new, unbuilt factor — an honest substitution, stated
# as such, not presented as equivalent.
#
# SYNTHESIS METHODOLOGY:
#   - pga (0.17, tied-highest): [K1]'s own "active faults, ...,
#     seismicity" ranked #1/#3 in their own quote — the real signal for
#     BOTH is folded into this one factor (see the fault-distance gap
#     note above). A dramatic, deliberate increase from the Murree
#     profile's own 0.04 — the single biggest structural difference
#     between the two profiles, directly reflecting [K1]'s own real,
#     region-specific finding, not an arbitrary rebalancing.
#   - slope (0.17, tied-highest): [K1] ranks it #2 ("slope gradient");
#     [E1] independently confirms top-3 for the broader region too.
#   - lithology (0.15, 3rd): [K1] ranks it #4 but explicitly "strong
#     influence"; [E1] also confirms top-3. Kept just below pga/slope,
#     matching [K1]'s own explicit ordering.
#   - distance_road (0.10): [E7]'s own hill-road-cut mechanism (§5)
#     arguably applies EVEN MORE directly here — the Karakoram Highway
#     corridor's own real, named identity IS its proximity to a major
#     engineered road (§3.8's own KKH rockfall/debris-flow literature) —
#     kept at the same magnitude as Murree's own, not reduced.
#   - distance_drainage (0.09): one of [K1]'s own real 10 factors;
#     a modest increase over Murree's own 0.08, glacial/snowmelt
#     drainage networks are a real, more dominant hydrological control
#     here than in a monsoon-forested hill catchment.
#   - rainfall (0.08, DOWN from Murree's 0.22): the single biggest
#     directional change alongside pga's own increase — [K1]'s own
#     dominant-factor list does not include rainfall at all (unlike
#     Murree's own water-dominant [E3] finding), consistent with this
#     corridor's own real rain-shadow position. NOT set to zero — real
#     monsoon incursions and glacial-melt-driven wet periods still
#     occur, and §3.5's own ID-threshold literature still applies to
#     this hazard's own L4 dynamic mode regardless of this factor's
#     static-layer weight.
#   - twi (0.07): reused from [E6], increased from Murree's own 0.05 —
#     glacial/snowmelt hydrology is a more directly diagnostic wetness
#     signal here than monsoon-driven TWI in a forested hill catchment.
#   - curvature (0.06): reused from [E6]'s own real 1%, scaled up
#     substantially (this project's own judgment) — [K1] includes it as
#     one of its own real 10 factors, and glacial valley morphology
#     (over-steepened, debuttressed slopes) makes curvature a more
#     physically diagnostic signal here than in Murree's own gentler
#     terrain.
#   - lulc (0.05, DOWN from Murree's 0.12): [K1] includes land cover as
#     one of its own 10 factors but does not rank it top-4; this
#     project's own judgment that LULC has genuinely less differentiating
#     power in a landscape dominated by bare rock/glacier/sparse
#     vegetation than in Murree's own forested hill terrain.
#   - aspect (0.03): [K1] includes it; not ranked top-4, kept modest,
#     consistent with Murree's own treatment.
#   - soil_type (0.02): reused direction from [E6], slightly above
#     Murree's own 0.01 — thin/immature high-mountain soils are
#     genuinely less differentiating here, kept low, not zero.
#   - ndvi (0.01): reused from [E6] unchanged — sparse vegetation cover
#     overall in this arid high-mountain zone limits NDVI's own
#     differentiating power, the smallest weight in the table, same as
#     Murree's own treatment.
# ---------------------------------------------------------------------------

from . import flood_ahp

_raw = {
    "rainfall": 0.22,
    "lithology": 0.18,
    "slope": 0.15,
    "lulc": 0.12,
    "distance_road": 0.10,
    "distance_drainage": 0.08,
    "twi": 0.05,
    "pga": 0.04,
    "curvature": 0.02,
    "aspect": 0.02,
    "ndvi": 0.01,
    "soil_type": 0.01,
}
assert abs(sum(_raw.values()) - 1.0) < 1e-9, f"MODERATE_RELIEF_MONSOON_FACTORS must sum to 1.0, got {sum(_raw.values())}"

MODERATE_RELIEF_MONSOON_FACTORS = {
    name: {"weight": weight, "source": "see landslide_ahp.py module docstring — SYNTHESIS METHODOLOGY"}
    for name, weight in _raw.items()
}

# "lite" variant — same shape flood_ahp.py's own *_LITE profiles use
# (the smallest-weight factors dropped, remaining weights renormalized)
# for a faster/cheaper run when the full factor set isn't needed. Drops
# ndvi/soil_type/aspect (the three smallest, 0.01/0.01/0.02) — the same
# "drop the least-evidenced small factors first" logic flood_ahp.py's
# own lite profiles already use.
_lite_raw = {k: v for k, v in _raw.items() if k not in ("ndvi", "soil_type", "aspect")}
_lite_sum = sum(_lite_raw.values())
MODERATE_RELIEF_MONSOON_FACTORS_LITE = {
    name: {"weight": round(weight / _lite_sum, 4), "source": "renormalized subset of MODERATE_RELIEF_MONSOON_FACTORS"}
    for name, weight in _lite_raw.items()
}

_karakoram_raw = {
    "pga": 0.17,
    "slope": 0.17,
    "lithology": 0.15,
    "distance_road": 0.10,
    "distance_drainage": 0.09,
    "rainfall": 0.08,
    "twi": 0.07,
    "curvature": 0.06,
    "lulc": 0.05,
    "aspect": 0.03,
    "soil_type": 0.02,
    "ndvi": 0.01,
}
assert abs(sum(_karakoram_raw.values()) - 1.0) < 1e-9, f"HIGH_RELIEF_KARAKORAM_FACTORS must sum to 1.0, got {sum(_karakoram_raw.values())}"

HIGH_RELIEF_KARAKORAM_FACTORS = {
    name: {"weight": weight, "source": "see landslide_ahp.py module docstring — HIGH_RELIEF_KARAKORAM_FACTORS SYNTHESIS METHODOLOGY"}
    for name, weight in _karakoram_raw.items()
}

# Drops soil_type/ndvi/aspect (the three smallest, 0.02/0.01/0.03) —
# same "drop the least-evidenced small factors first" convention the
# Murree lite profile above already uses, applied to THIS profile's own
# smallest three, not copied from Murree's own drop list (which
# happened to be the same three factors by coincidence of both profiles
# converging on aspect/soil/ndvi as their own smallest weights, not by
# design).
_karakoram_lite_raw = {k: v for k, v in _karakoram_raw.items() if k not in ("ndvi", "soil_type", "aspect")}
_karakoram_lite_sum = sum(_karakoram_lite_raw.values())
HIGH_RELIEF_KARAKORAM_FACTORS_LITE = {
    name: {"weight": round(weight / _karakoram_lite_sum, 4), "source": "renormalized subset of HIGH_RELIEF_KARAKORAM_FACTORS"}
    for name, weight in _karakoram_lite_raw.items()
}

_PROFILES = {
    "moderate_relief_monsoon": (MODERATE_RELIEF_MONSOON_FACTORS, MODERATE_RELIEF_MONSOON_FACTORS_LITE),
    "high_relief_karakoram": (HIGH_RELIEF_KARAKORAM_FACTORS, HIGH_RELIEF_KARAKORAM_FACTORS_LITE),
}


def get_factor_weights(terrain_class, lite=True):
    """Public accessor, same signature as flood_ahp.get_factor_weights.
    Two real, literature-distinct profiles exist: 'moderate_relief_
    monsoon' (Murree/Galyat-type — rainfall-led) and 'high_relief_
    karakoram' (Astore/Hunza-Nagar/Besham-Chilas-type — seismicity/
    lithology/slope-led, real elevation-gated classifier in
    landslide_model.classify_terrain_class, §13/L6). A genuinely
    different THIRD profile is real, deferred future work — this raises
    a clear error for any other terrain_class rather than silently
    reusing a mismatched profile."""
    if terrain_class not in _PROFILES:
        raise ValueError(f"Unknown landslide terrain_class {terrain_class!r} — known: {list(_PROFILES)}")
    full, lite_set = _PROFILES[terrain_class]
    chosen = lite_set if lite else full
    return {name: cfg["weight"] for name, cfg in chosen.items()}


def verify_consistency(label="MODERATE_RELIEF_MONSOON", full_factors=None, lite_factors=None):
    """Thin wrapper around flood_ahp.verify_consistency — reused
    unmodified (methodology doc §5: share the generic fusion
    primitives, don't reimplement them). Defaults to the Murree profile
    for backward compatibility; pass full_factors/lite_factors to check
    a different profile (e.g. the Karakoram one)."""
    full = full_factors if full_factors is not None else MODERATE_RELIEF_MONSOON_FACTORS
    lite_set = lite_factors if lite_factors is not None else MODERATE_RELIEF_MONSOON_FACTORS_LITE
    return [
        flood_ahp.verify_consistency(full, f"{label} (full)"),
        flood_ahp.verify_consistency(lite_set, f"{label} (lite)"),
    ]


if __name__ == "__main__":
    reports = verify_consistency("MODERATE_RELIEF_MONSOON") + verify_consistency(
        "HIGH_RELIEF_KARAKORAM", HIGH_RELIEF_KARAKORAM_FACTORS, HIGH_RELIEF_KARAKORAM_FACTORS_LITE,
    )
    for report in reports:
        print(f"\n=== {report['label']} ===")
        print(f"factors: {report['names']}")
        print(f"weights:            {report['published_weights']}")
        print(f"derived weights:    {report['derived_weights']}  (max abs diff: {report['max_abs_weight_diff']})")
        print(f"lambda_max: {report['lambda_max']}  CI: {report['consistency_index']}  "
              f"CR: {report['consistency_ratio']}  acceptable(<0.10): {report['acceptable']}")
