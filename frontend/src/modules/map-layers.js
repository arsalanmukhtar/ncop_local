import airportIcon from "@assets/images/map_icons/airplane.webp";
import schoolIcon from "@assets/images/map_icons/school.webp";
import settlementIcon from "@assets/images/map_icons/settlement.webp";

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
                        tiles: ["http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:national_boundary@EPSG:900913@pbf/{z}/{x}/{y}.pbf"],
                        maxzoom: 22
                    },
                    layers: [
                        {
                            id: "national_boundary-fill",
                            type: "fill",
                            source: "national_boundary-source",
                            "source-layer": "national_boundary",
                            paint: {
                                "fill-color": "#ffffff",
                                "fill-opacity": 0
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
                    attributes: {
                        name: "Name",
                    },
                    information: "The National Boundary layer outlines the borders of the country, providing a clear demarcation of national territory. This layer is essential for understanding geopolitical boundaries and is often used as a reference for other spatial data layers.",
                },
                provincial_boundary: {
                    label: "Provincial Boundary",
                    theme: null,
                    geometry: "polygon",
                    source: {
                        id: "provincial_boundary-source",
                        type: "vector",
                        scheme: "tms",
                        tiles: ["http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:provincial_boundary@EPSG:900913@pbf/{z}/{x}/{y}.pbf"],
                        maxzoom: 22
                    },
                    layers: [
                        {
                            id: "provincial_boundary-fill",
                            type: "fill",
                            source: "provincial_boundary-source",
                            "source-layer": "provincial_boundary",
                            paint: {
                                "fill-color": "#ffffff",
                                "fill-opacity": 0
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
                    information: "The Provincial Boundary layer delineates the borders of provinces within the country. This layer is crucial for regional planning and analysis, allowing users to visualize and manage data at the provincial level.",
                },
                district_boundary: {
                    label: "District Boundary",
                    theme: null,
                    source: {
                        id: "district_boundary-source",
                        type: "vector",
                        scheme: "tms",
                        tiles: ["http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:district_boundary@EPSG:900913@pbf/{z}/{x}/{y}.pbf"],
                        maxzoom: 22
                    },
                    layers: [
                        {
                            id: "district_boundary-fill",
                            type: "fill",
                            source: "district_boundary-source",
                            "source-layer": "district_boundary",
                            paint: {
                                "fill-color": "#ffffff",
                                "fill-opacity": 0
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
                    information: "The District Boundary layer outlines the borders of districts within the country. This layer is important for local governance and resource management, providing a clear framework for administrative boundaries.",
                },
                tehsil_boundary: {
                    label: "Tehsil Boundary",
                    theme: null,
                    source: {
                        id: "tehsil_boundary-source",
                        type: "vector",
                        scheme: "tms",
                        tiles: ["http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:tehsil_boundary@EPSG:900913@pbf/{z}/{x}/{y}.pbf"],
                        maxzoom: 22
                    },
                    layers: [
                        {
                            id: "tehsil_boundary-fill",
                            type: "fill",
                            source: "tehsil_boundary-source",
                            "source-layer": "tehsil_boundary",
                            paint: {
                                "fill-color": "#ffffff",
                                "fill-opacity": 0
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
                    information: "The Tehsil Boundary layer marks the subdivisions within districts, known as tehsils. This layer is important for local governance and administrative purposes, helping to manage resources and services at a more granular level.",
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
                        tiles: ["http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:airports@EPSG:900913@pbf/{z}/{x}/{y}.pbf"],
                        maxzoom: 22
                    },
                    layers: [
                        {
                            id: "airports-symbol",
                            type: "symbol",
                            source: "airports-source",
                            "source-layer": "airports",
                            layout: {
                                "icon-image": airportIcon, // Use custom icon name
                                // Interpolate icon-size based on zoom for smooth scaling
                                "icon-size": [
                                    "interpolate",
                                    ["linear"],
                                    ["zoom"],
                                    5, 0.25,
                                    10, 0.5,
                                    15, 1
                                ],
                                "icon-allow-overlap": true
                            }                            
                        }
                    ],
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
                        tiles: ["http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:schools@EPSG:900913@pbf/{z}/{x}/{y}.pbf"],
                        maxzoom: 22
                    },
                    layers: [
                        {
                            id: "schools-symbol",
                            type: "symbol",
                            source: "schools-source",
                            "source-layer": "schools",
                            layout: {
                                "icon-image": schoolIcon, // Use custom icon name
                                // Interpolate icon-size based on zoom for smooth scaling
                                "icon-size": [
                                    "interpolate",
                                    ["linear"],
                                    ["zoom"],
                                    5, 0.25,
                                    10, 0.5,
                                    15, 1
                                ],
                                "icon-allow-overlap": false
                            }
                        }
                    ],
                    information: "The Schools layer displays the locations of schools within the country. This layer is essential for education planning and resource allocation, providing critical information for educational services and facilities.",
                },
                settlements: {
                    label: "Settlements",
                    theme: null,
                    source: {
                        id: "settlements-source",
                        type: "vector",
                        scheme: "tms",
                        tiles: ["http://172.18.7.35:8080/geoserver/gwc/service/tms/1.0.0/gcop:settlements@EPSG:900913@pbf/{z}/{x}/{y}.pbf"],
                        maxzoom: 22
                    },
                    layers: [
                        {
                            id: "settlements-symbol",
                            type: "symbol",
                            source: "settlements-source",
                            "source-layer": "settlements",
                            layout: {
                                "icon-image": settlementIcon, // Use custom icon name
                                // Interpolate icon-size based on zoom for smooth scaling
                                "icon-size": [
                                    "interpolate",
                                    ["linear"],
                                    ["zoom"],
                                    5, 0.25,
                                    10, 0.5,
                                    15, 1
                                ],
                                "icon-allow-overlap": false
                            }
                        }
                    ],
                    information: "The Settlements layer displays the locations of settlements within the country. This layer is essential for urban planning and resource allocation, providing critical information for residential services and facilities.",
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
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                satellite_infrared: {
                    label: "Satellite Infrared",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                dwd_satellite_infrared: {
                    label: "DWD Satellite Infrared",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                imerg_precipitation_rate_14_days: {
                    label: "IMERG Precipitation Rate (14 Days)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
            },
        },
        "Global Deterministic Prediction System (GDPS)": {
            temporal: {
                specific_humidity_2m_above_ground: {
                    label: "Specific Humidity (2m Above Ground)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                relative_humidity_percent: {
                    label: "Relative Humidity (%)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                accumulated_precipitation: {
                    label: "Accumulated Precipitation",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                "precipitation_type_/_3hrs": {
                    label: "Precipitation Type / 3hrs",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
            },
        },
        "ECMWF Weather Forecast Parameters": {
            temporal: {
                temperature_850hPa: {
                    label: "Temperature (850hPa)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                lightning_forecast: {
                    label: "Lightning Forecast",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                tropical_cyclone_strike_probability: {
                    label: "Tropical Cyclone Strike Probability",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
            },
        },
        "Meteoblue Forecast": {
            temporal: {
                weekly_precipitation_2m_above_ground: {
                    label: "Weekly Precipitation (2m Above Ground)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                hourly_precipitation_2m_above_ground: {
                    label: "Hourly Precipitation (2m Above Ground)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                hourly_snowfall_forecast: {
                    label: "Hourly Snowfall (Forecast)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                weekly_snowfall_forecast: {
                    label: "Weekly Snow (Forecast)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                cape_hourly_forecast: {
                    label: "CAPE Hourly (Forecast)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                cape_weekly_forecast: {
                    label: "CAPE Weekly (Forecast)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                "storm_helicity_forecast_0-3km": {
                    label: "Storm Helicity Forecast (0-3km)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                precipitation_radar: {
                    label: "Precipitation Radar",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                temperature_2m_above_ground: {
                    label: "Temperature (2m Above Ground)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                official_weather_warnings_forecast: {
                    label: "Official Weather Warnings (Forecast)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                meteorological_risks_forecast: {
                    label: "Meteorological Risks (Forecast)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
            },
        },
        "Pakistan Meteorological Department (PMD)": {
            toggle: {
                precipitation_past_3_days: {
                    label: "Precipitation (Past 3 Days)",
                    type: "geojson",
                    theme: null,
                    geometry: null,
                },
                pmd_rainfall_stations: {
                    label: "PMD Rainfall Stations",
                    type: "geojson",
                    theme: null,
                    geometry: null,
                },
                pmd_temperature_stations: {
                    label: "PMD Temperature Stations",
                    type: "geojson",
                    theme: null,
                    geometry: null,
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
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                precipitation_probability_150mm_10days: {
                    label: "Precipitation Probability > 150mm (10 Days)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                precipitation_probability_300mm_10days: {
                    label: "Precipitation Probability > 300mm (10 Days)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                accumulated_precipitation: {
                    label: "Accumulated Precipitation",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                flood_summary_day_1_3: {
                    label: "Flood Summary (Day 1-3)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                flood_summary_day_4_10: {
                    label: "Flood Summary (Day 4-10)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
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
                "particulate_matter_2.5": {
                    label: "Particulate Matter (2.5)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                particulate_matter_10: {
                    label: "Particulate Matter (10)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                nitrogen_dioxide_850hPa: {
                    label: "Nitrogen Dioxide (850hPa)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                ozone: {
                    label: "Ozone",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                sulphur_dioxide_850hPa: {
                    label: "Sulphur Dioxide (850hPa)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                carbon_monoxide: {
                    label: "Carbon Monoxide",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                dust: {
                    label: "Dust",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                methane_at_300hPa: {
                    label: "Methane at 300hPa",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
            },
        },
    },
    "ocean/coastal": {
        Oceanography: {
            temporal: {
                ocean_surface_salinity_10m: {
                    label: "Ocean Surface Salinity (10m)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                ocean_surface_temperature_10m: {
                    label: "Ocean Surface Temperature (10m)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                ocean_surface_currents_10m: {
                    label: "Ocean Surface Currents (10m)",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
                ocean_surface_height_wrt_geoid: {
                    label: "Ocean Surface Height w.r.t Geoid",
                    image:
                        "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80",
                    type: "raster",
                    theme: "slider",
                    geometry: null,
                },
            },
        },
    },
    "Disaster Early Warning (DEW)": {
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
        "DEW Exposures Api Features": {
            dropdown: [
                {
                    endpoint: "http://172.18.1.108:8000/get-exposures/",
                    key: "id",
                    attribute: "remarks",
                    type: "geojson",
                    theme: null,
                    geometry: null,
                },
                {
                    endpoint: "http://172.18.1.108:8000/get-exposures/",
                    key: "id",
                    attribute: "remarks",
                    type: "geojson",
                    theme: null,
                    geometry: null,
                },
            ],
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
