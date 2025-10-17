// NavigationPanel.js
import { MapControls } from "./map-controls.js";

/**
 * Handles the bottom-right map navigation controls (zoom, bearing, 3D toggle, locate, home).
 * Assumes mapboxgl is globally available for Marker functionality.
 */
export class NavigationPanel {
    #map;
    #mapControls;

    /**
     * @param {mapboxgl.Map} mapInstance
     * @param {MapControls} mapControlsInstance
     * @param {ProjectionPanel} projectionPanelInstance - Must be passed for projection button
     */
    constructor(mapInstance, mapControlsInstance, projectionPanelInstance) {
        this.#map = mapInstance;
        this.#mapControls = mapControlsInstance;
        this.projectionPanel = projectionPanelInstance; // Store reference
        this.render();
        this.addEventListeners();
    }

    /**
     * Renders the custom navigation controls HTML into the map container.
     */
    render() {
        const mapContainer = document.getElementById("map");
        const navWrapper = document.createElement("div");
        navWrapper.className = "nav-controls-wrapper";
        navWrapper.innerHTML = `
            <div class="custom-nav-control" id="navControlsContainer">
                <button id="zoomIn" class="custom-nav-btn" title="Zoom In"><i data-lucide="plus"></i></button>
                <button id="zoomOut" class="custom-nav-btn" title="Zoom Out"><i data-lucide="minus"></i></button>
                <button id="resetBearing" class="custom-nav-btn" title="Reset Bearing"><i data-lucide="compass"></i></button>
                <button id="toggle3D" class="custom-nav-btn" title="Switch to 3D View (2D Mode)">
                    <span class="nav-text">3D</span>
                </button>
                <button id="projectionSwitch" class="custom-nav-btn" title="Map Projections"><i data-lucide="earth"></i></button>
                <button id="locate" class="custom-nav-btn" title="Find My Location"><i data-lucide="map-pin"></i></button>
                <button id="homeExtent" class="custom-nav-btn" title="Zoom to Pakistan"><i data-lucide="house"></i></button>
                <button id="navToggleBtn" class="nav-toggle-btn" title="Toggle Navigation Controls"><i data-lucide="chevron-left"></i></button>
            </div>
        `;
        mapContainer.appendChild(navWrapper);
        lucide.createIcons();
        this.restoreToggle3DState(
            window.ncop_storage?.getSetting("terrainEnabled")
        );
    }

    addEventListeners() {
        document
            .getElementById("navToggleBtn")
            ?.addEventListener("click", this.#handleNavToggle.bind(this));
        document
            .getElementById("zoomIn")
            ?.addEventListener("click", () => this.#map.zoomIn({ duration: 300 }));
        document
            .getElementById("zoomOut")
            ?.addEventListener("click", () => this.#map.zoomOut({ duration: 300 }));
        document
            .getElementById("resetBearing")
            ?.addEventListener("click", this.#handleResetBearing.bind(this));
        document
            .getElementById("toggle3D")
            ?.addEventListener("click", this.#handleToggle3D.bind(this));

        // Use the injected ProjectionPanel instance
        document
            .getElementById("projectionSwitch")
            ?.addEventListener("click", () => this.projectionPanel.togglePanel());

        document
            .getElementById("locate")
            ?.addEventListener("click", this.#handleLocate.bind(this));
        document
            .getElementById("homeExtent")
            ?.addEventListener("click", this.#handleHomeExtent.bind(this));
    }

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

    #handleResetBearing() {
        this.#map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
    }

    #handleToggle3D() {
        const toggle3DButton = document.getElementById("toggle3D");
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

    #handleLocate() {
        const targetCoords = [73.09896723226383, 33.681421388232]; // Islamabad
        this.#map.flyTo({ center: targetCoords, zoom: 15, duration: 2000 });
        new mapboxgl.Marker({ color: "#ff0000" })
            .setLngLat(targetCoords)
            .addTo(this.#map);
        // console.log("🎯 Zoomed to target location:", targetCoords);
    }

    #handleHomeExtent() {
        const pakistanCenter = [69.3451, 30.3753];
        this.#map.flyTo({
            center: pakistanCenter,
            zoom: 5,
            duration: 2000,
            essential: true,
        });
        // console.log("🏠 Zoomed to Pakistan extent");
    }

    /**
     * Updates the 3D toggle button state.
     * @param {boolean} terrainEnabled - The saved terrain state.
     */
    restoreToggle3DState(terrainEnabled) {
        const button = document.getElementById("toggle3D");
        if (button) {
            if (terrainEnabled) {
                button.title = "Switch to 2D View (3D Mode)";
                button.classList.add("terrain-active");
            } else {
                button.title = "Switch to 3D View (2D Mode)";
                button.classList.remove("terrain-active");
            }
        }
    }
}
