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
import "./temporal-controls.js"; // Exposes global time-slider functions
import { initRainViewerPlayer } from "./temporal-controls.js";
import { handleTemporalInteraction } from "./mapbox-functions.js";
// ===================================================

import {
  MapControls,
  initStoryManager,
  startStoryBySlug,
} from "./map-controls.js";
import { NavigationPanel } from "./navigation-panel.js";
import { ProjectionPanel, BasemapPanel, resolveBasemapUrl } from "./map-display-panels.js";
import { SidebarMenu } from "./sidebar-menu.js";
import { UtilityManager } from "./utility-manager.js";
import { UserControl, NCOPTourControl } from "./nav-controls.js";
import { SourceLayerControl } from "./sourcelayer-control.js";
import { LayerInfoPanel, LayerOrderControl } from "./layer-panels.js";
import { initializeSourceLayerControl } from "./mapbox-functions.js";
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
  // Flips true after the first `load` event. Runtime errors fired after
  // this point (missing tile/sprite/image/etc.) must NOT trigger the
  // streets-v12 fallback — doing so would wipe the user's chosen basemap
  // and all the layers they just restored.
  #initialLoadComplete = false;

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

    // Single SourceLayerControl instance — previously two were created and
    // each registered its own map.on("style.load") listener, doubling every
    // preload / restore step.
    this.#sourceLayerControl = new SourceLayerControl(this.#map);
    window.sourceLayerControl = this.#sourceLayerControl;

    // MapControls (your existing)
    const mapControls = new MapControls(window.ncop_map, window.ncop_storage);

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
    new NCOPTourControl();
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

    // Boot the map on the user's last basemap directly — avoids a second
    // setStyle after load which triggers Mapbox's slow "style diff
    // unimplemented, rebuilding from scratch" path.
    const savedBasemap = this.#storage
      ? this.#storage.getSetting("basemapStyle")
      : null;
    const initialStyle = resolveBasemapUrl(savedBasemap || "streets-v12");

    this.#map = new mapboxgl.Map({
      container: "map",
      style: initialStyle,
      center: savedCenter,
      zoom: savedZoom,
      projection: savedProjection || "mercator",
      hash: true,
    });

    // CRITICAL: Expose map globally so slider can access it
    window.ncop_map = this.#map;
  }

  #onMapLoad() {
    this.#initialLoadComplete = true;
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

    // Restore user state (basemap selection, active layers, active temporal).
    this.#restoreUserState();
  }

  /**
   * Restore the user's layers and temporal selection from browser storage.
   * The basemap was already applied in `#initializeMap` via resolveBasemapUrl
   * (the map boots directly on the saved style), so this only handles:
   *   1. Active layers  — replay via sourceLayerControl.addLayerByKey for
   *      each saved key, then sync the sidebar UI (checkbox / .is-selected).
   *      isRestoringLayers suppresses the persist hook during replay.
   *   2. Active temporal layer — click the matching `.ncop-item-temporal`
   *      div so handleTemporalInteraction runs end-to-end.
   * Waits for the sidebar to actually populate before acting — SidebarMenu
   * builds the DOM asynchronously after an `await import('./map-layers.js')`.
   */
  #restoreUserState() {
    if (!this.#storage || !this.#sourceLayerControl) {
      console.warn("[NCOP restore] storage or sourceLayerControl missing");
      return;
    }
    const storage = this.#storage;
    const slc = this.#sourceLayerControl;
    const savedLayers = storage.getSetting("activeLayerKeys") || [];
    const savedTemporal = storage.getSetting("activeTemporalKey");
    console.info("[NCOP restore] reading saved state:", {
      layers: savedLayers,
      temporal: savedTemporal,
    });

    // Poll until a selector appears, then resolve. Returns the element or null.
    const waitForEl = (selector, maxAttempts = 60, interval = 100) =>
      new Promise((resolve) => {
        const tick = (n) => {
          const el = document.querySelector(selector);
          if (el) return resolve(el);
          if (n >= maxAttempts) return resolve(null);
          setTimeout(() => tick(n + 1), interval);
        };
        tick(0);
      });

    // Signal that SidebarMenu.loadSidebarConfig() finished its async populate.
    const waitForSidebarReady = () =>
      waitForEl(
        ".sidebar-content .ncop-item[data-item-key], .sidebar-content input[data-item-key]"
      );

    const applyLayers = async () => {
      if (!Array.isArray(savedLayers) || !savedLayers.length) return;
      // Add layers to the map FIRST — addLayerByKey reads `ncop_menu_items`
      // from memory and doesn't need the sidebar DOM. Sidebar checkbox /
      // is-selected sync happens afterwards (see below) once the async
      // sidebar populate finishes.
      slc.isRestoringLayers = true;
      const added = [];
      try {
        for (const key of savedLayers) {
          let ok = false;
          try {
            ok = await slc.addLayerByKey(key, false);
          } catch (e) {
            console.warn(`[NCOP restore] addLayerByKey('${key}') threw`, e);
          }
          console.info(`[NCOP restore] addLayerByKey('${key}') ->`, ok);
          if (ok) added.push(key);
        }
      } finally {
        slc.isRestoringLayers = false;
      }
      // Sync sidebar UI in the background. If the sidebar never finishes
      // rendering we still have the layers on the map.
      waitForSidebarReady().then(() => {
        for (const key of added) {
          const cb = document.querySelector(`input[data-item-key="${key}"]`);
          if (cb) {
            cb.checked = true;
            continue;
          }
          const div = document.querySelector(
            `.ncop-item[data-item-key="${key}"]`
          );
          if (div) div.classList.add("is-selected");
        }
      });
    };

    const applyTemporal = async () => {
      if (!savedTemporal) return;
      const el = await waitForEl(
        `.ncop-item-temporal[data-item-key="${savedTemporal}"]`
      );
      if (el) {
        console.info(`[NCOP restore] clicking temporal '${savedTemporal}'`);
        el.click();
      } else {
        console.warn(
          `[NCOP restore] temporal item not found: ${savedTemporal}`
        );
      }
    };

    (async () => {
      await applyLayers();
      await applyTemporal();
    })();
  }

  #onMapMoveEnd() {
    if (this.#storage) {
      this.#storage.saveMapState(this.#map);
    }
  }

  #handleMapError(e) {
    console.error("Map error:", e);
    // Only auto-fallback if the INITIAL style never finished loading.
    // Once the map has fired its first `load` event we keep the user's
    // chosen basemap (and the layers we just restored) intact; runtime
    // errors after that are almost always about individual tiles /
    // sprites / icons and must not wipe the map.
    if (this.#initialLoadComplete) {
      return;
    }
    if (
      e?.error &&
      (e.error.message?.includes("404") ||
        e.error.message?.includes("Not Found") ||
        e.error.status === 404)
    ) {
      console.warn(
        "[NCOP] Initial style failed to load, falling back to streets-v12"
      );
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
      ".layer-order-panel, .layer-info-panel, .basemap-panel, .ncop-tour-panel"
    )
  );
  const buttons = Array.from(
    wrapper.querySelectorAll(
      ".custom-layer-btn, .custom-layer-info-btn, .custom-basemap-btn, .custom-tour-btn"
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
