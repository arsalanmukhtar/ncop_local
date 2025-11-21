// layer-info-panel.js

import { ncop_menu_items } from "./map-layers.js";

export class LayerInfoPanel {
  #map;
  #sourceLayerControl;
  #isVisible = false;
  #legendsVisible = new Map(); // Track which legends are visible
  #temporalObserver = null; // MutationObserver for temporal items

  constructor(map, sourceLayerControl) {
    this.#map = map;
    this.#sourceLayerControl = sourceLayerControl;
    this.render();
    this.addEventListeners();
    this.setupLayerChangeListener();
    this.setupTemporalLayerMonitoring(); // NEW: Monitor temporal layer changes
  }

  render() {
    let controlsWrapper = document.querySelector(".map-controls-wrapper");
    if (!controlsWrapper) return;

    // Create info control
    const infoControl = document.createElement("div");
    infoControl.className = "custom-layer-info-control";
    infoControl.innerHTML = `
            <button id="layerInfoToggle" class="custom-layer-btn" title="Layer Info">
                <i data-lucide="info"></i>
            </button>
            <div id="layerInfoPanel" class="layer-info-panel">
                <div class="layer-info-header">
                    <span class="layer-info-title">Layer Info</span>
                    <div class="layer-info-subtitle">Details for active layers</div>
                </div>
                <div id="layerInfoList" class="layer-info-list">
                    <div class="no-layers-message">No active layers</div>
                </div>
            </div>
        `;
    controlsWrapper.appendChild(infoControl);
    lucide.createIcons();
  }

  addEventListeners() {
    const infoToggle = document.getElementById("layerInfoToggle");
    const infoPanel = document.getElementById("layerInfoPanel");

    infoToggle?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePanel();
      // Hide layer order panel
      document.getElementById("layerOrderPanel")?.classList.remove("visible");
      // Hide basemap panel
      document.getElementById("basemapPanel")?.classList.remove("visible");
    });

    // Hide when basemap panel opens
    const basemapToggle = document.getElementById("basemapToggle");
    basemapToggle?.addEventListener("click", () => {
      this.hidePanel();
    });

    // Keep existing click listener for backward compatibility
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const temporalImage = target.closest(
        ".ncop-item-temporal .ncop-item-image"
      );
      if (!temporalImage) return;
      if (!this.#isVisible) return;

      // Update after a short delay to let the DOM update
      setTimeout(() => {
        if (!window.isTemporalAnimating) {
          this.updateLayerList();
        }
      }, 150);
    });
  }

  // NEW: Setup MutationObserver to monitor temporal layer state changes
  setupTemporalLayerMonitoring() {
    // Disconnect existing observer if any
    if (this.#temporalObserver) {
      this.#temporalObserver.disconnect();
    }

    // Create a new MutationObserver to watch for class changes on temporal items
    this.#temporalObserver = new MutationObserver((mutations) => {
      // Only process if panel is visible and not animating
      if (!this.#isVisible || window.isTemporalAnimating) return;

      // Check if any mutation affected the 'selected' class on temporal items
      let shouldUpdate = false;
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "class"
        ) {
          const target = mutation.target;
          if (
            target instanceof Element &&
            (target.classList.contains("ncop-item-image") ||
              target.closest(".ncop-item-temporal"))
          ) {
            shouldUpdate = true;
            break;
          }
        }
      }

      if (shouldUpdate) {
        // Debounce the update to avoid multiple rapid calls
        if (this._updateTimeout) {
          clearTimeout(this._updateTimeout);
        }
        this._updateTimeout = setTimeout(() => {
          this.updateLayerList();
        }, 100);
      }
    });

    // Start observing the sidebar for changes
    const observeTarget =
      document.querySelector(".sidebar-panel") || document.body;
    this.#temporalObserver.observe(observeTarget, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
  }

  setupLayerChangeListener() {
    const originalAddLayer = this.#sourceLayerControl.addLayerByKey.bind(
      this.#sourceLayerControl
    );
    const originalRemoveLayer = this.#sourceLayerControl.removeLayerByKey.bind(
      this.#sourceLayerControl
    );

    this.#sourceLayerControl.addLayerByKey = (...args) => {
      const result = originalAddLayer(...args);
      // Only update if not a temporal layer animation
      if (this.#isVisible && !window.isTemporalAnimating) {
        setTimeout(() => this.updateLayerList(), 100);
      }
      return result;
    };

    this.#sourceLayerControl.removeLayerByKey = (...args) => {
      const result = originalRemoveLayer(...args);
      if (this.#isVisible && !window.isTemporalAnimating) {
        setTimeout(() => this.updateLayerList(), 100);
      }
      return result;
    };
  }

  togglePanel() {
    this.#isVisible = !this.#isVisible;
    const infoPanel = document.getElementById("layerInfoPanel");
    if (this.#isVisible) {
      this.updateLayerList();
      infoPanel.classList.add("visible");
    } else {
      infoPanel.classList.remove("visible");
    }
  }

  hidePanel() {
    this.#isVisible = false;
    const infoPanel = document.getElementById("layerInfoPanel");
    infoPanel?.classList.remove("visible");
  }

  toggleLegend(layerKey) {
    const currentState = this.#legendsVisible.get(layerKey) || false;
    this.#legendsVisible.set(layerKey, !currentState);
    this.updateLayerList();
  }

  // PRIVATE: find temporal config in ncop_menu_items based on label
  #findTemporalConfigByLabel(label) {
    if (!label) return null;
    const trimmed = label.trim();
    for (const categoryKey in ncop_menu_items) {
      const category = ncop_menu_items[categoryKey];
      if (!category) continue;

      for (const subcategoryKey in category) {
        const subcategory = category[subcategoryKey];
        if (!subcategory || !subcategory.temporal) continue;

        const temporal = subcategory.temporal;
        for (const temporalKey in temporal) {
          const cfg = temporal[temporalKey];
          if (
            cfg &&
            typeof cfg.label === "string" &&
            cfg.label.trim() === trimmed
          ) {
            return {
              layerKey: temporalKey,
              config: cfg,
              categoryKey,
              subcategoryKey,
            };
          }
        }
      }
    }
    return null;
  }

  // PRIVATE: read active temporal items from sidebar DOM (.selected state)
  #getActiveTemporalConfigsFromDOM() {
    const results = [];
    const seen = new Set();
    const selectedImages = document.querySelectorAll(
      ".ncop-item-temporal .ncop-item-image.selected"
    );

    selectedImages.forEach((imgEl) => {
      const container = imgEl.closest(".ncop-item-temporal");
      if (!container) return;

      const labelEl = container.querySelector(".ncop-item-label");
      const labelText = labelEl?.textContent || "";
      const info = this.#findTemporalConfigByLabel(labelText);
      if (info && !seen.has(info.layerKey)) {
        seen.add(info.layerKey);
        results.push(info);
      }
    });

    return results;
  }

  updateLayerList() {
    // Prevent rerender/scroll-to-top during temporal animation
    if (window.isTemporalAnimating) return;

    const infoList = document.getElementById("layerInfoList");
    if (!infoList) return;

    // --- 1) Standard active layers from SourceLayerControl (toggle/static etc.) ---
    const activeLayerKeys = this.#sourceLayerControl.getActiveLayerKeys();

    // --- 2) Active temporal layers based on sidebar selection ---
    const activeTemporalInfos = this.#getActiveTemporalConfigsFromDOM();

    if (activeLayerKeys.length === 0 && activeTemporalInfos.length === 0) {
      infoList.innerHTML =
        '<div class="no-layers-message">No active layers</div>';
      return;
    }

    const htmlItems = [];

    // Render normal (non-temporal) layers using existing logic
    activeLayerKeys.forEach((layerKey) => {
      const layerInfo = this.#sourceLayerControl.findLayerConfig(layerKey);
      const label = layerInfo?.config?.label || layerKey;
      const info =
        layerInfo?.config?.information || "No information available.";
      const hasLegend = layerInfo?.config?.legend === true;
      const legendPath = layerInfo?.config?.legendPath || null;
      const isLegendVisible = this.#legendsVisible.get(layerKey) || false;

      let legendHtml = "";
      if (hasLegend && legendPath) {
        const legendButtonText = isLegendVisible
          ? "Hide Legend"
          : "Show Legend";
        legendHtml = `
                    <button class="legend-toggle-btn" data-layer-key="${layerKey}">
                        ${legendButtonText}
                    </button>
                    ${
                      isLegendVisible
                        ? `
                        <div class="legend-image-container">
                            <img src="${legendPath}" alt="Legend for ${label}" class="legend-image" />
                        </div>
                    `
                        : ""
                    }
                `;
      }

      htmlItems.push(`
                <div class="layer-info-item" data-layer-key="${layerKey}">
                    <div class="layer-info-label">${label}</div>
                    <div class="layer-info-details">${info}</div>
                    ${legendHtml}
                </div>
            `);
    });

    // Render temporal layers based on sidebar active state
    activeTemporalInfos.forEach(({ layerKey, config }) => {
      const label = config?.label || layerKey;
      const info = config?.information || "No information available.";
      const hasLegend = config?.legend === true;
      const legendPath = config?.legendPath || null;
      const isLegendVisible = this.#legendsVisible.get(layerKey) || false;

      let legendHtml = "";
      if (hasLegend && legendPath) {
        const legendButtonText = isLegendVisible
          ? "Hide Legend"
          : "Show Legend";
        legendHtml = `
                    <button class="legend-toggle-btn" data-layer-key="${layerKey}">
                        ${legendButtonText}
                    </button>
                    ${
                      isLegendVisible
                        ? `
                        <div class="legend-image-container">
                            <img src="${legendPath}" alt="Legend for ${label}" class="legend-image" />
                        </div>
                    `
                        : ""
                    }
                `;
      }

      htmlItems.push(`
                <div class="layer-info-item temporal-layer" data-layer-key="${layerKey}">
                    <div class="layer-info-label">${label} <span class="temporal-indicator">⏱</span></div>
                    <div class="layer-info-details">${info}</div>
                    ${legendHtml}
                </div>
            `);
    });

    infoList.innerHTML = htmlItems.join("");

    // Attach event listeners to legend buttons
    infoList.querySelectorAll(".legend-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const layerKey = btn.getAttribute("data-layer-key");
        this.toggleLegend(layerKey);
      });
    });

    // Dynamically adjust panel size if legends are visible
    this.adjustPanelSize();
  }

  adjustPanelSize() {
    const infoPanel = document.getElementById("layerInfoPanel");
    if (!infoPanel) return;

    // Check if any legend images are visible
    const visibleLegends = infoPanel.querySelectorAll(
      ".legend-image-container"
    );
    if (visibleLegends.length > 0) {
      // Add class to indicate legends are visible (CSS will handle the adjustment)
      infoPanel.classList.add("has-legend");
    } else {
      // Remove class if no legends are visible
      infoPanel.classList.remove("has-legend");
    }
  }

  // NEW: Cleanup method to disconnect observer
  destroy() {
    if (this.#temporalObserver) {
      this.#temporalObserver.disconnect();
      this.#temporalObserver = null;
    }
    if (this._updateTimeout) {
      clearTimeout(this._updateTimeout);
    }
  }
}
