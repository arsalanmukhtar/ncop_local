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

  /**
   * @param {mapboxgl.Map} mapInstance
   * @param {MapControls} mapControlsInstance
   * @param {ProjectionPanel} projectionPanelInstance
   */
  constructor(mapInstance, mapControlsInstance, projectionPanelInstance) {
    this.#map = mapInstance;
    this.#mapControls = mapControlsInstance;
    this.projectionPanel = projectionPanelInstance;

    console.log("🌏 Initializing NavigationPanel for South Asia scope");

    this.render();
    this.addEventListeners();
    this.setupNewsIntegration();
    this.#initializeNewsModal();
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
    // Story modal shell (kept dumb; logic handled elsewhere)
    const storyModal = document.createElement("div");
    storyModal.id = "story-modal";
    storyModal.style.cssText = `
    position: absolute; right: 16px; bottom: 72px; z-index: 3;
    display: none; width: 380px; max-height: 70vh; overflow: auto;
    background: rgba(20,20,24,.96); border: 1px solid #2a2a2a; border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0,0,0,.35); color: #eaeaea; backdrop-filter: blur(6px);
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

    console.log("✅ News modal detected - integrating with navigation");

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

    console.log(
      `📍 Navigation panel ${isCollapsed ? "collapsed" : "expanded"}`
    );
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
    console.log("🧭 Bearing and tilt reset");
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
    console.log(`🏔️ 3D Terrain ${newTerrainState ? "enabled" : "disabled"}`);
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

    console.log("🎯 Located to Islamabad, Pakistan");
  }

  /**
   * Handle home extent - Zoom to South Asia region
   */
  #handleHomeExtent() {
    // Zoom to Pakistan center
    const pakistanCenter = SOUTH_ASIA_COORDS.regions.pakistan; // [lng, lat]
    console.log({ pakistanCenter, SOUTH_ASIA_COORDS });
    this.#map.flyTo({
      center: pakistanCenter,
      zoom: 5, // adjust as needed
      duration: 1500,
      essential: true,
    });

    console.log(
      "🏠 Zoomed to South Asia region (Pakistan, India, Iran, Afghanistan, Bangladesh, Nepal, Sri Lanka, Myanmar, Thailand, Vietnam, Cambodia, Laos, Malaysia, Singapore, Indonesia, Philippines)"
    );
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
      console.log("📰 News modal hidden");
    } else {
      newsModal.style.display = "flex";
      localNewsBtn?.classList.add("active-news");
      console.log("📰 News modal shown");
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

    console.log(`🗺️ Jumped to ${cityName}`);
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

    console.log(`🌏 Jumped to ${regionName}`);
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
    console.log("🗞️ Initializing News Modal for South Asia");

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

      console.log("📱 Switched to Social Media mode");
    });

    // Regular News Button Click
    regularBtn.addEventListener("click", () => {
      // if already active, don't refetch
      if (regularBtn.classList.contains("active")) return;

      this.#includeSocialMedia = false;
      this.#fetchNews(false); // 🔥 fetch regular news
      this.#updateNewsButtonStates(regularBtn, socialBtn);

      console.log("📰 Switched to Regular News mode");
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
      console.log(`📡 Fetching news (Social Media: ${includeSM})...`);

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
        console.log("ℹ️ No articles found");
        return;
      }

      console.log(
        `✅ Fetched ${geojson.features.length} articles for South Asia`
      );

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
        console.log("📊 Metadata:", {
          total_features: geojson.metadata.total_features,
          gdelt_articles: geojson.metadata.gdelt_articles,
          social_media_posts: geojson.metadata.social_media_posts,
          sources: geojson.metadata.sources,
          geographic_scope: geojson.metadata.geographic_scope,
        });
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
      console.log(`❌ Marker ${index} removed`);
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

    console.log(`✅ Marker ${index} created at [${coords[0]}, ${coords[1]}]`);
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
        console.log("⏸️ News scroll paused");
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
        console.log("▶️ News scroll resumed");
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
}

// Export for use in other modules
export { SOUTH_ASIA_COORDS };
