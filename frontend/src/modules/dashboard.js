// main.js (New Dashboard Entry Point)

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
import { ProjectionPanel, BasemapPanel } from "./map-display-panels.js";
import { SidebarMenu } from "./sidebar-menu.js";
import { UserControl, NCOPTourControl } from "./nav-controls.js";
import { GeocoderControl } from "./geocoder-control.js";
import { LayerStyleConfig } from "./layer-style-config.js";
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
  #mapControls;
  #sourceLayerControl;
  #layerAttributePopup;
  #themeToggler;
  // Flips true after the first `load` event. Runtime errors fired after
  // this point (missing tile/sprite/image/etc.) must NOT trigger the
  // streets-v12 fallback — doing so would wipe the user's chosen basemap.
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

    // SourceLayerControl (your existing)
    const slc = new SourceLayerControl(window.ncop_map);
    window.sourceLayerControl = slc;

    // Keep your existing initializations…
    this.#sourceLayerControl = new SourceLayerControl(this.#map);
    this.#layerAttributePopup =
      this.#sourceLayerControl.layerAttributePopup ||
      new LayerAttributePopup(this.#map);
    window.layerAttributePopup = this.#layerAttributePopup;
    window.ncop_popup = this.#layerAttributePopup;

    initializeSourceLayerControl(this.#sourceLayerControl);

    this.#map.on("load", this.#onMapLoad.bind(this));
    this.#map.on("error", this.#handleMapError.bind(this));

    this.#mapControls = new MapControls(this.#map);

    const projectionPanel = new ProjectionPanel(this.#map, this.#mapControls);

    // IMPORTANT: NavigationPanel builds the story modal shell (#story-modal with #story-root)
    new NavigationPanel(this.#map, this.#mapControls, projectionPanel);

    new UserControl();
    // Geocoder search bar — sits between the NCOP card and the menu
    // button.  Mounts after the map is ready (we're already inside
    // init()) and self-positions via CSS.
    new GeocoderControl(this.#map);
    new BasemapPanel(this.#map, this.#mapControls);
    new LayerOrderControl(this.#map, this.#sourceLayerControl);
    new LayerStyleConfig(this.#map, this.#sourceLayerControl);
    new LayerInfoPanel(this.#map, this.#sourceLayerControl);
    new NCOPTourControl();
    new SidebarMenu();

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
    this.#map = new mapboxgl.Map({
      container: "map",
      style: "mapbox://styles/mapbox/streets-v12",
      center: [74.3, 31.5],
      zoom: 6,
      projection: "mercator",
      hash: true,
    });

    // CRITICAL: Expose map globally so slider can access it
    window.ncop_map = this.#map;
  }

  #onMapLoad() {
    this.#initialLoadComplete = true;
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

    // Default-enabled layers. Provincial is added before National so the
    // later-added National stacks above Provincial on the map. The sidebar
    // checkboxes are ticked asynchronously once the sidebar DOM has been
    // built (SidebarMenu populates items after an async import).
    this.#applyDefaultLayers();
  }

  #applyDefaultLayers() {
    const slc = this.#sourceLayerControl;
    if (!slc) return;
    const defaults = ["provincial_boundary", "national_boundary"];

    (async () => {
      for (const key of defaults) {
        try {
          await slc.addLayerByKey(key, false);
        } catch (e) {
          console.warn(`Default layer '${key}' failed to load:`, e);
        }
      }
    })();

    // Tick the sidebar checkboxes once they exist. Poll briefly — the
    // sidebar builds asynchronously.
    const tickCheckboxes = (attempts = 0) => {
      const foundAll = defaults.every((key) =>
        document.querySelector(`input[data-item-key="${key}"]`)
      );
      if (foundAll) {
        defaults.forEach((key) => {
          const cb = document.querySelector(`input[data-item-key="${key}"]`);
          if (cb) cb.checked = true;
        });
        return;
      }
      if (attempts >= 60) return;
      setTimeout(() => tickCheckboxes(attempts + 1), 100);
    };
    tickCheckboxes();
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

  constructor() {
    this.#applyTheme(this.#currentTheme);
    this.#createToggleButton();
    this.#attachEventListeners();
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

/* ============================================================================
 * UNIFIED RIGHT-RAIL CONTROL ARCHITECTURE
 * ============================================================================
 * Merges the three previously separate right-side wrapper groups
 *   .custom-user-control          (user button at top)
 *   .map-controls-wrapper         (layer / info / basemap / tour rail)
 *   .nav-controls-wrapper         (zoom / 3D / wind / ocean / news / chat …)
 * into ONE outer container `.map-right-rail` so every right-side icon
 * lives in a single visual wrapper.
 *
 * Every attached panel (basemap, projection, layer-order, layer-info,
 * tour, user) is moved to be a direct child of #map and given the
 * `.right-rail-panel` class; CSS in _map-panels.css drives a unified
 * slide-from-right animation.  This function below sets each panel's
 * `top` to align with its trigger button and `right` to sit just left
 * of the rail — uniform spacing, uniform timing.
 * ========================================================================= */
const RAIL_PANEL_BUTTON_MAP = {
  userPanel:       { btnId: "userToggle",       visibleClass: "user-panel-visible" },
  geocoderPanel:   { btnId: "geocoderToggle",   visibleClass: "visible" },
  basemapPanel:    { btnId: "basemapToggle",    visibleClass: "visible" },
  projectionPanel: { btnId: "projectionSwitch", visibleClass: "visible" },
  layerOrderPanel: { btnId: "layerOrderToggle", visibleClass: "visible" },
  layerStylePanel: { btnId: "layerStyleToggle", visibleClass: "visible" },
  layerInfoPanel:  { btnId: "layerInfoToggle",  visibleClass: "visible" },
  ncopTourPanel:   { btnId: "ncopTourToggle",   visibleClass: "visible" },
};

function buildUnifiedRightRail() {
  const map = document.getElementById("map");
  if (!map) return;

  let rail = document.querySelector(".map-right-rail");
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "map-right-rail";
    map.appendChild(rail);
  }

  // FLATTEN: pull every button out of its legacy wrapper and append it
  // directly to the rail in this vertical order:
  //   1. nav-toggle (chevron) — pinned to the TOP so collapse hides
  //      every other icon while the toggler stays accessible.
  //   2. user button
  //   3. .map-controls-wrapper buttons (layer-order / info / basemap /
  //      tour) in their original render order.
  //   4. all .custom-nav-btn buttons except the toggler, in their
  //      original DOM order (zoom +/- → compass → 3D → projection →
  //      wind → ocean → sensor → locate → news → chat → osm → home →
  //      story → geoglows → ...).
  // Buttons keep their original IDs and class names so every existing
  // event handler attached during render() continues to fire.
  const buttonOrder = [];
  const seen = new Set();
  const push = (el) => {
    if (el && !seen.has(el)) {
      seen.add(el);
      buttonOrder.push(el);
    }
  };

  push(document.querySelector(".nav-toggle-btn"));
  push(document.querySelector(".custom-user-btn"));
  // Geocoder (map-pin-search) sits directly below the user button —
  // matches the position the user marked between the user icon and
  // the layer-order icon in the rail.
  push(document.querySelector(".custom-geocoder-btn"));

  const mapWrapper = document.querySelector(".map-controls-wrapper");
  if (mapWrapper) {
    // Pushed individually so the layer-style button (palette) can be
    // injected between layer-order and layer-info — matching the spot
    // marked between the two arrow icons in the design.
    push(mapWrapper.querySelector(".custom-layer-btn"));
    push(document.querySelector(".custom-layer-style-btn"));
    push(mapWrapper.querySelector(".custom-layer-info-btn"));
    push(mapWrapper.querySelector(".custom-basemap-btn"));
    push(mapWrapper.querySelector(".custom-tour-btn"));
  }

  // Nav buttons EXCEPT the zoom triplet (zoomIn / zoomOut / resetBearing)
  // and `#osmData` which is non-functional and being removed entirely.
  // The zoom triplet is appended last so it sits at the BOTTOM of the rail.
  const NAV_TAIL_IDS = new Set(["zoomIn", "zoomOut", "resetBearing"]);
  const SKIP_IDS = new Set(["osmData"]);

  document
    .querySelectorAll(".custom-nav-control .custom-nav-btn:not(.nav-toggle-btn)")
    .forEach((btn) => {
      if (SKIP_IDS.has(btn.id) || NAV_TAIL_IDS.has(btn.id)) return;
      push(btn);
    });

  // Append the zoom triplet at the very bottom in canonical order.
  ["zoomIn", "zoomOut", "resetBearing"].forEach((id) => {
    push(document.getElementById(id));
  });

  // Hard-remove the non-functional #osmData button so it can't reappear.
  const osm = document.getElementById("osmData");
  if (osm) osm.remove();

  buttonOrder.forEach((b) => {
    rail.appendChild(b);
    b.classList.add("rail-btn");
  });

  // The legacy wrappers are now empty husks of nested divs — hide them
  // outright so they don't claim layout space anywhere on the map.
  [
    ".custom-user-control",
    ".map-controls-wrapper",
    ".nav-controls-wrapper",
  ].forEach((sel) => {
    const el = document.querySelector(sel);
    if (el) el.style.display = "none";
  });

  // Lift attached panels out of their button containers into #map so
  // they share the unified anchoring + slide-from-right animation.
  Object.keys(RAIL_PANEL_BUTTON_MAP).forEach((panelId) => {
    const p = document.getElementById(panelId);
    if (!p) return;
    if (p.parentElement !== map) map.appendChild(p);
    p.classList.add("right-rail-panel");
  });

  // Wire the chevron toggler.  The original #handleNavToggle in
  // navigation-panel.js still fires (it flips the chevron icon and
  // toggles `.collapsed` on the now-hidden #navControlsContainer); we
  // ALSO toggle `.collapsed` on the rail so the visible UI actually
  // collapses every icon except the toggler itself.
  const toggle = rail.querySelector(".nav-toggle-btn");
  if (toggle && !toggle.dataset.railToggleWired) {
    toggle.dataset.railToggleWired = "true";
    toggle.addEventListener("click", () => {
      rail.classList.toggle("collapsed");
    });
  }
}

function anchorRailPanelsToButtons() {
  const map = document.getElementById("map");
  const rail = document.querySelector(".map-right-rail");
  if (!map || !rail) return;

  const mapRect = map.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  // 8 px of breathing room between the panel and the rail.
  const rightOffset = mapRect.right - railRect.left + 8;

  Object.entries(RAIL_PANEL_BUTTON_MAP).forEach(([panelId, { btnId }]) => {
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!panel || !btn) return;

    const btnRect = btn.getBoundingClientRect();
    panel.style.top = `${btnRect.top - mapRect.top}px`;
    panel.style.right = `${rightOffset}px`;
  });
}

function setupRailPanelAnchoring() {
  const rail = document.querySelector(".map-right-rail");
  if (rail) {
    // Capture phase so anchoring runs BEFORE the button's own click
    // handler toggles `.visible` — otherwise the panel briefly animates
    // from its stale position.
    rail.addEventListener("click", anchorRailPanelsToButtons, true);
  }
  window.addEventListener("resize", anchorRailPanelsToButtons);
  requestAnimationFrame(anchorRailPanelsToButtons);
}

/* ----------------------------------------------------------------------
 * Floating panels — gee-chat-modal, geoglows-forecast-panel, story-modal
 * ----------------------------------------------------------------------
 * These three panels open via inline `style.display = "block/flex"`
 * (not a class toggle), so they fall outside the `.right-rail-panel`
 * system above.  Their original CSS pinned them at fixed map-corner
 * positions (e.g. bottom:13px right:50px), so they no longer line up
 * with their trigger button now that all rail icons are stacked at the
 * top-right.
 *
 * Solution: watch each panel's `style` attribute with a MutationObserver
 * — whenever the panel becomes visible, recompute and apply
 * `top` / `right` to anchor the panel beside its rail button.  CSS
 * also shrinks the panels to compact, consistent sizes so they fit
 * the column gap cleanly.
 * -------------------------------------------------------------------- */
const RAIL_FLOAT_PANEL_BUTTON_MAP = {
  "gee-chat-modal":          "geeChat",
  "geoglows-forecast-panel": "geoglowsForecast",
  "story-modal":             "storyBtn",
};

function anchorFloatingPanelToButton(panel, btnId) {
  const map = document.getElementById("map");
  const rail = document.querySelector(".map-right-rail");
  const btn = document.getElementById(btnId);
  if (!map || !rail || !btn) return;

  const mapRect = map.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();

  panel.style.top = `${btnRect.top - mapRect.top}px`;
  panel.style.right = `${mapRect.right - railRect.left + 8}px`;
  panel.style.left = "auto";
  panel.style.bottom = "auto";
  panel.style.position = "absolute";
}

function setupRailFloatingPanelAnchoring() {
  Object.entries(RAIL_FLOAT_PANEL_BUTTON_MAP).forEach(([panelId, btnId]) => {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    panel.classList.add("right-rail-float-panel");

    // Observe inline `style` changes — panels toggle display:block / flex
    // / none.  Re-anchor every time visibility flips on.
    const observer = new MutationObserver(() => {
      const d = panel.style.display;
      if (d && d !== "none") anchorFloatingPanelToButton(panel, btnId);
    });
    observer.observe(panel, {
      attributes: true,
      attributeFilter: ["style"],
    });

    // Anchor on viewport resize too (rail.left moves when window width
    // changes).
    window.addEventListener("resize", () => {
      const d = panel.style.display;
      if (d && d !== "none") anchorFloatingPanelToButton(panel, btnId);
    });

    // If the panel happens to be visible already when we wire this up.
    const initialDisplay = panel.style.display;
    if (initialDisplay && initialDisplay !== "none") {
      anchorFloatingPanelToButton(panel, btnId);
    }
  });
}

// Global Initialization
document.addEventListener("DOMContentLoaded", function () {
  // lucide shim provided by entry
  if (window.lucide?.createIcons) {
    window.lucide.createIcons();
  }
  new DashboardManager().init();

  // Right-side controls: merge into one rail and unify panel anchoring.
  // Must run AFTER DashboardManager.init() so all wrapper groups exist.
  buildUnifiedRightRail();
  setupRailPanelAnchoring();
  setupRailFloatingPanelAnchoring();
});
