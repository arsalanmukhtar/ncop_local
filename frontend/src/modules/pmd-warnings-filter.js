// ===========================================================================
// pmd-warnings-filter.js
// ---------------------------------------------------------------------------
// Pre-filter for the "PMD Weather Warnings" (pmd_warnings) layer.
//
// Sits in the sidebar directly above the pmd_warnings toggle row.  It is
// NOT a separate layer — it just decides which of the 13 hazard families
// (Rainstorm, Heatwave, Severe Convection, Gale, Fog/Visibility, Heavy
// Rainfall, Snowstorm, Cold Wave, Dust Storm, Thunderstorm, Lightning,
// Flood, Hail) the pmd_warnings polygons should surface.
//
// Behaviour (per spec):
//   - Empty selection            → filter cleared, every warning shown.
//   - Ticking any box            → filter applied AND (if the layer is
//                                  currently off) the layer's master
//                                  toggle is flipped on automatically.
//   - Unticking every box        → filter cleared but the layer stays on.
//   - Filter change fires an event `pmd-warnings-filter-changed` so the
//     Weather Report panel can re-render its own PMD-warnings section.
//
// Data hand-off:
//   The row-level colored badges (TPE / TEM / CONV / …) are for scanning
//   the LIST — they are not the on-map colors.  Map polygons stay colored
//   by SEVERITY (`level` = blue / yellow / orange / red / gust / t-storm)
//   as before.  Filtering is by hazard TYPE only.
// ===========================================================================

const SOURCE_ID       = "pmd_warnings-source";
const FILL_LAYER_ID   = "pmd_warnings-fill";
const OUTLINE_LAYER_ID = "pmd_warnings-outline";
const TOGGLE_KEY      = "pmd_warnings";

// -------------------------------------------------------------------------
// Hazard-type dictionary.
//
//   code       — stable id used in the Set of active filters
//   label      — human-readable row title
//   badge      — short code shown as a colored chip (list-scanning aid)
//   badgeBg    — chip background; row-level colour — NOT the map colour
//   badgeText  — chip text colour (default white; overridden for light bgs)
//   codes      — element short-codes we accept from the API (upper-cased)
//   patterns   — case-insensitive substrings of `element_label` we accept
//
// codes[] + patterns[] are both consulted per feature so we're resilient
// to API variations (upstream sometimes emits `TPE`, sometimes emits
// "Rainstorm", sometimes emits both).
// -------------------------------------------------------------------------
export const HAZARD_TYPES = [
  { code: "RAINSTORM", label: "Rainstorm",         badge: "TPE",  badgeBg: "#6366f1", codes: ["TPE", "RS"],           patterns: ["rainstorm", "torrential"] },
  { code: "HEATWAVE",  label: "Heatwave",          badge: "TEM",  badgeBg: "#f97316", codes: ["TEM", "HW"],           patterns: ["heat wave", "heatwave", "high temperature"] },
  { code: "CONV",      label: "Severe Convection", badge: "CONV", badgeBg: "#8b5cf6", codes: ["CONV", "SCV"],         patterns: ["convection", "convective"] },
  { code: "GALE",      label: "Gale",              badge: "GALE", badgeBg: "#14b8a6", codes: ["GALE", "GL"],          patterns: ["gale", "strong wind"] },
  { code: "FOG",       label: "Fog / Visibility",  badge: "FOG",  badgeBg: "#64748b", codes: ["FOG", "VIS"],          patterns: ["fog", "visibility", "haze", "mist"] },
  { code: "HRAIN",     label: "Heavy Rainfall",    badge: "RAIN", badgeBg: "#0ea5e9", codes: ["HRAIN", "RAIN", "HRF"], patterns: ["heavy rain", "rainfall"] },
  { code: "SNOW",      label: "Snowstorm",         badge: "SNOW", badgeBg: "#e2e8f0", badgeText: "#0f172a", codes: ["SNOW", "SS"], patterns: ["snowstorm", "blizzard", "snow"] },
  { code: "COLD",      label: "Cold Wave",         badge: "COLD", badgeBg: "#0369a1", codes: ["COLD", "CW"],          patterns: ["cold wave", "cold surge", "cold spell"] },
  { code: "DUST",      label: "Dust Storm",        badge: "DUST", badgeBg: "#a16207", codes: ["DUST", "DS"],          patterns: ["dust storm", "sandstorm", "dust"] },
  { code: "TSTM",      label: "Thunderstorm",      badge: "TSTM", badgeBg: "#a21caf", codes: ["TSTM", "THDR"],        patterns: ["thunderstorm", "thundery"] },
  { code: "LTNG",      label: "Lightning",         badge: "LTNG", badgeBg: "#facc15", badgeText: "#0f172a", codes: ["LTNG", "LGT"], patterns: ["lightning"] },
  { code: "FLD",       label: "Flood",             badge: "FLD",  badgeBg: "#dc2626", codes: ["FLD", "FLOOD"],        patterns: ["flood"] },
  { code: "HAIL",      label: "Hail",              badge: "HAIL", badgeBg: "#0891b2", codes: ["HAIL"],                patterns: ["hail"] },
];

// -------------------------------------------------------------------------
// Style block — injected once, on first controller boot.
// -------------------------------------------------------------------------
const STYLE_TAG_ID = "ncop-pmd-warnings-filter-style";
function injectStyles() {
  if (document.getElementById(STYLE_TAG_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_TAG_ID;
  style.textContent = `
    .ncop-pmd-warnings-filter {
      display: block;
      padding: 8px 10px 6px;
      margin: 6px 0 2px;
      background: rgba(15, 23, 42, 0.35);
      border: 1px solid rgba(148, 163, 184, 0.15);
      border-radius: 8px;
      cursor: default;
    }
    .ncop-pmd-warnings-filter__title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      font-weight: 700;
      color: rgba(203, 213, 225, 0.95);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 6px;
    }
    .ncop-pmd-warnings-filter__title::before {
      content: "";
      width: 6px; height: 6px; border-radius: 999px;
      background: #3b82f6;
      box-shadow: 0 0 6px rgba(59, 130, 246, 0.7);
    }
    .ncop-pmd-warnings-filter__counter {
      margin-left: auto;
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.18);
      color: #93c5fd;
      font-size: 9.5px;
      letter-spacing: 0.2px;
      font-weight: 600;
    }
    .ncop-pmd-warnings-filter__table {
      display: grid;
      grid-template-columns: 1fr;
      gap: 1px;
      max-height: 240px;
      overflow-y: auto;
      overflow-x: hidden;
    }
    .ncop-pmd-warnings-filter__table::-webkit-scrollbar { width: 4px; }
    .ncop-pmd-warnings-filter__table::-webkit-scrollbar-thumb {
      background: rgba(148, 163, 184, 0.25); border-radius: 4px;
    }
    .ncop-pmd-warnings-filter__row {
      display: grid;
      grid-template-columns: 16px 46px 1fr;
      gap: 8px;
      align-items: center;
      padding: 3px 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11.5px;
      transition: background 0.14s ease;
    }
    .ncop-pmd-warnings-filter__row:hover { background: rgba(59, 130, 246, 0.08); }
    .ncop-pmd-warnings-filter__row.is-active { background: rgba(59, 130, 246, 0.14); }
    .ncop-pmd-warnings-filter__checkbox {
      accent-color: #3b82f6;
      cursor: pointer;
      margin: 0;
    }
    .ncop-pmd-warnings-filter__badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.5px;
      line-height: 1;
      color: #fff;
      white-space: nowrap;
    }
    .ncop-pmd-warnings-filter__label {
      color: rgba(226, 232, 240, 0.92);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ncop-pmd-warnings-filter__actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 4px;
    }
    .ncop-pmd-warnings-filter__clear {
      background: transparent;
      border: 1px solid rgba(148, 163, 184, 0.28);
      color: rgba(203, 213, 225, 0.9);
      font-size: 10px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 999px;
      cursor: pointer;
      letter-spacing: 0.3px;
      transition: all 0.15s ease;
    }
    .ncop-pmd-warnings-filter__clear:hover {
      border-color: rgba(148, 163, 184, 0.5);
      color: #fff;
    }
    .ncop-pmd-warnings-filter__clear:disabled {
      opacity: 0.4;
      cursor: default;
    }
  `;
  document.head.appendChild(style);
}

// -------------------------------------------------------------------------
// Controller
// -------------------------------------------------------------------------
class PmdWarningsFilterController {
  #map = null;
  #selected = new Set();  // hazard-type `code`s
  #rawFeatures = [];      // last snapshot of pmd_warnings-source._data
  #hostEl = null;         // our injected filter card
  #counterEl = null;
  #clearBtnEl = null;

  attach(map) {
    if (!map || this.#map === map) return;
    this.#map = map;
    injectStyles();
    this.#injectIntoSidebar();
    this.#wireSourceListener();
  }

  // ---------- Public API used by weather-report-control.js ----------

  /** True iff the user has ticked at least one hazard type. */
  isFilterActive() { return this.#selected.size > 0; }

  /** Set of currently-selected hazard type `code`s. */
  activeCodes() { return new Set(this.#selected); }

  /**
   * Filter a raw pmd_warnings feature list down to what should be
   * SURFACED under the current selection.  Empty selection = pass-through
   * (every feature keeps).
   */
  filterFeatures(features) {
    if (this.#selected.size === 0) return features;
    return (features || []).filter((f) => this.#featureMatches(f));
  }

  // ---------- Internal ----------

  #injectIntoSidebar() {
    const done = () => this.#tryInject();
    if (done()) return;
    // Sidebar renders after DOMContentLoaded via SidebarMenu — wait for it.
    const observer = new MutationObserver(() => { if (done()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    // Safety net — stop watching after 15s no matter what.
    setTimeout(() => observer.disconnect(), 15000);
  }

  #tryInject() {
    const toggleInput = document.querySelector(`input[data-item-key="${TOGGLE_KEY}"]`);
    if (!toggleInput) return false;
    const row = toggleInput.closest(".ncop-item-toggle");
    if (!row || !row.parentElement) return false;
    // Guard against double-inject on hot-reload / re-renders.
    if (row.previousElementSibling?.classList?.contains("ncop-pmd-warnings-filter")) return true;

    this.#hostEl = this.#buildFilterCard();
    row.parentElement.insertBefore(this.#hostEl, row);
    return true;
  }

  #buildFilterCard() {
    const wrap = document.createElement("div");
    wrap.className = "ncop-pmd-warnings-filter";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Filter PMD Weather Warnings by hazard type");

    const title = document.createElement("div");
    title.className = "ncop-pmd-warnings-filter__title";
    title.innerHTML = `<span>Filter by hazard type</span>`;
    this.#counterEl = document.createElement("span");
    this.#counterEl.className = "ncop-pmd-warnings-filter__counter";
    this.#counterEl.textContent = "All";
    title.appendChild(this.#counterEl);
    wrap.appendChild(title);

    const table = document.createElement("div");
    table.className = "ncop-pmd-warnings-filter__table";

    HAZARD_TYPES.forEach((h) => {
      const row = document.createElement("label");
      row.className = "ncop-pmd-warnings-filter__row";
      row.dataset.hazardCode = h.code;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "ncop-pmd-warnings-filter__checkbox";
      cb.value = h.code;
      cb.setAttribute("aria-label", h.label);

      const badge = document.createElement("span");
      badge.className = "ncop-pmd-warnings-filter__badge";
      badge.style.background = h.badgeBg;
      if (h.badgeText) badge.style.color = h.badgeText;
      badge.textContent = h.badge;

      const label = document.createElement("span");
      label.className = "ncop-pmd-warnings-filter__label";
      label.textContent = h.label;

      cb.addEventListener("change", (e) => {
        this.#onCheckboxChange(h.code, e.target.checked, row);
      });

      row.append(cb, badge, label);
      table.appendChild(row);
    });

    wrap.appendChild(table);

    const actions = document.createElement("div");
    actions.className = "ncop-pmd-warnings-filter__actions";
    this.#clearBtnEl = document.createElement("button");
    this.#clearBtnEl.type = "button";
    this.#clearBtnEl.className = "ncop-pmd-warnings-filter__clear";
    this.#clearBtnEl.textContent = "Clear";
    this.#clearBtnEl.disabled = true;
    this.#clearBtnEl.addEventListener("click", () => this.#clearAll(table));
    actions.appendChild(this.#clearBtnEl);
    wrap.appendChild(actions);

    return wrap;
  }

  #clearAll(table) {
    this.#selected.clear();
    table.querySelectorAll("input.ncop-pmd-warnings-filter__checkbox").forEach((cb) => { cb.checked = false; });
    table.querySelectorAll(".ncop-pmd-warnings-filter__row.is-active").forEach((r) => r.classList.remove("is-active"));
    this.#updateCounter();
    this.#applyMapFilter();
    this.#notifyChange();
  }

  #onCheckboxChange(code, isChecked, rowEl) {
    if (isChecked) this.#selected.add(code); else this.#selected.delete(code);
    rowEl.classList.toggle("is-active", isChecked);

    // Auto-flip the layer master toggle ON when the user first selects
    // anything — but never flip it OFF here, per spec.
    if (this.#selected.size > 0) this.#ensureLayerOn();

    this.#updateCounter();
    this.#applyMapFilter();
    this.#notifyChange();
  }

  #ensureLayerOn() {
    const toggle = document.querySelector(`input[data-item-key="${TOGGLE_KEY}"]`);
    if (!toggle || toggle.checked) return;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
  }

  #updateCounter() {
    if (!this.#counterEl) return;
    const n = this.#selected.size;
    this.#counterEl.textContent = n === 0 ? "All" : `${n} of ${HAZARD_TYPES.length}`;
    if (this.#clearBtnEl) this.#clearBtnEl.disabled = n === 0;
  }

  #wireSourceListener() {
    if (!this.#map) return;
    // Snapshot the raw feature collection whenever the source
    // (re)hydrates — the filter matching uses this list to build the
    // element-label allow-list that goes into map.setFilter().
    this.#map.on("sourcedata", (e) => {
      if (!e || e.sourceId !== SOURCE_ID || !e.isSourceLoaded) return;
      const src = this.#map.getSource(SOURCE_ID);
      if (!src) return;
      const data = src._data;
      if (data && Array.isArray(data.features)) {
        this.#rawFeatures = data.features;
        // Re-apply the filter in case it was already active before the
        // fresh data landed.
        this.#applyMapFilter();
      }
    });
    // Also re-apply after a style reload — setStyle() drops all
    // per-layer filters, so we need to reinstate ours.
    this.#map.on("style.load", () => setTimeout(() => this.#applyMapFilter(), 50));
  }

  #featureMatches(feature) {
    const p = feature?.properties || {};
    const code = String(p.element || "").trim().toUpperCase();
    const label = String(p.element_label || p.element_name || p.type || "").trim();
    for (const code_ of this.#selected) {
      const h = HAZARD_TYPES.find((x) => x.code === code_);
      if (!h) continue;
      if (code && h.codes.includes(code)) return true;
      if (label) {
        const l = label.toLowerCase();
        for (const p of h.patterns) {
          if (l.includes(p)) return true;
        }
      }
    }
    return false;
  }

  #applyMapFilter() {
    if (!this.#map) return;
    const hasFill = this.#map.getLayer(FILL_LAYER_ID);
    const hasOutline = this.#map.getLayer(OUTLINE_LAYER_ID);
    if (!hasFill && !hasOutline) return;

    // Empty selection → clear both filters, restore full data view.
    if (this.#selected.size === 0) {
      try { if (hasFill)    this.#map.setFilter(FILL_LAYER_ID,    null); } catch (_) {}
      try { if (hasOutline) this.#map.setFilter(OUTLINE_LAYER_ID, null); } catch (_) {}
      return;
    }

    // Walk the raw features and collect the distinct label / code
    // strings that fall into ANY of the selected hazard buckets.  We
    // build a static Mapbox filter (["in", ...]) from those — avoids
    // custom expression logic and is fast on the GPU.
    const okLabels = new Set();
    const okCodes = new Set();
    for (const f of this.#rawFeatures) {
      if (this.#featureMatches(f)) {
        const p = f?.properties || {};
        const label = String(p.element_label || p.element_name || p.type || "").trim();
        const code  = String(p.element || "").trim();
        if (label) okLabels.add(label);
        if (code)  okCodes.add(code);
      }
    }

    // No feature matches any selected type → hide everything (both
    // layers get a filter that resolves to false for every feature).
    if (okLabels.size === 0 && okCodes.size === 0) {
      const hideAll = ["==", ["literal", "__nwfc_hide_all__"], "___"];
      try { if (hasFill)    this.#map.setFilter(FILL_LAYER_ID,    hideAll); } catch (_) {}
      try { if (hasOutline) this.#map.setFilter(OUTLINE_LAYER_ID, hideAll); } catch (_) {}
      return;
    }

    // Union filter: label ∈ okLabels OR element ∈ okCodes.
    const clauses = [];
    if (okLabels.size > 0) {
      clauses.push(["in", ["get", "element_label"], ["literal", Array.from(okLabels)]]);
      clauses.push(["in", ["get", "element_name"],  ["literal", Array.from(okLabels)]]);
      clauses.push(["in", ["get", "type"],           ["literal", Array.from(okLabels)]]);
    }
    if (okCodes.size > 0) {
      clauses.push(["in", ["get", "element"], ["literal", Array.from(okCodes)]]);
    }
    const filter = clauses.length === 1 ? clauses[0] : ["any", ...clauses];
    try { if (hasFill)    this.#map.setFilter(FILL_LAYER_ID,    filter); } catch (_) {}
    try { if (hasOutline) this.#map.setFilter(OUTLINE_LAYER_ID, filter); } catch (_) {}
  }

  #notifyChange() {
    try {
      window.dispatchEvent(new CustomEvent("pmd-warnings-filter-changed", {
        detail: { selected: Array.from(this.#selected) },
      }));
    } catch (_) {}
  }
}

export const pmdWarningsFilter = new PmdWarningsFilterController();

export function initPmdWarningsFilter(map) {
  pmdWarningsFilter.attach(map);
}
