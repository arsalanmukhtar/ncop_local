// time-slider-functionality.js
// Updated to work with DashboardManager's private map instance
// Adds: clean Lucide play/pause toggle with two buttons, and restoration on map 'style.load'.
// ADDED: Drag and Resize functionality
// IMPROVED: Table-based popup with advanced styling and CSS variables
// ENHANCED: HTML escaping, property prioritization, and better value formatting
// OPTIMIZED: Layer/show switching, caching of layer types/opacity props, no-op paint sets skipped
// ADDED: Async temporal loader (updateTempSliderAsync) that waits for map readiness
// ADDED: Temporal Opacity Controller (global factor applied to all temporal layers/steps)

import { legends } from "./temporal-layer-legends";

// ===== GLOBAL VARIABLES =====
let sliderLayers = []; // Array of arrays of layer ids for each timestep
let isPlaying = false;
let interval;
const speedLevels = [0.5, 1, 2, 3];
let currentSpeedIndex = 1;
let currentActiveLayerSet = null;
let clickPopup = null;

// Internal caches for faster ops
const _layerTypeCache = new Map();
const _opacityPropCache = new Map();
const _layerOpacityState = new Map();
const _boundClickLayers = new Set();

// Track current frame for 2-way toggle optimization
let _lastStepIndex = null;

// For restoring after 'style.load'
let _sliderRestore = {
  layerKey: null,
  textContent: null,
  layersDef: null,
  currentIndex: 0,
};
let _styleLoadHandlerBound = false;

// Drag variables
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartLeft = 0;
let dragStartTop = 0;

// === GLOBAL OPACITY FACTOR FOR TEMPORAL LAYERS (NEW) ===
let _opacityFactor = 1; // 1 = 100% (default). Controlled by UI popover.

// Module-level registry of NCOP-owned layer IDs so SourceLayerControl can
// treat temporal / RainViewer layers like its own when computing beforeId.
if (typeof window !== "undefined" && !(window.__ncop_layer_registry instanceof Set)) {
  window.__ncop_layer_registry = new Set();
}
// Separate registry for *temporal* layers only.  Drives the strict z-order
// rule: temporal layers must always sit below every NCOP normal vector
// layer (point/line/polygon).  Without this, queryRenderedFeatures on click
// returns the temporal fill *above* a district polygon, dominating its
// popup (the bug).  computeBeforeId(layerType, { isTemporal:true }) reads
// this set to find the first NCOP non-temporal layer to insert before.
if (typeof window !== "undefined" && !(window.__ncop_temporal_registry instanceof Set)) {
  window.__ncop_temporal_registry = new Set();
}

/**
 * Add a layer to the map while enforcing the NCOP z-order rule
 *   normal vectors > temporal layers > basemap, labels stay on top
 * by deferring to SourceLayerControl.computeBeforeId() with the
 * `isTemporal` flag.  Also records the layer ID in BOTH the shared
 * registry and the temporal-only registry so future computeBeforeId()
 * calls see it as "ours" AND know to keep it below normal vectors.
 */
function _ncopAddLayerInOrder(map, layerCfg) {
  const slc = window.sourceLayerControl;
  let beforeId;
  if (slc && typeof slc.computeBeforeId === "function") {
    try {
      beforeId = slc.computeBeforeId(layerCfg.type, { isTemporal: true });
    } catch {}
  }
  if (beforeId) map.addLayer(layerCfg, beforeId);
  else map.addLayer(layerCfg);
  try {
    window.__ncop_layer_registry?.add(layerCfg.id);
    window.__ncop_temporal_registry?.add(layerCfg.id);
  } catch {}
}

// Recompute the timeline panel's dynamic horizontal padding so first/last
// date pills never spill past the edge. Runs after labels are first inserted
// (via `updateTempSlider`) and again on every window resize so the slider
// stays readable when the dev console opens / closes or the viewport changes.
function _recomputeDateInset() {
  const yearLabelsDiv = document.querySelector("#temp-slider1 .year-labels1");
  if (!yearLabelsDiv) return;
  const panel = yearLabelsDiv.closest(".ts-panel--timeline");
  if (!panel) return;
  const spans = yearLabelsDiv.querySelectorAll("span");
  if (!spans.length) return;

  // Reset any previously-applied font-size override so we measure each label
  // at the stylesheet-default size (12px). That way the next pass starts from
  // a known baseline regardless of viewport changes between runs.
  yearLabelsDiv.style.removeProperty("--ts-label-font-size");

  // Force a synchronous re-style/layout so getBoundingClientRect() reflects
  // the reset font-size we just cleared.
  void yearLabelsDiv.offsetWidth;

  const measure = () => {
    let max = 0;
    spans.forEach((s) => {
      const w = s.getBoundingClientRect().width;
      if (w > max) max = w;
    });
    return max;
  };

  let maxWidth = measure();
  if (!maxWidth) return;

  // Available horizontal space in the labels strip. With N evenly-spaced
  // pills the budget per label is roughly containerWidth / (N - 1) — that's
  // the gap between two adjacent tick centers. If the widest label (plus a
  // small breathing gap) exceeds that budget, two labels will overlap.
  const containerWidth = yearLabelsDiv.clientWidth || 0;
  const n = spans.length;
  if (containerWidth > 0 && n > 1) {
    const slotWidth = containerWidth / (n - 1);
    const GAP = 4;             // px of breathing room between adjacent labels
    const MIN_FONT = 8;        // never shrink below 8px (still legible)
    const MAX_FONT = 12;       // stylesheet baseline

    if (maxWidth + GAP > slotWidth) {
      // Scale the font-size down proportionally to fit. Width ≈ font-size,
      // so scale by (available / required) clamped to [MIN, MAX].
      const scale = slotWidth / (maxWidth + GAP);
      const fontSize = Math.max(MIN_FONT, Math.floor(MAX_FONT * scale));
      yearLabelsDiv.style.setProperty(
        "--ts-label-font-size",
        `${fontSize}px`
      );
      // Re-measure at the new size so the panel inset below uses the
      // *current* widest label (otherwise we'd reserve too much padding).
      void yearLabelsDiv.offsetWidth;
      maxWidth = measure();
    }
  }

  const inset = Math.ceil(maxWidth / 2) + 6;
  panel.style.setProperty("--date-inset", `${inset}px`);
}

// When the viewport changes, recompute the inset AND clear any pinned
// width left by a previous drag, so the slider flexes with the new viewport
// width instead of staying locked to its drag-time size.
if (typeof window !== "undefined" && !window.__ts_resizeBound) {
  window.addEventListener("resize", () => {
    const slider = document.getElementById("temp-slider1");
    if (slider && !isDragging) {
      slider.style.width = "";
      slider.style.right = "";
    }
    requestAnimationFrame(_recomputeDateInset);
  });
  window.__ts_resizeBound = true;
}

// Helper to get the map instance from DashboardManager
function getMap() {
  if (!window.ncop_map) {
    console.error(
      "❌ Map not initialized. Make sure DashboardManager exposed window.ncop_map"
    );
    return null;
  }
  return window.ncop_map;
}

// ===== POPUP FORMATTING UTILITIES =====
const PROPERTY_PRIORITY = {
  event: 1,
  headline: 2,
  info: 3,
  description: 4,
  expire: 5,
  severity: 6,
  urgency: 7,
  name: 8,
  title: 9,
  type: 10,
};

function escapeHtml(text) {
  if (!text) return "";
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

function isUrlValue(value) {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function formatPropertyValue(value) {
  if (value === null || value === undefined || value === "") return "";
  if (isUrlValue(value)) {
    return `<a href="${escapeHtml(
      value
    )}" target="_blank" style="color:#0066cc;text-decoration:none;word-break:break-all;">Link</a>`;
  }
  if (typeof value === "number") {
    return escapeHtml(
      value.toLocaleString(
        undefined,
        Number.isInteger(value)
          ? undefined
          : { minimumFractionDigits: 0, maximumFractionDigits: 2 }
      )
    );
  }
  if (typeof value === "string") {
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;
    if (dateRegex.test(value)) {
      try {
        const d = new Date(value);
        if (!isNaN(d.getTime())) {
          return escapeHtml(
            d.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          );
        }
      } catch {}
    }
  }
  if (typeof value === "object") {
    try {
      const str = JSON.stringify(value);
      const truncated = str.length > 100 ? str.substring(0, 100) + "..." : str;
      return `<span style="font-family:monospace;font-size:11px;">${escapeHtml(
        truncated
      )}</span>`;
    } catch {}
  }
  return escapeHtml(String(value));
}

function formatPropertyKey(key) {
  return key
    .replace(/([_-])/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function buildPopupContent(layerId, feature) {
  const properties = feature.properties || {};
  const sorted = Object.entries(properties)
    .filter(([, v]) => v != null && v !== "")
    .sort(
      ([a], [b]) =>
        (PROPERTY_PRIORITY[a.toLowerCase()] || 99) -
          (PROPERTY_PRIORITY[b.toLowerCase()] || 99) || a.localeCompare(b)
    );

  const layerRow = `
    <tr>
      <td>Layer</td>
      <td>${escapeHtml(layerId)}</td>
    </tr>`;

  const propertyRows = sorted.length
    ? sorted
        .map(
          ([k, v]) => `
        <tr>
          <td>${escapeHtml(formatPropertyKey(k))}</td>
          <td>${formatPropertyValue(v)}</td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="ncop-popup__status-note" style="display:block;text-align:center;font-style:italic;">No properties available</td></tr>`;

  // Close button removed — the popup now closes via the ESC key
  // (handler bound once at module load below).  Keeps the data table
  // uncluttered and matches the convention used across NCOP popups.
  return `<div class="ncop-popup ncop-popup--compact">
    <div class="ncop-popup__body">
      <table class="ncop-popup__table">
        <tbody>${layerRow}${propertyRows}</tbody>
      </table>
    </div>
  </div>`;
}

// One global ESC handler for the temporal popup.  Bound once; checks
// the module-level `clickPopup` so it only acts when a temporal popup
// is actually open.  Mapbox Popup#remove is idempotent, so the call is
// safe even on stale references.
if (typeof document !== "undefined" && !window.__ts_esc_bound) {
  window.__ts_esc_bound = true;
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" && ev.key !== "Esc") return;
    try {
      if (clickPopup && typeof clickPopup.isOpen === "function" && clickPopup.isOpen()) {
        clickPopup.remove();
      }
    } catch {}
  });
}

// ===== DRAG FUNCTION =====
function initDragResize() {
  const tempSlider = document.getElementById("temp-slider1");
  const dragBtn = document.getElementById("dragControlButton");
  if (!tempSlider || !dragBtn) return;

  dragBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLeft = parseInt(window.getComputedStyle(tempSlider).left) || 0;
    dragStartTop = parseInt(window.getComputedStyle(tempSlider).top) || 0;
    // Pin current width and drop the `right` constraint so changing `left`
    // during drag only moves the slider and does not resize it.
    tempSlider.style.width = tempSlider.offsetWidth + "px";
    tempSlider.style.right = "auto";
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  });

  function onDragMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    tempSlider.style.left = dragStartLeft + dx + "px";
    tempSlider.style.top = dragStartTop + dy + "px";
    if (typeof window.__ts_positionOpacityPopover === "function") {
      window.__ts_positionOpacityPopover();
    }
  }
  function onDragEnd() {
    isDragging = false;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }
}

// ===== UTILITIES =====
function loadsliderlayertemporalIcons(layerSet) {
  const map = getMap();
  if (!map) return;
  if (layerSet[0]?.images) {
    layerSet[0].images.forEach((icon) => {
      if (!map.hasImage(icon.name)) {
        map.loadImage(icon.url, (err, image) => {
          if (err) {
            console.error(`Failed to load icon ${icon.name}:`, err);
          } else {
            map.addImage(icon.name, image);
          }
        });
      }
    });
  }
}

function _getLayerType(id) {
  if (_layerTypeCache.has(id)) return _layerTypeCache.get(id);
  const map = getMap();
  const layer = map?.getLayer(id);
  const type = layer?.type || null;
  if (type) _layerTypeCache.set(id, type);
  return type;
}

function isVectorLayer(id) {
  const t = _getLayerType(id);
  return t && ["fill", "line", "circle", "symbol"].includes(t);
}

function getOpacityProperty(id) {
  if (_opacityPropCache.has(id)) return _opacityPropCache.get(id);
  const t = _getLayerType(id);
  let prop = null;
  if (t === "raster") prop = "raster-opacity";
  else if (t === "fill") prop = "fill-opacity";
  else if (t === "line") prop = "line-opacity";
  else if (t === "circle") prop = "circle-opacity";
  else if (t === "symbol") prop = "icon-opacity";
  if (prop) _opacityPropCache.set(id, prop);
  return prop;
}

function setLayerOpacity(id, value) {
  const map = getMap();
  if (!map) return;
  const prop = getOpacityProperty(id);
  if (!prop || !map.getLayer(id)) return;
  const target =
    value > 0 ? Math.max(0, Math.min(1, value * _opacityFactor)) : 0;
  const rounded = Math.round(target * 1000) / 1000;
  const last = _layerOpacityState.get(id);
  if (last === rounded) return;
  map.setPaintProperty(id, prop, rounded);
  _layerOpacityState.set(id, rounded);
  if (_getLayerType(id) === "symbol") {
    try {
      map.setPaintProperty(id, "text-opacity", rounded);
    } catch {}
  }
}

function updateActiveYearLabel(stepIndex) {
  const labelsContainer = document.querySelector("#temp-slider1 .year-labels1");
  if (!labelsContainer) return;

  const labels = labelsContainer.querySelectorAll("span");
  if (!labels.length) return;

  const normalized = Math.max(
    0,
    Math.min(labels.length - 1, Number(stepIndex) || 0)
  );

  labels.forEach((label, index) => {
    const isActive = index === normalized;
    label.classList.toggle("is-active", isActive);
    label.setAttribute("aria-current", isActive ? "true" : "false");
  });
}

function hideAllSliderLayers() {
  sliderLayers.flat().forEach((id) => {
    const map = getMap();
    if (map?.getLayer(id)) setLayerOpacity(id, 0);
  });
}

function removeClickListeners() {
  const map = getMap();
  if (!map) return;
  if (clickPopup) {
    clickPopup.remove();
    clickPopup = null;
  }
  _boundClickLayers.forEach((layerId) => {
    if (map.getLayer(layerId)) {
      map.off("mouseenter", layerId);
      map.off("mouseleave", layerId);
      map.off("click", layerId);
    }
  });
  _boundClickLayers.clear();
}

function addClickListeners() {
  const map = getMap();
  if (!map) return;
  sliderLayers.flat().forEach((layerId) => {
    if (!map.getLayer(layerId) || !isVectorLayer(layerId)) return;
    if (_boundClickLayers.has(layerId)) return;
    map.on("mouseenter", layerId, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
    });
    map.on("click", layerId, (e) => {
      if (!e.features?.length) return;
      const feature = e.features[0];
      const coordinates = e.lngLat;
      // Close the shared LayerAttributePopup first so we never end up with
      // two popups when overlapping layers fire click events together.
      try {
        window.layerAttributePopup?.hide?.();
      } catch {}
      if (!clickPopup) {
        clickPopup = new mapboxgl.Popup({
          closeButton: false,
          closeOnClick: true,
          maxWidth: "420px",
          offset: [0, -10],
          anchor: "bottom",
          className: "ncop-popup-host temporal-layer-popup",
        });
        // Expose so other modules (LayerAttributePopup) can dismiss it when
        // they open their own popup on the same click.
        try { window.__ts_clickPopup = clickPopup; } catch {}
      }
      const html = buildPopupContent(layerId, feature);
      clickPopup.setLngLat(coordinates).setHTML(html).addTo(map);
      // Close-button binding removed — ESC keydown handler (module init
      // above) is now the single dismissal path for this popup.
    });
    _boundClickLayers.add(layerId);
  });
}

function cleanupSliderLayers() {
  const map = getMap();
  if (!map) return;
  removeClickListeners();
  sliderLayers.flat().forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
    _layerTypeCache.delete(id);
    _opacityPropCache.delete(id);
    _layerOpacityState.delete(id);
    // Symmetric: the layer was added to both registries in
    // _ncopAddLayerInOrder(); drop it from both on removal so future
    // computeBeforeId() calls don't keep treating a deleted ID as
    // "still on the map".
    try {
      window.__ncop_layer_registry?.delete(id);
      window.__ncop_temporal_registry?.delete(id);
    } catch {}
  });

  const sourceIds = new Set();
  sliderLayers.forEach((grp) => {
    grp.forEach((layerId) => {
      const layer = map.getLayer(layerId);
      if (layer && layer.source) sourceIds.add(layer.source);
    });
  });

  // Source cleanup needs the *resolved* layer array. For static items
  // (DWD, IMERG, ECMWF, …) this matches `window[currentActiveLayerSet]`;
  // for async items (RainViewer) `window[key]` is a builder function, so
  // reading it as an array crashes with "set.forEach is not a function".
  // _sliderRestore.layersDef holds the array we actually used in
  // updateTempSlider() and is correct for both flavors.
  const resolvedLayerSet = Array.isArray(_sliderRestore.layersDef)
    ? _sliderRestore.layersDef
    : Array.isArray(window[currentActiveLayerSet])
    ? window[currentActiveLayerSet]
    : null;
  if (resolvedLayerSet) {
    resolvedLayerSet.forEach((entry) => {
      if (entry.sources) entry.sources.forEach((s) => sourceIds.add(s.id));
      else if (entry.source) sourceIds.add(entry.source.id);
    });
  }

  sourceIds.forEach((sid) => {
    if (map.getSource(sid)) map.removeSource(sid);
  });

  sliderLayers = [];
  currentActiveLayerSet = null;
  _lastStepIndex = null;
}

// Optimized show: only flip previous vs current
function showTimeStepLayers(stepIndex) {
  const map = getMap();
  if (!map) return;
  if (_lastStepIndex === null || !sliderLayers[_lastStepIndex]) {
    hideAllSliderLayers();
  } else if (_lastStepIndex !== stepIndex) {
    sliderLayers[_lastStepIndex].forEach((id) => {
      if (map.getLayer(id)) setLayerOpacity(id, 0);
    });
  }
  if (sliderLayers[stepIndex]) {
    sliderLayers[stepIndex].forEach((id) => {
      if (map.getLayer(id)) setLayerOpacity(id, 0.75);
    });
  }
  _lastStepIndex = stepIndex;
  updateActiveYearLabel(stepIndex);
}

// Re-apply global opacity to current frame
function _applyGlobalOpacityNow() {
  const map = getMap();
  if (!map) return;
  const idx = _lastStepIndex != null ? _lastStepIndex : 0;
  showTimeStepLayers(idx);
}

// Rebuild layers from def (for style.load)
function _rebuildLayersFromDef(layersDef, currentIndex) {
  const map = getMap();
  if (!map || !Array.isArray(layersDef)) return;
  sliderLayers = [];
  _lastStepIndex = null;
  loadsliderlayertemporalIcons(layersDef);

  layersDef.forEach((entry, index) => {
    const group = [];

    if (entry.sources) {
      entry.sources.forEach((source) => {
        if (!map.getSource(source.id)) map.addSource(source.id, source);
      });
    } else if (entry.source) {
      if (!map.getSource(entry.source.id))
        map.addSource(entry.source.id, entry.source);
    }

    entry.layers.forEach((layerDef) => {
      group.push(layerDef.id);
      const t =
        _getLayerType(layerDef.id) ||
        layerDef.type ||
        (map.getLayer(layerDef.id)?.type ?? null);
      let opacityProp = getOpacityProperty(layerDef.id);
      if (!opacityProp) {
        opacityProp =
          t === "raster"
            ? "raster-opacity"
            : t === "fill"
            ? "fill-opacity"
            : t === "line"
            ? "line-opacity"
            : t === "circle"
            ? "circle-opacity"
            : t === "symbol"
            ? "icon-opacity"
            : null;
        if (opacityProp) _opacityPropCache.set(layerDef.id, opacityProp);
      }
      const initialOpacity =
        index === currentIndex ? layerDef.paint?.[opacityProp] ?? 0.75 : 0;

      const cfg = {
        ...layerDef,
        layout: { ...layerDef.layout, visibility: "visible" },
        paint: {
          ...layerDef.paint,
          ...(opacityProp ? { [opacityProp]: initialOpacity } : {}),
        },
      };
      if (t === "symbol") {
        cfg.paint = { ...cfg.paint, "text-opacity": initialOpacity };
      }

      if (!map.getLayer(layerDef.id)) {
        _ncopAddLayerInOrder(map, cfg);
        if (initialOpacity > 0) setLayerOpacity(layerDef.id, initialOpacity);
      } else {
        map.setLayoutProperty(layerDef.id, "visibility", "visible");
        if (opacityProp != null) setLayerOpacity(layerDef.id, initialOpacity);
      }
    });

    sliderLayers.push(group);
  });

  setTimeout(addClickListeners, 300);
}

export function updateLegendBarWidths() {
  const el = document.getElementById("legend-container-slider1");
  if (!el) return;
  el.querySelectorAll("div.bar1, div.bar2").forEach((bar) => {
    bar.style.flex = "1 1 0";
    bar.style.minWidth = "0";
    bar.style.width = "";
  });
}

// ===== MAIN SLIDER FUNCTION =====
function updateTempSlider(layers, textContent, layerKey, event = null) {
  const map = getMap();
  if (!map) {
    console.error("Map instance not found. Cannot initialize slider.");
    return;
  }

  const tempSlider = document.getElementById("temp-slider1");
  const yearLabelsDiv = document.querySelector(".year-labels1");
  const legendContainer = document.getElementById("legend-container-slider1");
  const playBtn = document.getElementById("playPauseButton1");
  const pauseBtn = document.getElementById("playPauseButton2");

  try {
    window.lucide?.createIcons();
  } catch {}

  if (playBtn) playBtn.style.display = "inline-block";
  if (pauseBtn) pauseBtn.style.display = "none";
  clearInterval(interval);
  isPlaying = false;

  if (
    tempSlider.style.display === "block" &&
    currentActiveLayerSet === layerKey
  ) {
    hideAllSliderLayers();
    cleanupSliderLayers();
    tempSlider.style.display = "none";
    if (legendContainer) legendContainer.style.display = "none";
    currentActiveLayerSet = null;
    _sliderRestore = {
      layerKey: null,
      textContent: null,
      layersDef: null,
      currentIndex: 0,
    };
    return;
  }

  if (sliderLayers.length > 0) {
    hideAllSliderLayers();
    cleanupSliderLayers();
  }

  loadsliderlayertemporalIcons(layers);

  tempSlider.style.display = "block";
  sliderLayers = [];
  currentActiveLayerSet = layerKey;
  _lastStepIndex = null;

  layers.forEach((entry, index) => {
    const group = [];

    if (entry.sources)
      entry.sources.forEach((s) => {
        if (!map.getSource(s.id)) map.addSource(s.id, s);
      });
    else if (entry.source) {
      const sid = entry.source.id;
      if (!map.getSource(sid)) map.addSource(sid, entry.source);
    }

    entry.layers.forEach((layerDef) => {
      group.push(layerDef.id);

      const opacityProp =
        getOpacityProperty(layerDef.id) ||
        (layerDef.type === "raster"
          ? "raster-opacity"
          : layerDef.type === "fill"
          ? "fill-opacity"
          : layerDef.type === "line"
          ? "line-opacity"
          : layerDef.type === "circle"
          ? "circle-opacity"
          : layerDef.type === "symbol"
          ? "icon-opacity"
          : null);

      let initialOpacity = 0;
      if (index === 0) {
        initialOpacity =
          layerDef.paint?.[opacityProp] !== undefined
            ? layerDef.paint[opacityProp]
            : 0.75;
      }

      if (!map.getLayer(layerDef.id)) {
        const cfg = {
          ...layerDef,
          layout: { ...layerDef.layout, visibility: "visible" },
          paint: {
            ...layerDef.paint,
            ...(opacityProp ? { [opacityProp]: initialOpacity } : {}),
          },
        };
        if (layerDef.type === "symbol") {
          cfg.paint = { ...cfg.paint, "text-opacity": initialOpacity };
        }
        _ncopAddLayerInOrder(map, cfg);
        if (initialOpacity > 0) setLayerOpacity(layerDef.id, initialOpacity);
      } else {
        map.setLayoutProperty(layerDef.id, "visibility", "visible");
        setLayerOpacity(layerDef.id, initialOpacity);
      }
    });

    sliderLayers.push(group);
  });

  setTimeout(addClickListeners, 300);

  if (yearLabelsDiv) {
    const frag = document.createDocumentFragment();
    const n = layers.length;
    layers.forEach((l, i) => {
      const span = document.createElement("span");
      span.textContent = l.date;
      const pct = n <= 1 ? 0 : (i / (n - 1)) * 100;
      span.style.left = `${pct}%`;
      span.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const sliderEl = document.getElementById("slider1");
        if (!sliderEl) return;
        sliderEl.value = String(i);
        sliderEl.dispatchEvent(new Event("input", { bubbles: true }));
      });
      frag.appendChild(span);
    });
    yearLabelsDiv.innerHTML = "";
    yearLabelsDiv.appendChild(frag);
    updateActiveYearLabel(0);

    // Dynamically inset the timeline panel's horizontal padding to fit the
    // widest label. First/last pills are centered at 0% / 100% of the content
    // box, so padding >= widest_label_width/2 keeps them from overflowing.
    requestAnimationFrame(_recomputeDateInset);
  }

  const sliderEl = document.getElementById("slider1");
  if (sliderEl) {
    sliderEl.max = layers.length - 1;
    sliderEl.value = 0;
  }

  const titleElement = document.querySelector("#temp-slider1 p");
  if (titleElement) {
    titleElement.textContent = textContent;
  }

  if (typeof legends !== "undefined" && legends[layerKey]) {
    if (legendContainer) {
      legendContainer.innerHTML = legends[layerKey];
      legendContainer.style.display = "block";
    }
  } else if (legendContainer) {
    legendContainer.style.display = "none";
  }

  updateLegendBarWidths();

  map.once("idle", () => {
    showTimeStepLayers(0);
  });

  _sliderRestore = {
    layerKey,
    textContent,
    layersDef: layers,
    currentIndex: 0,
  };

  if (!_styleLoadHandlerBound) {
    map.on("style.load", () => {
      const temp = document.getElementById("temp-slider1");
      if (
        temp &&
        temp.style.display === "block" &&
        _sliderRestore.layersDef &&
        _sliderRestore.layerKey === currentActiveLayerSet
      ) {
        removeClickListeners();
        _rebuildLayersFromDef(
          _sliderRestore.layersDef,
          _sliderRestore.currentIndex
        );
        showTimeStepLayers(_sliderRestore.currentIndex);
      }
    });
    _styleLoadHandlerBound = true;
  }
}

// ===== SLIDER CONTROLS & OPACITY BINDING =====
document.addEventListener("DOMContentLoaded", function () {
  const playBtn = document.getElementById("playPauseButton1");
  const pauseBtn = document.getElementById("playPauseButton2");
  const slider = document.getElementById("slider1");
  const speedBtn = document.getElementById("speedControlButton");

  try {
    window.lucide?.createIcons();
  } catch {}
  initDragResize();

  if (speedBtn) speedBtn.textContent = speedLevels[currentSpeedIndex] + "x";

  function playAnimation() {
    interval = setInterval(() => {
      const maxVal = parseInt(slider.max);
      const currentVal = parseInt(slider.value);
      const nextVal = currentVal < maxVal ? currentVal + 1 : 0;
      slider.value = nextVal;
      _sliderRestore.currentIndex = nextVal;
      showTimeStepLayers(nextVal);
    }, 1000 / speedLevels[currentSpeedIndex]);
  }

  if (playBtn) {
    playBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      isPlaying = true;
      window.isTemporalAnimating = true; // <-- ADD THIS LINE
      clearInterval(interval);
      playAnimation();
      playBtn.style.display = "none";
      if (pauseBtn) pauseBtn.style.display = "inline-block";
      try {
        window.lucide?.createIcons();
      } catch {}
    });
  }
  if (pauseBtn) {
    pauseBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      isPlaying = false;
      window.isTemporalAnimating = false; // <-- ADD THIS LINE
      clearInterval(interval);
      if (playBtn) playBtn.style.display = "inline-block";
      pauseBtn.style.display = "none";
      try {
        window.lucide?.createIcons();
      } catch {}
    });
  }
  if (slider) {
    slider.addEventListener("input", (ev) => {
      ev.stopPropagation();
      const val = parseInt(slider.value);
      _sliderRestore.currentIndex = val;
      showTimeStepLayers(val);
    });
  }
  if (speedBtn) {
    speedBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      currentSpeedIndex = (currentSpeedIndex + 1) % speedLevels.length;
      speedBtn.textContent = speedLevels[currentSpeedIndex] + "x";
      if (isPlaying) {
        clearInterval(interval);
        playAnimation();
      }
    });
  }

  // ===== Remove button: deactivate the current temporal layer =====
  // Clicking the trash icon in the variable panel mimics clicking the
  // currently-selected temporal item in the sidebar, so storage, sidebar
  // state, the map layers, and this slider all unwind through the same path
  // as user-initiated deselection.
  const removeBtn = document.getElementById("tempsliderRemoveButton");
  if (removeBtn) {
    removeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!currentActiveLayerSet) return;
      const sidebarItem = document.querySelector(
        `.ncop-item-temporal[data-item-key="${currentActiveLayerSet}"]`
      );
      if (sidebarItem) {
        sidebarItem.click();
      }
    });
  }

  // ===== Opacity Control: bind to HTML-owned elements =====
  const root = document.getElementById("temp-slider1");
  const controls = document.getElementById("tempslider-controls");
  const btn = document.getElementById("opacityControlButton");
  const pop = document.getElementById("opacityControlPopover");
  const range = document.getElementById("opacityRange");
  const label = document.getElementById("opacityValueLabel");

  if (range && label) {
    range.value = String(Math.round(_opacityFactor * 100));
    label.textContent = `${range.value}%`;
  }

  function positionPopover() {
    if (!root || !btn || !pop) return;
    const btnRect = btn.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    // Anchor popover directly under the opacity button, right-aligned with it.
    const rightOffset = rootRect.right - btnRect.right;
    pop.style.right = `${rightOffset}px`;
    pop.style.left = "auto";
    pop.style.top = `${btnRect.bottom - rootRect.top + 8}px`;
  }

  // expose for drag/resize to keep it pinned
  window.__ts_positionOpacityPopover = function __ts_positionOpacityPopover() {
    if (pop && pop.style.display === "block") positionPopover();
  };

  if (btn && pop) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = pop.style.display === "block";
      if (!open) {
        positionPopover();
        pop.style.display = "block";
        btn.setAttribute("aria-expanded", "true");
        pop.setAttribute("aria-hidden", "false");
      } else {
        pop.style.display = "none";
        btn.setAttribute("aria-expanded", "false");
        pop.setAttribute("aria-hidden", "true");
      }
      try {
        window.lucide?.createIcons();
      } catch {}
    });
  }

  if (range && label) {
    range.addEventListener("input", (e) => {
      e.stopPropagation();
      const pct = Math.max(
        0,
        Math.min(100, parseInt(range.value || "100", 10))
      );
      _opacityFactor = pct / 100;
      label.textContent = `${pct}%`;
      _applyGlobalOpacityNow();
    });
  }

  // No click-away closing — popover toggles only from its button
  window.addEventListener("resize", () => {
    if (pop && pop.style.display === "block") positionPopover();
  });

  // Expose manual helper for console
  window.setTemporalOpacity = function setTemporalOpacity(pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct)));
    _opacityFactor = clamped / 100;
    if (range) range.value = String(clamped);
    if (label) label.textContent = `${clamped}%`;
    _applyGlobalOpacityNow();
  };
});

// ===== ASYNC TEMPORAL SUPPORT =====
async function updateTempSliderAsync(layersPromise, textContent, layerKey) {
  const map = getMap();
  if (!map) return;
  if (!map.isStyleLoaded()) {
    await new Promise((resolve) => {
      map.once("load", resolve);
    });
  }

  // Helper: deselect the sidebar item that triggered this call. Used
  // whenever the builder fails or yields nothing, so the user isn't left
  // with a sidebar toggle that *looks* selected but produced no slider.
  const _resetSidebar = () => {
    try {
      const item = document.querySelector(
        `.ncop-item-temporal[data-item-key="${layerKey}"]`
      );
      if (item) {
        item.classList.remove("is-selected");
        const img = item.querySelector(".ncop-item-image");
        if (img) img.classList.remove("selected");
      }
    } catch (_) {}
  };

  // Helper: tear down whatever temporal layer was active before this call
  // so the user's click is always reflected as a *replace*, even when the
  // new layer turns out to be unavailable. Without this, an async layer
  // that resolves to [] would leave the prior layer + legend on screen
  // and look like the click did nothing.
  const _tearDownPrevious = () => {
    try {
      hideAllSliderLayers();
      cleanupSliderLayers();
    } catch (_) {}
    try {
      const tempSlider = document.getElementById("temp-slider1");
      if (tempSlider) tempSlider.style.display = "none";
      const legendContainer = document.getElementById(
        "legend-container-slider1"
      );
      if (legendContainer) legendContainer.style.display = "none";
    } catch (_) {}
    _sliderRestore = {
      layerKey: null,
      textContent: null,
      layersDef: null,
      currentIndex: 0,
    };
  };

  let layers;
  try {
    layers = await layersPromise;
  } catch (e) {
    console.warn(
      `updateTempSliderAsync[${layerKey}]: failed to resolve layers — ${e?.message || e}`
    );
    _tearDownPrevious();
    _resetSidebar();
    return;
  }
  if (!Array.isArray(layers) || layers.length === 0) {
    console.info(
      `updateTempSliderAsync[${layerKey}]: no frames available — clearing previous slider state`
    );
    _tearDownPrevious();
    _resetSidebar();
    return;
  }
  updateTempSlider(layers, textContent, layerKey);
}

// ===== EXPOSE GLOBALS =====
window.updateTempSlider = updateTempSlider;
window.updateTempSliderAsync = updateTempSliderAsync;
window.hideAllSliderLayers = hideAllSliderLayers;
window.cleanupSliderLayers = cleanupSliderLayers;

// Read-only accessor for downstream consumers (e.g. WeatherReportControl)
// that need to know which temporal layer is active and at what step. Pure
// snapshot — no behavior change.
function getCurrentTemporalState() {
  const layersDef = _sliderRestore.layersDef;
  const idx = _sliderRestore.currentIndex || 0;
  const currentEntry = Array.isArray(layersDef) ? layersDef[idx] : null;
  return {
    layerKey: currentActiveLayerSet,
    currentIndex: idx,
    layersDef,
    currentEntry,
    date: currentEntry?.date || _sliderRestore.textContent || "",
  };
}
window.getCurrentTemporalState = getCurrentTemporalState;

// RainViewer is now handled as a regular temporal raster layer — frame
// builders live in time-functions.js (generateRainViewerRadar/SatelliteIR
// Layers) and are exposed on window[itemKey] like every other temporal
// item. The standard #temp-slider1 controller above drives them too.
