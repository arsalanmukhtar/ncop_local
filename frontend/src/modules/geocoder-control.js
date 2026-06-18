// geocoder-control.js
//
// Renders a rail button (`#geocoderToggle`, lucide `map-pin-search`)
// and an attached panel (`#geocoderPanel`) that hosts a Mapbox Geocoder.
// The panel hooks into the existing right-rail-panel system in
// dashboard.js, so it slides in from the right with the same animation
// timing as basemap / layer-order / etc.  Results are limited to 5 and
// constrained to Pakistan; the panel is theme-adaptive via CSS.

import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";

export class GeocoderControl {
  #map;
  #wrapperEl;
  #buttonEl;
  #panelEl;
  #geocoder;

  constructor(map) {
    this.#map = map;
    this.#renderButton();
    this.#renderPanel();
    this.#wireToggle();
  }

  #renderButton() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;
    if (document.getElementById("geocoderToggle")) return;

    this.#wrapperEl = document.createElement("div");
    this.#wrapperEl.className = "custom-geocoder-control";
    // The installed `lucide@^0.546` package does not ship a
    // `map-pin-search` glyph (only `map-pin-*` and `*-search` exist
    // separately).  Fall back to `search` which is universal — still
    // semantically correct as the rail's location-search affordance.
    this.#wrapperEl.innerHTML = `
      <button id="geocoderToggle" class="custom-geocoder-btn"
              type="button" title="Search Location">
        <i data-lucide="search"></i>
      </button>
    `;
    mapContainer.appendChild(this.#wrapperEl);

    if (window.lucide?.createIcons) window.lucide.createIcons();

    this.#buttonEl = this.#wrapperEl.querySelector("#geocoderToggle");
  }

  #renderPanel() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;
    if (document.getElementById("geocoderPanel")) return;

    this.#panelEl = document.createElement("div");
    this.#panelEl.id = "geocoderPanel";
    // Pre-stamp `.right-rail-panel` so the slide-out / hidden state
    // applies on page load — otherwise the panel flashes visible
    // briefly before buildUnifiedRightRail() adds the class.
    this.#panelEl.className = "geocoder-panel right-rail-panel";
    mapContainer.appendChild(this.#panelEl);

    this.#geocoder = new MapboxGeocoder({
      accessToken: window.mapboxgl?.accessToken,
      mapboxgl: window.mapboxgl,
      placeholder: "Search location",
      limit: 5,
      countries: "pk",
      marker: true,
      collapsed: false,
      clearOnBlur: false,
      clearAndBlurOnEsc: true,
    });

    this.#panelEl.appendChild(this.#geocoder.onAdd(this.#map));

    // Selecting a result auto-closes the panel for a clean flow.
    this.#geocoder.on("result", () => this.#close());
  }

  #wireToggle() {
    if (!this.#buttonEl || !this.#panelEl) return;

    this.#buttonEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !this.#panelEl.classList.contains("visible");
      // Mutual exclusivity — close other rail panels before opening.
      this.#closeOtherRailPanels();
      this.#panelEl.classList.toggle("visible", willOpen);
      this.#buttonEl.classList.toggle("active-geocoder", willOpen);

      if (willOpen) {
        // Focus the input shortly after the slide-in starts.
        setTimeout(() => {
          this.#panelEl
            .querySelector(".mapboxgl-ctrl-geocoder--input")
            ?.focus();
        }, 120);
      }
    });
  }

  #close() {
    this.#panelEl?.classList.remove("visible");
    this.#buttonEl?.classList.remove("active-geocoder");
  }

  #closeOtherRailPanels() {
    const others = [
      ["userPanel", "user-panel-visible"],
      ["basemapPanel", "visible"],
      ["projectionPanel", "visible"],
      ["layerOrderPanel", "visible"],
      ["layerStylePanel", "visible"],
      ["layerInfoPanel", "visible"],
      ["ncopTourPanel", "visible"],
    ];
    others.forEach(([id, cls]) => {
      document.getElementById(id)?.classList.remove(cls);
    });
  }
}
