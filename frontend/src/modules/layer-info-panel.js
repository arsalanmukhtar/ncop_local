export class LayerInfoPanel {
  #map;
  #sourceLayerControl;
  #isVisible = false;
  #legendsVisible = new Map(); // Track which legends are visible

  constructor(map, sourceLayerControl) {
    this.#map = map;
    this.#sourceLayerControl = sourceLayerControl;
    this.render();
    this.addEventListeners();
    this.setupLayerChangeListener();
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
      // Collapse layer order panel if open
      const orderPanelDiv = document.querySelector(".custom-layer-control");
      if (
        orderPanelDiv &&
        !orderPanelDiv.classList.contains("panel-collapsed")
      ) {
        orderPanelDiv.classList.add("panel-collapsed");
      }
    });
    // Hide when basemap panel opens
    const basemapToggle = document.getElementById("basemapToggle");
    basemapToggle?.addEventListener("click", () => {
      this.hidePanel();
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
      if (this.#isVisible) setTimeout(() => this.updateLayerList(), 100);
      return result;
    };
    this.#sourceLayerControl.removeLayerByKey = (...args) => {
      const result = originalRemoveLayer(...args);
      if (this.#isVisible) setTimeout(() => this.updateLayerList(), 100);
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

  updateLayerList() {
    const infoList = document.getElementById("layerInfoList");
    if (!infoList) return;
    const activeLayerKeys = this.#sourceLayerControl.getActiveLayerKeys();
    if (activeLayerKeys.length === 0) {
      infoList.innerHTML =
        '<div class="no-layers-message">No active layers</div>';
      return;
    }
    // Show info for each active layer
    const items = activeLayerKeys
      .map((layerKey) => {
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

        return `
                <div class="layer-info-item" data-layer-key="${layerKey}">
                    <div class="layer-info-label">${label}</div>
                    <div class="layer-info-details">${info}</div>
                    ${legendHtml}
                </div>
            `;
      })
      .join("");
    infoList.innerHTML = items;

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
}
