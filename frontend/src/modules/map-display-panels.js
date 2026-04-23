// BasemapPanel.js
import { MapControls } from "./map-controls.js";

import streetsLogo from "@assets/images/basemap_images/streets.webp";
import hybridLogo from "@assets/images/basemap_images/hybrid.webp";
import osmLogo from "@assets/images/basemap_images/osm.webp";
import outdoorsLogo from "@assets/images/basemap_images/outdoors.webp";
import satelliteLogo from "@assets/images/basemap_images/satellite.webp";
import lightLogo from "@assets/images/basemap_images/light.webp";
import darkLogo from "@assets/images/basemap_images/dark.webp";

/**
 * Module-level basemap registry. Exported so `dashboard.js` can resolve the
 * persisted basemap id to a URL at map-construction time — which avoids the
 * expensive setStyle rebuild that happens when we boot on one style and then
 * switch to another.
 */
export const BASEMAP_STYLES = [
    { id: "streets-v12", name: "Streets", image: streetsLogo },
    { id: "stadia/stamen_satellite", name: "Hybrid", image: hybridLogo, url: "https://tiles.stadiamaps.com/styles/alidade_satellite.json" },
    { id: "stadia/stamen_streets", name: "Open Street Map", image: osmLogo, url: "https://tiles.stadiamaps.com/styles/osm_bright.json" },
    { id: "carto/positron", name: "CARTO Positron", image: lightLogo, url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" },
    { id: "carto/voyager", name: "CARTO Voyager", image: streetsLogo, url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
    { id: "carto/dark-matter", name: "CARTO Dark Matter", image: darkLogo, url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" },
    { id: "openfreemap/liberty", name: "OpenFreeMap Liberty", image: streetsLogo, url: "https://tiles.openfreemap.org/styles/liberty" },
    { id: "openfreemap/bright", name: "OpenFreeMap Bright", image: osmLogo, url: "https://tiles.openfreemap.org/styles/bright" },
    { id: "openfreemap/positron", name: "OpenFreeMap Positron", image: lightLogo, url: "https://tiles.openfreemap.org/styles/positron" },
    { id: "stadia/alidade_smooth", name: "Alidade Smooth", image: lightLogo, url: "https://tiles.stadiamaps.com/styles/alidade_smooth.json" },
    { id: "stadia/alidade_smooth_dark", name: "Alidade Smooth Dark", image: darkLogo, url: "https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json" },
    { id: "outdoors-v12", name: "Outdoors", image: outdoorsLogo },
    { id: "satellite-v9", name: "Satellite", image: satelliteLogo },
    { id: "navigation-day-v1", name: "Day", image: lightLogo },
    { id: "navigation-night-v1", name: "Night", image: darkLogo },
];

/**
 * Resolve a persisted basemap id (e.g. "navigation-day-v1", "carto/positron")
 * to a style URL usable by `mapboxgl.Map({ style })` or `map.setStyle(...)`.
 * Unknown / missing ids fall back to the Mapbox streets-v12 default.
 */
export function resolveBasemapUrl(id) {
    const found = BASEMAP_STYLES.find((s) => s.id === id);
    if (found?.url) return found.url;
    if (found) return `mapbox://styles/mapbox/${found.id}`;
    return "mapbox://styles/mapbox/streets-v12";
}

/**
 * Handles the top-right basemap/style and labels control.
 */
export class BasemapPanel {
    #map;
    #mapControls;
    #basemapStyles = BASEMAP_STYLES;
    #currentStyle = "streets-v12";
    #labelsEnabled = true;

    /**
     * @param {mapboxgl.Map} mapInstance
     * @param {MapControls} mapControlsInstance
     */    constructor(mapInstance, mapControlsInstance) {
        this.#map = mapInstance;
        this.#mapControls = mapControlsInstance;
        this.render();
        this.addEventListeners();
    }

    render() {
        const mapContainer = document.getElementById("map");
        const basemapContainer = document.createElement("div");
        basemapContainer.className = "custom-basemap-control";
        basemapContainer.innerHTML = `
            <button id="basemapToggle" class="custom-basemap-btn" title="Change Basemap">
                <i data-lucide="layers"></i>
            </button>
            <div id="basemapPanel" class="basemap-panel">
                <div class="labels-toggle">
                    <span class="labels-toggle-text">Show Labels</span>
                    <div class="toggle-switch ${this.#labelsEnabled ? "active" : ""
            }" id="labelsToggle">
                        <div class="toggle-slider"></div>
                    </div>
                </div>                <div class="basemap-list" id="basemapList">
                    ${this.#basemapStyles
                .map(
                    (style) => `
                        <div class="basemap-item ${style.id === this.#currentStyle ? "active" : ""
                        }" data-style="${style.id}">
                            <div class="basemap-image">
                                <img src="${style.image}" alt="${style.name}" />
                            </div>
                            <span class="basemap-name">${style.name}</span>
                        </div>
                    `
                )
                .join("")}
                </div>
            </div>
        `;
        mapContainer.appendChild(basemapContainer);
        lucide.createIcons();
    }

    addEventListeners() {
        const basemapToggle = document.getElementById("basemapToggle");
        const basemapPanel = document.getElementById("basemapPanel");
        const labelsToggle = document.getElementById("labelsToggle");
        const basemapList = document.getElementById("basemapList");

        basemapToggle?.addEventListener("click", (e) => {
          e.stopPropagation();
          basemapPanel.classList.toggle("visible");
          // Hide layer order panel
          document
            .getElementById("layerOrderPanel")
            ?.classList.remove("visible");
          // Hide layer info panel
          document
            .getElementById("layerInfoPanel")
            ?.classList.remove("visible");
        });

        labelsToggle?.addEventListener(
            "click",
            this.#handleLabelsToggle.bind(this)
        );
        basemapList?.addEventListener(
            "click",
            this.#handleBasemapSelection.bind(this)
        );
        document.addEventListener("click", this.#handleOutsideClick.bind(this));

        const userPanel = document.getElementById("userPanel");
        if (userPanel) {
            this.#observeUserPanel(userPanel);
        }
    }

    #handleLabelsToggle() {
        this.#labelsEnabled = !this.#labelsEnabled;
        const labelsToggle = document.getElementById("labelsToggle");
        labelsToggle.classList.toggle("active", this.#labelsEnabled);

        this.#mapControls.toggleMapLabels(this.#labelsEnabled);
    }    #handleBasemapSelection(event) {
        const basemapItem = event.target.closest(".basemap-item");        if (basemapItem) {
            const newStyle = basemapItem.dataset.style;
            const basemapPanel = document.getElementById("basemapPanel");

            // Find the style configuration to check for custom URL
            const styleConfig = this.#basemapStyles.find(style => style.id === newStyle);
            
            // Fallback function to handle errors
            const fallbackToStreets = (reason) => {
                console.warn(`${reason}, falling back to streets-v12`);
                
                // Remove active class from all items
                document.querySelectorAll(".basemap-item").forEach((item) => {
                    item.classList.remove("active");
                });
                  // Set streets as active
                document.querySelector('.basemap-item[data-style="streets-v12"]')?.classList.add("active");
                
                // Set Mapbox streets style
                try {
                    this.#map.setStyle('mapbox://styles/mapbox/streets-v12');
                    this.#currentStyle = 'streets-v12';
                } catch (fallbackError) {
                    console.error('Critical error: Cannot load fallback basemap', fallbackError);
                }
            };
            
            try {
                let styleUrl;
                
                if (styleConfig && styleConfig.url) {
                    // Use custom URL for Stadia Maps styles
                    styleUrl = styleConfig.url;
                } else {
                    // Use standard Mapbox style
                    styleUrl = `mapbox://styles/mapbox/${newStyle}`;
                }
                  // Set up error handling - only for actual errors
                const errorHandler = (e) => {
                    console.error('Basemap loading error:', e);
                    fallbackToStreets(`Failed to load basemap style: ${newStyle}`);
                    this.#map.off('error', errorHandler);
                    this.#map.off('styledata', successHandler);
                };
                
                const successHandler = () => {
                    clearTimeout(loadingTimeout);
                    this.#map.off('error', errorHandler);
                    // console.log(`✅ Successfully loaded basemap: ${newStyle}`);
                    
                    if (!this.#labelsEnabled) {
                        this.#mapControls.toggleMapLabels(false);
                    }
                };
                
                // Add error listener
                this.#map.once('error', errorHandler);
                
                // Set timeout for loading (increased to 15 seconds)
                const loadingTimeout = setTimeout(() => {
                    console.warn(`Timeout loading basemap: ${newStyle}`);
                    fallbackToStreets(`Timeout loading basemap style: ${newStyle}`);
                    this.#map.off('error', errorHandler);
                    this.#map.off('styledata', successHandler);
                }, 15000); // 15 second timeout
                
                // Update UI optimistically
                document.querySelectorAll(".basemap-item").forEach((item) => {
                    item.classList.remove("active");
                });
                basemapItem.classList.add("active");
                  // Set up success handler
                this.#map.once('styledata', successHandler);
                
                // Set the style
                this.#map.setStyle(styleUrl);

                // Update current style immediately (optimistic)
                this.#currentStyle = newStyle;

            } catch (error) {
                fallbackToStreets(`Synchronous error setting basemap style: ${newStyle}`);
            }

            basemapPanel.classList.remove("visible");
        }
    }

    #handleOutsideClick(event) {
        const basemapToggle = document.getElementById("basemapToggle");
        const basemapPanel = document.getElementById("basemapPanel");
        if (
            !basemapPanel.contains(event.target) &&
            !basemapToggle.contains(event.target)
        ) {
            basemapPanel.classList.remove("visible");
        }
    }

    #observeUserPanel(userPanel) {
        const basemapContainer = document.querySelector(".custom-basemap-control");
        const basemapPanel = document.getElementById("basemapPanel");

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (
                    mutation.type === "attributes" &&
                    mutation.attributeName === "class"
                ) {
                    if (userPanel.classList.contains("user-panel-visible")) {
                        basemapContainer.classList.add("panel-open");
                        basemapPanel.classList.remove("visible");
                    } else {
                        basemapContainer.classList.remove("panel-open");
                    }
                }
            });
        });
        observer.observe(userPanel, { attributes: true });
    }
}

// ===========================================================================
// Projection panel (previously: projection-panel.js)
// ===========================================================================

/**
 * Handles the logic for the map projection selection panel.
 */
export class ProjectionPanel {
    #map;
    #mapControls;
    #panel;

    /**
     * @param {mapboxgl.Map} mapInstance
     * @param {MapControls} mapControlsInstance
     */
    constructor(mapInstance, mapControlsInstance) {
        this.#map = mapInstance;
        this.#mapControls = mapControlsInstance;
        this.render();
        this.addEventListeners();
    }

    /**
     * Renders the projection panel HTML.
     */
    render() {
        const mapContainer = document.getElementById("map");
        const savedProjection = "mercator";

        const projections = [
            {
                key: "mercator",
                name: "Mercator",
                desc: "Standard web map projection",
                emoji: "🌍",
            },
            { key: "globe", name: "Globe", desc: "3D globe view", emoji: "🌐" },
            {
                key: "albers",
                name: "Albers",
                desc: "Equal-area conic projection",
                emoji: "🗺️",
            },
            {
                key: "equalEarth",
                name: "Equal Earth",
                desc: "Equal-area pseudocylindrical",
                emoji: "🌎",
            },
            {
                key: "naturalEarth",
                name: "Natural Earth",
                desc: "Compromise pseudocylindrical",
                emoji: "🌏",
            },
            {
                key: "winkelTripel",
                name: "Winkel Tripel",
                desc: "Modified azimuthal projection",
                emoji: "🗺️",
            },
        ];

        this.#panel = document.createElement("div");
        this.#panel.id = "projectionPanel";
        this.#panel.className = "projection-panel";
        this.#panel.innerHTML = `
            <div class="projection-header">
                <h3>Map Projections</h3>
                <button id="projectionClose" class="projection-close-btn"><i data-lucide="x"></i></button>
            </div>
            <div class="projection-list">
                ${projections
                .map(
                    (p) => `
                    <div class="projection-item ${p.key === savedProjection ? "active" : ""
                        }" data-projection="${p.key}">
                        <div class="projection-preview">${p.emoji}</div>
                        <div class="projection-info">
                            <div class="projection-name">${p.name}</div>
                            <div class="projection-desc">${p.desc}</div>
                        </div>
                    </div>
                `
                )
                .join("")}
            </div>
        `;

        mapContainer.appendChild(this.#panel);
        lucide.createIcons();
    }

    addEventListeners() {
        document
            .getElementById("projectionClose")
            ?.addEventListener("click", () => {
                this.#panel.classList.remove("visible");
            });

        this.#panel.querySelectorAll(".projection-item").forEach((item) => {
            item.addEventListener(
                "click",
                this.#handleProjectionSelection.bind(this, item)
            );
        });

        document.addEventListener("click", this.#handleOutsideClick.bind(this));
    }

    #handleProjectionSelection(item) {
        const projection = item.dataset.projection;
        this.#mapControls.changeMapProjection(projection);

        this.#panel
            .querySelectorAll(".projection-item")
            .forEach((i) => i.classList.remove("active"));
        item.classList.add("active");

        setTimeout(() => {
            this.#panel.classList.remove("visible");
        }, 500);
    }

    updateActiveProjection() {
        const currentProjection = "mercator";

        this.#panel.querySelectorAll(".projection-item").forEach((item) => {
            item.classList.remove("active");
            if (item.dataset.projection === currentProjection) {
                item.classList.add("active");
            }
        });
    }

    /**
     * Toggles the visibility of the projection panel.
     */
    togglePanel() {
        if (this.#panel) {
            if (!this.#panel.classList.contains("visible")) {
                this.updateActiveProjection();
            }
            this.#panel.classList.toggle("visible");
        }
    }

    #handleOutsideClick(event) {
        const projectionSwitchBtn = document.getElementById("projectionSwitch");
        if (
            !this.#panel.contains(event.target) &&
            !projectionSwitchBtn.contains(event.target)
        ) {
            this.#panel.classList.remove("visible");
        }
    }
}
