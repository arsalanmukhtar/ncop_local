# project/ncop_internal/flood_validation.py
# ---------------------------------------------------------------------------
# Event-matched accuracy validation — see FLASH_FLOOD_EARLY_WARNING_
# METHODOLOGY.md §0.21 for the full research trail behind this file.
#
# §0.20 ran the FIRST real AUC test for Nullah Lai (pooling one static
# raster — raw HAND, or one arbitrary synthetic rainfall scenario's
# discharge-margin — against 10 different real historical flood events).
# That's a real, honest result (0.605 / 0.646, both "poor"), but it has a
# genuine methodological flaw: comparing ONE fixed scenario against MANY
# different real events (each with its own, different, actual rainfall)
# is an apples-to-oranges comparison for a SCENARIO-DEPENDENT raster.
#
# This module fixes that specific flaw — not by tuning any formula to
# chase a target score (this project has explicitly rejected that kind
# of curve-fitting multiple times already, see flood_model.py's own
# HAND_FLOOD_PRONE_THRESHOLD_M comment) — but by feeding EACH event its
# OWN actual historical rainfall (via accuracy_assessment.
# fetch_peak_event_rainfall, CHIRPS-derived) through the EXISTING,
# UNMODIFIED discharge pipeline (flood_model.build_discharge_margin_raster,
# itself built on the EXISTING, UNMODIFIED build_discharge_driven_flood_zone),
# then validating each event's own scenario-specific raster against that
# SAME event's own MODIS-observed extent — the methodologically correct
# comparison, not a new science.
#
# No existing function's logic is changed anywhere in this file's own
# call chain — this is pure orchestration across three already-existing,
# already-tested modules (accuracy_assessment, flood_discharge via
# flood_model, flood_model itself).
# ---------------------------------------------------------------------------

import json
import logging
import os

from django.conf import settings

logger = logging.getLogger(__name__)


# A scenario needs at least this many actual sampled presence points to
# count toward the RELIABLE headline number — see
# assess_pooled_multi_raster_auc's own min_presence_samples docstring:
# CONFIRMED LIVE (§0.21) that a 1-2-presence-point scenario can score a
# perfect or near-perfect individual AUC purely by chance, which would
# silently inflate an unrestricted pooled result. 10 is not tuned to hit
# any particular target score — it is a plain, round, defensible "this
# many independent samples is enough to say something about a
# distribution" floor, applied the SAME way regardless of what number it
# produces.
_RELIABLE_MIN_PRESENCE_SAMPLES = 10


_DEFAULT_N_TRIALS = 5


def run_event_matched_validation(catchment_key, bbox, max_events=10, n_samples_per_event=200,
                                  reliable_min_presence_samples=_RELIABLE_MIN_PRESENCE_SAMPLES,
                                  n_trials=_DEFAULT_N_TRIALS):
    """The actual deliverable: for every real GFD event with a usable
    local signal in `bbox`, fetches that event's own peak-storm rainfall
    (accuracy_assessment.fetch_peak_event_rainfall), runs it through
    flood_model.build_discharge_margin_raster (the EXISTING discharge
    pipeline, untouched), and scores the result against that SAME
    event's own GFD flood-extent polygons — pooling every usable event
    into ONE combined AUC via accuracy_assessment.
    assess_pooled_multi_raster_auc.

    Returns TWO pooled results, not one — see methodology doc §0.21 for
    why: "all_events" pools every scenario with at least 1 real sampled
    presence point (maximum use of available signal, but can be swayed
    by a 1-2-point scenario's own sampling luck); "reliable_events"
    additionally requires >= `reliable_min_presence_samples` presence
    points per scenario before it contributes to the pool (a stricter,
    more conservative number). Reporting BOTH, not picking whichever
    looks better, is the point — this module never chooses one number to
    show based on which is higher.

    An event is skipped (not treated as a zero/failure) if: CHIRPS has no
    rainfall data for its window, its peak rainfall produces zero SCS-CN
    runoff (a real, physically correct "no flood forecast" outcome, not
    an error — see flood_discharge.py's own scs_runoff_depth_mm), or its
    own GFD flood-extent polygons are empty. Every skip is recorded with
    a reason, not silently dropped, so the final report shows exactly
    how many of the available events actually contributed and why any
    others didn't.

    Returns a dict: {"all_events_result", "reliable_events_result"
    (both assess_pooled_multi_raster_auc_stable's own shape — "auc_mean"/
    "auc_min"/"auc_max" across `n_trials` independent sampling passes,
    NOT a single "auc" — see that function's own docstring), "events_used":
    [...], "events_skipped": [...]}."""
    from . import accuracy_assessment as aa
    from . import flood_model

    events = aa.list_gfd_events(bbox, max_events=max_events)
    scenarios = []
    events_used = []
    events_skipped = []

    for event in events:
        event_id = event["id"]

        rain = aa.fetch_peak_event_rainfall(bbox, event["system_time_start_ms"], event["system_time_end_ms"])
        if rain is None:
            events_skipped.append({"event_id": event_id, "reason": "no CHIRPS rainfall data for this window"})
            continue

        geoms = aa.fetch_gfd_flood_extent(bbox, event_id=event_id)
        if not geoms:
            events_skipped.append({"event_id": event_id, "reason": "no GFD flood-extent polygons"})
            continue

        try:
            margin_path = flood_model.build_discharge_margin_raster(
                catchment_key, rainfall_mm=rain["rainfall_mm"], duration_hr=rain["duration_hr"],
            )
        except Exception as exc:
            logger.warning(
                "flood_validation: could not build discharge margin raster for event %s "
                "(rainfall=%.1fmm/%.0fh) — skipping this event, not the whole run",
                event_id, rain["rainfall_mm"], rain["duration_hr"], exc_info=True,
            )
            events_skipped.append({"event_id": event_id, "reason": f"discharge pipeline error: {exc}"})
            continue

        scenarios.append({
            "raster_path": margin_path,
            "presence_geoms": geoms,
            "aoi_bbox": bbox,
            "invert_score": False,  # margin already increases with flood-proneness
            "label": f"event_{event_id}",
        })
        events_used.append({
            "event_id": event_id,
            "rainfall_mm": rain["rainfall_mm"],
            "duration_hr": rain["duration_hr"],
            "peak_start_date": rain["peak_start_date"],
            "n_geoms": len(geoms),
        })

    # MULTI-TRIAL, not a single sampling pass — see §0.22: a single
    # assess_pooled_multi_raster_auc() call's result was confirmed live
    # to swing by a wide margin (0.75-0.86 observed for the exact same
    # scenarios/ground truth across different runs) purely from which
    # random points happened to be drawn. `scenarios` (the expensive
    # part — GEE queries, discharge-raster construction) is built ONCE
    # above; only the cheap sampling step repeats across n_trials.
    all_events_result = aa.assess_pooled_multi_raster_auc_stable(
        scenarios, n_samples_per_scenario=n_samples_per_event, min_presence_samples=1,
        n_trials=n_trials,
    )
    reliable_events_result = aa.assess_pooled_multi_raster_auc_stable(
        scenarios, n_samples_per_scenario=n_samples_per_event,
        min_presence_samples=reliable_min_presence_samples, n_trials=n_trials,
    )

    # Reconcile against what actually contributed to the (more permissive)
    # all_events pool, ACROSS ANY TRIAL — assess_pooled_multi_raster_auc
    # can ITSELF drop a scenario downstream (e.g. a ground-truth polygon
    # so small relative to the bbox that rejection sampling never lands a
    # point inside it in a given trial — a real, confirmed-live
    # limitation for some of this catchment's own single-pixel GFD
    # events, not a bug). A scenario counts as "used" if any trial
    # actually scored it; one that NEVER contributes across all n_trials
    # is genuinely unreliable, not just an unlucky single draw. Without
    # this reconciliation, events_used would over-report how many events
    # actually shaped either pooled result — a real bookkeeping bug
    # caught by checking the numbers, not assumed.
    contributed_labels = {
        sc["label"] for trial in all_events_result["trials"] for sc in trial["per_scenario"]
    }
    reconciled_used, newly_dropped = [], []
    for e in events_used:
        if f"event_{e['event_id']}" in contributed_labels:
            reconciled_used.append(e)
        else:
            newly_dropped.append(e)
    for e in newly_dropped:
        events_skipped.append({
            "event_id": e["event_id"],
            "reason": "ground-truth polygon too small relative to bbox — rejection "
                      "sampling found no presence points within the sampling budget",
        })

    return {
        "all_events_result": all_events_result,
        "reliable_events_result": reliable_events_result,
        "events_used": reconciled_used,
        "events_skipped": events_skipped,
    }


def run_riverine_validation(catchment_key, bbox, max_events=20, n_samples=200,
                             n_trials=_DEFAULT_N_TRIALS):
    """Riverine mode's OWN validation (§R4) — deliberately NOT the same
    event-matched mechanism run_event_matched_validation uses above,
    because that mechanism needs a per-event HISTORICAL rainfall/discharge
    value to drive a per-event scenario raster, and riverine mode has no
    such archive: flood_riverine.py's FFD feeds only give a rolling
    RECENT window (a few days), not arbitrary historical dates matching
    GFD's own 2000-2018 event catalog. Rather than fabricate a historical
    discharge value this project has no real source for, this validates
    what CAN be honestly tested with what's actually available, pooling
    EVERY real GFD event's own flooded pixels near this catchment into one
    combined ground-truth set (explicitly NOT date-matched to any single
    event — this tests whether the CURRENT connected-flood-fill result's
    spatial pattern generally aligns with where floods have historically
    occurred, not whether today's exact gauge reading reproduces any one
    historical event's own magnitude):

      1. "raw_hand" — a CONTINUOUS-score AUC test (accuracy_assessment.
         assess_pooled_multi_raster_auc_stable, unchanged) against the
         SAME static HAND raster every other mode's own raw-HAND baseline
         already uses — time-invariant terrain, no per-event data-matching
         needed at all.
      2. "connected_fill" — a BINARY-classification test (accuracy_
         assessment.assess_binary_mask_accuracy_stable — NOT AUC, since
         flood_model.build_riverine_flood_zone's own connected_flood_fill
         result is already a binary flooded/not-flooded mask, and AUC
         needs a continuous score to rank; a confusion-matrix metric — hit
         rate / CSI / F1 — is the correct, literature-matching family for
         an already-binary prediction, the same family this project's own
         "HAND vs FEMA maps" literature research found used for exactly
         this kind of validation) against TODAY's live connected-fill
         mask.

    Returns {"raw_hand_result" (assess_pooled_multi_raster_auc_stable's
    own shape), "connected_fill_result" (assess_binary_mask_accuracy_
    stable's own shape, or None if today's live gauge reading/mask was
    unavailable — never silently faked), "gauge_scenario" (flood_model.
    build_riverine_flood_zone's own returned scenario dict, or None),
    "events_used", "events_skipped"}."""
    from . import accuracy_assessment as aa
    from . import flood_model

    events = aa.list_gfd_events(bbox, max_events=max_events)
    hand_scenarios = []
    all_geoms = []
    events_used = []
    events_skipped = []

    pipeline = flood_model.build_hand_pipeline(catchment_key)
    hand_path = pipeline["paths"]["hand"]

    gauge_scenario = None
    mask_path = None
    try:
        zone_payload = flood_model.build_riverine_flood_zone(catchment_key)
        gauge_scenario = zone_payload["scenario"]
        mask_path = zone_payload["mask_path"]
    except Exception as exc:
        logger.warning(
            "flood_validation: riverine connected-fill mask unavailable for %s (%s) — "
            "raw_hand validation still proceeds, connected_fill_result will be skipped",
            catchment_key, exc, exc_info=True,
        )

    for event in events:
        event_id = event["id"]
        geoms = aa.fetch_gfd_flood_extent(bbox, event_id=event_id)
        if not geoms:
            events_skipped.append({"event_id": event_id, "reason": "no GFD flood-extent polygons"})
            continue

        hand_scenarios.append({
            "raster_path": hand_path, "presence_geoms": geoms, "aoi_bbox": bbox,
            "invert_score": True,  # lower HAND = more flood-prone
            "label": f"event_{event_id}",
        })
        all_geoms.extend(geoms)
        events_used.append({"event_id": event_id, "n_geoms": len(geoms)})

    raw_hand_result = aa.assess_pooled_multi_raster_auc_stable(
        hand_scenarios, n_samples_per_scenario=n_samples, min_presence_samples=1,
        n_trials=n_trials,
    )
    connected_fill_result = (
        aa.assess_binary_mask_accuracy_stable(mask_path, all_geoms, bbox, n_samples, n_trials=n_trials)
        if mask_path else None
    )

    return {
        "raw_hand_result": raw_hand_result,
        "connected_fill_result": connected_fill_result,
        "gauge_scenario": gauge_scenario,
        "events_used": events_used,
        "events_skipped": events_skipped,
    }


def run_ahp_susceptibility_validation(catchment_key, bbox, lite=True, max_events=20,
                                       n_samples=200, n_trials=_DEFAULT_N_TRIALS):
    """Validates flood_model.build_ahp_susceptibility_raster's own output
    (Phase 2.5.3/2.5.4) against real GFD ground truth — pooling EVERY
    real GFD event's own flooded pixels near this catchment into one
    combined ground-truth set, the SAME "static raster, no per-event
    data-matching needed" pattern run_riverine_validation's own
    "raw_hand" test already established (correct here for the same
    reason: this project's AHP composite has no scenario/rainfall
    dimension — every factor feeding it is either terrain-static or a
    static climatology, see build_ahp_susceptibility_raster's own
    docstring — so comparing it against MANY historical events pooled
    together is the right comparison, not the apples-to-oranges problem
    flood_validation.py's own module docstring describes for a
    SCENARIO-DEPENDENT raster like the discharge margin).

    Works for EITHER flood_type (flash or riverine) — the terrain-class
    selection inside build_ahp_susceptibility_raster already dispatches
    correctly per catchment; this function doesn't need to know which.

    invert_score=False (not True, unlike the raw-HAND test above) — the
    AHP composite is built so HIGHER score = MORE hazardous (see
    build_ahp_susceptibility_raster's own [1,5] hazard-class convention),
    the opposite convention from raw HAND (where LOWER = more hazardous).

    Returns {"terrain_class", "weights", "auc_result"
    (assess_pooled_multi_raster_auc_stable's own shape), "events_used",
    "events_skipped"} — per this project's own standing instruction, this
    result is meant to be reported honestly and used to inform whether
    the methodology generalizes, NOT to be chased/tuned toward any one
    pilot catchment's own outcome."""
    from . import accuracy_assessment as aa
    from . import flood_model

    ahp_result = flood_model.build_ahp_susceptibility_raster(catchment_key, lite=lite)
    ahp_path = ahp_result["path"]

    events = aa.list_gfd_events(bbox, max_events=max_events)
    scenarios = []
    events_used = []
    events_skipped = []

    for event in events:
        event_id = event["id"]
        geoms = aa.fetch_gfd_flood_extent(bbox, event_id=event_id)
        if not geoms:
            events_skipped.append({"event_id": event_id, "reason": "no GFD flood-extent polygons"})
            continue
        scenarios.append({
            "raster_path": ahp_path, "presence_geoms": geoms, "aoi_bbox": bbox,
            "invert_score": False,  # higher AHP score = more hazardous (opposite of raw HAND)
            "label": f"event_{event_id}",
        })
        events_used.append({"event_id": event_id, "n_geoms": len(geoms)})

    auc_result = aa.assess_pooled_multi_raster_auc_stable(
        scenarios, n_samples_per_scenario=n_samples, min_presence_samples=1, n_trials=n_trials,
    )

    return {
        "terrain_class": ahp_result["terrain_class"],
        "weights": ahp_result["weights"],
        "auc_result": auc_result,
        "events_used": events_used,
        "events_skipped": events_skipped,
    }


def calibrate_ahp_zone_breakpoints(catchment_key, bbox, lite=True, max_events=20,
                                    n_samples=200, n_trials=_DEFAULT_N_TRIALS):
    """Youden's-J calibration of the AHP zonation breakpoints
    (flood_model._AHP_ZONE_BREAKS_CALIBRATED) — the sub-phase named in
    this project's own ORIGINAL Phase 2.5 plan ("Phase 2.5.5 — Threshold
    /cutoff calibration... Apply Youden's J statistic... to the... new
    AHP susceptibility score") but never actually built until now.

    Runs against the SAME smoothed score build_ahp_zone_geometries
    itself classifies (flood_model.build_ahp_smoothed_score_raster) —
    calibrating against the raw, unsmoothed score would measure the
    wrong thing (this project already made almost exactly this mistake
    once, with the AUC citation itself — see methodology doc §0.31 —
    corrected here by construction, not repeated).

    Pools presence/absence samples across EVERY real GFD event near
    this catchment, x n_trials independent samplings each, into ONE
    combined array before running the hierarchical Youden's J
    calibration (accuracy_assessment.calibrate_hierarchical_thresholds)
    ONCE on the full pooled set — more statistically stable than
    averaging separately-computed thresholds per trial, the same
    "pool, don't average" posture assess_pooled_multi_raster_auc
    already established for AUC.

    This is a DESIGN-TIME/OFFLINE calibration tool, not called on the
    hot request path — run once per terrain class, its result hardcoded
    into flood_model._AHP_ZONE_BREAKS_CALIBRATED (matching this
    project's own established "research once, hardcode, keep the tool
    reproducible for later" posture already used for the AHP weight
    literature review itself).

    Returns {"terrain_class", "t1", "t2", "stage1_diagnostics",
    "stage2_diagnostics", "n_events_used", "n_events_skipped",
    "n_presence_total", "n_absence_total"}, or a dict with "error" if
    calibration could not run (e.g. no GFD ground truth at all for this
    catchment) — never raises, matching this module's own established
    degrade-honestly convention."""
    from . import accuracy_assessment as aa
    from . import flood_model

    smoothed_result = flood_model.build_ahp_smoothed_score_raster(catchment_key, lite=lite)
    smoothed_path = smoothed_result["path"]
    terrain_class = flood_model.build_ahp_susceptibility_raster(catchment_key, lite=lite)["terrain_class"]

    events = aa.list_gfd_events(bbox, max_events=max_events)
    all_presence = []
    all_absence = []
    events_used = []
    events_skipped = []

    for event in events:
        event_id = event["id"]
        geoms = aa.fetch_gfd_flood_extent(bbox, event_id=event_id)
        if not geoms:
            events_skipped.append({"event_id": event_id, "reason": "no GFD flood-extent polygons"})
            continue
        for _trial in range(n_trials):
            presence_vals, absence_vals = aa._sample_and_score(smoothed_path, geoms, bbox, n_samples)
            all_presence.extend(presence_vals)
            all_absence.extend(absence_vals)
        events_used.append({"event_id": event_id, "n_geoms": len(geoms)})

    if not all_presence or not all_absence:
        return {
            "terrain_class": terrain_class,
            "error": "no usable GFD ground truth for this catchment",
            "n_events_used": len(events_used), "n_events_skipped": len(events_skipped),
        }

    calibration = aa.calibrate_hierarchical_thresholds(all_presence, all_absence, ascending=True)
    if calibration is None:
        return {
            "terrain_class": terrain_class,
            "error": "Youden's J calibration undefined (one class empty)",
            "n_events_used": len(events_used), "n_events_skipped": len(events_skipped),
        }

    return {
        "terrain_class": terrain_class,
        "t1": calibration["t1"], "t2": calibration["t2"],
        "stage1_diagnostics": calibration["stage1_diagnostics"],
        "stage2_diagnostics": calibration["stage2_diagnostics"],
        "n_events_used": len(events_used), "n_events_skipped": len(events_skipped),
        "n_presence_total": len(all_presence), "n_absence_total": len(all_absence),
    }


def run_sar_cross_validation(catchment_key, bbox, max_events=20, force=False):
    """Phase 2.5.6 — cross-validates flood_sar.build_sar_flood_extent's
    own Sentinel-1-derived flood extent against real GFD ground truth,
    per real historical event. Genuinely different shape from every
    other function in this file: those build ONE static raster and pool
    MANY events against it (build_ahp_susceptibility_raster/raw HAND
    have no scenario dimension); SAR is the opposite — a NEW raster is
    built PER EVENT (its own pre/post date windows depend on that
    event's own dates), so this loops per-event and reports per-event
    results plus an aggregate mean, never pooling samples across events
    the way the AUC-based validators above do (there is no shared
    "static raster" to pool against here).

    A single event's failure (no SAR coverage, no GFD polygons, or any
    internal error) is logged and skipped — never fatal to the rest,
    matching this project's established resilience convention. This is
    an explicit DESIGN-TIME/OFFLINE tool, not called on any hot request
    path (same posture as calibrate_ahp_zone_breakpoints/run_ahp_
    susceptibility_validation above) — Sentinel-1 fetch + local terrain-
    mask/sieve/warp work is real, non-trivial per-event cost, unsuitable
    for a user-facing "Run" click.

    Returns {"catchment": catchment_key, "events": [{"event_id",
    "n_pre_scenes", "n_post_scenes", "agreement": <assess_raster_vs_
    raster_agreement's own dict>}], "n_events_used", "n_events_skipped",
    "mean_agreement_rate", "mean_iou", "mean_kappa"} — real, honest
    numbers per event; an aggregate mean is only computed over events
    that actually produced a result, not forced/assumed. Never raises."""
    from . import accuracy_assessment as aa
    from . import flood_sar

    events = aa.list_gfd_events(bbox, max_events=max_events)
    results = []
    skipped = []

    for event in events:
        event_id = event["id"]
        try:
            sar_result = flood_sar.build_sar_flood_extent(catchment_key, event, force=force)
        except Exception:
            logger.warning(
                "flood_validation: SAR extent build raised for %r event %r "
                "(skipping this event, continuing with the rest)",
                catchment_key, event_id, exc_info=True,
            )
            skipped.append({"event_id": event_id, "reason": "SAR build raised an exception"})
            continue
        if sar_result is None:
            skipped.append({"event_id": event_id, "reason": "no usable Sentinel-1 coverage for this event"})
            continue

        geoms = aa.fetch_gfd_flood_extent(bbox, event_id=event_id)
        if not geoms:
            skipped.append({"event_id": event_id, "reason": "no GFD flood-extent polygons"})
            continue

        agreement = aa.assess_raster_vs_raster_agreement(sar_result["path"], geoms, bbox)
        if "error" in agreement:
            skipped.append({"event_id": event_id, "reason": f"agreement check failed: {agreement['error']}"})
            continue

        results.append({
            "event_id": event_id,
            "n_pre_scenes": sar_result.get("n_pre_scenes"),
            "n_post_scenes": sar_result.get("n_post_scenes"),
            "agreement": agreement,
        })

    if not results:
        return {
            "catchment": catchment_key,
            "events": [],
            "n_events_used": 0, "n_events_skipped": len(skipped),
            "skipped": skipped,
            "mean_agreement_rate": float("nan"), "mean_iou": float("nan"), "mean_kappa": float("nan"),
        }

    agreement_rates = [r["agreement"]["agreement_rate"] for r in results]
    ious = [r["agreement"]["iou"] for r in results if r["agreement"]["iou"] == r["agreement"]["iou"]]
    kappas = [r["agreement"]["kappa"] for r in results if r["agreement"]["kappa"] == r["agreement"]["kappa"]]

    return {
        "catchment": catchment_key,
        "events": results,
        "n_events_used": len(results), "n_events_skipped": len(skipped),
        "skipped": skipped,
        "mean_agreement_rate": round(sum(agreement_rates) / len(agreement_rates), 4),
        "mean_iou": round(sum(ious) / len(ious), 4) if ious else float("nan"),
        "mean_kappa": round(sum(kappas) / len(kappas), 4) if kappas else float("nan"),
    }


def run_flood_extent_shape_comparison(catchment_key, force=False):
    """Phase 3's own first named scope item, finally done (see
    FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md §0.35 for the full
    account): a real shape/overlap check between our own riverine flood-
    zone and AHP-zone output and the app's own 20 EXISTING hydrological_
    global flood-extent layers (Upper/Lower Indus, Jhelum, Chenab, Ravi,
    Sutlej, Kabul, each with High/Medium/Low severity bands) — a
    completely different, independent ground truth from GFD, never
    checked against before this.

    A curated pilot needs `PILOT_CATCHMENTS[catchment_key]` to carry a
    `wfs_river_system` field (currently: chashma_indus -> upper_indus,
    guddu_indus -> lower_indus, peshawar_bhudni_nullah -> kabul — see
    each entry's own comment for how that mapping was confirmed live,
    not assumed). `nullah_lai` deliberately has NO such field — confirmed
    live to have zero real overlap with any of the 7 river systems, a
    real structural fact, not a gap — calling this for nullah_lai
    returns a clear `{"error": ...}` immediately, not a silent empty
    result.

    §0.41 — a custom AOI (`is_custom_aoi`) has no such pre-known mapping
    (there's no way to know in advance which, if any, of the 7 systems
    an arbitrary user-drawn polygon overlaps), so it PROBES all 7
    instead, unions together whichever systems' bands turn out non-empty
    (`river_system` in the return payload becomes a comma-joined list of
    the systems that actually contributed something, not a single key),
    and returns a clear, specific `{"error": ..., "attempted_systems":
    [...]}` only if genuinely NONE of the 7 overlap — an honest, expected
    outcome for most custom areas (these 7 systems cover specific major
    river reaches, not all of Pakistan), reported as such rather than
    silently degrading to a misleading "not available".

    Both sides of every comparison are already real vector polygons —
    this uses accuracy_assessment.assess_vector_overlap (pure shapely,
    no rasterization), not the raster-vs-raster machinery flood_sar.py's
    own cross-validation needed.

    Returns {"catchment", "river_system", "riverine_vs_bands":
    {severity: assess_vector_overlap's own dict}, "ahp_vs_bands":
    {zone_class: {severity: ...}}} — a band or zone missing/empty is
    skipped (its own dict carries an "error" key) rather than failing
    the whole comparison. Never raises."""
    from . import accuracy_assessment as aa
    from . import flood_exposure
    from . import flood_model

    if catchment_key not in flood_model.PILOT_CATCHMENTS:
        return {"error": f"Unknown catchment {catchment_key!r}"}
    cfg = flood_model.PILOT_CATCHMENTS[catchment_key]
    river_system = cfg.get("wfs_river_system")
    # §0.41 — a curated pilot's wfs_river_system is a real, confirmed-
    # live structural fact about THAT specific catchment (see this
    # function's own docstring: nullah_lai deliberately has none because
    # it truly doesn't overlap any of the 7 systems) — there is no
    # equivalent fact to look up for a custom AOI, since it's an
    # arbitrary user-drawn polygon anywhere in Pakistan. Rather than
    # refuse outright (which is what produced the "No accuracy" the user
    # correctly flagged as a real gap, not an inherent limitation), a
    # custom AOI PROBES all 7 systems the same way — fetch_flood_extent_
    # presence already degrades to an empty list per-system/per-bbox with
    # no overlap (confirmed live for nullah_lai originally), so trying
    # all 7 is just repeating that same safe, already-proven operation a
    # few more times, not new risk.
    is_custom_aoi = bool(cfg.get("is_custom_aoi"))
    if not river_system and not is_custom_aoi:
        return {
            "error": (
                f"{catchment_key!r} has no wfs_river_system mapping — confirmed live "
                f"this catchment has no real overlap with any of the 7 existing "
                f"hydrological_global river systems, so this comparison genuinely "
                f"cannot be run here (not a bug)."
            ),
        }
    if river_system and river_system not in aa.FLOOD_EXTENT_RIVER_SYSTEMS:
        return {"error": f"Unknown wfs_river_system {river_system!r} for {catchment_key!r}"}

    # No scenario dimension in the cache key — same "static, catchment-
    # level result" posture as build_ahp_zone_geometries/build_ahp_zone_
    # exposure_report's own caching convention (a WFS re-fetch is real
    # network cost, not worth paying per request).
    out_dir = os.path.join(settings.MEDIA_ROOT, "flood_model", catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    cache_path = os.path.join(out_dir, "flood_extent_shape_comparison.json")
    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        try:
            with open(cache_path) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "flood_validation: shape-comparison cache %s unreadable (%s) — "
                "rebuilding from scratch instead of trusting a stale/corrupt entry",
                cache_path, exc,
            )

    bbox = cfg["bbox"]
    severity_labels = {"h": "high", "m": "medium", "l": "low"}
    matched_systems = []

    if river_system:
        # A known pilot with a real, confirmed mapping — exactly the
        # original single-system behavior, unchanged (only the severity
        # keys THIS system actually has end up in `bands` at all — e.g.
        # a jhelum-mapped catchment would have no "medium" key, not an
        # empty one; no currently-mapped pilot is jhelum, but preserving
        # that exact shape rather than introducing a new always-3-keys
        # convention keeps this path byte-identical to before).
        bands = {}
        for sev in aa.FLOOD_EXTENT_RIVER_SYSTEMS[river_system]["severities"]:
            geoms = aa.fetch_flood_extent_presence(river_system, bbox, severities=(sev,))
            bands[severity_labels[sev]] = geoms
        # Unconditional (not gated on any(bands.values())) — the ORIGINAL
        # behavior always reported the mapped river_system in the payload
        # regardless of whether that particular call happened to return
        # zero overlapping features; preserved exactly, byte-identical.
        matched_systems = [river_system]
    else:
        bands = {"high": [], "medium": [], "low": []}
        # Custom AOI — no way to know in advance which (if any) of the 7
        # systems this arbitrary polygon might overlap, so every one is
        # tried; each system's own non-empty bands are UNION'd into the
        # combined bands dict (handles the rare case of an AOI sitting
        # near two systems' shared boundary/confluence). A system that
        # contributes nothing (the common case for most custom AOIs, e.g.
        # a small urban area far from any of the 7 mapped systems) is
        # simply skipped — matches fetch_flood_extent_presence's own
        # existing "no overlap is a real, legitimate outcome" posture.
        for system_key, system_cfg in aa.FLOOD_EXTENT_RIVER_SYSTEMS.items():
            system_had_any = False
            for sev in system_cfg["severities"]:
                geoms = aa.fetch_flood_extent_presence(system_key, bbox, severities=(sev,))
                if geoms:
                    bands[severity_labels[sev]].extend(geoms)
                    system_had_any = True
            if system_had_any:
                matched_systems.append(system_key)
        if not matched_systems:
            return {
                "error": (
                    f"No historical flood-extent ground truth found for this custom "
                    f"area — searched all {len(aa.FLOOD_EXTENT_RIVER_SYSTEMS)} known "
                    f"hydrological_global river systems (upper/lower Indus, Jhelum, "
                    f"Chenab, Ravi, Sutlej, Kabul) and none has a mapped historical "
                    f"flood extent overlapping this specific drawn area. A genuine, "
                    f"expected outcome for most custom areas (these 7 systems cover "
                    f"specific major river reaches, not all of Pakistan), not a bug."
                ),
                "attempted_systems": list(aa.FLOOD_EXTENT_RIVER_SYSTEMS),
            }
    river_system = ", ".join(matched_systems)

    riverine_vs_bands = {}
    if cfg.get("flood_type") == "riverine":
        try:
            zone_payload = flood_model.build_riverine_flood_zone(catchment_key, force=force)
            with flood_model._gdal_lock():
                riverine_geom = flood_exposure._vectorize_flood_zone(zone_payload["mask_path"])
            for label, band_geoms in bands.items():
                riverine_vs_bands[label] = aa.assess_vector_overlap([riverine_geom], band_geoms)
        except Exception:
            logger.warning(
                "flood_validation: riverine-vs-band shape comparison failed for %r "
                "(degraded, AHP comparison below still attempted)", catchment_key, exc_info=True,
            )
            riverine_vs_bands = {"error": "riverine flood-zone comparison failed"}

    ahp_vs_bands = {}
    try:
        zones_result = flood_model.build_ahp_zone_geometries(catchment_key, lite=True, force=force)
        from shapely.geometry import shape as shapely_shape
        zone_geoms_by_class = {}
        for feat in zones_result["geojson"]["features"]:
            zone_class = feat["properties"]["zone_class"]
            zone_geoms_by_class.setdefault(zone_class, []).append(shapely_shape(feat["geometry"]))

        for zone_class, geoms_a in zone_geoms_by_class.items():
            ahp_vs_bands[zone_class] = {
                label: aa.assess_vector_overlap(geoms_a, band_geoms)
                for label, band_geoms in bands.items()
            }
    except Exception:
        logger.warning(
            "flood_validation: AHP-zone-vs-band shape comparison failed for %r (degraded)",
            catchment_key, exc_info=True,
        )
        ahp_vs_bands = {"error": "AHP zone comparison failed"}

    payload = {
        "catchment": catchment_key,
        "river_system": river_system,
        "riverine_vs_bands": riverine_vs_bands,
        "ahp_vs_bands": ahp_vs_bands,
    }

    tmp_cache = f"{cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_cache, cache_path)
    except OSError:
        logger.warning(
            "flood_validation: could not write shape-comparison cache for %r "
            "(non-fatal — this will simply be recomputed next time)",
            catchment_key, exc_info=True,
        )

    return payload
