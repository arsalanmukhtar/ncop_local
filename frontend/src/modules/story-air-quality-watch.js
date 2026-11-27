// ==========================================================================
// story-air-quality-watch.js
// --------------------------------------------------------------------------
// National Air Quality Watch — a cinematic story selectable from
// #storySelect, next to "7-Day Weather Outlook" (story-provincial-
// forecast.js) and "Dynamic Weather Report" (story-dynamic-weather.js).
// Same integration and playback model as the Dynamic Weather Report:
//   - an injected sentinel <option> (re-injected by a MutationObserver
//     whenever StoryManager in map-controls.js rebuilds the select);
//   - a capture-phase "change" listener on #storySelect;
//   - the 7-Day Outlook is paused/hidden through its public hook
//     (window.ncopProvincialForecast) while this story plays;
//   - a card in #story-root with play/pause, prev/next, FF/RW (1x-5x),
//     scene dots, optional narration (speechSynthesis) and Urdu captions
//     via /api/translate/.
// This file shares no state with the other two stories.
//
// CHAPTER 1 — The Past Week (observed):
//   temporal hawanama_pm25_estimate (daily ML estimate, last 7 frames) +
//   toggle hawanama_stations (live PM2.5 stations). The camera tours the
//   week's worst multi-station cities, setting the estimate to each city's
//   own peak day, blinking its district and stations.
// CHAPTER 2 — The Outlook (forecast):
//   temporal hawanama_pm25_forecast (+3..+72 h, beta) + toggle
//   waqi_stations (live WAQI AQI, used as the ground reference next to
//   the forecast). The camera tours the cities with the highest forecast
//   peak, setting the forecast to the peak lead.
//
// Every number comes from GET /api/hawanama/watch/ (hawanama_client.
// air_quality_watch: station daily means per city for the last 7
// complete days, the daily drivers — Open-Meteo wind / mixing height over
// the Punjab plain and VIIRS crop-fire counts — the live station snapshot,
// and the forecast grid sampled per city) and the WAQI layer's own
// GeoJSON. Every scene with layers on shows their legends (temporal colour
// scale from temporal-layer-legends.js + the point layer's US AQI steps). Reference values
// the narration cites:
//   WHO Air Quality Guidelines (2021): PM2.5 24-h 15 µg/m³, annual 5.
//   Pakistan NEQS ambient air (2010): PM2.5 24-h 35 µg/m³, annual 15.
//   US EPA AQI PM2.5 breakpoints (2024): 9.0/35.4/55.4/125.4/225.4.
//   Liu et al., NEJM 2019 (652 cities): +0.68 % daily all-cause
//     mortality per +10 µg/m³ PM2.5.
//   AQLI (EPIC, U. Chicago) 2024 fact sheet: meeting the WHO guideline
//     would add 5.3 years of life expectancy in Lahore, 4.6 in Islamabad;
//     3.9 years for the average Pakistani (AQLI 2023).
//   Berkeley Earth (Muller 2015): 22 µg/m³ for a day ≈ 1 cigarette.
// Hawanama's forecast horizon is 72 h; the story says so rather than
// presenting it as a 7-day forecast.
// ==========================================================================

import { handleTemporalInteraction } from "./mapbox-functions.js";
import { legends as TEMPORAL_LEGENDS } from "./temporal-layer-legends.js";
import {
  wait,
  cinematicFlyTo,
  cinematicEaseTo,
  cinematicFitBounds,
  fadeLayerOpacity,
  enableCinematicAtmosphere,
  disableCinematicAtmosphere,
  orbitAroundPoint,
} from "./story-cinematic-engine.js";
import { mountExportButton, runStoryExport, captureMap, scenesToSections, notifyCard } from "./story-report-export.js";
import { aqiScale, aqiText, aqiHeadline, rankedCities, spreadCities, airQualityReportSections, airQualityReportMeta } from "./story-air-quality-report.js";

const MODAL_ID  = "story-modal";
const ROOT_ID   = "story-root";
const SELECT_ID = "storySelect";
const SENTINEL  = "__air_quality_watch__";
const LABEL     = "National Air Quality Watch";
const DWR_SENTINEL = "__dynamic_weather__";
const CARD_ID   = "ncop-air-quality-watch";
const POPUP_ID  = "ncop-air-quality-watch-popup";
const STYLE_ID  = "ncop-air-quality-watch-style";

const EST_KEY  = "hawanama_pm25_estimate";
// Story-scoped variant of the same layer: newest 7 days only (registered in
// hawanama-layers.js), so 7 frames load instead of 30. Falls back to the
// full layer if the variant isn't registered.
const EST_WEEK_KEY = "hawanama_pm25_estimate_week";
function _estKey() {
  return window[EST_WEEK_KEY] ? EST_WEEK_KEY : EST_KEY;
}
const STN_KEY  = "hawanama_stations";
const FC_KEY   = "hawanama_pm25_forecast";
const WAQI_KEY = "waqi_stations";
const STN_SRC  = "hawanama_stations-source";
const WAQI_SRC = "waqi_stations-source";
const WATCH_URL = "/api/hawanama/watch/?days=7";
const WAQI_URL  = "/get-waqi-global-airquality/";

const DIST_SRC       = "district_boundary-source";
const DIST_SRC_LAYER = "district_boundary";
const HL_DIST_FILL_ID = "_ncop_aqw_hl_dist_fill";
const HL_DIST_LINE_ID = "_ncop_aqw_hl_dist_line";
const HL_STN_ID       = "_ncop_aqw_hl_stations";
const HL_WAQI_ID      = "_ncop_aqw_hl_waqi";
const DIST_NAME_KEYS = ["district", "district_name", "districtname", "DISTRICT", "DISTRICT_NAME", "name", "NAME"];
const NEVER = ["has", "___ncop_never___"];

const PAKISTAN_CENTER = [70.2, 30.2];
const REGIONAL_START  = { center: [78, 22], zoom: 3.0, pitch: 0, bearing: 0 };
const PAKISTAN_BOUNDS = [[60.8, 23.6], [77.9, 37.1]];

// Literature reference values (see header).
const WHO_24H = 15;
const WHO_ANNUAL = 5;
const NEQS_24H = 35;
const AQLI_GAIN = { lahore: 5.3, islamabad: 4.6 };
const AQLI_NATIONAL = 3.9;
const EPA = [
  { key: "good",           max: 9.0,      label: "Good",                           color: "#00e400" },
  { key: "moderate",       max: 35.4,     label: "Moderate",                       color: "#ffff00" },
  { key: "usg",            max: 55.4,     label: "Unhealthy for Sensitive Groups", color: "#ff7e00" },
  { key: "unhealthy",      max: 125.4,    label: "Unhealthy",                      color: "#ff0000" },
  { key: "very_unhealthy", max: 225.4,    label: "Very Unhealthy",                 color: "#8f3f97" },
  { key: "hazardous",      max: Infinity, label: "Hazardous",                      color: "#7e0023" },
];
// US EPA AQI health messaging for PM2.5, by category.
const EPA_ADVICE = {
  good: "Air quality is satisfactory; no precautions needed.",
  moderate: "Unusually sensitive people should consider reducing prolonged or heavy outdoor exertion.",
  usg: "Children, older adults and people with heart or lung disease should reduce prolonged or heavy outdoor exertion.",
  unhealthy: "Sensitive groups should avoid prolonged or heavy exertion; everyone else should reduce it.",
  very_unhealthy: "Sensitive groups should avoid all physical activity outdoors; everyone else should avoid prolonged or heavy exertion.",
  hazardous: "Everyone should avoid all physical activity outdoors; sensitive groups should stay indoors and keep activity levels low.",
};
const METROS = ["Lahore", "Karachi", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Quetta",
  "Gujranwala", "Hyderabad", "Sialkot", "Bahawalpur"];

const PAST_TOUR_MAX = 5;
const FC_TOUR_MAX = 4;
const WAQI_NEAR_KM = 40;
const DWELL_MS_NO_TTS = 6500;
const SPEED_LEVELS = [1, 2, 3, 4, 5];
const FRAME_STEP_MS = 1600;

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
  digest: null,
  waqi: null,
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
  layerChapter: 0,      // which chapter's layers are currently on (0 = none)
  activeLayerKey: null, // temporal item this story activated
  loaderTimer: null,    // frame-loading progress poll
};

// ---- Small helpers --------------------------------------------------------
function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const HIGHLIGHT_RE = /(\d+(?:\.\d+)?\s?(?:µg\/m³|%|×|years|h\b))/g;
function _hl(escaped) {
  return String(escaped || "").replace(HIGHLIGHT_RE, '<mark class="aqw-hl">$1</mark>');
}
function _r(v, d = 0) {
  return Number.isFinite(v) ? Number(v).toFixed(d) : "—";
}
function _epa(v) {
  if (!Number.isFinite(v)) return null;
  return EPA.find((c) => v <= c.max) || EPA[EPA.length - 1];
}
// A value with its unit attached (unit rendered smaller, same line).
function _u(value, unit) {
  return `${value}<small class="aqwp-u">${_esc(unit)}</small>`;
}
function _pct(share) {
  return Number.isFinite(share) ? `${Math.round(share * 100)}%` : "—";
}
function _dayLabel(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}
function _shortDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
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
function _isSmogSeason(date = new Date()) {
  const m = date.getUTCMonth(); // Oct-Feb
  return m >= 9 || m <= 1;
}

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
  card?.querySelector(".aqw-lang")?.classList.add("is-loading");
  _translateInFlight = (async () => {
    let ok = false;
    for (let i = 0; i < missing.length; i += TRANSLATE_CHUNK_SIZE) {
      const chunk = missing.slice(i, i + TRANSLATE_CHUNK_SIZE);
      try {
        const out = await _translateBatch(chunk);
        chunk.forEach((t, j) => _translationCache.set(t, out[j]));
        ok = true;
      } catch (e) {
        console.warn("[aq-watch] Urdu translation chunk failed:", e);
      }
    }
    return ok;
  })().finally(() => {
    card?.querySelector(".aqw-lang")?.classList.remove("is-loading");
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
    const body = card.querySelector(".aqw-body");
    if (!body) { resolve("en"); return; }
    const last = _loadLangPref();
    body.innerHTML = `
      <div class="aqw-prompt" role="dialog" aria-labelledby="aqw-lang-title">
        <div class="aqw-prompt-icon" aria-hidden="true">🌐</div>
        <div id="aqw-lang-title" class="aqw-prompt-title">Choose a Language</div>
        <div class="aqw-prompt-desc">Language for this briefing's narrative text and voice narration. You can switch anytime from the header.</div>
        <div class="aqw-prompt-buttons">
          <button type="button" class="aqw-prompt-btn${last === "en" ? " is-primary" : ""}" data-choice="en">English</button>
          <button type="button" class="aqw-prompt-btn${last === "ur" ? " is-primary" : ""}" data-choice="ur">اردو</button>
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
      background: linear-gradient(135deg, rgba(167, 139, 250, 0.18), rgba(245, 158, 11, 0.06));
      border: 1px solid rgba(167, 139, 250, 0.38);
      border-radius: 10px; color: #eaeaea; font-size: 12.5px; line-height: 1.5;
    }
    #${CARD_ID} .aqw-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    #${CARD_ID} .aqw-title {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #c4b5fd;
    }
    #${CARD_ID} .aqw-live {
      width: 7px; height: 7px; border-radius: 50%; background: #a78bfa;
      box-shadow: 0 0 0 2px rgba(167, 139, 250, 0.3); animation: aqw-pulse 1.6s ease-in-out infinite;
    }
    @keyframes aqw-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.7); } }
    #${CARD_ID} .aqw-head-actions { display: flex; align-items: center; gap: 6px; }
    #${CARD_ID} .aqw-icon-btn {
      appearance: none; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; font-size: 12px; line-height: 1;
      color: rgba(234, 234, 234, 0.65); background: rgba(255, 255, 255, 0.06); border-radius: 999px;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${CARD_ID} .aqw-icon-btn:hover { background: rgba(167, 139, 250, 0.28); color: #fff; }
    #${CARD_ID} .aqw-close:hover { background: rgba(220, 38, 38, 0.25); }
    #${CARD_ID} .aqw-mute.is-muted { color: rgba(234, 234, 234, 0.35); }
    #${CARD_ID} .aqw-refresh:disabled { opacity: 0.6; cursor: default; }
    #${CARD_ID} .aqw-refresh.is-spinning svg { animation: aqw-spin 0.9s linear infinite; }
    #${CARD_ID} .aqw-lang {
      appearance: none; cursor: pointer; padding: 3px 9px; border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.06);
      font-size: 10.5px; font-weight: 600; line-height: 1; color: rgba(234, 234, 234, 0.8);
    }
    #${CARD_ID} .aqw-lang.is-active { background: rgba(167, 139, 250, 0.3); color: #fff; }
    #${CARD_ID} .aqw-lang.is-loading { opacity: 0.55; pointer-events: none; }
    .aqw-lang-ur {
      direction: rtl; text-align: right;
      font-family: "Noto Nastaliq Urdu", "Segoe UI", Tahoma, "Noto Naskh Arabic", sans-serif;
      font-size: 1.05em; line-height: 1.9;
    }
    #${CARD_ID} .aqw-chapter-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    #${CARD_ID} .aqw-chapter-title { font-size: 14px; font-weight: 800; color: #fff; }
    #${CARD_ID} .aqw-chapter-counter { font-size: 10.5px; color: rgba(234, 234, 234, 0.55); white-space: nowrap; font-variant-numeric: tabular-nums; }
    #${CARD_ID} .aqw-body { min-height: 40px; }
    #${CARD_ID} .aqw-status { display: flex; align-items: center; gap: 8px; padding: 12px 4px; font-size: 12px; color: rgba(234, 234, 234, 0.85); }
    #${CARD_ID} .aqw-spinner {
      width: 13px; height: 13px; border-radius: 50%; flex: 0 0 auto;
      border: 2px solid rgba(167, 139, 250, 0.25); border-top-color: #a78bfa; animation: aqw-spin 0.8s linear infinite;
    }
    @keyframes aqw-spin { to { transform: rotate(360deg); } }
    #${CARD_ID} .aqw-caption { font-size: 12.5px; line-height: 1.6; animation: aqw-in 0.5s ease; }
    @keyframes aqw-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    #${CARD_ID} mark.aqw-hl, #${POPUP_ID} mark.aqw-hl {
      background: rgba(167, 139, 250, 0.24); color: #fff; font-weight: 800;
      padding: 0 4px; border-radius: 4px; -webkit-box-decoration-break: clone; box-decoration-break: clone;
    }
    #${CARD_ID} .aqw-facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    #${CARD_ID} .aqw-pill {
      font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px;
      background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12);
    }
    #${CARD_ID} .aqw-pill.is-alert { background: rgba(220, 38, 38, 0.18); border-color: rgba(248, 113, 113, 0.4); color: #fca5a5; }
    #${CARD_ID} .aqw-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
    #${CARD_ID} .aqw-legend { margin-top: 8px; padding: 8px 9px; border-radius: 8px;
      background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255, 255, 255, 0.08); display: grid; gap: 8px; }
    #${CARD_ID} .aqw-legend-title { font-size: 10.5px; font-weight: 700; color: #eaeaea; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    #${CARD_ID} .aqw-legend-title small { font-weight: 400; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .aqw-legend-kind { font-size: 8.5px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
      padding: 1px 6px; border-radius: 999px; background: rgba(167, 139, 250, 0.22); color: #ddd6fe; }
    #${CARD_ID} .aqw-legend-scale { padding: 0 2px 12px; }
    #${CARD_ID} .aqw-legend-scale .ts-legend-stack { width: 100%; }
    #${CARD_ID} .aqw-legend-scale .ts-legend-values span { font-size: 9px; white-space: nowrap; }
    #${CARD_ID} .aqw-steps { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; }
    #${CARD_ID} .aqw-step { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 8.5px; color: rgba(234, 234, 234, 0.7); }
    #${CARD_ID} .aqw-step i { display: block; width: 100%; height: 8px; border-radius: 2px; }
    #${CARD_ID} .aqw-legend-row--hl { display: flex; flex-wrap: wrap; gap: 4px 12px; }
    #${CARD_ID} .aqw-hl-key { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; color: rgba(234, 234, 234, 0.7); }
    #${CARD_ID} .aqw-hl-key i { display: inline-block; width: 12px; height: 12px; border-radius: 50%; }
    #${CARD_ID} .aqw-hl-key i.is-district { border-radius: 2px; border: 2px solid #a78bfa; background: rgba(196, 181, 253, 0.2); animation: aqw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .aqw-hl-key i.is-station { border: 2px solid #fff; animation: aqw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .aqw-hl-key i.is-waqi { border: 2px solid #fbbf24; animation: aqw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .aqw-loader {
      display: flex; align-items: center; gap: 9px; margin-top: 8px; padding: 7px 9px; border-radius: 8px;
      background: rgba(167, 139, 250, 0.1); border: 1px solid rgba(167, 139, 250, 0.28); animation: aqw-in 0.3s ease;
    }
    #${CARD_ID} .aqw-loader[hidden] { display: none; }
    #${CARD_ID} .aqw-loader-main { flex: 1 1 auto; min-width: 0; }
    #${CARD_ID} .aqw-loader-text { font-size: 10.5px; color: rgba(234, 234, 234, 0.85); margin-bottom: 4px; }
    #${CARD_ID} .aqw-loader-bar { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); overflow: hidden; position: relative; }
    #${CARD_ID} .aqw-loader-bar i { display: block; height: 100%; width: 0; border-radius: 999px;
      background: linear-gradient(90deg, #a78bfa, #f59e0b); transition: width 0.3s ease; }
    #${CARD_ID} .aqw-loader-bar.is-indeterminate i { width: 35% !important; animation: aqw-indet 1.1s ease-in-out infinite; }
    @keyframes aqw-indet { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
    #${CARD_ID} .aqw-loader-time { font-size: 10px; color: rgba(234, 234, 234, 0.55); font-variant-numeric: tabular-nums; min-width: 32px; text-align: right; }
    #${CARD_ID} .aqw-loader.is-done { background: rgba(34, 197, 94, 0.1); border-color: rgba(34, 197, 94, 0.35); }
    #${CARD_ID} .aqw-loader.is-done .aqw-spinner { animation: none; border-color: #22c55e; }
    #${CARD_ID} .aqw-loader.is-done .aqw-loader-bar i { background: #22c55e; }
    #${CARD_ID} .aqw-layer-loading { margin-top: 6px; font-size: 11px; font-style: italic; color: rgba(234, 234, 234, 0.6); }
    #${CARD_ID} .aqw-progress-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    #${CARD_ID} .aqw-progress-track { flex: 1 1 auto; height: 3px; background: rgba(255, 255, 255, 0.08); border-radius: 999px; overflow: hidden; }
    #${CARD_ID} .aqw-progress-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #a78bfa, #f59e0b); transition: width 0.2s linear; }
    #${CARD_ID} .aqw-progress-timer { min-width: 38px; text-align: right; font-size: 10px; color: rgba(234, 234, 234, 0.55); font-variant-numeric: tabular-nums; }
    #${CARD_ID} .aqw-transport { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
    #${CARD_ID} .aqw-btn {
      appearance: none; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; color: #eaeaea; background: rgba(255, 255, 255, 0.06); border-radius: 999px;
      transition: background 0.15s ease;
    }
    #${CARD_ID} .aqw-btn:hover { background: rgba(167, 139, 250, 0.28); }
    #${CARD_ID} .aqw-btn svg { width: 14px; height: 14px; }
    #${CARD_ID} .aqw-btn--rw, #${CARD_ID} .aqw-btn--ff { width: auto; min-width: 26px; padding: 0 7px; gap: 3px; }
    #${CARD_ID} .aqw-speed { font-size: 9.5px; font-weight: 800; }
    #${CARD_ID} .aqw-btn.is-active { background: rgba(167, 139, 250, 0.45); color: #fff; }
    #${CARD_ID} .aqw-hint { margin-left: auto; font-size: 10.5px; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .aqw-dots { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
    #${CARD_ID} .aqw-dot {
      appearance: none; width: 8px; height: 8px; padding: 0; border: none; border-radius: 50%; cursor: pointer;
      background: rgba(255, 255, 255, 0.15); transition: background 0.15s ease, transform 0.15s ease;
    }
    #${CARD_ID} .aqw-dot.is-ch2 { background: rgba(245, 158, 11, 0.25); }
    #${CARD_ID} .aqw-dot.is-active { background: #a78bfa; transform: scale(1.3); }
    #${CARD_ID} .aqw-dot.is-ch2.is-active { background: #f59e0b; }
    #${CARD_ID} .aqw-meta { margin-top: 8px; font-size: 10.5px; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .aqw-prompt {
      display: grid; gap: 10px; padding: 16px 14px 14px; text-align: center; border-radius: 10px;
      background: linear-gradient(180deg, rgba(167, 139, 250, 0.14), rgba(167, 139, 250, 0.04));
      border: 1px solid rgba(167, 139, 250, 0.35); animation: aqw-in 0.26s ease-out;
    }
    #${CARD_ID} .aqw-prompt-icon { font-size: 26px; line-height: 1; }
    #${CARD_ID} .aqw-prompt-title { font-size: 13px; font-weight: 800; text-transform: uppercase; color: #fff; }
    #${CARD_ID} .aqw-prompt-desc { font-size: 11.5px; color: rgba(234, 234, 234, 0.8); }
    #${CARD_ID} .aqw-prompt-buttons { display: grid; gap: 6px; }
    #${CARD_ID} .aqw-prompt-btn {
      appearance: none; cursor: pointer; padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 700;
      border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.06); color: #eaeaea;
    }
    #${CARD_ID} .aqw-prompt-btn.is-primary { background: #7c3aed; color: #fff; box-shadow: 0 4px 12px rgba(124, 58, 237, 0.35); }

    #${POPUP_ID} {
      position: absolute; z-index: 5; width: 372px; max-width: calc(100% - 24px); max-height: 72vh; overflow-y: auto;
      top: 188px; left: 12px; pointer-events: auto; opacity: 0; transform: translateY(-8px);
      transition: opacity 0.35s ease, transform 0.35s ease;
      background: linear-gradient(180deg, rgba(22, 18, 34, 0.96), rgba(14, 12, 22, 0.96)); color: #eaeaea;
      border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55), 0 0 0 3px rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); font-size: 12px;
    }
    #${POPUP_ID} .aqwp-head {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: linear-gradient(90deg, rgba(124, 58, 237, 0.4), rgba(245, 158, 11, 0.1));
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    #${POPUP_ID} .aqwp-head.is-ch2 { background: linear-gradient(90deg, rgba(245, 158, 11, 0.38), rgba(124, 58, 237, 0.12)); }
    #${POPUP_ID} .aqwp-dot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; flex: 0 0 auto; animation: aqw-pulse 1.6s ease-in-out infinite; }
    #${POPUP_ID} .aqwp-title { flex: 1 1 auto; font-size: 13px; font-weight: 700; color: #fff; }
    #${POPUP_ID} .aqwp-badge {
      font-size: 9.5px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); white-space: nowrap;
    }
    #${POPUP_ID} .aqwp-body { padding: 10px 12px; line-height: 1.55; }
    #${POPUP_ID} .aqwp-caption { margin-bottom: 8px; color: rgba(234, 234, 234, 0.92); }
    #${POPUP_ID} .aqwp-label {
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
      color: rgba(234, 234, 234, 0.5); margin: 8px 0 4px;
    }
    #${POPUP_ID} .aqwp-big { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
    #${POPUP_ID} .aqwp-big-value { font-size: 26px; font-weight: 800; color: #fff; line-height: 1; }
    #${POPUP_ID} .aqwp-big-sub { font-size: 10.5px; color: rgba(234, 234, 234, 0.6); }
    #${POPUP_ID} .aqwp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 6px 0; }
    #${POPUP_ID} .aqwp-stat { padding: 6px 7px; border-radius: 8px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); }
    #${POPUP_ID} .aqwp-stat b { display: block; font-size: 13.5px; color: #fff; }
    #${POPUP_ID} .aqwp-stat span { font-size: 9.5px; color: rgba(234, 234, 234, 0.55); }
    #${POPUP_ID} .aqwp-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    #${POPUP_ID} .aqwp-table th {
      text-align: left; font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      color: rgba(234, 234, 234, 0.5); padding: 2px 6px 4px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    #${POPUP_ID} .aqwp-table td { padding: 3px 6px 3px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
    #${POPUP_ID} .aqwp-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    #${POPUP_ID} .aqwp-cat { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    #${POPUP_ID} .aqwp-chart { width: 100%; height: auto; display: block; margin: 2px 0; }
    #${POPUP_ID} .aqwp-stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; margin: 4px 0 6px; }
    #${POPUP_ID} .aqwp-stack > span { display: block; height: 100%; animation: aqw-grow 0.9s ease-out; transform-origin: left; }
    @keyframes aqw-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    #${POPUP_ID} .aqwp-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 9.5px; color: rgba(234, 234, 234, 0.65); }
    #${POPUP_ID} .aqwp-advice {
      margin-top: 8px; padding: 7px 9px; border-radius: 8px; font-size: 11px; line-height: 1.45;
      background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); color: #fde68a;
    }
    #${POPUP_ID} .aqwp-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
    #${POPUP_ID} .aqwp-chip {
      font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
      background: rgba(167, 139, 250, 0.16); border: 1px solid rgba(167, 139, 250, 0.35); color: #ddd6fe;
    }
    #${POPUP_ID} .aqwp-u { font-size: 0.68em; font-weight: 600; margin-left: 3px; color: rgba(234, 234, 234, 0.6); white-space: nowrap; }
    #${POPUP_ID} .aqwp-stat b { white-space: nowrap; }
    #${POPUP_ID} .aqwp-grid--4 { grid-template-columns: repeat(4, 1fr); }
    #${POPUP_ID} .aqwp-grid--4 .aqwp-stat b { font-size: 14px; }
    #${POPUP_ID} .aqwp-axis-note { font-size: 9.5px; color: rgba(234, 234, 234, 0.55); margin: 2px 0; }
    #${POPUP_ID} .aqwp-line { display: inline-block; width: 14px; height: 0; border-top: 2px dashed; margin-right: 5px; vertical-align: 2px; }
    #${POPUP_ID} .aqwp-line.is-dotted { border-top-style: dotted; }
    #${POPUP_ID} .aqwp-whisk { display: inline-block; width: 8px; height: 9px; margin-right: 5px; vertical-align: -1px;
      border-top: 1.5px solid rgba(255,255,255,0.75); background: linear-gradient(rgba(255,255,255,0.6), rgba(255,255,255,0.6)) center / 1px 100% no-repeat; }
    #${POPUP_ID} .aqwp-why { margin: 6px 0; padding: 8px 9px; border-radius: 8px;
      background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); animation: aqw-in 0.5s ease; }
    #${POPUP_ID} .aqwp-why-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 800; color: #fff; margin-bottom: 3px; }
    #${POPUP_ID} .aqwp-why-data { font-size: 11px; line-height: 1.5; color: rgba(234, 234, 234, 0.92); margin-bottom: 4px; }
    #${POPUP_ID} .aqwp-why-research { font-size: 10.5px; line-height: 1.45; color: rgba(196, 181, 253, 0.85); font-style: italic; }
    #${POPUP_ID} .aqwp-src { margin-top: 8px; font-size: 9.5px; color: rgba(234, 234, 234, 0.45); font-style: italic; }
  `;
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

// ---- Card -----------------------------------------------------------------
function _ensureCard(root) {
  let card = root.querySelector(`#${CARD_ID}`);
  if (card) return card;
  card = document.createElement("div");
  card.id = CARD_ID;
  card.innerHTML = `
    <div class="aqw-head">
      <div class="aqw-title"><span class="aqw-live" aria-hidden="true"></span><span>${LABEL}</span></div>
      <div class="aqw-head-actions">
        <button type="button" class="aqw-icon-btn aqw-refresh" aria-label="Refresh data" title="Re-fetch all air-quality data and restart">${ICON_REFRESH}</button>
        <button type="button" class="aqw-icon-btn aqw-mute is-muted" aria-label="Unmute narration" title="Unmute narration">${ICON_TTS_OFF}</button>
        <button type="button" class="aqw-lang" aria-label="Switch to Urdu" title="Switch narration to Urdu">اردو</button>
        <button type="button" class="aqw-icon-btn aqw-close" aria-label="Close ${LABEL}" title="Close and return to 7-Day Outlook">✕</button>
      </div>
    </div>
    <div class="aqw-chapter-head">
      <div class="aqw-chapter-title">—</div>
      <div class="aqw-chapter-counter"></div>
    </div>
    <div class="aqw-body" role="region" aria-live="polite"></div>
    <div class="aqw-loader" role="status" aria-live="polite" hidden>
      <span class="aqw-spinner" aria-hidden="true"></span>
      <div class="aqw-loader-main">
        <div class="aqw-loader-text"></div>
        <div class="aqw-loader-bar"><i></i></div>
      </div>
      <span class="aqw-loader-time"></span>
    </div>
    <div class="aqw-progress-row">
      <div class="aqw-progress-track"><div class="aqw-progress-fill"></div></div>
      <span class="aqw-progress-timer">0.0s</span>
    </div>
    <div class="aqw-transport">
      <button type="button" class="aqw-btn aqw-btn--rw" title="Rewind (cycles 1x-5x)" aria-label="Rewind">${ICON_RW}<span class="aqw-speed"></span></button>
      <button type="button" class="aqw-btn aqw-btn--prev" title="Previous scene" aria-label="Previous">${ICON_PREV}</button>
      <button type="button" class="aqw-btn aqw-btn--play" title="Play" aria-label="Play">${ICON_PLAY}</button>
      <button type="button" class="aqw-btn aqw-btn--next" title="Next scene" aria-label="Next">${ICON_NEXT}</button>
      <button type="button" class="aqw-btn aqw-btn--ff" title="Fast-forward (cycles 1x-5x)" aria-label="Fast-forward">${ICON_FF}<span class="aqw-speed"></span></button>
      <span class="aqw-hint">Chapter 1 · The Past Week</span>
    </div>
    <div class="aqw-dots" role="tablist"></div>
    <div class="aqw-meta">Source: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0 · WAQI · WHO AQG 2021 · Pak-NEQS 2010 · US EPA AQI 2024</div>
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

function _syncMuteButton(card) {
  const m = card?.querySelector(".aqw-mute");
  if (!m) return;
  m.classList.toggle("is-muted", !_state.ttsEnabled);
  m.innerHTML = _state.ttsEnabled ? ICON_TTS_ON : ICON_TTS_OFF;
  const label = _state.ttsEnabled ? "Mute narration" : "Unmute narration";
  m.setAttribute("aria-label", label);
  m.setAttribute("title", label);
}
function _syncLangButton(card) {
  const b = card?.querySelector(".aqw-lang");
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
  q(".aqw-btn--play").addEventListener("click", _togglePlay);
  q(".aqw-btn--prev").addEventListener("click", () => _gotoScene(_state.index - 1));
  q(".aqw-btn--next").addEventListener("click", () => _gotoScene(_state.index + 1));
  q(".aqw-btn--ff").addEventListener("click", () => _cycleSpeed(1));
  q(".aqw-btn--rw").addEventListener("click", () => _cycleSpeed(-1));
  q(".aqw-close").addEventListener("click", () => {
    const sel = document.getElementById(SELECT_ID);
    if (sel) sel.value = "";
    _hide();
  });
  q(".aqw-mute").addEventListener("click", () => {
    _state.ttsEnabled = !_state.ttsEnabled;
    _stopSpeaking();
    _syncMuteButton(card);
    if (_state.ttsEnabled) _speak(_tr(_state.scenes[_state.index]?.caption));
  });
  q(".aqw-lang").addEventListener("click", () => {
    _state.lang = _state.lang === "ur" ? "en" : "ur";
    _saveLangPref(_state.lang);
    _syncLangButton(card);
    _reapplyLanguage(card);
    if (_state.lang === "ur") {
      _ensureUrduTranslations(card).then((ok) => { if (ok && _state.lang === "ur") _reapplyLanguage(card); }).catch(() => {});
    }
  });
  q(".aqw-refresh").addEventListener("click", () => _handleRefresh(card));
  q(".aqw-dots").addEventListener("click", (e) => {
    const dot = e.target.closest(".aqw-dot");
    const idx = Number(dot?.dataset.aqwScene);
    if (dot && Number.isFinite(idx)) _gotoScene(idx);
  });
}

// ---- Data -----------------------------------------------------------------
async function _fetchJson(url) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Every multi-station city, deduplicated so two towns sharing the same
// forecast/estimate pixels (e.g. Lahore and Kahna Nau, ~20 km apart)
// don't both get a flyover. `rank` decides which of a close pair is kept.
function _dedupeByDistance(items, minKm = 30) {
  const kept = [];
  for (const it of items) {
    if (!kept.some((k) => _kmBetween([k.lon, k.lat], [it.lon, it.lat]) < minKm)) kept.push(it);
  }
  return kept;
}

function _isMetro(name) {
  return METROS.some((m) => m.toLowerCase() === String(name || "").toLowerCase());
}

// Cities trustworthy enough to narrate: two or more stations (a single
// low-cost sensor can be a local hotspot or a fault) or a major metro.
function _reliableCities(pastCities) {
  return (pastCities || []).filter((c) => c.n_stations >= 2 || _isMetro(c.city));
}

function _waqiNear(lon, lat, km = WAQI_NEAR_KM) {
  const feats = _state.waqi?.features || [];
  return feats
    .map((f) => {
      const c = f.geometry?.coordinates;
      const aqi = Number(f.properties?.aqi);
      if (!Array.isArray(c) || !Number.isFinite(aqi)) return null;
      return { uid: Number(f.properties.uid), name: f.properties.name, aqi, time: f.properties.time,
               coords: c, km: _kmBetween([lon, lat], c) };
    })
    .filter((x) => x && x.km <= km)
    .sort((a, b) => a.km - b.km)
    .slice(0, 4);
}

// ---- AQI narration (primary) ------------------------------------------------
// Used whenever the digest carries the backend AQI block (d.aqi). Every index
// is computed by project/ncop_internal/aqi_engine.py; nothing is converted
// here. The PM2.5 builders below are only the fallback when it is missing.
function _sc(d) { return aqiScale(d.aqi.standard); }
function _aqiIntroNarrative(d) {
  const H = aqiHeadline(d);
  return `National Air Quality Watch. ${H.nowLine} This briefing follows the Air Quality Index over the past ${H.days.length} days: how bad it was, where, and why. Then it looks ahead. The index is for fine particles, PM2.5, the only pollutant Pakistan's available stations report.`;
}
function _aqiWeekNarrative(d) {
  const H = aqiHeadline(d);
  return `${H.weekLine} On that day, ${H.S.atLeast(H.worst.category_counts, "very_unhealthy")} of ${H.worst.n_valid} stations were Very Unhealthy or Hazardous.${_weekWhySentence(d)} On the map, dots are stations coloured by AQI; the surface is the satellite-supported PM2.5 estimate behind them.`;
}
function _aqiCityNarrative(d, c, rank) {
  const S = _sc(d), a = c.aqi;
  const now = d.aqi.now?.cities?.find((x) => x.city === c.city);
  return `${rank === 1 ? "Worst of the week" : `Hotspot number ${rank}`}: ${c.city}. The middle day had an AQI of ${aqiText(a.median_aqi)}, ${S.label(a.median_aqi)}, across ${a.n_stations} station${a.n_stations > 1 ? "s" : ""}. The worst day was ${_dayLabel(a.peak_date)}, at ${aqiText(a.peak)}, ${S.label(a.peak)}.${now ? ` Right now it reads ${aqiText(now.aqi)}, ${S.label(now.aqi)}.` : ""} The evidence behind it: PM2.5 averaged ${_r(a.mean_pm25)} µg/m³ over the week. Data confidence is ${a.confidence}. ${S.advice(a.last ?? a.median_aqi)}`;
}
function _aqiMetrosNarrative(d, metros) {
  const S = _sc(d), list = [...metros].sort((x, y) => y.median_aqi - x.median_aqi), lo = list[list.length - 1];
  return `Pulling back to the major cities. ${list[0].city} had the worst middle day, AQI ${aqiText(list[0].median_aqi)}, ${S.label(list[0].median_aqi)}; ${lo.city} the best, ${aqiText(lo.median_aqi)}, ${S.label(lo.median_aqi)}. In between: ${_joinList(list.slice(1, 4).map((m) => `${m.city} ${aqiText(m.median_aqi)}`))}. These are 24-hour values, so they are comparable with each other but not with a live reading.`;
}
function _aqiWeekAssessment(d) {
  const H = aqiHeadline(d), n = H.S.atLeast(H.ref.counts, "hazardous");
  return `Past-week assessment. ${H.nowLine}${n ? ` ${n} stations are Hazardous.` : ""} The week is ${d.aqi.observed.trend === "insufficient data" ? "too short for a trend" : d.aqi.observed.trend}. Next, the outlook.`;
}
function _aqiFcIntro(d) {
  const fc = d.aqi.forecast;
  if (!fc?.days?.length) return "Chapter 2: the outlook. The AQI forecast could not be made for this issue, so this chapter shows the PM2.5 forecast map and live stations only.";
  return `Chapter 2: the outlook. The AQI forecast covers ${_dayLabel(fc.targets[0])} to ${_dayLabel(fc.targets[fc.targets.length - 1])}. It is a 24-hour forecast for each city, from the Copernicus model adjusted with the city's own stations. The map shows Hawanama's PM2.5 forecast; the dots are live WAQI stations.`;
}
function _aqiFcLayer(d) {
  const H = aqiHeadline(d), fc = H.fc;
  if (!fc?.days?.length) return _fcLayerNarrativePm(d);
  return `${H.fcLine} ${fc.days.map((x) => `${_dayLabel(x.date)}: middle city ${aqiText(x.median_aqi)}, ${H.S.label(x.median_aqi)}`).join("; ")}. In a backtest, tomorrow's category was right ${fc.days.find((x) => x.lead === 2)?.skill.hit ?? fc.days[0].skill.hit}% of the time, and within one category almost always.`;
}
function _aqiFcCity(d, c, rank, waqi) {
  const S = _sc(d), f = c.fcAqi, now = d.aqi.now?.cities?.find((x) => x.city === c.city);
  const pk = f.days.filter(Boolean).reduce((x, y) => (y.aqi > x.aqi ? y : x));
  return `${rank === 1 ? "Highest forecast" : `Forecast hotspot ${rank}`}: ${c.city}. AQI is expected to reach ${aqiText(f.peak)}, ${S.label(f.peak)}, on ${_dayLabel(f.peak_date)}, with a likely range of ${aqiText(pk.lo)} to ${aqiText(pk.hi)}. The best day is ${_dayLabel(f.best_date)}, at ${aqiText(f.best)}.${now ? ` Observed now: ${aqiText(now.aqi)}, ${S.label(now.aqi)}.` : ""}${waqi.length ? ` ${waqi.length} WAQI station${waqi.length > 1 ? "s" : ""} nearby read ${_joinList(waqi.map((x) => String(x.aqi)))}.` : ""} ${S.advice(f.peak)}`;
}
function _aqiFcAssessment(d) {
  const H = aqiHeadline(d), fc = H.fc;
  if (!fc?.days?.length) return "Outlook assessment: the AQI forecast is unavailable, so check the live stations again in a few hours. This concludes the National Air Quality Watch.";
  const watch = fc.cities.filter((c) => c.days.filter((x) => x && x.aqi > 200).length >= 2).length;
  return `Outlook assessment. ${H.fcLine} ${watch} of ${fc.cities.length} forecast cities stay Very Unhealthy or worse on two or more days. ${H.S.advice(H.fWorst.median_aqi)} Recheck the newest issue before acting: a forecast is not an observation. This concludes the National Air Quality Watch.`;
}

// ---- Narrative builders ---------------------------------------------------
function _introNarrative(d) {
  if (d.aqi) return _aqiIntroNarrative(d);
  const pw = d.past_week;
  const days = pw?.dates?.length || 0;
  const season = _isSmogSeason()
    ? " It is smog season: from October to February, cool, still air and night-time temperature inversions trap emissions from traffic, industry, brick kilns and crop-residue burning close to the ground across the Indus plain."
    : "";
  return `National Air Quality Watch. This briefing reviews fine particulate matter, PM2.5, across Pakistan over the past ${days || "few"} days, then looks ahead with the 72-hour forecast. Readings are compared against the World Health Organization's 24-hour guideline of ${WHO_24H} µg/m³ and Pakistan's National Environmental Quality Standard of ${NEQS_24H} µg/m³.${season}`;
}

function _weekLayerNarrative(d) {
  if (d.aqi) return _aqiWeekNarrative(d);
  const daily = d.past_week?.daily || [];
  if (!daily.length) return "The daily PM2.5 estimate for the past week is playing, but station daily means were not available for a summary.";
  const worstDay = daily.reduce((a, b) => (b.median > a.median ? b : a));
  const bestDay = daily.reduce((a, b) => (b.median < a.median ? b : a));
  const avgShareNeqs = daily.reduce((s, x) => s + x.share_above_neqs24, 0) / daily.length;
  const avgN = Math.round(daily.reduce((s, x) => s + x.n, 0) / daily.length);
  return `Here is the satellite-supported daily PM2.5 estimate for the last ${daily.length} days. Across about ${avgN} reporting stations, the worst day was ${_dayLabel(worstDay.date)}, with a national station median of ${_r(worstDay.median)} µg/m³, ${_r(worstDay.median / WHO_24H, 1)} × the WHO guideline. The cleanest was ${_dayLabel(bestDay.date)}, at ${_r(bestDay.median)} µg/m³. On an average day, ${_pct(avgShareNeqs)} of stations exceeded Pakistan's 24-hour standard.${_weekWhySentence(d)}`;
}

function _weekWhySentence(d) {
  const w = _weekDrivers(d);
  if (!w) return "";
  const bits = [];
  if (Number.isFinite(w.windMean)) bits.push(`winds averaged just ${_r(w.windMean, 1)} km/h and the night-time mixing layer fell to about ${_fmtInt(w.blhNightMean)} m, trapping emissions near the ground`);
  if (Number.isFinite(w.firesWeek)) bits.push(`satellites counted ${_fmtInt(w.firesWeek)} crop-residue fires across the two Punjabs`);
  return bits.length ? ` Why: ${bits.join("; ")}, on top of year-round traffic, waste-burning and industrial emissions.` : "";
}

function _weekCityNarrative(c, rank) {
  const cat = _epa(c.mean);
  return `${rank === 1 ? "Worst of the week" : `Hotspot number ${rank}`}: ${c.city}. Across ${c.n_stations} station${c.n_stations > 1 ? "s" : ""}, the 7-day average was ${_r(c.mean)} µg/m³, ${_r(c.times_who24, 1)} × the WHO guideline, in the ${cat?.label || "—"} range. It peaked at ${_r(c.peak)} µg/m³ on ${_dayLabel(c.peak_date)}, and the national standard was exceeded on ${c.days_above_neqs24} of ${c.days} days.`;
}

function _weekMetrosNarrative(metros) {
  const sorted = [...metros].sort((a, b) => b.mean - a.mean);
  const top = sorted[0];
  const low = sorted[sorted.length - 1];
  const lahore = metros.find((m) => m.city.toLowerCase() === "lahore");
  const isb = metros.find((m) => m.city.toLowerCase() === "islamabad");
  let aqli = "";
  if (lahore || isb) {
    const parts = [];
    if (lahore) parts.push(`${AQLI_GAIN.lahore} years in Lahore`);
    if (isb) parts.push(`${AQLI_GAIN.islamabad} years in Islamabad`);
    aqli = ` The University of Chicago's Air Quality Life Index estimates that meeting the WHO annual guideline would add ${_joinList(parts)} to average life expectancy.`;
  }
  return `Pulling back to the major cities. ${top.city} averaged the most among them this week, ${_r(top.mean)} µg/m³, and ${low.city} the least, ${_r(low.mean)} µg/m³. ${_joinList(sorted.slice(1, 4).map((m) => `${m.city} ${_r(m.mean)}`))} µg/m³ fill out the middle.${aqli}`;
}

function _weekAssessmentNarrative(d) {
  if (d.aqi) return _aqiWeekAssessment(d);
  const live = d.live;
  const pw = d.past_week;
  const daily = pw?.daily || [];
  const first = daily[0];
  const last = daily[daily.length - 1];
  let trend = "";
  if (first && last && daily.length >= 3) {
    const ch = ((last.median - first.median) / first.median) * 100;
    trend = Math.abs(ch) < 10
      ? ` Over the week, the national median held roughly steady, at around ${_r(last.median)} µg/m³.`
      : ` Over the week, the national median ${ch < 0 ? "fell" : "rose"} ${_r(Math.abs(ch))}%, from ${_r(first.median)} to ${_r(last.median)} µg/m³.`;
  }
  let now = "";
  if (live?.summary) {
    const unhealthyPlus = (live.category_counts?.unhealthy || 0) + (live.category_counts?.very_unhealthy || 0) + (live.category_counts?.hazardous || 0);
    now = ` Right now, ${live.summary.n} stations are reporting, with a median of ${_r(live.summary.median)} µg/m³; ${unhealthyPlus} of them read Unhealthy or worse on the US EPA scale.`;
  }
  return `Past-week assessment.${trend}${now} For context, the WHO annual guideline is ${WHO_ANNUAL} µg/m³, and the Air Quality Life Index puts the average Pakistani's loss of life expectancy from air pollution at ${AQLI_NATIONAL} years. Next, the outlook.`;
}

function _fcIntroNarrative(d) {
  if (d.aqi) return _aqiFcIntro(d);
  const fc = d.forecast;
  if (!fc || !fc.leads?.length) return "Chapter 2: the outlook. The Hawanama gridded forecast is unavailable right now, so this chapter shows live WAQI stations only.";
  const last = fc.leads[fc.leads.length - 1];
  return `Chapter 2: the outlook. Hawanama's gridded PM2.5 forecast, a beta product, was issued at ${_pkt(fc.init_time)} and runs to plus ${last.lead_h} hours, ${_pkt(last.valid_time)}. That is the longest horizon available, so beyond three days the seasonal pattern is the best guide. Live World Air Quality Index stations are switched on as the ground reference.`;
}

function _fcLayerNarrative(d) {
  return d.aqi ? _aqiFcLayer(d) : _fcLayerNarrativePm(d);
}
function _fcLayerNarrativePm(d) {
  const leads = d.forecast?.leads || [];
  if (!leads.length) return "Forecast frames are unavailable.";
  const peak = leads.reduce((a, b) => ((b.mean ?? -1) > (a.mean ?? -1) ? b : a));
  const first = leads[0];
  const last = leads[leads.length - 1];
  const dir = last.mean < first.mean ? "an improving" : last.mean > first.mean ? "a worsening" : "a flat";
  return `Stepping through the forecast. The national grid average peaks at ${_r(peak.mean)} µg/m³ at plus ${peak.lead_h} hours, ${_pkt(peak.valid_time)}, with the worst 5% of the country above ${_r(peak.p95)} µg/m³. By plus ${last.lead_h} hours the average is ${_r(last.mean)} µg/m³, ${dir} trend from ${_r(first.mean)} µg/m³ now. Night-time peaks are typical: the boundary layer collapses after sunset and holds emissions near the ground.`;
}

function _fcCityNarrative(c, rank, waqi) {
  const cat = _epa(c.peak);
  const lastCat = _epa(c.last);
  const w = waqi.length
    ? ` ${waqi.length} WAQI station${waqi.length > 1 ? "s" : ""} within ${WAQI_NEAR_KM} km currently read US AQI ${_joinList(waqi.map((x) => String(x.aqi)))}.`
    : " No WAQI station reports within reach of this city.";
  return `${rank === 1 ? "Highest forecast peak" : `Forecast hotspot ${rank}`}: ${c.city}. PM2.5 is expected to reach ${_r(c.peak)} µg/m³ around ${_pkt(c.peak_valid_time)}, at plus ${c.peak_lead_h} hours, in the ${cat?.label || "—"} range, then ${_r(c.last)} µg/m³ at the end of the run, ${lastCat?.label || "—"}.${w} Advice: ${EPA_ADVICE[cat?.key] || ""}`;
}

function _fcAssessmentNarrative(d) {
  if (d.aqi) return _aqiFcAssessment(d);
  const fc = d.forecast;
  const cities = fc?.cities || [];
  if (!cities.length) return "Outlook assessment: the forecast is unavailable, so check the live stations and the daily estimate again in a few hours.";
  const unhealthy = cities.filter((c) => c.peak > 55.4).length;
  const veryUnhealthy = cities.filter((c) => c.peak > 125.4).length;
  const improving = cities.filter((c) => c.last < c.series.find((v) => v != null)).length;
  const season = _isSmogSeason()
    ? " Beyond 72 hours, smog-season conditions usually persist until a western disturbance brings wind or rain, so expect episodes to recur."
    : "";
  return `Outlook assessment. Of ${cities.length} cities sampled, ${unhealthy} are forecast to touch Unhealthy levels and ${veryUnhealthy} Very Unhealthy or worse within 72 hours; ${improving} end the run cleaner than they start.${season} Recommended actions: limit outdoor activity at the forecast peaks, and give priority care to children, older people and anyone with heart or lung disease. This concludes the National Air Quality Watch.`;
}

// ---- Scenes ---------------------------------------------------------------
function _buildScenes(d) {
  const scenes = [{ kind: "intro", chapter: 1, caption: _introNarrative(d) }];
  const pw = d.past_week;
  if (pw?.daily?.length) {
    scenes.push({ kind: "week-layer", chapter: 1, caption: _weekLayerNarrative(d) });
    // AQI ranking (valid 24-hour sub-indices) when available; PM2.5 fallback.
    const byName = new Map(pw.cities.map((c) => [c.city, c]));
    const tour = d.aqi
      ? spreadCities(rankedCities(d.aqi)).slice(0, PAST_TOUR_MAX).map((a) => ({ city: a.city, lon: a.lon, lat: a.lat, n_stations: a.n_stations, ...(byName.get(a.city) || {}), peak_date: a.peak_date, aqi: a }))
      : _dedupeByDistance(_reliableCities(pw.cities)).slice(0, PAST_TOUR_MAX);
    tour.forEach((c, i) => scenes.push({ kind: "week-city", chapter: 1, city: c, rank: i + 1,
                                         caption: c.aqi ? _aqiCityNarrative(d, c, i + 1) : _weekCityNarrative(c, i + 1) }));
    const metros = pw.cities.filter((c) => _isMetro(c.city));
    const aqiMetros = (d.aqi?.observed?.cities || []).filter((c) => _isMetro(c.city));
    if (metros.length >= 3) scenes.push({ kind: "week-metros", chapter: 1, metros, aqiMetros: aqiMetros.length >= 3 ? aqiMetros : null,
      caption: aqiMetros.length >= 3 ? _aqiMetrosNarrative(d, aqiMetros) : _weekMetrosNarrative(metros) });
  }
  scenes.push({ kind: "week-assessment", chapter: 1, caption: _weekAssessmentNarrative(d) });

  scenes.push({ kind: "fc-intro", chapter: 2, caption: _fcIntroNarrative(d) });
  const fc = d.forecast;
  if (fc?.leads?.length) {
    scenes.push({ kind: "fc-layer", chapter: 2, caption: _fcLayerNarrative(d) });
    const reliable = new Set(_reliableCities(pw?.cities).map((c) => c.city));
    (d.live?.cities || []).forEach((c) => { if (c.n >= 2) reliable.add(c.city); });
    // Neighbouring towns share forecast cells (Lahore and Kahna Nau read the
    // same); on a tie the metro is kept.
    const ranked = fc.cities.filter((c) => reliable.has(c.city) || _isMetro(c.city))
      .sort((a, b) => (b.peak - a.peak) || (Number(_isMetro(b.city)) - Number(_isMetro(a.city))));
    // Ranked by forecast AQI when available. The Hawanama record is kept for
    // the map frame and camera, so only cities present in both are toured.
    const hawanama = new Map(fc.cities.map((c) => [c.city, c]));
    const ok = new Set(d.aqi ? rankedCities(d.aqi).map((c) => c.city) : []);
    const aqiTour = d.aqi?.forecast?.cities?.length
      ? spreadCities(d.aqi.forecast.cities.filter((c) => ok.has(c.city) && hawanama.has(c.city))).slice(0, FC_TOUR_MAX).map((f) => ({ ...hawanama.get(f.city), fcAqi: f }))
      : [];
    const tour = aqiTour.length ? aqiTour : _dedupeByDistance(ranked).slice(0, FC_TOUR_MAX);
    tour.forEach((c, i) => {
      const waqi = _waqiNear(c.lon, c.lat);
      scenes.push({ kind: "fc-city", chapter: 2, city: c, rank: i + 1, waqi, caption: c.fcAqi ? _aqiFcCity(d, c, i + 1, waqi) : _fcCityNarrative(c, i + 1, waqi) });
    });
  }
  scenes.push({ kind: "fc-assessment", chapter: 2, caption: _fcAssessmentNarrative(d) });
  return scenes;
}

function _sceneTitle(scene) {
  switch (scene.kind) {
    case "intro":           return "Chapter 1 — The Past Week";
    case "week-layer":      return "AQI — Last 7 Days";
    case "week-city":       return `Hotspot — ${scene.city.city}`;
    case "week-metros":     return "Major Cities — AQI";
    case "week-assessment": return "Past-Week Assessment";
    case "fc-intro":        return "Chapter 2 — The Outlook";
    case "fc-layer":        return "AQI Outlook — Coming Days";
    case "fc-city":         return `Forecast Focus — ${scene.city.city}`;
    case "fc-assessment":   return "Outlook Assessment";
    default:                return LABEL;
  }
}

function _pill(text, alert = false, color = null) {
  const sw = color ? `<span class="aqw-swatch" style="background:${color}"></span>` : "";
  return `<span class="aqw-pill${alert ? " is-alert" : ""}">${sw}${_hl(_esc(text))}</span>`;
}

// US AQI colour steps used by both point layers (hawanama_stations and
// waqi_stations colour their dots by US AQI, not by µg/m³).
const AQI_STEPS = [
  ["0–50", "#00e400"], ["51–100", "#ffff00"], ["101–150", "#ff7e00"],
  ["151–200", "#ff0000"], ["201–300", "#8f3f97"], ["301+", "#7e0023"],
];
const LAYER_SCENES = new Set(["week-layer", "week-city", "week-metros", "week-assessment",
  "fc-layer", "fc-city", "fc-assessment"]);

// Legend block for every layer on the map in this chapter: the temporal
// layer's colour scale (the same legend the sidebar slider shows) and the
// point layer's US AQI steps, plus the story's own highlight markers.
function _layersLegendHtml(chapter) {
  const temporal = chapter === 2
    ? { key: FC_KEY, title: "PM2.5 Forecast +3 to +72 h (beta)", unit: "µg/m³, turbo scale" }
    : { key: EST_KEY, title: "PM2.5 Estimate — daily", unit: "µg/m³, turbo scale" };
  const point = chapter === 2
    ? { title: "WAQI Stations", unit: "US AQI index" }
    : { title: "Hawanama Stations", unit: "US AQI index" };
  const steps = AQI_STEPS.map(([t, c]) => `<span class="aqw-step"><i style="background:${c}"></i>${t}</span>`).join("");
  const hl = chapter === 2
    ? `<span class="aqw-hl-key"><i class="is-district"></i>District in focus</span><span class="aqw-hl-key"><i class="is-waqi"></i>WAQI station in focus</span>`
    : `<span class="aqw-hl-key"><i class="is-district"></i>District in focus</span><span class="aqw-hl-key"><i class="is-station"></i>Station in focus</span>`;
  return `<div class="aqw-legend">
      <div class="aqw-legend-row"><div class="aqw-legend-title"><span class="aqw-legend-kind">Raster</span>${_esc(temporal.title)} <small>${_esc(temporal.unit)}</small></div>
        <div class="aqw-legend-scale">${String(TEMPORAL_LEGENDS?.[temporal.key] || "").replace(/\s*µg\/m³(\s*\(beta\))?/g, "")}</div></div>
      <div class="aqw-legend-row"><div class="aqw-legend-title"><span class="aqw-legend-kind">Points</span>${_esc(point.title)} <small>${_esc(point.unit)}</small></div>
        <div class="aqw-steps">${steps}</div></div>
      <div class="aqw-legend-row aqw-legend-row--hl">${hl}</div>
    </div>`;
}

function _factsHtml(scene) {
  const d = _state.digest || {};
  let pills = [];
  const S = d.aqi ? _sc(d) : null;
  if (S && scene.kind === "week-city" && scene.city.aqi) {
    const a = scene.city.aqi;
    pills = [_pill(`AQI ${aqiText(a.median_aqi)} ${S.label(a.median_aqi)}`, a.median_aqi > 150, S.color(a.median_aqi)), _pill(`worst day AQI ${aqiText(a.peak)}`), _pill(`PM2.5 ${_r(a.mean_pm25)} µg/m³`), _pill(`confidence ${a.confidence}`)];
  } else if (S && scene.kind === "week-metros" && scene.aqiMetros) {
    pills = [...scene.aqiMetros].sort((x, y) => y.median_aqi - x.median_aqi).slice(0, 4).map((m) => _pill(`${m.city}: AQI ${aqiText(m.median_aqi)}`, false, S.color(m.median_aqi)));
  } else if (S && scene.kind === "week-assessment") {
    const H = aqiHeadline(d);
    pills = [_pill(`AQI ${aqiText(H.ref.aqi)} middle station`, H.ref.aqi > 150, S.color(H.ref.aqi)), _pill(`${H.bad} of ${H.ref.n} stations Unhealthy or worse`, true)];
  } else if (S && scene.kind === "fc-city" && scene.city.fcAqi) {
    const f = scene.city.fcAqi;
    pills = [_pill(`forecast peak AQI ${aqiText(f.peak)} ${S.label(f.peak)}`, f.peak > 150, S.color(f.peak)), _pill(_shortDay(f.peak_date)), _pill(`best day AQI ${aqiText(f.best)}`)];
  } else if (S && scene.kind === "fc-assessment" && d.aqi.forecast?.cities?.length) {
    const n = d.aqi.forecast.cities.filter((c) => c.peak > 200).length;
    pills = [_pill(`${n} of ${d.aqi.forecast.cities.length} cities reach Very Unhealthy or worse`, n > 0)];
  } else if (scene.kind === "week-city") {
    const c = scene.city;
    const cat = _epa(c.mean);
    pills = [_pill(`${_r(c.mean)} µg/m³ 7-day avg`, c.mean > 55.4, cat?.color), _pill(`peak ${_r(c.peak)} µg/m³`),
      _pill(`${c.days_above_neqs24}/${c.days} days > NEQS ${NEQS_24H} µg/m³`, c.days_above_neqs24 > 0), _pill(`${_r(c.times_who24, 1)} × WHO ${WHO_24H} µg/m³`)];
  } else if (scene.kind === "week-metros") {
    pills = [...scene.metros].sort((a, b) => b.mean - a.mean).slice(0, 4)
      .map((m) => _pill(`${m.city}: ${_r(m.mean)} µg/m³`, false, _epa(m.mean)?.color));
  } else if (scene.kind === "week-assessment" && d.live?.summary) {
    pills = [_pill(`${_r(d.live.summary.median)} µg/m³ median now`), _pill(`${_pct(d.live.summary.share_above_neqs24)} of stations > NEQS ${NEQS_24H} µg/m³`, true)];
  } else if (scene.kind === "fc-city") {
    const c = scene.city;
    const cat = _epa(c.peak);
    pills = [_pill(`${_r(c.peak)} µg/m³ peak`, c.peak > 55.4, cat?.color), _pill(`+${c.peak_lead_h} h`), _pill(`${_r(c.last)} µg/m³ at run end`)];
    if (scene.waqi?.length) pills.push(_pill(`WAQI nearest: ${scene.waqi[0].aqi} US AQI`));
  } else if (scene.kind === "fc-assessment") {
    const n = (d.forecast?.cities || []).filter((c) => c.peak > 55.4).length;
    if (d.forecast?.cities?.length) pills = [_pill(`${n} cities ≥ Unhealthy (> 55.4 µg/m³)`, n > 0)];
  }
  if (!LAYER_SCENES.has(scene.kind)) return pills.length ? `<div class="aqw-facts">${pills.join("")}</div>` : "";
  const frame = `<span class="aqw-pill aqw-frame-pill">Frame <span class="aqw-frame-value">—</span></span>`;
  return `<div class="aqw-facts">${frame}${pills.join("")}</div>${_layersLegendHtml(scene.chapter)}`;
}

function _renderScene(card) {
  const scene = _state.scenes[_state.index];
  if (!scene || !card) return;
  card.querySelector(".aqw-chapter-title").textContent = _sceneTitle(scene);
  card.querySelector(".aqw-chapter-counter").textContent = `Scene ${_state.index + 1} / ${_state.scenes.length}`;
  card.querySelector(".aqw-hint").textContent = scene.chapter === 2 ? "Chapter 2 · The Outlook" : "Chapter 1 · The Past Week";
  const body = card.querySelector(".aqw-body");
  body.classList.toggle("aqw-lang-ur", _state.lang === "ur");
  body.innerHTML = `<div class="aqw-caption">${_hl(_esc(_tr(scene.caption)))}</div>${_factsHtml(scene)}`;
  _updateFrameLabel();
  card.querySelector(".aqw-dots").innerHTML = _state.scenes.map((s, i) => {
    const on = i === _state.index;
    return `<button type="button" role="tab" class="aqw-dot${s.chapter === 2 ? " is-ch2" : ""}${on ? " is-active" : ""}" data-aqw-scene="${i}" aria-selected="${on}" title="${_esc(_sceneTitle(s))}"></button>`;
  }).join("");
}

// Loader under the scene text: spinner + label + progress bar + elapsed
// seconds. `progress` = {ready, total} for a determinate bar, or null for
// an indeterminate one. Lives outside .aqw-body, so scene re-renders keep it.
function _loaderEl(card) {
  return card?.querySelector(".aqw-loader") || null;
}
function _showLoader(card, text, progress, startedAt, done = false) {
  const el = _loaderEl(card);
  if (!el) return;
  el.hidden = false;
  el.classList.toggle("is-done", done);
  el.querySelector(".aqw-loader-text").textContent = text;
  const bar = el.querySelector(".aqw-loader-bar");
  const fill = bar.querySelector("i");
  const det = progress && progress.total > 0;
  bar.classList.toggle("is-indeterminate", !det);
  fill.style.width = det ? `${Math.round((progress.ready / progress.total) * 100)}%` : "";
  el.querySelector(".aqw-loader-time").textContent = startedAt ? `${((performance.now() - startedAt) / 1000).toFixed(1)}s` : "";
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

function _popupHead(title, badge, chapter, badgeColor) {
  const style = badgeColor ? ` style="background:${badgeColor};color:${_textOn(badgeColor)}"` : "";
  return `<div class="aqwp-head${chapter === 2 ? " is-ch2" : ""}"><span class="aqwp-dot" aria-hidden="true"></span>
    <span class="aqwp-title">${_esc(title)}</span>${badge ? `<span class="aqwp-badge"${style}>${_esc(badge)}</span>` : ""}</div>`;
}
function _textOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#111" : "#fff";
}
function _captionBlock(caption) {
  const cls = _state.lang === "ur" ? "aqwp-caption aqw-lang-ur" : "aqwp-caption";
  return `<div class="${cls}">${_hl(_esc(_tr(caption)))}</div>`;
}
const SRC_NOTE = `<div class="aqwp-src">PM2.5 data: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0. Thresholds: WHO AQG 2021, Pak-NEQS 2010, US EPA AQI 2024.</div>`;

// ---- Charts -----------------------------------------------------------------
// Shared column geometry so the PM2.5 chart and the drivers strip below it
// line up day for day.
const CH_W = 340, CH_PAD_L = 46, CH_PAD_R = 8;
function _colX(i, n) {
  const cw = (CH_W - CH_PAD_L - CH_PAD_R) / Math.max(n, 1);
  return { x: CH_PAD_L + i * cw, cw, cx: CH_PAD_L + i * cw + cw / 2 };
}
function _niceStep(max) {
  return max <= 100 ? 25 : max <= 250 ? 50 : max <= 600 ? 100 : 200;
}

// PM2.5 bar chart: y-axis with gridlines, faint US EPA category bands
// behind the bars, WHO / Pak-NEQS reference lines labelled on the axis,
// bar colour = EPA category of the value, and an optional whisker per bar
// (e.g. the 90th-percentile station: "the worst 10% of stations").
function _pmChart(values, labels, opts = {}) {
  const sub = opts.sub || [];
  const whisk = opts.whisker || [];
  const n = values.length || 1;
  const top = 24, plotH = 132, base = top + plotH, H = base + (sub.length ? 28 : 18);
  const peak = Math.max(60, ...values.filter(Number.isFinite), ...whisk.filter(Number.isFinite));
  const step = _niceStep(peak);
  const ymax = Math.ceil((peak * 1.04) / step) * step;
  const y = (v) => base - (Math.min(v, ymax) / ymax) * plotH;
  const out = [];
  let lo = 0;
  for (const c of EPA) {
    const hi = Math.min(c.max, ymax);
    if (hi > lo) out.push(`<rect x="${CH_PAD_L}" y="${y(hi)}" width="${CH_W - CH_PAD_L - CH_PAD_R}" height="${y(lo) - y(hi)}" fill="${c.color}" opacity="0.07"/>`);
    lo = c.max;
    if (lo >= ymax) break;
  }
  for (let v = step; v <= ymax; v += step) {
    out.push(`<line x1="${CH_PAD_L}" x2="${CH_W - CH_PAD_R}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.08)"/>
      <text x="${CH_PAD_L - 5}" y="${y(v) + 3}" font-size="8" fill="rgba(234,234,234,0.5)" text-anchor="end">${v}</text>`);
  }
  out.push(`<line x1="${CH_PAD_L}" x2="${CH_W - CH_PAD_R}" y1="${base}" y2="${base}" stroke="rgba(255,255,255,0.25)"/>
    <text x="${CH_PAD_L - 5}" y="${top - 12}" font-size="7.5" font-weight="700" fill="rgba(234,234,234,0.6)" text-anchor="end">${_esc(opts.axisUnit || "µg/m³")}</text>`);
  // Reference lines; labels sit above (NEQS) and below (WHO) their lines so they never overlap.
  out.push(`<line x1="${CH_PAD_L}" x2="${CH_W - CH_PAD_R}" y1="${y(NEQS_24H)}" y2="${y(NEQS_24H)}" stroke="#fbbf24" stroke-dasharray="4 3" stroke-width="1.2"/>
    <text x="${CH_PAD_L - 5}" y="${y(NEQS_24H) - 1}" font-size="7.5" font-weight="700" fill="#fbbf24" text-anchor="end">NEQS ${NEQS_24H}</text>
    <line x1="${CH_PAD_L}" x2="${CH_W - CH_PAD_R}" y1="${y(WHO_24H)}" y2="${y(WHO_24H)}" stroke="#38bdf8" stroke-dasharray="2 3" stroke-width="1.2"/>
    <text x="${CH_PAD_L - 5}" y="${y(WHO_24H) + 8}" font-size="7.5" font-weight="700" fill="#38bdf8" text-anchor="end">WHO ${WHO_24H}</text>`);
  values.forEach((v, i) => {
    const { cw, cx } = _colX(i, n);
    const w = cw * 0.58;
    const bx = cx - w / 2;
    out.push(`<text x="${cx}" y="${base + 11}" font-size="8.5" font-weight="600" fill="rgba(234,234,234,0.8)" text-anchor="middle">${_esc(labels[i] || "")}</text>`);
    if (sub[i]) out.push(`<text x="${cx}" y="${base + 21}" font-size="7.5" fill="rgba(234,234,234,0.5)" text-anchor="middle">${_esc(sub[i])}</text>`);
    if (!Number.isFinite(v)) {
      out.push(`<text x="${cx}" y="${base - 4}" font-size="8" fill="rgba(234,234,234,0.4)" text-anchor="middle">n/a</text>`);
      return;
    }
    const t = y(v);
    const h = Math.max(1.5, base - t);
    const cat = _epa(v);
    const wv = whisk[i];
    if (Number.isFinite(wv) && wv > v) {
      const wy = y(wv);
      out.push(`<line x1="${cx}" x2="${cx}" y1="${t}" y2="${wy}" stroke="rgba(255,255,255,0.55)" stroke-width="1"/>
        <line x1="${cx - cw * 0.14}" x2="${cx + cw * 0.14}" y1="${wy}" y2="${wy}" stroke="rgba(255,255,255,0.7)" stroke-width="1.2"/>
        <text x="${cx}" y="${wy - 3}" font-size="7" fill="rgba(234,234,234,0.6)" text-anchor="middle">${_r(wv)}</text>`);
    }
    out.push(`<rect x="${bx}" y="${t}" width="${w}" height="${h}" rx="2.5" fill="${cat?.color || "#9ca3af"}" stroke="rgba(0,0,0,0.35)" stroke-width="0.6">
        <animate attributeName="height" from="0" to="${h}" dur="0.7s" fill="freeze"/>
        <animate attributeName="y" from="${base}" to="${t}" dur="0.7s" fill="freeze"/></rect>`);
    const inside = h > 16;
    out.push(`<text x="${cx}" y="${inside ? t + 11 : t - 3}" font-size="9" font-weight="800" fill="${inside ? _textOn(cat?.color || "#9ca3af") : "#fff"}" text-anchor="middle">${_r(v)}</text>`);
  });
  const cats = EPA.filter((c) => values.some((v) => _epa(v)?.key === c.key));
  const legend = `<div class="aqwp-legend">
      ${cats.map((c) => `<span><span class="aqwp-cat" style="background:${c.color}"></span>${_esc(c.label)}</span>`).join("")}
      <span><span class="aqwp-line" style="border-color:#fbbf24"></span>Pak-NEQS 24-h ${NEQS_24H}</span>
      <span><span class="aqwp-line is-dotted" style="border-color:#38bdf8"></span>WHO 24-h ${WHO_24H}</span>
      ${whisk.some(Number.isFinite) ? `<span><span class="aqwp-whisk"></span>${_esc(opts.whiskerLabel || "90th percentile")}</span>` : ""}
    </div>`;
  return `<div class="aqwp-axis-note">${_esc(opts.unitLabel || "PM2.5, µg/m³")}</div>
    <svg class="aqwp-chart" viewBox="0 0 ${CH_W} ${H}" role="img" aria-label="${_esc(opts.aria || "PM2.5 chart")}">${out.join("")}</svg>${legend}`;
}

// Day-aligned strip under the week chart: crop fires (both Punjabs), mean
// wind and afternoon mixing height. Shading is relative within the week
// (darker = more fires / stronger wind / deeper mixing).
function _driversStrip(dates, drivers) {
  if (!drivers) return "";
  const n = dates.length;
  const idx = (date) => (drivers.dates || []).indexOf(date);
  const rows = [];
  const fires = drivers.fires?.regions;
  if (fires) {
    const tot = dates.map((date) => {
      const vals = Object.values(fires).map((a) => a[idx(date)]).filter(Number.isFinite);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    });
    rows.push({ label: "Crop fires", sub: "both Punjabs", vals: tot, fmt: (v) => String(v), rgb: "249,115,22" });
  }
  const met = drivers.met;
  if (met) {
    const m = dates.map((date) => met[idx(date)] || {});
    rows.push({ label: "Wind", sub: "km/h, mean", vals: m.map((x) => x.wind_kmh), fmt: (v) => _r(v, 1), rgb: "56,189,248" });
    rows.push({ label: "Mixing ht", sub: "m, afternoon", vals: m.map((x) => x.blh_max_m),
                fmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : _r(v)), rgb: "52,211,153" });
    if (m.some((x) => (x.precip_mm || 0) >= 0.5)) {
      rows.push({ label: "Rain", sub: "mm", vals: m.map((x) => x.precip_mm), fmt: (v) => _r(v, 1), rgb: "129,140,248" });
    }
  }
  if (!rows.length) return "";
  const rh = 19;
  const H = rows.length * (rh + 3) + 2;
  const out = [];
  rows.forEach((r, ri) => {
    const y0 = 1 + ri * (rh + 3);
    const max = Math.max(...r.vals.filter(Number.isFinite), 1e-9);
    out.push(`<text x="${CH_PAD_L - 5}" y="${y0 + 9}" font-size="8" font-weight="700" fill="rgba(234,234,234,0.85)" text-anchor="end">${_esc(r.label)}</text>
      <text x="${CH_PAD_L - 5}" y="${y0 + 17}" font-size="6.5" fill="rgba(234,234,234,0.45)" text-anchor="end">${_esc(r.sub)}</text>`);
    r.vals.forEach((v, i) => {
      const { x, cw } = _colX(i, n);
      const a = Number.isFinite(v) ? 0.15 + 0.7 * (v / max) : 0.04;
      out.push(`<rect x="${x + 1.5}" y="${y0}" width="${cw - 3}" height="${rh}" rx="3" fill="rgba(${r.rgb},${a.toFixed(2)})"/>
        <text x="${x + cw / 2}" y="${y0 + 12.5}" font-size="8.5" font-weight="700" fill="#fff" text-anchor="middle">${Number.isFinite(v) ? _esc(r.fmt(v)) : "—"}</text>`);
    });
  });
  return `<svg class="aqwp-chart" viewBox="0 0 ${CH_W} ${H}" role="img" aria-label="Daily drivers">${out.join("")}</svg>`;
}

function _pearson(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (pts.length < 5) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [a, b] of pts) { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// Numbers behind "why": worst vs cleanest day, the week's weather and
// fires, and how each driver moved with the daily median this week.
function _weekDrivers(d) {
  const daily = d?.past_week?.daily || [];
  const dr = d?.drivers;
  if (!daily.length || !dr) return null;
  const dates = daily.map((x) => x.date);
  const idx = (date) => (dr.dates || []).indexOf(date);
  const metFor = (date) => (dr.met || [])[idx(date)] || null;
  const firesFor = (date) => {
    const i = idx(date);
    const vals = Object.values(dr.fires?.regions || {}).map((a) => a[i]).filter(Number.isFinite);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const worst = daily.reduce((a, b) => (b.median > a.median ? b : a));
  const best = daily.reduce((a, b) => (b.median < a.median ? b : a));
  const med = daily.map((x) => x.median);
  const wind = dates.map((x) => metFor(x)?.wind_kmh);
  const blh = dates.map((x) => metFor(x)?.blh_max_m);
  const blhMin = dates.map((x) => metFor(x)?.blh_min_m);
  const fires = dates.map(firesFor);
  const mean = (a) => { const f = a.filter(Number.isFinite); return f.length ? f.reduce((s, v) => s + v, 0) / f.length : null; };
  const sum = (a) => { const f = a.filter(Number.isFinite); return f.length ? f.reduce((s, v) => s + v, 0) : null; };
  const regionWeek = {};
  for (const [r, arr] of Object.entries(dr.fires?.regions || {})) regionWeek[r] = sum(dates.map((x) => arr[idx(x)]));
  return {
    worst, best, worstMet: metFor(worst.date), bestMet: metFor(best.date),
    worstFires: firesFor(worst.date), bestFires: firesFor(best.date),
    windMean: mean(wind), blhMean: mean(blh), blhNightMean: mean(blhMin), firesWeek: sum(fires),
    regionWeek, season: dr.fires?.season || {}, points: dr.met_points || [],
    rWind: _pearson(wind, med), rBlh: _pearson(blh, med), rFires: _pearson(fires, med),
  };
}
function _rText(r) {
  if (!Number.isFinite(r)) return "";
  const s = Math.abs(r) >= 0.7 ? "strongly" : Math.abs(r) >= 0.4 ? "moderately" : "only weakly";
  return `${s} ${r < 0 ? "against" : "with"} PM2.5 (r = ${r.toFixed(2)}, ${7} days — indicative only)`;
}
const _fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—");

// Research the "why" section cites (shown in the popup's source list).
const WHY_REFS = [
  "Urban Unit Lahore emissions inventory (2023, 2020–21 data), as reported by Dawn, 5 Nov 2026",
  "PAQI (2025), Unveiling Pakistan's Air Pollution, doi:10.5281/zenodo.17629179 (rejected by Punjab EPA, Dawn, 10 Dec 2025)",
  "Majeed et al. (2024), Frontiers in Sustainable Cities 5, 1314426",
  "VIIRS active fires (NOAA-20/21) via Hawanama; weather: Open-Meteo",
];

function _categoryStack(counts) {
  const total = EPA.reduce((s, c) => s + (counts?.[c.key] || 0), 0);
  if (!total) return "";
  const segs = EPA.map((c) => {
    const n = counts[c.key] || 0;
    return n ? `<span style="width:${(n / total) * 100}%;background:${c.color}" title="${_esc(c.label)}: ${n}"></span>` : "";
  }).join("");
  const legend = EPA.filter((c) => counts[c.key]).map((c) =>
    `<span><span class="aqwp-cat" style="background:${c.color}"></span>${_esc(c.label)} ${counts[c.key]}</span>`).join("");
  return `<div class="aqwp-stack">${segs}</div><div class="aqwp-legend">${legend}</div>`;
}

function _standardsTable() {
  const rows = EPA.map((c, i) => {
    const lo = i === 0 ? 0 : EPA[i - 1].max + 0.1;
    const hi = Number.isFinite(c.max) ? c.max : null;
    return `<tr><td><span class="aqwp-cat" style="background:${c.color}"></span>${_esc(c.label)}</td><td class="num">${_u(`${_r(lo, 1)}${hi ? `–${_r(hi, 1)}` : "+"}`, "µg/m³")}</td></tr>`;
  }).join("");
  return `<table class="aqwp-table"><thead><tr><th>US EPA category (2024)</th><th class="num">24-h PM2.5</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---- AQI popups (primary; the PM2.5 popups below are the fallback) ----------
function _aqiChart(S, rows, { note = "", aria = "AQI chart" } = {}) {
  const n = rows.length || 1, top = 22, plotH = 128, base = top + plotH, H = base + 28;
  const peak = Math.max(150, ...rows.flatMap((r) => [r.v, r.hi]).filter(Number.isFinite));
  const ymax = Math.min(520, Math.max(200, Math.ceil((peak * 1.05) / 50) * 50));
  const y = (v) => base - (Math.min(v, ymax) / ymax) * plotH;
  const out = [];
  for (const c of S.cats) {
    const lo = Math.max(0, c.lo - 1), hi = Math.min(c.hi ?? ymax, ymax);
    if (lo >= ymax) break;
    out.push(`<rect x="${CH_PAD_L}" y="${y(hi)}" width="${CH_W - CH_PAD_L - CH_PAD_R}" height="${y(lo) - y(hi)}" fill="${c.color}" opacity="0.1"/>`);
    if (lo > 0) out.push(`<text x="${CH_PAD_L - 5}" y="${y(lo) + 3}" font-size="8" fill="rgba(234,234,234,0.55)" text-anchor="end">${lo}</text>`);
  }
  out.push(`<line x1="${CH_PAD_L}" x2="${CH_W - CH_PAD_R}" y1="${base}" y2="${base}" stroke="rgba(255,255,255,0.25)"/><text x="${CH_PAD_L - 5}" y="${top - 10}" font-size="7.5" font-weight="700" fill="rgba(234,234,234,0.6)" text-anchor="end">AQI</text>`);
  rows.forEach((r, i) => {
    const { cw, cx } = _colX(i, n), w = cw * 0.56;
    out.push(`<text x="${cx}" y="${base + 11}" font-size="8.5" font-weight="600" fill="rgba(234,234,234,0.8)" text-anchor="middle">${_esc(r.label)}</text>${r.sub ? `<text x="${cx}" y="${base + 21}" font-size="7.5" fill="rgba(234,234,234,0.5)" text-anchor="middle">${_esc(r.sub)}</text>` : ""}`);
    if (!Number.isFinite(r.v)) { out.push(`<text x="${cx}" y="${base - 4}" font-size="8" fill="rgba(234,234,234,0.4)" text-anchor="middle">n/a</text>`); return; }
    const t = y(r.v), h = Math.max(1.5, base - t), col = S.color(r.v);
    if (Number.isFinite(r.hi) && r.hi > r.v) {
      const hy = y(r.hi);
      out.push(`<line x1="${cx}" x2="${cx}" y1="${t}" y2="${hy}" stroke="rgba(255,255,255,0.55)"/><line x1="${cx - cw * 0.14}" x2="${cx + cw * 0.14}" y1="${hy}" y2="${hy}" stroke="rgba(255,255,255,0.7)" stroke-width="1.2"/>`);
    }
    out.push(`<rect x="${cx - w / 2}" y="${t}" width="${w}" height="${h}" rx="2.5" fill="${col}" stroke="rgba(0,0,0,0.35)" stroke-width="0.6"><animate attributeName="height" from="0" to="${h}" dur="0.7s" fill="freeze"/><animate attributeName="y" from="${base}" to="${t}" dur="0.7s" fill="freeze"/></rect>
      <text x="${cx}" y="${h > 16 ? t + 11 : t - 3}" font-size="9" font-weight="800" fill="${h > 16 ? _textOn(col) : "#fff"}" text-anchor="middle">${aqiText(r.v)}</text>`);
  });
  const used = S.cats.filter((c) => rows.some((r) => S.of(r.v)?.key === c.key));
  return `<div class="aqwp-axis-note">${_esc(note)}</div><svg class="aqwp-chart" viewBox="0 0 ${CH_W} ${H}" role="img" aria-label="${_esc(aria)}">${out.join("")}</svg>
    <div class="aqwp-legend">${used.map((c) => `<span><span class="aqwp-cat" style="background:${c.color}"></span>${_esc(c.label)}</span>`).join("")}</div>`;
}
function _aqiCell(S, v) {
  return Number.isFinite(v) ? `<span class="aqwp-cat" style="background:${S.color(v)}"></span><b>${aqiText(v)}</b> <small>${_esc(S.label(v))}</small>` : "<small>insufficient data</small>";
}
function _aqiStdNote(d) {
  const s = d.aqi.standard;
  return `<div class="aqwp-src">Index: ${_esc(s.name)} (${_esc(s.version)})${s.approved ? "" : ", a reference standard not yet adopted for Pakistan"}. Observed AQI is the PM2.5 sub-index.</div>`;
}
function _aqiIntroPopup() {
  const d = _state.digest, S = _sc(d), H = aqiHeadline(d);
  const rows = S.cats.map((c) => `<tr><td><span class="aqwp-cat" style="background:${c.color}"></span>${_esc(c.label)}</td><td class="num">${c.lo}${c.hi == null ? "+" : `–${c.hi}`}</td><td>${_esc(c.meaning)}</td></tr>`).join("");
  _presentPopup(`${_popupHead("About This Briefing", "2 Chapters", 1, S.color(H.ref.aqi))}
    <div class="aqwp-body">
      <div class="aqwp-grid">
        <div class="aqwp-stat"><b style="color:${S.color(H.ref.aqi)}">${_u(aqiText(H.ref.aqi), "AQI")}</b><span>middle station now · ${_esc(S.label(H.ref.aqi))}</span></div>
        <div class="aqwp-stat"><b>${_u(`${H.bad}/${H.ref.n}`, "stations")}</b><span>Unhealthy or worse</span></div>
        <div class="aqwp-stat"><b>${_u(`${H.vbad}/${H.ref.n}`, "stations")}</b><span>Very Unhealthy or Hazardous</span></div>
      </div>
      <table class="aqwp-table"><thead><tr><th>Category</th><th class="num">AQI</th><th>Meaning</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="aqwp-label">Layers used</div>
      <div class="aqwp-chips"><span class="aqwp-chip">Hawanama Stations (AQI)</span><span class="aqwp-chip">WAQI Stations (AQI)</span><span class="aqwp-chip">PM2.5 Estimate — daily</span><span class="aqwp-chip">PM2.5 Forecast +3 to +72 h</span><span class="aqwp-chip">District Boundaries</span></div>
      ${_aqiStdNote(d)}${SRC_NOTE}
    </div>`);
}
function _aqiWeekPopup() {
  const d = _state.digest, S = _sc(d), H = aqiHeadline(d), days = H.days;
  const best = days.reduce((a, b) => (b.median_aqi < a.median_aqi ? b : a));
  const rows = days.map((x) => `<tr><td>${_esc(_dayLabel(x.date))}</td><td>${_aqiCell(S, x.median_aqi)}</td><td class="num">${aqiText(x.p90_aqi)}</td><td class="num">${x.n_valid}/${x.n_reporting}</td><td>${_esc(x.worst_city || "—")} <small>${aqiText(x.worst_city_aqi)}</small></td><td class="num">${_u(_r(x.median_pm25), "µg/m³")}</td></tr>`).join("");
  const cards = _whyCards(d).map((c) => `<div class="aqwp-why"><div class="aqwp-why-head"><span aria-hidden="true">${c.icon}</span>${_esc(c.title)}</div>${c.data ? `<div class="aqwp-why-data">${_hl(_esc(c.data))}</div>` : ""}<div class="aqwp-why-research">${_esc(c.research)}</div></div>`).join("");
  const w = _weekDrivers(d);
  _presentPopup(`${_popupHead("Past 7 Days — National AQI", `${days.length} days`, 1, S.color(H.worst.median_aqi))}
    <div class="aqwp-body">
      <div class="aqwp-grid aqwp-grid--4">
        <div class="aqwp-stat"><b style="color:${S.color(H.last.median_aqi)}">${_u(aqiText(H.last.median_aqi), "AQI")}</b><span>latest day · ${_esc(S.label(H.last.median_aqi))}</span></div>
        <div class="aqwp-stat"><b>${_u(aqiText(H.worst.median_aqi), "AQI")}</b><span>worst day · ${_esc(_shortDay(H.worst.date))}</span></div>
        <div class="aqwp-stat"><b>${_u(aqiText(best.median_aqi), "AQI")}</b><span>best day · ${_esc(_shortDay(best.date))}</span></div>
        <div class="aqwp-stat"><b>${_u(`${S.atLeast(H.last.category_counts, "unhealthy")}/${H.last.n_valid}`, "stations")}</b><span>Unhealthy or worse, latest day</span></div>
      </div>
      <div class="aqwp-label">How bad was each day?</div>
      ${_aqiChart(S, days.map((x) => ({ v: x.median_aqi, hi: x.p90_aqi, label: _shortDay(x.date), sub: _dayLabel(x.date).slice(0, 3) })), { note: "Bars: middle station's daily AQI (PM2.5, 24-hour). Line: worst 10% of stations.", aria: "Daily AQI for the past week" })}
      ${w ? `<div class="aqwp-label">Context, day by day</div>${_driversStrip(days.map((x) => x.date), d.drivers)}` : ""}
      <div class="aqwp-label">Why is the air unhealthy?</div>${cards}
      <div class="aqwp-label">Day by day</div>
      <table class="aqwp-table"><thead><tr><th>Day</th><th>Middle station</th><th class="num">Worst 10%</th><th class="num">Valid</th><th>Worst city</th><th class="num">PM2.5</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="aqwp-src">Research: ${_esc(WHY_REFS.join(" · "))}.</div>${_aqiStdNote(d)}${SRC_NOTE}
    </div>`);
}
function _aqiCityPopup(scene) {
  const d = _state.digest, S = _sc(d), a = scene.city.aqi, now = d.aqi.now?.cities?.find((x) => x.city === scene.city.city);
  _presentPopup(`${_popupHead(scene.city.city, S.label(a.median_aqi), 1, S.color(a.median_aqi))}
    <div class="aqwp-body">
      <div class="aqwp-big"><span class="aqwp-big-value" style="color:${S.color(a.median_aqi)}">${aqiText(a.median_aqi)} <small style="font-size:12px">AQI</small></span><span class="aqwp-big-sub">middle day of the week · ${a.n_stations} station${a.n_stations > 1 ? "s" : ""} · confidence ${_esc(a.confidence)}</span></div>
      <div class="aqwp-grid">
        <div class="aqwp-stat"><b>${_u(aqiText(a.peak), "AQI")}</b><span>worst day · ${_esc(_shortDay(a.peak_date))}</span></div>
        <div class="aqwp-stat"><b>${now ? _u(aqiText(now.aqi), "AQI") : "—"}</b><span>now (NowCast)${now ? ` · ${_esc(S.label(now.aqi))}` : ""}</span></div>
        <div class="aqwp-stat"><b>${_u(_r(a.mean_pm25), "µg/m³")}</b><span>PM2.5, week mean (evidence)</span></div>
      </div>
      ${_aqiChart(S, a.series.map((x, i) => ({ v: x?.aqi, hi: x && x.n > 1 ? x.max : undefined, label: _shortDay(d.aqi.observed.dates[i]), sub: _dayLabel(d.aqi.observed.dates[i]).slice(0, 3) })), { note: "Middle station's daily AQI (PM2.5, 24-hour). Line: highest station.", aria: `Daily AQI, ${scene.city.city}` })}
      ${_captionBlock(scene.caption)}
      <div class="aqwp-advice">${_esc(S.advice(a.last ?? a.median_aqi))}</div>${_aqiStdNote(d)}${SRC_NOTE}
    </div>`);
}
function _aqiMetrosPopup(scene) {
  const d = _state.digest, S = _sc(d), now = new Map((d.aqi.now?.cities || []).map((c) => [c.city, c]));
  const rows = [...scene.aqiMetros].sort((x, y) => y.median_aqi - x.median_aqi).map((m) => `<tr><td>${_esc(m.city)}</td><td>${_aqiCell(S, now.get(m.city)?.aqi)}</td><td>${_aqiCell(S, m.median_aqi)}</td><td class="num">${aqiText(m.peak)}</td><td>${_esc(m.trend)}</td><td class="num">${m.n_stations}</td></tr>`).join("");
  _presentPopup(`${_popupHead("Major Cities — AQI", `${scene.aqiMetros.length} cities`, 1)}
    <div class="aqwp-body"><table class="aqwp-table"><thead><tr><th>City</th><th>Now</th><th>Middle day</th><th class="num">Peak</th><th>Week</th><th class="num">Stations</th></tr></thead><tbody>${rows}</tbody></table>
    ${_captionBlock(scene.caption)}${_aqiStdNote(d)}${SRC_NOTE}</div>`);
}
function _aqiAssessPopup(scene) {
  const d = _state.digest, S = _sc(d), H = aqiHeadline(d), n = d.aqi.now;
  _presentPopup(`${_popupHead("Past-Week Assessment", n ? "Live now" : "", 1, S.color(H.ref.aqi))}
    <div class="aqwp-body">
      <div class="aqwp-label">Stations by AQI category ${n ? "now (NowCast)" : `on ${_esc(_dayLabel(H.last.date))}`}</div>${_categoryStack(H.ref.counts)}
      <div class="aqwp-grid">
        <div class="aqwp-stat"><b style="color:${S.color(H.ref.aqi)}">${_u(aqiText(H.ref.aqi), "AQI")}</b><span>middle station · ${_esc(S.label(H.ref.aqi))}</span></div>
        <div class="aqwp-stat"><b>${_u(`${H.bad}/${H.ref.n}`, "stations")}</b><span>Unhealthy or worse</span></div>
        <div class="aqwp-stat"><b>${n ? _u(`${n.n_valid}/${n.n_listed}`, "stations") : "—"}</b><span>with a valid current AQI</span></div>
      </div>
      ${_captionBlock(scene.caption)}${_aqiStdNote(d)}${SRC_NOTE}
    </div>`);
}
function _aqiFcLayerPopup() {
  const d = _state.digest, S = _sc(d), fc = d.aqi.forecast, leads = d.forecast?.leads || [];
  const rows = fc.days.map((x) => `<tr><td>${_esc(_dayLabel(x.date))}</td><td>${_aqiCell(S, x.median_aqi)}</td><td class="num">${S.atLeast(x.category_counts, "unhealthy")}/${x.n_cities}</td><td class="num">${S.atLeast(x.category_counts, "very_unhealthy")}/${x.n_cities}</td><td class="num">${x.skill.hit}%</td></tr>`).join("");
  const sup = leads.map((l) => `<tr><td>+${l.lead_h} h</td><td>${_esc(_pkt(l.valid_time))}</td><td class="num">${_u(_r(l.mean), "µg/m³")}</td><td class="num">${_u(_r(l.p95), "µg/m³")}</td></tr>`).join("");
  _presentPopup(`${_popupHead("AQI Outlook — Forecast Cities", `${fc.cities.length} cities`, 2)}
    <div class="aqwp-body">
      ${_aqiChart(S, fc.days.map((x) => ({ v: x.median_aqi, hi: x.max_aqi, label: _shortDay(x.date), sub: x.date === fc.today ? "today" : "" })), { note: "Forecast 24-hour AQI (PM2.5): middle city. Line: highest city.", aria: "Forecast AQI by day" })}
      <table class="aqwp-table"><thead><tr><th>Day</th><th>Middle city</th><th class="num">Unhealthy+</th><th class="num">Very Unh.+</th><th class="num">Hit rate</th></tr></thead><tbody>${rows}</tbody></table>
      ${sup ? `<div class="aqwp-label">Supporting: PM2.5 map frames (single hours, grid)</div><table class="aqwp-table"><thead><tr><th>Lead</th><th>Valid</th><th class="num">Grid mean</th><th class="num">Worst 5%</th></tr></thead><tbody>${sup}</tbody></table>` : ""}
      <div class="aqwp-src">${_esc(fc.skill_note)}</div>${_aqiStdNote(d)}${SRC_NOTE}
    </div>`);
}
function _aqiFcCityPopup(scene) {
  const d = _state.digest, S = _sc(d), f = scene.city.fcAqi, fc = d.aqi.forecast;
  const waqiRows = (scene.waqi || []).map((w) => `<tr><td>${_esc(w.name || `Station ${w.uid}`)}</td><td class="num">${_r(w.km)} km</td><td>${_aqiCell(S, w.aqi)}</td></tr>`).join("");
  _presentPopup(`${_popupHead(scene.city.city, `Peak: ${S.label(f.peak)}`, 2, S.color(f.peak))}
    <div class="aqwp-body">
      <div class="aqwp-big"><span class="aqwp-big-value" style="color:${S.color(f.peak)}">${aqiText(f.peak)} <small style="font-size:12px">AQI</small></span><span class="aqwp-big-sub">forecast peak · ${_esc(_dayLabel(f.peak_date))}</span></div>
      ${_aqiChart(S, f.days.map((x, i) => ({ v: x?.aqi, hi: x?.hi, label: _shortDay(fc.targets[i]), sub: fc.targets[i] === fc.today ? "today" : "" })), { note: "Forecast 24-hour AQI (PM2.5). Line: top of the likely range.", aria: `Forecast AQI, ${scene.city.city}` })}
      <div class="aqwp-axis-note">Evidence: expected PM2.5 ${_esc(f.days.map((x) => (x ? _r(x.pm25) : "—")).join(", "))} µg/m³; model adjusted ×${_esc(f.ratio)} from the city's stations.</div>
      ${waqiRows ? `<div class="aqwp-label">Observed reference: WAQI stations (US AQI)</div><table class="aqwp-table"><thead><tr><th>Station</th><th class="num">Distance</th><th>AQI</th></tr></thead><tbody>${waqiRows}</tbody></table>` : ""}
      <div class="aqwp-advice">${_esc(S.advice(f.peak))}</div>${_aqiStdNote(d)}${SRC_NOTE}
    </div>`);
}
function _aqiFcAssessPopup(scene) {
  const d = _state.digest, S = _sc(d), fc = d.aqi.forecast;
  const rows = fc.cities.slice(0, 10).map((c) => `<tr><td>${_esc(c.city)}</td><td>${_aqiCell(S, c.peak)}</td><td>${_esc(_shortDay(c.peak_date))}</td><td class="num">${aqiText(c.best)}</td><td>${_esc(c.trend)}</td></tr>`).join("");
  _presentPopup(`${_popupHead("Outlook Assessment", "AQI", 2)}
    <div class="aqwp-body"><table class="aqwp-table"><thead><tr><th>City</th><th>Forecast peak</th><th>On</th><th class="num">Best day</th><th>Trend</th></tr></thead><tbody>${rows}</tbody></table>
    ${_captionBlock(scene.caption)}${_aqiStdNote(d)}${SRC_NOTE}</div>`);
}

function _showIntroPopup(scene) {
  if (_state.digest?.aqi) return _aqiIntroPopup();
  const d = _state.digest;
  _presentPopup(`${_popupHead("About This Briefing", "2 Chapters", 1)}
    <div class="aqwp-body">
      ${_captionBlock("Every figure is computed live from Hawanama station data, the daily estimate and the gridded forecast. Nothing is scripted.")}
      <div class="aqwp-label">Reference values</div>
      <div class="aqwp-grid">
        <div class="aqwp-stat"><b>${_u(WHO_24H, "µg/m³")}</b><span>WHO 24-h guideline (2021)</span></div>
        <div class="aqwp-stat"><b>${_u(NEQS_24H, "µg/m³")}</b><span>Pak-NEQS 24-h standard</span></div>
        <div class="aqwp-stat"><b>${_u(WHO_ANNUAL, "µg/m³")}</b><span>WHO annual guideline</span></div>
      </div>
      ${_standardsTable()}
      <div class="aqwp-label">Layers used</div>
      <div class="aqwp-chips">
        <span class="aqwp-chip">PM2.5 Estimate — daily</span><span class="aqwp-chip">Hawanama Stations</span>
        <span class="aqwp-chip">PM2.5 Forecast +3 to +72 h</span><span class="aqwp-chip">WAQI Stations</span><span class="aqwp-chip">District Boundaries</span>
      </div>
      <div class="aqwp-label">Coverage</div>
      <div>${_esc(`${d?.past_week?.dates?.length || 0} days observed · ${d?.past_week?.cities?.length || 0} cities with station data · forecast run ${d?.forecast ? _pkt(d.forecast.init_time) : "unavailable"}`)}</div>
      ${SRC_NOTE}
    </div>`);
}

function _whyCards(d) {
  const w = _weekDrivers(d);
  const cards = [];
  const pts = w?.points?.length ? _joinList(w.points) : "the Punjab plain's main cities";
  // 1. Weather
  if (w && Number.isFinite(w.windMean)) {
    let cmp = "";
    if (w.worstMet && w.bestMet && w.worst.date !== w.best.date) {
      cmp = ` On the worst day (${_dayLabel(w.worst.date)}, median ${_r(w.worst.median)} µg/m³) wind averaged ${_r(w.worstMet.wind_kmh, 1)} km/h with a ${_fmtInt(w.worstMet.blh_max_m)} m afternoon mixing height; on the cleanest (${_dayLabel(w.best.date)}, ${_r(w.best.median)} µg/m³) it was ${_r(w.bestMet.wind_kmh, 1)} km/h and ${_fmtInt(w.bestMet.blh_max_m)} m${(w.bestMet.precip_mm || 0) >= 0.5 ? `, with ${_r(w.bestMet.precip_mm, 1)} mm of rain` : ""}.`;
    }
    const corr = Number.isFinite(w.rWind) ? ` This week, daily wind moved ${_rText(w.rWind)}.` : "";
    cards.push({ icon: "🌫️", title: "Weather trapping the pollution",
      data: `Across ${pts}, wind averaged only ${_r(w.windMean, 1)} km/h this week, and the mixing layer that pollution can disperse into rose to about ${_fmtInt(w.blhMean)} m in the afternoon but collapsed to about ${_fmtInt(w.blhNightMean)} m at night.${cmp}${corr}`,
      research: "In winter, cold clear nights form temperature inversions and a shallow mixing layer that hold emissions near the ground; studies of Lahore's smog point to this shallow layer and stagnant air as a main cause of the winter peak.",
    });
  } else {
    cards.push({ icon: "🌫️", title: "Weather trapping the pollution", data: "",
      research: "In winter, cold clear nights form temperature inversions and a shallow mixing layer that hold emissions near the ground; studies of Lahore's smog point to this shallow layer and stagnant air as a main cause of the winter peak." });
  }
  // 2. Crop-residue burning
  const pk = w?.season?.punjab;
  const ind = w?.season?.["indian-punjab"];
  if (w && Number.isFinite(w.firesWeek)) {
    const parts = [];
    if (Number.isFinite(w.regionWeek.punjab)) parts.push(`${_fmtInt(w.regionWeek.punjab)} in Pakistani Punjab`);
    if (Number.isFinite(w.regionWeek["indian-punjab"])) parts.push(`${_fmtInt(w.regionWeek["indian-punjab"])} in Indian Punjab`);
    const season = [];
    if (pk?.fires) season.push(`Pakistani Punjab ${_fmtInt(pk.fires)}${Number.isFinite(pk.pct_change) ? ` (${pk.pct_change >= 0 ? "+" : ""}${pk.pct_change}% vs ${pk.last_year})` : ""}`);
    if (ind?.fires) season.push(`Indian Punjab ${_fmtInt(ind.fires)}${Number.isFinite(ind.pct_change) ? ` (${ind.pct_change >= 0 ? "+" : ""}${ind.pct_change}% vs ${ind.last_year})` : ""}`);
    const corr = Number.isFinite(w.rFires) ? ` Day to day, fire counts moved ${_rText(w.rFires)}.` : "";
    cards.push({ icon: "🔥", title: "Crop-residue burning",
      data: `Satellites detected ${_fmtInt(w.firesWeek)} crop fires this week (${_joinList(parts)}). Rice season to date${pk?.since ? ` (since ${_shortDay(pk.since)})` : ""}: ${_joinList(season)}.${corr}`,
      research: "The Urban Unit's 2023 Lahore emission inventory attributes about 33% of the city's PM2.5 emissions to crop-residue burning (2020–21 data); burning peaks after the rice harvest in October–November, just as the mixing layer shrinks.",
    });
  }
  // 3. Year-round sources
  cards.push({ icon: "🚗", title: "Year-round local emissions",
    data: "",
    research: "The same inventory puts transport at about 35% of Lahore's PM2.5 emissions and open waste burning at about 29%, with industry at about 3%; PAQI's 2025 report instead gives transport 35%, industry 28% and brick kilns 17%, which Punjab EPA rejects. Estimates differ; winter weather and crop fires push the year-round level to extremes.",
  });
  // 4. Geography
  cards.push({ icon: "⛰️", title: "A basin that holds the air",
    data: "",
    research: "Punjab lies in the flat Indo-Gangetic plain, walled by the Himalaya and Hindu Kush to the north; slow post-monsoon and winter winds carry smoke along the plain and across the border instead of flushing it out.",
  });
  return cards;
}

function _showWeekLayerPopup(scene) {
  if (_state.digest?.aqi) return _aqiWeekPopup();
  const d = _state.digest || {};
  const daily = d.past_week?.daily || [];
  const dates = daily.map((x) => x.date);
  const w = _weekDrivers(d);
  const weekMedian = daily.length ? daily.reduce((a, x) => a + x.median, 0) / daily.length : null;
  const avgNeqs = daily.length ? daily.reduce((a, x) => a + x.share_above_neqs24, 0) / daily.length : null;
  const worst = daily.length ? daily.reduce((a, b) => (b.median > a.median ? b : a)) : null;
  const best = daily.length ? daily.reduce((a, b) => (b.median < a.median ? b : a)) : null;
  const rows = daily.map((x) => `<tr><td>${_esc(_dayLabel(x.date))}</td><td class="num"><span class="aqwp-cat" style="background:${_epa(x.median)?.color}"></span>${_u(_r(x.median), "µg/m³")}</td><td class="num">${_u(_r(x.p90), "µg/m³")}</td><td class="num">${_pct(x.share_above_neqs24)}</td><td>${_esc(x.worst_city || "—")} <small>${_u(_r(x.worst_city_pm25), "µg/m³")}</small></td></tr>`).join("");
  const cards = _whyCards(d).map((c) => `
      <div class="aqwp-why">
        <div class="aqwp-why-head"><span aria-hidden="true">${c.icon}</span>${_esc(c.title)}</div>
        ${c.data ? `<div class="aqwp-why-data">${_hl(_esc(c.data))}</div>` : ""}
        <div class="aqwp-why-research">${_esc(c.research)}</div>
      </div>`).join("");
  _presentPopup(`${_popupHead("Past 7 Days — National Picture", `${daily.length} days`, 1)}
    <div class="aqwp-body">
      <div class="aqwp-grid aqwp-grid--4">
        <div class="aqwp-stat"><b style="color:${_epa(weekMedian)?.color}">${_u(_r(weekMedian), "µg/m³")}</b><span>week average (daily medians)</span></div>
        <div class="aqwp-stat"><b>${worst ? _u(_r(worst.median), "µg/m³") : "—"}</b><span>worst day · ${_esc(worst ? _shortDay(worst.date) : "")}</span></div>
        <div class="aqwp-stat"><b>${best ? _u(_r(best.median), "µg/m³") : "—"}</b><span>cleanest day · ${_esc(best ? _shortDay(best.date) : "")}</span></div>
        <div class="aqwp-stat"><b>${_pct(avgNeqs)}</b><span>of stations above NEQS (${NEQS_24H} µg/m³), avg day</span></div>
      </div>
      <div class="aqwp-label">How bad was each day?</div>
      ${_pmChart(daily.map((x) => x.median), dates.map(_shortDay), {
        sub: dates.map((x) => _dayLabel(x).slice(0, 3)),
        whisker: daily.map((x) => x.p90),
        whiskerLabel: "worst 10% of stations (90th pct)",
        unitLabel: "Bars: national median of station daily means, PM2.5 µg/m³",
        aria: "Daily national PM2.5 median for the past week",
      })}
      ${w ? `<div class="aqwp-label">What drove it, day by day</div>${_driversStrip(dates, d.drivers)}
      <div class="aqwp-axis-note">Weather averaged over ${_esc(_joinList(w.points))}. Darker cell = more fires, stronger wind, deeper mixing. More wind and deeper mixing disperse pollution.</div>` : ""}
      <div class="aqwp-label">Why is the air this bad?</div>
      ${cards}
      <div class="aqwp-label">Day by day</div>
      <table class="aqwp-table"><thead><tr><th>Day</th><th class="num">Median</th><th class="num">Worst 10%</th><th class="num">Stations &gt; NEQS</th><th>Worst city</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="aqwp-src">Research: ${_esc(WHY_REFS.join(" · "))}.</div>
      ${SRC_NOTE}
    </div>`);
}

function _showWeekCityPopup(scene) {
  if (scene.city.aqi) return _aqiCityPopup(scene);
  const c = scene.city;
  const dates = _state.digest?.past_week?.dates || [];
  const cat = _epa(c.mean);
  _presentPopup(`${_popupHead(c.city, cat?.label, 1, cat?.color)}
    <div class="aqwp-body">
      <div class="aqwp-big"><span class="aqwp-big-value">${_r(c.mean)} <small style="font-size:12px">µg/m³</small></span><span class="aqwp-big-sub">7-day average of daily station means · ${c.n_stations} station${c.n_stations > 1 ? "s" : ""}</span></div>
      <div class="aqwp-grid">
        <div class="aqwp-stat"><b>${_u(`${_r(c.times_who24, 1)}×`, "the guideline")}</b><span>WHO 24-h guideline (${WHO_24H} µg/m³)</span></div>
        <div class="aqwp-stat"><b>${_u(`${c.days_above_neqs24}/${c.days}`, "days")}</b><span>above NEQS (${NEQS_24H} µg/m³)</span></div>
        <div class="aqwp-stat"><b>${_u(_r(c.peak), "µg/m³")}</b><span>peak day · ${_esc(_shortDay(c.peak_date))}</span></div>
      </div>
      ${_pmChart(c.series, dates.map(_shortDay), { sub: dates.map((x) => _dayLabel(x).slice(0, 3)), unitLabel: "Daily mean PM2.5 across the city's stations, µg/m³" })}
      ${_captionBlock(scene.caption)}
      <div class="aqwp-advice">${_esc(EPA_ADVICE[cat?.key] || "")}</div>
      ${SRC_NOTE}
    </div>`);
}

function _showWeekMetrosPopup(scene) {
  if (scene.aqiMetros) return _aqiMetrosPopup(scene);
  const rows = [...scene.metros].sort((a, b) => b.mean - a.mean).map((m) => {
    const cat = _epa(m.mean);
    return `<tr><td><span class="aqwp-cat" style="background:${cat?.color}"></span>${_esc(m.city)}</td><td class="num">${_u(_r(m.mean), "µg/m³")}</td><td class="num">${_u(_r(m.peak), "µg/m³")}</td><td class="num">${_u(`${m.days_above_neqs24}/${m.days}`, "days")}</td></tr>`;
  }).join("");
  _presentPopup(`${_popupHead("Major Cities — 7-Day Averages", `${scene.metros.length} cities`, 1)}
    <div class="aqwp-body">
      <table class="aqwp-table"><thead><tr><th>City</th><th class="num">7-day avg</th><th class="num">Peak day</th><th class="num">&gt; NEQS</th></tr></thead><tbody>${rows}</tbody></table>
      ${_captionBlock(scene.caption)}
      ${SRC_NOTE}
    </div>`);
}

function _showWeekAssessmentPopup(scene) {
  if (_state.digest?.aqi) return _aqiAssessPopup(scene);
  const live = _state.digest?.live;
  const s = live?.summary;
  _presentPopup(`${_popupHead("Past-Week Assessment", s ? "Live now" : "", 1)}
    <div class="aqwp-body">
      ${s ? `<div class="aqwp-label">Stations right now, US EPA category</div>${_categoryStack(live.category_counts)}
      <div class="aqwp-grid">
        <div class="aqwp-stat"><b>${_u(_r(s.median), "µg/m³")}</b><span>station median now</span></div>
        <div class="aqwp-stat"><b>${_pct(s.share_above_who24)}</b><span>of stations above WHO (${WHO_24H} µg/m³)</span></div>
        <div class="aqwp-stat"><b>${_pct(s.share_above_neqs24)}</b><span>of stations above NEQS (${NEQS_24H} µg/m³)</span></div>
      </div>` : ""}
      ${_captionBlock(scene.caption)}
      ${SRC_NOTE}
    </div>`);
}

function _showFcIntroPopup(scene) {
  const fc = _state.digest?.forecast;
  _presentPopup(`${_popupHead("The Outlook", fc ? (fc.beta ? "Beta" : "Forecast") : "Unavailable", 2)}
    <div class="aqwp-body">
      ${_captionBlock(scene.caption)}
      ${fc ? `<div class="aqwp-grid">
        <div class="aqwp-stat"><b>${_u(fc.leads.length, "steps")}</b><span>forecast frames</span></div>
        <div class="aqwp-stat"><b>${_u(`+${fc.leads[fc.leads.length - 1]?.lead_h ?? "—"}`, "hours")}</b><span>forecast horizon</span></div>
        <div class="aqwp-stat"><b>${_u((_state.waqi?.features || []).length, "stations")}</b><span>WAQI live (US AQI)</span></div>
      </div>
      <div class="aqwp-label">Model</div><div>${_esc(fc.model_tag || "Hawanama gridded PM2.5 (0.1°, ECMWF IFS + satellite)")}</div>` : ""}
      ${SRC_NOTE}
    </div>`);
}

function _showFcLayerPopup(scene) {
  if (_state.digest?.aqi?.forecast?.days?.length) return _aqiFcLayerPopup();
  const leads = _state.digest?.forecast?.leads || [];
  const rows = leads.map((l) => `<tr><td>+${l.lead_h} h</td><td>${_esc(_pkt(l.valid_time))}</td><td class="num">${_u(_r(l.mean), "µg/m³")}</td><td class="num">${_u(_r(l.p95), "µg/m³")}</td></tr>`).join("");
  _presentPopup(`${_popupHead("PM2.5 Forecast — National Grid", "Next 72 h", 2)}
    <div class="aqwp-body">
      <div class="aqwp-label">Grid mean by lead (µg/m³)</div>
      ${_pmChart(leads.map((l) => l.mean), leads.map((l) => `+${l.lead_h}h`), { sub: leads.map((l) => _pkt(l.valid_time, false).replace(" PKT", "")), whisker: leads.map((l) => l.p95), whiskerLabel: "95th percentile of grid cells (worst 5% of the country)", unitLabel: "Forecast PM2.5, national grid mean, µg/m³ (times PKT)" })}
      <table class="aqwp-table"><thead><tr><th>Lead</th><th>Valid</th><th class="num">Grid mean</th><th class="num">Worst 5%</th></tr></thead><tbody>${rows}</tbody></table>
      ${SRC_NOTE}
    </div>`);
}

function _showFcCityPopup(scene) {
  if (scene.city.fcAqi) return _aqiFcCityPopup(scene);
  const c = scene.city;
  const leads = _state.digest?.forecast?.leads || [];
  const cat = _epa(c.peak);
  const waqiRows = (scene.waqi || []).map((w) => `<tr><td>${_esc(w.name || `Station ${w.uid}`)}</td><td class="num">${_r(w.km)} km</td><td class="num"><b>${_u(w.aqi, "AQI")}</b></td></tr>`).join("");
  _presentPopup(`${_popupHead(c.city, `Peak: ${cat?.label || "—"}`, 2, cat?.color)}
    <div class="aqwp-body">
      <div class="aqwp-big"><span class="aqwp-big-value">${_r(c.peak)} <small style="font-size:12px">µg/m³</small></span><span class="aqwp-big-sub">forecast peak · ${_esc(_pkt(c.peak_valid_time))}</span></div>
      ${_pmChart(c.series, leads.map((l) => `+${l.lead_h}h`), { sub: leads.map((l) => _pkt(l.valid_time, false).replace(" PKT", "")), unitLabel: "Forecast PM2.5 over the city, µg/m³ (times PKT)" })}
      ${waqiRows ? `<div class="aqwp-label">WAQI live reference (US AQI index, not µg/m³)</div><table class="aqwp-table"><thead><tr><th>Station</th><th class="num">Distance</th><th class="num">AQI</th></tr></thead><tbody>${waqiRows}</tbody></table>` : ""}
      <div class="aqwp-advice">${_esc(EPA_ADVICE[cat?.key] || "")}</div>
      ${SRC_NOTE}
    </div>`);
}

function _showFcAssessmentPopup(scene) {
  if (_state.digest?.aqi?.forecast?.cities?.length) return _aqiFcAssessPopup(scene);
  const cities = (_state.digest?.forecast?.cities || []).filter((c) => _isMetro(c.city) || c.peak > 55.4).slice(0, 8);
  const rows = cities.map((c) => {
    const cat = _epa(c.peak);
    return `<tr><td><span class="aqwp-cat" style="background:${cat?.color}"></span>${_esc(c.city)}</td><td class="num">${_u(_r(c.peak), "µg/m³")}</td><td class="num">${_u(`+${c.peak_lead_h}`, "h")}</td><td class="num">${_u(_r(c.last), "µg/m³")}</td></tr>`;
  }).join("");
  _presentPopup(`${_popupHead("Outlook Assessment", "72 h", 2)}
    <div class="aqwp-body">
      ${rows ? `<table class="aqwp-table"><thead><tr><th>City</th><th class="num">Peak</th><th class="num">Lead</th><th class="num">At +72 h</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
      ${_captionBlock(scene.caption)}
      ${SRC_NOTE}
    </div>`);
}

// ---- Highlight overlays (district boundary, Hawanama + WAQI points) -----
function _ensureDistrictSource() {
  const map = window.ncop_map;
  if (!map) return Promise.resolve(false);
  if (map.getSource(DIST_SRC)) return Promise.resolve(true);
  const slc = window.sourceLayerControl;
  return Promise.resolve(slc?.addLayerByKey?.("district_boundary", false))
    .catch(() => {})
    .then(() => !!map.getSource(DIST_SRC));
}

function _ensureOverlayLayers() {
  const map = window.ncop_map;
  if (!map) return;
  try {
    if (map.getSource(DIST_SRC) && !map.getLayer(HL_DIST_LINE_ID)) {
      map.addLayer({ id: HL_DIST_FILL_ID, type: "fill", source: DIST_SRC, "source-layer": DIST_SRC_LAYER,
                     filter: NEVER, paint: { "fill-color": "#c4b5fd", "fill-opacity": 0.14 } });
      map.addLayer({ id: HL_DIST_LINE_ID, type: "line", source: DIST_SRC, "source-layer": DIST_SRC_LAYER,
                     filter: NEVER, paint: { "line-color": "#a78bfa", "line-width": 2.5, "line-opacity": 1 } });
    }
    if (map.getSource(STN_SRC) && !map.getLayer(HL_STN_ID)) {
      map.addLayer({ id: HL_STN_ID, type: "circle", source: STN_SRC, filter: NEVER,
                     paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffffff",
                              "circle-stroke-width": 2.5, "circle-stroke-opacity": 0.9 } });
    }
    if (map.getSource(WAQI_SRC) && !map.getLayer(HL_WAQI_ID)) {
      map.addLayer({ id: HL_WAQI_ID, type: "circle", source: WAQI_SRC, filter: NEVER,
                     paint: { "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#fbbf24",
                              "circle-stroke-width": 3, "circle-stroke-opacity": 0.95 } });
    }
    // Keep the highlights above layers added after them (chapter 2's
    // forecast frames and WAQI points).
    for (const id of [HL_DIST_FILL_ID, HL_DIST_LINE_ID, HL_STN_ID, HL_WAQI_ID]) {
      if (map.getLayer(id)) map.moveLayer(id);
    }
  } catch (_) { /* best-effort */ }
}

function _districtNameExpr() {
  return ["downcase", ["to-string", ["coalesce", ...DIST_NAME_KEYS.map((k) => ["get", k]), ""]]];
}
function _featureDistrictName(f) {
  const p = f?.properties || {};
  for (const k of DIST_NAME_KEYS) if (p[k]) return String(p[k]);
  return null;
}

function _ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function geometryContains(geom, x, y) {
  if (!geom) return false;
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  return polys.some((rings) => rings.length && _ringContains(rings[0], x, y)
    && !rings.slice(1).some((hole) => _ringContains(hole, x, y)));
}

// District names containing the given city points, from the district
// tiles already loaded for the current view (so call after the camera has
// arrived). Falls back to the city's own name, which matches most
// district names.
function _districtsAt(points) {
  const map = window.ncop_map;
  let feats = [];
  try {
    if (map?.getSource(DIST_SRC)) feats = map.querySourceFeatures(DIST_SRC, { sourceLayer: DIST_SRC_LAYER });
  } catch (_) { /* best-effort */ }
  const names = new Set();
  for (const p of points) {
    const hit = feats.find((f) => geometryContains(f.geometry, p.lon, p.lat));
    names.add(String(_featureDistrictName(hit) || p.city || "").toLowerCase().trim());
  }
  return Array.from(names).filter(Boolean);
}

function _setFilter(id, filter) {
  const map = window.ncop_map;
  try { if (map?.getLayer(id)) map.setFilter(id, filter); } catch (_) {}
}
function _highlightDistricts(names) {
  const f = names.length ? ["match", _districtNameExpr(), names, true, false] : NEVER;
  _setFilter(HL_DIST_FILL_ID, f);
  _setFilter(HL_DIST_LINE_ID, f);
}
function _highlightStations(cities) {
  const list = Array.from(new Set(cities.filter(Boolean)));
  _setFilter(HL_STN_ID, list.length ? ["match", ["to-string", ["get", "city"]], list, true, false] : NEVER);
}
function _highlightWaqi(uids) {
  const list = Array.from(new Set(uids.filter(Number.isFinite)));
  _setFilter(HL_WAQI_ID, list.length ? ["match", ["to-number", ["get", "uid"], -1], list, true, false] : NEVER);
}

function _startBlink() {
  if (_state.blinkTimer) return;
  const map = window.ncop_map;
  if (!map) return;
  _state.blinkTimer = setInterval(() => {
    _state.blinkPhase = !_state.blinkPhase;
    const on = _state.blinkPhase;
    try {
      if (map.getLayer(HL_DIST_LINE_ID)) {
        map.setPaintProperty(HL_DIST_LINE_ID, "line-width", on ? 6 : 2.5);
        map.setPaintProperty(HL_DIST_LINE_ID, "line-opacity", on ? 1 : 0.55);
      }
      if (map.getLayer(HL_DIST_FILL_ID)) map.setPaintProperty(HL_DIST_FILL_ID, "fill-opacity", on ? 0.32 : 0.1);
      if (map.getLayer(HL_STN_ID)) {
        map.setPaintProperty(HL_STN_ID, "circle-radius", on ? 18 : 11);
        map.setPaintProperty(HL_STN_ID, "circle-stroke-opacity", on ? 1 : 0.35);
      }
      if (map.getLayer(HL_WAQI_ID)) {
        map.setPaintProperty(HL_WAQI_ID, "circle-radius", on ? 21 : 13);
        map.setPaintProperty(HL_WAQI_ID, "circle-stroke-opacity", on ? 1 : 0.35);
      }
    } catch (_) { /* best-effort */ }
  }, 420);
}
function _stopBlink() {
  if (_state.blinkTimer) { clearInterval(_state.blinkTimer); _state.blinkTimer = null; }
}
function _clearHighlights() {
  _stopBlink();
  _highlightDistricts([]);
  _highlightStations([]);
  _highlightWaqi([]);
}
function _removeOverlayLayers() {
  _clearHighlights();
  const map = window.ncop_map;
  if (!map) return;
  for (const id of [HL_DIST_FILL_ID, HL_DIST_LINE_ID, HL_STN_ID, HL_WAQI_ID]) {
    try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
  }
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

async function _toggleOn(key) {
  try { await window.sourceLayerControl?.addLayerByKey?.(key, false); } catch (_) { /* best-effort */ }
}
function _toggleOff(key) {
  try { window.sourceLayerControl?.removeLayerByKey?.(key, false); } catch (_) { /* best-effort */ }
}

// Puts exactly one chapter's layers on the map. Idempotent, and also used
// when the operator jumps backwards/forwards across the chapter boundary.
async function _ensureChapterLayers(chapter, token, card) {
  if (_state.layerChapter === chapter && _state.activeLayerKey) return true;
  _clearHighlights();
  if (chapter === 1) {
    _toggleOff(WAQI_KEY);
    await _deactivateTemporal(FC_KEY);
    _trackLayerLoading(card, token, _estKey(), "Daily PM2.5 estimate (7 days)");
    const [ok] = await Promise.all([
      _activateTemporal(_estKey(), "PM2.5 Estimate, daily (µg/m³) — Hawanama", token),
      _toggleOn(STN_KEY),
    ]);
    if (token !== _state.runToken) return false;
    _state.layerChapter = 1;
    _ensureOverlayLayers();
    return ok;
  }
  _toggleOff(STN_KEY);
  await _deactivateTemporal(_estKey());
  _trackLayerLoading(card, token, FC_KEY, "PM2.5 forecast (+3 to +72 h)");
  const [ok] = await Promise.all([
    _activateTemporal(FC_KEY, "PM2.5 Forecast (µg/m³) — Hawanama BETA", token),
    _toggleOn(WAQI_KEY),
  ]);
  if (token !== _state.runToken) return false;
  _state.layerChapter = 2;
  _ensureOverlayLayers();
  return ok;
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
function _updateFrameLabel() {
  const el = document.getElementById(CARD_ID)?.querySelector(".aqw-frame-value");
  const t = _temporal();
  if (!el || !t) return;
  const e = t.currentEntry || {};
  const label = e.hawanamaDate ? _dayLabel(e.hawanamaDate) : (e.dateFull || e.date || "");
  el.textContent = label;
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

function _weekIndices() {
  const dates = new Set(_state.digest?.past_week?.dates || []);
  const defs = _temporal()?.layersDef || [];
  const idx = defs.map((f, i) => (dates.has(f.hawanamaDate) ? i : -1)).filter((i) => i >= 0);
  return idx.length ? idx : defs.map((_, i) => i).slice(-7);
}
function _forecastIndexForLead(lead) {
  return _frameIndex((f) => f.date === `+${lead}h`);
}

// ---- Scene choreography ---------------------------------------------------
async function _runIntro(map, scene, token, seq, card) {
  _showIntroPopup(scene);
  enableCinematicAtmosphere(map);
  map.jumpTo(REGIONAL_START);
  await Promise.all([
    cinematicFlyTo(map, { center: PAKISTAN_CENTER, zoom: 4.7, pitch: 35, bearing: 0, duration: _dur(4200) }),
    _ensureChapterLayers(1, token, card),
  ]);
  if (_isStale(token, seq)) return;
  await cinematicEaseTo(map, { bearing: 10, pitch: 38, duration: _dur(2000) });
}

async function _runWeekLayer(map, scene, token, seq, card) {
  await Promise.all([
    cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.9, pitch: 12, bearing: 0, duration: _dur(1800) }),
    _ensureChapterLayers(1, token, card),
  ]);
  if (_isStale(token, seq)) return;
  _showWeekLayerPopup(scene);
  // Blink the stations of every city the tour is about to visit.
  _highlightStations(_state.scenes.filter((s) => s.kind === "week-city").map((s) => s.city.city));
  _startBlink();
  _loopFrames(_weekIndices(), token, seq);
}

async function _flyToCity(map, c, token, seq, opts = {}) {
  await cinematicFlyTo(map, {
    center: [c.lon, c.lat], zoom: opts.zoom ?? 8.6, pitch: 48,
    bearing: (Math.random() * 30) - 15, duration: _dur(opts.duration ?? 3000),
  });
  if (_isStale(token, seq)) return false;
  _highlightDistricts(_districtsAt([c]));
  _startBlink();
  await orbitAroundPoint(map, [c.lon, c.lat], {
    durationMs: _dur(3400), radiusMeters: 14000, altitudeMeters: 9000, revolutions: 0.18,
  });
  return !_isStale(token, seq);
}

async function _runWeekCity(map, scene, token, seq, card) {
  const c = scene.city;
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  // Show the city's own worst day on the estimate while the camera is there.
  _setFrame(_frameIndex((f) => f.hawanamaDate === c.peak_date));
  _highlightStations([c.city]);
  _highlightDistricts([]);
  const ok = await _flyToCity(map, c, token, seq);
  if (!ok) return;
  _showWeekCityPopup(scene);
}

async function _runWeekMetros(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  const lastDate = (_state.digest?.past_week?.dates || []).slice(-1)[0];
  _setFrame(_frameIndex((f) => f.hawanamaDate === lastDate));
  const ms = scene.metros;
  const lons = ms.map((m) => m.lon);
  const lats = ms.map((m) => m.lat);
  await cinematicFitBounds(map, [[Math.min(...lons) - 0.8, Math.min(...lats) - 0.8], [Math.max(...lons) + 0.8, Math.max(...lats) + 0.8]],
    { pitch: 25, bearing: 0, duration: _dur(2800), maxZoom: 6.5, padding: { top: 60, bottom: 60, left: 380, right: 60 } });
  if (_isStale(token, seq)) return;
  _highlightStations(ms.map((m) => m.city));
  _highlightDistricts(_districtsAt(ms));
  _startBlink();
  _showWeekMetrosPopup(scene);
}

async function _runWeekAssessment(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _clearHighlights();
  _closePopup();
  const lastDate = (_state.digest?.past_week?.dates || []).slice(-1)[0];
  _setFrame(_frameIndex((f) => f.hawanamaDate === lastDate));
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(2600) });
  if (_isStale(token, seq)) return;
  _showWeekAssessmentPopup(scene);
}

async function _runFcIntro(map, scene, token, seq, card) {
  _clearHighlights();
  _closePopup();
  await Promise.all([
    cinematicFlyTo(map, { center: PAKISTAN_CENTER, zoom: 4.8, pitch: 30, bearing: -8, duration: _dur(3000) }),
    _ensureChapterLayers(2, token, card),
  ]);
  if (_isStale(token, seq)) return;
  _setFrame(0);
  _showFcIntroPopup(scene);
  // Blink every WAQI station in view — the live ground reference.
  _highlightWaqi((_state.waqi?.features || []).map((f) => Number(f.properties?.uid)));
  _startBlink();
}

async function _runFcLayer(map, scene, token, seq, card) {
  await Promise.all([
    cinematicEaseTo(map, { center: PAKISTAN_CENTER, zoom: 4.9, pitch: 12, bearing: 0, duration: _dur(1800) }),
    _ensureChapterLayers(2, token, card),
  ]);
  if (_isStale(token, seq)) return;
  _highlightWaqi([]);
  _showFcLayerPopup(scene);
  const leads = _state.digest?.forecast?.leads || [];
  _loopFrames(leads.map((l) => _forecastIndexForLead(l.lead_h)), token, seq);
}

async function _runFcCity(map, scene, token, seq, card) {
  const c = scene.city;
  await _ensureChapterLayers(2, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  _setFrame(_forecastIndexForLead(c.peak_lead_h));
  _highlightWaqi((scene.waqi || []).map((w) => w.uid));
  _highlightDistricts([]);
  const ok = await _flyToCity(map, c, token, seq, { zoom: 8.3 });
  if (!ok) return;
  _showFcCityPopup(scene);
}

async function _runFcAssessment(map, scene, token, seq, card) {
  await _ensureChapterLayers(2, token, card);
  if (_isStale(token, seq)) return;
  _clearHighlights();
  _closePopup();
  const leads = _state.digest?.forecast?.leads || [];
  const last = leads[leads.length - 1];
  if (last) _setFrame(_forecastIndexForLead(last.lead_h));
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 0, bearing: 0, duration: _dur(2600) });
  if (_isStale(token, seq)) return;
  _showFcAssessmentPopup(scene);
}

const RUNNERS = {
  "intro": _runIntro,
  "week-layer": _runWeekLayer,
  "week-city": _runWeekCity,
  "week-metros": _runWeekMetros,
  "week-assessment": _runWeekAssessment,
  "fc-intro": _runFcIntro,
  "fc-layer": _runFcLayer,
  "fc-city": _runFcCity,
  "fc-assessment": _runFcAssessment,
};

async function _enterScene(card, scene, token, seq) {
  _renderScene(card);
  _speak(_tr(scene.caption));
  const map = window.ncop_map;
  if (!map) { await wait(2000); return; }
  try {
    await RUNNERS[scene.kind]?.(map, scene, token, seq, card);
  } catch (e) {
    console.warn("[aq-watch] scene failed:", scene.kind, e); // a camera/layer hiccup must not stall the briefing
  }
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
  card.querySelector(".aqw-progress-fill").style.width = "0%";
  card.querySelector(".aqw-progress-timer").textContent = "0.0s";
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
  const fill = card.querySelector(".aqw-progress-fill");
  const timer = card.querySelector(".aqw-progress-timer");
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
    // Loop back to the intro once the last scene finishes playing.
    const n = _state.scenes.length;
    const next = ((_state.index + _state.direction) % n + n) % n;
    _gotoScene(next);
  };
  _state.tickTimer = setTimeout(advance, dwell);
}

function _setPlayGlyph(card, playing) {
  const b = card?.querySelector(".aqw-btn--play");
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
  const ff = card.querySelector(".aqw-btn--ff");
  const rw = card.querySelector(".aqw-btn--rw");
  const ffOn = direction === 1 && speed > 1;
  const rwOn = direction === -1;
  ff?.classList.toggle("is-active", ffOn);
  rw?.classList.toggle("is-active", rwOn);
  if (ff) ff.querySelector(".aqw-speed").textContent = ffOn ? `${speed}x` : "";
  if (rw) rw.querySelector(".aqw-speed").textContent = rwOn ? `${speed}x` : "";
}
function _cycleSpeed(direction) {
  if (_state.direction !== direction) _setSpeed(1, direction);
  else _setSpeed(SPEED_LEVELS[(SPEED_LEVELS.indexOf(_state.speed) + 1) % SPEED_LEVELS.length], direction);
  if (!_state.isPlaying) _play();
  else _scheduleAdvance(document.getElementById(CARD_ID), _state.runToken, _state.sceneSeq, _state.scenes[_state.index]?.caption);
}

// ---- Load / show / hide ---------------------------------------------------
function _loadingHtml(msg) {
  return `<div class="aqw-status"><span class="aqw-spinner" aria-hidden="true"></span><span>${_esc(msg)}</span></div>`;
}

// Wrapper: a pending export from the story picker is handed to the
// loader; if the loader never reaches it (no data, story closed) the
// pre-opened print window is closed instead of being left blank.
async function _loadAndPlay(card, forceRefresh = false) {
  const job = _state.pendingExport || null; // belongs to this load only
  _state.pendingExport = null;
  try {
    await _loadAndPlayInner(card, forceRefresh, job);
  } finally {
    if (job && !job.taken) { try { if (job.win && !job.win.closed) job.win.close(); } catch (_) {} }
  }
}

async function _loadAndPlayInner(card, forceRefresh = false, job = null) {
  const token = _state.runToken;
  const useCached = !forceRefresh && _state.loadedOnce && _state.digest;
  card.querySelector(".aqw-chapter-title").textContent = LABEL;
  card.querySelector(".aqw-chapter-counter").textContent = "";
  card.querySelector(".aqw-dots").innerHTML = "";
  card.querySelector(".aqw-body").innerHTML = _loadingHtml(forceRefresh
    ? "Refreshing station, estimate and forecast data…"
    : "Loading the past week's PM2.5, live stations and the 72-hour forecast…");
  if (!useCached) {
    let digest, waqi;
    const startedAt = performance.now();
    const loadTimer = setInterval(() => {
      if (token !== _state.runToken) { clearInterval(loadTimer); return; }
      _showLoader(card, "Fetching station data, crop fires, weather and the forecast…", null, startedAt);
    }, 250);
    try {
      [digest, waqi] = await Promise.all([
        _fetchJson(WATCH_URL),
        _fetchJson(WAQI_URL).catch(() => null),
      ]);
    } catch (e) {
      clearInterval(loadTimer);
      _hideLoader(card);
      if (token !== _state.runToken) return;
      card.querySelector(".aqw-body").innerHTML = `<div class="aqw-status">Air-quality data is unavailable right now (${_esc(e.message)}). Try Refresh in a few minutes.</div>`;
      return;
    }
    clearInterval(loadTimer);
    _hideLoader(card);
    if (token !== _state.runToken) return;
    _state.digest = digest;
    _state.waqi = waqi;
    _state.loadedOnce = true;
  }
  _state.scenes = _buildScenes(_state.digest);
  _state.index = 0;
  _state.layerChapter = 0;
  _setSpeed(1, 1);
  _state.ttsEnabled = false; // every run starts muted, like the other briefings
  _syncMuteButton(card);
  await _ensureDistrictSource();
  if (token !== _state.runToken) return;

  if (job) {
    // Opened from the picker's Export: English, no language prompt, no
    // autoplay — export, then rest paused on the first scene.
    job.taken = true;
    _state.lang = "en";
    _syncLangButton(card);
    _state.isPlaying = false;
    _setPlayGlyph(card, false);
    await _exportReport(job.format, job.win);
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
  _removeOverlayLayers();
  const map = window.ncop_map;
  if (map) disableCinematicAtmosphere(map);
  _stopLayerTracking(document.getElementById(CARD_ID));
  if (_state.layerChapter === 1 || _state.activeLayerKey === _estKey()) _toggleOff(STN_KEY);
  if (_state.layerChapter === 2 || _state.activeLayerKey === FC_KEY) _toggleOff(WAQI_KEY);
  if (_state.activeLayerKey) _deactivateTemporal(_state.activeLayerKey);
  _state.layerChapter = 0;
}

async function _handleRefresh(card) {
  const btn = card.querySelector(".aqw-refresh");
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.classList.add("is-spinning"); }
  _stopEverything();
  try {
    await _loadAndPlay(card, true);
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("is-spinning"); }
  }
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

// Only acts when this story was the one playing. Restores the 7-Day
// Outlook unless the operator switched straight to the Dynamic Weather
// Report (whose own listener has already hidden the outlook for itself).
function _hide() {
  if (!_state.active) return;
  _state.active = false;
  _stopEverything();
  const root = document.getElementById(ROOT_ID);
  const card = root?.querySelector(`#${CARD_ID}`);
  if (card) card.style.display = "none";
  const sel = document.getElementById(SELECT_ID);
  if ([DWR_SENTINEL, "__flood_watch__", "__food_security_watch__"].includes(sel?.value)) return;
  const chapters = root?.querySelector("#storyChapters");
  if (chapters) chapters.style.display = "grid";
  window.ncopProvincialForecast?.restore();
}

// ==========================================================================
// Export Report (PDF / Word) — sections from the briefing's own popups and
// narration; renderers in story-report-export.js. Works without playing.
// ==========================================================================
const REPORT_CHAPTERS = { 1: "The Past Week", 2: "The Outlook" };
const REPORT_POPUPS = {
  "intro": (sc) => _showIntroPopup(sc),
  "week-layer": (sc) => _showWeekLayerPopup(sc),
  "week-city": (sc) => _showWeekCityPopup(sc),
  "week-metros": (sc) => _showWeekMetrosPopup(sc),
  "week-assessment": (sc) => _showWeekAssessmentPopup(sc),
  "fc-intro": (sc) => _showFcIntroPopup(sc),
  "fc-layer": (sc) => _showFcLayerPopup(sc),
  "fc-city": (sc) => _showFcCityPopup(sc),
  "fc-assessment": (sc) => _showFcAssessmentPopup(sc),
};
function _reportWorstDay(d) {
  const daily = d?.past_week?.daily || [];
  return daily.length ? daily.reduce((a, b) => (b.median > a.median ? b : a)) : null;
}
function _reportPeakLead(d) {
  const leads = d?.forecast?.leads || [];
  return leads.length ? leads.reduce((a, b) => ((b.mean ?? -1) > (a.mean ?? -1) ? b : a)) : null;
}
const REPORT_SHOTS = [
  { key: "map1", chapter: 1, label: "Map: PM2.5 estimate, worst day", settleMs: 700,
    prepare: async (d) => { const w = _reportWorstDay(d); if (w) _setFrame(_frameIndex((f) => f.hawanamaDate === w.date)); },
    caption: (d) => { const w = _reportWorstDay(d); if (w && d.aqi) return `Dots: ground stations coloured by US AQI (observed, live). Surface: satellite-supported PM2.5 estimate for ${_dayLabel(w.date)}, the week's worst day (modelled, µg/m³).`; return w ? `Daily PM2.5 estimate on the week's worst day, ${_dayLabel(w.date)} (national station median ${_r(w.median)} µg/m³), with live stations.` : "Daily PM2.5 estimate."; } },
  { key: "map2", chapter: 2, label: "Map: PM2.5 forecast peak", settleMs: 700,
    prepare: async (d) => { const p = _reportPeakLead(d); if (p) _setFrame(_forecastIndexForLead(p.lead_h)); },
    caption: (d) => { const p = _reportPeakLead(d); if (p && d.aqi) return `Surface: Hawanama PM2.5 forecast for one hour, ${_pkt(p.valid_time)} (+${p.lead_h} h, its national peak; modelled, µg/m³). Dots: live WAQI stations coloured by US AQI (observed).`; return p ? `PM2.5 forecast at its national peak, +${p.lead_h} h (${_pkt(p.valid_time)}), with live WAQI stations.` : "PM2.5 forecast."; } },
];
function _reportMeta(d) {
  if (d?.aqi) return airQualityReportMeta(d);
  const dates = d?.past_week?.dates || [];
  return {
    title: LABEL,
    subtitle: "PM2.5 over the past week and the next 72 hours, against WHO and Pak-NEQS limits",
    strip: [
      { label: "Issued", value: new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
      { label: "Past week", value: dates.length ? `${_dayLabel(dates[0])} – ${_dayLabel(dates[dates.length - 1])}` : "n/a" },
      { label: "Forecast issued", value: d?.forecast?.init_time ? _pkt(d.forecast.init_time) : "n/a" },
      { label: "Reference", value: `NDMA/NCOP/AQW/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}` },
    ],
    glossary: [
      { term: "PM2.5", def: "Tiny dust and smoke particles, smaller than 2.5 micrometres (about one-thirtieth of a hair's width), that reach deep into the lungs." },
      { term: "µg/m³", def: "Micrograms per cubic metre of air: how much PM2.5 is in the air we breathe." },
      { term: "WHO guideline (15 µg/m³)", def: "The World Health Organization's 2021 advice for a safe daily average." },
      { term: "Pak-NEQS (35 µg/m³)", def: "Pakistan's legal daily limit (National Environmental Quality Standards, 2010)." },
      { term: "AQI categories", def: "US EPA colour bands (Good, Moderate, Unhealthy for sensitive groups, Unhealthy, Very Unhealthy, Hazardous) that turn PM2.5 into health advice." },
      { term: "Median / 90th percentile", def: "The middle station, and the level that only the worst 10% of stations exceed." },
      { term: "Forecast lead (+24 h)", def: "How far ahead of the forecast's issue time a value is valid." },
      { term: "VIIRS fires", def: "Fires spotted by NASA satellites, mostly crop-stubble burning." },
      { term: "Smog season", def: "Roughly October to January, when cool, still air traps smoke and exhaust near the ground." },
    ],
    footer: "Sources: Pakistan Air Quality Initiative (Hawanama, CC BY 4.0), WAQI, Open-Meteo, NASA VIIRS fires; WHO AQG 2021, Pak-NEQS 2010, US EPA AQI 2024.",
  };
}

// Run a scene's popup builder with its output redirected into the report.
function _reportPopupHtml(scene) {
  const fn = REPORT_POPUPS[scene.kind];
  if (!fn) return "";
  let html = "";
  const present = _presentPopup;
  _presentPopup = (h) => { html = h; };
  try { fn(scene); } catch (e) { console.warn("[air-quality-watch] report popup failed:", scene.kind, e); } finally { _presentPopup = present; }
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
  _clearHighlights();
  _state.runToken += 1;          // stops any running scene choreography
  const token = _state.runToken;
  const d = _state.digest;
  try {
    await runStoryExport({
      format, win, card, slug: "national-air-quality-watch", meta: _reportMeta(d),
      steps: [{ key: "data", label: "Briefing data" }, ...REPORT_SHOTS.map((s) => ({ key: s.key, label: s.label }))],
      build: async ({ run, mark }) => {
        run("data"); mark("data");
        const shots = {};
        for (const s of REPORT_SHOTS) {
          run(s.key);
          if (token !== _state.runToken) throw new Error("briefing closed during export");
          let src = null;
          if (map) {
            try {
              await _ensureChapterLayers(s.chapter, token, card);
              await s.prepare?.(d);
              map.fitBounds(PAKISTAN_BOUNDS, { duration: 0, padding: 30, pitch: 0, bearing: 0 });
              src = await captureMap(map, { settleMs: s.settleMs || 300 });
            } catch (e) { console.warn("[air-quality-watch] report capture failed:", s.key, e); }
          }
          if (token !== _state.runToken) throw new Error("briefing closed during export");
          (shots[s.chapter] ||= []).push({ src, caption: typeof s.caption === "function" ? s.caption(d) : s.caption });
          mark(s.key, src ? "ok" : "warn");
        }
        // AQI-first report; the popup-based PM2.5 report is the fallback.
        const aqiSections = airQualityReportSections(d, { shots, waqiNear: _waqiNear });
        if (aqiSections) return aqiSections;
        return scenesToSections({ scenes: _state.scenes, chapterNames: REPORT_CHAPTERS, titleOf: _sceneTitle, popupOf: _reportPopupHtml, shots, glanceKinds: ["week-layer", "fc-layer"], bottomLineKinds: ["week-assessment", "fc-assessment"] });
      },
    });
  } finally {
    _clearHighlights();
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

// Story panel's X button: stop without resurrecting another story.
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

// Story picker's Export button: open this briefing in export-only mode.
function _exportFromPicker(format, win) {
  const sel = document.getElementById(SELECT_ID);
  if (!sel || _exporting) { try { if (win && !win.closed) win.close(); } catch (_) {} return false; }
  _state.pendingExport = { format, win };
  sel.value = SENTINEL;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

window.ncopAirQualityWatch = {
  closeAll: _closeCompletely,
  exportReport: _exportFromPicker,
};

export function initStoryAirQualityWatch() {
  if (_wired) return;
  _wireStorySelectWhenReady();
  if (_wireModalVisibility()) { _wired = true; return; }
  const mo = new MutationObserver(() => {
    if (_wireModalVisibility()) { _wired = true; mo.disconnect(); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 20000);
}

// Pure builders, exported for tests.
export const _test = { buildScenes: _buildScenes, epa: _epa, dedupe: _dedupeByDistance, reliableCities: _reliableCities };

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initStoryAirQualityWatch);
  else initStoryAirQualityWatch();
}
