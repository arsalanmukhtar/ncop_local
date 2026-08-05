// ==========================================================================
// crop-explorer-control.js
// --------------------------------------------------------------------------
// Standalone Crop Data Explorer for NCOP.
//
// Provides a draggable + resizable modal — self-contained data explorer
// for the Pakistan Bureau of Statistics' Crops dashboard
// (na.data.gov.pk/Crops), proxied through the /api/crops/* endpoints.
//
// Access model: NO rail button.  The modal is launched from the
// "Open Crop Explorer" button inside the crop-choropleth layer's popup
// (see the crop_* dispatch branch in layer-attribute-popup.js).  A
// global `window.__openCropExplorer(cropId?, year?)` is exposed so the
// popup — or any other future consumer — can request the modal with
// a specific crop pre-selected.
//
//   * Crop picker (121 crops) + fiscal-year picker (~44 years)
//   * Left panel: current-year National card — area, production, yield
//   * Right panel: 4 tabs, all Chart.js-backed:
//        - Time Series        : 40+ years of yearly production / area / yield
//        - Province Map       : horizontal bar of per-province production
//        - Province Table     : tabular breakdown incl. yield ranking
//        - About              : source + methodology
//
// Zero coupling to existing map layers, popups, or NCOP dispatch chains.
// Same drag/resize pattern as .heatwave-modal / .ipc-modal so the CSS can
// share the shared --popup-* var palette.
// ==========================================================================
import Chart from "chart.js/auto";

const MODAL_ID  = "crop-explorer-modal";
const CHART_KEY = "crop-modal-chart";

// Default open state — Wheat is the marquee crop in Pakistani
// agricultural policy; 2024-25 is the most recent published fiscal year.
const DEFAULT_CROP  = 4;         // Wheat
const DEFAULT_YEAR  = "2024-25";
const DEFAULT_LEVEL = "11";      // 11 = Province, 13 = District
const DIST_LEVEL    = "13";
const DEFAULT_AREA  = "0";       // 0 = national aggregate

// Chart palette — semi-arid greens for cropland, matching the existing
// NCOP crop iconography.
const CROP_PALETTE = {
  area:       "#4c9a2a",
  production: "#0b5ea8",
  yield:      "#c17a1d",
};

const chartInstances = {};

// -- Small helpers -----------------------------------------------------------
function _fmtNum(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(digits)}M`;
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(digits)}k`;
  return n.toFixed(digits);
}
function _themedColor(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName);
  return (v && v.trim()) || fallback;
}
function _escape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default class CropExplorerControl {
  #map;
  #modalEl  = null;
  #ready    = false;

  // In-memory session cache — /api/crops responses are already cached
  // 24 h server-side, but memoising in JS avoids a second round-trip
  // when the user opens the modal multiple times in one session.
  #crops   = null;
  #years   = null;
  #summary = null;
  #yearly  = null;
  #mapData = null;
  // District-level GetMap payload — same shape as #mapData but ~150 rows.
  #distData = null;

  // Current picker state
  #cropId  = DEFAULT_CROP;
  #year    = DEFAULT_YEAR;
  #tab     = "series";

  constructor(map) {
    this.#map = map;
    // Expose the launcher globally so the crop-choropleth popup can
    // request the modal with a specific crop pre-selected without
    // needing an import.  The optional args mirror the sidebar layer's
    // (cropId, year) — either can be omitted to keep the modal's
    // current state.
    if (typeof window !== "undefined") {
      window.__openCropExplorer = (cropId, year) => {
        if (cropId != null) this.#cropId = Number(cropId) || DEFAULT_CROP;
        if (year   != null) this.#year   = String(year)   || DEFAULT_YEAR;
        this.#open();
      };
    }
  }

  // -----------------------------------------------------------------
  //  Modal open / close lifecycle
  // -----------------------------------------------------------------
  async #open() {
    this.#ensureModal();
    this.#modalEl.classList.remove("hidden");
    requestAnimationFrame(() => this.#modalEl.classList.add("is-open"));
    // Sync the picker DOM to the (possibly-just-changed) instance state.
    const cropSel = this.#modalEl.querySelector("#crop-modal-crop");
    const yearSel = this.#modalEl.querySelector("#crop-modal-year");
    if (cropSel) cropSel.value = String(this.#cropId);
    if (yearSel) yearSel.value = this.#year;
    if (!this.#ready) {
      await this.#bootstrap();
    } else {
      // Refresh data for the (possibly-new) crop+year selection, then
      // re-render the current tab.
      await this.#refreshAllData();
      this.#renderTab(this.#tab);
    }
  }

  #close() {
    if (!this.#modalEl) return;
    this.#modalEl.classList.remove("is-open");
    setTimeout(() => this.#modalEl?.classList.add("hidden"), 260);
    if (chartInstances[CHART_KEY]) {
      try { chartInstances[CHART_KEY].destroy(); } catch (_) {}
      delete chartInstances[CHART_KEY];
    }
  }

  // -----------------------------------------------------------------
  //  Modal DOM (built once, reused across opens)
  // -----------------------------------------------------------------
  #ensureModal() {
    if (this.#modalEl) return this.#modalEl;
    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.className = "crop-modal hidden";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Crop Data Explorer");
    modal.innerHTML = `
      <div class="crop-modal__head" data-crop-drag>
        <div class="crop-modal__drag-grip" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="crop-modal__title-block">
          <div class="crop-modal__kicker">Pakistan Bureau of Statistics · Crops</div>
          <div class="crop-modal__title" id="crop-modal-title">Crop Data Explorer</div>
          <div class="crop-modal__subtitle" id="crop-modal-sub">
            40+ years of national + provincial crop production, area, and yield.
          </div>
        </div>
        <button type="button" class="crop-modal__close" aria-label="Close" data-crop-close>×</button>
      </div>

      <div class="crop-modal__pickers">
        <label class="crop-modal__picker">
          <span>Crop</span>
          <select id="crop-modal-crop" aria-label="Crop"></select>
        </label>
        <label class="crop-modal__picker">
          <span>Fiscal year</span>
          <select id="crop-modal-year" aria-label="Fiscal year"></select>
        </label>
      </div>

      <div class="crop-modal__body">
        <aside class="crop-modal__left">
          <div class="crop-modal__stats" id="crop-modal-stats"></div>
          <div class="crop-modal__note">
            Numbers reflect the National aggregate for the selected fiscal year.
            The right pane breaks the same year down by <b>Province</b> and
            <b>District</b> — District Map shows the top-20 producers, District Table
            has every reporting district ranked by production share.
          </div>
        </aside>
        <section class="crop-modal__right">
          <div class="crop-modal__tabs" role="tablist">
            <button class="crop-modal__tab is-active" data-mode="series"   type="button">Time Series</button>
            <button class="crop-modal__tab"          data-mode="provmap"  type="button">Province Map</button>
            <button class="crop-modal__tab"          data-mode="provtable" type="button">Province Table</button>
            <button class="crop-modal__tab"          data-mode="distmap"  type="button">District Map</button>
            <button class="crop-modal__tab"          data-mode="disttable" type="button">District Table</button>
            <button class="crop-modal__tab"          data-mode="about"     type="button">About</button>
          </div>
          <div class="crop-modal__chart-wrap">
            <div class="crop-modal__chart-head">
              <div class="crop-modal__chart-title" id="crop-modal-ct">Time Series</div>
              <div class="crop-modal__chart-sub"   id="crop-modal-cs"></div>
            </div>
            <div class="crop-modal__canvas-host">
              <canvas id="crop-modal-canvas"></canvas>
              <div class="crop-modal__info-body" id="crop-modal-info-body" style="display:none;"></div>
              <div class="crop-modal__loader" id="crop-modal-loader" style="display:none;"><span></span><span></span><span></span></div>
            </div>
            <div class="crop-modal__footnote">
              Data: PBS Crop Reporting Service via na.data.gov.pk — proxied through NCOP,
              cached 24&nbsp;h server-side.
            </div>
          </div>
        </section>
      </div>

      <div class="crop-modal__resize" data-crop-resize aria-label="Resize">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M14 6 L6 14 M14 10 L10 14" stroke="currentColor" stroke-width="1.6"
                fill="none" stroke-linecap="round"/>
        </svg>
      </div>
    `;
    document.body.appendChild(modal);
    this.#modalEl = modal;

    // Wire buttons
    modal.querySelector("[data-crop-close]")?.addEventListener("click", () => this.#close());
    modal.querySelector("#crop-modal-crop")?.addEventListener("change", (e) => {
      this.#cropId = Number(e.target.value) || DEFAULT_CROP;
      this.#invalidateAndRerender();
    });
    modal.querySelector("#crop-modal-year")?.addEventListener("change", (e) => {
      this.#year = e.target.value || DEFAULT_YEAR;
      this.#invalidateAndRerender();
    });
    modal.querySelectorAll(".crop-modal__tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        modal.querySelectorAll(".crop-modal__tab")
             .forEach((t) => t.classList.toggle("is-active", t === btn));
        this.#tab = btn.getAttribute("data-mode");
        this.#renderTab(this.#tab);
      });
    });

    this.#attachDragAndResize(modal);
    return modal;
  }

  // -----------------------------------------------------------------
  //  Data lifecycle
  // -----------------------------------------------------------------
  async #bootstrap() {
    // Load the crop + year dropdowns in parallel, then the first data set.
    try {
      const [cropsR, yearsR] = await Promise.all([
        fetch(`${window.location.origin}/api/crops/list/`,  { credentials: "same-origin" }).then((r) => r.json()),
        fetch(`${window.location.origin}/api/crops/years/`, { credentials: "same-origin" }).then((r) => r.json()),
      ]);
      this.#crops = (cropsR && cropsR.data) || [];
      this.#years = (yearsR && yearsR.data) || [];
      this.#populatePickers();
      this.#ready = true;
      await this.#refreshAllData();
      this.#renderTab(this.#tab);
    } catch (e) {
      console.error("[Crop Explorer] bootstrap failed:", e);
      this.#showInfoBody(
        `<div class="crop-modal__error">Could not load crop metadata. Try again later.</div>`,
        "About"
      );
    }
  }

  #populatePickers() {
    const cropSel = this.#modalEl.querySelector("#crop-modal-crop");
    const yearSel = this.#modalEl.querySelector("#crop-modal-year");
    if (cropSel && this.#crops) {
      cropSel.innerHTML = this.#crops.map((c) =>
        `<option value="${c.id}"${c.id === this.#cropId ? " selected" : ""}>${_escape(c.name)}</option>`
      ).join("");
    }
    if (yearSel && this.#years) {
      yearSel.innerHTML = this.#years.map((y) =>
        `<option value="${_escape(y.id)}"${y.id === this.#year ? " selected" : ""}>${_escape(y.name)}</option>`
      ).join("");
    }
  }

  // Fetch summary + yearly + map for the current (crop, year) tuple.
  // The 3 endpoints are independent so we fire them in parallel; the
  // slowest defines total latency.  Each returns { data: […] }.
  async #refreshAllData() {
    const q   = `crop=${this.#cropId}&year=${this.#year}&level=${DEFAULT_LEVEL}&area=${DEFAULT_AREA}`;
    const qY  = `crop=${this.#cropId}&level=${DEFAULT_LEVEL}&area=${DEFAULT_AREA}`;
    const qM  = `crop=${this.#cropId}&year=${this.#year}&level=${DEFAULT_LEVEL}`;
    const qMD = `crop=${this.#cropId}&year=${this.#year}&level=${DIST_LEVEL}`;
    this.#setLoading(true);
    try {
      // District payload is the largest (~150 rows) but the endpoint is
      // 24 h-cached server-side, so firing it in parallel with the
      // other three costs nothing after the first hit per (crop, year).
      const [sumR, yrR, mapR, distR] = await Promise.all([
        fetch(`${window.location.origin}/api/crops/summary/?${q}`,   { credentials: "same-origin" }).then((r) => r.json()),
        fetch(`${window.location.origin}/api/crops/yearly/?${qY}`,   { credentials: "same-origin" }).then((r) => r.json()),
        fetch(`${window.location.origin}/api/crops/map/?${qM}`,      { credentials: "same-origin" }).then((r) => r.json()),
        fetch(`${window.location.origin}/api/crops/map/?${qMD}`,     { credentials: "same-origin" }).then((r) => r.json()),
      ]);
      this.#summary  = (sumR  && sumR.data)  || [];
      this.#yearly   = (yrR   && yrR.data)   || [];
      this.#mapData  = (mapR  && mapR.data)  || [];
      this.#distData = (distR && distR.data) || [];
      this.#renderStats();
      this.#renderTab(this.#tab);
    } catch (e) {
      console.error("[Crop Explorer] data refresh failed:", e);
    } finally {
      this.#setLoading(false);
    }
  }

  #invalidateAndRerender() {
    // Titles reflect the new selection immediately for feel.
    const cropName = this.#crops?.find((c) => c.id === this.#cropId)?.name || "";
    this.#modalEl.querySelector("#crop-modal-title").textContent =
      cropName ? `${cropName} · ${this.#year}` : "Crop Data Explorer";
    this.#refreshAllData();
  }

  // -----------------------------------------------------------------
  //  Left column
  // -----------------------------------------------------------------
  #renderStats() {
    const stats = this.#modalEl.querySelector("#crop-modal-stats");
    if (!stats) return;
    const row = (this.#summary && this.#summary[0]) || null;
    if (!row) {
      stats.innerHTML = `<div class="crop-modal__stat crop-modal__stat--empty">No National data for this crop / year.</div>`;
      return;
    }
    stats.innerHTML = `
      <div class="crop-modal__stat">
        <div class="crop-modal__stat-label">Area (000 Ha)</div>
        <div class="crop-modal__stat-value" style="color:${CROP_PALETTE.area}">${_fmtNum(row.area, 1)}</div>
      </div>
      <div class="crop-modal__stat">
        <div class="crop-modal__stat-label">Production (000 MT)</div>
        <div class="crop-modal__stat-value" style="color:${CROP_PALETTE.production}">${_fmtNum(row.production, 1)}</div>
      </div>
      <div class="crop-modal__stat">
        <div class="crop-modal__stat-label">Yield (MT / Ha)</div>
        <div class="crop-modal__stat-value" style="color:${CROP_PALETTE.yield}">${(Number(row.yield) || 0).toFixed(3)}</div>
      </div>
    `;
  }

  // -----------------------------------------------------------------
  //  Right column tabs
  // -----------------------------------------------------------------
  #renderTab(mode) {
    const ct  = this.#modalEl.querySelector("#crop-modal-ct");
    const cs  = this.#modalEl.querySelector("#crop-modal-cs");
    const canvas = this.#modalEl.querySelector("#crop-modal-canvas");
    const info   = this.#modalEl.querySelector("#crop-modal-info-body");
    if (chartInstances[CHART_KEY]) {
      try { chartInstances[CHART_KEY].destroy(); } catch (_) {}
      delete chartInstances[CHART_KEY];
    }
    canvas.style.display = "block";
    info.style.display   = "none";

    const cropName = this.#crops?.find((c) => c.id === this.#cropId)?.name || "";

    if (mode === "series") {
      ct.textContent = `Time Series — ${cropName || "Crop"}`;
      cs.textContent = "National totals across every published fiscal year (Area, Production, Yield)";
      this.#drawTimeSeries(canvas);
    } else if (mode === "provmap") {
      ct.textContent = `Province Production — ${cropName || "Crop"} · ${this.#year}`;
      cs.textContent = "Horizontal bar chart of per-province production (000 MT) for the selected year";
      this.#drawProvinceBar(canvas);
    } else if (mode === "provtable") {
      ct.textContent = `Province Table — ${cropName || "Crop"} · ${this.#year}`;
      cs.textContent = "Full per-province breakdown with Area, Production and Yield";
      canvas.style.display = "none";
      info.style.display = "block";
      info.innerHTML = this.#buildProvinceTable();
    } else if (mode === "distmap") {
      ct.textContent = `Top-20 Districts — ${cropName || "Crop"} · ${this.#year}`;
      cs.textContent = "Horizontal bar chart of the twenty largest district-level producers";
      this.#drawDistrictBar(canvas);
    } else if (mode === "disttable") {
      const total = (this.#distData || []).length;
      ct.textContent = `District Table — ${cropName || "Crop"} · ${this.#year}`;
      cs.textContent = total
        ? `Full ranked breakdown of ${total} districts (Area, Production, Yield). Scroll for the tail.`
        : "Full ranked breakdown of every district (Area, Production, Yield).";
      canvas.style.display = "none";
      info.style.display = "block";
      info.innerHTML = this.#buildDistrictTable();
    } else if (mode === "about") {
      ct.textContent = "About this dataset";
      cs.textContent = "Source, cadence, and integration notes";
      canvas.style.display = "none";
      info.style.display = "block";
      info.innerHTML = `
        <dl class="crop-modal__meta-dl">
          <dt>Source</dt><dd>Pakistan Bureau of Statistics — Crop Reporting Service, published via <code>na.data.gov.pk/Crops/*</code>.</dd>
          <dt>Coverage</dt><dd>121 crops · 44 fiscal years (1981-82 to 2024-25) · 4 provinces + AJK + Federal Capital + division + district levels.</dd>
          <dt>Metrics</dt><dd><b>Area</b> in 000 hectares, <b>Production</b> in 000 metric tonnes, <b>Yield</b> in MT per hectare.</dd>
          <dt>Cadence</dt><dd>Annual publication after each fiscal year closes. Cached in NCOP for 24&nbsp;h so repeat opens are instant.</dd>
          <dt>Method</dt><dd>Public JSON API — <b>not scraping</b>. Every endpoint mirrors <code>/Crops/Get*</code> upstream one-for-one under our <code>/api/crops/</code> proxy.</dd>
          <dt>Time Series</dt><dd>Overlays production, area, and yield on a shared X-axis (fiscal year); left Y is production/area (000 MT / 000 Ha), right Y is yield (MT/Ha).</dd>
          <dt>Province Map / Table</dt><dd>Uses PBS's own province IDs (1 KP · 2 Punjab · 3 Sindh · 4 Balochistan · 6 Federal Capital).</dd>
          <dt>District Map / Table</dt><dd>Drills into PBS's <code>level=13</code> feed. Bar chart caps at the top-20 districts for legibility; the table pane lists every reporting district ranked by production and shows each one's share of the national district total.</dd>
        </dl>
      `;
    }
  }

  #drawTimeSeries(canvas) {
    const rows = (this.#yearly || []).filter((r) => r.fiscalyear);
    if (!rows.length) {
      this.#showInfoBody(
        `<div class="crop-modal__error">No time-series data for the selected crop.</div>`,
        "Time Series"
      );
      return;
    }
    const labels = rows.map((r) => String(r.fiscalyear).trim());
    chartInstances[CHART_KEY] = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Area (000 Ha)",
            data: rows.map((r) => Number(r.area) || 0),
            borderColor: CROP_PALETTE.area,
            backgroundColor: CROP_PALETTE.area + "22",
            tension: 0.25, borderWidth: 2, pointRadius: 0, yAxisID: "y",
          },
          {
            label: "Production (000 MT)",
            data: rows.map((r) => Number(r.production) || 0),
            borderColor: CROP_PALETTE.production,
            backgroundColor: CROP_PALETTE.production + "22",
            tension: 0.25, borderWidth: 2, pointRadius: 0, yAxisID: "y",
          },
          {
            label: "Yield (MT / Ha)",
            data: rows.map((r) => Number(r.yield) || 0),
            borderColor: CROP_PALETTE.yield,
            backgroundColor: CROP_PALETTE.yield + "22",
            tension: 0.25, borderWidth: 2, pointRadius: 0, yAxisID: "y2",
            borderDash: [4, 4],
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { color: _themedColor("--popup-text", "#e5eef7"),
                                                   boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: (item) => {
                const v = Number(item.raw) || 0;
                const suffix = item.dataset.yAxisID === "y2" ? " MT/Ha" : "";
                return `${item.dataset.label}: ${v.toLocaleString(undefined,{maximumFractionDigits: 3})}${suffix}`;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: _themedColor("--popup-text-muted", "rgba(203,213,225,0.72)"),
              maxRotation: 45,
              font: { size: 10 },
              autoSkip: true, maxTicksLimit: 15,
            },
          },
          y:  {
            beginAtZero: true, position: "left",
            grid:  { color: "rgba(148,163,184,0.18)" },
            ticks: { color: _themedColor("--popup-text-muted", "rgba(203,213,225,0.72)"),
                     callback: (v) => _fmtNum(v, 0) },
            title: { display: true, text: "Area (000 Ha) · Production (000 MT)",
                     color: _themedColor("--popup-text-muted", "rgba(203,213,225,0.72)"), font: { size: 10 } },
          },
          y2: {
            beginAtZero: true, position: "right",
            grid:  { display: false },
            ticks: { color: CROP_PALETTE.yield,
                     callback: (v) => Number(v).toFixed(1) },
            title: { display: true, text: "Yield (MT / Ha)", color: CROP_PALETTE.yield, font: { size: 10 } },
          },
        },
      },
    });
  }

  #drawProvinceBar(canvas) {
    const rows = (this.#mapData || []).filter((r) => r.name);
    if (!rows.length) {
      this.#showInfoBody(
        `<div class="crop-modal__error">No provincial data for this crop / year.</div>`,
        "Province Map"
      );
      return;
    }
    rows.sort((a, b) => (Number(b.production) || 0) - (Number(a.production) || 0));
    const labels = rows.map((r) => r.name.replace(/^\s+|\s+$/g, ""));
    const productionData = rows.map((r) => Number(r.production) || 0);
    // Colour by rank — largest producer gets the deepest green.
    const shades = ["#124e0a", "#2c8b1a", "#5cb939", "#8fce6b", "#c1e59d", "#e6f2d3"];
    const bg = productionData.map((_, i) => shades[Math.min(i, shades.length - 1)]);
    chartInstances[CHART_KEY] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Production (000 MT)",
          data: productionData,
          backgroundColor: bg,
          borderColor: bg, borderWidth: 0.5, borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const row = rows[item.dataIndex];
                const prod = (Number(row.production) || 0).toLocaleString(undefined,{maximumFractionDigits:1});
                const area = (Number(row.area)       || 0).toLocaleString(undefined,{maximumFractionDigits:1});
                const yld  = (Number(row.yield)      || 0).toFixed(3);
                return [
                  `Production: ${prod} thousand MT`,
                  `Area:       ${area} thousand Ha`,
                  `Yield:      ${yld} MT/Ha`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            grid:  { color: "rgba(148,163,184,0.18)" },
            ticks: { color: _themedColor("--popup-text-muted", "rgba(203,213,225,0.72)"),
                     callback: (v) => _fmtNum(v, 0) },
          },
          y: {
            grid:  { display: false },
            ticks: { color: _themedColor("--popup-text", "#e5eef7"),
                     font: { size: 11, weight: "600" } },
          },
        },
      },
    });
  }

  #buildProvinceTable() {
    const rows = (this.#mapData || []).slice()
      .sort((a, b) => (Number(b.production) || 0) - (Number(a.production) || 0));
    if (!rows.length) {
      return `<div class="crop-modal__error">No provincial data for this crop / year.</div>`;
    }
    return `
      <table class="crop-modal__table">
        <thead>
          <tr>
            <th>#</th>
            <th>Province</th>
            <th style="text-align:right">Area (000 Ha)</th>
            <th style="text-align:right">Production (000 MT)</th>
            <th style="text-align:right">Yield (MT/Ha)</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${_escape(String(r.name || "").trim())}</td>
              <td style="text-align:right; font-variant-numeric: tabular-nums;">${(Number(r.area) || 0).toLocaleString(undefined,{maximumFractionDigits:1})}</td>
              <td style="text-align:right; font-variant-numeric: tabular-nums; color:${CROP_PALETTE.production}; font-weight:600;">${(Number(r.production) || 0).toLocaleString(undefined,{maximumFractionDigits:1})}</td>
              <td style="text-align:right; font-variant-numeric: tabular-nums;">${(Number(r.yield) || 0).toFixed(3)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  // ----- District tabs -----------------------------------------------
  // The `/api/crops/map/?level=13` endpoint returns one row per district
  // (~150 rows total, sparse coverage per crop).  The bar chart shows
  // the twenty largest producers so the axis stays readable; the table
  // tab has the full ranked list.
  #drawDistrictBar(canvas) {
    const rows = (this.#distData || [])
      .filter((r) => r && r.name && (Number(r.production) || 0) > 0);
    if (!rows.length) {
      this.#showInfoBody(
        `<div class="crop-modal__error">No district-level data reported for this crop / year.</div>`,
        "District Map"
      );
      return;
    }
    rows.sort((a, b) => (Number(b.production) || 0) - (Number(a.production) || 0));
    const top = rows.slice(0, 20);
    const labels = top.map((r) => String(r.name || "").trim());
    const production = top.map((r) => Number(r.production) || 0);
    // 20-bar viridis-ish green ramp so the descending order reads
    // visually — darkest at rank 1.
    const shade = (i) => {
      const t = i / Math.max(1, top.length - 1);
      const r = Math.round(12  + (230 - 12)  * t);
      const g = Math.round(78  + (242 - 78)  * t);
      const b = Math.round(10  + (211 - 10)  * t);
      return `rgb(${r},${g},${b})`;
    };
    const bg = top.map((_, i) => shade(i));
    chartInstances[CHART_KEY] = new Chart(canvas.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "Production (000 MT)",
          data: production,
          backgroundColor: bg,
          borderColor: bg, borderWidth: 0.5, borderRadius: 4,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (item) => {
                const row = top[item.dataIndex];
                const prod = (Number(row.production) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
                const area = (Number(row.area)       || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
                const yld  = (Number(row.yield)      || 0).toFixed(3);
                return [
                  `Production: ${prod} thousand MT`,
                  `Area:       ${area} thousand Ha`,
                  `Yield:      ${yld} MT/Ha`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            grid:  { color: "rgba(148,163,184,0.18)" },
            ticks: { color: _themedColor("--popup-text-muted", "rgba(203,213,225,0.72)"),
                     callback: (v) => _fmtNum(v, 0) },
          },
          y: {
            grid:  { display: false },
            ticks: { color: _themedColor("--popup-text", "#e5eef7"),
                     font: { size: 10.5, weight: "600" } },
          },
        },
      },
    });
  }

  #buildDistrictTable() {
    const rows = (this.#distData || []).slice()
      .filter((r) => r && r.name)
      .sort((a, b) => (Number(b.production) || 0) - (Number(a.production) || 0));
    if (!rows.length) {
      return `<div class="crop-modal__error">No district-level data reported for this crop / year.</div>`;
    }
    // Aggregate row up top so the reader can compare each district's
    // share against the national district total (which usually equals
    // the National card give-or-take unreported districts).
    const totProd = rows.reduce((s, r) => s + (Number(r.production) || 0), 0);
    const totArea = rows.reduce((s, r) => s + (Number(r.area)       || 0), 0);
    const avgYld  = totArea > 0 ? (totProd / totArea) : 0;

    const body = rows.map((r, i) => {
      const prod = Number(r.production) || 0;
      const share = totProd > 0 ? (prod / totProd) * 100 : 0;
      return `
        <tr>
          <td>${i + 1}</td>
          <td>${_escape(String(r.name || "").trim())}</td>
          <td style="text-align:right; font-variant-numeric: tabular-nums;">${(Number(r.area) || 0).toLocaleString(undefined,{maximumFractionDigits:1})}</td>
          <td style="text-align:right; font-variant-numeric: tabular-nums; color:${CROP_PALETTE.production}; font-weight:600;">${prod.toLocaleString(undefined,{maximumFractionDigits:1})}</td>
          <td style="text-align:right; font-variant-numeric: tabular-nums;">${(Number(r.yield) || 0).toFixed(3)}</td>
          <td style="text-align:right; font-variant-numeric: tabular-nums; color:${CROP_PALETTE.area};">${share.toFixed(1)}%</td>
        </tr>
      `;
    }).join("");

    return `
      <table class="crop-modal__table">
        <thead>
          <tr>
            <th>#</th>
            <th>District</th>
            <th style="text-align:right">Area (000 Ha)</th>
            <th style="text-align:right">Production (000 MT)</th>
            <th style="text-align:right">Yield (MT/Ha)</th>
            <th style="text-align:right">Share</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background: rgba(76,154,42,0.14); font-weight:700;">
            <td>–</td>
            <td>All reporting districts</td>
            <td style="text-align:right; font-variant-numeric: tabular-nums;">${totArea.toLocaleString(undefined,{maximumFractionDigits:1})}</td>
            <td style="text-align:right; font-variant-numeric: tabular-nums; color:${CROP_PALETTE.production};">${totProd.toLocaleString(undefined,{maximumFractionDigits:1})}</td>
            <td style="text-align:right; font-variant-numeric: tabular-nums;">${avgYld.toFixed(3)}</td>
            <td style="text-align:right; font-variant-numeric: tabular-nums;">100.0%</td>
          </tr>
          ${body}
        </tbody>
      </table>
    `;
  }

  #showInfoBody(html, chartTitle) {
    const canvas = this.#modalEl.querySelector("#crop-modal-canvas");
    const info   = this.#modalEl.querySelector("#crop-modal-info-body");
    canvas.style.display = "none";
    info.style.display = "block";
    info.innerHTML = html;
    if (chartTitle) this.#modalEl.querySelector("#crop-modal-ct").textContent = chartTitle;
  }

  #setLoading(on) {
    const loader = this.#modalEl.querySelector("#crop-modal-loader");
    if (loader) loader.style.display = on ? "flex" : "none";
  }

  // -----------------------------------------------------------------
  //  Drag + resize — self-contained (no coupling to heatwave/IPC helpers).
  // -----------------------------------------------------------------
  #attachDragAndResize(modal) {
    const drag   = modal.querySelector("[data-crop-drag]");
    const resize = modal.querySelector("[data-crop-resize]");

    const pin = () => {
      const r = modal.getBoundingClientRect();
      modal.style.left   = `${Math.round(r.left)}px`;
      modal.style.top    = `${Math.round(r.top)}px`;
      modal.style.right  = "auto";
      modal.style.bottom = "auto";
      modal.style.width  = `${Math.round(r.width)}px`;
      modal.style.height = `${Math.round(r.height)}px`;
    };

    if (drag) {
      drag.addEventListener("pointerdown", (e) => {
        if (e.target.closest("[data-crop-close]")) return;
        if (e.target.closest("select")) return;
        if (e.button !== undefined && e.button !== 0) return;
        pin();
        const sx = e.clientX, sy = e.clientY;
        const sl = parseFloat(modal.style.left) || 0;
        const st = parseFloat(modal.style.top)  || 0;
        modal.classList.add("is-dragging");
        try { drag.setPointerCapture(e.pointerId); } catch (_) {}
        const move = (ev) => {
          const m = 8, w = modal.offsetWidth, h = modal.offsetHeight;
          let nl = sl + (ev.clientX - sx), nt = st + (ev.clientY - sy);
          nl = Math.max(m, Math.min(window.innerWidth  - w - m, nl));
          nt = Math.max(m, Math.min(window.innerHeight - h - m, nt));
          modal.style.left = `${Math.round(nl)}px`;
          modal.style.top  = `${Math.round(nt)}px`;
        };
        const up = () => {
          modal.classList.remove("is-dragging");
          try { drag.releasePointerCapture(e.pointerId); } catch (_) {}
          drag.removeEventListener("pointermove", move);
          drag.removeEventListener("pointerup",   up);
          drag.removeEventListener("pointercancel", up);
        };
        drag.addEventListener("pointermove", move);
        drag.addEventListener("pointerup",   up);
        drag.addEventListener("pointercancel", up);
        e.preventDefault();
      });
    }
    if (resize) {
      const minW = 620, minH = 380;
      resize.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        pin();
        const sx = e.clientX, sy = e.clientY;
        const sw = modal.offsetWidth, sh = modal.offsetHeight;
        const sl = parseFloat(modal.style.left) || 0;
        const st = parseFloat(modal.style.top)  || 0;
        modal.classList.add("is-resizing");
        try { resize.setPointerCapture(e.pointerId); } catch (_) {}
        const move = (ev) => {
          const m = 8;
          const w = Math.max(minW, Math.min(window.innerWidth  - sl - m, sw + (ev.clientX - sx)));
          const h = Math.max(minH, Math.min(window.innerHeight - st - m, sh + (ev.clientY - sy)));
          modal.style.width  = `${Math.round(w)}px`;
          modal.style.height = `${Math.round(h)}px`;
        };
        const up = () => {
          modal.classList.remove("is-resizing");
          try { resize.releasePointerCapture(e.pointerId); } catch (_) {}
          resize.removeEventListener("pointermove", move);
          resize.removeEventListener("pointerup",   up);
          resize.removeEventListener("pointercancel", up);
        };
        resize.addEventListener("pointermove", move);
        resize.addEventListener("pointerup",   up);
        resize.addEventListener("pointercancel", up);
        e.preventDefault();
        e.stopPropagation();
      });
    }
  }
}