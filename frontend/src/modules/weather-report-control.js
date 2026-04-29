// weather-report-control.js
// =========================================================================
// District-level Weather Report
// -------------------------------------------------------------------------
// Adds a rail button + slide-from-right panel that, when open, renders a
// dynamic per-district summary of the *currently active* temporal Meteoblue
// layer. The slider value, the active layer key, and the visibility of the
// district / provincial boundary layers are all read at render time, so
// the panel automatically reflects whatever the user has playing on the
// slider.
//
// Performance notes:
//   - Render is gated on .visible — when the panel is closed, no work runs.
//   - The slider input event is debounced via requestAnimationFrame, so
//     dragging the slider produces at most one render per frame.
//   - District + province features are pulled with a single
//     queryRenderedFeatures call each, then cached for the render pass.
//   - We dedupe districts by name and skip districts whose centroid isn't
//     covered by the active vector layer (no signal → not in report).
// =========================================================================

const PANEL_ID = "weatherReportPanel";
const BTN_ID = "weatherReportToggle";

// =========================================================================
// Researched thresholds (single source of truth)
// -------------------------------------------------------------------------
// Sources: WHO 2021 Air Quality Guidelines, US EPA AQI breakpoints, IMD/PMD
// rainfall classifications, Pakistan Met Department heat advisories.  These
// are intentionally hard-coded so the report's "alert" semantics stay
// stable across deployments.  Tuning a value? Edit it here and grep for
// the kind to find every renderer using it.
// =========================================================================
const T = {
  // Temperature (°C) — PMD heat advisory ladder. >=40 starts being
  // dangerous in the Indus plains; >=42 is extreme.  Cold side: -15 is
  // rare in Pakistan but flagged for high-altitude regions.
  TEMP_HOT: 42,
  TEMP_COLD: -15,
  STATION_TEMP_HOT: 40, // tighter for in-situ readings (station accuracy)

  // Precipitation (mm) — IMD/PMD daily classifications.  Hourly is much
  // tighter because intense bursts cause flash flooding.
  RAIN_HOURLY_HEAVY: 10,
  RAIN_DAILY_HEAVY: 50, // daily rainfall classified "heavy"
  RAIN_WEEKLY_HEAVY: 100, // weekly accumulation flag
  RAIN_STATION_ALERT: 25, // station hourly accumulation alert

  // Snowfall (mm liquid-water-equivalent) — daily totals.
  SNOW_HOURLY_HEAVY: 5,
  SNOW_DAILY_HEAVY: 30,

  // Convection / severe weather (J/kg)
  CAPE_ALERT: 1000, // moderate-to-severe instability
  HELICITY_ALERT: 300, // tornadic supercell potential

  // Air Quality Index (US EPA scale) — 101 is the "Unhealthy for Sensitive
  // Groups" threshold; many public-health bodies issue advisories at 101+.
  AQI_USG: 101,
  AQI_UNHEALTHY: 151,

  // Pollutant concentrations (µg/m³) — WHO 2021 24-hour guideline values.
  // Alerts fire when concentrations exceed the WHO target by a margin that
  // typical EU/EPA standards use as their hard limit.
  PM25_ALERT: 35,
  PM10_ALERT: 100,
  NO2_ALERT: 40,
  SO2_ALERT: 75,
  CO_ALERT: 10000, // = 10 mg/m³, EPA 8-h alert level

  // Aerosol products
  DUST_ALERT: 200, // µg/m³, heavy dust event
  AOD_ALERT: 0.5, // unitless, visibility/health concern
};

// Map of temporal layer key → { kind, label, sourceLayers[] }.  `kind`
// drives signal interpretation (rainfall vs snowfall vs temperature etc.).
// `sourceLayers` lists the mapbox vector "source-layer" names whose
// features hold the numeric reading on the `minValue` property.
const LAYER_KIND_MAP = {
  weekly_precipitation_2m_above_ground: {
    kind: "precipitation",
    label: "Weekly Precipitation",
    sourceLayers: ["precip", "snow"],
    cadence: "weekly",
  },
  hourly_precipitation_2m_above_ground: {
    kind: "precipitation",
    label: "Hourly Precipitation",
    sourceLayers: ["precip", "layerSnow"],
    cadence: "hourly",
  },
  hourly_snowfall_forecast: {
    kind: "snowfall",
    label: "Hourly Snowfall",
    sourceLayers: ["snow"],
    cadence: "hourly",
  },
  weekly_snowfall_forecast: {
    kind: "snowfall",
    label: "Weekly Snowfall",
    sourceLayers: ["snow"],
    cadence: "weekly",
  },
  cape_hourly_forecast: {
    kind: "cape",
    label: "CAPE (Hourly)",
    sourceLayers: ["layerCAPEInternal"],
    cadence: "hourly",
  },
  cape_weekly_forecast: {
    kind: "cape",
    label: "CAPE (Weekly)",
    sourceLayers: ["layerCAPEInternal"],
    cadence: "weekly",
  },
  storm_helicity_forecast_0_3km: {
    kind: "storm_helicity",
    label: "Storm Helicity 0–3 km",
    sourceLayers: ["stormhelicityColortable"],
    cadence: "hourly",
  },
  temperature_2m_above_ground: {
    kind: "temperature",
    label: "Temperature (2 m)",
    sourceLayers: ["temperatureColortable"],
    cadence: "hourly",
  },
  precipitation_radar: {
    kind: "raster",
    label: "Precipitation Radar",
    sourceLayers: [],
    cadence: "hourly",
  },

  // ---- Meteoblue Air-Quality Forecast (hourly + daily variants) ---------
  cams_air_quality_index_hourly: {
    kind: "aqi",
    label: "AQI (Hourly)",
    sourceLayers: ["aqiColortable"],
    cadence: "hourly",
  },
  cams_air_quality_index_daily: {
    kind: "aqi",
    label: "AQI (Daily)",
    sourceLayers: ["aqiColortable"],
    cadence: "daily",
  },
  cams_desert_dust_hourly: {
    kind: "desert_dust",
    label: "Desert Dust (Hourly)",
    sourceLayers: ["desertDust"],
    cadence: "hourly",
  },
  cams_desert_dust_daily: {
    kind: "desert_dust",
    label: "Desert Dust (Daily)",
    sourceLayers: ["desertDust"],
    cadence: "daily",
  },
  cams_aerosol_optical_depth_hourly: {
    kind: "aod",
    label: "AOD (Hourly)",
    sourceLayers: ["aod"],
    cadence: "hourly",
  },
  cams_aerosol_optical_depth_daily: {
    kind: "aod",
    label: "AOD (Daily)",
    sourceLayers: ["aod"],
    cadence: "daily",
  },
  cams_nitrogen_dioxide_daily: {
    kind: "no2",
    label: "NO₂ (Daily)",
    sourceLayers: ["no2"],
    cadence: "daily",
  },
  cams_carbon_monoxide_daily: {
    kind: "co",
    label: "CO (Daily)",
    sourceLayers: ["COColorTable"],
    cadence: "daily",
  },
  cams_sulphur_dioxide_daily: {
    kind: "so2",
    label: "SO₂ (Daily)",
    sourceLayers: ["so2"],
    cadence: "daily",
  },
};

// =========================================================================
// Station-based sources — driven by the "toggle on AND visible" rule, not
// by the temporal slider.  When no temporal layer is active, the highest-
// priority visible station feeds the report.  Even when a temporal IS
// active, stations can enrich each district card with additional readings
// (rendered as small tags below the primary reading).
// =========================================================================
const STATION_KIND_MAP = {
  // WAQI air-quality station network — `aqi` is the primary numeric.
  waqi_stations: {
    kind: "aqi",
    label: "WAQI Stations",
    layerIds: ["waqi_stations-circle"],
    valueProp: "aqi",
  },
  // PMD MET monitoring rainfall — symbol layer; `rainfall` is the metric
  // that drives the rain-vs-sun icon split in the layer's own styling.
  pmd_weather_stations: {
    kind: "rainfall_station",
    label: "PMD Weather Stations",
    layerIds: [
      "pmd_weather_stations-sun-symbol",
      "pmd_weather_stations-rain-symbol",
    ],
    valueProp: "rainfall",
  },
  // Heatwave city points — `temperature` (°C) drives circle color/size.
  // Uses `temperature_station` (a station-tightened variant of the
  // `temperature` kind) so the threshold is the EPA station-accuracy
  // value (T.STATION_TEMP_HOT = 40 °C) instead of the looser 42 °C
  // forecast threshold.  Symmetric with rainfall_station vs
  // precipitation in the temporal kinds.
  heatwave_monitoring: {
    kind: "temperature_station",
    label: "Heatwave Monitoring",
    layerIds: ["heatwave_monitoring-circle"],
    valueProp: "temperature",
  },
};

// Property keys we'll search across for district / province names. The
// boundary tiles come from GeoServer (gcop:district_boundary,
// gcop:provincial_boundary) and the canonical key may vary by deployment.
const DISTRICT_NAME_KEYS = [
  "name",
  "NAME",
  "district",
  "district_name",
  "districtname",
  "DISTRICT",
  "DISTRICT_NAME",
];
const PROVINCE_NAME_KEYS = [
  "name",
  "NAME",
  "province",
  "province_name",
  "provincename",
  "PROVINCE",
  "PROVINCE_NAME",
  "admin1",
  "ADM1_EN",
  "prov_name",
];

const DISTRICT_LAYER_IDS = [
  "district_boundary-fill",
  "district_boundary-outline",
];
const PROVINCE_LAYER_IDS = [
  "provincial_boundary-fill",
  "provincial_boundary-outline",
];

export class WeatherReportControl {
  #map;
  #panelEl = null;
  #btnEl = null;
  #contentEl = null;
  #footerEl = null;
  #subtitleEl = null;
  #titleEl = null;
  #thresholdEl = null;
  #thresholdValueEl = null;

  // Throttle bookkeeping. `#renderTimerId` covers both rAF and setTimeout
  // ids so we have a single "is a render queued" flag to check.
  #renderTimerId = null;
  #lastRenderAt = 0;

  // Skip-redundant-render fingerprint. Each render computes a string
  // describing its inputs (active layer + step + viewport bounds + which
  // station layers are visible).  If the new fingerprint matches the
  // last AND the last render produced a real report (not a loading /
  // empty state), we skip — district queries + per-feature sampling is
  // the app's hottest cost path.  The `lastRenderComplete` gate prevents
  // us from getting stuck on a "Fetching results…" spinner once tiles
  // arrive (because tile-load events don't change the fingerprint).
  #lastFingerprint = "";
  #lastRenderComplete = false;

  // Listeners are wired only while the panel is open.  Closing the panel
  // detaches them so the cost of every map idle / slider input / DOM
  // mutation drops to zero when the user isn't looking at the report.
  #observer = null;
  #boundOnSliderInput = null;
  #boundOnTemporalDom = null;
  #boundOnMapMove = null;
  #boundOnMapIdle = null;
  #listenersAttached = false;

  constructor(map) {
    this.#map = map;
    this.#render();
    this.#wireToggle();
    // Listeners attach lazily on panel open — see #attachListeners.
  }

  // -------------------------------------------------------------- DOM build
  #render() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    // Button — wrapper div mirrors the LayerStyleConfig pattern so the
    // unified rail picker (`buildUnifiedRightRail`) finds it via class.
    const wrapper = document.createElement("div");
    wrapper.className = "custom-weather-report-control";
    wrapper.innerHTML = `
      <button id="${BTN_ID}" class="custom-weather-report-btn" type="button"
              title="Weather Report">
        <i data-lucide="clipboard-list"></i>
      </button>
    `;
    mapContainer.appendChild(wrapper);
    this.#btnEl = wrapper.querySelector(`#${BTN_ID}`);

    // Panel
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "weather-report-panel";
    panel.innerHTML = `
      <div class="wrp-header">
        <div class="wrp-header-text">
          <h3 class="wrp-title">Weather Report</h3>
          <p class="wrp-subtitle">Enable a temporal layer to begin</p>
          <p class="wrp-threshold" hidden>
            <span class="wrp-threshold-label">Alert threshold:</span>
            <span class="wrp-threshold-value"></span>
          </p>
        </div>
        <button class="wrp-close-btn" type="button" title="Close" aria-label="Close">
          <i data-lucide="x"></i>
        </button>
      </div>
      <div class="wrp-body" id="weatherReportBody"></div>
      <div class="wrp-footer" id="weatherReportFooter"></div>
    `;
    mapContainer.appendChild(panel);
    this.#panelEl = panel;
    this.#contentEl = panel.querySelector("#weatherReportBody");
    this.#footerEl = panel.querySelector("#weatherReportFooter");
    this.#titleEl = panel.querySelector(".wrp-title");
    this.#subtitleEl = panel.querySelector(".wrp-subtitle");
    this.#thresholdEl = panel.querySelector(".wrp-threshold");
    this.#thresholdValueEl = panel.querySelector(".wrp-threshold-value");

    // Lucide icons get rendered by the global init pass; nudge it in case
    // we're mounted after the initial pass.
    if (window.lucide?.createIcons) window.lucide.createIcons();

    // ONE delegated handler for the entire body — survives every render
    // (innerHTML changes don't drop listeners on the parent).  Reads
    // `data-fly-bbox` off the closest ancestor and flies the map to
    // that bbox.  No per-card listeners → zero per-render setup cost.
    const flyHandler = (ev) => {
      // Keyboard activation: only fire on Enter/Space, never block other keys.
      if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") {
        return;
      }
      const target = ev.target.closest("[data-fly-bbox]");
      if (!target) return;
      const raw = target.getAttribute("data-fly-bbox");
      if (!raw) return;
      const [w, s, e, n] = raw.split(",").map(Number);
      if (![w, s, e, n].every(Number.isFinite)) return;
      ev.preventDefault();
      try {
        this.#map.fitBounds(
          [
            [w, s],
            [e, n],
          ],
          { padding: 60, duration: 900, maxZoom: 10 }
        );
      } catch (err) {
        console.warn("[WeatherReport] fitBounds failed:", err);
      }
    };
    this.#contentEl.addEventListener("click", flyHandler);
    this.#contentEl.addEventListener("keydown", flyHandler);
  }

  #wireToggle() {
    if (!this.#btnEl || !this.#panelEl) return;

    this.#btnEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = !this.#panelEl.classList.contains("visible");
      this.#panelEl.classList.toggle("visible", willOpen);
      this.#btnEl.classList.toggle("active-weather-report", willOpen);
      if (willOpen) {
        this.#attachListeners();
        this.#scheduleRender();
      } else {
        this.#detachListeners();
      }
    });

    const closeBtn = this.#panelEl.querySelector(".wrp-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#panelEl.classList.remove("visible");
        this.#btnEl.classList.remove("active-weather-report");
        this.#detachListeners();
      });
    }
  }

  // -------------------------------------------------------------- reactivity
  // Listeners attach lazily on panel open and detach on close so we
  // don't pay any cost for slider drags / map idles / DOM mutations
  // while the user is doing something else.  This was the dominant
  // source of lag before — multi-Hz mutation events were waking up the
  // throttle even when the panel was hidden.
  #attachListeners() {
    if (this.#listenersAttached) return;
    this.#listenersAttached = true;
    // Force the next render to do real work even if state hasn't
    // technically changed since the last time the panel was open.
    this.#lastFingerprint = "";
    this.#lastRenderComplete = false;

    // Slider input → step changes. Throttled via #scheduleRender so
    // dragging at 60Hz collapses to ~6 renders/sec.
    this.#boundOnSliderInput = () => this.#scheduleRender();
    const slider = document.getElementById("slider1");
    if (slider) slider.addEventListener("input", this.#boundOnSliderInput);

    // Narrow MutationObserver — was previously watching subtree +
    // characterData which fired ~60Hz during slider play (every label /
    // active-step class change).  We only actually need to know when
    // the slider element's style attribute flips display:none↔block
    // (layer activation) or its class changes — both are on
    // #temp-slider1 itself, no subtree needed.
    const tempSlider = document.getElementById("temp-slider1");
    if (tempSlider) {
      this.#boundOnTemporalDom = () => this.#scheduleRender();
      this.#observer = new MutationObserver(this.#boundOnTemporalDom);
      this.#observer.observe(tempSlider, {
        attributes: true,
        attributeFilter: ["style", "class"],
        childList: false,
        subtree: false,
        characterData: false,
      });
    }

    // Pan / zoom changes the visible districts.
    this.#boundOnMapMove = () => this.#scheduleRender();
    this.#map.on("moveend", this.#boundOnMapMove);

    // `idle` fires when tiles/animations settle — flips the loading
    // spinner state once data lands.  Throttle prevents it from over-
    // rendering during normal map operation.
    this.#boundOnMapIdle = () => this.#scheduleRender();
    this.#map.on("idle", this.#boundOnMapIdle);
  }

  #detachListeners() {
    if (!this.#listenersAttached) return;
    this.#listenersAttached = false;

    if (this.#renderTimerId != null) {
      clearTimeout(this.#renderTimerId);
      this.#renderTimerId = null;
    }

    const slider = document.getElementById("slider1");
    if (slider && this.#boundOnSliderInput) {
      slider.removeEventListener("input", this.#boundOnSliderInput);
    }
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    if (this.#boundOnMapMove) {
      this.#map.off("moveend", this.#boundOnMapMove);
    }
    if (this.#boundOnMapIdle) {
      this.#map.off("idle", this.#boundOnMapIdle);
    }
    this.#boundOnSliderInput = null;
    this.#boundOnTemporalDom = null;
    this.#boundOnMapMove = null;
    this.#boundOnMapIdle = null;
  }

  #isOpen() {
    return this.#panelEl?.classList.contains("visible") === true;
  }

  // Time-based throttle: guarantee at least 150ms between renders.
  // Multiple calls inside the window collapse into a single trailing
  // render when the window expires.  This was previously rAF-only,
  // which means each frame of slider drag (60Hz) triggered a fresh
  // render — way too much for the heavy queryRenderedFeatures /
  // per-district sampling work the report does.
  #scheduleRender() {
    if (!this.#isOpen()) return;
    if (this.#renderTimerId != null) return; // already queued

    const RENDER_MIN_INTERVAL_MS = 150;
    const wait = Math.max(
      0,
      RENDER_MIN_INTERVAL_MS - (performance.now() - this.#lastRenderAt)
    );

    this.#renderTimerId = setTimeout(() => {
      this.#renderTimerId = null;
      if (!this.#isOpen()) return;
      this.#lastRenderAt = performance.now();
      try {
        this.#renderReport();
      } catch (e) {
        console.warn("[WeatherReport] render failed:", e);
      }
    }, wait);
  }

  // -------------------------------------------------------------- engine
  // Cheap fingerprint of every input that affects the rendered report.
  // If unchanged from the last render, we skip the heavy district +
  // per-feature sampling work entirely — this is the hottest cost path
  // when the panel is open (queryRenderedFeatures is called once per
  // district in the worst case).  A pan that doesn't actually change
  // which districts are visible (e.g. scrolling within the same admin
  // unit) results in a no-op render even though `moveend` fires.
  #computeFingerprint(state, activeStations) {
    const b = this.#map.getBounds?.();
    const zoom = this.#map.getZoom?.();
    // Round bounds so micro-pans don't change the fingerprint.
    const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "");
    const bbox = b
      ? `${fmt(b.getWest())},${fmt(b.getSouth())},${fmt(b.getEast())},${fmt(b.getNorth())}`
      : "";
    return [
      state.layerKey || "",
      state.currentIndex || 0,
      state.date || "",
      activeStations.join("|"),
      bbox,
      typeof zoom === "number" ? zoom.toFixed(2) : "",
    ].join("§");
  }

  #renderReport() {
    const state = window.getCurrentTemporalState
      ? window.getCurrentTemporalState()
      : { layerKey: null, currentEntry: null, date: "", currentIndex: 0 };

    const layerKey = state.layerKey;
    const tempMeta = layerKey ? LAYER_KIND_MAP[layerKey] : null;
    const activeStations = this.#activeStationKeys();
    const fallbackStationKey = activeStations[0] || null;
    const fallbackStationMeta = fallbackStationKey
      ? STATION_KIND_MAP[fallbackStationKey]
      : null;

    // Skip redundant work: if every input is identical AND the last
    // render produced a real report (not loading / empty), bail.
    const fp = this.#computeFingerprint(state, activeStations);
    if (fp === this.#lastFingerprint && this.#lastRenderComplete) return;
    this.#lastFingerprint = fp;
    this.#lastRenderComplete = false; // flipped to true at the end of a successful row render

    this.#titleEl.textContent = "Weather Report";

    // ----- No data sources at all ---------------------------------------
    if (!tempMeta && !fallbackStationMeta) {
      this.#clearThreshold();
      this.#subtitleEl.textContent =
        "Enable any temporal weather or station layer to generate a report.";
      this.#renderEmpty(
        "No active layer",
        "Toggle a Meteoblue temporal layer or a station layer (WAQI, PMD Weather Stations, Heatwave Monitoring) to populate the report."
      );
      return;
    }

    // Active raster temporal can't be sampled per-district — but if a
    // station is also visible, fall through to station-only mode rather
    // than dead-end.  Without a station, surface the raster-only message.
    if (tempMeta && tempMeta.kind === "raster" && !fallbackStationMeta) {
      this.#applyThreshold(tempMeta);
      this.#subtitleEl.textContent = `${tempMeta.label} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        `${tempMeta.label} is raster-only`,
        "Per-district readings are not available for radar tiles. Switch to a vector temporal layer or enable a station layer (WAQI / PMD / Heatwave) to see district aggregations."
      );
      return;
    }

    // ----- Boundary layer gating ----------------------------------------
    const districtVisible = this.#anyLayerVisible(DISTRICT_LAYER_IDS);
    const provinceVisible = this.#anyLayerVisible(PROVINCE_LAYER_IDS);
    if (!districtVisible || !provinceVisible) {
      const lbl = tempMeta?.label || fallbackStationMeta?.label || "";
      this.#subtitleEl.textContent = `${lbl} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "Boundaries required",
        "Enable both <b>District Boundary</b> and <b>Provincial Boundary</b> in the sidebar to generate the per-district report."
      );
      return;
    }

    // ----- Determine the *primary* sampling mode ------------------------
    // Active vector temporal wins; otherwise the highest-priority visible
    // station drives the report.  Either way the same district loop below
    // runs and ends up writing into the same `rows` shape.
    const isTemporalPrimary =
      !!tempMeta && tempMeta.kind !== "raster";
    const primaryMeta = isTemporalPrimary ? tempMeta : fallbackStationMeta;
    const primarySubtitleLabel = primaryMeta?.label || "";
    // Show the alert threshold for the chosen primary so the user can
    // see at a glance what bar a card has to clear to flip into red.
    this.#applyThreshold(primaryMeta);

    // For temporal mode, resolve frame layer IDs and verify sources are loaded.
    let targetLayerIds = [];
    if (isTemporalPrimary) {
      const frame = state.currentEntry;
      targetLayerIds = (frame?.layers || [])
        .map((l) => l.id)
        .filter((id) => this.#map.getLayer(id))
        .filter((id) => {
          const lyr = this.#map.getLayer(id);
          if (!lyr) return false;
          if (lyr.type === "raster") return false;
          const sl = lyr["source-layer"] || lyr.sourceLayer;
          return (
            tempMeta.sourceLayers.length === 0 ||
            tempMeta.sourceLayers.includes(sl)
          );
        });

      if (!targetLayerIds.length) {
        this.#subtitleEl.textContent = `${primarySubtitleLabel} · ${state.date || "Current step"}`;
        this.#renderLoading();
        return;
      }

      const frameSourceIds = this.#frameSourceIds(frame);
      if (
        frameSourceIds.length &&
        !frameSourceIds.every((id) => this.#sourceIsLoaded(id))
      ) {
        this.#subtitleEl.textContent = `${primarySubtitleLabel} · ${state.date || "Current step"}`;
        this.#renderLoading();
        return;
      }
    } else {
      // Station-only mode: gate on the chosen station's source being loaded.
      const stationLayerIds = fallbackStationMeta.layerIds.filter((id) =>
        this.#map.getLayer(id)
      );
      if (!stationLayerIds.length) {
        this.#subtitleEl.textContent = `${primarySubtitleLabel}`;
        this.#renderLoading();
        return;
      }
      // GeoJSON sources load fast but can be in flight on first paint.
      const sourceIds = stationLayerIds
        .map((id) => this.#map.getLayer(id)?.source)
        .filter(Boolean);
      if (
        sourceIds.length &&
        !sourceIds.every((sid) => this.#sourceIsLoaded(sid))
      ) {
        this.#subtitleEl.textContent = `${primarySubtitleLabel}`;
        this.#renderLoading();
        return;
      }
    }

    // ----- Query districts in viewport ----------------------------------
    // Query only the FILL layer — outline shares the same source so the
    // outline query would just return duplicate features which we'd then
    // dedupe.  One query, half the work.
    const districtQueryLayers = DISTRICT_LAYER_IDS.filter((id) =>
      this.#map.getLayer(id)
    ).slice(0, 1); // prefer the fill layer (first in the constant)
    const districtFeatures = this.#dedupedFeaturesByName(
      this.#map.queryRenderedFeatures({ layers: districtQueryLayers }),
      DISTRICT_NAME_KEYS
    );

    if (!districtFeatures.length) {
      this.#subtitleEl.textContent = `${primarySubtitleLabel} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "No districts in view",
        "Pan or zoom so district polygons are visible, then the report will populate."
      );
      return;
    }

    // Province features are only needed as a *fallback* when a district
    // feature lacks a province name property of its own.  If the very
    // first district carries a recognised province key, every other
    // district in this dataset will too — skip the second viewport
    // query entirely.  Saves one heavy queryRenderedFeatures call per
    // render in the common case.
    const sampleHasProvince = districtFeatures.some((d) =>
      this.#firstProp(d, PROVINCE_NAME_KEYS)
    );
    const provinceFeatures = sampleHasProvince
      ? []
      : this.#dedupedFeaturesByName(
          this.#map.queryRenderedFeatures({
            layers: PROVINCE_LAYER_IDS.filter((id) => this.#map.getLayer(id)).slice(0, 1),
          }),
          PROVINCE_NAME_KEYS
        );

    // Pre-build station feature pools once (cheap viewport queries).
    // Each entry: { metaKey, meta, features[] } — features are picked
    // up by the per-district loop via bbox containment.
    const stationPools = activeStations.map((stKey) => {
      const stMeta = STATION_KIND_MAP[stKey];
      const visibleIds = stMeta.layerIds.filter((id) => this.#map.getLayer(id));
      const features = visibleIds.length
        ? this.#map.queryRenderedFeatures({ layers: visibleIds })
        : [];
      return { metaKey: stKey, meta: stMeta, features };
    });

    // ----- Sample each district -----------------------------------------
    const rows = [];
    for (const district of districtFeatures) {
      const districtName = this.#firstProp(district, DISTRICT_NAME_KEYS);
      if (!districtName) continue;

      const center = this.#featureCenter(district);
      if (!center) continue;

      const provinceName =
        this.#firstProp(district, PROVINCE_NAME_KEYS) ||
        this.#provinceForCenter(center, provinceFeatures) ||
        "Unknown";

      // Primary reading (temporal sample, or station aggregation if no temporal).
      let primaryReading = null;
      if (isTemporalPrimary) {
        const sampled = this.#sampleAt(center, targetLayerIds);
        primaryReading = this.#aggregateReading(sampled, tempMeta.kind, tempMeta);
      } else {
        // Station-as-primary: collect station features whose point lies
        // inside the district bbox, aggregate via the station's valueProp.
        const inside = this.#stationsInDistrict(district, fallbackStationMeta, [
          {
            metaKey: fallbackStationKey,
            meta: fallbackStationMeta,
            features: stationPools.find(
              (p) => p.metaKey === fallbackStationKey
            )?.features || [],
          },
        ]);
        if (inside.length) {
          primaryReading = this.#aggregateReading(
            inside,
            fallbackStationMeta.kind,
            fallbackStationMeta,
            { valueProp: fallbackStationMeta.valueProp }
          );
        }
      }

      // Extras: every OTHER active station that has features inside this
      // district contributes a tag-style reading.  Skip the primary
      // station to avoid duplicate readings when in station-only mode.
      const extras = [];
      for (const pool of stationPools) {
        if (!isTemporalPrimary && pool.metaKey === fallbackStationKey) continue;
        const inside = this.#stationsInDistrict(district, pool.meta, [pool]);
        if (!inside.length) continue;
        const r = this.#aggregateReading(
          inside,
          pool.meta.kind,
          pool.meta,
          { valueProp: pool.meta.valueProp }
        );
        if (r) extras.push({ source: pool.meta.label, ...r });
      }

      if (!primaryReading && !extras.length) continue;

      // Cache the district's bbox here so the per-card click handler can
      // fly to it without re-querying the source feature on click.
      const bbox = this.#featureBbox(district);

      rows.push({
        district: districtName,
        province: provinceName,
        bbox,
        // If the primary slot is empty (no temporal sample, no station-as-primary
        // hit, but a secondary station got a reading), promote the first extra.
        reading: primaryReading || extras.shift(),
        extras,
      });
    }

    if (!rows.length) {
      this.#subtitleEl.textContent = `${primarySubtitleLabel} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "No signals at current step",
        "The active layer has no readings over the visible districts. Try a different time step or pan to a region with coverage."
      );
      return;
    }

    // Sort by score (severity / magnitude) descending — hotspots first.
    rows.sort((a, b) => b.reading.score - a.reading.score);

    // ----- Render -------------------------------------------------------
    const dateSuffix = isTemporalPrimary && state.date ? ` · ${state.date}` : "";
    this.#subtitleEl.textContent = `${primarySubtitleLabel}${dateSuffix} · ${rows.length} district${rows.length === 1 ? "" : "s"}`;
    this.#renderRows(rows, primaryMeta);
    this.#lastRenderComplete = true;
  }

  // -------------------------------------------------------------- station helpers
  // Which station layers are toggled on AND visible right now?  Returns
  // the keys in priority order (WAQI → PMD → Heatwave) — the first one
  // becomes the fallback when no temporal is active.
  #activeStationKeys() {
    const keys = [];
    for (const key of Object.keys(STATION_KIND_MAP)) {
      const meta = STATION_KIND_MAP[key];
      if (this.#anyLayerVisible(meta.layerIds)) keys.push(key);
    }
    return keys;
  }

  // Filter a pool of station features down to those whose centroid lies
  // inside the district's bbox.  bbox-only PIP is cheap and accurate
  // enough for non-overlapping district polygons.
  #stationsInDistrict(district, _stationMeta, pools) {
    const bbox = this.#featureBbox(district);
    if (!bbox) return [];
    const [minX, minY, maxX, maxY] = bbox;
    const out = [];
    for (const pool of pools || []) {
      for (const f of pool.features || []) {
        const geom = f?.geometry;
        if (!geom) continue;
        // Stations are point geometries — fast path.
        if (geom.type === "Point") {
          const [x, y] = geom.coordinates;
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(f);
          continue;
        }
        // Fallback for non-point: use centroid of feature bbox.
        const c = this.#featureCenter(f);
        if (!c) continue;
        if (c[0] >= minX && c[0] <= maxX && c[1] >= minY && c[1] <= maxY) {
          out.push(f);
        }
      }
    }
    return out;
  }

  // Renders a human-readable description of when this kind/cadence
   // triggers an alert.  Used to populate the "Alert threshold: ..." line
   // at the top of the panel so users know exactly what bar each card has
   // to clear to flip into the red-alert state.
  #thresholdDescription(meta) {
    if (!meta) return "";
    const cadence = meta.cadence || "hourly";
    switch (meta.kind) {
      case "precipitation":
        return cadence === "hourly"
          ? `≥ ${T.RAIN_HOURLY_HEAVY} mm/h rain (or ≥ ${T.SNOW_HOURLY_HEAVY} mm snow)`
          : cadence === "weekly"
            ? `≥ ${T.RAIN_WEEKLY_HEAVY} mm rain (weekly)`
            : `≥ ${T.RAIN_DAILY_HEAVY} mm rain (or ≥ ${T.SNOW_DAILY_HEAVY} mm snow, daily)`;
      case "snowfall":
        return cadence === "hourly"
          ? `≥ ${T.SNOW_HOURLY_HEAVY} mm/h snow`
          : `≥ ${T.SNOW_DAILY_HEAVY} mm snow (daily)`;
      case "cape":
        return `≥ ${T.CAPE_ALERT} J/kg (severe instability)`;
      case "storm_helicity":
        return `≥ ${T.HELICITY_ALERT} J/kg (tornadic potential)`;
      case "temperature":
        return `≥ ${T.TEMP_HOT} °C or ≤ ${T.TEMP_COLD} °C`;
      case "aqi":
        return `AQI ≥ ${T.AQI_USG} (Unhealthy for Sensitive Groups)`;
      case "desert_dust":
        return `≥ ${T.DUST_ALERT} µg/m³ (heavy dust event)`;
      case "aod":
        return `≥ ${T.AOD_ALERT} (heavy aerosol loading)`;
      case "no2":
        return `≥ ${T.NO2_ALERT} µg/m³ NO₂ (WHO 24h alert)`;
      case "co":
        return `≥ ${(T.CO_ALERT / 1000).toFixed(0)} mg/m³ CO (EPA 8h alert)`;
      case "so2":
        return `≥ ${T.SO2_ALERT} µg/m³ SO₂ (WHO 24h alert)`;
      case "rainfall_station":
        return `≥ ${T.RAIN_STATION_ALERT} mm at any station`;
      case "temperature_station":
        return `≥ ${T.STATION_TEMP_HOT} °C at any station (heat advisory)`;
      case "raster":
        return "raster-only (no per-district threshold)";
      default:
        return "";
    }
  }

  #applyThreshold(meta) {
    if (!this.#thresholdEl || !this.#thresholdValueEl) return;
    const text = this.#thresholdDescription(meta);
    if (!text) {
      this.#thresholdEl.hidden = true;
      this.#thresholdValueEl.textContent = "";
      return;
    }
    this.#thresholdValueEl.textContent = text;
    this.#thresholdEl.hidden = false;
  }

  #clearThreshold() {
    if (!this.#thresholdEl) return;
    this.#thresholdEl.hidden = true;
    if (this.#thresholdValueEl) this.#thresholdValueEl.textContent = "";
  }

  #featureBbox(feature) {
    const geom = feature?.geometry;
    if (!geom) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const visit = (coords) => {
      if (typeof coords[0] === "number") {
        const [x, y] = coords;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        return;
      }
      for (const c of coords) visit(c);
    };
    try {
      visit(geom.coordinates);
    } catch {
      return null;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    return [minX, minY, maxX, maxY];
  }

  // -------------------------------------------------------------- helpers
  #anyLayerVisible(ids) {
    for (const id of ids) {
      if (!this.#map.getLayer(id)) continue;
      const vis = this.#map.getLayoutProperty(id, "visibility");
      if (vis !== "none") return true;
    }
    return false;
  }

  #firstProp(feature, keys) {
    const p = feature?.properties || {};
    for (const k of keys) {
      const v = p[k];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  }

  #dedupedFeaturesByName(features, nameKeys) {
    const seen = new Set();
    const out = [];
    for (const f of features || []) {
      const name = this.#firstProp(f, nameKeys);
      if (!name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(f);
    }
    return out;
  }

  // Cheap centroid via bbox midpoint — exact polygon centroid would need
  // turf.centroid; bbox midpoint is good enough for sampling vector tiles.
  #featureCenter(feature) {
    const geom = feature?.geometry;
    if (!geom) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const visit = (coords) => {
      if (typeof coords[0] === "number") {
        const [x, y] = coords;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        return;
      }
      for (const c of coords) visit(c);
    };
    try {
      visit(geom.coordinates);
    } catch {
      return null;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  #provinceForCenter(center, provinceFeatures) {
    // bbox-only fallback (cheap, no turf dependency). Returns the first
    // province whose bbox contains `center` — accurate enough since
    // Pakistan provinces don't bbox-overlap meaningfully at this scale.
    for (const f of provinceFeatures) {
      const c = this.#featureCenter(f);
      if (!c) continue;
      const geom = f.geometry;
      if (!geom) continue;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      const visit = (coords) => {
        if (typeof coords[0] === "number") {
          const [x, y] = coords;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          return;
        }
        for (const cc of coords) visit(cc);
      };
      try {
        visit(geom.coordinates);
      } catch {
        continue;
      }
      const [cx, cy] = center;
      if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) {
        return this.#firstProp(f, PROVINCE_NAME_KEYS);
      }
    }
    return null;
  }

  #sampleAt(lngLat, layerIds) {
    if (!layerIds.length) return [];
    try {
      const point = this.#map.project(lngLat);
      return this.#map.queryRenderedFeatures(point, { layers: layerIds });
    } catch {
      return [];
    }
  }

  // Aggregate a list of features down to one reading with kind-specific
  // labelling + alert flag.  Thresholds live in the `T` constant block at
  // the top of the file so the rules are auditable in one place.  `meta`
  // is the LAYER_KIND_MAP / STATION_KIND_MAP entry — its `cadence` field
  // (hourly vs daily vs weekly) lets us pick the right rainfall threshold
  // tier from the same shared set.
  #aggregateReading(features, kind, meta = {}, opts = {}) {
    if (!features.length) return null;
    const valueProp = opts.valueProp || "minValue";
    let best = -Infinity;
    let bestSourceLayer = "";
    for (const f of features) {
      const v = Number(f?.properties?.[valueProp]);
      if (!Number.isFinite(v)) continue;
      if (v > best) {
        best = v;
        bestSourceLayer = f.layer?.["source-layer"] || f.sourceLayer || "";
      }
    }
    if (!Number.isFinite(best)) return null;

    const cadence = meta.cadence || opts.cadence || "hourly";
    let label = "";
    let unit = "";
    let alert = false;
    let score = Math.abs(best);

    switch (kind) {
      case "precipitation": {
        unit = "mm";
        const isSnow =
          bestSourceLayer === "snow" || bestSourceLayer === "layerSnow";
        if (isSnow) {
          label = `Snow ${best.toFixed(1)} ${unit}`;
          alert =
            cadence === "hourly"
              ? best >= T.SNOW_HOURLY_HEAVY
              : best >= T.SNOW_DAILY_HEAVY;
        } else {
          label = `Rain ${best.toFixed(1)} ${unit}`;
          // Tier the rain alert by cadence so an hourly burst and a
          // weekly accumulation aren't held to the same number.
          alert =
            cadence === "hourly"
              ? best >= T.RAIN_HOURLY_HEAVY
              : cadence === "weekly"
                ? best >= T.RAIN_WEEKLY_HEAVY
                : best >= T.RAIN_DAILY_HEAVY;
        }
        score = best;
        break;
      }
      case "snowfall":
        unit = "mm";
        label = `Snow ${best.toFixed(1)} ${unit}`;
        alert =
          cadence === "hourly"
            ? best >= T.SNOW_HOURLY_HEAVY
            : best >= T.SNOW_DAILY_HEAVY;
        score = best;
        break;
      case "cape":
        unit = "J/kg";
        label = `CAPE ${best.toFixed(0)} ${unit}`;
        alert = best >= T.CAPE_ALERT;
        score = best;
        break;
      case "storm_helicity":
        unit = "J/kg";
        label = `Helicity ${best.toFixed(0)} ${unit}`;
        alert = best >= T.HELICITY_ALERT;
        score = best;
        break;
      case "temperature":
        unit = "°C";
        label = `Temp ${best >= 0 ? "+" : ""}${best.toFixed(1)} ${unit}`;
        alert = best >= T.TEMP_HOT || best <= T.TEMP_COLD;
        score = Math.abs(best);
        break;
      // ---- Air-quality kinds ----------------------------------------
      case "aqi":
        unit = "AQI";
        label = `AQI ${best.toFixed(0)}`;
        alert = best >= T.AQI_USG;
        score = best;
        break;
      case "desert_dust":
        unit = "µg/m³";
        label = `Dust ${best.toFixed(0)} ${unit}`;
        alert = best >= T.DUST_ALERT;
        score = best;
        break;
      case "aod":
        unit = "";
        label = `AOD ${best.toFixed(2)}`;
        alert = best >= T.AOD_ALERT;
        score = best;
        break;
      case "no2":
        unit = "µg/m³";
        label = `NO₂ ${best.toFixed(0)} ${unit}`;
        alert = best >= T.NO2_ALERT;
        score = best;
        break;
      case "co":
        unit = "µg/m³";
        label = `CO ${best.toFixed(0)} ${unit}`;
        alert = best >= T.CO_ALERT;
        score = best;
        break;
      case "so2":
        unit = "µg/m³";
        label = `SO₂ ${best.toFixed(0)} ${unit}`;
        alert = best >= T.SO2_ALERT;
        score = best;
        break;
      // ---- Station-only kinds ---------------------------------------
      case "rainfall_station":
        unit = "mm";
        label = `Rain ${best.toFixed(1)} ${unit}`;
        alert = best >= T.RAIN_STATION_ALERT;
        score = best;
        break;
      case "temperature_station":
        // Tighter threshold than the `temperature` (forecast) kind —
        // station readings are point measurements with higher accuracy
        // and Pakistan heat-warning protocols flag at ≥ 40 °C.
        unit = "°C";
        label = `Temp ${best >= 0 ? "+" : ""}${best.toFixed(1)} ${unit}`;
        alert = best >= T.STATION_TEMP_HOT || best <= T.TEMP_COLD;
        score = Math.abs(best);
        break;
      default:
        label = `${best.toFixed(1)}`;
        alert = false;
    }
    return { value: best, label, alert, score, unit };
  }

  // -------------------------------------------------------------- HTML out
  #renderEmpty(title, body) {
    this.#contentEl.innerHTML = `
      <div class="wrp-empty">
        <h4>${escapeHtml(title)}</h4>
        <p>${body}</p>
      </div>
    `;
    // Empty state has no report → clear footer so the chrome strip
    // collapses out of view.
    if (this.#footerEl) {
      this.#footerEl.innerHTML = "";
      this.#footerEl.classList.remove("is-visible");
    }
  }

  // Spinner state — shown while the active frame's tiles are still
  // fetching.  The `idle` map listener kicks a re-render the moment
  // loading settles, so the spinner clears itself.
  #renderLoading() {
    this.#contentEl.innerHTML = `
      <div class="wrp-loading" role="status" aria-live="polite">
        <div class="wrp-loader" aria-hidden="true"></div>
        <div class="wrp-loading-text">Fetching results…</div>
      </div>
    `;
    if (this.#footerEl) {
      this.#footerEl.innerHTML = "";
      this.#footerEl.classList.remove("is-visible");
    }
  }

  #frameSourceIds(frame) {
    if (!frame) return [];
    if (Array.isArray(frame.sources)) return frame.sources.map((s) => s.id);
    if (frame.source?.id) return [frame.source.id];
    return [];
  }

  #sourceIsLoaded(sourceId) {
    try {
      // `isSourceLoaded` throws if the source hasn't been added yet —
      // treat that as "not loaded" rather than letting it bubble.
      if (!this.#map.getSource(sourceId)) return false;
      return this.#map.isSourceLoaded(sourceId);
    } catch {
      return false;
    }
  }

  #renderRows(rows, meta) {
    const provinces = new Map();
    let alertCount = 0;
    for (const r of rows) {
      if (r.reading.alert) alertCount += 1;
      const list = provinces.get(r.province) || [];
      list.push(r);
      provinces.set(r.province, list);
    }

    const top = rows[0];
    const summaryHtml = `
      <div class="wrp-summary">
        <div class="wrp-stat">
          <strong>${rows.length}</strong>
          <span>Districts</span>
        </div>
        <div class="wrp-stat">
          <strong>${alertCount}</strong>
          <span>Alerts</span>
        </div>
        <div class="wrp-stat">
          <strong>${provinces.size}</strong>
          <span>Provinces</span>
        </div>
      </div>
      ${
        top
          ? `
        <div class="wrp-hotspot ${top.reading.alert ? "is-alert" : ""}"
             ${bboxAttr(top.bbox)}
             role="button" tabindex="0"
             title="Fly to ${escapeHtml(top.district)}">
          <div class="wrp-hotspot-tag">HOTSPOT</div>
          <div class="wrp-hotspot-row">
            <div class="wrp-hotspot-text">
              <div class="wrp-hotspot-name">${escapeHtml(top.district)}</div>
              <div class="wrp-hotspot-meta">${escapeHtml(top.province)}</div>
            </div>
            <div class="wrp-hotspot-value">${escapeHtml(top.reading.label)}</div>
          </div>
        </div>
      `
          : ""
      }
    `;

    let groupsHtml = "";
    // Province ordering: by alert count desc, then district count desc.
    const orderedProvinces = [...provinces.entries()].sort(([, a], [, b]) => {
      const alertsA = a.filter((r) => r.reading.alert).length;
      const alertsB = b.filter((r) => r.reading.alert).length;
      if (alertsB !== alertsA) return alertsB - alertsA;
      return b.length - a.length;
    });

    for (const [province, list] of orderedProvinces) {
      const provinceAlerts = list.filter((r) => r.reading.alert).length;
      // Header layout per spec: district count stays as text (no icon),
      // alert count becomes an icon badge (Lucide `octagon-alert`).
      // The badge only renders when there's at least one alert in the
      // province — otherwise the right side stays clean.
      const alertBadgeHtml =
        provinceAlerts > 0
          ? `<span class="wrp-group-alert-badge" title="${provinceAlerts} alert${provinceAlerts === 1 ? "" : "s"}">
               <i data-lucide="octagon-alert" class="wrp-group-alert-icon"></i>
               <span class="wrp-group-alert-count">${provinceAlerts}</span>
             </span>`
          : "";
      groupsHtml += `
        <div class="wrp-group">
          <div class="wrp-group-head">
            <span class="wrp-group-name">${escapeHtml(province)}</span>
            <span class="wrp-group-meta">
              <span class="wrp-group-district-count">${list.length} district${list.length === 1 ? "" : "s"}</span>
              ${alertBadgeHtml}
            </span>
          </div>
          <div class="wrp-cards">
            ${list
              .map((r) => {
                const extrasHtml = (r.extras || [])
                  .map(
                    (ex) =>
                      `<span class="wrp-card-extra ${ex.alert ? "is-alert" : ""}" title="${escapeHtml(ex.source || "")}">${escapeHtml(ex.label)}</span>`
                  )
                  .join("");
                return `
              <div class="wrp-card ${r.reading.alert ? "is-alert" : ""}"
                   ${bboxAttr(r.bbox)}
                   role="button" tabindex="0"
                   title="Fly to ${escapeHtml(r.district)}">
                <div class="wrp-card-name">${escapeHtml(r.district)}</div>
                <div class="wrp-card-value">${escapeHtml(r.reading.label)}</div>
                ${extrasHtml ? `<div class="wrp-card-extras">${extrasHtml}</div>` : ""}
              </div>
            `;
              })
              .join("")}
          </div>
        </div>
      `;
    }

    const generated = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    // Layout split: `wrp-fixed` stays pinned to the top of the panel body
    // (summary + hotspot are reference data the user wants visible while
    // browsing); `wrp-scroll` owns the overflow so only the per-province
    // list scrolls.  The footer lives OUTSIDE this container at panel
    // level (#renderEmpty / #renderRows just write into #weatherReportFooter)
    // so it reads clearly as a static chrome strip, not the tail of a
    // scroll list.
    this.#contentEl.innerHTML = `
      <div class="wrp-fixed">${summaryHtml}</div>
      <div class="wrp-scroll">${groupsHtml}</div>
    `;
    if (this.#footerEl) {
      this.#footerEl.innerHTML = `${escapeHtml(meta.label)} · Generated ${generated}`;
      this.#footerEl.classList.add("is-visible");
    }
    // The new alert badges contain `<i data-lucide="octagon-alert">` —
    // lucide.createIcons() walks the DOM and replaces those placeholders
    // with their inline SVGs.  Cheap to call (it short-circuits when
    // there are no remaining `[data-lucide]` nodes).
    if (window.lucide?.createIcons) {
      try { window.lucide.createIcons(); } catch {}
    }
  }

  // -------------------------------------------------------------- destroy
  destroy() {
    // Single source of truth — same path used on panel close.  No need
    // to also clear #renderRafId because the throttle uses setTimeout
    // and #detachListeners clears that.
    this.#detachListeners();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Serialise a bbox tuple [w,s,e,n] to a `data-fly-bbox="w,s,e,n"`
// attribute fragment.  Returns "" if the bbox is missing/invalid so
// the card just renders without the click affordance instead of
// rendering with a broken value.
function bboxAttr(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return "";
  if (!bbox.every(Number.isFinite)) return "";
  return `data-fly-bbox="${bbox.map((n) => n.toFixed(4)).join(",")}"`;
}
