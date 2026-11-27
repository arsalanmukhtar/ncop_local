// landslide-model-control.js
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import { bbox as turfBbox } from "@turf/turf";
// The SAME, already-resolved LHASA2 layer definition map-layers.js's
// own generic layer catalog uses (its "LHASA2 Landslide Probability
// (Latest)" entry) — reused directly, not recomputed (see that
// module's own export comment for why: the underlying generator does
// a blocking network call, so this MUST be the one shared instance,
// not a second call).
import { mbx_lhasa2_latest } from "./map-layers.js";
// ---------------------------------------------------------------------------
// Frontend wiring for the landslide early-warning backend (L0-L6, see
// LANDSLIDE_EARLY_WARNING_METHODOLOGY.md §9/§12/§13-L5) — the real,
// previously-missing piece behind the "Coming soon" placeholder
// flood-model-control.js's own #landslideHazardContent container has
// shown since the multi-hazard tab shell was first built.
//
// Deliberately mirrors flood-model-control.js's own established
// patterns (async job-id polling, draw-tool wiring, zone-polygon map
// rendering, GeoJSON/report export) rather than inventing new ones —
// same CSS classes reused directly wherever the shape genuinely
// matches (_flood-model-panel.css already has generic
// .flood-model-select/.flood-model-run-btn/.flood-model-checklist-*/
// .flood-model-result-* classes with nothing flood-specific about
// their own styling — only a small, new block for landslide-specific
// content, e.g. the advisory badge, is added separately).
//
// Honest scope note, not silently simplified: this v1 does NOT port
// flood-model-control.js's own viewport-bounded buildings-on-zoom
// layer, classified point/line sub-layers (schools/drainage/roads as
// separately-colored features), the AHP AUC chart, the custom-AOI
// prewarm call (no landslide prewarm endpoint exists), or the per-
// stage countdown time-estimate table — real, legitimate flood-side
// features, deliberately deferred here rather than rushed.
//
// Async job-id polling against /api/landslide-model/run/ + /status/
// (ncop_internal/landslide_model_views.py) — never a single blocking
// request, matching that endpoint's own confirmed-live multi-minute
// cold-run cost for a new/custom catchment.
// ---------------------------------------------------------------------------

const LANDSLIDE_RUN_ENDPOINT = "/api/landslide-model/run/";
const LANDSLIDE_STATUS_ENDPOINT = "/api/landslide-model/status/";
const LANDSLIDE_EXPORT_ENDPOINT = "/api/landslide-model/export/";
const LANDSLIDE_REPORT_EXPORT_ENDPOINT = "/api/landslide-model/export-report/";
// Reuses the SAME generic, hazard-agnostic upload endpoints flood's own
// custom-AOI shapefile/KML import already uses (views.py's
// NcopShapefileUploadView/NcopKmzUploadView) — confirmed live this
// session to need zero new backend code.
const UPLOAD_SHAPEFILE_ENDPOINT = "/upload-shapefile/";
const UPLOAD_KMZ_ENDPOINT = "/upload-kmz/";

const POLL_INTERVAL_MS = 3000;
// Matches flood_model.MAX_CATCHMENT_BBOX_DEG2 exactly (0.30) — same
// reject-outright posture, not independently re-derived.
const MAX_CUSTOM_AOI_BBOX_DEG2 = 0.30;

const ZONE_SOURCE_ID = "landslide-model-zone-source";
const ZONE_FILL_LAYER_ID = "landslide-model-zone-fill-layer";
const ZONE_OUTLINE_LAYER_ID = "landslide-model-zone-outline-layer";
// §L7 — debris-flow watershed screening (debris_flow_model.py), drawn
// as its own outlined overlay above the slide zones, never merged in.
const DEBRIS_SOURCE_ID = "landslide-model-debris-source";
const DEBRIS_FILL_LAYER_ID = "landslide-model-debris-fill-layer";
const DEBRIS_OUTLINE_LAYER_ID = "landslide-model-debris-outline-layer";
const DEBRIS_COLORS = { debris_flow: "#c0392b", debris_flood: "#f0a030" };
// Same severity palette landslide_model.py's own zone GeoJSON features
// already carry (flood_model._AHP_ZONE_COLORS, reused server-side
// unmodified) — kept here too as a defensive fallback, not trusting the
// payload's own "color" property alone.
const ZONE_COLORS = { low: "#FFC300", medium: "#FF5733", high: "#C70039" };
const ZONE_LOW_OPACITY = 0.25;
const ZONE_MEDIUM_HIGH_OPACITY = 0.65;

// Real, curated catchments — landslide_model.PILOT_CATCHMENTS' own
// labels/bboxes, mirrored here as a hardcoded, curated list (matching
// KNOWN_CATCHMENTS' own established convention in flood-model-
// control.js — confirmed there as "not a live dump" of the backend
// dict; the same posture applies here, not a stylistic difference).
const KNOWN_CATCHMENTS = [
  { key: "murree_galyat", label: "Murree — Galyat Corridor (Rawalpindi/Abbottabad)", center: [73.40, 33.95] },
  { key: "astore", label: "Astore Valley (Gilgit-Baltistan)", center: [74.825, 35.35] },
  { key: "chitral_reshun", label: "Chitral / Reshun (Khyber Pakhtunkhwa)", center: [71.75, 35.865] },
  { key: "hunza_nagar_karakoram", label: "Hunza-Nagar / Karakoram Highway Corridor", center: [74.75, 36.35] },
  { key: "ajk_muzaffarabad", label: "Muzaffarabad District (Azad Jammu & Kashmir)", center: [73.50, 34.40] },
  { key: "besham_chilas_kkh", label: "Besham-Chilas Corridor, Karakoram Highway", center: [73.375, 35.325] },
];
const CUSTOM_KEY = "__custom__";

const MODE_SUSCEPTIBILITY = "susceptibility";
const MODE_TRIGGER = "trigger";
// §L3.5 — pools COOLR+GFLD+GLC ground truth across EVERY registered
// catchment into one real, statistically combined accuracy estimate.
// No catchment/area selection needed for this mode (see #renderContent's
// own catchment-select handling) — it validates the whole network, not
// one area.
const MODE_NATIONAL_VALIDATION = "national_validation";
// §L7 — trains + held-out-tests the data-driven susceptibility model
// (landslide_calibration.py). Like national validation, it spans every
// registered catchment, so it takes no area.
const MODE_CALIBRATE = "calibrate";
const NO_AREA_MODES = [MODE_NATIONAL_VALIDATION, MODE_CALIBRATE];

const SUSCEPTIBILITY_METHODS = [
  { value: "auto", label: "Auto — calibrated model only if it passed held-out testing" },
  { value: "ahp", label: "Literature AHP weights" },
  { value: "calibrated", label: "Calibrated model (even if not approved)" },
];

const RAINFALL_SOURCES = [
  { value: "chirps", label: "CHIRPS satellite estimate (recent, ~1-3 days)" },
  { value: "pmd_forecast", label: "PMD Monitor WRF forecast" },
  { value: "live_observed", label: "PMD daily rainfall report (observed)" },
];

// Static, STABLE milestones the backend's own _mark_stage calls emit
// (landslide_model_views.py) — mirrors flood_model_views.py's own
// RUN_STAGES/AHP_RUN_STAGES convention. The exposure sub-stages
// ("Fetching building exposure (Overture)", etc.) are NOT listed here
// (they're the same dynamic, catchment-shared exposure core flood's
// own RUN_STAGES already names) — #renderChecklistHTML's own dynamic-
// row fallback (copied from flood-model-control.js's own pattern)
// surfaces them without needing a duplicate static list.
const SUSCEPTIBILITY_RUN_STAGES = [
  "Fetching elevation & computing terrain hydrology (HAND)",
  "Computing static susceptibility score",
  "Classifying & vectorizing susceptibility zones",
  "Computing infinite-slope physical stability layer",
  "Screening rockfall susceptibility",
  "Screening snow-avalanche susceptibility",
  "Screening debris-flow watersheds (Melton ratio)",
  "Computing exposure (buildings/roads/population)",
];
// Mirrors _run_landslide_calibration_job's own _mark_stage calls.
const CALIBRATE_RUN_STAGES = [
  "Fetching ground truth and sampling every catchment's factor stack",
  "Leave-one-catchment-out testing of calibrated vs literature AHP",
];
// Trigger mode's own single real stage is fully dynamic ("Fetching
// {source} rainfall data") — left empty, the dynamic-row fallback
// handles it.
const TRIGGER_RUN_STAGES = [];
// Mirrors _run_landslide_national_validation_job's own 2 _mark_stage
// calls (landslide_model_views.py).
const NATIONAL_VALIDATION_RUN_STAGES = [
  "Fetching ground truth (COOLR/GFLD/GLC) for every registered catchment",
  "Building susceptibility + infinite-slope rasters for every catchment",
  "Fitting & held-out testing Frequency-Ratio calibration (leave-one-catchment-out)",
];
// The LHASA2 scan's own 4th, independent job type (landslide_lhasa2_
// scan.py) — its own executor slot, its own polling loop, entirely
// separate from the Mode/Run flow above (it needs no catchment: it scans
// Pakistan's whole bbox and extracts its own small, capped set of AOIs).
// Only the first 2 _mark_stage calls have fixed text; the 3rd carries a
// real feature count ("Assessing exposure for N of M features") so it's
// left to the same dynamic-row fallback #renderLhasa2ScanChecklistHTML
// already needs for that reason.
const LHASA2_SCAN_STAGES = [
  "Fetching latest LHASA2 nowcast",
  "Classifying & vectorizing probable-landslide areas",
];
const LHASA2_SCAN_RUN_ENDPOINT = LANDSLIDE_RUN_ENDPOINT;
const LHASA2_SCAN_STATUS_ENDPOINT = LANDSLIDE_STATUS_ENDPOINT;
const LHASA2_SCAN_SOURCE_ID = "landslide-model-lhasa2-scan-source";
const LHASA2_SCAN_FILL_LAYER_ID = "landslide-model-lhasa2-scan-fill-layer";
const LHASA2_SCAN_OUTLINE_LAYER_ID = "landslide-model-lhasa2-scan-outline-layer";

const ADVISORY_BADGE_CLASS = { Normal: "is-normal", Watch: "is-watch", Warning: "is-warning" };

export class LandslideModelControl {
  #map;
  #container;
  #isVisible = false;
  #busy = false;
  #activeJobId = null;
  #pollTimer = null;

  #selectedCatchment = KNOWN_CATCHMENTS[0].key;
  #mode = MODE_SUSCEPTIBILITY;
  #lite = true;
  #includeValidation = false;
  #selectedRainfallSource = "chirps";
  #method = "auto";

  #lastResult = null;
  #lastResultMode = null;
  #lastJobId = null;
  #exportingReport = false;

  #completedStages = [];
  #currentStage = null;
  #elapsedSeconds = null;
  #statusText = "";
  #statusTone = "info";

  #mapboxDraw = null;
  #drawnBbox = null;
  #drawnPolygon = null;
  #drawModeActive = false;
  #uploadingAoiFile = false;

  // Meteoblue LHASA2 cross-check layer (§3.2) — a visual reference only,
  // never a term in the trigger's own decision matrix. Off by default;
  // toggled independently of Run/mode state, so it can stay on/off
  // across catchment switches and job runs.
  #lhasa2Visible = false;

  // LHASA2 real-time extraction + exposure scan — its own independent job
  // (never shares #activeJobId/#pollTimer with the Mode/Run flow above, so
  // a susceptibility run and a scan can be in flight at the same time
  // without clobbering each other's polling).
  #lhasa2ScanBusy = false;
  #lhasa2ScanJobId = null;
  #lhasa2ScanPollTimer = null;
  #lhasa2ScanCompletedStages = [];
  #lhasa2ScanCurrentStage = null;
  #lhasa2ScanElapsedSeconds = null;
  #lhasa2ScanStatusText = "";
  #lhasa2ScanStatusTone = "info";
  #lhasa2ScanResult = null;
  #lhasa2ScanShowOnMap = false;

  constructor(map, container) {
    this.#map = map;
    this.#container = container;
    this.#render();
    this.#wireEvents();
    window.ncopLandslideModelControl = this;
  }

  // Called by flood-model-control.js's own #switchHazardTab whenever
  // this tab is shown/hidden — pauses polling for a hidden panel,
  // resumes if a job was left in flight, same discipline
  // FloodModelControl's own #isVisible already follows.
  setVisible(visible) {
    this.#isVisible = visible;
    if (visible && this.#activeJobId && !this.#pollTimer) this.#poll();
    if (!visible) this.#stopPolling();
    if (visible && this.#lhasa2ScanJobId && !this.#lhasa2ScanPollTimer) this.#pollLhasa2Scan();
    if (!visible) this.#stopLhasa2ScanPolling();
  }

  #esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- DOM --------------------------------------------------------------

  #render() {
    if (!this.#container) return;
    this.#container.hidden = false;
    this.#container.classList.remove("hazard-placeholder-content");
    this.#container.classList.add("flood-model-content");
    this.#renderContent();
  }

  #renderContent() {
    if (!this.#container) return;
    const catchmentOptions = KNOWN_CATCHMENTS.map(
      (c) => `<option value="${c.key}" ${this.#selectedCatchment === c.key ? "selected" : ""}>${this.#esc(c.label)}</option>`,
    ).join("");

    // Mirrors flood-model-control.js's own corrected Area section
    // exactly (its own §0.39 comment: "not gated behind picking
    // anything from the catchment dropdown — a dropdown entry isn't
    // 'a control the user can click to draw'"). The catchment <select>
    // only ever lists real, named catchments; the draw/upload icon row
    // below it is ALWAYS visible — clicking the lasso icon is what
    // switches to a custom area, not a hidden dropdown option.
    // national_validation pools every registered catchment's own
    // ground truth — it doesn't take an area at all, so the whole Area
    // section is skipped for it rather than shown-but-meaningless.
    const drawSection = NO_AREA_MODES.includes(this.#mode) ? "" : `
      <div class="flood-model-section">
        <div class="flood-model-section-title">Area</div>
        <select class="flood-model-select" data-role="catchment-select" ${this.#busy || this.#selectedCatchment === CUSTOM_KEY ? "disabled" : ""}>
          ${catchmentOptions}
        </select>
        ${this.#renderDrawControlsHTML()}
      </div>
    `;

    let modeInputsHTML;
    if (this.#mode === MODE_TRIGGER) modeInputsHTML = this.#renderTriggerInputsHTML();
    else if (this.#mode === MODE_NATIONAL_VALIDATION) modeInputsHTML = this.#renderNationalValidationInputsHTML();
    else if (this.#mode === MODE_CALIBRATE) modeInputsHTML = this.#renderCalibrateInputsHTML();
    else modeInputsHTML = this.#renderSusceptibilityInputsHTML();

    const modeSection = `
      <div class="flood-model-section">
        <div class="flood-model-section-title">Mode</div>
        <select class="flood-model-select" data-role="mode-select">
          <option value="${MODE_SUSCEPTIBILITY}" ${this.#mode === MODE_SUSCEPTIBILITY ? "selected" : ""}>Static susceptibility (slide score + infinite-slope + rockfall + avalanche + debris flow)</option>
          <option value="${MODE_TRIGGER}" ${this.#mode === MODE_TRIGGER ? "selected" : ""}>Rainfall-triggered dynamic check</option>
          <option value="${MODE_NATIONAL_VALIDATION}" ${this.#mode === MODE_NATIONAL_VALIDATION ? "selected" : ""}>Accuracy validation (all catchments, real ground truth)</option>
          <option value="${MODE_CALIBRATE}" ${this.#mode === MODE_CALIBRATE ? "selected" : ""}>Train & test calibrated model (all catchments)</option>
        </select>
        ${modeInputsHTML}
        ${NO_AREA_MODES.includes(this.#mode) ? "" : `
        <div class="flood-model-note">
          <strong>Note:</strong> factor weights are literature-derived per terrain class
          (moderate-relief/monsoon vs. high-relief/Karakoram), not identical for every
          catchment — see the methodology document for sourcing.
        </div>
        `}
      </div>
    `;

    // §3.2/§3.2.3 — a real, visual-only reference: NASA's LHASA2
    // landslide-probability nowcast, served here via the SAME Meteoblue
    // tile source the app's own generic layer catalog already exposes
    // ("Hazard Layers" panel → "LHASA2 Landslide Probability (Latest)")
    // — this toggle just saves a trip out of the landslide panel to
    // turn it on. Explicitly NOT a term in the AHP score or the
    // trigger's own decision matrix — an operator's own cross-check,
    // never blended in.
    const crossCheckSection = `
      <div class="flood-model-section">
        <div class="flood-model-section-title">Cross-check layers</div>
        <label class="landslide-model-toggle-row">
          <input type="checkbox" data-role="lhasa2-checkbox" ${this.#lhasa2Visible ? "checked" : ""} />
          <span class="landslide-model-toggle-text">
            <span class="landslide-model-toggle-label">Show LHASA2 landslide probability (Meteoblue)</span>
            <span class="landslide-model-toggle-hint">A separate, real-time nowcast layer for visual reference only — not blended into this model's own score or advisory.</span>
          </span>
        </label>
        ${this.#renderLhasa2ScanSectionHTML()}
      </div>
    `;

    const canRun = NO_AREA_MODES.includes(this.#mode)
      || this.#selectedCatchment !== CUSTOM_KEY || (this.#drawnBbox != null);
    const runRow = `
      <div class="flood-model-run-row">
        <button type="button" class="flood-model-run-btn" data-role="run-btn" ${this.#busy || !canRun ? "disabled" : ""}>
          ${this.#busy ? "Running…" : "Run"}
        </button>
        ${this.#lastResult ? `
          <button type="button" class="flood-model-download-btn" data-role="export-geojson-btn">${NO_AREA_MODES.includes(this.#lastResultMode) ? "Download JSON" : "Download GeoJSON"}</button>
          ${NO_AREA_MODES.includes(this.#lastResultMode) ? "" : `
          <button type="button" class="flood-model-download-btn" data-role="export-report-btn" ${this.#exportingReport ? "disabled" : ""}>
            ${this.#exportingReport ? "Generating…" : "Export report"}
          </button>`}
        ` : ""}
      </div>
    `;

    const statusRow = `<div class="flood-model-status flood-model-status-${this.#statusTone || "info"}" data-role="status">${this.#esc(this.#statusText || "")}</div>`;
    const checklist = this.#busy ? `<div class="flood-model-checklist">${this.#renderChecklistHTML()}</div>` : "";
    const results = this.#lastResult ? this.#renderResultsHTML() : "";

    this.#container.innerHTML = `
      ${drawSection}
      ${modeSection}
      ${crossCheckSection}
      ${runRow}
      ${statusRow}
      ${checklist}
      ${results}
    `;
  }

  #renderSusceptibilityInputsHTML() {
    const methodOpts = SUSCEPTIBILITY_METHODS.map(
      (m) => `<option value="${m.value}" ${this.#method === m.value ? "selected" : ""}>${this.#esc(m.label)}</option>`,
    ).join("");
    return `
      <div class="landslide-model-field-label">Slide-score method</div>
      <select class="flood-model-select" data-role="method-select">${methodOpts}</select>
      <label class="landslide-model-toggle-row">
        <input type="checkbox" data-role="lite-checkbox" ${this.#lite ? "checked" : ""} />
        <span class="landslide-model-toggle-text">
          <span class="landslide-model-toggle-label">Lite factor set</span>
          <span class="landslide-model-toggle-hint">Faster run — 9 highest-weighted factors instead of all 12.</span>
        </span>
      </label>
      <label class="landslide-model-toggle-row">
        <input type="checkbox" data-role="validation-checkbox" ${this.#includeValidation ? "checked" : ""} />
        <span class="landslide-model-toggle-text">
          <span class="landslide-model-toggle-label">Validate against ground truth (COOLR)</span>
          <span class="landslide-model-toggle-hint">Optional accuracy check against a real landslide inventory. That external service is currently unreachable, so this may just report "no data" — safe to leave off.</span>
        </span>
      </label>
    `;
  }

  #renderTriggerInputsHTML() {
    const opts = RAINFALL_SOURCES.map(
      (s) => `<option value="${s.value}" ${this.#selectedRainfallSource === s.value ? "selected" : ""}>${this.#esc(s.label)}</option>`,
    ).join("");
    return `
      <select class="flood-model-select" data-role="rainfall-source-select">${opts}</select>
      <div class="flood-model-note">
        Combines this live rainfall reading with the catchment's own static susceptibility
        class via a decision matrix (Normal / Watch / Warning) — not a blended score.
      </div>
    `;
  }

  #renderCalibrateInputsHTML() {
    return `
      <label class="landslide-model-toggle-row">
        <input type="checkbox" data-role="lite-checkbox" ${this.#lite ? "checked" : ""} />
        <span class="landslide-model-toggle-text">
          <span class="landslide-model-toggle-label">Lite AHP baseline</span>
          <span class="landslide-model-toggle-hint">Which AHP score the calibrated model is compared against.</span>
        </span>
      </label>
      <div class="flood-model-note">
        Fits a logistic-regression susceptibility model on absolute factor classes from every
        registered catchment's real ground truth, and tests it leave-one-catchment-out against the
        literature AHP score on the same held-out pixels. "Auto" runs only switch to it if it beats
        AHP by a clear margin, wins most held-out catchments, and has at least 100 real events behind it.
        A few minutes on a warm cache.
      </div>
    `;
  }

  #renderNationalValidationInputsHTML() {
    return `
      <label class="landslide-model-toggle-row">
        <input type="checkbox" data-role="lite-checkbox" ${this.#lite ? "checked" : ""} />
        <span class="landslide-model-toggle-text">
          <span class="landslide-model-toggle-label">Lite factor set</span>
          <span class="landslide-model-toggle-hint">Applies to every catchment's own susceptibility raster built for this check.</span>
        </span>
      </label>
      <div class="flood-model-note">
        Pools real ground-truth points from three independent sources (COOLR, the Global
        Fatal Landslide Database, and NASA's Global Landslide Catalog) across every
        registered catchment, then runs BOTH an uncalibrated (literature-weights-only) AUC
        AND a real, held-out local calibration (leave-one-catchment-out Frequency Ratio —
        never fit and tested on the same data). Real, first-ever cold run: ~12 minutes
        (builds the full susceptibility pipeline for any catchment not already cached);
        a few minutes on a warm cache.
      </div>
    `;
  }

  // The scan's own compact panel — a secondary action under the LHASA2
  // toggle, not a 4th mode-select option (see landslide_lhasa2_scan.py's
  // own module docstring for why: every AOI in this app is capped at
  // 0.30 deg², so this can never be modeled as one catchment-scoped run).
  // Enabled once the LHASA2 layer itself is on, so the affordance sits
  // exactly where the user is already looking at the raster it reads.
  #renderLhasa2ScanSectionHTML() {
    const btnDisabled = this.#lhasa2ScanBusy || !this.#lhasa2Visible;
    const statusHTML = this.#lhasa2ScanStatusText
      ? `<div class="flood-model-status flood-model-status-${this.#lhasa2ScanStatusTone || "info"}">${this.#esc(this.#lhasa2ScanStatusText)}</div>`
      : "";
    const checklistHTML = this.#lhasa2ScanBusy
      ? `<div class="flood-model-checklist">${this.#renderLhasa2ScanChecklistHTML()}</div>` : "";
    const resultsHTML = this.#lhasa2ScanResult ? this.#renderLhasa2ScanResultsHTML(this.#lhasa2ScanResult) : "";
    return `
      <div class="landslide-model-lhasa2-scan">
        <button type="button" class="flood-model-run-btn landslide-model-lhasa2-scan-btn" data-role="lhasa2-scan-run-btn" ${btnDisabled ? "disabled" : ""}>
          ${this.#lhasa2ScanBusy ? "Scanning…" : "Extract features & assess exposure"}
        </button>
        ${!this.#lhasa2Visible ? `<div class="landslide-model-toggle-hint">Turn the layer on above to enable this.</div>` : ""}
        ${statusHTML}
        ${checklistHTML}
        ${resultsHTML}
      </div>
    `;
  }

  #renderLhasa2ScanChecklistHTML() {
    const rows = LHASA2_SCAN_STAGES.map((stage) => {
      const done = this.#lhasa2ScanCompletedStages.includes(stage) && stage !== this.#lhasa2ScanCurrentStage;
      const active = stage === this.#lhasa2ScanCurrentStage;
      const icon = done ? "✓" : active ? "…" : "";
      const cls = done ? "is-done" : active ? "is-active" : "is-pending";
      const timeCell = active && this.#lhasa2ScanElapsedSeconds != null ? `${this.#lhasa2ScanElapsedSeconds.toFixed(0)}s elapsed` : "";
      return `
        <tr class="flood-model-checklist-row ${cls}">
          <td class="flood-model-checklist-icon">${icon}</td>
          <td class="flood-model-checklist-label">${this.#esc(stage)}</td>
          <td class="flood-model-checklist-time">${timeCell}</td>
        </tr>
      `;
    }).join("");
    // The 3rd real stage carries a live feature count ("Assessing exposure
    // for N of M features") — never matches the static list above, so it
    // renders through this same dynamic-row fallback every other mode in
    // this file already uses for its own count/source-carrying stages.
    const matchesStaticRow = LHASA2_SCAN_STAGES.includes(this.#lhasa2ScanCurrentStage);
    const dynamicRow = (this.#lhasa2ScanCurrentStage && !matchesStaticRow) ? `
      <tr class="flood-model-checklist-row is-active">
        <td class="flood-model-checklist-icon">…</td>
        <td class="flood-model-checklist-label">${this.#esc(this.#lhasa2ScanCurrentStage)}</td>
        <td class="flood-model-checklist-time">${this.#lhasa2ScanElapsedSeconds != null ? `${this.#lhasa2ScanElapsedSeconds.toFixed(0)}s elapsed` : ""}</td>
      </tr>
    ` : "";
    return `<table class="flood-model-checklist-table"><tbody>${rows}${dynamicRow}</tbody></table>`;
  }

  #renderLhasa2ScanResultsHTML(result) {
    if (result.n_features_total === 0) {
      return `<div class="flood-model-note">${this.#esc(result.note || "No elevated-probability areas found in this scan.")}</div>`;
    }
    const totals = result.totals || {};
    const capNote = result.n_features_assessed < result.n_features_total
      ? `<div class="flood-model-note">${result.n_features_assessed} of ${result.n_features_total} features assessed for exposure (per-scan cap) — the rest are listed by footprint only.</div>`
      : "";
    const featureRows = (result.features || []).slice(0, 30).map((f) => `
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">${this.#esc(f.id)} · ${this.#esc(f.area_km2)} km² · ≥${this.#esc(f.probability_class_min_pct)}%</span>
        <span class="flood-model-result-value">${f.assessed
          ? `${this.#esc(f.exposure?.buildings?.buildings_in_flood_zone ?? 0)} buildings · ${this.#esc(f.exposure?.population?.total ?? 0)} people`
          : "not assessed"}</span>
      </div>
    `).join("");
    return `
      <div class="flood-model-results">
        <div class="flood-model-result-row"><span class="flood-model-result-label">Nowcast date</span><span class="flood-model-result-value">${this.#esc(result.latest_time)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Features found (≥${this.#esc(result.threshold_pct)}%)</span><span class="flood-model-result-value">${this.#esc(result.n_features_total)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Buildings exposed (assessed features)</span><span class="flood-model-result-value">${this.#esc(totals.buildings_in_zone)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Population exposed (assessed features)</span><span class="flood-model-result-value">${this.#esc(totals.population_in_zone)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Roads in zone (assessed features)</span><span class="flood-model-result-value">${this.#esc(totals.roads_length_in_zone_km)} km</span></div>
        ${capNote}
        <label class="landslide-model-toggle-row">
          <input type="checkbox" data-role="lhasa2-scan-show-map-checkbox" ${this.#lhasa2ScanShowOnMap ? "checked" : ""} />
          <span class="landslide-model-toggle-text">
            <span class="landslide-model-toggle-label">Show extracted features on map</span>
          </span>
        </label>
        ${featureRows}
        <div class="flood-model-result-hint">
          A live extraction from the LHASA2 nowcast raster, not a validated hazard product — the ${this.#esc(result.threshold_pct)}% threshold is the color ramp's own visual "elevated" midpoint, not a literature-calibrated cutoff. Exposure sums are for ASSESSED features only, never extrapolated to the rest.
        </div>
      </div>
    `;
  }

  // Mirrors flood-model-control.js's own Area section exactly: one
  // always-visible row of icon buttons (draw / clear / upload) — never
  // gated behind a dropdown option. The lasso button IS how a custom
  // area starts (clicking it switches #selectedCatchment to CUSTOM_KEY
  // and enters draw mode, see #wireEvents); the label to the right only
  // ever describes the CURRENT state, not a separate control.
  #renderDrawControlsHTML() {
    const inCustomMode = this.#selectedCatchment === CUSTOM_KEY;
    let label = "Draw a custom area, or upload a shapefile/KML";
    if (this.#uploadingAoiFile) label = "Uploading…";
    else if (inCustomMode && this.#drawnBbox) label = "Custom area ready";
    else if (inCustomMode) label = "Draw a polygon, or upload a file";
    return `
      <div class="flood-model-draw-ctrl-row">
        <button type="button" class="flood-model-draw-icon-btn ${this.#drawModeActive || inCustomMode ? "is-active" : ""}" data-role="draw-btn" title="Draw a custom area on the map">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7 16 3-7 7-3z"/></svg>
        </button>
        <button type="button" class="flood-model-draw-icon-btn flood-model-draw-icon-btn--danger" data-role="draw-clear-btn" title="Delete the drawn area" ${this.#drawnBbox ? "" : "disabled"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>
        </button>
        <button type="button" class="flood-model-draw-icon-btn" data-role="upload-btn" title="Upload a shapefile (.zip) or KML/KMZ as the area" ${this.#uploadingAoiFile ? "disabled" : ""}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
        </button>
        <input type="file" class="flood-model-visually-hidden" data-role="aoi-file-input" accept=".zip,.kml,.kmz" aria-label="Upload area file" />
        <span class="flood-model-draw-ctrl-label">${this.#esc(label)}</span>
        ${inCustomMode ? `<button type="button" class="landslide-model-link-btn" data-role="use-named-btn">Use a named catchment instead</button>` : ""}
      </div>
    `;
  }

  #renderChecklistHTML() {
    const stages =
      this.#mode === MODE_TRIGGER ? TRIGGER_RUN_STAGES :
      this.#mode === MODE_NATIONAL_VALIDATION ? NATIONAL_VALIDATION_RUN_STAGES :
      this.#mode === MODE_CALIBRATE ? CALIBRATE_RUN_STAGES :
      SUSCEPTIBILITY_RUN_STAGES;
    const rows = stages.map((stage) => {
      const done = this.#completedStages.includes(stage) && stage !== this.#currentStage;
      const active = stage === this.#currentStage;
      const icon = done ? "✓" : active ? "…" : "";
      const cls = done ? "is-done" : active ? "is-active" : "is-pending";
      const timeCell = active && this.#elapsedSeconds != null ? `${this.#elapsedSeconds.toFixed(0)}s elapsed` : "";
      return `
        <tr class="flood-model-checklist-row ${cls}">
          <td class="flood-model-checklist-icon">${icon}</td>
          <td class="flood-model-checklist-label">${this.#esc(stage)}</td>
          <td class="flood-model-checklist-time">${timeCell}</td>
        </tr>
      `;
    }).join("");
    // Same "an unmatched current_stage still gets its own row" fallback
    // flood-model-control.js's own #renderChecklistHTML already
    // establishes — the exposure sub-stages and the trigger mode's own
    // dynamic "Fetching {source} rainfall data" stage both rely on this,
    // not a hardcoded exhaustive list.
    const matchesStaticRow = stages.includes(this.#currentStage);
    const dynamicRow = (this.#currentStage && !matchesStaticRow) ? `
      <tr class="flood-model-checklist-row is-active">
        <td class="flood-model-checklist-icon">…</td>
        <td class="flood-model-checklist-label">${this.#esc(this.#currentStage)}</td>
        <td class="flood-model-checklist-time">${this.#elapsedSeconds != null ? `${this.#elapsedSeconds.toFixed(0)}s elapsed` : ""}</td>
      </tr>
    ` : "";
    return `<table class="flood-model-checklist-table"><tbody>${rows}${dynamicRow}</tbody></table>`;
  }

  #renderResultsHTML() {
    if (this.#lastResultMode === MODE_TRIGGER) return this.#renderTriggerResultsHTML(this.#lastResult);
    if (this.#lastResultMode === MODE_NATIONAL_VALIDATION) return this.#renderNationalValidationResultsHTML(this.#lastResult);
    if (this.#lastResultMode === MODE_CALIBRATE) return this.#renderCalibrateResultsHTML(this.#lastResult);
    return this.#renderSusceptibilityResultsHTML(this.#lastResult);
  }

  #aucCell(entry) {
    if (!entry || entry.auc == null) return "—";
    return `${this.#esc(entry.auc)} (${this.#esc(entry.interpretation)})`;
  }

  #renderCalibrateResultsHTML(model) {
    const ev = model.evaluation || {};
    const pooled = ev.pooled || {};
    const chosenKey = `calibrated_${model.feature_set}`;
    const approval = (model.approval || {}).susceptibility || {};
    const fsApproval = (model.approval || {}).infinite_slope || {};
    const methodLabels = {
      ahp: "Literature AHP",
      [chosenKey]: `Calibrated (${model.feature_set})`,
      infinite_slope_default: "Infinite slope (default)",
      infinite_slope_calibrated: "Infinite slope (calibrated)",
    };
    const pooledRows = Object.entries(pooled).map(([name, e]) => `
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">${this.#esc(methodLabels[name] || name)}</span>
        <span class="flood-model-result-value">${name === chosenKey ? "<strong>" : ""}${this.#aucCell(e)}${name === chosenKey ? "</strong>" : ""}</span>
      </div>
    `).join("");
    const foldRows = (ev.per_fold || []).map((f) => `
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">${this.#esc(f.test_catchment)} (held out, ${this.#esc(f.n_test_events)} events)</span>
        <span class="flood-model-result-value">calibrated ${this.#aucCell(f.methods?.[chosenKey])} · AHP ${this.#aucCell(f.methods?.ahp)}</span>
      </div>
    `).join("");
    const trainRows = Object.entries((model.training || {}).catchments || {}).map(([key, c]) => {
      const bySrc = Object.entries(c.n_events_by_source || {}).filter(([, n]) => n).map(([src, n]) => `${src} ${n}`).join(" · ");
      return `<div class="flood-model-result-row"><span class="flood-model-result-label">${this.#esc(key)}</span><span class="flood-model-result-value">${this.#esc(c.n_events)} events${bySrc ? ` (${this.#esc(bySrc)})` : ""}</span></div>`;
    }).join("");
    const reasons = (approval.not_approved_reasons || []).map((r) => `<li>${this.#esc(r)}</li>`).join("");
    const local = model.local || {};
    const localApproved = Object.keys(local.approved_catchments || {});
    const localRows = Object.entries(local.evidence || {}).map(([key, e]) => `
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">${this.#esc(key)} (${this.#esc(e.n_events)} events)</span>
        <span class="flood-model-result-value">${e.approved ? "<strong>approved</strong>" : "not approved"} — ${this.#esc(e.spatial_cv_auc)} vs AHP ${this.#esc(e.ahp_spatial_cv_auc)}, won ${this.#esc(e.quadrants_won)} quadrants</span>
      </div>
    `).join("");
    const importance = Object.entries(model.factor_importance || {}).slice(0, 6).map(([k, v]) => `
      <div class="flood-model-ahp-weight-row"><span class="flood-model-ahp-weight-label">${this.#esc(k)}</span><span>${(v * 100).toFixed(1)}%</span></div>
    `).join("");
    return `
      <div class="flood-model-results">
        <div class="landslide-model-advisory-badge ${approval.approved ? "is-normal" : "is-watch"}">
          ${approval.approved ? "Approved everywhere — Auto runs now use the calibrated model"
            : localApproved.length ? `Approved locally for ${this.#esc(localApproved.join(", "))} — literature AHP everywhere else`
            : "Not approved — Auto runs keep using literature AHP"}
        </div>
        ${reasons ? `<div class="flood-model-note">Cross-catchment model not approved:</div><ul class="landslide-model-reason-list">${reasons}</ul>` : ""}
        ${localRows ? `
        <div class="flood-model-section-title" style="margin-top:10px;">Local model (${this.#esc(local.feature_set)}) — held-out quadrants of each catchment</div>
        ${localRows}` : ""}
        <div class="flood-model-section-title" style="margin-top:10px;">Held-out pooled AUC (leave-one-catchment-out)</div>
        ${pooledRows}
        <div class="flood-model-section-title" style="margin-top:10px;">Per held-out catchment</div>
        ${foldRows}
        <div class="flood-model-section-title" style="margin-top:10px;">Strongest factors (calibrated)</div>
        <div class="flood-model-ahp-weights">${importance}</div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Infinite-slope parameters</span><span class="flood-model-result-value">${fsApproval.approved ? "calibrated values in use" : "literature defaults kept"}</span></div>
        <div class="flood-model-section-title" style="margin-top:10px;">Ground truth used</div>
        ${trainRows}
        <div class="flood-model-result-hint">
          Point catalogs (GFLD/GLC) are only used where their own stated location precision is within ~1 km;
          most Pakistan entries are placed at a town or district centre and would otherwise score the map on
          where landslides were reported, not where slopes failed. Model ${this.#esc(model.model_id)}.
        </div>
      </div>
    `;
  }

  // A real, honest interpretation label per AUC value — same literature
  // bands accuracy_assessment.py's own _AUC_INTERPRETATION_BANDS use
  // server-side (>=0.9 excellent / >=0.8 good / >=0.7 fair / >=0.6 poor
  // / else fail) — mirrored here only for a plain-language display, the
  // actual number always comes from the server, never recomputed
  // client-side.
  #renderNationalValidationResultsHTML(result) {
    // Backward-compatible with an older cached result that only ever
    // had the simple pooled shape (no LOCO calibration yet).
    const simple = result.simple_pooled || result;
    const loco = result.loco_calibrated || null;

    const ahp = simple.ahp || {};
    const fs = simple.infinite_slope || {};
    const perCatchment = simple.per_catchment || {};
    const rows = Object.entries(perCatchment).map(([key, c]) => `
      <div class="flood-model-result-row">
        <span class="flood-model-result-label">${this.#esc(key)}</span>
        <span class="flood-model-result-value">COOLR ${c.n_coolr} · GFLD ${c.n_gfld} · GLC ${c.n_glc} · NCOP inventory ${c.n_ncop_inventory ?? 0} · NCOP recent ${c.n_ncop_recent ?? 0} · pooled ${c.n_pooled}</span>
      </div>
    `).join("");

    let locoHTML = "";
    if (loco && !loco.error) {
      const locoFr = loco.pooled_fr_auc_held_out || {};
      const locoAhp = loco.pooled_ahp_auc_held_out || {};
      const foldRows = (loco.per_fold || []).map((f) => `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">${this.#esc(f.test_catchment)} (held out, ${f.n_test_events} real events)</span>
          <span class="flood-model-result-value">FR ${this.#esc(f.fr_auc?.auc_mean)} (${this.#esc(f.fr_auc?.interpretation)}) · AHP-alone ${this.#esc(f.ahp_auc?.auc_mean)} (${this.#esc(f.ahp_auc?.interpretation)})</span>
        </div>
      `).join("");
      locoHTML = `
        <div class="flood-model-section-title" style="margin-top:10px;">Local calibration (held-out, Frequency Ratio)</div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Calibrated score — held-out pooled AUC</span><span class="flood-model-result-value"><strong>${this.#esc(locoFr.auc_mean)}</strong> (${this.#esc(locoFr.interpretation)}), range ${this.#esc(locoFr.auc_min)}–${this.#esc(locoFr.auc_max)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">AHP-alone on the same held-out test</span><span class="flood-model-result-value">${this.#esc(locoAhp.auc_mean)} (${this.#esc(locoAhp.interpretation)}), range ${this.#esc(locoAhp.auc_min)}–${this.#esc(locoAhp.auc_max)}</span></div>
        <div class="flood-model-note">
          Each catchment scored ONLY after being held out of its own calibration — a genuine, non-inflated estimate, not fit-and-tested on the same data:
        </div>
        ${foldRows}
        <div class="flood-model-result-hint">
          Frequency-Ratio weights are fit from the OTHER catchments' own real events, then tested against the one held-out catchment's own events it never saw. AUC is threshold-invariant — zone-breakpoint calibration alone cannot move it; only a data-fit score like this one can.
        </div>
      `;
    } else if (loco && loco.error) {
      locoHTML = `<div class="flood-model-note">Local calibration not available: ${this.#esc(loco.error)}</div>`;
    }

    // §L6.6 Part 2 — an INDEPENDENT spatial cross-check against 4 real
    // regional AHP susceptibility rasters (KP/Balochistan/AJK/GB, a
    // separate GeoServer). Never blended into the AUC figures above —
    // its own section, its own honest interpretation scale (a
    // correlation coefficient, not an AUC).
    const regionalComparison = simple.regional_comparison || {};
    const regionalRows = Object.entries(regionalComparison).map(([key, c]) => {
      if (!c || c.region == null) {
        return `<div class="flood-model-result-row"><span class="flood-model-result-label">${this.#esc(key)}</span><span class="flood-model-result-value">no regional coverage overlaps this area</span></div>`;
      }
      if (c.error) {
        return `<div class="flood-model-result-row"><span class="flood-model-result-label">${this.#esc(key)} (${this.#esc(c.region)})</span><span class="flood-model-result-value">${this.#esc(c.error)}</span></div>`;
      }
      return `<div class="flood-model-result-row"><span class="flood-model-result-label">${this.#esc(key)} (${this.#esc(c.region)})</span><span class="flood-model-result-value">Spearman r = ${this.#esc(c.spearman_r)} (${this.#esc(c.interpretation)}), ${this.#esc(c.n_valid_pixels)} px compared</span></div>`;
    }).join("");
    const regionalHTML = regionalRows ? `
      <div class="flood-model-section-title" style="margin-top:10px;">Regional AHP comparison (independent, not blended in)</div>
      <div class="flood-model-note">
        Spatial rank-correlation between our own AHP score and 4 real, independently-produced regional susceptibility rasters (KP/Balochistan/AJK/GB) — a second opinion, never fed back into our own weights.
      </div>
      ${regionalRows}
    ` : "";

    return `
      <div class="flood-model-results">
        <div class="flood-model-section-title">Uncalibrated (literature weights only)</div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">AHP score — pooled AUC</span><span class="flood-model-result-value">${this.#esc(ahp.auc_mean)} (${this.#esc(ahp.interpretation)}), range ${this.#esc(ahp.auc_min)}–${this.#esc(ahp.auc_max)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Infinite-slope — pooled AUC</span><span class="flood-model-result-value">${this.#esc(fs.auc_mean)} (${this.#esc(fs.interpretation)}), range ${this.#esc(fs.auc_min)}–${this.#esc(fs.auc_max)}</span></div>
        ${locoHTML}
        ${regionalHTML}
        <div class="flood-model-note">
          <strong>Real ground-truth counts per catchment</strong> (COOLR is currently unreachable — its own endpoint returns HTTP 404 — so its count is 0 everywhere until that recovers):
        </div>
        ${rows}
        <div class="flood-model-result-hint">
          Real, honest numbers throughout — never a fabricated target. An AUC below 0.6 is a genuine "fail" per the standard literature bands, reported as such either way.
        </div>
      </div>
    `;
  }

  #renderTriggerResultsHTML(result) {
    const idt = result.id_threshold || {};
    const rainfall = result.rainfall || {};
    const stat = result.static_susceptibility || {};
    const badgeClass = ADVISORY_BADGE_CLASS[result.advisory] || "is-normal";
    return `
      <div class="flood-model-results">
        <div class="landslide-model-advisory-badge ${badgeClass}">
          Advisory: ${this.#esc(result.advisory)}
        </div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Rainfall source</span><span class="flood-model-result-value">${this.#esc(result.source)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Rainfall / duration</span><span class="flood-model-result-value">${this.#esc(rainfall.rainfall_mm)} mm / ${this.#esc(rainfall.duration_hr)} hr</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Intensity vs. threshold</span><span class="flood-model-result-value">${this.#esc(idt.intensity_mm_hr)} vs. ${this.#esc(idt.threshold_mm_hr)} mm/hr</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Static susceptibility class</span><span class="flood-model-result-value">${this.#esc(stat.dominant_class)}</span></div>
        <div class="flood-model-result-hint">
          Regionally-transferred Kashmir Himalaya ID-threshold curve — see the methodology
          document §3.5/§6 for its own real, honest limitations (a daily-aggregate rainfall
          figure can understate a shorter, more intense causative burst).
        </div>
      </div>
    `;
  }

  #renderSusceptibilityResultsHTML(result) {
    const sus = result.susceptibility || {};
    const weights = sus.weights || {};
    const topWeights = Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const infSlope = result.infinite_slope || {};
    const rockfall = result.rockfall || {};
    const avalanche = result.avalanche || {};
    const debris = (result.debris_flow || {}).summary || null;
    const exposure = result.exposure || {};
    const pop = exposure.population || {};
    const buildings = exposure.buildings || {};
    const roads = exposure.roads || {};
    const validation = result.validation;

    const weightRows = topWeights.map(([k, v]) => `
      <div class="flood-model-ahp-weight-row">
        <span class="flood-model-ahp-weight-label">${this.#esc(k)}</span>
        <span>${(v * 100).toFixed(1)}%</span>
      </div>
    `).join("");

    let validationHTML = "";
    if (validation) {
      const ahpAuc = (validation.ahp || {}).interpretation || "no_ground_truth";
      validationHTML = `
        <div class="flood-model-result-row">
          <span class="flood-model-result-label">COOLR validation (AHP)</span>
          <span class="flood-model-result-value">${this.#esc(ahpAuc)}${validation.n_coolr_events ? "" : " — no ground truth reachable right now"}</span>
        </div>
      `;
    }

    const calibrated = sus.method === "calibrated";
    const modelSummary = sus.model_summary || {};
    const methodRow = calibrated
      ? `Calibrated (${modelSummary.scope === "local" ? "local to this catchment" : "all catchments"}) ${this.#esc(sus.model_id)} — held-out AUC ${this.#esc(modelSummary.held_out_auc)} vs AHP ${this.#esc(modelSummary.ahp_held_out_auc)}${modelSummary.approved ? "" : " (not approved)"}`
      : "Literature AHP weights";
    const debrisRows = debris ? `
        <div class="flood-model-result-row"><span class="flood-model-result-label">Debris-flow-capable area</span><span class="flood-model-result-value">${this.#esc(debris.debris_flow?.area_km2)} km² (${((debris.debris_flow?.area_fraction || 0) * 100).toFixed(1)}%)</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Debris-flood-capable area</span><span class="flood-model-result-value">${this.#esc(debris.debris_flood?.area_km2)} km² (${((debris.debris_flood?.area_fraction || 0) * 100).toFixed(1)}%)</span></div>
    ` : "";

    return `
      <div class="flood-model-results">
        <div class="flood-model-result-row"><span class="flood-model-result-label">Terrain class</span><span class="flood-model-result-value">${this.#esc(sus.terrain_class)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Slide-score method</span><span class="flood-model-result-value">${methodRow}</span></div>
        <div class="flood-model-ahp-weights">${weightRows}</div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Infinite-slope soil depth</span><span class="flood-model-result-value">${this.#esc(infSlope.soil_depth_m)} m</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Rockfall-flagged area</span><span class="flood-model-result-value">${this.#esc(rockfall.susceptible_km2)} km² (${((rockfall.susceptible_fraction || 0) * 100).toFixed(1)}%)</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Avalanche-gated fraction</span><span class="flood-model-result-value">${((avalanche.gate_applied_fraction || 0) * 100).toFixed(1)}%</span></div>
        ${debrisRows}
        <div class="flood-model-result-row"><span class="flood-model-result-label">High-zone area</span><span class="flood-model-result-value">${this.#esc(exposure.landslide_high_zone_km2)} km²</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Population in high zone</span><span class="flood-model-result-value">${this.#esc(pop.total)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Buildings in high zone</span><span class="flood-model-result-value">${this.#esc(buildings.buildings_in_flood_zone)}</span></div>
        <div class="flood-model-result-row"><span class="flood-model-result-label">Roads in high zone</span><span class="flood-model-result-value">${this.#esc(roads.length_in_flood_zone_km)} km</span></div>
        ${validationHTML}
        <div class="flood-model-result-hint">
          Rockfall, avalanche and debris-flow (Melton-ratio watershed screen, outlined in red/orange
          on the map) are independent screening layers (§3.8) — never blended into the slide score above.
        </div>
      </div>
    `;
  }

  #setStatus(text, tone = "info") {
    this.#statusText = text;
    this.#statusTone = tone;
  }

  // ---- Events -------------------------------------------------------------

  #wireEvents() {
    if (!this.#container) return;
    this.#container.addEventListener("change", (e) => {
      const role = e.target?.dataset?.role;
      if (role === "catchment-select") {
        this.#selectedCatchment = e.target.value;
        if (this.#selectedCatchment !== CUSTOM_KEY) { this.#deactivateDrawMode(); this.#mapboxDraw?.deleteAll(); this.#drawnBbox = null; this.#drawnPolygon = null; }
        this.#renderContent();
      } else if (role === "mode-select") {
        this.#mode = e.target.value;
        this.#renderContent();
      } else if (role === "lite-checkbox") {
        this.#lite = e.target.checked;
      } else if (role === "validation-checkbox") {
        this.#includeValidation = e.target.checked;
      } else if (role === "lhasa2-checkbox") {
        this.#toggleLhasa2Layer(e.target.checked);
        this.#renderContent();
      } else if (role === "lhasa2-scan-show-map-checkbox") {
        this.#lhasa2ScanShowOnMap = e.target.checked;
        this.#toggleLhasa2ScanMapLayer(this.#lhasa2ScanShowOnMap);
      } else if (role === "method-select") {
        this.#method = e.target.value;
      } else if (role === "rainfall-source-select") {
        this.#selectedRainfallSource = e.target.value;
      } else if (role === "aoi-file-input") {
        const file = e.target.files?.[0];
        e.target.value = ""; // allow re-selecting the SAME file next time (change wouldn't otherwise fire)
        if (file) this.#uploadAoiFile(file);
      }
    });

    this.#container.addEventListener("click", (e) => {
      const role = e.target?.closest?.("[data-role]")?.dataset?.role;
      if (role === "run-btn") this.#run();
      else if (role === "lhasa2-scan-run-btn") this.#runLhasa2Scan();
      else if (role === "draw-btn") {
        // Mirrors flood-model-control.js's own #floodModelDrawBtn handler
        // exactly: the lasso itself is what switches the active area to
        // "custom" — not a hidden dropdown option (see #renderContent's
        // own note on this).
        if (this.#selectedCatchment !== CUSTOM_KEY) {
          this.#selectedCatchment = CUSTOM_KEY;
          this.#lastResult = null;
          this.#lastResultMode = null;
          this.#removeZoneLayer();
        }
        this.#activateDrawMode();
        this.#renderContent();
      }
      else if (role === "draw-clear-btn") { this.#deactivateDrawMode(); this.#mapboxDraw?.deleteAll(); this.#drawnBbox = null; this.#drawnPolygon = null; this.#setStatus(""); this.#renderContent(); }
      else if (role === "upload-btn") this.#container.querySelector('[data-role="aoi-file-input"]')?.click();
      else if (role === "use-named-btn") {
        this.#deactivateDrawMode();
        this.#mapboxDraw?.deleteAll();
        this.#drawnBbox = null;
        this.#drawnPolygon = null;
        this.#selectedCatchment = KNOWN_CATCHMENTS[0].key;
        this.#lastResult = null;
        this.#lastResultMode = null;
        this.#removeZoneLayer();
        this.#setStatus("");
        this.#renderContent();
      }
      else if (role === "export-geojson-btn") this.#exportGeoJSON();
      else if (role === "export-report-btn") this.#exportReport();
    });
  }

  // ---- Draw tool ------------------------------------------------------------

  #ensureMapboxDraw() {
    if (this.#mapboxDraw) return this.#mapboxDraw;
    try {
      // Same "no default toolbar, driven entirely by our own panel
      // buttons" approach flood-model-control.js's own #ensureMapboxDraw
      // already establishes — a SEPARATE MapboxDraw instance from
      // flood's own (each hazard owns its own draw state), but the same
      // configuration, so no native toolbar ever needs the CSS carve-out
      // flood's own draw tool required.
      this.#mapboxDraw = new MapboxDraw({ displayControlsDefault: false, controls: {} });
      this.#map.addControl(this.#mapboxDraw);
      const onChange = () => this.#onDrawChange();
      this.#map.on("draw.create", onChange);
      this.#map.on("draw.update", onChange);
      this.#map.on("draw.delete", () => { this.#drawnBbox = null; this.#drawnPolygon = null; this.#renderContent(); });
      this.#map.on("draw.modechange", (e) => { this.#drawModeActive = e.mode === "draw_polygon"; });
    } catch (err) {
      console.warn("landslide-model-control: could not initialize the draw tool", err);
    }
    return this.#mapboxDraw;
  }

  // Public — checked by layer-attribute-popup.js via
  // window.ncopLandslideModelControl, mirroring flood's own convention.
  isDrawModeActive() {
    return this.#drawModeActive;
  }

  #activateDrawMode() {
    const draw = this.#ensureMapboxDraw();
    if (!draw) return;
    draw.changeMode("draw_polygon");
    this.#drawModeActive = true;
    this.#renderContent();
  }

  #deactivateDrawMode() {
    this.#drawModeActive = false;
    try { this.#mapboxDraw?.changeMode("simple_select"); } catch (_) { /* no-op if not initialized */ }
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
        this.#setStatus(`Drawn area is too large (${areaDeg2.toFixed(3)} deg² > ${MAX_CUSTOM_AOI_BBOX_DEG2} deg² cap) — draw a smaller area.`, "error");
        this.#mapboxDraw?.deleteAll();
        this.#drawnBbox = null;
        this.#drawnPolygon = null;
        this.#renderContent();
        return;
      }
      this.#drawnBbox = bbox;
      this.#drawnPolygon = feature.geometry;
      this.#setStatus("Area drawn — ready to run.", "info");
      this.#renderContent();
    } catch (err) {
      console.warn("landslide-model-control: could not read the drawn area", err);
    }
  }

  // Uploads a shapefile (.zip) or KML/KMZ via the SAME generic,
  // already-existing endpoints flood's own custom-AOI import uses,
  // takes the returned GeoJSON's own first polygon feature, and treats
  // it exactly like a hand-drawn polygon (same #drawnBbox/#drawnPolygon
  // state, same downstream Run flow).
  async #uploadAoiFile(file) {
    this.#uploadingAoiFile = true;
    this.#setStatus("Uploading area file…", "info");
    this.#renderContent();
    const isKml = /\.(kml|kmz)$/i.test(file.name);
    const endpoint = isKml ? UPLOAD_KMZ_ENDPOINT : UPLOAD_SHAPEFILE_ENDPOINT;
    const fieldName = isKml ? "kmz" : "shapefile";
    const formData = new FormData();
    formData.append(fieldName, file);
    try {
      const res = await fetch(endpoint, { method: "POST", credentials: "same-origin", body: formData });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        this.#setStatus(data?.error || "Could not process the uploaded file.", "error");
        return;
      }
      const feature = data.features?.[0];
      const geometry = feature?.geometry;
      if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
        this.#setStatus("The uploaded file did not contain a usable polygon.", "error");
        return;
      }
      const bbox = turfBbox(feature);
      const [minx, miny, maxx, maxy] = bbox;
      const areaDeg2 = (maxx - minx) * (maxy - miny);
      if (areaDeg2 > MAX_CUSTOM_AOI_BBOX_DEG2) {
        this.#setStatus(`Uploaded area is too large (${areaDeg2.toFixed(3)} deg² > ${MAX_CUSTOM_AOI_BBOX_DEG2} deg² cap).`, "error");
        return;
      }
      this.#selectedCatchment = CUSTOM_KEY;
      this.#lastResult = null;
      this.#lastResultMode = null;
      this.#removeZoneLayer();
      this.#drawnBbox = bbox;
      this.#drawnPolygon = geometry;
      // Mirror the uploaded shape into the draw tool too, so it's
      // visible on the map and clearable the same way a hand-drawn
      // polygon is.
      const draw = this.#ensureMapboxDraw();
      draw?.deleteAll();
      draw?.add({ type: "Feature", properties: {}, geometry });
      this.#setStatus("Area imported — ready to run.", "info");
    } catch (err) {
      this.#setStatus(`Could not upload the file: ${err?.message || "network error"}`, "error");
    } finally {
      this.#uploadingAoiFile = false;
      this.#renderContent();
    }
  }

  // ---- Run / poll -----------------------------------------------------------

  async #run() {
    if (this.#busy) return;

    let body;
    if (NO_AREA_MODES.includes(this.#mode)) {
      // No catchment/area at all for these modes — they pool every
      // registered catchment's own ground truth server-side.
      body = { mode: this.#mode, lite: this.#lite };
    } else {
      let catchmentBody;
      if (this.#selectedCatchment === CUSTOM_KEY) {
        if (!this.#drawnBbox) { this.#setStatus("Draw or upload an area first.", "error"); this.#renderContent(); return; }
        catchmentBody = { catchment: "custom", bbox: this.#drawnBbox, polygon: this.#drawnPolygon };
      } else {
        catchmentBody = { catchment: this.#selectedCatchment };
      }
      body = this.#mode === MODE_TRIGGER
        ? { ...catchmentBody, mode: MODE_TRIGGER, lite: this.#lite, source: this.#selectedRainfallSource }
        : { ...catchmentBody, mode: MODE_SUSCEPTIBILITY, lite: this.#lite, include_validation: this.#includeValidation, method: this.#method };
    }

    this.#busy = true;
    this.#lastResult = null;
    this.#completedStages = [];
    this.#currentStage = null;
    this.#elapsedSeconds = null;
    this.#removeZoneLayer();
    this.#setStatus("Submitting job…", "info");
    this.#renderContent();

    let res;
    try {
      res = await fetch(LANDSLIDE_RUN_ENDPOINT, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.#busy = false;
      this.#setStatus(`Could not reach the server: ${err?.message || "network error"}`, "error");
      this.#renderContent();
      return;
    }

    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.job_id) {
      this.#busy = false;
      this.#setStatus(data?.error || `Request failed (HTTP ${res.status}).`, "error");
      this.#renderContent();
      return;
    }

    this.#activeJobId = data.job_id;
    this.#setStatus("Job running…", "info");
    this.#renderContent();
    this.#poll();
  }

  async #poll() {
    if (!this.#activeJobId) return;
    this.#stopPolling();

    let res;
    try {
      res = await fetch(`${LANDSLIDE_STATUS_ENDPOINT}${encodeURIComponent(this.#activeJobId)}/`, { credentials: "same-origin" });
    } catch (err) {
      // Transient network hiccup while polling — try again next tick
      // rather than failing the whole run over one dropped request.
      this.#pollTimer = setTimeout(() => this.#poll(), POLL_INTERVAL_MS);
      return;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      this.#busy = false;
      this.#activeJobId = null;
      this.#setStatus(data?.error || `Status check failed (HTTP ${res.status}).`, "error");
      this.#renderContent();
      return;
    }

    this.#completedStages = data.completed_stages || [];
    this.#currentStage = data.current_stage || null;
    this.#elapsedSeconds = data.elapsed_seconds;

    if (data.status === "done") {
      this.#busy = false;
      this.#lastResult = data.result;
      this.#lastResultMode = data.mode;
      this.#lastJobId = this.#activeJobId;
      this.#activeJobId = null;
      this.#setStatus("Done.", "success");
      this.#renderContent();
      if (data.mode === MODE_SUSCEPTIBILITY) {
        const zones = (data.result?.susceptibility || {}).zones;
        const cfg = KNOWN_CATCHMENTS.find((c) => c.key === this.#selectedCatchment);
        const bounds = this.#drawnBbox
          ? [[this.#drawnBbox[0], this.#drawnBbox[1]], [this.#drawnBbox[2], this.#drawnBbox[3]]]
          : null;
        this.#addZoneLayer(zones, bounds, cfg?.center);
        this.#addDebrisLayer((data.result?.debris_flow || {}).geojson);
      }
      return;
    }
    if (data.status === "error") {
      this.#busy = false;
      this.#activeJobId = null;
      this.#setStatus(data.error || "The job failed.", "error");
      this.#renderContent();
      return;
    }

    this.#renderContent();
    if (this.#isVisible) this.#pollTimer = setTimeout(() => this.#poll(), POLL_INTERVAL_MS);
  }

  #stopPolling() {
    if (this.#pollTimer) { clearTimeout(this.#pollTimer); this.#pollTimer = null; }
  }

  // ---- LHASA2 scan: run / poll (own job, own loop — see this file's own
  // "LHASA2 real-time extraction + exposure scan" field-group comment) ------

  async #runLhasa2Scan() {
    if (this.#lhasa2ScanBusy) return;
    this.#lhasa2ScanBusy = true;
    this.#lhasa2ScanResult = null;
    this.#lhasa2ScanCompletedStages = [];
    this.#lhasa2ScanCurrentStage = null;
    this.#lhasa2ScanElapsedSeconds = null;
    this.#lhasa2ScanShowOnMap = false;
    this.#toggleLhasa2ScanMapLayer(false);
    this.#lhasa2ScanStatusText = "Submitting scan…";
    this.#lhasa2ScanStatusTone = "info";
    this.#renderContent();

    let res;
    try {
      res = await fetch(LHASA2_SCAN_RUN_ENDPOINT, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "lhasa2_exposure_scan" }),
      });
    } catch (err) {
      this.#lhasa2ScanBusy = false;
      this.#lhasa2ScanStatusText = `Could not reach the server: ${err?.message || "network error"}`;
      this.#lhasa2ScanStatusTone = "error";
      this.#renderContent();
      return;
    }

    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.job_id) {
      this.#lhasa2ScanBusy = false;
      this.#lhasa2ScanStatusText = data?.error || `Request failed (HTTP ${res.status}).`;
      this.#lhasa2ScanStatusTone = "error";
      this.#renderContent();
      return;
    }

    this.#lhasa2ScanJobId = data.job_id;
    this.#lhasa2ScanStatusText = "Scan running…";
    this.#renderContent();
    this.#pollLhasa2Scan();
  }

  async #pollLhasa2Scan() {
    if (!this.#lhasa2ScanJobId) return;
    this.#stopLhasa2ScanPolling();

    let res;
    try {
      res = await fetch(`${LHASA2_SCAN_STATUS_ENDPOINT}${encodeURIComponent(this.#lhasa2ScanJobId)}/`, { credentials: "same-origin" });
    } catch (err) {
      this.#lhasa2ScanPollTimer = setTimeout(() => this.#pollLhasa2Scan(), POLL_INTERVAL_MS);
      return;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      this.#lhasa2ScanBusy = false;
      this.#lhasa2ScanJobId = null;
      this.#lhasa2ScanStatusText = data?.error || `Status check failed (HTTP ${res.status}).`;
      this.#lhasa2ScanStatusTone = "error";
      this.#renderContent();
      return;
    }

    this.#lhasa2ScanCompletedStages = data.completed_stages || [];
    this.#lhasa2ScanCurrentStage = data.current_stage || null;
    this.#lhasa2ScanElapsedSeconds = data.elapsed_seconds;

    if (data.status === "done") {
      this.#lhasa2ScanBusy = false;
      this.#lhasa2ScanResult = data.result;
      this.#lhasa2ScanJobId = null;
      this.#lhasa2ScanStatusText = "Done.";
      this.#lhasa2ScanStatusTone = "success";
      this.#renderContent();
      return;
    }
    if (data.status === "error") {
      this.#lhasa2ScanBusy = false;
      this.#lhasa2ScanJobId = null;
      this.#lhasa2ScanStatusText = data.error || "The scan failed.";
      this.#lhasa2ScanStatusTone = "error";
      this.#renderContent();
      return;
    }

    this.#renderContent();
    if (this.#isVisible) this.#lhasa2ScanPollTimer = setTimeout(() => this.#pollLhasa2Scan(), POLL_INTERVAL_MS);
  }

  #stopLhasa2ScanPolling() {
    if (this.#lhasa2ScanPollTimer) { clearTimeout(this.#lhasa2ScanPollTimer); this.#lhasa2ScanPollTimer = null; }
  }

  // Real per-feature GeoJSON (result.features[].geometry, from the
  // backend's own vectorized blobs) — a separate source/layer pair from
  // ZONE_SOURCE_ID so a susceptibility zone layer and this scan's own
  // extracted-feature layer can be shown together without colliding.
  #toggleLhasa2ScanMapLayer(visible) {
    const map = this.#map;
    try {
      if (map.getLayer(LHASA2_SCAN_OUTLINE_LAYER_ID)) map.removeLayer(LHASA2_SCAN_OUTLINE_LAYER_ID);
      if (map.getLayer(LHASA2_SCAN_FILL_LAYER_ID)) map.removeLayer(LHASA2_SCAN_FILL_LAYER_ID);
      if (map.getSource(LHASA2_SCAN_SOURCE_ID)) map.removeSource(LHASA2_SCAN_SOURCE_ID);
      if (!visible || !this.#lhasa2ScanResult?.features?.length) return;
      const featureCollection = {
        type: "FeatureCollection",
        features: this.#lhasa2ScanResult.features.filter((f) => f.geometry).map((f) => ({
          type: "Feature", geometry: f.geometry,
          properties: { id: f.id, area_km2: f.area_km2, probability_class_min_pct: f.probability_class_min_pct, assessed: f.assessed },
        })),
      };
      map.addSource(LHASA2_SCAN_SOURCE_ID, { type: "geojson", data: featureCollection });
      map.addLayer({
        id: LHASA2_SCAN_FILL_LAYER_ID, type: "fill", source: LHASA2_SCAN_SOURCE_ID,
        paint: { "fill-color": "#8e44ad", "fill-opacity": 0.35 },
      });
      map.addLayer({
        id: LHASA2_SCAN_OUTLINE_LAYER_ID, type: "line", source: LHASA2_SCAN_SOURCE_ID,
        paint: { "line-color": "#5b2c6f", "line-width": 1.2 },
      });
    } catch (err) {
      console.warn("landslide-model-control: could not toggle the LHASA2 scan feature layer", err);
    }
  }

  // ---- Map layer ------------------------------------------------------------

  #addZoneLayer(zonesGeoJSON, bounds, fallbackCenter) {
    if (!zonesGeoJSON?.features?.length) return;
    const map = this.#map;
    this.#removeZoneLayer();
    try {
      map.addSource(ZONE_SOURCE_ID, { type: "geojson", data: zonesGeoJSON });
      map.addLayer({
        id: ZONE_FILL_LAYER_ID, type: "fill", source: ZONE_SOURCE_ID,
        paint: {
          "fill-color": ["match", ["get", "zone_class"], "low", ZONE_COLORS.low, "medium", ZONE_COLORS.medium, "high", ZONE_COLORS.high, "#999999"],
          "fill-opacity": ["match", ["get", "zone_class"], "low", ZONE_LOW_OPACITY, ZONE_MEDIUM_HIGH_OPACITY],
        },
      });
      map.addLayer({
        id: ZONE_OUTLINE_LAYER_ID, type: "line", source: ZONE_SOURCE_ID,
        paint: { "line-color": "#3a3a3a", "line-width": 0.6, "line-opacity": 0.5 },
      });
      if (Array.isArray(bounds) && bounds.length === 2) {
        map.fitBounds(bounds, { padding: 40, maxZoom: 11, duration: 600 });
      } else if (Array.isArray(fallbackCenter)) {
        map.flyTo({ center: fallbackCenter, zoom: 10, duration: 600 });
      }
    } catch (err) {
      console.warn("landslide-model-control: could not add zone layer", err);
    }
  }

  #addDebrisLayer(geojson) {
    if (!geojson?.features?.length) return;
    const map = this.#map;
    try {
      map.addSource(DEBRIS_SOURCE_ID, { type: "geojson", data: geojson });
      const color = ["match", ["get", "debris_class"], "debris_flow", DEBRIS_COLORS.debris_flow, "debris_flood", DEBRIS_COLORS.debris_flood, "#999999"];
      map.addLayer({
        id: DEBRIS_FILL_LAYER_ID, type: "fill", source: DEBRIS_SOURCE_ID,
        paint: { "fill-color": color, "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: DEBRIS_OUTLINE_LAYER_ID, type: "line", source: DEBRIS_SOURCE_ID,
        paint: { "line-color": color, "line-width": 1.0, "line-opacity": 0.8 },
      });
    } catch (err) {
      console.warn("landslide-model-control: could not add debris-flow layer", err);
    }
  }

  #removeZoneLayer() {
    const map = this.#map;
    try {
      if (map.getLayer(DEBRIS_OUTLINE_LAYER_ID)) map.removeLayer(DEBRIS_OUTLINE_LAYER_ID);
      if (map.getLayer(DEBRIS_FILL_LAYER_ID)) map.removeLayer(DEBRIS_FILL_LAYER_ID);
      if (map.getSource(DEBRIS_SOURCE_ID)) map.removeSource(DEBRIS_SOURCE_ID);
      if (map.getLayer(ZONE_OUTLINE_LAYER_ID)) map.removeLayer(ZONE_OUTLINE_LAYER_ID);
      if (map.getLayer(ZONE_FILL_LAYER_ID)) map.removeLayer(ZONE_FILL_LAYER_ID);
      if (map.getSource(ZONE_SOURCE_ID)) map.removeSource(ZONE_SOURCE_ID);
    } catch (_) { /* best-effort cleanup */ }
  }

  // Adds/removes the SAME LHASA2 raster tile source/layer the generic
  // layer catalog's own "LHASA2 Landslide Probability (Latest)" entry
  // uses — reuses mbx_lhasa2_latest.source/.layers verbatim (map-
  // layers.js's own already-resolved definition, see this file's own
  // import comment), just toggled from inside this panel instead of a
  // separate catalog trip. If the user ALSO has it on via the generic
  // catalog, addSource/addLayer below is guarded (checks getSource/
  // getLayer first) so toggling here never throws a duplicate-id error
  // — it just becomes a shared no-op either way.
  #toggleLhasa2Layer(visible) {
    this.#lhasa2Visible = visible;
    const map = this.#map;
    const sourceId = mbx_lhasa2_latest.source.id;
    try {
      if (visible) {
        if (!map.getSource(sourceId)) map.addSource(sourceId, mbx_lhasa2_latest.source);
        for (const layer of mbx_lhasa2_latest.layers) {
          if (!map.getLayer(layer.id)) map.addLayer({ ...layer, source: sourceId });
        }
      } else {
        for (const layer of mbx_lhasa2_latest.layers) {
          if (map.getLayer(layer.id)) map.removeLayer(layer.id);
        }
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      }
    } catch (err) {
      console.warn("landslide-model-control: could not toggle the LHASA2 layer", err);
    }
  }

  // ---- Export -----------------------------------------------------------

  async #exportGeoJSON() {
    if (!this.#lastJobId) return;
    window.open(`${LANDSLIDE_EXPORT_ENDPOINT}${encodeURIComponent(this.#lastJobId)}/`, "_blank");
  }

  #captureMapSnapshot() {
    const map = this.#map;
    if (!map || typeof map.getCanvas !== "function") return null;
    const MAX_WIDTH_PX = 1400;
    try {
      const sourceCanvas = map.getCanvas();
      const { width, height } = sourceCanvas;
      if (!width || !height) return null;
      if (width <= MAX_WIDTH_PX) return sourceCanvas.toDataURL("image/png");
      const scale = MAX_WIDTH_PX / width;
      const scaledCanvas = document.createElement("canvas");
      scaledCanvas.width = MAX_WIDTH_PX;
      scaledCanvas.height = Math.round(height * scale);
      const ctx = scaledCanvas.getContext("2d");
      if (!ctx) return sourceCanvas.toDataURL("image/png");
      ctx.drawImage(sourceCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
      return scaledCanvas.toDataURL("image/png");
    } catch (err) {
      console.warn("landslide-model-control: map snapshot capture failed", err);
      return null;
    }
  }

  async #exportReport() {
    if (this.#exportingReport || !this.#lastJobId) return;
    this.#exportingReport = true;
    this.#setStatus("Generating report…", "info");
    this.#renderContent();

    const mapImage = this.#captureMapSnapshot();
    let res;
    try {
      res = await fetch(`${LANDSLIDE_REPORT_EXPORT_ENDPOINT}${encodeURIComponent(this.#lastJobId)}/`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mapImage ? { map_image: mapImage } : {}),
      });
    } catch (err) {
      this.#exportingReport = false;
      this.#setStatus(`Could not reach the server: ${err?.message || "network error"}`, "error");
      this.#renderContent();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      this.#exportingReport = false;
      this.#setStatus(data?.error || `Report export failed (HTTP ${res.status}).`, "error");
      this.#renderContent();
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `landslide_model_report_${this.#selectedCatchment}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    this.#exportingReport = false;
    this.#setStatus("Report downloaded.", "success");
    this.#renderContent();
  }
}
