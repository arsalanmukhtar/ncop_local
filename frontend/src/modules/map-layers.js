import { Popup } from "mapbox-gl";
import {map_icons} from "./map-icons.js"

import {
  generateDWDSatelliteLayers,
  generateECMWFTempLayers,
  generateECMWFCycloneLayers,
  generateECMWFLightningLayers,
  generatePM25Layers,
  generatePM10Layers,
  generateNO2Layers,
  generateSO2Layers,
  generateO3Layers,
  generateCOLayers,
  generateDustLayers,
  generateCH4300Layers,
  generateGDPSHumLayers,
  generateGDPSAccPreciLayers,
  generateGDPSPreciTypesLayers,
  generateOceanSalinityLayers,
  generateOceanTemperatureLayers,
  generateOceanCurrentsLayers,
  generateOceanSurfaceHeightLayers,
  generateMeteoblueNEMSCloudPrecipLayers,
  generateMBX_MeteoblueHourlyCloudPrecipLayers,
  generateMBX_MeteoblueHourlyTemperatureLayers,
  generateMBX_MeteoblueRadarCompositeLayers,
  generateMBX_MeteoblueSnowfallHourlyLayers,
  generateMBX_MeteoblueCAPEHourlyLayers,
  generateMBX_MeteoblueStormHelicityHourlyLayers,
  generateMBX_MeteoblueDailySnowfallLayers,
  generateMBX_MeteoblueDailyCAPELayers,
  generateMBX_MeteoblueOfficialWeatherWarningsLayers,
  generateMBX_MeteoblueForecastWarningsDailyLayers,
  generateMBX_IMERGPrecipRateLayers,
} from "./time-functions.js";
// Global baseUrl for the entire application
window.baseUrl = window.location.origin;
export const baseUrl = window.baseUrl;
// Layer thumbnails can be added in loop by importing images like below
const images = import.meta.glob("@assets/images/layer_thumbnails/*.webp", { eager: true });
// Use this function name with image name to load it e.g. getImage('airports.webp')
function getImage(filename) {
    const match = Object.entries(images).find(([path]) => path.includes(filename));
    return match ? match[1].default : null;
}

// ======================================================
// Sync JSON → GeoJSON helpers (no async/await required)
// ======================================================
//
// main use:
// const fc = jsonUrlToGeoJsonSync("https://.../latest.json");
// map.addSource("...", { type: "geojson", data: fc });
//
// NOTE: This uses a synchronous XHR (blocking). That's intentional
// because we need data immediately at config-build time.
//

/**
 * Fetch remote JSON synchronously, convert it to a GeoJSON FeatureCollection.
 * Always returns a valid FeatureCollection, even on error.
 */
function jsonUrlToGeoJsonSync(url) {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", url, false); // false => block until done

  try {
    xhr.send(null);
  } catch (e) {
    console.error("jsonUrlToGeoJsonSync: network error for", url, e);
    return emptyFC();
  }

  if (xhr.status < 200 || xhr.status >= 300) {
    console.error("jsonUrlToGeoJsonSync:", url, "bad status", xhr.status);
    return emptyFC();
  }

  let data;
  try {
    data = JSON.parse(xhr.responseText);
  } catch (err) {
    console.error("jsonUrlToGeoJsonSync:", url, "invalid JSON", err);
    return emptyFC();
  }

  return buildFC(data);
}

/**
 * Small helper: return an empty but valid FeatureCollection.
 */
function emptyFC() {
  return { type: "FeatureCollection", features: [] };
}

/**
 * Turn an arbitrary nested object into a FeatureCollection.
 * We scan for any arrays whose objects look like they have coordinates.
 */
function buildFC(obj) {
  const arrays = collectGeoArrays(obj);
  const features = [];

  for (const arr of arrays) {
    for (const item of arr) {
      const feat = toPointFeature(item);
      if (feat) features.push(feat);
    }
  }

  return { type: "FeatureCollection", features };
}

/**
 * Recursively walk the object, collecting arrays that appear "geospatial".
 * "Geospatial" = at least one element that looks like it has lon/lat.
 */
function collectGeoArrays(root) {
  const found = [];

  (function walk(node) {
    if (!node) return;

    if (Array.isArray(node)) {
      // If array contains point-like objects, record it.
      if (looksGeospatial(node)) found.push(node);

      // Still descend in case there are nested arrays deeper.
      for (const child of node) {
        if (child && typeof child === "object") walk(child);
      }
      return;
    }

    if (typeof node === "object") {
      for (const k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) {
          walk(node[k]);
        }
      }
    }
  })(root);

  return found;
}

/**
 * Quick heuristic: check first object-like element in array and see
 * if we can extract coords from it.
 */
function looksGeospatial(arr) {
  const firstObj = arr.find(
    (el) => el && typeof el === "object" && !Array.isArray(el)
  );
  return !!firstObj && !!extractCoords(firstObj);
}

/**
 * Convert one data record into a GeoJSON Point feature.
 * Returns null if no usable coords.
 */
function toPointFeature(props) {
  const coords = extractCoords(props);
  if (!coords) return null;

  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: coords },
    properties: { ...props },
  };
}

/**
 * Try to pull [lon, lat] from flexible field names like:
 * long/lat, lon/lat, lng/lat, longitude/latitude, x/y, etc.
 *
 * Returns [lon, lat] as numbers, or null if invalid.
 */
function extractCoords(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Preferred explicit pairs to test in order.
  const pairs = [
    ["long", "lat"],
    ["lon", "lat"],
    ["lng", "lat"],
    ["longitude", "latitude"],
    ["x", "y"],
    ["Long", "Lat"],
    ["LONG", "LAT"],
  ];

  for (const [lonKey, latKey] of pairs) {
    if (lonKey in obj && latKey in obj) {
      const lon = toNum(obj[lonKey]);
      const lat = toNum(obj[latKey]);
      if (validCoord(lon, lat)) return [lon, lat];
    }
  }

  // Loose fallback: find any plausible lon-ish / lat-ish keys.
  const lonKeys = ["long", "lng", "lon", "longitude", "x", "LONG", "Long"];
  const latKeys = ["lat", "latitude", "y", "LAT", "Lat"];

  let lon, lat;

  for (const k of lonKeys) {
    if (k in obj) {
      lon = toNum(obj[k]);
      if (!Number.isNaN(lon)) break;
    }
  }
  for (const k of latKeys) {
    if (k in obj) {
      lat = toNum(obj[k]);
      if (!Number.isNaN(lat)) break;
    }
  }

  return validCoord(lon, lat) ? [lon, lat] : null;
}

/**
 * toNum(val):
 * - number → number
 * - "34,900" → 34900
 * - "72.7338000" → 72.7338
 * otherwise NaN
 */
function toNum(val) {
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const num = Number(val.trim().replace(/,/g, ""));
    if (!Number.isNaN(num)) return num;
  }
  return NaN;
}

/**
 * Basic lon/lat sanity (WGS84-ish).
 */
function validCoord(lon, lat) {
  return (
    typeof lon === "number" &&
    typeof lat === "number" &&
    !Number.isNaN(lon) &&
    !Number.isNaN(lat) &&
    lon >= -180 &&
    lon <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}
///
// This call BLOCKS until the JSON is fetched + converted.
// After this line, __FFD_GEOJSON__ is a real FeatureCollection.
const __FFD_GEOJSON__ = jsonUrlToGeoJsonSync(
  "https://raw.githubusercontent.com/Ibrahom1/hydrosituation/main/latest.json"
);
//Meteoblue Layers constants
const metbluT = window.metbluT;
const model = "NEMSIN";
const modelanomaly = "SA-ENSEMBLE";
//export let domain = "NEMSAUTO";
const level = "2 m above gnd";

// Defining the layer of temporal data
const dwd_layers = generateDWDSatelliteLayers();
const ecmwf_temp_layers = generateECMWFTempLayers();
const ecmwf_cyclone_layers = generateECMWFCycloneLayers();
const ecmwf_layers = generateECMWFLightningLayers();
const pm25_layers = generatePM25Layers();
const pm10_layers = generatePM10Layers();
const no2_layers = generateNO2Layers();
const so2_layers = generateSO2Layers();
const o3_layers = generateO3Layers();
const co_layers = generateCOLayers();
const dust_layers = generateDustLayers();
const ch4300_layers = generateCH4300Layers();
const gdps_hum_layers = generateGDPSHumLayers();
const gdps_accu_precip_layers = generateGDPSAccPreciLayers();
const gdps_preci_types_layers = generateGDPSPreciTypesLayers();
const ocean_salinity_layers = generateOceanSalinityLayers();
const ocean_temperature_layers = generateOceanTemperatureLayers();
const ocean_currents_layers = generateOceanCurrentsLayers();
const ocean_surface_height_layers = generateOceanSurfaceHeightLayers();
const nems_layers_weeklycloudprecip = generateMeteoblueNEMSCloudPrecipLayers(model, metbluT);
const mbx_hourly_cloudprecip = generateMBX_MeteoblueHourlyCloudPrecipLayers(model, metbluT);
const mbx_hourly_temp       = generateMBX_MeteoblueHourlyTemperatureLayers(model, level, metbluT);
const mbx_radar_composite   = generateMBX_MeteoblueRadarCompositeLayers(metbluT);
const mbx_snow_hourly       = generateMBX_MeteoblueSnowfallHourlyLayers(model, metbluT);
const mbx_cape_hourly       = generateMBX_MeteoblueCAPEHourlyLayers(model, metbluT);
const mbx_helicity_hourly   = generateMBX_MeteoblueStormHelicityHourlyLayers(model, metbluT);
const mbx_snow_daily        = generateMBX_MeteoblueDailySnowfallLayers(model, metbluT);
const mbx_cape_daily        = generateMBX_MeteoblueDailyCAPELayers(model, metbluT);
const mbx_warn_official     = generateMBX_MeteoblueOfficialWeatherWarningsLayers(metbluT);
const mbx_warn_forecast     = generateMBX_MeteoblueForecastWarningsDailyLayers(model, metbluT);
const mbx_imerg_precip_rate = generateMBX_IMERGPrecipRateLayers();

// Export the layer array globally for the time slider
window.dwd_satellite_infrared = dwd_layers;
window.ecmwf_temperature_850hPa = ecmwf_temp_layers;
window.ecmwf_cyclone = ecmwf_cyclone_layers;
window.ecmwf_lightning = ecmwf_layers;
window.particulate_matter_25 = pm25_layers;
window.particulate_matter_10 = pm10_layers;
window.nitrogen_dioxide_850hPa = no2_layers;
window.sulphur_dioxide_850hPa = so2_layers;
window.ozone = o3_layers;
window.carbon_monoxide = co_layers;
window.dust = dust_layers;
window.methane_at_300hPa = ch4300_layers;
window.specific_humidity_2m_above_ground = gdps_hum_layers;
window.gdps_accumulated_precipitation = gdps_accu_precip_layers;
window.precipitation_type_3hrs = gdps_preci_types_layers;
window.ocean_salinity = ocean_salinity_layers;
window.ocean_temperature = ocean_temperature_layers;
window.ocean_surface_currents = ocean_currents_layers;
window.ocean_surface_height = ocean_surface_height_layers;
window.weekly_precipitation_2m_above_ground = nems_layers_weeklycloudprecip;
window.hourly_precipitation_2m_above_ground = mbx_hourly_cloudprecip;
window.temperature_2m_above_ground = mbx_hourly_temp;
window.precipitation_radar = mbx_radar_composite;
window.hourly_snowfall_forecast = mbx_snow_hourly;
window.cape_hourly_forecast = mbx_cape_hourly;
window.storm_helicity_forecast_0_3km = mbx_helicity_hourly;
window.weekly_snowfall_forecast = mbx_snow_daily;
window.cape_weekly_forecast = mbx_cape_daily;
window.official_weather_warnings_forecast = mbx_warn_official;
window.meteorological_risks_forecast = mbx_warn_forecast;
window.imerg_precipitation_rate_14_days = mbx_imerg_precip_rate;
// console.log(
//   "✅ DWD layers created:",
//   window.dwd_satellite_infrared.length,
//   "steps"
// );

export const ncop_menu_items = {
  gis_layers: {
    "Administrative Boundaries": {
      toggle: {
        national_boundary: {
          label: "National Boundary",
          theme: null,
          geometry: "polygon",
          source: {
            id: "national_boundary-source",
            type: "vector",
            scheme: "tms",
            tiles: [
              "http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:national_boundary@EPSG:900913@pbf/{z}/{x}/{y}.pbf",
            ],
            maxzoom: 22,
          },
          layers: [
            {
              id: "national_boundary-fill",
              type: "fill",
              source: "national_boundary-source",
              "source-layer": "national_boundary",
              paint: {
                "fill-color": "#ffffff",
                "fill-opacity": 0,
              },
            },
            {
              id: "national_boundary-outline",
              type: "line",
              source: "national_boundary-source",
              "source-layer": "national_boundary",
              paint: {
                "line-color": "#000000",
                "line-width": 2.5,
              },
            },
          ],
          popup: true,
          information:
            "The National Boundary layer outlines the borders of the country, providing a clear demarcation of national territory. This layer is essential for understanding geopolitical boundaries and is often used as a reference for other spatial data layers.",
        },
        provincial_boundary: {
          label: "Provincial Boundary",
          theme: null,
          geometry: "polygon",
          source: {
            id: "provincial_boundary-source",
            type: "vector",
            scheme: "tms",
            tiles: [
              "http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:provincial_boundary@EPSG:900913@pbf/{z}/{x}/{y}.pbf",
            ],
            maxzoom: 22,
          },
          layers: [
            {
              id: "provincial_boundary-fill",
              type: "fill",
              source: "provincial_boundary-source",
              "source-layer": "provincial_boundary",
              paint: {
                "fill-color": "#ffffff",
                "fill-opacity": 0,
              },
            },
            {
              id: "provincial_boundary-outline",
              type: "line",
              source: "provincial_boundary-source",
              "source-layer": "provincial_boundary",
              paint: {
                "line-color": "#e74c3c",
                "line-width": 2,
              },
            },
          ],
          popup: true,
          information:
            "The Provincial Boundary layer delineates the borders of provinces within the country. This layer is crucial for regional planning and analysis, allowing users to visualize and manage data at the provincial level.",
        },
        district_boundary: {
          label: "District Boundary",
          theme: null,
          source: {
            id: "district_boundary-source",
            type: "vector",
            scheme: "tms",
            tiles: [
              "http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:district_boundary@EPSG:900913@pbf/{z}/{x}/{y}.pbf",
            ],
            maxzoom: 22,
          },
          layers: [
            {
              id: "district_boundary-fill",
              type: "fill",
              source: "district_boundary-source",
              "source-layer": "district_boundary",
              paint: {
                "fill-color": "#ffffff",
                "fill-opacity": 0,
              },
            },
            {
              id: "district_boundary-outline",
              type: "line",
              source: "district_boundary-source",
              "source-layer": "district_boundary",
              paint: {
                "line-color": "#27ae60",
                "line-width": 1.5,
              },
            },
          ],
          popup: true,
          information:
            "The District Boundary layer outlines the borders of districts within the country. This layer is important for local governance and resource management, providing a clear framework for administrative boundaries.",
        },
        tehsil_boundary: {
          label: "Tehsil Boundary",
          theme: null,
          source: {
            id: "tehsil_boundary-source",
            type: "vector",
            scheme: "tms",
            tiles: [
              "http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:tehsil_boundary@EPSG:900913@pbf/{z}/{x}/{y}.pbf",
            ],
            maxzoom: 22,
          },
          layers: [
            {
              id: "tehsil_boundary-fill",
              type: "fill",
              source: "tehsil_boundary-source",
              "source-layer": "tehsil_boundary",
              paint: {
                "fill-color": "#ffffff",
                "fill-opacity": 0,
              },
            },
            {
              id: "tehsil_boundary-outline",
              type: "line",
              source: "tehsil_boundary-source",
              "source-layer": "tehsil_boundary",
              paint: {
                "line-color": "#e1b12c",
                "line-width": 1,
              },
            },
          ],
          popup: true,
          information:
            "The Tehsil Boundary layer marks the subdivisions within districts, known as tehsils. This layer is important for local governance and administrative purposes, helping to manage resources and services at a more granular level.",
        },
      },
    },
    Infrastructure: {
      toggle: {
        airports: {
          label: "Airports",
          theme: null,
          source: {
            id: "airports-source",
            type: "vector",
            scheme: "tms",
            tiles: [
              "http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:airports@EPSG:900913@pbf/{z}/{x}/{y}.pbf",
            ],
            maxzoom: 22,
          },
          layers: [
            {
              id: "airports-symbol",
              type: "symbol",
              source: "airports-source",
              "source-layer": "airports",
              layout: {
                "icon-image": map_icons.airportIcon, // Use custom icon name
                // Interpolate icon-size based on zoom for smooth scaling
                "icon-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  5,
                  0.25,
                  10,
                  0.5,
                  15,
                  1,
                ],
                "icon-allow-overlap": true,
              },
            },
          ],
          popup: true,
          information:
            "The Airports layer displays the locations of airports within the country. This layer is essential for transportation planning and logistics, providing critical information for air travel and connectivity.",
        },
        // hospitals: {
        //     label: "Hospitals",
        //     theme: null,
        //     source: {
        //         id: "hospitals-source",
        //         type: "vector",
        //         scheme: "tms",
        //         tiles: ["http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:hospitals@EPSG:900913@pbf/{z}/{x}/{y}.pbf"],
        //         maxzoom: 22
        //     },
        //     layers: [
        //         {
        //             id: "hospitals-symbol",
        //             type: "symbol",
        //             source: "hospitals-source",
        //             "source-layer": "hospitals",
        //             layout: {
        //                 "icon-image": "/static/icons/map_icons/layer_icons/hospital.webp", // Use custom icon name
        //                 // Interpolate icon-size based on zoom for smooth scaling
        //                 "icon-size": [
        //                     "interpolate",
        //                     ["linear"],
        //                     ["zoom"],
        //                     5, 0.25,
        //                     10, 0.5,
        //                     15, 1
        //                 ],
        //                 "icon-allow-overlap": true
        //             }
        //         }
        //     ],
        //     information: "The Hospitals layer displays the locations of hospitals within the country. This layer is essential for healthcare planning and emergency response, providing critical information for medical services and facilities.",
        // },
        schools: {
          label: "Schools",
          theme: null,
          source: {
            id: "schools-source",
            type: "vector",
            scheme: "tms",
            tiles: [
              "http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:schools@EPSG:900913@pbf/{z}/{x}/{y}.pbf",
            ],
            maxzoom: 22,
          },
          layers: [
            {
              id: "schools-symbol",
              type: "symbol",
              source: "schools-source",
              "source-layer": "schools",
              layout: {
                "icon-image": map_icons.schoolIcon, // Use custom icon name
                // Interpolate icon-size based on zoom for smooth scaling
                "icon-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  5,
                  0.25,
                  10,
                  0.5,
                  15,
                  1,
                ],
                "icon-allow-overlap": false,
              },
            },
          ],
          popup: true,
          information:
            "The Schools layer displays the locations of schools within the country. This layer is essential for education planning and resource allocation, providing critical information for educational services and facilities.",
        },
        settlements: {
          label: "Settlements",
          theme: null,
          source: {
            id: "settlements-source",
            type: "vector",
            scheme: "tms",
            tiles: [
              "http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:settlements@EPSG:900913@pbf/{z}/{x}/{y}.pbf",
            ],
            maxzoom: 22,
          },
          layers: [
            {
              id: "settlements-symbol",
              type: "symbol",
              source: "settlements-source",
              "source-layer": "settlements",
              layout: {
                "icon-image": map_icons.settlementIcon, // Use custom icon name
                // Interpolate icon-size based on zoom for smooth scaling
                "icon-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  5,
                  0.25,
                  10,
                  0.5,
                  15,
                  1,
                ],
                "icon-allow-overlap": false,
              },
            },
          ],
          information:
            "The Settlements layer displays the locations of settlements within the country. This layer is essential for urban planning and resource allocation, providing critical information for residential services and facilities.",
        },
        // evacuation_points: {
        //     label: "Evacuation Points",
        //     type: "geojson",
        //     theme: null,
        //     geometry: null,
        // },
      },
    },
    "Hydrological Layers": {
      toggle: {
        rsc_exceptionally_high_zone: {
          label: "RSC Exceptionally High Zone",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        rsc_very_high_zone: {
          label: "RSC Very High Zone",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        rsc_high_zone: {
          label: "RSC High Zone",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        rsc_medium_zone: {
          label: "RSC Medium Zone",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        rsc_low_zone: {
          label: "RSC Low Zone",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        watershed_boundaries: {
          label: "Watershed Boundaries",
          type: "geojson",
          theme: null,
          geometry: null,
        },
      },
    },
  },
  weather: {
    "Radar Layers": {
      temporal: {
        realtime_radar: {
          label: "Realtime Radar",
          image: getImage("rainViewer_radar_precip.webp"),
          type: "raster",
          theme: "slider",
          title: "Radar",
        },
        satellite_infrared: {
          label: "Satellite Infrared",
          image: getImage("rainViewer_satellite.webp"),
          type: "raster",
          theme: "slider",
          title: "Radar Clouds",
        },
        dwd_satellite_infrared: {
          label: "DWD Satellite Infrared",
          image: getImage("dwd_radar.webp"),
          theme: "slider",
          type: "raster",
          title: "DWD Radar (°C)",
          information:
            "The DWD Satellite Infrared layer provides real-time infrared satellite imagery from the German Weather Service (DWD). This layer is essential for monitoring cloud cover, weather patterns, and atmospheric conditions, aiding in weather forecasting and analysis.",
        },
        imerg_precipitation_rate_14_days: {
          label: "IMERG Precipitation Rate (14 Days)",
          image: getImage("IMERG_precip_rate_past12d.webp"),
          type: "raster",
          theme: "slider",
          title: null,
        },
      },
    },
    "Global Deterministic Prediction System (GDPS)": {
      temporal: {
        specific_humidity_2m_above_ground: {
          label: "Specific Humidity (2m Above Ground)",
          image: getImage("specific_humidity_weekly_2m_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Specific Humidity (g/kg)",
        },
        relative_humidity_percent: {
          label: "Relative Humidity (%)",
          image: getImage("Relative_humidity_weekly_2m_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        gdps_accumulated_precipitation: {
          label: "Accumulated Precipitation",
          image: getImage("Convective_precipitation_weekly_kgm2_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        precipitation_type_3hrs: {
          label: "Precipitation Type / 3hrs",
          image: getImage("Precipitation_3hourly_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Precipitation Type",
        },
      },
    },
    "ECMWF Weather Forecast Parameters": {
      temporal: {
        ecmwf_temperature_850hPa: {
          label: "Temperature (850hPa)",
          image: getImage("temperature_cams.webp"),
          type: "raster",
          theme: "slider",
          title: "Temperature (°C)",
        },
        ecmwf_lightning: {
          label: "Lightning Forecast",
          image: getImage("lightning_forcasting.webp"),
          type: "raster",
          theme: "slider",
          title: "Probability %",
        },
        ecmwf_cyclone: {
          label: "Tropical Cyclone Strike Probability",
          image: getImage("Tropical_Cyclone_strike_propability.webp"),
          type: "raster",
          theme: "slider",
          title: "Probability %",
        },
      },
    },
    "Meteoblue Forecast": {
      temporal: {
        weekly_precipitation_2m_above_ground: {
          label: "Weekly Precipitation (2m Above Ground)",
          image: getImage("nems_cloudprecipitation.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        hourly_precipitation_2m_above_ground: {
          label: "Hourly Precipitation (2m Above Ground)",
          image: getImage("nems_cloudprecipitation.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        hourly_snowfall_forecast: {
          label: "Hourly Snowfall (Forecast)",
          image: getImage("nems_snowfall_hourly.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        weekly_snowfall_forecast: {
          label: "Weekly Snow (Forecast)",
          image: getImage("nems_snowfall_weekly.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        cape_hourly_forecast: {
          label: "CAPE Hourly (Forecast)",
          image: getImage("nems_cape_hourly.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        cape_weekly_forecast: {
          label: "CAPE Weekly (Forecast)",
          image: getImage("nems_cape_hourly.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        storm_helicity_forecast_0_3km: {
          label: "Storm Helicity Forecast (0-3km)",
          image: getImage("nems_storms_helicity_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        precipitation_radar: {
          label: "Precipitation Radar",
          image: getImage("global_precipitation.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        temperature_2m_above_ground: {
          label: "Temperature (2m Above Ground)",
          image: getImage("meteoblue_nems_temperature.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        official_weather_warnings_forecast: {
          label: "Official Weather Warnings (Forecast)",
          image: getImage("nems_forecast_offical_warnings.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        meteorological_risks_forecast: {
          label: "Meteorological Risks (Forecast)",
          image: getImage("nems_forecast_met_warnings.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
      },
    },
    "Pakistan Meteorological Department (PMD)": {
      toggle: {
        pmd_weather_stations: {
          label: "PMD Weather Stations",
          theme: null,
          source: {
            id: "pmd_weather_stations-source",
            type: "geojson",
            data: `${baseUrl}/get-weather-pmdffd-data/`,
            maxzoom: 22,
          },
          layers: [
            {
              id: "pmd_weather_stations-symbol",
              type: "symbol",
              source: "pmd_weather_stations-source",
              layout: {
                "icon-image": map_icons.weatherStationIcon, // Use custom icon name
                // Interpolate icon-size based on zoom for smooth scaling
                "icon-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  5,
                  0.25,
                  10,
                  0.5,
                  15,
                  1,
                ],
                "icon-allow-overlap": true,
              },
            },
          ],
          popup: true,
          information:
            "The PMD Weather Stations layer displays the locations (with daily data) of weather stations managed by the Pakistan Meteorological Department (PMD). This layer is essential for monitoring real-time weather conditions and collecting meteorological data across the country.",
        },
      },
    },
    "Indian Meteorological Department (IMD)": {
      toggle: {
        precipitation_past_3_days: {
          label: "Precipitation (Past 3 Days)",
          type: "geojson",
          theme: null,
          geometry: null,
        },
      },
    },
  },
  flood: {
    "Flood Forecasting Division (FFD-Data)": {
      toggle: {
        ffd_data: {
          label: "FFD Data",
          theme: null,
          source: {
            id: "ffd_data-source",
            type: "geojson",
            data: __FFD_GEOJSON__, // fully populated FeatureCollection, synchronously created
          },
          layers: [
            {
              id: "ffd_data-circle",
              type: "circle",
              // Critical: must match source.id so SourceLayerControl wires it correctly
              source: "ffd_data-source",
              paint: {
                "circle-color": [
                  "match",
                  ["get", "status"],

                  "Normal",
                  "#28a745", // Green - Normal Flow
                  "NORMAL",
                  "#28a745", // Green - Normal Flow

                  "Low",
                  "#17a2b8", // Teal - Low Flood
                  "LOW",
                  "#17a2b8", // Teal - Low Flood

                  "Medium",
                  "#ffc107", // Yellow - Medium Flood
                  "MEDIUM",
                  "#ffc107", // Yellow - Medium Flood

                  "High",
                  "#fd7e14", // Orange - High Flood
                  "HIGH",
                  "#fd7e14", // Orange - High Flood

                  "Very High",
                  "#dc3545", // Red - Very High Flood
                  "VERY_HIGH",
                  "#dc3545", // Red - Very High Flood

                  "Exceptionally High",
                  "#6f42c1", // Purple - Exceptionally High Flood
                  "EX_HIGH",
                  "#6f42c1", // Purple - Exceptionally High Flood

                  "#999999", // default gray if none match
                ],
                "circle-opacity": 1,
                "circle-radius": 7,
                "circle-stroke-width": 2,
                "circle-stroke-color": "#FFFFFF",
              },
            },
            {
              id: "ffd_data-labels",
              type: "symbol",
              source: "ffd_data-source",
              layout: {
                "text-field": "{name} \n {outflow_discharge}",
                "text-size": 12,
                "text-offset": [0, -0.5],
                "text-anchor": "bottom",
                "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
              },
              paint: {
                "text-color": "white",
                "text-halo-color": "black",
                "text-halo-width": 1,
              },
            },
          ],
          popup: true,
          information:
            "The FFD Data layer displays real-time flood monitoring data from the Flood Forecasting Division (FFD). This layer is crucial for flood risk assessment and management, providing vital information on water levels and flood status across various locations.",
        },
      },
    },
    "Global Flood Awareness System (GloFAS)": {
      temporal: {
        precipitation_probability_50mm_10days: {
          label: "Precipitation Probability > 50mm (10 Days)",
          image: getImage("glofas-precip-prob-gt-50.webp"),
          type: "raster",
          theme: "legend",
          geometry: null,
        },
        precipitation_probability_150mm_10days: {
          label: "Precipitation Probability > 150mm (10 Days)",
          image: getImage("glofas-precip-prob-gt-150.webp"),
          type: "raster",
          theme: "legend",
          geometry: null,
        },
        precipitation_probability_300mm_10days: {
          label: "Precipitation Probability > 300mm (10 Days)",
          image: getImage("glofas-precip-prob-gt-300.webp"),
          type: "raster",
          theme: "legend",
          geometry: null,
        },
        accumulated_precipitation: {
          label: "Accumulated Precipitation",
          image: getImage("glofas-accu-precip.webp"),
          type: "raster",
          theme: "legend",
          geometry: null,
        },
        flood_summary_day_1_3: {
          label: "Flood Summary (Day 1-3)",
          image: getImage("glofas-flood-sum-1-30d.webp"),
          type: "raster",
          theme: "legend",
          geometry: null,
        },
        flood_summary_day_4_10: {
          label: "Flood Summary (Day 4-10)",
          image: getImage("glofas-flood-sum-1-30d.webp"),
          type: "raster",
          theme: "legend",
          geometry: null,
        },
      },
      toggle: {
        initial_temperature_at_2m: {
          label: "Initial Temperature at 2m",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        major_rivers: {
          label: "Major Rivers",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        major_river_basins: {
          label: "Major River Basins",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        lakes_and_reservoirs: {
          label: "Lakes and Reservoirs",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        soil_moisture_at_2m: {
          label: "Soil Moisture at 2m",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        soil_moisture_anomaly_at_2m: {
          label: "Soil Moisture Anomaly at 2m",
          type: "geojson",
          theme: null,
          geometry: null,
        },
      },
    },
  },
  air_quality: {
    "Real Time Air Quality Parameters": {
      temporal: {
        particulate_matter_25: {
          label: "Particulate Matter (2.5)",
          image: getImage("pm_2.5.webp"),
          type: "raster",
          theme: "slider",
          title: "PM2.5 (µg/m³)",
        },
        particulate_matter_10: {
          label: "Particulate Matter (10)",
          image: getImage("pm_10.webp"),
          type: "raster",
          theme: "slider",
          title: "PM10 (µg/m³)",
        },
        nitrogen_dioxide_850hPa: {
          label: "Nitrogen Dioxide (850hPa)",
          image: getImage("no2.webp"),
          type: "raster",
          theme: "slider",
          title: "Nitrogen Dioxide (ppbv)",
        },
        ozone: {
          label: "Ozone",
          image: getImage("O3.webp"),
          type: "raster",
          theme: "slider",
          title: "Ozone (µg/m³)",
        },
        sulphur_dioxide_850hPa: {
          label: "Sulphur Dioxide (850hPa)",
          image: getImage("SO2.webp"),
          type: "raster",
          theme: "slider",
          title: "Sulphur Dioxide (µg/m³)",
        },
        carbon_monoxide: {
          label: "Carbon Monoxide",
          image: getImage("CO.webp"),
          type: "raster",
          theme: "slider",
          title: "Carbon Monoxide (ppbv)",
        },
        dust: {
          label: "Dust",
          image: getImage("cams_composition_duaod550.webp"),
          type: "raster",
          theme: "slider",
          title: "Dust",
        },
        methane_at_300hPa: {
          label: "Methane at 300hPa",
          image: getImage("methane.webp"),
          type: "raster",
          theme: "slider",
          title: "Methane (ppbv)",
        },
      },
      toggle: {
        waqi_stations: {
          label: "WAQI-Stations Air Quality",
          source: {
            id: "waqi_stations-source",
            type: "geojson",
            data: `${baseUrl}/get-waqi-global-airquality/`,
            maxzoom: 22,
          },
          layers: [
            {
              id: "waqi_stations-circle",
              type: "circle",
              source: "waqi_stations-source",
              paint: {
                // Radius increases with AQI = visually proportional
                "circle-radius": [
                  "interpolate",
                  ["linear"],
                  ["get", "aqi"],
                  0,
                  4, // clean air -> small
                  50,
                  6,
                  100,
                  8,
                  150,
                  10,
                  200,
                  12,
                  300,
                  14,
                  500,
                  16, // terrible -> big
                ],

                // Color by AQI category
                "circle-color": [
                  "step",
                  ["get", "aqi"],
                  "#00e400", // 0-50   Good
                  51,
                  "#ffff00", // 51-100  Moderate
                  101,
                  "#ff7e00", // 101-150 Unhealthy (SG)
                  151,
                  "#ff0000", // 151-200 Unhealthy
                  201,
                  "#8f3f97", // 201-300 Very Unhealthy
                  301,
                  "#7e0023", // 301+    Hazardous
                ],

                // White outline so dots pop on satellite/dark basemap
                "circle-stroke-width": 1.5,
                "circle-stroke-color": [
                  "case",
                  [">=", ["get", "aqi"], 151],
                  "#ffffff", // high AQI (dark fill) -> white stroke edge
                  "#000000", // low AQI (bright fill) -> dark stroke edge
                ],

                // Slight transparency so overlapping cities (e.g. Lahore cluster) are readable
                "circle-opacity": 0.85,
              },
            },

            // optional glow layer to make high AQI feel scary
            {
              id: "waqi_stations-glow",
              type: "circle",
              source: "waqi_stations-source",
              paint: {
                "circle-radius": [
                  "interpolate",
                  ["linear"],
                  ["get", "aqi"],
                  0,
                  8,
                  100,
                  12,
                  200,
                  16,
                  300,
                  20,
                  500,
                  24,
                ],
                "circle-color": [
                  "step",
                  ["get", "aqi"],
                  "rgba(0,228,0,0.15)", // Good
                  51,
                  "rgba(255,255,0,0.18)", // Moderate
                  101,
                  "rgba(255,126,0,0.22)", // Unhealthy SG
                  151,
                  "rgba(255,0,0,0.25)", // Unhealthy
                  201,
                  "rgba(143,63,151,0.28)", // Very Unhealthy
                  301,
                  "rgba(126,0,35,0.32)", // Hazardous
                ],
                "circle-blur": 1.2,
                "circle-opacity": 0.6,
              }
            },

            // AQI number label
            {
              id: "waqi_stations-label",
              type: "symbol",
              source: "waqi_stations-source",
              minzoom: 4, // hide labels when zoomed way out to avoid clutter
              paint: {
                // Text color switches for contrast: dark text on light dots, light text on dark dots
                "text-color": [
                  "case",
                  [">=", ["get", "aqi"], 151],
                  "#ffffff", // high AQI dots are dark -> white text
                  "#000000", // low AQI dots are bright -> black text
                ],
                "text-halo-color": [
                  "case",
                  [">=", ["get", "aqi"], 151],
                  "rgba(0,0,0,0.6)", // dark halo for very bright text
                  "rgba(255,255,255,0.8)", // light halo for dark text
                ],
                "text-halo-width": 1.5,
                "text-halo-blur": 0.5,
              },
              layout: {
                "text-field": ["to-string", ["get", "aqi"]],
                "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
                "text-size": [
                  "interpolate",
                  ["linear"],
                  ["get", "aqi"],
                  0,
                  9,
                  150,
                  11,
                  300,
                  13,
                  500,
                  14,
                ],
                "text-anchor": "center",
                "text-allow-overlap": false,
                "text-ignore-placement": false,
              },
            },
          ],
          popup: true,
          information:
            "The WAQI-Stations Air Quality layer displays real-time air quality data from the World Air Quality Index (WAQI) project. This layer is essential for monitoring pollution levels and assessing health risks associated with air quality in various locations worldwide.",
        },
      },
    },
  },
  "ocean/coastal": {
    Oceanography: {
      temporal: {
        ocean_salinity: {
          label: "Ocean Surface Salinity (10m)",
          image: getImage("Sea_Water_salinity_10m_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        ocean_temperature: {
          label: "Ocean Surface Temperature (10m)",
          image: getImage("Sea_Water_Potential_Temperature_10m_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        ocean_surface_currents: {
          label: "Ocean Surface Currents (10m)",
          image: getImage("Sea_Water_Potential_currents_10m_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
        ocean_surface_height: {
          label: "Ocean Surface Height w.r.t Geoid",
          image: getImage("Sea_Water_Potential_Height_2mgeoid_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
        },
      },
    },
  },
  "Disaster Early Warning (DEW)": {
    "API Features": {
      dropdown: {
        dew_exposures: {
          exposure_id_endpoint: "http://172.18.1.108:8000/get-exposures/",
          exposure_feature_endpoint: `http://172.18.1.108:8000/get-exposures/?exposure_id=<individual_exposure_id>`,
          key: "id",
          attribute: "remarks",
          type: "geojson",
          popup: true,
          information:
            "The DEW Exposures layer provides detailed information on various exposure points related to disaster early warning systems. This layer is crucial for identifying vulnerable areas and populations, enabling targeted interventions and resource allocation during disaster events.",
        },
      },
    },
    "DEW Polygons": {
      toggle: {
        rajanpur_and_dg_khan: {
          label: "Rajanpur and DG Khan",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        hyderabad_flash_flood: {
          label: "Hyderabad Flash Flood",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        jhal_magsi_flash_flood: {
          label: "Jhal Magsi Flash Flood",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        kalam_and_swat_flash_flood: {
          label: "Kalam & Swat Flash Flood",
          type: "geojson",
          theme: null,
          geometry: null,
        },
        muzaffarabad_flash_flood: {
          label: "Muzaffarabad Flash Flood",
          type: "geojson",
          theme: null,
          geometry: null,
        },
      },
    },
    "DEW Parameters": {
      button: {
        tech_ew: {
          label: "Tech EW",
          color: "#FF5733", // Bright Orange-Red (Existing)
          outline: "#C70039", // Dark Red (Existing)
        },
        nidm: {
          label: "NIDM",
          color: "#3366FF", // Royal Blue (Formal/Professional)
          outline: "#0033CC",
        },
        mobile_app: {
          label: "Mobile App",
          color: "#00CC99", // Teal (Modern/Digital)
          outline: "#008066",
        },
        media_comm: {
          label: "Media Comm",
          color: "#FFC300", // Gold/Amber (Communication/Alerts)
          outline: "#CC9900",
        },
        drr: {
          label: "DRR",
          color: "#339933", // Forest Green (Safety/Environment)
          outline: "#1E661E",
        },
        infra_development: {
          label: "Infra Development",
          color: "#607D8B", // Slate Blue-Gray (Structure/Construction)
          outline: "#455A64",
        },
        operations: {
          label: "Operations",
          color: "#CC0066", // Deep Magenta (Action/Management)
          outline: "#99004C",
        },
        plans: {
          label: "Plans",
          color: "#663399", // Deep Purple (Strategy/Planning)
          outline: "#4C2673",
        },
        intl_colaboration: {
          label: "Intl Collaboration",
          color: "#33CCFF", // Bright Sky Blue (Global/Partnership)
          outline: "#0099CC",
        },
        rm_and_m: {
          label: "RM & M",
          color: "#996633", // Earthy Brown (Resource Management)
          outline: "#664422",
        },
        cdrf: {
          label: "CDRF",
          color: "#00BFA5", // Mint Teal (Finance/Sustainability)
          outline: "#00897B",
        },
      },
    },
  },
};