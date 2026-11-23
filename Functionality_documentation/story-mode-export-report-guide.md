# Story Mode "Export Report" — Architecture & Replication Guide

**Written for:** a developer porting GCOP's Story Mode PDF/DOCX export feature into NCOP (a separate Django + Vite + Mapbox GL JS application with its own Story Mode cinematic).

This document has two parts. **Part 1** documents exactly how GCOP's `📄 Export Report` button works today — real code, real file:line references, nothing paraphrased from memory. **Part 2** is a from-scratch replication guide for NCOP, written as a portable pattern rather than a copy-paste of GCOP's file, since NCOP's own Story Mode data model is different.

All line numbers refer to `project/project/static/src/gcop-i/gcop-i-map.js` in the GCOP repo as of 2026-11-23.

---

## Part 1 — How GCOP's Export Report actually works

### 1.1 The trigger

```html
<button type="button" class="gcop-story-export-btn" id="gcop-story-export-btn"
        title="Export this story as a report (works without playing it first)">📄 Export Report</button>
```
*(gcop-i-map.js:23326)*

Clicking it doesn't export immediately — it toggles a small format-choice menu (PDF vs. Word):

```js
document.getElementById("gcop-story-export-btn").addEventListener("click", _storyToggleExportFormatChoice);
```
*(gcop-i-map.js:23391)*

Picking a format calls `_storyExportReport(format)` with `format` = `"pdf"` or `"docx"`.

**Key design point**: export works *without playing the story first*. It doesn't read anything off the screen or off whatever scene happens to be showing — it independently re-fetches the story's own data and re-drives the map camera, exactly like a fresh headless run of the story's data layer. This is why the button's own tooltip says "works without playing it first."

### 1.2 The dispatcher — `_storyExportReport(format)`

*(gcop-i-map.js:24938-25059)*

This is the orchestration function. Its job, in order:

1. **Read whatever's currently selected** in the story picker (story id, and if that story has a region picker, whichever region checkboxes are checked) — reused as-is, no separate export-time UI.
2. **Capture a baseline** of the live map (`_storyCaptureBaseline()`) — the exact same snapshot/restore mechanism real story playback uses — because export is about to fly the camera and may toggle hazard layers on. The `finally` block always restores it, success or failure:
   ```js
   const exportBaseline = _storyCaptureBaseline();
   try {
     /* ... everything below ... */
   } finally {
     await _storyRestoreBaseline(exportBaseline);
     _storyExportSetBusy(false);
   }
   ```
3. **Build a step checklist up front** — a different list per story type, so every row (including per-region rows) is visible and "pending" before any network call starts, rather than appearing mid-export:
   ```js
   const steps = isRegional
     ? [
         { key: "inventory", label: isGlobalDisaster ? "Loading hazard data" : "Loading weekly weather data" },
         ...regionsForSteps.map((r) => ({ key: `region-${r.rnum}`, label: `Capturing ${r.sub}` })),
         { key: "compile", label: "Compiling report" },
         { key: "download", label: "Downloading" },
       ]
     : /* ...isEnso / fallback variants... */;
   _storyExportProgressInit(steps);
   const markStep = (key, ok = true) => _storyUpdateChecklistRow(key, ok);
   ```
   This reuses the *exact same* checklist markup/CSS as the pre-story loading screen (`_storyRenderLoadingChecklist`) — one shared row-marking function (`_storyUpdateChecklistRow`) for both, not two parallel UI systems.
4. **Build a `meta` object** (title, subtitle, generated timestamp, a report reference code) — one literal per story, not derived generically from the story catalog label:
   ```js
   const meta = isGlobalDisaster
     ? { id: story.id, title: "Global Hazard Situation Report", subtitle: "...", generatedAt: new Date(), ref: `NEOC/GCOP/GHSR/${refDateStamp}` }
     : isWeeklyWeather ? { /* ... */ }
     : isEnso ? { /* ... */ }
     : { id: story.id, title: story.label, subtitle: story.description, generatedAt: new Date() };
   ```
5. **Dispatch to exactly one of three story-specific section builders** — this is the real heart of the architecture:
   ```js
   let sections;
   if (isGlobalDisaster) {
     sections = await _storyExportGlobalDisasterReport(exportCtl, markStep);
   } else if (isWeeklyWeather) {
     sections = await _storyExportWeeklyWeatherReport(exportCtl, markStep);
   } else if (isEnso) {
     sections = await _storyExportEnsoReport(exportCtl, markStep);
   } else {
     // generic fallback for any story with no dedicated report builder yet:
     // a single map snapshot + its sourcesLabel
     const snapshot = await exportCtl.captureSingleFrameFromMapCanvas(null, { delayMs: 300 });
     sections = [{ heading: "Current Map View", bodyHtml: `<p>${_ncopEscapeHtml(story.sourcesLabel || "")}</p>`, imageDataUrl: snapshot }];
   }
   ```
6. **Hand `sections` + `meta` to exactly one of two format-agnostic renderers**:
   ```js
   if (format === "docx") { await _storyBuildReportDocx(meta, sections); }
   else { await _storyBuildReportPdf(meta, sections); }
   ```

This is the single most important architectural fact in the whole system: **the three story-specific functions never touch jsPDF or docx at all.** They only ever produce an array of plain-object "sections." The renderers don't know or care which story produced the sections. This decoupling is what makes adding a 4th story (or, in NCOP's case, an entirely different set of stories) cheap — you write one new `_storyExportXScene(exportCtl, markStep)` function that returns `sections`, and both renderers already know how to draw every section shape it can produce.

### 1.3 The section model — the actual data contract

A "section" is a plain object. Every key is optional; a renderer only draws what's present. These are every key both `_storyBuildReportPdf` and `_storyBuildReportDocx` understand (confirmed by reading both functions in full):

| Key | Shape | What it draws |
|---|---|---|
| `heading` | `string` | A heading rule, in the brand navy color |
| `metaStrip` | `[{label, value}]` | A row of N equal-width bordered cells (used once, on the cover, for Issued/Coverage/etc.) |
| `callout` | `{tag, text}` | One dark "bottom line" box with a colored tag chip (`WATCH`/`RAIN`/`HEAT`/`BOTTOM LINE`) |
| `kpis` | `[{value, label, color:[r,g,b], country?, region?, note?}]` (≤4) | A row of stat cards with a colored top accent bar. `country` switches the card into "country-first" layout |
| `bullets` | `string[]` **or** `{tag, text}[]` | One wrapped line per bullet; tagged bullets get a small colored chip prefix |
| `bodyHtml` | `string` (HTML) | Tags stripped, entities decoded, flattened into wrapped prose |
| `legend` | `[{color:"#rrggbb", label}]` | A color-swatch key — colors come straight from the live map layer's real paint values, never invented |
| `imageDataUrl` | data URL | One full-width image, sized at its **real** aspect ratio |
| `imageRow` | `[dataUrl\|null, dataUrl\|null]` | Two images side by side, each at its own real aspect ratio; `null` → an "Overlay unavailable this cycle" placeholder, never a blank gap or a broken image tag |
| `table` | `{head, rows, colWidths?, levelCol?}` | A table with a navy header (redrawn on every page break so a multi-page table never loses its column labels), zebra striping, weighted column widths, and an optional column rendered as colored severity chips instead of plain text |

A concrete real example (one entry from the Weekly Weather report, gcop-i-map.js area ~27068-27074, re-used here as the SE Asia equivalent at line 27311-27329):

```js
sections.push({
  heading: "Southeast Asia — Current Conditions (Not a Seasonal Forecast)",
  bodyHtml: `<p>Real current rainfall across Indonesia, the Philippines, ... Source: ${_ncopEscapeHtml(seaRanked[0]?.model || "Open-Meteo Archive API (ERA5 reanalysis)")}.</p>`,
  imageRow: [seaMapImg, seaBarChartUrl],
  table: { head: ["#", "Country", "Past 7 Days"], rows: seaRanked.map((r, i) => [String(i + 1), r.country, _storyWwFormatMm(r.sum)]) },
});
```

That's the entire interface. A story-specific builder is free to assemble this array however it wants internally (fetch data, fly the camera, take screenshots, build chart images) — the renderer only ever sees the finished array.

### 1.4 Capturing visual evidence

Two independent capture mechanisms feed `imageDataUrl`/`imageRow`:

**(a) Map screenshots — `GCOPExportControl.captureSingleFrameFromMapCanvas()`** *(gcop-i-map.js:46691-46765)*

This reads Mapbox GL JS's own `<canvas>` element directly:
```js
async captureSingleFrameFromMapCanvas(selectionArea, opts = {}) {
  await this._waitForMapCanvasFrame();            // waits for the NEXT real render + forces a repaint
  const sourceCanvas = map?.getCanvas?.();
  // ...compute crop rect (full map, or a selection area)...
  const canvas = document.createElement("canvas"); // a NEW 2D canvas, downscaled to maxPdfImageEdge
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, outW, outH);
  return canvas.toDataURL("image/jpeg", this.defaults.pdfJpegQuality);  // JPEG, not PNG
}
```
`_waitForMapCanvasFrame()` listens for Mapbox's own `'render'` event (with a 500ms fallback timeout) before reading pixels — this is the standard technique for reliably reading a WebGL canvas's framebuffer: read too early and you get a stale or blank frame.

**(b) Blank-frame detection — `_frameLooksUsable(canvas)`** *(gcop-i-map.js:46787-46826)*

Before a captured frame is trusted, it's downsampled to a small thumbnail and tested for relative luminance (standard Rec. 709 weights) mean and variance:
```js
const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
// ...
if (mean < this.defaults.blackLumaThreshold) return false;   // too dark → likely blank
if (varr < this.defaults.lowVarThreshold) return false;      // too flat/uniform → likely blank
return true;
```
Any caller that gets `false` back treats the capture as failed and passes `null` into `imageRow`, which the renderer draws as the "Overlay unavailable this cycle" placeholder (§1.3) instead of embedding a broken or blank image.

**(c) Chart screenshots — `_storyRenderChartToDataUrl(config, width, height)`** *(gcop-i-map.js:25070-25108)*

Charts are rendered with the app's existing Chart.js import, off-screen (positioned at `left:-9999px`, **never** `display:none` — Chart.js needs real layout to size itself), then read back as an image and torn down:
```js
async function _storyRenderChartToDataUrl(config, width = 440, height = 280) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.style.position = "fixed"; canvas.style.left = "-9999px";
  document.body.appendChild(canvas);
  let chart = null;
  try {
    chart = new Chart(canvas, { ...config, options: { ...(config.options||{}), responsive: false, animation: false, devicePixelRatio: 3 } });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); // 2 RAFs = reliably painted
    // JPEG, not PNG — composited onto an opaque white background first since JPEG has no alpha
    const out = document.createElement("canvas");
    out.width = canvas.width; out.height = canvas.height;
    const octx = out.getContext("2d");
    octx.fillStyle = "#ffffff"; octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0);
    return out.toDataURL("image/jpeg", 0.85);
  } finally {
    if (chart) chart.destroy();
    canvas.remove();
  }
}
```
`devicePixelRatio: 3` renders at 3× the CSS pixel size before export, bringing a chart meant to print at full report width close to print resolution without changing its physical size on the page.

### 1.5 The PDF renderer — `_storyBuildReportPdf(meta, sections)`

*(gcop-i-map.js:27394-27812)* — built on **jsPDF** (`"jspdf": "^4.0.0"` in package.json), lazy-loaded:
```js
const loadJsPdfModule = () => { jspdfModulePromise ||= import("jspdf"); return jspdfModulePromise; };
```

Structure, in order:
1. Create an A4 `jsPDF("p", "mm", "a4")`, compute page/content width from margins.
2. Draw the cover: two letterhead logos (loaded via the export control's own `_loadImageAsDataURL`, wrapped in try/catch so a missing logo never blocks the report), title, subtitle, generated-at timestamp.
3. **Keep-together estimation** before every section — this is the fix for orphaned headings/stranded table headers:
   ```js
   const estimateSectionLeadHeight = (section) => {
     let h = 0;
     if (section.heading) h += 9;
     if (section.metaStrip) h += 20;
     /* ...one term per section key, capped... */
     return Math.min(h, pageH - 32);
   };
   for (const section of sections) {
     if (y + estimateSectionLeadHeight(section) > pageH - 16) { newPage(); }
     /* draw the section */
   }
   ```
   This is a *lead-height* estimate (heading + first chunk), not an estimate of the whole section — a genuinely long table will still span pages regardless, and the table-drawing loop separately re-draws its own header row (`drawHeader()`) every time a page break happens mid-table.
4. One `if (section.X)` block per section-model key (§1.3), each independently able to trigger its own page break if it won't fit in the remaining space.
5. **Real-aspect-ratio images**, not a hardcoded box:
   ```js
   function _storyGetImageAspect(pdf, dataUrl) {
     try {
       const props = pdf.getImageProperties(dataUrl);
       if (props?.width && props?.height) return props.width / props.height;
     } catch (err) {}
     return 16 / 9;
   }
   ```
   (jsPDF's `getImageProperties` reads the real embedded image's pixel dimensions.)
6. After every section is drawn, a **final pass over every existing page** stamps the navy header band and footer ("FOR OFFICIAL USE" / report ref / "Page X of Y") — done last because `pdf.internal.getNumberOfPages()` only has its real final value once the whole document exists:
   ```js
   const totalPages = pdf.internal.getNumberOfPages();
   for (let i = 1; i <= totalPages; i++) { pdf.setPage(i); /* draw header/footer */ }
   ```
7. `pdf.save(_storyReportFilename(meta.id, "pdf"))`.

### 1.6 The DOCX renderer — `_storyBuildReportDocx(meta, sections)`

*(gcop-i-map.js:27814+)* — built on the **`docx`** npm package (`"docx": "^9.5.1"`) + **`file-saver`** (`"file-saver": "^2.0.5"`) for the actual browser download, both lazy-loaded the same way as jsPDF.

This is a structural mirror of the PDF renderer over the *same* `sections` array and the *same* `STORY_REPORT_PALETTE`/`STORY_REPORT_TAG_COLORS`/`STORY_NEOC_LEVEL_COLORS` (converted to hex for `docx`'s shading/`TextRun.color` API) — so PDF and Word output are visually consistent, not two independently-designed documents:
```js
const toHex = (rgb) => rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
const paletteHex = { navy: toHex(STORY_REPORT_PALETTE.navy), /* ... */ };
```
It builds a flat `children: []` array of `docx` primitives (`Paragraph`, `Table`/`TableRow`/`TableCell`, `TextRun`, `ImageRun`) — one section-key handler at a time, e.g. a `metaStrip` becomes a 1-row `Table` with N shaded cells; a `callout` becomes a 1-row/1-cell shaded `Table`.

It has its own copy of the real-aspect-ratio fix, since `docx`'s `ImageRun` has no auto-size and needs an explicit `transformation: {width, height}`:
```js
const imageDims = new Map();
async function getImageDims(dataUrl) {
  if (imageDims.has(dataUrl)) return imageDims.get(dataUrl);
  const img = await _storyWwLoadImageEl(dataUrl);
  const dims = { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  imageDims.set(dataUrl, dims);
  return dims;
}
```
(Memoized per unique data URL — the same image is never decoded twice even if it appears in two sections.)

Finished with `Packer.toBlob(doc)` → `saveAs(blob, filename)`.

### 1.7 Optimization techniques already in production (confirmed, not theoretical)

These are real, comment-documented engineering decisions already in the shipped code — worth carrying forward, not reinventing:

1. **Code-splitting via dynamic `import()`** — `jspdf`, `docx`, `file-saver`, `gif.js`, and `three` are *all* lazy-loaded (`||=` memoized promise pattern), so none of these libraries are in the initial bundle; they're fetched only the first time a feature that needs them actually runs.
2. **JPEG, not PNG, for every captured image** — confirmed in the code's own comment this was a real fix for a **45MB export**: every chart/map capture used to be a lossless, alpha-channel PNG. JPEG has no alpha, so a white background is explicitly composited first on a *separate* canvas (Chart.js clears its own canvas on render, so painting a background on the live canvas before rendering would just get wiped).
3. **Real aspect ratios instead of a hardcoded 16:9 box** — fixed a specific, confirmed bug where a ~4.9:1 chart (a CAPE gauge) was squashed into a near-square box. Applied in *both* renderers independently, since jsPDF and `docx` have unrelated image-sizing APIs.
4. **Downscaling map captures to a max output edge** (`maxOut = this.defaults.maxPdfImageEdge`) *before* the JPEG encode, not after — avoids ever encoding a full-resolution Retina/HiDPI canvas just to shrink it in the PDF.
5. **Blank-frame detection skips, not fails** — a failed/blank capture degrades to a placeholder card, so one bad screenshot never blocks the whole report or silently ships a broken image.
6. **Per-region/per-metric data caching** (`_storyWwRegionDataCache`, a `Map` keyed by region+metric, 2-hour TTL) — a replay or a second export in the same session never re-fetches data that's still fresh. This matters doubly for export, since export independently re-fetches everything rather than reading off the live scene state.
7. **Shared palette/constants between PDF and DOCX** — one source of truth (`STORY_REPORT_PALETTE` etc.) converted per-format, so there's no risk of the two output formats visually drifting apart over time.
8. **Lead-height estimation, not full-section estimation, for page breaks** — cheap to compute, avoids over-triggering page breaks for sections that are going to span pages regardless (tables).

---

## Part 2 — Replicating this in NCOP

NCOP's Story Mode almost certainly has a different data model (different hazard types, different region definitions, different live layers) — so this is **not** "copy gcop-i-map.js's functions verbatim." It's the same *shape* of solution, built from NCOP's own data.

### 2.1 Prerequisites

Check NCOP's `package.json` for these three; add whichever are missing:
```bash
npm install jspdf docx file-saver
```
(`chart.js` is very likely already present in any dashboard app; if NCOP's Story Mode doesn't already render charts, skip the chart-capture piece in §2.4.)

### 2.2 Step 1 — the lazy-loader pattern (do this first, it's 10 lines and unlocks the code-splitting win)

Add near the top of NCOP's main Story Mode module:
```js
let jspdfModulePromise = null;
let docxModulePromise = null;
let fileSaverModulePromise = null;

const loadJsPdfModule   = () => (jspdfModulePromise   ||= import("jspdf"));
const loadDocxModule    = () => (docxModulePromise    ||= import("docx"));
const loadFileSaverModule = () => (fileSaverModulePromise ||= import("file-saver"));
```
Verify with Vite's build output afterward that these show up as **separate chunks**, not inlined into the main bundle — if NCOP's Vite config has manual chunking rules, make sure dynamic imports aren't being forced back into a vendor chunk.

### 2.3 Step 2 — define the section model as NCOP's own stable contract

Before writing any drawing code, decide which of §1.3's section keys NCOP's reports actually need. Don't port all nine mechanically — start with the minimum NCOP's own stories need (very likely: `heading`, `bodyHtml`, `imageDataUrl` or `imageRow`, `table`) and add `kpis`/`callout`/`bullets`/`metaStrip`/`legend` only once a real story needs them. This keeps the renderer's first version small and testable.

Write this contract down as a comment block above wherever NCOP's section-building functions live — it is the single most load-bearing design decision in the whole system, since every future story and every future renderer feature has to agree on it.

### 2.4 Step 3 — a map-capture helper

If NCOP already has an "export map as image" feature (many Mapbox GL JS dashboards do, for a basic screenshot toolbar button), **reuse that class's capture method** rather than writing a new one — just confirm it already does the two things that matter:
- Waits for a real `'render'` event (or forces `map.triggerRepaint()` and waits) before reading pixels — reading a WebGL canvas synchronously on click, without a render-frame wait, intermittently returns a stale or blank frame.
- Outputs JPEG via `canvas.toDataURL("image/jpeg", quality)`, not PNG.

If NCOP has no such class yet, a minimal standalone version:
```js
async function captureMapFrame(map, { delayMs = 0, maxEdge = 1600, quality = 0.85 } = {}) {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    map.once("render", finish);
    map.triggerRepaint();
    setTimeout(finish, 500); // fallback — never hang forever if 'render' doesn't fire
  });
  const src = map.getCanvas();
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const out = document.createElement("canvas");
  out.width = Math.max(2, Math.floor(src.width * scale));
  out.height = Math.max(2, Math.floor(src.height * scale));
  out.getContext("2d", { alpha: false }).drawImage(src, 0, 0, src.width, src.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", quality);
}
```
Add the blank-frame check (§1.4b) only if NCOP's layers are prone to late-loading tile sources the way GCOP's were — if NCOP's map layers are reliably loaded by the time export runs, this is a "nice to have," not a day-1 requirement.

### 2.5 Step 4 — the chart-capture helper (only if NCOP's stories use charts)

Port `_storyRenderChartToDataUrl` (§1.4c) near-verbatim — it has no GCOP-specific dependencies, just Chart.js. Keep the two real fixes: off-screen (not `display:none`) positioning, and the JPEG-over-opaque-white-background composite.

### 2.6 Step 5 — the two renderers

Write `buildReportPdf(meta, sections)` and `buildReportDocx(meta, sections)` as **generic functions that only know the section-model contract from §2.3** — never a specific story's data shape. Port the relevant `if (section.X)` blocks from §1.5/§1.6 one at a time, in order of which section keys NCOP actually uses, testing each with a hand-built fake `sections` array before wiring in real data:
```js
// Smoke test before touching any real story data:
await buildReportPdf(
  { id: "test", title: "Test Report", subtitle: "", generatedAt: new Date() },
  [{ heading: "Hello", bodyHtml: "<p>World</p>" }],
);
```
Carry forward, don't skip, these three specific bug-fixes from §1.5 even in a v1 — they were each a real, confirmed defect in GCOP's own first pass, not speculative hardening:
- Real image aspect ratio (`pdf.getImageProperties` / loading the image to read `naturalWidth`/`naturalHeight`), never a fixed box.
- The lead-height page-break estimate, so a heading is never stranded alone at a page bottom.
- A table header redrawn on every page break, so a multi-page table never loses its column labels.

### 2.7 Step 6 — one section-builder per NCOP story, and the dispatcher

For each of NCOP's Story Mode cinematics, write one `async function exportXStoryReport(exportCtl, markStep) { return sections; }` — this is where NCOP's *actual domain logic* lives (whatever NCOP's stories are about), and it's the only part of this whole system that can't be ported from GCOP at all, by definition.

Then the dispatcher, directly mirroring §1.2:
```js
async function exportStoryReport(format) {
  const story = getCurrentlySelectedStory();
  setExportBusy(true);
  const baseline = captureMapBaseline();
  try {
    const exportCtl = getExportControl();
    const meta = buildMetaForStory(story);
    const sections = await STORY_REPORT_BUILDERS[story.id](exportCtl, markStep);
    if (format === "docx") await buildReportDocx(meta, sections);
    else await buildReportPdf(meta, sections);
  } catch (err) {
    console.error("export failed:", err);
    alert("Could not generate the report. Please try again.");
  } finally {
    await restoreMapBaseline(baseline);
    setExportBusy(false);
  }
}
```
Using a lookup object (`STORY_REPORT_BUILDERS`) keyed by story id, rather than GCOP's `if/else if` chain, is a small improvement worth making in a fresh implementation — it scales to N stories without a growing conditional, and a missing entry is a simple `undefined` check instead of a silent fallthrough to the generic single-snapshot case.

### 2.8 Step 7 — the UI wiring

```html
<button type="button" class="story-export-btn" id="story-export-btn"
        title="Export this story as a report (works without playing it first)">📄 Export Report</button>
```
```js
document.getElementById("story-export-btn").addEventListener("click", toggleExportFormatChoice);
```
Reuse NCOP's own existing loading-checklist UI/CSS for export progress if one exists (same principle as §1.2 point 3) rather than building a second progress-indicator component.

### 2.9 Optimization checklist for the NCOP port

Apply these from day one — they're cheap when designed in, expensive to retrofit later (GCOP's own JPEG/aspect-ratio fixes were retrofits, confirmed by the code's own comments):

- [ ] Every third-party export library (`jspdf`, `docx`, `file-saver`, and `chart.js` if it's not already loaded elsewhere) is behind a lazy `import()`, never a top-level `import`.
- [ ] Every captured image (map or chart) is JPEG, composited onto an opaque background first, never PNG.
- [ ] Every embedded image is sized at its own real aspect ratio — load-and-measure for `docx`, `getImageProperties` for jsPDF — never a fixed box.
- [ ] Map captures are downscaled to a sane max edge **before** the JPEG encode, not after.
- [ ] Any per-region/per-story data fetch used by a report is cached with a TTL, keyed so a replay or a second export in the same session doesn't re-fetch.
- [ ] A failed/blank capture degrades to a visible placeholder, never a broken embed and never an exception that aborts the whole report.
- [ ] PDF and DOCX renderers share one palette/constants module, converted per-format — never two hand-maintained color sets.
- [ ] Page-break logic estimates only the *lead* height of a section (heading + first chunk), not the whole section, and table headers are explicitly redrawn after a break.

### 2.10 Verification steps (for every change, not just the final one)

Matches the rigor pattern already established in GCOP's own history on this exact feature:
1. `node --check <file>` after every edit — syntax is cheap to verify and catches typos before a build.
2. Full `npm run build` (or NCOP's equivalent) — confirms the dynamic imports actually produce separate chunks and nothing broke the bundle.
3. **Revert any build output from your working tree before committing** — `dist/` artifacts are for local verification only, never part of a commit, on dev branches.
4. A real, manual export test for at least one story in each format (PDF and DOCX) — open the resulting file and check: no blank/broken images, no stranded headings, no squashed non-16:9 charts, correct filename/timestamp.

---

## Summary

GCOP's export feature is really three small, separable ideas stacked together: **(1)** a story-agnostic array-of-plain-objects "section model" that decouples *what a story knows* from *how it's drawn*, **(2)** two renderers (jsPDF, `docx`) that only ever read that section model, and **(3)** a handful of specific, already-debugged fixes (JPEG not PNG, real aspect ratios, lead-height page breaks, blank-frame placeholders) that are cheap to carry forward and expensive to rediscover independently. Porting it to NCOP means rebuilding exactly those three pieces against NCOP's own story data — not copying GCOP's specific hazard/region logic, which has no place in a different application's domain.
