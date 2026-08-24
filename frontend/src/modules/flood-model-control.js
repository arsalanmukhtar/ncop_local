// flood-model-control.js
import { Popup } from "mapbox-gl";
// ---------------------------------------------------------------------------
// A self-contained rail button + panel for the flash-flood early-warning
// system's first frontend slice (see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md
// §7 "Phase 1.6" and §0.15 for the backend this calls). Zero coupling to
// ncop_menu_items/sourcelayer-control.js — same structural pattern
// GisExportControl already established: own DOM injected in the
// constructor, own RAIL_PANEL_REGISTRY entry in dashboard.js, delegated
// event listeners on a persistent content container.
//
// Scope, deliberately narrow for this first slice: the existing pilot
// catchment(s) only (currently just Nullah Lai) — pick a catchment, pick a
// HAND threshold, run, watch it poll to completion, see the result on the
// map plus a summary of the exposure report. Custom-AOI drawing and
// DEM/rainfall upload are Phase 1.6's own later step, not built here —
// this panel's "Area" section is a dropdown of known catchments, nothing
// more, so adding that step later only means extending this section, not
// restructuring the panel.
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
const POLL_INTERVAL_MS = 3000;
const RESULT_RASTER_SOURCE_ID = "flood-model-result-raster";
const RESULT_RASTER_LAYER_ID = "flood-model-result-raster-layer";
const CATCHMENT_MARKER_SOURCE_ID = "flood-model-catchment-marker";
const CATCHMENT_MARKER_LAYER_ID = "flood-model-catchment-marker-layer";

// Known pilot catchments — mirrors flood_model.PILOT_CATCHMENTS server-side
// (project/ncop_internal/flood_model.py). Kept as a small static list here
// rather than fetched from an endpoint: there is exactly one today, adding
// a second is a one-line change here and a one-line change there, and this
// avoids a network round-trip just to populate a dropdown. `center` is the
// bbox centroid (matches the server-side bbox exactly — see flood_model.py
// §0.17: corrected to the Lai Nullah Basin's own published boundary,
// Rahman et al., WMO/APFM case study), used only to place a marker+tooltip
// so an operator can see roughly where a catchment sits before running it.
const KNOWN_CATCHMENTS = [
  { key: "nullah_lai", label: "Nullah Lai (Rawalpindi/Islamabad)", center: [73.0167, 33.6583] },
];

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

export class FloodModelControl {
  #map;
  #isVisible = false;
  #busy = false;
  #activeJobId = null;
  #pollTimer = null;
  #selectedCatchment = KNOWN_CATCHMENTS[0]?.key || null;
  #selectedThreshold = DEFAULT_THRESHOLD_M;
  #lastResult = null;
  #completedStages = [];
  #currentStage = null;
  #catchmentPopup = null;

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
    });
    content?.addEventListener("change", (event) => {
      if (event.target.id === "floodModelCatchmentSelect") {
        this.#selectedCatchment = event.target.value;
        this.#updateCatchmentMarker();
        return;
      }
      if (event.target.id === "floodModelThresholdInput") {
        const v = parseFloat(event.target.value);
        if (Number.isFinite(v)) this.#selectedThreshold = v;
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

    const catchmentOptions = KNOWN_CATCHMENTS.map((c) => `
      <option value="${this.#esc(c.key)}" ${c.key === this.#selectedCatchment ? "selected" : ""}>${this.#esc(c.label)}</option>
    `).join("");

    content.innerHTML = `
      <div class="flood-model-section">
        <div class="flood-model-section-title">Area</div>
        <select id="floodModelCatchmentSelect" class="flood-model-select" ${this.#busy ? "disabled" : ""}>
          ${catchmentOptions}
        </select>
      </div>

      <div class="flood-model-section">
        <div class="flood-model-section-title">Model settings</div>
        <label class="flood-model-slider-row">
          <span class="flood-model-slider-label">Flood-prone threshold (HAND)</span>
          <input
            type="range" id="floodModelThresholdInput"
            min="${MIN_THRESHOLD_M}" max="${MAX_THRESHOLD_M}" step="${THRESHOLD_STEP_M}"
            value="${this.#selectedThreshold}" ${this.#busy ? "disabled" : ""}
          >
          <span id="floodModelThresholdReadout" class="flood-model-slider-readout">${this.#selectedThreshold.toFixed(1)} m</span>
        </label>
        <div class="flood-model-note">Cells within this HAND (height above nearest drainage) value are flagged flood-prone.</div>
        <div class="flood-model-note flood-model-note-methodology">
          <strong>Not calibrated for this catchment.</strong> A genuinely
          calibrated threshold needs an actual rainfall/discharge scenario
          as input (planned, not yet built) — this default is a starting
          point only, kept mid-range within the one directly comparable
          published study found: Bhatt &amp; Srinivasa Rao (2018),
          <em>HAND tool and satellite-based geospatial analysis of
          Hyderabad (India) urban floods</em>, Arabian Journal of
          Geosciences 11(19):600, which reports HAND 1&ndash;5m spanning
          very-high to very-low flood susceptibility for a comparable
          South Asian urban catchment. The same literature also documents
          HAND underestimating inundation by up to 40% in flat,
          channelized urban settings &mdash; a real caveat for Lai
          Nullah specifically, not a generic disclaimer.
        </div>
      </div>

      <div class="flood-model-section">
        <div class="flood-model-section-title">Run</div>
        <button type="button" id="floodModelRun" class="flood-model-run-btn" ${this.#busy ? "disabled" : ""}>
          ${this.#busy ? "Running…" : "Run flood model"}
        </button>
        <div id="floodModelStatus" class="flood-model-status" aria-live="polite"></div>
        <div id="floodModelChecklist" class="flood-model-checklist">${this.#busy ? this.#renderChecklistHTML() : ""}</div>
      </div>

      <div class="flood-model-section flood-model-accuracy-note">
        <div class="flood-model-section-title">Accuracy &amp; methodology status</div>
        <div class="flood-model-note">
          This is Phase 1's <strong>hazard layer only</strong> (terrain/HAND-based) &mdash;
          not an AHP-weighted susceptibility or vulnerability score (that's
          a separate, later phase, not yet built). <strong>No accuracy
          (AUC) report exists for this catchment</strong>: the 20 existing
          NCOP flood-extent reference layers do not geographically overlap
          Nullah Lai (confirmed directly against the source data, not
          assumed), so there is no independent ground truth to validate
          against here yet. The AUC methodology itself has been built and
          tested against a different catchment that does have overlapping
          ground truth &mdash; see the project's own methodology
          documentation for the full result.
        </div>
      </div>

      <div id="floodModelResults" class="flood-model-results"></div>
    `;

    if (this.#lastResult) this.#renderResults(this.#lastResult);
  }

  // Static-list checklist against the (known, backend-mirrored) stage
  // sequence — ticks a stage the moment it appears in #completedStages,
  // highlights whichever stage is #currentStage. Any stage not yet
  // reached renders as a plain pending row. See RUN_STAGES's own comment
  // for the frontend/backend string-coupling this depends on.
  #renderChecklistHTML() {
    return RUN_STAGES.map((stage) => {
      const done = this.#completedStages.includes(stage) && stage !== this.#currentStage;
      const active = stage === this.#currentStage;
      const icon = done ? "✓" : active ? "…" : "";
      const cls = done ? "is-done" : active ? "is-active" : "is-pending";
      return `<div class="flood-model-checklist-row ${cls}"><span class="flood-model-checklist-icon">${icon}</span><span class="flood-model-checklist-label">${this.#esc(stage)}</span></div>`;
    }).join("");
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
    this.#busy = true;
    this.#lastResult = null;
    this.#completedStages = [];
    this.#currentStage = null;
    const resultsEl = document.getElementById("floodModelResults");
    if (resultsEl) resultsEl.innerHTML = "";
    this.#removeResultLayer();
    this.#renderContent();
    this.#setStatus("Submitting…", "info");

    let res, data;
    try {
      res = await fetch(FLOOD_MODEL_RUN_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catchment: this.#selectedCatchment, threshold_m: this.#selectedThreshold }),
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
  }

  async #poll() {
    if (!this.#activeJobId) return;
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
      this.#currentStage = data.current_stage ?? this.#currentStage;
      const checklistEl = document.getElementById("floodModelChecklist");
      if (checklistEl) checklistEl.innerHTML = this.#renderChecklistHTML();
      if (this.#isVisible) this.#pollTimer = setTimeout(() => this.#poll(), POLL_INTERVAL_MS);
      // If hidden, just stop — showPanel() resumes polling on reopen since
      // #activeJobId is still set.
      return;
    }

    this.#busy = false;
    this.#activeJobId = null;

    if (data.status === "done") {
      this.#setStatus("Done.", "success");
      this.#lastResult = data.result;
      this.#renderContent();
      return;
    }

    // status === "error"
    this.#setStatus(`Run failed: ${data.error || "unknown error"}`, "error");
    this.#renderContent();
  }

  // ---- Results: map overlay + summary --------------------------------------------
  #renderResults(result) {
    const resultsEl = document.getElementById("floodModelResults");
    if (!resultsEl) return;

    this.#addResultLayer(result.flood_zone);

    const exposure = result.exposure || {};
    const buildings = exposure.buildings || {};
    const population = exposure.population || {};
    const roads = exposure.roads || {};
    const drainage = exposure.drainage || {};
    const admin = Array.isArray(exposure.administrative_context) ? exposure.administrative_context : [];
    const topAdmin = admin.filter((a) => a.level === "district").slice(0, 3);

    resultsEl.innerHTML = `
      <div class="flood-model-section-title">Results — ${this.#esc(exposure.flood_zone_km2 ?? "?")} km² flood-prone</div>
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
      <div class="flood-model-note">Flood-prone zone rendered on the map. This is a one-off run — not added to the permanent layer catalog.</div>
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
      map.fitBounds([[minx, miny], [maxx, maxy]], { padding: 40, maxZoom: 15, duration: 800 });
    } catch (err) {
      // Non-fatal — the numeric results are still shown even if the map
      // overlay fails to add (e.g. a stale/duplicate source id).
      console.warn("flood-model-control: could not add result raster layer", err);
    }
  }

  #removeResultLayer() {
    const map = this.#map;
    try {
      if (map.getLayer(RESULT_RASTER_LAYER_ID)) map.removeLayer(RESULT_RASTER_LAYER_ID);
      if (map.getSource(RESULT_RASTER_SOURCE_ID)) map.removeSource(RESULT_RASTER_SOURCE_ID);
    } catch (_) { /* best-effort cleanup */ }
  }
}
