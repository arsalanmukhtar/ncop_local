// hawanama-stats-modal.js
// Stats panel for Hawanama (Pakistan Air Quality Initiative) stations,
// opened from the station popup's "Open Stats Panel" button — the same
// heatwave-style panel shell as the IWMI flood panel (stats-panel.js), with
// a violet air-quality accent (.hawanama-modal in _popup.css).
//   left:  AQI, PM2.5, category, temperature, humidity, network, QC, last reading
//   tabs:  48 hours (hourly PM2.5) · 30 days (daily mean bars coloured by
//          US EPA PM2.5 category, with the day's min-max range)
// Data: /api/hawanama/stations/<id>/history/ (hawanama_views.py).

import Chart from "chart.js/auto";
import { createStatsPanel, statsPanelLegend } from "./stats-panel.js";

const API = `${window.location.origin}/api/hawanama`;
const ATTRIBUTION = "Pakistan Air Quality Initiative (Hawanama), CC BY 4.0";
const THEME = { text: "#e2e8f0", grid: "rgba(148,163,184,0.18)", line: "#a78bfa" };

// US EPA PM2.5 (24 h) categories, 2024 revision — same bands as the popups.
const EPA = [
  { max: 9.0, label: "Good", color: "#00e400", variant: "aqi-good" },
  { max: 35.4, label: "Moderate", color: "#ffff00", variant: "aqi-moderate" },
  { max: 55.4, label: "Unhealthy (sensitive)", color: "#ff7e00", variant: "aqi-usg" },
  { max: 125.4, label: "Unhealthy", color: "#ff0000", variant: "aqi-unhealthy" },
  { max: 225.4, label: "Very unhealthy", color: "#8f3f97", variant: "aqi-very-unhealthy" },
  { max: Infinity, label: "Hazardous", color: "#7e0023", variant: "aqi-hazardous" },
];

function epaFor(pm25) {
  const n = Number(pm25);
  if (pm25 === null || pm25 === undefined || !Number.isFinite(n)) return null;
  return EPA.find((b) => n <= b.max);
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

function num(v, digits = 0, suffix = "") {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}${suffix}`;
}

function pkt(iso, withDate = true) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Karachi", ...(withDate ? { day: "2-digit", month: "short" } : {}),
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function stat(label, value, extraClass = "") {
  return `<div class="heatwave-stat ${extraClass}"><div class="heatwave-stat__label">${esc(label)}</div><div class="heatwave-stat__value" title="${esc(String(value).replace(/<[^>]+>/g, ""))}">${value}</div></div>`;
}

const _cache = new Map(); // station id -> history payload
const panel = createStatsPanel({
  id: "hawanama-stats-modal",
  accentClass: "hawanama-modal",
  ariaLabel: "Air quality station stats",
  kicker: "Air Quality · Hawanama",
  onTab: (ctx, mode) => renderTab(ctx, mode),
});

export function hideHawanamaStatsModal() {
  panel.hide();
}

async function getHistory(stationId) {
  if (_cache.has(stationId)) return _cache.get(stationId);
  const r = await fetch(`${API}/stations/${encodeURIComponent(stationId)}/history/?hours=48&days=30`, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  _cache.set(stationId, data);
  if (_cache.size > 40) _cache.delete(_cache.keys().next().value);
  return data;
}

/** ctx = {props} — the station feature's properties. */
export async function showHawanamaStatsModal(ctx) {
  await panel.ensure();
  panel.ctx = ctx;
  panel.open();
  const p = ctx.props || {};
  const cat = epaFor(p.pm25);
  const stale = p.reading_stale === true || p.reading_stale === "true";
  panel.setText("name", p.name || "Station");
  panel.setText("meta", `${p.city || ""}${p.network ? ` · ${p.network}` : ""} · last reading ${pkt(p.last_reading)} PKT${stale ? " (stale)" : ""}`);
  panel.setBadge(`AQI ${p.aqi ?? "—"}`, aqiVariant(p.aqi));
  panel.setTabs([{ mode: "hourly", label: "48 Hours" }, { mode: "daily", label: "30 Days" }]);
  const statsEl = panel.$("stats");
  if (statsEl) statsEl.innerHTML = [
    stat("PM2.5 now", num(p.pm25, 0, " µg/m³"), "heatwave-stat--temp"),
    stat("US AQI", esc(p.aqi ?? "—"), "heatwave-stat--feels"),
    stat("Category", esc(cat ? cat.label : "No data")),
    stat("Temperature", num(p.temp, 0, " °C")),
    stat("Humidity", num(p.hum, 0, " %")),
    stat("Network", esc(p.network || "—")),
    `<div class="heatwave-stat" id="hawanama-stats-modal-avg48"><div class="heatwave-stat__label">48 h average</div><div class="heatwave-stat__value">…</div></div>`,
    `<div class="heatwave-stat" id="hawanama-stats-modal-peak48"><div class="heatwave-stat__label">48 h peak</div><div class="heatwave-stat__value">…</div></div>`,
  ].join("");
  const legend = panel.$("legend");
  if (legend) legend.innerHTML = statsPanelLegend(EPA.map((b) => ({ color: b.color, label: b.label })));
  panel.setText("footnote", `Data: ${ATTRIBUTION}. Categories: US EPA PM2.5 (2024). QC state: ${p.qc_state || "—"}.`);
  renderTab(ctx, "hourly");
}

function setSummary(avg, peak) {
  const a = document.querySelector("#hawanama-stats-modal-avg48 .heatwave-stat__value");
  const b = document.querySelector("#hawanama-stats-modal-peak48 .heatwave-stat__value");
  if (a) a.textContent = avg;
  if (b) b.textContent = peak;
}

function baseOptions(yMax) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { color: THEME.text, font: { size: 10 }, maxTicksLimit: 12, maxRotation: 0 }, grid: { color: THEME.grid } },
      y: { beginAtZero: true, suggestedMax: yMax, ticks: { color: THEME.text, font: { size: 10 } }, grid: { color: THEME.grid },
           title: { display: true, text: "PM2.5 (µg/m³)", color: THEME.text, font: { size: 10 } } },
    },
    plugins: { legend: { labels: { color: THEME.text, font: { size: 10 }, boxWidth: 12 } } },
  };
}

// Dashed reference lines at the EPA category boundaries that fall inside
// the plotted range, so a reading's category is readable off the chart.
function epaReferenceDatasets(n, maxVal) {
  return EPA.slice(0, -1)
    .filter((b) => b.max <= Math.max(maxVal * 1.15, 40))
    .map((b) => ({
      label: `${b.label} limit`, data: Array(n).fill(b.max), borderColor: b.color, borderWidth: 1,
      borderDash: [5, 5], pointRadius: 0, fill: false, order: 10,
    }));
}

async function renderTab(ctx, mode) {
  panel.destroyChart();
  panel.setLoader(true);
  const canvas = panel.$("canvas");
  try {
    const d = await getHistory(ctx.props.id);
    if (!panel.isCurrent(ctx)) return;
    const hourly = (d.hourly || []).filter((r) => r.t);
    const vals = hourly.map((r) => r.pm25).filter((v) => v !== null && v !== undefined);
    setSummary(vals.length ? num(vals.reduce((a, b) => a + b, 0) / vals.length, 0, " µg/m³") : "—",
               vals.length ? num(Math.max(...vals), 0, " µg/m³") : "—");
    if (mode === "daily") renderDaily(canvas, d.daily || []);
    else renderHourly(canvas, hourly);
  } catch (err) {
    console.warn("[hawanama] stats panel history unavailable", err);
    panel.setText("title", "History unavailable");
    panel.setText("sub", "The station's PM2.5 history could not be loaded right now. Try again shortly.");
    setSummary("—", "—");
  } finally {
    panel.setLoader(false);
  }
}

function renderHourly(canvas, rows) {
  const labels = rows.map((r) => pkt(r.t, false));
  const values = rows.map((r) => (r.pm25 === null || r.pm25 === undefined ? null : Number(r.pm25)));
  const maxVal = Math.max(0, ...values.filter((v) => v !== null));
  const valid = values.filter((v) => v !== null).length;
  panel.setText("title", "Hourly PM2.5 — last 48 hours");
  panel.setText("sub", valid ? `${valid} of ${rows.length} hours with readings · times in PKT. Dashed lines: EPA category limits.`
                             : "No readings in the last 48 hours.");
  panel.chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "PM2.5", data: values, borderColor: THEME.line, backgroundColor: "rgba(167,139,250,0.18)",
          fill: true, tension: 0.3, borderWidth: 2.2, pointRadius: 2, spanGaps: false, order: 1,
          segment: { borderColor: (c) => (epaFor(c.p1.parsed.y)?.color ?? THEME.line) },
          pointBackgroundColor: values.map((v) => epaFor(v)?.color ?? THEME.line),
        },
        ...epaReferenceDatasets(values.length, maxVal),
      ],
    },
    options: (() => {
      const o = baseOptions(maxVal * 1.15);
      o.plugins.legend.labels.filter = (i) => i.text === "PM2.5";
      o.plugins.tooltip = {
        filter: (i) => i.dataset.label === "PM2.5",
        callbacks: { afterLabel: (c) => (epaFor(c.parsed.y) ? `Category: ${epaFor(c.parsed.y).label}` : "") },
      };
      return o;
    })(),
  });
}

function renderDaily(canvas, rows) {
  const labels = rows.map((r) => {
    const d = new Date(`${r.date}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? r.date : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  });
  const values = rows.map((r) => (r.pm25 === null || r.pm25 === undefined ? null : Number(r.pm25)));
  const maxVal = Math.max(0, ...rows.flatMap((r) => [r.pm25, r.pm25_max]).filter((v) => v !== null && v !== undefined));
  const valid = values.filter((v) => v !== null);
  panel.setText("title", "Daily mean PM2.5 — last 30 days");
  panel.setText("sub", valid.length
    ? `${valid.length} days with data · 30-day mean ${num(valid.reduce((a, b) => a + b, 0) / valid.length, 0, " µg/m³")} · bars coloured by EPA category, whiskers = day's min–max.`
    : "No daily data in the last 30 days.");
  panel.chart = new Chart(canvas.getContext("2d"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar", label: "Daily mean", data: values, order: 2, borderRadius: 3,
          backgroundColor: values.map((v) => `${epaFor(v)?.color ?? "#94a3b8"}cc`),
        },
        {
          type: "line", label: "Daily max", data: rows.map((r) => r.pm25_max ?? null), order: 1,
          borderColor: "rgba(226,232,240,0.55)", borderWidth: 1, borderDash: [3, 3], pointRadius: 1.5, fill: false,
        },
        {
          type: "line", label: "Daily min", data: rows.map((r) => r.pm25_min ?? null), order: 1,
          borderColor: "rgba(226,232,240,0.35)", borderWidth: 1, borderDash: [3, 3], pointRadius: 1.5, fill: false,
        },
      ],
    },
    options: (() => {
      const o = baseOptions(maxVal * 1.1);
      o.plugins.tooltip = { callbacks: { afterBody: (items) => {
        const v = values[items[0]?.dataIndex];
        return epaFor(v) ? [`Category: ${epaFor(v).label}`] : [];
      } } };
      return o;
    })(),
  });
}

// ---------------------------------------------------------------------------
// Crop-fire smoke outlook → rice-season fire statistics panel
// Opened from the fire-outlook popup. Left: the city's smoke outlook plus
// the selected region's season-to-date figures. Tabs: Punjab (PK) /
// Indian Punjab — cumulative fire detections this season vs last season
// and the reference years. Data: /api/hawanama/fires/season/.
// ---------------------------------------------------------------------------

const FIRE_BAND_VARIANT = {
  none: "aqi-good", low: "aqi-moderate", elevated: "aqi-usg", high: "aqi-unhealthy", very_high: "aqi-very-unhealthy",
};
const FIRE_REGIONS = [
  { mode: "punjab", label: "Punjab (PK)" },
  { mode: "indian-punjab", label: "Indian Punjab" },
];
const _seasonCache = new Map(); // region -> payload

const firePanel = createStatsPanel({
  id: "hawanama-fire-stats-modal",
  accentClass: "hawanama-fire-modal",
  ariaLabel: "Crop-fire season stats",
  kicker: "Crop-Fire Smoke · Hawanama",
  onTab: (ctx, mode) => renderSeason(ctx, mode),
});

export function hideHawanamaFireStatsModal() {
  firePanel.hide();
}

async function getSeason(region) {
  if (_seasonCache.has(region)) return _seasonCache.get(region);
  const r = await fetch(`${API}/fires/season/?region=${encodeURIComponent(region)}`, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  _seasonCache.set(region, data);
  return data;
}

function pctText(v) {
  return v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v}%`;
}

/** ctx = {props} — the fire-outlook city feature's properties. */
export async function showHawanamaFireStatsModal(ctx) {
  await firePanel.ensure();
  firePanel.ctx = ctx;
  firePanel.open();
  const p = ctx.props || {};
  let byCountry = {};
  try { byCountry = typeof p.by_country === "string" ? JSON.parse(p.by_country) : (p.by_country || {}); } catch (_) {}
  const countries = Object.entries(byCountry).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
  const band = String(p.band || "none");
  firePanel.setText("name", p.city || "City");
  firePanel.setText("meta", `${p.province || ""} · next-day smoke-source outlook`);
  firePanel.setBadge(band.replace("_", " "), FIRE_BAND_VARIANT[band] || "neutral");
  firePanel.setTabs(FIRE_REGIONS);
  const statsEl = firePanel.$("stats");
  if (statsEl) statsEl.innerHTML = [
    stat("Upwind fire load", num(p.upwind_load_mw, 0, " MW"), "heatwave-stat--temp"),
    stat("Fires upwind", esc(p.fires_in_cone ?? "—"), "heatwave-stat--feels"),
    stat("Wind from", esc(p.from_compass || "—")),
    stat("Fires by country", esc(countries)),
    `<div class="heatwave-stat" id="hawanama-fire-stats-modal-todate"><div class="heatwave-stat__label">Season fires to date</div><div class="heatwave-stat__value">…</div></div>`,
    `<div class="heatwave-stat" id="hawanama-fire-stats-modal-yoy"><div class="heatwave-stat__label">vs last year (NOAA-20)</div><div class="heatwave-stat__value">…</div></div>`,
    `<div class="heatwave-stat" id="hawanama-fire-stats-modal-rank"><div class="heatwave-stat__label">vs reference years</div><div class="heatwave-stat__value">…</div></div>`,
    `<div class="heatwave-stat" id="hawanama-fire-stats-modal-perday"><div class="heatwave-stat__label">Fires per day</div><div class="heatwave-stat__value">…</div></div>`,
  ].join("") + `<div class="iwmi-modal__warning">A smoke-source outlook, not a PM2.5 forecast: fire load upwind is consistent with smoke transport, not proof it causes local PM2.5. Bands are unvalidated screening categories.</div>`;
  const legend = firePanel.$("legend");
  if (legend) legend.innerHTML = statsPanelLegend([
    { color: "#ef4444", label: "This season" }, { color: "#94a3b8", label: "Last season" }, { color: "rgba(148,163,184,0.45)", label: "Reference years" },
  ]);
  firePanel.setText("footnote", `Data: ${ATTRIBUTION}. VIIRS (NOAA-20/21) fire detections, deduplicated, high/nominal confidence; outlook wind: ECMWF IFS.`);
  renderSeason(ctx, "punjab");
}

function setFireStat(part, text) {
  const el = document.querySelector(`#hawanama-fire-stats-modal-${part} .heatwave-stat__value`);
  if (el) el.textContent = text;
}

async function renderSeason(ctx, region) {
  firePanel.destroyChart();
  firePanel.setLoader(true);
  const canvas = firePanel.$("canvas");
  try {
    const d = await getSeason(region);
    if (!firePanel.isCurrent(ctx)) return;
    const h = d.headline || {};
    const n20 = h.comparison_n20 || {};
    setFireStat("todate", num(h.fires, 0));
    setFireStat("yoy", pctText(n20.last_year?.pct_change));
    setFireStat("rank", n20.reference?.rank_text || h.reference?.rank_text || "—");
    setFireStat("perday", num(h.fires_per_day, 0));
    const current = (d.years || []).find((y) => y.role === "current");
    const last = (d.years || []).find((y) => y.role === "last");
    const refs = (d.years || []).filter((y) => y.role === "reference");
    firePanel.setText("title", `${d.region?.label || region} — cumulative fires, ${d.season?.label || "rice season"}`);
    firePanel.setText("sub", `${current?.year ?? ""} season to ${d.season?.end_effective || "date"}: ${num(h.fires, 0)} fires · `
      + `${pctText(n20.last_year?.pct_change)} vs ${n20.last_year?.year ?? "last year"} on the consistent NOAA-20 series.`);
    const labels = (d.days || []).map((s) => {
      const [m, dd] = String(s).split("-");
      const mon = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m)] || m;
      return `${dd} ${mon}`;
    });
    const datasets = [
      ...refs.map((y) => ({
        label: `${y.year}`, data: y.cum, borderColor: "rgba(148,163,184,0.35)", borderWidth: 1, pointRadius: 0, fill: false, order: 3,
      })),
    ];
    if (last) datasets.push({ label: `${last.year} (last)`, data: last.cum, borderColor: "#94a3b8", borderWidth: 1.8, borderDash: [5, 4], pointRadius: 0, fill: false, order: 2 });
    if (current) datasets.push({
      label: `${current.year} (this season)`, data: current.cum, borderColor: "#ef4444", backgroundColor: "rgba(239,68,68,0.15)",
      borderWidth: 2.6, pointRadius: (c) => (c.dataIndex === d.today_index ? 4 : 0), fill: true, spanGaps: false, order: 1,
    });
    firePanel.chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { labels, datasets },
      options: (() => {
        const o = baseOptions(undefined);
        o.scales.y.title.text = "Cumulative fires";
        o.scales.y.suggestedMax = undefined;
        o.plugins.legend.labels.filter = (i) => !/^\d{4}$/.test(i.text); // reference years: shown as one legend chip above
        o.plugins.tooltip = { filter: (i) => i.raw !== null && i.raw !== undefined };
        return o;
      })(),
    });
  } catch (err) {
    console.warn("[hawanama] fire season unavailable", err);
    firePanel.setText("title", "Season statistics unavailable");
    firePanel.setText("sub", "Fire-season data could not be loaded right now. Try again shortly.");
    ["todate", "yoy", "rank", "perday"].forEach((k) => setFireStat(k, "—"));
  } finally {
    firePanel.setLoader(false);
  }
}
