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

// HTML-escape a value for safe injection into an innerHTML template.
// Kept local so nothing else in this module has to depend on an
// external helper.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// Map a numeric AQI reading onto a unified badge variant (EPA-aligned bands).
function waqiAqiBin(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return "neutral";
  if (n <= 50) return "aqi-good";
  if (n <= 100) return "aqi-moderate";
  if (n <= 150) return "aqi-usg";
  if (n <= 200) return "aqi-unhealthy";
  if (n <= 300) return "aqi-very-unhealthy";
  return "aqi-hazardous";
}

function buildWaqiPopupContent(props) {
  const popupUID = `waqi-${props.uid}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  const aqiVariant = waqiAqiBin(props.aqi);
  const stationDetailsHtml =
    props.uid !== undefined && props.uid !== null && props.uid >= 0
      ? `<a class="ncop-popup__link" href="https://aqicn.org/station/@${props.uid}/" target="_blank">Station Details</a>`
      : "";

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${props.name}</div>
        <div class="ncop-popup__subtitle">${props.continent || ""}${props.continent && props.time ? " · " : ""}${props.time || ""}</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${aqiVariant}">AQI ${props.aqi}</span>
    </div>
  `;

  const drawer = `
    <div id="popup-airquality-${popupUID}">
      <div class="ncop-popup__actions" style="border-top:none;padding:0 0 10px;background:transparent;">
        <button class="ncop-popup__button ncop-popup__button--primary aqi-infograph-inline-btn"
                data-waqi-uid="${props.uid}"
                data-popup-id="${popupUID}"
                data-expanded="false"
                data-loaded="false">Show Station Infograph</button>
        ${stationDetailsHtml}
      </div>
      <div id="aqi-inline-metrics-${popupUID}" class="ncop-popup__pills" style="display:none;">
        <button class="ncop-popup__pill aqi-inline-metric-btn" data-metric="pm25" data-popup-id="${popupUID}">PM2.5</button>
        <button class="ncop-popup__pill aqi-inline-metric-btn" data-metric="pm10" data-popup-id="${popupUID}">PM10</button>
        <button class="ncop-popup__pill aqi-inline-metric-btn" data-metric="co2" data-popup-id="${popupUID}">CO₂</button>
        <button class="ncop-popup__pill aqi-inline-metric-btn" data-metric="tvoc" data-popup-id="${popupUID}">TVOC</button>
        <button class="ncop-popup__pill aqi-inline-metric-btn" data-metric="met.t" data-popup-id="${popupUID}">Temp</button>
        <button class="ncop-popup__pill aqi-inline-metric-btn" data-metric="met.h" data-popup-id="${popupUID}">RH</button>
      </div>
      <div id="aqi-inline-chart-wrapper-${popupUID}" class="ncop-popup__chart" style="display:none;">
        <div id="aqi-inline-station-name-${popupUID}" class="ncop-popup__chart-title"></div>
        <div id="aqi-inline-updated-time-${popupUID}" class="ncop-popup__status-note" style="display:block;margin-bottom:4px;"></div>
        <canvas id="aqiInlineChart-${popupUID}" style="width:220px;height:140px;max-width:100%;"></canvas>
        <div id="aqi-inline-attrib-${popupUID}" class="ncop-popup__status-note" style="display:block;margin-top:4px;line-height:1.3;"></div>
      </div>
    </div>
  `;

  return { primary, drawer, drawerTitle: "Air Quality Details" };
}

// ========== END WAQI-SPECIFIC CODE ==========

// ========== FFD-SPECIFIC CONSTANTS & HELPERS ==========
const ffdChartInstances = {};
const pmdChartInstances = {};
const nwfcChartInstances = {};

/**
 * Normalise an FFD feature's `properties` from the GCOP-backend schema
 * (`gauges` is a JSON string, `discharge` is top-level, etc — see
 * GCOP_PMD_API_Integration.md §2.1) into the flat shape the popup
 * builder + chart renderer already consume.  Idempotent: if the
 * expected flat keys are already present (older schema), they win.
 */
function normalizeFfdProps(raw) {
  const p = { ...(raw || {}) };
  let gauges = [];
  if (Array.isArray(p.gauges)) {
    gauges = p.gauges;
  } else if (typeof p.gauges === "string" && p.gauges.trim().startsWith("[")) {
    try { gauges = JSON.parse(p.gauges); } catch { gauges = []; }
  }
  const findByType = (t) =>
    gauges.find((g) => String(g?.type || "").toUpperCase() === t) || {};
  const outflow = findByType("OUTFLOW");
  const inflow  = findByType("INFLOW");
  return {
    ...p,
    outflow_discharge: p.outflow_discharge ?? outflow.discharge ?? p.discharge ?? "n/a",
    outflow_trend:     p.outflow_trend     ?? outflow.trend     ?? "—",
    outflow_time:      p.outflow_time      ?? p.recording_time  ?? "—",
    inflow_discharge:  p.inflow_discharge  ?? inflow.discharge  ?? "n/a",
    inflow_trend:      p.inflow_trend      ?? inflow.trend      ?? "—",
  };
}

function buildFfdPopupContent(rawProps) {
  const props = normalizeFfdProps(rawProps);
  const popupId = `ffd-${props.name}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;
  const inflow = props.inflow_discharge !== "n/a" ? props.inflow_discharge : 0;

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${props.name}</div>
        <div class="ncop-popup__subtitle">${props.status || ""}</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--status-active">FFD</span>
    </div>
  `;

  const drawer = `
    <div class="ncop-popup__info" id="ffd-info-${popupId}">
      <p class="ncop-popup__info-row"><strong>Outflow:</strong> ${props.outflow_discharge} cusecs</p>
      <p class="ncop-popup__info-row"><strong>Inflow:</strong> ${inflow} cusecs</p>
      <p class="ncop-popup__info-row"><strong>Outflow Trend:</strong> ${props.outflow_trend}</p>
      <p class="ncop-popup__info-row"><strong>Inflow Trend:</strong> ${props.inflow_trend}</p>
      <p class="ncop-popup__info-row"><strong>Recording Time:</strong> ${props.recording_time}</p>
      <p class="ncop-popup__info-row"><strong>Outflow Time:</strong> ${props.outflow_time}</p>
    </div>
    <div class="ncop-popup__chart ffd-chart-container" id="ffd-chart-container-${popupId}" style="display:none;opacity:0;transition:opacity 0.5s ease-in-out;">
      <canvas id="ffd-chart-canvas-${popupId}" style="width:230px;height:150px;"></canvas>
      <div class="chart-legend ncop-popup__status-note" style="display:block;text-align:center;margin-top:6px;">
        <span>Outflow: ${props.outflow_discharge} cusecs (${props.outflow_trend})</span> | <span>Inflow: ${inflow} cusecs (${props.inflow_trend})</span>
      </div>
    </div>
    <div class="ncop-popup__actions">
      <button class="ncop-popup__button ncop-popup__button--primary show-ffd-graph"
              data-popup-id="${popupId}"
              data-station="${(props.name ?? "").toString().replace(/"/g, "&quot;")}"
              data-outflow="${props.outflow_discharge ?? ""}"
              data-inflow="${props.inflow_discharge ?? ""}"
              data-outflow-trend="${(props.outflow_trend ?? "").toString().replace(/"/g, "&quot;")}"
              data-inflow-trend="${(props.inflow_trend ?? "").toString().replace(/"/g, "&quot;")}">Show Graph</button>
    </div>
  `;

  return { primary, drawer, drawerTitle: "Flood Forecast Details" };
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

    // Values now live as data-* attributes on the button itself — set in
    // buildFfdPopupContent().  This replaces the fragile DOM walk that
    // parsed an old <table>/<div style="background:black"> layout and
    // threw a null-reference against the current paragraph-row popup.
    const stationName  = graphButton.dataset.station      || "Station";
    const rawOutflow   = graphButton.dataset.outflow      || "0";
    const rawInflow    = graphButton.dataset.inflow       || "0";
    const outflowTrend = graphButton.dataset.outflowTrend || "";
    const inflowTrend  = graphButton.dataset.inflowTrend  || "";
    // Discharge values arrive comma-formatted from GCOP (e.g. "49,500");
    // strip commas so parseFloat inside createFfdChart parses cleanly.
    const stripCommas = (v) => String(v).replace(/,/g, "");
    const outflow = rawOutflow === "n/a" ? "n/a" : stripCommas(rawOutflow);
    const inflow  = rawInflow  === "n/a" ? "n/a" : stripCommas(rawInflow);

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
  // null / undefined / "" → N/A (never lie with 0.0).  Only bona-fide
  // finite numbers get formatted.
  if (value == null || value === "") return "N/A";
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  return num.toFixed(digits);
}

function formatPMDDateTime(date, time) {
  if (!date && !time) return "N/A";
  return [date, time].filter(Boolean).join(" ");
}

// PMD Monitor warn_* fields are `null` or one of blue|yellow|orange|red.
// Render as a coloured pill row that gives the operator an at-a-glance
// summary of every channel-level advisory active at this station.
function renderPmdWarnBadges(props) {
  const channels = [
    { key: "warn_temp", label: "Temp" },
    { key: "warn_wind", label: "Wind" },
    { key: "warn_rain", label: "Rain" },
    { key: "warn_vis",  label: "Vis"  },
  ];
  const active = channels.filter((c) => {
    const v = props[c.key];
    return typeof v === "string" && v.length > 0;
  });
  if (!active.length) return "";
  const pills = active.map((c) => {
    const level = String(props[c.key]).toLowerCase();
    return `<span class="ncop-popup__warn-pill ncop-popup__warn-pill--${level}"
                  title="${c.label} advisory: ${level}">${c.label}</span>`;
  }).join("");
  return `<div class="ncop-popup__warn-strip">
            <span class="ncop-popup__warn-strip-label">Active Advisories</span>
            <div class="ncop-popup__warn-strip-pills">${pills}</div>
          </div>`;
}

function buildPmdPopupContent(props) {
  const popupId = `pmd-${String(props.name || "station")
    .replace(/\s+/g, "-")
    .toLowerCase()}-${Math.random().toString(36).slice(2, 9)}`;
  // Use raw rainfall for the "wet/dry" badge — null counts as dry.
  const rainfall = props.rainfall == null ? 0 : Number(props.rainfall) || 0;
  const rainfallState = rainfall > 0 ? "Rain observed" : "Dry conditions";
  const rainVariant   = rainfall > 0 ? "rain-wet" : "rain-dry";

  // Subtitle now surfaces the station code + type so operators can
  // cross-reference against PMD's raw feeds (§3.1 gives us both).
  const code = props.code ? escapeHtml(String(props.code)) : "";
  const stationType = props.station_type
    ? escapeHtml(String(props.station_type).toUpperCase())
    : "";
  const subtitleBits = ["Pakistan Meteorological Department"];
  if (code || stationType) {
    subtitleBits.push([code, stationType].filter(Boolean).join(" · "));
  }
  const subtitle = subtitleBits.join(" • ");

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${escapeHtml(props.name || "PMD Station")}</div>
        <div class="ncop-popup__subtitle">${subtitle}</div>
      </div>
      <div class="ncop-popup__header-aside">
        <span class="ncop-popup__badge ncop-popup__badge--${rainVariant}">${rainfallState}</span>
      </div>
    </div>
  `;

  const drawer = `
    ${renderPmdWarnBadges(props)}
    <div class="ncop-popup__grid">
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Temperature</div><div class="ncop-popup__card-value">${formatPMDValue(props.temperature)} °C</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Rain 24h</div><div class="ncop-popup__card-value">${formatPMDValue(props.rainfall ?? props.rain_24h)} mm</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Humidity</div><div class="ncop-popup__card-value">${formatPMDValue(props.humidity)} %</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Wind</div><div class="ncop-popup__card-value">${formatPMDValue(props.windSpeed)} kt</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Visibility</div><div class="ncop-popup__card-value">${formatPMDValue(props.visibility)} km</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Pressure</div><div class="ncop-popup__card-value">${formatPMDValue(props.pressure, 0)} hPa</div></div>
    </div>
    <div class="ncop-popup__chart">
      <div class="ncop-popup__chart-title">Station Metrics</div>
      <canvas id="pmd-chart-canvas-${popupId}" style="width:280px;height:190px;max-width:100%;"></canvas>
    </div>
    <div class="ncop-popup__info">
      <p class="ncop-popup__info-row"><strong>Rain (1h):</strong> ${formatPMDValue(props.rain_1h)} mm</p>
      <p class="ncop-popup__info-row"><strong>Rain (6h):</strong> ${formatPMDValue(props.rain_6h)} mm</p>
      <p class="ncop-popup__info-row"><strong>Wind Direction:</strong> ${formatPMDValue(props.windDirection, 0)}°</p>
      <p class="ncop-popup__info-row"><strong>Dew Point:</strong> ${formatPMDValue(props.dewPoint)} °C</p>
      <p class="ncop-popup__info-row"><strong>Observed:</strong> ${formatPMDDateTime(props.temp_date, props.temp_time)}</p>
    </div>
  `;

  return { popupId, primary, drawer, drawerTitle: "Weather Details" };
}

// ---------------------------------------------------------------------------
// PMD City 12-Step Forecast popup
// ---------------------------------------------------------------------------
// §3.7 of the integration doc: each feature has a `fc` field which is a
// JSON *string* — parse it before rendering.  Each step is shaped:
//   { ft, tem, tmax, tmin, rhu, wspd, wdir, wdesc, pre, pre24, prs,
//     vis, tcc, wx }
// (see MD).  Fields with the 9999.0 / 999.0 sentinel value mean "no
// data" per MD §1.2 and are rendered as "—".

const FC_SENTINELS = new Set([9999, -9999, 999, -999]);

function parsePmdForecastSteps(fc) {
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

function formatFcCell(v, digits = 1) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (FC_SENTINELS.has(n)) return "—"; // upstream "no data" sentinel
  return n.toFixed(digits);
}

function buildPmdForecastStepsTable(steps) {
  const body = steps.map((s) => `
    <tr>
      <td class="ncop-popup__fc-time">${escapeHtml(s?.ft ?? "")}</td>
      <td>${formatFcCell(s?.tem)}</td>
      <td>${escapeHtml(String(s?.wx ?? ""))}</td>
      <td>${formatFcCell(s?.rhu, 0)}</td>
      <td>${formatFcCell(s?.wspd)}</td>
      <td>${escapeHtml(String(s?.wdir ?? ""))}</td>
      <td>${formatFcCell(s?.pre)}</td>
    </tr>
  `).join("");
  return `
    <table class="ncop-popup__fc-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>T °C</th>
          <th>Wx</th>
          <th>RH %</th>
          <th>Wind m/s</th>
          <th>Dir</th>
          <th>Precip mm</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function buildPmdCityForecastPopupContent(props) {
  const city = props.name || props.city || "City";
  const steps = parsePmdForecastSteps(props.fc);

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${escapeHtml(String(city))}</div>
        <div class="ncop-popup__subtitle">${escapeHtml(String(props.weather ?? "PMD Monitor · City Forecast"))}</div>
      </div>
      <div class="ncop-popup__header-aside">
        <span class="ncop-popup__badge ncop-popup__badge--status-active">
          ${steps.length}-step
        </span>
      </div>
    </div>
  `;

  const currentGrid = `
    <div class="ncop-popup__grid">
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Now</div><div class="ncop-popup__card-value">${formatPMDValue(props.temp)} °C</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Max / Min</div><div class="ncop-popup__card-value">${formatPMDValue(props.temp_max, 0)} / ${formatPMDValue(props.temp_min, 0)} °C</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">RH</div><div class="ncop-popup__card-value">${formatPMDValue(props.humidity, 0)} %</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Wind</div><div class="ncop-popup__card-value">${formatPMDValue(props.wind_speed)} m/s ${escapeHtml(String(props.wind_dir ?? ""))}</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Pressure</div><div class="ncop-popup__card-value">${formatPMDValue(props.pressure, 0)} hPa</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Visibility</div><div class="ncop-popup__card-value">${formatPMDValue(props.visibility)} km</div></div>
    </div>
  `;

  const forecastBlock = steps.length ? `
    <div class="ncop-popup__fc-title">${steps.length}-Step Forecast</div>
    <div class="ncop-popup__fc-scroll">
      ${buildPmdForecastStepsTable(steps)}
    </div>
  ` : `<p class="ncop-popup__fc-empty">No forecast steps available.</p>`;

  const drawer = currentGrid + forecastBlock;

  return { primary, drawer, drawerTitle: "City Forecast Details" };
}

// ---------------------------------------------------------------------------
// NWFC Observations popup — sleek dashboard-style layout + Chart.js
// live-metrics bar chart.  Consumes the properties surfaced by
// `/api/pmd/nwfc/observations/` (temperature / humidity / pressure /
// wind_speed / wind_direction / rain_3h / rain_24h / weather /
// sea_level_pressure / obs_time / max_temperature).
// ---------------------------------------------------------------------------

// Emoji lookup for the NWFC weather description — same ladder the
// map's icon dispatcher uses, kept local so this popup module doesn't
// have to import from map-icons.js.
function nwfcWeatherEmoji(text) {
  if (text == null) return "🌡️";
  const s = String(text).toLowerCase().trim();
  if (!s) return "🌡️";
  if (/thunder|lightning/.test(s))          return "⛈️";
  if (/drizzle/.test(s))                    return "🌦️";
  if (/shower|rain/.test(s))                return "🌧️";
  if (/snow|blizzard|sleet|hail/.test(s))   return "❄️";
  if (/fog|mist|haze/.test(s))              return "🌫️";
  if (/dust|sandstorm/.test(s))             return "🌪️";
  if (/partl?y.*cloud|part.*cloud/.test(s)) return "⛅";
  if (/overcast/.test(s))                   return "☁️";
  if (/cloud/.test(s))                      return "🌥️";
  if (/gust|wind/.test(s))                  return "💨";
  if (/clear|sunny|fair|dry|bright/.test(s)) return "☀️";
  return "🌡️";
}

// ---------------------------------------------------------------------------
// IPC / Food Security popup — one function covers every ipc_<country>
// layer because they all share the same feature schema.
// ---------------------------------------------------------------------------
// The raw IPC response is 33 fields long, most of them internal / UI-
// hint metadata that would just clutter a generic key-value dump.  This
// builder keeps ONLY the operationally useful ones and lays them out in
// a header + phase-breakdown table shape:
//   * Header  = area title + phase badge (colour tracks the IPC ramp)
//   * Summary = classified population + prolonged-crisis flag +
//               confidence level
//   * Table   = one row per IPC phase (1–5) with its colour swatch,
//               population, and % share — the phase whose colour
//               matches the header badge is highlighted so it stands
//               out at a glance.
//   * Footer  = analysis id + IPC period + justification (if present)
// ---------------------------------------------------------------------------
const IPC_PHASE_LABELS = {
  1: "Minimal",
  2: "Stressed",
  3: "Crisis",
  4: "Emergency",
  5: "Catastrophe / Famine",
};
// Baseline hex ramp — used when a feature lacks the API's baked-in
// phase-N colour (rare, but safest to have a fallback).
const IPC_PHASE_COLORS = {
  1: "#CDFACD",
  2: "#FAE61E",
  3: "#E67800",
  4: "#C80100",
  5: "#640000",
};

function _ipcFormatPopulation(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toLocaleString();
}
function _ipcFormatPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  // API returns 0.35 for 35 %.
  return `${(n * 100).toFixed(0)}%`;
}
// Pick a text colour that reads on the swatch — light phases (1, 2)
// need dark text; darker phases (3, 4, 5) need white.
function _ipcTextOn(phase) {
  return phase >= 3 ? "#ffffff" : "#1a1a1a";
}

function buildIpcPopupContent(props) {
  const title    = String(props.title || "IPC Area");
  const phase    = Number(props.overall_phase) || 0;
  const phaseLbl = IPC_PHASE_LABELS[phase] || "Unclassified";
  const badgeBg  = props.color || IPC_PHASE_COLORS[phase] || "#cccccc";
  const badgeFg  = _ipcTextOn(phase);
  const analysisId = props.anl_id ? String(props.anl_id) : "";

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${escapeHtml(title)}</div>
        <div class="ncop-popup__subtitle">IPC Acute Food Insecurity${analysisId ? ` &middot; Analysis ${escapeHtml(analysisId)}` : ""}</div>
      </div>
      <div class="ncop-popup__header-aside">
        <span class="ncop-popup__badge ncop-popup__badge--ipc"
              style="background:${escapeHtml(badgeBg)};color:${badgeFg};border-color:${escapeHtml(badgeBg)}">
          Phase ${phase || "—"} &middot; ${escapeHtml(phaseLbl)}
        </span>
      </div>
    </div>
  `;

  // Top summary tiles — the three numbers that matter operationally.
  // `population_min` is IPC's shorthand for the population in the
  // "phase equal to or worse than the overall phase" bucket (the
  // headline number in most IPC bulletins).
  const totalPop      = _ipcFormatPopulation(props.estimated_population);
  const classifiedPop = _ipcFormatPopulation(props.population_min);
  const prolonged     = props.prolonged_crisis === true
    ? `<span class="ipc-popup__flag ipc-popup__flag--warn">Yes</span>`
    : `<span class="ipc-popup__flag">No</span>`;
  const confidence    = props.confidence_level != null
    ? `${escapeHtml(String(props.confidence_level))} / 3`
    : "—";

  // Phase-breakdown table — one row per IPC phase with a colour swatch
  // pulled from the API's baked-in phase-N-colour field (falls back to
  // the baseline ramp above).  Row for the current overall_phase gets
  // an is-active class so it stands out.
  const phaseRows = [1, 2, 3, 4, 5].map((p) => {
    const pop     = props[`phase${p}_population`];
    const pct     = props[`phase${p}_percent`];
    const color   = props[`phase${p}_color`] || IPC_PHASE_COLORS[p];
    const isCur   = p === phase;
    return `
      <tr class="ipc-popup__phase-row${isCur ? " is-active" : ""}">
        <td class="ipc-popup__swatch-cell">
          <span class="ipc-popup__swatch" style="background:${escapeHtml(color)}"></span>
        </td>
        <td class="ipc-popup__phase-cell">
          <span class="ipc-popup__phase-num">Phase ${p}</span>
          <span class="ipc-popup__phase-lbl">${escapeHtml(IPC_PHASE_LABELS[p])}</span>
        </td>
        <td class="ipc-popup__pop-cell">${_ipcFormatPopulation(pop)}</td>
        <td class="ipc-popup__pct-cell">${_ipcFormatPercent(pct)}</td>
      </tr>
    `;
  }).join("");

  const justification = props.justification && String(props.justification).trim()
    ? `<p class="ipc-popup__justification">
         <strong>Justification:</strong> ${escapeHtml(String(props.justification))}
       </p>`
    : "";

  const drawer = `
    <div class="ncop-popup__grid ipc-popup__summary">
      <div class="ncop-popup__card">
        <div class="ncop-popup__card-label">Total Population</div>
        <div class="ncop-popup__card-value">${totalPop}</div>
      </div>
      <div class="ncop-popup__card">
        <div class="ncop-popup__card-label">In Phase ${phase || "—"}+</div>
        <div class="ncop-popup__card-value">${classifiedPop}</div>
      </div>
      <div class="ncop-popup__card">
        <div class="ncop-popup__card-label">Prolonged Crisis</div>
        <div class="ncop-popup__card-value">${prolonged}</div>
      </div>
      <div class="ncop-popup__card">
        <div class="ncop-popup__card-label">Confidence</div>
        <div class="ncop-popup__card-value">${confidence}</div>
      </div>
    </div>

    <div class="ipc-popup__breakdown">
      <div class="ipc-popup__breakdown-title">Population by IPC Phase</div>
      <table class="ipc-popup__phase-table">
        <thead>
          <tr>
            <th></th>
            <th>Phase</th>
            <th class="ipc-popup__pop-cell">Population</th>
            <th class="ipc-popup__pct-cell">Share</th>
          </tr>
        </thead>
        <tbody>${phaseRows}</tbody>
      </table>
    </div>

    ${justification}

    <div class="ncop-popup__info ipc-popup__meta">
      <p class="ncop-popup__info-row">
        <strong>Reading:</strong>
        The polygon covers the ${escapeHtml(title)} classification area.
        Colour = current overall phase (${escapeHtml(String(phase || "—"))}); the
        table above shows how the population is distributed across every
        IPC phase, not just the overall one.
      </p>
      ${props.ipc_period
        ? `<p class="ncop-popup__info-row"><strong>IPC Period:</strong> ${escapeHtml(String(props.ipc_period))}${
            props.ipc_period === "C" ? " (Current)"
            : props.ipc_period === "P" ? " (Projected — first period)"
            : props.ipc_period === "S" ? " (Projected — second period)"
            : ""}</p>`
        : ""}
    </div>

    <button type="button" class="ipc-open-stats"
        data-country="${escapeHtml(String(props._ipcCountry || ""))}"
        data-title="${escapeHtml(title)}"
        data-phase="${escapeHtml(String(phase))}"
        data-phase-label="${escapeHtml(phaseLbl)}"
        data-color="${escapeHtml(String(badgeBg))}"
        data-anl-id="${escapeHtml(String(props.anl_id || ""))}"
        data-total-pop="${escapeHtml(String(props.estimated_population || ""))}"
        data-classified-pop="${escapeHtml(String(props.population_min || ""))}"
        data-confidence="${escapeHtml(String(props.confidence_level || ""))}"
        data-prolonged="${props.prolonged_crisis === true ? "true" : "false"}"
        data-phase1-pop="${escapeHtml(String(props.phase1_population || 0))}"
        data-phase2-pop="${escapeHtml(String(props.phase2_population || 0))}"
        data-phase3-pop="${escapeHtml(String(props.phase3_population || 0))}"
        data-phase4-pop="${escapeHtml(String(props.phase4_population || 0))}"
        data-phase5-pop="${escapeHtml(String(props.phase5_population || 0))}"
        data-phase1-pct="${escapeHtml(String(props.phase1_percent || 0))}"
        data-phase2-pct="${escapeHtml(String(props.phase2_percent || 0))}"
        data-phase3-pct="${escapeHtml(String(props.phase3_percent || 0))}"
        data-phase4-pct="${escapeHtml(String(props.phase4_percent || 0))}"
        data-phase5-pct="${escapeHtml(String(props.phase5_percent || 0))}">
      Open Food Security Panel
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7"/></svg>
    </button>
  `;

  return { primary, drawer, drawerTitle: "Food-Security Breakdown" };
}

// ==========================================================================
//  IPC / Food Security Stats Modal (dedicated draggable + resizable panel)
// --------------------------------------------------------------------------
//  Mirrors the heatwave-modal pattern but is IPC-specific:
//    * Header  — area name, country kicker, phase badge, close button
//    * Left    — per-area stat tiles (total pop / in-phase-N+ / prolonged /
//                confidence + full phase 1-5 breakdown mirroring the popup)
//    * Right   — three tabs backed by Chart.js:
//                  1. Phase Breakdown  — bar chart of THIS area's phase-N pop
//                  2. Country Overview — bar chart of ALL districts in this
//                     country aggregated by phase (pulled from the /api/ipc/
//                     backend cache — no extra IPC hit if the map already
//                     loaded that country)
//                  3. Analysis Info    — resolved analysis ID + refresh info
//  Zero coupling to the heatwave modal.  Own drag/resize helper (~90 lines)
//  so heatwave code stays untouched.
//  Data source: the button carries every needed field on data-* attrs;
//  the country tab additionally reads window fetch of the cached backend
//  response (per-country, cached 6 h server-side by IpcFoodSecurityAPIView).
// ==========================================================================

const IPC_MODAL_ID = "ipc-stats-modal";
const IPC_MODAL_INSTANCE_KEY = "ipc-modal-chart";
const ipcChartInstances = {};
let _ipcCountryAggCache = new Map();  // country slug → { phase1..5 totals }
let _ipcHistoryCache    = new Map();  // country slug → { analyses: [...] }

function ensureIpcModal() {
  let modal = document.getElementById(IPC_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = IPC_MODAL_ID;
  modal.className = "ipc-modal hidden";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Food Security Stats");
  modal.innerHTML = `
    <div class="ipc-modal__head" data-ipc-drag>
      <div class="ipc-modal__drag-grip" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <div class="ipc-modal__title-block">
        <div class="ipc-modal__kicker" id="ipc-modal-kicker">Food Security · IPC / CH</div>
        <div class="ipc-modal__title" id="ipc-modal-name">—</div>
        <div class="ipc-modal__subtitle" id="ipc-modal-meta"></div>
      </div>
      <span class="ipc-modal__badge" id="ipc-modal-badge">—</span>
      <button type="button" class="ipc-modal__close" aria-label="Close" data-ipc-close>×</button>
    </div>

    <div class="ipc-modal__body">
      <aside class="ipc-modal__left">
        <div class="ipc-modal__stats" id="ipc-modal-stats"></div>
        <div class="ipc-modal__legend">
          <div class="ipc-modal__legend-title">IPC Phase Ramp</div>
          <div class="ipc-modal__legend-row"><span class="ipc-modal__legend-sw" style="background:#CDFACD"></span><span>1 — Minimal</span></div>
          <div class="ipc-modal__legend-row"><span class="ipc-modal__legend-sw" style="background:#FAE61E"></span><span>2 — Stressed</span></div>
          <div class="ipc-modal__legend-row"><span class="ipc-modal__legend-sw" style="background:#E67800"></span><span>3 — Crisis</span></div>
          <div class="ipc-modal__legend-row"><span class="ipc-modal__legend-sw" style="background:#C80100"></span><span>4 — Emergency</span></div>
          <div class="ipc-modal__legend-row"><span class="ipc-modal__legend-sw" style="background:#640000"></span><span>5 — Catastrophe</span></div>
        </div>
      </aside>
      <section class="ipc-modal__right">
        <div class="ipc-modal__tabs" role="tablist">
          <button class="ipc-modal__tab is-active" data-mode="area" type="button">Phase Breakdown</button>
          <button class="ipc-modal__tab"           data-mode="country" type="button">Country Overview</button>
          <button class="ipc-modal__tab"           data-mode="history" type="button">Historical Trend</button>
          <button class="ipc-modal__tab"           data-mode="info" type="button">Analysis Info</button>
        </div>
        <div class="ipc-modal__chart-wrap">
          <div class="ipc-modal__chart-head">
            <div class="ipc-modal__chart-title" id="ipc-modal-title">Phase Breakdown</div>
            <div class="ipc-modal__chart-sub" id="ipc-modal-sub">Population distribution by IPC phase for the selected area</div>
          </div>
          <div class="ipc-modal__canvas-host">
            <canvas id="ipc-modal-canvas"></canvas>
            <div class="ipc-modal__info-body" id="ipc-modal-info-body" style="display:none;"></div>
            <div class="ipc-modal__loader" id="ipc-modal-loader" style="display:none;"><span></span><span></span><span></span></div>
          </div>
          <div class="ipc-modal__footnote">Data: IPC Info public API — resolved via NCOP proxy (/api/ipc/&lt;country&gt;/), cached 6 h server-side.</div>
        </div>
      </section>
    </div>

    <div class="ipc-modal__resize" data-ipc-resize aria-label="Resize">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M14 6 L6 14 M14 10 L10 14" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      </svg>
    </div>
  `;
  document.body.appendChild(modal);

  // Close button
  modal.querySelector("[data-ipc-close]")?.addEventListener("click", () => {
    modal.classList.remove("is-open");
    modal.classList.add("hidden");
    if (ipcChartInstances[IPC_MODAL_INSTANCE_KEY]) {
      try { ipcChartInstances[IPC_MODAL_INSTANCE_KEY].destroy(); } catch (_) {}
      delete ipcChartInstances[IPC_MODAL_INSTANCE_KEY];
    }
  });

  // Tab click delegation
  modal.querySelectorAll(".ipc-modal__tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode");
      modal.querySelectorAll(".ipc-modal__tab").forEach((t) =>
        t.classList.toggle("is-active", t === btn));
      _renderIpcModalTab(modal, mode);
    });
  });

  _attachIpcDragAndResize(modal);
  return modal;
}

// Own drag/resize — self-contained duplicate of the heatwave pattern so
// heatwave code stays untouched.  Pinning to viewport pixels on first
// interaction lets subsequent drags/resizes stay sticky regardless of
// the CSS defaults from the initial open.
function _attachIpcDragAndResize(modal) {
  const drag   = modal.querySelector("[data-ipc-drag]");
  const resize = modal.querySelector("[data-ipc-resize]");

  const pinToPixels = () => {
    const r = modal.getBoundingClientRect();
    modal.style.left = `${Math.round(r.left)}px`;
    modal.style.top  = `${Math.round(r.top)}px`;
    modal.style.right = "auto";
    modal.style.bottom = "auto";
    modal.style.width  = `${Math.round(r.width)}px`;
    modal.style.height = `${Math.round(r.height)}px`;
  };

  if (drag) {
    drag.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-ipc-close]")) return;
      if (e.button !== undefined && e.button !== 0) return;
      pinToPixels();
      const sx = e.clientX, sy = e.clientY;
      const sl = parseFloat(modal.style.left) || 0;
      const st = parseFloat(modal.style.top)  || 0;
      modal.classList.add("is-dragging");
      try { drag.setPointerCapture(e.pointerId); } catch (_) {}
      const onMove = (ev) => {
        const m = 8;
        const w = modal.offsetWidth, h = modal.offsetHeight;
        let nl = sl + (ev.clientX - sx);
        let nt = st + (ev.clientY - sy);
        nl = Math.max(m, Math.min(window.innerWidth  - w - m, nl));
        nt = Math.max(m, Math.min(window.innerHeight - h - m, nt));
        modal.style.left = `${Math.round(nl)}px`;
        modal.style.top  = `${Math.round(nt)}px`;
      };
      const onUp = () => {
        modal.classList.remove("is-dragging");
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

  if (resize) {
    const minW = 560, minH = 320;
    resize.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      pinToPixels();
      const sx = e.clientX, sy = e.clientY;
      const sw = modal.offsetWidth, sh = modal.offsetHeight;
      const sl = parseFloat(modal.style.left) || 0;
      const st = parseFloat(modal.style.top)  || 0;
      modal.classList.add("is-resizing");
      try { resize.setPointerCapture(e.pointerId); } catch (_) {}
      const onMove = (ev) => {
        const m = 8;
        const maxW = window.innerWidth  - sl - m;
        const maxH = window.innerHeight - st - m;
        const w = Math.max(minW, Math.min(maxW, sw + (ev.clientX - sx)));
        const h = Math.max(minH, Math.min(maxH, sh + (ev.clientY - sy)));
        modal.style.width  = `${Math.round(w)}px`;
        modal.style.height = `${Math.round(h)}px`;
      };
      const onUp = () => {
        modal.classList.remove("is-resizing");
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

// Entry point — called from the click handler with the button's data-* set.
async function showIpcModalForArea(ctx) {
  const modal = ensureIpcModal();
  modal._ipcCtx = ctx;

  // Header
  const badgeBg = ctx.color || "#cccccc";
  const badgeFg = ctx.phase >= 3 ? "#ffffff" : "#1a1a1a";
  modal.querySelector("#ipc-modal-name").textContent    = ctx.title || "IPC Area";
  modal.querySelector("#ipc-modal-meta").textContent    =
    `${_ipcCountryLabel(ctx.country)}${ctx.anlId ? ` · Analysis ${ctx.anlId}` : ""}`;
  const badge = modal.querySelector("#ipc-modal-badge");
  badge.textContent = `Phase ${ctx.phase || "—"} · ${ctx.phaseLabel || "Unclassified"}`;
  badge.style.background   = badgeBg;
  badge.style.color        = badgeFg;
  badge.style.borderColor  = badgeBg;

  // Left column stats
  const total    = Number(ctx.totalPop) || 0;
  const classif  = Number(ctx.classifiedPop) || 0;
  const conf     = ctx.confidence || "—";
  const prol     = ctx.prolonged === "true"
    ? `<span class="ipc-modal__flag ipc-modal__flag--warn">Yes</span>`
    : `<span class="ipc-modal__flag">No</span>`;
  modal.querySelector("#ipc-modal-stats").innerHTML = `
    <div class="ipc-modal__stat"><div class="ipc-modal__stat-label">Total Pop.</div><div class="ipc-modal__stat-value">${total ? total.toLocaleString() : "—"}</div></div>
    <div class="ipc-modal__stat"><div class="ipc-modal__stat-label">In Phase ${ctx.phase || "—"}+</div><div class="ipc-modal__stat-value" style="color:${badgeBg}">${classif ? classif.toLocaleString() : "—"}</div></div>
    <div class="ipc-modal__stat"><div class="ipc-modal__stat-label">Prolonged Crisis</div><div class="ipc-modal__stat-value">${prol}</div></div>
    <div class="ipc-modal__stat"><div class="ipc-modal__stat-label">Confidence</div><div class="ipc-modal__stat-value">${conf}/3</div></div>
  `;

  // Reveal + default tab
  modal.classList.remove("hidden");
  requestAnimationFrame(() => modal.classList.add("is-open"));
  _renderIpcModalTab(modal, "area");
}

function _ipcCountryLabel(slug) {
  switch (slug) {
    case "pakistan":    return "Pakistan";
    case "afghanistan": return "Afghanistan";
    case "bangladesh":  return "Bangladesh";
    default:            return slug || "";
  }
}

function _renderIpcModalTab(modal, mode) {
  const ctx = modal._ipcCtx || {};
  const titleEl  = modal.querySelector("#ipc-modal-title");
  const subEl    = modal.querySelector("#ipc-modal-sub");
  const canvas   = modal.querySelector("#ipc-modal-canvas");
  const infoBody = modal.querySelector("#ipc-modal-info-body");
  const loader   = modal.querySelector("#ipc-modal-loader");

  // Kill any prior chart before rebuilding.
  if (ipcChartInstances[IPC_MODAL_INSTANCE_KEY]) {
    try { ipcChartInstances[IPC_MODAL_INSTANCE_KEY].destroy(); } catch (_) {}
    delete ipcChartInstances[IPC_MODAL_INSTANCE_KEY];
  }

  if (mode === "area") {
    titleEl.textContent = "Phase Breakdown";
    subEl.textContent   = `Population by IPC phase — ${ctx.title || "selected area"}`;
    canvas.style.display = "block";
    infoBody.style.display = "none";
    _drawIpcBarChart(canvas, _extractPhasePops(ctx), ctx.title || "Area");
  } else if (mode === "country") {
    titleEl.textContent = `Country Overview — ${_ipcCountryLabel(ctx.country)}`;
    subEl.textContent   = "Aggregate population by phase across every classified area in the country";
    canvas.style.display = "block";
    infoBody.style.display = "none";
    loader.style.display = "flex";
    _loadCountryAggregate(ctx.country).then((agg) => {
      loader.style.display = "none";
      if (!agg) {
        canvas.style.display = "none";
        infoBody.style.display = "block";
        infoBody.innerHTML = `<div class="ipc-modal__error">Could not load country data. Try again in a moment.</div>`;
        return;
      }
      _drawIpcBarChart(canvas, agg, _ipcCountryLabel(ctx.country));
    });
  } else if (mode === "history") {
    titleEl.textContent = `Historical Trend — ${_ipcCountryLabel(ctx.country)}`;
    subEl.textContent   =
      "Population by IPC phase across every published analysis cycle — data from IPC's Population Tracking Tool";
    canvas.style.display = "block";
    infoBody.style.display = "none";
    loader.style.display = "flex";
    _loadIpcHistory(ctx.country).then((analyses) => {
      loader.style.display = "none";
      if (!analyses || !analyses.length) {
        canvas.style.display = "none";
        infoBody.style.display = "block";
        infoBody.innerHTML = `<div class="ipc-modal__error">No historical analyses available for ${escapeHtml(_ipcCountryLabel(ctx.country))}. Try again later.</div>`;
        return;
      }
      _drawIpcHistoryChart(canvas, analyses);
    });
  } else if (mode === "info") {
    titleEl.textContent = "Analysis Info";
    subEl.textContent   = "Metadata for the currently-loaded IPC analysis";
    canvas.style.display = "none";
    infoBody.style.display = "block";
    infoBody.innerHTML = `
      <dl class="ipc-modal__meta-dl">
        <dt>Area</dt><dd>${escapeHtml(ctx.title || "—")}</dd>
        <dt>Country</dt><dd>${escapeHtml(_ipcCountryLabel(ctx.country) || "—")}</dd>
        <dt>Current Phase</dt><dd>Phase ${escapeHtml(String(ctx.phase || "—"))} · ${escapeHtml(ctx.phaseLabel || "—")}</dd>
        <dt>Analysis ID</dt><dd>${escapeHtml(ctx.anlId || "—")}</dd>
        <dt>Total Population</dt><dd>${(Number(ctx.totalPop) || 0).toLocaleString() || "—"}</dd>
        <dt>Confidence</dt><dd>${escapeHtml(ctx.confidence || "—")} / 3</dd>
        <dt>Prolonged Crisis</dt><dd>${ctx.prolonged === "true" ? "Yes" : "No"}</dd>
        <dt>Source</dt><dd>IPC Info public API — resolved server-side; cached 6 h.</dd>
        <dt>Colour Ramp</dt><dd>Official IPC/CH global 5-phase scale.</dd>
        <dt>Notes</dt><dd>The proxy walks up to 6 recent analyses to find one with polygon geometry — projections without maps are skipped automatically.</dd>
      </dl>
    `;
  }
}

function _extractPhasePops(ctx) {
  return [1, 2, 3, 4, 5].map((p) => ({
    phase: p,
    pop: Number(ctx[`phase${p}Pop`]) || 0,
    pct: Number(ctx[`phase${p}Pct`]) || 0,
  }));
}

async function _loadCountryAggregate(country) {
  if (!country) return null;
  if (_ipcCountryAggCache.has(country)) return _ipcCountryAggCache.get(country);
  try {
    const r = await fetch(`${window.location.origin}/api/ipc/${country}/`, {
      credentials: "same-origin",
    });
    if (!r.ok) return null;
    const data = await r.json();
    const feats = (data && data.features) || [];
    const sums = [1, 2, 3, 4, 5].map((p) => ({ phase: p, pop: 0, pct: 0 }));
    let totalPop = 0;
    for (const f of feats) {
      const p = f.properties || {};
      for (const b of sums) {
        b.pop += Number(p[`phase${b.phase}_population`]) || 0;
      }
      totalPop += Number(p.estimated_population) || 0;
    }
    if (totalPop > 0) {
      for (const b of sums) b.pct = b.pop / totalPop;
    }
    _ipcCountryAggCache.set(country, sums);
    return sums;
  } catch (e) {
    console.warn("[IPC modal] country aggregate load failed:", e);
    return null;
  }
}

async function _loadIpcHistory(country) {
  if (!country) return null;
  if (_ipcHistoryCache.has(country)) return _ipcHistoryCache.get(country);
  try {
    const r = await fetch(`${window.location.origin}/api/ipc/${country}/history/`, {
      credentials: "same-origin",
    });
    if (!r.ok) return null;
    const data = await r.json();
    const analyses = (data && data.analyses) || [];
    _ipcHistoryCache.set(country, analyses);
    return analyses;
  } catch (e) {
    console.warn("[IPC modal] history load failed:", e);
    return null;
  }
}

// Stacked bar chart — one bar per analysis cycle (chronological), each
// bar stacked into the 5 IPC phases with the official IPC hex ramp.
// Y-axis auto-formats to millions/thousands so long timelines stay
// readable.
function _drawIpcHistoryChart(canvas, analyses) {
  const colors = ["#CDFACD", "#FAE61E", "#E67800", "#C80100", "#640000"];
  const labels = analyses.map((a) => a.date || a.anl_id || "?");
  const buildSet = (phase) => ({
    label: `Phase ${phase}`,
    data: analyses.map((a) => Number(a[`phase${phase}_pop`]) || 0),
    backgroundColor: colors[phase - 1],
    borderColor: colors[phase - 1],
    borderWidth: 0.5,
    stack: "ipc",
  });
  ipcChartInstances[IPC_MODAL_INSTANCE_KEY] = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [buildSet(1), buildSet(2), buildSet(3), buildSet(4), buildSet(5)],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: getComputedStyle(document.documentElement).getPropertyValue("--popup-text") || "#e5eef7",
            boxWidth: 10,
            boxHeight: 10,
            font: { size: 11 },
            padding: 8,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              const a = analyses[i];
              return `${a.date || "—"} · ${a.title || a.anl_id || ""}`;
            },
            label: (item) => {
              const v = Number(item.raw) || 0;
              const pct = analyses[item.dataIndex]?.[`phase${item.datasetIndex + 1}_pct`];
              const pctStr = pct ? ` (${(pct * 100).toFixed(1)}%)` : "";
              return `${item.dataset.label}: ${v.toLocaleString()}${pctStr}`;
            },
            footer: (items) => {
              const a = analyses[items[0].dataIndex];
              const total = Number(a?.analyzed_pop) || 0;
              const p3 = Number(a?.phase3plus_pop) || 0;
              const pct = total ? ` (${((p3 / total) * 100).toFixed(1)}%)` : "";
              return total
                ? `Analyzed: ${total.toLocaleString()}   |   Phase 3+: ${p3.toLocaleString()}${pct}`
                : "";
            },
          },
        },
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: {
            color: getComputedStyle(document.documentElement).getPropertyValue("--popup-text-muted") || "rgba(203,213,225,0.72)",
            font: { size: 10 },
            maxRotation: 45,
            minRotation: 0,
          },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: "rgba(148, 163, 184, 0.18)" },
          ticks: {
            color: getComputedStyle(document.documentElement).getPropertyValue("--popup-text-muted") || "rgba(203,213,225,0.72)",
            callback: (v) => {
              if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
              if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}k`;
              return v;
            },
          },
        },
      },
    },
  });
}

function _drawIpcBarChart(canvas, phaseData, label) {
  const colors = ["#CDFACD", "#FAE61E", "#E67800", "#C80100", "#640000"];
  const textColors = ["#1a1a1a", "#1a1a1a", "#ffffff", "#ffffff", "#ffffff"];
  ipcChartInstances[IPC_MODAL_INSTANCE_KEY] = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: phaseData.map((d) => `Phase ${d.phase}`),
      datasets: [{
        label: `${label} — population`,
        data: phaseData.map((d) => d.pop),
        backgroundColor: colors,
        borderColor: colors.map((c) => c),
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const d = phaseData[item.dataIndex];
              const pct = d.pct ? ` (${(d.pct * 100).toFixed(1)}%)` : "";
              return `${d.pop.toLocaleString()} people${pct}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: getComputedStyle(document.documentElement).getPropertyValue("--popup-text") || "#e5eef7" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(148, 163, 184, 0.18)" },
          ticks: {
            color: getComputedStyle(document.documentElement).getPropertyValue("--popup-text-muted") || "rgba(203,213,225,0.72)",
            callback: (v) => {
              if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
              if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}k`;
              return v;
            },
          },
        },
      },
    },
  });
}

// Delegated click handler — one listener for every IPC popup on the page.
function setupIpcPopupEventHandlers() {
  document.removeEventListener("click", _handleIpcPopupClick);
  document.addEventListener("click", _handleIpcPopupClick);
}

function _handleIpcPopupClick(e) {
  const btn = e.target.closest(".ipc-open-stats");
  if (!btn) return;
  const ds = btn.dataset;
  showIpcModalForArea({
    country:      ds.country || "",
    title:        ds.title || "IPC Area",
    phase:        Number(ds.phase) || 0,
    phaseLabel:   ds.phaseLabel || "",
    color:        ds.color || "#cccccc",
    anlId:        ds.anlId || "",
    totalPop:     ds.totalPop || "",
    classifiedPop: ds.classifiedPop || "",
    confidence:   ds.confidence || "",
    prolonged:    ds.prolonged || "false",
    phase1Pop: ds.phase1Pop, phase2Pop: ds.phase2Pop, phase3Pop: ds.phase3Pop,
    phase4Pop: ds.phase4Pop, phase5Pop: ds.phase5Pop,
    phase1Pct: ds.phase1Pct, phase2Pct: ds.phase2Pct, phase3Pct: ds.phase3Pct,
    phase4Pct: ds.phase4Pct, phase5Pct: ds.phase5Pct,
  });
}

// ---------------------------------------------------------------------------
// Crop choropleth popup (crop_wheat / crop_rice / crop_cotton / crop_sugarcane)
// ---------------------------------------------------------------------------
// The layer's GeoJSON features carry `name`, `code`, `production`, `area`,
// `yield`, `crop_id`, `year`, `level`, `has_data` (see /api/crops/geojson/).
// We surface the three headline numbers as stat tiles + a small "Open
// Crop Explorer" CTA that launches the standalone modal pre-selected for
// the current crop.  Zero coupling to the crop-explorer module — it
// reaches window.__openCropExplorer only, exposed globally by
// CropExplorerControl's constructor.
// ---------------------------------------------------------------------------
function _cropFmt(v, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "—";
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(digits)}k`;
  return n.toFixed(digits);
}
function _cropCropName(id) {
  const map = { 4: "Wheat", 2: "Rice", 5: "Cotton", 3: "Sugarcane" };
  return map[Number(id)] || `Crop ${id}`;
}

function buildCropPopupContent(props) {
  const name = String(props.name || "Province").trim();
  const cropId = Number(props.crop_id) || 4;
  const cropName = _cropCropName(cropId);
  const year   = String(props.year || "");
  const hasData = props.has_data === true || props.has_data === "true";
  const prod = Number(props.production) || 0;
  const area = Number(props.area) || 0;
  const yld  = Number(props.yield) || 0;

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${escapeHtml(name)}</div>
        <div class="ncop-popup__subtitle">${escapeHtml(cropName)}${year ? ` &middot; ${escapeHtml(year)}` : ""} &middot; Pakistan Bureau of Statistics</div>
      </div>
      <div class="ncop-popup__header-aside">
        <span class="ncop-popup__badge ncop-popup__badge--crop">
          ${hasData ? "Reported" : "No Data"}
        </span>
      </div>
    </div>
  `;

  const drawer = hasData
    ? `
      <div class="ncop-popup__grid crop-popup__stats">
        <div class="ncop-popup__card">
          <div class="ncop-popup__card-label">Area</div>
          <div class="ncop-popup__card-value">${_cropFmt(area, 1)} <span class="crop-popup__unit">000 Ha</span></div>
        </div>
        <div class="ncop-popup__card">
          <div class="ncop-popup__card-label">Production</div>
          <div class="ncop-popup__card-value crop-popup__value--prod">${_cropFmt(prod, 1)} <span class="crop-popup__unit">000 MT</span></div>
        </div>
        <div class="ncop-popup__card">
          <div class="ncop-popup__card-label">Yield</div>
          <div class="ncop-popup__card-value">${yld.toFixed(3)} <span class="crop-popup__unit">MT/Ha</span></div>
        </div>
      </div>
      <p class="crop-popup__reading">
        <strong>Reading:</strong> Province colour = ${escapeHtml(cropName)} production ranked against the crop's national spread. Popup values are for the ${escapeHtml(year)} fiscal year specifically; open the Explorer for the full 40+ year time series.
      </p>
      <button type="button" class="crop-open-explorer"
        data-crop-id="${escapeHtml(String(cropId))}"
        data-year="${escapeHtml(year)}">
        Open Crop Explorer
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7"/></svg>
      </button>
    `
    : `
      <div class="crop-popup__empty">
        <p><strong>No provincial ${escapeHtml(cropName)} production reported for ${escapeHtml(year || "this year")}.</strong></p>
        <p>${escapeHtml(name)} may not be a primary producing region for this crop in the selected fiscal year. Open the Explorer to browse other crops or years.</p>
        <button type="button" class="crop-open-explorer"
          data-crop-id="${escapeHtml(String(cropId))}"
          data-year="${escapeHtml(year)}">
          Open Crop Explorer
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7"/></svg>
        </button>
      </div>
    `;

  return { primary, drawer, drawerTitle: `${cropName} — Provincial Breakdown` };
}

// One delegated listener wired at first dispatch — clicking any
// `.crop-open-explorer` button hands the (cropId, year) to the global
// launcher the crop-explorer-control module exposes.
function setupCropPopupEventHandlers() {
  document.removeEventListener("click", _handleCropPopupClick);
  document.addEventListener("click", _handleCropPopupClick);
}
function _handleCropPopupClick(e) {
  const btn = e.target.closest(".crop-open-explorer");
  if (!btn) return;
  const cid = Number(btn.getAttribute("data-crop-id")) || 4;
  const yr  = btn.getAttribute("data-year") || "";
  if (typeof window.__openCropExplorer === "function") {
    window.__openCropExplorer(cid, yr);
  } else {
    console.warn("[crop popup] window.__openCropExplorer not available");
  }
}

function buildNwfcPopupContent(props) {
  const popupId = `nwfc-${String(props.name || "station")
    .replace(/\s+/g, "-")
    .toLowerCase()}-${Math.random().toString(36).slice(2, 9)}`;

  const weatherText = props.weather ?? props.wx ?? "";
  const emoji = nwfcWeatherEmoji(weatherText);
  const subtitleBits = ["NWFC Observation"];
  if (props.code) subtitleBits.push(`Code ${escapeHtml(String(props.code))}`);

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${escapeHtml(props.name || "NWFC Station")}</div>
        <div class="ncop-popup__subtitle">${subtitleBits.join(" · ")}</div>
      </div>
      <div class="ncop-popup__header-aside">
        <span class="ncop-popup__badge ncop-popup__badge--status-active"
              title="${escapeHtml(String(weatherText || "—"))}">
          ${emoji} ${escapeHtml(String(weatherText || "Weather"))}
        </span>
      </div>
    </div>
  `;

  const drawer = `
    <div class="ncop-popup__grid">
      <div class="ncop-popup__card">
        <div class="ncop-popup__card-label">Temperature</div>
        <div class="ncop-popup__card-value">${formatPMDValue(props.temperature)} °C</div>
      </div>
      <div class="ncop-popup__card">
        <div class="ncop-popup__card-label">Humidity</div>
        <div class="ncop-popup__card-value">${formatPMDValue(props.humidity, 0)} %</div>
      </div>
      <div class="ncop-popup__card">
        <div class="ncop-popup__card-label">Rain 24h</div>
        <div class="ncop-popup__card-value">${formatPMDValue(props.rain_24h, 0)} mm</div>
      </div>
      <div class="ncop-popup__card">
        <div class="ncop-popup__card-label">Wind</div>
        <div class="ncop-popup__card-value">${formatPMDValue(props.wind_speed, 1)} m/s</div>
      </div>
    </div>
    <div class="ncop-popup__chart">
      <div class="ncop-popup__chart-title">Live Weather Metrics</div>
      <canvas id="nwfc-chart-canvas-${popupId}" style="width:280px;height:200px;max-width:100%;"></canvas>
    </div>
    <div class="ncop-popup__info">
      <p class="ncop-popup__info-row"><strong>Rain (3h):</strong> ${formatPMDValue(props.rain_3h, 0)} mm</p>
      <p class="ncop-popup__info-row"><strong>Pressure:</strong> ${formatPMDValue(props.pressure, 0)} hPa</p>
      <p class="ncop-popup__info-row"><strong>Sea Level Pressure:</strong> ${formatPMDValue(props.sea_level_pressure, 1)} hPa</p>
      <p class="ncop-popup__info-row"><strong>Wind Direction:</strong> ${formatPMDValue(props.wind_direction, 0)}°</p>
      <p class="ncop-popup__info-row"><strong>Max Temperature:</strong> ${formatPMDValue(props.max_temperature)} °C</p>
      <p class="ncop-popup__info-row"><strong>Dew Point:</strong> ${formatPMDValue(props.dew_point)} °C</p>
      <p class="ncop-popup__info-row"><strong>Observed:</strong> ${escapeHtml(String(props.obs_time || props.date_time || "—"))}</p>
    </div>
  `;

  return { popupId, primary, drawer, drawerTitle: "Station Metrics" };
}

function createNwfcChart(canvas, props) {
  const ctx = canvas.getContext("2d");
  const chartId = canvas.id;

  if (nwfcChartInstances[chartId]) {
    nwfcChartInstances[chartId].destroy();
  }
  pruneCacheMap(nwfcChartInstances, MAX_FFD_CHARTS, (chart) => {
    if (chart && typeof chart.destroy === "function") chart.destroy();
  });

  // Numeric coalesce with a null-preserving fallback (Number("") === 0
  // is a lie for missing rain readings, but we want the bar to still
  // draw a base tick so the chart doesn't collapse — 0 is fine for
  // display and callback labels distinguish 0 vs missing).
  const num = (v) => {
    if (v == null || v === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const humidity = num(props.humidity);
  const rain3    = num(props.rain_3h);
  const rain24   = num(props.rain_24h);
  const wind     = num(props.wind_speed);

  // Colour ramps per metric so the operator can see severity at a
  // glance — cyan intensifies with humidity, blue → orange → red with
  // rainfall totals, green → yellow → red with wind speed.
  const humidityColor =
    humidity >= 90 ? "#0891b2"
    : humidity >= 70 ? "#22d3ee"
    : "#7dd3fc";
  const rainColor24 =
    rain24 >= 50 ? "#dc2626"
    : rain24 >= 10 ? "#f97316"
    : rain24 > 0  ? "#3b82f6"
    : "#94a3b8";
  const rainColor3 =
    rain3 >= 25 ? "#dc2626"
    : rain3 >= 10 ? "#f97316"
    : rain3 > 0  ? "#3b82f6"
    : "#94a3b8";
  const windColor =
    wind >= 15 ? "#dc2626"
    : wind >= 8  ? "#f97316"
    : wind >= 3  ? "#facc15"
    : "#22c55e";

  nwfcChartInstances[chartId] = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Humidity %", "Rain 3h mm", "Rain 24h mm", "Wind m/s"],
      datasets: [{
        label: "Reading",
        data: [humidity, rain3, rain24, wind],
        backgroundColor: [humidityColor, rainColor3, rainColor24, windColor],
        borderColor:     [humidityColor, rainColor3, rainColor24, windColor],
        borderWidth: 1,
        borderRadius: 4,
        maxBarThickness: 42,
      }],
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: { duration: 900, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(15, 23, 42, 0.95)",
          titleColor: "#fff",
          bodyColor: "#fff",
          borderColor: "rgba(255,255,255,0.15)",
          borderWidth: 1,
          padding: 8,
          callbacks: {
            label: (item) => `${item.label}: ${item.raw}`,
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#e6ecf5",
            font: { size: 10, weight: "600" },
            maxRotation: 0,
            autoSkip: false,
          },
          grid: { display: false, drawBorder: false },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#94a3b8",
            font: { size: 9 },
            precision: 0,
          },
          grid: {
            color: "rgba(255,255,255,0.06)",
            drawBorder: false,
          },
        }
      }
    }
  });
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
              `<span class="ncop-popup__category">${category.title || category.id || "Category"}</span>`
          )
          .join("")
      : `<span class="ncop-popup__status-note">No category metadata</span>`;

  const sourceHtml =
    sources.length > 0
      ? sources
          .map((source) => {
            const label = source.id || "Source";
            const url = source.url || "";
            if (url) {
              return `<li><a class="ncop-popup__link" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
            }
            return `<li>${label}</li>`;
          })
          .join("")
      : `<li>No source links available</li>`;

  const eventLinkRow = props.event_link
    ? `<p class="ncop-popup__info-row" style="margin-top:6px;"><a class="ncop-popup__link" href="${props.event_link}" target="_blank" rel="noopener noreferrer">Open EONET Event</a></p>`
    : "";

  const statusVariant = props.event_status === "Closed" ? "status-closed" : "status-open";

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${props.title || "NASA EONET Event"}</div>
        <div class="ncop-popup__subtitle">ID: ${props.event_id || "N/A"}</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${statusVariant}">${props.event_status || "Open"}</span>
    </div>
  `;

  const drawer = `
    <div class="ncop-popup__section">
      ${categoryHtml}
    </div>
    <div class="ncop-popup__info">
      <p class="ncop-popup__info-row"><strong>Description:</strong> ${props.description || "No description available."}</p>
      <p class="ncop-popup__info-row"><strong>Closed:</strong> ${props.closed || "Still open"}</p>
      <p class="ncop-popup__info-row"><strong>Magnitude:</strong> ${props.magnitude_label || "N/A"}</p>
      ${
        props.magnitude_description
          ? `<p class="ncop-popup__info-row"><strong>Magnitude Notes:</strong> ${props.magnitude_description}</p>`
          : ""
      }
      ${eventLinkRow}
    </div>
    <div class="ncop-popup__info">
      <div class="ncop-popup__section-title">Sources</div>
      <ul class="ncop-popup__sources">${sourceHtml}</ul>
    </div>
  `;

  return { primary, drawer, drawerTitle: "Event Details" };
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

// Map a numeric earthquake magnitude onto one of the unified severity bins
// used by the popup badge system. Thresholds mirror USGS category bands.
function usgsMagnitudeBin(mag) {
  const m = Number(mag);
  if (!Number.isFinite(m)) return "neutral";
  if (m < 4) return "mag-low";
  if (m < 5) return "mag-moderate";
  if (m < 6) return "mag-strong";
  if (m < 7) return "mag-major";
  return "mag-extreme";
}

function buildUsgsPopupContent(props) {
  const magBin = usgsMagnitudeBin(props.mag);
  const eventLinkRow = props.usgs_event_url
    ? `<p class="ncop-popup__info-row" style="margin-top:6px;"><a class="ncop-popup__link" href="${props.usgs_event_url}" target="_blank" rel="noopener noreferrer">Open USGS Event Page</a></p>`
    : "";

  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${props.title || "USGS Earthquake"}</div>
        <div class="ncop-popup__subtitle">${props.place || "Unknown location"}</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${magBin}">M ${props.mag ?? "N/A"}</span>
    </div>
  `;

  const drawer = `
    <div class="ncop-popup__grid">
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Depth</div><div class="ncop-popup__card-value">${props.depth_km ?? "N/A"} km</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Significance</div><div class="ncop-popup__card-value">${props.significance ?? "N/A"}</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Status</div><div class="ncop-popup__card-value">${props.status || "N/A"}</div></div>
      <div class="ncop-popup__card"><div class="ncop-popup__card-label">Tsunami</div><div class="ncop-popup__card-value">${props.tsunami ? "Yes" : "No"}</div></div>
    </div>
    <div class="ncop-popup__info">
      <p class="ncop-popup__info-row"><strong>Time:</strong> ${formatUsgsTime(props.time)}</p>
      <p class="ncop-popup__info-row"><strong>Updated:</strong> ${formatUsgsTime(props.updated)}</p>
      <p class="ncop-popup__info-row"><strong>Magnitude Type:</strong> ${props.magType || "N/A"}</p>
      <p class="ncop-popup__info-row"><strong>Alert:</strong> ${props.alert || "None"}</p>
      <p class="ncop-popup__info-row"><strong>Felt Reports:</strong> ${props.felt_reports ?? "N/A"}</p>
      ${eventLinkRow}
    </div>
    <div class="ncop-popup__actions">
      <button type="button" class="ncop-popup__button ncop-popup__button--primary usgs-fetch-shakemap" data-event-id="${props.event_id}">Fetch ShakeMap</button>
      <button type="button" class="ncop-popup__button ncop-popup__button--neutral usgs-clear-shakemap">Clear ShakeMap</button>
      <span class="usgs-shakemap-status ncop-popup__status-note"></span>
    </div>
  `;

  return { primary, drawer, drawerTitle: "Earthquake Details" };
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

// ========== HEATWAVE MONITORING — simple popup + standalone stats modal ==========
const heatwaveChartInstances = {};
const heatwaveDetailCache = {};
const HEATWAVE_INFLIGHT = {};

const HEATWAVE_MODAL_ID = "heatwave-stats-modal";
const HEATWAVE_CANVAS_ID = "heatwave-modal-canvas";
const HEATWAVE_INSTANCE_KEY = "modal";

function heatwaveAlertVariant(level) {
  switch (String(level || "").toLowerCase()) {
    case "extreme":
      return "heatwave-extreme";
    case "severe":
      return "heatwave-severe";
    case "high":
      return "heatwave-high";
    case "elevated":
      return "heatwave-elevated";
    default:
      return "heatwave-normal";
  }
}

function heatwaveFmt(value, digits = 1, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

// Slim popup — no charts, no tabs. Just identity, current temp, alert badge,
// and a button that hands off to the standalone stats modal.
function buildHeatwavePopupContent(props) {
  const variant = heatwaveAlertVariant(props.alert_level);
  const alertText = props.alert_level || "Normal";

  const primary = `
    <div class="ncop-popup__header heatwave-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${props.name || "City"}</div>
        <div class="ncop-popup__subtitle">${props.province || ""} · Heatwave Monitoring</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${variant}">${alertText}</span>
    </div>
  `;

  const drawer = `
    <div class="heatwave-popup-body">
      <div class="heatwave-popup-now">
        <div class="heatwave-popup-now__main">
          <span class="heatwave-popup-now__value">${heatwaveFmt(props.temperature, 1, "")}</span>
          <span class="heatwave-popup-now__unit">°C</span>
        </div>
        <div class="heatwave-popup-now__sub">
          Feels ${heatwaveFmt(props.apparent_temperature, 0, "°")} ·
          ${heatwaveFmt(props.temp_max, 0, "°")} / ${heatwaveFmt(props.temp_min, 0, "°")} ·
          RH ${heatwaveFmt(props.humidity, 0, "%")}
        </div>
      </div>
      <button type="button" class="heatwave-open-stats" data-lat="${props._lat || ""}" data-lon="${props._lon || ""}" data-name="${props.name || ""}" data-province="${props.province || ""}" data-alert="${alertText}" data-variant="${variant}">
        Open Stats Panel
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7"/></svg>
      </button>
    </div>
  `;

  return { primary, drawer, drawerTitle: "Heatwave" };
}

// ----- Standalone stats modal --------------------------------------------
function ensureHeatwaveModal() {
  let modal = document.getElementById(HEATWAVE_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = HEATWAVE_MODAL_ID;
  modal.className = "heatwave-modal hidden";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Heatwave Stats");
  modal.innerHTML = `
    <div class="heatwave-modal__head" data-heatwave-drag>
      <div class="heatwave-modal__drag-grip" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <div class="heatwave-modal__title-block">
        <div class="heatwave-modal__kicker">Heatwave Monitoring</div>
        <div class="heatwave-modal__title" id="heatwave-modal-name">—</div>
        <div class="heatwave-modal__subtitle" id="heatwave-modal-meta"></div>
      </div>
      <span class="heatwave-modal__badge ncop-popup__badge ncop-popup__badge--heatwave-normal" id="heatwave-modal-badge">—</span>
      <button type="button" class="heatwave-modal__close" aria-label="Close" data-heatwave-close>×</button>
    </div>

    <div class="heatwave-modal__body">
      <aside class="heatwave-modal__left">
        <div class="heatwave-modal__stats" id="heatwave-modal-stats"></div>
      </aside>
      <section class="heatwave-modal__right">
        <div class="heatwave-modal__tabs" role="tablist">
          <button class="heatwave-modal__tab is-active" data-mode="forecast" type="button">16-Day Forecast</button>
          <button class="heatwave-modal__tab" data-mode="seasonal" type="button">6-Month Outlook</button>
          <button class="heatwave-modal__tab" data-mode="climate" type="button">Climate Trend</button>
        </div>
        <div class="heatwave-modal__chart-wrap">
          <div class="heatwave-modal__chart-head">
            <div class="heatwave-modal__chart-title" id="heatwave-modal-title">16-Day Forecast</div>
            <div class="heatwave-modal__chart-sub" id="heatwave-modal-sub">Loading…</div>
          </div>
          <div class="heatwave-modal__canvas-host">
            <canvas id="${HEATWAVE_CANVAS_ID}"></canvas>
            <div class="heatwave-modal__loader" id="heatwave-modal-loader"><span></span><span></span><span></span></div>
          </div>
          <div class="heatwave-modal__footnote">Data: Open-Meteo (forecast / seasonal / climate-change APIs)</div>
        </div>
      </section>
    </div>

    <div class="heatwave-modal__resize" data-heatwave-resize aria-label="Resize">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M14 6 L6 14 M14 10 L10 14" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      </svg>
    </div>
  `;
  document.body.appendChild(modal);

  // Wire close + tab clicks once.
  modal.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-heatwave-close]")) {
      hideHeatwaveModal();
      return;
    }
    const tab = ev.target.closest(".heatwave-modal__tab");
    if (tab) {
      const mode = tab.getAttribute("data-mode");
      if (!mode) return;
      modal
        .querySelectorAll(".heatwave-modal__tab")
        .forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      const ctx = modal._heatwaveCtx;
      if (ctx) loadHeatwaveMode(mode, ctx.lat, ctx.lon);
    }
  });

  attachHeatwaveDragAndResize(modal);
  return modal;
}

// ---- Drag + resize -------------------------------------------------------
// Pointer-event based, single-touch friendly. The first drag/resize converts
// the modal's CSS-driven default position (bottom/left%) into pixel-anchored
// inline styles so subsequent moves stay sticky and the modal can be pushed
// anywhere on screen.
function attachHeatwaveDragAndResize(modal) {
  const drag = modal.querySelector("[data-heatwave-drag]");
  const resize = modal.querySelector("[data-heatwave-resize]");

  const pinToPixels = () => {
    // Snapshot current rect, then anchor to absolute viewport pixels so
    // bottom/right rules from the stylesheet stop fighting our updates.
    const r = modal.getBoundingClientRect();
    modal.style.left = `${Math.round(r.left)}px`;
    modal.style.top = `${Math.round(r.top)}px`;
    modal.style.right = "auto";
    modal.style.bottom = "auto";
    modal.style.width = `${Math.round(r.width)}px`;
    modal.style.height = `${Math.round(r.height)}px`;
  };

  // Drag (header)
  if (drag) {
    drag.addEventListener("pointerdown", (e) => {
      // Don't start a drag from interactive children (close button, badge).
      if (e.target.closest("[data-heatwave-close]")) return;
      if (e.button !== undefined && e.button !== 0) return;

      pinToPixels();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = parseFloat(modal.style.left) || 0;
      const startTop = parseFloat(modal.style.top) || 0;
      modal.classList.add("is-dragging");
      drag.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const margin = 8;
        const w = modal.offsetWidth;
        const h = modal.offsetHeight;
        let nl = startLeft + (ev.clientX - startX);
        let nt = startTop + (ev.clientY - startY);
        nl = Math.max(margin, Math.min(window.innerWidth - w - margin, nl));
        nt = Math.max(margin, Math.min(window.innerHeight - h - margin, nt));
        modal.style.left = `${Math.round(nl)}px`;
        modal.style.top = `${Math.round(nt)}px`;
      };
      const onUp = () => {
        modal.classList.remove("is-dragging");
        try { drag.releasePointerCapture(e.pointerId); } catch (_) {}
        drag.removeEventListener("pointermove", onMove);
        drag.removeEventListener("pointerup", onUp);
        drag.removeEventListener("pointercancel", onUp);
      };
      drag.addEventListener("pointermove", onMove);
      drag.addEventListener("pointerup", onUp);
      drag.addEventListener("pointercancel", onUp);
      e.preventDefault();
    });
  }

  // Resize (bottom-right corner handle)
  if (resize) {
    resize.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      pinToPixels();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = modal.offsetWidth;
      const startH = modal.offsetHeight;
      const startLeft = parseFloat(modal.style.left) || 0;
      const startTop = parseFloat(modal.style.top) || 0;
      modal.classList.add("is-resizing");
      resize.setPointerCapture(e.pointerId);

      const minW = 540;
      const minH = 280;

      const onMove = (ev) => {
        const margin = 8;
        const maxW = window.innerWidth - startLeft - margin;
        const maxH = window.innerHeight - startTop - margin;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const w = Math.max(minW, Math.min(maxW, startW + dx));
        const h = Math.max(minH, Math.min(maxH, startH + dy));
        modal.style.width = `${Math.round(w)}px`;
        modal.style.height = `${Math.round(h)}px`;
        // Chart.js v4 + responsive:true watches its container via
        // ResizeObserver, so the canvas re-fits automatically. No
        // explicit chart.resize() call needed.
      };
      const onUp = () => {
        modal.classList.remove("is-resizing");
        try { resize.releasePointerCapture(e.pointerId); } catch (_) {}
        resize.removeEventListener("pointermove", onMove);
        resize.removeEventListener("pointerup", onUp);
        resize.removeEventListener("pointercancel", onUp);
      };
      resize.addEventListener("pointermove", onMove);
      resize.addEventListener("pointerup", onUp);
      resize.addEventListener("pointercancel", onUp);
      e.preventDefault();
      e.stopPropagation();
    });
  }
}

function setHeatwaveLoader(isLoading) {
  const el = document.getElementById("heatwave-modal-loader");
  if (el) el.style.display = isLoading ? "flex" : "none";
}

function setHeatwaveSub(text) {
  const el = document.getElementById("heatwave-modal-sub");
  if (el) el.textContent = text;
}

function setHeatwaveTitle(text) {
  const el = document.getElementById("heatwave-modal-title");
  if (el) el.textContent = text;
}

function showHeatwaveModalForCity(ctx) {
  const modal = ensureHeatwaveModal();
  modal._heatwaveCtx = ctx;
  modal.classList.remove("hidden");
  modal.classList.add("is-open");
  // Position once contents are populated below — call after the stats grid
  // is rendered so getBoundingClientRect() returns the final size.

  const nameEl = document.getElementById("heatwave-modal-name");
  const metaEl = document.getElementById("heatwave-modal-meta");
  const badgeEl = document.getElementById("heatwave-modal-badge");
  const statsEl = document.getElementById("heatwave-modal-stats");

  if (nameEl) nameEl.textContent = ctx.name || "City";
  if (metaEl) {
    const lat = Number(ctx.lat).toFixed(3);
    const lon = Number(ctx.lon).toFixed(3);
    metaEl.textContent = `${ctx.province || ""}${ctx.province ? " · " : ""}${lat}, ${lon}`;
  }
  if (badgeEl) {
    badgeEl.textContent = ctx.alert || "Normal";
    badgeEl.className = `heatwave-modal__badge ncop-popup__badge ncop-popup__badge--${ctx.variant || "heatwave-normal"}`;
  }
  if (statsEl) {
    const props = ctx.props || {};
    statsEl.innerHTML = `
      <div class="heatwave-stat heatwave-stat--temp">
        <div class="heatwave-stat__label">Now</div>
        <div class="heatwave-stat__value">${heatwaveFmt(props.temperature, 1, "°C")}</div>
      </div>
      <div class="heatwave-stat heatwave-stat--feels">
        <div class="heatwave-stat__label">Feels Like</div>
        <div class="heatwave-stat__value">${heatwaveFmt(props.apparent_temperature, 1, "°C")}</div>
      </div>
      <div class="heatwave-stat">
        <div class="heatwave-stat__label">Today Max / Min</div>
        <div class="heatwave-stat__value">${heatwaveFmt(props.temp_max, 0, "°")} / ${heatwaveFmt(props.temp_min, 0, "°")}</div>
      </div>
      <div class="heatwave-stat">
        <div class="heatwave-stat__label">Humidity</div>
        <div class="heatwave-stat__value">${heatwaveFmt(props.humidity, 0, "%")}</div>
      </div>
      <div class="heatwave-stat">
        <div class="heatwave-stat__label">Wind</div>
        <div class="heatwave-stat__value">${heatwaveFmt(props.wind_speed, 1, " km/h")}</div>
      </div>
      <div class="heatwave-stat">
        <div class="heatwave-stat__label">Precip</div>
        <div class="heatwave-stat__value">${heatwaveFmt(props.precipitation, 1, " mm")}</div>
      </div>
    `;
  }

  // Reset to 16-day mode each time a new city is opened.
  modal
    .querySelectorAll(".heatwave-modal__tab")
    .forEach((t) => t.classList.toggle("is-active", t.getAttribute("data-mode") === "forecast"));

  loadHeatwaveMode("forecast", ctx.lat, ctx.lon);
}

function hideHeatwaveModal() {
  const modal = document.getElementById(HEATWAVE_MODAL_ID);
  if (!modal) return;
  modal.classList.add("hidden");
  modal.classList.remove("is-open");
  destroyHeatwaveChart(HEATWAVE_INSTANCE_KEY);
}

async function fetchHeatwaveDetail(lat, lon, kind) {
  const key = `${kind}:${Number(lat).toFixed(3)}:${Number(lon).toFixed(3)}`;
  if (heatwaveDetailCache[key]) return heatwaveDetailCache[key];
  if (HEATWAVE_INFLIGHT[key]) return HEATWAVE_INFLIGHT[key];

  const url = `${window.baseUrl || ""}/get-heatwave-detail/?lat=${lat}&lon=${lon}&type=${kind}`;
  const promise = fetch(url, { credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((json) => {
      heatwaveDetailCache[key] = json;
      delete HEATWAVE_INFLIGHT[key];
      const keys = Object.keys(heatwaveDetailCache);
      if (keys.length > 64) delete heatwaveDetailCache[keys[0]];
      return json;
    })
    .catch((err) => {
      delete HEATWAVE_INFLIGHT[key];
      throw err;
    });
  HEATWAVE_INFLIGHT[key] = promise;
  return promise;
}

function getHeatwaveChartTheme() {
  const isDay = document.documentElement.getAttribute("data-theme") !== "night";
  return {
    text: "#e2e8f0",
    grid: "rgba(148,163,184,0.18)",
    accent: isDay ? "#0ea5e9" : "#38bdf8",
    accentSoft: isDay ? "rgba(14,165,233,0.18)" : "rgba(56,189,248,0.18)",
    warm: "#f97316",
    danger: "#ef4444",
    cool: "#3b82f6",
  };
}

function destroyHeatwaveChart(key) {
  const inst = heatwaveChartInstances[key];
  if (inst && typeof inst.destroy === "function") {
    try {
      inst.destroy();
    } catch (_) {}
  }
  delete heatwaveChartInstances[key];
}

function getHeatwaveCanvas() {
  return document.getElementById(HEATWAVE_CANVAS_ID);
}

function renderHeatwaveForecast(payload) {
  const data = payload?.data?.daily || {};
  const labels = (data.time || []).map((d) => {
    const dt = new Date(d);
    return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  });
  const tMax = data.temperature_2m_max || [];
  const tMin = data.temperature_2m_min || [];
  const precip = data.precipitation_sum || [];
  const theme = getHeatwaveChartTheme();
  const canvas = getHeatwaveCanvas();
  if (!canvas) return;
  destroyHeatwaveChart(HEATWAVE_INSTANCE_KEY);

  heatwaveChartInstances[HEATWAVE_INSTANCE_KEY] = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Max °C",
          data: tMax,
          borderColor: theme.danger,
          backgroundColor: "rgba(239,68,68,0.18)",
          fill: false,
          tension: 0.35,
          borderWidth: 2.4,
          pointRadius: 3,
          pointHoverRadius: 5,
          yAxisID: "y",
        },
        {
          label: "Min °C",
          data: tMin,
          borderColor: theme.cool,
          backgroundColor: "rgba(59,130,246,0.18)",
          fill: false,
          tension: 0.35,
          borderWidth: 2.4,
          pointRadius: 3,
          pointHoverRadius: 5,
          yAxisID: "y",
        },
        {
          label: "Precip mm",
          data: precip,
          type: "bar",
          backgroundColor: "rgba(56,189,248,0.45)",
          borderRadius: 4,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 900, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: theme.text, font: { size: 10 }, maxRotation: 0 },
          grid: { display: false },
        },
        y: {
          position: "left",
          ticks: { color: theme.text, font: { size: 10 } },
          grid: { color: theme.grid },
          title: { display: true, text: "°C", color: theme.text, font: { size: 10 } },
        },
        y1: {
          position: "right",
          beginAtZero: true,
          ticks: { color: theme.text, font: { size: 10 } },
          grid: { display: false },
          title: { display: true, text: "mm", color: theme.text, font: { size: 10 } },
        },
      },
      plugins: {
        legend: {
          labels: { color: theme.text, font: { size: 10, weight: "600" }, boxWidth: 12 },
        },
        tooltip: {
          backgroundColor: "rgba(15,23,42,0.95)",
          borderColor: "rgba(148,163,184,0.3)",
          borderWidth: 1,
          titleColor: "#f1f5f9",
          bodyColor: "#e2e8f0",
        },
      },
    },
  });
}

function renderHeatwaveSeasonal(payload) {
  // Seasonal API: weekly is the only valid grouping for temperature_2m_mean.
  // Daily series carries temperature_2m_max/min and humidity_2m_max/min, which
  // we layer on top so the chart still tells the full seasonal story.
  const weekly = payload?.data?.weekly || {};
  const daily = payload?.data?.daily || {};

  const weeklyLabels = (weekly.time || []).map((d) => {
    const dt = new Date(d);
    return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  });
  const tMean = weekly.temperature_2m_mean || [];

  // Down-sample the daily series so it stays readable on the same axis. We
  // keep one point every 7 days, aligning roughly with the weekly index.
  const dailyTimes = daily.time || [];
  const stride = Math.max(1, Math.round(dailyTimes.length / Math.max(1, weeklyLabels.length || 12)));
  const sampleIdx = [];
  for (let i = 0; i < dailyTimes.length; i += stride) sampleIdx.push(i);
  const sampledLabels = sampleIdx.map((i) => {
    const dt = new Date(dailyTimes[i]);
    return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  });
  const sample = (arr) => sampleIdx.map((i) => (Array.isArray(arr) ? arr[i] ?? null : null));

  // Prefer weekly labels when available; otherwise fall back to daily samples.
  const labels = weeklyLabels.length ? weeklyLabels : sampledLabels;

  const theme = getHeatwaveChartTheme();
  const canvas = getHeatwaveCanvas();
  if (!canvas) return;
  destroyHeatwaveChart(HEATWAVE_INSTANCE_KEY);

  const datasets = [];
  if (tMean.length) {
    datasets.push({
      label: "Weekly Mean °C",
      data: tMean,
      borderColor: theme.warm,
      backgroundColor: "rgba(249,115,22,0.22)",
      fill: true,
      tension: 0.4,
      borderWidth: 2.4,
      pointRadius: 2,
      yAxisID: "y",
    });
  }
  if (Array.isArray(daily.temperature_2m_max) && daily.temperature_2m_max.length) {
    datasets.push({
      label: "Daily Max °C",
      data: weeklyLabels.length ? sample(daily.temperature_2m_max) : daily.temperature_2m_max,
      borderColor: theme.danger,
      backgroundColor: "rgba(239,68,68,0.0)",
      fill: false,
      tension: 0.35,
      borderWidth: 1.8,
      borderDash: [4, 3],
      pointRadius: 0,
      yAxisID: "y",
    });
  }
  if (Array.isArray(daily.temperature_2m_min) && daily.temperature_2m_min.length) {
    datasets.push({
      label: "Daily Min °C",
      data: weeklyLabels.length ? sample(daily.temperature_2m_min) : daily.temperature_2m_min,
      borderColor: theme.cool,
      backgroundColor: "rgba(59,130,246,0.0)",
      fill: false,
      tension: 0.35,
      borderWidth: 1.8,
      borderDash: [4, 3],
      pointRadius: 0,
      yAxisID: "y",
    });
  }
  if (Array.isArray(daily.relative_humidity_2m_max) && daily.relative_humidity_2m_max.length) {
    datasets.push({
      label: "RH Max %",
      data: weeklyLabels.length ? sample(daily.relative_humidity_2m_max) : daily.relative_humidity_2m_max,
      borderColor: "rgba(56,189,248,0.85)",
      backgroundColor: "rgba(56,189,248,0.18)",
      fill: false,
      tension: 0.4,
      borderWidth: 1.6,
      pointRadius: 0,
      yAxisID: "y1",
    });
  }

  heatwaveChartInstances[HEATWAVE_INSTANCE_KEY] = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1000, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: theme.text, font: { size: 9 }, maxRotation: 30, autoSkip: true, maxTicksLimit: 14 },
          grid: { display: false },
        },
        y: {
          ticks: { color: theme.text, font: { size: 10 } },
          grid: { color: theme.grid },
          title: { display: true, text: "°C", color: theme.text, font: { size: 10 } },
        },
        y1: {
          position: "right",
          beginAtZero: true,
          max: 100,
          ticks: { color: theme.text, font: { size: 10 } },
          grid: { display: false },
          title: { display: true, text: "RH %", color: theme.text, font: { size: 10 } },
        },
      },
      plugins: {
        legend: { labels: { color: theme.text, font: { size: 10, weight: "600" }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: "rgba(15,23,42,0.95)",
          titleColor: "#f1f5f9",
          bodyColor: "#e2e8f0",
        },
      },
    },
  });
}

function aggregateMonthly(times, values) {
  if (!Array.isArray(times) || !Array.isArray(values) || !times.length) {
    return { labels: [], values: [] };
  }
  const buckets = new Map();
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || Number.isNaN(Number(v))) continue;
    const d = new Date(times[i]);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!buckets.has(key)) buckets.set(key, { sum: 0, n: 0 });
    const b = buckets.get(key);
    b.sum += Number(v);
    b.n += 1;
  }
  const labels = [];
  const out = [];
  Array.from(buckets.keys()).sort().forEach((k) => {
    const { sum, n } = buckets.get(k);
    if (n === 0) return;
    labels.push(k);
    out.push(sum / n);
  });
  return { labels, values: out };
}

function renderHeatwaveClimate(payload) {
  const daily = payload?.data?.daily || {};
  const times = daily.time || [];
  // Climate API returns variables suffixed by model — find any matching column.
  const findKey = (prefix) =>
    Object.keys(daily).find((k) => k === prefix || k.startsWith(`${prefix}_`));
  const meanArr = daily[findKey("temperature_2m_mean")] || [];
  const maxArr = daily[findKey("temperature_2m_max")] || [];
  const aggMean = aggregateMonthly(times, meanArr);
  const aggMax = aggregateMonthly(times, maxArr);
  const theme = getHeatwaveChartTheme();
  const canvas = getHeatwaveCanvas();
  if (!canvas) return;
  destroyHeatwaveChart(HEATWAVE_INSTANCE_KEY);

  heatwaveChartInstances[HEATWAVE_INSTANCE_KEY] = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: aggMean.labels.length ? aggMean.labels : aggMax.labels,
      datasets: [
        {
          label: "Mean °C",
          data: aggMean.values,
          borderColor: theme.accent,
          backgroundColor: theme.accentSoft,
          fill: true,
          tension: 0.4,
          borderWidth: 2.2,
          pointRadius: 0,
        },
        {
          label: "Max °C",
          data: aggMax.values,
          borderColor: theme.danger,
          backgroundColor: "rgba(239,68,68,0.12)",
          fill: false,
          tension: 0.4,
          borderWidth: 2,
          borderDash: [4, 3],
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 1100, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: theme.text, font: { size: 9 }, maxRotation: 30, autoSkip: true, maxTicksLimit: 12 },
          grid: { display: false },
        },
        y: {
          ticks: { color: theme.text, font: { size: 10 } },
          grid: { color: theme.grid },
          title: { display: true, text: "°C (monthly avg)", color: theme.text, font: { size: 10 } },
        },
      },
      plugins: {
        legend: { labels: { color: theme.text, font: { size: 10, weight: "600" }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: "rgba(15,23,42,0.95)",
          titleColor: "#f1f5f9",
          bodyColor: "#e2e8f0",
        },
      },
    },
  });
}

async function loadHeatwaveMode(mode, lat, lon) {
  setHeatwaveTitle(
    mode === "seasonal"
      ? "6-Month Seasonal Outlook"
      : mode === "climate"
      ? "Climate Change Trend"
      : "16-Day Forecast"
  );
  setHeatwaveSub("Loading…");
  setHeatwaveLoader(true);

  try {
    const payload = await fetchHeatwaveDetail(lat, lon, mode);
    setHeatwaveLoader(false);
    if (mode === "forecast") {
      renderHeatwaveForecast(payload);
      const daily = payload?.data?.daily || {};
      const days = (daily.time || []).length;
      setHeatwaveSub(`${days} day daily forecast · max / min / precipitation`);
    } else if (mode === "seasonal") {
      renderHeatwaveSeasonal(payload);
      const w = payload?.data?.weekly || {};
      const n = (w.time || []).length;
      setHeatwaveSub(n ? `${n} weekly steps · seasonal outlook (CFSv2)` : "Seasonal data unavailable");
    } else if (mode === "climate") {
      renderHeatwaveClimate(payload);
      setHeatwaveSub("Monthly aggregates · climate-change projection");
    }
  } catch (err) {
    setHeatwaveLoader(false);
    setHeatwaveSub("Could not load data — try again later.");
    console.warn("Heatwave detail load failed:", err);
  }
}

// Single delegated handler for the "Open Stats Panel" button inside the popup.
function setupHeatwavePopupEventHandlers() {
  document.removeEventListener("click", handleHeatwavePopupClick);
  document.addEventListener("click", handleHeatwavePopupClick);
}

function handleHeatwavePopupClick(e) {
  const btn = e.target.closest(".heatwave-open-stats");
  if (!btn) return;
  const lat = parseFloat(btn.getAttribute("data-lat"));
  const lon = parseFloat(btn.getAttribute("data-lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  showHeatwaveModalForCity({
    lat,
    lon,
    name: btn.getAttribute("data-name") || "City",
    province: btn.getAttribute("data-province") || "",
    alert: btn.getAttribute("data-alert") || "Normal",
    variant: btn.getAttribute("data-variant") || "heatwave-normal",
    props: btn._props || {},
  });
}
// ========== END HEATWAVE MONITORING ==========

// Additive named exports — the real heatwave stats modal (chart, drag/resize,
// forecast/seasonal/climate tabs) is otherwise entirely module-private.
// Exposing these two lets other callers (e.g. Story Mode) open the SAME
// modal for a specific city on demand instead of re-implementing it or
// depending on the delegated click handler having already been installed
// by a prior real popup click. No existing behavior changes — these were
// already fully self-contained functions, just not exported before.
export { showHeatwaveModalForCity, hideHeatwaveModal };

// Same additive-export reasoning as the heatwave pair above, for the FFD
// popup's content builder + its delegated "Show Graph" click handler.
// Both were already fully self-contained (buildFfdPopupContent takes raw
// properties and returns HTML strings; setupFfdPopupEventHandlers wires
// one idempotent document-level listener) — exporting them changes
// nothing about how the real map-click popup path behaves.
export { buildFfdPopupContent, setupFfdPopupEventHandlers };

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
    // Standard single-column popup:
    //   ┌──────────────────────────┐
    //   │ × close (top-right)      │
    //   │ primary (header, fixed)  │
    //   ├──────────────────────────┤
    //   │ body-scroll              │ takes remaining height,
    //   │ (scrolls vertically when │ scrolls internally when
    //   │  content exceeds room)   │ content overflows.
    //   └──────────────────────────┘
    const el = document.createElement("div");
    el.className = "layer-attribute-popup ncop-popup hidden";
    // Close button removed — the popup now closes via the ESC key only,
    // wired below as a single document-level keydown listener.  Keeping
    // the close UI off the popup gives the data more breathing room and
    // matches the modal-like ESC convention used elsewhere in NCOP.
    el.innerHTML = `
      <div class="ncop-popup__primary">
        <div class="ncop-popup__primary-content"></div>
      </div>
      <div class="ncop-popup__body-scroll"></div>
    `;
    document.body.appendChild(el);

    // ESC closes whichever popup is currently visible.  Bound once at
    // creation; the visibility check inside means it's a no-op when the
    // popup is hidden, so it's safe to leave attached for the page lifetime.
    if (!this.__escBound) {
      this.__escBound = true;
      document.addEventListener("keydown", (ev) => {
        if (ev.key !== "Escape" && ev.key !== "Esc") return;
        if (!this.popupEl || this.popupEl.classList.contains("hidden")) return;
        this.hide();
      });
    }
    return el;
  }

  // Inject split content: `primaryHtml` goes in the fixed header region;
  // `bodyHtml` goes in the scrollable body. The third argument is accepted
  // for backward compatibility with the previous drawer API but is unused.
  #renderSplit(primaryHtml, bodyHtml /* , _title */) {
    const primaryEl = this.popupEl.querySelector(".ncop-popup__primary-content");
    const bodyEl = this.popupEl.querySelector(".ncop-popup__body-scroll");

    primaryEl.innerHTML = primaryHtml || "";
    bodyEl.innerHTML = bodyHtml || "";
  }

  setContent(title, properties) {
    this.#setContent({ title, properties });
    if (this.anchorLngLat) {
      this.#show();
      this.#updatePosition();
      this.#attachMoveListeners();
    }
  }

  // Generic fallback: compact primary shows title + attribute count; drawer
  // holds the full key/value table. HIDDEN_KEYS and nested-object expansion
  // are preserved from the original renderer.
  #setContent({ title, properties }) {
    const safeTitle = title || "Attributes";
    const props = properties || {};
    const visibleKeys = Object.keys(props).filter((k) => !HIDDEN_KEYS.has(k));

    const primaryHtml = `
      <div class="ncop-popup__header">
        <div class="ncop-popup__title-block">
          <div class="ncop-popup__title popup-label">${prettyAttributeName(safeTitle)}</div>
          <div class="ncop-popup__subtitle">${
            visibleKeys.length
              ? `${visibleKeys.length} attribute${visibleKeys.length === 1 ? "" : "s"}`
              : "No attributes"
          }</div>
        </div>
      </div>
    `;

    if (visibleKeys.length === 0) {
      this.#renderSplit(primaryHtml, "", "Attributes");
      return;
    }

    const rows = [];
    const addRows = (obj, level = 0) => {
      Object.keys(obj).forEach((key) => {
        if (HIDDEN_KEYS.has(key)) return;
        let val = obj[key];
        if (val === null || val === undefined) val = "(empty)";
        if (typeof val === "string") {
          try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === "object") val = parsed;
          } catch (_) {}
        }
        const indent = level * 16;
        if (val && typeof val === "object" && !Array.isArray(val)) {
          rows.push(
            `<tr><td class="attr-key" style="padding-left:${indent}px">${prettyAttributeName(key)}</td><td class="attr-value"></td></tr>`
          );
          addRows(val, level + 1);
        } else {
          const displayVal = Array.isArray(val) ? val.join(", ") : String(val);
          rows.push(
            `<tr><td class="attr-key" style="padding-left:${indent}px">${prettyAttributeName(key)}</td><td class="attr-value">${displayVal}</td></tr>`
          );
        }
      });
    };
    addRows(props);

    const drawerHtml = `<table class="ncop-popup__table popup-attributes"><tbody>${rows.join("")}</tbody></table>`;
    this.#renderSplit(primaryHtml, drawerHtml, safeTitle);
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

      // If any feature at this click belongs to a temporal / RainViewer layer
      // (tracked in window.__ncop_layer_registry), let the temporal module's
      // layer-specific click handler render the popup instead. This prevents
      // the double-popup problem when a temporal layer overlaps a vector with
      // popup eligibility (e.g. National Boundary).
      try {
        const registry = window.__ncop_layer_registry;
        if (registry instanceof Set && registry.size) {
          for (const f of features) {
            if (f?.layer?.id && registry.has(f.layer.id)) {
              return this.hide();
            }
          }
        }
      } catch {}

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
        const { primary, drawer, drawerTitle } = buildWaqiPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupWaqiPopupEventHandlers();
        return;
      }

      // SPECIAL HANDLING FOR FFD_DATA LAYER
      if (layerId?.includes("ffd_data") || sourceId === "ffd_data-source") {
        const properties = { ...(eligible.properties || {}) };
        const { primary, drawer, drawerTitle } = buildFfdPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupFfdPopupEventHandlers();
        return;
      }

      if (sourceId?.startsWith("eonet_") || layerId?.includes("eonet_")) {
        const properties = { ...(eligible.properties || {}) };
        const { primary, drawer, drawerTitle } = buildEonetPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        return;
      }

      if (sourceId?.startsWith("usgs_") || layerId?.includes("usgs_")) {
        const properties = { ...(eligible.properties || {}) };
        const { primary, drawer, drawerTitle } = buildUsgsPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

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
        const { popupId, primary, drawer, drawerTitle } =
          buildPmdPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

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

      // SPECIAL HANDLING FOR PMD CITY 12-STEP FORECAST LAYER
      // The `fc` field is a JSON string per §3.7; render it as a proper
      // scrollable forecast table rather than the [object Object] leak
      // the generic popup path used to produce.
      if (
        layerId?.includes("pmd_city_forecast") ||
        sourceId === "pmd_city_forecast-source"
      ) {
        const properties = { ...(eligible.properties || {}) };
        const { primary, drawer, drawerTitle } =
          buildPmdCityForecastPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        return;
      }

      // SPECIAL HANDLING FOR Crop choropleth LAYERS (crop_*)
      // Every crop_<name> source registered in map-layers.js (wheat,
      // rice, cotton, sugarcane, …) routes through this branch so the
      // popup shows the joined province card + Open Explorer CTA.
      if (
        (layerId && layerId.startsWith("crop_")) ||
        (sourceId && sourceId.startsWith("crop_"))
      ) {
        const properties = { ...(eligible.properties || {}) };
        const { primary, drawer, drawerTitle } = buildCropPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);
        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupCropPopupEventHandlers();
        return;
      }

      // SPECIAL HANDLING FOR IPC / Food Security LAYERS (ipc_*)
      // One builder covers every country layer because the IPC schema
      // is identical per feature.  Filters the 33-field raw record
      // down to the operationally-useful subset and renders it as a
      // header + phase-breakdown table instead of the generic
      // key-value dump.  The "Open Food Security Panel" button in the
      // drawer opens the standalone IPC stats modal — the country
      // slug is stamped onto props here so the modal knows which
      // country's aggregate to load for the "Country Overview" tab.
      if (
        (layerId && layerId.startsWith("ipc_")) ||
        (sourceId && sourceId.startsWith("ipc_"))
      ) {
        const properties = { ...(eligible.properties || {}) };
        // Derive the country slug from layer/source id: "ipc_pakistan" → "pakistan"
        const idForSlug = (sourceId || layerId || "").replace(/-source$/, "");
        const m = /^ipc_([a-z_]+?)(?:-[a-z]+)?$/i.exec(idForSlug);
        properties._ipcCountry = m ? m[1] : "";
        const { primary, drawer, drawerTitle } =
          buildIpcPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupIpcPopupEventHandlers();
        return;
      }

      // SPECIAL HANDLING FOR NWFC OBSERVATIONS LAYER
      // Sleek dashboard-style popup for /api/pmd/nwfc/observations/
      // — station metrics grid + Chart.js live-metrics bar chart +
      // full info drawer.  Replaces the generic attribute-table dump
      // that was previously rendered for these features.
      if (
        layerId?.includes("nwfc_observations") ||
        sourceId === "nwfc_observations-source"
      ) {
        const properties = { ...(eligible.properties || {}) };
        const { popupId, primary, drawer, drawerTitle } =
          buildNwfcPopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();

        requestAnimationFrame(() => {
          const canvas = document.getElementById(`nwfc-chart-canvas-${popupId}`);
          if (canvas) {
            createNwfcChart(canvas, properties);
          }
        });
        return;
      }

      if (
        layerId?.includes("heatwave_monitoring") ||
        sourceId === "heatwave_monitoring-source"
      ) {
        const properties = { ...(eligible.properties || {}) };
        // Carry click coordinates so the modal can hit our backend endpoint
        // with the city's lat/lon (taken from the GeoJSON feature geometry).
        try {
          const coords = eligible.geometry?.coordinates;
          if (Array.isArray(coords) && coords.length >= 2) {
            properties._lon = coords[0];
            properties._lat = coords[1];
          }
        } catch (_) {}
        if (properties._lat == null || properties._lon == null) {
          properties._lat = e.lngLat.lat;
          properties._lon = e.lngLat.lng;
        }

        const { primary, drawer, drawerTitle } =
          buildHeatwavePopupContent(properties);
        this.#renderSplit(primary, drawer, drawerTitle);

        this.#show();
        this.#updatePosition();
        this.#attachMoveListeners();
        setupHeatwavePopupEventHandlers();

        // Stash the full property bag onto the button so the modal can show
        // the same stats grid without needing another roundtrip.
        requestAnimationFrame(() => {
          const btn = this.popupEl.querySelector(".heatwave-open-stats");
          if (btn) btn._props = properties;
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
    // Close the temporal-layer popup (if any) so both popups can't appear
    // simultaneously when the user clicks a spot where multiple layers
    // overlap.
    try {
      if (window.__ts_clickPopup?.remove) {
        window.__ts_clickPopup.remove();
      }
      document
        .querySelectorAll(".mapboxgl-popup.temporal-layer-popup")
        .forEach((n) => n.remove());
    } catch {}
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
