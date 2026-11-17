// iwmi-stats-modal.js
// Standalone stats panel for the IWMI flood-forecasting layers (GloFAS
// flood-alert points and Google Flood Hub gauges), opened from the feature
// popup's "Open Stats Panel" button. Same look and behaviour as the heatwave
// stats panel (#heatwave-stats-modal): it reuses that panel's CSS classes
// (stats grid on the left, tabbed chart on the right) and its drag/resize
// handler, with a flood-blue header (.iwmi-modal in _popup.css).

import Chart from "chart.js/auto";
import {
  ATTRIBUTION_FLOODHUB, ATTRIBUTION_GLOFAS, FLOODHUB_LEGEND, GLOFAS_LEGEND,
} from "./iwmi-flood-popups.js";

const MODAL_ID = "iwmi-stats-modal";
const CANVAS_ID = "iwmi-stats-modal-canvas";
const API = `${window.location.origin}/api/iwmi`;
const STATUS_LABEL = { normal: "Normal", warning: "Warning", danger: "Severe", extreme: "Extreme" };
const STATUS_VARIANT = { normal: "aqi-good", warning: "aqi-moderate", danger: "aqi-unhealthy", extreme: "aqi-hazardous" };
const SEVERITY_VARIANT = { NO_FLOODING: "aqi-good", ABOVE_NORMAL: "aqi-moderate", SEVERE: "aqi-unhealthy", EXTREME: "aqi-hazardous" };
const TREND_ARROW = { RISE: "▲ Rising", FALL: "▼ Falling", NO_CHANGE: "▬ Steady" };
const THEME = { text: "#e2e8f0", grid: "rgba(148,163,184,0.18)", flow: "#38bdf8", past: "#94a3b8" };

let _chart = null;
const _cache = new Map(); // url -> payload

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function num(v, digits = 0, suffix = "") {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n)
    ? "—"
    : `${n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}${suffix}`;
}

function pkt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso)
    : d.toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) + " PKT";
}

function stat(label, value, extraClass = "") {
  return `<div class="heatwave-stat ${extraClass}"><div class="heatwave-stat__label">${esc(label)}</div><div class="heatwave-stat__value" title="${esc(String(value).replace(/<[^>]+>/g, ""))}">${value}</div></div>`;
}

function legendRow(entries) {
  return entries.map((e) =>
    `<span class="iwmi-modal__legend-item"><span class="iwmi-modal__legend-dot" style="background:${e.color};"></span>${esc(e.label)}</span>`).join("");
}

// ---------------------------------------------------------------------------
// Modal shell (built once; same markup/classes as the heatwave panel)
// ---------------------------------------------------------------------------

async function ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = MODAL_ID;
  modal.className = "heatwave-modal iwmi-modal hidden";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "River flood stats");
  modal.innerHTML = `
    <div class="heatwave-modal__head" data-heatwave-drag>
      <div class="heatwave-modal__drag-grip" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="heatwave-modal__title-block">
        <div class="heatwave-modal__kicker" id="iwmi-modal-kicker">River Flood Forecast</div>
        <div class="heatwave-modal__title" id="iwmi-modal-name">—</div>
        <div class="heatwave-modal__subtitle" id="iwmi-modal-meta"></div>
      </div>
      <span class="heatwave-modal__badge ncop-popup__badge ncop-popup__badge--neutral" id="iwmi-modal-badge">—</span>
      <button type="button" class="heatwave-modal__close" aria-label="Close" data-heatwave-close data-iwmi-close>×</button>
    </div>
    <div class="heatwave-modal__body">
      <aside class="heatwave-modal__left">
        <div class="heatwave-modal__stats" id="iwmi-modal-stats"></div>
      </aside>
      <section class="heatwave-modal__right">
        <div class="heatwave-modal__tabs" role="tablist" id="iwmi-modal-tabs"></div>
        <div class="heatwave-modal__chart-wrap">
          <div class="heatwave-modal__chart-head">
            <div class="heatwave-modal__chart-title" id="iwmi-modal-title">—</div>
            <div class="heatwave-modal__chart-sub" id="iwmi-modal-sub">Loading…</div>
          </div>
          <div class="iwmi-modal__legend" id="iwmi-modal-legend"></div>
          <div class="heatwave-modal__canvas-host">
            <canvas id="${CANVAS_ID}"></canvas>
            <div class="heatwave-modal__loader" id="iwmi-modal-loader"><span></span><span></span><span></span></div>
          </div>
          <div class="heatwave-modal__footnote" id="iwmi-modal-footnote"></div>
        </div>
      </section>
    </div>
    <div class="heatwave-modal__resize" data-heatwave-resize aria-label="Resize">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 6 L6 14 M14 10 L10 14" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
    </div>`;
  document.body.appendChild(modal);

  modal.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-iwmi-close]")) {
      hideIwmiStatsModal();
      return;
    }
    const tab = ev.target.closest(".heatwave-modal__tab");
    if (tab && modal._ctx) {
      modal.querySelectorAll(".heatwave-modal__tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      renderTab(modal._ctx, tab.getAttribute("data-mode"));
    }
  });
  // Same drag/resize behaviour as the heatwave panel. Loaded lazily: a
  // static import would form a cycle (layer-attribute-popup.js imports the
  // IWMI popups, which open this panel).
  try {
    const { attachHeatwaveDragAndResize } = await import("./layer-attribute-popup.js");
    attachHeatwaveDragAndResize(modal);
  } catch (err) {
    console.warn("[iwmi] stats panel drag/resize unavailable", err);
  }
  return modal;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setLoader(on) {
  const el = document.getElementById("iwmi-modal-loader");
  if (el) el.style.display = on ? "flex" : "none";
}

function destroyChart() {
  if (_chart) {
    try { _chart.destroy(); } catch (_) {}
    _chart = null;
  }
}

export function hideIwmiStatsModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.add("hidden");
  modal.classList.remove("is-open");
  destroyChart();
}

async function getJson(url) {
  if (_cache.has(url)) return _cache.get(url);
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  _cache.set(url, data);
  if (_cache.size > 60) _cache.delete(_cache.keys().next().value);
  return data;
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/** ctx = {kind: "glofas"|"floodhub", props, dayLead?} */
export async function showIwmiStatsModal(ctx) {
  const modal = await ensureModal();
  modal._ctx = ctx;
  modal.classList.remove("hidden");
  modal.classList.add("is-open");
  const p = ctx.props || {};
  const tabs = document.getElementById("iwmi-modal-tabs");
  const badge = document.getElementById("iwmi-modal-badge");
  const statsEl = document.getElementById("iwmi-modal-stats");

  if (ctx.kind === "glofas") {
    const status = ctx.dayLead ? (p[`s_${ctx.dayLead}`] || "normal") : (p.status || "normal");
    const unreliable = p.quality === "unreliable";
    setText("iwmi-modal-kicker", "GloFAS River Discharge");
    setText("iwmi-modal-name", p.river ? `${p.river} — point ${p.id}` : `GloFAS point ${p.id}`);
    setText("iwmi-modal-meta", `${p.iso3 || ""} · forecast run ${p.forecast_date || "—"}${ctx.dayLead ? ` · viewing day +${ctx.dayLead}` : ""}`);
    if (badge) {
      badge.textContent = unreliable ? "Unreliable" : (STATUS_LABEL[status] || status);
      badge.className = `heatwave-modal__badge ncop-popup__badge ncop-popup__badge--${unreliable ? "neutral" : (STATUS_VARIANT[status] || "neutral")}`;
    }
    if (tabs) tabs.innerHTML = `
      <button class="heatwave-modal__tab is-active" data-mode="discharge" type="button">Discharge (45 days)</button>
      <button class="heatwave-modal__tab" data-mode="probability" type="button">Exceedance Probability</button>`;
    const peak = Number(p.peak_prob) > 0 ? `${num(Number(p.peak_prob) * 100, 0, "%")} · day +${esc(p.peak_lead)}` : "None ≥ 30%";
    if (statsEl) statsEl.innerHTML = [
      stat("Status", unreliable ? "Unreliable point" : esc(STATUS_LABEL[status] || status), "heatwave-stat--temp"),
      stat("Peak exceedance", peak, "heatwave-stat--feels"),
      stat("Warning level", num(p.warning, 0, " m³/s")),
      stat("Severe level", num(p.danger, 0, " m³/s")),
      stat("Extreme level", num(p.extreme, 0, " m³/s")),
      stat("Forecast run", esc(p.forecast_date || "—")),
      `<div class="heatwave-stat" id="iwmi-modal-flow-now"><div class="heatwave-stat__label">Day +1 flow</div><div class="heatwave-stat__value">…</div></div>`,
      `<div class="heatwave-stat" id="iwmi-modal-flow-peak"><div class="heatwave-stat__label">15-day max flow</div><div class="heatwave-stat__value">…</div></div>`,
    ].join("") + (unreliable ? `<div class="iwmi-modal__warning">Forecast flow never reaches 3% of this point's warning level — it is most likely matched to a dry or wrong model cell and cannot signal a flood. Do not read "Normal" here as an all-clear.</div>` : "");
    setText("iwmi-modal-footnote", `Data: ${ATTRIBUTION_GLOFAS}. Status = worst threshold whose estimated exceedance probability reaches 30% (GloFAS reporting-point rule).`);
    renderTab(ctx, "discharge");
  } else {
    const sev = p.severity || "NO_FLOODING";
    const sevLabel = (FLOODHUB_LEGEND.find((e) => e.severity === sev) || {}).label || sev;
    setText("iwmi-modal-kicker", "Google Flood Hub");
    setText("iwmi-modal-name", p.river ? `${p.river} — gauge` : "River gauge");
    setText("iwmi-modal-meta", `${p.iso3 || ""} · ${p.gauge_id || ""} · issued ${pkt(p.issued_time)}`);
    if (badge) {
      badge.textContent = sevLabel;
      badge.className = `heatwave-modal__badge ncop-popup__badge ncop-popup__badge--${SEVERITY_VARIANT[sev] || "neutral"}`;
    }
    if (tabs) tabs.innerHTML = `<button class="heatwave-modal__tab is-active" data-mode="discharge" type="button">Discharge (history + forecast)</button>`;
    if (statsEl) statsEl.innerHTML = [
      stat("Severity", esc(sevLabel), "heatwave-stat--temp"),
      stat("Trend", esc(TREND_ARROW[p.trend] || p.trend || "—"), "heatwave-stat--feels"),
      stat("Warning level", num(p.warning, 1, " m³/s")),
      stat("Danger level", num(p.danger, 1, " m³/s")),
      stat("Extreme level", num(p.extreme, 1, " m³/s")),
      stat("Forecast window", `${esc(pkt(p.forecast_start))}`),
      `<div class="heatwave-stat" id="iwmi-modal-flow-now"><div class="heatwave-stat__label">Latest flow</div><div class="heatwave-stat__value">…</div></div>`,
      `<div class="heatwave-stat" id="iwmi-modal-flow-peak"><div class="heatwave-stat__label">Forecast max</div><div class="heatwave-stat__value">…</div></div>`,
    ].join("");
    setText("iwmi-modal-footnote", `Data: ${ATTRIBUTION_FLOODHUB}. AI-modelled flow on a HydroBASINS river reach (virtual gauge).`);
    renderTab(ctx, "discharge");
  }
}

function setFlowStats(now, peak) {
  const a = document.querySelector("#iwmi-modal-flow-now .heatwave-stat__value");
  const b = document.querySelector("#iwmi-modal-flow-peak .heatwave-stat__value");
  if (a) a.textContent = now;
  if (b) b.textContent = peak;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function baseOptions(yTitle, yMax) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { color: THEME.text, font: { size: 10 }, maxTicksLimit: 12 }, grid: { color: THEME.grid } },
      y: { beginAtZero: true, max: yMax, ticks: { color: THEME.text, font: { size: 10 } }, grid: { color: THEME.grid },
           title: { display: !!yTitle, text: yTitle, color: THEME.text, font: { size: 10 } } },
    },
    plugins: { legend: { labels: { color: THEME.text, font: { size: 10 }, boxWidth: 12 } } },
  };
}

async function renderTab(ctx, mode) {
  destroyChart();
  setLoader(true);
  const canvas = document.getElementById(CANVAS_ID);
  const legend = document.getElementById("iwmi-modal-legend");
  try {
    if (ctx.kind === "glofas") {
      const d = await getJson(`${API}/glofas/points/${encodeURIComponent(ctx.props.id)}/discharge/`);
      if (document.getElementById(MODAL_ID)?._ctx !== ctx) return; // a newer feature was opened meanwhile
      const fut = (d.series || []).filter((r) => r.lead_day >= 1);
      setFlowStats(num(fut[0]?.median, 0, " m³/s"), num(Math.max(...fut.map((r) => r.median ?? 0)), 0, " m³/s"));
      if (legend) legend.innerHTML = legendRow(GLOFAS_LEGEND);
      if (mode === "probability") renderGlofasProbability(canvas, d);
      else renderGlofasDischarge(canvas, d);
    } else {
      const d = await getJson(`${API}/floodhub/gauges/${encodeURIComponent(ctx.props.gauge_id)}/discharge/`);
      if (document.getElementById(MODAL_ID)?._ctx !== ctx) return;
      const hist = d.history || [];
      const fc = d.forecast || [];
      setFlowStats(num(hist.at(-1)?.v, 1, " m³/s"), num(Math.max(0, ...fc.map((r) => r.v ?? 0)), 1, " m³/s"));
      if (legend) legend.innerHTML = legendRow(FLOODHUB_LEGEND.map((e) => ({ ...e, label: e.label === "Above normal" ? "Warning" : e.label === "Severe" ? "Danger" : e.label }))
        .filter((e) => e.label !== "No flooding"));
      renderFloodhubDischarge(canvas, d);
    }
  } catch (err) {
    console.warn("[iwmi] stats panel data unavailable", err);
    setText("iwmi-modal-title", "Data unavailable");
    setText("iwmi-modal-sub", "The forecast series could not be loaded right now. Try again shortly.");
    setFlowStats("—", "—");
  } finally {
    setLoader(false);
  }
}

function renderGlofasDischarge(canvas, d) {
  const s = d.series || [];
  const thr = d.thresholds || {};
  const labels = s.map((r) => {
    const dt = new Date(`${r.valid_date}T00:00:00Z`);
    return Number.isNaN(dt.getTime()) ? r.valid_date : dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  });
  const flat = (v) => s.map(() => (v === null || v === undefined ? null : Number(v)));
  const flowMax = Math.max(0, ...s.flatMap((r) => [r.median, r.hi]).filter((v) => v !== null && v !== undefined));
  setText("iwmi-modal-title", "Discharge — 30 days back, 15 days forward");
  setText("iwmi-modal-sub", `Run ${d.forecast_date}. Grey dashed: each past run's day-1 forecast (not observed flow). Blue: forecast ensemble mean, shaded ±1 SD.`);
  _chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "+1 SD", data: s.map((r) => r.hi), borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(56,189,248,0.20)", fill: "+1" },
        { label: "−1 SD", data: s.map((r) => r.lo), borderWidth: 0, pointRadius: 0, fill: false },
        { label: "Recent forecasts", data: s.map((r) => (r.lead_day <= 0 ? r.median : null)), borderColor: THEME.past, borderDash: [4, 4], borderWidth: 1.8, pointRadius: 0, tension: 0.25 },
        { label: "Forecast (mean)", data: s.map((r) => (r.lead_day >= 0 ? r.median : null)), borderColor: THEME.flow, borderWidth: 2.4, pointRadius: 2.5, tension: 0.25 },
        { label: "Warning", data: flat(thr.warning), borderColor: "#E7B416", borderDash: [7, 5], borderWidth: 1.4, pointRadius: 0 },
        { label: "Severe", data: flat(thr.danger), borderColor: "#E2683C", borderDash: [7, 5], borderWidth: 1.4, pointRadius: 0 },
        { label: "Extreme", data: flat(thr.extreme), borderColor: "#a11", borderDash: [7, 5], borderWidth: 1.4, pointRadius: 0 },
      ],
    },
    options: (() => {
      const o = baseOptions("m³/s", Math.max(flowMax, Number(thr.warning) || 0) * 1.25 || undefined);
      o.plugins.legend.labels.filter = (i) => !["+1 SD", "−1 SD"].includes(i.text);
      o.plugins.tooltip = {
        filter: (i) => i.raw !== null && !["+1 SD", "−1 SD"].includes(i.dataset.label),
        callbacks: {
          afterBody: (items) => {
            const r = s[items[0]?.dataIndex];
            if (!r) return [];
            if (r.lead_day < 1) return ["(day-1 forecast of a past run)"];
            const pct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
            return [`Day +${r.lead_day} · band ${num(r.lo)}–${num(r.hi)} m³/s`,
                    `P(>Warning) ${pct(r.p_warn)} · P(>Severe) ${pct(r.p_danger)} · P(>Extreme) ${pct(r.p_extreme)}`];
          },
        },
      };
      return o;
    })(),
  });
}

function renderGlofasProbability(canvas, d) {
  const s = (d.series || []).filter((r) => r.lead_day >= 1);
  const labels = s.map((r) => `+${r.lead_day}d`);
  const pct = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 10);
  setText("iwmi-modal-title", "Exceedance probability by forecast day");
  setText("iwmi-modal-sub", "Estimated chance the flow exceeds each threshold. A day reaches a status when its probability is ≥ 30% (dashed line).");
  _chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "P(>Warning)", data: s.map((r) => pct(r.p_warn)), backgroundColor: "#E7B416" },
        { label: "P(>Severe)", data: s.map((r) => pct(r.p_danger)), backgroundColor: "#E2683C" },
        { label: "P(>Extreme)", data: s.map((r) => pct(r.p_extreme)), backgroundColor: "#640000" },
        { type: "line", label: "30% alert cut-off", data: s.map(() => 30), borderColor: "#e2e8f0", borderDash: [5, 4], borderWidth: 1.2, pointRadius: 0 },
      ],
    },
    options: (() => {
      const o = baseOptions("%", 100);
      o.plugins.tooltip = { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw ?? "—"}%` } };
      return o;
    })(),
  });
}

function renderFloodhubDischarge(canvas, d) {
  const rows = [...(d.history || []).map((r) => ({ ...r, kind: "h" })), ...(d.forecast || []).map((r) => ({ ...r, kind: "f" }))];
  const thr = d.thresholds || {};
  const lastHist = rows.map((r) => r.kind).lastIndexOf("h");
  const labels = rows.map((r) => {
    const dt = new Date(r.t);
    return Number.isNaN(dt.getTime()) ? r.t : dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "Asia/Karachi" });
  });
  const flat = (v) => rows.map(() => (v === null || v === undefined ? null : Number(v)));
  const yMax = Math.max(0, ...rows.map((r) => r.v || 0), Number(thr.warning) || 0) * 1.25 || undefined;
  setText("iwmi-modal-title", "Discharge — recent and forecast");
  setText("iwmi-modal-sub", `Issued ${pkt(d.issued_time)}. Grey: recent modelled flow. Blue: forecast. Dashed: gauge warning / danger / extreme levels.`);
  _chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Recent", data: rows.map((r, i) => (i <= lastHist ? r.v : null)), borderColor: THEME.past, borderWidth: 2, pointRadius: 2, tension: 0.25 },
        { label: "Forecast", data: rows.map((r, i) => (i >= lastHist ? r.v : null)), borderColor: THEME.flow, borderWidth: 2.4, pointRadius: 3, tension: 0.25 },
        { label: "Warning", data: flat(thr.warning), borderColor: "#E7B416", borderDash: [7, 5], borderWidth: 1.4, pointRadius: 0 },
        { label: "Danger", data: flat(thr.danger), borderColor: "#E2683C", borderDash: [7, 5], borderWidth: 1.4, pointRadius: 0 },
        { label: "Extreme", data: flat(thr.extreme), borderColor: "#a11", borderDash: [7, 5], borderWidth: 1.4, pointRadius: 0 },
      ],
    },
    options: baseOptions(d.unit || "m³/s", yMax),
  });
}

// ---------------------------------------------------------------------------
// Popup button wiring
// ---------------------------------------------------------------------------

const _pending = new Map(); // button id -> ctx

export function registerIwmiStatsButton(buttonId, ctx) {
  _pending.set(buttonId, ctx);
  if (_pending.size > 50) _pending.delete(_pending.keys().next().value);
}

let _installed = false;
export function setupIwmiStatsButtonHandler() {
  if (_installed) return;
  _installed = true;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".iwmi-open-stats");
    if (!btn) return;
    const ctx = _pending.get(btn.id);
    if (ctx) showIwmiStatsModal(ctx);
  });
}
