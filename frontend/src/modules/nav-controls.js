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

const TOUR_STEPS = [
  {
    target: "#ncop-home-top-bar, .ncop-home-top-bar",
    title: "Welcome to NCOP",
    content:
      "This is your operational workspace for monitoring layers, alerts, weather, and map-based analysis tools in one place.",
    position: "bottom",
  },
  {
    target: "#miniglobe-wrapper",
    title: "Overview Globe",
    content:
      "Use the mini globe for quick orientation while you move around the main operational map.",
    position: "left",
  },
  {
    target: "#sidebarPanel.sidebar-panel",
    title: "Layers Panel",
    content:
      "Open the sidebar to browse categories, toggle operational layers, and work with temporal products.",
    position: "right",
    action: "openSidebar",
  },
  {
    title: "GIS Layers",
    content:
      "This section contains core geographic reference layers such as boundaries, infrastructure, and hydrological context.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "GIS Layers",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "GIS Layers",
  },
  {
    title: "Weather Systems",
    content:
      "This section groups weather observations, PMD stations, radar layers, and forecast products for operational monitoring.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Weather Systems",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Weather Systems",
  },
  {
    title: "GDPS Forecast Layers",
    content:
      "Inside Weather Systems, this section contains multiple temporal forecast products. You can open any of these time-enabled layers from the gallery to explore changing conditions over time.",
    position: "right",
    action: "openSidebarSubcategory",
    actionValue: "Global Deterministic Prediction System (GDPS)",
    targetResolver: "subcategoryHeaderByTitle",
    targetValue: "Global Deterministic Prediction System (GDPS)",
  },
  {
    title: "Temporal Layer Example",
    content:
      "This temporal layer is selected as an example. Activating a forecast item like this loads its time-aware visualization and controls.",
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
      "This panel controls the active temporal layer. Use the drag button to move it, the resize button to adjust its size, the play and pause controls to animate the timeline, the droplet button to change layer opacity, and the speed button to control playback rate. The main slider moves between time steps, the date labels show the available frames, and the legend below explains the value range and symbology for the current layer.",
    position: "bottom",
  },
  {
    title: "Flood Monitoring",
    content:
      "Flood monitoring brings together flood data, GloFAS products, rivers, and hydrologic overlays for situational awareness.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Flood Monitoring",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Flood Monitoring",
  },
  {
    title: "Air Quality",
    content:
      "This section is focused on air quality observations, atmospheric pollutants, and forecast products for environmental monitoring.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Air Quality",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Air Quality",
  },
  {
    title: "Ocean and Coastal",
    content:
      "Ocean and coastal layers provide marine conditions, oceanographic products, and coastal monitoring context.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Ocean & Coastal",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Ocean & Coastal",
  },
  {
    title: "Early Warning",
    content:
      "Early warning includes exposure products, alert feeds, hazard monitoring, and operational warning support tools.",
    position: "right",
    action: "openSidebarAccordion",
    actionValue: "Early Warning",
    targetResolver: "accordionHeaderByTitle",
    targetValue: "Early Warning",
  },
  {
    target: ".mapboxgl-ctrl-geocoder",
    title: "Location Search",
    content:
      "Search for places, coordinates, and areas of interest to move the map quickly to the right location.",
    position: "bottom",
  },
  {
    target: ".custom-user-control",
    title: "User Panel",
    content:
      "This control gives access to the user panel, where account-related actions and user options are kept separate from the main map workspace.",
    position: "left",
  },
  {
    target: "#ncop-timeseries-animation-slider-div",
    title: "Time Slider",
    content:
      "Temporal layers use this slider for stepping through forecasts, observations, and time-enabled datasets.",
    position: "top",
  },
  {
    target: ".custom-basemap-control",
    title: "Basemap Control",
    content:
      "Use this button to open the basemap panel and change the overall background style of the map.",
    position: "left",
    action: "openBasemapPanel",
  },
  {
    target: "#basemapPanel.visible .labels-toggle",
    title: "Labels Toggle",
    content:
      "This switch turns place labels on or off so you can either reduce clutter or keep reference names visible.",
    position: "left",
    action: "openBasemapPanel",
  },
  {
    target: "#basemapPanel.visible",
    title: "Basemap Styles",
    content:
      "These style cards let you switch between streets, hybrid, OSM, outdoors, satellite, day, and night views.",
    position: "left",
    action: "openBasemapPanel",
  },
  {
    target: ".custom-layer-control",
    title: "Layer Order",
    content:
      "Reorder active layers here so the most important overlays stay visible above the rest.",
    position: "left",
    action: "openLayerOrderPanel",
  },
  {
    target: "#layerOrderPanel",
    title: "Layer Order Panel",
    content:
      "This panel lists active layers and lets you drag them to change their drawing order on the map.",
    position: "left",
    action: "openLayerOrderPanel",
  },
  {
    target: ".custom-layer-info-control",
    title: "Layer Information",
    content:
      "Use this panel to review descriptions, active layer details, and legends for operational interpretation.",
    position: "left",
    action: "openLayerInfoPanel",
  },
  {
    target: "#layerInfoPanel",
    title: "Layer Info Panel",
    content:
      "When layers are active, this panel shows their descriptive information and legends for interpretation.",
    position: "left",
    action: "openLayerInfoPanel",
  },
  {
    target: ".custom-tour-control",
    title: "Tour Control",
    content:
      "Use this control any time you want to restart the NCOP guided tour.",
    position: "left",
  },
  {
    target: ".mapboxgl-ctrl-scale",
    title: "Scale Bar",
    content:
      "The scale bar helps estimate distance on the ground at the current zoom level.",
    position: "top",
  },
  {
    target: "#zoomIn",
    title: "Zoom In",
    content:
      "Zoom in to inspect the map at a more detailed operational scale.",
    position: "left",
  },
  {
    target: "#zoomOut",
    title: "Zoom Out",
    content:
      "Zoom out to recover wider regional context and compare a larger area.",
    position: "left",
  },
  {
    target: "#resetBearing",
    title: "Reset Bearing and Tilt",
    content:
      "Use this to return the map to a clean default orientation after rotating or tilting the view.",
    position: "left",
  },
  {
    target: "#toggle3D",
    title: "3D Toggle",
    content:
      "Switch between standard 2D viewing and a more terrain-focused 3D perspective.",
    position: "left",
  },
  {
    target: "#projectionSwitch",
    title: "Projection Switch",
    content:
      "Open the projection options to switch how the world is represented on the map.",
    position: "left",
  },
  {
    target: "#windParticles",
    title: "Wind Animation",
    content:
      "This control toggles animated wind particles to visualize atmospheric flow.",
    position: "left",
  },
  {
    target: "#oceanParticles",
    title: "Ocean Currents",
    content:
      "This control toggles animated ocean current particles for marine context.",
    position: "left",
  },
  {
    target: "#locate",
    title: "Locate",
    content:
      "Use this button to jump quickly to the configured working location or point of interest.",
    position: "left",
  },
  {
    target: "#localNews",
    title: "Local News",
    content:
      "Open the local news panel to monitor operationally relevant headlines alongside the map.",
    position: "left",
  },
  {
    target: "#geeChat",
    title: "GEE Chatbot",
    content:
      "Open the GEE chatbot for guided interaction and data support inside the application.",
    position: "left",
  },
  {
    target: "#osmData",
    title: "OpenStreetMap Data",
    content:
      "Use this control to access OpenStreetMap-based data and supporting context layers.",
    position: "left",
  },
  {
    target: "#homeExtent",
    title: "Home Extent",
    content:
      "Return the map quickly to the default operational extent for a consistent overview.",
    position: "left",
  },
  {
    target: "#storyBtn",
    title: "Story Panel",
    content:
      "Open the story panel to run map-based narratives and guided story workflows.",
    position: "left",
  },
  {
    target: "#navToggleBtn",
    title: "Navigation Toggle",
    content:
      "Collapse or expand the navigation controls to save space when you want a cleaner map view.",
    position: "left",
  },
  {
    target: ".mapboxgl-ctrl-zoom-in",
    title: "Zoom Controls",
    content:
      "Zoom in and out for regional overview or local detail. This works alongside mouse and touch gestures.",
    position: "left",
  },
  {
    target: ".mapboxgl-ctrl-compass",
    title: "Compass and Rotation",
    content:
      "Reset north or rotate the map orientation for different viewing angles when presenting or analyzing features.",
    position: "left",
  },
  {
    target: "#mapbox-gl-elevation",
    title: "Elevation Profile",
    content:
      "Analyze terrain variation and slopes for access, route review, and topographic context.",
    position: "left",
  },
  {
    target: "#geoglowsForecast",
    title: "GeoGLOWS Forecast Tool",
    content:
      "Use GeoGLOWS mode for river forecast context and hydrologic monitoring on the map.",
    position: "left",
  },
  {
    target: "#mapbox-gl-globe-projection",
    title: "Projection Control",
    content:
      "Switch between flat and globe-style map perspectives depending on the view you need.",
    position: "left",
  },
  {
    target: ".ncop-container.fixed.top-3.left-3.z-50, #themeToggleBtn",
    title: "Theme Toggle",
    content:
      "Switch the interface theme to match your working environment and improve readability.",
    position: "bottom",
  },
  {
    target: ".custom-tour-control",
    title: "NCOP Tour",
    content:
      "You can restart this guided walkthrough anytime from this tour control.",
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

    .custom-tour-btn:not(.active) {
      animation: ncopTourBlink 1.8s ease-in-out infinite;
    }

    .custom-tour-btn:not(.active) svg {
      animation: ncopTourIconBlink 1.8s ease-in-out infinite;
    }

    @keyframes ncopTourBlink {
      0%,
      100% {
        border-color: rgba(255, 255, 255, 0.18);
        box-shadow:
          0 0 0 rgba(70, 178, 255, 0),
          inset 0 0 0 rgba(70, 178, 255, 0);
      }
      50% {
        border-color: var(--ndma-blue-glow, rgba(70, 178, 255, 0.55));
        box-shadow:
          0 0 12px var(--ndma-blue-glow, rgba(70, 178, 255, 0.25)),
          inset 0 0 8px rgba(70, 178, 255, 0.14);
      }
    }

    @keyframes ncopTourIconBlink {
      0%,
      100% {
        color: inherit;
        filter: drop-shadow(0 0 0 rgba(70, 178, 255, 0));
      }
      50% {
        color: #8fd3ff;
        filter: drop-shadow(0 0 6px var(--ndma-blue-glow, rgba(70, 178, 255, 0.25)));
      }
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
    if (
      previousStep?.action &&
      sidebarActions.has(previousStep.action) &&
      (!nextStep?.action || !sidebarActions.has(nextStep.action))
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
      (previousStep?.action === "activateTemporalItem" ||
        previousStep?.target === "#temp-slider1") &&
      nextStep?.target !== "#temp-slider1" &&
      nextStep?.action !== "activateTemporalItem"
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
  }
}
