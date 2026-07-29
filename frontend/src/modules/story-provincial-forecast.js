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

const MODAL_ID   = "story-modal";
const ROOT_ID    = "story-root";
const CARD_ID    = "ncop-provincial-forecast";
const ENDPOINT   = "/api/pmd/monitor/daily-forecast-pro/";
const STYLE_ID   = "ncop-provincial-forecast-styles";
const TICK_MS    = 8000;   // 8 s per province — matches typical narration cadence

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
        <span>Provincial Daily Forecast</span>
      </div>
      <button type="button" class="pf-refresh" aria-label="Refresh forecast">Refresh</button>
    </div>
    <div class="pf-chapter-head">
      <div class="pf-chapter-title">—</div>
      <div class="pf-chapter-counter">0 / 0</div>
    </div>
    <div class="pf-body" role="region" aria-live="polite"></div>
    <div class="pf-progress-track"><div class="pf-progress-fill"></div></div>
    <div class="pf-transport">
      <button type="button" class="pf-btn pf-btn--prev" title="Previous province" aria-label="Previous">${ICON_PREV}</button>
      <button type="button" class="pf-btn pf-btn--play pf-btn--play-glyph" title="Play" aria-label="Play">${ICON_PLAY}</button>
      <button type="button" class="pf-btn pf-btn--next" title="Next province" aria-label="Next">${ICON_NEXT}</button>
      <span class="pf-hint">Auto-advance every 8s</span>
    </div>
    <div class="pf-dots" role="tablist"></div>
    <div class="pf-meta">
      <span class="pf-source">Source: PMD Meteorological Department</span>
      <span class="pf-stale" title="Serving last-known-good; upstream unavailable">STALE</span>
    </div>
  `;
  root.insertBefore(card, root.firstChild);
  _bindCardEvents(card);
  return card;
}

function _bindCardEvents(card) {
  const btn = (sel) => card.querySelector(sel);
  btn(".pf-btn--play").addEventListener("click", _togglePlay);
  btn(".pf-btn--prev").addEventListener("click", () => _goto(_story.index - 1, /*byUser*/ true));
  btn(".pf-btn--next").addEventListener("click", () => _goto(_story.index + 1, /*byUser*/ true));
  btn(".pf-refresh").addEventListener("click", () => {
    if (_inFlightFetch) return;
    _inFlightFetch = _fetchAndBuild(card).finally(() => { _inFlightFetch = null; });
  });
  // Delegated click on dots for quick-jump.
  card.querySelector(".pf-dots").addEventListener("click", (e) => {
    const dot = e.target.closest(".pf-dot");
    if (!dot || dot.classList.contains("is-empty")) return;
    const idx = Number(dot.dataset.pfIdx);
    if (Number.isFinite(idx)) _goto(idx, /*byUser*/ true);
  });
}


// ---- Rendering helpers --------------------------------------------------
function _renderDots(card) {
  card.querySelector(".pf-dots").innerHTML = _story.provinces.map((p, i) => `
    <button type="button" role="tab"
            class="pf-dot ${_story.playable.includes(p) && _playableIndexOf(p) === _story.index ? "is-active" : ""} ${p.empty ? "is-empty" : ""}"
            data-pf-idx="${_playableIndexOf(p)}"
            ${p.empty ? 'title="No forecast text published for this province"' : ""}
            aria-selected="${_playableIndexOf(p) === _story.index}">${p.title}</button>
  `).join("");
}

function _playableIndexOf(province) {
  return _story.playable.indexOf(province);
}

function _renderChapter(card, opts = {}) {
  const p = _story.playable[_story.index];
  if (!p) return;
  const titleEl   = card.querySelector(".pf-chapter-title");
  const counterEl = card.querySelector(".pf-chapter-counter");
  const bodyEl    = card.querySelector(".pf-body");

  titleEl.textContent   = p.title;
  counterEl.textContent = `${_story.index + 1} / ${_story.playable.length}`;

  if (opts.fade !== false) {
    bodyEl.classList.add("is-fading");
    setTimeout(() => {
      bodyEl.innerHTML = _sanitiseFragment(p.text);
      bodyEl.classList.remove("is-fading");
    }, 180);
  } else {
    bodyEl.innerHTML = _sanitiseFragment(p.text);
  }

  // Update dot active state (find the dot whose data-pf-idx matches current).
  card.querySelectorAll(".pf-dot").forEach((d) => {
    const isSel = Number(d.dataset.pfIdx) === _story.index;
    d.classList.toggle("is-active", isSel);
    d.setAttribute("aria-selected", isSel ? "true" : "false");
  });

  // Fly the map to this province.  Uses window.ncop_map (already exposed
  // by dashboard.js).  Silent no-op if the map isn't ready yet.
  _flyToProvince(p.title);
  // Filter + blink the provincial + district boundaries for this chapter.
  _applyChapterHighlight(p.title, p.text);
}

function _flyToProvince(provinceTitle) {
  try {
    const map = window.ncop_map;
    const loc = PROVINCE_LOCATIONS[provinceTitle];
    if (!map || !loc || typeof map.flyTo !== "function") return;
    map.flyTo({
      center: loc.center,
      zoom:   loc.zoom,
      pitch:  loc.pitch ?? 0,
      bearing: loc.bearing ?? 0,
      duration: 1600,
      essential: true,
    });
  } catch (_) { /* best-effort */ }
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
    const uniqueKeys = new Set();
    const sample = {};
    feats.slice(0, 25).forEach((f) => {
      Object.keys(f.properties || {}).forEach((k) => {
        uniqueKeys.add(k);
        if (!(k in sample)) sample[k] = f.properties[k];
      });
    });
    console.log(
      `[story-forecast] ${label} tile props →`,
      { keys: [...uniqueKeys], sample }
    );
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
        "fill-color": "#4dd0e1",
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

function _startBlink() {
  _stopBlink();
  const map = window.ncop_map;
  if (!map) return;
  _story.blinkPhase = false;
  _story.blinkTimer = setInterval(() => {
    _story.blinkPhase = !_story.blinkPhase;
    const wide = _story.blinkPhase;
    try {
      if (map.getLayer(HL_PROV_LINE_ID)) {
        map.setPaintProperty(HL_PROV_LINE_ID, "line-width", wide ? 5 : 2.5);
        map.setPaintProperty(HL_PROV_LINE_ID, "line-opacity", wide ? 1 : 0.45);
      }
      if (map.getLayer(HL_DIST_LINE_ID)) {
        map.setPaintProperty(HL_DIST_LINE_ID, "line-width", wide ? 4 : 2);
        map.setPaintProperty(HL_DIST_LINE_ID, "line-opacity", wide ? 1 : 0.5);
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

// Set filters for the current chapter — awaits any async source loads so
// setFilter never runs against a missing layer.
async function _applyChapterHighlight(chapterTitle, chapterText) {
  const map = window.ncop_map;
  if (!map) return;

  const districts = _extractDistrictNames(chapterText);
  const isIslamabad = chapterTitle === "Islamabad";

  // Provincial boundary source is added at boot by dashboard's
  // #applyDefaultLayers, but if the story panel opens BEFORE the map style
  // finishes loading, the source may not be there yet.  Wait for it.
  await _waitForSource(PROV_SRC, 3000);

  // Districts required for Islamabad, or any chapter that mentions specific
  // district names.  This is a real await now — the overlay attach will not
  // race the filter.
  const needDistricts = isIslamabad || districts.length > 0;
  if (needDistricts) await _ensureDistrictSource(true);

  _ensureOverlayLayers();

  // Filter province (skip for Islamabad — see comment on aliases).
  if (map.getLayer(HL_PROV_LINE_ID)) {
    if (isIslamabad) {
      map.setFilter(HL_PROV_LINE_ID, ["has", "___ncop_never___"]);
      map.setFilter(HL_PROV_FILL_ID, ["has", "___ncop_never___"]);
    } else {
      const provAliases = PROVINCE_ALIASES[chapterTitle] || [chapterTitle.toLowerCase()];
      const expr = _matchAnyExpr(provAliases);
      map.setFilter(HL_PROV_LINE_ID, expr);
      map.setFilter(HL_PROV_FILL_ID, expr);
    }
  }

  // Filter districts.
  if (map.getLayer(HL_DIST_LINE_ID)) {
    const targets = isIslamabad
      ? Array.from(new Set(["Islamabad", ...districts]))
      : districts;
    if (targets.length) {
      const expr = _matchAnyExpr(targets);
      map.setFilter(HL_DIST_LINE_ID, expr);
      map.setFilter(HL_DIST_FILL_ID, expr);
    } else {
      map.setFilter(HL_DIST_LINE_ID, ["has", "___ncop_never___"]);
      map.setFilter(HL_DIST_FILL_ID, ["has", "___ncop_never___"]);
    }
  }

  _startBlink();

  // One-shot property probe once real tiles arrive.  Runs deferred so
  // querySourceFeatures has data to read.
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
  const pct = Math.max(0, Math.min(100, (elapsed / TICK_MS) * 100));
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
  _story.tickTimer = setTimeout(() => {
    _goto(_story.index + 1, /*byUser*/ false);
  }, TICK_MS);
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
  card.querySelector(".pf-body").innerHTML = `<div class="pf-status ${isError ? "is-error" : ""}">${msg}</div>`;
  card.querySelector(".pf-dots").innerHTML = "";
  card.querySelector(".pf-chapter-title").textContent = "—";
  card.querySelector(".pf-chapter-counter").textContent = "0 / 0";
  card.querySelector(".pf-progress-fill").style.width = "0%";
}

async function _fetchAndBuild(card) {
  const btn = card.querySelector(".pf-refresh");
  if (btn) btn.classList.add("is-loading");
  _pause();
  _renderStatus(card, "Loading latest forecast…", false);
  const url = `${window.location.origin}${ENDPOINT}?_=${Date.now()}`;
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.error || !Array.isArray(data.provinces)) {
      throw new Error(data.error || "Unexpected response shape");
    }
    _story.provinces = data.provinces;
    _story.playable  = data.provinces.filter((p) => !p.empty);
    _story.index     = 0;
    _story.isStale   = data._stale === true;
    card.classList.toggle("is-stale", _story.isStale);

    if (!_story.playable.length) {
      _renderStatus(card, "No forecast text published for any province in the current cycle.", false);
      return;
    }
    _renderDots(card);
    _renderChapter(card, { fade: false });
    _play();   // auto-start on open — the whole point of a "story"
  } catch (e) {
    _renderStatus(card, `Couldn't load provincial forecast: ${e.message}`, true);
  } finally {
    if (btn) btn.classList.remove("is-loading");
  }
}


// ---- Panel-visibility wiring -------------------------------------------
function _handlePanelVisible() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  const card = _ensureCard(root);
  if (_inFlightFetch) return;
  _inFlightFetch = _fetchAndBuild(card).finally(() => { _inFlightFetch = null; });
}

function _handlePanelHidden() {
  // Stop the timer when the story panel closes — no reason to keep advancing
  // frames the operator can't see, and this also prevents surprise map flies
  // triggering while they're using another panel.
  _pause();
  // Pull down the highlight overlays so the map returns to whatever the user
  // had before the story ran.  Blink timer stops too.
  _teardownHighlight();
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
