# GCOP "PMD Weather" Report Tab — Feature, Style & Integration Guide

**Scope of this document:** the `PMD Weather` tab (`#wrp-tab-glof`, title *"PMD Weather Data & Observations"*) inside GCOP's floating Weather Report panel. This is a companion document to `GCOP_PMD_API_Integration.md` (the raw API reference) — this one documents the **feature that consumes those APIs**: its UI, behavior, internal architecture, and a step-by-step guide for rebuilding an equivalent feature on another platform that already has the same APIs available.

---

## 1. What it is, and how a user reaches it

The "PMD Weather" tab is one of four tabs inside a single shared floating panel (`#weather-report-panel`) — the others are **Weather** (Meteoblue point forecast), **Disasters** (global disaster monitoring), and **ENSO** (ENSO real-time monitor). All four tabs share one panel shell; only the active tab's content is rendered into `#weather-report-panel-content` at a time.

**Entry point:** a map toolbar control button, id `mapbox-gl-weather-report`, title *"Generate Weather Report"*. Clicking it dispatches a custom DOM event (`gcop-weather-report`) which opens the panel (or closes it if already open on the same tab — a toggle). Once open, clicking the `PMD Weather` tab button (or programmatically calling `showPmdWeatherReport()`) switches to this tab and renders it.

```
User clicks toolbar button
  → openWeatherReportControl() dispatches "gcop-weather-report"
  → listener opens the panel, defaults to the "weather" tab
  → user clicks "PMD Weather" tab
  → _ncopWeatherReportSetActiveTab("glof") + showPmdWeatherReport()
```

`showPmdWeatherReport()` is also called directly (bypassing the tab click) from several other places in the app — e.g. toggling any PMD-related sidebar layer while the panel is already open on this tab triggers a live re-render, so the panel never goes stale relative to the sidebar.

---

## 2. Visual style

- **Panel chrome:** a floating, **draggable** (via a header grip handle) and **resizable** (bottom-right corner handle) glass panel. `position: absolute`, default anchored bottom-right of the map viewport, `min-width: 280px`, capped at `min(540px, 100vw-24px)` wide × `min(65vh, 635px)` tall.
- **Material:** dark glassmorphism — `backdrop-filter: blur(24px) saturate(1.6)`, a near-black-to-navy diagonal gradient background, a soft cyan-blue border (`rgba(70,178,255,0.28)`), and an animated pulsing glow border while open (`wrp-border-pulse`, 4s loop). Thin corner-bracket accents (top-left/bottom-right `::before`/`::after`) give it a "sci-fi HUD" feel consistent with the rest of GCOP's dark theme.
- **Header:** drag handle (6-dot grip icon) + title/subtitle + the 4 tab buttons + a close (`×`) button, on a subtle horizontal gradient strip with an animated top glow line.
- **Tabs:** plain text buttons (`Weather` / `Disasters` / `PMD Weather` / `🌊 ENSO`), active tab gets a distinct highlight class (`wrp-tab--active`).
- **Content color language — every data category has a consistent accent color used across its toggle button, section label, and card border**, so a user can pattern-match by color without reading labels:

  | Category | Accent |
  |---|---|
  | PMD NWFC Observations | cyan `#7dd3fc` |
  | Pakistan Weather Stations | green `#86efac` |
  | PMD Monitor Warnings | red `#fca5a5` |
  | Lightning | amber `#fde68a` |
  | Monitor Stations (SYNOP/METAR/AWS) | blue `#93c5fd` |
  | GLOF Stations | teal `#67e8f9` |
  | City Forecast | violet `#c4b5fd` |
  | FFD River Telemetries | green `#86efac` |
  | Warning severity (independent scale) | blue→yellow→orange→red→cyan(gust)→purple(thunderstorm) |
  | Temperature heat-scale (report tables) | yellow→orange→red as temp rises, blue below 10°C |

- **Density:** intentionally compact — 8–11px font sizes throughout, tight padding, scrollable inner card lists (`max-height` + `overflow-y:auto` per section) so a data-dense sidebar-style panel doesn't need to grow unbounded.
- **Micro-interactions:** spinning ⟳ loading glyphs (CSS `animation: spin 1s linear infinite`) while a section's data is in flight; collapsible warning groups (▾/▸); "+N more" expanders for long lists; a "📖 Read" button that lazy-loads full press-release text inline instead of navigating away.

---

## 3. Internal architecture

### 3.1 State model

The tab has **no server-side session state** — it's entirely client-rendered from:
1. **Live DOM state** — which sidebar layer checkboxes are currently checked (read fresh on every render via `document.querySelector('input[data-layername="..."]')?.checked`).
2. **Module-level cache variables** — one GeoJSON cache per data type, populated lazily:

   | Variable | Populated by | Cleared when |
   |---|---|---|
   | `_pmdNwfcGeoJSON` | `/api/pmd/nwfc/observations/` | layer toggled off |
   | `_pmdFawsGeoJSON` | `/get-weather-pmdffd-data/` | layer toggled off |
   | `_pmdMonStationsGeoJSON` | `/api/pmd/monitor/stations/` | layer toggled off |
   | `_pmdMonGlofGeoJSON` | `/api/pmd/monitor/glof-obs/` | layer toggled off |
   | `_pmdMonCityFcGeoJSON` | `/api/pmd/monitor/city-forecast/` | layer toggled off |
   | `_pmdMonWarnings` | `/api/pmd/monitor/warnings/` | layer toggled off |
   | `_ffdReportCache` | `/get-ffd-waterlevels/` | layer toggled off |

3. **A handful of UI-only state variables** — `_warnEleFilter` (Set of selected hazard-type filter chips), `_pmdMonLtHours` (lightning time-window selector value).

### 3.2 The core render loop

`showPmdWeatherReport()` is a **full re-render, not a diff/patch** — every call rebuilds the entire `#weather-report-panel-content` innerHTML from scratch, string-templated from current state. This keeps the logic simple (no reconciliation bugs) at the cost of re-creating DOM nodes on every state change; acceptable here because renders are user-triggered (a click), not high-frequency.

Pattern per data section:
```
if (layerChecked) {
  section = cacheVar
    ? buildCardsFrom(cacheVar)      // already have data → render immediately
    : spinnerPlaceholder;            // no data yet → show spinner, kick off fetch below
} else {
  section = "";                      // layer off → section not rendered at all
}
```
Immediately after setting `content.innerHTML`, the function checks each cache variable — if a layer is checked but its cache is still `null`, it fires the fetch, and on success populates the cache **and** directly patches just that section's DOM node (`document.getElementById("pmd-obs-cards-list").innerHTML = ...`) rather than re-invoking the whole-panel rerender — a small optimization to avoid a full re-render finishing after (and undoing) unrelated user interaction that happened during the fetch.

### 3.3 The "MAP LAYERS" toggle buttons are two-way bound to the sidebar

Each toggle button in the panel is not its own independent control — clicking it:
1. Finds the real sidebar `<input type="checkbox">` for that layer (`data-layer-id` or `data-layer-query` on the button).
2. Calls `.click()` on it — this fires the sidebar's own existing checkbox-change handling (adds/removes the actual map layer, exactly as if the user had opened the sidebar and clicked it there — **no separate toggle logic is duplicated**).
3. Then re-renders the whole panel (`showPmdWeatherReport()`), which now reads the updated checked state.

One layer (**PMD Monitor Warnings**) is gated: it can't be switched on until at least one hazard-type filter chip is selected — clicking it while ungated flashes a "↑ select a filter first" message on the button instead of toggling.

### 3.4 Drill-down sub-views ("PMD NWFC DATA PANELS")

Six buttons (`Daily Forecast`, `Rainfall Reports`, `Max Temp Records`, `Press Releases`, `Weekly Outlook`, `FFD Bulletins`) each replace the **entire panel content** with a dedicated sub-view (not a modal/overlay — a full content swap), via `renderPMDPanelInReport(viewType)`:
- Renders a header with a `← Back` button (returns to the main view by calling `showPmdWeatherReport()` again) and a source attribution (`PMD NWFC · weather.gov.pk` or `FFD · ffd.pmd.gov.pk`).
- Fetches exactly **one** endpoint for that view type (see §4 table).
- Each view type has its own bespoke renderer (a styled table for forecast/max-temp, a card list for rainfall/releases/bulletins, highlighted prose blocks for the weekly outlook with hazard-keyword highlighting).
- Errors are caught and shown inline (`Error: <message>`) rather than breaking the panel.

### 3.5 Security posture worth replicating

- **All scraped/third-party text is HTML-escaped before insertion** (`escapeHtml()`), specifically called out in the FFD Bulletins renderer since that content is scraped from a third-party page.
- **The bulletin `download_url` is validated server-side** (must match `https://ffd.pmd.gov.pk/bulletin/<id>/download` exactly) before the API ever returns it — the frontend trusts it only because the backend already constrained it, not because the frontend re-validates.
- No credentials of any kind reach the browser for any of these calls — PMD Monitor's internal auth, if any, is handled entirely server-side by the proxying Django endpoints.

---

## 4. Feature-by-feature map to APIs

| Panel section | Endpoint(s) | Notes |
|---|---|---|
| MAP LAYERS toggles | (sidebar layer state only — no direct fetch from the toggle itself) | |
| NWFC Live Observations cards | `GET /api/pmd/nwfc/observations/` | |
| Pakistan Weather Stations cards | `GET /get-weather-pmdffd-data/` | not covered in the API-integration doc — a separate FAWS endpoint |
| Monitor Stations cards | `GET /api/pmd/monitor/stations/` | |
| GLOF Stations cards | `GET /api/pmd/monitor/glof-obs/` | |
| City Forecast cards | `GET /api/pmd/monitor/city-forecast/` | |
| PMD Monitor Warnings | `GET /api/pmd/monitor/warnings/` | client-side grouped by hazard, filtered by chip selection, click-to-zoom uses the feature's own geometry |
| FFD River Telemetries cards | `GET /get-ffd-waterlevels/` | only fetched if the `ffd` sidebar layer is checked |
| "Daily Forecast" panel | `GET /api/pmd/nwfc/forecast/` | |
| "Rainfall Reports" panel | `GET /api/pmd/nwfc/reports/` (filtered client-side to `kind === "Daily Rainfall"`) | |
| "Max Temp Records" panel | `GET /api/pmd/nwfc/max-temperatures/` | |
| "Press Releases" panel | `GET /api/pmd/nwfc/reports/` (filtered to `kind === "Press Release"`) + `GET /api/pmd/nwfc/press-release-text/?url=...` on demand | |
| "Weekly Outlook" panel | `GET /api/pmd/nwfc/weekly-outlook/` | |
| "FFD Bulletins" panel | `GET /get-ffd-bulletins/` | |
| Download Report (HTML/CSV) | fetches **6 endpoints unconditionally** (`forecast`, `max-temperatures`, `reports`, `observations`, `weekly-outlook`, `get-ffd-bulletins`) **+ reuses cache or fetches** `get-weather-pmdffd-data`, `glof-obs`, `city-forecast`, `monitor/stations` **+ conditionally** `get-ffd-waterlevels` (only if the FFD layer is on) | see §5 |

All endpoint details (params, response shapes, caching) are in `GCOP_PMD_API_Integration.md` §2–4 — this document intentionally doesn't repeat them.

---

## 5. Download Report (export)

Two formats, both client-generated from the same fetched dataset (no server-side report generation):

- **HTML** — a complete standalone report document (inline-styled, includes a table of contents / section anchors), triggers a browser file download.
- **CSV** — flat per-section blocks (`=== SECTION: X ===` markers), each with its own header row, prefixed with a `=== REPORT CONTENTS ===` index listing every section and its record count, a UTF-8 BOM prepended (`﻿`) so Excel renders °/³/em-dash characters correctly, and a `Classification` disclaimer line ("Restricted operational use — verify before operational use").

**Important divergence from the live panel:** the live panel only shows sections for currently-**toggled-on** layers. The downloaded report is a broader, best-effort **point-in-time snapshot** — it always pulls the 6 core NWFC/FFD-bulletin endpoints regardless of toggle state, opportunistically reuses whatever's already cached for the toggle-gated sections, and only includes FFD river data if that layer happens to be on. If you replicate this feature, decide deliberately whether your "export" should mirror exactly what the user is looking at, or (as GCOP does) attempt a more complete snapshot — they are different design choices with different tradeoffs (completeness vs. "what you see is what you get").

There is intentionally **no PDF export** in the current version — a prior print-based PDF path was removed as unreliable; HTML (which any browser can print-to-PDF itself) and CSV are the supported formats.

Every individual fetch in the export is wrapped in `Promise.allSettled`, not `Promise.all` — one endpoint failing (e.g. a scrape timeout) degrades that one section gracefully rather than failing the entire export.

---

## 6. Step-by-step: building an equivalent feature on a new platform

Assumes your platform already has access to the same (or equivalent) PMD/FFD API endpoints — either GCOP's own (per `GCOP_PMD_API_Integration.md`) or your own re-implementation of the same data contracts.

1. **Decide your panel shell.** You don't need GCOP's exact drag/resize/glass styling — a fixed sidebar, a modal, or a dedicated page all work. What matters functionally is: one container you can fully re-render, and a way to switch between a "main view" and "drill-down sub-views" (even a simple client-side router state is enough).

2. **Model your layer/section toggles as booleans**, one per data category you want to support (observations, stations, warnings, GLOF, city forecast, river telemetry, etc.). Each toggle controls both (a) whether that section renders at all, and (b) whether its data should be fetched.

3. **Fetch lazily, cache per-session, clear on toggle-off.** Don't fetch a section's data until its toggle turns on for the first time; keep the result in memory (a simple module-level variable, a React/Vue store, whatever fits your stack) so re-rendering the panel doesn't re-fetch; drop the cache when the toggle turns off so stale data doesn't reappear if it's turned back on later without an explicit refresh.

4. **Render each section independently, tolerant of partial failure.** One endpoint being slow or down should never blank the whole panel — show a spinner/placeholder per section while its own fetch is pending, and an inline error only within that section if it fails.

5. **Build drill-down sub-views as full-content swaps with a Back button**, each backed by exactly one endpoint fetch, rather than trying to cram every dataset into one scrollable view. This keeps each view's rendering logic isolated and easy to reason about independently.

6. **If you support warnings/alerts data**, group by hazard type, sort newest-first, collapse all but the most recent group by default, and offer a severity/type filter — this is the single most information-dense section in GCOP's version and benefits the most from progressive disclosure.

7. **Escape everything scraped from a third party** before inserting into the DOM (or use a framework that does this by default, e.g. React/Vue's default text interpolation) — several of these endpoints proxy scraped HTML/PDF content, not structured APIs with guaranteed-clean strings.

8. **For export, decide your own scope contract explicitly** (see §5's "important divergence" note) and document it for your users — don't leave it ambiguous whether "download" means "what I'm currently looking at" or "everything available".

9. **Wire a single, discoverable entry point** — GCOP uses one toolbar button dispatching a custom event that any part of the app can also trigger programmatically (e.g. clicking a related sidebar layer while the panel is closed can open it directly to the relevant tab). A custom-event-based open/toggle pattern like this decouples "what triggers the panel" from "how the panel opens," which is worth keeping even if you don't replicate anything else here.

10. **Reuse a consistent accent-color-per-category language** if your platform shows several of these data types simultaneously (as GCOP's does) — it measurably speeds up visual scanning once a user learns "cyan = observations, teal = GLOF," etc. If you're only surfacing one or two categories, this matters less.

---

*Verified against the live GCOP frontend source (`gcop-i-map.js`, `gcop-in-home.html`, `styles.css`) on 2026-07-22. Function/selector names (`showPmdWeatherReport`, `renderPMDPanelInReport`, `#wrp-tab-glof`, etc.) are cited for traceability if you need to cross-check current behavior against source — they are GCOP-internal implementation details, not a public contract, and may be refactored over time even if the feature behavior stays the same.*
