// layer-attribute-popup.js
// Generic attribute popup bound to the clicked lng/lat (NOT screen pixels)
// - Reads popup: true groups from map-layers.js (vector/geojson only; skips raster)
// - ALSO supports dynamic DEW exposure polygons added at runtime via window.exposureLayersMap
// - Does NOT inject "information" from config, but WILL display "information" if present in feature properties
// - SPECIAL HANDLING: waqi_stations layer with interactive charts and infographs
// - SPECIAL HANDLING: ffd_data layer with interactive flood data charts
// - FIXED: Map style loading race condition and instant popup display

import { ncop_menu_items } from "./map-layers.js";
import Chart from "chart.js/auto";

function prettyAttributeName(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

const HIDDEN_KEYS = new Set();

// ========== PERFORMANCE OPTIMIZATION CONSTANTS ==========
let LAST_QUERY_TIME = 0;
let LAST_QUERY_POINT = null;
let LAST_QUERY_RESULT = null;

// Simple global caps to avoid unbounded memory use
const MAX_WAQI_POPUPS = 80;
const MAX_FFD_CHARTS = 80;

// ========== WAQI-SPECIFIC CONSTANTS & HELPERS ==========
const WAQI_PUBLIC_TOKEN = waqiT;
const stationPayloads = {};
const chartInstances = {};

function pruneCacheMap(cacheObj, maxSize, destroyCb) {
  const keys = Object.keys(cacheObj);
  if (keys.length <= maxSize) return;
  const excess = keys.length - maxSize;
  for (let i = 0; i < excess; i++) {
    const k = keys[i];
    if (destroyCb && cacheObj[k]) {
      try {
        destroyCb(cacheObj[k]);
      } catch (_) { }
    }
    delete cacheObj[k];
  }
}

// Helper function to determine AQI status
function getAQIStatus(aqi) {
  const value = parseInt(aqi);
  if (isNaN(value)) return "Unknown";
  if (value <= 50) return "Good";
  if (value <= 100) return "Moderate";
  if (value <= 150) return "Unhealthy for Sensitive";
  if (value <= 200) return "Unhealthy";
  if (value <= 300) return "Very Unhealthy";
  return "Hazardous";
}

// Helper to get AQI status color
function getAQIStatusColor(aqi) {
  const value = parseInt(aqi);
  if (isNaN(value)) return "var(--text-secondary, rgba(255, 255, 255, 0.75))";
  if (value <= 50) return "var(--ndma-green, #2ecc71)";
  if (value <= 100) return "var(--ndma-blue, #46b2ff)";
  if (value <= 150) return "#ff9800";
  if (value <= 200) return "#ff5722";
  if (value <= 300) return "var(--ndma-red, #ff0000)";
  return "#8b0000";
}

async function fetchStationDetail(uid) {
  try {
    const airnetUrl = `https://airnet.waqi.info/airnet/feed/hourly/${uid}`;
    const airResp = await fetch(airnetUrl);
    if (airResp.ok) {
      const airJson = await airResp.json();
      if (airJson.status === "ok") {
        return {
          mode: "airnet",
          stationName:
            airJson.meta?.name ||
            airJson.loiq?.display_name ||
            `Station ${uid}`,
          updatedTime:
            airJson.data?.pm25?.slice(-1)?.[0]?.time ||
            airJson.data?.pm10?.slice(-1)?.[0]?.time ||
            airJson.data?.co2?.slice(-1)?.[0]?.time ||
            airJson.data?.tvoc?.slice(-1)?.[0]?.time ||
            airJson.data?.["met.t"]?.slice(-1)?.[0]?.time ||
            airJson.data?.["met.h"]?.slice(-1)?.[0]?.time ||
            "",
          attributions: [],
          data: airJson.data || {},
        };
      }
    }
  } catch (err) {
    console.warn("AirNet fetch failed for WAQI station:", uid, err);
  }

  const feedUrl = `https://api.waqi.info/feed/@${uid}/?token=${WAQI_PUBLIC_TOKEN}`;
  const feedResp = await fetch(feedUrl);
  if (!feedResp.ok) throw new Error("WAQI feed network fail");
  const feedJson = await feedResp.json();
  if (feedJson.status !== "ok") throw new Error("WAQI feed not ok");

  const d = feedJson.data;
  const nowTs = d?.time?.s || new Date().toISOString();

  function onePoint(val) {
    return [{ time: nowTs, mean: val ?? null }];
  }

  const iaqi = d?.iaqi || {};
  const pm25v = iaqi.pm25?.v;
  const pm10v = iaqi.pm10?.v;
  const co2v = iaqi.co?.v ?? null;
  const tvocv = null;
  const tempv = iaqi.t?.v ?? iaqi.temp?.v ?? null;
  const rhv = iaqi.h?.v ?? iaqi.hum?.v ?? null;

  return {
    mode: "feed",
    stationName: d?.city?.name || `Station ${uid}`,
    updatedTime: d?.time?.s || nowTs,
    attributions: d?.attributions || [],
    data: {
      pm25: onePoint(pm25v),
      pm10: onePoint(pm10v),
      co2: onePoint(co2v),
      tvoc: onePoint(tvocv),
      "met.t": onePoint(tempv),
      "met.h": onePoint(rhv),
    },
  };
}

function extractMetricTimeseries(payloadData, metricKey) {
  const arr = payloadData?.[metricKey];
  if (!Array.isArray(arr)) return { labels: [], values: [] };

  const sorted = arr
    .slice()
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  const labels = [];
  const values = [];
  for (const row of sorted) {
    if (!row) continue;
    if (row.time === undefined) continue;
    if (row.mean === undefined || row.mean === null) continue;

    const d = new Date(row.time);
    const lbl = d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    labels.push(lbl);
    values.push(row.mean);
  }

  return { labels, values };
}

function renderInlineChartForPopup(popupId, metricKey, niceLabel) {
  const payload = stationPayloads[popupId];
  if (!payload) return;

  const { labels, values } = extractMetricTimeseries(payload.data, metricKey);

  const canvas = document.getElementById(`aqiInlineChart-${popupId}`);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // prune cache if needed before we add/update
  pruneCacheMap(chartInstances, MAX_WAQI_POPUPS, (chart) => {
    if (chart && typeof chart.destroy === "function") chart.destroy();
  });

  if (chartInstances[popupId]) {
    const chart = chartInstances[popupId];
    chart.data.labels = labels;
    chart.data.datasets[0].label = niceLabel;
    chart.data.datasets[0].data = values;
    chart.update();
  } else {
    chartInstances[popupId] = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: niceLabel,
            data: values,
            fill: false,
            borderWidth: 2,
            pointRadius: 2,
            tension: 0.2,
          },
        ],
      },
      options: {
        responsive: false,
        scales: {
          x: {
            ticks: {
              color: "#ccc",
              maxRotation: 45,
              minRotation: 45,
              font: { size: 9 },
            },
            grid: { color: "rgba(255,255,255,0.07)" },
          },
          y: {
            ticks: {
              color: "#ccc",
              font: { size: 9 },
            },
            grid: { color: "rgba(255,255,255,0.1)" },
          },
        },
        plugins: {
          legend: {
            labels: {
              color: "#fff",
              font: { size: 10, weight: "bold" },
            },
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                const v = context.parsed.y;
                const t = context.label;
                return `${v} @ ${t}`;
              },
            },
          },
        },
      },
    });
  }
}

function populateInlineHeaderForPopup(popupId, uid) {
  const payload = stationPayloads[popupId];
  if (!payload) return;

  const nameEl = document.getElementById(`aqi-inline-station-name-${popupId}`);
  const timeEl = document.getElementById(`aqi-inline-updated-time-${popupId}`);
  const attribEl = document.getElementById(`aqi-inline-attrib-${popupId}`);

  if (nameEl) {
    nameEl.textContent = `${payload.stationName} (ID ${uid})`;
  }

  if (timeEl) {
    const d = new Date(payload.updatedTime);
    timeEl.textContent =
      "Updated " +
      d.toLocaleString("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  }

  if (attribEl) {
    if (Array.isArray(payload.attributions) && payload.attributions.length) {
      const parts = payload.attributions.map((a) => {
        if (a.url) return `${a.name} (${a.url})`;
        return a.name;
      });
      attribEl.textContent = "Attribution: " + parts.join(" | ");
    } else {
      attribEl.textContent = "";
    }
  }
}

function setupWaqiPopupEventHandlers() {
  document.removeEventListener("click", handleWaqiPopupClick);
  document.addEventListener("click", handleWaqiPopupClick);
}

// Updated handleWaqiPopupClick function for layer-attribute-popup.js
// Replace the existing handleWaqiPopupClick function with this version

function handleWaqiPopupClick(e) {
  const toggleBtn = e.target.closest(".aqi-infograph-inline-btn");
  if (toggleBtn) {
    const uid = toggleBtn.getAttribute("data-waqi-uid");
    const popupId = toggleBtn.getAttribute("data-popup-id");
    if (!uid || !popupId) return;

    const expanded = toggleBtn.getAttribute("data-expanded") === "true";
    const alreadyLoaded = toggleBtn.getAttribute("data-loaded") === "true";

    const metricsRow = document.getElementById(`aqi-inline-metrics-${popupId}`);
    const chartWrap = document.getElementById(`aqi-inline-chart-wrapper-${popupId}`);

    // Get the button text span (first span child)
    const buttonTextSpan = toggleBtn.querySelector("span:first-child");
    const buttonIconSpan = toggleBtn.querySelector("span:last-child");

    if (!expanded) {
      if (!alreadyLoaded) {
        try {
          fetchStationDetail(uid).then((payload) => {
            // prune payload cache if needed
            pruneCacheMap(stationPayloads, MAX_WAQI_POPUPS);
            stationPayloads[popupId] = payload;
            populateInlineHeaderForPopup(popupId, uid);
            renderInlineChartForPopup(popupId, "pm25", "PM2.5 (µg/m³)");
            toggleBtn.setAttribute("data-loaded", "true");
          });
        } catch (err) {
          console.error("Failed station fetch:", err);
          alert("Could not load station infograph.");
          return;
        }
      }

      // Show sections
      if (metricsRow) metricsRow.style.display = "block";
      if (chartWrap) chartWrap.style.display = "block";

      // Update button appearance for expanded state
      if (buttonTextSpan) buttonTextSpan.textContent = "Hide Station Infograph";
      if (buttonIconSpan) buttonIconSpan.style.transform = "rotate(180deg)";
      toggleBtn.style.background = "var(--ndma-green-opaque, rgba(9, 106, 11, 0.75))";
      toggleBtn.style.borderColor = "var(--border-green, rgba(9, 106, 11, 0.35))";
      toggleBtn.setAttribute("data-expanded", "true");
    } else {
      // Hide sections
      if (metricsRow) metricsRow.style.display = "none";
      if (chartWrap) chartWrap.style.display = "none";

      // Update button appearance for collapsed state
      if (buttonTextSpan) buttonTextSpan.textContent = "Show Station Infograph";
      if (buttonIconSpan) buttonIconSpan.style.transform = "rotate(0deg)";
      toggleBtn.style.background = "var(--btn-blue-bg, rgba(70, 178, 255, 0.75))";
      toggleBtn.style.borderColor = "var(--border-blue, rgba(70, 178, 255, 0.35))";
      toggleBtn.setAttribute("data-expanded", "false");
    }
  }

  const metricBtn = e.target.closest(".aqi-inline-metric-btn");
  if (metricBtn) {
    const metricKey = metricBtn.getAttribute("data-metric");
    const popupId = metricBtn.getAttribute("data-popup-id");
    if (!popupId) return;

    // Remove active state from all metric buttons in this popup
    const allMetricBtns = document.querySelectorAll(
      `.aqi-inline-metric-btn[data-popup-id="${popupId}"]`
    );
    allMetricBtns.forEach((btn) => {
      btn.style.background = "var(--glass-lighter, rgba(255, 255, 255, 0.15))";
      btn.style.borderColor = "var(--border-dark, rgba(255, 255, 255, 0.2))";
      btn.style.color = "var(--text-primary, rgba(255, 255, 255, 0.95))";
      btn.style.boxShadow = "none";
    });

    // Set active state on clicked button
    metricBtn.style.background = "var(--ndma-blue-opaque, rgba(70, 178, 255, 0.75))";
    metricBtn.style.borderColor = "var(--ndma-blue, #46b2ff)";
    metricBtn.style.color = "var(--white, #ffffff)";
    metricBtn.style.boxShadow = "var(--shadow-glow-blue, 0 0 12px 2px rgba(70, 178, 255, 0.25))";

    let label;
    switch (metricKey) {
      case "pm25":
        label = "PM2.5 (µg/m³)";
        break;
      case "pm10":
        label = "PM10 (µg/m³)";
        break;
      case "co2":
        label = "CO₂ (ppm)";
        break;
      case "tvoc":
        label = "TVOC (ppb)";
        break;
      case "met.t":
        label = "Temp (°C)";
        break;
      case "met.h":
        label = "RH (%)";
        break;
      default:
        label = metricKey;
    }

    renderInlineChartForPopup(popupId, metricKey, label);
  }
}
function buildWaqiPopupContent(props) {
  const popupUID = `waqi-${props.uid}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  let stationDetailsHtml = "";

  if (props.uid !== undefined && props.uid !== null && props.uid >= 0) {
    stationDetailsHtml = `<a href="https://aqicn.org/station/@${props.uid}/" target="_blank" style="font-size:9px;color:var(--ndma-blue,#46b2ff);text-decoration:underline;display:inline-block;margin-bottom:8px;transition:opacity 0.2s;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">View Station Details →</a>`;
  }

  const time_prop = new Date(props.time);
  const time_str = time_prop.toLocaleString();

  return `
  <div style="
    width: 240px;
    max-height: 300px;
    overflow-y: auto;
    box-sizing: border-box;
    background: var(--primary-bg, rgba(0, 0, 0, 0.6));
    backdrop-filter: blur(10px);
    border: 1.5px solid var(--border-light, rgba(255, 255, 255, 0.7));
    border-radius: 8px;
    padding: 8px;
    font-family: 'Inter', sans-serif;
    color: var(--text-primary, rgba(255, 255, 255, 0.95));
  ">

    <!-- HEADER SECTION -->
    <div style="
      display: flex;
      align-items: center;
      justify-content: space-between;
    ">
      <span style="
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary, rgba(255, 255, 255, 0.95));
        letter-spacing: 0.2px;
      ">Air Quality Index</span>
      <span style="
        font-size: 14px;
        font-weight: 700;
        color: var(--ndma-blue, #46b2ff);
        padding: 1px 8px;
        background: var(--frost-bg, rgba(255, 255, 255, 0.12));
        border-radius: 4px;
        border: 1px solid var(--border-blue, rgba(70, 178, 255, 0.35));
      ">${props.aqi}</span>
    </div>

    <!-- INFORMATION TABLE -->
    <table style="
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      margin-top: 8px;
      margin-bottom: 8px;
      border: 2px solid var(--border-dark, rgba(255, 255, 255, 0.5));
      border-radius: 5px;
      overflow: hidden;
      background: var(--glass-medium, rgba(0, 0, 0, 0.4));
    ">
      <tbody>
        <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
          <td style="
            width: 40%;
            padding: 6px 8px;
            font-size: 9px;
            vertical-align: middle;
            font-weight: 700;
            color: var(--text-secondary, rgba(255, 255, 255, 0.75));
            background: var(--glass-dark, rgba(0, 0, 0, 0.6));
            border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
          ">Status</td>
          <td style="
            width: 60%;
            padding: 6px 8px;
            font-size: 9px;
            vertical-align: middle;
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            background: var(--frost-bg, rgba(255, 255, 255, 0.12));
            border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
          ">
            <span style="color: ${getAQIStatusColor(props.aqi)}; font-weight: 700;">${getAQIStatus(props.aqi)}</span>
          </td>
        </tr>
        <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
          <td style="
            padding: 6px 8px;
            font-size: 9px;
            vertical-align: middle;
            font-weight: 700;
            color: var(--text-secondary, rgba(255, 255, 255, 0.75));
            background: var(--glass-dark, rgba(0, 0, 0, 0.6));
            border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
          ">Region</td>
          <td style="
            padding: 6px 8px;
            font-size: 9px;
            vertical-align: middle;
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            background: var(--frost-bg, rgba(255, 255, 255, 0.12));
            border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
          ">${props.name || "N/A"}</td>
        </tr>
        <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
          <td style="
            padding: 6px 8px;
            font-size: 9px;
            vertical-align: middle;
            font-weight: 700;
            color: var(--text-secondary, rgba(255, 255, 255, 0.75));
            background: var(--glass-dark, rgba(0, 0, 0, 0.6));
            border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
          ">Time</td>
          <td style="
            padding: 6px 8px;
            font-size: 9px;
            vertical-align: middle;
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            background: var(--frost-bg, rgba(255, 255, 255, 0.12));
            border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
          ">${time_str || "N/A"}</td>
        </tr>
      </tbody>
    </table>

    <!-- STATION DETAILS (if available) -->
    <div style="width: 100%; box-sizing: border-box; margin-bottom: 12px;">
      ${stationDetailsHtml}
    </div>

    <!-- SHOW INFOGRAPH BUTTON -->
    <button 
      class="aqi-infograph-inline-btn"
      data-waqi-uid="${props.uid}"
      data-popup-id="${popupUID}"
      data-expanded="false"
      data-loaded="false"
      style="
        width: 100%;
        box-sizing: border-box;
        background: var(--btn-blue-bg, rgba(70, 178, 255, 0.75));
        color: var(--text-primary, rgba(255, 255, 255, 0.95));
        border: 2px solid var(--border-blue, rgba(70, 178, 255, 0.35));
        border-radius: 45px;
        padding: 4px 8px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        text-align: center;
        transition: all 0.3s ease;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 15px;
      "
      onmouseover="this.style.background='var(--btn-blue-hover, linear-gradient(to right, rgba(70, 178, 255, 0.9), rgba(30, 144, 255, 0.6)))'; this.style.transform='translateY(-2px)'; this.style.boxShadow='var(--shadow-glow-blue, 0 0 12px 2px rgba(70, 178, 255, 0.25))';"
      onmouseout="this.style.background='var(--btn-blue-bg, rgba(70, 178, 255, 0.75))'; this.style.transform='translateY(0)'; this.style.boxShadow='none';"
      onmousedown="this.style.transform='translateY(0)';"
      onmouseup="this.style.transform='translateY(-2px)';"
    >
      <span>Show Station Infograph</span>
      <span style="transition: transform 0.3s ease;">▼</span>
    </button>

    <!-- METRICS SECTION (expandable) -->
    <div 
      id="aqi-inline-metrics-${popupUID}" 
      style="
        display: none;
        width: 100%;
        box-sizing: border-box;
        margin-bottom: 12px;
        overflow: hidden;
        transition: all 0.3s ease;
      "
    >
      <div style="
        width: 100%;
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        box-sizing: border-box;
      ">
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="pm25" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >PM2.5</button>
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="pm10" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >PM10</button>
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="o3" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >O₃</button>
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="no2" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >NO₂</button>
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="co" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >CO</button>
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="so2" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >SO₂</button>
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="met.t" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >Temp</button>
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="met.h" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >Humidity</button>
        <button 
          class="aqi-inline-metric-btn" 
          data-metric="met.p" 
          data-popup-id="${popupUID}"
          style="
            width: 100%;
            box-sizing: border-box;
            background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            border: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            border-radius: 25px;
            padding: 4px 8px;
            font-size: 10px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
          "
          onmouseover="this.style.background='var(--glass-highlight, rgba(255, 255, 255, 0.25))'; this.style.borderColor='var(--border-blue, rgba(70, 178, 255, 0.35))'; this.style.color='var(--ndma-blue, #46b2ff)'; this.style.transform='translateY(-1px)';"
          onmouseout="this.style.background='var(--glass-lighter, rgba(255, 255, 255, 0.15))'; this.style.borderColor='var(--border-dark, rgba(255, 255, 255, 0.2))'; this.style.color='var(--text-primary, rgba(255, 255, 255, 0.95))'; this.style.transform='translateY(0)';"
        >Pressure</button>
      </div>
    </div>

    <!-- CHART WRAPPER (expandable) -->
    <div 
      id="aqi-inline-chart-wrapper-${popupUID}" 
      style="
        display: none;
        width: 100%;
        box-sizing: border-box;
        background: var(--glass-lighter, rgba(255, 255, 255, 0.15));
        border: 2px solid var(--border-dark, rgba(255, 255, 255, 0.2));
        border-radius: 10px;
        padding: 14px;
        backdrop-filter: blur(10px);
        overflow: hidden;
        transition: all 0.3s ease;
      "
    >
      <div style="margin-bottom: 10px;">
        <div 
          id="aqi-inline-station-name-${popupUID}" 
          style="
            width: 100%;
            box-sizing: border-box;
            font-size: 13px;
            font-weight: 700;
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            margin-bottom: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          "
        ></div>
        <div 
          id="aqi-inline-updated-time-${popupUID}" 
          style="
            width: 100%;
            box-sizing: border-box;
            font-size: 10px;
            color: var(--text-muted, rgba(255, 255, 255, 0.55));
          "
        ></div>
      </div>

      <canvas 
        id="aqiInlineChart-${popupUID}" 
        style="
          width: 100% !important;
          height: 180px !important;
          display: block;
          border-radius: 6px;
        "
      ></canvas>

      <div 
        id="aqi-inline-attrib-${popupUID}" 
        style="
          width: 100%;
          box-sizing: border-box;
          font-size: 9px;
          margin-top: 10px;
          color: var(--text-muted, rgba(255, 255, 255, 0.55));
          text-align: justify;
        "
      ></div>
    </div>

  </div>
`;
}

// ========== END WAQI-SPECIFIC CODE ==========
// ========== SLICK PLUS-SPECIFIC HELPERS ==========
function buildSlickPlusPopupContent(props) {
  const popupId = `slick-plus-${props.id || Math.random().toString(36).substr(2, 9)}`;

  // Parse timestamp
  const slickTime = props.slick_timestamp ? new Date(props.slick_timestamp).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }) : 'N/A';

  // Format numbers with 2 decimal places
  const formatNumber = (val) => {
    if (val === null || val === undefined) return 'N/A';
    const num = parseFloat(val);
    return isNaN(num) ? 'N/A' : num.toFixed(2);
  };

  const machineConfidence = formatNumber(props.machine_confidence ? props.machine_confidence * 100 : null);
  const length = formatNumber(props.length);
  const area = formatNumber(props.area);
  const perimeter = formatNumber(props.perimeter);

  return `
    <div style="
      width: 280px;
      max-height: 400px;
      overflow-y: auto;
      box-sizing: border-box;
      background: var(--primary-bg, rgba(0, 0, 0, 0.6));
      backdrop-filter: blur(10px);
      border: 1.5px solid var(--border-light, rgba(255, 255, 255, 0.7));
      border-radius: 8px;
      padding: 12px;
      font-family: 'Inter', sans-serif;
      color: var(--text-primary, rgba(255, 255, 255, 0.95));
    ">

      <!-- HEADER SECTION -->
      <div style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
      ">
        <span style="
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary, rgba(255, 255, 255, 0.95));
          letter-spacing: 0.2px;
        ">Oil Slick Detection</span>
        <span style="
          font-size: 11px;
          font-weight: 700;
          color: var(--ndma-blue, #46b2ff);
          padding: 2px 8px;
          background: var(--frost-bg, rgba(255, 255, 255, 0.12));
          border-radius: 4px;
          border: 1px solid var(--border-blue, rgba(70, 178, 255, 0.35));
        ">ID: ${props.id || 'N/A'}</span>
      </div>

      <!-- INFORMATION TABLE -->
      <table style="
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        margin-bottom: 10px;
        border: 2px solid var(--border-dark, rgba(255, 255, 255, 0.5));
        border-radius: 5px;
        overflow: hidden;
        background: var(--glass-medium, rgba(0, 0, 0, 0.4));
      ">
        <tbody>
          <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
            <td style="
              width: 45%;
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              font-weight: 700;
              color: var(--text-secondary, rgba(255, 255, 255, 0.75));
              background: var(--glass-dark, rgba(0, 0, 0, 0.6));
              border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">Timestamp</td>
            <td style="
              width: 55%;
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              color: var(--text-primary, rgba(255, 255, 255, 0.95));
              background: var(--frost-bg, rgba(255, 255, 255, 0.12));
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">${slickTime}</td>
          </tr>
          <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
            <td style="
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              font-weight: 700;
              color: var(--text-secondary, rgba(255, 255, 255, 0.75));
              background: var(--glass-dark, rgba(0, 0, 0, 0.6));
              border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">Confidence</td>
            <td style="
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              color: var(--text-primary, rgba(255, 255, 255, 0.95));
              background: var(--frost-bg, rgba(255, 255, 255, 0.12));
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">${machineConfidence}%</td>
          </tr>
          <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
            <td style="
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              font-weight: 700;
              color: var(--text-secondary, rgba(255, 255, 255, 0.75));
              background: var(--glass-dark, rgba(0, 0, 0, 0.6));
              border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">Length (m)</td>
            <td style="
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              color: var(--text-primary, rgba(255, 255, 255, 0.95));
              background: var(--frost-bg, rgba(255, 255, 255, 0.12));
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">${length}</td>
          </tr>
          <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
            <td style="
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              font-weight: 700;
              color: var(--text-secondary, rgba(255, 255, 255, 0.75));
              background: var(--glass-dark, rgba(0, 0, 0, 0.6));
              border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">Area (m²)</td>
            <td style="
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              color: var(--text-primary, rgba(255, 255, 255, 0.95));
              background: var(--frost-bg, rgba(255, 255, 255, 0.12));
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">${area}</td>
          </tr>
          <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
            <td style="
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              font-weight: 700;
              color: var(--text-secondary, rgba(255, 255, 255, 0.75));
              background: var(--glass-dark, rgba(0, 0, 0, 0.6));
              border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">Perimeter (m)</td>
            <td style="
              padding: 6px 8px;
              font-size: 10px;
              vertical-align: middle;
              color: var(--text-primary, rgba(255, 255, 255, 0.95));
              background: var(--frost-bg, rgba(255, 255, 255, 0.12));
            ">${perimeter}</td>
          </tr>
        </tbody>
      </table>

      <!-- VIEW DETAILS LINK -->
      ${props.slick_url ? `
      <a href="${props.slick_url}" target="_blank" style="
        font-size: 10px;
        color: var(--ndma-blue, #46b2ff);
        text-decoration: underline;
        display: inline-block;
        margin-top: 4px;
        transition: opacity 0.2s;
      " onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">
        View Full Details →
      </a>
      ` : ''}

    </div>
  `;
}
// ========== END SLICK PLUS-SPECIFIC CODE ==========
// ========== FFD-SPECIFIC CONSTANTS & HELPERS ==========
const ffdChartInstances = {};

function buildFfdPopupContent(props) {
  const popupId = `ffd-${props.name}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  const inflow = props.inflow_discharge !== "n/a" ? props.inflow_discharge : 0;

  return `
    <div style="
      overflow-y:auto;
      width:100%;
      max-width:260px;
      background:#ffffff;
      border:1px solid #1e88e5;
      border-radius:8px;
      padding:8px;
      box-sizing:border-box;
      font-size:11px;
      line-height:1.25;
    ">

      <!-- HEADER (blue title like image 2) -->
      <div style="
        width:100%;
        box-sizing:border-box;
        color:#1e88e5;
        font-weight:700;
        font-size:12px;
        margin-bottom:6px;
      ">
        ${props.name} ${props.status ? `- ${props.status}` : ""}
      </div>

      <!-- INFO TABLE (blue borders, white bg, BLACK text) -->
      <div class="ffd-info" id="ffd-info-${popupId}" style="width:100%;box-sizing:border-box;">
        <table style="
          width:100%;
          border-collapse:collapse;
          background:#ffffff;
          font-size:10.5px;
          table-layout:fixed;
        ">
          <tr>
            <td style="width:42%;border:1px solid #1e88e5;padding:6px 6px;font-weight:700;color:#000000;vertical-align:top;">
              Outflow
            </td>
            <td style="border:1px solid #1e88e5;padding:6px 6px;color:#000000;vertical-align:top;word-break:break-word;">
              ${props.outflow_discharge} cusecs
            </td>
          </tr>

          <tr>
            <td style="border:1px solid #1e88e5;padding:6px 6px;font-weight:700;color:#000000;vertical-align:top;">
              Inflow
            </td>
            <td style="border:1px solid #1e88e5;padding:6px 6px;color:#000000;vertical-align:top;word-break:break-word;">
              ${inflow} cusecs
            </td>
          </tr>

          <tr>
            <td style="border:1px solid #1e88e5;padding:6px 6px;font-weight:700;color:#000000;vertical-align:top;">
              Outflow Trend
            </td>
            <td style="border:1px solid #1e88e5;padding:6px 6px;color:#000000;vertical-align:top;word-break:break-word;">
              ${props.outflow_trend}
            </td>
          </tr>

          <tr>
            <td style="border:1px solid #1e88e5;padding:6px 6px;font-weight:700;color:#000000;vertical-align:top;">
              Inflow Trend
            </td>
            <td style="border:1px solid #1e88e5;padding:6px 6px;color:#000000;vertical-align:top;word-break:break-word;">
              ${props.inflow_trend}
            </td>
          </tr>

          <tr>
            <td style="border:1px solid #1e88e5;padding:6px 6px;font-weight:700;color:#000000;vertical-align:top;">
              Recording Time
            </td>
            <td style="border:1px solid #1e88e5;padding:6px 6px;color:#000000;vertical-align:top;word-break:break-word;">
              ${props.recording_time}
            </td>
          </tr>

          <tr>
            <td style="border:1px solid #1e88e5;padding:6px 6px;font-weight:700;color:#000000;vertical-align:top;">
              Outflow Time
            </td>
            <td style="border:1px solid #1e88e5;padding:6px 6px;color:#000000;vertical-align:top;word-break:break-word;">
              ${props.outflow_time}
            </td>
          </tr>
        </table>
      </div>

      <!-- BUTTON (blue pill style like "Open Report/Open Details") -->
      <button class="show-ffd-graph"
        data-popup-id="${popupId}"
        style="
          width:100%;
          margin-top:8px;
          background:#1976d2;
          color:#ffffff;
          border:none;
          padding:8px 16px;
          border-radius:20px;
          cursor:pointer;
          font-size:11px;
          font-weight:600;
          box-sizing:border-box;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        ">
        Show Graph
      </button>

      <!-- CHART WRAPPER (white bg + blue border) -->
      <div class="ffd-chart-container"
        id="ffd-chart-container-${popupId}"
        style="
          display:none;
          width:100%;
          margin-top:8px;
          text-align:center;
          opacity:0;
          transition:opacity 0.5s ease-in-out;
          background:#ffffff;
          border:1px solid #1e88e5;
          border-radius:8px;
          padding:8px;
          box-sizing:border-box;
        ">

        <canvas id="ffd-chart-canvas-${popupId}"
          style="width:100% !important;height:150px;display:block;">
        </canvas>

        <div class="chart-legend" style="
          margin-top:6px;
          font-size:9.5px;
          color:#000000;
          line-height:1.2;
          word-break:break-word;
        ">
          <span style="font-weight:700;">Outflow:</span> ${props.outflow_discharge} cusecs (${props.outflow_trend})
          <span style="color:#666;"> | </span>
          <span style="font-weight:700;">Inflow:</span> ${inflow} cusecs (${props.inflow_trend})
        </div>
      </div>

    </div>`;
}

function createFfdChart(
  canvas,
  outflow,
  inflow,
  name,
  outflowTrend,
  inflowTrend
) {
  const ctx = canvas.getContext("2d");
  const chartId = canvas.id;

  if (ffdChartInstances[chartId]) {
    ffdChartInstances[chartId].destroy();
  }

  // prune FFD chart cache
  pruneCacheMap(ffdChartInstances, MAX_FFD_CHARTS, (chart) => {
    if (chart && typeof chart.destroy === "function") chart.destroy();
  });

  ffdChartInstances[chartId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Outflow", "Inflow"],
      datasets: [
        {
          label: "Outflow Discharge",
          data: [outflow !== "n/a" ? parseFloat(outflow) : 0, null],
          backgroundColor: "#0074D9",
          borderColor: "#0056b3",
          borderWidth: 2,
        },
        {
          label: "Inflow Discharge",
          data: [null, inflow !== "n/a" ? parseFloat(inflow) : 0],
          backgroundColor: "#FF4136",
          borderColor: "#b32424",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: {
        duration: 1000,
        easing: "easeInOutQuart",
      },
      scales: {
        x: {
          ticks: {
            color: "white",
            font: { weight: "bold" },
          },
          barPercentage: 1.0,
          categoryPercentage: 0.8,
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "white",
            font: { weight: "bold" },
          },
        },
      },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: "white",
            font: { weight: "bold" },
          },
        },
        tooltip: {
          callbacks: {
            title: () => name,
            label: (tooltipItem) =>
              `${tooltipItem.dataset.label}: ${tooltipItem.raw} cusecs`,
          },
        },
      },
    },
  });
}

function setupFfdPopupEventHandlers() {
  document.removeEventListener("click", handleFfdPopupClick);
  document.addEventListener("click", handleFfdPopupClick);
}

function handleFfdPopupClick(e) {
  const graphButton = e.target.closest(".show-ffd-graph");
  if (!graphButton) return;

  const popupId = graphButton.getAttribute("data-popup-id");
  if (!popupId) return;

  const chartContainer = document.getElementById(
    `ffd-chart-container-${popupId}`
  );
  const infoContainer = document.getElementById(`ffd-info-${popupId}`);
  const canvas = document.getElementById(`ffd-chart-canvas-${popupId}`);

  if (!chartContainer || !infoContainer || !canvas) return;

  if (chartContainer.style.display === "none") {
    chartContainer.style.display = "block";
    setTimeout(() => (chartContainer.style.opacity = "1"), 10);
    infoContainer.style.display = "none";

    const popupContainer = graphButton.closest("div");
    const headerDiv = popupContainer.querySelector(
      "div[style*='background:black']"
    );
    const headerText = headerDiv.textContent;
    const parts = headerText.split(" - ");
    const stationName = parts[0].trim();

    const tableRows = popupContainer.querySelectorAll("table tr");
    const outflow = tableRows[0]?.cells[1]?.textContent.split(" ")[0] || "0";
    const inflow = tableRows[1]?.cells[1]?.textContent.split(" ")[0] || "0";
    const outflowTrend = tableRows[2]?.cells[1]?.textContent || "";
    const inflowTrend = tableRows[3]?.cells[1]?.textContent || "";

    createFfdChart(
      canvas,
      outflow,
      inflow,
      stationName,
      outflowTrend,
      inflowTrend
    );
    graphButton.textContent = "Hide Graph";
  } else {
    chartContainer.style.opacity = "0";
    setTimeout(() => {
      chartContainer.style.display = "none";
      infoContainer.style.display = "block";
      graphButton.textContent = "Show Graph";
    }, 500);
  }
}

// ========== END FFD-SPECIFIC CODE ==========

// ========== GDACS-SPECIFIC HELPERS ==========
function formatGdacsDate(val) {
  if (!val) return "(empty)";
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return String(val);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function escHtml(v) {
  // Small escape helper to avoid accidentally injecting HTML into the popup.
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildGdacsPopupContent(props) {
  // Safe parse helper (works if value is already an object OR a JSON string)
  const asObject = (v) => {
    if (!v) return null;
    if (typeof v === "object") return v;
    if (typeof v === "string") {
      try { return JSON.parse(v); } catch { return null; }
    }
    return null;
  };

  // Only render the subset you asked for.
  const eventType = props.eventtype ?? "";
  const name = props.name ?? props.eventname ?? "";
  const htmlDescription = props.htmldescription ?? props.description ?? "";

  const urlObj = asObject(props.url) || {};
  const reportUrl = urlObj.report ?? "";
  const detailsUrl = urlObj.details ?? "";

  const alertLevel = props.alertlevel ?? "";
  const country = props.country ?? "";

  // ✅ correct key name is fromdate (lowercase)
  const fromDate = props.fromdate ?? "";
  const toDate = props.todate ?? "";

  const sevObj = asObject(props.severitydata) || {};
  const severityText = sevObj.severitytext ?? "";
  const severityUnit = sevObj.severityunit ?? "";

  // console.log("[GDACS subset]", {
  //   eventType, name, htmlDescription, alertLevel, country,
  //   fromDate, toDate, severityText, severityUnit,
  //   reportUrl, detailsUrl,
  // });


  const row = (k, v, isHtml = false) => {
    const safeVal = isHtml ? v : escHtml(v);
    return `
      <tr>
        <th scope="row">${escHtml(k)}</th>
        <td>${safeVal || "(empty)"}</td>
      </tr>
    `;
  };

  const buttons = `
    <div class="gdacs-actions">
      <a class="gdacs-btn" href="${escHtml(reportUrl)}" target="_blank" rel="noopener noreferrer" ${reportUrl ? "" : 'aria-disabled="true" tabindex="-1"'
    }>${reportUrl ? "Open Report" : "Report N/A"}</a>
      <a class="gdacs-btn gdacs-btn-secondary" href="${escHtml(
      detailsUrl
    )}" target="_blank" rel="noopener noreferrer" ${detailsUrl ? "" : 'aria-disabled="true" tabindex="-1"'
    }>${detailsUrl ? "Open Details" : "Details N/A"}</a>
    </div>
  `;

  return `
    <div class="gdacs-popup">
      <table class="gdacs-table" role="table">
        <tbody>
          ${row("Event Type", eventType)}
          ${row("Alert Level", alertLevel)}
          ${row("Country", country)}
          ${row("From", escHtml(formatGdacsDate(fromDate)), true)}
          ${row("To", escHtml(formatGdacsDate(toDate)), true)}
          ${row("Severity", severityText)}
          ${row("Severity Unit", severityUnit)}
          ${row("Description", htmlDescription)}
        </tbody>
      </table>
      ${buttons}
    </div>
  `;
}

// ========== END GDACS-SPECIFIC HELPERS ==========

export default class LayerAttributePopup {
  constructor(map) {
    this.map = null;
    this.popupEl = this.#createEl();
    this.anchorLngLat = null;
    this.isReady = false;

    // 🚀 Pre-index popup-eligible layers based strictly on popup:true in config
    const { popupLayers, popupSources, labelsByLayer, labelsBySource } =
      this.#indexPopupEligible();
    this.popupLayers = popupLayers;
    this.popupSources = popupSources;
    this.labelsByLayer = labelsByLayer;
    this.labelsBySource = labelsBySource;

    this.dynamicPopupLayers = new Set();
    this.dynamicPopupSources = new Set();
    this.dynamicTitleByLayer = new Map();
    this.dynamicTitleBySource = new Map();
    this._lastExposureCount = -1;
    this._dataTimeout = null; // For debouncing data events

    // Pre-compile GDACS regex patterns
    this.gdacsLayerRegex = new RegExp(
      `(${[
        "gdacs_tc",
        "gdacs_fl",
        "gdacs_eq",
        "gdacs_vo",
        "gdacs_wf",
        "gdacs_dr",
        "TC_",
        "FL_",
        "EQ_",
        "VO_",
        "WF_",
        "DR_",
      ].join("|")})`,
      "i"
    );

    this.gdacsSourceRegex = new RegExp(
      `(${[
        "gdacs_TC",
        "gdacs_FL",
        "gdacs_EQ",
        "gdacs_VO",
        "gdacs_WF",
        "gdacs_DR",
      ].join("|")})`,
      "i"
    );

    this.#bindToMap(map);
  }

  #createEl() {
    const el = document.createElement("div");
    el.className = "layer-attribute-popup hidden";
    el.innerHTML = `<div class="popup-content"></div>`;
    document.body.appendChild(el);
    return el;
  }

  setContent(title, properties) {
    this.#setContent({ title, properties });
    if (this.anchorLngLat) {
      this.#show();
      this.#updatePosition();
      this.#attachMoveListeners();
    }
  }

  #setContent({ title, properties }) {
    const contentDiv = this.popupEl.querySelector(".popup-content");
    if (!contentDiv) return;

    const props = properties || {};
    const keys = Object.keys(props);

    if (keys.length === 0) {
      contentDiv.innerHTML = `
        <div style="
          width: 300px;
          padding: 16px;
          background: var(--primary-bg, rgba(0, 0, 0, 0.6));
          backdrop-filter: blur(15px);
          border: 2px solid var(--border-light, rgba(255, 255, 255, 0.7));
          border-radius: 12px;
          font-family: 'Inter', sans-serif;
          color: var(--text-muted, rgba(255, 255, 255, 0.55));
          font-style: italic;
          text-align: center;
        ">
          No attributes found for this feature
        </div>
      `;
      return;
    }

    let tableRows = '';
    const addRows = (obj, level = 0) => {
      Object.keys(obj).forEach((key) => {
        if (HIDDEN_KEYS.has(key)) return;

        let val = obj[key];

        if (val === null || val === undefined) {
          val = "(empty)";
        }

        if (typeof val === "string") {
          try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === "object") val = parsed;
          } catch (_) { }
        }

        const indent = level * 16;

        if (val && typeof val === "object" && !Array.isArray(val)) {
          tableRows += `
            <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
              <td style="
                width: 40%;
                padding: 10px 14px;
                padding-left: ${indent + 14}px;
                font-size: 12px;
                vertical-align: middle;
                font-weight: 700;
                color: var(--text-secondary, rgba(255, 255, 255, 0.75));
                background: var(--glass-dark, rgba(0, 0, 0, 0.6));
                border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
                border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
              ">${prettyAttributeName(key)}</td>
              <td style="
                width: 60%;
                padding: 10px 14px;
                font-size: 12px;
                vertical-align: middle;
                color: var(--text-primary, rgba(255, 255, 255, 0.95));
                background: var(--frost-bg, rgba(255, 255, 255, 0.12));
                border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
              "></td>
            </tr>
          `;
          addRows(val, level + 1);
        } else {
          const displayVal = Array.isArray(val) ? val.join(", ") : String(val);
          tableRows += `
            <tr style="transition: background 0.2s ease;" onmouseover="this.style.background='var(--hover-bg, rgba(255, 255, 255, 0.08))'" onmouseout="this.style.background=''">
              <td style="
                width: 40%;
                padding: 10px 14px;
                padding-left: ${indent + 14}px;
                font-size: 12px;
                vertical-align: middle;
                font-weight: 700;
                color: var(--text-secondary, rgba(255, 255, 255, 0.75));
                background: var(--glass-dark, rgba(0, 0, 0, 0.6));
                border-right: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
                border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
              ">${prettyAttributeName(key)}</td>
              <td style="
                width: 60%;
                padding: 10px 14px;
                font-size: 12px;
                vertical-align: middle;
                color: var(--text-primary, rgba(255, 255, 255, 0.95));
                background: var(--frost-bg, rgba(255, 255, 255, 0.12));
                border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
                word-break: break-word;
              ">${displayVal}</td>
            </tr>
          `;
        }
      });
    };

    addRows(props);

    tableRows = tableRows.replace(/border-bottom: 1px solid[^"]*";(?=[^<]*<\/td>[^<]*<\/tr>\s*$)/, '');

    contentDiv.innerHTML = `
      <div style="
        width: 300px;
        box-sizing: border-box;
        background: var(--primary-bg, rgba(0, 0, 0, 0.6));
        backdrop-filter: blur(15px);
        border: 2px solid var(--border-light, rgba(255, 255, 255, 0.7));
        border-radius: 12px;
        padding: 16px;
        font-family: 'Inter', sans-serif;
        color: var(--text-primary, rgba(255, 255, 255, 0.95));
        box-shadow: var(--shadow-soft, 0 8px 16px rgba(0, 0, 0, 0.25));
      ">
        <div style="
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 14px;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
        ">
          <span style="
            font-size: 15px;
            font-weight: 700;
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            letter-spacing: 0.3px;
          ">${title || "Feature Attributes"}</span>
        </div>
        <table style="
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          border: 2px solid var(--border-dark, rgba(255, 255, 255, 0.2));
          border-radius: 10px;
          overflow: hidden;
          background: var(--glass-medium, rgba(0, 0, 0, 0.4));
        ">
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    `;
  }


  // Basic indexing from config only; respects popup:true strictly
  #indexPopupEligible() {
    const popupLayers = new Set();
    const popupSources = new Set();
    const labelsByLayer = new Map();
    const labelsBySource = new Map();

    const processItem = (item) => {
      if (!item || typeof item !== "object") return;

      const hasPopup = item.popup === true;
      const hasLayers =
        item.layers && Array.isArray(item.layers) && item.layers.length > 0;
      const sourceId = item.source?.id || null;

      // Only index items explicitly marked popup:true
      if (!hasPopup) return;

      const title = item.label || item.name;

      if (sourceId) {
        popupSources.add(sourceId);
        if (title) labelsBySource.set(sourceId, title);
      }

      if (hasLayers) {
        for (const layer of item.layers) {
          if (layer?.id) {
            popupLayers.add(layer.id);
            if (title) labelsByLayer.set(layer.id, title);
          }
        }
      }
    };

    const processGroup = (group) => {
      if (!group || typeof group !== "object") return;
      for (const item of Object.values(group)) {
        processItem(item);
      }
    };

    const processCategory = (category) => {
      if (!category || typeof category !== "object") return;

      for (const subcat of Object.values(category)) {
        if (!subcat || typeof subcat !== "object") continue;

        // direct buckets
        for (const bucketName of [
          "toggle",
          "temporal",
          "button",
          "dropdown",
          "static",
        ]) {
          const bucket = subcat[bucketName];
          if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) {
            processGroup(bucket);
          }
        }

        // nested/subsections buckets (e.g. DEW » Hazard Alerts » GDACS Alerts)
        const nested = subcat.nested || subcat.subsections;
        if (nested && typeof nested === "object") {
          for (const nestedSection of Object.values(nested)) {
            if (!nestedSection || typeof nestedSection !== "object") continue;
            for (const bucketName of [
              "toggle",
              "temporal",
              "button",
              "dropdown",
              "static",
            ]) {
              const bucket = nestedSection[bucketName];
              if (
                bucket &&
                typeof bucket === "object" &&
                !Array.isArray(bucket)
              ) {
                processGroup(bucket);
              }
            }
          }
        }
      }
    };

    try {
      if (ncop_menu_items && typeof ncop_menu_items === "object") {
        for (const category of Object.values(ncop_menu_items)) {
          processCategory(category);
        }
      }
    } catch (err) {
      console.warn("Basic popup indexing failed:", err);
    }

    return { popupLayers, popupSources, labelsByLayer, labelsBySource };
  }

  // FIXED: More aggressive pattern matching - runs even if style is loading
  #addCommonClickableLayers() {
    const commonPatterns = [
      "boundary",
      "admin",
      "district",
      "province",
      "country",
      "national",
      "gdacs",
      "flood",
      "earthquake",
      "cyclone",
      "drought",
      "wildfire",
      "waqi",
      "station",
      "sensor",
      "monitoring",
      "ffd",
      "infrastructure",
      "alert",
      "warning",
      "hazard",
      "risk",
      "exposure",
      "pmd",
      "ndma",
    ];

    try {
      if (!this.map || typeof this.map.getStyle !== "function") {
        return;
      }

      const style = this.map.getStyle();
      if (style?.layers) {
        for (const layer of style.layers) {
          if (!layer.id || layer.type === "raster") continue;

          const sourceId = layer.source;
          // ⛔ Skip Mapbox / basemap sources entirely
          if (this.#isBasemapSource(sourceId)) continue;

          const layerId = layer.id.toLowerCase();
          for (const pattern of commonPatterns) {
            if (layerId.includes(pattern)) {
              this.popupLayers.add(layer.id);
              if (!this.labelsByLayer.has(layer.id)) {
                this.labelsByLayer.set(
                  layer.id,
                  this.#generateTitleFromId(layer.id)
                );
              }
              break;
            }
          }
        }
      }
    } catch (err) {
      console.warn("Could not scan map layers for popup eligibility:", err);
    }
  }

  #shouldBeClickable(layerId) {
    if (!layerId) return false;
    const id = layerId.toLowerCase();
    return (
      id.includes("boundary") ||
      id.includes("admin") ||
      id.includes("district") ||
      id.includes("gdacs") ||
      id.includes("flood") ||
      id.includes("waqi") ||
      id.includes("station") ||
      id.includes("alert") ||
      id.includes("infrastructure") ||
      id.includes("national") ||
      id.includes("provincial")
    );
  }

  #generateTitleFromId(layerId) {
    if (!layerId) return "Feature";
    return layerId
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  #refreshDynamicExposureLookups() {
    const mapObj = window.exposureLayersMap;
    const count = mapObj instanceof Map ? mapObj.size : 0;
    if (count === this._lastExposureCount) return;

    this.dynamicPopupLayers.clear();
    this.dynamicPopupSources.clear();
    this.dynamicTitleByLayer.clear();
    this.dynamicTitleBySource.clear();

    if (mapObj instanceof Map && count > 0) {
      mapObj.forEach(({ layerId, outlineId, sourceId }, exposureId) => {
        let title = `DEW Exposure #${exposureId}`;

        try {
          const src = this.map?.getSource(sourceId);
          const data = src?.serialized?.data || src?._data || src?.data;
          const features = data?.features || [];
          if (features.length > 0) {
            const remarks = features[0].properties?.exposure_remarks;
            if (
              remarks &&
              typeof remarks === "string" &&
              remarks.trim() !== ""
            ) {
              title = remarks.trim();
            }
          }
        } catch (err) {
          console.warn(
            "Could not read exposure_remarks for exposure",
            exposureId,
            err
          );
        }

        if (layerId) {
          this.dynamicPopupLayers.add(layerId);
          this.dynamicTitleByLayer.set(layerId, title);
        }
        if (outlineId) {
          this.dynamicPopupLayers.add(outlineId);
          this.dynamicTitleByLayer.set(outlineId, title);
        }
        if (sourceId) {
          this.dynamicPopupSources.add(sourceId);
          this.dynamicTitleBySource.set(sourceId, title);
        }
      });
    }

    this._lastExposureCount = count;
  }

  #isGDACSLayer(layerId, sourceId) {
    return (
      (layerId && this.gdacsLayerRegex.test(layerId)) ||
      (sourceId && this.gdacsSourceRegex.test(sourceId))
    );
  }

  #getGDACSAlertType(layerId, sourceId) {
    const id = (layerId || sourceId || "").toLowerCase();
    if (id.includes("tc")) return "Tropical Cyclone";
    if (id.includes("fl")) return "Flood";
    if (id.includes("eq")) return "Earthquake";
    if (id.includes("vo")) return "Volcano";
    if (id.includes("wf")) return "Wildfire";
    if (id.includes("dr")) return "Drought";
    return "GDACS Alert";
  }

  #isMapboxMap(obj) {
    return !!(
      obj &&
      typeof obj.on === "function" &&
      typeof obj.project === "function" &&
      typeof obj.getCanvas === "function"
    );
  }

  #bindToMap(candidate) {
    const tryAttach = () => {
      const m = candidate || window.ncop_map || window.map;
      if (this.#isMapboxMap(m)) {
        this.map = m;

        // Bind events immediately
        this.#bindEvents();
        this.isReady = true;

        // Try to add common clickable layers immediately if style is ready
        if (m.isStyleLoaded && m.isStyleLoaded()) {
          this.#addCommonClickableLayers();
        }

        // Also add them when style loads/reloads
        m.on("style.load", () => {
          this.#addCommonClickableLayers();
        });

        // And add them on any data change (when layers are added dynamically)
        m.on("data", (e) => {
          if (e.dataType === "source" && e.isSourceLoaded) {
            // Debounce this to avoid too many calls
            clearTimeout(this._dataTimeout);
            this._dataTimeout = setTimeout(() => {
              this.#addCommonClickableLayers();
            }, 500);
          }
        });

        return true;
      }
      return false;
    };

    if (tryAttach()) return;

    let retryDelay = 25;
    const maxDelay = 500;

    const retry = () => {
      if (tryAttach()) return;
      retryDelay = Math.min(retryDelay * 1.2, maxDelay);
      setTimeout(retry, retryDelay);
    };

    retry();
  }

  #queryFeaturesAtPoint(point, options = {}) {
    const now = Date.now();

    // Simple cache for identical queries
    if (
      LAST_QUERY_POINT &&
      LAST_QUERY_RESULT &&
      now - LAST_QUERY_TIME < 50 &&
      Math.abs(LAST_QUERY_POINT.x - point.x) < 1 &&
      Math.abs(LAST_QUERY_POINT.y - point.y) < 1
    ) {
      return LAST_QUERY_RESULT;
    }

    try {
      if (!this.map || typeof this.map.queryRenderedFeatures !== "function") {
        console.warn("Map not ready for popup feature queries");
        return [];
      }

      let features = [];
      try {
        features =
          this.map.queryRenderedFeatures(
            [
              [point.x - 3, point.y - 3],
              [point.x + 3, point.y + 3],
            ],
            options
          ) || [];
      } catch (err) {
        // This ONLY catches the Mapbox internal "featuresets undefined" bug.
        console.warn(
          "Popup feature query skipped (basemap still loading)",
          err
        );
        return []; // return empty so popup stops silently
      }
      const interactiveFeatures = features.filter((feature) => {
        if (!feature || !feature.layer) return false;
        if (feature.layer.type === "raster") return false;
        if (feature.layer.type === "background" || feature.layer.type === "sky")
          return false;
        if (feature.layer.layout && feature.layer.layout.visibility === "none")
          return false;
        return true;
      });

      // Cache the result
      LAST_QUERY_TIME = now;
      LAST_QUERY_POINT = { x: point.x, y: point.y };
      LAST_QUERY_RESULT = interactiveFeatures;

      return interactiveFeatures;
    } catch (err) {
      console.error("Feature query failed for popup:", err);
      return [];
    }
  }

  #isPopupEligible(feature) {
    if (!feature) return false;

    const layerType = feature.layer?.type;
    if (
      layerType === "raster" ||
      layerType === "background" ||
      layerType === "sky"
    ) {
      return false;
    }

    const layerId = feature.layer?.id;
    const sourceId = feature.source;

    const explicitlyEligible =
      (layerId && this.popupLayers.has(layerId)) ||
      (sourceId && this.popupSources.has(sourceId)) ||
      (layerId && this.dynamicPopupLayers.has(layerId)) ||
      (sourceId && this.dynamicPopupSources.has(sourceId));

    const isGDACS = this.#isGDACSLayer(layerId, sourceId);
    const isBasemap = this.#isBasemapSource(sourceId);
    const shouldBeClickable =
      !isBasemap && layerId && this.#shouldBeClickable(layerId);

    return explicitlyEligible || isGDACS || shouldBeClickable;
  }

  // 🚀 Separate event binding method
  #bindEvents() {
    // Enhanced click handler
    this.map.on("click", async (e) => {
      // Reset any special styling from previous popups
      this.popupEl.classList.remove("gdacs-light");

      this.#refreshDynamicExposureLookups();

      const features = this.#queryFeaturesAtPoint(e.point);
      if (!features?.length) {
        return this.hide();
      }

      let eligible = null;
      for (const feature of features) {
        if (this.#isPopupEligible(feature)) {
          eligible = feature;
          break;
        }
      }

      if (!eligible) {
        return this.hide();
      }

      const layerId = eligible.layer?.id;
      const sourceId = eligible.source;

      this.anchorLngLat = e.lngLat;

      // SPECIAL HANDLING FOR WAQI_STATIONS LAYER
      if (
        layerId?.includes("waqi_stations") ||
        sourceId === "waqi_stations-source"
      ) {
        const properties = { ...(eligible.properties || {}) };
        const waqiHtml = buildWaqiPopupContent(properties);

        const contentDiv = this.popupEl.querySelector(".popup-content");
        if (contentDiv) {
          contentDiv.innerHTML = waqiHtml;
        }

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupWaqiPopupEventHandlers();
        return;
      }

      // SPECIAL HANDLING FOR FFD_DATA LAYER
      if (layerId?.includes("ffd_data") || sourceId === "ffd_data-source") {
        const properties = { ...(eligible.properties || {}) };
        const ffdHtml = buildFfdPopupContent(properties);

        const contentDiv = this.popupEl.querySelector(".popup-content");
        if (contentDiv) {
          contentDiv.innerHTML = ffdHtml;
        }

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupFfdPopupEventHandlers();
        return;
      }
      // SPECIAL HANDLING FOR SLICK_PLUS LAYER
      if (
        layerId?.includes("slick_plus") ||
        layerId?.includes("slick-plus") ||
        sourceId?.includes("slick_plus")
      ) {
        const properties = { ...(eligible.properties || {}) };
        const slickPlusHtml = buildSlickPlusPopupContent(properties);

        const contentDiv = this.popupEl.querySelector(".popup-content");
        if (contentDiv) {
          contentDiv.innerHTML = slickPlusHtml;
        }

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        return;
      }

      // GDACS SUPPORT
      if (this.#isGDACSLayer(layerId, sourceId)) {
        const properties = { ...(eligible.properties || {}) };

        const alertType = this.#getGDACSAlertType(layerId, sourceId);
        const eventName = properties.Name || properties.eventname || properties.name || "GDACS Event";

        const gdacsHtml = buildGdacsPopupContent(properties);

        const contentDiv = this.popupEl.querySelector(".popup-content");
        if (contentDiv) {
          contentDiv.innerHTML = `
          <div style="
            width: 250px;
            box-sizing: border-box;
            background: var(--primary-bg, rgba(0, 0, 0, 0.6));
            backdrop-filter: blur(10px);
            border: 1.5px solid var(--border-light, rgba(255, 255, 255, 0.7));
            border-radius: 10px;
            padding: 10px;
            font-family: 'Inter', sans-serif;
            color: var(--text-primary, rgba(255, 255, 255, 0.95));
            box-shadow: var(--shadow-soft, 0 6px 12px rgba(0, 0, 0, 0.2));
          ">
            <div style="
              display: flex;
              align-items: center;
              justify-content: space-between;
              margin-bottom: 10px;
              padding-bottom: 8px;
              border-bottom: 1px solid var(--border-dark, rgba(255, 255, 255, 0.2));
            ">
              <span style="
                font-size: 12px;
                font-weight: 600;
                color: var(--text-primary, rgba(255, 255, 255, 0.95));
                letter-spacing: 0.3px;
              ">${eventName}</span>
            </div>
            ${gdacsHtml}
          </div>
        `;
        }

        this.popupEl.classList.remove("gdacs-light");

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        return;
      }

      // Generic popup
      const title =
        this.labelsByLayer.get(layerId) ||
        this.labelsBySource.get(sourceId) ||
        this.dynamicTitleByLayer.get(layerId) ||
        this.dynamicTitleBySource.get(sourceId) ||
        this.#generateTitleFromId(layerId) ||
        "Feature";

      let properties = {};

      if (eligible.properties) {
        properties = { ...eligible.properties };
      } else if (eligible.feature?.properties) {
        properties = { ...eligible.feature.properties };
      } else {
        console.warn("No properties found on popup feature", {
          layerId,
          sourceId,
        });
      }

      this.#setContent({ title, properties });
      this.#show();
      this.#updatePosition();
      this.#attachMoveListeners();
    });

    // Optimized mousemove
    let mouseMoveTimeout = null;
    this.map.on("mousemove", (e) => {
      if (mouseMoveTimeout) return;

      mouseMoveTimeout = setTimeout(() => {
        this.#refreshDynamicExposureLookups();

        const features = this.#queryFeaturesAtPoint(e.point);
        const hasEligible = features?.some((f) => this.#isPopupEligible(f));

        this.map.getCanvas().style.cursor = hasEligible ? "pointer" : "";
        mouseMoveTimeout = null;
      }, 16);
    });

    // Click-outside detection
    let lastMapClickTime = 0;
    this.map.on("click", () => {
      lastMapClickTime = Date.now();
    });

    document.addEventListener("mousedown", (ev) => {
      if (Date.now() - lastMapClickTime < 200) return;

      if (
        !this.popupEl.classList.contains("hidden") &&
        !this.popupEl.contains(ev.target)
      ) {
        this.hide();
      }
    });
  }

  #attachMoveListeners() {
    this.#detachMoveListeners();

    let updateTimeout = null;
    const throttledUpdate = () => {
      if (updateTimeout) return;
      updateTimeout = requestAnimationFrame(() => {
        this.#updatePosition();
        updateTimeout = null;
      });
    };

    this._moveHandler = throttledUpdate;
    this._zoomHandler = throttledUpdate;
    this._rotateHandler = throttledUpdate;

    this.map.on("move", this._moveHandler);
    this.map.on("zoom", this._zoomHandler);
    this.map.on("rotate", this._rotateHandler);
  }

  #detachMoveListeners() {
    if (this._moveHandler) this.map.off("move", this._moveHandler);
    if (this._zoomHandler) this.map.off("zoom", this._zoomHandler);
    if (this._rotateHandler) this.map.off("rotate", this._rotateHandler);
    this._moveHandler = this._zoomHandler = this._rotateHandler = null;
  }

  #updatePosition() {
    if (!this.anchorLngLat) return;

    try {
      const p = this.map.project(this.anchorLngLat);
      const mapCanvas = this.map.getCanvas();
      const rect = mapCanvas.getBoundingClientRect();
      const left = rect.left + p.x;
      const top = rect.top + p.y;

      const OFFSET_Y = 16;
      this.popupEl.style.left = `${Math.round(left)}px`;
      this.popupEl.style.top = `${Math.round(top - OFFSET_Y)}px`;
    } catch (err) {
      console.warn("Popup position update failed:", err);
    }
  }
  #isBasemapSource(sourceId) {
    if (!sourceId) return false;
    const id = String(sourceId).toLowerCase();

    // Mapbox default / common basemap sources
    if (id === "composite") return true;

    return (
      id.includes("mapbox") || // mapbox, mapbox-streets-v8, etc.
      id.includes("basemap") ||
      id.includes("satellite") ||
      id.includes("streets") ||
      id.includes("terrain")
    );
  }

  #show() {
    this.popupEl.classList.remove("hidden");
    window.ncop_popup_active = true;
  }

  hide() {
    this.popupEl.classList.add("hidden");
    this.anchorLngLat = null;
    this.#detachMoveListeners();
    window.ncop_popup_active = false;
  }
}

// 🚀 FIXED: More reliable initialization that waits for both DOM and map
if (typeof window !== "undefined" && !window.layerAttributePopup) {
  const initPopup = () => {
    const m = window.ncop_map || window.map;
    if (m) {
      window.layerAttributePopup = new LayerAttributePopup(m);
    } else {
      setTimeout(initPopup, 25);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPopup);
  } else {
    initPopup();
  }
}