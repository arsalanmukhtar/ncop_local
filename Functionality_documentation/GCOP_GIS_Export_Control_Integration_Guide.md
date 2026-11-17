# GCOP — "Export Active GIS Layers" Control: Integration Guide

How to replicate the `#mapbox-gl-gis-export` control in another Mapbox GL JS
application: a toolbar button that opens a floating panel listing every
currently-active (checked + visible) layer, lets the user pick which ones to
export, and downloads each as the most appropriate GIS format it can produce
— GeoJSON, a real georeferenced GeoTIFF, or a manifest for manual GIS import
— without the user having to know what format each layer even is.

Read against the live source: `gcop-i-map-controls.js` (control + panel +
export logic), `ncop/views.py` (`NcopRasterExportView`), `ncop/urls.py`, and
the panel skeleton in `gcop-in-home.html`.

---

## 1. User-facing behavior

1. Click the toolbar button → a floating panel opens, positioned to the left
   of the button, listing every layer that is currently **checked in the
   sidebar AND has at least one visible map layer** (or, for a temporal
   layer, at least one time-step defined).
2. Each row shows: the layer's display label, its detected type (`fill`,
   `circle`, `raster`, `wms`, …), the format GCOP will export it as, and
   either "N time steps" (temporal layers) or "N visible map layers".
3. Toolbar buttons: **All** / **None** (bulk-select the checkboxes) and
   **Export Selected**.
4. Clicking Export Selected processes the selection **sequentially** (not in
   parallel — deliberately throttled), updating a status line
   ("Preparing 2 of 5: Rainfall Forecast…") as it goes, and triggers one
   browser download per layer, in whatever format that layer resolved to.
5. Toggling a sidebar layer on/off while the panel is open live-refreshes
   the list after a 30 ms debounce.
6. The panel is draggable (by its header) and resizable (bottom-right
   handle) — first open auto-sizes to content, then remembers the user's
   manual size/position for the rest of the session.
7. A second tab, **Import**, lives in the same panel (drag-drop GeoJSON /
   Shapefile .zip / GeoTIFF, plus "connect to a WMS and add its layers") —
   a separate, larger subsystem appended later ("no existing logic
   changed" per its own source comment). This guide covers **Export** in
   full; Import is out of scope here.

---

## 2. Prerequisites

| Need | Purpose |
|---|---|
| A Mapbox GL JS map with a **sidebar layer-switcher convention** | Export discovery relies on `<input data-layertype="layer">` checkboxes, each with a `data-layername` that matches (or prefixes) real Mapbox style layer ids. Without a consistent naming convention, you cannot generically discover "what's active." |
| A **temporal layer-set registry** (optional) | GCOP's `timeseries_layersets[layerName]` — an array of `{source, layers, date}` per time-step — used to export every step of an animated/temporal layer, not just the currently-displayed frame. Skip this if you have no temporal layers. |
| A backend endpoint that can **re-fetch and georeference a raster image** | Browsers cannot losslessly rasterize an already-rendered WMS tile back into a real GeoTIFF; GCOP does this server-side (`POST /export-raster/`). Without this, raster/WMS layers can only export as a connection-info text file. |
| A CSRF token accessor (optional in GCOP's own case) | The frontend always sends `X-CSRFToken` (`getImportCSRFToken()` reads the `csrftoken` cookie) — but `NcopRasterExportView` itself is `@csrf_exempt`, so GCOP doesn't actually require it. Send it anyway if you copy this pattern; don't rely on the exemption. |
| `mercantile` (Python) | Tile-index math (lon/lat/zoom → XYZ tile coordinates and back) for the XYZ tile-stitch path. |
| GDAL (`osgeo.gdal`, `osgeo.osr`) | Only for the **XYZ tile-stitch** path (building the output raster in a GDAL in-memory dataset and encoding it with LZW compression). The **WMS→GeoTIFF** path needs no GDAL at all — see §5. |
| The `MapboxGLButtonControl` IControl pattern | Same minimal custom-button `IControl` class documented in GCOP's Split Compare View guide — a `<button>` wrapped in a `.mapboxgl-ctrl-group`, added via `map.addControl()`. |

---

## 3. The core idea — a cascading, format-agnostic export strategy

The one non-obvious design decision worth understanding before building this:
GCOP does **not** ask the user what format they want. Each selected layer is
inspected and routed through an ordered cascade, and the *first* tier that
applies wins:

```
1. GeoJSON source (inline object or fetchable URL)   → direct .geojson download
2. Raster / WMS source                                → POST /export-raster/ → real .tif
3. Vector-tile / rendered features (fill/line/circle/symbol) → querySourceFeatures() → .geojson
4. Anything else                                       → JSON "source package" manifest
```

This means a single "Export Selected" click can simultaneously produce a
`.geojson`, a `.tif`, and a manifest `.json` across three different layers —
each layer decides its own format based on what it actually *is*, not a
format picker.

The second non-obvious piece: **tier 3 is deliberately honest about its own
limitation.** `map.querySourceFeatures()` only returns features from
**currently loaded map tiles** — not the full dataset. GCOP's exported
GeoJSON for this tier carries a `metadata.gcop_notice` field saying exactly
that, so a user doesn't mistake a partial, viewport-dependent export for a
complete dataset.

---

## 4. Step-by-step build guide

### 4.1 State + DOM skeleton

```js
const layerExportState = { items: [], busy: false, activeTab: "export", importedLayers: [] };
```

Static panel shell (everything inside `#...-content` is rendered dynamically):
```html
<div id="ncop-layer-export-panel" class="ncop-layer-export-panel bg-glass" aria-hidden="true">
  <div class="ncop-layer-export-panel-header">
    <div class="ncop-layer-export-panel-title-group">
      <div class="ncop-layer-export-panel-title">GIS Export</div>
      <div class="ncop-layer-export-panel-subtitle">Export active map layers by available source type.</div>
    </div>
    <button id="ncop-layer-export-panel-close" class="ncop-layer-export-panel-close">&times;</button>
  </div>
  <div id="ncop-layer-export-panel-content" class="ncop-layer-export-panel-content"></div>
  <div id="ncop-ep-resize-handle" class="ncop-ep-resize-handle" title="Drag to resize"></div>
</div>
```

### 4.2 Toolbar button

```js
const gisExportControl = new MapboxGLButtonControl({
  id: "mapbox-gl-gis-export",
  className: "mapbox-gl-gis-export",
  title: "Export Active GIS Layers",
  eventHandler: toggleLayerExportPanel,
});
map.addControl(gisExportControl, "bottom-right");
```

### 4.3 Discovering "active" layers

This is the crux of the whole feature — it has to turn a checked sidebar
input into the real Mapbox layer ids it corresponds to, generically, with no
per-layer hardcoding:

```js
function getLayerOrderRelatedMapLayers(layerName) {
  const styleLayers = map.getStyle?.()?.layers || [];
  return styleLayers
    .filter((layer) =>
      layer.source === layerName ||
      layer.id === layerName ||
      layer.id.startsWith(`${layerName}_`) ||
      layer.id.startsWith(`${layerName}-`)
    )
    .map((layer) => layer.id);
}
```

This is why GCOP's own layer-id convention (`<layername>_fill`,
`<layername>_point`, `<layername>_label`, …) matters — the export panel,
the Layer Order panel, and the popup wiring all lean on the same prefix
convention for free interoperability. If you adopt this pattern, keep your
layer ids consistently prefixed by the checkbox's `data-layername`.

Then, per checked input:
```js
function buildLayerExportItems() {
  const checkedInputs = [...document.querySelectorAll('[data-layertype="layer"]:checked')];
  const seen = new Set();

  return checkedInputs.map((input) => {
    const layerName = input.dataset.layername;
    if (!layerName || seen.has(layerName)) return null;
    seen.add(layerName);

    const isTemporal = input.dataset.istempo === "true";
    const temporalSteps = isTemporal ? (timeseries_layersets[layerName] || []) : [];
    const mapLayerIds = isTemporal
      ? temporalSteps.flatMap((step) => (step.layers || []).map((l) => l.id))
      : getLayerOrderRelatedMapLayers(layerName);

    const existingLayerIds = mapLayerIds.filter((id) => map.getLayer(id));
    const visibleLayerIds = existingLayerIds.filter(
      (id) => map.getLayoutProperty(id, "visibility") !== "none",
    );
    if (!isTemporal && !visibleLayerIds.length) return null;

    // collect one source spec per unique source id referenced by this layer
    // (both from temporal steps and from the live style), then classify it —
    // see 4.4 for isExportRasterSource / getExportLayerSourceTypes.
    ...
    return { id: layerName, label, groupLabel, isTemporal, temporalStepCount: temporalSteps.length,
      temporalSteps, layerIds: existingLayerIds, visibleLayerIds, sourceSpecs,
      typeLabel, formatLabel: describeExportFormat(layerTypes) };
  }).filter(Boolean);
}
```

Non-temporal layers require at least one *visible* map layer; temporal
layers are included as long as their step registry has entries (visibility
of the currently-active frame is not the gate — you're exporting the whole
time series).

### 4.4 Classifying each layer's exportable format

```js
function isExportRasterSource(source) {
  if (!source) return false;
  if (source.type === "raster" || source.type === "raster-dem") return true;
  const urls = [...(source.tiles || []), source.url].filter(Boolean).join(" ");
  return /service=wms|request=GetMap|\/wms\b/i.test(urls);
}

function describeExportFormat(types) {
  const t = types.map(String).map((x) => x.toLowerCase());
  if (t.includes("geojson")) return "GeoJSON";
  if (t.includes("wms") || t.includes("raster") || t.includes("raster-dem")) return "GeoTIFF (.tif)";
  if (t.includes("vector") || /fill|line|circle|symbol/.test(t.join(" "))) return "GeoJSON (loaded tiles)";
  return "Source package";
}
```

This is purely presentational (the badge text shown per row) — the actual
routing decision happens independently in `exportLayerItem` (4.6), in the
same priority order.

### 4.5 The panel UI

Two tabs (Export / Import) rendered as plain buttons with a `.active` class
and `data-ep-tab` attribute; clicking either re-renders the whole content
div. The Export tab body is: a toolbar (`All` / `None` / `Export Selected`),
a live status line (`aria-live="polite"` — announces progress to screen
readers), then one `<label>` checkbox row per item showing label + type +
format + step/layer count, and a closing note explaining the 3 real export
outcomes to the user up front so there are no surprises:

> "GeoJSON sources download directly. WMS/raster layers export as
> georeferenced GeoTIFF (.tif) using the layer's full WMS extent when
> available. Vector tile layers export rendered features as GeoJSON."

Wire the toolbar and checkboxes via **one delegated click listener** on the
content container (not per-row listeners — the list re-renders on every
layer toggle, so per-row listeners would leak):
```js
layerExportPanelContent.addEventListener("click", (event) => {
  const tabBtn = event.target.closest(".ncop-ep-tab");
  if (tabBtn) { layerExportState.activeTab = tabBtn.dataset.epTab; renderLayerExportPanel(); return; }

  const selectBtn = event.target.closest(".ncop-layer-export-select");
  if (selectBtn) {
    const checked = selectBtn.dataset.exportSelect === "all";
    layerExportPanelContent.querySelectorAll(".ncop-layer-export-check")
      .forEach((input) => (input.checked = checked));
    return;
  }
  if (event.target.closest("#ncop-layer-export-run")) exportSelectedLayers();
});
```

Auto-refresh while open, and click-outside-to-close:
```js
document.addEventListener("change", (e) => {
  if (e.target.matches?.('[data-layertype="layer"]') && layerExportPanel?.classList.contains("open")) {
    setTimeout(renderLayerExportPanel, 30);
  }
});
document.addEventListener("click", (event) => {
  if (!layerExportPanel?.classList.contains("open")) return;
  const path = event.composedPath ? event.composedPath() : [event.target];
  const insidePanel = path.some((el) => el?.id === "ncop-layer-export-panel");
  const onButton = path.some((el) => el?.id === "mapbox-gl-gis-export");
  if (!insidePanel && !onButton) closeLayerExportPanel();
});
```
Note the `composedPath()` use over `event.target` — GCOP's own comment flags
why: the Import tab's list re-renders via `outerHTML` mid-event in some
flows, which can detach `event.target` from the document before the outer
click handler runs; `composedPath()` was captured before that mutation.

Drag (header `mousedown`) and resize (handle `mousedown`) both set
`dataset.epMoved = "1"` — once set, `positionLayerExportPanel()` stops
auto-positioning relative to the button and just keeps the user's chosen
rect clamped inside the viewport on resize. This is the same drag/resize
idiom GCOP reuses for its other floating panels (e.g. the Weather Report
panel) — copy it verbatim rather than re-deriving it per panel.

### 4.6 Running the export

```js
async function exportSelectedLayers() {
  if (layerExportState.busy) return;
  const selectedIds = [...document.querySelectorAll(".ncop-layer-export-check:checked")].map((i) => i.value);
  const selectedItems = layerExportState.items.filter((item) => selectedIds.includes(item.id));
  if (!selectedItems.length) { setLayerExportStatus("Select at least one active layer to export."); return; }

  layerExportState.busy = true;
  try {
    for (let i = 0; i < selectedItems.length; i++) {
      setLayerExportStatus(`Preparing ${i + 1} of ${selectedItems.length}: ${selectedItems[i].label}`, true);
      await exportLayerItem(selectedItems[i]);
      await new Promise((r) => setTimeout(r, 80)); // small gap between downloads
    }
    setLayerExportStatus(`Export prepared for ${selectedItems.length} layer(s).`);
  } catch (err) {
    setLayerExportStatus(`Export failed: ${err?.message || "unknown error"}`);
  } finally {
    layerExportState.busy = false;
  }
}
```

Sequential, not `Promise.all` — deliberate, so multiple simultaneous browser
downloads don't all fire in the same tick (some browsers throttle/block
rapid-fire downloads), and so the status line can report real progress.

**Tier 1 — GeoJSON, direct:**
```js
async function resolveGeojsonData(sourceSpec) {
  if (sourceSpec?.type !== "geojson") return null;
  if (typeof sourceSpec.data === "object") return sourceSpec.data;
  if (typeof sourceSpec.data === "string") {
    const res = await fetch(sourceSpec.data);
    if (!res.ok) throw new Error(`GeoJSON fetch failed: ${res.status}`);
    return res.json();
  }
  return null;
}
```

**Tier 2 — raster/WMS → real GeoTIFF** (see §5 for the backend contract):
```js
async function exportSourceAsGeoTiff(baseName, source) {
  const isWMS = (source.tiles || []).some((u) => /service=wms|request=GetMap/i.test(u));
  const res = await fetch("/export-raster/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRFToken": getImportCSRFToken() },
    body: JSON.stringify({
      url: normalizeExportRasterUrl(source.tiles[0]),
      bbox: getExportBoundsEPSG3857(),   // current viewport, EPSG:3857 — used as fallback
      fullExtent: isWMS,                 // ask the server to look up the layer's REAL full extent instead
      xyz: !isWMS,                       // XYZ {z}/{x}/{y} template → tile-stitch path instead of WMS
      filename: baseName,
    }),
  });
  if (!res.ok) throw new Error(`GeoTIFF export failed: HTTP ${res.status}`);
  downloadExportBlob(`${baseName}.tif`, await res.blob(), "image/tiff");
}
```

**Tier 3 — rendered vector features from loaded tiles:**
```js
function collectLoadedVectorFeatures(item) {
  const features = [];
  item.layerIds.forEach((layerId) => {
    const styleLayer = map.getStyle().layers.find((l) => l.id === layerId);
    if (!styleLayer?.source || !map.getSource(styleLayer.source)) return;
    const found = map.querySourceFeatures(styleLayer.source, { sourceLayer: styleLayer["source-layer"] }) || [];
    found.forEach((f) => features.push({ type: "Feature", geometry: f.geometry,
      properties: { ...f.properties, gcop_map_layer: layerId } }));
  });
  return { type: "FeatureCollection",
    metadata: { gcop_export_scope: "loaded-map-tiles",
      gcop_notice: "Exported from currently loaded map tiles, not a full dataset endpoint." },
    features };
}
```

**Tier 4 — fallback manifest** (tile URL templates + bounds, for a user to
manually add the source in QGIS/ArcGIS) — a plain JSON `{ type, sources,
temporalSteps, note }` object, downloaded as `_source_package.json`.

`exportLayerItem(item)` just tries tiers 1→4 in order and returns on the
first one that produces output — see the cascade in §3.

---

## 5. Backend — `ncop/urls.py` routing + `NcopRasterExportView` internals

This is the piece a plain client-side clone cannot replicate without a
server: turning an already-rendered map tile back into a spatially-accurate
GeoTIFF requires re-requesting the source at a known bounding box and
stamping that bbox into the file's georeferencing — the browser-rendered
canvas alone has no coordinate metadata.

### 5.1 Routing (`ncop/urls.py`)

```python
path("export-raster/", NcopRasterExportView.as_view(), name="export-raster"),
```

Sits alongside the rest of GCOP's GIS import/export toolset, all plain
Django class-based views (not django-ninja, unlike most of GCOP's API
surface — see the project's `api_ninja.py` note about Ninja being mounted
at `""` and catching `/api/`+`/get-*/`; this cluster of routes deliberately
lives outside that):
```python
path("upload-shapefile/", NcopShapefileUploadView.as_view(), name="upload-shapefile"),
path("upload-raster/",    NcopRasterUploadView.as_view(),   name="upload-raster"),   # Import tab, GDAL-backed
path("export-raster/",    NcopRasterExportView.as_view(),   name="export-raster"),   # Export tab, tier 2
path("wms-capabilities/", NcopWmsCapabilitiesProxyView.as_view(), name="wms-capabilities"),
path("wms-tile/",         NcopWmsTileProxyView.as_view(),   name="wms-tile"),
```
`NcopRasterExportView` is `@method_decorator(csrf_exempt, name="dispatch")`
and a plain `View` (no `LoginRequiredMixin`) — unlike `GcopInternalView`
(the main map page), it does not itself enforce authentication; whatever
session/auth gate protects the page that embeds the button is the only
thing standing in front of this endpoint. Mirror that consciously in your
own backend rather than assuming CSRF-exempt implies auth-exempt is fine.

### 5.2 Request/response contract

**Request** (`application/json`):
```json
{
  "url": "https://<wms-host>/geoserver/wms?service=WMS&request=GetMap&layers=...",
  "bbox": [minX, minY, maxX, maxY],   // EPSG:3857, current viewport — always required as a fallback
  "fullExtent": true,                  // true: server looks up the WMS layer's own full extent instead of using bbox
  "xyz": false,                        // true: url is a {z}/{x}/{y} XYZ template, not WMS — tile-stitch path
  "filename": "my_layer",
  "width": 1024, "height": 1024        // optional; ignored in fullExtent mode (server picks size itself, see 5.4)
}
```
**Response**: `image/tiff` bytes with `Content-Disposition: attachment;
filename="<name>.tif"` on success, or JSON `{"error": "..."}` with a
non-200 status (400 for bad input, 502 for anything that fails once inside
the try block) on failure.

### 5.3 `post()` control flow

1. Parse JSON body; require `url`, and require either `fullExtent` or a
   4-element `bbox`.
2. If the incoming `url` is actually GCOP's own WMS proxy path
   (`/wms-tile/?...url=<encoded>`), unwrap it back to the real upstream URL
   first — the frontend sometimes hands this view an already-proxied tile
   URL, and the proxy wrapper isn't meaningful to an upstream GetCapabilities
   request.
3. **`xyz=true`** → delegate straight to `_stitch_xyz_tiles_to_geotiff()`
   (§5.5) and return; none of the WMS-specific logic below runs.
4. Otherwise (WMS): extract `LAYERS=` from the URL's own query string via
   `_normalize_wms_param_dict()` (lower-cases every param key so `LAYERS=`
   / `layers=` / `Layers=` all resolve the same way — WMS server casing is
   not standardized).
5. **`fullExtent=true`** → call `_read_wms_layer_extent_3857()` (§5.4) to
   get the layer's real advertised extent; on any failure, log a warning and
   silently fall back to the supplied viewport `bbox` instead of erroring out.
6. Pick output pixel dimensions via `_pick_raster_export_size()` (§5.4).
7. Rewrite the URL's `bbox=`, `width=`, `height=` query params to the
   resolved values (regex substitution if the param already exists, append
   if it doesn't — the URL was captured from a live GetMap request so it
   already has most params, just pointed at the current viewport).
8. Set the correct axis-order parameter for the WMS version actually in the
   URL: `params.get("version", "1.1.1")` → `CRS=EPSG:3857` for `1.3.x`,
   `SRS=EPSG:3857` for anything else. This isn't cosmetic — WMS 1.3.0
   formally swapped `SRS` for `CRS` (and, separately, swapped axis order for
   geographic CRSes), and some servers (GCOP calls out GloFAS specifically)
   reject a request that uses the wrong parameter name for its declared
   version instead of tolerating it.
9. `requests.get(url, timeout=60, verify=False)`.
   - `verify=False` — many of the WMS/GeoServer endpoints GCOP proxies for
     have self-signed or otherwise imperfect TLS chains; document this
     explicitly if you copy it, it's a deliberate tradeoff, not an oversight.
   - On `ConnectionError`/`ChunkedEncodingError` **during a full-extent
     request specifically**, retry exactly once at the original viewport
     `bbox` and a capped (non-full-extent) resolution — the most common
     cause is the resolved full-extent bbox or a 2048×2048 image exceeding
     the remote server's own size/timeout limits, and the viewport-scale
     request is far more likely to succeed.
10. `_write_geotiff_from_png()` (§5.6) turns the response image bytes into
    real GeoTIFF bytes, georeferenced to whichever bbox actually produced
    the image (the retry's viewport bbox if step 9 fell back, otherwise the
    resolved extent from step 5/6).
11. Any exception anywhere in this flow is caught at the top level, logged
    with `exc_info=True`, and returned as `{"error": str(e)}`, HTTP 502.

### 5.4 Resolving "the real extent" — `_read_wms_layer_extent_3857()` / `_pick_raster_export_size()`

`_read_wms_layer_extent_3857(getmap_url, layer_name)`:
- Builds a `GetCapabilities` URL from the GetMap URL (`_build_wms_capabilities_url`
  — same host/path, strips `bbox`/`width`/`height`/`format`/`transparent`/
  `styles`/`srs`/`crs`/`layers`/`time`, sets `service=WMS&request=GetCapabilities`,
  defaults `version=1.3.0` if the original URL didn't specify one).
- Fetches and parses the Capabilities XML with `xml.etree.ElementTree`,
  matching element names **namespace-agnostically** (`_xml_local_name()`
  strips any `{namespace}` prefix before comparing — WMS Capabilities XML
  namespacing varies enough across server implementations that exact
  qualified-name matching is fragile).
- Recursively walks the `<Layer>` tree, since WMS allows a child `<Layer>`
  to **inherit** its parent's `<BoundingBox>` when it doesn't declare its
  own (`find_layer(el, inherited_extent)` threads the nearest ancestor
  extent down as it recurses) — matches by unqualified name so a
  `workspace:layer_name` GetMap param still matches a bare `layer_name` in
  Capabilities.
- Extent extraction preference order (`_extract_layer_extent_3857`):
  1. A native `<BoundingBox CRS="EPSG:3857">` (or the legacy `900913` /
     `102100` aliases some servers still emit) — used as-is, no reprojection.
  2. Otherwise, the mandatory `<EX_GeographicBoundingBox>` (WMS 1.3) or
     `<LatLonBoundingBox>` (WMS 1.1) in lon/lat, hand-reprojected to
     EPSG:3857 via `_web_mercator_from_lonlat()` (the standard spherical
     Mercator formula, latitude clamped to ±85.0511° — the projection's own
     valid range).
  - **Edge case handled explicitly**: some global raster layers advertise a
    0–360° longitude span instead of −180..180°; naively clamping that to
    ±180 would collapse the bbox to only the eastern hemisphere, so a
    ≥359.9° span is detected and treated as the full globe in longitude
    instead of reprojected literally.
- Returns `None` if nothing usable is found (caller falls back to the
  viewport bbox — see 5.3 step 5).

`_pick_raster_export_size(bbox, requested_width, requested_height, full_extent)`:
- Viewport mode (`full_extent=False`): just clamps the client's requested
  `width`/`height` into `[64, 4096]`.
- Full-extent mode: **ignores** the requested width/height entirely and
  instead picks dimensions that preserve the resolved bbox's aspect ratio,
  with the longer axis at 2048px and the shorter axis scaled proportionally
  (floored at 256px) — so a very wide or very tall layer extent doesn't get
  squashed into a square image.

### 5.5 XYZ tile-stitch path — `_stitch_xyz_tiles_to_geotiff()`

Used when the frontend sends `xyz: true` (a `{z}/{x}/{y}` tile template
rather than a WMS GetMap URL — GCOP's tier-2 export routes here whenever the
source isn't identified as WMS). This is the one part of the export path
that **does** use GDAL, plus `mercantile` for tile math:

1. Convert the requested EPSG:3857 `bbox` to lon/lat, then pick the
   **highest zoom level whose tile count for that extent is ≤ `max_tiles`
   (64)** — walking down from `max_zoom=13`. This bounds worst-case fetch
   volume regardless of how large a bbox the user's current viewport covers.
2. Fetch all covering tiles **in parallel** (`ThreadPoolExecutor`, up to 16
   workers) — pure I/O, so parallelizing here is safe/cheap; decoding is
   kept serial afterward.
3. Decode each tile through a **numpy-free** path deliberately, per the
   source's own comments: PNG tiles go through GCOP's own hand-rolled PNG
   decoder (`_decode_png_rgba_rgb_or_gray`, the same one `_write_geotiff_from_png`
   uses); JPEG tiles go through `GDAL`'s in-memory `/vsimem/` filesystem +
   `band.ReadRaster()`, which returns raw bytes without ever touching
   `gdal_array`/`numpy`. This avoids a numpy/GDAL-Python-bindings version
   coupling that has historically been a fragile part of GDAL deployments.
4. Stitch decoded tiles into one flat per-band `bytearray` canvas (band-
   sequential/BSQ layout) at native tile resolution — `tile_count_x ×
   tile_w` by `tile_count_y × tile_h` — using slice assignment per tile row,
   not a pixel loop.
5. Compute the stitched canvas's true EPSG:3857 extent from the tile grid's
   corner tiles via `mercantile.xy_bounds()` (exact, not re-derived from the
   original request bbox — the tile grid almost never lines up exactly with
   the requested bbox, so this is what actually gets georeferenced).
6. Build a GDAL **in-memory (`MEM` driver)** dataset, set its GeoTransform +
   EPSG:3857 projection, write each band's bytes with `WriteRaster()`
   (again bypassing `gdal_array`), then `gdal.Translate()` it to a real
   on-disk-format GeoTIFF **inside another `/vsimem/` virtual file**
   (`COMPRESS=LZW, TILED=YES, BIGTIFF=IF_NEEDED`) and read those bytes back
   out — so the whole pipeline, fetch through final bytes, never touches a
   real temp file on disk.

### 5.6 The dependency-free GeoTIFF writer — `_write_geotiff_from_png()`

This is the piece worth understanding even if you never touch the XYZ path:
the **WMS branch has zero GDAL/rasterio dependency**. `_write_geotiff_from_png`
takes raw PNG bytes + a bbox and hand-assembles a valid baseline-TIFF +
GeoTIFF file by packing IFD (Image File Directory) tags directly with
`struct.pack` — no imaging or geospatial library at all on this path.

Tags written (baseline TIFF, values via a local `add_tag(tag, field_type, values)` helper):

| Tag | Meaning |
|---|---|
| 256 / 257 | ImageWidth / ImageLength |
| 258 | BitsPerSample (8 per channel) |
| 259 | Compression (1 = none) |
| 262 | PhotometricInterpretation (from the decoded PNG: RGB, grayscale, etc.) |
| 273 | StripOffsets (patched to the real offset once the IFD's own size is known) |
| 277 | SamplesPerPixel |
| 278 | RowsPerStrip (= full image height — single strip) |
| 279 | StripByteCounts |
| 284 | PlanarConfiguration (1 = chunky/interleaved) |
| 338 | ExtraSamples (set only for a 4-sample/RGBA image, marking the alpha channel) |

Plus the three tags that make it a **GeoTIFF**, not just a TIFF:

| Tag | Meaning |
|---|---|
| 33550 `ModelPixelScaleTag` | `[(maxx-minx)/width, (maxy-miny)/height, 0]` — ground units per pixel |
| 33922 `ModelTiepointTag` | `[0,0,0, minx,maxy,0]` — pixel (0,0) ties to the bbox's top-left corner |
| 34735 `GeoKeyDirectoryTag` | A hand-built GeoKey directory declaring: projected CS (key 1024/1025), geographic base CRS EPSG:4326 (key 2048), and projected CRS EPSG:3857 with linear units in metres (keys 3072/3076/9001) |

The function then: sorts entries by tag number (the TIFF spec requires IFD
entries in ascending tag order), inline-packs any value ≤4 bytes directly
into the IFD entry, spills anything larger into an "extra data" region
after the IFD and points the entry at that offset instead, and finally
concatenates `header + IFD + extra_data + pixel_data` into the returned
byte string. If you need this exact capability without GDAL as a
dependency, this function is a complete, self-contained reference for how
little a **valid, QGIS/ArcGIS-openable, correctly-georeferenced** GeoTIFF
actually requires.

### 5.7 If you don't want a georeferencing backend at all

The honest degraded option — which is what GCOP itself falls back to for
raster sources it can't identify as either WMS or XYZ — is a plain-text
connection-info file with the tile URL template and copy-paste instructions
for adding it as an XYZ/WMS layer directly in QGIS or ArcGIS Pro (see tier 4
in §4.6/§3).

---

## 6. Gotchas worth remembering

- **Naming convention is load-bearing.** The entire "what's active" and
  "what layer type is this" discovery is convention-based
  (`layerName`/`layerName_*`/`layerName-*`), not an explicit registry. If a
  new layer's map-layer ids don't follow the pattern, it silently won't be
  discovered by export (or by Layer Order, which shares the same helper).
- **Tier 3 exports are viewport/zoom-dependent**, not full datasets — surface
  that limitation to the user (GCOP does, via the `gcop_notice` metadata
  field and the panel's closing note) rather than letting them assume
  completeness.
- **Sequential exports, not parallel** — multiple simultaneous
  `<a download>` clicks in the same tick can be silently dropped by some
  browsers' download-throttling; GCOP's 80 ms gap between items and
  await-per-item loop avoids this.
- **WMS 1.1 vs 1.3 param naming** (`SRS=` vs `CRS=`) is not cosmetic — some
  WMS servers reject the wrong one outright rather than tolerating it.
- **CSRF / auth**: `NcopRasterExportView` is `@csrf_exempt` and carries no
  login/permission mixin of its own — the frontend sends the CSRF header
  anyway (harmless, just unnecessary here), but don't copy the exemption
  without deciding deliberately whether *your* equivalent endpoint should be
  open like this or gated behind whatever auth protects the rest of your API.
- **`verify=False` on outbound WMS requests** — GCOP does this because several
  proxied WMS/GeoServer endpoints have imperfect TLS chains; it's a
  conscious tradeoff in this codebase, not something to copy silently into
  a context where it matters more.
- The **Import tab** shares the same panel, button, and open/close state but
  is a materially larger, separate subsystem (file drag-drop, Shapefile .zip
  upload to `/upload-shapefile/`, WMS GetCapabilities browsing, per-layer
  symbology editor, stats) — treat it as its own integration task if you
  need it; this guide intentionally stops at Export.
