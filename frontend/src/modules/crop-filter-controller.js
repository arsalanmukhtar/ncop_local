// ==========================================================================
// crop-filter-controller.js
// --------------------------------------------------------------------------
// Injects a "Filter by crop type" card ABOVE the Agriculture subcategory's
// toggle rows in the sidebar.  Mirrors the visual pattern of
// pmd-warnings-filter.js — same class prefix conventions, same MutationObserver
// injection strategy, same colour tokens — but the semantics are different:
//
//   * Single-select (radio-style) — a choropleth only paints ONE variable.
//   * 121 crops served from /api/crops/list/ (cached 24h server-side).
//     Big list, so the card includes a small search box that filters the
//     rows client-side.
//   * On selection change, ALL active crop_* map sources (provincial +
//     district) have their `data` URL rewritten to point at the new
//     crop id.  Mapbox's setData accepts a URL and refetches — no
//     addSource/removeLayer churn.
//
// Zero coupling to the crop-explorer modal.  Fires a
// `ncop-crop-selection-changed` CustomEvent on window so any future
// consumer (Chart panel, download button, …) can react.
// ==========================================================================

const TOGGLE_KEYS = ["crop_provincial", "crop_district"];
const HOST_CLASS  = "ncop-crop-filter";
const STYLE_ID    = "ncop-crop-filter-styles";
const YEAR        = "2024-25";

// Default crop rendered when the filter first mounts.
const DEFAULT_CROP_ID = 4; // Wheat

// Per-crop production stops (000 MT) for provincial + district layers.
// Numbers are computed from the observed range of 2024-25 max per level.
// A crop that isn't in the table falls back to WHEAT_STOPS — Mapbox's
// `interpolate` clamps out-of-range values so the ramp still renders,
// it just may not span the full colour gradient.
const CROP_STOPS = {
  //     provincial            district
  4:  { prov: [0,   500, 2000,  6000, 20000], dist: [0,   50, 150,  400, 1500] }, // Wheat
  2:  { prov: [0,   200,  800,  2000,  6000], dist: [0,   20,  80,  200,  800] }, // Rice
  5:  { prov: [0,    50,  300,  1500,  7000], dist: [0,   20,  80,  250, 1000] }, // Cotton
  3:  { prov: [0,   500, 3000, 20000, 60000], dist: [0,  100, 500, 2000, 8000] }, // Sugarcane
  1:  { prov: [0,   200, 1000,  3000,  8000], dist: [0,   30, 100,  300, 1200] }, // Maize
  6:  { prov: [0,   100,  400,  1000,  2500], dist: [0,   15,  50,  150,  600] }, // Tomato
  7:  { prov: [0,    50,  200,   600,  1600], dist: [0,   10,  40,  120,  400] }, // Onion
  8:  { prov: [0,   200,  800,  2500,  6500], dist: [0,   30, 100,  350, 1200] }, // Potato
  12: { prov: [0,    30,  120,   400,  1000], dist: [0,    5,  20,   60,  250] }, // Gram
};
const FALLBACK_STOPS_PROV = [0, 100, 500, 1500, 5000];
const FALLBACK_STOPS_DIST = [0,  10,  50,  150,  600];

function _stopsFor(cropId, level) {
  const t = CROP_STOPS[Number(cropId)];
  if (t) return level === 13 ? t.dist : t.prov;
  return level === 13 ? FALLBACK_STOPS_DIST : FALLBACK_STOPS_PROV;
}

function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .ncop-crop-filter {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 6px 8px 10px;
      padding: 10px 10px 8px;
      background: rgba(76, 154, 42, 0.10);
      border: 1px solid rgba(76, 154, 42, 0.28);
      border-radius: 8px;
      font-size: 12px;
      color: var(--text-primary, #e2e8f0);
    }
    .ncop-crop-filter__title {
      display: flex; align-items: center; justify-content: space-between;
      font-size: 11px; font-weight: 700; letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--text-secondary, #cbd5e1);
    }
    .ncop-crop-filter__counter {
      padding: 1px 8px; border-radius: 999px;
      background: rgba(76, 154, 42, 0.35);
      color: #fff;
      font-size: 10px; font-weight: 700; letter-spacing: 0.4px;
    }
    .ncop-crop-filter__search {
      width: 100%; padding: 5px 9px;
      background: rgba(15, 23, 42, 0.35);
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 6px;
      color: var(--text-primary, #e2e8f0);
      font-size: 11.5px;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .ncop-crop-filter__search:focus {
      border-color: #4c9a2a;
      box-shadow: 0 0 0 3px rgba(76, 154, 42, 0.25);
    }
    .ncop-crop-filter__table {
      max-height: 220px;
      overflow-y: auto;
      display: flex; flex-direction: column;
      gap: 2px;
      padding: 2px 0;
      background: rgba(15, 23, 42, 0.20);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 6px;
    }
    .ncop-crop-filter__table::-webkit-scrollbar { width: 6px; }
    .ncop-crop-filter__table::-webkit-scrollbar-thumb {
      background: rgba(76, 154, 42, 0.55); border-radius: 3px;
    }
    .ncop-crop-filter__row {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .ncop-crop-filter__row:hover { background: rgba(76, 154, 42, 0.18); }
    .ncop-crop-filter__row.is-selected {
      background: rgba(76, 154, 42, 0.35);
      font-weight: 600;
    }
    .ncop-crop-filter__radio {
      width: 12px; height: 12px;
      border-radius: 50%;
      border: 1.5px solid rgba(148, 163, 184, 0.55);
      flex: 0 0 auto;
      position: relative;
      background: rgba(0, 0, 0, 0.22);
      transition: border-color 0.15s ease;
    }
    .ncop-crop-filter__row.is-selected .ncop-crop-filter__radio {
      border-color: #4c9a2a;
      background: #4c9a2a;
    }
    .ncop-crop-filter__row.is-selected .ncop-crop-filter__radio::after {
      content: ""; position: absolute; inset: 2px;
      background: #fff; border-radius: 50%;
    }
    .ncop-crop-filter__label {
      flex: 1 1 auto;
      color: var(--text-primary, #e2e8f0);
      font-size: 11.5px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      text-transform: capitalize;
    }
    .ncop-crop-filter__id {
      color: var(--text-muted, rgba(148, 163, 184, 0.6));
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      font-weight: 500;
    }
    .ncop-crop-filter__empty {
      padding: 10px; text-align: center;
      color: var(--text-muted, rgba(148, 163, 184, 0.7));
      font-size: 11px; font-style: italic;
    }
    [data-theme="night"] .ncop-crop-filter {
      background: rgba(76, 154, 42, 0.14);
    }
    [data-theme="night"] .ncop-crop-filter__search {
      background: rgba(255, 255, 255, 0.65);
      color: #0f172a;
    }
    [data-theme="night"] .ncop-crop-filter__table {
      background: rgba(255, 255, 255, 0.55);
    }
    [data-theme="night"] .ncop-crop-filter__label {
      color: #0f172a;
    }
  `;
  document.head.appendChild(s);
}

class CropFilterController {
  #map     = null;
  #hostEl  = null;
  #tableEl = null;
  #searchEl = null;
  #counterEl = null;
  #crops   = null;      // [{id, name}]
  #selected = DEFAULT_CROP_ID;

  init(map) {
    this.#map = map;
    _injectStyles();
    this.#injectIntoSidebar();
  }

  // Wait for the sidebar to render the crop toggle rows.
  #injectIntoSidebar() {
    if (this.#tryInject()) return;
    const observer = new MutationObserver(() => {
      if (this.#tryInject()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }

  #tryInject() {
    // Anchor above the first crop_* toggle in the sidebar.  Same
    // pattern as PMD warnings filter — we insertBefore that row so the
    // filter card sits at the top of the Agriculture container.
    const anchor = TOGGLE_KEYS
      .map((k) => document.querySelector(`input[data-item-key="${k}"]`))
      .filter(Boolean)[0];
    if (!anchor) return false;
    const row = anchor.closest(".ncop-item-toggle");
    if (!row || !row.parentElement) return false;
    if (row.previousElementSibling?.classList?.contains(HOST_CLASS)) return true;

    this.#hostEl = this.#buildCard();
    row.parentElement.insertBefore(this.#hostEl, row);
    // Kick off the crop list fetch now that the card exists.
    this.#loadCrops();
    return true;
  }

  #buildCard() {
    const wrap = document.createElement("div");
    wrap.className = HOST_CLASS;
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Filter Agriculture layers by crop type");
    wrap.innerHTML = `
      <div class="ncop-crop-filter__title">
        <span>Filter by crop type</span>
        <span class="ncop-crop-filter__counter">Wheat</span>
      </div>
      <input type="search" class="ncop-crop-filter__search"
             placeholder="Search 121 crops…" autocomplete="off"
             aria-label="Search crops">
      <div class="ncop-crop-filter__table" role="listbox" aria-label="Crop options"></div>
    `;
    this.#counterEl = wrap.querySelector(".ncop-crop-filter__counter");
    this.#searchEl  = wrap.querySelector(".ncop-crop-filter__search");
    this.#tableEl   = wrap.querySelector(".ncop-crop-filter__table");
    this.#searchEl.addEventListener("input", () => this.#renderRows());
    return wrap;
  }

  async #loadCrops() {
    try {
      const r = await fetch(`${window.location.origin}/api/crops/list/`,
                            { credentials: "same-origin" });
      const d = await r.json();
      this.#crops = (d && d.data) || [];
      this.#renderRows();
    } catch (e) {
      console.warn("[crop-filter] crop-list fetch failed:", e);
      if (this.#tableEl) {
        this.#tableEl.innerHTML = `<div class="ncop-crop-filter__empty">Crop list unavailable — try refreshing.</div>`;
      }
    }
  }

  #renderRows() {
    if (!this.#tableEl || !this.#crops) return;
    const q = (this.#searchEl?.value || "").trim().toLowerCase();
    const filtered = q
      ? this.#crops.filter((c) => String(c.name || "").toLowerCase().includes(q))
      : this.#crops;
    if (!filtered.length) {
      this.#tableEl.innerHTML = `<div class="ncop-crop-filter__empty">No crops match "${_escape(q)}"</div>`;
      return;
    }
    // Render up to ~500 rows — small DOM, no virtualization needed.
    this.#tableEl.innerHTML = filtered.map((c) => `
      <div class="ncop-crop-filter__row ${c.id === this.#selected ? "is-selected" : ""}"
           role="option" aria-selected="${c.id === this.#selected}"
           data-crop-id="${c.id}"
           title="Show ${_escape(c.name)} on the map">
        <span class="ncop-crop-filter__radio" aria-hidden="true"></span>
        <span class="ncop-crop-filter__label">${_escape(c.name)}</span>
        <span class="ncop-crop-filter__id">#${c.id}</span>
      </div>
    `).join("");
    // Delegated click — one listener via addEventListener on the table.
    this.#tableEl.onclick = (e) => {
      const row = e.target.closest(".ncop-crop-filter__row");
      if (!row) return;
      const id = Number(row.dataset.cropId);
      if (Number.isFinite(id)) this.#select(id);
    };
  }

  #select(cropId) {
    if (cropId === this.#selected) return;
    this.#selected = cropId;
    const name = this.#crops?.find((c) => c.id === cropId)?.name || `Crop #${cropId}`;
    if (this.#counterEl) this.#counterEl.textContent = name;
    // Re-highlight rows without re-rendering the whole list — cheap.
    this.#tableEl.querySelectorAll(".ncop-crop-filter__row").forEach((r) => {
      const isSel = Number(r.dataset.cropId) === cropId;
      r.classList.toggle("is-selected", isSel);
      r.setAttribute("aria-selected", isSel ? "true" : "false");
    });
    this.#refreshMapSources(cropId);
    window.dispatchEvent(new CustomEvent("ncop-crop-selection-changed", {
      detail: { cropId, cropName: name, year: YEAR },
    }));
  }

  // Rewrite the geojson data URL on any currently-registered crop_*
  // source AND update the fill-color interpolate stops to match the
  // new crop's magnitude.  If a source doesn't exist yet (toggle is
  // off), the /api/crops/geojson/ URL baked into map-layers.js is
  // updated so a later toggle-on picks up the current selection.
  #refreshMapSources(cropId) {
    if (!this.#map) return;
    const menu = window.ncop_menu_items || {};
    // Scan every top-level category for the crop-production subcategory.
    // History: block lived under `gis_layers` originally, then moved to
    // `agriculture_food`; the subcategory itself was renamed from
    // "Agriculture" → "Crop Production" to match its toggle labels.
    // Falling back to the old name keeps this working across the rename.
    const SUBCAT_NAMES = ["Crop Production", "Agriculture"];
    const toggles = (function _findCropToggles() {
      for (const catKey of Object.keys(menu)) {
        const cat = menu[catKey];
        if (!cat) continue;
        for (const name of SUBCAT_NAMES) {
          if (cat[name] && cat[name].toggle) return cat[name].toggle;
        }
      }
      return {};
    })();
    for (const key of Object.keys(toggles)) {
      const cfg = toggles[key];
      if (!cfg || !cfg._ncop_level) continue;
      const level = cfg._ncop_level;
      const newUrl = `${window.location.origin}/api/crops/geojson/?crop=${cropId}&year=${YEAR}&level=${level}`;
      // Update the source config so subsequent toggle-on uses the new URL.
      if (cfg.source) cfg.source.data = newUrl;
      // Update the stops per crop.  Layer paint expression is baked
      // at addLayer time; we re-set fill-color if the layer exists.
      const newStops = _stopsFor(cropId, level);
      cfg._ncop_stops = newStops;

      // Rewrite live source if the toggle is currently ON.
      const src = this.#map.getSource(cfg.source?.id || `${key}-source`);
      if (src && typeof src.setData === "function") {
        try { src.setData(newUrl); } catch (e) {
          console.warn(`[crop-filter] setData failed for ${key}:`, e);
        }
      }
      // Rewrite fill-color paint if the layer is present, using the
      // same `case + interpolate` shape map-layers.js used at boot.
      const fillLayerId = `${key}-fill`;
      if (this.#map.getLayer(fillLayerId)) {
        try {
          this.#map.setPaintProperty(fillLayerId, "fill-color", [
            "case",
            ["!=", ["get", "has_data"], true], "#e5e7eb",
            [
              "interpolate", ["linear"],
              ["to-number", ["coalesce", ["get", "production"], 0]],
              newStops[0], "#f7fcf5",
              newStops[1], "#c7e9c0",
              newStops[2], "#74c476",
              newStops[3], "#238b45",
              newStops[4], "#00441b",
            ],
          ]);
        } catch (e) {
          console.warn(`[crop-filter] setPaintProperty failed for ${fillLayerId}:`, e);
        }
      }
    }
  }
}

function _escape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const cropFilter = new CropFilterController();

export function initCropFilter(map) {
  cropFilter.init(map);
  return cropFilter;
}