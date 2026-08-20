// gcop-monitor-integration.js
// ---------------------------------------------------------------------------
// Hydration hooks for every additional PMD Monitor / NWFC spatial layer.
// One shared `sourcedata` listener dispatches on `sourceId` to the right
// fetcher + optional normaliser and calls setData() once, only when the
// source is holding its empty seed FeatureCollection.
//
// The dispatch table below is the single source of truth for the map
// between a Mapbox source id and the GCOP endpoint that feeds it.
// Adding a new layer = add a new row to `DISPATCH` and drop the
// matching empty-seed source into map-layers.js.
//
// No wrapping of SourceLayerControl needed — every layer here uses
// exactly one source (no companion layers), so the pattern is simpler
// than the FFD rivers case in gcop-ffd-integration.js.
// ---------------------------------------------------------------------------

import {
  getPmdWarnings,
  getPmdMonsoon,
  getPmdGlofObs,
  getPmdLightning,
  getPmdCityForecast,
  getPmdGlacierLakes,
  getNwfcObservations,
} from "./gcop-api-cache.js";
import { registerNwfcWeatherIcons, nwfcWeatherIconId } from "./map-icons.js";
import { initNwfcHtmlMarkers } from "./nwfc-html-markers.js";

/**
 * NWFC observations normaliser — stamps a `wx_icon` string onto every
 * feature so the map layer can drive `icon-image` off a plain
 * `["get", "wx_icon"]` expression rather than a giant `match` block.
 * Uses the same `weather` / `wx` / `description` field probes as the
 * rest of the pipeline so a weather-emoji marker appears even when
 * the response uses one of the alias field names.
 */
function normaliseNwfcObservationsFC(raw) {
  const fc = toFC(raw);
  fc.features = fc.features.map((feat) => {
    if (!feat || typeof feat !== "object") return feat;
    const props = feat.properties || {};
    const wxText = props.weather ?? props.wx ?? props.description ?? props.condition ?? "";
    const iconId = nwfcWeatherIconId(wxText);
    // Stamp under BOTH names.  `wxIcon` (camelCase) is what the layer's
    // `["get", "wxIcon"]` match expression reads — a rename from the
    // previous `wx_icon` because the underscore variant returned null
    // in Mapbox v3's expression engine even though the property was
    // clearly present.  `wx_icon` is retained too so any downstream
    // consumer (popup, weather-report) that reads it keeps working.
    return {
      ...feat,
      properties: {
        ...props,
        wxIcon:  iconId,
        wx_icon: iconId,
      },
    };
  });
  return fc;
}

/**
 * Best-effort empty FC.  Some upstream endpoints degrade to
 * `{count:0, features:[]}` without the `type` field; some return the
 * inner list under a wrapper key.  This normalises everything the
 * downstream setData() call needs.
 */
function toFC(raw) {
  if (!raw) return { type: "FeatureCollection", features: [] };
  if (Array.isArray(raw.features)) {
    return { type: "FeatureCollection", features: raw.features };
  }
  if (Array.isArray(raw)) {
    return { type: "FeatureCollection", features: raw };
  }
  return { type: "FeatureCollection", features: [] };
}

/**
 * Dispatch table: sourceId → { fetch, normalize? }.
 * `fetch()` returns a Promise<any>.  `normalize()` is optional; when
 * omitted, `toFC()` is used directly.  Normalisers should return a
 * fully-formed FeatureCollection ready for `source.setData()`.
 */
const DISPATCH = {
  "pmd_warnings-source":         { fetch: getPmdWarnings },
  "pmd_monsoon-source":          { fetch: getPmdMonsoon },
  "pmd_glof_obs-source":         { fetch: getPmdGlofObs },
  "pmd_lightning-source":        { fetch: () => getPmdLightning(1) },
  "pmd_city_forecast-source":    { fetch: getPmdCityForecast },
  "pmd_glacier_lakes-source":    { fetch: getPmdGlacierLakes },
  "nwfc_observations-source":    { fetch: getNwfcObservations, normalize: normaliseNwfcObservationsFC },
};

function hydrate(map, sourceId) {
  const src = map.getSource(sourceId);
  if (!src) return;
  const current = src._data;
  // Only hydrate the empty seed.  Later ticks on a populated source
  // are no-ops — Mapbox emits `sourcedata` many times per lifecycle.
  if (!current || (current.features && current.features.length > 0)) return;
  const entry = DISPATCH[sourceId];
  if (!entry) return;

  entry.fetch()
    .then((raw) => {
      const fresh = map.getSource(sourceId);
      if (fresh) {
        const fc = entry.normalize ? entry.normalize(raw) : toFC(raw);
        fresh.setData(fc);
      }
    })
    .catch((err) => console.warn(`[GCOP Monitor] hydration failed (${sourceId}):`, err))
    .finally(() => {
      // Tells mapbox-functions.js's sidebar loading-spinner (showLayerLoading)
      // that this empty-seed source has now genuinely finished hydrating —
      // Mapbox's own `sourcedata`/isSourceLoaded fires almost instantly on
      // the tiny empty seed itself, long before this real fetch resolves,
      // so that signal alone isn't enough for these layers. Fires on
      // failure too, so an upstream error still clears the spinner instead
      // of leaving it stuck until the 20s bailout.
      window.dispatchEvent(new CustomEvent("ncop:source-hydrated", { detail: { sourceId } }));
    });
}

/**
 * Install a single shared `sourcedata` listener that dispatches to the
 * DISPATCH table.  Also registers the NWFC weather-emoji icon fleet
 * (thunderstorm / rain / drizzle / snow / fog / dust / overcast /
 * cloudy / partly cloudy / clear / windy / hot / cold / default) so
 * the nwfc_observations symbol layer has every image it needs the
 * moment the layer is toggled on.  Called once from dashboard.js
 * after the map is constructed.
 */
export function initGcopMonitorIntegration(map) {
  if (!map) return;

  // Weather-emoji icon registration — idempotent, so we can safely
  // call it on every style reload without leaking images.  Fires on
  // initial map load and again after each basemap change (setStyle
  // wipes all registered images).
  const registerIcons = () => {
    try { registerNwfcWeatherIcons(map); }
    catch (err) { console.warn("[NWFC] weather icons failed to register:", err); }
  };
  if (typeof map.isStyleLoaded === "function" && map.isStyleLoaded()) registerIcons();
  map.on("load", registerIcons);
  map.on("style.load", registerIcons);

  map.on("sourcedata", (e) => {
    if (!e.isSourceLoaded) return;
    if (!DISPATCH[e.sourceId]) return;
    hydrate(map, e.sourceId);
  });

  // NWFC observations: bring up the HTML mapboxgl.Marker manager.
  // The visible weather icons + temperature labels for that layer are
  // rendered as HTML markers (per GCOP's own approach) — the Mapbox
  // circle layer defined in map-layers.js is a zero-opacity click
  // target only.  The marker manager listens to its own sourcedata /
  // style.load events, so no additional wiring is needed here.
  try { initNwfcHtmlMarkers(map); }
  catch (err) { console.warn("[NWFC] HTML markers failed to init:", err); }
}