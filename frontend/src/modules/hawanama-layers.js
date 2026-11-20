// hawanama-layers.js
// Hawanama (Pakistan Air Quality Initiative) layers for NCOP's Air Quality
// accordion — CC BY 4.0, attribution carried on every source:
//   temporal (temp-slider1):
//     hawanama_pm25_estimate          daily PM2.5 estimate tiles, last 30 days
//     hawanama_pm25_estimate_stations same + that day's ground-station means
//     hawanama_pm25_forecast          gridded forecast +3..+72 h (beta)
//     hawanama_pm25_nowcast           station nowcast +3/6/12/24 h
//   toggle (point layers): hawanama_stations, hawanama_fire_outlook
// All data comes through NCOP's /api/hawanama/ proxy (hawanama_views.py).

import { HAWANAMA_ATTRIBUTION } from "./hawanama-popups.js";

const API = `${window.location.origin}/api/hawanama`;
const ESTIMATE_DAYS_DEFAULT = 30;
const LABEL_TARGET = 8;
const ESTIMATE_TILE_MAX_ZOOM = 9;

// US EPA PM2.5 breakpoints (2024) → colours, for PM2.5-only point layers.
const PM25_COLOR = [
  "step", ["to-number", ["get", "pm25"], -1],
  "#9ca3af",   // no data
  0, "#00e400",
  9.1, "#ffff00",
  35.5, "#ff7e00",
  55.5, "#ff0000",
  125.5, "#8f3f97",
  225.5, "#7e0023",
];

function pm25ColorFor(prop) {
  const expr = JSON.parse(JSON.stringify(PM25_COLOR));
  expr[1] = ["to-number", ["get", prop], -1];
  return expr;
}

function pickLabelIndices(total, target = LABEL_TARGET) {
  if (total <= target) return null;
  const picks = new Set();
  for (let i = 0; i < target; i++) picks.add(Math.round((i * (total - 1)) / (target - 1)));
  return picks;
}

function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

function pktLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit",
                                      minute: "2-digit", hour12: false });
}

async function getJson(url) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Daily PM2.5 estimate (optionally with that day's ground stations)
// ---------------------------------------------------------------------------

export function estimateLayerId(date) {
  return `hawanama_pm25_est_${date}`;
}

function buildEstimateFrame(date, index, n, dateMeta, showLabel, withStations) {
  const id = estimateLayerId(date);
  const raster = {
    id,
    type: "raster",
    tiles: [`${API}/tiles/${date}/{z}/{x}/{y}.png`],
    tileSize: 256,
    minzoom: dateMeta.minzoom ?? 0,
    // Capped at z9: the estimate is a ~1 km grid and a z9 pixel is already
    // ~260 m over Pakistan, so Mapbox over-zooms z9 tiles beyond that
    // instead of requesting z10-12 for every slider frame (which flooded
    // the tile endpoint with requests and errors on deep zoom).
    maxzoom: Math.min(dateMeta.maxzoom ?? 12, ESTIMATE_TILE_MAX_ZOOM),
    bounds: dateMeta.bounds,
    attribution: HAWANAMA_ATTRIBUTION,
  };
  const visible = index === n - 1;
  const layers = [{
    id, type: "raster", source: id, layout: { visibility: "visible" },
    paint: { "raster-opacity": visible ? 0.85 : 0, "raster-fade-duration": 300 },
  }];
  const entry = { layers, date: showLabel ? shortDate(date) : "", dateFull: shortDate(date), hawanamaDate: date };
  if (!withStations) {
    entry.source = raster;
    return entry;
  }
  const sid = `hawanama_daily_stations_${date}`;
  entry.sources = [raster, { id: sid, type: "geojson", data: `${API}/stations/daily/${date}/`,
                             attribution: HAWANAMA_ATTRIBUTION }];
  layers.push({
    id: sid, type: "circle", source: sid,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 3, 8, 6, 11, 9],
      "circle-color": PM25_COLOR,
      "circle-opacity": visible ? 0.95 : 0,
    },
  });
  return entry;
}

export function generateHawanamaEstimateLoader({ days = ESTIMATE_DAYS_DEFAULT, withStations = false } = {}) {
  let cache = null;
  return async function loadHawanamaEstimate() {
    if (cache) return cache;
    let meta;
    try {
      meta = await getJson(`${API}/tiles/dates/?limit=${Math.max(days, 1)}`);
    } catch (e) {
      console.warn("[hawanama] estimate dates unavailable:", e);
      return [];
    }
    const dates = (meta.dates || []).slice(-days);
    if (!dates.length) return [];
    const showAt = pickLabelIndices(dates.length);
    const frames = dates.map((d, i) =>
      buildEstimateFrame(d, i, dates.length, meta, showAt === null || showAt.has(i), withStations));
    frames.initialIndex = frames.length - 1; // open on the newest day (temporal-controls honours this)
    cache = frames;
    return frames;
  };
}

// ---------------------------------------------------------------------------
// Gridded forecast (+3..+72 h, beta) — image frames rendered server-side
// ---------------------------------------------------------------------------

export function generateHawanamaForecastLoader() {
  let cache = null;
  let cachedAt = 0;
  return async function loadHawanamaForecast() {
    if (cache && Date.now() - cachedAt < 15 * 60 * 1000) return cache;
    let data;
    try {
      data = await getJson(`${API}/forecast/`);
    } catch (e) {
      console.warn("[hawanama] forecast unavailable:", e);
      return [];
    }
    const run = String(data.init_time || "").replace(/[^0-9]/g, "").slice(0, 12);
    const frames = (data.frames || []).map((f, i) => {
      const id = `hawanama_pm25_fc_${run}_${f.lead_h}`;
      const label = `+${f.lead_h}h ${pktLabel(f.valid_time)}`;
      return {
        source: { id, type: "image", url: f.url, coordinates: f.coordinates },
        layers: [{
          id, type: "raster", source: id, layout: { visibility: "visible" },
          paint: { "raster-opacity": i === 0 ? 0.8 : 0, "raster-fade-duration": 300 },
        }],
        date: `+${f.lead_h}h`,
        dateFull: label,
      };
    });
    cache = frames;
    cachedAt = Date.now();
    return frames;
  };
}

// ---------------------------------------------------------------------------
// Station nowcast (+3/6/12/24 h) — one circle frame per lead
// ---------------------------------------------------------------------------

export function nowcastLayerId(lead) {
  return `hawanama_nowcast_${lead}`;
}

export function generateHawanamaNowcastLoader() {
  let cache = null;
  let cachedAt = 0;
  return async function loadHawanamaNowcast() {
    if (cache && Date.now() - cachedAt < 15 * 60 * 1000) return cache;
    let gj;
    try {
      gj = await getJson(`${API}/nowcast/`);
    } catch (e) {
      console.warn("[hawanama] nowcast unavailable:", e);
      return [];
    }
    const leads = gj.metadata?.leads || [];
    const validTimes = gj.metadata?.valid_times || {};
    // One shared GeoJSON (fetched once, inlined) re-styled per lead.
    const frames = leads.map((lead, i) => {
      const id = nowcastLayerId(lead);
      const prop = `pm25_${lead}`;
      return {
        source: { id, type: "geojson", data: gj, attribution: HAWANAMA_ATTRIBUTION },
        layers: [{
          id, type: "circle", source: id,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 4,
              ["case", ["==", ["get", "forecastable"], true], 4, 2.5], 10,
              ["case", ["==", ["get", "forecastable"], true], 9, 6]],
            "circle-color": pm25ColorFor(prop),
            "circle-opacity": i === 0 ? 0.92 : 0,
          },
        }],
        date: `+${lead}h`,
        dateFull: `+${lead}h · ${pktLabel(validTimes[String(lead)])}`,
      };
    });
    cache = frames;
    cachedAt = Date.now();
    return frames;
  };
}

// ---------------------------------------------------------------------------
// Toggle (point) layers
// ---------------------------------------------------------------------------

const AQI_COLOR = [
  "step", ["to-number", ["get", "aqi"], -1],
  "#9ca3af", 0, "#00e400", 51, "#ffff00", 101, "#ff7e00", 151, "#ff0000", 201, "#8f3f97", 301, "#7e0023",
];

export const hawanamaToggleItems = {
  hawanama_stations: {
    label: "Hawanama Stations — PM2.5 (PAQI)",
    source: {
      id: "hawanama_stations-source",
      type: "geojson",
      data: `${API}/stations/`,
      attribution: HAWANAMA_ATTRIBUTION,
    },
    layers: [
      {
        id: "hawanama_stations-glow",
        type: "circle",
        source: "hawanama_stations-source",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["to-number", ["get", "aqi"], 0], 0, 8, 150, 14, 300, 20, 500, 24],
          "circle-color": AQI_COLOR,
          "circle-blur": 1.2,
          "circle-opacity": 0.25,
        },
      },
      {
        id: "hawanama_stations-circle",
        type: "circle",
        source: "hawanama_stations-source",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["to-number", ["get", "aqi"], 0], 0, 4, 100, 7, 200, 10, 300, 12, 500, 14],
          "circle-color": AQI_COLOR,
          "circle-stroke-width": 1.2,
          "circle-stroke-color": ["case", [">=", ["to-number", ["get", "aqi"], 0], 151], "#ffffff", "#1f2937"],
          // Readings older than 3 h are drawn faded, not hidden.
          "circle-opacity": ["case", ["==", ["get", "reading_stale"], true], 0.35, 0.9],
        },
      },
      {
        id: "hawanama_stations-label",
        type: "symbol",
        source: "hawanama_stations-source",
        minzoom: 8,
        layout: {
          "text-field": ["to-string", ["coalesce", ["get", "aqi"], ""]],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 10,
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": ["case", [">=", ["to-number", ["get", "aqi"], 0], 151], "#ffffff", "#000000"],
          "text-halo-color": ["case", [">=", ["to-number", ["get", "aqi"], 0], 151], "rgba(0,0,0,0.6)", "rgba(255,255,255,0.8)"],
          "text-halo-width": 1.2,
        },
      },
    ],
    popup: true,
    information:
      "Hourly PM2.5 and US AQI from ~320 stations in Pakistan (PAQI low-cost sensors, IQAir, Punjab EPA and Urban Unit reference monitors), via the Pakistan Air Quality Initiative's Hawanama platform. Faded dots: no reading in the last 3 hours. Click a station for its 48-hour and 30-day PM2.5 history. Data: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0.",
  },
  hawanama_fire_outlook: {
    label: "Crop-Fire Smoke Outlook (Hawanama)",
    source: {
      id: "hawanama_fire_outlook-source",
      type: "geojson",
      data: `${API}/fires/outlook/`,
      attribution: HAWANAMA_ATTRIBUTION,
    },
    layers: [
      {
        id: "hawanama_fire_outlook-circle",
        type: "circle",
        source: "hawanama_fire_outlook-source",
        paint: {
          "circle-radius": ["match", ["get", "band"], "very_high", 11, "high", 9, "elevated", 7, "low", 5, 3.5],
          "circle-color": ["match", ["get", "band"],
            "very_high", "#7e0023", "high", "#ff0000", "elevated", "#ff7e00", "low", "#ffd000", "#9ca3af"],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#111827",
          "circle-opacity": 0.9,
        },
      },
      {
        id: "hawanama_fire_outlook-label",
        type: "symbol",
        source: "hawanama_fire_outlook-source",
        minzoom: 6,
        filter: ["in", ["get", "band"], ["literal", ["elevated", "high", "very_high"]]],
        layout: {
          "text-field": ["get", "city"],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 10,
          "text-offset": [0, 1.2],
        },
        paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.7)", "text-halo-width": 1.2 },
      },
    ],
    popup: true,
    information:
      "Next-day smoke-source outlook for 104 Pakistani cities: total fire radiative power (VIIRS fires, NOAA-20/21) upwind under the ECMWF forecast wind. A screening outlook, not a PM2.5 forecast and not proof that fires cause local pollution. Data: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0.",
  },
};

export const hawanamaTemporalItems = {
  hawanama_pm25_estimate: {
    label: "PM2.5 Estimate — daily (Hawanama)",
    thumbnail: "pm25_daily_hawanama.webp",
    type: "raster",
    theme: "slider",
    title: "PM2.5 Estimate, daily (µg/m³) — Hawanama",
    information:
      "Satellite-supported machine-learning estimate of daily mean PM2.5 across Pakistan (Pakistan Air Quality Initiative). Last 30 days; opens on the newest complete day. Click the map for the estimated value at a point. Data: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0.",
  },
  hawanama_pm25_estimate_stations: {
    label: "PM2.5 Estimate + Ground Stations (Hawanama)",
    thumbnail: "pm25_ground_station_hawanama.webp",
    type: "raster",
    theme: "slider",
    title: "PM2.5 Estimate vs Stations, daily (µg/m³) — Hawanama",
    information:
      "The daily PM2.5 estimate with the same day's ground-station daily means drawn on top in the same colour bands, for a visual check of the estimate against measurements. Data: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0.",
  },
  hawanama_pm25_forecast: {
    label: "PM2.5 Forecast +3 to +72 h (Hawanama, Beta)",
    thumbnail: "pm25_daily_hawanama.webp",
    type: "raster",
    theme: "slider",
    title: "PM2.5 Forecast (µg/m³) — Hawanama BETA",
    information:
      "Gridded PM2.5 forecast at +3, +6, +12, +24, +48 and +72 hours (0.1° grid, ECMWF IFS + satellite inputs). Marked beta by its producer. A separate product from the daily estimate — do not read the two as one timeline. Data: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0.",
  },
  hawanama_pm25_nowcast: {
    label: "Station PM2.5 Nowcast +3 to +24 h (Hawanama)",
    thumbnail: "pm25_ground_station_hawanama.webp",
    type: "circle",
    theme: "slider",
    title: "Station PM2.5 Nowcast (µg/m³) — Hawanama",
    information:
      "Short-range PM2.5 forecast at each monitoring station (+3, +6, +12, +24 h). Small dots: stations without enough recent data, estimated from neighbouring stations. Click a station for the forecast's 75th/90th-percentile range. Data: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0.",
  },
};

export function registerHawanamaTemporalLoaders() {
  window.hawanama_pm25_estimate = generateHawanamaEstimateLoader();
  window.hawanama_pm25_estimate_stations = generateHawanamaEstimateLoader({ withStations: true });
  // Same daily estimate, newest 7 days only — used by the National Air
  // Quality Watch story so it loads 7 frames instead of 30.
  window.hawanama_pm25_estimate_week = generateHawanamaEstimateLoader({ days: 7 });
  window.hawanama_pm25_forecast = generateHawanamaForecastLoader();
  window.hawanama_pm25_nowcast = generateHawanamaNowcastLoader();
}

// ---------------------------------------------------------------------------
// Click on the daily estimate → value at that point for the shown date
// ---------------------------------------------------------------------------

function activeEstimateDate(map) {
  const layers = map.getStyle()?.layers || [];
  for (const l of layers) {
    if (!l.id.startsWith("hawanama_pm25_est_")) continue;
    const op = map.getPaintProperty(l.id, "raster-opacity");
    if (typeof op === "number" && op > 0.01) return l.id.slice("hawanama_pm25_est_".length);
  }
  return null;
}

let _clickInstalled = false;
export function installHawanamaEstimateClick(map, mapboxgl) {
  if (_clickInstalled || !map || !mapboxgl) return;
  _clickInstalled = true;
  let popup = null;
  map.on("click", async (e) => {
    const date = activeEstimateDate(map);
    if (!date) return;
    // Let vector-feature popups (stations etc.) win when one was clicked.
    const hit = map.queryRenderedFeatures(e.point).some((f) => f.layer?.type !== "raster" && !f.layer?.id?.startsWith("mapbox"));
    if (hit) return;
    const { lng, lat } = e.lngLat;
    try {
      const d = await (await fetch(`${API}/point/?date=${date}&lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`,
                                   { credentials: "same-origin" })).json();
      const v = d.pm25 === null || d.pm25 === undefined ? "no estimate here" : `${Number(d.pm25).toFixed(0)} µg/m³`;
      if (popup) popup.remove();
      popup = new mapboxgl.Popup({ closeButton: true, className: "ncop-popup-host", maxWidth: "240px" })
        .setLngLat(e.lngLat)
        .setHTML(`<div class="ncop-popup"><div class="ncop-popup__title">PM2.5 estimate ${date}</div>
          <div class="ncop-popup__subtitle" style="font-size:15px;font-weight:700;margin:4px 0;">${v}</div>
          <div class="ncop-popup__status-note" style="display:block;">Daily mean, ML estimate · ${HAWANAMA_ATTRIBUTION}</div></div>`)
        .addTo(map);
    } catch (err) {
      console.warn("[hawanama] point value failed", err);
    }
  });
}
