// NavigationPanel.js - SOUTH ASIA INTEGRATED VERSION
// Handles:
//  - bottom-right map navigation controls (zoom, bearing, 3D toggle, locate, home)
//  - South Asia coordinate jumps
//  - News modal UI (fetch, render, markers, scroll pause, clock)
// Single source of truth for navigation + news

import { MapControls } from "./map-controls.js";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import { SatelliteTracker } from "./satellite-tracker.js";

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
  #geocoder = null;

  // News-related state
  #newsSelected = {};
  #newsMarkers = {};
  #scrollPaused = false;
  #includeSocialMedia = false;
  #baseUrl = window.location.origin;
  // Globe spin (Mapbox official pattern)
  #spinEnabled = false;
  #userInteracting = false;

  // Spin tuning (same idea as Mapbox demo)
  #secondsPerRevolution = 100; // 🔥 faster than 120 so you can SEE it
  #maxSpinZoom = 5;
  #slowSpinZoom = 3;

  // "first touch stops forever" rule
  #spinStoppedByUser = false;

  // Satellite tracker instance
  #satelliteTracker = null;
  /**
   * @param {mapboxgl.Map} mapInstance
   * @param {MapControls} mapControlsInstance
   * @param {ProjectionPanel} projectionPanelInstance
   */
  constructor(mapInstance, mapControlsInstance, projectionPanelInstance) {
    this.#map = mapInstance;
    this.#mapControls = mapControlsInstance;
    this.projectionPanel = projectionPanelInstance;

    this.render();
    // Start globe spinning on initial load
    this.addEventListeners();
    // Start spin automatically when style is ready (matches Mapbox example)
    this.#map.on("style.load", () => {
      // Optional: if you use globe + fog, keep your existing fog code elsewhere.
      this.#startInitialGlobeSpin();
    });
    this.setupNewsIntegration();
    this.#initializeNewsModal();
    this.#updateNewsClock();

    // keep the live clock running
    setInterval(() => this.#updateNewsClock(), 1000);

    // Restore terrain state
    this.restoreToggle3DState(
      window.ncop_storage?.getSetting("terrainEnabled") || false
    );
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

          <!-- COLLAPSE/EXPAND (top — panel opens downward) -->
          <button id="navToggleBtn" class="nav-toggle-btn" title="Toggle Navigation Controls">
              <i data-lucide="chevron-up"></i>
          </button>

          <!-- TOUR GUIDE -->
          <button id="tourGuideBtn" class="custom-nav-btn tour-nav-btn" title="Start Guided Tour">
              <i data-lucide="map"></i>
          </button>

          <!-- ZOOM CONTROLS -->
          <button id="zoomIn" class="custom-nav-btn" title="Zoom In">
              <i data-lucide="plus"></i>
          </button>

          <button id="zoomOut" class="custom-nav-btn" title="Zoom Out">
              <i data-lucide="minus"></i>
          </button>

          <!-- 3D TOGGLE -->
          <button id="toggle3D" class="custom-nav-btn" title="Switch to 3D View (2D Mode)">
              <span class="nav-text">3D</span>
          </button>

          <!-- PROJECTION SWITCH -->
          <button id="projectionSwitch" class="custom-nav-btn" title="Map Projections">
              <i data-lucide="earth"></i>
          </button>

          <!-- SPINNING GLOBE TOGGLE -->
          <button id="spinGlobe" class="custom-nav-btn" title="Toggle Spinning Globe">
              <i data-lucide="rotate-3d"></i>
          </button>

          <!-- LOCAL NEWS TOGGLE -->
          <button id="localNews" class="custom-nav-btn" title="Toggle Local News Panel">
              <i data-lucide="newspaper"></i>
          </button>

          <!-- ZOOM TO HOME (GLOBAL VIEW) -->
          <button id="zoomHome" class="custom-nav-btn" title="Zoom to Global View">
              <i data-lucide="fullscreen"></i>
          </button>

          <!-- SATELLITE TRACKER -->
          <button id="satTrackerBtn" class="custom-nav-btn" title="Satellite Tracker">
              <i data-lucide="satellite"></i>
          </button>

      </div>
    `;

    mapContainer.appendChild(navWrapper);
    this.#renderGeocoder(mapContainer);

    // Satellite tracker modal
    const satModal = document.createElement("div");
    satModal.id = "sat-tracker-modal";
    satModal.className = "sat-tracker-modal";
    satModal.innerHTML = `
      <div class="sat-modal-header">
        <div class="sat-modal-title">
          <span class="sat-modal-icon">🛰️</span>
          <div>
            <div class="sat-modal-heading">Satellite Tracker</div>
            <div class="sat-modal-status" id="satTrackerStatus">Ready — click a load button below.</div>
          </div>
        </div>
        <button id="satModalCloseBtn" class="custom-nav-btn" title="Close">
          <i data-lucide="x"></i>
        </button>
      </div>
      <div class="sat-modal-body">
        <div class="sat-modal-row">
          <button id="satLoadStationsBtn" class="sat-action-btn">
            <i data-lucide="radio-tower"></i> ISS / Stations
          </button>
          <button id="satLoadEOBtn" class="sat-action-btn">
            <i data-lucide="cloud"></i> EO / Weather
          </button>
        </div>
        <div class="sat-modal-row">
          <button id="satPauseBtn" class="sat-action-btn" disabled>
            <i data-lucide="pause"></i> Pause
          </button>
          <button id="satClearTrailsBtn" class="sat-action-btn" disabled>
            <i data-lucide="eraser"></i> Clear Trails
          </button>
        </div>
        <button id="satRemoveBtn" class="sat-action-btn sat-remove-btn" disabled>
          <i data-lucide="trash-2"></i> Remove Satellites
        </button>
      </div>
    `;
    mapContainer.appendChild(satModal);

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

    document.getElementById("tourGuideBtn")?.addEventListener("click", () => {
      window.ncopTourGuide?.toggle?.();
    });

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

    // =====================================================
    // ZOOM TO HOME (GLOBAL VIEW)
    // =====================================================
    document.getElementById("zoomHome")?.addEventListener("click", () => {
      map.flyTo({
        center: [0, 0],   // Center of the globe
        zoom: 1,          // Global zoom level
        bearing: 0,
        pitch: 0,
        essential: true
      });
    });
    // Local News Toggle
    document
      .getElementById("localNews")
      ?.addEventListener("click", this.#handleNewsToggle.bind(this));

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

    // Spinning Globe Toggle
    // document
    //   .getElementById("spinGlobe")
    //   ?.addEventListener("click", this.#handleSpinGlobe.bind(this));
    // Spinning Globe Toggle (manual button)
    document.getElementById("spinGlobe")?.addEventListener("click", () => {
      // If the user already touched the map, button acts as normal toggle (optional)
      // If you want it to NEVER spin again even via button, remove the next 3 lines.
      if (this.#spinStoppedByUser) this.#spinStoppedByUser = false;

      this.#spinEnabled = !this.#spinEnabled;

      if (this.#spinEnabled) {
        this.#updateSpinButtonUI();
        this.#spinGlobeTick();
      } else {
        this.#map.stop();
        this.#updateSpinButtonUI();
      }
    });
    // Pause spinning on interaction (first touch/click stops spinning + deactivates button)
    this.#map.on("mousedown", () => {
      this.#userInteracting = true;
      this.#stopGlobeSpinByUser();
    });

    this.#map.on("touchstart", () => {
      this.#userInteracting = true;
      this.#stopGlobeSpinByUser();
    });

    this.#map.on("wheel", () => {
      this.#stopGlobeSpinByUser();
    });

    // Safety: if interaction ends, we WOULD resume in Mapbox demo,
    // but your requirement is "stop on first touch" so we do nothing.
    this.#map.on("mouseup", () => {
      this.#userInteracting = false;
    });
    this.#map.on("dragend", () => {
      this.#userInteracting = false;
    });
    this.#map.on("pitchend", () => {
      this.#userInteracting = false;
    });
    this.#map.on("rotateend", () => {
      this.#userInteracting = false;
    });

    // Mapbox demo loop trigger: when movement ends, attempt next spin step
    this.#map.on("moveend", () => {
      this.#spinGlobeTick();
    });

    // ── Satellite Tracker ──────────────────────────────────────────────────
    this.#satelliteTracker = new SatelliteTracker(this.#map);

    const satBtn         = document.getElementById("satTrackerBtn");
    const satModal       = document.getElementById("sat-tracker-modal");
    const satStatus      = document.getElementById("satTrackerStatus");
    const satLoadStn     = document.getElementById("satLoadStationsBtn");
    const satLoadEO      = document.getElementById("satLoadEOBtn");
    const satPause       = document.getElementById("satPauseBtn");
    const satClear       = document.getElementById("satClearTrailsBtn");
    const satRemove      = document.getElementById("satRemoveBtn");
    const satClose       = document.getElementById("satModalCloseBtn");

    // Toggle modal open/close
    satBtn?.addEventListener("click", () => {
      if (!satModal) return;
      const isOpen = satModal.classList.toggle("sat-modal-open");
      satBtn.classList.toggle("active", isOpen);
    });

    satClose?.addEventListener("click", () => {
      satModal?.classList.remove("sat-modal-open");
      satBtn?.classList.remove("active");
    });

    const setStatus = (msg) => { if (satStatus) satStatus.textContent = msg; };

    const afterLoad = (ok) => {
      satPause.disabled  = !ok;
      satClear.disabled  = !ok;
      satRemove.disabled = !ok;
      satLoadStn.disabled = false;
      satLoadEO.disabled  = false;
      if (ok) {
        satPause.innerHTML = `<i data-lucide="pause"></i> Pause`;
        if (window.lucide?.createIcons) window.lucide.createIcons();
      }
    };

    const doLoad = async (group) => {
      [satLoadStn, satLoadEO, satPause, satClear, satRemove].forEach(b => { if (b) b.disabled = true; });
      await this.#satelliteTracker.init(group, setStatus);
      const ok = this.#satelliteTracker.isActive;
      afterLoad(ok);
    };

    satLoadStn?.addEventListener("click", () => doLoad("stations"));
    satLoadEO?.addEventListener("click",  () => doLoad("eo"));

    satPause?.addEventListener("click", () => {
      const paused = this.#satelliteTracker.togglePause();
      satPause.innerHTML = paused
        ? `<i data-lucide="play"></i> Resume`
        : `<i data-lucide="pause"></i> Pause`;
      if (window.lucide?.createIcons) window.lucide.createIcons();
    });

    satClear?.addEventListener("click", () => {
      this.#satelliteTracker.clearTrails();
    });

    satRemove?.addEventListener("click", () => {
      this.#satelliteTracker.destroy(setStatus);
      [satPause, satClear, satRemove].forEach(b => { if (b) b.disabled = true; });
      satPause.innerHTML = `<i data-lucide="pause"></i> Pause`;
      if (window.lucide?.createIcons) window.lucide.createIcons();
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
  #updateSpinButtonUI() {
    const btn = document.getElementById("spinGlobe");
    if (!btn) return;

    if (this.#spinEnabled && !this.#spinStoppedByUser) {
      btn.classList.add("spin-active");
      btn.title = "Spinning Globe (auto). Touch map to stop.";
    } else {
      btn.classList.remove("spin-active");
      btn.title = "Toggle Spinning Globe";
    }
  }

  #spinGlobeTick() {
    // Block if user already stopped it by interacting
    if (this.#spinStoppedByUser) return;

    const zoom = this.#map.getZoom();
    if (this.#spinEnabled && !this.#userInteracting && zoom < this.#maxSpinZoom) {
      let distancePerSecond = 360 / this.#secondsPerRevolution;

      if (zoom > this.#slowSpinZoom) {
        const zoomDif =
          (this.#maxSpinZoom - zoom) / (this.#maxSpinZoom - this.#slowSpinZoom);
        distancePerSecond *= zoomDif;
      }

      const center = this.#map.getCenter();
      center.lng -= distancePerSecond;

      // IMPORTANT: easeTo triggers moveend → which triggers next tick
      this.#map.easeTo({
        center,
        duration: 1000,
        easing: (n) => n,
      });
    }
  }

  #startInitialGlobeSpin() {
    // Start only once, on initial load
    if (this.#spinStoppedByUser) return;

    this.#spinEnabled = true;
    this.#updateSpinButtonUI();
    this.#spinGlobeTick(); // kick off the moveend loop
  }

  #stopGlobeSpinByUser() {
    if (this.#spinStoppedByUser) return;

    this.#spinStoppedByUser = true;
    this.#spinEnabled = false;
    this.#map.stop(); // immediately cancel ongoing easeTo
    this.#updateSpinButtonUI();
  }


  /**
   * Handle navigation panel collapse/expand
   */
  #handleNavToggle() {
    const navControlsContainer = document.getElementById(
      "navControlsContainer"
    );
    const isCollapsed = navControlsContainer.classList.toggle("collapsed");
    const toggleBtn = document.getElementById("navToggleBtn");
    if (toggleBtn) {
      toggleBtn.classList.toggle("is-collapsed", isCollapsed);
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
  
  #renderGeocoder(mapContainer) {
    // Prevent duplicates
    if (document.getElementById("ncopGeocoderWrapper")) return;

    const wrapper = document.createElement("div");
    wrapper.id = "ncopGeocoderWrapper";
    wrapper.className = "ncop-geocoder-wrapper"; // collapsed by default (no is-open)

    wrapper.innerHTML = `
    <div class="ncop-geocoder-icon" title="Search">
      <i data-lucide="search"></i>
    </div>
    <div class="ncop-geocoder-mount" id="ncopGeocoderMount"></div>
  `;

    mapContainer.appendChild(wrapper);

    // Create icons
    if (window.lucide?.createIcons) window.lucide.createIcons();

    const mount = wrapper.querySelector("#ncopGeocoderMount");
    if (!mount) return;

    // Create geocoder (keep it always "not collapsed"; we manage collapsing ourselves)
    try {
      this.#geocoder = new MapboxGeocoder({
        accessToken: mapboxgl.accessToken,
        mapboxgl,
        marker: false,
        flyTo: { speed: 1.2, curve: 1.2, essential: true },
        placeholder: "Search place…",
        collapsed: false,
        clearAndBlurOnEsc: true,
      });

      mount.appendChild(this.#geocoder.onAdd(this.#map));
    } catch (e) {
      console.warn("⚠️ Geocoder failed to initialize:", e);
      return;
    }

    // Helper: get the input inside geocoder
    const getInput = () =>
      wrapper.querySelector(".mapboxgl-ctrl-geocoder--input");

    const open = () => {
      wrapper.classList.add("is-open");
      const input = getInput();
      if (input) {
        input.focus();
        // optional: select existing text
        try { input.select(); } catch (_) { }
      }
    };

    const close = () => {
      wrapper.classList.remove("is-open");
      const input = getInput();
      if (input) input.blur();
    };

    // Click icon/wrapper to open
    wrapper.addEventListener("click", (ev) => {
      // If already open, don't force close on internal clicks
      if (!wrapper.classList.contains("is-open")) open();
      ev.stopPropagation();
    });

    // Close when clicking outside
    document.addEventListener("click", (ev) => {
      if (!wrapper.classList.contains("is-open")) return;
      if (!wrapper.contains(ev.target)) close();
    });

    // Close on ESC (even if suggestions open)
    wrapper.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        close();
        ev.stopPropagation();
      }
    });

    // After selecting a result, optionally auto-close
    this.#geocoder.on("result", () => {
      close();
    });

    // Prevent map drag/zoom while interacting with the control
    ["dblclick", "mousedown", "touchstart", "wheel"].forEach((evt) => {
      wrapper.addEventListener(evt, (ev) => ev.stopPropagation(), {
        passive: evt === "wheel",
      });
    });
  }



  /**
   * Handle 3D toggle
   */
  #handleToggle3D() {
    const currentTerrain =
      window.ncop_storage?.getSetting("terrainEnabled") || false;
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
        new mapboxgl.Popup().setHTML(
          "<strong>📍 Islamabad</strong><br>Capital of Pakistan<br><small>Your Location Marker</small>"
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
      zoom: 3,
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
   * Handle spinning globe toggle
   */
  // #handleSpinGlobe() {
  //   if (this.#isGlobeSpinning) {
  //     this.#stopGlobeSpin();
  //   } else {
  //     this.#startGlobeSpin();
  //   }
  // }

  /**
   * Fetch news from Django backend
   * @param {boolean} includeSM - Include social media or just regular
   */
  async #fetchNews(includeSM = false) {
    // Show skeleton loader immediately while waiting for the API
    const newsModal = document.getElementById("news-modal");
    const container = document.getElementById("news-scroll");
    if (container) {
      container.innerHTML = `
        <div class="ticker-skeleton">
          <div class="ticker-skeleton-item"></div>
          <div class="ticker-skeleton-item"></div>
          <div class="ticker-skeleton-item"></div>
          <div class="ticker-skeleton-item"></div>
        </div>
      `;
    }
    newsModal?.classList.remove("news-loaded");
    newsModal?.classList.add("news-loading");

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

      if (!container) {
        console.error("❌ News scroll container not found");
        return;
      }

      container.innerHTML = "";

      // No data case
      if (!geojson.features || geojson.features.length === 0) {
        newsModal?.classList.remove("news-loading", "news-loaded");
        container.innerHTML = `
          <div style="color: white; padding: 8px 16px; font-size:11px; opacity:0.7;">
              🔍 No news data available — try the other source button
          </div>
        `;
        newsModal?.classList.add("news-loaded");
        return;
      }

      // Build items — originals only (no double handler)
      const items = [];
      geojson.features.forEach((feature, index) => {
        const props = feature.properties;
        const metaHtml = this.#generateTickerMeta(props);
        const displayDate = this.#formatGdeltDate(props.formatted_date);
        const headline = this.#sanitizeHTML(props.title || "Untitled");

        const item = document.createElement("div");
        item.className = "ticker-item";
        item.dataset.index = index;
        item.innerHTML = `
          <div class="ticker-meta">
            ${metaHtml}
            <span class="ticker-bullet">•</span>
            <span class="ticker-date">${displayDate}</span>
          </div>
          <div class="ticker-headline">${headline}</div>
        `;
        // Attach click handler ONCE on the original
        item.addEventListener("click", () => this.#toggleNewsMarker(index, feature));
        items.push(item);
      });

      // Append originals, then deep-clones for seamless infinite loop
      items.forEach(item => container.appendChild(item));
      items.forEach(item => {
        const clone = item.cloneNode(true);
        const idx = parseInt(clone.dataset.index);
        clone.addEventListener("click", () =>
          this.#toggleNewsMarker(idx, geojson.features[idx])
        );
        container.appendChild(clone);
      });

      // Reveal divider + rail now that content is ready
      newsModal?.classList.remove("news-loading");
      newsModal?.classList.add("news-loaded");

      window.gdeltNewsFeatures = geojson.features;
    } catch (error) {
      console.error("❌ Error fetching news:", error);
      newsModal?.classList.remove("news-loading");
      if (container) {
        newsModal?.classList.add("news-loaded");
        container.innerHTML = `
          <div style="color:#ff6b6b; padding:8px 16px; font-size:11px;">
              ⚠ Failed to load news: ${this.#sanitizeHTML(error.message)}
          </div>
        `;
      }
    }
  }

  /**
   * Render the meta row (flag + tag + country) for a ticker item.
   * Returns inner HTML fragments that go inside .ticker-meta
   */
  #generateTickerMeta(props) {
    const flagBase = "https://flagcdn.com/";

    if (props.source_platform === "reddit") {
      const sub = this.#sanitizeHTML(props.reddit_subreddit || "unknown");
      return `
        <span class="ticker-tag tag-reddit">REDDIT</span>
        <span class="ticker-country">r/${sub}</span>
      `;
    }

    if (props.source_platform === "mastodon") {
      const author = this.#sanitizeHTML(props.mastodon_author || "unknown");
      return `
        <span class="ticker-tag tag-mastodon">MASTODON</span>
        <span class="ticker-country">@${author}</span>
      `;
    }

    // Traditional GDELT news
    const country = props.sourcecountry || "Unknown";
    const isoCode = (COUNTRY_ISO_MAP[country] || "un").toLowerCase();
    return `
      <picture class="ticker-flag">
        <source type="image/webp" srcset="${flagBase}16x12/${isoCode}.webp">
        <source type="image/png"  srcset="${flagBase}16x12/${isoCode}.png">
        <img src="${flagBase}16x12/${isoCode}.png" width="16" height="12"
             alt="${this.#sanitizeHTML(country)} flag" onerror="this.style.display='none'">
      </picture>
      <span class="ticker-tag tag-news">NEWS</span>
      <span class="ticker-country">${this.#sanitizeHTML(country)}</span>
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

      document
        .querySelector(`[data-index="${index}"]`)
        ?.classList.remove("active");

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
      let popupContent = `<strong>${this.#sanitizeHTML(
        props.title
      )}</strong><br>`;

      if (props.source_platform === "reddit") {
        popupContent += `
          <small>
              📱 <strong>Reddit</strong> • r/${
                props.reddit_subreddit || "unknown"
              }<br>
              👍 ${props.reddit_score || 0} upvotes | 💬 ${
          props.reddit_comments || 0
        } comments
          </small><br>
        `;
      } else if (props.source_platform === "mastodon") {
        popupContent += `
          <small>
              🐘 <strong>Mastodon</strong> • @${
                props.mastodon_author || "unknown"
              }<br>
              ⭐ ${props.mastodon_favourites || 0} favorites | 🔄 ${
          props.mastodon_reblogs || 0
        } reblogs
          </small><br>
        `;
      } else {
        popupContent += `
          <small>
              📰 <strong>${this.#sanitizeHTML(
                props.domain || "News Source"
              )}</strong><br>
              🌍 ${this.#sanitizeHTML(props.sourcecountry || "Unknown Country")}
          </small><br>
        `;
      }

      popupContent += `
        <a href="${props.url}"
           target="_blank"
           rel="noopener noreferrer"
           style="color:#0099ff;">
            Read More →
        </a>
      `;

      new mapboxgl.Popup()
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

    document.querySelector(`[data-index="${index}"]`)?.classList.add("active");
  }

  /**
   * Pause marquee scroll while marker is active
   */
  #pauseScroll() {
    if (!this.#scrollPaused) {
      const scrollElement = document.querySelector(".news-ticker-rail");
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
      const scrollElement = document.querySelector(".news-ticker-rail");
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
}

// Export for use in other modules
export { SOUTH_ASIA_COORDS };
