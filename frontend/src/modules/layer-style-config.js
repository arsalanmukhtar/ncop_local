// layer-style-config.js
//
// Rail button (`#layerStyleToggle`, lucide `palette`) + attached panel
// (`#layerStylePanel`) that lets the user restyle any active vector
// layer on the map.
//
// Architecture
// ------------
// • Layer dropdown is populated from `SourceLayerControl.getActiveLayerKeys()`
//   and refreshed whenever a sidebar toggle adds/removes a layer (we wrap
//   add/removeLayerByKey, mirroring what LayerOrderControl already does
//   for its draggable list).
// • When the user picks a layer, we read its config from
//   `findLayerConfig(layerKey).config.layers[]`, infer geometry from
//   the Mapbox layer types (fill → polygon, line → line, circle → point),
//   and render a geometry-appropriate set of controls.
// • Each control is declarative — see GEOMETRY_CONTROL_DEFS / LABEL_CONTROL_DEFS
//   below.  A single render loop turns those defs into DOM and wires
//   `map.setPaintProperty` / `setLayoutProperty` directly on each input.
// • Labels are added via a synthesized symbol layer
//   `<primaryLayerId>--lsp-labels` that we own — toggling the master
//   switch adds / removes that layer.

const LSP_LABELS_SUFFIX = "--lsp-labels";

// ---------------------------------------------------------------------------
// Geometry-aware control definitions.  Each entry yields one row in the
// STYLE section.  `role` is resolved to a Mapbox layer id at render time
// via the layer's role map (see #resolveRoles).
// ---------------------------------------------------------------------------
const GEOMETRY_CONTROL_DEFS = {
  line: [
    { kind: "slider", label: "Width", role: "line", prop: "line-width",
      min: 0, max: 20, step: 0.5, unit: "px", fmt: "1d", fallback: 1 },
    { kind: "color",  label: "Color", role: "line", prop: "line-color",
      fallback: "#3bb2d0" },
    { kind: "slider", label: "Opacity", role: "line", prop: "line-opacity",
      min: 0, max: 1, step: 0.01, fmt: "1d2", fallback: 1 },
    { kind: "segment-dash", label: "Dash pattern", role: "line",
      prop: "line-dasharray",
      options: [
        { value: "solid",  label: "Solid",  dash: null },
        { value: "dashed", label: "Dashed", dash: [4, 2] },
        { value: "dotted", label: "Dotted", dash: [1, 2] },
        { value: "custom", label: "Custom", dash: [6, 3, 1, 3] },
      ] },
    { kind: "segment", label: "Line cap", role: "line", prop: "line-cap",
      type: "layout",
      options: [
        { value: "butt",   label: "Butt"   },
        { value: "round",  label: "Round"  },
        { value: "square", label: "Square" },
      ], fallback: "butt" },
    { kind: "segment", label: "Line join", role: "line", prop: "line-join",
      type: "layout",
      options: [
        { value: "bevel", label: "Bevel" },
        { value: "round", label: "Round" },
        { value: "miter", label: "Miter" },
      ], fallback: "miter" },
    { kind: "slider", label: "Blur", role: "line", prop: "line-blur",
      min: 0, max: 10, step: 0.1, unit: "px", fmt: "1d1", fallback: 0 },
    { kind: "slider", label: "Gap width", role: "line", prop: "line-gap-width",
      min: 0, max: 20, step: 0.5, unit: "px", fmt: "1d1", fallback: 0 },
    { kind: "slider", label: "Offset", role: "line", prop: "line-offset",
      min: -20, max: 20, step: 0.5, unit: "px", fmt: "1d", fallback: 0 },
  ],

  point: [
    { kind: "slider", label: "Radius", role: "circle", prop: "circle-radius",
      min: 0, max: 30, step: 0.5, unit: "px", fmt: "1d1", fallback: 5 },
    { kind: "color",  label: "Fill color", role: "circle", prop: "circle-color",
      fallback: "#3bb2d0" },
    { kind: "slider", label: "Fill opacity", role: "circle",
      prop: "circle-opacity",
      min: 0, max: 1, step: 0.01, fmt: "1d2", fallback: 1 },
    { kind: "color",  label: "Stroke color", role: "circle",
      prop: "circle-stroke-color", fallback: "#000000" },
    { kind: "slider", label: "Stroke width", role: "circle",
      prop: "circle-stroke-width",
      min: 0, max: 10, step: 0.5, unit: "px", fmt: "1d1", fallback: 0 },
    { kind: "slider", label: "Stroke opacity", role: "circle",
      prop: "circle-stroke-opacity",
      min: 0, max: 1, step: 0.01, fmt: "1d2", fallback: 1 },
    { kind: "slider", label: "Blur", role: "circle", prop: "circle-blur",
      min: -1, max: 1, step: 0.05, fmt: "1d2", fallback: 0 },
  ],

  polygon: [
    { kind: "color",  label: "Fill color", role: "fill", prop: "fill-color",
      fallback: "#3bb2d0" },
    { kind: "slider", label: "Fill opacity", role: "fill", prop: "fill-opacity",
      min: 0, max: 1, step: 0.01, fmt: "1d2", fallback: 0.3 },
    { kind: "color",  label: "Outline color", role: "outline",
      prop: "line-color", fallback: "#000000" },
    { kind: "slider", label: "Outline width", role: "outline",
      prop: "line-width",
      min: 0, max: 10, step: 0.5, unit: "px", fmt: "1d1", fallback: 1 },
    { kind: "slider", label: "Outline opacity", role: "outline",
      prop: "line-opacity",
      min: 0, max: 1, step: 0.01, fmt: "1d2", fallback: 1 },
  ],
};

// ---------------------------------------------------------------------------
// Label controls — applied to the synthesized labels symbol layer.
// `role` is always "labels".
// ---------------------------------------------------------------------------
const LABEL_CONTROL_DEFS = [
  { kind: "field-select", label: "Field", prop: "text-field", type: "layout" },
  { kind: "slider", label: "Size", prop: "text-size", type: "layout",
    min: 8, max: 32, step: 1, unit: "px", fmt: "1d", fallback: 12 },
  { kind: "color", label: "Color", prop: "text-color", fallback: "#ffffff" },
  { kind: "slider", label: "Opacity", prop: "text-opacity",
    min: 0, max: 1, step: 0.01, fmt: "1d2", fallback: 1 },
  { kind: "segment", label: "Transform", prop: "text-transform", type: "layout",
    options: [
      { value: "none",      label: "None"  },
      { value: "uppercase", label: "Upper" },
      { value: "lowercase", label: "Lower" },
    ], fallback: "none" },
  { kind: "color", label: "Halo color", prop: "text-halo-color",
    fallback: "#000000" },
  { kind: "slider", label: "Halo width", prop: "text-halo-width",
    min: 0, max: 5, step: 0.1, unit: "px", fmt: "1d1", fallback: 1 },
  { kind: "slider", label: "Halo blur", prop: "text-halo-blur",
    min: 0, max: 5, step: 0.1, unit: "px", fmt: "1d1", fallback: 0 },
];

// Inline SVG pill glyphs — purpose-drawn so each geometry is unambiguous
// at 10px.  Lucide's `circle` is hollow by default and CSS overrides
// were inconsistent across SVG-attribute precedence; inline markup with
// hard-coded fill/stroke avoids the whole issue.
const GEOMETRY_PILL_META = {
  line: {
    label: "Line",
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <line x1="3" y1="12" x2="21" y2="12"
                  stroke="currentColor" stroke-width="4"
                  stroke-linecap="round" />
          </svg>`,
  },
  point: {
    label: "Point",
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="12" cy="12" r="8" fill="currentColor" />
          </svg>`,
  },
  polygon: {
    label: "Polygon",
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16"
                  fill="none" stroke="currentColor" stroke-width="2.75"
                  stroke-linejoin="round" />
          </svg>`,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const roundToStep = (v, step) =>
  step > 0 ? Math.round(v / step) * step : v;

function formatValue(v, def) {
  if (v == null) return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  switch (def.fmt) {
    case "1d2": return n.toFixed(2);
    case "1d1": return n.toFixed(1);
    case "1d":  return Number.isInteger(n) ? String(n) : n.toFixed(1);
    default:    return String(n);
  }
}

// Convert a Mapbox color (any) to a hex usable by <input type="color">.
// Mapbox accepts named, hex, rgb, rgba, hsl — we just need a reasonable
// hex for the UI swatch.  Anything that fails to parse falls back to
// the def fallback.
function toHex(value, fallback = "#000000") {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (/^#([0-9a-f]{6})$/i.test(v)) return v.toLowerCase();
  if (/^#([0-9a-f]{3})$/i.test(v)) {
    return ("#" + v.slice(1).split("").map((c) => c + c).join("")).toLowerCase();
  }
  // rgb / rgba / named — render via a temp element.
  try {
    const el = document.createElement("div");
    el.style.color = v;
    document.body.appendChild(el);
    const computed = getComputedStyle(el).color;
    el.remove();
    const m = computed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) {
      const r = parseInt(m[1]).toString(16).padStart(2, "0");
      const g = parseInt(m[2]).toString(16).padStart(2, "0");
      const b = parseInt(m[3]).toString(16).padStart(2, "0");
      return ("#" + r + g + b).toLowerCase();
    }
  } catch { /* ignore */ }
  return fallback;
}

// ---------------------------------------------------------------------------
export class LayerStyleConfig {
  #map;
  #sourceLayerControl;
  #wrapperEl;
  #buttonEl;
  #panelEl;

  // Selected layer state
  #currentKey = null;
  #currentRoles = {};       // { fill, outline, line, circle, symbol }
  #currentGeometry = null;  // 'line' | 'point' | 'polygon' | null

  // Per-layer label state (persisted across selection changes within a session)
  // key -> { enabled, field, fields[], symbolLayerId }
  #labelState = new Map();

  // Snapshot of original paint values per layer for "Reset to default"
  // key -> { [mapboxLayerId]: { paint: {prop:value}, layout: {prop:value} } }
  #originalSnapshots = new Map();

  // Element refs for the currently-rendered controls
  #styleControlsEl;
  #labelsContentEl;
  #labelsHeaderEl;
  #labelsToggleEl;
  #geometryPillEl;
  #layerSelectEl;

  constructor(map, sourceLayerControl) {
    this.#map = map;
    this.#sourceLayerControl = sourceLayerControl;
    this.#renderButton();
    this.#renderPanel();
    this.#wireToggle();
    this.#wireInternalUI();
    this.#hookSourceLayerControl();
    this.#hookStyleReload();
  }

  // ------------------------------------------------------------------ DOM
  #renderButton() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;
    if (document.getElementById("layerStyleToggle")) return;

    this.#wrapperEl = document.createElement("div");
    this.#wrapperEl.className = "custom-layer-style-control";
    this.#wrapperEl.innerHTML = `
      <button id="layerStyleToggle" class="custom-layer-style-btn"
              type="button" title="Layer Style">
        <i data-lucide="palette"></i>
      </button>
    `;
    mapContainer.appendChild(this.#wrapperEl);
    if (window.lucide?.createIcons) window.lucide.createIcons();
    this.#buttonEl = this.#wrapperEl.querySelector("#layerStyleToggle");
  }

  #renderPanel() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;
    if (document.getElementById("layerStylePanel")) return;

    this.#panelEl = document.createElement("div");
    this.#panelEl.id = "layerStylePanel";
    this.#panelEl.className = "layer-style-panel right-rail-panel";
    this.#panelEl.innerHTML = `
      <header class="lsp-header">
        <div class="lsp-titles">
          <h2 class="lsp-title">Layer Style</h2>
          <span class="lsp-subtitle">Configure rendering</span>
        </div>
        <button class="lsp-close" type="button" aria-label="Close">
          <i data-lucide="x"></i>
        </button>
      </header>

      <div class="lsp-body">
        <div class="lsp-row">
          <span class="lsp-row-label">Layer</span>
          <div class="lsp-control">
            <div class="lsp-select-wrap">
              <select class="lsp-native-select" id="lspLayerSelect"></select>
              <i data-lucide="chevron-down" class="lsp-select-caret"></i>
            </div>
          </div>
        </div>

        <div class="lsp-section-header">
          <div class="lsp-section-titlewrap">
            <h3 class="lsp-section-title">Style</h3>
            <span class="lsp-geometry-pill" id="lspGeometryPill"
                  data-geometry="">
              <span class="lsp-geometry-icon"></span>
              <span class="lsp-geometry-label">—</span>
            </span>
          </div>
        </div>

        <div class="lsp-controls" id="lspStyleControls">
          <div class="lsp-empty-state">No active vector layers.<br>
            Toggle a layer from the sidebar to begin.</div>
        </div>

        <div class="lsp-section-header lsp-labels-header" data-collapsed="true">
          <button class="lsp-section-titlewrap lsp-collapse-btn"
                  type="button" aria-expanded="false">
            <i data-lucide="chevron-down" class="lsp-collapse-chevron"></i>
            <h3 class="lsp-section-title">Labels</h3>
          </button>
          <button class="lsp-toggle" type="button"
                  data-layout="text-field-toggle" aria-pressed="false">
            <span class="lsp-toggle-thumb"></span>
          </button>
        </div>

        <div class="lsp-controls lsp-labels-content" hidden></div>
      </div>

      <footer class="lsp-footer">
        <button class="lsp-btn lsp-btn--ghost" type="button"
                id="lspResetBtn">Reset to default</button>
        <button class="lsp-btn lsp-btn--primary" type="button"
                id="lspApplyBtn">Apply</button>
      </footer>
    `;
    mapContainer.appendChild(this.#panelEl);
    if (window.lucide?.createIcons) window.lucide.createIcons();

    this.#styleControlsEl = this.#panelEl.querySelector("#lspStyleControls");
    this.#labelsContentEl = this.#panelEl.querySelector(".lsp-labels-content");
    this.#labelsHeaderEl  = this.#panelEl.querySelector(".lsp-labels-header");
    this.#labelsToggleEl  = this.#panelEl.querySelector(
      '.lsp-toggle[data-layout="text-field-toggle"]'
    );
    this.#geometryPillEl  = this.#panelEl.querySelector("#lspGeometryPill");
    this.#layerSelectEl   = this.#panelEl.querySelector("#lspLayerSelect");
  }

  // ------------------------------------------------------------------ wiring
  #wireToggle() {
    if (!this.#buttonEl || !this.#panelEl) return;

    this.#buttonEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !this.#panelEl.classList.contains("visible");
      this.#closeOtherRailPanels();
      this.#panelEl.classList.toggle("visible", willOpen);
      this.#buttonEl.classList.toggle("active-layer-style", willOpen);
      if (willOpen) this.#refreshOnOpen();
    });

    this.#panelEl.querySelector(".lsp-close")
      ?.addEventListener("click", () => this.#close());
  }

  #wireInternalUI() {
    // Layer dropdown
    this.#layerSelectEl.addEventListener("change", (e) => {
      this.#selectLayer(e.target.value);
    });

    // Labels collapsible
    const collapseBtn = this.#panelEl.querySelector(".lsp-collapse-btn");
    collapseBtn.addEventListener("click", () => {
      const collapsed = this.#labelsHeaderEl.dataset.collapsed === "true";
      this.#labelsHeaderEl.dataset.collapsed = collapsed ? "false" : "true";
      collapseBtn.setAttribute("aria-expanded", collapsed ? "true" : "false");
      this.#labelsContentEl.hidden = !collapsed;
    });

    // Master labels toggle
    this.#labelsToggleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!this.#currentKey) return;
      const on = this.#labelsToggleEl.classList.toggle("on");
      this.#labelsToggleEl.setAttribute("aria-pressed", on ? "true" : "false");
      if (on) this.#enableLabels();
      else    this.#disableLabels();
    });

    // Footer
    this.#panelEl.querySelector("#lspResetBtn")
      .addEventListener("click", () => this.#resetCurrent());
    this.#panelEl.querySelector("#lspApplyBtn")
      .addEventListener("click", () => this.#close());
  }

  #hookSourceLayerControl() {
    if (!this.#sourceLayerControl) return;
    const slc = this.#sourceLayerControl;
    const origAdd = slc.addLayerByKey.bind(slc);
    const origRem = slc.removeLayerByKey.bind(slc);
    slc.addLayerByKey = (...args) => {
      const r = origAdd(...args);
      this.#onActiveLayersChanged();
      return r;
    };
    slc.removeLayerByKey = (...args) => {
      const r = origRem(...args);
      this.#onActiveLayersChanged();
      return r;
    };
  }

  #hookStyleReload() {
    // Basemap changes wipe the style — labels we synthesized are gone,
    // and SourceLayerControl re-adds layers with their original paint.
    // Reset our state so next render reads fresh values.
    this.#map.on("style.load", () => {
      this.#labelState.forEach((s) => { s.symbolLayerId = null; });
      // Re-snapshot will happen next time a layer is selected.
      this.#originalSnapshots.clear();
      if (this.#panelEl?.classList.contains("visible")) {
        // Rebuild after layers settle.
        setTimeout(() => this.#refreshOnOpen(), 250);
      }
    });
  }

  #close() {
    this.#panelEl?.classList.remove("visible");
    this.#buttonEl?.classList.remove("active-layer-style");
  }

  #closeOtherRailPanels() {
    [
      ["userPanel", "user-panel-visible"],
      ["geocoderPanel", "visible"],
      ["basemapPanel", "visible"],
      ["projectionPanel", "visible"],
      ["layerOrderPanel", "visible"],
      ["layerInfoPanel", "visible"],
      ["ncopTourPanel", "visible"],
    ].forEach(([id, cls]) => {
      document.getElementById(id)?.classList.remove(cls);
    });
  }

  // ------------------------------------------------------------------ data
  #activeStylableLayers() {
    if (!this.#sourceLayerControl) return [];
    const keys = this.#sourceLayerControl.getActiveLayerKeys();
    return keys
      .map((key) => {
        const info  = this.#sourceLayerControl.findLayerConfig(key);
        const entry = this.#sourceLayerControl.activeLayers?.get(key);
        if (!info || !entry) return null;
        const geometry = this.#detectGeometry(info.config);
        if (!geometry) return null; // raster / unknown — skip
        return {
          key,
          label: info.config.label || key,
          config: info.config,
          activeEntry: entry,
          geometry,
        };
      })
      .filter(Boolean);
  }

  #detectGeometry(config) {
    const types = (config.layers || []).map((l) => l.type);
    if (types.includes("fill"))   return "polygon";
    if (types.includes("line"))   return "line";
    if (types.includes("circle")) return "point";
    if (types.includes("symbol")) return "point";
    return null;
  }

  // Map a "role" (fill/outline/line/circle/symbol) → live Mapbox layer id.
  #resolveRoles(activeEntry, config) {
    const roles = {};
    const layers = config.layers || [];
    const ids = activeEntry.layerIds || [];

    let firstLine = null, secondLine = null, fillId = null;
    layers.forEach((l, i) => {
      const id = ids[i];
      if (!id) return;
      if (l.type === "fill") fillId = id;
      else if (l.type === "line") {
        if (!firstLine) firstLine = id;
        else if (!secondLine) secondLine = id;
      } else if (l.type === "circle") roles.circle = id;
      else if (l.type === "symbol") roles.symbol = id;
    });

    if (fillId) {
      // Polygon: fill + (optional) outline-as-line
      roles.fill = fillId;
      if (firstLine) roles.outline = firstLine;
    } else if (firstLine) {
      // Pure line
      roles.line = firstLine;
      if (secondLine) roles.outline = secondLine;
    }
    return roles;
  }

  // ------------------------------------------------------------------ open
  #refreshOnOpen() {
    this.#populateLayerDropdown();
    // Keep previous selection across opens if it's still active.
    if (this.#currentKey) {
      const stillThere = Array.from(this.#layerSelectEl.options)
        .some((o) => o.value === this.#currentKey);
      if (stillThere) this.#layerSelectEl.value = this.#currentKey;
    }
    const value = this.#layerSelectEl.value;
    if (value) this.#selectLayer(value);
    else this.#renderEmptyState();
  }

  #onActiveLayersChanged() {
    if (!this.#panelEl?.classList.contains("visible")) return;
    const previous = this.#currentKey;
    this.#populateLayerDropdown();
    const stillActive = Array.from(this.#layerSelectEl.options)
      .some((o) => o.value === previous);
    if (stillActive) {
      this.#layerSelectEl.value = previous;
    } else if (this.#layerSelectEl.options.length > 0) {
      this.#layerSelectEl.value = this.#layerSelectEl.options[0].value;
      this.#selectLayer(this.#layerSelectEl.value);
    } else {
      this.#renderEmptyState();
    }
  }

  #populateLayerDropdown() {
    const layers = this.#activeStylableLayers();
    if (layers.length === 0) {
      this.#layerSelectEl.innerHTML =
        `<option value="">No active vector layers</option>`;
      this.#layerSelectEl.disabled = true;
      return;
    }
    this.#layerSelectEl.disabled = false;
    this.#layerSelectEl.innerHTML = layers
      .map((l) => `<option value="${l.key}">${l.label}</option>`)
      .join("");
  }

  #renderEmptyState() {
    this.#currentKey = null;
    this.#currentRoles = {};
    this.#currentGeometry = null;
    this.#geometryPillEl.dataset.geometry = "";
    this.#geometryPillEl.querySelector(".lsp-geometry-label").textContent = "—";
    this.#styleControlsEl.innerHTML =
      `<div class="lsp-empty-state">No active vector layers.<br>
       Toggle a layer from the sidebar to begin.</div>`;
    this.#labelsContentEl.innerHTML = "";
    this.#labelsToggleEl.classList.remove("on");
    this.#labelsToggleEl.setAttribute("aria-pressed", "false");
  }

  // ------------------------------------------------------------------ select
  #selectLayer(layerKey) {
    if (!layerKey) return this.#renderEmptyState();
    const layers = this.#activeStylableLayers();
    const entry = layers.find((l) => l.key === layerKey);
    if (!entry) return this.#renderEmptyState();

    this.#currentKey = layerKey;
    this.#currentGeometry = entry.geometry;
    this.#currentRoles = this.#resolveRoles(entry.activeEntry, entry.config);

    // Snapshot original paint/layout for Reset
    if (!this.#originalSnapshots.has(layerKey)) {
      const snap = {};
      Object.values(this.#currentRoles).forEach((id) => {
        if (!id) return;
        const cfgLayer = entry.config.layers.find(
          (l, i) => entry.activeEntry.layerIds[i] === id
        );
        snap[id] = {
          paint:  { ...(cfgLayer?.paint  || {}) },
          layout: { ...(cfgLayer?.layout || {}) },
        };
      });
      this.#originalSnapshots.set(layerKey, snap);
    }

    // Geometry pill — inline SVG (see GEOMETRY_PILL_META for shape rules)
    const meta = GEOMETRY_PILL_META[entry.geometry] || GEOMETRY_PILL_META.line;
    this.#geometryPillEl.dataset.geometry = entry.geometry;
    this.#geometryPillEl.querySelector(".lsp-geometry-label").textContent =
      meta.label;
    const iconEl = this.#geometryPillEl.querySelector(".lsp-geometry-icon");
    iconEl.outerHTML =
      `<span class="lsp-geometry-icon">${meta.svg}</span>`;

    // Style controls
    this.#renderControls(entry.geometry);
    // Labels
    this.#renderLabelsContent();
    this.#syncLabelsToggleUI();
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  // ------------------------------------------------------------------ render
  #renderControls(geometry) {
    const defs = GEOMETRY_CONTROL_DEFS[geometry] || [];
    this.#styleControlsEl.innerHTML = "";
    defs.forEach((def) => this.#styleControlsEl.appendChild(this.#buildRow(def)));
  }

  #renderLabelsContent() {
    const state = this.#getLabelState(this.#currentKey);
    this.#labelsContentEl.innerHTML = "";
    LABEL_CONTROL_DEFS.forEach((def) => {
      this.#labelsContentEl.appendChild(this.#buildRow(def, { isLabels: true, state }));
    });
  }

  // Build one full row (label + control) from a def.
  #buildRow(def, ctx = {}) {
    const row = document.createElement("div");
    row.className = "lsp-row";
    row.innerHTML = `<span class="lsp-row-label">${def.label}</span>`;
    const control = document.createElement("div");
    control.className = "lsp-control";

    switch (def.kind) {
      case "slider":   this.#buildSlider(control, def, ctx); break;
      case "color":    this.#buildColor(control, def, ctx); break;
      case "segment":  this.#buildSegment(control, def, ctx); break;
      case "segment-dash": this.#buildDashSegment(control, def, ctx); break;
      case "field-select": this.#buildFieldSelect(control, def, ctx); break;
      default: control.textContent = "—";
    }

    row.appendChild(control);
    return row;
  }

  // ------------------------------------------------------------------ controls
  #targetLayerId(def, ctx) {
    if (ctx.isLabels) return this.#getOrCreateLabelsId();
    const role = def.role;
    return this.#currentRoles[role];
  }

  #readCurrent(def, ctx) {
    const id = this.#targetLayerId(def, ctx);
    if (!id || !this.#map.getLayer(id)) return def.fallback;
    try {
      if (def.type === "layout") {
        const v = this.#map.getLayoutProperty(id, def.prop);
        return v == null ? def.fallback : v;
      }
      const v = this.#map.getPaintProperty(id, def.prop);
      return v == null ? def.fallback : v;
    } catch { return def.fallback; }
  }

  #applyToLayer(def, ctx, value) {
    const id = this.#targetLayerId(def, ctx);
    if (!id || !this.#map.getLayer(id)) return;
    try {
      if (def.type === "layout") {
        this.#map.setLayoutProperty(id, def.prop, value);
      } else {
        this.#map.setPaintProperty(id, def.prop, value);
      }
    } catch (e) {
      console.warn(`[LayerStyle] Failed to set ${def.prop} on ${id}:`, e);
    }
  }

  // ----- slider --------------------------------------------------
  #buildSlider(control, def, ctx) {
    control.classList.add("lsp-control--slider");
    const initial = clamp(
      Number(this.#readCurrent(def, ctx) ?? def.fallback),
      def.min, def.max
    );
    const pct = ((initial - def.min) / (def.max - def.min)) * 100;
    control.innerHTML = `
      <div class="lsp-slider" data-min="${def.min}" data-max="${def.max}"
           data-step="${def.step}">
        <div class="lsp-slider-track">
          <div class="lsp-slider-fill" style="width:${pct}%"></div>
        </div>
        <div class="lsp-slider-thumb" style="left:${pct}%"></div>
      </div>
      <span class="lsp-value">${formatValue(initial, def)}${def.unit || ""}</span>
    `;
    const slider  = control.querySelector(".lsp-slider");
    const fill    = control.querySelector(".lsp-slider-fill");
    const thumb   = control.querySelector(".lsp-slider-thumb");
    const display = control.querySelector(".lsp-value");

    const setValue = (rawV, write = true) => {
      let v = clamp(rawV, def.min, def.max);
      v = roundToStep(v, def.step);
      const p = ((v - def.min) / (def.max - def.min)) * 100;
      fill.style.width = p + "%";
      thumb.style.left = p + "%";
      display.textContent = formatValue(v, def) + (def.unit || "");
      if (write) this.#applyToLayer(def, ctx, v);
    };

    const dragFrom = (clientX) => {
      const rect = slider.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      setValue(def.min + ratio * (def.max - def.min));
    };

    slider.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      slider.setPointerCapture(e.pointerId);
      dragFrom(e.clientX);
      const move = (ev) => dragFrom(ev.clientX);
      const up = () => {
        slider.releasePointerCapture(e.pointerId);
        slider.removeEventListener("pointermove", move);
        slider.removeEventListener("pointerup", up);
      };
      slider.addEventListener("pointermove", move);
      slider.addEventListener("pointerup", up);
    });
  }

  // ----- color ---------------------------------------------------
  #buildColor(control, def, ctx) {
    const initial = toHex(this.#readCurrent(def, ctx), def.fallback || "#000000");
    control.innerHTML = `
      <label class="lsp-swatch">
        <input type="color" class="lsp-swatch-input" value="${initial}">
        <span class="lsp-swatch-chip" style="background:${initial}"></span>
        <span class="lsp-swatch-hex">${initial.toUpperCase()}</span>
      </label>
    `;
    const input = control.querySelector(".lsp-swatch-input");
    const chip  = control.querySelector(".lsp-swatch-chip");
    const hex   = control.querySelector(".lsp-swatch-hex");
    input.addEventListener("input", () => {
      chip.style.background = input.value;
      hex.textContent = input.value.toUpperCase();
      this.#applyToLayer(def, ctx, input.value);
    });
  }

  // ----- segment (cap/join/transform) ---------------------------
  #buildSegment(control, def, ctx) {
    const current = String(this.#readCurrent(def, ctx) ?? def.fallback);
    const seg = document.createElement("div");
    seg.className = "lsp-segmented";
    seg.innerHTML = def.options.map((o) => `
      <button class="lsp-seg ${o.value === current ? "active" : ""}"
              type="button" data-value="${o.value}">${o.label}</button>
    `).join("");
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest(".lsp-seg");
      if (!btn) return;
      seg.querySelectorAll(".lsp-seg")
        .forEach((s) => s.classList.toggle("active", s === btn));
      this.#applyToLayer(def, ctx, btn.dataset.value);
    });
    control.appendChild(seg);
  }

  // ----- dash segment (4 presets that map to line-dasharray arrays)
  #buildDashSegment(control, def, ctx) {
    const id = this.#targetLayerId(def, ctx);
    let currentDash = null;
    try { currentDash = id ? this.#map.getPaintProperty(id, "line-dasharray") : null; }
    catch { currentDash = null; }
    const matchValue = currentDash
      ? (def.options.find((o) => Array.isArray(o.dash) &&
          JSON.stringify(o.dash) === JSON.stringify(currentDash))?.value || "custom")
      : "solid";

    const seg = document.createElement("div");
    seg.className = "lsp-segmented";
    seg.innerHTML = def.options.map((o) => `
      <button class="lsp-seg ${o.value === matchValue ? "active" : ""}"
              type="button" data-value="${o.value}">${o.label}</button>
    `).join("");
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest(".lsp-seg");
      if (!btn) return;
      seg.querySelectorAll(".lsp-seg")
        .forEach((s) => s.classList.toggle("active", s === btn));
      const opt = def.options.find((o) => o.value === btn.dataset.value);
      const targetId = this.#targetLayerId(def, ctx);
      if (!targetId) return;
      try {
        // Mapbox: passing undefined removes the override; we pass null
        // for "solid" which Mapbox treats the same way.
        this.#map.setPaintProperty(targetId, "line-dasharray",
          opt.dash || undefined);
      } catch (err) {
        console.warn("[LayerStyle] dasharray:", err);
      }
    });
    control.appendChild(seg);
  }

  // ----- field-select (label field) ------------------------------
  #buildFieldSelect(control, def, ctx) {
    const state = ctx.state;
    const fields = state.fields || [];
    const current = state.field || fields[0] || "";

    const wrap = document.createElement("div");
    wrap.className = "lsp-select-wrap";
    wrap.innerHTML = `
      <select class="lsp-native-select lsp-field-select">
        ${fields.length === 0
          ? `<option value="">(no fields detected — toggle labels on)</option>`
          : fields.map((f) => `
            <option value="${f}" ${f === current ? "selected" : ""}>${f}</option>
          `).join("")}
      </select>
      <i data-lucide="chevron-down" class="lsp-select-caret"></i>
    `;
    const select = wrap.querySelector("select");
    select.disabled = fields.length === 0;
    select.addEventListener("change", () => {
      state.field = select.value;
      const id = this.#targetLayerId(def, ctx);
      if (!id || !this.#map.getLayer(id)) return;
      try {
        this.#map.setLayoutProperty(id, "text-field", ["get", select.value]);
      } catch (e) { console.warn("[LayerStyle] text-field:", e); }
    });
    control.appendChild(wrap);
  }

  // ------------------------------------------------------------------ labels
  #getLabelState(layerKey) {
    if (!this.#labelState.has(layerKey)) {
      this.#labelState.set(layerKey, {
        enabled: false,
        field: null,
        fields: [],
        symbolLayerId: null,
      });
    }
    return this.#labelState.get(layerKey);
  }

  #syncLabelsToggleUI() {
    const state = this.#getLabelState(this.#currentKey);
    this.#labelsToggleEl.classList.toggle("on", !!state.enabled);
    this.#labelsToggleEl.setAttribute(
      "aria-pressed", state.enabled ? "true" : "false"
    );
  }

  #getOrCreateLabelsId() {
    const state = this.#getLabelState(this.#currentKey);
    return state.symbolLayerId;
  }

  #enableLabels() {
    const key = this.#currentKey;
    const state = this.#getLabelState(key);
    if (state.enabled) return;

    const entry = this.#sourceLayerControl.activeLayers.get(key);
    const cfg = this.#sourceLayerControl.findLayerConfig(key)?.config;
    if (!entry || !cfg) return;

    const sourceId = entry.sourceId;
    const sourceLayerName = (cfg.layers || [])[0]?.["source-layer"];
    const primaryId = entry.layerIds[entry.layerIds.length - 1];

    state.fields = this.#discoverFields(sourceId, sourceLayerName);
    state.field = state.field || state.fields[0] || "name";

    const symbolId = `${primaryId}${LSP_LABELS_SUFFIX}`;
    if (!this.#map.getLayer(symbolId)) {
      try {
        this.#map.addLayer({
          id: symbolId,
          type: "symbol",
          source: sourceId,
          ...(sourceLayerName ? { "source-layer": sourceLayerName } : {}),
          layout: {
            "text-field": ["get", state.field],
            "text-size": 12,
            "text-anchor": "center",
            "text-allow-overlap": false,
            "text-ignore-placement": false,
          },
          paint: {
            "text-color": "#ffffff",
            "text-halo-color": "#000000",
            "text-halo-width": 1,
          },
        });
      } catch (e) {
        console.warn("[LayerStyle] addLayer (labels):", e);
        return;
      }
    }
    state.symbolLayerId = symbolId;
    state.enabled = true;

    // Re-render label content so the field select gets populated.
    this.#renderLabelsContent();
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  #disableLabels() {
    const state = this.#getLabelState(this.#currentKey);
    if (!state.enabled) return;
    if (state.symbolLayerId && this.#map.getLayer(state.symbolLayerId)) {
      try { this.#map.removeLayer(state.symbolLayerId); }
      catch (e) { console.warn("[LayerStyle] removeLayer (labels):", e); }
    }
    state.enabled = false;
    state.symbolLayerId = null;
    // Re-render label content so target-layer-dependent rows go inert.
    this.#renderLabelsContent();
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  // Sample rendered features and union their property keys.
  #discoverFields(sourceId, sourceLayerName) {
    try {
      const features = this.#map.querySourceFeatures(
        sourceId,
        sourceLayerName ? { sourceLayer: sourceLayerName } : {}
      );
      const set = new Set();
      features.slice(0, 200).forEach((f) => {
        if (f.properties) Object.keys(f.properties).forEach((k) => set.add(k));
      });
      return Array.from(set).sort();
    } catch { return []; }
  }

  // ------------------------------------------------------------------ reset
  #resetCurrent() {
    if (!this.#currentKey) return;
    const snap = this.#originalSnapshots.get(this.#currentKey);
    if (!snap) return;
    const defs = GEOMETRY_CONTROL_DEFS[this.#currentGeometry] || [];

    // For every prop the user could have touched, restore the original
    // value if it was in the snapshot, otherwise clear it (undefined →
    // Mapbox falls back to its style default).
    defs.forEach((def) => {
      const layerId = this.#currentRoles[def.role];
      if (!layerId || !this.#map.getLayer(layerId)) return;
      const orig = snap[layerId] || { paint: {}, layout: {} };
      try {
        if (def.kind === "segment-dash") {
          this.#map.setPaintProperty(layerId, "line-dasharray",
            orig.paint["line-dasharray"]);
          return;
        }
        if (def.type === "layout") {
          this.#map.setLayoutProperty(layerId, def.prop, orig.layout[def.prop]);
        } else {
          this.#map.setPaintProperty(layerId, def.prop, orig.paint[def.prop]);
        }
      } catch { /* ignore */ }
    });

    // Drop labels
    this.#disableLabels();

    // Re-read current values into the rendered controls.
    this.#renderControls(this.#currentGeometry);
    this.#renderLabelsContent();
    this.#syncLabelsToggleUI();
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }
}
