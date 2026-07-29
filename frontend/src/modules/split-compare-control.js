// ===========================================================================
// split-compare-control.js
// ---------------------------------------------------------------------------
// Split Compare View — a right-rail toggle that puts a second, independent
// mapboxgl.Map instance on the right half of the viewport and lets the user
// pick any temporal layer (from the shared ncop_menu_items registry) to load
// into it.  A draggable divider between the panes controls the split ratio;
// panning/zooming the primary map moves the second map identically (one-way,
// rAF-throttled), while each pane keeps its own time step so users can compare
// two different snapshots of the same layer, or two different layers, at the
// same geography.
//
// EVERY external dependency is read-only:
//
//   - window.ncop_menu_items           — enumerate available temporal keys
//   - window[itemKey]                  — resolve a layer's step array
//   - window.getCurrentTemporalState   — auto-preselect the active Layer A
//   - #playPauseButton1 / #playPauseButton2 / #speedControlButton
//                                      — observed to mirror play/pause/speed
//                                        onto Slider B in real time
//
// This module never mutates temporal-controls.js, sourcelayer-control.js,
// map-layers.js, or the primary map's active layers/style.  On teardown it
// disposes the entire second map instance (`.remove()`), disconnects every
// observer/listener, and removes every DOM node it created — so a full cycle
// activate → deactivate leaves the app in the exact state it started in.
// ===========================================================================

import mapboxgl from "mapbox-gl";
import { legends } from "./temporal-layer-legends";

const BTN_ID       = "splitCompareToggle";
const OVERLAY_ID   = "splitCompareOverlay";
const INNER_ID     = "splitCompareInner";
const DIVIDER_ID   = "splitCompareDivider";
const PANEL_ID     = "splitComparePanel";
const SLIDER2_ID   = "temp-slider2";
const CLONED_LAYER_PREFIX  = "sc2_";       // second-map cloned boundary ids
const CLONED_SOURCE_PREFIX = "sc2src_";    // second-map cloned source ids

// Split range — never let either pane collapse fully.
const SPLIT_MIN = 15;
const SPLIT_MAX = 85;

// Boundary/reference sources on the primary map worth mirroring onto the
// second so the right pane isn't a bare basemap.  Any missing source is
// silently skipped.
const BOUNDARY_SOURCE_IDS = [
  "national_boundary-source",
  "provincial_boundary-source",
  "district_boundary-source",
];

// Speed levels — mirror the primary slider's constant so the "1x / 2x / 3x"
// text on Slider B stays visually aligned with A.  Only used to translate
// the A-slider's speed-button label into a step-interval delay for B.
const SPEED_TO_MS = { "0.5x": 2000, "1x": 1000, "2x": 500, "3x": 333 };
const DEFAULT_SPEED_MS = 1000;

export default class SplitCompareControl {
  #map = null;
  #btnEl = null;
  #state = {
    active: false,
    map2: null,
    overlay: null,
    inner: null,
    divider: null,
    panel: null,
    slider: null,               // Slider B DOM root
    splitPct: 50,
    layerBKey: null,
    layerBLabel: "",
    layerBSteps: null,
    layerBIndex: 0,
    focusLngLat: null,
    resizeObs: null,
    playObs: null,              // MutationObserver on primary playPauseButton1.style
    speedObs: null,             // MutationObserver on primary speed button text
    boundOnResize: null,
    boundOnPrimaryMove: null,
    boundOnDividerDown: null,
    boundOnDividerMove: null,
    boundOnDividerUp: null,
    rafHandle: null,
    // Slider B animation state
    sliderBInterval: null,
    sliderBSpeedMs: DEFAULT_SPEED_MS,
    sliderBIsPlaying: false,
  };

  constructor(map) {
    this.#map = map;
    this.#renderButton();
    this.#wireToggle();
  }

  // -------------------------------------------------------- Rail button
  #renderButton() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    const wrapper = document.createElement("div");
    wrapper.className = "custom-split-compare-control";
    wrapper.innerHTML = `
      <button id="${BTN_ID}" class="custom-split-compare-btn" type="button"
              title="Split Compare View — compare two temporal layers side by side">
        <i data-lucide="columns-2"></i>
      </button>
    `;
    mapContainer.appendChild(wrapper);
    this.#btnEl = wrapper.querySelector(`#${BTN_ID}`);
    try { window.lucide?.createIcons(); } catch (_) {}
  }

  #wireToggle() {
    if (!this.#btnEl) return;
    this.#btnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle();
    });
  }

  toggle() {
    if (this.#state.active) this.deactivate();
    else this.activate();
  }

  // ============================================================ ACTIVATE
  activate() {
    if (this.#state.active || !this.#map) return;
    this.#state.active = true;
    this.#btnEl?.classList.add("active-split-compare");

    // Add a body-scoped class so CSS can reposition the primary slider,
    // hide the NCOP header card, etc. — all cleanly reverted on deactivate.
    document.body.classList.add("split-compare-active");

    this.#state.focusLngLat = this.#map.getCenter();

    this.#buildOverlayAndDivider();
    this.#buildLayerBPicker();
    this.#buildSliderB();
    this.#applySplit(this.#state.splitPct);

    // ------------------ Second Mapbox instance ------------------
    // Use a plain style URL rather than the primary map's serialised
    // style object.  Passing the serialised object has been observed
    // to fail silently when the primary style has token-scoped sprites
    // or the sprite URL can't be re-resolved for the second instance;
    // "mapbox://styles/mapbox/streets-v12" matches how the primary map
    // is originally created (see dashboard.js) and always resolves.
    this.#state.map2 = new mapboxgl.Map({
      container:   this.#state.inner,
      style:       "mapbox://styles/mapbox/streets-v12",
      center:      this.#map.getCenter(),
      zoom:        this.#map.getZoom(),
      bearing:     this.#map.getBearing(),
      pitch:       this.#map.getPitch(),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
    });

    // Force one resize on the next tick — Mapbox measures its container
    // at construction, and if the DOM was flushed between our append
    // and the constructor call it can end up with 0x0.  Explicit
    // .resize() after the style has parsed lines up the WebGL canvas
    // to the actual DOM dimensions.
    this.#state.map2.once("style.load", () => {
      try { this.#state.map2.resize(); }          catch (_) {}
      try { this.#cloneBoundaryLayersOntoMap2(); } catch (e) { console.warn("[split-compare] boundary clone failed:", e); }
      try { this.#syncCameraNow(); }              catch (_) {}
      if (this.#state.layerBKey) {
        try { this.#loadLayerBOntoMap2(this.#state.layerBKey); } catch (_) {}
      }
    });

    // ------------------ Camera sync ------------------
    this.#state.boundOnPrimaryMove = () => this.#scheduleCameraSync();
    this.#map.on("move", this.#state.boundOnPrimaryMove);

    if (typeof ResizeObserver !== "undefined") {
      this.#state.resizeObs = new ResizeObserver(() => this.#onContainerResize());
      const mc = document.getElementById("map");
      if (mc) this.#state.resizeObs.observe(mc);
    }
    this.#state.boundOnResize = () => this.#onContainerResize();
    window.addEventListener("resize", this.#state.boundOnResize);

    // ------------------ Play/pause + speed sync ------------------
    this.#installPrimaryPlayPauseObserver();
    this.#installPrimarySpeedObserver();

    // ------------------ Auto-select the layer already active on A ------------------
    try {
      const cur = window.getCurrentTemporalState && window.getCurrentTemporalState();
      if (cur && cur.layerKey) {
        const select = this.#state.panel?.querySelector("select");
        if (select) select.value = cur.layerKey;
      }
    } catch (_) {}

    // Kick a window resize AFTER the DOM has settled with the new
    // `.split-compare-active` class + Slider A's 50% width override.
    // _recomputeDateInset() (temporal-controls.js) is bound to
    // `window.resize` and recalculates `--date-inset` +
    // `--ts-label-font-size` on #temp-slider1 from the CURRENT panel
    // width — without this dispatch, the previously-cached wide-layout
    // values leak in and push year-labels/ticks out of view.
    requestAnimationFrame(() => {
      try { window.dispatchEvent(new Event("resize")); } catch (_) {}
    });
  }

  // ============================================================ DEACTIVATE
  deactivate() {
    if (!this.#state.active) return;
    this.#state.active = false;
    this.#btnEl?.classList.remove("active-split-compare");
    document.body.classList.remove("split-compare-active");

    // Stop Slider B playback + observers first so nothing fires mid-teardown.
    this.#stopSliderBPlayback();
    if (this.#state.playObs)  { try { this.#state.playObs.disconnect(); }  catch (_) {} this.#state.playObs  = null; }
    if (this.#state.speedObs) { try { this.#state.speedObs.disconnect(); } catch (_) {} this.#state.speedObs = null; }

    if (this.#state.rafHandle != null) {
      try { cancelAnimationFrame(this.#state.rafHandle); } catch (_) {}
      this.#state.rafHandle = null;
    }

    if (this.#map && this.#state.boundOnPrimaryMove) {
      try { this.#map.off("move", this.#state.boundOnPrimaryMove); } catch (_) {}
    }
    this.#state.boundOnPrimaryMove = null;

    if (this.#state.resizeObs)     { try { this.#state.resizeObs.disconnect(); } catch (_) {} this.#state.resizeObs = null; }
    if (this.#state.boundOnResize) { try { window.removeEventListener("resize", this.#state.boundOnResize); } catch (_) {} this.#state.boundOnResize = null; }

    if (this.#state.boundOnDividerMove) {
      try { window.removeEventListener("mousemove", this.#state.boundOnDividerMove); } catch (_) {}
      try { window.removeEventListener("touchmove", this.#state.boundOnDividerMove); } catch (_) {}
    }
    if (this.#state.boundOnDividerUp) {
      try { window.removeEventListener("mouseup",  this.#state.boundOnDividerUp); } catch (_) {}
      try { window.removeEventListener("touchend", this.#state.boundOnDividerUp); } catch (_) {}
    }
    this.#state.boundOnDividerMove = null;
    this.#state.boundOnDividerUp   = null;

    if (this.#state.map2) {
      try { this.#state.map2.remove(); } catch (_) {}
      this.#state.map2 = null;
    }

    [this.#state.overlay, this.#state.divider, this.#state.panel, this.#state.slider].forEach((el) => {
      if (el && el.parentElement) el.parentElement.removeChild(el);
    });
    this.#state.overlay = null;
    this.#state.inner   = null;
    this.#state.divider = null;
    this.#state.panel   = null;
    this.#state.slider  = null;

    this.#state.splitPct     = 50;
    this.#state.layerBKey    = null;
    this.#state.layerBLabel  = "";
    this.#state.layerBSteps  = null;
    this.#state.layerBIndex  = 0;
    this.#state.focusLngLat  = null;
    this.#state.sliderBIsPlaying = false;
    this.#state.sliderBSpeedMs   = DEFAULT_SPEED_MS;

    // Snap Slider A back to its normal full-width layout — same reason
    // as the resize dispatch in activate(), just in reverse: without
    // this, --date-inset/--ts-label-font-size stay locked at the
    // 50%-width values calculated during compare mode.
    requestAnimationFrame(() => {
      try { window.dispatchEvent(new Event("resize")); } catch (_) {}
    });
  }

  // =================================================================
  //  Split-view DOM (overlay + inner + divider)
  // =================================================================
  #buildOverlayAndDivider() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "split-compare-overlay";
    mapContainer.appendChild(overlay);
    this.#state.overlay = overlay;

    const inner = document.createElement("div");
    inner.id = INNER_ID;
    inner.className = "split-compare-inner";
    overlay.appendChild(inner);
    this.#state.inner = inner;

    const divider = document.createElement("div");
    divider.id = DIVIDER_ID;
    divider.className = "split-compare-divider";
    divider.innerHTML = `<div class="split-compare-divider__grip" aria-label="Drag to resize"></div>`;
    overlay.appendChild(divider);
    this.#state.divider = divider;

    const onDown = (ev) => {
      ev.preventDefault();
      document.body.style.userSelect = "none";
      document.body.style.cursor     = "ew-resize";
      this.#state.boundOnDividerMove = (mv) => this.#onDividerMove(mv);
      this.#state.boundOnDividerUp   = () => this.#onDividerUp();
      window.addEventListener("mousemove", this.#state.boundOnDividerMove);
      window.addEventListener("mouseup",   this.#state.boundOnDividerUp);
      window.addEventListener("touchmove", this.#state.boundOnDividerMove, { passive: false });
      window.addEventListener("touchend",  this.#state.boundOnDividerUp);
    };
    divider.addEventListener("mousedown",  onDown);
    divider.addEventListener("touchstart", onDown, { passive: false });
  }

  #onDividerMove(ev) {
    const mc = document.getElementById("map");
    if (!mc) return;
    const rect = mc.getBoundingClientRect();
    const x = (ev.touches && ev.touches[0]) ? ev.touches[0].clientX : ev.clientX;
    let pct = ((x - rect.left) / rect.width) * 100;
    if (pct < SPLIT_MIN) pct = SPLIT_MIN;
    if (pct > SPLIT_MAX) pct = SPLIT_MAX;
    this.#applySplit(pct);
    this.#scheduleCameraSync();
  }

  #onDividerUp() {
    document.body.style.userSelect = "";
    document.body.style.cursor     = "";
    if (this.#state.boundOnDividerMove) {
      try { window.removeEventListener("mousemove", this.#state.boundOnDividerMove); } catch (_) {}
      try { window.removeEventListener("touchmove", this.#state.boundOnDividerMove); } catch (_) {}
    }
    if (this.#state.boundOnDividerUp) {
      try { window.removeEventListener("mouseup",  this.#state.boundOnDividerUp); } catch (_) {}
      try { window.removeEventListener("touchend", this.#state.boundOnDividerUp); } catch (_) {}
    }
    this.#state.boundOnDividerMove = null;
    this.#state.boundOnDividerUp   = null;
    if (this.#state.map2) { try { this.#state.map2.resize(); } catch (_) {} }
    this.#syncCameraNow();
  }

  #applySplit(pct) {
    this.#state.splitPct = pct;
    if (this.#state.inner) {
      this.#state.inner.style.clipPath        = `inset(0 0 0 ${pct}%)`;
      this.#state.inner.style.webkitClipPath  = `inset(0 0 0 ${pct}%)`;
    }
    if (this.#state.divider) this.#state.divider.style.left = `${pct}%`;
  }

  // =================================================================
  //  Camera sync — primary → secondary, one-way, offset-per-pane
  // =================================================================
  #scheduleCameraSync() {
    if (!this.#state.active || this.#state.rafHandle != null) return;
    this.#state.rafHandle = requestAnimationFrame(() => {
      this.#state.rafHandle = null;
      this.#syncCameraNow();
    });
  }

  #syncCameraNow() {
    if (!this.#state.active || !this.#state.map2 || !this.#map) return;
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;
    const rect = mapContainer.getBoundingClientRect();
    const w = rect.width;
    if (!w) return;

    const pct = this.#state.splitPct;
    const focus = this.#map.unproject([(pct / 200) * w, rect.height / 2]);
    this.#state.focusLngLat = focus;

    const primary = this.#map;
    const map2    = this.#state.map2;
    const primaryOffsetX = ((pct / 2)         / 100 - 0.5) * w;
    const map2OffsetX    = (((100 + pct) / 2) / 100 - 0.5) * w;
    const deltaX = map2OffsetX - primaryOffsetX;

    try {
      map2.jumpTo({
        center:  primary.getCenter(),
        zoom:    primary.getZoom(),
        bearing: primary.getBearing(),
        pitch:   primary.getPitch(),
      });
      map2.easeTo({
        center:   primary.getCenter(),
        offset:   [deltaX, 0],
        duration: 0,
        animate:  false,
      });
    } catch (_) {}
  }

  // =================================================================
  //  Boundary cloning onto map2
  // =================================================================
  #cloneBoundaryLayersOntoMap2() {
    const map2 = this.#state.map2;
    if (!map2) return;
    const primaryStyle = this.#map.getStyle();
    if (!primaryStyle) return;
    for (const srcId of BOUNDARY_SOURCE_IDS) {
      const src = this.#map.getSource(srcId);
      if (!src) continue;
      const cfg = this.#serialiseSource(src);
      if (!cfg) continue;
      const cloneSrcId = CLONED_SOURCE_PREFIX + srcId;
      if (!map2.getSource(cloneSrcId)) {
        try { map2.addSource(cloneSrcId, cfg); } catch (_) { continue; }
      }
      for (const layer of primaryStyle.layers || []) {
        if (layer.source !== srcId) continue;
        const cloneLayerId = CLONED_LAYER_PREFIX + layer.id;
        if (map2.getLayer(cloneLayerId)) continue;
        const cloned = JSON.parse(JSON.stringify(layer));
        cloned.id     = cloneLayerId;
        cloned.source = cloneSrcId;
        cloned.layout = { ...(cloned.layout || {}), visibility: "visible" };
        try { map2.addLayer(cloned); } catch (_) {}
      }
    }
  }

  #serialiseSource(src) {
    try {
      if (src.type === "vector") {
        const cfg = { type: "vector" };
        if (src.tiles)   cfg.tiles   = [...src.tiles];
        if (src.url)     cfg.url     = src.url;
        if (src.scheme)  cfg.scheme  = src.scheme;
        if (src.minzoom != null) cfg.minzoom = src.minzoom;
        if (src.maxzoom != null) cfg.maxzoom = src.maxzoom;
        return cfg;
      }
      if (src.type === "geojson") {
        const data = src._data || (src.serialize ? src.serialize().data : undefined);
        return { type: "geojson", data: data || { type: "FeatureCollection", features: [] } };
      }
    } catch (_) {}
    return null;
  }

  #raiseBoundaryClonesAbove() {
    const map2 = this.#state.map2;
    if (!map2) return;
    const style = map2.getStyle();
    if (!style) return;
    for (const l of style.layers) {
      if (l.id.startsWith(CLONED_LAYER_PREFIX)) {
        try { map2.moveLayer(l.id); } catch (_) {}
      }
    }
  }

  // =================================================================
  //  Layer-B picker panel (bottom-center)
  // =================================================================
  #buildLayerBPicker() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "split-compare-panel split-compare-panel--bottom";
    panel.innerHTML = `
      <div class="split-compare-panel__row">
        <span class="split-compare-panel__title">Compare Layer (Map B)</span>
        <select class="split-compare-panel__select" aria-label="Layer B"></select>
        <button class="split-compare-panel__close" type="button" title="Close split view" aria-label="Close split view">✕</button>
      </div>
    `;
    mapContainer.appendChild(panel);
    this.#state.panel = panel;

    const select = panel.querySelector("select");
    const sentinel = document.createElement("option");
    sentinel.value = "";
    sentinel.textContent = "— pick a layer —";
    select.appendChild(sentinel);

    // Build <optgroup>s that mirror the sidebar's category → subcategory
    // structure so the dropdown reads the way the sidebar reads:
    //   optgroup label = subcategoryKey (already human-readable, e.g.
    //   "Radar Layers", "Global Deterministic Prediction System (GDPS)")
    //   options = every temporal item under that subcategory
    // Falls back to a flat list if enumeration returns nothing grouped.
    const groups = this.#enumerateGroupedTemporalKeys();
    for (const group of groups) {
      const og = document.createElement("optgroup");
      og.label = group.label;
      for (const opt of group.items) {
        const el = document.createElement("option");
        el.value = opt.key;
        el.textContent = opt.label;
        el.dataset.label = opt.label;
        og.appendChild(el);
      }
      select.appendChild(og);
    }
    select.value = "";

    select.addEventListener("change", () => {
      const key = select.value;
      if (!key) return;
      this.#state.layerBKey = key;
      const chosen = select.options[select.selectedIndex];
      this.#state.layerBLabel = chosen?.dataset?.label || chosen?.textContent || key;
      this.#loadLayerBOntoMap2(key);
    });

    panel.querySelector(".split-compare-panel__close").addEventListener("click", () => this.deactivate());
  }

  #enumerateTemporalKeys() {
    const menu = window.ncop_menu_items;
    const out = [];
    if (!menu || typeof menu !== "object") return out;
    for (const catKey of Object.keys(menu)) {
      const cat = menu[catKey];
      if (!cat) continue;
      for (const subKey of Object.keys(cat)) {
        const sub = cat[subKey];
        if (!sub || !sub.temporal) continue;
        for (const itemKey of Object.keys(sub.temporal)) {
          const it = sub.temporal[itemKey];
          if (!it || it.hidden === true) continue;
          out.push({ key: itemKey, label: it.label || itemKey, group: subKey });
        }
      }
    }
    return out;
  }

  // Grouped variant used by the compare panel dropdown.  Returns
  // [{ label: subKey, items: [{key,label}, ...] }, ...] preserving
  // the sidebar's declared order (categories → subcategories → items).
  #enumerateGroupedTemporalKeys() {
    const menu = window.ncop_menu_items;
    const groups = [];
    if (!menu || typeof menu !== "object") return groups;
    for (const catKey of Object.keys(menu)) {
      const cat = menu[catKey];
      if (!cat) continue;
      for (const subKey of Object.keys(cat)) {
        const sub = cat[subKey];
        if (!sub || !sub.temporal) continue;
        const items = [];
        for (const itemKey of Object.keys(sub.temporal)) {
          const it = sub.temporal[itemKey];
          if (!it || it.hidden === true) continue;
          items.push({ key: itemKey, label: it.label || itemKey });
        }
        if (items.length) groups.push({ label: subKey, items });
      }
    }
    return groups;
  }

  // =================================================================
  //  Slider B — full replica of #temp-slider1 HTML shape
  // =================================================================
  #buildSliderB() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;
    const slider = document.createElement("div");
    slider.id = SLIDER2_ID;
    slider.className = "sc-temp-slider-b";
    slider.innerHTML = `
      <div class="tempslider-layout">
        <!-- Row 1: transport | timeline | drag -->
        <div class="ts-row ts-row--timeline">
          <div id="tempslider-controls-b" class="ts-panel ts-panel--transport">
            <button id="playPauseButton1_b" title="Play/Pause animation" style="display:inline-block;">
              <i data-lucide="play"></i>
            </button>
            <button id="playPauseButton2_b" title="Play/Pause animation" style="display:none;">
              <i data-lucide="pause"></i>
            </button>
            <button id="speedControlButton_b" class="speed-btn" title="Speed (synced with Map A)">1x</button>
          </div>
          <div class="ts-panel ts-panel--timeline ts-timeline" style="--date-inset: 67px;">
            <div class="year-labels1 sc-year-labels-b"></div>
            <div class="ts-slider-track">
              <input type="range" min="0" step="1" value="0" max="0"
                     class="slider1 sc-slider-b" id="slider1_b"
                     title="Drag to change time step">
            </div>
          </div>
          <button id="dragControlButton_b" class="ts-panel ts-panel--drag ts-corner-btn" title="Drag slider" disabled>
            <i data-lucide="move"></i>
          </button>
        </div>
        <!-- Row 2: variable | legend | opacity -->
        <div class="ts-row ts-row--legend">
          <div class="ts-panel ts-panel--variable">
            <button id="tempsliderRemoveButton_b" class="ts-variable-icon" type="button" title="Remove Layer B" aria-label="Remove Layer B">
              <i data-lucide="trash-2"></i>
            </button>
            <div class="ts-variable">
              <p class="sc-slider-b-title">Layer B</p>
            </div>
          </div>
          <div class="ts-panel ts-panel--legend">
            <!-- id mirrors #legend-container-slider1 (with _b suffix) so
                 the shared .ts-legend-stack / .ts-legend-bar /
                 .ts-legend-values styles from _temporal.css cascade
                 naturally to the injected legend HTML. -->
            <div id="legend-container-slider1_b" class="sc-slider-b-legend" style="display:none;"></div>
          </div>
          <button id="opacityControlButton_b" class="ts-panel ts-panel--opacity" title="Opacity" disabled>
            <i data-lucide="blend"></i>
          </button>
        </div>
      </div>
    `;
    mapContainer.appendChild(slider);
    this.#state.slider = slider;

    try { window.lucide?.createIcons(); } catch (_) {}

    // Wire slider range → step Layer B
    const range = slider.querySelector("#slider1_b");
    range.addEventListener("input", () => {
      const idx = Number(range.value) || 0;
      this.#stepLayerBTo(idx);
    });

    // Wire play/pause on Slider B — mirror the click onto Slider A so the
    // sync flows through the primary observer (single source of truth).
    slider.querySelector("#playPauseButton1_b").addEventListener("click", () => {
      const primaryPlay = document.getElementById("playPauseButton1");
      if (primaryPlay && primaryPlay.style.display !== "none") primaryPlay.click();
    });
    slider.querySelector("#playPauseButton2_b").addEventListener("click", () => {
      const primaryPause = document.getElementById("playPauseButton2");
      if (primaryPause && primaryPause.style.display !== "none") primaryPause.click();
    });

    // Speed button on Slider B — mirror the click onto Slider A so both cycle together.
    slider.querySelector("#speedControlButton_b").addEventListener("click", () => {
      const primarySpeed = document.getElementById("speedControlButton");
      if (primarySpeed) primarySpeed.click();
    });

    // Remove (trash) button on Slider B — clear the layer from map2 only.
    slider.querySelector("#tempsliderRemoveButton_b").addEventListener("click", () => {
      this.#unloadLayerBFromMap2();
      this.#state.layerBKey = null;
      this.#state.layerBLabel = "";
      this.#refreshSliderBLabels();
      const sel = this.#state.panel?.querySelector("select");
      if (sel) sel.value = "";
      const titleEl = slider.querySelector(".sc-slider-b-title");
      if (titleEl) titleEl.textContent = "Layer B";
      // Hide the legend that was populated for the previous layer.
      const legEl = document.getElementById("legend-container-slider1_b");
      if (legEl) { legEl.innerHTML = ""; legEl.style.display = "none"; }
    });

    // Year-label click → jump to that step
    slider.querySelector(".sc-year-labels-b").addEventListener("click", (e) => {
      const span = e.target.closest("span[data-step]");
      if (!span) return;
      const idx = Number(span.dataset.step) || 0;
      this.#stepLayerBTo(idx);
    });
  }

  // =================================================================
  //  Play/pause sync via MutationObserver on #playPauseButton1
  // =================================================================
  #installPrimaryPlayPauseObserver() {
    const playBtn = document.getElementById("playPauseButton1");
    if (!playBtn) return;
    const readState = () => {
      // When #playPauseButton1 is HIDDEN, primary is playing.
      const isPlaying = window.getComputedStyle(playBtn).display === "none";
      if (isPlaying) this.#startSliderBPlayback();
      else           this.#stopSliderBPlayback();
    };
    this.#state.playObs = new MutationObserver(readState);
    this.#state.playObs.observe(playBtn, { attributes: true, attributeFilter: ["style", "class"] });
    // Also read the current state right away in case A is already playing
    // when compare is toggled on.
    readState();
  }

  #installPrimarySpeedObserver() {
    const speedBtn = document.getElementById("speedControlButton");
    if (!speedBtn) return;
    const readSpeed = () => {
      const label = (speedBtn.textContent || "1x").trim();
      const bLabel = this.#state.slider?.querySelector("#speedControlButton_b");
      if (bLabel) bLabel.textContent = label;
      this.#state.sliderBSpeedMs = SPEED_TO_MS[label] || DEFAULT_SPEED_MS;
      // If Slider B is currently playing, restart its interval at the new speed.
      if (this.#state.sliderBIsPlaying) {
        this.#stopSliderBPlayback();
        this.#startSliderBPlayback();
      }
    };
    this.#state.speedObs = new MutationObserver(readSpeed);
    this.#state.speedObs.observe(speedBtn, { childList: true, characterData: true, subtree: true });
    readSpeed();
  }

  #startSliderBPlayback() {
    if (this.#state.sliderBIsPlaying) return;
    this.#state.sliderBIsPlaying = true;
    // Update Slider B's play/pause button icons to reflect "playing".
    const playEl  = this.#state.slider?.querySelector("#playPauseButton1_b");
    const pauseEl = this.#state.slider?.querySelector("#playPauseButton2_b");
    if (playEl)  playEl.style.display  = "none";
    if (pauseEl) pauseEl.style.display = "inline-block";

    const step = () => {
      const steps = this.#state.layerBSteps;
      if (!Array.isArray(steps) || steps.length === 0) return;
      const next = (this.#state.layerBIndex + 1) % steps.length;
      this.#stepLayerBTo(next);
    };
    if (this.#state.sliderBInterval) clearInterval(this.#state.sliderBInterval);
    this.#state.sliderBInterval = setInterval(step, this.#state.sliderBSpeedMs);
  }

  #stopSliderBPlayback() {
    this.#state.sliderBIsPlaying = false;
    if (this.#state.sliderBInterval) {
      clearInterval(this.#state.sliderBInterval);
      this.#state.sliderBInterval = null;
    }
    const playEl  = this.#state.slider?.querySelector("#playPauseButton1_b");
    const pauseEl = this.#state.slider?.querySelector("#playPauseButton2_b");
    if (playEl)  playEl.style.display  = "inline-block";
    if (pauseEl) pauseEl.style.display = "none";
  }

  // =================================================================
  //  Load Layer B onto map2 + populate Slider B labels
  // =================================================================
  async #loadLayerBOntoMap2(itemKey) {
    const map2 = this.#state.map2;
    if (!map2) {
      console.warn(`[split-compare] loadLayerB(${itemKey}): map2 not initialised yet`);
      return;
    }
    if (!map2.isStyleLoaded()) {
      map2.once("style.load", () => this.#loadLayerBOntoMap2(itemKey));
      return;
    }
    this.#unloadLayerBFromMap2();

    // Resolve `window[itemKey]` → step array.
    //   * Array<entry>           — pre-baked frames (most layers)
    //   * () => Array | Promise  — descriptor-driven, lazy (RainViewer etc.)
    //   * Promise<Array<entry>>  — already in flight
    // These are the SAME three shapes accepted by the primary loader in
    // mapbox-functions.js:handleTemporalLayerToggle, so behaviour is
    // consistent between the sidebar (Map A) and the compare panel (Map B).
    let src = window[itemKey];
    if (src == null) {
      console.warn(`[split-compare] loadLayerB(${itemKey}): window["${itemKey}"] is undefined — layer builder never populated this key.`);
      return;
    }
    if (typeof src === "function") {
      try { src = src(); }
      catch (e) {
        console.error(`[split-compare] loadLayerB(${itemKey}): builder threw`, e);
        return;
      }
    }
    if (src && typeof src.then === "function") {
      try { src = await src; }
      catch (e) {
        console.error(`[split-compare] loadLayerB(${itemKey}): promise rejected`, e);
        return;
      }
    }
    if (!Array.isArray(src) || src.length === 0) {
      console.warn(`[split-compare] loadLayerB(${itemKey}): resolved to empty/non-array`, src);
      return;
    }

    // Deep-clone the ENTIRE step array before adding to map2.  The primary
    // map has already registered these source/layer objects and Mapbox
    // mutates them internally (attaches owner map ref, cached _data, etc.).
    // Passing the mutated originals to map2 causes silent failures where
    // addSource/addLayer succeed but tiles never render — cloning gives
    // map2 its own private copy that Mapbox can safely mutate.
    const steps = src.map((e) => JSON.parse(JSON.stringify(e)));

    this.#state.layerBSteps = steps;
    this.#state.layerBIndex = 0;

    let addedCount = 0;
    steps.forEach((entry, idx) => {
      const initialOpacity = idx === 0 ? 0.7 : 0;
      if (entry.sources) entry.sources.forEach((s) => this.#safeAddSource(map2, s));
      else if (entry.source) this.#safeAddSource(map2, entry.source);
      (entry.layers || []).forEach((layerDef) => {
        if (this.#safeAddLayerWithOpacity(map2, layerDef, initialOpacity)) addedCount++;
      });
    });

    if (addedCount === 0) {
      console.warn(`[split-compare] loadLayerB(${itemKey}): no layers were successfully added to map2`);
    }

    // Refresh slider label + title, then jump to step 0
    const titleEl = this.#state.slider?.querySelector(".sc-slider-b-title");
    if (titleEl) titleEl.textContent = this.#state.layerBLabel || "Layer B";
    this.#refreshSliderBLabels();
    this.#stepLayerBTo(0);
    this.#populateSliderBLegend(itemKey);
    this.#raiseBoundaryClonesAbove();
  }

  // Mirror how temporal-controls.js populates #legend-container-slider1:
  // look up the layer key in the `legends` dictionary (imported at the
  // top of this file) and drop its raw HTML into Slider B's legend
  // container.  The injected markup uses the same class-scoped styles
  // (.ts-legend-stack / .ts-legend-bar / .ts-legend-values) so no extra
  // CSS is needed.
  #populateSliderBLegend(itemKey) {
    const el = document.getElementById("legend-container-slider1_b");
    if (!el) return;
    if (typeof legends !== "undefined" && legends[itemKey]) {
      el.innerHTML = legends[itemKey];
      el.style.display = "block";
    } else {
      el.innerHTML = "";
      el.style.display = "none";
    }
  }

  #safeAddSource(map, srcDef) {
    if (!srcDef || !srcDef.id) return false;
    if (map.getSource(srcDef.id)) return true;   // already present is fine
    // Strip `id` from the config before handing to Mapbox — id is passed
    // as the first arg, and some Mapbox validators complain about the
    // extra field on strict source configs.
    const { id, ...cfg } = srcDef;
    try {
      map.addSource(id, cfg);
      return true;
    } catch (e) {
      console.error(`[split-compare] addSource("${id}") failed:`, e);
      return false;
    }
  }

  #safeAddLayerWithOpacity(map, layerDef, opacity) {
    if (!layerDef || !layerDef.id) return false;
    if (map.getLayer(layerDef.id)) return true;
    // layerDef is already a fresh clone (loadLayerBOntoMap2 deep-clones
    // the entire step array), so we can mutate it directly.
    const cfg = layerDef;
    const opProp = this.#opacityPropFor(cfg.type);
    if (opProp) cfg.paint = { ...(cfg.paint || {}), [opProp]: opacity };
    cfg.layout = { ...(cfg.layout || {}), visibility: "visible" };
    try {
      map.addLayer(cfg);
      return true;
    } catch (e) {
      console.error(`[split-compare] addLayer("${cfg.id}") failed:`, e);
      return false;
    }
  }

  #opacityPropFor(type) {
    switch (type) {
      case "raster": return "raster-opacity";
      case "fill":   return "fill-opacity";
      case "line":   return "line-opacity";
      case "circle": return "circle-opacity";
      case "symbol": return "icon-opacity";
      default:       return null;
    }
  }

  #unloadLayerBFromMap2() {
    const map2 = this.#state.map2;
    const prev = this.#state.layerBSteps;
    if (!map2 || !prev) return;
    for (const entry of prev) {
      (entry.layers || []).forEach((l) => { if (map2.getLayer(l.id)) { try { map2.removeLayer(l.id); } catch (_) {} } });
      if (entry.sources) entry.sources.forEach((s) => { if (map2.getSource(s.id)) { try { map2.removeSource(s.id); } catch (_) {} } });
      else if (entry.source && map2.getSource(entry.source.id)) { try { map2.removeSource(entry.source.id); } catch (_) {} }
    }
    this.#state.layerBSteps = null;
    this.#state.layerBIndex = 0;
  }

  // =================================================================
  //  Slider B labels + step
  // =================================================================
  #refreshSliderBLabels() {
    const slider = this.#state.slider;
    const steps  = this.#state.layerBSteps;
    if (!slider) return;
    const range = slider.querySelector("#slider1_b");
    const labelsEl = slider.querySelector(".sc-year-labels-b");
    if (!Array.isArray(steps) || steps.length === 0) {
      range.min = 0; range.max = 0; range.value = 0;
      labelsEl.innerHTML = "";
      return;
    }
    range.min = "0";
    range.max = String(steps.length - 1);
    range.value = "0";
    const frag = document.createDocumentFragment();
    const n = steps.length;
    steps.forEach((entry, i) => {
      const span = document.createElement("span");
      // Preserve an intentional empty date string ("") — loaders that thin
      // their slider labels (e.g. PMD Forecast via _pmdPickLabelIndices)
      // rely on empty spans collapsing through the `span:empty` CSS rule.
      // The `|| \`Step N\`` fallback would defeat that by filling every
      // span; only fall back when `date` is genuinely missing.
      const d = entry?.date;
      span.textContent = (d === undefined || d === null) ? `Step ${i + 1}` : String(d);
      span.style.left  = n === 1 ? "0%" : `${(i / (n - 1)) * 100}%`;
      span.dataset.step = String(i);
      span.setAttribute("aria-current", i === 0 ? "true" : "false");
      if (i === 0) span.classList.add("is-active");
      frag.appendChild(span);
    });
    labelsEl.innerHTML = "";
    labelsEl.appendChild(frag);
    // Auto-scale font size to fit the narrower split-compare panel.
    // Runs after layout so getBoundingClientRect() reflects real widths.
    requestAnimationFrame(() => this.#recomputeSliderBFontSize());
  }

  // Mirrors _recomputeDateInset in temporal-controls.js but scoped to the
  // Layer-B labels strip.  Counts ONLY spans with real text (empty ones
  // collapse via CSS) so a thinned-label layer gets accurate slot budget.
  // Same MIN_FONT (8px) / MAX_FONT (12px) clamp as Map A for visual parity.
  #recomputeSliderBFontSize() {
    const labels = this.#state.slider?.querySelector(".sc-year-labels-b");
    if (!labels) return;
    const spans = labels.querySelectorAll("span");
    if (!spans.length) return;

    // Reset any previously-set override so we measure at stylesheet baseline.
    labels.style.removeProperty("--ts-label-font-size");
    void labels.offsetWidth;

    let maxWidth = 0;
    let visibleN = 0;
    spans.forEach((s) => {
      if (!s.textContent) return;
      visibleN += 1;
      const w = s.getBoundingClientRect().width;
      if (w > maxWidth) maxWidth = w;
    });
    if (!maxWidth || visibleN < 2) return;

    const containerWidth = labels.clientWidth || 0;
    const slotWidth = containerWidth / (visibleN - 1);
    const GAP = 4;
    const MIN_FONT = 8;
    const MAX_FONT = 12;
    if (maxWidth + GAP > slotWidth) {
      const scale = slotWidth / (maxWidth + GAP);
      const fontSize = Math.max(MIN_FONT, Math.floor(MAX_FONT * scale));
      labels.style.setProperty("--ts-label-font-size", `${fontSize}px`);
    }
  }

  #stepLayerBTo(idx) {
    const map2  = this.#state.map2;
    const steps = this.#state.layerBSteps;
    if (!map2 || !Array.isArray(steps) || steps.length === 0) return;
    if (idx < 0) idx = 0;
    if (idx >= steps.length) idx = steps.length - 1;
    this.#state.layerBIndex = idx;

    steps.forEach((entry, i) => {
      const opacity = (i === idx) ? 0.7 : 0;
      (entry.layers || []).forEach((layerDef) => {
        if (!map2.getLayer(layerDef.id)) return;
        const opProp = this.#opacityPropFor(layerDef.type);
        if (opProp) { try { map2.setPaintProperty(layerDef.id, opProp, opacity); } catch (_) {} }
      });
    });

    const slider = this.#state.slider;
    if (slider) {
      const range = slider.querySelector("#slider1_b");
      if (range && Number(range.value) !== idx) range.value = String(idx);
      const labels = slider.querySelectorAll(".sc-year-labels-b span");
      labels.forEach((s, i) => {
        s.classList.toggle("is-active", i === idx);
        s.setAttribute("aria-current", i === idx ? "true" : "false");
      });
      // Mirror of the temporal-current-step.js behaviour on Map A: keep a
      // live "current timestep" line inside the Layer B .ts-variable panel
      // in sync with the slider.  Prefers each frame's `dateFull` (always
      // populated on thinned-label layers) and falls back to `date`.  The
      // paragraph is injected once per panel and reused for every step.
      const varPanel = slider.querySelector(".ts-variable");
      if (varPanel) {
        let dateEl = varPanel.querySelector(".ts-current-date");
        if (!dateEl) {
          dateEl = document.createElement("p");
          dateEl.className = "ts-current-date";
          varPanel.appendChild(dateEl);
        }
        const entry = steps[idx];
        const text  = String(entry?.dateFull || entry?.date || "");
        dateEl.textContent = text;
        dateEl.classList.toggle("is-empty", !text);
      }
    }
    this.#raiseBoundaryClonesAbove();
  }

  // =================================================================
  //  Resize propagation
  // =================================================================
  #onContainerResize() {
    if (!this.#state.active) return;
    if (this.#state.map2) { try { this.#state.map2.resize(); } catch (_) {} }
    this.#scheduleCameraSync();
  }
}
