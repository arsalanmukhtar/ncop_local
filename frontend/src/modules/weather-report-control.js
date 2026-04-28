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

// Map of temporal layer key → { kind, label, sourceLayers[] }.  `kind`
// drives signal interpretation (rainfall vs snowfall vs temperature etc.).
// `sourceLayers` lists the mapbox vector "source-layer" names whose
// features hold the numeric reading on the `minValue` property.
const LAYER_KIND_MAP = {
  weekly_precipitation_2m_above_ground: {
    kind: "precipitation",
    label: "Weekly Precipitation",
    sourceLayers: ["precip", "snow"],
  },
  hourly_precipitation_2m_above_ground: {
    kind: "precipitation",
    label: "Hourly Precipitation",
    sourceLayers: ["precip", "layerSnow"],
  },
  hourly_snowfall_forecast: {
    kind: "snowfall",
    label: "Hourly Snowfall",
    sourceLayers: ["snow"],
  },
  weekly_snowfall_forecast: {
    kind: "snowfall",
    label: "Weekly Snowfall",
    sourceLayers: ["snow"],
  },
  cape_hourly_forecast: {
    kind: "cape",
    label: "CAPE (Hourly)",
    sourceLayers: ["layerCAPEInternal"],
  },
  cape_weekly_forecast: {
    kind: "cape",
    label: "CAPE (Weekly)",
    sourceLayers: ["layerCAPEInternal"],
  },
  storm_helicity_forecast_0_3km: {
    kind: "storm_helicity",
    label: "Storm Helicity 0–3 km",
    sourceLayers: ["stormhelicityColortable"],
  },
  temperature_2m_above_ground: {
    kind: "temperature",
    label: "Temperature (2 m)",
    sourceLayers: ["temperatureColortable"],
  },
  precipitation_radar: {
    kind: "raster",
    label: "Precipitation Radar",
    sourceLayers: [],
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
  #renderRafId = null;
  #observer = null;
  #boundOnSliderInput = null;
  #boundOnTemporalDom = null;
  #boundOnMapMove = null;
  #boundOnMapIdle = null;

  constructor(map) {
    this.#map = map;
    this.#render();
    this.#wireToggle();
    this.#wireReactivity();
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

    // Lucide icons get rendered by the global init pass; nudge it in case
    // we're mounted after the initial pass.
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  #wireToggle() {
    if (!this.#btnEl || !this.#panelEl) return;

    this.#btnEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = !this.#panelEl.classList.contains("visible");
      this.#panelEl.classList.toggle("visible", willOpen);
      this.#btnEl.classList.toggle("active-weather-report", willOpen);
      if (willOpen) this.#scheduleRender();
    });

    const closeBtn = this.#panelEl.querySelector(".wrp-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#panelEl.classList.remove("visible");
        this.#btnEl.classList.remove("active-weather-report");
      });
    }
  }

  // -------------------------------------------------------------- reactivity
  #wireReactivity() {
    // Slider step changes — listen on input event of #slider1. The
    // handler is debounced via rAF so dragging produces 1 render/frame.
    this.#boundOnSliderInput = () => this.#scheduleRender();
    const slider = document.getElementById("slider1");
    if (slider) slider.addEventListener("input", this.#boundOnSliderInput);

    // The slider element itself appears / disappears, and the variable
    // label changes when the user toggles a different temporal layer.
    // A single MutationObserver on #temp-slider1 (style + subtree) catches
    // both: visibility flips AND label updates inside .ts-variable p.
    const tempSlider = document.getElementById("temp-slider1");
    if (tempSlider) {
      this.#boundOnTemporalDom = () => this.#scheduleRender();
      this.#observer = new MutationObserver(this.#boundOnTemporalDom);
      this.#observer.observe(tempSlider, {
        attributes: true,
        attributeFilter: ["style"],
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    // Pan / zoom changes the visible districts → re-render so the report
    // tracks the viewport. moveend is a single fire after movement settles.
    this.#boundOnMapMove = () => {
      if (this.#isOpen()) this.#scheduleRender();
    };
    this.#map.on("moveend", this.#boundOnMapMove);

    // `idle` fires when the map has finished loading tiles + animations
    // for its current state.  This is what flips us out of the loading
    // spinner once the just-activated frame's tiles arrive.  rAF debounce
    // in #scheduleRender keeps it cheap.
    this.#boundOnMapIdle = () => {
      if (this.#isOpen()) this.#scheduleRender();
    };
    this.#map.on("idle", this.#boundOnMapIdle);
  }

  #isOpen() {
    return this.#panelEl?.classList.contains("visible") === true;
  }

  #scheduleRender() {
    if (!this.#isOpen()) return;
    if (this.#renderRafId != null) return;
    this.#renderRafId = requestAnimationFrame(() => {
      this.#renderRafId = null;
      try {
        this.#renderReport();
      } catch (e) {
        console.warn("[WeatherReport] render failed:", e);
      }
    });
  }

  // -------------------------------------------------------------- engine
  #renderReport() {
    const state = window.getCurrentTemporalState
      ? window.getCurrentTemporalState()
      : { layerKey: null, currentEntry: null, date: "", currentIndex: 0 };

    const layerKey = state.layerKey;
    const meta = layerKey ? LAYER_KIND_MAP[layerKey] : null;

    // ----- Subtitle / title ---------------------------------------------
    this.#titleEl.textContent = "Weather Report";
    if (!layerKey || !meta) {
      this.#subtitleEl.textContent =
        "Enable any temporal weather layer to generate a report.";
      this.#renderEmpty(
        "No active temporal layer",
        "Toggle a Meteoblue temporal layer (precipitation, snowfall, CAPE, helicity, temperature, …) and use the slider to step through frames. The report below will follow the current step automatically."
      );
      return;
    }

    if (meta.kind === "raster") {
      this.#subtitleEl.textContent = `${meta.label} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        `${meta.label} is raster-only`,
        "Per-district readings are not available for radar tiles. Switch to a vector temporal layer (precipitation, snowfall, CAPE, helicity, temperature) to see district aggregations."
      );
      return;
    }

    // ----- Boundary layer gating ----------------------------------------
    const districtVisible = this.#anyLayerVisible(DISTRICT_LAYER_IDS);
    const provinceVisible = this.#anyLayerVisible(PROVINCE_LAYER_IDS);
    if (!districtVisible || !provinceVisible) {
      this.#subtitleEl.textContent = `${meta.label} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "Boundaries required",
        "Enable both <b>District Boundary</b> and <b>Provincial Boundary</b> in the sidebar to generate the per-district report."
      );
      return;
    }

    // ----- Active frame's vector layer IDs ------------------------------
    const frame = state.currentEntry;
    const targetLayerIds = (frame?.layers || [])
      .map((l) => l.id)
      .filter((id) => this.#map.getLayer(id))
      .filter((id) => {
        const lyr = this.#map.getLayer(id);
        if (!lyr) return false;
        // Exclude raster sub-layers (composite radar) — they have no minValue.
        if (lyr.type === "raster") return false;
        // Only keep layers whose source-layer is one of the report-relevant ones.
        const sl = lyr["source-layer"] || lyr.sourceLayer;
        return meta.sourceLayers.length === 0 || meta.sourceLayers.includes(sl);
      });

    if (!targetLayerIds.length) {
      // Layers haven't been registered on the map yet — this is the
      // transient window right after activation while addSource/addLayer
      // is still running.  Spinner is the right UX, not an error.
      this.#subtitleEl.textContent = `${meta.label} · ${state.date || "Current step"}`;
      this.#renderLoading();
      return;
    }

    // Sources may exist but tiles for the current viewport may still be
    // in flight — `isSourceLoaded` is the canonical mapbox signal.  When
    // any of the active frame's sources is mid-fetch, defer to the
    // spinner; the `idle` listener (#wireReactivity) will kick a re-render
    // the moment loading settles.
    const frameSourceIds = this.#frameSourceIds(frame);
    if (frameSourceIds.length && !frameSourceIds.every((id) => this.#sourceIsLoaded(id))) {
      this.#subtitleEl.textContent = `${meta.label} · ${state.date || "Current step"}`;
      this.#renderLoading();
      return;
    }

    // ----- Query districts in viewport ----------------------------------
    const districtFeatures = this.#dedupedFeaturesByName(
      this.#map.queryRenderedFeatures({ layers: DISTRICT_LAYER_IDS }),
      DISTRICT_NAME_KEYS
    );

    if (!districtFeatures.length) {
      this.#subtitleEl.textContent = `${meta.label} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "No districts in view",
        "Pan or zoom so district polygons are visible, then the report will populate."
      );
      return;
    }

    // Province lookup table: build a flat list once, then use centroid PIP
    // via simple bbox containment when district feature lacks a province
    // property of its own.  Cheap fallback — most district features carry
    // their province key directly.
    const provinceFeatures = this.#dedupedFeaturesByName(
      this.#map.queryRenderedFeatures({ layers: PROVINCE_LAYER_IDS }),
      PROVINCE_NAME_KEYS
    );

    // ----- Sample each district's center point against vector layer -----
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

      const sampled = this.#sampleAt(center, targetLayerIds);
      const reading = this.#aggregateReading(sampled, meta.kind);
      if (reading == null) continue;

      rows.push({
        district: districtName,
        province: provinceName,
        reading,
      });
    }

    if (!rows.length) {
      this.#subtitleEl.textContent = `${meta.label} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "No signals at current step",
        "The active temporal frame has no readings over the visible districts. Try a different time step or pan to a region with coverage."
      );
      return;
    }

    // Sort by score (severity / magnitude) descending — hotspots first.
    rows.sort((a, b) => b.reading.score - a.reading.score);

    // ----- Render -------------------------------------------------------
    this.#subtitleEl.textContent = `${meta.label} · ${state.date || "Current step"} · ${rows.length} district${rows.length === 1 ? "" : "s"}`;
    this.#renderRows(rows, meta);
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

  #aggregateReading(features, kind) {
    if (!features.length) return null;
    let best = -Infinity;
    let bestSourceLayer = "";
    for (const f of features) {
      const v = Number(f?.properties?.minValue);
      if (!Number.isFinite(v)) continue;
      if (v > best) {
        best = v;
        bestSourceLayer = f.layer?.["source-layer"] || f.sourceLayer || "";
      }
    }
    if (!Number.isFinite(best)) return null;

    // Kind-specific labels + alert thresholds (mirrors weatherreport sample).
    let label = "";
    let unit = "";
    let alert = false;
    let score = Math.abs(best);
    switch (kind) {
      case "precipitation": {
        unit = "mm";
        if (bestSourceLayer === "snow" || bestSourceLayer === "layerSnow") {
          label = `Snow ${best.toFixed(1)} ${unit}`;
          alert = best >= 10;
        } else {
          label = `Rain ${best.toFixed(1)} ${unit}`;
          alert = best >= 20;
        }
        score = best;
        break;
      }
      case "snowfall":
        unit = "mm";
        label = `Snow ${best.toFixed(1)} ${unit}`;
        alert = best >= 10;
        score = best;
        break;
      case "cape":
        unit = "J/kg";
        label = `CAPE ${best.toFixed(0)} ${unit}`;
        alert = best >= 1000;
        score = best;
        break;
      case "storm_helicity":
        unit = "J/kg";
        label = `Helicity ${best.toFixed(0)} ${unit}`;
        alert = best >= 300;
        score = best;
        break;
      case "temperature":
        unit = "°C";
        label = `Temp ${best >= 0 ? "+" : ""}${best.toFixed(1)} ${unit}`;
        alert = best >= 42 || best <= -15;
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
        <div class="wrp-hotspot ${top.reading.alert ? "is-alert" : ""}">
          <div class="wrp-hotspot-tag">HOTSPOT</div>
          <div class="wrp-hotspot-name">${escapeHtml(top.district)}</div>
          <div class="wrp-hotspot-meta">${escapeHtml(top.province)}</div>
          <div class="wrp-hotspot-value">${escapeHtml(top.reading.label)}</div>
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
      groupsHtml += `
        <div class="wrp-group">
          <div class="wrp-group-head">
            <span class="wrp-group-name">${escapeHtml(province)}</span>
            <span class="wrp-group-meta">
              ${list.length} district${list.length === 1 ? "" : "s"}
              ${provinceAlerts > 0 ? `· <b class="wrp-group-alerts">${provinceAlerts} alert${provinceAlerts === 1 ? "" : "s"}</b>` : ""}
            </span>
          </div>
          <div class="wrp-cards">
            ${list
              .map(
                (r) => `
              <div class="wrp-card ${r.reading.alert ? "is-alert" : ""}">
                <div class="wrp-card-name">${escapeHtml(r.district)}</div>
                <div class="wrp-card-value">${escapeHtml(r.reading.label)}</div>
              </div>
            `
              )
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
  }

  // -------------------------------------------------------------- destroy
  destroy() {
    if (this.#renderRafId != null) cancelAnimationFrame(this.#renderRafId);
    if (this.#observer) this.#observer.disconnect();
    const slider = document.getElementById("slider1");
    if (slider && this.#boundOnSliderInput)
      slider.removeEventListener("input", this.#boundOnSliderInput);
    if (this.#boundOnMapMove)
      this.#map.off("moveend", this.#boundOnMapMove);
    if (this.#boundOnMapIdle)
      this.#map.off("idle", this.#boundOnMapIdle);
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
