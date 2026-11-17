// hawanama-popups.js
// Popup content for the Hawanama (Pakistan Air Quality Initiative) layers —
// live stations, station nowcast, daily station archive and the fire
// smoke-source outlook — plus the click handler for the daily PM2.5
// estimate raster on temp-slider1. Wired from layer-attribute-popup.js
// (vector layers) and map-layers.js (raster click), alongside the WAQI
// and FFD special cases there. Data via NCOP's /api/hawanama/ proxy;
// every popup carries the CC BY 4.0 attribution.

import { showHawanamaFireStatsModal, showHawanamaStatsModal } from "./hawanama-stats-modal.js";

export const HAWANAMA_ATTRIBUTION = "Pakistan Air Quality Initiative (Hawanama), CC BY 4.0";
const API = `${window.location.origin}/api/hawanama`;

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmt(v, digits = 1, suffix = "") {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}${suffix}`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }) + " PKT";
}

// US AQI badge variant from an AQI number (same bands as the WAQI popup).
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

// US EPA PM2.5 (24 h) breakpoints, 2024 revision — for layers that carry
// PM2.5 but no AQI (nowcast, daily archive, estimate).
export function pm25Variant(pm25) {
  const n = Number(pm25);
  if (!Number.isFinite(n)) return "neutral";
  if (n <= 9) return "aqi-good";
  if (n <= 35.4) return "aqi-moderate";
  if (n <= 55.4) return "aqi-usg";
  if (n <= 125.4) return "aqi-unhealthy";
  if (n <= 225.4) return "aqi-very-unhealthy";
  return "aqi-hazardous";
}

const PM25_LABEL = {
  "aqi-good": "Good", "aqi-moderate": "Moderate", "aqi-usg": "Unhealthy (sensitive)",
  "aqi-unhealthy": "Unhealthy", "aqi-very-unhealthy": "Very unhealthy", "aqi-hazardous": "Hazardous", neutral: "No data",
};

function card(label, value) {
  return `<div class="ncop-popup__card"><div class="ncop-popup__card-label">${esc(label)}</div><div class="ncop-popup__card-value">${value}</div></div>`;
}

function attributionNote(extra = "") {
  return `<div class="ncop-popup__status-note" style="display:block;margin-top:6px;line-height:1.3;">${extra ? `${esc(extra)}<br>` : ""}Data: ${esc(HAWANAMA_ATTRIBUTION)}</div>`;
}

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 11)}`;
}

// ---------------------------------------------------------------------------
// Live stations
// ---------------------------------------------------------------------------

const _stationCtx = new Map(); // button id -> station properties (bounded)

export function buildHawanamaStationPopup(p) {
  const btnId = uid("hwn-stats-btn");
  _stationCtx.set(btnId, { ...p });
  if (_stationCtx.size > 50) _stationCtx.delete(_stationCtx.keys().next().value);
  const stale = p.reading_stale === true || p.reading_stale === "true";
  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${esc(p.name)}</div>
        <div class="ncop-popup__subtitle">${esc(p.city || "")}${p.network ? ` · ${esc(p.network)}` : ""}</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${aqiVariant(p.aqi)}">AQI ${esc(p.aqi ?? "—")}</span>
    </div>`;
  const drawer = `
    <div class="ncop-popup__grid ncop-popup__grid--triple">
      ${card("PM2.5", fmt(p.pm25, 0, " µg/m³"))}
      ${card("Temp", fmt(p.temp, 0, " °C"))}
      ${card("Humidity", fmt(p.hum, 0, " %"))}
    </div>
    <div class="ncop-popup__info">
      <p class="ncop-popup__info-row"><strong>Last reading:</strong> ${esc(fmtTime(p.last_reading))}${stale ? " <em>(stale)</em>" : ""}</p>
      <p class="ncop-popup__info-row"><strong>Network:</strong> ${esc(p.network || "—")} · <strong>QC:</strong> ${esc(p.qc_state || "—")}</p>
    </div>
    <button type="button" id="${btnId}" class="hawanama-open-stats">
      Open Stats Panel
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7"/></svg>
    </button>
    ${attributionNote()}`;
  return { primary, drawer, drawerTitle: "Hawanama Station" };
}

// ---------------------------------------------------------------------------
// Station nowcast (temporal frames)
// ---------------------------------------------------------------------------

export function buildHawanamaNowcastPopup(p) {
  const lead = Number(p._lead_h);
  const pm = p[`pm25_${lead}`];
  const forecastable = p.forecastable === true || p.forecastable === "true";
  const variant = pm25Variant(pm);
  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${esc(p.name)}</div>
        <div class="ncop-popup__subtitle">${esc(p.city || "")} · PM2.5 nowcast +${lead} h</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${variant}">${fmt(pm, 0)} µg/m³</span>
    </div>`;
  const drawer = `
    <div class="ncop-popup__grid ncop-popup__grid--triple">
      ${card("Expected", fmt(pm, 1))}
      ${card("75th pct", fmt(p[`q75_${lead}`], 1))}
      ${card("90th pct", fmt(p[`q90_${lead}`], 1))}
    </div>
    <div class="ncop-popup__info">
      <p class="ncop-popup__info-row"><strong>Valid:</strong> ${esc(fmtTime(p[`valid_${lead}`]))}</p>
      <p class="ncop-popup__info-row"><strong>Category:</strong> ${esc(PM25_LABEL[variant])}</p>
      <p class="ncop-popup__info-row"><strong>Basis:</strong> ${esc(p.basis || "—")}${forecastable ? "" : " — <em>not directly forecastable; estimated from neighbouring stations</em>"}</p>
      <p class="ncop-popup__info-row"><strong>Last observed:</strong> ${fmt(p.last_obs, 0, " µg/m³")} (${fmt(p.obs_age_h, 0, " h ago")})</p>
    </div>
    ${attributionNote("Station nowcast (model v1). The 75th/90th percentiles show the forecast's own uncertainty.")}`;
  return { primary, drawer, drawerTitle: "Hawanama Nowcast" };
}

// ---------------------------------------------------------------------------
// Daily station archive (synced to the estimate's slider date)
// ---------------------------------------------------------------------------

export function buildHawanamaDailyStationPopup(p) {
  const variant = pm25Variant(p.pm25);
  const complete = p.complete === true || p.complete === "true";
  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${esc(p.name)}</div>
        <div class="ncop-popup__subtitle">${esc(p.city || "")} · daily mean ${esc(p.date || "")}</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${variant}">${fmt(p.pm25, 0)} µg/m³</span>
    </div>`;
  const drawer = `
    <div class="ncop-popup__info">
      <p class="ncop-popup__info-row"><strong>Category:</strong> ${esc(PM25_LABEL[variant])}</p>
      <p class="ncop-popup__info-row"><strong>Hours with data:</strong> ${esc(p.valid_hours ?? "—")}${complete ? "" : " (partial day)"}</p>
      <p class="ncop-popup__info-row"><strong>Network:</strong> ${esc(p.network || "—")}</p>
    </div>
    ${attributionNote("Ground station daily mean — compare with the PM2.5 estimate colour under it.")}`;
  return { primary, drawer, drawerTitle: "Hawanama Daily Station" };
}

// ---------------------------------------------------------------------------
// Fire smoke-source outlook
// ---------------------------------------------------------------------------

const _fireCtx = new Map(); // button id -> fire-outlook city properties (bounded)

const FIRE_BAND_VARIANT = {
  none: "aqi-good", low: "aqi-moderate", elevated: "aqi-usg", high: "aqi-unhealthy", very_high: "aqi-very-unhealthy",
};

export function buildHawanamaFirePopup(p) {
  const btnId = uid("hwnfire-stats-btn");
  _fireCtx.set(btnId, { ...p });
  if (_fireCtx.size > 50) _fireCtx.delete(_fireCtx.keys().next().value);
  let byCountry = {};
  try { byCountry = typeof p.by_country === "string" ? JSON.parse(p.by_country) : (p.by_country || {}); } catch (_) {}
  const countries = Object.entries(byCountry).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(", ") || "—";
  const band = String(p.band || "none");
  const primary = `
    <div class="ncop-popup__header">
      <div class="ncop-popup__title-block">
        <div class="ncop-popup__title">${esc(p.city)}</div>
        <div class="ncop-popup__subtitle">${esc(p.province || "")} · smoke-source outlook (next day)</div>
      </div>
      <span class="ncop-popup__badge ncop-popup__badge--${FIRE_BAND_VARIANT[band] || "neutral"}">${esc(band.replace("_", " "))}</span>
    </div>`;
  const drawer = `
    <div class="ncop-popup__grid ncop-popup__grid--triple">
      ${card("Upwind fire load", fmt(p.upwind_load_mw, 0, " MW"))}
      ${card("Fires upwind", esc(p.fires_in_cone ?? "—"))}
      ${card("Wind from", esc(p.from_compass || "—"))}
    </div>
    <div class="ncop-popup__info">
      <p class="ncop-popup__info-row"><strong>Fires by country:</strong> ${countries}</p>
    </div>
    <button type="button" id="${btnId}" class="hawanama-open-stats hawanama-open-stats--fire">
      Open Stats Panel
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 5l7 7-7 7"/></svg>
    </button>
    ${attributionNote("A smoke-source outlook, not a PM2.5 forecast: fire load upwind is consistent with smoke transport, not proof that it causes local PM2.5. Bands are unvalidated screening categories.")}`;
  return { primary, drawer, drawerTitle: "Fire Smoke Outlook" };
}

// ---------------------------------------------------------------------------
// Dispatch + document-level click handling
// ---------------------------------------------------------------------------

/** Returns {primary, drawer, drawerTitle} for a Hawanama vector feature, or null. */
export function buildHawanamaPopup(layerId, sourceId, props) {
  const id = `${layerId || ""} ${sourceId || ""}`;
  if (id.includes("hawanama_nowcast")) {
    const m = /hawanama_nowcast_(\d+)/.exec(id);
    return buildHawanamaNowcastPopup({ ...props, _lead_h: m ? m[1] : props._lead_h });
  }
  if (id.includes("hawanama_daily_stations")) return buildHawanamaDailyStationPopup(props);
  if (id.includes("hawanama_fire_outlook")) return buildHawanamaFirePopup(props);
  if (id.includes("hawanama_stations")) return buildHawanamaStationPopup(props);
  return null;
}

let _handlerInstalled = false;
export function setupHawanamaPopupEventHandlers() {
  if (_handlerInstalled) return;
  _handlerInstalled = true;
  document.addEventListener("click", (e) => {
    const statsBtn = e.target.closest?.(".hawanama-open-stats");
    if (!statsBtn) return;
    const station = _stationCtx.get(statsBtn.id);
    if (station) { showHawanamaStatsModal({ props: station }); return; }
    const city = _fireCtx.get(statsBtn.id);
    if (city) showHawanamaFireStatsModal({ props: city });
  });
}
