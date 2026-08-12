// gcop-pmd-integration.js
// ---------------------------------------------------------------------------
// PMD Weather Stations integration with the GCOP backend.
//
// The pmd_weather_stations layer used to hit the local Django proxy at
// `/get-weather-pmdffd-data/`, which merged three PMD product feeds.
// It now consumes the GCOP-normalised endpoint at
// `/api/pmd/monitor/stations/` (see GCOP_PMD_API_Integration.md §3.1),
// which returns a clean GeoJSON FeatureCollection of ~270 stations.
//
// The upstream schema differs from what the popup / weather report /
// rain-symbol filter currently expect, so we transform each feature's
// properties into the flat alias shape they consume:
//
//   wind_speed (m/s)  → windSpeed (knots, so popup's "kt" unit is correct)
//   wind_direction    → windDirection
//   rain_24h          → rainfall  (drives rain-symbol filter + report threshold)
//   date_time         → temp_date, temp_time, wind_date, wind_time,
//                       rainfall_date, rainfall_time  (all share one clock)
//
// Original upstream keys are preserved via `...props` so downstream code
// can also read them directly (e.g. `station_type`, `warn_temp`,
// `warn_rain`, `visibility`) — nothing is stripped.
// ---------------------------------------------------------------------------

import { getPmdStations } from "./gcop-api-cache.js";

const PMD_SOURCE_ID = "pmd_weather_stations-source";

// 1 m/s ≈ 1.94384 knots
const MS_TO_KT = 1.94384;

// Return a finite number or NULL — never coerce "missing / no reading" to 0.
// A station without a rain gauge should not show "0.0 mm"; it should show
// "N/A" (popup) or "—" (report table).  The old toNum() lied about zero.
function toNumOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeStation(feature) {
  if (!feature || typeof feature !== "object") return feature;
  const props = feature.properties || {};

  const dt = typeof props.date_time === "string" ? props.date_time : "";
  const [datePart, timePart] = dt ? dt.split(/[T\s]/) : ["", ""];

  // Wind: only convert m/s → kt when we actually received a number.
  const windMs = toNumOrNull(props.wind_speed);
  const windKt = windMs == null ? null : +(windMs * MS_TO_KT).toFixed(1);

  const normalized = {
    ...props,
    // Aliases the popup / weather report / rain-symbol filter expect.
    // NULL preserved end-to-end so "no reading" is visibly distinct from
    // "0.0" — both the popup's formatPMDValue() and the report's
    // #formatLayerCell() render null as N/A / — respectively.
    windSpeed:     windKt,
    windDirection: toNumOrNull(props.wind_direction),
    // rainfall alias = 24h total (drives the rain-symbol filter — a
    // filter comparing null to > 0 evaluates to false in Mapbox, which
    // is exactly what we want for "no rainfall sensor / no reading").
    rainfall:      toNumOrNull(props.rain_24h),
    temperature:   toNumOrNull(props.temperature),
    humidity:      toNumOrNull(props.humidity),
    pressure:      toNumOrNull(props.pressure),
    visibility:    toNumOrNull(props.visibility),
    // Additional numeric aliases so the popup / report can surface all
    // three rain windows without probing raw props themselves.
    rain_1h:       toNumOrNull(props.rain_1h),
    rain_6h:       toNumOrNull(props.rain_6h),
    rain_24h:      toNumOrNull(props.rain_24h),
    // Not present in the new upstream — surface as null so the popup's
    // "N/A" formatter kicks in instead of showing "0.0 °C".
    dewPoint:      props.dew_point ?? null,
    // The new payload has a single `date_time` field that applies to
    // every channel, so all three per-channel timestamps share it.
    temp_date:      datePart, temp_time:      timePart,
    wind_date:      datePart, wind_time:      timePart,
    rainfall_date:  datePart, rainfall_time:  timePart,
  };
  return { ...feature, properties: normalized };
}

function normalizeFC(fc) {
  if (!fc || !Array.isArray(fc.features)) {
    return { type: "FeatureCollection", features: [] };
  }
  return { type: "FeatureCollection", features: fc.features.map(normalizeStation) };
}

function hydrateStations(map) {
  const src = map.getSource(PMD_SOURCE_ID);
  if (!src) return;
  const current = src._data;
  // Only hydrate on the empty seed; a populated source is a no-op.
  if (!current || (current.features && current.features.length > 0)) return;
  getPmdStations()
    .then((raw) => {
      const fresh = map.getSource(PMD_SOURCE_ID);
      if (!fresh) return;
      fresh.setData(normalizeFC(raw));
    })
    .catch((err) => console.warn("[PMD Stations] hydration failed:", err));
}

/**
 * Install the PMD stations hydration hook.  Called once from
 * dashboard.js after the map + SourceLayerControl are constructed.
 */
export function initGcopPmdIntegration(map) {
  if (!map) return;
  map.on("sourcedata", (e) => {
    if (e.sourceId !== PMD_SOURCE_ID) return;
    if (!e.isSourceLoaded) return;
    hydrateStations(map);
  });
}