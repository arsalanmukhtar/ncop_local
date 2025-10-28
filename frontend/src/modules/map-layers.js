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
  generateOceanSurfaceHeightLayers
} from "./time-functions.js";

// Global baseUrl for the entire application
window.baseUrl = window.location.origin;
console.log('🌐 Global baseUrl:', window.baseUrl);
export const baseUrl = window.baseUrl;

// Layer thumbnails can be added in loop by importing images like below
const images = import.meta.glob("@assets/images/layer_thumbnails/*.webp", { eager: true });
// Use this function name with image name to load it e.g. getImage('airports.webp')
function getImage(filename) {
    const match = Object.entries(images).find(([path]) => path.includes(filename));
    return match ? match[1].default : null;
}

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
console.log(
  "✅ DWD layers created:",
  window.dwd_satellite_infrared.length,
  "steps"
);

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
          information:"The National Boundary layer outlines the borders of the country, providing a clear demarcation of national territory. This layer is essential for understanding geopolitical boundaries and is often used as a reference for other spatial data layers.",
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
          popup: false,
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
          information: "The Airports layer displays the locations of airports within the country. This layer is essential for transportation planning and logistics, providing critical information for air travel and connectivity.",
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
        "storm_helicity_forecast_0-3km": {
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
          information: "The DEW Exposures layer provides detailed information on various exposure points related to disaster early warning systems. This layer is crucial for identifying vulnerable areas and populations, enabling targeted interventions and resource allocation during disaster events.",
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