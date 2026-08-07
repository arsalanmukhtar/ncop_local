// weather-report-control.js
import {
  getFfdBulletins,
  getNwfcWeeklyOutlook,
  getNwfcReports,
  getNwfcMaxTemperatures,
  getPmdPublicForecast,
  getNwfcForecast,
  getNwfcPressReleaseText,
} from "./gcop-api-cache.js";
import { pmdWarningsFilter } from "./pmd-warnings-filter.js";

// =========================================================================
// District-level Weather Report
// -------------------------------------------------------------------------
// Adds a rail button + slide-from-right panel that, when open, renders a
// dynamic per-district summary of the *currently active* temporal Meteoblue
// layer. The slider value, the active layer key, and the visibility of the
// district / provincial boundary layers are all read at render time, so
// the panel automatically reflects whatever the user has playing on the
// slider.
//
// Performance notes:
//   - Render is gated on .visible — when the panel is closed, no work runs.
//   - The slider input event is debounced via requestAnimationFrame, so
//     dragging the slider produces at most one render per frame.
//   - District + province features are pulled with a single
//     queryRenderedFeatures call each, then cached for the render pass.
//   - We dedupe districts by name and skip districts whose centroid isn't
//     covered by the active vector layer (no signal → not in report).
// =========================================================================

const PANEL_ID = "weatherReportPanel";
const BTN_ID = "weatherReportToggle";

// =========================================================================
// PMD Overview — tracked layers config
// -------------------------------------------------------------------------
// One entry per toggleable layer we surface as its own "Active Layer"
// card inside the PMD Overview tab.  `primaryLayerId` is the Mapbox
// layer id we use to detect toggle-on state; `sourceId` is where we
// pull the source's cached FeatureCollection from.  `columns` describes
// the flat data table underneath the legend.
// =========================================================================
// Accent-colour language mirrors GCOP §2 so operators can pattern-match
// on category by dot colour without reading labels:
//   FFD River Telemetries       — green   #86efac
//   Pakistan Weather / Monitor  — blue    #93c5fd
//   NWFC Observations           — cyan    #7dd3fc
//   GLOF Stations               — teal    #67e8f9
//   PMD Monitor Warnings        — red     #fca5a5
//   Lightning                   — amber   #fde68a
//   City Forecast               — violet  #c4b5fd
const PMD_TAB_TRACKED_LAYERS = {
  ffd_data: {
    label: "FFD River Telemetries",
    primaryLayerId: "ffd_data-circle",
    sourceId: "ffd_data-source",
    icon: { shape: "circle", color: "#86efac" },
    legend: [
      { label: "Normal",    color: "#28a745" },
      { label: "Low",       color: "#17a2b8" },
      { label: "Medium",    color: "#ffc107" },
      { label: "High",      color: "#fd7e14" },
      { label: "Very High", color: "#dc3545" },
      { label: "Ex High",   color: "#6f42c1" },
    ],
    // §2.1 schema: name, area_name (river), height, status (Normal /
    // Low / Medium / High / Very High / Exceptionally High), discharge
    // (comma-formatted cusecs string), recording_time (PKT).
    columns: [
      { key: "name",           label: "Gauge" },
      { key: "area_name",      label: "River" },
      { key: "status",         label: "Status", chip: "status" },
      { key: "discharge",      label: "Discharge" },
      { key: "recording_time", label: "Time" },
    ],
    maxRows: 15,
    emptyText: "No FFD gauges loaded yet.",
  },
  pmd_weather_stations: {
    label: "PMD Weather Stations",
    primaryLayerId: "pmd_weather_stations-sun-symbol",
    sourceId: "pmd_weather_stations-source",
    icon: { shape: "circle", color: "#93c5fd" },
    legend: [
      { label: "Blue",   color: "#3b82f6" },
      { label: "Yellow", color: "#eab308" },
      { label: "Orange", color: "#f97316" },
      { label: "Red",    color: "#dc2626" },
    ],
    // Columns match the §3.1 schema.  All measurement fields are
    // nullable — the normaliser preserves null for "no sensor / no
    // reading" instead of coercing to 0.
    columns: [
      { key: "name",         label: "Station" },
      { key: "station_type", label: "Type",  chip: "kind" },
      { key: "temperature",  label: "T",     unit: "°C", numeric: 1 },
      { key: "rainfall",     fallback: "rain_24h", label: "Rain 24h", unit: "mm", numeric: 1 },
      { key: "windSpeed",    label: "Wind",  unit: "kt", numeric: 1 },
      { key: "visibility",   label: "Vis",   unit: "km", numeric: 1 },
    ],
    maxRows: 15,
    emptyText: "No station features loaded yet.",
  },
  pmd_warnings: {
    label: "PMD Weather Warnings",
    primaryLayerId: "pmd_warnings-fill",
    sourceId: "pmd_warnings-source",
    icon: { shape: "square", color: "#fca5a5" },
    legend: [
      { label: "Red",     color: "#dc2626" },
      { label: "Orange",  color: "#f97316" },
      { label: "Yellow",  color: "#eab308" },
      { label: "Blue",    color: "#3b82f6" },
      { label: "T-storm", color: "#a21caf" },
      { label: "Gust",    color: "#7c3aed" },
    ],
    columns: [
      { key: "element_label", fallback: "element",     label: "Type" },
      { key: "level",         label: "Level",          chip: "level" },
      { key: "area_km2",      label: "Area", unit: "km²", numeric: 0 },
      { key: "forecast_time", fallback: "data_time",   label: "Valid" },
    ],
    maxRows: 15,
    emptyText: "No active warnings.",
  },
  pmd_monsoon: {
    label: "Monsoon Warnings",
    primaryLayerId: "pmd_monsoon-fill",
    sourceId: "pmd_monsoon-source",
    icon: { shape: "square", color: "#0ea5e9" },
    legend: [
      { label: "Red",    color: "#dc2626" },
      { label: "Orange", color: "#f97316" },
      { label: "Yellow", color: "#eab308" },
      { label: "Blue",   color: "#3b82f6" },
    ],
    columns: [
      { key: "province",      label: "Province" },
      { key: "level",         label: "Level", chip: "level" },
      { key: "type",          label: "Type" },
      { key: "rain_24h",      label: "24h",   unit: "mm", numeric: 1 },
      { key: "rain_forecast", label: "Fcst",  unit: "mm", numeric: 1 },
    ],
    maxRows: 15,
    emptyText: "No monsoon warnings issued.",
  },
  pmd_lightning: {
    label: "Lightning Strikes",
    primaryLayerId: "pmd_lightning-circle",
    sourceId: "pmd_lightning-source",
    icon: { shape: "circle", color: "#fde68a" },
    legend: [],
    columns: [
      { key: "time",       fallback: "obs_time", label: "Time" },
      { key: "intensity",  fallback: "value",    label: "Intensity", numeric: 0 },
      { key: "type",       label: "Type" },
    ],
    maxRows: 15,
    emptyText: "No lightning strikes in the last hour.",
  },
  pmd_city_forecast: {
    label: "City 12-Step Forecast",
    primaryLayerId: "pmd_city_forecast-circle",
    sourceId: "pmd_city_forecast-source",
    icon: { shape: "circle", color: "#c4b5fd" },
    legend: [
      { label: "<15°",   color: "#2563eb" },
      { label: "15-25°", color: "#22c55e" },
      { label: "25-32°", color: "#facc15" },
      { label: "32-40°", color: "#f97316" },
      { label: "40°+",   color: "#ef4444" },
    ],
    columns: [
      { key: "name",       fallback: "city", label: "City" },
      { key: "temp",       label: "T",       unit: "°C", numeric: 1 },
      { key: "weather",    label: "Wx" },
      { key: "humidity",   label: "RH",      unit: "%",   numeric: 0 },
      { key: "wind_speed", label: "Wind",    unit: "m/s", numeric: 1 },
    ],
    maxRows: 15,
    emptyText: "No city forecast features loaded yet.",
  },
  nwfc_observations: {
    label: "NWFC Station Observations",
    primaryLayerId: "nwfc_observations-click",
    sourceId: "nwfc_observations-source",
    icon: { shape: "circle", color: "#7dd3fc" },
    legend: [],
    // NWFC §4.1 exposes rain_3h and rain_24h — surface both since
    // stations can be reporting on either window.
    columns: [
      { key: "name",         label: "Station" },
      { key: "temperature",  label: "T",     unit: "°C", numeric: 1 },
      { key: "rain_24h",     label: "24h",   unit: "mm", numeric: 1 },
      { key: "rain_3h",      label: "3h",    unit: "mm", numeric: 1 },
      { key: "weather",      label: "Wx" },
    ],
    maxRows: 15,
    emptyText: "No NWFC observations loaded yet.",
  },
  pmd_glof_obs: {
    label: "GLOF Stations",
    primaryLayerId: "pmd_glof_obs-circle",
    sourceId: "pmd_glof_obs-source",
    icon: { shape: "circle", color: "#67e8f9" },
    legend: [
      { label: "Normal",    color: "#22c55e" },
      { label: "Watch",     color: "#facc15" },
      { label: "Warning",   color: "#f97316" },
      { label: "Emergency", color: "#dc2626" },
    ],
    // §3.5 schema: id, name, city, province, station_type, obs_time,
    // water_level (m), flow (m³/s), rainfall (mm), rain_intensity,
    // alert_level (0/20/40/60), alert_label (NORMAL / WATCH /
    // WARNING / EMERGENCY), connectivity (OK / OFFLINE /
    // SENSOR_FAULT), has_water_level_sensor, stale.
    columns: [
      { key: "name",         label: "Station" },
      { key: "city",         label: "City" },
      { key: "alert_label",  label: "Alert", chip: "alert" },
      { key: "water_level",  label: "WL",    unit: "m",     numeric: 2 },
      { key: "rainfall",     label: "Rain",  unit: "mm",    numeric: 1 },
      { key: "connectivity", label: "Link",  chip: "kind" },
    ],
    maxRows: 15,
    emptyText: "No GLOF stations loaded yet.",
  },
};

// =========================================================================
// Researched thresholds (single source of truth)
// -------------------------------------------------------------------------
// Sources: WHO 2021 Air Quality Guidelines, US EPA AQI breakpoints, IMD/PMD
// rainfall classifications, Pakistan Met Department heat advisories.  These
// are intentionally hard-coded so the report's "alert" semantics stay
// stable across deployments.  Tuning a value? Edit it here and grep for
// the kind to find every renderer using it.
// =========================================================================
const T = {
  // Temperature (°C) — PMD heat advisory ladder. >=40 starts being
  // dangerous in the Indus plains; >=42 is extreme.  Cold side: -15 is
  // rare in Pakistan but flagged for high-altitude regions.
  TEMP_HOT: 42,
  TEMP_COLD: -15,
  STATION_TEMP_HOT: 40, // tighter for in-situ readings (station accuracy)

  // Precipitation (mm) — IMD/PMD daily classifications.  Hourly is much
  // tighter because intense bursts cause flash flooding.
  RAIN_HOURLY_HEAVY: 10,
  RAIN_DAILY_HEAVY: 50, // daily rainfall classified "heavy"
  RAIN_WEEKLY_HEAVY: 100, // weekly accumulation flag
  RAIN_STATION_ALERT: 25, // station hourly accumulation alert

  // Snowfall (mm liquid-water-equivalent) — daily totals.
  SNOW_HOURLY_HEAVY: 5,
  SNOW_DAILY_HEAVY: 30,

  // Convection / severe weather (J/kg)
  CAPE_ALERT: 1000, // moderate-to-severe instability
  HELICITY_ALERT: 300, // tornadic supercell potential

  // Air Quality Index (US EPA scale) — 101 is the "Unhealthy for Sensitive
  // Groups" threshold; many public-health bodies issue advisories at 101+.
  AQI_USG: 101,
  AQI_UNHEALTHY: 151,

  // Pollutant concentrations (µg/m³) — WHO 2021 24-hour guideline values.
  // Alerts fire when concentrations exceed the WHO target by a margin that
  // typical EU/EPA standards use as their hard limit.
  PM25_ALERT: 35,
  PM10_ALERT: 100,
  NO2_ALERT: 40,
  SO2_ALERT: 75,
  CO_ALERT: 10000, // = 10 mg/m³, EPA 8-h alert level

  // Aerosol products
  DUST_ALERT: 200, // µg/m³, heavy dust event
  AOD_ALERT: 0.5, // unitless, visibility/health concern
};

// =========================================================================
// PMD Forecast raster layers (pmd_pred_*) — separate from LAYER_KIND_MAP
// above on purpose. Those Meteoblue-branded entries are VECTOR tiles with
// a `minValue` feature property, sampled via queryRenderedFeatures — the
// existing Dynamic Report tab explicitly treats any `kind: "raster"`
// temporal as a dead end for per-district numbers (see the "raster-only"
// branch in #renderReport) because there was historically nothing to
// sample. pmd_pred_* layers ARE rasters (Mapbox `image` sources, colorized
// server-side from WRFPRS/GDFS GeoTIFFs — see map-layers.js:522-538), but
// the backend now separately exposes their real numeric grid via
// /api/pmd/monitor/predictions/<element>/value/?lat=&lon=&step_index=
// (PmdMonitorPredictionValueAPIView), so they get their own map + their
// own PMD-Overview-tab section below instead of being folded into the
// vector-only Dynamic Report path.
// itemKey → elementKey is a straight `pmd_pred_` prefix strip (verified
// against every window.pmd_pred_* registration in map-layers.js); `kind`
// selects which T.* threshold this element's alert styling uses.
// =========================================================================
const PMD_FORECAST_ELEMENT_MAP = {
  pmd_pred_hourtpe:       { elementKey: "hourtpe",       kind: "precip_hourly" },
  pmd_pred_sixtpe:        { elementKey: "sixtpe",        kind: "precip_hourly" },
  pmd_pred_twelvetpe:     { elementKey: "twelvetpe",     kind: "precip_daily" },
  pmd_pred_daytpe:        { elementKey: "daytpe",        kind: "precip_daily" },
  pmd_pred_temp2m:        { elementKey: "temp2m",        kind: "temperature" },
  pmd_pred_cloud_cover:   { elementKey: "cloud_cover",   kind: "neutral" },
  pmd_pred_rel_humidity:  { elementKey: "rel_humidity",  kind: "neutral" },
  pmd_pred_ext_high_temp: { elementKey: "ext_high_temp", kind: "temperature" },
  pmd_pred_ext_low_temp:  { elementKey: "ext_low_temp",  kind: "temperature_cold" },
};

// Point-value cache for the endpoint above — keyed coarsely (2 decimal
// places ≈ 1.1km, well under a district's size) so nearby district
// centroids across repeated renders/tab-switches share one entry instead
// of re-hitting the backend (which itself does real GDAL file I/O per
// call). 30 min TTL: long enough that switching tabs back and forth or
// re-opening the panel doesn't re-fetch, short enough to pick up the
// next PMD model run (~4x/day) within a session.
const PMD_FORECAST_VALUE_TTL_MS = 30 * 60 * 1000;
const _pmdForecastValueCache = new Map();
async function _fetchPmdForecastValue(elementKey, lat, lon, stepIndex) {
  const key = `${elementKey}|${stepIndex}|${lat.toFixed(2)}|${lon.toFixed(2)}`;
  const hit = _pmdForecastValueCache.get(key);
  if (hit && Date.now() - hit.ts < PMD_FORECAST_VALUE_TTL_MS) return hit.data;
  const url = `${window.location.origin}/api/pmd/monitor/predictions/${elementKey}/value/`
    + `?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&step_index=${encodeURIComponent(stepIndex)}`;
  let data = null;
  try {
    const r = await fetch(url, { credentials: "same-origin" });
    if (r.ok) data = await r.json();
  } catch {
    data = null;
  }
  _pmdForecastValueCache.set(key, { data, ts: Date.now() });
  return data;
}

// Small bounded-concurrency map — caps in-flight requests to the value
// endpoint (each one does real backend GDAL file I/O) instead of firing
// one fetch per district in the viewport at once.
async function _mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

// Map of temporal layer key → { kind, label, sourceLayers[] }.  `kind`
// drives signal interpretation (rainfall vs snowfall vs temperature etc.).
// `sourceLayers` lists the mapbox vector "source-layer" names whose
// features hold the numeric reading on the `minValue` property.
export const LAYER_KIND_MAP = {
  weekly_precipitation_2m_above_ground: {
    kind: "precipitation",
    label: "Weekly Precipitation",
    sourceLayers: ["precip", "snow"],
    cadence: "weekly",
  },
  hourly_precipitation_2m_above_ground: {
    kind: "precipitation",
    label: "Hourly Precipitation",
    sourceLayers: ["precip", "layerSnow"],
    cadence: "hourly",
  },
  hourly_snowfall_forecast: {
    kind: "snowfall",
    label: "Hourly Snowfall",
    sourceLayers: ["snow"],
    cadence: "hourly",
  },
  weekly_snowfall_forecast: {
    kind: "snowfall",
    label: "Weekly Snowfall",
    sourceLayers: ["snow"],
    cadence: "weekly",
  },
  cape_hourly_forecast: {
    kind: "cape",
    label: "CAPE (Hourly)",
    sourceLayers: ["layerCAPEInternal"],
    cadence: "hourly",
  },
  cape_weekly_forecast: {
    kind: "cape",
    label: "CAPE (Weekly)",
    sourceLayers: ["layerCAPEInternal"],
    cadence: "weekly",
  },
  storm_helicity_forecast_0_3km: {
    kind: "storm_helicity",
    label: "Storm Helicity 0–3 km",
    sourceLayers: ["stormhelicityColortable"],
    cadence: "hourly",
  },
  temperature_2m_above_ground: {
    kind: "temperature",
    label: "Temperature (2 m)",
    sourceLayers: ["temperatureColortable"],
    cadence: "hourly",
  },
  precipitation_radar: {
    kind: "raster",
    label: "Precipitation Radar",
    sourceLayers: [],
    cadence: "hourly",
  },

  // ---- Meteoblue Air-Quality Forecast (hourly + daily variants) ---------
  cams_air_quality_index_hourly: {
    kind: "aqi",
    label: "AQI (Hourly)",
    sourceLayers: ["aqiColortable"],
    cadence: "hourly",
  },
  cams_air_quality_index_daily: {
    kind: "aqi",
    label: "AQI (Daily)",
    sourceLayers: ["aqiColortable"],
    cadence: "daily",
  },
  cams_desert_dust_hourly: {
    kind: "desert_dust",
    label: "Desert Dust (Hourly)",
    sourceLayers: ["desertDust"],
    cadence: "hourly",
  },
  cams_desert_dust_daily: {
    kind: "desert_dust",
    label: "Desert Dust (Daily)",
    sourceLayers: ["desertDust"],
    cadence: "daily",
  },
  cams_aerosol_optical_depth_hourly: {
    kind: "aod",
    label: "AOD (Hourly)",
    sourceLayers: ["aod"],
    cadence: "hourly",
  },
  cams_aerosol_optical_depth_daily: {
    kind: "aod",
    label: "AOD (Daily)",
    sourceLayers: ["aod"],
    cadence: "daily",
  },
  cams_nitrogen_dioxide_daily: {
    kind: "no2",
    label: "NO₂ (Daily)",
    sourceLayers: ["no2"],
    cadence: "daily",
  },
  cams_carbon_monoxide_daily: {
    kind: "co",
    label: "CO (Daily)",
    sourceLayers: ["COColorTable"],
    cadence: "daily",
  },
  cams_sulphur_dioxide_daily: {
    kind: "so2",
    label: "SO₂ (Daily)",
    sourceLayers: ["so2"],
    cadence: "daily",
  },
};

// =========================================================================
// Station-based sources — driven by the "toggle on AND visible" rule, not
// by the temporal slider.  When no temporal layer is active, the highest-
// priority visible station feeds the report.  Even when a temporal IS
// active, stations can enrich each district card with additional readings
// (rendered as small tags below the primary reading).
// =========================================================================
const STATION_KIND_MAP = {
  // WAQI air-quality station network — `aqi` is the primary numeric.
  waqi_stations: {
    kind: "aqi",
    label: "WAQI Stations",
    layerIds: ["waqi_stations-circle"],
    valueProp: "aqi",
  },
  // PMD MET monitoring rainfall — symbol layer; `rainfall` is the metric
  // that drives the rain-vs-sun icon split in the layer's own styling.
  pmd_weather_stations: {
    kind: "rainfall_station",
    label: "PMD Weather Stations",
    layerIds: [
      "pmd_weather_stations-sun-symbol",
      "pmd_weather_stations-rain-symbol",
    ],
    valueProp: "rainfall",
  },
  // Heatwave city points — `temperature` (°C) drives circle color/size.
  // Uses `temperature_station` (a station-tightened variant of the
  // `temperature` kind) so the threshold is the EPA station-accuracy
  // value (T.STATION_TEMP_HOT = 40 °C) instead of the looser 42 °C
  // forecast threshold.  Symmetric with rainfall_station vs
  // precipitation in the temporal kinds.
  heatwave_monitoring: {
    kind: "temperature_station",
    label: "Heatwave Monitoring",
    layerIds: ["heatwave_monitoring-circle"],
    valueProp: "temperature",
  },
};

// Property keys we'll search across for district / province names. The
// boundary tiles come from GeoServer (gcop:district_boundary,
// gcop:provincial_boundary) and the canonical key may vary by deployment.
const DISTRICT_NAME_KEYS = [
  "name",
  "NAME",
  "district",
  "district_name",
  "districtname",
  "DISTRICT",
  "DISTRICT_NAME",
];
// Keys for *province feature* dedup — province polygons carry their own
// name in `name`/`NAME` so generic keys are correct here.
const PROVINCE_NAME_KEYS = [
  "name",
  "NAME",
  "province",
  "province_name",
  "provincename",
  "PROVINCE",
  "PROVINCE_NAME",
  "admin1",
  "ADM1_EN",
  "prov_name",
];

// Keys for reading the PROVINCE NAME from a DISTRICT feature.  Excludes
// generic `name`/`NAME` because those hold the *district's* own name —
// without this separation, every district reported its own name as its
// province (the "34 PROVINCES for 34 districts" bug in the screenshot).
const DISTRICT_PROVINCE_PROP_KEYS = [
  "province",
  "province_name",
  "provincename",
  "PROVINCE",
  "PROVINCE_NAME",
  "admin1",
  "ADM1_EN",
  "prov_name",
];

const DISTRICT_LAYER_IDS = [
  "district_boundary-fill",
  "district_boundary-outline",
];
const PROVINCE_LAYER_IDS = [
  "provincial_boundary-fill",
  "provincial_boundary-outline",
];

export class WeatherReportControl {
  #map;
  #panelEl = null;
  #btnEl = null;
  #contentEl = null;
  #footerEl = null;
  #subtitleEl = null;
  #titleEl = null;
  #thresholdEl = null;
  #thresholdValueEl = null;

  // Tab machinery.  #activeTab tracks which panel body is currently
  // shown ("dynamic" = the district-level dynamic report, "pmd" = the
  // static PMD Overview built from the GCOP cache helpers).
  // #pmdContentEl is the second body container we lazily populate the
  // first time the PMD tab is opened; #pmdLoaded avoids re-fetching
  // when the user toggles back and forth within the cache windows.
  #tabsEl = null;
  #pmdContentEl = null;
  #activeTab = "dynamic";
  #pmdLoaded = false;
  #pmdLoading = false;

  // Container for the auto-updating "Active Layers" block inside the
  // PMD Overview tab.  Rewritten whenever a tracked layer's toggle
  // changes or its source loads new data.
  #activeLayersEl = null;
  #activeLayersTimerId = null;
  #activeLayersFingerprint = "";

  // Container for the "PMD Forecast — Active Layer" block — per-district
  // numeric samples of whichever pmd_pred_* raster layer is on the
  // temporal slider. Same lazily-populated-placeholder pattern as
  // #activeLayersEl above: written into a fixed empty <div> right after
  // the sync PMD Overview render, filled in async afterward so slow
  // per-district sampling never blocks the rest of the tab's paint.
  #pmdForecastEl = null;
  // Generation counter guarding the async sampling pass below — unlike
  // #refreshActiveLayers (synchronous, no await, so no interleaving is
  // possible), this one does real network round-trips. Without this, a
  // slow in-flight refresh (e.g. from a tab switch that's since been
  // superseded by another switch back, or a rapid double-click on
  // Refresh) could resolve after a newer pass and stomp its result.
  #pmdForecastGen = 0;

  // Snapshot of every endpoint result from the last PMD Overview
  // render — the Download HTML / CSV buttons pull from here so the
  // exported report is exactly what the operator is looking at.
  // Individual entries may be null if that endpoint failed.
  #pmdRawData = {
    outlook: null,
    bulletins: null,
    reports: null,
    maxTemps: null,
    publicFc: null,
    nwfcFc: null,
  };
  #pmdClickBound = false;

  // Snapshot of the last successful Dynamic Report render — the Word/PDF
  // export buttons pull from here so the download always matches what
  // the user is currently looking at.  All references, no cloning —
  // rows/meta/state are already in memory during the render pass and
  // won't be mutated after being handed here.  Cleared on the empty /
  // loading paths so the export buttons stay disabled until real data
  // is on screen.
  #lastReport = null; // { rows, meta, state, generatedAt: Date }
  #wrpExportDocBtn = null;
  #wrpExportPdfBtn = null;

  // §3.4 drill-down state — "overview" is the default multi-section
  // scroll; the other values are the dedicated full-content sub-views
  // reached via the drill button strip.
  #pmdView = "overview";

  // Throttle bookkeeping. `#renderTimerId` covers both rAF and setTimeout
  // ids so we have a single "is a render queued" flag to check.
  #renderTimerId = null;
  #lastRenderAt = 0;

  // Skip-redundant-render fingerprint. Each render computes a string
  // describing its inputs (active layer + step + viewport bounds + which
  // station layers are visible).  If the new fingerprint matches the
  // last AND the last render produced a real report (not a loading /
  // empty state), we skip — district queries + per-feature sampling is
  // the app's hottest cost path.  The `lastRenderComplete` gate prevents
  // us from getting stuck on a "Fetching results…" spinner once tiles
  // arrive (because tile-load events don't change the fingerprint).
  #lastFingerprint = "";
  #lastRenderComplete = false;

  // Listeners are wired only while the panel is open.  Closing the panel
  // detaches them so the cost of every map idle / slider input / DOM
  // mutation drops to zero when the user isn't looking at the report.
  #observer = null;
  #boundOnSliderInput = null;
  #boundOnTemporalDom = null;
  #boundOnMapMove = null;
  #boundOnMapIdle = null;
  #listenersAttached = false;

  constructor(map) {
    this.#map = map;
    this.#render();
    this.#wireToggle();
    // Listeners attach lazily on panel open — see #attachListeners.

    // Expose the instance so other modules (the story panel's Dynamic
    // Weather Report mode) can reuse the sampling primitives below
    // without duplicating them. Purely additive — nothing here reads
    // this back, so it can't affect the Dynamic Report tab itself.
    window.ncopWeatherReportControl = this;
  }

  // -------------------------------------------------------------- DOM build
  #render() {
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    // Button — wrapper div mirrors the LayerStyleConfig pattern so the
    // unified rail picker (`buildUnifiedRightRail`) finds it via class.
    const wrapper = document.createElement("div");
    wrapper.className = "custom-weather-report-control";
    wrapper.innerHTML = `
      <button id="${BTN_ID}" class="custom-weather-report-btn" type="button"
              title="Weather Report">
        <i data-lucide="clipboard-list"></i>
      </button>
    `;
    mapContainer.appendChild(wrapper);
    this.#btnEl = wrapper.querySelector(`#${BTN_ID}`);

    // Panel
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "weather-report-panel";
    panel.innerHTML = `
      <div class="wrp-header" data-wrp-drag>
        <div class="wrp-drag-grip" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="wrp-header-text">
          <h3 class="wrp-title">Weather Report</h3>
          <p class="wrp-subtitle">Enable a temporal layer to begin</p>
          <p class="wrp-threshold" hidden>
            <span class="wrp-threshold-label">Alert threshold:</span>
            <span class="wrp-threshold-value"></span>
          </p>
        </div>
        <div class="wrp-header-actions">
          <button class="wrp-export-btn" type="button"
                  id="wrpExportDocBtn"
                  title="Download as Word (.doc)"
                  aria-label="Download as Word" disabled>
            <i data-lucide="file-text"></i>
          </button>
          <button class="wrp-export-btn" type="button"
                  id="wrpExportPdfBtn"
                  title="Download as PDF"
                  aria-label="Download as PDF" disabled>
            <i data-lucide="file-down"></i>
          </button>
          <button class="wrp-close-btn" type="button" title="Close" aria-label="Close">
            <i data-lucide="x"></i>
          </button>
        </div>
      </div>
      <div class="wrp-tabs" role="tablist">
        <button class="wrp-tab is-active" type="button" role="tab"
                data-tab="dynamic" aria-selected="true">Dynamic Report</button>
        <button class="wrp-tab" type="button" role="tab"
                data-tab="pmd" aria-selected="false">PMD Overview</button>
      </div>
      <div class="wrp-body" id="weatherReportBody" data-tab-content="dynamic"></div>
      <div class="wrp-body wrp-body--pmd" id="weatherReportPmdBody"
           data-tab-content="pmd" hidden></div>
      <div class="wrp-footer" id="weatherReportFooter"></div>
      <div class="wrp-resize" data-wrp-resize aria-label="Resize">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M14 6 L6 14 M14 10 L10 14"
                stroke="currentColor" stroke-width="1.6"
                fill="none" stroke-linecap="round"></path>
        </svg>
      </div>
    `;
    mapContainer.appendChild(panel);
    this.#panelEl = panel;
    this.#contentEl = panel.querySelector("#weatherReportBody");
    this.#pmdContentEl = panel.querySelector("#weatherReportPmdBody");
    this.#tabsEl = panel.querySelector(".wrp-tabs");
    this.#footerEl = panel.querySelector("#weatherReportFooter");
    this.#titleEl = panel.querySelector(".wrp-title");
    this.#subtitleEl = panel.querySelector(".wrp-subtitle");
    this.#thresholdEl = panel.querySelector(".wrp-threshold");
    this.#thresholdValueEl = panel.querySelector(".wrp-threshold-value");
    this.#wrpExportDocBtn = panel.querySelector("#wrpExportDocBtn");
    this.#wrpExportPdfBtn = panel.querySelector("#wrpExportPdfBtn");

    // Wire the two Dynamic-Report export buttons.  Handlers are no-ops
    // when there's no report snapshot yet (buttons are also disabled in
    // that state via the `disabled` attribute set at render time).
    // The runExport() wrapper below shows a spinner overlay while the
    // report HTML is being built + streamed to Blob/window, and surfaces
    // any thrown error in the same overlay instead of silently failing.
    this.#wrpExportDocBtn?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (this.#wrpExportDocBtn.disabled) return;
      this.#runExport("Word", () => this.#downloadReportAsWord());
    });
    this.#wrpExportPdfBtn?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (this.#wrpExportPdfBtn.disabled) return;
      this.#runExport("PDF", () => this.#downloadReportAsPdf());
    });

    // Tab click delegation — single listener on the strip, dispatches
    // on the clicked <button>'s data-tab.
    this.#tabsEl.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-tab]");
      if (!btn) return;
      this.#switchTab(btn.getAttribute("data-tab"));
    });

    // Lucide icons get rendered by the global init pass; nudge it in case
    // we're mounted after the initial pass.
    if (window.lucide?.createIcons) window.lucide.createIcons();

    // Drag + resize — mirrors the heatwave modal pattern (see
    // layer-attribute-popup.js attachHeatwaveDragAndResize).  Pointer-
    // event based (single-touch friendly), converts CSS-driven
    // positioning to pixel-anchored inline styles on first interaction
    // so subsequent moves stay sticky and the rail's anchoring rule
    // stops fighting our updates.  Zero listeners fire while the panel
    // is idle — pointerdown adds pointermove/up then removes them on
    // release, so there's no rAF loop or observer running in the
    // background.
    this.#attachDragAndResize(panel);

    // ONE delegated handler for the entire body — survives every render
    // (innerHTML changes don't drop listeners on the parent).  Reads
    // `data-fly-bbox` off the closest ancestor and flies the map to
    // that bbox.  No per-card listeners → zero per-render setup cost.
    const flyHandler = (ev) => {
      // Keyboard activation: only fire on Enter/Space, never block other keys.
      if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") {
        return;
      }
      const target = ev.target.closest("[data-fly-bbox]");
      if (!target) return;
      const raw = target.getAttribute("data-fly-bbox");
      if (!raw) return;
      const [w, s, e, n] = raw.split(",").map(Number);
      if (![w, s, e, n].every(Number.isFinite)) return;
      ev.preventDefault();
      try {
        this.#map.fitBounds(
          [
            [w, s],
            [e, n],
          ],
          { padding: 60, duration: 900, maxZoom: 10 }
        );
      } catch (err) {
        console.warn("[WeatherReport] fitBounds failed:", err);
      }
    };
    this.#contentEl.addEventListener("click", flyHandler);
    this.#contentEl.addEventListener("keydown", flyHandler);

    // Auto-refresh of the PMD-tab "Active Layers" block on any layer
    // toggle or tracked-source hydration.  Both are cheap (early-return
    // when the PMD tab isn't visible), and the refresh itself is
    // throttled + fingerprinted, so a rapid tempo of source events
    // collapses into a single DOM write.
    this.#map.on("styledata", () => this.#scheduleActiveLayersRefresh());
    this.#map.on("sourcedata", (e) => {
      if (!e || !e.sourceId) return;
      // Only bounce the refresh for sources we actually surface.
      for (const cfg of Object.values(PMD_TAB_TRACKED_LAYERS)) {
        if (cfg.sourceId === e.sourceId) {
          this.#scheduleActiveLayersRefresh();
          return;
        }
      }
    });

    // Ticking a checkbox on the sidebar's PMD Weather Warnings
    // pre-filter narrows the feature set the report shows for the
    // pmd_warnings section.  Re-render both the Active Layers block
    // and the full PMD Overview tab so hotspot / meaning / mitigation
    // strings recompute against the filtered subset.
    window.addEventListener("pmd-warnings-filter-changed", () => {
      this.#scheduleActiveLayersRefresh();
      this.#scheduleRender();
    });
  }

  #wireToggle() {
    if (!this.#btnEl || !this.#panelEl) return;

    this.#btnEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = !this.#panelEl.classList.contains("visible");
      this.#panelEl.classList.toggle("visible", willOpen);
      this.#btnEl.classList.toggle("active-weather-report", willOpen);
      if (willOpen) {
        this.#attachListeners();
        this.#scheduleRender();
      } else {
        this.#detachListeners();
      }
    });

    const closeBtn = this.#panelEl.querySelector(".wrp-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.#panelEl.classList.remove("visible");
        this.#btnEl.classList.remove("active-weather-report");
        this.#detachListeners();
      });
    }
  }

  // -------------------------------------------------------------- reactivity
  // Listeners attach lazily on panel open and detach on close so we
  // don't pay any cost for slider drags / map idles / DOM mutations
  // while the user is doing something else.  This was the dominant
  // source of lag before — multi-Hz mutation events were waking up the
  // throttle even when the panel was hidden.
  #attachListeners() {
    if (this.#listenersAttached) return;
    this.#listenersAttached = true;
    // Force the next render to do real work even if state hasn't
    // technically changed since the last time the panel was open.
    this.#lastFingerprint = "";
    this.#lastRenderComplete = false;

    // Slider input → step changes. Throttled via #scheduleRender so
    // dragging at 60Hz collapses to ~6 renders/sec.
    this.#boundOnSliderInput = () => this.#scheduleRender();
    const slider = document.getElementById("slider1");
    if (slider) slider.addEventListener("input", this.#boundOnSliderInput);

    // Narrow MutationObserver — was previously watching subtree +
    // characterData which fired ~60Hz during slider play (every label /
    // active-step class change).  We only actually need to know when
    // the slider element's style attribute flips display:none↔block
    // (layer activation) or its class changes — both are on
    // #temp-slider1 itself, no subtree needed.
    const tempSlider = document.getElementById("temp-slider1");
    if (tempSlider) {
      this.#boundOnTemporalDom = () => this.#scheduleRender();
      this.#observer = new MutationObserver(this.#boundOnTemporalDom);
      this.#observer.observe(tempSlider, {
        attributes: true,
        attributeFilter: ["style", "class"],
        childList: false,
        subtree: false,
        characterData: false,
      });
    }

    // Pan / zoom changes the visible districts.
    this.#boundOnMapMove = () => this.#scheduleRender();
    this.#map.on("moveend", this.#boundOnMapMove);

    // `idle` fires when tiles/animations settle — flips the loading
    // spinner state once data lands.  Throttle prevents it from over-
    // rendering during normal map operation.
    this.#boundOnMapIdle = () => this.#scheduleRender();
    this.#map.on("idle", this.#boundOnMapIdle);
  }

  #detachListeners() {
    if (!this.#listenersAttached) return;
    this.#listenersAttached = false;

    if (this.#renderTimerId != null) {
      clearTimeout(this.#renderTimerId);
      this.#renderTimerId = null;
    }

    const slider = document.getElementById("slider1");
    if (slider && this.#boundOnSliderInput) {
      slider.removeEventListener("input", this.#boundOnSliderInput);
    }
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
    if (this.#boundOnMapMove) {
      this.#map.off("moveend", this.#boundOnMapMove);
    }
    if (this.#boundOnMapIdle) {
      this.#map.off("idle", this.#boundOnMapIdle);
    }
    this.#boundOnSliderInput = null;
    this.#boundOnTemporalDom = null;
    this.#boundOnMapMove = null;
    this.#boundOnMapIdle = null;
  }

  #isOpen() {
    return this.#panelEl?.classList.contains("visible") === true;
  }

  // Time-based throttle: guarantee at least 150ms between renders.
  // Multiple calls inside the window collapse into a single trailing
  // render when the window expires.  This was previously rAF-only,
  // which means each frame of slider drag (60Hz) triggered a fresh
  // render — way too much for the heavy queryRenderedFeatures /
  // per-district sampling work the report does.
  #scheduleRender() {
    if (!this.#isOpen()) return;
    if (this.#renderTimerId != null) return; // already queued

    const RENDER_MIN_INTERVAL_MS = 150;
    const wait = Math.max(
      0,
      RENDER_MIN_INTERVAL_MS - (performance.now() - this.#lastRenderAt)
    );

    this.#renderTimerId = setTimeout(() => {
      this.#renderTimerId = null;
      if (!this.#isOpen()) return;
      this.#lastRenderAt = performance.now();
      try {
        this.#renderReport();
      } catch (e) {
        console.warn("[WeatherReport] render failed:", e);
      }
    }, wait);
  }

  // -------------------------------------------------------------- engine
  // Cheap fingerprint of every input that affects the rendered report.
  // If unchanged from the last render, we skip the heavy district +
  // per-feature sampling work entirely — this is the hottest cost path
  // when the panel is open (queryRenderedFeatures is called once per
  // district in the worst case).  A pan that doesn't actually change
  // which districts are visible (e.g. scrolling within the same admin
  // unit) results in a no-op render even though `moveend` fires.
  #computeFingerprint(state, activeStations) {
    const b = this.#map.getBounds?.();
    const zoom = this.#map.getZoom?.();
    // Round bounds so micro-pans don't change the fingerprint.
    const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "");
    const bbox = b
      ? `${fmt(b.getWest())},${fmt(b.getSouth())},${fmt(b.getEast())},${fmt(b.getNorth())}`
      : "";
    return [
      state.layerKey || "",
      state.currentIndex || 0,
      state.date || "",
      activeStations.join("|"),
      bbox,
      typeof zoom === "number" ? zoom.toFixed(2) : "",
    ].join("§");
  }

  #renderReport() {
    const state = window.getCurrentTemporalState
      ? window.getCurrentTemporalState()
      : { layerKey: null, currentEntry: null, date: "", currentIndex: 0 };

    const layerKey = state.layerKey;
    const tempMeta = layerKey ? LAYER_KIND_MAP[layerKey] : null;
    const activeStations = this.#activeStationKeys();
    const fallbackStationKey = activeStations[0] || null;
    const fallbackStationMeta = fallbackStationKey
      ? STATION_KIND_MAP[fallbackStationKey]
      : null;

    // Skip redundant work: if every input is identical AND the last
    // render produced a real report (not loading / empty), bail.
    const fp = this.#computeFingerprint(state, activeStations);
    if (fp === this.#lastFingerprint && this.#lastRenderComplete) return;
    this.#lastFingerprint = fp;
    this.#lastRenderComplete = false; // flipped to true at the end of a successful row render

    this.#titleEl.textContent = "Weather Report";

    // ----- No data sources at all ---------------------------------------
    if (!tempMeta && !fallbackStationMeta) {
      this.#clearThreshold();
      this.#subtitleEl.textContent =
        "Enable any temporal weather or station layer to generate a report.";
      this.#renderEmpty(
        "No active layer",
        "Toggle a Meteoblue temporal layer or a station layer (WAQI, PMD Weather Stations, Heatwave Monitoring) to populate the report."
      );
      return;
    }

    // Active raster temporal can't be sampled per-district — but if a
    // station is also visible, fall through to station-only mode rather
    // than dead-end.  Without a station, surface the raster-only message.
    if (tempMeta && tempMeta.kind === "raster" && !fallbackStationMeta) {
      this.#applyThreshold(tempMeta);
      this.#subtitleEl.textContent = `${tempMeta.label} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        `${tempMeta.label} is raster-only`,
        "Per-district readings are not available for radar tiles. Switch to a vector temporal layer or enable a station layer (WAQI / PMD / Heatwave) to see district aggregations."
      );
      return;
    }

    // ----- Boundary layer gating ----------------------------------------
    const districtVisible = this.#anyLayerVisible(DISTRICT_LAYER_IDS);
    const provinceVisible = this.#anyLayerVisible(PROVINCE_LAYER_IDS);
    if (!districtVisible || !provinceVisible) {
      const lbl = tempMeta?.label || fallbackStationMeta?.label || "";
      this.#subtitleEl.textContent = `${lbl} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "Boundaries required",
        "Enable both <b>District Boundary</b> and <b>Provincial Boundary</b> in the sidebar to generate the per-district report."
      );
      return;
    }

    // ----- Determine the *primary* sampling mode ------------------------
    // Active vector temporal wins; otherwise the highest-priority visible
    // station drives the report.  Either way the same district loop below
    // runs and ends up writing into the same `rows` shape.
    const isTemporalPrimary =
      !!tempMeta && tempMeta.kind !== "raster";
    const primaryMeta = isTemporalPrimary ? tempMeta : fallbackStationMeta;
    const primarySubtitleLabel = primaryMeta?.label || "";
    // Show the alert threshold for the chosen primary so the user can
    // see at a glance what bar a card has to clear to flip into red.
    this.#applyThreshold(primaryMeta);

    // For temporal mode, resolve frame layer IDs and verify sources are loaded.
    let targetLayerIds = [];
    if (isTemporalPrimary) {
      const frame = state.currentEntry;
      targetLayerIds = (frame?.layers || [])
        .map((l) => l.id)
        .filter((id) => this.#map.getLayer(id))
        .filter((id) => {
          const lyr = this.#map.getLayer(id);
          if (!lyr) return false;
          if (lyr.type === "raster") return false;
          const sl = lyr["source-layer"] || lyr.sourceLayer;
          return (
            tempMeta.sourceLayers.length === 0 ||
            tempMeta.sourceLayers.includes(sl)
          );
        });

      if (!targetLayerIds.length) {
        this.#subtitleEl.textContent = `${primarySubtitleLabel} · ${state.date || "Current step"}`;
        this.#renderLoading();
        return;
      }

      const frameSourceIds = this.#frameSourceIds(frame);
      if (
        frameSourceIds.length &&
        !frameSourceIds.every((id) => this.#sourceIsLoaded(id))
      ) {
        this.#subtitleEl.textContent = `${primarySubtitleLabel} · ${state.date || "Current step"}`;
        this.#renderLoading();
        return;
      }
    } else {
      // Station-only mode: gate on the chosen station's source being loaded.
      const stationLayerIds = fallbackStationMeta.layerIds.filter((id) =>
        this.#map.getLayer(id)
      );
      if (!stationLayerIds.length) {
        this.#subtitleEl.textContent = `${primarySubtitleLabel}`;
        this.#renderLoading();
        return;
      }
      // GeoJSON sources load fast but can be in flight on first paint.
      const sourceIds = stationLayerIds
        .map((id) => this.#map.getLayer(id)?.source)
        .filter(Boolean);
      if (
        sourceIds.length &&
        !sourceIds.every((sid) => this.#sourceIsLoaded(sid))
      ) {
        this.#subtitleEl.textContent = `${primarySubtitleLabel}`;
        this.#renderLoading();
        return;
      }
    }

    // ----- Query districts in viewport ----------------------------------
    // Query only the FILL layer — outline shares the same source so the
    // outline query would just return duplicate features which we'd then
    // dedupe.  One query, half the work.
    const districtQueryLayers = DISTRICT_LAYER_IDS.filter((id) =>
      this.#map.getLayer(id)
    ).slice(0, 1); // prefer the fill layer (first in the constant)
    const districtFeatures = this.#dedupedFeaturesByName(
      this.#map.queryRenderedFeatures({ layers: districtQueryLayers }),
      DISTRICT_NAME_KEYS
    );

    if (!districtFeatures.length) {
      this.#subtitleEl.textContent = `${primarySubtitleLabel} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "No districts in view",
        "Pan or zoom so district polygons are visible, then the report will populate."
      );
      return;
    }

    // Province features are only needed as a *fallback* when a district
    // feature lacks a province name property of its own.  Use the
    // district-only key list — `PROVINCE_NAME_KEYS` would falsely
    // match every district's own `name` and skip the fallback query
    // when we actually need it.
    const sampleHasProvince = districtFeatures.some((d) =>
      this.#firstProp(d, DISTRICT_PROVINCE_PROP_KEYS)
    );
    const provinceFeatures = sampleHasProvince
      ? []
      : this.#dedupedFeaturesByName(
          this.#map.queryRenderedFeatures({
            layers: PROVINCE_LAYER_IDS.filter((id) => this.#map.getLayer(id)).slice(0, 1),
          }),
          PROVINCE_NAME_KEYS
        );

    // Pre-build station feature pools once (cheap viewport queries).
    // Each entry: { metaKey, meta, features[] } — features are picked
    // up by the per-district loop via bbox containment.
    const stationPools = activeStations.map((stKey) => {
      const stMeta = STATION_KIND_MAP[stKey];
      const visibleIds = stMeta.layerIds.filter((id) => this.#map.getLayer(id));
      const features = visibleIds.length
        ? this.#map.queryRenderedFeatures({ layers: visibleIds })
        : [];
      return { metaKey: stKey, meta: stMeta, features };
    });

    // ----- Sample each district -----------------------------------------
    const rows = [];
    for (const district of districtFeatures) {
      const districtName = this.#firstProp(district, DISTRICT_NAME_KEYS);
      if (!districtName) continue;

      const center = this.#featureCenter(district);
      if (!center) continue;

      const provinceName =
        // Use the *district-feature* province key list (excludes generic
        // 'name'/'NAME' which would match the district's own name).
        this.#firstProp(district, DISTRICT_PROVINCE_PROP_KEYS) ||
        this.#provinceForCenter(center, provinceFeatures) ||
        "Unknown";

      // Primary reading (temporal sample, or station aggregation if no temporal).
      let primaryReading = null;
      if (isTemporalPrimary) {
        const sampled = this.#sampleAt(center, targetLayerIds);
        primaryReading = this.#aggregateReading(sampled, tempMeta.kind, tempMeta);
      } else {
        // Station-as-primary: collect station features whose point lies
        // inside the district bbox, aggregate via the station's valueProp.
        const inside = this.#stationsInDistrict(district, fallbackStationMeta, [
          {
            metaKey: fallbackStationKey,
            meta: fallbackStationMeta,
            features: stationPools.find(
              (p) => p.metaKey === fallbackStationKey
            )?.features || [],
          },
        ]);
        if (inside.length) {
          primaryReading = this.#aggregateReading(
            inside,
            fallbackStationMeta.kind,
            fallbackStationMeta,
            { valueProp: fallbackStationMeta.valueProp }
          );
        }
      }

      // Extras: every OTHER active station that has features inside this
      // district contributes a tag-style reading.  Skip the primary
      // station to avoid duplicate readings when in station-only mode.
      const extras = [];
      for (const pool of stationPools) {
        if (!isTemporalPrimary && pool.metaKey === fallbackStationKey) continue;
        const inside = this.#stationsInDistrict(district, pool.meta, [pool]);
        if (!inside.length) continue;
        const r = this.#aggregateReading(
          inside,
          pool.meta.kind,
          pool.meta,
          { valueProp: pool.meta.valueProp }
        );
        if (r) extras.push({ source: pool.meta.label, ...r });
      }

      if (!primaryReading && !extras.length) continue;

      // Cache the district's bbox here so the per-card click handler can
      // fly to it without re-querying the source feature on click.
      const bbox = this.#featureBbox(district);

      rows.push({
        district: districtName,
        province: provinceName,
        bbox,
        // If the primary slot is empty (no temporal sample, no station-as-primary
        // hit, but a secondary station got a reading), promote the first extra.
        reading: primaryReading || extras.shift(),
        extras,
      });
    }

    if (!rows.length) {
      this.#subtitleEl.textContent = `${primarySubtitleLabel} · ${state.date || "Current step"}`;
      this.#renderEmpty(
        "No signals at current step",
        "The active layer has no readings over the visible districts. Try a different time step or pan to a region with coverage."
      );
      return;
    }

    // Sort by score (severity / magnitude) descending — hotspots first.
    rows.sort((a, b) => b.reading.score - a.reading.score);

    // ----- Render -------------------------------------------------------
    const dateSuffix = isTemporalPrimary && state.date ? ` · ${state.date}` : "";
    this.#subtitleEl.textContent = `${primarySubtitleLabel}${dateSuffix} · ${rows.length} district${rows.length === 1 ? "" : "s"}`;
    this.#renderRows(rows, primaryMeta);
    this.#lastRenderComplete = true;

    // Snapshot for the Word / PDF export buttons.  References only —
    // rows and meta live on the render frame; storing the pointer is
    // O(1) memory.  Downloads read directly from this snapshot at
    // click time, no re-query into the map.
    this.#lastReport = {
      rows,
      meta: primaryMeta,
      state,
      generatedAt: new Date(),
    };
    this.#setExportEnabled(true);
  }

  // Public, pure-computation sibling of #renderReport() — samples the
  // per-district temporal reading for an ARBITRARY frame (e.g. a
  // different day of the same layer's forecast) instead of "whatever the
  // slider currently says". #renderReport() is completely untouched and
  // keeps reading window.getCurrentTemporalState() for "now" exactly as
  // before; this method exists purely so the story panel's Dynamic
  // Weather Report mode can preview other days without moving the
  // slider. No DOM is written here — station fallback/extras are
  // intentionally out of scope (stations are live point observations,
  // not a multi-day forecast, so they don't fit a day-by-day story).
  //
  // Returns:
  //   { rows, meta }  — rows sorted by score desc, same shape as #lastReport.rows
  //   "loading"       — this frame's tiles/sources aren't ready yet
  //   null            — nothing to show (no layer, raster-only, boundaries
  //                     hidden, no districts in view, or no signal)
  getDistrictReportForFrame(frame, layerKey) {
    const tempMeta = layerKey ? LAYER_KIND_MAP[layerKey] : null;
    if (!tempMeta || tempMeta.kind === "raster") return null;

    if (!this.#anyLayerVisible(DISTRICT_LAYER_IDS) || !this.#anyLayerVisible(PROVINCE_LAYER_IDS)) {
      return null;
    }

    const targetLayerIds = (frame?.layers || [])
      .map((l) => l.id)
      .filter((id) => this.#map.getLayer(id))
      .filter((id) => {
        const lyr = this.#map.getLayer(id);
        if (!lyr) return false;
        if (lyr.type === "raster") return false;
        const sl = lyr["source-layer"] || lyr.sourceLayer;
        return tempMeta.sourceLayers.length === 0 || tempMeta.sourceLayers.includes(sl);
      });
    if (!targetLayerIds.length) return null;

    const frameSourceIds = this.#frameSourceIds(frame);
    if (frameSourceIds.length && !frameSourceIds.every((id) => this.#sourceIsLoaded(id))) {
      return "loading";
    }

    const districtQueryLayers = DISTRICT_LAYER_IDS.filter((id) => this.#map.getLayer(id)).slice(0, 1);
    const districtFeatures = this.#dedupedFeaturesByName(
      this.#map.queryRenderedFeatures({ layers: districtQueryLayers }),
      DISTRICT_NAME_KEYS
    );
    if (!districtFeatures.length) return null;

    const sampleHasProvince = districtFeatures.some((d) => this.#firstProp(d, DISTRICT_PROVINCE_PROP_KEYS));
    const provinceFeatures = sampleHasProvince
      ? []
      : this.#dedupedFeaturesByName(
          this.#map.queryRenderedFeatures({
            layers: PROVINCE_LAYER_IDS.filter((id) => this.#map.getLayer(id)).slice(0, 1),
          }),
          PROVINCE_NAME_KEYS
        );

    const rows = [];
    for (const district of districtFeatures) {
      const districtName = this.#firstProp(district, DISTRICT_NAME_KEYS);
      if (!districtName) continue;
      const center = this.#featureCenter(district);
      if (!center) continue;
      const provinceName =
        this.#firstProp(district, DISTRICT_PROVINCE_PROP_KEYS) ||
        this.#provinceForCenter(center, provinceFeatures) ||
        "Unknown";
      const sampled = this.#sampleAt(center, targetLayerIds);
      const reading = this.#aggregateReading(sampled, tempMeta.kind, tempMeta);
      if (!reading) continue;
      rows.push({
        district: districtName,
        province: provinceName,
        bbox: this.#featureBbox(district),
        reading,
        extras: [],
      });
    }
    if (!rows.length) return null;
    rows.sort((a, b) => b.reading.score - a.reading.score);
    return { rows, meta: tempMeta };
  }

  // -------------------------------------------------------------- station helpers
  // Which station layers are toggled on AND visible right now?  Returns
  // the keys in priority order (WAQI → PMD → Heatwave) — the first one
  // becomes the fallback when no temporal is active.
  #activeStationKeys() {
    const keys = [];
    for (const key of Object.keys(STATION_KIND_MAP)) {
      const meta = STATION_KIND_MAP[key];
      if (this.#anyLayerVisible(meta.layerIds)) keys.push(key);
    }
    return keys;
  }

  // Filter a pool of station features down to those whose centroid lies
  // inside the district's bbox.  bbox-only PIP is cheap and accurate
  // enough for non-overlapping district polygons.
  #stationsInDistrict(district, _stationMeta, pools) {
    const bbox = this.#featureBbox(district);
    if (!bbox) return [];
    const [minX, minY, maxX, maxY] = bbox;
    const out = [];
    for (const pool of pools || []) {
      for (const f of pool.features || []) {
        const geom = f?.geometry;
        if (!geom) continue;
        // Stations are point geometries — fast path.
        if (geom.type === "Point") {
          const [x, y] = geom.coordinates;
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(f);
          continue;
        }
        // Fallback for non-point: use centroid of feature bbox.
        const c = this.#featureCenter(f);
        if (!c) continue;
        if (c[0] >= minX && c[0] <= maxX && c[1] >= minY && c[1] <= maxY) {
          out.push(f);
        }
      }
    }
    return out;
  }

  // Renders a human-readable description of when this kind/cadence
   // triggers an alert.  Used to populate the "Alert threshold: ..." line
   // at the top of the panel so users know exactly what bar each card has
   // to clear to flip into the red-alert state.
  #thresholdDescription(meta) {
    if (!meta) return "";
    const cadence = meta.cadence || "hourly";
    switch (meta.kind) {
      case "precipitation":
        return cadence === "hourly"
          ? `≥ ${T.RAIN_HOURLY_HEAVY} mm/h rain (or ≥ ${T.SNOW_HOURLY_HEAVY} mm snow)`
          : cadence === "weekly"
            ? `≥ ${T.RAIN_WEEKLY_HEAVY} mm rain (weekly)`
            : `≥ ${T.RAIN_DAILY_HEAVY} mm rain (or ≥ ${T.SNOW_DAILY_HEAVY} mm snow, daily)`;
      case "snowfall":
        return cadence === "hourly"
          ? `≥ ${T.SNOW_HOURLY_HEAVY} mm/h snow`
          : `≥ ${T.SNOW_DAILY_HEAVY} mm snow (daily)`;
      case "cape":
        return `≥ ${T.CAPE_ALERT} J/kg (severe instability)`;
      case "storm_helicity":
        return `≥ ${T.HELICITY_ALERT} J/kg (tornadic potential)`;
      case "temperature":
        return `≥ ${T.TEMP_HOT} °C or ≤ ${T.TEMP_COLD} °C`;
      case "aqi":
        return `AQI ≥ ${T.AQI_USG} (Unhealthy for Sensitive Groups)`;
      case "desert_dust":
        return `≥ ${T.DUST_ALERT} µg/m³ (heavy dust event)`;
      case "aod":
        return `≥ ${T.AOD_ALERT} (heavy aerosol loading)`;
      case "no2":
        return `≥ ${T.NO2_ALERT} µg/m³ NO₂ (WHO 24h alert)`;
      case "co":
        return `≥ ${(T.CO_ALERT / 1000).toFixed(0)} mg/m³ CO (EPA 8h alert)`;
      case "so2":
        return `≥ ${T.SO2_ALERT} µg/m³ SO₂ (WHO 24h alert)`;
      case "rainfall_station":
        return `≥ ${T.RAIN_STATION_ALERT} mm at any station`;
      case "temperature_station":
        return `≥ ${T.STATION_TEMP_HOT} °C at any station (heat advisory)`;
      case "raster":
        return "raster-only (no per-district threshold)";
      default:
        return "";
    }
  }

  #applyThreshold(meta) {
    if (!this.#thresholdEl || !this.#thresholdValueEl) return;
    const text = this.#thresholdDescription(meta);
    if (!text) {
      this.#thresholdEl.hidden = true;
      this.#thresholdValueEl.textContent = "";
      return;
    }
    this.#thresholdValueEl.textContent = text;
    this.#thresholdEl.hidden = false;
  }

  #clearThreshold() {
    if (!this.#thresholdEl) return;
    this.#thresholdEl.hidden = true;
    if (this.#thresholdValueEl) this.#thresholdValueEl.textContent = "";
  }

  #featureBbox(feature) {
    const geom = feature?.geometry;
    if (!geom) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
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
    try {
      visit(geom.coordinates);
    } catch {
      return null;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    return [minX, minY, maxX, maxY];
  }

  // -------------------------------------------------------------- helpers
  #anyLayerVisible(ids) {
    for (const id of ids) {
      if (!this.#map.getLayer(id)) continue;
      const vis = this.#map.getLayoutProperty(id, "visibility");
      if (vis !== "none") return true;
    }
    return false;
  }

  #firstProp(feature, keys) {
    const p = feature?.properties || {};
    for (const k of keys) {
      const v = p[k];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  }

  #dedupedFeaturesByName(features, nameKeys) {
    const seen = new Set();
    const out = [];
    for (const f of features || []) {
      const name = this.#firstProp(f, nameKeys);
      if (!name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(f);
    }
    return out;
  }

  // Cheap centroid via bbox midpoint — exact polygon centroid would need
  // turf.centroid; bbox midpoint is good enough for sampling vector tiles.
  #featureCenter(feature) {
    const geom = feature?.geometry;
    if (!geom) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
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
    try {
      visit(geom.coordinates);
    } catch {
      return null;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
    return [(minX + maxX) / 2, (minY + maxY) / 2];
  }

  #provinceForCenter(center, provinceFeatures) {
    // bbox-only fallback (cheap, no turf dependency). Returns the first
    // province whose bbox contains `center` — accurate enough since
    // Pakistan provinces don't bbox-overlap meaningfully at this scale.
    for (const f of provinceFeatures) {
      const c = this.#featureCenter(f);
      if (!c) continue;
      const geom = f.geometry;
      if (!geom) continue;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      const visit = (coords) => {
        if (typeof coords[0] === "number") {
          const [x, y] = coords;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          return;
        }
        for (const cc of coords) visit(cc);
      };
      try {
        visit(geom.coordinates);
      } catch {
        continue;
      }
      const [cx, cy] = center;
      if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) {
        return this.#firstProp(f, PROVINCE_NAME_KEYS);
      }
    }
    return null;
  }

  #sampleAt(lngLat, layerIds) {
    if (!layerIds.length) return [];
    try {
      const point = this.#map.project(lngLat);
      return this.#map.queryRenderedFeatures(point, { layers: layerIds });
    } catch {
      return [];
    }
  }

  // Aggregate a list of features down to one reading with kind-specific
  // labelling + alert flag.  Thresholds live in the `T` constant block at
  // the top of the file so the rules are auditable in one place.  `meta`
  // is the LAYER_KIND_MAP / STATION_KIND_MAP entry — its `cadence` field
  // (hourly vs daily vs weekly) lets us pick the right rainfall threshold
  // tier from the same shared set.
  #aggregateReading(features, kind, meta = {}, opts = {}) {
    if (!features.length) return null;
    const valueProp = opts.valueProp || "minValue";
    let best = -Infinity;
    let bestSourceLayer = "";
    for (const f of features) {
      const v = Number(f?.properties?.[valueProp]);
      if (!Number.isFinite(v)) continue;
      if (v > best) {
        best = v;
        bestSourceLayer = f.layer?.["source-layer"] || f.sourceLayer || "";
      }
    }
    if (!Number.isFinite(best)) return null;

    const cadence = meta.cadence || opts.cadence || "hourly";
    let label = "";
    let unit = "";
    let alert = false;
    let score = Math.abs(best);

    switch (kind) {
      case "precipitation": {
        unit = "mm";
        const isSnow =
          bestSourceLayer === "snow" || bestSourceLayer === "layerSnow";
        if (isSnow) {
          label = `Snow ${best.toFixed(1)} ${unit}`;
          alert =
            cadence === "hourly"
              ? best >= T.SNOW_HOURLY_HEAVY
              : best >= T.SNOW_DAILY_HEAVY;
        } else {
          label = `Rain ${best.toFixed(1)} ${unit}`;
          // Tier the rain alert by cadence so an hourly burst and a
          // weekly accumulation aren't held to the same number.
          alert =
            cadence === "hourly"
              ? best >= T.RAIN_HOURLY_HEAVY
              : cadence === "weekly"
                ? best >= T.RAIN_WEEKLY_HEAVY
                : best >= T.RAIN_DAILY_HEAVY;
        }
        score = best;
        break;
      }
      case "snowfall":
        unit = "mm";
        label = `Snow ${best.toFixed(1)} ${unit}`;
        alert =
          cadence === "hourly"
            ? best >= T.SNOW_HOURLY_HEAVY
            : best >= T.SNOW_DAILY_HEAVY;
        score = best;
        break;
      case "cape":
        unit = "J/kg";
        label = `CAPE ${best.toFixed(0)} ${unit}`;
        alert = best >= T.CAPE_ALERT;
        score = best;
        break;
      case "storm_helicity":
        unit = "J/kg";
        label = `Helicity ${best.toFixed(0)} ${unit}`;
        alert = best >= T.HELICITY_ALERT;
        score = best;
        break;
      case "temperature":
        unit = "°C";
        label = `Temp ${best >= 0 ? "+" : ""}${best.toFixed(1)} ${unit}`;
        alert = best >= T.TEMP_HOT || best <= T.TEMP_COLD;
        score = Math.abs(best);
        break;
      // ---- Air-quality kinds ----------------------------------------
      case "aqi":
        unit = "AQI";
        label = `AQI ${best.toFixed(0)}`;
        alert = best >= T.AQI_USG;
        score = best;
        break;
      case "desert_dust":
        unit = "µg/m³";
        label = `Dust ${best.toFixed(0)} ${unit}`;
        alert = best >= T.DUST_ALERT;
        score = best;
        break;
      case "aod":
        unit = "";
        label = `AOD ${best.toFixed(2)}`;
        alert = best >= T.AOD_ALERT;
        score = best;
        break;
      case "no2":
        unit = "µg/m³";
        label = `NO₂ ${best.toFixed(0)} ${unit}`;
        alert = best >= T.NO2_ALERT;
        score = best;
        break;
      case "co":
        unit = "µg/m³";
        label = `CO ${best.toFixed(0)} ${unit}`;
        alert = best >= T.CO_ALERT;
        score = best;
        break;
      case "so2":
        unit = "µg/m³";
        label = `SO₂ ${best.toFixed(0)} ${unit}`;
        alert = best >= T.SO2_ALERT;
        score = best;
        break;
      // ---- Station-only kinds ---------------------------------------
      case "rainfall_station":
        unit = "mm";
        label = `Rain ${best.toFixed(1)} ${unit}`;
        alert = best >= T.RAIN_STATION_ALERT;
        score = best;
        break;
      case "temperature_station":
        // Tighter threshold than the `temperature` (forecast) kind —
        // station readings are point measurements with higher accuracy
        // and Pakistan heat-warning protocols flag at ≥ 40 °C.
        unit = "°C";
        label = `Temp ${best >= 0 ? "+" : ""}${best.toFixed(1)} ${unit}`;
        alert = best >= T.STATION_TEMP_HOT || best <= T.TEMP_COLD;
        score = Math.abs(best);
        break;
      default:
        label = `${best.toFixed(1)}`;
        alert = false;
    }
    return { value: best, label, alert, score, unit };
  }

  // -------------------------------------------------------------- HTML out
  #renderEmpty(title, body) {
    this.#contentEl.innerHTML = `
      <div class="wrp-empty">
        <h4>${escapeHtml(title)}</h4>
        <p>${body}</p>
      </div>
    `;
    // Empty state has no report → clear footer + disable exports so the
    // header buttons match the actual availability of data.
    if (this.#footerEl) {
      this.#footerEl.innerHTML = "";
      this.#footerEl.classList.remove("is-visible");
    }
    this.#setExportEnabled(false);
    this.#lastReport = null;
  }

  // Spinner state — shown while the active frame's tiles are still
  // fetching.  The `idle` map listener kicks a re-render the moment
  // loading settles, so the spinner clears itself.
  #renderLoading() {
    this.#contentEl.innerHTML = `
      <div class="wrp-loading" role="status" aria-live="polite">
        <div class="wrp-loader" aria-hidden="true"></div>
        <div class="wrp-loading-text">Fetching results…</div>
      </div>
    `;
    if (this.#footerEl) {
      this.#footerEl.innerHTML = "";
      this.#footerEl.classList.remove("is-visible");
    }
    // Loading state — keep whatever snapshot we already had (so a
    // brief re-fetch doesn't disable the buttons mid-review), but
    // don't advertise the exports as new-data ready.
    this.#setExportEnabled(!!this.#lastReport);
  }

  #setExportEnabled(enabled) {
    if (this.#wrpExportDocBtn) this.#wrpExportDocBtn.disabled = !enabled;
    if (this.#wrpExportPdfBtn) this.#wrpExportPdfBtn.disabled = !enabled;
  }

  // ---- Province aggregation -------------------------------------------
  // Reduce a province's per-district readings to a single representative
  // number + label.  Aggregation strategy is kind-aware:
  //   - cape, storm_helicity → MAX (worst-case is the headline number)
  //   - everything else      → MEAN (typical conditions in the province)
  // Returns { value, label, alert, title } or null if no readings.
  #provinceAggregate(rows, meta) {
    if (!rows || !rows.length || !meta) return null;
    const values = rows
      .map((r) => r.reading?.value)
      .filter((v) => Number.isFinite(v));
    if (!values.length) return null;

    const useMax = meta.kind === "cape" || meta.kind === "storm_helicity";
    const agg = useMax
      ? Math.max(...values)
      : values.reduce((a, b) => a + b, 0) / values.length;
    const prefix = useMax ? "Max" : "Avg";

    const fmt = this.#formatProvinceReading(meta.kind, agg, prefix);
    // Alert flag at province level uses the same threshold as a single
    // district reading — pass the aggregate value through aggregateReading
    // by pretending it's a single-feature query.
    const synth = [{ properties: { minValue: agg } }];
    const reading = this.#aggregateReading(synth, meta.kind, meta);
    const alert = reading?.alert === true;
    return {
      value: agg,
      label: fmt,
      alert,
      title: `${rows.length} district${rows.length === 1 ? "" : "s"} · ${prefix.toLowerCase()}`,
    };
  }

  #formatProvinceReading(kind, value, prefix) {
    switch (kind) {
      case "temperature":
      case "temperature_station":
        return `${prefix} ${value >= 0 ? "+" : ""}${value.toFixed(1)} °C`;
      case "precipitation":
        return `${prefix} ${value.toFixed(1)} mm`;
      case "snowfall":
        return `${prefix} ${value.toFixed(1)} mm`;
      case "rainfall_station":
        return `${prefix} ${value.toFixed(1)} mm`;
      case "cape":
        return `${prefix} ${value.toFixed(0)} J/kg`;
      case "storm_helicity":
        return `${prefix} ${value.toFixed(0)} J/kg`;
      case "aqi":
        return `${prefix} AQI ${value.toFixed(0)}`;
      case "desert_dust":
        return `${prefix} ${value.toFixed(0)} µg/m³`;
      case "aod":
        return `${prefix} AOD ${value.toFixed(2)}`;
      case "no2":
        return `${prefix} ${value.toFixed(0)} µg/m³`;
      case "co":
        return `${prefix} ${value.toFixed(0)} µg/m³`;
      case "so2":
        return `${prefix} ${value.toFixed(0)} µg/m³`;
      default:
        return `${prefix} ${value.toFixed(1)}`;
    }
  }

  // Union of multiple bbox tuples [w,s,e,n] — used to fit-bounds a
  // whole province from its constituent district bboxes.
  #unionBboxes(bboxes) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const b of bboxes || []) {
      if (!Array.isArray(b) || b.length !== 4) continue;
      if (!b.every(Number.isFinite)) continue;
      if (b[0] < minX) minX = b[0];
      if (b[1] < minY) minY = b[1];
      if (b[2] > maxX) maxX = b[2];
      if (b[3] > maxY) maxY = b[3];
    }
    if (!Number.isFinite(minX)) return null;
    return [minX, minY, maxX, maxY];
  }

  #frameSourceIds(frame) {
    if (!frame) return [];
    if (Array.isArray(frame.sources)) return frame.sources.map((s) => s.id);
    if (frame.source?.id) return [frame.source.id];
    return [];
  }

  #sourceIsLoaded(sourceId) {
    try {
      // `isSourceLoaded` throws if the source hasn't been added yet —
      // treat that as "not loaded" rather than letting it bubble.
      if (!this.#map.getSource(sourceId)) return false;
      return this.#map.isSourceLoaded(sourceId);
    } catch {
      return false;
    }
  }

  #renderRows(rows, meta) {
    const provinces = new Map();
    let alertCount = 0;
    for (const r of rows) {
      if (r.reading.alert) alertCount += 1;
      const list = provinces.get(r.province) || [];
      list.push(r);
      provinces.set(r.province, list);
    }

    const top = rows[0];
    const summaryHtml = `
      <div class="wrp-summary">
        <div class="wrp-stat">
          <strong>${rows.length}</strong>
          <span>Districts</span>
        </div>
        <div class="wrp-stat">
          <strong>${alertCount}</strong>
          <span>Alerts</span>
        </div>
      </div>
      ${
        top
          ? `
        <div class="wrp-hotspot ${top.reading.alert ? "is-alert" : ""}"
             ${bboxAttr(top.bbox)}
             role="button" tabindex="0"
             title="Fly to ${escapeHtml(top.district)}">
          <div class="wrp-hotspot-tag">HOTSPOT</div>
          <div class="wrp-hotspot-row">
            <div class="wrp-hotspot-text">
              <div class="wrp-hotspot-name">${escapeHtml(top.district)}</div>
              <div class="wrp-hotspot-meta">${escapeHtml(top.province)}</div>
            </div>
            <div class="wrp-hotspot-value">${escapeHtml(top.reading.label)}</div>
          </div>
        </div>
      `
          : ""
      }
    `;

    let groupsHtml = "";
    // Province ordering: by alert count desc, then district count desc.
    const orderedProvinces = [...provinces.entries()].sort(([, a], [, b]) => {
      const alertsA = a.filter((r) => r.reading.alert).length;
      const alertsB = b.filter((r) => r.reading.alert).length;
      if (alertsB !== alertsA) return alertsB - alertsA;
      return b.length - a.length;
    });

    for (const [province, list] of orderedProvinces) {
      const provinceAlerts = list.filter((r) => r.reading.alert).length;
      // Province-level aggregate: kind-aware aggregation across the
      // districts in this province.  CAPE / helicity take the MAX
      // (hotspot semantics — worst-case is the meaningful number),
      // every other kind takes the MEAN (typical conditions).
      const provinceAgg = this.#provinceAggregate(list, meta);
      // Province bbox: union of district bboxes — click-to-fly target.
      const provinceBbox = this.#unionBboxes(list.map((r) => r.bbox));
      // Header layout per spec: district count stays as text (no icon),
      // alert count becomes an icon badge (Lucide `octagon-alert`).
      // The badge only renders when there's at least one alert in the
      // province — otherwise the right side stays clean.
      const alertBadgeHtml =
        provinceAlerts > 0
          ? `<span class="wrp-group-alert-badge" title="${provinceAlerts} alert${provinceAlerts === 1 ? "" : "s"}">
               <i data-lucide="octagon-alert" class="wrp-group-alert-icon"></i>
               <span class="wrp-group-alert-count">${provinceAlerts}</span>
             </span>`
          : "";
      const aggHtml = provinceAgg
        ? `<span class="wrp-group-aggregate ${provinceAgg.alert ? "is-alert" : ""}" title="${escapeHtml(provinceAgg.title)}">${escapeHtml(provinceAgg.label)}</span>`
        : "";
      groupsHtml += `
        <div class="wrp-group">
          <div class="wrp-group-head"
               ${bboxAttr(provinceBbox)}
               role="button" tabindex="0"
               title="Fly to ${escapeHtml(province)}">
            <span class="wrp-group-name">${escapeHtml(province)}</span>
            <span class="wrp-group-meta">
              ${aggHtml}
              <span class="wrp-group-district-count">${list.length} district${list.length === 1 ? "" : "s"}</span>
              ${alertBadgeHtml}
            </span>
          </div>
          <div class="wrp-cards">
            ${list
              .map((r) => {
                const extrasHtml = (r.extras || [])
                  .map(
                    (ex) =>
                      `<span class="wrp-card-extra ${ex.alert ? "is-alert" : ""}" title="${escapeHtml(ex.source || "")}">${escapeHtml(ex.label)}</span>`
                  )
                  .join("");
                return `
              <div class="wrp-card ${r.reading.alert ? "is-alert" : ""}"
                   ${bboxAttr(r.bbox)}
                   role="button" tabindex="0"
                   title="Fly to ${escapeHtml(r.district)}">
                <div class="wrp-card-name">${escapeHtml(r.district)}</div>
                <div class="wrp-card-value">${escapeHtml(r.reading.label)}</div>
                ${extrasHtml ? `<div class="wrp-card-extras">${extrasHtml}</div>` : ""}
              </div>
            `;
              })
              .join("")}
          </div>
        </div>
      `;
    }

    const generated = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    // Layout split: `wrp-fixed` stays pinned to the top of the panel body
    // (summary + hotspot are reference data the user wants visible while
    // browsing); `wrp-scroll` owns the overflow so only the per-province
    // list scrolls.  The footer lives OUTSIDE this container at panel
    // level (#renderEmpty / #renderRows just write into #weatherReportFooter)
    // so it reads clearly as a static chrome strip, not the tail of a
    // scroll list.
    this.#contentEl.innerHTML = `
      <div class="wrp-fixed">${summaryHtml}</div>
      <div class="wrp-scroll">${groupsHtml}</div>
    `;
    if (this.#footerEl) {
      this.#footerEl.innerHTML = `${escapeHtml(meta.label)} · Generated ${generated}`;
      this.#footerEl.classList.add("is-visible");
    }
    // The new alert badges contain `<i data-lucide="octagon-alert">` —
    // lucide.createIcons() walks the DOM and replaces those placeholders
    // with their inline SVGs.  Cheap to call (it short-circuits when
    // there are no remaining `[data-lucide]` nodes).
    if (window.lucide?.createIcons) {
      try { window.lucide.createIcons(); } catch {}
    }
  }

  // -------------------------------------------------------------- tab machinery
  // Swap the visible body based on the tab requested.  Dynamic tab
  // keeps its listener lifecycle attached (map-driven).  PMD tab is
  // static — data pulled once through the cache, no map listeners
  // needed while it's on top.  Redundant switches are no-ops.
  #switchTab(tab) {
    if (tab !== "dynamic" && tab !== "pmd") return;
    if (this.#activeTab === tab) return;
    this.#activeTab = tab;

    // Tab button visual state
    for (const btn of this.#tabsEl.querySelectorAll(".wrp-tab")) {
      const on = btn.getAttribute("data-tab") === tab;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }

    // Body swap
    this.#contentEl.hidden = tab !== "dynamic";
    this.#pmdContentEl.hidden = tab !== "pmd";

    // Header contextual state — the alert threshold pill is a
    // Dynamic-tab-only artefact (there is no active layer concept on
    // the PMD Overview), and the subtitle text changes.
    if (tab === "pmd") {
      this.#thresholdEl.hidden = true;
      this.#subtitleEl.textContent = "Live PMD data feeds — bulletins, outlook, records";
      // Always land the PMD tab on the overview, even if the user
      // was inside a drill-down last time.  Force a re-render so
      // any layer toggles that happened while the Dynamic tab was
      // on top get picked up.
      this.#pmdView = "overview";
      this.#pmdLoaded = false;
      this.#renderPmdOverviewTab();
      this.#activeLayersFingerprint = "";
      this.#refreshActiveLayers();
    } else {
      // Re-run the dynamic renderer so the panel reflects any changes
      // that happened while the PMD tab was on top.
      this.#lastFingerprint = ""; // force full re-render
      this.#scheduleRender();
    }
  }

  // -------------------------------------------------------------- PMD Overview
  // Fetches every non-spatial GCOP endpoint in parallel via the shared
  // TTL cache, then renders labelled sections.  Idempotent: after the
  // first successful render, subsequent tab switches within the cache
  // windows show the same result without a network hit.
  async #renderPmdOverviewTab() {
    // Loading skeleton on first entry
    if (!this.#pmdLoaded && !this.#pmdLoading) {
      this.#pmdContentEl.innerHTML = `
        <div class="wrp-loading" role="status" aria-live="polite">
          <div class="wrp-loader" aria-hidden="true"></div>
          <div class="wrp-loading-text">Loading PMD data…</div>
        </div>
      `;
      this.#pmdLoading = true;
    } else if (this.#pmdLoaded) {
      // Already rendered — no work.  (Cache still guarantees fresh data
      // via the underlying getX helpers if TTL expired.)
      return;
    }

    // Fetch every section in parallel; tolerate individual failures.
    const [
      outlookRes,
      bulletinsRes,
      reportsRes,
      maxTempsRes,
      publicFcRes,
      nwfcFcRes,
    ] = await Promise.allSettled([
      getNwfcWeeklyOutlook(),
      getFfdBulletins(),
      getNwfcReports(),
      getNwfcMaxTemperatures(),
      getPmdPublicForecast(),
      getNwfcForecast(),
    ]);

    this.#pmdLoading = false;
    this.#pmdLoaded = true;

    // Snapshot the raw payloads so Download HTML/CSV can rebuild the
    // report without a second network round-trip.
    this.#pmdRawData = {
      outlook:   outlookRes.status   === "fulfilled" ? outlookRes.value   : null,
      bulletins: bulletinsRes.status === "fulfilled" ? bulletinsRes.value : null,
      reports:   reportsRes.status   === "fulfilled" ? reportsRes.value   : null,
      maxTemps:  maxTempsRes.status  === "fulfilled" ? maxTempsRes.value  : null,
      publicFc:  publicFcRes.status  === "fulfilled" ? publicFcRes.value  : null,
      nwfcFc:    nwfcFcRes.status    === "fulfilled" ? nwfcFcRes.value    : null,
    };

    const sections = [];
    sections.push(this.#renderOutlookSection(outlookRes));
    sections.push(this.#renderNwfcForecastSection(nwfcFcRes));
    sections.push(this.#renderBulletinsSection(bulletinsRes));
    sections.push(this.#renderRainfallReportsSection(reportsRes));
    sections.push(this.#renderPressReleasesSection(reportsRes));
    sections.push(this.#renderMaxTempsSection(maxTempsRes));
    sections.push(this.#renderPublicForecastSection(publicFcRes));

    this.#pmdContentEl.innerHTML = `
      <div class="wrp-fixed">
        <div class="wrp-pmd-hero">
          <div class="wrp-pmd-hero-badge">GCOP · Live</div>
          <div class="wrp-pmd-hero-title">Pakistan Meteorological Department</div>
          <div class="wrp-pmd-hero-sub">Cached feeds from PMD Monitor + NWFC + FFD (Section 6, integration doc)</div>
        </div>
        ${this.#renderDrillStrip()}
      </div>
      <div class="wrp-scroll wrp-pmd-scroll">
        <div class="wrp-pmd-active-layers" id="weatherReportActiveLayers"></div>
        <div class="wrp-pmd-forecast-section" id="weatherReportPmdForecast"></div>
        ${sections.filter(Boolean).join("")}
        ${this.#renderDownloadStrip()}
      </div>
    `;
    this.#activeLayersEl = this.#pmdContentEl.querySelector("#weatherReportActiveLayers");
    // First pass — force fingerprint refresh so we always paint on entry
    this.#activeLayersFingerprint = "";
    this.#refreshActiveLayers();
    this.#pmdForecastEl = this.#pmdContentEl.querySelector("#weatherReportPmdForecast");
    this.#refreshPmdForecastSection();

    // Wire delegation on the PMD content once — every Read / Download
    // button uses `data-pmd-action` so the handler stays generic.
    // innerHTML rewrites don't drop listeners on the parent, so this
    // survives every subsequent tab render.
    if (!this.#pmdClickBound) {
      this.#pmdContentEl.addEventListener("click", (ev) => this.#onPmdClick(ev));
      // Keyboard activation for the PMD Forecast table's row="button"
      // cells (real <button> elements elsewhere in this tab already get
      // this for free from the browser) — scoped to fly-bbox only so it
      // can't double-fire alongside a real button's native Enter/Space click.
      this.#pmdContentEl.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        if (!ev.target.closest('[data-pmd-action="fly-bbox"]')) return;
        ev.preventDefault();
        this.#onPmdClick(ev);
      });
      this.#pmdClickBound = true;
    }

    // Footer breadcrumb — mirrors the Dynamic tab's convention
    const generated = new Date().toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit",
    });
    if (this.#footerEl) {
      this.#footerEl.innerHTML = `PMD Overview · Generated ${escapeHtml(generated)}`;
      this.#footerEl.classList.add("is-visible");
    }
    if (window.lucide?.createIcons) {
      try { window.lucide.createIcons(); } catch {}
    }
  }

  // ---- individual section renderers -----------------------------------
  // `opts.collapsed: true` renders the section as a native <details>
  // element that starts collapsed — user has to click the header to
  // open.  Used for verbose / secondary sections (Bulletins, Rainfall
  // Reports, Press Releases, PMD Public Forecast) so the tab lands on
  // the important sections first (Outlook, Daily Forecast, Max Temps,
  // Active Layers) without a wall of link rows shoving everything
  // else offscreen.
  #pmdSectionShell(title, body, iconName = "circle", opts = {}) {
    const collapsed = opts && opts.collapsed === true;
    if (collapsed) {
      return `
        <details class="wrp-pmd-section wrp-pmd-section--collapsible">
          <summary class="wrp-pmd-section-head wrp-pmd-section-head--summary">
            <i data-lucide="${iconName}" class="wrp-pmd-section-icon"></i>
            <h4 class="wrp-pmd-section-title">${escapeHtml(title)}</h4>
            <span class="wrp-pmd-section-chevron" aria-hidden="true">▸</span>
          </summary>
          <div class="wrp-pmd-section-body">${body}</div>
        </details>
      `;
    }
    return `
      <section class="wrp-pmd-section">
        <header class="wrp-pmd-section-head">
          <i data-lucide="${iconName}" class="wrp-pmd-section-icon"></i>
          <h4 class="wrp-pmd-section-title">${escapeHtml(title)}</h4>
        </header>
        <div class="wrp-pmd-section-body">${body}</div>
      </section>
    `;
  }

  #pmdErrorBody(reason) {
    return `<p class="wrp-pmd-empty">Unavailable · ${escapeHtml(String(reason || "no response"))}</p>`;
  }

  #pmdEmptyBody(text) {
    return `<p class="wrp-pmd-empty">${escapeHtml(text)}</p>`;
  }

  // ---- PMD Forecast (pmd_pred_*) active-layer section -------------------
  // Async placeholder-fill, same two-phase pattern as #refreshActiveLayers:
  // #renderPmdOverviewTab already painted the rest of the tab synchronously
  // by the time this runs, so a slow district-sampling pass here never
  // delays the other 7 sections.
  async #refreshPmdForecastSection() {
    if (!this.#pmdForecastEl) return;
    const gen = ++this.#pmdForecastGen;
    this.#pmdForecastEl.innerHTML = this.#pmdSectionShell(
      "PMD Forecast — Active Layer",
      `<div class="wrp-loading" role="status" aria-live="polite">
        <div class="wrp-loader" aria-hidden="true"></div>
        <div class="wrp-loading-text">Checking active layer…</div>
      </div>`,
      "layers"
    );
    const html = await this.#renderPmdForecastSection();
    // Bail if a newer refresh started while this one was sampling (rapid
    // Refresh clicks, or a tab-away-and-back), OR the panel/tab moved on
    // entirely — #pmdForecastEl is nulled out in exactly that case (see
    // #renderPmdSubView).
    if (gen !== this.#pmdForecastGen) return;
    if (!this.#pmdForecastEl) return;
    this.#pmdForecastEl.innerHTML = html;
    if (window.lucide?.createIcons) {
      try { window.lucide.createIcons(); } catch {}
    }
  }

  #pmdForecastAlert(kind, value) {
    if (!Number.isFinite(value)) return false;
    switch (kind) {
      case "temperature":      return value >= T.TEMP_HOT;
      case "temperature_cold": return value <= T.TEMP_COLD;
      case "precip_hourly":    return value >= T.RAIN_HOURLY_HEAVY;
      case "precip_daily":     return value >= T.RAIN_DAILY_HEAVY;
      default:                 return false; // cloud_cover / rel_humidity — informational only
    }
  }

  async #renderPmdForecastSection() {
    const ICON = "layers";
    const TITLE = "PMD Forecast — Active Layer";

    const state = window.getCurrentTemporalState ? window.getCurrentTemporalState() : null;
    const fmeta = state?.layerKey ? PMD_FORECAST_ELEMENT_MAP[state.layerKey] : null;
    if (!fmeta) {
      return this.#pmdSectionShell(TITLE, this.#pmdEmptyBody(
        "Toggle a PMD Forecast raster layer (2m Temperature, 3h/6h/12h/24h Precipitation, " +
        "Cloud Cover, Relative Humidity, or 24h Extreme High/Low Temperature) to populate " +
        "district-level values here."
      ), ICON);
    }

    const districtVisible = this.#anyLayerVisible(DISTRICT_LAYER_IDS);
    const provinceVisible = this.#anyLayerVisible(PROVINCE_LAYER_IDS);
    if (!districtVisible || !provinceVisible) {
      return this.#pmdSectionShell(TITLE, this.#pmdEmptyBody(
        "Enable both District Boundary and Provincial Boundary in the sidebar to sample per-district values."
      ), ICON);
    }

    const districtQueryLayers = DISTRICT_LAYER_IDS.filter((id) => this.#map.getLayer(id)).slice(0, 1);
    const districtFeatures = this.#dedupedFeaturesByName(
      this.#map.queryRenderedFeatures({ layers: districtQueryLayers }),
      DISTRICT_NAME_KEYS
    );
    if (!districtFeatures.length) {
      return this.#pmdSectionShell(TITLE, this.#pmdEmptyBody(
        "No districts in view — pan or zoom so district polygons are visible."
      ), ICON);
    }

    // Bound the number of backend value-endpoint calls per render — each
    // one is real GDAL file I/O server-side, not a cheap lookup.
    const SAMPLE_CAP = 24;
    const sampled = districtFeatures.slice(0, SAMPLE_CAP);
    const overflow = districtFeatures.length - sampled.length;
    const stepIndex = state.currentIndex || 0;

    const results = await _mapLimit(sampled, 4, async (district) => {
      const name = this.#firstProp(district, DISTRICT_NAME_KEYS);
      const center = this.#featureCenter(district);
      if (!name || !center) return null;
      const [lon, lat] = center;
      const data = await _fetchPmdForecastValue(fmeta.elementKey, lat, lon, stepIndex);
      if (!data || data.value == null || !Number.isFinite(data.value)) return null;
      return {
        district: name,
        province: this.#firstProp(district, DISTRICT_PROVINCE_PROP_KEYS) || "Unknown",
        bbox: this.#featureBbox(district),
        value: data.value,
        unit: data.unit || "",
        label: data.label || "",
        date: data.date || "",
        alert: this.#pmdForecastAlert(fmeta.kind, data.value),
      };
    });

    const rows = results.filter(Boolean).sort((a, b) => b.value - a.value);
    if (!rows.length) {
      return this.#pmdSectionShell(TITLE, this.#pmdEmptyBody(
        "No values could be sampled for the districts in view — try a different step or region."
      ), ICON);
    }

    const label = rows[0].label || fmeta.elementKey;
    const dateTxt = rows[0].date || "";
    const alertCount = rows.filter((r) => r.alert).length;

    const tableRows = rows.map((r) => `
      <tr class="wrp-pmd-forecast-row${r.alert ? " is-alert" : ""}"
          data-pmd-action="fly-bbox" data-pmd-bbox="${r.bbox ? escapeHtml(r.bbox.join(",")) : ""}"
          role="button" tabindex="0" title="Fly to ${escapeHtml(r.district)}">
        <td>${escapeHtml(r.district)}</td>
        <td>${escapeHtml(r.province)}</td>
        <td>${escapeHtml(r.value.toFixed(1))}${escapeHtml(r.unit)}</td>
      </tr>
    `).join("");

    const overflowNote = overflow > 0
      ? `<p class="wrp-pmd-empty">+${overflow} more district${overflow === 1 ? "" : "s"} in view not sampled — zoom in to narrow the list.</p>`
      : "";

    const body = `
      <button class="wrp-pmd-read-btn" type="button" data-pmd-action="refresh-pmd-forecast" title="Re-sample the current view">
        <i data-lucide="refresh-cw"></i>
        <span>Refresh</span>
      </button>
      <div class="wrp-summary">
        <div class="wrp-stat"><strong>${rows.length}</strong><span>Districts</span></div>
        <div class="wrp-stat"><strong>${alertCount}</strong><span>Alerts</span></div>
      </div>
      <table class="wrp-pmd-layer-table">
        <thead><tr><th>District</th><th>Province</th><th>Value</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${overflowNote}
    `;

    // #pmdSectionShell escapes `title` itself — pass raw text, not pre-escaped.
    const titleWithMeta = `${TITLE} — ${label}${dateTxt ? ` · ${dateTxt}` : ""}`;
    return this.#pmdSectionShell(titleWithMeta, body, ICON);
  }

  #renderOutlookSection(res) {
    if (res.status !== "fulfilled") {
      return this.#pmdSectionShell("Weekly Outlook", this.#pmdErrorBody(res.reason), "calendar-days");
    }
    const data = res.value || {};
    const days = Array.isArray(data.days) ? data.days.slice(0, 7) : [];
    if (!days.length) {
      return this.#pmdSectionShell("Weekly Outlook", this.#pmdEmptyBody("No outlook published."), "calendar-days");
    }
    const items = days.map((d) => `
      <li class="wrp-pmd-outlook-item">
        <div class="wrp-pmd-outlook-date">${escapeHtml(d?.date || "—")}</div>
        <div class="wrp-pmd-outlook-body">${this.#highlightHazards(d?.outlook || "")}</div>
      </li>
    `).join("");
    return this.#pmdSectionShell(
      `Weekly Outlook${data.issue_date ? ` · issued ${escapeHtml(data.issue_date)}` : ""}`,
      `<ul class="wrp-pmd-outlook">${items}</ul>`,
      "calendar-days"
    );
  }

  #renderBulletinsSection(res) {
    if (res.status !== "fulfilled") {
      return this.#pmdSectionShell("Latest FFD Bulletins", this.#pmdErrorBody(res.reason), "file-warning", { collapsed: true });
    }
    const items = (res.value?.items || []).slice(0, 6);
    if (!items.length) {
      return this.#pmdSectionShell("Latest FFD Bulletins", this.#pmdEmptyBody("No bulletins."), "file-warning", { collapsed: true });
    }
    const rows = items.map((it) => `
      <a class="wrp-pmd-link-row" href="${escapeHtml(it?.download_url || "#")}"
         target="_blank" rel="noopener">
        <span class="wrp-pmd-link-kind wrp-pmd-link-kind--${(it?.kind || "").toLowerCase() === "advisory" ? "advisory" : "bulletin"}">
          ${escapeHtml(it?.kind || "PDF")}
        </span>
        <span class="wrp-pmd-link-body">
          <span class="wrp-pmd-link-title">${escapeHtml(it?.title || "Untitled")}</span>
          <span class="wrp-pmd-link-meta">${escapeHtml(it?.issued || "")}</span>
        </span>
        <i data-lucide="external-link" class="wrp-pmd-link-icon"></i>
      </a>
    `).join("");
    return this.#pmdSectionShell("Latest FFD Bulletins", rows, "file-warning", { collapsed: true });
  }

  // Split the merged reports payload into rainfall vs press-release
  // buckets.  Server may return several shapes:
  //   { rainfall_reports: [...], press_releases: [...] }
  //   { items: [{kind:"Daily Rainfall"|"Press Release", ...}, ...] }
  //   [ ...raw array... ]
  // We probe every shape defensively so field-name drift doesn't blank
  // a section that actually has data.
  #splitReportItems(data) {
    const empty = { rainfall: [], press: [] };
    if (!data) return empty;
    if (Array.isArray(data?.rainfall_reports) || Array.isArray(data?.press_releases)) {
      return {
        rainfall: data.rainfall_reports || [],
        press:    data.press_releases   || [],
      };
    }
    const all = Array.isArray(data?.items) ? data.items
      : Array.isArray(data?.reports)       ? data.reports
      : Array.isArray(data)                ? data
      : [];
    const kindMatch = (it, k) => String(it?.kind || "").toLowerCase().includes(k);
    return {
      rainfall: all.filter((it) => kindMatch(it, "rain")),
      press:    all.filter((it) => kindMatch(it, "press") || kindMatch(it, "release")),
    };
  }

  #renderRainfallReportsSection(res) {
    if (res.status !== "fulfilled") {
      return this.#pmdSectionShell("NWFC Daily Rainfall Reports", this.#pmdErrorBody(res.reason), "cloud-rain", { collapsed: true });
    }
    const { rainfall } = this.#splitReportItems(res.value);
    const items = rainfall.slice(0, 6);
    if (!items.length) {
      return this.#pmdSectionShell("NWFC Daily Rainfall Reports", this.#pmdEmptyBody("No rainfall reports."), "cloud-rain", { collapsed: true });
    }
    const rows = items.map((it) => this.#reportLinkRow(it, "report")).join("");
    return this.#pmdSectionShell("NWFC Daily Rainfall Reports", rows, "cloud-rain", { collapsed: true });
  }

  #renderPressReleasesSection(res) {
    if (res.status !== "fulfilled") {
      return this.#pmdSectionShell("NWFC Press Releases", this.#pmdErrorBody(res.reason), "megaphone", { collapsed: true });
    }
    const { press } = this.#splitReportItems(res.value);
    const items = press.slice(0, 6);
    if (!items.length) {
      return this.#pmdSectionShell("NWFC Press Releases", this.#pmdEmptyBody("No recent press releases."), "megaphone", { collapsed: true });
    }
    // Press-release rows get an extra "Read" button that lazy-loads the
    // extracted PDF text via /api/pmd/nwfc/press-release-text/ on click.
    // Only URLs on weather.gov.pk are accepted by the backend — hide
    // the Read button for anything else so the user isn't dead-ended.
    const rows = items.map((it, idx) => {
      const url = it?.url || it?.download_url || it?.link || "";
      const canRead = typeof url === "string" && url.startsWith("https://weather.gov.pk/");
      const readId = `wrp-pr-${idx}-${Math.random().toString(36).slice(2, 7)}`;
      const linkRow = this.#reportLinkRow(it, "release", canRead ? {
        readAttr: `data-pmd-action="read-pr" data-pmd-pr-url="${escapeHtml(url)}" data-pmd-pr-target="${readId}"`,
      } : null);
      return `
        ${linkRow}
        <div class="wrp-pmd-read-panel" id="${readId}" hidden></div>
      `;
    }).join("");
    return this.#pmdSectionShell("NWFC Press Releases", rows, "megaphone", { collapsed: true });
  }

  // Shared link-row builder used by bulletins / rainfall / press
  // sections.  `opts.readAttr` (optional) injects a "Read" button that
  // the delegated click handler picks up.
  #reportLinkRow(it, kindClass, opts) {
    const url    = it?.url || it?.download_url || it?.link || "#";
    const title  = it?.title || it?.name || it?.subject || "PDF";
    const issued = it?.issued || it?.date || it?.published || "";
    const kindLabel = kindClass === "release" ? "RELEASE"
                    : kindClass === "report"  ? "PDF"
                    : "PDF";
    return `
      <div class="wrp-pmd-link-row">
        <span class="wrp-pmd-link-kind wrp-pmd-link-kind--${kindClass}">${kindLabel}</span>
        <span class="wrp-pmd-link-body">
          <span class="wrp-pmd-link-title">${escapeHtml(title)}</span>
          <span class="wrp-pmd-link-meta">${escapeHtml(issued)}</span>
        </span>
        ${opts?.readAttr ? `
          <button class="wrp-pmd-read-btn" type="button" ${opts.readAttr} title="Extract PDF text inline">
            <i data-lucide="book-open-text"></i>
            <span>Read</span>
          </button>
        ` : ""}
        <a class="wrp-pmd-link-open" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Open PDF in new tab">
          <i data-lucide="external-link"></i>
        </a>
      </div>
    `;
  }

  // NWFC daily forecast table (§4.2).  The upstream response shape is
  // NOT tightly documented, so instead of hard-coding a field-name
  // guess (which was producing empty cells when the schema differed),
  // we discover the fields that are actually present on each item via
  // `#discoverForecastColumns` (shared with the HTML export builder so
  // both surfaces stay in lock-step).  On top of the dynamic table we
  // add:
  //   - a weather / temperature emoji next to each city name
  //   - documented-threshold highlighting on temp / humidity / wind /
  //     rain cells (see #thresholdClass for the ladders).
  #renderNwfcForecastSection(res) {
    if (res.status !== "fulfilled") {
      return this.#pmdSectionShell("NWFC Daily Forecast", this.#pmdErrorBody(res.reason), "cloud-sun-rain");
    }
    const cities = this.#extractItemArray(res.value, ["cities", "forecast", "items", "data", "stations", "records", "results"]);
    if (!cities.length) {
      return this.#pmdSectionShell("NWFC Daily Forecast", this.#pmdEmptyBody("No forecast published."), "cloud-sun-rain");
    }

    const { cols, nameKeys } = this.#discoverForecastColumns(cities);

    // Fallback if we STILL have no columns (all values were empty) —
    // dump a per-city "key: value" list so operators can at least see
    // what came back instead of a table of dashes.
    if (!cols.length) {
      const dump = cities.slice(0, 8).map((c) => {
        const name = nameKeys.map((k) => c?.[k]).find((v) => v != null && v !== "") || "—";
        const pairs = Object.entries(c || {})
          .filter(([k, v]) => !nameKeys.includes(k) && v != null && v !== "")
          .slice(0, 6)
          .map(([k, v]) => `<b>${escapeHtml(this.#prettyLabel(k))}:</b> ${this.#formatLayerCell(v, {})}`)
          .join(" · ");
        return `<li class="wrp-pmd-outlook-item">
                  <div class="wrp-pmd-outlook-date">${escapeHtml(String(name))}</div>
                  <div class="wrp-pmd-outlook-body">${pairs || "—"}</div>
                </li>`;
      }).join("");
      return this.#pmdSectionShell("NWFC Daily Forecast",
        `<ul class="wrp-pmd-outlook">${dump}</ul>`, "cloud-sun-rain");
    }

    // Pick the "Max" / temperature column (if any) to drive the
    // per-city emoji chip beside the city name.
    const tempCol = cols.find((x) => /max|temp|°c/i.test(x.label)) || null;
    const wxCol   = cols.find((x) => /weather|wx|condition/i.test(x.label)) || null;

    // Recognise weekday-suffixed columns (e.g. "Wednesday°C") so each
    // day cell can carry its own rain / sun / cloud emoji derived
    // from the day's weather field (or its temperature as fallback).
    const isDayCol = (label) =>
      /monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(String(label));

    const rows = cities.slice(0, 14).map((c) => {
      if (!c || typeof c !== "object") return "";
      const nameKey = nameKeys.find((k) => c[k] != null && c[k] !== "");
      const name = nameKey ? c[nameKey] : "—";

      // City-row emoji: probe the weather column if present, otherwise
      // fall back to the temperature column.  Both go through the
      // envelope-aware helpers so `{value: 39}` and `{weather:"Rain"}`
      // work as well as raw scalars.
      const wxRaw   = wxCol ? c[wxCol.key] : null;
      const tempRaw = tempCol ? c[tempCol.key] : null;
      const wxStr   = this.#extractWeather(wxRaw)
                   || this.#extractWeather(tempRaw);
      const tempVal = this.#parseTempRange(tempRaw);
      const emoji   = this.#weatherEmoji(wxStr) || this.#tempEmoji(tempVal);

      const cells = cols.map((col) => {
        const raw = c[col.key];
        const cls = this.#thresholdClass(this.#parseTempRange(raw), col.label);
        let dayEmoji = "";
        if (isDayCol(col.label)) {
          const dayWx = this.#extractWeather(raw);
          dayEmoji = this.#weatherEmoji(dayWx)
                  || this.#tempEmoji(this.#parseTempRange(raw));
        }
        const content = this.#formatLayerCell(raw, {});
        const inner = dayEmoji
          ? `<span class="wrp-pmd-cell-emoji" aria-hidden="true">${dayEmoji}</span> ${content}`
          : content;
        return `<td${cls ? ` class="${cls}"` : ""}>${inner}</td>`;
      }).join("");

      return `<tr>
        <td class="wrp-pmd-fc-time">
          <span class="wrp-pmd-city-emoji" aria-hidden="true">${emoji}</span>
          <span class="wrp-pmd-city-name">${escapeHtml(String(name))}</span>
        </td>
        ${cells}
      </tr>`;
    }).filter(Boolean).join("");

    const headers = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    const table = `
      <table class="wrp-pmd-fc-table">
        <thead><tr><th>City</th>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${this.#renderExtremeLegend()}
    `;
    return this.#pmdSectionShell("NWFC Daily Forecast", table, "cloud-sun-rain");
  }

  // ---- Shared: field discovery for NWFC-style city forecast ----
  // Returns { cols: [{label, key}, ...], nameKeys: [...] } so the
  // caller can render city name + N discovered columns.
  #discoverForecastColumns(cities) {
    const nameKeys = ["name", "city", "station", "station_name", "location", "title"];
    const priority = [
      { label: "Max °C",  keys: ["max_temp", "max_temperature", "temp_max", "tmax", "day_max", "high", "temperatureMax", "max", "max_c"] },
      { label: "Min °C",  keys: ["min_temp", "min_temperature", "temp_min", "tmin", "day_min", "low", "temperatureMin", "min", "min_c"] },
      { label: "Weather", keys: ["weather", "wx", "description", "forecast", "condition", "text", "wx_description", "summary"] },
      { label: "Rain",    keys: ["rain", "rainfall", "precipitation", "precip", "prec_mm", "rain_mm"] },
      { label: "Wind",    keys: ["wind_speed", "wind", "wspd", "wind_km", "wind_ms", "wind_kt", "wind_kmh"] },
      { label: "RH %",    keys: ["humidity", "rhu", "rh"] },
    ];
    const MAX_COLS = 6;

    const allFields = new Set();
    for (const c of cities.slice(0, 40)) {
      if (c && typeof c === "object") for (const k of Object.keys(c)) allFields.add(k);
    }
    const cols = [];
    const usedKeys = new Set(nameKeys);
    for (const p of priority) {
      if (cols.length >= MAX_COLS) break;
      const found = p.keys.find((k) => allFields.has(k));
      if (found) { cols.push({ label: p.label, key: found }); usedKeys.add(found); }
    }
    if (cols.length < MAX_COLS) {
      for (const k of allFields) {
        if (cols.length >= MAX_COLS) break;
        if (usedKeys.has(k)) continue;
        if (/^(id|pk|_.+)$/i.test(k)) continue;
        cols.push({ label: this.#prettyLabel(k), key: k });
        usedKeys.add(k);
      }
    }
    return { cols, nameKeys };
  }

  // ---- Documented extreme-value thresholds ----
  // Temperature classes follow WMO / PMD heat-advisory ladders (≥45 °C
  // extreme, ≥40 °C very hot, ≥35 °C hot; ≤0 °C freezing, ≤5 °C cold).
  // Humidity classes follow generic comfort ladders (≥90 % oppressive,
  // ≤20 % very dry).  Wind follows Beaufort-adjacent ladders (≥60 km/h
  // strong, ≥40 km/h moderate).  Rain follows PMD/IMD daily rain
  // classifications (≥25 mm heavy, ≥10 mm moderate).
  #thresholdClass(value, label) {
    const n = Number.isFinite(value) ? value : this.#parseTempRange(value);
    if (!Number.isFinite(n)) return "";
    const l = String(label).toLowerCase();
    if (l.includes("temp") || l.includes("°c") || /(max|min)\b/.test(l)) {
      if (n >= 45) return "wrp-pmd-x-extreme-hot";
      if (n >= 40) return "wrp-pmd-x-very-hot";
      if (n >= 35) return "wrp-pmd-x-hot";
      if (n <= 0)  return "wrp-pmd-x-freezing";
      if (n <= 5)  return "wrp-pmd-x-cold";
      return "";
    }
    if (l.includes("humidity") || l.includes("rh") || l === "rh %" || l.includes("%")) {
      if (n >= 90) return "wrp-pmd-x-humid";
      if (n <= 20) return "wrp-pmd-x-dry";
      return "";
    }
    if (l.includes("wind")) {
      if (n >= 60) return "wrp-pmd-x-strong-wind";
      if (n >= 40) return "wrp-pmd-x-mod-wind";
      return "";
    }
    if (l.includes("rain") || l.includes("precip")) {
      if (n >= 25) return "wrp-pmd-x-heavy-rain";
      if (n >= 10) return "wrp-pmd-x-mod-rain";
      return "";
    }
    return "";
  }

  // "24-26" → 26 (uses the higher of the range); "37.5" → 37.5;
  // {value: 28} → 28.  Unwraps envelope objects up front — endpoints
  // frequently deliver day-forecast cells as `{value, unit}` or
  // `{range, weather}` rather than raw scalars, and without this
  // unwrap the emoji and threshold pipelines were seeing NaN for
  // every value (the panel showed the default 🏙️ for every city).
  #parseTempRange(v) {
    v = this.#unwrapValue(v);
    if (v == null) return NaN;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v !== "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    }
    const s = v.trim();
    if (!s) return NaN;
    // Range doesn't require ^/$ anchors so we also match strings like
    // "24-26 °C" that carry a trailing unit.
    const range = s.match(/(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)/);
    if (range) return Math.max(Number(range[1]), Number(range[2]));
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  // Extract the primitive value from a "value-envelope" object, so
  // downstream string / number logic (parseTempRange, thresholdClass,
  // weatherEmoji) doesn't have to duplicate the fallback ladder.
  // Returns the value untouched if it's already primitive.
  #unwrapValue(v) {
    if (v == null) return null;
    if (typeof v !== "object") return v;
    if (Array.isArray(v)) return v.length ? v[0] : null;
    return v.value
        ?? v.max
        ?? v.temperature
        ?? v.temp
        ?? v.range
        ?? v.text
        ?? v.label
        ?? v.title
        ?? v.name
        ?? v.description
        ?? null;
  }

  // Pull a weather-description string out of an object (if any) so
  // per-day cells can render a matching rain / sun / storm emoji even
  // when the top-level column is a temperature range.
  #extractWeather(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      return String(
        v.weather
        ?? v.wx
        ?? v.description
        ?? v.condition
        ?? v.summary
        ?? v.wdesc
        ?? ""
      );
    }
    return "";
  }

  // Temperature-based fallback emoji (used when no weather text field
  // is present in the response).
  #tempEmoji(t) {
    if (!Number.isFinite(t)) return "🏙️";
    if (t >= 45) return "🥵";
    if (t >= 40) return "🔥";
    if (t >= 35) return "☀️";
    if (t >= 25) return "🌤️";
    if (t >= 15) return "🌥️";
    if (t >= 5)  return "🌦️";
    return "❄️";
  }

  // Weather-description emoji (preferred over temp emoji when the
  // response includes a `weather` / `wx` string).  Accepts either a
  // plain string or an object envelope — extracts the weather field
  // from the envelope before pattern matching.
  #weatherEmoji(text) {
    if (text == null) return "";
    if (typeof text === "object") text = this.#extractWeather(text);
    const s = String(text).toLowerCase();
    if (!s.trim()) return "";
    if (/thunder|lightning/.test(s)) return "⛈️";
    if (/rain|shower|drizzle/.test(s)) return "🌧️";
    if (/snow|blizzard/.test(s)) return "❄️";
    if (/fog|mist/.test(s)) return "🌫️";
    if (/dust|sandstorm/.test(s)) return "🌪️";
    if (/partl?y.*cloud|part.*cloud/.test(s)) return "⛅";
    if (/overcast|cloud/.test(s)) return "☁️";
    if (/wind|gust/.test(s)) return "💨";
    if (/clear|sunny|dry|fair/.test(s)) return "☀️";
    return "";
  }

  // Small legend strip explaining the threshold color chips.
  #renderExtremeLegend() {
    return `
      <div class="wrp-pmd-x-legend" title="Documented meteorological thresholds">
        <span class="wrp-pmd-x-legend-swatch wrp-pmd-x-extreme-hot">≥45°</span>
        <span class="wrp-pmd-x-legend-swatch wrp-pmd-x-very-hot">≥40°</span>
        <span class="wrp-pmd-x-legend-swatch wrp-pmd-x-hot">≥35°</span>
        <span class="wrp-pmd-x-legend-swatch wrp-pmd-x-humid">RH ≥90%</span>
        <span class="wrp-pmd-x-legend-swatch wrp-pmd-x-dry">RH ≤20%</span>
      </div>
    `;
  }

  // Neat structured-table fallback for datasets that don't map to a
  // known schema.  Discovers every property key across the sample,
  // renders every row as a table with those keys as columns.  Temp /
  // humidity / wind / rain-looking columns get threshold-coloured
  // backgrounds; level / status / alert / severity-looking columns
  // get coloured severity pills.  Used by both the panel section and
  // the sub-view so the fallback presentation stays consistent.
  #buildFallbackTable(source, opts = {}) {
    const maxRows = opts.maxRows ?? 40;
    if (!Array.isArray(source) || !source.length) return "";

    // Union of every property across up to 40 rows so the header
    // matches what's actually present.  Skip obvious internal ids.
    const allKeys = new Map();  // preserve insertion order
    for (const r of source.slice(0, 40)) {
      if (r && typeof r === "object") {
        for (const k of Object.keys(r)) {
          if (/^(id|pk|_.+)$/i.test(k)) continue;
          if (!allKeys.has(k)) allKeys.set(k, this.#prettyLabel(k));
        }
      }
    }
    const cols = Array.from(allKeys.entries()).map(([key, label]) => ({ key, label }));
    if (!cols.length) return "";

    // Chip / threshold detection uses the pretty label so the same
    // regex works whether the raw key is "Max Temp C" or "max_temp_c".
    const isChipCol = (label) => this.#reportLooksLikeChipField(label)
      || /^level$|^status$|^alert$|^severity$/i.test(String(label).replace(/\s+/g, ""));

    const headers = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    const rows = source.slice(0, maxRows).map((r) => {
      if (!r || typeof r !== "object") return "";
      const cells = cols.map((col) => {
        const raw = r[col.key];
        const text = this.#reportFormatValue(raw);
        if (raw == null || raw === "") {
          return `<td><span class="wrp-pmd-cell-empty">—</span></td>`;
        }
        // Chip render (severity/level/status pill)
        if (isChipCol(col.label)) {
          const lvl = String(text).toLowerCase()
            .replace(/\bexceptionally\s+high\b/g, "ex-high")
            .replace(/\bex[_\s-]*high\b/g, "ex-high")
            .replace(/\bvery\s+high\b/g, "very-high")
            .replace(/[\s_]+/g, "-");
          return `<td><span class="wrp-pmd-level-chip wrp-pmd-level-chip--${escapeHtml(lvl)}">${escapeHtml(text)}</span></td>`;
        }
        // Threshold-coloured background for numeric metric cells.
        const cls = this.#thresholdClass(this.#parseTempRange(raw), col.label);
        return `<td${cls ? ` class="${cls}"` : ""}>${escapeHtml(text)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).filter(Boolean).join("");

    return `
      <table class="wrp-pmd-fc-table wrp-pmd-fc-table--full">
        <thead><tr>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${this.#renderExtremeLegend()}
    `;
  }

  // Utility: dig an array of item objects out of any of the common
  // envelopes upstream APIs use (raw array, {items}, {data}, ...).
  #extractItemArray(data, keys = []) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
    return [];
  }

  // camelCase / snake_case → Title Case, e.g. `max_temp_c` → `Max Temp C`.
  #prettyLabel(key) {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .trim()
      .replace(/\b\w/g, (l) => l.toUpperCase());
  }

  // Highlight PMD hazard keywords in a plain-text narrative.  Called
  // once per outlook day.  Regex operates on already-escaped text, so
  // no XSS risk.  Word-boundary anchors + <mark> insertion means
  // subsequent matches never mis-fire inside earlier marks (the
  // inserted `<mark class="...">` uses non-word characters).
  #highlightHazards(text) {
    if (typeof text !== "string" || !text) return "";
    const escaped = escapeHtml(text);
    const pattern = /\b(heavy|very heavy|intense|severe|extreme|heatwave|heat wave|rain(?:s|fall)?|shower(?:s)?|drizzle|precipitation|thunder\w*|lightning|thunderstorm(?:s)?|storm(?:s)?|windstorm(?:s)?|dust storm(?:s)?|gust(?:s|y)?|winds?|flood(?:s|ing)?|flash flood(?:s)?|warning(?:s)?|advisor(?:y|ies)|alert(?:s)?|fog|haze|dust|snow(?:fall)?)\b/gi;
    return escaped.replace(pattern, (m) => `<mark class="wrp-pmd-hz">${m}</mark>`);
  }

  // §3.4 — drill-down button strip.  Each button swaps the entire
  // PMD tab body for a dedicated sub-view (see #renderPmdSubView).
  // Uses the delegated PMD click handler (data-pmd-action="drill").
  #renderDrillStrip() {
    const btn = (view, label, icon) => `
      <button class="wrp-pmd-drill-btn" type="button"
              data-pmd-action="drill" data-pmd-view="${escapeHtml(view)}">
        <i data-lucide="${icon}" class="wrp-pmd-drill-icon"></i>
        <span>${escapeHtml(label)}</span>
      </button>
    `;
    return `
      <div class="wrp-pmd-drill-strip" role="group" aria-label="PMD Data Panels">
        ${btn("forecast",  "Daily Forecast",   "cloud-sun-rain")}
        ${btn("rainfall",  "Rainfall Reports", "cloud-rain")}
        ${btn("max-temps", "Max Temp Records", "thermometer-sun")}
        ${btn("releases",  "Press Releases",   "megaphone")}
        ${btn("outlook",   "Weekly Outlook",   "calendar-days")}
        ${btn("bulletins", "FFD Bulletins",    "file-warning")}
      </div>
    `;
  }

  // Sub-view metadata table.  Each entry supplies the header title,
  // source attribution (per §3.4), the Lucide icon for the crown, and
  // the class-method name that builds the body.
  #pmdSubViewMeta(view) {
    switch (view) {
      case "forecast":  return { title: "NWFC Daily Forecast",       source: "PMD NWFC · weather.gov.pk",  icon: "cloud-sun-rain" };
      case "rainfall":  return { title: "NWFC Daily Rainfall Reports", source: "PMD NWFC · weather.gov.pk", icon: "cloud-rain" };
      case "max-temps": return { title: "Max Temp Records",           source: "PMD NWFC · weather.gov.pk", icon: "thermometer-sun" };
      case "releases":  return { title: "NWFC Press Releases",        source: "PMD NWFC · weather.gov.pk", icon: "megaphone" };
      case "outlook":   return { title: "Weekly Outlook",             source: "PMD NWFC · weather.gov.pk", icon: "calendar-days" };
      case "bulletins": return { title: "FFD Bulletins",              source: "FFD · ffd.pmd.gov.pk",       icon: "file-warning" };
      default: return null;
    }
  }

  // §3.4 sub-view render — full-content swap.  Header carries a
  // ← Back button, the title, and the source attribution; body is
  // the view's bespoke renderer.  Data is pulled from the
  // #pmdRawData snapshot so this is always instant (no re-fetch);
  // if the endpoint failed at render time the sub-view surfaces
  // the error inline instead of blanking.
  #renderPmdSubView(view) {
    const meta = this.#pmdSubViewMeta(view);
    if (!meta) { this.#pmdView = "overview"; this.#renderPmdOverviewTab(); return; }
    this.#pmdView = view;

    let body = "";
    try {
      switch (view) {
        case "forecast":  body = this.#buildForecastFullView();  break;
        case "rainfall":  body = this.#buildRainfallFullView();  break;
        case "max-temps": body = this.#buildMaxTempsFullView();  break;
        case "releases":  body = this.#buildReleasesFullView();  break;
        case "outlook":   body = this.#buildOutlookFullView();   break;
        case "bulletins": body = this.#buildBulletinsFullView(); break;
      }
    } catch (err) {
      body = `<div class="wrp-pmd-subview-error">Error: ${escapeHtml(String(err?.message || err))}</div>`;
    }

    this.#pmdContentEl.innerHTML = `
      <div class="wrp-fixed">
        <div class="wrp-pmd-subview-head">
          <button class="wrp-pmd-back-btn" type="button" data-pmd-action="back" title="Back to overview">
            <i data-lucide="arrow-left"></i>
            <span>Back</span>
          </button>
          <div class="wrp-pmd-subview-titlewrap">
            <i data-lucide="${meta.icon}" class="wrp-pmd-subview-icon"></i>
            <h3 class="wrp-pmd-subview-title">${escapeHtml(meta.title)}</h3>
          </div>
          <div class="wrp-pmd-subview-source">${escapeHtml(meta.source)}</div>
        </div>
      </div>
      <div class="wrp-scroll wrp-pmd-subview-body">
        ${body}
      </div>
    `;
    this.#activeLayersEl = null;
    this.#pmdForecastEl = null;
    if (this.#footerEl) {
      this.#footerEl.innerHTML = `${escapeHtml(meta.title)} · ${escapeHtml(meta.source)}`;
      this.#footerEl.classList.add("is-visible");
    }
    if (window.lucide?.createIcons) { try { window.lucide.createIcons(); } catch {} }
  }

  // ---- Sub-view body builders (all pull from #pmdRawData snapshot) ----

  #buildForecastFullView() {
    const cities = this.#extractItemArray(this.#pmdRawData?.nwfcFc,
      ["cities", "forecast", "items", "data", "stations", "records", "results"]);
    if (!cities.length) return `<p class="wrp-pmd-empty">No forecast published.</p>`;

    const { cols, nameKeys } = this.#discoverForecastColumns(cities);
    if (!cols.length) return `<p class="wrp-pmd-empty">Response has no discoverable columns.</p>`;

    const tempCol = cols.find((x) => /max|temp|°c/i.test(x.label)) || null;
    const wxCol   = cols.find((x) => /weather|wx|condition/i.test(x.label)) || null;
    const isDayCol = (label) =>
      /monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(String(label));

    const headers = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    const rows = cities.map((c) => {
      if (!c || typeof c !== "object") return "";
      const nameKey = nameKeys.find((k) => c[k] != null && c[k] !== "");
      const name = nameKey ? c[nameKey] : "—";
      const wxRaw   = wxCol ? c[wxCol.key] : null;
      const tempRaw = tempCol ? c[tempCol.key] : null;
      const wxStr   = this.#extractWeather(wxRaw) || this.#extractWeather(tempRaw);
      const tempVal = this.#parseTempRange(tempRaw);
      const emoji   = this.#weatherEmoji(wxStr) || this.#tempEmoji(tempVal);
      const cells = cols.map((col) => {
        const raw = c[col.key];
        const cls = this.#thresholdClass(this.#parseTempRange(raw), col.label);
        let dayEmoji = "";
        if (isDayCol(col.label)) {
          const dayWx = this.#extractWeather(raw);
          dayEmoji = this.#weatherEmoji(dayWx) || this.#tempEmoji(this.#parseTempRange(raw));
        }
        const content = this.#formatLayerCell(raw, {});
        const inner = dayEmoji
          ? `<span class="wrp-pmd-cell-emoji" aria-hidden="true">${dayEmoji}</span> ${content}`
          : content;
        return `<td${cls ? ` class="${cls}"` : ""}>${inner}</td>`;
      }).join("");
      return `<tr>
        <td class="wrp-pmd-fc-time">
          <span class="wrp-pmd-city-emoji" aria-hidden="true">${emoji}</span>
          <span class="wrp-pmd-city-name">${escapeHtml(String(name))}</span>
        </td>
        ${cells}
      </tr>`;
    }).filter(Boolean).join("");

    return `
      <table class="wrp-pmd-fc-table wrp-pmd-fc-table--full">
        <thead><tr><th>City</th>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${this.#renderExtremeLegend()}
    `;
  }

  #buildRainfallFullView() {
    const { rainfall } = this.#splitReportItems(this.#pmdRawData?.reports);
    if (!rainfall.length) return `<p class="wrp-pmd-empty">No rainfall reports.</p>`;
    return rainfall.map((it) => this.#reportLinkRow(it, "report")).join("");
  }

  // §4 "Max Temp Records" panel — feeds from `/api/pmd/nwfc/max-temperatures/`.
  // Rebuilt on top of the same dynamic-column discovery + emoji + threshold
  // pipeline as the NWFC Daily Forecast sub-view so the two surfaces read
  // as one visual system.  Records sorted hottest-first so the extreme heat
  // sits at the top of the ranking.
  #buildMaxTempsFullView() {
    // Deep extraction — the endpoint sometimes nests the row array under
    // `provinces` / `by_station` envelopes rather than a top-level `items`.
    let source = this.#extractItemArray(this.#pmdRawData?.maxTemps,
      ["items", "data", "stations", "records", "results", "max_temperatures", "max_temps", "list", "rows"]);
    if (!source.length) source = this.#deepFindItemArray(this.#pmdRawData?.maxTemps);
    if (!source.length) {
      return `<p class="wrp-pmd-empty">No records available.</p>`;
    }

    const { cols, nameKeys } = this.#discoverMaxTempsColumns(source);

    // If nothing recognisable, fall through to the shared table
    // fallback so the operator sees a proper columned view (with
    // threshold highlighting and severity chips) instead of the ugly
    // key: value · key: value dump we used to render.
    if (!cols.length) {
      return `
        <div class="wrp-pmd-subview-issued">
          ${source.length} record${source.length === 1 ? "" : "s"} returned; standard schema didn't match — every field shown below with automatic column discovery.
        </div>
        ${this.#buildFallbackTable(source, { maxRows: source.length })}
      `;
    }

    // Pick the temperature column — used both for the row-level emoji
    // chip and for sorting hottest → coolest.
    const tempCol = cols.find((x) => /max|temp|°c|record/i.test(x.label)) || null;

    // Sort by max temp desc when a temp column is present so the ranking
    // reads as "hottest records first" (matches the NWFC page ordering).
    let ranked = source;
    if (tempCol) {
      ranked = [...source].sort((a, b) => {
        const av = this.#parseTempRange(a?.[tempCol.key]);
        const bv = this.#parseTempRange(b?.[tempCol.key]);
        if (!Number.isFinite(bv)) return -1;
        if (!Number.isFinite(av)) return 1;
        return bv - av;
      });
    }

    const headers = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    const rows = ranked.map((r) => {
      if (!r || typeof r !== "object") return "";
      const nameKey = nameKeys.find((k) => r[k] != null && r[k] !== "");
      const name = nameKey ? this.#unwrapValue(r[nameKey]) ?? r[nameKey] : "—";

      // Row-level station emoji comes from the temperature column
      // (weather description isn't part of a max-record row).
      const tempRaw = tempCol ? r[tempCol.key] : null;
      const tempVal = this.#parseTempRange(tempRaw);
      const emoji   = this.#tempEmoji(tempVal);

      const cells = cols.map((col) => {
        const raw = r[col.key];
        const cls = this.#thresholdClass(this.#parseTempRange(raw), col.label);
        const content = this.#formatLayerCell(raw, {});
        return `<td${cls ? ` class="${cls}"` : ""}>${content}</td>`;
      }).join("");

      return `<tr>
        <td class="wrp-pmd-fc-time">
          <span class="wrp-pmd-city-emoji" aria-hidden="true">${emoji}</span>
          <span class="wrp-pmd-city-name">${escapeHtml(String(name))}</span>
        </td>
        ${cells}
      </tr>`;
    }).filter(Boolean).join("");

    return `
      <div class="wrp-pmd-subview-issued">
        Source · <code>/api/pmd/nwfc/max-temperatures/</code> · ${ranked.length} record${ranked.length === 1 ? "" : "s"}${tempCol ? ` · sorted hottest first` : ""}.
      </div>
      <table class="wrp-pmd-fc-table wrp-pmd-fc-table--full">
        <thead><tr><th>Station</th>${headers}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${this.#renderExtremeLegend()}
    `;
  }

  // Field-discovery for `/api/pmd/nwfc/max-temperatures/`.  Priority
  // ladder places record temperature first, then date/year, then any
  // useful contextual field the response happens to carry (province,
  // elevation, ...).  Fields we don't recognise fill the remaining
  // slots via #prettyLabel so the operator still sees them.
  // Normalise a field name for case/space/underscore-insensitive matching.
  // "Max Temp C" / "max_temp_c" / "MaxTempC" all collapse to "maxtempc"
  // so the same probe entry covers every casing/separator convention
  // scrapers use.  Also strips a trailing "°C" / "°F" / "%" unit so a
  // header like "Max Temp °C" still matches a probe of "max_temp_c".
  #normFieldKey(k) {
    return String(k)
      .toLowerCase()
      .replace(/[\s_\-.]+/g, "")
      .replace(/°[cf]$|percent$|%$/g, "");
  }

  #discoverMaxTempsColumns(items) {
    const nameKeys = [
      "name", "station", "station_name", "stationname",
      "city", "location", "site", "place", "observatory",
    ];
    const priority = [
      { label: "Max °C",   keys: ["max_temp_c", "temperature", "max_temperature", "max_temp",
                                  "maxTemp", "max", "record_max", "record_temp", "record",
                                  "ever_max", "all_time_max", "all_time", "historical_max",
                                  "absolute_max", "absolute_high", "hottest", "peak", "peak_temp",
                                  "high", "temp", "tmax", "tmax_c", "max_c", "value"] },
      { label: "Date",     keys: ["date", "recorded_on", "record_date", "when", "at", "observed_on"] },
      { label: "Year",     keys: ["year", "year_of_record", "recorded_year", "record_year"] },
      { label: "Province", keys: ["province", "state", "region", "district"] },
      { label: "Elev m",   keys: ["elevation", "altitude", "elev", "elev_m", "altitude_m"] },
    ];
    const MAX_COLS = 5;

    // Build a normalised → original-key map across the sample so probes
    // stay agnostic to the scraper's casing/separator choices.
    const fieldsMap = new Map();
    for (const c of items.slice(0, 40)) {
      if (c && typeof c === "object") {
        for (const k of Object.keys(c)) {
          const n = this.#normFieldKey(k);
          if (!fieldsMap.has(n)) fieldsMap.set(n, k);
        }
      }
    }

    const usedKeys = new Set();
    // Reserve the actual name-column keys so they don't fill leftover slots.
    const discoveredNameKeys = [];
    for (const nk of nameKeys) {
      const found = fieldsMap.get(this.#normFieldKey(nk));
      if (found && !discoveredNameKeys.includes(found)) {
        discoveredNameKeys.push(found);
        usedKeys.add(found);
      }
    }
    if (!discoveredNameKeys.length) discoveredNameKeys.push(...nameKeys);

    const cols = [];
    for (const p of priority) {
      if (cols.length >= MAX_COLS) break;
      let foundKey = null;
      for (const probe of p.keys) {
        const actual = fieldsMap.get(this.#normFieldKey(probe));
        if (actual && !usedKeys.has(actual)) { foundKey = actual; break; }
      }
      if (foundKey) { cols.push({ label: p.label, key: foundKey }); usedKeys.add(foundKey); }
    }
    if (cols.length < MAX_COLS) {
      for (const originalKey of fieldsMap.values()) {
        if (cols.length >= MAX_COLS) break;
        if (usedKeys.has(originalKey)) continue;
        if (/^(id|pk|_.+)$/i.test(originalKey)) continue;
        cols.push({ label: this.#prettyLabel(originalKey), key: originalKey });
        usedKeys.add(originalKey);
      }
    }
    return { cols, nameKeys: discoveredNameKeys };
  }

  // Walk an object one level deep looking for the first array of
  // objects.  Used when the standard shallow key list misses because
  // the endpoint wraps the row list under a category envelope (e.g.
  // `{by_province: {sindh: [...], punjab: [...]}}`).
  #deepFindItemArray(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    // Level 1 — direct properties.
    for (const v of Object.values(data)) {
      if (Array.isArray(v) && v.length && v.some((x) => x && typeof x === "object")) {
        return v.filter((x) => x && typeof x === "object");
      }
    }
    // Level 2 — nested one deeper.  Flatten arrays and array-valued
    // properties as we go so category maps also unfold.
    const flat = [];
    for (const v of Object.values(data)) {
      if (!v || typeof v !== "object") continue;
      if (Array.isArray(v)) {
        for (const child of v) {
          if (child && typeof child === "object") {
            const inner = this.#deepFindItemArray(child);
            flat.push(...inner);
          }
        }
        continue;
      }
      for (const nested of Object.values(v)) {
        if (Array.isArray(nested)) {
          for (const item of nested) {
            if (item && typeof item === "object") flat.push(item);
          }
        }
      }
    }
    return flat;
  }

  #buildReleasesFullView() {
    const { press } = this.#splitReportItems(this.#pmdRawData?.reports);
    if (!press.length) return `<p class="wrp-pmd-empty">No recent press releases.</p>`;
    return press.map((it, idx) => {
      const url = it?.url || it?.download_url || it?.link || "";
      const canRead = typeof url === "string" && url.startsWith("https://weather.gov.pk/");
      const readId = `wrp-sv-pr-${idx}-${Math.random().toString(36).slice(2, 7)}`;
      const linkRow = this.#reportLinkRow(it, "release", canRead ? {
        readAttr: `data-pmd-action="read-pr" data-pmd-pr-url="${escapeHtml(url)}" data-pmd-pr-target="${readId}"`,
      } : null);
      return `${linkRow}<div class="wrp-pmd-read-panel" id="${readId}" hidden></div>`;
    }).join("");
  }

  #buildOutlookFullView() {
    const data = this.#pmdRawData?.outlook || {};
    const days = Array.isArray(data.days) ? data.days : [];
    if (!days.length) return `<p class="wrp-pmd-empty">No outlook published.</p>`;

    const issued = data.issue_date ? `<div class="wrp-pmd-subview-issued">Issued: ${escapeHtml(String(data.issue_date))}</div>` : "";
    const items = days.map((d) => `
      <li class="wrp-pmd-outlook-item wrp-pmd-outlook-item--full">
        <div class="wrp-pmd-outlook-date">${escapeHtml(String(d?.date || "—"))}</div>
        <div class="wrp-pmd-outlook-body">${this.#highlightHazards(String(d?.outlook || ""))}</div>
      </li>
    `).join("");
    return `${issued}<ul class="wrp-pmd-outlook">${items}</ul>`;
  }

  #buildBulletinsFullView() {
    const items = this.#pmdRawData?.bulletins?.items || [];
    if (!items.length) return `<p class="wrp-pmd-empty">No bulletins.</p>`;
    return items.map((it) => this.#reportLinkRow(it, (it?.kind || "").toLowerCase() === "advisory" ? "release" : "bulletin")).join("");
  }

  // Bottom-of-tab chrome strip with two download buttons.  Uses the
  // #pmdRawData snapshot cached during the last render so a click is
  // instant and doesn't re-fetch.
  #renderDownloadStrip() {
    return `
      <div class="wrp-pmd-download-strip">
        <div class="wrp-pmd-download-label">Export Situational Report</div>
        <div class="wrp-pmd-download-buttons">
          <button class="wrp-pmd-download-btn" type="button"
                  data-pmd-action="download-html"
                  title="Full NCOP-themed HTML report with analysis and active layers">
            <i data-lucide="file-code-2"></i>
            <span>HTML</span>
          </button>
          <button class="wrp-pmd-download-btn" type="button"
                  data-pmd-action="download-csv"
                  title="Excel-friendly CSV with every section">
            <i data-lucide="sheet"></i>
            <span>CSV</span>
          </button>
        </div>
      </div>
    `;
  }

  // -------------------------------------------------------------- PMD click delegation
  async #onPmdClick(ev) {
    const target = ev.target.closest("[data-pmd-action]");
    if (!target) return;
    const action = target.getAttribute("data-pmd-action");

    // PMD Forecast section: re-sample the current view / step on demand.
    if (action === "refresh-pmd-forecast") {
      ev.preventDefault();
      this.#refreshPmdForecastSection();
      return;
    }
    // PMD Forecast section: click a district row to fly to its bbox —
    // same fitBounds call the Dynamic Report tab's data-fly-bbox handler
    // uses, just routed through this tab's own delegated listener.
    if (action === "fly-bbox") {
      ev.preventDefault();
      const raw = target.getAttribute("data-pmd-bbox");
      if (!raw) return;
      const [w, s, e, n] = raw.split(",").map(Number);
      if (![w, s, e, n].every(Number.isFinite)) return;
      try {
        this.#map.fitBounds([[w, s], [e, n]], { padding: 60, duration: 900, maxZoom: 10 });
      } catch (err) {
        console.warn("[WeatherReport] fitBounds failed:", err);
      }
      return;
    }

    // §3.4 drill-down navigation
    if (action === "drill") {
      ev.preventDefault();
      const view = target.getAttribute("data-pmd-view");
      if (view) this.#renderPmdSubView(view);
      return;
    }
    if (action === "back") {
      ev.preventDefault();
      this.#pmdView = "overview";
      // Force overview to re-render (data still cached, so this is instant).
      this.#pmdLoaded = false;
      this.#renderPmdOverviewTab();
      return;
    }

    if (action === "read-pr") {
      ev.preventDefault();
      const url = target.getAttribute("data-pmd-pr-url");
      const targetId = target.getAttribute("data-pmd-pr-target");
      if (!url || !targetId) return;
      const panel = document.getElementById(targetId);
      if (!panel) return;
      // Toggle collapse if already open
      if (!panel.hasAttribute("hidden") && panel.dataset.loaded === "1") {
        panel.hidden = true;
        target.querySelector("span").textContent = "Read";
        return;
      }
      if (panel.dataset.loaded === "1") {
        panel.hidden = false;
        target.querySelector("span").textContent = "Hide";
        return;
      }
      // Fresh load
      target.disabled = true;
      target.querySelector("span").textContent = "Loading…";
      panel.hidden = false;
      panel.innerHTML = `<div class="wrp-pmd-read-loading">
        <div class="wrp-loader" aria-hidden="true"></div>
        <span>Extracting PDF text…</span>
      </div>`;
      try {
        const data = await getNwfcPressReleaseText(url);
        const text = typeof data === "string" ? data
                   : typeof data?.text === "string" ? data.text
                   : typeof data?.content === "string" ? data.content
                   : "";
        const err = data?.error;
        if (err) {
          panel.innerHTML = `<div class="wrp-pmd-read-error">${escapeHtml(String(err))}</div>`;
        } else if (!text.trim()) {
          panel.innerHTML = `<div class="wrp-pmd-read-error">Empty response.</div>`;
        } else {
          panel.innerHTML = `<pre class="wrp-pmd-read-text">${escapeHtml(text)}</pre>`;
        }
        panel.dataset.loaded = "1";
        target.disabled = false;
        target.querySelector("span").textContent = "Hide";
      } catch (e) {
        panel.innerHTML = `<div class="wrp-pmd-read-error">Failed: ${escapeHtml(String(e?.message || e))}</div>`;
        target.disabled = false;
        target.querySelector("span").textContent = "Read";
      }
      return;
    }

    if (action === "download-html") {
      this.#triggerDownload(this.#buildHtmlReport(), `pmd-report-${this.#stampFilename()}.html`, "text/html;charset=utf-8");
      return;
    }
    if (action === "download-csv") {
      // UTF-8 BOM so Excel renders °/³/em-dash correctly.
      this.#triggerDownload("﻿" + this.#buildCsvReport(), `pmd-report-${this.#stampFilename()}.csv`, "text/csv;charset=utf-8");
      return;
    }
  }

  #stampFilename() {
    // Avoid Date.now-only naming so multiple downloads in a session
    // stay distinguishable; use HH-MM-SS component.
    try {
      const d = new Date();
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    } catch { return "snapshot"; }
  }

  #triggerDownload(content, filename, mime) {
    try {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      console.warn("[PMD Report] download failed:", e);
    }
  }

  // ---- Export builders (share source: #pmdRawData snapshot) -------------
  #buildCsvReport() {
    const raw = this.#pmdRawData || {};
    const lines = [];
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\r\n]/.test(s) ? `"${s}"` : s;
    };
    const section = (title, header, rows) => {
      lines.push(`=== SECTION: ${title} ===`);
      lines.push(header.join(","));
      for (const r of rows) lines.push(r.map(esc).join(","));
      lines.push("");
    };

    lines.push("=== REPORT ===");
    lines.push(`Generated,${new Date().toISOString()}`);
    lines.push(`Source,GCOP PMD Monitor + NWFC + FFD`);
    lines.push(`Classification,Restricted operational use — verify before operational use`);
    lines.push("");

    // Weekly Outlook
    const outlookDays = Array.isArray(raw.outlook?.days) ? raw.outlook.days : [];
    if (outlookDays.length) {
      section("Weekly Outlook", ["Date", "Outlook"],
        outlookDays.map((d) => [d?.date || "", d?.outlook || ""]));
    }

    // NWFC Daily Forecast
    // CSV NWFC Daily Forecast — dynamic discovery to match the panel
    // and the HTML export, and route every value through
    // #reportFormatValue so object cells become their `.value / .text`
    // summary rather than "[object Object]".
    const nwfcCities = this.#extractItemArray(raw.nwfcFc, ["cities", "forecast", "items", "data", "stations", "records", "results"]);
    if (nwfcCities.length) {
      const { cols, nameKeys } = this.#discoverForecastColumns(nwfcCities);
      if (cols.length) {
        const header = ["City", ...cols.map((c) => c.label)];
        section("NWFC Daily Forecast", header,
          nwfcCities.map((c) => {
            const nameKey = nameKeys.find((k) => c?.[k] != null && c[k] !== "");
            const name = nameKey ? this.#reportFormatValue(c[nameKey]) : "";
            return [name, ...cols.map((col) => this.#reportFormatValue(c?.[col.key]))];
          }));
      }
    }

    // FFD Bulletins
    const bulletins = Array.isArray(raw.bulletins?.items) ? raw.bulletins.items : [];
    if (bulletins.length) {
      section("FFD Bulletins", ["Kind", "Title", "Issued", "URL"],
        bulletins.map((b) => [
          this.#reportFormatValue(b?.kind),
          this.#reportFormatValue(b?.title),
          this.#reportFormatValue(b?.issued),
          this.#reportFormatValue(b?.download_url),
        ]));
    }

    // NWFC Reports (split)
    const splitReports = this.#splitReportItems(raw.reports);
    if (splitReports.rainfall.length) {
      section("NWFC Daily Rainfall Reports", ["Title", "Date", "URL"],
        splitReports.rainfall.map((r) => [
          this.#reportFormatValue(r?.title ?? r?.name),
          this.#reportFormatValue(r?.issued ?? r?.date),
          this.#reportFormatValue(r?.url ?? r?.download_url),
        ]));
    }
    if (splitReports.press.length) {
      section("NWFC Press Releases", ["Title", "Date", "URL"],
        splitReports.press.map((r) => [
          this.#reportFormatValue(r?.title ?? r?.name),
          this.#reportFormatValue(r?.issued ?? r?.date),
          this.#reportFormatValue(r?.url ?? r?.download_url),
        ]));
    }

    // Max Temperatures
    const mtRaw = raw.maxTemps;
    const mtSource = Array.isArray(mtRaw) ? mtRaw
      : Array.isArray(mtRaw?.items) ? mtRaw.items
      : Array.isArray(mtRaw?.data)  ? mtRaw.data
      : Array.isArray(mtRaw?.stations) ? mtRaw.stations
      : [];
    if (mtSource.length) {
      section("Historical Record Max Temperatures", ["Station", "Max °C", "Date"],
        mtSource.map((r) => [
          this.#reportFormatValue(r?.name ?? r?.station ?? r?.city),
          this.#reportFormatValue(r?.temperature ?? r?.max_temperature ?? r?.max_temp ?? r?.value),
          this.#reportFormatValue(r?.date ?? r?.recorded_on),
        ]));
    }

    return lines.join("\r\n");
  }

  // Extract a printable plain-text value from anything the endpoints
  // might return.  Used by both the HTML and CSV exports so nested
  // objects (`{"value": "24-26"}`, `{"text": "Rain"}`) don't leak as
  // "[object Object]" and arrays don't leak as "[Object,Object,...]".
  // Returns UNESCAPED text — the caller is responsible for esc/CSV
  // quoting because escaping rules differ between the two formats.
  #reportFormatValue(v) {
    if (v == null || v === "") return "";
    if (typeof v === "object") {
      if (Array.isArray(v)) {
        // Try to summarise an array of primitives inline; fall back to
        // "N items" for arrays of objects.
        if (v.every((x) => x == null || typeof x !== "object")) {
          const joined = v.filter((x) => x != null && x !== "").join(", ");
          return joined || `${v.length} items`;
        }
        return `${v.length} items`;
      }
      // Probe common label fields
      const s = v.label ?? v.name ?? v.title ?? v.value ?? v.text ?? v.description ?? v.summary;
      if (s != null && s !== "" && typeof s !== "object") return String(s);
      try {
        const j = JSON.stringify(v);
        return j.length > 80 ? j.slice(0, 77) + "…" : j;
      } catch { return String(v); }
    }
    return String(v);
  }

  // Chip colour palette for level / status / alert values encountered
  // across the tracked layers.  Same mapping used by the panel CSS
  // (.wrp-pmd-level-chip--*) so the report reads as the same alert
  // system.  Returns "" for values not on any severity ladder.
  #reportChipStyle(raw) {
    if (raw == null || raw === "") return "";
    const v = String(raw).toLowerCase()
      .replace(/\bexceptionally\s+high\b/g, "ex-high")
      .replace(/\bex[_\s-]*high\b/g, "ex-high")
      .replace(/\bvery\s+high\b/g, "very-high")
      .replace(/[\s_]+/g, "-");
    const palette = {
      // PMD Monitor warning colour names
      red:          "background:#dc2626;color:#ffffff",
      orange:       "background:#f97316;color:#ffffff",
      yellow:       "background:#eab308;color:#1a1a1a",
      blue:         "background:#3b82f6;color:#ffffff",
      gust:         "background:#7c3aed;color:#ffffff",
      thunderstorm: "background:#7c3aed;color:#ffffff",
      // FFD flood classification
      normal:       "background:#16a34a;color:#ffffff",
      low:          "background:#0891b2;color:#ffffff",
      medium:       "background:#eab308;color:#1a1a1a",
      high:         "background:#f97316;color:#ffffff",
      "very-high":  "background:#dc2626;color:#ffffff",
      "ex-high":    "background:#6f42c1;color:#ffffff",
      // GLOF alert-label ladder
      watch:        "background:#facc15;color:#1a1a1a",
      warning:      "background:#f97316;color:#ffffff",
      emergency:    "background:#dc2626;color:#ffffff",
      // Connectivity states (neutral)
      ok:            "background:#e2e8f0;color:#0f172a",
      offline:       "background:#94a3b8;color:#ffffff",
      "sensor-fault":"background:#f59e0b;color:#1a1a1a",
    };
    return palette[v] || "";
  }

  // Wrap a table in a scrollable container with a sticky header so the
  // exported HTML has one scrollbar per section rather than one giant
  // document scroll.  `maxHeight` caps the visible viewport per table;
  // rows beyond it scroll inside their own frame.
  #reportScrollWrap(tableHtml, maxHeight = 420) {
    return `
      <div class="scroll-wrap" style="max-height:${maxHeight}px;overflow:auto;border:1px solid var(--line);border-radius:4px;margin:8px 0;background:var(--paper)">
        ${tableHtml}
      </div>
    `;
  }

  // Detect whether a column looks like a "chip"-styled severity /
  // status / alert field so we can apply the coloured pill even when
  // the cell comes from a source that didn't declare a chip in cfg.
  #reportLooksLikeChipField(label) {
    return /^(level|status|alert|alert_label|connectivity|state|severity)$/i.test(
      String(label).replace(/\s+/g, "_"));
  }

  // Inline-style palette mirroring the panel's threshold classes
  // (see _weather-report.css .wrp-pmd-x-*).  Colours are tuned for a
  // WHITE background — the HTML export is a standalone doc, so it
  // can't share the dark-theme stylesheet.  Returned string is a
  // partial CSS declaration list ready to drop into a `style=""`.
  #reportThresholdStyle(cls) {
    switch (cls) {
      case "wrp-pmd-x-extreme-hot": return "background:#7f1d1d;color:#ffffff;font-weight:700";
      case "wrp-pmd-x-very-hot":    return "background:#dc2626;color:#ffffff;font-weight:700";
      case "wrp-pmd-x-hot":         return "background:#f97316;color:#ffffff;font-weight:600";
      case "wrp-pmd-x-cold":        return "background:#93c5fd;color:#111827;font-weight:600";
      case "wrp-pmd-x-freezing":    return "background:#3b82f6;color:#ffffff;font-weight:700";
      case "wrp-pmd-x-humid":       return "background:#67e8f9;color:#111827;font-weight:600";
      case "wrp-pmd-x-dry":         return "background:#fde68a;color:#111827;font-weight:600";
      case "wrp-pmd-x-strong-wind": return "background:#a78bfa;color:#ffffff;font-weight:700";
      case "wrp-pmd-x-mod-wind":    return "background:#c4b5fd;color:#111827";
      case "wrp-pmd-x-heavy-rain":  return "background:#06b6d4;color:#ffffff;font-weight:700";
      case "wrp-pmd-x-mod-rain":    return "background:#67e8f9;color:#111827";
      default: return "";
    }
  }

  // ============================================================
  // Full-fledged NCOP-themed Situational Report (HTML export)
  // ------------------------------------------------------------
  // Consumes:
  //   - Every cached endpoint in #pmdRawData (Weekly Outlook, NWFC
  //     Forecast, FFD Bulletins, Rainfall Reports, Press Releases,
  //     Max Temp records, PMD Public Forecast).
  //   - Every currently-toggled tracked layer (§7 of the API doc —
  //     FFD waterlevels / rivers, PMD Monitor stations / warnings /
  //     monsoon / GLOF / lightning / city forecast / glacier lakes,
  //     NWFC observations) read straight off the map so the report
  //     mirrors the operator's live situational picture.
  //
  // For every section the report also generates a small analytical
  // block: HOTSPOTS (what stands out), WHAT THIS MEANS (interpretation),
  // FORECAST IMPLICATIONS (what to watch), and MITIGATION guidance
  // (documented NDMA / PMD / IMD protocols keyed to the hazard).
  // ============================================================
  #buildHtmlReport() {
    const raw = this.#pmdRawData || {};
    const esc = (v) => escapeHtml(v ?? "");
    const generated = new Date();
    const genIso = generated.toISOString();
    const genPretty = generated.toLocaleString("en-GB", {
      dateStyle: "full", timeStyle: "medium",
    });
    const parts = [];
    const sections = [];  // TOC entries
    const addSection = (id, title, iconChar, contentHtml) => {
      sections.push({ id, title });
      parts.push(`
        <section id="${id}" class="report-section">
          <h2><span class="section-icon">${iconChar}</span> ${esc(title)}</h2>
          ${contentHtml || `<p class="empty">No data available for this section.</p>`}
        </section>
      `);
    };

    // ---- NCOP-themed head + cover -----------------------------------
    parts.push(`<!DOCTYPE html><html lang="en"><head>
      <meta charset="utf-8">
      <title>NCOP Situational Report — ${esc(genIso.slice(0, 10))}</title>
      <style>
        :root {
          --ncop-navy: #0b1e3f;
          --ncop-navy-2: #14294d;
          --ncop-blue: #1e40af;
          --ncop-accent: #0891b2;
          --ncop-cyan: #06b6d4;
          --ncop-teal: #14b8a6;
          --ink: #0f172a;
          --ink-2: #1e293b;
          --muted: #64748b;
          --line: #e2e8f0;
          --paper: #ffffff;
          --paper-alt: #f8fafc;
          --warn: #dc2626;
          --caution: #f97316;
          --advisory: #eab308;
          --safe: #16a34a;
        }
        * { box-sizing: border-box; }
        body {
          font-family: 'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif;
          margin: 0; padding: 0; background: var(--paper-alt); color: var(--ink);
          line-height: 1.55;
        }
        .container { max-width: 960px; margin: 0 auto; padding: 32px 40px 60px; background: var(--paper); }
        /* Cover */
        .cover {
          margin: -32px -40px 32px;
          padding: 44px 40px 34px;
          background: linear-gradient(135deg, var(--ncop-navy) 0%, var(--ncop-blue) 55%, var(--ncop-accent) 100%);
          color: white;
          border-bottom: 4px solid var(--ncop-cyan);
        }
        .cover .brand {
          display: inline-block;
          font-size: 10px; font-weight: 800; letter-spacing: 4px;
          padding: 5px 12px; background: rgba(255,255,255,0.14);
          border-radius: 3px; margin-bottom: 12px;
        }
        .cover h1 { margin: 4px 0 6px; font-size: 30px; font-weight: 700; letter-spacing: 0.2px; }
        .cover .sub { font-size: 14px; opacity: 0.85; margin-bottom: 22px; }
        .cover .meta-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 12px; font-size: 12px;
          padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.18);
        }
        .cover .meta-grid strong { display: block; font-size: 10px; opacity: 0.7; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 2px; }
        .classification { display:inline-block; margin-top:10px; padding: 3px 10px; border: 1px solid rgba(255,255,255,0.35); font-size: 11px; letter-spacing: 1px; text-transform: uppercase; }
        /* Executive summary */
        .exec {
          margin: 18px 0 26px;
          padding: 18px 20px;
          background: linear-gradient(135deg, #eef2ff, #f0fdfa);
          border: 1px solid var(--line);
          border-left: 4px solid var(--ncop-accent);
          border-radius: 6px;
        }
        .exec h3 { margin: 0 0 6px; font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--ncop-blue); }
        .exec .stat-strip { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
        .exec .stat { padding: 10px 14px; background: var(--paper); border: 1px solid var(--line); border-radius: 5px; min-width: 130px; }
        .exec .stat-value { font-size: 22px; font-weight: 700; color: var(--ncop-navy); }
        .exec .stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--muted); }
        /* TOC */
        .toc { margin: 22px 0 26px; padding: 14px 18px; background: var(--paper-alt); border-left: 4px solid var(--ncop-teal); border-radius: 4px; }
        .toc h3 { margin: 0 0 6px; font-size: 12px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--ncop-blue); }
        .toc ol { margin: 0; padding-left: 20px; font-size: 13px; column-count: 2; column-gap: 24px; }
        .toc li { margin: 3px 0; break-inside: avoid; }
        .toc a { color: var(--ncop-blue); text-decoration: none; }
        .toc a:hover { text-decoration: underline; }
        /* Section */
        .report-section { margin: 32px 0; }
        h2 { margin: 0 0 12px; padding: 8px 14px; background: var(--paper-alt); border-left: 5px solid var(--ncop-accent); color: var(--ncop-navy); font-size: 18px; font-weight: 700; }
        .section-icon { display: inline-block; margin-right: 6px; font-size: 16px; vertical-align: -2px; }
        /* Tables */
        table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12px; }
        th, td { border: 1px solid var(--line); padding: 6px 9px; text-align: left; vertical-align: top; }
        th { background: var(--ncop-navy); color: white; font-weight: 700; letter-spacing: 0.3px; font-size: 11px; text-transform: uppercase; }
        tr:nth-child(even) td { background: var(--paper-alt); }
        /* Per-section scroll containers — sticky header stays pinned as
           rows scroll underneath.  Solid navy background on the header
           cells is essential so scrolling rows don't bleed through the
           translucent cell edges. */
        .scroll-wrap { background: var(--paper); }
        .scroll-wrap table thead th {
          background: var(--ncop-navy) !important;
          box-shadow: 0 1px 0 rgba(0,0,0,0.15);
        }
        .scroll-wrap::-webkit-scrollbar { width: 10px; height: 10px; }
        .scroll-wrap::-webkit-scrollbar-thumb { background: #94a3b8; border-radius: 5px; border: 2px solid var(--paper-alt); }
        .scroll-wrap::-webkit-scrollbar-thumb:hover { background: #64748b; }
        .scroll-wrap::-webkit-scrollbar-track { background: var(--paper-alt); }
        code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; background: #eef2ff; padding: 1px 5px; border-radius: 3px; color: var(--ncop-blue); }
        .empty { color: var(--muted); font-style: italic; }
        /* Analysis block */
        .analysis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 14px 0 4px; }
        .analysis-card { padding: 12px 14px; border: 1px solid var(--line); border-left: 4px solid var(--ncop-teal); background: var(--paper-alt); border-radius: 4px; }
        .analysis-card.hotspot { border-left-color: var(--warn); background: #fef2f2; }
        .analysis-card.meaning { border-left-color: var(--ncop-blue); }
        .analysis-card.forecast { border-left-color: var(--caution); background: #fff7ed; }
        .analysis-card.mitigation { border-left-color: var(--safe); background: #f0fdf4; }
        .analysis-card h4 { margin: 0 0 6px; font-size: 10.5px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--ink-2); }
        .analysis-card ul { margin: 4px 0 0; padding-left: 18px; font-size: 12px; }
        .analysis-card p { margin: 4px 0; font-size: 12px; }
        /* Layer badges */
        .layer-badge { display: inline-block; padding: 2px 8px; font-size: 10px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: white; border-radius: 3px; margin-right: 6px; }
        .layer-badge.ffd { background: #16a34a; }
        .layer-badge.pmd { background: var(--ncop-blue); }
        .layer-badge.nwfc { background: var(--ncop-cyan); color: white; }
        /* Recommendations */
        .rec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
        .rec { padding: 12px 14px; border-radius: 5px; background: var(--paper); border: 1px solid var(--line); border-top: 3px solid var(--ncop-accent); }
        .rec h4 { margin: 0 0 6px; font-size: 13px; color: var(--ncop-navy); }
        .rec ul { margin: 4px 0 0; padding-left: 18px; font-size: 11.5px; color: var(--ink-2); }
        /* Footer */
        .footer { margin-top: 44px; padding: 18px 20px; background: var(--ncop-navy); color: rgba(255,255,255,0.85); font-size: 11px; border-radius: 4px; }
        .footer .cite { color: rgba(255,255,255,0.6); font-family: 'JetBrains Mono', monospace; }
        @media print {
          body { background: white; }
          .container { max-width: none; padding: 20px 24px; }
          .cover { margin: -20px -24px 24px; }
          h2 { page-break-after: avoid; }
          .report-section { page-break-inside: avoid; }
          .analysis { page-break-inside: avoid; }
        }
      </style>
    </head><body><div class="container">`);

    // ---- Cover ------------------------------------------------------
    parts.push(`
      <div class="cover">
        <div class="brand">NCOP · NDMA</div>
        <h1>Pakistan Meteorological Situational Report</h1>
        <div class="sub">Consolidated feeds from PMD Monitor, PMD NWFC, and FFD (per GCOP integration §7)</div>
        <div class="meta-grid">
          <div><strong>Generated</strong>${esc(genPretty)}</div>
          <div><strong>ISO Timestamp</strong>${esc(genIso)}</div>
          <div><strong>Prepared By</strong>NCOP Weather Report · Operator Console</div>
        </div>
        <div class="classification">Restricted operational use — verify before dispatch</div>
      </div>
    `);

    // ---- Executive Summary + hotspot rollup -------------------------
    const summary = this.#reportComputeSummary(raw);
    parts.push(`
      <div class="exec">
        <h3>Executive Summary</h3>
        <p>${summary.narrative}</p>
        <div class="stat-strip">
          <div class="stat"><div class="stat-value">${summary.activeLayers}</div><div class="stat-label">Live Layers</div></div>
          <div class="stat"><div class="stat-value">${summary.forecastHotCount}</div><div class="stat-label">Cities ≥40 °C Forecast</div></div>
          <div class="stat"><div class="stat-value">${summary.warningCount}</div><div class="stat-label">Active Warnings</div></div>
          <div class="stat"><div class="stat-value">${summary.glofAlerts}</div><div class="stat-label">GLOF Alerts</div></div>
          <div class="stat"><div class="stat-value">${summary.recordExtremes}</div><div class="stat-label">Records ≥45 °C</div></div>
        </div>
      </div>
    `);

    // TOC placeholder — filled after all sections are declared.
    const tocIdx = parts.length;
    parts.push("__TOC__");

    // ---- 1. Active Layers Snapshot ----------------------------------
    const activeSnap = this.#reportActiveLayerSnapshot();
    if (activeSnap.length) {
      const blocks = activeSnap.map((s) => this.#reportRenderActiveLayerBlock(s)).join("");
      addSection("active-layers", "Active Data Layers Snapshot", "🛰️",
        `<p style="font-size:12px;color:${"var(--muted)"};margin:0 0 12px">
           Currently-toggled operator layers, sampled at report generation time.
           Feature counts and hotspots reflect the live map state.
         </p>${blocks}`);
    } else {
      addSection("active-layers", "Active Data Layers Snapshot", "🛰️",
        `<p class="empty">No PMD Monitor / FFD / NWFC layers are currently toggled on the operator map. Toggle any tracked layer to include its live snapshot in the report.</p>`);
    }

    // ---- 2. NWFC Weekly Outlook -------------------------------------
    const outlookDays = Array.isArray(raw.outlook?.days) ? raw.outlook.days : [];
    if (outlookDays.length) {
      const rows = outlookDays.map((d) => `
        <tr>
          <td style="width:190px;white-space:nowrap"><b>${esc(this.#reportFormatValue(d?.date))}</b></td>
          <td>${esc(this.#reportFormatValue(d?.outlook))}</td>
        </tr>
      `).join("");
      const analysis = this.#reportAnalyseOutlook(outlookDays);
      const table = `<table style="margin:0"><thead style="position:sticky;top:0;z-index:1"><tr><th>Date</th><th>Outlook</th></tr></thead><tbody>${rows}</tbody></table>`;
      addSection("outlook", "Weekly Outlook", "📅",
        `${this.#reportScrollWrap(table, 380)}
         ${this.#reportAnalysisBlock(analysis)}`);
    } else {
      addSection("outlook", "Weekly Outlook", "📅", "");
    }

    // ---- 3. NWFC Daily Forecast -------------------------------------
    const nwfcCities = this.#extractItemArray(raw.nwfcFc, ["cities", "forecast", "items", "data", "stations", "records", "results"]);
    if (nwfcCities.length) {
      const forecastHtml = this.#reportBuildForecastTable(nwfcCities);
      const analysis = this.#reportAnalyseForecast(nwfcCities);
      addSection("nwfc-fc", "NWFC Daily Forecast", "🌤️",
        `${forecastHtml}${this.#reportAnalysisBlock(analysis)}`);
    } else {
      addSection("nwfc-fc", "NWFC Daily Forecast", "🌤️", "");
    }

    // ---- 4. Historical Record Max Temperatures ----------------------
    let mtSource = this.#extractItemArray(raw.maxTemps, ["items", "data", "stations", "records", "results", "max_temperatures", "max_temps", "list", "rows"]);
    if (!mtSource.length) mtSource = this.#deepFindItemArray(raw.maxTemps);
    if (mtSource.length) {
      const mtHtml = this.#reportBuildMaxTempsTable(mtSource);
      const analysis = this.#reportAnalyseMaxTemps(mtSource);
      addSection("maxtemps", "Historical Record Max Temperatures", "🌡️",
        `${mtHtml}${this.#reportAnalysisBlock(analysis)}`);
    } else {
      addSection("maxtemps", "Historical Record Max Temperatures", "🌡️", "");
    }

    // ---- 5. FFD Bulletins -------------------------------------------
    const bulletins = Array.isArray(raw.bulletins?.items) ? raw.bulletins.items : [];
    if (bulletins.length) {
      const rows = bulletins.map((b) => `<tr>
        <td><span class="layer-badge ffd">${esc(this.#reportFormatValue(b?.kind) || "PDF")}</span></td>
        <td>${esc(this.#reportFormatValue(b?.title))}</td>
        <td>${esc(this.#reportFormatValue(b?.issued))}</td>
        <td><a href="${esc(this.#reportFormatValue(b?.download_url))}">Open PDF</a></td>
      </tr>`).join("");
      const table = `<table style="margin:0"><thead style="position:sticky;top:0;z-index:1"><tr><th>Kind</th><th>Title</th><th>Issued</th><th>Link</th></tr></thead><tbody>${rows}</tbody></table>`;
      addSection("bulletins", "FFD Bulletins", "📄",
        `${this.#reportScrollWrap(table, 380)}
         <p style="font-size:11.5px;color:var(--muted);margin-top:8px">Source: <code>/get-ffd-bulletins/</code> · Flood Forecasting Division · ffd.pmd.gov.pk · showing all ${bulletins.length} items.</p>`);
    } else {
      addSection("bulletins", "FFD Bulletins", "📄", "");
    }

    // ---- 6. Reports split (Rainfall + Press) ------------------------
    const splitReports = this.#splitReportItems(raw.reports);
    const renderLinkTable = (rows, badgeClass) => {
      const trs = rows.map((r) => `<tr>
        <td><span class="layer-badge ${badgeClass}">PDF</span></td>
        <td>${esc(this.#reportFormatValue(r?.title ?? r?.name))}</td>
        <td>${esc(this.#reportFormatValue(r?.issued ?? r?.date))}</td>
        <td><a href="${esc(this.#reportFormatValue(r?.url ?? r?.download_url))}">Open PDF</a></td>
      </tr>`).join("");
      return `<table style="margin:0"><thead style="position:sticky;top:0;z-index:1"><tr><th>Type</th><th>Title</th><th>Date</th><th>Link</th></tr></thead><tbody>${trs}</tbody></table>`;
    };
    if (splitReports.rainfall.length) {
      addSection("rainfall", "NWFC Daily Rainfall Reports", "🌧️",
        `${this.#reportScrollWrap(renderLinkTable(splitReports.rainfall, "nwfc"), 380)}
         <p style="font-size:11.5px;color:var(--muted);margin-top:8px">Source: <code>/api/pmd/nwfc/reports/</code> filtered to Daily Rainfall · weather.gov.pk · showing all ${splitReports.rainfall.length} items.</p>`);
    } else {
      addSection("rainfall", "NWFC Daily Rainfall Reports", "🌧️", "");
    }
    if (splitReports.press.length) {
      addSection("press", "NWFC Press Releases", "📣",
        `${this.#reportScrollWrap(renderLinkTable(splitReports.press, "nwfc"), 380)}
         <p style="font-size:11.5px;color:var(--muted);margin-top:8px">Source: <code>/api/pmd/nwfc/reports/</code> filtered to Press Release · weather.gov.pk · showing all ${splitReports.press.length} items.</p>`);
    } else {
      addSection("press", "NWFC Press Releases", "📣", "");
    }

    // ---- 7. PMD Public Forecast -------------------------------------
    const publicFcDaily = Array.isArray(raw.publicFc?.daily) ? raw.publicFc.daily : null;
    if (publicFcDaily && publicFcDaily.length) {
      const rows = publicFcDaily.map((d) => `<tr>
        <td><b>${esc(this.#reportFormatValue(d?.today_date))}</b></td>
        <td>${esc(this.#reportFormatValue(d?.today_forecast_eng))}</td>
        <td><b>${esc(this.#reportFormatValue(d?.tomorrow_date))}</b></td>
        <td>${esc(this.#reportFormatValue(d?.tomorrow_forecast_eng))}</td>
      </tr>`).join("");
      const table = `<table style="margin:0"><thead style="position:sticky;top:0;z-index:1"><tr><th>Today (Date)</th><th>Today Forecast</th><th>Tomorrow (Date)</th><th>Tomorrow Forecast</th></tr></thead><tbody>${rows}</tbody></table>`;
      addSection("public-fc", "PMD Public Forecast", "🌥️",
        `${this.#reportScrollWrap(table, 380)}
         <p style="font-size:11.5px;color:var(--muted);margin-top:8px">Source: <code>/api/pmd/public-forecast/</code> · pmd.gov.pk</p>`);
    } else {
      addSection("public-fc", "PMD Public Forecast", "🌥️", "");
    }

    // ---- 8. Recommendations & Mitigation ----------------------------
    parts.push(`
      <section id="mitigation" class="report-section">
        <h2><span class="section-icon">🛡️</span> Recommendations & Mitigation Guidelines</h2>
        <p style="font-size:12px;color:var(--muted);margin:0 0 12px">
          Guidance below is drawn from published NDMA / PMD / IMD protocols and is not a substitute for
          on-scene professional judgement. Confirm before dispatch.
        </p>
        <div class="rec-grid">
          ${this.#reportMitigationCards(summary)}
        </div>
      </section>
    `);
    sections.push({ id: "mitigation", title: "Recommendations & Mitigation" });

    // ---- TOC (fill placeholder) -------------------------------------
    const tocHtml = `
      <div class="toc">
        <h3>Contents</h3>
        <ol>${sections.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join("")}</ol>
      </div>
    `;
    parts[tocIdx] = tocHtml;

    // ---- Footer ------------------------------------------------------
    parts.push(`
      <div class="footer">
        <div><strong>Classification:</strong> Restricted operational use — verify before dispatch.</div>
        <div style="margin-top:6px">Generated by NCOP · National Common Operating Picture · NDMA.</div>
        <div class="cite" style="margin-top:6px">
          Source endpoints per <em>GCOP_PMD_API_Integration.md §7</em>:
          get-ffd-waterlevels · get-ffd-rivers · get-ffd-bulletins ·
          /api/pmd/monitor/stations · warnings · monsoon · glof-obs · lightning · city-forecast · glacier-lakes ·
          /api/pmd/public-forecast ·
          /api/pmd/nwfc/observations · forecast · reports · weekly-outlook · max-temperatures.
        </div>
      </div>
    `);
    parts.push(`</div></body></html>`);
    return parts.join("");
  }

  // ---- Report subroutines --------------------------------------------

  // Snapshot every currently-toggled tracked layer for the report.
  // Returns [{ key, label, cfg, features, tag }] where tag is "ffd" /
  // "pmd" / "nwfc" so downstream renderers can colour-code badges.
  #reportActiveLayerSnapshot() {
    const out = [];
    for (const [key, cfg] of Object.entries(PMD_TAB_TRACKED_LAYERS)) {
      if (!this.#isTrackedKeyActive(key, cfg)) continue;
      const features = this.#extractFeatures(cfg.sourceId);
      const tag = key.startsWith("ffd_") ? "ffd"
                : key.startsWith("nwfc_") ? "nwfc"
                : "pmd";
      out.push({ key, label: cfg.label, cfg, features, tag });
    }
    return out;
  }

  #reportRenderActiveLayerBlock(snap) {
    const { key, label, cfg, features, tag } = snap;
    const count = features.length;
    const analysis = this.#reportAnalyseLayer(key, cfg, features);
    // Show ALL features + ALL properties inside a per-section scroll
    // container.  No slice, no column cap — the report is the artefact
    // the operator escalates upward, so completeness matters.
    const table = features.length
      ? this.#reportScrollWrap(this.#reportBuildGenericLayerTable(cfg, features), 460)
      : `<p class="empty">Source has no features at report time.</p>`;
    return `
      <div style="margin:16px 0 22px;padding:16px 18px;background:var(--paper);border:1px solid var(--line);border-radius:6px">
        <h3 style="margin:0 0 6px;font-size:14px;color:var(--ncop-navy)">
          <span class="layer-badge ${tag}">${tag.toUpperCase()}</span>
          ${escapeHtml(label)}
          <span style="float:right;font-size:11px;color:var(--muted);font-weight:400">${count} feature${count === 1 ? "" : "s"}</span>
        </h3>
        <p style="font-size:11px;color:var(--muted);margin:0 0 8px">
          Source: <code>${escapeHtml(cfg.sourceId)}</code> · showing all ${count} feature${count === 1 ? "" : "s"} — scroll within table for the full set.
        </p>
        ${table}
        ${this.#reportAnalysisBlock(analysis)}
      </div>
    `;
  }

  // Show ALL features + ALL properties, not just the configured column
  // set — the report is the analytical artefact, not a compact panel
  // widget.  The configured columns from cfg.columns come first (so the
  // operator's mental model of the layer is preserved), then any
  // remaining properties fill out the row.  Cells run through the same
  // threshold-class + chip-style palette so the report reads as one
  // system with the panel.
  #reportBuildGenericLayerTable(cfg, features) {
    if (!features.length) return "";

    // Union of every property key present on any feature.
    const allFields = new Set();
    for (const f of features) {
      if (f?.properties && typeof f.properties === "object") {
        for (const k of Object.keys(f.properties)) allFields.add(k);
      }
    }

    // Configured columns first (preserve operator-facing order + labels),
    // then any remaining properties as extra columns.  Skip obvious
    // internal identifiers.
    const cols = [];
    const usedKeys = new Set();
    for (const c of cfg.columns || []) {
      const key = allFields.has(c.key) ? c.key
                : (c.fallback && allFields.has(c.fallback) ? c.fallback : null);
      if (!key) continue;
      cols.push({ ...c, key });
      usedKeys.add(key);
    }
    for (const k of allFields) {
      if (usedKeys.has(k)) continue;
      if (/^(id|pk|_.+)$/i.test(k)) continue;
      cols.push({ key: k, label: this.#prettyLabel(k) });
      usedKeys.add(k);
    }
    if (!cols.length) return "";

    const headers = cols
      .map((c) => `<th>${escapeHtml(c.label)}</th>`)
      .join("");
    const rows = features.map((f) => {
      const p = f?.properties || {};
      const cells = cols.map((col) => {
        const raw = this.#firstDefined(p, col.key, col.fallback);
        const text = this.#reportFormatValue(raw);

        // Chip render — applied when the column is explicitly a
        // level/status/alert chip OR when the column NAME looks like
        // one (defensive so passthrough sources with `level` /
        // `status` / `alert_label` fields still get coloured).
        const isChip = col.chip === "level" || col.chip === "status" || col.chip === "alert"
                    || this.#reportLooksLikeChipField(col.label);
        if (isChip) {
          const chip = this.#reportChipStyle(text);
          if (chip) {
            return `<td><span style="${chip};padding:2px 8px;border-radius:3px;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.4px">${escapeHtml(text)}</span></td>`;
          }
        }

        // Threshold-coloured background for numeric fields (temp,
        // humidity, wind, rain) — same ladder as the panel.
        const cls = this.#thresholdClass(this.#parseTempRange(raw), col.label);
        const style = this.#reportThresholdStyle(cls);
        return `<td${style ? ` style="${style}"` : ""}>${escapeHtml(text)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("");

    return `<table style="margin:0"><thead style="position:sticky;top:0;z-index:1"><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  // Build the daily forecast HTML fragment (table + threshold legend)
  // for the exported doc — same visual language as the panel version.
  #reportBuildForecastTable(nwfcCities) {
    const { cols, nameKeys } = this.#discoverForecastColumns(nwfcCities);
    if (!cols.length) return `<p class="empty">Response has no discoverable columns.</p>`;
    const tempCol = cols.find((x) => /max|temp|°c/i.test(x.label)) || null;
    const wxCol   = cols.find((x) => /weather|wx|condition/i.test(x.label)) || null;
    const isDayCol = (label) => /monday|tuesday|wednesday|thursday|friday|saturday|sunday/i.test(String(label));

    const headers = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    const rows = nwfcCities.map((c) => {
      if (!c || typeof c !== "object") return "";
      const nameKey = nameKeys.find((k) => c[k] != null && c[k] !== "");
      const name = nameKey ? c[nameKey] : "";
      const wxRaw = wxCol ? c[wxCol.key] : null;
      const tempRaw = tempCol ? c[tempCol.key] : null;
      const wxStr = this.#extractWeather(wxRaw) || this.#extractWeather(tempRaw);
      const tempVal = this.#parseTempRange(tempRaw);
      const emoji = this.#weatherEmoji(wxStr) || this.#tempEmoji(tempVal);
      const cells = cols.map((col) => {
        const raw = c[col.key];
        const text = this.#reportFormatValue(raw);
        const cls = this.#thresholdClass(this.#parseTempRange(raw), col.label);
        const style = this.#reportThresholdStyle(cls);
        let dayEmoji = "";
        if (isDayCol(col.label)) {
          const dayWx = this.#extractWeather(raw);
          dayEmoji = this.#weatherEmoji(dayWx) || this.#tempEmoji(this.#parseTempRange(raw));
        }
        const emojiHtml = dayEmoji ? `<span style="margin-right:4px">${dayEmoji}</span>` : "";
        return `<td${style ? ` style="${style}"` : ""}>${emojiHtml}${escapeHtml(text)}</td>`;
      }).join("");
      return `<tr>
        <td><span style="margin-right:6px;font-size:1.15em">${emoji}</span><b>${escapeHtml(String(name))}</b></td>
        ${cells}
      </tr>`;
    }).filter(Boolean).join("");

    const legend = `
      <div style="margin-top:8px;font-size:11px;color:var(--muted)">
        <b>Thresholds:</b>
        <span style="${this.#reportThresholdStyle("wrp-pmd-x-extreme-hot")};padding:2px 6px;border-radius:3px;margin-left:4px">≥45°</span>
        <span style="${this.#reportThresholdStyle("wrp-pmd-x-very-hot")};padding:2px 6px;border-radius:3px;margin-left:2px">≥40°</span>
        <span style="${this.#reportThresholdStyle("wrp-pmd-x-hot")};padding:2px 6px;border-radius:3px;margin-left:2px">≥35°</span>
        <span style="${this.#reportThresholdStyle("wrp-pmd-x-humid")};padding:2px 6px;border-radius:3px;margin-left:2px">RH ≥90%</span>
        <span style="${this.#reportThresholdStyle("wrp-pmd-x-dry")};padding:2px 6px;border-radius:3px;margin-left:2px">RH ≤20%</span>
      </div>
    `;
    const table = `<table style="margin:0"><thead style="position:sticky;top:0;z-index:1"><tr><th>City</th>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    return `${this.#reportScrollWrap(table, 460)}${legend}
      <p style="font-size:11.5px;color:var(--muted);margin-top:8px">Source: <code>/api/pmd/nwfc/forecast/</code> · weather.gov.pk · showing all ${nwfcCities.length} cities.</p>`;
  }

  // Build the max-temperatures HTML fragment for the exported doc.
  #reportBuildMaxTempsTable(mtSource) {
    const { cols, nameKeys } = this.#discoverMaxTempsColumns(mtSource);
    if (!cols.length) return `<p class="empty">Response has no discoverable columns.</p>`;
    const tempCol = cols.find((x) => /max|temp|°c|record/i.test(x.label)) || null;
    let ranked = mtSource;
    if (tempCol) {
      ranked = [...mtSource].sort((a, b) => {
        const av = this.#parseTempRange(a?.[tempCol.key]);
        const bv = this.#parseTempRange(b?.[tempCol.key]);
        if (!Number.isFinite(bv)) return -1;
        if (!Number.isFinite(av)) return 1;
        return bv - av;
      });
    }
    const headers = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    const rows = ranked.map((r) => {
      if (!r || typeof r !== "object") return "";
      const nameKey = nameKeys.find((k) => r[k] != null && r[k] !== "");
      const name = nameKey ? this.#unwrapValue(r[nameKey]) ?? r[nameKey] : "";
      const tempRaw = tempCol ? r[tempCol.key] : null;
      const emoji = this.#tempEmoji(this.#parseTempRange(tempRaw));
      const cells = cols.map((col) => {
        const raw = r[col.key];
        const text = this.#reportFormatValue(raw);
        const cls = this.#thresholdClass(this.#parseTempRange(raw), col.label);
        const style = this.#reportThresholdStyle(cls);
        return `<td${style ? ` style="${style}"` : ""}>${escapeHtml(text)}</td>`;
      }).join("");
      return `<tr>
        <td><span style="margin-right:6px;font-size:1.15em">${emoji}</span><b>${escapeHtml(String(name))}</b></td>
        ${cells}
      </tr>`;
    }).filter(Boolean).join("");
    const table = `<table style="margin:0"><thead style="position:sticky;top:0;z-index:1"><tr><th>Station</th>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    return `${this.#reportScrollWrap(table, 460)}
      <p style="font-size:11.5px;color:var(--muted);margin-top:8px">Source: <code>/api/pmd/nwfc/max-temperatures/</code> · weather.gov.pk · showing all ${ranked.length} records.</p>`;
  }

  // ---- Analysis engines ----------------------------------------------

  // Executive-summary rollup — sums across every dataset for the
  // stat strip at the top of the report.
  #reportComputeSummary(raw) {
    const snap = this.#reportActiveLayerSnapshot();
    const activeLayers = snap.length;

    // Forecast: how many cities have Max Temp ≥ 40 °C?
    let forecastHotCount = 0;
    const cities = this.#extractItemArray(raw.nwfcFc, ["cities", "forecast", "items", "data", "stations", "records", "results"]);
    if (cities.length) {
      const { cols } = this.#discoverForecastColumns(cities);
      const tempCol = cols.find((x) => /max|temp|°c/i.test(x.label));
      if (tempCol) {
        for (const c of cities) {
          const v = this.#parseTempRange(c?.[tempCol.key]);
          if (Number.isFinite(v) && v >= T.STATION_TEMP_HOT) forecastHotCount++;
        }
      }
    }
    // Warnings on the map
    const wSnap = snap.find((s) => s.key === "pmd_warnings");
    const warningCount = wSnap ? wSnap.features.length : 0;
    // GLOF alerts
    const gSnap = snap.find((s) => s.key === "pmd_glof_obs");
    let glofAlerts = 0;
    if (gSnap) {
      for (const f of gSnap.features) {
        const lvl = Number(f?.properties?.alert_level);
        if (Number.isFinite(lvl) && lvl >= 20) glofAlerts++;
      }
    }
    // Historical records above 45 °C
    let mtSource = this.#extractItemArray(raw.maxTemps, ["items", "data", "stations", "records", "results", "max_temperatures", "max_temps", "list", "rows"]);
    if (!mtSource.length) mtSource = this.#deepFindItemArray(raw.maxTemps);
    let recordExtremes = 0;
    for (const r of mtSource) {
      const { cols } = this.#discoverMaxTempsColumns([r]);
      const tempCol = cols.find((x) => /max|temp|°c|record/i.test(x.label));
      if (tempCol) {
        const v = this.#parseTempRange(r?.[tempCol.key]);
        if (Number.isFinite(v) && v >= 45) recordExtremes++;
      }
    }
    // Narrative — pieces the numbers together into a paragraph.
    const bits = [];
    if (activeLayers > 0) bits.push(`${activeLayers} operator layer${activeLayers === 1 ? "" : "s"} live on the map`);
    if (forecastHotCount > 0) bits.push(`${forecastHotCount} city forecast${forecastHotCount === 1 ? "" : "s"} at or above the ${T.STATION_TEMP_HOT} °C heat-advisory threshold`);
    if (warningCount > 0) bits.push(`${warningCount} active PMD warning zone${warningCount === 1 ? "" : "s"}`);
    if (glofAlerts > 0) bits.push(`${glofAlerts} GLOF station${glofAlerts === 1 ? "" : "s"} at or above Watch`);
    if (recordExtremes > 0) bits.push(`${recordExtremes} historical record${recordExtremes === 1 ? "" : "s"} at 45 °C or above in scope`);
    const narrative = bits.length
      ? `Situational summary at report time: ${bits.join("; ")}.`
      : `No hazard-threshold indicators surfaced in current data. Continue routine monitoring.`;
    return {
      activeLayers, forecastHotCount, warningCount, glofAlerts, recordExtremes, narrative,
    };
  }

  #reportAnalyseForecast(cities) {
    const { cols } = this.#discoverForecastColumns(cities);
    const tempCol = cols.find((x) => /max|temp|°c/i.test(x.label));
    const hotspots = [];
    if (tempCol) {
      for (const c of cities) {
        const v = this.#parseTempRange(c?.[tempCol.key]);
        if (!Number.isFinite(v)) continue;
        const name = c?.name ?? c?.city ?? "—";
        if (v >= 45) hotspots.push({ label: `${name} — ${v.toFixed(0)}°C (EXTREME)` });
        else if (v >= 40) hotspots.push({ label: `${name} — ${v.toFixed(0)}°C (Very Hot)` });
        else if (v >= 35) hotspots.push({ label: `${name} — ${v.toFixed(0)}°C (Hot)` });
      }
      hotspots.sort((a, b) => {
        const av = Number(a.label.match(/—\s*(\d+)/)?.[1]) || 0;
        const bv = Number(b.label.match(/—\s*(\d+)/)?.[1]) || 0;
        return bv - av;
      });
    }
    return {
      hotspots: hotspots.slice(0, 8),
      meaning: hotspots.length
        ? `Forecast shows ${hotspots.length} station${hotspots.length === 1 ? "" : "s"} at or above the 35 °C hot threshold. The highest are listed above; anything at or above ${T.STATION_TEMP_HOT} °C triggers PMD's heat advisory ladder.`
        : `Forecast is within normal temperature range across monitored cities. No heat-advisory triggers.`,
      forecast: hotspots.length
        ? `Watch for compounding humidity in the same rows (a Humid ≥ 90% flag combined with ≥ 35 °C markedly raises the effective heat index).`
        : `Continue monitoring — schedule next check-in per operator cadence.`,
      mitigation: hotspots.length
        ? `Coordinate with PMD for confirmatory advisories; pre-position cooling and hydration resources in the flagged districts; brief field teams on heat-illness triage.`
        : `Routine posture: no additional actions required at this time.`,
    };
  }

  #reportAnalyseOutlook(days) {
    // Count hazard keywords across the week's prose.
    const buckets = { rain: 0, thunder: 0, wind: 0, heavy: 0, flood: 0, heat: 0, snow: 0 };
    for (const d of days) {
      const s = String(d?.outlook || "").toLowerCase();
      if (/heavy|very\s+heavy/.test(s)) buckets.heavy++;
      if (/rain|shower/.test(s)) buckets.rain++;
      if (/thunder|lightning/.test(s)) buckets.thunder++;
      if (/wind|gust/.test(s)) buckets.wind++;
      if (/flood/.test(s)) buckets.flood++;
      if (/heatwave|heat wave/.test(s)) buckets.heat++;
      if (/snow/.test(s)) buckets.snow++;
    }
    const hotspots = Object.entries(buckets)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => ({ label: `${k[0].toUpperCase() + k.slice(1)} referenced across ${n} day${n === 1 ? "" : "s"}` }));
    const active = hotspots.length > 0;
    return {
      hotspots,
      meaning: active
        ? `The week's outlook narrative highlights ${hotspots.length} distinct hazard type${hotspots.length === 1 ? "" : "s"}. Frequency reflects PMD's per-day emphasis.`
        : `Outlook narrative does not reference standard hazard categories in this window.`,
      forecast: buckets.heavy > 0
        ? `Heavy or very-heavy modifiers appear on ${buckets.heavy} day${buckets.heavy === 1 ? "" : "s"} — treat as elevated risk periods and align flood / drainage readiness.`
        : `No heavy-modifier language — hazards described are lighter-tier.`,
      mitigation: (buckets.rain + buckets.flood) > 0
        ? `Confirm river-level thresholds against FFD waterlevels feed; verify drainage capacity in low-lying districts; keep evacuation routes reviewed.`
        : (buckets.thunder + buckets.wind > 0
            ? `Advise field teams on lightning-safe posture and secure loose infrastructure ahead of high-wind windows.`
            : `Routine monitoring cadence sufficient.`),
    };
  }

  #reportAnalyseMaxTemps(mtSource) {
    const { cols } = this.#discoverMaxTempsColumns(mtSource);
    const tempCol = cols.find((x) => /max|temp|°c|record/i.test(x.label));
    const nameKey = ["name", "station", "station_name", "city", "location"].find((k) =>
      mtSource.some((r) => r?.[k] != null && r[k] !== ""));
    const hotspots = [];
    if (tempCol && nameKey) {
      for (const r of mtSource) {
        const v = this.#parseTempRange(r?.[tempCol.key]);
        if (!Number.isFinite(v)) continue;
        const name = String(this.#unwrapValue(r[nameKey]) ?? r[nameKey]);
        if (v >= 50) hotspots.push({ label: `${name} — ${v.toFixed(1)}°C (EXTREME HISTORICAL RECORD)` });
        else if (v >= 47) hotspots.push({ label: `${name} — ${v.toFixed(1)}°C (near-country-max)` });
      }
      hotspots.sort((a, b) => {
        const av = Number(a.label.match(/—\s*([\d.]+)/)?.[1]) || 0;
        const bv = Number(b.label.match(/—\s*([\d.]+)/)?.[1]) || 0;
        return bv - av;
      });
    }
    return {
      hotspots: hotspots.slice(0, 8),
      meaning: hotspots.length
        ? `${hotspots.length} station${hotspots.length === 1 ? "" : "s"} carry all-time records at or above 47 °C. These sit on Pakistan's historical extreme-heat envelope.`
        : `No stations with recorded ≥ 47 °C surface in the current dataset.`,
      forecast: hotspots.length
        ? `Compare current NWFC daily forecast for these stations to the record: an approach within 3 °C is a leading indicator for a heat event.`
        : `Historical context for reference only; not a live forecast.`,
      mitigation: hotspots.length
        ? `For districts hosting the flagged stations, verify cooling-centre readiness; coordinate outreach to vulnerable groups; ensure water supply resilience.`
        : `No immediate action from historical records alone.`,
    };
  }

  #reportAnalyseLayer(key, cfg, features) {
    if (!features.length) {
      return {
        hotspots: [],
        meaning: `Layer is active but source currently has no features. Monitor for hydration.`,
        forecast: `No inference from empty feature set.`,
        mitigation: `Reload layer / check backend cache warmth if this is unexpected.`,
      };
    }
    const props = (f) => f?.properties || {};
    switch (key) {
      case "pmd_warnings": {
        const bySeverity = { red: 0, orange: 0, yellow: 0, blue: 0, gust: 0, thunderstorm: 0 };
        for (const f of features) {
          const l = String(props(f).level || "").toLowerCase();
          if (l in bySeverity) bySeverity[l]++;
        }
        const hotspots = Object.entries(bySeverity).filter(([, n]) => n > 0)
          .map(([lvl, n]) => ({ label: `${lvl[0].toUpperCase() + lvl.slice(1)} · ${n} zone${n === 1 ? "" : "s"}` }));
        const hi = bySeverity.red + bySeverity.orange;
        return {
          hotspots,
          meaning: hi > 0
            ? `${hi} high-severity warning zone${hi === 1 ? "" : "s"} (Orange or Red) currently in force.`
            : `Warnings are at Yellow / Blue advisory level — no critical zones.`,
          forecast: `Cross-reference the polygon extents against district populations and infrastructure.`,
          mitigation: hi > 0
            ? `Activate NDMA coordination for the affected districts; brief field commanders on the specific element (rainstorm / heatwave / etc).`
            : `Continue routine posture; escalate if any zone upgrades severity.`,
        };
      }
      case "pmd_weather_stations":
      case "nwfc_observations": {
        // Find the hottest, wettest, windiest stations from live obs.
        let hottest = null, wettest = null;
        for (const f of features) {
          const p = props(f);
          const t = Number(p.temperature); if (Number.isFinite(t) && (!hottest || t > hottest.v)) hottest = { name: p.name || "—", v: t };
          const r = Number(p.rainfall ?? p.rain_24h);
          if (Number.isFinite(r) && (!wettest || r > wettest.v)) wettest = { name: p.name || "—", v: r };
        }
        const hs = [];
        if (hottest) hs.push({ label: `Hottest: ${hottest.name} — ${hottest.v.toFixed(1)}°C` });
        if (wettest && wettest.v > 0) hs.push({ label: `Wettest: ${wettest.name} — ${wettest.v.toFixed(1)} mm (24h)` });
        return {
          hotspots: hs,
          meaning: hottest && hottest.v >= T.STATION_TEMP_HOT
            ? `At least one station is currently reporting at or above the ${T.STATION_TEMP_HOT} °C heat threshold.`
            : `No station currently over the heat-advisory threshold; conditions within normal band.`,
          forecast: `Compare station readings to the NWFC daily forecast section for divergence — a bigger gap suggests forecast bias to investigate.`,
          mitigation: hottest && hottest.v >= T.STATION_TEMP_HOT
            ? `Confirm forecast alignment; pre-position hydration and cooling assets in the flagged district.`
            : `Routine posture; recheck at next update cycle.`,
        };
      }
      case "pmd_glof_obs": {
        const byAlert = { normal: 0, watch: 0, warning: 0, emergency: 0 };
        for (const f of features) {
          const lbl = String(props(f).alert_label || "").toLowerCase();
          if (lbl in byAlert) byAlert[lbl]++;
        }
        const hs = Object.entries(byAlert).filter(([, n]) => n > 0)
          .map(([lvl, n]) => ({ label: `${lvl[0].toUpperCase() + lvl.slice(1)} · ${n} station${n === 1 ? "" : "s"}` }));
        const critical = byAlert.warning + byAlert.emergency;
        return {
          hotspots: hs,
          meaning: critical > 0
            ? `${critical} GLOF station${critical === 1 ? "" : "s"} at Warning or Emergency alert.`
            : `GLOF network in Normal or Watch state — no critical outlets.`,
          forecast: `Correlate with upstream rainfall and glacier-lake area for burst risk.`,
          mitigation: critical > 0
            ? `Notify local administration in the affected valley; verify downstream evacuation triggers with FFD.`
            : `Continue routine GLOF monitoring.`,
        };
      }
      case "pmd_lightning": {
        return {
          hotspots: features.length ? [{ label: `${features.length} strike${features.length === 1 ? "" : "s"} in the last hour` }] : [],
          meaning: features.length ? `Active convection somewhere in the window.` : `Quiet electrical activity in the last hour.`,
          forecast: `Correlate strike locations with the warnings polygon layer to identify affected districts.`,
          mitigation: `Advise field teams on lightning-safe posture near strike clusters.`,
        };
      }
      case "pmd_city_forecast": {
        return {
          hotspots: features.slice(0, 6).map((f) => {
            const p = props(f);
            const t = Number(p.temp);
            return { label: `${p.name || p.city || "—"} — now ${Number.isFinite(t) ? t.toFixed(0) : "?"} °C · ${p.weather || ""}` };
          }),
          meaning: `Live city snapshot — driven by PMD Monitor 12-step forecast per station.`,
          forecast: `Full 12-step forecast is available in the popup / PMD Overview drilldown.`,
          mitigation: `Use for planning-window queries against the operator's ROI.`,
        };
      }
      case "ffd_data": {
        const byStatus = {};
        for (const f of features) {
          const s = String(props(f).status || "").toLowerCase();
          byStatus[s] = (byStatus[s] || 0) + 1;
        }
        const hs = Object.entries(byStatus).filter(([, n]) => n > 0)
          .map(([lvl, n]) => ({ label: `${lvl.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} · ${n} gauge${n === 1 ? "" : "s"}` }));
        const risk = (byStatus["high"] || 0) + (byStatus["very high"] || 0) + (byStatus["very_high"] || 0) + (byStatus["exceptionally high"] || 0) + (byStatus["ex_high"] || 0);
        return {
          hotspots: hs,
          meaning: risk > 0
            ? `${risk} river gauge${risk === 1 ? "" : "s"} currently at High or above.`
            : `River telemetries in Normal / Low band.`,
          forecast: `Compare inflow / outflow trends over the next 24 h using upstream lag hours.`,
          mitigation: risk > 0
            ? `Coordinate with FFD for downstream advisories; verify embankment / evacuation posture on the affected reach.`
            : `Routine monitoring cadence.`,
        };
      }
      case "pmd_monsoon": {
        return {
          hotspots: features.slice(0, 6).map((f) => ({ label: `${props(f).province || "—"} · ${props(f).level || ""}` })),
          meaning: `Monsoon-specific warning envelope from PMD Monitor.`,
          forecast: `Overlay with FFD waterlevels to derive flash-flood exposure.`,
          mitigation: `Follow monsoon SOP: pre-emptive drainage clearance, road-closure staging.`,
        };
      }
      default: {
        return {
          hotspots: [],
          meaning: `Live layer with ${features.length} feature${features.length === 1 ? "" : "s"}.`,
          forecast: `Refer to source documentation for interpretation.`,
          mitigation: `Follow standing SOP for this data category.`,
        };
      }
    }
  }

  // Wrap an { hotspots, meaning, forecast, mitigation } object into
  // the 4-card analysis grid used across the report.
  #reportAnalysisBlock(a) {
    if (!a) return "";
    const hotspotHtml = a.hotspots?.length
      ? `<ul>${a.hotspots.map((h) => `<li>${escapeHtml(h.label || h)}</li>`).join("")}</ul>`
      : `<p style="color:var(--muted);font-style:italic;margin:0">None flagged in current data.</p>`;
    return `
      <div class="analysis">
        <div class="analysis-card hotspot">
          <h4>Hotspots</h4>
          ${hotspotHtml}
        </div>
        <div class="analysis-card meaning">
          <h4>What This Means</h4>
          <p>${escapeHtml(a.meaning || "—")}</p>
        </div>
        <div class="analysis-card forecast">
          <h4>Forecast Implications</h4>
          <p>${escapeHtml(a.forecast || "—")}</p>
        </div>
        <div class="analysis-card mitigation">
          <h4>Mitigation / Actions</h4>
          <p>${escapeHtml(a.mitigation || "—")}</p>
        </div>
      </div>
    `;
  }

  // Mitigation cards keyed off the exec-summary signal counts — always
  // includes the general NDMA / PMD / FFD standing guidance, and
  // conditionally surfaces hazard-specific cards when the numbers
  // trip a threshold.
  #reportMitigationCards(summary) {
    const cards = [];
    // Standing NDMA guidance — always visible.
    cards.push(`
      <div class="rec">
        <h4>NDMA Standing Guidance</h4>
        <ul>
          <li>Maintain 24×7 NEOC watch officer coverage across all active hazards.</li>
          <li>Verify communication trees quarterly; test SAT link on rotation.</li>
          <li>Log all advisories in the NCOP incident channel with timestamp + source.</li>
        </ul>
      </div>
    `);
    if (summary.forecastHotCount > 0 || summary.recordExtremes > 0) {
      cards.push(`
        <div class="rec">
          <h4>Heat Response (PMD Advisory Ladder)</h4>
          <ul>
            <li>≥ 35 °C — issue caution; brief outdoor labour supervisors.</li>
            <li>≥ 40 °C — issue advisory; open cooling shelters in urban centres.</li>
            <li>≥ 45 °C — heat-emergency posture; suspend non-essential outdoor work; coordinate with health authorities.</li>
            <li>Hydration and shade guidance to be disseminated on PMD press-release cadence.</li>
          </ul>
        </div>
      `);
    }
    if (summary.warningCount > 0) {
      cards.push(`
        <div class="rec">
          <h4>Active-Warning Coordination</h4>
          <ul>
            <li>Identify districts intersecting each Orange / Red polygon and notify local admin.</li>
            <li>Cross-reference the warning element (rainstorm, gust, thunderstorm) with the operator SOP.</li>
            <li>Verify field teams are outside the affected extent or wearing appropriate PPE.</li>
          </ul>
        </div>
      `);
    }
    if (summary.glofAlerts > 0) {
      cards.push(`
        <div class="rec">
          <h4>GLOF Watch Response</h4>
          <ul>
            <li>Watch → notify downstream valley administration and monitor for escalation.</li>
            <li>Warning → coordinate with FFD to pre-clear evacuation routes.</li>
            <li>Emergency → activate valley-level evacuation triggers per SOP.</li>
          </ul>
        </div>
      `);
    }
    // Always include a generic flood / FFD guidance card.
    cards.push(`
      <div class="rec">
        <h4>Flood / Waterlevel Coordination</h4>
        <ul>
          <li>Cross-check FFD waterlevels feed against gauge routing (upstream point, lag hours).</li>
          <li>Confirm embankment condition against latest FFD bulletin.</li>
          <li>Escalate any gauge at "Exceptionally High" per FFD SOP.</li>
        </ul>
      </div>
    `);
    return cards.join("");
  }

  #renderMaxTempsSection(res) {
    if (res.status !== "fulfilled") {
      return this.#pmdSectionShell("Historical Record Max Temperatures", this.#pmdErrorBody(res.reason), "thermometer-sun");
    }
    // Deep extraction — see #deepFindItemArray for the fallback path.
    let source = this.#extractItemArray(res.value, ["items", "data", "stations", "records", "results", "max_temperatures", "max_temps", "list", "rows"]);
    if (!source.length) source = this.#deepFindItemArray(res.value);
    if (!source.length) {
      return this.#pmdSectionShell("Historical Record Max Temperatures", this.#pmdEmptyBody("No records available."), "thermometer-sun");
    }

    // Broadened alias sets (same rationale as #buildMaxTempsFullView).
    const nameKeys = ["name", "station", "station_name", "stationname", "city", "location", "site", "place", "observatory"];
    const valueKeys = [
      "temperature", "max_temperature", "max_temp", "maxTemp", "max", "value",
      "record", "record_max", "record_temp", "ever_max", "all_time_max",
      "all_time", "historical_max", "absolute_max", "absolute_high",
      "hottest", "peak", "peak_temp", "high", "temp", "tmax", "tmax_c", "max_c",
    ];
    const dateKeys = [
      "date", "recorded_on", "record_date", "when", "at", "observed_on",
      "year", "year_of_record", "recorded_year", "record_year",
    ];

    // Case/separator-insensitive key resolution — the scraper writes
    // "Station" / "Max Temp C" / "Date", the probe list is lowercase +
    // snake_case; without this normalisation the row loop always
    // dropped into the fallback rendering path.
    const findCI = (obj, candidates) => {
      if (!obj || typeof obj !== "object") return null;
      const keys = Object.keys(obj);
      const map = new Map(keys.map((k) => [this.#normFieldKey(k), k]));
      for (const c of candidates) {
        const actual = map.get(this.#normFieldKey(c));
        if (actual != null && obj[actual] != null && obj[actual] !== "") return actual;
      }
      return null;
    };
    const rows = [];
    for (const r of source) {
      if (!r || typeof r !== "object") continue;
      const nameKey = findCI(r, nameKeys);
      const valKey  = findCI(r, valueKeys);
      if (!nameKey || !valKey) continue;
      const num = this.#parseTempRange(r[valKey]);
      if (!Number.isFinite(num)) continue;
      const dateKey = findCI(r, dateKeys);
      rows.push({
        name:  String(this.#unwrapValue(r[nameKey]) ?? r[nameKey]),
        value: num,
        date:  dateKey ? String(this.#unwrapValue(r[dateKey]) ?? r[dateKey]) : "",
      });
    }
    if (!rows.length) {
      // Fallback — render a clean table using whatever fields the
      // response actually carries.  Every temperature-looking cell
      // gets a threshold background, every level/status/alert-looking
      // cell gets a coloured pill.  Column order is stable across
      // rows because we discover the field union once.
      const raw = this.#buildFallbackTable(source, { maxRows: 40 });
      return this.#pmdSectionShell(
        "Historical Record Max Temperatures",
        raw || this.#pmdEmptyBody("No records available."),
        "thermometer-sun"
      );
    }
    rows.sort((a, b) => b.value - a.value);
    const top = rows.slice(0, 10);
    const list = top.map((r) => `
      <li class="wrp-pmd-record-row">
        <span class="wrp-pmd-record-name">${escapeHtml(r.name)}</span>
        <span class="wrp-pmd-record-meta">${escapeHtml(r.date)}</span>
        <span class="wrp-pmd-record-value">${r.value.toFixed(1)} °C</span>
      </li>
    `).join("");
    return this.#pmdSectionShell(
      "Historical Record Max Temperatures",
      `<ul class="wrp-pmd-records">${list}</ul>`,
      "thermometer-sun"
    );
  }

  #renderPublicForecastSection(res) {
    if (res.status !== "fulfilled") {
      return this.#pmdSectionShell("PMD Public Forecast", this.#pmdErrorBody(res.reason), "cloud-sun", { collapsed: true });
    }
    const data = res.value;
    if (!data) {
      return this.#pmdSectionShell("PMD Public Forecast", this.#pmdEmptyBody("No forecast available."), "cloud-sun", { collapsed: true });
    }

    const daily = Array.isArray(data?.daily) ? data.daily : null;

    // Expected upstream shape is `{ daily: [ { type, today_date, ... } ] }`.
    // If that's what we got, render each entry as a proper table with
    // a distinct header, Today/Tomorrow sub-columns for the paired
    // fields, and full-width rows for the narrative fields.
    if (daily && daily.length) {
      const body = daily.map((entry) => this.#buildForecastTable(entry)).join("");
      return this.#pmdSectionShell("PMD Public Forecast", body, "cloud-sun", { collapsed: true });
    }

    // Fallback — schema drifted or empty; drop back to a JSON preview
    // so operators can still see something landed instead of an
    // "unavailable" state that hides a real payload.
    let preview = "";
    try {
      preview = JSON.stringify(data, null, 2);
      if (preview.length > 1200) preview = preview.slice(0, 1200) + "\n… (truncated)";
    } catch { preview = String(data); }
    return this.#pmdSectionShell(
      "PMD Public Forecast (raw)",
      `<pre class="wrp-pmd-pre">${escapeHtml(preview)}</pre>`,
      "cloud-sun",
      { collapsed: true }
    );
  }

  // Build a single 3-column table for one `daily[]` entry.  Layout:
  //   ┌──────────────────────────────────────────────────────────┐
  //   │  EVENING FORECAST                          <- title row  │
  //   ├──────────┬─────────────────┬─────────────────────────────┤
  //   │          │ Today  15 Jun   │ Tomorrow  16 Jun            │
  //   ├──────────┼─────────────────┼─────────────────────────────┤
  //   │ Forecast │ ...today text...│ ...tomorrow text...         │
  //   ├──────────┼─────────────────┴─────────────────────────────┤
  //   │ Past 24h │ ... narrative spans both columns ...          │
  //   │ Synoptic │ ...                                           │
  //   │ Warning  │ ...  (only rendered when non-empty)           │
  //   │ Updated  │ 15 Jun 2026, 12:39                            │
  //   └──────────┴───────────────────────────────────────────────┘
  #buildForecastTable(entry) {
    const type = String(entry?.type || "Forecast").trim();
    const typeLabel = type
      ? type.replace(/\b\w/g, (c) => c.toUpperCase())
      : "Forecast";
    const todayDate    = entry?.today_date || "";
    const tomorrowDate = entry?.tomorrow_date || "";
    const todayFc      = this.#decodePmdText(entry?.today_forecast_eng);
    const tomorrowFc   = this.#decodePmdText(entry?.tomorrow_forecast_eng);
    const past24       = this.#decodePmdText(entry?.past_24_weather);
    const synoptic     = this.#decodePmdText(entry?.synoptic_situation_eng);
    const warning      = this.#decodePmdText(entry?.warning_eng);
    const updated      = this.#formatUnixTs(entry?.last_updated);

    const fullRow = (label, text) => text
      ? `<tr class="wrp-pmd-forecast-full">
           <th scope="row">${escapeHtml(label)}</th>
           <td colspan="2">${escapeHtml(text)}</td>
         </tr>`
      : "";

    return `
      <table class="wrp-pmd-forecast-table">
        <thead>
          <tr>
            <th colspan="3" class="wrp-pmd-forecast-title">${escapeHtml(typeLabel)} Forecast</th>
          </tr>
          <tr class="wrp-pmd-forecast-subhead">
            <th scope="col"></th>
            <th scope="col">Today<span class="wrp-pmd-forecast-date">${escapeHtml(todayDate)}</span></th>
            <th scope="col">Tomorrow<span class="wrp-pmd-forecast-date">${escapeHtml(tomorrowDate)}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr class="wrp-pmd-forecast-split">
            <th scope="row">Forecast</th>
            <td>${escapeHtml(todayFc) || "—"}</td>
            <td>${escapeHtml(tomorrowFc) || "—"}</td>
          </tr>
          ${fullRow("Past 24h", past24)}
          ${fullRow("Synoptic", synoptic)}
          ${fullRow("Warning", warning)}
          ${fullRow("Updated", updated)}
        </tbody>
      </table>
    `;
  }

  // Decode PMD's HTML-entity-escaped narrative fields into plain text
  // with real newlines.  PMD stores `<br>` as `&lt;br&gt;` inside the
  // JSON string, and sprinkles `&nbsp;` freely — both need normalising
  // before rendering.  Any other HTML tags are stripped as a defensive
  // XSS guard.
  #decodePmdText(s) {
    if (typeof s !== "string" || !s) return "";
    const decoded = s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    return decoded
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }

  // Format a `last_updated` unix timestamp (seconds or ms).
  #formatUnixTs(ts) {
    if (ts == null || ts === "") return "";
    const n = Number(ts);
    if (!Number.isFinite(n)) return String(ts);
    try {
      const ms = n < 1e11 ? n * 1000 : n;
      return new Date(ms).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return String(ts);
    }
  }

  // -------------------------------------------------------------- Active-Layers block
  // Throttled refresh — coalesces bursts of `sourcedata` / `styledata`
  // into a single DOM write per 150 ms window.  Cheap no-op when the
  // PMD tab isn't currently visible.
  #scheduleActiveLayersRefresh() {
    if (this.#activeTab !== "pmd") return;
    if (!this.#activeLayersEl) return;
    if (this.#activeLayersTimerId != null) return;
    this.#activeLayersTimerId = setTimeout(() => {
      this.#activeLayersTimerId = null;
      this.#refreshActiveLayers();
    }, 150);
  }

  #refreshActiveLayers() {
    if (!this.#activeLayersEl) return;
    if (this.#activeTab !== "pmd") return;

    // Build a fingerprint of (active key + feature count) so a
    // sourcedata tick that doesn't change anything is a free re-render.
    const activeEntries = [];
    for (const [key, cfg] of Object.entries(PMD_TAB_TRACKED_LAYERS)) {
      if (!this.#isTrackedKeyActive(key, cfg)) continue;
      const features = this.#extractFeatures(cfg.sourceId);
      activeEntries.push({ key, cfg, features });
    }
    const fp = activeEntries
      .map((e) => `${e.key}:${e.features.length}`)
      .join("|");
    if (fp === this.#activeLayersFingerprint) return;
    this.#activeLayersFingerprint = fp;

    if (!activeEntries.length) {
      this.#activeLayersEl.innerHTML = `
        <div class="wrp-pmd-active-empty">
          <i data-lucide="layers" class="wrp-pmd-active-empty-icon"></i>
          <div class="wrp-pmd-active-empty-text">
            No live layers on the map yet.  Toggle any layer under
            <b>PMD Monitor Live Feeds</b> or <b>PMD Weather Stations</b>
            in the sidebar to see its data here.
          </div>
        </div>
      `;
    } else {
      this.#activeLayersEl.innerHTML = activeEntries
        .map(({ key, cfg, features }) => this.#buildLayerSection(key, cfg, features))
        .join("");
    }
    if (window.lucide?.createIcons) {
      try { window.lucide.createIcons(); } catch {}
    }
  }

  #extractFeatures(sourceId) {
    let features = [];
    try {
      const src = this.#map.getSource(sourceId);
      if (src) {
        const data = src._data;
        if (data && Array.isArray(data.features)) features = data.features;
      }
    } catch {}
    if (features.length === 0) {
      try { features = this.#map.querySourceFeatures(sourceId) || []; }
      catch { features = []; }
    }
    // Honour the pmd_warnings hazard-type pre-filter (sidebar checkbox
    // table above the master toggle) if it's currently narrowing the
    // set.  Empty selection → filterFeatures() is pass-through, so this
    // call is a no-op when the user hasn't ticked anything.
    if (sourceId === "pmd_warnings-source" && pmdWarningsFilter?.filterFeatures) {
      try { features = pmdWarningsFilter.filterFeatures(features); } catch (_) {}
    }
    return features;
  }

  // Detect whether a tracked layer key is currently toggled on.  We
  // used to hard-code a single `primaryLayerId` (e.g. "ffd_data-circle")
  // — but if that specific layer id ever gets renamed / dropped /
  // suffixed by a downstream helper, the section vanishes even though
  // the layer is clearly on the map (this bit the FFD River
  // Telemetries case).  Broader detection: match the explicit primary
  // AND fall back to "any layer id starting with `${key}-`" so
  // companion layers (labels, rivers-fill, sun-symbol, ...) also count
  // as evidence the toggle is on.  Trailing `-` prevents a longer key
  // from accidentally shadowing a shorter one.
  #isTrackedKeyActive(key, cfg) {
    const ids = Array.isArray(cfg.primaryLayerId)
      ? cfg.primaryLayerId
      : [cfg.primaryLayerId];
    for (const id of ids) {
      if (id && this.#map.getLayer(id)) return true;
    }
    // Fallback: any style layer with the key prefix.
    try {
      const style = this.#map.getStyle();
      if (!style || !Array.isArray(style.layers)) return false;
      const prefix = `${key}-`;
      for (const l of style.layers) {
        if (typeof l.id === "string" && l.id.startsWith(prefix)) return true;
      }
    } catch {}
    return false;
  }

  #buildLayerSection(key, cfg, features) {
    const count = features.length;
    const rows = features.slice(0, cfg.maxRows || 15);

    const iconClass = cfg.icon?.shape === "square"
      ? "wrp-pmd-layer-icon wrp-pmd-layer-icon--square"
      : "wrp-pmd-layer-icon wrp-pmd-layer-icon--circle";
    const iconHtml = `<span class="${iconClass}" style="background:${cfg.icon?.color || "#7280"}"></span>`;

    const legendHtml = cfg.legend?.length
      ? `<div class="wrp-pmd-layer-legend">
           ${cfg.legend.map((l) => `
             <span class="wrp-pmd-legend-chip">
               <span class="wrp-pmd-legend-swatch" style="background:${l.color}"></span>
               <span class="wrp-pmd-legend-label">${escapeHtml(l.label)}</span>
             </span>
           `).join("")}
         </div>`
      : "";

    let bodyContent;
    if (!rows.length) {
      bodyContent = `<p class="wrp-pmd-empty">${escapeHtml(cfg.emptyText || "No features in current data.")}</p>`;
    } else if (key === "pmd_city_forecast") {
      // City forecast gets a bespoke body: the summary table on top,
      // then a per-city accordion revealing that city's parsed 12-step
      // forecast table.  The `fc` field arrives as a JSON string per
      // §3.7 — parse before rendering.
      bodyContent = this.#buildLayerTable(cfg, rows, count) +
        this.#buildCityForecastAccordions(rows);
    } else {
      bodyContent = this.#buildLayerTable(cfg, rows, count);
    }

    return `
      <section class="wrp-pmd-section wrp-pmd-layer-section" data-layer-key="${escapeHtml(key)}">
        <header class="wrp-pmd-section-head wrp-pmd-layer-head">
          ${iconHtml}
          <h4 class="wrp-pmd-section-title">${escapeHtml(cfg.label)}</h4>
          <span class="wrp-pmd-layer-count">${count} feature${count === 1 ? "" : "s"}</span>
        </header>
        <div class="wrp-pmd-section-body wrp-pmd-layer-body">
          ${legendHtml}
          ${bodyContent}
        </div>
      </section>
    `;
  }

  // ---- city-forecast per-city drilldowns (fc[] parsed) ----
  #buildCityForecastAccordions(features) {
    const cards = features.map((f) => {
      const p = f?.properties || {};
      const city  = p.name || p.city || "City";
      const steps = this.#parseFcSteps(p.fc);
      if (!steps.length) return "";
      return `
        <details class="wrp-pmd-city-drill">
          <summary class="wrp-pmd-city-drill-head">
            <span class="wrp-pmd-city-drill-name">${escapeHtml(String(city))}</span>
            <span class="wrp-pmd-city-drill-meta">${steps.length}-step forecast</span>
            <span class="wrp-pmd-city-drill-chevron" aria-hidden="true">▸</span>
          </summary>
          <div class="wrp-pmd-city-drill-body">
            ${this.#buildFcStepsTable(steps)}
          </div>
        </details>
      `;
    }).filter(Boolean).join("");
    if (!cards) return "";
    return `<div class="wrp-pmd-city-drills">
              <div class="wrp-pmd-city-drills-title">Per-city 12-Step Forecast</div>
              ${cards}
            </div>`;
  }

  #parseFcSteps(fc) {
    if (fc == null) return [];
    if (Array.isArray(fc)) return fc;
    if (typeof fc === "string") {
      const s = fc.trim();
      if (!s || (s[0] !== "[" && s[0] !== "{")) return [];
      try {
        const parsed = JSON.parse(s);
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }
    return [];
  }

  #buildFcStepsTable(steps) {
    const SENT = new Set([9999, -9999, 999, -999]);
    const fmt = (v, digits = 1) => {
      if (v == null || v === "") return "—";
      const n = Number(v);
      if (!Number.isFinite(n) || SENT.has(n)) return "—";
      return n.toFixed(digits);
    };
    const rows = steps.map((s) => `
      <tr>
        <td class="wrp-pmd-fc-time">${escapeHtml(String(s?.ft ?? ""))}</td>
        <td>${fmt(s?.tem)}</td>
        <td>${escapeHtml(String(s?.wx ?? ""))}</td>
        <td>${fmt(s?.rhu, 0)}</td>
        <td>${fmt(s?.wspd)}</td>
        <td>${escapeHtml(String(s?.wdir ?? ""))}</td>
        <td>${fmt(s?.pre)}</td>
      </tr>
    `).join("");
    return `
      <table class="wrp-pmd-fc-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>T °C</th>
            <th>Wx</th>
            <th>RH %</th>
            <th>Wind</th>
            <th>Dir</th>
            <th>Precip</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  #buildLayerTable(cfg, features, totalCount) {
    const cols = cfg.columns || [];
    const headerHtml = cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
    const bodyHtml = features.map((f) => {
      const p = f?.properties || {};
      const cells = cols.map((c) => {
        const raw = this.#firstDefined(p, c.key, c.fallback);
        return `<td>${this.#formatLayerCell(raw, c)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    }).join("");

    const caption = features.length < totalCount
      ? `<caption class="wrp-pmd-layer-caption">Showing first ${features.length} of ${totalCount}</caption>`
      : "";

    return `
      <table class="wrp-pmd-layer-table">
        ${caption}
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    `;
  }

  #formatLayerCell(raw, col) {
    // Missing/empty → dash (never lie with a fake 0).
    if (raw == null || raw === "") {
      return `<span class="wrp-pmd-cell-empty">—</span>`;
    }

    // Some upstream fields are JSON strings (see MD §1.2: gauges,
    // lag_hours, elements, fc).  Parse before rendering so we don't
    // dump `[{"ft":"..."}]` into a table cell.
    let value = raw;
    if (typeof value === "string") {
      const s = value.trim();
      if ((s.startsWith("[") || s.startsWith("{")) && s.length > 2) {
        try { value = JSON.parse(s); } catch { /* keep as string */ }
      }
    }

    // Arrays → count summary (e.g. "12 items") with title tooltip
    // showing the first entry.  Prevents "[object Object], ..." leaks
    // when a column happens to point at gauges / fc / elements.
    if (Array.isArray(value)) {
      const first = value[0];
      const tip = first && typeof first === "object"
        ? Object.keys(first).slice(0, 4).join(", ")
        : String(first ?? "");
      const label = `${value.length} item${value.length === 1 ? "" : "s"}`;
      return `<span class="wrp-pmd-cell-array" title="${escapeHtml(tip)}">${label}</span>`;
    }

    // Plain objects → try to extract a human-readable summary.
    if (typeof value === "object") {
      const summary = value.label ?? value.name ?? value.title
        ?? value.value ?? value.text ?? value.description;
      if (summary != null && summary !== "") {
        return escapeHtml(String(summary).slice(0, 60));
      }
      try {
        const s = JSON.stringify(value);
        return `<span class="wrp-pmd-cell-array" title="${escapeHtml(s)}">${escapeHtml(s.length > 40 ? s.slice(0, 37) + "…" : s)}</span>`;
      } catch { return escapeHtml(String(value)); }
    }

    // Level / status / alert chip — all three funnel to the same
    // .wrp-pmd-level-chip class family.  Normalise the value into a
    // safe class-name slug (spaces/underscores → dashes; "Exceptionally
    // High" → "ex-high"; "VERY_HIGH" → "very-high"; etc.) so the CSS
    // colour ramp resolves regardless of whether the upstream uses
    // canonical or abbreviated severity names.
    if (col.chip === "level" || col.chip === "status" || col.chip === "alert") {
      const raw = String(value);
      const lvl = raw.toLowerCase()
        .replace(/\bexceptionally\s+high\b/g, "ex-high")
        .replace(/\bex[_\s-]*high\b/g, "ex-high")
        .replace(/\bvery\s+high\b/g, "very-high")
        .replace(/[\s_]+/g, "-");
      return `<span class="wrp-pmd-level-chip wrp-pmd-level-chip--${escapeHtml(lvl)}">${escapeHtml(raw)}</span>`;
    }
    // Kind chip (grey pill for station_type etc)
    if (col.chip === "kind") {
      return `<span class="wrp-pmd-kind-chip">${escapeHtml(String(value).toUpperCase())}</span>`;
    }

    // Numeric with unit — after the object/array bail-outs so we only
    // hit this for scalar values.
    if (col.numeric != null) {
      const n = Number(value);
      if (Number.isFinite(n)) {
        const digits = Math.max(0, Number(col.numeric) || 0);
        return `${n.toFixed(digits)}${col.unit ? ` <span class="wrp-pmd-unit">${escapeHtml(col.unit)}</span>` : ""}`;
      }
    }

    // Long strings — truncate so a single 400-char forecast doesn't
    // blow the row height out.
    const str = String(value);
    if (str.length > 80) {
      return `<span title="${escapeHtml(str)}">${escapeHtml(str.slice(0, 77) + "…")}</span>`;
    }
    return escapeHtml(str);
  }

  #firstDefined(obj, key, fallback) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
    if (fallback && obj[fallback] != null && obj[fallback] !== "") return obj[fallback];
    return null;
  }

  // ================================================================
  //  Dynamic Report — Word / PDF export
  // ================================================================
  //  Zero-dependency exports.  The full styled report HTML is built
  //  ONLY on click (never stored between clicks), so the memory
  //  footprint while the panel is idle is a single { rows, meta, state }
  //  reference — no serialized copy.
  //  * Word (.doc):  Blob with `application/msword` MIME; Word opens
  //                  the HTML natively.  No docx library needed.
  //  * PDF:          new window with the same HTML + auto window.print()
  //                  — user's OS print dialog exports the PDF.  No
  //                  jsPDF, no html2canvas, no rasterization overhead.
  //  Both share #buildReportHtml() so the two formats stay in sync.
  // ================================================================

  // Overlay-wrapped runner for the two export buttons.  Shows a spinner
  // in the panel body while the report HTML is built + streamed to the
  // download layer, restores the button state on completion, and
  // surfaces any thrown error inline (previously errors were silently
  // eaten by the button's click handler + never made it to the user).
  //
  // The report build is synchronous but can take a beat on wide bboxes
  // — we yield to the paint pipeline once via requestAnimationFrame so
  // the spinner actually appears BEFORE the ~30-50ms serialisation runs.
  async #runExport(label, fn) {
    this.#showExportOverlay(`Preparing ${label} report…`);
    // Two rAFs guarantees the spinner paints at least one frame before
    // the (synchronous) serialisation starts.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const result = fn();
      if (result && typeof result.then === "function") await result;
      this.#hideExportOverlay();
    } catch (err) {
      console.error(`[WeatherReport] ${label} export failed:`, err);
      this.#showExportOverlay(
        `${label} export failed. ${err && err.message ? err.message : "See console for details."}`,
        { isError: true }
      );
      // Auto-clear the error banner after 4 s so the panel returns to
      // normal on its own.
      setTimeout(() => this.#hideExportOverlay(), 4000);
    }
  }

  #showExportOverlay(message, opts = {}) {
    const panel = this.#panelEl;
    if (!panel) return;
    let overlay = panel.querySelector(".wrp-export-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "wrp-export-overlay";
      overlay.innerHTML = `
        <div class="wrp-export-overlay__card">
          <div class="wrp-export-overlay__spinner" aria-hidden="true"></div>
          <div class="wrp-export-overlay__text"></div>
        </div>
      `;
      panel.appendChild(overlay);
    }
    overlay.querySelector(".wrp-export-overlay__text").textContent = message;
    overlay.classList.toggle("is-error", !!opts.isError);
    // Force a reflow before adding the visible class so the CSS
    // transition kicks in on first show as well.
    void overlay.offsetWidth;
    overlay.classList.add("is-visible");
  }

  #hideExportOverlay() {
    const overlay = this.#panelEl?.querySelector(".wrp-export-overlay");
    if (!overlay) return;
    overlay.classList.remove("is-visible");
    // Match CSS transition duration before removing from DOM so a
    // rapid re-open reuses the same node.
    setTimeout(() => {
      if (!overlay.classList.contains("is-visible")) overlay.remove();
    }, 320);
  }

  #downloadReportAsWord() {
    if (!this.#lastReport) return;
    const html  = this.#buildReportHtml("word");
    const stamp = this.#slugForFilename();
    const blob  = new Blob(
      ["﻿" + html],  // BOM so Word recognises UTF-8
      { type: "application/msword" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `weather-report-${stamp}.doc`;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    // Explicit MouseEvent so browsers that gate synthetic .click() on
    // non-visible anchors (Firefox in particular) still initiate the
    // download.  Bubbles + cancelable so the browser's own download
    // handler picks it up.
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    // Small teardown delay lets Chrome flush the download; Blob is
    // GC'd the moment the URL is revoked + a is removed.
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 400);
  }

  #downloadReportAsPdf() {
    if (!this.#lastReport) return;
    const html = this.#buildReportHtml("pdf");
    // Fresh popup window scoped just to the printable report.  We
    // inject the HTML directly (document.write) rather than data-URL
    // so the print dialog opens in a normal window context — Chrome
    // blocks window.print() on data: URLs.
    const w = window.open("", "_blank", "noopener,noreferrer,width=980,height=720");
    if (!w) {
      // Popup blocked — fall back to opening in a temporary iframe
      // whose print() call targets the main window's print dialog.
      this.#pdfViaIframe(html);
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
    // Wait for the doc to finish parsing + fonts before printing so the
    // dialog opens with the fully-laid-out content.
    const doPrint = () => {
      try { w.focus(); } catch (_) {}
      try { w.print(); } catch (_) {}
    };
    if (w.document.readyState === "complete") {
      setTimeout(doPrint, 120);
    } else {
      w.addEventListener("load", () => setTimeout(doPrint, 120), { once: true });
    }
  }

  #pdfViaIframe(html) {
    // Fallback path when popups are blocked.  The iframe is torn down
    // one second after print() fires so we don't leak DOM.
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.left = "-10000px";
    frame.style.top  = "-10000px";
    frame.style.width  = "0";
    frame.style.height = "0";
    document.body.appendChild(frame);
    const fdoc = frame.contentDocument || frame.contentWindow.document;
    fdoc.open();
    fdoc.write(html);
    fdoc.close();
    setTimeout(() => {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (_) {}
      setTimeout(() => frame.remove(), 1000);
    }, 200);
  }

  #slugForFilename() {
    const d = this.#lastReport?.generatedAt || new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const key = this.#lastReport?.meta?.label
      ? this.#lastReport.meta.label
          .toLowerCase()
          .replace(/[^\w]+/g, "-")
          .replace(/^-|-$/g, "")
      : "report";
    return `${key}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // ----------------------------------------------------------------
  // Report HTML builder — cover, executive summary, per-province
  // narrative, per-district table, mitigation.  Format-agnostic:
  // `mode` only tweaks trivia (whether to auto-print, filename hint).
  // ----------------------------------------------------------------
  #buildReportHtml(mode) {
    const snap  = this.#lastReport;
    const rows  = snap.rows || [];
    const meta  = snap.meta || {};
    const state = snap.state || {};
    const kind  = meta.kind || "unknown";
    const guidance = this.#kindGuidance(kind);
    const genDate  = snap.generatedAt || new Date();
    const alertRows = rows.filter((r) => r.reading.alert);
    const provinces = this.#groupRowsByProvince(rows);

    const headerTitle = escapeHtml(meta.label || "Weather Report");
    const stepLabel   = escapeHtml(state.date || "Current step");
    const genStr      = genDate.toLocaleString();

    // Auto-generated bulletin-style paragraph — mirrors the narrative
    // tone of the example the user gave ("Rain-wind/thundershowers is
    // expected in ...").  Assembled from the province groupings, so
    // provinces with alerts appear first.
    const bulletin = this.#buildBulletinParagraph(kind, provinces, meta);

    // Executive summary tiles (rendered as a table for Word-HTML
    // compatibility — Word ignores CSS flex/grid).
    const summaryHtml = `
      <table class="wrp-doc-summary" role="presentation">
        <tr>
          <td><div class="wrp-doc-stat-num">${rows.length}</div>
              <div class="wrp-doc-stat-lbl">Districts sampled</div></td>
          <td><div class="wrp-doc-stat-num" style="color:#dc2626">${alertRows.length}</div>
              <div class="wrp-doc-stat-lbl">Districts over threshold</div></td>
          <td><div class="wrp-doc-stat-num">${provinces.length}</div>
              <div class="wrp-doc-stat-lbl">Provinces covered</div></td>
        </tr>
      </table>
    `;

    // Hotspots table — top 10 by score.
    const hotspotRows = rows.slice(0, 10).map((r, i) => `
      <tr class="${r.reading.alert ? "wrp-doc-alert" : ""}">
        <td>${i + 1}</td>
        <td>${escapeHtml(r.district)}</td>
        <td>${escapeHtml(r.province)}</td>
        <td class="wrp-doc-val">${escapeHtml(r.reading.label)}</td>
        <td>${r.reading.alert ? "⚠ Alert" : "Nominal"}</td>
      </tr>
    `).join("");

    // Province breakdown sections — each with narrative + district
    // rows grouped underneath.
    let provinceSections = "";
    for (const [province, list] of provinces) {
      const agg = this.#provinceAggregate(list, meta);
      const provinceAlerts = list.filter((r) => r.reading.alert).length;
      const districtRows = list.map((r) => `
        <tr class="${r.reading.alert ? "wrp-doc-alert" : ""}">
          <td>${escapeHtml(r.district)}</td>
          <td class="wrp-doc-val">${escapeHtml(r.reading.label)}</td>
          <td>${r.reading.alert ? "⚠" : ""}</td>
        </tr>
      `).join("");

      provinceSections += `
        <div class="wrp-doc-province">
          <h3>${escapeHtml(province)}
            ${provinceAlerts ? `<span class="wrp-doc-badge">${provinceAlerts} alert${provinceAlerts === 1 ? "" : "s"}</span>` : ""}
          </h3>
          <p class="wrp-doc-province-narrative">
            ${this.#buildProvinceNarrative(province, list, meta, agg)}
          </p>
          <table class="wrp-doc-table">
            <thead>
              <tr>
                <th>District</th>
                <th>${escapeHtml(meta.label || "Value")}</th>
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>${districtRows}</tbody>
          </table>
        </div>
      `;
    }

    // Best-practice mitigation section, kind-aware.
    const mitigationHtml = `
      <div class="wrp-doc-mitigation">
        <h2>What This Means &amp; Recommended Actions</h2>
        <p class="wrp-doc-significance"><strong>Significance.</strong> ${escapeHtml(guidance.signifies)}</p>
        <p class="wrp-doc-risks"><strong>Primary risks if threshold breached.</strong> ${escapeHtml(guidance.risks)}</p>
        <h3>Best-practice mitigation</h3>
        <ul>
          ${guidance.mitigation.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}
        </ul>
      </div>
    `;

    // Word MSO styling gets a little help — page-margin comment is a
    // no-op in Chrome but Word honours it.  For PDF mode we add a
    // print stylesheet so the page renders full-width with sensible
    // margins.
    const printCss = mode === "pdf" ? `
      @media print {
        @page { size: A4 portrait; margin: 14mm 14mm 16mm 14mm; }
        body { margin: 0; }
        .wrp-doc-print-controls { display: none !important; }
      }
    ` : "";

    const printControls = mode === "pdf" ? `
      <div class="wrp-doc-print-controls">
        <button type="button" onclick="window.print()">Print / Save as PDF</button>
        <button type="button" onclick="window.close()">Close</button>
      </div>
    ` : "";

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Weather Report — ${headerTitle}</title>
<style>
  body {
    font-family: 'Segoe UI', 'Inter', Arial, sans-serif;
    color: #0f172a;
    line-height: 1.5;
    margin: 0 auto;
    max-width: 820px;
    padding: 24px 32px 40px;
    background: #ffffff;
  }
  .wrp-doc-print-controls {
    position: fixed; top: 10px; right: 12px;
    display: flex; gap: 8px; z-index: 999;
  }
  .wrp-doc-print-controls button {
    padding: 8px 14px; border-radius: 6px; border: 1px solid #cbd5e1;
    background: #1e40af; color: #fff; font-weight: 600; cursor: pointer;
  }
  .wrp-doc-print-controls button + button {
    background: #f8fafc; color: #0f172a;
  }
  h1 { font-size: 22px; margin: 0 0 4px; color: #0b3b8c; }
  .wrp-doc-subtitle { color: #475569; margin: 0 0 4px; font-size: 13px; }
  .wrp-doc-generated { color: #94a3b8; margin: 0 0 20px; font-size: 12px; }
  h2 { font-size: 17px; color: #0b3b8c; margin: 24px 0 10px;
       border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  h3 { font-size: 14px; color: #0b3b8c; margin: 16px 0 6px; }
  p  { margin: 6px 0 12px; }
  .wrp-doc-bulletin {
    background: linear-gradient(135deg, #eef4ff 0%, #f8fafc 100%);
    border-left: 4px solid #3b82f6;
    padding: 12px 16px;
    border-radius: 4px;
    font-size: 13.5px;
    color: #1e293b;
    margin: 12px 0 20px;
  }
  .wrp-doc-summary { width: 100%; border-collapse: separate;
                     border-spacing: 8px 0; margin: 6px 0 18px; }
  .wrp-doc-summary td { width: 33.3%; padding: 12px; text-align: center;
                        background: #f1f5f9; border-radius: 6px; }
  .wrp-doc-stat-num { font-size: 26px; font-weight: 700; color: #0b3b8c; }
  .wrp-doc-stat-lbl { font-size: 11px; color: #64748b; text-transform: uppercase;
                      letter-spacing: 0.6px; margin-top: 2px; }
  .wrp-doc-table { width: 100%; border-collapse: collapse; margin: 6px 0 14px;
                   font-size: 12px; }
  .wrp-doc-table th, .wrp-doc-table td { padding: 6px 8px;
                                          border-bottom: 1px solid #e2e8f0;
                                          text-align: left; }
  .wrp-doc-table thead th { background: #dbeafe; color: #0b3b8c; font-size: 11px;
                             text-transform: uppercase; letter-spacing: 0.4px; }
  .wrp-doc-val { font-weight: 600; font-variant-numeric: tabular-nums; }
  .wrp-doc-alert td { background: #fef2f2; color: #7f1d1d; }
  .wrp-doc-alert .wrp-doc-val { color: #b91c1c; }
  .wrp-doc-province { margin: 20px 0 8px; page-break-inside: avoid; }
  .wrp-doc-province h3 { margin: 0 0 6px; }
  .wrp-doc-badge {
    display: inline-block; margin-left: 8px; padding: 2px 8px;
    background: #dc2626; color: #fff; font-size: 10px; font-weight: 700;
    border-radius: 999px; text-transform: uppercase; letter-spacing: 0.4px;
  }
  .wrp-doc-province-narrative { font-size: 12.5px; color: #334155; margin: 0 0 8px; }
  .wrp-doc-mitigation { margin-top: 22px; padding: 14px 16px;
                        background: #fef7ec; border-left: 4px solid #f59e0b;
                        border-radius: 4px; }
  .wrp-doc-mitigation h2 { color: #92400e; border-bottom-color: #fbbf24; margin-top: 0; }
  .wrp-doc-mitigation h3 { color: #92400e; }
  .wrp-doc-mitigation ul { margin: 4px 0 6px 18px; padding: 0; }
  .wrp-doc-mitigation li { margin: 4px 0; font-size: 12.5px; color: #422006; }
  .wrp-doc-footer { margin-top: 30px; padding-top: 12px;
                    border-top: 1px solid #e2e8f0; color: #94a3b8;
                    font-size: 11px; text-align: center; }
  ${printCss}
</style>
</head>
<body>
${printControls}
<h1>${headerTitle}</h1>
<p class="wrp-doc-subtitle">Time step: ${stepLabel} &middot; NDMA National Common Operating Picture</p>
<p class="wrp-doc-generated">Generated ${escapeHtml(genStr)}</p>

<h2>Bulletin</h2>
<div class="wrp-doc-bulletin">${bulletin}</div>

<h2>Executive Summary</h2>
${summaryHtml}

<h2>Top Affected Districts</h2>
<table class="wrp-doc-table">
  <thead>
    <tr><th>#</th><th>District</th><th>Province</th><th>${escapeHtml(meta.label || "Reading")}</th><th>Status</th></tr>
  </thead>
  <tbody>${hotspotRows}</tbody>
</table>

<h2>Province Breakdown</h2>
${provinceSections}

${mitigationHtml}

<div class="wrp-doc-footer">
  Auto-generated from live map state &middot; NCOP &middot; ${escapeHtml(genStr)}
</div>
</body>
</html>`;
  }

  // Group rows by province while preserving alert-first ordering used
  // by the on-screen renderer.  Returns a plain array of [name, rows]
  // pairs so it survives JSON roundtrips if we ever cache it.
  #groupRowsByProvince(rows) {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.province)) map.set(r.province, []);
      map.get(r.province).push(r);
    }
    return [...map.entries()].sort(([, a], [, b]) => {
      const alertsA = a.filter((r) => r.reading.alert).length;
      const alertsB = b.filter((r) => r.reading.alert).length;
      if (alertsB !== alertsA) return alertsB - alertsA;
      return b.length - a.length;
    });
  }

  // Human-readable narrative for a single province.  Auto-composed so
  // the report reads like a PMD bulletin instead of a table dump.
  // Names the alerting districts explicitly and quotes the aggregate
  // reading for context.
  #buildProvinceNarrative(province, list, meta, agg) {
    const alerts = list.filter((r) => r.reading.alert).map((r) => r.district);
    const top    = list.slice(0, 3).map((r) => `${r.district} (${r.reading.label})`);
    const kindText = this.#kindNarrativePhrase(meta.kind);
    const period   = this.#cadenceText(meta.cadence);
    const parts = [];

    if (alerts.length) {
      parts.push(
        `${kindText} at threshold-breach levels reported across ${alerts.length} district${alerts.length === 1 ? "" : "s"} ` +
        `of ${province} — most notably ${alerts.slice(0, 3).map(escapeHtml).join(", ")}` +
        `${alerts.length > 3 ? ` and ${alerts.length - 3} other${alerts.length - 3 === 1 ? "" : "s"}` : ""}.`
      );
    } else {
      parts.push(
        `${kindText} sampled across ${list.length} district${list.length === 1 ? "" : "s"} of ${escapeHtml(province)} ` +
        `remains within nominal ranges${period ? ` over ${period}` : ""}.`
      );
    }

    if (agg && agg.label) {
      parts.push(`Provincial aggregate reads <strong>${escapeHtml(agg.label)}</strong>.`);
    }
    if (top.length) {
      parts.push(`Top readings: ${top.map(escapeHtml).join("; ")}.`);
    }
    return parts.join(" ");
  }

  // Bulletin paragraph — the opening card that reads like the PMD/NWFC
  // narrative the user gave as reference.  Assembles province names
  // into a natural sentence and prepends a date stamp.
  #buildBulletinParagraph(kind, provinces, meta) {
    if (!provinces.length) return "";
    const alertProvinces = provinces
      .filter(([, list]) => list.some((r) => r.reading.alert))
      .map(([name]) => name);
    const label   = (meta.label || this.#kindNarrativePhrase(kind)).replace(/ – /g, " ");
    const dateStr = this.#formatBulletinDate(this.#lastReport?.generatedAt);
    const period  = this.#cadenceText(meta.cadence);

    if (alertProvinces.length) {
      const list = this.#joinList(alertProvinces);
      return `${escapeHtml(dateStr)}. ${escapeHtml(label)} is showing threshold-level activity across ${escapeHtml(list)}` +
        `${period ? ` over ${escapeHtml(period)}` : ""}. Localised heavy readings are likely at isolated places within these regions during the period. ` +
        `Refer to the province breakdown below for district-level detail and recommended actions.`;
    }
    const covered = provinces.map(([name]) => name);
    const list = this.#joinList(covered);
    return `${escapeHtml(dateStr)}. ${escapeHtml(label)} sampled across ${escapeHtml(list)} remains within nominal ranges${period ? ` over ${escapeHtml(period)}` : ""}. ` +
      `No districts have crossed the alert threshold at this time step; continue routine monitoring.`;
  }

  // Small utilities for narrative generation ------------------------
  #joinList(items) {
    if (!items.length) return "";
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
  }

  #formatBulletinDate(d) {
    const date = d instanceof Date ? d : new Date();
    return date.toLocaleDateString(undefined, {
      day: "numeric", month: "long", year: "numeric", weekday: "long",
    });
  }

  #cadenceText(cadence) {
    if (!cadence) return "";
    if (cadence === "hourly") return "the next hourly window";
    if (cadence === "daily")  return "the current 24-hour window";
    if (cadence === "weekly") return "the current weekly window";
    return "";
  }

  #kindNarrativePhrase(kind) {
    switch (kind) {
      case "precipitation":       return "Rain / thundershower activity";
      case "snowfall":            return "Snowfall";
      case "cape":                return "Convective instability (CAPE)";
      case "storm_helicity":      return "Storm-relative helicity";
      case "temperature":         return "Ambient air temperature";
      case "aqi":                 return "Air Quality Index (AQI)";
      case "desert_dust":         return "Airborne desert dust";
      case "aod":                 return "Aerosol Optical Depth (AOD)";
      case "no2":                 return "Nitrogen dioxide (NO₂)";
      case "co":                  return "Carbon monoxide (CO)";
      case "so2":                 return "Sulphur dioxide (SO₂)";
      case "rainfall_station":    return "Station-observed rainfall";
      case "temperature_station": return "Station-observed temperature";
      default:                    return "Weather observation";
    }
  }

  // Kind → { signifies, risks, mitigation[] }.  Sourced from PMD /
  // NDMA advisory guidance, WHO 2021 AQ guidelines, US EPA AQI and
  // standard operational best-practice.  Kept as a flat lookup so
  // additions are cheap (one object entry per new kind).
  #kindGuidance(kind) {
    const G = {
      precipitation: {
        signifies:
          "Cumulative or short-window rainfall over the sampled districts. High values on the accumulated / hourly bands indicate potential for surface water accumulation, urban flash flooding, and elevated river inflow.",
        risks:
          "Flash floods in urban low-lying areas, riverine flooding in the Indus / Chenab / Jhelum / Ravi / Sutlej basins, landslides in the KP / GB / AJK belt, road closures, and disruption to agricultural fields close to harvest.",
        mitigation: [
          "Activate district Flood Control Rooms and pre-position dewatering pumps in identified low-elevation neighbourhoods.",
          "Issue early-warning SMS to residents in floodplain and glacial-lake outburst (GLOF) exposure zones.",
          "Coordinate with FFD and PMD for updated river-gauge and short-range QPF; ready evacuation routes for downstream districts.",
          "Restrict travel through gorge and landslide-prone sections (Karakoram Highway, Neelum Valley, Kaghan / Naran corridor).",
          "Alert farmers in Punjab and Sindh to secure standing crops and drain excess irrigation water where possible.",
        ],
      },
      snowfall: {
        signifies:
          "Frozen precipitation accumulation. Sustained heavy snowfall in the northern belt closes passes, isolates communities, and increases avalanche risk on high-elevation slopes.",
        risks:
          "Highway closures (Babusar, Lowari, Khunjerab), avalanche exposure in KP and GB, hypothermia risk for stranded travellers, structural loading on flat roofs.",
        mitigation: [
          "Pre-deploy snow-clearing machinery to the Karakoram Highway and Naran-Kaghan corridor.",
          "Coordinate with FWO / NHA to stage road-closure advisories with alternate-route guidance.",
          "Distribute cold-weather relief kits (blankets, heaters, generators) to district administrations of Chitral, Skardu, and Ghizer.",
          "Issue avalanche advisories through PMD to trekking / expedition operators in Gilgit-Baltistan.",
        ],
      },
      cape: {
        signifies:
          "Convective Available Potential Energy — the energy an air parcel would gain if lifted. High values ( ≥1000 J/kg) signal that any triggered convection can develop into severe thunderstorms with hail and strong downbursts.",
        risks:
          "Severe thunderstorms, damaging straight-line winds, large hail (crop damage), lightning fatalities in exposed rural work areas, aviation disruption.",
        mitigation: [
          "Issue thunderstorm watch advisories through PMD / NDMA channels for the flagged districts.",
          "Coordinate with PCAA for aviation route-planning around convective cells.",
          "Advise agricultural extension officers to warn open-field workers to seek shelter during peak instability hours.",
          "Ready DDMA rapid-response teams for lightning-strike and hail-damage response.",
        ],
      },
      storm_helicity: {
        signifies:
          "0–3 km storm-relative helicity — a measure of horizontal wind rotation that can be tilted into vertical rotation by an updraft, giving thunderstorms their tornadic potential.",
        risks:
          "Tornadic supercells (rare in Pakistan but documented in Sindh / south Punjab), roof and infrastructure damage, wind-driven power outages.",
        mitigation: [
          "Elevate PMD watch level for tornado-capable environments and coordinate with district disaster cells.",
          "Pre-position emergency shelter capacity in identified severe-storm corridors.",
          "Broadcast public safety messaging on shelter-in-place procedures.",
        ],
      },
      temperature: {
        signifies:
          "Ambient air temperature at the sampled districts. Sustained readings ≥40 °C trigger PMD's heat advisory ladder; ≤5 °C flags cold-wave risk in the northern belt and Balochistan uplands.",
        risks:
          "Heat-stroke fatalities (particularly urban outdoor workers in Karachi / Sindh / South Punjab), power-grid overload from AC demand, wildfire ignition, cold-related morbidity in the north.",
        mitigation: [
          "Open cooling centres in the flagged high-temperature districts; distribute ORS / drinking water via municipal outlets.",
          "Coordinate with health departments on heat-stroke protocols in tertiary hospitals.",
          "Adjust school and outdoor-work timings; issue public health advisories on hydration and midday sun avoidance.",
          "For cold-wave: distribute blankets, verify LPG / heater safety in valleys, monitor livestock exposure.",
        ],
      },
      aqi: {
        signifies:
          "Composite Air Quality Index across PM2.5, PM10, NO₂, O₃, SO₂, and CO. Values in the Unhealthy for Sensitive Groups band (≥100) begin affecting children, the elderly, and those with respiratory conditions.",
        risks:
          "Aggravated asthma and cardiovascular conditions, reduced visibility, school-absence spikes, hospital admissions for respiratory distress.",
        mitigation: [
          "Advise sensitive groups (children, elderly, respiratory patients) to remain indoors during flagged periods.",
          "Coordinate with Punjab / Sindh EPAs on emission controls (brick kilns, industrial stack scrubbers, crop-residue burning).",
          "Issue N95 mask advisories through health departments; support distribution in identified hotspot districts.",
          "Monitor school outdoor-activity restrictions; brief EPI / DHOs on expected respiratory case load.",
        ],
      },
      desert_dust: {
        signifies:
          "Airborne desert-dust concentration. Heavy loading blankets Sindh and southern Punjab during shamal winds, degrading air quality and creating aviation and road-visibility hazards.",
        risks:
          "Aviation disruption at Karachi / Sukkur / Rahim Yar Khan, reduced highway visibility, respiratory distress, solar-panel efficiency loss, agricultural leaf damage.",
        mitigation: [
          "Coordinate advisory to PCAA on airport visibility and aviation dust NOTAMs.",
          "Issue road-visibility warnings for national highways in Sindh / South Punjab.",
          "Health departments to increase respiratory-clinic capacity in flagged districts.",
        ],
      },
      aod: {
        signifies:
          "Aerosol Optical Depth — total column aerosol loading. High AOD indicates dense atmospheric particulates (dust, smoke, pollution) between the surface and satellite.",
        risks:
          "Combined visibility and health impact — often correlates with elevated PM2.5 at surface. Reduces surface solar irradiance (agriculture / power).",
        mitigation: [
          "Cross-reference with PM2.5 station data to confirm surface impact before issuing public advisory.",
          "Alert utilities to expected drop in solar generation for the flagged period.",
        ],
      },
      no2: {
        signifies:
          "Tropospheric nitrogen dioxide — a proxy for combustion sources (traffic, power plants, industry). WHO 24-hour AQ Guideline is 25 µg/m³.",
        risks:
          "Respiratory irritation, aggravated asthma, and contribution to secondary ozone / particulate formation.",
        mitigation: [
          "Advise traffic-heavy district administrations on rush-hour diversion where feasible.",
          "Coordinate with EPA on industrial-source monitoring at flagged locations.",
        ],
      },
      co: {
        signifies:
          "Carbon monoxide — incomplete combustion product; primary sources are vehicle exhaust and biomass burning. EPA 8-hour standard is 10 mg/m³.",
        risks:
          "Headache, dizziness, unconsciousness in enclosed spaces; cardiovascular stress at chronic exposure.",
        mitigation: [
          "Health department briefing to hospital ERs on CO-poisoning signs during flagged periods.",
          "Coordinate with municipal environment cells on biomass-burning restrictions.",
        ],
      },
      so2: {
        signifies:
          "Sulphur dioxide — mainly from thermal power plants and industry. WHO 24-hour guideline is 40 µg/m³.",
        risks:
          "Bronchoconstriction, aggravated asthma, contribution to acid deposition affecting agriculture and infrastructure.",
        mitigation: [
          "Cross-check with power-generation dispatch data; recommend fuel-switching where thermal capacity dominates.",
          "Issue advisory for asthma patients in flagged districts.",
        ],
      },
      rainfall_station: {
        signifies:
          "Rainfall observed at PMD / hydrometric stations across the flagged districts.",
        risks:
          "Same envelope as precipitation kind — flash floods, riverine flooding, landslides.",
        mitigation: [
          "Same as precipitation — activate flood control rooms, brief FFD, pre-position pumping capacity.",
        ],
      },
      temperature_station: {
        signifies:
          "Air temperature observed at PMD stations. Values ≥35 °C flag heat exposure per PMD advisory ladder.",
        risks:
          "Same envelope as temperature kind — heat-stroke, grid overload, wildfire.",
        mitigation: [
          "Same as temperature — open cooling centres, brief health departments, adjust outdoor-work timings.",
        ],
      },
    };
    return G[kind] || {
      signifies: "Observation at the sampled districts.",
      risks: "Refer to the applicable NDMA / PMD advisory for this parameter.",
      mitigation: [
        "Coordinate with the relevant technical agency (PMD / FFD / EPA) for parameter-specific guidance.",
        "Monitor over the next several time steps for trend confirmation before escalating response.",
      ],
    };
  }

  // -------------------------------------------------------------- destroy
  destroy() {
    // Single source of truth — same path used on panel close.  No need
    // to also clear #renderRafId because the throttle uses setTimeout
    // and #detachListeners clears that.
    this.#detachListeners();
  }

  // ================================================================
  //  Drag + Resize (mirrors heatwave-modal pattern)
  // ================================================================
  //  * Drag handle  = the whole `.wrp-header` row (tagged data-wrp-drag).
  //  * Resize grip  = 22×22 corner element (data-wrp-resize).
  //  * pinToPixels  = converts the rail-anchored top/right offsets into
  //                   absolute left/top + explicit width/height so
  //                   subsequent moves aren't fighting the anchoring
  //                   rule from anchorRailPanelsToButtons().
  //  * Listeners: pointerdown attaches move/up ONLY for the duration of
  //    the gesture and removes them on release — nothing runs while
  //    the panel is idle.
  //  * Pointer capture makes single-touch reliable across the whole
  //    viewport even when the pointer leaves the handle bounds.
  // ================================================================
  #attachDragAndResize(panel) {
    const drag   = panel.querySelector("[data-wrp-drag]");
    const resize = panel.querySelector("[data-wrp-resize]");

    // Position helper — always use setProperty with 'important' because
    // BOTH .right-rail-panel { left: auto !important } (map-panels.css)
    // AND .weather-report-panel { height: min(...) !important } beat
    // plain inline styles.  Without the important flag, panel.style.left
    // is silently ignored and the panel snaps to the map's left edge
    // the moment we set right:auto during pinToPixels().
    const setPx = (name, value) => panel.style.setProperty(name, value, "important");

    const pinToPixels = () => {
      const r = panel.getBoundingClientRect();
      setPx("left",   `${Math.round(r.left)}px`);
      setPx("top",    `${Math.round(r.top)}px`);
      setPx("right",  "auto");
      setPx("bottom", "auto");
      setPx("width",  `${Math.round(r.width)}px`);
      setPx("height", `${Math.round(r.height)}px`);
      // Once user-positioned, opt this panel out of the rail's
      // per-tick anchoring loop so anchorRailPanelsToButtons() doesn't
      // teleport it back after each render.
      panel.dataset.wrpUserPositioned = "true";
    };

    // Drag from header (but not from the interactive children — otherwise
    // pointerdown captures the pointer and swallows the click that would
    // have hit the close / export / tab buttons).  Any button inside the
    // header's action cluster is opted out here.
    if (drag) {
      drag.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".wrp-close-btn"))       return;
        if (e.target.closest(".wrp-export-btn"))      return;
        if (e.target.closest(".wrp-header-actions"))  return;
        if (e.target.closest("[data-tab]"))           return;
        if (e.button !== undefined && e.button !== 0) return;

        pinToPixels();
        const startX = e.clientX;
        const startY = e.clientY;
        const startLeft = parseFloat(panel.style.left) || 0;
        const startTop  = parseFloat(panel.style.top)  || 0;
        panel.classList.add("is-dragging");
        try { drag.setPointerCapture(e.pointerId); } catch (_) {}

        const onMove = (ev) => {
          const margin = 8;
          const w = panel.offsetWidth;
          const h = panel.offsetHeight;
          let nl = startLeft + (ev.clientX - startX);
          let nt = startTop  + (ev.clientY - startY);
          nl = Math.max(margin, Math.min(window.innerWidth  - w - margin, nl));
          nt = Math.max(margin, Math.min(window.innerHeight - h - margin, nt));
          setPx("left", `${Math.round(nl)}px`);
          setPx("top",  `${Math.round(nt)}px`);
        };
        const onUp = () => {
          panel.classList.remove("is-dragging");
          try { drag.releasePointerCapture(e.pointerId); } catch (_) {}
          drag.removeEventListener("pointermove",   onMove);
          drag.removeEventListener("pointerup",     onUp);
          drag.removeEventListener("pointercancel", onUp);
        };
        drag.addEventListener("pointermove",   onMove);
        drag.addEventListener("pointerup",     onUp);
        drag.addEventListener("pointercancel", onUp);
        e.preventDefault();
      });
    }

    // Bottom-right corner resize
    if (resize) {
      // Min sizes chosen to keep the PMD tables' 6-column layout
      // readable at the smallest allowed width.
      const MIN_W = 460;
      const MIN_H = 320;

      resize.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        pinToPixels();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = panel.offsetWidth;
        const startH = panel.offsetHeight;
        const startLeft = parseFloat(panel.style.left) || 0;
        const startTop  = parseFloat(panel.style.top)  || 0;
        panel.classList.add("is-resizing");
        try { resize.setPointerCapture(e.pointerId); } catch (_) {}

        const onMove = (ev) => {
          const margin = 8;
          const maxW = window.innerWidth  - startLeft - margin;
          const maxH = window.innerHeight - startTop  - margin;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          const w = Math.max(MIN_W, Math.min(maxW, startW + dx));
          const h = Math.max(MIN_H, Math.min(maxH, startH + dy));
          setPx("width",  `${Math.round(w)}px`);
          setPx("height", `${Math.round(h)}px`);
        };
        const onUp = () => {
          panel.classList.remove("is-resizing");
          try { resize.releasePointerCapture(e.pointerId); } catch (_) {}
          resize.removeEventListener("pointermove",   onMove);
          resize.removeEventListener("pointerup",     onUp);
          resize.removeEventListener("pointercancel", onUp);
        };
        resize.addEventListener("pointermove",   onMove);
        resize.addEventListener("pointerup",     onUp);
        resize.addEventListener("pointercancel", onUp);
        e.preventDefault();
        e.stopPropagation();
      });
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Serialise a bbox tuple [w,s,e,n] to a `data-fly-bbox="w,s,e,n"`
// attribute fragment.  Returns "" if the bbox is missing/invalid so
// the card just renders without the click affordance instead of
// rendering with a broken value.
function bboxAttr(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return "";
  if (!bbox.every(Number.isFinite)) return "";
  return `data-fly-bbox="${bbox.map((n) => n.toFixed(4)).join(",")}"`;
}
