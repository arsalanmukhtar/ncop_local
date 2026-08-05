// ==========================================================================
// story-dynamic-weather.js
// --------------------------------------------------------------------------
// Dynamic Weather Report — a SEPARATE story selectable via #storySelect
// (alongside demostory / hydrological / meteorological), entirely
// independent from story-provincial-forecast.js. The provincial outlook
// always auto-shows when the Story panel opens and this file never touches
// it, its state, or its DOM — the two are unrelated beyond living in the
// same #story-root container.
//
// What it shows: whichever Meteoblue temporal layer is currently active
// (or one picked from this card's own layer selector), replayed one
// chapter per forecast day/frame, each chapter listing the per-district
// reading sorted by severity. Per-district sampling is NOT reimplemented
// here — every frame's reading comes from
// WeatherReportControl.getDistrictReportForFrame() (weather-report-control.js),
// the same primitives that already power the Dynamic Report tab.
//
// Integration with #storySelect (owned by StoryManager in map-controls.js,
// which we never modify):
//   1. Wait for #storySelect to exist, inject our own sentinel option, and
//      re-inject it via a MutationObserver whenever StoryManager's own
//      _renderList() rebuilds the <select> from scratch (e.g. after the
//      operator saves a story in the editor) and wipes it.
//   2. Listen for "change" on #storySelect in the CAPTURE phase — this
//      fires before StoryManager's own listener (registered directly on
//      the element, target phase) resets state.currentStory / re-renders
//      the chapter list, so we still see our sentinel value before it's
//      overwritten. We never call stopPropagation — StoryManager's own
//      handler runs right after ours and harmlessly resets ITS OWN UI to
//      "no story picked", which is exactly what should happen when the
//      operator switches away from the other three JSON stories.
//   3. Show/hide our own card accordingly. We only ever toggle the
//      *display* of StoryManager's #storyChapters element (a presentation
//      choice, not a code change) so our card and its empty placeholder
//      don't show at the same time.
// ==========================================================================

import { LAYER_KIND_MAP } from "./weather-report-control.js";
import { handleTemporalInteraction } from "./mapbox-functions.js";

const MODAL_ID    = "story-modal";
const ROOT_ID      = "story-root";
const SELECT_ID    = "storySelect";
const SENTINEL     = "__dynamic_weather__";
const CARD_ID      = "ncop-dynamic-weather-forecast";
const POPUP_ID     = "ncop-dynamic-weather-popup";
const STYLE_ID     = "ncop-dynamic-weather-style";

const TICK_MS = 10000; // 10s per day, matches the outlook's own overview pace

let _wired = false;
let _optionObserver = null;

const _state = {
  isPlaying:  false,
  tickTimer:  null,
  progTimer:  null,
  tickStartMs: 0,
  layerKey:   null,
  label:      "",
  chapters:   [],   // = getCurrentTemporalState().layersDef for the chosen layer
  index:      0,
  popupEl:    null,
};

// ---- Small helpers -------------------------------------------------------
function _escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function _dayLabel(frame, i) {
  const raw = String(frame?.date || "").trim();
  if (!raw) return `Day ${i + 1}`;
  const dowMatch = raw.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*/i);
  if (dowMatch) return dowMatch[1].slice(0, 3);
  return raw.slice(0, 3) || `Day ${i + 1}`;
}

// ---- Styles ---------------------------------------------------------------
function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${CARD_ID} {
      margin: 0 0 12px;
      padding: 12px 14px 12px;
      background: linear-gradient(135deg, rgba(70, 178, 255, 0.16), rgba(70, 178, 255, 0.04));
      border: 1px solid rgba(70, 178, 255, 0.35);
      border-radius: 10px;
      color: #eaeaea;
      font-size: 12.5px;
      line-height: 1.5;
    }
    #${CARD_ID} .dwr-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; margin-bottom: 10px;
    }
    #${CARD_ID} .dwr-title {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.05em;
      color: var(--ndma-blue, #46b2ff);
      text-transform: uppercase;
    }
    #${CARD_ID} .dwr-live {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--ndma-blue, #46b2ff);
      box-shadow: 0 0 0 2px rgba(70, 178, 255, 0.30);
      animation: dwr-pulse 1.6s ease-in-out infinite;
    }
    @keyframes dwr-pulse {
      0%, 100% { opacity: 1;   transform: scale(1); }
      50%      { opacity: 0.55; transform: scale(0.7); }
    }
    #${CARD_ID} .dwr-close {
      appearance: none; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      font-size: 12px; line-height: 1;
      color: rgba(234, 234, 234, 0.65);
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${CARD_ID} .dwr-close:hover {
      background: rgba(220, 38, 38, 0.25);
      color: #fff;
    }
    #${CARD_ID} .dwr-toolbar {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 8px;
    }
    #${CARD_ID} .dwr-toolbar-label {
      font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
      color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase;
    }
    #${CARD_ID} .dwr-select {
      flex: 1 1 auto;
      padding: 5px 8px;
      font-size: 11.5px; font-weight: 600;
      color: #eaeaea;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      cursor: pointer;
    }
    #${CARD_ID} .dwr-select:hover { border-color: rgba(70, 178, 255, 0.45); }
    #${CARD_ID} .dwr-chapter-head {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 10px; margin-bottom: 6px;
    }
    #${CARD_ID} .dwr-chapter-title {
      font-size: 14px; font-weight: 800; color: #fff;
    }
    #${CARD_ID} .dwr-chapter-counter {
      font-size: 10.5px; color: rgba(234, 234, 234, 0.55);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    #${CARD_ID} .dwr-body { min-height: 40px; }
    #${CARD_ID} .dwr-status {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 4px;
      font-size: 12px; color: rgba(234, 234, 234, 0.85);
      line-height: 1.5;
    }
    #${CARD_ID} .dwr-status-spinner {
      width: 13px; height: 13px; border-radius: 50%;
      border: 2px solid rgba(70, 178, 255, 0.25);
      border-top-color: var(--ndma-blue, #46b2ff);
      animation: dwr-spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    @keyframes dwr-spin { to { transform: rotate(360deg); } }
    #${CARD_ID} .dwr-section-head {
      font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
      color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    #${CARD_ID} .dwr-list {
      display: flex; flex-direction: column; gap: 4px;
      max-height: 260px; overflow-y: auto;
    }
    #${CARD_ID} .dwr-row {
      display: grid; grid-template-columns: 1fr auto auto;
      align-items: baseline; gap: 8px;
      padding: 5px 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      font-size: 11.5px;
    }
    #${CARD_ID} .dwr-row.is-alert {
      background: rgba(220, 38, 38, 0.14);
      border-color: rgba(248, 113, 113, 0.35);
    }
    #${CARD_ID} .dwr-district { font-weight: 700; color: #eaeaea; }
    #${CARD_ID} .dwr-province {
      font-size: 10px; color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase; letter-spacing: 0.02em;
    }
    #${CARD_ID} .dwr-value {
      font-weight: 700; font-variant-numeric: tabular-nums;
      color: var(--ndma-blue, #46b2ff);
    }
    #${CARD_ID} .dwr-row.is-alert .dwr-value { color: #f87171; }
    #${CARD_ID} .dwr-overflow {
      padding: 4px 8px;
      font-size: 10.5px; font-style: italic;
      color: rgba(234, 234, 234, 0.50);
    }
    #${CARD_ID} .dwr-progress-track {
      height: 3px; margin-top: 10px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px; overflow: hidden;
    }
    #${CARD_ID} .dwr-progress-fill {
      height: 100%; width: 0%;
      background: var(--ndma-blue, #46b2ff);
      transition: width 0.1s linear;
    }
    #${CARD_ID} .dwr-transport {
      display: flex; align-items: center; gap: 6px;
      margin-top: 8px;
    }
    #${CARD_ID} .dwr-btn {
      appearance: none; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px;
      color: #eaeaea;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      transition: background 0.15s ease;
    }
    #${CARD_ID} .dwr-btn:hover { background: rgba(70, 178, 255, 0.25); }
    #${CARD_ID} .dwr-btn svg { width: 14px; height: 14px; }
    #${CARD_ID} .dwr-btn--play-glyph svg { margin-left: 1px; }
    #${CARD_ID} .dwr-hint {
      margin-left: auto;
      font-size: 10.5px; letter-spacing: 0.03em;
      color: rgba(234, 234, 234, 0.55);
    }
    #${CARD_ID} .dwr-dots {
      display: flex; flex-wrap: wrap; gap: 4px;
      margin: 10px 0 0;
    }
    #${CARD_ID} .dwr-dot {
      appearance: none;
      padding: 2px 8px;
      font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em;
      color: rgba(234, 234, 234, 0.70);
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    #${CARD_ID} .dwr-dot.is-active {
      color: #fff;
      background: var(--ndma-blue, #46b2ff);
      border-color: rgba(255, 255, 255, 0.35);
    }
    #${CARD_ID} .dwr-meta {
      margin-top: 8px;
      font-size: 10.5px; color: rgba(234, 234, 234, 0.55);
    }

    /* Floating textual popup — entirely our own element (#${POPUP_ID}),
       never story-provincial-forecast.js's #ncop-story-briefing. */
    #${POPUP_ID} {
      position: absolute; z-index: 5;
      width: 340px; max-width: calc(100% - 24px);
      top: 188px; left: 12px;
      pointer-events: auto;
      opacity: 0; transform: translateY(-8px);
      transition: opacity 0.30s ease, transform 0.30s ease;
      background: linear-gradient(180deg, rgba(20, 20, 30, 0.96), rgba(14, 14, 22, 0.96));
      color: #eaeaea;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55), 0 0 0 3px rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      font-size: 12px;
    }
    #${POPUP_ID} .dwrp-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      background: linear-gradient(90deg, rgba(70, 178, 255, 0.30), rgba(70, 178, 255, 0.08));
      border-bottom: 1px solid rgba(255, 255, 255, 0.10);
    }
    #${POPUP_ID} .dwrp-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--ndma-blue, #46b2ff);
      box-shadow: 0 0 0 3px rgba(70, 178, 255, 0.28);
      animation: dwr-pulse 1.6s ease-in-out infinite;
      flex: 0 0 auto;
    }
    #${POPUP_ID} .dwrp-title {
      flex: 1 1 auto;
      font-size: 13px; font-weight: 700; color: #fff;
    }
    #${POPUP_ID} .dwrp-badge {
      font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
      color: rgba(234, 234, 234, 0.85);
      text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
    }
    #${POPUP_ID} .dwrp-body {
      padding: 10px 12px;
      color: #eaeaea; font-size: 12px; line-height: 1.55;
    }
    #${POPUP_ID} .dwrp-chips {
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 0 12px 10px;
    }
    #${POPUP_ID} .dwrp-chip {
      font-size: 10.5px; font-weight: 600;
      padding: 2px 8px;
      background: rgba(77, 208, 225, 0.18);
      color: #7fdfec;
      border: 1px solid rgba(77, 208, 225, 0.35);
      border-radius: 999px;
    }
    #${POPUP_ID} .dwrp-chip.is-alert {
      background: rgba(220, 38, 38, 0.20);
      color: #fca5a5;
      border-color: rgba(248, 113, 113, 0.40);
    }
  `;
  document.head.appendChild(s);
}

// ---- SVG glyphs -------------------------------------------------------
const ICON_PLAY  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`;
const ICON_PREV  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>`;
const ICON_NEXT  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`;

// ---- Card DOM ---------------------------------------------------------
function _ensureCard(root) {
  let card = root.querySelector(`#${CARD_ID}`);
  if (card) return card;
  card = document.createElement("div");
  card.id = CARD_ID;
  card.innerHTML = `
    <div class="dwr-head">
      <div class="dwr-title">
        <span class="dwr-live" aria-hidden="true"></span>
        <span>Dynamic Weather Report</span>
      </div>
      <button type="button" class="dwr-close" aria-label="Close Dynamic Weather Report" title="Close and return to 7-Day Outlook">✕</button>
    </div>
    <div class="dwr-toolbar">
      <label class="dwr-toolbar-label" for="dwrLayerSelect">Layer</label>
      <select id="dwrLayerSelect" class="dwr-select"></select>
    </div>
    <div class="dwr-chapter-head">
      <div class="dwr-chapter-title">—</div>
      <div class="dwr-chapter-counter"></div>
    </div>
    <div class="dwr-body" role="region" aria-live="polite"></div>
    <div class="dwr-progress-track"><div class="dwr-progress-fill"></div></div>
    <div class="dwr-transport">
      <button type="button" class="dwr-btn dwr-btn--prev" title="Previous day" aria-label="Previous">${ICON_PREV}</button>
      <button type="button" class="dwr-btn dwr-btn--play dwr-btn--play-glyph" title="Play" aria-label="Play">${ICON_PLAY}</button>
      <button type="button" class="dwr-btn dwr-btn--next" title="Next day" aria-label="Next">${ICON_NEXT}</button>
      <span class="dwr-hint">10s per day</span>
    </div>
    <div class="dwr-dots" role="tablist"></div>
    <div class="dwr-meta">Source: Meteoblue</div>
  `;
  // Insert right after StoryManager's select row (its own shell,
  // untouched) so this card reads as "the content for what you picked",
  // and before #storyMeta/#storyChapters which StoryManager still owns.
  const selectRow = root.querySelector(`#${SELECT_ID}`)?.parentElement;
  if (selectRow && selectRow.parentElement === root) {
    selectRow.insertAdjacentElement("afterend", card);
  } else {
    root.appendChild(card);
  }
  _bindCardEvents(card);
  return card;
}

function _bindCardEvents(card) {
  const btn = (sel) => card.querySelector(sel);
  btn(".dwr-btn--play").addEventListener("click", _togglePlay);
  btn(".dwr-btn--prev").addEventListener("click", () => _goto(_state.index - 1, /*byUser*/ true));
  btn(".dwr-btn--next").addEventListener("click", () => _goto(_state.index + 1, /*byUser*/ true));
  // Close — resets #storySelect to blank (so the dropdown doesn't keep
  // claiming this is showing) and hides this card; _hide() below already
  // takes care of restoring the provincial outlook.
  btn(".dwr-close").addEventListener("click", () => {
    const sel = document.getElementById(SELECT_ID);
    if (sel) sel.value = "";
    _hide();
  });

  const select = btn("#dwrLayerSelect");
  if (select) {
    const options = Object.entries(LAYER_KIND_MAP)
      .filter(([, meta]) => meta.kind !== "raster")
      .map(([key, meta]) => `<option value="${_escapeHtml(key)}">${_escapeHtml(meta.label)}</option>`)
      .join("");
    select.innerHTML = `<option value="">Select a layer…</option>${options}`;
    select.addEventListener("change", () => {
      if (select.value) _activateLayer(select.value);
    });
  }

  card.querySelector(".dwr-dots").addEventListener("click", (e) => {
    const dot = e.target.closest(".dwr-dot");
    if (!dot) return;
    const idx = Number(dot.dataset.dwrDay);
    if (Number.isFinite(idx)) _goto(idx, /*byUser*/ true);
  });
}

// ---- Rendering ----------------------------------------------------------
function _emptyHtml() {
  return `<div class="dwr-status"><span>Pick a layer above (Temperature, Precipitation, AQI, etc.) to start the Dynamic Weather Report.</span></div>`;
}
function _loadingHtml() {
  return `<div class="dwr-status"><span class="dwr-status-spinner" aria-hidden="true"></span><span>Loading this day's layer data…</span></div>`;
}
function _noDataHtml(frame) {
  const when = _escapeHtml(frame?.date || "this day");
  return `<div class="dwr-status"><span>No per-district readings for ${when}. Try a different layer, pan to a region with coverage, or enable District/Provincial Boundary layers.</span></div>`;
}
function _reportHtml(result, frame) {
  const { rows, meta } = result;
  const shown = rows.slice(0, 20);
  const items = shown.map((r) => {
    const alertCls = r.reading?.alert ? " is-alert" : "";
    return `
      <div class="dwr-row${alertCls}">
        <span class="dwr-district">${_escapeHtml(r.district)}</span>
        <span class="dwr-province">${_escapeHtml(r.province)}</span>
        <span class="dwr-value">${_escapeHtml(r.reading?.label || "")}</span>
      </div>`;
  }).join("");
  const overflow = rows.length > shown.length
    ? `<div class="dwr-overflow">+${rows.length - shown.length} more district${rows.length - shown.length === 1 ? "" : "s"}</div>`
    : "";
  return `
    <div class="dwr-section-head">${_escapeHtml(meta?.label || "Dynamic Report")} — ${_escapeHtml(frame?.date || "")}</div>
    <div class="dwr-list">${items}${overflow}</div>
  `;
}

function _renderDots(card) {
  card.querySelector(".dwr-dots").innerHTML = _state.chapters.map((frame, i) => {
    const label = _dayLabel(frame, i);
    const isSel = i === _state.index;
    return `
      <button type="button" role="tab"
              class="dwr-dot ${isSel ? "is-active" : ""}"
              data-dwr-day="${i}"
              title="${_escapeHtml(frame?.date || label)}"
              aria-selected="${isSel}">${_escapeHtml(label)}</button>
    `;
  }).join("");
}

function _renderChapter(card) {
  const frame = _state.chapters[_state.index];
  const titleEl = card.querySelector(".dwr-chapter-title");
  const counterEl = card.querySelector(".dwr-chapter-counter");
  const bodyEl = card.querySelector(".dwr-body");
  const select = card.querySelector("#dwrLayerSelect");
  if (select) select.value = _state.layerKey || "";

  if (!frame) {
    titleEl.textContent = _state.label || "Dynamic Weather Report";
    counterEl.textContent = "";
    bodyEl.innerHTML = _emptyHtml();
    card.querySelector(".dwr-progress-fill").style.width = "0%";
    _renderDots(card);
    _closePopup();
    return;
  }

  titleEl.textContent = `${_state.label} · ${frame.date || _dayLabel(frame, _state.index)}`;
  counterEl.textContent = `Day ${_state.index + 1} / ${_state.chapters.length}`;

  const wrc = window.ncopWeatherReportControl;
  const result = wrc && typeof wrc.getDistrictReportForFrame === "function"
    ? wrc.getDistrictReportForFrame(frame, _state.layerKey)
    : null;

  bodyEl.innerHTML = result === "loading"
    ? _loadingHtml()
    : result
      ? _reportHtml(result, frame)
      : _noDataHtml(frame);

  _renderDots(card);

  if (result && result !== "loading") {
    _flyToChapter(result);
    _showPopup(frame, result);
  } else {
    _closePopup();
  }
}

// ---- Camera ---------------------------------------------------------------
// No single warning polygon exists in this data (unlike the outlook's
// per-hazard polygons) — fly to wherever today's reading is most severe:
// alert-flagged districts if any, otherwise the single top-scoring one
// (rows already arrive sorted desc by score).
function _flyToChapter(result) {
  try {
    const map = window.ncop_map;
    if (!map || typeof map.flyTo !== "function") return;
    if (!result?.rows?.length) return;

    const alerts = result.rows.filter((r) => r.reading?.alert).slice(0, 3);
    const pick = alerts.length ? alerts : result.rows.slice(0, 1);
    const bboxes = pick.map((r) => r.bbox).filter((b) => Array.isArray(b) && b.length === 4);
    if (!bboxes.length) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [bx0, by0, bx1, by1] of bboxes) {
      minX = Math.min(minX, bx0); minY = Math.min(minY, by0);
      maxX = Math.max(maxX, bx1); maxY = Math.max(maxY, by1);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;

    const cam = map.cameraForBounds([[minX, minY], [maxX, maxY]], { padding: 90, maxZoom: 9 });
    const target = cam
      ? { center: cam.center, zoom: Math.max(6, cam.zoom) }
      : { center: [(minX + maxX) / 2, (minY + maxY) / 2], zoom: 6.5 };

    map.flyTo({
      center: target.center,
      zoom: target.zoom,
      pitch: 25,
      bearing: 0,
      duration: 2200,
      curve: 1.6,
      easing: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
      essential: true,
    });
  } catch (_) { /* best-effort */ }
}

// ---- Floating popup ---------------------------------------------------
function _ensurePopup() {
  if (_state.popupEl && document.body.contains(_state.popupEl)) return _state.popupEl;
  const mapEl = document.getElementById("map");
  if (!mapEl) return null;
  const el = document.createElement("div");
  el.id = POPUP_ID;
  mapEl.appendChild(el);
  _state.popupEl = el;
  return el;
}

function _popupHtml(frame, result) {
  const { rows, meta } = result;
  const alertRows = rows.filter((r) => r.reading?.alert);
  const headline = alertRows.length
    ? `${alertRows.length} district${alertRows.length === 1 ? "" : "s"} above alert threshold`
    : `Top reading: ${_escapeHtml(rows[0]?.district || "")} — ${_escapeHtml(rows[0]?.reading?.label || "")}`;
  const chips = rows.slice(0, 6).map((r) => {
    const cls = r.reading?.alert ? "dwrp-chip is-alert" : "dwrp-chip";
    return `<span class="${cls}">${_escapeHtml(r.district)}: ${_escapeHtml(r.reading?.label || "")}</span>`;
  }).join("");
  return `
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">${_escapeHtml(meta?.label || "Dynamic Weather Report")}</span>
      <span class="dwrp-badge">${_escapeHtml(frame?.date || "")}</span>
    </div>
    <div class="dwrp-body">${_escapeHtml(headline)}</div>
    ${chips ? `<div class="dwrp-chips">${chips}</div>` : ""}
  `;
}

function _showPopup(frame, result) {
  const el = _ensurePopup();
  if (!el) return;
  el.innerHTML = _popupHtml(frame, result);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });
}

function _closePopup() {
  const el = _state.popupEl;
  if (!el) return;
  el.style.opacity = "0";
  el.style.transform = "translateY(-8px)";
  setTimeout(() => { if (el) el.innerHTML = ""; }, 260);
}

function _removePopup() {
  if (_state.popupEl) {
    try { _state.popupEl.remove(); } catch (_) {}
  }
  _state.popupEl = null;
}

// ---- Layer activation -------------------------------------------------
// Activates a layer through the exact same entry point a sidebar checkbox
// uses (handleTemporalInteraction → updateTempSlider/updateTempSliderAsync)
// — no need to leave the story or hunt the layer down in the sidebar. The
// temp-slider widget that activation normally reveals is hidden
// immediately: this card's own transport drives days, the slider control
// adds nothing here.
async function _activateLayer(layerKey) {
  const meta = LAYER_KIND_MAP[layerKey];
  if (!meta || typeof handleTemporalInteraction !== "function") return;

  const card = document.getElementById(CARD_ID);
  if (card) card.querySelector(".dwr-body").innerHTML = _loadingHtml();

  const hideSlider = () => {
    const slider = document.getElementById("temp-slider1");
    if (slider) slider.style.display = "none";
  };

  handleTemporalInteraction(null, null, layerKey, true, { title: meta.label });
  hideSlider();

  for (let attempt = 0; attempt < 40; attempt++) {
    const state = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
    if (state?.layerKey === layerKey && Array.isArray(state.layersDef) && state.layersDef.length) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  hideSlider();

  _state.index = 0;
  _refreshChapters();
}

function _refreshChapters() {
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  const state = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
  const layerKey = state?.layerKey || null;
  const layersDef = Array.isArray(state?.layersDef) ? state.layersDef : [];

  _state.layerKey = layerKey;
  _state.chapters = layerKey ? layersDef : [];
  _state.label = (layerKey && LAYER_KIND_MAP[layerKey]?.label) || "Dynamic Weather Report";
  if (_state.index >= _state.chapters.length) _state.index = 0;

  _renderChapter(card);
}

// ---- Playback -------------------------------------------------------------
function _clearTimers() {
  if (_state.tickTimer) { clearTimeout(_state.tickTimer); _state.tickTimer = null; }
  if (_state.progTimer) { clearInterval(_state.progTimer); _state.progTimer = null; }
}
function _updateProgress(card) {
  const fill = card.querySelector(".dwr-progress-fill");
  if (!fill || !_state.isPlaying) return;
  const elapsed = performance.now() - _state.tickStartMs;
  fill.style.width = `${Math.max(0, Math.min(100, (elapsed / TICK_MS) * 100))}%`;
}
function _setPlayGlyph(card, playing) {
  const btn = card.querySelector(".dwr-btn--play");
  if (!btn) return;
  btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  btn.classList.toggle("dwr-btn--play-glyph", !playing);
  btn.title = playing ? "Pause" : "Play";
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
}
function _play() {
  const card = document.getElementById(CARD_ID);
  if (!card || _state.chapters.length < 2) return;
  _state.isPlaying = true;
  _setPlayGlyph(card, true);
  _startTick(card);
}
function _pause() {
  const card = document.getElementById(CARD_ID);
  _state.isPlaying = false;
  _clearTimers();
  if (card) _setPlayGlyph(card, false);
}
function _togglePlay() {
  if (_state.isPlaying) _pause();
  else _play();
}
function _startTick(card) {
  _clearTimers();
  _state.tickStartMs = performance.now();
  const fill = card.querySelector(".dwr-progress-fill");
  if (fill) fill.style.width = "0%";
  _state.progTimer = setInterval(() => _updateProgress(card), 100);
  _state.tickTimer = setTimeout(() => {
    _state.tickTimer = null;
    _goto(_state.index + 1, /*byUser*/ false);
  }, TICK_MS);
}
function _goto(rawIdx, byUser) {
  const n = _state.chapters.length;
  if (!n) return;
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  _state.index = ((rawIdx % n) + n) % n;
  _renderChapter(card);
  if (_state.isPlaying) _startTick(card);
}

// ---- Show / hide (driven by #storySelect) --------------------------------
function _show() {
  _injectStyles();
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  // Pause + hide the provincial outlook via its own public hook (defined
  // in story-provincial-forecast.js) — its internal logic is untouched,
  // this just calls the same teardown it already runs on panel-close.
  // Two full "stories" playing/animating the map at once was the actual
  // complaint; only one is ever live at a time now.
  window.ncopProvincialForecast?.hide();
  const card = _ensureCard(root);
  card.style.display = "";
  // Presentation-only toggle of StoryManager's OWN element — its code and
  // state are never touched, we just hide its empty "pick a story"
  // placeholder while ours is the thing actually showing.
  const chaptersEl = root.querySelector("#storyChapters");
  if (chaptersEl) chaptersEl.style.display = "none";
  _refreshChapters();
}

function _hide() {
  _pause();
  _closePopup();
  const root = document.getElementById(ROOT_ID);
  const card = root?.querySelector(`#${CARD_ID}`);
  if (card) card.style.display = "none";
  const chaptersEl = root?.querySelector("#storyChapters");
  if (chaptersEl) chaptersEl.style.display = "grid";
  window.ncopProvincialForecast?.restore();
}

function _teardown() {
  _pause();
  _closePopup();
  _removePopup();
}

// ---- #storySelect integration ---------------------------------------------
function _ensureOption(sel) {
  if (!sel || sel.querySelector(`option[value="${SENTINEL}"]`)) return;
  const opt = document.createElement("option");
  opt.value = SENTINEL;
  opt.textContent = "Dynamic Weather Report";
  sel.appendChild(opt);
}

function _watchSelect(sel) {
  _ensureOption(sel);
  if (_optionObserver) _optionObserver.disconnect();
  _optionObserver = new MutationObserver(() => _ensureOption(sel));
  _optionObserver.observe(sel, { childList: true });

  // Capture phase so this fires BEFORE StoryManager's own change listener
  // (registered directly on the element, so it runs at target phase) has
  // a chance to reset the select back to blank via its own _renderList().
  document.addEventListener("change", (e) => {
    if (e.target !== sel) return;
    if (e.target.value === SENTINEL) _show();
    else _hide();
  }, true);
}

function _wireStorySelectWhenReady() {
  const sel = document.getElementById(SELECT_ID);
  if (sel) { _watchSelect(sel); return; }
  const mo = new MutationObserver(() => {
    const s = document.getElementById(SELECT_ID);
    if (s) { mo.disconnect(); _watchSelect(s); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 20000);
}

// ---- Story-panel visibility (teardown on close, regardless of what was
// selected) — independent copy of the same detection pattern
// story-provincial-forecast.js uses, not a shared function with it.
function _wireModalVisibility() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return false;
  const isVisible = () => {
    const disp = modal.style.display;
    if (disp && disp !== "none") return true;
    if (modal.classList.contains("visible")) return true;
    return false;
  };
  let wasVisible = isVisible();
  const mo = new MutationObserver(() => {
    const nowVisible = isVisible();
    if (!nowVisible && wasVisible) {
      _teardown();
    } else if (nowVisible && !wasVisible) {
      // Re-opening the panel: story-provincial-forecast.js has its OWN
      // independent visibility observer that unconditionally re-shows
      // itself on every open, regardless of what #storySelect currently
      // says. If Dynamic Weather Report was left selected from a prior
      // session, re-assert the hide (after yielding a tick so its own
      // panel-visible flow runs first) so the outlook doesn't reappear
      // underneath it — the exact clutter this hide/restore was added
      // to prevent in the first place.
      const sel = document.getElementById(SELECT_ID);
      if (sel && sel.value === SENTINEL) {
        setTimeout(() => window.ncopProvincialForecast?.hide(), 0);
      }
    }
    wasVisible = nowVisible;
  });
  mo.observe(modal, { attributes: true, attributeFilter: ["style", "class"] });
  return true;
}

export function initStoryDynamicWeather() {
  if (_wired) return;
  _wireStorySelectWhenReady();
  if (_wireModalVisibility()) { _wired = true; return; }
  const mo = new MutationObserver(() => {
    if (_wireModalVisibility()) { _wired = true; mo.disconnect(); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 20000);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initStoryDynamicWeather);
  } else {
    initStoryDynamicWeather();
  }
}
