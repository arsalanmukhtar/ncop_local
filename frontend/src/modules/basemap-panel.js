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
 * Handles the top-right basemap/style and labels control.
 * Note: Basemap selections are not persisted to storage - always defaults to streets-v12 on load.
 */
export class BasemapPanel {
    #map;
    #storage = window.ncop_storage;
    #mapControls;
    #basemapStyles = [
        { id: "streets-v12", name: "Streets", image: streetsLogo },
        // { id: "stadia/stamen_satellite", name: "Hybrid", image: hybridLogo, url: "https://tiles.stadiamaps.com/styles/alidade_satellite.json" },
        // { id: "stadia/stamen_streets", name: "Open Street Map", image: osmLogo, url: "https://tiles.stadiamaps.com/styles/osm_bright.json" },
        { id: "outdoors-v12", name: "Outdoors", image: outdoorsLogo },
        { id: "satellite-v9", name: "Satellite", image: satelliteLogo },
        { id: "navigation-day-v1", name: "Day", image: lightLogo },
        { id: "navigation-night-v1", name: "Night", image: darkLogo },
        // { id: "light-v11", name: "Light", image: "/static/images/basemap_images/day.webp" },
        // { id: "dark-v11", name: "Dark", image: "/static/images/basemap_images/night.webp" },
    ];
    #currentStyle;
    #labelsEnabled;

    /**
     * @param {mapboxgl.Map} mapInstance
     * @param {MapControls} mapControlsInstance
     */    constructor(mapInstance, mapControlsInstance) {
        this.#map = mapInstance;
        this.#mapControls = mapControlsInstance;
        // Always default to streets-v12, no storage for basemap
        this.#currentStyle = "streets-v12";
        this.#labelsEnabled = this.#storage ? this.#storage.getLabelsState() : true;
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

        if (this.#storage) {
            this.#storage.saveLabelsState(this.#labelsEnabled);
        }

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
                    
                    // Note: Basemap fallback is not saved to storage
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

                // Note: Basemap selection is not saved to storage
                
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
