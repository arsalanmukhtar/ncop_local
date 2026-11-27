// ==========================================================================
// story-food-security-watch.js
// --------------------------------------------------------------------------
// National Food Security & Agriculture Watch — a cinematic briefing
// selectable from #storySelect next to the other four stories. Same
// integration and playback model: injected sentinel <option> (re-injected
// by a MutationObserver), capture-phase "change" listener, the 7-Day
// Outlook paused via window.ncopProvincialForecast, a card in #story-root
// with play/pause, prev/next, FF/RW, scene dots, optional narration and
// Urdu captions. The playback engine is the one story-air-quality-watch.js
// uses; no state is shared with any other story.
//
// Written as an operational (military-style) briefing: bottom line up
// front, situation, where, outlook, recommended actions.
//
// CHAPTER 1 — Hunger Now (IPC): ipc_pakistan layer; population by phase,
//   provinces, hotspot districts (outline + the IPC Food Security panel),
//   the 2017→ trend, and the regional picture (ipc_afghanistan).
// CHAPTER 2 — The Harvests (PBS): crop_provincial driven through the crop
//   filter (wheat, rice, cotton, maize), national 20-year series vs the
//   5-year average, provinces, top wheat districts; Crop Explorer panel.
// CHAPTER 3 — Markets & Prices (WFP): retail prices in Lahore, Karachi,
//   Peshawar, Quetta and Multan; year-on-year change; purchasing power
//   (kg of wheat flour one day's unskilled wage buys).
// CHAPTER 4 — The Next 1–2 Months: bias-corrected GEFS rain outlook vs
//   2001–2025 normals by province (gefs_precip_35d on the map), the crop
//   calendar, and an INDICATIVE seasonal price path (labelled as such).
// CHAPTER 5 — Why, and the assessment: research context and a watch level
//   computed from transparent indicators, with recommended actions.
//
// Data: GET /api/foodsec/watch/ (foodsec_watch.py — one cached digest of
// the IPC and PBS endpoints NCOP already serves, WFP/HDX prices and the
// GEFS district outlook). Every figure is computed from that live data;
// research statements cite only verified sources (REFS).
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
import { LEVELS as EWS_LEVELS, ewsHeadline, districtReason, concernList, prettyProvince, foodReportMeta, foodReportSections } from "./story-food-security-report.js";

const MODAL_ID  = "story-modal";
const ROOT_ID   = "story-root";
const SELECT_ID = "storySelect";
const SENTINEL  = "__food_security_watch__";
const LABEL     = "National Food Security & Agriculture Watch";
// Other cinematic stories: switching straight to one of them must not
// resurrect the 7-Day Outlook (they hide it themselves).
const OTHER_STORY_SENTINELS = ["__dynamic_weather__", "__air_quality_watch__", "__flood_watch__"];
const CARD_ID   = "ncop-food-security-watch";
const POPUP_ID  = "ncop-food-security-watch-popup";
const STYLE_ID  = "ncop-food-security-watch-style";

const IPC_KEY     = "ipc_pakistan";
const IPC_AFG_KEY = "ipc_afghanistan";
const CROP_KEY    = "crop_provincial";
const GEFS_KEY    = "gefs_precip_35d";
const WATCH_URL   = "/api/foodsec/watch/";
const WATCH_WAIT_MS = 90000;           // first-ever digest build on a cold server

const OUTLINE_SRC  = "_ncop_fsw_outline";
const OUTLINE_FILL = "_ncop_fsw_outline_fill";
const OUTLINE_LINE = "_ncop_fsw_outline_line";
const FOCUS_SRC    = "_ncop_fsw_focus";
const FOCUS_HALO_ID = "_ncop_fsw_focus_halo";
const FOCUS_RING_ID = "_ncop_fsw_focus_ring";

const PAKISTAN_CENTER = [70.2, 30.2];
const PAKISTAN_BOUNDS = [[60.8, 23.6], [77.9, 37.1]];
const REGION_BOUNDS   = [[60.4, 23.4], [75.5, 38.6]];   // Pakistan + Afghanistan
const PUNJAB_PLAIN    = [72.6, 30.6];
const REGIONAL_START  = { center: [69.5, 30.0], zoom: 3.4, pitch: 0, bearing: 0 };

const HOTSPOT_MAX = 5;
const DWELL_MS_NO_TTS = 7000;
const SPEED_LEVELS = [1, 2, 3, 4, 5];
const FRAME_STEP_MS = 700;
const DOCK_HEIGHT_PX = 330;

const IPC_PHASES = [
  { k: 1, label: "Minimal", color: "#CDFACD" },
  { k: 2, label: "Stressed", color: "#FAE61E" },
  { k: 3, label: "Crisis", color: "#E67800" },
  { k: 4, label: "Emergency", color: "#C80100" },
  { k: 5, label: "Famine", color: "#640000" },
];
const CROP_RAMP = ["#f7fcf5", "#c7e9c0", "#74c476", "#238b45", "#00441b"];
const FOCUS_CROPS = [4, 2, 5, 1];        // wheat, rice, cotton, maize (PBS ids)
const KEY_PRICES = ["Wheat flour", "Wheat", "Rice (coarse)", "Sugar", "Oil (cooking)", "Ghee (artificial)", "Milk",
  "Lentils (masur)", "Poultry", "Eggs", "Fuel (diesel)"];
const OUTLOOK_PRICES = ["Wheat flour", "Rice (coarse)", "Oil (cooking)", "Sugar", "Milk"];
const SHORT_NAMES = { "Wage (non-qualified labour, non-agricultural)": "Daily wage (unskilled)",
  "Rice (basmati, broken)": "Rice (basmati)", "Ghee (artificial)": "Ghee", "Oil (cooking)": "Cooking oil",
  "Lentils (masur)": "Masoor lentils", "Lentils (gram)": "Gram lentils", "Fuel (diesel)": "Diesel" };

const WATCH_LEVELS = [
  { label: "Normal",  color: "#3FA34D", action: "Routine monitoring. Keep market and harvest reporting on schedule." },
  { label: "Watch",   color: "#E7B416", action: "Heightened monitoring of hotspot districts and staple prices; pre-position assessment teams." },
  { label: "Warning", color: "#E67800", action: "Activate targeted assistance planning for Phase 3+ districts; coordinate with provincial food departments on wheat stocks and flour prices; track sowing in rain-fed areas." },
  { label: "Alert",   color: "#C80100", action: "Scale up food and cash assistance in Phase 4 areas; release strategic reserves; daily price and stock reporting." },
];

// Verified sources only (each checked live). `cite` is the short form shown
// under a finding; `full` the reference list in the assessment.
const REFS = {
  ipc2026: { cite: "IPC Pakistan analysis, Dec 2025–Sep 2026",
    full: "IPC (2026). Pakistan: Acute Food Insecurity Situation Dec 2025–Mar 2026 and Projection Apr–Sep 2026 (45 districts), with the March 2026 Punjab analysis (6 districts). Both projections ended 30 September 2026. ipcinfo.org." },
  ipcMal: { cite: "IPC Pakistan acute malnutrition analysis, 2025–26",
    full: "IPC (2026). Pakistan: Acute Malnutrition Oct 2025–Mar 2026 and Projection Apr–Sep 2026 (Balochistan, KP, Sindh). ipcinfo.org." },
  pdna: { cite: "Pakistan Floods 2022 PDNA",
    full: "Government of Pakistan, ADB, EU, UNDP, World Bank (2022). Pakistan Floods 2022: Post-Disaster Needs Assessment." },
  faoUnfccc: { cite: "FAO submission to UNFCCC, 2024",
    full: "FAO Pakistan (2024). Submission to the UNFCCC on loss and damage in the agrifood sector from the 2022 floods." },
  fao2025: { cite: "FAO satellite flood assessment, Sep 2025",
    full: "FAO (2025). Satellite-based assessment of 2025 monsoon flood impacts on cropland in Punjab, Pakistan." },
  survey: { cite: "Pakistan Economic Survey 2024–25",
    full: "Finance Division, Government of Pakistan (2025). Pakistan Economic Survey 2024–25, Chapter 2: Agriculture." },
  giewsWheat: { cite: "FAO GIEWS country brief, 2025",
    full: "FAO GIEWS (2025). Country Brief: Pakistan — wheat area and minimum support price." },
  grfc: { cite: "Global Report on Food Crises 2024",
    full: "FSIN & Global Network Against Food Crises (2024). Global Report on Food Crises 2024 — Pakistan." },
  wbFood: { cite: "World Bank Food Security Update, Sep 2023",
    full: "World Bank (2023). Food Security Update, September 2023." },
  nns: { cite: "National Nutrition Survey 2018",
    full: "Government of Pakistan & UNICEF (2019). National Nutrition Survey 2018 — Key Findings Report." },
  faoGlance: { cite: "FAO in Pakistan — Pakistan at a glance",
    full: "FAO. Pakistan at a glance (agriculture's share of GDP, employment and exports). fao.org/pakistan." },
  fewsIndus: { cite: "FEWS NET Pakistan reporting",
    full: "FEWS NET (2026). Pakistan context and food security outlook reports. fews.net." },
  ipcAfg: { cite: "IPC Afghanistan analysis, 2026",
    full: "IPC (2026). Afghanistan: Acute Food Insecurity and Malnutrition analysis. ipcinfo.org." },
  wfpPrices: { cite: "WFP market monitoring (HDX)",
    full: "World Food Programme VAM (2026). Pakistan — Food Prices (monthly retail, 5 markets). Humanitarian Data Exchange, CC BY-IGO." },
  giewsCal: { cite: "FAO GIEWS crop calendar, Pakistan",
    full: "FAO GIEWS. Crop calendar — Pakistan (wheat, rice, maize, cotton, sugarcane)." },
  gefs: { cite: "NOAA GEFS v12, bias-corrected by NCOP",
    full: "NOAA GEFS v12 ensemble mean via NOAA Open Data; district values bias-corrected against NASA POWER (IMERG/MERRA-2) by NCOP (158 verified forecasts)." },
};
Object.assign(REFS, {
  fewsOct: { cite: "FEWS NET Pakistan outlook, Oct 2026",
    full: "FEWS NET (2026). Pakistan Food Security Outlook, October 2026, and district classification data. fews.net/asia/pakistan" },
  hies: { cite: "PBS HIES 2024–25",
    full: "Pakistan Bureau of Statistics (2026). Household Integrated Economic Survey 2024–25, Tables 7.1–7.2." },
  diet: { cite: "World Bank / FAO, cost of a healthy diet",
    full: "World Bank and FAO (2026). Food Prices for Nutrition 5.0: cost and affordability of a healthy diet. CC BY 4.0." },
  psd: { cite: "USDA PSD", full: "USDA Foreign Agricultural Service (2026). Production, Supply and Distribution database: Pakistan grains." },
  irsa: { cite: "IRSA decision, Dawn 7 Oct 2026", full: "Dawn (7 October 2026). IRSA okays 22pc lower water share for Rabi. dawn.com/news/2035296" },
  monsoon: { cite: "PMD monsoon 2026, The Nation", full: "The Nation (30 September 2026). Pakistan's 2026 monsoon rainfall falls 19.3 percent below normal (PMD data)." },
  eo: { cite: "CHIRPS v3, NASA FLDAS, MODIS", full: "CHIRPS v3 rainfall (UC Santa Barbara), FLDAS soil moisture (NASA), MODIS vegetation index (NASA); district means by NCOP." },
  enso: { cite: "NOAA CPC", full: "NOAA Climate Prediction Center (2026). Oceanic Niño Index and weekly Niño 3.4 sea-surface temperature." },
  acled: { cite: "ACLED via HDX", full: "ACLED monthly conflict events for Pakistan, through OCHA HDX HAPI." },
  khaleej: { cite: "Khaleej Times, 20 Nov 2026", full: "Khaleej Times (20 November 2026). Why is food becoming unaffordable for millions of households in Pakistan?" },
});
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
  digest: null,          // /api/foodsec/watch/ payload
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
  toggledOn: new Set(),  // toggles this story switched on (only these are switched off again)
  cropSelected: null,    // crop id the story set in the crop filter
  operatorCrop: null,    // crop id the operator had selected (restored on exit)
  dockedOpen: null,      // "ipc" | "crop" when a stats panel is open
};

// ---- Small helpers ----------------------------------------------------------
function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const HIGHLIGHT_RE = /(\d[\d,]*(?:\.\d+)?\s?(?:million|%|PKR|kg|mm|°C|tonnes|bales|t\b|×|months?\b|years?\b|districts?\b))/g;
function _hl(escaped) {
  return String(escaped || "").replace(HIGHLIGHT_RE, '<mark class="fsw-hl">$1</mark>');
}
function _fmt(v, d = 0) {
  return Number.isFinite(v) ? Number(v).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—";
}
function _mil(v, d = 1) {
  return Number.isFinite(v) ? `${(v / 1e6).toFixed(d)} million` : "—";
}
function _u(value, unit) {
  return `${value}<small class="fswp-u">${_esc(unit)}</small>`;
}
function _pct(share, d = 0) {
  return Number.isFinite(share) ? `${(share * 100).toFixed(d)}%` : "—";
}
function _signed(v, d = 1, unit = "%") {
  if (!Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(d)}${unit}`;
}
// Chart axis label: "Oct '26"; prose: "October 2026".
function _monthLabel(ym) {
  const d = new Date(`${String(ym).slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(ym);
  return `${d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })} '${String(d.getUTCFullYear()).slice(2)}`;
}
function _monthLong(ym) {
  const d = new Date(`${String(ym).slice(0, 7)}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(ym) : d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
function _dayMonth(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
function _yieldUnit(s) {
  return s.unit === "000 bales" ? "bales per hectare" : "tonnes per hectare";
}
function _joinList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
function _dur(ms) {
  return Math.max(150, ms / (_state.speed || 1));
}
function _isStale(token, seq) {
  return token !== _state.runToken || seq !== _state.sceneSeq;
}
function _textOn(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return "#fff";
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#111" : "#fff";
}
function _short(name) {
  return SHORT_NAMES[name] || name;
}
function _bboxToBounds(b) {
  return Array.isArray(b) && b.length === 4 ? [[b[0], b[1]], [b[2], b[3]]] : null;
}
function _unionBbox(list) {
  const bs = list.map((x) => x.bbox).filter((b) => Array.isArray(b) && b.length === 4);
  if (!bs.length) return null;
  return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
}
function _price(d, name) {
  return (d?.prices?.items || []).find((x) => x.commodity === name) || null;
}
function _staple(d, id) {
  return (d?.crops?.staples || []).find((s) => s.id === id) || null;
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
  card?.querySelector(".fsw-lang")?.classList.add("is-loading");
  _translateInFlight = (async () => {
    let ok = false;
    for (let i = 0; i < missing.length; i += TRANSLATE_CHUNK_SIZE) {
      const chunk = missing.slice(i, i + TRANSLATE_CHUNK_SIZE);
      try {
        const out = await _translateBatch(chunk);
        chunk.forEach((t, j) => _translationCache.set(t, out[j]));
        ok = true;
      } catch (e) {
        console.warn("[food-watch] Urdu translation chunk failed:", e);
      }
    }
    return ok;
  })().finally(() => {
    card?.querySelector(".fsw-lang")?.classList.remove("is-loading");
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
    const body = card.querySelector(".fsw-body");
    if (!body) { resolve("en"); return; }
    const last = _loadLangPref();
    body.innerHTML = `
      <div class="fsw-prompt" role="dialog" aria-labelledby="fsw-lang-title">
        <div class="fsw-prompt-icon" aria-hidden="true">🌐</div>
        <div id="fsw-lang-title" class="fsw-prompt-title">Choose a Language</div>
        <div class="fsw-prompt-desc">Language for this briefing's narrative text and voice narration. You can switch anytime from the header.</div>
        <div class="fsw-prompt-buttons">
          <button type="button" class="fsw-prompt-btn${last === "en" ? " is-primary" : ""}" data-choice="en">English</button>
          <button type="button" class="fsw-prompt-btn${last === "ur" ? " is-primary" : ""}" data-choice="ur">اردو</button>
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
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(34, 197, 94, 0.06));
      border: 1px solid rgba(245, 158, 11, 0.38);
      border-radius: 10px; color: #eaeaea; font-size: 12.5px; line-height: 1.5;
    }
    #${CARD_ID} .fsw-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    #${CARD_ID} .fsw-title {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #fcd34d;
    }
    #${CARD_ID} .fsw-live {
      width: 7px; height: 7px; border-radius: 50%; background: #f59e0b;
      box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.3); animation: fsw-pulse 1.6s ease-in-out infinite;
    }
    @keyframes fsw-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.7); } }
    #${CARD_ID} .fsw-head-actions { display: flex; align-items: center; gap: 6px; }
    #${CARD_ID} .fsw-icon-btn {
      appearance: none; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; font-size: 12px; line-height: 1;
      color: rgba(234, 234, 234, 0.65); background: rgba(255, 255, 255, 0.06); border-radius: 999px;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${CARD_ID} .fsw-icon-btn:hover { background: rgba(245, 158, 11, 0.28); color: #fff; }
    #${CARD_ID} .fsw-close:hover { background: rgba(220, 38, 38, 0.25); }
    #${CARD_ID} .fsw-mute.is-muted { color: rgba(234, 234, 234, 0.35); }
    #${CARD_ID} .fsw-refresh:disabled { opacity: 0.6; cursor: default; }
    #${CARD_ID} .fsw-refresh.is-spinning svg { animation: fsw-spin 0.9s linear infinite; }
    #${CARD_ID} .fsw-lang {
      appearance: none; cursor: pointer; padding: 3px 9px; border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12); background: rgba(255, 255, 255, 0.06);
      font-size: 10.5px; font-weight: 600; line-height: 1; color: rgba(234, 234, 234, 0.8);
    }
    #${CARD_ID} .fsw-lang.is-active { background: rgba(245, 158, 11, 0.3); color: #fff; }
    #${CARD_ID} .fsw-lang.is-loading { opacity: 0.55; pointer-events: none; }
    .fsw-lang-ur {
      direction: rtl; text-align: right;
      font-family: "Noto Nastaliq Urdu", "Segoe UI", Tahoma, "Noto Naskh Arabic", sans-serif;
      font-size: 1.05em; line-height: 1.9;
    }
    #${CARD_ID} .fsw-chapter-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    #${CARD_ID} .fsw-chapter-title { font-size: 14px; font-weight: 800; color: #fff; }
    #${CARD_ID} .fsw-chapter-counter { font-size: 10.5px; color: rgba(234, 234, 234, 0.55); white-space: nowrap; font-variant-numeric: tabular-nums; }
    #${CARD_ID} .fsw-body { min-height: 40px; }
    #${CARD_ID} .fsw-status { display: flex; align-items: center; gap: 8px; padding: 12px 4px; font-size: 12px; color: rgba(234, 234, 234, 0.85); }
    #${CARD_ID} .fsw-spinner {
      width: 13px; height: 13px; border-radius: 50%; flex: 0 0 auto;
      border: 2px solid rgba(245, 158, 11, 0.25); border-top-color: #f59e0b; animation: fsw-spin 0.8s linear infinite;
    }
    @keyframes fsw-spin { to { transform: rotate(360deg); } }
    #${CARD_ID} .fsw-caption { font-size: 12.5px; line-height: 1.6; animation: fsw-in 0.5s ease; }
    @keyframes fsw-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    #${CARD_ID} mark.fsw-hl, #${POPUP_ID} mark.fsw-hl {
      background: rgba(245, 158, 11, 0.24); color: #fff; font-weight: 800;
      padding: 0 4px; border-radius: 4px; -webkit-box-decoration-break: clone; box-decoration-break: clone;
    }
    #${CARD_ID} .fsw-facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    #${CARD_ID} .fsw-pill {
      font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px;
      background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12);
    }
    #${CARD_ID} .fsw-pill.is-alert { background: rgba(220, 38, 38, 0.18); border-color: rgba(248, 113, 113, 0.4); color: #fca5a5; }
    #${CARD_ID} .fsw-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: 0; }
    #${CARD_ID} .fsw-legend { margin-top: 8px; padding: 8px 9px; border-radius: 8px;
      background: rgba(0, 0, 0, 0.22); border: 1px solid rgba(255, 255, 255, 0.08); display: grid; gap: 8px; }
    #${CARD_ID} .fsw-legend-title { font-size: 10.5px; font-weight: 700; color: #eaeaea; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    #${CARD_ID} .fsw-legend-title small { font-weight: 400; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .fsw-legend-kind { font-size: 8.5px; font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
      padding: 1px 6px; border-radius: 999px; background: rgba(245, 158, 11, 0.22); color: #fde68a; }
    #${CARD_ID} .fsw-legend-scale { padding: 0 2px 12px; }
    #${CARD_ID} .fsw-legend-scale .ts-legend-stack { width: 100%; }
    #${CARD_ID} .fsw-legend-scale .ts-legend-values span { font-size: 9px; white-space: nowrap; }
    #${CARD_ID} .fsw-steps { display: grid; grid-template-columns: repeat(6, 1fr); gap: 2px; }
    #${CARD_ID} .fsw-step { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 8.5px; color: rgba(234, 234, 234, 0.7); }
    #${CARD_ID} .fsw-step i { display: block; width: 100%; height: 8px; border-radius: 2px; }
    #${CARD_ID} .fsw-legend-row--hl { display: flex; flex-wrap: wrap; gap: 4px 12px; }
    #${CARD_ID} .fsw-hl-key { display: inline-flex; align-items: center; gap: 5px; font-size: 9.5px; color: rgba(234, 234, 234, 0.7); }
    #${CARD_ID} .fsw-hl-key i { display: inline-block; width: 12px; height: 12px; border-radius: 50%; }
    #${CARD_ID} .fsw-hl-key i.is-district { border-radius: 2px; border: 2px solid #f59e0b; background: rgba(253, 230, 138, 0.2); animation: fsw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .fsw-hl-key i.is-station { border: 2px solid #fff; animation: fsw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .fsw-hl-key i.is-waqi { border: 2px solid #fbbf24; animation: fsw-pulse 0.84s ease-in-out infinite; }
    #${CARD_ID} .fsw-loader {
      display: flex; align-items: center; gap: 9px; margin-top: 8px; padding: 7px 9px; border-radius: 8px;
      background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.28); animation: fsw-in 0.3s ease;
    }
    #${CARD_ID} .fsw-loader[hidden] { display: none; }
    #${CARD_ID} .fsw-loader-main { flex: 1 1 auto; min-width: 0; }
    #${CARD_ID} .fsw-loader-text { font-size: 10.5px; color: rgba(234, 234, 234, 0.85); margin-bottom: 4px; }
    #${CARD_ID} .fsw-loader-bar { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); overflow: hidden; position: relative; }
    #${CARD_ID} .fsw-loader-bar i { display: block; height: 100%; width: 0; border-radius: 999px;
      background: linear-gradient(90deg, #f59e0b, #22c55e); transition: width 0.3s ease; }
    #${CARD_ID} .fsw-loader-bar.is-indeterminate i { width: 35% !important; animation: fsw-indet 1.1s ease-in-out infinite; }
    @keyframes fsw-indet { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
    #${CARD_ID} .fsw-loader-time { font-size: 10px; color: rgba(234, 234, 234, 0.55); font-variant-numeric: tabular-nums; min-width: 32px; text-align: right; }
    #${CARD_ID} .fsw-loader.is-done { background: rgba(34, 197, 94, 0.1); border-color: rgba(34, 197, 94, 0.35); }
    #${CARD_ID} .fsw-loader.is-done .fsw-spinner { animation: none; border-color: #22c55e; }
    #${CARD_ID} .fsw-loader.is-done .fsw-loader-bar i { background: #22c55e; }
    #${CARD_ID} .fsw-layer-loading { margin-top: 6px; font-size: 11px; font-style: italic; color: rgba(234, 234, 234, 0.6); }
    #${CARD_ID} .fsw-progress-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    #${CARD_ID} .fsw-progress-track { flex: 1 1 auto; height: 3px; background: rgba(255, 255, 255, 0.08); border-radius: 999px; overflow: hidden; }
    #${CARD_ID} .fsw-progress-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #f59e0b, #22c55e); transition: width 0.2s linear; }
    #${CARD_ID} .fsw-progress-timer { min-width: 38px; text-align: right; font-size: 10px; color: rgba(234, 234, 234, 0.55); font-variant-numeric: tabular-nums; }
    #${CARD_ID} .fsw-transport { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
    #${CARD_ID} .fsw-btn {
      appearance: none; border: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; color: #eaeaea; background: rgba(255, 255, 255, 0.06); border-radius: 999px;
      transition: background 0.15s ease;
    }
    #${CARD_ID} .fsw-btn:hover { background: rgba(245, 158, 11, 0.28); }
    #${CARD_ID} .fsw-btn svg { width: 14px; height: 14px; }
    #${CARD_ID} .fsw-btn--rw, #${CARD_ID} .fsw-btn--ff { width: auto; min-width: 26px; padding: 0 7px; gap: 3px; }
    #${CARD_ID} .fsw-speed { font-size: 9.5px; font-weight: 800; }
    #${CARD_ID} .fsw-btn.is-active { background: rgba(245, 158, 11, 0.45); color: #fff; }
    #${CARD_ID} .fsw-hint { margin-left: auto; font-size: 10.5px; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .fsw-dots { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 10px; }
    #${CARD_ID} .fsw-dot {
      appearance: none; width: 8px; height: 8px; padding: 0; border: none; border-radius: 50%; cursor: pointer;
      background: rgba(255, 255, 255, 0.15); transition: background 0.15s ease, transform 0.15s ease;
    }
    #${CARD_ID} .fsw-dot.is-ch2 { background: rgba(34, 197, 94, 0.25); }
    #${CARD_ID} .fsw-dot.is-active { background: #f59e0b; transform: scale(1.3); }
    #${CARD_ID} .fsw-dot.is-ch2.is-active { background: #22c55e; }
    #${CARD_ID} .fsw-meta { margin-top: 8px; font-size: 10.5px; color: rgba(234, 234, 234, 0.55); }
    #${CARD_ID} .fsw-prompt {
      display: grid; gap: 10px; padding: 16px 14px 14px; text-align: center; border-radius: 10px;
      background: linear-gradient(180deg, rgba(245, 158, 11, 0.14), rgba(245, 158, 11, 0.04));
      border: 1px solid rgba(245, 158, 11, 0.35); animation: fsw-in 0.26s ease-out;
    }
    #${CARD_ID} .fsw-prompt-icon { font-size: 26px; line-height: 1; }
    #${CARD_ID} .fsw-prompt-title { font-size: 13px; font-weight: 800; text-transform: uppercase; color: #fff; }
    #${CARD_ID} .fsw-prompt-desc { font-size: 11.5px; color: rgba(234, 234, 234, 0.8); }
    #${CARD_ID} .fsw-prompt-buttons { display: grid; gap: 6px; }
    #${CARD_ID} .fsw-prompt-btn {
      appearance: none; cursor: pointer; padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 700;
      border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.06); color: #eaeaea;
    }
    #${CARD_ID} .fsw-prompt-btn.is-primary { background: #b45309; color: #fff; box-shadow: 0 4px 12px rgba(180, 83, 9, 0.35); }

    #${POPUP_ID} {
      position: absolute; z-index: 5; width: 372px; max-width: calc(100% - 24px); max-height: 72vh; overflow-y: auto;
      top: 188px; left: 12px; pointer-events: auto; opacity: 0; transform: translateY(-8px);
      transition: opacity 0.35s ease, transform 0.35s ease;
      background: linear-gradient(180deg, rgba(24, 20, 12, 0.96), rgba(14, 12, 8, 0.96)); color: #eaeaea;
      border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55), 0 0 0 3px rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); font-size: 12px;
    }
    #${POPUP_ID} .fswp-head {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: linear-gradient(90deg, rgba(180, 83, 9, 0.4), rgba(34, 197, 94, 0.1));
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    #${POPUP_ID} .fswp-head.is-ch2 { background: linear-gradient(90deg, rgba(34, 197, 94, 0.38), rgba(180, 83, 9, 0.12)); }
    #${POPUP_ID} .fswp-dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; flex: 0 0 auto; animation: fsw-pulse 1.6s ease-in-out infinite; }
    #${POPUP_ID} .fswp-title { flex: 1 1 auto; font-size: 13px; font-weight: 700; color: #fff; }
    #${POPUP_ID} .fswp-badge {
      font-size: 9.5px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); white-space: nowrap;
    }
    #${POPUP_ID} .fswp-body { padding: 10px 12px; line-height: 1.55; }
    #${POPUP_ID} .fswp-caption { margin-bottom: 8px; color: rgba(234, 234, 234, 0.92); }
    #${POPUP_ID} .fswp-label {
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
      color: rgba(234, 234, 234, 0.5); margin: 8px 0 4px;
    }
    #${POPUP_ID} .fswp-big { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
    #${POPUP_ID} .fswp-big-value { font-size: 26px; font-weight: 800; color: #fff; line-height: 1; }
    #${POPUP_ID} .fswp-big-sub { font-size: 10.5px; color: rgba(234, 234, 234, 0.6); }
    #${POPUP_ID} .fswp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 6px 0; }
    #${POPUP_ID} .fswp-stat { padding: 6px 7px; border-radius: 8px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.08); }
    #${POPUP_ID} .fswp-stat b { display: block; font-size: 13.5px; color: #fff; }
    #${POPUP_ID} .fswp-stat span { font-size: 9.5px; color: rgba(234, 234, 234, 0.55); }
    #${POPUP_ID} .fswp-table { width: 100%; border-collapse: collapse; font-size: 11px; }
    #${POPUP_ID} .fswp-table th {
      text-align: left; font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
      color: rgba(234, 234, 234, 0.5); padding: 2px 6px 4px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    #${POPUP_ID} .fswp-table td { padding: 3px 6px 3px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
    #${POPUP_ID} .fswp-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    #${POPUP_ID} .fswp-cat { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
    #${POPUP_ID} .fswp-chart { width: 100%; height: auto; display: block; margin: 2px 0; }
    #${POPUP_ID} .fswp-stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; margin: 4px 0 6px; }
    #${POPUP_ID} .fswp-stack > span { display: block; height: 100%; animation: fsw-grow 0.9s ease-out; transform-origin: left; }
    @keyframes fsw-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    #${POPUP_ID} .fswp-legend { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 9.5px; color: rgba(234, 234, 234, 0.65); }
    #${POPUP_ID} .fswp-advice {
      margin-top: 8px; padding: 7px 9px; border-radius: 8px; font-size: 11px; line-height: 1.45;
      background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); color: #fde68a;
    }
    #${POPUP_ID} .fswp-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
    #${POPUP_ID} .fswp-chip {
      font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
      background: rgba(245, 158, 11, 0.16); border: 1px solid rgba(245, 158, 11, 0.35); color: #fde68a;
    }
    #${POPUP_ID} .fswp-u { font-size: 0.68em; font-weight: 600; margin-left: 3px; color: rgba(234, 234, 234, 0.6); white-space: nowrap; }
    #${POPUP_ID} .fswp-stat b { white-space: nowrap; }
    #${POPUP_ID} .fswp-grid--4 { grid-template-columns: repeat(4, 1fr); }
    #${POPUP_ID} .fswp-grid--4 .fswp-stat b { font-size: 14px; }
    #${POPUP_ID} .fswp-axis-note { font-size: 9.5px; color: rgba(234, 234, 234, 0.55); margin: 2px 0; }
    #${POPUP_ID} .fswp-line { display: inline-block; width: 14px; height: 0; border-top: 2px dashed; margin-right: 5px; vertical-align: 2px; }
    #${POPUP_ID} .fswp-line.is-dotted { border-top-style: dotted; }
    #${POPUP_ID} .fswp-whisk { display: inline-block; width: 8px; height: 9px; margin-right: 5px; vertical-align: -1px;
      border-top: 1.5px solid rgba(255,255,255,0.75); background: linear-gradient(rgba(255,255,255,0.6), rgba(255,255,255,0.6)) center / 1px 100% no-repeat; }
    #${POPUP_ID} .fswp-why { margin: 6px 0; padding: 8px 9px; border-radius: 8px;
      background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); animation: fsw-in 0.5s ease; }
    #${POPUP_ID} .fswp-why-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 800; color: #fff; margin-bottom: 3px; }
    #${POPUP_ID} .fswp-why-data { font-size: 11px; line-height: 1.5; color: rgba(234, 234, 234, 0.92); margin-bottom: 4px; }
    #${POPUP_ID} .fswp-why-research { font-size: 10.5px; line-height: 1.45; color: rgba(253, 230, 138, 0.85); font-style: italic; }
    #${POPUP_ID} .fswp-src { margin-top: 8px; font-size: 9.5px; color: rgba(234, 234, 234, 0.45); font-style: italic; }
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
  const m = card?.querySelector(".fsw-mute");
  if (!m) return;
  m.classList.toggle("is-muted", !_state.ttsEnabled);
  m.innerHTML = _state.ttsEnabled ? ICON_TTS_ON : ICON_TTS_OFF;
  const label = _state.ttsEnabled ? "Mute narration" : "Unmute narration";
  m.setAttribute("aria-label", label);
  m.setAttribute("title", label);
}

function _syncLangButton(card) {
  const b = card?.querySelector(".fsw-lang");
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
  q(".fsw-btn--play").addEventListener("click", _togglePlay);
  q(".fsw-btn--prev").addEventListener("click", () => _gotoScene(_state.index - 1));
  q(".fsw-btn--next").addEventListener("click", () => _gotoScene(_state.index + 1));
  q(".fsw-btn--ff").addEventListener("click", () => _cycleSpeed(1));
  q(".fsw-btn--rw").addEventListener("click", () => _cycleSpeed(-1));
  q(".fsw-close").addEventListener("click", () => {
    const sel = document.getElementById(SELECT_ID);
    if (sel) sel.value = "";
    _hide();
  });
  q(".fsw-mute").addEventListener("click", () => {
    _state.ttsEnabled = !_state.ttsEnabled;
    _stopSpeaking();
    _syncMuteButton(card);
    if (_state.ttsEnabled) _speak(_tr(_state.scenes[_state.index]?.caption));
  });
  q(".fsw-lang").addEventListener("click", () => {
    _state.lang = _state.lang === "ur" ? "en" : "ur";
    _saveLangPref(_state.lang);
    _syncLangButton(card);
    _reapplyLanguage(card);
    if (_state.lang === "ur") {
      _ensureUrduTranslations(card).then((ok) => { if (ok && _state.lang === "ur") _reapplyLanguage(card); }).catch(() => {});
    }
  });
  q(".fsw-refresh").addEventListener("click", () => _handleRefresh(card));
  q(".fsw-dots").addEventListener("click", (e) => {
    const dot = e.target.closest(".fsw-dot");
    const idx = Number(dot?.dataset.fswScene);
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
// an indeterminate one. Lives outside .fsw-body, so scene re-renders keep it.
function _loaderEl(card) {
  return card?.querySelector(".fsw-loader") || null;
}

function _showLoader(card, text, progress, startedAt, done = false) {
  const el = _loaderEl(card);
  if (!el) return;
  el.hidden = false;
  el.classList.toggle("is-done", done);
  el.querySelector(".fsw-loader-text").textContent = text;
  const bar = el.querySelector(".fsw-loader-bar");
  const fill = bar.querySelector("i");
  const det = progress && progress.total > 0;
  bar.classList.toggle("is-indeterminate", !det);
  fill.style.width = det ? `${Math.round((progress.ready / progress.total) * 100)}%` : "";
  el.querySelector(".fsw-loader-time").textContent = startedAt ? `${((performance.now() - startedAt) / 1000).toFixed(1)}s` : "";
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
  const cls = _state.lang === "ur" ? "fswp-caption fsw-lang-ur" : "fswp-caption";
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
  card.querySelector(".fsw-progress-fill").style.width = "0%";
  card.querySelector(".fsw-progress-timer").textContent = "0.0s";
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
  const fill = card.querySelector(".fsw-progress-fill");
  const timer = card.querySelector(".fsw-progress-timer");
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
  const b = card?.querySelector(".fsw-btn--play");
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
  const ff = card.querySelector(".fsw-btn--ff");
  const rw = card.querySelector(".fsw-btn--rw");
  const ffOn = direction === 1 && speed > 1;
  const rwOn = direction === -1;
  ff?.classList.toggle("is-active", ffOn);
  rw?.classList.toggle("is-active", rwOn);
  if (ff) ff.querySelector(".fsw-speed").textContent = ffOn ? `${speed}x` : "";
  if (rw) rw.querySelector(".fsw-speed").textContent = rwOn ? `${speed}x` : "";
}

function _cycleSpeed(direction) {
  if (_state.direction !== direction) _setSpeed(1, direction);
  else _setSpeed(SPEED_LEVELS[(SPEED_LEVELS.indexOf(_state.speed) + 1) % SPEED_LEVELS.length], direction);
  if (!_state.isPlaying) _play();
  else _scheduleAdvance(document.getElementById(CARD_ID), _state.runToken, _state.sceneSeq, _state.scenes[_state.index]?.caption);
}

// ---- Load / show / hide ---------------------------------------------------
function _loadingHtml(msg) {
  return `<div class="fsw-status"><span class="fsw-spinner" aria-hidden="true"></span><span>${_esc(msg)}</span></div>`;
}

async function _handleRefresh(card) {
  const btn = card.querySelector(".fsw-refresh");
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
// Analysis (pure — exported for tests)
// ==========================================================================
export function hotspots(d) {
  return (d?.ipc?.hotspots || []).slice(0, HOTSPOT_MAX);
}

// Rain over the outlook window as a share of the 2001–2025 normal.
function _rainRatio(p) {
  return Number.isFinite(p.rain_normal_mm) && p.rain_normal_mm > 0.5 ? p.rain_mm / p.rain_normal_mm : null;
}
function _majorProvinces(w) {
  return (w?.provinces || []).filter((p) => ["Punjab", "Sindh", "Khyber Pakhtunkhwa", "Balochistan"].includes(p.province));
}

// National level: the early-warning layer's own result (foodsec_ews.py). Without
// it, a simple point count in which every indicator that adds a point is listed.
export function watchLevel(d) {
  const H = ewsHeadline(d);
  if (H) return { level: H.n.level, ews: true, indicators: [] };
  const ind = [];
  const t = d?.ipc?.totals;
  if (t) {
    const s = t.p3plus_pct;
    ind.push({ name: "Population in IPC Phase 3+", value: _pct(s), points: s >= 0.2 ? 2 : s >= 0.1 ? 1 : 0 });
    const p4 = t.p?.[4] || 0;
    const p4Areas = t.phase_counts?.[4] || 0;
    ind.push({ name: "People in Emergency (Phase 4)", value: _mil(p4, 2), points: p4Areas > 0 ? 2 : p4 >= 250000 ? 1 : 0 });
  }
  const flour = _price(d, "Wheat flour");
  if (flour && Number.isFinite(flour.yoy_pct)) {
    ind.push({ name: "Wheat flour price, year on year", value: _signed(flour.yoy_pct), points: flour.yoy_pct >= 20 ? 1 : 0 });
  }
  const tot = d?.prices?.terms_of_trade;
  if (tot && Number.isFinite(tot.latest) && Number.isFinite(tot.avg5_same_month)) {
    const gap = tot.latest / tot.avg5_same_month - 1;
    ind.push({ name: "Purchasing power vs 5-year average", value: _signed(gap * 100, 0), points: gap <= -0.1 ? 1 : 0 });
  }
  const wheat = _staple(d, 4);
  if (wheat && Number.isFinite(wheat.vs_avg5_pct)) {
    ind.push({ name: "Wheat harvest vs 5-year average", value: _signed(wheat.vs_avg5_pct), points: wheat.vs_avg5_pct <= -5 ? 1 : 0 });
  }
  const w = d?.outlook?.weather;
  if (w) {
    const dry = _majorProvinces(w).filter((p) => (_rainRatio(p) ?? 1) < 0.5);
    ind.push({ name: `Rain outlook, next ${w.days} days`, value: dry.length ? `${dry.length} province(s) < 50% of normal` : "near or above normal",
               points: dry.length >= 2 ? 1 : 0 });
  }
  const score = ind.reduce((s, i) => s + i.points, 0);
  const level = score >= 6 ? 3 : score >= 4 ? 2 : score >= 2 ? 1 : 0;
  return { level, score, indicators: ind };
}

// ==========================================================================
// Narrative (operational briefing tone, every figure from the digest)
// ==========================================================================
function _introNarrative(d) {
  const H = ewsHeadline(d);
  if (H) {
    return `Bottom line: the national level is ${H.lv.label.toUpperCase()}. ${H.line} ${Number.isFinite(H.pk.kg) ? `A day's wage now buys ${_fmt(H.pk.kg, 1)} kilograms of flour, against a five-year average of ${_fmt(H.pk.kg_avg5, 1)}. ` : ""}` +
      `FEWS NET puts ${H.crisisNow} districts in Crisis now and expects ${H.crisisNext} by January. This briefing shows where, why, what may come next, and what to do.`;
  }
  const t = d?.ipc?.totals;
  const wheat = _staple(d, 4);
  const flour = _price(d, "Wheat flour");
  const tot = d?.prices?.terms_of_trade;
  const parts = [];
  if (t) parts.push(`Bottom line up front: in the latest IPC projection, ${_mil(t.p3plus)} people across ${t.areas} analysed districts face Crisis-or-worse food insecurity (IPC Phase 3+), ${_pct(t.p3plus_pct)} of the ${_mil(t.pop)} people analysed; ${_mil(t.p[4], 2)} are in Emergency (Phase 4).`);
  if (wheat) parts.push(`The ${wheat.latest.year} wheat harvest was ${_fmt(wheat.latest.production / 1000, 1)} million tonnes, ${_signed(wheat.change_pct)} on the year before.`);
  if (flour && Number.isFinite(flour.yoy_pct)) parts.push(`Wheat flour costs ${_fmt(flour.latest)} PKR per kg, ${_signed(flour.yoy_pct)} in a year${tot?.latest ? `, and a day's unskilled wage now buys ${_fmt(tot.latest, 1)} kg of flour` : ""}.`);
  parts.push("This briefing covers who is hungry and where, the harvests, market prices, the next one to two months, and the assessment.");
  return parts.join(" ");
}

function _ewsLevelNarrative(d) {
  const H = ewsHeadline(d);
  const top = concernList(H.e, 4).map((r) => r.name);
  return `Warning levels. ${H.alert.length ? `Alert: ${_joinList(H.alertText)} districts. ` : ""}${H.warnText.length ? `Warning: ${_joinList(H.warnText)} districts. ` : ""}` +
    `Each district is scored on hunger, food prices and wages, water and crops, and shocks. ${H.karachiOnly ? "Karachi is at Alert because of food prices alone. " : ""}` +
    `${top.length ? `First on the list: ${_joinList(top)}. ` : ""}Confidence is mostly low, because only five cities report prices, so check on the ground first. This is an NCOP overlay, not an IPC classification.`;
}
function _fewsNarrative(d) {
  const H = ewsHeadline(d);
  const need = (H.e.register || []).find((r) => r.id === "needs2026");
  return `The newest independent outlook, FEWS NET October 2026: ${H.crisisNow} districts are in Crisis now, rising to ${H.crisisNext} by January. ` +
    `${need && need.state === "current" ? need.text : ""} This is a forecast by analysts of whole districts and is a different measure from the IPC head count.`;
}
function _householdNarrative(d) {
  const h = d.ews.household, v = h.hies, y = Object.keys(h.diet || {}).sort().pop(), x = h.diet?.[y];
  return `Families. In the national survey of ${v.year}, ${_fmt(v.moderate_or_severe)}% of households were food insecure, up from ${_fmt(v.prev_moderate_or_severe)}% in ${v.prev_year}. ` +
    `Among the poorest fifth it is ${_fmt(v.poorest)}%. ${x ? `${_fmt(x.cannot_afford_pct)}% of people could not afford a healthy diet in ${y}. ` : ""}` +
    "No open district data on child malnutrition are available now. That is the biggest gap in this picture.";
}
function _supplyNarrative(d) {
  const r = d.ews.supply.wheat.rows, l = r[r.length - 1], best = r.reduce((a, b) => (b.cover_days > a.cover_days ? b : a));
  return `Wheat supply. For the crop cut in spring ${l.harvest_year}, USDA estimates ${_fmt(l.production / 1000, 1)} million tonnes against ${_fmt(l.use / 1000, 1)} million needed. ` +
    `Stores would hold about ${l.cover_days} days of food at the end of the season, against ${best.cover_days} days at their best. Other estimates of this harvest are lower, down to about 26 million tonnes, so treat it as a range.`;
}
function _waterNarrative(d) {
  const w = d.ews.water, si = (w.provinces || []).find((p) => p.province === "Sindh"), ba = (w.provinces || []).find((p) => p.province === "Balochistan");
  return `Rain and water. ${si ? `Satellites show the 2026 monsoon ${_signed(si.monsoon_pct, 0)} in Sindh` : ""}${ba ? ` and ${_signed(ba.monsoon_pct, 0)} in Balochistan` : ""}, dry but not record-breaking. ` +
    `${w.canal_pct != null ? `Canal water for Punjab and Sindh this winter is planned ${Math.abs(w.canal_pct)}% below normal: the main risk to the wheat crop. ` : ""}` +
    `${w.enso ? `A ${w.enso.strength || ""} ${w.enso.state} is under way. For Pakistan it does not mean a dry winter: average to above-average rain is expected.` : ""}`;
}
function _shocksNarrative(d) {
  const c = d.ews.shocks?.conflict, reg = d.ews.register || [];
  const get = (id) => { const r = reg.find((x) => x.id === id); return r && r.state === "current" ? r.text : ""; };
  return `Shocks and trade. ${c ? `${_fmt(c.events)} violent political events were recorded in ${_monthLong(c.month)}; the average month of the year before had ${_fmt(c.avg12)}. ` : ""}${get("border2026")} ${get("fertiliser2026")}`.trim();
}
function _trustNarrative(d) {
  const b = d.ews.backtest, m = b.market.warning, p = d.ews.price_outlook, c = p?.skill.find((s) => s.model === "chosen");
  return `How far to trust this. The rules were replayed over ${_fmt(m.months)} past months. After a price Warning, flour jumped 10% or more within three months ${_fmt((m.precision || 0) * 100)}% of the time, against ${_fmt((m.base_rate || 0) * 100)}% in any month, but ${m.missed} of ${m.surges} jumps came without a Warning. ` +
    (c ? `The flour forecast has typically been ${_fmt(c.by_horizon["1"])}% off one month ahead and ${_fmt(c.by_horizon["3"])}% off three months ahead.` : "");
}

function _ipcOverviewNarrative(d) {
  const L = d.ews?.ipc?.lines;
  if (L?.length) {
    return `The last official count (IPC). ${_joinList(L.map((l) => `${l.label}: ${_mil(l.projected?.p3plus, 2)} people in Crisis or worse, ${_pct(l.projected?.p3plus_pct)} of those analysed`))}. ` +
      `${L.length > 1 ? "These are two analyses with different dates, so they are shown apart. " : ""}${d.ews.ipc.expired ? `Both projections ended on ${_dayMonth(d.ews.ipc.valid_to)} 2026 and nothing newer is published, so this is the last known count, not today's.` : ""}`;
  }
  const i = d.ipc;
  const prov = (i.provinces || []).filter((p) => p.province !== "Other").slice(0, 4);
  const worst = prov.slice().sort((a, b) => (b.p3plus_pct || 0) - (a.p3plus_pct || 0))[0];
  return `Situation. The latest IPC analysis covers ${i.totals.areas} districts: ${i.totals.phase_counts[3]} are classified Crisis (Phase 3) and ${i.totals.phase_counts[2]} Stressed (Phase 2). ` +
    `By number of people in Phase 3 or worse: ${_joinList(prov.map((p) => `${p.province} ${_mil(p.p3plus)}`))}. ` +
    (worst ? `Proportionally, ${worst.province} is hardest hit, with ${_pct(worst.p3plus_pct)} of its analysed population in Phase 3+.` : "");
}

function _hotspotNarrative(h, rank) {
  const r = (_state.digest?.ews?.districts || []).find((x) => x.name === h.title);
  return `Hotspot ${rank}: ${h.title}${h.province ? `, ${h.province}` : ""}. ${_mil(h.p3plus, 2)} people in Crisis or worse (${_pct(h.p3plus_pct)} of the district), ` +
    `including ${_fmt(h.p[4])} in Emergency, in the IPC projection to 30 September. Class: Phase ${h.phase}${h.prolonged ? ", a prolonged crisis" : ""}.` +
    (r ? ` NCOP level today: ${EWS_LEVELS[r.level].label}. ${districtReason(r)}.` : "");
}

function _trendNarrative(d) {
  const h = (d.ipc.history || []).filter((a) => Number.isFinite(a.phase3plus_pop));
  if (h.length < 2) return "IPC analysis history is not available.";
  const peak = h.reduce((a, b) => (b.phase3plus_pop > a.phase3plus_pop ? b : a));
  const last = h[h.length - 1];
  const flood = h.find((a) => /flood/i.test(a.title || ""));
  return `Trend. Since ${h[0].date.slice(0, 4)}, IPC analyses have grown from one province to most of the country. The largest number in Phase 3+ was ${_mil(peak.phase3plus_pop)} (${_monthLong(peak.date)}). ` +
    (flood ? `The 2022 flood update alone put ${_mil(flood.phase3plus_pop)} in Phase 3+. ` : "") +
    `The latest analysis (${_monthLong(last.date)}) reported ${_mil(last.phase3plus_pop)} for its current period, ${_pct(last.phase3plus_pct)} of those analysed; the projection shown on the map is ${_mil(d.ipc.totals.p3plus)}. Shares have eased, but on a far larger population.`;
}

function _regionNarrative(d) {
  const n = d.ipc.neighbours || {};
  const a = n.afghanistan, b = n.bangladesh, t = d.ipc.totals;
  return `Regional picture. ${a ? `Afghanistan's mapped analysis shows ${_mil(a.p3plus)} people (${_pct(a.p3plus_pct)}) in Phase 3+` : ""}${b ? `; Bangladesh ${_mil(b.p3plus)} (${_pct(b.p3plus_pct)})` : ""}. ` +
    `Pakistan's share is ${_pct(t.p3plus_pct)}. Shared wheat and flour markets mean a poor harvest or price spike on one side of the border is felt on the other.`;
}

function _cropsOverviewNarrative(d) {
  const st = d.crops.staples;
  const down = st.filter((s) => (s.change_pct || 0) < -2).map((s) => `${s.name.toLowerCase()} ${_signed(s.change_pct)}`);
  const up = st.filter((s) => (s.change_pct || 0) > 2).map((s) => `${s.name.toLowerCase()} ${_signed(s.change_pct)}`);
  return `The harvests, ${d.crops.latest_year}. ${down.length ? `Down on the previous year: ${_joinList(down)}.` : "No staple fell sharply."} ${up.length ? `Up: ${_joinList(up)}.` : ""} ` +
    `The map shades each province by production of the crop in focus.`;
}

function _cropNarrative(s, prov) {
  const top = (prov || []).slice(0, 2);
  const share = top.length && s.latest.production ? top[0].production / s.latest.production : null;
  const unit = s.unit === "000 bales" ? "million bales" : "million tonnes";
  let why = "";
  if (s.id === 4 && (s.change_pct || 0) < 0) why = " Planted area fell after the minimum support price was withdrawn in 2024, and the season saw adverse weather.";
  if (s.id === 5 && (s.change_pct || 0) < -10) why = " Lower planted area, heat, pests and monsoon flooding are the reported causes.";
  return `${s.name}: ${_fmt(s.latest.production / 1000, 2)} ${unit} in ${s.latest.year}, ${_signed(s.change_pct)} on the year and ${_signed(s.vs_avg5_pct)} against the 5-year average; yield ${_fmt(s.latest.yield, 2)} ${_yieldUnit(s)}.` +
    (top.length ? ` ${top[0].name} produces ${_pct(share)} of it${top[1] ? `, followed by ${top[1].name}` : ""}.` : "") + why;
}

function _districtsNarrative(list) {
  return `Breadbasket. The top wheat districts are ${_joinList(list.slice(0, 4).map((x) => `${x.name} (${_fmt(x.production)} thousand tonnes)`))}. ` +
    "Most of the national wheat crop comes from the canal-irrigated plains of Punjab, so stocks there set flour prices nationwide.";
}

function _pricesOverviewNarrative(d) {
  const p = d.prices;
  const up = KEY_PRICES.map((n) => _price(d, n)).filter((x) => x && (x.yoy_pct || 0) >= 10)
    .sort((a, b) => b.yoy_pct - a.yoy_pct).slice(0, 3);
  const down = KEY_PRICES.map((n) => _price(d, n)).filter((x) => x && (x.yoy_pct || 0) <= -10).slice(0, 2);
  return `Markets, ${_monthLong(p.latest_month)}. Retail prices in Lahore, Karachi, Peshawar, Quetta and Multan. ` +
    (up.length ? `Sharpest rises in a year: ${_joinList(up.map((x) => `${_short(x.commodity).toLowerCase()} ${_signed(x.yoy_pct)}`))}. ` : "") +
    (down.length ? `Cheaper than a year ago: ${_joinList(down.map((x) => `${_short(x.commodity).toLowerCase()} ${_signed(x.yoy_pct)}`))}.` : "");
}

function _flourNarrative(d) {
  const f = _price(d, "Wheat flour");
  if (!f) return "Wheat flour prices are not available.";
  const mk = Object.entries(f.by_market).sort((a, b) => b[1] - a[1]);
  return `Wheat flour, the staple: ${_fmt(f.latest)} PKR per kg on average, ${_signed(f.yoy_pct)} year on year and ${_signed(f.m3_pct)} in three months. ` +
    (mk.length ? `Dearest in ${mk[0][0]} (${_fmt(mk[0][1])} PKR), cheapest in ${mk[mk.length - 1][0]} (${_fmt(mk[mk.length - 1][1])} PKR).` : "");
}

function _totNarrative(d) {
  const t = d.prices.terms_of_trade;
  if (!t?.latest) return "Purchasing-power data are not available.";
  const mk = Object.entries(t.by_market).sort((a, b) => a[1] - b[1]);
  return `Purchasing power. One day of unskilled labour buys ${_fmt(t.latest, 1)} kg of wheat flour${t.year_ago ? `, down from ${_fmt(t.year_ago, 1)} kg a year ago` : ""}` +
    `${t.avg5_same_month ? ` and the 5-year average of ${_fmt(t.avg5_same_month, 1)} kg for this month` : ""}. ` +
    (mk.length ? `Weakest in ${mk[0][0]} (${_fmt(mk[0][1], 1)} kg). Wages are not keeping pace with food prices.` : "");
}

function _weatherNarrative(d) {
  const w = d.outlook?.weather;
  if (!w) return "The weather outlook is not available.";
  const rows = _majorProvinces(w);
  const desc = rows.map((p) => {
    const r = _rainRatio(p);
    return `${p.province} ${_fmt(p.rain_mm, 0)} mm${r != null ? ` (${_pct(r)} of normal)` : ""}`;
  });
  const warm = rows.filter((p) => Number.isFinite(p.temp_normal_c) && p.temp_c - p.temp_normal_c >= 1);
  return `The next ${w.days} days (${_dayMonth(w.from)} to ${_dayMonth(w.to)}), bias-corrected GEFS outlook: ${_joinList(desc)}. ` +
    (warm.length ? `Temperatures run warmer than normal in ${_joinList(warm.map((p) => p.province))}. ` : "") +
    "The map plays the daily rain forecast.";
}

function _cropStageNarrative(d) {
  const o = d.outlook;
  if (!o) return "";
  const sowing = o.calendar.filter((c) => c.stages[0] === "sowing" || c.stages[1] === "sowing").map((c) => c.crop.split(" (")[0].toLowerCase());
  const harvest = o.calendar.filter((c) => c.stages[0] === "harvest" || c.stages[1] === "harvest").map((c) => c.crop.split(" (")[0].toLowerCase());
  const dry = _majorProvinces(o.weather).filter((p) => (_rainRatio(p) ?? 1) < 0.5).map((p) => p.province);
  return `In the fields, ${o.months[0]} to ${o.months[1]}: ${sowing.length ? `${_joinList(sowing)} sowing` : "no major sowing"}${harvest.length ? `; ${_joinList(harvest)} harvest` : ""}. ` +
    (dry.length ? `A dry outlook in ${_joinList(dry)} raises irrigation demand for newly sown wheat and puts rain-fed (barani) areas at risk of poor germination.` : "Rain near normal supports germination of newly sown wheat.");
}

function _priceOutlookNarrative(d) {
  const f = _price(d, "Wheat flour");
  const last = f?.outlook?.[f.outlook.length - 1];
  const po = d.ews?.price_outlook;
  if (po) {
    const e = po.path[po.path.length - 1], c = po.skill.find((x) => x.model === "chosen");
    return `Flour price outlook. The central estimate is about ${_fmt(e.mid)} rupees a kilogram by ${_monthLong(e.month)}, and the likely range is ${_fmt(e.lo)} to ${_fmt(e.hi)}. ` +
      `It is a possible range, not a guaranteed price: three months ahead this method has typically been ${_fmt(c?.by_horizon?.["3"])}% off. Stock releases, imports or a poor sowing season would move it.`;
  }
  return `Indicative price path. Applying the typical seasonal movement of the last five years to today's prices, ` +
    (last ? `wheat flour would be around ${_fmt(last.mid)} PKR per kg by ${_monthLong(last.month)} (range ${_fmt(last.lo)}–${_fmt(last.hi)} PKR). ` : "") +
    "This is a seasonal guide, not a forecast: stock releases, import decisions or a poor sowing season would move it.";
}

const WHY_CARDS = [
  { icon: "🌊", title: "Climate shocks hit farms first",
    text: "The 2022 floods caused about USD 3.7 billion of damage and USD 9.2 billion of losses in the agrifood sector — the second most affected sector. In 2025, about 9% of Punjab's cropland flooded, hitting rice and cotton.",
    refs: ["pdna", "faoUnfccc", "fao2025"] },
  { icon: "🌾", title: "Policy and the wheat market",
    text: "After the minimum support price for wheat was withdrawn in 2024, wheat area fell about 6.5% and output dropped from a record 31.8 to about 29 million tonnes; agriculture grew only 0.6%.",
    refs: ["giewsWheat", "survey"] },
  { icon: "💸", title: "Prices outrun incomes",
    text: "Food inflation peaked near 48–49% in 2023. When staple prices rise faster than wages, poor households cut meals and diet quality first — the main driver of IPC Phase 3 classifications.",
    refs: ["grfc", "wbFood", "ipc2026"] },
  { icon: "🧒", title: "Hunger becomes malnutrition",
    text: "40.2% of children under five are stunted and 17.7% wasted; IPC projects about 2.7 million acutely malnourished children aged 6–59 months in the analysed provinces.",
    refs: ["nns", "ipcMal"] },
  { icon: "🏞️", title: "One river, one economy",
    text: "Agriculture is about 23% of GDP and 37% of employment; the Indus system supports roughly 90% of agricultural production — a single water system carrying the national food supply.",
    refs: ["faoGlance", "fewsIndus"] },
];
function _whyNarrative() {
  return "Why it happens. Climate shocks, wheat-market policy, prices outrunning wages, and malnutrition compound one another — and nearly all of Pakistan's food depends on one river system.";
}

function _assessmentNarrative(d, w) {
  const lvl = WATCH_LEVELS[w.level];
  const H = ewsHeadline(d);
  if (H) {
    const ac = H.e.actions || [];
    return `Assessment: ${H.lv.label.toUpperCase()}, ${H.lv.say}. ${ac.length ? `Priority actions: ${_joinList(ac.map((a, i) => `${["first", "second", "third", "fourth"][i] || ""}, ${a.title.charAt(0).toLowerCase()}${a.title.slice(1)}`))}. ` : ""}The owners and dates are on the panel.`;
  }
  const hs = hotspots(d).slice(0, 3).map((h) => h.title);
  return `Assessment: watch level ${lvl.label.toUpperCase()}. ` +
    (hs.length ? `Priority districts: ${_joinList(hs)}. ` : "") +
    `Recommended action: ${lvl.action}`;
}

// ==========================================================================
// Scenes
// ==========================================================================
export function buildScenes(d) {
  const scenes = [{ kind: "intro", chapter: 1, caption: _introNarrative(d) }];
  const ews = ewsHeadline(d) ? d.ews : null;
  if (ews) scenes.push({ kind: "ews-level", chapter: 1, caption: _ewsLevelNarrative(d) }, { kind: "fews-outlook", chapter: 1, caption: _fewsNarrative(d) });
  if (d?.ipc) {
    scenes.push({ kind: "ipc-overview", chapter: 1, caption: _ipcOverviewNarrative(d) });
    hotspots(d).forEach((h, i) => scenes.push({ kind: "ipc-hotspot", chapter: 1, hotspot: h, rank: i + 1, caption: _hotspotNarrative(h, i + 1) }));
    if ((d.ipc.history || []).length >= 2) scenes.push({ kind: "ipc-trend", chapter: 1, caption: _trendNarrative(d) });
    // Different countries' analyses cover different dates and areas: no comparison in the decision briefing.
    if (!ews && Object.keys(d.ipc.neighbours || {}).length) scenes.push({ kind: "ipc-region", chapter: 1, caption: _regionNarrative(d) });
  }
  if (ews?.household?.hies) scenes.push({ kind: "household", chapter: 1, caption: _householdNarrative(d) });
  if (ews?.supply?.wheat?.rows?.length) scenes.push({ kind: "supply", chapter: 2, caption: _supplyNarrative(d) });
  if (d?.crops?.staples?.length) {
    scenes.push({ kind: "crops-overview", chapter: 2, caption: _cropsOverviewNarrative(d) });
    for (const id of FOCUS_CROPS) {
      const s = _staple(d, id);
      if (s) scenes.push({ kind: "crop-focus", chapter: 2, crop: s, caption: _cropNarrative(s, d.crops.provinces?.[id]) });
    }
    if (d.crops.wheat_districts?.length) scenes.push({ kind: "wheat-districts", chapter: 2, caption: _districtsNarrative(d.crops.wheat_districts) });
  }
  if (d?.prices?.items?.length) {
    scenes.push({ kind: "prices-overview", chapter: 3, caption: _pricesOverviewNarrative(d) });
    if (_price(d, "Wheat flour")) scenes.push({ kind: "price-flour", chapter: 3, caption: _flourNarrative(d) });
    if (d.prices.terms_of_trade?.latest) scenes.push({ kind: "purchasing-power", chapter: 3, caption: _totNarrative(d) });
  }
  if (ews?.water) scenes.push({ kind: "water", chapter: 4, caption: _waterNarrative(d) });
  if (d?.outlook) {
    if (d.outlook.weather) scenes.push({ kind: "outlook-weather", chapter: 4, caption: _weatherNarrative(d) });
    scenes.push({ kind: "outlook-crops", chapter: 4, caption: _cropStageNarrative(d) });
    if (d?.prices?.items?.length) scenes.push({ kind: "outlook-prices", chapter: 4, caption: _priceOutlookNarrative(d) });
  }
  if (ews?.shocks) scenes.push({ kind: "shocks", chapter: 4, caption: _shocksNarrative(d) });
  const w = watchLevel(d);
  if (ews?.backtest) scenes.push({ kind: "trust", chapter: 5, caption: _trustNarrative(d) });
  scenes.push({ kind: "why", chapter: 5, caption: _whyNarrative() });
  scenes.push({ kind: "assessment", chapter: 5, watch: w, caption: _assessmentNarrative(d, w) });
  return scenes;
}

const CHAPTER_NAMES = ["", "Warning Level & Hunger", "Harvests & Supply", "Prices & Wages", "The Months Ahead", "Why & What to Do"];

function _sceneTitle(scene) {
  switch (scene.kind) {
    case "intro":            return "Chapter 1 — Warning Level & Hunger";
    case "ews-level":        return "Where Pressure Is Building";
    case "fews-outlook":     return "Independent Outlook — FEWS NET";
    case "household":        return "Nutrition & Households";
    case "supply":           return "Chapter 2 — Is There Enough Wheat?";
    case "water":            return "Chapter 4 — Rain, Canals & El Niño";
    case "shocks":           return "Shocks & Trade";
    case "trust":            return "Chapter 5 — How Far to Trust This";
    case "ipc-overview":     return "Last Official Count — IPC";
    case "ipc-hotspot":      return `Hotspot ${scene.rank} — ${scene.hotspot.title}`;
    case "ipc-trend":        return "IPC Trend, 2017 →";
    case "ipc-region":       return "Regional Picture";
    case "crops-overview":   return "Official Harvests — PBS";
    case "crop-focus":       return `${scene.crop.name} — ${scene.crop.latest.year}`;
    case "wheat-districts":  return "Wheat Breadbasket Districts";
    case "prices-overview":  return "Chapter 3 — Prices & Wages";
    case "price-flour":      return "Wheat Flour";
    case "purchasing-power": return "Purchasing Power";
    case "outlook-weather":  return "Next 30 Days: Weather";
    case "outlook-crops":    return "Next 1–2 Months: In the Fields";
    case "outlook-prices":   return "Next 1–3 Months: Flour Price";
    case "why":              return "Why It Happens";
    case "assessment":       return "Assessment & Recommended Actions";
    default:                 return LABEL;
  }
}

function _pill(text, alert = false, color = null) {
  const sw = color ? `<span class="fsw-swatch" style="background:${color}"></span>` : "";
  return `<span class="fsw-pill${alert ? " is-alert" : ""}">${sw}${_hl(_esc(text))}</span>`;
}
function _steps(levels) {
  return `<div class="fsw-steps">${levels.map((l) => `<span class="fsw-step"><i style="background:${l.color}"></i>${_esc(l.label)}</span>`).join("")}</div>`;
}
function _legendRow(kind, title, unit, body) {
  return `<div class="fsw-legend-row"><div class="fsw-legend-title"><span class="fsw-legend-kind">${_esc(kind)}</span>${_esc(title)}${unit ? ` <small>${_esc(unit)}</small>` : ""}</div>${body}</div>`;
}
function _layersLegendHtml(scene) {
  const rows = [];
  const ch = scene.chapter;
  if (scene.kind === "ews-level" || scene.kind === "assessment") rows.push(_legendRow("Points", "NCOP level by district (Warning and Alert)", "", _steps(EWS_LEVELS.slice(2))));
  if (ch === 1 || ch === 5) rows.push(_legendRow("Area", "IPC acute food insecurity (last projection)", "phase", _steps(IPC_PHASES)));
  if (ch === 2) {
    const s = scene.crop || _staple(_state.digest, 4);
    rows.push(_legendRow("Area", `${s?.name || "Crop"} production by province`, s?.unit || "",
      `<div class="fsw-ramp">${CROP_RAMP.map((c) => `<i style="background:${c}"></i>`).join("")}</div><div class="fsw-legend-note"><span>low</span><span>high</span></div>`));
  }
  if (ch === 3) rows.push(_legendRow("Points", "WFP-monitored markets", "", `<div class="fsw-legend-note"><span class="fsw-ring"></span>Lahore · Karachi · Peshawar · Quetta · Multan</div>`));
  if (ch === 4 && scene.kind === "outlook-weather") {
    rows.push(_legendRow("Temporal", "GEFS daily precipitation", "mm/day", `<div class="fsw-legend-scale">${String(TEMPORAL_LEGENDS?.[GEFS_KEY] || "")}</div>`));
  }
  if (scene.kind === "ipc-hotspot" || scene.kind === "wheat-districts") {
    rows.push(`<div class="fsw-legend-row fsw-legend-row--hl"><span class="fsw-hl-key"><i></i>Blinking outline: in focus</span></div>`);
  }
  return rows.length ? `<div class="fsw-legend">${rows.join("")}</div>` : "";
}

function _factsHtml(scene) {
  const d = _state.digest || {};
  const pills = [];
  const k = scene.kind;
  if (k === "ews-level") {
    const H = ewsHeadline(d);
    pills.push(_pill(`${H.lv.label}`, H.n.level >= 2, H.lv.color), _pill(`${H.wp.districts} districts at Warning or Alert`, true), _pill("Modelled"));
  } else if (k === "fews-outlook") pills.push(_pill("Forecast"), _pill("Oct 2026 to May 2027"));
  else if (k === "household") pills.push(_pill("Survey 2024–25"));
  else if (k === "supply" || k === "water") pills.push(_pill("Modelled"));
  else if (k === "shocks") pills.push(_pill("Observed"));
  else if (k === "outlook-prices" && d.ews?.price_outlook) pills.push(_pill("Forecast, tested"));
  else if (k === "ipc-overview" && d.ews?.ipc?.expired) pills.push(_pill(`Modelled · expired ${_dayMonth(d.ews.ipc.valid_to)}`, true));
  else if (k === "ipc-overview" && d.ipc) {
    pills.push(_pill(`${_mil(d.ipc.totals.p3plus)} in Phase 3+`, true), _pill(`${_pct(d.ipc.totals.p3plus_pct)} of analysed`));
  } else if (k === "ipc-hotspot") {
    const h = scene.hotspot;
    const ph = IPC_PHASES.find((p) => p.k === h.phase) || IPC_PHASES[2];
    pills.push(_pill(`Phase ${h.phase} · ${ph.label}`, h.phase >= 3, ph.color), _pill(`${_pct(h.p3plus_pct)} in Phase 3+`, true));
  } else if (k === "crop-focus") {
    const s = scene.crop;
    pills.push(_pill(`${_signed(s.change_pct)} on year`, (s.change_pct || 0) < -5), _pill(`${_signed(s.vs_avg5_pct)} vs 5-yr avg`, (s.vs_avg5_pct || 0) < -5));
  } else if (k === "price-flour") {
    const f = _price(d, "Wheat flour");
    if (f) pills.push(_pill(`${_fmt(f.latest)} PKR/kg`), _pill(`${_signed(f.yoy_pct)} year on year`, (f.yoy_pct || 0) >= 10));
  } else if (k === "purchasing-power") {
    const t = d.prices?.terms_of_trade;
    if (t) pills.push(_pill(`${_fmt(t.latest, 1)} kg flour per day's wage`, t.year_ago && t.latest < t.year_ago));
  } else if (k === "assessment") {
    const lvl = WATCH_LEVELS[scene.watch.level];
    pills.push(_pill(`Watch level: ${lvl.label}`, scene.watch.level >= 2, lvl.color));
  }
  const frame = k === "outlook-weather" ? `<span class="fsw-pill fsw-frame-pill">Frame <span class="fsw-frame-value">—</span></span>` : "";
  const facts = frame || pills.length ? `<div class="fsw-facts">${frame}${pills.join("")}</div>` : "";
  return k === "intro" ? facts : facts + _layersLegendHtml(scene);
}

function _renderScene(card) {
  const scene = _state.scenes[_state.index];
  if (!scene || !card) return;
  card.querySelector(".fsw-chapter-title").textContent = _sceneTitle(scene);
  card.querySelector(".fsw-chapter-counter").textContent = `Scene ${_state.index + 1} / ${_state.scenes.length}`;
  card.querySelector(".fsw-hint").textContent = `Chapter ${scene.chapter} · ${CHAPTER_NAMES[scene.chapter] || ""}`;
  const body = card.querySelector(".fsw-body");
  body.classList.toggle("fsw-lang-ur", _state.lang === "ur");
  body.innerHTML = `<div class="fsw-caption">${_hl(_esc(_tr(scene.caption)))}</div>${_factsHtml(scene)}`;
  card.querySelector(".fsw-dots").innerHTML = _state.scenes.map((s, i) => {
    const on = i === _state.index;
    return `<button type="button" role="tab" class="fsw-dot is-ch${s.chapter}${on ? " is-active" : ""}" data-fsw-scene="${i}" aria-selected="${on}" title="${_esc(_sceneTitle(s))}"></button>`;
  }).join("");
  _updateFrameLabel();
}

function _updateFrameLabel() {
  const el = document.getElementById(CARD_ID)?.querySelector(".fsw-frame-value");
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
    <div class="fsw-head">
      <div class="fsw-title"><span class="fsw-live" aria-hidden="true"></span><span>${LABEL}</span></div>
      <div class="fsw-head-actions">
        <button type="button" class="fsw-icon-btn fsw-refresh" aria-label="Refresh data" title="Re-fetch all data and restart">${ICON_REFRESH}</button>
        <button type="button" class="fsw-icon-btn fsw-mute is-muted" aria-label="Unmute narration" title="Unmute narration">${ICON_TTS_OFF}</button>
        <button type="button" class="fsw-lang" aria-label="Switch to Urdu" title="Switch narration to Urdu">اردو</button>
        <button type="button" class="fsw-icon-btn fsw-close" aria-label="Close ${LABEL}" title="Close and return to 7-Day Outlook">✕</button>
      </div>
    </div>
    <div class="fsw-chapter-head">
      <div class="fsw-chapter-title">—</div>
      <div class="fsw-chapter-counter"></div>
    </div>
    <div class="fsw-body" role="region" aria-live="polite"></div>
    <div class="fsw-loader" role="status" aria-live="polite" hidden>
      <span class="fsw-spinner" aria-hidden="true"></span>
      <div class="fsw-loader-main">
        <div class="fsw-loader-text"></div>
        <div class="fsw-loader-bar"><i></i></div>
      </div>
      <span class="fsw-loader-time"></span>
    </div>
    <div class="fsw-progress-row">
      <div class="fsw-progress-track"><div class="fsw-progress-fill"></div></div>
      <span class="fsw-progress-timer">0.0s</span>
    </div>
    <div class="fsw-transport">
      <button type="button" class="fsw-btn fsw-btn--rw" title="Rewind (cycles 1x-5x)" aria-label="Rewind">${ICON_RW}<span class="fsw-speed"></span></button>
      <button type="button" class="fsw-btn fsw-btn--prev" title="Previous scene" aria-label="Previous">${ICON_PREV}</button>
      <button type="button" class="fsw-btn fsw-btn--play" title="Play" aria-label="Play">${ICON_PLAY}</button>
      <button type="button" class="fsw-btn fsw-btn--next" title="Next scene" aria-label="Next">${ICON_NEXT}</button>
      <button type="button" class="fsw-btn fsw-btn--ff" title="Fast-forward (cycles 1x-5x)" aria-label="Fast-forward">${ICON_FF}<span class="fsw-speed"></span></button>
      <span class="fsw-hint">Chapter 1 · Warning Level & Hunger</span>
    </div>
    <div class="fsw-dots" role="tablist"></div>
    <div class="fsw-meta">Sources: IPC · FEWS NET · WFP (HDX) · PBS · USDA · CHIRPS, NASA FLDAS & MODIS · NOAA · ACLED · World Bank/FAO · national reports. Not an IPC classification.</div>
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
  return `<div class="fswp-head is-ch${chapter}"><span class="fswp-dot" aria-hidden="true"></span>
    <span class="fswp-title">${_esc(title)}</span>${badge ? `<span class="fswp-badge"${style}>${_esc(badge)}</span>` : ""}</div>`;
}
function _refsLine(ids) {
  return `<div class="fswp-refs">Sources: ${_esc(_cite(...ids))}</div>`;
}
const SRC_IPC = `<div class="fswp-src">Data: Integrated Food Security Phase Classification (IPC) via NCOP's IPC layer.</div>`;
const SRC_PBS = `<div class="fswp-src">Data: Pakistan Bureau of Statistics Crop Reporting Service (production 000 t; cotton 000 bales).</div>`;
const SRC_WFP = `<div class="fswp-src">Data: WFP market monitoring, monthly retail prices in PKR (HDX, CC BY-IGO).</div>`;

function _kpis(items) {
  return `<div class="fswp-grid fswp-grid--${Math.min(items.length, 4)}">${items.map((k) =>
    `<div class="fswp-stat"><b${k.color ? ` style="color:${k.color}"` : ""}>${k.html}</b><span>${_esc(k.label)}</span></div>`).join("")}</div>`;
}
// Stacked bar of population by IPC phase.
function _phaseStack(p) {
  const total = IPC_PHASES.reduce((s, ph) => s + (p?.[ph.k] || 0), 0);
  if (!total) return "";
  const segs = IPC_PHASES.map((ph) => {
    const n = p[ph.k] || 0;
    return n ? `<span style="width:${(n / total) * 100}%;background:${ph.color}" title="${_esc(ph.label)}: ${_fmt(n)}"></span>` : "";
  }).join("");
  const legend = IPC_PHASES.filter((ph) => p[ph.k]).map((ph) => `<span><span class="fswp-cat" style="background:${ph.color}"></span>${ph.k} ${_esc(ph.label)} ${_u((p[ph.k] / 1e6).toFixed(2), "M")}</span>`).join("");
  return `<div class="fswp-stack">${segs}</div><div class="fswp-legend">${legend}</div>`;
}
function _hBars(rows, opts = {}) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)).filter(Number.isFinite), opts.min || 0, 1e-9);
  return `<div class="fswp-hbars">${rows.map((r) => {
    const w = Number.isFinite(r.value) ? Math.max(1.5, (Math.abs(r.value) / max) * 100) : 0;
    const marker = Number.isFinite(r.marker) ? `<b class="fswp-hbar-marker" style="left:${Math.min(100, (r.marker / max) * 100)}%" title="${_esc(r.markerLabel || "")}"></b>` : "";
    return `<div class="fswp-hbar"><span class="fswp-hbar-label" title="${_esc(r.label)}">${_esc(r.label)}</span>
      <span class="fswp-hbar-track"><i style="width:${w}%;background:${r.color || "#22c55e"}"></i>${marker}</span>
      <span class="fswp-hbar-value">${r.valueHtml ?? _esc(_fmt(r.value))}</span></div>`;
  }).join("")}</div>`;
}
// Line chart; optional reference lines and an outlook band [{i, lo, hi}].
function _lineChart(series, labels, refs = [], opts = {}) {
  const W = 340, padL = 44, padR = 8, top = 18, plotH = 118, base = top + plotH, H = base + 18;
  const vals = series.flatMap((s) => s.values).concat((opts.band || []).flatMap((b) => [b.lo, b.hi])).filter(Number.isFinite);
  const refVals = refs.map((r) => r.v).filter(Number.isFinite);
  let lo = Math.min(...vals, ...refVals), hi = Math.max(...vals, ...refVals);
  if (opts.zero) lo = Math.min(0, lo);
  const pad = (hi - lo) * 0.08 || 1;
  lo = opts.zero ? lo : lo - pad;
  hi += pad;
  const n = Math.max(labels.length, 2);
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v) => base - ((v - lo) / (hi - lo)) * plotH;
  const out = [];
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    out.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(255,255,255,0.08)"/><text x="${padL - 5}" y="${y(v) + 3}" font-size="7.5" fill="rgba(234,234,234,0.5)" text-anchor="end">${_fmt(v, opts.dp ?? 0)}</text>`);
  }
  out.push(`<text x="${padL - 5}" y="${top - 6}" font-size="7.5" font-weight="700" fill="rgba(234,234,234,0.6)" text-anchor="end">${_esc(opts.unit || "")}</text>`);
  if (opts.band?.length) {
    const b = opts.band;
    const up = b.map((p) => `${x(p.i).toFixed(1)},${y(p.hi).toFixed(1)}`).join(" ");
    const dn = b.slice().reverse().map((p) => `${x(p.i).toFixed(1)},${y(p.lo).toFixed(1)}`).join(" ");
    out.push(`<polygon points="${up} ${dn}" fill="#f59e0b" opacity="0.18"/>`);
    out.push(`<line x1="${x(b[0].i)}" x2="${x(b[0].i)}" y1="${top}" y2="${base}" stroke="rgba(255,255,255,0.3)" stroke-dasharray="2 2"/><text x="${x(b[0].i) + 3}" y="${top + 8}" font-size="7" fill="rgba(234,234,234,0.6)">indicative →</text>`);
  }
  for (const r of refs) {
    if (!Number.isFinite(r.v)) continue;
    out.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="${r.color}" stroke-dasharray="4 3" stroke-width="1.2"/>
      <text x="${W - padR - 2}" y="${y(r.v) - 2}" font-size="7.5" font-weight="700" fill="${r.color}" text-anchor="end">${_esc(r.label)}</text>`);
  }
  for (const s of series) {
    const idx = s.values.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
    const pts = idx.map((i) => `${x(i).toFixed(1)},${y(s.values[i]).toFixed(1)}`);
    if (pts.length < 2) continue;
    if (s.fill) out.push(`<polygon points="${x(idx[0]).toFixed(1)},${base} ${pts.join(" ")} ${x(idx[idx.length - 1]).toFixed(1)},${base}" fill="${s.color}" opacity="0.14"/>`);
    out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"${s.dashed ? ' stroke-dasharray="4 3"' : ""}/>`);
    const li = idx[idx.length - 1];
    out.push(`<circle cx="${x(li)}" cy="${y(s.values[li])}" r="2.6" fill="${s.color}"/>`);
  }
  const every = Math.max(1, Math.ceil(labels.length / 7));
  labels.forEach((l, i) => {
    if (i % every !== 0 && i !== labels.length - 1) return;
    const anchor = i === labels.length - 1 ? "end" : i === 0 ? "start" : "middle";
    out.push(`<text x="${x(i)}" y="${base + 11}" font-size="7.5" fill="rgba(234,234,234,0.75)" text-anchor="${anchor}">${_esc(l)}</text>`);
  });
  const legend = `<div class="fswp-legend">${series.map((s) => `<span><span class="fswp-line" style="border-color:${s.color}${s.dashed ? ";border-top-style:dashed" : ""}"></span>${_esc(s.label)}</span>`).join("")}${refs.filter((r) => Number.isFinite(r.v)).map((r) => `<span><span class="fswp-line" style="border-color:${r.color};border-top-style:dashed"></span>${_esc(r.label)}</span>`).join("")}${opts.band?.length ? `<span><span class="fswp-cat" style="background:rgba(245,158,11,0.45)"></span>indicative range</span>` : ""}</div>`;
  return `<svg class="fswp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${_esc(opts.aria || "chart")}">${out.join("")}</svg>${legend}`;
}

function _levelSteps(cur) {
  return `<div class="fswp-level">${EWS_LEVELS.map((l, i) => `<span class="${i === cur ? "is-on" : ""}" style="background:${l.color}">${_esc(l.label)}</span>`).join("")}</div>`;
}
function _showEwsIntroPopup(H) {
  _presentPopup(`${_popupHead("Briefing Overview", `National: ${H.lv.label}`, 1, H.lv.color)}
    <div class="fswp-body">
      <div class="fswp-label">National level today</div>${_levelSteps(H.n.level)}
      ${_kpis([
        { html: _u(String(H.wp.districts), `of ${H.n.districts}`), label: "districts at Warning or Alert", color: "#E67800" },
        { html: _u((H.wp.people / 1e6).toFixed(0), "million"), label: "people live there" },
        { html: _u(_fmt(H.pk.kg, 1), "kg"), label: `flour for a day's wage (average ${_fmt(H.pk.kg_avg5, 1)})` },
        { html: _u(_signed(H.pk.flour_y1, 0), ""), label: "flour price, 1 year" },
      ])}
      <div class="fswp-label">Chapters</div>
      <div class="fswp-steps">
        <div><b>1</b> Warning level and hunger: where pressure is building, and the last official counts</div>
        <div><b>2</b> Harvests and supply: is there enough wheat?</div>
        <div><b>3</b> Prices and wages: what families can afford</div>
        <div><b>4</b> The months ahead: rain, canal water, crops, prices, shocks</div>
        <div><b>5</b> How far to trust this, why it happens, and what to do</div>
      </div>
      <div class="fswp-axis-note">${_esc(`Prices to ${_monthLong(H.e.periods.prices)} · rain, soil and crops to ${_monthLong(H.e.periods.eo.rain)} · FEWS NET ${_monthLong(String(H.e.periods.fews_round || "").slice(0, 7))} · issue ${H.e.issue?.number ?? 1}. Levels are an NCOP overlay, not an IPC classification.`)}</div>
    </div>`);
}
function _scoreCell(p) { return p ? `<td class="num"><span class="fswp-cat" style="background:${EWS_LEVELS[p[0]].color}"></span> ${p[0]}</td>` : `<td class="num">–</td>`; }
function _showEwsLevelPopup() {
  const H = ewsHeadline(_state.digest);
  const list = concernList(H.e, 8);
  _presentPopup(`${_popupHead("Where Pressure Is Building", H.lv.label, 1, H.lv.color)}
    <div class="fswp-body">
      ${_levelSteps(H.n.level)}
      <div class="fswp-label">Districts at each level, by province</div>
      ${_hBars((H.e.provinces || []).filter((p) => p.count[2] + p.count[3]).map((p) => ({ label: prettyProvince(p.province), value: p.count[2] + p.count[3], color: p.count[3] ? "#C80100" : "#E67800", valueHtml: `${p.count[3] ? `${p.count[3]} Alert, ` : ""}${p.count[2]} Warning <small>of ${p.districts}</small>` })))}
      <div class="fswp-label">Most concern (0 normal … 3 alert)</div>
      <table class="fswp-table"><thead><tr><th>District</th><th class="num">Hunger</th><th class="num">Prices</th><th class="num">Water</th><th class="num">Shocks</th></tr></thead><tbody>
        ${list.map((r) => `<tr><td><span class="fswp-cat" style="background:${EWS_LEVELS[r.level].color}"></span> ${_esc(r.name)}<small class="fswp-u">${_esc(districtReason(r))}</small></td>${["hunger", "market", "water", "shocks"].map((k) => _scoreCell(r.pillars[k])).join("")}</tr>`).join("")}
      </tbody></table>
      <div class="fswp-axis-note">Warning: two pressures at 2 or more. Alert: one at 3 with medium confidence, or two at 3. A level falls only after two calm months. Confidence is Low for ${H.n.confidence?.Low || 0} of ${H.wp.districts} districts: one city's prices stand for a province.</div>
      ${_refsLine(["fewsOct", "wfpPrices", "eo", "irsa"])}
    </div>`);
}
function _showFewsPopup() {
  const H = ewsHeadline(_state.digest);
  const cnt = (i) => [1, 2, 3, 4].map((k) => H.rows.filter((r) => r.fews?.[i] === k).length);
  const rows = ["Now (Oct 2026)", "To Jan 2027", "Feb–May 2027"].map((t, i) => ({ t, c: cnt(i) }));
  const need = (H.e.register || []).find((r) => r.id === "needs2026");
  _presentPopup(`${_popupHead("FEWS NET Outlook, October 2026", "Forecast", 1)}
    <div class="fswp-body">
      <div class="fswp-label">Number of districts in each class</div>
      <table class="fswp-table"><thead><tr><th>Period</th>${IPC_PHASES.slice(0, 4).map((p) => `<th class="num">${_esc(p.label)}</th>`).join("")}</tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${_esc(r.t)}</td>${r.c.map((v, i) => `<td class="num"><span class="fswp-cat" style="background:${IPC_PHASES[i].color}"></span> ${v}</td>`).join("")}</tr>`).join("")}
      </tbody></table>
      ${need ? `<div class="fswp-brief"><div><b>Need</b>${_esc(need.text)}</div></div>` : ""}
      <div class="fswp-axis-note">IPC-compatible classes by FEWS NET analysts for whole districts. They are not IPC consensus results and not a head count.</div>
      ${_refsLine(["fewsOct"])}
    </div>`);
}
function _showHouseholdPopup() {
  const h = _state.digest.ews.household, v = h.hies, y = Object.keys(h.diet || {}).sort().pop(), x = h.diet?.[y], uy = Object.keys(h.undernourished || {}).sort().pop();
  _presentPopup(`${_popupHead("Nutrition & Households", `Survey ${v.year}`, 1)}
    <div class="fswp-body">
      ${_kpis([
        { html: _u(_fmt(v.moderate_or_severe, 1), "%"), label: `households food insecure (${_fmt(v.prev_moderate_or_severe, 1)}% in ${v.prev_year})`, color: "#E67800" },
        { html: _u(_fmt(v.severe, 1), "%"), label: "severely food insecure", color: "#ef4444" },
        ...(x ? [{ html: _u(_fmt(x.cannot_afford_pct), "%"), label: `cannot afford a healthy diet, ${y}` }] : []),
        ...(uy ? [{ html: _u(_fmt(h.undernourished[uy], 1), "%"), label: `undernourished, ${uy}` }] : []),
      ])}
      <div class="fswp-label">Food-insecure households by province</div>
      ${_hBars(Object.entries(v.provinces).sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ label: p, value: n, color: "#E67800", valueHtml: `${_fmt(n, 1)}%` })))}
      <div class="fswp-axis-note">Poorest fifth of families ${_fmt(v.poorest)}%, richest ${_fmt(v.richest)}%. These change slowly and do not set today's level. Child malnutrition has no open district data now.</div>
      ${_refsLine(["hies", "diet"])}
    </div>`);
}
function _showSupplyPopup() {
  const s = _state.digest.ews.supply, r = s.wheat.rows, l = r[r.length - 1];
  _presentPopup(`${_popupHead("Is There Enough Wheat?", l.marketing_year, 2)}
    <div class="fswp-body">
      ${_kpis([
        { html: _u(_fmt(l.production / 1000, 1), "Mt"), label: `harvest, spring ${l.harvest_year} (USDA)` },
        { html: _u(_fmt(l.use / 1000, 1), "Mt"), label: "needed" },
        { html: _u(_fmt((l.imports || 0) / 1000, 1), "Mt"), label: "imports expected" },
        { html: _u(String(l.cover_days), "days"), label: "in store at season end", color: "#E67800" },
      ])}
      <div class="fswp-label">Days of wheat in store at season end</div>
      ${_lineChart([{ label: "days of use", color: "#f59e0b", fill: true, values: r.map((x) => x.cover_days) }], r.map((x) => x.marketing_year), [], { unit: "days", zero: true, aria: "Wheat stock cover" })}
      <div class="fswp-axis-note">Estimates of the 2026 harvest differ: 29.3 million tonnes (government committee), 29.0 (USDA), about 27.5 (Dawn), about 26 (trade). Season labels are USDA marketing years.</div>
      ${_refsLine(["psd"])}
    </div>`);
}
function _showWaterPopup() {
  const w = _state.digest.ews.water, rows = (w.provinces || []).filter((p) => ["Sindh", "Balochistan", "Punjab", "Khyber Pakhtunkhwa", "Gilgit Baltistan", "Azad Kashmir"].includes(p.province));
  _presentPopup(`${_popupHead("Rain, Canals & El Niño", "", 4)}
    <div class="fswp-body">
      ${_kpis([
        ...(w.canal_pct != null ? [{ html: _u(_signed(w.canal_pct, 0), ""), label: "canal water this winter, Punjab & Sindh", color: "#E67800" }] : []),
        ...(w.reservoirs?.dams || []).map((x) => ({ html: _u(String(x.range_pct), "%"), label: `${x.name} level (0 lowest, 100 full)` })),
        ...(w.enso ? [{ html: _u(`${w.enso.oni > 0 ? "+" : ""}${_fmt(w.enso.oni, 1)}`, "°C"), label: `${w.enso.strength || ""} ${w.enso.state}` }] : []),
      ].slice(0, 4))}
      <div class="fswp-label">Monsoon ${rows[0]?.monsoon_year || ""} and conditions now, satellite</div>
      <table class="fswp-table"><thead><tr><th>Province</th><th class="num">Monsoon rain</th><th class="num">Soil (percentile)</th><th class="num">Crops (0–100)</th></tr></thead><tbody>
        ${rows.map((p) => `<tr><td>${_esc(prettyProvince(p.province))}</td><td class="num ${p.monsoon_pct < -20 ? "is-down" : ""}">${_signed(p.monsoon_pct, 0)}</td><td class="num">${_fmt(p.soil_pct)}</td><td class="num">${_fmt(p.vci)}</td></tr>`).join("")}
      </tbody></table>
      <div class="fswp-axis-note">Most of Punjab and Sindh is watered by canals, so canal water matters more there than local rain. Reservoir level is not the same as volume.</div>
      ${_refsLine(["eo", "irsa", "monsoon", "enso"])}
    </div>`);
}
function _showShocksPopup() {
  const e = _state.digest.ews, c = e.shocks?.conflict;
  const get = (id) => (e.register || []).find((x) => x.id === id);
  _presentPopup(`${_popupHead("Shocks & Trade", c ? _monthLabel(c.month) : "", 4)}
    <div class="fswp-body">
      ${c ? `<div class="fswp-label">Violent political events a month (national)</div>${_lineChart([{ label: "events", color: "#f87171", fill: true, values: c.series.map((x) => x.events) }], c.series.map((x) => _monthLabel(x.month)), [{ v: c.avg12, label: "average of the year before", color: "#94a3b8" }], { unit: "events", zero: true, aria: "Conflict events" })}` : ""}
      <div class="fswp-brief">
        ${["border2026", "imports2026", "fertiliser2026"].map(get).filter(Boolean).map((r) => `<div><b>${_esc(r.topic)}</b>${_esc(r.text)} <small>(as of ${_esc(_dayMonth(r.as_of))}${r.state === "current" ? "" : ", out of date"})</small></div>`).join("")}
      </div>
      <div class="fswp-axis-note">Conflict data are national only, so districts are not scored on conflict.</div>
      ${_refsLine(["acled", "fewsOct", "khaleej"])}
    </div>`);
}
function _showTrustPopup() {
  const e = _state.digest.ews, b = e.backtest, m = b.market, po = e.price_outlook;
  const res = (x) => (x.kind === "quiet" ? (x.first_signal ? "false alarm" : "quiet, correct") : !x.first_signal ? (x.watch_share != null ? "Watch only" : "missed") : x.kind === "wet" ? "seen as it happened" : x.known_lead_months > 0 ? `${x.known_lead_months}+ months early` : "seen after the jump");
  _presentPopup(`${_popupHead("How Far to Trust This", `${m.warning.months} months tested`, 5)}
    <div class="fswp-body">
      ${_kpis([
        { html: _u(_fmt((m.warning.precision || 0) * 100), "%"), label: "price Warnings followed by a 10% flour jump" },
        { html: _u(_fmt((m.warning.base_rate || 0) * 100), "%"), label: "chance in any month" },
        { html: _u(`${m.warning.missed}`, `of ${m.warning.surges}`), label: "jumps that came without a Warning", color: "#ef4444" },
      ])}
      <div class="fswp-label">Past events, replayed</div>
      <table class="fswp-table"><thead><tr><th>Event</th><th class="num">Result</th></tr></thead><tbody>${b.episodes.map((x) => `<tr><td>${_esc(x.label)}</td><td class="num">${_esc(res(x))}</td></tr>`).join("")}</tbody></table>
      ${po ? `<div class="fswp-label">Flour forecast: typical error since ${_esc(po.test_from.slice(0, 4))}</div>
      <table class="fswp-table"><thead><tr><th>Method</th><th class="num">1 month</th><th class="num">3 months</th></tr></thead><tbody>${po.skill.filter((s) => ["chosen", "seasonal", "no_change"].includes(s.model)).map((s) => `<tr><td>${{ chosen: "Used here", seasonal: "Old seasonal method", no_change: "Assume no change" }[s.model]}</td><td class="num">${_fmt(s.by_horizon["1"], 1)}%</td><td class="num">${_fmt(s.by_horizon["3"], 1)}%</td></tr>`).join("")}</tbody></table>` : ""}
      <div class="fswp-axis-note">The thresholds are starting values and were not tuned on these events. Data issues found this time: ${(e.issues || []).length}, listed in the exported report.</div>
    </div>`);
}

function _showIntroPopup() {
  const H = ewsHeadline(_state.digest);
  if (H) return _showEwsIntroPopup(H);
  const d = _state.digest || {};
  const t = d.ipc?.totals;
  const wheat = _staple(d, 4);
  const flour = _price(d, "Wheat flour");
  const tot = d.prices?.terms_of_trade;
  _presentPopup(`${_popupHead("Briefing Overview", "5 Chapters", 1)}
    <div class="fswp-body">
      <div class="fswp-label">Bottom line up front</div>
      ${_kpis([
        { html: _u(t ? (t.p3plus / 1e6).toFixed(1) : "—", "million"), label: "people in IPC Phase 3+", color: "#E67800" },
        { html: _u(t ? (t.p[4] / 1e6).toFixed(2) : "—", "million"), label: "in Emergency (Phase 4)", color: "#ef4444" },
        { html: wheat ? _u(_signed(wheat.change_pct), "") : "—", label: `wheat harvest ${wheat?.latest.year || ""}` },
        { html: flour ? _u(_signed(flour.yoy_pct), "") : "—", label: "wheat flour price, 1 year" },
      ])}
      <div class="fswp-label">Chapters</div>
      <div class="fswp-steps">
        <div><b>1</b> Hunger now — IPC classification, hotspots, trend, region</div>
        <div><b>2</b> The harvests — wheat, rice, cotton, maize (PBS)</div>
        <div><b>3</b> Markets & prices — 5 cities, purchasing power (WFP)</div>
        <div><b>4</b> Next 1–2 months — weather outlook, crop calendar, indicative prices</div>
        <div><b>5</b> Why it happens & assessment with recommended actions</div>
      </div>
      <div class="fswp-label">Layers & panels used</div>
      <div class="fswp-chips">
        <span class="fswp-chip">IPC — Pakistan</span><span class="fswp-chip">IPC — Afghanistan</span>
        <span class="fswp-chip">Crop Production (Provincial)</span><span class="fswp-chip">GEFS Precipitation — 35-Day</span>
        <span class="fswp-chip">Food Security Panel</span><span class="fswp-chip">Crop Explorer</span>
      </div>
      <div class="fswp-axis-note">${_esc(`IPC analysis ${d.ipc?.analysis_id || "n/a"} · PBS ${d.crops?.latest_year || "n/a"} · prices ${d.prices ? _monthLabel(d.prices.latest_month) : "n/a"}${tot?.latest ? ` · ${_fmt(tot.latest, 1)} kg flour per day's wage` : ""}`)}</div>
    </div>`);
}

function _showIpcOverviewPopup() {
  const i = _state.digest.ipc;
  const prov = (i.provinces || []).filter((p) => p.province !== "Other");
  const L = _state.digest.ews?.ipc?.lines;
  const two = L?.length ? `<div class="fswp-label">Two analyses, shown apart</div>
      <table class="fswp-table"><thead><tr><th>Analysis</th><th class="num">Then</th><th class="num">Projected</th><th class="num">Ends</th></tr></thead><tbody>
        ${L.map((l) => `<tr><td>${_esc(l.label)}</td><td class="num">${_u((l.current?.p3plus / 1e6).toFixed(2), "M")} ${_pct(l.current?.p3plus_pct)}</td><td class="num">${_u((l.projected?.p3plus / 1e6).toFixed(2), "M")} ${_pct(l.projected?.p3plus_pct)}</td><td class="num">${_esc(_dayMonth(l.periods.projected?.to))}</td></tr>`).join("")}
      </tbody></table>` : "";
  _presentPopup(`${_popupHead("Last Official Count — IPC", `${i.totals.areas} districts`, 1)}
    <div class="fswp-body">
      ${two}
      ${_kpis([
        { html: _u((i.totals.pop / 1e6).toFixed(1), "M"), label: "people analysed" },
        { html: _u((i.totals.p3plus / 1e6).toFixed(2), "M"), label: "Phase 3+", color: "#E67800" },
        { html: _u(_pct(i.totals.p3plus_pct), ""), label: "share in Phase 3+" },
        { html: _u(i.totals.phase_counts[3], "districts"), label: "classified Crisis" },
      ])}
      <div class="fswp-label">Population by phase</div>
      ${_phaseStack(i.totals.p)}
      <div class="fswp-label">Phase 3+ by province (share in brackets)</div>
      ${_hBars(prov.map((p) => ({ label: p.province, value: p.p3plus, color: "#E67800", valueHtml: `${_u((p.p3plus / 1e6).toFixed(2), "M")} <small>(${_pct(p.p3plus_pct)})</small>` })))}
      ${SRC_IPC}${_refsLine(["ipc2026"])}
    </div>`);
}

function _showHotspotPopup(scene) {
  const h = scene.hotspot;
  const ph = IPC_PHASES.find((p) => p.k === h.phase) || IPC_PHASES[2];
  _presentPopup(`${_popupHead(h.title, `Phase ${h.phase} · ${ph.label}`, 1, ph.color)}
    <div class="fswp-body">
      ${_kpis([
        { html: _u((h.pop / 1e6).toFixed(2), "M"), label: "people analysed" },
        { html: _u((h.p3plus / 1e6).toFixed(2), "M"), label: "Phase 3+", color: "#E67800" },
        { html: _u(_fmt(h.p[4]), ""), label: "Emergency (Phase 4)", color: "#ef4444" },
        { html: _u(_pct(h.p3plus_pct), ""), label: "of the district" },
      ])}
      <div class="fswp-label">Population by phase</div>
      ${_phaseStack(h.p)}
      <div class="fswp-axis-note">${_esc(`${h.province || "Province n/a"} · confidence ${h.confidence || "—"}/3${h.prolonged ? " · prolonged crisis" : ""} · the Food Security panel below shows this district's full breakdown and history.`)}</div>
      ${SRC_IPC}
    </div>`);
}

function _showTrendPopup() {
  const h = (_state.digest.ipc.history || []).filter((a) => Number.isFinite(a.phase3plus_pop));
  const labels = h.map((a) => a.date.slice(0, 7));
  _presentPopup(`${_popupHead("IPC Phase 3+ Over Time", `${h.length} analyses`, 1)}
    <div class="fswp-body">
      ${_lineChart([{ label: "people in Phase 3+ (millions)", color: "#E67800", fill: true, values: h.map((a) => a.phase3plus_pop / 1e6) },
                    { label: "people analysed (millions)", color: "#94a3b8", dashed: true, values: h.map((a) => (a.analyzed_pop || NaN) / 1e6) }],
                   labels, [], { unit: "million", dp: 0, zero: true, aria: "IPC Phase 3+ population by analysis" })}
      <table class="fswp-table"><thead><tr><th>Analysis</th><th class="num">Phase 3+</th><th class="num">Share</th></tr></thead><tbody>
        ${h.slice(-6).reverse().map((a) => `<tr><td>${_esc((a.title || "").replace(/Acute Food Insecurity/i, "AFI").slice(0, 38))}</td><td class="num">${_u((a.phase3plus_pop / 1e6).toFixed(2), "M")}</td><td class="num">${_pct(a.phase3plus_pct)}</td></tr>`).join("")}
      </tbody></table>
      <div class="fswp-axis-note">Coverage grew over time (one province in 2017 to most of the country), so compare shares, not only totals.</div>
      ${SRC_IPC}
    </div>`);
}

function _showRegionPopup() {
  const i = _state.digest.ipc;
  const n = i.neighbours || {};
  const rows = [{ label: "Pakistan", value: i.totals.p3plus_pct * 100, color: "#E67800", valueHtml: `${_pct(i.totals.p3plus_pct)} <small>(${_mil(i.totals.p3plus)})</small>` }];
  if (n.afghanistan) rows.push({ label: "Afghanistan", value: n.afghanistan.p3plus_pct * 100, color: "#C80100", valueHtml: `${_pct(n.afghanistan.p3plus_pct)} <small>(${_mil(n.afghanistan.p3plus)})</small>` });
  if (n.bangladesh) rows.push({ label: "Bangladesh", value: n.bangladesh.p3plus_pct * 100, color: "#f59e0b", valueHtml: `${_pct(n.bangladesh.p3plus_pct)} <small>(${_mil(n.bangladesh.p3plus)})</small>` });
  _presentPopup(`${_popupHead("Regional Food Insecurity", "IPC Phase 3+", 1)}
    <div class="fswp-body">
      <div class="fswp-label">Share of analysed population in Phase 3+</div>
      ${_hBars(rows)}
      <div class="fswp-axis-note">Mapped IPC analyses as published (each country's own analysis period). Afghanistan relies heavily on imported wheat and flour, so Pakistani supply and prices matter across the border.</div>
      ${SRC_IPC}${_refsLine(["ipcAfg", "ipc2026"])}
    </div>`);
}

function _cropUnit(s) {
  return s.unit === "000 bales" ? "M bales" : "Mt";
}
function _showCropsOverviewPopup() {
  const st = _state.digest.crops.staples;
  _presentPopup(`${_popupHead("Staple Harvests", _state.digest.crops.latest_year, 2)}
    <div class="fswp-body">
      <table class="fswp-table"><thead><tr><th>Crop</th><th class="num">Latest</th><th class="num">vs last year</th><th class="num">vs 5-yr avg</th></tr></thead><tbody>
        ${st.map((s) => `<tr><td>${_esc(s.name)}</td><td class="num">${_u(_fmt(s.latest.production / 1000, 2), _cropUnit(s))}</td>
          <td class="num ${(s.change_pct || 0) < 0 ? "is-down" : "is-up"}">${_signed(s.change_pct)}</td>
          <td class="num ${(s.vs_avg5_pct || 0) < 0 ? "is-down" : "is-up"}">${_signed(s.vs_avg5_pct)}</td></tr>`).join("")}
      </tbody></table>
      <div class="fswp-label">Change on the previous year</div>
      ${_hBars(st.map((s) => ({ label: s.name, value: s.change_pct, color: (s.change_pct || 0) < 0 ? "#ef4444" : "#22c55e", valueHtml: _signed(s.change_pct) })))}
      ${SRC_PBS}${_refsLine(["survey"])}
    </div>`);
}

function _showCropPopup(scene) {
  const s = scene.crop;
  const series = s.series.slice(-15);
  const prov = (_state.digest.crops.provinces?.[s.id] || []).slice(0, 5);
  const div = 1000;
  _presentPopup(`${_popupHead(s.name, s.latest.year, 2)}
    <div class="fswp-body">
      ${_kpis([
        { html: _u(_fmt(s.latest.production / div, 2), _cropUnit(s)), label: "production" },
        { html: _u(_signed(s.change_pct), ""), label: "vs previous year", color: (s.change_pct || 0) < 0 ? "#f87171" : "#4ade80" },
        { html: _u(_fmt(s.latest.yield, 2), s.unit === "000 bales" ? "bales/ha" : "t/ha"), label: "yield" },
        { html: _u(_fmt(s.latest.area / 1000, 2), "M ha"), label: "area" },
      ])}
      ${_lineChart([{ label: `production (${_cropUnit(s)})`, color: "#22c55e", fill: true, values: series.map((r) => r.production / div) }],
                   series.map((r) => r.year.slice(2)), Number.isFinite(s.avg5) ? [{ v: s.avg5 / div, label: "5-yr avg", color: "#f59e0b" }] : [],
                   { unit: _cropUnit(s), dp: 1, aria: `${s.name} production, last 15 years` })}
      <div class="fswp-label">By province, ${_esc(s.latest.year)}</div>
      ${_hBars(prov.map((p) => ({ label: p.name, value: p.production / div, color: "#16a34a", valueHtml: _u(_fmt(p.production / div, 2), _cropUnit(s)) })))}
      ${SRC_PBS}${_refsLine(s.id === 4 ? ["survey", "giewsWheat"] : ["survey"])}
    </div>`);
}

function _showDistrictsPopup() {
  const list = _state.digest.crops.wheat_districts;
  _presentPopup(`${_popupHead("Top Wheat Districts", _state.digest.crops.latest_year, 2)}
    <div class="fswp-body">
      ${_hBars(list.map((x) => ({ label: `${x.name}${x.province ? ` · ${x.province}` : ""}`, value: x.production, color: "#16a34a",
                                   valueHtml: _u(_fmt(x.production), "000 t") })))}
      <div class="fswp-axis-note">Yields: ${_esc(list.slice(0, 4).map((x) => `${x.name} ${_fmt(x.yield, 2)} t/ha`).join(" · "))}</div>
      ${SRC_PBS}
    </div>`);
}

function _showPricesPopup() {
  const p = _state.digest.prices;
  const rows = KEY_PRICES.map((n) => _price(_state.digest, n)).filter(Boolean);
  const cls = (v) => (!Number.isFinite(v) ? "" : v >= 5 ? "is-down" : v <= -5 ? "is-up" : "");
  _presentPopup(`${_popupHead("Retail Prices — 5 Markets", _monthLabel(p.latest_month), 3)}
    <div class="fswp-body">
      <table class="fswp-table"><thead><tr><th>Item</th><th class="num">Price</th><th class="num">1 year</th><th class="num">3 months</th></tr></thead><tbody>
        ${rows.map((x) => `<tr><td>${_esc(_short(x.commodity))}</td><td class="num">${_u(_fmt(x.latest), x.unit)}</td>
          <td class="num ${cls(x.yoy_pct)}">${_signed(x.yoy_pct)}</td><td class="num ${cls(x.m3_pct)}">${_signed(x.m3_pct)}</td></tr>`).join("")}
      </tbody></table>
      <div class="fswp-axis-note">Average of Lahore, Karachi, Peshawar, Quetta and Multan. Red = dearer (a cost for households), green = cheaper.</div>
      ${SRC_WFP}
    </div>`);
}

function _showFlourPopup() {
  const f = _price(_state.digest, "Wheat flour");
  const w = _price(_state.digest, "Wheat");
  const labels = f.series.map((s) => _monthLabel(s.month));
  const mk = Object.entries(f.by_market).sort((a, b) => b[1] - a[1]);
  _presentPopup(`${_popupHead("Wheat Flour & Wheat Prices", `${_fmt(f.latest)} PKR/kg`, 3)}
    <div class="fswp-body">
      ${_lineChart([{ label: "wheat flour", color: "#f59e0b", fill: true, values: f.series.map((s) => s.price) },
                    ...(w ? [{ label: "wheat grain", color: "#fde68a", dashed: true, values: w.series.map((s) => s.price) }] : [])],
                   labels, [], { unit: "PKR/kg", aria: "Wheat flour price, 24 months" })}
      <div class="fswp-label">By market, ${_esc(_monthLabel(_state.digest.prices.latest_month))}</div>
      ${_hBars(mk.map(([m, v]) => ({ label: m, value: v, color: "#f59e0b", valueHtml: _u(_fmt(v), "PKR/kg") })))}
      ${SRC_WFP}
    </div>`);
}

function _showTotPopup() {
  const t = _state.digest.prices.terms_of_trade;
  const mk = Object.entries(t.by_market).sort((a, b) => a[1] - b[1]);
  _presentPopup(`${_popupHead("Purchasing Power", "kg flour per day's wage", 3)}
    <div class="fswp-body">
      ${_kpis([
        { html: _u(_fmt(t.latest, 1), "kg"), label: "now", color: "#f59e0b" },
        { html: _u(_fmt(t.year_ago, 1), "kg"), label: "a year ago" },
        { html: _u(_fmt(t.avg5_same_month, 1), "kg"), label: "5-year average" },
      ])}
      ${_lineChart([{ label: "kg wheat flour per day of unskilled wage", color: "#f59e0b", fill: true, values: t.series.map((s) => s.kg) }],
                   t.series.map((s) => _monthLabel(s.month)), Number.isFinite(t.avg5_same_month) ? [{ v: t.avg5_same_month, label: "5-yr avg (this month)", color: "#22c55e" }] : [],
                   { unit: "kg/day", dp: 1, aria: "Wage-to-flour terms of trade" })}
      ${_hBars(mk.map(([m, v]) => ({ label: m, value: v, color: "#f59e0b", valueHtml: _u(_fmt(v, 1), "kg") })))}
      <div class="fswp-axis-note">Terms of trade = daily unskilled wage ÷ price of 1 kg wheat flour — a standard WFP/FEWS NET indicator of household access to food.</div>
      ${SRC_WFP}
    </div>`);
}

function _showWeatherPopup() {
  const w = _state.digest.outlook.weather;
  const rows = _majorProvinces(w).concat(w.provinces.filter((p) => !_majorProvinces(w).includes(p) && p.districts >= 5));
  _presentPopup(`${_popupHead(`Next ${w.days} Days — Rain & Temperature`, w.calibrated ? "bias-corrected" : "GEFS", 4)}
    <div class="fswp-body">
      <div class="fswp-label">Rain over the period (district average) vs 2001–2025 normal</div>
      ${_hBars(rows.map((p) => {
        const r = _rainRatio(p);
        return { label: p.province, value: p.rain_mm, marker: p.rain_normal_mm, markerLabel: "normal",
                 color: r != null && r < 0.5 ? "#f59e0b" : "#38bdf8",
                 valueHtml: `${_u(_fmt(p.rain_mm, 0), "mm")}${r != null ? ` <small>(${_pct(r)})</small>` : ""}` };
      }))}
      <div class="fswp-label">Mean temperature vs normal</div>
      ${_hBars(rows.filter((p) => Number.isFinite(p.temp_normal_c)).map((p) => {
        const a = p.temp_c - p.temp_normal_c;
        return { label: p.province, value: a, color: a >= 0 ? "#f97316" : "#60a5fa", valueHtml: _u(_signed(a, 1, ""), "°C") };
      }))}
      <div class="fswp-axis-note">White tick = normal rainfall. ${_esc(`${_dayMonth(w.from)} to ${_dayMonth(w.to)}, GEFS run ${String(w.run).slice(0, 8)}.`)} Week 1–2 values are the most reliable; weeks 3–5 are tendencies.</div>
      ${_refsLine(["gefs"])}
    </div>`);
}

function _showCropStagePopup() {
  const o = _state.digest.outlook;
  const cls = (s) => (s === "sowing" ? "is-sow" : s === "harvest" ? "is-harvest" : s ? "is-grow" : "");
  _presentPopup(`${_popupHead("In the Fields — Next Months", "crop calendar", 4)}
    <div class="fswp-body">
      <table class="fswp-table fswp-cal"><thead><tr><th>Crop</th>${o.months.map((m) => `<th>${_esc(m)}</th>`).join("")}</tr></thead><tbody>
        ${o.calendar.map((c) => `<tr><td>${_esc(c.crop)}</td>${c.stages.map((s) => `<td class="${cls(s)}">${_esc(s || "—")}</td>`).join("")}</tr>`).join("")}
      </tbody></table>
      ${_captionBlock(_state.scenes[_state.index]?.caption || "")}
      ${_refsLine(["giewsCal", "gefs"])}
    </div>`);
}

function _showPriceOutlookPopup() {
  const d = _state.digest;
  const f = _price(d, "Wheat flour");
  const hist = f.series.slice(-12);
  const labels = hist.map((s) => _monthLabel(s.month)).concat(f.outlook.map((o) => _monthLabel(o.month)));
  const values = hist.map((s) => s.price).concat(f.outlook.map(() => NaN));
  const mids = hist.map((_, i) => (i === hist.length - 1 ? hist[i].price : NaN)).concat(f.outlook.map((o) => o.mid));
  const band = [{ i: hist.length - 1, lo: hist[hist.length - 1].price, hi: hist[hist.length - 1].price }]
    .concat(f.outlook.map((o, k) => ({ i: hist.length + k, lo: o.lo, hi: o.hi })));
  const rows = OUTLOOK_PRICES.map((n) => _price(d, n)).filter((x) => x && x.outlook?.length);
  _presentPopup(`${_popupHead("Indicative Prices — Next 1–3 Months", "seasonal guide", 4)}
    <div class="fswp-body">
      ${_lineChart([{ label: "wheat flour (observed)", color: "#f59e0b", values },
                    { label: "indicative path", color: "#fde68a", dashed: true, values: mids }], labels, [],
                   { unit: "PKR/kg", band, aria: "Wheat flour: last 12 months and indicative seasonal path" })}
      <table class="fswp-table"><thead><tr><th>Item</th><th class="num">Now</th>${(rows[0]?.outlook || []).map((o) => `<th class="num">${_esc(_monthLabel(o.month))}</th>`).join("")}</tr></thead><tbody>
        ${rows.map((x) => `<tr><td>${_esc(_short(x.commodity))}</td><td class="num">${_fmt(x.latest)}</td>${x.outlook.map((o) => `<td class="num">${_fmt(o.mid)}<small class="fswp-u">${_fmt(o.lo)}–${_fmt(o.hi)}</small></td>`).join("")}</tr>`).join("")}
      </tbody></table>
      <div class="fswp-axis-note">Method: the median month-to-month price change for the same calendar months over the last 5 years, applied to the latest price; range = 10th–90th percentile of those changes. A seasonal guide, not a forecast.</div>
      ${SRC_WFP}${_refsLine(["wfpPrices"])}
    </div>`);
}

function _showWhyPopup() {
  const d = _state.digest;
  const cards = WHY_CARDS.map((c) => `
    <div class="fswp-why">
      <div class="fswp-why-head"><span aria-hidden="true">${c.icon}</span>${_esc(c.title)}</div>
      <div class="fswp-why-data">${_hl(_esc(c.text))}</div>
      <div class="fswp-why-research">${_esc(_cite(...c.refs))}</div>
    </div>`).join("");
  _presentPopup(`${_popupHead("Why It Happens", "Research", 5)}
    <div class="fswp-body">
      ${_kpis([
        { html: _u("3.7", "bn USD"), label: "agrifood damage, 2022 floods" },
        { html: _u("40.2", "%"), label: "children stunted (NNS 2018)" },
        { html: _u("~49", "%"), label: "peak food inflation, 2023" },
        { html: _u(_signed(_price(d, "Wheat flour")?.yoy_pct), ""), label: "wheat flour, last 12 months" },
      ])}
      ${cards}
    </div>`);
}

function _showAssessmentPopup(scene) {
  const d = _state.digest || {};
  const w = scene.watch;
  const lvl = WATCH_LEVELS[w.level];
  const H = ewsHeadline(d);
  if (H) {
    const all = Object.values(REFS).map((r) => `<li>${_esc(r.full)}</li>`).join("");
    _presentPopup(`${_popupHead("What to Do", H.lv.label, 5, H.lv.color)}
      <div class="fswp-body">
        ${_levelSteps(H.n.level)}
        <div class="fswp-brief">${(H.e.actions || []).map((a, i) => `<div><b>Action ${i + 1}</b><strong>${_esc(a.title)}.</strong> ${_esc(a.text)} <small>Who: ${_esc(a.owner)}. When: ${_esc(a.by)}.</small></div>`).join("")}</div>
        <div class="fswp-label">Risk calendar</div>
        <table class="fswp-table"><tbody>${(H.e.calendar || []).map((c) => `<tr><td>${c.now ? "<b>NOW</b> " : ""}${_esc(c.window)}</td><td>${_esc(c.risk)}</td></tr>`).join("")}</tbody></table>
        <details class="fswp-refs-all"><summary>References (${Object.keys(REFS).length})</summary><ol>${all}</ol></details>
      </div>`);
    return;
  }
  const hs = hotspots(d);
  const flour = _price(d, "Wheat flour");
  const fLast = flour?.outlook?.[flour.outlook.length - 1];
  const dry = _majorProvinces(d.outlook?.weather).filter((p) => (_rainRatio(p) ?? 1) < 0.5).map((p) => p.province);
  const refs = Object.values(REFS).map((r) => `<li>${_esc(r.full)}</li>`).join("");
  _presentPopup(`${_popupHead("Assessment", `Watch: ${lvl.label}`, 5, lvl.color)}
    <div class="fswp-body">
      <div class="fswp-level">
        ${WATCH_LEVELS.map((l, i) => `<span class="${i === w.level ? "is-on" : ""}" style="background:${l.color}">${_esc(l.label)}</span>`).join("")}
      </div>
      <div class="fswp-brief">
        <div><b>Situation</b>${_esc(d.ipc ? `${_mil(d.ipc.totals.p3plus)} people (${_pct(d.ipc.totals.p3plus_pct)}) in IPC Phase 3+, ${_mil(d.ipc.totals.p[4], 2)} in Phase 4.` : "IPC data unavailable.")}</div>
        <div><b>Where</b>${_esc(hs.length ? hs.map((h) => `${h.title}${h.province ? ` (${h.province})` : ""}`).join(", ") : "—")}</div>
        <div><b>Markets</b>${_esc(flour ? `Wheat flour ${_fmt(flour.latest)} PKR/kg (${_signed(flour.yoy_pct)} in a year); a day's wage buys ${_fmt(d.prices?.terms_of_trade?.latest, 1)} kg.` : "—")}</div>
        <div><b>Next 1–2 months</b>${_esc(`${dry.length ? `Dry outlook in ${dry.join(", ")} during wheat sowing.` : "Rain near normal for wheat sowing."}${fLast ? ` Flour indicatively ${_fmt(fLast.mid)} PKR/kg by ${_monthLong(fLast.month)}.` : ""}`)}</div>
        <div><b>Action</b>${_esc(lvl.action)}</div>
      </div>
      <table class="fswp-table"><thead><tr><th>Indicator</th><th class="num">Now</th><th class="num">Points</th></tr></thead><tbody>
        ${w.indicators.map((i) => `<tr><td>${_esc(i.name)}</td><td class="num">${_esc(i.value)}</td><td class="num">${i.points}</td></tr>`).join("")}
        <tr><td><b>Total</b> (0–1 Normal · 2–3 Watch · 4–5 Warning · 6+ Alert)</td><td></td><td class="num"><b>${w.score}</b></td></tr>
      </tbody></table>
      <details class="fswp-refs-all"><summary>References (${Object.keys(REFS).length})</summary><ol>${refs}</ol></details>
    </div>`);
}

// ==========================================================================
// Map overlays: blinking outlines (districts) and market rings
// ==========================================================================
function _ensureOverlayLayers() {
  const map = window.ncop_map;
  if (!map) return;
  try {
    if (!map.getSource(OUTLINE_SRC)) map.addSource(OUTLINE_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!map.getLayer(OUTLINE_FILL)) map.addLayer({ id: OUTLINE_FILL, type: "fill", source: OUTLINE_SRC, paint: { "fill-color": "#fbbf24", "fill-opacity": 0.12 } });
    if (!map.getLayer(OUTLINE_LINE)) map.addLayer({ id: OUTLINE_LINE, type: "line", source: OUTLINE_SRC, paint: { "line-color": "#fbbf24", "line-width": 3, "line-opacity": 1 } });
    if (!map.getSource(FOCUS_SRC)) map.addSource(FOCUS_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    if (!map.getLayer(FOCUS_HALO_ID)) map.addLayer({ id: FOCUS_HALO_ID, type: "circle", source: FOCUS_SRC, paint: { "circle-radius": 20, "circle-color": ["coalesce", ["get", "color"], "#f59e0b"], "circle-blur": 0.9, "circle-opacity": 0.35 } });
    if (!map.getLayer(FOCUS_RING_ID)) map.addLayer({ id: FOCUS_RING_ID, type: "circle", source: FOCUS_SRC, paint: { "circle-radius": 12, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": ["coalesce", ["get", "color"], "#f59e0b"], "circle-stroke-width": 3 } });
    for (const id of [OUTLINE_FILL, OUTLINE_LINE, FOCUS_HALO_ID, FOCUS_RING_ID]) map.moveLayer(id);
  } catch (_) { /* best-effort */ }
}
function _setOutlines(features) {
  const map = window.ncop_map;
  if (!map) return;
  _ensureOverlayLayers();
  try { map.getSource(OUTLINE_SRC)?.setData({ type: "FeatureCollection", features: features.filter((f) => f?.geometry) }); } catch (_) {}
  _startBlink();
}
function _setMarkets(points) {
  const map = window.ncop_map;
  if (!map) return;
  _ensureOverlayLayers();
  try {
    map.getSource(FOCUS_SRC)?.setData({ type: "FeatureCollection", features: points.filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))
      .map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: p.color ? { color: p.color } : {} })) });
  } catch (_) {}
  _startBlink();
}
/** Districts at Warning and Alert as coloured rings (Alert drawn last, on top). */
function _levelPoints(d) {
  return (d?.ews?.districts || []).filter((r) => r.level >= 2 && r.centroid).sort((a, b) => a.level - b.level)
    .map((r) => ({ lon: r.centroid[0], lat: r.centroid[1], color: EWS_LEVELS[r.level].color }));
}
function _startBlink() {
  if (_state.blinkTimer) return;
  const map = window.ncop_map;
  if (!map) return;
  _state.blinkTimer = setInterval(() => {
    _state.blinkPhase = !_state.blinkPhase;
    const on = _state.blinkPhase;
    try {
      if (map.getLayer(OUTLINE_LINE)) { map.setPaintProperty(OUTLINE_LINE, "line-opacity", on ? 1 : 0.3); map.setPaintProperty(OUTLINE_LINE, "line-width", on ? 3.5 : 2); }
      if (map.getLayer(FOCUS_RING_ID)) map.setPaintProperty(FOCUS_RING_ID, "circle-radius", on ? 18 : 10);
      if (map.getLayer(FOCUS_HALO_ID)) map.setPaintProperty(FOCUS_HALO_ID, "circle-opacity", on ? 0.5 : 0.15);
    } catch (_) {}
  }, 460);
}
function _clearOverlays() {
  if (_state.blinkTimer) { clearInterval(_state.blinkTimer); _state.blinkTimer = null; }
  const map = window.ncop_map;
  const empty = { type: "FeatureCollection", features: [] };
  try { map?.getSource(OUTLINE_SRC)?.setData(empty); } catch (_) {}
  try { map?.getSource(FOCUS_SRC)?.setData(empty); } catch (_) {}
}
function _removeOverlays() {
  _clearOverlays();
  const map = window.ncop_map;
  if (!map) return;
  for (const id of [FOCUS_RING_ID, FOCUS_HALO_ID, OUTLINE_LINE, OUTLINE_FILL]) { try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {} }
  for (const id of [OUTLINE_SRC, FOCUS_SRC]) { try { if (map.getSource(id)) map.removeSource(id); } catch (_) {} }
}

// ==========================================================================
// Stats panels (IPC Food Security panel, Crop Explorer) docked beside the card
// ==========================================================================
function _visibleRect(el) {
  if (!el) return null;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}
// Fit a bottom-docked panel between the story popup and the story card so it
// never covers either (same rule as the FFD panel in the Flood Watch).
function _dock(modal) {
  if (!modal || modal.classList.contains("hidden")) return;
  const story = _visibleRect(document.getElementById(MODAL_ID));
  if (!story) return;
  const margin = 12;
  let left = margin;
  const pop = _visibleRect(document.getElementById(POPUP_ID));
  if (pop && pop.left < window.innerWidth / 2) left = Math.max(left, pop.right + margin);
  const right = story.left - margin;
  const minW = 520;
  if (right - left < minW) left = Math.max(margin, right - minW);
  Object.assign(modal.style, { right: "auto", left: `${Math.round(left)}px`, width: `${Math.round(Math.max(minW, right - left))}px`,
                               height: `${DOCK_HEIGHT_PX}px`, minWidth: "0" });
}
function _undock(modal) {
  if (!modal) return;
  for (const p of ["left", "right", "width", "height", "minWidth"]) modal.style[p] = "";
}
function _openIpcPanel(h) {
  // The panel is opened through its own delegated click handler (the same one
  // the IPC popup's "Open Food Security Panel" button uses).
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ipc-open-stats";
  b.style.display = "none";
  const ph = IPC_PHASES.find((p) => p.k === h.phase) || IPC_PHASES[2];
  Object.assign(b.dataset, {
    country: "pakistan", title: h.title, phase: String(h.phase), phaseLabel: ph.label, color: h.color || ph.color,
    anlId: String(_state.digest?.ipc?.analysis_id || ""), totalPop: String(h.pop), classifiedPop: String(h.p3plus),
    confidence: String(h.confidence || ""), prolonged: h.prolonged ? "true" : "false",
    phase1Pop: String(h.p[1]), phase2Pop: String(h.p[2]), phase3Pop: String(h.p[3]), phase4Pop: String(h.p[4]), phase5Pop: String(h.p[5]),
    phase1Pct: String(h.pop ? h.p[1] / h.pop : 0), phase2Pct: String(h.pop ? h.p[2] / h.pop : 0), phase3Pct: String(h.pop ? h.p[3] / h.pop : 0),
    phase4Pct: String(h.pop ? h.p[4] / h.pop : 0), phase5Pct: String(h.pop ? h.p[5] / h.pop : 0),
  });
  document.body.appendChild(b);
  try { b.click(); } catch (_) {}
  b.remove();
  _state.dockedOpen = "ipc";
  const modal = document.getElementById("ipc-stats-modal");
  _dock(modal);
  setTimeout(() => _dock(modal), 450); // the story popup may still be fading in
}
function _openCropPanel(cropId, year) {
  if (typeof window.__openCropExplorer !== "function") return;
  try { window.__openCropExplorer(cropId, year); } catch (_) { return; }
  _state.dockedOpen = "crop";
  const modal = document.querySelector(".crop-modal");
  _dock(modal);
  setTimeout(() => _dock(document.querySelector(".crop-modal")), 450);
}
function _closePanels() {
  const ipc = document.getElementById("ipc-stats-modal");
  if (ipc && !ipc.classList.contains("hidden")) { try { ipc.querySelector("[data-ipc-close]")?.click(); } catch (_) {} }
  _undock(ipc);
  const crop = document.querySelector(".crop-modal");
  if (crop && !crop.classList.contains("hidden")) { try { crop.querySelector("[data-crop-close]")?.click(); } catch (_) {} }
  _undock(crop);
  _state.dockedOpen = null;
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
function _currentCropFilter() {
  const sel = document.querySelector(".ncop-crop-filter__row.is-selected");
  const id = Number(sel?.dataset.cropId);
  return Number.isFinite(id) && id > 0 ? id : null;
}
// Drive the crop through the sidebar crop filter (so its counter, the map
// source and the paint ramp stay in sync); fall back to the source itself.
function _selectCrop(cropId, year) {
  if (_state.operatorCrop == null) _state.operatorCrop = _currentCropFilter() || 4;
  _state.cropSelected = cropId;
  const row = document.querySelector(`.ncop-crop-filter__row[data-crop-id="${cropId}"]`);
  if (row) { try { row.click(); return; } catch (_) {} }
  const map = window.ncop_map;
  const prov = _state.digest?.crops?.provinces?.[cropId] || [];
  try {
    map?.getSource(`${CROP_KEY}-source`)?.setData(`${window.location.origin}/api/crops/geojson/?crop=${cropId}&year=${year}&level=11`);
    const vals = prov.map((p) => p.production).filter(Number.isFinite).sort((a, b) => a - b);
    if (vals.length >= 2 && map?.getLayer(`${CROP_KEY}-fill`)) {
      const mx = vals[vals.length - 1];
      const stops = [0, mx * 0.05, mx * 0.15, mx * 0.4, mx];
      map.setPaintProperty(`${CROP_KEY}-fill`, "fill-color", ["case", ["!=", ["get", "has_data"], true], "#e5e7eb",
        ["interpolate", ["linear"], ["to-number", ["coalesce", ["get", "production"], 0]], ...stops.flatMap((s, i) => [s, CROP_RAMP[i]])]]);
    }
  } catch (_) { /* best-effort */ }
}
function _restoreCrop() {
  if (_state.cropSelected != null && _state.operatorCrop != null && _state.operatorCrop !== _state.cropSelected) {
    const row = document.querySelector(`.ncop-crop-filter__row[data-crop-id="${_state.operatorCrop}"]`);
    try { row?.click(); } catch (_) {}
  }
  _state.cropSelected = null;
  _state.operatorCrop = null;
}

// Exactly one chapter's layers on the map; idempotent.
async function _ensureChapterLayers(chapter, token, card) {
  if (_state.layerChapter === chapter) return true;
  _stopLayerTracking(card);
  _clearOverlays();
  _closePanels();
  let ok = true;
  if (chapter === 1 || chapter === 5) {
    [CROP_KEY].forEach(_storyToggleOff);
    await _deactivateTemporal(GEFS_KEY);
    await _storyToggleOn(IPC_KEY);
  } else if (chapter === 2) {
    [IPC_KEY, IPC_AFG_KEY].forEach(_storyToggleOff);
    await _deactivateTemporal(GEFS_KEY);
    await _storyToggleOn(CROP_KEY);
  } else if (chapter === 3) {
    [IPC_KEY, IPC_AFG_KEY, CROP_KEY].forEach(_storyToggleOff);
    await _deactivateTemporal(GEFS_KEY);
  } else if (chapter === 4) {
    [IPC_KEY, IPC_AFG_KEY, CROP_KEY].forEach(_storyToggleOff);
  }
  if (token !== _state.runToken) return false;
  _state.layerChapter = chapter;
  _ensureOverlayLayers();
  return ok;
}

// ==========================================================================
// Scene choreography
// ==========================================================================
async function _runIntro(map, scene, token, seq, card) {
  _showIntroPopup();
  enableCinematicAtmosphere(map);
  map.jumpTo(REGIONAL_START);
  await Promise.all([
    cinematicFlyTo(map, { center: PAKISTAN_CENTER, zoom: 4.7, pitch: 32, bearing: 0, duration: _dur(4200) }),
    _ensureChapterLayers(1, token, card),
  ]);
  if (_isStale(token, seq)) return;
  await cinematicEaseTo(map, { bearing: 8, pitch: 36, duration: _dur(2200) });
}

async function _runEwsLevel(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _setMarkets(_levelPoints(_state.digest));
  _showEwsLevelPopup();
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 0, bearing: 0, duration: _dur(2600) });
}
/** Scenes that only need a popup and a steady country view. */
function _panelScene(chapter, show, camera) {
  return async (map, scene, token, seq, card) => {
    await _ensureChapterLayers(chapter, token, card);
    if (_isStale(token, seq)) return;
    _closePanels();
    _clearOverlays();
    if (chapter === 4) { await _deactivateTemporal(GEFS_KEY); if (_isStale(token, seq)) return; }
    show(scene);
    await cinematicFitBounds(map, PAKISTAN_BOUNDS, { bearing: 0, duration: _dur(2600), ...camera });
  };
}

async function _runIpcOverview(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _clearOverlays();
  _showIpcOverviewPopup();
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 0, bearing: 0, duration: _dur(2600) });
}

async function _runHotspot(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  const h = scene.hotspot;
  _closePanels();
  _setOutlines(h.outline ? [{ type: "Feature", geometry: h.outline, properties: {} }] : []);
  _showHotspotPopup(scene);
  const b = _bboxToBounds(h.bbox);
  if (b) await cinematicFitBounds(map, b, { pitch: 40, bearing: -8 + scene.rank * 4, duration: _dur(3000), padding: 120, maxZoom: 8.5 });
  else if (h.centroid) await cinematicFlyTo(map, { center: h.centroid, zoom: 7.5, pitch: 40, duration: _dur(3000) });
  if (_isStale(token, seq)) return;
  _openIpcPanel(h);
}

async function _runTrend(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _closePanels();
  _clearOverlays();
  _showTrendPopup();
  await orbitAroundPoint(map, [68.6, 26.5], { durationMs: _dur(8000), radiusMeters: 140000, altitudeMeters: 900000, revolutions: 0.08 });
}

async function _runRegion(map, scene, token, seq, card) {
  await _ensureChapterLayers(1, token, card);
  if (_isStale(token, seq)) return;
  _closePanels();
  _showRegionPopup();
  await Promise.all([
    _storyToggleOn(IPC_AFG_KEY),
    cinematicFitBounds(map, REGION_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(3200) }),
  ]);
}

async function _runCropsOverview(map, scene, token, seq, card) {
  const s = _staple(_state.digest, 4);
  _selectCrop(4, s?.latest.year || _state.digest.crops.latest_year);
  await _ensureChapterLayers(2, token, card);
  if (_isStale(token, seq)) return;
  _showCropsOverviewPopup();
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 25, bearing: 0, duration: _dur(2800) });
}

async function _runCropFocus(map, scene, token, seq, card) {
  await _ensureChapterLayers(2, token, card);
  if (_isStale(token, seq)) return;
  const s = scene.crop;
  _closePanels();
  _selectCrop(s.id, s.latest.year);
  _showCropPopup(scene);
  await cinematicEaseTo(map, { center: PUNJAB_PLAIN, zoom: 5.4, pitch: 38, bearing: -12 + FOCUS_CROPS.indexOf(s.id) * 8, duration: _dur(2800) });
  if (_isStale(token, seq)) return;
  if (s.id === 4) _openCropPanel(4, s.latest.year);   // wheat: open the Crop Explorer once
}

async function _runWheatDistricts(map, scene, token, seq, card) {
  await _ensureChapterLayers(2, token, card);
  if (_isStale(token, seq)) return;
  _closePanels();
  _selectCrop(4, _state.digest.crops.latest_year);
  const list = _state.digest.crops.wheat_districts;
  _setOutlines(list.filter((x) => x.outline).map((x) => ({ type: "Feature", geometry: x.outline, properties: {} })));
  _showDistrictsPopup();
  const b = _bboxToBounds(_unionBbox(list));
  if (b) await cinematicFitBounds(map, b, { pitch: 42, bearing: 10, duration: _dur(3200), padding: 90 });
}

async function _runPricesOverview(map, scene, token, seq, card) {
  await _ensureChapterLayers(3, token, card);
  if (_isStale(token, seq)) return;
  _setMarkets(_state.digest.prices.markets || []);
  _showPricesPopup();
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 30, bearing: 0, duration: _dur(2600) });
}

async function _runFlour(map, scene, token, seq, card) {
  await _ensureChapterLayers(3, token, card);
  if (_isStale(token, seq)) return;
  _setMarkets(_state.digest.prices.markets || []);
  _showFlourPopup();
  const lahore = (_state.digest.prices.markets || []).find((m) => m.market === "Lahore");
  if (lahore) await cinematicFlyTo(map, { center: [lahore.lon, lahore.lat], zoom: 6, pitch: 45, bearing: 15, duration: _dur(3000) });
}

async function _runTot(map, scene, token, seq, card) {
  await _ensureChapterLayers(3, token, card);
  if (_isStale(token, seq)) return;
  _setMarkets(_state.digest.prices.markets || []);
  _showTotPopup();
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 30, bearing: -6, duration: _dur(2600) });
}

async function _runWeather(map, scene, token, seq, card) {
  await _ensureChapterLayers(4, token, card);
  if (_isStale(token, seq)) return;
  _showWeatherPopup();
  _trackLayerLoading(card, token, GEFS_KEY, "GEFS 35-day rain outlook");
  const [ok] = await Promise.all([
    _activateTemporal(GEFS_KEY, "GEFS daily precipitation — next 30 days", token),
    cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 0, bearing: 0, duration: _dur(2400) }),
  ]);
  if (!ok || _isStale(token, seq)) return;
  const n = (_temporal()?.layersDef || []).length;
  _loopFrames(Array.from({ length: Math.min(30, n) }, (_, i) => i), token, seq);
}

async function _runCropStage(map, scene, token, seq, card) {
  await _ensureChapterLayers(4, token, card);
  if (_isStale(token, seq)) return;
  _showCropStagePopup();
  await cinematicEaseTo(map, { center: PUNJAB_PLAIN, zoom: 5.6, pitch: 45, bearing: 20, duration: _dur(3000) });
}

async function _runPriceOutlook(map, scene, token, seq, card) {
  await _ensureChapterLayers(4, token, card);
  if (_isStale(token, seq)) return;
  await _deactivateTemporal(GEFS_KEY);
  _setMarkets(_state.digest.prices?.markets || []);
  _showPriceOutlookPopup();
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 20, bearing: 0, duration: _dur(2600) });
}

async function _runWhy(map, scene, token, seq, card) {
  _closePopup();
  await Promise.all([
    cinematicFlyTo(map, { center: [70.5, 28.5], zoom: 5.2, pitch: 50, bearing: -10, duration: _dur(3000) }),
    _ensureChapterLayers(5, token, card),
  ]);
  if (_isStale(token, seq)) return;
  _showWhyPopup();
  await orbitAroundPoint(map, [70.5, 28.5], { durationMs: _dur(9000), radiusMeters: 160000, altitudeMeters: 280000, revolutions: 0.15 });
}

async function _runAssessment(map, scene, token, seq, card) {
  await _ensureChapterLayers(5, token, card);
  if (_isStale(token, seq)) return;
  _closePopup();
  if (scene.watch.ews) _setMarkets(_levelPoints(_state.digest));
  else _setOutlines(hotspots(_state.digest).filter((h) => h.outline).map((h) => ({ type: "Feature", geometry: h.outline, properties: {} })));
  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { pitch: 0, bearing: 0, duration: _dur(2600) });
  if (_isStale(token, seq)) return;
  _showAssessmentPopup(scene);
  disableCinematicAtmosphere(map);
}

const RUNNERS = {
  "intro": _runIntro,
  "ews-level": _runEwsLevel,
  "fews-outlook": _panelScene(1, _showFewsPopup, { pitch: 10 }),
  "household": _panelScene(1, _showHouseholdPopup, { pitch: 25 }),
  "supply": _panelScene(2, _showSupplyPopup, { pitch: 20 }),
  "water": _panelScene(4, _showWaterPopup, { pitch: 15 }),
  "shocks": _panelScene(4, _showShocksPopup, { pitch: 20 }),
  "trust": _panelScene(5, _showTrustPopup, { pitch: 10 }),
  "ipc-overview": _runIpcOverview,
  "ipc-hotspot": _runHotspot,
  "ipc-trend": _runTrend,
  "ipc-region": _runRegion,
  "crops-overview": _runCropsOverview,
  "crop-focus": _runCropFocus,
  "wheat-districts": _runWheatDistricts,
  "prices-overview": _runPricesOverview,
  "price-flour": _runFlour,
  "purchasing-power": _runTot,
  "outlook-weather": _runWeather,
  "outlook-crops": _runCropStage,
  "outlook-prices": _runPriceOutlook,
  "why": _runWhy,
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
    console.warn("[food-security-watch] scene failed:", scene.kind, e); // a camera/layer hiccup must not stall the briefing
  }
}

// ==========================================================================
// Load / show / hide
// ==========================================================================
async function _fetchWatch(token) {
  const started = Date.now();
  for (;;) {
    const r = await fetch(WATCH_URL, { credentials: "same-origin" });
    if (r.status === 200) return r.json();
    if (r.status !== 202 || Date.now() - started > WATCH_WAIT_MS || token !== _state.runToken) throw new Error(`HTTP ${r.status}`);
    await wait(Math.min(Number(r.headers.get("Retry-After")) || 10, 15) * 1000);
  }
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
  card.querySelector(".fsw-chapter-title").textContent = LABEL;
  card.querySelector(".fsw-chapter-counter").textContent = "";
  card.querySelector(".fsw-dots").innerHTML = "";
  card.querySelector(".fsw-body").innerHTML = _loadingHtml(forceRefresh
    ? "Refreshing food-security, harvest and price data…"
    : "Loading food-security, harvest, price and outlook data…");
  if (!useCached) {
    const startedAt = performance.now();
    const loadTimer = setInterval(() => {
      if (token !== _state.runToken) { clearInterval(loadTimer); return; }
      _showLoader(card, "Fetching IPC, PBS crops, WFP prices and the GEFS outlook…", null, startedAt);
    }, 250);
    const digest = await _fetchWatch(token).catch(() => null);
    clearInterval(loadTimer);
    _hideLoader(card);
    if (token !== _state.runToken) return;
    if (!digest || (!digest.ipc && !digest.crops && !digest.prices && !digest.ews)) {
      card.querySelector(".fsw-body").innerHTML = `<div class="fsw-status">Food-security data are unavailable right now. Try Refresh in a few minutes.</div>`;
      return;
    }
    _state.digest = digest;
    _state.loadedOnce = true;
  }
  _state.scenes = buildScenes(_state.digest);
  _state.index = 0;
  _state.layerChapter = 0;
  _setSpeed(1, 1);
  _state.ttsEnabled = false; // every run starts muted, like the other briefings
  _syncMuteButton(card);

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
  _closePanels();
  _stopLayerTracking(document.getElementById(CARD_ID));
  _removeOverlays();
  const map = window.ncop_map;
  if (map) disableCinematicAtmosphere(map);
  _restoreCrop();
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
  // Another story's change handler may restore the 7-Day Outlook after ours.
  setTimeout(() => { if (_state.active) window.ncopProvincialForecast?.hide(); }, 0);
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
const REPORT_POPUPS = {
  "intro": () => _showIntroPopup(),
  "ews-level": () => _showEwsLevelPopup(),
  "fews-outlook": () => _showFewsPopup(),
  "household": () => _showHouseholdPopup(),
  "supply": () => _showSupplyPopup(),
  "water": () => _showWaterPopup(),
  "shocks": () => _showShocksPopup(),
  "trust": () => _showTrustPopup(),
  "ipc-overview": () => _showIpcOverviewPopup(),
  "ipc-hotspot": (sc) => _showHotspotPopup(sc),
  "ipc-trend": () => _showTrendPopup(),
  "ipc-region": () => _showRegionPopup(),
  "crops-overview": () => _showCropsOverviewPopup(),
  "crop-focus": (sc) => _showCropPopup(sc),
  "wheat-districts": () => _showDistrictsPopup(),
  "prices-overview": () => _showPricesPopup(),
  "price-flour": () => _showFlourPopup(),
  "purchasing-power": () => _showTotPopup(),
  "outlook-weather": () => _showWeatherPopup(),
  "outlook-crops": () => _showCropStagePopup(),
  "outlook-prices": () => _showPriceOutlookPopup(),
  "why": () => _showWhyPopup(),
  "assessment": (sc) => _showAssessmentPopup(sc),
};
// Run a scene's popup builder with its output redirected into the report.
function _reportPopupHtml(scene) {
  const fn = REPORT_POPUPS[scene.kind];
  if (!fn) return "";
  let html = "";
  const present = _presentPopup;
  _presentPopup = (h) => { html = h; };
  try { fn(scene); } catch (e) { console.warn("[food-security-watch] report popup failed:", scene.kind, e); } finally { _presentPopup = present; }
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
  _closePanels();
  _state.runToken += 1;          // stops any running scene choreography
  const token = _state.runToken;
  const d = _state.digest;
  try {
    await runStoryExport({
      format, win, card, slug: "food-security-agriculture-watch",
      meta: ewsHeadline(d) ? foodReportMeta(d) : {
        title: LABEL,
        subtitle: "IPC food insecurity · harvests · market prices · next 1–2 months · assessment",
        strip: [
          { label: "Issued", value: new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
          { label: "IPC analysis", value: String(d.ipc?.analysis_id || "n/a") },
          { label: "Harvest / prices", value: `${d.crops?.latest_year || "n/a"} · ${d.prices ? _monthLong(d.prices.latest_month) : "n/a"}` },
          { label: "Reference", value: `NDMA/NCOP/FSW/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}` },
        ],
        glossary: [
          { term: "IPC", def: "Integrated Food Security Phase Classification: the international hunger scale, from Phase 1 (Minimal) to Phase 5 (Famine)." },
          { term: "Phase 3+ (Crisis or worse)", def: "People who cannot meet basic food needs without cutting meals or selling what they own. They need urgent help." },
          { term: "Phase 4 (Emergency)", def: "Large food gaps, with high levels of malnutrition and deaths. Life-saving help is needed." },
          { term: "Current vs projection", def: "The IPC estimate for the analysis period now, and its estimate for the coming months." },
          { term: "Mt", def: "Million tonnes." },
          { term: "5-year average", def: "The average of the last five harvests. It is used to judge whether a harvest was good or poor." },
          { term: "Rabi / Kharif", def: "Winter crop season (wheat, sown Nov–Dec, harvested Apr–May) and summer crop season (rice, cotton, maize, sugarcane)." },
          { term: "Year-on-year (YoY)", def: "The change compared with the same month last year." },
          { term: "Terms of trade", def: "How much wheat flour a day's casual-labour wage buys. It falls when food becomes dearer than wages." },
          { term: "Indicative price path", def: "A likely range for the next one to two months, based on usual seasonal price changes. It is not a guarantee." },
          { term: "GEFS outlook", def: "NOAA's 35-day weather outlook, bias-corrected by NCOP against observations." },
        ],
        footer: "Sources: IPC, PBS Crop Reporting Service, WFP market monitoring (HDX), NOAA GEFS (bias-corrected by NCOP), FAO, World Bank and national reports.",
      },
      steps: [{ key: "data", label: "Briefing data" }, { key: "map1", label: "Map: warning levels & food insecurity" },
              { key: "map2", label: "Map: wheat production by province" }],
      build: async ({ run, mark }) => {
        run("data"); mark("data");
        const shots = {};
        if (map) {
          run("map1");
          await _ensureChapterLayers(1, token, card);
          const levels = _levelPoints(d);
          if (levels.length) _setMarkets(levels);
          else _setOutlines(hotspots(d).filter((h) => h.outline).map((h) => ({ type: "Feature", geometry: h.outline, properties: {} })));
          map.fitBounds(PAKISTAN_BOUNDS, { duration: 0, padding: 30, pitch: 0, bearing: 0 });
          const a = await captureMap(map, { settleMs: 300 });
          if (token !== _state.runToken) throw new Error("briefing closed during export");
          shots[1] = [{ src: a, caption: levels.length
            ? "Rings: districts at Warning (orange) and Alert (red) today [Modelled, NCOP]. Shading: the last IPC projection, to 30 September 2026. They are different measures."
            : "IPC acute food insecurity (projection) by district; outlined: the five hotspot districts." }];
          mark("map1", a ? "ok" : "warn");
          run("map2");
          _clearOverlays();
          const wheat = _staple(d, 4);
          _selectCrop(4, wheat?.latest.year || d.crops?.latest_year);
          await _ensureChapterLayers(2, token, card);
          _selectCrop(4, wheat?.latest.year || d.crops?.latest_year); // again: the layer may only exist now
          map.fitBounds(PAKISTAN_BOUNDS, { duration: 0, padding: 30, pitch: 0, bearing: 0 });
          for (let i = 0; i < 12 && !map.getLayer?.(`${CROP_KEY}-fill`); i++) await wait(250);
          const b = await captureMap(map, { settleMs: 1200 });
          if (token !== _state.runToken) throw new Error("briefing closed during export");
          shots[2] = [{ src: b, caption: `Wheat production by province, PBS crop year ${wheat?.latest.year || ""}${wheat?.harvest ? ` (cut in ${wheat.harvest})` : ""}; darker = more [Observed].` }];
          mark("map2", b ? "ok" : "warn");
        } else {
          mark("map1", "warn"); mark("map2", "warn");
        }
        const decision = foodReportSections(d, { shots });
        if (decision) return decision;
        return scenesToSections({ scenes: _state.scenes, chapterNames: CHAPTER_NAMES, titleOf: _sceneTitle, popupOf: _reportPopupHtml, shots });
      },
    });
  } finally {
    _clearOverlays();
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
    #${CARD_ID} .fsw-dot.is-ch1 { background: rgba(230, 120, 0, 0.28); }
    #${CARD_ID} .fsw-dot.is-ch2 { background: rgba(34, 197, 94, 0.25); }
    #${CARD_ID} .fsw-dot.is-ch3 { background: rgba(245, 158, 11, 0.25); }
    #${CARD_ID} .fsw-dot.is-ch4 { background: rgba(56, 189, 248, 0.25); }
    #${CARD_ID} .fsw-dot.is-ch5 { background: rgba(196, 181, 253, 0.25); }
    #${CARD_ID} .fsw-dot.is-ch1.is-active { background: #E67800; }
    #${CARD_ID} .fsw-dot.is-ch2.is-active { background: #22c55e; }
    #${CARD_ID} .fsw-dot.is-ch3.is-active { background: #f59e0b; }
    #${CARD_ID} .fsw-dot.is-ch4.is-active { background: #38bdf8; }
    #${CARD_ID} .fsw-dot.is-ch5.is-active { background: #c4b5fd; }
    #${CARD_ID} .fsw-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(58px, 1fr)); gap: 3px; }
    #${CARD_ID} .fsw-ramp { display: flex; height: 9px; border-radius: 4px; overflow: hidden; }
    #${CARD_ID} .fsw-ramp i { flex: 1; }
    #${CARD_ID} .fsw-legend-note { margin-top: 4px; font-size: 9px; color: rgba(234, 234, 234, 0.6); display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
    #${CARD_ID} .fsw-ring { display: inline-block; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #f59e0b; }
    #${CARD_ID} .fsw-hl-key i { border: 2px solid #fbbf24; animation: fsw-pulse 0.92s ease-in-out infinite; }
    #${POPUP_ID} .fswp-head.is-ch1 { background: linear-gradient(90deg, rgba(230, 120, 0, 0.42), rgba(200, 1, 0, 0.12)); }
    #${POPUP_ID} .fswp-head.is-ch2 { background: linear-gradient(90deg, rgba(22, 163, 74, 0.42), rgba(245, 158, 11, 0.1)); }
    #${POPUP_ID} .fswp-head.is-ch3 { background: linear-gradient(90deg, rgba(245, 158, 11, 0.4), rgba(22, 163, 74, 0.1)); }
    #${POPUP_ID} .fswp-head.is-ch4 { background: linear-gradient(90deg, rgba(56, 189, 248, 0.38), rgba(22, 163, 74, 0.12)); }
    #${POPUP_ID} .fswp-head.is-ch5 { background: linear-gradient(90deg, rgba(124, 58, 237, 0.36), rgba(230, 120, 0, 0.12)); }
    #${POPUP_ID} .fswp-grid--2 { grid-template-columns: repeat(2, 1fr); }
    #${POPUP_ID} .fswp-grid--3 { grid-template-columns: repeat(3, 1fr); }
    #${POPUP_ID} .fswp-hbars { display: grid; gap: 4px; margin: 4px 0 6px; }
    #${POPUP_ID} .fswp-hbar { display: grid; grid-template-columns: 112px 1fr auto; align-items: center; gap: 7px; font-size: 10.5px; }
    #${POPUP_ID} .fswp-hbar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: rgba(234, 234, 234, 0.85); }
    #${POPUP_ID} .fswp-hbar-track { position: relative; height: 9px; border-radius: 999px; background: rgba(255, 255, 255, 0.07); }
    #${POPUP_ID} .fswp-hbar-track i { display: block; height: 100%; border-radius: 999px; animation: fsw-grow 0.9s ease-out; transform-origin: left; }
    #${POPUP_ID} .fswp-hbar-marker { position: absolute; top: -3px; width: 2px; height: 15px; background: #fff; opacity: 0.85; border-radius: 1px; }
    #${POPUP_ID} .fswp-hbar-value { font-weight: 700; color: #fff; font-variant-numeric: tabular-nums; white-space: nowrap; }
    #${POPUP_ID} .fswp-hbar-value small { font-weight: 500; color: rgba(234, 234, 234, 0.65); }
    #${POPUP_ID} .fswp-steps { display: grid; gap: 4px; font-size: 11px; }
    #${POPUP_ID} .fswp-steps b { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-right: 6px; border-radius: 50%; background: rgba(230, 120, 0, 0.3); color: #fff; font-size: 9.5px; }
    #${POPUP_ID} .fswp-refs { margin-top: 6px; font-size: 9.5px; color: rgba(253, 230, 138, 0.85); font-style: italic; }
    #${POPUP_ID} .fswp-level { display: flex; gap: 3px; margin: 2px 0 8px; }
    #${POPUP_ID} .fswp-level span { flex: 1; text-align: center; padding: 4px 0; border-radius: 6px; font-size: 9.5px; font-weight: 800; color: #fff; opacity: 0.28; }
    #${POPUP_ID} .fswp-level span.is-on { opacity: 1; box-shadow: 0 0 0 2px #fff inset, 0 4px 12px rgba(0, 0, 0, 0.35); animation: fsw-pulse 1.6s ease-in-out infinite; }
    #${POPUP_ID} .fswp-brief { display: grid; gap: 5px; margin: 0 0 8px; font-size: 11px; line-height: 1.45; }
    #${POPUP_ID} .fswp-brief b { display: inline-block; min-width: 104px; margin-right: 6px; color: #fde68a; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.04em; }
    #${POPUP_ID} .fswp-table td.is-down { color: #f87171; }
    #${POPUP_ID} .fswp-table td.is-up { color: #4ade80; }
    #${POPUP_ID} .fswp-table td small.fswp-u { display: block; font-size: 8.5px; color: rgba(234, 234, 234, 0.55); }
    #${POPUP_ID} .fswp-cal td { text-align: center; font-size: 10px; }
    #${POPUP_ID} .fswp-cal td:first-child { text-align: left; }
    #${POPUP_ID} .fswp-cal td.is-sow { background: rgba(34, 197, 94, 0.22); color: #bbf7d0; }
    #${POPUP_ID} .fswp-cal td.is-grow { background: rgba(56, 189, 248, 0.16); color: #bae6fd; }
    #${POPUP_ID} .fswp-cal td.is-harvest { background: rgba(245, 158, 11, 0.24); color: #fde68a; }
    #${POPUP_ID} .fswp-refs-all { margin-top: 8px; font-size: 10px; color: rgba(234, 234, 234, 0.75); }
    #${POPUP_ID} .fswp-refs-all summary { cursor: pointer; font-weight: 700; color: #fde68a; }
    #${POPUP_ID} .fswp-refs-all ol { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 3px; }
`;

// Pure builders, exported for tests.
export const _test = { buildScenes, watchLevel, hotspots, refs: REFS };

// Story picker's Export button: open this briefing in export-only mode.
function _exportFromPicker(format, win) {
  const sel = document.getElementById(SELECT_ID);
  if (!sel || _exporting) { try { if (win && !win.closed) win.close(); } catch (_) {} return false; }
  _state.pendingExport = { format, win };
  sel.value = SENTINEL;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

window.ncopFoodSecurityWatch = {
  closeAll: _closeCompletely,
  exportReport: _exportFromPicker,
};

export function initStoryFoodSecurityWatch() {
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
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initStoryFoodSecurityWatch);
  else initStoryFoodSecurityWatch();
}
