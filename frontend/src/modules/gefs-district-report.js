// gefs-district-report.js
// District view of the NOAA GEFS 35-day outlook for the Weather Report
// panel (WeatherReportControl delegates here when gefs_precip_35d or
// gefs_t2m_35d drives temp-slider1).
//
// The values come pre-aggregated from /api/gefs/districts/ — area-weighted
// over each district polygon of NCOP's district boundary layer, for all 163
// districts of Pakistan and every day 1-35 — so the panel does no map
// sampling at all: one ~80 KB request per variable and run, then pure DOM.
//
//   - Summary cards for the day on the slider
//   - Every district: value chip (same colour classes as the map), a 35-day
//     sparkline (click a day to move the slider there) and the 35-day total
//     (rain) or range (temperature)
//   - Province filter, search, sort; click a district to fly to it
//
// Re-renders are keyed on (variable, run, day, filter, sort, search) so
// slider drags and map pans never rebuild an unchanged table.

import { exportGefsOutlook } from "./gefs-outlook-export.js";

const API = `${window.location.origin}/api/gefs/districts/`;
const LAYER_VARS = { gefs_precip_35d: "precip", gefs_t2m_35d: "t2m" };
const MAX_WAIT_MS = 150000;
const CACHE_MS = 15 * 60 * 1000;

const _data = {};        // var -> { doc, at, promise, error }
const _ui = { province: "", sort: "day", q: "" };
let _lastKey = "";

export function isGefsDistrictLayer(layerKey) {
  return Object.prototype.hasOwnProperty.call(LAYER_VARS, layerKey || "");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDoc(variable) {
  const started = Date.now();
  for (;;) {
    const r = await fetch(`${API}?var=${variable}`, { credentials: "same-origin" });
    if (r.status === 200) return r.json();
    if (r.status !== 202 || Date.now() - started > MAX_WAIT_MS) {
      let detail = "";
      try { detail = (await r.json()).detail || ""; } catch { /* non-JSON */ }
      throw new Error(detail || `HTTP ${r.status}`);
    }
    await wait(Math.min(Number(r.headers.get("Retry-After")) || 15, 20) * 1000);
  }
}

// Cached doc, or null while it loads (onReady fires once it arrives).
function getDoc(variable, onReady) {
  const e = (_data[variable] ||= {});
  const fresh = e.doc && Date.now() - e.at < CACHE_MS;
  if (!fresh && !e.promise && !(e.error && Date.now() - e.errorAt < 60000)) {
    e.promise = fetchDoc(variable)
      .then((doc) => { e.doc = doc; e.at = Date.now(); e.error = null; })
      .catch((err) => { e.error = err; e.errorAt = Date.now(); console.warn("[gefs-districts]", err); })
      .finally(() => { e.promise = null; onReady?.(); });
  }
  return e.doc || null;
}

// ----------------------------------------------------------- colour classes
function classIndex(v, bounds) {
  let i = 0;
  while (i < bounds.length && v >= bounds[i]) i++;
  return i;
}

function chipStyle(v, scale) {
  if (v == null) return { bg: "transparent", fg: "inherit" };
  const c = scale.colors[classIndex(v, scale.bounds)];
  if (!c) return { bg: "transparent", fg: "inherit" };
  const n = parseInt(c.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return { bg: c, fg: lum > 0.6 ? "#111" : "#fff" };
}

// ----------------------------------------------------------------- helpers
const sum = (a) => a.reduce((s, v) => s + (v ?? 0), 0);
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(d));

function dayFromState(state) {
  const g = state?.currentEntry?.gefsDay;
  return Number.isInteger(g) ? g : (state?.currentIndex || 0) + 1;
}

function dateLabel(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}

// Sparkline: bars (rain, common scale across districts so rows compare) or
// a line (temperature, common range). Each day is a click target.
function sparkline(series, day, variable, scale, range) {
  const W = 140, H = 26, n = series.length, bw = W / n;
  let marks = "";
  if (variable === "precip") {
    const top = Math.sqrt(Math.max(range.max, 1));
    series.forEach((v, i) => {
      const h = v ? Math.max(1, (Math.sqrt(v) / top) * (H - 2)) : 0;
      const col = chipStyle(v, scale).bg;
      if (h) marks += `<rect x="${(i * bw + 0.3).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(bw - 0.6).toFixed(2)}" height="${h.toFixed(2)}" fill="${col === "transparent" ? "currentColor" : col}"/>`;
    });
  } else {
    // Per-district range (min 6 deg C span) so each row shows its own trend;
    // the 35-day range column carries the absolute comparison.
    const fin = series.filter((v) => v != null);
    const mid = fin.length ? (Math.min(...fin) + Math.max(...fin)) / 2 : 0;
    const span = fin.length ? Math.max(Math.max(...fin) - Math.min(...fin), 6) : 6;
    range = { min: mid - span / 2 };
    const pts = series.map((v, i) => (v == null ? null : `${(i * bw + bw / 2).toFixed(1)},${(H - 2 - ((v - range.min) / span) * (H - 4)).toFixed(1)}`)).filter(Boolean);
    marks = `<polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`;
  }
  const cur = `<rect class="wrp-gefs-spark__cur" x="${((day - 1) * bw).toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${H}"/>`;
  return `<svg class="wrp-gefs-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-gefs-days="${n}" aria-label="35-day ${variable === "precip" ? "rain" : "temperature"} trend; click a day to show it on the map">${cur}${marks}</svg>`;
}

function jumpToDay(day) {
  const state = window.getCurrentTemporalState?.();
  const defs = state?.layersDef || [];
  let idx = defs.findIndex((f) => f?.gefsDay === day);
  if (idx < 0) idx = day - 1;
  const slider = document.getElementById("slider1");
  if (!slider || idx < 0 || idx > Number(slider.max)) return;
  slider.value = String(idx);
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}

// --------------------------------------------------------------- rendering
function summaryCards(rows, d, variable, unit) {
  const valid = rows.filter((r) => r.v != null);
  if (!valid.length) return "";
  const card = (label, value, sub) => `<div class="wrp-card wrp-gefs-card"><span class="wrp-gefs-card__label">${esc(label)}</span><span class="wrp-gefs-card__value">${value}</span>${sub ? `<span class="wrp-gefs-card__sub">${sub}</span>` : ""}</div>`;
  const by = (k, dir) => valid.reduce((a, b) => (dir * (b[k] - a[k]) > 0 ? b : a));
  const mean = sum(valid.map((r) => r.v)) / valid.length;
  if (variable === "precip") {
    const wet = valid.filter((r) => r.v >= 1).length;
    const top = by("v", 1), topT = by("total", 1);
    return card(`Districts with ≥ 1 mm (day ${d})`, `${wet} <small>of ${valid.length}</small>`, "") +
      (top.v >= 0.5 ? card(`Wettest district (day ${d})`, `${fmt(top.v)} <small>${esc(unit)}</small>`, esc(top.name))
        : card(`Wettest district (day ${d})`, "No rain", "no district ≥ 0.5 mm")) +
      card("Wettest over 35 days", `${fmt(topT.total, 0)} <small>mm</small>`, esc(topT.name)) +
      card(`Mean of districts (day ${d})`, `${fmt(mean)} <small>${esc(unit)}</small>`, "");
  }
  const hot = by("hi", 1), cold = by("lo", -1);
  return card(`Warmest district (day ${d})`, `${fmt(by("v", 1).v)} <small>${esc(unit)}</small>`, esc(by("v", 1).name)) +
    card(`Coldest district (day ${d})`, `${fmt(by("v", -1).v)} <small>${esc(unit)}</small>`, esc(by("v", -1).name)) +
    card(`Highest cell (day ${d})`, `${fmt(hot.hi)} <small>${esc(unit)}</small>`, esc(hot.name)) +
    card(`Lowest cell (day ${d})`, `${fmt(cold.lo)} <small>${esc(unit)}</small>`, esc(cold.name));
}

function buildRows(doc, d) {
  const variable = doc.var;
  const i = d - 1;
  return doc.districts.map((x) => {
    const s = x[variable] || [];
    const finite = s.filter((v) => v != null);
    return {
      name: x.name, province: x.province, bbox: x.bbox, series: s, v: s[i] ?? null,
      total: variable === "precip" ? sum(s) : null,
      week: variable === "precip" ? sum(s.slice(i, i + 7)) : null,
      lo: variable === "precip" ? null : (x.t2m_min || [])[i] ?? null,
      hi: variable === "precip" ? (x.precip_max || [])[i] ?? null : (x.t2m_max || [])[i] ?? null,
      min35: finite.length ? Math.min(...finite) : null, max35: finite.length ? Math.max(...finite) : null,
    };
  });
}

function renderTable(root, doc, d) {
  const variable = doc.var, scale = doc.colorscale, unit = doc.unit;
  const all = buildRows(doc, d);
  const q = _ui.q.trim().toLowerCase();
  let rows = all.filter((r) => (!_ui.province || r.province === _ui.province) && (!q || r.name.toLowerCase().includes(q)));
  const key = _ui.sort === "total" ? (variable === "precip" ? "total" : "max35") : _ui.sort === "week" ? "week" : "v";
  if (_ui.sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
  else rows.sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity) || (b.week ?? 0) - (a.week ?? 0) || a.name.localeCompare(b.name));

  // Common sparkline scale over every district (rows stay comparable).
  const flat = all.flatMap((r) => r.series).filter((v) => v != null);
  const range = { min: Math.min(...flat), max: Math.max(...flat) };

  const extended = d > (doc.daily_skill_days || 14);
  const res = d <= (doc.hr_days || 10) ? "0.25°" : "0.5°";
  root.querySelector(".wrp-gefs-summary").innerHTML = summaryCards(all.filter((r) => !_ui.province || r.province === _ui.province), d, variable, unit);
  root.querySelector(".wrp-gefs-daynote").innerHTML =
    `<b>Day ${d}</b> · ${esc(dateLabel(doc.dates?.[d - 1]))} · GEFS ${res} grid${extended
      ? ` · <span class="wrp-gefs-ext">extended range — read as a weekly tendency, not an exact daily amount</span>` : ""}`;
  const totalHead = variable === "precip" ? (_ui.sort === "week" ? "7 days" : "35 days") : "35-day range";
  const body = rows.map((r) => {
    const chip = chipStyle(r.v, scale);
    const val = r.v == null ? "–" : variable === "precip" && r.v < 0.5 ? "dry" : fmt(r.v);
    const extra = variable === "precip"
      ? `${fmt(_ui.sort === "week" ? r.week : r.total, 0)}<small> mm</small>`
      : `${fmt(r.min35, 0)}…${fmt(r.max35, 0)}<small> °C</small>`;
    const detail = variable === "precip"
      ? `wettest cell ${fmt(r.hi)} mm`
      : `cells ${fmt(r.lo)}…${fmt(r.hi)} °C`;
    const bb = Array.isArray(r.bbox) ? r.bbox.join(",") : "";
    return `<tr class="wrp-gefs-row" data-fly-bbox="${esc(bb)}" tabindex="0" title="${esc(r.name)} — click to zoom to the district">
      <td class="wrp-gefs-name"><span>${esc(r.name)}</span><small>${esc(r.province.replace(/_/g, " "))}</small></td>
      <td class="wrp-gefs-val"><span class="wrp-gefs-chip" style="background:${chip.bg};color:${chip.fg}" title="${esc(detail)}">${val}</span></td>
      <td class="wrp-gefs-trend">${sparkline(r.series, d, variable, scale, range)}</td>
      <td class="wrp-gefs-total">${extra}</td></tr>`;
  }).join("");
  const unitHead = variable === "precip" ? "mm/day" : "°C";
  root.querySelector(".wrp-gefs-table-wrap").innerHTML = rows.length
    ? `<table class="wrp-gefs-table"><thead><tr><th>District</th><th>Day ${d}<small> ${unitHead}</small></th><th>Days 1–35</th><th>${totalHead}</th></tr></thead><tbody>${body}</tbody></table>`
    : `<div class="wrp-empty"><p>No district matches the filter.</p></div>`;
  root.querySelector(".wrp-gefs-count").textContent = `${rows.length} of ${all.length} districts`;
}

function shell(doc) {
  const provinces = [...new Set(doc.districts.map((x) => x.province).filter(Boolean))].sort();
  const isP = doc.var === "precip";
  const opt = (v, l) => `<option value="${esc(v)}"${_ui.sort === v ? " selected" : ""}>${esc(l)}</option>`;
  return `<div class="wrp-gefs" data-gefs-var="${doc.var}" data-gefs-run="${esc(doc.run)}">
    <div class="wrp-gefs-export" role="group" aria-label="Export the 35-day outlook">
      <span class="wrp-gefs-export__label"><b>35-day outlook report</b> · rain + temperature · all districts</span>
      <button type="button" data-gefs-export="word" title="Word document: key messages, weekly national / provincial / district tables, daily annexes">Word</button>
      <button type="button" data-gefs-export="pdf" title="Printable report (save as PDF from the print dialog)">PDF</button>
      <button type="button" data-gefs-export="csv" title="Every district x every day, both variables (spreadsheet)">CSV</button>
    </div>
    <div class="wrp-gefs-summary"></div>
    <div class="wrp-gefs-daynote"></div>
    <div class="wrp-gefs-controls">
      <select data-gefs-ui="province" aria-label="Province"><option value="">All provinces</option>${provinces.map((p) => `<option value="${esc(p)}"${_ui.province === p ? " selected" : ""}>${esc(p.replace(/_/g, " "))}</option>`).join("")}</select>
      <select data-gefs-ui="sort" aria-label="Sort">${opt("day", isP ? "Wettest on this day" : "Warmest on this day")}${isP ? opt("week", "Wettest next 7 days") : ""}${opt("total", isP ? "Wettest over 35 days" : "Warmest over 35 days")}${opt("name", "A–Z")}</select>
      <input type="search" data-gefs-ui="q" placeholder="Find district…" value="${esc(_ui.q)}" aria-label="Find district">
      <span class="wrp-gefs-count"></span>
    </div>
    <div class="wrp-gefs-table-wrap"></div>
    <p class="wrp-gefs-method">Area-weighted mean of the GEFS ensemble over each district polygon. Click a district to zoom to it; click a day on its trend to move the slider there.</p>
  </div>`;
}

function wire(root, rerender) {
  root.addEventListener("change", (e) => {
    const k = e.target?.dataset?.gefsUi;
    if (k === "province" || k === "sort") { _ui[k] = e.target.value; rerender(); }
  });
  let t = null;
  root.addEventListener("input", (e) => {
    if (e.target?.dataset?.gefsUi !== "q") return;
    _ui.q = e.target.value;
    clearTimeout(t);
    t = setTimeout(rerender, 120);
  });
  // Export buttons (detailed 35-day report, both variables).
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest?.("[data-gefs-export]");
    if (!btn || btn.disabled) return;
    e.stopPropagation();
    const all = root.querySelectorAll("[data-gefs-export]");
    const label = btn.textContent;
    all.forEach((b) => { b.disabled = true; });
    btn.textContent = "Preparing…";
    try {
      await exportGefsOutlook(btn.dataset.gefsExport);
    } catch (err) {
      console.warn("[gefs-districts] export failed", err);
      btn.textContent = "Failed";
      await wait(2500);
    } finally {
      btn.textContent = label;
      all.forEach((b) => { b.disabled = false; });
    }
  });
  // Click on a sparkline day → move the slider (and don't fly the map).
  root.addEventListener("click", (e) => {
    const svg = e.target.closest?.(".wrp-gefs-spark");
    if (!svg) return;
    e.stopPropagation();
    const box = svg.getBoundingClientRect();
    const n = Number(svg.dataset.gefsDays) || 35;
    if (box.width > 0) jumpToDay(Math.min(n, Math.max(1, Math.floor(((e.clientX - box.left) / box.width) * n) + 1)));
  });
}

/**
 * Render the GEFS district report into the panel body.
 * @param {object} o  { container, footerEl, subtitleEl, state, districtVisible, rerender }
 */
export function renderGefsDistrictReport(o) {
  const variable = LAYER_VARS[o.state?.layerKey];
  const d = Math.min(35, Math.max(1, dayFromState(o.state)));
  const label = variable === "precip" ? "GEFS precipitation by district" : "GEFS 2 m temperature by district";
  if (o.subtitleEl) o.subtitleEl.textContent = `${label} · day ${d}`;

  const doc = getDoc(variable, () => { _lastKey = ""; o.rerender?.(); });
  if (!doc) {
    const err = _data[variable]?.error;
    _lastKey = "";
    o.container.innerHTML = err
      ? `<div class="wrp-empty"><h4>District values unavailable</h4><p>${esc(err.message || "The GEFS district service did not respond.")} It is retried automatically.</p></div>`
      : `<div class="wrp-loading" role="status" aria-live="polite"><div class="wrp-loader" aria-hidden="true"></div>
           <div class="wrp-loading-text">Preparing 35-day values for every district…</div></div>`;
    if (o.footerEl) { o.footerEl.innerHTML = ""; o.footerEl.classList.remove("is-visible"); }
    return;
  }

  let root = o.container.querySelector(":scope > .wrp-gefs");
  if (!root || root.dataset.gefsVar !== doc.var || root.dataset.gefsRun !== String(doc.run)) {
    o.container.innerHTML = shell(doc);
    root = o.container.querySelector(":scope > .wrp-gefs");
    wire(root, () => { _lastKey = ""; renderGefsDistrictReport({ ...o, state: window.getCurrentTemporalState?.() || o.state }); });
    _lastKey = "";
  }
  const key = [doc.var, doc.run, d, _ui.province, _ui.sort, _ui.q, o.districtVisible].join("|");
  if (key === _lastKey) return;
  _lastKey = key;

  const scroll = o.container.scrollTop;
  renderTable(root, doc, d);
  o.container.scrollTop = scroll;
  if (!o.districtVisible) {
    root.querySelector(".wrp-gefs-daynote").insertAdjacentHTML("beforeend",
      `<div class="wrp-gefs-hint">Tip: turn on <b>District Boundary</b> to see the district outlines over the outlook.</div>`);
  }
  if (o.footerEl) {
    o.footerEl.innerHTML = `NOAA GEFS v12 ensemble mean · run ${esc(String(doc.run).slice(0, 8))} 00Z · ${esc(doc.districts.length)} districts`;
    o.footerEl.classList.add("is-visible");
  }
}
