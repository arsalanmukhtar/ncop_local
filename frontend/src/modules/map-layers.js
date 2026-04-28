import { Popup } from "mapbox-gl";
import {
  map_icons,
  PMD_RAIN_ICON_ID,
  PMD_SUN_ICON_ID,
  EONET_ICON_IDS,
  USGS_ICON_IDS,
} from "./map-icons.js";

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
  generateSUAOD550Layers,
  generateBBAOD550Layers,
  generateCO2_850hPaLayers,
  generateCO2SurfaceLayers,
  generateHCHOSurfaceLayers,
  generateSSAOD550Layers,
  generateUVIndexDailyMaxLayers,
  generateGDPSRelHumLayers,
  generateGDPSSpecHumLayers,
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
  generateMBX_MeteoblueLHASA2LatestLayer,
  generateMeteoblueCAMSAirQualityHourlyLayers,
  generateMeteoblueCAMSAirQualityDailyLayers,
  generateMeteoblueCAMSDesertDustHourlyLayers,
  generateMeteoblueCAMSDesertDustDailyLayers,
  generateMeteoblueCAMSAODHourlyLayers,
  generateMeteoblueCAMSAODDailyLayers,
  generateMeteoblueCAMSNO2DailyLayers,
  generateMeteoblueCAMSCODailyLayers,
  generateMeteoblueCAMSSO2DailyLayers,
  generateMBX_IMERGPrecipRateLayers,
  generateSnowDensityWeeklyLayers,
  generateSnowDepthWeeklyLayers,
  generateSnowfallHourlyLayers,
  generateThunderstormProbability3HourlyLayers,
  generateLiquidFogProbability3HourlyLayers,
  generateConvectivePrecipitationWeeklyLayers,
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
const legend_images = import.meta.glob("@assets/images/layer_legends/*.webp", { eager: true });
function getLegendImage(filename) {
  const match = Object.entries(legend_images).find(([path]) => path.includes(filename));
  return match ? match[1].default : null;
}

function createEonetLayers(sourceId, pointColor, polygonColor, iconId) {
  return [
    {
      id: `${sourceId}-fill`,
      type: "fill",
      source: sourceId,
      paint: {
        "fill-color": polygonColor,
        "fill-opacity": 0.22,
      },
    },
    {
      id: `${sourceId}-outline`,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": polygonColor,
        "line-width": 2,
        "line-opacity": 0.9,
      },
    },
    {
      id: `${sourceId}-point`,
      type: "symbol",
      source: sourceId,
      filter: ["==", "$type", "Point"],
      layout: {
        "icon-image": iconId,
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          4,
          0.45,
          7,
          0.58,
          10,
          0.72,
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    },
  ];
}

function createUsgsEarthquakeLayers(sourceId) {
  return [
    {
      id: `${sourceId}-symbol`,
      type: "symbol",
      source: sourceId,
      layout: {
        "icon-image": [
          "case",
          [">=", ["to-number", ["coalesce", ["get", "mag"], 0]], 7],
          USGS_ICON_IDS.major,
          [">=", ["to-number", ["coalesce", ["get", "mag"], 0]], 5],
          USGS_ICON_IDS.strong,
          [">=", ["to-number", ["coalesce", ["get", "mag"], 0]], 3],
          USGS_ICON_IDS.moderate,
          USGS_ICON_IDS.low,
        ],
        "icon-size": [
          "interpolate",
          ["linear"],
          ["zoom"],
          3,
          0.9,
          5,
          1.2,
          7,
          1.6,
          10,
          2,
        ],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    },
  ];
}
// GloFAS Layers baseURL
const glofaswmsurl =
  "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=EGE_probRgt50&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE";
// console.log("✅ GloFAS WMS URL set:", glofaswmsurl + "");

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
const suaod550_layers = generateSUAOD550Layers();
const bbaod550_layers = generateBBAOD550Layers();
const co2_850hpa_layers = generateCO2_850hPaLayers();
const co2_surface_layers = generateCO2SurfaceLayers();
const hcho_surface_layers = generateHCHOSurfaceLayers();
const ssaod550_layers = generateSSAOD550Layers();
const uvindex_layers = generateUVIndexDailyMaxLayers();
const gdps_relhum_layers = generateGDPSRelHumLayers();
const gdps_spechum_layers = generateGDPSSpecHumLayers();
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
const mbx_lhasa2_latest     = generateMBX_MeteoblueLHASA2LatestLayer(metbluT);
const cams_aqi_hourly_layers = generateMeteoblueCAMSAirQualityHourlyLayers(metbluT);
const cams_aqi_daily_layers = generateMeteoblueCAMSAirQualityDailyLayers(metbluT);
const cams_desert_dust_hourly_layers = generateMeteoblueCAMSDesertDustHourlyLayers(metbluT);
const cams_desert_dust_daily_layers = generateMeteoblueCAMSDesertDustDailyLayers(metbluT);
const cams_aod_hourly_layers = generateMeteoblueCAMSAODHourlyLayers(metbluT);
const cams_aod_daily_layers = generateMeteoblueCAMSAODDailyLayers(metbluT);
const cams_no2_daily_layers = generateMeteoblueCAMSNO2DailyLayers(metbluT);
const cams_co_daily_layers = generateMeteoblueCAMSCODailyLayers(metbluT);
const cams_so2_daily_layers = generateMeteoblueCAMSSO2DailyLayers(metbluT);
const mbx_imerg_precip_rate = generateMBX_IMERGPrecipRateLayers();
const snow_density_weekly_layers = generateSnowDensityWeeklyLayers();
const snow_depth_weekly_layers = generateSnowDepthWeeklyLayers();
const snowfall_hourly_layers = generateSnowfallHourlyLayers();
const thunderstorm_prob_3hourly_layers = generateThunderstormProbability3HourlyLayers();
const liquid_fog_prob_3hourly_layers = generateLiquidFogProbability3HourlyLayers();
const convective_precip_weekly_layers = generateConvectivePrecipitationWeeklyLayers();

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
window.sulphate_aod_550 = suaod550_layers;
window.biomass_burning_aod_550 = bbaod550_layers;
window.co2_850hpa = co2_850hpa_layers;
window.co2_surface = co2_surface_layers;
window.hcho_surface = hcho_surface_layers;
window.sea_salt_aod_550 = ssaod550_layers;
window.uv_index_daily_max = uvindex_layers;
window.specific_humidity_2m_above_ground = gdps_spechum_layers;
window.relative_humidity_2m_above_ground = gdps_relhum_layers;
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
window.lhasa2_latest = mbx_lhasa2_latest;
window.cams_air_quality_index_hourly = cams_aqi_hourly_layers;
window.cams_air_quality_index_daily = cams_aqi_daily_layers;
window.cams_desert_dust_hourly = cams_desert_dust_hourly_layers;
window.cams_desert_dust_daily = cams_desert_dust_daily_layers;
window.cams_aerosol_optical_depth_hourly = cams_aod_hourly_layers;
window.cams_aerosol_optical_depth_daily = cams_aod_daily_layers;
window.cams_nitrogen_dioxide_daily = cams_no2_daily_layers;
window.cams_carbon_monoxide_daily = cams_co_daily_layers;
window.cams_sulphur_dioxide_daily = cams_so2_daily_layers;
window.imerg_precipitation_rate_14_days = mbx_imerg_precip_rate;
window.snow_density_weekly_forecast = snow_density_weekly_layers;
window.snow_depth_weekly_forecast = snow_depth_weekly_layers;
window.snowfall_hourly_forecast = snowfall_hourly_layers;
window.thunderstorm_probability_3hourly_forecast = thunderstorm_prob_3hourly_layers;
window.liquid_fog_probability_3hourly_forecast = liquid_fog_prob_3hourly_layers;
window.convective_precipitation_weekly_forecast = convective_precip_weekly_layers;
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
          legend: true,
          legendPath: getLegendImage("airports.webp"),
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
          information:
            "The Realtime Radar layer provides up-to-the-minute radar imagery, allowing users to monitor precipitation patterns and intensity in real-time. This layer is crucial for tracking weather events such as storms, rainfall, and severe weather conditions.",
        },
        satellite_infrared: {
          label: "Satellite Infrared",
          image: getImage("rainViewer_satellite.webp"),
          type: "raster",
          theme: "slider",
          title: "Radar Clouds",
          information:"The Satellite Infrared layer provides real-time infrared satellite imagery, allowing users to monitor cloud cover and atmospheric conditions. This layer is essential for tracking weather patterns and forecasting.",
        },
        dwd_satellite_infrared: {
          label: "DWD Satellite Infrared",
          image: getImage("dwd_radar.webp"),
          theme: "slider",
          type: "raster",
          title: "DWD Radar (°C)",
          information:"The DWD Satellite Infrared layer provides real-time infrared satellite imagery from the German Weather Service (DWD). This layer is essential for monitoring cloud cover, weather patterns, and atmospheric conditions, aiding in weather forecasting and analysis.",
        },
        imerg_precipitation_rate_14_days: {
          label: "IMERG Precipitation Rate (14 Days)",
          image: getImage("IMERG_precip_rate_past12d.webp"),
          type: "raster",
          theme: "slider",
          title: null,
          information:"The IMERG Precipitation Rate layer displays the precipitation rates over the past 14 days using data from the Integrated Multi-satellitE Retrievals for GPM (IMERG). This layer is crucial for understanding recent rainfall patterns and assessing hydrological conditions.",
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
          information:"The Specific Humidity (2m Above Ground) layer displays the specific humidity levels at 2 meters above ground level. This layer is essential for understanding moisture content in the atmosphere and its impact on weather patterns.",
        },
        relative_humidity_2m_above_ground: {
          label: "Relative Humidity (%)",
          image: getImage("Relative_humidity_weekly_2m_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Relative Humidity (g/kg)",
          geometry: null,
          information:"The Relative Humidity (2m Above Ground) layer displays the relative humidity levels at 2 meters above ground level. This layer is essential for understanding moisture content in the atmosphere and its impact on weather patterns.",
        },
        gdps_accumulated_precipitation: {
          label: "Accumulated Precipitation",
          image: getImage("Convective_precipitation_weekly_kgm2_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Accumulated Precipitation (mm)",
          geometry: null,
          information:"The Accumulated Precipitation layer displays the total precipitation accumulated over a specified period. This layer is essential for understanding rainfall patterns and their impact on the environment.",
        },
        precipitation_type_3hrs: {
          label: "Precipitation Type / 3hrs",
          image: getImage("Precipitation_3hourly_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Precipitation Type",
          information:"The Precipitation Type layer displays the type of precipitation (rain, snow, etc.) expected over the next 3 hours. This layer is essential for understanding short-term weather impacts and planning.",
        },
        snow_density_weekly_forecast: {
          label: "Snow Density Weekly Forecast",
          image: getImage("Snow_density_weekly_kgm3_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Snow Density (kg/m³)",
          information: "The Snow Density Weekly Forecast layer displays the predicted snow density in kilograms per cubic meter over the next 7 days. This layer helps understand snow pack characteristics and water content in snowfall.",
        },
        snow_depth_weekly_forecast: {
          label: "Snow Depth Weekly Forecast",
          image: getImage("Snow_depth_weekly_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Snow Depth (m)",
          information: "The Snow Depth Weekly Forecast layer displays the predicted snow depth in meters over the next 7 days. This layer is essential for avalanche forecasting, winter sports planning, and water resource management.",
        },
        snowfall_hourly_forecast: {
          label: "Snowfall Hourly Forecast",
          image: getImage("Snowfall_hourly_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Snowfall Probability (%)",
          information: "The Snowfall Hourly Forecast layer displays the probability of snowfall at 3-hour intervals over the next 30 hours. This layer helps in short-term winter weather planning and travel decisions.",
        },
        thunderstorm_probability_3hourly_forecast: {
          label: "Thunderstorm Probability 3-Hourly",
          image: getImage("Thunderstorm_Propability_3hourly_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Thunderstorm Probability (%)",
          information: "The Thunderstorm Probability 3-Hourly Forecast layer displays the likelihood of thunderstorm occurrence at 3-hour intervals. This layer is critical for severe weather warnings and public safety.",
        },
        liquid_fog_probability_3hourly_forecast: {
          label: "Liquid Fog Probability 3-Hourly",
          image: getImage("Liquid_Fog_Propability_3hourly_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Fog Visibility (km)",
          information: "The Liquid Fog Probability 3-Hourly Forecast layer displays the predicted visibility conditions due to liquid fog at 3-hour intervals. This layer is essential for aviation, transportation planning, and safety operations.",
        },
        convective_precipitation_weekly_forecast: {
          label: "Convective Precipitation Weekly",
          image: getImage("Convective_precipitation_weekly_kgm2_forecast.webp"),
          type: "raster",
          theme: "slider",
          title: "Convective Precipitation (kg/m²)",
          information: "The Convective Precipitation Weekly Forecast layer displays the predicted convective precipitation (thunderstorm-related rainfall) in kg/m² over the next 10 days. This layer helps in flood forecasting and severe weather prediction.",
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
          information:"The Temperature (850hPa) layer displays the temperature levels at 850 hPa pressure level. This layer is essential for understanding atmospheric conditions and their impact on weather patterns.",
        },
        ecmwf_lightning: {
          label: "Lightning Forecast",
          image: getImage("lightning_forcasting.webp"),
          type: "raster",
          theme: "slider",
          title: "Probability %",
          information:"The Lightning Forecast layer provides predictions of lightning activity based on ECMWF data. This layer is crucial for anticipating severe weather events and ensuring safety during thunderstorms.",
        },
        ecmwf_cyclone: {
          label: "Tropical Cyclone Strike Probability",
          image: getImage("Tropical_Cyclone_strike_propability.webp"),
          type: "raster",
          theme: "slider",
          title: "Probability %",
          information:"The Tropical Cyclone Strike Probability layer provides predictions of tropical cyclone activity based on ECMWF data. This layer is crucial for anticipating severe weather events and ensuring safety during cyclonic conditions.",
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
          information:"The Weekly Precipitation (2m Above Ground) layer displays the total precipitation accumulated over the past week at 2 meters above ground level. This layer is essential for understanding weekly rainfall patterns and their impact on the environment.",
        },
        hourly_precipitation_2m_above_ground: {
          label: "Hourly Precipitation (2m Above Ground)",
          image: getImage("nems_cloudprecipitation.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The Hourly Precipitation (2m Above Ground) layer displays the precipitation levels at 2 meters above ground level on an hourly basis. This layer is essential for understanding short-term rainfall patterns and their impact on the environment.",
        },
        hourly_snowfall_forecast: {
          label: "Hourly Snowfall (Forecast)",
          image: getImage("nems_snowfall_hourly.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The Hourly Snowfall (Forecast) layer displays the snowfall levels at 2 meters above ground level on an hourly basis. This layer is essential for understanding short-term snowfall patterns and their impact on the environment.",
        },
        weekly_snowfall_forecast: {
          label: "Weekly Snow (Forecast)",
          image: getImage("nems_snowfall_weekly.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The Weekly Snow (Forecast) layer displays the total snowfall accumulated over the past week at 2 meters above ground level. This layer is essential for understanding weekly snowfall patterns and their impact on the environment.",
        },
        cape_hourly_forecast: {
          label: "CAPE Hourly (Forecast)",
          image: getImage("nems_cape_hourly.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The CAPE Hourly (Forecast) layer displays the Convective Available Potential Energy (CAPE) levels on an hourly basis. This layer is essential for understanding atmospheric instability and its potential for severe weather development.",
        },
        cape_weekly_forecast: {
          label: "CAPE Weekly (Forecast)",
          image: getImage("nems_cape_hourly.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The CAPE Weekly (Forecast) layer displays the Convective Available Potential Energy (CAPE) levels on a weekly basis. This layer is essential for understanding atmospheric instability and its potential for severe weather development.",
        },
        storm_helicity_forecast_0_3km: {
          label: "Storm Helicity Forecast (0-3km)",
          image: getImage("nems_storms_helicity_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The Storm Helicity Forecast (0-3km) layer displays the storm helicity levels in the 0-3 km atmospheric layer. This layer is essential for understanding the potential for rotating storms and severe weather development.",
        },
        precipitation_radar: {
          label: "Precipitation Radar",
          image: getImage("global_precipitation.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The Precipitation Radar layer provides real-time precipitation data using radar technology. This layer is crucial for monitoring rainfall intensity and tracking storm systems.",
        },
        temperature_2m_above_ground: {
          label: "Temperature (2m Above Ground)",
          image: getImage("meteoblue_nems_temperature.webp"),
          type: "raster",
          theme: "slider",
          title: "Daily Max Temperature (°C)",
          geometry: null,
          information:"The Temperature (2m Above Ground) layer displays the forecast daily maximum temperature at 2 meters above ground level. This layer is useful for tracking expected daytime heat patterns and temperature extremes.",
        },
      },
    },
    "MET Monitoring": {
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
              id: "pmd_weather_stations-sun-symbol",
              type: "symbol",
              source: "pmd_weather_stations-source",
              layout: {
                "icon-image": PMD_SUN_ICON_ID,
                "icon-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  5,
                  0.5,
                  7,
                  0.6,
                  10,
                  0.76,
                  15,
                  1,
                ],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
            },
            {
              id: "pmd_weather_stations-rain-symbol",
              type: "symbol",
              source: "pmd_weather_stations-source",
              filter: [
                ">",
                ["to-number", ["coalesce", ["get", "rainfall"], 0]],
                0,
              ],
              layout: {
                "icon-image": PMD_RAIN_ICON_ID,
                "icon-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  5,
                  0.5,
                  7,
                  0.6,
                  10,
                  0.76,
                  15,
                  1,
                ],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
            },
          ],
          popup: true,
          information:
            "The PMD Weather Stations layer displays the locations (with daily data) of weather stations managed by the MET Monitoring. This layer is essential for monitoring real-time weather conditions and collecting meteorological data across the country.",
        },
        heatwave_monitoring: {
          label: "Heatwave Monitoring",
          theme: null,
          source: {
            id: "heatwave_monitoring-source",
            type: "geojson",
            data: `${baseUrl}/get-heatwave-monitoring/`,
            maxzoom: 22,
          },
          layers: [
            {
              id: "heatwave_monitoring-circle",
              type: "circle",
              source: "heatwave_monitoring-source",
              paint: {
                "circle-color": [
                  "interpolate",
                  ["linear"],
                  ["coalesce", ["to-number", ["get", "temperature"]], 0],
                  20, "#2563eb",
                  28, "#22c55e",
                  34, "#facc15",
                  38, "#f97316",
                  42, "#ef4444",
                  46, "#7f1d1d",
                ],
                "circle-radius": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  4, [
                    "interpolate",
                    ["linear"],
                    ["coalesce", ["to-number", ["get", "temperature"]], 0],
                    20, 9,
                    30, 12,
                    38, 16,
                    46, 22,
                  ],
                  8, [
                    "interpolate",
                    ["linear"],
                    ["coalesce", ["to-number", ["get", "temperature"]], 0],
                    20, 16,
                    30, 22,
                    38, 30,
                    46, 40,
                  ],
                ],
                "circle-opacity": 0.88,
                "circle-stroke-width": 2,
                "circle-stroke-color": "#ffffff",
                "circle-stroke-opacity": 0.9,
              },
            },
            {
              id: "heatwave_monitoring-label",
              type: "symbol",
              source: "heatwave_monitoring-source",
              layout: {
                "text-field": [
                  "concat",
                  [
                    "to-string",
                    ["round", ["coalesce", ["to-number", ["get", "temperature"]], 0]],
                  ],
                  "°",
                ],
                "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
                "text-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  4, 10,
                  8, 14,
                ],
                "text-anchor": "center",
                "text-allow-overlap": true,
                "text-ignore-placement": true,
              },
              paint: {
                "text-color": "#ffffff",
                "text-halo-color": "rgba(0,0,0,0.55)",
                "text-halo-width": 1.4,
              },
            },
            {
              id: "heatwave_monitoring-name",
              type: "symbol",
              source: "heatwave_monitoring-source",
              minzoom: 5.5,
              layout: {
                "text-field": ["coalesce", ["get", "name"], ""],
                "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
                "text-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  5.5, 10,
                  9, 13,
                ],
                "text-offset": [0, 1.6],
                "text-anchor": "top",
                "text-allow-overlap": false,
                "text-optional": true,
              },
              paint: {
                "text-color": "#0f172a",
                "text-halo-color": "rgba(255,255,255,0.92)",
                "text-halo-width": 1.6,
              },
            },
          ],
          popup: true,
          information:
            "The Heatwave Monitoring layer plots current air temperature for major Pakistani cities, sized and colored by intensity. Click a city to open a stats panel with the 16-day forecast, 6-month seasonal outlook, and a multi-year climate-change trend (powered by Open-Meteo).",
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
      static: {
        precipitation_probability_50mm_10days: {
          label: "Likely Heavy Precipitation > 50mm (10 Days)",
          image: getImage("glofas-precip-prob-gt-50.webp"),
          type: "raster",
          theme: "legend",
          source: {
            id: "EGE_probRgt50-source",
            type: "raster",
            tiles: [
              // Optimized URL with smaller tile size and better format
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=512&HEIGHT=512&LAYERS=EGE_probRgt50&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 512, // Use 512 for better performance
            maxzoom: 18, // Reduce max zoom if not needed
            minzoom: 0,
          },
          layers: [
            {
              id: "EGE_probRgt50",
              type: "raster",
              source: "EGE_probRgt50-source",
              paint: {
                "raster-fade-duration": 0, // Disable fade for faster loading
              },
            },
          ],
          legend: true,
          legendPath: getLegendImage(
            "Precipitation Probability 50mm (10 Days).webp"
          ),
          information:
            "The Likely Heavy Precipitation > 50mm (10 Days) layer from GloFAS provides a forecast of areas expected to receive heavy rainfall exceeding 50mm within the next 10 days. This layer is crucial for flood risk assessment and preparedness, helping authorities and communities to anticipate and respond to potential flooding events.",
        },
        precipitation_probability_150mm_10days: {
          label: "Precipitation Probability > 150mm (10 Days)",
          image: getImage("glofas-precip-prob-gt-150.webp"),
          type: "raster",
          theme: "legend",
          source: {
            id: "EGE_probRgt150-source",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=EGE_probRgt150&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "EGE_probRgt150",
              type: "raster",
              source: "EGE_probRgt150-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage("precip3Days.webp"),
          information:
            "The Precipitation Probability > 150mm (10 Days) layer from GloFAS provides a forecast of areas expected to receive heavy rainfall exceeding 150mm within the next 10 days. This layer is crucial for flood risk assessment and preparedness, helping authorities and communities to anticipate and respond to potential flooding events.",
        },
        precipitation_probability_300mm_10days: {
          label: "Precipitation Probability > 300mm (10 Days)",
          image: getImage("glofas-precip-prob-gt-300.webp"),
          type: "raster",
          theme: "legend",
          source: {
            id: "EGE_probRgt300-source",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=EGE_probRgt300&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "EGE_probRgt300",
              type: "raster",
              source: "EGE_probRgt300-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage(
            "Precipitation Probability 300mm (10 Days).webp"
          ),
          information:
            "The Precipitation Probability > 300mm (10 Days) layer from GloFAS provides a forecast of areas expected to receive heavy rainfall exceeding 300mm within the next 10 days. This layer is crucial for flood risk assessment and preparedness, helping authorities and communities to anticipate and respond to potential flooding events.",
        },
        accumulated_precipitation: {
          label: "Accumulated Precipitation",
          image: getImage("glofas-accu-precip.webp"),
          type: "raster",
          theme: "legend",
          source: {
            id: "AccRainEGE",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=AccRainEGE&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "AccRainEGE",
              type: "raster",
              source: "EAccRainEGE-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage("precip3Days.webp"),
          information:
            "The Precipitation Probability > 300mm (10 Days) layer from GloFAS provides a forecast of areas expected to receive heavy rainfall exceeding 300mm within the next 10 days. This layer is crucial for flood risk assessment and preparedness, helping authorities and communities to anticipate and respond to potential flooding events.",
        },
        flood_summary_day_1_3: {
          label: "Flood Summary (Day 1-3)",
          image: getImage("glofas-flood-sum-1-30d.webp"),
          type: "raster",
          theme: "legend",
          source: {
            id: "sumAL41EGE-source",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=sumAL41EGE&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "sumAL41EGE",
              type: "raster",
              source: "sumAL41EGE-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage("sumAL41EGE.webp"),
          information:
            "The Flood Summary (Day 1-3) layer from GloFAS provides a summary of flood events expected to occur within the first three days of the forecast period. This layer is essential for early warning and response efforts, allowing authorities and communities to prepare for potential flooding impacts.",
        },
        flood_summary_day_4_10: {
          label: "Flood Summary (Day 4-10)",
          image: getImage("glofas-flood-sum-1-30d.webp"),
          type: "raster",
          theme: "legend",
          source: {
            id: "sumAL42EGE-source",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=sumAL42EGE&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "sumAL42EGE",
              type: "raster",
              source: "sumAL42EGE-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage("sumAL41EGE.webp"),
          information:
            "The Flood Summary (Day 4-10) layer from GloFAS provides a summary of flood events expected to occur within the fourth to tenth days of the forecast period. This layer is essential for early warning and response efforts, allowing authorities and communities to prepare for potential flooding impacts.",
        },
      },
      toggle: {
        initial_temperature_at_2m: {
          label: "Initial Temperature at 2m",
          type: "raster",
          theme: "legend",
          source: {
            id: "sumAL43EGE",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=sumAL43EGE&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "sumAL43EGE",
              type: "raster",
              source: "sumAL43EGE-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage("glofas-initial-temp-2m.webp"),
          information:
            "The Initial Temperature at 2m layer from GloFAS provides information on the initial temperature conditions at a height of 2 meters above ground level. This layer is important for understanding the thermal state of the atmosphere, which can influence weather patterns and flood dynamics.",
        },
        major_rivers: {
          label: "Major Rivers",
          type: "raster",
          theme: "legend",
          source: {
            id: "MajorRivers1",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=MajorRivers1&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "MajorRivers1",
              type: "raster",
              source: "MajorRivers1-source",
            },
          ],
          legend: false,
          // legendPath: getLegendImage("sumAL43EGE.webp"),
          information:
            "The Major Rivers layer from GloFAS provides information on the location and extent of major rivers within the region. This layer is important for understanding the hydrological context of flood events and for planning flood management strategies.",
        },
        major_river_basins: {
          label: "Major River Basins",
          type: "raster",
          theme: "legend",
          source: {
            id: "MajorRiverBasins",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=MajorRiverBasins&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "MajorRiverBasins",
              type: "raster",
              source: "MajorRiverBasins-source",
            },
          ],
          legend: false,
          // legendPath: getLegendImage("sumAL43EGE.webp"),
          information:
            "The Major River Basins layer from GloFAS provides information on the boundaries and extents of major river basins within the region. This layer is important for understanding the hydrological context of flood events and for planning flood management strategies.",
        },
        lakes_and_reservoirs: {
          label: "Lakes and Reservoirs",
          type: "raster",
          theme: "legend",
          source: {
            id: "GlofasLakesReservoirs",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=GlofasLakesReservoirs&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "GlofasLakesReservoirs",
              type: "raster",
              source: "GlofasLakesReservoirs-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage("glofas-lakes-reservoirs.webp"),
          information:
            "The Lakes and Reservoirs layer from GloFAS provides information on the location and extent of lakes and reservoirs within the region. This layer is important for understanding the hydrological context of flood events and for planning flood management strategies.",
        },
        soil_moisture_at_2m: {
          label: "Soil Moisture at 2m",
          type: "raster",
          theme: "legend",
          source: {
            id: "soilMoistureInst",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=soilMoistureInst&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "soilMoistureInst",
              type: "raster",
              source: "soilMoistureInst-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage("glofas-soil-moisture-2m.webp"),
          information:
            "The Soil Moisture layer from GloFAS provides information on the moisture content in the soil at a depth of 2 meters. This layer is important for understanding the hydrological context of flood events and for planning flood management strategies.",
        },
        soil_moisture_anomaly_at_2m: {
          label: "Soil Moisture Anomaly at 2m",
          type: "raster",
          theme: "legend",
          source: {
            id: "soilMoistureInstAnomaly",
            type: "raster",
            tiles: [
              "https://globalfloods-ows.ecmwf.int/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&BBOX={bbox-epsg-3857}&CRS=EPSG:3857&WIDTH=1439&HEIGHT=602&LAYERS=soilMoistureInstAnomaly&STYLES=&FORMAT=image/png&DPI=96&MAP_RESOLUTION=96&FORMAT_OPTIONS=dpi:96&TRANSPARENT=TRUE",
            ],
            tileSize: 256,
            maxzoom: 22,
          },
          layers: [
            {
              id: "soilMoistureInstAnomaly",
              type: "raster",
              source: "soilMoistureInstAnomaly-source",
            },
          ],
          legend: true,
          legendPath: getLegendImage("glofas-soil-moisture-anomaly-2m.webp"),
          information:
            "The Soil Moisture Anomaly layer from GloFAS provides information on the deviation of soil moisture from the long-term average at a depth of 2 meters. This layer is important for understanding the hydrological context of flood events and for planning flood management strategies.",
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
          information: "The PM2.5 layer displays the concentration of particulate matter with a diameter of 2.5 micrometers or less. This layer is essential for understanding air quality and its impact on human health.",
        },
        particulate_matter_10: {
          label: "Particulate Matter (10)",
          image: getImage("pm_10.webp"),
          type: "raster",
          theme: "slider",
          title: "PM10 (µg/m³)",
          information: "The PM10 layer displays the concentration of particulate matter with a diameter of 10 micrometers or less. This layer is essential for understanding air quality and its impact on human health.",
        },
        nitrogen_dioxide_850hPa: {
          label: "Nitrogen Dioxide (850hPa)",
          image: getImage("no2.webp"),
          type: "raster",
          theme: "slider",
          title: "Nitrogen Dioxide (ppbv)",
          information: "The Nitrogen Dioxide layer displays the concentration of nitrogen dioxide at 850 hPa pressure level. This layer is essential for understanding air quality and its impact on human health.",
        },
        ozone: {
          label: "Ozone",
          image: getImage("O3.webp"),
          type: "raster",
          theme: "slider",
          title: "Ozone (µg/m³)",
          information: "The Ozone layer displays the concentration of ozone in the atmosphere. This layer is essential for understanding air quality and its impact on human health.",
        },
        sulphur_dioxide_850hPa: {
          label: "Sulphur Dioxide (850hPa)",
          image: getImage("SO2.webp"),
          type: "raster",
          theme: "slider",
          title: "Sulphur Dioxide (µg/m³)",
          information: "The Sulphur Dioxide layer displays the concentration of sulphur dioxide at 850 hPa pressure level. This layer is essential for understanding air quality and its impact on human health.",
        },
        carbon_monoxide: {
          label: "Carbon Monoxide",
          image: getImage("CO.webp"),
          type: "raster",
          theme: "slider",
          title: "Carbon Monoxide (ppbv)",
          information: "The Carbon Monoxide layer displays the concentration of carbon monoxide in the atmosphere. This layer is essential for understanding air quality and its impact on human health.",
        },
        dust: {
          label: "Dust",
          image: getImage("cams_composition_duaod550.webp"),
          type: "raster",
          theme: "slider",
          title: "Dust",
          information: "The Dust layer displays the concentration of dust particles in the atmosphere. This layer is essential for understanding air quality and its impact on human health.",
        },
        methane_at_300hPa: {
          label: "Methane at 300hPa",
          image: getImage("methane.webp"),
          type: "raster",
          theme: "slider",
          title: "Methane (ppbv)",
          information: "The Methane at 300hPa layer displays the concentration of methane at 300 hPa pressure level. This layer is essential for understanding air quality and its impact on human health.",
        },
        sulphate_aod_550: {
          label: "Sulphate Aerosol (AOD 550nm)",
          image: getImage("cams_composition_suaod550.webp"),
          type: "raster",
          theme: "slider",
          title: "Sulphate AOD",
          information: "The Sulphate Aerosol Optical Depth layer displays the concentration of sulphate aerosol particles at 550nm wavelength. These particles form from SO₂ emissions and play a significant role in air quality, visibility reduction, and climate by reflecting sunlight. Major sources include industrial emissions and volcanic activity.",
        },
        biomass_burning_aod_550: {
          label: "Biomass Burning Aerosol (AOD 550nm)",
          image: getImage("cams_composition_bbaod550_biomass.webp"),
          type: "raster",
          theme: "slider",
          title: "Biomass Burning AOD",
          information: "The Biomass Burning Aerosol Optical Depth layer displays the concentration of smoke particles from wildfires, agricultural burning, and forest fires at 550nm wavelength. These aerosols significantly impact air quality, visibility, and climate. This layer is crucial for monitoring fire seasons and smoke transport.",
        },
        co2_850hpa: {
          label: "Carbon Dioxide at 850hPa",
          image: getImage("cams_composition_co2_850hpa.webp"),
          type: "raster",
          theme: "slider",
          title: "CO₂ (ppm)",
          information: "The Carbon Dioxide at 850hPa layer displays the concentration of CO₂ at 850 hPa pressure level (approximately 1.5 km altitude). CO₂ is the primary greenhouse gas from fossil fuel combustion, deforestation, and industrial processes. This layer helps monitor atmospheric CO₂ distribution and transport patterns.",
        },
        co2_surface: {
          label: "Carbon Dioxide at Surface",
          image: getImage("cams_composition_co2_surface.webp"),
          type: "raster",
          theme: "slider",
          title: "CO₂ (ppm)",
          information: "The Carbon Dioxide at Surface layer displays ground-level CO₂ concentrations. This layer shows the spatial and temporal variations of atmospheric CO₂, which is crucial for understanding carbon sources and sinks, urban emissions, and the global carbon cycle. Surface measurements are key for climate change monitoring.",
        },
        hcho_surface: {
          label: "Formaldehyde at Surface",
          image: getImage("cams_composition_co2_surface.webp"),
          type: "raster",
          theme: "slider",
          title: "HCHO (ppbv)",
          information: "The Formaldehyde at Surface layer displays ground-level HCHO concentrations. Formaldehyde is a volatile organic compound (VOC) produced by incomplete combustion, vegetation, and industrial sources. It contributes to ozone formation and is a respiratory irritant. This layer helps identify pollution sources and photochemical smog formation.",
        },
        sea_salt_aod_550: {
          label: "Sea Salt Aerosol (AOD 550nm)",
          image: getImage("cams_composition_seasalt.webp"),
          type: "raster",
          theme: "slider",
          title: "Sea Salt AOD",
          information: "The Sea Salt Aerosol Optical Depth layer displays the concentration of sea salt particles at 550nm wavelength. These natural aerosols are generated by wave breaking and sea spray, particularly in high wind conditions. Sea salt aerosols affect climate, cloud formation, and can contribute to reduced visibility in coastal areas.",
        },
        uv_index_daily_max: {
          label: "UV Index (Daily Maximum)",
          image: getImage("cams_composition_uvindex_daily_max.webp"),
          type: "raster",
          theme: "slider",
          title: "UV Index",
          information: "The UV Index Daily Maximum layer displays the peak ultraviolet radiation level expected during the day. The UV Index ranges from 0 (low) to 11+ (extreme) and indicates the strength of solar UV radiation reaching the Earth's surface. This layer is essential for sun protection planning and skin cancer prevention. Values above 3 require sun protection measures.",
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
              },
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
          legend: true,
          legendPath: getLegendImage("World_AirQuality.webp"),
          information:
            "The WAQI-Stations Air Quality layer displays real-time air quality data from the World Air Quality Index (WAQI) project. This layer is essential for monitoring pollution levels and assessing health risks associated with air quality in various locations worldwide.",
        },
      },
    },
    "Meteoblue Air-Quality Forecast": {
      temporal: {
        cams_air_quality_index_hourly: {
          label: "Air Quality Index (AQI) Hourly",
          image: getImage("meteoblue_cams_aqi_daily.webp"),
          type: "raster",
          theme: "slider",
          title: "AQI",
          information: "The CAMS Air Quality Index (AQI) Hourly layer displays hourly forecasts of overall air quality. The index ranges from good (green) to hazardous (purple), providing an easy-to-understand measure of air pollution levels.",
        },
        cams_air_quality_index_daily: {
          label: "Air Quality Index (AQI) Daily",
          image: getImage("meteoblue_cams_aqi_daily.webp"),
          type: "raster",
          theme: "slider",
          title: "AQI",
          information: "The CAMS Air Quality Index (AQI) Daily layer displays daily average forecasts of overall air quality. This layer helps in understanding air quality trends over multiple days.",
        },
        cams_desert_dust_hourly: {
          label: "Desert Dust Hourly Forecast",
          image: getImage("meteoblue_cams_desert_dust_daily.webp"),
          type: "raster",
          theme: "slider",
          title: "Desert Dust (µg/m³)",
          information: "The Desert Dust Hourly Forecast layer displays hourly predictions of desert dust concentrations. This is particularly important for monitoring dust storms and their impact on air quality and visibility.",
        },
        cams_desert_dust_daily: {
          label: "Desert Dust Daily Forecast",
          image: getImage("meteoblue_cams_desert_dust_daily.webp"),
          type: "raster",
          theme: "slider",
          title: "Desert Dust (µg/m³)",
          information: "The Desert Dust Daily Forecast layer displays daily average predictions of desert dust concentrations, useful for medium-term air quality planning.",
        },
        cams_aerosol_optical_depth_hourly: {
          label: "Aerosol Optical Depth (AOD) Hourly",
          image: getImage("meteoblue_cams_aod_hourly.webp"),
          type: "raster",
          theme: "slider",
          title: "AOD",
          information: "The Aerosol Optical Depth (AOD) Hourly layer measures the extinction of solar radiation by aerosols in the atmosphere. Higher AOD values indicate more aerosols and reduced visibility.",
        },
        cams_aerosol_optical_depth_daily: {
          label: "Aerosol Optical Depth (AOD) Daily",
          image: getImage("meteoblue_cams_aod_hourly.webp"),
          type: "raster",
          theme: "slider",
          title: "AOD",
          information: "The Aerosol Optical Depth (AOD) Daily layer provides daily average forecasts of atmospheric aerosol levels, useful for air quality monitoring and climate studies.",
        },
        cams_nitrogen_dioxide_daily: {
          label: "Nitrogen Dioxide (NO₂) Daily Forecast",
          image: getImage("meteoblue_cams_no2_daily.webp"),
          type: "raster",
          theme: "slider",
          title: "NO₂ (µg/m³)",
          information: "The Nitrogen Dioxide (NO₂) Daily Forecast layer displays daily predictions of NO₂ concentrations. NO₂ is a major air pollutant primarily from combustion processes and vehicle emissions.",
        },
        cams_carbon_monoxide_daily: {
          label: "Carbon Monoxide (CO) Daily Forecast",
          image: getImage("meteoblue_cams_co_daily.webp"),
          type: "raster",
          theme: "slider",
          title: "CO (µg/m³)",
          information: "The Carbon Monoxide (CO) Daily Forecast layer displays daily predictions of CO concentrations. CO is a colorless, odorless gas produced by incomplete combustion and is harmful to human health.",
        },
        cams_sulphur_dioxide_daily: {
          label: "Sulphur Dioxide (SO₂) Daily Forecast",
          image: getImage("meteoblue_cams_so2_daily.webp"),
          type: "raster",
          theme: "slider",
          title: "SO₂ (µg/m³)",
          information: "The Sulphur Dioxide (SO₂) Daily Forecast layer displays daily predictions of SO₂ concentrations. SO₂ is a major air pollutant from industrial processes and fossil fuel combustion.",
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
          information:"The Ocean Surface Salinity layer displays the salinity levels of the ocean surface at a depth of 10 meters. This layer is essential for understanding oceanographic processes and their impact on marine ecosystems.",
        },
        ocean_temperature: {
          label: "Ocean Surface Temperature (10m)",
          image: getImage("Sea_Water_Potential_Temperature_10m_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The Ocean Surface Temperature layer displays the temperature of the ocean surface at a depth of 10 meters. This layer is essential for understanding oceanographic processes and their impact on marine ecosystems.",
        },
        ocean_surface_currents: {
          label: "Ocean Surface Currents (10m)",
          image: getImage("Sea_Water_Potential_currents_10m_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The Ocean Surface Currents layer displays the surface currents of the ocean at a depth of 10 meters. This layer is essential for understanding oceanographic processes and their impact on marine ecosystems.",
        },
        ocean_surface_height: {
          label: "Ocean Surface Height w.r.t Geoid",
          image: getImage("Sea_Water_Potential_Height_2mgeoid_forecast.webp"),
          type: "raster",
          theme: "slider",
          geometry: null,
          information:"The Ocean Surface Height layer displays the height of the ocean surface with respect to the geoid. This layer is essential for understanding oceanographic processes and their impact on marine ecosystems.",
        },
      },
      toggle: {
        slick_plus_oil_spills: {
          label: "Oil Spills – SkyTruth Slick+ (Last 7 days)",
          source: {
            id: "slick-plus-oil-spills-source",
            type: "geojson",
            // Django view: path("api/slick-plus-geojson/", SlickPlusGeojsonApi.as_view(), ...)
            data: `${baseUrl}/api/slick-plus/`,
            maxzoom: 22,
          },
          layers: [
            // 1) Filled polygons = oil slick footprint
            {
              id: "slick-plus-oil-spills-fill",
              type: "fill",
              source: "slick-plus-oil-spills-source",
              paint: {
                // Color by slick area – bigger slicks = stronger color
                "fill-color": [
                  "step",
                  ["get", "area"],
                  "#fff5f0", // < 1M
                  1_000_000,
                  "#fee0d2",
                  5_000_000,
                  "#fcbba1",
                  10_000_000,
                  "#fc9272",
                  20_000_000,
                  "#fb6a4a",
                  40_000_000,
                  "#de2d26",
                  80_000_000,
                  "#a50f15", // very large slick
                ],
                "fill-opacity": 0.65,
              },
            },

            // 2) Polygon outline
            {
              id: "slick-plus-oil-spills-outline",
              type: "line",
              source: "slick-plus-oil-spills-source",
              paint: {
                "line-color": "#111111",
                "line-width": 1.5,
                "line-opacity": 0.9,
              },
            },

            // 3) Labels inside polygons (use ID + date)
            {
              id: "slick-plus-oil-spills-label",
              type: "symbol",
              source: "slick-plus-oil-spills-source",
              minzoom: 5,
              layout: {
                "text-field": [
                  "concat",
                  "ID: ",
                  ["to-string", ["get", "id"]],
                  "\n",
                  [
                    "slice",
                    ["to-string", ["get", "slick_timestamp"]],
                    0,
                    10, // YYYY-MM-DD
                  ],
                ],
                "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
                "text-size": 10,
                "text-anchor": "center",
                "text-allow-overlap": false,
              },
              paint: {
                "text-color": "#ffffff",
                "text-halo-color": "rgba(0,0,0,0.8)",
                "text-halo-width": 1.5,
                "text-halo-blur": 0.5,
              },
            },
          ],

          // keep popup behaviour ON (your popup handler will use the feature properties)
          popup: true, // (or ispopup: true if that’s what your code expects)
          legend: true,
          legendPath: getLegendImage("Oil_Spills_SlickPlus.webp"),
          information:
            "This layer shows satellite-detected marine oil slicks from SkyTruth’s Slick+ dataset over Pakistan’s EEZ for the last 7 days. Polygon color reflects slick area; outlines highlight the footprint. Click a slick for detailed attributes (timestamp, area, source hints, etc.).",
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
    // ========================================================================
    // âœ… UPDATED: "DEW Polygons" renamed to "Hazard Alerts" with nested structure
    // ========================================================================
    "Hazard Alerts": {
      nested: {
        // 🆕 NEW: GDACS Alerts sub-accordion with static layers
        "GDACS Alerts": {
          static: {
            gdacs_tc_events: {
              label: "GDACS – Tropical Cyclones (TC)",
              image: getImage("gdacs-TC.webp"),
              type: "geojson",
              theme: "legend",
              source: {
                id: "gdacs_TC",
                type: "geojson",
                data: `${baseUrl}/get-gdacs-events/TC/`,
              },
              layers: [
                {
                  id: "gdacs_TC_fill",
                  type: "fill",
                  source: "gdacs_TC",
                  paint: {
                    "fill-color": [
                      "case",
                      ["==", ["get", "Class"], "Poly_Green"],
                      "#00FF00",
                      ["==", ["get", "Class"], "Poly_Orange"],
                      "#FFA500",
                      ["==", ["get", "Class"], "Poly_Red"],
                      "#FF0000",
                      "#CCCCCC",
                    ],
                    "fill-opacity": 0.4,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_TC_outline",
                  type: "line",
                  source: "gdacs_TC",
                  paint: {
                    "line-opacity": 1,
                    "line-color": "#FFFF00",
                    "line-width": 2,
                  },
                  filter: ["==", "$type", "LineString"],
                },
                {
                  id: "gdacs_TC_label",
                  type: "symbol",
                  source: "gdacs_TC",
                  layout: {
                    "text-field": "{polygonlabel}",
                    "text-size": 12,
                    "text-offset": [0, 0],
                    "text-anchor": "left",
                  },
                },
                {
                  id: "gdacs_TC_icon",
                  type: "symbol",
                  source: "gdacs_TC",
                  layout: {
                    "icon-image": ["get", "icon"], // Use the full URL directly from the icon property
                    "icon-anchor": "bottom",
                    "icon-allow-overlap": true,
                  },
                  filter: ["==", "$type", "Point"],
                },
              ],
              legend: true,
              legendPath: getLegendImage("GDACS_TropicalCyclones.webp"),
              information:
                "Displays GDACS Tropical Cyclone alerts (TC) including polygons, tracks, and icons colored by alert level (Green, Orange, Red).",
            },
            //GDACS Flood Events
            gdacs_fl_events: {
              label: "GDACS – Floods (FL)",
              image: getImage("gdacs-FL.webp"),
              type: "geojson",
              theme: "legend",
              source: {
                id: "gdacs_FL",
                type: "geojson",
                data: `${baseUrl}/get-gdacs-events/FL/`,
              },
              layers: [
                {
                  id: "gdacs_FL_fill",
                  type: "fill",
                  source: "gdacs_FL",
                  paint: {
                    "fill-color": "#FF0000",
                    "fill-opacity": 0.3,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_FL_outline",
                  type: "line",
                  source: "gdacs_FL",
                  paint: {
                    "line-opacity": 0.8,
                    "line-color": "#FF0000",
                    "line-width": 1,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_FL_label",
                  type: "symbol",
                  source: "gdacs_FL",
                  layout: {
                    "text-field": "{polygonlabel}",
                    "text-size": 12,
                    "text-offset": [0, 0],
                    "text-anchor": "left",
                  },
                },
                {
                  id: "gdacs_FL_icon",
                  type: "symbol",
                  source: "gdacs_FL",
                  layout: {
                    "icon-image": ["get", "icon"], // Use the full URL directly from the icon property
                    "icon-anchor": "bottom",
                    "icon-allow-overlap": true,
                  },
                  filter: ["==", "$type", "Point"],
                },
              ],
              legend: true,
              legendPath: getLegendImage("GDACS_Floods.webp"),
              information:
                "Displays GDACS Flood alerts (FL) with polygons and points representing active flood events and their alert levels.",
            },
            //GDACS Earthquake Events
            gdacs_eq_events: {
              label: "GDACS – Earthquakes (EQ)",
              image: getImage("gdacs-EQ.webp"),
              type: "geojson",
              theme: "legend",
              source: {
                id: "gdacs_EQ",
                type: "geojson",
                data: `${baseUrl}/get-gdacs-events/EQ/`,
              },
              layers: [
                {
                  id: "gdacs_EQ_fill",
                  type: "fill",
                  source: "gdacs_EQ",
                  paint: {
                    "fill-color": "#FF0000",
                    "fill-opacity": 0.1,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_EQ_outline",
                  type: "line",
                  source: "gdacs_EQ",
                  paint: {
                    "line-opacity": 0.8,
                    "line-color": "#FF0000",
                    "line-width": 1,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_EQ_label",
                  type: "symbol",
                  source: "gdacs_EQ",
                  layout: {
                    "text-field": "{polygonlabel}",
                    "text-size": 12,
                    "text-offset": [0, 0],
                    "text-anchor": "left",
                  },
                },
                {
                  id: "gdacs_EQ_icon",
                  type: "symbol",
                  source: "gdacs_EQ",
                  layout: {
                    "icon-image": ["get", "icon"], // Use the full URL directly from the icon property
                    "icon-anchor": "bottom",
                    "icon-allow-overlap": true,
                  },
                  filter: ["==", "$type", "Point"],
                },
              ],
              legend: true,
              legendPath: getLegendImage("GDACS_Earthquakes.webp"),
              information:
                "Displays GDACS Earthquake alerts (EQ), including affected polygons and epicenter markers with alert-level icons.",
            },
            //GDACS Volcano Events
            gdacs_vo_events: {
              label: "GDACS – Volcanoes (VO)",
              image: getImage("gdacs-VO.webp"),
              type: "geojson",
              theme: "legend",
              source: {
                id: "gdacs_VO",
                type: "geojson",
                data: `${baseUrl}/get-gdacs-events/VO/`,
              },
              layers: [
                {
                  id: "gdacs_VO_fill",
                  type: "fill",
                  source: "gdacs_VO",
                  paint: {
                    "fill-color": "#FF0000",
                    "fill-opacity": 0.5,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_VO_outline",
                  type: "line",
                  source: "gdacs_VO",
                  paint: {
                    "line-opacity": 0.8,
                    "line-color": "#FF0000",
                    "line-width": 1,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_VO_label",
                  type: "symbol",
                  source: "gdacs_VO",
                  layout: {
                    "text-field": "{polygonlabel}",
                    "text-size": 12,
                    "text-offset": [0, 0],
                    "text-anchor": "left",
                  },
                },
                {
                  id: "gdacs_VO_icon",
                  type: "symbol",
                  source: "gdacs_VO",
                  layout: {
                    "icon-image": ["get", "icon"], // Use the full URL directly from the icon property
                    "icon-anchor": "bottom",
                    "icon-allow-overlap": true,
                  },
                  filter: ["==", "$type", "Point"],
                },
              ],
              legend: true,
              legendPath: getLegendImage("GDACS_Volcanoes.webp"),
              information:
                "Displays GDACS Volcano alerts (VO) including affected zones and volcano locations with alert icons.",
            },
            //GDACS Wildfire Events
            gdacs_wf_events: {
              label: "GDACS – Wildfires (WF)",
              image: getImage("gdacs-WF.webp"),
              type: "geojson",
              theme: "legend",
              source: {
                id: "gdacs_WF",
                type: "geojson",
                data: `${baseUrl}/get-gdacs-events/WF/`,
              },
              layers: [
                {
                  id: "gdacs_WF_fill",
                  type: "fill",
                  source: "gdacs_WF",
                  paint: {
                    "fill-color": "#FF0000",
                    "fill-opacity": 0.5,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_WF_outline",
                  type: "line",
                  source: "gdacs_WF",
                  paint: {
                    "line-opacity": 0.8,
                    "line-color": "#FF0000",
                    "line-width": 1,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_WF_label",
                  type: "symbol",
                  source: "gdacs_WF",
                  layout: {
                    "text-field": "{polygonlabel}",
                    "text-size": 12,
                    "text-offset": [0, 0],
                    "text-anchor": "left",
                  },
                },
                {
                  id: "gdacs_WF_icon",
                  type: "symbol",
                  source: "gdacs_WF",
                  layout: {
                    "icon-image": ["get", "icon"], // Use the full URL directly from the icon property
                    "icon-anchor": "bottom",
                    "icon-allow-overlap": true,
                  },
                  filter: ["==", "$type", "Point"],
                },
              ],
              legend: true,
              legendPath: getLegendImage("GDACS_Wildfires.webp"),
              information:
                "Displays GDACS Wildfire alerts (WF) and their alert levels using polygons and point icons.",
            },
            //GDACS Drought Events
            gdacs_dr_events: {
              label: "GDACS – Drought (DR)",
              image: getImage("gdacs-DR.webp"),
              type: "geojson",
              theme: "legend",
              source: {
                id: "gdacs_DR",
                type: "geojson",
                data: `${baseUrl}/get-gdacs-events/DR/`,
              },
              layers: [
                {
                  id: "gdacs_DR_fill",
                  type: "fill",
                  source: "gdacs_DR",
                  paint: {
                    "fill-color": "#FF0000",
                    "fill-opacity": 0.5,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_DR_outline",
                  type: "line",
                  source: "gdacs_DR",
                  paint: {
                    "line-opacity": 0.8,
                    "line-color": "#FF0000",
                    "line-width": 1,
                  },
                  filter: ["==", "$type", "Polygon"],
                },
                {
                  id: "gdacs_DR_label",
                  type: "symbol",
                  source: "gdacs_DR",
                  layout: {
                    "text-field": "{polygonlabel}",
                    "text-size": 12,
                    "text-offset": [0, 0],
                    "text-anchor": "left",
                  },
                },
                {
                  id: "gdacs_DR_icon",
                  type: "symbol",
                  source: "gdacs_DR",
                  layout: {
                    "icon-image": ["get", "icon"], // Use the full URL directly from the icon property
                    "icon-anchor": "bottom",
                    "icon-allow-overlap": true,
                  },
                  filter: ["==", "$type", "Point"],
                },
              ],
              legend: true,
              legendPath: getLegendImage("GDACS_Drought.webp"),
              information:
                "Displays GDACS Drought alerts (DR) with affected areas and drought alert-level markers.",
            },
          },
        },

        "NASA EONET Events": {
          static: {
            eonet_all_events: {
              label: "NASA EONET Events",
              image: getImage("eonetevents.webp"),
              type: "geojson",
              theme: null,
              source: {
                id: "eonet_all_events",
                type: "geojson",
                data: `${baseUrl}/get-nasa-eonet-events/all/`,
              },
              layers: createEonetLayers("eonet_all_events", "#0ea5e9", "#38bdf8", EONET_ICON_IDS.all),
              popup: true,
              information:
                "Displays NASA EONET natural events from the official EONET v3 feed, including open event geometries and event metadata.",
            },
            eonet_severe_storms: {
              label: "NASA EONET Severe Storms",
              image: getImage("eonet_severeStorms.webp"),
              type: "geojson",
              theme: null,
              source: {
                id: "eonet_severe_storms",
                type: "geojson",
                data: `${baseUrl}/get-nasa-eonet-events/severeStorms/`,
              },
              layers: createEonetLayers("eonet_severe_storms", "#2563eb", "#60a5fa", EONET_ICON_IDS.severeStorms),
              popup: true,
              information:
                "Displays open NASA EONET severe storm events with associated event geometry and sources.",
            },
            eonet_wildfires: {
              label: "NASA EONET Wildfires",
              image: getImage("eonet_wildfires.webp"),
              type: "geojson",
              theme: null,
              source: {
                id: "eonet_wildfires",
                type: "geojson",
                data: `${baseUrl}/get-nasa-eonet-events/wildfires/`,
              },
              layers: createEonetLayers("eonet_wildfires", "#dc2626", "#f97316", EONET_ICON_IDS.wildfires),
              popup: true,
              information:
                "Displays open NASA EONET wildfire events with geometry, categories, and source metadata.",
            },
            eonet_volcanoes: {
              label: "NASA EONET Volcanoes",
              image: getImage("eonet_volcano.webp"),
              type: "geojson",
              theme: null,
              source: {
                id: "eonet_volcanoes",
                type: "geojson",
                data: `${baseUrl}/get-nasa-eonet-events/volcanoes/`,
              },
              layers: createEonetLayers("eonet_volcanoes", "#7c3aed", "#a855f7", EONET_ICON_IDS.volcanoes),
              popup: true,
              information:
                "Displays open NASA EONET volcano events with event geometry and descriptive metadata.",
            },
            eonet_earthquakes: {
              label: "NASA EONET Earthquakes",
              image: getImage("eonet_earthquakes.webp"),
              type: "geojson",
              theme: null,
              source: {
                id: "eonet_earthquakes",
                type: "geojson",
                data: `${baseUrl}/get-nasa-eonet-events/earthquakes/`,
              },
              layers: createEonetLayers("eonet_earthquakes", "#ca8a04", "#facc15", EONET_ICON_IDS.earthquakes),
              popup: true,
              information:
                "Displays open NASA EONET earthquake events with event geometry and source references.",
            },
            eonet_sea_lake_ice: {
              label: "NASA EONET Sea Lake Ice",
              image: getImage("eonet_seaLakeIce.webp"),
              type: "geojson",
              theme: null,
              source: {
                id: "eonet_sea_lake_ice",
                type: "geojson",
                data: `${baseUrl}/get-nasa-eonet-events/seaLakeIce/`,
              },
              layers: createEonetLayers("eonet_sea_lake_ice", "#0891b2", "#22d3ee", EONET_ICON_IDS.seaLakeIce),
              popup: true,
              information:
                "Displays open NASA EONET sea and lake ice events with geometry and source references.",
            },
          },
        },

        "USGS Earthquake Alerts": {
          static: {
            usgs_realtime_eq_events: {
              label: "USGS Realtime Earthquakes",
              image: getImage("usgs_realtime_earthquake_events.webp"),
              type: "geojson",
              theme: null,
              source: {
                id: "usgs_realtime_eq_events",
                type: "geojson",
                data: `${baseUrl}/get-usgs-earthquake-alerts/`,
              },
              layers: createUsgsEarthquakeLayers("usgs_realtime_eq_events"),
              popup: true,
              information:
                "Displays realtime USGS earthquake events from the last 2 days with pulsing markers sized by magnitude and popup-driven ShakeMap access.",
            },
          },
        },

        "Meteoblue early warnings": {
          temporal: {
            official_weather_warnings_forecast: {
              label: "Official Weather Warnings (Forecast)",
              image: getImage("nems_forecast_offical_warnings.webp"),
              type: "raster",
              theme: "slider",
              geometry: null,
              information:
                "The Official Weather Warnings (Forecast) layer displays the official weather warnings issued by meteorological authorities. This layer is essential for staying informed about severe weather threats and taking appropriate precautions.",
            },
            meteorological_risks_forecast: {
              label: "Meteorological Risks (Forecast)",
              image: getImage("nems_forecast_met_warnings.webp"),
              type: "raster",
              theme: "slider",
              geometry: null,
              information:
                "The Meteorological Risks (Forecast) layer displays the meteorological risks associated with various weather phenomena. This layer is essential for understanding potential weather hazards and preparing for adverse conditions.",
            },
          },
          static: {
            lhasa2_latest: {
              label: "LHASA2 Landslide Probability (Latest)",
              image: getImage("nems_forecast_met_warnings.webp"),
              type: "raster",
              theme: null,
              source: mbx_lhasa2_latest.source,
              layers: mbx_lhasa2_latest.layers,
              information:
                "The LHASA2 Landslide Probability (Latest) layer displays the latest Meteoblue landslide probability daily product as a dynamically updating static layer using the most recent daily time returned by Meteoblue.",
            },
          },
        },
      },
    },
    // "DEW Parameters": {
    //   button: {
    //     tech_ew: {
    //       label: "Tech EW",
    //       color: "#FF5733", // Bright Orange-Red (Existing)
    //       outline: "#C70039", // Dark Red (Existing)
    //     },
    //     nidm: {
    //       label: "NIDM",
    //       color: "#3366FF", // Royal Blue (Formal/Professional)
    //       outline: "#0033CC",
    //     },
    //     mobile_app: {
    //       label: "Mobile App",
    //       color: "#00CC99", // Teal (Modern/Digital)
    //       outline: "#008066",
    //     },
    //     media_comm: {
    //       label: "Media Comm",
    //       color: "#FFC300", // Gold/Amber (Communication/Alerts)
    //       outline: "#CC9900",
    //     },
    //     drr: {
    //       label: "DRR",
    //       color: "#339933", // Forest Green (Safety/Environment)
    //       outline: "#1E661E",
    //     },
    //     infra_development: {
    //       label: "Infra Development",
    //       color: "#607D8B", // Slate Blue-Gray (Structure/Construction)
    //       outline: "#455A64",
    //     },
    //     operations: {
    //       label: "Operations",
    //       color: "#CC0066", // Deep Magenta (Action/Management)
    //       outline: "#99004C",
    //     },
    //     plans: {
    //       label: "Plans",
    //       color: "#663399", // Deep Purple (Strategy/Planning)
    //       outline: "#4C2673",
    //     },
    //     intl_colaboration: {
    //       label: "Intl Collaboration",
    //       color: "#33CCFF", // Bright Sky Blue (Global/Partnership)
    //       outline: "#0099CC",
    //     },
    //     rm_and_m: {
    //       label: "RM & M",
    //       color: "#996633", // Earthy Brown (Resource Management)
    //       outline: "#664422",
    //     },
    //     cdrf: {
    //       label: "CDRF",
    //       color: "#00BFA5", // Mint Teal (Finance/Sustainability)
    //       outline: "#00897B",
    //     },
    //   },
    // },
  },
};
window.ncop_menu_items = ncop_menu_items;
