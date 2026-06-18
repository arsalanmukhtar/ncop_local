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
      // Hide layer style panel
      document.getElementById("layerStylePanel")?.classList.remove("visible");
      document
        .getElementById("layerStyleToggle")
        ?.classList.remove("active-layer-style");
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

// ===========================================================================
// Layer order drag-and-drop panel (previously: layer-order-control.js)
// ===========================================================================

/**
 * Handles layer ordering control with drag-and-drop functionality
 */
export class LayerOrderControl {
    #map;
    #sourceLayerControl;
    #isVisible = false;

    constructor(map, sourceLayerControl) {
        this.#map = map;
        this.#sourceLayerControl = sourceLayerControl;
        this.render();
        this.addEventListeners();
        this.setupLayerChangeListener();
    }
    render() {
        const mapContainer = document.getElementById("map");

        // Check if wrapper already exists
        let controlsWrapper = document.querySelector(".map-controls-wrapper");
        const basemapControl = document.querySelector(".custom-basemap-control");

        if (!controlsWrapper && basemapControl) {
            // Create wrapper div
            controlsWrapper = document.createElement("div");
            controlsWrapper.className = "map-controls-wrapper";

            // Insert wrapper before basemap control
            basemapControl.parentNode.insertBefore(controlsWrapper, basemapControl);

            // Move basemap control into wrapper
            controlsWrapper.appendChild(basemapControl);
        }

        if (controlsWrapper) {
            // Create layer control
            const layerControl = document.createElement("div");
            layerControl.className = "custom-layer-control";
            layerControl.innerHTML = `
                <button id="layerOrderToggle" class="custom-layer-btn" title="Order Toggled Layers">
                    <i data-lucide="bring-to-front"></i>
                </button>
                <div id="layerOrderPanel" class="layer-order-panel">
                    <div class="layer-order-header">
                        <span class="layer-order-title">Layer Order</span>
                        <div class="layer-order-subtitle">Drag to reorder</div>
                    </div>
                    <div id="layerOrderList" class="layer-order-list">
                        <div class="no-layers-message">No active layers</div>
                    </div>
                </div>
            `;

            // Add layer control to wrapper
            controlsWrapper.appendChild(layerControl);

            lucide.createIcons();
        }
    }
    addEventListeners() {
        const layerToggle = document.getElementById("layerOrderToggle");
        const layerPanel = document.getElementById("layerOrderPanel");

        layerToggle?.addEventListener("click", (e) => {
          e.stopPropagation();
          this.togglePanel();
          // Hide layer info panel
          document
            .getElementById("layerInfoPanel")
            ?.classList.remove("visible");
          // Hide layer style panel
          document
            .getElementById("layerStylePanel")
            ?.classList.remove("visible");
          document
            .getElementById("layerStyleToggle")
            ?.classList.remove("active-layer-style");
          // Hide basemap panel
          document.getElementById("basemapPanel")?.classList.remove("visible");
        });

        // Don't close panel when clicking outside - let user manually toggle
        // Only close when basemap panel opens to avoid overlap
        const basemapToggle = document.getElementById("basemapToggle");
        basemapToggle?.addEventListener("click", () => {
            this.hidePanel();
        });

        // Observe user panel changes to adjust wrapper position
        const userPanel = document.getElementById("userPanel");
        if (userPanel) {
            this.observeUserPanel(userPanel);
        }
    }

    observeUserPanel(userPanel) {
        const controlsWrapper = document.querySelector(".map-controls-wrapper");

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (
                    mutation.type === "attributes" &&
                    mutation.attributeName === "class"
                ) {
                    if (userPanel.classList.contains("user-panel-visible")) {
                        controlsWrapper?.classList.add("panel-open");
                        this.hidePanel(); // Hide layer panel when user panel opens
                    } else {
                        controlsWrapper?.classList.remove("panel-open");
                    }
                }
            });
        });
        observer.observe(userPanel, { attributes: true });
    }

    setupLayerChangeListener() {
        // Only update layer list for add/remove, not for temporal animation
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
        const layerPanel = document.getElementById("layerOrderPanel");

        if (this.#isVisible) {
            this.updateLayerList();
            layerPanel.classList.add("visible");
        } else {
            layerPanel.classList.remove("visible");
        }
    }

    hidePanel() {
        this.#isVisible = false;
        const layerPanel = document.getElementById("layerOrderPanel");
        layerPanel?.classList.remove("visible");
    }
    updateLayerList() {
        const layerList = document.getElementById("layerOrderList");
        if (!layerList) return;

        const activeLayerKeys = new Set(
            this.#sourceLayerControl.getActiveLayerKeys()
        );
        const layerOrder = [...this.#sourceLayerControl.layerOrder]; // Get current order from source control

        // Filter to only show active layers and maintain their order
        const orderedActiveLayers = layerOrder.filter((layerKey) =>
            activeLayerKeys.has(layerKey)
        );

        if (orderedActiveLayers.length === 0) {
            layerList.innerHTML =
                '<div class="no-layers-message">No active layers</div>';
            return;
        }

        // Create layer items in reverse order (top layers first in UI)
        const layerItems = orderedActiveLayers
            .slice()
            .reverse()
            .map((layerKey) => {
                const layerInfo = this.#sourceLayerControl.findLayerConfig(layerKey);
                const label = layerInfo?.config?.label || layerKey;

                return `
                <div class="layer-item" data-layer-key="${layerKey}" draggable="true">
                    <div class="layer-drag-handle">
                        <i data-lucide="grip-vertical"></i>
                    </div>
                    <div class="layer-info">
                        <span class="layer-name">${label}</span>
                    </div>
                </div>
            `;
            })
            .join("");

        layerList.innerHTML = layerItems;
        lucide.createIcons();
        this.setupDragAndDrop();
    }
    setupDragAndDrop() {
        const layerItems = document.querySelectorAll(".layer-item");
        let draggedElement = null;

        // console.log(`🔧 Setting up drag and drop for ${layerItems.length} items`);

        layerItems.forEach((item) => {
            item.addEventListener("dragstart", (e) => {
                draggedElement = item;
                item.classList.add("dragging");
                e.dataTransfer.effectAllowed = "move";
                // console.log(`🟢 Drag started for: ${item.dataset.layerKey}`);
            });

            item.addEventListener("dragend", () => {
                item.classList.remove("dragging");
                draggedElement = null;
                // console.log(`🔴 Drag ended for: ${item.dataset.layerKey}`);
            });

            item.addEventListener("dragover", (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                // Add visual feedback
                if (draggedElement && draggedElement !== item) {
                    item.style.borderTop = "2px solid #00ff00";
                }
            });

            item.addEventListener("dragleave", (e) => {
                // Remove visual feedback
                item.style.borderTop = "";
            });

            item.addEventListener("drop", (e) => {
                e.preventDefault();
                // Remove visual feedback
                item.style.borderTop = "";

                if (draggedElement && draggedElement !== item) {
                    // console.log(`🔄 Reordering: ${draggedElement.dataset.layerKey} -> ${item.dataset.layerKey}`);
                    this.reorderLayers(draggedElement, item);
                }
            });
        });
    }
    reorderLayers(draggedItem, targetItem) {
        const draggedKey = draggedItem.dataset.layerKey;
        const targetKey = targetItem.dataset.layerKey;

        // Get the current UI order (which is reversed in display)
        const layerItems = Array.from(document.querySelectorAll(".layer-item"));
        const uiOrder = layerItems.map((item) => item.dataset.layerKey);

        // Convert UI order back to actual layer order (reverse it)
        const actualOrder = [...uiOrder].reverse();

        // Find positions in the actual order
        const draggedIndex = actualOrder.indexOf(draggedKey);
        const targetIndex = actualOrder.indexOf(targetKey);

        if (draggedIndex === -1 || targetIndex === -1) return;

        // Remove dragged item and insert at new position
        actualOrder.splice(draggedIndex, 1);
        actualOrder.splice(targetIndex, 0, draggedKey);

        // Update the source layer control order immediately
        this.#sourceLayerControl.layerOrder = [...actualOrder];

        // Reorder layers on map
        this.applyLayerOrder(actualOrder);

        // Update UI immediately to reflect the new order
        this.updateLayerList();
    }

    applyLayerOrder(newOrder) {
        // Snapshot the live paint/layout of every layer BEFORE we remove
        // anything. LayerStyleConfig writes user customizations straight
        // to the map via setPaintProperty/setLayoutProperty and never
        // mirrors them back to layerInfo.config.layers[]; if we re-added
        // from the original config those customizations would be lost on
        // every reorder. Reading from map.getStyle() captures the current
        // live state (config defaults + any user overrides) so we can
        // replay it exactly when re-adding.
        const liveLayerById = new Map();
        try {
            const style = this.#map.getStyle();
            (style?.layers || []).forEach((l) => liveLayerById.set(l.id, l));
        } catch (e) {
            console.warn("[LayerOrder] getStyle() failed; falling back to config paint/layout:", e);
        }

        // Remove all layers first
        const activeLayers = [...this.#sourceLayerControl.activeLayers.keys()];
        activeLayers.forEach((key) => {
            const layerInfo = this.#sourceLayerControl.activeLayers.get(key);
            if (layerInfo) {
                // Remove layers from map without updating tracking
                layerInfo.layerIds.forEach((layerId) => {
                    if (this.#map.getLayer(layerId)) {
                        this.#map.removeLayer(layerId);
                    }
                });
            }
        }); // Re-add layers in new order
        newOrder.forEach((layerKey) => {
            const layerInfo = this.#sourceLayerControl.activeLayers.get(layerKey);
            if (layerInfo) {
                // Re-add layers to map
                layerInfo.config.layers.forEach((layerConfig) => {
                    const live = liveLayerById.get(layerConfig.id);
                    const paint  = live?.paint  ?? layerConfig.paint;
                    const layout = live?.layout ?? layerConfig.layout;
                    const layer = {
                        id: layerConfig.id,
                        type: layerConfig.type,
                        source: layerInfo.sourceId,
                        ...(layerConfig["source-layer"] && {
                            "source-layer": layerConfig["source-layer"],
                        }),
                        ...(paint  && { paint }),
                        ...(layout && { layout }),
                    };

                    if (!this.#map.getLayer(layerConfig.id)) {
                        this.#map.addLayer(layer);
                    }
                });
            }
        }); // Ensure labels stay on top after reordering
        try {
            if (typeof this.#sourceLayerControl.ensureLabelsOnTop === "function") {
                this.#sourceLayerControl.ensureLabelsOnTop();
            }
        } catch (error) {
            console.warn("Labels on top function not available:", error);
        }
    }
}