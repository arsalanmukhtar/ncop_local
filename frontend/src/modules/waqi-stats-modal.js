// waqi-stats-modal.js
// Stats panel for WAQI air-quality stations, opened from the WAQI popup's
// "Open Stats Panel" button — the same heatwave-style shell as the other
// stats panels (stats-panel.js), with a teal accent (.waqi-modal).
//
// Every WAQI parameter is shown, whether or not this station reports it,
// combining WAQI's two documented sources:
//   - AirNet hourly feed (sensor stations, e.g. AirGradient): PM2.5, PM10,
//     PM1, CO2, TVOC, temperature, humidity — ~72 h of hourly mean/min/max
//     (via layer-attribute-popup.js's existing fetchStationDetail);
//   - WAQI station feed (official stations): current PM2.5, PM10, O3, NO2,
//     SO2, CO (as US AQI sub-indices), temperature, humidity, pressure,
//     dew point, wind; today's forecast min/max for PM2.5 and PM10.
//   left:  parameter table — Now / Min / Max for all 14 parameters
//   tabs:  "All Parameters" — every parameter in one chart (hourly series on
//          a shared 0-100% scale of each parameter's own range, tooltips in
//          real units; current-only and no-reading parameters listed in the
//          legend) · one tab per parameter with hourly history.

import Chart from "chart.js/auto";
import { createStatsPanel, statsPanelLegend } from "./stats-panel.js";

const THEME = { text: "#e2e8f0", grid: "rgba(148,163,184,0.18)", line: "#2dd4bf", band: "rgba(45,212,191,0.16)" };

// key: our id · airnet: AirNet series key · feed: WAQI feed iaqi key ·
// unitA: AirNet unit (concentration) · unitF: feed unit (pollutants are
// US AQI sub-indices in the feed) · color: line colour in the combined chart.
const PARAMS = [
  { key: "pm25", label: "PM2.5", airnet: "pm25", feed: "pm25", unitA: "µg/m³", unitF: "AQI", digits: 0, color: "#f43f5e" },
  { key: "pm10", label: "PM10", airnet: "pm10", feed: "pm10", unitA: "µg/m³", unitF: "AQI", digits: 0, color: "#f97316" },
  { key: "pm1", label: "PM1", airnet: "pm1", feed: null, unitA: "µg/m³", digits: 0, color: "#fb7185" },
  { key: "o3", label: "O₃", airnet: null, feed: "o3", unitF: "AQI", digits: 0, color: "#a78bfa" },
  { key: "no2", label: "NO₂", airnet: null, feed: "no2", unitF: "AQI", digits: 0, color: "#c084fc" },
  { key: "so2", label: "SO₂", airnet: null, feed: "so2", unitF: "AQI", digits: 0, color: "#e879f9" },
  { key: "co", label: "CO", airnet: null, feed: "co", unitF: "AQI", digits: 0, color: "#94a3b8" },
  { key: "co2", label: "CO₂", airnet: "co2", feed: null, unitA: "ppm", digits: 0, color: "#64748b" },
  { key: "tvoc", label: "TVOC", airnet: "tvoc", feed: null, unitA: "ppb", digits: 0, color: "#eab308" },
  { key: "t", label: "Temp", airnet: "met.t", feed: "t", unitA: "°C", unitF: "°C", digits: 1, color: "#ef4444" },
  { key: "h", label: "R.H.", airnet: "met.h", feed: "h", unitA: "%", unitF: "%", digits: 0, color: "#38bdf8" },
  { key: "p", label: "Pressure", airnet: null, feed: "p", unitF: "hPa", digits: 0, color: "#22c55e" },
  { key: "dew", label: "Dew point", airnet: null, feed: "dew", unitF: "°C", digits: 0, color: "#06b6d4" },
  { key: "w", label: "Wind", airnet: null, feed: "w", unitF: "m/s", digits: 1, color: "#14b8a6" },
];

// US EPA PM2.5 categories (2024), same bands as the other air-quality panels.
const EPA = [
  { max: 9.0, label: "Good", color: "#00e400" },
  { max: 35.4, label: "Moderate", color: "#ffff00" },
  { max: 55.4, label: "Unhealthy (sensitive)", color: "#ff7e00" },
  { max: 125.4, label: "Unhealthy", color: "#ff0000" },
  { max: 225.4, label: "Very unhealthy", color: "#8f3f97" },
  { max: Infinity, label: "Hazardous", color: "#7e0023" },
];

function epaFor(v) {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : EPA.find((b) => n <= b.max);
}

function aqiVariant(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return "neutral";
  if (n <= 50) return "aqi-good";
  if (n <= 100) return "aqi-moderate";
  if (n <= 150) return "aqi-usg";
  if (n <= 200) return "aqi-unhealthy";
  if (n <= 300) return "aqi-very-unhealthy";
  return "aqi-hazardous";
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function num(v, digits = 0) {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

function pkt(iso, withDate = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", { timeZone: "Asia/Karachi", ...(withDate ? { day: "2-digit", month: "short" } : {}),
                                      hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Sorted AirNet rows with a numeric mean for one series key. */
function airnetRows(payload, key) {
  if (!key || payload?.mode !== "airnet") return [];
  const arr = payload?.data?.[key];
  if (!Array.isArray(arr)) return [];
  return arr.filter((r) => r && r.time && r.mean !== null && r.mean !== undefined && Number.isFinite(Number(r.mean)))
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

/** Per-parameter summary combining both sources. */
export function summarizeWaqiParameters(airnet, feed) {
  const iaqi = feed?.iaqi || {};
  const today = feed?.time?.s ? String(feed.time.s).slice(0, 10) : null;
  const fcToday = (k) => ((feed?.forecast?.daily || {})[k] || []).find((d) => d.day === today);
  return PARAMS.map((p) => {
    const rows = airnetRows(airnet, p.airnet);
    if (rows.length) {
      return {
        ...p, source: "AirNet hourly", unit: p.unitA, rows,
        now: Number(rows.at(-1).mean),
        min: Math.min(...rows.map((r) => Number(r.min ?? r.mean))),
        max: Math.max(...rows.map((r) => Number(r.max ?? r.mean))),
        window: `${rows.length} h`,
      };
    }
    const cur = p.feed ? iaqi[p.feed]?.v : undefined;
    if (cur !== undefined && cur !== null) {
      const fc = p.feed ? fcToday(p.feed) : null;
      return {
        ...p, source: "WAQI station feed", unit: p.unitF, rows: [], now: Number(cur),
        min: fc ? fc.min : null, max: fc ? fc.max : null, window: fc ? "today (forecast)" : "",
      };
    }
    return { ...p, source: null, unit: p.unitA || p.unitF || "", rows: [], now: null, min: null, max: null, window: "" };
  });
}

const _cache = new Map(); // uid -> {airnet, feed}
const panel = createStatsPanel({
  id: "waqi-stats-modal",
  accentClass: "waqi-modal",
  ariaLabel: "WAQI station stats",
  kicker: "Air Quality · WAQI",
  onTab: (ctx, mode) => (mode === "all" ? renderAll(ctx) : renderMetric(ctx, mode)),
});

export function hideWaqiStatsModal() {
  panel.hide();
}

async function fetchFeed(uid) {
  const token = window.waqiT;
  if (!token) return null;
  try {
    const r = await fetch(`https://api.waqi.info/feed/@${encodeURIComponent(uid)}/?token=${encodeURIComponent(token)}`);
    if (!r.ok) return null;
    const j = await r.json();
    return j.status === "ok" && j.data && typeof j.data === "object" && Object.keys(j.data.iaqi || {}).length ? j.data : null;
  } catch (_) {
    return null;
  }
}

async function getData(uid) {
  if (_cache.has(uid)) return _cache.get(uid);
  // The AirNet fetcher lives with the WAQI popup code; loaded lazily to
  // avoid an import cycle (layer-attribute-popup.js imports this panel).
  const airnetP = import("./layer-attribute-popup.js")
    .then(({ fetchStationDetail }) => fetchStationDetail(uid))
    .catch((err) => { console.warn("[waqi] AirNet/feed detail unavailable", err); return null; });
  const [airnet, feed] = await Promise.all([airnetP, fetchFeed(uid)]);
  if (!airnet && !feed) throw new Error("no WAQI data for this station");
  const data = { airnet, feed };
  _cache.set(uid, data);
  if (_cache.size > 40) _cache.delete(_cache.keys().next().value);
  return data;
}

function paramTable(summary) {
  const rows = summary.map((s) => {
    const has = s.now !== null && s.now !== undefined;
    const unit = s.unit ? `<small>${esc(s.unit)}</small>` : "";
    // Official-feed PM min/max are TODAY'S FORECAST range, not observed —
    // tagged so a current reading outside it doesn't look like an error.
    const fc = s.window === "today (forecast)" && s.min !== null ? `<sup class="waqi-param__fc" title="Today's forecast range">fc</sup>` : "";
    return `<tr class="${has ? "" : "is-empty"}" title="${esc(has ? `${s.source}${s.window ? ` · ${s.window}` : ""}` : "This station does not report this parameter")}">
      <td><span class="waqi-param__dot" style="background:${s.color};"></span>${esc(s.label)}</td>
      <td class="waqi-param__now">${has ? `${num(s.now, s.digits)}${unit}` : "no reading"}</td>
      <td>${num(s.min, s.digits)}${fc}</td>
      <td>${num(s.max, s.digits)}${fc}</td></tr>`;
  }).join("");
  return `<table class="waqi-param-table">
    <thead><tr><th>Parameter</th><th>Now</th><th>Min</th><th>Max</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

/** ctx = {uid, name, aqi, time, continent} from the WAQI popup. */
export async function showWaqiStatsModal(ctx) {
  await panel.ensure();
  panel.ctx = ctx;
  panel.open();
  panel.setText("name", ctx.name || `Station ${ctx.uid}`);
  panel.setText("meta", `WAQI station ${ctx.uid}${ctx.continent ? ` · ${ctx.continent}` : ""}${ctx.time ? ` · ${ctx.time}` : ""}`);
  panel.setBadge(`AQI ${ctx.aqi ?? "—"}`, aqiVariant(ctx.aqi));
  panel.setTabs([{ mode: "all", label: "All Parameters" }]);
  const statsEl = panel.$("stats");
  if (statsEl) statsEl.innerHTML = `<div class="heatwave-stat"><div class="heatwave-stat__label">Loading station data…</div><div class="heatwave-stat__value">…</div></div>`;
  panel.setText("title", "—");
  panel.setText("sub", "Loading…");
  panel.setLoader(true);
  let data;
  try {
    data = await getData(ctx.uid);
  } catch (err) {
    if (!panel.isCurrent(ctx)) return;
    panel.setLoader(false);
    panel.setText("title", "Station data unavailable");
    panel.setText("sub", "WAQI did not return this station's data right now. Try again shortly.");
    if (statsEl) statsEl.innerHTML = paramTable(summarizeWaqiParameters(null, null));
    return;
  }
  if (!panel.isCurrent(ctx)) return;
  const summary = summarizeWaqiParameters(data.airnet, data.feed);
  ctx.summary = summary;
  const stationName = data.feed?.city?.name || data.airnet?.stationName;
  if (stationName) panel.setText("name", stationName);
  const updated = data.airnet?.mode === "airnet" ? data.airnet.updatedTime : (data.feed?.time?.iso || data.feed?.time?.s || data.airnet?.updatedTime);
  const sources = [data.airnet?.mode === "airnet" ? "AirNet hourly" : null, data.feed ? "WAQI station feed" : null].filter(Boolean).join(" + ");
  panel.setText("meta", `WAQI station ${ctx.uid} · updated ${pkt(updated)} PKT · ${sources || "current reading"}`);
  const feedAqi = data.feed?.aqi;
  if (feedAqi !== undefined && feedAqi !== null && feedAqi !== "-") panel.setBadge(`AQI ${feedAqi}`, aqiVariant(feedAqi));

  panel.setTabs([{ mode: "all", label: "All Parameters" },
                 ...summary.filter((s) => s.rows.length > 1).map((s) => ({ mode: s.key, label: s.label }))]);
  if (statsEl) statsEl.innerHTML = paramTable(summary);
  const attrib = [
    ...(Array.isArray(data.feed?.attributions) ? data.feed.attributions.map((a) => a.name) : []),
    ...(Array.isArray(data.airnet?.attributions) ? data.airnet.attributions.map((a) => a.name) : []),
  ].filter(Boolean);
  panel.setText("footnote", `Data: ${[...new Set(attrib)].join(" · ") || "World Air Quality Index (WAQI) / AirNet"}. `
    + "Feed pollutants are US AQI sub-indices; AirNet values are concentrations. Min/Max: hourly window, or today's forecast where marked. Times in PKT.");
  renderAll(ctx);
}

// ---------------------------------------------------------------------------
// "All Parameters" — every parameter in one chart
// ---------------------------------------------------------------------------

function renderAll(ctx) {
  panel.destroyChart();
  panel.setLoader(false);
  const summary = ctx.summary || summarizeWaqiParameters(null, null);
  const legend = panel.$("legend");
  if (legend) legend.innerHTML = "";
  const withHistory = summary.filter((s) => s.rows.length > 1);
  const currentOnly = summary.filter((s) => s.rows.length <= 1 && s.now !== null);
  const none = summary.filter((s) => s.now === null);

  // Shared time axis: every hour any hourly parameter reported.
  const times = [...new Set(withHistory.flatMap((s) => s.rows.map((r) => r.time)))].sort((a, b) => new Date(a) - new Date(b));
  const labels = times.length ? times.map((t) => pkt(t)) : [pkt(new Date().toISOString())];

  const datasets = withHistory.map((s) => {
    const byTime = new Map(s.rows.map((r) => [r.time, Number(r.mean)]));
    const span = (s.max - s.min) || 1;
    return {
      label: `${s.label} (${s.unit})`,
      data: times.map((t) => (byTime.has(t) ? ((byTime.get(t) - s.min) / span) * 100 : null)),
      raw: times.map((t) => (byTime.has(t) ? byTime.get(t) : null)),
      unit: s.unit, digits: s.digits,
      borderColor: s.color, backgroundColor: s.color, borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 3,
      tension: 0.3, spanGaps: true,
    };
  });
  // Current-only and no-reading parameters: legend entries (no line), so the
  // full parameter set is always visible in the one chart.
  currentOnly.forEach((s) => datasets.push({
    label: `${s.label}: ${num(s.now, s.digits)} ${s.unit} (current only)`, data: [], borderColor: s.color,
    backgroundColor: s.color, borderDash: [2, 3], pointRadius: 0,
  }));
  none.forEach((s) => datasets.push({
    label: `${s.label}: no reading`, data: [], borderColor: "rgba(148,163,184,0.45)",
    backgroundColor: "rgba(148,163,184,0.25)", borderDash: [2, 3], pointRadius: 0,
  }));

  panel.setText("title", "All parameters");
  panel.setText("sub", withHistory.length
    ? `${withHistory.length} parameters with hourly history over ${times.length} h, each scaled 0–100% of its own min–max (hover for real values). `
      + `${currentOnly.length} current-only, ${none.length} not reported by this station.`
    : `This station publishes current readings only (${currentOnly.length} parameters); ${none.length} are not reported. See the table for values.`);

  panel.chart = new Chart(panel.$("canvas").getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: THEME.text, font: { size: 10 }, maxTicksLimit: 9, maxRotation: 0 }, grid: { color: THEME.grid } },
        y: { min: 0, max: 100, ticks: { color: THEME.text, font: { size: 10 }, callback: (v) => `${v}%` }, grid: { color: THEME.grid },
             title: { display: true, text: "% of each parameter's range", color: THEME.text, font: { size: 10 } } },
      },
      plugins: {
        legend: { position: "bottom", labels: { color: THEME.text, font: { size: 9.5 }, boxWidth: 10, boxHeight: 2, padding: 6 } },
        tooltip: {
          filter: (i) => i.raw !== null && i.raw !== undefined,
          callbacks: {
            label: (c) => {
              const v = c.dataset.raw?.[c.dataIndex];
              return `${c.dataset.label.split(" (")[0]}: ${num(v, c.dataset.digits)} ${c.dataset.unit || ""}`;
            },
          },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Single parameter (hourly history)
// ---------------------------------------------------------------------------

function renderMetric(ctx, key) {
  panel.destroyChart();
  panel.setLoader(false);
  const s = (ctx.summary || []).find((x) => x.key === key);
  const rows = s?.rows || [];
  const legend = panel.$("legend");
  const isPm = key === "pm25";
  if (legend) legend.innerHTML = isPm ? statsPanelLegend(EPA.map((b) => ({ color: b.color, label: b.label }))) : "";
  if (!s || !rows.length) {
    panel.setText("title", `${s?.label || key} — no hourly data`);
    panel.setText("sub", "This station does not publish hourly history for this parameter.");
    return;
  }
  panel.setText("title", `${s.label} — hourly, last ${rows.length} hours`);
  panel.setText("sub", `Line: hourly mean · shaded: the hour's min–max${isPm ? " · dashed: EPA category limits" : ""}. Times in PKT.`);
  const labels = rows.map((r) => pkt(r.time));
  const mean = rows.map((r) => Number(r.mean));
  const maxVal = Math.max(...rows.map((r) => Number(r.max ?? r.mean)));
  const datasets = [
    { label: "max", data: rows.map((r) => (r.max ?? null)), borderWidth: 0, pointRadius: 0, backgroundColor: THEME.band, fill: "+1", order: 5 },
    { label: "min", data: rows.map((r) => (r.min ?? null)), borderWidth: 0, pointRadius: 0, fill: false, order: 5 },
    {
      label: `${s.label} (${s.unit})`, data: mean, borderColor: s.color, borderWidth: 2.2, tension: 0.3, order: 1, pointRadius: 1.8,
      pointBackgroundColor: isPm ? mean.map((v) => epaFor(v)?.color ?? s.color) : s.color,
      segment: isPm ? { borderColor: (c) => epaFor(c.p1.parsed.y)?.color ?? s.color } : undefined,
    },
  ];
  if (isPm) {
    EPA.slice(0, -1).filter((b) => b.max <= Math.max(maxVal * 1.15, 40)).forEach((b) => datasets.push({
      label: `${b.label} limit`, data: Array(rows.length).fill(b.max), borderColor: b.color, borderWidth: 1,
      borderDash: [5, 5], pointRadius: 0, fill: false, order: 10,
    }));
  }
  panel.chart = new Chart(panel.$("canvas").getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: THEME.text, font: { size: 10 }, maxTicksLimit: 10, maxRotation: 0 }, grid: { color: THEME.grid } },
        y: { beginAtZero: key !== "t", ticks: { color: THEME.text, font: { size: 10 } }, grid: { color: THEME.grid },
             title: { display: true, text: `${s.label} (${s.unit})`, color: THEME.text, font: { size: 10 } } },
      },
      plugins: {
        legend: { labels: { color: THEME.text, font: { size: 10 }, boxWidth: 12, filter: (i) => i.text.includes("(") } },
        tooltip: {
          filter: (i) => !["max", "min"].includes(i.dataset.label) && !String(i.dataset.label).endsWith("limit"),
          callbacks: {
            afterBody: (items) => {
              const r = rows[items[0]?.dataIndex];
              if (!r) return [];
              const out = [];
              if (r.min !== undefined && r.max !== undefined) out.push(`Hour range ${num(r.min, s.digits)}–${num(r.max, s.digits)} ${s.unit}`);
              if (r.count) out.push(`${r.count} readings`);
              if (isPm && epaFor(r.mean)) out.push(`Category: ${epaFor(r.mean).label}`);
              return out;
            },
          },
        },
      },
    },
  });
}
