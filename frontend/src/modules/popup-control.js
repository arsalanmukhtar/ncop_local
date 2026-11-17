// popup-control.js
// Standalone popup inspection control that provides manual control over popup display
// Adds a button to navigation panel to toggle "popup inspection mode"
// When active, clicking on any visible layer with popup:true shows its popup instantly

/**
 * PopupControl Class
 *
 * Provides a standalone control button in the navigation panel that allows users to
 * toggle "popup inspection mode". When active:
 * - Cursor changes to crosshair/pointer
 * - Clicking on any popup-enabled layer shows its attributes instantly
 * - Uses existing LayerAttributePopup infrastructure
 * - More performant than automatic popup detection
 */
export class PopupControl {
  #map;
  #isActive = false;
  #button = null;
  #originalCursor = "";
  #clickHandler = null;

  constructor(map) {
    this.#map = map;
    this.#init();
  }

  #init() {
    // Wait for navigation panel to be rendered
    this.#waitForNavigation().then(() => {
      this.#createButton();
      this.#setupEventListeners();
      console.log("✅ PopupControl initialized");
    });
  }

  #waitForNavigation(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const checkNav = () => {
        const navContainer = document.getElementById("navControlsContainer");
        if (navContainer) {
          resolve(navContainer);
        } else {
          setTimeout(checkNav, 100);
        }
      };

      checkNav();

      setTimeout(
        () => reject(new Error("Navigation panel not found")),
        timeout
      );
    });
  }

  #createButton() {
    const navContainer = document.getElementById("navControlsContainer");
    if (!navContainer) return;

    // Find the toggle button (last child)
    const toggleBtn = navContainer.querySelector("#navToggleBtn");

    // Create popup inspection button
    const button = document.createElement("button");
    button.id = "popupInspectBtn";
    button.className = "custom-nav-btn";
    button.title = "Toggle Popup Inspection Mode";
    button.innerHTML = '<i data-lucide="mouse-pointer-click"></i>';

    // Insert before the toggle button
    if (toggleBtn) {
      navContainer.insertBefore(button, toggleBtn);
    } else {
      navContainer.appendChild(button);
    }

    this.#button = button;

    // Initialize lucide icons
    if (window.lucide?.createIcons) {
      window.lucide.createIcons();
    }
  }

  #setupEventListeners() {
    if (!this.#button) return;

    this.#button.addEventListener("click", () => {
      this.toggle();
    });
  }

  toggle() {
    if (this.#isActive) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  activate() {
    if (this.#isActive) return;

    this.#isActive = true;
    this.#button?.classList.add("active");

    // Change cursor to indicate inspection mode
    const canvas = this.#map.getCanvas();
    this.#originalCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";

    // Show notification
    this.#showNotification(
      "Popup Inspection Mode Active - Click any feature to inspect"
    );

    // Setup click handler for inspection
    this.#setupInspectionMode();

    console.log("🔍 Popup inspection mode activated");
  }

  deactivate() {
    if (!this.#isActive) return;

    this.#isActive = false;
    this.#button?.classList.remove("active");

    // Restore cursor
    const canvas = this.#map.getCanvas();
    canvas.style.cursor = this.#originalCursor;

    // Remove click handler
    this.#teardownInspectionMode();

    // Hide any existing popup
    if (window.layerAttributePopup || window.ncop_popup) {
      const popup = window.layerAttributePopup || window.ncop_popup;
      if (popup && typeof popup.hide === "function") {
        popup.hide();
      }
    }

    console.log("❌ Popup inspection mode deactivated");
  }

  #setupInspectionMode() {
    // Create a high-priority click handler for inspection
    this.#clickHandler = async (e) => {
      if (!this.#isActive) return;

      // Get popup instance
      const popup = window.layerAttributePopup || window.ncop_popup;
      if (!popup) {
        console.warn("⚠️ LayerAttributePopup not found");
        this.#showNotification("Popup system not ready", "error");
        return;
      }

      // Query features at click point
      const features = this.#queryFeaturesAtPoint(e.point);

      if (!features || features.length === 0) {
        this.#showNotification("No features found at this location", "info");
        return;
      }

      // Find first popup-eligible feature
      let eligible = null;
      for (const feature of features) {
        if (this.#isFeaturePopupEligible(feature)) {
          eligible = feature;
          break;
        }
      }

      if (!eligible) {
        this.#showNotification(
          "No popup-enabled features at this location",
          "info"
        );
        return;
      }

      // Trigger popup display using the existing system
      const layerId = eligible.layer?.id;
      const sourceId = eligible.source;

      console.log(`🎯 Inspecting: ${layerId || sourceId}`, eligible.properties);

      // Use existing popup infrastructure
      // The popup should have all the logic to display content
      if (typeof popup.showForFeature === "function") {
        popup.showForFeature(eligible, e.lngLat);
      } else {
        // Fallback: manually trigger popup display
        this.#displayPopupForFeature(eligible, e.lngLat, popup);
      }
    };

    // Add click handler with high priority
    this.#map.on("click", this.#clickHandler);
  }

  #teardownInspectionMode() {
    if (this.#clickHandler) {
      this.#map.off("click", this.#clickHandler);
      this.#clickHandler = null;
    }
  }

  #queryFeaturesAtPoint(point) {
    try {
      // Only query if style is ready
      if (!this.#map.isStyleLoaded()) return [];

      return this.#map.queryRenderedFeatures(point) || [];
    } catch (err) {
      console.warn("⚠️ Feature query failed:", err);
      return [];
    }
  }

  #isFeaturePopupEligible(feature) {
    if (!feature || !feature.layer) return false;

    const layerType = feature.layer.type;

    // Skip raster, background, sky layers
    if (
      layerType === "raster" ||
      layerType === "background" ||
      layerType === "sky"
    ) {
      return false;
    }

    const layerId = feature.layer.id;
    const sourceId = feature.source;

    // Check if popup is explicitly enabled for this layer
    const popup = window.layerAttributePopup || window.ncop_popup;
    if (!popup) return false;

    // Check against popup system's layer/source sets
    const explicitlyEligible =
      (layerId && popup.popupLayers?.has(layerId)) ||
      (sourceId && popup.popupSources?.has(sourceId)) ||
      (layerId && popup.dynamicPopupLayers?.has(layerId)) ||
      (sourceId && popup.dynamicPopupSources?.has(sourceId));

    // Check for GDACS layers
    const isGDACS = this.#isGDACSLayer(layerId, sourceId);

    // Check for other clickable layers (like waqi_stations, ffd_data)
    const isClickable = this.#shouldBeClickable(layerId);

    return explicitlyEligible || isGDACS || isClickable;
  }

  #isGDACSLayer(layerId, sourceId) {
    const gdacsPatterns = [
      "gdacs",
      "earthquake",
      "flood",
      "tropical_cyclone",
      "volcano",
      "drought",
      "wildfire",
    ];

    const idStr = (layerId || sourceId || "").toLowerCase();
    return gdacsPatterns.some((pattern) => idStr.includes(pattern));
  }

  #shouldBeClickable(layerId) {
    if (!layerId) return false;

    const clickablePatterns = [
      "waqi_stations",
      "ffd_data",
      "infrastructure",
      "pmd_",
      "exposure",
    ];

    const idStr = layerId.toLowerCase();
    return clickablePatterns.some((pattern) => idStr.includes(pattern));
  }

  #displayPopupForFeature(feature, lngLat, popup) {
    try {
      const layerId = feature.layer?.id;
      const sourceId = feature.source;
      const properties = feature.properties || {};

      // Try to use popup's internal methods
      if (
        typeof popup._setContent === "function" ||
        typeof popup.setContent === "function"
      ) {
        const title = this.#generateTitle(layerId, sourceId);

        const setContentFn = popup._setContent || popup.setContent;
        setContentFn.call(popup, { title, properties });

        popup.anchorLngLat = lngLat;

        if (typeof popup._show === "function") {
          popup._show();
        } else if (typeof popup.show === "function") {
          popup.show();
        }

        if (typeof popup._updatePosition === "function") {
          popup._updatePosition();
        } else if (typeof popup.updatePosition === "function") {
          popup.updatePosition();
        }

        if (typeof popup._attachMoveListeners === "function") {
          popup._attachMoveListeners();
        }
      } else {
        console.warn("⚠️ Unable to display popup - interface not found");
      }
    } catch (err) {
      console.error("❌ Error displaying popup:", err);
    }
  }

  #generateTitle(layerId, sourceId) {
    // Try to get label from popup system
    const popup = window.layerAttributePopup || window.ncop_popup;

    if (popup) {
      if (layerId && popup.labelsByLayer?.has(layerId)) {
        return popup.labelsByLayer.get(layerId);
      }
      if (sourceId && popup.labelsBySource?.has(sourceId)) {
        return popup.labelsBySource.get(sourceId);
      }
    }

    // Fallback to generating from ID
    if (layerId) {
      return layerId
        .replace(/_/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase());
    }

    return "Feature";
  }

  #showNotification(message, type = "info") {
    // Create or get notification element
    let notification = document.getElementById("popup-inspect-notification");

    if (!notification) {
      notification = document.createElement("div");
      notification.id = "popup-inspect-notification";
      notification.style.cssText = `
          position: fixed;
          bottom: 80px;
          right: 20px;
          padding: 12px 20px;
          border-radius: 8px;
          color: white;
          font-size: 13px;
          font-weight: 500;
          z-index: 10000;
          opacity: 0;
          transition: opacity 0.3s;
          pointer-events: none;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;
      document.body.appendChild(notification);
    }

    // Set background based on type
    const colors = {
      info: "#2196F3",
      success: "#4CAF50",
      error: "#F44336",
      warning: "#FF9800",
    };

    notification.style.backgroundColor = colors[type] || colors.info;
    notification.textContent = message;
    notification.style.opacity = "1";

    // Auto-hide after 3 seconds
    setTimeout(() => {
      notification.style.opacity = "0";
    }, 3000);
  }

  // Public methods for external control
  isActive() {
    return this.#isActive;
  }

  destroy() {
    this.deactivate();
    if (this.#button) {
      this.#button.remove();
    }
  }
}

// Auto-initialize when map is ready
if (typeof window !== "undefined") {
  const initPopupControl = () => {
    const map = window.ncop_map || window.map;
    if (map && !window.popupControl) {
      window.popupControl = new PopupControl(map);
      console.log("✅ PopupControl auto-initialized");
    } else if (!map) {
      setTimeout(initPopupControl, 100);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPopupControl);
  } else {
    initPopupControl();
  }
}

export default PopupControl;
