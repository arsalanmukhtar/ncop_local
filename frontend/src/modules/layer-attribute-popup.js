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

const ndmaLogoSrc = new URL(
  "../assets/images/bg_images/ndma-logo.png",
  import.meta.url
).href;

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
      } catch (_) {}
    }
    delete cacheObj[k];
  }
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

function handleWaqiPopupClick(e) {
  const toggleBtn = e.target.closest(".aqi-infograph-inline-btn");
  if (toggleBtn) {
    const uid = toggleBtn.getAttribute("data-waqi-uid");
    const popupId = toggleBtn.getAttribute("data-popup-id");
    if (!uid || !popupId) return;

    const expanded = toggleBtn.getAttribute("data-expanded") === "true";
    const alreadyLoaded = toggleBtn.getAttribute("data-loaded") === "true";

    const metricsRow = document.getElementById(`aqi-inline-metrics-${popupId}`);
    const chartWrap = document.getElementById(
      `aqi-inline-chart-wrapper-${popupId}`
    );

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

      if (metricsRow) metricsRow.style.display = "flex";
      if (chartWrap) chartWrap.style.display = "block";

      toggleBtn.textContent = "Hide Station Infograph";
      toggleBtn.setAttribute("data-expanded", "true");
    } else {
      if (metricsRow) metricsRow.style.display = "none";
      if (chartWrap) chartWrap.style.display = "none";

      toggleBtn.textContent = "Show Station Infograph";
      toggleBtn.setAttribute("data-expanded", "false");
    }
  }

  const metricBtn = e.target.closest(".aqi-inline-metric-btn");
  if (metricBtn) {
    const metricKey = metricBtn.getAttribute("data-metric");
    const popupId = metricBtn.getAttribute("data-popup-id");
    if (!popupId) return;

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
    stationDetailsHtml = `<a href="https://aqicn.org/station/@${props.uid}/" target="_blank" style="font-size:12px;color:#fff;text-decoration:underline;">Station Details</a>`;
  }

  return `<div id="popup-airquality-${popupUID}" style="color:white;font-size:14px;line-height:1.4;max-width:240px;">
    <div style="font-weight:bold;font-size:14px;">${props.name}</div>
    <div style="font-size:13px;"><strong>AQI: ${props.aqi}</strong></div>
    <div style="font-size:11px;">${props.continent || ""}</div>
    <div style="font-size:11px;">${props.time}</div>
    <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
      <button class="aqi-infograph-inline-btn" data-waqi-uid="${
        props.uid
      }" data-popup-id="${popupUID}" data-expanded="false" data-loaded="false" style="background:#0074D9;color:white;border:none;padding:5px 10px;margin-top:5px;border-radius:20px;display:flex;align-items:center;font-size:11px;line-height:1.2;cursor:pointer;">Show Station Infograph</button>
      ${stationDetailsHtml}
    </div>
    <div id="aqi-inline-metrics-${popupUID}" style="display:none;margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;">
      <button class="aqi-inline-metric-btn" data-metric="pm25" data-popup-id="${popupUID}" style="background:#444;color:#fff;border:1px solid #666;border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;">PM2.5</button>
      <button class="aqi-inline-metric-btn" data-metric="pm10" data-popup-id="${popupUID}" style="background:#444;color:#fff;border:1px solid #666;border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;">PM10</button>
      <button class="aqi-inline-metric-btn" data-metric="co2" data-popup-id="${popupUID}" style="background:#444;color:#fff;border:1px solid #666;border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;">CO₂</button>
      <button class="aqi-inline-metric-btn" data-metric="tvoc" data-popup-id="${popupUID}" style="background:#444;color:#fff;border:1px solid #666;border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;">TVOC</button>
      <button class="aqi-inline-metric-btn" data-metric="met.t" data-popup-id="${popupUID}" style="background:#444;color:#fff;border:1px solid #666;border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;">Temp</button>
      <button class="aqi-inline-metric-btn" data-metric="met.h" data-popup-id="${popupUID}" style="background:#444;color:#fff;border:1px solid #666;border-radius:3px;padding:2px 4px;font-size:10px;cursor:pointer;">RH</button>
    </div>
    <div id="aqi-inline-chart-wrapper-${popupUID}" style="display:none;margin-top:8px;background:#1a1a1a;border:1px solid #444;border-radius:4px;padding:6px;">
      <div id="aqi-inline-station-name-${popupUID}" style="font-size:11px;font-weight:bold;color:#fff;"></div>
      <div id="aqi-inline-updated-time-${popupUID}" style="font-size:10px;color:#aaa;line-height:1.2;margin-bottom:4px;"></div>
      <canvas id="aqiInlineChart-${popupUID}" style="width:220px;height:140px;max-width:100%;"></canvas>
      <div id="aqi-inline-attrib-${popupUID}" style="font-size:9px;color:#888;margin-top:4px;line-height:1.3;"></div>
    </div>
  </div>`;
}

// ========== END WAQI-SPECIFIC CODE ==========

// ========== FFD-SPECIFIC CONSTANTS & HELPERS ==========
const ffdChartInstances = {};
const pmdChartInstances = {};

function buildFfdPopupContent(props) {
  const popupId = `ffd-${props.name}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  const inflow = props.inflow_discharge !== "n/a" ? props.inflow_discharge : 0;

  return `<div style="overflow-y:auto;">
    <div style="background:black;color:white;font-weight:bold;text-align:center;padding:5px;border-radius:5px;">${props.name} - ${props.status}</div>
    <div class="ffd-info" id="ffd-info-${popupId}">
      <table style="width:100%;border-collapse:collapse;color:white;">
        <tr>
          <td style="font-weight:bold;padding:4px;">Outflow:</td>
          <td style="padding:4px;">${props.outflow_discharge} cusecs</td>
        </tr>
        <tr>
          <td style="font-weight:bold;padding:4px;">Inflow:</td>
          <td style="padding:4px;">${inflow} cusecs</td>
        </tr>
        <tr>
          <td style="font-weight:bold;padding:4px;">Outflow Trend:</td>
          <td style="padding:4px;">${props.outflow_trend}</td>
        </tr>
        <tr>
          <td style="font-weight:bold;padding:4px;">Inflow Trend:</td>
          <td style="padding:4px;">${props.inflow_trend}</td>
        </tr>
        <tr>
          <td style="font-weight:bold;padding:4px;">Recording Time:</td>
          <td style="padding:4px;">${props.recording_time}</td>
        </tr>
        <tr>
          <td style="font-weight:bold;padding:4px;">Outflow Time:</td>
          <td style="padding:4px;">${props.outflow_time}</td>
        </tr>
      </table>
    </div>
    <button class="show-ffd-graph" data-popup-id="${popupId}" style="background:#0074D9;color:white;border:none;padding:5px 10px;margin-top:5px;border-radius:20px;display:flex;align-items:center;cursor:pointer;font-size:12px;">Show Graph</button>
    <div class="ffd-chart-container" id="ffd-chart-container-${popupId}" style="display:none;text-align:center;opacity:0;transition:opacity 0.5s ease-in-out;">
      <canvas id="ffd-chart-canvas-${popupId}" style="width:230px;height:150px;"></canvas>
      <div class="chart-legend" style="color:white;font-weight:bold;margin-top:5px;font-size:11px;">
        <span>Outflow: ${props.outflow_discharge} cusecs (${props.outflow_trend})</span> | <span>Inflow: ${inflow} cusecs (${props.inflow_trend})</span>
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

function formatPMDValue(value, digits = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  return num.toFixed(digits);
}

function formatPMDDateTime(date, time) {
  if (!date && !time) return "N/A";
  return [date, time].filter(Boolean).join(" ");
}

function buildPmdPopupContent(props) {
  const popupId = `pmd-${String(props.name || "station")
    .replace(/\s+/g, "-")
    .toLowerCase()}-${Math.random().toString(36).slice(2, 9)}`;
  const rainfall = Number(props.rainfall || 0);
  const rainfallState = rainfall > 0 ? "Rain observed" : "Dry conditions";
  const rainfallColor = rainfall > 0 ? "#2563eb" : "#f59e0b";

  return {
    popupId,
    html: `<div style="color:#e5eef7;max-width:300px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:10px;background:linear-gradient(135deg,#0f172a,#1e293b);margin-bottom:8px;">
        <div>
          <div style="font-size:15px;font-weight:700;line-height:1.2;">${props.name || "PMD Station"}</div>
          <div style="font-size:11px;color:#cbd5e1;margin-top:3px;">Pakistan Meteorological Department</div>
        </div>
        <div style="display:flex;align-items:flex-start;gap:6px;">
          <div style="font-size:11px;font-weight:700;color:white;background:${rainfallColor};padding:4px 8px;border-radius:999px;white-space:nowrap;">${rainfallState}</div>
          <button class="pmd-popup-close" type="button" style="width:24px;height:24px;border:none;border-radius:999px;background:#334155;color:#fff;font-size:14px;line-height:1;cursor:pointer;">×</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-bottom:8px;">
        <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:8px;padding:7px;">
          <div style="font-size:10px;color:#94a3b8;">Temperature</div>
          <div style="font-size:16px;font-weight:700;">${formatPMDValue(props.temperature)} °C</div>
        </div>
        <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:8px;padding:7px;">
          <div style="font-size:10px;color:#94a3b8;">Rainfall</div>
          <div style="font-size:16px;font-weight:700;">${formatPMDValue(props.rainfall)} mm</div>
        </div>
        <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:8px;padding:7px;">
          <div style="font-size:10px;color:#94a3b8;">Humidity</div>
          <div style="font-size:16px;font-weight:700;">${formatPMDValue(props.humidity)} %</div>
        </div>
        <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:8px;padding:7px;">
          <div style="font-size:10px;color:#94a3b8;">Wind</div>
          <div style="font-size:16px;font-weight:700;">${formatPMDValue(props.windSpeed)} kt</div>
        </div>
      </div>
      <div style="background:#0f172a;border:1px solid rgba(148,163,184,0.22);border-radius:10px;padding:8px;">
        <div style="font-size:11px;font-weight:700;margin-bottom:6px;color:#f8fafc;">Station Metrics</div>
        <canvas id="pmd-chart-canvas-${popupId}" style="width:280px;height:190px;max-width:100%;"></canvas>
      </div>
      <div style="margin-top:8px;background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:10px;padding:8px;font-size:11px;line-height:1.45;">
        <div><strong>Dew Point:</strong> ${formatPMDValue(props.dewPoint)} °C</div>
        <div><strong>Pressure:</strong> ${formatPMDValue(props.pressure)} hPa</div>
        <div><strong>Wind Direction:</strong> ${formatPMDValue(props.windDirection, 0)}°</div>
        <div><strong>Temp Updated:</strong> ${formatPMDDateTime(props.temp_date, props.temp_time)}</div>
        <div><strong>Wind Updated:</strong> ${formatPMDDateTime(props.wind_date, props.wind_time)}</div>
        <div><strong>Rain Updated:</strong> ${formatPMDDateTime(props.rainfall_date, props.rainfall_time)}</div>
      </div>
    </div>`,
  };
}

function createPmdChart(canvas, props) {
  const ctx = canvas.getContext("2d");
  const chartId = canvas.id;

  if (pmdChartInstances[chartId]) {
    pmdChartInstances[chartId].destroy();
  }

  const labels = [
    "Temperature",
    "Dew Point",
    "Humidity",
    "Pressure",
    "Wind Speed",
    "Rainfall",
  ];
  const values = [
    Number(props.temperature || 0),
    Number(props.dewPoint || 0),
    Number(props.humidity || 0),
    Number(props.pressure || 0),
    Number(props.windSpeed || 0),
    Number(props.rainfall || 0),
  ];

  pruneCacheMap(pmdChartInstances, MAX_FFD_CHARTS, (chart) => {
    if (chart && typeof chart.destroy === "function") chart.destroy();
  });

  pmdChartInstances[chartId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Station value",
          data: values,
          backgroundColor: [
            "#f97316",
            "#38bdf8",
            "#14b8a6",
            "#8b5cf6",
            "#f43f5e",
            "#2563eb",
          ],
          borderRadius: 6,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: {
        duration: 900,
        easing: "easeOutQuart",
      },
      scales: {
        x: {
          ticks: {
            color: "#e2e8f0",
            font: { size: 10, weight: "bold" },
            maxRotation: 0,
            minRotation: 0,
          },
          grid: {
            display: false,
          },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#94a3b8",
            font: { size: 10 },
          },
          grid: {
            color: "rgba(148,163,184,0.15)",
          },
        },
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label(context) {
              const units = {
                Temperature: "°C",
                "Dew Point": "°C",
                Humidity: "%",
                Pressure: "hPa",
                "Wind Speed": "kt",
                Rainfall: "mm",
              };
              const label = context.label;
              return `${label}: ${context.parsed.y} ${units[label] || ""}`.trim();
            },
          },
        },
      },
    },
  });
}

function buildEonetPopupContent(props) {
  let categories = [];
  let sources = [];

  try {
    categories = JSON.parse(props.categories_json || "[]");
  } catch (_) {}
  try {
    sources = JSON.parse(props.sources_json || "[]");
  } catch (_) {}

  const categoryHtml =
    categories.length > 0
      ? categories
          .map(
            (category) =>
              `<span style="display:inline-block;background:#1d4ed8;color:#eff6ff;padding:3px 8px;border-radius:999px;font-size:11px;margin:0 6px 6px 0;">${category.title || category.id || "Category"}</span>`
          )
          .join("")
      : `<span style="color:#94a3b8;">No category metadata</span>`;

  const sourceHtml =
    sources.length > 0
      ? sources
          .map((source) => {
            const label = source.id || "Source";
            const url = source.url || "";
            if (url) {
              return `<li><a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;text-decoration:underline;">${label}</a></li>`;
            }
            return `<li>${label}</li>`;
          })
          .join("")
      : `<li>No source links available</li>`;

  const eventLink = props.event_link
    ? `<a href="${props.event_link}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;text-decoration:underline;">Open EONET Event</a>`
    : "";

  return `<div style="color:#e5eef7;max-width:320px;line-height:1.45;">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:linear-gradient(135deg,#0f172a,#1e293b);margin-bottom:8px;">
      <div>
        <div style="font-size:15px;font-weight:700;line-height:1.25;">${props.title || "NASA EONET Event"}</div>
        <div style="font-size:11px;color:#cbd5e1;margin-top:4px;">ID: ${props.event_id || "N/A"}</div>
      </div>
      <div style="font-size:11px;font-weight:700;color:white;background:${props.event_status === "Closed" ? "#64748b" : "#16a34a"};padding:4px 8px;border-radius:999px;white-space:nowrap;">${props.event_status || "Open"}</div>
    </div>
    <div style="margin-bottom:8px;">
      ${categoryHtml}
    </div>
    <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:10px;padding:8px;font-size:11px;margin-bottom:8px;">
      <div><strong>Description:</strong> ${props.description || "No description available."}</div>
      <div style="margin-top:6px;"><strong>Closed:</strong> ${props.closed || "Still open"}</div>
      <div><strong>Magnitude:</strong> ${props.magnitude_label || "N/A"}</div>
      ${
        props.magnitude_description
          ? `<div><strong>Magnitude Notes:</strong> ${props.magnitude_description}</div>`
          : ""
      }
      ${eventLink ? `<div style="margin-top:6px;">${eventLink}</div>` : ""}
    </div>
    <div style="background:#0f172a;border:1px solid rgba(148,163,184,0.22);border-radius:10px;padding:8px;font-size:11px;">
      <div style="font-weight:700;margin-bottom:6px;">Sources</div>
      <ul style="padding-left:18px;margin:0;">${sourceHtml}</ul>
    </div>
  </div>`;
}

let activeUsgsShakeMap = null;

function formatUsgsTime(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }) + " UTC";
}

function ensureUsgsLegendPanel() {
  let panel = document.getElementById("usgs-shakemap-panel");
  if (panel) return panel;

  if (!document.getElementById("usgs-shakemap-panel-styles")) {
    const style = document.createElement("style");
    style.id = "usgs-shakemap-panel-styles";
    style.textContent = `
      #usgs-shakemap-panel {
        position: absolute;
        right: 52px;
        bottom: 18px;
        z-index: 20;
        width: 548px;
        max-width: calc(100vw - 24px);
        max-height: 46vh;
        overflow: hidden;
        display: none;
        color: #e2e8f0;
        border-radius: 20px;
        border: 1px solid rgba(148, 163, 184, 0.22);
        background:
          linear-gradient(180deg, rgba(15, 23, 42, 0.94), rgba(17, 24, 39, 0.96)),
          radial-gradient(circle at top left, rgba(56, 189, 248, 0.2), transparent 35%);
        box-shadow:
          0 22px 50px rgba(2, 6, 23, 0.45),
          inset 0 1px 0 rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(14px);
      }

      #usgs-shakemap-panel .usgs-panel-shell {
        padding: 14px;
      }

      #usgs-shakemap-panel .usgs-panel-header {
        display: flex;
        align-items: stretch;
        gap: 12px;
        margin-bottom: 12px;
      }

      #usgs-shakemap-panel .usgs-panel-logo {
        width: 58px;
        height: 58px;
        border-radius: 18px;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.92));
        border: 1px solid rgba(148, 163, 184, 0.2);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
      }

      #usgs-shakemap-panel .usgs-panel-logo img {
        width: 42px;
        height: 42px;
        object-fit: contain;
        animation: usgsPanelSpin 16s linear infinite;
      }

      #usgs-shakemap-panel .usgs-panel-info {
        min-width: 0;
        flex: 1 1 auto;
      }

      #usgs-shakemap-panel .usgs-panel-kicker {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #7dd3fc;
        margin-bottom: 4px;
      }

      #usgs-shakemap-panel .usgs-panel-title {
        font-size: 20px;
        font-weight: 800;
        line-height: 1.05;
        color: #f8fafc;
      }

      #usgs-shakemap-panel .usgs-panel-subtitle {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid rgba(148, 163, 184, 0.18);
        color: #cbd5e1;
        font-size: 12px;
        line-height: 1.35;
      }

      #usgs-shakemap-panel .usgs-panel-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
        padding: 10px 12px;
        border-radius: 14px;
        background: rgba(15, 23, 42, 0.54);
        border: 1px solid rgba(148, 163, 184, 0.16);
      }

      #usgs-shakemap-panel .usgs-panel-label-wrap {
        min-width: 0;
      }

      #usgs-shakemap-panel .usgs-panel-label-caption {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #94a3b8;
        margin-bottom: 4px;
      }

      #usgs-shakemap-panel .usgs-panel-label {
        font-size: 14px;
        font-weight: 700;
        color: #f8fafc;
        word-break: break-word;
      }

      #usgs-shakemap-panel .usgs-clear-shakemap {
        border: none;
        border-radius: 12px;
        padding: 9px 14px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        color: #fff;
        background: linear-gradient(135deg, #ef4444, #b91c1c);
        box-shadow: 0 10px 20px rgba(127, 29, 29, 0.35);
        transition: transform 0.18s ease, box-shadow 0.18s ease, filter 0.18s ease;
      }

      #usgs-shakemap-panel .usgs-clear-shakemap:hover {
        transform: translateY(-1px);
        filter: brightness(1.04);
        box-shadow: 0 14px 24px rgba(127, 29, 29, 0.45);
      }

      #usgs-shakemap-panel .usgs-panel-legend {
        overflow: auto;
        max-height: calc(46vh - 150px);
        border-radius: 16px;
        padding: 12px;
        background:
          linear-gradient(180deg, rgba(15, 23, 42, 0.7), rgba(2, 6, 23, 0.8)),
          radial-gradient(circle at top right, rgba(14, 165, 233, 0.15), transparent 30%);
        border: 1px solid rgba(148, 163, 184, 0.18);
      }

      #usgs-shakemap-panel .usgs-panel-legend-title {
        margin-bottom: 10px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #7dd3fc;
      }

      #usgs-shakemap-panel .usgs-panel-legend img {
        width: 100%;
        display: block;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.32);
      }

      #usgs-shakemap-panel .usgs-panel-empty {
        padding: 12px;
        border-radius: 14px;
        background: rgba(15, 23, 42, 0.52);
        border: 1px dashed rgba(148, 163, 184, 0.22);
        color: #cbd5e1;
        font-size: 12px;
        line-height: 1.5;
      }

      @keyframes usgsPanelSpin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      @media (max-width: 640px) {
        #usgs-shakemap-panel {
          right: 10px;
          left: 10px;
          bottom: 10px;
          width: auto;
          max-width: none;
          max-height: 50vh;
        }
      }
    `;
    document.head.appendChild(style);
  }

  panel = document.createElement("div");
  panel.id = "usgs-shakemap-panel";
  document.body.appendChild(panel);
  return panel;
}

function clearUsgsShakeMapLayer() {
  const map = window.ncop_map || window.map;
  if (map && activeUsgsShakeMap) {
    if (map.getLayer(activeUsgsShakeMap.layerId)) map.removeLayer(activeUsgsShakeMap.layerId);
    if (map.getSource(activeUsgsShakeMap.sourceId)) map.removeSource(activeUsgsShakeMap.sourceId);
  }
  activeUsgsShakeMap = null;
  const panel = document.getElementById("usgs-shakemap-panel");
  if (panel) {
    panel.style.display = "none";
    panel.innerHTML = "";
  }
}

function collectCoordinates(geometry, bucket = []) {
  if (!geometry) return bucket;
  const coords = geometry.coordinates;
  if (!Array.isArray(coords)) return bucket;
  if (typeof coords[0] === "number") {
    bucket.push([coords[0], coords[1]]);
    return bucket;
  }
  coords.forEach((item) => collectCoordinates({ coordinates: item }, bucket));
  return bucket;
}

async function animateUsgsShakeMapLayer(contentUrl, legendUrl, label) {
  const map = window.ncop_map || window.map;
  if (!map) return;

  clearUsgsShakeMapLayer();

  const response = await fetch(
    `${window.baseUrl || window.location.origin}/get-usgs-shakemap-content/?url=${encodeURIComponent(contentUrl)}`
  );
  if (!response.ok) {
    throw new Error("Could not load ShakeMap content");
  }
  const geojson = await response.json();
  const features = geojson.features || [];
  if (!features.length) {
    throw new Error("ShakeMap has no features");
  }

  const firstType = features[0]?.geometry?.type || "";
  let layerType = "line";
  let paint = {};

  if (firstType.includes("Point")) {
    layerType = "circle";
    paint = {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["coalesce", ["to-number", ["get", "intensity"]], 0],
        0,
        5,
        10,
        18,
      ],
      "circle-color": [
        "coalesce",
        ["to-color", ["get", "color"]],
        "#ef4444",
      ],
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff",
      "circle-opacity": 0.88,
    };
  } else if (firstType.includes("Polygon")) {
    layerType = "fill";
    paint = {
      "fill-color": ["coalesce", ["to-color", ["get", "color"]], "#ef4444"],
      "fill-opacity": 0.4,
      "fill-outline-color": "#111827",
    };
  } else {
    layerType = "line";
    paint = {
      "line-color": ["coalesce", ["to-color", ["get", "color"]], "#ef4444"],
      "line-width": [
        "coalesce",
        ["to-number", ["get", "weight"]],
        2,
      ],
    };
  }

  const sourceId = "usgs_shakemap_source";
  const layerId = "usgs_shakemap_layer";
  const animatedData = { type: "FeatureCollection", features: [] };

  map.addSource(sourceId, { type: "geojson", data: animatedData });
  map.addLayer({ id: layerId, type: layerType, source: sourceId, paint });
  activeUsgsShakeMap = { sourceId, layerId };

  const bounds = features.reduce((acc, feature) => {
    collectCoordinates(feature.geometry).forEach((coord) => acc.extend(coord));
    return acc;
  }, new mapboxgl.LngLatBounds());
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 32, duration: 900 });
  }

  let index = 0;
  const batchSize = Math.max(1, Math.ceil(features.length / 30));
  const step = () => {
    if (!map.getSource(sourceId)) return;
    for (let i = 0; i < batchSize && index < features.length; i += 1) {
      animatedData.features.push(features[index]);
      index += 1;
    }
    map.getSource(sourceId).setData(animatedData);
    if (index < features.length) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);

  const panel = ensureUsgsLegendPanel();
  panel.style.display = "block";
  panel.innerHTML = `
    <div class="usgs-panel-shell">
      <div class="usgs-panel-header">
        <div class="usgs-panel-logo">
          <img src="${ndmaLogoSrc}" alt="NDMA Logo" />
        </div>
        <div class="usgs-panel-info">
          <div class="usgs-panel-kicker">USGS Monitoring</div>
          <div class="usgs-panel-title">ShakeMap</div>
          <div class="usgs-panel-subtitle">Live seismic intensity overlay and supporting legend for the selected earthquake event.</div>
        </div>
      </div>
      <div class="usgs-panel-actions">
        <div class="usgs-panel-label-wrap">
          <div class="usgs-panel-label-caption">Active Product</div>
          <div class="usgs-panel-label">${label}</div>
        </div>
        <button type="button" class="usgs-clear-shakemap">Clear</button>
      </div>
      <div class="usgs-panel-legend">
        <div class="usgs-panel-legend-title">Legend Preview</div>
        ${
          legendUrl
            ? `<img src="${legendUrl}" alt="ShakeMap legend" />`
            : `<div class="usgs-panel-empty">No legend is available for this ShakeMap product, but the selected overlay is still active on the map.</div>`
        }
      </div>
    </div>
  `;
}

function pickPreferredUsgsShakemapContent(contents) {
  const preferredKeys = [
    "download/cont_mmi.json",
    "download/cont_pga.json",
    "download/cont_pgv.json",
    "download/cont_mi.json",
    "download/stationlist.json",
  ];
  for (const key of preferredKeys) {
    if (contents[key]?.url) {
      return {
        url: contents[key].url,
        label: key.split("/").pop().replace(".json", "").replace("cont_", "").toUpperCase(),
        legendUrl: contents["download/mmi_legend.png"]?.url || "",
      };
    }
  }
  return null;
}

function buildUsgsPopupContent(props) {
  return `<div style="color:#e5eef7;max-width:320px;line-height:1.45;">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:linear-gradient(135deg,#0f172a,#1e293b);margin-bottom:8px;">
      <div>
        <div style="font-size:15px;font-weight:700;line-height:1.25;">${props.title || "USGS Earthquake"}</div>
        <div style="font-size:11px;color:#cbd5e1;margin-top:4px;">${props.place || "Unknown location"}</div>
      </div>
      <div style="font-size:12px;font-weight:700;color:white;background:#991b1b;padding:4px 8px;border-radius:999px;white-space:nowrap;">M ${props.mag ?? "N/A"}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-bottom:8px;">
      <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:8px;padding:7px;">
        <div style="font-size:10px;color:#94a3b8;">Depth</div>
        <div style="font-size:15px;font-weight:700;">${props.depth_km ?? "N/A"} km</div>
      </div>
      <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:8px;padding:7px;">
        <div style="font-size:10px;color:#94a3b8;">Significance</div>
        <div style="font-size:15px;font-weight:700;">${props.significance ?? "N/A"}</div>
      </div>
      <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:8px;padding:7px;">
        <div style="font-size:10px;color:#94a3b8;">Status</div>
        <div style="font-size:15px;font-weight:700;">${props.status || "N/A"}</div>
      </div>
      <div style="background:#111827;border:1px solid rgba(148,163,184,0.2);border-radius:8px;padding:7px;">
        <div style="font-size:10px;color:#94a3b8;">Tsunami</div>
        <div style="font-size:15px;font-weight:700;">${props.tsunami ? "Yes" : "No"}</div>
      </div>
    </div>
    <div style="background:#0f172a;border:1px solid rgba(148,163,184,0.22);border-radius:10px;padding:8px;font-size:11px;margin-bottom:8px;">
      <div><strong>Time:</strong> ${formatUsgsTime(props.time)}</div>
      <div><strong>Updated:</strong> ${formatUsgsTime(props.updated)}</div>
      <div><strong>Magnitude Type:</strong> ${props.magType || "N/A"}</div>
      <div><strong>Alert:</strong> ${props.alert || "None"}</div>
      <div><strong>Felt Reports:</strong> ${props.felt_reports ?? "N/A"}</div>
      ${
        props.usgs_event_url
          ? `<div style="margin-top:6px;"><a href="${props.usgs_event_url}" target="_blank" rel="noopener noreferrer" style="color:#38bdf8;text-decoration:underline;">Open USGS Event Page</a></div>`
          : ""
      }
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button type="button" class="usgs-fetch-shakemap" data-event-id="${props.event_id}" style="background:linear-gradient(135deg,#2563eb,#0ea5e9);color:#fff;border:none;border-radius:999px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;">Fetch ShakeMap</button>
      <button type="button" class="usgs-clear-shakemap" style="background:#334155;color:#fff;border:none;border-radius:999px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;">Clear ShakeMap</button>
      <span class="usgs-shakemap-status" style="font-size:11px;color:#94a3b8;"></span>
    </div>
  </div>`;
}

function setupUsgsPopupEventHandlers() {
  document.removeEventListener("click", handleUsgsPopupClick);
  document.addEventListener("click", handleUsgsPopupClick);
}

async function handleUsgsPopupClick(e) {
  const clearBtn = e.target.closest(".usgs-clear-shakemap");
  if (clearBtn) {
    clearUsgsShakeMapLayer();
    return;
  }

  const fetchBtn = e.target.closest(".usgs-fetch-shakemap");
  if (!fetchBtn) return;

  const eventId = fetchBtn.getAttribute("data-event-id");
  const statusEl = fetchBtn.parentElement?.querySelector(".usgs-shakemap-status");
  if (!eventId) return;

  if (statusEl) statusEl.textContent = "Loading ShakeMap...";
  fetchBtn.disabled = true;

  try {
    const response = await fetch(
      `${window.baseUrl || window.location.origin}/get-usgs-earthquake-detail/${eventId}/`
    );
    if (!response.ok) {
      throw new Error("Could not load earthquake detail");
    }
    const detail = await response.json();
    const products = detail.properties?.products || {};
    const shakemap = products.shakemap?.[0];
    const contents = shakemap?.contents || {};
    const chosen = pickPreferredUsgsShakemapContent(contents);

    if (!chosen) {
      throw new Error("No ShakeMap product available for this earthquake");
    }

    await animateUsgsShakeMapLayer(chosen.url, chosen.legendUrl, chosen.label);
    if (statusEl) statusEl.textContent = `Loaded ${chosen.label}`;
  } catch (error) {
    if (statusEl) statusEl.textContent = error.message;
  } finally {
    fetchBtn.disabled = false;
  }
}

function setupPmdPopupEventHandlers(popupInstance) {
  document.removeEventListener("click", handlePmdPopupClick);
  document.addEventListener("click", handlePmdPopupClick);
  window._ncopPmdPopupInstance = popupInstance;
}

function handlePmdPopupClick(e) {
  const closeBtn = e.target.closest(".pmd-popup-close");
  if (!closeBtn) return;

  const popupInstance = window._ncopPmdPopupInstance;
  if (popupInstance && typeof popupInstance.hide === "function") {
    popupInstance.hide();
  }
}

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
    el.innerHTML = `<div class="popup-content"><div class="popup-label"></div><div class="popup-attributes-scroll"><table class="popup-attributes"></table></div></div>`;
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
    const labelEl = this.popupEl.querySelector(".popup-label");
    const tableEl = this.popupEl.querySelector(".popup-attributes");

    labelEl.textContent = title || "Attributes";
    tableEl.innerHTML = "";

    const props = properties || {};
    const keys = Object.keys(props);

    if (keys.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="attr-value" colspan="2" style="color: #888; font-style: italic;">No attributes found for this feature</td>`;
      tableEl.appendChild(tr);
      return;
    }

    const fragment = document.createDocumentFragment();

    const addRows = (obj, level = 0) => {
      Object.keys(obj).forEach((key) => {
        if (HIDDEN_KEYS.has(key)) return;

        let val = obj[key];

        // Handle null/undefined
        if (val === null || val === undefined) {
          val = "(empty)";
        }

        // Try to parse JSON strings
        if (typeof val === "string") {
          try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === "object") val = parsed;
          } catch (_) {}
        }

        const indent = level * 16;
        const tr = document.createElement("tr");

        if (val && typeof val === "object" && !Array.isArray(val)) {
          tr.innerHTML = `<td class="attr-key" style="padding-left:${indent}px">${prettyAttributeName(
            key
          )}</td><td class="attr-value"></td>`;
          fragment.appendChild(tr);
          addRows(val, level + 1);
        } else {
          const displayVal = Array.isArray(val) ? val.join(", ") : String(val);
          tr.innerHTML = `<td class="attr-key" style="padding-left:${indent}px">${prettyAttributeName(
            key
          )}</td><td class="attr-value">${displayVal}</td>`;
          fragment.appendChild(tr);
        }
      });
    };

    addRows(props);
    tableEl.appendChild(fragment);
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

        const tableEl = this.popupEl.querySelector(".popup-attributes");
        const labelEl = this.popupEl.querySelector(".popup-label");
        labelEl.textContent = properties.name || "WAQI Station";
        tableEl.innerHTML = waqiHtml;

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

        const tableEl = this.popupEl.querySelector(".popup-attributes");
        const labelEl = this.popupEl.querySelector(".popup-label");
        labelEl.textContent = properties.name || "FFD Station";
        tableEl.innerHTML = ffdHtml;

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupFfdPopupEventHandlers();
        return;
      }

      if (sourceId?.startsWith("eonet_") || layerId?.includes("eonet_")) {
        const properties = { ...(eligible.properties || {}) };
        const eonetHtml = buildEonetPopupContent(properties);

        const tableEl = this.popupEl.querySelector(".popup-attributes");
        const labelEl = this.popupEl.querySelector(".popup-label");
        labelEl.textContent = properties.title || "NASA EONET Event";
        tableEl.innerHTML = eonetHtml;

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        return;
      }

      if (sourceId?.startsWith("usgs_") || layerId?.includes("usgs_")) {
        const properties = { ...(eligible.properties || {}) };
        const usgsHtml = buildUsgsPopupContent(properties);

        const tableEl = this.popupEl.querySelector(".popup-attributes");
        const labelEl = this.popupEl.querySelector(".popup-label");
        labelEl.textContent = properties.title || "USGS Earthquake";
        tableEl.innerHTML = usgsHtml;

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupUsgsPopupEventHandlers();
        return;
      }

      if (
        layerId?.includes("pmd_weather_stations") ||
        sourceId === "pmd_weather_stations-source"
      ) {
        const properties = { ...(eligible.properties || {}) };
        const { popupId, html } = buildPmdPopupContent(properties);

        const tableEl = this.popupEl.querySelector(".popup-attributes");
        const labelEl = this.popupEl.querySelector(".popup-label");
        labelEl.textContent = properties.name || "PMD Weather Station";
        tableEl.innerHTML = html;

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupPmdPopupEventHandlers(this);

        requestAnimationFrame(() => {
          const canvas = document.getElementById(`pmd-chart-canvas-${popupId}`);
          if (canvas) {
            createPmdChart(canvas, properties);
          }
        });
        return;
      }

      // GDACS SUPPORT
      if (this.#isGDACSLayer(layerId, sourceId)) {
        const properties = { ...(eligible.properties || {}) };
        const alertType = this.#getGDACSAlertType(layerId, sourceId);
        const eventName =
          properties.eventname || properties.name || "GDACS Event";
        const alertLevel = properties.alertlevel || "Unknown";

        let title = `${alertType}: ${eventName}`;
        if (alertLevel !== "Unknown") {
          title += ` (${alertLevel})`;
        }

        this.#setContent({ title, properties });
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
