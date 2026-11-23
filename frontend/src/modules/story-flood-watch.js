// ==========================================================================
// story-flood-watch.js
// --------------------------------------------------------------------------
// National Flood Watch — a cinematic story selectable from #storySelect,
// next to "7-Day Weather Outlook", "Dynamic Weather Report" and "National
// Air Quality Watch". Same integration and playback model as those:
// injected sentinel <option> (re-injected by a MutationObserver), capture-
// phase "change" listener, the 7-Day Outlook paused via
// window.ncopProvincialForecast, a card in #story-root with play/pause,
// prev/next, FF/RW, scene dots, optional narration and Urdu captions.
// The playback engine is the same one story-air-quality-watch.js uses; no
// state is shared with any other story.
//
// CHAPTER 1 — Rivers Now (FFD): the barrage/dam beats that used to close
//   the Dynamic Weather Report, moved here unchanged in behaviour (river-
//   by-river tour along the FFD routing graph, free-camera flights between
//   stations, the real FFD popup + FFD Discharge Stats modal, the routing-
//   map reference, river overviews, assessment), plus network infographics
//   built from the live feed (season peak, trends, travel times).
// CHAPTER 2 — 15-Day Outlook (CEMS GloFAS via IWMI): temporal layer
//   iwmi_glofas_forecast_days, per-day alert counts, "headroom" (forecast
//   peak as a share of each point's warning threshold) and a tour of the
//   points closest to their thresholds, cross-checked against the nearest
//   FFD station.
// CHAPTER 3 — AI River Forecasts (Google Flood Hub via IWMI): gauges
//   (iwmi_floodhub_gauges) with severity, trend and discharge forecast
//   charts, and modelled inundation (iwmi_floodhub_inundation).
// CHAPTER 4 — Why Pakistan floods and the national assessment: research
//   context (33 peer-reviewed papers + 2 official reports, see REFS) and a
//   combined watch level from all three systems; every IWMI layer and FFD
//   on together (incl. iwmi_glofas_points).
//
// Data: GET /api/iwmi/watch/?iso3=PAK (iwmi_flood_client.flood_watch —
// built from the cached IWMI endpoints) and the GCOP FFD feeds the
// ffd_data layer already uses. Every figure is computed from live data;
// research statements cite only verified findings.
// ==========================================================================

import { handleTemporalInteraction } from "./mapbox-functions.js";
import { getFfdWaterlevels, getFfdHistoryAll } from "./gcop-api-cache.js";
import { buildFfdPopupContent, setupFfdPopupEventHandlers } from "./layer-attribute-popup.js";
import { showFfdModalForStation, hideFfdModal, refitFfdModal } from "./ffd-stats-modal.js";
import { legends as TEMPORAL_LEGENDS } from "./temporal-layer-legends.js";
import { ffdFloodLimitsFor, ffdLimitTier, ffdSpillState } from "./ffd-flood-limits.js";
import {
  wait,
  cinematicFlyTo,
  cinematicEaseTo,
  cinematicFitBounds,
  fadeLayerOpacity,
  enableCinematicAtmosphere,
  disableCinematicAtmosphere,
  orbitAroundPoint,
  flyAlongPath,
} from "./story-cinematic-engine.js";
import { mountExportButton, runStoryExport, captureMap, scenesToSections, notifyCard } from "./story-report-export.js";

const MODAL_ID  = "story-modal";
const ROOT_ID   = "story-root";
const SELECT_ID = "storySelect";
const SENTINEL  = "__flood_watch__";
const LABEL     = "National Flood Watch";
// Other cinematic stories: switching straight to one of them must not
// resurrect the 7-Day Outlook (they hide it themselves).
const OTHER_STORY_SENTINELS = ["__dynamic_weather__", "__air_quality_watch__", "__food_security_watch__"];
const CARD_ID   = "ncop-flood-watch";
const POPUP_ID  = "ncop-flood-watch-popup";
const STYLE_ID  = "ncop-flood-watch-style";

const FFD_KEY         = "ffd_data";
const GLOFAS_DAYS_KEY = "iwmi_glofas_forecast_days";
const GLOFAS_PTS_KEY  = "iwmi_glofas_points";
const FH_GAUGES_KEY   = "iwmi_floodhub_gauges";
const FH_INUND_KEY    = "iwmi_floodhub_inundation";
const STORY_TOGGLES   = [FFD_KEY, GLOFAS_PTS_KEY, FH_GAUGES_KEY, FH_INUND_KEY];
const WATCH_URL = "/api/iwmi/watch/?iso3=PAK";
const FH_DISCHARGE_URL = (id) => `/api/iwmi/floodhub/gauges/${encodeURIComponent(id)}/discharge/`;
// Vite-bundled static asset (same pattern the Dynamic Weather Report used).
const FLOOD_ROUTING_MAP_SRC = new URL("../assets/images/ffd_flood_routing/flood_routing_map.png", import.meta.url).href;

// Focus overlay: the story's own GeoJSON source of "points in focus"
// (stations, GloFAS points, gauges), blinking on top of every layer — so
// highlighting never depends on another module's source ids.
const FOCUS_SRC     = "_ncop_nfw_focus";
const FOCUS_HALO_ID = "_ncop_nfw_focus_halo";
const FOCUS_RING_ID = "_ncop_nfw_focus_ring";

const PAKISTAN_CENTER = [70.2, 30.2];
const REGIONAL_START  = { center: [78, 22], zoom: 3.0, pitch: 0, bearing: 0 };
const PAKISTAN_BOUNDS = [[60.8, 23.6], [77.9, 37.1]];
const INDUS_PLAIN     = [70.6, 29.2];

const CUSECS_PER_M3S = 35.3147;
const GLOFAS_TOUR_MAX = 3;
const FH_TOUR_MAX = 3;
const CROSSCHECK_KM = 60;
const DWELL_MS_NO_TTS = 6500;
const SPEED_LEVELS = [1, 2, 3, 4, 5];
const FRAME_STEP_MS = 1300;
const FFD_MODAL_LOAD_TIMEOUT_MS = 15000;
const FH_SERIES_TIMEOUT_MS = 9000;

// Official palettes: FFD's own six tiers (ffd_data-circle in map-layers.js)
// and the four-class GloFAS / Flood Hub colours (iwmi-flood-layers.js).
const FFD_TIERS = [
  { key: "normal",    label: "Normal flow",              color: "#28a745", rank: 0 },
  { key: "low",       label: "Low flood",                color: "#17a2b8", rank: 1 },
  { key: "medium",    label: "Medium flood",             color: "#ffc107", rank: 2 },
  { key: "high",      label: "High flood",               color: "#fd7e14", rank: 3 },
  { key: "very_high", label: "Very high flood",          color: "#dc3545", rank: 4 },
  { key: "ex_high",   label: "Exceptionally high flood", color: "#6f42c1", rank: 5 },
];
const GLOFAS_LEVELS = [
  { key: "normal",  label: "Normal",  color: "#3FA34D", rank: 0 },
  { key: "warning", label: "Warning", color: "#E7B416", rank: 2 },
  { key: "danger",  label: "Severe",  color: "#E2683C", rank: 3 },
  { key: "extreme", label: "Extreme", color: "#640000", rank: 4 },
];
const FH_LEVELS = [
  { key: "NO_FLOODING",  label: "No flooding",  color: "#3FA34D", rank: 0 },
  { key: "ABOVE_NORMAL", label: "Above normal", color: "#E7B416", rank: 2 },
  { key: "SEVERE",       label: "Severe",       color: "#E2683C", rank: 3 },
  { key: "EXTREME",      label: "Extreme",      color: "#640000", rank: 4 },
];
// Combined national watch level (max over the three systems).
const WATCH_LEVELS = [
  { label: "Normal",   color: "#22c55e", action: "Routine monitoring: keep daily FFD bulletins, GloFAS runs and Flood Hub gauges under review." },
  { label: "Elevated", color: "#17a2b8", action: "Watch: confirm readings with FFD, brief PDMAs on the rivers showing low-flood flows, and check embankment and barrage gate readiness." },
  { label: "Alert",    color: "#E7B416", action: "Alert: issue advisories for the affected river reaches, pre-position response stocks and verify evacuation routes in low-lying districts." },
  { label: "Warning",  color: "#E2683C", action: "Warning: activate district emergency operations, warn communities along the forecast reaches and prepare evacuations." },
  { label: "Severe",   color: "#640000", action: "Severe: evacuate the forecast flood plains, mobilise national response and coordinate barrage operations with IRSA and provincial irrigation departments." },
];

// ---- Research base (verified) ---------------------------------------------
const REFS = {
  nanditha2023: { cite: "Nanditha et al., 2023", full: "Nanditha, J. S., et al. (2023). The Pakistan flood of August 2022: Causes and implications. Earth's Future, 11(3), e2022EF003230." },
  otto2023: { cite: "Otto et al., 2023", full: "Otto, F. E. L., et al. (2023). Climate change increased extreme monsoon rainfall, flooding highly vulnerable communities in Pakistan. Environmental Research: Climate, 2, 025001." },
  pdna2022: { cite: "PDNA, 2022", full: "Government of Pakistan, ADB, EU, UN & World Bank (2022). Pakistan Floods 2022: Post-Disaster Needs Assessment (PDNA). Ministry of Planning, Development & Special Initiatives." },
  houze2011: { cite: "Houze et al., 2011", full: "Houze, R. A., Rasmussen, K. L., Medina, S., Brodzik, S. R., & Romatschke, U. (2011). Anomalous atmospheric events leading to the summer 2010 floods in Pakistan. Bulletin of the American Meteorological Society, 92(3), 291–298." },
  webster2011: { cite: "Webster et al., 2011", full: "Webster, P. J., Toma, V. E., & Kim, H.-M. (2011). Were the 2010 Pakistan floods predictable? Geophysical Research Letters, 38." },
  lau2012: { cite: "Lau & Kim, 2012", full: "Lau, W. K. M., & Kim, K.-M. (2012). The 2010 Pakistan flood and Russian heat wave: Teleconnection of hydrometeorologic extremes. Journal of Hydrometeorology, 13, 392–403." },
  syvitski2013: { cite: "Syvitski & Brakenridge, 2013", full: "Syvitski, J. P. M., & Brakenridge, G. R. (2013). Causation and avoidance of catastrophic flooding along the Indus River, Pakistan. GSA Today, 23(1), 4–10." },
  tariq2012: { cite: "Tariq & van de Giesen, 2012", full: "Tariq, M. A. U. R., & van de Giesen, N. (2012). Floods and flood management in Pakistan. Physics and Chemistry of the Earth, 47–48, 11–20." },
  alfieri2013: { cite: "Alfieri et al., 2013", full: "Alfieri, L., et al. (2013). GloFAS – global ensemble streamflow forecasting and flood early warning. Hydrology and Earth System Sciences, 17, 1161–1175." },
  harrigan2020: { cite: "Harrigan et al., 2020", full: "Harrigan, S., et al. (2020). GloFAS-ERA5 operational global river discharge reanalysis 1979–present. Earth System Science Data, 12, 2043–2060." },
  harrigan2023: { cite: "Harrigan et al., 2023", full: "Harrigan, S., et al. (2023). Daily ensemble river discharge reforecasts and real-time forecasts from the operational Global Flood Awareness System. Hydrology and Earth System Sciences, 27, 1–19." },
  emerton2016: { cite: "Emerton et al., 2016", full: "Emerton, R. E., et al. (2016). Continental and global scale flood forecasting systems. WIREs Water, 3(3), 391–418." },
  cloke2009: { cite: "Cloke & Pappenberger, 2009", full: "Cloke, H. L., & Pappenberger, F. (2009). Ensemble flood forecasting: A review. Journal of Hydrology, 375, 613–626." },
  wu2020: { cite: "Wu et al., 2020", full: "Wu, W., et al. (2020). Ensemble flood forecasting: Current status and future opportunities. WIREs Water, 7(3), e1432." },
  nearing2024: { cite: "Nearing et al., 2024", full: "Nearing, G., et al. (2024). Global prediction of extreme floods in ungauged watersheds. Nature, 627, 559–563." },
  nevo2022: { cite: "Nevo et al., 2022", full: "Nevo, S., et al. (2022). Flood forecasting with machine learning models in an operational framework. Hydrology and Earth System Sciences, 26, 4013–4032." },
  pappenberger2015: { cite: "Pappenberger et al., 2015", full: "Pappenberger, F., Cloke, H. L., Parker, D. J., Wetterhall, F., Richardson, D. S., & Thielen, J. (2015). The monetary benefit of early flood warnings in Europe. Environmental Science & Policy, 51, 278–291." },
  coughlan2015: { cite: "Coughlan de Perez et al., 2015", full: "Coughlan de Perez, E., et al. (2015). Forecast-based financing: an approach for catalyzing humanitarian action based on extreme weather and climate forecasts. Natural Hazards and Earth System Sciences, 15, 895–904." },
  immerzeel2010: { cite: "Immerzeel et al., 2010", full: "Immerzeel, W. W., van Beek, L. P. H., & Bierkens, M. F. P. (2010). Climate change will affect the Asian water towers. Science, 328, 1382–1385." },
  immerzeel2020: { cite: "Immerzeel et al., 2020", full: "Immerzeel, W. W., et al. (2020). Importance and vulnerability of the world's water towers. Nature, 577, 364–369." },
  lutz2014: { cite: "Lutz et al., 2014", full: "Lutz, A. F., Immerzeel, W. W., Shrestha, A. B., & Bierkens, M. F. P. (2014). Consistent increase in High Asia's runoff due to increasing glacier melt and precipitation. Nature Climate Change, 4, 587–592." },
  archer2004: { cite: "Archer & Fowler, 2004", full: "Archer, D. R., & Fowler, H. J. (2004). Spatial and temporal variations in precipitation in the Upper Indus Basin, global teleconnections and hydrological implications. Hydrology and Earth System Sciences, 8, 47–61." },
  hewitt2005: { cite: "Hewitt, 2005", full: "Hewitt, K. (2005). The Karakoram anomaly? Glacier expansion and the 'elevation effect', Karakoram Himalaya. Mountain Research and Development, 25(4), 332–340." },
  farinotti2020: { cite: "Farinotti et al., 2020", full: "Farinotti, D., Immerzeel, W. W., de Kok, R., Quincey, D. J., & Dehecq, A. (2020). Manifestations and mechanisms of the Karakoram glacier Anomaly. Nature Geoscience, 13, 8–16." },
  zheng2021: { cite: "Zheng et al., 2021", full: "Zheng, G., et al. (2021). Increasing risk of glacial lake outburst floods from future Third Pole deglaciation. Nature Climate Change, 11, 411–417." },
  hunt2018: { cite: "Hunt et al., 2018", full: "Hunt, K. M. R., Turner, A. G., & Shaffrey, L. C. (2018). The evolution, seasonality and impacts of western disturbances. Quarterly Journal of the Royal Meteorological Society, 144, 278–290." },
  dimri2015: { cite: "Dimri et al., 2015", full: "Dimri, A. P., et al. (2015). Western Disturbances: A review. Reviews of Geophysics, 53, 225–246." },
  trenberth2003: { cite: "Trenberth et al., 2003", full: "Trenberth, K. E., Dai, A., Rasmussen, R. M., & Parsons, D. B. (2003). The changing character of precipitation. Bulletin of the American Meteorological Society, 84, 1205–1217." },
  fowler2021: { cite: "Fowler et al., 2021", full: "Fowler, H. J., et al. (2021). Anthropogenic intensification of short-duration rainfall extremes. Nature Reviews Earth & Environment, 2, 107–122." },
  ipcc2021: { cite: "IPCC AR6, 2021", full: "Seneviratne, S. I., et al. (2021). Weather and climate extreme events in a changing climate. In Climate Change 2021: The Physical Science Basis (IPCC AR6 WG1), Chapter 11. Cambridge University Press." },
  hirabayashi2013: { cite: "Hirabayashi et al., 2013", full: "Hirabayashi, Y., et al. (2013). Global flood risk under climate change. Nature Climate Change, 3, 816–821." },
  dottori2018: { cite: "Dottori et al., 2018", full: "Dottori, F., et al. (2018). Increased human and economic losses from river flooding with anthropogenic warming. Nature Climate Change, 8, 781–786." },
  alfieri2017: { cite: "Alfieri et al., 2017", full: "Alfieri, L., et al. (2017). Global projections of river flood risk in a warmer world. Earth's Future, 5, 171–182." },
  tellman2021: { cite: "Tellman et al., 2021", full: "Tellman, B., et al. (2021). Satellite imaging reveals increased proportion of population exposed to floods. Nature, 596, 80–86." },
  rentschler2022: { cite: "Rentschler et al., 2022", full: "Rentschler, J., Salhab, M., & Jafino, B. A. (2022). Flood exposure and poverty in 188 countries. Nature Communications, 13, 3527." },
};
function _cite(...ids) {
  return ids.map((id) => REFS[id]?.cite).filter(Boolean).join("; ");
}

let _wired = false;
let _optionObserver = null;

const _state = {
  active: false,
  isPlaying: false,
  ttsEnabled: false,
  runToken: 0,
  sceneSeq: 0,
  scenes: [],
  index: 0,
  digest: null,         // /api/iwmi/watch/ payload (null if unavailable)
  ffd: null,            // live FFD waterlevels FeatureCollection (null if unavailable)
  waypoints: [],        // FFD stations in routing order, each with .reading
  loadedOnce: false,
  popupEl: null,
  tickTimer: null,
  progRaf: null,
  blinkTimer: null,
  blinkPhase: false,
  speed: 1,
  direction: 1,
  pendingMinDwellMs: 0,
  lang: "en",
  layerChapter: 0,
  activeLayerKey: null,
  loaderTimer: null,
  toggledOn: new Set(), // toggles this story switched on (only these are switched off again)
  fhSeries: new Map(),  // gauge id -> discharge payload (or null)
};

// ---- Small helpers ----------------------------------------------------------
function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const HIGHLIGHT_RE = /(\d[\d,]*(?:\.\d+)?\s?(?:cusecs|m³\/s|%|×|h\b|km\b|days?\b|years?\b|million\b|billion\b))/g;
function _hl(escaped) {
  return String(escaped || "").replace(HIGHLIGHT_RE, '<mark class="nfw-hl">$1</mark>');
}
function _r(v, d = 0) {
  return Number.isFinite(v) ? Number(v).toFixed(d) : "—";
}
function _fmt(v, d = 0) {
  return Number.isFinite(v) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—";
}
function _u(value, unit) {
  return `${value}<small class="nfwp-u">${_esc(unit)}</small>`;
}
function _pct(share, d = 0) {
  return Number.isFinite(share) ? `${(share * 100).toFixed(d)}%` : "—";
}
function _num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function _toCusecs(m3s) {
  return Number.isFinite(m3s) ? m3s * CUSECS_PER_M3S : null;
}
function _shortDay(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}
function _pkt(iso, withDay = true) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: false,
    ...(withDay ? { weekday: "short", day: "2-digit", month: "short" } : {}),
  }) + " PKT";
}
function _joinList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
function _kmBetween(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function _dur(ms) {
  return Math.max(150, ms / (_state.speed || 1));
}
function _isStale(token, seq) {
  return token !== _state.runToken || seq !== _state.sceneSeq;
}
function _awaitBounded(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    Promise.resolve(promise).then(finish, () => finish(undefined));
    setTimeout(() => finish(undefined), ms);
  });
}
function _textOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return "#fff";
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#111" : "#fff";
}
// Season from the PKT month — drives the "is a quiet board expected?" context.
function _season(date = new Date()) {
  const m = Number(date.toLocaleString("en-GB", { timeZone: "Asia/Karachi", month: "numeric" })) - 1;
  if (m >= 6 && m <= 8) return "monsoon";
  if (m === 5) return "pre-monsoon";
  if (m >= 2 && m <= 4) return "melt";
  return "low-flow";
}

// ==========================================================================
// Playback / UI engine — same as story-air-quality-watch.js (narration,
// Urdu captions, styles, card controls, loader, popup shell, temporal
// layer control, transport, #storySelect integration).
// ==========================================================================
// ---- Narration (speechSynthesis) + Urdu captions ---------------------------
let _voicesCache = null;
try {
  const ss = window.speechSynthesis;
  if (ss) {
    _voicesCache = ss.getVoices();
    if (!_voicesCache.length) ss.addEventListener("voiceschanged", () => { _voicesCache = ss.getVoices(); }, { once: true });
  }
} catch (_) {}

function _pickUrduVoice() {
  const voices = (_voicesCache && _voicesCache.length) ? _voicesCache : (window.speechSynthesis?.getVoices() || []);
  return voices.find((v) => /^ur[-_]?/i.test(v.lang)) || voices.find((v) => /^ar/i.test(v.lang)) || null;
}

function _speak(text) {
  try {
    if (!_state.ttsEnabled || !window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Math.min(3, 0.98 * (_state.speed || 1));
    if (_state.lang === "ur") {
      u.lang = "ur-PK";
      const v = _pickUrduVoice();
      if (v) u.voice = v;
    }
    window.speechSynthesis.speak(u);
  } catch (_) { /* narration is optional */ }
}

function _stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch (_) {}
}

// Same localStorage key the other two stories use, so the language choice
// is shared across briefings.
const LANG_PREF_KEY = "ncop-story-lang-pref";

function _loadLangPref() {
  try { return localStorage.getItem(LANG_PREF_KEY) === "ur" ? "ur" : "en"; } catch (_) { return "en"; }
}

function _saveLangPref(lang) {
  try { localStorage.setItem(LANG_PREF_KEY, lang); } catch (_) {}
}

const _translationCache = new Map();

function _tr(text) {
  if (_state.lang !== "ur") return text;
  return _translationCache.get(text) ?? text;
}

const TRANSLATE_CHUNK_SIZE = 16;

let _translateInFlight = null;

async function _translateBatch(texts) {
  const res = await fetch("/api/translate/", {
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

function _ensureUrduTranslations(card) {
  if (_translateInFlight) return _translateInFlight;
  const missing = Array.from(new Set(_state.scenes.map((s) => s.caption).filter(Boolean)))
    .filter((t) => !_translationCache.has(t));
  if (!missing.length) return Promise.resolve(true);
  card?.querySelector(".nfw-lang")?.classList.add("is-loading");
  _translateInFlight = (async () => {
    let ok = false;
    for (let i = 0; i < missing.length; i += TRANSLATE_CHUNK_SIZE) {
      const chunk = missing.slice(i, i + TRANSLATE_CHUNK_SIZE);
      try {
        const out = await _translateBatch(chunk);
        chunk.forEach((t, j) => _translationCache.set(t, out[j]));
        ok = true;
      } catch (e) {
        console.warn("[flood-watch] Urdu translation chunk failed:", e);
      }
    }
    return ok;
  })().finally(() => {
    card?.querySelector(".nfw-lang")?.classList.remove("is-loading");
    _translateInFlight = null;
  });
  return _translateInFlight;
}

function _reapplyLanguage(card) {
  _renderScene(card);
  const scene = _state.scenes[_state.index];
  if (scene) _speak(_tr(scene.caption));
}

function _showLangPrompt(card) {
  return new Promise((resolve) => {
    const body = card.querySelector(".nfw-body");
    if (!body) { resolve("en"); return; }
    const last = _loadLangPref();
    body.innerHTML = `
      <div class="nfw-prompt" role="dialog" aria-labelledby="nfw-lang-title">
        <div class="nfw-prompt-icon" aria-hidden="true">🌐</div>
        <div id="nfw-lang-title" class="nfw-prompt-title">Choose a Language</div>
        <div class="nfw-prompt-desc">Language for this briefing's narrative text and voice narration. You can switch anytime from the header.</div>
        <div class="nfw-prompt-buttons">
          <button type="button" class="nfw-prompt-btn${last === "en" ? " is-primary" : ""}" data-choice="en">English</button>
          <button type="button" class="nfw-prompt-btn${last === "ur" ? " is-primary" : ""}" data-choice="ur">اردو</button>
        </div>
      </div>`;
    const onClick = (e) => {
      const b = e.target.closest("[data-choice]");
      if (!b) return;
      body.removeEventListener("click", onClick);
      resolve(b.dataset.choice === "ur" ? "ur" : "en");
    };
    body.addEventListener("click", onClick);
  });
}

// ---- Styles ---------------------------------------------------------------
function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${CARD_ID} {
      margin: 0 0 12px; padding: 12px 14px;
      background: linear-gradient(135deg, rgba(56, 189, 248, 0.18), rgba(20, 184, 166, 0.06));
      border: 1px solid rgba(56, 189, 248, 0.38);
      border-radius: 10px; color: #eaeaea; font-size: 12.5px; line-height: 1.5;
    }
    #${CARD_ID} .nfw-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    #${CARD_ID} .nfw-title {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #7dd3fc;
    }
    #${CARD_ID} .nfw-live {
      width: 7px; height: 7px; border-radius: 50%; background: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.3); animation: nfw-pulse 1.6s ease-in-out infinite;
    }
    @keyframes nfw-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.7); } }
    #${CARD_ID} .nfw-head-actions { display: flex; align-items: center; gap: 6px; }
    #${CARD_ID} .nfw-icon-btn {
      appearance: none; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; font-size: 12px; line-height: 1;
      color: rgba(234, 234, 234, 0.65); background: rgba(255, 255, 255, 0.06); border-radius: 999px;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${CARD_ID} .nfw-icon-btn:hover { background: rgba(56, 189, 248, 0.28); color: #fff; }
    #${CARD_ID} .nfw-close:hover { background: rgba(220, 38, 38, 0.25); }
    #${CARD_ID} .nfw-mute.is-muted { color: rgba(234, 234, 234, 0.35); }
    #${CARD_ID} .nfw-refresh:disabled { opacity: 0.6; cursor: default; }
    #${CARD_ID} .nfw-refresh.is-spinning svg { animation: nfw-spin 0.9s linear infinite; }
    #${CARD_ID} .nfw-lang {
      appearance: none; cursor: pointer; padding: 3px 9px; border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.06);
      font-size: 10.5px; font-weight: 600; line-height: 1; color: rgba(234, 234, 234, 0.8);
    }
    #${CARD_ID} .nfw-lang.is-active { background: rgba(56, 189, 248, 0.3); color: #fff; }
    #${CARD_ID} .nfw-lang.is-loading { opacity: 0.55; pointer-events: none; }
    .nfw-lang-ur {
      direction: rtl; text-align: right;
      font-family: "Noto Nastaliq Urdu", "Segoe UI", Tahoma, "Noto Naskh Arabic", sans-serif;
      font-size: 1.05em; line-height: 1.9;
    }
    #${CARD_ID} .nfw-chapter-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    #${CARD_ID} .nfw-chapter-title { font-size: 14px; font-weight: 800; color: #fff; }
    #${CARD_ID} .nfw-chapter-counter { font-size: 10.5px; color: rgba(234, 234, 234, 0.55); white-space: nowrap; font-variant-numeric: tabular-nums; }
    #${CARD_ID} .nfw-body { min-height: 40px; }
    #${CARD_ID} .nfw-status { display: flex; align-items: center; gap: 8px; padding: 12px 4px; font-size: 12px; color: rgba(234, 234, 234, 0.85); }
    #${CARD_ID} .nfw-spinner {
      width: 13px; height: 13px; border-radius: 50%; flex: 0 0 auto;
      border: 2px solid rgba(56, 189, 248, 0.25); border-top-color: #38bdf8; animation: nfw-spin 0.8s linear infinite;
    }
    @keyframes nfw-spin { to { transform: rotate(360deg); } }
    #${CARD_ID} .nfw-caption { font-size: 12.5px; line-height: 1.6; animation: nfw-in 0.5s ease; }
    @keyframes nfw-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    #${CARD_ID} mark.nfw-hl, #${POPUP_ID} mark.nfw-hl {
      background: rgba(56, 189, 248, 0.24); color: #fff; font-weight: 800;
      padding: 0 4px; border-radius: 4px; -webkit-box-decoration-break: clone; box-decoration-break: clone;
    }
    #${CARD_ID} .nfw-facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    #${CARD_ID} .nfw-pill {
      font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px;
      background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12);
    }
    #${CARD_ID} .nfw-pill.is-alert { background: rgba(220, 38, 38, 0.18); border-color: rgba(248, 113, 113, 0.4); color: #fca5a5; }
    #${CARD_ID} .nfw-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
    #${CARD_ID} .nfw-legend { margin-top: 8px; padding: 8px 9px; border-radius: 8px;
      background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255, 255, 255, 0.08); display: grid; gap: 8px; }
    #${CARD_ID} .nfw-legend-title { font-size: 10.5px; font-weight: 700; color: #eaeaea; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    #${CARD_ID} .nfw-legend-title small { font-weight: 400; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .nfw-legend-kind { font-size: 8.5px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
      padding: 1px 6px; border-radius: 999px; background: rgba(56, 189, 248, 0.22); color: #bae6fd; }
    #${CARD_ID} .nfw-legend-scale { padding: 0 2px 12px; }
    #${CARD_ID} .nfw-legend-scale .ts-legend-stack { width: 100%; }
    #${CARD_ID} .nfw-legend-scale .ts-legend-values span { font-size: 9px; white-space: nowrap; }
    #${CARD_ID} .nfw-steps { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; }
    #${CARD_ID} .nfw-step { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 8.5px; color: rgba(234, 234, 234, 0.7); }
    #${CARD_ID} .nfw-step i { display: block; width: 100%; height: 8px; border-radius: 2px; }
    #${CARD_ID} .nfw-legend-row--hl { display: flex; flex-wrap: wrap; gap: 4px 12px; }
    #${CARD_ID} .nfw-hl-key { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; color: rgba(234, 234, 234, 0.7); }
    #${CARD_ID} .nfw-hl-key i { display: inline-block; width: 12px; height: 12px; border-radius: 50%; }
    #${CARD_ID} .nfw-hl-key i.is-district { border-radius: 2px; border: 2px solid #38bdf8; background: rgba(125, 211, 252, 0.2); animation: nfw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .nfw-hl-key i.is-station { border: 2px solid #fff; animation: nfw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .nfw-hl-key i.is-waqi { border: 2px solid #fbbf24; animation: nfw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .nfw-loader {
      display: flex; align-items: center; gap: 9px; margin-top: 8px; padding: 7px 9px; border-radius: 8px;
      background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.28); animation: nfw-in 0.3s ease;
    }
    #${CARD_ID} .nfw-loader[hidden] { display: none; }
    #${CARD_ID} .nfw-loader-main { flex: 1 1 auto; min-width: 0; }
    #${CARD_ID} .nfw-loader-text { font-size: 10.5px; color: rgba(234, 234, 234, 0.85); margin-bottom: 4px; }
    #${CARD_ID} .nfw-loader-bar { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); overflow: hidden; position: relative; }
    #${CARD_ID} .nfw-loader-bar i { display: block; height: 100%; width: 0; border-radius: 999px;
      background: linear-gradient(90deg, #38bdf8, #14b8a6); transition: width 0.3s ease; }
    #${CARD_ID} .nfw-loader-bar.is-indeterminate i { width: 35% !important; animation: nfw-indet 1.1s ease-in-out infinite; }
    @keyframes nfw-indet { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
    #${CARD_ID} .nfw-loader-time { font-size: 10px; color: rgba(234, 234, 234, 0.55); font-variant-numeric: tabular-nums; min-width: 32px; text-align: right; }
    #${CARD_ID} .nfw-loader.is-done { background: rgba(34, 197, 94, 0.1); border-color: rgba(34, 197, 94, 0.35); }
    #${CARD_ID} .nfw-loader.is-done .nfw-spinner { animation: none; border-color: #22c55e; }
    #${CARD_ID} .nfw-loader.is-done .nfw-loader-bar i { background: #22c55e; }
    #${CARD_ID} .nfw-layer-loading { margin-top: 6px; font-size: 11px; font-style: italic; color: rgba(234, 234, 234, 0.6); }
    #${CARD_ID} .nfw-progress-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    #${CARD_ID} .nfw-progress-track { flex: 1 1 auto; height: 3px; background: rgba(255, 255, 255, 0.08); border-radius: 999px; overflow: hidden; }
    #${CARD_ID} .nfw-progress-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #38bdf8, #14b8a6); transition: width 0.2s linear; }
    #${CARD_ID} .nfw-progress-timer { min-width: 38px; text-align: right; font-size: 10px; color: rgba(234, 234, 234, 0.55); font-variant-numeric: tabular-nums; }
    #${CARD_ID} .nfw-transport { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
    #${CARD_ID} .nfw-btn {
      appearance: none; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; color: #eaeaea; background: rgba(255, 255, 255, 0.06); border-radius: 999px;
      transition: background 0.15s ease;
    }
    #${CARD_ID} .nfw-btn:hover { background: rgba(56, 189, 248, 0.28); }
    #${CARD_ID} .nfw-btn svg { width: 14px; height: 14px; }
    #${CARD_ID} .nfw-btn--rw, #${CARD_ID} .nfw-btn--ff { width: auto; min-width: 26px; padding: 0 7px; gap: 3px; }
    #${CARD_ID} .nfw-speed { font-size: 9.5px; font-weight: 800; }
    #${CARD_ID} .nfw-btn.is-active { background: rgba(56, 189, 248, 0.45); color: #fff; }
    #${CARD_ID} .nfw-hint { margin-left: auto; font-size: 10.5px; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .nfw-dots { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
    #${CARD_ID} .nfw-dot {
      appearance: none; width: 8px; height: 8px; padding: 0; border: none; border-radius: 50%; cursor: pointer;
      background: rgba(255, 255, 255, 0.15); transition: background 0.15s ease, transform 0.15s ease;
    }
    #${CARD_ID} .nfw-dot.is-ch2 { background: rgba(20, 184, 166, 0.25); }
    #${CARD_ID} .nfw-dot.is-active { background: #38bdf8; transform: scale(1.3); }
    #${CARD_ID} .nfw-dot.is-ch2.is-active { background: #14b8a6; }
    #${CARD_ID} .nfw-meta { margin-top: 8px; font-size: 10.5px; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .nfw-prompt {
      display: grid; gap: 10px; padding: 16px 14px 14px; text-align: center; border-radius: 10px;
      background: linear-gradient(180deg, rgba(56, 189, 248, 0.14), rgba(56, 189, 248, 0.04));
      border: 1px solid rgba(56, 189, 248, 0.35); animation: nfw-in 0.26s ease-out;
    }
    #${CARD_ID} .nfw-prompt-icon { font-size: 26px; line-height: 1; }
    #${CARD_ID} .nfw-prompt-title { font-size: 13px; font-weight: 800; text-transform: uppercase; color: #fff; }
    #${CARD_ID} .nfw-prompt-desc { font-size: 11.5px; color: rgba(234, 234, 234, 0.8); }
    #${CARD_ID} .nfw-prompt-buttons { display: grid; gap: 6px; }
    #${CARD_ID} .nfw-prompt-btn {
      appearance: none; cursor: pointer; padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 700;
      border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.06); color: #eaeaea;
    }
    #${CARD_ID} .nfw-prompt-btn.is-primary { background: #0284c7; color: #fff; box-shadow: 0 4px 12px rgba(2, 132, 199, 0.35); }

    #${POPUP_ID} {
      position: absolute; z-index: 5; width: 372px; max-width: calc(100% - 24px); max-height: 72vh; overflow-y: auto;
      top: 188px; left: 12px; pointer-events: auto; opacity: 0; transform: translateY(-8px);
      transition: opacity 0.35s ease, transform 0.35s ease;
      background: linear-gradient(180deg, rgba(12, 20, 32, 0.96), rgba(8, 14, 24, 0.96)); color: #eaeaea;
      border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55), 0 0 0 3px rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); font-size: 12px;
    }
    #${POPUP_ID} .nfwp-head {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: linear-gradient(90deg, rgba(2, 132, 199, 0.4), rgba(20, 184, 166, 0.1));
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    #${POPUP_ID} .nfwp-head.is-ch2 { background: linear-gradient(90deg, rgba(20, 184, 166, 0.38), rgba(2, 132, 199, 0.12)); }
    #${POPUP_ID} .nfwp-dot { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; flex: 0 0 auto; animation: nfw-pulse 1.6s ease-in-out infinite; }
    #${POPUP_ID} .nfwp-title { flex: 1 1 auto; font-size: 13px; font-weight: 700; color: #fff; }
    #${POPUP_ID} .nfwp-badge {
      font-size: 9.5px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); white-space: nowrap;
    }
    #${POPUP_ID} .nfwp-body { padding: 10px 12px; line-height: 1.55; }
    #${POPUP_ID} .nfwp-caption { margin-bottom: 8px; color: rgba(234, 234, 234, 0.92); }
    #${POPUP_ID} .nfwp-label {
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
      color: rgba(234, 234, 234, 0.5); margin: 8px 0 4px;
    }
    #${POPUP_ID} .nfwp-big { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
    #${POPUP_ID} .nfwp-big-value { font-size: 26px; font-weight: 800; color: #fff; line-height: 1; }
    #${POPUP_ID} .nfwp-big-sub { font-size: 10.5px; color: rgba(234, 234, 234, 0.6); }
    #${POPUP_ID} .nfwp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 6px 0; }
    #${POPUP_ID} .nfwp-stat { padding: 6px 7px; border-radius: 8px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); }
    #${POPUP_ID} .nfwp-stat b { display: block; font-size: 13.5px; color: #fff; }
    #${POPUP_ID} .nfwp-stat span { font-size: 9.5px; color: rgba(234, 234, 234, 0.55); }
    #${POPUP_ID} .nfwp-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    #${POPUP_ID} .nfwp-table th {
      text-align: left; font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      color: rgba(234, 234, 234, 0.5); padding: 2px 6px 4px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    #${POPUP_ID} .nfwp-table td { padding: 3px 6px 3px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
    #${POPUP_ID} .nfwp-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    #${POPUP_ID} .nfwp-cat { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    #${POPUP_ID} .nfwp-chart { width: 100%; height: auto; display: block; margin: 2px 0; }
    #${POPUP_ID} .nfwp-stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; margin: 4px 0 6px; }
    #${POPUP_ID} .nfwp-stack > span { display: block; height: 100%; animation: nfw-grow 0.9s ease-out; transform-origin: left; }
    @keyframes nfw-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    #${POPUP_ID} .nfwp-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 9.5px; color: rgba(234, 234, 234, 0.65); }
    #${POPUP_ID} .nfwp-advice {
      margin-top: 8px; padding: 7px 9px; border-radius: 8px; font-size: 11px; line-height: 1.45;
      background: rgba(20, 184, 166, 0.1); border: 1px solid rgba(20, 184, 166, 0.3); color: #fde68a;
    }
    #${POPUP_ID} .nfwp-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
    #${POPUP_ID} .nfwp-chip {
      font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
      background: rgba(56, 189, 248, 0.16); border: 1px solid rgba(56, 189, 248, 0.35); color: #bae6fd;
    }
    #${POPUP_ID} .nfwp-u { font-size: 0.68em; font-weight: 600; margin-left: 3px; color: rgba(234, 234, 234, 0.6); white-space: nowrap; }
    #${POPUP_ID} .nfwp-stat b { white-space: nowrap; }
    #${POPUP_ID} .nfwp-grid--4 { grid-template-columns: repeat(4, 1fr); }
    #${POPUP_ID} .nfwp-grid--4 .nfwp-stat b { font-size: 14px; }
    #${POPUP_ID} .nfwp-axis-note { font-size: 9.5px; color: rgba(234, 234, 234, 0.55); margin: 2px 0; }
    #${POPUP_ID} .nfwp-line { display: inline-block; width: 14px; height: 0; border-top: 2px dashed; margin-right: 5px; vertical-align: 2px; }
    #${POPUP_ID} .nfwp-line.is-dotted { border-top-style: dotted; }
    #${POPUP_ID} .nfwp-whisk { display: inline-block; width: 8px; height: 9px; margin-right: 5px; vertical-align: -1px;
      border-top: 1.5px solid rgba(255,255,255,0.75); background: linear-gradient(rgba(255,255,255,0.6), rgba(255,255,255,0.6)) center / 1px 100% no-repeat; }
    #${POPUP_ID} .nfwp-why { margin: 6px 0; padding: 8px 9px; border-radius: 8px;
      background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); animation: nfw-in 0.5s ease; }
    #${POPUP_ID} .nfwp-why-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 800; color: #fff; margin-bottom: 3px; }
    #${POPUP_ID} .nfwp-why-data { font-size: 11px; line-height: 1.5; color: rgba(234, 234, 234, 0.92); margin-bottom: 4px; }
    #${POPUP_ID} .nfwp-why-research { font-size: 10.5px; line-height: 1.45; color: rgba(125, 211, 252, 0.85); font-style: italic; }
    #${POPUP_ID} .nfwp-src { margin-top: 8px; font-size: 9.5px; color: rgba(234, 234, 234, 0.45); font-style: italic; }
  ` + EXTRA_CSS;
  document.head.appendChild(s);
}

// ---- Icons ----------------------------------------------------------------
const ICON_PLAY  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>`;

const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`;

const ICON_PREV  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>`;

const ICON_NEXT  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`;

const ICON_RW    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"></polygon><polygon points="22 19 13 12 22 5 22 19"></polygon></svg>`;

const ICON_FF    = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"></polygon><polygon points="2 19 11 12 2 5 2 19"></polygon></svg>`;

const ICON_TTS_ON  = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;

const ICON_TTS_OFF = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;

const ICON_REFRESH = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>`;

function _syncMuteButton(card) {
  const m = card?.querySelector(".nfw-mute");
  if (!m) return;
  m.classList.toggle("is-muted", !_state.ttsEnabled);
  m.innerHTML = _state.ttsEnabled ? ICON_TTS_ON : ICON_TTS_OFF;
  const label = _state.ttsEnabled ? "Mute narration" : "Unmute narration";
  m.setAttribute("aria-label", label);
  m.setAttribute("title", label);
}

function _syncLangButton(card) {
  const b = card?.querySelector(".nfw-lang");
  if (!b) return;
  const isUr = _state.lang === "ur";
  b.textContent = isUr ? "EN" : "اردو";
  b.classList.toggle("is-active", isUr);
  const label = isUr ? "Switch narration to English" : "Switch narration to Urdu";
  b.setAttribute("aria-label", label);
  b.setAttribute("title", label);
}

function _bindCardEvents(card) {
  const q = (sel) => card.querySelector(sel);
  q(".nfw-btn--play").addEventListener("click", _togglePlay);
  q(".nfw-btn--prev").addEventListener("click", () => _gotoScene(_state.index - 1));
  q(".nfw-btn--next").addEventListener("click", () => _gotoScene(_state.index + 1));
  q(".nfw-btn--ff").addEventListener("click", () => _cycleSpeed(1));
  q(".nfw-btn--rw").addEventListener("click", () => _cycleSpeed(-1));
  q(".nfw-close").addEventListener("click", () => {
    const sel = document.getElementById(SELECT_ID);
    if (sel) sel.value = "";
    _hide();
  });
  q(".nfw-mute").addEventListener("click", () => {
    _state.ttsEnabled = !_state.ttsEnabled;
    _stopSpeaking();
    _syncMuteButton(card);
    if (_state.ttsEnabled) _speak(_tr(_state.scenes[_state.index]?.caption));
  });
  q(".nfw-lang").addEventListener("click", () => {
    _state.lang = _state.lang === "ur" ? "en" : "ur";
    _saveLangPref(_state.lang);
    _syncLangButton(card);
    _reapplyLanguage(card);
    if (_state.lang === "ur") {
      _ensureUrduTranslations(card).then((ok) => { if (ok && _state.lang === "ur") _reapplyLanguage(card); }).catch(() => {});
    }
  });
  q(".nfw-refresh").addEventListener("click", () => _handleRefresh(card));
  q(".nfw-dots").addEventListener("click", (e) => {
    const dot = e.target.closest(".nfw-dot");
    const idx = Number(dot?.dataset.nfwScene);
    if (dot && Number.isFinite(idx)) _gotoScene(idx);
  });
}

// ---- Data -----------------------------------------------------------------
async function _fetchJson(url) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Loader under the scene text: spinner + label + progress bar + elapsed
// seconds. `progress` = {ready, total} for a determinate bar, or null for
// an indeterminate one. Lives outside .nfw-body, so scene re-renders keep it.
function _loaderEl(card) {
  return card?.querySelector(".nfw-loader") || null;
}

function _showLoader(card, text, progress, startedAt, done = false) {
  const el = _loaderEl(card);
  if (!el) return;
  el.hidden = false;
  el.classList.toggle("is-done", done);
  el.querySelector(".nfw-loader-text").textContent = text;
  const bar = el.querySelector(".nfw-loader-bar");
  const fill = bar.querySelector("i");
  const det = progress && progress.total > 0;
  bar.classList.toggle("is-indeterminate", !det);
  fill.style.width = det ? `${Math.round((progress.ready / progress.total) * 100)}%` : "";
  el.querySelector(".nfw-loader-time").textContent = startedAt ? `${((performance.now() - startedAt) / 1000).toFixed(1)}s` : "";
}

function _hideLoader(card) {
  const el = _loaderEl(card);
  if (el) el.hidden = true;
}

function _stopLayerTracking(card) {
  if (_state.loaderTimer) { clearInterval(_state.loaderTimer); _state.loaderTimer = null; }
  if (card) _hideLoader(card);
}

// Kept for the few one-off status lines (same loader, indeterminate).
function _setLoadingNote(card, msg) {
  if (!msg) { if (!_state.loaderTimer) _hideLoader(card); return; }
  _showLoader(card, msg, null, null);
}

// Tracks the active temporal layer until every frame's imagery for the
// current view has loaded: "fetching frame list…", then "N/M frames
// ready", then a brief "ready" state. Hidden frames (opacity 0) load too,
// which is what lets the slider step through them without flicker.
function _trackLayerLoading(card, token, itemKey, label) {
  _stopLayerTracking(null);
  const startedAt = performance.now();
  let doneAt = 0;
  const tick = () => {
    if (token !== _state.runToken) { _stopLayerTracking(card); return; }
    const map = window.ncop_map;
    const t = _temporal();
    const defs = t?.layerKey === itemKey ? (t.layersDef || []) : [];
    const ids = defs.flatMap((f) => (f.sources || [f.source]).filter(Boolean).map((src) => src.id));
    let ready = 0;
    for (const id of ids) {
      try { if (map?.getSource(id) && map.isSourceLoaded(id)) ready += 1; } catch (_) { /* best-effort */ }
    }
    if (!ids.length) {
      _showLoader(card, `${label}: fetching the frame list…`, null, startedAt);
    } else if (ready < ids.length) {
      _showLoader(card, `${label}: loading imagery — ${ready}/${ids.length} frames ready`, { ready, total: ids.length }, startedAt);
    } else {
      if (!doneAt) doneAt = performance.now();
      _showLoader(card, `${label}: all ${ids.length} frames ready`, { ready, total: ids.length }, null, true);
      if (performance.now() - doneAt > 1400) _stopLayerTracking(card);
    }
    // Give up quietly after 3 minutes (e.g. upstream outage): frames that
    // did load keep working, missing tiles simply show as gaps.
    if (performance.now() - startedAt > 180000) _stopLayerTracking(card);
  };
  tick();
  _state.loaderTimer = setInterval(tick, 300);
}

// ---- Popup ----------------------------------------------------------------
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
  el.scrollTop = 0;
  requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
}

function _closePopup() {
  const el = _state.popupEl;
  if (!el) return;
  el.style.opacity = "0";
  el.style.transform = "translateY(-8px)";
  setTimeout(() => { if (el && el.style.opacity === "0") el.innerHTML = ""; }, 300);
}

function _removePopup() {
  if (_state.popupEl) { try { _state.popupEl.remove(); } catch (_) {} }
  _state.popupEl = null;
}

function _captionBlock(caption) {
  const cls = _state.lang === "ur" ? "nfwp-caption nfw-lang-ur" : "nfwp-caption";
  return `<div class="${cls}">${_hl(_esc(_tr(caption)))}</div>`;
}

// ---- Layers ---------------------------------------------------------------
function _hideTempSlider() {
  const el = document.getElementById("temp-slider1");
  if (el) el.style.display = "none";
}

function _temporal() {
  return window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
}

// Same activation path as a sidebar click (handleTemporalInteraction),
// polling until the frames are built (the forecast renders server-side on
// a cold cache). The native #temp-slider1 panel stays hidden; this card's
// transport drives the story.
async function _activateTemporal(itemKey, title, token, opts = {}) {
  if (typeof handleTemporalInteraction !== "function") return false;
  const t = _temporal();
  if (t?.layerKey === itemKey && t.layersDef?.length) { _state.activeLayerKey = itemKey; _hideTempSlider(); return true; }
  handleTemporalInteraction(null, null, itemKey, true, { title });
  _hideTempSlider();
  for (let i = 0; i < 200; i++) {
    if (token !== _state.runToken) return false;
    const s = _temporal();
    if (s?.layerKey === itemKey && Array.isArray(s.layersDef) && s.layersDef.length) {
      _hideTempSlider();
      _state.activeLayerKey = itemKey;
      return true;
    }
    if (i === 12) opts.onSlow?.();
    await wait(300);
  }
  return false;
}

async function _deactivateTemporal(itemKey) {
  const map = window.ncop_map;
  if (!itemKey || !map) return;
  if (_state.activeLayerKey === itemKey) _state.activeLayerKey = null;
  // Deactivation clears whichever temporal layer is current, so only act
  // when it really is ours (never tear down an unrelated layer).
  const t = _temporal();
  if (t?.layerKey !== itemKey) return;
  const ids = (t.currentEntry?.layers || []).map((l) => l.id).filter((id) => map.getLayer(id));
  await Promise.all(ids.map((id) => {
    const prop = map.getLayer(id)?.type === "circle" ? "circle-opacity" : "raster-opacity";
    let from = 0.85;
    try { const cur = map.getPaintProperty(id, prop); if (typeof cur === "number") from = cur; } catch (_) {}
    return fadeLayerOpacity(map, id, prop, from, 0, _dur(900));
  }));
  if (_temporal()?.layerKey !== itemKey) return; // replaced while fading
  try { handleTemporalInteraction(null, null, itemKey, false, {}); } catch (_) {}
}

function _frameIndex(pred) {
  const defs = _temporal()?.layersDef || [];
  return defs.findIndex(pred);
}

function _setFrame(idx) {
  const slider = document.getElementById("slider1");
  if (!slider || idx < 0) return;
  slider.value = idx;
  try { slider.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
  _hideTempSlider();
  _updateFrameLabel();
}

// Steps the slider through `indices` (the last 7 days, or every forecast
// lead) until the scene goes stale, wrapping around. Sets the scene's
// minimum dwell so at least one full pass is visible before auto-advance.
function _loopFrames(indices, token, seq) {
  const list = indices.filter((i) => i >= 0);
  if (!list.length) return;
  _state.pendingMinDwellMs = Math.min(list.length * FRAME_STEP_MS + 800, 30000);
  (async () => {
    window.isTemporalAnimating = true;
    try {
      let k = 0;
      while (!_isStale(token, seq)) {
        _setFrame(list[k % list.length]);
        k += 1;
        await wait(FRAME_STEP_MS / (_state.speed || 1));
      }
    } finally {
      window.isTemporalAnimating = false;
    }
  })();
}

// ---- Playback -------------------------------------------------------------
function _clearAdvanceTimers() {
  if (_state.tickTimer) { clearTimeout(_state.tickTimer); _state.tickTimer = null; }
  if (_state.progRaf) { cancelAnimationFrame(_state.progRaf); _state.progRaf = null; }
}

function _estimateSpeechMs(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  return words ? Math.max(4000, Math.min(60000, words * 430 + 1500)) : 4000;
}

// Reading time for the caption when narration is off (≈ 220 words/min),
// never less than the standard dwell.
function _readingMs(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  return Math.max(DWELL_MS_NO_TTS, Math.min(26000, words * 270));
}

async function _gotoScene(rawIdx) {
  const n = _state.scenes.length;
  const card = document.getElementById(CARD_ID);
  if (!n || !card) return;
  _clearAdvanceTimers();
  _state.index = ((rawIdx % n) + n) % n;
  const token = _state.runToken;
  const seq = ++_state.sceneSeq;
  _state.pendingMinDwellMs = 0;
  card.querySelector(".nfw-progress-fill").style.width = "0%";
  card.querySelector(".nfw-progress-timer").textContent = "0.0s";
  const scene = _state.scenes[_state.index];
  await _enterScene(card, scene, token, seq);
  if (_isStale(token, seq)) return;
  const minDwell = _state.pendingMinDwellMs || 0;
  _state.pendingMinDwellMs = 0;
  if (_state.isPlaying) _scheduleAdvance(card, token, seq, scene.caption, minDwell);
}

function _scheduleAdvance(card, token, seq, caption, minDwellMs = 0) {
  _clearAdvanceTimers();
  const base = (_state.ttsEnabled ? _estimateSpeechMs(_tr(caption)) : _readingMs(caption)) / (_state.speed || 1);
  const dwell = Math.max(base, minDwellMs / (_state.speed || 1));
  const fill = card.querySelector(".nfw-progress-fill");
  const timer = card.querySelector(".nfw-progress-timer");
  const start = performance.now();
  const tick = () => {
    if (_isStale(token, seq) || !_state.isPlaying) return;
    const el = Math.min(performance.now() - start, dwell);
    if (fill) fill.style.width = `${(el / dwell) * 100}%`;
    if (timer) timer.textContent = `${(el / 1000).toFixed(1)}s / ${(dwell / 1000).toFixed(1)}s`;
    if (el < dwell) _state.progRaf = requestAnimationFrame(tick);
  };
  _state.progRaf = requestAnimationFrame(tick);
  const advance = () => {
    _state.tickTimer = null;
    if (_isStale(token, seq) || !_state.isPlaying) return;
    const speaking = _state.ttsEnabled && window.speechSynthesis && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
    if (speaking) { _state.tickTimer = setTimeout(advance, 1000); return; }
    // Stop at the end instead of looping back to the intro.
    const next = _state.index + _state.direction;
    if (next >= _state.scenes.length || next < 0) { _pause(); return; }
    _gotoScene(next);
  };
  _state.tickTimer = setTimeout(advance, dwell);
}

function _setPlayGlyph(card, playing) {
  const b = card?.querySelector(".nfw-btn--play");
  if (!b) return;
  b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  b.title = playing ? "Pause" : "Play";
}

function _play() {
  const card = document.getElementById(CARD_ID);
  if (!card || _state.scenes.length < 2) return;
  _state.isPlaying = true;
  _setPlayGlyph(card, true);
  const scene = _state.scenes[_state.index];
  _scheduleAdvance(card, _state.runToken, _state.sceneSeq, scene?.caption);
}

function _pause() {
  _state.isPlaying = false;
  _clearAdvanceTimers();
  _stopSpeaking();
  _setPlayGlyph(document.getElementById(CARD_ID), false);
}

function _togglePlay() {
  if (_state.isPlaying) { _pause(); return; }
  _setSpeed(1, 1);
  // Pressing play on the last scene restarts from the beginning.
  if (_state.index >= _state.scenes.length - 1) { _state.isPlaying = true; _setPlayGlyph(document.getElementById(CARD_ID), true); _gotoScene(0); return; }
  _play();
}

function _setSpeed(speed, direction) {
  _state.speed = speed;
  _state.direction = direction;
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  const ff = card.querySelector(".nfw-btn--ff");
  const rw = card.querySelector(".nfw-btn--rw");
  const ffOn = direction === 1 && speed > 1;
  const rwOn = direction === -1;
  ff?.classList.toggle("is-active", ffOn);
  rw?.classList.toggle("is-active", rwOn);
  if (ff) ff.querySelector(".nfw-speed").textContent = ffOn ? `${speed}x` : "";
  if (rw) rw.querySelector(".nfw-speed").textContent = rwOn ? `${speed}x` : "";
}

function _cycleSpeed(direction) {
  if (_state.direction !== direction) _setSpeed(1, direction);
  else _setSpeed(SPEED_LEVELS[(SPEED_LEVELS.indexOf(_state.speed) + 1) % SPEED_LEVELS.length], direction);
  if (!_state.isPlaying) _play();
  else _scheduleAdvance(document.getElementById(CARD_ID), _state.runToken, _state.sceneSeq, _state.scenes[_state.index]?.caption);
}

// ---- Load / show / hide ---------------------------------------------------
function _loadingHtml(msg) {
  return `<div class="nfw-status"><span class="nfw-spinner" aria-hidden="true"></span><span>${_esc(msg)}</span></div>`;
}

async function _handleRefresh(card) {
  const btn = card.querySelector(".nfw-refresh");
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.classList.add("is-spinning"); }
  _stopEverything();
  try {
    await _loadAndPlay(card, true);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("is-spinning"); }
  }
}

// ---- #storySelect integration ---------------------------------------------
function _ensureOption(sel) {
  if (!sel || sel.querySelector(`option[value="${SENTINEL}"]`)) return;
  const opt = document.createElement("option");
  opt.value = SENTINEL;
  opt.textContent = LABEL;
  sel.appendChild(opt);
}

function _watchSelect(sel) {
  _ensureOption(sel);
  if (_optionObserver) _optionObserver.disconnect();
  _optionObserver = new MutationObserver(() => _ensureOption(sel));
  _optionObserver.observe(sel, { childList: true });
  // Capture phase, before StoryManager's target-phase listener resets the
  // select. Registered after the other two stories' listeners (import
  // order in dashboard.js), so this runs last and its hide of the 7-Day
  // Outlook wins over the Dynamic Weather Report's restore.
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

function _wireModalVisibility() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return false;
  const isVisible = () => {
    const disp = modal.style.display;
    return (disp && disp !== "none") || modal.classList.contains("visible");
  };
  let wasVisible = isVisible();
  const mo = new MutationObserver(() => {
    const now = isVisible();
    if (!now && wasVisible) {
      if (_state.active) { _stopEverything(); _state.active = false; }
      const card = document.getElementById(CARD_ID);
      if (card) card.style.display = "none";
    }
    wasVisible = now;
  });
  mo.observe(modal, { attributes: true, attributeFilter: ["style", "class"] });
  return true;
}

// ==========================================================================
// FFD routing graph + camera helpers — moved here with the FFD beats from
// the Dynamic Weather Report (story-dynamic-weather.js).
// ==========================================================================
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


// ==========================================================================
// FFD — parsing the live feed
// ==========================================================================
// The feed carries discharge as comma-formatted strings ("22,200"),
// inflow/outflow + trend inside a `gauges` JSON string, this year's peak
// (cyp_*), and upstream travel times (from + lag_hours). Older payloads had
// outflow_discharge/inflow_discharge, which are still honoured first.
function _ffdGauges(props) {
  try {
    const g = typeof props?.gauges === "string" ? JSON.parse(props.gauges) : props?.gauges;
    return Array.isArray(g) ? g : [];
  } catch (_) {
    return [];
  }
}
export function ffdReading(props = {}) {
  const g = _ffdGauges(props);
  const out = g.find((x) => /^out/i.test(String(x?.type || "")));
  const inn = g.find((x) => /^in/i.test(String(x?.type || "")));
  return {
    outflow: _num(props.outflow_discharge) ?? _num(out?.discharge) ?? _num(props.discharge),
    inflow: _num(props.inflow_discharge) ?? _num(inn?.discharge),
    outTrend: out?.trend || null,
    inTrend: inn?.trend || null,
    peak: _num(props.cyp_discharge),
    peakStatus: props.cyp_status || null,
    peakDate: props.cyp_date || null,
    from: Array.isArray(props.from) ? props.from.map((s) => String(s).trim()).filter(Boolean) : [],
    lag: Array.isArray(props.lag_hours) ? props.lag_hours.map(Number).filter(Number.isFinite) : [],
    time: props.recording_time || null,
  };
}
function _tier(status) {
  const kind = _ffdStatusKind(status);
  return FFD_TIERS.find((t) => t.key === kind) || { key: "unknown", label: "Unknown status", color: "#999999", rank: -1 };
}
function _trendGlyph(trend) {
  if (!trend) return "";
  return /ris/i.test(trend) ? "▲" : /fall/i.test(trend) ? "▼" : "▬";
}
function _ffdNetworkStats(waypoints) {
  const counts = Object.fromEntries(FFD_TIERS.map((t) => [t.key, 0]));
  let rising = 0, falling = 0, total = 0, peaksRatio = [];
  for (const wp of waypoints) {
    const t = _tier(wp.properties?.status);
    if (counts[t.key] != null) counts[t.key] += 1;
    const r = wp.reading;
    if (/ris/i.test(r.outTrend || "")) rising += 1;
    if (/fall/i.test(r.outTrend || "")) falling += 1;
    if (Number.isFinite(r.outflow)) total += r.outflow;
    if (Number.isFinite(r.outflow) && Number.isFinite(r.peak) && r.peak > 0) peaksRatio.push(r.outflow / r.peak);
  }
  peaksRatio.sort((a, b) => a - b);
  const median = peaksRatio.length ? peaksRatio[Math.floor(peaksRatio.length / 2)] : null;
  const top = waypoints.filter((w) => Number.isFinite(w.reading.outflow)).sort((a, b) => b.reading.outflow - a.reading.outflow);
  const alerts = waypoints.filter((w) => !_ffdIsNormal(w.properties?.status));
  return { counts, rising, falling, total, medianOfPeak: median, top, alerts, n: waypoints.length };
}

// ---- Cross-checks between systems ------------------------------------------
function _glofasPoints() {
  return (_state.digest?.glofas?.points || []).filter((p) => p.quality !== "unreliable");
}
function _nearestGlofas(lon, lat, river) {
  let best = null;
  for (const p of _glofasPoints()) {
    const km = _kmBetween([lon, lat], [p.lon, p.lat]);
    const sameRiver = river && p.river && String(river).toLowerCase().includes(String(p.river).toLowerCase());
    const score = km - (sameRiver ? 15 : 0);
    if (km <= CROSSCHECK_KM && (!best || score < best.score)) best = { p, km, score };
  }
  return best;
}
function _nearestFfd(lon, lat) {
  let best = null;
  for (const wp of _state.waypoints) {
    if (!(wp.reading?.outflow > 0)) continue; // closed gate or not reporting: no basis for a comparison
    const km = _kmBetween([lon, lat], wp.center);
    if (km <= CROSSCHECK_KM && (!best || km < best.km)) best = { wp, km };
  }
  return best;
}
function _headroom(p) {
  return Number.isFinite(p?.headroom_ratio) ? p.headroom_ratio : null;
}

// Combined watch level: 0 Normal .. 4 Severe (max over the three systems).
export function watchLevel(stats, digest) {
  let lvl = 0;
  const ffdTop = Math.max(-1, ...(stats?.alerts || []).map((w) => _tier(w.properties?.status).rank));
  if (ffdTop >= 1) lvl = Math.max(lvl, ffdTop >= 4 ? 4 : ffdTop >= 3 ? 3 : ffdTop >= 2 ? 2 : 1);
  const gc = digest?.glofas?.counts || {};
  if (gc.extreme) lvl = Math.max(lvl, 4); else if (gc.danger) lvl = Math.max(lvl, 3); else if (gc.warning) lvl = Math.max(lvl, 2);
  const fc = digest?.floodhub?.counts || {};
  if (fc.EXTREME) lvl = Math.max(lvl, 4); else if (fc.SEVERE) lvl = Math.max(lvl, 3); else if (fc.ABOVE_NORMAL) lvl = Math.max(lvl, 2);
  if ((digest?.inundation?.count || 0) > 0) lvl = Math.max(lvl, 2);
  return lvl;
}

// ==========================================================================
// Narratives
// ==========================================================================
function _seasonSentence() {
  switch (_season()) {
    case "monsoon":
      return "It is monsoon season, when Pakistan's major floods have occurred: in 2010 and again in 2022, when two atmospheric rivers delivered about 15 days of extreme rain onto already saturated ground (Nanditha et al., 2023).";
    case "pre-monsoon":
      return "Snow and glacier melt are lifting the Indus system ahead of the monsoon; most of the upper Indus flow comes from snow and glacier melt (Archer & Fowler, 2004).";
    case "melt":
      return "Spring melt of winter snow, delivered largely by western disturbances (Dimri et al., 2015), is beginning to raise flows in the northern rivers.";
    default:
      return "It is the low-flow season: rivers run on base flow and a quiet board is expected. The value of this briefing now is readiness and a baseline to compare against when flows rise.";
  }
}

function _introNarrative(stats, d) {
  const g = d?.glofas;
  const h = d?.floodhub;
  const parts = [];
  if (stats.n) parts.push(`${stats.n} FFD barrages and dams`);
  if (g) parts.push(`${g.points.length} GloFAS forecast points`);
  if (h) parts.push(`${h.gauges.length} Google Flood Hub gauges`);
  return `National Flood Watch. This briefing reads Pakistan's rivers from ${parts.length ? _joinList(parts) : "the available systems"}: what the rivers carry right now, what the 15-day ensemble outlook and the AI gauge forecasts expect next, and what the research says about why Pakistan floods. ${_seasonSentence()}`;
}

function _ffdIntroNarrative(stats) {
  if (!stats.n) return "FFD barrage and dam telemetry is not currently available; the river tour will resume once the feed returns.";
  const alerts = stats.alerts.length
    ? `${stats.alerts.length} report above-normal flow: ${_joinList(stats.alerts.map((w) => `${w.name} (${_tier(w.properties?.status).label})`))}.`
    : "every station reports normal flow.";
  const trend = stats.rising || stats.falling ? ` ${stats.rising} rising and ${stats.falling} falling.` : "";
  const peak = Number.isFinite(stats.medianOfPeak) ? ` The typical station is carrying ${_pct(stats.medianOfPeak)} of its peak flow so far this year.` : "";
  return `Chapter 1: rivers now. The Federal Flood Commission network reports ${stats.n} barrages and dams; ${alerts}${trend}${peak} The tour follows the water downstream, river by river, from the mountains to the Arabian Sea.`;
}

function _ffdRoutingMapNarrative() {
  return "This is PMD/FFD's own flood-routing network: the real hydrological topology, with revised lag times in hours between every gauge, dam and confluence. Those lag times are the warning window: a flood wave seen upstream reaches the next barrage hours to days later.";
}

function _ffdBarrageNarrative(wp) {
  const r = wp.reading;
  const t = _tier(wp.properties?.status);
  const bits = [];
  const flows = [];
  if (Number.isFinite(r.outflow)) flows.push(`outflow ${_fmt(r.outflow)} cusecs${r.outTrend ? ` and ${String(r.outTrend).toLowerCase()}` : ""}`);
  if (Number.isFinite(r.inflow)) flows.push(`inflow ${_fmt(r.inflow)} cusecs`);
  bits.push(`${wp.name}${wp.area ? `, on the ${wp.area}` : ""}: ${flows.length ? flows.join(", ") : "no discharge reading"}. Status: ${t.label}.`);
  if (Number.isFinite(r.peak) && r.peak > 0) {
    bits.push(`This year's peak here was ${_fmt(r.peak)} cusecs${r.peakDate ? ` on ${r.peakDate}` : ""}${r.peakStatus ? ` (${_tier(r.peakStatus).label.toLowerCase()})` : ""}; today's flow is ${_pct((r.outflow || 0) / r.peak)} of it.`);
  }
  const limits = ffdFloodLimitsFor(wp.name);
  const flow = Math.max(...[r.outflow, r.inflow].filter(Number.isFinite), -Infinity);
  if (limits && Number.isFinite(flow)) {
    const spill = ffdSpillState(flow, limits);
    const low = limits.thresholds.low;
    if (spill.share != null) {
      bits.push(spill.state === "over"
        ? `It is passing ${_fmt(flow)} cusecs, above its ${_fmt(limits.design)} cusecs design capacity: spill-over conditions.`
        : `That is ${_pct(spill.share)} of its ${_fmt(limits.design)} cusecs design capacity${low && flow < low ? `; FFD's low-flood level here is ${_fmt(low)} cusecs` : ""}.`);
    } else if (low) {
      bits.push(`FFD's low-flood level here is ${_fmt(low)} cusecs.`);
    }
  }
  if (r.from.length && r.lag.length) {
    bits.push(`Water from ${r.from[0]} takes about ${r.lag[0]} h to arrive here.`);
  }
  const near = _nearestGlofas(wp.center[0], wp.center[1], wp.area);
  if (near) {
    const p = near.p;
    bits.push(`The GloFAS point ${_r(near.km)} km away on the ${p.river || "same reach"} forecasts a 15-day peak of ${_fmt(p.max_q)} m³/s (about ${_fmt(_toCusecs(p.max_q))} cusecs), ${_pct(_headroom(p))} of its warning level.`);
  }
  return bits.join(" ");
}

function _ffdRiverGroupNarrative(river, members) {
  const alerts = members.filter((wp) => !_ffdIsNormal(wp.properties?.status));
  const total = members.reduce((s, wp) => s + (Number.isFinite(wp.reading.outflow) ? wp.reading.outflow : 0), 0);
  const bits = [`${river}: ${members.length} monitored station${members.length === 1 ? "" : "s"}, carrying ${_fmt(total)} cusecs in total.`];
  if (alerts.length) {
    bits.push(`Above normal: ${_joinList(alerts.map((wp) => `${wp.name} (${_tier(wp.properties?.status).label})`))}.`);
  } else {
    bits.push("Every station on this river reports normal flow.");
  }
  const lead = members.filter((wp) => Number.isFinite(wp.reading.outflow)).sort((a, b) => b.reading.outflow - a.reading.outflow)[0];
  if (lead) bits.push(`The largest flow is at ${lead.name}, ${_fmt(lead.reading.outflow)} cusecs.`);
  return bits.join(" ");
}

function _ffdAssessmentNarrative(stats) {
  if (!stats.n) return "FFD assessment unavailable: no station telemetry was returned.";
  const top = stats.top[0];
  const bits = ["FFD network assessment."];
  if (top) bits.push(`${top.name} carries the most water, ${_fmt(top.reading.outflow)} cusecs.`);
  bits.push(stats.alerts.length
    ? `${stats.alerts.length} station${stats.alerts.length > 1 ? "s are" : " is"} above normal, so continued monitoring is warranted.`
    : "All stations report normal flow.");
  bits.push("Lesson from 2010: the catastrophe came from levee breaches at relatively modest flows along a raised, embanked Indus channel, not only from extreme discharge (Syvitski & Brakenridge, 2013). Flood-to-damage ratios have not fallen, so structural and non-structural measures must be planned together (Tariq & van de Giesen, 2012).");
  return bits.join(" ");
}

function _glofasDaysNarrative(g) {
  if (!g) return "Chapter 2: the 15-day outlook. GloFAS data from IWMI is unavailable right now, so this chapter is skipped.";
  const reliable = g.points.filter((p) => p.quality !== "unreliable");
  const alerting = reliable.filter((p) => p.status !== "normal");
  const closest = reliable.filter((p) => Number.isFinite(p.headroom_ratio)).sort((a, b) => b.headroom_ratio - a.headroom_ratio)[0];
  const bits = [`Chapter 2: the 15-day outlook from the Copernicus Global Flood Awareness System, run of ${g.forecast_date || "unknown date"}${Number.isFinite(g.run_age_days) ? `, ${g.run_age_days} days old` : ""}.`];
  bits.push(alerting.length
    ? `${alerting.length} of ${reliable.length} reliable points in Pakistan reach a flood threshold within 15 days.`
    : `None of the ${reliable.length} reliable points in Pakistan reaches a flood threshold within 15 days, at the 30% probability rule.`);
  if (closest) bits.push(`Closest to its warning level: the ${closest.river || "unnamed reach"}, peaking at ${_pct(closest.headroom_ratio)} of it around day +${closest.max_lead}.`);
  if (g.unreliable) bits.push(`${g.unreliable} points are flagged unreliable and drawn as hollow rings.`);
  bits.push("GloFAS compares an ensemble of river forecasts with thresholds from a 0.1° reanalysis (Alfieri et al., 2013; Harrigan et al., 2020) and is skilful in over 93% of catchments at 1 to 15 days (Harrigan et al., 2023).");
  return bits.join(" ");
}

function _glofasPointNarrative(p, rank) {
  const lvl = GLOFAS_LEVELS.find((x) => x.key === p.status) || GLOFAS_LEVELS[0];
  const bits = [`${rank === 1 ? "Closest to its threshold" : `Outlook focus ${rank}`}: the ${p.river || "unnamed"} at GloFAS point ${p.id}. Status ${lvl.label}.`];
  if (Number.isFinite(p.max_q)) bits.push(`The ensemble median peaks at ${_fmt(p.max_q)} m³/s (about ${_fmt(_toCusecs(p.max_q))} cusecs) on day +${p.max_lead}, ${_pct(_headroom(p))} of the ${_fmt(p.warning)} m³/s warning level.`);
  if (Number.isFinite(p.peak_prob) && p.status !== "normal") bits.push(`Peak exceedance probability ${_pct(p.peak_prob)} at day +${p.peak_lead}.`);
  const ffd = _nearestFfd(p.lon, p.lat);
  if (ffd && Number.isFinite(ffd.wp.reading.outflow)) {
    bits.push(`Ground check: ${ffd.wp.name}, ${_r(ffd.km)} km away, measures ${_fmt(ffd.wp.reading.outflow)} cusecs today (${_fmt(ffd.wp.reading.outflow / CUSECS_PER_M3S)} m³/s).`);
  }
  return bits.join(" ");
}

function _floodhubNarrative(h) {
  if (!h) return "Chapter 3: AI river forecasts. Google Flood Hub data from IWMI is unavailable right now.";
  const flooding = (h.counts.ABOVE_NORMAL || 0) + (h.counts.SEVERE || 0) + (h.counts.EXTREME || 0);
  const rising = h.trends.RISE || 0;
  const falling = h.trends.FALL || 0;
  return `Chapter 3: AI river forecasts. Google Flood Hub models ${h.gauges.length} quality-verified gauges in Pakistan, issued ${h.issued_time ? _pkt(h.issued_time) : "recently"}. ${flooding ? `${flooding} forecast flooding.` : "None forecasts flooding."} ${rising} rising, ${falling} falling, ${h.trends.NO_CHANGE || 0} steady. Its machine-learning model forecasts extreme floods in ungauged basins up to five days ahead with reliability comparable to or better than GloFAS nowcasts (Nearing et al., 2024).`;
}

function _gaugeNarrative(g, rank, series) {
  const lvl = FH_LEVELS.find((x) => x.key === g.severity) || FH_LEVELS[0];
  const bits = [`Gauge focus ${rank}: the ${g.river || "unnamed river"} (${g.id}). Severity: ${lvl.label}, trend ${String(g.trend || "unknown").toLowerCase().replace(/_/g, " ")}.`];
  const fc = (series?.forecast || []).map((x) => _num(x.v)).filter(Number.isFinite);
  if (fc.length && Number.isFinite(g.warning) && g.warning > 0) {
    const peak = Math.max(...fc);
    bits.push(`The forecast peaks at ${_fmt(peak)} m³/s, ${_pct(peak / g.warning)} of the ${_fmt(g.warning)} m³/s warning level.`);
  } else if (Number.isFinite(g.warning)) {
    bits.push(`Warning level ${_fmt(g.warning)} m³/s; danger ${_fmt(g.danger)} m³/s.`);
  }
  const ffd = _nearestFfd(g.lon, g.lat);
  if (ffd && Number.isFinite(ffd.wp.reading.outflow)) bits.push(`Nearest FFD station: ${ffd.wp.name}, ${_r(ffd.km)} km away, ${_fmt(ffd.wp.reading.outflow)} cusecs today.`);
  return bits.join(" ");
}

function _inundationNarrative(inund) {
  if (!inund) return "Modelled inundation is unavailable right now.";
  return inund.count
    ? `Google's inundation model maps ${inund.count} flooded area${inund.count > 1 ? "s" : ""} in Pakistan right now; the camera is framed on them. Flood Hub converts gauge forecasts into extent maps using its operational inundation models (Nevo et al., 2022).`
    : "No modelled inundation in Pakistan right now. Flood Hub draws extent maps only where a gauge in its high-resolution regions is forecast to flood (Nevo et al., 2022), so an empty map means no modelled flooding, not missing data.";
}

const WHY_CARDS = [
  {
    icon: "🌧️", title: "Monsoon extremes on saturated ground",
    text: "In August 2022, about 15 days of extreme rain from two atmospheric rivers fell on already wet soils, flooding about a third of the country; 33 million people were affected, more than 1,730 died, and damages and losses exceeded USD 30 billion, about 70% of it in Sindh.",
    refs: ["nanditha2023", "pdna2022"],
  },
  {
    icon: "🌡️", title: "A warmer atmosphere holds more water",
    text: "Air holds about 7% more moisture per °C of warming, and short-duration rainfall extremes are intensifying worldwide; for 2022, some models suggest climate change made the heaviest rainfall up to 50% more intense.",
    refs: ["trenberth2003", "fowler2021", "ipcc2021", "otto2023"],
  },
  {
    icon: "🏔️", title: "Snow, glaciers and western disturbances",
    text: "Most upper-Indus flow is snow and glacier melt, fed by winter snow from western disturbances. Runoff from High Asia is projected to rise until at least 2050, Karakoram glaciers are an anomaly that is unlikely to persist, and glacial-lake outburst flood risk is increasing.",
    refs: ["archer2004", "dimri2015", "hunt2018", "lutz2014", "hewitt2005", "farinotti2020", "zheng2021", "immerzeel2010", "immerzeel2020"],
  },
  {
    icon: "🌀", title: "Large-scale weather patterns",
    text: "The 2010 flood followed anomalous monsoon and upper-level patterns linked to the same blocking that drove the Russian heat wave; its heavy rain was predictable 6 to 8 days ahead in ensemble forecasts.",
    refs: ["houze2011", "lau2012", "webster2011"],
  },
  {
    icon: "🛡️", title: "Embankments, barrages and the channel",
    text: "In 2010, levee breaches at relatively modest flows along the raised Indus channel caused much of the damage, about 2,000 deaths and 20 million displaced; flood-to-damage ratios have not fallen, so structural and non-structural measures must be planned together.",
    refs: ["syvitski2013", "tariq2012"],
  },
  {
    icon: "👥", title: "Exposure is growing",
    text: "1.81 billion people live in 1-in-100-year flood zones, 89% in low- and middle-income countries; the share of people exposed rose about 20% from 2000 to 2018, mostly in South and Southeast Asia, and flood losses rise with every increment of warming.",
    refs: ["rentschler2022", "tellman2021", "hirabayashi2013", "dottori2018", "alfieri2017"],
  },
  {
    icon: "📡", title: "Early warning pays",
    text: "Ensemble forecasts give days of lead time; continental flood warnings in Europe return about 400 euros per euro invested, and forecast-based financing lets agencies act before the water arrives.",
    refs: ["cloke2009", "emerton2016", "wu2020", "pappenberger2015", "coughlan2015"],
  },
];

function _whyNarrative() {
  return "Why Pakistan floods. The research points to five drivers that combine: multi-day monsoon extremes on saturated ground, a warming atmosphere that holds more water, snow and glacier melt fed by western disturbances, large-scale weather patterns, and an embanked river system with growing exposure on its flood plains. Early warning is the best-proven defence.";
}

function _assessmentNarrative(stats, d, lvl) {
  const w = WATCH_LEVELS[lvl];
  const g = d?.glofas;
  const h = d?.floodhub;
  const bits = [`National assessment: watch level ${w.label}.`];
  bits.push(stats.n ? `FFD: ${stats.alerts.length ? `${stats.alerts.length} of ${stats.n} stations above normal` : `all ${stats.n} stations normal`}.` : "FFD: no telemetry.");
  if (g) {
    const a = (g.counts.warning || 0) + (g.counts.danger || 0) + (g.counts.extreme || 0);
    bits.push(`GloFAS: ${a ? `${a} points reach a threshold within 15 days` : "no threshold reached within 15 days"}.`);
  }
  if (h) {
    const f = (h.counts.ABOVE_NORMAL || 0) + (h.counts.SEVERE || 0) + (h.counts.EXTREME || 0);
    bits.push(`Flood Hub: ${f ? `${f} gauges forecast flooding` : "no gauge forecasts flooding"}.`);
  }
  bits.push(w.action);
  bits.push("This concludes the National Flood Watch.");
  return bits.join(" ");
}

// ==========================================================================
// Scenes
// ==========================================================================
function _pickGlofasTour(g) {
  if (!g) return [];
  const rank = Object.fromEntries(GLOFAS_LEVELS.map((x) => [x.key, x.rank]));
  const ranked = g.points.filter((p) => p.quality !== "unreliable" && Number.isFinite(p.lon))
    .sort((a, b) => (rank[b.status] - rank[a.status]) || ((b.headroom_ratio || 0) - (a.headroom_ratio || 0)));
  const out = [];
  for (const p of ranked) {
    if (out.some((q) => _kmBetween([q.lon, q.lat], [p.lon, p.lat]) < 50)) continue;
    out.push(p);
    if (out.length >= GLOFAS_TOUR_MAX) break;
  }
  return out;
}
function _pickGaugeTour(h) {
  if (!h) return [];
  // Already sorted server-side: severity, rising first, biggest river.
  // Prefer distinct rivers so the tour covers the system, not one reach.
  const out = [];
  for (const g of h.gauges) {
    if (!Number.isFinite(g.lon)) continue;
    if (out.some((q) => _kmBetween([q.lon, q.lat], [g.lon, g.lat]) < 60)) continue;
    if (g.severity === "NO_FLOODING" && out.some((q) => q.river && q.river === g.river)) continue;
    out.push(g);
    if (out.length >= FH_TOUR_MAX) break;
  }
  return out;
}

export function buildScenes(d, waypoints) {
  const stats = _ffdNetworkStats(waypoints);
  const scenes = [{ kind: "intro", chapter: 1, caption: _introNarrative(stats, d) }];

  if (waypoints.length) {
    scenes.push({ kind: "ffd-intro", chapter: 1, caption: _ffdIntroNarrative(stats) });
    scenes.push({ kind: "ffd-routing-map", chapter: 1, caption: _ffdRoutingMapNarrative() });
    // River by river: every above-normal station gets its own flight; a
    // quiet river gets its single largest-flow station as representative.
    // Every river closes with an overview covering all its stations.
    let prevForPath = null;
    for (const [river, members] of _groupFfdByRiver(waypoints)) {
      const nonNormal = members.filter((wp) => !_ffdIsNormal(wp.properties?.status));
      let featured = nonNormal;
      if (!featured.length) {
        const biggest = members.slice().sort((a, b) => (b.reading.outflow || -1) - (a.reading.outflow || -1))[0];
        featured = biggest ? [biggest] : [];
      }
      const names = new Set(featured.map((wp) => wp.name));
      for (const wp of members.filter((m) => names.has(m.name))) {
        scenes.push({ kind: "ffd-barrage", chapter: 1, waypoint: wp, prevWaypoint: prevForPath, caption: _ffdBarrageNarrative(wp) });
        prevForPath = wp;
      }
      scenes.push({ kind: "ffd-river-overview", chapter: 1, river, members, caption: _ffdRiverGroupNarrative(river, members) });
    }
    scenes.push({ kind: "ffd-assessment", chapter: 1, stats, caption: _ffdAssessmentNarrative(stats) });
  }

  scenes.push({ kind: "glofas-days", chapter: 2, caption: _glofasDaysNarrative(d?.glofas) });
  if (d?.glofas) {
    _pickGlofasTour(d.glofas).forEach((p, i) =>
      scenes.push({ kind: "glofas-point", chapter: 2, point: p, rank: i + 1, caption: _glofasPointNarrative(p, i + 1) }));
  }

  scenes.push({ kind: "floodhub-overview", chapter: 3, caption: _floodhubNarrative(d?.floodhub) });
  if (d?.floodhub) {
    _pickGaugeTour(d.floodhub).forEach((g, i) =>
      scenes.push({ kind: "floodhub-gauge", chapter: 3, gauge: g, rank: i + 1, caption: _gaugeNarrative(g, i + 1, null) }));
  }
  scenes.push({ kind: "inundation", chapter: 3, caption: _inundationNarrative(d?.inundation) });

  const lvl = watchLevel(stats, d);
  scenes.push({ kind: "why-floods", chapter: 4, caption: _whyNarrative() });
  scenes.push({ kind: "assessment", chapter: 4, stats, level: lvl, caption: _assessmentNarrative(stats, d, lvl) });
  return scenes;
}

const CHAPTER_NAMES = ["", "Rivers Now · FFD", "15-Day Outlook · GloFAS", "AI Gauges · Flood Hub", "Context & Assessment"];

function _sceneTitle(scene) {
  switch (scene.kind) {
    case "intro":              return "Chapter 1 — Rivers Now";
    case "ffd-intro":          return "FFD Barrage & Dam Network";
    case "ffd-routing-map":    return "FFD Flood Routing Map";
    case "ffd-barrage":        return `${scene.waypoint.name}${scene.waypoint.area ? ` — ${scene.waypoint.area}` : ""}`;
    case "ffd-river-overview": return `${scene.river} — Overview`;
    case "ffd-assessment":     return "FFD Network Assessment";
    case "glofas-days":        return "Chapter 2 — 15-Day Outlook (GloFAS)";
    case "glofas-point":       return `Outlook Focus — ${scene.point.river || `Point ${scene.point.id}`}`;
    case "floodhub-overview":  return "Chapter 3 — AI River Forecasts (Flood Hub)";
    case "floodhub-gauge":     return `Gauge Focus — ${scene.gauge.river || scene.gauge.id}`;
    case "inundation":         return "Modelled Inundation";
    case "why-floods":         return "Chapter 4 — Why Pakistan Floods";
    case "assessment":         return "National Flood Assessment";
    default:                   return LABEL;
  }
}

function _pill(text, alert = false, color = null) {
  const sw = color ? `<span class="nfw-swatch" style="background:${color}"></span>` : "";
  return `<span class="nfw-pill${alert ? " is-alert" : ""}">${sw}${_hl(_esc(text))}</span>`;
}

// Legend block for the layers on the map in this chapter.
function _steps(levels) {
  return `<div class="nfw-steps">${levels.map((l) => `<span class="nfw-step"><i style="background:${l.color}"></i>${_esc(l.label)}</span>`).join("")}</div>`;
}
function _legendRow(kind, title, unit, body) {
  return `<div class="nfw-legend-row"><div class="nfw-legend-title"><span class="nfw-legend-kind">${_esc(kind)}</span>${_esc(title)}${unit ? ` <small>${_esc(unit)}</small>` : ""}</div>${body}</div>`;
}
function _layersLegendHtml(scene) {
  const rows = [];
  const ch = scene.chapter;
  if (ch === 1 || ch === 4) rows.push(_legendRow("Points", "FFD barrages & dams", "flood tier", _steps(FFD_TIERS)));
  if (ch === 2) {
    const scale = String(TEMPORAL_LEGENDS?.[GLOFAS_DAYS_KEY] || "");
    rows.push(_legendRow("Temporal", "GloFAS alerts by forecast day", "≥30% exceedance probability",
      `<div class="nfw-legend-scale">${scale}</div><div class="nfw-legend-note">Hollow grey ring: unreliable point · dot size: river size × level</div>`));
  }
  if (ch === 4) rows.push(_legendRow("Points", "GloFAS flood-alert points", "", _steps(GLOFAS_LEVELS)));
  if (ch === 3 || ch === 4) {
    rows.push(_legendRow("Points", "Flood Hub gauges", "severity",
      `${_steps(FH_LEVELS)}<div class="nfw-legend-note"><span class="nfw-ring is-rise"></span>rising <span class="nfw-ring is-fall"></span>falling <span class="nfw-ring"></span>steady</div>`));
  }
  if ((ch === 3 && scene.kind === "inundation") || ch === 4) {
    rows.push(_legendRow("Area", "Modelled inundation", "",
      _steps([{ label: "High", color: "#1e3a8a" }, { label: "Medium", color: "#2563eb" }, { label: "Low", color: "#93c5fd" }])));
  }
  rows.push(`<div class="nfw-legend-row nfw-legend-row--hl"><span class="nfw-hl-key"><i></i>Blinking ring: in focus</span></div>`);
  return `<div class="nfw-legend">${rows.join("")}</div>`;
}

function _factsHtml(scene) {
  const d = _state.digest || {};
  const pills = [];
  const k = scene.kind;
  if (k === "ffd-barrage") {
    const r = scene.waypoint.reading;
    const t = _tier(scene.waypoint.properties?.status);
    pills.push(_pill(t.label, t.rank > 0, t.color));
    if (Number.isFinite(r.outflow)) pills.push(_pill(`${_fmt(r.outflow)} cusecs out ${_trendGlyph(r.outTrend)}`));
    if (Number.isFinite(r.inflow)) pills.push(_pill(`${_fmt(r.inflow)} cusecs in ${_trendGlyph(r.inTrend)}`));
    if (Number.isFinite(r.peak) && r.peak > 0 && Number.isFinite(r.outflow)) pills.push(_pill(`${_pct(r.outflow / r.peak)} of season peak`));
  } else if (k === "ffd-river-overview") {
    const a = scene.members.filter((wp) => !_ffdIsNormal(wp.properties?.status)).length;
    pills.push(_pill(`${scene.members.length} stations`), _pill(`${a} above normal`, a > 0));
  } else if (k === "ffd-assessment" || k === "ffd-intro") {
    const s = scene.stats || _ffdNetworkStats(_state.waypoints);
    pills.push(_pill(`${s.n} stations`), _pill(`${s.alerts.length} above normal`, s.alerts.length > 0), _pill(`${_fmt(s.total)} cusecs total`));
  } else if (k === "glofas-days" && d.glofas) {
    const a = (d.glofas.counts.warning || 0) + (d.glofas.counts.danger || 0) + (d.glofas.counts.extreme || 0);
    pills.push(_pill(`${a} points alerting`, a > 0), _pill(`run ${d.glofas.forecast_date}`));
  } else if (k === "glofas-point") {
    const p = scene.point;
    pills.push(_pill(`${_fmt(p.max_q)} m³/s peak`), _pill(`${_pct(_headroom(p))} of warning`, (_headroom(p) || 0) >= 1), _pill(`day +${p.max_lead}`));
  } else if (k === "floodhub-overview" && d.floodhub) {
    const f = (d.floodhub.counts.ABOVE_NORMAL || 0) + (d.floodhub.counts.SEVERE || 0) + (d.floodhub.counts.EXTREME || 0);
    pills.push(_pill(`${d.floodhub.gauges.length} gauges`), _pill(`${f} forecasting flooding`, f > 0));
  } else if (k === "floodhub-gauge") {
    const g = scene.gauge;
    const lvl = FH_LEVELS.find((x) => x.key === g.severity) || FH_LEVELS[0];
    pills.push(_pill(lvl.label, lvl.rank > 0, lvl.color), _pill(`warning ${_fmt(g.warning)} m³/s`));
  } else if (k === "inundation" && d.inundation) {
    pills.push(_pill(`${d.inundation.count} flooded areas`, d.inundation.count > 0));
  } else if (k === "assessment") {
    const w = WATCH_LEVELS[scene.level];
    pills.push(_pill(`Watch level: ${w.label}`, scene.level >= 2, w.color));
  }
  const frame = scene.chapter === 2 ? `<span class="nfw-pill nfw-frame-pill">Frame <span class="nfw-frame-value">—</span></span>` : "";
  const facts = frame || pills.length ? `<div class="nfw-facts">${frame}${pills.join("")}</div>` : "";
  return scene.kind === "intro" ? facts : facts + _layersLegendHtml(scene);
}

function _renderScene(card) {
  const scene = _state.scenes[_state.index];
  if (!scene || !card) return;
  card.querySelector(".nfw-chapter-title").textContent = _sceneTitle(scene);
  card.querySelector(".nfw-chapter-counter").textContent = `Scene ${_state.index + 1} / ${_state.scenes.length}`;
  card.querySelector(".nfw-hint").textContent = `Chapter ${scene.chapter} · ${CHAPTER_NAMES[scene.chapter] || ""}`;
  const body = card.querySelector(".nfw-body");
  body.classList.toggle("nfw-lang-ur", _state.lang === "ur");
  body.innerHTML = `<div class="nfw-caption">${_hl(_esc(_tr(scene.caption)))}</div>${_factsHtml(scene)}`;
  card.querySelector(".nfw-dots").innerHTML = _state.scenes.map((s, i) => {
    const on = i === _state.index;
    return `<button type="button" role="tab" class="nfw-dot is-ch${s.chapter}${on ? " is-active" : ""}" data-nfw-scene="${i}" aria-selected="${on}" title="${_esc(_sceneTitle(s))}"></button>`;
  }).join("");
  _updateFrameLabel();
}

function _updateFrameLabel() {
  const el = document.getElementById(CARD_ID)?.querySelector(".nfw-frame-value");
  const t = _temporal();
  if (!el || !t) return;
  const e = t.currentEntry || {};
  el.textContent = e.dateFull || e.date || "";
}

// ==========================================================================
// Card
// ==========================================================================
function _ensureCard(root) {
  let card = root.querySelector(`#${CARD_ID}`);
  if (card) return card;
  card = document.createElement("div");
  card.id = CARD_ID;
  card.innerHTML = `
    <div class="nfw-head">
      <div class="nfw-title"><span class="nfw-live" aria-hidden="true"></span><span>${LABEL}</span></div>
      <div class="nfw-head-actions">
        <button type="button" class="nfw-icon-btn nfw-refresh" aria-label="Refresh data" title="Re-fetch all river data and restart">${ICON_REFRESH}</button>
        <button type="button" class="nfw-icon-btn nfw-mute is-muted" aria-label="Unmute narration" title="Unmute narration">${ICON_TTS_OFF}</button>
        <button type="button" class="nfw-lang" aria-label="Switch to Urdu" title="Switch narration to Urdu">اردو</button>
        <button type="button" class="nfw-icon-btn nfw-close" aria-label="Close ${LABEL}" title="Close and return to 7-Day Outlook">✕</button>
      </div>
    </div>
    <div class="nfw-chapter-head">
      <div class="nfw-chapter-title">—</div>
      <div class="nfw-chapter-counter"></div>
    </div>
    <div class="nfw-body" role="region" aria-live="polite"></div>
    <div class="nfw-loader" role="status" aria-live="polite" hidden>
      <span class="nfw-spinner" aria-hidden="true"></span>
      <div class="nfw-loader-main">
        <div class="nfw-loader-text"></div>
        <div class="nfw-loader-bar"><i></i></div>
      </div>
      <span class="nfw-loader-time"></span>
    </div>
    <div class="nfw-progress-row">
      <div class="nfw-progress-track"><div class="nfw-progress-fill"></div></div>
      <span class="nfw-progress-timer">0.0s</span>
    </div>
    <div class="nfw-transport">
      <button type="button" class="nfw-btn nfw-btn--rw" title="Rewind (cycles 1x-5x)" aria-label="Rewind">${ICON_RW}<span class="nfw-speed"></span></button>
      <button type="button" class="nfw-btn nfw-btn--prev" title="Previous scene" aria-label="Previous">${ICON_PREV}</button>
      <button type="button" class="nfw-btn nfw-btn--play" title="Play" aria-label="Play">${ICON_PLAY}</button>
      <button type="button" class="nfw-btn nfw-btn--next" title="Next scene" aria-label="Next">${ICON_NEXT}</button>
      <button type="button" class="nfw-btn nfw-btn--ff" title="Fast-forward (cycles 1x-5x)" aria-label="Fast-forward">${ICON_FF}<span class="nfw-speed"></span></button>
      <span class="nfw-hint">Chapter 1 · Rivers Now · FFD</span>
    </div>
    <div class="nfw-dots" role="tablist"></div>
    <div class="nfw-meta">Sources: PMD Federal Flood Commission · CEMS GloFAS (Copernicus) & Google Flood Forecasting via IWMI ENSO Outlook · 33 peer-reviewed studies</div>
  `;
  const selectRow = root.querySelector(`#${SELECT_ID}`)?.parentElement;
  if (selectRow && selectRow.parentElement === root) selectRow.insertAdjacentElement("afterend", card);
  else root.appendChild(card);
  _state.lang = _loadLangPref();
  _bindCardEvents(card);
  _syncLangButton(card);
  mountExportButton(card, _exportReport);
  return card;
}

// ==========================================================================
// Popups + infographics
// ==========================================================================
function _popupHead(title, badge, chapter, badgeColor) {
  const style = badgeColor ? ` style="background:${badgeColor};color:${_textOn(badgeColor)}"` : "";
  return `<div class="nfwp-head is-ch${chapter}"><span class="nfwp-dot" aria-hidden="true"></span>
    <span class="nfwp-title">${_esc(title)}</span>${badge ? `<span class="nfwp-badge"${style}>${_esc(badge)}</span>` : ""}</div>`;
}
function _refsLine(ids) {
  return `<div class="nfwp-refs">Research: ${_esc(_cite(...ids))}</div>`;
}
const SRC_FFD = `<div class="nfwp-src">Data: PMD Federal Flood Commission (FFD), live telemetry via GCOP. 1 m³/s = ${CUSECS_PER_M3S} cusecs.</div>`;
const SRC_IWMI = `<div class="nfwp-src">Data: CEMS GloFAS (Copernicus) and Google Flood Forecasting, CC BY 4.0, via IWMI ENSO Outlook.</div>`;

// Stacked bar of category counts (status distribution), with legend.
function _stack(levels, counts, unit = "") {
  const total = levels.reduce((s, l) => s + (counts?.[l.key] || 0), 0);
  if (!total) return `<div class="nfwp-axis-note">No ${_esc(unit || "items")} reported.</div>`;
  const segs = levels.map((l) => {
    const n = counts[l.key] || 0;
    return n ? `<span style="width:${(n / total) * 100}%;background:${l.color}" title="${_esc(l.label)}: ${n}"></span>` : "";
  }).join("");
  const legend = levels.map((l) => `<span><span class="nfwp-cat" style="background:${l.color}"></span>${_esc(l.label)} ${_u(counts[l.key] || 0, unit)}</span>`).join("");
  return `<div class="nfwp-stack">${segs}</div><div class="nfwp-legend">${legend}</div>`;
}

// Horizontal bars (label · bar · value), optional reference fraction marker.
function _hBars(rows, opts = {}) {
  const max = Math.max(...rows.map((r) => r.value).filter(Number.isFinite), opts.min || 0, 1e-9);
  return `<div class="nfwp-hbars">${rows.map((r) => {
    const w = Number.isFinite(r.value) ? Math.max(1.5, (r.value / max) * 100) : 0;
    const marker = Number.isFinite(r.marker) ? `<b class="nfwp-hbar-marker" style="left:${Math.min(100, (r.marker / max) * 100)}%" title="${_esc(r.markerLabel || "")}"></b>` : "";
    return `<div class="nfwp-hbar"><span class="nfwp-hbar-label" title="${_esc(r.label)}">${_esc(r.label)}</span>
      <span class="nfwp-hbar-track"><i style="width:${w}%;background:${r.color || "#38bdf8"}"></i>${marker}</span>
      <span class="nfwp-hbar-value">${r.valueHtml ?? _esc(_fmt(r.value))}</span></div>`;
  }).join("")}</div>`;
}

// Stacked columns: GloFAS status counts per forecast day.
function _dayStackChart(dayCounts) {
  const W = 340, padL = 26, padR = 6, top = 10, plotH = 110, base = top + plotH, H = base + 26;
  const n = dayCounts.length || 1;
  const cw = (W - padL - padR) / n;
  const maxTotal = Math.max(1, ...dayCounts.map((d) => GLOFAS_LEVELS.reduce((s, l) => s + (d[l.key] || 0), 0)));
  const y = (v) => base - (v / maxTotal) * plotH;
  const out = [];
  for (let v = 0; v <= maxTotal; v += Math.max(1, Math.ceil(maxTotal / 4))) {
    out.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.08)"/><text x="${padL - 4}" y="${y(v) + 3}" font-size="7.5" fill="rgba(234,234,234,0.5)" text-anchor="end">${v}</text>`);
  }
  dayCounts.forEach((d, i) => {
    const x = padL + i * cw + cw * 0.15;
    const w = cw * 0.7;
    let acc = 0;
    for (const l of GLOFAS_LEVELS) {
      const c = d[l.key] || 0;
      if (!c) continue;
      const y0 = y(acc), y1 = y(acc + c);
      out.push(`<rect x="${x}" y="${y1}" width="${w}" height="${Math.max(0.5, y0 - y1)}" fill="${l.color}" rx="1.5"><title>Day +${d.lead}: ${c} ${l.label}</title></rect>`);
      acc += c;
    }
    out.push(`<text x="${x + w / 2}" y="${base + 10}" font-size="7.5" fill="rgba(234,234,234,0.75)" text-anchor="middle">+${d.lead}</text>`);
    if (i % 3 === 0 && d.date) out.push(`<text x="${x + w / 2}" y="${base + 20}" font-size="6.5" fill="rgba(234,234,234,0.45)" text-anchor="middle">${_esc(_shortDay(d.date))}</text>`);
  });
  out.push(`<text x="${padL - 4}" y="${top - 2}" font-size="7" font-weight="700" fill="rgba(234,234,234,0.6)" text-anchor="end">points</text>`);
  return `<svg class="nfwp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="GloFAS points by status for each forecast day">${out.join("")}</svg>`;
}

// Line chart with threshold reference lines (warning / danger / extreme).
function _lineChart(series, labels, refs, opts = {}) {
  const W = 340, padL = 44, padR = 8, top = 22, plotH = 120, base = top + plotH, H = base + (opts.sub ? 28 : 18);
  const vals = series.flatMap((s) => s.values).filter(Number.isFinite);
  const refVals = refs.map((r) => r.v).filter(Number.isFinite);
  const showRefs = opts.refsIfWithin ? refVals.filter((v) => v <= Math.max(...vals, 1) * opts.refsIfWithin) : refVals;
  const peak = Math.max(1, ...vals, ...showRefs);
  const step = peak <= 100 ? 25 : peak <= 500 ? 100 : peak <= 2500 ? 500 : peak <= 10000 ? 2000 : peak <= 25000 ? 5000 : 10000;
  const ymax = Math.ceil((peak * 1.05) / step) * step;
  const n = Math.max(labels.length, 2);
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v) => base - (Math.min(v, ymax) / ymax) * plotH;
  const out = [];
  for (let v = step; v <= ymax; v += step) {
    out.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.08)"/><text x="${padL - 5}" y="${y(v) + 3}" font-size="7.5" fill="rgba(234,234,234,0.5)" text-anchor="end">${_fmt(v)}</text>`);
  }
  out.push(`<line x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}" stroke="rgba(255,255,255,0.25)"/>
    <text x="${padL - 5}" y="${top - 10}" font-size="7.5" font-weight="700" fill="rgba(234,234,234,0.6)" text-anchor="end">${_esc(opts.unit || "m³/s")}</text>`);
  for (const r of refs) {
    if (!Number.isFinite(r.v) || r.v > ymax) continue;
    out.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="${r.color}" stroke-dasharray="4 3" stroke-width="1.2"/>
      <text x="${W - padR - 2}" y="${y(r.v) - 2}" font-size="7.5" font-weight="700" fill="${r.color}" text-anchor="end">${_esc(r.label)} ${_fmt(r.v)}</text>`);
  }
  if (Number.isFinite(opts.splitAt)) {
    out.push(`<line x1="${x(opts.splitAt)}" x2="${x(opts.splitAt)}" y1="${top}" y2="${base}" stroke="rgba(255,255,255,0.35)" stroke-dasharray="2 2"/>
      <text x="${x(opts.splitAt) + 3}" y="${top + 8}" font-size="7" fill="rgba(234,234,234,0.6)">forecast →</text>`);
  }
  for (const s of series) {
    const idx = s.values.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
    const pts = idx.map((i) => `${x(i).toFixed(1)},${y(s.values[i]).toFixed(1)}`);
    if (pts.length < 2) continue;
    if (s.fill) out.push(`<polygon points="${x(idx[0]).toFixed(1)},${base} ${pts.join(" ")} ${x(idx[idx.length - 1]).toFixed(1)},${base}" fill="${s.color}" opacity="0.14"/>`);
    out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"${s.dashed ? ' stroke-dasharray="4 3"' : ""}/>`);
  }
  const every = Math.ceil(labels.length / 7);
  const last = labels.length - 1;
  labels.forEach((l, i) => {
    const regular = i % every === 0 && last - i >= every;
    if (!regular && i !== last) return;
    const anchor = i === last ? "end" : i === 0 ? "start" : "middle";
    out.push(`<text x="${x(i)}" y="${base + 11}" font-size="7.5" fill="rgba(234,234,234,0.75)" text-anchor="${anchor}">${_esc(l)}</text>`);
    if (opts.sub?.[i]) out.push(`<text x="${x(i)}" y="${base + 21}" font-size="6.5" fill="rgba(234,234,234,0.45)" text-anchor="${anchor}">${_esc(opts.sub[i])}</text>`);
  });
  const legend = `<div class="nfwp-legend">${series.map((s) => `<span><span class="nfwp-line" style="border-color:${s.color}${s.dashed ? ";border-top-style:dashed" : ""}"></span>${_esc(s.label)}</span>`).join("")}${refs.filter((r) => Number.isFinite(r.v) && r.v <= ymax).map((r) => `<span><span class="nfwp-line" style="border-color:${r.color};border-top-style:dashed"></span>${_esc(r.label)}</span>`).join("")}</div>`;
  return `<svg class="nfwp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${_esc(opts.aria || "Discharge chart")}">${out.join("")}</svg>${legend}`;
}

function _kpis(items) {
  return `<div class="nfwp-grid nfwp-grid--${Math.min(items.length, 4)}">${items.map((k) =>
    `<div class="nfwp-stat"><b${k.color ? ` style="color:${k.color}"` : ""}>${k.html}</b><span>${_esc(k.label)}</span></div>`).join("")}</div>`;
}

function _showIntroPopup() {
  const d = _state.digest || {};
  const stats = _ffdNetworkStats(_state.waypoints);
  const g = d.glofas, h = d.floodhub;
  const gAlerts = g ? (g.counts.warning || 0) + (g.counts.danger || 0) + (g.counts.extreme || 0) : null;
  const hFlood = h ? (h.counts.ABOVE_NORMAL || 0) + (h.counts.SEVERE || 0) + (h.counts.EXTREME || 0) : null;
  _presentPopup(`${_popupHead("About This Briefing", "4 Chapters", 1)}
    <div class="nfwp-body">
      <div class="nfwp-label">Rivers at a glance</div>
      ${_kpis([
        { html: _u(stats.n ? `${stats.alerts.length}/${stats.n}` : "—", "stations"), label: "FFD above normal" },
        { html: _u(g ? `${gAlerts}/${g.points.length - g.unreliable}` : "—", "points"), label: "GloFAS alerting (15 days)" },
        { html: _u(h ? `${hFlood}/${h.gauges.length}` : "—", "gauges"), label: "Flood Hub forecasting flooding" },
        { html: _u(d.inundation ? d.inundation.count : "—", "areas"), label: "modelled inundation" },
      ])}
      <div class="nfwp-label">Chapters</div>
      <div class="nfwp-steps">
        <div><b>1</b> Rivers now — live FFD barrages & dams, river by river</div>
        <div><b>2</b> 15-day outlook — CEMS GloFAS ensemble forecast</div>
        <div><b>3</b> AI river forecasts — Google Flood Hub gauges & inundation</div>
        <div><b>4</b> Why Pakistan floods (research) & national assessment</div>
      </div>
      <div class="nfwp-label">Layers used</div>
      <div class="nfwp-chips">
        <span class="nfwp-chip">FFD Data</span><span class="nfwp-chip">GloFAS Flood Alerts by Forecast Day</span>
        <span class="nfwp-chip">GloFAS — River Discharge Points</span><span class="nfwp-chip">Google Flood Hub — River Gauges</span>
        <span class="nfwp-chip">Google Flood Hub — Inundation Extent</span>
      </div>
      <div class="nfwp-axis-note">${_esc(`GloFAS run ${g?.forecast_date || "n/a"}${g?.run_stale ? " (stale)" : ""} · Flood Hub issued ${h?.issued_time ? _pkt(h.issued_time) : "n/a"} · FFD ${stats.n ? `${stats.n} stations` : "unavailable"}`)}</div>
      ${SRC_FFD}${SRC_IWMI}
    </div>`);
}

function _showFfdIntroPopup(scene) {
  const stats = _ffdNetworkStats(_state.waypoints);
  const byRiver = [..._groupFfdByRiver(_state.waypoints)].map(([river, members]) => ({
    label: river.replace(" River", "").replace(FFD_MAINSTEM_LABEL, "Indus trunk"),
    value: members.reduce((s, wp) => s + (Number.isFinite(wp.reading.outflow) ? wp.reading.outflow : 0), 0),
    color: "#38bdf8",
  })).sort((a, b) => b.value - a.value);
  byRiver.forEach((r) => { r.valueHtml = _u(_fmt(r.value), "cusecs"); });
  _presentPopup(`${_popupHead("FFD Network Snapshot", `${stats.n} stations`, 1)}
    <div class="nfwp-body">
      ${_kpis([
        { html: _u(_fmt(stats.total), "cusecs"), label: "total current flow" },
        { html: _u(stats.alerts.length, "stations"), label: "above normal" },
        { html: _u(`${stats.rising}▲ ${stats.falling}▼`, ""), label: "rising / falling" },
        { html: _pct(stats.medianOfPeak), label: "median share of season peak" },
      ])}
      <div class="nfwp-label">Flood tier, all stations</div>
      ${_stack(FFD_TIERS, stats.counts, "stations")}
      <div class="nfwp-label">Current flow by river</div>
      ${_hBars(byRiver)}
      ${SRC_FFD}
    </div>`);
}

function _showFfdRoutingMapPopup() {
  _presentPopup(`${_popupHead("FFD Flood Routing Map", "Reference", 1)}
    <div class="nfwp-body">
      <img src="${FLOOD_ROUTING_MAP_SRC}" alt="FFD Flood Routing Map — revised lag times, 1990-2020" class="nfwp-routing-map-img" />
      <div class="nfwp-axis-note">Official PMD/FFD flood-routing network — lag times in hours between every gauge, dam and confluence (revised, 1990–2020, approved 23 Jul 2021). The tour that follows walks this same network, river by river.</div>
    </div>`);
}

// The REAL FFD popup (buildFfdPopupContent/setupFfdPopupEventHandlers, the
// same code a map click on an ffd_data gauge uses) with its graph auto-
// opened, plus the station's season and travel-time stats. The FFD
// Discharge Stats modal (30-day history, 14-day regression, GeoGLOWS) is
// opened for the same station; the scene holds (bounded) until it loads.
async function _showFfdBarragePopup(scene, token, seq) {
  const wp = scene.waypoint;
  const props = wp.properties || {};
  const r = wp.reading;
  const modalReady = (async () => {
    try {
      await showFfdModalForStation({
        name: wp.name,
        province: wp.province || "",
        status: props.status || "",
        outflow: Number.isFinite(r.outflow) ? _fmt(r.outflow) : (props.discharge ?? "n/a"),
        inflow: Number.isFinite(r.inflow) ? _fmt(r.inflow) : "n/a",
        lat: wp.center?.[1],
        lon: wp.center?.[0],
      });
    } catch (_) { /* best-effort — a modal hiccup must never crash playback */ }
  })();

  let primary = "", drawer = "";
  try { ({ primary, drawer } = buildFfdPopupContent(props)); } catch (_) { /* best-effort */ }
  const stats = [];
  if (Number.isFinite(r.peak) && r.peak > 0 && Number.isFinite(r.outflow)) {
    stats.push(_hBars([
      { label: "Now", value: r.outflow, color: _tier(props.status).color, valueHtml: _u(_fmt(r.outflow), "cusecs") },
      { label: `Season peak${r.peakDate ? ` (${r.peakDate})` : ""}`, value: r.peak, color: (FFD_TIERS.find((t) => t.key === _ffdStatusKind(r.peakStatus)) || FFD_TIERS[0]).color, valueHtml: _u(_fmt(r.peak), "cusecs") },
    ]));
  }
  const limits = ffdFloodLimitsFor(wp.name);
  if (limits && Number.isFinite(r.outflow)) {
    const flow = Math.max(...[r.outflow, r.inflow].filter(Number.isFinite));
    const tier = ffdLimitTier(flow, limits);
    const spill = ffdSpillState(flow, limits);
    const rows = [{ label: "Now (max of in/out)", value: flow, color: tier.color, valueHtml: _u(_fmt(flow), "cusecs") }];
    if (limits.thresholds.low) rows.push({ label: "FFD low-flood level", value: limits.thresholds.low, color: "#17a2b8", valueHtml: _u(_fmt(limits.thresholds.low), "cusecs") });
    if (limits.design) rows.push({ label: "Design capacity", value: limits.design, color: "#ef4444", valueHtml: _u(_fmt(limits.design), "cusecs") });
    stats.push(`<div class="nfwp-label">Against FFD flood limits</div>${_hBars(rows)}<div class="nfwp-axis-note">${_esc(tier.label)}${spill.share != null ? ` · ${_pct(spill.share)} of design capacity${spill.state === "over" ? " — spill-over" : ""}` : ""} · source: FFD flood-limits table</div>`);
  }
  if (r.from.length) {
    stats.push(`<div class="nfwp-axis-note">Upstream: ${_esc(r.from.map((f, i) => `${f}${Number.isFinite(r.lag[i]) ? ` (${r.lag[i]} h)` : ""}`).join(", "))}</div>`);
  }
  _presentPopup(`
    <div class="ncop-popup__primary"><div class="ncop-popup__primary-content">${primary}</div></div>
    <div class="ncop-popup__body-scroll">
      ${drawer}
      <div class="nfwp-body">
        ${stats.length ? `<div class="nfwp-label">Today vs this season</div>${stats.join("")}` : ""}
        ${_captionBlock(scene.caption)}
        ${SRC_FFD}
      </div>
    </div>`);
  try {
    setupFfdPopupEventHandlers();
    _state.popupEl?.querySelector(".show-ffd-graph")?.click();
  } catch (_) { /* best-effort */ }
  // The stats modal opened before this popup was visible; once the popup has
  // faded in, fit the modal into the strip between it and the story panel.
  setTimeout(() => { try { refitFfdModal(); } catch (_) {} }, 450);
  await _awaitBounded(modalReady, FFD_MODAL_LOAD_TIMEOUT_MS);
  if (_isStale(token, seq)) return;
}

// Every station on the river, not just the featured ones — a quiet river
// never loses a reading, only its dedicated camera time.
function _showFfdRiverOverviewPopup(scene) {
  const rows = (scene.members || []).map((wp) => {
    const r = wp.reading;
    const t = _tier(wp.properties?.status);
    const share = Number.isFinite(r.peak) && r.peak > 0 && Number.isFinite(r.outflow) ? r.outflow / r.peak : null;
    return `<tr>
      <td><span class="nfwp-cat" style="background:${t.color}" title="${_esc(t.label)}"></span>${_esc(wp.name)}</td>
      <td class="num">${Number.isFinite(r.outflow) ? _u(_fmt(r.outflow), "cusecs") : "—"} <span class="nfwp-trend">${_trendGlyph(r.outTrend)}</span></td>
      <td class="num">${share == null ? "—" : `<span class="nfwp-mini"><i style="width:${Math.min(100, share * 100)}%"></i></span>${_pct(share)}`}</td>
    </tr>`;
  }).join("");
  _presentPopup(`${_popupHead(scene.river, `${scene.members.length} station${scene.members.length === 1 ? "" : "s"}`, 1)}
    <div class="nfwp-body">
      ${_captionBlock(scene.caption)}
      <table class="nfwp-table"><thead><tr><th>Station</th><th class="num">Flow now</th><th class="num">Of season peak</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="nfwp-axis-note">▲ rising · ▼ falling · ▬ steady (FFD outflow gauge trend)</div>
      ${SRC_FFD}
    </div>`);
}

function _showFfdAssessmentPopup(scene) {
  const stats = scene.stats || _ffdNetworkStats(_state.waypoints);
  const top = stats.top.slice(0, 10).map((wp) => ({
    label: wp.name, value: wp.reading.outflow, color: _tier(wp.properties?.status).color,
    marker: wp.reading.peak, markerLabel: "season peak", valueHtml: _u(_fmt(wp.reading.outflow), "cusecs"),
  }));
  _presentPopup(`${_popupHead("FFD Network Assessment", stats.alerts.length ? `${stats.alerts.length} above normal` : "All normal", 1,
    stats.alerts.length ? _tier(stats.alerts[0].properties?.status).color : "#28a745")}
    <div class="nfwp-body">
      <div class="nfwp-label">Largest flows now (bar colour = flood tier, tick = season peak)</div>
      ${_hBars(top, { min: Math.max(...stats.top.slice(0, 10).map((w) => w.reading.peak || 0)) })}
      ${_captionBlock(scene.caption)}
      ${_refsLine(["syvitski2013", "tariq2012"])}
      ${SRC_FFD}
    </div>`);
}

function _showGlofasDaysPopup() {
  const g = _state.digest?.glofas;
  if (!g) {
    _presentPopup(`${_popupHead("15-Day Outlook", "Unavailable", 2)}<div class="nfwp-body">${_captionBlock(_glofasDaysNarrative(null))}${SRC_IWMI}</div>`);
    return;
  }
  const reliable = g.points.filter((p) => p.quality !== "unreliable");
  const a = (g.counts.warning || 0) + (g.counts.danger || 0) + (g.counts.extreme || 0);
  const head = reliable.filter((p) => Number.isFinite(p.headroom_ratio)).sort((x, y) => y.headroom_ratio - x.headroom_ratio).slice(0, 6);
  const rows = head.map((p) => ({
    label: `${p.river || "—"} · ${p.id}`, value: p.headroom_ratio * 100,
    color: (GLOFAS_LEVELS.find((l) => l.key === p.status) || GLOFAS_LEVELS[0]).color,
    valueHtml: `${_pct(p.headroom_ratio)} <small class="nfwp-u">d+${p.max_lead}</small>`,
  }));
  _presentPopup(`${_popupHead("15-Day Outlook — Pakistan", g.run_stale ? `Run ${g.forecast_date} · stale` : `Run ${g.forecast_date}`, 2)}
    <div class="nfwp-body">
      ${_kpis([
        { html: _u(reliable.length, "points"), label: "reliable forecast points" },
        { html: _u(a, "points"), label: "reach a threshold ≤15 days", color: a ? "#E7B416" : null },
        { html: _u(g.unreliable, "points"), label: "flagged unreliable" },
        { html: _u(Number.isFinite(g.run_age_days) ? g.run_age_days : "—", "days"), label: "age of the run" },
      ])}
      <div class="nfwp-label">Points by status, each forecast day</div>
      ${_dayStackChart(g.day_counts || [])}
      <div class="nfwp-legend">${GLOFAS_LEVELS.map((l) => `<span><span class="nfwp-cat" style="background:${l.color}"></span>${_esc(l.label)}</span>`).join("")}</div>
      <div class="nfwp-label">Headroom: 15-day peak as a share of the warning level</div>
      ${_hBars(rows, { min: 100 })}
      <div class="nfwp-axis-note">100% = the point's warning threshold (bar scale floor). Status uses the GloFAS rule: worst threshold with ≥${_pct(g.prob_cutoff)} exceedance probability.</div>
      ${_refsLine(["alfieri2013", "harrigan2020", "harrigan2023", "cloke2009"])}
      ${SRC_IWMI}
    </div>`);
}

function _showGlofasPointPopup(scene) {
  const p = scene.point;
  const g = _state.digest?.glofas || {};
  const leads = g.leads || [];
  const lvl = GLOFAS_LEVELS.find((l) => l.key === p.status) || GLOFAS_LEVELS[0];
  const ffd = _nearestFfd(p.lon, p.lat);
  _presentPopup(`${_popupHead(`${p.river || "River"} — GloFAS point ${p.id}`, lvl.label, 2, lvl.color)}
    <div class="nfwp-body">
      ${_kpis([
        { html: _u(_fmt(p.max_q), "m³/s"), label: `15-day peak (day +${p.max_lead})` },
        { html: _u(_fmt(_toCusecs(p.max_q)), "cusecs"), label: "same, in cusecs" },
        { html: _pct(_headroom(p)), label: "of warning level" },
      ])}
      ${_lineChart([{ values: p.q || [], color: "#38bdf8", label: "Ensemble median", fill: true }],
        leads.map((L) => `+${L}`),
        [{ v: p.warning, label: "Warning", color: "#E7B416" }, { v: p.danger, label: "Severe", color: "#E2683C" }, { v: p.extreme, label: "Extreme", color: "#b91c1c" }],
        { sub: leads.map((L) => _shortDay(g.lead_dates?.[String(L)] || "")), refsIfWithin: 4, aria: "15-day discharge forecast" })}
      ${ffd ? `<div class="nfwp-label">Ground check (FFD)</div>${_hBars([
        { label: `${ffd.wp.name} (${_r(ffd.km)} km)`, value: (ffd.wp.reading.outflow || 0) / CUSECS_PER_M3S, color: _tier(ffd.wp.properties?.status).color, valueHtml: _u(_fmt((ffd.wp.reading.outflow || 0) / CUSECS_PER_M3S), "m³/s") },
        { label: "GloFAS day +1 median", value: (p.q || [])[0], color: "#38bdf8", valueHtml: _u(_fmt((p.q || [])[0]), "m³/s") },
      ])}<div class="nfwp-axis-note">Different sites and methods (barrage gauge vs 0.1° model grid): read as an order-of-magnitude check, not a validation.</div>` : ""}
      ${_captionBlock(scene.caption)}
      ${_refsLine(["alfieri2013", "harrigan2023"])}
      ${SRC_IWMI}
    </div>`);
}

function _showFloodhubPopup() {
  const h = _state.digest?.floodhub;
  if (!h) {
    _presentPopup(`${_popupHead("AI River Forecasts", "Unavailable", 3)}<div class="nfwp-body">${_captionBlock(_floodhubNarrative(null))}${SRC_IWMI}</div>`);
    return;
  }
  const f = (h.counts.ABOVE_NORMAL || 0) + (h.counts.SEVERE || 0) + (h.counts.EXTREME || 0);
  const byRiver = {};
  for (const g of h.gauges) byRiver[g.river || "Unnamed"] = (byRiver[g.river || "Unnamed"] || 0) + 1;
  const rivers = Object.entries(byRiver).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([label, value]) => ({ label, value, color: "#14b8a6", valueHtml: _u(value, "gauges") }));
  _presentPopup(`${_popupHead("Google Flood Hub — Pakistan", `${h.gauges.length} gauges`, 3)}
    <div class="nfwp-body">
      ${_kpis([
        { html: _u(h.gauges.length, "gauges"), label: "quality-verified" },
        { html: _u(f, "gauges"), label: "forecasting flooding", color: f ? "#E7B416" : null },
        { html: _u(`${h.trends.RISE || 0}▲ ${h.trends.FALL || 0}▼`, ""), label: "rising / falling" },
      ])}
      <div class="nfwp-label">Severity, all gauges</div>
      ${_stack(FH_LEVELS, h.counts, "gauges")}
      <div class="nfwp-label">Gauges by river</div>
      ${_hBars(rivers)}
      <div class="nfwp-axis-note">Issued ${_esc(h.issued_time ? _pkt(h.issued_time) : "n/a")}. Forecasts run up to 7 days; reliability holds to about 5 days in ungauged basins.</div>
      ${_refsLine(["nearing2024", "nevo2022"])}
      ${SRC_IWMI}
    </div>`);
}

function _gaugeChartHtml(g, series) {
  if (!series) return `<div class="nfwp-axis-note">Discharge series unavailable for this gauge right now.</div>`;
  const hist = (series.history || []).slice(-14);
  const fc = series.forecast || [];
  const all = [...hist, ...fc];
  if (all.length < 2) return `<div class="nfwp-axis-note">No discharge series published for this gauge.</div>`;
  const labels = all.map((x) => _shortDay(x.t));
  const histVals = all.map((x, i) => (i < hist.length ? _num(x.v) : null));
  const fcVals = all.map((x, i) => (i >= hist.length - 1 ? (i < hist.length ? _num(hist[hist.length - 1]?.v) : _num(x.v)) : null));
  return _lineChart(
    [{ values: histVals, color: "#94a3b8", label: "Recent (modelled)" }, { values: fcVals, color: "#14b8a6", label: "Forecast", fill: true }],
    labels,
    [{ v: g.warning, label: "Warning", color: "#E7B416" }, { v: g.danger, label: "Danger", color: "#E2683C" }, { v: g.extreme, label: "Extreme", color: "#b91c1c" }],
    { splitAt: hist.length ? hist.length - 1 : undefined, refsIfWithin: 4, aria: "Flood Hub discharge" });
}

function _showGaugePopup(scene, series, loading = false) {
  const g = scene.gauge;
  const lvl = FH_LEVELS.find((x) => x.key === g.severity) || FH_LEVELS[0];
  const fc = (series?.forecast || []).map((x) => _num(x.v)).filter(Number.isFinite);
  const peak = fc.length ? Math.max(...fc) : null;
  _presentPopup(`${_popupHead(`${g.river || "River"} — Flood Hub gauge`, lvl.label, 3, lvl.color)}
    <div class="nfwp-body">
      ${_kpis([
        { html: _u(_fmt(peak), "m³/s"), label: "forecast peak" },
        { html: Number.isFinite(peak) && g.warning ? _pct(peak / g.warning) : "—", label: "of warning level" },
        { html: _u(String(g.trend || "—").replace(/_/g, " ").toLowerCase(), ""), label: "trend" },
      ])}
      ${loading ? `<div class="nfwp-axis-note">Loading the gauge's discharge series…</div>` : _gaugeChartHtml(g, series)}
      ${_captionBlock(scene.caption)}
      ${_refsLine(["nearing2024", "nevo2022"])}
      ${SRC_IWMI}
    </div>`);
}

function _showInundationPopup(scene) {
  const inund = _state.digest?.inundation;
  _presentPopup(`${_popupHead("Modelled Inundation", inund ? `${inund.count} areas` : "Unavailable", 3)}
    <div class="nfwp-body">
      ${_kpis([
        { html: _u(inund ? inund.count : "—", "areas"), label: "Pakistan" },
        { html: _u(inund ? inund.count_region : "—", "areas"), label: "whole region (13 countries)" },
      ])}
      ${_captionBlock(scene.caption)}
      ${_refsLine(["nevo2022", "tellman2021"])}
      ${SRC_IWMI}
    </div>`);
}

function _showWhyPopup() {
  const cards = WHY_CARDS.map((c) => `
    <div class="nfwp-why">
      <div class="nfwp-why-head"><span aria-hidden="true">${c.icon}</span>${_esc(c.title)}</div>
      <div class="nfwp-why-data">${_hl(_esc(c.text))}</div>
      <div class="nfwp-why-research">${_esc(_cite(...c.refs))}</div>
    </div>`).join("");
  _presentPopup(`${_popupHead("Why Pakistan Floods", "Research", 4)}
    <div class="nfwp-body">
      ${_kpis([
        { html: _u("33", "million"), label: "people affected, 2022" },
        { html: _u(">30", "billion USD"), label: "damages + losses, 2022" },
        { html: _u("~7", "% per °C"), label: "more atmospheric moisture" },
        { html: _u("400", ": 1"), label: "benefit of early warning (EU)" },
      ])}
      ${cards}
    </div>`);
}

function _showAssessmentPopup(scene) {
  const d = _state.digest || {};
  const stats = scene.stats;
  const w = WATCH_LEVELS[scene.level];
  const g = d.glofas, h = d.floodhub;
  const row = (sys, indicator, value, color) =>
    `<tr><td>${_esc(sys)}</td><td>${_esc(indicator)}</td><td class="num"><span class="nfwp-cat" style="background:${color}"></span>${value}</td></tr>`;
  const gA = g ? (g.counts.warning || 0) + (g.counts.danger || 0) + (g.counts.extreme || 0) : null;
  const hF = h ? (h.counts.ABOVE_NORMAL || 0) + (h.counts.SEVERE || 0) + (h.counts.EXTREME || 0) : null;
  const refs = Object.values(REFS).map((r) => `<li>${_esc(r.full)}</li>`).join("");
  _presentPopup(`${_popupHead("National Flood Assessment", `Watch: ${w.label}`, 4, w.color)}
    <div class="nfwp-body">
      <div class="nfwp-level" style="--lvl:${w.color}">
        ${WATCH_LEVELS.map((l, i) => `<span class="${i === scene.level ? "is-on" : ""}" style="background:${l.color}">${_esc(l.label)}</span>`).join("")}
      </div>
      <table class="nfwp-table"><thead><tr><th>System</th><th>Indicator</th><th class="num">Now</th></tr></thead><tbody>
        ${row("FFD", "stations above normal", stats.n ? _u(`${stats.alerts.length}/${stats.n}`, "stations") : "—", stats.alerts.length ? "#fd7e14" : "#28a745")}
        ${row("FFD", "total flow", _u(_fmt(stats.total), "cusecs"), "#38bdf8")}
        ${row("GloFAS", "points reaching a threshold ≤15 d", g ? _u(gA, "points") : "—", gA ? "#E7B416" : "#3FA34D")}
        ${row("Flood Hub", "gauges forecasting flooding", h ? _u(hF, "gauges") : "—", hF ? "#E7B416" : "#3FA34D")}
        ${row("Flood Hub", "modelled inundation", d.inundation ? _u(d.inundation.count, "areas") : "—", d.inundation?.count ? "#2563eb" : "#3FA34D")}
      </tbody></table>
      <div class="nfwp-advice">${_esc(w.action)}</div>
      ${_captionBlock(scene.caption)}
      <details class="nfwp-refs-all"><summary>References (${Object.keys(REFS).length})</summary><ol>${refs}</ol></details>
      ${SRC_FFD}${SRC_IWMI}
    </div>`);
}

// ==========================================================================
// Focus overlay (blinking rings on the points in focus)
// ==========================================================================
function _ensureFocusLayers() {
  const map = window.ncop_map;
  if (!map) return;
  try {
    if (!map.getSource(FOCUS_SRC)) map.addSource(FOCUS_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!map.getLayer(FOCUS_HALO_ID)) {
      map.addLayer({ id: FOCUS_HALO_ID, type: "circle", source: FOCUS_SRC,
                     paint: { "circle-radius": 20, "circle-color": ["coalesce", ["get", "color"], "#38bdf8"], "circle-blur": 0.9, "circle-opacity": 0.35 } });
    }
    if (!map.getLayer(FOCUS_RING_ID)) {
      map.addLayer({ id: FOCUS_RING_ID, type: "circle", source: FOCUS_SRC,
                     paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["coalesce", ["get", "color"], "#38bdf8"],
                              "circle-stroke-width": 3, "circle-stroke-opacity": 0.95 } });
    }
    map.moveLayer(FOCUS_HALO_ID);
    map.moveLayer(FOCUS_RING_ID);
  } catch (_) { /* best-effort */ }
}
// points: [{lon, lat, color?}]
function _setFocus(points) {
  const map = window.ncop_map;
  if (!map) return;
  _ensureFocusLayers();
  try {
    map.getSource(FOCUS_SRC)?.setData({ type: "FeatureCollection", features: points
      .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))
      .map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: { color: p.color || "#38bdf8" } })) });
  } catch (_) { /* best-effort */ }
  _startBlink();
}
function _startBlink() {
  if (_state.blinkTimer) return;
  const map = window.ncop_map;
  if (!map) return;
  _state.blinkTimer = setInterval(() => {
    _state.blinkPhase = !_state.blinkPhase;
    const on = _state.blinkPhase;
    try {
      if (map.getLayer(FOCUS_RING_ID)) {
        map.setPaintProperty(FOCUS_RING_ID, "circle-radius", on ? 19 : 11);
        map.setPaintProperty(FOCUS_RING_ID, "circle-stroke-opacity", on ? 1 : 0.35);
      }
      if (map.getLayer(FOCUS_HALO_ID)) map.setPaintProperty(FOCUS_HALO_ID, "circle-opacity", on ? 0.5 : 0.15);
    } catch (_) { /* best-effort */ }
  }, 420);
}
function _clearFocus() {
  if (_state.blinkTimer) { clearInterval(_state.blinkTimer); _state.blinkTimer = null; }
  const map = window.ncop_map;
  try { map?.getSource(FOCUS_SRC)?.setData({ type: "FeatureCollection", features: [] }); } catch (_) {}
}
function _removeFocusLayers() {
  _clearFocus();
  const map = window.ncop_map;
  if (!map) return;
  for (const id of [FOCUS_RING_ID, FOCUS_HALO_ID]) { try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {} }
  try { if (map.getSource(FOCUS_SRC)) map.removeSource(FOCUS_SRC); } catch (_) {}
}
function _wpFocus(wp) {
  return { lon: wp.center[0], lat: wp.center[1], color: _tier(wp.properties?.status).color === "#28a745" ? "#38bdf8" : _tier(wp.properties?.status).color };
}

// ==========================================================================
// Layers
// ==========================================================================
async function _storyToggleOn(key) {
  const slc = window.sourceLayerControl;
  try {
    const added = await slc?.addLayerByKey?.(key, false);
    if (added) _state.toggledOn.add(key);
  } catch (_) { /* best-effort */ }
}
function _storyToggleOff(key) {
  if (!_state.toggledOn.has(key)) return; // never switch off a layer the operator had on
  try { window.sourceLayerControl?.removeLayerByKey?.(key, false); } catch (_) {}
  _state.toggledOn.delete(key);
}

// Exactly one chapter's layers on the map; idempotent, also used when the
// operator jumps across chapters.
async function _ensureChapterLayers(chapter, token, card) {
  if (_state.layerChapter === chapter) return true;
  _stopLayerTracking(card); // a previous chapter's loader must not linger
  _clearFocus();
  try { hideFfdModal(); } catch (_) {}
  let ok = true;
  if (chapter === 1) {
    [GLOFAS_PTS_KEY, FH_GAUGES_KEY, FH_INUND_KEY].forEach(_storyToggleOff);
    await _deactivateTemporal(GLOFAS_DAYS_KEY);
    await _storyToggleOn(FFD_KEY);
  } else if (chapter === 2) {
    [FFD_KEY, GLOFAS_PTS_KEY, FH_GAUGES_KEY, FH_INUND_KEY].forEach(_storyToggleOff);
    _trackLayerLoading(card, token, GLOFAS_DAYS_KEY, "GloFAS 15-day outlook");
    ok = await _activateTemporal(GLOFAS_DAYS_KEY, "GloFAS flood-alert status by forecast day", token);
  } else if (chapter === 3) {
    [FFD_KEY, GLOFAS_PTS_KEY].forEach(_storyToggleOff);
    await _deactivateTemporal(GLOFAS_DAYS_KEY);
    await _storyToggleOn(FH_GAUGES_KEY);
  } else {
    await _deactivateTemporal(GLOFAS_DAYS_KEY);
    await Promise.all([FFD_KEY, GLOFAS_PTS_KEY, FH_GAUGES_KEY, FH_INUND_KEY].map(_storyToggleOn));
  }
  if (token !== _state.runToken) return false;
  _state.layerChapter = chapter;
  _ensureFocusLayers();
  return ok;
}

function _glofasFrameForLead(lead) {
  return _frameIndex((f) => f.date === `+${lead}d`);
}

// ==========================================================================
// Scene choreography
// ==========================================================================
async function _runIntro(map, scene, token, seq, card) {
  _showIntroPopup();
  enableCinematicAtmosphere(map);
  map.jumpTo(REGIONAL_START);
  // Warm the bulk FFD history the FFD Discharge Stats modal reads (~700 KB,
  // fire-and-forget) so the first barrage popup doesn't wait on it.
  getFfdHistoryAll(30).catch(() => {});
  await Promise.all([
    cinematicFlyTo(map, { center: PAKISTAN_CENTER, zoom: 4.7, pitch: 35, bearing: 0, duration: _dur(4200) }),
    _ensureChapterLayers(1, token, card),
  ]);
  if (_isStale(token, seq)) return;
  await cinematicEaseTo(map, { bearing: 10, pitch: 38, duration: _dur(2000) });
}

async function _runFfdIntro(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  const coords = _state.waypoints.map((wp) => wp.center);
  if (coords.length) {
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    await cinematicFitBounds(map, [[Math.min(...lons) - 0.6, Math.min(...lats) - 0.6], [Math.max(...lons) + 0.6, Math.max(...lats) + 0.6]],
      { pitch: 30, bearing: 0, duration: _dur(2800), maxZoom: 6.4, padding: { top: 60, bottom: 60, left: 400, right: 60 } });
  }
  if (_isStale(token, seq)) return;
  _setFocus(_state.waypoints.map(_wpFocus));
  _showFfdIntroPopup(scene);
}

async function _runFfdRoutingMap(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  _clearFocus();
  _closePopup();
  await cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.6, pitch: 10, bearing: 0, duration: _dur(2000) });
  if (_isStale(token, seq)) return;
  _showFfdRoutingMapPopup();
}

async function _runFfdBarrage(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  const wp = scene.waypoint;
  if (!wp?.center) return;
  _setFocus([_wpFocus(wp)]);
  if (scene.prevWaypoint?.center) {
    // Free-camera flight along a gently bowed arc between consecutive
    // stations (the FFD feed has no channel geometry to trace).
    const arc = _curvedStationPath(scene.prevWaypoint.center, wp.center);
    const straightDeg = _pathLengthDeg([scene.prevWaypoint.center, wp.center]);
    const ratio = straightDeg > 0 ? _pathLengthDeg(arc) / straightDeg : 1;
    const durationMs = Math.min(14000, 6000 * Math.max(1, ratio));
    const pathWaypoints = arc.map((c, i) => ({ center: c, altitude: 12000 + (8000 - 12000) * (i / (arc.length - 1)) }));
    await flyAlongPath(map, pathWaypoints, { durationMs: _dur(durationMs), lookAheadFrac: 0.18 });
  } else {
    await cinematicFlyTo(map, { center: wp.center, zoom: 7.5, pitch: 45, bearing: 0, duration: _dur(2600) });
  }
  if (_isStale(token, seq)) return;
  await orbitAroundPoint(map, wp.center, { durationMs: _dur(3000), radiusMeters: 12000, altitudeMeters: 7000, revolutions: 0.2 });
  if (_isStale(token, seq)) return;
  await _showFfdBarragePopup(scene, token, seq);
}

async function _runFfdRiverOverview(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  _closePopup();
  try { hideFfdModal(); } catch (_) {}
  const coords = (scene.members || []).map((wp) => wp.center).filter(Boolean);
  if (!coords.length) return;
  await _frameDistrictCluster(map, coords, { pitch: 30, bearing: 0, duration: 2800, zoom: 7.2, maxZoom: 8.2 });
  if (_isStale(token, seq)) return;
  _setFocus(scene.members.map(_wpFocus));
  _showFfdRiverOverviewPopup(scene);
}

async function _runFfdAssessment(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  _closePopup();
  try { hideFfdModal(); } catch (_) {}
  const stats = scene.stats;
  _setFocus((stats.alerts.length ? stats.alerts : stats.top.slice(0, 3)).map(_wpFocus));
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(2400) });
  if (_isStale(token, seq)) return;
  _showFfdAssessmentPopup(scene);
}

async function _runGlofasDays(map, scene, token, seq, card) {
  _closePopup();
  await Promise.all([
    cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.9, pitch: 12, bearing: 0, duration: _dur(2000) }),
    _ensureChapterLayers(2, token, card),
  ]);
  if (_isStale(token, seq)) return;
  _showGlofasDaysPopup();
  const defs = _temporal()?.layersDef || [];
  _loopFrames(defs.map((_, i) => i), token, seq);
}

async function _runGlofasPoint(map, scene, token, seq, card) {
  const p = scene.point;
  await _ensureChapterLayers(2, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  _setFrame(_glofasFrameForLead(p.max_lead || 1));
  const lvl = GLOFAS_LEVELS.find((l) => l.key === p.status) || GLOFAS_LEVELS[0];
  _setFocus([{ lon: p.lon, lat: p.lat, color: p.status === "normal" ? "#38bdf8" : lvl.color }]);
  await cinematicFlyTo(map, { center: [p.lon, p.lat], zoom: 8.2, pitch: 48, bearing: (Math.random() * 30) - 15, duration: _dur(3000) });
  if (_isStale(token, seq)) return;
  await orbitAroundPoint(map, [p.lon, p.lat], { durationMs: _dur(3200), radiusMeters: 14000, altitudeMeters: 9000, revolutions: 0.18 });
  if (_isStale(token, seq)) return;
  _showGlofasPointPopup(scene);
}

async function _runFloodhubOverview(map, scene, token, seq, card) {
  _closePopup();
  await Promise.all([
    cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 18, bearing: 0, duration: _dur(2400) }),
    _ensureChapterLayers(3, token, card),
  ]);
  if (_isStale(token, seq)) return;
  const tour = _state.scenes.filter((s) => s.kind === "floodhub-gauge").map((s) => ({ lon: s.gauge.lon, lat: s.gauge.lat, color: "#14b8a6" }));
  if (tour.length) _setFocus(tour);
  _showFloodhubPopup();
}

function _dedupeSeries(rows) {
  const byT = new Map();
  for (const r of rows || []) if (r && r.t) byT.set(r.t, r);
  return [...byT.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
}
function _fetchGaugeSeries(id) {
  if (_state.fhSeries.has(id)) return Promise.resolve(_state.fhSeries.get(id));
  return _fetchJson(FH_DISCHARGE_URL(id))
    .then((d) => {
      const clean = d ? { ...d, history: _dedupeSeries(d.history), forecast: _dedupeSeries(d.forecast) } : null;
      _state.fhSeries.set(id, clean);
      return clean;
    })
    .catch(() => { _state.fhSeries.set(id, null); return null; });
}

async function _runFloodhubGauge(map, scene, token, seq, card) {
  const g = scene.gauge;
  await _ensureChapterLayers(3, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  let seriesDone = false;
  const seriesP = _awaitBounded(_fetchGaugeSeries(g.id), FH_SERIES_TIMEOUT_MS) // fetched while the camera flies
    .then((s) => { seriesDone = true; return s; });
  const lvl = FH_LEVELS.find((x) => x.key === g.severity) || FH_LEVELS[0];
  _setFocus([{ lon: g.lon, lat: g.lat, color: g.severity === "NO_FLOODING" ? "#14b8a6" : lvl.color }]);
  await cinematicFlyTo(map, { center: [g.lon, g.lat], zoom: 8.3, pitch: 48, bearing: (Math.random() * 30) - 15, duration: _dur(3000) });
  if (_isStale(token, seq)) return;
  await orbitAroundPoint(map, [g.lon, g.lat], { durationMs: _dur(3000), radiusMeters: 14000, altitudeMeters: 9000, revolutions: 0.18 });
  if (_isStale(token, seq)) return;
  if (!seriesDone) _showGaugePopup(scene, null, true); // never an empty screen while the series loads
  const series = await seriesP;
  if (_isStale(token, seq)) return;
  // The caption gains the forecast peak once the series is in.
  if (series) {
    scene.caption = _gaugeNarrative(g, scene.rank, series);
    _renderScene(card);
    _speak(_tr(scene.caption));
  }
  _showGaugePopup(scene, series);
}

async function _runInundation(map, scene, token, seq, card) {
  await _ensureChapterLayers(3, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  _clearFocus();
  await _storyToggleOn(FH_INUND_KEY);
  const bbox = _state.digest?.inundation?.bbox;
  if (Array.isArray(bbox) && bbox.length === 4) {
    await cinematicFitBounds(map, [[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { pitch: 30, bearing: 0, duration: _dur(2600), maxZoom: 10 });
  } else {
    await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 15, bearing: 0, duration: _dur(2200) });
  }
  if (_isStale(token, seq)) return;
  _showInundationPopup(scene);
}

async function _runWhy(map, scene, token, seq, card) {
  _closePopup();
  await Promise.all([
    cinematicFlyTo(map, { center: INDUS_PLAIN, zoom: 5.6, pitch: 50, bearing: -10, duration: _dur(3000) }),
    _ensureChapterLayers(4, token, card),
  ]);
  if (_isStale(token, seq)) return;
  _showWhyPopup();
  // Slow drone pass over the Indus plain while the research is on screen.
  await orbitAroundPoint(map, INDUS_PLAIN, { durationMs: _dur(9000), radiusMeters: 160000, altitudeMeters: 260000, revolutions: 0.15 });
}

async function _runAssessment(map, scene, token, seq, card) {
  await _ensureChapterLayers(4, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  const stats = scene.stats;
  _setFocus((stats.alerts.length ? stats.alerts : []).map(_wpFocus));
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 0, bearing: 0, duration: _dur(2600) });
  if (_isStale(token, seq)) return;
  _showAssessmentPopup(scene);
  disableCinematicAtmosphere(map);
}

const RUNNERS = {
  "intro": _runIntro,
  "ffd-intro": _runFfdIntro,
  "ffd-routing-map": _runFfdRoutingMap,
  "ffd-barrage": _runFfdBarrage,
  "ffd-river-overview": _runFfdRiverOverview,
  "ffd-assessment": _runFfdAssessment,
  "glofas-days": _runGlofasDays,
  "glofas-point": _runGlofasPoint,
  "floodhub-overview": _runFloodhubOverview,
  "floodhub-gauge": _runFloodhubGauge,
  "inundation": _runInundation,
  "why-floods": _runWhy,
  "assessment": _runAssessment,
};

async function _enterScene(card, scene, token, seq) {
  _renderScene(card);
  _speak(_tr(scene.caption));
  const map = window.ncop_map;
  if (!map) { await wait(2000); return; }
  try {
    await RUNNERS[scene.kind]?.(map, scene, token, seq, card);
  } catch (e) {
    console.warn("[flood-watch] scene failed:", scene.kind, e); // a camera/layer hiccup must not stall the briefing
  }
}

// ==========================================================================
// Load / show / hide
// ==========================================================================
// Wrapper: a pending export from the story picker is handed to the
// loader; if the loader never reaches it (no data, story closed) the
// pre-opened print window is closed instead of being left blank.
async function _loadAndPlay(card, forceRefresh = false) {
  _state.exportAfterLoad = _state.pendingExport || null;
  _state.pendingExport = null;
  try {
    await _loadAndPlayInner(card, forceRefresh);
  } finally {
    const p = _state.exportAfterLoad;
    _state.exportAfterLoad = null;
    if (p) { try { if (p.win && !p.win.closed) p.win.close(); } catch (_) {} }
  }
}

async function _loadAndPlayInner(card, forceRefresh = false) {
  const token = _state.runToken;
  const useCached = !forceRefresh && _state.loadedOnce && (_state.digest || _state.ffd);
  card.querySelector(".nfw-chapter-title").textContent = LABEL;
  card.querySelector(".nfw-chapter-counter").textContent = "";
  card.querySelector(".nfw-dots").innerHTML = "";
  card.querySelector(".nfw-body").innerHTML = _loadingHtml(forceRefresh
    ? "Refreshing FFD, GloFAS and Flood Hub data…"
    : "Loading live river readings and flood forecasts…");
  if (!useCached) {
    const startedAt = performance.now();
    const loadTimer = setInterval(() => {
      if (token !== _state.runToken) { clearInterval(loadTimer); return; }
      _showLoader(card, "Fetching FFD telemetry, GloFAS outlook and Flood Hub gauges…", null, startedAt);
    }, 250);
    const [digest, ffd] = await Promise.all([
      _fetchJson(WATCH_URL).catch(() => null),
      getFfdWaterlevels().then((fc) => (fc && Array.isArray(fc.features) ? fc : null)).catch(() => null),
    ]);
    clearInterval(loadTimer);
    _hideLoader(card);
    if (token !== _state.runToken) return;
    if (!digest && !ffd) {
      card.querySelector(".nfw-body").innerHTML = `<div class="nfw-status">River and flood-forecast data are unavailable right now. Try Refresh in a few minutes.</div>`;
      return;
    }
    _state.digest = digest;
    _state.ffd = ffd;
    _state.fhSeries = new Map();
    _state.loadedOnce = true;
  }
  _state.waypoints = _buildFfdWaypoints(_state.ffd).map((wp) => ({ ...wp, reading: ffdReading(wp.properties) }));
  _state.scenes = buildScenes(_state.digest, _state.waypoints);
  _state.index = 0;
  _state.layerChapter = 0;
  _setSpeed(1, 1);
  _state.ttsEnabled = false; // every run starts muted, like the other briefings
  _syncMuteButton(card);

  const exportReq = _state.exportAfterLoad;
  if (exportReq) {
    // Opened from the picker's Export: English, no language prompt, no
    // autoplay — export, then rest paused on the first scene.
    _state.exportAfterLoad = null;
    _state.lang = "en";
    _syncLangButton(card);
    _state.isPlaying = false;
    _setPlayGlyph(card, false);
    await _exportReport(exportReq.format, exportReq.win);
    return;
  }
  if (!useCached) {
    const lang = await _showLangPrompt(card);
    if (token !== _state.runToken) return;
    _state.lang = lang;
    _saveLangPref(lang);
    _syncLangButton(card);
    if (lang === "ur") {
      _ensureUrduTranslations(card).then((ok) => { if (ok && _state.lang === "ur") _reapplyLanguage(card); }).catch(() => {});
    }
  }
  _state.isPlaying = true;
  _setPlayGlyph(card, true);
  await _gotoScene(0);
}

function _stopEverything() {
  _state.runToken += 1;
  _pause();
  _closePopup();
  try { hideFfdModal(); } catch (_) {}
  _stopLayerTracking(document.getElementById(CARD_ID));
  _removeFocusLayers();
  const map = window.ncop_map;
  if (map) disableCinematicAtmosphere(map);
  for (const key of [..._state.toggledOn]) _storyToggleOff(key);
  if (_state.activeLayerKey) _deactivateTemporal(_state.activeLayerKey);
  _state.layerChapter = 0;
}

function _show() {
  _injectStyles();
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  if (_state.active) _stopEverything();
  _state.active = true;
  _state.runToken += 1;
  window.ncopProvincialForecast?.hide();
  const card = _ensureCard(root);
  card.style.display = "";
  const chapters = root.querySelector("#storyChapters");
  if (chapters) chapters.style.display = "none";
  _loadAndPlay(card);
}

// Only acts when this story was playing. Restores the 7-Day Outlook unless
// the operator switched straight to another cinematic story.
function _hide() {
  if (!_state.active) return;
  _state.active = false;
  _stopEverything();
  const root = document.getElementById(ROOT_ID);
  const card = root?.querySelector(`#${CARD_ID}`);
  if (card) card.style.display = "none";
  const sel = document.getElementById(SELECT_ID);
  if (OTHER_STORY_SENTINELS.includes(sel?.value)) return;
  const chapters = root?.querySelector("#storyChapters");
  if (chapters) chapters.style.display = "grid";
  window.ncopProvincialForecast?.restore();
}

function _closeCompletely() {
  if (!_state.active) return;
  _state.active = false;
  _stopEverything();
  _removePopup();
  const root = document.getElementById(ROOT_ID);
  const card = root?.querySelector(`#${CARD_ID}`);
  if (card) card.style.display = "none";
  const chapters = root?.querySelector("#storyChapters");
  if (chapters) chapters.style.display = "grid";
}

// ==========================================================================
// Export Report (PDF / Word) — sections from the briefing's own popups and
// narration; renderers in story-report-export.js. Works without playing.
// ==========================================================================
const REPORT_CHAPTERS = Object.fromEntries(CHAPTER_NAMES.map((n, i) => [i, n]));
const REPORT_POPUPS = {
  "intro": () => _showIntroPopup(),
  "ffd-intro": (sc) => _showFfdIntroPopup(sc),
  "ffd-river-overview": (sc) => _showFfdRiverOverviewPopup(sc),
  "ffd-assessment": (sc) => _showFfdAssessmentPopup(sc),
  "glofas-days": () => _showGlofasDaysPopup(),
  "glofas-point": (sc) => _showGlofasPointPopup(sc),
  "floodhub-overview": () => _showFloodhubPopup(),
  "floodhub-gauge": (sc) => _showGaugePopup(sc, _state.fhSeries?.get(sc.gauge?.id) || null, false),
  "inundation": (sc) => _showInundationPopup(sc),
  "why-floods": () => _showWhyPopup(),
  "assessment": (sc) => _showAssessmentPopup(sc),
};
// The forecast day with the most GloFAS points at warning or above.
function _reportPeakLead(d) {
  const days = d?.glofas?.day_counts || [];
  let best = null;
  for (const x of days) {
    const a = (x.warning || 0) + (x.danger || 0) + (x.extreme || 0);
    if (!best || a > best.a) best = { lead: x.lead, a };
  }
  return best?.lead || 1;
}
const REPORT_SHOTS = [
  { key: "map1", chapter: 1, label: "Map: FFD barrages & dams", caption: "FFD barrage and dam network, current flood tier." },
  { key: "map2", chapter: 2, label: "Map: GloFAS outlook, peak day", settleMs: 700,
    prepare: async (d) => { _setFrame(_glofasFrameForLead(_reportPeakLead(d))); },
    caption: (d) => `GloFAS flood-alert status on forecast day +${_reportPeakLead(d)} (the day with the most points at warning or above).` },
  { key: "map3", chapter: 4, label: "Map: all flood layers", settleMs: 500,
    caption: "FFD stations, GloFAS points, Flood Hub gauges and modelled inundation together." },
];
function _reportMeta(d) {
  const g = d?.glofas, h = d?.floodhub;
  return {
    title: LABEL,
    subtitle: "Rivers now (FFD) · 15-day outlook (GloFAS) · AI gauges (Flood Hub) · assessment",
    strip: [
      { label: "Issued", value: new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
      { label: "GloFAS run", value: g?.forecast_date || "n/a" },
      { label: "Flood Hub issued", value: h?.issued_time ? _pkt(h.issued_time) : "n/a" },
      { label: "Reference", value: `NDMA/NCOP/NFW/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}` },
    ],
    glossary: [
      { term: "FFD", def: "Flood Forecasting Division of the Pakistan Meteorological Department. It measures river flow at the main barrages and dams several times a day." },
      { term: "Cusecs", def: "Cubic feet per second: how much water passes a point every second. 100,000 cusecs is about 2,830 cubic metres per second." },
      { term: "Flood tiers", def: "FFD's official levels for each river site (Low, Medium, High, Very High, Exceptionally High). Each has a fixed flow limit." },
      { term: "GloFAS", def: "Copernicus Global Flood Awareness System: a European computer forecast of river flow for the next 15 days." },
      { term: "Ensemble / probability", def: "The forecast is run many times with small changes. \"30% probability\" means 30 of every 100 runs reach that level." },
      { term: "Warning / Severe / Extreme (GloFAS)", def: "Flows seen on average about once every 2, 5 and 20 years. The rarer the flow, the more serious the flood." },
      { term: "Google Flood Hub", def: "Google's AI forecasts of river level at individual gauges, up to about a week ahead, shared through IWMI." },
      { term: "Discharge", def: "River flow, in cubic metres per second (m³/s)." },
      { term: "Inundation map", def: "Modelled areas that would be under water if the forecast flood happens." },
    ],
    footer: "Sources: PMD Federal Flood Commission (FFD), CEMS GloFAS (Copernicus) and Google Flood Forecasting via IWMI, peer-reviewed research.",
  };
}

// Run a scene's popup builder with its output redirected into the report.
function _reportPopupHtml(scene) {
  const fn = REPORT_POPUPS[scene.kind];
  if (!fn) return "";
  let html = "";
  const present = _presentPopup;
  _presentPopup = (h) => { html = h; };
  try { fn(scene); } catch (e) { console.warn("[flood-watch] report popup failed:", scene.kind, e); } finally { _presentPopup = present; }
  return html;
}

let _exporting = false;
async function _exportReport(format, win) {
  const card = document.getElementById(CARD_ID);
  // Not ready: still loading, or the narration-language prompt is open (the
  // load flow is waiting on it and must not be interrupted).
  const prompting = !!card?.querySelector('[class$="-prompt"]');
  if (_exporting || !_state.digest || !_state.scenes.length || prompting) {
    try { if (win && !win.closed) win.close(); } catch (_) {}
    notifyCard(card, _exporting ? "An export is already running."
      : prompting ? "Choose a narration language first, then export."
      : "Briefing data is still loading — try again in a moment.");
    return;
  }
  _exporting = true;
  const narrationLang = _state.lang;
  _state.lang = "en"; // reports are always in English
  const map = window.ncop_map;
  const cam = map ? { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() } : null;
  _pause();
  _closePopup();
  try { hideFfdModal(); } catch (_) {}
  _clearFocus();
  _state.runToken += 1;          // stops any running scene choreography
  const token = _state.runToken;
  const d = _state.digest;
  try {
    await runStoryExport({
      format, win, card, slug: "national-flood-watch", meta: _reportMeta(d),
      steps: [{ key: "data", label: "Briefing data" }, ...REPORT_SHOTS.map((s) => ({ key: s.key, label: s.label }))],
      build: async ({ run, mark }) => {
        run("data"); mark("data");
        const shots = {};
        for (const s of REPORT_SHOTS) {
          run(s.key);
          let src = null;
          if (map) {
            try {
              await _ensureChapterLayers(s.chapter, token, card);
              await s.prepare?.(d);
              map.fitBounds(PAKISTAN_BOUNDS, { duration: 0, padding: 30, pitch: 0, bearing: 0 });
              src = await captureMap(map, { settleMs: s.settleMs || 300 });
            } catch (e) { console.warn("[flood-watch] report capture failed:", s.key, e); }
          }
          (shots[s.chapter] ||= []).push({ src, caption: typeof s.caption === "function" ? s.caption(d) : s.caption });
          mark(s.key, src ? "ok" : "warn");
        }
        return scenesToSections({ scenes: _state.scenes, chapterNames: REPORT_CHAPTERS, titleOf: _sceneTitle, popupOf: _reportPopupHtml, shots });
      },
    });
  } finally {
    try { hideFfdModal(); } catch (_) {}
  _clearFocus();
    _state.layerChapter = 0;
    if (cam && map) { try { map.jumpTo(cam); } catch (_) {} }
    _state.lang = narrationLang;
    _exporting = false;
    if (_state.active && _state.scenes.length) {
      _setPlayGlyph(card, false);
      _gotoScene(_state.index); // back to where the operator was, paused
    }
  }
}

const EXTRA_CSS = `
    #${CARD_ID} .nfw-dot.is-ch1 { background: rgba(56, 189, 248, 0.25); }
    #${CARD_ID} .nfw-dot.is-ch2 { background: rgba(231, 180, 22, 0.25); }
    #${CARD_ID} .nfw-dot.is-ch3 { background: rgba(20, 184, 166, 0.25); }
    #${CARD_ID} .nfw-dot.is-ch4 { background: rgba(196, 181, 253, 0.25); }
    #${CARD_ID} .nfw-dot.is-ch1.is-active { background: #38bdf8; }
    #${CARD_ID} .nfw-dot.is-ch2.is-active { background: #E7B416; }
    #${CARD_ID} .nfw-dot.is-ch3.is-active { background: #14b8a6; }
    #${CARD_ID} .nfw-dot.is-ch4.is-active { background: #c4b5fd; }
    #${CARD_ID} .nfw-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(48px, 1fr)); gap: 3px; }
    #${CARD_ID} .nfw-legend-note { margin-top: 4px; font-size: 9px; color: rgba(234, 234, 234, 0.6); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    #${CARD_ID} .nfw-ring { display: inline-block; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #fff; }
    #${CARD_ID} .nfw-ring.is-rise { border-color: #dc2626; }
    #${CARD_ID} .nfw-ring.is-fall { border-color: #2563eb; }
    #${CARD_ID} .nfw-hl-key i { border: 2px solid #38bdf8; animation: nfw-pulse 0.84s ease-in-out infinite; }
    #${POPUP_ID} .nfwp-head.is-ch1 { background: linear-gradient(90deg, rgba(2, 132, 199, 0.42), rgba(20, 184, 166, 0.1)); }
    #${POPUP_ID} .nfwp-head.is-ch2 { background: linear-gradient(90deg, rgba(231, 180, 22, 0.34), rgba(2, 132, 199, 0.1)); }
    #${POPUP_ID} .nfwp-head.is-ch3 { background: linear-gradient(90deg, rgba(20, 184, 166, 0.4), rgba(2, 132, 199, 0.1)); }
    #${POPUP_ID} .nfwp-head.is-ch4 { background: linear-gradient(90deg, rgba(124, 58, 237, 0.36), rgba(2, 132, 199, 0.12)); }
    #${POPUP_ID} .nfwp-grid--2 { grid-template-columns: repeat(2, 1fr); }
    #${POPUP_ID} .nfwp-grid--3 { grid-template-columns: repeat(3, 1fr); }
    #${POPUP_ID} .nfwp-hbars { display: grid; gap: 4px; margin: 4px 0 6px; }
    #${POPUP_ID} .nfwp-hbar { display: grid; grid-template-columns: 112px 1fr auto; align-items: center; gap: 7px; font-size: 10.5px; }
    #${POPUP_ID} .nfwp-hbar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(234, 234, 234, 0.85); }
    #${POPUP_ID} .nfwp-hbar-track { position: relative; height: 9px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); }
    #${POPUP_ID} .nfwp-hbar-track i { display: block; height: 100%; border-radius: 999px; animation: nfw-grow 0.9s ease-out; transform-origin: left; }
    #${POPUP_ID} .nfwp-hbar-marker { position: absolute; top: -3px; width: 2px; height: 15px; background: #fff; opacity: 0.8; border-radius: 1px; }
    #${POPUP_ID} .nfwp-hbar-value { font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; white-space: nowrap; }
    #${POPUP_ID} .nfwp-mini { display: inline-block; width: 38px; height: 6px; margin-right: 5px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); overflow: hidden; vertical-align: 1px; }
    #${POPUP_ID} .nfwp-mini i { display: block; height: 100%; background: #38bdf8; }
    #${POPUP_ID} .nfwp-trend { font-size: 9px; color: rgba(234, 234, 234, 0.7); }
    #${POPUP_ID} .nfwp-steps { display: grid; gap: 4px; font-size: 11px; }
    #${POPUP_ID} .nfwp-steps b { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-right: 6px; border-radius: 50%; background: rgba(56, 189, 248, 0.25); color: #fff; font-size: 9.5px; }
    #${POPUP_ID} .nfwp-routing-map-img { width: 100%; height: auto; display: block; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.12); margin-bottom: 8px; }
    #${POPUP_ID} .nfwp-refs { margin-top: 6px; font-size: 9.5px; color: rgba(125, 211, 252, 0.85); font-style: italic; }
    #${POPUP_ID} .nfwp-level { display: flex; gap: 3px; margin: 2px 0 8px; }
    #${POPUP_ID} .nfwp-level span { flex: 1; text-align: center; padding: 4px 0; border-radius: 6px; font-size: 9.5px; font-weight: 800; color: #fff; opacity: 0.28; }
    #${POPUP_ID} .nfwp-level span.is-on { opacity: 1; box-shadow: 0 0 0 2px #fff inset, 0 4px 12px rgba(0, 0, 0, 0.35); animation: nfw-pulse 1.6s ease-in-out infinite; }
    #${POPUP_ID} .nfwp-refs-all { margin-top: 8px; font-size: 10px; color: rgba(234, 234, 234, 0.75); }
    #${POPUP_ID} .nfwp-refs-all summary { cursor: pointer; font-weight: 700; color: #7dd3fc; }
    #${POPUP_ID} .nfwp-refs-all ol { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 3px; }
`;

// Pure builders, exported for tests.
export const _test = { buildScenes, ffdReading, watchLevel, pickGlofasTour: _pickGlofasTour, pickGaugeTour: _pickGaugeTour, refs: REFS };

// Story picker's Export button: open this briefing in export-only mode.
function _exportFromPicker(format, win) {
  const sel = document.getElementById(SELECT_ID);
  if (!sel || _exporting) { try { if (win && !win.closed) win.close(); } catch (_) {} return false; }
  _state.pendingExport = { format, win };
  sel.value = SENTINEL;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

window.ncopFloodWatch = {
  closeAll: _closeCompletely,
  exportReport: _exportFromPicker,
};

export function initStoryFloodWatch() {
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
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initStoryFloodWatch);
  else initStoryFloodWatch();
}
