// MapControls.js

/**
 * Handles the Mapbox map instance and core map interactions (labels, projection, terrain).
 * Assumes mapboxgl and ncop_storage are available globally or managed by the caller.
 */
export class MapControls {
    #map;
    #storage;

    constructor(mapInstance, storageInstance) {
        this.#map = mapInstance;
        this.#storage = storageInstance;
    }

    /**
     * Toggles the visibility of symbol layers, typically used for map labels.
     * @param {boolean} enabled - True to show labels, false to hide.
     */
    toggleMapLabels(enabled) {
        const style = this.#map.getStyle();
        if (style && style.layers) {
            style.layers.forEach((layer) => {
                // Target symbol layers with a text-field property
                if (
                    layer.type === "symbol" &&
                    layer.layout &&
                    layer.layout["text-field"]
                ) {
                    this.#map.setLayoutProperty(
                        layer.id,
                        "visibility",
                        enabled ? "visible" : "none"
                    );
                }
            });
        }
        // console.log(`🗺️ Map labels toggled: ${enabled ? "visible" : "none"}`);
    }

    /**
     * Changes the map's projection and saves the preference.
     * @param {string} projectionName - The Mapbox GL JS projection name.
     */
    changeMapProjection(projectionName) {
        try {
            this.#map.setProjection(projectionName);
            // console.log(`🌍 Changed projection to: ${projectionName}`);
            if (this.#storage) {
                this.#storage.saveSetting("mapProjection", projectionName);
            }
        } catch (error) {
            console.error("Error changing projection:", error);
            this.#map.setProjection("mercator");
        }
    }

    /**
     * Adds Mapbox GL JS DEM source and enables 3D terrain.
     */
    enableTerrain() {
        // console.log("🏔️ Enabling 3D Terrain mode...");
        const DEM_SOURCE_ID = "mapbox-dem";

        if (!this.#map.getSource(DEM_SOURCE_ID)) {
            try {
                this.#map.addSource(DEM_SOURCE_ID, {
                    type: "raster-dem",
                    url: "mapbox://mapbox.mapbox-terrain-dem-v1",
                    tileSize: 512,
                    maxzoom: 14,
                });
            } catch (error) {
                console.warn("Error adding terrain source:", error);
            }
        }

        try {
            this.#map.setTerrain({ source: DEM_SOURCE_ID, exaggeration: 1.5 });
        } catch (error) {
            console.warn("Error setting terrain:", error);
        }

        this.#map.easeTo({
            pitch: 80,
            bearing: -17.6,
            duration: 1000,
        });

        if (this.#storage) {
            this.#storage.saveSetting("terrainEnabled", true);
        }
    }

    /**
     * Removes 3D terrain and returns to 2D view.
     */
    disableTerrain() {
        // console.log("🗺️ Switching to 2D mode...");

        try {
            this.#map.setTerrain(null);
        } catch (error) {
            console.warn("Error removing terrain:", error);
        }

        setTimeout(() => {
            try {
                if (this.#map.getSource("mapbox-dem")) {
                    this.#map.removeSource("mapbox-dem");
                }
            } catch (error) {
                console.warn("Error removing terrain source:", error);
            }
        }, 200);

        const currentProjection = this.#storage
            ? this.#storage.getSetting("mapProjection") || "mercator"
            : "mercator";

        this.#map.easeTo({
            pitch: 0,
            bearing: 0,
            duration: 1000,
        });

        setTimeout(() => {
            try {
                this.#map.setProjection(currentProjection);
                // console.log("🌍 Projection restored to:", currentProjection);
            } catch (error) {
                console.warn("Error setting projection:", error);
                this.#map.setProjection("mercator");
            }
        }, 1200);

        if (this.#storage) {
            this.#storage.saveSetting("terrainEnabled", false);
        }
    }
}
