// ==========================================================================
// story-dynamic-weather.js
// --------------------------------------------------------------------------
// Dynamic Weather Report — a SEPARATE story selectable via #storySelect
// (alongside demostory / hydrological / meteorological), entirely
// independent from story-provincial-forecast.js. The provincial outlook
// always auto-shows when the Story panel opens; entering this story hides
// + pauses it via its own public hook (window.ncopProvincialForecast),
// and closing this story restores it. The two never share DOM, state, or
// code beyond that one hide/restore handshake.
//
// CHAPTER 1 — Previous 24-Hour Precipitation Outlook (cinematic briefing):
//   1. Cinematic fly-in from a regional view to Pakistan, terrain + fog
//      enabled for depth, brief bearing settle.
//   2. DWD Satellite Infrared (`dwd_satellite_infrared`) faded in 0→85%
//      opacity over ~2s. Camera holds still. Narration/captions describe
//      rainfall corridors from the PARSED RAINFALL REPORT (see below) —
//      never from the raster itself, which is visual-only (cloud-top
//      infrared imagery, not a rainfall reading). The meteoblue
//      `precipitation_radar` layer this used to show was dropped entirely
//      — its tile API kept 400/404-ing at the zoom levels this chapter's
//      camera work needed, unrelated to anything fixable from this file.
//   3. Satellite imagery fades out, NWFC Station Observations fades in. A cinematic
//      tour flies to the top-ranked stations (by rainfall, from the
//      parsed report, cross-matched against live station coordinates),
//      pulses each marker, opens a popup combining live observation +
//      report reading, narrates, then moves on.
//   4. fitBounds back to national view; closing operational assessment.
//
// Rainfall data source: GET /api/pmd/nwfc/rainfall-report/ — NCOP's own
// backend (project/ncop_internal/views.py: NwfcRainfallReportAPIView),
// which discovers, downloads, and parses the latest NWFC Daily Rainfall
// PDF server-side (pdfplumber). This is NOT a GCOP endpoint, so it's
// fetched with a plain same-origin fetch(), not gcop-api-cache.js's
// fetchGcopCached (which is GCOP_BASE_URL-specific).
//
// Chapter 2 (temperature/heatwave) is intentionally not built yet — see
// the stopping-point notes from this feature's build session. Selecting
// this story currently plays Chapter 1 only, then holds on the national
// assessment.
//
// Integration with #storySelect (owned by StoryManager in map-controls.js,
// which we never modify) is unchanged from the previous version of this
// file — see the three numbered points below.
//   1. Wait for #storySelect to exist, inject our own sentinel option, and
//      re-inject it via a MutationObserver whenever StoryManager's own
//      _renderList() rebuilds the <select> from scratch and wipes it.
//   2. Listen for "change" on #storySelect in the CAPTURE phase — this
//      fires before StoryManager's own listener (registered directly on
//      the element, target phase) resets state.currentStory. We never
//      call stopPropagation — StoryManager's own handler runs right after
//      and harmlessly resets ITS OWN UI to "no story picked".
//   3. Show/hide our own card accordingly, toggling only the *display* of
//      StoryManager's #storyChapters element (a presentation choice, not
//      a code change).
// ==========================================================================

import { getNwfcObservations } from "./gcop-api-cache.js";
import { handleTemporalInteraction } from "./mapbox-functions.js";
import {
  wait,
  cinematicFlyTo,
  cinematicEaseTo,
  cinematicFitBounds,
  fadeLayerOpacity,
  enableCinematicAtmosphere,
  disableCinematicAtmosphere,
  pulseElement,
  orbitAroundPoint,
  enableRainEffect,
  disableRainEffect,
} from "./story-cinematic-engine.js";

const MODAL_ID  = "story-modal";
const ROOT_ID   = "story-root";
const SELECT_ID = "storySelect";
const SENTINEL  = "__dynamic_weather__";
const CARD_ID   = "ncop-dynamic-weather-forecast";
const POPUP_ID  = "ncop-dynamic-weather-popup";
const STYLE_ID  = "ncop-dynamic-weather-style";

// Kept the name RADAR_ITEM_KEY internally (scene kind "radar", _runRadar,
// etc. all still refer to this as "the radar scene") even though the
// meteoblue precipitation_radar layer it used to point at was dropped
// entirely — it now activates DWD Satellite Infrared instead, which
// doesn't 400/404 at the zoom levels this chapter's camera work needs.
const RADAR_ITEM_KEY = "dwd_satellite_infrared";
const OBS_ITEM_KEY   = "nwfc_observations";
// CHAPTER 2 — Temperature Outlook. Reuses the live NWFC observations feed
// already fetched for Chapter 1 (per-station `properties.temperature`) —
// no new backend endpoint needed. Province attribution for those live
// stations comes from the rainfall report's own province->station-name
// directory (report.provinces[x].stations[].name), since the live feed
// itself carries no province field — a second, independent use of data
// already on hand, not a new fetch.
const TEMP_ITEM_KEY = "pmd_pred_temp2m";

// District-boundary blink overlay — same `district_boundary` vector
// source story-provincial-forecast.js highlights, but a fully separate
// set of overlay layer ids (this file never touches that module's
// layers/state). Highlights whichever districts Chapter 1 is currently
// discussing (the top rainfall districts across every province).
const DIST_SRC       = "district_boundary-source";
const DIST_SRC_LAYER = "district_boundary";
const HL_DIST_FILL_ID = "_ncop_dwr_hl_dist_fill";
const HL_DIST_LINE_ID = "_ncop_dwr_hl_dist_line";
const DIST_NAME_KEYS = ["district", "district_name", "districtname", "DISTRICT", "DISTRICT_NAME", "name", "NAME"];

const PAKISTAN_CENTER = [69.5, 30.5];
const REGIONAL_START  = { center: [78, 22], zoom: 3.0, pitch: 0, bearing: 0 };  // wide Indian-Ocean/regional satellite framing
const PAKISTAN_BOUNDS  = [[60.8, 23.6], [77.9, 37.1]];

let _wired = false;
let _optionObserver = null;

// Forward speeds selectable via the fast-forward button; the rewind
// button cycles the same levels but with _state.direction flipped to -1.
const SPEED_LEVELS = [1, 2, 3, 4, 5];

const _state = {
  isPlaying:   false,
  ttsEnabled:  true,
  runToken:    0,        // bumped on every _hide()/_teardown() so an in-flight
                         // async sequence recognises it's stale and stops.
  sceneSeq:    0,        // bumped on every _gotoScene() call, incl. prev/next
                         // while already playing — prevents two navigations'
                         // camera work from running concurrently.
  scenes:      [],
  index:       0,
  report:      null,     // parsed rainfall report ({ total_mm, provinces, ... })
  observations: null,    // live NWFC FeatureCollection
  popupEl:     null,
  tickTimer:   null,     // advance timer — TTS completion poll, or the fixed 20s dwell
  progRaf:     null,     // rAF handle for the progress-bar animation
  discussedDistricts: [], // top rainfall districts (>=5, all provinces) chapter 1 is covering
  hottestStations: [],   // top temperature stations (>=5, all provinces) chapter 2 is covering
  activeLayerKey: RADAR_ITEM_KEY, // whichever temporal item was last successfully activated
  blinkTimer:  null,     // district-boundary blink interval
  blinkPhase:  false,
  speed:       1,        // playback speed multiplier — 1..5, set via fast-forward/rewind
  direction:   1,        // +1 forward, -1 reverse — which way auto-advance steps
  pendingMinDwellMs: 0,  // set by a layer scene once it knows its own frame count,
                         // read once by _gotoScene's next _scheduleAdvance call so the
                         // scene holds long enough to actually show a full timelapse lap
};

// Standard dwell when narration is muted. When narration IS on, the
// scene instead waits for the utterance to actually finish (see
// _scheduleAdvance) — this is just the no-TTS fallback pace.
const DWELL_MS_NO_TTS = 20000;

// ---- Small helpers -------------------------------------------------------
function _escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Wraps rainfall/wind/temperature readings (e.g. "44 mm", "12 kt", "30°C")
// in a highlight <mark> so the key figures stand out from surrounding
// narration/table prose at a glance — applied AFTER escaping, so it only
// ever matches literal digit+unit text, never markup.
const HIGHLIGHT_NUM_RE = /(\d+(?:\.\d+)?\s?(?:mm\/24h|mm\/h|mm|kt|km\/h|°c|%))/gi;
function _highlightNumbers(escapedHtml) {
  return String(escapedHtml || "").replace(HIGHLIGHT_NUM_RE, '<mark class="dwr-hl">$1</mark>');
}
// For a value we already know is a figure (table cells, chip labels) —
// skips the regex entirely, just wraps it directly.
function _hlNum(text) {
  return `<mark class="dwr-hl">${_escapeHtml(text)}</mark>`;
}

// Returns a promise that resolves once the utterance actually finishes
// (or immediately if TTS is off/unavailable/there's no caption) — the
// scene-advance timer awaits this directly instead of guessing a duration.
function _speak(text) {
  return new Promise((resolve) => {
    try {
      if (!_state.ttsEnabled || !window.speechSynthesis || !text) { resolve(); return; }
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      // Speeds the VOICE up with fast-forward too (capped — speech past
      // ~3x reads as noise) so narration and the scene-advance gate (which
      // just polls speechSynthesis.speaking) stay in lockstep automatically,
      // no separate dwell-time math needed for the TTS path.
      utter.rate = Math.min(3, 0.98 * (_state.speed || 1));
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    } catch (_) { resolve(); /* best-effort — TTS is a nicety, never blocks the visuals */ }
  });
}
function _stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch (_) {}
}

// Scales a camera-animation duration by the current fast-forward/rewind
// speed so the whole briefing genuinely plays back faster, not just the
// scene-advance timer — floors at 150ms so a 5x speed never collapses a
// flyTo into an instant, jarring cut.
function _dur(ms) {
  return Math.max(150, ms / (_state.speed || 1));
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
    #${CARD_ID} .dwr-head-actions { display: flex; align-items: center; gap: 6px; }
    #${CARD_ID} .dwr-mute,
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
    #${CARD_ID} .dwr-mute.is-muted { color: rgba(234, 234, 234, 0.35); }
    #${CARD_ID} .dwr-close:hover { background: rgba(220, 38, 38, 0.25); color: #fff; }
    #${CARD_ID} .dwr-mute:hover { background: rgba(70, 178, 255, 0.25); color: #fff; }

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

    #${CARD_ID} .dwr-caption {
      font-size: 12.5px; line-height: 1.6; color: #eaeaea;
      animation: dwr-caption-in 0.5s ease;
    }
    @keyframes dwr-caption-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #${CARD_ID} mark.dwr-hl,
    #${POPUP_ID} mark.dwr-hl {
      background: rgba(70, 178, 255, 0.22);
      color: #fff;
      font-weight: 800;
      padding: 0 4px;
      border-radius: 4px;
      font-style: normal;
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    #${CARD_ID} .dwr-facts {
      display: flex; flex-wrap: wrap; gap: 6px;
      margin-top: 8px;
    }
    #${CARD_ID} .dwr-fact-pill {
      font-size: 10.5px; font-weight: 700;
      padding: 3px 9px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      color: #eaeaea;
    }
    #${CARD_ID} .dwr-fact-pill.is-alert {
      background: rgba(220, 38, 38, 0.18);
      border-color: rgba(248, 113, 113, 0.40);
      color: #fca5a5;
    }
    #${CARD_ID} .dwr-layer-loading {
      margin-top: 6px;
      font-size: 11px; font-style: italic;
      color: rgba(234, 234, 234, 0.6);
    }

    #${CARD_ID} .dwr-progress-track {
      height: 3px; margin-top: 10px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px; overflow: hidden;
    }
    #${CARD_ID} .dwr-progress-fill {
      height: 100%; width: 0%;
      background: var(--ndma-blue, #46b2ff);
      transition: width 0.2s linear;
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
    #${CARD_ID} .dwr-btn--rw,
    #${CARD_ID} .dwr-btn--ff {
      width: auto; min-width: 26px; padding: 0 7px; gap: 3px;
    }
    #${CARD_ID} .dwr-speed-label {
      font-size: 9.5px; font-weight: 800; font-variant-numeric: tabular-nums;
    }
    #${CARD_ID} .dwr-btn.is-active {
      background: rgba(70, 178, 255, 0.40);
      color: #fff;
    }
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
      width: 8px; height: 8px; padding: 0;
      background: rgba(255, 255, 255, 0.15);
      border: none; border-radius: 50%;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease;
    }
    #${CARD_ID} .dwr-dot.is-active {
      background: var(--ndma-blue, #46b2ff);
      transform: scale(1.3);
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
      max-height: 70vh; overflow-y: auto;
      top: 188px; left: 12px;
      pointer-events: auto;
      opacity: 0; transform: translateY(-8px);
      transition: opacity 0.35s ease, transform 0.35s ease;
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
    #${POPUP_ID} .dwrp-title { flex: 1 1 auto; font-size: 13px; font-weight: 700; color: #fff; }
    #${POPUP_ID} .dwrp-badge {
      font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
      color: rgba(234, 234, 234, 0.85);
      text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
    }
    #${POPUP_ID} .dwrp-body { padding: 10px 12px; color: #eaeaea; font-size: 12px; line-height: 1.55; }
    #${POPUP_ID} .dwrp-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 12px 10px; }
    #${POPUP_ID} .dwrp-chip {
      font-size: 10.5px; font-weight: 600;
      padding: 2px 8px;
      background: rgba(77, 208, 225, 0.18);
      color: #7fdfec;
      border: 1px solid rgba(77, 208, 225, 0.35);
      border-radius: 999px;
    }
    #${POPUP_ID} .dwrp-table {
      width: 100%; border-collapse: collapse;
      margin-bottom: 8px;
      font-size: 11.5px;
    }
    #${POPUP_ID} .dwrp-table th {
      text-align: left;
      font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
      color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase;
      padding: 2px 6px 4px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    #${POPUP_ID} .dwrp-table td {
      padding: 3px 6px 3px 0;
      color: #eaeaea;
    }
    #${POPUP_ID} .dwrp-summary-line {
      font-size: 11.5px; line-height: 1.5;
      color: rgba(234, 234, 234, 0.85);
    }
    #${POPUP_ID} .dwrp-summary-secondary {
      font-size: 10.5px; font-style: italic;
      color: rgba(234, 234, 234, 0.55);
    }
    #${POPUP_ID} .dwrp-table-label {
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em;
      color: rgba(234, 234, 234, 0.50);
      text-transform: uppercase;
      margin: 6px 0 4px;
    }
    #${POPUP_ID} .dwrp-district-prov {
      font-size: 9.5px; color: rgba(234, 234, 234, 0.50);
      text-transform: uppercase; letter-spacing: 0.02em;
    }
    #${POPUP_ID} .dwrp-live-note {
      font-size: 9.5px; font-weight: 400; font-style: italic;
      color: #7fdfec;
    }
    #${POPUP_ID} .dwrp-pdf-list {
      border-top: 1px solid rgba(255, 255, 255, 0.10);
      padding: 8px 12px 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    #${POPUP_ID} .dwrp-pdf-row {
      display: flex; align-items: center; gap: 8px;
    }
    #${POPUP_ID} .dwrp-pdf-badge {
      flex: 0 0 auto;
      font-size: 9px; font-weight: 800; letter-spacing: 0.04em;
      padding: 2px 6px;
      background: rgba(220, 38, 38, 0.20);
      color: #fca5a5;
      border-radius: 4px;
    }
    #${POPUP_ID} .dwrp-pdf-body { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
    #${POPUP_ID} .dwrp-pdf-title { font-size: 11px; font-weight: 600; color: #eaeaea; }
    #${POPUP_ID} .dwrp-pdf-meta { font-size: 9.5px; color: rgba(234, 234, 234, 0.55); }
    #${POPUP_ID} .dwrp-pdf-open {
      flex: 0 0 auto;
      color: #7fdfec; text-decoration: none;
      font-size: 14px;
    }
    #${POPUP_ID} .dwrp-pdf-open:hover { color: #fff; }

    /* Station-marker pulse — targets whatever mapboxgl.Marker element(s)
       are currently in the map container when the class is toggled.
       nwfc-html-markers.js owns marker creation; this only reaches in via
       a class on #map so we never touch that file. */
    #map.ncop-dwr-pulse-target .mapboxgl-marker {
      animation: ncop-dwr-marker-pulse 1.1s ease-in-out 2;
    }
    @keyframes ncop-dwr-marker-pulse {
      0%, 100% { filter: none; transform: scale(1); }
      50%      { filter: drop-shadow(0 0 10px rgba(70,178,255,0.9)); transform: scale(1.25); }
    }
    #map.ncop-dwr-fade-in .mapboxgl-marker {
      animation: ncop-dwr-marker-fadein 1.6s ease forwards;
    }
    @keyframes ncop-dwr-marker-fadein {
      from { opacity: 0; } to { opacity: 1; }
    }
  `;
  document.head.appendChild(s);
}

// ---- SVG glyphs -------------------------------------------------------
const ICON_PLAY  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`;
const ICON_PREV  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>`;
const ICON_NEXT  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`;
const ICON_RW    = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"></polygon><polygon points="22 19 13 12 22 5 22 19"></polygon></svg>`;
const ICON_FF    = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"></polygon><polygon points="2 19 11 12 2 5 2 19"></polygon></svg>`;
const ICON_TTS_ON  = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
const ICON_TTS_OFF = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;

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
      <div class="dwr-head-actions">
        <button type="button" class="dwr-mute" aria-label="Mute narration" title="Mute narration">${ICON_TTS_ON}</button>
        <button type="button" class="dwr-close" aria-label="Close Dynamic Weather Report" title="Close and return to 7-Day Outlook">✕</button>
      </div>
    </div>
    <div class="dwr-chapter-head">
      <div class="dwr-chapter-title">—</div>
      <div class="dwr-chapter-counter"></div>
    </div>
    <div class="dwr-body" role="region" aria-live="polite"></div>
    <div class="dwr-progress-track"><div class="dwr-progress-fill"></div></div>
    <div class="dwr-transport">
      <button type="button" class="dwr-btn dwr-btn--rw" title="Rewind (cycles 1x-5x)" aria-label="Rewind">${ICON_RW}<span class="dwr-speed-label"></span></button>
      <button type="button" class="dwr-btn dwr-btn--prev" title="Previous scene" aria-label="Previous">${ICON_PREV}</button>
      <button type="button" class="dwr-btn dwr-btn--play dwr-btn--play-glyph" title="Play" aria-label="Play">${ICON_PLAY}</button>
      <button type="button" class="dwr-btn dwr-btn--next" title="Next scene" aria-label="Next">${ICON_NEXT}</button>
      <button type="button" class="dwr-btn dwr-btn--ff" title="Fast-forward (cycles 1x-5x)" aria-label="Fast-forward">${ICON_FF}<span class="dwr-speed-label"></span></button>
      <span class="dwr-hint">Chapter 1 · Precipitation Briefing</span>
    </div>
    <div class="dwr-dots" role="tablist"></div>
    <div class="dwr-meta">Source: PMD NWFC Daily Rainfall Report · DWD Satellite Infrared</div>
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
  btn(".dwr-btn--prev").addEventListener("click", () => _gotoScene(_state.index - 1, /*byUser*/ true));
  btn(".dwr-btn--next").addEventListener("click", () => _gotoScene(_state.index + 1, /*byUser*/ true));
  btn(".dwr-btn--ff").addEventListener("click", () => _cycleSpeed(1));
  btn(".dwr-btn--rw").addEventListener("click", () => _cycleSpeed(-1));
  btn(".dwr-close").addEventListener("click", () => {
    const sel = document.getElementById(SELECT_ID);
    if (sel) sel.value = "";
    _hide();
  });
  btn(".dwr-mute").addEventListener("click", () => {
    _state.ttsEnabled = !_state.ttsEnabled;
    _stopSpeaking();
    const m = btn(".dwr-mute");
    m.classList.toggle("is-muted", !_state.ttsEnabled);
    m.innerHTML = _state.ttsEnabled ? ICON_TTS_ON : ICON_TTS_OFF;
  });
  card.querySelector(".dwr-dots").addEventListener("click", (e) => {
    const dot = e.target.closest(".dwr-dot");
    if (!dot) return;
    const idx = Number(dot.dataset.dwrScene);
    if (Number.isFinite(idx)) _gotoScene(idx, /*byUser*/ true);
  });
}

// ==========================================================================
// Data: parsed rainfall report + live NWFC observations
// ==========================================================================
async function _fetchRainfallReport() {
  const res = await fetch("/api/pmd/nwfc/rainfall-report/");
  if (!res.ok) throw new Error(`rainfall report HTTP ${res.status}`);
  return res.json();
}

function _normName(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function _districtPart(reportStationName) {
  const idx = reportStationName.indexOf(" - ");
  return idx >= 0 ? reportStationName.slice(0, idx) : reportStationName;
}
/** Station-name reconciliation between the PDF-parsed report (district or
 * "District - SubStation" granularity) and the live NWFC observations feed
 * (one entry per major city/district). Tries exact match on the district
 * name first, then substring containment either direction — same
 * tolerant-matching philosophy already used throughout this app's other
 * name-based joins (e.g. MESSAGE_PROVINCE_ALIASES in
 * story-provincial-forecast.js). */
function _matchLiveStation(reportStationName, liveFeatures) {
  const district = _normName(_districtPart(reportStationName));
  const full = _normName(reportStationName);
  let contains = null;
  for (const f of liveFeatures) {
    const liveName = _normName(f.properties?.name);
    if (!liveName) continue;
    if (liveName === district || liveName === full) return f;
    if (!contains && (liveName.includes(district) || district.includes(liveName))) contains = f;
  }
  return contains;
}

function _provinceRanking(report) {
  return Object.entries(report?.provinces || {})
    .map(([name, p]) => ({ name, mm: p.summary_mm || 0, nil: !!p.nil }))
    .sort((a, b) => b.mm - a.mm);
}

// District-level ranking for the SINGLE latest day (mirrors the backend's
// own per-day district-max logic in _merge_rainfall_reports — multiple
// gauges within one district are different monitoring points, so a
// district's figure is the MAX among its own stations, not their sum).
// The backend's districts_multiday is a 48h aggregate; this is the 24h
// counterpart, computed client-side since the API doesn't return a
// single-day district breakdown (only the province-level one).
function _districtRankingFromDay(report) {
  const totals = new Map(); // "province||district" -> mm
  for (const [province, p] of Object.entries(report?.provinces || {})) {
    const dayMax = new Map();
    for (const station of p.stations || []) {
      if (station.trace) continue;
      const district = station.name.split(" - ")[0];
      dayMax.set(district, Math.max(dayMax.get(district) || 0, station.mm));
    }
    for (const [district, mm] of dayMax) totals.set(`${province}||${district}`, { province, district, mm });
  }
  return Array.from(totals.values())
    .map((d) => ({ name: d.district, province: d.province, mm_total: Math.round(d.mm * 10) / 10 }))
    .sort((a, b) => b.mm_total - a.mm_total);
}

// Guarantees province diversity FIRST (the single top district from every
// province that logged rain), then fills with the next-highest districts
// overall until at least 5 total are present — used so Chapter 1's
// narrative, camera tour, and stats table represent the whole country
// rather than whichever single province happened to log the highest
// reading (fewer than 5 only when the report genuinely has fewer than 5
// wet districts nationwide).
function _topDistrictsAcrossProvinces(report) {
  const all = _districtRankingFromDay(report).filter((d) => d.mm_total > 0); // already sorted desc
  if (!all.length) return [];
  const picked = [];
  const seenProvince = new Set();
  for (const d of all) {
    if (seenProvince.has(d.province)) continue;
    seenProvince.add(d.province);
    picked.push(d);
  }
  const pickedKeys = new Set(picked.map((d) => `${d.province}||${d.name}`));
  for (const d of all) {
    if (picked.length >= 5) break;
    const key = `${d.province}||${d.name}`;
    if (pickedKeys.has(key)) continue;
    picked.push(d);
    pickedKeys.add(key);
  }
  return picked.sort((a, b) => b.mm_total - a.mm_total);
}

function _joinDistrictList(list) {
  const parts = list.map((d) => `${d.name} (${d.mm_total} mm, ${d.province})`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// ==========================================================================
// CHAPTER 2 data — live NWFC station temperatures (already fetched for
// Chapter 1 as _state.observations; no new backend endpoint needed). The
// live feed carries no province field of its own, so province attribution
// reuses the rainfall report's own province -> station-name directory
// (report.provinces[x].stations[].name) purely as a name/province lookup
// — a second, independent use of data already on hand.
// ==========================================================================
function _buildStationProvinceLookup(report) {
  const lookup = new Map();
  for (const [province, p] of Object.entries(report?.provinces || {})) {
    for (const station of p.stations || []) {
      const district = station.name.split(" - ")[0];
      lookup.set(_normName(district), province);
    }
  }
  return lookup;
}

// Same province-diversity rule as _topDistrictsAcrossProvinces — one
// hottest station per province first, then filled to >=5 overall with
// the next-highest readings, so Chapter 2 also represents the whole
// country rather than whichever province happened to run hottest.
function _hottestStationsAcrossProvinces(observationsFC, lookup) {
  const withTemp = (observationsFC?.features || [])
    .filter((f) => Number.isFinite(f.properties?.temperature))
    .map((f) => ({
      feature: f,
      temp: f.properties.temperature,
      province: lookup.get(_normName(f.properties?.name)) || null,
    }))
    .sort((a, b) => b.temp - a.temp);
  if (!withTemp.length) return [];
  const picked = [];
  const seenProvince = new Set();
  for (const x of withTemp) {
    if (!x.province || seenProvince.has(x.province)) continue;
    seenProvince.add(x.province);
    picked.push(x);
  }
  const pickedNames = new Set(picked.map((x) => x.feature.properties?.name));
  for (const x of withTemp) {
    if (picked.length >= 5) break;
    const name = x.feature.properties?.name;
    if (pickedNames.has(name)) continue;
    picked.push(x);
    pickedNames.add(name);
  }
  return picked.sort((a, b) => b.temp - a.temp);
}

function _joinTempList(list) {
  const parts = list.map((x) => `${x.feature.properties?.name} (${x.temp}°C${x.province ? `, ${x.province}` : ""})`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function _chapter2IntroNarrative() {
  return "Chapter 2: the Temperature Outlook. Using live station observations, cross-checked against the PMD 2-metre temperature prediction layer, this chapter surveys the hottest conditions currently reported across the country, one reading from every province.";
}

function _tempLayerNarrative(hottest) {
  const lead = hottest[0];
  const headline = lead
    ? `The hottest conditions currently reported are at ${lead.feature.properties?.name}${lead.province ? ` in ${lead.province}` : ""}, at ${lead.temp}°C.`
    : "No live temperature readings are currently available.";
  const spread = hottest.length > 1
    ? ` Elevated readings also extend to ${_joinTempList(hottest.slice(1, 5))}.`
    : "";
  return `${headline}${spread} The 2m Temperature prediction layer is shown for visual context on the wider thermal pattern only — live station observations remain the authoritative reading.`;
}

function _tempStationNarrative(entry, hottest) {
  const props = entry.feature.properties || {};
  const rank = hottest.findIndex((x) => x.feature === entry.feature) + 1;
  const bits = [`${props.name} is currently reporting ${entry.temp}°C.`];
  if (props.weather) bits.push(`Conditions: ${props.weather}.`);
  if (Number.isFinite(props.wind_speed) && props.wind_speed > 0) bits.push(`Wind ${props.wind_speed} kt.`);
  if (entry.province) bits.push(`${entry.province} — ranked ${rank ? `#${rank}` : "unranked"} nationally by current temperature among reporting stations.`);
  return bits.join(" ");
}

function _tempAssessmentNarrative(hottest) {
  const bits = ["National temperature assessment:"];
  bits.push(hottest.length
    ? `the heaviest heat currently centers on ${_joinTempList(hottest.slice(0, 3))}.`
    : "no significant heat signal is present in current station reports.");
  bits.push("Live station observations, cross-checked against the PMD prediction layer, remain the authoritative record.");
  bits.push("Operational readiness: routine monitoring posture recommended based on current data.");
  return bits.join(" ");
}

// ---- Narrative generation (template-based from real parsed data — no
// values are ever invented, and nothing is extracted from the radar
// raster itself, per the operational brief). --------------------------
function _radarNarrative(report) {
  // Focus is the latest 24h report — the single-day data is the primary
  // source here, matching the operational brief. The 48h dataset is still
  // fetched and available (report.*_multiday) but only appears as a
  // secondary mention, not the headline framing.
  const ranking = _provinceRanking(report);
  const wet = ranking.filter((p) => p.mm > 0);
  const lead = wet[0];
  const corridor = lead
    ? `The primary precipitation corridor over the past 24 hours tracked across ${lead.name}${
        wet.length > 1 ? `, with secondary activity extending into ${wet.slice(1, 3).map((p) => p.name).join(" and ")}` : ""
      }.`
    : "No significant precipitation corridor was detected over the reporting period.";
  // A whole-Pakistan briefing needs district-level standouts from EVERY
  // province represented, not just whichever one led nationally.
  const topDistricts = _topDistrictsAcrossProvinces(report);
  const districtLine = topDistricts.length
    ? ` The heaviest district-level totals nationwide, one from each reporting province, were ${_joinDistrictList(topDistricts.slice(0, 5))}.`
    : "";
  const dry = (report.nil_provinces || []).length
    ? ` ${report.nil_provinces.join(" and ")} remained dry, with no rainfall reported.`
    : "";
  const trace = (report.trace_stations || []).length
    ? ` Trace amounts were logged at ${report.trace_stations.slice(0, 4).join(", ")}.`
    : "";
  const multiday = (report.total_mm_multiday != null && report.window_hours > 24)
    ? ` Over the preceding ${report.window_hours} hours, cumulative rainfall reached ${report.total_mm_multiday} mm nationally.`
    : "";
  return `${corridor}${districtLine}${dry}${trace}${multiday} Satellite infrared imagery is shown for visual assessment of cloud cover and storm organization only — the station network, cross-checked against live observations, is the authoritative rainfall record.`;
}

// Shown once, at the very start of Chapter 1 — orients the operator on
// what this briefing is, before the data-driven narration begins.
function _introNarrative() {
  return "Welcome to the Dynamic Weather Report — a cinematic, data-driven operational briefing built entirely from live PMD and NWFC sources, with no invented figures. This is Chapter 1: the Precipitation Outlook, covering the past 24 hours nationwide. The sequence ahead moves from a national radar sweep, through a guided tour of the heaviest rainfall districts across every province, to a closing operational assessment.";
}

// Strips the "District - " prefix a report station name carries, leaving
// just the gauge/sub-station label (e.g. "Rawalpindi - Gawalmandi" -> "Gawalmandi").
function _subStationName(fullName) {
  const idx = String(fullName || "").indexOf(" - ");
  return idx >= 0 ? fullName.slice(idx + 3) : fullName;
}

// Districts that carry more than one gauge (e.g. Rawalpindi's Gawalmandi +
// Katcheri stations) get ONE scene for the whole district — a stations
// summary — rather than a separate scene per gauge or silently picking
// just the highest one and ignoring the rest.
function _districtStationsNarrative(district, withLive, report) {
  const province = district.province;
  const ranking = _provinceRanking(report);
  const rank = ranking.findIndex((p) => p.name === province) + 1;
  const bits = [];
  if (withLive.length > 1) {
    const parts = withLive.map(({ station }) =>
      station.trace ? `${_subStationName(station.name)} (trace)` : `${_subStationName(station.name)} ${station.mm} mm`
    );
    bits.push(`${district.name} logged rainfall across ${withLive.length} monitoring stations: ${parts.join(", ")}.`);
    bits.push(`District figure of record (highest single gauge): ${district.mm_total} mm.`);
  } else {
    const { station } = withLive[0];
    bits.push(`${district.name} recorded ${station.mm} mm of rainfall in the past 24 hours at its ${_subStationName(station.name)} station.`);
  }
  const live = withLive.find((x) => x.live)?.live;
  const props = live?.properties || {};
  if (props.weather) bits.push(`Current conditions: ${props.weather}.`);
  if (Number.isFinite(props.temperature)) bits.push(`Temperature ${props.temperature}°C.`);
  if (Number.isFinite(props.wind_speed) && props.wind_speed > 0) bits.push(`Wind ${props.wind_speed} kt.`);
  bits.push(`${province} ranks ${rank ? `#${rank}` : "unranked"} nationally by total rainfall.`);
  return bits.join(" ");
}

function _assessmentNarrative(report) {
  // 24h is the primary focus, per the operational brief — the 48h figure
  // (still fetched/available) is only added as a trailing supplementary
  // note, not the headline number.
  const ranking = _provinceRanking(report);
  const wet = ranking.filter((p) => p.mm > 0);
  const dry = ranking.filter((p) => p.nil);
  const strongestWind = (report.wind || []).slice().sort((a, b) => (b.wind_kt || 0) - (a.wind_kt || 0))[0];
  const floodAlert = report.water_level && report.water_level.normal === false;
  const bits = [
    `National operational assessment: ${report.total_mm} mm logged cumulatively across reporting stations in the past 24 hours.`,
  ];
  if (wet.length) bits.push(`Heaviest activity centered on ${wet.slice(0, 2).map((p) => p.name).join(" and ")}.`);
  const topDistricts = _topDistrictsAcrossProvinces(report);
  if (topDistricts.length) bits.push(`District-level standouts, spanning every reporting province: ${_joinDistrictList(topDistricts.slice(0, 5))}.`);
  if (dry.length) bits.push(`${dry.map((p) => p.name).join(" and ")} reported no measurable rainfall.`);
  if (strongestWind) bits.push(`Strongest winds reported at ${strongestWind.station}: ${strongestWind.wind_kt} kt.`);
  bits.push(
    floodAlert
      ? "Water level observations indicate above-normal levels at monitored points — continued flood-risk monitoring is warranted."
      : "Water levels at monitored points remain normal; no flood escalation indicated at this time."
  );
  if (report.total_mm_multiday != null && report.window_hours > 24) {
    bits.push(`For context, the preceding ${report.window_hours} hours totaled ${report.total_mm_multiday} mm nationally.`);
  }
  bits.push("Operational readiness: routine monitoring posture recommended based on current data.");
  return bits.join(" ");
}

// ==========================================================================
// Scene construction — a flat, ordered list built once the data loads.
// ==========================================================================
function _buildScenes(report, observationsFC) {
  const liveFeatures = observationsFC?.features || [];
  const scenes = [
    { kind: "intro", chapter: 1, caption: _introNarrative() },
    { kind: "radar", chapter: 1, caption: _radarNarrative(report) },
  ];

  // District-diverse ranking (one top district per province, filled to
  // >=5 overall) — so the station tour covers the whole country, not
  // just whichever province happened to log the single highest reading.
  // A district with multiple gauges (e.g. Rawalpindi's Gawalmandi +
  // Katcheri stations) becomes ONE scene — a stations summary — rather
  // than a separate scene per gauge, or silently picking just the
  // highest and dropping the rest. Skipped only if NONE of a district's
  // stations can be matched to a live coordinate — nowhere real to fly
  // the camera — per the existing "never guess" philosophy.
  const topDistricts = _topDistrictsAcrossProvinces(report);
  _state.discussedDistricts = topDistricts;
  let added = 0;
  for (const d of topDistricts) {
    if (added >= 8) break;
    const allStations = (report?.provinces?.[d.province]?.stations || [])
      .filter((s) => s.name.split(" - ")[0] === d.name);
    if (!allStations.length) continue;
    const withLive = allStations.map((s) => ({ station: s, live: _matchLiveStation(s.name, liveFeatures) }));
    if (!withLive.some((x) => x.live)) continue;
    scenes.push({
      kind: "station",
      chapter: 1,
      district: d,
      stations: withLive,
      caption: _districtStationsNarrative(d, withLive, report),
    });
    added += 1;
  }

  scenes.push({ kind: "assessment", chapter: 1, caption: _assessmentNarrative(report) });

  // ---- CHAPTER 2 — Temperature Outlook ------------------------------
  // Reuses the SAME report + live observations already fetched for
  // Chapter 1 — the province lookup and hottest-station ranking are the
  // only new computation, no new fetch.
  const provinceLookup = _buildStationProvinceLookup(report);
  const hottest = _hottestStationsAcrossProvinces(observationsFC, provinceLookup);
  _state.hottestStations = hottest;

  scenes.push({ kind: "ch2-intro", chapter: 2, caption: _chapter2IntroNarrative() });
  scenes.push({ kind: "temp-layer", chapter: 2, caption: _tempLayerNarrative(hottest) });
  let addedTemp = 0;
  for (const entry of hottest) {
    if (addedTemp >= 8) break;
    if (!entry.feature?.geometry?.coordinates) continue; // nowhere real to fly the camera
    scenes.push({ kind: "temp-station", chapter: 2, entry, caption: _tempStationNarrative(entry, hottest) });
    addedTemp += 1;
  }
  scenes.push({ kind: "temp-assessment", chapter: 2, caption: _tempAssessmentNarrative(hottest) });

  return scenes;
}

// ==========================================================================
// Rendering
// ==========================================================================
function _loadingHtml(msg) {
  return `<div class="dwr-status"><span class="dwr-status-spinner" aria-hidden="true"></span><span>${_escapeHtml(msg)}</span></div>`;
}
function _errorHtml(msg) {
  return `<div class="dwr-status"><span>${_escapeHtml(msg)}</span></div>`;
}

function _renderDots(card) {
  card.querySelector(".dwr-dots").innerHTML = _state.scenes.map((_, i) => {
    const isSel = i === _state.index;
    return `<button type="button" role="tab" class="dwr-dot ${isSel ? "is-active" : ""}" data-dwr-scene="${i}" aria-selected="${isSel}" title="Scene ${i + 1}"></button>`;
  }).join("");
}

function _sceneTitle(scene) {
  switch (scene.kind) {
    case "intro":           return "Chapter 1 — Precipitation Outlook";
    case "radar":           return "Satellite Infrared — Previous 24 Hours";
    case "station":         return `District Focus — ${scene.district.name} (${scene.district.province})`;
    case "assessment":      return "National Rainfall Assessment";
    case "ch2-intro":       return "Chapter 2 — Temperature Outlook";
    case "temp-layer":      return "2m Temperature — Current Conditions";
    case "temp-station":    return `Station Focus — ${scene.entry.feature.properties?.name}${scene.entry.province ? ` (${scene.entry.province})` : ""}`;
    case "temp-assessment": return "National Temperature Assessment";
    default:                return "Dynamic Weather Report";
  }
}

// One pill per station in the district (so a multi-gauge district like
// Rawalpindi shows Gawalmandi/Katcheri/etc. side by side) plus whichever
// live-feed conditions are available for the district.
function _factPillsForDistrictStations(scene) {
  const { stations } = scene;
  const pills = stations.map(({ station }) =>
    station.trace ? `${_subStationName(station.name)}: trace` : `${_subStationName(station.name)}: ${station.mm} mm`
  );
  const live = stations.find((x) => x.live)?.live;
  const props = live?.properties || {};
  if (props.weather) pills.push(props.weather);
  if (Number.isFinite(props.temperature)) pills.push(`${props.temperature}°C`);
  if (Number.isFinite(props.wind_speed) && props.wind_speed > 0) pills.push(`Wind ${props.wind_speed} kt`);
  return pills;
}

function _renderSceneBody(card, scene) {
  const bodyEl = card.querySelector(".dwr-body");
  let factsHtml = "";
  if (scene.kind === "station") {
    factsHtml = `<div class="dwr-facts">${_factPillsForDistrictStations(scene).map((p) => `<span class="dwr-fact-pill">${_highlightNumbers(_escapeHtml(p))}</span>`).join("")}</div>`;
  } else if (scene.kind === "radar" || scene.kind === "temp-layer") {
    factsHtml = `<div class="dwr-facts"><span class="dwr-fact-pill dwr-frame-pill">Frame <span class="dwr-frame-value">—</span></span></div>`;
  } else if (scene.kind === "assessment") {
    const report = _state.report;
    const total = report?.total_mm ?? 0; // 24h focus — the primary figure
    factsHtml = `<div class="dwr-facts"><span class="dwr-fact-pill">${_hlNum(`${total} mm`)} national total (24h)</span></div>`;
  } else if (scene.kind === "temp-station") {
    const props = scene.entry.feature.properties || {};
    const pills = [`${scene.entry.temp}°C`];
    if (props.weather) pills.push(props.weather);
    if (Number.isFinite(props.wind_speed) && props.wind_speed > 0) pills.push(`Wind ${props.wind_speed} kt`);
    factsHtml = `<div class="dwr-facts">${pills.map((p) => `<span class="dwr-fact-pill">${_highlightNumbers(_escapeHtml(p))}</span>`).join("")}</div>`;
  } else if (scene.kind === "temp-assessment") {
    const lead = _state.hottestStations?.[0];
    factsHtml = lead ? `<div class="dwr-facts"><span class="dwr-fact-pill is-alert">${_hlNum(`${lead.temp}°C`)} peak reading</span></div>` : "";
  }
  bodyEl.innerHTML = `<div class="dwr-caption">${_highlightNumbers(_escapeHtml(scene.caption || ""))}</div>${factsHtml}`;
}

function _renderScene(card) {
  const scene = _state.scenes[_state.index];
  if (!scene) return;
  card.querySelector(".dwr-chapter-title").textContent = _sceneTitle(scene);
  card.querySelector(".dwr-chapter-counter").textContent = `Scene ${_state.index + 1} / ${_state.scenes.length}`;
  const hint = card.querySelector(".dwr-hint");
  if (hint) hint.textContent = scene.chapter === 2 ? "Chapter 2 · Temperature Outlook" : "Chapter 1 · Precipitation Briefing";
  _renderSceneBody(card, scene);
  _renderDots(card);
}

// ==========================================================================
// District-boundary blink overlay — reuses the `district_boundary` vector
// source (already loaded by the map-layers registry / toggled on-demand
// via sourceLayerControl, same as story-provincial-forecast.js), but adds
// its OWN overlay layer ids so neither module ever touches the other's
// state. Highlights whichever districts Chapter 1's narrative and station
// tour are currently discussing.
// ==========================================================================
function _lowerDistrictNameExpr() {
  return ["downcase", ["to-string", ["coalesce", ...DIST_NAME_KEYS.map((k) => ["get", k]), ""]]];
}
function _matchDistrictNamesExpr(names) {
  const unique = Array.from(new Set((names || []).map((s) => String(s).toLowerCase().trim()))).filter(Boolean);
  if (!unique.length) return ["has", "___ncop_never___"];
  return ["match", _lowerDistrictNameExpr(), unique, true, false];
}

async function _ensureDistrictSource() {
  const map = window.ncop_map;
  if (!map) return false;
  if (map.getSource(DIST_SRC)) return true;
  try {
    const slc = window.sourceLayerControl;
    if (slc && typeof slc.addLayerByKey === "function") {
      await slc.addLayerByKey("district_boundary", false);
    }
  } catch (_) { /* best-effort */ }
  return !!map.getSource(DIST_SRC);
}

function _ensureDistrictOverlayLayers() {
  const map = window.ncop_map;
  if (!map || !map.getSource(DIST_SRC) || map.getLayer(HL_DIST_LINE_ID)) return;
  map.addLayer({
    id: HL_DIST_FILL_ID,
    type: "fill",
    source: DIST_SRC,
    "source-layer": DIST_SRC_LAYER,
    filter: ["has", "___ncop_never___"],
    paint: { "fill-color": "#ffffff", "fill-opacity": 0.16 },
  });
  map.addLayer({
    id: HL_DIST_LINE_ID,
    type: "line",
    source: DIST_SRC,
    "source-layer": DIST_SRC_LAYER,
    filter: ["has", "___ncop_never___"],
    paint: { "line-color": "#46b2ff", "line-width": 2.5, "line-opacity": 1 },
  });
}

// Prepares the overlay for a given set of districts (called once the
// report loads, before any scene that needs it actually plays) — safe to
// call even if the map/source isn't ready yet; blink itself only starts
// once _startDistrictBlink is explicitly called from the radar scene.
async function _prepareDistrictHighlight(districts) {
  if (!districts || !districts.length) return;
  const ok = await _ensureDistrictSource();
  if (!ok) return;
  _ensureDistrictOverlayLayers();
  const map = window.ncop_map;
  if (!map) return;
  const expr = _matchDistrictNamesExpr(districts.map((d) => d.name));
  try {
    if (map.getLayer(HL_DIST_FILL_ID)) map.setFilter(HL_DIST_FILL_ID, expr);
    if (map.getLayer(HL_DIST_LINE_ID)) map.setFilter(HL_DIST_LINE_ID, expr);
  } catch (_) { /* best-effort */ }
}

function _startDistrictBlink() {
  _stopDistrictBlink();
  const map = window.ncop_map;
  if (!map) return;
  _state.blinkPhase = false;
  _state.blinkTimer = setInterval(() => {
    _state.blinkPhase = !_state.blinkPhase;
    const wide = _state.blinkPhase;
    try {
      if (map.getLayer(HL_DIST_LINE_ID)) {
        map.setPaintProperty(HL_DIST_LINE_ID, "line-width", wide ? 4 : 2);
        map.setPaintProperty(HL_DIST_LINE_ID, "line-opacity", wide ? 1 : 0.5);
      }
      if (map.getLayer(HL_DIST_FILL_ID)) {
        map.setPaintProperty(HL_DIST_FILL_ID, "fill-opacity", wide ? 0.26 : 0.10);
      }
    } catch (_) { /* best-effort */ }
  }, 550);
}

function _stopDistrictBlink() {
  if (_state.blinkTimer) { clearInterval(_state.blinkTimer); _state.blinkTimer = null; }
}

function _clearDistrictOverlay() {
  _stopDistrictBlink();
  const map = window.ncop_map;
  if (!map) return;
  try {
    if (map.getLayer(HL_DIST_FILL_ID)) map.setFilter(HL_DIST_FILL_ID, ["has", "___ncop_never___"]);
    if (map.getLayer(HL_DIST_LINE_ID)) map.setFilter(HL_DIST_LINE_ID, ["has", "___ncop_never___"]);
  } catch (_) { /* best-effort */ }
}

// ==========================================================================
// Camera + layer choreography per scene kind
// ==========================================================================
async function _runIntro(map, token, seq) {
  _showIntroPopup();
  enableCinematicAtmosphere(map);
  map.jumpTo(REGIONAL_START); // only non-animated cut in the whole sequence — the deliberate "opening shot" starting position
  await cinematicFlyTo(map, {
    center: PAKISTAN_CENTER,
    zoom: 4.6,
    pitch: 35,
    bearing: 0,
    duration: _dur(4200),
  });
  if (_isStale(token, seq)) return;
  // Settle only — no further zoom/orbit motion on this scene. An extra
  // free-camera sweep here just extended the opening without adding
  // information, and any additional camera movement risks pulling the
  // viewport across zoom levels the active raster layers weren't built for.
  await cinematicEaseTo(map, { bearing: 12, pitch: 40, duration: _dur(2200) });
}

// "About this briefing" — shown once, at the very start of Chapter 1,
// answering what this story is, how many chapters exist so far, and what
// layers/data feed it, in plain operator-facing terms. Replaced by the
// radar's own stats popup a few seconds later (same shared popup shell).
function _showIntroPopup() {
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">About This Briefing</span>
      <span class="dwrp-badge">2 Chapters</span>
    </div>
    <div class="dwrp-body">
      A cinematic, data-driven walkthrough of Pakistan's most recent weather picture — every figure traces back to a live PMD/NWFC source; nothing here is scripted or invented. Use the rewind/fast-forward buttons on the transport bar to change playback speed (1x-5x) in either direction.
    </div>
    <div class="dwrp-table-label">Layers used in this briefing</div>
    <div class="dwrp-chips">
      <span class="dwrp-chip">DWD Satellite Infrared</span>
      <span class="dwrp-chip">2m Temperature</span>
      <span class="dwrp-chip">NWFC Station Observations</span>
      <span class="dwrp-chip">District Boundaries</span>
    </div>
    <div class="dwrp-table-label">What happens next</div>
    <div class="dwrp-body">
      1. Cinematic fly-in to Pakistan<br>
      2. Chapter 1 — satellite sweep + 24-hour rainfall stats, then a tour of the heaviest rainfall districts<br>
      3. Chapter 2 — 2m temperature outlook, then a tour of the hottest reporting stations<br>
      4. Closing operational assessment for each chapter
    </div>
    <div class="dwrp-body" style="font-size:10.5px;color:rgba(234,234,234,0.55);font-style:italic;">
      More chapters are planned — this briefing will keep growing.
    </div>
  `);
}

// dwd_satellite_infrared is a TEMPORAL item (data-item-key + class
// ncop-item-temporal, per the sidebar markup) — it activates through
// handleTemporalInteraction() → updateTempSlider/updateTempSliderAsync,
// the exact same path a sidebar click uses, NOT SourceLayerControl (that's
// for TOGGLE items like nwfc_observations below). The temp-slider widget
// that activation normally reveals is hidden immediately — this card's
// own transport drives the briefing, the slider control adds nothing here.
function _hideTempSlider() {
  const slider = document.getElementById("temp-slider1");
  if (slider) slider.style.display = "none";
}

// Shows/updates/clears a small "still loading…" note under a scene's
// caption — used while a slow-generating temporal layer (PMD prediction
// rasters especially) is still being built server-side, so the scene
// never just looks frozen. Pass null/omit msg to clear it.
function _setLayerLoadingNote(card, msg) {
  const body = card?.querySelector(".dwr-body");
  if (!body) return;
  let el = body.querySelector(".dwr-layer-loading");
  if (!msg) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.className = "dwr-layer-loading";
    body.appendChild(el);
  }
  el.textContent = msg;
}

// Generic TEMPORAL-item activation with a genuinely patient wait — some
// layers (dwd_satellite_infrared) publish their frame list synchronously,
// but others (pmd_pred_temp2m and the rest of the PMD prediction family)
// trigger a real server-side render on first request and can take tens of
// seconds. A short poll here just means the fade-in starts before there's
// really anything to show, or fails outright — so this waits properly
// (default up to ~75s) and only gives up if it's still empty after that
// or the scene has gone stale (operator navigated away). Returns true
// once layersDef is populated, false on timeout/staleness.
async function _activateTemporalLayer(map, itemKey, title, token, seq, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 250;
  const pollMs = opts.pollMs ?? 300;
  const slowAfterAttempts = opts.slowAfterAttempts ?? 12; // ~3.5s in
  if (typeof handleTemporalInteraction !== "function") return false;
  handleTemporalInteraction(null, null, itemKey, true, { title });
  _hideTempSlider();
  let announcedSlow = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (_isStale(token, seq)) return false;
    const state = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
    if (state?.layerKey === itemKey && Array.isArray(state.layersDef) && state.layersDef.length) {
      _hideTempSlider(); // re-assert — some frame-build steps can re-show it mid-flight
      _state.activeLayerKey = itemKey;
      return true;
    }
    if (!announcedSlow && attempt >= slowAfterAttempts && opts.onSlow) {
      announcedSlow = true;
      opts.onSlow();
    }
    await wait(pollMs);
  }
  return false;
}

// Reverses _activateTemporalLayer — fades the layer's current frame out
// and deactivates it via the same handleTemporalInteraction path a
// sidebar click would use.
async function _deactivateTemporalLayer(map, itemKey) {
  const temporal = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
  const layerIds = (temporal?.currentEntry?.layers || []).map((l) => l.id).filter((id) => map.getLayer(id));
  await Promise.all(layerIds.map((id) => fadeLayerOpacity(map, id, "raster-opacity", 0.85, 0, _dur(1200))));
  try {
    if (typeof handleTemporalInteraction === "function") {
      handleTemporalInteraction(null, null, itemKey, false, {});
    }
  } catch (_) {}
}

async function _runRadar(map, token, seq) {
  // Explicit whole-Pakistan, map-readable framing for the overview — a
  // gentle settle rather than a big jump, since the intro already leaves
  // the camera close to this. Flatter pitch than the intro/station scenes
  // so the popup's stats table reads easily alongside the radar.
  await cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.7, pitch: 15, bearing: 0, duration: _dur(1800) });
  if (_isStale(token, seq)) return;

  const card = document.getElementById(CARD_ID);
  const ready = await _activateTemporalLayer(map, RADAR_ITEM_KEY, "DWD Satellite Infrared", token, seq, {
    onSlow: () => _setLayerLoadingNote(card, "Loading DWD Satellite Infrared imagery…"),
  });
  _setLayerLoadingNote(card, null);
  if (_isStale(token, seq)) return;
  if (!ready) { if (_state.report) _showRadarPopup(_state.report); return; }

  // Resolve the actual rendered layer id(s) for this frame from the
  // temporal state — dwd_satellite_infrared is a raster layer, so its
  // opacity property is "raster-opacity".
  const temporal = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
  const layerIds = (temporal?.currentEntry?.layers || []).map((l) => l.id).filter((id) => map.getLayer(id));
  for (const id of layerIds) {
    try { map.setPaintProperty(id, "raster-opacity", 0); } catch (_) {}
  }
  await wait(150); // let the tiles paint at opacity 0 before animating up, avoids a "pop"
  if (_isStale(token, seq)) return;
  await Promise.all(layerIds.map((id) => fadeLayerOpacity(map, id, "raster-opacity", 0, 0.85, _dur(2000))));
  if (_isStale(token, seq)) return;

  // Start the temporal slider's own autoplay and just leave it running —
  // its native loop already wraps from the last frame back to the first
  // on its own, so this plays continuously for as long as the operator
  // stays on this scene. The loop below is fire-and-forget: it watches
  // for the scene to go stale (operator moves on) and, at that point,
  // pauses the layer at whatever frame it's on rather than fading it out
  // — "keep the layer on, but paused" through the rest of the chapter,
  // not hidden between scenes.
  _playTemporalLoop(token, seq);

  // Blink the districts this chapter is discussing (top rainfall,
  // one per province) on the boundary layer — stays blinking through the
  // station tour, stopped when the closing assessment scene begins.
  _startDistrictBlink();

  // National stats table + PDF source link, shown while the radar plays
  // and before the camera moves on to individual stations.
  if (_state.report) _showRadarPopup(_state.report);
}

// The native #temp-slider1 autoplay (temporal-controls.js's own
// playAnimation()) only offers fixed 0.5x/1x/2x/3x speeds — all far too
// fast for a slow-generating layer: stepping frames that quickly asks the
// active raster layer's tile provider for a new frame every ~300-2000ms,
// which is what produced the repeated 400/404 tile errors against
// meteoblue's precipitation_radar (dropped for this exact reason). So this
// drives the SAME slider element itself, but at our own much slower,
// explicit cadence (0.05x of the native 1x baseline, i.e. one frame
// roughly every 20s) — one frame gets plenty of time to load and be seen
// before the next is requested. Shared by every "layer" scene (radar in
// Chapter 1, temperature in Chapter 2), not radar-specific despite the name.
// Setting `.value` alone doesn't invoke the slider's own frame-rendering
// logic (showTimeStepLayers, private to temporal-controls.js), so a
// synthetic "input" event is dispatched — the exact event its own
// listener (temporal-controls.js) is already wired to, just triggered by
// us instead of a native pointer drag. Runs in the background (not
// awaited by the caller) for as long as this scene stays active; stops
// the instant the scene goes stale (operator moved to another scene) —
// the layer itself is never faded out here, only this stepping stops.
// Also sets _state.pendingMinDwellMs (read once by _gotoScene's next
// _scheduleAdvance call) so the scene holds long enough to actually SHOW
// a full lap of frames rather than moving on after showing just one.
const TEMPORAL_STEP_BASE_MS = 1000; // matches temporal-controls.js's own 1x baseline
const TEMPORAL_STEP_SPEED = 0.05;   // requested playback speed for these layer scenes
function _playTemporalLoop(token, seq) {
  const slider = document.getElementById("slider1");
  if (!slider) return;

  const maxVal = parseInt(slider.max, 10);
  if (!Number.isFinite(maxVal) || maxVal < 1) return; // only one frame — nothing to step through

  const stepMs = TEMPORAL_STEP_BASE_MS / TEMPORAL_STEP_SPEED; // 20,000ms/frame at 0.05x
  _state.pendingMinDwellMs = Math.min(maxVal * stepMs, 60000); // capped — don't hold forever on a huge frame count
  _runTemporalLoop(slider, maxVal, stepMs, token, seq); // fire-and-forget
}
async function _runTemporalLoop(slider, maxVal, stepMs, token, seq) {
  // layer-panels.js checks this same flag (set by the native autoplay
  // button too) to avoid re-rendering mid frame-swap — keep it consistent
  // even though our cadence is far slower than what that flag usually guards.
  window.isTemporalAnimating = true;
  try {
    while (!_isStale(token, seq)) {
      _updateFrameLabel();
      await wait(stepMs / (_state.speed || 1));
      if (_isStale(token, seq)) break;
      const cur = parseInt(slider.value, 10) || 0;
      const next = cur < maxVal ? cur + 1 : 0;
      slider.value = next;
      try { slider.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) { /* best-effort */ }
    }
  } finally {
    window.isTemporalAnimating = false;
  }
}

// Reads the temporal slider's own current-frame state (already exposed
// globally by temporal-controls.js) and reflects it into the story
// card's "Frame N/M — <label>" readout — the visible timestep labelling
// a layer scene needs, without reviving the native #temp-slider1 panel
// the operational brief explicitly asked to keep hidden. Generic — shared
// by the radar scene (Chapter 1) and the temperature scene (Chapter 2).
function _updateFrameLabel() {
  const card = document.getElementById(CARD_ID);
  const valEl = card?.querySelector(".dwr-frame-value");
  if (!valEl) return;
  const t = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
  if (!t) return;
  const total = Array.isArray(t.layersDef) ? t.layersDef.length : 0;
  const idx = (t.currentIndex ?? 0) + 1;
  valEl.textContent = `${idx}${total ? `/${total}` : ""}${t.date ? ` — ${t.date}` : ""}`;
}

async function _ensureObservationsOn() {
  if (!window.sourceLayerControl || typeof window.sourceLayerControl.addLayerByKey !== "function") return;
  await window.sourceLayerControl.addLayerByKey(OBS_ITEM_KEY);
  // nwfc_observations renders via mapboxgl.Marker DOM overlays (see
  // nwfc-html-markers.js), not a GL paint property — approximate a fade
  // with a CSS animation class on #map rather than reaching into that
  // module's marker-creation code.
  const mapEl = document.getElementById("map");
  if (mapEl) {
    mapEl.classList.add("ncop-dwr-fade-in");
    setTimeout(() => mapEl.classList.remove("ncop-dwr-fade-in"), 1800);
  }
}

function _centroid(coords) {
  const n = coords.length;
  const sum = coords.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
  return [sum[0] / n, sum[1] / n];
}

// Frames a district's matched station coordinate(s) at a FIXED, moderate
// aerial zoom — never nudged in further for any reason. Zooming in past
// this triggers Mapbox to request higher-zoom tiles for whatever raster
// layer is still visible (DWD Satellite Infrared now, which stays on
// through the station tour) — the meteoblue precipitation_radar layer
// this used to be was dropped for exactly this reason (repeated 400s,
// burning its API key's rate limit) and there's no proof the replacement
// tile source tolerates deep zoom any better, so the same caution applies.
// A single station gets a flyTo at that height; multiple stations in the
// same district (e.g. Rawalpindi's Gawalmandi + Katcheri gauges) get a
// fitBounds over all of them, capped at the same max zoom so a
// tightly-clustered pair doesn't punch in closer than the rest of the tour.
async function _frameDistrictCluster(map, coords, opts = {}) {
  const zoom = opts.zoom ?? 8.4;
  const pitch = opts.pitch ?? 40;
  const duration = _dur(opts.duration ?? 2600);
  const bearing = opts.bearing ?? 0;
  if (coords.length <= 1) {
    const [lng, lat] = coords[0];
    return cinematicFlyTo(map, { center: [lng, lat], zoom, pitch, bearing, duration });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minX) minX = lng;
    if (lng > maxX) maxX = lng;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  }
  const padDeg = 0.1; // pads tight clusters so fitBounds doesn't over-zoom past the aerial height below
  return cinematicFitBounds(map, [[minX - padDeg, minY - padDeg], [maxX + padDeg, maxY + padDeg]], {
    pitch, bearing, duration, maxZoom: opts.maxZoom ?? 9.0,
  });
}

async function _runStation(map, scene, token, seq) {
  const matched = scene.stations.filter((s) => s.live);
  const coords = matched.map((s) => s.live.geometry.coordinates);
  if (!coords.length) return;
  const hasRain = scene.stations.some((s) => (s.station?.mm || 0) > 0);

  // One fixed aerial zoom for every district, regardless of rainfall —
  // no extra zoom-in step. See _frameDistrictCluster for why: any closer
  // and the still-visible DWD Satellite Infrared layer starts requesting
  // tile zooms its provider may not serve.
  await _frameDistrictCluster(map, coords, {
    pitch: 40,
    bearing: (Math.random() * 30) - 15, // gentle scene-to-scene bearing variety, not a random spin
    duration: 2600,
  });
  if (_isStale(token, seq)) return;

  // Mapbox's rain example (setRain) for districts that actually recorded
  // rainfall — zoom-gated to the SAME 8.4-9.0 range _frameDistrictCluster
  // already holds at, so the effect appears without any extra zoom-in
  // step or camera move: "no need [for extra] animation once this is
  // visible", it's just part of the shot that's already framed.
  if (hasRain) enableRainEffect(map, { zoomStart: 7.5, zoomEnd: 8.6 });
  else disableRainEffect(map);

  // Free-camera sweep over the district cluster — the same
  // animate-camera-around-point technique used in the intro, but at an
  // altitude well above Pakistan's highest terrain (K2 ~8,611 m) so the
  // orbit reads as a high aerial/drone pass rather than a close hover
  // that clips through 3D terrain or implies a tile-busting zoom level.
  await orbitAroundPoint(map, _centroid(coords), {
    durationMs: _dur(3400),
    radiusMeters: 16000,
    altitudeMeters: 9500,
    revolutions: 0.2,
  });
  if (_isStale(token, seq)) return;

  const mapEl = document.getElementById("map");
  if (mapEl) {
    mapEl.classList.add("ncop-dwr-pulse-target");
    setTimeout(() => mapEl.classList.remove("ncop-dwr-pulse-target"), 2400);
  }
  _showStationPopup(scene);
}

async function _runAssessment(map) {
  _closePopup();
  _clearDistrictOverlay();
  disableRainEffect(map);
  // This is now the radar layer's real teardown point — Chapter 1 keeps
  // it visible-but-paused through the whole station tour (see
  // _playTemporalLoop), and only fades it out here at the close.
  await _deactivateTemporalLayer(map, RADAR_ITEM_KEY);
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(2400) });
  disableCinematicAtmosphere(map);
}

// ==========================================================================
// CHAPTER 2 — Temperature Outlook. Mirrors Chapter 1's structure and every
// preference established there: DWD-style long-timeout layer activation
// (_activateTemporalLayer), the slow 0.05x frame-stepping loop
// (_playTemporalLoop) with a minimum scene hold so a lap is actually
// visible, drone-height camera work (_frameDistrictCluster/orbitAroundPoint
// at the same fixed, never-nudged-in zoom), fast-forward/rewind speed via
// _dur(), number highlighting, and the district-blink overlay re-pointed
// at the hottest stations instead of rainfall districts.
// ==========================================================================
async function _runChapter2Intro(map, token, seq) {
  // Chapter 1's assessment already leaves the camera at a national
  // fitBounds view — just a brief re-settle, no new fly-in needed.
  await cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.8, pitch: 25, bearing: -8, duration: _dur(2000) });
}

async function _runTempLayer(map, token, seq) {
  await cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.7, pitch: 15, bearing: 0, duration: _dur(1800) });
  if (_isStale(token, seq)) return;

  const card = document.getElementById(CARD_ID);
  // PMD prediction layers colorize rasters server-side on first request —
  // this can genuinely take up to a minute, unlike DWD's pre-baked frames,
  // so this gets the same patient wait plus an explicit "still loading" note.
  const ready = await _activateTemporalLayer(map, TEMP_ITEM_KEY, "2m Temperature", token, seq, {
    onSlow: () => _setLayerLoadingNote(card, "Generating 2m Temperature forecast imagery — this can take up to a minute on first load…"),
  });
  _setLayerLoadingNote(card, null);
  if (_isStale(token, seq)) return;
  if (!ready) { _showTempLayerPopup(_state.hottestStations); return; }

  const temporal = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
  const layerIds = (temporal?.currentEntry?.layers || []).map((l) => l.id).filter((id) => map.getLayer(id));
  for (const id of layerIds) {
    try { map.setPaintProperty(id, "raster-opacity", 0); } catch (_) {}
  }
  await wait(150);
  if (_isStale(token, seq)) return;
  await Promise.all(layerIds.map((id) => fadeLayerOpacity(map, id, "raster-opacity", 0, 0.75, _dur(2000))));
  if (_isStale(token, seq)) return;

  _playTemporalLoop(token, seq);

  // Re-point the SAME district-blink overlay Chapter 1 used at the
  // hottest stations instead — a fresh call to _prepareDistrictHighlight
  // overwrites the boundary filter, so this cleanly takes over from
  // whatever Chapter 1 last set it to.
  const hotNames = (_state.hottestStations || [])
    .map((x) => ({ name: x.feature.properties?.name }))
    .filter((d) => d.name);
  _prepareDistrictHighlight(hotNames).then(() => { if (!_isStale(token, seq)) _startDistrictBlink(); });

  _showTempLayerPopup(_state.hottestStations);
}

async function _runTempStation(map, scene, token, seq) {
  const coords = scene.entry?.feature?.geometry?.coordinates;
  if (!coords) return;

  await _frameDistrictCluster(map, [coords], {
    pitch: 40,
    bearing: (Math.random() * 30) - 15,
    duration: 2600,
  });
  if (_isStale(token, seq)) return;

  await orbitAroundPoint(map, coords, {
    durationMs: _dur(3400),
    radiusMeters: 16000,
    altitudeMeters: 9500,
    revolutions: 0.2,
  });
  if (_isStale(token, seq)) return;

  const mapEl = document.getElementById("map");
  if (mapEl) {
    mapEl.classList.add("ncop-dwr-pulse-target");
    setTimeout(() => mapEl.classList.remove("ncop-dwr-pulse-target"), 2400);
  }
  _showTempStationPopup(scene);
}

async function _runTempAssessment(map) {
  _closePopup();
  _clearDistrictOverlay();
  disableRainEffect(map);
  await _deactivateTemporalLayer(map, TEMP_ITEM_KEY);
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(2400) });
  disableCinematicAtmosphere(map);
}

// ---- Floating popup — shared shell, two content builders -----------------
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
function _presentPopup(html) {
  const el = _ensurePopup();
  if (!el) return;
  el.innerHTML = html;
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });
}
function _showStationPopup(scene) {
  const { district, stations } = scene;
  const live = stations.find((x) => x.live)?.live;
  const props = live?.properties || {};
  const chips = _factPillsForDistrictStations(scene)
    .map((p) => `<span class="dwrp-chip">${_highlightNumbers(_escapeHtml(p))}</span>`)
    .join("");
  // Multi-gauge districts (e.g. Rawalpindi's Gawalmandi + Katcheri) get a
  // small per-station breakdown table under the summary caption; a
  // single-gauge district skips it — the caption already says it all.
  const rows = stations.length > 1 ? stations.map(({ station, live: st }) => {
    const val = station.trace ? "Trace" : _hlNum(`${station.mm} mm`);
    const liveRain = st?.properties?.rain_24h;
    const liveNote = Number.isFinite(liveRain) ? `<div class="dwrp-live-note">Live: ${_hlNum(`${liveRain} mm/24h`)}</div>` : "";
    return `<tr><td>${_escapeHtml(_subStationName(station.name))}</td><td>${val}${liveNote}</td></tr>`;
  }).join("") : "";
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">${_escapeHtml(district.name)}</span>
      <span class="dwrp-badge">${_escapeHtml(props.obs_time || district.province)}</span>
    </div>
    <div class="dwrp-body">
      ${_highlightNumbers(_escapeHtml(scene.caption || ""))}
      ${rows ? `
      <div class="dwrp-table-label">Stations in ${_escapeHtml(district.name)}</div>
      <table class="dwrp-table">
        <thead><tr><th>Station</th><th>Rainfall</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ""}
    </div>
    ${chips ? `<div class="dwrp-chips">${chips}</div>` : ""}
  `);
}
// National overview popup shown while the radar plays and the camera
// holds the whole-country view — a stats table + a link back to the
// actual PMD PDF this data was parsed from, for verification.
// Cross-references a district/station name against the LIVE NWFC
// observations feed's own rain_24h reading — reuses the same tolerant
// name-matching already built for the station tour. Purely a "does the
// live feed corroborate this" supplementary note; the PDF report stays
// the authoritative figure per the operational brief.
function _liveRainForName(name, liveFeatures) {
  const f = _matchLiveStation(name, liveFeatures);
  const rain = f?.properties?.rain_24h;
  return Number.isFinite(rain) ? rain : null;
}

function _pdfLinkRow(r) {
  return `
    <div class="dwrp-pdf-row">
      <span class="dwrp-pdf-badge">PDF</span>
      <span class="dwrp-pdf-body">
        <span class="dwrp-pdf-title">NWFC Daily Rainfall</span>
        <span class="dwrp-pdf-meta">${_escapeHtml(r.date || "")}</span>
      </span>
      <a class="dwrp-pdf-open" href="${_escapeHtml(r.source_url || "#")}" target="_blank" rel="noopener" title="Open PDF in new tab">↗</a>
    </div>
  `;
}

// National overview popup shown while the radar plays and the camera
// holds the whole-country view. Two comparisons (province, then
// district) over the multi-day aggregation window the backend computed
// (report.*_multiday — falls back to the single latest day if that
// backend is older/unavailable), each district row cross-checked against
// the live NWFC observations feed, plus a sample of the actual source
// PDF(s) this was parsed from for verification.
// Focus is the latest 24h report (per the operational brief) — both
// tables are single-day. The 48h dataset is still fetched by the backend
// and appears only as one secondary line, not the headline. PDF sample
// rows still show both source reports either way, since that's about
// verifying the source, not which window is "the" number.
function _showRadarPopup(report) {
  const liveFeatures = _state.observations?.features || [];

  const provinceRanking = _provinceRanking(report);
  const provinceRows = provinceRanking.slice(0, 6).map((p) => `
    <tr><td>${_escapeHtml(p.name)}</td><td>${p.mm > 0 ? _hlNum(`${p.mm} mm`) : "NIL"}</td></tr>
  `).join("");

  // Province-diverse district ranking — every reporting province gets a
  // row before any second entry from the leading province appears.
  const districts = _topDistrictsAcrossProvinces(report);
  const districtRows = districts.slice(0, 8).map((d) => {
    const live = _liveRainForName(d.name, liveFeatures);
    const liveNote = live != null ? `<div class="dwrp-live-note">Live station feed: ${_hlNum(`${live} mm/24h`)}</div>` : "";
    return `
      <tr>
        <td>${_escapeHtml(d.name)}<div class="dwrp-district-prov">${_escapeHtml(d.province)}</div></td>
        <td>${_hlNum(`${d.mm_total} mm`)}${liveNote}</td>
      </tr>
    `;
  }).join("");

  const pdfRows = (report.reports && report.reports.length ? report.reports : [{ date: report.date, source_url: report.source_url }])
    .map(_pdfLinkRow).join("");
  const strongestWind = (report.wind || []).slice().sort((a, b) => (b.wind_kt || 0) - (a.wind_kt || 0))[0];
  const floodLine = report.water_level && report.water_level.normal === false
    ? "Above-normal water levels reported at monitored points."
    : "Water levels at monitored points remain normal.";
  const multidayLine = (report.total_mm_multiday != null && report.window_hours > 24)
    ? `<div class="dwrp-summary-line dwrp-summary-secondary">Preceding ${report.window_hours}h total: ${_hlNum(`${report.total_mm_multiday} mm`)}</div>`
    : "";

  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">24-Hour Rainfall Summary</span>
      <span class="dwrp-badge">${_escapeHtml(report.date || "")}</span>
    </div>
    <div class="dwrp-body">
      <div class="dwrp-table-label">By Province — highest first</div>
      <table class="dwrp-table">
        <thead><tr><th>Province</th><th>Rainfall</th></tr></thead>
        <tbody>${provinceRows}</tbody>
      </table>
      ${districtRows ? `
      <div class="dwrp-table-label">By District — top ${Math.min(8, districts.length)}, one per province first, cross-checked against live stations</div>
      <table class="dwrp-table">
        <thead><tr><th>District</th><th>Rainfall</th></tr></thead>
        <tbody>${districtRows}</tbody>
      </table>` : ""}
      <div class="dwrp-summary-line">National total: ${_hlNum(`${report.total_mm} mm`)} (24h)</div>
      ${strongestWind ? `<div class="dwrp-summary-line">Strongest wind: ${_escapeHtml(strongestWind.station)} — ${_hlNum(`${strongestWind.wind_kt} kt`)}</div>` : ""}
      <div class="dwrp-summary-line">${floodLine}</div>
      ${multidayLine}
    </div>
    <div class="dwrp-pdf-list">${pdfRows}</div>
  `);
}

// National temperature overview popup — mirrors _showRadarPopup's shape
// (one table, one summary line) but for Chapter 2's live-station ranking
// instead of the parsed rainfall report.
function _showTempLayerPopup(hottest) {
  const list = hottest || [];
  const rows = list.slice(0, 8).map((x) => {
    const props = x.feature.properties || {};
    return `
      <tr>
        <td>${_escapeHtml(props.name || "")}<div class="dwrp-district-prov">${_escapeHtml(x.province || "")}</div></td>
        <td>${_hlNum(`${x.temp}°C`)}</td>
      </tr>
    `;
  }).join("");
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">Current Temperature Outlook</span>
      <span class="dwrp-badge">Live</span>
    </div>
    <div class="dwrp-body">
      ${rows ? `
      <div class="dwrp-table-label">Hottest stations — one per province first</div>
      <table class="dwrp-table">
        <thead><tr><th>Station</th><th>Temperature</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="dwrp-summary-line">No live temperature readings are currently available.</div>`}
      <div class="dwrp-summary-line dwrp-summary-secondary">Layer: PMD 2m Temperature prediction — visual context only, live stations are authoritative.</div>
    </div>
  `);
}

function _showTempStationPopup(scene) {
  const props = scene.entry.feature.properties || {};
  const chips = [`${scene.entry.temp}°C`];
  if (props.weather) chips.push(props.weather);
  if (Number.isFinite(props.wind_speed) && props.wind_speed > 0) chips.push(`Wind ${props.wind_speed} kt`);
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">${_escapeHtml(props.name || "")}</span>
      <span class="dwrp-badge">${_escapeHtml(props.obs_time || "")}</span>
    </div>
    <div class="dwrp-body">${_highlightNumbers(_escapeHtml(scene.caption || ""))}</div>
    <div class="dwrp-chips">${chips.map((p) => `<span class="dwrp-chip">${_highlightNumbers(_escapeHtml(p))}</span>`).join("")}</div>
  `);
}

function _closePopup() {
  const el = _state.popupEl;
  if (!el) return;
  el.style.opacity = "0";
  el.style.transform = "translateY(-8px)";
  setTimeout(() => { if (el) el.innerHTML = ""; }, 300);
}
function _removePopup() {
  if (_state.popupEl) { try { _state.popupEl.remove(); } catch (_) {} }
  _state.popupEl = null;
}

// ==========================================================================
// Playback — linear cinematic sequence, not a random-access day picker.
// Play/Pause controls whether it auto-advances; Prev/Next/dots let the
// operator jump directly to any scene (choreography re-runs for that
// scene so it never looks "cut off").
// ==========================================================================
function _setPlayGlyph(card, playing) {
  const b = card.querySelector(".dwr-btn--play");
  if (!b) return;
  b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  b.classList.toggle("dwr-btn--play-glyph", !playing);
  b.title = playing ? "Pause" : "Play";
}

// `token` goes stale on hide/teardown; `seq` goes stale on ANY navigation
// (including a simple Next click while the previous scene's camera work
// is still animating). Checking both means two _enterScene calls can
// never both be mid-flight fighting over the camera.
function _isStale(token, seq) {
  return token !== _state.runToken || seq !== _state.sceneSeq;
}

async function _enterScene(card, scene, token, seq) {
  const map = window.ncop_map;
  _renderScene(card);
  _speak(scene.caption || "");
  if (!map) { await wait(2000); return; }

  try {
    if (scene.kind === "intro") {
      await _runIntro(map, token, seq);
    } else if (scene.kind === "radar") {
      await _runRadar(map, token, seq);
    } else if (scene.kind === "station") {
      if (_isStale(token, seq)) return;
      const prevKind = _state.scenes[_state.index - 1]?.kind;
      if (prevKind === "radar") {
        // The radar layer itself stays ON — _playTemporalLoop already
        // paused it at its current frame the moment this scene became
        // active (its own staleness check). Only the popup content swaps.
        _closePopup();
        await wait(320);
      }
      // Only turn observations on once, entering the station-tour phase —
      // not on every single station-to-station hop within the tour.
      if (prevKind !== "station") await _ensureObservationsOn();
      if (_isStale(token, seq)) return;
      await _runStation(map, scene, token, seq);
    } else if (scene.kind === "assessment") {
      if (_isStale(token, seq)) return;
      await _runAssessment(map);
    } else if (scene.kind === "ch2-intro") {
      await _runChapter2Intro(map, token, seq);
    } else if (scene.kind === "temp-layer") {
      await _runTempLayer(map, token, seq);
    } else if (scene.kind === "temp-station") {
      if (_isStale(token, seq)) return;
      const prevKind = _state.scenes[_state.index - 1]?.kind;
      if (prevKind === "temp-layer") {
        // Same pattern as Chapter 1's radar->station handoff — the layer
        // stays ON (paused at its current frame), only the popup swaps.
        _closePopup();
        await wait(320);
      }
      if (prevKind !== "temp-station" && prevKind !== "station") await _ensureObservationsOn();
      if (_isStale(token, seq)) return;
      await _runTempStation(map, scene, token, seq);
    } else if (scene.kind === "temp-assessment") {
      if (_isStale(token, seq)) return;
      await _runTempAssessment(map);
    }
  } catch (_) { /* best-effort — a camera/layer hiccup shouldn't stall the whole briefing */ }
}

function _clearAdvanceTimers() {
  if (_state.tickTimer) { clearTimeout(_state.tickTimer); _state.tickTimer = null; }
  if (_state.progRaf) { cancelAnimationFrame(_state.progRaf); _state.progRaf = null; }
}

// Word-count pace estimate — same heuristic story-provincial-forecast.js
// uses for its own TTS scenes — purely to drive the progress bar's visual
// pace; the REAL advance gate below is speechSynthesis actually finishing.
function _estimateSpeechMs(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  if (!words) return 4000;
  return Math.max(4000, Math.min(45000, words * 480 + 1500));
}

async function _gotoScene(rawIdx, byUser) {
  const n = _state.scenes.length;
  if (!n) return;
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  _clearAdvanceTimers();
  _state.index = ((rawIdx % n) + n) % n;
  const token = _state.runToken;
  const seq = ++_state.sceneSeq;
  const fill = card.querySelector(".dwr-progress-fill");
  if (fill) fill.style.width = "0%";
  const scene = _state.scenes[_state.index];
  await _enterScene(card, scene, token, seq);
  if (_isStale(token, seq)) return; // superseded by a newer navigation, or hidden/torn down mid-scene
  // A layer scene (radar/temperature) may have just set this, synchronously,
  // from _playTemporalLoop — read-and-clear so it only affects THIS scene's
  // hold time, not every scene from here on.
  const minDwellMs = _state.pendingMinDwellMs || 0;
  _state.pendingMinDwellMs = 0;
  if (_state.isPlaying) _scheduleAdvance(card, token, seq, scene?.caption, minDwellMs);
}

// If narration is on, the scene holds until the voice actually finishes
// (re-checking every second past the estimate rather than cutting it off
// — the estimate only paces the progress bar; the actual gate is
// speechSynthesis.speaking, and _speak() already scales utter.rate by
// _state.speed, so TTS mode speeds up "for free"). If narration is off, a
// standard 20s dwell applies instead, divided by the current speed.
// `minDwellMs` (set by layer scenes so a frame-stepping timelapse is
// actually visible before auto-advance) is respected as a FLOOR, not
// divided by speed — fast-forwarding through a layer scene is still
// allowed to cut it short, same as any manual Next/dot click would.
function _scheduleAdvance(card, token, seq, caption, minDwellMs = 0) {
  _clearAdvanceTimers();
  const base = (_state.ttsEnabled ? _estimateSpeechMs(caption) : DWELL_MS_NO_TTS) / (_state.speed || 1);
  const dwellMs = Math.max(base, minDwellMs);
  const fill = card.querySelector(".dwr-progress-fill");
  const start = performance.now();

  const tickProgress = () => {
    if (_isStale(token, seq) || !_state.isPlaying) return;
    const pct = Math.min(100, ((performance.now() - start) / dwellMs) * 100);
    if (fill) fill.style.width = `${pct}%`;
    if (pct < 100) _state.progRaf = requestAnimationFrame(tickProgress);
  };
  _state.progRaf = requestAnimationFrame(tickProgress);

  const advanceOrRecheck = () => {
    _state.tickTimer = null;
    if (_isStale(token, seq) || !_state.isPlaying) return;
    const stillSpeaking = _state.ttsEnabled && window.speechSynthesis
      && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
    if (stillSpeaking) {
      _state.tickTimer = setTimeout(advanceOrRecheck, 1000);
      return;
    }
    _gotoScene(_state.index + _state.direction, false);
  };
  _state.tickTimer = setTimeout(advanceOrRecheck, dwellMs);
}

function _play() {
  const card = document.getElementById(CARD_ID);
  if (!card || _state.scenes.length < 2) return;
  _state.isPlaying = true;
  _setPlayGlyph(card, true);
  _scheduleAdvance(card, _state.runToken, _state.sceneSeq, _state.scenes[_state.index]?.caption);
}
function _pause() {
  const card = document.getElementById(CARD_ID);
  _state.isPlaying = false;
  _clearAdvanceTimers();
  _stopSpeaking();
  if (card) _setPlayGlyph(card, false);
}
// Explicit Play always resets to normal 1x forward playback — matches
// typical media-player behavior where pressing Play cancels any FF/RW
// mode, and keeps this button's outcome predictable regardless of
// whatever speed/direction the transport was left in.
function _togglePlay() {
  if (_state.isPlaying) { _pause(); return; }
  _setSpeed(1, 1);
  _play();
}

// ---- Fast-forward / rewind ------------------------------------------------
// Two buttons cycling the SAME speed ladder (1x-5x), one per direction.
// Pressing the button for whichever direction ISN'T currently active
// always starts that direction fresh at 1x (a clean "switch direction"
// gesture); pressing the button for the direction ALREADY active escalates
// to the next level, wrapping back to 1x after 5x.
function _setSpeed(speed, direction) {
  _state.speed = speed;
  _state.direction = direction;
  _updateSpeedButtons();
}
function _updateSpeedButtons() {
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  const ff = card.querySelector(".dwr-btn--ff");
  const rw = card.querySelector(".dwr-btn--rw");
  const ffOn = _state.direction === 1 && _state.speed > 1;
  const rwOn = _state.direction === -1;
  if (ff) {
    ff.classList.toggle("is-active", ffOn);
    const label = ff.querySelector(".dwr-speed-label");
    if (label) label.textContent = ffOn ? `${_state.speed}x` : "";
  }
  if (rw) {
    rw.classList.toggle("is-active", rwOn);
    const label = rw.querySelector(".dwr-speed-label");
    if (label) label.textContent = rwOn ? `${_state.speed}x` : "";
  }
}
function _rescheduleCurrentAdvance() {
  const card = document.getElementById(CARD_ID);
  if (!card || !_state.isPlaying) return;
  _scheduleAdvance(card, _state.runToken, _state.sceneSeq, _state.scenes[_state.index]?.caption);
}
function _cycleSpeed(direction) {
  if (_state.direction !== direction) {
    _setSpeed(1, direction);
  } else {
    const idx = SPEED_LEVELS.indexOf(_state.speed);
    _setSpeed(SPEED_LEVELS[(idx + 1) % SPEED_LEVELS.length], direction);
  }
  if (!_state.isPlaying) _play();
  else _rescheduleCurrentAdvance();
}

// ==========================================================================
// Show / hide (driven by #storySelect)
// ==========================================================================
async function _loadAndPlay(card) {
  const token = _state.runToken;
  card.querySelector(".dwr-body").innerHTML = _loadingHtml("Loading rainfall report and station observations…");
  card.querySelector(".dwr-chapter-title").textContent = "Dynamic Weather Report";
  card.querySelector(".dwr-chapter-counter").textContent = "";

  let report, observations;
  try {
    [report, observations] = await Promise.all([
      _fetchRainfallReport(),
      getNwfcObservations().catch(() => null),
    ]);
  } catch (e) {
    if (token !== _state.runToken) return;
    card.querySelector(".dwr-body").innerHTML = _errorHtml(`Couldn't load the rainfall briefing: ${e.message}`);
    return;
  }
  if (token !== _state.runToken) return;
  if (report?.error) {
    card.querySelector(".dwr-body").innerHTML = _errorHtml(`Rainfall report unavailable: ${report.error}`);
    return;
  }

  _state.report = report;
  _state.observations = observations;
  _state.scenes = _buildScenes(report, observations); // also sets _state.discussedDistricts / hottestStations
  _state.index = 0;
  _setSpeed(1, 1); // fresh load always starts at normal forward speed, regardless of a prior session
  _prepareDistrictHighlight(_state.discussedDistricts);

  await _gotoScene(0, false);
  if (token !== _state.runToken) return;
  _play();
}

function _show() {
  _injectStyles();
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  _state.runToken += 1; // invalidate any previous in-flight sequence
  // Pause + hide the provincial outlook via its own public hook (defined
  // in story-provincial-forecast.js) — its internal logic is untouched,
  // this just calls the same teardown it already runs on panel-close.
  window.ncopProvincialForecast?.hide();
  const card = _ensureCard(root);
  card.style.display = "";
  const chaptersEl = root.querySelector("#storyChapters");
  if (chaptersEl) chaptersEl.style.display = "none";
  _loadAndPlay(card);
}

function _hide() {
  _state.runToken += 1; // stop any in-flight async scene choreography
  _pause();
  _closePopup();
  _clearDistrictOverlay();
  const map = window.ncop_map;
  // Both chapters now keep their layer on-but-paused between scenes (see
  // _playTemporalLoop) rather than fading it out mid-story — so closing
  // early (still on a layer or station scene) must explicitly tear it
  // down here, not just rely on the chapter's own closing scene.
  if (map) { disableCinematicAtmosphere(map); disableRainEffect(map); _deactivateTemporalLayer(map, _state.activeLayerKey); }
  const root = document.getElementById(ROOT_ID);
  const card = root?.querySelector(`#${CARD_ID}`);
  if (card) card.style.display = "none";
  const chaptersEl = root?.querySelector("#storyChapters");
  if (chaptersEl) chaptersEl.style.display = "grid";
  window.ncopProvincialForecast?.restore();
}

function _teardown() {
  _state.runToken += 1;
  _pause();
  _closePopup();
  _removePopup();
  _clearDistrictOverlay();
  const map = window.ncop_map;
  if (map) { disableCinematicAtmosphere(map); disableRainEffect(map); _deactivateTemporalLayer(map, _state.activeLayerKey); }
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
      // underneath it.
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
