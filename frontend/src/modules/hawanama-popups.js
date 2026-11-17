// hawanama-popups.js
// Popup content for the Hawanama (Pakistan Air Quality Initiative) layers —
// live stations, station nowcast, daily station archive and the fire
// smoke-source outlook — plus the click handler for the daily PM2.5
// estimate raster on temp-slider1. Wired from layer-attribute-popup.js
// (vector layers) and map-layers.js (raster click), alongside the WAQI
// and FFD special cases there. Data via NCOP's /api/hawanama/ proxy;
// every popup carries the CC BY 4.0 attribution.

import Chart from "chart.js/auto";

export const HAWANAMA_ATTRIBUTION = "Pakistan Air Quality Initiative (Hawanama), CC BY 4.0";
const API = `${window.location.origin}/api/hawanama`;
const MAX_CHARTS = 40;
const _charts = new Map();

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

export function buildHawanamaStationPopup(p) {
  const popupId = uid("hwn");
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
    <div class="ncop-popup__actions" style="border-top:none;padding:6px 0;background:transparent;">
      <button class="ncop-popup__button ncop-popup__button--primary hawanama-history-btn"
              data-station-id="${esc(p.id)}" data-popup-id="${popupId}" data-loaded="false">Show PM2.5 history</button>
    </div>
    <div id="hwn-chart-wrap-${popupId}" class="ncop-popup__chart" style="display:none;">
      <div class="ncop-popup__pills">
        <button class="ncop-popup__pill hawanama-history-range" data-range="hourly" data-popup-id="${popupId}">48 hours</button>
        <button class="ncop-popup__pill hawanama-history-range" data-range="daily" data-popup-id="${popupId}">30 days</button>
      </div>
      <canvas id="hwn-chart-${popupId}" style="width:230px;height:140px;max-width:100%;"></canvas>
      <div id="hwn-chart-note-${popupId}" class="ncop-popup__status-note" style="display:block;"></div>
    </div>
    ${attributionNote()}`;
  return { primary, drawer, drawerTitle: "Hawanama Station" };
}

const _history = new Map(); // popupId -> payload

function drawHistory(popupId, range) {
  const payload = _history.get(popupId);
  const canvas = document.getElementById(`hwn-chart-${popupId}`);
  const note = document.getElementById(`hwn-chart-note-${popupId}`);
  if (!payload || !canvas) return;
  const rows = range === "daily" ? payload.daily : payload.hourly;
  const labels = rows.map((r) =>
    range === "daily" ? r.date.slice(5) : fmtTime(r.t).replace(" PKT", "").slice(7));
  const values = rows.map((r) => (r.pm25 === null || r.pm25 === undefined ? null : Number(r.pm25)));
  if (note) {
    const valid = values.filter((v) => v !== null).length;
    note.textContent = valid ? (range === "daily" ? "Daily mean PM2.5 (µg/m³), PKT days" : "Hourly PM2.5 (µg/m³)")
                             : "No readings in this period.";
  }
  if (_charts.size >= MAX_CHARTS) {
    const [oldKey, oldChart] = _charts.entries().next().value;
    oldChart.destroy();
    _charts.delete(oldKey);
  }
  const existing = _charts.get(popupId);
  if (existing) existing.destroy();
  _charts.set(popupId, new Chart(canvas.getContext("2d"), {
    type: range === "daily" ? "bar" : "line",
    data: { labels, datasets: [{ label: "PM2.5 (µg/m³)", data: values, borderWidth: 2, pointRadius: 1.5,
                                tension: 0.2, spanGaps: false, backgroundColor: "rgba(239,68,68,0.55)",
                                borderColor: "rgb(239,68,68)" }] },
    options: {
      responsive: false,
      scales: {
        x: { ticks: { color: "#ccc", maxRotation: 45, minRotation: 45, font: { size: 9 }, autoSkip: true, maxTicksLimit: 8 },
             grid: { color: "rgba(255,255,255,0.07)" } },
        y: { beginAtZero: true, ticks: { color: "#ccc", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.1)" } },
      },
      plugins: { legend: { display: false } },
    },
  }));
}

async function onHistoryButton(btn) {
  const popupId = btn.getAttribute("data-popup-id");
  const sid = btn.getAttribute("data-station-id");
  const wrap = document.getElementById(`hwn-chart-wrap-${popupId}`);
  if (!wrap) return;
  const open = wrap.style.display !== "none";
  if (open) {
    wrap.style.display = "none";
    btn.textContent = "Show PM2.5 history";
    return;
  }
  wrap.style.display = "block";
  btn.textContent = "Hide PM2.5 history";
  if (btn.getAttribute("data-loaded") === "true") return;
  const note = document.getElementById(`hwn-chart-note-${popupId}`);
  if (note) note.textContent = "Loading…";
  try {
    const r = await fetch(`${API}/stations/${encodeURIComponent(sid)}/history/?hours=48&days=30`, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _history.set(popupId, await r.json());
    if (_history.size > MAX_CHARTS) _history.delete(_history.keys().next().value);
    btn.setAttribute("data-loaded", "true");
    drawHistory(popupId, "hourly");
  } catch (err) {
    console.warn("[hawanama] station history failed", err);
    if (note) note.textContent = "History unavailable right now.";
  }
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

const FIRE_BAND_VARIANT = {
  none: "aqi-good", low: "aqi-moderate", elevated: "aqi-usg", high: "aqi-unhealthy", very_high: "aqi-very-unhealthy",
};

export function buildHawanamaFirePopup(p) {
  const popupId = uid("hwnfire");
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
    <div class="ncop-popup__actions" style="border-top:none;padding:6px 0;background:transparent;">
      <button class="ncop-popup__button ncop-popup__button--primary hawanama-season-btn" data-popup-id="${popupId}">Rice-season fire counts</button>
    </div>
    <div id="hwn-season-wrap-${popupId}" class="ncop-popup__chart" style="display:none;">
      <div class="ncop-popup__pills">
        <button class="ncop-popup__pill hawanama-season-region" data-region="punjab" data-popup-id="${popupId}">Punjab (PK)</button>
        <button class="ncop-popup__pill hawanama-season-region" data-region="indian-punjab" data-popup-id="${popupId}">Indian Punjab</button>
      </div>
      <canvas id="hwn-season-chart-${popupId}" style="width:230px;height:150px;max-width:100%;"></canvas>
      <div id="hwn-season-note-${popupId}" class="ncop-popup__status-note" style="display:block;"></div>
    </div>
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

// ---------------------------------------------------------------------------
// Rice-season fire statistics (cumulative VIIRS detections, this season vs
// last season) — opened from the fire-outlook popup.
// ---------------------------------------------------------------------------

const _seasonCache = new Map();

async function drawSeason(popupId, region) {
  const canvas = document.getElementById(`hwn-season-chart-${popupId}`);
  const note = document.getElementById(`hwn-season-note-${popupId}`);
  if (!canvas) return;
  if (note) note.textContent = "Loading…";
  let data = _seasonCache.get(region);
  if (!data) {
    try {
      const r = await fetch(`${API}/fires/season/?region=${encodeURIComponent(region)}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
      _seasonCache.set(region, data);
    } catch (err) {
      console.warn("[hawanama] fire season failed", err);
      if (note) note.textContent = "Fire statistics unavailable right now.";
      return;
    }
  }
  const current = data.years.find((y) => y.role === "current");
  const last = data.years.find((y) => y.role === "last");
  const key = `season-${popupId}`;
  const existing = _charts.get(key);
  if (existing) existing.destroy();
  const datasets = [];
  if (current) datasets.push({ label: `${current.year}`, data: current.cum, borderColor: "rgb(239,68,68)", borderWidth: 2, pointRadius: 0, spanGaps: false });
  if (last) datasets.push({ label: `${last.year}`, data: last.cum, borderColor: "rgb(148,163,184)", borderWidth: 1.5, pointRadius: 0, borderDash: [4, 3] });
  _charts.set(key, new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: data.days, datasets },
    options: {
      responsive: false,
      scales: {
        x: { ticks: { color: "#ccc", font: { size: 9 }, maxTicksLimit: 6 }, grid: { color: "rgba(255,255,255,0.07)" } },
        y: { beginAtZero: true, ticks: { color: "#ccc", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.1)" } },
      },
      plugins: { legend: { labels: { color: "#fff", font: { size: 10 } } } },
    },
  }));
  const h = data.headline || {};
  const n20 = h.comparison_n20?.last_year?.pct_change;
  if (note) {
    note.textContent = `${data.region?.label || region}: cumulative fire detections, ${data.season?.label || "rice season"}. `
      + (n20 !== undefined && n20 !== null ? `NOAA-20-only year-on-year change to date: ${n20 > 0 ? "+" : ""}${n20}%.` : "");
  }
}

let _handlerInstalled = false;
export function setupHawanamaPopupEventHandlers() {
  if (_handlerInstalled) return;
  _handlerInstalled = true;
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".hawanama-history-btn");
    if (btn) { onHistoryButton(btn); return; }
    const range = e.target.closest?.(".hawanama-history-range");
    if (range) { drawHistory(range.getAttribute("data-popup-id"), range.getAttribute("data-range")); return; }
    const seasonBtn = e.target.closest?.(".hawanama-season-btn");
    if (seasonBtn) {
      const pid = seasonBtn.getAttribute("data-popup-id");
      const wrap = document.getElementById(`hwn-season-wrap-${pid}`);
      if (!wrap) return;
      const open = wrap.style.display !== "none";
      wrap.style.display = open ? "none" : "block";
      if (!open) drawSeason(pid, "punjab");
      return;
    }
    const region = e.target.closest?.(".hawanama-season-region");
    if (region) drawSeason(region.getAttribute("data-popup-id"), region.getAttribute("data-region"));
  });
}
