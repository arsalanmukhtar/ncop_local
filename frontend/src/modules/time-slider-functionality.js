// time-slider-functionality.js
// Updated to work with DashboardManager's private map instance
// Adds: clean Lucide play/pause toggle with two buttons, and restoration on map 'style.load'.
// ADDED: Drag and Resize functionality
// IMPROVED: Table-based popup with advanced styling and CSS variables
// ENHANCED: HTML escaping, property prioritization, and better value formatting
// OPTIMIZED: Layer/show switching, caching of layer types/opacity props, no-op paint sets skipped
// ADDED: Async temporal loader (updateTempSliderAsync) that waits for map readiness
// ADDED: Temporal Opacity Controller (global factor applied to all temporal layers/steps)

import { legends, legendCompact } from "./temporal-layer-legends";

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

// Dynamic label + responsive legend helpers (slider1)
let _yearLabelsDivRef = null;
let _layersMetaForLabels = null;
let _legendResponsive = { container: null, layerKey: null };

function _updateDynamicYearLabel(stepIndex) {
  if (!_yearLabelsDivRef || !_layersMetaForLabels) return;
  const meta = _layersMetaForLabels[stepIndex];
  const label = meta?.date ?? meta?.label ?? String(stepIndex + 1);
  const span = _yearLabelsDivRef.querySelector("span");
  if (span) span.textContent = label;
}

function _applyLegendResponsiveness() {
  const container = _legendResponsive.container;
  const layerKey = _legendResponsive.layerKey;
  if (!container || !layerKey) return;
  const labels = Array.from(container.querySelectorAll(".legend-labels"));
  if (!labels.length) return;

  const isSmall = window.matchMedia && window.matchMedia("(max-width: 480px)").matches;
  if (!isSmall) {
    labels.forEach((el) => (el.style.display = ""));
    return;
  }

  // Prefer config from temporal-layer-legends.js (derived from same ticks)
  const cfg = (typeof legendCompact !== "undefined" && legendCompact[layerKey]) ? legendCompact[layerKey] : null;
  const midIdx = Math.floor((labels.length - 1) / 2);

  labels.forEach((el, i) => {
    const show = i === 0 || i === midIdx || i === labels.length - 1;
    el.style.display = show ? "" : "none";
  });

  // Ensure the visible labels are exactly min/mean/max (even if ticks were dense)
  if (cfg) {
    labels[0].textContent = cfg.min;
    labels[midIdx].textContent = cfg.mean;
    labels[labels.length - 1].textContent = cfg.max;
  }
}

// Drag and Resize variables
let isDragging = false;
let isResizing = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartLeft = 0;
let dragStartTop = 0;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;

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
      } catch { }
    }
  }
  if (typeof value === "object") {
    try {
      const str = JSON.stringify(value);
      const truncated = str.length > 100 ? str.substring(0, 100) + "..." : str;
      return `<span style="font-family:monospace;font-size:11px;">${escapeHtml(
        truncated
      )}</span>`;
    } catch { }
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

  let rows = `
    <tr style="border-bottom:1px solid rgba(255,255,255,0.5);">
      <td style="padding:8px 0;padding-right:12px;font-weight:600;color:#2ecc71;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;white-space:nowrap;">Layer</td>
      <td style="padding:8px 0;color:rgba(255,255,255,0.75);font-weight:500;word-break:break-word;">${escapeHtml(
    layerId
  )}</td>
    </tr>`;

  if (sorted.length) {
    rows += sorted
      .map(([k, v], i) => {
        const last = i === sorted.length - 1;
        return `
        <tr style="border-bottom:1px solid rgba(255,255,255,${last ? "0" : "0.5"
          });">
          <td style="padding:8px 0;padding-right:12px;font-weight:600;color:#2ecc71;white-space:nowrap;vertical-align:top;">${escapeHtml(
            formatPropertyKey(k)
          )}:</td>
          <td style="padding:8px 0;color:rgba(255,255,255,0.75);word-break:break-word;max-width:250px;">${formatPropertyValue(
            v
          )}</td>
        </tr>`;
      })
      .join("");
  } else {
    rows += `
      <tr>
        <td colspan="2" style="padding:8px 0;color:rgba(255,255,255,0.75);font-size:12px;font-style:italic;text-align:center;">No properties available</td>
      </tr>`;
  }

  return `
    <div style="position:fixed;z-index:9999;background:var(--primary-bg,#ffffff);box-shadow:0 8px 32px var(--shadow-soft,rgba(0,0,0,0.1));border-radius:8px;padding:10px 15px;font-size:13px;border:1px solid var(--border-dark,rgba(0,0,0,0.1));backdrop-filter:blur(15px) saturate(180%);-webkit-backdrop-filter:blur(15px) saturate(180%);transition:opacity .2s;opacity:1;display:flex;flex-direction:column;transform:translate(-50%,-100%);min-width:280px;height:25rem;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.4;overflow-y:auto;">
      <table style="width:100%;border-collapse:collapse;margin:0;padding:0;">
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ===== DRAG AND RESIZE FUNCTIONS =====
function initDragResize() {
  const tempSlider = document.getElementById("temp-slider1");
  const dragBtn = document.getElementById("dragControlButton");
  const resizeBtn = document.getElementById("resizeControlButton");
  if (!tempSlider || !dragBtn || !resizeBtn) return;

  dragBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLeft = parseInt(window.getComputedStyle(tempSlider).left) || 0;
    dragStartTop = parseInt(window.getComputedStyle(tempSlider).top) || 0;
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

  resizeBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartWidth = tempSlider.offsetWidth;
    resizeStartHeight = tempSlider.offsetHeight;
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", onResizeEnd);
  });

  function onResizeMove(e) {
    if (!isResizing) return;
    const dx = e.clientX - resizeStartX;
    const dy = e.clientY - resizeStartY;
    const newW = Math.max(100, resizeStartWidth + dx);
    const newH = Math.max(50, resizeStartHeight + dy);
    tempSlider.style.width = newW + "px";
    tempSlider.style.height = newH + "px";
    const legendContainer = document.querySelector(".legend-container1");
    if (legendContainer) legendContainer.style.width = newW * 0.95 + "px";
    if (typeof window.__ts_positionOpacityPopover === "function") {
      window.__ts_positionOpacityPopover();
    }
  }
  function onResizeEnd() {
    isResizing = false;
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeEnd);
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
    } catch { }
  }
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
          maxWidth: "400px",
          offset: [0, -10],
          anchor: "bottom",
          className: "temporal-layer-popup",
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
  _updateDynamicYearLabel(stepIndex);
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

  // NEW: wrapper refs (because labels are now outside the button)
  const playControl = playBtn ? playBtn.closest(".control-item") : null;
  const pauseControl =
    document.getElementById("pauseControl") ||
    (pauseBtn ? pauseBtn.closest(".control-item") : null);

  try {
    window.lucide?.createIcons();
  } catch { }

  // Show PLAY wrapper, hide PAUSE wrapper (not just buttons)
  if (playControl) playControl.style.display = "";
  else if (playBtn) playBtn.style.display = "";

  if (pauseControl) pauseControl.style.display = "none";
  else if (pauseBtn) pauseBtn.style.display = "none";

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
    // Store refs so we can update label as slider moves (keep slider core logic unchanged)
    _yearLabelsDivRef = yearLabelsDiv;
    _layersMetaForLabels = layers;

    // Show only ONE label, updated dynamically (e.g., Day 1 → Day 2 → Day 3)
    yearLabelsDiv.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = layers?.[0]?.date ?? layers?.[0]?.label ?? "";
    yearLabelsDiv.appendChild(span);
  }

  const sliderEl = document.getElementById("slider1");
  if (sliderEl) {
    sliderEl.max = layers.length - 1;
    sliderEl.value = 0;
  }

  const titleElement = document.querySelector("#temp-slider1 .tempslider-title p");
  if (titleElement) {
    titleElement.textContent = textContent;
  }

  if (typeof legends !== "undefined" && legends[layerKey]) {
    if (legendContainer) {
      legendContainer.innerHTML = legends[layerKey];
      legendContainer.style.display = "block";
      _legendResponsive = { container: legendContainer, layerKey };
      _applyLegendResponsiveness();
    }
  } else if (legendContainer) {
    legendContainer.style.display = "none";
    _legendResponsive = { container: null, layerKey: null };
  }

  // Update min/max labels dynamically based on legend data
  if (typeof legendCompact !== "undefined" && legendCompact[layerKey]) {
    const minLabel = document.querySelector("#temp-slider1 .legend-min-label");
    const maxLabel = document.querySelector("#temp-slider1 .legend-max-label");

    if (minLabel) {
      minLabel.textContent = legendCompact[layerKey].min;
    }
    if (maxLabel) {
      maxLabel.textContent = legendCompact[layerKey].max;
    }
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

  // NEW: wrapper refs for correct show/hide after DOM change
  const playControl = playBtn ? playBtn.closest(".control-item") : null;
  const pauseControl =
    document.getElementById("pauseControl") ||
    (pauseBtn ? pauseBtn.closest(".control-item") : null);

  try {
    window.lucide?.createIcons();
  } catch { }
  initDragResize();

  if (speedBtn) speedBtn.textContent = "Speed " + speedLevels[currentSpeedIndex] + "x";

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
      // Hide PLAY wrapper + show PAUSE wrapper (so label switches too)
      if (playControl) playControl.style.display = "none";
      else playBtn.style.display = "none";

      if (pauseControl) pauseControl.style.display = "";
      else if (pauseBtn) pauseBtn.style.display = "";

      try {
        window.lucide?.createIcons();
      } catch { }

    });
  }
  if (pauseBtn) {
    pauseBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      isPlaying = false;
      window.isTemporalAnimating = false; // <-- ADD THIS LINE
      clearInterval(interval);
      // Show PLAY wrapper + hide PAUSE wrapper (so label switches too)
      if (playControl) playControl.style.display = "";
      else if (playBtn) playBtn.style.display = "";

      if (pauseControl) pauseControl.style.display = "none";
      else pauseBtn.style.display = "none";

      try {
        window.lucide?.createIcons();
      } catch { }

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
      speedBtn.textContent = "Speed " + speedLevels[currentSpeedIndex] + "x";
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
    if (!root || !controls || !pop) return;
    const controlsRect = controls.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();

    // Position below the controls row
    const left = controlsRect.left - rootRect.left;
    const top = controlsRect.bottom - rootRect.top + 8; // 8px gap below controls

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
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
      } catch { }
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
    _applyLegendResponsiveness();
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