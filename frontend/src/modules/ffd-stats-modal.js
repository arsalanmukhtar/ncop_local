// ffd-stats-modal.js
// ---------------------------------------------------------------------------
// FFD Discharge Stats Modal — a draggable/resizable panel showing a
// clicked FFD barrage/dam's 30-day discharge history + 14-day regression
// forecast (plus GeoGLOWS's own forecast where the station's coordinates
// are available).
//
// Deliberately mirrors the Heatwave Stats Modal's chrome/interaction shape
// (modal shell, header with kicker/title/badge, drag handle, resize
// corner, close button, loader dots) WITHOUT touching or importing from
// its implementation (layer-attribute-popup.js) — same "zero coupling, own
// drag/resize helper" precedent that file's own IPC Stats Modal already
// established relative to the Heatwave modal, so neither of those two
// existing modals is touched by this addition.
//
// The history/regression MATH is not reimplemented here — it reuses
// ffd-history-forecast.js's already-built, already-verified pure
// functions (buildFfdStationOutlook et al. — the same ones Story Mode's
// Chapter 3 barrage popups already use) and getFfdHistoryAll from
// gcop-api-cache.js for the raw 30-day payload, so this modal and the
// cinematic story's own outlook section can never disagree.
// ---------------------------------------------------------------------------

import { getFfdHistoryAll } from "./gcop-api-cache.js";
import { buildFfdStationOutlook, renderFfdOutlookChartSVG } from "./ffd-history-forecast.js";

const MODAL_ID = "ffd-stats-modal";
const CMS_TO_CUSECS = 35.3147; // 1 m3/s = 35.3147 ft3/s — same conversion story-dynamic-weather.js already uses, kept in lockstep by hand since the two modules don't import from each other

function _escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- GeoGLOWS horizon table (Now / +24h / +72h / +7d / Peak) --------------
// Same nearestTo/peak-reduce technique story-dynamic-weather.js's own
// (now-removed) _fetchGeoglowsForecast used — reimplemented locally rather
// than imported, same "zero coupling" precedent this file's own drag/resize
// helper already established, so this modal never depends on Story Mode
// being loaded (the real-map-click open path, _handleFfdStatsClick, has no
// access to that file at all).
function _cusecsLocal(cms) {
  return Number.isFinite(cms) ? Math.round(cms * CMS_TO_CUSECS).toLocaleString() : "—";
}
function _fmtGeoglowsWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function _buildGeoglowsHorizon(points, riverId) {
  const nowMs = Date.now();
  const nearestTo = (hoursAhead) => {
    const targetMs = nowMs + hoursAhead * 3600 * 1000;
    let best = points[0], bestDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(new Date(p.date).getTime() - targetMs);
      if (diff < bestDiff) { bestDiff = diff; best = p; }
    }
    return best;
  };
  const peak = points.reduce((a, b) => (b.cms > a.cms ? b : a), points[0]);
  return { riverId, now: nearestTo(0), day1: nearestTo(24), day3: nearestTo(72), day7: nearestTo(168), peak };
}
function _renderGeoglowsHorizonHTML(gg) {
  if (!gg) return "";
  const row = (label, p) => p ? `
    <tr>
      <td>${_escapeHtml(label)}</td>
      <td><mark class="dwr-hl">${_cusecsLocal(p.cms)} cusecs</mark></td>
      <td>${_escapeHtml(_fmtGeoglowsWhen(p.date))}</td>
    </tr>` : "";
  return `
    <div class="ffd-modal__geoglows">
      <div class="ffd-modal__geoglows-title">GeoGLOWS river forecast</div>
      <table class="ffd-modal__geoglows-table">
        <thead><tr><th>Horizon</th><th>Flow</th><th>Valid</th></tr></thead>
        <tbody>
          ${row("Now", gg.now)}
          ${row("+24h", gg.day1)}
          ${row("+72h", gg.day3)}
          ${row("+7d", gg.day7)}
          ${row("Peak (15d)", gg.peak)}
        </tbody>
      </table>
      <div class="ffd-modal__geoglows-note">Approximation — nearest simulated reach (river ID ${gg.riverId}), not a direct gauge reading. Uncertainty at "Now": ${_cusecsLocal(gg.now?.lowCms)}–${_cusecsLocal(gg.now?.highCms)} cusecs.</div>
    </div>
  `;
}

// ---- Modal DOM --------------------------------------------------------------
function _ensureModal() {
  let modal = document.getElementById(MODAL_ID);
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = MODAL_ID;
  modal.className = "ffd-modal hidden";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "FFD Discharge Stats");
  modal.innerHTML = `
    <div class="ffd-modal__head" data-ffd-drag>
      <div class="ffd-modal__head-top">
        <div class="ffd-modal__drag-grip" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="ffd-modal__title-block">
          <div class="ffd-modal__kicker">FFD Discharge</div>
          <div class="ffd-modal__title" id="ffd-modal-name">—</div>
          <div class="ffd-modal__subtitle" id="ffd-modal-meta">—</div>
        </div>
        <span class="ffd-modal__badge" id="ffd-modal-badge">—</span>
        <button type="button" class="ffd-modal__close" aria-label="Close" data-ffd-close>&times;</button>
      </div>
      <div class="ffd-modal__head-stats" id="ffd-modal-head-stats"></div>
    </div>
    <div class="ffd-modal__body">
      <aside class="ffd-modal__left">
        <div class="ffd-modal__stats" id="ffd-modal-stats"></div>
      </aside>
      <section class="ffd-modal__right">
        <div class="ffd-modal__chart-wrap">
          <div class="ffd-modal__chart-head">
            <div class="ffd-modal__chart-title">30-Day History &amp; 14-Day Outlook</div>
            <div class="ffd-modal__chart-sub" id="ffd-modal-sub">Loading…</div>
          </div>
          <div class="ffd-modal__canvas-host" id="ffd-modal-chart-host">
            <div class="ffd-modal__loader" id="ffd-modal-loader"><span></span><span></span><span></span></div>
          </div>
          <div class="ffd-modal__description" id="ffd-modal-description"></div>
          <div class="ffd-modal__footnote">Data: FFD 30-day discharge history (regression trend) + GeoGLOWS river-routing simulation where available. A statistical outlook, not an FFD-issued flood forecast.</div>
        </div>
      </section>
    </div>
    <div class="ffd-modal__resize" data-ffd-resize aria-label="Resize">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 6 L6 14 M14 10 L10 14" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"></path></svg>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-ffd-close]")) hideFfdModal();
  });

  _attachFfdDragAndResize(modal);
  return modal;
}

// Own drag/resize implementation — same per-gesture add/remove-listener
// technique layer-attribute-popup.js's attachHeatwaveDragAndResize already
// uses (pointer capture on the handle itself, viewport-clamped, "pin to
// absolute pixels" on first interaction so stylesheet bottom/left rules
// stop fighting the drag) — reimplemented locally rather than imported, so
// this module has zero coupling to that file.
function _attachFfdDragAndResize(modal) {
  const drag = modal.querySelector("[data-ffd-drag]");
  const resize = modal.querySelector("[data-ffd-resize]");
  const MIN_W = 480, MIN_H = 300;

  const pinToPixels = () => {
    const r = modal.getBoundingClientRect();
    modal.style.left = `${Math.round(r.left)}px`;
    modal.style.top = `${Math.round(r.top)}px`;
    modal.style.right = "auto";
    modal.style.bottom = "auto";
    modal.style.width = `${Math.round(r.width)}px`;
    modal.style.height = `${Math.round(r.height)}px`;
  };

  if (drag) {
    drag.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-ffd-close]")) return;
      if (e.button !== undefined && e.button !== 0) return;
      pinToPixels();
      const startX = e.clientX, startY = e.clientY;
      const startLeft = parseFloat(modal.style.left) || 0;
      const startTop = parseFloat(modal.style.top) || 0;
      modal.classList.add("is-dragging");
      drag.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const margin = 8;
        const w = modal.offsetWidth, h = modal.offsetHeight;
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

  if (resize) {
    resize.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      pinToPixels();
      const startX = e.clientX, startY = e.clientY;
      const startW = modal.offsetWidth, startH = modal.offsetHeight;
      const startLeft = parseFloat(modal.style.left) || 0;
      const startTop = parseFloat(modal.style.top) || 0;
      modal.classList.add("is-resizing");
      resize.setPointerCapture(e.pointerId);

      const onMove = (ev) => {
        const margin = 8;
        const maxW = window.innerWidth - startLeft - margin;
        const maxH = window.innerHeight - startTop - margin;
        const w = Math.max(MIN_W, Math.min(maxW, startW + (ev.clientX - startX)));
        const h = Math.max(MIN_H, Math.min(maxH, startH + (ev.clientY - startY)));
        modal.style.width = `${Math.round(w)}px`;
        modal.style.height = `${Math.round(h)}px`;
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

// ---- Open / close -------------------------------------------------------------
/**
 * ctx: { name, province, status, outflow, inflow, lat, lon }
 * Same single-object-arg shape showHeatwaveModalForCity uses.
 */
export async function showFfdModalForStation(ctx) {
  const modal = _ensureModal();
  modal.classList.remove("hidden");
  modal.classList.add("is-open");

  const nameEl = document.getElementById("ffd-modal-name");
  const metaEl = document.getElementById("ffd-modal-meta");
  const badgeEl = document.getElementById("ffd-modal-badge");
  const statsEl = document.getElementById("ffd-modal-stats");
  const subEl = document.getElementById("ffd-modal-sub");
  const hostEl = document.getElementById("ffd-modal-chart-host");
  const descEl = document.getElementById("ffd-modal-description");
  const headStatsEl = document.getElementById("ffd-modal-head-stats");

  if (nameEl) nameEl.textContent = ctx.name || "FFD Station";
  if (metaEl) {
    const coordText = Number.isFinite(ctx.lat) && Number.isFinite(ctx.lon) ? `${ctx.lat.toFixed(3)}, ${ctx.lon.toFixed(3)}` : null;
    metaEl.textContent = [ctx.province, coordText].filter(Boolean).join(" · ") || "—";
  }
  if (badgeEl) badgeEl.textContent = ctx.status || "—";
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="ffd-stat ffd-stat--outflow">
        <div class="ffd-stat__label">Outflow (now)</div>
        <div class="ffd-stat__value">${_escapeHtml(ctx.outflow ?? "n/a")}</div>
      </div>
      <div class="ffd-stat ffd-stat--inflow">
        <div class="ffd-stat__label">Inflow (now)</div>
        <div class="ffd-stat__value">${_escapeHtml(ctx.inflow ?? "n/a")}</div>
      </div>
    `;
  }
  if (subEl) subEl.textContent = "Loading 30-day history…";
  if (hostEl) hostEl.innerHTML = `<div class="ffd-modal__loader" id="ffd-modal-loader"><span></span><span></span><span></span></div>`;
  if (descEl) descEl.textContent = "";
  if (headStatsEl) headStatsEl.innerHTML = "";

  // requestToken guards against a fast second click (a different station)
  // resolving out of order and stomping a still-loading first request's
  // eventual render — same staleness-guard idiom used throughout the
  // Story Mode popups this feature's math is shared with.
  const requestToken = (modal._ffdRequestToken = (modal._ffdRequestToken || 0) + 1);

  // GeoGLOWS is a bonus overlay, never a dependency — best-effort, silently
  // skipped if the station has no lat/lon (e.g. clicked without geometry
  // resolving) or the upstream lookup fails.
  let geoglowsPoints = null;
  let geoglowsHorizon = null;
  if (Number.isFinite(ctx.lat) && Number.isFinite(ctx.lon)) {
    try {
      const idRes = await fetch(`/get-geoglows-riverid/?lat=${encodeURIComponent(ctx.lat)}&lon=${encodeURIComponent(ctx.lon)}`, { credentials: "same-origin" });
      if (idRes.ok) {
        const idData = await idRes.json();
        const riverId = idData?.river_id;
        if (Number.isFinite(riverId)) {
          const fcRes = await fetch(`/get-geoglows-forecast/${riverId}/`, { credentials: "same-origin" });
          if (fcRes.ok) {
            const fcData = await fcRes.json();
            const raw = fcData?.raw;
            const datetimes = Array.isArray(raw?.datetime) ? raw.datetime : [];
            const median = Array.isArray(raw?.flow_median) ? raw.flow_median : [];
            const lower = Array.isArray(raw?.flow_uncertainty_lower) ? raw.flow_uncertainty_lower : [];
            const upper = Array.isArray(raw?.flow_uncertainty_upper) ? raw.flow_uncertainty_upper : [];
            geoglowsPoints = datetimes
              .map((dt, i) => ({ date: dt, cms: Number(median[i]) }))
              .filter((p) => Number.isFinite(p.cms));
            const horizonPoints = datetimes
              .map((dt, i) => ({ date: dt, cms: Number(median[i]), lowCms: Number(lower[i]), highCms: Number(upper[i]) }))
              .filter((p) => Number.isFinite(p.cms));
            if (horizonPoints.length) geoglowsHorizon = _buildGeoglowsHorizon(horizonPoints, riverId);
          }
        }
      }
    } catch (_) { /* best-effort */ }
  }
  if (requestToken !== modal._ffdRequestToken) return; // superseded by a newer station click
  // Rendered into the left aside, alongside the Outflow/Inflow "now" cards
  // set synchronously above — this is the same horizon table Story Mode's
  // barrage popup used to render inline; it now lives here instead, since
  // this modal is opened alongside that popup for every station anyway.
  if (statsEl) statsEl.insertAdjacentHTML("beforeend", _renderGeoglowsHorizonHTML(geoglowsHorizon));

  let outlook = null;
  try {
    const historyAllData = await getFfdHistoryAll(30).catch(() => null);
    if (requestToken !== modal._ffdRequestToken) return;
    if (historyAllData?.stations) {
      outlook = buildFfdStationOutlook({
        waypointName: ctx.name,
        historyAllStations: historyAllData.stations,
        geoglowsPoints,
        cmsToCusecs: CMS_TO_CUSECS,
        daysAhead: 14,
        includeInflow: true,
      });
    }
  } catch (_) { /* best-effort */ }
  if (requestToken !== modal._ffdRequestToken) return;

  _renderOutlook(outlook, ctx.name);
}

function _renderOutlook(outlook, name) {
  const subEl = document.getElementById("ffd-modal-sub");
  const hostEl = document.getElementById("ffd-modal-chart-host");
  const descEl = document.getElementById("ffd-modal-description");
  const headStatsEl = document.getElementById("ffd-modal-head-stats");
  if (!outlook) {
    if (subEl) subEl.textContent = "No 30-day discharge history available.";
    if (hostEl) hostEl.innerHTML = `<div class="ffd-modal__empty">History data is not currently available for ${_escapeHtml(name || "this station")}.</div>`;
    if (descEl) descEl.textContent = "";
    if (headStatsEl) headStatsEl.innerHTML = "";
    return;
  }
  if (subEl) subEl.textContent = `${outlook.stats?.days ?? 30}-day history, sampled ${new Date().toLocaleDateString()}`;
  // The Avg/Min/Max/trend pills live in the HEADER now, not the chart
  // host — moving them out gives the chart the entire canvas host to
  // itself (was previously sharing vertical space with two pill rows).
  if (headStatsEl) headStatsEl.innerHTML = outlook.statsRowHTML;
  // Description text is set BEFORE the chart slot is measured below — it's
  // a flex sibling of the canvas host inside .ffd-modal__chart-wrap, and
  // canvas-host's flex-grow shares the wrap's available height with it. If
  // description were still empty at measurement time (as it was previously,
  // set only after the chart render), canvas-host would get measured taller
  // than its real final size — once the description text landed afterward
  // and claimed its own height back, canvas-host would shrink, leaving the
  // already-drawn SVG (built for the taller, stale measurement) unable to
  // fill the now-shorter box at full width: exactly the "shrunk chart with
  // gaps on the sides" symptom. Setting it first means the sibling's real
  // height is already accounted for when the chart slot is measured.
  if (descEl) descEl.innerHTML = outlook.descriptionHTML || _escapeHtml(outlook.description);
  if (hostEl) {
    // Two-stage render: lay out an EMPTY chart slot + legend first, then
    // MEASURE that slot's actual flex-grown box (now that the pills are
    // out of the way, this is effectively the WHOLE host) and re-render
    // the SVG with a matching aspect ratio. This is what keeps the
    // chart's own axis/value labels crisp — a mismatched viewBox forced
    // to fill a differently-shaped box via non-uniform stretching would
    // otherwise squash the text along with the geometry. outlook.chartSVG
    // (the default-aspect-ratio version) is intentionally NOT used here.
    hostEl.innerHTML = `
      <div class="dwr-ffd-chart-slot" id="ffd-modal-chart-slot"></div>
      ${outlook.legendHTML}
    `;
    const slot = document.getElementById("ffd-modal-chart-slot");
    if (slot) {
      const rect = slot.getBoundingClientRect(); // forces layout — reflects the DOM changes just made above
      const aspectRatio = rect.width > 10 && rect.height > 10 ? rect.width / rect.height : undefined;
      slot.innerHTML = renderFfdOutlookChartSVG({
        history: outlook.history,
        regressionForecast: outlook.regressionForecast,
        geoglowsDaily: outlook.geoglowsDaily,
        inflowHistory: outlook.inflowHistory,
        aspectRatio,
      });
    }
    _attachChartTooltip(hostEl);
  }
}

// ---- Hover crosshair tooltip -------------------------------------------
// The chart SVG (renderFfdOutlookChartSVG in ffd-history-forecast.js)
// embeds its merged per-day dataset as a data-points JSON attribute plus
// a transparent full-canvas hit rect (.dwr-ffd-hover-capture, spanning the
// entire svg, not just the inner plot area) — a much bigger, easier target
// than hovering individual data-point circles.
// This reads that embedded data and drives a real floating tooltip +
// moving crosshair guideline, rather than relying on native <title>
// per-point tooltips alone (those stay in the markup as a no-cost
// fallback, e.g. for a screen reader or if JS somehow fails to attach).
function _fmtTooltipNum(v) {
  return Number.isFinite(v) ? Math.round(v).toLocaleString() : null;
}
function _fmtTooltipDate(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function _attachChartTooltip(hostEl) {
  const svg = hostEl.querySelector(".dwr-ffd-chart-svg");
  const capture = svg?.querySelector(".dwr-ffd-hover-capture");
  const hoverLine = svg?.querySelector(".dwr-ffd-hover-line");
  if (!svg || !capture || !hoverLine) return;

  let points;
  try { points = JSON.parse(svg.getAttribute("data-points") || "[]"); } catch (_) { points = []; }
  if (!points.length) return;

  // Mapped from the capture rect's OWN x/width (it now spans the entire
  // svg canvas, not just the inner plot area — see renderFfdOutlookChartSVG
  // — so hovering anywhere over the chart, including the axis-label
  // gutters, resolves to the nearest data point instead of only working
  // inside the narrower plot rectangle).
  const captureX = parseFloat(capture.getAttribute("x"));
  const captureW = parseFloat(capture.getAttribute("width"));
  if (!Number.isFinite(captureX) || !Number.isFinite(captureW) || captureW <= 0) return;

  let tooltip = hostEl.querySelector(".dwr-ffd-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "dwr-ffd-tooltip";
    hostEl.appendChild(tooltip);
  }
  tooltip.style.display = "none";

  const SERIES = [
    { key: "o", label: "Outflow", color: "#3987e5" },
    { key: "i", label: "Inflow", color: "#6da7ec" },
    { key: "t", label: "Trend", color: "#199e70" },
    { key: "g", label: "GeoGLOWS", color: "#d95926" },
  ];

  const onMove = (e) => {
    // capture's own rendered box maps linearly onto its own x/width in SVG
    // user-space (default preserveAspectRatio="xMidYMid meet" scales both
    // axes uniformly, so a simple fraction is correct — no matrix math
    // needed) — no letterbox offset to account for as long as the caller
    // measured the container before choosing the viewBox's aspect ratio.
    const rect = capture.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetX = captureX + frac * captureW;

    let nearest = points[0], bestDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(p.x - targetX);
      if (diff < bestDiff) { bestDiff = diff; nearest = p; }
    }

    hoverLine.setAttribute("x1", nearest.x);
    hoverLine.setAttribute("x2", nearest.x);
    hoverLine.setAttribute("opacity", "1");

    const rows = SERIES
      .filter((s) => nearest[s.key] != null)
      .map((s) => `<span class="dwr-ffd-tt-row"><span class="dwr-ffd-tt-swatch" style="background:${s.color}"></span>${s.label} ${_fmtTooltipNum(nearest[s.key])}</span>`)
      .join("");
    tooltip.innerHTML = `<div class="dwr-ffd-tt-date">${_escapeHtml(_fmtTooltipDate(nearest.d))}</div>${rows}`;
    tooltip.style.display = "block";

    const hostRect = hostEl.getBoundingClientRect();
    let left = e.clientX - hostRect.left + 14;
    let top = e.clientY - hostRect.top - 12;
    const ttRect = tooltip.getBoundingClientRect();
    if (left + ttRect.width > hostRect.width - 8) left = e.clientX - hostRect.left - ttRect.width - 14;
    if (left < 4) left = 4;
    if (top + ttRect.height > hostRect.height - 8) top = hostRect.height - ttRect.height - 8;
    if (top < 4) top = 4;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  const onLeave = () => {
    tooltip.style.display = "none";
    hoverLine.setAttribute("opacity", "0");
  };

  capture.addEventListener("pointermove", onMove);
  capture.addEventListener("pointerleave", onLeave);
}

export function hideFfdModal() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;
  modal.classList.add("hidden");
  modal.classList.remove("is-open");
  modal._ffdRequestToken = (modal._ffdRequestToken || 0) + 1; // invalidate any load still in flight
}

// ---- Delegated click for the real-map popup's "Open Discharge Stats"
// button — same idempotent remove-then-add pattern setupFfdPopupEventHandlers/
// setupHeatwavePopupEventHandlers already use in layer-attribute-popup.js.
function _handleFfdStatsClick(e) {
  const btn = e.target.closest(".ffd-open-stats");
  if (!btn) return;
  const lat = parseFloat(btn.getAttribute("data-lat"));
  const lon = parseFloat(btn.getAttribute("data-lon"));
  showFfdModalForStation({
    name: btn.getAttribute("data-station") || "",
    province: btn.getAttribute("data-province") || "",
    status: btn.getAttribute("data-status") || "",
    outflow: btn.getAttribute("data-outflow"),
    inflow: btn.getAttribute("data-inflow"),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  });
}
export function setupFfdStatsPopupEventHandlers() {
  document.removeEventListener("click", _handleFfdStatsClick);
  document.addEventListener("click", _handleFfdStatsClick);
}

// ---- History priming on layer-toggle-on ----------------------------------
// Wraps sourceLayerControl.addLayerByKey/removeLayerByKey the same
// composable way gcop-ffd-integration.js / LayerInfoPanel / LayerOrderControl
// / LayerStyleConfig / GisExportControl already do (each wrap binds
// whatever was installed before it, so this stacks safely on top of the
// FFD-rivers wrap gcop-ffd-integration.js installs) — zero edits to
// SourceLayerControl itself. The moment the ffd_data toggle is switched
// on, this kicks off (or reuses, via getFfdHistoryAll's own 30-min TTL
// cache) the bulk 30-day history fetch, so by the time an operator
// actually clicks a station the modal opens with data already warm
// instead of showing a multi-second "Loading…".
export function initFfdHistoryPriming(sourceLayerControl) {
  if (!sourceLayerControl || typeof sourceLayerControl.addLayerByKey !== "function") return;
  const origAdd = sourceLayerControl.addLayerByKey.bind(sourceLayerControl);
  sourceLayerControl.addLayerByKey = (key, ...rest) => {
    const r = origAdd(key, ...rest);
    if (key === "ffd_data") getFfdHistoryAll(30).catch(() => null);
    return r;
  };
}
