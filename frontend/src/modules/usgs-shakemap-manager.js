// usgs-shakemap-manager.js
export class USGSShakemapManager {
    constructor(map) {
        this.map = map;
        this.modal = null;
        this.earthquakeSelect = null;
        this.shakemapSelect = null;
        this.loadBtn = null;
        this.clearBtn = null;
        this.currentLegendUrl = "";
        this.selectedShakemapUrls = [];
        this.activeShakemapLayers = [];

        this.init();
    }

    init() {
        this.modal = document.getElementById("usgsShakemapModal");
        this.earthquakeSelect = document.getElementById("usgsEarthquakeSelect");
        this.shakemapSelect = document.getElementById("usgsShakemapSelect");
        this.loadBtn = document.getElementById("usgsLoadShakemapBtn");
        this.clearBtn = document.getElementById("usgsClearShakemapBtn");

        this.attachEventListeners();
    }

    attachEventListeners() {
        // Close modal
        document.getElementById("usgsModalClose")?.addEventListener("click", () => {
            this.closeModal();
        });

        // Close on backdrop click
        this.modal?.addEventListener("click", (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });

        // Earthquake selection
        this.earthquakeSelect?.addEventListener("change", () => {
            this.loadShakemapOptions();
        });

        // Shakemap selection (multiple)
        this.shakemapSelect?.addEventListener("change", () => {
            this.updateSelectedShakemaps();
        });

        // Load shakemap button
        this.loadBtn?.addEventListener("click", () => {
            this.loadShakemapsOnMap();
        });

        // Clear shakemap button
        this.clearBtn?.addEventListener("click", () => {
            this.clearShakemaps();
        });
    }

    async openModal() {
        this.modal?.classList.add("show");
        await this.fetchEarthquakes();

        // Reinitialize Lucide icons
        if (window.lucide?.createIcons) {
            window.lucide.createIcons();
        }
    }

    closeModal() {
        this.modal?.classList.remove("show");
    }

    async fetchEarthquakes() {
        try {
            this.earthquakeSelect.innerHTML = '<option selected disabled>Loading earthquakes...</option>';

            const minmagnitude = 5;
            const startTime = this.getNextNDays(-10);
            const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?minmagnitude=${minmagnitude}&format=geojson&starttime=${startTime}T19:00:00`;

            const res = await fetch(url);
            const { features } = await res.json();

            this.earthquakeSelect.innerHTML = '<option selected disabled>Select Earthquake (Mag ≥ 5)</option>';

            for (let i = 0; i < features.length; i++) {
                const f = features[i];
                const time = this.unixTimeToUTC(f.properties.time);
                const title = f.properties.title;
                const option = document.createElement("option");
                option.value = f.id;
                option.textContent = `${time} - ${title}`;
                this.earthquakeSelect.appendChild(option);
            }
        } catch (err) {
            console.error("Error fetching earthquakes:", err);
            this.earthquakeSelect.innerHTML = '<option selected disabled>Error loading earthquakes</option>';
        }
    }

    async loadShakemapOptions() {
        const eventId = this.earthquakeSelect.value;
        if (!eventId) return;

        try {
            this.shakemapSelect.innerHTML = '<option selected disabled>Loading shakemap options...</option>';
            this.loadBtn.disabled = true;

            const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=${eventId}&format=geojson`;
            const res = await fetch(url);
            const { properties } = await res.json();
            const contents = properties?.products?.shakemap?.[0]?.contents;

            if (!contents) {
                const selectedText = this.earthquakeSelect.options[this.earthquakeSelect.selectedIndex].textContent;
                alert(`No ShakeMap available for:\n\nID: ${eventId}\nEvent: ${selectedText}`);
                this.shakemapSelect.innerHTML = '<option selected disabled>No shakemap available</option>';
                return;
            }

            this.shakemapSelect.innerHTML = '';

            const labelMap = {
                psa0p3: "PSA03 Contours",
                mmi: "MMI Contours",
                psa1p0: "PSA10 Contours",
                psa3p0: "PSA30 Contours",
                psa0p6: "PSA06 Contours",
                pga: "PGA Contours",
                mi: "MI Contours",
                pgv: "PGV Contours",
                stationlist: "Shakemap Stations",
            };

            for (const name in contents) {
                const info = contents[name];

                if (name.includes("download/cont_") || name === "download/stationlist.json") {
                    const key = name.split("/").pop().replace(".json", "").replace("cont_", "");
                    const label = labelMap[key] || key;
                    const option = document.createElement("option");
                    option.value = info.url;
                    option.textContent = label;
                    option.dataset.isStationList = name === "download/stationlist.json" ? "true" : "false";
                    this.shakemapSelect.appendChild(option);
                }

                if (name === "download/mmi_legend.png") {
                    this.currentLegendUrl = contents[name].url;
                }
            }

            this.shakemapSelect.insertAdjacentHTML('afterbegin', '<option selected disabled>Select one or more shakemap layers</option>');
        } catch (err) {
            console.error("Error fetching shakemap details:", err);
            this.shakemapSelect.innerHTML = '<option selected disabled>Error loading shakemap options</option>';
        }
    }

    updateSelectedShakemaps() {
        const selected = Array.from(this.shakemapSelect.selectedOptions);
        this.selectedShakemapUrls = selected
            .filter(opt => !opt.disabled)
            .map(opt => ({
                url: opt.value,
                label: opt.textContent,
                isStationList: opt.dataset.isStationList === "true"
            }));

        this.loadBtn.disabled = this.selectedShakemapUrls.length === 0;
    }

    async loadShakemapsOnMap() {
        if (this.selectedShakemapUrls.length === 0) return;

        this.loadBtn.disabled = true;
        this.loadBtn.innerHTML = '<span class="usgs-loading"></span> Loading...';

        try {
            // Show legend if available
            if (this.currentLegendUrl) {
                const legendContainer = document.getElementById("usgsLegendContainer");
                const legendImage = document.getElementById("usgsLegendImage");
                legendImage.src = this.currentLegendUrl;
                legendContainer.style.display = "block";
            }

            // Load each selected shakemap
            for (const shakemap of this.selectedShakemapUrls) {
                await this.addShakemapLayer(shakemap.url, this.currentLegendUrl, shakemap.isStationList);
            }

            this.clearBtn.disabled = false;
            this.closeModal();
        } catch (err) {
            console.error("Error loading shakemaps:", err);
            alert("Error loading shakemap layers. Please try again.");
        } finally {
            this.loadBtn.innerHTML = '<i data-lucide="download"></i> Load ShakeMap on Map';
            this.loadBtn.disabled = false;
            if (window.lucide?.createIcons) {
                window.lucide.createIcons();
            }
        }
    }

    async addShakemapLayer(url, legendUrl, isStationList = false) {
        const layerId = `usgs_shakemap_layer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const sourceId = `usgs_shakemap_source_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        try {
            const geojson = await (await fetch(url)).json();
            const animatedData = { type: "FeatureCollection", features: [] };

            // Determine geometry type
            const firstGeom = geojson.features[0]?.geometry?.type || "";
            let layerType = "line";
            let paint = {};

            if (firstGeom.includes("Point")) {
                layerType = "circle";
                paint = {
                    "circle-radius": isStationList ? [
                        "interpolate",
                        ["linear"],
                        ["get", "intensity"],
                        0, 6,
                        10, 20,
                    ] : 5,
                    "circle-color": isStationList ? [
                        "interpolate",
                        ["linear"],
                        ["get", "intensity"],
                        0, "#00bfff",
                        2, "#00ff00",
                        4, "#ffff00",
                        6, "#ff8000",
                        8, "#ff0000",
                    ] : ["coalesce", ["to-color", ["get", "color"]], "#FF0000"],
                    "circle-stroke-width": 1,
                    "circle-stroke-color": "#ffffff",
                };
            } else if (firstGeom.includes("Polygon")) {
                layerType = "fill";
                paint = {
                    "fill-color": ["coalesce", ["to-color", ["get", "color"]], "#FF0000"],
                    "fill-opacity": 0.4,
                    "fill-outline-color": "#000000",
                };
            } else if (firstGeom.includes("Line")) {
                layerType = "line";
                paint = {
                    "line-color": ["coalesce", ["to-color", ["get", "color"]], "#FF0000"],
                    "line-width": ["coalesce", ["get", "weight"], 2],
                };
            }

            // Add source and layer
            this.map.addSource(sourceId, { type: "geojson", data: animatedData });
            this.map.addLayer({ id: layerId, type: layerType, source: sourceId, paint });

            // Store for cleanup
            this.activeShakemapLayers.push({ layerId, sourceId });

            // Fit bounds
            const bounds = geojson.features.reduce((b, { geometry }) => {
                const coords = geometry.coordinates.flat(2);
                for (let i = 0; i < coords.length; i += 2) {
                    b.extend([coords[i], coords[i + 1]]);
                }
                return b;
            }, new mapboxgl.LngLatBounds());

            if (!bounds.isEmpty()) {
                this.map.fitBounds(bounds, { padding: 50 });
            }

            // Animate features
            let index = 0;
            const interval = setInterval(() => {
                if (index < geojson.features.length) {
                    animatedData.features.push(geojson.features[index++]);
                    this.map.getSource(sourceId).setData(animatedData);
                } else {
                    clearInterval(interval);
                }
            }, 50);
        } catch (err) {
            console.error("Error loading shakemap content:", err);
        }
    }

    clearShakemaps() {
        if (this.activeShakemapLayers && this.activeShakemapLayers.length > 0) {
            this.activeShakemapLayers.forEach(({ layerId, sourceId }) => {
                if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
                if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
            });
            this.activeShakemapLayers = [];
        }

        // Hide legend
        const legendContainer = document.getElementById("usgsLegendContainer");
        if (legendContainer) {
            legendContainer.style.display = "none";
        }

        this.clearBtn.disabled = true;
    }

    // Helper functions
    getNextNDays(days) {
        const date = new Date();
        date.setDate(date.getDate() + days);
        return date.toISOString().split("T")[0];
    }

    unixTimeToUTC(unixTime) {
        const date = new Date(unixTime);
        return date.toISOString().replace("T", " ").substring(0, 19) + " UTC";
    }
}