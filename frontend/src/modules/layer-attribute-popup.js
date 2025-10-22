// layer-attribute-popup.js
// Themed popup for displaying vector tile feature attributes on click

class LayerAttributePopup {
  constructor(map, layerConfigs) {
    this.map = map;
    this.layerConfigs = layerConfigs;
    this.popupEl = this._createPopupElement();
    this._bindEvents();
    this._setupDewPolygonClickHandler();
  }

  _createPopupElement() {
    const el = document.createElement("div");
    el.className = "layer-attribute-popup hidden";
    el.innerHTML = '<div class="popup-content"></div>';
    document.body.appendChild(el);
    return el;
  }

  _bindEvents() {
    // Hide popup when clicking outside
    let lastMapClickTime = 0;
    this.map.on("click", () => {
      lastMapClickTime = Date.now();
    });
    document.addEventListener("mousedown", (e) => {
      // Prevent immediate hide after map click
      if (Date.now() - lastMapClickTime < 200) return;
      if (
        !this.popupEl.classList.contains("hidden") &&
        !this.popupEl.contains(e.target)
      ) {
        this.hide();
      }
    });
  }

  /**
   * Setup click handler for DEW exposure polygon layers
   */
  _setupDewPolygonClickHandler() {
    this.map.on("click", (e) => {
      // Query all rendered features at this click point
      const features = this.map.queryRenderedFeatures(e.point);

      if (!features || features.length === 0) {
        this.hide();
        return;
      }

      // Look for DEW polygon layers FIRST (format: exposure-polygon-{id})
      for (const feature of features) {
        // Support both vector tile and GeoJSON features
        const layerId = feature.layer?.id;
        const sourceId = feature.source;
        // Try to match exposure polygons by layerId or sourceId
        let exposureId = null;
        if (layerId && layerId.startsWith("exposure-polygon-")) {
          exposureId = layerId.replace("exposure-polygon-", "");
        } else if (sourceId && sourceId.startsWith("exposure-source-")) {
          exposureId = sourceId.replace("exposure-source-", "");
        }
        if (exposureId) {
          const customConfig = { label: `DEW Exposure #${exposureId}` };
          console.log(`🔍 DEW Polygon clicked: ${layerId || sourceId}`, feature);
          this.show(
            feature,
            `dew_exposure_${exposureId}`,
            e.point,
            customConfig
          );
          // IMPORTANT: Stop here and don't process other layers
          return;
        }
      }
      // If no DEW polygon found, hide popup for non-feature clicks
      // (let vector tile handlers deal with their own layers)
    });

    // Change cursor to pointer when hovering over DEW polygons
    this.map.on("mousemove", (e) => {
      const features = this.map.queryRenderedFeatures(e.point);
      let hasDewPolygon = features?.some(
        (f) => (f.layer?.id && f.layer.id.startsWith("exposure-polygon-")) ||
               (f.source && f.source.startsWith("exposure-source-"))
      );
      this.map.getCanvas().style.cursor = hasDewPolygon ? "pointer" : "";
    });
  }

  show(feature, layerId, clickPoint = null, customConfig = null) {
    // Try to get config from vector tile layers first
    let config = customConfig || this.layerConfigs[layerId];

    // If not found, try to get config from DEW polygons
    if (!config && window.sourceLayerControl && typeof window.sourceLayerControl.getDewPolygonConfigs === 'function') {
      const dewConfigs = window.sourceLayerControl.getDewPolygonConfigs();
      config = dewConfigs[layerId];
    }

    if (!config) {
      console.warn("❌ No config found");
      return;
    }

    const content = this.popupEl.querySelector(".popup-content");

    let html = `<div class="popup-label">${config.label || layerId}</div>`;
    html +=
      '<div class="popup-attributes-scroll"><table class="popup-attributes">';

    // Fallback for missing properties
    const props = feature.properties || {};
    if (Object.keys(props).length === 0) {
      html += `<tr><td colspan="2" class="attr-value">No attributes found</td></tr>`;
    } else {
      // Helper to recursively render nested objects as tables
      function renderNestedTable(obj, level = 0) {
        let rows = "";
        for (const key in obj) {
          const prettyKey = prettyAttributeName(key);
          const value = obj[key];
          if (typeof value === "object" && value !== null) {
            rows += `<tr><td class="attr-key" style="padding-left:${level * 16}px">${prettyKey}</td><td></td></tr>`;
            rows += renderNestedTable(value, level + 1);
          } else {
            rows += `<tr><td class="attr-key" style="padding-left:${level * 16}px">${prettyKey}</td><td class="attr-value">${value}</td></tr>`;
          }
        }
        return rows;
      }
      html += renderNestedTable(props);
    }

    html += "</table></div>";
    content.innerHTML = html;

    // Position popup centered above the clicked point
    if (clickPoint) {
      this.popupEl.style.visibility = "hidden";
      this.popupEl.classList.remove("hidden");

      // Wait for DOM to render to get width/height
      requestAnimationFrame(() => {
        const rect = this.popupEl.getBoundingClientRect();
        const popupWidth = rect.width;
        const popupHeight = rect.height;
        const left = clickPoint.x - popupWidth / 2;
        const top = clickPoint.y - popupHeight - 16;

        this.popupEl.style.left = `${Math.max(left, 8)}px`;
        this.popupEl.style.top = `${Math.max(top, 8)}px`;
        this.popupEl.style.visibility = "visible";
      });
    } else {
      this.popupEl.classList.remove("hidden");
    }

    window.ncop_popup_active = true;
  }

  hide() {
    this.popupEl.classList.add("hidden");
    window.ncop_popup_active = false;
  }
}

function prettyAttributeName(attr) {
  // Replace underscores/dashes with spaces, capitalize each word
  return attr
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default LayerAttributePopup;
