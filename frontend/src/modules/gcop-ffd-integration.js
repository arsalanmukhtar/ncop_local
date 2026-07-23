// gcop-ffd-integration.js
// ---------------------------------------------------------------------------
// FFD-specific glue between the GCOP backend and the map.  Two responsibilities:
//
//   1. Hydration — the ffd_data-source ships as an empty seed FC (see
//      map-layers.js §FFD Data).  When Mapbox reports the source loaded,
//      we pull the live waterlevels from the GCOP TTL cache and swap it
//      in via setData().  Idempotent: only fires when the source is
//      still holding the empty seed.
//
//   2. Rivers companion layer — the ffd_data toggle now also drives a
//      companion river-basin polygon layer sourced from
//      /get-ffd-rivers/.  Add / remove of the rivers source+layers is
//      wired to the SourceLayerControl toggle for `ffd_data`, so a
//      single sidebar switch controls both the gauge points and the
//      basin polygons.  Rivers are placed BELOW the gauge circle layer
//      so points remain interactive on top.
//
// Zero core-logic edits to SourceLayerControl / LayerStyleConfig — we
// wrap addLayerByKey / removeLayerByKey the same way LayerStyleConfig
// already does.
// ---------------------------------------------------------------------------

import { getFfdWaterlevels, getFfdRivers } from "./gcop-api-cache.js";

const FFD_SOURCE_ID = "ffd_data-source";
const RIVERS_SOURCE_ID = "ffd_data-rivers-source";
const RIVERS_FILL_ID = "ffd_data-rivers-fill";
const RIVERS_LINE_ID = "ffd_data-rivers-line";
const FFD_CIRCLE_ID = "ffd_data-circle";

/**
 * Populate the ffd_data-source with live waterlevels if it's still empty.
 * Called from the map's `sourcedata` handler, so may fire many times —
 * the early return on non-empty features keeps subsequent hits cheap.
 */
function hydrateWaterlevels(map) {
  const src = map.getSource(FFD_SOURCE_ID);
  if (!src) return;
  const current = src._data;
  if (!current || (current.features && current.features.length > 0)) return;
  getFfdWaterlevels()
    .then((geo) => {
      const fresh = map.getSource(FFD_SOURCE_ID);
      if (fresh && geo && Array.isArray(geo.features)) fresh.setData(geo);
    })
    .catch((err) => console.warn("[FFD] waterlevels hydration failed:", err));
}

/**
 * Add the rivers source and its fill+line layers to the map, positioned
 * below the ffd_data-circle so gauges remain the top interactive layer.
 * Idempotent — safe to call on every ffd_data toggle-ON; existing
 * layers are skipped and visibility is restored if it had been hidden.
 */
async function ensureRiversLayer(map) {
  // Restore visibility if they already exist (repeat toggle-on)
  if (map.getSource(RIVERS_SOURCE_ID)) {
    for (const id of [RIVERS_FILL_ID, RIVERS_LINE_ID]) {
      if (map.getLayer(id)) {
        try { map.setLayoutProperty(id, "visibility", "visible"); } catch {}
      }
    }
    return;
  }
  let geo;
  try {
    geo = await getFfdRivers();
  } catch (err) {
    console.warn("[FFD Rivers] fetch failed:", err);
    return;
  }
  if (!geo || !Array.isArray(geo.features)) return;
  // Race guard: another call may have added the source while we awaited.
  if (map.getSource(RIVERS_SOURCE_ID)) return;

  try {
    map.addSource(RIVERS_SOURCE_ID, { type: "geojson", data: geo });
  } catch (err) {
    console.warn("[FFD Rivers] addSource failed:", err);
    return;
  }

  const beforeId = map.getLayer(FFD_CIRCLE_ID) ? FFD_CIRCLE_ID : undefined;

  // Fill — applies only to Polygon/MultiPolygon; per-feature color/opacity
  // fall back to sane defaults if the property is missing.
  if (!map.getLayer(RIVERS_FILL_ID)) {
    try {
      map.addLayer({
        id: RIVERS_FILL_ID,
        type: "fill",
        source: RIVERS_SOURCE_ID,
        paint: {
          "fill-color": [
            "case",
            ["==", ["typeof", ["get", "color"]], "string"], ["get", "color"],
            "#3388cc",
          ],
          "fill-opacity": [
            "case",
            ["==", ["typeof", ["get", "opacity"]], "number"], ["get", "opacity"],
            0.20,
          ],
        },
      }, beforeId);
    } catch (err) {
      console.warn("[FFD Rivers] fill addLayer failed:", err);
    }
  }

  // Outline — works on both Polygon and LineString geometries.
  if (!map.getLayer(RIVERS_LINE_ID)) {
    try {
      map.addLayer({
        id: RIVERS_LINE_ID,
        type: "line",
        source: RIVERS_SOURCE_ID,
        paint: {
          "line-color": [
            "case",
            ["==", ["typeof", ["get", "color"]], "string"], ["get", "color"],
            "#0074D9",
          ],
          "line-width": 1.5,
          "line-opacity": 0.85,
        },
      }, beforeId);
    } catch (err) {
      console.warn("[FFD Rivers] line addLayer failed:", err);
    }
  }
}

/**
 * Fully remove the rivers layers and source from the map.  Called when
 * the ffd_data toggle is turned OFF so rivers vanish alongside gauges.
 */
function teardownRiversLayer(map) {
  for (const id of [RIVERS_LINE_ID, RIVERS_FILL_ID]) {
    try { if (map.getLayer(id)) map.removeLayer(id); } catch {}
  }
  try { if (map.getSource(RIVERS_SOURCE_ID)) map.removeSource(RIVERS_SOURCE_ID); } catch {}
}

/**
 * Install every FFD-integration hook on the map + SourceLayerControl.
 * Called once from dashboard.js after both are constructed.
 */
export function initGcopFfdIntegration(map, sourceLayerControl) {
  if (!map || !sourceLayerControl) return;

  // Waterlevels: hydrate on sourcedata (fires on initial add and any
  // basemap-switch re-add; setData is a no-op once features.length > 0).
  map.on("sourcedata", (e) => {
    if (e.sourceId !== FFD_SOURCE_ID) return;
    if (!e.isSourceLoaded) return;
    hydrateWaterlevels(map);
  });

  // Rivers: wrap the toggle so a single sidebar switch drives both
  // gauge points and river polygons.  Same wrapping pattern
  // LayerStyleConfig already uses — no core logic edit.
  const origAdd = sourceLayerControl.addLayerByKey.bind(sourceLayerControl);
  const origRem = sourceLayerControl.removeLayerByKey.bind(sourceLayerControl);
  sourceLayerControl.addLayerByKey = (key, ...rest) => {
    const r = origAdd(key, ...rest);
    if (key === "ffd_data" && r !== false) ensureRiversLayer(map);
    return r;
  };
  sourceLayerControl.removeLayerByKey = (key, ...rest) => {
    if (key === "ffd_data") teardownRiversLayer(map);
    return origRem(key, ...rest);
  };
}