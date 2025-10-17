// main.js (New Dashboard Entry Point)

// --------------------------------------------------------
// --- START: NCOP Storage Manager Integration (The Fix) ---
// --------------------------------------------------------

import NCOPStorageManager from "./local-storage-manager.js"; // ensure .js extension in Vite

// Initialize global storage as early as possible
window.ncop_storage = null;
if (NCOPStorageManager.isAvailable()) {
  window.ncop_storage = new NCOPStorageManager();
} else {
  console.warn(
    "⚠️ LocalStorage not available - user preferences will not be saved"
  );
}

// --------------------------------------------------------
// --- END: NCOP Storage Manager Integration (The Fix) ---
// --------------------------------------------------------

import { MapControls } from "./map-controls.js";
import { NavigationPanel } from "./navigation-panel.js";
import { ProjectionPanel } from "./projection-panel.js";
import { BasemapPanel } from "./basemap-panel.js";
import { SidebarMenu } from "./sidebar-menu.js";
import { UtilityManager } from "./utility-manager.js";
import { UserControl } from "./user-control.js";
import { SourceLayerControl } from "./sourcelayer-control.js";
import { LayerOrderControl } from "./layer-order-control.js";
import { initializeSourceLayerControl } from "./mapbox-functions.js";
import { LayerInfoPanel } from "./layer-info-panel.js";
import LayerAttributePopup from "./layer-attribute-popup.js";

// ---- Mapbox token handling ----
// The entry (dashboard_main.js) already set mapboxgl.accessToken when possible.
// Here we only WARN once if it’s still missing, and we don’t overwrite it.
if (typeof window !== "undefined" && window.mapboxgl) {
  const existing = window.mapboxgl.accessToken || "";
  if (!existing) {
    const fallback =
      (typeof window !== "undefined" && window.MAPBOX_ACCESS_TOKEN) ||
      import.meta.env?.VITE_MAPBOX_ACCESS_TOKEN ||
      "";
    if (fallback) {
      window.mapboxgl.accessToken = fallback;
    } else {
      console.warn(
        "Mapbox token still missing in dashboard module. Check template head or frontend/.env.development"
      );
    }
  }
}

/**
 * Main class to handle setup, initialization, and overall state management.
 */
class DashboardManager {
  #map;
  #storage = window.ncop_storage;
  #mapControls;
  #sourceLayerControl;
  #layerAttributePopup;

  init() {
    if (!window.mapboxgl?.accessToken) {
      console.error(
        "Mapbox access token not found. Please check your environment configuration."
      );
      return;
    }

    this.#initializeMap();

    // Initialize SourceLayerControl for layer management
    this.#sourceLayerControl = new SourceLayerControl(this.#map);
    this.#layerAttributePopup = this.#sourceLayerControl.layerAttributePopup;

    // Initialize SourceLayerControl reference for interaction handlers
    initializeSourceLayerControl(this.#sourceLayerControl);

    this.#map.on("load", this.#onMapLoad.bind(this));
    this.#map.on("moveend", this.#onMapMoveEnd.bind(this));
    this.#map.on("error", this.#handleMapError.bind(this));

    this.#mapControls = new MapControls(this.#map, this.#storage);

    // ProjectionPanel must be initialized before NavigationPanel to pass its instance
    const projectionPanel = new ProjectionPanel(this.#map, this.#mapControls);

    // Initialize UI components
    new NavigationPanel(this.#map, this.#mapControls, projectionPanel);
    new UserControl();
    new BasemapPanel(this.#map, this.#mapControls);
    new LayerOrderControl(this.#map, this.#sourceLayerControl);
    new LayerInfoPanel(this.#map, this.#sourceLayerControl);
    new SidebarMenu();
    new UtilityManager();

    if (this.#storage) {
      this.#storage.updateLastLogin();
    }
  }

  #initializeMap() {
    const savedCenter = this.#storage
      ? this.#storage.getSetting("mapCenter")
      : [74.3, 31.5];
    const savedZoom = this.#storage ? this.#storage.getSetting("mapZoom") : 6;
    const savedProjection = this.#storage
      ? this.#storage.getSetting("mapProjection")
      : "mercator";

    this.#map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/streets-v12", // default
      center: savedCenter,
      zoom: savedZoom,
      projection: savedProjection || "mercator",
      hash: true,
    });
  }

  #onMapLoad() {
    if (this.#storage) {
      const savedBearing = this.#storage.getSetting("mapBearing");
      const savedPitch = this.#storage.getSetting("mapPitch");
      const savedProjection = this.#storage.getSetting("mapProjection");
      const savedTerrain = this.#storage.getSetting("terrainEnabled");
      const labelsEnabled = this.#storage.getLabelsState();

      if (savedBearing !== null || savedPitch !== null) {
        this.#map.setBearing(savedBearing || 0);
        this.#map.setPitch(savedPitch || 0);
      }

      if (savedProjection && savedProjection !== "mercator") {
        setTimeout(
          () => this.#mapControls.changeMapProjection(savedProjection),
          500
        );
      }

      if (savedTerrain) {
        setTimeout(() => this.#mapControls.enableTerrain(), 800);
      }

      if (!labelsEnabled) {
        setTimeout(() => this.#mapControls.toggleMapLabels(false), 1000);
      }
    }
  }

  #onMapMoveEnd() {
    if (this.#storage) {
      this.#storage.saveMapState(this.#map);
    }
  }

  #handleMapError(e) {
    console.error("Map error:", e);
    if (
      e?.error &&
      (e.error.message?.includes("404") ||
        e.error.message?.includes("Not Found") ||
        e.error.message?.includes("style") ||
        e.error.status === 404)
    ) {
      console.warn("Style loading error detected, falling back to streets-v12");
      try {
        this.#map.setStyle("mapbox://styles/mapbox/streets-v12");
        setTimeout(() => {
          document
            .querySelectorAll(".basemap-item")
            .forEach((item) => item.classList.remove("active"));
          document
            .querySelector('.basemap-item[data-style="streets-v12"]')
            ?.classList.add("active");
        }, 100);
      } catch (fallbackError) {
        console.error(
          "Critical error: Cannot load fallback basemap",
          fallbackError
        );
      }
    }
  }
}

// Ensure only one control panel is open at a time inside .map-controls-wrapper
function setupMapControlsExclusivePanels() {
  const wrapper = document.querySelector(".map-controls-wrapper");
  if (!wrapper) return;
  const panels = Array.from(
    wrapper.querySelectorAll(
      ".layer-order-panel, .layer-info-panel, .basemap-panel"
    )
  );
  const buttons = Array.from(
    wrapper.querySelectorAll(
      ".custom-layer-btn, .custom-layer-info-btn, .custom-basemap-btn"
    )
  );
  buttons.forEach((btn, idx) => {
    btn.addEventListener("click", function () {
      panels.forEach((panel, pidx) => {
        if (pidx === idx) {
          panel.classList.toggle("visible");
        } else {
          panel.classList.remove("visible");
        }
      });
    });
  });
}
if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    setupMapControlsExclusivePanels
  );
} else {
  setupMapControlsExclusivePanels();
}

// Global Initialization
document.addEventListener("DOMContentLoaded", function () {
  // lucide shim provided by entry
  if (window.lucide?.createIcons) {
    window.lucide.createIcons();
  }
  new DashboardManager().init();
});
