// UserControl.js

/**
 * Handles the top-right user control button and panel visibility.
 */
export class UserControl {
    constructor() {
        this.render();
        this.addEventListeners();
    }

    /**
     * Renders the custom user button HTML.
     */
    render() {
        const mapContainer = document.getElementById("map");
        const userContainer = document.createElement("div");
        userContainer.className = "custom-user-control";
        userContainer.innerHTML = `
            <button id="userToggle" class="custom-user-btn" title="User Info">
                <i data-lucide="user"></i>
            </button>
        `;
        mapContainer.appendChild(userContainer);
        lucide.createIcons();
    }

    /**
     * Adds event listeners for the user button and outside clicks.
     */
    addEventListeners() {
        const userToggle = document.getElementById("userToggle");
        const userPanel = document.getElementById("userPanel");

        if (userToggle && userPanel) {
            userToggle.addEventListener("click", function () {
                userPanel.classList.toggle("user-panel-visible");
            });

            document.addEventListener("click", function (event) {
                if (
                    !userPanel.contains(event.target) &&
                    !userToggle.contains(event.target)
                ) {
                    userPanel.classList.remove("user-panel-visible");
                }
            });
        }
    }
}

// ===========================================================================
// NCOP guided tour (previously: ncop-tour-control.js)
// ===========================================================================

const TOUR_CONFIG = {
  animationDuration: 260,
  highlightPadding: 8,
  arrowSize: 12,
  tooltipOffset: 18,
  zIndex: 10000,
};

// ---------------------------------------------------------------------------
// TOUR_STEPS
// ---------------------------------------------------------------------------
// Full end-to-end walkthrough — orientation → layer catalogue → every rail
// control → the new analysis features (Split Compare, Weather Report,
// dynamic legends).  Each step is a plain data object:
//
//   target          CSS selector to highlight (or omit + use targetResolver)
//   title           Header shown in the tooltip
//   content         Body text; write as if you are demoing to a new user
//   position        "top" | "bottom" | "left" | "right" — tooltip placement
//   action          Optional prep action executed BEFORE showing the step
//                   (opens sidebar, expands accordion, opens rail panel, …)
//   actionValue     Argument to the action (accordion title, item label, …)
//   targetResolver  For dynamic targets that don't have a static selector
//                   (e.g. accordion header by its title text)
//   targetValue     Argument to the resolver
//
// New actions added below (see NCOPTour.executeAction):
//   openWeatherReportPanel · openLayerStylePanel · activateSplitCompare
// ---------------------------------------------------------------------------
const TOUR_STEPS = [
  // ===============================================================
  //  ORIENTATION
  // ===============================================================
  {
    target: "#ncop-home-top-bar, .ncop-home-top-bar",
    title: "Welcome to NCOP",
    content:
      "This is your NDMA National Common Operating Picture — an operational workspace combining GIS layers, weather forecasts, flood monitoring, air quality, satellite imagery, and side-by-side comparison tools in a single map interface. This tour will walk you through every category, every control, and every advanced feature.",
    position: "bottom",
  },
  {
    target: "#miniglobe-wrapper",
    title: "Overview Mini-Globe",
    content:
      "The mini-globe in the corner keeps you oriented globally. It mirrors the main map's centre and zoom so you always know where you are on Earth while working locally.",
    position: "left",
  },

  // ===============================================================
  //  SIDEBAR — layer catalogue
  // ===============================================================
  {
    target: "#menuToggle, .custom-menu-control",
    title: "Menu Button — open the Layer Catalogue",
    content:
      "This hamburger button on the top-left opens the sidebar layer catalogue. All operational data layers — boundaries, weather forecasts, flood extents, air-quality products — are organized inside it. The button stays visible even in Split-Compare mode so you can add layers to Map A without leaving the split view.",
    position: "right",
  },
  {
    target: "#sidebarPanel.sidebar-panel",
    title: "Sidebar Panel — the Layer Catalogue",
    content:
      "The sidebar groups every layer into four top-level accordions: GIS Layers, Weather Systems, Flood Monitoring, and Air Quality. Each accordion has multiple subcategories, and each subcategory contains either toggleable vector layers or clickable temporal (time-aware) layers.",
    position: "right",
    action: "openSidebar",
  },
  {
    target: "#sidebarSearch, .sidebar-search-container",
    title: "Search Box",
    content:
      "Type any layer name here to filter the whole catalogue instantly — useful when you know the layer you want but don't remember which category it lives in.",
    position: "right",
    action: "openSidebar",
  },

  // ===============================================================
  //  GIS LAYERS accordion — boundaries, infra, hydrology, geology, seismology
  // ===============================================================
  {
    title: "1 · GIS Layers",
    content:
      "The first accordion holds all foundational geographic reference layers — administrative boundaries, critical infrastructure, hydrological network, geological formations, and seismic hazard maps. These are the base context you overlay everything else onto.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "GIS Layers",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "GIS Layers",
  },
  {
    title: "Administrative Boundaries",
    content:
      "National, Provincial, District, and Tehsil boundary polygons for Pakistan. Toggle any combination to build the administrative context you need for a specific incident or analysis.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Administrative Boundaries",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Administrative Boundaries",
  },
  {
    title: "Infrastructure",
    content:
      "Point layers for Airports, Schools, and Settlements. Turn them on to see critical facilities that may need evacuation planning, protection, or resource dispatch during an emergency.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Infrastructure",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Infrastructure",
  },
  {
    title: "Hydrological Layers",
    content:
      "Rivers, reservoirs, dams, watershed catchments, AND — new in this release — 20 pre-computed flood-extent polygons for the six major river basins (Upper/Lower Indus, Jhelum, Chenab, Ravi, Sutlej, Kabul), each split into High / Medium / Low severity. All served directly from GeoServer as vector tiles.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Hydrological Layers",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Hydrological Layers",
  },
  {
    title: "Geology",
    content:
      "Two layers new to this release: Geological Formations (40-formation lithology with an RdYlBu colour ramp) and PGA Zones (Peak Ground Acceleration hazard zones for structural risk assessment).",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Geology",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Geology",
  },
  {
    title: "Seismology",
    content:
      "Three layers new to this release: Fault Lines, Seismic Source Zones, and the national Seismic Hazard Map. Together they give you the tectonic context behind any recent quake or forecast risk assessment.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Seismology",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Seismology",
  },

  // ===============================================================
  //  WEATHER SYSTEMS accordion — the big one
  // ===============================================================
  {
    title: "2 · Weather Systems",
    content:
      "The Weather Systems accordion holds all satellite imagery, radar mosaics, numerical weather predictions, and live PMD observations. Every item here is time-aware — click one and the temporal slider (bottom of the map) lights up with playable forecast frames.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Weather Systems",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Weather Systems",
  },
  {
    title: "Radar Layers",
    content:
      "Real-time radar & satellite imagery: DWD Satellite Infrared (Meteosat IR, refreshed every 15 min) and IMERG Precipitation Rate (14 days of NASA-derived precipitation).",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Radar Layers",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Radar Layers",
  },
  {
    title: "Global Deterministic Prediction System (GDPS)",
    content:
      "Canada's Meteorological Service GDPS provides a full suite of forecast products: humidity, precipitation type, snow density/depth, snowfall, thunderstorm probability, fog probability, and convective precipitation — each on a rolling 7-day forecast window.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Global Deterministic Prediction System (GDPS)",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Global Deterministic Prediction System (GDPS)",
  },
  {
    title: "Temporal Layer — live demo",
    content:
      "As an example, we're activating 'Specific Humidity (2m Above Ground)'. Watch the map: the raster fades in and the temporal slider at the bottom populates with date labels, a play button, a legend, and per-step animation.",
    position: "right",
    action: "activateTemporalItem",
    actionValue: "Specific Humidity (2m Above Ground)",
    targetResolver: "temporalItemByLabel",
    targetValue: "Specific Humidity (2m Above Ground)",
  },
  {
    target: "#temp-slider1",
    title: "Temporal Slider",
    content:
      "This is the animation controller for the active temporal layer. Left group: the play/pause circle and the 1× speed pill (cycle through 0.5×/1×/2×/4×). Middle: the timeline with clickable date labels and the drag-handle. Right: the drag icon lets you move the whole panel. Bottom row: the trash icon removes the active layer, the layer name is shown next to it, then the colour-ramp legend explaining the values, and finally an opacity droplet on the far right.",
    position: "bottom",
  },
  {
    title: "ECMWF Weather Forecast Parameters",
    content:
      "European Centre for Medium-Range Weather Forecasts products: 850 hPa Temperature, Lightning Forecast, and Tropical Cyclone Strike Probability — the go-to global model outputs for severe weather planning.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "ECMWF Weather Forecast Parameters",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "ECMWF Weather Forecast Parameters",
  },
  {
    title: "Meteoblue Forecast",
    content:
      "Meteoblue's NEMS-based products: Weekly & Hourly Precipitation (with a snow emoji when frozen precipitation is expected), Hourly & Weekly Snowfall, CAPE (Convective Available Potential Energy) hourly & weekly, Storm Helicity (0-3 km), Precipitation Radar, and 2-m Air Temperature.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Meteoblue Forecast",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Meteoblue Forecast",
  },
  {
    title: "Live Meteorological Operations",
    content:
      "Live PMD station observations and hazard products: NWFC Weather Observations (HTML-marker icons with weather-condition GIFs), PMD Weather Warnings (with a new 13-hazard-type checkbox filter you'll find above the toggle), and heatwave/cold-wave watch feeds. Every layer here now has a dynamic legend rendered in the Layer Info panel.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Live Meteorological Operations",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Live Meteorological Operations",
  },
  {
    title: "PMD Forecast — new",
    content:
      "The newest subcategory under Weather Systems: nine forecast rasters fetched (authenticated) from PMD Monitor's own /predictions API, colorized server-side via GDAL into PNG frames the temporal slider plays as animated overlays. Precipitation windows in four accumulations (3h / 6h / 12h / 24h) from the Pakistan-tuned WRFPRS model, plus 2m Temperature (WRFPRS), Total Cloud Cover (GDFS — vendor's WRFPRS/TCC feed is currently empty), Relative Humidity (GDFS), and 24h Extreme High / Low Temperature (GDFS/TMAX2M + TMIN2M). Every layer gets its own colour ramp, unit-aware legend, and a live 'current timestep' line inside the slider's variable panel that updates as you scrub. GDFS-backed layers are clipped server-side to a South-Asia bbox so a global-grid raster doesn't balloon Mapbox's GPU texture pool.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "PMD Forecast",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "PMD Forecast",
  },

  // ===============================================================
  //  FLOOD MONITORING accordion
  // ===============================================================
  {
    title: "3 · Flood Monitoring",
    content:
      "The Flood Monitoring accordion combines PMD glacier-related products, FFD's flood forecasting products, and the global GloFAS ensemble — the operational stack for hydrological hazard tracking.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Flood Monitoring",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Flood Monitoring",
  },
  {
    title: "PMD Glaciers & GLOF",
    content:
      "Pakistan Meteorological Department glacier and Glacial Lake Outburst Flood (GLOF) products: Glacier Lake Inventory, GLOF Observations, and glacier-related monitoring layers — each with dynamic legends explaining what the colours and swatches mean.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "PMD Glaciers & GLOF",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "PMD Glaciers & GLOF",
  },
  {
    title: "Flood Forecasting Division (FFD-Data)",
    content:
      "FFD's operational feeds: river gauge readings, flood-alert bulletins, and situation reports. Great context to overlay on the Hydrological Layers flood-extent polygons for an integrated picture.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Flood Forecasting Division (FFD-Data)",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Flood Forecasting Division (FFD-Data)",
  },
  {
    title: "Global Flood Awareness System (GloFAS)",
    content:
      "The Copernicus/ECMWF GloFAS ensemble river-discharge forecast — global 25 km resolution, 30-day outlook, with return-period exceedance overlays for early warning.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Global Flood Awareness System (GloFAS)",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Global Flood Awareness System (GloFAS)",
  },

  // ===============================================================
  //  AIR QUALITY accordion
  // ===============================================================
  {
    title: "4 · Air Quality",
    content:
      "The Air Quality accordion covers real-time station observations, atmospheric composition products, and forecast overlays — WAQI stations, CAMS AQI, particulate matter, gases (NO₂, O₃, SO₂, CO, CH₄), aerosols, and desert-dust products.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Air Quality",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Air Quality",
  },
  {
    title: "Real Time Air Quality Parameters",
    content:
      "Live WAQI-Stations Air Quality (station-level AQI), CAMS AQI hourly & daily forecasts, plus per-pollutant products: PM2.5, PM10, NO₂, O₃, SO₂, CO, dust, methane, sulphate/biomass/sea-salt aerosols, CO₂ at surface & 850 hPa, formaldehyde, and UV Index.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Real Time Air Quality Parameters",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Real Time Air Quality Parameters",
  },

  // ===============================================================
  //  AGRICULTURE MONITORING accordion — new
  // ===============================================================
  {
    title: "5 · Agriculture Monitoring — new",
    content:
      "The Agriculture Monitoring accordion (wheat icon) is a new top-level category that combines humanitarian food-security indicators with Pakistan's official crop-production statistics. Two subcategories today — Food Security (IPC/CH) and Crop Production (PBS) — with room for livestock, irrigation, pest, and market-price layers in future releases.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Agriculture Monitoring",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Agriculture Monitoring",
  },
  {
    title: "Food Security — IPC / CH",
    content:
      "Three country layers driven by IPC Info's official Acute Food Insecurity classification: Pakistan, Afghanistan, and Bangladesh. Each polygon renders in the official 5-phase colour ramp (Minimal → Catastrophe). The layers are fetched through a Django proxy that resolves the LATEST published analysis cycle server-side, so you always see the most recent classification without hard-coded cycle IDs. Click any polygon for a tabular popup and the Open Food Security Panel button, which launches a draggable + resizable IPC Stats Modal with 4 tabs including a Historical Trend chart from the PTT scrape.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Food Security",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Food Security",
  },
  {
    title: "Crop Production — 121 crops · 44 fiscal years",
    content:
      "Two toggleable choropleths — Provincial and District — driven by the Pakistan Bureau of Statistics (PBS) Crop Reporting Service, joined server-side to na.data.gov.pk's polygon file. The 'Filter by crop type' card injected above the toggles is a single-select radio list of all 121 crops with a live search box: pick any crop (Wheat is the default) and BOTH active layers redraw in lock-step with per-crop stops so the colour ramp always spans the crop's real production magnitude. Click any province/district polygon for the full Area / Production / Yield tile and the Open Crop Explorer button, which launches the standalone 6-tab Crop Explorer modal (Time Series · Province Map · Province Table · District Map · District Table · About) pre-selected on the current crop.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Crop Production",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Crop Production",
  },

  // ===============================================================
  //  UNIFIED RIGHT RAIL — every button, in stack order
  // ===============================================================
  {
    target: ".map-right-rail",
    title: "The Unified Right Rail",
    content:
      "Every action button lives here, in a single vertical stack. Buttons are organised top-to-bottom by workflow: chevron collapse → user & search → layer tools → analysis panels → map tools → view tools → utilities → zoom controls. We'll walk through each one now.",
    position: "left",
  },
  {
    target: "#navToggleBtn",
    title: "Rail Collapse",
    content:
      "The top chevron collapses the entire rail — every other icon slides away, leaving only this toggle so you get a maximally clean map view. Click again to expand.",
    position: "left",
  },
  {
    target: "#userToggle",
    title: "User Panel",
    content:
      "Opens the user account panel with your profile, session info, and account-related settings — kept separate from the map so it never clutters the workspace.",
    position: "left",
  },
  {
    target: "#geocoderToggle, .mapboxgl-ctrl-geocoder",
    title: "Location Search",
    content:
      "Type a place, coordinates, or landmark to fly the map straight to it. Uses Mapbox's global geocoder — Islamabad, 34.1,73.2, and 'Khunjerab Pass' all work.",
    position: "left",
    action: "openGeocoderPanel",
  },
  {
    target: "#layerOrderToggle",
    title: "Layer Order",
    content:
      "Opens the Layer Order panel: every active layer in a draggable list. Drag rows up or down to change which layer draws on top — critical when combining overlays.",
    position: "left",
    action: "openLayerOrderPanel",
  },
  {
    target: "#layerStyleToggle",
    title: "Layer Style — Palette",
    content:
      "Opens the Layer Style panel where you can restyle any active vector layer — change fill colour, opacity, stroke width, and label visibility on-the-fly. Great for quickly recolouring boundaries or making a flood extent stand out.",
    position: "left",
    action: "openLayerStylePanel",
  },
  {
    target: "#layerInfoToggle",
    title: "Layer Info",
    content:
      "Opens the Layer Info panel — descriptions, metadata, and DYNAMIC LEGENDS for every active layer. Newer layers now render swatch/gradient/icon legends automatically so you can read the map without going back to the catalogue.",
    position: "left",
    action: "openLayerInfoPanel",
  },
  {
    target: "#weatherReportToggle",
    title: "Weather Report — new",
    content:
      "Opens the Weather Report panel: a slide-out card that fetches the PMD/GCOP live weather brief for the map's current centre point. Move the map and the report updates.",
    position: "left",
    action: "openWeatherReportPanel",
  },
  {
    target: "#splitCompareToggle",
    title: "Split Compare View — new",
    content:
      "Toggles the Split Compare View — the flagship new feature. The map splits vertically into Map A (left) and Map B (right), with a draggable divider, synchronised camera, two independent temporal sliders, and a bottom picker to load any temporal layer onto Map B while Map A keeps whatever you had. Perfect for A/B comparing forecasts.",
    position: "left",
  },
  {
    target: "#basemapToggle",
    title: "Basemap",
    content:
      "Opens the basemap picker: switch between streets, hybrid, OSM, outdoors, satellite, day, and night styles. There's also a labels toggle inside so you can hide place names if the map is getting busy.",
    position: "left",
    action: "openBasemapPanel",
  },
  {
    target: "#basemapPanel.visible .labels-toggle",
    title: "Basemap — Labels Toggle",
    content:
      "This switch inside the basemap panel turns place labels on or off — useful when you're presenting and want the map to speak for itself, or when heavy raster overlays make labels illegible.",
    position: "left",
    action: "openBasemapPanel",
  },
  {
    target: "#ncopTourToggle",
    title: "NCOP Guided Tour",
    content:
      "This graduation-cap icon is what you just clicked to start this tour. Click it any time to restart the walkthrough — it will guide you through every element again, useful for training new operators.",
    position: "left",
  },
  {
    target: "#toggle3D",
    title: "3D Toggle",
    content:
      "Switches between standard 2D flat view and a tilted 3D view with terrain relief. Great for visualising mountain flooding, glacial catchments, and topographic hazard exposure.",
    position: "left",
  },
  {
    target: "#projectionSwitch",
    title: "Projection Switch",
    content:
      "Cycles between Mercator (default flat), Globe (spherical), and other Mapbox projections. Globe mode gives you Google Earth-style rotation for a briefing look.",
    position: "left",
  },
  {
    target: "#windParticles",
    title: "Wind Particle Animation",
    content:
      "Toggles GPU-accelerated wind-particle streamlines using the current wind forecast — animated arrows sweeping across the country show flow, speed, and eddies at a glance.",
    position: "left",
  },
  {
    target: "#oceanParticles",
    title: "Ocean Currents Animation",
    content:
      "Toggles animated ocean-current particles for the Arabian Sea and coastal waters — pairs well with the Ocean Surface Currents / Temperature / Salinity temporal layers.",
    position: "left",
  },
  {
    target: "#geoglowsForecast",
    title: "GeoGLOWS Forecast",
    content:
      "Toggles GeoGLOWS river-discharge forecast mode — click any river reach on the map to see its 15-day discharge hydrograph and ensemble spread in a chart popup.",
    position: "left",
  },
  {
    target: "#locate",
    title: "Locate to Islamabad",
    content:
      "Snaps the map to Islamabad — a fast way to return to the operational headquarters view without hunting for the extent.",
    position: "left",
  },
  {
    target: "#localNews",
    title: "Local News Panel",
    content:
      "Opens a scrolling panel of operationally-relevant news headlines — a background awareness ticker that runs alongside your map work.",
    position: "left",
  },
  {
    target: "#geeChat",
    title: "GEE Chatbot",
    content:
      "Opens the Google Earth Engine chatbot — ask natural-language questions about GEE datasets and get guided suggestions for what to query.",
    position: "left",
  },
  {
    target: "#ncopAssistantToggle",
    title: "NCOP Assistant — AI Q&A",
    content:
      "That friendly animated bot is the NCOP Assistant — ask it anything about NCOP: what a layer shows, how a feature works, or where to find something. It's grounded in NCOP's own documentation and live data (current rainfall totals, heatwave alerts), can jump you straight to a layer, category, or control, and can describe what's actually on your map right now — active layers, the current temporal step, all of it. Pick between AI models in its header, and turn on narration to have replies read aloud. You'll also spot a second, larger version of this same bot floating near the bottom-right of the map — either one opens the same assistant.",
    position: "left",
  },
  {
    target: "#homeExtent",
    title: "Home Extent — South Asia",
    content:
      "Zooms the map to the default South-Asia regional extent. Use it as a reset when you've drilled deep into a district and want the big picture back.",
    position: "left",
  },
  {
    target: "#storyBtn",
    title: "Story Panel",
    content:
      "Opens the story-mode panel where map-based narratives (guided walkthroughs of past events, briefings, training scenarios) can be played back turn-by-turn.",
    position: "left",
  },
  {
    target: "#zoomIn",
    title: "Zoom In",
    content:
      "Steps the zoom level up by one — pinch/scroll works too, but this button gives a predictable increment.",
    position: "left",
  },
  {
    target: "#zoomOut",
    title: "Zoom Out",
    content:
      "Steps the zoom level down by one to recover wider regional context.",
    position: "left",
  },
  {
    target: "#resetBearing",
    title: "Reset Bearing & Tilt",
    content:
      "Snaps the map back to north-up, zero-tilt — useful after rotating or tilting the view for a presentation angle.",
    position: "left",
  },

  // ===============================================================
  //  MISCELLANEOUS + WRAP-UP
  // ===============================================================
  {
    target: ".mapboxgl-ctrl-scale",
    title: "Scale Bar",
    content:
      "The scale bar in the bottom-left updates live with your zoom level — an at-a-glance distance reference for anything you're measuring.",
    position: "top",
  },
  {
    target: ".ncop-container.fixed.top-3.left-3.z-50, #themeToggleBtn",
    title: "Theme Toggle",
    content:
      "Switches between day and night themes for the whole interface. Night mode is designed for dark operations rooms and reduces eye strain during long shifts.",
    position: "bottom",
  },
  {
    target: "#ncopTourToggle",
    title: "That's the full tour",
    content:
      "You now know every category, every rail button, and every new feature — including Split Compare View, Weather Report, dynamic legends, PMD Warnings hazard filter, NWFC HTML weather markers, the Geology + Seismology + expanded Hydrological Layers, the Agriculture Monitoring accordion (IPC/CH Food Security + PBS Crop Production choropleths with 121-crop filter and the 6-tab Crop Explorer modal), the PMD Forecast subcategory with nine authenticated WRFPRS/GDFS forecast rasters (precipitation, temperature, cloud cover, humidity, and 24h extreme highs/lows), each with its own colour ramp, unit-aware legend, and live current-timestep display in the slider, and the NCOP Assistant — the animated bot that can answer questions, navigate you anywhere, and describe what's live on your map. Click this graduation-cap icon any time to restart the tour.",
    position: "left",
  },
];

function ensureTourStyles() {
  if (document.getElementById("ncop-tour-control-styles")) return;

  const style = document.createElement("style");
  style.id = "ncop-tour-control-styles";
  style.textContent = `
    .custom-tour-control {
      position: relative;
    }

    .custom-tour-btn {
      width: 32px;
      height: 36px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .custom-tour-btn.active {
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
      color: #fff;
    }

    /* -----------------------------------------------------------------
       Blinking outline — theme-independent + prominent.
       Uses the highest-specificity selectors we can practically apply so
       we beat the .map-right-rail > .rail-btn baseline in _controls.css
       (which sets border: 1px solid var(--rail-border) !important)
       and both day/night theme rules.
       Colours are hard-coded (not CSS-var) so the pulse looks identical
       in day and night themes. The will-change hint promotes the button
       to its own layer so the box-shadow pulse stays smooth.
       ----------------------------------------------------------------- */
    .map-right-rail > .custom-tour-btn:not(.active),
    .custom-tour-btn:not(.active) {
      animation: ncopTourBlink 1.4s ease-in-out infinite !important;
      will-change: box-shadow, border-color, transform;
      position: relative;
      z-index: 5;
    }

    .map-right-rail > .custom-tour-btn:not(.active) svg,
    .custom-tour-btn:not(.active) svg {
      animation: ncopTourIconBlink 1.4s ease-in-out infinite !important;
    }

    /* Green pulse — emerald-500 (#22c55e / rgb(34, 197, 94)) picked
       because it reads as "start here / go" in every theme and stays
       high-contrast against both light and dark rails.  Hard-coded RGB
       so no CSS variable can dim it. */
    @keyframes ncopTourBlink {
      0%,
      100% {
        border-color: rgba(34, 197, 94, 0.60) !important;
        box-shadow:
          0 0 0 0 rgba(34, 197, 94, 0.55),
          0 0 6px rgba(34, 197, 94, 0.40),
          inset 0 0 4px rgba(34, 197, 94, 0.22) !important;
        transform: scale(1);
      }
      50% {
        border-color: rgba(34, 197, 94, 1) !important;
        box-shadow:
          0 0 0 4px rgba(34, 197, 94, 0.32),
          0 0 20px rgba(34, 197, 94, 0.85),
          inset 0 0 10px rgba(34, 197, 94, 0.45) !important;
        transform: scale(1.06);
      }
    }

    @keyframes ncopTourIconBlink {
      0%,
      100% {
        color: #22c55e !important;
        stroke: #22c55e !important;
        filter: drop-shadow(0 0 2px rgba(34, 197, 94, 0.40));
      }
      50% {
        color: #ffffff !important;
        stroke: #ffffff !important;
        filter: drop-shadow(0 0 6px rgba(34, 197, 94, 0.90));
      }
    }

    /* -----------------------------------------------------------------
       First-load floating tooltip — appears 500 ms after the button is
       rendered, points to it from the left, auto-dismisses after 10 s
       or on any click.  Positioned absolutely relative to the button's
       viewport rect via inline styles set by the JS.
       ----------------------------------------------------------------- */
    .ncop-tour-floating-hint {
      position: fixed;
      z-index: 10005;
      max-width: 260px;
      padding: 12px 14px 12px 14px;
      color: #f8fafc;
      /* Green gradient so the tooltip visually reads as an extension of
         the pulsing button it points to (both use emerald-500 rgb). */
      background:
        linear-gradient(135deg, rgba(22, 163, 74, 0.98), rgba(34, 197, 94, 0.98));
      border: 1px solid rgba(255, 255, 255, 0.30);
      border-radius: 12px;
      box-shadow:
        0 12px 32px rgba(2, 6, 23, 0.55),
        0 0 24px rgba(34, 197, 94, 0.55);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12.5px;
      font-weight: 500;
      line-height: 1.5;
      letter-spacing: 0.1px;
      opacity: 0;
      transform: translateX(8px) scale(0.95);
      transition:
        opacity 0.28s ease,
        transform 0.28s ease;
      pointer-events: auto;
      cursor: pointer;
    }

    .ncop-tour-floating-hint.visible {
      opacity: 1;
      transform: translateX(0) scale(1);
    }

    .ncop-tour-floating-hint__title {
      display: block;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.92);
      margin-bottom: 4px;
    }

    .ncop-tour-floating-hint__close {
      position: absolute;
      top: 6px;
      right: 8px;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 50%;
      background: rgba(0, 0, 0, 0.20);
      color: #fff;
      font-size: 12px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .ncop-tour-floating-hint__close:hover {
      background: rgba(0, 0, 0, 0.40);
    }

    /* Arrow pointing from the tooltip's right edge to the button — CSS
       triangle via a rotated square with the same gradient background. */
    .ncop-tour-floating-hint::after {
      content: "";
      position: absolute;
      top: 50%;
      right: -6px;
      width: 12px;
      height: 12px;
      background: rgba(34, 197, 94, 0.98);
      transform: translateY(-50%) rotate(45deg);
      border-right: 1px solid rgba(255, 255, 255, 0.30);
      border-top: 1px solid rgba(255, 255, 255, 0.30);
      border-top-right-radius: 2px;
    }

    .ncop-tour-panel {
      position: absolute;
      top: 0;
      right: calc(100% + 12px);
      width: 280px;
      display: none;
      color: #e2e8f0;
      border-radius: 16px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background:
        linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(17, 24, 39, 0.97)),
        radial-gradient(circle at top left, rgba(14, 165, 233, 0.2), transparent 36%);
      box-shadow: 0 20px 44px rgba(2, 6, 23, 0.34);
      backdrop-filter: blur(12px);
      overflow: hidden;
    }

    .ncop-tour-panel.visible {
      display: block;
    }

    .ncop-tour-panel-inner {
      padding: 14px;
    }

    .ncop-tour-panel-title {
      font-size: 16px;
      font-weight: 800;
      color: #f8fafc;
      margin-bottom: 4px;
    }

    .ncop-tour-panel-subtitle {
      font-size: 12px;
      line-height: 1.45;
      color: #cbd5e1;
      margin-bottom: 12px;
    }

    .ncop-tour-panel-actions {
      display: flex;
      gap: 8px;
    }

    .ncop-tour-start,
    .ncop-tour-close-panel {
      flex: 1 1 0;
      border: none;
      border-radius: 10px;
      padding: 10px 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      transition: transform 0.18s ease, filter 0.18s ease;
    }

    .ncop-tour-start {
      color: #fff;
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
    }

    .ncop-tour-close-panel {
      color: #e2e8f0;
      background: rgba(30, 41, 59, 0.88);
      border: 1px solid rgba(148, 163, 184, 0.18);
    }

    .ncop-tour-start:hover,
    .ncop-tour-close-panel:hover,
    .gcop-tour-btn:hover,
    .gcop-tour-close:hover {
      transform: translateY(-1px);
      filter: brightness(1.04);
    }

    .gcop-tour-overlay {
      position: fixed;
      inset: 0;
      z-index: ${TOUR_CONFIG.zIndex};
      pointer-events: none;
      opacity: 0;
      transition: opacity ${TOUR_CONFIG.animationDuration}ms ease;
      background: radial-gradient(circle at center, rgba(15, 23, 42, 0.04), rgba(15, 23, 42, 0.16));
    }

    .gcop-tour-overlay.active {
      opacity: 1;
    }

    .gcop-tour-highlight {
      position: fixed;
      border-radius: 16px;
      border: 2px solid rgba(56, 189, 248, 0.95);
      box-shadow:
        0 0 0 9999px rgba(2, 6, 23, 0.14),
        0 0 0 8px rgba(56, 189, 248, 0.14),
        0 10px 30px rgba(14, 165, 233, 0.22);
      transition:
        top ${TOUR_CONFIG.animationDuration}ms ease,
        left ${TOUR_CONFIG.animationDuration}ms ease,
        width ${TOUR_CONFIG.animationDuration}ms ease,
        height ${TOUR_CONFIG.animationDuration}ms ease,
        opacity ${TOUR_CONFIG.animationDuration}ms ease;
      opacity: 0;
    }

    .gcop-tour-highlight.active {
      opacity: 1;
    }

    .gcop-tour-tooltip {
      position: fixed;
      width: 320px;
      max-width: calc(100vw - 20px);
      z-index: ${TOUR_CONFIG.zIndex + 1};
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      transition:
        opacity ${TOUR_CONFIG.animationDuration}ms ease,
        transform ${TOUR_CONFIG.animationDuration}ms ease,
        top ${TOUR_CONFIG.animationDuration}ms ease,
        left ${TOUR_CONFIG.animationDuration}ms ease;
      color: #e2e8f0;
      border-radius: 18px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background:
        linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(17, 24, 39, 0.98)),
        radial-gradient(circle at top left, rgba(14, 165, 233, 0.18), transparent 38%);
      box-shadow: 0 24px 60px rgba(2, 6, 23, 0.42);
      overflow: hidden;
    }

    .gcop-tour-tooltip.active {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .gcop-tour-tooltip-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
      padding: 16px 16px 12px;
    }

    .gcop-tour-tooltip-header h3 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      color: #f8fafc;
    }

    .gcop-tour-close {
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 999px;
      background: rgba(30, 41, 59, 0.9);
      color: #e2e8f0;
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      flex: 0 0 auto;
    }

    .gcop-tour-tooltip-content {
      padding: 0 16px 14px;
      font-size: 13px;
      line-height: 1.6;
      color: #cbd5e1;
    }

    .gcop-tour-tooltip-content p {
      margin: 0;
    }

    .gcop-tour-tooltip-footer {
      padding: 0 16px 16px;
    }

    .gcop-tour-progress {
      margin-bottom: 12px;
      font-size: 11px;
      font-weight: 700;
      color: #94a3b8;
    }

    .gcop-tour-progress-bar {
      width: 100%;
      height: 6px;
      margin-top: 6px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(51, 65, 85, 0.9);
    }

    .gcop-tour-progress-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #38bdf8, #2563eb);
      transition: width ${TOUR_CONFIG.animationDuration}ms ease;
    }

    .gcop-tour-buttons {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .gcop-tour-btn {
      border: none;
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
    }

    .gcop-tour-btn.gcop-tour-prev {
      color: #e2e8f0;
      background: rgba(30, 41, 59, 0.92);
      border: 1px solid rgba(148, 163, 184, 0.18);
    }

    .gcop-tour-arrow {
      position: fixed;
      width: 0;
      height: 0;
      z-index: ${TOUR_CONFIG.zIndex + 1};
      opacity: 0;
      transition:
        opacity ${TOUR_CONFIG.animationDuration}ms ease,
        top ${TOUR_CONFIG.animationDuration}ms ease,
        left ${TOUR_CONFIG.animationDuration}ms ease,
        transform ${TOUR_CONFIG.animationDuration}ms ease;
      border-left: ${TOUR_CONFIG.arrowSize}px solid transparent;
      border-right: ${TOUR_CONFIG.arrowSize}px solid transparent;
      border-bottom: ${TOUR_CONFIG.arrowSize * 1.5}px solid #38bdf8;
      filter: drop-shadow(0 6px 10px rgba(14, 165, 233, 0.3));
      pointer-events: none;
    }

    @media (max-width: 768px) {
      .ncop-tour-panel {
        right: auto;
        left: 0;
        top: calc(100% + 10px);
        width: min(280px, calc(100vw - 24px));
      }

      .gcop-tour-tooltip {
        width: min(320px, calc(100vw - 20px));
      }
    }
  `;
  document.head.appendChild(style);
}

function resolveTarget(selector) {
  if (!selector) return null;
  return document.querySelector(selector);
}

function getSidebarPanel() {
  return document.getElementById("sidebarPanel");
}

function getSidebarMenuControl() {
  return document.querySelector(".custom-menu-control");
}

function openSidebarPanel() {
  const sidebar = getSidebarPanel();
  sidebar?.classList.add("visible", "open");
  getSidebarMenuControl()?.classList.add("hidden");
}

function closeSidebarPanel() {
  const sidebar = getSidebarPanel();
  sidebar?.classList.remove("visible", "open");
  getSidebarMenuControl()?.classList.remove("hidden");
}

function openUserPanel() {
  document.getElementById("userPanel")?.classList.add("user-panel-visible");
}

function closeUserPanel() {
  document.getElementById("userPanel")?.classList.remove("user-panel-visible");
}

function closeBasemapPanel() {
  document.getElementById("basemapPanel")?.classList.remove("visible");
}

function closeLayerOrderPanel() {
  document.getElementById("layerOrderPanel")?.classList.remove("visible");
}

function closeLayerInfoPanel() {
  document.getElementById("layerInfoPanel")?.classList.remove("visible");
}

// New rail-panel helpers added for the expanded tour — each mirrors the
// existing pattern: check if the panel is already visible, otherwise
// click its rail toggle to open it.  Closers are called from
// cleanupStepContext when the tour moves off the corresponding step.
function closeWeatherReportPanel() {
  document.querySelector(".weather-report-panel")?.classList.remove("visible");
}

function closeLayerStylePanel() {
  document.getElementById("layerStylePanel")?.classList.remove("visible");
}

// Geocoder needs both the panel AND the button's active class flipped —
// the button owns its own "active-geocoder" flag that the app uses to
// style the rail button + drive the "click-outside to close" behaviour
// (see geocoder-control.js).  Toggle by clicking to keep both in sync.
function closeGeocoderPanel() {
  const panel = document.getElementById("geocoderPanel");
  if (panel?.classList.contains("visible")) {
    document.getElementById("geocoderToggle")?.click();
  }
}

function getAccordionHeaderByTitle(title) {
  const headers = Array.from(document.querySelectorAll(".accordion-header"));
  return (
    headers.find((header) => {
      const text = header.querySelector(".accordion-title")?.textContent?.trim();
      return text === title;
    }) || null
  );
}

function getSubcategoryHeaderByTitle(title) {
  const headers = Array.from(document.querySelectorAll(".ncop-subcategory-header"));
  return (
    headers.find((header) => {
      const text = header.querySelector("span")?.textContent?.trim();
      return text === title;
    }) || null
  );
}

function expandSubcategoryHeader(title) {
  const header = getSubcategoryHeaderByTitle(title);
  if (!header) return null;

  const itemsContainer = header.nextElementSibling;
  const isExpanded = header.classList.contains("expanded");
  const parentContent = header.closest(".accordion-content");

  parentContent?.querySelectorAll(".ncop-subcategory-header").forEach((other) => {
    if (other !== header) {
      other.classList.remove("expanded");
      other.nextElementSibling?.classList.remove("visible");
    }
  });

  if (!isExpanded) {
    header.click();
  } else {
    header.classList.add("expanded");
    itemsContainer?.classList.add("visible");
  }

  return header;
}

function getTemporalItemByLabel(label) {
  const items = Array.from(document.querySelectorAll(".ncop-item.ncop-item-temporal"));
  return (
    items.find((item) => {
      const text = item.querySelector(".ncop-item-label")?.textContent?.trim();
      return text === label;
    }) || null
  );
}

function toggleTemporalItem(label, shouldActivate) {
  const item = getTemporalItemByLabel(label);
  const image = item?.querySelector(".ncop-item-image");
  if (!item || !image) return null;

  const isSelected = image.classList.contains("selected");
  if ((shouldActivate && !isSelected) || (!shouldActivate && isSelected)) {
    image.click();
  }

  return item;
}

function expandAccordionHeader(title) {
  openSidebarPanel();
  const header = getAccordionHeaderByTitle(title);
  if (!header) return null;

  const content = header.nextElementSibling;
  const isActive = header.classList.contains("active");

  document.querySelectorAll(".accordion-header").forEach((otherHeader) => {
    if (otherHeader !== header) {
      otherHeader.classList.remove("active");
      otherHeader.nextElementSibling?.classList.remove("expanded");
    }
  });

  if (!isActive) {
    header.click();
  } else {
    header.classList.add("active");
    content?.classList.add("expanded");
  }

  return header;
}

function resolveStepTarget(step) {
  if (step.targetResolver === "accordionHeaderByTitle") {
    return getAccordionHeaderByTitle(step.targetValue);
  }
  if (step.targetResolver === "subcategoryHeaderByTitle") {
    return getSubcategoryHeaderByTitle(step.targetValue);
  }
  if (step.targetResolver === "temporalItemByLabel") {
    return getTemporalItemByLabel(step.targetValue);
  }
  return resolveTarget(step.target);
}

class NCOPTour {
  constructor({ onStateChange } = {}) {
    this.currentStep = 0;
    this.isActive = false;
    this.completed = false;
    this.onStateChange = onStateChange;
    this.elements = {
      overlay: null,
      tooltip: null,
      arrow: null,
      highlight: null,
    };

    this.nextStep = this.nextStep.bind(this);
    this.prevStep = this.prevStep.bind(this);
    this.endTour = this.endTour.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleKeyPress = this.handleKeyPress.bind(this);
  }

  start() {
    if (this.isActive) return;
    this.isActive = true;
    this.currentStep = 0;
    this.completed = false;
    this.createTourElements();
    this.attachEventListeners();
    this.onStateChange?.(true);
    this.showStep(0);
  }

  createTourElements() {
    this.elements.overlay = document.createElement("div");
    this.elements.overlay.className = "gcop-tour-overlay";
    document.body.appendChild(this.elements.overlay);

    this.elements.highlight = document.createElement("div");
    this.elements.highlight.className = "gcop-tour-highlight";
    this.elements.overlay.appendChild(this.elements.highlight);

    this.elements.tooltip = document.createElement("div");
    this.elements.tooltip.className = "gcop-tour-tooltip";
    document.body.appendChild(this.elements.tooltip);

    this.elements.arrow = document.createElement("div");
    this.elements.arrow.className = "gcop-tour-arrow";
    document.body.appendChild(this.elements.arrow);

    requestAnimationFrame(() => {
      this.elements.overlay?.classList.add("active");
    });
  }

  async showStep(stepIndex) {
    if (stepIndex < 0 || stepIndex >= TOUR_STEPS.length) {
      this.endTour();
      return;
    }

    const previousStep = TOUR_STEPS[this.currentStep];
    this.cleanupStepContext(previousStep, TOUR_STEPS[stepIndex]);
    this.currentStep = stepIndex;
    const step = TOUR_STEPS[stepIndex];

    if (step.action) {
      await this.executeAction(step.action);
    }

    const targetEl = resolveStepTarget(step);
    if (!targetEl) {
      this.nextStep();
      return;
    }

    this.updateTooltip(step, targetEl);
    this.updateHighlight(targetEl);
    this.updateArrow(targetEl, step.position);
  }

  async executeAction(action) {
    switch (action) {
      case "openSidebar": {
        openSidebarPanel();
        await this.waitForUISettle(240);
        break;
      }
      case "openSidebarAccordion": {
        const step = TOUR_STEPS[this.currentStep];
        expandAccordionHeader(step.actionValue);
        await this.waitForUISettle(260);
        break;
      }
      case "openSidebarSubcategory": {
        const step = TOUR_STEPS[this.currentStep];
        expandSubcategoryHeader(step.actionValue);
        await this.waitForUISettle(240);
        break;
      }
      case "activateTemporalItem": {
        const step = TOUR_STEPS[this.currentStep];
        toggleTemporalItem(step.actionValue, true);
        await this.waitForUISettle(320);
        break;
      }
      case "openBasemapPanel": {
        const panel = document.getElementById("basemapPanel");
        if (panel && !panel.classList.contains("visible")) {
          document.getElementById("basemapToggle")?.click();
        }
        await this.waitForUISettle(180);
        break;
      }
      case "openUserPanel": {
        openUserPanel();
        await this.waitForUISettle(340);
        break;
      }
      case "openLayerOrderPanel": {
        const panel = document.getElementById("layerOrderPanel");
        if (panel && !panel.classList.contains("visible")) {
          document.getElementById("layerOrderToggle")?.click();
        }
        await this.waitForUISettle(180);
        break;
      }
      case "openLayerInfoPanel": {
        const panel = document.getElementById("layerInfoPanel");
        if (panel && !panel.classList.contains("visible")) {
          document.getElementById("layerInfoToggle")?.click();
        }
        await this.waitForUISettle(180);
        break;
      }
      case "openWeatherReportPanel": {
        const panel = document.querySelector(".weather-report-panel");
        if (!panel || !panel.classList.contains("visible")) {
          document.getElementById("weatherReportToggle")?.click();
        }
        await this.waitForUISettle(220);
        break;
      }
      case "openLayerStylePanel": {
        const panel = document.getElementById("layerStylePanel");
        if (panel && !panel.classList.contains("visible")) {
          document.getElementById("layerStyleToggle")?.click();
        }
        await this.waitForUISettle(180);
        break;
      }
      case "openGeocoderPanel": {
        const panel = document.getElementById("geocoderPanel");
        if (!panel || !panel.classList.contains("visible")) {
          document.getElementById("geocoderToggle")?.click();
        }
        await this.waitForUISettle(220);
        break;
      }
      default:
        break;
    }
  }

  waitForUISettle(delay = 180) {
    return new Promise((resolve) => {
      window.setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(resolve);
        });
      }, delay);
    });
  }

  cleanupStepContext(previousStep, nextStep) {
    const sidebarActions = new Set([
      "openSidebar",
      "openSidebarAccordion",
      "openSidebarSubcategory",
      "activateTemporalItem",
    ]);

    // "Sidebar section" = any step that logically belongs to the sidebar/
    // temporal-slider walkthrough.  The temporal-slider step itself uses no
    // `action` (it just highlights #temp-slider1), so if we relied only on
    // `sidebarActions.has(action)` the sidebar would close between the
    // "activateTemporalItem" step and the "#temp-slider1" step — and again
    // when moving from #temp-slider1 to the next category step (ECMWF,
    // Meteoblue, Live Meteorological Operations, …).  We want the sidebar
    // to stay open through ALL of that.  It should close only when we
    // truly leave the catalogue and head into the right-rail section.
    const isSidebarSectionStep = (step) => {
      if (!step) return false;
      if (step.target === "#temp-slider1") return true;
      if (step.action && sidebarActions.has(step.action)) return true;
      return false;
    };

    if (
      isSidebarSectionStep(previousStep) &&
      !isSidebarSectionStep(nextStep)
    ) {
      closeSidebarPanel();
    }

    if (
      previousStep?.action === "openUserPanel" &&
      nextStep?.action !== "openUserPanel"
    ) {
      closeUserPanel();
    }

    if (
      previousStep?.action === "openBasemapPanel" &&
      nextStep?.action !== "openBasemapPanel"
    ) {
      closeBasemapPanel();
    }

    if (
      previousStep?.action === "openLayerOrderPanel" &&
      nextStep?.action !== "openLayerOrderPanel"
    ) {
      closeLayerOrderPanel();
    }

    if (
      previousStep?.action === "openLayerInfoPanel" &&
      nextStep?.action !== "openLayerInfoPanel"
    ) {
      closeLayerInfoPanel();
    }

    if (
      previousStep?.action === "openWeatherReportPanel" &&
      nextStep?.action !== "openWeatherReportPanel"
    ) {
      closeWeatherReportPanel();
    }

    if (
      previousStep?.action === "openLayerStylePanel" &&
      nextStep?.action !== "openLayerStylePanel"
    ) {
      closeLayerStylePanel();
    }

    if (
      previousStep?.action === "openGeocoderPanel" &&
      nextStep?.action !== "openGeocoderPanel"
    ) {
      closeGeocoderPanel();
    }

    // The demo temporal layer (Specific Humidity 2m) should stay loaded on
    // the map for as long as we're still inside the sidebar section — that
    // way when the user is reading the ECMWF / Meteoblue / Live Met Ops
    // category cards, they can still see the slider + legend + animation
    // context that step 15 introduced.  Only tear it down once we leave
    // the sidebar section entirely.
    if (
      (previousStep?.action === "activateTemporalItem" ||
        previousStep?.target === "#temp-slider1") &&
      !isSidebarSectionStep(nextStep)
    ) {
      toggleTemporalItem("Specific Humidity (2m Above Ground)", false);
    }
  }

  updateTooltip(step, targetEl) {
    const tooltip = this.elements.tooltip;
    if (!tooltip) return;

    tooltip.innerHTML = `
      <div class="gcop-tour-tooltip-header">
        <h3>${step.title}</h3>
        <button class="gcop-tour-close" aria-label="Close tour">&times;</button>
      </div>
      <div class="gcop-tour-tooltip-content">
        <p>${step.content}</p>
      </div>
      <div class="gcop-tour-tooltip-footer">
        <div class="gcop-tour-progress">
          <span>Step ${this.currentStep + 1} of ${TOUR_STEPS.length}</span>
          <div class="gcop-tour-progress-bar">
            <div class="gcop-tour-progress-fill" style="width:${((this.currentStep + 1) / TOUR_STEPS.length) * 100}%"></div>
          </div>
        </div>
        <div class="gcop-tour-buttons">
          ${
            this.currentStep > 0
              ? '<button class="gcop-tour-btn gcop-tour-prev">Previous</button>'
              : ""
          }
          ${
            this.currentStep < TOUR_STEPS.length - 1
              ? '<button class="gcop-tour-btn gcop-tour-next">Next</button>'
              : '<button class="gcop-tour-btn gcop-tour-finish">Finish</button>'
          }
        </div>
      </div>
    `;

    tooltip
      .querySelector(".gcop-tour-close")
      ?.addEventListener("click", () => this.endTour(false));
    tooltip
      .querySelector(".gcop-tour-prev")
      ?.addEventListener("click", this.prevStep);
    tooltip
      .querySelector(".gcop-tour-next")
      ?.addEventListener("click", this.nextStep);
    tooltip
      .querySelector(".gcop-tour-finish")
      ?.addEventListener("click", () => this.endTour(true));

    this.positionTooltip(targetEl, step.position);
    tooltip.classList.add("active");
  }

  positionTooltip(targetEl, position) {
    const tooltip = this.elements.tooltip;
    if (!tooltip) return;
    const rect = targetEl.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const offset = TOUR_CONFIG.tooltipOffset;

    let top = rect.bottom + offset;
    let left = rect.left + (rect.width - tooltipRect.width) / 2;

    switch (position) {
      case "top":
        top = rect.top - tooltipRect.height - offset;
        break;
      case "left":
        top = rect.top + (rect.height - tooltipRect.height) / 2;
        left = rect.left - tooltipRect.width - offset;
        break;
      case "right":
        top = rect.top + (rect.height - tooltipRect.height) / 2;
        left = rect.right + offset;
        break;
      case "bottom":
      default:
        break;
    }

    top = Math.max(10, Math.min(top, window.innerHeight - tooltipRect.height - 10));
    left = Math.max(10, Math.min(left, window.innerWidth - tooltipRect.width - 10));

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  updateHighlight(targetEl) {
    const highlight = this.elements.highlight;
    if (!highlight) return;
    const rect = targetEl.getBoundingClientRect();
    const padding = TOUR_CONFIG.highlightPadding;

    highlight.style.top = `${rect.top - padding}px`;
    highlight.style.left = `${rect.left - padding}px`;
    highlight.style.width = `${rect.width + padding * 2}px`;
    highlight.style.height = `${rect.height + padding * 2}px`;
    highlight.classList.add("active");
  }

  updateArrow(targetEl, position) {
    const arrow = this.elements.arrow;
    if (!arrow) return;
    const rect = targetEl.getBoundingClientRect();
    const arrowSize = TOUR_CONFIG.arrowSize;

    let top = rect.bottom + arrowSize;
    let left = rect.left + rect.width / 2;
    let rotation = 0;

    switch (position) {
      case "top":
        top = rect.top - arrowSize * 2.6;
        rotation = 180;
        break;
      case "left":
        top = rect.top + rect.height / 2;
        left = rect.left - arrowSize * 2.4;
        rotation = 90;
        break;
      case "right":
        top = rect.top + rect.height / 2;
        left = rect.right + arrowSize * 1.4;
        rotation = -90;
        break;
      default:
        break;
    }

    arrow.style.top = `${top}px`;
    arrow.style.left = `${left}px`;
    arrow.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    arrow.style.opacity = "1";
  }

  nextStep() {
    this.showStep(this.currentStep + 1);
  }

  prevStep() {
    this.showStep(this.currentStep - 1);
  }

  endTour(completed = false) {
    if (!this.isActive) return;
    this.isActive = false;
    this.completed = completed;
    this.detachEventListeners();
    this.onStateChange?.(false);
    closeSidebarPanel();
    closeUserPanel();
    closeBasemapPanel();
    closeLayerOrderPanel();
    closeLayerInfoPanel();

    this.elements.overlay?.classList.remove("active");
    this.elements.tooltip?.classList.remove("active");
    this.elements.highlight?.classList.remove("active");
    this.elements.arrow && (this.elements.arrow.style.opacity = "0");

    setTimeout(() => {
      this.elements.overlay?.remove();
      this.elements.tooltip?.remove();
      this.elements.arrow?.remove();
      this.elements = {
        overlay: null,
        tooltip: null,
        arrow: null,
        highlight: null,
      };

      if (this.completed) {
        window.location.reload();
      }
    }, TOUR_CONFIG.animationDuration);
  }

  attachEventListeners() {
    window.addEventListener("resize", this.handleResize);
    document.addEventListener("keydown", this.handleKeyPress);
  }

  detachEventListeners() {
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("keydown", this.handleKeyPress);
  }

  handleResize() {
    if (!this.isActive) return;
    clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => {
      this.showStep(this.currentStep);
    }, 100);
  }

  handleKeyPress(event) {
    if (!this.isActive) return;

    if (event.key === "Escape") this.endTour(false);
    if (event.key === "ArrowRight") this.nextStep();
    if (event.key === "ArrowLeft") this.prevStep();
  }
}

export class NCOPTourControl {
  constructor() {
    this.tour = new NCOPTour({
      onStateChange: (active) => {
        this.button?.classList.toggle("active", active);
      },
    });
    ensureTourStyles();
    this.render();
    this.addEventListeners();
  }

  render() {
    const controlsWrapper = document.querySelector(".map-controls-wrapper");
    if (!controlsWrapper || document.querySelector(".custom-tour-control")) return;

    const tourControl = document.createElement("div");
    tourControl.className = "custom-tour-control";
    tourControl.innerHTML = `
      <button id="ncopTourToggle" class="custom-layer-btn custom-tour-btn" title="NCOP Guided Tour">
        <i data-lucide="graduation-cap"></i>
      </button>
      <div id="ncopTourPanel" class="ncop-tour-panel">
        <div class="ncop-tour-panel-inner">
          <div class="ncop-tour-panel-title">NCOP Tour</div>
          <div class="ncop-tour-panel-subtitle">Take a smooth guided walkthrough of the map, controls, layers, and core tools across the application.</div>
          <div class="ncop-tour-panel-actions">
            <button type="button" class="ncop-tour-start">Start Tour</button>
            <button type="button" class="ncop-tour-close-panel">Close</button>
          </div>
        </div>
      </div>
    `;

    controlsWrapper.appendChild(tourControl);
    window.lucide?.createIcons?.();
  }

  addEventListeners() {
    this.button = document.getElementById("ncopTourToggle");
    this.panel = document.getElementById("ncopTourPanel");

    this.button?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.panel?.classList.toggle("visible");
      document.getElementById("basemapPanel")?.classList.remove("visible");
      document.getElementById("layerOrderPanel")?.classList.remove("visible");
      document.getElementById("layerInfoPanel")?.classList.remove("visible");
    });

    this.panel
      ?.querySelector(".ncop-tour-start")
      ?.addEventListener("click", () => {
        this.panel?.classList.remove("visible");
        this.tour.start();
      });

    this.panel
      ?.querySelector(".ncop-tour-close-panel")
      ?.addEventListener("click", () => {
        this.panel?.classList.remove("visible");
      });

    document.addEventListener("click", (event) => {
      if (!this.panel || !this.button) return;
      if (
        !this.panel.contains(event.target) &&
        !this.button.contains(event.target)
      ) {
        this.panel.classList.remove("visible");
      }
    });

    const closeTourPanel = () => this.panel?.classList.remove("visible");
    document
      .getElementById("basemapToggle")
      ?.addEventListener("click", closeTourPanel);
    document
      .getElementById("layerOrderToggle")
      ?.addEventListener("click", closeTourPanel);
    document
      .getElementById("layerInfoToggle")
      ?.addEventListener("click", closeTourPanel);

    // First-load floating hint — appears next to the tour button ~1.2s
    // after mount (giving `buildUnifiedRightRail` time to flatten the
    // button into `.map-right-rail`, otherwise `getBoundingClientRect`
    // returns the wrong position).  Auto-dismisses after 10s or on any
    // click / on start of the tour.
    this.#scheduleFirstLoadHint();
  }

  #scheduleFirstLoadHint() {
    setTimeout(() => this.#showFirstLoadHint(), 1200);
  }

  #showFirstLoadHint() {
    // If the button isn't on-screen yet (e.g. rail hasn't rendered), bail.
    const btn = document.getElementById("ncopTourToggle");
    if (!btn || !btn.getBoundingClientRect().width) return;
    // Never re-show once dismissed in the current session.
    if (document.querySelector(".ncop-tour-floating-hint")) return;

    const hint = document.createElement("div");
    hint.className = "ncop-tour-floating-hint";
    hint.innerHTML = `
      <button class="ncop-tour-floating-hint__close" type="button" aria-label="Dismiss">&times;</button>
      <span class="ncop-tour-floating-hint__title">New here?</span>
      Take the guided tour to learn every control, layer, and feature of NCOP in a few minutes.
    `;
    document.body.appendChild(hint);

    // Position: to the LEFT of the tour button, vertically centred on it.
    const rect = btn.getBoundingClientRect();
    // Measure the hint AFTER it's in the DOM so width/height are known.
    const hintRect = hint.getBoundingClientRect();
    const gap = 14;
    let top  = rect.top + rect.height / 2 - hintRect.height / 2;
    let left = rect.left - hintRect.width - gap;
    // Clamp to viewport.
    top  = Math.max(10, Math.min(top,  window.innerHeight - hintRect.height - 10));
    left = Math.max(10, left);
    hint.style.top  = `${top}px`;
    hint.style.left = `${left}px`;

    // Fade in.
    requestAnimationFrame(() => hint.classList.add("visible"));

    // Auto-dismiss after 10 s.
    const autoHideId = setTimeout(() => this.#dismissFirstLoadHint(hint), 10000);

    // Dismiss on close button, on tap of the hint itself, or on tour start.
    const dismiss = () => {
      clearTimeout(autoHideId);
      this.#dismissFirstLoadHint(hint);
    };
    hint
      .querySelector(".ncop-tour-floating-hint__close")
      ?.addEventListener("click", (e) => { e.stopPropagation(); dismiss(); });
    hint.addEventListener("click", () => {
      dismiss();
      // A click on the body of the tooltip opens the tour panel like the
      // button itself would — a "yes, I want the tour" affordance.
      this.button?.click();
    });
    this.button?.addEventListener("click", dismiss, { once: true });
  }

  #dismissFirstLoadHint(hint) {
    if (!hint || !hint.parentElement) return;
    hint.classList.remove("visible");
    setTimeout(() => hint.parentElement && hint.remove(), 320);
  }
}
