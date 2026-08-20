// ==========================================================================
// story-provincial-forecast.js
// --------------------------------------------------------------------------
// Live Provincial Daily Forecast STORY that appears at the top of the Story
// panel (#story-modal / #story-root) each time the operator toggles the
// Story button.
//
// Mechanics match the existing StoryManager pattern:
//   * Each province is a "chapter" — the story auto-advances through the
//     seven of them on a timer.
//   * On each advance, the map flies to that province's centroid
//     (window.ncop_map.flyTo(...)), so the operator sees the region the
//     forecast text is describing.
//   * Play / Pause / Prev / Next transport buttons + a progress bar
//     showing "3 of 7 · Sindh (auto-advance in 6s)".
//   * Refresh button re-fetches the proxy endpoint (cache-busted).
//
// Data flow (per open):
//     #storyBtn click → #story-modal display flips from none → block
//         → MutationObserver fires → ensure card exists in #story-root
//             → fetch /api/pmd/monitor/daily-forecast-pro/?_=<ts>
//                 → render story shell, start auto-play on chapter 0
//                     → flyTo(0), tick → flyTo(1), tick → …
//
// Zero coupling to StoryManager — card is DOM-injected as the first child
// of #story-root; Story's own dropdown/chapters/editor render below it.
// ==========================================================================

import { getNwfcWeeklyOutlook, getPmdWarnings } from "./gcop-api-cache.js";
import { HAZARD_TYPES } from "./pmd-warnings-filter.js";

const MODAL_ID   = "story-modal";
const ROOT_ID    = "story-root";
const CARD_ID    = "ncop-provincial-forecast";
const STYLE_ID   = "ncop-provincial-forecast-styles";
// #storySelect integration — same injected-option pattern
// story-dynamic-weather.js already uses for its own "Dynamic Weather
// Report" entry, so both cinematic briefings are reached the same way:
// pick from the dropdown, playback starts automatically.
const SELECT_ID  = "storySelect";
const PF_SENTINEL = "__provincial_forecast__";
// Per-item playback timing.  Warning polygons need time to load and the
// operator needs time to read the merged popup — hence longer than the
// pure-outlook cadence.  Sub-chapters (feature focus) get a longer dwell
// than the day overview.
const TICK_MS_OVERVIEW = 10000;   // 10s for the chapter intro (all-polygons view)
const TICK_MS_FOCUS    = 14000;   // 14s per single-warning focus sub-chapter
// TTS-mode dwell = estimated speech duration (below).  Clamped to
// [6s, 75s] so tiny messages don't blip past and pathological long ones
// don't stall forever.
const TICK_MS_TTS_MIN  = 6000;
const TICK_MS_TTS_MAX  = 75000;

// Clean text the same way _speakChapterMessage does, so word-count based
// duration matches what the voice will actually utter.
function _ttsCleanText(raw) {
  return String(raw || "")
    .replace(/\r/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/#{2,}/g, "")
    .replace(/\n+/g, ". ")
    .replace(/\b\d+\.\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Rough estimate of how long the browser will take to speak a message.
// Browser TTS at rate 0.98 ≈ 150 words/min ≈ 400 ms/word.  We use
// 480 ms/word (~20% buffer) + a 1.5s start/end pause allowance so the
// estimate LEANS LONGER than the real utterance — that way progress
// bar + camera orbit almost always finish just before utter.onend fires,
// which triggers the actual chapter advance.
function _estimateTtsMs(item) {
  if (!item || item.type !== "focus") return TICK_MS_FOCUS;
  const clean = _ttsCleanText(item.feature?.properties?.message || "");
  if (!clean) return TICK_MS_FOCUS;
  const words = clean.split(/\s+/).filter(Boolean).length;
  const est = words * 480 + 1500;
  return Math.max(TICK_MS_TTS_MIN, Math.min(TICK_MS_TTS_MAX, est));
}

// Return the target dwell time for the currently-shown playback item.
// When TTS is on for a focus item we return the WORD-COUNT ESTIMATE so
// progress bar + camera orbit pace with the narration.  utter.onend is
// still the authoritative advance signal (below); tick is a safety.
function _currentTickMs() {
  const item = _story.playable[_story.index];
  if (!item) return TICK_MS_OVERVIEW;
  const isFocus = item.type === "focus";
  if (isFocus && _story.ttsEnabled) return _estimateTtsMs(item);
  return isFocus ? TICK_MS_FOCUS : TICK_MS_OVERVIEW;
}

// Approximate centroids + zoom per province.  Values chosen so the
// province fills ~⅔ of the viewport at NCOP's default aspect ratio.
// If a future release adds a real province-boundaries source we could
// derive these from a GeoJSON — for now hardcoded is enough.
const PROVINCE_LOCATIONS = {
  Balochistan: { center: [65.5, 28.5], zoom: 5.5, pitch: 0, bearing: 0 },
  GB:          { center: [74.6, 35.9], zoom: 6.8, pitch: 0, bearing: 0 },
  Islamabad:   { center: [73.1, 33.7], zoom: 9.2, pitch: 0, bearing: 0 },
  Kashmir:     { center: [74.1, 34.0], zoom: 7.5, pitch: 0, bearing: 0 },
  KPk:         { center: [71.6, 34.2], zoom: 6.5, pitch: 0, bearing: 0 },
  Punjab:      { center: [72.7, 30.9], zoom: 5.8, pitch: 0, bearing: 0 },
  Sindh:       { center: [68.9, 26.4], zoom: 5.8, pitch: 0, bearing: 0 },
};

// Country-wide view — used for chapters that mention multiple provinces
// (which is the common case in the weekly outlook narrative).
const COUNTRY_LOCATION = { center: [69.5, 30.5], zoom: 4.6, pitch: 0, bearing: 0 };

// Canonical province titles in a stable display order — used to iterate
// alias tables when scanning outlook text for province mentions.
const PROVINCE_ORDER = ["Balochistan", "GB", "Islamabad", "Kashmir", "KPk", "Punjab", "Sindh"];

// Outlook-narrative-tailored patterns for each PMD warning hazard code.
// These are RICHER than pmd-warnings-filter.js's `patterns` (which target
// the API's short element_label field): here we're scanning free prose
// (e.g. "Rain-wind/thundershower ... heavyfalls"), so we cast a wider net.
// Keys must match HAZARD_TYPES[].code so we can pass the matched codes
// straight into the sidebar filter checkboxes.
const OUTLOOK_HAZARD_PATTERNS = {
  RAINSTORM: ["rainstorm", "torrential rain"],
  HEATWAVE:  ["heatwave", "heat wave", "high temperature", "hot and humid", "hot and dry", "hot weather", "intense heat"],
  CONV:      ["convection", "convective", "severe convection"],
  GALE:      ["gale", "strong wind", "gusty wind"],
  FOG:       ["fog", "visibility", "haze", "mist", "dense fog"],
  HRAIN:     ["heavy rain", "heavy rainfall", "heavyfall", "very heavyfall", "very heavy", "widespread rain", "rain-wind"],
  SNOW:      ["snowstorm", "blizzard", "snowfall", "snow"],
  COLD:      ["cold wave", "cold surge", "cold spell", "severe cold"],
  DUST:      ["dust storm", "dust-storm", "duststorm", "sandstorm"],
  TSTM:      ["thundershower", "thunderstorm", "thundery", "thunderstorms"],
  LTNG:      ["lightning"],
  FLD:       ["flood", "flash flood", "flooding", "urban flooding"],
  HAIL:      ["hail", "hailstorm"],
};

// Compiled { code → HAZARD_TYPES entry } for quick chip-rendering lookups.
// Built once at module load, tiny (13 entries).
const HAZARDS_BY_CODE = Object.fromEntries(
  (HAZARD_TYPES || []).map((h) => [h.code, h])
);

// Deliberate playback order for the Story sub-chapters.  Any hazard NOT in
// this list is skipped during playback; any hazard here that has no
// polygons on a given day is silently omitted.  Reorder freely to change
// the briefing sequence.
const HAZARD_PLAYBACK_ORDER = [
  "HEATWAVE", "RAINSTORM", "CONV", "HRAIN", "TSTM", "LTNG",
  "COLD", "SNOW", "HAIL", "DUST", "FLD", "FOG", "GALE",
];

// Given a feature's properties, return the FIRST HAZARD_TYPES code it
// matches (element short-code first, element_label pattern fallback), or
// null if it belongs to no known hazard.  Mirrors pmd-warnings-filter.js's
// private `#featureMatches` logic so buckets align exactly.
function _hazardCodeForFeature(feature) {
  const p = feature?.properties || {};
  const code  = String(p.element || "").trim().toUpperCase();
  const label = String(p.element_label || p.element_name || p.type || "").trim().toLowerCase();
  for (const h of HAZARD_TYPES) {
    if (code && h.codes.includes(code)) return h.code;
    if (label && h.patterns.some((pat) => label.includes(pat))) return h.code;
  }
  return null;
}

// Walk a GeoJSON geometry, calling cb(lng, lat) for every coordinate pair.
// Cheap iterative implementation — no recursion overhead for arbitrarily
// nested Multi* geometries.
function _walkCoords(geom, cb) {
  if (!geom || !geom.coordinates) return;
  const stack = [geom.coordinates];
  while (stack.length) {
    const arr = stack.pop();
    if (!Array.isArray(arr) || !arr.length) continue;
    if (typeof arr[0] === "number") {
      cb(arr[0], arr[1]);
    } else {
      for (let i = 0; i < arr.length; i++) stack.push(arr[i]);
    }
  }
}

// Compute a [minLng, minLat, maxLng, maxLat] bounding box for an arbitrary
// array of GeoJSON features.  Returns null on empty input or degenerate
// (single-point) bbox.
function _bboxForFeatures(features) {
  if (!features || !features.length) return null;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let found = false;
  for (let i = 0; i < features.length; i++) {
    _walkCoords(features[i].geometry, (x, y) => {
      if (x < bbox[0]) bbox[0] = x;
      if (y < bbox[1]) bbox[1] = y;
      if (x > bbox[2]) bbox[2] = x;
      if (y > bbox[3]) bbox[3] = y;
      found = true;
    });
  }
  if (!found) return null;
  if (bbox[0] === bbox[2] && bbox[1] === bbox[3]) return null;
  return bbox;
}

// FeatureCollection normaliser — the getPmdWarnings() response may arrive
// as a proper FC, a bare feature array, or a wrapped shape.  Small local
// helper avoids importing gcop-monitor-integration.js.
function _toFC(raw) {
  if (!raw) return { type: "FeatureCollection", features: [] };
  if (Array.isArray(raw.features)) return { type: "FeatureCollection", features: raw.features };
  if (Array.isArray(raw)) return { type: "FeatureCollection", features: raw };
  return { type: "FeatureCollection", features: [] };
}

// Parse "29 July, 2026 Wednesday" into an epoch-ms.  Used to sort warnings
// chronologically for playback order within a chapter.  Returns null on
// malformed input.
function _parseChapterDateMs(dateStr) {
  const m = String(dateStr || "").match(/(\d{1,2})\s+(\w+),\s*(\d{4})/);
  if (!m) return null;
  const t = Date.parse(`${m[1]} ${m[2]} ${m[3]}`);
  return Number.isFinite(t) ? t : null;
}

// Extract a YYYY-MM-DD date from an ISO timestamp (or an ISO-shaped
// string).  Timezone-safe compared to Date parsing because it works on
// the raw text — the API emits its timestamps without a TZ suffix and
// midnight-in-local vs midnight-in-UTC could otherwise drift a day.
function _isoDateOnly(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Turn "29 July, 2026 Wednesday" into "2026-07-29" for direct string
// comparison against feature data_time / forecast_time date parts.
const _MONTH_TO_MM = {
  january:"01", february:"02", march:"03", april:"04", may:"05", june:"06",
  july:"07", august:"08", september:"09", october:"10", november:"11", december:"12",
};
function _chapterDateISO(dateStr) {
  const m = String(dateStr || "").match(/(\d{1,2})\s+(\w+),\s*(\d{4})/);
  if (!m) return null;
  const mm = _MONTH_TO_MM[m[2].toLowerCase()];
  if (!mm) return null;
  const dd = String(m[1]).padStart(2, "0");
  return `${m[3]}-${mm}-${dd}`;
}

// Select the warning features that belong to this chapter's briefing.
//
// PRIMARY filters (both must pass):
//   (1) LOCATION — the feature's `message` field must mention at least
//       one alias of a chapter province or an outlook-extracted district.
//       "Belongs to this chapter" = the warning is actually about the
//       places the outlook talks about.
//   (2) DATE — data_time (fallback: forecast_time) within ±36 h of the
//       chapter's day.  Weekly outlook spans a week and warnings are
//       time-bound, so date proximity is what pins a warning to a day.
//
// The chapter's PROSE-extracted hazards (chapter.hazards) are NOT used as
// a filter — earlier attempts to intersect prose hazards ("thundershower")
// with API buckets (TPE / TEM / CONVECTIVE / VIS / UV) dropped most
// features because the two vocabularies don't align.  Instead the hazard
// bucket is derived from the feature ITSELF and stamped as `_hazard_code`
// so the paint expression can colour it and _buildPlaybackList can group
// sub-chapters by hazard type.
//
// Sorted ascending by data_time so the briefing plays in chronological
// order within each hazard bucket.
function _selectWarningFeatures(chapter) {
  if (!_story.warningsFC || !chapter) return [];
  const features = _story.warningsFC.features || [];
  if (!features.length) return [];

  // Location alias list.  Empty = country-wide match (no location filter,
  // accepts any feature).
  const locLower = [];
  for (const p of chapter.provinces || []) {
    const aliases = PROVINCE_ALIASES[p] || [p.toLowerCase()];
    for (const a of aliases) locLower.push(String(a).toLowerCase());
  }
  for (const d of chapter.districts || []) locLower.push(String(d).toLowerCase());
  const hasLocFilter = locLower.length > 0;

  // Chapter's target day as YYYY-MM-DD.  Feature is on-chapter iff its
  // data_time date OR forecast_time date matches this string exactly.
  const chapterDate = _chapterDateISO(chapter.date);

  const matched = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];

    // (1) Location primary — reject if message doesn't mention any target.
    if (hasLocFilter) {
      const msg = String(f.properties?.message || "").toLowerCase();
      if (!msg) continue;
      let hit = false;
      for (let j = 0; j < locLower.length; j++) {
        if (msg.includes(locLower[j])) { hit = true; break; }
      }
      if (!hit) continue;
    }

    // (2) Hazard bucket — only reject if the feature is TRULY unknown
    // (element short-code AND label pattern both fail to match anything
    // in HAZARD_TYPES).  Otherwise the code is used purely as metadata.
    const code = _hazardCodeForFeature(f);
    if (!code) continue;

    // (3) STRICT day match — the warning belongs to this chapter iff
    // its `data_time` date OR its `forecast_time` date matches the
    // chapter's day.  Both API fields matter:
    //   data_time     = when the warning was issued / applies from
    //   forecast_time = when the forecast event is valid
    // Either matching means the warning is relevant to that calendar
    // day.  A warning whose ONLY timestamp is a past/future day gets
    // pinned to that day's chapter — never bleeds into neighbouring
    // days like the old ±36 h window did.
    const dataDate     = _isoDateOnly(f.properties?.data_time);
    const forecastDate = _isoDateOnly(f.properties?.forecast_time);
    if (chapterDate && dataDate !== chapterDate && forecastDate !== chapterDate) {
      continue;
    }

    // Preserve numeric time for sub-chapter sort (forecast_time preferred
    // — that's when the event is happening).
    const t = Date.parse(f.properties?.forecast_time || "") ||
              Date.parse(f.properties?.data_time || "") || 0;
    matched.push({ f, code, t });
  }

  if (!matched.length) return [];

  matched.sort((a, b) => a.t - b.t);
  return matched.map(({ f, code }) => ({
    ...f,
    properties: { ...f.properties, _hazard_code: code },
  }));
}

// ---- Boundary highlight system ----------------------------------------
// Reuses `provincial_boundary` / `district_boundary` sources loaded by the
// map-layers registry.  We add our OWN overlay layers with dedicated ids so
// the user's toggle state is never mutated — pure additive.  On close we
// remove only the overlays; the sources stay for whatever else consumes
// them.
const HL_PROV_LINE_ID = "_ncop_story_hl_prov_line";
const HL_PROV_FILL_ID = "_ncop_story_hl_prov_fill";
const HL_DIST_LINE_ID = "_ncop_story_hl_dist_line";
const HL_DIST_FILL_ID = "_ncop_story_hl_dist_fill";

const PROV_SRC = "provincial_boundary-source";
const DIST_SRC = "district_boundary-source";
const PROV_SRC_LAYER = "provincial_boundary";
const DIST_SRC_LAYER = "district_boundary";

// Property keys that might carry the province name (mirrors
// weather-report-control.js so behaviour matches the rest of the app).
const NAME_KEYS = ["name", "NAME", "province", "province_name", "provincename",
                   "PROVINCE", "PROVINCE_NAME", "admin1", "ADM1_EN", "prov_name",
                   "district", "district_name", "districtname", "DISTRICT", "DISTRICT_NAME"];

// Story-title → canonical GeoServer-boundary aliases (lowercase, matched
// case-insensitively).  These cover the common spellings the GCOP dataset
// tends to use; if the tile uses something else, we fall back gracefully
// to "no match" which just leaves the highlight empty — never breaks.
const PROVINCE_ALIASES = {
  Balochistan: ["balochistan", "baluchistan"],
  GB:          ["gilgit-baltistan", "gilgit baltistan", "gilgit", "gb"],
  Islamabad:   ["islamabad", "ict", "islamabad capital territory", "federal capital"],
  Kashmir:     ["azad jammu and kashmir", "ajk", "kashmir", "azad kashmir", "aj&k"],
  KPk:         ["khyber pakhtunkhwa", "kpk", "kp", "khyber pakhtoonkhwa", "nwfp"],
  Punjab:      ["punjab"],
  Sindh:       ["sindh", "sind"],
};

// Words that look like proper nouns in forecast text but are NOT districts.
// Extracted extensively from the observed PMD payloads.
const DISTRICT_BLACKLIST = new Set([
  "monday","tuesday","wednesday","thursday","friday","saturday","sunday","night",
  "morning","afternoon","evening","today","tomorrow","tonight",
  "mainly","however","partly","cloudy","hot","cold","weather","expected","expect",
  "rain","wind","duststorm","thunderstorm","rainstorm","gustywind","gusty","dust",
  "isolated","places","surroundings","most","few","many","several","during",
  "over","from","with","and","the","prob","province","provinces","districts","district",
  "areas","area","surrounding","north","northern","south","southern","east","eastern",
  "west","western","central","upper","lower",
  // known province aliases (self-filter)
  "balochistan","baluchistan","punjab","sindh","sind","kashmir","islamabad",
  "gilgit","baltistan","gb","kpk","khyber","pakhtunkhwa","ict","pakistan",
]);

let _wired         = false;
let _inFlightFetch = null;

// ---- Runtime story state — reset on each panel-open --------------------
let _story = {
  provinces:    [],     // normalised array from the endpoint
  playable:     [],     // subset with non-empty text (chapters we auto-advance through)
  index:        0,      // pointer into `playable`
  isPlaying:    false,
  tickTimer:    null,   // setTimeout id for the next advance
  progTimer:    null,   // setInterval id for progress-bar animation
  tickStartMs:  0,
  isStale:      false,
  // Highlight lifecycle
  addedDistrictSource: false,   // true if WE called addLayerByKey("district_boundary")
  blinkTimer:   null,
  blinkPhase:   false,
  outlookData:    null,   // raw { days:[...], issue_date } from getNwfcWeeklyOutlook()
  issueDate:      "",     // display string; not used by rendering yet but kept for future header
  warningsFC:     null,   // raw PMD Weather Warnings FeatureCollection (getPmdWarnings)
  currentWarnFeatures: [], // features SELECTED for the current chapter (hazard ∩ location)
  warnHoverPopup: null,   // mapboxgl.Popup used for the polygon hover popup
  warnHoverWired: false,  // hover event listeners installed?
  warnHoverHandlers: null,// { onEnter, onMove, onLeave } — captured for map.off()
  briefingCardEl: null,   // fixed HTML card in #map (chapter briefing surface)
  briefingResizeHandler: null,   // window.resize listener that repositions the card
  cinematicTimer: null,   // setTimeout id for the bearing-orbit kick-off
  hazardEffectActive: null,     // last-applied HAZARD_EFFECTS key, or null
  savedFog: null,               // snapshot of map.getFog() before we override
  ttsEnabled: false,            // operator toggle — auto-speak each focus warning
  ttsSpeakingItem: null,        // playback item currently being spoken (dedupe guard)
  lang: "en",                   // "en" | "ur" — operator toggle for narrative text + TTS language

  // Map popup for the current chapter
  chapterPopup:   null,   // mapboxgl.Popup instance

  // Gate: the outlook no longer auto-fetches/auto-plays the instant the
  // Story panel opens — it shows a Start prompt and waits for an explicit
  // click. Stays true for the rest of the session once started (reopening
  // the panel later resumes normally), so this is a one-time-per-session
  // opt-in, not a repeated interruption.
  started: false,
};


// ---- Styles ------------------------------------------------------------
function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${CARD_ID} {
      margin: -2px 0 12px;
      padding: 12px 14px 12px;
      background: linear-gradient(135deg, rgba(70, 178, 255, 0.16), rgba(70, 178, 255, 0.04));
      border: 1px solid rgba(70, 178, 255, 0.35);
      border-radius: 10px;
      color: #eaeaea;
      font-size: 12.5px;
      line-height: 1.5;
    }
    #${CARD_ID} .pf-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px; margin-bottom: 10px;
    }
    #${CARD_ID} .pf-title {
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.05em;
      color: var(--ndma-blue, #46b2ff);
      text-transform: uppercase;
    }
    #${CARD_ID} .pf-live {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--ndma-blue, #46b2ff);
      box-shadow: 0 0 0 2px rgba(70, 178, 255, 0.30);
      animation: pf-pulse 1.6s ease-in-out infinite;
    }
    @keyframes pf-pulse {
      0%, 100% { opacity: 1;   transform: scale(1); }
      50%      { opacity: 0.55; transform: scale(0.7); }
    }
    #${CARD_ID} .pf-refresh {
      appearance: none;
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 9px;
      font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em;
      color: rgba(234, 234, 234, 0.80);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${CARD_ID} .pf-refresh:hover { background: rgba(70, 178, 255, 0.22); color: #fff; }
    #${CARD_ID} .pf-refresh.is-loading { opacity: 0.55; pointer-events: none; }
    #${CARD_ID} .pf-mute {
      appearance: none; border: none; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      color: rgba(234, 234, 234, 0.65);
      background: rgba(255, 255, 255, 0.06);
      border-radius: 999px;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${CARD_ID} .pf-mute.is-muted { color: rgba(234, 234, 234, 0.35); }
    #${CARD_ID} .pf-mute:hover { background: rgba(70, 178, 255, 0.25); color: #fff; }
    #${CARD_ID} .pf-lang {
      appearance: none;
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 9px;
      font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em;
      color: rgba(234, 234, 234, 0.80);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    #${CARD_ID} .pf-lang:hover { background: rgba(70, 178, 255, 0.22); color: #fff; }
    #${CARD_ID} .pf-lang.is-active { background: rgba(70, 178, 255, 0.30); color: #fff; border-color: rgba(70, 178, 255, 0.5); }
    #${CARD_ID} .pf-lang.is-loading { opacity: 0.55; pointer-events: none; }

    /* ---- Urdu narrative text (RTL + legible script font) ------------ */
    .pf-lang-ur {
      direction: rtl;
      text-align: right;
      font-family: "Noto Nastaliq Urdu", "Segoe UI", Tahoma, "Noto Naskh Arabic", sans-serif;
      font-size: 1.05em;
      line-height: 1.9;
    }

    /* ---- Chapter header (province name + counter) ----------------- */
    #${CARD_ID} .pf-chapter-head {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 10px; margin-bottom: 6px;
    }
    #${CARD_ID} .pf-chapter-title {
      font-size: 15px; font-weight: 700; letter-spacing: 0.01em;
      color: #fff;
    }
    #${CARD_ID} .pf-chapter-counter {
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
      color: rgba(234, 234, 234, 0.65);
      font-variant-numeric: tabular-nums;
      text-transform: uppercase;
    }

    /* ---- Body (forecast text) ------------------------------------- */
    #${CARD_ID} .pf-body {
      max-height: 210px; overflow-y: auto;
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.22);
      border-radius: 6px;
      font-size: 12.5px; line-height: 1.55;
      color: #eaeaea;
      min-height: 68px;
    }
    #${CARD_ID} .pf-body br + br { display: block; margin-top: 4px; }
    #${CARD_ID} .pf-body.is-fading { opacity: 0.35; transition: opacity 0.35s ease; }

    /* ---- Progress bar --------------------------------------------- */
    #${CARD_ID} .pf-progress-track {
      position: relative;
      height: 3px; margin: 10px 0 8px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      overflow: hidden;
    }
    #${CARD_ID} .pf-progress-fill {
      position: absolute; left: 0; top: 0; bottom: 0;
      width: 0%;
      background: var(--ndma-blue, #46b2ff);
      box-shadow: 0 0 8px rgba(70, 178, 255, 0.55);
      transition: width 0.20s linear;
    }
    #${CARD_ID}.is-paused .pf-progress-fill { transition: none; }

    /* ---- Transport row -------------------------------------------- */
    #${CARD_ID} .pf-transport {
      display: flex; align-items: center; gap: 6px;
    }
    #${CARD_ID} .pf-btn {
      appearance: none;
      width: 30px; height: 30px;
      display: inline-flex; align-items: center; justify-content: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      color: #eaeaea;
      cursor: pointer;
      padding: 0;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    #${CARD_ID} .pf-btn:hover { background: rgba(70, 178, 255, 0.22); color: #fff; }
    #${CARD_ID} .pf-btn:disabled { opacity: 0.35; cursor: default; }
    #${CARD_ID} .pf-btn svg { width: 14px; height: 14px; }
    #${CARD_ID} .pf-btn--play {
      width: 34px; height: 34px;
      background: var(--ndma-blue, #46b2ff);
      color: #fff; border-color: rgba(255, 255, 255, 0.35);
      box-shadow: 0 2px 8px rgba(70, 178, 255, 0.35);
      position: relative;
    }
    #${CARD_ID} .pf-btn--play:hover { background: var(--ndma-blue, #46b2ff); filter: brightness(1.12); }
    #${CARD_ID} .pf-btn--play svg { width: 16px; height: 16px; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); }
    #${CARD_ID} .pf-btn--play.pf-btn--play-glyph svg { transform: translate(calc(-50% + 1px), -50%); }
    #${CARD_ID} .pf-hint {
      margin-left: auto;
      font-size: 10.5px; letter-spacing: 0.03em;
      color: rgba(234, 234, 234, 0.55);
      font-variant-numeric: tabular-nums;
    }

    /* ---- Chapter dots (quick jump) --------------------------------- */
    #${CARD_ID} .pf-dots {
      display: flex; flex-wrap: wrap; gap: 4px;
      margin: 10px 0 6px;
    }
    #${CARD_ID} .pf-dot {
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
    #${CARD_ID} .pf-dot:hover { color: #fff; background: rgba(70, 178, 255, 0.14); }
    #${CARD_ID} .pf-dot.is-active {
      color: #fff;
      background: var(--ndma-blue, #46b2ff);
      border-color: rgba(255, 255, 255, 0.35);
    }
    #${CARD_ID} .pf-dot.is-empty { opacity: 0.35; cursor: not-allowed; }

    /* ---- Footer meta ----------------------------------------------- */
    /* Level-colour legend — always visible so the colour-coded pills on
       every warning step (pf-warning-level / nsp-level / the "also active"
       chips) are self-explanatory without hovering anything. Built from
       LEVEL_COLORS itself so it can never drift out of sync with the
       colours actually used elsewhere. */
    #${CARD_ID} .pf-legend {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      margin-top: 8px; padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 10px; color: rgba(234, 234, 234, 0.55);
    }
    #${CARD_ID} .pf-legend-item {
      display: inline-flex; align-items: center; gap: 4px;
    }
    #${CARD_ID} .pf-legend-dot {
      width: 8px; height: 8px; border-radius: 50%;
      flex: 0 0 auto;
    }

    #${CARD_ID} .pf-meta {
      display: flex; justify-content: space-between; align-items: center;
      gap: 8px; margin-top: 8px;
      font-size: 10.5px; color: rgba(234, 234, 234, 0.55);
    }
    #${CARD_ID} .pf-meta .pf-stale {
      display: none; padding: 2px 7px; border-radius: 999px;
      background: rgba(251, 191, 36, 0.20);
      color: #fbbf24; font-weight: 600;
    }
    #${CARD_ID}.is-stale .pf-meta .pf-stale { display: inline-block; }
    #${CARD_ID} .pf-status {
      font-size: 11px; color: rgba(234, 234, 234, 0.60);
      font-style: italic; padding: 6px 0;
    }
    #${CARD_ID} .pf-status.is-error { color: #f87171; font-style: normal; }
    #${CARD_ID} .pf-status {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 4px;
      font-size: 12px; color: rgba(234, 234, 234, 0.85);
      line-height: 1.5;
    }
    #${CARD_ID} .pf-status-spinner {
      width: 14px; height: 14px; flex: 0 0 auto;
      border: 2px solid rgba(70, 178, 255, 0.20);
      border-top-color: var(--ndma-blue, #46b2ff);
      border-radius: 50%;
      animation: pf-spin 0.9s linear infinite;
    }
    @keyframes pf-spin { to { transform: rotate(360deg); } }

    /* ---- Start-briefing prompt (opt-in gate) ----------------------- */
    #${CARD_ID} .pf-start-wrap {
      display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
      padding: 10px 2px 4px;
    }
    #${CARD_ID} .pf-start-copy {
      font-size: 12px; line-height: 1.5;
      color: rgba(234, 234, 234, 0.75);
      margin: 0;
    }
    #${CARD_ID} .pf-start-btn {
      appearance: none; cursor: pointer;
      display: inline-flex; align-items: center; gap: 7px;
      padding: 8px 16px;
      font-size: 12.5px; font-weight: 700; letter-spacing: 0.02em;
      color: #fff;
      background: var(--ndma-blue, #46b2ff);
      border: none; border-radius: 999px;
      transition: filter 0.15s ease;
    }
    #${CARD_ID} .pf-start-btn:hover { filter: brightness(1.12); }
    #${CARD_ID} .pf-start-btn svg { width: 13px; height: 13px; }

    /* ---- Map popup for the current chapter ------------------------ */
    .ncop-story-popup.mapboxgl-popup { max-width: 340px !important; z-index: 5; }
    .ncop-story-popup .mapboxgl-popup-content {
      padding: 0;
      background: linear-gradient(180deg, rgba(20, 20, 30, 0.98), rgba(14, 14, 22, 0.98));
      color: #eaeaea;
      border: 1px solid rgba(70, 178, 255, 0.45);
      border-radius: 10px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55), 0 0 0 3px rgba(70, 178, 255, 0.10);
      overflow: hidden;
      backdrop-filter: blur(4px);
      animation: ncopStoryPopupIn 420ms cubic-bezier(0.22, 1.2, 0.36, 1);
      transform-origin: bottom center;
    }
    .ncop-story-popup .mapboxgl-popup-tip {
      border-top-color: rgba(70, 178, 255, 0.55) !important;
      filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.3));
    }
    .ncop-story-popup .mapboxgl-popup-close-button {
      color: #eaeaea; opacity: 0.7;
      font-size: 18px; line-height: 1;
      padding: 6px 8px;
      transition: opacity 0.15s ease, color 0.15s ease;
    }
    .ncop-story-popup .mapboxgl-popup-close-button:hover { opacity: 1; color: #fff; background: transparent; }

    .ncop-story-popup .nsp-head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      background: linear-gradient(90deg, rgba(70, 178, 255, 0.30), rgba(70, 178, 255, 0.08));
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .ncop-story-popup .nsp-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--ndma-blue, #46b2ff);
      box-shadow: 0 0 0 3px rgba(70, 178, 255, 0.28);
      animation: pf-pulse 1.6s ease-in-out infinite;
      flex: 0 0 auto;
    }
    .ncop-story-popup .nsp-title {
      font-size: 13px; font-weight: 700; letter-spacing: 0.01em;
      color: #fff;
    }
    .ncop-story-popup .nsp-badge {
      margin-left: auto;
      font-size: 10px; font-weight: 600; letter-spacing: 0.05em;
      color: rgba(234, 234, 234, 0.75);
      text-transform: uppercase;
    }
    .ncop-story-popup .nsp-body {
      padding: 10px 12px 12px;
      font-size: 12px; line-height: 1.55;
      color: #eaeaea;
      max-height: 200px; overflow-y: auto;
    }
    .ncop-story-popup .nsp-body br + br { display: block; margin-top: 4px; }
    .ncop-story-popup .nsp-districts {
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 0 12px 10px;
    }
    .ncop-story-popup .nsp-chip {
      font-size: 10.5px; font-weight: 600;
      padding: 2px 8px;
      background: rgba(77, 208, 225, 0.18);
      color: #7fdfec;
      border: 1px solid rgba(77, 208, 225, 0.35);
      border-radius: 999px;
    }
    @keyframes ncopStoryPopupIn {
      from { opacity: 0; transform: scale(0.85) translateY(10px); }
      to   { opacity: 1; transform: scale(1) translateY(0); }
    }
    .ncop-story-popup.is-leaving .mapboxgl-popup-content {
      animation: ncopStoryPopupOut 220ms ease-in forwards;
    }
    @keyframes ncopStoryPopupOut {
      to { opacity: 0; transform: scale(0.92) translateY(4px); }
    }

    /* ---- Merged chapter body (Daily + Extended Outlook) ------------ */
    #${CARD_ID} .pf-body .pf-chapter-section { margin: 0; }
    #${CARD_ID} .pf-body .pf-chapter-section-head {
      display: inline-block;
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
      color: var(--ndma-blue, #46b2ff);
      text-transform: uppercase;
      margin: 2px 0 6px;
      padding: 2px 8px;
      background: rgba(70, 178, 255, 0.10);
      border-left: 2px solid var(--ndma-blue, #46b2ff);
      border-radius: 0 4px 4px 0;
    }
    #${CARD_ID} .pf-body .pf-chapter-section-body {
      font-size: 12.5px; line-height: 1.55; color: #eaeaea;
    }

    /* Popup mirrors card section header so the two surfaces read as one. */
    .ncop-story-popup .nsp-body .pf-chapter-section-head {
      display: inline-block;
      font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
      color: var(--ndma-blue, #46b2ff);
      text-transform: uppercase;
      margin: 2px 0 6px;
      padding: 2px 8px;
      background: rgba(70, 178, 255, 0.14);
      border-left: 2px solid var(--ndma-blue, #46b2ff);
      border-radius: 0 4px 4px 0;
    }

    /* ---- Province chips (mentioned in each day's outlook) --------- */
    #${CARD_ID} .pf-prov-chips {
      display: flex; flex-wrap: wrap; gap: 4px;
      margin-top: 10px;
    }
    #${CARD_ID} .pf-prov-chip {
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.03em;
      padding: 2px 9px;
      background: rgba(255, 209, 102, 0.18);
      color: #ffd166;
      border: 1px solid rgba(255, 209, 102, 0.40);
      border-radius: 999px;
      text-transform: uppercase;
    }
    .ncop-story-popup .nsp-provs {
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 0 12px 6px;
    }
    .ncop-story-popup .nsp-prov-chip {
      font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
      padding: 2px 8px;
      background: rgba(255, 209, 102, 0.20);
      color: #ffd166;
      border: 1px solid rgba(255, 209, 102, 0.40);
      border-radius: 999px;
      text-transform: uppercase;
    }

    /* ---- Hazard chips (PMD Weather Warnings) ------------------------ */
    #${CARD_ID} .pf-hazard-chips {
      display: flex; flex-wrap: wrap; gap: 4px;
      margin-top: 8px;
    }
    #${CARD_ID} .pf-hazard-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 8px 2px 5px;
      font-size: 10px; font-weight: 800; letter-spacing: 0.04em;
      border-radius: 999px;
      text-transform: uppercase;
      color: #fff;
      line-height: 1.4;
      border: 1px solid rgba(0, 0, 0, 0.20);
    }
    #${CARD_ID} .pf-hazard-chip .pf-hazard-chip-label {
      font-size: 10px; font-weight: 600; letter-spacing: 0.01em;
      opacity: 0.95;
      text-transform: none;
    }
    .ncop-story-popup .nsp-hazards {
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 0 12px 6px;
    }
    .ncop-story-popup .pf-hazard-chip--sm {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 2px 7px 2px 5px;
      font-size: 9.5px; font-weight: 800; letter-spacing: 0.04em;
      border-radius: 999px;
      text-transform: uppercase;
      color: #fff;
      line-height: 1.35;
      border: 1px solid rgba(0, 0, 0, 0.20);
    }
    .ncop-story-popup .pf-hazard-chip--sm .pf-hazard-chip-label {
      font-size: 9.5px; font-weight: 600; letter-spacing: 0.01em;
      text-transform: none; opacity: 0.95;
    }

    /* ---- Story warnings — hover popup on the actual polygon --------- */
    .ncop-story-warn-popup.mapboxgl-popup { max-width: 360px !important; z-index: 6; }
    .ncop-story-warn-popup .mapboxgl-popup-content {
      padding: 0;
      background: linear-gradient(180deg, rgba(20, 20, 30, 0.98), rgba(14, 14, 22, 0.98));
      color: #eaeaea;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55);
      overflow: hidden;
      backdrop-filter: blur(4px);
      animation: ncopStoryPopupIn 260ms cubic-bezier(0.22, 1.2, 0.36, 1);
    }
    .ncop-story-warn-popup .mapboxgl-popup-tip { filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.3)); }

    .ncop-story-warn-popup .nswp-head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.10);
      font-weight: 700;
    }
    .ncop-story-warn-popup .nswp-badge {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 34px; height: 20px; padding: 0 6px;
      font-size: 10px; font-weight: 800; letter-spacing: 0.05em;
      background: rgba(255, 255, 255, 0.22); border-radius: 999px;
      text-transform: uppercase;
    }
    .ncop-story-warn-popup .nswp-title {
      flex: 1 1 auto;
      font-size: 12.5px; font-weight: 700; letter-spacing: 0.01em;
    }
    .ncop-story-warn-popup .nswp-level {
      display: inline-flex; align-items: center;
      padding: 2px 8px;
      font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
      background: rgba(255, 255, 255, 0.22); color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.30);
      border-radius: 999px;
      text-transform: uppercase;
    }
    /* Level tint overrides — mimic PMD's blue/yellow/orange/red/tstorm scheme. */
    .ncop-story-warn-popup .nswp-level[data-level="blue"]        { background: rgba(59,130,246,.85); border-color: rgba(59,130,246,1); }
    .ncop-story-warn-popup .nswp-level[data-level="yellow"]      { background: rgba(234,179,8,.90);  border-color: rgba(234,179,8,1);  color: #1f1300; }
    .ncop-story-warn-popup .nswp-level[data-level="orange"]      { background: rgba(249,115,22,.90); border-color: rgba(249,115,22,1); }
    .ncop-story-warn-popup .nswp-level[data-level="red"]         { background: rgba(220,38,38,.92);  border-color: rgba(220,38,38,1);  }
    .ncop-story-warn-popup .nswp-level[data-level="thunderstorm"]{ background: rgba(139,92,246,.90); border-color: rgba(139,92,246,1); }
    .ncop-story-warn-popup .nswp-level[data-level="gust"]        { background: rgba(20,184,166,.90); border-color: rgba(20,184,166,1); }

    .ncop-story-warn-popup .nswp-body {
      padding: 10px 12px 12px;
      max-height: 260px; overflow-y: auto;
      font-size: 12px; line-height: 1.55;
    }
    .ncop-story-warn-popup .nswp-msg {
      margin: 0 0 8px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.05);
      border-left: 3px solid var(--ndma-blue, #46b2ff);
      border-radius: 4px;
      color: #eaeaea;
      font-size: 12px; line-height: 1.55;
      white-space: pre-wrap;
    }
    .ncop-story-warn-popup .nswp-facts {
      display: grid; grid-template-columns: 1fr;
      gap: 4px;
      margin: 0; padding: 0;
      font-size: 11px; color: rgba(234, 234, 234, 0.90);
    }
    .ncop-story-warn-popup .nswp-fact {
      display: grid; grid-template-columns: 82px 1fr;
      gap: 8px; align-items: baseline;
    }
    .ncop-story-warn-popup .nswp-fact dt {
      font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
      color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase; margin: 0;
    }
    .ncop-story-warn-popup .nswp-fact dd {
      margin: 0;
      font-size: 11.5px; color: #eaeaea;
    }

    /* ---- Card body focus-mode (military briefing slide) ------------- */
    #${CARD_ID}.is-focus .pf-body .pf-outlook-context .pf-chapter-section-head {
      background: rgba(255, 255, 255, 0.06);
      color: rgba(234, 234, 234, 0.7);
      border-left-color: rgba(255, 255, 255, 0.3);
    }
    #${CARD_ID}.is-focus .pf-outlook-text-dim {
      opacity: 0.62;
      font-size: 11.5px;
    }
    #${CARD_ID} .pf-chapter-divider {
      height: 1px; margin: 8px 0;
      background: linear-gradient(90deg, transparent, rgba(70, 178, 255, 0.35), transparent);
    }
    #${CARD_ID} .pf-warning-focus {
      margin-top: 4px;
    }
    #${CARD_ID} .pf-warning-head {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px;
      border-radius: 6px;
      margin-bottom: 8px;
      font-weight: 700;
    }
    #${CARD_ID} .pf-warning-badge {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 32px; height: 18px; padding: 0 5px;
      font-size: 10px; font-weight: 800; letter-spacing: 0.05em;
      background: rgba(255, 255, 255, 0.22); border-radius: 999px;
      text-transform: uppercase;
    }
    #${CARD_ID} .pf-warning-title {
      flex: 1 1 auto;
      font-size: 12.5px; font-weight: 700;
    }
    #${CARD_ID} .pf-warning-level {
      display: inline-flex; align-items: center;
      padding: 1px 7px;
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em;
      background: rgba(0, 0, 0, 0.28); color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 999px;
      text-transform: uppercase;
    }
    #${CARD_ID} .pf-warning-msg {
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.22);
      border-left: 3px solid var(--ndma-blue, #46b2ff);
      border-radius: 4px;
      font-size: 12px; line-height: 1.5; color: #eaeaea;
      white-space: pre-wrap;
      max-height: 140px; overflow-y: auto;
    }
    #${CARD_ID} .pf-warning-facts {
      display: grid; gap: 4px;
      margin: 8px 0 0; padding: 0;
      font-size: 11px;
    }
    #${CARD_ID} .pf-fact {
      display: grid; grid-template-columns: 72px 1fr;
      gap: 8px; align-items: baseline;
    }
    #${CARD_ID} .pf-fact dt {
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em;
      color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase; margin: 0;
    }
    #${CARD_ID} .pf-fact dd {
      margin: 0;
      font-size: 11px; color: #eaeaea;
    }

    /* Hazard chips in focus mode — the current hazard is prominent,
       the others dim + slightly desaturated so the operator's eye lands
       on the current threat. */
    #${CARD_ID} .pf-hazard-chip.is-dim {
      opacity: 0.35;
      filter: grayscale(0.4);
    }
    #${CARD_ID} .pf-hazard-chip.is-focus {
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.65),
                  0 0 12px rgba(70, 178, 255, 0.60);
      transform: translateY(-0.5px);
    }

    /* District chips shown in focus body (which districts the polygon
       message names as affected — same names are blinking on the map). */
    #${CARD_ID} .pf-dist-chips {
      display: flex; flex-wrap: wrap; gap: 4px;
      margin-top: 8px;
    }
    #${CARD_ID} .pf-dist-chip {
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em;
      padding: 2px 8px;
      background: rgba(77, 208, 225, 0.14);
      color: #7fdfec;
      border: 1px solid rgba(77, 208, 225, 0.40);
      border-radius: 999px;
    }

    /* "Also active in this area" — same-hazard warnings folded into this
       step instead of getting their own slide (see _buildPlaybackList).
       Shared markup/classes between the fixed card and the map popup;
       each surface just supplies its own chip class for the level pills. */
    #${CARD_ID} .pf-also-warnings,
    .ncop-story-popup .pf-also-warnings {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      margin-top: 8px; padding-top: 8px;
      border-top: 1px dashed rgba(255, 255, 255, 0.15);
    }
    #${CARD_ID} .pf-also-label,
    .ncop-story-popup .pf-also-label {
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em;
      color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase;
    }

    /* Focus-mode CHAPTER popup on the map — swaps the header for the
       hazard-coloured slab and stacks the message + facts below. */
    .ncop-story-popup--focus .mapboxgl-popup-content { max-width: 380px; }
    .ncop-story-popup .nsp-head--focus {
      background: #46b2ff; color: #fff;
      padding: 8px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.10);
    }
    .ncop-story-popup .nsp-head--focus .nsp-badge {
      background: rgba(255, 255, 255, 0.22);
      color: inherit;
      padding: 2px 7px;
      font-size: 10px; font-weight: 800; letter-spacing: 0.04em;
      border-radius: 999px;
      text-transform: uppercase;
    }
    .ncop-story-popup .nsp-head--focus .nsp-title { color: #fff; }
    .ncop-story-popup .nsp-head--focus .nsp-level {
      display: inline-flex; align-items: center;
      padding: 2px 8px;
      font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
      background: rgba(0, 0, 0, 0.28); color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.30);
      border-radius: 999px;
      text-transform: uppercase;
    }
    .ncop-story-popup .nsp-context {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 12px 0;
      font-size: 11px; color: rgba(234, 234, 234, 0.65);
      letter-spacing: 0.03em;
    }
    .ncop-story-popup .nsp-context-date { font-weight: 700; }
    .ncop-story-popup .nsp-focus-msg {
      margin: 8px 12px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.05);
      border-left: 3px solid var(--ndma-blue, #46b2ff);
      border-radius: 4px;
      font-size: 12px; line-height: 1.55; color: #eaeaea;
      white-space: pre-wrap;
      max-height: 180px; overflow-y: auto;
    }
    .ncop-story-popup .nsp-focus-facts {
      display: grid; gap: 3px;
      margin: 0 12px 8px; padding: 0;
      font-size: 11px;
    }
    .ncop-story-popup .nsp-fact {
      display: grid; grid-template-columns: 72px 1fr;
      gap: 8px; align-items: baseline;
    }
    .ncop-story-popup .nsp-fact dt {
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em;
      color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase; margin: 0;
    }
    .ncop-story-popup .nsp-fact dd {
      margin: 0;
      font-size: 11px; color: #eaeaea;
    }

    /* ---- Fixed briefing card in map top-left (never covers Pakistan) --- */
    #ncop-story-briefing.ncop-story-briefing {
      background: linear-gradient(180deg, rgba(20, 20, 30, 0.96), rgba(14, 14, 22, 0.96));
      color: #eaeaea;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55),
                  0 0 0 3px rgba(255, 255, 255, 0.03);
      overflow: hidden;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      font-family: inherit;
      font-size: 12px;
      line-height: 1.5;
    }
    /* Overview mode header — dark slate */
    #ncop-story-briefing[data-mode="overview"] .nsp-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      background: linear-gradient(90deg, rgba(70, 178, 255, 0.30), rgba(70, 178, 255, 0.08));
      border-bottom: 1px solid rgba(255, 255, 255, 0.10);
    }
    #ncop-story-briefing[data-mode="overview"] .nsp-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--ndma-blue, #46b2ff);
      box-shadow: 0 0 0 3px rgba(70, 178, 255, 0.28);
      animation: pf-pulse 1.6s ease-in-out infinite;
    }
    #ncop-story-briefing[data-mode="overview"] .nsp-title {
      flex: 1 1 auto;
      font-size: 13px; font-weight: 700;
      color: #fff;
    }
    #ncop-story-briefing[data-mode="overview"] .nsp-badge {
      margin-left: auto;
      font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
      color: rgba(234, 234, 234, 0.85);
      text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
    }
    #ncop-story-briefing[data-mode="overview"] .nsp-body {
      padding: 10px 12px;
      color: #eaeaea; font-size: 12px; line-height: 1.55;
      max-height: 180px; overflow-y: auto;
    }
    #ncop-story-briefing .nsp-provs,
    #ncop-story-briefing .nsp-hazards,
    #ncop-story-briefing .nsp-districts {
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 0 12px 8px;
    }
    #ncop-story-briefing .nsp-prov-chip {
      font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
      padding: 2px 8px;
      background: rgba(255, 209, 102, 0.20);
      color: #ffd166;
      border: 1px solid rgba(255, 209, 102, 0.40);
      border-radius: 999px;
      text-transform: uppercase;
    }
    #ncop-story-briefing .nsp-chip {
      font-size: 10.5px; font-weight: 600;
      padding: 2px 8px;
      background: rgba(77, 208, 225, 0.18);
      color: #7fdfec;
      border: 1px solid rgba(77, 208, 225, 0.35);
      border-radius: 999px;
    }

    /* Focus mode header — level color takes over */
    #ncop-story-briefing[data-mode="focus"] .nsp-head--focus {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid rgba(0, 0, 0, 0.15);
      font-weight: 700;
      /* background/color inline-styled from JS via _colorForLevel */
    }
    #ncop-story-briefing[data-mode="focus"] .nsp-badge {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 36px; height: 22px;
      padding: 0 8px;
      font-size: 10px; font-weight: 800; letter-spacing: 0.05em;
      border-radius: 999px;
      text-transform: uppercase;
      border: 1px solid rgba(255, 255, 255, 0.18);
    }
    #ncop-story-briefing[data-mode="focus"] .nsp-title {
      flex: 1 1 auto;
      font-size: 14px; font-weight: 800; letter-spacing: 0.01em;
    }
    #ncop-story-briefing[data-mode="focus"] .nsp-level {
      display: inline-flex; align-items: center;
      padding: 3px 9px;
      font-size: 10.5px; font-weight: 800; letter-spacing: 0.06em;
      background: rgba(0, 0, 0, 0.30); color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 999px;
      text-transform: uppercase;
    }
    #ncop-story-briefing .nsp-context {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px 0;
      font-size: 10.5px;
      color: rgba(234, 234, 234, 0.70);
      letter-spacing: 0.03em;
    }
    #ncop-story-briefing .nsp-context-date {
      font-weight: 700; text-transform: uppercase;
    }
    #ncop-story-briefing .nsp-context-ord {
      margin-left: auto;
      font-weight: 700; text-transform: uppercase;
      padding: 1px 8px;
      border-radius: 999px;
      background: rgba(70, 178, 255, 0.14);
      color: var(--ndma-blue, #46b2ff);
      border: 1px solid rgba(70, 178, 255, 0.30);
      font-variant-numeric: tabular-nums;
    }
    #ncop-story-briefing .nsp-context .nsp-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--ndma-blue, #46b2ff);
      box-shadow: 0 0 0 2px rgba(70, 178, 255, 0.28);
      animation: pf-pulse 1.6s ease-in-out infinite;
    }
    #ncop-story-briefing .nsp-focus-msg {
      margin: 8px 12px;
      padding: 9px 11px;
      background: rgba(255, 255, 255, 0.06);
      border-left: 3px solid var(--ndma-blue, #46b2ff);
      border-radius: 4px;
      font-size: 12px; line-height: 1.55; color: #eaeaea;
      white-space: pre-wrap;
      max-height: 180px; overflow-y: auto;
    }
    #ncop-story-briefing .nsp-focus-facts {
      display: grid; gap: 3px;
      margin: 0 12px 8px; padding: 0;
      font-size: 11px;
    }
    #ncop-story-briefing .nsp-fact {
      display: grid; grid-template-columns: 74px 1fr;
      gap: 8px; align-items: baseline;
    }
    #ncop-story-briefing .nsp-fact dt {
      font-size: 9.5px; font-weight: 700; letter-spacing: 0.04em;
      color: rgba(234, 234, 234, 0.55);
      text-transform: uppercase; margin: 0;
    }
    #ncop-story-briefing .nsp-fact dd {
      margin: 0;
      font-size: 11px; color: #eaeaea;
    }

    /* ---- Fact pills (Data time / Forecast / Area) --------------------- */
    #ncop-story-briefing .nsp-facts-row {
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 8px 12px 4px;
    }
    #ncop-story-briefing .nsp-fact-pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 10px;
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em;
      background: rgba(70, 178, 255, 0.14);
      color: #a7d5ff;
      border: 1px solid rgba(70, 178, 255, 0.35);
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    #ncop-story-briefing .nsp-fact-pill[data-fact="data"] {
      background: rgba(167, 139, 250, 0.16); color: #c4b5fd;
      border-color: rgba(167, 139, 250, 0.35);
    }
    #ncop-story-briefing .nsp-fact-pill[data-fact="forecast"] {
      background: rgba(70, 178, 255, 0.16); color: #a7d5ff;
      border-color: rgba(70, 178, 255, 0.35);
    }
    #ncop-story-briefing .nsp-fact-pill[data-fact="area"] {
      background: rgba(74, 222, 128, 0.16); color: #86efac;
      border-color: rgba(74, 222, 128, 0.35);
    }

    /* ---- Rich warning message body ------------------------------------ */
    #ncop-story-briefing .nsp-focus-msg {
      margin: 8px 12px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.05);
      border-left: 3px solid var(--ndma-blue, #46b2ff);
      border-radius: 6px;
      max-height: none;    /* no inner scroll — outer card scrolls if needed */
      overflow: visible;
    }
    #ncop-story-briefing .wm-content { min-width: 0; }
    #ncop-story-briefing .wm-body {
      font-size: 12.5px; line-height: 1.7; color: #eaeaea;
      word-break: normal; overflow-wrap: anywhere;
    }
    /* Highlighted spans inside decorated warning text */
    #ncop-story-briefing .wm-body mark,
    #ncop-story-briefing .wm-advisory-body mark,
    #ncop-story-briefing .wm-advisory-list mark {
      background: rgba(70, 178, 255, 0.16);
      color: #a7d5ff;
      padding: 0 5px;
      border-radius: 3px;
      font-weight: 700;
    }
    #ncop-story-briefing mark.wm-time {
      background: rgba(255, 209, 102, 0.18); color: #ffd166;
    }
    #ncop-story-briefing mark.wm-num {
      background: rgba(74, 222, 128, 0.16); color: #86efac;
    }
    #ncop-story-briefing mark.wm-date {
      background: rgba(167, 139, 250, 0.20); color: #c4b5fd;
    }
    #ncop-story-briefing mark.wm-lvl {
      text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.03em;
      padding: 1px 6px;
    }
    #ncop-story-briefing mark.wm-lvl-red    { background: rgba(220,38,38,.28); color: #fca5a5; }
    #ncop-story-briefing mark.wm-lvl-orange { background: rgba(249,115,22,.28); color: #fdba74; }
    #ncop-story-briefing mark.wm-lvl-yellow { background: rgba(234,179,8,.28);  color: #fde68a; }
    #ncop-story-briefing mark.wm-lvl-blue   { background: rgba(59,130,246,.28); color: #93c5fd; }
    #ncop-story-briefing mark.wm-lvl-thunderstorm { background: rgba(139,92,246,.28); color: #c4b5fd; }
    #ncop-story-briefing mark.wm-lvl-gust   { background: rgba(20,184,166,.28); color: #7fdfec; }

    /* Advisory block */
    #ncop-story-briefing .wm-advisory {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed rgba(255, 255, 255, 0.12);
    }
    #ncop-story-briefing .wm-advisory-head {
      font-size: 11px; font-weight: 800; letter-spacing: 0.04em;
      color: #ffd166; text-transform: uppercase;
      margin-bottom: 6px;
    }
    #ncop-story-briefing .wm-advisory-list {
      list-style: none; margin: 0; padding: 0;
      display: grid; gap: 5px;
    }
    #ncop-story-briefing .wm-advisory-list li {
      position: relative;
      padding: 4px 8px 4px 22px;
      font-size: 12px; line-height: 1.5; color: rgba(234, 234, 234, 0.92);
      background: rgba(255, 209, 102, 0.06);
      border-left: 2px solid rgba(255, 209, 102, 0.45);
      border-radius: 4px;
    }
    #ncop-story-briefing .wm-advisory-list li::before {
      content: "✓";
      position: absolute; left: 8px; top: 4px;
      color: #ffd166; font-weight: 800;
    }
    #ncop-story-briefing .wm-advisory-body {
      font-size: 12px; line-height: 1.5;
      color: rgba(234, 234, 234, 0.92);
      padding: 6px 8px;
      background: rgba(255, 209, 102, 0.06);
      border-left: 2px solid rgba(255, 209, 102, 0.45);
      border-radius: 4px;
    }

    /* ---- Speaker button in focus header ------------------------------- */
    #ncop-story-briefing .nsp-tts-btn {
      appearance: none; border: 1px solid rgba(255, 255, 255, 0.30);
      background: rgba(0, 0, 0, 0.20); color: inherit;
      width: 26px; height: 26px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease;
    }
    #ncop-story-briefing .nsp-tts-btn:hover {
      background: rgba(0, 0, 0, 0.34); transform: scale(1.05);
    }
    #ncop-story-briefing .nsp-tts-btn.is-on {
      background: rgba(255, 255, 255, 0.22);
      color: #fff;
      box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.20), 0 0 12px rgba(70, 178, 255, 0.55);
    }
    #ncop-story-briefing .nsp-tts-btn.is-on svg {
      animation: pf-tts-wave 1.4s ease-in-out infinite;
    }
    @keyframes pf-tts-wave {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.12); }
    }

    /* Narrow viewports: shrink briefing card to fit */
    @media (max-width: 640px) {
      #ncop-story-briefing.ncop-story-briefing {
        width: calc(100% - 24px) !important;
      }
    }

    /* ---- First-open TTS preference prompt ----------------------------- */
    #${CARD_ID} .pf-tts-prompt {
      display: grid; gap: 10px;
      padding: 16px 14px 14px;
      background: linear-gradient(180deg, rgba(70, 178, 255, 0.12), rgba(70, 178, 255, 0.04));
      border: 1px solid rgba(70, 178, 255, 0.35);
      border-radius: 10px;
      text-align: center;
      animation: pf-tts-prompt-in 260ms ease-out;
    }
    @keyframes pf-tts-prompt-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    #${CARD_ID} .pf-tts-prompt-icon {
      font-size: 28px; line-height: 1;
      filter: drop-shadow(0 2px 6px rgba(70, 178, 255, 0.35));
      margin: 4px auto 0;
    }
    #${CARD_ID} .pf-tts-prompt-title {
      font-size: 13px; font-weight: 800; letter-spacing: 0.02em;
      color: #fff;
      text-transform: uppercase;
    }
    #${CARD_ID} .pf-tts-prompt-desc {
      font-size: 11.5px; line-height: 1.5;
      color: rgba(234, 234, 234, 0.80);
      padding: 0 4px;
    }
    #${CARD_ID} .pf-tts-prompt-buttons {
      display: grid; gap: 6px;
      margin-top: 4px;
    }
    #${CARD_ID} .pf-tts-prompt-btn {
      appearance: none; border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.06);
      color: #eaeaea;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px; font-weight: 700; letter-spacing: 0.02em;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
    }
    #${CARD_ID} .pf-tts-prompt-btn:hover {
      background: rgba(255, 255, 255, 0.10);
      transform: translateY(-1px);
    }
    #${CARD_ID} .pf-tts-prompt-btn.is-primary {
      background: var(--ndma-blue, #46b2ff); color: #fff;
      border-color: rgba(255, 255, 255, 0.30);
      box-shadow: 0 4px 12px rgba(70, 178, 255, 0.35);
    }
    #${CARD_ID} .pf-tts-prompt-btn.is-primary:hover {
      background: #5cbdff;
    }
    #${CARD_ID} .pf-tts-prompt-hint {
      font-size: 10px; font-style: italic;
      color: rgba(234, 234, 234, 0.50);
      margin-top: 2px;
    }
  `;
  document.head.appendChild(s);
}


// ---- HTML sanitiser (upstream sends <br> for line breaks) --------------
function _sanitiseFragment(html) {
  if (!html) return "";
  return String(html)
    .replace(/\r\n?/g, "\n")
    .replace(/\n/g, "<br>")
    .replace(/<(?!\/?(?:br|b|strong|em|i|p)\b)[^>]*>/gi, "");
}

// ---- SVG glyphs ---------------------------------------------------------
const ICON_PLAY  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`;
const ICON_PREV  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="19 20 9 12 19 4 19 20"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>`;
const ICON_NEXT  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`;


// ---- DOM helpers --------------------------------------------------------
function _ensureCard(root) {
  let card = root.querySelector(`#${CARD_ID}`);
  if (card) return card;
  card = document.createElement("div");
  card.id = CARD_ID;
  card.innerHTML = `
    <div class="pf-head">
      <div class="pf-title">
        <span class="pf-live" aria-hidden="true"></span>
        <span>7-Day Weather Outlook</span>
      </div>
      <button type="button" class="pf-mute is-muted" aria-label="Enable narration" title="Enable narration">${ICON_TTS_OFF}</button>
      <button type="button" class="pf-lang" aria-label="Switch to Urdu" title="Switch narration to Urdu">اردو</button>
      <button type="button" class="pf-refresh" aria-label="Refresh outlook">Refresh</button>
    </div>
    <div class="pf-chapter-head">
      <div class="pf-chapter-title">—</div>
      <div class="pf-chapter-counter">0 / 0</div>
    </div>
    <div class="pf-body" role="region" aria-live="polite"></div>
    <div class="pf-progress-track"><div class="pf-progress-fill"></div></div>
    <div class="pf-transport">
      <button type="button" class="pf-btn pf-btn--prev" title="Previous day" aria-label="Previous">${ICON_PREV}</button>
      <button type="button" class="pf-btn pf-btn--play pf-btn--play-glyph" title="Play" aria-label="Play">${ICON_PLAY}</button>
      <button type="button" class="pf-btn pf-btn--next" title="Next day" aria-label="Next">${ICON_NEXT}</button>
      <span class="pf-hint">Overview 10s · Warning focus 14s</span>
    </div>
    <div class="pf-dots" role="tablist"></div>
    ${_legendHtml()}
    <div class="pf-meta">
      <span class="pf-source">Source: PMD NWFC · weather.gov.pk</span>
      <span class="pf-stale" title="Serving last-known-good; upstream unavailable">STALE</span>
    </div>
  `;
  root.insertBefore(card, root.firstChild);
  _story.lang = _loadLangPref();
  _bindCardEvents(card);
  _syncLangButton(card);
  return card;
}

// Syncs the header mute button's icon/class/labels to the CURRENT
// _story.ttsEnabled — same pattern story-dynamic-weather.js's own
// .dwr-mute button uses. Called from the button's own click handler and
// from _fetchAndBuild right after ttsEnabled is determined (saved pref,
// or the first-run prompt's answer), since the button's DOM only exists
// from card creation onward and needs an explicit resync at that point.
function _syncMuteButton(card) {
  const m = card?.querySelector(".pf-mute");
  if (!m) return;
  m.classList.toggle("is-muted", !_story.ttsEnabled);
  m.innerHTML = _story.ttsEnabled ? ICON_TTS_ON : ICON_TTS_OFF;
  const label = _story.ttsEnabled ? "Mute narration" : "Enable narration";
  m.setAttribute("aria-label", label);
  m.setAttribute("title", label);
}

// Syncs the header language-toggle button's label/state to the CURRENT
// _story.lang.  Shows "اردو" (a call-to-action to switch TO Urdu) while in
// English, "EN" (switch back) while in Urdu — same on/off pairing pattern
// _syncMuteButton uses for the speaker icon.
function _syncLangButton(card) {
  const b = card?.querySelector(".pf-lang");
  if (!b) return;
  const isUr = _story.lang === "ur";
  b.textContent = isUr ? "EN" : "اردو";
  const label = isUr ? "Switch narration to English" : "Switch narration to Urdu";
  b.setAttribute("aria-label", label);
  b.setAttribute("title", label);
  b.classList.toggle("is-active", isUr);
}

// Toggles the button into/out of a brief loading state while a translate
// request is in flight — reuses the same visual pattern .pf-refresh.is-loading
// already established (dimmed + non-interactive) rather than inventing a
// new spinner.
function _setLangButtonLoading(card, isLoading) {
  const b = card?.querySelector(".pf-lang");
  if (!b) return;
  b.classList.toggle("is-loading", isLoading);
}

function _bindCardEvents(card) {
  const btn = (sel) => card.querySelector(sel);
  btn(".pf-btn--play").addEventListener("click", _togglePlay);
  btn(".pf-btn--prev").addEventListener("click", () => _goto(_story.index - 1, /*byUser*/ true));
  btn(".pf-btn--next").addEventListener("click", () => _goto(_story.index + 1, /*byUser*/ true));
  btn(".pf-mute").addEventListener("click", () => {
    _story.ttsEnabled = !_story.ttsEnabled;
    _saveTtsPref(_story.ttsEnabled ? "on" : "off");
    _syncMuteButton(card);
    if (_story.ttsEnabled) {
      _speakChapterMessage(_story.playable[_story.index]);
    } else {
      _stopSpeaking();
    }
    // TTS state changes _currentTickMs() (TTS on moves the safety cap to
    // the word-count estimate; off returns to the fixed 14s) — restart
    // the tick so the new dwell takes effect immediately.
    if (_story.isPlaying) _startTick(card);
  });
  btn(".pf-lang").addEventListener("click", () => {
    const next = _story.lang === "ur" ? "en" : "ur";
    _story.lang = next;
    _saveLangPref(next);
    _syncLangButton(card);
    // Re-render (and, if narration is on, re-speak) immediately with
    // whatever's already cached (falls back to English via _tr()'s
    // cache-miss no-op) — this also repaints the map popup via
    // _renderChapter → _applyChapterHighlightDay → _showChapterPopup. NOT
    // awaited: translating a full day's worth of warnings on this CPU-only
    // model can take well over a minute (a real 15-item batch measured at
    // ~105s) — blocking here would freeze the story on the current scene
    // with only the button's own loading spinner as feedback.
    // Fire-and-forget instead, silently upgrading (text AND narration)
    // once ready.
    _reapplyCurrentItemLanguage(card);
    if (next === "ur") {
      _ensureUrduTranslations(card).then((ok) => {
        if (ok && _story.lang === "ur") _reapplyCurrentItemLanguage(card);
      }).catch(() => {});
    }
  });
  btn(".pf-refresh").addEventListener("click", () => {
    _story.started = true; // refreshing is an implicit start if it hadn't happened yet
    if (_inFlightFetch) return;
    // An explicit operator-driven refresh should always hit the network,
    // not silently serve the hour-old cache back to them.
    _storyDataCache = null;
    _inFlightFetch = _fetchAndBuild(card).finally(() => { _inFlightFetch = null; });
  });
  // Delegated click on dots for quick-jump.  A dot targets a DAY — we
  // jump to that day's OVERVIEW slot in the playback list (skipping into
  // the middle of another day's sub-chapter run wouldn't make narrative
  // sense).
  card.querySelector(".pf-dots").addEventListener("click", (e) => {
    const dot = e.target.closest(".pf-dot");
    if (!dot) return;
    const dayIdx = Number(dot.dataset.pfDay);
    if (!Number.isFinite(dayIdx)) return;
    const targetItemIdx = _story.playable.findIndex(
      (it) => it.chapterIdx === dayIdx && it.type === "overview"
    );
    if (targetItemIdx >= 0) _goto(targetItemIdx, /*byUser*/ true);
  });
}

// Escape any HTML that comes back from the PMD proxy — the outlook prose
// arrives as plain text so we never want the browser to interpret it.
function _escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


// ---- Rendering helpers --------------------------------------------------
// Dots represent DAYS of the outlook.  Clicking a dot jumps to that day's
// OVERVIEW slide (not into the middle of its sub-chapter sequence).
function _renderDots(card) {
  const chapters = _story.chapters || [];
  const currentItem = _story.playable[_story.index];
  const currentDayIdx = currentItem ? currentItem.chapterIdx : -1;
  card.querySelector(".pf-dots").innerHTML = chapters.map((c, dayIdx) => {
    const label = (c.dow || `Day ${dayIdx + 1}`).slice(0, 3);
    const isSel = dayIdx === currentDayIdx;
    return `
      <button type="button" role="tab"
              class="pf-dot ${isSel ? "is-active" : ""}"
              data-pf-day="${dayIdx}"
              title="${_escapeHtml(c.date)}"
              aria-selected="${isSel}">${_escapeHtml(label)}</button>
    `;
  }).join("");
}

// Count sub-chapters within one day (excluding overview) so the counter can
// show "Warning 2 of 5".
function _subChapterOrdinal(item) {
  if (!item || item.type !== "focus") return { current: 0, total: 0 };
  const dayItems = _story.playable.filter(
    (it) => it.chapterIdx === item.chapterIdx && it.type === "focus"
  );
  return {
    current: dayItems.indexOf(item) + 1,
    total:   dayItems.length,
  };
}

function _renderChapter(card, opts = {}) {
  const item = _story.playable[_story.index];
  if (!item) return;
  const c = item.chapter;
  const titleEl   = card.querySelector(".pf-chapter-title");
  const counterEl = card.querySelector(".pf-chapter-counter");
  const bodyEl    = card.querySelector(".pf-body");
  const totalDays = (_story.chapters || []).length;
  const dayNum    = item.chapterIdx + 1;

  card.classList.toggle("is-focus", item.type === "focus");
  card.classList.toggle("is-overview", item.type === "overview");

  // Title: date; for focus mode append the hazard label.  Counter always
  // shows "Day N / 7" and, when in focus mode, "· Warning K of M".
  if (item.type === "focus") {
    const hazardLabel = item.hazardMeta?.label || item.hazardCode || "Warning";
    titleEl.textContent = `${c.date} · ${hazardLabel}`;
    const ord = _subChapterOrdinal(item);
    counterEl.textContent = `Day ${dayNum} / ${totalDays} · Warning ${ord.current} of ${ord.total}`;
  } else {
    titleEl.textContent   = c.date;
    counterEl.textContent = totalDays > 0 ? `Day ${dayNum} / ${totalDays}` : "—";
  }

  // For overview: currentWarnFeatures = ALL selected features for the day.
  // For focus:    currentWarnFeatures = ONLY this one feature.
  _story.currentWarnFeatures = item.type === "focus"
    ? [item.feature]
    : (c._selectedFeatures || []);

  const bodyHtml = item.type === "focus"
    ? _buildFocusChapterHtml(item)
    : _buildDayChapterHtml(c);
  bodyEl.classList.toggle("pf-lang-ur", _story.lang === "ur");
  if (opts.fade !== false) {
    bodyEl.classList.add("is-fading");
    setTimeout(() => {
      bodyEl.innerHTML = bodyHtml;
      bodyEl.classList.remove("is-fading");
    }, 180);
  } else {
    bodyEl.innerHTML = bodyHtml;
  }

  // Dot active state = whichever day this item belongs to.
  card.querySelectorAll(".pf-dot").forEach((d) => {
    const isSel = Number(d.dataset.pfDay) === item.chapterIdx;
    d.classList.toggle("is-active", isSel);
    d.setAttribute("aria-selected", isSel ? "true" : "false");
  });

  _flyToChapter(item);
  _applyChapterHighlightDay(item);
}

// Camera framing per playback item, in priority order:
//   1. Fit bounds of the current warning polygons — one for focus items,
//      several for overview.  That's what the operator actually needs to
//      see for this slide.
//   2. Fall back to the chapter's single mentioned province centroid.
//   3. Fall back to country-wide when many provinces are mentioned.
// For focus items, we clamp maxZoom higher (10) so a single polygon fills
// the viewport instead of leaving the operator zoomed out.
// Movie-style camera: dramatic parabolic flight to the polygon with pitch,
// then a subtle continuous bearing orbit during the dwell.  Every hop uses
// enforced min-zoom so we always see a real zoom-in (huge polygons like
// the 697 000 km² Gale don't leave us stuck at country-view zoom).
function _flyToChapter(item) {
  try {
    const map = window.ncop_map;
    if (!map || typeof map.flyTo !== "function") return;
    const c = item.chapter || item;
    const isFocus = item.type === "focus";

    // Cancel a leftover orbit-schedule from the prior slide (its
    // setTimeout would otherwise fire mid-new-flyTo and inject an
    // unwanted easeTo).  DO NOT call map.stop() here — that would kill
    // the flyTo we're about to start.
    _stopOrbitOnly();

    const targetPitch  = isFocus ? 55 : 30;      // deeper tilt for focus
    const startBearing = isFocus ? -18 : 0;
    const orbitDelta   = isFocus ? 40 : 0;       // total orbit sweep
    // MIN zoom clamp — for huge polygons (Gale covers all Pakistan)
    // fitBounds gives zoom ~5 which reads as "no zoom".  Force at least
    // a moderate zoom-in so the camera visibly moves in.
    const minZoom      = isFocus ? 6.5 : 5.4;
    const maxZoom      = isFocus ? 10 : 8;
    const flyDuration  = 2600;

    let target = null;
    const bbox = _bboxForFeatures(_story.currentWarnFeatures || []);
    if (bbox) {
      const cam = map.cameraForBounds(
        [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
        { padding: 90, maxZoom }
      );
      if (cam) {
        target = { center: cam.center, zoom: Math.max(minZoom, cam.zoom) };
      } else {
        target = {
          center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2],
          zoom: minZoom + 0.5,
        };
      }
    }
    if (!target) {
      const provs = c.provinces || [];
      const loc = (provs.length === 1 && PROVINCE_LOCATIONS[provs[0]])
        ? PROVINCE_LOCATIONS[provs[0]]
        : COUNTRY_LOCATION;
      target = { center: loc.center, zoom: Math.max(minZoom, loc.zoom) };
    }

    // Curved parabolic flight — Mapbox's `curve` controls how tall the
    // arc is (higher = more of a "zoom-out-then-in" swoop, i.e. movie
    // opening-shot feel).  We omit `speed` so `duration` governs.
    map.flyTo({
      center:   target.center,
      zoom:     target.zoom,
      pitch:    targetPitch,
      bearing:  startBearing,
      duration: flyDuration,
      curve:    1.9,          // dramatic parabolic arc
      easing:   (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,  // ease-in-out cubic
      essential: true,
    });

    if (isFocus) _startCinematicOrbit(map, startBearing, orbitDelta, flyDuration);
  } catch (_) { /* best-effort */ }
}

// Bearing orbit — starts AFTER the flyTo lands (via setTimeout), then
// eases the bearing over the remaining dwell.  Uses cubic easing so the
// orbit accelerates and decelerates smoothly instead of the linear pan
// (which reads as mechanical).
function _startCinematicOrbit(map, startBearing, orbitDelta, flyDurationMs) {
  _stopOrbitOnly();
  const dwellMs = _currentTickMs();
  const orbitMs = Math.max(2500, dwellMs - flyDurationMs - 300);
  _story.cinematicTimer = setTimeout(() => {
    _story.cinematicTimer = null;
    try {
      map.easeTo({
        bearing: startBearing + orbitDelta,
        duration: orbitMs,
        easing: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),   // sine ease in-out
        essential: true,
      });
    } catch (_) { /* best-effort */ }
  }, flyDurationMs);
}

// Clear ONLY the pending orbit-kickoff timer — used when the current
// flyTo is being replaced by a new flyTo (chapter transition).  Does NOT
// call map.stop(), because that would cancel the incoming flyTo too.
function _stopOrbitOnly() {
  if (_story.cinematicTimer) {
    clearTimeout(_story.cinematicTimer);
    _story.cinematicTimer = null;
  }
}

// Full cinematic shutdown — used on panel close.  Cancels both the orbit
// kickoff timer AND any in-progress map animation.
function _stopCinematicLoop() {
  _stopOrbitOnly();
  const map = window.ncop_map;
  if (map && typeof map.stop === "function") {
    try { map.stop(); } catch (_) {}
  }
}

// Chip helpers — reusable across card body & popup surfaces.
function _hazardChipHtml(code, small = false) {
  const h = HAZARDS_BY_CODE[code];
  if (!h) return "";
  const bg = h.badgeBg || "#666";
  const fg = h.badgeText || "#fff";
  const cls = small ? "pf-hazard-chip pf-hazard-chip--sm" : "pf-hazard-chip";
  return `<span class="${cls}" style="background:${bg};color:${fg};" title="${_escapeHtml(h.label)}">${_escapeHtml(h.badge)}<span class="pf-hazard-chip-label">${_escapeHtml(h.label)}</span></span>`;
}

// Compact popup + card body renderer for a DAY chapter (weekly-outlook
// entry).  Shows the narrative text + province chips + auto-selected
// PMD-warning hazard chips (color-matched to their sidebar badges).
function _buildDayChapterHtml(chapter) {
  const text = _sanitiseFragment(_tr(chapter.text));
  const provChips = (chapter.provinces || []).map((p) =>
    `<span class="pf-prov-chip">${_escapeHtml(p)}</span>`
  ).join("");
  const hazChips = (chapter.hazards || []).map((c) => _hazardChipHtml(c, false)).join("");
  return `
    <div class="pf-chapter-section">
      <div class="pf-chapter-section-head">Extended Outlook</div>
      <div class="pf-chapter-section-body">${text}</div>
      ${provChips ? `<div class="pf-prov-chips">${provChips}</div>` : ""}
      ${hazChips  ? `<div class="pf-hazard-chips" title="Active PMD Weather Warnings">${hazChips}</div>` : ""}
    </div>
  `;
}

// Render the "also active here" line for warnings that were folded into
// this step instead of getting their own slide (see _buildPlaybackList's
// per-hazard grouping). `chipClass` lets the two callers (fixed card vs
// map popup) reuse their own existing pill styling instead of new CSS.
function _alsoWarningsHtml(item, chipClass) {
  const also = item.alsoWarnings;
  if (!also || !also.length) return "";
  const meta = item.hazardMeta || HAZARDS_BY_CODE[item.hazardCode] || {};
  const label = _escapeHtml(meta.label || item.hazardCode || "warning");
  const chips = also.map((f) => {
    const lvl = String(f.properties?.level || "").trim();
    if (!lvl) return "";
    const c = _colorForLevel(lvl, meta.badgeBg);
    return `<span class="${chipClass}" style="background:${c.bg};color:${c.fg};border-color:${c.bg};">${_escapeHtml(lvl)}</span>`;
  }).filter(Boolean).join("");
  const n = also.length;
  return `
    <div class="pf-also-warnings">
      <span class="pf-also-label">Also active in this area — ${n} more ${label} ${n === 1 ? "warning" : "warnings"}:</span>
      ${chips}
    </div>
  `;
}

// Focus-mode card body — shrunk outlook context on top, then a prominent
// "Live Warning" block with the feature's own hazard chip, level pill,
// message + facts.  Reads like a briefing slide: context → threat → data.
function _buildFocusChapterHtml(item) {
  const c = item.chapter;
  const f = item.feature || {};
  const p = f.properties || {};
  const hazardCode = item.hazardCode;
  const meta = item.hazardMeta || HAZARDS_BY_CODE[hazardCode] || {};

  const level = String(p.level || "").trim();
  const areaKm2 = p.area_km2 ? Number(p.area_km2) : null;
  const dataTime = _fmtIsoTime(p.data_time);
  const forecastTime = _fmtIsoTime(p.forecast_time);
  const message = _stripPreventionMeasures(_tr(p.message || ""));
  const outlookLine = _sanitiseFragment(_tr(c.text || ""));

  // Focused hazard chip stands out; the day's other hazard chips are dim.
  const hazChips = (c.hazards || []).map((code) => {
    const chip = _hazardChipHtml(code, false);
    if (code === hazardCode) {
      return chip.replace('class="pf-hazard-chip"', 'class="pf-hazard-chip is-focus"');
    }
    return chip.replace('class="pf-hazard-chip"', 'class="pf-hazard-chip is-dim"');
  }).join("");

  const districtChips = (item.featureDistricts || []).slice(0, 12).map((d) =>
    `<span class="pf-dist-chip">${_escapeHtml(d)}</span>`
  ).join("");
  const provinceChips = (item.featureProvinces || []).slice(0, 6).map((pr) =>
    `<span class="pf-prov-chip">${_escapeHtml(pr)}</span>`
  ).join("");

  return `
    <div class="pf-chapter-section pf-outlook-context">
      <div class="pf-chapter-section-head">Weekly Context</div>
      <div class="pf-chapter-section-body pf-outlook-text-dim">${outlookLine}</div>
      ${hazChips ? `<div class="pf-hazard-chips">${hazChips}</div>` : ""}
    </div>
    <div class="pf-chapter-divider" aria-hidden="true"></div>
    <div class="pf-chapter-section pf-warning-focus">
      <div class="pf-warning-head" style="background:${_colorForLevel(level, meta.badgeBg).bg};color:${_colorForLevel(level, meta.badgeBg).fg};">
        <span class="pf-warning-badge" style="background:${meta.badgeBg || "rgba(0,0,0,0.28)"};color:${meta.badgeText || "#fff"};">${_escapeHtml(meta.badge || hazardCode || "!")}</span>
        <span class="pf-warning-title">${_escapeHtml(meta.label || p.element_label || hazardCode || "Warning")}</span>
        ${level ? `<span class="pf-warning-level" data-level="${_escapeHtml(level.toLowerCase())}">${_escapeHtml(level)}</span>` : ""}
      </div>
      ${message ? `<div class="pf-warning-msg">${_escapeHtml(message)}</div>` : ""}
      <dl class="pf-warning-facts">
        ${dataTime     ? `<div class="pf-fact"><dt>Data time</dt><dd>${_escapeHtml(dataTime)}</dd></div>` : ""}
        ${forecastTime ? `<div class="pf-fact"><dt>Forecast</dt><dd>${_escapeHtml(forecastTime)}</dd></div>` : ""}
        ${areaKm2      ? `<div class="pf-fact"><dt>Area</dt><dd>${areaKm2.toLocaleString()} km²</dd></div>` : ""}
      </dl>
      ${provinceChips ? `<div class="pf-prov-chips">${provinceChips}</div>` : ""}
      ${districtChips ? `<div class="pf-dist-chips" title="Affected districts (highlighted on map)">${districtChips}</div>` : ""}
      ${_alsoWarningsHtml(item, "pf-dist-chip")}
    </div>
  `;
}


// ==========================================================================
// Animated chapter popup — a themed Mapbox popup pinned to the current
// chapter's province centroid.  Contains the chapter title + prose, plus
// pills for any extracted district names.  Fades in with a spring-eased
// pop, fades out on chapter change.
// ==========================================================================
// Popup content for a DAY chapter — date + outlook prose + province chips
// + hazard chips (auto-selected PMD warnings) + district chips.
function _overviewPopupHtml(chapter) {
  const bodyHtml = _sanitiseFragment(_tr(chapter.text));
  const provChips = (chapter.provinces || []).map((p) =>
    `<span class="nsp-prov-chip">${_escapeHtml(p)}</span>`
  ).join("");
  const hazChips = (chapter.hazards || []).map((c) => _hazardChipHtml(c, true)).join("");
  const distChips = (chapter.districts || []).slice(0, 10).map((d) =>
    `<span class="nsp-chip">${_escapeHtml(d)}</span>`
  ).join("");
  const distOverflow = (chapter.districts || []).length > 10
    ? `<span class="nsp-chip">+${chapter.districts.length - 10} more</span>` : "";
  return `
    <div class="nsp-head">
      <span class="nsp-dot" aria-hidden="true"></span>
      <span class="nsp-title">${_escapeHtml(chapter.date)}</span>
      <span class="nsp-badge">Weekly Outlook</span>
    </div>
    <div class="nsp-body">${bodyHtml}</div>
    ${provChips ? `<div class="nsp-provs">${provChips}</div>` : ""}
    ${hazChips  ? `<div class="nsp-hazards" title="Active PMD Weather Warnings">${hazChips}</div>` : ""}
    ${distChips || distOverflow ? `<div class="nsp-districts">${distChips}${distOverflow}</div>` : ""}
  `;
}

// Focus popup — merges the day's outlook context (dimmed) with the
// specific feature's message + facts.  Same visual language as the
// hover popup for consistency, but pinned in place (not hover-tracking).
function _focusPopupHtml(item) {
  const c = item.chapter;
  const f = item.feature || {};
  const p = f.properties || {};
  const meta = item.hazardMeta || HAZARDS_BY_CODE[item.hazardCode] || {};
  const level = String(p.level || "").trim();
  const headColor = _colorForLevel(level, meta.badgeBg || "#666");
  const areaKm2 = p.area_km2 ? Number(p.area_km2) : null;
  const dataTime = _fmtIsoTime(p.data_time);
  const forecastTime = _fmtIsoTime(p.forecast_time);
  const richMsgHtml = _buildRichFocusMessage(_tr(p.message || ""), item.hazardCode);
  const provChips = (item.featureProvinces || []).slice(0, 6).map((pr) =>
    `<span class="nsp-prov-chip">${_escapeHtml(pr)}</span>`
  ).join("");
  const distChips = (item.featureDistricts || []).slice(0, 12).map((d) =>
    `<span class="nsp-chip">${_escapeHtml(d)}</span>`
  ).join("");
  const ord = _subChapterOrdinal(item);
  const ttsOn = !!_story.ttsEnabled;
  const ttsIcon = ttsOn ? ICON_TTS_ON : ICON_TTS_OFF;
  const ttsTitle = ttsOn ? "Mute voice briefing" : "Play voice briefing (auto-play on each warning)";

  // Fact pills, styled like the level pill.  Rendered ABOVE the message
  // so the operator sees the key metadata (when + how big) before the
  // narrative prose.
  const factPills = [
    dataTime     ? `<span class="nsp-fact-pill" data-fact="data">📅&nbsp;${_escapeHtml(dataTime)}</span>` : "",
    forecastTime ? `<span class="nsp-fact-pill" data-fact="forecast">📡&nbsp;${_escapeHtml(forecastTime)}</span>` : "",
    areaKm2      ? `<span class="nsp-fact-pill" data-fact="area">📐&nbsp;${areaKm2.toLocaleString()}&nbsp;km²</span>` : "",
  ].filter(Boolean).join("");

  return `
    <div class="nsp-head nsp-head--focus" style="background:${headColor.bg};color:${headColor.fg}">
      <span class="nsp-badge" style="background:${meta.badgeBg || "rgba(0,0,0,0.28)"};color:${meta.badgeText || "#fff"};">${_escapeHtml(meta.badge || item.hazardCode || "!")}</span>
      <span class="nsp-title">${_escapeHtml(meta.label || p.element_label || item.hazardCode || "Warning")}</span>
      ${level ? `<span class="nsp-level" data-level="${_escapeHtml(level.toLowerCase())}">${_escapeHtml(level)}</span>` : ""}
      <button type="button" class="nsp-tts-btn ${ttsOn ? "is-on" : ""}" data-nsp-tts title="${_escapeHtml(ttsTitle)}" aria-pressed="${ttsOn}">${ttsIcon}</button>
    </div>
    <div class="nsp-context">
      <span class="nsp-dot" aria-hidden="true"></span>
      <span class="nsp-context-date">${_escapeHtml(c.date)}</span>
      ${ord.total ? `<span class="nsp-context-ord">Warning ${ord.current} of ${ord.total}</span>` : ""}
    </div>
    ${factPills ? `<div class="nsp-facts-row">${factPills}</div>` : ""}
    ${richMsgHtml ? `<div class="nsp-body nsp-focus-msg">${richMsgHtml}</div>` : ""}
    ${provChips ? `<div class="nsp-provs">${provChips}</div>` : ""}
    ${distChips ? `<div class="nsp-districts">${distChips}</div>` : ""}
    ${_alsoWarningsHtml(item, "nsp-chip")}
  `;
}

// ---- Fixed briefing card ------------------------------------------------
// A DOM overlay pinned to the top-left of the #map container.  Never
// obscures the polygons (which live over Pakistan; the card sits over
// the Afghanistan/Iran side of the viewport).  Same content as the old
// Mapbox popup, but decoupled from the polygon centroid so it never
// competes with the polygon for screen space.
//
// PMD warning severity levels — the header background comes from the
// LEVEL, not the hazard badge colour.  Blue/yellow/orange/red are PMD's
// standard escalation; thunderstorm/gust are the two special severities.
const LEVEL_COLORS = {
  blue:         { bg: "#3b82f6", fg: "#ffffff" },
  yellow:       { bg: "#eab308", fg: "#0f172a" },
  orange:       { bg: "#f97316", fg: "#ffffff" },
  red:          { bg: "#dc2626", fg: "#ffffff" },
  thunderstorm: { bg: "#8b5cf6", fg: "#ffffff" },
  gust:         { bg: "#14b8a6", fg: "#ffffff" },
};

function _colorForLevel(level, fallback) {
  const key = String(level || "").trim().toLowerCase();
  return LEVEL_COLORS[key] || { bg: fallback || "#666", fg: "#ffffff" };
}

// Severity rank derived from LEVEL_COLORS' own declared order (blue <
// yellow < orange < red is PMD's documented escalation; thunderstorm/gust
// sit after red as CONVECTIVE's two special severities — see the comment
// above LEVEL_COLORS). Unknown/missing levels rank lowest so they never
// crowd out a level we can actually grade.
const _LEVEL_RANK = Object.fromEntries(Object.keys(LEVEL_COLORS).map((k, i) => [k, i]));
function _levelRank(feature) {
  const key = String(feature?.properties?.level || "").trim().toLowerCase();
  return _LEVEL_RANK[key] ?? -1;
}

// Do two "<District> in <Province>" location sets (as returned by
// _parseMessageLocations) refer to overlapping geography? District-level
// match wins when both features name districts; falls back to province
// overlap when either side has no district names in its message.
function _locationsOverlap(a, b) {
  if (!a || !b) return false;
  const aDist = new Set((a.districts || []).map((d) => d.toLowerCase()));
  const bDist = new Set((b.districts || []).map((d) => d.toLowerCase()));
  if (aDist.size && bDist.size) {
    for (const d of aDist) if (bDist.has(d)) return true;
    return false;
  }
  const aProv = new Set((a.provinces || []).map((p) => p.toLowerCase()));
  const bProv = new Set((b.provinces || []).map((p) => p.toLowerCase()));
  for (const p of aProv) if (bProv.has(p)) return true;
  return false;
}

// Legend row for the 6 PMD severity levels, generated straight from
// LEVEL_COLORS so it can't fall out of sync with the colours the level
// pills actually use elsewhere in the card/popup.
function _legendHtml() {
  const dots = Object.entries(LEVEL_COLORS).map(([key, c]) => {
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    return `<span class="pf-legend-item"><span class="pf-legend-dot" style="background:${c.bg};"></span>${_escapeHtml(label)}</span>`;
  }).join("");
  return `<div class="pf-legend" title="PMD warning severity levels">${dots}</div>`;
}

// Fixed top offset for the briefing card — chosen (188.2 px) so the card
// starts well below the NCOP header row + its accompanying spacing on
// standard viewport heights.  Kept as a constant instead of measuring
// `.ncop-container` because the header can subtly change size (theme
// toggle icon swap, docs button hover) and produce sub-pixel jitter.
const BRIEFING_CARD_TOP    = 188;
const BRIEFING_CARD_LEFT   = 12;
const BRIEFING_CARD_MARGIN = 12;

function _computeBriefingCardOffset(mapEl) {
  const mapRect = mapEl.getBoundingClientRect();
  const top     = BRIEFING_CARD_TOP;
  const left    = BRIEFING_CARD_LEFT;
  const maxHeight = Math.max(220, mapRect.height - top - BRIEFING_CARD_MARGIN);
  return { top, left, maxHeight };
}

function _positionBriefingCard(card) {
  if (!card) return;
  const mapEl = document.getElementById("map");
  if (!mapEl) return;
  const { top, left, maxHeight } = _computeBriefingCardOffset(mapEl);
  card.style.top    = `${top}px`;
  card.style.left   = `${left}px`;
  card.style.maxHeight = `${maxHeight}px`;
  card.style.overflowY = "auto";
}

function _ensureBriefingCard() {
  if (_story.briefingCardEl && document.body.contains(_story.briefingCardEl)) {
    _positionBriefingCard(_story.briefingCardEl);   // reposition in case header size changed
    return _story.briefingCardEl;
  }
  const mapEl = document.getElementById("map");
  if (!mapEl) return null;
  const card = document.createElement("div");
  card.id = "ncop-story-briefing";
  card.className = "ncop-story-briefing";
  // Absolute-position inside #map so it moves + resizes with the map
  // container.  z-index above the map canvas but below the NCOP header
  // (which is z-50 fixed at top-left) — hence we position BELOW that
  // header rather than compete for the same slot.
  card.style.cssText = `
    position: absolute; z-index: 5;
    width: 380px; max-width: calc(100% - 24px);
    pointer-events: auto;
    opacity: 0; transform: translateY(-8px);
    transition: opacity 0.30s ease, transform 0.30s ease;
  `;
  mapEl.appendChild(card);
  _story.briefingCardEl = card;
  _positionBriefingCard(card);

  // Re-position on resize (debounced) so header wrap changes are followed.
  if (!_story.briefingResizeHandler) {
    let raf = null;
    _story.briefingResizeHandler = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        if (_story.briefingCardEl) _positionBriefingCard(_story.briefingCardEl);
      });
    };
    window.addEventListener("resize", _story.briefingResizeHandler);
  }
  return card;
}

// SVG icons for the speaker button in the focus header
const ICON_TTS_ON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;
const ICON_TTS_OFF = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;

// ---- Hazard-in-polygon simulation (Mapbox v3 setRain/setSnow/setFog) ---
// Maps a hazard code → global weather effect applied while that hazard's
// focus sub-chapter is on screen.  Effects are GLOBAL to the map (Mapbox
// doesn't clip these to polygons) but because focus mode zooms tight on
// the polygon, the effect visually appears "inside" it.  Cleared on
// overview / panel-close so the map returns to its normal look.
// Effect params tuned for VISIBILITY at focus zoom-levels — Mapbox v3's
// rain/snow are global-viewport post-processes, so density + opacity need
// to be aggressive for the effect to read clearly against a busy basemap.
const HAZARD_EFFECTS = {
  RAINSTORM: { kind: "rain", opts: { density: 1.0,  intensity: 1.8, color: "#93a8bd", opacity: 1.0,  "distortion-strength": 0.7, "drop-size": 0.6,  direction: [0, 80],  vignette: 0.55, "vignette-color": "#0f172a", "center-thinning": 0.4 } },
  HRAIN:     { kind: "rain", opts: { density: 0.9,  intensity: 1.5, color: "#93a8bd", opacity: 1.0,  "distortion-strength": 0.55, "drop-size": 0.55, direction: [0, 80],  vignette: 0.5,  "vignette-color": "#0f172a", "center-thinning": 0.35 } },
  TSTM:      { kind: "rain", opts: { density: 1.0,  intensity: 1.9, color: "#7a8899", opacity: 1.0,  "distortion-strength": 0.7,  "drop-size": 0.62, direction: [15, 90], vignette: 0.6,  "vignette-color": "#000000", "center-thinning": 0.4 } },
  CONV:      { kind: "rain", opts: { density: 1.0,  intensity: 2.2, color: "#6a7889", opacity: 1.0,  "distortion-strength": 0.85, "drop-size": 0.7,  direction: [20, 95], vignette: 0.65, "vignette-color": "#000000", "center-thinning": 0.45 } },
  SNOW:      { kind: "snow", opts: { density: 1.0,  intensity: 1.4, color: "#ffffff", opacity: 1.0,  "flake-size": 0.95, direction: [10, 65], vignette: 0.4,  "vignette-color": "#152030", "center-thinning": 0.4 } },
  COLD:      { kind: "snow", opts: { density: 0.5,  intensity: 0.9, color: "#e8f0ff", opacity: 0.9,  "flake-size": 0.6,  direction: [8, 55],  vignette: 0.35 } },
  HAIL:      { kind: "snow", opts: { density: 0.75, intensity: 1.6, color: "#dceaff", opacity: 1.0,  "flake-size": 0.55, direction: [5, 92],  vignette: 0.5 } },
  FOG:       { kind: "fog",  opts: { range: [-1, 2], color: "rgba(220, 220, 230, 0.90)", "horizon-blend": 0.55, "high-color": "rgba(210, 210, 225, 0.75)", "space-color": "rgba(50, 55, 65, 1)", "star-intensity": 0 } },
  DUST:      { kind: "fog",  opts: { range: [-1, 2], color: "rgba(190, 152, 95, 0.85)", "horizon-blend": 0.45, "high-color": "rgba(210, 170, 110, 0.65)", "space-color": "rgba(60, 45, 20, 1)", "star-intensity": 0 } },
  // No visual effect for HEATWAVE / GALE / LTNG / FLD — the polygon fill
  // colour + level pill already carry the signal; adding fake effects
  // would misrepresent the data.
};

function _applyHazardEffect(hazardCode) {
  // Disabled — this mode only needs district blinking + province
  // highlighting (handled entirely separately, via _startBlink and the
  // HL_PROV_*/HL_DIST_* filters — neither goes through this function).
  // Rain/snow/fog polygon-simulation effects below are switched off
  // rather than deleted, so re-enabling later is a one-line revert.
  return;
  // eslint-disable-next-line no-unreachable
  const map = window.ncop_map;
  if (!map) return;
  if (_story.hazardEffectActive === hazardCode) return;
  _clearHazardEffects();
  const effect = HAZARD_EFFECTS[hazardCode];
  if (!effect) { console.log("[story] no visual effect for hazard", hazardCode); return; }

  const doApply = () => {
    try {
      if (effect.kind === "rain") {
        if (typeof map.setRain !== "function") {
          console.warn("[story] map.setRain not available — Mapbox GL JS < 3.7?");
          return;
        }
        map.setRain(effect.opts);
        console.log("[story] setRain applied for", hazardCode, effect.opts);
      } else if (effect.kind === "snow") {
        if (typeof map.setSnow !== "function") {
          console.warn("[story] map.setSnow not available");
          return;
        }
        map.setSnow(effect.opts);
        console.log("[story] setSnow applied for", hazardCode, effect.opts);
      } else if (effect.kind === "fog") {
        if (typeof map.setFog !== "function") {
          console.warn("[story] map.setFog not available");
          return;
        }
        if (_story.savedFog === null) _story.savedFog = map.getFog ? map.getFog() : {};
        map.setFog(effect.opts);
        console.log("[story] setFog applied for", hazardCode);
      }
      _story.hazardEffectActive = hazardCode;
    } catch (e) {
      console.error("[story] hazard effect apply failed:", e);
    }
  };

  // Defer to style.load if the style is still hydrating — otherwise the
  // effect settings can be dropped by the style-loader.
  if (typeof map.isStyleLoaded === "function" && !map.isStyleLoaded()) {
    map.once("style.load", doApply);
  } else {
    doApply();
  }
}

function _clearHazardEffects() {
  const map = window.ncop_map;
  if (!map) return;
  try { if (typeof map.setRain === "function") map.setRain(null); } catch (_) {}
  try { if (typeof map.setSnow === "function") map.setSnow(null); } catch (_) {}
  try {
    if (typeof map.setFog === "function") {
      map.setFog(_story.savedFog || null);
    }
  } catch (_) {}
  _story.savedFog = null;
  _story.hazardEffectActive = null;
}

// ---- Urdu voice selection -----------------------------------------------
// Setting utter.lang alone is NOT enough — the actual voice used is still
// whatever the engine's current DEFAULT voice is unless one is explicitly
// assigned via utter.voice. A default English voice given Arabic-script
// Urdu text silently skips whatever it can't pronounce — in practice that
// means only the embedded Latin numerals get read aloud and the Urdu
// prose itself goes silent. Voices also populate ASYNCHRONOUSLY
// (getVoices() commonly returns [] until the browser's one-time
// 'voiceschanged' event fires, even when a matching voice IS installed) —
// cached eagerly here so a real voice list is already available by the
// time playback starts.
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

// ---- Text-to-speech briefing narrator ---------------------------------
// Uses the browser's SpeechSynthesis API (built-in, no server, no dep).
// Cancels the current utterance every time a new focus sub-chapter is
// shown so the operator never hears two overlapping narrations.  Skips
// on overview / when the operator toggled TTS off.
function _speakChapterMessage(item) {
  const ss = window.speechSynthesis;
  if (!ss) return;
  // Always cancel — even if TTS is off — so a pending utterance from a
  // previous chapter dies with the chapter change.
  try { ss.cancel(); } catch (_) {}
  if (!_story.ttsEnabled) return;
  if (!item || item.type !== "focus") return;
  const raw = _tr(item.feature?.properties?.message || "");
  if (!raw) return;

  // Prep clean prose for speech synthesis: drop numbered-list markers so
  // the voice doesn't read out "One dot... two dot..." and collapse the
  // paragraph structure into a single sentence-flow.
  const speech = String(raw)
    .replace(/\r/g, "")
    .replace(/\n+/g, ". ")
    .replace(/\b\d+\.\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!speech) return;

  const utter = new SpeechSynthesisUtterance(speech);
  utter.rate  = 0.98;
  utter.pitch = 1.0;
  utter.volume = 0.9;
  utter.lang  = _story.lang === "ur" ? "ur-PK" : "en-US";
  if (_story.lang === "ur") {
    const urVoice = _pickUrduVoice();
    if (urVoice) utter.voice = urVoice;
  }
  // TTS drives the pacing: when the narration ends, auto-advance if
  // we're still on the same item AND still playing AND TTS is still
  // enabled.  The auto-tick timer (safety cap 90s) covers the case
  // where onend never fires.
  utter.onend = () => {
    const sameItem = _story.ttsSpeakingItem === item;
    if (sameItem) _story.ttsSpeakingItem = null;
    if (!sameItem) return;
    if (!_story.ttsEnabled) return;
    if (!_story.isPlaying) return;
    // Cancel the safety-tick FIRST so it can't double-fire with our
    // advance below.  The 400ms breath prevents an end-of-utterance
    // jump-cut into the next chapter's flyTo swoop.
    if (_story.tickTimer) { clearTimeout(_story.tickTimer); _story.tickTimer = null; }
    setTimeout(() => {
      if (_story.ttsSpeakingItem == null && _story.ttsEnabled && _story.isPlaying) {
        _goto(_story.index + 1, /*byUser*/ false);
      }
    }, 400);
  };
  utter.onerror = () => { if (_story.ttsSpeakingItem === item) _story.ttsSpeakingItem = null; };
  _story.ttsSpeakingItem = item;
  try { ss.speak(utter); } catch (_) {}
}

function _stopSpeaking() {
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) {}
  _story.ttsSpeakingItem = null;
}

// Re-renders the current item and — if narration is on — re-speaks it too.
// Without this, a translation landing in the background (see
// _ensureUrduTranslations' fire-and-forget call sites) would silently swap
// the on-screen TEXT to Urdu while the voice that already read this item
// stays whatever it said in English, or say nothing at all if narration
// was toggled on mid-wait. _speakChapterMessage already no-ops safely for
// non-"focus" items and always reads whatever's CURRENTLY at _story.index,
// so this is safe to call any time, not just right after a language
// switch. Shared by every background-upgrade call site so an item's text
// and its narration always agree once a translation actually lands.
function _reapplyCurrentItemLanguage(card) {
  _renderChapter(card, { fade: false });
  _speakChapterMessage(_story.playable[_story.index]);
}

// ---- TTS preference persistence ---------------------------------------
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
// Scope is deliberately narrow: only the narrated prose (chapter.text /
// item.feature.properties.message) ever passes through _tr() — buttons,
// hints, legends, and fact-pill labels stay English in both modes. Every
// formatting function downstream of the raw string (_sanitiseFragment,
// _stripPreventionMeasures, _buildRichFocusMessage, etc.) is regex/English-
// word based but degrades gracefully on non-Latin text (no match = pass
// the whole block through unsegmented, no crash, no mangling — verified by
// reading each one), so _tr() only ever needs to swap WHICH string those
// functions receive, never touch their internals.
// ==========================================================================
const LANG_PREF_KEY = "ncop-story-lang-pref"; // shared-by-convention key with
// story-dynamic-weather.js's own toggle, same pattern as TTS_PREF_KEY above
// (neither file imports the other — both just agree on the same string).
function _loadLangPref() {
  try { return localStorage.getItem(LANG_PREF_KEY) === "ur" ? "ur" : "en"; } catch (_) { return "en"; }
}
function _saveLangPref(lang) {
  try { localStorage.setItem(LANG_PREF_KEY, lang); } catch (_) {}
}

// English -> Urdu translations, keyed by the ORIGINAL English string.
// Content-addressed, so it never needs clearing on refresh — the same
// English sentence recurring in a later fetch reuses its cached Urdu.
let _translationCache = new Map();

// Read-time helper — the ONLY thing every call site below wraps around a
// raw narrative-string read. No-ops in English mode; in Urdu mode, returns
// the cached translation or silently falls back to English on a cache miss
// (untranslated-yet or a failed fetch) so the story can never break.
function _tr(text) {
  if (_story.lang !== "ur") return text;
  return _translationCache.get(text) ?? text;
}

// Gathers every distinct narrative string currently loaded — deduplicated.
// Pulls warning messages from the FULL warningsFC feature set (every
// warning the API returned), not just the capped/selected playable-list
// subset (MAX_PER_HAZARD/MAX_PER_CHAPTER can leave warnings out of the
// scripted playback that the operator can still reach by hovering a
// polygon directly — see _showWarningHoverPopup — so those need
// translations cached too).
function _collectNarrativeStrings() {
  const set = new Set();
  (_story.chapters || []).forEach((c) => { if (c.text) set.add(c.text); });
  (_story.warningsFC?.features || []).forEach((f) => {
    const msg = f.properties?.message;
    if (msg) set.add(msg);
  });
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

// Fills in any cache misses for the CURRENTLY loaded data in one shot.
// De-duped against in-flight calls (a second toggle-click while one is
// already running just awaits the same promise). Never throws — resolves
// `false` on failure and leaves the cache as-is, so _tr()'s fallback keeps
// the story showing English for whatever never got translated.
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

// Render an inline preference prompt inside the story panel body and
// resolve when the operator picks a choice.  Called on the FIRST ever
// story open (no saved pref) — subsequent opens read the stored choice
// and skip the prompt.  Returns a promise that resolves to "on" | "off".
function _showTtsPrompt(card) {
  return new Promise((resolve) => {
    const bodyEl = card.querySelector(".pf-body");
    if (!bodyEl) { resolve("off"); return; }
    const prev = bodyEl.innerHTML;
    bodyEl.innerHTML = `
      <div class="pf-tts-prompt" role="dialog" aria-labelledby="pf-tts-prompt-title">
        <div class="pf-tts-prompt-icon" aria-hidden="true">🔊</div>
        <div id="pf-tts-prompt-title" class="pf-tts-prompt-title">Enable Voice Briefing?</div>
        <div class="pf-tts-prompt-desc">
          Have each warning read aloud during the briefing.
          You can toggle it anytime from the speaker button in each chapter.
        </div>
        <div class="pf-tts-prompt-buttons">
          <button type="button" class="pf-tts-prompt-btn is-primary" data-choice="on">
            <span aria-hidden="true">🔊</span>&nbsp;Enable voice briefing
          </button>
          <button type="button" class="pf-tts-prompt-btn" data-choice="off">
            <span aria-hidden="true">🔇</span>&nbsp;Silent mode
          </button>
        </div>
        <div class="pf-tts-prompt-hint">Your choice is remembered for next time.</div>
      </div>
    `;
    const onClick = (e) => {
      const btn = e.target.closest("[data-choice]");
      if (!btn) return;
      bodyEl.removeEventListener("click", onClick);
      const choice = btn.dataset.choice === "on" ? "on" : "off";
      // Restore whatever was in the body before the prompt so the
      // subsequent _renderChapter doesn't have to fight leftover markup.
      bodyEl.innerHTML = prev;
      resolve(choice);
    };
    bodyEl.addEventListener("click", onClick);
  });
}

// Same single-click-resolves pattern _showTtsPrompt uses just above,
// asking English vs Urdu instead. Unlike the TTS prompt (asked once ever,
// remembered forever via savedPref === null), this is shown every time
// _fetchAndBuild actually runs — the very first open AND after every
// manual Refresh, since a plain reopen resumes in place via
// _handlePanelVisible and never reaches _fetchAndBuild at all — so the
// operator is asked "before the story starts" each time there's genuinely
// new data, and the choice holds until the next manual refresh. Pre-
// highlights whichever language was picked last time (defaulting to
// English) so a repeat refresh confirming the same choice is still one
// click.
function _showLangPrompt(card) {
  return new Promise((resolve) => {
    const bodyEl = card.querySelector(".pf-body");
    if (!bodyEl) { resolve("en"); return; }
    const prev = bodyEl.innerHTML;
    const lastChoice = _loadLangPref();
    bodyEl.innerHTML = `
      <div class="pf-tts-prompt" role="dialog" aria-labelledby="pf-lang-prompt-title">
        <div class="pf-tts-prompt-icon" aria-hidden="true">🌐</div>
        <div id="pf-lang-prompt-title" class="pf-tts-prompt-title">Choose a Language</div>
        <div class="pf-tts-prompt-desc">
          Pick the language for this briefing's narrative text and voice narration.
          You can switch anytime from the language button in the header.
        </div>
        <div class="pf-tts-prompt-buttons">
          <button type="button" class="pf-tts-prompt-btn${lastChoice === "en" ? " is-primary" : ""}" data-choice="en">English</button>
          <button type="button" class="pf-tts-prompt-btn${lastChoice === "ur" ? " is-primary" : ""}" data-choice="ur">اردو</button>
        </div>
        <div class="pf-tts-prompt-hint">Your choice holds until you refresh the data.</div>
      </div>
    `;
    const onClick = (e) => {
      const btn = e.target.closest("[data-choice]");
      if (!btn) return;
      bodyEl.removeEventListener("click", onClick);
      const choice = btn.dataset.choice === "ur" ? "ur" : "en";
      bodyEl.innerHTML = prev;
      resolve(choice);
    };
    bodyEl.addEventListener("click", onClick);
  });
}

function _toggleTTS(card) {
  _story.ttsEnabled = !_story.ttsEnabled;
  // Re-render the current chapter so the header button reflects the new
  // pressed state; also trigger speech immediately when enabling.
  const item = _story.playable[_story.index];
  if (card && item && item.type === "focus") {
    card.innerHTML = _focusPopupHtml(item);
    // Re-attach the toggle listener after re-render.
    const btn = card.querySelector("[data-nsp-tts]");
    if (btn) btn.addEventListener("click", (e) => { e.stopPropagation(); _toggleTTS(card); });
  }
  if (_story.ttsEnabled) _speakChapterMessage(item);
  else _stopSpeaking();
  // Reset the tick since TTS state changes _currentTickMs() — TTS on
  // moves the safety cap to 90s; TTS off returns to 14s.
  if (_story.isPlaying) {
    const activeCard = card || document.getElementById(CARD_ID);
    if (activeCard) _startTick(activeCard);
  }
}


function _showChapterPopup(item) {
  const card = _ensureBriefingCard();
  if (!card) return;
  const isFocus = item.type === "focus";
  card.dataset.mode = isFocus ? "focus" : "overview";
  card.classList.toggle("pf-lang-ur", _story.lang === "ur");
  card.innerHTML = isFocus ? _focusPopupHtml(item) : _overviewPopupHtml(item.chapter || item);
  // Wire the speaker toggle on the freshly-rendered header.
  const ttsBtn = card.querySelector("[data-nsp-tts]");
  if (ttsBtn) {
    ttsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      _toggleTTS(card);
    });
  }
  // Fade in.  If already visible, re-render swaps content — the
  // transition triggers only on first show.
  requestAnimationFrame(() => {
    card.style.opacity = "1";
    card.style.transform = "translateY(0)";
  });
  // Apply the polygon-simulation weather effect for this hazard (focus
  // only — overview would confuse the operator by raining "over Pakistan").
  if (isFocus) _applyHazardEffect(item.hazardCode);
  else _clearHazardEffects();
  // Kick off the voice-briefing narration (a silent no-op if TTS is off).
  _speakChapterMessage(item);
}

function _closeChapterPopup(instant = false) {
  const card = _story.briefingCardEl;
  if (!card) return;
  if (instant) {
    card.style.opacity = "0";
    card.style.transform = "translateY(-8px)";
    card.innerHTML = "";
    return;
  }
  card.style.opacity = "0";
  card.style.transform = "translateY(-8px)";
  setTimeout(() => { if (card) card.innerHTML = ""; }, 260);
}

function _removeBriefingCard() {
  if (_story.briefingCardEl) {
    try { _story.briefingCardEl.remove(); } catch (_) {}
  }
  _story.briefingCardEl = null;
  if (_story.briefingResizeHandler) {
    try { window.removeEventListener("resize", _story.briefingResizeHandler); } catch (_) {}
    _story.briefingResizeHandler = null;
  }
}


// ==========================================================================
// Boundary highlight — reuses provincial_boundary + district_boundary
// vector sources; adds our own overlay layers keyed with the `_ncop_story_*`
// prefix so nothing owned by the user's toggle state is mutated.
// ==========================================================================

// Mapbox expression that reads the first non-null value across NAME_KEYS,
// coerces to string, and lowercases it — mirrors the pattern in
// weather-report-control.js so behaviour is consistent.
function _lowerNameExpr() {
  return [
    "downcase",
    ["to-string",
      ["coalesce", ...NAME_KEYS.map((k) => ["get", k]), ""]
    ],
  ];
}

function _matchAnyExpr(candidates) {
  if (!candidates || !candidates.length) return ["has", "___ncop_never___"];
  const unique = Array.from(new Set(candidates.map((s) => String(s).toLowerCase().trim()))).filter(Boolean);
  if (!unique.length) return ["has", "___ncop_never___"];
  // Use `match` — most portable form of set-membership across mapbox-gl
  // versions.  Returns true when the coerced lowercase name equals any
  // alias; false otherwise.
  return ["match", _lowerNameExpr(), unique, true, false];
}

// ---- Lightweight polygon-intersection (no turf dependency) --------------
// @turf/turf is a listed dependency but deliberately unused elsewhere in
// this codebase (see weather-report-control.js's bbox-only comment) —
// matching that convention here rather than pulling turf into this
// module for the first time. Good enough for "should this district also
// blink", not meant as survey-grade geometry.

function _geometryBBox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === "number") {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords) visit(c);
  };
  try { visit(geometry.coordinates); } catch (_) { return null; }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return [minX, minY, maxX, maxY];
}

// Outer ring only (holes ignored) — for a "does this touch that" check,
// treating a donut hole as solid only ever makes us over- rather than
// under-inclusive, which is the safe direction for a blink heuristic.
function _geometryOuterRings(geometry) {
  if (!geometry) return [];
  const { type, coordinates } = geometry;
  if (type === "Polygon" && coordinates?.[0]) return [coordinates[0]];
  if (type === "MultiPolygon") return (coordinates || []).map((poly) => poly[0]).filter(Boolean);
  return [];
}

function _pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function _orientation(p, q, r) {
  const val = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  if (Math.abs(val) < 1e-12) return 0;
  return val > 0 ? 1 : 2;
}
function _onSegment(p, q, r) {
  return Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) &&
         Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
}
function _segmentsIntersect(p1, p2, p3, p4) {
  const o1 = _orientation(p1, p2, p3);
  const o2 = _orientation(p1, p2, p4);
  const o3 = _orientation(p3, p4, p1);
  const o4 = _orientation(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && _onSegment(p1, p3, p2)) return true;
  if (o2 === 0 && _onSegment(p1, p4, p2)) return true;
  if (o3 === 0 && _onSegment(p3, p1, p4)) return true;
  if (o4 === 0 && _onSegment(p3, p2, p4)) return true;
  return false;
}
function _ringsEdgesIntersect(ringA, ringB) {
  for (let i = 0; i < ringA.length - 1; i++) {
    for (let j = 0; j < ringB.length - 1; j++) {
      if (_segmentsIntersect(ringA[i], ringA[i + 1], ringB[j], ringB[j + 1])) return true;
    }
  }
  return false;
}

// bbox reject → vertex-containment either way (catches full containment)
// → edge-crossing either way (catches partial overlap neither vertex set
// falls inside the other for, e.g. a "plus" overlap).
function _geometriesIntersect(geomA, geomB) {
  const bboxA = _geometryBBox(geomA);
  const bboxB = _geometryBBox(geomB);
  if (!bboxA || !bboxB) return false;
  if (bboxA[2] < bboxB[0] || bboxB[2] < bboxA[0] || bboxA[3] < bboxB[1] || bboxB[3] < bboxA[1]) {
    return false;
  }
  const ringsA = _geometryOuterRings(geomA);
  const ringsB = _geometryOuterRings(geomB);
  for (const ringA of ringsA) {
    for (const ringB of ringsB) {
      if (ringA.length && _pointInRing(ringA[0], ringB)) return true;
      if (ringB.length && _pointInRing(ringB[0], ringA)) return true;
      if (_ringsEdgesIntersect(ringA, ringB)) return true;
    }
  }
  return false;
}

function _firstNameProp(feature) {
  const props = feature?.properties || {};
  for (const k of NAME_KEYS) {
    const v = props[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

// One-shot diagnostic — logs the property keys carried by real tiles the
// first time a chapter runs so a property-name mismatch is visible in the
// console instead of silently rendering an empty filter.  Cheap: uses
// `querySourceFeatures` which reads already-loaded tile data.
let _propsProbed = { prov: false, dist: false };
function _probeProps(srcId, srcLayer, label) {
  if (_propsProbed[label]) return;
  const map = window.ncop_map;
  if (!map || !map.getSource(srcId)) return;
  try {
    const feats = map.querySourceFeatures(srcId, { sourceLayer: srcLayer }) || [];
    if (!feats.length) return; // no tiles yet — probe again later
    _propsProbed[label] = true;
  } catch (_) { /* best-effort */ }
}

// Extract candidate district names from a forecast string.  Looks after
// trigger words (in|at|over|across) and pulls out comma / "and" separated
// Capitalized-Word tokens, then filters against the blacklist.
function _extractDistrictNames(text) {
  if (!text || typeof text !== "string") return [];
  // Strip HTML tags/entities so <br> etc don't glue words together.
  const plain = text.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

  const trigger = /\b(?:in|at|over|across)\s+((?:[A-Z][A-Za-z\-]+(?:\s+[A-Z][A-Za-z\-]+)?)(?:(?:\s*,\s*|\s+and\s+|\s*&\s*)[A-Z][A-Za-z\-]+(?:\s+[A-Z][A-Za-z\-]+)?)+)/g;

  const out = new Set();
  let m;
  while ((m = trigger.exec(plain)) !== null) {
    const chunk = m[1];
    // Split on commas / "and" / "&".
    chunk.split(/\s*,\s*|\s+and\s+|\s*&\s*/).forEach((raw) => {
      const token = raw.trim();
      if (!token) return;
      // Reject if any word of the token is blacklisted (drops compound
      // false-positives like "Isolated Places").
      const words = token.split(/\s+/);
      if (words.some((w) => DISTRICT_BLACKLIST.has(w.toLowerCase()))) return;
      // Reject single-letter or overly long tokens (probably parse errors).
      if (token.length < 3 || token.length > 40) return;
      out.add(token);
    });
  }
  return Array.from(out);
}

// Returns a promise that resolves TRUE once the district source is present
// on the map (either it already existed, or the add-request succeeded).
// Awaited by the highlight applier so setFilter never runs before the layer
// exists.
async function _ensureDistrictSource(mustExist) {
  const map = window.ncop_map;
  if (!map) return false;
  if (map.getSource(DIST_SRC)) return true;
  if (!mustExist) return false;
  try {
    const slc = window.sourceLayerControl;
    if (slc && typeof slc.addLayerByKey === "function") {
      const ok = await slc.addLayerByKey("district_boundary", false);
      if (ok) _story.addedDistrictSource = true;
    }
  } catch (_) { /* best-effort */ }
  return !!map.getSource(DIST_SRC);
}

function _ensureOverlayLayers() {
  const map = window.ncop_map;
  if (!map) return;

  // Province overlay (source already loaded at boot by default-layer flow).
  if (map.getSource(PROV_SRC) && !map.getLayer(HL_PROV_LINE_ID)) {
    map.addLayer({
      id: HL_PROV_FILL_ID,
      type: "fill",
      source: PROV_SRC,
      "source-layer": PROV_SRC_LAYER,
      filter: ["has", "___ncop_never___"],
      paint: {
        "fill-color": "#ffd166",
        "fill-opacity": 0.12,
      },
    });
    map.addLayer({
      id: HL_PROV_LINE_ID,
      type: "line",
      source: PROV_SRC,
      "source-layer": PROV_SRC_LAYER,
      filter: ["has", "___ncop_never___"],
      paint: {
        "line-color": "#ffd166",
        "line-width": 3,
        "line-opacity": 1,
        "line-blur": 0.2,
      },
    });
  }

  // District overlay (only added once the source is present).
  if (map.getSource(DIST_SRC) && !map.getLayer(HL_DIST_LINE_ID)) {
    map.addLayer({
      id: HL_DIST_FILL_ID,
      type: "fill",
      source: DIST_SRC,
      "source-layer": DIST_SRC_LAYER,
      filter: ["has", "___ncop_never___"],
      paint: {
        "fill-color": "#ffffff",
        "fill-opacity": 0.18,
      },
    });
    map.addLayer({
      id: HL_DIST_LINE_ID,
      type: "line",
      source: DIST_SRC,
      "source-layer": DIST_SRC_LAYER,
      filter: ["has", "___ncop_never___"],
      paint: {
        "line-color": "#4dd0e1",
        "line-width": 2.5,
        "line-opacity": 1,
      },
    });
  }
}

// Province stays a STATIC highlight (whatever _ensureOverlayLayers set it
// to at creation — line-width 3 / opacity 1) — only the district layer
// blinks now, both its outline (as before) and its white fill (a subtle
// opacity pulse, low enough not to wash out the basemap underneath).
function _startBlink() {
  _stopBlink();
  const map = window.ncop_map;
  if (!map) return;
  _story.blinkPhase = false;
  _story.blinkTimer = setInterval(() => {
    _story.blinkPhase = !_story.blinkPhase;
    const wide = _story.blinkPhase;
    try {
      if (map.getLayer(HL_DIST_LINE_ID)) {
        map.setPaintProperty(HL_DIST_LINE_ID, "line-width", wide ? 4 : 2);
        map.setPaintProperty(HL_DIST_LINE_ID, "line-opacity", wide ? 1 : 0.5);
      }
      if (map.getLayer(HL_DIST_FILL_ID)) {
        map.setPaintProperty(HL_DIST_FILL_ID, "fill-opacity", wide ? 0.28 : 0.10);
      }
    } catch (_) { /* best-effort */ }
  }, 550);
}

function _stopBlink() {
  if (_story.blinkTimer) {
    clearInterval(_story.blinkTimer);
    _story.blinkTimer = null;
  }
}

// Set filters for a DAY chapter — highlights every mentioned province at
// once, plus any districts extracted from the outlook prose.  Awaits any
// async source loads so setFilter never runs against a missing layer.
// Message vocabulary from PMD's warning feed doesn't align with our
// PROVINCE_ALIASES keys — feature messages say "N.W.F.P." (old name for
// KPk), "F.C.T." (Islamabad Capital Territory), "Sind" (older spelling of
// Sindh), "Baluchistan" (variant of Balochistan).  Map each raw token to
// the alias-set of the canonical province so the boundary filter matches.
const MESSAGE_PROVINCE_ALIASES = {
  "azad kashmir":  PROVINCE_ALIASES.Kashmir,
  "kashmir":       PROVINCE_ALIASES.Kashmir,
  "n.w.f.p.":      PROVINCE_ALIASES.KPk,
  "nwfp":          PROVINCE_ALIASES.KPk,
  "khyber pakhtunkhwa": PROVINCE_ALIASES.KPk,
  "kpk":           PROVINCE_ALIASES.KPk,
  "northern areas": PROVINCE_ALIASES.GB,
  "gilgit baltistan": PROVINCE_ALIASES.GB,
  "gilgit-baltistan": PROVINCE_ALIASES.GB,
  "gb":            PROVINCE_ALIASES.GB,
  "punjab":        PROVINCE_ALIASES.Punjab,
  "sind":          PROVINCE_ALIASES.Sindh,
  "sindh":         PROVINCE_ALIASES.Sindh,
  "baluchistan":   PROVINCE_ALIASES.Balochistan,
  "balochistan":   PROVINCE_ALIASES.Balochistan,
  "islamabad":     PROVINCE_ALIASES.Islamabad,
  "f.c.t.":        PROVINCE_ALIASES.Islamabad,
  "fct":           PROVINCE_ALIASES.Islamabad,
  "f.a.t.a.":      PROVINCE_ALIASES.KPk,     // FATA merged into KPk in 2018
  "fata":          PROVINCE_ALIASES.KPk,
};

function _messageProvincesToAliases(rawList) {
  const set = new Set();
  for (const raw of rawList || []) {
    const key = String(raw).toLowerCase().trim();
    const aliases = MESSAGE_PROVINCE_ALIASES[key];
    if (aliases) for (const a of aliases) set.add(a.toLowerCase());
    else set.add(key);   // unknown → still push through as a substring guess
  }
  return Array.from(set);
}

// Districts whose boundary geometry intersects the warning polygon —
// on top of (never instead of) the message-text-derived list. Reads
// whatever district tiles are already cached, with a short poll since
// the district source may have JUST been added for this chapter.
async function _expandDistrictsByGeometry(item, baseDistricts) {
  const warnGeom = item.feature?.geometry;
  if (!warnGeom) return baseDistricts;
  const map = window.ncop_map;
  if (!map) return baseDistricts;

  let feats = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!map.getSource(DIST_SRC)) return baseDistricts;
    feats = map.querySourceFeatures(DIST_SRC, { sourceLayer: DIST_SRC_LAYER }) || [];
    if (feats.length) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!feats.length) return baseDistricts;

  const seen = new Set(baseDistricts.map((d) => d.toLowerCase()));
  const extra = [];
  for (const f of feats) {
    const name = _firstNameProp(f);
    if (!name || seen.has(name.toLowerCase())) continue;
    if (_geometriesIntersect(warnGeom, f.geometry)) {
      seen.add(name.toLowerCase());
      extra.push(name);
    }
  }
  return extra.length ? [...baseDistricts, ...extra] : baseDistricts;
}

async function _applyChapterHighlightDay(item) {
  const map = window.ncop_map;
  if (!map) return;

  const c = item.chapter || item;
  const isFocus = item.type === "focus";

  // For OVERVIEW: highlight the day's mentioned provinces + outlook
  // districts.  For FOCUS: highlight the provinces + districts parsed
  // from THIS specific warning's message ("<District> in <Province>"
  // pairs) so both blinks land on the exact area the current polygon
  // describes — every sub-chapter blinks a different set matching its
  // own feature, instead of the day's shared list.
  const isNonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;
  let provAliases;
  if (isFocus && isNonEmpty(item.featureProvinces)) {
    provAliases = _messageProvincesToAliases(item.featureProvinces);
  } else {
    provAliases = (c.provinces || []).flatMap((p) => PROVINCE_ALIASES[p] || [p.toLowerCase()]);
  }
  const districts = isFocus
    ? (item.featureDistricts || [])
    : (c.districts || []);

  // A focus warning polygon can cover districts the message text never
  // names — geometry expansion below needs the district source loaded
  // even when text-matching alone found nothing.
  const canExpandByGeometry = isFocus && !!item.feature?.geometry;

  await _waitForSource(PROV_SRC, 3000);
  if (districts.length || canExpandByGeometry) await _ensureDistrictSource(true);

  _ensureOverlayLayers();

  if (map.getLayer(HL_PROV_LINE_ID)) {
    if (provAliases.length) {
      const expr = _matchAnyExpr(provAliases);
      map.setFilter(HL_PROV_LINE_ID, expr);
      map.setFilter(HL_PROV_FILL_ID, expr);
    } else {
      map.setFilter(HL_PROV_LINE_ID, ["has", "___ncop_never___"]);
      map.setFilter(HL_PROV_FILL_ID, ["has", "___ncop_never___"]);
    }
  }

  if (map.getLayer(HL_DIST_LINE_ID)) {
    if (districts.length) {
      const expr = _matchAnyExpr(districts);
      map.setFilter(HL_DIST_LINE_ID, expr);
      map.setFilter(HL_DIST_FILL_ID, expr);
    } else {
      map.setFilter(HL_DIST_LINE_ID, ["has", "___ncop_never___"]);
      map.setFilter(HL_DIST_FILL_ID, ["has", "___ncop_never___"]);
    }
  }

  // Districts that geometrically intersect the warning polygon join the
  // blink set shortly after — needs tile data, so it can't land in the
  // same synchronous pass as the text-matched set above. Purely additive:
  // only ever grows the filter, never removes what's already blinking.
  if (canExpandByGeometry) {
    const highlightIndex = _story.index;
    _expandDistrictsByGeometry(item, districts).then((expanded) => {
      if (expanded.length <= districts.length) return;
      if (_story.index !== highlightIndex) return; // moved to another chapter
      if (!map.getLayer(HL_DIST_LINE_ID)) return;
      const expr = _matchAnyExpr(expanded);
      map.setFilter(HL_DIST_LINE_ID, expr);
      map.setFilter(HL_DIST_FILL_ID, expr);
    }).catch(() => {});
  }

  _startBlink();

  // Push the current-slide feature set to our story-owned overlay.
  // currentWarnFeatures was already set by _renderChapter (single feature
  // for focus, all-for-day for overview).
  _applyChapterWarningsOverlay();

  // Themed animated popup — different shape for focus vs overview.
  requestAnimationFrame(() => _showChapterPopup(item));

  // One-shot property probe once real tiles arrive.
  setTimeout(() => {
    _probeProps(PROV_SRC, PROV_SRC_LAYER, "prov");
    if (map.getSource(DIST_SRC)) _probeProps(DIST_SRC, DIST_SRC_LAYER, "dist");
  }, 1200);
}

// Wait up to `timeoutMs` for a source to exist on the map.  Polls every
// 100 ms — cheap for the small windows we're waiting on.  Resolves TRUE
// if the source appears, FALSE on timeout.
function _waitForSource(srcId, timeoutMs) {
  return new Promise((resolve) => {
    const map = window.ncop_map;
    if (!map) return resolve(false);
    if (map.getSource(srcId)) return resolve(true);
    const start = performance.now();
    const iv = setInterval(() => {
      if (map.getSource(srcId)) { clearInterval(iv); resolve(true); }
      else if (performance.now() - start > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 100);
  });
}

function _teardownHighlight() {
  _stopBlink();
  _closeChapterPopup(/*instant*/ false);
  const map = window.ncop_map;
  if (!map) return;
  [HL_PROV_FILL_ID, HL_PROV_LINE_ID, HL_DIST_FILL_ID, HL_DIST_LINE_ID].forEach((id) => {
    try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
  });
  // Only pull the district source if WE added it.  Users who had it toggled
  // on before opening the story keep their choice.
  if (_story.addedDistrictSource) {
    try {
      const slc = window.sourceLayerControl;
      if (slc && typeof slc.removeLayerByKey === "function") {
        slc.removeLayerByKey("district_boundary", false);
      }
    } catch (_) {}
    _story.addedDistrictSource = false;
  }
}


// ---- Playback ----------------------------------------------------------
function _clearTimers() {
  if (_story.tickTimer) { clearTimeout(_story.tickTimer);  _story.tickTimer = null; }
  if (_story.progTimer) { clearInterval(_story.progTimer); _story.progTimer = null; }
}

function _updateProgress(card) {
  const fill = card.querySelector(".pf-progress-fill");
  if (!fill) return;
  if (!_story.isPlaying) return;
  const elapsed = performance.now() - _story.tickStartMs;
  const pct = Math.max(0, Math.min(100, (elapsed / _currentTickMs()) * 100));
  fill.style.width = `${pct}%`;
}

function _setPlayGlyph(card, playing) {
  const btn = card.querySelector(".pf-btn--play");
  if (!btn) return;
  btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  btn.classList.toggle("pf-btn--play-glyph", !playing);   // optical nudge for play only
  btn.title = playing ? "Pause" : "Play";
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function _play() {
  const card = document.getElementById(CARD_ID);
  if (!card || _story.playable.length < 2) return;
  _story.isPlaying = true;
  card.classList.remove("is-paused");
  _setPlayGlyph(card, true);
  _startTick(card);
}

function _pause() {
  const card = document.getElementById(CARD_ID);
  _story.isPlaying = false;
  _clearTimers();
  if (card) {
    card.classList.add("is-paused");
    _setPlayGlyph(card, false);
  }
}

function _togglePlay() {
  if (_story.isPlaying) _pause();
  else _play();
}

function _startTick(card) {
  _clearTimers();
  _story.tickStartMs = performance.now();
  const fill = card.querySelector(".pf-progress-fill");
  if (fill) fill.style.width = "0%";
  _story.progTimer = setInterval(() => _updateProgress(card), 100);
  const dwell = _currentTickMs();
  // Advance handler with a TTS-aware guard: if the estimate expires
  // slightly before the browser voice actually finishes (rare — estimate
  // has ~20 % buffer, but can happen), re-schedule in 2s chunks and
  // check again.  utter.onend is still the authoritative primary
  // advance signal — this is only a fallback / safety.
  //
  // Chrome's speechSynthesis has a well-documented failure mode where
  // rapid cancel()+speak() calls (exactly what happens on every chapter
  // change — see _speakChapterMessage) can leave speaking/pending wedged
  // true forever, so onend never fires again for any future utterance.
  // Before this cap, that meant this retry loop span forever — the
  // "gets stuck on a specific step and the page becomes unresponsive"
  // symptom, since nothing else was wrong except this one signal never
  // arriving. MAX_SPEECH_RETRIES × 2s ≈ 24s of extra grace beyond the
  // already-generous initial estimate before giving up on TTS for this
  // step and force-advancing anyway.
  const MAX_SPEECH_RETRIES = 12;
  let speechRetries = 0;
  const advanceOrRecheck = () => {
    _story.tickTimer = null;
    const stillSpeaking = _story.ttsEnabled
      && window.speechSynthesis
      && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
    if (stillSpeaking && speechRetries < MAX_SPEECH_RETRIES) {
      speechRetries += 1;
      _story.tickTimer = setTimeout(advanceOrRecheck, 2000);
      return;
    }
    if (stillSpeaking) {
      // Retry budget exhausted — the synthesis engine is presumed wedged
      // rather than genuinely still narrating. Force it quiet so it can't
      // keep blocking every subsequent chapter's advance the same way.
      console.warn("[story] speechSynthesis appears stuck — forcing advance");
      _stopSpeaking();
    }
    _goto(_story.index + 1, /*byUser*/ false);
  };
  _story.tickTimer = setTimeout(advanceOrRecheck, dwell);
}

function _goto(rawIdx, byUser) {
  if (!_story.playable.length) return;
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  // Wrap around — cyclic story.
  const n = _story.playable.length;
  _story.index = ((rawIdx % n) + n) % n;
  _renderChapter(card);
  // User-driven prev/next also pauses (operator wants to read at their own pace)…
  // …UNLESS play was on AND the click was our auto-tick (byUser=false).
  if (_story.isPlaying) {
    if (byUser) {
      // Restart the tick from the new index so the timer isn't half-elapsed.
      _startTick(card);
    } else {
      _startTick(card);
    }
  }
}


// ---- Fetch + build -----------------------------------------------------
function _renderStatus(card, msg, isError) {
  const spinner = isError ? "" : `<span class="pf-status-spinner" aria-hidden="true"></span>`;
  card.querySelector(".pf-body").innerHTML =
    `<div class="pf-status ${isError ? "is-error" : ""}">${spinner}<span>${_escapeHtml(msg)}</span></div>`;
  card.querySelector(".pf-dots").innerHTML = "";
  card.querySelector(".pf-chapter-title").textContent = isError ? "Error" : "Loading…";
  card.querySelector(".pf-chapter-counter").textContent = "";
  card.querySelector(".pf-progress-fill").style.width = "0%";
}

// Opt-in gate — the outlook used to auto-fetch/auto-play the instant the
// Story panel opened; it now waits here for an explicit click so it
// doesn't compete for attention with whatever else the operator opened
// the panel to look at (e.g. picking Dynamic Weather Report right away).
function _renderStartPrompt(card) {
  card.querySelector(".pf-chapter-title").textContent = "7-Day Weather Outlook";
  card.querySelector(".pf-chapter-counter").textContent = "";
  card.querySelector(".pf-dots").innerHTML = "";
  card.querySelector(".pf-progress-fill").style.width = "0%";
  card.querySelector(".pf-body").innerHTML = `
    <div class="pf-start-wrap">
      <p class="pf-start-copy">PMD weather warnings, station highlights, and daily narration for the week ahead.</p>
      <button type="button" class="pf-start-btn">${ICON_PLAY}<span>Start Briefing</span></button>
    </div>
  `;
  const btn = card.querySelector(".pf-start-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      _story.started = true;
      if (_inFlightFetch) return;
      _inFlightFetch = _fetchAndBuild(card).finally(() => { _inFlightFetch = null; });
    }, { once: true });
  }
}

// Scan free-text prose for province mentions using our PROVINCE_ALIASES
// table (case-insensitive substring match).  Returns canonical province
// titles (Balochistan, GB, Islamabad, Kashmir, KPk, Punjab, Sindh) in
// PROVINCE_ORDER so the highlight order is deterministic.
function _mentionedProvincesIn(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return [];
  const hits = new Set();
  PROVINCE_ORDER.forEach((title) => {
    const aliases = PROVINCE_ALIASES[title] || [];
    if (aliases.some((a) => lower.includes(a))) hits.add(title);
  });
  return PROVINCE_ORDER.filter((t) => hits.has(t));
}

// Scan outlook prose for hazard mentions using OUTLOOK_HAZARD_PATTERNS.
// Returns an array of HAZARD_TYPES codes (RAINSTORM, HRAIN, TSTM, …) in
// stable HAZARD_TYPES order.
function _extractHazardCodesFrom(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return [];
  const hits = new Set();
  for (const h of HAZARD_TYPES) {
    const patterns = OUTLOOK_HAZARD_PATTERNS[h.code] || [];
    if (patterns.some((p) => lower.includes(p))) hits.add(h.code);
  }
  return HAZARD_TYPES.filter((h) => hits.has(h.code)).map((h) => h.code);
}

// Turn each weekly-outlook day into a story chapter.  Chapter shape:
//   { id, date, dow, text, provinces:[...], districts:[...], hazards:[...] }
function _buildChaptersFromOutlook(outlookData) {
  const days = Array.isArray(outlookData?.days) ? outlookData.days : [];
  // Local-calendar YYYY-MM-DD for "today" — PMD outlook dates are Pakistan
  // local calendar dates, so we compare on local YYYY-MM-DD strings rather
  // than epoch-ms (avoids off-by-one drift when the browser is in a
  // different timezone from the data source).
  const now = new Date();
  const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return days.map((d, i) => {
    const dateStr = String(d?.date || "").trim();
    // "29 July, 2026 Wednesday" → dow = "Wednesday"; abbreviate to 3 chars
    // for the dot label.
    const dowMatch = dateStr.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
    const dow = dowMatch ? dowMatch[1] : `Day ${i + 1}`;
    const text = String(d?.outlook || "").replace(/&nbsp;/g, " ").trim();
    return {
      id:        `day${i}`,
      date:      dateStr || `Day ${i + 1}`,
      dow:       dow,
      text:      text,
      provinces: _mentionedProvincesIn(text),
      districts: _extractDistrictNames(text),
      hazards:   _extractHazardCodesFrom(text),
    };
  })
    .filter((c) => c.text)      // drop days with no narrative
    .filter((c) => {
      // Drop days whose calendar date is strictly before today.  Today
      // itself is kept — the outlook for the current day is still
      // actionable.  A chapter whose date string doesn't parse is kept
      // (better to show an ambiguous day than silently disappear it).
      const iso = _chapterDateISO(c.date);
      return !iso || iso >= todayISO;
    });
}

// Build the flat playback list from the day chapters.  Each day contributes
// ONE "overview" item + N "focus" sub-items (one per warning feature we
// picked for that day, grouped by hazard code).  Sub-items give the
// operator a military-style briefing — fly to each polygon, blink its
// districts, show its message — instead of one flat all-polygons view.
//
// Rebuilt whenever warnings arrive so late-arriving features get spliced
// in without dropping playback.
function _buildPlaybackList(chapters) {
  const list = [];
  chapters.forEach((c, chapterIdx) => {
    // Pick this chapter's features fresh from the current warningsFC —
    // returns empty array if warnings haven't arrived yet.
    const features = _selectWarningFeatures(c);
    c._selectedFeatures = features;   // cache on chapter for overlay setData

    // Overview slide — always present, even when no features (chapter is
    // still narratable via outlook prose alone).
    list.push({
      type: "overview",
      chapterIdx,
      chapter: c,
      features,                       // full set (used for overview overlay)
      totalWarnings: features.length,
    });

    // Group features by hazard code so the briefing plays type-by-type.
    const byHazard = new Map();
    for (const f of features) {
      const code = f.properties?._hazard_code;
      if (!code) continue;
      if (!byHazard.has(code)) byHazard.set(code, []);
      byHazard.get(code).push(f);
    }

    // Per-hazard cap: 5 features per bucket ("13 rainstorms → show 5").
    // Per-chapter overall cap: 14 total sub-chapters (day of dense
    // warnings shouldn't play for 3+ minutes straight).
    const MAX_PER_HAZARD    = 5;
    const MAX_PER_CHAPTER   = 14;
    let subCount = 0;
    // Iterate in the deliberate HAZARD_PLAYBACK_ORDER (life-safety first)
    // rather than the arbitrary Map insertion order, which was whatever
    // the raw PMD API happened to serialise first.
    const orderedCodes = HAZARD_PLAYBACK_ORDER.filter((code) => byHazard.has(code));
    for (const code of orderedCodes) {
      const feats = byHazard.get(code);
      if (subCount >= MAX_PER_CHAPTER) break;
      const room = MAX_PER_CHAPTER - subCount;
      const bucket = feats.slice(0, Math.min(MAX_PER_HAZARD, room));

      // A bucket of >2 warnings for one hazard/day plays only its 2 most
      // severe as full steps; any other bucket member whose message names
      // the SAME area as one of those 2 is folded into that step as a
      // textual "also active here" mention instead of burning its own
      // slide. A member that matches neither shown area's geography still
      // gets its own step — geography mismatch, so it can't be silently
      // folded in and can't be silently dropped either.
      let toRender = bucket;
      let alsoByFeature = null;
      if (bucket.length > 2) {
        const bySeverity = bucket.slice().sort((a, b) => _levelRank(b) - _levelRank(a));
        const shown = bySeverity.slice(0, 2);
        const rest = bySeverity.slice(2);
        const shownLoc = shown.map((f) => _parseMessageLocations(f.properties?.message || ""));
        alsoByFeature = new Map(shown.map((f) => [f, []]));
        const overflow = [];
        for (const f of rest) {
          const loc = _parseMessageLocations(f.properties?.message || "");
          const matchIdx = shownLoc.findIndex((sLoc) => _locationsOverlap(loc, sLoc));
          if (matchIdx >= 0) alsoByFeature.get(shown[matchIdx]).push(f);
          else overflow.push(f);
        }
        // Restore chronological (data_time) order for what actually plays
        // — _selectWarningFeatures already sorted `feats` that way.
        toRender = [...shown, ...overflow].sort((a, b) => bucket.indexOf(a) - bucket.indexOf(b));
      }

      toRender.forEach((f, i) => {
        const { provinces, districts } = _parseMessageLocations(f.properties?.message || "");
        list.push({
          type: "focus",
          chapterIdx,
          chapter: c,
          feature: f,
          hazardCode: code,
          hazardMeta: HAZARDS_BY_CODE[code] || null,
          featureProvinces: provinces,
          featureDistricts: districts,
          ordinal: i + 1,
          totalInHazard: feats.length,
          alsoWarnings: alsoByFeature ? (alsoByFeature.get(f) || []) : [],
        });
      });
      subCount += toRender.length;
    }
  });
  return list;
}


// ==========================================================================
// Story-owned PMD Weather Warnings overlay
// --------------------------------------------------------------------------
// The story does NOT touch the sidebar's pmd_warnings toggle or the hazard
// filter checkboxes — the operator's own state stays intact.  Instead we
// maintain our OWN GeoJSON source and two paint layers, keyed with the
// `_ncop_story_warn` prefix.  Per chapter we call setData() with the
// chapter-filtered subset of features (hazard type ∩ message-location) so
// the map shows ONLY the polygons that belong to this story slide.
//
// Fill/outline colours come from HAZARD_TYPES[].badgeBg via a single
// ["match", ["get", "_hazard_code"], …] paint expression, built once.
//
// Hover on a polygon → animated popup with the feature's own message +
// facts (level, times, area, provinces/districts parsed out of message).
// ==========================================================================
const WARN_SRC_ID  = "_ncop_story_warn-source";
const WARN_FILL_ID = "_ncop_story_warn-fill";
const WARN_LINE_ID = "_ncop_story_warn-line";

function _hazardColorMatchExpr(fallback) {
  const pairs = [];
  for (const h of HAZARD_TYPES) pairs.push(h.code, h.badgeBg || "#666");
  return ["match", ["get", "_hazard_code"], ...pairs, fallback || "#666"];
}

// Return the first existing layer id from the candidate list, or undefined.
// Used as a `beforeId` argument to map.addLayer() so new layers slot in
// underneath existing ones instead of stacking on top.
function _firstExistingLayer(map, candidates) {
  for (const id of candidates) {
    if (map.getLayer(id)) return id;
  }
  return undefined;
}

function _ensureStoryWarningLayers() {
  const map = window.ncop_map;
  if (!map) return;
  if (!map.getSource(WARN_SRC_ID)) {
    map.addSource(WARN_SRC_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      generateId: true,
    });
  }

  // Insert BENEATH the province + district boundary layers so the crisp
  // boundary outlines always render on top of the warning polygons.  Falls
  // back to "top of stack" if none of those layers exist yet — they'll
  // be re-hoisted below in _hoistBoundariesAboveWarnings().
  const beforeId = _firstExistingLayer(map, [
    "provincial_boundary-fill",
    "provincial_boundary-outline",
    "district_boundary-fill",
    "district_boundary-outline",
    HL_PROV_FILL_ID, HL_PROV_LINE_ID,
    HL_DIST_FILL_ID, HL_DIST_LINE_ID,
  ]);

  const color = _hazardColorMatchExpr("#666");
  if (!map.getLayer(WARN_FILL_ID)) {
    map.addLayer({
      id: WARN_FILL_ID,
      type: "fill",
      source: WARN_SRC_ID,
      paint: {
        "fill-color": color,
        "fill-opacity": [
          "case", ["boolean", ["feature-state", "hover"], false], 0.45, 0.28,
        ],
        "fill-outline-color": color,
      },
    }, beforeId);
  }
  if (!map.getLayer(WARN_LINE_ID)) {
    map.addLayer({
      id: WARN_LINE_ID,
      type: "line",
      source: WARN_SRC_ID,
      paint: {
        "line-color": color,
        "line-width": [
          "case", ["boolean", ["feature-state", "hover"], false], 4, 2.5,
        ],
        "line-opacity": 0.95,
      },
    }, beforeId);
  }
  _wireWarningHoverIfNeeded(map);
  _hoistBoundariesAboveWarnings();
}

// Ensure ALL boundary layers — the app's provincial_boundary + district_
// boundary, AND our _ncop_story highlight overlays — stack ABOVE the
// warning polygons.  Boundary lines are thin outlines that don't obscure
// other overlays' fills; keeping them on top is the operator's expected
// visual reference layer.  Called after any add/setData on the warnings
// source so late-loaded district tiles or style reloads never leave
// boundaries buried under the coloured warning fill.
function _hoistBoundariesAboveWarnings() {
  const map = window.ncop_map;
  if (!map) return;
  // Order matters: hoist bottom-up so the resulting z-order is
  //   ... (map base) → warn fill/line → prov fill/outline
  //     → dist fill/outline → HL prov (static gold highlight) → HL dist (blinking white)
  const order = [
    "provincial_boundary-fill",
    "provincial_boundary-outline",
    "district_boundary-fill",
    "district_boundary-outline",
    HL_PROV_FILL_ID,
    HL_PROV_LINE_ID,
    HL_DIST_FILL_ID,
    HL_DIST_LINE_ID,
  ];
  for (const id of order) {
    if (map.getLayer(id)) {
      try { map.moveLayer(id); } catch (_) {}
    }
  }
}

function _applyChapterWarningsOverlay() {
  const map = window.ncop_map;
  if (!map) { console.warn("[story] overlay: no map"); return; }
  _ensureStoryWarningLayers();
  const src = map.getSource(WARN_SRC_ID);
  if (src) {
    const feats = _story.currentWarnFeatures || [];
    src.setData({ type: "FeatureCollection", features: feats });
  } else {
    console.warn("[story] overlay: source", WARN_SRC_ID, "missing");
  }
  _hoistBoundariesAboveWarnings();
}

// PMD's vendor feed still uses the retired province name "N.W.F.P."
// (renamed to Khyber Pakhtunkhwa in 2010) — relabel it wherever it shows
// up in message prose.
// No trailing \b here deliberately — with it, the optional trailing "."
// in "N.W.F.P." never gets consumed (a boundary can't sit between two
// non-word chars, i.e. "." then ","), leaving a stray period behind.
const NWFP_RE = /\bN\.?\s?W\.?\s?F\.?\s?P\.?/gi;

// Occasionally the feed pairs a name with itself — "Azad Kashmir in Azad
// Kashmir", "Kashmir in Kashmir" — a redundant "district in province"
// where both sides are literally the same string. Collapse to one name.
const SELF_REF_RE = /\b([A-Z][A-Za-z.\-]*(?:\s+[A-Z][A-Za-z.\-]*){0,2})\s+in\s+\1\b/g;

// Same "<District> in <Province>" shape the popup's chip-parser
// (_parseMessageLocations) already relies on, just ordered/undeduped so
// we can regroup rather than just list.
const LOCATION_PAIR_RE = /([A-Z][A-Za-z.\-]*(?:\s+[A-Z][A-Za-z.\-]*){0,2})\s+in\s+([A-Z][A-Za-z.\-]*(?:\s+[A-Z][A-Za-z.\-]*){0,2})/g;

function _joinWithAmpersand(names) {
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(",")} & ${names[names.length - 1]}`;
}

// The "... cities affected include A in P1,B in P1,C in P2 and D in P1."
// sentence reads as a flat list even though several names share the same
// province. Regroup it into "A,B & D in Province P1; C in Province P2."
// Leaves the sentence untouched if it can't parse any pairs — never drop
// data we can't confidently restructure.
function _regroupCitiesSentence(sentence) {
  const hadTrailingPeriod = /\.\s*$/.test(sentence);
  const body = sentence.replace(/\.\s*$/, "");
  const m = body.match(/^(.*?\bcities affected include\s+)([\s\S]+)$/i);
  if (!m) return sentence;
  const [, lead, listStr] = m;

  LOCATION_PAIR_RE.lastIndex = 0;
  const groups = new Map();
  let mm;
  let matchedAny = false;
  while ((mm = LOCATION_PAIR_RE.exec(listStr)) !== null) {
    matchedAny = true;
    const district = mm[1].trim();
    const province = mm[2].trim();
    const standalone = district.toLowerCase() === province.toLowerCase();
    const key = standalone ? " standalone" : province;
    if (!groups.has(key)) groups.set(key, { province: standalone ? null : province, names: [] });
    const g = groups.get(key);
    if (!g.names.includes(district)) g.names.push(district);
  }
  if (!matchedAny) return sentence;

  const parts = [];
  for (const g of groups.values()) {
    const joined = _joinWithAmpersand(g.names);
    parts.push(g.province ? `${joined} in Province ${g.province}` : joined);
  }
  return `${lead}${parts.join("; ")}${hadTrailingPeriod ? "." : ""}`;
}

// Shared prose cleanup applied once, upstream of both the fixed-card
// plain message and the rich popup's wm-content — so the two surfaces
// never drift out of sync on this. Renames N.W.F.P., collapses
// self-referential "X in X" pairs, and regroups the affected-cities list
// by province.
function _cleanupWarningProse(rawMsg) {
  let text = String(rawMsg == null ? "" : rawMsg);
  if (!text) return text;
  text = text.replace(NWFP_RE, "Khyber Pakhtunkhwa");

  const sentences = text.split(/(?<=\.)\s+(?=[A-Z])/);
  for (let i = 0; i < sentences.length; i++) {
    if (/cities affected include/i.test(sentences[i])) {
      sentences[i] = _regroupCitiesSentence(sentences[i]);
    }
  }
  text = sentences.join(" ");

  // Catch any remaining self-referential pair outside the cities clause
  // (the clause's own standalone entries are already handled above).
  text = text.replace(SELF_REF_RE, "$1");
  return text;
}

// Message often has "Prevention Measures: 1. … 2. …" — split at that
// marker so we can render warning-prose and advisories with distinct
// styling.  Also strip PMD's `###` separator character, common HTML
// entities, and collapse extra whitespace/newlines.
function _splitWarningMessage(msg) {
  const raw = _cleanupWarningProse(
    String(msg || "")
      .replace(/\r/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/#{2,}/g, "")          // strip ## / ### / #### separator junk
      .replace(/\s{2,}/g, " ")        // collapse runs of whitespace
      .trim()
  );
  if (!raw) return { warning: "", advisory: "" };
  const [before, ...afterParts] = raw.split(/prevention\s+measures\s*:/i);
  const warning  = (before || "").trim();
  const advisory = afterParts.join(" ").trim();
  return { warning, advisory };
}
// Kept for back-compat with the hover popup + TTS which just want the prose.
function _stripPreventionMeasures(msg) {
  return _splitWarningMessage(msg).warning;
}

// Inline hazard-word → emoji injector.  Runs on already-escaped text.
// Rules apply in order; each emoji is inserted BEFORE the first match
// of its hazard word so the operator can scan the text like a comic:
// "🌧️ rainstorm ... ⚡ lightning ... 🌊 flooding".  Each emoji is used
// at most once per message so the prose doesn't turn into an emoji soup.
const INLINE_EMOJI_RULES = [
  { emoji: "🌧️", re: /\b(rainstorm)\b/i },
  { emoji: "⛈️", re: /\b(thunderstorm|thundershower|thundery|thunderstorms)\b/i },
  { emoji: "🌧️", re: /\b(heavy rain|heavy rainfall|rainfall)\b/i },
  { emoji: "🌪️", re: /\b(convection|convective|severe convective)\b/i },
  { emoji: "🌡️", re: /\b(heatwave|heat wave|high temperature|hot and humid|hot weather)\b/i },
  { emoji: "🌫️", re: /\b(fog|foggy|mist|misty|haze|visibility)\b/i },
  { emoji: "❄️",  re: /\b(snowstorm|snowfall|snow|blizzard)\b/i },
  { emoji: "🥶", re: /\b(cold wave|cold surge|cold spell|severe cold)\b/i },
  { emoji: "💨", re: /\b(gale|strong wind|gusty wind|high winds?)\b/i },
  { emoji: "🌪️", re: /\b(dust storm|duststorm|sandstorm|dust)\b/i },
  { emoji: "⚡", re: /\b(lightning)\b/i },
  { emoji: "🌊", re: /\b(flood|flooding|flash flood)\b/i },
  { emoji: "🧊", re: /\b(hail|hailstorm)\b/i },
  { emoji: "📍", re: /\b(cities affected)\b/i },
  { emoji: "👥", re: /\b(residents|citizens|travelers)\b/i },
  { emoji: "⚠️", re: /\b(warning has been issued|warning is currently)\b/i },
];
function _injectInlineEmoji(text) {
  let out = text;
  for (const { emoji, re } of INLINE_EMOJI_RULES) {
    // Use replace with a 1-shot regex (no /g) — we prefix the first
    // occurrence and skip subsequent ones for that rule.
    out = out.replace(re, `${emoji} $1`);
  }
  return out;
}

// Decorate the warning prose with <mark> tags around numbers, times,
// severity levels and calendar dates so key data-points stand out.  Order
// of replacements matters — apply longest/most-specific patterns first
// so shorter regexes don't chomp inside the wrappers.  Runs on ESCAPED
// text so the added `<mark>` tags are the only HTML we introduce.
function _decorateWarningText(rawEscaped) {
  let s = rawEscaped;

  // Dates like "2026-07-30" or "July 30, 2026"
  s = s.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, '<mark class="wm-date">$1</mark>');
  s = s.replace(/\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?)\b/gi,
    '<mark class="wm-date">$1</mark>');

  // Areas + counts with units
  s = s.replace(/\b(\d{1,3}(?:,\d{3})+|\d{1,3}(?:\.\d+)?)\s+(square\s+kilometers?|km²|kilometers?|km\/h)\b/gi,
    '<mark class="wm-num">$1&nbsp;$2</mark>');

  // Clock times like "21:00", "23:59", "0000 hours"
  s = s.replace(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g, '<mark class="wm-time">$1</mark>');
  s = s.replace(/\b(midnight|midday|noon|dawn|dusk)\b/gi, '<mark class="wm-time">$1</mark>');
  s = s.replace(/\b(\d{4}\s+hours?)\b/gi, '<mark class="wm-time">$1</mark>');

  // Severity levels (colour-coded)
  s = s.replace(/\b(level\s+)?(red|orange|yellow|blue|thunderstorm|gust)\b(?![^<]*<\/mark>)/gi,
    (_, prefix, lvl) => `<mark class="wm-lvl wm-lvl-${String(lvl).toLowerCase()}">${prefix || ""}${lvl}</mark>`);

  return s;
}

// Some upstream PMD Monitor warning messages arrive as a Chinese vendor
// template with only the (locally-inserted) affected-cities list rendered
// in English — the surrounding advisory prose is untranslated Chinese.  We
// deliberately do NOT machine-translate safety-critical text here (a wrong
// translation reaching an operator is worse than no translation); instead
// we detect CJK runs and collapse each contiguous run into one neutral
// flag so the briefing stays readable instead of showing raw Chinese.
const CJK_RE = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
const UNTRANSLATED_CJK_NOTE = "⚠️ [additional advisory text from source system not available in English]";
function _flagUntranslatedCjk(raw) {
  const text = String(raw == null ? "" : raw);
  if (!CJK_RE.test(text)) return text;
  // Split into sentence-like chunks on CJK/Latin sentence enders, keeping
  // the delimiter attached so we don't need to re-punctuate afterwards.
  const parts = text.split(/(?<=[。！？.!?])\s*/);
  const out = [];
  let flaggedRun = false;
  for (const part of parts) {
    if (!part) continue;
    if (CJK_RE.test(part)) {
      if (!flaggedRun) out.push(UNTRANSLATED_CJK_NOTE);
      flaggedRun = true; // swallow further CJK chunks into the same note
    } else {
      out.push(part);
      flaggedRun = false;
    }
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

// Compose warning text: flag untranslated CJK → escape → inline-emoji →
// decorate marks.  Order matters: emoji sits BEFORE the mark-wrapped
// tokens, so highlights stay intact.
function _composeWarningText(raw) {
  const cjkFlagged = _flagUntranslatedCjk(raw);
  const escaped = _escapeHtml(cjkFlagged);
  const withEmoji = _injectInlineEmoji(escaped);
  return _decorateWarningText(withEmoji);
}

// Build the rich focus-message HTML.  Called by _focusPopupHtml.  Flat
// structure — no big-glyph column; emojis live inline with the text.
function _buildRichFocusMessage(rawMsg /*, hazardCode */) {
  const { warning, advisory } = _splitWarningMessage(rawMsg);
  if (!warning && !advisory) return "";
  const warnHtml = warning ? `<div class="wm-body">${_composeWarningText(warning)}</div>` : "";

  let advisoryHtml = "";
  if (advisory) {
    // Advisory typically arrives as "1. … 2. … 3. …" — split into a
    // scannable checklist.  Regex splits on the numeric prefix so each
    // sentence lands on its own row without swallowing periods inside
    // the sentence body.
    const items = advisory.split(/\s+(?=\d+\.\s)/g)
      .map((s) => s.trim().replace(/^\d+\.\s*/, ""))
      .filter(Boolean);
    if (items.length > 1) {
      advisoryHtml = `
        <div class="wm-advisory">
          <div class="wm-advisory-head">💡 Prevention Measures</div>
          <ul class="wm-advisory-list">
            ${items.map((it) => `<li>${_composeWarningText(it)}</li>`).join("")}
          </ul>
        </div>`;
    } else {
      advisoryHtml = `
        <div class="wm-advisory">
          <div class="wm-advisory-head">💡 Prevention Measures</div>
          <div class="wm-advisory-body">${_composeWarningText(advisory)}</div>
        </div>`;
    }
  }
  return `
    <div class="wm-content">
      ${warnHtml}
      ${advisoryHtml}
    </div>
  `;
}

// PMD messages state "<District> in <Province>" (repeated per city, comma
// separated).  Pull those pairs so the popup can show a clean list.
function _parseMessageLocations(msg) {
  const provinces = new Set();
  const districts = new Set();
  if (!msg) return { provinces: [], districts: [] };
  const re = /([A-Z][A-Za-z\-]+(?:\s+[A-Z][A-Za-z\-]+)?)\s+in\s+([A-Z][A-Za-z\-]+(?:\s+[A-Z][A-Za-z\-]+)?)/g;
  let m;
  while ((m = re.exec(msg)) !== null) {
    districts.add(m[1].trim());
    provinces.add(m[2].trim());
  }
  return { provinces: Array.from(provinces), districts: Array.from(districts) };
}

// ISO string → "30 Jul 2026, 03:00".  Falls back to raw string on unparse.
function _fmtIsoTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  try {
    return new Date(t).toLocaleString(undefined, {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch (_) {
    return String(iso);
  }
}

// ---- Hover popup on story-overlay polygons ------------------------------
function _wireWarningHoverIfNeeded(map) {
  if (_story.warnHoverWired) return;
  let hoveredId = null;

  const onEnter = (e) => {
    if (!e.features || !e.features.length) return;
    map.getCanvas().style.cursor = "pointer";
    const f = e.features[0];
    if (f.id != null) {
      if (hoveredId != null) {
        map.setFeatureState({ source: WARN_SRC_ID, id: hoveredId }, { hover: false });
      }
      hoveredId = f.id;
      map.setFeatureState({ source: WARN_SRC_ID, id: hoveredId }, { hover: true });
    }
    _showWarningHoverPopup(f, e.lngLat);
  };
  const onMove = (e) => {
    if (_story.warnHoverPopup) _story.warnHoverPopup.setLngLat(e.lngLat);
  };
  const onLeave = () => {
    map.getCanvas().style.cursor = "";
    if (hoveredId != null) {
      try { map.setFeatureState({ source: WARN_SRC_ID, id: hoveredId }, { hover: false }); } catch (_) {}
      hoveredId = null;
    }
    _closeWarningHoverPopup();
  };

  map.on("mouseenter", WARN_FILL_ID, onEnter);
  map.on("mousemove",  WARN_FILL_ID, onMove);
  map.on("mouseleave", WARN_FILL_ID, onLeave);
  _story.warnHoverHandlers = { onEnter, onMove, onLeave };
  _story.warnHoverWired = true;
}

function _showWarningHoverPopup(feature, lngLat) {
  const map = window.ncop_map;
  const mgl = window.mapboxgl;
  if (!map || !mgl) return;
  _closeWarningHoverPopup();

  const p = feature?.properties || {};
  const hazardCode = p._hazard_code || _hazardCodeForFeature(feature) || "";
  const meta = HAZARDS_BY_CODE[hazardCode] || {};
  const level = String(p.level || "").trim();
  const areaKm2 = p.area_km2 ? Number(p.area_km2) : null;
  const dataTime = _fmtIsoTime(p.data_time);
  const forecastTime = _fmtIsoTime(p.forecast_time);
  const message = _stripPreventionMeasures(_tr(p.message || ""));
  // Location parsing stays on the RAW (untranslated) message — the
  // extraction regex/alias tables match English province/district names,
  // so this must never receive the Urdu string.
  const { provinces, districts } = _parseMessageLocations(p.message || "");

  // Header background driven by severity level (blue/yellow/orange/red/…)
  // so the hover popup instantly signals threat level; badge inside keeps
  // the hazard's own colour so type is still visible.
  const headColor = _colorForLevel(level, meta.badgeBg || "#666");

  const popup = new mgl.Popup({
    className: "ncop-story-warn-popup",
    closeButton: false,
    closeOnClick: false,
    closeOnMove: false,
    anchor: "bottom",
    offset: 10,
    maxWidth: "360px",
  });
  popup.setLngLat(lngLat).setHTML(`
    <div class="nswp-head" style="background:${headColor.bg};color:${headColor.fg}">
      <span class="nswp-badge" style="background:${meta.badgeBg || "rgba(0,0,0,0.28)"};color:${meta.badgeText || "#fff"};">${_escapeHtml(meta.badge || hazardCode || "!")}</span>
      <span class="nswp-title">${_escapeHtml(meta.label || p.element_label || hazardCode || "Warning")}</span>
      ${level ? `<span class="nswp-level" data-level="${_escapeHtml(level.toLowerCase())}">${_escapeHtml(level)}</span>` : ""}
    </div>
    <div class="nswp-body">
      ${message ? `<p class="nswp-msg${_story.lang === "ur" ? " pf-lang-ur" : ""}">${_escapeHtml(message)}</p>` : ""}
      <dl class="nswp-facts">
        ${dataTime     ? `<div class="nswp-fact"><dt>Data time</dt><dd>${_escapeHtml(dataTime)}</dd></div>` : ""}
        ${forecastTime ? `<div class="nswp-fact"><dt>Forecast</dt><dd>${_escapeHtml(forecastTime)}</dd></div>` : ""}
        ${areaKm2      ? `<div class="nswp-fact"><dt>Area</dt><dd>${areaKm2.toLocaleString()} km²</dd></div>` : ""}
        ${provinces.length ? `<div class="nswp-fact"><dt>Province</dt><dd>${_escapeHtml(provinces.join(", "))}</dd></div>` : ""}
        ${districts.length ? `<div class="nswp-fact"><dt>District</dt><dd>${_escapeHtml(districts.join(", "))}</dd></div>` : ""}
      </dl>
    </div>
  `).addTo(map);
  _story.warnHoverPopup = popup;
}

function _closeWarningHoverPopup() {
  if (!_story.warnHoverPopup) return;
  try { _story.warnHoverPopup.remove(); } catch (_) {}
  _story.warnHoverPopup = null;
}

function _teardownStoryWarningsOverlay() {
  _closeWarningHoverPopup();
  const map = window.ncop_map;
  if (!map) return;
  const h = _story.warnHoverHandlers;
  if (h) {
    try { map.off("mouseenter", WARN_FILL_ID, h.onEnter); } catch (_) {}
    try { map.off("mousemove",  WARN_FILL_ID, h.onMove);  } catch (_) {}
    try { map.off("mouseleave", WARN_FILL_ID, h.onLeave); } catch (_) {}
    _story.warnHoverHandlers = null;
  }
  _story.warnHoverWired = false;
  [WARN_LINE_ID, WARN_FILL_ID].forEach((id) => {
    try { if (map.getLayer(id)) map.removeLayer(id); } catch (_) {}
  });
  try { if (map.getSource(WARN_SRC_ID)) map.removeSource(WARN_SRC_ID); } catch (_) {}
  _story.currentWarnFeatures = [];
}

// PMD Warnings endpoint has been observed at ~30 MB, 6–17 s cold.  We
// race it against this hard timeout so the story can start even if the
// endpoint stalls entirely — the operator sees the outlook chapters
// with a graceful "warnings unavailable" note rather than an infinite
// spinner.  Client cache (fetchGcopCached) makes re-opens instant.
const WARNINGS_FETCH_TIMEOUT_MS = 60000;   // 60 s — the endpoint has been measured at 6–17 s cold; 30 s wasn't a comfortable safety margin

// ---- Chapter data cache --------------------------------------------------
// getNwfcWeeklyOutlook/getPmdWarnings are shared, generic helpers used
// elsewhere in the app too (e.g. the live warnings map layer in
// gcop-monitor-integration.js) with their own TTLs tuned for THAT use —
// changing those globally would make the live map layer show stale
// warnings, which is out of scope here. This is a story-local cache
// sitting in FRONT of them instead: PMD Warnings alone can be ~30 MB and
// 6-17s cold, and severe-weather warnings genuinely don't change
// meaningfully minute-to-minute, so re-fetching on every story (re)open
// within an hour is pure waste. A reopen within the window replays from
// memory instantly; past it, one fresh fetch repopulates the cache for
// the next hour. Only a genuinely successful outlook fetch refreshes the
// cache — a failed attempt never overwrites a still-valid cached result
// with nothing, and the next call simply retries instead of waiting out
// the full hour.
const STORY_DATA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let _storyDataCache = null; // { outlookRes, warningsRes, fetchedAt }

async function _fetchOutlookAndWarnings() {
  const now = Date.now();
  if (_storyDataCache && (now - _storyDataCache.fetchedAt) < STORY_DATA_CACHE_TTL_MS) {
    return _storyDataCache;
  }

  const outlookP = getNwfcWeeklyOutlook();
  // The timeout branch's own setTimeout is always cleared once the race
  // settles below — an uncleared one used to keep ticking in the
  // background and log a misleading "timed out" message ~60s after
  // every open regardless of outcome, even once the real fetch had
  // already won.
  let warningsTimeoutId = null;
  const warningsTimeout = new Promise((resolve) => {
    warningsTimeoutId = setTimeout(() => {
      console.warn("[story] warnings fetch timed out");
      resolve(null);
    }, WARNINGS_FETCH_TIMEOUT_MS);
  });
  const warningsP = Promise.race([
    getPmdWarnings().catch((e) => { console.warn("[story] getPmdWarnings threw", e); return null; }),
    warningsTimeout,
  ]).finally(() => { if (warningsTimeoutId) clearTimeout(warningsTimeoutId); });

  const [outlookRes, warningsRes] = await Promise.allSettled([outlookP, warningsP]);
  const result = { outlookRes, warningsRes, fetchedAt: now };
  if (outlookRes.status === "fulfilled" && outlookRes.value && !outlookRes.value.error) {
    _storyDataCache = result;
  }
  return result;
}

async function _fetchAndBuild(card) {
  const btn = card.querySelector(".pf-refresh");
  if (btn) btn.classList.add("is-loading");
  _pause();

  const warmCached = _story.warningsFC && _story.warningsFC.features.length > 0;
  _renderStatus(card, warmCached
    ? "Loading 7-day outlook…"
    : "Loading 7-day outlook & PMD Weather Warnings… (may take up to 60 s on first open)", false);
  console.log("[story] loading weekly outlook + PMD warnings…");

  try {
    const { outlookRes, warningsRes } = await _fetchOutlookAndWarnings();

    if (outlookRes.status !== "fulfilled" || !outlookRes.value) {
      throw outlookRes.reason || new Error("Weekly outlook unavailable");
    }
    const data = outlookRes.value;
    if (data.error || !Array.isArray(data.days)) {
      throw new Error(data.error || "Unexpected outlook shape");
    }
    _story.outlookData = data;

    if (warningsRes.status === "fulfilled" && warningsRes.value) {
      _story.warningsFC = _toFC(warningsRes.value);
    } else if (!_story.warningsFC) {
      _story.warningsFC = { type: "FeatureCollection", features: [] };
      console.warn("[story] warningsFC empty — story will play overview-only");
    }

    const chapters = _buildChaptersFromOutlook(data);
    if (!chapters.length) {
      _renderStatus(card, "No weekly outlook published in the current cycle.", false);
      return;
    }

    _story.chapters  = chapters;
    _story.playable  = _buildPlaybackList(chapters);
    _story.index     = 0;
    _story.isStale   = false;
    _story.issueDate = data?.issue_date || "";
    card.classList.remove("is-stale");

    const focusCount = _story.playable.filter((x) => x.type === "focus").length;
    console.log(`[story] loaded and cached — ${chapters.length} days, ${_story.playable.length} scenes (${focusCount} warnings), ${_story.warningsFC.features.length} PMD warning features`);

    // Determine TTS preference — on first ever open, ask the operator;
    // on subsequent opens, honour the saved choice from localStorage.
    const savedPref = _loadTtsPref();
    if (savedPref === "on")  _story.ttsEnabled = true;
    else if (savedPref === "off") _story.ttsEnabled = false;
    _syncMuteButton(card);

    // This fetch can take up to ~60s on a cold first open. If the
    // operator switched to Dynamic Weather Report (which hides this card
    // via window.ncopProvincialForecast.hide()) while it was in flight,
    // don't resurrect anything on completion — _renderChapter would
    // repopulate the (invisible) card fine, but _showChapterPopup/_play
    // would still show the floating briefing popup and restart the
    // camera/blink loop, since that popup is a SEPARATE element outside
    // this card and isn't hidden by card.style.display alone. The data
    // itself is still cached in _story.* for whenever hide→restore runs.
    if (card.style.display === "none") return;

    _renderDots(card);
    _renderChapter(card, { fade: false });

    // Preference prompts — pause playback, ask, apply, THEN start playing.
    // _renderChapter above already painted the first slide's animations +
    // polygon effect; the prompt(s) just gate auto-advance until the
    // operator has answered. TTS still only asks once ever (savedPref ===
    // null); language asks EVERY time this function runs — see
    // _showLangPrompt's own comment.
    _pause();
    if (savedPref === null) {
      const choice = await _showTtsPrompt(card);
      _saveTtsPref(choice);
      _story.ttsEnabled = choice === "on";
      _syncMuteButton(card);
      if (card.style.display === "none") return; // hidden during the prompt's own await
    }
    const langChoice = await _showLangPrompt(card);
    _story.lang = langChoice;
    _saveLangPref(langChoice);
    _syncLangButton(card);
    if (card.style.display === "none") return; // hidden during the prompt's own await
    // Re-render so the speaker/language buttons reflect the final state,
    // and start playing right away — falls back to English via _tr()'s
    // cache-miss no-op wherever a translation isn't ready yet.
    _renderChapter(card, { fade: false });
    _play();
    if (langChoice === "ur") {
      // NOT awaited — translating a full day's worth of warnings on this
      // CPU-only model can take well over a minute (a real 15-item batch
      // measured at ~105s). Blocking story start on that produced a
      // "frozen with zero feedback for 100+ seconds" experience. Instead:
      // play now, silently upgrade (text AND narration) scene-by-scene as
      // translations land.
      _ensureUrduTranslations(card).then((ok) => {
        if (ok && _story.lang === "ur") _reapplyCurrentItemLanguage(card);
      }).catch(() => {});
    }
  } catch (e) {
    console.error("[story] _fetchAndBuild failed:", e);
    _renderStatus(card, `Couldn't load briefing: ${e.message}`, true);
  } finally {
    if (btn) btn.classList.remove("is-loading");
  }
}


// ---- Panel-visibility wiring -------------------------------------------
function _handlePanelVisible() {
  // Now that this story is reached by picking it from #storySelect
  // rather than shown unconditionally whenever the story-modal opens, a
  // modal reopen should only resurrect it if it's still the operator's
  // last explicit pick — otherwise it would reappear underneath whatever
  // OTHER story they'd switched to before closing (e.g. Dynamic Weather
  // Report). _pfActiveViaPicker (not #storySelect's own .value, which
  // StoryManager resets to blank right after every pick — see
  // _watchSelect) is the reliable record of that.
  if (!_pfActiveViaPicker) return;
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const card = _ensureCard(root);
  if (!_story.started) {
    _renderStartPrompt(card);
    return;
  }
  // Already loaded from an earlier open — resume in place instead of
  // re-fetching + rebuilding from scratch. Same resume-in-place pattern
  // _restoreCardExternally already uses for the cross-story-switch case
  // just below; this path (the story-modal's own show/hide, watched by
  // _wireVisibilityObserver) fell through to an unconditional re-fetch
  // instead, which — every time the operator closed and reopened the
  // panel mid-briefing — spun up a second overlapping fetch/playback/
  // TTS/timer cycle on top of the one already running, racing the two
  // for control of the shared _story state. That's the freeze/"stuck
  // step" behaviour: repeated re-renders of the same chapter piling up
  // until the tab locks up.
  if (_story.playable.length) {
    if (_inFlightFetch) return;
    _renderChapter(card, { fade: false });
    if (_wasPlayingBeforeExternalHide) _play();
    return;
  }
  if (_inFlightFetch) return;
  _inFlightFetch = _fetchAndBuild(card).finally(() => { _inFlightFetch = null; });
}

function _handlePanelHidden() {
  // Capture play state before _pause() below clears it — read by
  // _handlePanelVisible's resume-in-place branch above. _hideCardExternally
  // (the cross-story-switch path) already captures this itself before
  // calling here; re-capturing it is a harmless no-op for that path and
  // is what makes it available for THIS function's other caller (the
  // story-modal visibility observer), which had no equivalent before.
  _wasPlayingBeforeExternalHide = _story.isPlaying;
  // Stop the timer when the story panel closes — no reason to keep advancing
  // frames the operator can't see, and this also prevents surprise map flies
  // triggering while they're using another panel.
  _pause();
  // Silence any in-progress voice briefing.
  _stopSpeaking();
  // Remove the polygon-simulation weather effects so the map returns to
  // its normal, calm look for other panels.
  _clearHazardEffects();
  // Stop any in-flight cinematic camera loop (bearing orbit) so it
  // doesn't keep panning the map after the panel closes.
  _stopCinematicLoop();
  // Restore the pitch/bearing so the next reopen doesn't start tilted.
  try {
    const map = window.ncop_map;
    if (map && typeof map.easeTo === "function") {
      map.easeTo({ pitch: 0, bearing: 0, duration: 600, essential: true });
    }
  } catch (_) {}
  // Pull down the boundary highlight overlays so the map returns to whatever
  // the user had before the story ran.  Blink timer stops too.
  _teardownHighlight();
  // Pull down our warnings overlay (source + fill + line + hover listeners
  // + hover popup).  The sidebar's own pmd_warnings toggle and hazard
  // filter checkboxes were NEVER touched by us, so nothing to restore
  // there — the operator's selections are exactly what they set.
  _teardownStoryWarningsOverlay();
  // Remove the fixed briefing card from the map container.
  _removeBriefingCard();
}

// Public control surface — used ONLY by story-dynamic-weather.js so it can
// hide/pause this card while ITS OWN Dynamic Weather Report is showing (a
// separate, independent story picked from #storySelect), and restore this
// one when the operator closes back out. This calls the exact same
// teardown/render functions the #story-modal visibility observer already
// uses below — nothing about this card's own playback logic changes for
// its normal (visible, story-modal-driven) lifecycle.
let _wasPlayingBeforeExternalHide = false;

function _hideCardExternally() {
  const card = document.getElementById(CARD_ID);
  if (!card || card.style.display === "none") return;
  _wasPlayingBeforeExternalHide = _story.isPlaying;
  _handlePanelHidden();
  card.style.display = "none";
}

function _restoreCardExternally() {
  const card = document.getElementById(CARD_ID);
  if (!card) return;
  card.style.display = "";
  if (!_story.started) {
    _renderStartPrompt(card);
    return;
  }
  if (_story.playable.length) {
    _renderChapter(card, { fade: false });
    if (_wasPlayingBeforeExternalHide) _play();
  }
}

window.ncopProvincialForecast = {
  hide: _hideCardExternally,
  restore: _restoreCardExternally,
};

// ---- #storySelect integration ---------------------------------------
// Same injected-option pattern story-dynamic-weather.js already uses for
// its own "Dynamic Weather Report" entry (see that file's _ensureOption/
// _watchSelect) — mirrored here so both cinematic briefings are reached
// identically: pick from the dropdown, playback starts automatically.
// The two coexist safely without cross-calling each other: each only
// ever hides ITSELF when #storySelect's value stops matching its own
// sentinel, which the shared `change` listener naturally covers however
// the operator got there (picked the other story, or cleared the
// selection).
function _ensureOption(sel) {
  if (!sel || sel.querySelector(`option[value="${PF_SENTINEL}"]`)) return;
  const opt = document.createElement("option");
  opt.value = PF_SENTINEL;
  opt.textContent = "7-Day Weather Outlook";
  sel.appendChild(opt);
}

// Tracks "was this story the one last explicitly picked", independent of
// #storySelect's own .value — StoryManager's change listener (target
// phase, fires after ours) doesn't find our externally-injected sentinel
// in its own story list and resets the select back to blank via
// _renderList() every time, same acknowledged quirk story-dynamic-
// weather.js's identical integration already lives with. Re-reading
// sel.value later (e.g. on modal reopen) would therefore always read
// blank even while this story is genuinely still active — this flag is
// what _handlePanelVisible actually checks instead.
let _pfActiveViaPicker = false;

let _pfOptionObserver = null;
function _watchSelect(sel) {
  _ensureOption(sel);
  if (_pfOptionObserver) _pfOptionObserver.disconnect();
  _pfOptionObserver = new MutationObserver(() => _ensureOption(sel));
  _pfOptionObserver.observe(sel, { childList: true });

  // Capture phase so this fires before StoryManager's own change listener
  // (registered directly on the element, so it runs at target phase) has
  // a chance to reset the select back to blank via its own _renderList()
  // — same reasoning story-dynamic-weather.js's identical listener relies on.
  document.addEventListener("change", (e) => {
    if (e.target !== sel) return;
    // StoryManager's own #storyChapters list (chapter-card / scroll
    // stories) has nothing to show once a cinematic briefing is picked —
    // same hide-while-active / restore-on-exit story-dynamic-weather.js's
    // own _show()/_hide() already do for this exact element. Safe even
    // when switching directly to Dynamic Weather Report: its own change
    // listener fires for the same event and re-hides it synchronously
    // right after, so there's no visible flicker.
    const chaptersEl = document.getElementById(ROOT_ID)?.querySelector("#storyChapters");
    _pfActiveViaPicker = e.target.value === PF_SENTINEL;
    if (_pfActiveViaPicker) {
      if (chaptersEl) chaptersEl.style.display = "none";
      _showFromPicker();
    } else {
      _hideCardExternally();
      if (chaptersEl) chaptersEl.style.display = "grid";
    }
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

// Picking this story from the dropdown always plays immediately — no
// "Start Briefing" gate. That button (_renderStartPrompt) still exists
// untouched for the legacy story-modal-open fallback path, but the
// picker is now the primary way in, and selecting it is already an
// explicit "play this" gesture, so it starts straight away exactly like
// clicking that button would.
function _showFromPicker() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const card = _ensureCard(root);
  card.style.display = "";
  _story.started = true;
  // Already loaded from an earlier selection this session — resume in
  // place instead of re-fetching, same reasoning _handlePanelVisible's
  // resume-in-place branch uses.
  if (_story.playable.length) {
    if (_inFlightFetch) return;
    _renderChapter(card, { fade: false });
    _play();
    return;
  }
  if (_inFlightFetch) return;
  _inFlightFetch = _fetchAndBuild(card).finally(() => { _inFlightFetch = null; });
}

function _wireVisibilityObserver() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return false;

  const isVisible = () => {
    const disp = modal.style.display;
    if (disp && disp !== "none") return true;
    if (modal.classList.contains("visible")) return true;
    return false;
  };

  if (isVisible()) _handlePanelVisible();

  let wasVisible = isVisible();
  const mo = new MutationObserver(() => {
    const nowVisible = isVisible();
    if (nowVisible && !wasVisible) _handlePanelVisible();
    else if (!nowVisible && wasVisible) _handlePanelHidden();
    wasVisible = nowVisible;
  });
  mo.observe(modal, { attributes: true, attributeFilter: ["style", "class"] });
  return true;
}

export function initStoryProvincialForecast() {
  if (_wired) return;
  _injectStyles();
  _wireStorySelectWhenReady();
  if (_wireVisibilityObserver()) { _wired = true; return; }
  const mo = new MutationObserver(() => {
    if (_wireVisibilityObserver()) { _wired = true; mo.disconnect(); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { if (!_wired) mo.disconnect(); }, 20000);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initStoryProvincialForecast);
  } else {
    initStoryProvincialForecast();
  }
}
