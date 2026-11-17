# Frontend UI Architecture Reference — Map Dashboard Control System

## 0. What this document is (and isn't)

This is a **portable design/architecture reference**, extracted from a real, working
production dashboard (a Mapbox GL map with a right-side control rail, slide-in
panels, and a temporal/time-series slider). It exists so that **another AI or
developer can replicate the UI structure, styling system, and interaction
mechanics in a brand-new, unrelated application** — without inheriting anything
specific to the source app's actual data, map layers, or backend API.

**What IS in this document**: the control-rail architecture (how buttons and
panels are registered, positioned, and made mutually exclusive), every distinct
*UI pattern* used by a rail control (toggle-only button, slide-in panel, complex
tabbed panel, full-viewport takeover, floating action button), the temporal
slider's complete DOM/CSS/JS mechanics, the design-token/theming system, and the
general panel/animation CSS conventions. Every code example is **genericized**:
real mechanism names (`RAIL_PANEL_REGISTRY`, `buildUnifiedRightRail`, etc.) are
kept because they describe *behavior*, not the source app; brand colors,
business-specific control names (e.g. an "Export GIS Layers" panel, a "Weather
Report" panel), and any data-loading/API logic have been renamed to generic
placeholders or removed entirely.

**What is NOT in this document, deliberately**: any specific map layer, dataset,
API endpoint, or business logic belonging to the source application. One control
(a "weather report"-style panel, in the source app) is intentionally excluded
completely — it existed only to display the source app's own domain data and has
no generic UI pattern worth extracting beyond what's already covered by the
"complex tabbed panel" pattern below. A couple of other source-app controls
(a raw layer-catalog/data-source manager, and one small popup-launched modal with
no rail button at all) are mentioned only in passing, for the same reason.

Read this top to bottom if starting a port from scratch: §1–2 are prerequisites
(theming, base layout) that everything else depends on visually; §3 is the rail
system itself; §4 is the temporal slider (a self-contained subsystem — a new app
without any time-series data can skip it); §5–6 are the honest critique and a
practical porting checklist.

---

## 1. Design language & theming

The whole UI runs on a **single set of CSS custom properties** (design tokens),
consumed by every component — no component hardcodes a color. This is what makes
a from-scratch reskin (new brand colors, or a light/dark mode) a one-file change.

### 1.1 Token categories

Define these on `:root` (your default/light theme):

```css
:root {
    /* Brand accent colors — pick your own; the source app used three semantic
       accents (a "positive/green", a "primary/blue", a "danger/red"), each with
       four derived shades: solid, a translucent "opaque" fill, a lighter border
       tint, a glow, and a two-stop gradient. */
    --brand-a: #2ecc71;
    --brand-a-opaque: rgba(9, 106, 11, 0.75);
    --brand-a-light: rgba(9, 106, 11, 0.35);
    --brand-a-glow: rgba(9, 106, 11, 0.25);
    --brand-a-gradient: linear-gradient(to right, rgba(28, 169, 30, 0.6), rgba(9, 106, 11, 0.9));

    --brand-b: #46b2ff;
    --brand-b-opaque: rgba(70, 178, 255, 0.75);
    --brand-b-light: rgba(70, 178, 255, 0.35);
    --brand-b-glow: rgba(70, 178, 255, 0.25);
    --brand-b-gradient: linear-gradient(to right, rgba(70, 178, 255, 0.9), rgba(30, 144, 255, 0.6));

    --brand-c: #ff0000;
    --brand-c-opaque: rgba(255, 0, 0, 0.75);
    --brand-c-light: rgba(255, 0, 0, 0.35);
    --brand-c-glow: rgba(255, 0, 0, 0.25);
    --brand-c-gradient: linear-gradient(to right, rgba(255, 76, 76, 0.7), rgba(255, 0, 0, 0.9));

    /* Base glass tones — the raw black/white-with-alpha values every
       background/border token below is built from. */
    --black: #000000;
    --white: #ffffff;
    --glass-dark: rgba(0, 0, 0, 0.6);
    --glass-medium: rgba(0, 0, 0, 0.4);
    --glass-light: rgba(255, 255, 255, 0.2);
    --glass-lighter: rgba(255, 255, 255, 0.15);
    --glass-highlight: rgba(255, 255, 255, 0.25);

    /* Semantic backgrounds — components reference THESE, never the raw
       glass/brand tones directly. This indirection is what makes theme
       switching a token-file-only change. */
    --primary-bg: var(--glass-dark);
    --secondary-bg: var(--glass-medium);
    --tertiary-bg: var(--glass-light);
    --accent-bg-a: var(--brand-a-opaque);
    --accent-bg-b: var(--brand-b-opaque);
    --accent-bg-c: var(--brand-c-opaque);
    --overlay-bg: rgba(255, 255, 255, 0.05);
    --frost-bg: rgba(255, 255, 255, 0.12);

    /* Text */
    --text-primary: rgba(255, 255, 255, 0.95);
    --text-secondary: rgba(255, 255, 255, 0.75);
    --text-muted: rgba(255, 255, 255, 0.55);
    --text-inverse: rgba(0, 0, 0, 0.85);
    --text-accent-a: var(--brand-a);
    --text-accent-b: var(--brand-b);
    --text-accent-c: var(--brand-c);

    /* Borders — subtle and translucent, never a solid opaque color */
    --border-dark: rgba(255, 255, 255, 0.2);
    --border-light: rgba(255, 255, 255, 0.7);
    --border-strong: rgba(0, 0, 0, 0.2);
    --border-a: var(--brand-a-light);
    --border-b: var(--brand-b-light);
    --border-c: var(--brand-c-light);

    /* Button state colors, per accent */
    --btn-a-bg: var(--brand-a-opaque);
    --btn-a-hover: var(--brand-a-gradient);
    --btn-b-bg: var(--brand-b-opaque);
    --btn-b-hover: var(--brand-b-gradient);
    --btn-c-bg: var(--brand-c-opaque);
    --btn-c-hover: var(--brand-c-gradient);

    /* Interaction feedback */
    --focus-ring: var(--brand-b-light);
    --hover-bg: rgba(255, 255, 255, 0.08);
    --active-bg: rgba(255, 255, 255, 0.12);
    --success-bg: var(--brand-a-glow);
    --error-bg: var(--brand-c-glow);
    --info-bg: var(--brand-b-glow);

    /* Depth */
    --shadow-soft: 0 8px 16px rgba(0, 0, 0, 0.25);
    --shadow-glow-a: 0 0 12px 2px var(--brand-a-glow);
    --shadow-glow-b: 0 0 12px 2px var(--brand-b-glow);
    --shadow-glow-c: 0 0 12px 2px var(--brand-c-glow);
}
```

### 1.2 A second theme, via one attribute swap

The source app calls its alternate theme "night," but — worth noting explicitly,
because it's a genuinely good, non-obvious trick — **"night" is a light/paper
theme, not a darker one**. The default theme is dark glass-on-black; the
alternate is light glass-on-white. Same token *names*, inverted *values*:

```css
[data-theme="alt"] {
    --primary-bg: rgba(190, 190, 190, 0.88);
    --secondary-bg: rgba(180, 180, 180, 0.85);
    --tertiary-bg: rgba(200, 200, 200, 0.90);
    --overlay-bg: rgba(195, 195, 195, 0.75);
    --frost-bg: rgba(205, 205, 205, 0.80);

    --text-primary: rgba(0, 0, 0, 0.95);
    --text-secondary: rgba(20, 20, 20, 0.90);
    --text-muted: rgba(40, 40, 40, 0.85);
    --text-inverse: rgba(255, 255, 255, 0.95);

    --border-dark: rgba(120, 120, 120, 0.35);
    --border-light: rgba(110, 110, 110, 0.45);
    --border-strong: rgba(90, 90, 90, 0.65);

    --hover-bg: rgba(170, 170, 170, 0.88);
    --active-bg: rgba(155, 155, 155, 0.92);
    --focus-ring: rgba(70, 70, 70, 0.75);
    --glass-highlight: rgba(210, 210, 210, 0.92);
}
```

Toggled purely by setting `data-theme="alt"` on `<html>` — no class juggling
elsewhere, no component-level theme logic. **Every component-level CSS file
should only ever add a `[data-theme="alt"] .my-component { ... }` override block
for the handful of things token substitution can't reach** (e.g. an SVG `fill`
that isn't `currentColor`, or a box-shadow whose color needs a different alpha
curve in the light theme, not just a different base color). If you find yourself
overriding more than a few properties per component, the component is using raw
colors instead of tokens somewhere — fix that instead of piling up overrides.

A sub-component (like a control rail, below) can define its OWN small token set
the same way, scoped to just what it needs:

```css
:root {
    --rail-bg:     rgba(28, 32, 40, 0.55);
    --rail-border: rgba(255, 255, 255, 0.10);
    --rail-inset:  rgba(0, 0, 0, 0.35);
    --rail-hi:     rgba(255, 255, 255, 0.08);
    --rail-drop:   rgba(0, 0, 0, 0.28);
}
[data-theme="alt"] {
    --rail-bg:     rgba(210, 214, 220, 0.55);
    --rail-border: rgba(0, 0, 0, 0.12);
    --rail-inset:  rgba(255, 255, 255, 0.45);
    --rail-hi:     rgba(255, 255, 255, 0.55);
    --rail-drop:   rgba(0, 0, 0, 0.15);
}
```

### 1.3 Visual identity, in one sentence

Everything is **glassmorphic**: translucent backgrounds + `backdrop-filter: blur(...)`
+ a thin translucent border + a soft outer shadow, over a full-bleed map. Rounded
corners (`8px`–`16px`), never sharp. Icons throughout are a single icon-font/SVG
set at a consistent stroke weight (the source app uses Lucide) — mixing icon
styles is the fastest way to make this look assembled rather than designed.

---

## 2. Base layout: the map as canvas, everything else floats on top

```html
<style>
  body { margin: 0; padding: 0; overflow: hidden; }
  #map {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    width: 100%;
    height: 100vh;
  }
</style>
<body>
  <div id="app-skeleton" aria-hidden="true">...</div>       <!-- optional loading skeleton -->
  <div class="app-header-card">...</div>                     <!-- fixed, top-left, viewport-relative -->
  <div id="sidebarPanel" class="sidebar-panel">...</div>      <!-- fixed, left edge, viewport-relative -->
  <div id="map"></div>                                        <!-- the map library mounts its canvas here -->
  <div id="temporal-slider" style="display:none;">...</div>   <!-- absolute, sibling of #map -->
  <div id="bottom-ticker" class="bottom-ticker">...</div>     <!-- absolute, sibling of #map -->
</body>
```

Two genuinely different positioning strategies coexist, and the distinction
matters for anyone porting this:

- **`position: fixed`, viewport-relative** — the header card, a left sidebar,
  anything that should stay put regardless of what's happening to the map
  underneath. These sit as `<body>` children *before* `#map` in DOM order.
- **`position: absolute`, sibling-of-`#map`** — the temporal slider and any
  bottom ticker/toast. Because `<body>` itself isn't `position: relative`, their
  absolute coordinates are *effectively* viewport-relative too, but they were
  hand-placed to visually read as "inside" the map area (e.g. a slider inset
  from the map's own edges) without being DOM-nested inside `#map`.
- **Everything the control-rail system manages is `appendChild`-ed directly
  INTO `#map`** at runtime by JS (§3) — not a separate overlay div, not
  DOM-nested siblings. This means every rail button and every rail panel's
  `position: absolute` is relative to `#map`'s own box (which is itself
  `position: absolute`, establishing that containing block).

Mount the map library against the empty `#map` div and immediately suppress its
own default UI chrome except whatever one piece you want to keep (the source app
keeps only a scale bar):

```js
const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/streets-v12",
  center: [/* your default center */],
  zoom: 6,
  hash: true,
});
map.addControl(new mapboxgl.ScaleControl({ maxWidth: 200, unit: "metric" }), "bottom-right");
```

```css
.mapboxgl-ctrl-group { display: none !important; }
.mapboxgl-ctrl-top-right { display: none !important; }
.mapboxgl-ctrl-bottom-right { display: none !important; }
.mapboxgl-ctrl-bottom-right:has(.mapboxgl-ctrl-scale) {
    display: flex !important;
    flex-direction: column;
    align-items: flex-end;
    margin: 0 16px 6px 0 !important;
    pointer-events: none;
    z-index: 5;
}
```

---

## 3. The control rail system

This is the core reusable mechanism. It solves one problem well: **N independent
feature modules, each owning one button and (usually) one panel, need to end up
visually unified in a single vertical rail, with only one panel ever open at a
time, without every module having to know about every other module.**

The trick is a **two-phase build**: every module renders its OWN button into
its own throwaway wrapper first (usually straight into `#map`, or into a small
number of legacy grouping wrappers), completely independently. Then, once, after
every module has finished initializing, one function walks the DOM, physically
moves (not clones) each button node into one shared rail container in a
deliberate order, and re-parents every registered panel to be a sibling of that
rail inside `#map`. Because it's a DOM *move*, not a re-render, every button's
already-attached event listeners survive intact.

### 3.1 Data structures

Three plain objects/arrays drive everything. Keep them as the single source of
truth — do not duplicate panel-open/close logic ad hoc per module once these
exist (the source app has some legacy per-module leftovers that do exactly that,
and it's a real wart — see §5).

```js
// Panels whose visibility is a CSS class toggle (the common case).
const RAIL_PANEL_BUTTON_MAP = {
  examplePanelA: { btnId: "toggleA", visibleClass: "visible" },
  examplePanelB: { btnId: "toggleB", visibleClass: "visible" },
  // one legacy exception is fine to support if you need it:
  legacyPanel:   { btnId: "legacyToggle", visibleClass: "legacy-panel-visible" },
};

// Panels whose visibility is inline style.display (a second family — see the
// critique in §5 about why you should probably NOT do this in a fresh build).
const RAIL_FLOAT_PANEL_BUTTON_MAP = {
  exampleModal: "modalToggleBtn",
};

// The authoritative registry: every closeable panel in the app, its
// visibility-detection strategy, and (optionally) its trigger button's own
// "active" class to strip when force-closed.
const RAIL_PANEL_REGISTRY = [
  { id: "examplePanelA", kind: "class", cls: "visible",
    btn: { id: "toggleA", activeCls: "active-a" } },
  { id: "examplePanelB", kind: "class", cls: "visible",
    btn: { id: "toggleB", activeCls: "active-b" } },
  { id: "exampleModal",  kind: "display",
    btn: { id: "modalToggleBtn", activeCls: "active-modal" } },
];
```

### 3.2 Assembling the rail (run once, after every module has initialized)

```js
function buildUnifiedRail() {
  const map = document.getElementById("map");
  if (!map) return;

  let rail = document.querySelector(".control-rail");
  if (!rail) {
    rail = document.createElement("div");
    rail.className = "control-rail";
    map.appendChild(rail);
  }

  const buttonOrder = [];
  const seen = new Set();
  const push = (el) => { if (el && !seen.has(el)) { seen.add(el); buttonOrder.push(el); } };

  // Deliberate, hand-picked order — this is your actual information
  // architecture decision, not something to derive automatically.
  push(document.querySelector(".nav-toggle-btn"));   // the rail's own collapse toggle, if you want it first
  push(document.getElementById("toggleA"));
  push(document.getElementById("toggleB"));
  push(document.getElementById("modalToggleBtn"));
  // ...every other rail button, in the order you want them to appear...

  buttonOrder.forEach((b) => {
    rail.appendChild(b);       // MOVES the node — listeners survive
    b.classList.add("rail-btn");
  });

  // Re-parent every registered panel to sit as a sibling of the rail, inside #map.
  Object.keys(RAIL_PANEL_BUTTON_MAP).forEach((panelId) => {
    const p = document.getElementById(panelId);
    if (!p) return;
    if (p.parentElement !== map) map.appendChild(p);
    p.classList.add("right-rail-panel");
  });

  // Optional: a self-collapsing rail (see 3.3's CSS for `.collapsed`)
  const toggle = rail.querySelector(".nav-toggle-btn");
  if (toggle && !toggle.dataset.railToggleWired) {
    toggle.dataset.railToggleWired = "true";
    toggle.addEventListener("click", () => rail.classList.toggle("collapsed"));
  }
}
```

Call this **once**, on `DOMContentLoaded`, strictly *after* every feature
module has already run its own constructor (so every button/panel node already
exists in the DOM to be found and moved):

```js
document.addEventListener("DOMContentLoaded", () => {
  initEveryFeatureModule();   // each one renders its own button+panel independently
  buildUnifiedRail();
  setupRailPanelAnchoring();          // §3.4
  setupStrictRailMutualExclusion();   // §3.5
});
```

### 3.3 Rail & button visual conventions

The rail container itself — a frosted vertical strip, scroll-capable if it
overflows the viewport height, with a layered inset/outset shadow for a subtle
3D "frosted glass edge" effect:

```css
.control-rail {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 5px;
    background: var(--rail-bg);
    backdrop-filter: blur(10px);
    border: 1px solid var(--rail-border);
    border-radius: 12px;
    box-shadow:
        inset 0 1px 0 var(--rail-hi),
        inset 0 -1px 2px var(--rail-inset),
        0 6px 18px var(--rail-drop);
    max-height: calc(100vh - 20px);
    overflow-y: auto;
    scrollbar-width: none;
}
```

Every button gets **uniform geometry enforced centrally** — individual modules
should only ever supply resting/hover/active *colors*, never size:

```css
.control-rail > .rail-btn {
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    min-height: 32px !important;
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 8px !important;
    border: 1px solid var(--rail-border) !important;
    box-sizing: border-box !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    transition:
        transform 0.25s ease, opacity 0.18s ease, height 0.2s ease,
        width 0.2s ease, margin 0.2s ease, padding 0.2s ease,
        border 0.2s ease, background 0.2s ease, visibility 0s linear 0s;
}
.control-rail > .rail-btn i,
.control-rail > .rail-btn svg {
    width: 13px !important;
    height: 13px !important;
}
```

Per-module color convention (repeat this shape for every button, swapping only
the class name and the accent color):

```css
.control-rail > .my-feature-btn {
    background: var(--secondary-bg) !important;
    backdrop-filter: blur(10px) !important;
    color: var(--white) !important;
    cursor: pointer;
}
.control-rail > .my-feature-btn:hover:not(.active-my-feature) {
    background: var(--primary-bg) !important;
}
.control-rail > .my-feature-btn.active-my-feature {
    background: var(--brand-b) !important;
    border-color: var(--brand-b) !important;
    color: #fff !important;
}
[data-theme="alt"] .control-rail > .my-feature-btn {
    background: var(--tertiary-bg) !important;
    backdrop-filter: blur(12px) saturate(105%) !important;
    box-shadow:
        0 2px 8px rgba(0, 0, 0, 0.15),
        0 1px 2px rgba(0, 0, 0, 0.10),
        inset 0 1px 0 rgba(255, 255, 255, 0.25) !important;
}
```

Collapse behavior (paired with the toggle wiring in §3.2):

```css
.control-rail.collapsed > .rail-btn:not(.nav-toggle-btn) {
    width: 0 !important; height: 0 !important; margin: 0 !important;
    padding: 0 !important; border: none !important; opacity: 0 !important;
    visibility: hidden;
}
```

**Icon rule**: use one icon set, one stroke weight, and — this is a real,
non-obvious gotcha worth stating plainly — **check your icon set for near-duplicate
glyphs before assigning two different buttons a visually-similar icon**. Two
controls in the source app once used icons that looked almost identical at
13×13px; it was only caught in a live visual review, not by any tooling. There's
no automated check for this — a human (or an AI with the actual icon rendered)
has to look at the assembled rail once before shipping.

### 3.4 Panel chrome & slide-in animation

Every panel, after being re-parented under `.right-rail-panel` by §3.2, shares
one animation contract — `transform: translateX` + `opacity`, never animating
`left`/`right` directly (that fights the browser's compositor and looks
noticeably janky compared to a transform):

```css
.right-rail-panel {
    position: absolute !important;
    bottom: auto !important;
    left: auto !important;
    transform: translateX(20px) !important;
    opacity: 0 !important;
    pointer-events: none !important;
    visibility: hidden !important;
    transition:
        transform 0.28s cubic-bezier(0.32, 0.72, 0.34, 1),
        opacity 0.22s ease,
        visibility 0s linear 0.28s !important;
    z-index: 1001 !important;
}
.right-rail-panel.visible {
    transform: translateX(0) !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    visibility: visible !important;
    transition:
        transform 0.28s cubic-bezier(0.32, 0.72, 0.34, 1),
        opacity 0.22s ease,
        visibility 0s linear 0s !important;
}
```

Note the `visibility` transition-delay trick: `visibility` flips to `hidden`
only *after* the fade-out finishes (delay matches the opacity duration), so
focus/pointer-events genuinely leave the DOM flow only once the panel is
actually invisible — but flips back to `visible` with **zero** delay when
opening, so the fade-in is visible from frame one. Get this backwards and
panels either flash open instantly then animate, or take an extra 0.28s to
become interactive after they're already visually open.

Panel chrome itself (a header with title/subtitle/close, plus a scrollable
content area) — this exact shape repeats across every panel in the source app
regardless of how simple or complex its content is:

```css
.example-panel {
    position: absolute;
    top: 0;
    right: 42px;              /* clears the rail's own width + gap */
    width: 300px;             /* 280-340px depending on content density */
    max-height: 480px;
    background: var(--primary-bg);
    border: 2px solid var(--border-light);
    border-radius: 8px;
    backdrop-filter: blur(15px);
    box-shadow: 0 8px 32px var(--shadow-soft);
    display: flex;
    flex-direction: column;
    overflow: hidden;         /* header stays put; only .panel-content scrolls */
}
.example-panel-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 12px 10px;
    border-bottom: 1px solid var(--border-dark);
    flex-shrink: 0;
}
.example-panel-content {
    padding: 10px 12px 12px;
    overflow-y: auto;
}
```

### 3.5 Registry-driven mutual exclusion (the important part)

**The problem this solves**: with N independently-built panels, "close every
other panel when one opens" naively means every module needs a hardcoded list
of every *other* module's panel id — an O(N²) coupling that breaks the moment
you add module N+1 and forget to update the other N modules' lists. (The source
app actually has exactly this legacy pattern lingering in a few older modules —
see §5.2. Don't copy that part.)

**The fix**: one `MutationObserver` per registry entry, watching only its OWN
visibility-driving attribute. The instant any one panel's observer sees it
become visible, it closes every *other* registry entry — no panel needs to know
any other panel's identity, only that the shared registry exists.

```js
function setupStrictRailMutualExclusion() {
  const isVisible = (entry) => {
    const el = document.getElementById(entry.id);
    if (!el) return false;
    if (entry.kind === "class") return el.classList.contains(entry.cls);
    const d = el.style.display;
    return !!(d && d !== "none");
  };

  const closeEntry = (entry) => {
    const el = document.getElementById(entry.id);
    if (!el) return;
    if (entry.kind === "class") el.classList.remove(entry.cls);
    else el.style.display = "none";
    if (entry.btn) document.getElementById(entry.btn.id)?.classList.remove(entry.btn.activeCls);
  };

  let suppressing = false;   // re-entrancy guard — see below

  const closeOthers = (activeId) => {
    if (suppressing) return;
    suppressing = true;
    try {
      RAIL_PANEL_REGISTRY.forEach((entry) => {
        if (entry.id === activeId) return;
        if (isVisible(entry)) closeEntry(entry);
      });
    } finally {
      suppressing = false;
    }
  };

  RAIL_PANEL_REGISTRY.forEach((entry) => {
    const el = document.getElementById(entry.id);
    if (!el) return;
    const obs = new MutationObserver(() => {
      if (suppressing) return;
      if (isVisible(entry)) closeOthers(entry.id);
    });
    obs.observe(el, {
      attributes: true,
      attributeFilter: entry.kind === "class" ? ["class"] : ["style"],
    });
  });
}
```

The `suppressing` flag matters: without it, `closeEntry()` mutating another
panel's class/style would fire THAT panel's own observer, which would call
`closeOthers()` again, cascading pointlessly (and, depending on timing, possibly
re-opening or double-closing something). It's a simple synchronous lock, not a
debounce — cheap and sufficient because all of this runs synchronously within
one microtask.

**Consequence for every individual panel module**: since this registry-level
observer will force-close a panel from *outside* that panel's own code
(bypassing whatever `hidePanel()` method the module itself has), every module
that keeps its own `#isVisible` boolean needs to **resync that boolean** when it
notices the panel was closed out from under it — otherwise a later click on that
module's own toggle button will see its internal flag say "already closed" when
the button says "open," and do nothing:

```js
// Inside each panel module's own constructor/setup:
new MutationObserver(() => {
  if (this.#isVisible && !panelEl.classList.contains("visible")) {
    this.#isVisible = false;
    toggleBtnEl.classList.remove("active-my-feature");
  }
}).observe(panelEl, { attributes: true, attributeFilter: ["class"] });
```

Also wire the standard "click outside to close" per panel:

```js
document.addEventListener("click", (event) => {
  if (!this.#isVisible) return;
  const path = event.composedPath ? event.composedPath() : [event.target];
  const insidePanel = path.some((el) => el?.id === "examplePanelA");
  const onButton = path.some((el) => el?.id === "toggleA");
  if (!insidePanel && !onButton) this.hidePanel();
});
```

### 3.6 Panel-to-button position anchoring

If panels are meant to appear docked next to their own trigger button (rather
than all stacked at a fixed `top: 0`), recompute each panel's position relative
to its button on every rail interaction and on resize:

```js
function anchorRailPanelsToButtons() {
  const map = document.getElementById("map");
  const rail = document.querySelector(".control-rail");
  if (!map || !rail) return;

  const mapRect = map.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  const rightOffset = mapRect.right - railRect.left + 8;

  Object.entries(RAIL_PANEL_BUTTON_MAP).forEach(([panelId, { btnId }]) => {
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!panel || !btn) return;
    if (panel.dataset.userPositioned === "true") return;   // opt-out for user-dragged panels

    const btnRect = btn.getBoundingClientRect();
    panel.style.top = `${btnRect.top - mapRect.top}px`;
    panel.style.right = `${rightOffset}px`;
  });
}

function setupRailPanelAnchoring() {
  const rail = document.querySelector(".control-rail");
  // Capture phase — anchoring must run BEFORE the button's own click handler
  // toggles the panel's visibility class, or the freshly-opened panel will
  // render one frame at its stale position first.
  if (rail) rail.addEventListener("click", anchorRailPanelsToButtons, true);
  window.addEventListener("resize", anchorRailPanelsToButtons);
  requestAnimationFrame(anchorRailPanelsToButtons);
}
```

### 3.7 The five UI patterns a rail control can use

Every control in the source app's rail is one of these five. Pick the simplest
one that fits — most controls should be pattern A or B; reach for C only when a
control genuinely has multiple sub-sections or tabs; D and E are rare,
special-purpose escapes from the rail-panel model entirely.

**Pattern A — toggle-only button, no panel.** The button IS the whole feature;
clicking it flips a boolean and an `.active-*` class, nothing more:

```js
document.getElementById("toggleA")?.addEventListener("click", () => {
  const isOn = myFeatureToggleFunction();   // your own on/off logic, returns new state
  document.getElementById("toggleA")?.classList.toggle("active-a", isOn);
});
```
No panel markup exists at all for this pattern. Use it for direct map actions
(zoom, recenter, a map overlay effect toggle) that need no configuration UI.

**Pattern B — simple slide-in panel.** A button plus one panel with a single
piece of content (a form, a list, a single embedded third-party widget):

```js
export class ExampleSimplePanelControl {
  #map; #buttonEl; #panelEl;

  constructor(map) {
    this.#map = map;
    this.#renderButton();
    this.#renderPanel();
    this.#wireToggle();
  }

  #renderButton() {
    const mapEl = document.getElementById("map");
    const wrap = document.createElement("div");
    wrap.className = "custom-example-control";
    wrap.innerHTML = `
      <button id="toggleA" class="custom-example-btn" type="button" title="Example">
        <i data-lucide="search"></i>
      </button>`;
    mapEl.appendChild(wrap);
    window.lucide?.createIcons();
    this.#buttonEl = wrap.querySelector("#toggleA");
  }

  #renderPanel() {
    const mapEl = document.getElementById("map");
    this.#panelEl = document.createElement("div");
    this.#panelEl.id = "examplePanelA";
    // Pre-stamp right-rail-panel even before buildUnifiedRail() runs, so
    // there's never a flash-of-visible-panel before the rail system takes over.
    this.#panelEl.className = "example-panel right-rail-panel";
    mapEl.appendChild(this.#panelEl);
    this.#panelEl.innerHTML = `<div class="example-panel-content">...</div>`;
  }

  #wireToggle() {
    this.#buttonEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !this.#panelEl.classList.contains("visible");
      this.#panelEl.classList.toggle("visible", willOpen);
      this.#buttonEl.classList.toggle("active-a", willOpen);
    });
  }
}
```

**Pattern C — complex multi-section panel.** Same button/panel skeleton as B,
but the panel has a persistent header + a persistent tab bar (wired ONCE, not
re-wired per render) + a content `<div>` whose `innerHTML` is fully replaced on
every tab switch or state change:

```js
#render() {
  const mapEl = document.getElementById("map");
  const wrap = document.createElement("div");
  wrap.className = "custom-example-control";
  wrap.innerHTML = `
    <button id="toggleC" class="custom-example-c-btn" type="button" title="Example">
      <i data-lucide="download"></i>
    </button>
    <div id="examplePanelC" class="example-panel">
      <div class="example-panel-header">
        <div class="example-panel-title-group">
          <span class="example-panel-title">Example Panel</span>
          <span class="example-panel-subtitle">One line of context.</span>
        </div>
        <button id="exampleClose" class="example-panel-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="example-panel-tabs">
        <button type="button" class="example-tab active" data-tab="one">One</button>
        <button type="button" class="example-tab" data-tab="two">Two</button>
      </div>
      <div id="exampleContent" class="example-panel-content"></div>
    </div>
  `;
  mapEl.appendChild(wrap);
  window.lucide?.createIcons();
}

// Called on open, and again every time the active tab or underlying state changes.
#renderContent() {
  const content = document.getElementById("exampleContent");
  content.innerHTML = this.#activeTab === "two"
    ? `<div>...tab two markup...</div>`
    : `<div>...tab one markup, rebuilt from current state...</div>`;
}
```

The load-bearing rule here: **the tab bar's own click listeners are attached
once, outside `#renderContent()`**, delegating to whatever's currently in
`#exampleContent` — never re-attach listeners inside the function that rebuilds
that div's `innerHTML`, or you'll leak a new listener on every render.

**Pattern D — full-viewport takeover.** For a feature big enough that a rail
panel can't hold it (the source app uses this for a side-by-side map-compare
view: a second, fully independent map instance rendered in a split-screen
overlay with its own draggable divider). The rail button toggles a boolean and
builds/tears down an entirely separate DOM subtree and, if needed, a second
instance of your map library — it does **not** touch the rail-panel system at
all:

```js
toggle() { this.#state.active ? this.deactivate() : this.activate(); }

activate() {
  this.#state.active = true;
  this.#btnEl?.classList.add("active-split");
  document.body.classList.add("split-active");   // a body-level class is the
                                                    // simplest way to let global
                                                    // CSS react to this mode
  this.#buildOverlayAndDivider();
  this.#secondMapInstance = new mapboxgl.Map({ container: this.#innerEl, interactive: false, /* ... */ });
}
```

**Pattern E — floating action button outside the rail.** For one, singular,
always-visible entry point (the source app uses this for an assistant/chat
launcher rendered as a free-floating mascot/FAB) that deliberately does NOT live
in the rail — because it's meant to be discoverable independent of whether the
rail is collapsed, or because it has its own persistent visual identity that
would be diminished by rail-button uniformity:

```js
#renderMascot() {
  const mapEl = document.getElementById("map");
  const el = document.createElement("div");
  el.id = "assistantMascot";
  el.className = "assistant-mascot";
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  mapEl.appendChild(el);
  el.addEventListener("click", () => this.togglePanel());
}
```
Its own panel, if it has one, can still be added to `RAIL_PANEL_REGISTRY` for
mutual-exclusion purposes even though its *button* never enters the rail —
registry membership and rail membership are independent (`RAIL_PANEL_REGISTRY`
entries have an *optional* `btn`, and nothing requires that button to be a rail
child).

---

## 4. The temporal / time-series slider

A self-contained, reusable subsystem for scrubbing through a sequence of
time-stamped map layers (e.g. daily satellite composites, hourly forecast
frames). Skip this whole section if your app has no time-series data — but if
it does, this is the single most valuable piece to replicate faithfully; getting
the frame-switching mechanism right (opacity crossfade, not add/remove) is what
makes it feel smooth instead of flickery.

### 4.1 DOM structure

```html
<div id="temporal-slider" style="display:none;">
    <div class="ts-layout">
        <!-- Row 1: Transport | Timeline | Drag handle -->
        <div class="ts-row ts-row--timeline">
            <div class="ts-panel ts-panel--transport">
                <button id="playBtn" title="Play/Pause"><i data-lucide="play"></i></button>
                <button id="pauseBtn" title="Play/Pause" style="display:none;"><i data-lucide="pause"></i></button>
                <button id="speedBtn" class="speed-btn" title="Change speed">1x</button>
            </div>

            <div class="ts-panel ts-panel--timeline">
                <div class="ts-date-labels"></div>              <!-- JS-populated tick labels -->
                <div class="ts-slider-track">
                    <input type="range" min="0" step="1" value="0" class="ts-slider" id="tsSlider" title="Drag to change time step">
                </div>
            </div>

            <button id="dragHandle" class="ts-panel ts-panel--drag" title="Reposition slider">
                <i data-lucide="move"></i>
            </button>
        </div>

        <!-- Row 2: Current layer | Legend | Opacity -->
        <div class="ts-row ts-row--legend">
            <div class="ts-panel ts-panel--variable">
                <button id="tsRemoveBtn" class="ts-variable-icon" type="button" title="Remove layer" aria-label="Remove layer">
                    <i data-lucide="trash-2"></i>
                </button>
                <div class="ts-variable"><p></p></div>          <!-- JS fills in layer name + a "current date" pill -->
            </div>
            <div class="ts-panel ts-panel--legend">
                <div id="tsLegendContainer"></div>               <!-- JS-injected gradient/swatch legend -->
            </div>
            <button id="opacityBtn" class="ts-panel ts-panel--opacity" title="Opacity" aria-expanded="false" aria-controls="opacityPopover">
                <i data-lucide="blend"></i>
            </button>
        </div>
    </div>

    <!-- Direct child of the slider root (not nested inside .ts-layout) so it
         escapes the layout's own overflow clipping. -->
    <div id="opacityPopover" role="dialog" aria-hidden="true">
        <div class="opacity-popover-row">
            <span class="opacity-popover-label">Opacity</span>
            <input id="opacityRange" type="range" min="0" max="100" step="5" />
            <span id="opacityValueLabel" class="opacity-popover-value">100%</span>
        </div>
    </div>
</div>
```

Two-row / three-panel-per-row grid. Sits as a sibling of `#map` in the DOM
(§2), positioned to visually overlay it.

### 4.2 CSS

```css
#temporal-slider {
    position: absolute;
    top: 13px;
    left: 405px;     /* tune to clear whatever fixed UI sits at top-left */
    right: 80px;      /* tune to clear the control rail */
    background-color: var(--primary-bg);
    border: 1px solid var(--glass-lighter);
    border-radius: 14px;
    display: none;
    backdrop-filter: blur(14px);
    box-shadow: var(--shadow-soft);
    z-index: 1001;
    touch-action: none;
    box-sizing: border-box;
}
#temporal-slider > .ts-layout {
    display: flex;
    flex-direction: column;
    width: 100%;
    border-radius: inherit;
    overflow: hidden;
}
.ts-row { display: flex; align-items: stretch; width: 100%; height: 72px; box-sizing: border-box; }
.ts-row--timeline { border-bottom: 1px solid var(--border-dark); }
.ts-panel { display: flex; align-items: center; box-sizing: border-box;
    transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease; }

/* Transport panel */
.ts-panel--transport { flex-shrink: 0; gap: 10px; padding: 0 18px;
    background: var(--overlay-bg); border-right: 1px solid var(--border-dark); }
#playBtn, #pauseBtn {
    width: 40px; height: 40px; border-radius: 50%;
    background: var(--brand-b-opaque); border: 1px solid var(--brand-b-light);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
}
.speed-btn { width: auto; min-width: 40px; height: 28px; padding: 0 10px;
    border-radius: 4px; background: var(--overlay-bg); border: 1px solid var(--border-dark);
    font-size: 12px; font-weight: 500; }

/* Timeline panel */
.ts-panel--timeline {
    --date-inset: 40px;   /* recompute in JS to fit your widest label — see 4.3 */
    flex: 1 1 auto; min-width: 0; padding: 10px var(--date-inset);
    background: var(--frost-bg); flex-direction: column; justify-content: space-between; gap: 6px;
}
.ts-date-labels { position: relative; width: 100%; height: 22px; margin-bottom: 14px; }
.ts-date-labels span {
    position: absolute; top: 0; padding: 2px 8px;
    font-size: 12px; font-weight: 500; color: var(--text-secondary);
    border: 1px solid transparent; border-radius: 4px; white-space: nowrap;
    cursor: pointer; transform: translateX(-50%); transition: all 0.2s ease;
}
/* A small tick mark under every label, active one becomes a glowing dot */
.ts-date-labels span::after {
    content: ""; position: absolute; top: calc(100% + 6px); left: 50%;
    transform: translateX(-50%); width: 3px; height: 10px; border-radius: 2px;
    background: var(--border-light);
}
.ts-date-labels span.is-active {
    color: #fff; background: var(--brand-b);
    border-color: rgba(255, 255, 255, 0.85);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.ts-date-labels span.is-active::after {
    top: calc(100% + 4px); width: 14px; height: 14px; border-radius: 50%;
    background: #fff; border: 2.5px solid var(--brand-b);
    box-shadow: 0 0 10px rgba(70, 178, 255, 0.7);
}
.ts-slider {
    -webkit-appearance: none; width: 100%; height: 6px;
    background: var(--border-dark); border-radius: 999px; outline: none; cursor: pointer;
}
/* Thumb rendered invisible on purpose — the glowing dot on the active date's
   OWN tick (above) is the real visual indicator of position, so there's only
   ONE moving indicator on screen, not two slightly-misaligned ones. */
.ts-slider::-webkit-slider-thumb {
    -webkit-appearance: none; width: 16px; height: 16px;
    background: transparent; border: none; box-shadow: none; cursor: pointer;
}

/* Variable/legend/opacity panels */
.ts-panel--variable { flex-shrink: 0; min-width: 220px; gap: 14px; padding: 0 18px;
    background: var(--frost-bg); border-right: 1px solid var(--border-dark); }
.ts-variable p { margin: 0; font-size: 13px; font-weight: 500; color: var(--text-primary); }
.ts-variable .ts-current-date {
    display: inline-flex; align-items: center; gap: 6px; width: fit-content; max-width: 100%;
    margin-top: 5px; padding: 3px 10px 3px 8px; font-size: 12px; font-weight: 700; color: #fff;
    background: var(--brand-b); border: 1px solid var(--brand-b-light); border-radius: 999px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.20), 0 2px 8px var(--brand-b-glow);
    font-variant-numeric: tabular-nums;
}
.ts-variable .ts-current-date::before {
    content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: #fff; animation: ts-date-pulse 1.6s ease-in-out infinite;
}
@keyframes ts-date-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.55; transform: scale(0.75); } }

.ts-legend-bar {
    position: relative; width: 100%; height: 14px; border-radius: 4px;
    box-shadow: 0 0 0 1px var(--glass-lighter), inset 0 1px 2px -1px rgba(0, 0, 0, 0.35);
    overflow: hidden;
}

.ts-panel--opacity { flex-shrink: 0; width: 56px; justify-content: center;
    background: var(--overlay-bg); border: none; border-left: 1px solid var(--border-dark); color: var(--text-muted); }
#opacityPopover {
    display: none; position: absolute; padding: 8px 10px;
    background: var(--primary-bg); border: 1px solid var(--border-dark); border-radius: 6px;
    box-shadow: var(--shadow-soft); z-index: 9999; min-width: 220px; backdrop-filter: blur(10px);
}
```

### 4.3 JS behavior

**Ownership model**: build this as ONE shared/singleton slider that any part of
your app can hand a frame sequence to — don't build a bespoke slider per data
type. The contract is simple: whoever wants to show a time series calls one
function with an array of frames; the slider owns everything else (play state,
current index, DOM).

```js
// The generic contract your data-loading code calls into:
//   frames: [{ date: "2024-01-01", layerIds: ["layer-frame-0"] }, { date: "2024-01-02", layerIds: [...] }, ...]
//   Each frame's layerIds are map-library layer ids ALREADY ADDED to the map
//   (this module does not fetch or add layers — that's your app's job).
function showTimeSeries(frames) {
  sliderLayers = frames.map(f => f.layerIds);   // module-level array-of-arrays
  buildDateLabels(frames.map(f => f.date));
  document.getElementById("temporal-slider").style.display = "";
  showTimeStepLayers(0);
}
```

**Play / pause / speed**:

```js
const speedLevels = [0.5, 1, 2, 3];
let currentSpeedIndex = 1;
let interval = null;

function playAnimation() {
  interval = setInterval(() => {
    const maxVal = parseInt(slider.max);
    const currentVal = parseInt(slider.value);
    const nextVal = currentVal < maxVal ? currentVal + 1 : 0;   // loops back to start
    slider.value = nextVal;
    showTimeStepLayers(nextVal);
  }, 1000 / speedLevels[currentSpeedIndex]);
}

playBtn.addEventListener("click", () => {
  clearInterval(interval);
  playAnimation();
  playBtn.style.display = "none";
  pauseBtn.style.display = "inline-block";
});
pauseBtn.addEventListener("click", () => {
  clearInterval(interval);
  pauseBtn.style.display = "none";
  playBtn.style.display = "inline-block";
});
speedBtn.addEventListener("click", () => {
  currentSpeedIndex = (currentSpeedIndex + 1) % speedLevels.length;
  speedBtn.textContent = `${speedLevels[currentSpeedIndex]}x`;
  if (interval) { clearInterval(interval); playAnimation(); }   // restart at new speed if already playing
});
```

**Manual scrub** and **clicking a date label** both converge on the same
handler by having the label-click path dispatch a synthetic `input` event
rather than duplicating the frame-switch call:

```js
slider.addEventListener("input", () => showTimeStepLayers(parseInt(slider.value)));

// Inside buildDateLabels(), per label span:
labelSpan.addEventListener("click", () => {
  slider.value = index;
  slider.dispatchEvent(new Event("input"));
});
```

**Frame switching — the one detail that actually matters for smoothness**:
switch frames via *paint opacity*, never by adding/removing layers or toggling
`visibility`. Adding/removing a layer per frame forces the map library to
re-parse a style layer and re-attach any interaction handlers every single
frame; toggling `visibility` avoids the reparse but still causes a visible
"pop" since there's no fade. Fading the old frame to 0 and the new frame up to
your target opacity, back to back, reads as a smooth crossfade even at 3x
speed:

```js
let lastStepIndex = null;
let globalOpacityFactor = 1;   // separate 0-1 multiplier, driven by the opacity popover

function showTimeStepLayers(stepIndex) {
  if (lastStepIndex !== null && sliderLayers[lastStepIndex]) {
    sliderLayers[lastStepIndex].forEach(id => setLayerOpacity(id, 0));
  }
  if (sliderLayers[stepIndex]) {
    sliderLayers[stepIndex].forEach(id => setLayerOpacity(id, 0.75 * globalOpacityFactor));
  }
  lastStepIndex = stepIndex;
  updateActiveDateLabel(stepIndex);
}

// Resolve the correct paint property per layer TYPE — this varies by map
// library, but the principle (one opacity property per renderer type) holds
// generally. Cache the resolved property name per layer id; querying a
// layer's own type on every single frame is wasted work at animation speed.
const opacityPropCache = new Map();
function setLayerOpacity(layerId, value) {
  let prop = opacityPropCache.get(layerId);
  if (!prop) {
    const type = map.getLayer(layerId)?.type;
    prop = { raster: "raster-opacity", fill: "fill-opacity", line: "line-opacity",
              circle: "circle-opacity", symbol: "icon-opacity" }[type] || "raster-opacity";
    opacityPropCache.set(layerId, prop);
  }
  if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, value);
}
```

**Date-label layout** — because label text width is unpredictable (dates,
month names, whatever your data uses), position labels by *percentage across
the track* and recompute the panel's own side padding so the first/last labels
never get visually clipped:

```js
function buildDateLabels(dates) {
  const container = document.querySelector(".ts-date-labels");
  container.innerHTML = dates.map((d, i) => {
    const pct = dates.length > 1 ? (i / (dates.length - 1)) * 100 : 50;
    return `<span style="left:${pct}%" data-index="${i}">${d}</span>`;
  }).join("");
  slider.max = String(dates.length - 1);
  recomputeDateInset();   // measure the widest rendered label, set --date-inset accordingly
}
```

**Global opacity popover** (independent of per-frame opacity — this is a
user-controlled multiplier on top of it):

```js
opacityBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = opacityPopover.style.display === "block";
  opacityPopover.style.display = isOpen ? "none" : "block";
  opacityBtn.setAttribute("aria-expanded", String(!isOpen));
});
opacityRange.addEventListener("input", () => {
  const pct = Math.max(0, Math.min(100, parseInt(opacityRange.value || "100", 10)));
  globalOpacityFactor = pct / 100;
  opacityValueLabel.textContent = `${pct}%`;
  if (sliderLayers[lastStepIndex]) {
    sliderLayers[lastStepIndex].forEach(id => setLayerOpacity(id, 0.75 * globalOpacityFactor));
  }
});
```

**Drag-to-reposition** (the move-handle button in row 1):

```js
let dragging = false, dragOffsetX = 0, dragOffsetY = 0;
dragHandle.addEventListener("mousedown", (e) => {
  dragging = true;
  const rect = sliderRoot.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
  sliderRoot.style.right = "auto";   // pin current width so left-based dragging doesn't fight right:
  sliderRoot.style.width = `${rect.width}px`;
});
document.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  sliderRoot.style.left = `${e.clientX - dragOffsetX}px`;
  sliderRoot.style.top = `${e.clientY - dragOffsetY}px`;
});
document.addEventListener("mouseup", () => { dragging = false; });
```

**The "current step" pill needs a `MutationObserver`, not just an event
listener** — this is a genuinely non-obvious gotcha, worth stating explicitly
so it isn't rediscovered the hard way: the play-animation loop above advances
frames by setting `slider.value = x` directly in JS, which does **not** fire
the input's native `input`/`change` event (only real user interaction does).
Anything that needs to react to "the current frame changed" *regardless of
whether a human or the autoplay loop caused it* has to watch something that
changes reliably in both cases — the active date-label's own class flip is a
good signal, since `updateActiveDateLabel()` runs unconditionally inside
`showTimeStepLayers()`:

```js
new MutationObserver(() => {
  const activeLabel = document.querySelector(".ts-date-labels span.is-active");
  if (activeLabel) updateCurrentStepPill(activeLabel.textContent);
}).observe(document.querySelector(".ts-date-labels"), {
  attributes: true, attributeFilter: ["class"], subtree: true,
});
```

---

## 5. Critique

### 5.1 What genuinely works well — keep these

- **Token-driven theming.** No component hardcodes a color anywhere observed;
  swapping the entire visual identity (or adding a whole new theme) is a
  CSS-variable-file change, not a find-and-replace across dozens of files.
- **The registry + `MutationObserver` mutual-exclusion pattern (§3.5).** This is
  the single best idea to copy wholesale. It scales to an arbitrary number of
  panels with zero per-module coordination code, and — because it observes the
  DOM rather than intercepting function calls — it correctly catches a panel
  being closed by literally any code path (a keyboard shortcut, a programmatic
  close from unrelated app logic, a different registry entry's own close),
  not just clicks on that panel's own button.
- **Move, don't clone, when assembling the rail.** `appendChild` on an
  already-existing DOM node relocates it without disturbing attached event
  listeners. This lets every feature module stay completely ignorant of the
  rail's existence and be developed/tested in isolation.
- **Non-destructive frame switching in the temporal slider.** Opacity crossfade
  instead of add/remove keeps click handlers and hover states stable across an
  entire animation loop — worth the small extra bookkeeping (`opacityPropCache`).
- **Consistent panel chrome regardless of content complexity.** A one-line form
  and a six-thousand-line tabbed data-import panel use *exactly* the same
  header/close/content-scroll shell. A user (or an AI extending the app later)
  never has to re-learn panel conventions per feature.

### 5.2 What NOT to copy verbatim

- **Two competing panel-visibility mechanisms** (`RAIL_PANEL_BUTTON_MAP`'s
  class-toggle family vs. `RAIL_FLOAT_PANEL_BUTTON_MAP`'s inline-`display`
  family) exist side by side, apparently because the `display`-based ones
  predate the class-based convention and were never migrated. This means the
  positioning/anchoring code (§3.6) has to be duplicated in two parallel
  versions (one keyed off `classList`, one off `style.display`), and anyone
  adding a new panel has to remember which family to use and why. **In a fresh
  build, pick ONE mechanism (the class-toggle one — it composes better with
  CSS transitions) and never introduce the second.**
- **Legacy per-module "close these other panels" lists coexisting with the
  registry.** Several older modules still carry their own hardcoded array of
  sibling panel ids to blank out on open — functionally superseded by §3.5's
  registry, but never deleted. They're harmless (redundant, not conflicting)
  but they're exactly the O(N²) coupling the registry was built to eliminate,
  left in place. **Delete these once the registry exists; don't leave both.**
- **Heavy reliance on `!important`.** The rail-button geometry rules, the
  panel slide-in animation, and several color overrides are all `!important`.
  This was presumably necessary once, to win specificity fights against older,
  more specific per-panel selectors written before the shared conventions
  existed — but it means every new component has to actively fight the same
  battle rather than simply not needing to. **Establish the shared rail/panel
  base classes FIRST, with normal specificity, before any per-feature CSS is
  written, and this entire category of problem disappears.**
- **Hand-tuned pixel offsets** (the temporal slider's `left: 405px; right: 80px`,
  a panel's `right: 42px`) are brittle: they were tuned against one specific
  header/rail width and will visibly misalign the moment either changes size.
  Prefer deriving these from the actual measured geometry of the elements
  they're clearing (as §3.6 already does for panel anchoring) rather than a
  magic number, wherever it's not significantly more code to do so.
- **A `MutationObserver` per panel, per concern.** Panels in this system
  commonly end up with two or three separate observers watching the same
  element for different reasons (mutual-exclusion, self-resync, the
  current-step pill). Individually justified, but if porting this to a new
  app, consider whether a single shared observer dispatching a custom event
  (`panel:visibility-changed`) that multiple listeners subscribe to would be
  cheaper and clearer than N independent observers on the same node.

### 5.3 A note on scope creep

The single biggest practical risk in replicating this architecture is
under-scoping the "complex panel" pattern (§3.7-C) and then organically growing
a simple panel into a complex one without ever refactoring it onto that shape.
The source app's most complex panels grew to well over a thousand lines each
by accretion. If a "simple" panel (§3.7-B) gains a second logically-distinct
section, that is the moment to restructure it onto the header+tabs+content
shape — not after it's grown a third and fourth section with no seams between
them.

---

## 6. Porting checklist

If replicating this in a new application, roughly in this order:

1. **Tokens first.** Define your own `:root` custom properties (§1.1) before
   writing a single component. Pick your brand accent(s) and decide if you
   want a second theme; if so, define its token overrides now too (§1.2), even
   if you don't wire up the toggle UI yet.
2. **Base layout.** Get the map (or whatever your app's "canvas" is) filling
   the viewport, with the mount-point div `position: absolute; inset: 0`
   (§2). Confirm any default library UI chrome is suppressed except what you
   intentionally keep.
3. **The rail shell, empty.** Build `.control-rail`'s own CSS (§3.3) and the
   `buildUnifiedRail()`/anchoring/mutual-exclusion functions (§3.2, §3.5, §3.6)
   BEFORE building any real feature module. Test it with two or three throwaway
   dummy buttons/panels first, to confirm the assembly, exclusion, and
   anchoring mechanics all work in isolation.
4. **One real feature per pattern, as a template.** Build exactly one control
   using pattern A, one using B, and one using C (§3.7) — real enough to
   prove the pattern, not yet your full feature set. Confirm each correctly
   participates in the shared registry and rail.
5. **Everything else.** Add your actual feature modules, each following
   whichever of the five patterns fits, each registering itself in
   `RAIL_PANEL_BUTTON_MAP`/`RAIL_PANEL_REGISTRY` — never inventing its own
   parallel visibility or exclusion mechanism (§5.2's warning).
6. **The temporal slider, if needed** (§4) — build it as a standalone,
   singleton module with the generic `showTimeSeries(frames)` contract from
   §4.3, decoupled from any specific feature's data-loading code, so any
   number of features can hand it a frame sequence without it knowing what
   they are.
7. **Visual QA pass.** Actually look at the assembled rail with every button
   present — check for icon collisions, spacing, and hover/active states in
   BOTH themes before considering the port done. Several of the real bugs this
   architecture has hit in production (icon collisions, wrong active-state
   colors) were only ever caught by looking at the rendered result, never by
   any code review alone.
