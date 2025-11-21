// LayerOrderControl.js - Manages layer ordering with drag-and-drop functionality

/**
 * Handles layer ordering control with drag-and-drop functionality
 */
export class LayerOrderControl {
    #map;
    #sourceLayerControl;
    #storage = window.ncop_storage;
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
                    const layer = {
                        id: layerConfig.id,
                        type: layerConfig.type,
                        source: layerInfo.sourceId,
                        ...(layerConfig["source-layer"] && {
                            "source-layer": layerConfig["source-layer"],
                        }),
                        ...(layerConfig.paint && { paint: layerConfig.paint }),
                        ...(layerConfig.layout && { layout: layerConfig.layout }),
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