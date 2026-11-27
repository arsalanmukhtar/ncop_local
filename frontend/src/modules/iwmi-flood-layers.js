// iwmi-flood-layers.js
// IWMI ENSO Outlook flood forecasting for NCOP's Flood Monitoring accordion
// ("IWMI Flood Forecasting" subsection), via /api/iwmi/ (iwmi_flood_views.py):
//   toggle:   iwmi_glofas_points       GloFAS flood-alert points (+ discharge chart)
//             iwmi_floodhub_gauges     Google Flood Hub river gauges (+ chart)
//             iwmi_floodhub_inundation Google Flood Hub inundation extent
//   temporal: iwmi_glofas_forecast_days  GloFAS status per forecast day (temp-slider1)
// plus a small regional status card while any of these layers is on.

import {
  ATTRIBUTION_FLOODHUB, ATTRIBUTION_GLOFAS, FLOODHUB_LEGEND, GLOFAS_LEGEND,
} from "./iwmi-flood-popups.js";

const API = `${window.location.origin}/api/iwmi`;
const GREY = "#9ca3af";

function glofasColor(prop) {
  return ["match", ["get", prop],
    "extreme", "#640000", "danger", "#E2683C", "warning", "#E7B416", "normal", "#3FA34D", GREY];
}

const UNRELIABLE = ["==", ["get", "quality"], "unreliable"];

// ---- Proportional marker sizing --------------------------------------------
// Dot size = river size x alert level, scaled with zoom:
//   river size  - the point's own warning-threshold discharge on a log
//                 scale (a 20,000 m3/s Indus reach reads bigger than a
//                 50 m3/s tributary); 0.8 when the gauge has no threshold.
//   alert level - Normal 1.0, Warning 1.25, Severe 1.5, Extreme 1.8.
// Zoom must be the top-level input of a Mapbox interpolate, so the data
// multiplier sits inside each zoom stop.
function magnitudeFactor(thresholdProp) {
  return ["interpolate", ["linear"], ["ln", ["max", 1, ["to-number", ["coalesce", ["get", thresholdProp], 1], 1]]],
    0, 0.8,      // <= 1 m3/s or unknown
    4.6, 1.0,    // ~100 m3/s
    6.9, 1.25,   // ~1,000 m3/s
    9.2, 1.55,   // ~10,000 m3/s
    10.3, 1.75]; // ~30,000 m3/s and above
}

function severityFactor(prop, levels) {
  return ["match", ["get", prop], ...levels.flatMap(([k, f]) => [k, f]), 1.0];
}

const GLOFAS_LEVELS = [["warning", 1.25], ["danger", 1.5], ["extreme", 1.8]];
const FLOODHUB_LEVELS = [["ABOVE_NORMAL", 1.25], ["SEVERE", 1.5], ["EXTREME", 1.8]];

function zoomedRadius(sizeExpr, base = [[3, 3.2], [6, 5.5], [9, 8.5], [12, 12]]) {
  return ["interpolate", ["linear"], ["zoom"], ...base.flatMap(([z, r]) => [z, ["*", r, sizeExpr]])];
}

function haloRadius(sizeExpr) {
  return zoomedRadius(sizeExpr, [[3, 7], [6, 11], [9, 16], [12, 22]]);
}

// Official four-class GloFAS flood-alert colours (IWMI legend), white
// outline for contrast on any basemap; unreliable points are a hollow grey
// ring at the smallest size so they never read as an all-clear.
function glofasPointPaint(statusProp, opacity = 0.95) {
  const size = ["*", magnitudeFactor("warning"), severityFactor(statusProp, GLOFAS_LEVELS)];
  return {
    "circle-radius": zoomedRadius(["case", UNRELIABLE, 0.8, size]),  // one zoom interpolate (Mapbox rule)
    "circle-color": ["case", UNRELIABLE, "rgba(0,0,0,0)", glofasColor(statusProp)],
    "circle-stroke-color": ["case", UNRELIABLE, GREY, "rgba(255,255,255,0.92)"],
    "circle-stroke-width": ["case", UNRELIABLE, 1.8, ["match", ["get", statusProp], "normal", 1.1, 1.6]],
    "circle-opacity": opacity,
    "circle-stroke-opacity": opacity,
    "circle-pitch-alignment": "map",
  };
}

// Soft glow behind points in alert (Warning and above) so they stand out
// at national zoom without enlarging every normal point.
function glofasHaloPaint(statusProp) {
  const size = ["*", magnitudeFactor("warning"), severityFactor(statusProp, GLOFAS_LEVELS)];
  return {
    "circle-radius": haloRadius(size),
    "circle-color": glofasColor(statusProp),
    "circle-blur": 0.9,
    "circle-opacity": ["case", ["any", UNRELIABLE, ["==", ["get", statusProp], "normal"]], 0, 0.38],
  };
}

// Draw higher alert levels on top of lower ones.
function rankSortKey(prop, levels) {
  return ["match", ["get", prop], ...levels.flatMap(([k], i) => [k, i + 1]), 0];
}

// Official Flood Hub severity colours (same four-class palette as GloFAS).
const FLOODHUB_COLOR = ["match", ["get", "severity"],
  "EXTREME", "#640000", "SEVERE", "#E2683C", "ABOVE_NORMAL", "#E7B416", "NO_FLOODING", "#3FA34D", GREY];

export const iwmiToggleItems = {
  iwmi_glofas_points: {
    label: "GloFAS — River Discharge (Flood-Alert Points)",
    source: { id: "iwmi_glofas_points-source", type: "geojson", data: `${API}/glofas/points/`, attribution: ATTRIBUTION_GLOFAS },
    layers: [
      {
        id: "iwmi_glofas_points-halo", type: "circle", source: "iwmi_glofas_points-source",
        layout: { "circle-sort-key": rankSortKey("status", GLOFAS_LEVELS) },
        paint: glofasHaloPaint("status"),
      },
      {
        id: "iwmi_glofas_points-circle", type: "circle", source: "iwmi_glofas_points-source",
        layout: { "circle-sort-key": rankSortKey("status", GLOFAS_LEVELS) },
        paint: glofasPointPaint("status"),
      },
      {
        id: "iwmi_glofas_points-label", type: "symbol", source: "iwmi_glofas_points-source", minzoom: 7,
        layout: { "text-field": ["coalesce", ["get", "river"], ""], "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
                  "text-size": 10, "text-offset": [0, 1.2], "text-allow-overlap": false },
        paint: { "text-color": "#e5e7eb", "text-halo-color": "rgba(0,0,0,0.7)", "text-halo-width": 1.1 },
      },
    ],
    popup: true,
    dynamicLegend: {
      title: "GloFAS flood-alert status",
      entries: [...GLOFAS_LEGEND.map((e) => ({ swatch: e.color, label: e.label })),
                { swatch: "transparent", label: "Hollow grey ring: unreliable point" },
                { swatch: "transparent", label: "Dot size: river size x alert level" }],
    },
    information:
      "CEMS GloFAS flood-alert reference points across Pakistan, the subcontinent and Southeast Asia. Each point is coloured by the worst threshold (Warning / Severe / Extreme) whose estimated exceedance probability reaches 30% within the 15-day forecast. Click a point for its discharge chart (30 days of recent forecasts, 15 forecast days with ±1 SD band and threshold lines). Hollow grey points never reach 3% of their warning level and cannot signal a flood. GloFAS runs are not daily; check the run date in the popup. Data: CEMS GloFAS (Copernicus) via IWMI ENSO Outlook.",
  },
  iwmi_floodhub_gauges: {
    label: "Google Flood Hub — River Gauges",
    source: { id: "iwmi_floodhub_gauges-source", type: "geojson", data: `${API}/floodhub/gauges/`, attribution: ATTRIBUTION_FLOODHUB },
    layers: [
      {
        id: "iwmi_floodhub_gauges-halo", type: "circle", source: "iwmi_floodhub_gauges-source",
        layout: { "circle-sort-key": rankSortKey("severity", FLOODHUB_LEVELS) },
        paint: {
          "circle-radius": haloRadius(["*", magnitudeFactor("warning"), severityFactor("severity", FLOODHUB_LEVELS)]),
          "circle-color": FLOODHUB_COLOR,
          "circle-blur": 0.9,
          "circle-opacity": ["match", ["get", "severity"], "ABOVE_NORMAL", 0.35, "SEVERE", 0.4, "EXTREME", 0.45, 0],
        },
      },
      {
        id: "iwmi_floodhub_gauges-circle", type: "circle", source: "iwmi_floodhub_gauges-source",
        layout: { "circle-sort-key": rankSortKey("severity", FLOODHUB_LEVELS) },
        paint: {
          // Gauges are dense (887 in the region): a touch smaller than the
          // GloFAS points at the same zoom so the two layers read together.
          "circle-radius": zoomedRadius(["*", magnitudeFactor("warning"), severityFactor("severity", FLOODHUB_LEVELS)],
                                        [[3, 2.6], [6, 4.6], [9, 7.5], [12, 10.5]]),
          "circle-color": FLOODHUB_COLOR,
          // Trend: rising = red ring, falling = blue ring, steady = white ring.
          "circle-stroke-color": ["match", ["get", "trend"], "RISE", "#dc2626", "FALL", "#2563eb", "rgba(255,255,255,0.9)"],
          "circle-stroke-width": ["match", ["get", "trend"], "RISE", 2.2, "FALL", 2.2, 1],
          "circle-opacity": 0.95,
          "circle-pitch-alignment": "map",
        },
      },
    ],
    popup: true,
    dynamicLegend: {
      title: "Flood Hub gauge severity",
      entries: [...FLOODHUB_LEGEND.map((e) => ({ swatch: e.color, label: e.label })),
                { swatch: "#dc2626", label: "Red ring: rising" }, { swatch: "#2563eb", label: "Blue ring: falling" },
                { swatch: "transparent", label: "Dot size: river size x severity" }],
    },
    information:
      "Google Flood Forecasting (Flood Hub) AI-modelled river gauges — quality-verified gauges only — with severity, short-term trend and warning/danger/extreme discharge thresholds. Click a gauge for its discharge chart. Data: Google Flood Forecasting, CC BY 4.0 (via IWMI ENSO Outlook).",
  },
  iwmi_floodhub_inundation: {
    label: "Google Flood Hub — Inundation Extent",
    source: { id: "iwmi_floodhub_inundation-source", type: "geojson", data: `${API}/floodhub/inundation/`, attribution: ATTRIBUTION_FLOODHUB },
    layers: [
      {
        id: "iwmi_floodhub_inundation-fill", type: "fill", source: "iwmi_floodhub_inundation-source",
        paint: {
          "fill-color": ["match", ["upcase", ["to-string", ["coalesce", ["get", "level"], ["get", "inundationLevel"], ""]]],
            "HIGH", "#1e3a8a", "MEDIUM", "#2563eb", "LOW", "#93c5fd", "#3b82f6"],
          "fill-opacity": 0.45,
        },
      },
      {
        id: "iwmi_floodhub_inundation-line", type: "line", source: "iwmi_floodhub_inundation-source",
        paint: { "line-color": "#1e40af", "line-width": 0.8 },
      },
    ],
    popup: true,
    dynamicLegend: {
      title: "Modelled inundation",
      entries: [{ swatch: "#1e3a8a", label: "High" }, { swatch: "#2563eb", label: "Medium" }, { swatch: "#93c5fd", label: "Low" }],
    },
    information:
      "Flood-extent polygons from Google Flood Forecasting for gauges that are currently flooding, in Google's high-resolution modelled regions only. Normally empty — an empty layer means no modelled flooding right now, not a fault. Data: Google Flood Forecasting, CC BY 4.0 (via IWMI ENSO Outlook).",
  },
};

export const iwmiTemporalItems = {
  iwmi_glofas_forecast_days: {
    label: "GloFAS Flood Alerts by Forecast Day",
    type: "circle",
    theme: "slider",
    title: "GloFAS flood-alert status by forecast day",
    information:
      "Each frame colours the GloFAS flood-alert points by their status on that forecast day (+1 to +15): the worst threshold whose estimated exceedance probability that day reaches 30%. Hollow grey points are unreliable. Data: CEMS GloFAS (Copernicus) via IWMI ENSO Outlook.",
  },
};

// ---------------------------------------------------------------------------
// Forecast-day slider (temp-slider1)
// ---------------------------------------------------------------------------

function shortDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso || "")
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

export function generateGlofasForecastDayLoader() {
  let cache = null;
  let cachedAt = 0;
  return async function loadGlofasForecastDays() {
    if (cache && Date.now() - cachedAt < 15 * 60 * 1000) return cache;
    let gj;
    try {
      const r = await fetch(`${API}/glofas/forecast-days/`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      gj = await r.json();
    } catch (e) {
      console.warn("[iwmi] forecast-day frames unavailable:", e);
      return [];
    }
    const leads = gj.metadata?.leads || [];
    const dates = gj.metadata?.lead_dates || {};
    const frames = leads.map((lead, i) => {
      const id = `iwmi_glofas_day_${lead}`;
      return {
        source: { id, type: "geojson", data: gj, attribution: ATTRIBUTION_GLOFAS },
        layers: [{ id, type: "circle", source: id, layout: { "circle-sort-key": rankSortKey(`s_${lead}`, GLOFAS_LEVELS) },
                   paint: glofasPointPaint(`s_${lead}`, i === 0 ? 0.95 : 0) }],
        date: `+${lead}d`,
        dateFull: `Day +${lead} · ${shortDate(dates[String(lead)])} (run ${gj.metadata?.forecast_date || "?"})`,
      };
    });
    cache = frames;
    cachedAt = Date.now();
    return frames;
  };
}

export function registerIwmiTemporalLoaders() {
  window.iwmi_glofas_forecast_days = generateGlofasForecastDayLoader();
}

// ---------------------------------------------------------------------------
// Regional river-flood status card — a compact monitoring panel shown while
// any IWMI flood layer is on: live header, KPI tiles, per-country table
// with stacked status bars, top alerts and data freshness. Styles in
// styles/dashboard/_iwmi-status-card.css.
// ---------------------------------------------------------------------------

// "On" is judged by the toggle's LAYERS, not its source: SourceLayerControl.
// removeLayerByKey removes a toggled-off item's layers but keeps its source
// on the map, so a source check would keep these panels showing after the
// layer was switched off.
const IWMI_TOGGLE_LAYER_PREFIXES = ["iwmi_glofas_points-", "iwmi_floodhub_gauges-", "iwmi_floodhub_inundation-"];

function anyIwmiLayerOn(map) {
  return (map.getStyle()?.layers || []).some((l) =>
    l.id.startsWith("iwmi_glofas_day_") || IWMI_TOGGLE_LAYER_PREFIXES.some((p) => l.id.startsWith(p)));
}
const COUNTRY = { PAK: "Pakistan", IND: "India", BGD: "Bangladesh", LKA: "Sri Lanka", AFG: "Afghanistan", MMR: "Myanmar",
                  THA: "Thailand", VNM: "Vietnam", KHM: "Cambodia", LAO: "Laos", IDN: "Indonesia", PHL: "Philippines", MYS: "Malaysia" };
const GLOFAS_ORDER = ["normal", "warning", "danger", "extreme"];
const FHUB_ORDER = ["NO_FLOODING", "ABOVE_NORMAL", "SEVERE", "EXTREME"];
const LEVEL_COLOR = ["#3FA34D", "#E7B416", "#E2683C", "#640000"];
const LEVEL_LABEL = ["Normal", "Warning", "Severe", "Extreme"];
const FHUB_LABEL = ["No flooding", "Above normal", "Severe", "Extreme"];

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function pktTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—"
    : d.toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

// Stacked bar: segment widths start at 0 and are set after insertion so
// they animate in (CSS transition on width).
function stackedBar(counts, order) {
  const total = order.reduce((n, k) => n + (counts?.[k] || 0), 0) || 1;
  const segs = order.map((k, i) => {
    const n = counts?.[k] || 0;
    return n ? `<span class="iwmi-sc__seg" data-w="${((n / total) * 100).toFixed(1)}" style="background:${LEVEL_COLOR[i]};" title="${esc(n)}"></span>` : "";
  }).join("");
  return `<div class="iwmi-sc__bar">${segs}</div>`;
}

function countUp(el, target, suffix = "") {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !Number.isFinite(target)) { el.textContent = `${target}${suffix}`; return; }
  const start = performance.now();
  const dur = 650;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = `${Math.round(target * (1 - (1 - t) ** 3))}${suffix}`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStatusCard(el, st) {
  const t = st.totals || {};
  const g = st.glofas || {};
  const rows = Object.entries(st.countries || {}).map(([iso, c]) => {
    const gr = GLOFAS_ORDER.indexOf(c.glofas?.worst ?? "normal");
    const fr = FHUB_ORDER.indexOf(c.floodhub?.worst ?? "NO_FLOODING");
    return { iso, c, rank: Math.max(gr, fr, 0) };
  }).sort((a, b) => (b.rank - a.rank) || (a.iso === "PAK" ? -1 : b.iso === "PAK" ? 1 : 0)
    || ((b.c.floodhub?.gauges || 0) + (b.c.glofas?.points || 0)) - ((a.c.floodhub?.gauges || 0) + (a.c.glofas?.points || 0)));
  const worst = rows.reduce((m, r) => Math.max(m, r.rank), 0);
  el.style.setProperty("--iwmi-sc-accent", LEVEL_COLOR[worst]);

  const kpi = (cls, label, valueHtml, sub) =>
    `<div class="iwmi-sc__kpi ${cls}"><div class="iwmi-sc__kpi-label">${esc(label)}</div><div class="iwmi-sc__kpi-value">${valueHtml}</div><div class="iwmi-sc__kpi-sub">${esc(sub)}</div></div>`;
  const ageDays = g.run_age_days;

  const tableRows = rows.map(({ iso, c, rank }, i) => {
    const gl = c.glofas;
    const fh = c.floodhub;
    const glofasCell = gl
      ? `<div class="iwmi-sc__cell">${stackedBar(gl.counts, GLOFAS_ORDER)}<span class="iwmi-sc__count"><b>${gl.alerts}</b>/${gl.points - gl.unreliable}${gl.unreliable ? ` · ${gl.unreliable} n/a` : ""}</span></div>`
      : `<span class="iwmi-sc__count">—</span>`;
    const fhubCell = fh
      ? `<div class="iwmi-sc__cell">${stackedBar(fh.counts, FHUB_ORDER)}<span class="iwmi-sc__count"><b>${fh.flooding}</b>/${fh.gauges}</span></div>`
      : `<span class="iwmi-sc__count">—</span>`;
    return `<tr class="iwmi-sc__row${iso === "PAK" ? " is-home" : ""}" style="--i:${i}">
      <td><div class="iwmi-sc__country"><span class="iwmi-sc__dot${rank > 0 ? " is-alert" : ""}" style="background:${LEVEL_COLOR[rank]};"></span><span>${esc(COUNTRY[iso] || iso)}</span></div></td>
      <td>${glofasCell}</td>
      <td>${fhubCell}</td>
      <td style="text-align:right;"><span class="iwmi-sc__pill" style="background:${LEVEL_COLOR[rank]};">${esc(LEVEL_LABEL[rank])}</span></td>
    </tr>`;
  }).join("");

  const alerts = (st.top_alerts || []).map((a) => {
    const order = a.source === "glofas" ? GLOFAS_ORDER : FHUB_ORDER;
    const r = order.indexOf(a.level);
    const name = a.river || (a.source === "glofas" ? `GloFAS pt ${a.id}` : "Flood Hub gauge");
    const meta = a.source === "glofas"
      ? `GloFAS · ${a.peak_prob ? `${Math.round(a.peak_prob * 100)}% · day +${a.peak_lead}` : ""}`
      : `Flood Hub${a.trend === "RISE" ? " · ▲ rising" : a.trend === "FALL" ? " · ▼ falling" : ""}`;
    return `<li class="iwmi-sc__alert" style="--lvl:${LEVEL_COLOR[r]};">
      <span class="iwmi-sc__alert-main"><b>${esc(name)}</b> · ${esc(COUNTRY[a.iso3] || a.iso3)}</span>
      <span class="iwmi-sc__alert-meta">${esc(a.source === "glofas" ? LEVEL_LABEL[r] : FHUB_LABEL[r])} · ${esc(meta)}</span></li>`;
  }).join("");

  el.querySelector(".iwmi-sc__body").innerHTML = `
    <div class="iwmi-sc__kpis">
      ${kpi(t.glofas_alerts ? "is-alert" : "is-ok", "GloFAS alerts", `<span data-count="${t.glofas_alerts || 0}">0</span><small>/${t.glofas_reliable ?? "—"}</small>`, `${t.glofas_points ?? 0} points · 15-day`)}
      ${kpi(t.floodhub_flooding ? "is-alert" : "is-ok", "Gauges flooding", `<span data-count="${t.floodhub_flooding || 0}">0</span><small>/${t.floodhub_gauges ?? "—"}</small>`, "Flood Hub · now")}
      ${kpi(g.run_stale ? "is-stale" : "is-ok", "GloFAS run age", `<span data-count="${ageDays ?? 0}">0</span><small>d</small>`, g.forecast_date ? `run ${g.forecast_date}` : "unavailable")}
    </div>
    <table class="iwmi-sc__table">
      <thead><tr><th>Country</th><th title="Reliable GloFAS points by status; bold = in alert">GloFAS</th><th title="Flood Hub gauges by severity; bold = flooding">Flood Hub</th><th>Worst</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div>
      <div class="iwmi-sc__section-title">Top alerts</div>
      ${alerts ? `<ul class="iwmi-sc__alerts">${alerts}</ul>`
               : `<div class="iwmi-sc__allclear">✓ No river flood alerts across ${rows.length} countries</div>`}
    </div>
    <div class="iwmi-sc__foot">
      GloFAS run ${esc(g.forecast_date || "—")}${g.run_stale ? `<span class="iwmi-sc__stale">${esc(ageDays)} d old</span>` : ""}
      · Flood Hub issued ${esc(pktTime(st.floodhub?.issued_time))} PKT<br>
      CEMS GloFAS (Copernicus) · Google Flood Forecasting (CC BY 4.0) · via IWMI ENSO Outlook
    </div>`;

  el.querySelectorAll("[data-count]").forEach((n) => countUp(n, Number(n.getAttribute("data-count"))));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.querySelectorAll(".iwmi-sc__seg").forEach((s) => { s.style.width = `${s.getAttribute("data-w")}%`; });
  }));
}

let _cardInstalled = false;
export function installIwmiStatusCard(map) {
  if (_cardInstalled || !map) return;
  _cardInstalled = true;
  const el = document.createElement("div");
  el.className = "iwmi-status-card";
  el.hidden = true;
  el.innerHTML = `
    <div class="iwmi-sc__head" role="button" tabindex="0" aria-label="Collapse or expand river flood status">
      <span class="iwmi-sc__live" aria-hidden="true"></span>
      <div class="iwmi-sc__title-block">
        <div class="iwmi-sc__kicker">Live · IWMI Flood Monitoring</div>
        <div class="iwmi-sc__title">River Flood Status</div>
      </div>
      <button type="button" class="iwmi-sc__toggle" aria-label="Collapse">
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>
      </button>
    </div>
    <div class="iwmi-sc__body"><div class="iwmi-sc__loading"><span></span><span></span><span></span></div></div>`;
  map.getContainer().appendChild(el);
  const toggle = () => el.classList.toggle("is-collapsed");
  el.querySelector(".iwmi-sc__head").addEventListener("click", toggle);
  el.querySelector(".iwmi-sc__head").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  let status = null;
  let fetchedAt = 0;
  let loading = false;
  let shown = false;

  const refresh = async () => {
    if (!anyIwmiLayerOn(map)) { el.hidden = true; shown = false; return; }
    const justShown = !shown;
    el.hidden = false;
    shown = true;
    if (status && Date.now() - fetchedAt < 5 * 60 * 1000) {
      if (justShown) renderStatusCard(el, status); // replay entrance animations when re-opened
      return;
    }
    if (loading) return;
    loading = true;
    try {
      const r = await fetch(`${API}/status/`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      status = await r.json();
      fetchedAt = Date.now();
      renderStatusCard(el, status);
    } catch (e) {
      el.querySelector(".iwmi-sc__body").innerHTML =
        `<div class="iwmi-sc__foot" style="border:0;padding:6px 0;">River flood status unavailable right now — the layers still work.</div>`;
    } finally {
      loading = false;
    }
  };
  let pending = null;
  map.on("styledata", () => {
    clearTimeout(pending);
    pending = setTimeout(refresh, 300);
  });
}


// ---------------------------------------------------------------------------
// Inundation layer: empty-state notice + auto-refresh
// Google only publishes inundation extents while gauges are flooding (and
// only in its high-resolution modelled regions), so most of the year the
// layer is legitimately empty. Instead of a silent blank map, a small
// notice says so — with the live gauge count and when it was checked —
// and the data reloads every 15 min while the layer is on, so polygons
// appear on their own when flooding starts.
// ---------------------------------------------------------------------------

const INUNDATION_SOURCE = "iwmi_floodhub_inundation-source";
const INUNDATION_LAYERS = ["iwmi_floodhub_inundation-fill", "iwmi_floodhub_inundation-line"];

// Layer-based on/off check (see anyIwmiLayerOn for why not the source).
function inundationOn(map) {
  return INUNDATION_LAYERS.some((id) => map.getLayer(id));
}
const INUNDATION_REFRESH_MS = 15 * 60 * 1000;

export function installIwmiInundationNotice(map) {
  if (!map || map.__iwmiInundationNotice) return;
  map.__iwmiInundationNotice = true;
  const el = document.createElement("div");
  el.className = "iwmi-inundation-notice";
  el.hidden = true;
  el.setAttribute("role", "status");
  map.getContainer().appendChild(el);

  let timer = null;
  let busy = false;

  const check = async (reloadSource) => {
    if (!inundationOn(map)) {
      el.hidden = true;
      clearInterval(timer);
      timer = null;
      return;
    }
    if (!timer) timer = setInterval(() => check(true), INUNDATION_REFRESH_MS);
    if (busy) return;
    busy = true;
    try {
      const [inund, status] = await Promise.all([
        fetch(`${API}/floodhub/inundation/`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${API}/status/`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (!inundationOn(map)) { el.hidden = true; return; } // switched off while fetching
      if (reloadSource && inund) map.getSource(INUNDATION_SOURCE)?.setData(inund);
      const n = inund?.features?.length ?? 0;
      const totals = status?.totals || {};
      const nCountries = (inund?.metadata?.countries || []).length || Object.keys(status?.countries || {}).length;
      const checked = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: false });
      if (inund === null) {
        el.className = "iwmi-inundation-notice is-error";
        el.innerHTML = `<span class="iwmi-in__icon">!</span><span>Inundation data unavailable right now — retrying automatically.</span>`;
      } else if (n === 0) {
        el.className = "iwmi-inundation-notice is-empty";
        el.innerHTML = `<span class="iwmi-in__icon">✓</span><span><b>No active flood inundation</b> — ${totals.floodhub_flooding ?? 0} of ${totals.floodhub_gauges ?? "—"} Flood Hub gauges flooding across ${nCountries} countries. Extents appear here automatically when flooding is modelled. <i>Checked ${checked} PKT</i></span>`;
      } else {
        el.className = "iwmi-inundation-notice is-active";
        el.innerHTML = `<span class="iwmi-in__icon">≈</span><span><b>${n} inundation extent${n === 1 ? "" : "s"}</b> mapped from ${totals.floodhub_flooding ?? "?"} flooding gauge${totals.floodhub_flooding === 1 ? "" : "s"}. <i>Checked ${checked} PKT</i></span>`;
      }
      el.hidden = false;
    } catch (_) {
      el.className = "iwmi-inundation-notice is-error";
      el.innerHTML = `<span class="iwmi-in__icon">!</span><span>Inundation data unavailable right now — retrying automatically.</span>`;
      el.hidden = false;
    } finally {
      busy = false;
    }
  };

  let pending = null;
  let wasOn = false;
  map.on("styledata", () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      const on = inundationOn(map);
      if (on !== wasOn || !on) check(false);
      wasOn = on;
    }, 300);
  });
}
