# Cinematic Story Mode → CCOP: architecture, integration steps, climate data, and TTS

**Scope note:** this is a supplementary deliverable, same as the two prior
markdown docs this session (GEE→CCOP, temporal-slider opacity). The main
thread of this project remains the **landslide AHP susceptibility work**
(`ncop_internal/landslide_model.py`, `landslide_ahp.py`, `landslide_lhasa2_scan.py`,
`landslide_regional_comparison.py`, `LANDSLIDE_EARLY_WARNING_METHODOLOGY.md`) —
nothing here changes or depends on that work; this is a standalone reference
for building CCOP's own Story Mode.

**Audience:** engineers adding a "Story Mode" — the `storyBtn` rail button +
`#story-modal` panel, cinematic camera-driven data briefings — to **CCOP
(Century Common Operating Picture)**, a Django + Vite + Mapbox GL JS app, and
tailoring its content to **climate change**: trends, projections, disasters,
and impacts, narrated with text‑to‑speech.

Everything under "How NCOP does it" is read directly from the working NCOP
codebase (`ncop_v1/ncop_local`) — real files, real line ranges, nothing
guessed.

---

## 0. TL;DR — the shape of the whole thing

Story Mode in NCOP is **three layers**, not one:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1 — the shared shell (rail button + modal + <select>)          │
│   navigation-panel.js builds #story-modal; map-controls.js's         │
│   StoryManager owns #storySelect/#storyMeta/#storyChapters/          │
│   #storyEditor and is the ONLY thing that ever creates that <select> │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2 — generic, JSON-backed stories (StoryManager itself)         │
│   Flat-file JSON CRUD via GET/POST /stories/, /stories/<slug>/.      │
│   Chapters render as simple cards: title + markdown body + optional  │
│   image/video + "fly to chapter" / "show layers" buttons. No         │
│   camera choreography, no TTS, no live data — a lightweight,         │
│   editable, non-cinematic story type.                                │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 3 — cinematic, live-data-driven stories (self-contained        │
│   modules: story-dynamic-weather.js, story-provincial-forecast.js)   │
│   Each module:                                                       │
│     1. injects its own <option value="__sentinel__"> into the SAME   │
│        #storySelect StoryManager owns, re-injecting via              │
│        MutationObserver whenever StoryManager wipes the <select>;    │
│     2. listens for "change" on #storySelect in the CAPTURE phase —   │
│        so it intercepts the pick BEFORE StoryManager's own handler   │
│        resets state — and takes over, hiding #storyChapters and      │
│        rendering its OWN full-bleed card in its place;               │
│     3. drives the map via story-cinematic-engine.js's shared         │
│        flyTo/easeTo/fitBounds/fade/orbit/flythrough primitives;      │
│     4. narrates each scene via window.speechSynthesis (Web Speech    │
│        API, built into the browser — no server, no install), with    │
│        an optional English↔Urdu toggle backed by a self-hosted       │
│        NLLB-200 translation model on the Django side;                │
│     5. pulls its numbers from real backend endpoints (parsed PDFs,   │
│        proxied government feeds), never from decorative rasters.     │
└─────────────────────────────────────────────────────────────────────┘
```

Layer 3 is what the pasted `#story-modal` HTML is really advertising: *"real
PMD/NWFC/FFD figures narrated scene by scene, not scripted content."* For a
**climate story**, CCOP wants the equivalent of Layer 3, with a climate data
catalog instead of a weather one (§3).

---

## 1. How NCOP builds this today (read the actual files)

### 1.1 The rail button + modal shell

`frontend/src/modules/navigation-panel.js` builds `#gee-chat-modal` and (per
its own comment in `dashboard.js`) `#story-modal` — this is the pasted HTML's
direct source: the `storyBtn` rail button, the `#story-modal` floating panel
with header/close button, and an empty `#story-root` div that Layer 2
(`StoryManager`) fills in.

`frontend/src/modules/dashboard.js` (~L734–943) is the panel registry that
makes the rail button toggle the modal open/closed, and tracks it alongside
every other floating panel (`gee-chat-modal`, `geoglows-forecast-panel`, …) so
opening one can close the others if that's the desired UX (a config table, not
custom code per panel).

### 1.2 Layer 2 — `StoryManager` (`frontend/src/modules/map-controls.js`, ~L123–460)

```js
export class StoryManager {
  constructor({ map, sourceLayerControl, storyRoot, fetchBase = "" }) {
    this.map = map;
    this.root = storyRoot;                 // #story-root
    this.state = { isPlaying:false, currentStory:null, currentIndex:0,
                   stories:[], temporalActiveKey:null, activeLayerKeys:new Set() };
    this._renderShell();                   // builds #storySelect/#storyMeta/#storyChapters/#storyEditor
    this._bind();
    this.loadStories();
  }

  async loadStories() {                     // GET /stories/?full=1
    const r = await fetch(`${this.fetchBase}/stories/?full=1`);
    const data = await r.json();            // { slug: {title, subtitle, chapters:[...]} }
    this.state.stories = Object.entries(data).map(([slug, obj]) =>
      ({ id: slug, title: obj?.title || slug, ...obj }));
    this._renderList();                     // populates #storySelect <option>s
  }

  async saveStory(payload) {                // POST or PUT /stories/(<id>/)
    const method = payload?.id ? "PUT" : "POST";
    const url = payload?.id ? `${this.fetchBase}/stories/${payload.id}/`
                            : `${this.fetchBase}/stories/`;
    return fetch(url, { method, headers:{"Content-Type":"application/json"},
                        body: JSON.stringify(payload) }).then(r => r.json());
  }
  // _renderShell / _renderList / _renderStory / _renderMedia / editor UI …
}
```

Each chapter renders as a card with a title, markdown body, optional
`<img>`/`<video>`/YouTube-Vimeo iframe (`_renderMedia`, L249–299), and two
buttons: **fly to chapter** and **show layers** — both call straight into the
already-shared `sourceLayerControl` and `map.flyTo`, no camera choreography.
`StoryManager.HIDDEN_STORY_IDS` (L215) keeps three demo/legacy JSON stories
(`demostory`, `hydrological`, `meteorological`) loadable-by-editor but off the
operational picker — the picker only shows real cinematic briefings plus
whatever real JSON stories an operator authors later.

**Backend** (`project/ncop_internal/views.py`, `StoriesView` ~L308, `StoryDetailView`
~L358): flat JSON files under `STORY_JSON_DIR`
(`project/ncop_project/settings/base.py` L426–427, default
`frontend/src/assets/story_jasons/`). `GET /stories/` lists slugs; `GET
/stories/?full=1` returns every story object; `POST`/`PUT` write a JSON file
per slug (`SLUG_RE`-validated); `GET /stories/<slug>/` returns one.

### 1.3 Layer 3 — cinematic, live-data-driven stories

**The reusable engine, `frontend/src/modules/story-cinematic-engine.js`** (412
lines, zero story-specific code — pure motion/timing toolkit, fully portable
to CCOP as-is):

| Export | What it does |
|---|---|
| `cinematicFlyTo(map, opts)` | `map.flyTo` wrapped as a Promise (resolves on real `moveend`, not a guessed timeout), house defaults `curve:1.7`, cubic ease |
| `cinematicEaseTo(map, opts)` | Same, for smaller adjustments (bearing/pitch), sine ease |
| `cinematicFitBounds(map, bounds, opts)` | Same, for "show everything at once" beats |
| `fadeLayerOpacity(map, id, prop, from, to, ms)` | `requestAnimationFrame`-driven opacity ramp — **every layer in Story Mode fades in/out, never snaps** (the same opacity-not-visibility discipline documented in `TEMPORAL_SLIDER_OPACITY_ANIMATION.md`) |
| `fadeLayers(map, pairs, ms)` | Same, multiple layer/prop pairs in lockstep |
| `enableCinematicAtmosphere(map, opts)` / `disableCinematicAtmosphere` | 3D terrain (`mapbox://mapbox.mapbox-terrain-dem-v1`) + `setFog` for depth on the opening fly-in; reversible |
| `pulseElement(el, class, ms)` | Timed CSS-class pulse on a DOM marker/badge |
| `orbitAroundPoint(map, center, opts)` | Free-camera partial sweep around a point (`setFreeCameraOptions` + `MercatorCoordinate`, Mapbox's own documented technique) — "drone flyover" feel |
| `flyAlongPath(map, waypoints, opts)` | Free-camera flythrough along waypoints, paced by cumulative distance (not waypoint index) so uneven spacing still reads smoothly, camera looks ahead of its own position |
| `enableRainEffect(map, opts)` / `disableRainEffect` | Mapbox GL's built-in `setRain`, zoom-gated |

Every helper **returns a Promise that resolves on the real animation
completion event**, with a timeout safety net — this is what lets a story
script read as a linear sequence of `await`s instead of a pile of nested
`setTimeout`s.

**The sentinel-injection pattern** — how a cinematic module attaches to the
Layer‑1/2 shell **without ever touching `StoryManager`'s own code**
(`story-dynamic-weather.js` L55–68, verified against the real
implementation L5269–5365):

```js
const SELECT_ID = "storySelect";
const SENTINEL  = "__dynamic_weather__";

function _ensureOption(sel) {                 // 1. inject our own <option>
  if (sel.querySelector(`option[value="${SENTINEL}"]`)) return;
  const opt = document.createElement("option");
  opt.value = SENTINEL; opt.textContent = "Dynamic Weather Report";
  sel.appendChild(opt);
}

function _watchSelect(sel) {
  _ensureOption(sel);
  new MutationObserver(() => _ensureOption(sel))   // re-inject if StoryManager
    .observe(sel, { childList: true });            //   wipes the <select>

  // 2. CAPTURE phase — fires BEFORE StoryManager's own target-phase
  //    listener resets state.currentStory back to blank.
  document.addEventListener("change", (e) => {
    if (e.target !== sel) return;
    if (e.target.value === SENTINEL) _show(); else _hide();
  }, true);                                        // <- capture = true
}

function _wireStorySelectWhenReady() {
  const sel = document.getElementById(SELECT_ID);
  if (sel) return _watchSelect(sel);
  const mo = new MutationObserver(() => {           // #storySelect may not
    const s = document.getElementById(SELECT_ID);    // exist yet at import
    if (s) { mo.disconnect(); _watchSelect(s); }      // time — wait for it
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 20000);
}
```

`_show()` toggles `#storyChapters`'s own `display` to `"none"` and renders the
module's own full card in its place (a **presentation choice**, never a code
change to `StoryManager`); `_hide()` reverses it. The module never calls
`stopPropagation()` — `StoryManager`'s own handler still runs right after and
harmlessly resets its own (now-hidden) UI to "no story picked". This is the
whole integration contract: **one shared `<select>`, own additively, never
modify.**

**A worked scene, condensed from the real chapter‑1 flow**
(`story-dynamic-weather.js`, real calls, reordered for readability):

```js
async function _playChapter1() {
  enableCinematicAtmosphere(map, { exaggeration: 1.4 });
  await cinematicFlyTo(map, { center: [69.3, 30.4], zoom: 4.2, pitch: 45, duration: 2600 });
  await cinematicFlyTo(map, { center: [69.3, 30.4], zoom: 5.4, pitch: 55, bearing: 15, duration: 2200 });

  const report = await fetch("/api/pmd/nwfc/rainfall-report/").then(r => r.json());
  await fadeLayerOpacity(map, "dwd_satellite_infrared", "raster-opacity", 0, 0.85, 2000);
  await _speak(_narrationFor(report));               // awaits real speech end, not a timer

  await fadeLayerOpacity(map, "dwd_satellite_infrared", "raster-opacity", 0.85, 0, 1500);
  await fadeLayerOpacity(map, "nwfc_observations", "circle-opacity", 0, 0.9, 1500);
  for (const station of _topStations(report, 3)) {
    await cinematicFlyTo(map, { center: station.coords, zoom: 9, duration: 2400 });
    pulseElement(document.querySelector(`[data-station="${station.id}"]`));
    _openStationPopup(station);
    await _speak(_stationNarration(station));
  }

  await cinematicFitBounds(map, PAKISTAN_BOUNDS, { duration: 2600 });
  disableCinematicAtmosphere(map);
}
```

### 1.4 TTS — the actual, live implementation (zero install, zero cost)

NCOP's story narration is the **browser-native Web Speech API**
(`window.speechSynthesis` / `SpeechSynthesisUtterance`) — **not** a paid
cloud service; the repo has a stale `azure_tts.py.pyc` from a removed,
unused module, but no active Azure/Google/ElevenLabs TTS code path exists
today. The real mechanism (`story-dynamic-weather.js` L237–330):

```js
// Voices load ASYNCHRONOUSLY — getVoices() often returns [] until the
// one-time 'voiceschanged' event fires, even when a matching voice IS
// installed. Cached eagerly so playback never races an empty voice list.
let _voicesCache = null;
const _ss = window.speechSynthesis;
_voicesCache = _ss.getVoices();
if (!_voicesCache.length) {
  _ss.addEventListener("voiceschanged", () => { _voicesCache = _ss.getVoices(); }, { once: true });
}

function _pickUrduVoice() {
  const voices = _voicesCache.length ? _voicesCache : _ss.getVoices();
  return voices.find(v => /^ur[-_]/i.test(v.lang))    // exact Urdu locale
      || voices.find(v => /^ur$/i.test(v.lang))
      || voices.find(v => /^ar/i.test(v.lang))         // Arabic: same script fallback
      || null;
}

function _speak(text) {
  return new Promise((resolve) => {
    if (!_state.ttsEnabled || !window.speechSynthesis || !text) return resolve();
    window.speechSynthesis.cancel();                   // never let two utterances overlap
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = Math.min(3, 0.98 * (_state.speed || 1));   // fast-forward speeds up the VOICE too
    if (_state.lang === "ur") {
      utter.lang = "ur-PK";
      const voice = _pickUrduVoice();
      if (voice) utter.voice = voice; else _showNoUrduVoiceWarning();  // real, on-screen, once
    }
    utter.onend = () => resolve();                      // scene-advance AWAITS the real speech end
    utter.onerror = () => resolve();
    window.speechSynthesis.speak(utter);
  });
}
```

Key, worth copying verbatim into CCOP: (a) TTS is **muted by default** —
`ttsEnabled: false`, an explicit opt-in prompt on first open (a real
accessibility/UX courtesy, not an accident); (b) the scene-advance timer
**awaits the real `onend` event**, not a duration estimate, so pacing and
narration never drift apart; (c) fast-forward (`speedLevels`) scales
`utter.rate` too, so "2×" genuinely means "reads twice as fast," not "waits
half as long while the voice drones on"; (d) a missing target-language voice
degrades **honestly** (a visible warning, not silent mis-narration).

### 1.5 Translation (optional layer, only needed for multi-language narration)

`project/ncop_internal/translate.py` — a **self-hosted**
`facebook/nllb-200-distilled-600M` model (Meta, CC‑BY‑NC‑4.0 — non‑commercial
only; flagged as a real license term in NCOP's own comment), chosen over a
smaller Marian model (`Helsinki-NLP/opus-mt-en-ur`) after live A/B testing:
the smaller model corrupted numbers/units in real weather warnings
("21:00‑23:59" → "21:37‑23:1", "45.2 mm" → "45 meters (45 miles)")
— unacceptable for safety‑critical figures. NLLB‑200 preserved every
number/unit/place‑name across the same test cases. Served at
`POST /api/translate/` (`NcopTranslateView`), production‑hardened for
Waitress's single‑process/multi‑thread model (one shared ~1.2 GB model
instance, a lock around first load, a semaphore around concurrent
`generate()` calls — CPU‑bound work must not be run unbounded‑concurrently on
one process). Warmed up on a background timer in `apps.py.ready()` rather
than on the first real request (avoids a cold‑load hit landing on nginx's
gateway timeout).

### 1.6 The real backend data pipeline behind Layer 3

- `NwfcRainfallReportAPIView` (`views.py` L9946) — discovers the latest NWFC
  Daily Rainfall PDF (via GCOP's own report index, or a constructed
  `weather.gov.pk` URL as a direct fallback), downloads it, and parses it
  **server-side with `pdfplumber`** (`_parse_nwfc_rainfall_pdf`, L9776) into
  structured JSON (district/province totals, top stations, wind, water
  level). Cached 4 h primary / 24 h stale-fallback via Django's cache
  framework.
- `PmdDailyForecastProAPIView` — proxies `pmd.gov.pk`'s public
  `daily-forecastpro.php` feed, 30‑min cache + 6 h stale fallback.
- `frontend/src/modules/gcop-api-cache.js` — a small generic
  `fetchGcopCached(url, ttlSeconds)` wrapper plus convenience getters
  (`getNwfcObservations`, `getFfdWaterlevels`, `getPmdWarnings`, …) — every
  cinematic story reuses this same client-side TTL cache instead of each
  rolling its own.

---

## 2. Part A — integrating Story Mode into CCOP from scratch

### Step 1 — the rail button + modal shell (HTML/CSS, framework-agnostic)

```html
<!-- wherever CCOP builds its right rail (mirrors navigation-panel.js) -->
<button id="storyBtn" class="custom-nav-btn rail-btn" title="Open Story Panel">
  <svg data-lucide="book-open" width="24" height="24"></svg>
</button>
```

```js
// frontend/src/modules/story-modal-shell.js
export function buildStoryModal(mountParent) {
  const modal = document.createElement("div");
  modal.id = "story-modal";
  modal.className = "right-rail-float-panel";
  modal.style.display = "none";
  modal.innerHTML = `
    <div class="story-modal-header">
      <div><div class="story-modal-title">Story</div>
           <div class="story-modal-subtitle">Create, pick and play interactive chapters</div></div>
      <button id="storyCloseBtn" title="Close"><svg data-lucide="x"></svg></button>
    </div>
    <div id="story-root"></div>`;
  mountParent.appendChild(modal);

  document.getElementById("storyBtn").addEventListener("click", () => {
    modal.style.display = modal.style.display === "none" ? "flex" : "none";
  });
  document.getElementById("storyCloseBtn").addEventListener("click", () => {
    modal.style.display = "none";
  });
  return modal;
}
```

Port the panel CSS (`_story-gee.css`/panel-shared styles referenced from
`dashboard.css` in NCOP) as-is; it's plain CSS, not framework-coupled.

### Step 2 — port `story-cinematic-engine.js` verbatim

It has **zero** NCOP-specific imports or globals (only `window.mapboxgl` and
`map`, both of which CCOP already has). Copy the file into
`frontend/src/modules/story-cinematic-engine.js` unmodified. This is the
single highest-leverage step — every cinematic story CCOP ever builds reuses
this file untouched.

### Step 3 — `StoryManager` (Layer 2) + backend JSON CRUD

Port `StoryManager` from `map-controls.js` (constructor, `_renderShell`,
`loadStories`, `saveStory`, `_renderList`, `_renderStory`, `_renderMedia`, the
editor). It's map/DOM-generic already — the only CCOP-specific piece is
`fetchBase` (same-origin, empty string works if CCOP serves its API at the
same host).

**Backend** (`ccop_stories/views.py`, mirrors `StoriesView`/`StoryDetailView`):

```python
import json, re
from pathlib import Path
from django.conf import settings
from django.http import JsonResponse, HttpResponseBadRequest
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator

SLUG_RE = re.compile(r"^[a-z0-9_-]+$")
STORY_DIR = Path(settings.STORY_JSON_DIR)
STORY_DIR.mkdir(parents=True, exist_ok=True)

def _story_path(slug):
    return STORY_DIR / f"{slug}.json" if SLUG_RE.match(slug or "") else None

def _list_slugs():
    return sorted(p.stem for p in STORY_DIR.glob("*.json"))

class StoriesView(View):
    def get(self, request):
        slugs = _list_slugs()
        if request.GET.get("full") == "1":
            data = {}
            for s in slugs:
                try:
                    data[s] = json.loads(_story_path(s).read_text(encoding="utf-8"))
                except Exception as e:
                    data[s] = {"error": str(e)}
            return JsonResponse(data)
        return JsonResponse({"stories": slugs})

    def post(self, request):
        payload = json.loads(request.body.decode("utf-8"))
        slug, obj = payload.get("slug"), payload.get("story")
        path = _story_path(slug)
        if not path or not isinstance(obj, dict):
            return HttpResponseBadRequest("bad slug/story")
        path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        return JsonResponse({"slug": slug, "saved": True})

@method_decorator(csrf_exempt, name="dispatch")
class StoryDetailView(View):
    def get(self, request, slug):
        path = _story_path(slug)
        if not path or not path.exists():
            return JsonResponse({"error": "not found"}, status=404)
        return JsonResponse(json.loads(path.read_text(encoding="utf-8")))

    def put(self, request, slug):
        payload = json.loads(request.body.decode("utf-8"))
        path = _story_path(slug)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return JsonResponse({"slug": slug, "saved": True})
```

`settings.py`: `STORY_JSON_DIR = env("STORY_JSON_DIR", default=BASE_DIR / "frontend" / "src" / "assets" / "story_json")`.
`urls.py`: `path("stories/", StoriesView.as_view()), path("stories/<slug:slug>/", StoryDetailView.as_view())`.

### Step 4 — a cinematic climate story module (the sentinel pattern)

Use `frontend/src/modules/story-climate-briefing.js` as the template — copy
the **entire** integration skeleton from §1.3 (`_ensureOption`,
`_watchSelect`, `_wireStorySelectWhenReady`, capture-phase listener,
`initStoryClimateBriefing()` self-init on `DOMContentLoaded`), rename the
sentinel and card id, then fill in your own scene sequence using
`story-cinematic-engine.js`'s primitives and your own climate data fetches
(§3). A minimal, complete skeleton:

```js
// frontend/src/modules/story-climate-briefing.js
import {
  cinematicFlyTo, cinematicFitBounds, fadeLayerOpacity,
  enableCinematicAtmosphere, disableCinematicAtmosphere, wait,
} from "./story-cinematic-engine.js";
import { speak, stopSpeaking, ttsAvailable } from "./story-tts.js";     // §4

const SELECT_ID = "storySelect";
const SENTINEL  = "__climate_briefing__";
const CARD_ID   = "ccop-climate-briefing";
const MODAL_ID  = "story-modal";
const NATIONAL_BOUNDS = [[60.5, 23.3], [77.9, 37.3]];   // adapt to CCOP's own AOI

let _state = { index: 0, playing: false, ttsEnabled: false, speed: 1 };
let _scenes = [];

async function _buildScenes() {
  // Fetch once per open; each scene is {run: async fn, caption}. See §3
  // for real dataset sources feeding each of these.
  const warming = await fetch("/api/climate/warming-trend/").then(r => r.json());
  const slr     = await fetch("/api/climate/sea-level-rise/").then(r => r.json());
  const events  = await fetch("/api/climate/recent-extreme-events/").then(r => r.json());

  return [
    {
      caption: `Global mean temperature has risen ${warming.delta_c.toFixed(2)}°C since ` +
                `the 1951–1980 baseline, with ${warming.last_year} the ${warming.rank} warmest year on record.`,
      run: async (map) => {
        enableCinematicAtmosphere(map);
        await cinematicFlyTo(map, { center: warming.hottest_region_center, zoom: 3.6, pitch: 40, duration: 2600 });
        await fadeLayerOpacity(map, "gee-warming-trend", "raster-opacity", 0, 0.8, 2000);
      },
    },
    {
      caption: `Under a high-emissions pathway, sea level could rise ${slr.rise_m_2100.toFixed(1)} m ` +
                `by 2100, putting ${slr.pop_exposed_millions.toFixed(1)} million coastal residents at risk.`,
      run: async (map) => {
        await cinematicFlyTo(map, { center: slr.coastal_focus_center, zoom: 7, duration: 2400 });
        await fadeLayerOpacity(map, "gee-warming-trend", "raster-opacity", 0.8, 0, 1200);
        await fadeLayerOpacity(map, "gee-slr-inundation", "fill-opacity", 0, 0.7, 1600);
      },
    },
    {
      caption: `${events.count_this_year} climate-linked disasters have been recorded so far this year — ` +
                `${events.top_type} events are the most frequent, concentrated in ${events.top_region}.`,
      run: async (map) => {
        await fadeLayerOpacity(map, "gee-slr-inundation", "fill-opacity", 0.7, 0, 1200);
        await fadeLayerOpacity(map, "climate-disaster-events", "circle-opacity", 0, 0.9, 1500);
        await cinematicFitBounds(map, NATIONAL_BOUNDS, { duration: 2200 });
      },
    },
  ];
}

async function _playFrom(i) {
  _state.playing = true;
  for (let k = i; k < _scenes.length && _state.playing; k++) {
    _state.index = k;
    await _scenes[k].run(window.map);
    if (_state.ttsEnabled) await speak(_scenes[k].caption, _state.speed);
    else await wait(4500 / _state.speed);       // silent dwell, mirrors NCOP's own fallback pacing
  }
  disableCinematicAtmosphere(window.map);
  _state.playing = false;
}

function _render() {
  const root = document.getElementById("story-root");
  let card = root.querySelector(`#${CARD_ID}`);
  if (!card) {
    card = document.createElement("div");
    card.id = CARD_ID;
    card.innerHTML = `
      <div class="cb-caption"></div>
      <div class="cb-controls">
        <button class="cb-play">▶</button>
        <button class="cb-mute" title="${ttsAvailable() ? "Toggle narration" : "TTS unavailable"}">🔈</button>
      </div>`;
    root.appendChild(card);
    card.querySelector(".cb-play").onclick = () => _playFrom(_state.index);
    card.querySelector(".cb-mute").onclick = () => { _state.ttsEnabled = !_state.ttsEnabled; };
  }
  card.querySelector(".cb-caption").textContent = _scenes[_state.index]?.caption || "";
}

async function _show() {
  const chaptersEl = document.querySelector("#storyChapters");
  if (chaptersEl) chaptersEl.style.display = "none";
  _scenes = await _buildScenes();
  _render();
  _playFrom(0);
}
function _hide() {
  stopSpeaking();
  _state.playing = false;
  const card = document.getElementById(CARD_ID);
  if (card) card.remove();
  const chaptersEl = document.querySelector("#storyChapters");
  if (chaptersEl) chaptersEl.style.display = "grid";
}

// ---- sentinel injection — identical contract to §1.3, copy verbatim ----
function _ensureOption(sel) {
  if (sel.querySelector(`option[value="${SENTINEL}"]`)) return;
  const opt = document.createElement("option");
  opt.value = SENTINEL; opt.textContent = "Climate Briefing";
  sel.appendChild(opt);
}
function _watchSelect(sel) {
  _ensureOption(sel);
  new MutationObserver(() => _ensureOption(sel)).observe(sel, { childList: true });
  document.addEventListener("change", (e) => {
    if (e.target?.id !== SELECT_ID) return;
    if (e.target.value === SENTINEL) _show(); else _hide();
  }, true);
}
export function initStoryClimateBriefing() {
  const sel = document.getElementById(SELECT_ID);
  if (sel) return _watchSelect(sel);
  const mo = new MutationObserver(() => {
    const s = document.getElementById(SELECT_ID);
    if (s) { mo.disconnect(); _watchSelect(s); }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 20000);
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initStoryClimateBriefing);
} else initStoryClimateBriefing();
```

Import it as a side-effect (same as NCOP's `dashboard.js` L58–62):
`import "./modules/story-climate-briefing.js";`.

### Step 5 — TTS: keep the free baseline, add real upgrade paths

**Baseline (Step 5a, recommended default — zero install, zero cost):**
`frontend/src/modules/story-tts.js` extracting NCOP's exact pattern into a
reusable module:

```js
// frontend/src/modules/story-tts.js
let _voicesCache = window.speechSynthesis?.getVoices() || [];
if (!_voicesCache.length && window.speechSynthesis) {
  window.speechSynthesis.addEventListener("voiceschanged",
    () => { _voicesCache = window.speechSynthesis.getVoices(); }, { once: true });
}

export function ttsAvailable() { return !!window.speechSynthesis; }

export function speak(text, speed = 1, lang = null) {
  return new Promise((resolve) => {
    if (!ttsAvailable() || !text) return resolve();
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = Math.min(3, 0.98 * speed);
    if (lang) {
      utter.lang = lang;
      const voice = _voicesCache.find(v => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
      if (voice) utter.voice = voice;
    }
    utter.onend = resolve;
    utter.onerror = resolve;
    window.speechSynthesis.speak(utter);
  });
}
export function stopSpeaking() { try { window.speechSynthesis?.cancel(); } catch (_) {} }
```

**Nothing to install** for this path — every evergreen browser (Chrome,
Edge, Firefox, Safari) ships `speechSynthesis` natively. The only real
"installation" is an **OS-level language pack** if you need a non-English
voice and the OS doesn't already have one (Windows: *Settings → Time &
Language → Language & region → Add a language*; same idea on macOS/Linux).

**Step 5b — when to upgrade, and how.** The Web Speech API's real
limitations: voice quality/selection varies by OS and browser (a Linux
server's headless Chrome has *no* voices at all — irrelevant here since TTS
runs client-side in the operator's own browser, but relevant if CCOP ever
wants **server-rendered narration audio** for offline/export use, e.g. baking
an MP3 into a shareable video briefing). Pick based on that need:

| Need | Recommended | Why |
|---|---|---|
| Live, in-browser narration only (NCOP's own use case) | **Web Speech API** (Step 5a) | Free, zero install, zero latency, no data leaves the browser |
| Consistent voice across all users/OSes, still client-driven | **Azure Cognitive Services Speech SDK** (browser JS SDK) | Neural voices, consistent quality, still runs client-side against a token endpoint |
| Server-rendered audio files (export, offline playback, video) | **Azure Speech / Google Cloud TTS / ElevenLabs REST API** | Produces a real `.mp3`/`.wav` you can cache, download, or mux into a video |
| Fully open-source, self-hosted, no cloud dependency | **Piper TTS** or **Coqui TTS** | On-prem, no API key, no per-character billing — good fit for a government/NDMA-style deployment with data-residency requirements |

**Installation — Azure Cognitive Services Speech (server-rendered audio):**

```bash
pip install azure-cognitiveservices-speech==1.40.0
```

```python
# ccop_stories/tts_azure.py
import azure.cognitiveservices.speech as speechsdk
from django.conf import settings

def synthesize_to_file(text: str, out_path: str, voice="en-US-JennyNeural", lang="en-US"):
    cfg = speechsdk.SpeechConfig(subscription=settings.AZURE_SPEECH_KEY,
                                 region=settings.AZURE_SPEECH_REGION)
    cfg.speech_synthesis_voice_name = voice
    cfg.speech_synthesis_language = lang
    audio_cfg = speechsdk.audio.AudioOutputConfig(filename=out_path)
    synthesizer = speechsdk.SpeechSynthesizer(speech_config=cfg, audio_config=audio_cfg)
    result = synthesizer.speak_text_async(text).get()
    if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
        raise RuntimeError(f"TTS failed: {result.reason} — {result.cancellation_details}")
    return out_path
```

- Get a key: Azure Portal → *Create a resource → Speech* → note **Key** +
  **Region** (`https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices`).
- `.env`: `AZURE_SPEECH_KEY=...`, `AZURE_SPEECH_REGION=eastus` (or your region).
- Urdu neural voice id: `ur-PK-UzmaNeural` (female) / `ur-PK-AsadNeural` (male) —
  confirm current availability at
  `https://learn.microsoft.com/azure/ai-services/speech-service/language-support`.

**Installation — Google Cloud Text-to-Speech:**

```bash
pip install google-cloud-texttospeech==2.17.2
```

```python
from google.cloud import texttospeech

def synthesize(text, lang_code="en-US", voice_name="en-US-Neural2-C"):
    client = texttospeech.TextToSpeechClient()      # picks up GOOGLE_APPLICATION_CREDENTIALS
    resp = client.synthesize_speech(
        input=texttospeech.SynthesisInput(text=text),
        voice=texttospeech.VoiceSelectionParams(language_code=lang_code, name=voice_name),
        audio_config=texttospeech.AudioConfig(audio_encoding=texttospeech.AudioEncoding.MP3),
    )
    return resp.audio_content   # raw MP3 bytes
```

- Enable the API: `https://console.cloud.google.com/apis/library/texttospeech.googleapis.com`.
- Service account + JSON key (same pattern as §"Step 2 — Service account" in
  the GEE→CCOP doc): `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`.

**Installation — ElevenLabs (highest naturalness, paid, simplest REST call):**

```bash
pip install elevenlabs==1.9.0
```

```python
from elevenlabs.client import ElevenLabs

def synthesize(text, voice_id="21m00Tcm4TlvDq8ikWAM"):  # "Rachel", a stock voice id
    client = ElevenLabs(api_key=settings.ELEVENLABS_API_KEY)
    return client.text_to_speech.convert(voice_id=voice_id, text=text,
                                         model_id="eleven_multilingual_v2")
```

- API key: `https://elevenlabs.io/app/settings/api-keys`.
- `eleven_multilingual_v2` covers Urdu/Arabic-script languages reasonably; verify with a real sample before relying on it for safety-critical narration (apply the same "test against real numbers/units" discipline NCOP's own translate.py comment documents for the NLLB choice).

**Installation — Piper (self-hosted, open-source, no API key, no cloud):**

```bash
pip install piper-tts==1.2.0
# download a voice model once (example: US English, medium quality)
python -m piper.download_voices en_US-lessac-medium
# Urdu voice availability: check https://github.com/rhasspy/piper/blob/master/VOICES.md
# (community voice coverage for ur/ar varies — verify before depending on it)
```

```python
import subprocess

def synthesize_piper(text, out_path, model="en_US-lessac-medium"):
    subprocess.run(
        ["piper", "--model", model, "--output_file", out_path],
        input=text.encode("utf-8"), check=True,
    )
    return out_path
```

**Installation — Coqui TTS (self-hosted, open-source, broader multilingual model zoo):**

```bash
pip install TTS==0.22.0        # pulls torch as a dependency — heavy install (~2-4 GB)
```

```python
from TTS.api import TTS

_tts = None
def get_tts():
    global _tts
    if _tts is None:
        _tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")  # first call downloads weights
    return _tts

def synthesize_coqui(text, out_path, speaker="Claribel Dervla", language="en"):
    get_tts().tts_to_file(text=text, file_path=out_path, speaker=speaker, language=language)
    return out_path
```

> **A real, honest trade-off note, matching this project's own discipline
> elsewhere:** self-hosted models (Piper, Coqui, and NCOP's own NLLB
> translation model) avoid per-request cost and external data egress, but
> cost real GPU/CPU + memory on your own server, and their voice/language
> coverage is not guaranteed to match a paid cloud API's. Test the *actual*
> target language against real numbers/units/place-names before shipping —
> NCOP's own `translate.py` comment documents exactly this kind of live A/B
> test catching a real correctness failure (a smaller model corrupting
> "21:00-23:59" into "21:37-23:1"). Apply the same discipline to whichever
> TTS engine you pick.

**A backend TTS endpoint (framework once, swap the engine per §5b):**

```python
# ccop_stories/views_tts.py
import hashlib, os
from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.views import View

CACHE_DIR = os.path.join(settings.MEDIA_ROOT, "story_tts_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

class StoryNarrationView(View):
    """POST {text, lang} -> cached MP3. Swap `synthesize` for whichever
    engine (Azure/Google/ElevenLabs/Piper/Coqui) §5b installed."""
    def post(self, request):
        import json
        body = json.loads(request.body or b"{}")
        text, lang = body.get("text", "").strip(), body.get("lang", "en")
        if not text:
            return JsonResponse({"error": "text required"}, status=400)

        key = hashlib.sha256(f"{lang}|{text}".encode()).hexdigest()[:24]
        path = os.path.join(CACHE_DIR, f"{key}.mp3")
        if not os.path.exists(path):
            from .tts_azure import synthesize_to_file   # or whichever engine
            synthesize_to_file(text, path, lang=lang)
        with open(path, "rb") as f:
            return HttpResponse(f.read(), content_type="audio/mpeg")
```

Frontend swap-in (drop-in replacement for `speak()` in `story-tts.js` when
server-rendered narration is preferred over the browser voice):

```js
export async function speakServer(text, lang = "en") {
  const res = await fetch("/api/story/narration/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, lang }),
  });
  const blob = await res.blob();
  const audio = new Audio(URL.createObjectURL(blob));
  return new Promise((resolve) => { audio.onended = resolve; audio.onerror = resolve; audio.play(); });
}
```

### Step 6 — translation (optional, only if CCOP needs multi-language narration)

Port `translate.py` verbatim if CCOP needs the same English↔local-language
narration toggle NCOP has for Urdu — it's fully generic (any NLLB-200
FLORES-200 language code works, not Urdu-specific; see
`https://github.com/facebookresearch/flores/blob/main/flores200/README.md#languages-in-flores-200`
for the code table). Same install:

```bash
pip install transformers==4.44.2 torch==2.4.0 sentencepiece==0.2.0
```

First call downloads ~2.4 GB of model weights to `HF_HOME` (set this env var
to a drive with room, same as NCOP's own `settings/base.py` L27–31 does).
**Skip this step entirely** if CCOP only ever narrates in one language — it's
a genuinely optional layer, not a hard dependency of Story Mode itself.

### Step 7 — backend data endpoints + caching (the pattern, not the content)

Every NCOP cinematic-story data endpoint follows the same shape — copy it for
CCOP's own climate endpoints (§3 has the actual data sources):

```python
from django.core.cache import cache

class SomeClimateDataView(APIView):
    CACHE_KEY, PRIMARY_TTL, STALE_TTL = "some_climate_data", 6*60*60, 48*60*60

    def get(self, request):
        hit = cache.get(self.CACHE_KEY)
        if hit is not None:
            return JsonResponse(hit)
        try:
            data = self._fetch_and_parse()          # the real, slow work
            cache.set(self.CACHE_KEY, data, self.PRIMARY_TTL)
            cache.set(f"{self.CACHE_KEY}_stale", data, self.STALE_TTL)
            return JsonResponse(data)
        except Exception:
            stale = cache.get(f"{self.CACHE_KEY}_stale")
            if stale is not None:
                return JsonResponse({**stale, "stale": True})
            return JsonResponse({"error": "source unavailable"}, status=503)
```

---

## 3. Part B — what data to actually put in a climate story

The design goal, stated the same way NCOP states it for weather: **real
figures, narrated scene by scene, never scripted/fabricated content.** Below
is a chapter-by-chapter catalog of real, open, fetchable climate datasets,
grouped the way a story's chapters would be.

### 3.1 Chapter: "How much has it already warmed?" (observed trend)

| Source | What | Access |
|---|---|---|
| **NASA GISTEMP v4** | Global/regional monthly & annual mean temperature anomaly, 1880–present | CSV, no key: `https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv` |
| **Berkeley Earth** | Global + country-level land-surface temperature series | `https://berkeleyearth.org/data/` (CSV/NetCDF, no key) |
| **NOAA Climate at a Glance** | US + global monthly/annual temp & precip anomalies | REST API: `https://www.ncdc.noaa.gov/cag/global/time-series` (JSON) |
| **ERA5 reanalysis via GEE** | Gridded observed temp/precip for a specific AOI (Pakistan, a province, a basin) | See `CCOP_GEE_CLIMATE_INTEGRATION.md` §3.1 — reuse that pipeline directly for the raster shown in this scene |

### 3.2 Chapter: "Where is it headed?" (projections/scenarios)

| Source | What | Access |
|---|---|---|
| **NASA NEX-GDDP-CMIP6** | Downscaled, bias-adjusted daily CMIP6 projections, SSP1‑2.6 to SSP5‑8.5, to 2100 | Via GEE (`NASA/GDDP-CMIP6`) — see the CCOP GEE doc §3.2 for the exact compute functions (`cmip6_delta`, `cmip6_hot_days`) |
| **IPCC WGI Interactive Atlas** | Pre-computed regional projection figures/maps, citable, no coding needed for a quick figure | `https://interactive-atlas.ipcc.ch/` (screenshots/embeds; no public API — best for a citation card, not live data) |
| **World Bank Climate Change Knowledge Portal** | Country-level historical + projected climate indicators, CMIP5/CMIP6-derived | REST API: `https://climateknowledgeportal.worldbank.org/api` (see `.../api-reference` on that site) |

### 3.3 Chapter: "Sea-level rise" (already scoped in the GEE doc, §3.3 there)

| Source | What | Access |
|---|---|---|
| **NASA Sea Level Change Portal** | Observed + projected (IPCC AR6-based) sea level rise by scenario/location | `https://sealevel.nasa.gov/task-force-scenario-tool/` — data downloadable as CSV per tide-gauge/grid point |
| **NOAA Sea Level Trends** | Long-term tide-gauge trends, per station | `https://tidesandcurrents.noaa.gov/sltrends/` (CSV export per station) |
| **GEE bathtub inundation** | Visual "what does N meters of rise look like here" raster | Reuse `slr_inundation()` from the GEE doc §3.3 |

### 3.4 Chapter: "Extreme heat" / "Heatwaves"

| Source | What | Access |
|---|---|---|
| **Copernicus Climate Data Store (CDS)** | ERA5 heat indices, Heat Index/WBGT derived products | `pip install cdsapi`; API key from `https://cds.climate.copernicus.eu/api-how-to` (free registration) |
| **NCOP's own Heatwave Monitoring** (already built!) | Live station-level heat data for Pakistan, Open-Meteo-derived | `GET /get-heatwave-monitoring/`, `/get-heatwave-detail/` — if CCOP shares infrastructure/region with NCOP, this is directly reusable; otherwise mirror the same Open-Meteo-backed pattern |

### 3.5 Chapter: "Extreme weather & disaster frequency" (climate-attributed hazards)

NCOP **already has three of these wired in** — directly portable to CCOP,
same endpoints, same GeoJSON shape, zero new backend code needed if CCOP can
reach the same public feeds:

| Source | What | NCOP's own endpoint (copy the view class) |
|---|---|---|
| **GDACS** (Global Disaster Alert and Coordination System) | Real-time floods/cyclones/earthquakes/droughts/volcanoes, severity-scored | `get-gdacs-events/<slug>/`, `get-gdacs-event-details/...` — `GdacsEventsGeojsonApi` |
| **NASA EONET** | Natural event tracker: wildfires, severe storms, volcanoes, ice/snow, drought | `get-nasa-eonet-events/<category>/` — `NasaEonetEventsGeojsonApi` |
| **USGS Earthquake feed** | Real-time seismic events (not climate per se, but a standard "hazards" story chapter) | `get-usgs-earthquake-alerts/` — `UsgsEarthquakeAlertsGeojsonApi` |
| **EM-DAT** (International Disaster Database) | Historical disaster counts/impacts by country/type/year, the standard citation source for "N climate disasters this decade" framing | `https://public.emdat.be/` — free account, CSV/API export |
| **ReliefWeb API** | Real humanitarian/disaster reports, narratives, situation updates | `https://api.reliefweb.int/v1/reports` — no key required, documented at `https://apidoc.reliefweb.int/` |

### 3.6 Chapter: "Glaciers & cryosphere"

| Source | What | Access |
|---|---|---|
| **GLIMS / Randolph Glacier Inventory** | Global glacier outlines + area/volume change | `https://www.glims.org/download/` (shapefiles/geodatabases) |
| **NSIDC** | Sea ice extent, snow cover trends | `https://nsidc.org/data` (various APIs/FTP per dataset) |
| **MODIS NDSI (via GEE)** | Snow-cover trend for a specific AOI — same technique the GEE doc already documents | `MODIS/061/MOD10A1` |

### 3.7 Chapter: "Emissions & the carbon budget"

| Source | What | Access |
|---|---|---|
| **Global Carbon Project** | Annual global/national CO₂ emissions, carbon budget remaining | `https://globalcarbonbudget.org/` (CSV downloads) |
| **Our World in Data — CO2 & GHG dataset** | Cleaned, ready-to-chart CSV of emissions by country/sector/year | `https://github.com/owid/co2-data` (raw CSV, no key, updated regularly) |
| **EDGAR** (Emissions Database for Global Atmospheric Research) | Gridded emissions, sector-level | `https://edgar.jrc.ec.europa.eu/` (downloadable grids) |

### 3.8 Chapter: "Drought & water stress"

| Source | What | Access |
|---|---|---|
| **CHIRPS** (via GEE) | Precipitation anomaly → drought indices | Already in the GEE doc §3.1 |
| **US/Global Drought Monitor-style SPI/SPEI** | Standardized precip/evapotranspiration index | Compute from CHIRPS + ERA5 PET (formula in the GEE doc §3.5) |
| **Aqueduct Water Risk Atlas (WRI)** | Baseline water stress, projected change | `https://www.wri.org/aqueduct` (data download, no key) |

### 3.9 Chapter: "National climate risk context" (closing scene)

| Source | What | Access |
|---|---|---|
| **Germanwatch Global Climate Risk Index** | Country ranking by climate-disaster impact | `https://www.germanwatch.org/en/cri` (annual PDF/data table — good for a citation card) |
| **ND-GAIN Country Index** | Vulnerability + readiness scoring per country | `https://gain.nd.edu/our-work/country-index/` (CSV download) |

### 3.10 A representative CCOP climate-story chapter list

Mirroring NCOP's own two-chapter cinematic structure (§1.1's Chapter 1/2
comment block), a first CCOP "Climate Briefing" story might be:

1. **Opening** — national fly-in, terrain+fog (`enableCinematicAtmosphere`).
2. **Observed warming** — ERA5/GISTEMP trend raster fades in; narration reads
   the real delta-°C and rank-of-year (§3.1).
3. **Projected warming** — CMIP6 ensemble-mean raster for a chosen SSP/horizon
   fades in over the same view; narration states the scenario name in plain
   language ("a high-emissions pathway") plus the number, with the
   ensemble spread if available (§3.2, reusing `cmip6_delta`).
4. **Sea-level risk** (skip if CCOP's AOI is landlocked) — bathtub inundation
   fades in over the coast; narration cites the real rise-by-2100 figure and
   exposed-population estimate (§3.3).
5. **This year's climate-linked disasters** — GDACS/EONET markers pulse in a
   tour across the AOI, real counts/types narrated (§3.5) — this is the
   direct climate analogue of NCOP's own "top-ranked rainfall stations" tour.
6. **Closing** — `cinematicFitBounds` back to the national view, a one-line
   risk-index citation card (§3.9), atmosphere disabled.

---

## 4. Installations checklist (everything referenced above)

```
# --- Python / Django backend ---
[ ] pip install pdfplumber                       # if parsing any PDF report source, like NWFC's
[ ] pip install requests                          # already a near-universal dependency; used throughout
[ ] pip install cdsapi                            # ONLY if pulling Copernicus CDS heat/drought indices
[ ] pip install azure-cognitiveservices-speech==1.40.0   # ONLY if using Azure TTS (§5b)
[ ] pip install google-cloud-texttospeech==2.17.2        # ONLY if using Google Cloud TTS (§5b)
[ ] pip install elevenlabs==1.9.0                        # ONLY if using ElevenLabs (§5b)
[ ] pip install piper-tts==1.2.0                         # ONLY if self-hosting Piper (§5b)
[ ] pip install TTS==0.22.0                              # ONLY if self-hosting Coqui (§5b) — heavy, pulls torch
[ ] pip install transformers==4.44.2 torch==2.4.0 sentencepiece==0.2.0  # ONLY if porting translate.py (Step 6)
[ ] earthengine-api, google-auth, redis            # if wiring the climate-raster chapters — see the GEE doc's own checklist

# --- OS-level ---
[ ] An Urdu/Arabic (or whichever target language) voice pack, IF relying on
    the browser-native Web Speech API baseline for that language — Windows:
    Settings > Time & Language > Language & region > Add a language.
    (Not needed at all for the cloud/self-hosted TTS engines in §5b — they
    ship their own voices.)
[ ] ffmpeg, IF you'll transcode/concatenate TTS output into a downloadable
    video briefing (`apt install ffmpeg` / `choco install ffmpeg`) — not
    required for live in-browser playback.

# --- Frontend / npm ---
[ ] No new npm packages required for Steps 1-4 (pure DOM + Mapbox GL, both
    already dependencies of any CCOP build).
[ ] lucide (icons) — already a NCOP dependency (`window.lucide.createIcons()`
    calls throughout); install if CCOP doesn't already have it:
    npm install lucide

# --- Accounts / API keys ---
[ ] Azure Speech key + region (portal.azure.com → Create a resource → Speech)  — only if §5b Azure
[ ] Google Cloud service account + Text-to-Speech API enabled              — only if §5b Google
[ ] ElevenLabs API key (elevenlabs.io/app/settings/api-keys)               — only if §5b ElevenLabs
[ ] Copernicus CDS API key (cds.climate.copernicus.eu/api-how-to)          — only if §3.4/3.8 CDS
[ ] EM-DAT free account (public.emdat.be)                                  — only if §3.5 EM-DAT
[ ] GEE service account (see CCOP_GEE_CLIMATE_INTEGRATION.md §2 Step 2)    — for every raster-backed chapter
```

---

## 5. Recommended improvements (brief, prioritized)

1. **Cache TTS output server-side** (the `StoryNarrationView` pattern in §5b)
   even for the free browser path is not applicable, but IS essential the
   moment you adopt any paid cloud TTS engine — never pay to re-synthesize
   the same narration text twice; hash `{lang, text}` → cached audio file.
2. **Author climate chapters as data, not code** — a small `climate_story_catalog.py`
   (mirroring `GEEDataCatalog`/`CLIMATE_CATALOG` from the GEE doc) listing
   `{chapter_id, data_endpoint, narration_template, camera_waypoints}` lets
   non-engineers add/edit chapters without touching `story-climate-briefing.js`.
3. **Cross-link to the Scenario Builder** (see `CCOP_GEE_CLIMATE_INTEGRATION.md`
   §5) — a "Build your own scenario" button at the end of the closing scene,
   same `ccop:open-scenario` custom-event handoff pattern already documented
   there.
4. **Graceful multi-voice fallback** for server-rendered TTS the same way
   NCOP's client-side `_pickUrduVoice()` degrades honestly (exact locale →
   language family → same-script fallback → visible warning) — don't let a
   cloud TTS call silently 400 on an unsupported voice/language pair.
5. **A "read the sources" footer** on every chapter — one line naming the
   real dataset behind that scene's number (NCOP already does this
   implicitly via its own module comments; make it visible in-product for a
   climate story, since attribution matters more for climate figures that
   get screenshotted and shared).
6. **Respect data licenses** — CMIP6/NEX-GDDP requires citing the modelling
   groups (noted in the GEE doc); EM-DAT and some CDS products have their own
   attribution/redistribution terms — check each source's own license page
   before shipping a public-facing story built on it.
