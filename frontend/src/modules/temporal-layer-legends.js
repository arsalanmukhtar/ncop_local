// Utility to generate standardized linear gradient legend bars.
// Reference layout: gradient bar on top, value labels positioned below at matching percentages.
function gradientLegendBar(colors, values) {
  // colors: array of color stops (hex/rgb)
  // values: array of tick labels (numbers/strings)
  const gradient = `linear-gradient(to right, ${colors.join(", ")})`;
  const n = values.length;
  let html = `<div class="ts-legend-stack">`;
  html += `<div class="ts-legend-bar" style="background: ${gradient};"></div>`;
  html += `<div class="ts-legend-values">`;
  values.forEach((val, i) => {
    const leftPercent = (n === 1) ? 0 : (i / (n - 1)) * 100;
    let translate;
    if (i === 0) translate = "translateX(0%)";
    else if (i === n - 1) translate = "translateX(-100%)";
    else translate = "translateX(-50%)";
    html += `<span style="left: ${leftPercent}%; transform: ${translate};">${val}</span>`;
  });
  html += `</div></div>`;
  return html;
}

export const legends = {
  dwd_satellite_infrared: gradientLegendBar(
    [
      "rgb(255, 204, 255)",
      "rgb(255, 143, 255)",
      "rgb(255, 0, 255)",
      "rgb(190, 0, 255)",
      "rgb(126, 0, 255)",
      "rgb(64, 0, 0)",
      "rgb(191, 0, 0)",
      "rgb(255, 0, 0)",
      "rgb(250, 63, 0)",
      "rgb(255, 192, 0)",
      "rgb(254, 255, 0)",
      "rgb(34, 255, 0)",
      "rgb(0, 253, 255)",
      "rgb(0, 121, 255)",
      "rgb(0, 65, 255)",
      "rgb(0, 0, 255)",
      "rgb(153, 153, 153)",
      "rgb(114, 114, 114)",
      "rgb(96, 96, 96)",
      "rgb(80, 80, 80)",
      "rgb(59, 59, 59)",
      "rgb(32, 32, 32)",
      "rgb(16, 16, 16)",
      "rgb(12, 12, 12)",
    ],
    [
      "-84",
      "-76",
      "-68",
      "-60",
      "-52",
      "-44",
      "-36",
      "-28",
      "-20",
      "-12",
      "-4",
      "4",
      "12",
      "20",
      "28",
      "36",
      "44",
      "40",
    ]
  ),
  rainviewerSatInfra: gradientLegendBar(
    ["#565B54", "#7B7C7B", "#A3A3A3", "#C8C8C8", "#EAEAEA", "#F5F5F5"],
    ["Low", "Med-Low", "Medium", "Med-High", "High", "Very High"]
  ),
  rainviewerRadar: gradientLegendBar(
    [
      "#63eb63",
      "#3dc63d",
      "#1f9e34",
      "#116719",
      "#023002",
      "#ff0",
      "#ff7f00",
      "#e60000",
      "#cd0000",
      "#9b0000",
      "#820000",
    ],
    ["0.1", "0.5", "1", "2", "5", "10", "20", "30", "50", "100", "150"]
  ),
  specific_humidity_2m_above_ground: gradientLegendBar(
    [
      "#FFFFFF",
      "#0010CC",
      "#0031FE",
      "#00B3FE",
      "#28FDD4",
      "#90FD6D",
      "#F6FE05",
      "#FEA300",
      "#FE3B00",
      "#DC0000",
      "#B10000",
      "#830000",
    ],
    ["0", "5", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"]
  ),
  relative_humidity_2m_above_ground: gradientLegendBar(
    [
      "#FFFFFF",
      "#0010CC",
      "#0031FE",
      "#00B3FE",
      "#28FDD4",
      "#90FD6D",
      "#F6FE05",
      "#FEA300",
      "#FE3B00",
      "#DC0000",
      "#B10000",
      "#830000",
    ],
    ["0", "5", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100"]
  ),
  gdpsSpecificHum: gradientLegendBar(
    ["#001AB4", "#1AA3E3", "#B4FE4B", "#FE7201", "#AD1300"],
    ["Very Low", "Low", "Moderate", "High", "Very High"]
  ),
  gdps_accumulated_precipitation: gradientLegendBar(
    [
      "#FFFFFF",
      "#B8D5FF",
      "#A1C7FF",
      "#A6CBFF",
      "#7AACFF",
      "#3DA0F3",
      "#1FCADF",
      "#27E4D5",
      "#36F0C6",
      "#62FF9B",
      "#CCFE32",
      "#FFE900",
      "#FF9600",
      "#F71D00",
      "#D70000",
      "#280000",
    ],
    [
      "0",
      "1",
      "2",
      "5",
      "10",
      "20",
      "30",
      "40",
      "50",
      "60",
      "70",
      "80",
      "90",
      "100",
      "120",
      "150",
    ]
  ),
  precipitation_type_3hrs: gradientLegendBar(
    ["#007700", "#EECC00", "#FF0000", "#FF06FF", "#005599"],
    ["Rain", "Rain-Snow", "Freezing Rain", "Ice-Pellets", "Snow"]
  ),
  ecmwf_temperature_850hPa: gradientLegendBar(
    [
      "#e133e1",
      "#ae33ae",
      "#7a337a",
      "#473347",
      "#330066",
      "#590080",
      "#8000ff",
      "#0080ff",
      "#00ccff",
      "#00ffff",
      "#00ff80",
      "#80ff00",
      "#daff00",
      "#ffff80",
      "#ffff00",
      "#ffda00",
      "#ffb000",
      "#ff7300",
      "#ff0000",
      "#cc0000",
      "#80002c",
      "#cc3d6e",
      "#ff00ff",
      "#ff80ff",
      "#ffbfff",
    ],
    [
      "-52",
      "-48",
      "-44",
      "-40",
      "-36",
      "-32",
      "-28",
      "-24",
      "-20",
      "-16",
      "-12",
      "-8",
      "-4",
      "0",
      "4",
      "8",
      "12",
      "16",
      "20",
      "24",
      "28",
      "32",
      "36",
      "40",
      "44",
    ]
  ),
  imerg_precipitation_rate_14_days: gradientLegendBar(
    [
      "rgba(56,160,58,1.0)",
      "rgba(141,198,63,1.0)",
      "rgba(193,219,80,1.0)",
      "rgba(245,240,98,1.0)",
      "rgba(245,203,66,1.0)",
      "rgba(245,166,35,1.0)",
      "rgba(239,117,44,1.0)",
      "rgba(234,68,53,1.0)",
      "rgba(208,48,40,1.0)",
      "rgba(183,28,28,1.0)",
      "rgba(151,25,25,1.0)",
      "rgba(120,23,23,1.0)",
      "rgba(93,16,16,1.0)",
      "rgba(66,9,9,1.0)",
    ],
    [
      "0.2",
      "0.5",
      "0.75",
      "1.0",
      "1.5",
      "2.0",
      "3.0",
      "5.0",
      "7.0",
      "10.0",
      "15.0",
      "20.0",
      "30.0",
      "≥53.0",
    ]
  ),
  ecmwf_lightning: gradientLegendBar(
    ["#87ff89", "#feff59", "#fcb12d", "#f65319", "#b10a0a"],
    ["Very Low", "Low", "Moderate", "High", "Very High"]
  ),
  ecmwf_cyclone: gradientLegendBar(
    [
      "#FF06FF",
      "#FF4F01",
      "#FFB000",
      "#FFFE03",
      "#26FF03",
      "#018C30",
      "#00FFFF",
      "#0080FF",
      "#0017FF",
      "#7B11B3",
    ],
    ["5", "10", "20", "30", "40", "50", "60", "70", "80", "90"]
  ),
  particulate_matter_25: gradientLegendBar(
    [
      "#ffffff",
      "#ecfac5",
      "#ceffcf",
      "#9df0b4",
      "#5abd9f",
      "#3da695",
      "#3c94b2",
      "#1a6ead",
      "#124e89",
      "#121b92",
      "#2b0043",
    ],
    ["0", "20", "30", "40", "50", "60", "80", "100", "150", "200", "300"]
  ),
  particulate_matter_10: gradientLegendBar(
    [
      "#265ba0",
      "#269170",
      "#6bb25b",
      "#a8c96b",
      "#fff49b",
      "#f4d138",
      "#eab538",
      "#dd8740",
      "#cc3533",
      "#9b1623",
      "#561919",
      "#341919",
    ],
    [
      "0.01",
      "0.02",
      "0.05",
      "0.1",
      "0.2",
      "0.5",
      "1",
      "2",
      "5",
      "10",
      "20",
      "50",
    ]
  ),
  nitrogen_dioxide_850hPa: gradientLegendBar(
    [
      "#265ba0",
      "#269170",
      "#6bb25b",
      "#a8c96b",
      "#fff49b",
      "#f4d138",
      "#eab538",
      "#dd8740",
      "#cc3533",
      "#9b1623",
      "#561919",
      "#341919",
    ],
    [
      "0.01",
      "0.02",
      "0.05",
      "0.1",
      "0.2",
      "0.5",
      "1",
      "2",
      "5",
      "10",
      "20",
      "50",
    ]
  ),
  sulphur_dioxide_850hPa: gradientLegendBar(
    [
      "#c6e9f3",
      "#b3dfeb",
      "#a0d5e3",
      "#bfdfcd",
      "#ebeeb3",
      "#fae88e",
      "#f5d363",
      "#edb43d",
      "#e18621",
      "#d05d0c",
      "#aa4211",
      "#852716",
    ],
    ["0", "2", "5", "10", "20", "30", "40", "50", "75", "100", "150", "200"]
  ),
  co2_850hpa: gradientLegendBar(
    [
      "#0c0c0c",
      "#3800a3",
      "#007ddd",
      "#00aa90",
      "#00c700",
      "#b0ff00",
      "#ffb100",
      "#db0000",
      "#66001e",
      "#66001e",
      "#66001e",
    ],
    ["380", "390", "400", "405", "410", "415", "420", "425", "430", "435", "440", "450+"]
  ),
  co2_surface: gradientLegendBar(
    [
      "#5e4fa2",
      "#3485bc",
      "#60bba8",
      "#a2daa4",
      "#edf8a3",
      "#fff8b2",
      "#ffe999",
      "#febf6f",
      "#f8844d",
      "#e2514a",
      "#9e0142",
    ],
    ["380", "390", "400", "405", "410", "415", "420", "425", "430", "435", "440", "450+"]
  ),
  ozone: gradientLegendBar(
    [
      "#c6e9f3",
      "#b3dfeb",
      "#a0d5e3",
      "#bfdfcd",
      "#ebeeb3",
      "#fae88e",
      "#f5d363",
      "#edb43d",
      "#e18621",
      "#d05d0c",
      "#aa4211",
      "#852716",
    ],
    [
      "0",
      "50",
      "100",
      "150",
      "200",
      "250",
      "300",
      "350",
      "400",
      "500",
      "700",
      "1000",
    ]
  ),
  carbon_monoxide: gradientLegendBar(
    [
      "#c6e9f3",
      "#b3dfeb",
      "#a0d5e3",
      "#bfdfcd",
      "#ebeeb3",
      "#fae88e",
      "#f5d363",
      "#edb43d",
      "#e18621",
      "#d05d0c",
      "#aa4211",
      "#852716",
    ],
    [
      "0",
      "50",
      "100",
      "150",
      "200",
      "250",
      "300",
      "350",
      "400",
      "500",
      "700",
      "1000",
    ]
  ),
  dust: gradientLegendBar(
    [
      "#FFFFFE",
      "#FEF7F0",
      "#FDE5D0",
      "#FCD2B1",
      "#FABA8F",
      "#F09A67",
      "#DF7747",
      "#CD6839",
      "#913815",
      "#7D290B",
    ],
    ["0.1", "0.15", "0.2", "0.25", "0.3", "0.35", "0.4", "0.5", "0.8", "1.0"]
  ),
  methane_at_300hPa: gradientLegendBar(
    [
      "#0c0c0c",
      "#680177",
      "#850096",
      "#2d00a4",
      "#0000c9",
      "#0041dd",
      "#0085dd",
      "#009fcb",
      "#00aaa0",
      "#00a773",
      "#009c00",
      "#00bd00",
      "#00da00",
      "#00fa00",
      "#84ff00",
      "#ceff29",
      "#dcf400",
      "#f8da00",
      "#ffb500",
      "#ff5d00",
      "#f40000",
      "#da0000",
      "#be0004",
      "#66001e",
    ],
    ["0", "1780", "1840", "1900", "1960", "2020", "2080", "2140", "10000"]
  ),
  sulphate_aod_550: gradientLegendBar(
    [
      "#0000f2",
      "#004cff",
      "#00b1ff",
      "#29ffce",
      "#7dff7a",
      "#ceff29",
      "#ffc500",
      "#ff6800",
      "#f20700",
    ],
    ["0", "0.02", "0.05", "0.1", "0.15", "0.2", "0.3", "0.4", "0.5", "0.8+"]
  ),
  biomass_burning_aod_550: gradientLegendBar(
    [
      "#0000f2",
      "#004cff",
      "#00b1ff",
      "#29ffce",
      "#7dff7a",
      "#ceff29",
      "#ffc500",
      "#ff6800",
      "#f20700",
    ],
    ["0", "0.05", "0.1", "0.2", "0.3", "0.5", "0.8", "1.0", "1.5", "2.0+"]
  ),
  sea_salt_aod_550: gradientLegendBar(
    [
      "#F0F9FF",
      "#CCE4F0",
      "#99CCE0",
      "#66B3D1",
      "#3399C2",
      "#0080B3",
      "#006699",
      "#004D80",
    ],
    ["0", "0.02", "0.05", "0.1", "0.15", "0.2", "0.3", "0.4", "0.6+"]
  ),
  hcho_surface: gradientLegendBar(
    [
      "#F7FCF5",
      "#E5F5E0",
      "#C7E9C0",
      "#A1D99B",
      "#74C476",
      "#41AB5D",
      "#238B45",
      "#006D2C",
      "#00441B",
    ],
    ["0", "1", "2", "3", "5", "7", "10", "15", "20", "30+"]
  ),
  uv_index_daily_max: gradientLegendBar(
    [
      "#42a631", // Low
      "#fff300", // Moderate
      "#ef8a00", // High
      "#e63510", // Very High
      "#b565a5", // Extreme
    ],
    ["0-2 (Low)", "3-5 (Moderate)", "6-7 (High)", "8-10 (Very High)", "11+ (Extreme)"]
  ),
  ocean_salinity: gradientLegendBar(
    [
      "#000DB9",
      "#0014ED",
      "#0028FF",
      "#0168FF",
      "#00A2FF",
      "#00E1FF",
      "#13FDEB",
      "#46FDB7",
      "#77FD86",
      "#EEFE10",
      "#FEDB02",
      "#FEDE00",
      "#FEA400",
      "#FE4901",
      "#FE4201",
      "#B00000",
    ],
    [
      "0-2",
      "2-4",
      "4-7",
      "7-9",
      "9-11",
      "11-13",
      "13-16",
      "16-18",
      "18-20",
      "20-22",
      "22-24",
      "24-27",
      "27-29",
      "29-31",
      "31-33",
      "33-37",
    ]
  ),
  ocean_temperature: gradientLegendBar(
    [
      "#00067F",
      "#012EDC",
      "#2ADED3",
      "#C9FE34",
      "#FE9301",
      "#D52200",
      "#8C0500",
      "#7F0000",
    ],
    ["271K", "278K", "284K", "290K", "296K", "297K", "303K", "400K"]
  ),
  ocean_surface_currents: gradientLegendBar(
    [
      "#99E8FD",
      "#9994FF",
      "#9A40F9",
      "#CC87FE",
      "#A8C0B5",
      "#80FF64",
      "#D1FE2D",
      "#FFD900",
      "#FF8001",
      "#FF3C00",
      "#FF1400",
      "#3C0000",
    ],
    [
      "0.00",
      "0.10",
      "0.20",
      "0.30",
      "0.40",
      "0.50",
      "0.60",
      "0.70",
      "0.80",
      "0.90",
      "1.00",
      "2.50",
    ]
  ),
  ocean_surface_height: gradientLegendBar(
    [
      "#000892",
      "#000EBD",
      "#0014ED",
      "#0028FF",
      "#0065FF",
      "#0096FF",
      "#00EBFF",
      "#1CFEE0",
      "#5CFDA1",
      "#8DFD70",
      "#BBFF42",
      "#F6FE0A",
      "#FED302",
      "#FE9C01",
      "#FE7600",
      "#FE0800",
      "#D80100",
      "#D60000",
      "#A90000",
      "#800000",
    ],
    [
      "-2.7",
      "-2.4",
      "-2.1",
      "-1.8",
      "-1.5",
      "-1.2",
      "-0.9",
      "-0.6",
      "-0.3",
      "0.0",
      "0.3",
      "0.6",
      "0.9",
      "1.2",
      "1.5",
      "1.8",
      "2.1",
      "2.4",
      "2.7",
      "3.0",
    ]
  ),
  weekly_precipitation_2m_above_ground: gradientLegendBar(
    [
      "#C2FBFA",
      "#87A9FD",
      "#7B95F9",
      "#3496FE",
      "#3686DD",
      "#35AC9F",
      "#35D14D",
      "#BEFE35",
      "#5CFDA1",
      "#BE46EB",
      "#FF8134",
      "#FD6334",
      "#FC4335",
    ],
    ["0", "0.25", "1", "2", "4", "6", "10", "15", "20", "30", "50", "70", "100"]
  ),
  hourly_precipitation_2m_above_ground: gradientLegendBar(
    [
      "#C2FBFA",
      "#87A9FD",
      "#7B95F9",
      "#3496FE",
      "#3686DD",
      "#35AC9F",
      "#35D14D",
      "#BEFE35",
      "#5CFDA1",
      "#BE46EB",
      "#FF8134",
      "#FD6334",
      "#FC4335",
    ],
    ["0", "0.25", "1", "2", "4", "6", "10", "15", "20", "30", "50", "70", "100"]
  ),
  temperature_2m_above_ground: gradientLegendBar(
    [
      "#1C378A",
      "#264FAC",
      "#348CFE",
      "#44B1F6",
      "#51D4D9",
      "#80E0F7",
      "#A0EAF7",
      "#00EF7C",
      "#3CA12C",
      "#B5FF33",
      "#FFF600",
      "#FFB600",
      "#FF6B00",
      "#FF2E2E",
      "#F316C2",
    ],
    [
      "-80",
      "-60",
      "-40",
      "-20",
      "-10",
      "-8",
      "-2",
      "0",
      "6",
      "12",
      "18",
      "24",
      "30",
      "36",
      "42",
      "46",
    ]
  ),
  precipitation_radar: gradientLegendBar(
    ["#7AE1E8", "#02C8D8", "#2D7BEA", "#BE46EB", "#E60B0B"],
    ["Drizzle", "Light", "Moderate", "Heavy", "Extreme"]
  ),
  weekly_snowfall_forecast: gradientLegendBar(
    [
      "rgba(230, 250, 255, 0.8)",
      "rgba(191, 236, 243, 1.0)",
      "rgba(156, 227, 242, 1.0)",
      "rgba(113, 207, 240, 1.0)",
      "rgba(84, 193, 238, 1.0)",
      "rgba(63, 181, 237, 1.0)",
      "rgba(43, 168, 229, 1.0)",
      "rgba(22, 150, 218, 1.0)",
      "rgba(28, 133, 207, 1.0)",
      "rgba(90, 123, 248, 1.0)",
      "rgba(134, 111, 250, 1.0)",
      "rgba(170, 100, 245, 1.0)",
      "rgba(200, 85, 230, 1.0)",
      "rgba(215, 65, 200, 1.0)",
      "rgba(230, 50, 160, 1.0)",
      "rgba(245, 35, 120, 1.0)",
      "rgba(255, 20, 80, 1.0)",
    ],
    [
      "0.1",
      "0.5",
      "1",
      "2",
      "4",
      "8",
      "12",
      "16",
      "20",
      "30",
      "50",
      "75",
      "105",
      "150",
      "200",
      "270",
      "360",
    ]
  ),
  hourly_snowfall_forecast: gradientLegendBar(
    [
      "rgba(230, 250, 255, 0.8)",
      "rgba(191, 236, 243, 1.0)",
      "rgba(156, 227, 242, 1.0)",
      "rgba(113, 207, 240, 1.0)",
      "rgba(84, 193, 238, 1.0)",
      "rgba(63, 181, 237, 1.0)",
      "rgba(43, 168, 229, 1.0)",
      "rgba(22, 150, 218, 1.0)",
      "rgba(28, 133, 207, 1.0)",
      "rgba(90, 123, 248, 1.0)",
      "rgba(134, 111, 250, 1.0)",
      "rgba(170, 100, 245, 1.0)",
      "rgba(200, 85, 230, 1.0)",
      "rgba(215, 65, 200, 1.0)",
      "rgba(230, 50, 160, 1.0)",
      "rgba(245, 35, 120, 1.0)",
      "rgba(255, 20, 80, 1.0)",
    ],
    [
      "0.1",
      "0.5",
      "1",
      "2",
      "4",
      "8",
      "12",
      "16",
      "20",
      "25",
      "30",
      "40",
      "50",
      "70",
      "90",
      "110",
      "140",
    ]
  ),
  cape_hourly_forecast: gradientLegendBar(
    [
      "rgba(180, 170, 255, 0.8)",
      "rgba(130, 120, 255, 1.0)",
      "rgba(90, 140, 255, 1.0)",
      "rgba(60, 170, 255, 1.0)",
      "rgba(0, 200, 255, 1.0)",
      "rgba(0, 220, 200, 1.0)",
      "rgba(0, 210, 120, 1.0)",
      "rgba(140, 230, 60, 1.0)",
      "rgba(230, 230, 40, 1.0)",
      "rgba(255, 210, 40, 1.0)",
      "rgba(255, 180, 30, 1.0)",
      "rgba(255, 150, 20, 1.0)",
      "rgba(255, 120, 10, 1.0)",
      "rgba(255, 90, 0, 1.0)",
      "rgba(255, 60, 0, 1.0)",
      "rgba(255, 30, 0, 1.0)",
      "rgba(255, 0, 0, 1.0)",
      "rgba(240, 0, 0, 1.0)",
      "rgba(230, 0, 0, 1.0)",
      "rgba(0, 255, 255, 1.0)",
    ],
    [
      "25",
      "75",
      "125",
      "250",
      "500",
      "750",
      "1000",
      "1250",
      "1500",
      "1750",
      "2000",
      "2250",
      "2500",
      "2750",
      "3000",
      "3250",
      "3500",
      "4000",
      "4500",
      "5000",
    ]
  ),
  cape_weekly_forecast: gradientLegendBar(
    [
      "rgba(180, 170, 255, 0.8)",
      "rgba(130, 120, 255, 1.0)",
      "rgba(90, 140, 255, 1.0)",
      "rgba(60, 170, 255, 1.0)",
      "rgba(0, 200, 255, 1.0)",
      "rgba(0, 220, 200, 1.0)",
      "rgba(0, 210, 120, 1.0)",
      "rgba(140, 230, 60, 1.0)",
      "rgba(230, 230, 40, 1.0)",
      "rgba(255, 210, 40, 1.0)",
      "rgba(255, 180, 30, 1.0)",
      "rgba(255, 150, 20, 1.0)",
      "rgba(255, 120, 10, 1.0)",
      "rgba(255, 90, 0, 1.0)",
      "rgba(255, 60, 0, 1.0)",
      "rgba(255, 30, 0, 1.0)",
      "rgba(255, 0, 0, 1.0)",
      "rgba(240, 0, 0, 1.0)",
      "rgba(230, 0, 0, 1.0)",
      "rgba(0, 255, 255, 1.0)",
    ],
    [
      "25",
      "75",
      "125",
      "250",
      "500",
      "750",
      "1000",
      "1250",
      "1500",
      "1750",
      "2000",
      "2250",
      "2500",
      "2750",
      "3000",
      "3250",
      "3500",
      "4000",
      "4500",
      "5000",
    ]
  ),
  meteorological_risks_forecast: gradientLegendBar(
    [
      "rgba(248, 246, 0, 1.0)",
      "rgba(255, 173, 0, 1.0)",
      "rgba(255, 26, 0, 1.0)",
      "rgba(145, 201, 255, 1.0)",
      "rgba(157, 121, 210, 1.0)",
      "rgba(148, 0, 166, 1.0)",
    ],
    [
      "Mod Wind",
      "High Wind",
      "Severe Wind",
      "Mod Precip",
      "High Precip",
      "Severe Precip",
    ]
  ),
  official_weather_warnings_forecast: gradientLegendBar(
    [
      "rgba(255, 0, 0, 0.6)",
      "rgba(255, 125, 0, 0.6)",
      "rgba(252, 231, 0, 0.6)",
      "rgba(215, 255, 0, 0.6)",
      "rgba(112, 112, 112, 0.6)",
    ],
    ["Extreme", "Severe", "Moderate", "Minor", "Unknown"]
  ),
  storm_helicity_forecast_0_3km: gradientLegendBar(
    [
      "rgba(170, 255, 102, 1.0)",
      "rgba(214, 255, 0, 1.0)",
      "rgba(255, 230, 0, 1.0)",
      "rgba(255, 173, 0, 1.0)",
      "rgba(255, 120, 0, 1.0)",
      "rgba(255, 96, 160, 1.0)",
      "rgba(255, 64, 208, 1.0)",
      "rgba(255, 128, 224, 1.0)",
    ],
    ["150", "200", "250", "300", "400", "600", "800", "1000"]
  ),
  snow_density_weekly_forecast: gradientLegendBar(
    [
      "#00088F",
      "#0013DF",
      "#011FFF",
      "#007FFF",
      "#01DFFF",
      "#00FFFF",
      "#5FFF9F",
      "#BFFE3E",
      "#FFFE03",
      "#FF7F00",
      "#7F0000",
    ],
    ["0", "50", "100", "150", "200", "250", "300", "350", "400", "450", "500"]
  ),
  snow_depth_weekly_forecast: gradientLegendBar(
    [
      "#00088F",
      "#0013DF",
      "#011FFF",
      "#007FFF",
      "#01DFFF",
      "#00FFFF",
      "#5FFF9F",
      "#BFFE3E",
      "#FFFE03",
      "#FF7F00",
      "#4e0000",
    ],
    ["0", "0.1", "0.2", "0.3", "0.5", "0.7", "1.0", "1.5", "2.0", "3.0", "5.0"]
  ),
  snowfall_hourly_forecast: gradientLegendBar(
    [
      "#FFFFFF",
      "#2149FF",
      "#0054FE",
      "#10BBEC",
      "#68FF95",
      "#CEFE2D",
      "#FCD100",
      "#FF9F4E",
      "#FF5F7A",
      "#CD1547",
      "#7B0029",
    ],
    ["0%", "10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%"]
  ),
  thunderstorm_probability_3hourly_forecast: gradientLegendBar(
    [
      "#FFFFFF",
      "#7BC8FF",
      "#011CFF",
      "#0094FE",
      "#2FFFCE",
      "#92FF6D",
      "#FAFE04",
      "#FFA000",
      "#FF3365",
      "#AA0032",
    ],
    ["0%", "10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%"]
  ),
  liquid_fog_probability_3hourly_forecast: gradientLegendBar(
    [
      "#FFFFFF",
      "#F3EDFF",
      "#E6DBFF",
      "#D6C5FF",
      "#C7AFFF",
      "#B899FF",
      "#A983FF",
      "#9A6DFF",
      "#8B57FF",
      "#8B4DFF",
    ],
    [">10km", "5-10km", "2-5km", "1-2km", "0.5-1km", "0.2-0.5km", "0.1-0.2km", "50-100m", "20-50m", "<20m"]
  ),
  convective_precipitation_weekly_forecast: gradientLegendBar(
    [
      "#FFFFFF",
      "#B8D5FF",
      "#A1C7FF",
      "#7AACFF",
      "#3DA0F3",
      "#1FCADF",
      "#27E4D5",
      "#62FF9B",
      "#CCFE32",
      "#FF9600",
      "#290000",
    ],
    ["0", "5", "10", "15", "20", "30", "40", "50", "75", "100", "150"]
  ),
  cams_air_quality_index_hourly: gradientLegendBar(
    [
      "#00E400", // Good
      "#FFFF00", // Moderate
      "#FF7E00", // Unhealthy for Sensitive
      "#FF0000", // Unhealthy
      "#8F3F97", // Very Unhealthy
    ],
    ["-10 (Good)", "25 (Moderate)", "50 (Unhealthy SG)", "75 (Unhealthy)", "100 (Very Unhealthy)"]
  ),
  cams_air_quality_index_daily: gradientLegendBar(
    [
      "#00E400", // Good
      "#FFFF00", // Moderate
      "#FF7E00", // Unhealthy for Sensitive
      "#FF0000", // Unhealthy
      "#8F3F97", // Very Unhealthy
    ],
    ["-10 (Good)", "25 (Moderate)", "50 (Unhealthy SG)", "75 (Unhealthy)", "100 (Very Unhealthy)"]
  ),
  cams_desert_dust_hourly: gradientLegendBar(
    [
      "#B2A346", // Light brown
      "#D9C000", // Yellow-brown
      "#D4A12B", // Orange-brown
      "#D08D37", // Darker orange-brown
      "#E78835", // Orange
      "#FF535A", // Red-orange
      "#A8005A", // Dark red-purple
      "#99094A", // Purple-red
      "#790038", // Dark purple
      "#5A0328", // Very dark purple
      "#2E0000", // Almost black
    ],
    ["30", "50", "100", "150", "200", "250", "300", "400", "600", "800", "1500"]
  ),
  cams_desert_dust_daily: gradientLegendBar(
    [
      "#B2A346", // Light brown
      "#D9C000", // Yellow-brown
      "#D4A12B", // Orange-brown
      "#D08D37", // Darker orange-brown
      "#E78835", // Orange
      "#FF535A", // Red-orange
      "#A8005A", // Dark red-purple
      "#99094A", // Purple-red
      "#790038", // Dark purple
      "#5A0328", // Very dark purple
      "#2E0000", // Almost black
    ],
    ["30", "50", "100", "150", "200", "250", "300", "400", "600", "800", "1500"]
  ),
  cams_aerosol_optical_depth_hourly: gradientLegendBar(
    [
      "#5A5A5A", // Dark gray
      "#5D5773", // Purple-gray
      "#5F5783", // Light purple
      "#48658F", // Blue
      "#057C8D", // Teal
      "#008F80", // Cyan-green
      "#00976F", // Green-cyan
      "#4A9E5A", // Green
      "#70A148", // Yellow-green
      "#96A047", // Lime
      "#A59E4D", // Yellow-brown
      "#BF9B5C", // Orange-tan
      "#D99971", // Light orange
      "#EE9791", // Salmon
      "#FF96AF", // Pink
      "#FF9BC3", // Light pink
      "#F0BACF", // Pale pink
      "#E9C6D4", // Very pale pink
      "#E2D3D9", // Light gray-pink
      "#DCDCDC", // Light gray
    ],
    ["-10", "0.05", "0.1", "0.15", "0.2", "0.25", "0.3", "0.35", "0.4", "0.45", "0.5", "0.6", "0.7", "0.8", "0.9", "1.0", "1.5", "2.0", "3.0", "5.0"]
  ),
  cams_aerosol_optical_depth_daily: gradientLegendBar(
    [
      "#5A5A5A", // Dark gray
      "#5D5773", // Purple-gray
      "#5F5783", // Light purple
      "#48658F", // Blue
      "#057C8D", // Teal
      "#008F80", // Cyan-green
      "#00976F", // Green-cyan
      "#4A9E5A", // Green
      "#70A148", // Yellow-green
      "#96A047", // Lime
      "#A59E4D", // Yellow-brown
      "#BF9B5C", // Orange-tan
      "#D99971", // Light orange
      "#EE9791", // Salmon
      "#FF96AF", // Pink
      "#FF9BC3", // Light pink
      "#F0BACF", // Pale pink
      "#E9C6D4", // Very pale pink
      "#E2D3D9", // Light gray-pink
      "#DCDCDC", // Light gray
    ],
    ["-10", "0.05", "0.1", "0.15", "0.2", "0.25", "0.3", "0.35", "0.4", "0.45", "0.5", "0.6", "0.7", "0.8", "0.9", "1.0", "1.5", "2.0", "3.0", "5.0"]
  ),
  cams_nitrogen_dioxide_daily: gradientLegendBar(
    [
      "#3E8EB5", // Blue
      "#7DB6D1", // Light blue
      "#AAB7BD", // Gray-blue
      "#C2C37D", // Yellow-green
      "#C7B571", // Yellow-brown
      "#CCA764", // Orange-brown
      "#D09958", // Orange
      "#D58B4B", // Dark orange
      "#DA7D3F", // Red-orange
      "#DF6F32", // Red
      "#E36126", // Dark red
      "#E85319", // Very dark red
      "#BD3413", // Brown-red
      "#89200A", // Dark brown
      "#4B0C00", // Very dark brown
      "#44281C", // Brown-gray
      "#3D3939", // Dark gray
      "#5C4857", // Purple-gray
      "#7B5776", // Purple
      "#8A5E85", // Light purple
      "#996594", // Pink-purple
      "#B874B2", // Pink
    ],
    ["-0.1", "1", "2", "3", "4", "5", "7", "10", "15", "20", "25", "30", "40", "60", "100", "150", "200", "250", "300", "350", "400", "500"]
  ),
  cams_carbon_monoxide_daily: gradientLegendBar(
    [
      "#3E8EB5", // Blue
      "#7DB6D1", // Light blue
      "#AAB7BD", // Gray-blue
      "#C2C37D", // Yellow-green
      "#C7B571", // Yellow-brown
      "#CCA764", // Orange-brown
      "#D09958", // Orange
      "#D58B4B", // Dark orange
      "#DA7D3F", // Red-orange
      "#DF6F32", // Red
      "#E36126", // Dark red
      "#E85319", // Very dark red
      "#BD3413", // Brown-red
      "#89200A", // Dark brown
      "#4B0C00", // Very dark brown
      "#44281C", // Brown-gray
      "#3D3939", // Dark gray
      "#5C4857", // Purple-gray
      "#7B5776", // Purple
      "#8A5E85", // Light purple
      "#996594", // Pink-purple
      "#B874B2", // Pink
    ],
    ["0", "35", "70", "90", "110", "130", "150", "170", "200", "230", "260", "300", "350", "400", "450", "600", "800", "1000", "1200", "1400", "1800", "2200"]
  ),
  cams_sulphur_dioxide_daily: gradientLegendBar(
    [
      "#3E8EB5", // Blue
      "#7DB6D1", // Light blue
      "#AAB7BD", // Gray-blue
      "#C2C37D", // Yellow-green
      "#C7B571", // Yellow-brown
      "#CCA764", // Orange-brown
      "#D09958", // Orange
      "#D58B4B", // Dark orange
      "#DA7D3F", // Red-orange
      "#DF6F32", // Red
      "#E36126", // Dark red
      "#E85319", // Very dark red
      "#BD3413", // Brown-red
      "#89200A", // Dark brown
      "#4B0C00", // Very dark brown
      "#44281C", // Brown-gray
      "#3D3939", // Dark gray
      "#5C4857", // Purple-gray
      "#7B5776", // Purple
      "#8A5E85", // Light purple
      "#996594", // Pink-purple
      "#B874B2", // Pink
    ],
    ["-0.1", "1", "2", "3", "4", "5", "7", "10", "15", "20", "25", "30", "40", "60", "100", "150", "200", "250", "300", "350", "400", "500"]
  ),
};
