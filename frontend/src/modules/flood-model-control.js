// flood-model-control.js
import { Popup } from "mapbox-gl";
import Chart from "chart.js/auto";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import { bbox as turfBbox } from "@turf/turf";
// ---------------------------------------------------------------------------
// A self-contained rail button + panel for the flash-flood early-warning
// system's first frontend slice (see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md
// §7 "Phase 1.6" and §0.15 for the backend this calls). Zero coupling to
// ncop_menu_items/sourcelayer-control.js — same structural pattern
// GisExportControl already established: own DOM injected in the
// constructor, own RAIL_PANEL_REGISTRY entry in dashboard.js, delegated
// event listeners on a persistent content container.
//
// §0.36 — the ORIGINAL Phase 1.6 vision, closed: alongside the 4 curated
// pilot catchments, a real, themed lasso/trash control (§0.39, replacing
// the original dropdown-option idea) lets an operator draw a custom
// area, backed by @mapbox/mapbox-gl-draw + @turf/turf (both already
// installed, confirmed unused elsewhere in this app before this).
// Fixed-threshold, discharge-driven (with server-side auto-derived
// composite_cn/basin_length_km), and AHP mode all work for a drawn
// flash-flood area — the same job runners every curated pilot already
// uses, unmodified. §0.44 extended this to riverine too: a custom
// riverine AOI has no real, named FFD gauge station (this app's own FFD
// network covers exactly 31 named barrages/dams — see flood_riverine.py's
// own module docstring), so flood_model.build_riverine_flood_zone
// derives a water level from GeoGLOWS (a real global streamflow
// forecast service) + a synthetic rating curve instead — the SAME
// connected-flood-fill spatial engine every real-gauge riverine pilot
// already uses, not a separate technique.
//
// Async job-id polling against /api/flood-model/run/ + /api/flood-model/
// status/<job_id>/ (ncop_internal/flood_model_views.py) — never a single
// blocking request, matching that endpoint's own confirmed-live 64-85s
// runtime. Polling only runs while the panel is actually visible (stopped
// on hide, resumed on reopen if a job was left in flight) — no reason to
// keep hitting the status endpoint for a closed panel nobody's looking at.
// ---------------------------------------------------------------------------

const FLOOD_MODEL_RUN_ENDPOINT = "/api/flood-model/run/";
const FLOOD_MODEL_STATUS_ENDPOINT = "/api/flood-model/status/";
// §0.37 — fire-and-forget custom-AOI prewarm, called right after a real
// polygon is drawn (see #onDrawChange). A pure optimization — safe to
// call, safe to fail, never awaited by anything the user is blocked on.
const FLOOD_MODEL_PREWARM_ENDPOINT = "/api/flood-model/prewarm-custom-aoi/";
// §0.47 — download the currently-shown result (zone/AHP-zone geometry +
// every already-computed exposure attribute) as a real GeoJSON file.
const FLOOD_MODEL_EXPORT_ENDPOINT = "/api/flood-model/export/";
const POLL_INTERVAL_MS = 3000;
const RESULT_RASTER_SOURCE_ID = "flood-model-result-raster";
const RESULT_RASTER_LAYER_ID = "flood-model-result-raster-layer";
const CATCHMENT_MARKER_SOURCE_ID = "flood-model-catchment-marker";
const CATCHMENT_MARKER_LAYER_ID = "flood-model-catchment-marker-layer";
// AHP zone polygons (post-zonation) — a separate GeoJSON fill source, NOT
// the "image" raster source every other mode's own #addResultLayer uses.
// Replaces AHP mode's earlier full-bbox continuous-score PNG overlay
// (confirmed live, real screenshot review: it read as "too big"/unclipped
// next to every other mode's own clipped, classified rendering) with 3
// discrete, classified zone polygons instead — see flood_model.
// build_ahp_zone_geometries.
const AHP_ZONE_SOURCE_ID = "flood-model-ahp-zone-source";
const AHP_ZONE_FILL_LAYER_ID = "flood-model-ahp-zone-fill-layer";
const AHP_ZONE_OUTLINE_LAYER_ID = "flood-model-ahp-zone-outline-layer";
// Same severity palette flood_model.py's own _AHP_ZONE_COLORS already
// uses server-side (itself reused verbatim from this app's own
// "Hydrological Layers" flood-extent layers, map-layers.js's own
// buildFloodExtents() IIFE) — kept here too so the legend/fill-color
// expression don't have to trust the payload's own "color" property
// alone (defensive: a real, known-good fallback if that field is ever
// missing from an older cached result).
const AHP_ZONE_COLORS = { low: "#FFC300", medium: "#FF5733", high: "#C70039" };
const AHP_ZONE_LOW_OPACITY = 0.25;  // faint — design decision: only Medium/High should read as visually "colored"
const AHP_ZONE_MEDIUM_HIGH_OPACITY = 0.65;

// Classified point/line map layers (flood_exposure.
// build_ahp_zone_classified_map_layers) — schools/settlements/airports/
// bridges/hospitals as zone-colored points, drainage/roads as zone-
// colored lines. `minzoom` gates all of them so the map doesn't clutter
// at low zoom (buildings are deliberately NOT included here — up to
// 419K in a single catchment's AOI, a real crash risk; only aggregate
// zone counts are shown, see #renderAhpResults — individual-building
// rendering stays Sub-phase 5's own deferred, viewport-bounded work).
const AHP_POINTS_SOURCE_ID = "flood-model-ahp-points-source";
const AHP_POINTS_LAYER_ID = "flood-model-ahp-points-layer";
const AHP_DRAINAGE_SOURCE_ID = "flood-model-ahp-drainage-source";
const AHP_DRAINAGE_LAYER_ID = "flood-model-ahp-drainage-layer";
const AHP_ROADS_SOURCE_ID = "flood-model-ahp-roads-source";
const AHP_ROADS_LAYER_ID = "flood-model-ahp-roads-layer";
const AHP_POINTS_MINZOOM = 12;   // schools/settlements/bridges/hospitals/airports
const AHP_DRAINAGE_MINZOOM = 11;
const AHP_ROADS_MINZOOM = 13;    // roads are the densest of the three, gated latest

// Sub-phase 5 — viewport-bounded buildings-on-zoom (ncop_internal.
// flood_exposure.get_buildings_in_viewport, served via
// FloodModelAhpBuildingsInViewView). Individual building footprints,
// fetched only for the current small map viewport and only once zoomed
// in close — the deliberately-deferred piece of the classified-exposure
// work (up to 419K buildings per catchment's own AOI, a real crash risk
// shipped whole; only aggregate zone counts come with the main result
// payload — see #renderAhpResults).
const FLOOD_MODEL_AHP_BUILDINGS_ENDPOINT = "/api/flood-model/ahp-buildings-in-view/";
const AHP_BUILDINGS_SOURCE_ID = "flood-model-ahp-buildings-source";
const AHP_BUILDINGS_LAYER_ID = "flood-model-ahp-buildings-layer";
const AHP_BUILDINGS_OUTLINE_LAYER_ID = "flood-model-ahp-buildings-outline-layer";
const AHP_BUILDINGS_MINZOOM = 15; // deep zoom only
// Slightly more conservative than weather-report-control.js's own 150ms
// throttle — that one re-renders from already-fetched client state; this
// one hits a real backend endpoint on every fire, so a bit more headroom
// between requests during a fast pan/zoom session.
const AHP_BUILDINGS_RENDER_MIN_INTERVAL_MS = 200;

// Real, existing AUC interpretation bands (accuracy_assessment.py's own
// _AUC_INTERPRETATION_BANDS: excellent >=0.9, good >=0.8, fair >=0.7,
// poor >=0.6, fail <0.6) — used as the AUC chart's reference lines, not
// invented cutoffs. chart.js instance keyed by canvas id, destroy-
// before-recreate on every redraw — same convention crop-explorer-
// control.js's own chartInstances dict already establishes elsewhere in
// this app.
const AUC_INTERPRETATION_BANDS = [
  { threshold: 0.9, label: "excellent" },
  { threshold: 0.8, label: "good" },
  { threshold: 0.7, label: "fair" },
  { threshold: 0.6, label: "poor" },
  { threshold: 0.0, label: "fail" },
];
const AHP_AUC_CHART_CANVAS_ID = "floodModelAhpAucChart";
const chartInstances = {};

// Known pilot catchments — mirrors flood_model.PILOT_CATCHMENTS server-side
// (project/ncop_internal/flood_model.py). Kept as a small static list here
// rather than fetched from an endpoint: adding one is a one-line change
// here and a one-line change there, and this avoids a network round-trip
// just to populate a dropdown. `center` is the bbox centroid (matches the
// server-side bbox exactly), used only to place a marker+tooltip so an
// operator can see roughly where a catchment sits before running it.
// `floodType` mirrors flood_model.PILOT_CATCHMENTS' own "flood_type"
// field exactly — a flood type is a property of the catchment's own
// physical character (small nullah vs. major-river reach), not an
// independent request toggle a user applies to any catchment (§R4's own
// design decision, matching the approved plan). This is what the "Flood
// type" selector below actually filters on.
const KNOWN_CATCHMENTS = [
  // Rahman et al., WMO/APFM case study — see flood_model.py §0.17.
  { key: "nullah_lai", label: "Nullah Lai (Rawalpindi/Islamabad)", center: [73.0167, 33.6583], floodType: "flash" },
  // §0.23 — added directly from the methodology doc's own literature
  // review (§0.22); see flood_model.py's own PILOT_CATCHMENTS entry for
  // the full sourcing/uncertainty account (bbox empirically corrected
  // against a published basin-area figure, not a precise published
  // boundary the way Nullah Lai's own is).
  { key: "peshawar_bhudni_nullah", label: "Bhudni Nullah Basin (Peshawar)", center: [71.575, 34.09], floodType: "flash" },
  // §0.49 — 4 more real, literature-documented flash-flood-prone areas
  // (Karachi urban pluvial flooding, Swat's own 2010 flash flood, Lasbela
  // 2022 floods, Hunza GLOF-adjacent risk) — see flood_model.py's own
  // PILOT_CATCHMENTS comment for the full sourcing account and live-
  // tested composite_cn/basin_length_km/terrain_class numbers.
  { key: "karachi_urban", label: "Karachi Urban (Gujjar/Orangi Nullah)", center: [67.06, 24.93], floodType: "flash" },
  { key: "swat_mingora", label: "Swat — Mingora", center: [72.36, 34.773], floodType: "flash" },
  { key: "lasbela_uthal", label: "Lasbela — Uthal", center: [66.617, 25.807], floodType: "flash" },
  { key: "hunza_karimabad", label: "Hunza — Karimabad", center: [74.65, 36.317], floodType: "flash" },
  // §R4 — riverine catchments, real major-river reaches near a live FFD
  // gauge, chosen from a real multi-source data-availability check (see
  // flood_model.py's own PILOT_CATCHMENTS comment for the full account:
  // real live discharge/status/water-level data, official published
  // flood-severity thresholds, real WFS flood-extent zonation overlap,
  // and real GFD ground truth all confirmed live for both).
  { key: "chashma_indus", label: "Chashma Barrage (Indus)", center: [71.37889, 32.43389], floodType: "riverine" },
  { key: "guddu_indus", label: "Guddu Barrage (Indus)", center: [69.7132, 28.4186], floodType: "riverine" },
  // §0.48 — the rest of Pakistan's own real FFD gauge/barrage network
  // (Indus, Jhelum, Chenab, Ravi, Sutlej, Kabul, + Azad Kashmir), real
  // live-confirmed names/coordinates from flood_riverine.
  // FFD_WATERLEVELS_URL (see flood_model.py's own PILOT_CATCHMENTS
  // comment for the full sourcing account) — every `key` here matches
  // that same dict's own key exactly, `center` is each station's own
  // real [lon, lat].
  { key: "azad_pattan", label: "Azad Pattan (Jhelum River)", center: [73.601, 33.731], floodType: "riverine" },
  { key: "balloki", label: "Balloki (Ravi River)", center: [73.8596, 31.2222], floodType: "riverine" },
  { key: "besham", label: "Besham (Indus River)", center: [72.866788, 34.905843], floodType: "riverine" },
  { key: "chattar_kallas", label: "Chattar Kallas (Azad Kashmir)", center: [73.494, 34.2], floodType: "riverine" },
  { key: "chiniot_bridge", label: "Chiniot Bridge (Chenab River)", center: [72.947924, 31.752697], floodType: "riverine" },
  { key: "domel", label: "Domel (Azad Kashmir)", center: [73.4901, 34.3444], floodType: "riverine" },
  { key: "ganda_singh_wala", label: "Ganda Singh Wala (Sutlej River)", center: [74.545256, 30.993429], floodType: "riverine" },
  { key: "islam", label: "Islam (Sutlej River)", center: [72.5485, 29.8263], floodType: "riverine" },
  { key: "jassar", label: "Jassar (Ravi River)", center: [74.992018, 32.049654], floodType: "riverine" },
  { key: "kala_bagh", label: "Kala Bagh (Indus River)", center: [71.5219, 32.9187], floodType: "riverine" },
  { key: "khanki", label: "Khanki (Chenab River)", center: [73.9685, 32.4088], floodType: "riverine" },
  { key: "kotli", label: "Kotli (Azad Kashmir)", center: [73.9109, 33.5296], floodType: "riverine" },
  { key: "kotri", label: "Kotri (Indus River)", center: [68.3151, 25.4428], floodType: "riverine" },
  { key: "mangla_dam", label: "Mangla Dam (Jhelum River)", center: [73.6491, 33.1507], floodType: "riverine" },
  { key: "marala", label: "Marala (Chenab River)", center: [74.41125, 32.660583], floodType: "riverine" },
  { key: "muzaffarabad", label: "Muzaffarabad (Azad Kashmir)", center: [73.465, 34.383], floodType: "riverine" },
  { key: "new_rasul", label: "New Rasul (Jhelum River)", center: [73.5186, 32.6832], floodType: "riverine" },
  { key: "nowshera", label: "Nowshera (Kabul River)", center: [71.9846, 34.009583], floodType: "riverine" },
  { key: "panjnad", label: "Panjnad (Chenab River)", center: [71.0202, 29.3464], floodType: "riverine" },
  { key: "partab_bridge", label: "Partab Bridge (Indus River)", center: [74.37, 35.44], floodType: "riverine" },
  { key: "qadirabad", label: "Qadirabad (Chenab River)", center: [73.6851, 32.3209], floodType: "riverine" },
  { key: "shahdara", label: "Shahdara (Ravi River)", center: [74.2956, 31.6085], floodType: "riverine" },
  { key: "sidhnai", label: "Sidhnai (Ravi River)", center: [72.1582, 30.5723], floodType: "riverine" },
  { key: "skardu", label: "Skardu (Indus River)", center: [75.604, 35.338], floodType: "riverine" },
  { key: "sukkur", label: "Sukkur (Indus River)", center: [68.8462, 27.679], floodType: "riverine" },
  { key: "sulemanki", label: "Sulemanki (Sutlej River)", center: [73.8663, 30.3777], floodType: "riverine" },
  { key: "tarbela_dam", label: "Tarbela Dam (Indus River)", center: [72.7338, 34.1059], floodType: "riverine" },
  { key: "taunsa", label: "Taunsa (Indus River)", center: [70.836721, 30.518528], floodType: "riverine" },
  { key: "trimmu", label: "Trimmu (Chenab River)", center: [72.146, 31.1448], floodType: "riverine" },
];

const FLOOD_TYPE_FLASH = "flash";
const FLOOD_TYPE_RIVERINE = "riverine";

function getCatchmentsForFloodType(floodType) {
  return KNOWN_CATCHMENTS.filter((c) => c.floodType === floodType);
}

// Per-catchment accuracy figures — §0.22/§0.23's own real, multi-trial
// AUC results (accuracy_assessment.assess_raster_auc_stable /
// assess_pooled_multi_raster_auc_stable, 8 trials each). Kept as data
// here rather than duplicated prose in two render methods, so adding a
// catchment's numbers is a one-time data entry, not a text-editing
// exercise, and so the notes can never show one catchment's numbers
// while a DIFFERENT catchment is actually selected — a real correctness
// risk once a second catchment existed, not present when there was only
// one. `comparisonNote` is optional HTML — a catchment-specific external
// validation point (e.g. Nullah Lai's own HEC-RAS comparison); omitted
// entirely for a catchment without an equivalent published comparison,
// rather than reusing another catchment's unrelated one.
const CATCHMENT_ACCURACY_INFO = {
  nullah_lai: {
    rawHandAuc: "0.614", rawHandBand: "poor", rawHandRange: "0.58&ndash;0.64",
    dischargeAuc: "0.81", dischargeBand: "good", dischargeRange: "0.79&ndash;0.82",
    nEvents: "10", improvementNote: "a real, substantial, multi-trial-confirmed improvement",
    comparisonNote: `Validated against a published HEC-RAS/HEC-GeoRAS hydraulic model
      of Nullah Lai's own main channel (Kattarian&ndash;Gawalmandi reach, Rawalpindi):
      at a discharge close to that study's own severe 3,000 m&sup3;/s scenario, this
      mode produces roughly 19.8 km&sup2; of whole-basin susceptibility &mdash; about
      2.5&times; smaller than the fixed-threshold mode's 49.75 km&sup2; at the same
      location, the remaining gap explained by scope (whole basin vs. one channel
      reach), not a structural flaw.`,
    ahp: {
      // Validated against the SMOOTHED score (flood_connectivity.
      // box_mean_filter, radius 8px) — the input build_ahp_zone_
      // geometries actually classifies into zones, not the raw score.
      // Confirmed live smoothing IMPROVES AUC at all 4 catchments (it
      // removes pixel-level noise from combining several already-noisy
      // factors) — this correction replaces the earlier raw-score
      // citation (0.889), itself now stale relative to what's deployed.
      auc: "0.924", aucMin: "0.9191", aucMax: "0.9279", band: "excellent", terrainClass: "moderate_relief",
      note: `A large, real jump over this catchment's own raw-HAND baseline
        (${"0.614"}) &mdash; the strongest AHP result across all 4 pilot
        catchments, in either flood type.`,
    },
  },
  peshawar_bhudni_nullah: {
    rawHandAuc: "0.68", rawHandBand: "poor", rawHandRange: "0.65&ndash;0.70",
    dischargeAuc: "0.71", dischargeBand: "fair", dischargeRange: "0.70&ndash;0.72",
    nEvents: "9", improvementNote: `a real but much MORE MODEST improvement than
      Nullah Lai's own (+0.03 here vs. +0.20 there) &mdash; plausibly because this
      basin's terrain is far flatter (HAND values here top out around 76m vs. Nullah
      Lai's 478m), and the literature (Wahba et al. 2026, &sect;0.22) specifically
      documents HAND-class methods struggling more in flat terrain, where a
      discharge-driven stage has less local relief to differentiate against`,
    comparisonNote: null,
    ahp: {
      // Smoothed-score validation (see nullah_lai's own comment above for
      // why) — a real, meaningful improvement over the earlier raw-score
      // citation (0.771 fair), now genuinely "good".
      auc: "0.842", aucMin: "0.8387", aucMax: "0.846", band: "good", terrainClass: "flat_relief",
      note: `Inside the original 75&ndash;85% target range this whole AHP phase
        was built toward &mdash; and, after smoothing, comfortably so.`,
    },
  },
  // §R4/§0.28-0.30 — riverine catchments, added to this dict for the first
  // time as part of actually wiring the riverine mode into the UI (it was
  // previously reachable server-side but never had its own results/
  // accuracy rendering here). No single AUC number for the gauge-driven
  // mode itself (its output is a BINARY mask, not a continuous score —
  // confusion-matrix metrics are the correct family, see the methodology
  // doc §0.28) — only the newer AHP susceptibility mode gets a number here,
  // an honest gap, not an omission.
  chashma_indus: {
    rawHandAuc: null, rawHandBand: null, rawHandRange: null,
    dischargeAuc: null, dischargeBand: null, dischargeRange: null,
    nEvents: "20",
    ahp: {
      // Smoothed-score validation — a further real improvement over the
      // earlier raw-score citation (0.750), on top of the connectivity-
      // factor gain already documented in §0.29.
      auc: "0.767", aucMin: "0.7642", aucMax: "0.7717", band: "fair", terrainClass: "high_drainage_density",
      note: `Clears the revised 70% floor for this catchment. Improved
        substantially (from 0.690 &ldquo;poor&rdquo;) after a new
        connectivity factor was added in direct response to this
        catchment's own validation result, then further after smoothing
        the score before zone classification &mdash; see the methodology
        doc &sect;0.29 for the full account.`,
    },
  },
  guddu_indus: {
    rawHandAuc: null, rawHandBand: null, rawHandRange: null,
    dischargeAuc: null, dischargeBand: null, dischargeRange: null,
    nEvents: "17",
    ahp: {
      // Smoothed-score validation — a small further improvement (+0.011)
      // over the earlier raw-score citation (0.612), still "poor".
      auc: "0.620", aucMin: "0.6119", aucMax: "0.6279", band: "poor", terrainClass: "low_drainage_density",
      note: `The harder of the two riverine pilots &mdash; improved
        substantially (from 0.487 &ldquo;fail&rdquo;, essentially random)
        after the same connectivity-factor addition, and a little further
        after smoothing the score before zone classification, but still
        short of the 72% floor set for the worse-performing catchment.
        Reported honestly, not tuned further against this one pilot's
        own result &mdash; see the methodology doc &sect;0.29 for the
        full, considered account of what was tried and why this is the
        current, real state.`,
    },
  },
};

function getCatchmentAccuracyInfo(catchmentKey) {
  return CATCHMENT_ACCURACY_INFO[catchmentKey] || null;
}

// Starting value only — NOT calibrated for this catchment. See
// flood_model.HAND_FLOOD_PRONE_THRESHOLD_M's own docstring (methodology
// doc §0.17) for the full citation trail: a genuinely calibrated
// threshold needs a rainfall/discharge scenario (Phase 2, not yet built),
// not a fixed number. 3.0m is kept mid-range within the one geographically
// comparable published study found (Bhatt & Srinivasa Rao 2018, Hyderabad
// urban HAND study — HAND 1-5m spans "very high to very low" flood
// susceptibility there) — shown to the operator directly in this panel's
// own methodology note, not just in a code comment nobody using the UI
// would ever see.
const DEFAULT_THRESHOLD_M = 3.0;
const MIN_THRESHOLD_M = 0.5;
const MAX_THRESHOLD_M = 10.0;
const THRESHOLD_STEP_M = 0.5;

// Discharge-driven mode (methodology doc §0.19) — a real rainfall/
// duration scenario replaces the fixed HAND threshold above with a
// genuine, per-reach flood stage (SCS-CN -> Kirpich -> SCS unit
// hydrograph -> Manning's equation). Bounds mirror
// flood_model_views.py's own server-side validation
// (_MIN/_MAX_RAINFALL_MM, _MIN/_MAX_DURATION_HR) exactly — a request
// outside these would just 400 server-side, so keeping the same bounds
// here lets the panel reject it before ever hitting the network.
// Default (100mm/4hr) is a moderate storm, roughly comparable in scale
// to Farooq et al.'s own study rainfall for this basin — not an extreme
// scenario by default, so a first-time run doesn't imply "this is what
// severe flooding looks like" before the operator has chosen anything.
const DEFAULT_RAINFALL_MM = 100.0;
const MIN_RAINFALL_MM = 0.1;
const MAX_RAINFALL_MM = 1000.0;
const DEFAULT_DURATION_HR = 4.0;
const MIN_DURATION_HR = 0.1;
const MAX_DURATION_HR = 72.0;

const MODE_THRESHOLD = "threshold";
const MODE_DISCHARGE = "discharge";
// Riverine mode's own existing behavior (§R4) — a live FFD gauge reading
// run through connected_flood_fill, the ONLY mode a riverine catchment
// has ever actually supported server-side. No request-body 'mode' key is
// sent for this one (flood_model_views.py's own post() dispatches on the
// catchment's flood_type automatically when no 'mode' is given) — kept
// as an explicit frontend mode constant anyway so the flood-type-aware
// selector below has a real, named option instead of an implicit default.
const MODE_RIVERINE_GAUGE = "riverine_gauge";
// AHP susceptibility (§0.29/§0.30) — the ONE mode that works identically
// for EITHER flood type, opt-in via 'mode': 'ahp_susceptibility' on the
// request body. Available regardless of which flood type is selected.
const MODE_AHP = "ahp_susceptibility";

// Which modes are offered for each flood type — riverine catchments have
// no local rainfall-runoff concept (no threshold/discharge inputs), so
// they get their own gauge-driven default instead of the flash-flood
// pair. AHP is common to both.
// §0.36 — custom-AOI draw tool. Same value flood_model_views.py's own
// post() checks for ("custom" body.catchment) and the same area cap
// flood_model.MAX_CATCHMENT_BBOX_DEG2 already enforces server-side —
// duplicated here ONLY for immediate client-side feedback (the server
// check is still the real, authoritative one; this just avoids a round
// trip for an obviously-oversized draw).
const CUSTOM_AOI_CATCHMENT_KEY = "custom";
const MAX_CUSTOM_AOI_BBOX_DEG2 = 0.30;

const MODES_FOR_FLOOD_TYPE = {
  [FLOOD_TYPE_FLASH]: [
    { value: MODE_THRESHOLD, label: "Fixed HAND threshold (susceptibility)" },
    { value: MODE_DISCHARGE, label: "Rainfall scenario (discharge-driven)" },
    { value: MODE_AHP, label: "AHP susceptibility (literature-weighted)" },
  ],
  [FLOOD_TYPE_RIVERINE]: [
    { value: MODE_RIVERINE_GAUGE, label: "Live gauge-driven flood zone" },
    { value: MODE_AHP, label: "AHP susceptibility (literature-weighted)" },
  ],
};

// Rainfall input sources for discharge-driven mode (§0.26) — mirrors
// flood_forecast.RAINFALL_SOURCES exactly. "manual" (the original,
// unchanged path) stays the default; the other three replace the
// manually-typed rainfall_mm/duration_hr with a value fetched server-side
// from this app's own already-integrated weather data (CHIRPS satellite
// estimate, PMD Monitor's WRFPRS forecast, or PMD's NWFC observed-rainfall
// report) — additive options, not a replacement for manual entry.
const RAINFALL_SOURCE_MANUAL = "manual";
const RAINFALL_SOURCE_CHIRPS = "chirps";
const RAINFALL_SOURCE_PMD_FORECAST = "pmd_forecast";
const RAINFALL_SOURCE_LIVE_OBSERVED = "live_observed";

// Mirrors flood_forecast.PMD_FORECAST_ELEMENTS exactly (element_key ->
// accumulation window) — kept as display labels here since the backend
// dict maps to hours, not human text.
const PMD_FORECAST_ELEMENTS = [
  { key: "hourtpe", label: "Next 3 hours" },
  { key: "sixtpe", label: "Next 6 hours" },
  { key: "twelvetpe", label: "Next 12 hours" },
  { key: "daytpe", label: "Next 24 hours" },
];

// Mirrors flood_exposure.build_exposure_report()'s own progress_callback
// stage names EXACTLY, in the order flood_model_views.py's job runner
// reports them (see that module's _run_flood_model_job) — a real string-
// matching coupling between frontend and backend, not resolved by a
// formal stage-id enum on this pass; if a backend stage name ever
// changes, this list needs updating too, silently otherwise (a stage
// would just never tick — degrades gracefully, doesn't crash the panel).
const RUN_STAGES = [
  "Fetching elevation & computing terrain hydrology (HAND)",
  "Building flood-prone zone raster",
  "Vectorizing flood-prone zone",
  "Tagging administrative context (district/tehsil)",
  "Reusing existing NCOP infrastructure (airports/schools/settlements)",
  "Fetching building exposure (Overture)",
  "Fetching bridges & hospitals (OSM)",
  "Fetching road network (OSM)",
  "Fetching drainage network (OSM)",
  "Fetching population exposure (WorldPop)",
];

// Discharge-driven mode's own (much shorter) stage sequence — mirrors
// flood_model_views.py's _run_flood_model_job discharge branch exactly
// (only 2 _mark_stage calls, since this mode skips build_exposure_report
// entirely — see that function's own docstring for why). A SEPARATE list
// from RUN_STAGES above, not a shared one filtered down: the two modes'
// pipelines are genuinely different work, not the same steps with some
// skipped.
const DISCHARGE_RUN_STAGES = [
  "Fetching elevation & computing terrain hydrology (HAND)",
  "Computing rainfall-driven discharge & spatially-varying flood stage",
];

// Riverine mode's own stage list — mirrors flood_model_views.py's
// _run_riverine_flood_model_job exactly (2 _mark_stage calls before the
// SAME exposure stages the fixed-threshold mode's own RUN_STAGES lists,
// since riverine mode reuses build_exposure_report unchanged for that
// part). Built by slicing into RUN_STAGES rather than retyping its own
// exposure-stage strings a third time — a real string-coupling with the
// backend either way (see RUN_STAGES' own comment), kept in exactly one
// place for the exposure half.
//
// Second stage's text corrected (was "...gauge-calibrated flood
// threshold", stale from before §R4's rebuild replaced the uniform-HAND-
// threshold approach with connected_flood_fill — the backend's own
// _mark_stage call was updated then but this string never was, so this
// checklist row silently never ticked; a real, harmless-but-real bug
// fixed while actually wiring this mode into the UI for the first time).
const RIVERINE_RUN_STAGES = [
  "Fetching elevation & computing terrain hydrology (HAND)",
  "Reading live river gauge & computing connected flood extent",
  ...RUN_STAGES.slice(1),
  "Comparing against existing flood-extent hazard layers",
];

// AHP susceptibility mode's own stage list (post-zonation) — mirrors the
// STABLE, always-in-this-order milestones flood_model_views.py's
// _run_ahp_susceptibility_job and flood_exposure.
// build_ahp_zone_exposure_report emit. Deliberately NOT a 1:1 list of
// every stage those two functions actually mark — the exposure report's
// own per-zone stages (e.g. "[low] Fetching building exposure
// (Overture)") are zone-LABEL-prefixed and the zone iteration order is
// data-dependent (whichever classes are actually present, in dict
// order), not a fixed, hardcodable sequence. Listing only the stable
// milestones here and letting the rest flow through unlisted matches
// this file's own already-established tolerance (see RUN_STAGES' own
// comment: an unmatched stage simply never ticks a checklist row,
// degrades gracefully, never crashes the panel) — simpler and more
// robust than trying to enumerate a dynamic sequence.
const AHP_RUN_STAGES = [
  "Fetching elevation & computing terrain hydrology (HAND)",
  "Building AHP factor rasters (distance-to-river, TWI, LULC, soil, rainfall, NDVI, connectivity...)",
  "Combining factors via literature-weighted overlay",
  "Building susceptibility zone boundaries (low/medium/high)",
  "Computing road & drainage exposure per zone",
  "Tagging administrative context by dominant susceptibility zone",
  "Building classified map layers (schools, bridges, roads, drainage)",
  "Comparing against existing flood-extent hazard layers",
];

// §0.37 — real, cited timing ranges from this project's own confirmed-
// live history (FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md §0.12/§0.23/
// §0.36/§0.37), not invented numbers. Matched against a stage's own
// label via .includes() (exact stage text varies slightly by mode, the
// matched substring doesn't). Shown only for the CURRENTLY active
// stage, next to its own real elapsed time — an honest range, not a
// fabricated smoothly-ticking progress bar.
// §0.40 — `typicalSeconds` added alongside each existing human hint (the
// SAME cited real numbers, just also expressed as a plain number) so a
// remaining-time COUNTDOWN can be computed, not just shown as text. Take
// the upper end of each cited range — an honest ceiling, not an average —
// since a countdown that hits 0 while the stage is visibly still not
// done reads as broken; hitting 0 and sitting there ("finishing up…")
// on a genuinely slow real-world case reads as correct.
const STAGE_TIME_HINTS = [
  { match: "Overture", hint: "typically 225-270s; several minutes for a brand-new custom area", typicalSeconds: 270 },
  { match: "terrain hydrology (HAND)", hint: "seconds if cached, ~1-2min if this area's terrain is new", typicalSeconds: 120 },
  { match: "bridges & hospitals", hint: "typically 20-90s (OSM Overpass, can retry on a transient error)", typicalSeconds: 90 },
  { match: "road network", hint: "typically 10-40s", typicalSeconds: 40 },
  { match: "drainage network", hint: "typically 10-40s", typicalSeconds: 40 },
  { match: "population exposure", hint: "typically 5-15s", typicalSeconds: 15 },
  { match: "AHP factor rasters", hint: "typically 30-90s", typicalSeconds: 90 },
];
function stageTimeEstimate(stageLabel) {
  return STAGE_TIME_HINTS.find((h) => stageLabel.includes(h.match)) || null;
}

export class FloodModelControl {
  #map;
  #isVisible = false;
  #busy = false;
  #activeJobId = null;
  #pollTimer = null;
  #floodType = FLOOD_TYPE_FLASH;
  #selectedCatchment = KNOWN_CATCHMENTS[0]?.key || null;
  #mode = MODE_THRESHOLD;
  #selectedThreshold = DEFAULT_THRESHOLD_M;
  #selectedRainfallMm = DEFAULT_RAINFALL_MM;
  #selectedDurationHr = DEFAULT_DURATION_HR;
  #selectedRainfallSource = RAINFALL_SOURCE_MANUAL;
  #selectedChirpsDays = 1;
  #selectedPmdElement = "daytpe";
  #lastResult = null;
  #lastResultMode = null;
  // §0.47 — the job_id a finished #lastResult actually came from, kept
  // separately from #activeJobId (which #poll() always nulls once a job
  // reaches a terminal state) so the "Download results" button still
  // has a real job_id to export against after the run completes.
  #lastJobId = null;
  #lastDischargeScenario = null;
  #completedStages = [];
  #currentStage = null;
  #elapsedSeconds = null;
  // §0.40 — client-side timestamp of when #currentStage last CHANGED
  // (not server-provided — the backend only exposes whole-job elapsed
  // time, not per-stage) + the 1s local ticker that redraws the
  // checklist between poll ticks so a countdown reads as a genuinely
  // live "10, 9, 8…", not just a value that jumps every POLL_INTERVAL_MS
  // (3s). See #renderChecklistTimeCell for how these combine with
  // STAGE_TIME_HINTS' own typicalSeconds into a real, honest estimate.
  #currentStageStartedAt = null;
  #stageTickTimer = null;
  #catchmentPopup = null;

  // §0.36 — custom-AOI draw tool state. #mapboxDraw is created lazily
  // (only once a user actually picks "Draw custom area…") and left on
  // the map afterward (matching MapboxDraw's own idiom — cheap to keep
  // idle, no reason to tear down/recreate on every toggle); #drawnBbox
  // is null until a real polygon exists.
  #mapboxDraw = null;
  #drawnBbox = null;
  #drawnPolygon = null;
  #drawModeActive = false;

  // Sub-phase 5 — buildings-on-zoom viewport listener state. Attached
  // lazily only while an AHP result is currently rendered (mirrors
  // weather-report-control.js's own lazy-attach-while-panel-open
  // convention), never left running for a threshold/discharge/riverine
  // result.
  #ahpBuildingsListenersAttached = false;
  #ahpBuildingsCatchmentKey = null;
  #ahpBuildingsLastFingerprint = "";
  #ahpBuildingsRenderTimerId = null;
  #ahpBuildingsLastRenderAt = 0;
  #ahpBuildingsAbortController = null;
  #boundOnAhpBuildingsMapMove = null;

  constructor(map) {
    this.#map = map;
    this.#render();
    this.#wireEvents();
    window.ncopFloodModelControl = this;
  }

  // ---- DOM ------------------------------------------------------------------
  #render() {
    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    const wrap = document.createElement("div");
    wrap.className = "custom-flood-model-control";
    wrap.innerHTML = `
      <button id="floodModelToggle" class="custom-flood-model-btn" type="button" title="Flash-Flood Early Warning">
        <i data-lucide="triangle-alert"></i>
      </button>
      <div id="floodModelPanel" class="flood-model-panel">
        <div class="flood-model-header">
          <div class="flood-model-title-group">
            <span class="flood-model-title">Flash-Flood Early Warning</span>
            <span class="flood-model-subtitle">HAND-based hazard + exposure, per catchment.</span>
          </div>
          <button id="floodModelClose" class="flood-model-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div id="floodModelContent" class="flood-model-content"></div>
      </div>
    `;
    mapEl.appendChild(wrap);
    try { window.lucide?.createIcons(); } catch (_) {}
  }

  #esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s ?? "");
    return d.innerHTML;
  }

  // Clears any result from a previous run — shared by every selection
  // change that invalidates the currently-shown result (flood type,
  // catchment, mode) AND by #runModel() itself at the start of a new
  // run, previously four separate copies of the same four lines.
  #clearStaleResults() {
    this.#lastResult = null;
    this.#lastResultMode = null;
    this.#lastDischargeScenario = null;
    this.#lastJobId = null;
    const resultsEl = document.getElementById("floodModelResults");
    if (resultsEl) resultsEl.innerHTML = "";
  }

  // ---- Show / hide ------------------------------------------------------------
  #wireEvents() {
    const toggle = document.getElementById("floodModelToggle");
    const panel = document.getElementById("floodModelPanel");
    const closeBtn = document.getElementById("floodModelClose");
    const content = document.getElementById("floodModelContent");

    toggle?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.#isVisible) this.hidePanel();
      else this.showPanel();
    });
    closeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hidePanel();
    });

    // One delegated listener — the content container is re-rendered on
    // every state change (catchment pick, run, poll tick), so per-element
    // listeners would leak, same reasoning GisExportControl's own content
    // listener already documents.
    content?.addEventListener("click", (event) => {
      if (event.target.closest("#floodModelRun")) { this.#runModel(); return; }
      if (event.target.closest("#floodModelClear")) { this.#clearMap(); return; }
      // §0.39 — the real, themed draw/trash control (Lucide `lasso` /
      // `trash-2`, icon-only squares) that IS how a custom draw starts
      // now — "Draw custom area…" is no longer a pickable dropdown
      // option at all (see #renderContent's catchmentOptions). Clicking
      // the lasso itself is what switches the active area to "custom",
      // mirroring what picking that dropdown option used to do; "Trash"
      // clears only the drawn shape via the same #deactivateDrawMode
      // every other draw-discarding path already uses, staying in
      // custom mode (selectedCatchment untouched) so a redraw needs
      // only the lasso again, not re-selecting anything.
      if (event.target.closest("#floodModelDrawBtn")) {
        if (this.#selectedCatchment !== CUSTOM_AOI_CATCHMENT_KEY) {
          this.#selectedCatchment = CUSTOM_AOI_CATCHMENT_KEY;
          this.#removeCatchmentMarker();
          this.#clearStaleResults();
        }
        this.#activateDrawMode();
        this.#renderContent();
        return;
      }
      if (event.target.closest("#floodModelDrawTrashBtn")) {
        this.#deactivateDrawMode();
        this.#setStatus("");
        this.#renderContent();
        return;
      }
      // §0.46 — proxies the click to the real (hidden) file input, same
      // "visible button triggers a hidden <input type=file>" pattern the
      // GIS Import panel's own browse link already uses.
      if (event.target.closest("#floodModelUploadBtn")) {
        document.getElementById("floodModelAoiFileInput")?.click();
        return;
      }
    });
    content?.addEventListener("change", (event) => {
      if (event.target.id === "floodModelAoiFileInput") {
        const file = event.target.files?.[0];
        event.target.value = ""; // allow re-selecting the SAME file next time (change wouldn't fire otherwise)
        if (file) this.#handleAoiFileUpload(file);
        return;
      }
      if (event.target.id === "floodModelFloodTypeSelect") {
        this.#floodType = event.target.value === FLOOD_TYPE_RIVERINE ? FLOOD_TYPE_RIVERINE : FLOOD_TYPE_FLASH;
        // Switching flood type swaps the WHOLE catchment list (a real
        // physical-character property, not an independent toggle — see
        // KNOWN_CATCHMENTS' own comment) — reset the catchment selection
        // to the first one of the new type, and the mode to that type's
        // own default (riverine has no threshold/discharge concept at
        // all), same reasoning every other selection-changing handler
        // here already applies.
        const catchmentsOfType = getCatchmentsForFloodType(this.#floodType);
        this.#selectedCatchment = catchmentsOfType[0]?.key || null;
        this.#mode = this.#floodType === FLOOD_TYPE_RIVERINE ? MODE_RIVERINE_GAUGE : MODE_THRESHOLD;
        this.#clearStaleResults();
        this.#deactivateDrawMode(); // riverine's own catchment list never offers "custom" — see MODES_FOR_FLOOD_TYPE
        this.#updateCatchmentMarker();
        this.#renderContent();
        return;
      }
      if (event.target.id === "floodModelCatchmentSelect") {
        // §0.39 — this dropdown only ever lists real, named catchments
        // now (see #renderContent) — a custom draw is started/redrawn
        // exclusively via the lasso icon-button, never through this
        // <select>. Picking a real catchment here always exits any
        // in-progress custom draw, discarding whatever was drawn —
        // matches the flood-type switch handler's own identical posture
        // a few lines above.
        this.#selectedCatchment = event.target.value;
        this.#deactivateDrawMode();
        this.#updateCatchmentMarker();
        // Full re-render, not just the marker — the accuracy notes are
        // catchment-specific (§0.23: a second real catchment exists, and
        // showing one catchment's AUC numbers while a DIFFERENT one is
        // actually selected would be a real correctness bug, not just a
        // stale-UI cosmetic issue). Any stale results from a previous
        // catchment's run are cleared too, same reasoning #runModel()
        // already applies at the start of a new run.
        this.#clearStaleResults();
        this.#renderContent();
        return;
      }
      if (event.target.id === "floodModelModeSelect") {
        // Validated against the CURRENT flood type's own allowed mode
        // list, not a hardcoded threshold/discharge pair — riverine
        // catchments offer a genuinely different set (see
        // MODES_FOR_FLOOD_TYPE). Falls back to that type's own first
        // (default) mode for a value that isn't actually offered, rather
        // than trusting the raw <select> value blindly.
        const allowed = MODES_FOR_FLOOD_TYPE[this.#floodType] || [];
        const chosen = allowed.find((m) => m.value === event.target.value);
        this.#mode = chosen ? chosen.value : (allowed[0]?.value || MODE_THRESHOLD);
        this.#clearStaleResults();
        // Full re-render, not a surgical patch — swapping modes swaps
        // which inputs (threshold slider vs. rainfall/duration fields vs.
        // nothing, for AHP/riverine) are even in the DOM.
        this.#renderContent();
        return;
      }
      if (event.target.id === "floodModelThresholdInput") {
        const v = parseFloat(event.target.value);
        if (Number.isFinite(v)) this.#selectedThreshold = v;
        return;
      }
      if (event.target.id === "floodModelRainfallInput") {
        const v = parseFloat(event.target.value);
        if (Number.isFinite(v)) this.#selectedRainfallMm = v;
        return;
      }
      if (event.target.id === "floodModelDurationInput") {
        const v = parseFloat(event.target.value);
        if (Number.isFinite(v)) this.#selectedDurationHr = v;
        return;
      }
      if (event.target.id === "floodModelRainfallSourceSelect") {
        this.#selectedRainfallSource = event.target.value;
        // Full re-render — switching source swaps which input controls
        // (manual number fields vs. a window/element dropdown) are in the
        // DOM at all, same reasoning the mode switch above already applies.
        this.#renderContent();
        return;
      }
      if (event.target.id === "floodModelChirpsDaysSelect") {
        const v = parseInt(event.target.value, 10);
        if (Number.isFinite(v)) this.#selectedChirpsDays = v;
        return;
      }
      if (event.target.id === "floodModelPmdElementSelect") {
        this.#selectedPmdElement = event.target.value;
        return;
      }
    });
    content?.addEventListener("input", (event) => {
      // Live-update the threshold readout while dragging the slider,
      // without waiting for "change" (which only fires on release).
      if (event.target.id === "floodModelThresholdInput") {
        const readout = document.getElementById("floodModelThresholdReadout");
        if (readout) readout.textContent = `${parseFloat(event.target.value).toFixed(1)} m`;
      }
    });

    // Same resync-on-external-close pattern GisExportControl's own
    // MutationObserver already establishes — dashboard.js's
    // RAIL_PANEL_REGISTRY force-closes this panel (direct classList.remove)
    // whenever another rail panel opens, bypassing hidePanel().
    new MutationObserver(() => {
      if (this.#isVisible && !panel?.classList.contains("visible")) {
        this.#isVisible = false;
        document.getElementById("floodModelToggle")?.classList.remove("active-flood-model");
        this.#stopPolling();
      }
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });

    document.addEventListener("click", (event) => {
      if (!this.#isVisible) return;
      const path = event.composedPath ? event.composedPath() : [event.target];
      const insidePanel = path.some((el) => el?.id === "floodModelPanel");
      const onButton = path.some((el) => el?.id === "floodModelToggle");
      if (!insidePanel && !onButton) this.hidePanel();
    });
  }

  showPanel() {
    this.#isVisible = true;
    document.getElementById("floodModelToggle")?.classList.add("active-flood-model");
    document.getElementById("floodModelPanel")?.classList.add("visible");
    this.#renderContent();
    this.#updateCatchmentMarker();
    // Resume polling if a job was left in flight while the panel was closed.
    if (this.#activeJobId && !this.#pollTimer) this.#poll();
  }

  hidePanel() {
    this.#isVisible = false;
    document.getElementById("floodModelToggle")?.classList.remove("active-flood-model");
    document.getElementById("floodModelPanel")?.classList.remove("visible");
    this.#stopPolling();
    this.#removeCatchmentMarker();
  }

  // ---- Custom-AOI draw tool (§0.36) ------------------------------------------
  // @mapbox/mapbox-gl-draw + @turf/turf — both already installed,
  // confirmed unused anywhere else in this app before this. The control
  // is created once, lazily (only when a user actually picks "Draw
  // custom area…"), and left on the map afterward — cheap to keep idle,
  // matching this library's own established usage idiom; only its own
  // active/inactive polygon-drawing MODE toggles per selection.
  #ensureMapboxDraw() {
    if (this.#mapboxDraw) return this.#mapboxDraw;
    try {
      // §0.38 — displayControlsDefault: false + an EMPTY controls
      // override renders ZERO of Draw's own buttons on the map (the
      // officially-documented way to drive Draw entirely through a
      // custom UI) — addControl still wires up its real drawing engine
      // (vertex placement on map clicks etc.), just with no default
      // Mapbox-styled toolbar attached to any map corner. Real NCOP-
      // themed buttons (Lucide `lasso`/`trash-2`, matching this app's
      // own established icon language) live in the panel's own "Area"
      // section instead (#renderContent) and call this SAME instance's
      // public API (changeMode/deleteAll) directly.
      this.#mapboxDraw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {},
      });
      this.#map.addControl(this.#mapboxDraw);
      const onChange = () => this.#onDrawChange();
      this.#map.on("draw.create", onChange);
      this.#map.on("draw.update", onChange);
      this.#map.on("draw.delete", () => {
        this.#drawnBbox = null;
        this.#drawnPolygon = null;
        this.#renderContent();
      });
      // §0.37 — tracks whether the user is ACTIVELY placing vertices
      // right now (not just "the custom-area option is selected") —
      // layer-attribute-popup.js's own global click handler checks this
      // via isDrawModeActive() to avoid popping up feature-attribute
      // popups on top of the polygon being drawn. Synced from Draw's
      // own mode-change event rather than hand-toggled in multiple
      // places, so an Escape-cancelled draw (which Draw itself reverts
      // to simple_select) is picked up correctly too, not just a
      // completed draw.create.
      this.#map.on("draw.modechange", (e) => {
        this.#drawModeActive = e.mode === "draw_polygon";
      });
    } catch (err) {
      console.warn("flood-model-control: could not initialize the draw tool", err);
    }
    return this.#mapboxDraw;
  }

  // Public — checked by layer-attribute-popup.js's own global click
  // handler (§0.37) via window.ncopFloodModelControl, this app's own
  // established cross-module access convention (set in the constructor).
  isDrawModeActive() {
    return this.#drawModeActive;
  }

  #onDrawChange() {
    try {
      const data = this.#mapboxDraw?.getAll();
      const feature = data?.features?.[data.features.length - 1];
      if (!feature) { this.#drawnBbox = null; this.#drawnPolygon = null; this.#renderContent(); return; }
      const bbox = turfBbox(feature);
      const [minx, miny, maxx, maxy] = bbox;
      const areaDeg2 = (maxx - minx) * (maxy - miny);
      if (areaDeg2 > MAX_CUSTOM_AOI_BBOX_DEG2) {
        // Same reject-outright posture flood_model._validate_catchment_
        // bbox already uses server-side (see its own comment) — quietly
        // shrinking what the user actually drew would misrepresent the
        // result; the server re-validates this too regardless, this is
        // just faster feedback.
        this.#setStatus(
          `Drawn area is too large (${areaDeg2.toFixed(3)} deg² > ${MAX_CUSTOM_AOI_BBOX_DEG2} deg² cap) — draw a smaller area.`,
          "error",
        );
        this.#mapboxDraw?.deleteAll();
        this.#drawnBbox = null;
        this.#drawnPolygon = null;
        this.#renderContent();
        return;
      }
      this.#drawnBbox = bbox;
      // §0.37 — the REAL drawn shape (not just its bbox), sent to the
      // server so the rendered result clips to what the user actually
      // drew, not the whole bounding rectangle (a real, confirmed bug).
      this.#drawnPolygon = feature.geometry;
      this.#setStatus("Area drawn — ready to run.", "info");
      this.#renderContent();
      this.#prewarmCustomAoi(bbox, feature.geometry);
    } catch (err) {
      console.warn("flood-model-control: could not read the drawn area", err);
    }
  }

  // §0.37 — fire-and-forget: kicks off the server's own coalescing-safe
  // Overture prewarm right after a valid polygon is drawn, well before
  // the user reviews mode/settings and clicks Run. Never awaited by
  // anything else in this module, and any failure is silently ignored
  // (a network hiccup here should never disrupt the actual Run flow) —
  // this is a pure optimization, not a correctness dependency.
  #prewarmCustomAoi(bbox, polygonGeometry) {
    // §0.44 — must match #runModel()'s own body.flood_type exactly:
    // register_custom_aoi's content-addressed key folds flood_type into
    // its own hash, so a mismatched flood_type here would register a
    // DIFFERENT catchment_key than the real Run job later uses —
    // silently wasting the whole prewarm (not a correctness bug, since
    // the real run still works standalone, just an optimization that
    // would quietly do nothing for a riverine custom draw).
    fetch(FLOOD_MODEL_PREWARM_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bbox, flood_type: this.#floodType, polygon: polygonGeometry }),
    }).catch(() => { /* best-effort — the real Run job falls back to its own full fetch regardless */ });
  }

  // §0.46 — upload a shapefile/GeoJSON/KML as the AOI instead of
  // drawing it. Reuses the SAME /upload-shapefile/ and /upload-kmz/
  // endpoints (exact request/response contract) the GIS Import panel
  // already established (gis-export-control.js's own #uploadVectorFile/
  // #processGeoJSONImport) — not a new backend feature, no flood-
  // modeling-side change needed at all: every mode already accepts an
  // arbitrary bbox+polygon for catchment="custom" (§0.36/§0.37). Once a
  // real Polygon/MultiPolygon geometry is extracted, this feeds the
  // EXACT SAME #drawnBbox/#drawnPolygon state a hand-drawn polygon
  // already does, including displaying it on the map via the SAME
  // MapboxDraw instance (so it reads as "the area", not a separate
  // concept) and the SAME §0.37 Overture prewarm.
  async #handleAoiFileUpload(file) {
    const name = file.name.toLowerCase();
    this.#setStatus(`Reading ${file.name}…`, "info");
    let featureCollection;
    try {
      if (name.endsWith(".geojson") || name.endsWith(".json")) {
        // Client-only — same as gis-export-control.js's own
        // #processGeoJSONImport, no network round trip needed for a
        // format that's already exactly what this needs.
        const data = JSON.parse(await file.text());
        featureCollection = data.type === "FeatureCollection" ? data
          : { type: "FeatureCollection", features: [data] };
      } else if (name.endsWith(".zip")) {
        featureCollection = await this.#uploadAoiFile(file, "/upload-shapefile/", "shapefile");
      } else if (name.endsWith(".kml") || name.endsWith(".kmz")) {
        featureCollection = await this.#uploadAoiFile(file, "/upload-kmz/", "kmz");
      } else {
        this.#setStatus(`${file.name}: unsupported file type — use GeoJSON, Shapefile (.zip), or KML/KMZ.`, "error");
        return;
      }
    } catch (err) {
      this.#setStatus(`Could not read ${file.name}: ${err?.message || "unknown error"}`, "error");
      return;
    }

    const geometry = this.#extractAoiPolygonGeometry(featureCollection);
    if (!geometry) {
      this.#setStatus(`${file.name} has no polygon area to use — a point/line file can't define an area.`, "error");
      return;
    }

    const feature = { type: "Feature", geometry, properties: {} };
    let bbox;
    try {
      bbox = turfBbox(feature);
    } catch (err) {
      this.#setStatus(`${file.name}'s own polygon geometry is invalid — could not compute its area.`, "error");
      return;
    }
    const [minx, miny, maxx, maxy] = bbox;
    const areaDeg2 = (maxx - minx) * (maxy - miny);
    if (areaDeg2 > MAX_CUSTOM_AOI_BBOX_DEG2) {
      // Same reject-outright posture #onDrawChange's own identical check
      // already establishes for a hand-drawn polygon — the server
      // re-validates this too regardless (_validate_catchment_bbox),
      // this is just faster feedback.
      this.#setStatus(
        `${file.name}'s own area is too large (${areaDeg2.toFixed(3)} deg² > ${MAX_CUSTOM_AOI_BBOX_DEG2} deg² cap) — upload a smaller area.`,
        "error",
      );
      return;
    }

    if (this.#selectedCatchment !== CUSTOM_AOI_CATCHMENT_KEY) {
      this.#selectedCatchment = CUSTOM_AOI_CATCHMENT_KEY;
      this.#removeCatchmentMarker();
      this.#clearStaleResults();
    }
    const draw = this.#ensureMapboxDraw();
    try {
      draw?.deleteAll();
      draw?.add(feature);
      draw?.changeMode("simple_select");
    } catch (err) {
      console.warn("flood-model-control: could not display the uploaded area on the map", err);
    }
    this.#drawModeActive = false;
    this.#drawnBbox = bbox;
    this.#drawnPolygon = geometry;
    this.#setStatus(`${file.name} loaded — ready to run.`, "info");
    this.#renderContent();
    this.#prewarmCustomAoi(bbox, geometry);
  }

  // Shared multipart upload for the two server-processed AOI formats
  // (Shapefile .zip / KML-KMZ) — the exact same request shape gis-
  // export-control.js's own #uploadVectorFile already established for
  // the GIS Import panel's identical endpoints, replicated here rather
  // than cross-module-imported (a separate class with its own private
  // field-backed state — not worth coupling two modules for 8 lines).
  async #uploadAoiFile(file, endpoint, fieldName) {
    const formData = new FormData();
    formData.append(fieldName, file);
    const res = await fetch(endpoint, { method: "POST", body: formData, credentials: "same-origin" });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    if (data?.error) throw new Error(data.error);
    if (!data?.features?.length) throw new Error("No features returned from server");
    return data;
  }

  // Polygon/MultiPolygon features only — a point/line feature in the
  // SAME file (e.g. a shapefile with a boundary polygon AND some
  // markers) is silently skipped, not an error, unless NO polygon
  // exists at all. Multiple polygon features are combined into ONE
  // MultiPolygon (plain coordinate-array concatenation, not a turf.
  // union dissolve) rather than picking just the first/largest —
  // preserves the user's own multi-part shape exactly, and
  // flood_model._clip_array_to_polygon already handles an arbitrary
  // MultiPolygon natively via GDAL's own ogr.CreateGeometryFromJson, no
  // server-side change needed to accept one.
  #extractAoiPolygonGeometry(featureCollection) {
    const polygonCoordsList = [];
    for (const feature of featureCollection?.features || []) {
      const geom = feature?.geometry;
      if (!geom) continue;
      if (geom.type === "Polygon") polygonCoordsList.push(geom.coordinates);
      else if (geom.type === "MultiPolygon") polygonCoordsList.push(...geom.coordinates);
    }
    if (!polygonCoordsList.length) return null;
    return polygonCoordsList.length === 1
      ? { type: "Polygon", coordinates: polygonCoordsList[0] }
      : { type: "MultiPolygon", coordinates: polygonCoordsList };
  }

  #activateDrawMode() {
    const draw = this.#ensureMapboxDraw();
    if (!draw) return;
    try {
      draw.deleteAll();
      this.#drawnBbox = null;
      this.#drawnPolygon = null;
      draw.changeMode("draw_polygon");
    } catch (err) {
      console.warn("flood-model-control: could not activate the draw tool", err);
    }
  }

  #deactivateDrawMode() {
    this.#drawModeActive = false;
    if (!this.#mapboxDraw) return;
    try {
      this.#mapboxDraw.deleteAll();
      this.#mapboxDraw.changeMode("simple_select");
    } catch (_) { /* best-effort */ }
    this.#drawnBbox = null;
    this.#drawnPolygon = null;
  }

  // ---- Catchment marker ---------------------------------------------------------
  // A simple visual anchor so an operator can see roughly where the
  // selected catchment sits before running anything — NOT the flood-zone
  // result itself (that's #addResultLayer, a raster overlay added only
  // after a run completes). Shown only while the panel is open.
  #updateCatchmentMarker() {
    const cfg = KNOWN_CATCHMENTS.find((c) => c.key === this.#selectedCatchment);
    if (!cfg?.center) { this.#removeCatchmentMarker(); return; }
    const map = this.#map;
    const geojson = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: cfg.center }, properties: { label: cfg.label } }],
    };
    try {
      const existing = map.getSource(CATCHMENT_MARKER_SOURCE_ID);
      if (existing) {
        existing.setData(geojson);
      } else {
        map.addSource(CATCHMENT_MARKER_SOURCE_ID, { type: "geojson", data: geojson });
        map.addLayer({
          id: CATCHMENT_MARKER_LAYER_ID,
          type: "circle",
          source: CATCHMENT_MARKER_SOURCE_ID,
          paint: {
            "circle-radius": 7,
            "circle-color": "#f5a623",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#7a4a00",
          },
        });
        map.on("mouseenter", CATCHMENT_MARKER_LAYER_ID, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", CATCHMENT_MARKER_LAYER_ID, () => { map.getCanvas().style.cursor = ""; });
      }
      this.#showCatchmentTooltip(cfg.center, cfg.label);
    } catch (err) {
      console.warn("flood-model-control: could not place catchment marker", err);
    }
  }

  #showCatchmentTooltip(lngLat, label) {
    try {
      if (this.#catchmentPopup) this.#catchmentPopup.remove();
      this.#catchmentPopup = new Popup({ closeButton: false, closeOnClick: false, offset: 12 })
        .setLngLat(lngLat)
        .setHTML(`<div class="flood-model-marker-tooltip">${this.#esc(label)}</div>`)
        .addTo(this.#map);
    } catch (_) { /* non-fatal — the marker itself still shows without a tooltip */ }
  }

  #removeCatchmentMarker() {
    const map = this.#map;
    try {
      if (this.#catchmentPopup) { this.#catchmentPopup.remove(); this.#catchmentPopup = null; }
      if (map.getLayer(CATCHMENT_MARKER_LAYER_ID)) map.removeLayer(CATCHMENT_MARKER_LAYER_ID);
      if (map.getSource(CATCHMENT_MARKER_SOURCE_ID)) map.removeSource(CATCHMENT_MARKER_SOURCE_ID);
    } catch (_) { /* best-effort cleanup */ }
  }

  // ---- Rendering --------------------------------------------------------------
  #renderContent() {
    const content = document.getElementById("floodModelContent");
    if (!content) return;

    // Catchment list filtered to the CURRENTLY selected flood type — a
    // flood type is a property of the catchment's own physical character
    // (§R4's own design decision), not an independent toggle applied to
    // any catchment, so the dropdown only ever offers catchments that
    // actually match.
    const catchmentsOfType = getCatchmentsForFloodType(this.#floodType);
    // §0.39 — "Draw custom area…" is no longer a pickable <option> here
    // at all (the user's own explicit correction: a dropdown entry isn't
    // "a control the user can click to draw" — the lasso icon-button in
    // the Area section below is). This list is exclusively real, named
    // catchments now; a custom AOI is entered/exited only via that
    // button and the trash button beside it.
    const catchmentOptions = catchmentsOfType.map((c) => `
      <option value="${this.#esc(c.key)}" ${c.key === this.#selectedCatchment ? "selected" : ""}>${this.#esc(c.label)}</option>
    `).join("");

    const modeOptions = (MODES_FOR_FLOOD_TYPE[this.#floodType] || []).map((m) => `
      <option value="${this.#esc(m.value)}" ${m.value === this.#mode ? "selected" : ""}>${this.#esc(m.label)}</option>
    `).join("");

    content.innerHTML = `
      <div class="flood-model-section">
        <div class="flood-model-section-title">Flood type</div>
        <select id="floodModelFloodTypeSelect" class="flood-model-select" ${this.#busy ? "disabled" : ""}>
          <option value="${FLOOD_TYPE_FLASH}" ${this.#floodType === FLOOD_TYPE_FLASH ? "selected" : ""}>Flash flood (small basin, local runoff)</option>
          <option value="${FLOOD_TYPE_RIVERINE}" ${this.#floodType === FLOOD_TYPE_RIVERINE ? "selected" : ""}>Riverine (major river reach, live gauge)</option>
        </select>
      </div>

      <div class="flood-model-section">
        <div class="flood-model-section-title">Area</div>
        <select id="floodModelCatchmentSelect" class="flood-model-select"
          ${this.#busy || this.#selectedCatchment === CUSTOM_AOI_CATCHMENT_KEY ? "disabled" : ""}>
          ${catchmentOptions}
        </select>
        <div class="flood-model-draw-ctrl-row">
          <button type="button" id="floodModelDrawBtn"
            class="flood-model-draw-icon-btn ${this.#drawModeActive || this.#selectedCatchment === CUSTOM_AOI_CATCHMENT_KEY ? "is-active" : ""}"
            title="${this.#drawnBbox ? "Redraw the custom area" : "Draw a custom area on the map"}" ${this.#busy ? "disabled" : ""}>
            <i data-lucide="lasso"></i>
          </button>
          <button type="button" id="floodModelDrawTrashBtn" class="flood-model-draw-icon-btn flood-model-draw-icon-btn--danger"
            title="Delete the drawn area" ${this.#drawnBbox ? "" : "disabled"}>
            <i data-lucide="trash-2"></i>
          </button>
          <!-- §0.46 — upload a shapefile/GeoJSON/KML as the AOI instead
               of drawing it. Reuses the SAME /upload-shapefile/ and
               /upload-kmz/ endpoints (and request contract) the GIS
               Import panel already established (gis-export-control.js) —
               not a new backend feature. #floodModelAoiFileInput stays
               hidden; the button just proxies a click to it, the same
               pattern gisImportFileInput's own browse link already uses. -->
          <button type="button" id="floodModelUploadBtn" class="flood-model-draw-icon-btn"
            title="Upload a shapefile (.zip), GeoJSON, or KML/KMZ as the area" ${this.#busy ? "disabled" : ""}>
            <i data-lucide="upload"></i>
          </button>
          <input type="file" id="floodModelAoiFileInput" class="flood-model-visually-hidden"
            accept=".geojson,.json,.zip,.kml,.kmz" aria-label="Upload area file">
          ${this.#selectedCatchment === CUSTOM_AOI_CATCHMENT_KEY ? `
          <span class="flood-model-draw-ctrl-label">
            ${this.#drawnBbox ? "Custom area drawn" : "Draw, or upload a file"}
          </span>
          ` : ""}
        </div>
      </div>

      <div class="flood-model-section">
        <div class="flood-model-section-title">Model mode</div>
        <select id="floodModelModeSelect" class="flood-model-select" ${this.#busy ? "disabled" : ""}>
          ${modeOptions}
        </select>
      </div>

      <div class="flood-model-section">
        <div class="flood-model-section-title">Model settings</div>
        ${this.#renderModelSettingsHTML()}
      </div>

      <div class="flood-model-section">
        <div class="flood-model-section-title">Run</div>
        <div class="flood-model-run-row">
          <button type="button" id="floodModelRun" class="flood-model-run-btn" ${this.#busy ? "disabled" : ""}>
            ${this.#busy ? "Running…" : "Run flood model"}
          </button>
          <button type="button" id="floodModelClear" class="flood-model-clear-btn" title="Remove everything this panel has added to the map">
            Clear map
          </button>
          ${this.#lastResult && this.#lastJobId ? `
          <!-- §0.47 — downloads the CURRENTLY-shown result as a real
               GeoJSON file (zone/AHP-zone geometry + every exposure
               attribute already computed — buildings, population,
               roads, drainage, administrative context), via the SAME
               job_id this result came from. Only shown once a real
               result exists; #lastJobId is cleared alongside #lastResult
               by #clearStaleResults so this never offers a stale link. -->
          <a href="${FLOOD_MODEL_EXPORT_ENDPOINT}${encodeURIComponent(this.#lastJobId)}/" download
            class="flood-model-clear-btn flood-model-download-btn" title="Download this result as GeoJSON (geometry + all attributes)">
            <i data-lucide="download"></i>
          </a>
          ` : ""}
        </div>
        <div id="floodModelStatus" class="flood-model-status" aria-live="polite"></div>
        <div id="floodModelChecklist" class="flood-model-checklist">${this.#busy ? this.#renderChecklistHTML() : ""}</div>
      </div>

      <div class="flood-model-section flood-model-accuracy-note">
        <div class="flood-model-section-title">Accuracy &amp; methodology status</div>
        ${this.#renderAccuracyNoteHTML()}
      </div>

      <div id="floodModelResults" class="flood-model-results"></div>
    `;

    if (this.#lastResult) this.#renderResults(this.#lastResult);
    this.#drawAhpAucChartIfNeeded();
    // §0.38 — #renderContent() re-injects innerHTML on every state change
    // (catchment pick, run, poll tick), including the new draw/trash
    // `data-lucide` icons; without re-invoking createIcons() here they'd
    // stay raw, invisible <i> tags — the same real gap #render()'s own
    // one-time call already closes for the static toggle-button icon,
    // matching the precedent every other module with dynamic Lucide
    // icons already follows (layer-panels.js, navigation-panel.js, etc.).
    try { window.lucide?.createIcons(); } catch (_) { /* best-effort */ }
  }

  // Dispatches to the right "Model settings" body for the current mode —
  // riverine-gauge and AHP have no scenario inputs of their own (a live
  // gauge reading / catchment-static factors respectively), so they get
  // a short explanatory note instead of input controls, rather than
  // showing stale threshold/rainfall fields that don't apply.
  #renderModelSettingsHTML() {
    if (this.#mode === MODE_DISCHARGE) return this.#renderDischargeInputsHTML();
    if (this.#mode === MODE_THRESHOLD) return this.#renderThresholdInputsHTML();
    if (this.#mode === MODE_RIVERINE_GAUGE) return this.#renderRiverineGaugeInputsHTML();
    if (this.#mode === MODE_AHP) return this.#renderAhpInputsHTML();
    return "";
  }

  #renderAccuracyNoteHTML() {
    if (this.#mode === MODE_DISCHARGE) return this.#renderDischargeAccuracyNoteHTML();
    if (this.#mode === MODE_THRESHOLD) return this.#renderThresholdAccuracyNoteHTML();
    if (this.#mode === MODE_RIVERINE_GAUGE) return this.#renderRiverineGaugeAccuracyNoteHTML();
    if (this.#mode === MODE_AHP) return this.#renderAhpAccuracyNoteHTML();
    return "";
  }

  #renderThresholdInputsHTML() {
    return `
      <label class="flood-model-slider-row">
        <span class="flood-model-slider-label">Flood-prone threshold (HAND)</span>
        <input
          type="range" id="floodModelThresholdInput"
          min="${MIN_THRESHOLD_M}" max="${MAX_THRESHOLD_M}" step="${THRESHOLD_STEP_M}"
          value="${this.#selectedThreshold}" ${this.#busy ? "disabled" : ""}
        >
        <span id="floodModelThresholdReadout" class="flood-model-slider-readout">${this.#selectedThreshold.toFixed(1)} m</span>
      </label>
      <div class="flood-model-note">Cells within this HAND value are flagged flood-prone.</div>
      <div class="flood-model-note flood-model-note-methodology">
        <strong>Not calibrated</strong> — try <strong>Rainfall scenario
        mode</strong> for a calibrated result. Default per Bhatt &amp;
        Srinivasa Rao (2018), a comparable South Asian urban catchment.
      </div>
    `;
  }

  #renderDischargeInputsHTML() {
    const src = this.#selectedRainfallSource;
    return `
      <label class="flood-model-slider-row">
        <span class="flood-model-slider-label">Rainfall source</span>
        <select id="floodModelRainfallSourceSelect" class="flood-model-select" ${this.#busy ? "disabled" : ""}>
          <option value="${RAINFALL_SOURCE_MANUAL}" ${src === RAINFALL_SOURCE_MANUAL ? "selected" : ""}>Manual entry</option>
          <option value="${RAINFALL_SOURCE_CHIRPS}" ${src === RAINFALL_SOURCE_CHIRPS ? "selected" : ""}>CHIRPS (satellite rainfall estimate)</option>
          <option value="${RAINFALL_SOURCE_PMD_FORECAST}" ${src === RAINFALL_SOURCE_PMD_FORECAST ? "selected" : ""}>PMD Forecast (WRFPRS)</option>
          <option value="${RAINFALL_SOURCE_LIVE_OBSERVED}" ${src === RAINFALL_SOURCE_LIVE_OBSERVED ? "selected" : ""}>Live observed (PMD ground stations)</option>
        </select>
      </label>
      ${src === RAINFALL_SOURCE_MANUAL ? this.#renderManualRainfallInputsHTML() : ""}
      ${src === RAINFALL_SOURCE_CHIRPS ? this.#renderChirpsInputsHTML() : ""}
      ${src === RAINFALL_SOURCE_PMD_FORECAST ? this.#renderPmdForecastInputsHTML() : ""}
      ${src === RAINFALL_SOURCE_LIVE_OBSERVED ? `
        <div class="flood-model-note">
          PMD's latest daily report (~48h window). <strong>No rain
          listed = none recorded</strong>, not an error.
        </div>` : ""}
      <div class="flood-model-note">
        <strong>SCS-CN &rarr; Kirpich &rarr; SCS-UH &rarr; Manning's</strong>
        — a real per-reach stage, not a fixed cutoff.
      </div>
    `;
  }

  #renderManualRainfallInputsHTML() {
    return `
      <label class="flood-model-slider-row">
        <span class="flood-model-slider-label">Rainfall depth</span>
        <input
          type="number" id="floodModelRainfallInput" class="flood-model-number-input"
          min="${MIN_RAINFALL_MM}" max="${MAX_RAINFALL_MM}" step="1"
          value="${this.#selectedRainfallMm}" ${this.#busy ? "disabled" : ""}
        >
        <span class="flood-model-slider-readout">mm</span>
      </label>
      <label class="flood-model-slider-row">
        <span class="flood-model-slider-label">Storm duration</span>
        <input
          type="number" id="floodModelDurationInput" class="flood-model-number-input"
          min="${MIN_DURATION_HR}" max="${MAX_DURATION_HR}" step="0.5"
          value="${this.#selectedDurationHr}" ${this.#busy ? "disabled" : ""}
        >
        <span class="flood-model-slider-readout">hours</span>
      </label>
    `;
  }

  #renderChirpsInputsHTML() {
    return `
      <label class="flood-model-slider-row">
        <span class="flood-model-slider-label">Accumulation window</span>
        <select id="floodModelChirpsDaysSelect" class="flood-model-select" ${this.#busy ? "disabled" : ""}>
          <option value="1" ${this.#selectedChirpsDays === 1 ? "selected" : ""}>Last 1 day</option>
          <option value="2" ${this.#selectedChirpsDays === 2 ? "selected" : ""}>Last 2 days</option>
          <option value="3" ${this.#selectedChirpsDays === 3 ? "selected" : ""}>Last 3 days</option>
        </select>
      </label>
      <div class="flood-model-note">
        <strong>Satellite ESTIMATE</strong>, not live — can lag real
        time by weeks. Actual covered date shown once fetched.
      </div>
    `;
  }

  #renderPmdForecastInputsHTML() {
    return `
      <label class="flood-model-slider-row">
        <span class="flood-model-slider-label">Forecast window</span>
        <select id="floodModelPmdElementSelect" class="flood-model-select" ${this.#busy ? "disabled" : ""}>
          ${PMD_FORECAST_ELEMENTS.map((e) => `<option value="${e.key}" ${this.#selectedPmdElement === e.key ? "selected" : ""}>${e.label}</option>`).join("")}
        </select>
      </label>
      <div class="flood-model-note">
        <strong>Real PMD WRFPRS forecast</strong>, sampled at this
        catchment's centroid.
      </div>
    `;
  }

  // Riverine mode has no scenario input of its own — it reads a real,
  // live water-surface-elevation reading from FFD at run time (§R4), so
  // there's nothing for an operator to set here beyond picking the
  // catchment above.
  #renderRiverineGaugeInputsHTML() {
    // §0.44 — a custom AOI has no real, named FFD gauge station (this
    // app's own FFD network covers exactly 31 named barrages/dams, not
    // a dense grid) — the SAME connected flood-fill engine runs, just
    // fed a water level derived from GeoGLOWS (a real global streamflow
    // forecast service) + a synthetic rating curve instead of a live
    // physical sensor reading. Told upfront, not left implicit, since
    // it's a real, honest difference in HOW the number was obtained.
    if (this.#selectedCatchment === CUSTOM_AOI_CATCHMENT_KEY) {
      return `
        <div class="flood-model-note">
          <strong>No input needed</strong> — no named gauge station exists
          for a custom area, so this derives a water level from
          <strong>GeoGLOWS</strong> (a real global streamflow forecast
          service) for the nearest detected river reach, converted to a
          stage via a synthetic rating curve, then floods via the same
          connected flood-fill (&sect;0.44). Fails honestly if GeoGLOWS has
          no reach near this specific area.
        </div>
      `;
    }
    return `
      <div class="flood-model-note">
        <strong>No input needed</strong> — reads today's live FFD gauge
        reading, floods via connected flood-fill (&sect;0.28).
      </div>
    `;
  }

  // AHP susceptibility mode also has no scenario input — every factor
  // feeding it is catchment-static (terrain, land cover, soil, rainfall
  // climatology, a topological connectivity measure — see the
  // methodology doc §0.29), so there's nothing to set beyond the
  // catchment above either. Shown here so an operator isn't left staring
  // at an empty "Model settings" section wondering if something's missing.
  #renderAhpInputsHTML() {
    return `
      <div class="flood-model-note">
        <strong>No input needed</strong> — static, terrain-weighted AHP
        score. Weight profile shown in results below.
      </div>
    `;
  }

  #renderThresholdAccuracyNoteHTML() {
    const acc = getCatchmentAccuracyInfo(this.#selectedCatchment);
    return `
      <div class="flood-model-note">
        <strong>Terrain-based zone, not a predicted extent</strong> — wider than any real event.
        Try <strong>Rainfall scenario mode</strong> for an event-specific result.
        ${acc ? `
        <strong>AUC: ${acc.rawHandAuc} ("${acc.rawHandBand}")</strong> —
        8-trial mean (${acc.rawHandRange}) vs. ${acc.nEvents} real GFD events.
        &sect;0.20/&sect;0.22/&sect;0.23.
        ` : `
        <strong>No AUC result yet</strong> for this catchment.
        `}
      </div>
    `;
  }

  #renderDischargeAccuracyNoteHTML() {
    const acc = getCatchmentAccuracyInfo(this.#selectedCatchment);
    return `
      <div class="flood-model-note">
        <strong>Rainfall-derived flood stage</strong>, not a fixed cutoff.
        ${acc?.comparisonNote ? acc.comparisonNote : ""}
        ${acc ? `
        <strong>AUC: ${acc.dischargeAuc} ("${acc.dischargeBand}")</strong> —
        8-trial mean (${acc.dischargeRange}), event-matched CHIRPS rainfall
        vs. ${acc.nEvents} real events. ${acc.improvementNote} over raw HAND
        (${acc.rawHandAuc}). &sect;0.19-&sect;0.23.
        ` : `
        <strong>No AUC result yet</strong> for this catchment.
        `}
      </div>
    `;
  }

  // Riverine mode's own output is a BINARY flooded/not-flooded mask, not
  // a continuous score — AUC (which needs a rankable score) isn't the
  // right metric family here; confusion-matrix metrics (hit rate, CSI,
  // F1) are, matching the literature precedent this project's own
  // research found for "HAND vs FEMA maps" validation (methodology doc
  // §0.28). No single number is quoted inline here, deliberately — this
  // project's own standing discipline is to never state a figure that
  // hasn't been directly, freshly verified, and per-event binary-metric
  // results vary run to run with which live gauge reading happened to be
  // current; the methodology doc is the place for the full, dated numbers.
  #renderRiverineGaugeAccuracyNoteHTML() {
    return `
      <div class="flood-model-note">
        <strong>Binary extent</strong>, not a susceptibility score —
        hit-rate/CSI/F1 apply, not AUC (&sect;0.28).
        <strong>See AHP susceptibility mode above</strong> for a validated
        accuracy number.
      </div>
    `;
  }

  #renderAhpAccuracyNoteHTML() {
    const acc = getCatchmentAccuracyInfo(this.#selectedCatchment);
    const ahp = acc?.ahp;
    // §0.43/§0.50 — a custom AOI (drawn/uploaded) or any of the 35
    // catchments added in §0.48/§0.49 is never in the hardcoded
    // getCatchmentAccuracyInfo table above (see that function's own
    // definition — it's a static, design-time lookup for ONLY the 4
    // ORIGINAL pilots: Nullah Lai, Bhudni Nullah, Chashma, Guddu), but
    // CAN carry its own real, LIVE accuracy result from this same run
    // (flood_model.compute_frequency_ratio_ensemble, surfaced via
    // susceptibility.custom_aoi_accuracy) — checked as a second tier,
    // only once the pilot table itself comes back empty, so the
    // original 4's own existing display is completely unaffected.
    const customAcc = this.#lastResult?.susceptibility?.custom_aoi_accuracy;
    return `
      <div class="flood-model-note">
        <strong>AHP susceptibility score</strong> — literature-weighted
        factors, weight profile auto-selected by terrain (&sect;0.27/&sect;0.29).
        ${ahp ? `
        <strong>AUC: ${ahp.auc} ("${ahp.band}")</strong> — terrain class
        <code>${this.#esc(ahp.terrainClass)}</code>, validated vs. real GFD
        extent. ${ahp.note}
        <div class="flood-model-auc-chart-wrap">
          <canvas id="${AHP_AUC_CHART_CANVAS_ID}" height="90"></canvas>
        </div>
        <div class="flood-model-note flood-model-auc-chart-caption">
          Static, dated result (5-trial mean, whisker = range) — not
          recomputed live.
        </div>
        ` : customAcc ? this.#renderCustomAoiAccuracyHTML(customAcc) : `
        <strong>No AHP accuracy result yet</strong> for this catchment.
        `}
      </div>
    `;
  }

  // §0.43 — a real, LIVE (not design-time/hardcoded) accuracy result for
  // a custom AOI: real observed flood pixels (Global Flood Database)
  // happened to overlap this specific drawn area, so both the AHP-alone
  // score AND the new AHP-Frequency-Ratio ensemble were actually scored
  // against them (accuracy_assessment.assess_raster_auc_stable — the
  // SAME machinery the curated pilots' own hardcoded numbers were
  // computed with). Reports BOTH numbers, honestly, even when the
  // ensemble does NOT come out ahead for this particular area — matches
  // this project's own standing "report the real measurement, not the
  // flattering one" discipline (e.g. the composite-CN/basin-length
  // honest-discrepancy reporting elsewhere in this codebase).
  #renderCustomAoiAccuracyHTML(customAcc) {
    const fmtAuc = (a) => (a && typeof a.auc_mean === "number" && !Number.isNaN(a.auc_mean))
      ? `${a.auc_mean.toFixed(3)} (${this.#esc(a.interpretation || "")})`
      : "n/a";
    const ahpAuc = customAcc.ahp_auc;
    const ensAuc = customAcc.ensemble_auc;
    const bothReal = ahpAuc && ensAuc
      && typeof ahpAuc.auc_mean === "number" && !Number.isNaN(ahpAuc.auc_mean)
      && typeof ensAuc.auc_mean === "number" && !Number.isNaN(ensAuc.auc_mean);
    const delta = bothReal ? ensAuc.auc_mean - ahpAuc.auc_mean : null;
    return `
      <strong>Live AHP + Frequency Ratio ensemble</strong> — cross-checked
      against ${customAcc.n_presence_pixels} real observed flood pixel(s)
      (Global Flood Database) found for this area.
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">AHP alone (AUC)</span>
        <span class="flood-model-result-value">${fmtAuc(ahpAuc)}</span>
      </div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">AHP + FR ensemble (AUC)</span>
        <span class="flood-model-result-value">${fmtAuc(ensAuc)}</span>
      </div>
      ${delta != null ? `
      <div class="flood-model-note">
        ${delta > 0.0005
          ? `<strong>Ensemble improved AUC by ${(delta * 100).toFixed(1)} points</strong> for this specific area — zones above use the ensemble's own classification.`
          : delta < -0.0005
            ? `<strong>Ensemble did NOT improve AUC here</strong> (${(delta * 100).toFixed(1)} points) — reported honestly; zones above still use the ensemble, but AHP-alone may be the more reliable read for this specific area.`
            : `Ensemble matched AHP-alone AUC for this area — zones above use the ensemble's own classification.`}
      </div>
      ` : ""}
      <div class="flood-model-note">
        A real, live result for THIS specific area (not a static,
        design-time figure the way Nullah Lai/Bhudni Nullah/Chashma/
        Guddu's own AUC above is).
      </div>
    `;
  }

  // Draws (or destroys, if not in AHP mode / no data) the small AUC
  // chart in the accuracy note — a horizontal bar for this catchment's
  // own real mean AUC, an error-bar-style min/max whisker, and vertical
  // reference lines at the real AUC_INTERPRETATION_BANDS thresholds.
  // Chart.js needs the canvas to already be in the DOM, so this is
  // called AFTER #renderContent() sets innerHTML, never during template
  // string construction — same reasoning crop-explorer-control.js's own
  // chart-drawing calls are always separate from its own HTML building.
  #drawAhpAucChartIfNeeded() {
    const existing = chartInstances[AHP_AUC_CHART_CANVAS_ID];
    if (existing) {
      try { existing.destroy(); } catch (_) { /* best-effort */ }
      delete chartInstances[AHP_AUC_CHART_CANVAS_ID];
    }
    if (this.#mode !== MODE_AHP) return;
    const canvas = document.getElementById(AHP_AUC_CHART_CANVAS_ID);
    if (!canvas) return;
    const ahp = getCatchmentAccuracyInfo(this.#selectedCatchment)?.ahp;
    if (!ahp) return;

    const mean = parseFloat(ahp.auc);
    const min = parseFloat(ahp.aucMin ?? ahp.auc);
    const max = parseFloat(ahp.aucMax ?? ahp.auc);
    if (!Number.isFinite(mean)) return;

    chartInstances[AHP_AUC_CHART_CANVAS_ID] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels: ["AUC"],
        datasets: [{
          label: "Mean AUC (5 trials)",
          data: [mean],
          backgroundColor: AHP_ZONE_COLORS[ahp.band === "good" || ahp.band === "excellent" ? "low" : ahp.band === "fair" ? "medium" : "high"] || "#5b9bd5",
          borderRadius: 4,
          barPercentage: 0.5,
          // Chart.js error-bar whiskers need a plugin this app doesn't
          // have installed — a real min/max RANGE bar drawn underneath
          // the mean bar (low opacity) is a simpler, dependency-free way
          // to show the same spread without adding a new chart.js plugin.
        }, {
          label: "Min–max range",
          data: [max - min],
          base: min,
          backgroundColor: "rgba(120,120,120,0.25)",
          borderRadius: 4,
          barPercentage: 0.9,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            min: 0, max: 1,
            grid: { color: "rgba(128,128,128,0.15)" },
            ticks: { color: "#999", font: { size: 9 } },
          },
          y: { display: false },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ctx.datasetIndex === 0
                ? `Mean AUC: ${mean.toFixed(3)}`
                : `Range: ${min.toFixed(3)}–${max.toFixed(3)}`,
            },
          },
          // Reference lines at the real AUC_INTERPRETATION_BANDS
          // thresholds — drawn via a tiny inline plugin rather than a
          // separate chart.js annotation-plugin dependency this app
          // doesn't already have.
          annotationLite: {},
        },
      },
      plugins: [{
        id: "annotationLite",
        afterDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          if (!chartArea) return;
          ctx.save();
          ctx.font = "9px sans-serif";
          ctx.fillStyle = "#888";
          ctx.strokeStyle = "rgba(136,136,136,0.4)";
          for (const band of AUC_INTERPRETATION_BANDS) {
            if (band.threshold <= 0) continue;
            const x = scales.x.getPixelForValue(band.threshold);
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.stroke();
            ctx.fillText(band.label, x + 2, chartArea.top + 9);
          }
          ctx.restore();
        },
      }],
    });
  }

  // Static-list checklist against the (known, backend-mirrored) stage
  // sequence — ticks a stage the moment it appears in #completedStages,
  // highlights whichever stage is #currentStage. Any stage not yet
  // reached renders as a plain pending row. See RUN_STAGES's own comment
  // for the frontend/backend string-coupling this depends on.
  // §0.37 — redesigned as a real table (was a plain icon+label div
  // list), with a genuine per-stage elapsed time (server-computed, not
  // fabricated) and a cited real-range hint for the currently-active
  // stage. Themed entirely via this app's own existing tokens
  // (--ndma-blue/--text-primary/--secondary-bg/--border-dark — the same
  // ones _flood-model-panel.css already uses everywhere else), so it
  // matches both day and night theme automatically, no new colors.
  #renderChecklistHTML() {
    const stages =
      this.#mode === MODE_DISCHARGE ? DISCHARGE_RUN_STAGES :
      this.#mode === MODE_RIVERINE_GAUGE ? RIVERINE_RUN_STAGES :
      this.#mode === MODE_AHP ? AHP_RUN_STAGES :
      RUN_STAGES;
    const rows = stages.map((stage) => {
      const done = this.#completedStages.includes(stage) && stage !== this.#currentStage;
      const active = stage === this.#currentStage;
      const icon = done ? "✓" : active ? "…" : "";
      const cls = done ? "is-done" : active ? "is-active" : "is-pending";
      const timeCell = active ? this.#renderChecklistTimeCell(stage) : "";
      return `
        <tr class="flood-model-checklist-row ${cls}">
          <td class="flood-model-checklist-icon">${icon}</td>
          <td class="flood-model-checklist-label">${this.#esc(stage)}</td>
          <td class="flood-model-checklist-time">${timeCell}</td>
        </tr>
      `;
    }).join("");
    // §0.40 — AHP's own per-zone exposure stages (e.g. "[low] Fetching
    // building exposure (Overture)") are dynamic — a fixed zone-label
    // prefix on a handful of reused stage names, never a literal match
    // against the static `stages` list above (see AHP_RUN_STAGES' own
    // comment on why that list only has the STABLE milestones). Before
    // this, an unmatched current_stage simply never lit up ANY row —
    // real backend progress (often the single slowest leg: Overture/
    // Overpass/WorldPop, three times, once per zone) was completely
    // invisible, reading as a dead/frozen panel even though the job was
    // genuinely still running. Appending one extra row for whatever the
    // current stage actually is, whenever it doesn't match a static
    // row, keeps real progress visible instead of silently dropping it.
    const matchesStaticRow = stages.includes(this.#currentStage);
    const dynamicRow = (this.#currentStage && !matchesStaticRow) ? `
      <tr class="flood-model-checklist-row is-active">
        <td class="flood-model-checklist-icon">…</td>
        <td class="flood-model-checklist-label">${this.#esc(this.#currentStage)}</td>
        <td class="flood-model-checklist-time">${this.#renderChecklistTimeCell(this.#currentStage)}</td>
      </tr>
    ` : "";
    return `<table class="flood-model-checklist-table"><tbody>${rows}${dynamicRow}</tbody></table>`;
  }

  // §0.40 — a real, DESCENDING "time remaining" estimate for the active
  // row, not a count-up ("Xs elapsed" read as "is this even moving?" —
  // the user's own explicit ask was for a literal countdown, 10,9,8…).
  // Anchored to #currentStageStartedAt (a CLIENT-side timestamp set the
  // moment this stage was first observed — the backend only tracks
  // whole-job elapsed time, not per-stage, so this is a real, if
  // approximate — within one POLL_INTERVAL_MS — measurement, not a
  // fabricated one) and STAGE_TIME_HINTS' own cited typicalSeconds
  // ceiling. Ticks every 1s via #stageTickTimer, independent of the 3s
  // poll cadence, so it reads as continuously live. Once elapsed passes
  // the estimate, holds at "finishing up…" rather than going negative —
  // a genuinely slow real-world run (the Overture hint's own "several
  // minutes for a brand-new custom area" case) is expected sometimes,
  // not a bug to hide by lying about the countdown.
  #renderChecklistTimeCell(stage) {
    const estimate = stageTimeEstimate(stage);
    if (!estimate) {
      return this.#elapsedSeconds != null ? `${this.#elapsedSeconds.toFixed(0)}s elapsed` : "";
    }
    const stageElapsed = this.#currentStageStartedAt != null
      ? (Date.now() - this.#currentStageStartedAt) / 1000
      : (this.#elapsedSeconds || 0);
    const remaining = Math.round(estimate.typicalSeconds - stageElapsed);
    const primary = remaining > 0 ? `~${remaining}s left` : "finishing up…";
    return `${primary}<div class="flood-model-checklist-hint">${this.#esc(estimate.hint)}</div>`;
  }

  #setStatus(text, tone = "info") {
    const el = document.getElementById("floodModelStatus");
    if (!el) return;
    el.textContent = text;
    el.className = `flood-model-status flood-model-status-${tone}`;
  }

  // ---- Run + poll ---------------------------------------------------------------
  async #runModel() {
    if (this.#busy || !this.#selectedCatchment) return;

    // §0.36 — a custom AOI needs a real drawn polygon before it can run
    // at all; the "custom" catchment key alone (with no bbox) isn't
    // submittable — matches the server's own equally-strict validation,
    // this is just faster feedback than a round trip.
    if (this.#selectedCatchment === CUSTOM_AOI_CATCHMENT_KEY && !this.#drawnBbox) {
      this.#setStatus("Draw an area on the map first.", "error");
      return;
    }

    // Client-side bounds check for discharge mode — <input type="number">
    // does not itself block an out-of-range value from ending up in
    // .value the way the threshold slider's own min/max/step attributes
    // do; mirrors flood_model_views.py's own _MIN/_MAX_RAINFALL_MM and
    // _MIN/_MAX_DURATION_HR exactly so a bad value is caught here,
    // before a network round-trip, not just relying on the server's
    // own 400.
    if (this.#mode === MODE_DISCHARGE && this.#selectedRainfallSource === RAINFALL_SOURCE_MANUAL) {
      const rainOk = Number.isFinite(this.#selectedRainfallMm)
        && this.#selectedRainfallMm >= MIN_RAINFALL_MM && this.#selectedRainfallMm <= MAX_RAINFALL_MM;
      const durOk = Number.isFinite(this.#selectedDurationHr)
        && this.#selectedDurationHr >= MIN_DURATION_HR && this.#selectedDurationHr <= MAX_DURATION_HR;
      if (!rainOk || !durOk) {
        this.#setStatus(
          `Rainfall must be ${MIN_RAINFALL_MM}-${MAX_RAINFALL_MM}mm and duration ${MIN_DURATION_HR}-${MAX_DURATION_HR}h.`,
          "error",
        );
        return;
      }
    }
    // Non-manual sources have no client-side numeric bounds to check —
    // the actual value only exists once the server fetches it.

    this.#busy = true;
    this.#clearStaleResults();
    this.#completedStages = [];
    this.#currentStage = null;
    this.#elapsedSeconds = null;
    this.#currentStageStartedAt = null;
    this.#removeResultLayer();
    this.#renderContent();
    this.#setStatus("Submitting…", "info");

    // Body shape depends entirely on #mode — each of the 4 modes has a
    // genuinely different set of accepted parameters server-side
    // (flood_model_views.py's post() rejects any parameter that doesn't
    // belong to the mode actually being run, rather than silently
    // ignoring it), so this branches on ALL of them explicitly rather
    // than a binary discharge/threshold check.
    let body;
    if (this.#mode === MODE_DISCHARGE) {
      body = this.#selectedRainfallSource === RAINFALL_SOURCE_MANUAL
        ? {
            catchment: this.#selectedCatchment,
            rainfall_mm: this.#selectedRainfallMm,
            duration_hr: this.#selectedDurationHr,
            rainfall_source: RAINFALL_SOURCE_MANUAL,
          }
        : {
            catchment: this.#selectedCatchment,
            rainfall_source: this.#selectedRainfallSource,
            chirps_days: this.#selectedChirpsDays,
            pmd_element: this.#selectedPmdElement,
          };
    } else if (this.#mode === MODE_AHP) {
      // No scenario input of its own (§0.30) — every factor is
      // catchment-static. 'lite' is not exposed as a UI toggle this pass
      // (keeping the panel simple); the server-side default (true) is
      // what every catchment was actually validated against (§0.29), so
      // leaving it unset here matches that, not an arbitrary choice.
      body = { catchment: this.#selectedCatchment, mode: MODE_AHP };
    } else if (this.#mode === MODE_RIVERINE_GAUGE) {
      // No 'mode' key at all — flood_model_views.py's post() dispatches
      // to the riverine job runner automatically from the catchment's
      // own flood_type when neither a flash-only param nor
      // mode:'ahp_susceptibility' is present (§R4's own design: flood
      // type is a property of the catchment, not a request toggle).
      body = { catchment: this.#selectedCatchment };
    } else {
      body = { catchment: this.#selectedCatchment, threshold_m: this.#selectedThreshold };
    }

    // §0.36 — a custom AOI's own body needs 'bbox' + 'flood_type'
    // instead of relying on a known PILOT_CATCHMENTS key; flood_model_
    // views.py's own post() reassigns `catchment` to the real,
    // content-addressed key register_custom_aoi returns before falling
    // through to the exact same dispatch below. §0.44 — this used to
    // hardcode FLOOD_TYPE_FLASH here (riverine-gauge mode was genuinely
    // unreachable for a custom AOI back then) — now that riverine is
    // supported too (GeoGLOWS-derived water level), hardcoding it would
    // silently register a RIVERINE draw as a flash-type catchment,
    // which build_riverine_flood_zone's own flood_type check would then
    // reject outright. Sends the REAL selected flood type now.
    if (this.#selectedCatchment === CUSTOM_AOI_CATCHMENT_KEY) {
      body.bbox = this.#drawnBbox;
      // §0.37 — the real drawn shape, so the server clips its own
      // rendered result to it instead of the whole bbox rectangle.
      body.polygon = this.#drawnPolygon;
      body.flood_type = this.#floodType;
    }

    let res, data;
    try {
      res = await fetch(FLOOD_MODEL_RUN_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      data = await res.json().catch(() => null);
    } catch (err) {
      this.#busy = false;
      this.#setStatus(`Could not reach the server: ${err?.message || "network error"}`, "error");
      this.#renderContent();
      return;
    }

    if (!res.ok || !data?.job_id) {
      this.#busy = false;
      this.#setStatus(data?.error || `Request failed (HTTP ${res.status}).`, "error");
      this.#renderContent();
      return;
    }

    this.#activeJobId = data.job_id;
    this.#setStatus("Queued — this can take up to a couple of minutes.", "info");
    this.#poll();
  }

  #stopPolling() {
    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    // §0.40 — the general "stop all polling activity" hook, so every
    // terminal path (done/error/lost-track/panel-hidden) reliably kills
    // the 1s countdown ticker too, not just the 3s status poll.
    if (this.#stageTickTimer) {
      clearInterval(this.#stageTickTimer);
      this.#stageTickTimer = null;
    }
  }

  async #poll() {
    if (!this.#activeJobId) return;
    const jobId = this.#activeJobId; // captured before #activeJobId is nulled on a terminal status below
    let res, data;
    try {
      res = await fetch(`${FLOOD_MODEL_STATUS_ENDPOINT}${encodeURIComponent(this.#activeJobId)}/`, {
        credentials: "same-origin",
      });
      data = await res.json().catch(() => null);
    } catch (err) {
      // Transient network hiccup — keep polling rather than giving up on
      // one failed request; the job itself is unaffected server-side.
      this.#pollTimer = setTimeout(() => this.#poll(), POLL_INTERVAL_MS);
      return;
    }

    if (!res.ok) {
      this.#busy = false;
      this.#activeJobId = null;
      this.#stopPolling();
      this.#setStatus(data?.error || `Lost track of the job (HTTP ${res.status}).`, "error");
      this.#renderContent();
      return;
    }

    if (data.status === "pending" || data.status === "running") {
      this.#setStatus(data.status === "running" ? "Running…" : "Queued…", "info");
      // Update the checklist IN PLACE (not a full #renderContent()) — the
      // Area/Model-settings inputs above are disabled while busy anyway,
      // but a surgical update avoids any re-render flicker every poll tick.
      this.#completedStages = Array.isArray(data.completed_stages) ? data.completed_stages : this.#completedStages;
      // §0.40 — a genuine stage change (including the very first stage
      // ever observed) restarts the per-stage countdown clock; a
      // repeated poll of the SAME stage must NOT reset it, or the
      // countdown would never advance past its own starting value.
      const newStage = data.current_stage ?? this.#currentStage;
      if (newStage !== this.#currentStage) this.#currentStageStartedAt = Date.now();
      this.#currentStage = newStage;
      // §0.37 — real elapsed time (server-computed from the job's own
      // started_at), not a fabricated ticking timer.
      this.#elapsedSeconds = typeof data.elapsed_seconds === "number" ? data.elapsed_seconds : this.#elapsedSeconds;
      const checklistEl = document.getElementById("floodModelChecklist");
      if (checklistEl) checklistEl.innerHTML = this.#renderChecklistHTML();
      // §0.40 — a local 1s ticker so the countdown reads as continuously
      // live instead of only moving once every POLL_INTERVAL_MS (3s);
      // purely a display refresh, never itself fetches or advances the
      // job. Only one ever runs at a time (guarded by the null check).
      if (this.#isVisible && !this.#stageTickTimer) {
        this.#stageTickTimer = setInterval(() => {
          const el = document.getElementById("floodModelChecklist");
          if (el) el.innerHTML = this.#renderChecklistHTML();
        }, 1000);
      }
      if (this.#isVisible) this.#pollTimer = setTimeout(() => this.#poll(), POLL_INTERVAL_MS);
      // If hidden, just stop — showPanel() resumes polling on reopen since
      // #activeJobId is still set.
      else this.#stopPolling();
      return;
    }

    this.#busy = false;
    this.#activeJobId = null;
    this.#stopPolling();

    if (data.status === "done") {
      this.#setStatus("Done.", "success");
      this.#lastResult = data.result;
      this.#lastResultMode = data.result?.mode || null;
      this.#lastDischargeScenario = data.discharge_scenario || null;
      this.#lastJobId = jobId;
      this.#renderContent();
      return;
    }

    // status === "error"
    this.#setStatus(`Run failed: ${data.error || "unknown error"}`, "error");
    this.#renderContent();
  }

  // ---- Results: map overlay + summary --------------------------------------------
  #renderResults(result) {
    if (result.mode === "ahp_susceptibility") {
      // AHP renders classified ZONE POLYGONS (a GeoJSON fill source), not
      // the continuous-score PNG image overlay every other mode's own
      // #addResultLayer expects — see #addAhpZoneLayer's own docstring
      // for why (fixes the "too big"/unclipped-rectangle complaint the
      // PNG had).
      this.#addAhpZoneLayer(result.susceptibility?.zones, result.susceptibility?.bounds);
      this.#addAhpClassifiedLayers(result.zone_map_layers);
      // Sub-phase 5 — catchment key is read from the exposure report's
      // own "catchment" field (not this.#selectedCatchment) so a later
      // dropdown change can never mismatch a still-rendered result with
      // the wrong catchment's buildings — the same stale-selection bug
      // class §0.23 already found and fixed for the accuracy note.
      this.#ahpBuildingsCatchmentKey = result.zone_exposure?.catchment || this.#selectedCatchment;
      this.#attachAhpBuildingsListeners();
    } else {
      this.#addResultLayer(result.flood_zone);
      this.#detachAhpBuildingsListeners();
      this.#removeAhpBuildingsLayer();
    }
    if (result.no_flood_expected) {
      this.#renderNoFloodExpectedResults(result);
    } else if (result.mode === "discharge_driven") {
      this.#renderDischargeResults(result);
    } else if (result.mode === "riverine") {
      this.#renderRiverineResults(result);
    } else if (result.mode === "ahp_susceptibility") {
      this.#renderAhpResults(result);
    } else {
      this.#renderThresholdResults(result);
    }
  }

  // A real, fetched (non-manual) rainfall value can come back too low to
  // drive the discharge model at all (§0.26 — confirmed live: PMD Forecast
  // and NWFC's observed report both routinely return 0mm during a real dry
  // spell). flood_model_views.py short-circuits that case server-side
  // rather than running the expensive HAND/discharge pipeline for an
  // already-known "no flood" outcome — this renders that honestly, instead
  // of feeding a null flood_zone into #renderDischargeResults (which would
  // show a confusing "? km² / undefined mm" result).
  #renderNoFloodExpectedResults(result) {
    const resultsEl = document.getElementById("floodModelResults");
    if (!resultsEl) return;
    resultsEl.innerHTML = `
      <div class="flood-model-section-title">No flood risk currently indicated</div>
      ${this.#renderRainfallSourceNoteHTML()}
      <div class="flood-model-note">
        ${this.#esc(result.message || "The fetched rainfall value was too low to drive the discharge model.")}
      </div>
    `;
  }

  // Honest provenance line for a fetched (non-manual) rainfall value —
  // shows which real data source drove this run and its own per-source
  // caveat (CHIRPS's real publication lag, PMD Forecast's issue time, or
  // the NWFC report's matched district), pulled from the job status
  // endpoint's own discharge_scenario.source_meta (§0.26). Renders nothing
  // for manual entry — that mode's numbers are exactly what the operator
  // typed, needing no provenance note.
  #renderRainfallSourceNoteHTML() {
    const sc = this.#lastDischargeScenario;
    if (!sc || sc.rainfall_source === RAINFALL_SOURCE_MANUAL) return "";
    const meta = sc.source_meta || {};
    let detail = "";
    if (sc.rainfall_source === RAINFALL_SOURCE_CHIRPS) {
      detail = `satellite estimate covering its ${this.#esc(meta.days ?? "?")}-day window ending ${this.#esc(meta.end_date ?? "an unknown date")}`;
    } else if (sc.rainfall_source === RAINFALL_SOURCE_PMD_FORECAST) {
      detail = `WRFPRS forecast for ${this.#esc(meta.forecast_time ?? "an unspecified time")}`;
    } else if (sc.rainfall_source === RAINFALL_SOURCE_LIVE_OBSERVED) {
      detail = `observed at ${this.#esc(meta.matched_district ?? "a matched station")}`;
    }
    const label = {
      [RAINFALL_SOURCE_CHIRPS]: "CHIRPS (satellite estimate)",
      [RAINFALL_SOURCE_PMD_FORECAST]: "PMD Forecast (WRFPRS)",
      [RAINFALL_SOURCE_LIVE_OBSERVED]: "Live observed (PMD ground stations)",
    }[sc.rainfall_source] || sc.rainfall_source;
    return `
      <div class="flood-model-note flood-model-source-note">
        <strong>Source: ${this.#esc(label)}</strong>${detail ? ` — ${detail}` : ""}. Not a manually-typed value.
      </div>
    `;
  }

  // Discharge-driven mode's own result rendering — separate from
  // #renderThresholdResults since the two modes' scenario-specific
  // preamble differs (rainfall/discharge numbers vs. a threshold value),
  // but §0.24 wired this mode to a REAL exposure breakdown too — same
  // buildings/population/roads/drainage rows as the threshold mode,
  // sourced from flood_exposure.build_discharge_exposure_report (the
  // discharge model's own per-pixel-varying mask, vectorized and run
  // through the identical exposure pipeline the threshold mode uses).
  #renderDischargeResults(result) {
    const resultsEl = document.getElementById("floodModelResults");
    if (!resultsEl) return;
    const sc = result.flood_zone?.scenario || {};
    const exposure = result.exposure || {};
    const buildings = exposure.buildings || {};
    const population = exposure.population || {};
    const roads = exposure.roads || {};
    const drainage = exposure.drainage || {};
    const admin = Array.isArray(exposure.administrative_context) ? exposure.administrative_context : [];
    const topAdmin = admin.filter((a) => a.level === "district").slice(0, 3);
    // The exposure report's own vectorized area (buildings/roads/etc. are
    // computed against THIS geometry) can differ slightly from the raw
    // raster cell-count area in sc.flood_zone_km2 (polygon dissolve +
    // simplify tolerance) — confirmed live within ~3% for real scenarios,
    // so showing the exposure's own figure keeps the headline number
    // consistent with the breakdown rows underneath it.
    const zoneKm2 = exposure.flood_zone_km2 ?? sc.flood_zone_km2;

    resultsEl.innerHTML = `
      <div class="flood-model-section-title">Results — ${this.#esc(zoneKm2 ?? "?")} km² flood-prone (${this.#esc(sc.rainfall_mm)}mm / ${this.#esc(sc.duration_hr)}h scenario)</div>
      ${this.#renderRainfallSourceNoteHTML()}
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Peak discharge (outlet)</span>
        <span class="flood-model-result-value">${this.#esc(sc.peak_discharge_m3s ?? "—")} m&sup3;/s</span>
      </div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Runoff depth</span>
        <span class="flood-model-result-value">${this.#esc(sc.runoff_depth_mm ?? "—")} mm <span class="flood-model-result-hint">(SCS-CN, CN=${this.#esc(sc.composite_cn ?? "—")})</span></span>
      </div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Time of concentration</span>
        <span class="flood-model-result-value">${this.#esc(sc.time_of_concentration_hr ?? "—")} hr <span class="flood-model-result-hint">(Kirpich)</span></span>
      </div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Outlet drainage area</span>
        <span class="flood-model-result-value">${this.#esc(sc.outlet_area_km2 ?? "—")} km&sup2;</span>
      </div>
      ${topAdmin.length ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">Districts affected</span>
          <span class="flood-model-result-value">${topAdmin.map((a) => `${this.#esc(a.name)} (${a.pct_of_flood_zone ?? "?"}%)`).join(", ")}</span>
        </div>` : ""}
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Buildings in zone</span>
        <span class="flood-model-result-value">${this.#esc(buildings.buildings_in_flood_zone ?? "—")} <span class="flood-model-result-hint">of ${this.#esc(buildings.total_buildings_in_aoi ?? "—")} (${this.#esc(buildings.source ?? "unknown source")})</span></span>
      </div>
      ${population.total != null ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">Population in zone</span>
          <span class="flood-model-result-value">${this.#esc(population.total)} <span class="flood-model-result-hint">(${this.#esc(population.under5)} under-5, ${this.#esc(population.elderly)} ${this.#esc(population.elderly_cutoff_age)}+)</span></span>
        </div>` : ""}
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Roads in zone</span>
        <span class="flood-model-result-value">${this.#esc(roads.length_in_flood_zone_km ?? "—")} km <span class="flood-model-result-hint">of ${this.#esc(roads.total_length_km ?? "—")} km</span></span>
      </div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Drainage in zone</span>
        <span class="flood-model-result-value">${this.#esc(drainage.length_in_flood_zone_km ?? "—")} km <span class="flood-model-result-hint">of ${this.#esc(drainage.total_length_km ?? "—")} km</span></span>
      </div>
      <div class="flood-model-note">
        <strong>One-off scenario result</strong> — not added to the
        permanent layer catalog.
      </div>
    `;
  }

  #renderThresholdResults(result) {
    const resultsEl = document.getElementById("floodModelResults");
    if (!resultsEl) return;

    const exposure = result.exposure || {};
    const buildings = exposure.buildings || {};
    const population = exposure.population || {};
    const roads = exposure.roads || {};
    const drainage = exposure.drainage || {};
    const admin = Array.isArray(exposure.administrative_context) ? exposure.administrative_context : [];
    const topAdmin = admin.filter((a) => a.level === "district").slice(0, 3);

    resultsEl.innerHTML = `
      <div class="flood-model-section-title">Results — ${this.#esc(exposure.flood_zone_km2 ?? "?")} km² susceptibility zone</div>
      ${topAdmin.length ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">Districts affected</span>
          <span class="flood-model-result-value">${topAdmin.map((a) => `${this.#esc(a.name)} (${a.pct_of_flood_zone ?? "?"}%)`).join(", ")}</span>
        </div>` : ""}
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Buildings in zone</span>
        <span class="flood-model-result-value">${this.#esc(buildings.buildings_in_flood_zone ?? "—")} <span class="flood-model-result-hint">of ${this.#esc(buildings.total_buildings_in_aoi ?? "—")} (${this.#esc(buildings.source ?? "unknown source")})</span></span>
      </div>
      ${population.total != null ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">Population in zone</span>
          <span class="flood-model-result-value">${this.#esc(population.total)} <span class="flood-model-result-hint">(${this.#esc(population.under5)} under-5, ${this.#esc(population.elderly)} ${this.#esc(population.elderly_cutoff_age)}+)</span></span>
        </div>` : ""}
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Roads in zone</span>
        <span class="flood-model-result-value">${this.#esc(roads.length_in_flood_zone_km ?? "—")} km <span class="flood-model-result-hint">of ${this.#esc(roads.total_length_km ?? "—")} km</span></span>
      </div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Drainage in zone</span>
        <span class="flood-model-result-value">${this.#esc(drainage.length_in_flood_zone_km ?? "—")} km <span class="flood-model-result-hint">of ${this.#esc(drainage.total_length_km ?? "—")} km</span></span>
      </div>
      <div class="flood-model-note"><strong>One-off result</strong> — not added to the permanent layer catalog.</div>
    `;
  }

  // Riverine mode's own result rendering (§R4/§0.28) — a real, live-
  // gauge-driven binary flood extent, plus the SAME exposure pipeline
  // every other mode uses (buildings/population/roads/drainage/
  // administrative context), extended with riverine-specific fields:
  // OSM bridges/hospitals (§ mid-task demographic/infra request) and the
  // male/female/children population breakdown flood_exposure.py gained
  // alongside it.
  #renderRiverineResults(result) {
    const resultsEl = document.getElementById("floodModelResults");
    if (!resultsEl) return;

    const sc = result.flood_zone?.scenario || {};
    const exposure = result.exposure || {};
    const buildings = exposure.buildings || {};
    const population = exposure.population || {};
    const roads = exposure.roads || {};
    const drainage = exposure.drainage || {};
    const osm = exposure.osm_infrastructure || {};
    const bridges = osm.bridges || {};
    const hospitals = osm.hospitals || {};
    const admin = Array.isArray(exposure.administrative_context) ? exposure.administrative_context : [];
    const topAdmin = admin.filter((a) => a.level === "district").slice(0, 3);
    const zoneKm2 = exposure.flood_zone_km2 ?? sc.flood_zone_km2;

    // §0.44 — a custom riverine AOI has no real named gauge station, so
    // its own scenario.gauge_source is "geoglows_forecast" (see
    // flood_model.build_riverine_flood_zone's own docstring) instead of
    // "ffd_live_gauge" — the source note below reflects that honestly
    // rather than always claiming "FFD live gauge reading".
    const isGeoglows = sc.gauge_source === "geoglows_forecast";
    const ds = sc.discharge_scenario || {};
    resultsEl.innerHTML = `
      <div class="flood-model-section-title">Results — ${this.#esc(zoneKm2 ?? "?")} km² flooded (water level: ${this.#esc(sc.gauge_height_m ?? "?")}m, ${this.#esc(sc.ffd_status ?? "status unknown")})</div>
      <div class="flood-model-note flood-model-source-note">
        ${isGeoglows
          ? `<strong>Source: GeoGLOWS forecast</strong> for the nearest detected river reach
             (river ID <code>${this.#esc(ds.geoglows_river_id ?? "?")}</code>), converted to a
             water level via a synthetic rating curve${sc.reading_time ? ` — forecast generated ${this.#esc(sc.reading_time)}` : ""}.
             No named gauge station exists for a custom area.`
          : `<strong>Source: FFD live gauge reading</strong>${sc.reading_time ? ` — as of ${this.#esc(sc.reading_time)}` : ""}. Not a rainfall scenario.`}
      </div>
      ${isGeoglows ? `
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Peak forecasted discharge</span>
        <span class="flood-model-result-value">${this.#esc(ds.target_discharge_m3s ?? "—")} m&sup3;/s <span class="flood-model-result-hint">${ds.forecast_horizon_days ? `over ${this.#esc(ds.forecast_horizon_days)}-day forecast` : ""}</span></span>
      </div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Solved stage above channel bed</span>
        <span class="flood-model-result-value">${this.#esc(ds.stage_m ?? "—")} m</span>
      </div>
      ` : ""}
      ${topAdmin.length ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">Districts affected</span>
          <span class="flood-model-result-value">${topAdmin.map((a) => `${this.#esc(a.name)} (${a.pct_of_flood_zone ?? "?"}%)`).join(", ")}</span>
        </div>` : ""}
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Buildings in zone</span>
        <span class="flood-model-result-value">${this.#esc(buildings.buildings_in_flood_zone ?? "—")} <span class="flood-model-result-hint">of ${this.#esc(buildings.total_buildings_in_aoi ?? "—")} (${this.#esc(buildings.source ?? "unknown source")})</span></span>
      </div>
      ${population.total != null ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">Population in zone</span>
          <span class="flood-model-result-value">${this.#esc(population.total)} <span class="flood-model-result-hint">(${this.#esc(population.under5)} under-5, ${this.#esc(population.elderly)} ${this.#esc(population.elderly_cutoff_age)}+)</span></span>
        </div>
        ${population.male != null ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">&nbsp;&nbsp;by sex / age</span>
          <span class="flood-model-result-value flood-model-result-hint">${this.#esc(population.male)} male, ${this.#esc(population.female)} female &middot; ${this.#esc(population.children)} under ${this.#esc(population.children_cutoff_age)}</span>
        </div>` : ""}` : ""}
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Roads in zone</span>
        <span class="flood-model-result-value">${this.#esc(roads.length_in_flood_zone_km ?? "—")} km <span class="flood-model-result-hint">of ${this.#esc(roads.total_length_km ?? "—")} km</span></span>
      </div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Drainage in zone</span>
        <span class="flood-model-result-value">${this.#esc(drainage.length_in_flood_zone_km ?? "—")} km <span class="flood-model-result-hint">of ${this.#esc(drainage.total_length_km ?? "—")} km</span></span>
      </div>
      ${bridges.total_in_aoi != null ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">Bridges in zone</span>
          <span class="flood-model-result-value">${this.#esc((bridges.in_flood_zone || []).length)} <span class="flood-model-result-hint">of ${this.#esc(bridges.total_in_aoi)}</span></span>
        </div>` : ""}
      ${hospitals.total_in_aoi != null ? `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">Hospitals in zone</span>
          <span class="flood-model-result-value">${this.#esc((hospitals.in_flood_zone || []).length)} <span class="flood-model-result-hint">of ${this.#esc(hospitals.total_in_aoi)}</span></span>
        </div>` : ""}
      <div class="flood-model-note">
        <strong>Live snapshot</strong> from today's gauge reading —
        changes on the next run.
      </div>
      ${this.#renderShapeComparisonNoteHTML(result.shape_comparison)}
    `;
  }

  // §0.35 — one short, honest headline line from flood_validation.
  // run_flood_extent_shape_comparison's own real output: how much of
  // OUR OWN zone falls within the app's existing, already-published
  // flood-extent hazard bands (a completely separate ground truth from
  // GFD). Picks the single best-matching severity's own coverage_of_a
  // figure — the most useful ONE number for a "does our own model make
  // sense next to what's already published" sanity check, not a data
  // dump of every severity/zone-class combination (that full detail
  // lives in the methodology doc §0.35, not this panel). Returns "" (no
  // note rendered) for a catchment with no wfs_river_system mapping
  // (e.g. Nullah Lai — confirmed to have zero real overlap) rather than
  // showing an error to the user for a real, expected condition.
  #renderShapeComparisonNoteHTML(shapeComparison) {
    if (!shapeComparison) return "";
    // §0.42 — a custom AOI's own error path (flood_validation.
    // run_flood_extent_shape_comparison, the "probed all 7 systems,
    // genuinely none overlap" case) carries `attempted_systems` — a
    // curated pilot's pre-existing "no wfs_river_system mapping" error
    // never does, so this only changes behavior for a custom AOI, never
    // for a pilot (nullah_lai's own silent "" stays exactly as before).
    // Shown so a custom-AOI run reads as "a real check was attempted
    // and genuinely found nothing here" rather than a silent, unexplained
    // gap indistinguishable from "this was never built" — the exact
    // confusion the user's own screenshot flagged.
    if (shapeComparison.error) {
      if (!Array.isArray(shapeComparison.attempted_systems)) return "";
      return `
        <div class="flood-model-note">
          <strong>No historical flood-extent ground truth</strong> overlaps
          this drawn area — checked all ${shapeComparison.attempted_systems.length}
          known river systems (upper/lower Indus, Jhelum, Chenab, Ravi,
          Sutlej, Kabul). Expected for most custom areas; not every
          system's own mapped extent covers all of Pakistan.
        </div>
      `;
    }
    const bandGroups = [shapeComparison.riverine_vs_bands, ...Object.values(shapeComparison.ahp_vs_bands || {})]
      .filter((g) => g && !g.error);
    let best = null;
    for (const group of bandGroups) {
      for (const [label, stats] of Object.entries(group)) {
        if (stats && typeof stats.coverage_of_a === "number" && (!best || stats.coverage_of_a > best.coverage_of_a)) {
          best = { label, coverage_of_a: stats.coverage_of_a };
        }
      }
    }
    if (!best) return "";
    const riverLabel = (shapeComparison.river_system || "").replace(/_/g, " ");
    return `
      <div class="flood-model-note">
        <strong>${Math.round(best.coverage_of_a * 100)}% overlap</strong>
        with the existing ${this.#esc(riverLabel)} ${this.#esc(best.label)} flood-extent band.
      </div>
    `;
  }

  // AHP susceptibility mode's own result rendering (§0.29/§0.30) — no
  // exposure breakdown (the score is a continuous surface, not a binary
  // extent with a geometry to run through the buildings/roads/population
  // pipeline — see render_ahp_susceptibility_png's own docstring); shows
  // the auto-selected terrain class and the exact weights actually used
  // instead, matching this project's own "never hide the numbers behind
  // the result" convention.
  #renderAhpResults(result) {
    const resultsEl = document.getElementById("floodModelResults");
    if (!resultsEl) return;

    const susc = result.susceptibility || {};
    const weights = susc.weights || {};
    const weightRows = Object.entries(weights)
      .sort((a, b) => b[1] - a[1])
      .map(([factor, weight]) => `
        <div class="flood-model-ahp-weight-row">
          <span class="flood-model-ahp-weight-label">${this.#esc(factor.replace(/_/g, " "))}</span>
          <span class="flood-model-ahp-weight-bar-track">
            <span class="flood-model-ahp-weight-bar-fill" style="width:${Math.max(2, Math.round(weight * 100))}%"></span>
          </span>
          <span class="flood-model-ahp-weight-value">${Math.round(weight * 100)}%</span>
        </div>
      `).join("");

    const zoneExposure = result.zone_exposure || {};
    const byZone = zoneExposure.by_zone || {};
    // Fixed display order (not dict iteration order, which is data-
    // dependent) — low-to-high reads naturally and matches the legend's
    // own order below.
    const ZONE_ORDER = ["low", "medium", "high"];
    const zoneRows = ZONE_ORDER.filter((z) => byZone[z]).map((zoneLabel) => {
      const z = byZone[zoneLabel];
      const buildings = z.buildings || {};
      const population = z.population || {};
      const roads = z.roads || {};
      const drainage = z.drainage || {};
      const infra = z.infrastructure || {};
      const osmInfra = z.osm_infrastructure || {};
      const bridges = osmInfra.bridges || {};
      const hospitals = osmInfra.hospitals || {};
      const schools = infra.schools || {};
      const settlements = infra.settlements || {};
      return `
        <div class="flood-model-ahp-zone-block">
          <div class="flood-model-ahp-zone-heading">
            <span class="flood-model-ahp-zone-swatch" style="background:${AHP_ZONE_COLORS[zoneLabel]};"></span>
            <span>${zoneLabel[0].toUpperCase()}${zoneLabel.slice(1)} zone</span>
            <span class="flood-model-result-hint">(${this.#esc(z.zone_km2 ?? "?")} km&sup2;)</span>
          </div>
          <div class="flood-model-result-row">
            <span class="flood-model-result-label">Buildings</span>
            <span class="flood-model-result-value">${this.#esc(buildings.buildings_in_flood_zone ?? "—")} <span class="flood-model-result-hint">(${this.#esc(buildings.source ?? "unknown source")})</span></span>
          </div>
          ${population.total != null ? `
          <div class="flood-model-result-row">
            <span class="flood-model-result-label">Population</span>
            <span class="flood-model-result-value">${this.#esc(population.total)} <span class="flood-model-result-hint">(${this.#esc(population.male)} male, ${this.#esc(population.female)} female, ${this.#esc(population.children)} under ${this.#esc(population.children_cutoff_age)}, ${this.#esc(population.elderly)} ${this.#esc(population.elderly_cutoff_age)}+)</span></span>
          </div>` : ""}
          <div class="flood-model-result-row">
            <span class="flood-model-result-label">Roads</span>
            <span class="flood-model-result-value">${this.#esc(roads.length_in_flood_zone_km ?? "—")} km <span class="flood-model-result-hint">of ${this.#esc(roads.total_length_km ?? "—")} km</span></span>
          </div>
          <div class="flood-model-result-row">
            <span class="flood-model-result-label">Drainage</span>
            <span class="flood-model-result-value">${this.#esc(drainage.length_in_flood_zone_km ?? "—")} km <span class="flood-model-result-hint">of ${this.#esc(drainage.total_length_km ?? "—")} km</span></span>
          </div>
          <div class="flood-model-result-row">
            <span class="flood-model-result-label">Bridges / hospitals</span>
            <span class="flood-model-result-value">${this.#esc((bridges.in_flood_zone || []).length)} / ${this.#esc((hospitals.in_flood_zone || []).length)}</span>
          </div>
          <div class="flood-model-result-row">
            <span class="flood-model-result-label">Schools / settlements</span>
            <span class="flood-model-result-value">${this.#esc((schools.in_flood_zone || []).length)} / ${this.#esc((settlements.in_flood_zone || []).length)}</span>
          </div>
        </div>
      `;
    }).join("");

    // Builds its own short, bolded markup from the raw fields (name/
    // dominant_zone/dominant_zone_pct) rather than using the server's
    // pre-composed .sentence string — same data, real highlighting.
    // `name` falls back the same way the Python sentence-builder's own
    // local fallback does (props.get("name") or level.title()).
    const adminSentences = (zoneExposure.administrative_zone_context || []).slice(0, 8)
      .map((a) => {
        const name = a.name || (a.level ? a.level[0].toUpperCase() + a.level.slice(1) : "Region");
        return `<div class="flood-model-admin-sentence"><strong>${this.#esc(name)}</strong>: <strong>${this.#esc(a.dominant_zone)}</strong> zone (${this.#esc(a.dominant_zone_pct ?? "?")}%)</div>`;
      }).join("");

    resultsEl.innerHTML = `
      <div class="flood-model-section-title">Results — AHP susceptibility zones</div>
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">Terrain class (auto-selected)</span>
        <span class="flood-model-result-value">${this.#esc(susc.terrain_class ?? "—")}</span>
      </div>
      ${this.#renderAhpLegendHTML()}
      ${weightRows ? `
        <div class="flood-model-section-title" style="margin-top:10px;">Weights used</div>
        <div class="flood-model-ahp-weights">${weightRows}</div>
      ` : ""}
      ${zoneRows ? `
        <div class="flood-model-section-title" style="margin-top:10px;">Exposure by zone</div>
        ${zoneRows}
      ` : `<div class="flood-model-note">Zone-classified exposure is still being computed or was unavailable for this run.</div>`}
      ${adminSentences ? `
        <div class="flood-model-section-title" style="margin-top:10px;">Administrative context</div>
        <div class="flood-model-admin-sentences">${adminSentences}</div>
      ` : ""}
      <div class="flood-model-note">
        <strong>Static result</strong> — not a predicted extent for any
        one event. Breakpoints are <strong>Youden's-J calibrated</strong>
        vs. real GFD data, not an arbitrary split.
      </div>
      <div class="flood-model-note">
        <strong>Zoom in</strong> for zone-colored schools, bridges,
        drainage, roads — and <strong>past ${AHP_BUILDINGS_MINZOOM}</strong>
        for individual buildings (totals above already cover all of them).
      </div>
      ${this.#renderShapeComparisonNoteHTML(result.shape_comparison)}
    `;
  }

  // Small legend, reusing the app's own existing dynamic-legend CSS
  // classes (frontend/src/styles/dashboard/_layer-panels.css, already
  // loaded globally via dashboard.css — see layer-panels.js's own
  // #renderDynamicLegend for the precedent this mirrors) rather than
  // inventing new legend markup/CSS. Built from a local config object,
  // not layer-panels.js's own state — this module stays zero-coupled to
  // that one, per its own header comment, just borrowing the same class
  // names for visual consistency.
  #renderAhpLegendHTML() {
    const entries = [
      { swatch: AHP_ZONE_COLORS.low, label: "Low susceptibility", shape: "square" },
      { swatch: AHP_ZONE_COLORS.medium, label: "Medium susceptibility", shape: "square" },
      { swatch: AHP_ZONE_COLORS.high, label: "High susceptibility", shape: "square" },
    ];
    const rows = entries.map((e) => `
      <div class="dynamic-legend-row">
        <span class="dynamic-legend-swatch dynamic-legend-swatch--square" style="background:${this.#esc(e.swatch)};"></span>
        <span class="dynamic-legend-label">${this.#esc(e.label)}</span>
      </div>
    `).join("");
    return `
      <div class="dynamic-legend-container flood-model-ahp-legend">
        <div class="dynamic-legend-title">Susceptibility zone</div>
        <div class="dynamic-legend-rows">${rows}</div>
      </div>
    `;
  }

  #addResultLayer(floodZone) {
    if (!floodZone?.png_url || !Array.isArray(floodZone.bounds) || floodZone.bounds.length !== 2) return;
    const map = this.#map;
    const [[minx, miny], [maxx, maxy]] = floodZone.bounds;
    // Mapbox's "image" source wants four corners in
    // [top-left, top-right, bottom-right, bottom-left] order — the backend
    // payload gives a plain [[minx,miny],[maxx,maxy]] bbox (see
    // flood_model._flood_zone_payload), converted here, once, at the one
    // place this shape actually gets consumed.
    const coordinates = [
      [minx, maxy], [maxx, maxy], [maxx, miny], [minx, miny],
    ];
    this.#removeResultLayer();
    try {
      map.addSource(RESULT_RASTER_SOURCE_ID, { type: "image", url: floodZone.png_url, coordinates });
      map.addLayer({ id: RESULT_RASTER_LAYER_ID, type: "raster", source: RESULT_RASTER_SOURCE_ID, paint: { "raster-opacity": 0.85 } });
      // maxZoom lowered from 15 to 11 (was previously removed entirely,
      // then restored at the user's own request: the camera SHOULD still
      // move to the result, just not zoom in as far). Per a real
      // user-reported browser console trace, the original maxZoom:15 +
      // 800ms flight repeatedly triggered "Map error" tile-load failures
      // on every completed run — flying in close and fast makes Mapbox
      // request base-map tiles across many intermediate zoom levels in
      // quick succession, some of which get superseded/cancelled
      // mid-transition and surface as error events (a documented
      // characteristic of animated fitBounds/flyTo transitions, not
      // something reproduced in a live browser here — this session never
      // runs one itself). These were already harmless either way
      // (dashboard.js's own #handleMapError explicitly no-ops once the
      // initial map load is done, exactly for this class of post-load
      // tile error), but a shallower, shorter flight both satisfies "less
      // zoom" directly and reduces how much tile churn the transition
      // itself creates. `floodZone.bounds` is this catchment's WHOLE
      // bbox (confirmed: flood_model._flood_zone_payload derives it from
      // the HAND raster's own extent, not just the flood-prone sub-area),
      // so 11 still frames the full catchment, just without pushing in
      // past it.
      map.fitBounds([[minx, miny], [maxx, maxy]], { padding: 40, maxZoom: 11, duration: 600 });
    } catch (err) {
      // Non-fatal — the numeric results are still shown even if the map
      // overlay fails to add (e.g. a stale/duplicate source id).
      console.warn("flood-model-control: could not add result raster layer", err);
    }
  }

  // AHP mode's own zone-polygon rendering — a `fill`+`fill-outline` pair
  // on a real GeoJSON source (not the "image" raster overlay every other
  // mode uses), colored by `zone_class` via a `match` expression. Low
  // renders at reduced opacity (design decision: only Medium/High should
  // read as visually "colored," matching how the existing binary flood-
  // zone layers only color the actually-flood-prone area, not the whole
  // bbox) — this is the direct fix for the "too big"/unclipped-rectangle
  // complaint the continuous-score PNG overlay had.
  #addAhpZoneLayer(zonesGeoJSON, bounds) {
    if (!zonesGeoJSON?.features?.length) return;
    const map = this.#map;
    this.#removeAhpZoneLayer();
    try {
      map.addSource(AHP_ZONE_SOURCE_ID, { type: "geojson", data: zonesGeoJSON });
      map.addLayer({
        id: AHP_ZONE_FILL_LAYER_ID,
        type: "fill",
        source: AHP_ZONE_SOURCE_ID,
        paint: {
          "fill-color": [
            "match", ["get", "zone_class"],
            "low", AHP_ZONE_COLORS.low,
            "medium", AHP_ZONE_COLORS.medium,
            "high", AHP_ZONE_COLORS.high,
            "#999999",
          ],
          "fill-opacity": [
            "match", ["get", "zone_class"],
            "low", AHP_ZONE_LOW_OPACITY,
            AHP_ZONE_MEDIUM_HIGH_OPACITY,
          ],
        },
      });
      map.addLayer({
        id: AHP_ZONE_OUTLINE_LAYER_ID,
        type: "line",
        source: AHP_ZONE_SOURCE_ID,
        paint: { "line-color": "#3a3a3a", "line-width": 0.6, "line-opacity": 0.5 },
      });
      if (Array.isArray(bounds) && bounds.length === 2) {
        const [[minx, miny], [maxx, maxy]] = bounds;
        // Same shallower/shorter-flight reasoning #addResultLayer's own
        // fitBounds call already documents (maxZoom 11, not 15) — this
        // catchment's own bbox, not the zones' own (possibly smaller,
        // if a class is entirely absent) bounding box, so the camera
        // always frames the whole assessed area consistently.
        map.fitBounds([[minx, miny], [maxx, maxy]], { padding: 40, maxZoom: 11, duration: 600 });
      }
    } catch (err) {
      console.warn("flood-model-control: could not add AHP zone layer", err);
    }
  }

  #removeAhpZoneLayer() {
    const map = this.#map;
    try {
      if (map.getLayer(AHP_ZONE_OUTLINE_LAYER_ID)) map.removeLayer(AHP_ZONE_OUTLINE_LAYER_ID);
      if (map.getLayer(AHP_ZONE_FILL_LAYER_ID)) map.removeLayer(AHP_ZONE_FILL_LAYER_ID);
      if (map.getSource(AHP_ZONE_SOURCE_ID)) map.removeSource(AHP_ZONE_SOURCE_ID);
    } catch (_) { /* best-effort cleanup */ }
    // Classified point/line layers are a separate concern from the zone
    // fill itself, but always added/removed together in practice (both
    // are AHP-mode-only map content) — cleaned up here too so every
    // existing caller of #removeAhpZoneLayer (itself already folded into
    // #removeResultLayer) doesn't need its own parallel call. Same for
    // Sub-phase 5's own buildings-on-zoom layer + its viewport listener.
    this.#removeAhpClassifiedLayers();
    this.#detachAhpBuildingsListeners();
    this.#removeAhpBuildingsLayer();
  }

  // Adds the 3 classified point/line layers (points, drainage, roads) —
  // see flood_exposure.build_ahp_zone_classified_map_layers's own
  // docstring for what's included/excluded (buildings deliberately
  // excluded — real crash risk at real scale, aggregate counts only).
  // `mapLayers` is the {"points", "drainage", "roads"} payload from
  // that function; each is independently optional (a catchment with
  // e.g. zero drainage features simply gets no drainage layer, not an
  // empty/broken one).
  #addAhpClassifiedLayers(mapLayers) {
    if (!mapLayers) return;
    const map = this.#map;
    this.#removeAhpClassifiedLayers();

    const zoneColorExpr = [
      "match", ["get", "zone_class"],
      "low", AHP_ZONE_COLORS.low,
      "medium", AHP_ZONE_COLORS.medium,
      "high", AHP_ZONE_COLORS.high,
      "#999999",
    ];

    try {
      if (mapLayers.points?.features?.length) {
        map.addSource(AHP_POINTS_SOURCE_ID, { type: "geojson", data: mapLayers.points });
        map.addLayer({
          id: AHP_POINTS_LAYER_ID,
          type: "circle",
          source: AHP_POINTS_SOURCE_ID,
          minzoom: AHP_POINTS_MINZOOM,
          paint: {
            "circle-radius": 4,
            "circle-color": zoneColorExpr,
            "circle-stroke-width": 1,
            "circle-stroke-color": "#1a1a1a",
          },
        });
      }
      if (mapLayers.drainage?.features?.length) {
        map.addSource(AHP_DRAINAGE_SOURCE_ID, { type: "geojson", data: mapLayers.drainage });
        map.addLayer({
          id: AHP_DRAINAGE_LAYER_ID,
          type: "line",
          source: AHP_DRAINAGE_SOURCE_ID,
          minzoom: AHP_DRAINAGE_MINZOOM,
          paint: { "line-color": zoneColorExpr, "line-width": 1.5, "line-opacity": 0.85 },
        });
      }
      if (mapLayers.roads?.features?.length) {
        map.addSource(AHP_ROADS_SOURCE_ID, { type: "geojson", data: mapLayers.roads });
        map.addLayer({
          id: AHP_ROADS_LAYER_ID,
          type: "line",
          source: AHP_ROADS_SOURCE_ID,
          minzoom: AHP_ROADS_MINZOOM,
          paint: { "line-color": zoneColorExpr, "line-width": 1, "line-opacity": 0.7 },
        });
      }
    } catch (err) {
      console.warn("flood-model-control: could not add AHP classified layers", err);
    }
  }

  #removeAhpClassifiedLayers() {
    const map = this.#map;
    try {
      for (const [layerId, sourceId] of [
        [AHP_POINTS_LAYER_ID, AHP_POINTS_SOURCE_ID],
        [AHP_DRAINAGE_LAYER_ID, AHP_DRAINAGE_SOURCE_ID],
        [AHP_ROADS_LAYER_ID, AHP_ROADS_SOURCE_ID],
      ]) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      }
    } catch (_) { /* best-effort cleanup */ }
  }

  // ---- Sub-phase 5: viewport-bounded buildings-on-zoom -----------------------
  // Reuses weather-report-control.js's own proven lazy-attach + time-
  // based-throttle + fingerprint-skip pattern (#attachListeners/
  // #scheduleRender/#computeFingerprint there), adapted for a real
  // network fetch instead of a pure client-side re-render.
  #attachAhpBuildingsListeners() {
    if (this.#ahpBuildingsListenersAttached) return;
    this.#ahpBuildingsListenersAttached = true;
    this.#ahpBuildingsLastFingerprint = "";
    this.#boundOnAhpBuildingsMapMove = () => this.#scheduleAhpBuildingsRender();
    this.#map.on("moveend", this.#boundOnAhpBuildingsMapMove);
    // Fire once immediately — covers the case where the map is already
    // zoomed in close when an AHP result first renders (e.g. re-opening
    // the panel on a job that finished while it was closed).
    this.#scheduleAhpBuildingsRender();
  }

  #detachAhpBuildingsListeners() {
    if (!this.#ahpBuildingsListenersAttached) return;
    this.#ahpBuildingsListenersAttached = false;
    if (this.#ahpBuildingsRenderTimerId != null) {
      clearTimeout(this.#ahpBuildingsRenderTimerId);
      this.#ahpBuildingsRenderTimerId = null;
    }
    if (this.#boundOnAhpBuildingsMapMove) {
      this.#map.off("moveend", this.#boundOnAhpBuildingsMapMove);
      this.#boundOnAhpBuildingsMapMove = null;
    }
    // A real race condition with debounced network fetches: cancel any
    // in-flight request rather than let a stale response land after
    // this layer has already been torn down.
    if (this.#ahpBuildingsAbortController) {
      this.#ahpBuildingsAbortController.abort();
      this.#ahpBuildingsAbortController = null;
    }
    this.#ahpBuildingsLastFingerprint = "";
  }

  #scheduleAhpBuildingsRender() {
    if (!this.#ahpBuildingsListenersAttached) return;
    if (this.#ahpBuildingsRenderTimerId != null) return; // already queued

    const wait = Math.max(
      0,
      AHP_BUILDINGS_RENDER_MIN_INTERVAL_MS - (performance.now() - this.#ahpBuildingsLastRenderAt)
    );
    this.#ahpBuildingsRenderTimerId = setTimeout(() => {
      this.#ahpBuildingsRenderTimerId = null;
      if (!this.#ahpBuildingsListenersAttached) return;
      this.#ahpBuildingsLastRenderAt = performance.now();
      this.#renderAhpBuildingsLayer();
    }, wait);
  }

  // Returns null when the map is zoomed out past AHP_BUILDINGS_MINZOOM —
  // the caller skips the fetch entirely in that case (not just a visual
  // declutter, real saved backend work), matching the plan's own
  // explicit ask.
  #computeAhpBuildingsFingerprint() {
    const zoom = this.#map.getZoom?.();
    if (typeof zoom !== "number" || zoom < AHP_BUILDINGS_MINZOOM) return null;
    const b = this.#map.getBounds?.();
    const fmt = (n) => (typeof n === "number" ? n.toFixed(4) : "");
    const bbox = b
      ? `${fmt(b.getWest())},${fmt(b.getSouth())},${fmt(b.getEast())},${fmt(b.getNorth())}`
      : "";
    return `${this.#ahpBuildingsCatchmentKey || ""}§${bbox}`;
  }

  async #renderAhpBuildingsLayer() {
    const fp = this.#computeAhpBuildingsFingerprint();
    if (fp === null) {
      // Zoomed out past the threshold — remove any stale footprints
      // rather than leaving an outdated set visible, skip the fetch.
      this.#removeAhpBuildingsLayer();
      this.#ahpBuildingsLastFingerprint = "";
      return;
    }
    if (fp === this.#ahpBuildingsLastFingerprint) return; // viewport hasn't meaningfully moved
    this.#ahpBuildingsLastFingerprint = fp;

    if (!this.#ahpBuildingsCatchmentKey) return;
    const b = this.#map.getBounds?.();
    if (!b) return;

    // Cancel any request still in flight — a fast pan/zoom can easily
    // fire a second fetch before the first resolves.
    if (this.#ahpBuildingsAbortController) this.#ahpBuildingsAbortController.abort();
    const abortController = new AbortController();
    this.#ahpBuildingsAbortController = abortController;

    const bboxStr = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
    const url = `${FLOOD_MODEL_AHP_BUILDINGS_ENDPOINT}?catchment=${encodeURIComponent(this.#ahpBuildingsCatchmentKey)}&bbox=${encodeURIComponent(bboxStr)}`;
    try {
      const resp = await fetch(url, { credentials: "same-origin", signal: abortController.signal });
      if (!resp.ok) return; // degrade quietly — this is a visual nice-to-have, not core hazard data
      const geojson = await resp.json();
      if (abortController.signal.aborted) return; // a newer request already superseded this one
      this.#applyAhpBuildingsLayer(geojson);
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.warn("flood-model-control: buildings-in-view fetch failed", err);
      }
    }
  }

  #applyAhpBuildingsLayer(geojson) {
    if (!geojson?.features) return;
    const map = this.#map;
    try {
      const source = map.getSource(AHP_BUILDINGS_SOURCE_ID);
      if (source) {
        source.setData(geojson);
        return;
      }
      map.addSource(AHP_BUILDINGS_SOURCE_ID, { type: "geojson", data: geojson });
      const zoneColorExpr = [
        "match", ["get", "zone_class"],
        "low", AHP_ZONE_COLORS.low,
        "medium", AHP_ZONE_COLORS.medium,
        "high", AHP_ZONE_COLORS.high,
        "#999999",
      ];
      map.addLayer({
        id: AHP_BUILDINGS_LAYER_ID,
        type: "fill",
        source: AHP_BUILDINGS_SOURCE_ID,
        minzoom: AHP_BUILDINGS_MINZOOM,
        paint: { "fill-color": zoneColorExpr, "fill-opacity": 0.75 },
      });
      map.addLayer({
        id: AHP_BUILDINGS_OUTLINE_LAYER_ID,
        type: "line",
        source: AHP_BUILDINGS_SOURCE_ID,
        minzoom: AHP_BUILDINGS_MINZOOM,
        paint: { "line-color": "#1a1a1a", "line-width": 0.5, "line-opacity": 0.6 },
      });
    } catch (err) {
      console.warn("flood-model-control: could not add AHP buildings-on-zoom layer", err);
    }
  }

  #removeAhpBuildingsLayer() {
    const map = this.#map;
    try {
      if (map.getLayer(AHP_BUILDINGS_OUTLINE_LAYER_ID)) map.removeLayer(AHP_BUILDINGS_OUTLINE_LAYER_ID);
      if (map.getLayer(AHP_BUILDINGS_LAYER_ID)) map.removeLayer(AHP_BUILDINGS_LAYER_ID);
      if (map.getSource(AHP_BUILDINGS_SOURCE_ID)) map.removeSource(AHP_BUILDINGS_SOURCE_ID);
    } catch (_) { /* best-effort cleanup */ }
  }

  #removeResultLayer() {
    const map = this.#map;
    try {
      if (map.getLayer(RESULT_RASTER_LAYER_ID)) map.removeLayer(RESULT_RASTER_LAYER_ID);
      if (map.getSource(RESULT_RASTER_SOURCE_ID)) map.removeSource(RESULT_RASTER_SOURCE_ID);
    } catch (_) { /* best-effort cleanup */ }
    // AHP zone layer is a SEPARATE source/layer pair (a GeoJSON fill, not
    // the "image" raster source every other mode uses) — cleaned up here
    // too so every existing call site of #removeResultLayer (start of a
    // new run, #clearMap) already clears it without needing its own
    // parallel call added at each site.
    this.#removeAhpZoneLayer();
  }

  // Removes EVERYTHING this control has ever added to the map — the
  // result raster overlay AND the catchment marker/tooltip — not just
  // whichever one happens to currently be showing. Does not touch a job
  // that's still running server-side (that's a separate concern, not
  // something the map-cleanup button should silently cancel); it only
  // clears the map + this panel's own results display.
  #clearMap() {
    this.#removeResultLayer();
    this.#removeCatchmentMarker();
    this.#clearStaleResults();
    if (this.#selectedCatchment === CUSTOM_AOI_CATCHMENT_KEY) {
      // Clears the drawn polygon too but stays in "custom area" mode
      // (selectedCatchment untouched), ready for a fresh draw via the
      // lasso button — matches "Clear" meaning "clear everything
      // currently on the map" without silently switching the active
      // area back to a named catchment.
      this.#deactivateDrawMode();
      this.#renderContent();
    }
    this.#setStatus("");
  }
}
