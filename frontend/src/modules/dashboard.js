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

// ========== ADD TIME SLIDER IMPORTS HERE ==========
import {
  generateDWDSatelliteLayers,
  generateECMWFLightningLayers,
  generatePM25Layers,
  generatePM10Layers,
  generateNO2Layers,
  generateSO2Layers,
  generateO3Layers,
  generateCOLayers,
  generateDustLayers,
  generateCH4300Layers,
} from "./time-functions.js";
import "./map-layers.js"; // Exposes window.dwd_satellite_infrared
import "./time-slider-functionality.js"; // Exposes global functions
import { initRainViewerPlayer } from "./rainviewer-player.js";
import { handleTemporalInteraction } from "./mapbox-functions.js";
// ===================================================

import {
  MapControls,
  initStoryManager,
  startStoryBySlug,
} from "./map-controls.js";
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
  #themeToggler;

  init() {
    if (!window.mapboxgl?.accessToken) {
      console.error(
        "Mapbox access token not found. Please check your environment configuration."
      );
      return;
    }

    this.#initializeMap();

    // Expose globals (you already do this)
    window.map = this.#map;
    window.ncop_map = this.#map;

    // Initialize theme toggler early
    this.#themeToggler = new ThemeToggler();

    // SourceLayerControl (your existing)
    const slc = new SourceLayerControl(window.ncop_map);
    window.sourceLayerControl = slc;

    // MapControls (your existing)
    const mapControls = new MapControls(window.ncop_map, window.ncop_storage);

    // Keep your existing initializations…
    this.#sourceLayerControl = new SourceLayerControl(this.#map);
    this.#layerAttributePopup =
      this.#sourceLayerControl.layerAttributePopup ||
      new LayerAttributePopup(this.#map);
    window.layerAttributePopup = this.#layerAttributePopup;
    window.ncop_popup = this.#layerAttributePopup;

    initializeSourceLayerControl(this.#sourceLayerControl);

    this.#map.on("load", this.#onMapLoad.bind(this));
    this.#map.on("moveend", this.#onMapMoveEnd.bind(this));
    this.#map.on("error", this.#handleMapError.bind(this));

    this.#mapControls = new MapControls(this.#map, this.#storage);

    const projectionPanel = new ProjectionPanel(this.#map, this.#mapControls);

    // IMPORTANT: NavigationPanel builds the story modal shell (#story-modal with #story-root)
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

    // ✅ Mount Story UI AFTER the NavigationPanel has created #story-root
    waitForEl("#story-root")
      .then(() => {
        // ✅ Mount Story UI AFTER the NavigationPanel has created #story-root
        const mgr = initStoryManager({
          map: window.ncop_map,
          sourceLayerControl: window.sourceLayerControl, // you created `slc` earlier
          fetchBase: window.baseUrl, // ✅ use your global baseUrl
        });

        // Optional: make a one-liner available globally to start by slug
        window.startStoryBySlug = (slug) => startStoryBySlug(slug, "");

        // Optional auto-start (leave commented to avoid changing behavior)
        // startStoryBySlug('meteorological', '');
      })
      .catch(() => {
        console.warn("Story root not found (timed out).");
      });
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

    // CRITICAL: Expose map globally so slider can access it
    window.ncop_map = this.#map;
    // console.log("✅ Map exposed as window.ncop_map");
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
    // ------------------------------
    // RainViewer Player init (standalone)
    // ------------------------------
    try {
      if (!window.__rvInited) {
        initRainViewerPlayer(this.#map);
        window.__rvInited = true;
      }
    } catch (e) {
      console.warn("RainViewer Player failed to init:", e);
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

// THEME CHANGING TOGGLER
class ThemeToggler {
  #currentTheme = 'day';
  #storage = window.ncop_storage;

  constructor() {
    this.#loadSavedTheme();
    this.#createToggleButton();
    this.#attachEventListeners();
  }

  #loadSavedTheme() {
    if (this.#storage) {
      const savedTheme = this.#storage.getSetting('theme') || 'day';
      this.#currentTheme = savedTheme;
      this.#applyTheme(savedTheme);
    }
  }

  #createToggleButton() {
    // Wait for NCOP container to exist
    const checkForContainer = () => {
      const ncopContainer = document.querySelector('.ncop-container');
      if (ncopContainer) {
        this.#renderToggleButton(ncopContainer);
      } else {
        setTimeout(checkForContainer, 100);
      }
    };
    checkForContainer();
  }

  #renderToggleButton(container) {
    const toggleButton = document.createElement('div');
    toggleButton.className = 'theme-toggle-wrapper';
    toggleButton.innerHTML = `
      <button id="themeToggleBtn" class="theme-toggle-btn" title="Toggle Day/Night Mode">
        <i data-lucide="${this.#currentTheme === 'day' ? 'sun' : 'moon'}" class="theme-icon"></i>
      </button>
    `;
    
    // Insert at the top of the NCOP container
    container.insertBefore(toggleButton, container.firstChild);
    
    // Initialize lucide icons
    if (window.lucide?.createIcons) {
      window.lucide.createIcons();
    }
  }

  #attachEventListeners() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('#themeToggleBtn')) {
        e.preventDefault();
        e.stopPropagation();
        this.#toggleTheme();
      }
    });
  }

  #toggleTheme() {
    const newTheme = this.#currentTheme === 'day' ? 'night' : 'day';
    this.#currentTheme = newTheme;
    this.#applyTheme(newTheme);
    this.#updateButtonIcon();
    this.#saveTheme(newTheme);
  }

  #applyTheme(theme) {
    const htmlElement = document.documentElement;
    if (theme === 'night') {
      htmlElement.setAttribute('data-theme', 'night');
    } else {
      htmlElement.removeAttribute('data-theme');
    }
  }

  #updateButtonIcon() {
    const iconElement = document.querySelector('#themeToggleBtn .theme-icon');
    if (iconElement) {
      // Update the icon attribute
      iconElement.setAttribute('data-lucide', this.#currentTheme === 'day' ? 'sun' : 'moon');
      
      // Recreate the icon
      if (window.lucide?.createIcons) {
        window.lucide.createIcons();
      }
      
      // Update the button title
      const buttonElement = document.getElementById('themeToggleBtn');
      if (buttonElement) {
        buttonElement.setAttribute('title', `Switch to ${this.#currentTheme === 'day' ? 'Night' : 'Day'} Mode`);
      }
    }
  }

  #saveTheme(theme) {
    if (this.#storage) {
      this.#storage.saveSetting('theme', theme);
    }
  }

  // Public method to get current theme
  getCurrentTheme() {
    return this.#currentTheme;
  }
}
// Utility: wait for a DOM element to exist before resolving
function waitForEl(selector, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`waitForEl: Timeout waiting for ${selector}`));
    }, timeout);
  });
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
