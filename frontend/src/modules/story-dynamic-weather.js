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
// CHAPTER 2 — Temperature Outlook:
//   1. Past-24-hour scene: 2m Temperature layer fades in while narration
//      covers the past day's highs/lows (Heatwave Monitoring's temp_max/
//      temp_min, Open-Meteo-derived server-side, cross-checked against
//      historical Max Temp Records where a station has one on file).
//   2. Current-conditions tour: flies to the hottest currently-reporting
//      Heatwave Monitoring stations (one per province, filled to >=5),
//      opens a popup styled after the app's real heatwave marker popup
//      (alert badge + "now" readout) with the actual `.heatwave-open-
//      stats` button — if the app's own delegated click handler for that
//      button has already been installed this session, it opens the real
//      stats modal; if not, the click is a harmless no-op.
//   3. Closing national temperature assessment.
// Deferred: a direct scrape of weather.gov.pk's FAWS station page and a
// PMD Weather Stations cross-check — Heatwave Monitoring's own Open-
// Meteo backing already covers "fall back to a free source" without a
// second integration.
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

import { getNwfcObservations, getNwfcMaxTemperatures, getFfdWaterlevels, getFfdRivers, getFfdHistoryAll } from "./gcop-api-cache.js";
import { handleTemporalInteraction } from "./mapbox-functions.js";
import { showHeatwaveModalForCity, hideHeatwaveModal, buildFfdPopupContent, setupFfdPopupEventHandlers } from "./layer-attribute-popup.js";
import { showFfdModalForStation, hideFfdModal } from "./ffd-stats-modal.js";
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
  flyAlongPath,
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
// CHAPTER 2 — Temperature Outlook. Data source is Heatwave Monitoring
// (NCOP's own /get-heatwave-monitoring/ endpoint, same-origin fetch —
// see _fetchHeatwaveMonitoring) plus Max Temp Records (GCOP-backed, see
// _fetchMaxTempRecords) for past-24h historical context — NOT the live
// NWFC observations feed Chapter 1 uses. Each Heatwave Monitoring
// feature already carries its own province and alert_level, so unlike
// Chapter 1's rainfall report no separate province lookup is needed.
const TEMP_ITEM_KEY = "pmd_pred_temp2m";
// TOGGLE item (same pattern as OBS_ITEM_KEY in Chapter 1) — displayed
// alongside/on top of the temperature raster during the station tour.
const HEATWAVE_ITEM_KEY = "heatwave_monitoring";

// CHAPTER 3 — Forecasted Precipitation Outlook. Two independent halves:
// (a) Meteoblue's own weekly precipitation layer (the REAL layer, shown
// visually via the normal single-active-temporal mechanism this time —
// see METEOBLUE_WEEKLY_ITEM_KEY), turned off again once the FFD tour
// begins; its district-level mm figures come from the cached step-sample
// pass (_sampleMeteoblueAllSteps/_fetchPrecipSamples), independent of
// whatever the visual layer happens to be showing at any moment — and
// (b) a north-to-south cinematic tour of FFD barrages/dams (TOGGLE item,
// same activation pattern as HEATWAVE_ITEM_KEY) using their live inflow/
// outflow readings plus a best-effort discharge history (see
// _fetchFfdHistory).
const FFD_ITEM_KEY = "ffd_data";
// Below this, a district's forecast reads as a trace amount, not worth a
// dedicated camera flyover — see _buildChapter3Scenes.
const PRECIP_DISTRICT_ZOOM_THRESHOLD_MM = 5;

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
  ttsEnabled:  false, // muted by default — operator opts IN to narration via the mute button
  runToken:    0,        // bumped on every _hide()/_teardown() so an in-flight
                         // async sequence recognises it's stale and stops.
  sceneSeq:    0,        // bumped on every _gotoScene() call, incl. prev/next
                         // while already playing — prevents two navigations'
                         // camera work from running concurrently.
  scenes:      [],
  index:       0,
  baseDataLoadedOnce: false, // true once _loadAndPlay's upfront Promise.all (report/observations/news/heatwave/maxTemp/ffdStations/ffdRivers) has resolved at least once THIS SESSION — later _show() calls (re-selecting the story, or it auto-restarting) reuse the already-cached _state.report/etc. below instead of re-fetching everything; only the new Refresh button (_handleRefreshClick) resets this to force a real re-fetch
  report:      null,     // parsed rainfall report ({ total_mm, provinces, ... })
  observations: null,    // live NWFC FeatureCollection
  newsArticles: [],       // recent GDELT articles for the opening scene's context section
  popupEl:     null,
  tickTimer:   null,     // advance timer — TTS completion poll, or the fixed 20s dwell
  progRaf:     null,     // rAF handle for the progress-bar animation
  discussedDistricts: [], // top rainfall districts (>=5, all provinces) chapter 1 is covering
  heatwaveStations: null, // Heatwave Monitoring FeatureCollection — chapter 2's primary station source
  maxTempRecords: [],     // historical on-record max temperatures, best-effort (see _fetchMaxTempRecords)
  hottestStations: [],   // top temperature stations (>=5, all provinces) chapter 2 is covering
  ffdStations: null,       // live FFD waterlevels FeatureCollection — chapter 3's barrage-tour source
  ffdRivers: null,         // FFD catchment-polygon FeatureCollection (NOT river channels — see _curvedStationPath) — kept only for the on-map visual layer, never used for camera pathing
  meteoblueWeekly: null,   // Map<districtName, {name,province,coords,mm,unit,date,series}> — weekly (daily-sum) Meteoblue samples, ALL 8 steps queried once and cached; series[0] ("today") is the 24h total used as the primary precip value
  meteoblueHourly: null,   // Map<districtName, {name,province,coords,series}> — hourly Meteoblue samples, ALL ~11 steps queried once and cached; supporting/peak-hour context only, never the headline number
  meteoblueSampledOnce: false, // true once _sampleMeteoblueAllSteps has run for this story session — never re-samples (never re-hits Meteoblue's tiles) on repeat Chapter 3 entries, per "preserve calls for meteoblue" constraint
  chapter3ScenesBuilt: false,   // guards _buildChapter3Scenes/splice from running again if the operator navigates back to ch3-intro a second time
  meteoblueTemperature: null,  // Map<districtName, {name,province,coords,series}> — weekly (8-day) Meteoblue 2m Temperature samples, ALL 8 steps queried once and cached; series[0] ("today") is the headline forecast value
  meteoblueTempSampledOnce: false, // true once _sampleMeteoblueTemperatureAllSteps has run for this story session — same "never re-hit Meteoblue's tiles twice" rule as meteoblueSampledOnce
  weeklyTempSamples: [],   // districts with the highest sampled 8-day temperature outlook (see _buildTempWeeklySamples)
  chapter2WeeklyScenesBuilt: false, // guards the temp-weekly scene splice from running again if the operator navigates back to ch2-intro a second time
  ffdHistoryAll: null,       // raw getFfdHistoryAll() payload — {days, stations:{NAME:{inflow:[],outflow:[]}}} for all ~31 FFD stations, 30-day 4-6h series
  ffdHistoryAllFetchedOnce: false, // true once _runFfdIntro has KICKED OFF the fetch for this story session — never re-fetches the ~700KB payload on repeat FFD-tour entries
  ffdHistoryAllPromise: null, // the in-flight (or resolved) fetch itself, so _showFfdBarragePopup can await readiness instead of polling
  districtBoundaryCandidates: [], // {name,province,coords}[] for every district polygon in view — see _districtBoundaryCandidates; computed once (whichever of Chapter 2/3 reaches it first) and shared by both
  districtBoundaryCandidatesComputed: false, // guards the one-time district_boundary query above from re-running on repeat ch2-intro/ch3-intro entries
  topPrecipDistricts: [], // districts with the highest sampled 24h-precip forecast (see _fetchPrecipSamples)
  ffdWaypoints: [],        // FFD barrages/dams sorted north-to-south, chapter 3's camera-path tour
  activeLayerKey: RADAR_ITEM_KEY, // whichever temporal item was last successfully activated
  blinkTimer:  null,     // district-boundary blink interval
  blinkPhase:  false,
  ffdBlinkTimer: null,   // FFD station-point blink interval — separate handle from the district one, see _startFfdBlink
  ffdBlinkPhase: false,
  speed:       1,        // playback speed multiplier — 1..5, set via fast-forward/rewind
  direction:   1,        // +1 forward, -1 reverse — which way auto-advance steps
  pendingMinDwellMs: 0,  // set by a layer scene once it knows its own frame count,
                         // read once by _gotoScene's next _scheduleAdvance call so the
                         // scene holds long enough to actually show a full timelapse lap
  lang: "en",            // "en" | "ur" — operator toggle for narrative text + TTS language
};

// Standard dwell when narration is muted. When narration IS on, the
// scene instead waits for the utterance to actually finish (see
// _scheduleAdvance) — that pacing is correct as-is, since it's tied to
// real speech duration. With narration OFF there's nothing to wait for,
// so this is deliberately much shorter than the TTS case — just enough
// to read the caption, not a fixed 20s regardless of content.
const DWELL_MS_NO_TTS = 6000;

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

// ---- Urdu voice selection -----------------------------------------------
// Setting utter.lang alone is NOT enough — the actual voice used is still
// whatever the engine's current DEFAULT voice is unless one is explicitly
// assigned via utter.voice. A default English voice given Arabic-script
// Urdu text silently skips whatever it can't pronounce — in practice that
// means only the embedded Latin numerals in a caption get read aloud and
// the Urdu prose itself goes silent, which is exactly the "just reads
// numbers" symptom. Voices also populate ASYNCHRONOUSLY (getVoices()
// commonly returns [] until the browser's one-time 'voiceschanged' event
// fires, even when a matching voice IS installed) — cached eagerly here so
// a real voice list is already available by the time playback starts.
let _voicesCache = null;
try {
  const _ss = window.speechSynthesis;
  if (_ss) {
    _voicesCache = _ss.getVoices();
    if (!_voicesCache.length) {
      _ss.addEventListener("voiceschanged", () => { _voicesCache = _ss.getVoices(); }, { once: true });
    }
  }
} catch (_) {}

function _pickUrduVoice() {
  const voices = (_voicesCache && _voicesCache.length) ? _voicesCache : (window.speechSynthesis?.getVoices() || []);
  // Exact Urdu locale first, then any Urdu variant, then Arabic as a
  // same-script fallback (Urdu and Arabic share the Arabic script, so an
  // Arabic voice at least attempts to vocalize the characters instead of
  // silently skipping them the way an English voice does).
  return (
    voices.find((v) => /^ur[-_]/i.test(v.lang)) ||
    voices.find((v) => /^ur$/i.test(v.lang)) ||
    voices.find((v) => /^ar/i.test(v.lang)) ||
    null
  );
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
      // Only set explicitly for Urdu — leaving it unset in English mode
      // preserves the exact pre-existing (browser-default) behaviour.
      if (_state.lang === "ur") {
        utter.lang = "ur-PK";
        const voice = _pickUrduVoice();
        if (voice) utter.voice = voice;
      }
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    } catch (_) { resolve(); /* best-effort — TTS is a nicety, never blocks the visuals */ }
  });
}
function _stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch (_) {}
}

// ---- TTS preference prompt ------------------------------------------
// Same localStorage key story-provincial-forecast.js's own TTS prompt
// uses ("ncop-story-tts-pref") — deliberately shared so the operator is
// only ever asked once across BOTH cinematic briefings, not once per
// story. Neither file imports from the other (each stays fully
// independent per this app's existing story-isolation convention); the
// key is just a plain string both happen to agree on.
const TTS_PREF_KEY = "ncop-story-tts-pref";
function _loadTtsPref() {
  try { return localStorage.getItem(TTS_PREF_KEY); } catch (_) { return null; }
}
function _saveTtsPref(choice) {
  try { localStorage.setItem(TTS_PREF_KEY, choice); } catch (_) {}
}

// ==========================================================================
// English <-> Urdu narrative translation
// --------------------------------------------------------------------------
// Scope is deliberately narrow: only scene.caption (the narrated prose) is
// ever translated — fact pills ("Wind", "Feels", "RH", table headers, etc.)
// stay English in both modes. scene.caption is a plain precomputed string
// (composed once by the ~19 _xNarrative() functions when scenes are
// built) — _tr() below only swaps WHICH string gets read at each display/
// TTS site, never touches how it's composed.
// ==========================================================================
// Same key story-provincial-forecast.js's own toggle uses — shared by
// convention (see TTS_PREF_KEY's comment above for why that's safe even
// though neither file imports the other).
const LANG_PREF_KEY = "ncop-story-lang-pref";
function _loadLangPref() {
  try { return localStorage.getItem(LANG_PREF_KEY) === "ur" ? "ur" : "en"; } catch (_) { return "en"; }
}
function _saveLangPref(lang) {
  try { localStorage.setItem(LANG_PREF_KEY, lang); } catch (_) {}
}

// English -> Urdu translations, keyed by the ORIGINAL English caption.
// Content-addressed, so it's never cleared on refresh — a recurring
// caption (e.g. the same phrasing pattern across two districts never
// collides since captions are per-district/per-station specific, but a
// literal repeat just reuses its cached translation for free).
let _translationCache = new Map();

// Read-time helper — the ONLY thing every scene.caption display/TTS site
// wraps around the raw read. No-ops in English mode; in Urdu mode returns
// the cached translation or silently falls back to English on a cache miss
// so the story can never break.
function _tr(text) {
  if (_state.lang !== "ur") return text;
  return _translationCache.get(text) ?? text;
}

// Shared caption markup for the map-popup builders (_showStationPopup and
// friends, below) — wraps the (possibly-translated) caption in its own
// block so the RTL/Urdu-font class applies ONLY to the narrative text,
// never to the popup's title/badges/tables (those stay English + LTR
// regardless of _state.lang, per the "static UI chrome" scope rule).
function _captionHtml(caption) {
  const cls = _state.lang === "ur" ? "dwrp-caption dwr-lang-ur" : "dwrp-caption";
  return `<div class="${cls}">${_highlightNumbers(_escapeHtml(_tr(caption) || ""))}</div>`;
}

// Every distinct caption across all CURRENTLY built scenes, deduplicated.
function _collectNarrativeStrings() {
  const set = new Set();
  (_state.scenes || []).forEach((s) => { if (s.caption) set.add(s.caption); });
  return Array.from(set);
}

// The backend (translate.py) internally splits a large batch into several
// smaller SEQUENTIAL Groq calls itself, staying under a safe per-call
// character budget — protects against Groq's tokens-per-minute rate limit,
// which a single big/parallel-chunked request from here previously tripped
// in production (a real 413 "Request too large ... TPM"). So this just
// sends everything in ONE request and lets the server handle safe batching
// — no client-side chunking, no parallel fan-out.
const TRANSLATE_ENDPOINT = "/api/translate/";
async function _translateBatch(texts) {
  const res = await fetch(TRANSLATE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ texts, target_lang: "ur" }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data.translations) || data.translations.length !== texts.length) {
    throw new Error(data?.error || `translate HTTP ${res.status}`);
  }
  return data.translations;
}

// Fills in any cache misses for the CURRENTLY built scenes in one shot.
// De-duped against in-flight calls. Never throws — resolves `false` on
// failure and leaves the cache as-is, so _tr()'s fallback keeps showing
// English for whatever never got translated.
let _translateInFlight = null;
function _ensureUrduTranslations(card) {
  if (_translateInFlight) return _translateInFlight;
  const all = _collectNarrativeStrings();
  const missing = all.filter((t) => !_translationCache.has(t));
  if (!missing.length) return Promise.resolve(true);
  _setLangButtonLoading(card, true);
  _translateInFlight = _translateBatch(missing)
    .then((translated) => {
      missing.forEach((orig, i) => _translationCache.set(orig, translated[i]));
      return true;
    })
    .catch((e) => {
      console.warn("[story] Urdu translation failed:", e);
      return false;
    })
    .finally(() => {
      _setLangButtonLoading(card, false);
      _translateInFlight = null;
    });
  return _translateInFlight;
}

// Re-renders the current scene with whatever's now cached, and — if
// narration is on — re-speaks it too. Without this, a translation landing
// in the background (see _ensureUrduTranslations' fire-and-forget call
// sites below) would silently swap the on-screen TEXT to Urdu while the
// voice that already read this scene stays whatever it said in English —
// or say nothing at all if narration was toggled on mid-wait. Shared by
// every background-upgrade call site so a scene's text and its narration
// always agree once a translation actually lands.
function _reapplyCurrentSceneLanguage(card) {
  _renderScene(card);
  const scene = _state.scenes[_state.index];
  if (scene) _speak(_tr(scene.caption) || "");
}

// Fire-and-forget helper for scene-splice sites (Chapter 2/3's late-built
// scenes) — if the operator is already in Urdu mode when new scenes get
// spliced in, their captions weren't part of the original toggle-time
// batch. Re-checks for cache misses and, if any land, re-applies to the
// CURRENTLY shown scene so a caption that happens to be visible right now
// updates in place. Never awaited by the splice sites — translation
// latency must never stall scene entry/auto-advance.
function _queueTranslateNewCaptions(card) {
  if (_state.lang !== "ur" || !card) return;
  _ensureUrduTranslations(card).then((ok) => {
    if (ok && _state.lang === "ur") _reapplyCurrentSceneLanguage(card);
  }).catch(() => {});
}

// Shown once, before the very first scene of a fresh load, ONLY when no
// preference has been saved yet (by either story). Resolves "on"/"off";
// never blocks playback indefinitely — a missing/unclickable body just
// resolves to "off" and moves on.
function _showTtsPrompt(card) {
  return new Promise((resolve) => {
    const bodyEl = card.querySelector(".dwr-body");
    if (!bodyEl) { resolve("off"); return; }
    bodyEl.innerHTML = `
      <div class="dwr-tts-prompt" role="dialog" aria-labelledby="dwr-tts-prompt-title">
        <div class="dwr-tts-prompt-icon" aria-hidden="true">🔊</div>
        <div id="dwr-tts-prompt-title" class="dwr-tts-prompt-title">Enable Voice Narration?</div>
        <div class="dwr-tts-prompt-desc">
          Have each scene's briefing read aloud as it plays.
          You can toggle it anytime from the speaker button on the transport bar.
        </div>
        <div class="dwr-tts-prompt-buttons">
          <button type="button" class="dwr-tts-prompt-btn is-primary" data-choice="on">
            <span aria-hidden="true">🔊</span>&nbsp;Enable narration
          </button>
          <button type="button" class="dwr-tts-prompt-btn" data-choice="off">
            <span aria-hidden="true">🔇</span>&nbsp;Silent mode
          </button>
        </div>
        <div class="dwr-tts-prompt-hint">Your choice is remembered for next time.</div>
      </div>
    `;
    const onClick = (e) => {
      const btn = e.target.closest("[data-choice]");
      if (!btn) return;
      bodyEl.removeEventListener("click", onClick);
      resolve(btn.dataset.choice === "on" ? "on" : "off");
    };
    bodyEl.addEventListener("click", onClick);
  });
}

// Same single-click-resolves pattern _showTtsPrompt uses just above,
// asking English vs Urdu instead. Unlike the TTS decision above (this
// story always starts muted regardless of any saved preference — see the
// "no exceptions" comment where _state.ttsEnabled is force-set in
// _loadAndPlay), language is shown every time a genuine fetch happens
// (first-ever open, or after Refresh — gated by _loadAndPlay's own
// `!useCached` check, since a plain reopen never re-fetches at all) so the
// operator is asked "before the story starts" whenever there's genuinely
// new data, and the choice holds until the next manual refresh. Pre-
// highlights whichever language was picked last time (defaulting to
// English) so confirming the same choice again is still one click.
function _showLangPrompt(card) {
  return new Promise((resolve) => {
    const bodyEl = card.querySelector(".dwr-body");
    if (!bodyEl) { resolve("en"); return; }
    const lastChoice = _loadLangPref();
    bodyEl.innerHTML = `
      <div class="dwr-tts-prompt" role="dialog" aria-labelledby="dwr-lang-prompt-title">
        <div class="dwr-tts-prompt-icon" aria-hidden="true">🌐</div>
        <div id="dwr-lang-prompt-title" class="dwr-tts-prompt-title">Choose a Language</div>
        <div class="dwr-tts-prompt-desc">
          Pick the language for this report's narrative text and voice narration.
          You can switch anytime from the language button in the header.
        </div>
        <div class="dwr-tts-prompt-buttons">
          <button type="button" class="dwr-tts-prompt-btn${lastChoice === "en" ? " is-primary" : ""}" data-choice="en">English</button>
          <button type="button" class="dwr-tts-prompt-btn${lastChoice === "ur" ? " is-primary" : ""}" data-choice="ur">اردو</button>
        </div>
        <div class="dwr-tts-prompt-hint">Your choice holds until you refresh the data.</div>
      </div>
    `;
    const onClick = (e) => {
      const btn = e.target.closest("[data-choice]");
      if (!btn) return;
      bodyEl.removeEventListener("click", onClick);
      resolve(btn.dataset.choice === "ur" ? "ur" : "en");
    };
    bodyEl.addEventListener("click", onClick);
  });
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
    #${CARD_ID} .dwr-refresh,
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
    #${CARD_ID} .dwr-refresh:hover { background: rgba(70, 178, 255, 0.25); color: #fff; }
    #${CARD_ID} .dwr-refresh:disabled { cursor: default; opacity: 0.6; }
    #${CARD_ID} .dwr-refresh.is-spinning svg { animation: dwr-refresh-spin 0.9s linear infinite; }
    @keyframes dwr-refresh-spin { to { transform: rotate(360deg); } }
    #${CARD_ID} .dwr-lang {
      appearance: none; border: 1px solid rgba(255, 255, 255, 0.12); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 3px 9px;
      font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em; line-height: 1;
      color: rgba(234, 234, 234, 0.80);
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${CARD_ID} .dwr-lang:hover { background: rgba(70, 178, 255, 0.22); color: #fff; }
    #${CARD_ID} .dwr-lang.is-active { background: rgba(70, 178, 255, 0.30); color: #fff; border-color: rgba(70, 178, 255, 0.5); }
    #${CARD_ID} .dwr-lang.is-loading { opacity: 0.55; pointer-events: none; }

    /* ---- Urdu narrative text (RTL + legible script font) ------------ */
    .dwr-lang-ur {
      direction: rtl;
      text-align: right;
      font-family: "Noto Nastaliq Urdu", "Segoe UI", Tahoma, "Noto Naskh Arabic", sans-serif;
      font-size: 1.05em;
      line-height: 1.9;
    }

    #${CARD_ID} .dwr-tts-prompt {
      display: grid; gap: 10px;
      padding: 16px 14px 14px;
      background: linear-gradient(180deg, rgba(70, 178, 255, 0.12), rgba(70, 178, 255, 0.04));
      border: 1px solid rgba(70, 178, 255, 0.35);
      border-radius: 10px;
      text-align: center;
      animation: dwr-tts-prompt-in 260ms ease-out;
    }
    @keyframes dwr-tts-prompt-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #${CARD_ID} .dwr-tts-prompt-icon {
      font-size: 28px; line-height: 1;
      filter: drop-shadow(0 2px 6px rgba(70, 178, 255, 0.35));
      margin: 4px auto 0;
    }
    #${CARD_ID} .dwr-tts-prompt-title {
      font-size: 13px; font-weight: 800; letter-spacing: 0.02em;
      color: #fff;
      text-transform: uppercase;
    }
    #${CARD_ID} .dwr-tts-prompt-desc {
      font-size: 11.5px; line-height: 1.5;
      color: rgba(234, 234, 234, 0.80);
      padding: 0 4px;
    }
    #${CARD_ID} .dwr-tts-prompt-buttons {
      display: grid; gap: 6px;
      margin-top: 4px;
    }
    #${CARD_ID} .dwr-tts-prompt-btn {
      appearance: none; border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.06);
      color: #eaeaea;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.02em;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
    }
    #${CARD_ID} .dwr-tts-prompt-btn:hover {
      background: rgba(255, 255, 255, 0.10);
      transform: translateY(-1px);
    }
    #${CARD_ID} .dwr-tts-prompt-btn.is-primary {
      background: var(--ndma-blue, #46b2ff); color: #fff;
      border-color: rgba(255, 255, 255, 0.30);
      box-shadow: 0 4px 12px rgba(70, 178, 255, 0.35);
    }
    #${CARD_ID} .dwr-tts-prompt-btn.is-primary:hover {
      background: #5cbdff;
    }
    #${CARD_ID} .dwr-tts-prompt-hint {
      font-size: 10px; font-style: italic;
      color: rgba(234, 234, 234, 0.50);
      margin-top: 2px;
    }

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

    #${CARD_ID} .dwr-progress-row {
      display: flex; align-items: center; gap: 8px;
      margin-top: 10px;
    }
    #${CARD_ID} .dwr-progress-row .dwr-progress-track { flex: 1 1 auto; margin-top: 0; }
    #${CARD_ID} .dwr-progress-timer {
      flex: 0 0 auto;
      min-width: 38px; text-align: right;
      font-size: 10px; font-variant-numeric: tabular-nums;
      color: rgba(234, 234, 234, 0.55);
    }
    #${CARD_ID} .dwr-progress-track {
      height: 3px;
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
    #${POPUP_ID} .dwrp-badge--normal   { background: rgba(34, 197, 94, 0.20);  color: #86efac; }
    #${POPUP_ID} .dwrp-badge--elevated { background: rgba(234, 179, 8, 0.20);  color: #fde047; }
    #${POPUP_ID} .dwrp-badge--high     { background: rgba(249, 115, 22, 0.22); color: #fdba74; }
    #${POPUP_ID} .dwrp-badge--severe   { background: rgba(220, 38, 38, 0.22);  color: #fca5a5; }
    #${POPUP_ID} .dwrp-badge--extreme  { background: rgba(147, 51, 234, 0.25); color: #d8b4fe; }
    #${POPUP_ID} .dwrp-heatwave-now {
      display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px;
      margin-bottom: 8px;
    }
    #${POPUP_ID} .dwrp-heatwave-now-value {
      font-size: 24px; font-weight: 800; color: #fff; line-height: 1;
    }
    #${POPUP_ID} .dwrp-heatwave-now-sub {
      font-size: 10.5px; color: rgba(234, 234, 234, 0.6);
    }
    #${POPUP_ID} .heatwave-open-stats {
      appearance: none; cursor: pointer;
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 10.5px; font-weight: 700;
      padding: 6px 12px;
      background: rgba(70, 178, 255, 0.18);
      border: 1px solid rgba(70, 178, 255, 0.35);
      border-radius: 999px;
      color: #eaeaea;
      transition: background 0.15s ease;
    }
    #${POPUP_ID} .heatwave-open-stats:hover { background: rgba(70, 178, 255, 0.32); color: #fff; }
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
    #${POPUP_ID} .dwrp-news-list {
      padding: 0 12px 10px;
      display: flex; flex-direction: column; gap: 6px;
    }
    #${POPUP_ID} .dwrp-news-item {
      display: flex; flex-direction: column; gap: 1px;
      padding: 6px 8px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.04);
      text-decoration: none;
      transition: background 0.15s ease;
    }
    #${POPUP_ID} .dwrp-news-item:hover { background: rgba(70, 178, 255, 0.15); }
    #${POPUP_ID} .dwrp-news-title {
      font-size: 11px; font-weight: 600; line-height: 1.35;
      color: #eaeaea;
    }
    #${POPUP_ID} .dwrp-news-meta {
      font-size: 9.5px; color: rgba(234, 234, 234, 0.5);
      text-transform: uppercase; letter-spacing: 0.02em;
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
    #${POPUP_ID} .dwrp-routing-map-img {
      width: 100%;
      height: auto;
      display: block;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      margin-bottom: 8px;
    }

    /* FFD "30-Day History & 14-Day Outlook" — chart/stats/legend for
       ffd-history-forecast.js's rendered output. Colors match that
       module's _CHART_COLORS (dark-mode data-viz categorical slots
       1/2/3 — blue/orange/aqua), kept as literal hex here so the two
       stay in lockstep without importing CSS across module boundaries. */
    #${POPUP_ID} .dwr-ffd-stats-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
    #${POPUP_ID} .dwr-ffd-stat-pill {
      font-size: 10px; font-weight: 600;
      padding: 3px 8px; border-radius: 999px;
      background: rgba(255, 255, 255, 0.06);
      color: rgba(234, 234, 234, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.10);
    }
    #${POPUP_ID} .dwr-ffd-stat-pill--rising  { color: #fdba74; border-color: rgba(217, 89, 38, 0.45); background: rgba(217, 89, 38, 0.14); }
    #${POPUP_ID} .dwr-ffd-stat-pill--falling { color: #7fdfec; border-color: rgba(25, 158, 112, 0.45); background: rgba(25, 158, 112, 0.14); }
    #${POPUP_ID} .dwr-ffd-chart-svg { width: 100%; height: auto; display: block; margin: 4px 0 2px; }
    #${POPUP_ID} .dwr-ffd-legend { display: flex; flex-wrap: wrap; gap: 10px; margin: 2px 0 8px; }
    #${POPUP_ID} .dwr-ffd-legend-item {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 9.5px; color: rgba(234, 234, 234, 0.65);
    }
    #${POPUP_ID} .dwr-ffd-legend-swatch {
      width: 12px; height: 0; display: inline-block;
      border-top: 2px solid currentColor;
    }
    #${POPUP_ID} .dwr-ffd-legend-swatch--dashed { border-top-style: dashed; }

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
const ICON_REFRESH = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;

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
        <button type="button" class="dwr-refresh" aria-label="Refresh data" title="Refresh all data (re-fetches every layer/API) and restart from Chapter 1">${ICON_REFRESH}</button>
        <button type="button" class="dwr-mute is-muted" aria-label="Unmute narration" title="Unmute narration">${ICON_TTS_OFF}</button>
        <button type="button" class="dwr-lang" aria-label="Switch to Urdu" title="Switch narration to Urdu">اردو</button>
        <button type="button" class="dwr-close" aria-label="Close Dynamic Weather Report" title="Close and return to 7-Day Outlook">✕</button>
      </div>
    </div>
    <div class="dwr-chapter-head">
      <div class="dwr-chapter-title">—</div>
      <div class="dwr-chapter-counter"></div>
    </div>
    <div class="dwr-body" role="region" aria-live="polite"></div>
    <div class="dwr-progress-row">
      <div class="dwr-progress-track"><div class="dwr-progress-fill"></div></div>
      <span class="dwr-progress-timer">0.0s</span>
    </div>
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
  _state.lang = _loadLangPref();
  _bindCardEvents(card);
  _syncLangButton(card);
  return card;
}

// Syncs the mute button's icon/class/labels to the CURRENT _state.ttsEnabled
// — used both by its own click handler (below) and right after the TTS
// prompt resolves in _loadAndPlay, since the button's markup is otherwise
// static at card-creation time and would silently mismatch a preference
// that wasn't "off" (the default in that static markup).
function _syncMuteButton(card) {
  const m = card?.querySelector(".dwr-mute");
  if (!m) return;
  m.classList.toggle("is-muted", !_state.ttsEnabled);
  m.innerHTML = _state.ttsEnabled ? ICON_TTS_ON : ICON_TTS_OFF;
  const label = _state.ttsEnabled ? "Mute narration" : "Unmute narration";
  m.setAttribute("aria-label", label);
  m.setAttribute("title", label);
}

// Syncs the header language-toggle button's label/state to the CURRENT
// _state.lang — same on/off pairing pattern _syncMuteButton uses above.
// Shows "اردو" (call-to-action to switch TO Urdu) while in English, "EN"
// (switch back) while in Urdu.
function _syncLangButton(card) {
  const b = card?.querySelector(".dwr-lang");
  if (!b) return;
  const isUr = _state.lang === "ur";
  b.textContent = isUr ? "EN" : "اردو";
  const label = isUr ? "Switch narration to English" : "Switch narration to Urdu";
  b.setAttribute("aria-label", label);
  b.setAttribute("title", label);
  b.classList.toggle("is-active", isUr);
}

// Brief loading state on the language button while a translate request is
// in flight — same visual pattern .dwr-refresh.is-spinning already uses.
function _setLangButtonLoading(card, isLoading) {
  const b = card?.querySelector(".dwr-lang");
  if (!b) return;
  b.classList.toggle("is-loading", isLoading);
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
    _syncMuteButton(card);
  });
  btn(".dwr-lang").addEventListener("click", () => {
    const next = _state.lang === "ur" ? "en" : "ur";
    _state.lang = next;
    _saveLangPref(next);
    _syncLangButton(card);
    // Re-render (and, if narration is on, re-speak) the current scene
    // immediately so the switch is visible/audible right away, with
    // whatever's already cached (falls back to English via _tr()'s
    // cache-miss no-op). A currently open map popup keeps its already-
    // rendered text until the NEXT scene navigation — popups are rebuilt
    // fresh on every scene entry by the _run*() functions, and some of
    // those (e.g. _showFfdBarragePopup) carry real side effects (auto-
    // opening the FFD stats modal, kicking off fetches), so they're
    // deliberately not re-invoked here just to swap displayed text.
    _reapplyCurrentSceneLanguage(card);
    if (next === "ur") {
      // NOT awaited — translating a full report's worth of captions on
      // this CPU-only model can take well over a minute (a real 15-item
      // batch measured at ~105s). Blocking here would freeze the current
      // scene with only the button's own loading spinner as feedback.
      // Fire-and-forget instead, silently upgrading (text AND narration)
      // once ready.
      _ensureUrduTranslations(card).then((ok) => {
        if (ok && _state.lang === "ur") _reapplyCurrentSceneLanguage(card);
      }).catch(() => {});
    }
  });
  btn(".dwr-refresh").addEventListener("click", () => _handleRefreshClick(card));
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

// Recent news/context for the opening scene — reuses NCOP's own existing
// GDELT endpoint (project/ncop_internal/views.py: GdeltNewsEventsApi,
// already consumed elsewhere by navigation-panel.js's news ticker with
// the same `include_social_media=false` pattern) rather than a new
// backend route. A short client-side timeout and a broad try/catch make
// this purely additive — the briefing plays exactly the same with zero
// articles if GDELT is slow/unavailable, it just skips the news section.
//
// Module-level cache (survives across story open/close within the same
// page load, not just within one _loadAndPlay call) — the backend's own
// cache is bucketed in 10-minute windows, so re-fetching sooner than that
// can only ever return the same data anyway. Reopening the story, hitting
// Prev back to scene 1, etc. all reuse this instead of hitting the
// network again. The empty/error result gets cached too, for the same
// TTL — GDELT being rate-limited shouldn't mean every reopen retries it.
let _newsCache = { articles: null, fetchedAt: 0 };
const NEWS_CACHE_TTL_MS = 10 * 60 * 1000;

async function _fetchGdeltNews() {
  const now = Date.now();
  if (_newsCache.articles !== null && (now - _newsCache.fetchedAt) < NEWS_CACHE_TTL_MS) {
    return _newsCache.articles;
  }
  let articles = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch("/get-gdelt-news-events/?include_social_media=false&days=2&max_records=10", {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const geojson = await res.json();
      if (!geojson?.metadata?.error) {
        articles = (geojson.features || [])
          .map((f) => f.properties || {})
          .filter((p) => p.title && p.url)
          .sort((a, b) => new Date(b.seendate || 0) - new Date(a.seendate || 0))
          .slice(0, 4);
      }
    }
  } catch (_) {
    // best-effort — the briefing works fine with zero articles; falls
    // through to caching the empty result below rather than retrying
    // immediately on the next call.
  }
  _newsCache = { articles, fetchedAt: now };
  return articles;
}

// Chapter 2's primary station data source — NCOP's own Heatwave
// Monitoring endpoint (same-origin, NOT a GCOP endpoint — it's wired
// directly as a Mapbox GeoJSON source URL elsewhere in the app, so this
// is a plain fetch() mirroring that, not fetchGcopCached). Backed by
// Open-Meteo server-side, so its temp_max/temp_min fields already are
// the "use open-meteo or any free source" fallback the operational brief
// asked for — no separate direct Open-Meteo integration needed. Best-
// effort: returns null on any failure, never throws.
async function _fetchHeatwaveMonitoring() {
  try {
    const res = await fetch("/get-heatwave-monitoring/");
    if (!res.ok) return null;
    const geojson = await res.json();
    return geojson && Array.isArray(geojson.features) ? geojson : null;
  } catch (_) {
    return null;
  }
}

// Historical record-maximum temperatures per station (GCOP-backed, 24h
// cache — same helper weather-report-control.js's "Max Temp Records"
// drill view already uses). The upstream schema isn't guaranteed, so
// this probes the same envelope/column aliases that view's own defensive
// extraction does, and degrades to an empty list rather than throwing on
// anything unexpected.
async function _fetchMaxTempRecords() {
  try {
    const raw = await getNwfcMaxTemperatures();
    return _extractMaxTempRows(raw);
  } catch (_) {
    return [];
  }
}
function _extractMaxTempRows(raw) {
  if (!raw) return [];
  let arr = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "object") {
    for (const key of ["items", "data", "stations", "records", "results", "max_temperatures", "max_temps", "list", "rows"]) {
      if (Array.isArray(raw[key])) { arr = raw[key]; break; }
    }
  }
  if (!arr) return [];
  const nameKeys = ["name", "station", "station_name", "city", "location", "site"];
  const tempKeys = ["max_temp_c", "temperature", "max_temperature", "max_temp", "maxTemp", "max", "record_max", "record_temp", "record", "value", "temp", "tmax"];
  const dateKeys = ["date", "recorded_on", "record_date", "when", "at", "observed_on"];
  const rows = [];
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const name = nameKeys.map((k) => row[k]).find((v) => v != null);
    const tempRaw = tempKeys.map((k) => row[k]).find((v) => v != null);
    const temp = Number(tempRaw);
    if (!name || !Number.isFinite(temp)) continue;
    const date = dateKeys.map((k) => row[k]).find((v) => v != null) || null;
    rows.push({ name: String(name), temp, date: date != null ? String(date) : null });
  }
  return rows.sort((a, b) => b.temp - a.temp);
}

// Chapter 3's FFD tour source — live inflow/outflow per barrage/dam
// (same GCOP-backed feed the ffd_data map layer itself uses). Best-
// effort: returns null on any failure, never throws.
async function _fetchFfdStations() {
  try {
    const fc = await getFfdWaterlevels();
    return fc && Array.isArray(fc.features) ? fc : null;
  } catch (_) {
    return null;
  }
}

// Bulk 30-day discharge history for every FFD station (see getFfdHistoryAll
// — a different host than the rest of the FFD/GCOP feeds, ~700KB). Feeds
// the barrage popup's "30-Day History & 14-Day Outlook" chart/stats/
// description (see ffd-history-forecast.js). Best-effort: resolves null on
// any failure, same as every other FFD/precip fetch in this file — a
// missing history payload just means that section of the popup shows "not
// available", never breaks playback.
async function _fetchFfdHistoryAll() {
  try {
    const data = await getFfdHistoryAll(30);
    return data && typeof data.stations === "object" ? data : null;
  } catch (_) {
    return null;
  }
}

// Meteoblue's weekly/hourly precipitation layers are published as plain,
// already-resolved arrays on window[layerKey] — see map-layers.js
// ("window.weekly_precipitation_2m_above_ground = nems_layers_weeklycloudprecip",
// "window.hourly_precipitation_2m_above_ground = mbx_hourly_cloudprecip")
// built by generateMeteoblueNEMSCloudPrecipLayers/generateMBX_MeteoblueHourlyCloudPrecipLayers
// (time-functions.js). Each entry already carries its own {source, layers,
// date} — a fixed vector-tile source + a "precip" source-layer fill layer
// whose features expose the numeric reading via `minValue`. Reading these
// arrays directly means Chapter 3 never has to go through
// handleTemporalInteraction()/#temp-slider1 at all: no sidebar
// "is-selected" flash, no legend swap, no hijacking the app's single
// shared "active temporal layer" slot — genuinely just fetching tiles and
// querying them, never "turning the layer on" in the UI sense.
const METEOBLUE_LAYER_KEYS = ["weekly_precipitation_2m_above_ground", "hourly_precipitation_2m_above_ground"];
// The weekly layer is also Chapter 3's VISUAL centerpiece (see
// _runChapter3Intro/_runPrecipLayer/_runPrecipAssessment) — activated for
// real, through the normal single-active-temporal mechanism, unlike the
// values-only pass above which never touches it. Same string as
// METEOBLUE_LAYER_KEYS[0], kept as its own named constant since it's used
// for a genuinely different purpose (display, not step-sampling).
const METEOBLUE_WEEKLY_ITEM_KEY = METEOBLUE_LAYER_KEYS[0];
function _meteoblueEntries(layerKey) {
  const raw = window[layerKey];
  return Array.isArray(raw) ? raw : [];
}

// Adds EVERY step of BOTH Meteoblue precipitation layers to the map as
// its own source + a single invisible ("fill-opacity": 0, kept
// layout-visible only so queryRenderedFeatures can see it) "precip" fill
// layer, waits for their vector tiles to load, samples every candidate
// district against all of them in one queryRenderedFeatures pass, then
// removes everything it added. This is the "iterate through all steps and
// store values in cache" approach — no layer is ever toggled/shown, no
// step is ever the app's "current" step, and nothing is left behind
// afterwards. Called at most ONCE per story session (see
// _state.meteoblueSampledOnce in _runChapter3Intro) so a re-entry into
// Chapter 3 never re-hits Meteoblue's tile API a second time.
async function _sampleMeteoblueAllSteps(map, candidates) {
  const weekly = new Map();
  const hourly = new Map();
  if (!map || !candidates.length) return { weekly, hourly };

  const jobs = [];
  for (const layerKey of METEOBLUE_LAYER_KEYS) {
    for (const entry of _meteoblueEntries(layerKey)) {
      const precipDef = (entry.layers || []).find((l) => l["source-layer"] === "precip");
      if (!precipDef || !entry.source) continue;
      jobs.push({ layerKey, date: entry.date, source: entry.source, layerId: precipDef.id, layerDef: precipDef });
    }
  }
  if (!jobs.length) return { weekly, hourly };

  const addedLayerIds = [];
  const addedSourceIds = [];
  for (const j of jobs) {
    try {
      if (!map.getSource(j.source.id)) {
        map.addSource(j.source.id, j.source);
        addedSourceIds.push(j.source.id);
      }
    } catch (_) { continue; }
    try {
      if (!map.getLayer(j.layerId)) {
        map.addLayer({ ...j.layerDef, layout: { ...j.layerDef.layout, visibility: "visible" }, paint: { ...j.layerDef.paint, "fill-opacity": 0 } });
        addedLayerIds.push(j.layerId);
      } else {
        map.setLayoutProperty(j.layerId, "visibility", "visible");
      }
    } catch (_) {}
  }

  const sourceIds = [...new Set(jobs.map((j) => j.source.id))];
  for (let i = 0; i < 60; i++) {
    const allLoaded = sourceIds.every((sid) => { try { return map.isSourceLoaded(sid); } catch (_) { return true; } });
    if (allLoaded) break;
    await wait(200);
  }

  const allLayerIds = jobs.map((j) => j.layerId);
  const jobByLayerId = new Map(jobs.map((j) => [j.layerId, j]));
  // These layers render CONTOUR BANDS — each polygon's `minValue` is the
  // lower bound of a range (e.g. one polygon for "1-2mm", the next for
  // "2-3mm"), so a single point exactly at a district's gauge coordinate
  // can land in a low band even when heavier rain is forecast a few km
  // away within the same district. Query a small bounding box around the
  // district (~20km radius) instead of one pixel, so the district's
  // WORST forecast band in its own vicinity is what gets picked up, not
  // whatever happens to sit under the exact gauge pin.
  const DISTRICT_SAMPLE_RADIUS_DEG = 0.18;
  for (const c of candidates) {
    let box, feats;
    try {
      const [lng, lat] = c.coords;
      const p1 = map.project([lng - DISTRICT_SAMPLE_RADIUS_DEG, lat + DISTRICT_SAMPLE_RADIUS_DEG]);
      const p2 = map.project([lng + DISTRICT_SAMPLE_RADIUS_DEG, lat - DISTRICT_SAMPLE_RADIUS_DEG]);
      box = [[Math.min(p1.x, p2.x), Math.min(p1.y, p2.y)], [Math.max(p1.x, p2.x), Math.max(p1.y, p2.y)]];
    } catch (_) { continue; }
    try { feats = map.queryRenderedFeatures(box, { layers: allLayerIds }); } catch (_) { continue; }
    const bestByLayer = new Map();
    for (const f of feats || []) {
      const lid = f.layer?.id;
      const v = Number(f?.properties?.minValue);
      if (!lid || !Number.isFinite(v)) continue;
      if (!bestByLayer.has(lid) || v > bestByLayer.get(lid)) bestByLayer.set(lid, v);
    }
    for (const [lid, mm] of bestByLayer) {
      const job = jobByLayerId.get(lid);
      if (!job) continue;
      const target = job.layerKey === "weekly_precipitation_2m_above_ground" ? weekly : hourly;
      if (!target.has(c.name)) target.set(c.name, { name: c.name, province: c.province, coords: c.coords, series: [] });
      target.get(c.name).series.push({ date: job.date, mm });
    }
  }

  for (const id of addedLayerIds) { if (map.getLayer(id)) { try { map.removeLayer(id); } catch (_) {} } }
  for (const sid of addedSourceIds) { if (map.getSource(sid)) { try { map.removeSource(sid); } catch (_) {} } }

  return { weekly, hourly };
}

// Chapter 2's weekly-temperature-outlook counterpart to
// _sampleMeteoblueAllSteps above — same standalone add-source/add-layer/
// query/remove pass (never touches handleTemporalInteraction/#temp-
// slider1, nothing is left on the map afterwards), just pointed at
// window.temperature_2m_above_ground instead of the precipitation layers.
// That array is built by generateMBX_MeteoblueHourlyTemperatureLayers
// (time-functions.js) — despite the function's name it's structurally
// identical to the weekly precipitation array: 8 entries (today..+7d),
// each a vector-tile source + a "temperatureColortable" fill layer whose
// features carry the reading on `minValue`. A separate function (not a
// parameter added to _sampleMeteoblueAllSteps) so Chapter 3's existing,
// already-working precipitation sampling is never touched.
async function _sampleMeteoblueTemperatureAllSteps(map, candidates) {
  const temperature = new Map();
  if (!map || !candidates.length) return temperature;

  const jobs = [];
  for (const entry of _meteoblueEntries("temperature_2m_above_ground")) {
    const tempDef = (entry.layers || []).find((l) => l["source-layer"] === "temperatureColortable");
    if (!tempDef || !entry.source) continue;
    jobs.push({ date: entry.date, source: entry.source, layerId: tempDef.id, layerDef: tempDef });
  }
  if (!jobs.length) return temperature;

  const addedLayerIds = [];
  const addedSourceIds = [];
  for (const j of jobs) {
    try {
      if (!map.getSource(j.source.id)) {
        map.addSource(j.source.id, j.source);
        addedSourceIds.push(j.source.id);
      }
    } catch (_) { continue; }
    try {
      if (!map.getLayer(j.layerId)) {
        map.addLayer({ ...j.layerDef, layout: { ...j.layerDef.layout, visibility: "visible" }, paint: { ...j.layerDef.paint, "fill-opacity": 0 } });
        addedLayerIds.push(j.layerId);
      } else {
        map.setLayoutProperty(j.layerId, "visibility", "visible");
      }
    } catch (_) {}
  }

  const sourceIds = [...new Set(jobs.map((j) => j.source.id))];
  for (let i = 0; i < 60; i++) {
    const allLoaded = sourceIds.every((sid) => { try { return map.isSourceLoaded(sid); } catch (_) { return true; } });
    if (allLoaded) break;
    await wait(200);
  }

  const allLayerIds = jobs.map((j) => j.layerId);
  const jobByLayerId = new Map(jobs.map((j) => [j.layerId, j]));
  // Same "query a small bounding box, not one pixel" reasoning as
  // precipitation sampling — these are contour bands, and a district's
  // own peak heat can sit a few km from its exact station coordinate.
  const DISTRICT_SAMPLE_RADIUS_DEG = 0.18;
  for (const c of candidates) {
    let box, feats;
    try {
      const [lng, lat] = c.coords;
      const p1 = map.project([lng - DISTRICT_SAMPLE_RADIUS_DEG, lat + DISTRICT_SAMPLE_RADIUS_DEG]);
      const p2 = map.project([lng + DISTRICT_SAMPLE_RADIUS_DEG, lat - DISTRICT_SAMPLE_RADIUS_DEG]);
      box = [[Math.min(p1.x, p2.x), Math.min(p1.y, p2.y)], [Math.max(p1.x, p2.x), Math.max(p1.y, p2.y)]];
    } catch (_) { continue; }
    try { feats = map.queryRenderedFeatures(box, { layers: allLayerIds }); } catch (_) { continue; }
    const bestByLayer = new Map();
    for (const f of feats || []) {
      const lid = f.layer?.id;
      const v = Number(f?.properties?.minValue);
      if (!lid || !Number.isFinite(v)) continue;
      if (!bestByLayer.has(lid) || v > bestByLayer.get(lid)) bestByLayer.set(lid, v);
    }
    for (const [lid, tempC] of bestByLayer) {
      const job = jobByLayerId.get(lid);
      if (!job) continue;
      if (!temperature.has(c.name)) temperature.set(c.name, { name: c.name, province: c.province, coords: c.coords, series: [] });
      temperature.get(c.name).series.push({ date: job.date, tempC });
    }
  }

  for (const id of addedLayerIds) { if (map.getLayer(id)) { try { map.removeLayer(id); } catch (_) {} } }
  for (const sid of addedSourceIds) { if (map.getSource(sid)) { try { map.removeSource(sid); } catch (_) {} } }

  return temperature;
}

// Builds Chapter 2's weekly-outlook list from the cached sampling pass
// above — same shape/ranking convention as _fetchPrecipSamples: sorted
// desc by the headline ("today") value, a district with no sample is
// simply omitted rather than guessed.
function _buildTempWeeklySamples(candidates, temperatureMap) {
  const results = candidates.map((c) => {
    const t = temperatureMap?.get(c.name);
    if (!t || !t.series?.length) return null;
    const today = t.series[0];
    return {
      name: c.name,
      province: c.province,
      coords: c.coords,
      tempC: today.tempC,
      date: today.date,
      source: "Meteoblue weekly (2m Temperature)",
      weeklySeries: t.series,
    };
  });
  return results.filter(Boolean).sort((a, b) => b.tempC - a.tempC);
}

// Nationally-representative candidate district list for precipitation
// sampling — up to 3 per province (reusing _districtsGroupedByProvince
// purely as a geographic candidate pool; its own mm_total-based ordering
// doesn't matter here since districts get RE-ranked by sampled FORECAST
// value elsewhere). Coordinates come from the same live-station matching
// Chapter 1 already relies on (_matchLiveStation) — a district only
// becomes a candidate if it resolves to a real coordinate, same "never
// guess a location" rule the rest of this file follows. Shared by both
// the Meteoblue step-sampling pass (_sampleMeteoblueAllSteps) and
// _fetchPrecipSamples below, so the two always agree on which districts
// are in play.
function _precipCandidateDistricts(report, liveFeatures) {
  const byProvince = _districtsGroupedByProvince(report);
  const candidates = [];
  for (const [province, districts] of byProvince) {
    for (const d of (districts || []).slice(0, 3)) {
      const allStations = (report?.provinces?.[province]?.stations || [])
        .filter((s) => s.name.split(" - ")[0] === d.name);
      const live = allStations.map((s) => _matchLiveStation(s.name, liveFeatures)).find(Boolean);
      if (live?.geometry?.coordinates) {
        candidates.push({ name: d.name, province, coords: live.geometry.coordinates });
      }
    }
  }
  return candidates;
}

// Property keys carrying a DISTRICT feature's own province name — mirrors
// weather-report-control.js's DISTRICT_PROVINCE_PROP_KEYS (same GeoServer
// source, gcop:district_boundary, already empirically fought through by
// that module's own history — see its "34 PROVINCES for 34 districts"
// comment). Duplicated as a small local constant rather than imported,
// same "each file keeps its own small piece of schema knowledge" pattern
// DIST_NAME_KEYS above already follows.
const DISTRICT_PROVINCE_KEYS = ["province", "province_name", "provincename", "PROVINCE", "PROVINCE_NAME", "admin1", "ADM1_EN", "prov_name"];

// Representative point for a rendered district polygon feature — reuses
// the existing _centroid(coords) averager (unchanged), just adds the
// geometry-type unwrapping it needs. MultiPolygon districts (a handful of
// districts have offshore/split parts) use the ring with the most
// vertices as a cheap "biggest part" stand-in, so the sample point lands
// on the district's main landmass rather than a small enclave.
function _featureCentroid(feature) {
  const geom = feature?.geometry;
  if (!geom) return null;
  let ring;
  if (geom.type === "Polygon") {
    ring = geom.coordinates?.[0];
  } else if (geom.type === "MultiPolygon") {
    const best = (geom.coordinates || []).reduce(
      (acc, poly) => ((poly?.[0]?.length || 0) > (acc?.[0]?.length || 0) ? poly : acc),
      null
    );
    ring = best?.[0];
  }
  return ring?.length ? _centroid(ring) : null;
}

// A far broader per-district candidate list than _precipCandidateDistricts
// above (which is capped at ~3 districts per province THAT REPORTED
// RAINFALL, and only when a live station coordinate happens to resolve —
// on a quiet day this can end up as just one or two districts). This one
// queries the district_boundary vector tiles DIRECTLY for every district
// polygon currently rendered at the national view Chapter 2/3's camera
// already sits at when this runs, giving genuinely national coverage
// (all ~163 districts, not a handful) with each district's own real
// centroid instead of a live-station proxy point.
//
// Same "temporarily add an invisible source+layer, query, remove"
// technique _sampleMeteoblueAllSteps already uses for the Meteoblue layers
// themselves — nothing is ever shown on the map or flips a sidebar toggle
// on; the map looks identical before and after this runs. Best-effort:
// returns [] (never throws) if the layer config can't be resolved or its
// tiles don't load in time, so callers can fall back to
// _precipCandidateDistricts exactly as before.
async function _districtBoundaryCandidates(map) {
  const found = typeof window.sourceLayerControl?.findLayerConfig === "function"
    ? window.sourceLayerControl.findLayerConfig("district_boundary")
    : null;
  const config = found?.config;
  const source = config?.source;
  const fillLayerDef = (config?.layers || []).find((l) => l.type === "fill") || (config?.layers || [])[0];
  if (!source?.id || !fillLayerDef) return [];

  let addedSource = false, addedLayer = false;
  try {
    if (!map.getSource(source.id)) { map.addSource(source.id, source); addedSource = true; }
    if (!map.getLayer(fillLayerDef.id)) {
      map.addLayer({ ...fillLayerDef, layout: { ...fillLayerDef.layout, visibility: "visible" }, paint: { ...fillLayerDef.paint, "fill-opacity": 0 } });
      addedLayer = true;
    } else {
      map.setLayoutProperty(fillLayerDef.id, "visibility", "visible");
    }
  } catch (_) {
    return [];
  }

  for (let i = 0; i < 40; i++) {
    let loaded = true;
    try { loaded = map.isSourceLoaded(source.id); } catch (_) { /* treat as loaded, don't hang the pass */ }
    if (loaded) break;
    await wait(150);
  }

  const candidates = [];
  try {
    const features = map.queryRenderedFeatures({ layers: [fillLayerDef.id] });
    const seen = new Set();
    for (const f of features) {
      const name = DIST_NAME_KEYS.map((k) => f.properties?.[k]).find((v) => v != null);
      if (!name || seen.has(name)) continue;
      const coords = _featureCentroid(f);
      if (!coords) continue;
      const province = DISTRICT_PROVINCE_KEYS.map((k) => f.properties?.[k]).find((v) => v != null) || "";
      seen.add(name);
      candidates.push({ name: String(name), province: String(province || ""), coords });
    }
  } catch (_) { /* best-effort */ }

  if (addedLayer && map.getLayer(fillLayerDef.id)) { try { map.removeLayer(fillLayerDef.id); } catch (_) {} }
  if (addedSource && map.getSource(source.id)) { try { map.removeSource(source.id); } catch (_) {} }

  return candidates;
}

// Precipitation VALUES for Chapter 3 come exclusively from the cached
// Meteoblue samples (_state.meteoblueWeekly/_state.meteoblueHourly,
// populated once by _sampleMeteoblueAllSteps during _runChapter3Intro) —
// independent of the separately-activated VISUAL Meteoblue weekly layer
// (METEOBLUE_WEEKLY_ITEM_KEY, see _runPrecipLayer), which can be stepped/
// toggled/torn down without affecting these already-cached numbers. The
// weekly layer's "today" step is a proper 24h daily-sum forecast, so it's
// the headline mm figure; the hourly layer (next ~10-11 hours, per-hour
// readings) supplies the peak-hour context alongside it. A district with
// no weekly sample is simply omitted.
// `candidatesOverride`, when given, replaces the report-driven candidate
// list above with a broader one (see _districtBoundaryCandidates) — an
// OPTIONAL 3rd param so every existing caller that doesn't pass it (there
// are none left after _runChapter3Intro's own update below, but the
// fallback keeps this function correct on its own terms) gets the exact
// original report-driven behavior, unchanged.
async function _fetchPrecipSamples(report, liveFeatures, candidatesOverride) {
  const candidates = candidatesOverride?.length ? candidatesOverride : _precipCandidateDistricts(report, liveFeatures);
  if (!candidates.length) return [];

  const weekly = _state.meteoblueWeekly;
  const hourly = _state.meteoblueHourly;
  const results = candidates.map((c) => {
    const w = weekly?.get(c.name);
    if (!w || !w.series?.length) return null;
    const today = w.series[0];
    const h = hourly?.get(c.name);
    let peakHour = null;
    if (h?.series?.length) {
      peakHour = h.series.reduce((best, s) => (best === null || s.mm > best.mm ? s : best), null);
    }
    return {
      name: c.name,
      province: c.province,
      coords: c.coords,
      mm: today.mm,
      unit: "mm",
      date: today.date,
      source: "Meteoblue weekly (NEMS)",
      weeklySeries: w.series,
      hourlySeries: h?.series || [],
      peakHour,
    };
  });
  return results.filter(Boolean).sort((a, b) => b.mm - a.mm);
}

// FFD stations ordered by REAL hydrological connectivity, not geometry.
// /get-ffd-rivers/ was curled and inspected directly — it returns 27
// catchment/basin POLYGONS (one per station, colored by status, up to
// ~2.3° across), not river-channel LineStrings, so there is no line to
// trace a tour along. /get-ffd-waterlevels/, however, publishes exactly
// the connectivity a tour actually needs: each station's `from` (its
// upstream source station name(s)) and `area_name` (river system). This
// is a multi-source topological walk over that `from` graph — a station
// only becomes eligible once every upstream source still in the dataset
// has already been placed, so confluences (e.g. Guddu, fed by both
// Taunsa and Panjnad) are visited only after both of their sources, and
// a real chain like Besham → Tarbela Dam → Chashma → Taunsa → Guddu
// falls out in that exact order because each one's `from` names the
// last. Station names in `from` are matched whitespace/case-insensitive
// (_normStationName) — the raw feed itself is inconsistent about this
// ("Besham " vs "Besham", "Kalabagh" vs "Kala Bagh"), which would
// otherwise silently break the graph. Stations that become eligible in
// the same pass are grouped by river system then north-to-south, so a
// tributary's own stations stay together instead of interleaving with an
// unrelated river; any station with missing/unresolvable upstream data
// just falls back into that same north-to-south ordering rather than
// blocking the walk.
function _normStationName(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, "");
}
function _buildFfdWaypoints(ffdFC) {
  const feats = (ffdFC?.features || []).filter((f) => f?.geometry?.coordinates);
  const byName = new Map();
  for (const f of feats) {
    const name = f.properties?.name || "Station";
    byName.set(name, {
      name,
      province: f.properties?.province || "",
      area: (f.properties?.area_name && f.properties.area_name !== "N/A") ? f.properties.area_name : "",
      center: f.geometry.coordinates,
      properties: f.properties || {},
      from: Array.isArray(f.properties?.from) ? f.properties.from.map(_normStationName) : [],
    });
  }

  const remaining = new Map(byName);
  const remainingNorm = new Set([...byName.keys()].map(_normStationName));
  const ordered = [];
  const maxPasses = remaining.size + 1;
  for (let pass = 0; pass < maxPasses && remaining.size; pass++) {
    let ready = [...remaining.values()].filter((wp) => wp.from.every((up) => !remainingNorm.has(up)));
    if (!ready.length) ready = [...remaining.values()]; // cycle/unresolved refs — flush rather than loop forever
    ready.sort((a, b) => (a.area || "").localeCompare(b.area || "") || b.center[1] - a.center[1]);
    for (const wp of ready) {
      ordered.push(wp);
      remaining.delete(wp.name);
      remainingNorm.delete(_normStationName(wp.name));
    }
  }
  return ordered;
}

// /get-ffd-rivers/ has no channel geometry to follow (see above), so the
// travel leg between two consecutive barrages is a gently bowed arc
// rather than a ruler-straight line — it reads as a followed corridor
// instead of a straight teleport, without pretending to trace a real
// river course the data doesn't provide. The bow is a gentle perpendicular
// offset scaled to the leg's own length (short hops bow only slightly,
// long hops are capped so it never looks like a detour) — one consistent
// side rather than alternating, since there's no data to know which way
// any given reach actually bends. Densely sampled (`samples` points) so
// flyAlongPath's distance-paced camera turns gradually along the curve
// instead of pivoting hard at just two endpoints.
function _curvedStationPath(from, to, samples = 24, bowFrac = 0.12) {
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;
  const dx = lng2 - lng1;
  const dy = lat2 - lat1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1e-6) return [from, to];
  const px = -dy / dist;
  const py = dx / dist;
  const bow = Math.min(dist * bowFrac, 0.6); // capped in degrees (~65km at this latitude)
  const midLng = (lng1 + lng2) / 2 + px * bow;
  const midLat = (lat1 + lat2) / 2 + py * bow;
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const omt = 1 - t;
    pts.push([
      omt * omt * lng1 + 2 * omt * t * midLng + t * t * lng2,
      omt * omt * lat1 + 2 * omt * t * midLat + t * t * lat2,
    ]);
  }
  return pts;
}

// Cheap path length in degrees — used only to scale flyAlongPath's
// duration so a longer leg covers its (longer) real distance at roughly
// the same visual pace as a shorter one, not faster.
function _pathLengthDeg(coords) {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const dx = coords[i + 1][0] - coords[i][0];
    const dy = coords[i + 1][1] - coords[i][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

// Nearest sampled precip district to a barrage — simple planar distance
// (fine at this scale, same approximation _featureCenter-style helpers
// elsewhere in the app already use), for the "would forecast
// precipitation affect this barrage's inflow" cross-reference. Returns
// null if there are no precip samples at all or none within a loose
// catchment radius (~2.5° ≈ 275 km — generous, since a barrage's real
// catchment can span a wide upstream area, not just its own pin).
function _nearestPrecipSample(waypoint, precipSamples) {
  if (!precipSamples?.length) return null;
  let best = null, bestD = Infinity;
  for (const p of precipSamples) {
    const dx = p.coords[0] - waypoint.center[0];
    const dy = p.coords[1] - waypoint.center[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestD) { bestD = d; best = p; }
  }
  return bestD <= 2.5 ? best : null;
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

// Same province-diverse-first ordering as _topDistrictsAcrossProvinces,
// but with NO cap — every district the PDF reported a measurable (non-
// trace) reading for gets included, so the station tour actually visits
// every station in the source report, not just a top-5 summary. The
// narrative/popup text still uses the capped top-5 version above for
// readability; this uncapped list drives the CAMERA TOUR only. Districts
// where every station is trace-only are still surfaced — just narratively
// (report.trace_stations), not with an individual flyover, since there's
// no numeric reading to rank or report at that location.
function _allWetDistrictsAcrossProvinces(report) {
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

// Same join, without repeating the province tag on every item — used for
// province-scoped lists (the province-overview scene) where the province
// is already the subject of the sentence.
function _joinDistrictNames(list) {
  const parts = list.map((d) => `${d.name} (${d.mm_total} mm)`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Every wet district, grouped by province (each array sorted desc by
// mm_total, since it's filtered straight out of the already-sorted
// _districtRankingFromDay). Drives the per-province tour structure: top
// 2 districts get an individual zoom-in scene each, the rest are folded
// into that province's closing overview scene instead of also getting a
// full flyover — applied uniformly to every reporting province.
function _districtsGroupedByProvince(report) {
  const byProvince = new Map();
  for (const d of _districtRankingFromDay(report).filter((x) => x.mm_total > 0)) {
    if (!byProvince.has(d.province)) byProvince.set(d.province, []);
    byProvince.get(d.province).push(d);
  }
  return byProvince;
}

// Closes out a province's district tour — the "zoom out to show the
// whole province" beat. Names the top districts just toured, then
// narrates whatever additional stations reported beyond those two
// (never invents a number for them — every mm value here already came
// through _districtRankingFromDay the same as the top 2 did).
function _provinceOverviewNarrative(province, top2, rest) {
  const bits = [];
  if (top2.length) {
    bits.push(`That covers ${province}'s leading districts — ${_joinDistrictNames(top2)}.`);
  }
  if (rest.length) {
    bits.push(`Elsewhere across the province, ${_joinDistrictNames(rest)} also reported measurable rainfall.`);
  } else if (top2.length) {
    bits.push(`No other district in ${province} reported measurable rainfall beyond these.`);
  }
  return bits.join(" ");
}

// ==========================================================================
// CHAPTER 2 data — Heatwave Monitoring stations (_fetchHeatwaveMonitoring,
// NCOP's own endpoint), NOT the live NWFC observations feed Chapter 1
// uses. Each feature already carries its own province and an alert_level
// ("Normal"|"Elevated"|"High"|"Severe"|"Extreme"), so no separate
// province lookup is needed here the way Chapter 1's rainfall report
// required one. Cross-referenced against Max Temp Records
// (_fetchMaxTempRecords) for "past 24 hours" historical context in the
// opening scene. Deferred (out of scope for this pass): a direct scrape
// of weather.gov.pk's FAWS station page and a PMD Weather Stations
// cross-check — Heatwave Monitoring's temp_max/temp_min already come
// from Open-Meteo server-side, which covers the "use a free open source
// if nothing else is available" requirement without a second integration.
// ==========================================================================

// Same province-diversity rule Chapter 1 uses for districts — one
// hottest station per province first, then filled to >=5 overall with
// the next-highest readings, so the CURRENT-conditions tour represents
// the whole country rather than whichever province happened to run hottest.
function _hottestHeatwaveStations(heatwaveFC) {
  const withTemp = (heatwaveFC?.features || [])
    .filter((f) => Number.isFinite(f.properties?.temperature))
    .map((f) => ({
      feature: f,
      temp: f.properties.temperature,
      province: f.properties.province || null,
      alert: f.properties.alert_level || "Normal",
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
  return "Chapter 2: the Temperature Outlook, built from PMD's Heatwave Monitoring network and historical Max Temperature Records, cross-checked against the PMD 2-metre temperature prediction layer.";
}

// Opening scene — PAST 24 HOURS, not current conditions. Prefers each
// station's own temp_max/temp_min (already Open-Meteo-derived server-
// side), backed with a historical on-record maximum where Max Temp
// Records has a match for that station name.
function _pastDayNarrative(heatwaveFC, maxTempRecords) {
  const feats = (heatwaveFC?.features || [])
    .filter((f) => Number.isFinite(f.properties?.temp_max))
    .map((f) => ({ name: f.properties.name, province: f.properties.province, tempMax: f.properties.temp_max, tempMin: f.properties.temp_min }))
    .sort((a, b) => b.tempMax - a.tempMax);

  // Heatwave Monitoring's backing source (Open-Meteo) rate-limits under
  // load (HTTP 429) — when that leaves NO usable temp_max readings, fall
  // back to Max Temp Records (a fully separate, non-Open-Meteo GCOP feed
  // — the same "Max Temp Records" drill view weather-report-control.js
  // exposes — already fetched unconditionally alongside heatwaveFC
  // either way) so the opening scene still has real past-temperature
  // context instead of an empty placeholder.
  if (!feats.length) {
    const records = (maxTempRecords || []).slice(0, 5);
    if (!records.length) {
      return "Past-24-hour temperature context is not currently available from any connected source.";
    }
    const lead = records[0];
    const bits = [
      `Live Open-Meteo readings are temporarily unavailable, so this is drawn from PMD's Max Temperature Records instead — the highest on-record reading nationwide was at ${lead.name}, at ${lead.temp}°C${lead.date ? ` (${lead.date})` : ""}.`,
    ];
    const others = records.slice(1, 4);
    if (others.length) bits.push(`Also historically hot: ${others.map((r) => `${r.name} (${r.temp}°C)`).join(", ")}.`);
    return bits.join(" ");
  }
  const lead = feats[0];
  const bits = [
    `Over the past 24 hours, the highest reading nationwide was at ${lead.name}${lead.province ? ` in ${lead.province}` : ""}, reaching ${lead.tempMax}°C${Number.isFinite(lead.tempMin) ? ` (low of ${lead.tempMin}°C)` : ""}.`,
  ];
  const others = feats.slice(1, 4);
  if (others.length) {
    bits.push(`Also running hot: ${others.map((f) => `${f.name} (${f.tempMax}°C)`).join(", ")}.`);
  }
  const record = (maxTempRecords || []).find((r) => _normName(r.name) === _normName(lead.name));
  if (record) {
    bits.push(`For reference, ${lead.name}'s on-record historical maximum is ${record.temp}°C${record.date ? ` (${record.date})` : ""}.`);
  }
  return bits.join(" ");
}

function _tempStationNarrative(entry, hottest) {
  const props = entry.feature.properties || {};
  const rank = hottest.findIndex((x) => x.feature === entry.feature) + 1;
  const bits = [`${props.name} is currently reporting ${entry.temp}°C, alert level ${entry.alert}.`];
  if (Number.isFinite(props.apparent_temperature)) bits.push(`Feels like ${props.apparent_temperature}°C.`);
  if (Number.isFinite(props.humidity)) bits.push(`Relative humidity ${props.humidity}%.`);
  if (Number.isFinite(props.wind_speed) && props.wind_speed > 0) bits.push(`Wind ${props.wind_speed} km/h.`);
  if (entry.province) bits.push(`${entry.province} — ranked ${rank ? `#${rank}` : "unranked"} nationally by current temperature among monitored stations.`);
  return bits.join(" ");
}

function _tempAssessmentNarrative(hottest) {
  const bits = ["National temperature assessment:"];
  bits.push(hottest.length
    ? `current heat centers on ${_joinTempList(hottest.slice(0, 3))}.`
    : "no significant heat signal is present in current station reports.");
  const anyAlert = hottest.find((x) => x.alert && x.alert !== "Normal");
  bits.push(anyAlert
    ? `${anyAlert.feature.properties?.name} is under a ${anyAlert.alert.toLowerCase()} heat alert — continued monitoring is warranted.`
    : "No station is currently under an elevated heat alert.");
  bits.push("Heatwave Monitoring station data, cross-checked against the PMD prediction layer, remains the authoritative record.");
  bits.push("Operational readiness: routine monitoring posture recommended based on current data.");
  return bits.join(" ");
}

function _joinTempWeeklyList(list) {
  const parts = list.map((d) => `${d.name} (${d.tempC}°C, ${d.province})`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// Forward-looking counterpart to _pastDayNarrative/_tempAssessmentNarrative
// — built from _state.weeklyTempSamples (see _sampleMeteoblueTemperatureAllSteps
// / _buildTempWeeklySamples), sampled once per session during
// _runChapter2Intro, same as Chapter 3's precipitation values.
function _tempWeeklyNarrative(weeklyTempSamples) {
  if (!weeklyTempSamples.length) {
    return "The 8-day temperature outlook is not currently returning sampled values for any monitored district — the Heatwave Monitoring and Max Temp Records data above remain the authoritative current and historical record.";
  }
  const lead = weeklyTempSamples[0];
  const bits = [
    `Looking ahead, the Meteoblue 8-day outlook points to the highest sustained temperatures at ${lead.name} in ${lead.province}, forecast to reach ${lead.tempC}°C.`,
  ];
  const others = weeklyTempSamples.slice(1, 4);
  if (others.length) bits.push(`Also trending hot over the coming week: ${_joinTempWeeklyList(others)}.`);
  bits.push("Values are sampled directly from Meteoblue's weekly 2-metre temperature layer, each step carrying its own forecast date, not estimated.");
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
function _introNarrative(newsArticles) {
  const newsNote = (newsArticles && newsArticles.length)
    ? " Recent news context is included alongside this briefing where available."
    : "";
  return `Welcome to the Dynamic Weather Report — a cinematic, data-driven operational briefing built entirely from live PMD and NWFC sources, with no invented figures. This is Chapter 1: the Precipitation Outlook, covering the past 24 hours nationwide. The sequence ahead moves from a national radar sweep, through a guided tour of the heaviest rainfall districts across every province, to a closing operational assessment.${newsNote}`;
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

// ---- CHAPTER 3 narrative generation — Forecasted Precipitation Outlook.
// Every figure here comes from a real sampled value (PmdMonitorPrediction-
// ValueAPIView) or a live FFD reading — same "never invent a number"
// discipline as Chapters 1 and 2. ----------------------------------------
function _chapter3IntroNarrative() {
  return "Chapter 3: the Forecasted Precipitation Outlook, drawing district-level 24-hour precipitation values from Meteoblue's forecast layers, followed by a north-to-south tour of the FFD's monitored barrages and dams and how the outlook may affect their inflows.";
}

function _joinPrecipList(list) {
  const parts = list.map((d) => `${d.name} (${d.mm} ${d.unit}, ${d.province})`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function _precipLayerNarrative(precipSamples) {
  if (!precipSamples.length) {
    return "The 24-hour precipitation forecast is not currently returning sampled values for any monitored district — the layer is shown for visual reference only.";
  }
  const lead = precipSamples[0];
  const bits = [
    `The 24-hour precipitation forecast points to the heaviest activity at ${lead.name} in ${lead.province}, at ${lead.mm} ${lead.unit}.`,
  ];
  const others = precipSamples.slice(1, 4).filter((d) => d.mm > 0);
  if (others.length) bits.push(`Also expected to see rainfall: ${_joinPrecipList(others)}.`);
  const dryCount = precipSamples.filter((d) => d.mm <= 0.1).length;
  if (dryCount) bits.push(`${dryCount} of the ${precipSamples.length} sampled districts show no meaningful forecast precipitation.`);
  return bits.join(" ");
}

function _precipDistrictNarrative(entry, precipSamples) {
  const rank = precipSamples.findIndex((x) => x === entry) + 1;
  const bits = [`${entry.name}, ${entry.province}, is forecast ${entry.mm} ${entry.unit} of precipitation over the next 24 hours.`];
  bits.push(rank ? `Ranked #${rank} nationally among sampled districts.` : "");
  bits.push(entry.mm >= 25
    ? "This crosses the threshold PMD classifies as heavy rainfall — downstream river levels and low-lying areas warrant monitoring."
    : entry.mm > 0
      ? "A moderate accumulation, not expected to be operationally significant on its own."
      : "No meaningful precipitation is forecast at this location for the coming window.");
  return bits.filter(Boolean).join(" ");
}

// Groups the SAME already-sampled precipSamples (no new fetch, no map-
// layer dependency) by province, mirroring weather-report-control.js's
// own Dynamic Report tab presentation (province groups, each with an
// average + its districts) — used for a single national, province-wise
// overview instead of the individual per-district zoom-ins the "precip-
// district" scene kind still does elsewhere. precipSamples is already
// sorted desc by mm nationally (see _fetchPrecipSamples), so each
// province's own district list comes out desc-sorted too, for free.
// Provinces themselves are ranked by average mm, matching the Dynamic
// Report tab's own #provinceAggregate (mean, not max, for precipitation).
function _groupPrecipByProvince(precipSamples) {
  const byProvince = new Map();
  for (const d of precipSamples) {
    if (!byProvince.has(d.province)) byProvince.set(d.province, []);
    byProvince.get(d.province).push(d);
  }
  const groups = Array.from(byProvince.entries()).map(([province, districts]) => ({
    province,
    districts,
    avgMm: districts.reduce((sum, d) => sum + (d.mm || 0), 0) / districts.length,
  }));
  groups.sort((a, b) => b.avgMm - a.avgMm);
  return groups;
}

function _joinProvinceAverages(groups) {
  const parts = groups.map((g) =>
    `${g.province} (avg ${g.avgMm.toFixed(1)} mm across ${g.districts.length} district${g.districts.length === 1 ? "" : "s"})`
  );
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function _precipProvinceOverviewNarrative(groups) {
  if (!groups.length) return "No province currently shows a sampled precipitation forecast above the reporting threshold.";
  const totalDistricts = groups.reduce((n, g) => n + g.districts.length, 0);
  const bits = [
    `Province-wise, the 24-hour precipitation forecast is led by ${_joinProvinceAverages(groups.slice(0, 3))}.`,
    `This national overview covers ${groups.length} province${groups.length === 1 ? "" : "s"} and ${totalDistricts} sampled district${totalDistricts === 1 ? "" : "s"}.`,
  ];
  return bits.join(" ");
}

function _precipAssessmentNarrative(precipSamples) {
  const bits = ["Precipitation outlook assessment:"];
  bits.push(precipSamples.length
    ? `forecast rainfall over the coming hours centers on ${_joinPrecipList(precipSamples.slice(0, 3))}.`
    : "no significant forecast precipitation signal is present in currently sampled districts.");
  const heavy = precipSamples.find((d) => d.mm >= 25);
  bits.push(heavy
    ? `${heavy.name} crosses PMD's heavy-rainfall threshold — the FFD barrage tour that follows checks whether this outlook reaches any monitored catchment.`
    : "No sampled district currently crosses the heavy-rainfall threshold.");
  bits.push("Values are sampled directly from Meteoblue's weekly and hourly precipitation forecasts, not estimated.");
  return bits.join(" ");
}

function _ffdIntroNarrative(ffdWaypoints) {
  if (!ffdWaypoints.length) {
    return "FFD barrage and dam telemetry is not currently available — this tour will resume once the feed returns.";
  }
  return `A river-by-river tour of ${ffdWaypoints.length} FFD-monitored barrages and dams follows — any station currently reporting above-normal flow gets a full flythrough, and each river closes with a wide overview covering every one of its stations, so nothing is missed even where nothing is happening.`;
}

function _ffdBarrageNarrative(waypoint, precipSamples) {
  const props = waypoint.properties || {};
  const outflow = props.outflow_discharge ?? props.discharge ?? "n/a";
  const inflow = props.inflow_discharge ?? "n/a";
  const bits = [`${waypoint.name}${waypoint.province ? `, ${waypoint.province}` : ""}: outflow ${outflow} cusecs, inflow ${inflow} cusecs.`];
  if (props.status) bits.push(`Current status: ${props.status}.`);
  const near = _nearestPrecipSample(waypoint, precipSamples);
  if (near && near.mm > 0) {
    bits.push(`Forecast precipitation nearby at ${near.name} (${near.mm} ${near.unit}) ${near.mm >= 25 ? "may push inflows higher over the coming hours." : "is not expected to significantly affect inflows."}`);
  } else {
    bits.push("No significant forecast precipitation is expected in this barrage's nearby catchment.");
  }
  return bits.join(" ");
}

function _ffdAssessmentNarrative(ffdWaypoints) {
  if (!ffdWaypoints.length) return "FFD tour assessment unavailable — no station telemetry was returned.";
  const bits = ["FFD barrage tour assessment:"];
  const highest = ffdWaypoints.slice().sort((a, b) => {
    const av = Number(a.properties?.outflow_discharge ?? a.properties?.discharge ?? 0);
    const bv = Number(b.properties?.outflow_discharge ?? b.properties?.discharge ?? 0);
    return bv - av;
  })[0];
  if (highest) {
    const v = highest.properties?.outflow_discharge ?? highest.properties?.discharge ?? "n/a";
    bits.push(`${highest.name} currently reports the highest outflow among monitored barrages, at ${v} cusecs.`);
  }
  const alert = ffdWaypoints.find((w) => w.properties?.status && !/normal/i.test(String(w.properties.status)));
  bits.push(alert
    ? `${alert.name} is reporting a "${alert.properties.status}" status — continued monitoring is warranted.`
    : "All monitored barrages currently report normal flow status.");
  bits.push("Readings are live FFD telemetry; the preceding precipitation outlook determines whether inflows are likely to rise.");
  return bits.join(" ");
}

// ---- FFD flood-status classification — same 6-tier scale + colors
// map-layers.js's ffd_data-circle paint expression and its dynamicLegend
// already use (confirmed against the real value strings that expression
// matches: "Normal"/"NORMAL", "Low"/"LOW", "Medium"/"MEDIUM", "High"/
// "HIGH", "Very High"/"VERY_HIGH", "Exceptionally High"/"EX_HIGH").
// Duplicated here as a small local classifier (not imported — map-
// layers.js's version lives inside a Mapbox paint expression, not a
// reusable JS function) so the FFD tour can group stations by the exact
// same tiers the on-map circle colors and legend already show.
const FFD_STATUS_LABELS = {
  normal: "Normal flow",
  low: "Low flood",
  medium: "Medium flood",
  high: "High flood",
  very_high: "Very high flood",
  ex_high: "Exceptionally high flood",
  unknown: "Unknown status",
};
function _ffdStatusKind(status) {
  const s = String(status || "").trim().toLowerCase().replace(/_/g, " ");
  if (!s) return "unknown";
  if (s === "normal") return "normal";
  if (s === "low") return "low";
  if (s === "medium") return "medium";
  if (s === "high") return "high";
  if (s === "very high") return "very_high";
  if (s === "exceptionally high" || s === "ex high") return "ex_high";
  return "unknown";
}
function _ffdIsNormal(status) {
  return _ffdStatusKind(status) === "normal";
}

// Groups FFD waypoints by their real river system (area_name — "Indus
// River", "Jhelum River", "Chenab River", "Ravi River", "Sutlej River",
// "Kabul River") in the same order the flood_routing_map.png reference
// chart lays them out, tributaries first, confluence/mainstem trunk
// (Trimmu → Punjnad → Guddu → Sukkur → Kotri — these carry no area_name
// of their own, see _buildFfdWaypoints's own area:"" handling) last,
// since that's literally downstream of everything else on the chart.
// Membership order within each group is whatever _buildFfdWaypoints
// already topologically resolved — untouched here.
const FFD_RIVER_ORDER = ["Indus River", "Kabul River", "Jhelum River", "Chenab River", "Ravi River", "Sutlej River"];
const FFD_MAINSTEM_LABEL = "Indus Mainstem (Confluence Trunk)";
function _groupFfdByRiver(ffdWaypoints) {
  const buckets = new Map();
  for (const wp of ffdWaypoints) {
    const river = wp.area || FFD_MAINSTEM_LABEL;
    if (!buckets.has(river)) buckets.set(river, []);
    buckets.get(river).push(wp);
  }
  const ordered = new Map();
  for (const river of FFD_RIVER_ORDER) {
    if (buckets.has(river)) { ordered.set(river, buckets.get(river)); buckets.delete(river); }
  }
  const mainstem = buckets.get(FFD_MAINSTEM_LABEL);
  buckets.delete(FFD_MAINSTEM_LABEL);
  for (const [river, members] of buckets) ordered.set(river, members); // any river name not in the fixed list — never silently dropped
  if (mainstem) ordered.set(FFD_MAINSTEM_LABEL, mainstem);
  return ordered;
}

// Picks `n` evenly-spaced items from `arr` (by index) — used to choose a
// handful of REPRESENTATIVE normal-flow stations for a river where
// nothing is currently in alert, so a quiet river still gets a little
// individual camera time rather than none at all.
function _pickEvenly(arr, n) {
  if (n <= 0 || !arr.length) return [];
  if (n >= arr.length) return arr.slice();
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

function _ffdRoutingMapNarrative() {
  return "This is PMD/FFD's own flood-routing network — the real hydrological topology, with revised lag times in hours between every gauge, dam, and confluence point. The tour that follows walks this same network, river by river, from the mountains down to the Arabian Sea.";
}

// Overview narrative for one river group — names every non-normal
// station explicitly (the operationally important part), and either
// lists which representative stations got individual camera time (quiet
// river) or simply confirms full normal-flow coverage.
function _ffdRiverGroupNarrative(river, members, featured, skipped) {
  const alerts = members.filter((wp) => !_ffdIsNormal(wp.properties?.status));
  const bits = [`${river}: ${members.length} monitored station${members.length === 1 ? "" : "s"}.`];
  if (alerts.length) {
    const parts = alerts.map((wp) => `${wp.name} (${FFD_STATUS_LABELS[_ffdStatusKind(wp.properties?.status)]})`);
    bits.push(`${parts.length > 1 ? "Stations" : "Station"} currently reporting above-normal flow: ${parts.join(", ")}.`);
  } else {
    bits.push("Every station on this river currently reports normal flow.");
    if (featured.length && featured.length < members.length) {
      bits.push(`${featured.map((wp) => wp.name).join(", ")} shown individually as representative readings; the remaining ${skipped.length} station${skipped.length === 1 ? "" : "s"} are summarized here.`);
    }
  }
  return bits.join(" ");
}

// ==========================================================================
// Scene construction — a flat, ordered list built once the data loads.
// ==========================================================================
async function _buildScenes(report, observationsFC, newsArticles) {
  const liveFeatures = observationsFC?.features || [];
  const scenes = [
    { kind: "intro", chapter: 1, caption: _introNarrative(newsArticles) },
    { kind: "radar", chapter: 1, caption: _radarNarrative(report) },
  ];

  // Per-province tour: for EVERY province that reported rainfall, zoom
  // into its top 2 districts individually (same multi-gauge grouping as
  // before — a district with several stations, e.g. Islamabad's Golra/
  // Saidpur/Zero Point/Airport, is still ONE scene that zooms to one and
  // narrates the rest), then a single province-overview scene that zooms
  // OUT to the province's whole extent and names whatever additional
  // stations reported beyond those top 2. Applied uniformly to every
  // reporting province, not just the wettest ones. A district is skipped
  // only if NONE of its stations can be matched to a live coordinate —
  // nowhere real to fly the camera — per the existing "never guess"
  // philosophy; _state.discussedDistricts (for the boundary-blink
  // overlay) still covers every wet district regardless, top-2 or not.
  _state.discussedDistricts = _allWetDistrictsAcrossProvinces(report);
  const byProvince = _districtsGroupedByProvince(report);
  const provinceOrder = _provinceRanking(report).map((p) => p.name).filter((name) => byProvince.has(name));
  for (const province of provinceOrder) {
    const districts = byProvince.get(province); // already sorted desc by mm_total
    const top2 = districts.slice(0, 2);
    const rest = districts.slice(2);
    const provinceLiveCoords = [];

    for (const d of top2) {
      const allStations = (report?.provinces?.[d.province]?.stations || [])
        .filter((s) => s.name.split(" - ")[0] === d.name);
      if (!allStations.length) continue;
      const withLive = allStations.map((s) => ({ station: s, live: _matchLiveStation(s.name, liveFeatures) }));
      withLive.forEach((x) => { if (x.live) provinceLiveCoords.push(x.live.geometry.coordinates); });
      if (!withLive.some((x) => x.live)) continue;
      scenes.push({
        kind: "station",
        chapter: 1,
        district: d,
        stations: withLive,
        caption: _districtStationsNarrative(d, withLive, report),
      });
    }

    // The "rest" districts don't get their own flyover, but their live
    // coordinates (where matched) still widen the province-overview
    // shot so it genuinely shows the province's full extent, not just
    // wherever the top 3 happen to sit.
    for (const d of rest) {
      const allStations = (report?.provinces?.[d.province]?.stations || [])
        .filter((s) => s.name.split(" - ")[0] === d.name);
      for (const s of allStations) {
        const live = _matchLiveStation(s.name, liveFeatures);
        if (live) provinceLiveCoords.push(live.geometry.coordinates);
      }
    }

    scenes.push({
      kind: "province-overview",
      chapter: 1,
      province,
      topDistricts: top2,
      remainingDistricts: rest,
      coords: provinceLiveCoords,
      caption: _provinceOverviewNarrative(province, top2, rest),
    });
  }

  scenes.push({ kind: "assessment", chapter: 1, caption: _assessmentNarrative(report) });

  // ---- CHAPTER 2 — Temperature Outlook ------------------------------
  // Heatwave Monitoring stations + Max Temp Records, both already
  // fetched in _loadAndPlay (_state.heatwaveStations / .maxTempRecords)
  // — a fully separate data source from Chapter 1's rainfall report and
  // NWFC observations feed.
  const heatwaveFC = _state.heatwaveStations;
  const maxTempRecords = _state.maxTempRecords;
  const hottest = _hottestHeatwaveStations(heatwaveFC);
  _state.hottestStations = hottest;

  scenes.push({ kind: "ch2-intro", chapter: 2, caption: _chapter2IntroNarrative() });
  // "temp-layer" is the PAST-24-HOUR scene — current conditions are the
  // station tour that follows, not this one.
  scenes.push({ kind: "temp-layer", chapter: 2, caption: _pastDayNarrative(heatwaveFC, maxTempRecords) });
  let addedTemp = 0;
  for (const entry of hottest) {
    if (addedTemp >= 8) break;
    if (!entry.feature?.geometry?.coordinates) continue; // nowhere real to fly the camera
    scenes.push({ kind: "temp-station", chapter: 2, entry, caption: _tempStationNarrative(entry, hottest) });
    addedTemp += 1;
  }
  scenes.push({ kind: "temp-assessment", chapter: 2, caption: _tempAssessmentNarrative(hottest) });

  // ---- CHAPTER 3 — Forecasted Precipitation Outlook ------------------
  // Only the intro stub is built here — unlike Chapters 1/2, Chapter 3's
  // actual content depends on its OWN layers being loaded first (Meteoblue
  // weekly (visual), FFD + rivers, Meteoblue sampled for values), and per
  // the operational brief those only load once Chapter 2 ends, not upfront
  // alongside everything else. _runChapter3Intro does that preload, then
  // calls _buildChapter3Scenes and splices the result in right after this
  // stub — see there for the rest of what used to be built here.
  scenes.push({ kind: "ch3-intro", chapter: 3, caption: _chapter3IntroNarrative() });

  return scenes;
}

// The rest of Chapter 3 — split out of _buildScenes because it can only
// be built AFTER Chapter 3's own layers (Meteoblue weekly, FFD + rivers,
// Meteoblue-for-values) have loaded, which now happens at Chapter 3's
// own start (_runChapter3Intro), not upfront with everything else. Same
// two halves as before: sampled 24h-precipitation values per district
// (_fetchPrecipSamples reads _state.meteoblueWeekly/_state.meteoblueHourly,
// populated by the preload that runs just before this is called) and the live FFD
// barrage/dam tour (_state.ffdStations, fetched much earlier in
// _loadAndPlay — that part never needed the layers, only the tour
// SCENES built from it are deferred here for consistency).
async function _buildChapter3Scenes(report, liveFeatures, candidatesOverride) {
  const scenes = [];
  const precipSamples = await _fetchPrecipSamples(report, liveFeatures, candidatesOverride);
  _state.topPrecipDistricts = precipSamples;

  scenes.push({ kind: "precip-layer", chapter: 3, precipSamples, caption: _precipLayerNarrative(precipSamples) });
  // Province-wise national overview — no individual district zoom-ins for
  // the precipitation forecast (that's still what "precip-district"/
  // _runPrecipDistrict do, just no longer scheduled here). Groups the SAME
  // already-sampled precipSamples by province (_groupPrecipByProvince, no
  // new fetch, no boundary-layer dependency) and shows them all in one
  // broad national shot, mirroring weather-report-control.js's own Dynamic
  // Report tab presentation (province groups + per-district values).
  const precipProvinceGroups = _groupPrecipByProvince(precipSamples.filter((d) => d.mm > 0));
  if (precipProvinceGroups.length) {
    scenes.push({
      kind: "precip-province-overview",
      chapter: 3,
      precipSamples,
      groups: precipProvinceGroups,
      caption: _precipProvinceOverviewNarrative(precipProvinceGroups),
    });
  }
  scenes.push({ kind: "precip-assessment", chapter: 3, precipSamples, caption: _precipAssessmentNarrative(precipSamples) });

  // FFD barrage tour — only built when the live feed actually returned
  // stations; an empty/unavailable feed just skips straight past this
  // (Chapter 3 still has its full precipitation half either way) rather
  // than pushing a tour with nothing to show.
  const ffdWaypoints = _buildFfdWaypoints(_state.ffdStations);
  _state.ffdWaypoints = ffdWaypoints;
  if (ffdWaypoints.length) {
    scenes.push({ kind: "ffd-intro", chapter: 3, caption: _ffdIntroNarrative(ffdWaypoints) });
    scenes.push({ kind: "ffd-routing-map", chapter: 3, caption: _ffdRoutingMapNarrative() });

    // River-by-river, not station-by-station: every station currently
    // reporting anything other than normal flow gets its own full
    // flythrough (unchanged "ffd-barrage" scene — camera path, orbit,
    // popup, GeoGLOWS, stats modal, all exactly as before); a quiet river
    // (every station normal) gets up to 4 REPRESENTATIVE stations
    // individually instead of all of them. Every river closes with one
    // "ffd-river-overview" scene — a single wide shot blinking every
    // station on that river (featured and skipped alike) with a compact
    // table of ALL of their current readings, so nothing is actually
    // hidden, just not given its own dedicated flythrough. flyAlongPath's
    // travel leg (prevWaypoint) is threaded across FEATURED stations
    // only — skipped stations were never a physical stop, so the path
    // between two featured stops is simply longer, not literally
    // retraced through every skipped one.
    const riverGroups = _groupFfdByRiver(ffdWaypoints);
    let prevForPath = null;
    for (const [river, members] of riverGroups) {
      const nonNormal = members.filter((wp) => !_ffdIsNormal(wp.properties?.status));
      const normal = members.filter((wp) => _ffdIsNormal(wp.properties?.status));
      // Every non-normal station is always individually featured, uncapped
      // — those are the operationally important ones and are never
      // skipped. The "top 2" cap for representative normal-flow stations
      // matches the same reduction convention Chapter 1's own province
      // tour already established (top 2 districts, rest folded into an
      // overview) — checked against the real live feed: with a cap of 4
      // most rivers already have <=4 stations, so nothing was actually
      // skipped and the tour barely shrank; 2 gives a real reduction
      // while every station's reading still surfaces in the river
      // overview's table either way.
      const featuredCount = Math.max(nonNormal.length, Math.min(2, members.length));
      const representativeNormal = _pickEvenly(normal, Math.max(0, featuredCount - nonNormal.length));
      const featuredNames = new Set([...nonNormal, ...representativeNormal].map((wp) => wp.name));
      const featured = members.filter((wp) => featuredNames.has(wp.name)); // preserves members' own topological order
      const skipped = members.filter((wp) => !featuredNames.has(wp.name));

      for (const wp of featured) {
        scenes.push({
          kind: "ffd-barrage",
          chapter: 3,
          waypoint: wp,
          prevWaypoint: prevForPath,
          precipSamples,
          caption: _ffdBarrageNarrative(wp, precipSamples),
        });
        prevForPath = wp;
      }

      scenes.push({
        kind: "ffd-river-overview",
        chapter: 3,
        river,
        members,
        featured,
        skipped,
        caption: _ffdRiverGroupNarrative(river, members, featured, skipped),
      });
    }

    scenes.push({ kind: "ffd-assessment", chapter: 3, caption: _ffdAssessmentNarrative(ffdWaypoints) });
  }

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
    case "province-overview": return `${scene.province} — Province Overview`;
    case "assessment":      return "National Rainfall Assessment";
    case "ch2-intro":       return "Chapter 2 — Temperature Outlook";
    case "temp-layer":      return "2m Temperature — Past 24 Hours";
    case "temp-station":    return `Station Focus — ${scene.entry.feature.properties?.name}${scene.entry.province ? ` (${scene.entry.province})` : ""}`;
    case "temp-weekly":     return "8-Day Temperature Outlook";
    case "temp-assessment": return "National Temperature Assessment";
    case "ch3-intro":       return "Chapter 3 — Forecasted Precipitation Outlook";
    case "precip-layer":    return "24h Precipitation Forecast";
    case "precip-district": return `Forecast Focus — ${scene.entry.name} (${scene.entry.province})`;
    case "precip-province-overview": return "Province-Wise Precipitation Overview";
    case "precip-assessment": return "Precipitation Outlook Assessment";
    case "ffd-intro":       return "FFD Barrage & Dam Tour";
    case "ffd-routing-map": return "FFD Flood Routing Map";
    case "ffd-barrage":     return `${scene.waypoint.name}${scene.waypoint.province ? ` (${scene.waypoint.province})` : ""}`;
    case "ffd-river-overview": return `${scene.river} — Overview`;
    case "ffd-assessment":  return "FFD Tour Assessment";
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
  } else if (scene.kind === "province-overview") {
    const pills = (scene.topDistricts || []).map((d) => `${d.name}: ${d.mm_total} mm`);
    factsHtml = pills.length ? `<div class="dwr-facts">${pills.map((p) => `<span class="dwr-fact-pill">${_highlightNumbers(_escapeHtml(p))}</span>`).join("")}</div>` : "";
  } else if (scene.kind === "radar" || scene.kind === "temp-layer" || scene.kind === "precip-layer") {
    factsHtml = `<div class="dwr-facts"><span class="dwr-fact-pill dwr-frame-pill">Frame <span class="dwr-frame-value">—</span></span></div>`;
  } else if (scene.kind === "assessment") {
    const report = _state.report;
    const total = report?.total_mm ?? 0; // 24h focus — the primary figure
    factsHtml = `<div class="dwr-facts"><span class="dwr-fact-pill">${_hlNum(`${total} mm`)} national total (24h)</span></div>`;
  } else if (scene.kind === "temp-station") {
    const props = scene.entry.feature.properties || {};
    const alert = scene.entry.alert || "Normal";
    const pills = [`${scene.entry.temp}°C`];
    if (Number.isFinite(props.apparent_temperature)) pills.push(`Feels ${props.apparent_temperature}°C`);
    if (Number.isFinite(props.humidity)) pills.push(`RH ${props.humidity}%`);
    if (Number.isFinite(props.wind_speed) && props.wind_speed > 0) pills.push(`Wind ${props.wind_speed} km/h`);
    const alertPillClass = alert !== "Normal" ? "dwr-fact-pill is-alert" : "dwr-fact-pill";
    factsHtml = `<div class="dwr-facts"><span class="${alertPillClass}">${_escapeHtml(alert)}</span>${pills.map((p) => `<span class="dwr-fact-pill">${_highlightNumbers(_escapeHtml(p))}</span>`).join("")}</div>`;
  } else if (scene.kind === "temp-weekly") {
    const lead = (scene.weeklyTempSamples || _state.weeklyTempSamples)?.[0];
    factsHtml = lead ? `<div class="dwr-facts"><span class="dwr-fact-pill">${_hlNum(`${lead.tempC}°C`)} 8-day peak</span></div>` : "";
  } else if (scene.kind === "temp-assessment") {
    const lead = _state.hottestStations?.[0];
    factsHtml = lead ? `<div class="dwr-facts"><span class="dwr-fact-pill is-alert">${_hlNum(`${lead.temp}°C`)} peak reading</span></div>` : "";
  } else if (scene.kind === "precip-district") {
    const e = scene.entry;
    const pillClass = e.mm >= 25 ? "dwr-fact-pill is-alert" : "dwr-fact-pill";
    factsHtml = `<div class="dwr-facts"><span class="${pillClass}">${_hlNum(`${e.mm} ${e.unit}`)} forecast (24h)</span></div>`;
  } else if (scene.kind === "precip-province-overview") {
    const pills = (scene.groups || []).slice(0, 3).map((g) => `${g.province}: avg ${g.avgMm.toFixed(1)} mm`);
    factsHtml = pills.length ? `<div class="dwr-facts">${pills.map((p) => `<span class="dwr-fact-pill">${_highlightNumbers(_escapeHtml(p))}</span>`).join("")}</div>` : "";
  } else if (scene.kind === "precip-assessment") {
    const lead = (scene.precipSamples || _state.topPrecipDistricts)?.[0];
    factsHtml = lead ? `<div class="dwr-facts"><span class="dwr-fact-pill${lead.mm >= 25 ? " is-alert" : ""}">${_hlNum(`${lead.mm} ${lead.unit}`)} leading forecast</span></div>` : "";
  } else if (scene.kind === "ffd-barrage") {
    const props = scene.waypoint.properties || {};
    const outflow = props.outflow_discharge ?? props.discharge ?? "n/a";
    const inflow = props.inflow_discharge ?? "n/a";
    factsHtml = `<div class="dwr-facts"><span class="dwr-fact-pill">${_hlNum(`${outflow} cusecs`)} outflow</span><span class="dwr-fact-pill">${_hlNum(`${inflow} cusecs`)} inflow</span></div>`;
  } else if (scene.kind === "ffd-river-overview") {
    const alertCount = (scene.members || []).filter((wp) => !_ffdIsNormal(wp.properties?.status)).length;
    factsHtml = `<div class="dwr-facts"><span class="dwr-fact-pill${alertCount ? " is-alert" : ""}">${scene.members.length} stations</span>${alertCount ? `<span class="dwr-fact-pill is-alert">${alertCount} above normal</span>` : ""}</div>`;
  } else if (scene.kind === "ffd-assessment") {
    const wp = (_state.ffdWaypoints || [])[0];
    factsHtml = wp ? `<div class="dwr-facts"><span class="dwr-fact-pill">${_state.ffdWaypoints.length} barrages monitored</span></div>` : "";
  }
  bodyEl.classList.toggle("dwr-lang-ur", _state.lang === "ur");
  bodyEl.innerHTML = `<div class="dwr-caption">${_highlightNumbers(_escapeHtml(_tr(scene.caption) || ""))}</div>${factsHtml}`;
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
  // Faster interval + a wider swing on both line-width and fill-opacity
  // than before — the pulse needs to read clearly while the camera is
  // busy flying/orbiting into a district, not just on a static frame.
  _state.blinkTimer = setInterval(() => {
    _state.blinkPhase = !_state.blinkPhase;
    const wide = _state.blinkPhase;
    try {
      if (map.getLayer(HL_DIST_LINE_ID)) {
        map.setPaintProperty(HL_DIST_LINE_ID, "line-width", wide ? 6 : 2.5);
        map.setPaintProperty(HL_DIST_LINE_ID, "line-opacity", wide ? 1 : 0.55);
      }
      if (map.getLayer(HL_DIST_FILL_ID)) {
        map.setPaintProperty(HL_DIST_FILL_ID, "fill-opacity", wide ? 0.45 : 0.15);
      }
    } catch (_) { /* best-effort */ }
  }, 420);
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
// FFD station-point highlight/blink overlay — same filter-driven pulse
// technique as the district-boundary blink above, just built on the
// ffd_data-source's own POINT geometry instead of district polygons, and
// with its own separate timer/phase state (_state.ffdBlinkTimer/Phase, not
// the district ones) so the two overlays can never fight over the same
// handle. Used by "ffd-river-overview" scenes to highlight every station
// on a river at once (featured and skipped alike) while its summary
// popup is showing — its own layer id, never touches ffd_data-circle
// itself.
// ==========================================================================
const FFD_HL_SOURCE_ID = "ffd_data-source"; // reuses the EXISTING source — no new source, no extra fetch
const HL_FFD_CIRCLE_ID = "dwr-ffd-highlight-circle";

function _matchFfdNamesExpr(names) {
  const unique = Array.from(new Set((names || []).map((s) => String(s).toLowerCase().trim()))).filter(Boolean);
  if (!unique.length) return ["has", "___ncop_never___"];
  return ["match", ["downcase", ["to-string", ["coalesce", ["get", "name"], ""]]], unique, true, false];
}

function _ensureFfdHighlightLayer() {
  const map = window.ncop_map;
  if (!map || !map.getSource(FFD_HL_SOURCE_ID) || map.getLayer(HL_FFD_CIRCLE_ID)) return;
  try {
    map.addLayer({
      id: HL_FFD_CIRCLE_ID,
      type: "circle",
      source: FFD_HL_SOURCE_ID,
      filter: ["has", "___ncop_never___"],
      paint: {
        "circle-radius": 12,
        "circle-color": "transparent",
        "circle-stroke-color": "#46b2ff",
        "circle-stroke-width": 3,
        "circle-stroke-opacity": 0.9,
      },
    });
  } catch (_) { /* best-effort — ffd_data-source may not be loaded yet */ }
}

function _setFfdHighlight(names) {
  const map = window.ncop_map;
  if (!map) return;
  _ensureFfdHighlightLayer();
  try {
    if (map.getLayer(HL_FFD_CIRCLE_ID)) map.setFilter(HL_FFD_CIRCLE_ID, _matchFfdNamesExpr(names));
  } catch (_) { /* best-effort */ }
}

function _startFfdBlink() {
  _stopFfdBlink();
  const map = window.ncop_map;
  if (!map) return;
  _state.ffdBlinkPhase = false;
  _state.ffdBlinkTimer = setInterval(() => {
    _state.ffdBlinkPhase = !_state.ffdBlinkPhase;
    const wide = _state.ffdBlinkPhase;
    try {
      if (map.getLayer(HL_FFD_CIRCLE_ID)) {
        map.setPaintProperty(HL_FFD_CIRCLE_ID, "circle-radius", wide ? 18 : 11);
        map.setPaintProperty(HL_FFD_CIRCLE_ID, "circle-stroke-opacity", wide ? 1 : 0.4);
      }
    } catch (_) { /* best-effort */ }
  }, 420);
}

function _stopFfdBlink() {
  if (_state.ffdBlinkTimer) { clearInterval(_state.ffdBlinkTimer); _state.ffdBlinkTimer = null; }
}

function _clearFfdHighlight() {
  _stopFfdBlink();
  const map = window.ncop_map;
  if (!map) return;
  try {
    if (map.getLayer(HL_FFD_CIRCLE_ID)) map.setFilter(HL_FFD_CIRCLE_ID, ["has", "___ncop_never___"]);
  } catch (_) { /* best-effort */ }
}

// ==========================================================================
// Camera + layer choreography per scene kind
// ==========================================================================
async function _runIntro(map, token, seq) {
  _showIntroPopup();
  enableCinematicAtmosphere(map);
  map.jumpTo(REGIONAL_START); // only non-animated cut in the whole sequence — the deliberate "opening shot" starting position
  // Chapter 1's own layers (DWD Satellite Infrared, NWFC Station
  // Observations) load alongside the opening flyover rather than staying
  // idle until the radar/station scenes reach them individually —
  // _activateTemporalLayer/_ensureObservationsOn are both idempotent, so
  // those later scenes' own calls just find everything already ready.
  const card = document.getElementById(CARD_ID);
  _setLayerLoadingNote(card, "Loading satellite and station observation layers for Chapter 1…");
  await Promise.all([
    cinematicFlyTo(map, {
      center: PAKISTAN_CENTER,
      zoom: 4.6,
      pitch: 35,
      bearing: 0,
      duration: _dur(4200),
    }),
    _activateTemporalLayer(map, RADAR_ITEM_KEY, "DWD Satellite Infrared", token, seq).catch(() => false),
    _ensureObservationsOn(),
  ]);
  if (_isStale(token, seq)) return;
  _setLayerLoadingNote(card, null);
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
// News rows for the opening popup's "Recent news & context" section —
// GDELT articles fetched alongside the rainfall report in _loadAndPlay
// (see _fetchGdeltNews). Renders nothing if the fetch came back empty
// (slow/unavailable GDELT, or genuinely no recent matching coverage) —
// purely additive, never blocks or alters the rest of the briefing.
function _newsSectionHtml() {
  const articles = _state.newsArticles || [];
  if (!articles.length) return "";
  const rows = articles.map((a) => `
    <a class="dwrp-news-item" href="${_escapeHtml(a.url)}" target="_blank" rel="noopener">
      <span class="dwrp-news-title">${_escapeHtml(a.title)}</span>
      <span class="dwrp-news-meta">${_escapeHtml(a.domain || a.sourcecountry || "")}${a.formatted_date ? ` · ${_escapeHtml(a.formatted_date)}` : ""}</span>
    </a>
  `).join("");
  return `
    <div class="dwrp-table-label">Recent news &amp; context</div>
    <div class="dwrp-news-list">${rows}</div>
  `;
}

function _showIntroPopup() {
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">About This Briefing</span>
      <span class="dwrp-badge">3 Chapters</span>
    </div>
    <div class="dwrp-body">
      A cinematic, data-driven walkthrough of Pakistan's most recent weather picture — every figure traces back to a live PMD/NWFC/FFD source; nothing here is scripted or invented. Use the rewind/fast-forward buttons on the transport bar to change playback speed (1x-5x) in either direction.
    </div>
    <div class="dwrp-table-label">Layers used in this briefing</div>
    <div class="dwrp-chips">
      <span class="dwrp-chip">DWD Satellite Infrared</span>
      <span class="dwrp-chip">2m Temperature</span>
      <span class="dwrp-chip">24h Precipitation</span>
      <span class="dwrp-chip">NWFC Station Observations</span>
      <span class="dwrp-chip">Heatwave Monitoring</span>
      <span class="dwrp-chip">FFD Data</span>
      <span class="dwrp-chip">District Boundaries</span>
    </div>
    <div class="dwrp-table-label">What happens next</div>
    <div class="dwrp-body">
      1. Cinematic fly-in to Pakistan<br>
      2. Chapter 1 — satellite sweep + 24-hour rainfall stats, then a tour of the heaviest rainfall districts<br>
      3. Chapter 2 — 2m temperature outlook, then a tour of the hottest reporting stations<br>
      4. Chapter 3 — 24h precipitation outlook, then a north-to-south flythrough of FFD-monitored barrages and dams<br>
      5. Closing operational assessment for each chapter
    </div>
    ${_newsSectionHtml()}
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
  await Promise.all(layerIds.map((id) => {
    const prop = _opacityPropForLayer(map, id);
    let from = 0.85;
    try {
      const cur = map.getPaintProperty(id, prop);
      if (typeof cur === "number") from = cur;
    } catch (_) { /* best-effort */ }
    return fadeLayerOpacity(map, id, prop, from, 0, _dur(1200));
  }));
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
// playAnimation()) only offers fixed 0.5x/1x/2x/3x speeds. This drives the
// SAME slider element itself instead, at our own explicit cadence — 0.5x
// of the native baseline (one frame every 2000ms) so an 8-frame lap takes
// ~16s, slow enough to actually read each frame rather than blur past it.
// Shared by every "layer" scene (radar in Chapter 1, temperature in
// Chapter 2), not radar-specific despite the name. Setting `.value` alone
// doesn't invoke the slider's own frame-rendering logic (showTimeStepLayers,
// private to temporal-controls.js), so a synthetic "input" event is
// dispatched — the exact event its own listener (temporal-controls.js) is
// already wired to, just triggered by us instead of a native pointer drag.
// Runs in the background (not awaited by the caller) for as long as this
// scene stays active; stops the instant the scene goes stale (operator
// moved to another scene) — the layer itself is never faded out here,
// only this stepping stops. Also sets _state.pendingMinDwellMs (read once
// by _gotoScene's next _scheduleAdvance call) so the scene holds long
// enough to actually SHOW a full lap of frames rather than moving on
// after showing just one — at this cadence that's usually a few seconds,
// well under the normal TTS/dwell time, so it rarely has to stretch the
// scene at all.
const TEMPORAL_STEP_BASE_MS = 1000; // matches temporal-controls.js's own 1x baseline
const TEMPORAL_STEP_SPEED = 0.5;    // playback speed for these layer scenes — half normal
function _playTemporalLoop(token, seq) {
  const slider = document.getElementById("slider1");
  if (!slider) return;

  const maxVal = parseInt(slider.max, 10);
  if (!Number.isFinite(maxVal) || maxVal < 1) return; // only one frame — nothing to step through

  const stepMs = TEMPORAL_STEP_BASE_MS / TEMPORAL_STEP_SPEED; // 2000ms/frame at 0.5x
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

// Reverses _ensureObservationsOn — Chapter 1's NWFC Station Observations
// markers have no business staying on the map once Chapter 2's own
// Heatwave Monitoring markers take over the same visual role; leaving both
// on clutters the view with two overlapping marker sets. Best-effort, same
// pattern as _ensureHeatwaveLayerOn.
async function _ensureObservationsOff() {
  if (!window.sourceLayerControl || typeof window.sourceLayerControl.removeLayerByKey !== "function") return;
  try { window.sourceLayerControl.removeLayerByKey(OBS_ITEM_KEY); } catch (_) { /* best-effort */ }
}

// Chapter 2's equivalent of _ensureObservationsOn — turns on the
// Heatwave Monitoring TOGGLE layer so its markers are visible alongside
// the 2m Temperature raster during the station tour. Renders via a real
// GL circle layer (unlike nwfc_observations' DOM markers), so no CSS
// marker-fade class is applied here — best-effort, matches the existing
// TOGGLE-item activation pattern.
async function _ensureHeatwaveLayerOn() {
  if (!window.sourceLayerControl || typeof window.sourceLayerControl.addLayerByKey !== "function") return;
  try { await window.sourceLayerControl.addLayerByKey(HEATWAVE_ITEM_KEY); } catch (_) { /* best-effort */ }
}

// Chapter 3's equivalent of _ensureHeatwaveLayerOn — turns on the FFD
// Data TOGGLE layer for the barrage tour. Chapter 2's Heatwave Monitoring
// layer has no reason to stay on into Chapter 3, mirroring the same
// hand-off _ensureObservationsOff already does between Chapters 1 and 2.
async function _ensureFfdLayerOn() {
  if (!window.sourceLayerControl || typeof window.sourceLayerControl.addLayerByKey !== "function") return;
  try { await window.sourceLayerControl.addLayerByKey(FFD_ITEM_KEY); } catch (_) { /* best-effort */ }
}
async function _ensureHeatwaveLayerOff() {
  if (!window.sourceLayerControl || typeof window.sourceLayerControl.removeLayerByKey !== "function") return;
  try { window.sourceLayerControl.removeLayerByKey(HEATWAVE_ITEM_KEY); } catch (_) { /* best-effort */ }
}

function _centroid(coords) {
  const n = coords.length;
  const sum = coords.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
  return [sum[0] / n, sum[1] / n];
}

// Resolves the correct opacity paint property for a layer by its actual
// Mapbox type — "raster-opacity" covers every temporal layer this file
// used to deal with exclusively (PMD/DWD raster predictions), but
// Chapter 3's overview now shows Meteoblue's own vector fill layer
// (weekly_precipitation_2m_above_ground) as its visual, which needs
// "fill-opacity" instead. Falls back to "raster-opacity" if the layer
// can't be found/typed, matching this file's prior hardcoded assumption.
function _opacityPropForLayer(map, id) {
  const type = map.getLayer(id)?.type;
  switch (type) {
    case "fill":    return "fill-opacity";
    case "circle":  return "circle-opacity";
    case "line":    return "line-opacity";
    case "symbol":  return "icon-opacity";
    case "heatmap": return "heatmap-opacity";
    default:        return "raster-opacity";
  }
}

// Fades the currently-active temporal layer's opacity to `to`, reading
// whatever it's CURRENTLY painted at as the fade start (rather than
// assuming a fixed value) — this gets called both to dim the layer while
// zoomed into a district and to restore it on the province-wide zoom-out,
// so it needs to work from either starting point.
async function _setActiveLayerOpacity(map, to, durationMs = 700) {
  const temporal = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
  const layerIds = (temporal?.currentEntry?.layers || []).map((l) => l.id).filter((id) => map.getLayer(id));
  await Promise.all(layerIds.map((id) => {
    const prop = _opacityPropForLayer(map, id);
    let from = 0.85;
    try {
      const cur = map.getPaintProperty(id, prop);
      if (typeof cur === "number") from = cur;
    } catch (_) { /* best-effort */ }
    return fadeLayerOpacity(map, id, prop, from, to, _dur(durationMs));
  }));
}

// Fading opacity to 0 (_setActiveLayerOpacity) only makes the layer paint
// transparent — Mapbox still keeps it in the render loop, so as the camera
// zooms/orbits closer during a district close-up it still requests newly-
// needed tiles at the higher zoom for that (invisible) layer, and if the
// provider doesn't serve that zoom level those requests surface as real
// map "error" events (see dashboard.js's #handleMapError) even though
// nothing is visibly wrong. Layout `visibility: "none"` is the actual fix
// — it pulls the layer out of the render/tile-management loop entirely, so
// no new tiles are requested for it at all while zoomed in. Toggled back
// to "visible" wherever the layer is meant to be seen again (_runPrecipLayer's
// own reveal), never left off after this scene's layer is torn down for
// real anyway (_deactivateTemporalLayer doesn't need this — it removes the
// layer's frame entirely, so its visibility state stops mattering).
function _setActiveLayerVisibility(map, visible) {
  const temporal = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
  const layerIds = (temporal?.currentEntry?.layers || []).map((l) => l.id).filter((id) => map.getLayer(id));
  for (const id of layerIds) {
    try { map.setLayoutProperty(id, "visibility", visible ? "visible" : "none"); } catch (_) {}
  }
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

  // Narrow the boundary-blink overlay to JUST this district — the
  // previous district (or the whole-province set from a prior overview
  // scene) stops blinking the instant this filter is applied. Blinking
  // itself keeps running (_startDistrictBlink was already started back
  // in _runRadar); this only changes WHICH districts match its filter.
  _prepareDistrictHighlight([scene.district]);

  // One fixed aerial zoom for every district, regardless of rainfall —
  // no extra zoom-in step. See _frameDistrictCluster for why: any closer
  // and the still-visible DWD Satellite Infrared layer starts requesting
  // tile zooms its provider may not serve. The layer's opacity also dims
  // to <=0.5 while zoomed into a district, so the raster doesn't compete
  // visually with the district focus — restored on the province-overview
  // zoom-out (_runProvinceOverview).
  await Promise.all([
    _frameDistrictCluster(map, coords, {
      pitch: 40,
      bearing: (Math.random() * 30) - 15, // gentle scene-to-scene bearing variety, not a random spin
      duration: 2600,
    }),
    _setActiveLayerOpacity(map, 0.4),
  ]);
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

// Wide establishing shot for a whole province, once its top-2 district
// tour is done — bounds over every matched station in that province
// (top 2 + the rest), padded generously and capped at a much lower zoom
// than _frameDistrictCluster, so it reads as "here's the extent of the
// whole province", not another district close-up.
async function _frameProvinceExtent(map, coords, opts = {}) {
  if (!coords.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minX) minX = lng;
    if (lng > maxX) maxX = lng;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  }
  const padDeg = 0.5;
  return cinematicFitBounds(map, [[minX - padDeg, minY - padDeg], [maxX + padDeg, maxY + padDeg]], {
    pitch: opts.pitch ?? 25,
    bearing: opts.bearing ?? 0,
    duration: _dur(opts.duration ?? 2800),
    maxZoom: opts.maxZoom ?? 6.5,
  });
}

async function _runProvinceOverview(map, scene, token, seq) {
  // Widen the boundary-blink overlay to every affected district in this
  // province (the top 2 just toured PLUS the rest that only got a
  // mention) — a single-district filter would leave the zoomed-out shot
  // looking like only one district in the whole province mattered.
  const allProvinceDistricts = [...(scene.topDistricts || []), ...(scene.remainingDistricts || [])];
  _prepareDistrictHighlight(allProvinceDistricts);

  await Promise.all([
    _frameProvinceExtent(map, scene.coords || []),
    _setActiveLayerOpacity(map, 0.85), // restore — the dim from _runStation was district-focus-only
    disableRainEffect(map), // any per-district rain flourish doesn't belong on a province-wide shot
  ]);
  if (_isStale(token, seq)) return;
  _showProvinceOverviewPopup(scene);
}

function _showProvinceOverviewPopup(scene) {
  const top3 = scene.topDistricts || [];
  const rest = scene.remainingDistricts || [];
  const topRows = top3.map((d) => `<tr><td>${_escapeHtml(d.name)}</td><td>${_hlNum(`${d.mm_total} mm`)}</td></tr>`).join("");
  const restRows = rest.map((d) => `<tr><td>${_escapeHtml(d.name)}</td><td>${_hlNum(`${d.mm_total} mm`)}</td></tr>`).join("");
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">${_escapeHtml(scene.province)} — Province Overview</span>
      <span class="dwrp-badge">${top3.length + rest.length} districts</span>
    </div>
    <div class="dwrp-body">
      ${_captionHtml(scene.caption)}
      ${topRows ? `
      <div class="dwrp-table-label">Districts just toured</div>
      <table class="dwrp-table">
        <thead><tr><th>District</th><th>Rainfall</th></tr></thead>
        <tbody>${topRows}</tbody>
      </table>` : ""}
      ${restRows ? `
      <div class="dwrp-table-label">Also reporting rainfall</div>
      <table class="dwrp-table">
        <thead><tr><th>District</th><th>Rainfall</th></tr></thead>
        <tbody>${restRows}</tbody>
      </table>` : ""}
    </div>
  `);
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
  // Chapter 1's own layer (NWFC Station Observations) has no reason to
  // stay on once we've moved past the rainfall chapter — Chapter 2 brings
  // its own station layer (Heatwave Monitoring) for the same role. Its
  // temporal raster (DWD) was already torn down by Chapter 1's own
  // closing "assessment" scene, the step before this one.
  _ensureObservationsOff();

  // Chapter 2's own layers (2m Temperature, Heatwave Monitoring) load
  // alongside the re-settle rather than staying idle until the
  // temperature/station scenes reach them individually —
  // _activateTemporalLayer/_ensureHeatwaveLayerOn are both idempotent,
  // so those later scenes' own calls just find everything already ready.
  const card = document.getElementById(CARD_ID);
  _setLayerLoadingNote(card, "Loading temperature and heatwave layers for Chapter 2…");
  await Promise.all([
    // Chapter 1's assessment already leaves the camera at a national
    // fitBounds view — just a brief re-settle, no new fly-in needed.
    cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.8, pitch: 25, bearing: -8, duration: _dur(2000) }),
    _activateTemporalLayer(map, TEMP_ITEM_KEY, "2m Temperature", token, seq).catch(() => false),
    _ensureHeatwaveLayerOn(),
  ]);
  if (_isStale(token, seq)) return;
  _setLayerLoadingNote(card, null);

  // Weekly temperature VALUES: query every step of the Meteoblue 2m
  // Temperature layer directly (never through handleTemporalInteraction/
  // #temp-slider1 — see _sampleMeteoblueTemperatureAllSteps) and cache
  // them, same "sample once per session" rule Chapter 3 uses for
  // precipitation. Candidate districts come from _districtBoundaryCandidates
  // (every district polygon actually in view — genuinely national
  // coverage), computed once and shared with Chapter 3's own sampling pass
  // below; _precipCandidateDistricts (a handful of report-driven districts)
  // is only the fallback if the boundary query comes back empty.
  if (!_state.districtBoundaryCandidatesComputed) {
    _state.districtBoundaryCandidates = await _districtBoundaryCandidates(map).catch(() => []);
    _state.districtBoundaryCandidatesComputed = true;
  }
  if (!_state.meteoblueTempSampledOnce) {
    _setLayerLoadingNote(card, "Sampling Meteoblue 8-day temperature outlook for monitored districts…");
    const candidates = _state.districtBoundaryCandidates.length
      ? _state.districtBoundaryCandidates
      : _precipCandidateDistricts(_state.report, _state.observations?.features || []);
    const temperatureMap = await _sampleMeteoblueTemperatureAllSteps(map, candidates).catch(() => new Map());
    _state.meteoblueTemperature = temperatureMap;
    _state.weeklyTempSamples = _buildTempWeeklySamples(candidates, temperatureMap);
    _state.meteoblueTempSampledOnce = true;
    _setLayerLoadingNote(card, null);
  }
  if (_isStale(token, seq)) return;

  // Splice the weekly-outlook scene in right before temp-assessment —
  // guarded so re-entering ch2-intro (Prev/dot-click) never inserts a
  // second copy. Mirrors _runChapter3Intro's own scene-splice pattern.
  if (!_state.chapter2WeeklyScenesBuilt) {
    const assessmentIdx = _state.scenes.findIndex((s) => s.kind === "temp-assessment");
    const insertAt = assessmentIdx >= 0 ? assessmentIdx : _state.scenes.length;
    _state.scenes.splice(insertAt, 0, {
      kind: "temp-weekly",
      chapter: 2,
      weeklyTempSamples: _state.weeklyTempSamples,
      caption: _tempWeeklyNarrative(_state.weeklyTempSamples),
    });
    _state.chapter2WeeklyScenesBuilt = true;
    const cardEl = document.getElementById(CARD_ID);
    if (cardEl) _renderDots(cardEl);
    _queueTranslateNewCaptions(cardEl);
  }
}

async function _runTempLayer(map, token, seq) {
  // National-scale scene, not zoomed to any one district — close any stats
  // panel left open from a station scene reached via Prev/Next navigation.
  try { hideHeatwaveModal(); } catch (_) {}
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
  if (!ready) { _showTempLayerPopup(); return; }

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

  _showTempLayerPopup();
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

// Forward-looking outlook scene, spliced in right before temp-assessment
// once its Meteoblue sampling pass has run (see _runChapter2Intro) —
// national-scale, no per-district flyover tour (unlike Chapter 3's
// precip-district scenes), same camera treatment as _runTempLayer/
// _runPrecipLayer's national reveal.
async function _runTempWeekly(map, scene, token, seq) {
  try { hideHeatwaveModal(); } catch (_) {}
  await cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.7, pitch: 15, bearing: 4, duration: _dur(1800) });
  if (_isStale(token, seq)) return;
  _showTempWeeklyPopup(scene);
}

async function _runTempAssessment(map) {
  _closePopup();
  try { hideHeatwaveModal(); } catch (_) {}
  _clearDistrictOverlay();
  disableRainEffect(map);
  await _deactivateTemporalLayer(map, TEMP_ITEM_KEY);
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(2400) });
  disableCinematicAtmosphere(map);
}

// ==========================================================================
// CHAPTER 3 — Forecasted Precipitation Outlook. First half mirrors
// Chapters 1/2's "layer scene → district tour" structure exactly (same
// _activateTemporalLayer/_playTemporalLoop/_frameDistrictCluster/
// orbitAroundPoint choreography); second half is the FFD barrage tour,
// which additionally uses flyAlongPath for the north-to-south travel
// between consecutive stops.
// ==========================================================================
// Chapter 3's own layer/scene preload — mirrors what _runIntro does for
// Chapter 1 and _runChapter2Intro does for Chapter 2: tear down the
// PREVIOUS chapter's layers first, then load and confirm-display THIS
// chapter's own layers, and only once that's done does the chapter
// actually proceed. Chapter 3 additionally has to build its OWN scene
// list here (_buildChapter3Scenes) rather than upfront in _buildScenes,
// since those scenes' district values depend on Meteoblue's sampled
// data, which doesn't exist until this preload runs.
//
// Meteoblue's VALUES are sampled via its own standalone source/layer
// add+query+remove pass (_sampleMeteoblueAllSteps) that never touches the
// shared #temp-slider1 system at all — that finishes and tears itself
// down BEFORE the real Meteoblue weekly layer is activated afterward for
// actual display (METEOBLUE_WEEKLY_ITEM_KEY), so the two never overlap on
// the app's single "active temporal layer" slot. The visual layer is left
// active once this returns, ready for Chapter 3's own scenes to fade in
// later, and torn down again in _runPrecipAssessment before the FFD tour.
// FFD has no such conflict either (a TOGGLE layer, not a temporal one).
async function _runChapter3Intro(map, token, seq) {
  // Chapter 2's layers/functionality go away entirely once Chapter 3
  // starts — same "previous chapter's layers don't linger" hand-off
  // _runChapter2Intro already does for Chapter 1's.
  _ensureHeatwaveLayerOff();
  await _deactivateTemporalLayer(map, TEMP_ITEM_KEY);
  if (_isStale(token, seq)) return;

  const card = document.getElementById(CARD_ID);
  _setLayerLoadingNote(card, "Loading precipitation, river, and station layers for Chapter 3…");

  await cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.8, pitch: 25, bearing: 6, duration: _dur(2000) });
  if (_isStale(token, seq)) return;

  await _ensureFfdLayerOn();
  if (_isStale(token, seq)) return;
  // ensureRiversLayer (gcop-ffd-integration.js) runs fire-and-forget
  // inside the addLayerByKey wrapping it uses, so the await above doesn't
  // actually track when the rivers source finishes loading — poll for it
  // briefly (same patient-wait convention _activateTemporalLayer itself
  // uses) rather than assume it's ready the instant addLayerByKey returns.
  for (let i = 0; i < 30 && !map.getSource("ffd_data-rivers-source"); i++) {
    await wait(200);
    if (_isStale(token, seq)) return;
  }

  // Precipitation VALUES: query every step of both Meteoblue precip
  // layers directly (never through handleTemporalInteraction/#temp-
  // slider1 — see _sampleMeteoblueAllSteps) and cache them. Runs once per
  // story session — a repeat visit to ch3-intro (Prev/dot-click) reuses
  // the cached Maps instead of re-hitting Meteoblue's tile API again.
  // Candidate districts come from _districtBoundaryCandidates (every
  // district polygon in view, genuinely national coverage) — computed
  // once and shared with Chapter 2's own sampling pass, whichever of the
  // two chapters reaches it first this session; _precipCandidateDistricts
  // is only the fallback if that boundary query came back empty.
  if (!_state.districtBoundaryCandidatesComputed) {
    _state.districtBoundaryCandidates = await _districtBoundaryCandidates(map).catch(() => []);
    _state.districtBoundaryCandidatesComputed = true;
  }
  const precipCandidates = _state.districtBoundaryCandidates.length
    ? _state.districtBoundaryCandidates
    : _precipCandidateDistricts(_state.report, _state.observations?.features || []);
  if (!_state.meteoblueSampledOnce) {
    _setLayerLoadingNote(card, "Sampling Meteoblue precipitation forecasts for monitored districts…");
    const sampled = await _sampleMeteoblueAllSteps(map, precipCandidates).catch(() => ({ weekly: new Map(), hourly: new Map() }));
    _state.meteoblueWeekly = sampled.weekly;
    _state.meteoblueHourly = sampled.hourly;
    _state.meteoblueSampledOnce = true;
    _setLayerLoadingNote(card, null);
  }
  if (_isStale(token, seq)) return;

  // Precipitation VISUAL: the actual Meteoblue weekly layer, shown for
  // real this time (unlike the standalone sampling pass above, this DOES
  // go through the normal single-active-temporal-layer mechanism, since
  // it's now meant to be seen). Pre-activating it here means it's already
  // on by the time _runPrecipLayer's own scene fades it in — same
  // preload-then-reveal pattern _runIntro/_runChapter2Intro use for
  // DWD/2m Temperature. Deactivated again in _runPrecipAssessment, right
  // before the FFD station tour begins.
  await _activateTemporalLayer(map, METEOBLUE_WEEKLY_ITEM_KEY, "Weekly Precipitation", token, seq).catch(() => false);
  if (_isStale(token, seq)) return;
  _setLayerLoadingNote(card, null);

  // Everything Chapter 3 needs is loaded now — build its actual scenes
  // (deferred out of _buildScenes for exactly this reason) and splice
  // them in right after this ch3-intro stub, then refresh the dot nav so
  // it reflects the new total scene count. Guarded to run ONCE per story
  // load — re-entering ch3-intro via Prev/a dot click after Chapter 3 has
  // already played would otherwise splice a second copy in every time;
  // the layer preload above this is fine to repeat (all idempotent), only
  // the scene-list build+splice needs the guard.
  if (!_state.chapter3ScenesBuilt) {
    const newScenes = await _buildChapter3Scenes(_state.report, _state.observations?.features || [], precipCandidates);
    if (_isStale(token, seq)) return;
    _state.scenes.splice(_state.index + 1, 0, ...newScenes);
    _state.chapter3ScenesBuilt = true;
    const cardEl = document.getElementById(CARD_ID);
    if (cardEl) _renderDots(cardEl);
    _queueTranslateNewCaptions(cardEl);
  }
}

async function _runPrecipLayer(map, token, seq) {
  try { hideHeatwaveModal(); } catch (_) {}
  await cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.7, pitch: 15, bearing: 0, duration: _dur(1800) });
  if (_isStale(token, seq)) return;

  const card = document.getElementById(CARD_ID);
  const ready = await _activateTemporalLayer(map, METEOBLUE_WEEKLY_ITEM_KEY, "Weekly Precipitation", token, seq, {
    onSlow: () => _setLayerLoadingNote(card, "Loading Meteoblue precipitation imagery…"),
  });
  _setLayerLoadingNote(card, null);
  if (_isStale(token, seq)) return;
  if (!ready) { _showPrecipLayerPopup(); return; }

  const temporal = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
  const layerIds = (temporal?.currentEntry?.layers || []).map((l) => l.id).filter((id) => map.getLayer(id));
  // Undoes _runPrecipDistrict's visibility:none in case the operator
  // navigated straight back here (Prev/a dot click) from a district scene
  // — without this the opacity fade-in below would run on a layer Mapbox
  // still isn't rendering at all.
  _setActiveLayerVisibility(map, true);
  for (const id of layerIds) {
    try { map.setPaintProperty(id, _opacityPropForLayer(map, id), 0); } catch (_) {}
  }
  await wait(150);
  if (_isStale(token, seq)) return;
  await Promise.all(layerIds.map((id) => fadeLayerOpacity(map, id, _opacityPropForLayer(map, id), 0, 0.75, _dur(2000))));
  if (_isStale(token, seq)) return;

  _playTemporalLoop(token, seq);

  // Blink every sampled district with a non-zero forecast — the districts
  // this chapter's sampling step actually found precipitation at, not
  // Chapter 1's observed-rainfall set (a fresh _prepareDistrictHighlight
  // call cleanly takes over the same boundary-blink overlay).
  const wetNames = (_state.topPrecipDistricts || [])
    .filter((d) => d.mm > 0)
    .map((d) => ({ name: d.name }));
  _prepareDistrictHighlight(wetNames).then(() => { if (!_isStale(token, seq)) _startDistrictBlink(); });

  _showPrecipLayerPopup();
}

async function _runPrecipDistrict(map, scene, token, seq) {
  const coords = scene.entry?.coords;
  if (!coords) return;

  _prepareDistrictHighlight([{ name: scene.entry.name }]);

  // Fully hidden (not just dimmed) while zoomed into a district — the
  // raster's own low resolution reads as noisy/blocky at this close a
  // zoom, and the district boundary highlight + popup numbers already
  // carry the reading without it. Uses layout visibility, not opacity: an
  // opacity-only fade leaves the layer in Mapbox's render loop, so as the
  // camera zooms/orbits in it still requests newly-needed tiles at the
  // higher zoom for a layer nobody can see, and the provider erroring on
  // those (see _setActiveLayerVisibility's own comment) surfaced as real
  // map "error" events. Visibility:none pulls it out of that loop entirely.
  _setActiveLayerVisibility(map, false);

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
  _showPrecipDistrictPopup(scene);
}

// Province-wise national overview — deliberately NO camera zoom into any
// single district (that's still what _runPrecipDistrict does, just no
// longer scheduled by _buildChapter3Scenes); a single wide national shot,
// same cinematicFitBounds(PAKISTAN_BOUNDS) framing _runPrecipAssessment
// already uses to close this section out. Blinks every district that
// actually has a group entry (mirrors _runPrecipLayer's own "blink every
// wet district" overlay), so the boundary highlight still visually backs
// up the numbers in the popup.
async function _runPrecipProvinceOverview(map, scene, token, seq) {
  _setActiveLayerVisibility(map, true); // undoes _runPrecipDistrict's visibility:none, in case of a direct Prev/dot jump

  const wetNames = (scene.precipSamples || [])
    .filter((d) => d.mm > 0)
    .map((d) => ({ name: d.name }));
  _prepareDistrictHighlight(wetNames).then(() => { if (!_isStale(token, seq)) _startDistrictBlink(); });

  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(2400) });
  if (_isStale(token, seq)) return;
  _showPrecipProvinceOverviewPopup(scene);
}

async function _runPrecipAssessment(map) {
  _closePopup();
  _clearDistrictOverlay();
  disableRainEffect(map);
  // Meteoblue's weekly layer was the precipitation half's visual — turned
  // off here, before the FFD barrage/dam tour begins, same "previous
  // chapter's layers don't linger" hand-off used between every other
  // chapter transition. The cached step values (_state.meteoblueWeekly/
  // Hourly) are untouched by this — narration keeps reading from those
  // regardless of whether the layer itself is currently shown.
  await _deactivateTemporalLayer(map, METEOBLUE_WEEKLY_ITEM_KEY);
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(2400) });
}

// ---- FFD barrage/dam tour ----------------------------------------------
async function _runFfdIntro(map, token, seq) {
  await _ensureFfdLayerOn();

  // Bulk 30-day discharge history for the whole barrage tour — fired once,
  // fire-and-forget (not awaited): by the time the first barrage's own
  // camera flythrough + popup finish (several more seconds), this has
  // almost always already resolved, so nothing here waits on a fetch that
  // isn't actually needed until a popup renders (see _showFfdBarragePopup).
  if (!_state.ffdHistoryAllFetchedOnce) {
    _state.ffdHistoryAllFetchedOnce = true;
    _state.ffdHistoryAllPromise = _fetchFfdHistoryAll().then((data) => { _state.ffdHistoryAll = data; return data; });
  }

  const first = _state.ffdWaypoints?.[0];
  if (!first) return;
  await cinematicFlyTo(map, { center: first.center, zoom: 6.2, pitch: 45, bearing: 0, duration: _dur(3200) });
}

// Reference-chart scene — a brief national hold while the popup shows the
// real PMD/FFD flood-routing network diagram (flood_routing_map.png),
// oriented before the river-by-river tour walks that same real topology.
async function _runFfdRoutingMap(map, token, seq) {
  _closePopup();
  await cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.6, pitch: 10, bearing: 0, duration: _dur(2000) });
  if (_isStale(token, seq)) return;
  _showFfdRoutingMapPopup();
}

async function _runFfdBarrage(map, scene, token, seq) {
  _closePopup();
  // A prior river's overview scene may still have its group blink
  // active — individual station scenes always start from a clean slate.
  _clearFfdHighlight();
  const wp = scene.waypoint;
  if (!wp?.center) return;

  if (scene.prevWaypoint?.center) {
    // The literal "animate camera along a path" technique the operational
    // brief pointed at — https://docs.mapbox.com/mapbox-gl-js/example/free-camera-path/
    // — flown for the TRAVEL leg between consecutive barrages. There is no
    // river-channel geometry to trace (/get-ffd-rivers/ is catchment
    // polygons, not lines — see _buildFfdWaypoints), so the leg follows a
    // gently bowed arc (_curvedStationPath) instead of a dead-straight
    // line — a slow, low, drone-like pass rather than a fast teleport.
    const arc = _curvedStationPath(scene.prevWaypoint.center, wp.center);
    const straightDeg = _pathLengthDeg([scene.prevWaypoint.center, wp.center]);
    const arcDeg = _pathLengthDeg(arc);
    const ratio = straightDeg > 0 ? arcDeg / straightDeg : 1;
    // Slow baseline (a straight-line hop between two nearby barrages
    // still takes a good ~7s) scaled gently for longer legs, capped so a
    // very long leg doesn't drag on forever.
    const durationMs = Math.min(16000, 7000 * Math.max(1, ratio));
    const pathWaypoints = arc.map((c, i) => ({
      center: c,
      altitude: 12000 + (8000 - 12000) * (i / (arc.length - 1)),
    }));
    await flyAlongPath(map, pathWaypoints, { durationMs: _dur(durationMs), lookAheadFrac: 0.18 });
  } else {
    await cinematicFlyTo(map, { center: wp.center, zoom: 7.5, pitch: 45, bearing: 0, duration: _dur(2600) });
  }
  if (_isStale(token, seq)) return;

  // Re-establishes a clean angled view after the flythrough (whose last
  // frames look nearly straight down as the look-ahead point converges on
  // the arrival point itself) — same orbit beat every other station scene
  // in this file ends on.
  await orbitAroundPoint(map, wp.center, {
    durationMs: _dur(3000),
    radiusMeters: 12000,
    altitudeMeters: 7000,
    revolutions: 0.2,
  });
  if (_isStale(token, seq)) return;

  const mapEl = document.getElementById("map");
  if (mapEl) {
    mapEl.classList.add("ncop-dwr-pulse-target");
    setTimeout(() => mapEl.classList.remove("ncop-dwr-pulse-target"), 2400);
  }
  await _showFfdBarragePopup(scene, token, seq);
}

// Wide, single-shot summary for one whole river — reuses
// _frameDistrictCluster's own bbox+pad+fitBounds computation (already
// proven for exactly this "camera over a cluster of points" job in
// Chapter 1) rather than re-deriving bounding-box math here. Blinks
// EVERY station on the river at once (featured individually-toured ones
// AND skipped normal-flow ones alike) so the "which point is this
// talking about" cue covers the whole group, not just whichever one
// happened to get its own flythrough — see _showFfdRiverOverviewPopup
// for the compact per-station table that keeps every reading visible
// even for stations that didn't get individual camera time.
async function _runFfdRiverOverview(map, scene, token, seq) {
  _closePopup();
  // The overview is a whole-river summary, not a single station — any
  // per-station FFD Discharge Stats modal left open from a previous
  // "ffd-barrage" scene no longer applies here.
  try { hideFfdModal(); } catch (_) {}
  const coords = (scene.members || []).map((wp) => wp.center).filter(Boolean);
  if (!coords.length) return;
  await _frameDistrictCluster(map, coords, { pitch: 30, bearing: 0, duration: 2800, zoom: 7.2, maxZoom: 8.2 });
  if (_isStale(token, seq)) return;

  _setFfdHighlight(scene.members.map((wp) => wp.name));
  _startFfdBlink();

  _showFfdRiverOverviewPopup(scene);
}

async function _runFfdAssessment(map) {
  _closePopup();
  try { hideFfdModal(); } catch (_) {}
  _clearFfdHighlight();
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
      ${_captionHtml(scene.caption)}
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
// Past-24-hour popup — temp_max/temp_min per station (Heatwave Monitoring,
// Open-Meteo-derived) cross-referenced against Max Temp Records where a
// historical on-record match exists. Reads straight from _state since
// this scene isn't about "the current top 5", it's every station with a
// past-day reading, most-recent-fetch data only — never invents a figure.
function _showTempLayerPopup() {
  const feats = (_state.heatwaveStations?.features || [])
    .filter((f) => Number.isFinite(f.properties?.temp_max))
    .map((f) => ({ name: f.properties.name, province: f.properties.province, tempMax: f.properties.temp_max, tempMin: f.properties.temp_min }))
    .sort((a, b) => b.tempMax - a.tempMax);
  const records = _state.maxTempRecords || [];

  // Same Open-Meteo-outage fallback as _pastDayNarrative — when Heatwave
  // Monitoring returns no usable temp_max readings at all (429-rate-
  // limited), build this table from Max Temp Records directly instead of
  // showing an empty state. Max Temp Records carries no province field
  // (see _extractMaxTempRows), so that column is simply omitted here.
  const usingRecordsFallback = !feats.length && records.length > 0;
  const rows = usingRecordsFallback
    ? records.slice(0, 8).map((r) => `
        <tr>
          <td>${_escapeHtml(r.name || "")}</td>
          <td>${_hlNum(`${r.temp}°C`)}${r.date ? `<div class="dwrp-live-note">On-record: ${_escapeHtml(r.date)}</div>` : ""}</td>
        </tr>
      `).join("")
    : feats.slice(0, 8).map((f) => {
        const record = records.find((r) => _normName(r.name) === _normName(f.name));
        const recordNote = record ? `<div class="dwrp-live-note">On-record max: ${_hlNum(`${record.temp}°C`)}${record.date ? ` (${_escapeHtml(record.date)})` : ""}</div>` : "";
        return `
          <tr>
            <td>${_escapeHtml(f.name || "")}<div class="dwrp-district-prov">${_escapeHtml(f.province || "")}</div></td>
            <td>${_hlNum(`${f.tempMax}°C`)}${Number.isFinite(f.tempMin) ? ` / ${_hlNum(`${f.tempMin}°C`)}` : ""}${recordNote}</td>
          </tr>
        `;
      }).join("");
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">Past 24 Hours — Temperature</span>
      <span class="dwrp-badge">${usingRecordsFallback ? "On-Record" : "High / Low"}</span>
    </div>
    <div class="dwrp-body">
      ${rows ? `
      <div class="dwrp-table-label">${usingRecordsFallback ? "Hottest on-record stations (Max Temp Records)" : "Hottest stations, past 24h"}</div>
      <table class="dwrp-table">
        <thead><tr><th>Station</th><th>${usingRecordsFallback ? "On-Record Max" : "High / Low"}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="dwrp-summary-line">No past-24-hour temperature data is currently available from any connected source.</div>`}
      <div class="dwrp-summary-line dwrp-summary-secondary">${usingRecordsFallback ? "Live Open-Meteo readings are temporarily unavailable (rate-limited) — showing PMD's historical Max Temperature Records instead." : "Source: PMD Heatwave Monitoring (Open-Meteo-derived) + historical Max Temp Records. Layer: PMD 2m Temperature prediction, shown for visual context only."}</div>
    </div>
  `);
}

// Current-conditions popup — mirrors the REAL heatwave marker popup's
// look (alert badge, "now" readout) and includes the actual
// `.heatwave-open-stats` button with the same data-lat/data-lon/data-name/
// data-province/data-alert/data-variant attributes the real one uses. The
// app's own global click handler for that class (layer-attribute-popup.js)
// is delegated on document, so if it's already been installed (i.e. any
// heatwave popup has been opened at least once this session) clicking it
// opens the SAME real stats modal — a bonus, not a dependency: if that
// handler was never installed, the click is a harmless no-op (delegated
// listeners never throw on an unmatched/unregistered case).
function _heatwaveAlertVariant(alert) {
  const key = String(alert || "Normal").toLowerCase();
  return ["normal", "elevated", "high", "severe", "extreme"].includes(key) ? key : "normal";
}
function _showTempStationPopup(scene) {
  const props = scene.entry.feature.properties || {};
  const [lng, lat] = scene.entry.feature.geometry?.coordinates || [];
  const alert = scene.entry.alert || "Normal";
  const variant = `heatwave-${_heatwaveAlertVariant(alert)}`;
  const subParts = [];
  if (Number.isFinite(props.apparent_temperature)) subParts.push(`Feels ${props.apparent_temperature}°`);
  if (Number.isFinite(props.temp_max) && Number.isFinite(props.temp_min)) subParts.push(`${props.temp_max}° / ${props.temp_min}°`);
  if (Number.isFinite(props.humidity)) subParts.push(`RH ${props.humidity}%`);
  const chips = [];
  if (Number.isFinite(props.wind_speed) && props.wind_speed > 0) chips.push(`Wind ${props.wind_speed} km/h`);
  if (props.updated) chips.push(String(props.updated));
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">${_escapeHtml(props.name || "")}</span>
      <span class="dwrp-badge dwrp-badge--${_escapeHtml(_heatwaveAlertVariant(alert))}">${_escapeHtml(alert)}</span>
    </div>
    <div class="dwrp-body">
      <div class="dwrp-heatwave-now">
        <span class="dwrp-heatwave-now-value">${_hlNum(`${scene.entry.temp}°C`)}</span>
        ${subParts.length ? `<span class="dwrp-heatwave-now-sub">${_escapeHtml(subParts.join(" · "))}</span>` : ""}
      </div>
      ${_captionHtml(scene.caption)}
    </div>
    ${chips.length ? `<div class="dwrp-chips">${chips.map((p) => `<span class="dwrp-chip">${_highlightNumbers(_escapeHtml(p))}</span>`).join("")}</div>` : ""}
    <div class="dwrp-pdf-list">
      <button type="button" class="heatwave-open-stats"
        data-lat="${Number.isFinite(lat) ? lat : ""}" data-lon="${Number.isFinite(lng) ? lng : ""}"
        data-name="${_escapeHtml(props.name || "")}" data-province="${_escapeHtml(scene.entry.province || "")}"
        data-alert="${_escapeHtml(alert)}" data-variant="${_escapeHtml(variant)}">
        Open Stats Panel
      </button>
    </div>
  `);

  // Auto-open the REAL heatwave stats panel (16-day forecast chart, drag/
  // resize, tab switching — all core logic, untouched) for THIS station by
  // default, instead of waiting on an operator click. showHeatwaveModalForCity
  // just updates the existing modal instance in place if one's already open,
  // so hopping station-to-station during the tour reads as one panel
  // updating, not a stack of new ones. Best-effort: never let a stats-panel
  // hiccup break scene playback.
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      showHeatwaveModalForCity({ lat, lon: lng, name: props.name || "City", province: scene.entry.province || "", alert, variant, props });
    } catch (_) { /* best-effort — story playback must never depend on this */ }
  }
}

// ---- CHAPTER 3 popups ----------------------------------------------------
function _showPrecipLayerPopup() {
  const samples = _state.topPrecipDistricts || [];
  const rows = samples.slice(0, 8).map((d) => `
    <tr>
      <td>${_escapeHtml(d.name)}<div class="dwrp-district-prov">${_escapeHtml(d.province)}</div></td>
      <td>${_hlNum(`${d.mm} ${d.unit}`)}</td>
    </tr>
  `).join("");
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">24h Precipitation Forecast</span>
      <span class="dwrp-badge">Sampled</span>
    </div>
    <div class="dwrp-body">
      ${rows ? `
      <div class="dwrp-table-label">Highest forecast districts (sampled)</div>
      <table class="dwrp-table">
        <thead><tr><th>District</th><th>Forecast (24h)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="dwrp-summary-line">No forecast precipitation values could be sampled for currently reachable districts.</div>`}
      ${samples[0] ? _dayWiseRowsMarkup(samples[0].weeklySeries) : ""}
      <div class="dwrp-summary-line dwrp-summary-secondary">Values sampled from Meteoblue's weekly + hourly precipitation forecast layers at each district's vicinity (worst reading within ~20km, not just the exact gauge point). The map layer shown alongside is the same Meteoblue weekly layer.${samples[0] ? ` Day-by-day breakdown above is for the leading district, ${_escapeHtml(samples[0].name)}.` : ""}</div>
    </div>
  `);
}

// "Today", "+1d", ... "+7d" labels for the 8 weekly steps, in order —
// matches generateMeteoblueNEMSCloudPrecipLayers' idSuffixes ordering
// (today, onedayahead, twodayahead, ...), which weeklySeries is built
// from in the same order.
const _DAY_WISE_LABELS = ["Today", "+1d", "+2d", "+3d", "+4d", "+5d", "+6d", "+7d"];
function _dayWiseRowsMarkup(weeklySeries) {
  if (!Array.isArray(weeklySeries) || !weeklySeries.length) return "";
  const rows = weeklySeries.map((p, i) => `
    <tr>
      <td>${_escapeHtml(_DAY_WISE_LABELS[i] || `+${i}d`)}</td>
      <td>${_escapeHtml(String(p.date || "—"))}</td>
      <td>${_hlNum(`${p.mm} mm`)}</td>
    </tr>
  `).join("");
  return `
    <div class="dwrp-table-label">Day-by-day forecast (Meteoblue weekly)</div>
    <table class="dwrp-table">
      <thead><tr><th>Day</th><th>Date</th><th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function _showPrecipDistrictPopup(scene) {
  const e = scene.entry;
  const badgeVariant = e.mm >= 25 ? "severe" : e.mm > 0 ? "elevated" : "normal";
  const peakLine = e.peakHour
    ? `<div class="dwrp-summary-line dwrp-summary-secondary">Peak hourly rate (next ~10h): ${_hlNum(`${e.peakHour.mm} mm/h`)} around ${_escapeHtml(e.peakHour.date || "—")}</div>`
    : "";
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">${_escapeHtml(e.name)}</span>
      <span class="dwrp-badge dwrp-badge--${badgeVariant}">${_escapeHtml(e.province)}</span>
    </div>
    <div class="dwrp-body">
      <div class="dwrp-heatwave-now">
        <span class="dwrp-heatwave-now-value">${_hlNum(`${e.mm} ${e.unit}`)}</span>
        <span class="dwrp-heatwave-now-sub">forecast, next 24h</span>
      </div>
      ${peakLine}
      ${_captionHtml(scene.caption)}
      ${_dayWiseRowsMarkup(e.weeklySeries)}
    </div>
  `);
}

// Province-wise national overview popup — one table per province (sorted
// by that province's own average, districts within it already sorted desc
// by mm), mirroring weather-report-control.js's Dynamic Report tab shape
// (province group + per-district values) with this file's own existing
// dwrp-* classes — no new CSS needed.
function _showPrecipProvinceOverviewPopup(scene) {
  const groups = scene.groups || [];
  const totalDistricts = groups.reduce((n, g) => n + g.districts.length, 0);
  const groupsHtml = groups.map((g) => {
    const rows = g.districts.map((d) => `
      <tr>
        <td>${_escapeHtml(d.name)}</td>
        <td>${_hlNum(`${d.mm} ${d.unit}`)}</td>
      </tr>
    `).join("");
    return `
      <div class="dwrp-table-label">${_escapeHtml(g.province)} <span class="dwrp-district-prov">avg ${_hlNum(`${g.avgMm.toFixed(1)} mm`)} · ${g.districts.length} district${g.districts.length === 1 ? "" : "s"}</span></div>
      <table class="dwrp-table">
        <thead><tr><th>District</th><th>Forecast (24h)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }).join("");
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">Province-Wise Precipitation Overview</span>
      <span class="dwrp-badge">${groups.length} province${groups.length === 1 ? "" : "s"} · ${totalDistricts} district${totalDistricts === 1 ? "" : "s"}</span>
    </div>
    <div class="dwrp-body">
      ${_captionHtml(scene.caption)}
      ${groupsHtml}
    </div>
  `);
}

// Chapter 2's weekly-outlook counterpart to _dayWiseRowsMarkup — same
// "Today"/"+1d".../"+7d" step labels with each step's real forecast date
// (not just an offset), just against °C values instead of mm.
function _tempDayWiseRowsMarkup(weeklySeries) {
  if (!Array.isArray(weeklySeries) || !weeklySeries.length) return "";
  const rows = weeklySeries.map((p, i) => `
    <tr>
      <td>${_escapeHtml(_DAY_WISE_LABELS[i] || `+${i}d`)}</td>
      <td>${_escapeHtml(String(p.date || "—"))}</td>
      <td>${_hlNum(`${p.tempC}°C`)}</td>
    </tr>
  `).join("");
  return `
    <div class="dwrp-table-label">Day-by-day outlook (Meteoblue weekly 2m Temperature)</div>
    <table class="dwrp-table">
      <thead><tr><th>Day</th><th>Date</th><th>Forecast</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// National-scope summary, mirroring _showPrecipLayerPopup's table shape —
// top sampled districts by today's forecast value, plus the leading
// district's full 8-day, timestamped breakdown underneath.
function _showTempWeeklyPopup(scene) {
  const samples = scene.weeklyTempSamples || [];
  const rows = samples.slice(0, 8).map((d) => `
    <tr>
      <td>${_escapeHtml(d.name)}<div class="dwrp-district-prov">${_escapeHtml(d.province)}</div></td>
      <td>${_hlNum(`${d.tempC}°C`)}</td>
    </tr>
  `).join("");
  const lead = samples[0];
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">8-Day Temperature Outlook</span>
      <span class="dwrp-badge">Sampled</span>
    </div>
    <div class="dwrp-body">
      ${rows ? `
      <div class="dwrp-table-label">Highest forecast districts (today's step, sampled)</div>
      <table class="dwrp-table">
        <thead><tr><th>District</th><th>Forecast</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="dwrp-summary-line">No 8-day temperature values could be sampled for currently reachable districts.</div>`}
      ${lead ? _tempDayWiseRowsMarkup(lead.weeklySeries) : ""}
      <div class="dwrp-summary-line dwrp-summary-secondary">Values sampled from the Meteoblue weekly 2-metre temperature layer at each district's vicinity (highest reading within ~20km, not just the exact station point) — each step carries its own forecast date/timestamp.</div>
    </div>
  `);
}

// Vite-bundled static asset — same new URL(..., import.meta.url).href
// pattern layer-attribute-popup.js's ndmaLogoSrc already uses for a
// static image reference.
const FLOOD_ROUTING_MAP_SRC = new URL("../assets/images/ffd_flood_routing/flood_routing_map.png", import.meta.url).href;

function _showFfdRoutingMapPopup() {
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">FFD Flood Routing Map</span>
      <span class="dwrp-badge">Reference</span>
    </div>
    <div class="dwrp-body">
      <img src="${FLOOD_ROUTING_MAP_SRC}" alt="FFD Flood Routing Map — revised lag times, 1990-2020" class="dwrp-routing-map-img" />
      <div class="dwrp-summary-line dwrp-summary-secondary">Official PMD/FFD flood-routing network — lag times in hours between every gauge, dam, and confluence point (revised, 1990–2020, approved 23 Jul 2021). The barrage tour that follows walks this same real network, river by river.</div>
    </div>
  `);
}

// One compact table covering EVERY station on a river (not just the ones
// that got an individual flythrough — see _buildChapter3Scenes' featured/
// skipped split) so a quiet, all-normal river never actually loses a
// reading, just the dedicated camera time for it. Status badges reuse
// the same 6-tier classification (_ffdStatusKind/FFD_STATUS_LABELS) the
// on-map circle color and its legend already use.
function _showFfdRiverOverviewPopup(scene) {
  const rows = (scene.members || []).map((wp) => {
    const props = wp.properties || {};
    const kind = _ffdStatusKind(props.status);
    const outflow = props.outflow_discharge ?? props.discharge ?? "n/a";
    const inflow = props.inflow_discharge ?? "n/a";
    const badgeVariant = kind === "normal" ? "normal" : kind === "low" ? "elevated" : kind === "medium" ? "high" : kind === "high" ? "severe" : kind === "very_high" || kind === "ex_high" ? "extreme" : "";
    return `
      <tr>
        <td>${_escapeHtml(wp.name)}${badgeVariant ? `<div class="dwrp-district-prov"><span class="dwrp-badge dwrp-badge--${badgeVariant}">${_escapeHtml(FFD_STATUS_LABELS[kind])}</span></div>` : ""}</td>
        <td>${_hlNum(`${outflow} cusecs`)} / ${_hlNum(`${inflow} cusecs`)}</td>
      </tr>
    `;
  }).join("");
  _presentPopup(`
    <div class="dwrp-head">
      <span class="dwrp-dot" aria-hidden="true"></span>
      <span class="dwrp-title">${_escapeHtml(scene.river)}</span>
      <span class="dwrp-badge">${scene.members.length} station${scene.members.length === 1 ? "" : "s"}</span>
    </div>
    <div class="dwrp-body">
      ${_captionHtml(scene.caption)}
      <div class="dwrp-table-label">Every monitored station on this river — outflow / inflow</div>
      <table class="dwrp-table">
        <thead><tr><th>Station</th><th>Outflow / Inflow</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `);
}

// Bounds an awaited promise so a slow/never-resolving fetch (a hung
// GeoGLOWS lookup, an unreachable history-all payload) can't stall scene
// playback indefinitely — always resolves, never rejects, regardless of
// how the wrapped promise settles.
function _awaitBounded(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    Promise.resolve(promise).then(finish, finish);
    setTimeout(finish, ms);
  });
}
const FFD_MODAL_LOAD_TIMEOUT_MS = 15000;

// Shows the REAL FFD popup — buildFfdPopupContent/setupFfdPopupEventHandlers
// (exported additively from layer-attribute-popup.js for exactly this) are
// the SAME code a real map click on an ffd_data gauge uses, so this is the
// actual popup shell, actual "Show Graph" button with the actual outflow/
// inflow bar chart, not a lookalike. The graph is auto-opened (dispatching
// a real click on the button it just rendered) rather than waiting for the
// operator — same reasoning the heatwave stats panel auto-opens itself.
// Discharge history, the GeoGLOWS river forecast table, and the 30-day
// history/14-day outlook chart are DELIBERATELY not duplicated here — the
// FFD Discharge Stats modal opened just below (showFfdModalForStation)
// covers all three (including its own GeoGLOWS horizon table in its left
// aside), so this popup stays focused on the station's live reading.
async function _showFfdBarragePopup(scene, token, seq) {
  const wp = scene.waypoint;
  const props = wp.properties || {};

  // Auto-open the REAL FFD Discharge Stats modal (30-day history + 14-day
  // regression + GeoGLOWS overlay, incl. the GeoGLOWS horizon table) for
  // THIS station — same "reuse the real modal, update it in place as the
  // tour advances" pattern _showTempStationPopup already uses for the real
  // heatwave stats modal in Chapter 2 (hopping station-to-station reads as
  // one panel updating, not a stack of new ones). Kicked off here but only
  // AWAITED further down (after the on-map popup below has already shown),
  // so the popup itself never waits on the modal's own network fetches.
  const modalReady = (async () => {
    try {
      await showFfdModalForStation({
        name: wp.name,
        province: wp.province || "",
        status: props.status || "",
        outflow: props.outflow_discharge ?? props.discharge ?? "n/a",
        inflow: props.inflow_discharge ?? "n/a",
        lat: wp.center?.[1],
        lon: wp.center?.[0],
      });
    } catch (_) { /* best-effort — a modal hiccup must never crash playback */ }
  })();

  const { primary, drawer } = buildFfdPopupContent(props);
  const near = _nearestPrecipSample(wp, scene.precipSamples || _state.topPrecipDistricts);
  const precipNote = near
    ? `<div class="dwrp-live-note">Nearby forecast: ${_hlNum(`${near.name} — ${near.mm} ${near.unit}`)}</div>`
    : "";
  _presentPopup(`
    <div class="ncop-popup__primary">
      <div class="ncop-popup__primary-content">${primary}</div>
    </div>
    <div class="ncop-popup__body-scroll">
      ${drawer}
      <div class="dwrp-body">
        ${_captionHtml(scene.caption)}
        ${precipNote}
      </div>
    </div>
  `);

  // Best-effort: never let a graph-rendering hiccup break scene playback.
  try {
    setupFfdPopupEventHandlers();
    const graphBtn = _state.popupEl?.querySelector(".show-ffd-graph");
    if (graphBtn) graphBtn.click();
  } catch (_) {}

  // AWAITED (bounded) — the caller (_runFfdBarrage) awaits this whole
  // function, and _gotoScene's auto-advance timer only starts once scene
  // entry fully resolves (see _gotoScene), so the barrage scene now holds
  // on this station until its FFD Discharge Stats modal has actually
  // finished loading and rendering its chart — capped at
  // FFD_MODAL_LOAD_TIMEOUT_MS so an unreachable upstream can't stall the
  // story indefinitely.
  await _awaitBounded(modalReady, FFD_MODAL_LOAD_TIMEOUT_MS);
  if (_isStale(token, seq)) return;
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
  _speak(_tr(scene.caption) || "");
  if (!map) { await wait(2000); return; }

  try {
    if (scene.kind === "intro") {
      await _runIntro(map, token, seq);
    } else if (scene.kind === "radar") {
      await _runRadar(map, token, seq);
    } else if (scene.kind === "station") {
      if (_isStale(token, seq)) return;
      const prevKind = _state.scenes[_state.index - 1]?.kind;
      if (prevKind === "radar" || prevKind === "province-overview") {
        // The radar layer itself stays ON — _playTemporalLoop already
        // paused it at its current frame the moment this scene became
        // active (its own staleness check). Only the popup content swaps.
        _closePopup();
        await wait(320);
      }
      // Only turn observations on once, entering the station-tour phase —
      // not on every single station-to-station hop within the tour.
      if (prevKind !== "station" && prevKind !== "province-overview") await _ensureObservationsOn();
      if (_isStale(token, seq)) return;
      await _runStation(map, scene, token, seq);
    } else if (scene.kind === "province-overview") {
      if (_isStale(token, seq)) return;
      _closePopup();
      await wait(320);
      if (_isStale(token, seq)) return;
      await _runProvinceOverview(map, scene, token, seq);
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
      if (prevKind !== "temp-station") await _ensureHeatwaveLayerOn();
      if (_isStale(token, seq)) return;
      await _runTempStation(map, scene, token, seq);
    } else if (scene.kind === "temp-weekly") {
      if (_isStale(token, seq)) return;
      await _runTempWeekly(map, scene, token, seq);
    } else if (scene.kind === "temp-assessment") {
      if (_isStale(token, seq)) return;
      await _runTempAssessment(map);
    } else if (scene.kind === "ch3-intro") {
      await _runChapter3Intro(map, token, seq);
    } else if (scene.kind === "precip-layer") {
      await _runPrecipLayer(map, token, seq);
    } else if (scene.kind === "precip-district") {
      if (_isStale(token, seq)) return;
      const prevKind = _state.scenes[_state.index - 1]?.kind;
      if (prevKind === "precip-layer") {
        // Same pattern as every other layer->station handoff in this file
        // — the layer stays ON (paused at its current frame), only the
        // popup content swaps.
        _closePopup();
        await wait(320);
      }
      await _runPrecipDistrict(map, scene, token, seq);
    } else if (scene.kind === "precip-province-overview") {
      if (_isStale(token, seq)) return;
      const prevKind = _state.scenes[_state.index - 1]?.kind;
      if (prevKind === "precip-layer" || prevKind === "precip-district") {
        // Same layer-stays-on, popup-swaps handoff every other scene
        // transition in this chapter already uses.
        _closePopup();
        await wait(320);
      }
      await _runPrecipProvinceOverview(map, scene, token, seq);
    } else if (scene.kind === "precip-assessment") {
      if (_isStale(token, seq)) return;
      await _runPrecipAssessment(map);
    } else if (scene.kind === "ffd-intro") {
      if (_isStale(token, seq)) return;
      await _runFfdIntro(map, token, seq);
    } else if (scene.kind === "ffd-routing-map") {
      if (_isStale(token, seq)) return;
      await _runFfdRoutingMap(map, token, seq);
    } else if (scene.kind === "ffd-barrage") {
      if (_isStale(token, seq)) return;
      await _runFfdBarrage(map, scene, token, seq);
    } else if (scene.kind === "ffd-river-overview") {
      if (_isStale(token, seq)) return;
      await _runFfdRiverOverview(map, scene, token, seq);
    } else if (scene.kind === "ffd-assessment") {
      if (_isStale(token, seq)) return;
      await _runFfdAssessment(map);
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
  const timerEl = card.querySelector(".dwr-progress-timer");
  if (timerEl) timerEl.textContent = "0.0s";
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
  const timerEl = card.querySelector(".dwr-progress-timer");
  const totalSec = dwellMs / 1000;
  const start = performance.now();

  // Small "3.2s / 8.0s" readout next to the bar — makes the actual step
  // duration visible instead of just an abstract fill percentage. Both
  // the bar and the displayed seconds are clamped at the allotted total —
  // if TTS runs long (advanceOrRecheck below keeps polling past dwellMs),
  // this holds at "45.0s / 45.0s" rather than counting past it, since the
  // allotted time is exactly that: a ceiling, not a live stopwatch.
  const tickProgress = () => {
    if (_isStale(token, seq) || !_state.isPlaying) return;
    const elapsedMs = Math.min(performance.now() - start, dwellMs);
    const pct = (elapsedMs / dwellMs) * 100;
    if (fill) fill.style.width = `${pct}%`;
    if (timerEl) timerEl.textContent = `${(elapsedMs / 1000).toFixed(1)}s / ${totalSec.toFixed(1)}s`;
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
// `forceRefresh` — true ONLY when the operator clicks the new Refresh
// button (_handleRefreshClick). On a normal story open (_show(), which
// fires every time "Dynamic Weather Report" is (re)selected, including a
// full restart back to Chapter 1), this reuses whatever was already
// fetched earlier THIS SESSION — see _state.baseDataLoadedOnce below —
// instead of re-hitting every API. The various sampling passes further
// downstream (Meteoblue weekly/hourly/temperature, the district-boundary
// candidate query, the bulk FFD 30-day history) already had their own
// "only once per session" guards from earlier work; forceRefresh now
// also resets THOSE, so Refresh genuinely re-fetches everything, not
// just this function's own upfront batch.
async function _loadAndPlay(card, forceRefresh = false) {
  const token = _state.runToken;

  if (forceRefresh) {
    _state.baseDataLoadedOnce = false;
    _state.meteoblueSampledOnce = false;
    _state.meteoblueTempSampledOnce = false;
    _state.districtBoundaryCandidatesComputed = false;
    _state.districtBoundaryCandidates = [];
    _state.ffdHistoryAllFetchedOnce = false;
    _state.ffdHistoryAllPromise = null;
    _state.ffdHistoryAll = null;
  }

  // A prior load's data is only trusted if it actually succeeded — a
  // failed/errored report never counts as "cached", so a transient
  // failure on first open doesn't get stuck forever; the very next
  // _show() call retries the real fetch exactly as before.
  const useCached = !forceRefresh && _state.baseDataLoadedOnce && _state.report && !_state.report.error;

  card.querySelector(".dwr-body").innerHTML = _loadingHtml(
    forceRefresh
      ? "Refreshing rainfall report, station observations, and every layer this story uses…"
      : "Loading rainfall report and station observations…"
  );
  card.querySelector(".dwr-chapter-title").textContent = "Dynamic Weather Report";
  card.querySelector(".dwr-chapter-counter").textContent = "";

  let report, observations, newsArticles;
  if (useCached) {
    report = _state.report;
    observations = _state.observations;
    newsArticles = _state.newsArticles;
  } else {
    let heatwaveStations, maxTempRecords, ffdStations, ffdRivers;
    try {
      [report, observations, newsArticles, heatwaveStations, maxTempRecords, ffdStations, ffdRivers] = await Promise.all([
        _fetchRainfallReport(),
        getNwfcObservations().catch(() => null),
        _fetchGdeltNews(), // best-effort — never rejects, resolves [] on any failure
        _fetchHeatwaveMonitoring(), // best-effort — resolves null on any failure
        _fetchMaxTempRecords(), // best-effort — resolves [] on any failure
        _fetchFfdStations(), // best-effort — resolves null on any failure
        getFfdRivers().catch(() => null), // best-effort — feeds the on-map catchment-polygon visual layer only, not the barrage-tour camera path (see _buildFfdWaypoints)
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
    _state.newsArticles = newsArticles || [];
    _state.heatwaveStations = heatwaveStations;
    _state.maxTempRecords = maxTempRecords || [];
    _state.ffdStations = ffdStations;
    _state.ffdRivers = ffdRivers;
    _state.baseDataLoadedOnce = true;
  }

  // Each chapter loads and confirms-displays ONLY its own layers, at its
  // own start, and tears down the previous chapter's — see _runIntro
  // (Chapter 1: DWD + NWFC observations), _runChapter2Intro (Chapter 2:
  // 2m Temperature + Heatwave Monitoring), and _runChapter3Intro
  // (Chapter 3: Meteoblue weekly (visual) + FFD/rivers + Meteoblue-for-values, the
  // last of which is also where Chapter 3's own scenes get built — see
  // _buildChapter3Scenes — since their district values depend on that
  // Meteoblue sampling pass having already run).
  _state.scenes = await _buildScenes(report, observations, newsArticles); // also sets _state.discussedDistricts / hottestStations
  if (token !== _state.runToken) return;
  _state.index = 0;
  _state.chapter3ScenesBuilt = false; // fresh load — Chapter 3's scenes get (re)built the next time ch3-intro is reached
  _state.chapter2WeeklyScenesBuilt = false; // fresh load — Chapter 2's weekly-outlook scene gets (re)built the next time ch2-intro is reached
  _setSpeed(1, 1); // fresh load always starts at normal forward speed, regardless of a prior session
  _prepareDistrictHighlight(_state.discussedDistricts);

  // Always muted at the start of every story run, no exceptions — never
  // reads/shows the old on/off preference prompt to decide the STARTING
  // state. The mute button itself, and toggling it mid-story, are
  // completely unchanged; this only forces the initial value.
  _state.ttsEnabled = false;
  _syncMuteButton(card);

  // Language prompt — shown only when this run involved a genuine fetch
  // (first-ever open, or after Refresh; useCached being true means this
  // is a plain reopen of already-loaded data, which never re-prompts —
  // see _showLangPrompt's own comment for why this differs from the
  // TTS decision above).
  if (!useCached) {
    const langChoice = await _showLangPrompt(card);
    if (token !== _state.runToken) return;
    _state.lang = langChoice;
    _saveLangPref(langChoice);
    _syncLangButton(card);
    if (langChoice === "ur") {
      // NOT awaited — translating a full report's worth of captions on
      // this CPU-only model can take well over a minute (a real 15-item
      // batch measured at ~105s). Blocking story start on that produced a
      // "frozen with zero feedback for 100+ seconds" experience. Instead:
      // play now (falls back to English via _tr()'s cache-miss no-op),
      // silently upgrade scene-by-scene as translations land.
      _ensureUrduTranslations(card).then((ok) => {
        if (ok && _state.lang === "ur") _reapplyCurrentSceneLanguage(card);
      }).catch(() => {});
    }
  }

  await _gotoScene(0, false);
  if (token !== _state.runToken) return;
  _play();
}

// Refresh button — the ONLY way to force a real re-fetch of every layer/
// API this story uses once they're cached (see _loadAndPlay's
// baseDataLoadedOnce check). Mirrors _hide()'s own teardown of whatever
// is currently on-screen (popup, modals, district/FFD overlays, active
// temporal layer) — same reasoning: a scene can be mid-flythrough or
// mid-orbit when this is clicked, and that must stop cleanly before
// reloading — but keeps the card itself visible and showing the loading
// state, rather than actually hiding it like a close would.
async function _handleRefreshClick(card) {
  const btn = card.querySelector(".dwr-refresh");
  if (btn?.disabled) return; // already refreshing — ignore a double-click
  if (btn) { btn.disabled = true; btn.classList.add("is-spinning"); }

  _state.runToken += 1; // invalidate whatever scene sequence is currently in flight
  _pause();
  _stopSpeaking();
  _closePopup();
  try { hideHeatwaveModal(); } catch (_) {}
  try { hideFfdModal(); } catch (_) {}
  _clearDistrictOverlay();
  _clearFfdHighlight();
  const map = window.ncop_map;
  if (map) { disableCinematicAtmosphere(map); disableRainEffect(map); _deactivateTemporalLayer(map, _state.activeLayerKey); }

  try {
    await _loadAndPlay(card, /*forceRefresh*/ true);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("is-spinning"); }
  }
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
  try { hideHeatwaveModal(); } catch (_) {}
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
  try { hideHeatwaveModal(); } catch (_) {}
  _removePopup();
  _clearDistrictOverlay();
  const map = window.ncop_map;
  if (map) { disableCinematicAtmosphere(map); disableRainEffect(map); _deactivateTemporalLayer(map, _state.activeLayerKey); }
}

// Public hook for an external "close everything" control (the story
// panel's own X button) — unlike _hide() above, this does NOT call
// window.ncopProvincialForecast?.restore() afterward, since a full close
// should leave BOTH stories stopped, not resurrect the other one. Reuses
// _teardown()'s existing cleanup exactly; only adds the display/visibility
// bookkeeping _hide() also does.
function _closeCompletely() {
  _teardown();
  const root = document.getElementById(ROOT_ID);
  const card = root?.querySelector(`#${CARD_ID}`);
  if (card) card.style.display = "none";
  const chaptersEl = root?.querySelector("#storyChapters");
  if (chaptersEl) chaptersEl.style.display = "grid";
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

// Public control surface — mirrors window.ncopProvincialForecast's own
// pattern. `closeAll` is used by the story panel's X button (wired in
// navigation-panel.js) to fully stop this story regardless of whether it
// was the active one, without the cross-story restore _hide() otherwise
// triggers on close.
window.ncopDynamicWeather = {
  closeAll: _closeCompletely,
};

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
