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

  return `<div class="ncop-popup ncop-popup--compact">
    <div class="ncop-popup__body">
      <table class="ncop-popup__table">
        <tbody>${layerRow}${propertyRows}</tbody>
      </table>
    </div>
  </div>`;
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
      if (!clickPopup) {
        clickPopup = new mapboxgl.Popup({
          closeButton: true,
          closeOnClick: true,
          maxWidth: "420px",
          offset: [0, -10],
          anchor: "bottom",
          className: "ncop-popup-host temporal-layer-popup",
        });
      }
      const html = buildPopupContent(layerId, feature);
      clickPopup.setLngLat(coordinates).setHTML(html).addTo(map);
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
  });

  const sourceIds = new Set();
  sliderLayers.forEach((grp) => {
    grp.forEach((layerId) => {
      const layer = map.getLayer(layerId);
      if (layer && layer.source) sourceIds.add(layer.source);
    });
  });

  if (currentActiveLayerSet && window[currentActiveLayerSet]) {
    const set = window[currentActiveLayerSet];
    set.forEach((entry) => {
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
        map.addLayer(cfg);
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
        map.addLayer(cfg);
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
    requestAnimationFrame(() => {
      const panel = yearLabelsDiv.closest(".ts-panel--timeline");
      if (!panel) return;
      let maxWidth = 0;
      yearLabelsDiv.querySelectorAll("span").forEach((s) => {
        const w = s.getBoundingClientRect().width;
        if (w > maxWidth) maxWidth = w;
      });
      if (maxWidth > 0) {
        const inset = Math.ceil(maxWidth / 2) + 6;
        panel.style.setProperty("--date-inset", `${inset}px`);
      }
    });
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
  let layers;
  try {
    layers = await layersPromise;
  } catch (e) {
    console.error("updateTempSliderAsync: failed to resolve layers:", e);
    return;
  }
  if (!Array.isArray(layers) || layers.length === 0) {
    console.warn("updateTempSliderAsync: empty layers array");
    return;
  }
  updateTempSlider(layers, textContent, layerKey);
}

// ===== EXPOSE GLOBALS =====
window.updateTempSlider = updateTempSlider;
window.updateTempSliderAsync = updateTempSliderAsync;
window.hideAllSliderLayers = hideAllSliderLayers;
window.cleanupSliderLayers = cleanupSliderLayers;

// ===========================================================================
// RainViewer player (previously: rainviewer-player.js)
// ===========================================================================


const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";

const RV = {
    host: null,
    data: null,

    mode: "radar", // "radar" | "satellite"
    lockedMode: false,

    frames: [], // [{time, path, type, tileUrl, label}]
    index: 0,

    timer: null,
    playing: false,
    speedIndex: 0,
    speeds: [1, 2, 3],
    baseIntervalMs: 2000,

    map: null,

    ids: {
        layerPrefix: "rvplayer_layer",
        sourcePrefix: "rvplayer_source",
    },

    debounceTimer: null,
};

// ------------------------- fetch + helpers
function rvFetchSync() {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", RAINVIEWER_API, false);
    try { xhr.send(null); } catch (e) { console.error("RV fetch failed", e); return null; }
    if (xhr.status < 200 || xhr.status >= 300) { console.error("RV bad status", xhr.status); return null; }
    try { return JSON.parse(xhr.responseText); } catch (e) { console.error("RV parse failed", e); return null; }
}

function rvFormatPKT(unixSeconds) {
    const pktTime = new Date(unixSeconds * 1000 + 5 * 60 * 60 * 1000);
    const day = String(pktTime.getUTCDate()).padStart(2, "0");
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mon = MONTHS[pktTime.getUTCMonth()];
    const h = pktTime.getUTCHours();
    const m = pktTime.getUTCMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${mon} ${day} - ${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
}

function rvBuildTileUrl(host, path, type) {
    const size = 256;
    const tail = type === "radar" ? "2/1_1" : "0/0_0";
    // IMPORTANT: no ?t=... (keeps caching)
    return `${host}${path}/${size}/{z}/{x}/{y}/${tail}.png`;
}

function rvResolveSatelliteFrames(data) {
    const sat = data?.satellite;
    if (!sat || typeof sat !== "object") return [];

    // Preferred known shape
    if (Array.isArray(sat.infrared) && sat.infrared.length) return sat.infrared;

    // Backward/alternate shapes observed across API revisions
    if (Array.isArray(sat.past) && sat.past.length) return sat.past;
    if (Array.isArray(sat.frames) && sat.frames.length) return sat.frames;

    // Last-resort: find any array of frame-like objects ({time, path})
    for (const key of Object.keys(sat)) {
        const v = sat[key];
        if (
            Array.isArray(v) &&
            v.length &&
            v.some((it) => it && typeof it === "object" && it.time && it.path)
        ) {
            return v;
        }
    }

    return [];
}

function rvBuildFrames(data, mode) {
    const frames = [];

    if (mode === "radar") {
        const past = Array.isArray(data?.radar?.past) ? data.radar.past : [];
        const items = [...past].sort((a, b) => a.time - b.time);

        const stride = Math.max(1, Math.floor(items.length / 6)) || 1;
        for (let i = 0; i < items.length; i += stride) {
            const it = items[i];
            frames.push({
                time: it.time,
                path: it.path,
                type: "radar",
                tileUrl: rvBuildTileUrl(data.host, it.path, "radar"),
                label: rvFormatPKT(it.time),
            });
            if (frames.length >= 6) break;
        }
    } else {
        const satFrames = rvResolveSatelliteFrames(data);
        const items = [...satFrames].sort((a, b) => a.time - b.time);

        const stride = Math.max(1, Math.floor(items.length / 6)) || 1;
        for (let i = 0; i < items.length; i += stride) {
            const it = items[i];
            if (!it?.path || !it?.time) continue;
            frames.push({
                time: it.time,
                path: it.path,
                type: "satellite",
                tileUrl: rvBuildTileUrl(data.host, it.path, "satellite"),
                label: rvFormatPKT(it.time),
            });
            if (frames.length >= 6) break;
        }
    }

    return frames;
}

// ------------------------- map ids
function rvSourceId(mode, i) { return `${RV.ids.sourcePrefix}_${mode}_${i}`; }
function rvLayerId(mode, i) { return `${RV.ids.layerPrefix}_${mode}_${i}`; }

// ------------------------- map layer mgmt
function rvRemoveAllMapLayers() {
    const map = RV.map;
    if (!map) return;

    const modes = ["radar", "satellite"];
    for (const mode of modes) {
        for (let i = 0; i < 30; i++) {
            const lid = rvLayerId(mode, i);
            const sid = rvSourceId(mode, i);
            try { if (map.getLayer(lid)) map.removeLayer(lid); } catch { }
            try { if (map.getSource(sid)) map.removeSource(sid); } catch { }
        }
    }
}

function rvEnsureMapLayers() {
    const map = RV.map;
    if (!map || !RV.frames.length) return;

    // clear old mode layers, then add new
    rvRemoveAllMapLayers();

    const MAXZ = 10; // free limit; lower to 8 if still 429

    RV.frames.forEach((f, i) => {
        const sid = rvSourceId(RV.mode, i);
        const lid = rvLayerId(RV.mode, i);

        map.addSource(sid, {
            type: "raster",
            tiles: [f.tileUrl],
            tileSize: 256,
            maxzoom: MAXZ,
        });

        map.addLayer({
            id: lid,
            type: "raster",
            source: sid,
            layout: { visibility: i === RV.index ? "visible" : "none" },
            paint: {
                "raster-opacity": 1,
                "raster-fade-duration": 0,
            },
            minzoom: 0,
            maxzoom: MAXZ,
        });
    });
}

function rvSetVisibleIndex(index) {
    const map = RV.map;
    if (!map) return;

    for (let i = 0; i < RV.frames.length; i++) {
        const lid = rvLayerId(RV.mode, i);
        try {
            if (map.getLayer(lid)) {
                map.setLayoutProperty(lid, "visibility", i === index ? "visible" : "none");
                map.setPaintProperty(lid, "raster-opacity", 1);
                map.setPaintProperty(lid, "raster-fade-duration", 0);
            }
        } catch { }
    }
}

// ------------------------- Legend Management
function rvUpdateLegend() {
    const legendsContainer = document.getElementById("rv-legends");
    if (!legendsContainer) return;

    // Clear existing legends
    legendsContainer.innerHTML = "";

    // Get the appropriate legend based on current mode
    let legendHTML = "";

    if (RV.mode === "radar") {
        legendHTML = legends.rainviewerRadar || "";
    } else if (RV.mode === "satellite") {
        legendHTML = legends.rainviewerSatInfra || "";
    }

    if (!legendHTML) return;

    // Create the legend container with the improved structure
    const legendContainer = document.createElement("div");
    legendContainer.className = "rv-legend-container";
    // Create legend items (the gradient bar goes here)
    const itemsDiv = document.createElement("div");
    itemsDiv.className = "rv-legend-items";
    itemsDiv.style.gridTemplateColumns = "1fr"; // Single column for gradient bar
    itemsDiv.innerHTML = legendHTML;

    // Assemble the legend
    legendContainer.appendChild(itemsDiv);
    legendsContainer.appendChild(legendContainer);

    // Re-initialize Lucide icons
    try {
        if (window.lucide?.createIcons) {
            window.lucide.createIcons();
        }
    } catch (e) {
        console.warn("Lucide icons not available:", e);
    }
}

// ------------------------- UI
function rvUpdateTopLabel() {
    const labelEl = document.getElementById("rv_time_label");
    if (!labelEl || !RV.frames.length) return;
    const f = RV.frames[RV.index];
    const prefix = RV.mode === "radar" ? "Radar" : "Satellite IR";
    labelEl.textContent = `${prefix} — ${f.label}`;
}

function rvUpdateLabelsBar() {
    const el = document.getElementById("rvLabels1");
    if (!el) return;
    el.innerHTML = "";
    if (!RV.frames.length) return;

    const start = RV.frames[0];
    const mid = RV.frames[Math.floor((RV.frames.length - 1) / 2)];
    const end = RV.frames[RV.frames.length - 1];

    const mk = (txt) => {
        const s = document.createElement("span");
        s.textContent = txt;
        return s;
    };

    el.appendChild(mk(start.label));
    el.appendChild(mk(mid.label));
    el.appendChild(mk(end.label));
}

function rvUpdateSliderRange() {
    const slider = document.getElementById("rvSlider1");
    if (!slider) return;
    slider.min = "0";
    slider.max = String(Math.max(0, RV.frames.length - 1));
    slider.value = String(RV.index);
}

function rvApplyLockModeUI() {
    const modeBtn = document.getElementById("rvModeButton");
    if (!modeBtn) return;
    modeBtn.style.display = RV.lockedMode ? "none" : "inline-block";
}

// ------------------------- player actions
function rvSetIndex(idx) {
    if (!RV.frames.length) return;
    RV.index = Math.max(0, Math.min(RV.frames.length - 1, idx));
    rvSetVisibleIndex(RV.index);
    rvUpdateTopLabel();
    rvUpdateSliderRange();
}

function rvStep(delta) {
    if (!RV.frames.length) return;
    const next = (RV.index + delta + RV.frames.length) % RV.frames.length;
    rvSetIndex(next);
}

function rvPlay() {
    if (RV.playing) return;
    RV.playing = true;

    const playBtn = document.getElementById("rvPlayButton");
    const pauseBtn = document.getElementById("rvPauseButton");
    if (playBtn) playBtn.style.display = "none";
    if (pauseBtn) pauseBtn.style.display = "inline-block";

    const speed = RV.speeds[RV.speedIndex] || 1;
    const interval = Math.max(1200, Math.floor(RV.baseIntervalMs / speed));

    RV.timer = setInterval(() => rvStep(+1), interval);
}

function rvPause() {
    RV.playing = false;
    if (RV.timer) clearInterval(RV.timer);
    RV.timer = null;

    const playBtn = document.getElementById("rvPlayButton");
    const pauseBtn = document.getElementById("rvPauseButton");
    if (playBtn) playBtn.style.display = "inline-block";
    if (pauseBtn) pauseBtn.style.display = "none";
}

function rvBindDragResize(panelId, dragBtnId, resizeBtnId) {
    const panel = document.getElementById(panelId);
    const dragBtn = document.getElementById(dragBtnId);
    const resizeBtn = document.getElementById(resizeBtnId);
    if (!panel || !dragBtn || !resizeBtn) return;

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    dragBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = parseInt(window.getComputedStyle(panel).left) || 0;
        startTop = parseInt(window.getComputedStyle(panel).top) || 0;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    function onMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panel.style.left = startLeft + dx + "px";
        panel.style.top = startTop + dy + "px";
    }

    function onUp() {
        isDragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
    }

    let isResizing = false;
    let rsX = 0, rsY = 0, rsW = 0, rsH = 0;

    resizeBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        isResizing = true;
        rsX = e.clientX;
        rsY = e.clientY;
        rsW = panel.offsetWidth;
        rsH = panel.offsetHeight;
        document.addEventListener("mousemove", onResize);
        document.addEventListener("mouseup", onResizeUp);
    });

    function onResize(e) {
        if (!isResizing) return;
        const dx = e.clientX - rsX;
        const dy = e.clientY - rsY;
        panel.style.width = Math.max(220, rsW + dx) + "px";
        panel.style.height = Math.max(80, rsH + dy) + "px";
    }

    function onResizeUp() {
        isResizing = false;
        document.removeEventListener("mousemove", onResize);
        document.removeEventListener("mouseup", onResizeUp);
    }
}

function rvSetMode(mode) {
    RV.mode = mode === "satellite" || mode === "satellite_infrared" ? "satellite" : "radar";

    const modeBtn = document.getElementById("rvModeButton");
    if (modeBtn) modeBtn.textContent = RV.mode === "radar" ? "Radar" : "Satellite";

    RV.frames = rvBuildFrames(RV.data, RV.mode);
    if (!RV.frames.length) {
        console.warn(`RainViewer: no frames available for mode "${RV.mode}"`);
    }
    RV.index = 0;

    rvPause();
    rvEnsureMapLayers();
    rvUpdateLabelsBar();
    rvUpdateSliderRange();
    rvUpdateTopLabel();
    rvApplyLockModeUI();

    // ✅ UPDATE LEGEND WHEN MODE CHANGES
    rvUpdateLegend();
}

// ------------------------- Public API
export function showRainViewerPlayer(mode = "radar", lockMode = false) {
    const panel = document.getElementById("rv-slider1");
    const temp = document.getElementById("temp-slider1");
    if (temp) temp.style.display = "none";
    if (panel) panel.style.display = "block";

    RV.lockedMode = !!lockMode;
    window.__rvRequestedMode = mode;
    window.__rvLockMode = RV.lockedMode;

    // if already inited, apply immediately
    if (RV.map && RV.data) {
        rvSetMode(mode);
    }
}

export function hideRainViewerPlayer(map) {
    const panel = document.getElementById("rv-slider1");
    if (panel) panel.style.display = "none";
    rvPause();

    RV.map = map || RV.map;
    rvRemoveAllMapLayers();
}

export function initRainViewerPlayer(map) {
    RV.map = map;

    const data = rvFetchSync();
    if (!data?.host) {
        console.error("RainViewer: API unavailable");
        return;
    }
    RV.data = data;
    RV.host = data.host;

    rvBindDragResize("rv-slider1", "rvDragControlButton", "rvResizeControlButton");

    // speed
    const speedBtn = document.getElementById("rvSpeedButton");
    if (speedBtn) {
        // Update speed button to show current speed with text
        const speedText = speedBtn.querySelector('.rv-speed-text');
        if (speedText) {
            speedText.textContent = (RV.speeds[RV.speedIndex] || 1) + "x";
        } else {
            speedBtn.textContent = (RV.speeds[RV.speedIndex] || 1) + "x";
        }

        speedBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            RV.speedIndex = (RV.speedIndex + 1) % RV.speeds.length;

            // Update speed text
            const speedText = speedBtn.querySelector('.rv-speed-text');
            if (speedText) {
                speedText.textContent = (RV.speeds[RV.speedIndex] || 1) + "x";
            } else {
                speedBtn.textContent = (RV.speeds[RV.speedIndex] || 1) + "x";
            }

            if (RV.playing) { rvPause(); rvPlay(); }
        });
    }

    // mode toggle (will be hidden when locked)
    const modeBtn = document.getElementById("rvModeButton");
    if (modeBtn) {
        modeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (RV.lockedMode) return; // IMPORTANT: lock when opened from layer toggles
            rvSetMode(RV.mode === "radar" ? "satellite" : "radar");
        });
    }

    // play/pause
    document.getElementById("rvPlayButton")?.addEventListener("click", (e) => {
        e.stopPropagation();
        rvPlay();
    });
    document.getElementById("rvPauseButton")?.addEventListener("click", (e) => {
        e.stopPropagation();
        rvPause();
    });

    // slider (debounced)
    const slider = document.getElementById("rvSlider1");
    if (slider) {
        slider.addEventListener("input", (e) => {
            e.stopPropagation();
            rvPause();
            const val = parseInt(slider.value || "0", 10);
            if (RV.debounceTimer) clearTimeout(RV.debounceTimer);
            RV.debounceTimer = setTimeout(() => rvSetIndex(val), 120);
        });
    }

    // pause when moving map
    map.on("movestart", () => { if (RV.playing) rvPause(); });

    // apply requested/default mode (BUT DON'T ADD LAYERS YET)
    RV.lockedMode = !!window.__rvLockMode;
    const requestedRaw = window.__rvRequestedMode || "radar";
    const requested =
        requestedRaw === "satellite" || requestedRaw === "satellite_infrared"
            ? "satellite"
            : "radar";

    // ✅ IMPORTANT: Only build frames, don't add layers until showRainViewerPlayer is called
    RV.frames = rvBuildFrames(RV.data, requested);
    RV.mode = requested;
    RV.index = 0;

    // Update UI elements but don't add map layers
    rvUpdateLabelsBar();
    rvUpdateSliderRange();
    rvUpdateTopLabel();
    rvApplyLockModeUI();

    try { window.lucide?.createIcons(); } catch { }
}
