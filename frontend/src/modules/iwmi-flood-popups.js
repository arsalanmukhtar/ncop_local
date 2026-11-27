// iwmi-flood-popups.js
// Slim popups for the IWMI flood-forecasting layers in the Flood Monitoring
// accordion — GloFAS flood-alert points (and their forecast-day slider
// frames) and Google Flood Hub river gauges. Same pattern as the heatwave
// popup: identity, status badge and a few key numbers, plus an
// "Open Stats Panel" button that opens the full stats panel with the
// discharge / exceedance charts (iwmi-stats-modal.js). Wired from
// layer-attribute-popup.js next to the Hawanama/WAQI/FFD special cases.

import { registerIwmiStatsButton, setupIwmiStatsButtonHandler } from "./iwmi-stats-modal.js";

export const ATTRIBUTION_GLOFAS = "CEMS GloFAS (Copernicus) via IWMI ENSO Outlook";
export const ATTRIBUTION_FLOODHUB = "Google Flood Forecasting, CC BY 4.0 (via IWMI ENSO Outlook)";
export const GLOFAS_LEGEND = [
  { status: "extreme", label: "Extreme", color: "#640000" },
  { status: "danger", label: "Severe", color: "#E2683C" },
  { status: "warning", label: "Warning", color: "#E7B416" },
  { status: "normal", label: "Normal", color: "#3FA34D" },
];
export const FLOODHUB_LEGEND = [
  { severity: "EXTREME", label: "Extreme", color: "#640000" },
  { severity: "SEVERE", label: "Severe", color: "#E2683C" },
  { severity: "ABOVE_NORMAL", label: "Above normal", color: "#E7B416" },
  { severity: "NO_FLOODING", label: "No flooding", color: "#3FA34D" },
];
const STATUS_LABEL = { normal: "Normal", warning: "Warning", danger: "Severe", extreme: "Extreme" };
const STATUS_VARIANT = { normal: "aqi-good", warning: "aqi-moderate", danger: "aqi-unhealthy", extreme: "aqi-hazardous" };
const SEVERITY_VARIANT = { NO_FLOODING: "aqi-good", ABOVE_NORMAL: "aqi-moderate", SEVERE: "aqi-unhealthy", EXTREME: "aqi-hazardous" };
const TREND_ARROW = { RISE: "▲ rising", FALL: "▼ falling", NO_CHANGE: "▬ steady" };

const OPEN_STATS_ARROW = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7"/></svg>`;

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function num(v, digits = 0, suffix = "") {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n)
    ? "—"
    : `${n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}${suffix}`;
}

function uid(p) {
  return `${p}-${Math.random().toString(36).slice(2, 11)}`;
}

function openStatsButton(ctx) {
  const id = uid("iwmi-stats-btn");
  registerIwmiStatsButton(id, ctx);
  return `<button type="button" id="${id}" class="iwmi-open-stats">Open Stats Panel ${OPEN_STATS_ARROW}</button>`;
}

// ---------------------------------------------------------------------------
// GloFAS flood-alert point
// ---------------------------------------------------------------------------

export function buildGlofasPopup(p, dayLead = null) {
  const status = dayLead ? (p[`s_${dayLead}`] || "normal") : (p.status || "normal");
  const unreliable = p.quality === "unreliable";
  const where = [p.river, p.iso3].filter(Boolean).join(" · ") || p.iso3 || "";
  const badge = unreliable
    ? `<span class="ncop-popup__badge ncop-popup__badge--neutral">Unreliable</span>`
    : `<span class="ncop-popup__badge ncop-popup__badge--${STATUS_VARIANT[status] || "neutral"}">${esc(STATUS_LABEL[status] || status)}</span>`;
  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">GloFAS point ${esc(p.id)}</div>
        <div class="ncop-popup__subtitle">${esc(where)}${dayLead ? ` · forecast day +${esc(dayLead)}` : ""}</div>
      </div>
      ${badge}
    </div>`;
  const peak = !dayLead && Number(p.peak_prob) > 0
    ? `${num(Number(p.peak_prob) * 100, 0, "%")} on day +${esc(p.peak_lead)}` : "none ≥ 30%";
  const drawer = `
    <div class="heatwave-popup-body">
      ${unreliable ? `<div class="iwmi-popup-warning">Unreliable point: forecast flow never reaches 3% of its warning level, so it can only read "Normal". Not an all-clear.</div>` : ""}
      <div class="ncop-popup__info" style="margin:0;">
        ${dayLead ? `<p class="ncop-popup__info-row"><strong>Flow day +${esc(dayLead)}:</strong> ${num(p[`q_${dayLead}`], 0, " m³/s")}</p>` : ""}
        <p class="ncop-popup__info-row"><strong>Warning level:</strong> ${num(p.warning, 0, " m³/s")}</p>
        <p class="ncop-popup__info-row"><strong>Peak exceedance:</strong> ${peak}</p>
        <p class="ncop-popup__info-row"><strong>Forecast run:</strong> ${esc(p.forecast_date || "—")}</p>
      </div>
      ${openStatsButton({ kind: "glofas", props: { ...p }, dayLead })}
    </div>`;
  return { primary, drawer, drawerTitle: "GloFAS River Discharge" };
}

// ---------------------------------------------------------------------------
// Google Flood Hub gauge
// ---------------------------------------------------------------------------

export function buildFloodhubPopup(p) {
  const sev = p.severity || "NO_FLOODING";
  const label = (FLOODHUB_LEGEND.find((e) => e.severity === sev) || {}).label || p.severity_label || sev;
  const where = [p.river, p.site_name, p.iso3].filter(Boolean).join(" · ");
  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">Flood Hub gauge</div>
        <div class="ncop-popup__subtitle">${esc(where)}</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${SEVERITY_VARIANT[sev] || "neutral"}">${esc(label)}</span>
    </div>`;
  const drawer = `
    <div class="heatwave-popup-body">
      <div class="ncop-popup__info" style="margin:0;">
        <p class="ncop-popup__info-row"><strong>Trend:</strong> ${esc(TREND_ARROW[p.trend] || p.trend || "—")}</p>
        <p class="ncop-popup__info-row"><strong>Warning level:</strong> ${num(p.warning, 1, " m³/s")}</p>
        <p class="ncop-popup__info-row"><strong>Gauge:</strong> ${esc(p.gauge_id)}</p>
      </div>
      ${openStatsButton({ kind: "floodhub", props: { ...p } })}
    </div>`;
  return { primary, drawer, drawerTitle: "Google Flood Hub" };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** {primary, drawer, drawerTitle} for an IWMI vector feature, or null. */
export function buildIwmiPopup(layerId, sourceId, props) {
  const id = `${layerId || ""} ${sourceId || ""}`;
  const day = /iwmi_glofas_day_(\d+)/.exec(id);
  if (day) return buildGlofasPopup(props, Number(day[1]));
  if (id.includes("iwmi_glofas_points")) return buildGlofasPopup(props);
  if (id.includes("iwmi_floodhub_gauges")) return buildFloodhubPopup(props);
  return null;
}

export function setupIwmiPopupEventHandlers() {
  setupIwmiStatsButtonHandler();
}
