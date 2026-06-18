// NavigationPanel.js - SOUTH ASIA INTEGRATED VERSION
// Handles:
//  - bottom-right map navigation controls (zoom, bearing, 3D toggle, locate, home)
//  - South Asia coordinate jumps
//  - News modal UI (fetch, render, markers, scroll pause, clock)
//  - GEE Chatbot with optimized temporal timeline
// Single source of truth for navigation + news

import { MapControls } from "./map-controls.js";
import Chart from "chart.js/auto";
import {
  toggleWindParticleLayer,
  toggleOceanParticleLayer,
} from "./wind-ocean-particles.js";

const ndmaLogoSrc = new URL(
  "../assets/images/bg_images/ndma-logo.png",
  import.meta.url
).href;

const CUMEC_TO_CUSEC = 35.3147;

/**
 * South Asia Geographic Coordinates
 * Covers: Pakistan, Iran, India, Afghanistan, Bangladesh, Nepal, Sri Lanka, Myanmar,
 *         Thailand, Vietnam, Cambodia, Laos, Malaysia, Singapore, Indonesia, Philippines
 */
const SOUTH_ASIA_COORDS = {
  // Major City Coordinates
  cities: {
    // Pakistan - PRIMARY FOCUS
    islamabad: [73.09896723226383, 33.681421388232],
    karachi: [67.0011, 24.8607],
    lahore: [74.3587, 31.5204],
    peshawar: [71.579, 34.0056],
    quetta: [67.0011, 30.1798],
    gilgit: [74.3144, 35.9216],
    hunza: [74.9227, 36.8527],

    // India
    delhi: [77.1025, 28.7041],
    mumbai: [72.8777, 19.076],
    bangalore: [77.5946, 12.9716],
    kolkata: [88.3639, 22.5726],
    hyderabad: [78.4744, 17.385],
    srinagar: [75.5941, 34.0837],

    // Iran
    tehran: [51.389, 35.6892],
    isfahan: [51.6644, 32.6546],
    mashhad: [59.5671, 36.2605],

    // Afghanistan
    kabul: [69.1761, 34.5553],
    kandahar: [65.7097, 31.6257],
    herat: [62.1977, 34.3425],

    // Bangladesh
    dhaka: [90.3563, 23.8103],
    chittagong: [91.8363, 22.3384],

    // Nepal
    kathmandu: [85.3206, 27.7172],
    pokhara: [83.9863, 28.2096],

    // Sri Lanka
    colombo: [79.8612, 6.9271],
    kandy: [80.6339, 7.2906],

    // Myanmar
    yangon: [96.1951, 16.8661],
    mandalay: [96.0891, 21.9588],

    // Thailand
    bangkok: [100.5018, 13.7563],
    chiang_mai: [98.9853, 18.7883],

    // Vietnam
    hanoi: [105.8342, 21.0285],
    hcmc: [106.6296, 10.8231],

    // Southeast Asia
    singapore: [103.8198, 1.3521],
    kuala_lumpur: [101.6964, 3.139],
    jakarta: [106.8456, -6.2088],
    manila: [121.774, 14.5994],
  },

  // Regional Centers
  regions: {
    pakistan: [69.3451, 30.3753],
    india: [78.9629, 20.5937],
    iran: [53.688, 32.4279],
    afghanistan: [67.709, 33.9391],
    bangladesh: [90.3563, 23.685],
    nepal: [84.124, 28.3949],
    srilanka: [80.7718, 7.8731],
    myanmar: [95.956, 21.9162],
    thailand: [100.9925, 15.87],
    vietnam: [108.2772, 14.0583],
    cambodia: [104.8901, 12.5657],
    laos: [104.1954, 19.8523],
    malaysia: [101.9758, 4.2105],
    singapore: [103.8198, 1.3521],
    indonesia: [113.9213, -0.7893],
    philippines: [121.774, 12.8797],
  },

  // Regional Bounds
  bounds: {
    southAsia: {
      sw: [45, 5], // Southwest corner
      ne: [115, 40], // Northeast corner
    },
    pakistan: {
      sw: [60, 24],
      ne: [77, 37],
    },
    india: {
      sw: [68, 8],
      ne: [97, 36],
    },
  },
};

// ---------------------------------------------
// NEWS STATE + HELPERS
// ---------------------------------------------

// Country → ISO country code (for flags)
const COUNTRY_ISO_MAP = {
  // Primary South Asia
  Pakistan: "PK",
  India: "IN",
  Iran: "IR",
  Afghanistan: "AF",
  Bangladesh: "BD",
  Nepal: "NP",
  "Sri Lanka": "LK",

  // Southeast Asia
  Myanmar: "MM",
  Thailand: "TH",
  Vietnam: "VN",
  Cambodia: "KH",
  Laos: "LA",
  Malaysia: "MY",
  Singapore: "SG",
  Indonesia: "ID",
  Philippines: "PH",

  // Others
  "United States": "US",
  China: "CN",
  Russia: "RU",
  "United Kingdom": "GB",
  Turkey: "TR",
  "Saudi Arabia": "SA",
  Australia: "AU",
  Canada: "CA",
  Brazil: "BR",
  "South Korea": "KR",
  Japan: "JP",
  France: "FR",
  Germany: "DE",
  Italy: "IT",
  Spain: "ES",
  Egypt: "EG",
  Ukraine: "UA",
  Israel: "IL",
  "South Africa": "ZA",
  Norway: "NO",
};

export class NavigationPanel {
  // ============================================================
  // PRIVATE FIELD DECLARATIONS - Must be at class level
  // ============================================================
  #map;
  #mapControls;

  // News-related state
  #newsSelected = {};
  #newsMarkers = {};
  #scrollPaused = false;
  #includeSocialMedia = false;
  #baseUrl = window.location.origin;

  // GEE Chatbot State
  #geeLayers = new Map();
  #chatHistory = [];
  #temporalLayers = {};
  #temporalLayerCache = new Map(); // ✅ Optimized temporal cache
  #geeChatMessages; // ✅ Required for temporal dialog
  #geoglowsMarker = null;
  #geoglowsEnabled = false;
  #geoglowsSelecting = false;
  #geoglowsSelectionHandler = null;
  #geoglowsAbortController = null;
  #geoglowsChartView = false;
  #geoglowsActiveResult = null;
  #geoglowsForecastChart = null;
  #geoglowsStatsChart = null;
  #geoglowsDailyChart = null;
  #geoglowsMonthlyChart = null;
  #geoglowsAnnualChart = null;
  #geoglowsUnit = "cumecs";

  /**
   * @param {mapboxgl.Map} mapInstance
   * @param {MapControls} mapControlsInstance
   * @param {ProjectionPanel} projectionPanelInstance
   */
  constructor(mapInstance, mapControlsInstance, projectionPanelInstance) {
    this.#map = mapInstance;
    this.#mapControls = mapControlsInstance;
    this.projectionPanel = projectionPanelInstance;
    this.#geoglowsSelectionHandler = this.#handleGeoGlowsMapClick.bind(this);

    this.render();
    this.#ensureGeoGlowsStyles();
    this.addEventListeners();
    this.setupNewsIntegration();
    this.#initializeNewsModal();
    this.#initializeGeeChatbot();
    this.#updateNewsClock();

    // keep the live clock running
    setInterval(() => this.#updateNewsClock(), 1000);

    // Sync toggle with current map terrain state
    this.restoreToggle3DState(!!this.#map?.getTerrain?.());
  }

  /**
   * Renders the custom navigation controls
   */
  render() {
    const mapContainer = document.getElementById("map");
    const navWrapper = document.createElement("div");
    navWrapper.className = "nav-controls-wrapper";

    navWrapper.innerHTML = `
      <div class="custom-nav-control" id="navControlsContainer">
          <!-- ZOOM CONTROLS -->
          <button id="zoomIn" class="custom-nav-btn" title="Zoom In">
              <i data-lucide="plus"></i>
          </button>
          <button id="zoomOut" class="custom-nav-btn" title="Zoom Out">
              <i data-lucide="minus"></i>
          </button>
          
          <!-- BEARING RESET -->
          <button id="resetBearing" class="custom-nav-btn" title="Reset Bearing & Tilt">
              <i data-lucide="compass"></i>
          </button>
          
          <!-- 3D TOGGLE -->
          <button id="toggle3D" class="custom-nav-btn" title="Switch to 3D View (2D Mode)">
              <span class="nav-text">3D</span>
          </button>
          
          <!-- PROJECTION SWITCH -->
          <button id="projectionSwitch" class="custom-nav-btn" title="Map Projections">
              <i data-lucide="earth"></i>
          </button>

          <!-- WIND PARTICLES -->
          <button id="windParticles" class="custom-nav-btn" title="Toggle Wind Animation">
              <i data-lucide="wind"></i>
          </button>

          <!-- OCEAN CURRENTS -->
          <button id="oceanParticles" class="custom-nav-btn" title="Toggle Ocean Currents">
              <i data-lucide="waves"></i>
          </button>

          <!-- GEOGLOWS FORECAST -->
          <button id="geoglowsForecast" class="custom-nav-btn" title="GeoGLOWS River Forecast">
              <i data-lucide="activity"></i>
          </button>
          
          <!-- LOCATE USER -->
          <button id="locate" class="custom-nav-btn" title="Find My Location (Islamabad)">
              <i data-lucide="map-pin"></i>
          </button>
          
          <!-- LOCAL NEWS TOGGLE -->
          <button id="localNews" class="custom-nav-btn" title="Toggle Local News Panel">
              <i data-lucide="newspaper"></i>
          </button>
          <!-- GEE CHATBOT TOGGLE -->
          <button id="geeChat" class="custom-nav-btn" title="GEE Data Chatbot">
              <i data-lucide="message-circle"></i>
          </button>
          <!-- OPENSTREETMAP DATA TOGGLE -->
          <button id="osmData" class="custom-nav-btn" title="OpenStreetMap Data">
              <i data-lucide="map"></i>
          </button>
          <!-- HOME EXTENT (Pakistan / South Asia) -->
          <button id="homeExtent" class="custom-nav-btn" title="Zoom to South Asia Region">
              <i data-lucide="house"></i>
          </button>
          <button id="storyBtn" class="custom-nav-btn" title="Open Story Panel">
            <i data-lucide="book-open"></i>
          </button>
          <!-- COLLAPSE/EXPAND -->
          <button id="navToggleBtn" class="nav-toggle-btn" title="Toggle Navigation Controls">
              <i data-lucide="chevron-left"></i>
          </button>
      </div>
    `;

    mapContainer.appendChild(navWrapper);

    //GEE Chatbot modal shell
    const geeChatModal = document.createElement("div");
    geeChatModal.id = "gee-chat-modal";
    geeChatModal.style.display = "none";
    geeChatModal.innerHTML = `
      <div class="gee-chat-header">
        <div class="gee-chat-title">
          <i data-lucide="satellite" style="width:18px;height:18px"></i>
          <span>Earth Engine Data Assistant</span>
        </div>
        <button id="geeChatClose">
          <i data-lucide="x"></i>
        </button>
      </div>
      
      <div class="gee-chat-messages" id="geeChatMessages"></div>
      
      <div class="gee-chat-input-wrapper">
        <input type="text" 
              id="geeChatInput" 
              placeholder="Ask for data…"
              autocomplete="off"
              data-lpignore="true"
              data-form-type="other"
              data-1p-ignore="true">
        <button id="geeChatSend">
          <i data-lucide="send"></i>
        </button>
      </div>
    `;
    mapContainer.appendChild(geeChatModal);

    const geoglowsModal = document.createElement("div");
    geoglowsModal.id = "geoglows-forecast-panel";
    geoglowsModal.style.display = "none";
    geoglowsModal.innerHTML = `
      <div class="geoglows-panel-shell">
        <div class="geoglows-panel-header">
          <div class="geoglows-panel-logo">
            <img src="${ndmaLogoSrc}" alt="NDMA Logo">
          </div>
          <div class="geoglows-panel-info">
            <div class="geoglows-panel-kicker">GeoGLOWS Monitoring</div>
            <div class="geoglows-panel-title">River Forecast</div>
            <div class="geoglows-panel-subtitle">Click the map near a river reach to load the nearest forecast and streamflow statistics from GeoGLOWS.</div>
          </div>
        </div>
        <div class="geoglows-panel-actions">
          <div class="geoglows-panel-label-wrap">
            <div class="geoglows-panel-label-caption">Mode</div>
            <div class="geoglows-panel-label" id="geoglowsModeLabel">Ready</div>
          </div>
          <div class="geoglows-panel-button-row">
            <button type="button" class="geoglows-view-btn" id="geoglowsViewToggleBtn" disabled>Chart View</button>
            <button type="button" class="geoglows-unit-btn" id="geoglowsUnitToggleBtn" disabled>Show ft³/s</button>
            <button type="button" class="geoglows-clear-btn" id="geoglowsClearBtn">Clear</button>
          </div>
        </div>
        <div class="geoglows-panel-body" id="geoglowsPanelBody">
          <div class="geoglows-empty-state">
            <div class="geoglows-empty-title">GeoGLOWS is ready</div>
            <div class="geoglows-empty-copy">Use the GeoGLOWS control, then click a location on the map near a river to resolve the nearest reach ID and open the forecast panels.</div>
          </div>
        </div>
      </div>
    `;
    mapContainer.appendChild(geoglowsModal);

    // Story modal shell (kept dumb; logic handled elsewhere)
    const storyModal = document.createElement("div");
    storyModal.id = "story-modal";
    storyModal.style.cssText = `
    position: absolute; right: 50px; bottom: 72px; z-index: 3;
    display: none; width: 380px; max-height: 70vh; overflow: auto;
    background: rgba(20,20,24,.96); border: 1px solid #2a2a2a; border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,.35); color: #eaeaea; backdrop-filter: blur(6px);
    transition: all 0.3s ease;
  `;
    storyModal.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #2a2a2a">
        <div>
          <div style="font-weight:700;font-size:14px">Story</div>
          <div style="font-size:11px;opacity:.7">Create, pick and play interactive chapters</div>
        </div>
        <button id="storyCloseBtn" class="custom-nav-btn" title="Close"><i data-lucide="x"></i></button>
      </div>
      <div id="story-root" style="padding:10px 12px;"></div>
    `;
    mapContainer.appendChild(storyModal);
    lucide.createIcons();
  }

  /**
   * Add event listeners to all navigation buttons
   */
  addEventListeners() {
    // Navigation Toggle
    document
      .getElementById("navToggleBtn")
      ?.addEventListener("click", this.#handleNavToggle.bind(this));

    // Zoom Controls
    document.getElementById("zoomIn")?.addEventListener("click", () => {
      this.#map.zoomIn({ duration: 300 });
    });

    document.getElementById("zoomOut")?.addEventListener("click", () => {
      this.#map.zoomOut({ duration: 300 });
    });

    // Bearing Reset
    document
      .getElementById("resetBearing")
      ?.addEventListener("click", this.#handleResetBearing.bind(this));

    // 3D Toggle
    document
      .getElementById("toggle3D")
      ?.addEventListener("click", this.#handleToggle3D.bind(this));

    // Projection Switch
    document
      .getElementById("projectionSwitch")
      ?.addEventListener("click", () => {
        if (this.projectionPanel) {
          this.projectionPanel.togglePanel();
        }
      });

    // Locate (Default to Islamabad - Pakistan capital)
    document
      .getElementById("locate")
      ?.addEventListener("click", this.#handleLocate.bind(this));

    // Wind particles
    document.getElementById("windParticles")?.addEventListener("click", () => {
      const isOn = toggleWindParticleLayer();
      document.getElementById("windParticles")?.classList.toggle("active-wind", isOn);
    });

    // Ocean particles
    document.getElementById("oceanParticles")?.addEventListener("click", () => {
      const isOn = toggleOceanParticleLayer();
      document
        .getElementById("oceanParticles")
        ?.classList.toggle("active-ocean", isOn);
    });

    document
      .getElementById("geoglowsForecast")
      ?.addEventListener("click", this.#handleGeoGlowsToggle.bind(this));

    document
      .getElementById("geoglowsClearBtn")
      ?.addEventListener("click", () => this.#clearGeoGlowsState());

    document
      .getElementById("geoglowsViewToggleBtn")
      ?.addEventListener("click", () => this.#toggleGeoGlowsView());

    document
      .getElementById("geoglowsUnitToggleBtn")
      ?.addEventListener("click", () => this.#toggleGeoGlowsUnit());

    // Home Extent (South Asia)
    document
      .getElementById("homeExtent")
      ?.addEventListener("click", this.#handleHomeExtent.bind(this));

    // Local News Toggle
    document
      .getElementById("localNews")
      ?.addEventListener("click", this.#handleNewsToggle.bind(this));

    // GEE Chat button
    document
      .getElementById("geeChat")
      ?.addEventListener("click", this.#handleGeeChatToggle.bind(this));

    // Story button
    document.getElementById("storyBtn")?.addEventListener("click", () => {
      const modal = document.getElementById("story-modal");
      if (!modal) return;
      modal.style.display =
        modal.style.display === "none" || !modal.style.display
          ? "block"
          : "none";
    });

    document.getElementById("storyCloseBtn")?.addEventListener("click", () => {
      const modal = document.getElementById("story-modal");
      if (modal) modal.style.display = "none";
    });
  }

  /**
   * Setup news modal reference + default hidden state
   */
  setupNewsIntegration() {
    const newsModal = document.getElementById("news-modal");
    const localNewsBtn = document.getElementById("localNews");

    if (!newsModal) {
      console.warn("⚠️ News modal not found in DOM");
      return;
    }

    // Keep reference for later usage
    this.newsModal = newsModal;

    // Start hidden
    newsModal.style.display = "none";
    localNewsBtn?.classList.remove("active-news");
  }

  /**
   * Handle navigation panel collapse/expand
   */
  #handleNavToggle() {
    const navControlsContainer = document.getElementById(
      "navControlsContainer"
    );
    const isCollapsed = navControlsContainer.classList.toggle("collapsed");
    const toggleIcon = document
      .getElementById("navToggleBtn")
      ?.querySelector("i");

    if (toggleIcon) {
      toggleIcon.setAttribute(
        "data-lucide",
        isCollapsed ? "chevron-right" : "chevron-left"
      );
      lucide.createIcons();
    }
  }

  /**
   * Handle bearing reset
   */
  #handleResetBearing() {
    this.#map.easeTo({
      bearing: 0,
      pitch: 0,
      duration: 500,
    });
  }

  /**
   * Handle 3D toggle
   */
  #handleToggle3D() {
    const currentTerrain = !!this.#map?.getTerrain?.();
    const newTerrainState = !currentTerrain;

    if (newTerrainState) {
      this.#mapControls.enableTerrain();
    } else {
      this.#mapControls.disableTerrain();
    }

    this.restoreToggle3DState(newTerrainState);
  }

  /**
   * Handle locate button - Default to Islamabad, Pakistan
   */
  #handleLocate() {
    const islamabadCoords = SOUTH_ASIA_COORDS.cities.islamabad;

    this.#map.flyTo({
      center: islamabadCoords,
      zoom: 12,
      duration: 2000,
      essential: true,
    });

    // Add marker at Islamabad
    new mapboxgl.Marker({ color: "#ff4500" })
      .setLngLat(islamabadCoords)
      .setPopup(
        new mapboxgl.Popup({ className: "ncop-popup-host", maxWidth: "320px" }).setHTML(
          `<div class="ncop-popup ncop-popup--compact">
            <div class="ncop-popup__header">
              <div class="ncop-popup__title-block">
                <div class="ncop-popup__title">📍 Islamabad</div>
                <div class="ncop-popup__subtitle">Capital of Pakistan</div>
              </div>
            </div>
            <div class="ncop-popup__body">
              <div class="ncop-popup__info">
                <p class="ncop-popup__info-row">Your Location Marker</p>
              </div>
            </div>
          </div>`
        )
      )
      .addTo(this.#map);
  }

  /**
   * Handle home extent - Zoom to South Asia region
   */
  #handleHomeExtent() {
    // Zoom to Pakistan center
    const pakistanCenter = SOUTH_ASIA_COORDS.regions.pakistan;
    this.#map.flyTo({
      center: pakistanCenter,
      zoom: 5,
      duration: 1500,
      essential: true,
    });
  }

  /**
   * Handle local news toggle (show/hide panel)
   */
  #handleNewsToggle() {
    const localNewsBtn = document.getElementById("localNews");
    const newsModal = document.getElementById("news-modal");

    if (!newsModal) {
      console.warn("⚠️ News modal not found");
      return;
    }

    const isVisible = newsModal.style.display === "flex";

    if (isVisible) {
      newsModal.style.display = "none";
      localNewsBtn?.classList.remove("active-news");
    } else {
      newsModal.style.display = "flex";
      localNewsBtn?.classList.add("active-news");
    }
  }

  /**
   * Restore 3D toggle button state
   * @param {boolean} terrainEnabled
   */
  restoreToggle3DState(terrainEnabled) {
    const button = document.getElementById("toggle3D");
    if (button) {
      if (terrainEnabled) {
        button.title = "Switch to 2D View (3D Mode Enabled)";
        button.classList.add("terrain-active");
      } else {
        button.title = "Switch to 3D View (2D Mode)";
        button.classList.remove("terrain-active");
      }
    }
  }

  #ensureGeoGlowsStyles() {
    if (document.getElementById("geoglows-control-styles")) return;

    const style = document.createElement("style");
    style.id = "geoglows-control-styles";
    style.textContent = `
      .custom-nav-btn.active-geoglows {
        background: var(--ndma-blue) !important;
        border-color: var(--ndma-blue) !important;
        box-shadow: 0 0 12px var(--ndma-blue-glow) !important;
        color: #fff !important;
      }

      #geoglows-forecast-panel {
        position: absolute;
        right: 54px;
        bottom: 72px;
        z-index: 1002;
        width: min(780px, calc(100vw - 96px));
        max-height: 72vh;
        overflow: auto;
      }

      .geoglows-panel-shell {
        background: rgba(15, 23, 42, 0.96);
        color: rgb(226, 232, 240);
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 18px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
        padding: 14px;
        backdrop-filter: blur(14px);
      }

      .geoglows-panel-header {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-bottom: 12px;
      }

      .geoglows-panel-logo {
        width: 56px;
        height: 56px;
        flex: 0 0 56px;
        border-radius: 14px;
        background: linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(34, 197, 94, 0.12));
        border: 1px solid rgba(148, 163, 184, 0.2);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .geoglows-panel-logo img {
        width: 42px;
        height: 42px;
        object-fit: contain;
      }

      .geoglows-panel-kicker {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #7dd3fc;
      }

      .geoglows-panel-title {
        font-size: 22px;
        font-weight: 800;
        line-height: 1.1;
        margin-top: 2px;
      }

      .geoglows-panel-subtitle {
        margin-top: 4px;
        color: #cbd5e1;
        font-size: 13px;
        line-height: 1.5;
      }

      .geoglows-panel-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }

      .geoglows-panel-label-wrap {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .geoglows-panel-label-caption {
        color: #94a3b8;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .geoglows-panel-label {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 32px;
        padding: 7px 12px;
        border-radius: 999px;
        background: rgba(37, 99, 235, 0.18);
        border: 1px solid rgba(96, 165, 250, 0.28);
        color: #e0f2fe;
        font-weight: 700;
        font-size: 12px;
      }

      .geoglows-clear-btn {
        border: none;
        border-radius: 10px;
        padding: 8px 14px;
        background: linear-gradient(135deg, #ef4444, #dc2626);
        color: #fff;
        font-weight: 700;
        cursor: pointer;
      }

      .geoglows-panel-button-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .geoglows-view-btn {
        border: 1px solid rgba(96, 165, 250, 0.32);
        border-radius: 10px;
        padding: 8px 14px;
        background: linear-gradient(135deg, rgba(37, 99, 235, 0.2), rgba(14, 165, 233, 0.16));
        color: #e0f2fe;
        font-weight: 700;
        cursor: pointer;
      }

      .geoglows-view-btn.is-chart {
        background: linear-gradient(135deg, rgba(34, 197, 94, 0.26), rgba(59, 130, 246, 0.22));
        border-color: rgba(74, 222, 128, 0.3);
      }

      .geoglows-unit-btn {
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 10px;
        padding: 8px 14px;
        background: linear-gradient(135deg, rgba(51, 65, 85, 0.55), rgba(30, 41, 59, 0.7));
        color: #f8fafc;
        font-weight: 700;
        cursor: pointer;
      }

      .geoglows-panel-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .geoglows-panel-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .geoglows-chart-stack {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
      }

      .geoglows-subgrid-3 {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }

      .geoglows-chart-card {
        background: rgba(15, 23, 42, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 14px;
        padding: 12px;
      }

      .geoglows-chart-card h4 {
        margin: 0 0 4px;
        font-size: 15px;
        font-weight: 800;
        color: #f8fafc;
      }

      .geoglows-chart-card p {
        margin: 0 0 12px;
        color: #cbd5e1;
        font-size: 12px;
        line-height: 1.45;
      }

      .geoglows-chart-wrap {
        position: relative;
        width: 100%;
        min-height: 240px;
      }

      .geoglows-chart-wrap canvas {
        width: 100% !important;
        height: 240px !important;
      }

      .geoglows-panel-card {
        background: rgba(15, 23, 42, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 14px;
        padding: 12px;
      }

      .geoglows-panel-card h4 {
        margin: 0 0 4px;
        font-size: 15px;
        font-weight: 800;
        color: #f8fafc;
      }

      .geoglows-panel-card p {
        margin: 0 0 10px;
        color: #cbd5e1;
        font-size: 12px;
        line-height: 1.45;
      }

      .geoglows-metadata-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }

      .geoglows-metadata-item {
        background: rgba(30, 41, 59, 0.72);
        border: 1px solid rgba(148, 163, 184, 0.14);
        border-radius: 12px;
        padding: 10px;
      }

      .geoglows-metadata-label {
        display: block;
        color: #94a3b8;
        font-size: 11px;
        margin-bottom: 5px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .geoglows-metadata-value {
        color: #f8fafc;
        font-weight: 700;
        font-size: 13px;
        word-break: break-word;
      }

      .geoglows-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      .geoglows-table th,
      .geoglows-table td {
        padding: 7px 0;
        border-bottom: 1px solid rgba(148, 163, 184, 0.12);
        text-align: left;
      }

      .geoglows-table th {
        color: #93c5fd;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .geoglows-table td:last-child,
      .geoglows-table th:last-child {
        text-align: right;
      }

      .geoglows-mini-group + .geoglows-mini-group {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid rgba(148, 163, 184, 0.12);
      }

      .geoglows-mini-title {
        font-weight: 700;
        font-size: 12px;
        color: #e2e8f0;
        margin-bottom: 6px;
      }

      .geoglows-empty-state,
      .geoglows-loading-state,
      .geoglows-error-state {
        padding: 18px;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.14);
        background: rgba(15, 23, 42, 0.72);
      }

      .geoglows-empty-title,
      .geoglows-loading-title,
      .geoglows-error-title {
        font-size: 16px;
        font-weight: 800;
        color: #f8fafc;
        margin-bottom: 6px;
      }

      .geoglows-empty-copy,
      .geoglows-loading-copy,
      .geoglows-error-copy {
        font-size: 13px;
        color: #cbd5e1;
        line-height: 1.5;
      }

      .geoglows-loading-spinner {
        width: 18px;
        height: 18px;
        border: 2px solid rgba(148, 163, 184, 0.3);
        border-top-color: #38bdf8;
        border-radius: 999px;
        display: inline-block;
        margin-right: 8px;
        vertical-align: middle;
        animation: ncop-spin 0.7s linear infinite;
      }

      @media (max-width: 900px) {
        #geoglows-forecast-panel {
          right: 50px;
          width: min(540px, calc(100vw - 80px));
        }

        .geoglows-panel-grid,
        .geoglows-metadata-grid,
        .geoglows-subgrid-3 {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 640px) {
        #geoglows-forecast-panel {
          right: 12px;
          left: 12px;
          bottom: 72px;
          width: auto;
        }

        .geoglows-panel-header,
        .geoglows-panel-actions {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    `;
    document.head.appendChild(style);
  }

  #handleGeoGlowsToggle() {
    if (this.#geoglowsEnabled) {
      this.#clearGeoGlowsState();
      return;
    }

    this.#geoglowsEnabled = true;
    this.#geoglowsSelecting = true;
    document
      .getElementById("geoglowsForecast")
      ?.classList.add("active-geoglows");
    this.#setGeoGlowsModeLabel("Select River");
    this.#setGeoGlowsMapCursor("crosshair");
    this.#showGeoGlowsPanel();
    this.#setGeoGlowsBody(`
      <div class="geoglows-loading-state">
        <div class="geoglows-loading-title"><span class="geoglows-loading-spinner"></span>GeoGLOWS selection mode enabled</div>
        <div class="geoglows-loading-copy">Click a point on the map near a river reach. NCOP will resolve the nearest GeoGLOWS river ID, place a marker, and fetch the forecast panels.</div>
      </div>
    `);
    this.#map.off("click", this.#geoglowsSelectionHandler);
    this.#map.on("click", this.#geoglowsSelectionHandler);
  }

  #handleGeoGlowsMapClick(event) {
    if (!this.#geoglowsEnabled) return;
    this.#loadGeoGlowsForecast(event.lngLat);
  }

  async #loadGeoGlowsForecast(lngLat) {
    this.#geoglowsSelecting = false;
    this.#map.off("click", this.#geoglowsSelectionHandler);
    this.#setGeoGlowsMapCursor("");
    this.#setGeoGlowsModeLabel("Loading");
    this.#destroyGeoGlowsCharts();
    this.#geoglowsActiveResult = null;
    this.#geoglowsChartView = false;
    this.#geoglowsUnit = "cumecs";
    this.#updateGeoGlowsViewToggle();
    this.#updateGeoGlowsUnitToggle();
    this.#setGeoGlowsMarker(lngLat);
    this.#setGeoGlowsBody(`
      <div class="geoglows-loading-state">
        <div class="geoglows-loading-title"><span class="geoglows-loading-spinner"></span>Loading GeoGLOWS forecast</div>
        <div class="geoglows-loading-copy">Resolving the nearest stream reach and fetching forecast summary plus ensemble statistics for the selected location.</div>
      </div>
    `);

    this.#geoglowsAbortController?.abort();
    this.#geoglowsAbortController = new AbortController();

    try {
      const riverRes = await fetch(
        `${this.#baseUrl}/get-geoglows-riverid/?lat=${encodeURIComponent(
          lngLat.lat
        )}&lon=${encodeURIComponent(lngLat.lng)}`,
        { signal: this.#geoglowsAbortController.signal }
      );
      const riverData = await riverRes.json();
      if (!riverRes.ok || !riverData?.river_id) {
        throw new Error(riverData?.detail || "Unable to resolve GeoGLOWS river ID");
      }

      const riverId = riverData.river_id;
      const [forecastRes, statsRes, dailyRes, monthlyRes, annualRes] = await Promise.all([
        fetch(`${this.#baseUrl}/get-geoglows-forecast/${riverId}/`, {
          signal: this.#geoglowsAbortController.signal,
        }),
        fetch(`${this.#baseUrl}/get-geoglows-forecaststats/${riverId}/`, {
          signal: this.#geoglowsAbortController.signal,
        }),
        fetch(`${this.#baseUrl}/get-geoglows-dailyaverages/${riverId}/`, {
          signal: this.#geoglowsAbortController.signal,
        }),
        fetch(`${this.#baseUrl}/get-geoglows-monthlyaverages/${riverId}/`, {
          signal: this.#geoglowsAbortController.signal,
        }),
        fetch(`${this.#baseUrl}/get-geoglows-annualaverages/${riverId}/`, {
          signal: this.#geoglowsAbortController.signal,
        }),
      ]);

      const [forecastData, statsData, dailyData, monthlyData, annualData] = await Promise.all([
        forecastRes.json(),
        statsRes.json(),
        dailyRes.json(),
        monthlyRes.json(),
        annualRes.json(),
      ]);

      if (!forecastRes.ok) {
        throw new Error(
          forecastData?.detail || "Unable to load GeoGLOWS forecast data"
        );
      }
      if (!statsRes.ok) {
        throw new Error(
          statsData?.detail || "Unable to load GeoGLOWS forecast statistics"
        );
      }

      const averageWarnings = [];
      const safeDailyData = dailyRes.ok
        ? dailyData
        : (averageWarnings.push(
            dailyData?.detail || "Daily averages were unavailable for this reach."
          ),
          null);
      const safeMonthlyData = monthlyRes.ok
        ? monthlyData
        : (averageWarnings.push(
            monthlyData?.detail || "Monthly averages were unavailable for this reach."
          ),
          null);
      const safeAnnualData = annualRes.ok
        ? annualData
        : (averageWarnings.push(
            annualData?.detail || "Annual averages were unavailable for this reach."
          ),
          null);

      this.#renderGeoGlowsResults({
        riverId,
        point: { lon: lngLat.lng, lat: lngLat.lat },
        forecast: forecastData,
        stats: statsData,
        daily: safeDailyData,
        monthly: safeMonthlyData,
        annual: safeAnnualData,
        averageWarnings,
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      this.#setGeoGlowsModeLabel("Error");
      this.#setGeoGlowsBody(`
        <div class="geoglows-error-state">
          <div class="geoglows-error-title">GeoGLOWS request failed</div>
          <div class="geoglows-error-copy">${this.#escapeHtml(
            error?.message || "An unexpected error occurred while loading GeoGLOWS."
          )}</div>
        </div>
      `);
    }
  }

  #renderGeoGlowsResults({
    riverId,
    point,
    forecast,
    stats,
    daily,
    monthly,
    annual,
    averageWarnings = [],
  }) {
    const forecastSeries = this.#extractGeoGlowsSeries(
      forecast?.raw ?? forecast,
      ["forecast", "average_flow", "mean"]
    );
    const statGroups = this.#extractGeoGlowsStatGroups(stats?.raw ?? stats);
    const dailySeries = this.#extractGeoGlowsSeries(daily?.raw ?? daily);
    const monthlySeries = this.#extractGeoGlowsSeries(monthly?.raw ?? monthly);
    const annualSeries = this.#extractGeoGlowsSeries(annual?.raw ?? annual);
    this.#geoglowsActiveResult = {
      riverId,
      point,
      forecastSeries,
      statGroups,
      dailySeries,
      monthlySeries,
      annualSeries,
      averageWarnings,
    };

    this.#renderGeoGlowsActiveView();
  }

  #renderGeoGlowsActiveView() {
    if (!this.#geoglowsActiveResult) return;
    if (this.#geoglowsChartView) {
      this.#renderGeoGlowsChartView();
    } else {
      this.#renderGeoGlowsTableView();
    }
    this.#updateGeoGlowsViewToggle();
    this.#updateGeoGlowsUnitToggle();
  }

  #renderGeoGlowsTableView() {
    const { riverId, point, forecastSeries, statGroups, dailySeries, monthlySeries, annualSeries, averageWarnings } =
      this.#geoglowsActiveResult;
    const unitText = this.#getGeoGlowsUnitLabel();
    const forecastRows = forecastSeries.length
      ? forecastSeries
          .slice(0, 10)
          .map(
            (item) => `
              <tr>
                <td>${this.#escapeHtml(item.label)}</td>
                <td>${this.#formatGeoGlowsDisplayValue(item.value)}</td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="2">No forecast samples were returned.</td></tr>`;

    const statsMarkup = statGroups.length
      ? statGroups
          .slice(0, 4)
          .map((group) => {
            const rows = group.series
              .slice(0, 6)
              .map(
                (item) => `
                  <tr>
                    <td>${this.#escapeHtml(item.label)}</td>
                    <td>${this.#formatGeoGlowsDisplayValue(item.value)}</td>
                  </tr>
                `
              )
              .join("");

            return `
              <div class="geoglows-mini-group">
                <div class="geoglows-mini-title">${this.#escapeHtml(group.title)}</div>
                <table class="geoglows-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Flow</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
            `;
          })
          .join("")
      : `
        <div class="geoglows-mini-group">
          <div class="geoglows-mini-title">Forecast Statistics</div>
          <div class="geoglows-empty-copy">No statistical series were returned for the selected reach.</div>
        </div>
      `;

    const dailyRows = this.#buildGeoGlowsRowsMarkup(dailySeries, 6);
    const monthlyRows = this.#buildGeoGlowsRowsMarkup(monthlySeries, 6);
    const annualRows = this.#buildGeoGlowsRowsMarkup(annualSeries, 6);

    const warningMarkup = averageWarnings.length
      ? `
        <div class="geoglows-error-state">
          <div class="geoglows-error-title">Some historic averages were unavailable</div>
          <div class="geoglows-error-copy">${this.#escapeHtml(averageWarnings.join(" "))}</div>
        </div>
      `
      : "";

    this.#setGeoGlowsModeLabel("Active Reach");
    this.#setGeoGlowsBody(`
      ${warningMarkup}
      <div class="geoglows-metadata-grid">
        <div class="geoglows-metadata-item">
          <span class="geoglows-metadata-label">Reach ID</span>
          <div class="geoglows-metadata-value">${this.#escapeHtml(
            String(riverId)
          )}</div>
        </div>
        <div class="geoglows-metadata-item">
          <span class="geoglows-metadata-label">Latitude</span>
          <div class="geoglows-metadata-value">${Number(point.lat).toFixed(4)}</div>
        </div>
        <div class="geoglows-metadata-item">
          <span class="geoglows-metadata-label">Longitude</span>
          <div class="geoglows-metadata-value">${Number(point.lon).toFixed(4)}</div>
        </div>
      </div>
      <div class="geoglows-panel-grid">
        <section class="geoglows-panel-card">
          <h4>Average Forecast</h4>
          <p>Representative discharge forecast for the nearest GeoGLOWS stream reach in ${unitText}.</p>
          <table class="geoglows-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Flow</th>
              </tr>
            </thead>
            <tbody>${forecastRows}</tbody>
          </table>
        </section>
        <section class="geoglows-panel-card">
          <h4>Forecast Statistics</h4>
          <p>Ensemble-derived forecast statistics for the same reach, grouped by the returned statistic series in ${unitText}.</p>
          ${statsMarkup}
        </section>
      </div>
      <div class="geoglows-subgrid-3">
        <section class="geoglows-panel-card">
          <h4>Daily Averages</h4>
          <p>Historic simulation daily-average flow profile for the selected reach in ${unitText}.</p>
          <table class="geoglows-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Flow</th>
              </tr>
            </thead>
            <tbody>${dailyRows}</tbody>
          </table>
        </section>
        <section class="geoglows-panel-card">
          <h4>Monthly Averages</h4>
          <p>Historic monthly-average discharge values for the same river reach in ${unitText}.</p>
          <table class="geoglows-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Flow</th>
              </tr>
            </thead>
            <tbody>${monthlyRows}</tbody>
          </table>
        </section>
        <section class="geoglows-panel-card">
          <h4>Annual Averages</h4>
          <p>Historic annual-average flow series derived from the GeoGLOWS simulation in ${unitText}.</p>
          <table class="geoglows-table">
            <thead>
              <tr>
                <th>Year</th>
                <th>Flow</th>
              </tr>
            </thead>
            <tbody>${annualRows}</tbody>
          </table>
        </section>
      </div>
    `);
  }

  #renderGeoGlowsChartView() {
    const { riverId, point, forecastSeries, statGroups, dailySeries, monthlySeries, annualSeries, averageWarnings } =
      this.#geoglowsActiveResult;
    const unitText = this.#getGeoGlowsUnitLabel();

    const warningMarkup = averageWarnings.length
      ? `
        <div class="geoglows-error-state">
          <div class="geoglows-error-title">Some historic averages were unavailable</div>
          <div class="geoglows-error-copy">${this.#escapeHtml(averageWarnings.join(" "))}</div>
        </div>
      `
      : "";

    this.#setGeoGlowsModeLabel("Chart View");
    this.#setGeoGlowsBody(`
      ${warningMarkup}
      <div class="geoglows-metadata-grid">
        <div class="geoglows-metadata-item">
          <span class="geoglows-metadata-label">Reach ID</span>
          <div class="geoglows-metadata-value">${this.#escapeHtml(
            String(riverId)
          )}</div>
        </div>
        <div class="geoglows-metadata-item">
          <span class="geoglows-metadata-label">Latitude</span>
          <div class="geoglows-metadata-value">${Number(point.lat).toFixed(4)}</div>
        </div>
        <div class="geoglows-metadata-item">
          <span class="geoglows-metadata-label">Longitude</span>
          <div class="geoglows-metadata-value">${Number(point.lon).toFixed(4)}</div>
        </div>
      </div>
      <div class="geoglows-chart-stack">
        <section class="geoglows-chart-card">
          <h4>Average Forecast Chart</h4>
          <p>Line chart for the representative discharge forecast at the selected GeoGLOWS reach in ${unitText}.</p>
          <div class="geoglows-chart-wrap">
            <canvas id="geoglowsForecastChartCanvas"></canvas>
          </div>
        </section>
        <section class="geoglows-chart-card">
          <h4>Forecast Statistics Chart</h4>
          <p>Multi-series chart for the returned forecast statistics in ${unitText} so you can compare the temporal patterns more clearly.</p>
          <div class="geoglows-chart-wrap">
            <canvas id="geoglowsStatsChartCanvas"></canvas>
          </div>
        </section>
        <div class="geoglows-subgrid-3">
          <section class="geoglows-chart-card">
            <h4>Daily Averages Chart</h4>
            <p>Historic daily-average flow distribution for the selected reach in ${unitText}.</p>
            <div class="geoglows-chart-wrap">
              <canvas id="geoglowsDailyChartCanvas"></canvas>
            </div>
          </section>
          <section class="geoglows-chart-card">
            <h4>Monthly Averages Chart</h4>
            <p>Historic monthly-average discharge values for the same reach in ${unitText}.</p>
            <div class="geoglows-chart-wrap">
              <canvas id="geoglowsMonthlyChartCanvas"></canvas>
            </div>
          </section>
          <section class="geoglows-chart-card">
            <h4>Annual Averages Chart</h4>
            <p>Historic annual-average flow series from the GeoGLOWS simulation in ${unitText}.</p>
            <div class="geoglows-chart-wrap">
              <canvas id="geoglowsAnnualChartCanvas"></canvas>
            </div>
          </section>
        </div>
      </div>
    `);

    queueMicrotask(() => {
      this.#drawGeoGlowsCharts(
        forecastSeries,
        statGroups,
        dailySeries,
        monthlySeries,
        annualSeries
      );
    });
  }

  #drawGeoGlowsCharts(forecastSeries, statGroups, dailySeries, monthlySeries, annualSeries) {
    this.#destroyGeoGlowsCharts();
    const unitText = this.#getGeoGlowsUnitLabel();

    const forecastCanvas = document.getElementById("geoglowsForecastChartCanvas");
    const statsCanvas = document.getElementById("geoglowsStatsChartCanvas");
    const dailyCanvas = document.getElementById("geoglowsDailyChartCanvas");
    const monthlyCanvas = document.getElementById("geoglowsMonthlyChartCanvas");
    const annualCanvas = document.getElementById("geoglowsAnnualChartCanvas");

    if (forecastCanvas && forecastSeries.length) {
      this.#geoglowsForecastChart = new Chart(forecastCanvas.getContext("2d"), {
        type: "line",
        data: {
          labels: forecastSeries.map((item) => item.label),
          datasets: [
            {
              label: `Average Forecast (${unitText})`,
              data: forecastSeries.map((item) => this.#convertGeoGlowsValue(item.value)),
              borderColor: "#38bdf8",
              backgroundColor: "rgba(56, 189, 248, 0.18)",
              fill: true,
              borderWidth: 2,
              tension: 0.28,
              pointRadius: 2,
            },
          ],
        },
        options: this.#getGeoGlowsChartOptions(),
      });
    }

    if (statsCanvas && statGroups.length) {
      const palette = ["#f97316", "#22c55e", "#a855f7", "#facc15", "#ef4444"];
      this.#geoglowsStatsChart = new Chart(statsCanvas.getContext("2d"), {
        type: "line",
        data: {
          labels: statGroups[0].series.map((item) => item.label),
          datasets: statGroups.slice(0, 5).map((group, index) => ({
            label: `${group.title} (${unitText})`,
            data: group.series.map((item) => this.#convertGeoGlowsValue(item.value)),
            borderColor: palette[index % palette.length],
            backgroundColor: "transparent",
            borderWidth: 2,
            tension: 0.22,
            pointRadius: 1.5,
          })),
        },
        options: this.#getGeoGlowsChartOptions(8),
      });
    }

    if (dailyCanvas && dailySeries.length) {
      this.#geoglowsDailyChart = new Chart(dailyCanvas.getContext("2d"), {
        type: "line",
        data: {
          labels: dailySeries.map((item) => item.label),
          datasets: [
            {
              label: `Daily Average (${unitText})`,
              data: dailySeries.map((item) => this.#convertGeoGlowsValue(item.value)),
              borderColor: "#22c55e",
              backgroundColor: "rgba(34, 197, 94, 0.15)",
              fill: true,
              borderWidth: 2,
              tension: 0.22,
              pointRadius: 1,
            },
          ],
        },
        options: this.#getGeoGlowsChartOptions(10),
      });
    }

    if (monthlyCanvas && monthlySeries.length) {
      this.#geoglowsMonthlyChart = new Chart(monthlyCanvas.getContext("2d"), {
        type: "bar",
        data: {
          labels: monthlySeries.map((item) => item.label),
          datasets: [
            {
              label: `Monthly Average (${unitText})`,
              data: monthlySeries.map((item) => this.#convertGeoGlowsValue(item.value)),
              backgroundColor: "rgba(249, 115, 22, 0.55)",
              borderColor: "#f97316",
              borderWidth: 1.5,
            },
          ],
        },
        options: this.#getGeoGlowsChartOptions(12),
      });
    }

    if (annualCanvas && annualSeries.length) {
      this.#geoglowsAnnualChart = new Chart(annualCanvas.getContext("2d"), {
        type: "line",
        data: {
          labels: annualSeries.map((item) => item.label),
          datasets: [
            {
              label: `Annual Average (${unitText})`,
              data: annualSeries.map((item) => this.#convertGeoGlowsValue(item.value)),
              borderColor: "#a855f7",
              backgroundColor: "rgba(168, 85, 247, 0.16)",
              fill: true,
              borderWidth: 2,
              tension: 0.2,
              pointRadius: 1.5,
            },
          ],
        },
        options: this.#getGeoGlowsChartOptions(8),
      });
    }
  }

  #getGeoGlowsChartOptions(maxTicksLimit = 8) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          labels: {
            color: "#e2e8f0",
            boxWidth: 12,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#cbd5e1",
            maxTicksLimit,
          },
          grid: {
            color: "rgba(148, 163, 184, 0.12)",
          },
        },
        y: {
          ticks: {
            color: "#cbd5e1",
          },
          title: {
            display: true,
            text: `Flow (${this.#getGeoGlowsUnitLabel()})`,
            color: "#e2e8f0",
          },
          grid: {
            color: "rgba(148, 163, 184, 0.12)",
          },
        },
      },
    };
  }

  #buildGeoGlowsRowsMarkup(series, limit = 6) {
    if (!series.length) {
      return `<tr><td colspan="2">No data returned.</td></tr>`;
    }

    return series
      .slice(0, limit)
      .map(
        (item) => `
          <tr>
            <td>${this.#escapeHtml(item.label)}</td>
            <td>${this.#formatGeoGlowsDisplayValue(item.value)}</td>
          </tr>
        `
      )
      .join("");
  }

  #toggleGeoGlowsView() {
    if (!this.#geoglowsActiveResult) return;
    this.#geoglowsChartView = !this.#geoglowsChartView;
    this.#renderGeoGlowsActiveView();
  }

  #toggleGeoGlowsUnit() {
    this.#geoglowsUnit =
      this.#geoglowsUnit === "cumecs" ? "cusecs" : "cumecs";
    this.#renderGeoGlowsActiveView();
    this.#updateGeoGlowsUnitToggle();
  }

  #updateGeoGlowsViewToggle() {
    const btn = document.getElementById("geoglowsViewToggleBtn");
    if (!btn) return;
    btn.disabled = !this.#geoglowsActiveResult;
    btn.textContent = this.#geoglowsChartView ? "Table View" : "Chart View";
    btn.classList.toggle("is-chart", this.#geoglowsChartView);
  }

  #updateGeoGlowsUnitToggle() {
    const btn = document.getElementById("geoglowsUnitToggleBtn");
    if (!btn) return;
    btn.disabled = !this.#geoglowsActiveResult;
    btn.textContent =
      this.#geoglowsUnit === "cumecs" ? "Show ft³/s" : "Show m³/s";
  }

  #extractGeoGlowsStatGroups(payload) {
    const source = payload?.raw ?? payload;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      const fallbackSeries = this.#extractGeoGlowsSeries(source);
      return fallbackSeries.length
        ? [{ title: "Statistics", series: fallbackSeries }]
        : [];
    }

    const groups = [];
    for (const [key, value] of Object.entries(source)) {
      const series = this.#extractGeoGlowsSeries(value);
      if (series.length) {
        groups.push({ title: this.#prettifyGeoGlowsKey(key), series });
      }
    }

    if (!groups.length) {
      const fallbackSeries = this.#extractGeoGlowsSeries(source);
      if (fallbackSeries.length) {
        groups.push({ title: "Statistics", series: fallbackSeries });
      }
    }

    return groups;
  }

  #extractGeoGlowsSeries(payload, preferredKeys = []) {
    const source = payload?.raw ?? payload;
    if (!source) return [];

    if (Array.isArray(source)) {
      return source
        .map((item, index) => this.#normalizeGeoGlowsPoint(item, index))
        .filter(Boolean);
    }

    if (typeof source !== "object") return [];

    for (const key of preferredKeys) {
      if (source[key] != null) {
        const preferredSeries = this.#extractGeoGlowsSeries(source[key]);
        if (preferredSeries.length) return preferredSeries;
      }
    }

    const keys = Object.keys(source);
    const looksLikeDateMap =
      keys.length > 1 &&
      keys.every((key) => !Number.isNaN(Date.parse(String(key))));
    if (looksLikeDateMap) {
      return keys
        .map((key, index) =>
          this.#normalizeGeoGlowsPoint(
            { date: key, value: source[key] },
            index
          )
        )
        .filter(Boolean);
    }

    const dateArray =
      (Array.isArray(source.datetime) && source.datetime) ||
      (Array.isArray(source.date) && source.date) ||
      (Array.isArray(source.time) && source.time) ||
      null;

    if (dateArray) {
      const valueKey = Object.keys(source).find((key) => {
        if (["datetime", "date", "time"].includes(key)) return false;
        const value = source[key];
        return (
          Array.isArray(value) &&
          value.length === dateArray.length &&
          value.some((item) => Number.isFinite(Number(item)))
        );
      });

      if (valueKey) {
        return dateArray
          .map((label, index) =>
            this.#normalizeGeoGlowsPoint(
              { date: label, value: source[valueKey][index] },
              index
            )
          )
          .filter(Boolean);
      }
    }

    for (const value of Object.values(source)) {
      const nestedSeries = this.#extractGeoGlowsSeries(value);
      if (nestedSeries.length) return nestedSeries;
    }

    return [];
  }

  #normalizeGeoGlowsPoint(item, index) {
    if (item == null) return null;

    if (Array.isArray(item) && item.length >= 2) {
      const value = Number(item[1]);
      if (!Number.isFinite(value)) return null;
      return {
        label: this.#formatGeoGlowsLabel(item[0], index),
        value,
      };
    }

    if (typeof item === "object") {
      const label =
        item.datetime ??
        item.date ??
        item.time ??
        item.timestamp ??
        item.label ??
        item.x ??
        `Point ${index + 1}`;

      const valueKey = [
        "value",
        "flow",
        "streamflow",
        "mean",
        "average_flow",
        "avg",
        "high_res",
        "median",
        "p50",
      ].find((key) => Number.isFinite(Number(item[key])));

      if (valueKey) {
        return {
          label: this.#formatGeoGlowsLabel(label, index),
          value: Number(item[valueKey]),
        };
      }

      const firstNumericEntry = Object.entries(item).find(([, value]) =>
        Number.isFinite(Number(value))
      );
      if (firstNumericEntry) {
        return {
          label: this.#formatGeoGlowsLabel(label, index),
          value: Number(firstNumericEntry[1]),
        };
      }
    }

    return null;
  }

  #formatGeoGlowsLabel(value, index) {
    if (value == null || value === "") return `Point ${index + 1}`;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleString("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return String(value);
  }

  #formatGeoGlowsValue(value) {
    if (!Number.isFinite(Number(value))) return "N/A";
    return `${Number(value).toLocaleString("en-US", {
      maximumFractionDigits: 2,
    })} m³/s`;
  }

  #prettifyGeoGlowsKey(key) {
    return String(key)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  #convertGeoGlowsValue(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return value;
    return this.#geoglowsUnit === "cusecs"
      ? numeric * CUMEC_TO_CUSEC
      : numeric;
  }

  #getGeoGlowsUnitLabel() {
    return this.#geoglowsUnit === "cusecs" ? "ft³/s" : "m³/s";
  }

  #formatGeoGlowsDisplayValue(value) {
    if (!Number.isFinite(Number(value))) return "N/A";
    return `${this.#convertGeoGlowsValue(value).toLocaleString("en-US", {
      maximumFractionDigits: 2,
    })} ${this.#getGeoGlowsUnitLabel()}`;
  }

  #escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  #setGeoGlowsMarker(lngLat) {
    if (this.#geoglowsMarker) {
      this.#geoglowsMarker.setLngLat(lngLat);
      return;
    }

    this.#geoglowsMarker = new mapboxgl.Marker({ color: "#38bdf8" })
      .setLngLat(lngLat)
      .addTo(this.#map);
  }

  #showGeoGlowsPanel() {
    const panel = document.getElementById("geoglows-forecast-panel");
    if (panel) panel.style.display = "block";
  }

  #hideGeoGlowsPanel() {
    const panel = document.getElementById("geoglows-forecast-panel");
    if (panel) panel.style.display = "none";
  }

  #setGeoGlowsModeLabel(text) {
    const label = document.getElementById("geoglowsModeLabel");
    if (label) label.textContent = text;
  }

  #setGeoGlowsBody(markup) {
    const body = document.getElementById("geoglowsPanelBody");
    if (body) body.innerHTML = markup;
  }

  #setGeoGlowsMapCursor(cursor) {
    const canvas = this.#map?.getCanvas?.();
    if (canvas) canvas.style.cursor = cursor;
  }

  #destroyGeoGlowsCharts() {
    if (this.#geoglowsForecastChart) {
      try {
        this.#geoglowsForecastChart.destroy();
      } catch (_) {}
      this.#geoglowsForecastChart = null;
    }

    if (this.#geoglowsStatsChart) {
      try {
        this.#geoglowsStatsChart.destroy();
      } catch (_) {}
      this.#geoglowsStatsChart = null;
    }

    if (this.#geoglowsDailyChart) {
      try {
        this.#geoglowsDailyChart.destroy();
      } catch (_) {}
      this.#geoglowsDailyChart = null;
    }

    if (this.#geoglowsMonthlyChart) {
      try {
        this.#geoglowsMonthlyChart.destroy();
      } catch (_) {}
      this.#geoglowsMonthlyChart = null;
    }

    if (this.#geoglowsAnnualChart) {
      try {
        this.#geoglowsAnnualChart.destroy();
      } catch (_) {}
      this.#geoglowsAnnualChart = null;
    }
  }

  #clearGeoGlowsState() {
    this.#geoglowsAbortController?.abort();
    this.#geoglowsAbortController = null;
    this.#destroyGeoGlowsCharts();
    this.#geoglowsActiveResult = null;
    this.#geoglowsChartView = false;

    if (this.#geoglowsMarker) {
      this.#geoglowsMarker.remove();
      this.#geoglowsMarker = null;
    }

    this.#geoglowsEnabled = false;
    this.#geoglowsSelecting = false;
    this.#map.off("click", this.#geoglowsSelectionHandler);
    this.#setGeoGlowsMapCursor("");
    this.#hideGeoGlowsPanel();
    this.#setGeoGlowsModeLabel("Ready");
    document
      .getElementById("geoglowsForecast")
      ?.classList.remove("active-geoglows");
    this.#updateGeoGlowsViewToggle();
    this.#updateGeoGlowsUnitToggle();
  }

  /**
   * Public method: jump to specific city
   * @param {string} cityName - Name of city from SOUTH_ASIA_COORDS
   */
  jumpToCity(cityName) {
    const cityKey = cityName.toLowerCase().replace(/\s+/g, "_");
    const coords = SOUTH_ASIA_COORDS.cities[cityKey];

    if (!coords) {
      console.warn(`⚠️ City "${cityName}" not found in South Asia coordinates`);
      return;
    }

    this.#map.flyTo({
      center: coords,
      zoom: 10,
      duration: 1500,
      essential: true,
    });
  }

  /**
   * Public method: jump to region
   * @param {string} regionName - Name of region
   */
  jumpToRegion(regionName) {
    const regionKey = regionName.toLowerCase().replace(/\s+/g, "");
    const coords = SOUTH_ASIA_COORDS.regions[regionKey];

    if (!coords) {
      console.warn(`⚠️ Region "${regionName}" not found in South Asia regions`);
      return;
    }

    this.#map.flyTo({
      center: coords,
      zoom: 6,
      duration: 1500,
      essential: true,
    });
  }

  /**
   * Get South Asia coordinates reference
   */
  getSouthAsiaCoordinates() {
    return SOUTH_ASIA_COORDS;
  }

  // ============================================================
  // NEWS MODAL LOGIC (merged from news-modal.js)
  // ============================================================

  /**
   * Initialize News Modal buttons and default mode
   */
  #initializeNewsModal() {
    const socialBtn = document.getElementById("toggle-social-btn");
    const regularBtn = document.getElementById("fetch-regular-btn");

    if (!socialBtn || !regularBtn) {
      console.warn("⚠️ News modal buttons not found");
      return;
    }

    // Social Media Button Click
    socialBtn.addEventListener("click", () => {
      if (socialBtn.classList.contains("active")) return;

      this.#includeSocialMedia = true;
      this.#fetchNews(true);
      this.#updateNewsButtonStates(socialBtn, regularBtn);
    });

    // Regular News Button Click
    regularBtn.addEventListener("click", () => {
      if (regularBtn.classList.contains("active")) return;

      this.#includeSocialMedia = false;
      this.#fetchNews(false);
      this.#updateNewsButtonStates(regularBtn, socialBtn);
    });

    // Both start inactive
    regularBtn.classList.remove("active");
    socialBtn.classList.remove("active");
    regularBtn.disabled = false;
    socialBtn.disabled = false;
  }

  /**
   * Update "Regular / Social" button visual state after fetch
   */
  #updateNewsButtonStates(activeBtn, inactiveBtn) {
    activeBtn.classList.add("active");
    activeBtn.disabled = true;

    inactiveBtn.classList.remove("active");
    inactiveBtn.disabled = false;
  }

  /**
   * Fetch news from Django backend
   * @param {boolean} includeSM - Include social media or just regular
   */
  async #fetchNews(includeSM = false) {
    // Render the loading animation immediately so the user gets feedback
    // the moment they click a toggle.  Using `.is-loading` neutralizes
    // the marquee animation so the dots stay centered instead of being
    // dragged off-screen by the scroll-left keyframes.
    const preContainer = document.getElementById("news-scroll");
    if (preContainer) {
      preContainer.classList.add("is-loading");
      preContainer.innerHTML = `
        <div class="news-loading" role="status" aria-live="polite">
          <span class="news-loading-label">Loading news…</span>
          <div class="news-loading-track" aria-hidden="true">
            <span></span><span></span><span></span><span></span><span></span>
          </div>
        </div>
      `;
    }

    try {
      const url = includeSM
        ? `${
            this.#baseUrl
          }/get-gdelt-news-events/?include_only_social_media=true&days=7`
        : `${
            this.#baseUrl
          }/get-gdelt-news-events/?include_social_media=false&days=7`;

      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const geojson = await res.json();
      const container = document.getElementById("news-scroll");

      if (!container) {
        console.error("❌ News scroll container not found");
        return;
      }

      container.classList.remove("is-loading");
      container.innerHTML = "";

      // No data case
      if (!geojson.features || geojson.features.length === 0) {
        container.innerHTML = `
          <div class="news-empty">
              🔍 No news data found for South Asia
              <small>Try switching between Social Media and Regular News</small>
          </div>
        `;
        return;
      }

      // populate ticker with boxes
      geojson.features.forEach((feature, index) => {
        const props = feature.properties;
        const box = document.createElement("div");
        box.className = "news-box";

        const fullUrl = props.url || "#";
        const maxLength = 38;
        const shortUrl =
          fullUrl.length > maxLength
            ? fullUrl.substring(0, maxLength / 2) +
              "…" +
              fullUrl.slice(-maxLength / 2)
            : fullUrl;

        const headerInner = this.#generateSourceDisplay(props);
        const displayDate = this.#formatGdeltDate(props.formatted_date);
        const safeUrl = this.#sanitizeHTML(fullUrl);

        box.innerHTML = `
          <div class="news-box-header">
            ${headerInner}
          </div>
          <div class="news-box-title">
            ${this.#sanitizeHTML(props.title || "Untitled")}
          </div>
          <div class="news-box-footer">
            <a class="news-box-link"
               href="${safeUrl}"
               target="_blank"
               rel="noopener noreferrer"
               title="${safeUrl}">
              ${this.#sanitizeHTML(shortUrl)}
            </a>
            <span class="news-box-time">${this.#sanitizeHTML(displayDate)}</span>
          </div>
        `;

        // Stop link clicks from also toggling the marker (prevents the
        // map flying to the location while the user just wanted to open
        // the article in a new tab).
        box
          .querySelector(".news-box-link")
          ?.addEventListener("click", (e) => e.stopPropagation());

        box.dataset.index = index;
        box.addEventListener("click", () =>
          this.#toggleNewsMarker(index, feature)
        );
        container.appendChild(box);
      });

      // Duplicate the rendered cards once so the marquee animation
      // (translateX 0% → -50%) loops seamlessly.  Clones carry
      // `data-clone="true"` so click handlers can still locate the
      // original feature index.
      const originals = Array.from(container.children);
      originals.forEach((node) => {
        const clone = node.cloneNode(true);
        clone.dataset.clone = "true";
        clone.setAttribute("aria-hidden", "true");
        const idx = Number(clone.dataset.index);
        const feat = geojson.features[idx];
        if (feat) {
          clone.addEventListener("click", () =>
            this.#toggleNewsMarker(idx, feat)
          );
          clone
            .querySelector(".news-box-link")
            ?.addEventListener("click", (e) => e.stopPropagation());
        }
        container.appendChild(clone);
      });

      window.gdeltNewsFeatures = geojson.features;
    } catch (error) {
      console.error("❌ Error fetching news:", error);
      const container = document.getElementById("news-scroll");
      if (container) {
        container.classList.remove("is-loading");
        container.innerHTML = `
          <div class="news-error">
              <strong>Failed to load news</strong>
              <small>${this.#sanitizeHTML(error.message)}</small>
          </div>
        `;
      }
    }
  }

  /**
   * Render the "source line" of each news card
   */
  #generateSourceDisplay(props) {
    const flagBase = "https://flagcdn.com/";

    // Reddit source — badge + r/sub + (upvotes / comments)
    if (props.source_platform === "reddit") {
      return `
        <div class="news-box-source">
          <span class="news-box-badge news-box-badge--reddit">REDDIT</span>
          <span class="news-box-source-meta">
            r/${this.#sanitizeHTML(props.reddit_subreddit || "unknown")}
          </span>
        </div>
        <div class="news-box-meta">
          <span class="news-box-meta-stat">⬆️ ${this.#sanitizeHTML(
            String(props.reddit_score || 0)
          )}</span>
          <span class="news-box-meta-stat">💬 ${this.#sanitizeHTML(
            String(props.reddit_comments || 0)
          )}</span>
        </div>
      `;
    }

    // Mastodon source — badge + @author + (favorites / reblogs)
    if (props.source_platform === "mastodon") {
      return `
        <div class="news-box-source">
          <span class="news-box-badge news-box-badge--mastodon">MASTODON</span>
          <span class="news-box-source-meta">
            @${this.#sanitizeHTML(props.mastodon_author || "unknown")}
          </span>
        </div>
        <div class="news-box-meta">
          <span class="news-box-meta-stat">⭐ ${this.#sanitizeHTML(
            String(props.mastodon_favourites || 0)
          )}</span>
          <span class="news-box-meta-stat">🔁 ${this.#sanitizeHTML(
            String(props.mastodon_reblogs || 0)
          )}</span>
        </div>
      `;
    }

    // Traditional news (GDELT) — badge + flag + country
    const country = props.sourcecountry || "Unknown";
    const isoCode = (COUNTRY_ISO_MAP[country] || "un").toLowerCase();
    const safeCountry = this.#sanitizeHTML(country);

    return `
      <div class="news-box-source">
        <span class="news-box-badge news-box-badge--news">NEWS</span>
        <span class="news-box-source-meta">
          <picture>
            <source type="image/webp" srcset="${flagBase}16x12/${isoCode}.webp">
            <source type="image/png"  srcset="${flagBase}16x12/${isoCode}.png">
            <img src="${flagBase}16x12/${isoCode}.png"
                 width="14" height="10"
                 alt="${safeCountry} flag"
                 onerror="this.style.display='none'">
          </picture>
          ${safeCountry}
        </span>
      </div>
    `;
  }

  /**
   * Add/remove map marker for a clicked news item and fly to it
   */
  #toggleNewsMarker(index, feature) {
    const id = `news-${index}`;
    const coords = feature.geometry.coordinates;
    const props = feature.properties;

    // If marker already exists → remove
    if (this.#newsMarkers[id]) {
      this.#newsMarkers[id].remove();
      delete this.#newsMarkers[id];

      // Strip `.active` from BOTH the original card and its marquee
      // clone (cards are duplicated so the scroll loop is seamless).
      document
        .querySelectorAll(`.news-box[data-index="${index}"]`)
        .forEach((el) => el.classList.remove("active"));

      this.#resumeScroll();
      return;
    }

    // Create new marker
    this.#pauseScroll();

    // Determine marker color based on source
    let markerColor = "#e63946";
    if (props.source_platform === "reddit") {
      markerColor = "#ff4500";
    } else if (props.source_platform === "mastodon") {
      markerColor = "#6364ff";
    }

    const marker = new mapboxgl.Marker({ color: markerColor })
      .setLngLat(coords)
      .addTo(this.#map);

    // Create popup on marker click
    marker.getElement().addEventListener("click", () => {
      let platformBlock;
      let badgeVariant = "status-active";
      let badgeLabel = "News";

      if (props.source_platform === "reddit") {
        badgeLabel = "Reddit";
        platformBlock = `
          <p class="ncop-popup__info-row">📱 <strong>Reddit</strong> · r/${props.reddit_subreddit || "unknown"}</p>
          <p class="ncop-popup__info-row">👍 ${props.reddit_score || 0} upvotes · 💬 ${props.reddit_comments || 0} comments</p>
        `;
      } else if (props.source_platform === "mastodon") {
        badgeLabel = "Mastodon";
        platformBlock = `
          <p class="ncop-popup__info-row">🐘 <strong>Mastodon</strong> · @${props.mastodon_author || "unknown"}</p>
          <p class="ncop-popup__info-row">⭐ ${props.mastodon_favourites || 0} favorites · 🔄 ${props.mastodon_reblogs || 0} reblogs</p>
        `;
      } else {
        badgeVariant = "status-open";
        badgeLabel = this.#sanitizeHTML(props.domain || "News");
        platformBlock = `
          <p class="ncop-popup__info-row">📰 <strong>${this.#sanitizeHTML(props.domain || "News Source")}</strong></p>
          <p class="ncop-popup__info-row">🌍 ${this.#sanitizeHTML(props.sourcecountry || "Unknown Country")}</p>
        `;
      }

      const popupContent = `<div class="ncop-popup ncop-popup--compact">
        <div class="ncop-popup__header">
          <div class="ncop-popup__title-block">
            <div class="ncop-popup__title">${this.#sanitizeHTML(props.title)}</div>
          </div>
          <span class="ncop-popup__badge ncop-popup__badge--${badgeVariant}">${badgeLabel}</span>
        </div>
        <div class="ncop-popup__body">
          <div class="ncop-popup__info">${platformBlock}</div>
        </div>
        <div class="ncop-popup__actions">
          <a class="ncop-popup__button ncop-popup__button--primary" href="${props.url}" target="_blank" rel="noopener noreferrer">Read More →</a>
        </div>
      </div>`;

      new mapboxgl.Popup({ className: "ncop-popup-host", maxWidth: "360px" })
        .setLngLat(coords)
        .setHTML(popupContent)
        .addTo(this.#map);
    });

    this.#newsMarkers[id] = marker;

    // Fly to marker
    this.#map.flyTo({
      center: coords,
      zoom: 6,
      duration: 1500,
    });

    document
      .querySelectorAll(`.news-box[data-index="${index}"]`)
      .forEach((el) => el.classList.add("active"));
  }

  /**
   * Pause marquee scroll while marker is active
   */
  #pauseScroll() {
    if (!this.#scrollPaused) {
      const scrollElement = document.querySelector(".news-scroll");
      if (scrollElement) {
        scrollElement.style.animationPlayState = "paused";
        this.#scrollPaused = true;
      }
    }
  }

  /**
   * Resume marquee scroll if no markers are active
   */
  #resumeScroll() {
    if (this.#scrollPaused && Object.keys(this.#newsMarkers).length === 0) {
      const scrollElement = document.querySelector(".news-scroll");
      if (scrollElement) {
        scrollElement.style.animationPlayState = "running";
        this.#scrollPaused = false;
      }
    }
  }

  /**
   * Update clock in the news header
   */
  #updateNewsClock() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const timeElement = document.getElementById("news-time");
    if (timeElement) {
      timeElement.textContent = timeStr;
    }
  }

  /**
   * Very small helper to avoid HTML injection
   */
  #sanitizeHTML(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Convert GDELT-style timestamp "20251027T121500Z" -> "27th Oct 2025"
   */
  #formatGdeltDate(raw) {
    if (!raw || typeof raw !== "string") return "Unknown date";

    const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) {
      return "Unknown date";
    }

    const [_, year, month, day, hour, minute, second] = match;

    const dateObj = new Date(
      Date.UTC(
        parseInt(year, 10),
        parseInt(month, 10) - 1,
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
        parseInt(second, 10)
      )
    );

    const dayNum = dateObj.getUTCDate();
    const monthNamesShort = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const monthLabel = monthNamesShort[dateObj.getUTCMonth()];
    const yearNum = dateObj.getUTCFullYear();

    const suffix = ((n) => {
      const rem10 = n % 10;
      const rem100 = n % 100;
      if (rem10 === 1 && rem100 !== 11) return "st";
      if (rem10 === 2 && rem100 !== 12) return "nd";
      if (rem10 === 3 && rem100 !== 13) return "rd";
      return "th";
    })(dayNum);

    return `${dayNum}${suffix} ${monthLabel} ${yearNum}`;
  }

  // ============================================================
  // GEE CHATBOT IMPLEMENTATION
  // ============================================================

  #initializeGeeChatbot() {
    const sendBtn = document.getElementById("geeChatSend");
    const input = document.getElementById("geeChatInput");
    const closeBtn = document.getElementById("geeChatClose");

    // Store reference to messages container
    this.#geeChatMessages = document.getElementById("geeChatMessages");

    sendBtn?.addEventListener("click", () => this.#handleGeeMessage());

    input?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.#handleGeeMessage();
    });

    closeBtn?.addEventListener("click", () => {
      document.getElementById("gee-chat-modal").style.display = "none";
      document.getElementById("geeChat")?.classList.remove("active-gee");
    });

    // Welcome message
    this.#addChatMessage(
      "assistant",
      '👋 Hi! I can help you visualize satellite data over Pakistan.\n\nTry asking:\n• "Show snow cover in Gilgit Baltistan"\n• "Display population density in Lahore"\n• "Air quality in Karachi last week"'
    );
  }

  #handleGeeChatToggle() {
    const modal = document.getElementById("gee-chat-modal");
    const btn = document.getElementById("geeChat");

    if (!modal) return;

    const isVisible = modal.style.display === "flex";

    if (isVisible) {
      modal.style.display = "none";
      btn?.classList.remove("active-gee");
    } else {
      modal.style.display = "flex";
      btn?.classList.add("active-gee");
      document.getElementById("geeChatInput")?.focus();
    }
  }

  async #handleGeeMessage() {
    const input = document.getElementById("geeChatInput");
    const message = input.value.trim();

    if (!message) return;

    // Add user message
    this.#addChatMessage("user", message);
    input.value = "";

    // Check for conversational queries
    const semanticResponse = this.#handleSemanticQuery(message);
    if (semanticResponse) {
      this.#addChatMessage("assistant", semanticResponse);
      return;
    }

    // Show loading
    const loadingId = this.#addChatMessage(
      "assistant",
      "🔄 Generating layer...",
      true
    );

    try {
      const response = await fetch(`${this.#baseUrl}/api/gee/dynamic-layer/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      const data = await response.json();

      // Remove loading message
      document.getElementById(loadingId)?.remove();

      if (data.success) {
        // Store layer info
        this.#geeLayers.set(data.layer_id, {
          tile_url: data.tile_url,
          dataset: data.dataset,
          location: data.location,
          legend: data.legend,
          visualization: data.visualization,
          added: false,
        });

        // Add response with controls
        this.#addLayerResponse(data);
      } else {
        this.#addChatMessage("assistant", data.response || data.error);
      }
    } catch (error) {
      document.getElementById(loadingId)?.remove();
      this.#addChatMessage("assistant", `❌ Error: ${error.message}`);
    }
  }

  /**
   * Handle semantic/conversational queries
   */
  #handleSemanticQuery(message) {
    const msg = message.toLowerCase().trim();

    // Greetings
    const greetings = ["hi", "hello", "hey", "yo", "sup", "greetings"];
    if (greetings.some((g) => msg === g || msg.startsWith(g + " "))) {
      return "👋 Hey! I'm your Earth Engine assistant for Pakistan. I can show you satellite data like:\n\n• Snow cover in northern areas\n• Flood risk zones\n• Population density\n• Air quality\n• Temperature data\n• And much more!\n\nJust ask me to show you any environmental data.";
    }

    // Identity
    if (msg.includes("what are you") || msg.includes("who are you")) {
      return '🛰️ I\'m an AI assistant powered by **Google Earth Engine**. I help visualize satellite and geospatial data over Pakistan.\n\nI can access:\n• Real-time satellite imagery\n• Climate data (temperature, rainfall)\n• Hazard maps (floods, landslides, fires)\n• Environmental indices (NDVI, NDSI, NDWI)\n• Population & infrastructure data\n\nTry asking: "Show me snow in Hunza" or "Flood risk in Sindh"';
    }

    // Capabilities
    if (
      msg.includes("what can you do") ||
      msg.includes("help") ||
      msg === "?"
    ) {
      return '🎯 **I can help you with:**\n\n**🌊 Hazards:**\n• Flood extent & susceptibility\n• Landslide risk areas\n• Fire detection & burn scars\n• Drought severity\n• Earthquake zones\n\n**🌍 Environment & Climate:**\n• Snow & glacier monitoring\n• Vegetation health (NDVI)\n• Water bodies & hydrology\n• Air quality (AOD)\n• Land Surface Temperature\n• Urban Heat Island effects\n• Land Use Land Cover (LULC)\n• Evapotranspiration\n• Thermal comfort index\n\n**🌊 Climate Scenarios:**\n• Sea Level Rise 2050/2100\n• Coastal flooding risk\n\n**🏙️ Urban:**\n• Population density\n• Urban growth (NDBI)\n• Nighttime lights\n• Built-up areas\n\n**Example queries:**\n• "Show flood risk in Karachi"\n• "Urban heat island in Lahore"\n• "Land use cover in Islamabad"\n• "Sea level rise 2050 Gwadar"';
    }

    // Thanks
    if (msg.includes("thank") || msg.includes("thanks")) {
      return "😊 You're welcome! Let me know if you need any more satellite data or hazard information.";
    }

    // Status
    if (
      msg.includes("how are you") ||
      msg.includes("whats up") ||
      msg.includes("what's up")
    ) {
      return "🛰️ I'm functioning perfectly! All satellite connections active and ready to pull data for Pakistan.\n\nWhat environmental data would you like to explore?";
    }

    // Coverage
    if (
      msg.includes("where") &&
      (msg.includes("cover") || msg.includes("work"))
    ) {
      return "🗺️ I cover **all of Pakistan** including:\n\n📍 **55+ cities** from Karachi to Gilgit\n🏔️ **All provinces** (Punjab, Sindh, KPK, Balochistan, GB)\n🌊 **River basins** (Indus, Chenab, Jhelum, Ravi, Sutlej)\n\nJust specify any location in Pakistan and I'll get the data!";
    }

    // Download info
    if (msg.includes("download") && !msg.includes("show")) {
      return "📥 **To download layer data:**\n\n1. Ask me to show any dataset\n2. Click the **📥 Download Info** button in the response\n3. You'll get a JSON file with:\n   • Tile URL (use in QGIS/ArcGIS)\n   • Metadata & visualization settings\n   • Usage instructions\n\n**Note:** I provide tile URLs, not raw raster files. Use GIS software to access the full dataset via the tile service.";
    }

    // Goodbye
    if (
      msg.includes("bye") ||
      msg.includes("goodbye") ||
      msg.includes("see you")
    ) {
      return "👋 See you later! Come back anytime you need satellite data for Pakistan. Stay safe!";
    }

    return null;
  }

  #addChatMessage(role, content, isLoading = false) {
    const container = this.#geeChatMessages;
    const msgId = `msg-${Date.now()}-${Math.random()}`;

    const msgDiv = document.createElement("div");
    msgDiv.className = `gee-chat-message gee-chat-${role}`;
    msgDiv.id = msgId;
    msgDiv.innerHTML = this.#formatMessage(content);

    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;

    lucide.createIcons();

    return msgId;
  }

  #formatMessage(text) {
    return text
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  #addLayerResponse(data) {
    const container = this.#geeChatMessages;

    const responseDiv = document.createElement("div");
    responseDiv.className =
      "gee-chat-message gee-chat-assistant gee-layer-response";
    responseDiv.setAttribute("data-layer-id", data.layer_id);

    responseDiv.innerHTML = `
      <div class="gee-response-text">${this.#formatMessage(data.response)}</div>
      
      ${
        data.description
          ? `
        <div class="gee-description-box">
          <strong>📊 What this shows:</strong><br>
          <span style="font-size:12px; color:#ccc;">${this.#formatMessage(
            data.description
          )}</span>
        </div>
      `
          : ""
      }
      
      ${
        data.legend
          ? `
        <div class="gee-legend-container">
          <img src="${data.legend}" alt="Legend" class="gee-legend-image">
        </div>
      `
          : ""
      }
      
      <div class="gee-layer-controls">
        <label class="gee-checkbox-label">
          <input type="checkbox" 
                 class="gee-layer-checkbox" 
                 data-layer-id="${data.layer_id}"
                 ${data.added ? "checked" : ""}>
          <span>${data.added ? "Remove from map" : "Add to map"}</span>
        </label>
        
        <button class="gee-download-btn" data-layer-id="${
          data.layer_id
        }" title="Download layer info & metadata">
          <i data-lucide="download" style="width:14px;height:14px"></i>
          <span>Download Info</span>
        </button>
      </div>
    `;

    container.appendChild(responseDiv);
    container.scrollTop = container.scrollHeight;

    // Check for temporal data
    if (
      data.temporal &&
      data.temporal.available === true &&
      data.temporal.start_year &&
      data.temporal.end_year &&
      !data.temporal.enabled
    ) {
      this.#showTemporalDialog(data);
    }

    // Attach listeners
    const checkbox = responseDiv.querySelector(".gee-layer-checkbox");
    checkbox.addEventListener("change", (e) => {
      this.#toggleGeeLayer(data.layer_id, e.target.checked);
    });

    const downloadBtn = responseDiv.querySelector(".gee-download-btn");
    downloadBtn.addEventListener("click", () => {
      this.#downloadLayerInfo(data.layer_id);
    });

    lucide.createIcons();
  }

  // ============================================================
  // OPTIMIZED TEMPORAL TIMELINE IMPLEMENTATION
  // ============================================================

  /**
   * Show temporal dialog inline within chatbot (no full-screen backdrop)
   */
  #showTemporalDialog(data) {
    const startYear = data.temporal.start_year;
    const endYear = data.temporal.end_year;
    const datasetName = data.dataset_name || "this dataset";
    const note = data.temporal.note || "";

    console.log(`📅 ${datasetName} available years: ${startYear} - ${endYear}`);

    // Calculate suggested years (5 evenly spaced)
    const yearCount = endYear - startYear + 1;
    let suggestedYears;

    if (yearCount <= 5) {
      suggestedYears = Array.from(
        { length: yearCount },
        (_, i) => startYear + i
      );
    } else {
      const step = Math.floor((endYear - startYear) / 4);
      suggestedYears = [
        startYear,
        startYear + step,
        startYear + 2 * step,
        startYear + 3 * step,
        endYear,
      ];
    }

    // Create dialog inline (no backdrop)
    const dialogContainer = document.createElement("div");
    dialogContainer.className = "gee-temporal-dialog";
    dialogContainer.innerHTML = `
      <div class="gee-temporal-dialog-content">
        <div class="gee-temporal-dialog-header">
          <i data-lucide="calendar-range"></i>
          <span>Temporal Data Configuration</span>
        </div>
        
        <div class="gee-temporal-dialog-body">
          <p><strong>Dataset:</strong> ${datasetName}</p>
          <p><strong>📅 Available Years:</strong> ${startYear} - ${endYear} (${yearCount} years)</p>
          ${
            note
              ? `<p style="color:#fbbf24;font-size:12px;"><strong>Note:</strong> ${note}</p>`
              : ""
          }
          
          <div class="gee-temporal-input-block">
            <label>Select Years (comma-separated):</label>
            <input 
              type="text" 
              class="gee-temporal-input"
              id="gee-temporal-years-input-${data.layer_id}"
              value="${suggestedYears.join(", ")}"
              placeholder="e.g., ${startYear}, ${Math.floor(
      (startYear + endYear) / 2
    )}, ${endYear}">
            <small class="gee-temporal-hint">
              💡 Suggested: ${suggestedYears.join(
                ", "
              )} | Valid range: ${startYear}-${endYear}
            </small>
            <small class="gee-temporal-error" id="gee-temporal-error-${
              data.layer_id
            }"></small>
          </div>
        </div>
        
        <div class="gee-temporal-actions">
          <button class="gee-temporal-btn gee-temporal-cancel" data-layer-id="${
            data.layer_id
          }">
            <i data-lucide="x"></i>
            <span>Cancel</span>
          </button>
          <button class="gee-temporal-btn gee-temporal-confirm" data-layer-id="${
            data.layer_id
          }">
            <i data-lucide="check"></i>
            <span>Load Timeline</span>
          </button>
        </div>
      </div>
    `;

    // Append to chat messages container
    this.#geeChatMessages.appendChild(dialogContainer);
    this.#geeChatMessages.scrollTop = this.#geeChatMessages.scrollHeight;

    lucide.createIcons();

    const input = dialogContainer.querySelector(
      `#gee-temporal-years-input-${data.layer_id}`
    );
    const errorDiv = dialogContainer.querySelector(
      `#gee-temporal-error-${data.layer_id}`
    );
    const cancelBtn = dialogContainer.querySelector(".gee-temporal-cancel");
    const confirmBtn = dialogContainer.querySelector(".gee-temporal-confirm");

    // Validate years
    const validateYears = () => {
      const value = input.value.trim();
      if (!value) {
        errorDiv.textContent = "Please enter at least one year";
        errorDiv.style.display = "block";
        return null;
      }

      const years = value
        .split(",")
        .map((y) => parseInt(y.trim()))
        .filter((y) => !isNaN(y));

      if (years.length === 0) {
        errorDiv.textContent = "No valid years found";
        errorDiv.style.display = "block";
        return null;
      }

      const invalidYears = years.filter((y) => y < startYear || y > endYear);

      if (invalidYears.length > 0) {
        errorDiv.textContent = `Invalid years: ${invalidYears.join(
          ", "
        )}. Valid range: ${startYear}-${endYear}`;
        errorDiv.style.display = "block";
        return null;
      }

      const sortedYears = [...new Set(years)].sort((a, b) => a - b);

      if (sortedYears.length > 20) {
        errorDiv.textContent = "Maximum 20 years allowed";
        errorDiv.style.display = "block";
        return null;
      }

      errorDiv.style.display = "none";
      return sortedYears;
    };

    input.addEventListener("input", () => {
      errorDiv.style.display = "none";
    });

    cancelBtn.addEventListener("click", () => {
      dialogContainer.remove();
      this.#addChatMessage(
        "assistant",
        "⏸️ Temporal timeline configuration cancelled. You can still use the latest year data."
      );
    });

    confirmBtn.addEventListener("click", () => {
      const years = validateYears();
      if (years) {
        console.log(`✅ Valid years selected: ${years.join(", ")}`);
        dialogContainer.remove();
        this.#addTemporalTimeline(data, years);
      }
    });

    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        confirmBtn.click();
      }
    });

    // Focus input for immediate typing
    input.focus();
  }

  /**
   * Add temporal timeline UI within chatbot messages
   */
  #addTemporalTimeline(data, years) {
    if (!years || years.length === 0) {
      console.error("No valid years provided");
      return;
    }

    const startYear = data.temporal.start_year;
    const endYear = data.temporal.end_year;

    console.log(
      `📅 Creating timeline: ${years.length} years from ${years[0]} to ${
        years[years.length - 1]
      }`
    );

    // Check if timeline already exists and remove it
    const existingTimeline = this.#geeChatMessages.querySelector(
      `#temporal-timeline-${data.layer_id}`
    );
    if (existingTimeline) {
      console.log("⚠️ Timeline already exists, removing old one");
      existingTimeline.remove();
    }

    const timelineContainer = document.createElement("div");
    timelineContainer.className = "gee-temporal-timeline";
    timelineContainer.id = `temporal-timeline-${data.layer_id}`;

    timelineContainer.innerHTML = `
      <div class="gee-temporal-timeline-header">
        <div class="gee-temporal-timeline-title">
          <i data-lucide="calendar-clock" style="width:14px;height:14px;margin-right:4px"></i>
          <span>Timeline</span>
        </div>
        <div class="gee-temporal-current-year" id="temporal-current-year-${
          data.layer_id
        }">
          ${years[years.length - 1]}
        </div>
      </div>
      
      <div class="gee-temporal-loading" id="temporal-loading-${data.layer_id}">
        <div class="gee-temporal-loading-spinner"></div>
        <div class="gee-temporal-loading-text">
          <span id="temporal-loading-progress-${
            data.layer_id
          }">Loading temporal data...</span>
          <small>Preparing ${years.length} years (${years[0]}-${
      years[years.length - 1]
    })</small>
        </div>
      </div>
      
      <div class="gee-temporal-timeline-content" id="temporal-content-${
        data.layer_id
      }" style="display:none;">
        <div class="gee-temporal-timeline-slider">
          <input type="range" 
                 class="gee-temporal-year-slider" 
                 id="temporal-year-slider-${data.layer_id}"
                 min="0" 
                 max="${years.length - 1}" 
                 value="${years.length - 1}"
                 step="1"
                 disabled
                 data-years='${JSON.stringify(years)}'
                 data-layer-id="${data.layer_id}">
          
          <div class="gee-temporal-year-labels">
            <span>${years[0]}</span>
            <span>${years[Math.floor(years.length / 2)]}</span>
            <span>${years[years.length - 1]}</span>
          </div>
        </div>
        
        <div class="gee-temporal-year-markers">
          ${years
            .map(
              (year, idx) => `
            <div class="gee-temporal-year-marker" 
                 style="left: ${(idx / (years.length - 1)) * 100}%"
                 title="${year}">
              <div class="gee-temporal-year-dot"></div>
            </div>
          `
            )
            .join("")}
        </div>
        
        <div class="gee-temporal-timeline-controls">
          <button class="gee-temporal-control-btn gee-temporal-control-btn-remove" 
                  id="temporal-remove-${data.layer_id}" 
                  title="Remove timeline">
            <i data-lucide="x"></i>
          </button>
        </div>
      </div>
      
      <div class="gee-temporal-info">
        <small>📊 Dataset: ${startYear}-${endYear} | Loading: ${
      years.length
    } years</small>
        <small id="temporal-status-${
          data.layer_id
        }" style="display:block;margin-top:4px;"></small>
      </div>
    `;

    // Append timeline to chat messages
    this.#geeChatMessages.appendChild(timelineContainer);
    this.#geeChatMessages.scrollTop = this.#geeChatMessages.scrollHeight;

    console.log(`✅ Timeline container created for layer: ${data.layer_id}`);

    this.#preloadTemporalLayers(data, years);

    lucide.createIcons();
  }

  /**
   * Pre-load all temporal layers (prevents 429 errors)
   */
  async #preloadTemporalLayers(data, years) {
    const layerId = data.layer_id;
    const loadingDiv = document.getElementById(`temporal-loading-${layerId}`);
    const contentDiv = document.getElementById(`temporal-content-${layerId}`);
    const slider = document.getElementById(`temporal-year-slider-${layerId}`);
    const progressText = document.getElementById(
      `temporal-loading-progress-${layerId}`
    );
    const statusText = document.getElementById(`temporal-status-${layerId}`);

    console.log(
      `🔄 Pre-loading ${years.length} temporal layers for ${layerId}...`
    );

    try {
      progressText.textContent = `Fetching ${years.length} years from GEE...`;

      const response = await fetch("/api/gee/temporal-layer/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset_key: data.temporal.dataset_key,
          location: data.temporal.location_name,
          bbox: data.temporal.bbox,
          years: years,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();

      if (!result.success || !result.layers) {
        throw new Error("Invalid response from server");
      }

      console.log(
        `📦 Received ${result.layers.length} layer responses from backend`
      );

      // Initialize cache
      if (!this.#temporalLayerCache) {
        this.#temporalLayerCache = new Map();
        console.log(`🆕 Initialized temporal layer cache (Map)`);
      }

      const layerCache = new Map();
      let successCount = 0;
      let failedYears = [];

      // Process each layer
      for (const layerData of result.layers) {
        const year = layerData.year || layerData.requested_year;

        if (layerData.available && layerData.tile_url) {
          const temporalLayerId = `${layerId}-year-${year}`;

          // Cleanup if exists
          if (this.#map.getLayer(temporalLayerId)) {
            this.#map.removeLayer(temporalLayerId);
          }
          if (this.#map.getSource(temporalLayerId)) {
            this.#map.removeSource(temporalLayerId);
          }

          // Add source
          this.#map.addSource(temporalLayerId, {
            type: "raster",
            tiles: [layerData.tile_url],
            tileSize: 256,
            minzoom: 0,
            maxzoom: 22,
          });

          // Add layer (hidden with visibility)
          this.#map.addLayer({
            id: temporalLayerId,
            type: "raster",
            source: temporalLayerId,
            paint: {
              "raster-opacity": 0.8,
              "raster-fade-duration": 0,
            },
            layout: {
              visibility: "none", // KEY: Stops tile fetching
            },
          });

          // Add error listener for this temporal layer
          this.#map.on("error", (e) => {
            if (
              e.sourceId === temporalLayerId ||
              e.source?.id === temporalLayerId
            ) {
              console.warn(`⚠️ Temporal tile error for year ${year}:`, e.error);
              // Don't spam user with errors - temporal layers are pre-cached
            }
          });

          // Cache the layer
          layerCache.set(year, {
            layerId: temporalLayerId,
            tileUrl: layerData.tile_url,
            year: year,
          });

          successCount++;
          console.log(`✅ Cached layer for year ${year}`);
        } else {
          failedYears.push(year);
          console.warn(`⚠️ No data for year ${year}`);
        }
      }

      // Store cache
      this.#temporalLayerCache.set(layerId, layerCache);

      console.log(`💾 Cache stored for ${layerId}:`, {
        cacheExists: this.#temporalLayerCache.has(layerId),
        cachedYears: Array.from(layerCache.keys()),
        successCount: successCount,
      });

      if (successCount === 0) {
        throw new Error(
          `No data available for any year. Requested: ${years.join(", ")}`
        );
      }

      // Update status
      statusText.textContent = `✅ ${successCount}/${years.length} years loaded`;
      statusText.style.color = "#10b981";

      if (failedYears.length > 0) {
        statusText.textContent += ` (${failedYears.length} unavailable)`;
      }

      // Show content
      loadingDiv.style.display = "none";
      contentDiv.style.display = "block";
      slider.disabled = false;

      // Show most recent year
      const availableYears = Array.from(layerCache.keys()).sort(
        (a, b) => b - a
      );
      const mostRecentYear = availableYears[0];

      console.log(`👁️ Showing most recent year: ${mostRecentYear}`);
      this.#showTemporalYear(layerId, mostRecentYear);
      this.#attachOptimizedTimelineListeners(layerId, data, years);

      console.log(`✅ Temporal timeline ready for ${layerId}`);
    } catch (error) {
      console.error(`❌ Failed to pre-load temporal layers:`, error);

      progressText.textContent = "❌ Failed to load";
      progressText.style.color = "#ef4444";
      statusText.textContent = error.message;
      statusText.style.color = "#ef4444";

      loadingDiv.style.display = "none";
      contentDiv.style.display = "block";

      this.#addChatMessage(
        "assistant",
        `❌ Temporal loading failed: ${error.message}`
      );
    }
  }

  /**
   * Show specific year (instant visibility toggle)
   */
  #showTemporalYear(layerId, year) {
    const cache = this.#temporalLayerCache?.get(layerId);

    if (!cache) {
      console.error(`❌ No cache found for ${layerId}`);
      return;
    }

    // Hide all years
    cache.forEach((layerInfo) => {
      if (this.#map.getLayer(layerInfo.layerId)) {
        this.#map.setLayoutProperty(layerInfo.layerId, "visibility", "none");
      }
    });

    // Show selected year
    const layerInfo = cache.get(year);

    if (layerInfo && this.#map.getLayer(layerInfo.layerId)) {
      this.#map.setLayoutProperty(layerInfo.layerId, "visibility", "visible");
      console.log(`👁️ Showing year ${year}`);
    } else {
      console.warn(`⚠️ Year ${year} not in cache`);
    }
  }

  /**
   * Attach optimized timeline listeners
   */
  #attachOptimizedTimelineListeners(layerId, data, years) {
    const slider = document.getElementById(`temporal-year-slider-${layerId}`);
    const removeBtn = document.getElementById(`temporal-remove-${layerId}`);
    const currentYearDisplay = document.getElementById(
      `temporal-current-year-${layerId}`
    );

    // Slider input - INSTANT visibility toggle
    slider?.addEventListener("input", (e) => {
      const yearIndex = parseInt(e.target.value);
      const year = years[yearIndex];

      currentYearDisplay.textContent = year;
      this.#updateActiveMarker(layerId, yearIndex, years.length);
      this.#showTemporalYear(layerId, year);
    });

    // Remove button
    removeBtn?.addEventListener("click", () => {
      const cache = this.#temporalLayerCache?.get(layerId);
      if (cache) {
        cache.forEach((layerInfo) => {
          if (this.#map.getLayer(layerInfo.layerId)) {
            this.#map.removeLayer(layerInfo.layerId);
          }
          if (this.#map.getSource(layerInfo.layerId)) {
            this.#map.removeSource(layerInfo.layerId);
          }
        });
        this.#temporalLayerCache.delete(layerId);
        console.log(`🗑️ Removed cache for ${layerId}`);
      }

      const timeline = document.getElementById(`temporal-timeline-${layerId}`);
      timeline?.remove();

      this.#addChatMessage("assistant", "🗑️ Temporal timeline removed.");
    });
  }

  /**
   * Update active marker visualization
   */
  #updateActiveMarker(layerId, activeIndex, totalYears) {
    const timeline = document.getElementById(`temporal-timeline-${layerId}`);
    if (!timeline) return;

    const markers = timeline.querySelectorAll(".gee-temporal-year-marker");
    markers.forEach((marker, idx) => {
      marker.classList.toggle("active", idx === activeIndex);
      marker.classList.toggle("past", idx < activeIndex);
    });
  }

  /**
   * Toggle GEE layer on/off with error handling
   */
  #toggleGeeLayer(layerId, shouldAdd) {
    const layerInfo = this.#geeLayers.get(layerId);
    if (!layerInfo) return;

    if (shouldAdd) {
      if (!this.#map.getSource(layerId)) {
        try {
          this.#map.addSource(layerId, {
            type: "raster",
            tiles: [layerInfo.tile_url],
            tileSize: 256,
          });

          this.#map.addLayer({
            id: layerId,
            type: "raster",
            source: layerId,
            paint: { "raster-opacity": 0.7 },
          });

          // Add error listener for tile loading failures
          this.#map.on("error", (e) => {
            if (e.sourceId === layerId || e.source?.id === layerId) {
              console.error(`❌ GEE Tile Error for ${layerId}:`, e.error);

              // Show user-friendly error message
              this.#addChatMessage(
                "assistant",
                `⚠️ **Tile Loading Error**\n\nThe layer tiles failed to load. This usually means:\n• The map ID has expired (GEE map IDs expire after 3 days)\n• The dataset is temporarily unavailable\n• There's an authentication issue\n\n**Solution:** Try requesting the layer again to generate a fresh map ID.`
              );

              // Auto-remove the broken layer
              setTimeout(() => {
                if (this.#map.getLayer(layerId)) {
                  this.#map.removeLayer(layerId);
                }
                if (this.#map.getSource(layerId)) {
                  this.#map.removeSource(layerId);
                }
                layerInfo.added = false;

                // Update checkbox
                const checkbox = document.querySelector(
                  `input.gee-layer-checkbox[data-layer-id="${layerId}"]`
                );
                if (checkbox) {
                  checkbox.checked = false;
                  const labelSpan =
                    checkbox.parentElement.querySelector("span");
                  if (labelSpan) {
                    labelSpan.textContent = "Add to map";
                  }
                }
              }, 2000);
            }
          });

          layerInfo.added = true;
          console.log(`✅ Added layer: ${layerId}`);
        } catch (error) {
          console.error(`❌ Error adding layer ${layerId}:`, error);
          this.#addChatMessage(
            "assistant",
            `❌ Failed to add layer to map: ${error.message}`
          );
        }
      }
    } else {
      if (this.#map.getLayer(layerId)) {
        this.#map.removeLayer(layerId);
        this.#map.removeSource(layerId);
        layerInfo.added = false;
        console.log(`❌ Removed layer: ${layerId}`);
      }
    }

    // Update checkbox text
    const checkbox = document.querySelector(
      `input.gee-layer-checkbox[data-layer-id="${layerId}"]`
    );
    if (checkbox) {
      const labelSpan = checkbox.parentElement.querySelector("span");
      if (labelSpan) {
        labelSpan.textContent = shouldAdd ? "Remove from map" : "Add to map";
      }
    }
  }

  /**
   * Download layer metadata
   */
  #downloadLayerInfo(layerId) {
    const layerInfo = this.#geeLayers.get(layerId);
    if (!layerInfo) {
      console.error(`❌ Layer ${layerId} not found`);
      return;
    }

    const metadata = {
      layer_id: layerId,
      dataset: layerInfo.dataset,
      location: layerInfo.location,
      tile_url_template: layerInfo.tile_url,
      legend_url: layerInfo.legend,
      visualization: layerInfo.visualization,
      download_info: {
        description: "Google Earth Engine Layer Information",
        note: "Use the tile_url_template in GIS software (QGIS, ArcGIS) as XYZ Tiles",
        tile_format: "Raster tiles served by Google Earth Engine",
        coordinate_system: "EPSG:3857 (Web Mercator)",
        tile_size: "256x256 pixels",
      },
      instructions: {
        qgis: "Layer → Add Layer → Add XYZ Tiles → Paste tile_url_template",
        arcgis: "Add Data → Add Basemap → Use tile_url_template as service URL",
        web: "Use with Leaflet, OpenLayers, or Mapbox GL JS as raster source",
      },
      exported_at: new Date().toISOString(),
      generated_by: "NDMA NCOP GEE Chatbot",
    };

    const jsonStr = JSON.stringify(metadata, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const timestamp = new Date().toISOString().split("T")[0];
    const safeName = layerInfo.dataset
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();
    const filename = `gee_${safeName}_${layerInfo.location}_${timestamp}.json`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);

    console.log(`✅ Downloaded layer info: ${filename}`);

    this.#addChatMessage(
      "assistant",
      `📥 Downloaded **${layerInfo.dataset}** metadata as **${filename}**\n\nYou can use the tile URL in GIS software like QGIS or ArcGIS Pro.`
    );
  }
}

// Export for use in other modules
export { SOUTH_ASIA_COORDS };
