// layer-attribute-popup.js
// Generic attribute popup bound to the clicked lng/lat (NOT screen pixels)
// - Reads popup: true groups from map-layers.js (vector/geojson only; skips raster)
// - ALSO supports dynamic DEW exposure polygons added at runtime via window.exposureLayersMap
// - Does NOT inject "information" from config, but WILL display "information" if present in feature properties

import { ncop_menu_items } from "./map-layers.js";

function prettyAttributeName(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

// Show everything the feature already has, including "information"
const HIDDEN_KEYS = new Set();

export default class LayerAttributePopup {
  constructor(map) {
    this.map = null; // will be set once a real map is found
    this.popupEl = this.#createEl();
    this.anchorLngLat = null;

    // Static (config-driven) popup eligibility
    const { popupLayers, popupSources, labelsByLayer, labelsBySource } =
      this.#indexPopupEligible();
    this.popupLayers = popupLayers; // Set<string>
    this.popupSources = popupSources; // Set<string>
    this.labelsByLayer = labelsByLayer; // Map<layerId, title>
    this.labelsBySource = labelsBySource; // Map<sourceId, title>

    // Dynamic (runtime DEW) eligibility
    this.dynamicPopupLayers = new Set(); // Set<string> (layerIds)
    this.dynamicPopupSources = new Set(); // Set<string> (sourceIds)
    this.dynamicTitleByLayer = new Map(); // Map<layerId, title>
    this.dynamicTitleBySource = new Map(); // Map<sourceId, title>
    this._lastExposureCount = -1; // to detect changes

    // Defer bind until a real map exists
    this.#deferredBind(map);
  }

  // ---------- DOM ----------
  #createEl() {
    const el = document.createElement("div");
    el.className = "layer-attribute-popup hidden";
    el.innerHTML = `
      <div class="popup-content">
        <div class="popup-label"></div>
        <div class="popup-attributes-scroll">
          <table class="popup-attributes"></table>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    return el;
  }

  // Public wrapper so other modules can programmatically set content
  setContent(title, properties) {
    this.#setContent({ title, properties });
    if (this.anchorLngLat) {
      this.#show();
      this.#updatePosition();
      this.#attachMoveListeners();
    }
  }

  #setContent({ title, properties }) {
    const labelEl = this.popupEl.querySelector(".popup-label");
    const tableEl = this.popupEl.querySelector(".popup-attributes");

    labelEl.textContent = title || "Attributes";
    tableEl.innerHTML = ""; // reset

    const props = properties || {};
    const keys = Object.keys(props || {}); // <- do NOT filter out "information"

    if (!props || keys.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="attr-value" colspan="2">No attributes found</td>`;
      tableEl.appendChild(tr);
      return;
    }

    const addRows = (obj, level = 0) => {
      Object.keys(obj).forEach((key) => {
        if (HIDDEN_KEYS.has(key)) return;

        let val = obj[key];
        // Try JSON parse for stringified objects/arrays
        if (typeof val === "string") {
          try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === "object") val = parsed;
          } catch (_) {}
        }
        const indent = level * 16;

        if (val && typeof val === "object" && !Array.isArray(val)) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td class="attr-key" style="padding-left:${indent}px">${prettyAttributeName(
            key
          )}</td><td class="attr-value"></td>`;
          tableEl.appendChild(tr);
          addRows(val, level + 1);
        } else {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td class="attr-key" style="padding-left:${indent}px">${prettyAttributeName(
            key
          )}</td>
            <td class="attr-value">${
              Array.isArray(val) ? val.join(", ") : String(val)
            }</td>`;
          tableEl.appendChild(tr);
        }
      });
    };

    addRows(props);
  }

  // ---------- Index popup-enabled items from config ----------
  #indexPopupEligible() {
    const popupLayers = new Set(); // actual Mapbox layer IDs we should accept
    const popupSources = new Set(); // Mapbox source IDs we should accept
    const labelsByLayer = new Map(); // title by layer id
    const labelsBySource = new Map(); // title by source id

    const visit = (item) => {
      if (!item || !item.source || !item.layers) return;
      if (!item.popup) return; // only items explicitly flagged popup: true
      const title = item.label || null;

      // Source-level enable
      if (item.source.id) {
        popupSources.add(item.source.id);
        if (title) labelsBySource.set(item.source.id, title);
      }
      // Layer-level enable
      item.layers.forEach((l) => {
        if (l && l.id) {
          popupLayers.add(l.id);
          if (title) labelsByLayer.set(l.id, title);
        }
      });
    };

    try {
      Object.values(ncop_menu_items || {}).forEach((category) => {
        Object.values(category || {}).forEach((subcat) => {
          ["toggle", "temporal", "button", "dropdown"].forEach((bucket) => {
            const group = subcat?.[bucket];
            if (!group) return;
            if (bucket === "dropdown" && Array.isArray(group)) return;
            if (typeof group === "object") {
              Object.values(group).forEach((item) => visit(item));
            }
          });
        });
      });
    } catch (err) {
      console.warn("Popup index failed:", err);
    }

    return { popupLayers, popupSources, labelsByLayer, labelsBySource };
  }

  // ---------- Dynamic DEW exposure indexing ----------
  // ---------- Dynamic DEW exposure indexing ----------
  #refreshDynamicExposureLookups() {
    const mapObj = window.exposureLayersMap;
    const count = mapObj instanceof Map ? mapObj.size : 0;
    if (count === this._lastExposureCount) return; // nothing changed

    // Rebuild
    this.dynamicPopupLayers.clear();
    this.dynamicPopupSources.clear();
    this.dynamicTitleByLayer.clear();
    this.dynamicTitleBySource.clear();

    if (mapObj instanceof Map && count > 0) {
      mapObj.forEach(({ layerId, outlineId, sourceId }, exposureId) => {
        let title = `DEW Exposure #${exposureId}`;

        try {
          // Try to fetch the GeoJSON source and extract exposure_remarks from its properties
          const src = this.map?.getSource(sourceId);
          const data = src?.serialized?.data || src?._data || src?.data;
          const features = data?.features || [];
          if (features.length > 0) {
            const remarks = features[0].properties?.exposure_remarks;
            if (
              remarks &&
              typeof remarks === "string" &&
              remarks.trim() !== ""
            ) {
              title = remarks.trim();
            }
          }
        } catch (err) {
          console.warn(
            "⚠️ Could not read exposure_remarks for",
            exposureId,
            err
          );
        }

        if (layerId) {
          this.dynamicPopupLayers.add(layerId);
          this.dynamicTitleByLayer.set(layerId, title);
        }
        if (outlineId) {
          this.dynamicPopupLayers.add(outlineId);
          this.dynamicTitleByLayer.set(outlineId, title);
        }
        if (sourceId) {
          this.dynamicPopupSources.add(sourceId);
          this.dynamicTitleBySource.set(sourceId, title);
        }
      });
    }

    this._lastExposureCount = count;
  }

  // ---------- Map readiness ----------
  #isMapboxMap(obj) {
    return !!(
      obj &&
      typeof obj.on === "function" &&
      typeof obj.project === "function" &&
      typeof obj.getCanvas === "function"
    );
  }

  #deferredBind(candidate) {
    const tryAttach = () => {
      const m = candidate || window.ncop_map || window.map;
      if (this.#isMapboxMap(m)) {
        this.map = m;
        this.#bind();
        return true;
      }
      return false;
    };

    if (tryAttach()) return;

    this._bindRetryTimer = setInterval(() => {
      if (tryAttach()) {
        clearInterval(this._bindRetryTimer);
        this._bindRetryTimer = null;
      }
    }, 100);
  }

  // ---------- Safe query wrapper ----------
  #safeQueryRenderedFeatures(point, options) {
    try {
      if (!this.map) return [];
      // Guard against querying during style churn/initialization
      const style = this.map.getStyle && this.map.getStyle();
      if (!style || !this.map.isStyleLoaded || !this.map.isStyleLoaded())
        return [];
      // Some Mapbox builds throw if internal featuresets not ready; catch hard
      return this.map.queryRenderedFeatures(point, options) || [];
    } catch (err) {
      // Swallow known Mapbox GL edge errors (e.g., “featuresets” undefined)
      // and degrade gracefully.
      return [];
    }
  }

  // ---------- Events ----------
  #bind() {
    // Click: find first popup-eligible feature (vector tile or geojson), skip raster
    this.map.on("click", (e) => {
      // Update dynamic eligibility (DEW) just-in-time
      this.#refreshDynamicExposureLookups();

      const features = this.#safeQueryRenderedFeatures(e.point);
      if (!features || features.length === 0) return this.hide();

      // Prefer items that are explicitly enabled (static or dynamic), never raster
      const chosen = features.find((f) => {
        const layerType = f?.layer?.type;
        if (layerType === "raster") return false;
        const layerId = f?.layer?.id;
        const sourceId = f?.source;
        // static eligibility
        const okStatic =
          (layerId && this.popupLayers.has(layerId)) ||
          (sourceId && this.popupSources.has(sourceId));
        // dynamic DEW eligibility
        const okDynamic =
          (layerId && this.dynamicPopupLayers.has(layerId)) ||
          (sourceId && this.dynamicPopupSources.has(sourceId));
        return okStatic || okDynamic;
      });

      if (!chosen) return this.hide();

      const layerId = chosen?.layer?.id;
      const sourceId = chosen?.source;

      // Title preference: static label → dynamic DEW title → layer/source fallback
      const title =
        this.labelsByLayer.get(layerId) ||
        this.labelsBySource.get(sourceId) ||
        this.dynamicTitleByLayer.get(layerId) ||
        this.dynamicTitleBySource.get(sourceId) ||
        layerId ||
        sourceId ||
        "Feature";

      // Compose properties (do NOT inject config "information"; keep whatever the feature has)
      const properties = { ...(chosen.properties || {}) };

      // Anchor strictly to clicked lngLat
      this.anchorLngLat = e.lngLat;
      this.#setContent({ title, properties });
      this.#show();
      this.#updatePosition();

      // Keep bound to same lngLat on move/zoom/rotate
      this.#attachMoveListeners();
    });

    // Cursor affordance for eligible features
    this.map.on("mousemove", (e) => {
      this.#refreshDynamicExposureLookups();

      const features = this.#safeQueryRenderedFeatures(e.point);
      const hover = features.some((f) => {
        if (f?.layer?.type === "raster") return false;
        const lid = f?.layer?.id;
        const sid = f?.source;
        const okStatic =
          (lid && this.popupLayers.has(lid)) ||
          (sid && this.popupSources.has(sid));
        const okDynamic =
          (lid && this.dynamicPopupLayers.has(lid)) ||
          (sid && this.dynamicPopupSources.has(sid));
        return okStatic || okDynamic;
      });
      this.map.getCanvas().style.cursor = hover ? "pointer" : "";
    });

    // Click outside to hide (with small guard)
    let lastMapClick = 0;
    this.map.on("click", () => (lastMapClick = Date.now()));
    document.addEventListener("mousedown", (ev) => {
      if (Date.now() - lastMapClick < 200) return;
      if (
        !this.popupEl.classList.contains("hidden") &&
        !this.popupEl.contains(ev.target)
      ) {
        this.hide();
      }
    });
  }

  #attachMoveListeners() {
    this.#detachMoveListeners();
    this._moveHandler = () => this.#updatePosition();
    this._zoomHandler = () => this.#updatePosition();
    this._rotateHandler = () => this.#updatePosition();

    this.map.on("move", this._moveHandler);
    this.map.on("zoom", this._zoomHandler);
    this.map.on("rotate", this._rotateHandler);
  }
  #detachMoveListeners() {
    if (this._moveHandler) this.map.off("move", this._moveHandler);
    if (this._zoomHandler) this.map.off("zoom", this._zoomHandler);
    if (this._rotateHandler) this.map.off("rotate", this._rotateHandler);
    this._moveHandler = this._zoomHandler = this._rotateHandler = null;
  }

  // ---------- Positioning ----------
  #updatePosition() {
    if (!this.anchorLngLat) return;
    const p = this.map.project(this.anchorLngLat); // screen pixel in map container coords
    const mapCanvas = this.map.getCanvas();
    const rect = mapCanvas.getBoundingClientRect();
    const left = rect.left + p.x;
    const top = rect.top + p.y;

    const OFFSET_Y = 16; // lift a bit above the clicked point
    this.popupEl.style.left = `${Math.round(left)}px`;
    this.popupEl.style.top = `${Math.round(top - OFFSET_Y)}px`;
  }

  // ---------- Visibility ----------
  #show() {
    this.popupEl.classList.remove("hidden");
    window.ncop_popup_active = true;
  }

  hide() {
    this.popupEl.classList.add("hidden");
    this.anchorLngLat = null;
    this.#detachMoveListeners();
    window.ncop_popup_active = false;
  }
}

// Optional auto-init (safe due to deferred binding)
if (typeof window !== "undefined" && !window.layerAttributePopup) {
  const m = window.ncop_map || window.map;
  window.layerAttributePopup = new LayerAttributePopup(m);
}
