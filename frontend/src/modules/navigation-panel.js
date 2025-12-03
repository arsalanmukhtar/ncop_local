// NavigationPanel.js - SOUTH ASIA INTEGRATED VERSION
// Handles:
//  - bottom-right map navigation controls (zoom, bearing, 3D toggle, locate, home)
//  - South Asia coordinate jumps
//  - News modal UI (fetch, render, markers, scroll pause, clock)
// Single source of truth for navigation + news

import { MapControls } from "./map-controls.js";

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
  #map;
  #mapControls;

  // News-related state
  #newsSelected = {};
  #newsMarkers = {};
  #scrollPaused = false;
  #includeSocialMedia = false;
  #baseUrl = window.location.origin;
  // GEE Chatbot State
  #geeLayers = new Map(); // Store active layers
  #chatHistory = [];
  #temporalLayers = {};

  /**
   * @param {mapboxgl.Map} mapInstance
   * @param {MapControls} mapControlsInstance
   * @param {ProjectionPanel} projectionPanelInstance
   */
  constructor(mapInstance, mapControlsInstance, projectionPanelInstance) {
    this.#map = mapInstance;
    this.#mapControls = mapControlsInstance;
    this.projectionPanel = projectionPanelInstance;

    // console.log("🌏 Initializing NavigationPanel for South Asia scope");

    this.render();
    this.addEventListeners();
    this.setupNewsIntegration();
    this.#initializeNewsModal();
    this.#initializeGeeChatbot();
    this.#updateNewsClock();

    // keep the live clock running
    setInterval(() => this.#updateNewsClock(), 1000);

    // ⛔ DO NOT auto-fetch news here anymore.
    // ⛔ DO NOT auto-mark any button as active here.
    // Terrain state stays same:
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
              placeholder="Ask for data: 'Show snow cover in Swat Valley'"
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

    // In addEventListeners()
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

    // console.log("✅ News modal detected - integrating with navigation");

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

    // console.log(`📍 Navigation panel ${isCollapsed ? "collapsed" : "expanded"}`);
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
    // console.log("🧭 Bearing and tilt reset");
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
    // console.log(`🏔️ 3D Terrain ${newTerrainState ? "enabled" : "disabled"}`);
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

    // console.log("🎯 Located to Islamabad, Pakistan");
  }

  /**
   * Handle home extent - Zoom to South Asia region
   */
  #handleHomeExtent() {
    // Zoom to Pakistan center
    const pakistanCenter = SOUTH_ASIA_COORDS.regions.pakistan; // [lng, lat]
    // console.log({ pakistanCenter, SOUTH_ASIA_COORDS });
    this.#map.flyTo({
      center: pakistanCenter,
      zoom: 5, // adjust as needed
      duration: 1500,
      essential: true,
    });

    // console.log("🏠 Zoomed to South Asia region (Pakistan, India, Iran, Afghanistan, Bangladesh, Nepal, Sri Lanka, Myanmar, Thailand, Vietnam, Cambodia, Laos, Malaysia, Singapore, Indonesia, Philippines)");
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
      // console.log("📰 News modal hidden");
    } else {
      newsModal.style.display = "flex";
      localNewsBtn?.classList.add("active-news");
      // console.log("📰 News modal shown");
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

    // console.log(`🗺️ Jumped to ${cityName}`);
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

    // console.log(`🌏 Jumped to ${regionName}`);
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
   * - We NO LONGER fetch by default.
   * - We ONLY fetch on button click.
   * - We ONLY mark a button as active after it triggers a fetch.
   */
  #initializeNewsModal() {
    // console.log("🗞️ Initializing News Modal for South Asia");

    const socialBtn = document.getElementById("toggle-social-btn");
    const regularBtn = document.getElementById("fetch-regular-btn");

    if (!socialBtn || !regularBtn) {
      console.warn("⚠️ News modal buttons not found");
      return;
    }

    // Social Media Button Click
    socialBtn.addEventListener("click", () => {
      // if already active, don't refetch
      if (socialBtn.classList.contains("active")) return;

      this.#includeSocialMedia = true;
      this.#fetchNews(true); // 🔥 fetch social feed
      this.#updateNewsButtonStates(socialBtn, regularBtn);

      // console.log("📱 Switched to Social Media mode");
    });

    // Regular News Button Click
    regularBtn.addEventListener("click", () => {
      // if already active, don't refetch
      if (regularBtn.classList.contains("active")) return;

      this.#includeSocialMedia = false;
      this.#fetchNews(false); // 🔥 fetch regular news
      this.#updateNewsButtonStates(regularBtn, socialBtn);

      // console.log("📰 Switched to Regular News mode");
    });

    // ⛔ DO NOT set default active state here.
    // both start inactive, both enabled.
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
    try {
      // console.log(`📡 Fetching news (Social Media: ${includeSM})...`);

      // pick URL based on mode
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

      container.innerHTML = "";

      // No data case
      if (!geojson.features || geojson.features.length === 0) {
        container.innerHTML = `
          <div style="color: white; padding: 20px; text-align: center;">
              <p>🔍 No news data found for South Asia</p>
              <small>Try switching between Social Media and Regular News</small>
          </div>
        `;
        // console.log("ℹ️ No articles found");
        return;
      }

      // console.log(`✅ Fetched ${geojson.features.length} articles for South Asia`);

      // populate ticker with boxes
      geojson.features.forEach((feature, index) => {
        const props = feature.properties;
        const box = document.createElement("div");
        box.className = "news-box";

        const fullUrl = props.url || "#";
        const maxLength = 50;
        const shortUrl =
          fullUrl.length > maxLength
            ? fullUrl.substring(0, maxLength / 2) +
              "..." +
              fullUrl.slice(-maxLength / 2)
            : fullUrl;

        const sourceDisplay = this.#generateSourceDisplay(props);

        const displayDate = this.#formatGdeltDate(props.formatted_date);

        box.innerHTML = `
            ${sourceDisplay}
            <div style="margin-top: 6px;">
                <strong style="display:block; font-size:13px; line-height:1.4;">
                    ${this.#sanitizeHTML(props.title || "Untitled")}
                </strong>
                <small style="font-size:11px;">
                    <a href="${fullUrl}"
                    target="_blank"
                    rel="noopener noreferrer"
                    style="color:#cce6ff; text-decoration:underline;">
                        ${this.#sanitizeHTML(shortUrl)}
                    </a>
                </small>
                <div style="font-size:10px; color:#999; margin-top:4px;">
                    ${displayDate}
                </div>
            </div>
        `;

        box.dataset.index = index;
        box.addEventListener("click", () =>
          this.#toggleNewsMarker(index, feature)
        );
        container.appendChild(box);
      });

      // keep globally accessible (optional debug/use)
      window.gdeltNewsFeatures = geojson.features;

      // Log metadata if available
      if (geojson.metadata) {
        // console.log("📊 Metadata:", {
        //   total_features: geojson.metadata.total_features,
        //   gdelt_articles: geojson.metadata.gdelt_articles,
        //   social_media_posts: geojson.metadata.social_media_posts,
        //   sources: geojson.metadata.sources,
        //   geographic_scope: geojson.metadata.geographic_scope,
        // });
      }
    } catch (error) {
      console.error("❌ Error fetching news:", error);
      const container = document.getElementById("news-scroll");
      if (container) {
        container.innerHTML = `
          <div style="color:#ff6b6b; padding:20px;">
              <strong>Failed to load news</strong>
              <small style="display:block; margin-top:8px;">
                  ${this.#sanitizeHTML(error.message)}
              </small>
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

    // Reddit source
    if (props.source_platform === "reddit") {
      return `
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <span style="background: #ff4500; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">
                REDDIT
            </span>
            <span style="font-size: 11px; color: #ccc;">
                r/${this.#sanitizeHTML(props.reddit_subreddit || "unknown")}
            </span>
            <span style="font-size: 9px; color: #888;">
                👍 ${props.reddit_score || 0} | 💬 ${props.reddit_comments || 0}
            </span>
        </div>
      `;
    }

    // Mastodon source
    if (props.source_platform === "mastodon") {
      return `
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <span style="background: #6364ff; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">
                MASTODON
            </span>
            <span style="font-size: 11px; color: #ccc;">
                @${this.#sanitizeHTML(props.mastodon_author || "unknown")}
            </span>
            <span style="font-size: 9px; color: #888;">
                ⭐ ${props.mastodon_favourites || 0} | 🔄 ${
        props.mastodon_reblogs || 0
      }
            </span>
        </div>
      `;
    }

    // Traditional news (GDELT)
    const country = props.sourcecountry || "Unknown";
    const isoCode = COUNTRY_ISO_MAP[country] || "un";

    return `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <picture style="display: flex; align-items: center;">
              <source type="image/webp" srcset="${flagBase}16x12/${isoCode.toLowerCase()}.webp">
              <source type="image/png" srcset="${flagBase}16x12/${isoCode.toLowerCase()}.png">
              <img 
                  src="${flagBase}16x12/${isoCode.toLowerCase()}.png" 
                  width="16" 
                  height="12" 
                  alt="${country} flag"
                  onerror="this.style.display='none'"
              >
          </picture>
          <span style="background: #28a745; color: white; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: bold;">
              NEWS
          </span>
          <span style="font-size: 11px; color: #ccc;">
              ${this.#sanitizeHTML(country)}
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

      document
        .querySelector(`[data-index="${index}"]`)
        ?.classList.remove("active");

      this.#resumeScroll();
      // console.log(`❌ Marker ${index} removed`);
      return;
    }

    // Create new marker
    this.#pauseScroll();

    // Determine marker color based on source
    let markerColor = "#e63946"; // default red for GDELT
    if (props.source_platform === "reddit") {
      markerColor = "#ff4500"; // Reddit orange
    } else if (props.source_platform === "mastodon") {
      markerColor = "#6364ff"; // Mastodon bluish
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

    // console.log(`✅ Marker ${index} created at [${coords[0]}, ${coords[1]}]`);
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
        // console.log("⏸️ News scroll paused");
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
        // console.log("▶️ News scroll resumed");
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
   * Fallbacks to "Unknown date" if invalid.
   */
  #formatGdeltDate(raw) {
    if (!raw || typeof raw !== "string") return "Unknown date";

    // Expecting "YYYYMMDDTHHMMSSZ"
    // Example: "20251027T121500Z"
    const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) {
      return "Unknown date";
    }

    const [_, year, month, day, hour, minute, second] = match;

    // Build a real Date in UTC
    const dateObj = new Date(
      Date.UTC(
        parseInt(year, 10),
        parseInt(month, 10) - 1, // month is 0-based
        parseInt(day, 10),
        parseInt(hour, 10),
        parseInt(minute, 10),
        parseInt(second, 10)
      )
    );

    // Human-friendly pieces
    const dayNum = dateObj.getUTCDate(); // 1-31
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

    // ordinal suffix (1st, 2nd, 3rd, 4th...)
    const suffix = ((n) => {
      const rem10 = n % 10;
      const rem100 = n % 100;
      if (rem10 === 1 && rem100 !== 11) return "st";
      if (rem10 === 2 && rem100 !== 12) return "nd";
      if (rem10 === 3 && rem100 !== 13) return "rd";
      return "th";
    })(dayNum);

    // Style A: "27th Oct 2025"
    const pretty = `${dayNum}${suffix} ${monthLabel} ${yearNum}`;

    // Style B (if you prefer): "2025/10/27"
    // const pretty = `${year}/${month}/${day}`;

    return pretty;
  }

  // ============================================================
  // GEE CHATBOT IMPLEMENTATION
  // ============================================================

  #initializeGeeChatbot() {
    const sendBtn = document.getElementById("geeChatSend");
    const input = document.getElementById("geeChatInput");
    const closeBtn = document.getElementById("geeChatClose");

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

    // ⭐ Check for conversational queries BEFORE calling backend
    const semanticResponse = this.#handleSemanticQuery(message);
    if (semanticResponse) {
      this.#addChatMessage("assistant", semanticResponse);
      return; // Don't call backend for greetings/help
    }

    // Show loading for actual data queries
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
   * ⭐ Handle semantic/conversational queries without calling backend
   * Returns response text if matched, null otherwise
   */
  #handleSemanticQuery(message) {
    const msg = message.toLowerCase().trim();

    // Greetings
    const greetings = ["hi", "hello", "hey", "yo", "sup", "greetings"];
    if (greetings.some((g) => msg === g || msg.startsWith(g + " "))) {
      return "👋 Hey! I'm your Earth Engine assistant for Pakistan. I can show you satellite data like:\n\n• Snow cover in northern areas\n• Flood risk zones\n• Population density\n• Air quality\n• Temperature data\n• And much more!\n\nJust ask me to show you any environmental data.";
    }

    // Identity questions
    if (msg.includes("what are you") || msg.includes("who are you")) {
      return '🛰️ I\'m an AI assistant powered by **Google Earth Engine**. I help visualize satellite and geospatial data over Pakistan.\n\nI can access:\n• Real-time satellite imagery\n• Climate data (temperature, rainfall)\n• Hazard maps (floods, landslides, fires)\n• Environmental indices (NDVI, NDSI, NDWI)\n• Population & infrastructure data\n\nTry asking: "Show me snow in Hunza" or "Flood risk in Sindh"';
    }
    // Capabilities
    if (
      msg.includes("what can you do") ||
      msg.includes("help") ||
      msg === "?"
    ) {
      return '🎯 **I can help you with:**\n\n**🌊 Hazards:**\n• Flood extent & susceptibility\n• Landslide risk areas\n• Fire detection & burn scars\n• Drought severity\n• Earthquake zones\n\n**🌍 Environment & Climate:**\n• Snow & glacier monitoring\n• Vegetation health (NDVI)\n• Water bodies & hydrology\n• Air quality (AOD)\n• Land Surface Temperature\n• Urban Heat Island effects\n• Land Use Land Cover (LULC) ⭐ NEW\n• Evapotranspiration\n• Thermal comfort index\n\n**🌊 Climate Scenarios:**\n• Sea Level Rise 2050/2100\n• Coastal flooding risk\n\n**🏙️ Urban:**\n• Population density\n• Urban growth (NDBI)\n• Nighttime lights\n• Built-up areas\n\n**Example queries:**\n• "Show flood risk in Karachi"\n• "Urban heat island in Lahore"\n• "Land use cover in Islamabad" ⭐\n• "Sea level rise 2050 Gwadar"\n• "Glacier extent in Hunza"';
    }

    // Urban Heat Island - FIXED
    if (
      (msg.includes("tell me about") ||
        msg.includes("what is") ||
        msg.includes("explain")) &&
      (msg.includes("heat island") || msg.includes("uhii"))
    ) {
      return "🌡️ **Urban Heat Island Index (UHII)**\n\nI can show you temperature differences between urban and rural areas...";
    }
    if (
      (msg.includes("show") ||
        msg.includes("display") ||
        msg.includes("map")) &&
      (msg.includes("heat island") || msg.includes("uhii"))
    ) {
      return null; // Pass to backend
    }

    // Sea Level Rise queries - ONLY for explanatory questions
    if (
      (msg.includes("tell me about") ||
        msg.includes("what is") ||
        msg.includes("explain")) &&
      (msg.includes("sea level") || msg.includes("slr"))
    ) {
      return '🌊 **Sea Level Rise Scenarios**\n\nI can visualize projected coastal inundation for 2050 (1-3m) and 2100 (1-5m) scenarios.\n\nTry:\n• "Sea level rise 2050 in Karachi"\n• "Coastal flooding risk Gwadar"\n• "Show SLR scenario 2100"';
    }

    // ⚠️ IMPORTANT: Let "show", "display", "map" queries pass through to backend!
    if (
      (msg.includes("show") ||
        msg.includes("display") ||
        msg.includes("map")) &&
      (msg.includes("sea level") ||
        msg.includes("slr") ||
        msg.includes("coastal flood"))
    ) {
      return null; // ✅ Pass to backend for actual data
    }

    // Glacier queries - FIXED
    if (
      (msg.includes("tell me about") ||
        msg.includes("what is") ||
        msg.includes("explain")) &&
      (msg.includes("glacier") || msg.includes("ice cover"))
    ) {
      return "🏔️ **Glacier & Ice Monitoring**\n\nI can track glaciers and permanent ice...";
    }

    if (
      (msg.includes("show") ||
        msg.includes("display") ||
        msg.includes("map")) &&
      (msg.includes("glacier") || msg.includes("ice"))
    ) {
      return null; // Pass to backend
    }

    // Thermal comfort - FIXED
    if (
      (msg.includes("tell me about") ||
        msg.includes("what is") ||
        msg.includes("explain")) &&
      (msg.includes("thermal comfort") || msg.includes("heat stress"))
    ) {
      return "🌡️ **Thermal Comfort Index**\n\nI can assess human thermal comfort...";
    }

    if (
      (msg.includes("show") ||
        msg.includes("display") ||
        msg.includes("map")) &&
      (msg.includes("thermal comfort") || msg.includes("heat stress"))
    ) {
      return null; // Pass to backend
    }

    // Evapotranspiration - FIXED
    if (
      (msg.includes("tell me about") ||
        msg.includes("what is") ||
        msg.includes("explain")) &&
      (msg.includes("evapotranspiration") ||
        msg.includes("et") ||
        msg.includes("water loss"))
    ) {
      return "💧 **Evapotranspiration (ET)**\n\nI can show water loss from vegetation...";
    }

    if (
      (msg.includes("show") ||
        msg.includes("display") ||
        msg.includes("map")) &&
      (msg.includes("evapotranspiration") || msg.includes("et"))
    ) {
      return null; // Pass to backend
    }

    // Surface water - FIXED
    if (
      (msg.includes("tell me about") ||
        msg.includes("what is") ||
        msg.includes("explain")) &&
      (msg.includes("surface water") || msg.includes("water extent"))
    ) {
      return "💧 **Surface Water Monitoring**\n\nI can track current extent of rivers...";
    }

    if (
      (msg.includes("show") ||
        msg.includes("display") ||
        msg.includes("map")) &&
      (msg.includes("surface water") || msg.includes("water extent"))
    ) {
      return null; // Pass to backend
    }
    // LULC queries
    if (
      (msg.includes("tell me about") ||
        msg.includes("what is") ||
        msg.includes("explain")) &&
      (msg.includes("land use") ||
        msg.includes("land cover") ||
        msg.includes("lulc"))
    ) {
      return '🌳 **Land Use Land Cover (LULC)**\n\nI can show detailed land classification including forests, croplands, urban areas, water bodies, and more.\n\nTry:\n• "Show land use in Lahore"\n• "Land cover classification Sindh"\n• "LULC map Islamabad"';
    }

    if (
      (msg.includes("show") ||
        msg.includes("display") ||
        msg.includes("map")) &&
      (msg.includes("land use") ||
        msg.includes("land cover") ||
        msg.includes("lulc"))
    ) {
      return null; // Pass to backend
    }
    // Thanks
    if (msg.includes("thank") || msg.includes("thanks")) {
      return "😊 You're welcome! Let me know if you need any more satellite data or hazard information.";
    }

    // How are you / status
    if (
      msg.includes("how are you") ||
      msg.includes("whats up") ||
      msg.includes("what's up")
    ) {
      return "🛰️ I'm functioning perfectly! All satellite connections active and ready to pull data for Pakistan.\n\nWhat environmental data would you like to explore?";
    }

    // Coverage area
    if (
      msg.includes("where") &&
      (msg.includes("cover") || msg.includes("work"))
    ) {
      return "🗺️ I cover **all of Pakistan** including:\n\n📍 **55+ cities** from Karachi to Gilgit\n🏔️ **All provinces** (Punjab, Sindh, KPK, Balochistan, GB)\n🌊 **River basins** (Indus, Chenab, Jhelum, Ravi, Sutlej)\n\nJust specify any location in Pakistan and I'll get the data!";
    }

    // Data freshness
    if (
      msg.includes("how recent") ||
      msg.includes("latest") ||
      msg.includes("real-time")
    ) {
      return "⏱️ **Data freshness:**\n\n🔴 **Near real-time** (updates hourly/daily):\n• Active fires (VIIRS)\n• Flood extent (Sentinel-1 SAR)\n• Weather data (temperature, wind)\n\n🟡 **Weekly updates:**\n• Vegetation indices (NDVI)\n• Snow cover (NDSI)\n• Air quality\n\n🟢 **Static/Yearly:**\n• Population density\n• Elevation data\n• Infrastructure maps\n\nI always pull the latest available imagery!";
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

    // No match - let backend handle it
    return null;
  }

  #addChatMessage(role, content, isLoading = false) {
    const container = document.getElementById("geeChatMessages");
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
    const container = document.getElementById("geeChatMessages");

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

    // ⭐ CHECK FOR TEMPORAL DATA AVAILABILITY
    if (
      data.temporal &&
      data.temporal.available === true &&
      data.temporal.start_year &&
      data.temporal.end_year &&
      !data.temporal.enabled
    ) {
      this.#showTemporalDialog(responseDiv, data);
    }

    // Rest of existing code...
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
  /**
   * 📅 Show temporal dialog - Ask user if they want timeline visualization
   */
  #showTemporalDialog(responseDiv, data) {
    const timelineData = data.temporal;
    const layerId = data.layer_id;
    const datasetName = data.dataset;

    const { start_year: startYear, end_year: endYear } = timelineData || {
      start_year: null,
      end_year: null,
    };
    if (!startYear || !endYear) {
      console.warn("Dataset has no valid timeline metadata");
      return;
    }
    const defaultYears = this.#getDefaultYears(timelineData);
    const yearsText =
      defaultYears.length > 0
        ? defaultYears.join(", ")
        : `${startYear}–${endYear}`;

    const dialogContainer = document.createElement("div");
    dialogContainer.className = "gee-temporal-dialog";
    dialogContainer.innerHTML = `
      <div class="gee-temporal-dialog-content">
        <div class="gee-temporal-dialog-header">
          <i data-lucide="calendar-clock" style="width:16px;height:16px"></i>
          <span>Temporal View Available</span>
        </div>
        
        <div class="gee-temporal-dialog-body">
          <p>
            This dataset has historical data from 
            <strong>${startYear}</strong> to <strong>${endYear}</strong>.
          </p>
          <p style="margin-top: 6px;">
            Would you like to visualize <strong>changes over time</strong>?
          </p>
  
          <div class="gee-temporal-year-selection">
            <label for="temporal-years-${layerId}">
              Enter years separated by commas (e.g., ${yearsText}):
            </label>
            <input
              id="temporal-years-${layerId}"
              type="text"
              class="gee-temporal-years-input"
              placeholder="${yearsText}"
            />
            <small>Leave empty to use the latest 5 years by default.</small>
            <div class="gee-temporal-error" style="color:#f87171; margin-top:4px; display:none;"></div>
          </div>
        </div>
  
        <div class="gee-temporal-dialog-actions">
          <button class="gee-temporal-btn gee-temporal-btn-cancel">
            <i data-lucide="x" style="width:14px;height:14px"></i>
            <span>No, keep latest only</span>
          </button>
          <button class="gee-temporal-btn gee-temporal-btn-confirm">
            <i data-lucide="check" style="width:14px;height:14px"></i>
            <span>Yes, show timeline</span>
          </button>
        </div>
      </div>
    `;

    // ⭐ APPEND TO CHAT MESSAGE (responseDiv), NOT document.body
    responseDiv.appendChild(dialogContainer);

    // Refresh Lucide icons
    if (typeof lucide !== "undefined") {
      lucide.createIcons();
    }

    const input = dialogContainer.querySelector(`#temporal-years-${layerId}`);
    const errorBox = dialogContainer.querySelector(".gee-temporal-error");
    const cancelBtn = dialogContainer.querySelector(".gee-temporal-btn-cancel");
    const confirmBtn = dialogContainer.querySelector(
      ".gee-temporal-btn-confirm"
    );

    const closeDialog = () => {
      dialogContainer.remove();
    };

    cancelBtn.addEventListener("click", () => {
      closeDialog();
    });

    confirmBtn.addEventListener("click", () => {
      const raw = (input.value || "").trim();
      const { validYears, invalidYears } = this.#parseYears(
        raw,
        startYear,
        endYear
      );

      // Case 1: user entered something, but ALL of it is invalid
      if (raw && validYears.length === 0) {
        const suggested = this.#getDefaultYears(timelineData);
        errorBox.style.display = "block";
        errorBox.innerHTML = `
          The year(s) you entered are not available for this dataset.<br>
          Available range is <strong>${startYear}–${endYear}</strong>.<br>
          Try years closer to the latest data, for example: 
          <strong>${suggested.join(", ")}</strong>.
        `;
        // Pre-fill with suggested years so user can just confirm
        input.value = suggested.join(", ");
        return; // keep dialog open
      }

      // Case 2: some invalid, some valid → warn, but proceed with valid
      if (invalidYears.length > 0 && validYears.length > 0) {
        errorBox.style.display = "block";
        errorBox.innerHTML = `
          Ignoring unavailable year(s): <strong>${invalidYears.join(
            ", "
          )}</strong>.<br>
          Using only valid years within <strong>${startYear}–${endYear}</strong>.
        `;
        // Continue with validYears
      }

      // Case 3: user left it empty → default to last N years
      const yearsToUse =
        validYears.length > 0
          ? validYears
          : this.#getDefaultYears(timelineData);

      if (!yearsToUse || yearsToUse.length === 0) {
        // Failsafe: no years at all → just keep latest
        closeDialog();
        return;
      }

      // Build timeline UI & emit temporal events
      const timelineData_extended = {
        ...data,
        temporal: { ...data.temporal, years: yearsToUse },
      };
      this.#addTemporalTimeline(responseDiv, timelineData_extended, yearsToUse);

      // Mark temporal as enabled locally so we don't re-prompt
      window.dispatchEvent(
        new CustomEvent("gee-temporal-enabled", {
          detail: {
            layerId,
            datasetKey: timelineData.dataset_key || null,
            years: yearsToUse,
          },
        })
      );

      closeDialog();
    });
  }

  /**
   * Get default last N years
   */
  #getDefaultYears(timelineData) {
    const { start_year: startYear, end_year: endYear } = timelineData || {
      start_year: null,
      end_year: null,
    };
    if (!startYear || !endYear) return [];

    // Take up to the last 5 years in the dataset range, i.e. closest to "now"
    const defaultYears = [];
    for (let y = endYear; y >= startYear && defaultYears.length < 5; y--) {
      defaultYears.unshift(y);
    }

    return defaultYears;
  }

  /**
   * Parse and validate years from user input
   */
  #parseYears(inputValue, startYear, endYear) {
    // No input → let caller decide default
    if (!inputValue) {
      return {
        validYears: [],
        invalidYears: [],
      };
    }

    const rawYears = inputValue
      .split(",")
      .map((y) => parseInt(y.trim(), 10))
      .filter((y) => !isNaN(y));

    const validYears = [];
    const invalidYears = [];

    for (const y of rawYears) {
      if (y >= startYear && y <= endYear) {
        validYears.push(y);
      } else {
        invalidYears.push(y);
      }
    }

    const uniqueValid = Array.from(new Set(validYears)).sort((a, b) => a - b);

    return {
      validYears: uniqueValid,
      invalidYears,
    };
  }
  /**
   * ⏱️ TEMPORAL TIMELINE - Year-based slider with play/pause
   */
  #addTemporalTimeline(responseDiv, data, years) {
    if (!years || years.length === 0) {
      console.error("No valid years provided");
      return;
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
      
      <div class="gee-temporal-timeline-slider">
        <input type="range" 
               class="gee-temporal-year-slider" 
               id="temporal-year-slider-${data.layer_id}"
               min="0" 
               max="${years.length - 1}" 
               value="${years.length - 1}"
               step="1"
               data-years='${JSON.stringify(years)}'
               data-layer-id="${data.layer_id}"
               data-dataset-key="${data.temporal.dataset_key}"
               data-location="${data.temporal.location_name}"
               data-bbox='${JSON.stringify(data.temporal.bbox || null)}'>
        
        <div class="gee-temporal-year-labels">
          <span class="gee-temporal-year-label">${years[0]}</span>
          <span class="gee-temporal-year-label">${
            years[Math.floor(years.length / 2)]
          }</span>
          <span class="gee-temporal-year-label">${
            years[years.length - 1]
          }</span>
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
        <button class="gee-temporal-control-btn" id="temporal-play-${
          data.layer_id
        }" title="Play animation">
          <i data-lucide="play"></i>
        </button>
        <button class="gee-temporal-control-btn" id="temporal-pause-${
          data.layer_id
        }" style="display:none;" title="Pause animation">
          <i data-lucide="pause"></i>
        </button>
        <button class="gee-temporal-control-btn" id="temporal-stop-${
          data.layer_id
        }" title="Stop & reset">
          <i data-lucide="square"></i>
        </button>
        <button class="gee-temporal-control-btn gee-temporal-control-btn-remove" id="temporal-remove-${
          data.layer_id
        }" title="Remove timeline">
          <i data-lucide="x"></i>
        </button>
        
        <div class="gee-temporal-speed-control">
          <label>Speed:</label>
          <select id="temporal-speed-${
            data.layer_id
          }" class="gee-temporal-speed-select">
            <option value="2000">Slow</option>
            <option value="1000" selected>Normal</option>
            <option value="500">Fast</option>
          </select>
        </div>
      </div>
      
      <div class="gee-temporal-info">
        <small>📊 Showing ${years.length} years: ${years.join(", ")}</small>
      </div>
    `;

    // ⭐ Simply append to responseDiv (already the correct container)
    responseDiv.appendChild(timelineContainer);
    console.log(`✅ Timeline appended to chatbot for layer: ${data.layer_id}`);

    // Attach event listeners
    this.#attachTimelineListeners(data.layer_id, data, years);

    // Load initial year
    console.log(`⏸️ Timeline ready. Drag slider to load years manually.`);

    // Refresh icons
    if (typeof lucide !== "undefined") {
      lucide.createIcons();
    }
  }
  /**
   * Attach event listeners to timeline controls
   */
  #attachTimelineListeners(layerId, data, years) {
    const slider = document.getElementById(`temporal-year-slider-${layerId}`);
    const playBtn = document.getElementById(`temporal-play-${layerId}`);
    const pauseBtn = document.getElementById(`temporal-pause-${layerId}`);
    const stopBtn = document.getElementById(`temporal-stop-${layerId}`);
    const removeBtn = document.getElementById(`temporal-remove-${layerId}`);
    const speedSelect = document.getElementById(`temporal-speed-${layerId}`);
    const currentYearDisplay = document.getElementById(
      `temporal-current-year-${layerId}`
    );

    let isPlaying = false;
    let playInterval = null;
    // ===== SLIDER CHANGE EVENT WITH DEBOUNCING =====
    let sliderDebounceTimeout;
    slider?.addEventListener("input", (e) => {
      const yearIndex = parseInt(e.target.value);
      const year = years[yearIndex];

      // Update display immediately
      currentYearDisplay.textContent = year;

      // Update active marker immediately
      this.#updateActiveMarker(layerId, yearIndex, years.length);

      // Debounce the actual layer loading to prevent rate limiting
      clearTimeout(sliderDebounceTimeout);
      sliderDebounceTimeout = setTimeout(() => {
        console.log(`🎯 User selected year ${year} - loading layer...`);

        // Clear previous temporal layers before loading new one
        if (this.#temporalLayers && this.#temporalLayers[layerId]) {
          this.#temporalLayers[layerId].forEach((tempLayerId) => {
            if (this.#map.getLayer(tempLayerId)) {
              this.#map.removeLayer(tempLayerId);
            }
            if (this.#map.getSource(tempLayerId)) {
              this.#map.removeSource(tempLayerId);
            }
          });
          this.#temporalLayers[layerId] = [];
        }

        // Load layer for this year
        this.#loadTemporalLayer(data, year, yearIndex);
      }, 500); // Wait 500ms after user stops dragging
    });

    // ===== PLAY BUTTON =====
    playBtn?.addEventListener("click", () => {
      isPlaying = true;
      playBtn.style.display = "none";
      pauseBtn.style.display = "flex";

      let currentIndex = parseInt(slider.value);
      const speed = parseInt(speedSelect.value);

      playInterval = setInterval(() => {
        if (currentIndex >= years.length - 1) {
          currentIndex = 0; // Loop back to start
        } else {
          currentIndex++;
        }

        slider.value = currentIndex;
        slider.dispatchEvent(new Event("input"));
      }, speed);
    });

    // ===== PAUSE BUTTON =====
    pauseBtn?.addEventListener("click", () => {
      isPlaying = false;
      playBtn.style.display = "flex";
      pauseBtn.style.display = "none";

      if (playInterval) {
        clearInterval(playInterval);
        playInterval = null;
      }
    });

    // ===== STOP BUTTON =====
    stopBtn?.addEventListener("click", () => {
      isPlaying = false;
      playBtn.style.display = "flex";
      pauseBtn.style.display = "none";

      if (playInterval) {
        clearInterval(playInterval);
        playInterval = null;
      }

      // Reset to last year
      slider.value = years.length - 1;
      slider.dispatchEvent(new Event("input"));
    });

    // ===== REMOVE BUTTON =====
    // ===== REMOVE BUTTON =====
    removeBtn?.addEventListener("click", () => {
      // Stop animation if playing
      if (playInterval) {
        clearInterval(playInterval);
      }

      // Remove ALL temporal layers for this dataset
      if (this.#temporalLayers && this.#temporalLayers[layerId]) {
        this.#temporalLayers[layerId].forEach((tempLayerId) => {
          if (this.#map.getLayer(tempLayerId)) {
            this.#map.removeLayer(tempLayerId);
          }
          if (this.#map.getSource(tempLayerId)) {
            this.#map.removeSource(tempLayerId);
          }
          console.log(`🗑️ Removed temporal layer: ${tempLayerId}`);
        });
        delete this.#temporalLayers[layerId];
      }

      // Remove base layer
      if (this.#map && this.#map.getLayer && this.#map.getLayer(layerId)) {
        this.#map.removeLayer(layerId);
        if (this.#map.getSource(layerId)) {
          this.#map.removeSource(layerId);
        }
      }

      // Remove timeline UI
      const timeline = document.getElementById(`temporal-timeline-${layerId}`);
      if (timeline) {
        timeline.remove();
      }

      console.log(`🗑️ Removed temporal timeline and all layers: ${layerId}`);
    });

    // ===== SPEED CHANGE =====
    speedSelect?.addEventListener("change", () => {
      if (isPlaying) {
        // Restart with new speed
        pauseBtn.click();
        setTimeout(() => playBtn.click(), 100);
      }
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
      if (idx === activeIndex) {
        marker.classList.add("active");
      } else if (idx < activeIndex) {
        marker.classList.add("past");
        marker.classList.remove("active");
      } else {
        marker.classList.remove("active", "past");
      }
    });
  }

  /**
   * Load temporal layer for specific year
   */
  async #loadTemporalLayer(data, year, yearIndex) {
    console.log(
      `📅 Loading ${data.dataset} for year ${year} (index ${yearIndex})`
    );

    try {
      // Call backend to get tile URL for this specific year
      const response = await fetch("/api/gee/temporal-layer/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset_key: data.temporal.dataset_key,
          location: data.temporal.location_name,
          bbox: data.temporal.bbox,
          years: [year],
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      if (result.success && result.layers && result.layers.length > 0) {
        const layerData = result.layers[0];

        if (layerData.available && layerData.tile_url) {
          const temporalLayerId = `${data.layer_id}-year-${year}`;

          // Remove old temporal layer if exists
          if (this.#map.getLayer(temporalLayerId)) {
            this.#map.removeLayer(temporalLayerId);
          }
          if (this.#map.getSource(temporalLayerId)) {
            this.#map.removeSource(temporalLayerId);
          }

          // Add new temporal layer
          this.#map.addSource(temporalLayerId, {
            type: "raster",
            tiles: [layerData.tile_url],
            tileSize: 256,
          });

          this.#map.addLayer({
            id: temporalLayerId,
            type: "raster",
            source: temporalLayerId,
            paint: { "raster-opacity": 0.8 },
          });

          // Store layer ID for cleanup
          if (!this.#temporalLayers) this.#temporalLayers = {};
          if (!this.#temporalLayers[data.layer_id]) {
            this.#temporalLayers[data.layer_id] = [];
          }
          this.#temporalLayers[data.layer_id].push(temporalLayerId);

          console.log(`✅ Added temporal layer: ${temporalLayerId}`);
        } else {
          console.warn(`⚠️ No data for year ${year}`);
        }
      }
    } catch (error) {
      console.error(`❌ Failed to load year ${year}:`, error);
    }
  }
  #addTemporalSlider(responseDiv, data) {
    if (!data.temporal || !data.temporal.enabled) return;

    const sliderContainer = document.createElement("div");
    sliderContainer.className = "gee-temporal-slider";
    sliderContainer.innerHTML = `
      <div class="gee-temporal-header">
        <span class="gee-temporal-title">⏱️ Timeline</span>
        <span class="gee-temporal-date" id="temporal-date-${data.layer_id}">
          ${data.temporal.start_date}
        </span>
      </div>
      
      <div class="gee-temporal-controls">
        <input type="range" 
               class="gee-temporal-range" 
               id="temporal-slider-${data.layer_id}"
               min="0" 
               max="100" 
               value="0"
               data-layer-id="${data.layer_id}"
               data-start="${data.temporal.start_date}"
               data-end="${data.temporal.end_date}">
      </div>
      
      <div class="gee-temporal-buttons">
        <button class="gee-temporal-btn" id="temporal-play-${data.layer_id}">
          <i data-lucide="play"></i>
          <span>Play</span>
        </button>
        <button class="gee-temporal-btn" id="temporal-pause-${data.layer_id}" style="display:none;">
          <i data-lucide="pause"></i>
          <span>Pause</span>
        </button>
        <button class="gee-temporal-btn" id="temporal-remove-${data.layer_id}">
          <i data-lucide="x"></i>
          <span>Remove</span>
        </button>
      </div>
    `;

    responseDiv.appendChild(sliderContainer);

    // Attach event listeners
    this.#attachTemporalListeners(data.layer_id, data);

    lucide.createIcons();
  }

  #attachTemporalListeners(layerId, data) {
    const slider = document.getElementById(`temporal-slider-${layerId}`);
    const playBtn = document.getElementById(`temporal-play-${layerId}`);
    const pauseBtn = document.getElementById(`temporal-pause-${layerId}`);
    const removeBtn = document.getElementById(`temporal-remove-${layerId}`);
    const dateDisplay = document.getElementById(`temporal-date-${layerId}`);

    let isPlaying = false;
    let playInterval = null;

    // Slider change
    slider?.addEventListener("input", (e) => {
      const value = parseInt(e.target.value);
      const startDate = new Date(data.temporal.start_date);
      const endDate = new Date(data.temporal.end_date);
      const totalDays = (endDate - startDate) / (1000 * 60 * 60 * 24);
      const currentDays = (totalDays * value) / 100;
      const currentDate = new Date(
        startDate.getTime() + currentDays * 24 * 60 * 60 * 1000
      );

      dateDisplay.textContent = currentDate.toISOString().split("T")[0];

      // Update layer with new date
      this.#updateTemporalLayer(
        layerId,
        currentDate.toISOString().split("T")[0]
      );
    });

    // Play button
    playBtn?.addEventListener("click", () => {
      isPlaying = true;
      playBtn.style.display = "none";
      pauseBtn.style.display = "flex";

      playInterval = setInterval(() => {
        const currentValue = parseInt(slider.value);
        if (currentValue >= 100) {
          slider.value = 0;
        } else {
          slider.value = currentValue + 1;
        }
        slider.dispatchEvent(new Event("input"));
      }, 500); // 500ms per frame
    });

    // Pause button
    pauseBtn?.addEventListener("click", () => {
      isPlaying = false;
      playBtn.style.display = "flex";
      pauseBtn.style.display = "none";
      clearInterval(playInterval);
    });

    // Remove button
    removeBtn?.addEventListener("click", () => {
      if (playInterval) clearInterval(playInterval);

      // Remove layer from map
      if (this.#map.getLayer(layerId)) {
        this.#map.removeLayer(layerId);
        this.#map.removeSource(layerId);
      }

      // Remove UI
      const container = document
        .querySelector(`#temporal-slider-${layerId}`)
        .closest(".gee-temporal-slider");
      container?.remove();

      // Update layer info
      const layerInfo = this.#geeLayers.get(layerId);
      if (layerInfo) {
        layerInfo.added = false;
      }
    });
  }

  #updateTemporalLayer(layerId, date) {
    // This would re-fetch the layer for the new date
    // For now, just update visual feedback
    console.log(`Updating layer ${layerId} to date ${date}`);

    // In a full implementation, you'd:
    // 1. Call backend with new date
    // 2. Get new tile URL
    // 3. Update map source
  }

  #toggleGeeLayer(layerId, shouldAdd) {
    const layerInfo = this.#geeLayers.get(layerId);
    if (!layerInfo) return;

    if (shouldAdd) {
      // Add layer to map
      if (!this.#map.getSource(layerId)) {
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

        layerInfo.added = true;
        console.log(`✅ Added layer: ${layerId}`);
      }
    } else {
      // Remove layer from map
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
   * Download layer metadata and tile info as JSON
   */
  #downloadLayerInfo(layerId) {
    const layerInfo = this.#geeLayers.get(layerId);
    if (!layerInfo) {
      console.error(`❌ Layer ${layerId} not found`);
      return;
    }

    // Prepare comprehensive metadata
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

    // Convert to formatted JSON
    const jsonStr = JSON.stringify(metadata, null, 2);

    // Create blob and download
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    // Generate filename
    const timestamp = new Date().toISOString().split("T")[0];
    const safeName = layerInfo.dataset
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();
    const filename = `gee_${safeName}_${layerInfo.location}_${timestamp}.json`;

    // Trigger download
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();

    // Cleanup
    URL.revokeObjectURL(url);

    console.log(`✅ Downloaded layer info: ${filename}`);

    // Show confirmation in chat
    this.#addChatMessage(
      "assistant",
      `📥 Downloaded **${layerInfo.dataset}** metadata as **${filename}**\n\nYou can use the tile URL in GIS software like QGIS or ArcGIS Pro.`
    );
  }
}

// Export for use in other modules
export { SOUTH_ASIA_COORDS };
