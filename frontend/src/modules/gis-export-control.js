// gis-export-control.js
// ---------------------------------------------------------------------------
// A self-contained rail button + panel with two tabs:
//
// EXPORT — lists every currently-active NCOP layer (sidebar TOGGLE items
// that are checked AND actually rendering, plus whichever TEMPORAL item is
// currently selected) and exports each as the most appropriate GIS format
// it can produce, without asking the user to pick a format:
//
//   1. GeoJSON source (inline object or fetchable URL)      -> .geojson
//   2. Raster tile source (XYZ {z}/{x}/{y})                  -> real .tif
//      (server-side tile-stitch + georeference, see NcopRasterExportView)
//   3. Vector-tile source (rendered features, loaded tiles)  -> .geojson
//   4. Anything else                                          -> manifest .json
//
// IMPORT — drag/drop (or browse) a GeoJSON, a zipped Shapefile, or a
// GeoTIFF onto the map; see the "Import tab" section near the bottom of
// this file for the full flow (client-side GeoJSON parse, or a
// server-side upload to NcopShapefileUploadView/NcopRasterUploadView).
//
// Ported from the equivalent GCOP feature (see
// GCOP_GIS_Export_Control_Integration_Guide.md at the repo root) but built
// on NCOP's OWN conventions rather than copying GCOP's:
//   - Layer discovery reads window.sourceLayerControl.activeLayers (NCOP's
//     real in-memory registry) instead of scanning sidebar checkboxes —
//     more reliable, since a checked checkbox doesn't guarantee the layer
//     actually finished loading (see handleToggleInteraction in
//     mapbox-functions.js, which fires addLayerByKey without awaiting or
//     rolling back the checkbox on failure).
//   - Temporal items are read via window.getCurrentTemporalState()
//     (layersDef = every step, not just the current frame) — NCOP's
//     equivalent of GCOP's timeseries_layersets.
//   - Panel chrome (button classes, slide-in panel, mutual-exclusion with
//     other rail panels) matches NCOP's own LayerInfoPanel/BasemapPanel
//     idiom, not GCOP's draggable/resizable one.
//
// Zero core-logic edits: addLayerByKey/removeLayerByKey are wrapped (same
// "wrap, don't touch" pattern layer-panels.js's LayerInfoPanel and
// gcop-ffd-integration.js already use), never modified in place.
// ---------------------------------------------------------------------------

const RASTER_EXPORT_ENDPOINT = "/gis-export/raster/";
const EXPORT_GAP_MS = 80; // small gap between sequential downloads — some browsers throttle rapid-fire <a download> clicks

export class GisExportControl {
  #map;
  #sourceLayerControl;
  #isVisible = false;
  #busy = false;
  #items = [];
  #refreshTimer = null;
  #activeTab = "export";
  #importedLayers = [];
  #wmsCapsState = null; // last-fetched WMS GetCapabilities parse, kept around so "Add Selected" can read it back
  #qgisWmsConnections = null; // last-parsed QGIS wms_connections.xml import, kept around so picking one can look its url back up

  constructor(map, sourceLayerControl) {
    this.#map = map;
    this.#sourceLayerControl = sourceLayerControl;
    this.#render();
    this.#wireEvents();
    this.#wireLiveRefresh();
    window.ncopGisExportControl = this;
  }

  // ---- DOM ----------------------------------------------------------------
  #render() {
    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    const wrap = document.createElement("div");
    wrap.className = "custom-gis-export-control";
    wrap.innerHTML = `
      <button id="gisExportToggle" class="custom-gis-export-btn" type="button" title="Export Active GIS Layers">
        <i data-lucide="download"></i>
      </button>
      <div id="gisExportPanel" class="gis-export-panel">
        <div class="gis-export-header">
          <div class="gis-export-title-group">
            <span class="gis-export-title" id="gisExportPanelTitle">GIS Export</span>
            <span class="gis-export-subtitle" id="gisExportPanelSubtitle">Export active map layers by source type.</span>
          </div>
          <button id="gisExportClose" class="gis-export-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="gis-export-tabs" id="gisExportTabs">
          <button type="button" class="gis-export-tab active" data-gis-tab="export">Export</button>
          <button type="button" class="gis-export-tab" data-gis-tab="import">Import</button>
        </div>
        <div id="gisExportContent" class="gis-export-content"></div>
      </div>
    `;
    mapEl.appendChild(wrap);
    try { window.lucide?.createIcons(); } catch (_) {}
  }

  #esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s ?? "");
    return d.innerHTML;
  }

  // ---- Show / hide ----------------------------------------------------------
  #wireEvents() {
    const toggle = document.getElementById("gisExportToggle");
    const panel = document.getElementById("gisExportPanel");
    const closeBtn = document.getElementById("gisExportClose");
    const content = document.getElementById("gisExportContent");

    toggle?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.#isVisible) this.hidePanel();
      else this.showPanel();
    });
    closeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hidePanel();
    });

    // Tabs live OUTSIDE #gisExportContent (never replaced by innerHTML
    // swaps), wired once here rather than per-render.
    document.getElementById("gisExportTabs")?.addEventListener("click", (event) => {
      const tabBtn = event.target.closest(".gis-export-tab");
      if (!tabBtn) return;
      const tab = tabBtn.dataset.gisTab;
      if (!tab || tab === this.#activeTab) return;
      this.#activeTab = tab;
      document.querySelectorAll("#gisExportTabs .gis-export-tab").forEach((b) => b.classList.toggle("active", b === tabBtn));
      const titleEl = document.getElementById("gisExportPanelTitle");
      const subtitleEl = document.getElementById("gisExportPanelSubtitle");
      if (tab === "import") {
        if (titleEl) titleEl.textContent = "GIS Import";
        if (subtitleEl) subtitleEl.textContent = "Drag in a file, or connect to a WMS service.";
      } else {
        if (titleEl) titleEl.textContent = "GIS Export";
        if (subtitleEl) subtitleEl.textContent = "Export active map layers by source type.";
      }
      this.#renderContent();
    });

    // One delegated listener on the content container — it's re-rendered
    // on every layer toggle / tab switch, so per-row listeners would leak.
    content?.addEventListener("click", (event) => {
      const selectBtn = event.target.closest(".gis-export-select");
      if (selectBtn) {
        const checked = selectBtn.dataset.select === "all";
        content.querySelectorAll(".gis-export-check").forEach((i) => { i.checked = checked; });
        return;
      }
      if (event.target.closest("#gisExportRun")) { this.#exportSelected(); return; }

      const removeBtn = event.target.closest("[data-imp-remove]");
      if (removeBtn) { this.#removeImportedLayer(removeBtn.dataset.impRemove); return; }

      // Clicking anywhere on the dropzone (not just the "browse" text)
      // opens the file picker — the input itself is excluded so its own
      // native click handling isn't re-triggered recursively.
      const dropzone = event.target.closest(".gis-import-dropzone");
      if (dropzone && event.target.id !== "gisImportFileInput") {
        document.getElementById("gisImportFileInput")?.click();
      }
    });

    content?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!event.target.closest(".gis-import-dropzone")) return;
      event.preventDefault();
      document.getElementById("gisImportFileInput")?.click();
    });

    content?.addEventListener("change", (event) => {
      if (event.target.id === "gisImportFileInput" && event.target.files?.length) {
        this.#handleImportFiles(event.target.files);
        event.target.value = ""; // reset so re-selecting the same file still fires "change"
      }
    });

    // Drag-and-drop, delegated the same way — the drop zone is inside
    // #gisExportContent, which gets replaced whenever the tab/list
    // re-renders, so listeners live on the persistent container instead.
    ["dragover", "dragenter"].forEach((evt) => {
      content?.addEventListener(evt, (event) => {
        if (!event.target.closest(".gis-import-dropzone")) return;
        event.preventDefault();
        document.getElementById("gisImportDropzone")?.classList.add("is-dragover");
      });
    });
    content?.addEventListener("dragleave", (event) => {
      if (!event.target.closest(".gis-import-dropzone")) return;
      document.getElementById("gisImportDropzone")?.classList.remove("is-dragover");
    });
    content?.addEventListener("drop", (event) => {
      if (!event.target.closest(".gis-import-dropzone")) return;
      event.preventDefault();
      document.getElementById("gisImportDropzone")?.classList.remove("is-dragover");
      if (event.dataTransfer?.files?.length) this.#handleImportFiles(event.dataTransfer.files);
    });

    // ---- WMS connector — all delegated, same reasoning as everything
    // above (the URL row / caps browser live inside #gisExportContent,
    // which gets replaced on every tab switch / list re-render).
    content?.addEventListener("input", (event) => {
      if (event.target.id === "gisWmsUrl") {
        const v = event.target.value.trim();
        const hasGetMap = /request=GetMap/i.test(v) || /\{bbox/i.test(v);
        const layerRow = document.getElementById("gisWmsLayerRow");
        if (layerRow) layerRow.style.display = v && !hasGetMap ? "flex" : "none";
        return;
      }
      const sliderId = event.target.dataset.wmsTimeSlider;
      if (sliderId) {
        const entry = this.#importedLayers.find((l) => l.id === sliderId);
        if (entry?.wmsTimes?.length) {
          this.#setWmsLayerTimeIndex(entry, parseInt(event.target.value, 10)).catch((err) => {
            this.#setImportStatus(`WMS time step failed: ${err?.message || "unknown error"}`, false);
          });
        }
      }
    });

    content?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.id === "gisWmsUrl") {
        event.preventDefault();
        document.getElementById("gisWmsConnect")?.click();
      }
    });

    content?.addEventListener("click", (event) => {
      if (event.target.closest("#gisWmsConnect")) {
        const url = document.getElementById("gisWmsUrl")?.value?.trim() || "";
        if (!url) { this.#setImportStatus("Paste a WMS base URL first.", false); return; }
        this.#fetchWmsCapabilities(url);
        return;
      }
      if (event.target.closest("#gisWmsAdd")) {
        const url = document.getElementById("gisWmsUrl")?.value?.trim() || "";
        const layerName = document.getElementById("gisWmsLayerName")?.value?.trim() || "";
        if (!url) { this.#setImportStatus("Paste a WMS URL first.", false); return; }
        // If Connect was already run for this same URL, reuse that layer's
        // known extent so this manual add zooms too, not just the
        // checkbox-picker "Add Selected" path.
        const known = this.#wmsCapsState?.baseUrl === url ? this.#wmsCapsState.layers.find((l) => l.name === layerName) : null;
        this.#addWmsImportLayer(url, layerName, known?.bbox ? { bbox: known.bbox } : {});
        return;
      }

      const selectAllBtn = event.target.closest("[data-wms-select-all]");
      if (selectAllBtn) {
        const box = document.getElementById("gisWmsCaps");
        const checks = box?.querySelectorAll(".gis-wms-layer-check");
        const checkAll = !Array.from(checks || []).every((c) => c.checked);
        checks?.forEach((c) => { c.checked = checkAll; });
        return;
      }
      if (event.target.closest("[data-wms-add-selected]")) { this.#addSelectedWmsCapsLayers(); return; }

      const connBtn = event.target.closest("[data-wms-conn-idx]");
      if (connBtn) {
        const conn = this.#qgisWmsConnections?.[parseInt(connBtn.dataset.wmsConnIdx, 10)];
        if (conn) {
          const urlInput = document.getElementById("gisWmsUrl");
          if (urlInput) urlInput.value = conn.url;
          this.#fetchWmsCapabilities(conn.url);
        }
        return;
      }

      const infoBtn = event.target.closest("[data-wms-info-idx]");
      if (infoBtn) {
        const idx = infoBtn.dataset.wmsInfoIdx;
        const panel = document.querySelector(`[data-wms-info-panel="${idx}"]`);
        const layer = this.#wmsCapsState?.layers?.[parseInt(idx, 10)];
        if (panel && layer) {
          const isOpen = panel.style.display !== "none";
          if (isOpen) {
            panel.style.display = "none";
          } else {
            panel.innerHTML = this.#renderWmsLayerInfoHTML(layer);
            panel.style.display = "block";
          }
        }
        return;
      }

      const playBtn = event.target.closest("[data-wms-time-play]");
      if (playBtn) {
        const entry = this.#importedLayers.find((l) => l.id === playBtn.dataset.wmsTimePlay);
        if (entry) this.#toggleWmsLayerPlay(entry);
      }
    });

    // dashboard.js's RAIL_PANEL_REGISTRY force-closes this panel (direct
    // classList.remove) whenever another rail panel opens, bypassing
    // hidePanel() — resync our own #isVisible flag when that happens so a
    // later click on the toggle button re-opens instead of no-op'ing.
    new MutationObserver(() => {
      if (this.#isVisible && !panel?.classList.contains("visible")) {
        this.#isVisible = false;
        document.getElementById("gisExportToggle")?.classList.remove("active-gis-export");
      }
    }).observe(panel, { attributes: true, attributeFilter: ["class"] });

    document.addEventListener("click", (event) => {
      if (!this.#isVisible) return;
      const path = event.composedPath ? event.composedPath() : [event.target];
      const insidePanel = path.some((el) => el?.id === "gisExportPanel");
      const onButton = path.some((el) => el?.id === "gisExportToggle");
      if (!insidePanel && !onButton) this.hidePanel();
    });
  }

  showPanel() {
    this.#isVisible = true;
    document.getElementById("gisExportToggle")?.classList.add("active-gis-export");
    this.#renderContent();
    document.getElementById("gisExportPanel")?.classList.add("visible");
  }

  hidePanel() {
    this.#isVisible = false;
    document.getElementById("gisExportToggle")?.classList.remove("active-gis-export");
    document.getElementById("gisExportPanel")?.classList.remove("visible");
  }

  // ---- Live refresh while open ---------------------------------------------
  // Mirrors LayerInfoPanel's own two refresh signals: wrap addLayerByKey/
  // removeLayerByKey for TOGGLE items (same pattern gcop-ffd-integration.js
  // and LayerInfoPanel already use — composes fine, each wrap just calls
  // through to whatever was there before), and watch for .is-selected
  // class changes on temporal sidebar items for temporal switches (those
  // never go through addLayerByKey/removeLayerByKey at all).
  #wireLiveRefresh() {
    const slc = this.#sourceLayerControl;
    if (slc && typeof slc.addLayerByKey === "function" && typeof slc.removeLayerByKey === "function") {
      const origAdd = slc.addLayerByKey.bind(slc);
      const origRemove = slc.removeLayerByKey.bind(slc);
      slc.addLayerByKey = (...args) => {
        const r = origAdd(...args);
        this.#scheduleRefresh();
        return r;
      };
      slc.removeLayerByKey = (...args) => {
        const r = origRemove(...args);
        this.#scheduleRefresh();
        return r;
      };
    }

    const observeTarget = document.querySelector(".sidebar-panel") || document.body;
    new MutationObserver((mutations) => {
      if (!this.#isVisible || window.isTemporalAnimating) return;
      const relevant = mutations.some((m) =>
        m.type === "attributes" && m.attributeName === "class" &&
        m.target instanceof Element &&
        (m.target.classList.contains("ncop-item-image") || m.target.closest(".ncop-item-temporal"))
      );
      if (relevant) this.#scheduleRefresh();
    }).observe(observeTarget, { attributes: true, attributeFilter: ["class"], subtree: true });
  }

  #scheduleRefresh() {
    // Only the Export tab's list depends on live sidebar/temporal state —
    // re-rendering while the operator is mid-upload on the Import tab
    // would wipe their drop zone/status for no reason.
    if (!this.#isVisible || this.#activeTab !== "export") return;
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => this.#renderExportContent(), 120);
  }

  // ---- Discovering active layers -------------------------------------------
  #classifySource(source) {
    if (!source) return "unknown";
    if (source.type === "geojson") return "geojson";
    if (source.type === "raster" || source.type === "raster-dem") return "raster";
    if (source.type === "vector") return "vector";
    return "unknown";
  }

  #buildItem({ itemKey, label, isTemporal, sourceGroups, currentSource, countLabel }) {
    const type = this.#classifySource(currentSource || sourceGroups[0]?.source);
    const typeLabel = { geojson: "GeoJSON source", raster: "Raster", vector: "Vector tile" }[type] || "Unknown";
    const formatLabel = { geojson: "GeoJSON", raster: "GeoTIFF (.tif)", vector: "GeoJSON (loaded tiles)" }[type] || "Source package";
    const slug = String(itemKey).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "layer";
    return { itemKey, label, isTemporal, type, typeLabel, formatLabel, countLabel, sourceGroups, currentSource, slug };
  }

  // Ground truth for TOGGLE items is sourceLayerControl.activeLayers, NOT
  // the sidebar checkbox DOM state — see module header comment. Ground
  // truth for the (at most one) active TEMPORAL item is
  // window.getCurrentTemporalState(), whose layersDef is the FULL step
  // array, not just the currently-displayed frame.
  #getActiveExportItems() {
    const map = this.#map;
    const slc = this.#sourceLayerControl;
    const items = [];

    if (slc?.activeLayers) {
      for (const [itemKey, info] of slc.activeLayers) {
        const config = info?.config;
        const source = config?.source;
        const layerIds = (info?.layerIds || []).filter((id) => { try { return !!map.getLayer(id); } catch (_) { return false; } });
        if (!layerIds.length) continue;
        const visibleLayerIds = layerIds.filter((id) => {
          try { return map.getLayoutProperty(id, "visibility") !== "none"; } catch (_) { return true; }
        });
        if (!visibleLayerIds.length) continue;
        const label = config?.label || config?.title || itemKey;
        items.push(this.#buildItem({
          itemKey,
          label,
          isTemporal: false,
          sourceGroups: [{ source, layerIds: visibleLayerIds, date: null }],
          currentSource: source,
          countLabel: `${visibleLayerIds.length} map layer${visibleLayerIds.length === 1 ? "" : "s"}`,
        }));
      }
    }

    const temporal = typeof window.getCurrentTemporalState === "function" ? window.getCurrentTemporalState() : null;
    if (temporal?.layerKey && Array.isArray(temporal.layersDef) && temporal.layersDef.length) {
      const found = typeof slc?.findLayerConfig === "function" ? slc.findLayerConfig(temporal.layerKey) : null;
      const label = found?.config?.label || found?.config?.title || temporal.layerKey;
      const sourceGroups = [];
      for (const entry of temporal.layersDef) {
        const srcs = Array.isArray(entry.sources) && entry.sources.length ? entry.sources : (entry.source ? [entry.source] : []);
        for (const source of srcs) {
          if (source) sourceGroups.push({ source, layerIds: (entry.layers || []).map((l) => l.id), date: entry.date });
        }
      }
      if (sourceGroups.length) {
        const cur = temporal.currentEntry;
        const curSrc = cur ? ((Array.isArray(cur.sources) && cur.sources[0]) || cur.source) : null;
        items.push(this.#buildItem({
          itemKey: temporal.layerKey,
          label,
          isTemporal: true,
          sourceGroups,
          currentSource: curSrc || sourceGroups[0].source,
          countLabel: `${temporal.layersDef.length} time step${temporal.layersDef.length === 1 ? "" : "s"}`,
        }));
      }
    }

    return items;
  }

  // ---- Rendering the panel body ---------------------------------------------
  #renderContent() {
    if (this.#activeTab === "import") this.#renderImportContent();
    else this.#renderExportContent();
  }

  #renderExportContent() {
    this.#items = this.#getActiveExportItems();
    const content = document.getElementById("gisExportContent");
    if (!content) return;

    if (!this.#items.length) {
      content.innerHTML = `<div class="gis-export-empty">No active layers to export yet — turn on a sidebar layer or select a temporal layer first.</div>`;
      return;
    }

    const rows = this.#items.map((it) => `
      <label class="gis-export-row">
        <input type="checkbox" class="gis-export-check" value="${this.#esc(it.itemKey)}" checked>
        <span class="gis-export-row-main">
          <span class="gis-export-row-label">${this.#esc(it.label)}</span>
          <span class="gis-export-row-meta">${this.#esc(it.typeLabel)} · ${this.#esc(it.formatLabel)} · ${this.#esc(it.countLabel)}</span>
        </span>
      </label>
    `).join("");

    content.innerHTML = `
      <div class="gis-export-toolbar">
        <button type="button" class="gis-export-select" data-select="all">All</button>
        <button type="button" class="gis-export-select" data-select="none">None</button>
        <button type="button" id="gisExportRun" class="gis-export-run">Export Selected</button>
      </div>
      <div id="gisExportStatus" class="gis-export-status" aria-live="polite">
        <span id="gisExportLoader" class="gis-export-loader" aria-hidden="true"><span class="gis-export-loader-bars"></span></span>
        <span id="gisExportStatusText" class="gis-export-status-text"></span>
      </div>
      <div class="gis-export-rows">${rows}</div>
      <div class="gis-export-note">GeoJSON sources download directly. Raster layers export as a georeferenced GeoTIFF (.tif) covering the current map view — one file per time step for a temporal layer. Vector tile layers export the features currently loaded in view as GeoJSON — not a full dataset.</div>
    `;
  }

  #setStatus(text, busy = false) {
    const container = document.getElementById("gisExportStatus");
    const textEl = document.getElementById("gisExportStatusText");
    if (textEl) textEl.textContent = text;
    if (container) container.classList.toggle("is-busy", !!busy && !!text);
  }

  // ---- Running the export ---------------------------------------------------
  async #exportSelected() {
    if (this.#busy) return;
    const content = document.getElementById("gisExportContent");
    if (!content) return;
    const checkedIds = [...content.querySelectorAll(".gis-export-check:checked")].map((i) => i.value);
    const selected = this.#items.filter((it) => checkedIds.includes(it.itemKey));
    if (!selected.length) { this.#setStatus("Select at least one active layer to export."); return; }

    this.#busy = true;
    try {
      for (let i = 0; i < selected.length; i++) {
        this.#setStatus(`Preparing ${i + 1} of ${selected.length}: ${selected[i].label}…`, true);
        await this.#exportItem(selected[i]);
        await new Promise((r) => setTimeout(r, EXPORT_GAP_MS));
      }
      this.#setStatus(`Export prepared for ${selected.length} layer(s).`);
    } catch (err) {
      this.#setStatus(`Export failed: ${err?.message || "unknown error"}`);
    } finally {
      this.#busy = false;
    }
  }

  // Tries tiers 1 -> 4 in order, stopping at the first that produces output.
  async #exportItem(item) {
    if (item.type === "geojson") {
      if (item.isTemporal) {
        const combined = { type: "FeatureCollection", metadata: { ncop_temporal_steps: item.sourceGroups.length }, features: [] };
        for (const g of item.sourceGroups) {
          const data = await this.#resolveGeojson(g.source);
          if (Array.isArray(data?.features)) {
            for (const f of data.features) combined.features.push({ ...f, properties: { ...(f.properties || {}), ncop_step_date: g.date || null } });
          }
        }
        if (combined.features.length) { this.#download(`${item.slug}.geojson`, JSON.stringify(combined, null, 2), "application/geo+json"); return; }
      } else {
        const data = await this.#resolveGeojson(item.sourceGroups[0].source);
        if (data) { this.#download(`${item.slug}.geojson`, JSON.stringify(data, null, 2), "application/geo+json"); return; }
      }
    }

    if (item.type === "raster") {
      const ok = item.isTemporal ? await this.#exportRasterAllSteps(item) : await this.#exportRaster(item.currentSource, item.slug);
      if (ok) return;
    }

    if (item.type === "vector") {
      const fc = this.#collectLoadedVectorFeatures(item);
      if (fc.features.length) { this.#download(`${item.slug}.geojson`, JSON.stringify(fc, null, 2), "application/geo+json"); return; }
    }

    this.#downloadManifest(item);
  }

  // Tier 1 — GeoJSON, direct. Prefers the LIVE loaded source data over the
  // static config: several NCOP geojson sources ship an empty seed
  // FeatureCollection and get hydrated in-place via setData() once real
  // data arrives (ffd_data, nwfc_observations) — the static config's own
  // .data would export empty for those.
  async #resolveGeojson(source) {
    if (!source || source.type !== "geojson") return null;
    try {
      const liveSrc = this.#map.getSource(source.id);
      const raw = liveSrc?._data;
      if (raw && typeof raw === "object" && Array.isArray(raw.features) && raw.features.length) return raw;
    } catch (_) { /* fall through to config-based resolution */ }
    if (typeof source.data === "object") return source.data;
    if (typeof source.data === "string") {
      try {
        const res = await fetch(source.data, { credentials: "same-origin" });
        if (!res.ok) return null;
        return await res.json();
      } catch (_) { return null; }
    }
    return null;
  }

  // Tier 2 — raster -> real GeoTIFF, server-side (see NcopRasterExportView,
  // which auto-detects whether the source is a WMS {bbox-epsg-3857}
  // template — true for most of NCOP's own temporal raster layers, DWD/
  // ECMWF/GDPS/Copernicus/… — or a literal {z}/{x}/{y} XYZ template).
  // Uses the CURRENT map viewport in EPSG:3857 — NCOP's raster sources
  // have no GetCapabilities to look up a "full extent" from (unlike
  // GCOP's WMS layers), so a viewport-scoped export is the honest scope
  // here.
  async #exportRaster(source, slug) {
    const urlTemplate = (Array.isArray(source?.tiles) && source.tiles[0]) || source?.url;
    if (!urlTemplate) return false;
    const bbox = this.#viewportBounds3857();
    const params = new URLSearchParams({
      url: urlTemplate,
      bbox: bbox.join(","),
      filename: slug,
    });
    let res;
    try {
      res = await fetch(`${RASTER_EXPORT_ENDPOINT}?${params.toString()}`, { credentials: "same-origin" });
    } catch (_) { return false; }
    if (!res.ok) return false;
    const blob = await res.blob();
    this.#download(`${slug}.tif`, blob, "image/tiff");
    return true;
  }

  // Exports EVERY step of a temporal raster layer as its own GeoTIFF —
  // one sequential request per step (same 80ms-gap-between-downloads
  // reasoning as the outer per-item loop, since this can add up to a lot
  // of individual downloads for a layer with many steps). Returns true if
  // at least one step exported successfully.
  async #exportRasterAllSteps(item) {
    let exportedAny = false;
    for (let i = 0; i < item.sourceGroups.length; i++) {
      const g = item.sourceGroups[i];
      const stepLabel = g.date ? String(g.date).replace(/[^a-zA-Z0-9]+/g, "_") : `step${String(i + 1).padStart(2, "0")}`;
      this.#setStatus(`Preparing step ${i + 1} of ${item.sourceGroups.length} (${item.label})…`, true);
      const ok = await this.#exportRaster(g.source, `${item.slug}_${stepLabel}`);
      if (ok) exportedAny = true;
      if (i < item.sourceGroups.length - 1) await new Promise((r) => setTimeout(r, EXPORT_GAP_MS));
    }
    return exportedAny;
  }

  #viewportBounds3857() {
    const b = this.#map.getBounds();
    const toMerc = (lng, lat) => {
      const x = (lng * 20037508.34) / 180;
      let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
      y = (y * 20037508.34) / 180;
      return [x, y];
    };
    const [minX, minY] = toMerc(b.getWest(), b.getSouth());
    const [maxX, maxY] = toMerc(b.getEast(), b.getNorth());
    return [minX, minY, maxX, maxY];
  }

  // Tier 3 — rendered vector features from currently-loaded tiles. Honest
  // about its own limitation, same as the GCOP original: only features
  // from tiles the map has actually loaded at the current view/zoom, not
  // a full dataset — flagged via metadata.ncop_notice.
  #collectLoadedVectorFeatures(item) {
    const map = this.#map;
    const features = [];
    const seen = new Set();
    const layerIds = item.sourceGroups.flatMap((g) => g.layerIds || []);
    for (const layerId of layerIds) {
      let styleLayer;
      try { styleLayer = map.getStyle()?.layers?.find((l) => l.id === layerId); } catch (_) { continue; }
      if (!styleLayer?.source || !map.getSource(styleLayer.source)) continue;
      const key = `${styleLayer.source}|${styleLayer["source-layer"] || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let found = [];
      try { found = map.querySourceFeatures(styleLayer.source, { sourceLayer: styleLayer["source-layer"] }) || []; } catch (_) { /* best-effort */ }
      for (const f of found) {
        features.push({ type: "Feature", geometry: f.geometry, properties: { ...(f.properties || {}), ncop_map_layer: layerId } });
      }
    }
    return {
      type: "FeatureCollection",
      metadata: {
        ncop_export_scope: "loaded-map-tiles",
        ncop_notice: "Exported from currently loaded map tiles at the current view/zoom — not a full dataset. Zoom/pan to load more tiles before exporting for wider coverage.",
      },
      features,
    };
  }

  // Tier 4 — fallback manifest: enough for a user to add the source
  // manually in QGIS/ArcGIS when nothing else applies.
  #downloadManifest(item) {
    const manifest = {
      type: "ncop_gis_export_manifest",
      label: item.label,
      itemKey: item.itemKey,
      isTemporal: item.isTemporal,
      sources: item.sourceGroups.map((g) => ({
        sourceType: g.source?.type,
        tiles: g.source?.tiles,
        url: g.source?.url,
        data: typeof g.source?.data === "string" ? g.source.data : undefined,
        date: g.date || undefined,
      })),
      note: "NCOP could not export this layer's source directly. Use the tile URL/template above to add it manually as a source in QGIS or ArcGIS Pro.",
    };
    this.#download(`${item.slug}_source_package.json`, JSON.stringify(manifest, null, 2), "application/json");
  }

  #download(filename, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ==========================================================================
  // Import tab — drag/drop GeoJSON, a zipped Shapefile, or a GeoTIFF onto
  // the map. Ported from the sibling GCOP feature's Import tab (see "GCOP —
  // GIS Import Tab Full Ground.txt" §5-6), scoped to file-drop/browse only
  // — the WMS-connect/browse/time-animation and choropleth/stats
  // subsystems that guide also documents are out of scope here. GeoJSON is
  // parsed entirely client-side (no backend involved at all); Shapefile/
  // GeoTIFF go through NcopShapefileUploadView/NcopRasterUploadView
  // respectively, since the browser has no geometry/raster libraries of
  // its own for those formats. Nothing here persists server-side beyond
  // one upload request, and nothing is saved client-side either — imported
  // layers are a working-session scratch space, gone on reload.
  // ==========================================================================
  #renderImportContent() {
    const content = document.getElementById("gisExportContent");
    if (!content) return;
    content.innerHTML = `
      <div class="gis-wms-row">
        <input type="text" id="gisWmsUrl" class="gis-wms-url-input" placeholder="WMS URL — paste GetMap or base WMS endpoint">
        <div id="gisWmsLayerRow" class="gis-wms-layer-row" style="display:none">
          <input type="text" id="gisWmsLayerName" class="gis-wms-layer-input" placeholder="Layer name (e.g. topp:states)">
        </div>
        <div class="gis-wms-btn-row">
          <button type="button" id="gisWmsConnect" class="gis-wms-btn" title="Fetch capabilities and list available layers">Connect</button>
          <button type="button" id="gisWmsAdd" class="gis-wms-btn gis-wms-btn-primary">Add WMS</button>
        </div>
      </div>
      <div id="gisWmsCaps" class="gis-wms-caps" style="display:none"></div>

      <div class="gis-import-dropzone" id="gisImportDropzone" tabindex="0" role="button" aria-label="Drop a file here, or browse">
        <div class="gis-import-dropzone-icon" aria-hidden="true"><i data-lucide="upload-cloud"></i></div>
        <div class="gis-import-dropzone-label">Drop a file here, or <span class="gis-import-browse">browse</span></div>
        <div class="gis-import-dropzone-hint">GeoJSON · Shapefile .zip · KML/KMZ · Excel/CSV (lat/lon) · GeoTIFF · QGIS wms_connections.xml</div>
        <input type="file" id="gisImportFileInput" class="gis-import-file-input" accept=".geojson,.json,.zip,.kmz,.kml,.xlsx,.xls,.csv,.tif,.tiff,.xml" multiple aria-label="Upload file">
      </div>
      <div id="gisImportStatus" class="gis-export-status" aria-live="polite">
        <span id="gisImportLoader" class="gis-export-loader" aria-hidden="true"><span class="gis-export-loader-bars"></span></span>
        <span id="gisImportStatusText" class="gis-export-status-text"></span>
      </div>
      <div id="gisImportList" class="gis-import-list">${this.#renderImportedLayersListHTML()}</div>
      <div class="gis-export-note">GeoJSON loads directly in the browser. Every other format (Shapefile, KML/KMZ, Excel/CSV, GeoTIFF) is processed server-side (reprojected to WGS84 / EPSG:3857) then added to the map; WMS tiles are proxied server-side to avoid CORS. Don't know a WMS URL? Drop a QGIS-exported wms_connections.xml here to pick from your saved connections instead. Nothing here is saved — closing or reloading the page clears imported layers.</div>
    `;
    try { window.lucide?.createIcons(); } catch (_) {}
  }

  #renderImportedLayersListHTML() {
    if (!this.#importedLayers.length) return `<div class="gis-import-empty">No imported layers yet.</div>`;
    return this.#importedLayers.map((l) => `
      <div class="gis-import-row" data-imp-id="${this.#esc(l.id)}">
        <div class="gis-import-row-head">
          <span class="gis-import-row-main">
            <span class="gis-import-row-label">${this.#esc(l.label)}</span>
            <span class="gis-import-row-meta">${this.#esc(l.type)}</span>
          </span>
          <button type="button" class="gis-import-remove" data-imp-remove="${this.#esc(l.id)}" title="Remove layer" aria-label="Remove layer">&times;</button>
        </div>
        ${l.wmsTimes?.length > 1 ? this.#renderWmsTimeCtrlHTML(l) : ""}
      </div>
    `).join("");
  }

  #refreshImportList() {
    const listEl = document.getElementById("gisImportList");
    if (listEl) listEl.innerHTML = this.#renderImportedLayersListHTML();
  }

  #setImportStatus(text, busy = false) {
    const container = document.getElementById("gisImportStatus");
    const textEl = document.getElementById("gisImportStatusText");
    if (textEl) textEl.textContent = text;
    if (container) container.classList.toggle("is-busy", !!busy && !!text);
  }

  #handleImportFiles(fileList) {
    [...fileList].forEach((file) => {
      const ext = file.name.split(".").pop().toLowerCase();
      if (ext === "geojson" || ext === "json") {
        this.#setImportStatus(`Loading ${file.name}…`, true);
        const reader = new FileReader();
        reader.onload = (e) => this.#processGeoJSONImport(String(e.target.result), file.name);
        reader.onerror = () => this.#setImportStatus(`Failed to read ${file.name}`, false);
        reader.readAsText(file);
      } else if (ext === "zip") {
        this.#processShapefileImport(file);
      } else if (ext === "kmz" || ext === "kml") {
        this.#processKmzImport(file);
      } else if (ext === "xlsx" || ext === "xls" || ext === "csv") {
        this.#processSpreadsheetImport(file);
      } else if (ext === "tif" || ext === "tiff") {
        this.#processRasterImport(file);
      } else if (ext === "xml") {
        this.#setImportStatus(`Loading ${file.name}…`, true);
        const reader = new FileReader();
        reader.onload = (e) => this.#processQgisWmsConnectionsImport(String(e.target.result), file.name);
        reader.onerror = () => this.#setImportStatus(`Failed to read ${file.name}`, false);
        reader.readAsText(file);
      } else {
        this.#setImportStatus(`Unsupported format: .${ext}. Use GeoJSON, .zip (Shapefile), .kmz/.kml, .xlsx/.csv (with lat/lon columns), GeoTIFF, or a QGIS wms_connections.xml.`, false);
      }
    });
  }

  #processGeoJSONImport(text, filename) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      this.#setImportStatus(`Invalid GeoJSON in ${filename}`, false);
      return;
    }
    if (!data || !["FeatureCollection", "Feature", "GeometryCollection"].includes(data.type)) {
      if (data?.features) data.type = "FeatureCollection";
      else { this.#setImportStatus(`${filename} is not a valid GeoJSON`, false); return; }
    }
    const fc = data.type === "FeatureCollection" ? data : { type: "FeatureCollection", features: [data] };
    const label = filename.replace(/\.(geo)?json$/i, "");
    this.#addImportedVectorLayer(fc, label, "GeoJSON");
  }

  // Shared by every server-side vector-import path (Shapefile/KMZ/
  // Spreadsheet) — same upload/status/error shape, only the endpoint,
  // form field name, and filename-suffix pattern differ. GeoJSON isn't
  // here since it never touches the network at all (see
  // #processGeoJSONImport).
  async #uploadVectorFile(file, { endpoint, fieldName, typeLabel, labelPattern }) {
    const formData = new FormData();
    formData.append(fieldName, file);
    const fileMb = file.size / (1024 * 1024);
    this.#setImportStatus(
      fileMb > 30
        ? `Uploading ${file.name} (${fileMb.toFixed(0)} MB) — large file, processing may take a minute…`
        : `Uploading ${file.name}…`,
      true
    );
    try {
      const res = await fetch(endpoint, { method: "POST", body: formData, credentials: "same-origin" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (data?.error) throw new Error(data.error);
      if (!data?.features?.length) throw new Error("No features returned from server");
      const label = file.name.replace(labelPattern, "");
      this.#addImportedVectorLayer(data, label, typeLabel);
      const meta = data.metadata;
      if (meta?.ncop_import_rows_total != null) {
        const total = meta.ncop_import_rows_total, mapped = meta.ncop_import_rows_mapped;
        this.#setImportStatus(`${label} loaded — ${mapped} of ${total} row${total === 1 ? "" : "s"} mapped to points.`, false);
      }
    } catch (err) {
      this.#setImportStatus(`Upload failed: ${err?.message || "unknown error"}`, false);
    }
  }

  #processShapefileImport(file) {
    return this.#uploadVectorFile(file, { endpoint: "/upload-shapefile/", fieldName: "shapefile", typeLabel: "Shapefile", labelPattern: /\.zip$/i });
  }

  #processKmzImport(file) {
    return this.#uploadVectorFile(file, { endpoint: "/upload-kmz/", fieldName: "kmz", typeLabel: "KML/KMZ", labelPattern: /\.(kmz|kml)$/i });
  }

  #processSpreadsheetImport(file) {
    return this.#uploadVectorFile(file, { endpoint: "/upload-spreadsheet/", fieldName: "spreadsheet", typeLabel: "Spreadsheet", labelPattern: /\.(xlsx|xls|csv)$/i });
  }

  async #processRasterImport(file) {
    const formData = new FormData();
    formData.append("raster", file);
    const fileMb = file.size / (1024 * 1024);
    this.#setImportStatus(
      fileMb > 30
        ? `Uploading ${file.name} (${fileMb.toFixed(0)} MB) — large raster, this may take a minute…`
        : `Uploading raster ${file.name}…`,
      true
    );
    try {
      const res = await fetch("/upload-raster/", { method: "POST", body: formData, credentials: "same-origin" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (data?.error) throw new Error(data.error);
      const label = file.name.replace(/\.(tif|tiff)$/i, "");
      this.#addImportedRasterLayer(data, label);
    } catch (err) {
      this.#setImportStatus(`Raster upload failed: ${err?.message || "unknown error"}`, false);
    }
  }

  // Geometry type (point/polygon/line) is DERIVED from the actual GeoJSON,
  // never asked for — same "geomClass detected, not declared" approach the
  // GCOP guide uses, which is what lets GeoJSON and Shapefile imports (two
  // different producers) share this one code path.
  #addImportedVectorLayer(geojsonData, label, type) {
    const map = this.#map;
    const id = `ncop-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const geomTypes = [...new Set((geojsonData.features || []).map((f) => f?.geometry?.type).filter(Boolean))];
    const isPoint = geomTypes.length > 0 && geomTypes.every((t) => t.includes("Point"));
    const isPoly = geomTypes.some((t) => t.includes("Polygon"));

    try {
      if (map.getSource(id)) map.removeSource(id);
      map.addSource(id, { type: "geojson", data: geojsonData });
      if (isPoint) {
        map.addLayer({ id, type: "circle", source: id, paint: { "circle-radius": 5, "circle-color": "#00eaff", "circle-stroke-width": 1.5, "circle-stroke-color": "#003366" } });
      } else if (isPoly) {
        map.addLayer({ id: `${id}-fill`, type: "fill", source: id, paint: { "fill-color": "#00eaff", "fill-opacity": 0.18 } });
        map.addLayer({ id: `${id}-stroke`, type: "line", source: id, paint: { "line-color": "#00eaff", "line-width": 1.5 } });
      } else {
        map.addLayer({ id, type: "line", source: id, paint: { "line-color": "#00eaff", "line-width": 2 } });
      }
    } catch (err) {
      this.#setImportStatus(`Failed to add layer: ${err?.message || "unknown error"}`, false);
      return;
    }

    const layerIds = isPoly ? [`${id}-fill`, `${id}-stroke`] : [id];
    const featureCount = geojsonData.features?.length ?? 0;
    this.#importedLayers.push({ id, label, type, sourceId: id, layerIds });
    this.#refreshImportList();
    this.#setImportStatus(`${label} loaded — ${featureCount} feature${featureCount === 1 ? "" : "s"}.`, false);
    this.#fitToGeojsonBounds(geojsonData);
  }

  #addImportedRasterLayer(rasterData, fallbackLabel) {
    const map = this.#map;
    const id = `ncop-imp-raster-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const coordinates = rasterData.coordinates;
    if (!rasterData.url || !Array.isArray(coordinates) || coordinates.length !== 4) {
      this.#setImportStatus("Raster import did not return georeferenced image coordinates.", false);
      return;
    }
    try {
      if (map.getSource(id)) map.removeSource(id);
      map.addSource(id, { type: "image", url: rasterData.url, coordinates });
      map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.85 } });
    } catch (err) {
      this.#setImportStatus(`Failed to add raster: ${err?.message || "unknown error"}`, false);
      return;
    }

    const label = rasterData.label || fallbackLabel || "Imported raster";
    this.#importedLayers.push({ id, label, type: "GeoTIFF", sourceId: id, layerIds: [id] });
    this.#refreshImportList();
    this.#setImportStatus(`${label} loaded — ${rasterData.crs || "georeferenced raster"}.`, false);

    try {
      const b = rasterData.bounds;
      if (Array.isArray(b) && b.length === 4) {
        map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, maxZoom: 15, duration: 800 });
      }
    } catch (_) { /* ignore fit errors */ }
  }

  // Hand-rolled bbox scan (not turf.js) — flattens arbitrarily-nested
  // coordinate arrays via a regex over the JSON text rather than a
  // geometry-type-aware walker, same pragmatic trick the GCOP guide uses:
  // Point/Polygon/MultiPolygon all nest differently, and this doesn't
  // need to care which.
  #fitToGeojsonBounds(geojsonData) {
    try {
      const bounds = (geojsonData.features || []).reduce((b, f) => {
        const coords = f?.geometry?.coordinates;
        if (!coords) return b;
        const flat = (JSON.stringify(coords).match(/-?\d+\.?\d*/g) || []).map(Number);
        for (let i = 0; i < flat.length; i += 2) {
          const lng = flat[i], lat = flat[i + 1];
          if (lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
            if (b === null) b = [lng, lat, lng, lat];
            else { b[0] = Math.min(b[0], lng); b[1] = Math.min(b[1], lat); b[2] = Math.max(b[2], lng); b[3] = Math.max(b[3], lat); }
          }
        }
        return b;
      }, null);
      if (bounds) this.#map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 40, maxZoom: 15, duration: 800 });
    } catch (_) { /* ignore fit errors */ }
  }

  #removeImportedLayer(importId) {
    const map = this.#map;
    const entry = this.#importedLayers.find((l) => l.id === importId);
    if (!entry) return;

    // Stop playback FIRST — otherwise the running loop can try to touch a
    // layer we're about to remove out from under it.
    if (entry._wmsPlayTimer) {
      entry._wmsPlayToken = (entry._wmsPlayToken || 0) + 1;
      entry._wmsTimeRequestSeq = (entry._wmsTimeRequestSeq || 0) + 1;
      entry._wmsPlayTimer = null;
    }
    try {
      if (entry._wmsTimeCache) {
        // Every cached LAYER first, then every cached SOURCE — Mapbox GL
        // throws if you remove a source a layer still references.
        entry._wmsTimeCache.forEach((ref) => { if (map.getLayer(ref.layerId)) map.removeLayer(ref.layerId); });
        entry._wmsTimeCache.forEach((ref) => { if (map.getSource(ref.sourceId)) map.removeSource(ref.sourceId); });
        entry._wmsTimeCache.clear();
      } else {
        entry.layerIds.forEach((lid) => { if (map.getLayer(lid)) map.removeLayer(lid); });
        if (map.getSource(entry.sourceId)) map.removeSource(entry.sourceId);
      }
    } catch (_) { /* best-effort cleanup */ }
    this.#importedLayers = this.#importedLayers.filter((l) => l.id !== importId);
    this.#refreshImportList();
    this.#setImportStatus("Layer removed.", false);
  }

  // ==========================================================================
  // WMS connector — "paste a URL, Connect or Add WMS". Ported from "GCOP —
  // WMS Connector Full Ground-.txt", scoped to this project's Import tab
  // (same `#importedLayers` array / `#refreshImportList()` every other
  // import path already uses — see that guide's own §1 note that this
  // subsystem only assumes "some array + some re-render function," which
  // is exactly what's already here). Server side is two deliberately dumb
  // proxies (NcopWmsCapabilitiesProxyView/NcopWmsTileProxyView) — all the
  // URL-shape detection, XML parsing, and time-animation logic below is
  // client-side, matching the guide's own architecture.
  // ==========================================================================

  // Recognizes three URL shapes a user might paste and normalizes all of
  // them into a Mapbox-tileable {bbox-epsg-3857} template. Reused for
  // EVERY tile URL this subsystem ever builds — the initial add, every
  // capabilities-browser add, and every individual animation frame — so
  // there's exactly one place these three shapes are handled, not three
  // that could drift out of sync.
  #buildWmsTileUrl(rawUrl, wmsLayerName, extra = {}) {
    let tileUrl;
    if (/\{bbox-epsg-3857\}/i.test(rawUrl)) {
      tileUrl = rawUrl;
    } else if (/request=GetMap/i.test(rawUrl)) {
      tileUrl = rawUrl
        .replace(/([?&])bbox=[^&]*/i, `$1bbox={bbox-epsg-3857}`)
        .replace(/([?&])width=[^&]*/i, "$1width=256")
        .replace(/([?&])height=[^&]*/i, "$1height=256");
      if (!/bbox=/i.test(tileUrl)) {
        tileUrl += "&bbox={bbox-epsg-3857}&width=256&height=256&transparent=true";
      }
    } else {
      const base = rawUrl.includes("?") ? rawUrl.split("?")[0] : rawUrl;
      const lyr = wmsLayerName || "0";
      // styles= (empty is valid — "use each layer's default style") is
      // mandatory for plenty of real WMS 1.1.1 servers (confirmed live
      // against a public GeoServer instance during testing: omitting it
      // returns "missing parameters ['styles']" instead of a tile).
      tileUrl = `${base}?service=WMS&version=1.1.1&request=GetMap&layers=${encodeURIComponent(lyr)}&styles=&bbox={bbox-epsg-3857}&width=256&height=256&srs=EPSG:3857&format=image/png&transparent=true`;
    }
    tileUrl = tileUrl.replace(/([?&])time=[^&]*&?/i, "$1").replace(/[?&]$/, "");
    if (extra.time) tileUrl += `&time=${encodeURIComponent(extra.time)}`;
    return tileUrl;
  }

  // Routes a tile URL through the Django proxy so cross-origin WMS
  // servers without CORS headers can still load as map tiles. The
  // marker-swap dance matters: Mapbox GL substitutes {bbox-epsg-3857}
  // itself, at actual tile-request time, by string-replacing that exact
  // literal substring — naively encodeURIComponent()-ing the whole URL
  // first would percent-encode the braces too, and Mapbox's substitution
  // would never find a match again.
  #proxyWmsTileUrl(tileUrl) {
    const PLACEHOLDER = "{bbox-epsg-3857}";
    const MARKER = "__NCOP_BBOX_MARKER__";
    const encoded = encodeURIComponent(tileUrl.replace(PLACEHOLDER, MARKER)).replace(MARKER, PLACEHOLDER);
    return `/wms-tile/?url=${encoded}`;
  }

  #addWmsImportLayer(rawUrl, wmsLayerName, extra = {}, customLabel = "", opts = {}) {
    const map = this.#map;
    const id = `ncop-imp-wms-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tileUrl = this.#buildWmsTileUrl(rawUrl, wmsLayerName, extra);
    const proxiedTileUrl = this.#proxyWmsTileUrl(tileUrl);

    try {
      if (map.getSource(id)) map.removeSource(id);
      map.addSource(id, { type: "raster", tiles: [proxiedTileUrl], tileSize: 256 });
      map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.9 } });
    } catch (err) {
      this.#setImportStatus(`Failed to add WMS: ${err?.message || "unknown error"}`, false);
      return;
    }

    let label = customLabel || wmsLayerName;
    if (!label) {
      try { label = new URL(rawUrl.replace(/\{[^}]+\}/g, "placeholder")).hostname; } catch (_) { label = "WMS layer"; }
    }
    let wmsTimeIndex = -1;
    if (extra.times) {
      wmsTimeIndex = extra.times.indexOf(extra.time);
      if (wmsTimeIndex < 0) wmsTimeIndex = extra.times.length - 1;
    }
    const entry = {
      id, label, type: "WMS", sourceId: id, layerIds: [id],
      wmsRawUrl: rawUrl,
      wmsLayerName: wmsLayerName || "",
      wmsTime: extra.time || null,
      wmsTimes: extra.times || null,
      wmsTimeIndex,
    };
    if (entry.wmsTimes?.length > 1) {
      // Seed the time-animation cache with the frame just built, rather
      // than throwing it away and rebuilding — the first frame the user
      // sees isn't wasted work.
      entry._wmsTimeCache = new Map();
      entry._wmsTimeCache.set(wmsTimeIndex, { layerId: id, sourceId: id, index: wmsTimeIndex, lastUsed: Date.now() });
      entry._wmsActiveTimeLayerId = id;
      this.#preloadAdjacentWmsTimes(entry, wmsTimeIndex);
    }
    this.#importedLayers.push(entry);
    this.#refreshImportList();
    this.#setImportStatus(`WMS layer added: ${label}`, false);

    // Zoom to the layer's advertised extent, same as every other import
    // type already does (GeoJSON/Shapefile/KMZ/Spreadsheet via
    // #fitToGeojsonBounds, raster via its own bounds) — skipped when
    // #addSelectedWmsCapsLayers is adding several layers at once, since
    // that caller fits ONE combined view after the whole batch instead.
    if (!opts.skipZoom && Array.isArray(extra.bbox) && extra.bbox.length === 4 && extra.bbox.every((v) => Number.isFinite(v))) {
      try {
        map.fitBounds([[extra.bbox[0], extra.bbox[1]], [extra.bbox[2], extra.bbox[3]]], { padding: 40, maxZoom: 12, duration: 800 });
      } catch (_) { /* ignore fit errors */ }
    }
  }

  // ---- Connect: fetching + parsing GetCapabilities --------------------------
  async #fetchWmsCapabilities(rawUrl) {
    const capsBox = document.getElementById("gisWmsCaps");
    if (!capsBox) return;
    this.#setImportStatus("Connecting to WMS service…", true);
    capsBox.style.display = "block";
    capsBox.innerHTML = `<div class="gis-wms-caps-loading">Fetching capabilities…</div>`;

    try {
      const proxyUrl = `/wms-capabilities/?url=${encodeURIComponent(rawUrl)}`;
      const res = await fetch(proxyUrl, { credentials: "same-origin" });
      const text = await res.text();
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = JSON.parse(text); if (j.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }
      const parsed = this.#parseWmsCapabilitiesXML(text);
      if (!parsed.layers.length) throw new Error("No layers found in capabilities document");
      this.#wmsCapsState = { baseUrl: rawUrl, ...parsed };
      capsBox.innerHTML = this.#renderWmsCapsHTML(this.#wmsCapsState);
      this.#setImportStatus(`Connected — ${parsed.layers.length} layer${parsed.layers.length === 1 ? "" : "s"} available.`, false);
    } catch (err) {
      this.#wmsCapsState = null;
      capsBox.innerHTML = `<div class="gis-wms-caps-error">Failed to load capabilities: ${this.#esc(err?.message || "unknown error")}</div>`;
      this.#setImportStatus(`WMS capabilities request failed: ${err?.message || "unknown error"}`, false);
    }
  }

  // WMS Capabilities documents are a TREE of <Layer> elements; the time
  // <Dimension>/<Extent> and <Abstract> can be declared once on a parent
  // and implicitly apply to every child that doesn't redeclare them —
  // real, common WMS server behavior, threaded down through the
  // recursive walk below rather than skipped as an edge case.
  #parseWmsCapabilitiesXML(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid capabilities XML");

    const root = doc.documentElement;
    const version = root?.getAttribute("version") || "1.3.0";
    const layers = [];

    const readTimeDimension = (layerEl) => {
      const children = [...layerEl.children];
      const dimEl = children.find((el) => el.tagName.toLowerCase() === "dimension" && (el.getAttribute("name") || "").toLowerCase() === "time");
      const extEl = children.find((el) => el.tagName.toLowerCase() === "extent" && (el.getAttribute("name") || "").toLowerCase() === "time");
      if (!dimEl && !extEl) return null;
      const extent = (extEl?.textContent || dimEl?.textContent || "").trim();
      const def = (extEl?.getAttribute("default") || dimEl?.getAttribute("default") || "").trim();
      if (!extent && !def) return null;
      return { extent, default: def };
    };

    // Bounding box, so a newly-added WMS layer can be zoomed to just like
    // every other import type — WMS 1.3.0 uses <EX_GeographicBoundingBox>
    // (child elements), WMS 1.1.1 uses <LatLonBoundingBox minx=".."
    // miny=".." maxx=".." maxy=".."/> (attributes). Like time/abstract
    // above, real services commonly declare this once on a parent Layer
    // and expect it to apply to every child that doesn't redeclare it.
    const readGeographicBBox = (layerEl) => {
      const children = [...layerEl.children];
      const exEl = children.find((el) => el.tagName.toLowerCase() === "ex_geographicboundingbox");
      if (exEl) {
        const exChildren = [...exEl.children];
        const get = (tag) => {
          const el = exChildren.find((c) => c.tagName.toLowerCase() === tag);
          const v = el ? parseFloat(el.textContent) : NaN;
          return Number.isFinite(v) ? v : null;
        };
        const west = get("westboundlongitude"), east = get("eastboundlongitude");
        const south = get("southboundlatitude"), north = get("northboundlatitude");
        if ([west, south, east, north].every((v) => v != null)) return [west, south, east, north];
      }
      const llEl = children.find((el) => el.tagName.toLowerCase() === "latlonboundingbox");
      if (llEl) {
        const west = parseFloat(llEl.getAttribute("minx"));
        const south = parseFloat(llEl.getAttribute("miny"));
        const east = parseFloat(llEl.getAttribute("maxx"));
        const north = parseFloat(llEl.getAttribute("maxy"));
        if ([west, south, east, north].every((v) => Number.isFinite(v))) return [west, south, east, north];
      }
      return null;
    };

    const walk = (layerEl, inheritedTime, inheritedAbstract, inheritedBBox) => {
      const children = [...layerEl.children];
      const nameEl = children.find((el) => el.tagName.toLowerCase() === "name");
      const titleEl = children.find((el) => el.tagName.toLowerCase() === "title");
      const abstractEl = children.find((el) => el.tagName.toLowerCase() === "abstract");
      const name = nameEl?.textContent.trim() || "";
      const title = titleEl?.textContent.trim() || name;

      const ownTime = readTimeDimension(layerEl);
      const layerTime = ownTime || inheritedTime || null;
      const abstract = abstractEl?.textContent.trim() || inheritedAbstract || "";
      const layerBBox = readGeographicBBox(layerEl) || inheritedBBox || null;

      if (name) layers.push({ name, title, time: layerTime, abstract, bbox: layerBBox });

      children.filter((el) => el.tagName.toLowerCase() === "layer").forEach((child) => walk(child, layerTime, abstract, layerBBox));
    };

    const capabilityEl = [...root.children].find((el) => el.tagName.toLowerCase() === "capability");
    const topLayers = capabilityEl ? [...capabilityEl.children].filter((el) => el.tagName.toLowerCase() === "layer") : [];
    topLayers.forEach((l) => walk(l, null, "", null));

    return { version, layers };
  }

  #renderWmsCapsHTML(state) {
    const rows = state.layers.map((l, i) => {
      const timeBadge = l.time
        ? `<span class="gis-wms-time-badge" title="${this.#esc(l.time.extent || l.time.default || "")}">Temporal${l.time.default ? ` — ${this.#esc(l.time.default)}` : ""}</span>`
        : "";
      return `
        <div class="gis-wms-layer-row-item">
          <label class="gis-wms-layer-row-label">
            <input type="checkbox" class="gis-wms-layer-check" data-wms-layer-idx="${i}">
            <span class="gis-wms-layer-text">
              <span class="gis-wms-layer-title">${this.#esc(l.title || l.name)}</span>
              <span class="gis-wms-layer-name">${this.#esc(l.name)}</span>
            </span>
            ${timeBadge}
          </label>
          <button type="button" class="gis-wms-info-btn" data-wms-info-idx="${i}" title="Layer info" aria-label="Layer information">i</button>
        </div>
        <div class="gis-wms-layer-info-panel" data-wms-info-panel="${i}" style="display:none"></div>`;
    }).join("");

    return `
      <div class="gis-wms-caps-header">
        <span>${state.layers.length} layer${state.layers.length === 1 ? "" : "s"} available</span>
        <div class="gis-wms-caps-actions">
          <button type="button" class="gis-wms-mini-btn" data-wms-select-all>Select All</button>
          <button type="button" class="gis-wms-mini-btn gis-wms-mini-btn-primary" data-wms-add-selected>Add Selected</button>
        </div>
      </div>
      <div class="gis-wms-caps-body">${rows}</div>
    `;
  }

  // Plain-language "what am I about to add" guidance, computed live from
  // the actual parsed time-step count/range rather than a raw metadata
  // dump — built lazily, only when the (i) popover is actually opened
  // (see the delegated click handler), not up-front for every layer in
  // a service that might offer hundreds.
  #renderWmsLayerInfoHTML(layer) {
    const desc = layer.abstract ? this.#esc(layer.abstract) : "No description was provided by this WMS service for this layer.";
    let timeInfo = "";
    if (layer.time) {
      const times = this.#parseWmsTimeExtent(layer.time.extent || "");
      if (times.length > 1) {
        const start = this.#formatWmsTimeLabel(times[0]);
        const end = this.#formatWmsTimeLabel(times[times.length - 1]);
        timeInfo = `
          <p><strong>Temporal layer</strong> — this layer offers ${times.length} time steps, from <strong>${this.#esc(start)}</strong> to <strong>${this.#esc(end)}</strong>.</p>
          <p><strong>How time works once added:</strong> a play/scrub control appears under this layer's card in the Import list. Drag it to step through timestamps, or press play — frames are pre-loaded and swapped by opacity, not re-fetched, so it doesn't flicker.</p>`;
      } else if (layer.time.default) {
        timeInfo = `<p><strong>Temporal layer</strong> — the service only reports a single default time (<code>${this.#esc(layer.time.default)}</code>), so it will be added showing that snapshot.</p>`;
      }
    }
    return `<div class="gis-wms-info-body">
      <p class="gis-wms-info-desc">${desc}</p>
      <p><strong>WMS layer name:</strong> <code>${this.#esc(layer.name)}</code></p>
      <p><strong>How to add this layer:</strong> tick the checkbox next to it (or use "Select All"), then click <strong>Add Selected</strong>.</p>
      ${timeInfo}
    </div>`;
  }

  #addSelectedWmsCapsLayers() {
    const capsBox = document.getElementById("gisWmsCaps");
    if (!capsBox || !this.#wmsCapsState) return;
    const checks = [...capsBox.querySelectorAll(".gis-wms-layer-check:checked")];
    if (!checks.length) { this.#setImportStatus("Select at least one layer to add.", false); return; }

    let added = 0;
    let combinedBBox = null;
    checks.forEach((c) => {
      const idx = parseInt(c.dataset.wmsLayerIdx, 10);
      const layer = this.#wmsCapsState.layers[idx];
      if (!layer) return;

      const extra = {};
      if (Array.isArray(layer.bbox)) {
        extra.bbox = layer.bbox;
        if (!combinedBBox) combinedBBox = [...layer.bbox];
        else {
          combinedBBox[0] = Math.min(combinedBBox[0], layer.bbox[0]);
          combinedBBox[1] = Math.min(combinedBBox[1], layer.bbox[1]);
          combinedBBox[2] = Math.max(combinedBBox[2], layer.bbox[2]);
          combinedBBox[3] = Math.max(combinedBBox[3], layer.bbox[3]);
        }
      }
      if (layer.time?.extent) {
        const times = this.#parseWmsTimeExtent(layer.time.extent);
        if (times.length > 1) {
          extra.times = times;
          const def = (layer.time.default || "").toLowerCase();
          let defIdx = -1;
          if (def && !["current", "default"].includes(def)) {
            defIdx = times.indexOf(layer.time.default);
            if (defIdx < 0) defIdx = this.#findClosestWmsTimeIndex(times, layer.time.default);
          }
          extra.time = defIdx >= 0 ? times[defIdx] : times[times.length - 1];
        }
      }
      if (!extra.time && layer.time?.default) {
        const def = layer.time.default.toLowerCase();
        if (def !== "current" && def !== "default") extra.time = layer.time.default;
      }

      this.#addWmsImportLayer(this.#wmsCapsState.baseUrl, layer.name, extra, layer.title, { skipZoom: true });
      added++;
    });

    if (combinedBBox) {
      try {
        this.#map.fitBounds([[combinedBBox[0], combinedBBox[1]], [combinedBBox[2], combinedBBox[3]]], { padding: 40, maxZoom: 12, duration: 800 });
      } catch (_) { /* ignore fit errors */ }
    }
    this.#setImportStatus(`Added ${added} WMS layer${added === 1 ? "" : "s"}.`, false);
  }

  // ---- QGIS wms_connections.xml import — a shortcut into the SAME
  // Connect flow above, for when the user doesn't know/have a WMS URL
  // handy but does have their saved connections exported from QGIS
  // (Settings > Options > ... or right-click "WMS/WMTS" > Export
  // Connections in the QGIS Data Source Manager). Format is a flat,
  // unnamespaced <qgsWMSConnections><wms name="..." url="..."/>...</> —
  // parsed with the same DOMParser already used for GetCapabilities,
  // no backend involved (nothing to fetch yet, just reading attributes).
  #processQgisWmsConnectionsImport(text, filename) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, "text/xml");
      if (doc.querySelector("parsererror")) throw new Error("invalid XML");
    } catch (_) {
      this.#setImportStatus(`${filename} is not valid XML.`, false);
      return;
    }
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "qgswmsconnections") {
      this.#setImportStatus(`${filename} doesn't look like a QGIS WMS connections export (expected a <qgsWMSConnections> root element).`, false);
      return;
    }
    const connections = [...doc.querySelectorAll("wms")]
      .map((el) => ({ name: el.getAttribute("name") || "Untitled", url: (el.getAttribute("url") || "").trim() }))
      .filter((c) => c.url);
    if (!connections.length) {
      this.#setImportStatus(`No WMS connections found in ${filename}.`, false);
      return;
    }

    this.#qgisWmsConnections = connections;
    const capsBox = document.getElementById("gisWmsCaps");
    if (capsBox) {
      capsBox.style.display = "block";
      capsBox.innerHTML = this.#renderQgisConnectionsPickerHTML(connections);
    }
    this.#setImportStatus(`Loaded ${connections.length} WMS connection${connections.length === 1 ? "" : "s"} from ${filename} — pick one to browse its layers.`, false);
  }

  // A single-select list (not the multi-checkbox layer picker) — picking
  // a row fills the URL field and immediately runs the normal Connect
  // flow (#fetchWmsCapabilities), which replaces this list with that
  // connection's actual layer picker. Nothing here talks to the network;
  // it's purely local attribute values from the parsed XML.
  #renderQgisConnectionsPickerHTML(connections) {
    const rows = connections.map((c, i) => `
      <button type="button" class="gis-wms-conn-row" data-wms-conn-idx="${i}">
        <span class="gis-wms-conn-name">${this.#esc(c.name)}</span>
        <span class="gis-wms-conn-url">${this.#esc(c.url)}</span>
      </button>
    `).join("");
    return `
      <div class="gis-wms-caps-header">
        <span>${connections.length} saved WMS connection${connections.length === 1 ? "" : "s"} — pick one to browse its layers</span>
      </div>
      <div class="gis-wms-caps-body">${rows}</div>
    `;
  }

  // ---- Expanding a WMS time dimension into concrete steps --------------------
  #parseISODuration(str) {
    const m = String(str || "").match(/^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!m) return null;
    return { years: +(m[1] || 0), months: +(m[2] || 0), days: +(m[3] || 0), hours: +(m[4] || 0), minutes: +(m[5] || 0), seconds: +(m[6] || 0) };
  }

  #addISODuration(date, dur) {
    const d = new Date(date.getTime());
    if (dur.years) d.setUTCFullYear(d.getUTCFullYear() + dur.years);
    if (dur.months) d.setUTCMonth(d.getUTCMonth() + dur.months);
    if (dur.days) d.setUTCDate(d.getUTCDate() + dur.days);
    if (dur.hours) d.setUTCHours(d.getUTCHours() + dur.hours);
    if (dur.minutes) d.setUTCMinutes(d.getUTCMinutes() + dur.minutes);
    if (dur.seconds) d.setUTCSeconds(d.getUTCSeconds() + dur.seconds);
    return d;
  }

  // maxSteps=100 is a deliberate hard cap — real public WMS services have
  // been observed advertising century-long daily ranges
  // ("2000-01-01/2099-12-31/P1D", 36000+ steps); generating that many
  // client-side would freeze the tab. A degenerate service still gets a
  // usable, evenly-distributed slider instead of hanging.
  #parseWmsTimeExtent(extentStr, maxSteps = 100) {
    if (!extentStr) return [];
    const out = [];
    String(extentStr).split(",").map((s) => s.trim()).filter(Boolean).forEach((part) => {
      if (part.includes("/")) {
        const [startStr, endStr, periodStr] = part.split("/");
        const start = new Date(startStr);
        const end = new Date(endStr);
        const dur = periodStr ? this.#parseISODuration(periodStr) : null;
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          if (!isNaN(start.getTime())) out.push(start.toISOString());
          return;
        }
        if (!dur) {
          const totalMs = end.getTime() - start.getTime();
          const dayMs = 24 * 60 * 60 * 1000;
          const stepMs = Math.max(totalMs / Math.max(maxSteps - 1, 1), dayMs);
          let cur = start, count = 0;
          while (cur.getTime() <= end.getTime() && count < maxSteps) {
            out.push(cur.toISOString());
            cur = new Date(cur.getTime() + stepMs);
            count++;
          }
          return;
        }
        let cur = start, count = 0;
        while (cur.getTime() <= end.getTime() && count < maxSteps) {
          out.push(cur.toISOString());
          cur = this.#addISODuration(cur, dur);
          count++;
        }
      } else {
        const d = new Date(part);
        out.push(isNaN(d.getTime()) ? part : d.toISOString());
      }
    });
    return [...new Set(out)];
  }

  #findClosestWmsTimeIndex(times, target) {
    const targetMs = new Date(target).getTime();
    if (isNaN(targetMs)) return -1;
    let best = -1, bestDiff = Infinity;
    times.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - targetMs);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    return best;
  }

  #formatWmsTimeLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 16).replace("T", " ") + "Z";
  }

  // ---- Time-animation engine --------------------------------------------
  // The naive approach — tear down the old tile source and build a new one
  // with a new TIME= on every slider move — flickers (blank frame while
  // new tiles load) and hits the remote server on every drag event.
  // Instead: every VISITED time step gets its own real Mapbox source+
  // layer, kept in a small LRU-capped cache; switching is a raster-opacity
  // paint-property change (instant, GPU-side, no network) while the next
  // likely step is warmed in the background.
  #WMS_TIME_CACHE_LIMIT = 8;
  #WMS_FRAME_READY_TIMEOUT_MS = 8000;
  #WMS_PLAY_INTERVAL_MS = 900;

  #getWmsLayerOpacity(_entry) {
    return 0.9; // fixed — this pass doesn't include the symbology/opacity-slider toolkit
  }

  #buildWmsTimeLayerIds(entry, index) {
    return { sourceId: `${entry.id}-time-src-${index}`, layerId: `${entry.id}-time-layer-${index}` };
  }

  // Creates (or returns the cached) Mapbox source+layer for one time
  // index. A newly-created layer starts fully transparent — "prepared"
  // and "visible" are deliberately separate steps.
  #ensureWmsTimeLayer(entry, index) {
    const map = this.#map;
    if (!entry._wmsTimeCache) entry._wmsTimeCache = new Map();
    const cached = entry._wmsTimeCache.get(index);
    if (cached && map.getLayer(cached.layerId) && map.getSource(cached.sourceId)) {
      cached.lastUsed = Date.now();
      return cached;
    }

    const ids = this.#buildWmsTimeLayerIds(entry, index);
    const time = entry.wmsTimes[index];
    const tileUrl = this.#buildWmsTileUrl(entry.wmsRawUrl, entry.wmsLayerName, { time });
    const proxiedTileUrl = this.#proxyWmsTileUrl(tileUrl);

    try {
      if (!map.getSource(ids.sourceId)) {
        map.addSource(ids.sourceId, { type: "raster", tiles: [proxiedTileUrl], tileSize: 256 });
      }
      if (!map.getLayer(ids.layerId)) {
        map.addLayer({ id: ids.layerId, type: "raster", source: ids.sourceId, paint: { "raster-opacity": 0 } });
      }
    } catch (err) {
      this.#setImportStatus(`Failed to prepare WMS time frame: ${err?.message || "unknown error"}`, false);
      return null;
    }

    const layerRef = { ...ids, index, lastUsed: Date.now() };
    entry._wmsTimeCache.set(index, layerRef);
    this.#trimWmsTimeCache(entry);
    return layerRef;
  }

  // Evicts the least-recently-used cached frame(s) once the cache exceeds
  // the limit. Never evicts the currently-active frame, even if it's the
  // oldest by lastUsed — that one is what's actually on screen.
  #trimWmsTimeCache(entry) {
    if (!entry._wmsTimeCache || entry._wmsTimeCache.size <= this.#WMS_TIME_CACHE_LIMIT) return;
    const activeIndex = entry.wmsTimeIndex;
    const removable = [...entry._wmsTimeCache.entries()]
      .filter(([idx, ref]) => idx !== activeIndex && ref.layerId !== entry._wmsActiveTimeLayerId)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const map = this.#map;
    while (entry._wmsTimeCache.size > this.#WMS_TIME_CACHE_LIMIT && removable.length) {
      const [idx, ref] = removable.shift();
      try {
        if (map.getLayer(ref.layerId)) map.removeLayer(ref.layerId);
        if (ref.sourceId !== entry.sourceId && map.getSource(ref.sourceId)) map.removeSource(ref.sourceId);
      } catch (_) { /* ignore stale cache cleanup */ }
      entry._wmsTimeCache.delete(idx);
    }
  }

  // Waits for a source's tiles to actually finish loading (or times out —
  // resolves false either way, since a slow server shouldn't permanently
  // block the UI; callers proceed regardless, just showing whatever's
  // loaded so far after the timeout).
  #waitForWmsSourceReady(sourceId, timeoutMs = this.#WMS_FRAME_READY_TIMEOUT_MS) {
    const map = this.#map;
    return new Promise((resolve) => {
      let done = false, timeoutId = null;
      const cleanup = () => {
        if (done) return;
        done = true;
        if (timeoutId) clearTimeout(timeoutId);
        map.off?.("sourcedata", onSourceData);
        map.off?.("idle", onIdle);
      };
      const finish = () => { cleanup(); resolve(true); };
      const isReady = () => {
        try { return typeof map.isSourceLoaded === "function" && map.getSource(sourceId) && map.isSourceLoaded(sourceId); }
        catch (_) { return false; }
      };
      const onSourceData = (e) => { if (e?.sourceId === sourceId && (e.isSourceLoaded || isReady())) finish(); };
      const onIdle = () => { if (isReady()) finish(); };
      if (isReady()) { resolve(true); return; }
      map.on("sourcedata", onSourceData);
      map.on("idle", onIdle);
      timeoutId = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    });
  }

  // Warms the two neighboring time steps (prev + next) in the background,
  // fire-and-forget — called right after any step becomes active so
  // scrubbing/playing in either direction usually lands on an
  // already-ready frame instead of a cold fetch.
  #preloadAdjacentWmsTimes(entry, index) {
    if (!entry?.wmsTimes?.length) return;
    const len = entry.wmsTimes.length;
    [(index + 1) % len, (index - 1 + len) % len].forEach((idx) => {
      const ref = this.#ensureWmsTimeLayer(entry, idx);
      if (ref) this.#waitForWmsSourceReady(ref.sourceId).catch(() => {});
    });
  }

  // Makes one time index the visible one: wait for its tiles, then set
  // every cached frame's opacity in ONE pass (target → real opacity,
  // every other cached frame → 0) — a single atomic-looking swap, not a
  // sequence of individual add/remove calls that could show an
  // intermediate empty state.
  async #activateWmsTimeLayer(entry, index, requestSeq) {
    const map = this.#map;
    const ref = this.#ensureWmsTimeLayer(entry, index);
    if (!ref) return false;
    this.#setWmsTimeCtrlLoading(entry, true);
    await this.#waitForWmsSourceReady(ref.sourceId);
    if (requestSeq !== entry._wmsTimeRequestSeq) return false; // superseded by a newer request while we waited — drop it

    const opacity = this.#getWmsLayerOpacity(entry);
    entry._wmsTimeCache?.forEach((layerRef) => {
      if (map.getLayer(layerRef.layerId)) {
        map.setPaintProperty(layerRef.layerId, "raster-opacity", layerRef.layerId === ref.layerId ? opacity : 0);
      }
    });
    entry._wmsActiveTimeLayerId = ref.layerId;
    entry.wmsTimeIndex = index;
    entry.wmsTime = entry.wmsTimes[index];
    this.#updateWmsTimeCtrlUI(entry, index);
    this.#setWmsTimeCtrlLoading(entry, false);
    this.#preloadAdjacentWmsTimes(entry, index);
    return true;
  }

  // requestSeq exists because #activateWmsTimeLayer is async (it awaits
  // tile readiness) — between when it starts and when that await
  // resolves, the user can have scrubbed again or hit stop. Every call
  // here (scrub OR one playback tick) bumps a per-entry counter and
  // captures its own value; the async call checks it's still the LATEST
  // increment before touching any paint property, or silently bails.
  // Without this, a stale call finishing late would visually flash a
  // previous frame back into view over the correct current one.
  async #setWmsLayerTimeIndex(entry, index) {
    if (!entry?.wmsTimes?.length) return;
    const clamped = Math.max(0, Math.min(index, entry.wmsTimes.length - 1));
    const requestSeq = (entry._wmsTimeRequestSeq || 0) + 1;
    entry._wmsTimeRequestSeq = requestSeq;

    if (entry.wmsTimes.length > 1) {
      return this.#activateWmsTimeLayer(entry, clamped, requestSeq);
    }
    // Exactly one time step: no cache/crossfade machinery needed, just
    // point the one existing source at the (only) time value directly.
    entry.wmsTimeIndex = clamped;
    entry.wmsTime = entry.wmsTimes[clamped];
    const tileUrl = this.#buildWmsTileUrl(entry.wmsRawUrl, entry.wmsLayerName, { time: entry.wmsTime });
    const proxiedTileUrl = this.#proxyWmsTileUrl(tileUrl);
    const src = this.#map.getSource(entry.sourceId);
    if (src && typeof src.setTiles === "function") src.setTiles([proxiedTileUrl]);
    this.#updateWmsTimeCtrlUI(entry, clamped);
  }

  #delayWmsPlayback(ms, entry, token) {
    return new Promise((resolve) => {
      setTimeout(() => resolve(entry._wmsPlayToken === token && entry._wmsPlayTimer), ms);
    });
  }

  // Two INDEPENDENT token mechanisms working together, not one:
  //   _wmsTimeRequestSeq — is this specific frame activation still current
  //     (could be issued by playback OR manual scrubbing)?
  //   _wmsPlayToken       — is this playback SESSION still running (has
  //     the user pressed stop, or play again, since it started)?
  // Playback stopping on the very next check (not "one more frame later")
  // depends on bumping BOTH — stopping only the play token would still
  // let an in-flight activation finish and flip opacities after the user
  // thought they'd stopped it.
  #toggleWmsLayerPlay(entry) {
    if (!entry?.wmsTimes?.length || entry.wmsTimes.length < 2) return;

    if (entry._wmsPlayTimer) {
      entry._wmsPlayToken = (entry._wmsPlayToken || 0) + 1;
      entry._wmsTimeRequestSeq = (entry._wmsTimeRequestSeq || 0) + 1;
      entry._wmsPlayTimer = null;
      this.#setWmsTimeCtrlLoading(entry, false);
    } else {
      const token = (entry._wmsPlayToken || 0) + 1;
      entry._wmsPlayToken = token;
      entry._wmsPlayTimer = true;
      const runPlayback = async () => {
        while (entry._wmsPlayTimer && entry._wmsPlayToken === token) {
          this.#preloadAdjacentWmsTimes(entry, entry.wmsTimeIndex);
          const next = (entry.wmsTimeIndex + 1) % entry.wmsTimes.length;
          await this.#setWmsLayerTimeIndex(entry, next);
          if (!(await this.#delayWmsPlayback(this.#WMS_PLAY_INTERVAL_MS, entry, token))) break;
        }
      };
      this.#refreshImportList();
      runPlayback().catch((err) => this.#setImportStatus(`WMS playback failed: ${err?.message || "unknown error"}`, false));
      return;
    }
    this.#refreshImportList();
  }

  #setWmsTimeCtrlLoading(entry, loading) {
    entry._wmsTimeLoading = !!loading;
    const card = document.querySelector(`.gis-import-row[data-imp-id="${entry.id}"]`);
    const ctrl = card?.querySelector(".gis-wms-time-ctrl");
    const slider = card?.querySelector(`[data-wms-time-slider="${entry.id}"]`);
    if (ctrl) ctrl.classList.toggle("loading", !!loading);
    if (slider) slider.disabled = !!loading && !!entry._wmsPlayTimer; // only lock the slider during autoplay, not manual scrubbing
  }

  #updateWmsTimeCtrlUI(entry, index) {
    const card = document.querySelector(`.gis-import-row[data-imp-id="${entry.id}"]`);
    const slider = card?.querySelector(`[data-wms-time-slider="${entry.id}"]`);
    const label = card?.querySelector(`[data-wms-time-label="${entry.id}"]`);
    if (slider) slider.value = String(index);
    if (label) label.textContent = this.#formatWmsTimeLabel(entry.wmsTimes[index]);
  }

  // Only rendered for a card when wmsTimes.length > 1 (see
  // #renderImportedLayersListHTML) — a single-step or non-temporal WMS
  // layer never shows this control at all.
  #renderWmsTimeCtrlHTML(l) {
    const idx = Math.max(0, Math.min(l.wmsTimeIndex, l.wmsTimes.length - 1));
    const playing = !!l._wmsPlayTimer;
    const loading = !!l._wmsTimeLoading;
    const playIcon = playing
      ? `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>`
      : `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
    return `
      <div class="gis-wms-time-ctrl${loading ? " loading" : ""}">
        <button type="button" class="gis-wms-time-play-btn${playing ? " playing" : ""}" data-wms-time-play="${this.#esc(l.id)}" title="${playing ? "Pause" : "Play"} time animation" aria-label="${playing ? "Pause" : "Play"} time animation">${playIcon}</button>
        <input type="range" min="0" max="${l.wmsTimes.length - 1}" value="${idx}" step="1" data-wms-time-slider="${this.#esc(l.id)}"${loading && playing ? " disabled" : ""}>
        <span class="gis-wms-time-label" data-wms-time-label="${this.#esc(l.id)}">${this.#esc(this.#formatWmsTimeLabel(l.wmsTimes[idx]))}</span>
      </div>`;
  }
}
