// ProjectionPanel.js
import { MapControls } from "./map-controls.js";

/**
 * Handles the logic for the map projection selection panel.
 */
export class ProjectionPanel {
    #map;
    #mapControls;
    #panel;
    #storage = window.ncop_storage;

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
        const savedProjection = this.#storage
            ? this.#storage.getSetting("mapProjection")
            : "mercator";

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
        const currentProjection = this.#storage
            ? this.#storage.getSetting("mapProjection") || "mercator"
            : "mercator";

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
