// ffd-history-forecast.js
// ---------------------------------------------------------------------------
// Pure, DOM/state-agnostic helpers for FFD barrage/dam discharge history and
// a 14-day-ish forward outlook, blending:
//
//   1. A simple linear-regression extrapolation of the REAL 30-day
//      discharge history (getFfdHistoryAll — see gcop-api-cache.js —
//      http://172.18.1.113:8000/proxy_api_daily/api/history-all).
//   2. GeoGLOWS's physically-simulated river-discharge forecast, where a
//      nearby reach resolves (story-dynamic-weather.js's own
//      _fetchGeoglowsForecastSeries feeds this the FULL forecast series,
//      not the 5 sparse horizon points its sibling _fetchGeoglowsForecast
//      keeps for the existing "Now/+24h/+72h/+7d/Peak" table).
//
// No new dependency: the chart is a hand-rolled inline SVG (matches this
// project's existing zero-charting-library convention — see the module note
// atop time-functions.js), and the regression is a plain least-squares fit,
// no stats library needed for a single slope/intercept.
//
// Every function here is pure (no fetch, no DOM writes) — story-dynamic-
// weather.js owns fetching the raw payload and injecting the rendered HTML/
// SVG string into the FFD barrage popup.
// ---------------------------------------------------------------------------

// ---- Station name reconciliation -------------------------------------------
// history-all's station keys are a DIFFERENT naming convention than the
// live ffd_data feed's `properties.name` (confirmed by curling both feeds
// directly): "TARBELA" vs "Tarbela Dam", "KALABAGH" vs "Kala Bagh", "RASUL"
// vs "New Rasul", "PARTAB BRIDGE (BUNJI)" vs "Partab Bridge", "MANGLA" vs
// "Mangla Dam". Stripped-to-alnum equality or substring containment (either
// direction) resolves every one of those automatically. Exactly one pair
// needs an explicit alias — "G.S WALA*" vs "Ganda Singh Wala" share no
// common substring once punctuation is stripped — same "known real-world
// naming inconsistency" pattern story-dynamic-weather.js's own
// _buildFfdWaypoints already documents for the `from` graph.
const FFD_HISTORY_NAME_ALIASES = {
  GANDASINGHWALA: "GSWALA",
};

function _normFfdKey(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Resolves a live FFD waypoint's display name to its matching key in the
 * history-all `stations` object, or null if none resolves. */
export function matchFfdHistoryStationKey(waypointName, historyStationNames) {
  const norm = _normFfdKey(waypointName);
  const aliased = FFD_HISTORY_NAME_ALIASES[norm] || norm;
  for (const hname of historyStationNames) {
    const hnorm = _normFfdKey(hname);
    if (hnorm === aliased || hnorm === norm) return hname;
  }
  for (const hname of historyStationNames) {
    const hnorm = _normFfdKey(hname);
    if (hnorm.includes(aliased) || aliased.includes(hnorm) || hnorm.includes(norm) || norm.includes(hnorm)) return hname;
  }
  return null;
}

// ---- Parsing / resampling ---------------------------------------------------
// history-all timestamps look like "13-Jul-2026 06:00 PKT" — fixed format,
// always PKT (Pakistan carries no DST), so a hand-rolled parse avoids
// depending on the runtime's Date parser accepting a non-ISO, zone-
// abbreviated string (unreliable across browsers).
const _MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function parseFfdHistoryTimestamp(x) {
  const m = String(x || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mi] = m;
  const monthIdx = _MONTHS[mon];
  if (monthIdx == null) return null;
  // Fixed UTC+5 offset (PKT) so every station's series sorts/buckets
  // consistently regardless of the browser's own local timezone.
  return Date.UTC(+yyyy, monthIdx, +dd, +hh - 5, +mi);
}

/** Collapses a raw {x,y} series (irregular ~4-6h steps, occasional
 * duplicate timestamps — confirmed via curl: one station carries two
 * different readings both stamped the same hour) to one point per
 * calendar day (PKT), averaging same-day readings. Returns ascending
 * {dayIndex, dateMs, value}[]. */
export function dailyResampleFfdSeries(series) {
  const byDay = new Map(); // dayKey (ms, UTC midnight of that PKT day) -> {sum, n}
  for (const pt of series || []) {
    const ms = parseFfdHistoryTimestamp(pt.x);
    const y = Number(pt.y);
    if (ms == null || !Number.isFinite(y)) continue;
    const dayKey = Math.floor(ms / 86400000) * 86400000;
    const cur = byDay.get(dayKey) || { sum: 0, n: 0 };
    cur.sum += y;
    cur.n += 1;
    byDay.set(dayKey, cur);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  return days.map(([dateMs, agg], i) => ({ dayIndex: i, dateMs, value: agg.sum / agg.n }));
}

// ---- Regression ---------------------------------------------------------------
/** Ordinary least-squares fit of value ~ dayIndex. Returns null when there
 * are fewer than 2 distinct days (can't fit a line). `r2` is included so
 * callers can flag a low-confidence trend instead of presenting it with
 * false certainty. */
export function linearRegression(dailySeries) {
  const n = dailySeries.length;
  if (n < 2) return null;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (const d of dailySeries) {
    sumX += d.dayIndex; sumY += d.value;
    sumXY += d.dayIndex * d.value; sumXX += d.dayIndex * d.dayIndex;
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return { slope: 0, intercept: sumY / n, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (const d of dailySeries) {
    const pred = intercept + slope * d.dayIndex;
    ssRes += (d.value - pred) ** 2;
    ssTot += (d.value - meanY) ** 2;
  }
  const r2 = ssTot > 1e-9 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, intercept, r2 };
}

/** Extrapolates the fitted line `daysAhead` days past the last real day,
 * clamped to >=0 (discharge can't go negative) — one point per day, dated
 * from the last-observed day + 1..daysAhead. */
export function projectRegression(dailySeries, regression, daysAhead) {
  if (!regression || !dailySeries.length) return [];
  const lastDay = dailySeries[dailySeries.length - 1];
  const out = [];
  for (let i = 1; i <= daysAhead; i++) {
    const dayIndex = lastDay.dayIndex + i;
    const raw = regression.intercept + regression.slope * dayIndex;
    out.push({ dayIndex, dateMs: lastDay.dateMs + i * 86400000, value: Math.max(0, raw) });
  }
  return out;
}

// ---- Stats -------------------------------------------------------------------
export function computeFfdStats(dailySeries) {
  if (!dailySeries.length) return null;
  const values = dailySeries.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const latest = values[values.length - 1];
  // Trend over the last week (or the whole window if shorter) — a short
  // recent slope is more operationally useful than the full-window slope,
  // which an early-window spike would otherwise dominate.
  const windowN = Math.min(7, dailySeries.length);
  const recentReg = linearRegression(dailySeries.slice(-windowN));
  let trend = "steady";
  if (recentReg && Math.abs(recentReg.slope) > mean * 0.01) {
    trend = recentReg.slope > 0 ? "rising" : "falling";
  }
  return { min, max, mean, latest, trend, days: dailySeries.length };
}

// ---- GeoGLOWS daily resample --------------------------------------------------
/** Resamples a GeoGLOWS forecast's full {date, cms}[] series (3-hourly) to
 * one point per calendar day (mean, converted to cusecs via `cmsToCusecs`)
 * — same {dateMs, value} shape dailyResampleFfdSeries produces, so both
 * series overlay on one chart / feed the same renderer. */
export function dailyResampleGeoglows(points, cmsToCusecs) {
  const byDay = new Map();
  for (const p of points || []) {
    const d = new Date(p.date);
    if (Number.isNaN(d.getTime()) || !Number.isFinite(p.cms)) continue;
    const dayKey = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const cur = byDay.get(dayKey) || { sum: 0, n: 0 };
    cur.sum += p.cms * cmsToCusecs;
    cur.n += 1;
    byDay.set(dayKey, cur);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([dateMs, agg]) => ({ dateMs, value: agg.sum / agg.n }));
}

// ---- Description ---------------------------------------------------------------
function _fmtCusecs(v) {
  return Number.isFinite(v) ? Math.round(v).toLocaleString() : "—";
}
function _fmtDay(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Plain-language synthesis for one station — every figure traces back to
 * a real historical reading, a computed regression, or GeoGLOWS's own
 * simulated series; nothing here is invented. `inflowStats` is optional
 * (see buildFfdStationOutlook's `includeInflow` flag) — when absent, this
 * reads/behaves EXACTLY as before (Story Mode's own call never passes it). */
export function describeFfdOutlook({ stats, regression, regressionForecast, geoglowsDaily, stationLabel, inflowStats }) {
  if (!stats) {
    return `No sufficient discharge history is available to build an outlook for ${stationLabel}.`;
  }
  const bits = [
    `Over the past ${stats.days} days, ${stationLabel}'s outflow averaged ${_fmtCusecs(stats.mean)} cusecs (range ${_fmtCusecs(stats.min)}–${_fmtCusecs(stats.max)}), most recently ${_fmtCusecs(stats.latest)} cusecs and ${stats.trend} over the last week.`,
  ];
  if (inflowStats) {
    bits.push(`Inflow over the same window averaged ${_fmtCusecs(inflowStats.mean)} cusecs (range ${_fmtCusecs(inflowStats.min)}–${_fmtCusecs(inflowStats.max)}), most recently ${_fmtCusecs(inflowStats.latest)} cusecs and ${inflowStats.trend} over the last week.`);
    const netLatest = stats.latest - inflowStats.latest;
    if (Number.isFinite(netLatest) && Math.abs(netLatest) > Math.max(stats.mean, inflowStats.mean) * 0.03) {
      bits.push(netLatest > 0
        ? `Outflow is currently exceeding inflow by roughly ${_fmtCusecs(netLatest)} cusecs — storage is drawing down.`
        : `Inflow is currently exceeding outflow by roughly ${_fmtCusecs(-netLatest)} cusecs — storage is accumulating.`);
    } else {
      bits.push("Inflow and outflow are currently close to balanced.");
    }
  }
  if (regressionForecast?.length) {
    const end = regressionForecast[regressionForecast.length - 1];
    const confidence = (regression?.r2 ?? 0) >= 0.5 ? "a reasonably steady" : "a weak, noisy";
    bits.push(`Extending the outflow trend forward (${confidence} fit, R² ${(regression?.r2 ?? 0).toFixed(2)}) projects roughly ${_fmtCusecs(end.value)} cusecs by ${_fmtDay(end.dateMs)}.`);
  }
  if (geoglowsDaily?.length) {
    const peak = geoglowsDaily.reduce((a, b) => (b.value > a.value ? b : a), geoglowsDaily[0]);
    bits.push(`GeoGLOWS' independent river-routing simulation projects a peak of ${_fmtCusecs(peak.value)} cusecs around ${_fmtDay(peak.dateMs)} on the nearest simulated reach.`);
  } else {
    bits.push("GeoGLOWS has no simulated reach resolved near this station, so the trend projection above is the only forward outlook.");
  }
  bits.push("This is a statistical trend and a hydrological simulation, not a flood forecast issued by FFD — treat both as directional context alongside the live reading above.");
  return bits.join(" ");
}

function _escapeHtmlDesc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function _hlValue(v) {
  return `<strong class="dwr-ffd-hl-value">${v}</strong>`;
}
function _hlTrend(word) {
  const cls = word === "rising" ? "dwr-ffd-hl-rising" : word === "falling" ? "dwr-ffd-hl-falling" : "dwr-ffd-hl-steady";
  return `<span class="${cls}">${_escapeHtmlDesc(word)}</span>`;
}

/** Same sentences as describeFfdOutlook (kept as a SEPARATE function
 * rather than a shared builder, so that plain-text function — already
 * relied on by Story Mode's popup — is never at risk of an HTML-escaping
 * regression), but with the key numbers, trend words, confidence
 * descriptors, and the storage-accumulating/drawing-down synthesis
 * wrapped in styled spans, for callers that want a scannable rather than
 * plain-prose reading. Returns a safe, ready-to-insert HTML string —
 * every dynamic value is either a formatted number (never raw user text)
 * or passes through _escapeHtmlDesc first. */
export function describeFfdOutlookHTML({ stats, regression, regressionForecast, geoglowsDaily, stationLabel, inflowStats }) {
  const label = _escapeHtmlDesc(stationLabel);
  if (!stats) {
    return `No sufficient discharge history is available to build an outlook for <strong>${label}</strong>.`;
  }
  const bits = [
    `Over the past ${_hlValue(stats.days)} days, <strong>${label}</strong>'s outflow averaged ${_hlValue(`${_fmtCusecs(stats.mean)} cusecs`)} (range ${_hlValue(`${_fmtCusecs(stats.min)}–${_fmtCusecs(stats.max)}`)}), most recently ${_hlValue(`${_fmtCusecs(stats.latest)} cusecs`)} and ${_hlTrend(stats.trend)} over the last week.`,
  ];
  if (inflowStats) {
    bits.push(`Inflow over the same window averaged ${_hlValue(`${_fmtCusecs(inflowStats.mean)} cusecs`)} (range ${_hlValue(`${_fmtCusecs(inflowStats.min)}–${_fmtCusecs(inflowStats.max)}`)}), most recently ${_hlValue(`${_fmtCusecs(inflowStats.latest)} cusecs`)} and ${_hlTrend(inflowStats.trend)} over the last week.`);
    const netLatest = stats.latest - inflowStats.latest;
    if (Number.isFinite(netLatest) && Math.abs(netLatest) > Math.max(stats.mean, inflowStats.mean) * 0.03) {
      bits.push(netLatest > 0
        ? `Outflow is currently exceeding inflow by roughly ${_hlValue(`${_fmtCusecs(netLatest)} cusecs`)} — <strong class="dwr-ffd-hl-drawdown">storage is drawing down</strong>.`
        : `Inflow is currently exceeding outflow by roughly ${_hlValue(`${_fmtCusecs(-netLatest)} cusecs`)} — <strong class="dwr-ffd-hl-accum">storage is accumulating</strong>.`);
    } else {
      bits.push(`Inflow and outflow are currently close to <span class="dwr-ffd-hl-steady">balanced</span>.`);
    }
  }
  if (regressionForecast?.length) {
    const end = regressionForecast[regressionForecast.length - 1];
    const r2 = regression?.r2 ?? 0;
    const confident = r2 >= 0.5;
    const confidenceLabel = confident ? "a reasonably steady fit" : "a weak, noisy fit";
    const confidenceClass = confident ? "dwr-ffd-hl-confident" : "dwr-ffd-hl-unsure";
    bits.push(`Extending the outflow trend forward (<span class="${confidenceClass}">${confidenceLabel}</span>, R² ${_hlValue(r2.toFixed(2))}) projects roughly ${_hlValue(`${_fmtCusecs(end.value)} cusecs`)} by ${_hlValue(_escapeHtmlDesc(_fmtDay(end.dateMs)))}.`);
  }
  if (geoglowsDaily?.length) {
    const peak = geoglowsDaily.reduce((a, b) => (b.value > a.value ? b : a), geoglowsDaily[0]);
    bits.push(`<span class="dwr-ffd-hl-source">GeoGLOWS</span>' independent river-routing simulation projects a peak of ${_hlValue(`${_fmtCusecs(peak.value)} cusecs`)} around ${_hlValue(_escapeHtmlDesc(_fmtDay(peak.dateMs)))} on the nearest simulated reach.`);
  } else {
    bits.push(`<span class="dwr-ffd-hl-source">GeoGLOWS</span> has no simulated reach resolved near this station, so the trend projection above is the only forward outlook.`);
  }
  bits.push("This is a statistical trend and a hydrological simulation, not a flood forecast issued by FFD — treat both as directional context alongside the live reading above.");
  return bits.join(" ");
}

// ---- Chart (hand-rolled inline SVG — no charting library, matches this
// project's existing convention) -------------------------------------------
// Colors are the dark-mode categorical slots 1/2/3 from NCOP's data-viz
// palette method (blue/orange/aqua) — that exact 3-slot subset is the one
// validated to pass CVD-separation/contrast/lightness checks together in
// dark mode, which is why History/Trend/GeoGLOWS map to those three and not
// an arbitrary pick. Inflow (opt-in, see includeInflow below) deliberately
// does NOT take a 4th competing hue — the palette method's own guidance is
// that a 4th categorical slot (yellow) fails its CVD floor against slot 2
// (orange, already used by GeoGLOWS here). Inflow instead reuses outflow's
// own blue family one step lighter on the same sequential ramp (#6da7ec,
// step 300) — a secondary encoding (lightness + a distinct dash pattern),
// not a new identity color, so it never collides with GeoGLOWS/Trend.
const _CHART_COLORS = {
  history: "#3987e5",
  regression: "#199e70",
  geoglows: "#d95926",
  inflow: "#6da7ec",
  grid: "rgba(255,255,255,0.14)",
  text: "rgba(234,234,234,0.55)",
  textStrong: "#eaeaea",
};

function _escapeHtmlLocal(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Renders the 30-day history + up-to-14-day outlook as one inline SVG
 * line chart. `history`/`regressionForecast`/`geoglowsDaily` are all
 * {dateMs, value}[] already converted to the SAME unit (cusecs) so they
 * share one y-scale — never a dual-axis chart. `inflowHistory` is optional
 * (defaults to none) — when omitted, this renders BYTE-FOR-BYTE identical
 * to before (Story Mode's own call never passes it), so that existing,
 * already-shipped chart is untouched. `aspectRatio` (width/height) lets a
 * caller match the chart's viewBox shape to its ACTUAL rendered container
 * before drawing — the previous approach (a fixed 300x120 viewBox stretched
 * non-uniformly via preserveAspectRatio="none" to fill an arbitrarily-
 * shaped box) filled the box but visibly squashed/stretched every text
 * label, since a non-uniform scale distorts glyph shapes. Matching the
 * viewBox shape to the container instead means the DEFAULT uniform scaling
 * (preserveAspectRatio, unset below = "xMidYMid meet") both fills the box
 * AND keeps every label crisp, since scaling by the same factor on both
 * axes never distorts text. Omitted (default 300/120 = 2.5), this renders
 * identically to the fixed original — Story Mode's own call never passes
 * it. Returns "" if there isn't enough data to plot anything. */
export function renderFfdOutlookChartSVG({ history, regressionForecast, geoglowsDaily, inflowHistory = [], aspectRatio = 300 / 120 }) {
  const width = 300;
  // Clamped so a pathological measurement (a near-zero-height or
  // extremely tall container) can't produce an unreadable or degenerate
  // chart — matches this function's own established padding/font-size
  // constants, tuned for roughly this range.
  const height = Math.round(Math.min(220, Math.max(90, width / (aspectRatio || 300 / 120))));
  const allPoints = [...history, ...regressionForecast, ...geoglowsDaily, ...inflowHistory];
  if (allPoints.length < 2) return "";

  const padL = 34, padR = 8, padT = 10, padB = 16;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const minX = Math.min(...allPoints.map((p) => p.dateMs));
  const maxX = Math.max(...allPoints.map((p) => p.dateMs));
  const rawMaxY = Math.max(...allPoints.map((p) => p.value));
  const spanX = Math.max(maxX - minX, 1);

  // Rounded to a tidy number so the gridline labels read cleanly (0 / 1,000
  // / 2,000 style) rather than an arbitrary decimal.
  const niceMax = (() => {
    const raw = rawMaxY > 0 ? rawMaxY * 1.12 : 1; // headroom so the peak isn't clipped against the top edge
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    return Math.ceil(raw / mag) * mag;
  })();

  const xAt = (ms) => padL + ((ms - minX) / spanX) * plotW;
  const yAt = (v) => padT + plotH - (Math.max(0, v) / niceMax) * plotH;
  const pathFor = (pts) => pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p.dateMs).toFixed(1)} ${yAt(p.value).toFixed(1)}`).join(" ");

  const nowX = history.length ? xAt(history[history.length - 1].dateMs) : null;
  const gridSteps = [0, niceMax / 2, niceMax];

  const historyAreaPath = history.length
    ? `${pathFor(history)} L ${xAt(history[history.length - 1].dateMs).toFixed(1)} ${(padT + plotH).toFixed(1)} L ${xAt(history[0].dateMs).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
    : "";

  // The dashed regression line is drawn starting from history's own last
  // point (a real reading) so it reads as a continuation of that series,
  // not a disconnected floating segment — mathematically true, since
  // projectRegression's first point is exactly dayIndex+1 from it. GeoGLOWS
  // is a genuinely separate, independently-dated source, so it is NOT
  // stitched onto history the same way.
  const regressionPath = regressionForecast.length
    ? pathFor([history[history.length - 1], ...regressionForecast].filter(Boolean))
    : "";

  const endLabel = (pts, color) => {
    if (!pts.length) return "";
    const last = pts[pts.length - 1];
    const x = xAt(last.dateMs), y = yAt(last.value);
    return `
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color}" stroke="#14181f" stroke-width="2"><title>${_fmtCusecs(last.value)} cusecs — ${_escapeHtmlLocal(_fmtDay(last.dateMs))}</title></circle>
      <text x="${Math.min(x, width - padR - 2).toFixed(1)}" y="${Math.max(y - 8, padT + 8).toFixed(1)}" text-anchor="end" font-size="9" fill="${_CHART_COLORS.textStrong}">${_fmtCusecs(last.value)}</text>
    `;
  };
  const pointTitles = (pts, label) => pts.map((p) => `<circle cx="${xAt(p.dateMs).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="7" fill="transparent"><title>${_escapeHtmlLocal(label)}: ${_fmtCusecs(p.value)} cusecs — ${_escapeHtmlLocal(_fmtDay(p.dateMs))}</title></circle>`).join("");

  // X-axis date labels — start / "now" / end, sitting in the padB gutter
  // below the plot (the tooltip crosshair already surfaces the exact date
  // for any point on hover; these three give that same context by default,
  // without hover). "now" is skipped if it would sit too close to either
  // edge label to avoid overlapping text.
  const xAxisLabel = (ms, x, anchor) => `<text x="${x.toFixed(1)}" y="${(padT + plotH + 11).toFixed(1)}" text-anchor="${anchor}" font-size="8.5" fill="${_CHART_COLORS.text}">${_escapeHtmlLocal(_fmtDay(ms))}</text>`;

  // Merged per-day dataset for the JS-driven crosshair tooltip (see
  // ffd-stats-modal.js's _attachChartTooltip) — embedded as a data
  // attribute rather than recomputed from the DOM, so the tooltip's
  // values can never drift from what's actually plotted. Purely additive:
  // Story Mode's existing consumer reads none of this and is unaffected.
  const byDay = new Map();
  const mergeIn = (pts, field) => {
    for (const p of pts) {
      const row = byDay.get(p.dateMs) || { d: p.dateMs, x: Math.round(xAt(p.dateMs) * 10) / 10 };
      row[field] = Math.round(p.value);
      byDay.set(p.dateMs, row);
    }
  };
  mergeIn(history, "o");
  mergeIn(inflowHistory, "i");
  mergeIn(regressionForecast, "t");
  mergeIn(geoglowsDaily, "g");
  const mergedDays = [...byDay.values()].sort((a, b) => a.d - b.d);
  const pointsAttr = _escapeHtmlLocal(JSON.stringify(mergedDays));

  return `
    <svg viewBox="0 0 ${width} ${height}" class="dwr-ffd-chart-svg" role="img" aria-label="30-day discharge history and 14-day outlook"
         data-points='${pointsAttr}' data-plot-left="${padL}" data-plot-right="${width - padR}" data-plot-top="${padT}" data-plot-bottom="${padT + plotH}">
      ${gridSteps.map((v) => `
        <line x1="${padL}" x2="${width - padR}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}" stroke="${_CHART_COLORS.grid}" stroke-width="1"/>
        <text x="${padL - 4}" y="${(yAt(v) + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="${_CHART_COLORS.text}">${v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)}</text>
      `).join("")}
      ${nowX != null ? `<line x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${padT}" y2="${padT + plotH}" stroke="${_CHART_COLORS.text}" stroke-width="1" stroke-dasharray="2 2"/>` : ""}
      ${historyAreaPath ? `<path d="${historyAreaPath}" fill="${_CHART_COLORS.history}" fill-opacity="0.10" stroke="none"/>` : ""}
      ${inflowHistory.length ? `<path d="${pathFor(inflowHistory)}" fill="none" stroke="${_CHART_COLORS.inflow}" stroke-width="1.75" stroke-dasharray="3 2" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
      ${history.length ? `<path d="${pathFor(history)}" fill="none" stroke="${_CHART_COLORS.history}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
      ${regressionPath ? `<path d="${regressionPath}" fill="none" stroke="${_CHART_COLORS.regression}" stroke-width="2" stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
      ${geoglowsDaily.length ? `<path d="${pathFor(geoglowsDaily)}" fill="none" stroke="${_CHART_COLORS.geoglows}" stroke-width="2" stroke-dasharray="1 3" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
      ${pointTitles(history, "Outflow history")}
      ${pointTitles(inflowHistory, "Inflow history")}
      ${pointTitles(regressionForecast, "Outflow trend projection")}
      ${pointTitles(geoglowsDaily, "GeoGLOWS forecast")}
      ${endLabel(history, _CHART_COLORS.history)}
      ${endLabel(inflowHistory, _CHART_COLORS.inflow)}
      ${endLabel(regressionForecast, _CHART_COLORS.regression)}
      ${endLabel(geoglowsDaily, _CHART_COLORS.geoglows)}
      ${xAxisLabel(minX, padL, "start")}
      ${nowX != null && nowX > padL + 14 && nowX < width - padR - 14 ? xAxisLabel(history[history.length - 1].dateMs, nowX, "middle") : ""}
      ${xAxisLabel(maxX, width - padR, "end")}
      <line class="dwr-ffd-hover-line" x1="0" x2="0" y1="${padT}" y2="${padT + plotH}" stroke="${_CHART_COLORS.textStrong}" stroke-width="1" stroke-dasharray="2 2" opacity="0" pointer-events="none"/>
      <rect class="dwr-ffd-hover-capture" x="0" y="0" width="${width}" height="${height}" fill="transparent"/>
    </svg>
  `;
}

function _legendSwatch(color, dashed) {
  return `<span class="dwr-ffd-legend-swatch${dashed ? " dwr-ffd-legend-swatch--dashed" : ""}" style="color:${color}"></span>`;
}

/** Legend for the chart above — always shown alongside it (per the
 * "identity is never color-alone" rule for >=2 series), styled via
 * .dwr-ffd-legend* in story-dynamic-weather.js's injected stylesheet (and
 * equivalently in _popup.css for the FFD Stats Modal). `includeInflow`
 * defaults to false so Story Mode's own call (which never passes it)
 * renders EXACTLY the existing 3-item legend, unchanged. */
export function renderFfdOutlookLegendHTML({ includeInflow = false } = {}) {
  return `
    <div class="dwr-ffd-legend">
      <span class="dwr-ffd-legend-item">${_legendSwatch(_CHART_COLORS.history, false)}Outflow history (30d)</span>
      ${includeInflow ? `<span class="dwr-ffd-legend-item">${_legendSwatch(_CHART_COLORS.inflow, true)}Inflow history (30d)</span>` : ""}
      <span class="dwr-ffd-legend-item">${_legendSwatch(_CHART_COLORS.regression, true)}Outflow trend projection</span>
      <span class="dwr-ffd-legend-item">${_legendSwatch(_CHART_COLORS.geoglows, true)}GeoGLOWS forecast</span>
    </div>
  `;
}

/** Compact stat pills — min/max/mean/latest/trend — rendered above the
 * chart. Returns "" when there's no data (caller shows a plain message
 * instead). `inflowStats` is optional; when provided, a second labeled
 * row (In: …) is added below the outflow row (Out: …) so the two read as
 * a clear comparison rather than an ambiguous duplicate set of numbers.
 * Story Mode's own call passes only `stats`, so its existing single,
 * unlabeled row renders exactly as before. */
export function renderFfdStatsRowHTML(stats, inflowStats) {
  if (!stats) return "";
  const pillsFor = (s, prefix) => {
    const trendClass = s.trend === "rising" ? " dwr-ffd-stat-pill--rising" : s.trend === "falling" ? " dwr-ffd-stat-pill--falling" : "";
    const trendArrow = s.trend === "rising" ? "↑" : s.trend === "falling" ? "↓" : "→";
    const p = prefix ? `${prefix} ` : "";
    return `
      <span class="dwr-ffd-stat-pill">${p}Avg ${_fmtCusecs(s.mean)}</span>
      <span class="dwr-ffd-stat-pill">${p}Min ${_fmtCusecs(s.min)}</span>
      <span class="dwr-ffd-stat-pill">${p}Max ${_fmtCusecs(s.max)}</span>
      <span class="dwr-ffd-stat-pill${trendClass}">${p}${trendArrow} ${_escapeHtmlLocal(s.trend)} (7d)</span>
    `;
  };
  if (!inflowStats) {
    return `<div class="dwr-ffd-stats-row">${pillsFor(stats, "")}</div>`;
  }
  return `
    <div class="dwr-ffd-stats-row">${pillsFor(stats, "Out")}</div>
    <div class="dwr-ffd-stats-row dwr-ffd-stats-row--inflow">${pillsFor(inflowStats, "In")}</div>
  `;
}

/**
 * Top-level entry point — builds everything a barrage popup needs from the
 * raw history-all payload + (optionally) a full GeoGLOWS forecast series,
 * for ONE station. Returns null if no history matched this station at all.
 *
 * `includeInflow` (default false) additionally samples the SAME station's
 * inflow series and threads it through the chart/legend/stats/description
 * as a companion to outflow. Story Mode's own call never passes this, so
 * its outflow-only computation, chart, legend, and stats row are all
 * completely unaffected — every inflow-related value below is `null`/[]
 * and every renderer's optional inflow param is simply omitted, which
 * each one documents falls back to its pre-existing exact behavior.
 */
export function buildFfdStationOutlook({ waypointName, historyAllStations, geoglowsPoints, cmsToCusecs, daysAhead = 14, includeInflow = false }) {
  const historyStationNames = Object.keys(historyAllStations || {});
  const key = matchFfdHistoryStationKey(waypointName, historyStationNames);
  const rawSeries = key ? historyAllStations[key]?.outflow : null;
  if (!rawSeries?.length) return null;

  const history = dailyResampleFfdSeries(rawSeries);
  const regression = linearRegression(history);
  const regressionForecast = projectRegression(history, regression, daysAhead);
  const stats = computeFfdStats(history);
  const geoglowsDaily = geoglowsPoints?.length ? dailyResampleGeoglows(geoglowsPoints, cmsToCusecs) : [];

  let inflowHistory = [], inflowStats = null;
  if (includeInflow) {
    const rawInflow = historyAllStations[key]?.inflow;
    if (rawInflow?.length) {
      inflowHistory = dailyResampleFfdSeries(rawInflow);
      inflowStats = computeFfdStats(inflowHistory);
    }
  }

  return {
    matchedKey: key,
    history,
    regression,
    regressionForecast,
    geoglowsDaily,
    stats,
    inflowHistory,
    inflowStats,
    description: describeFfdOutlook({ stats, regression, regressionForecast, geoglowsDaily, stationLabel: waypointName, inflowStats }),
    descriptionHTML: describeFfdOutlookHTML({ stats, regression, regressionForecast, geoglowsDaily, stationLabel: waypointName, inflowStats }),
    chartSVG: renderFfdOutlookChartSVG({ history, regressionForecast, geoglowsDaily, inflowHistory }),
    legendHTML: renderFfdOutlookLegendHTML({ includeInflow: inflowHistory.length > 0 }),
    statsRowHTML: renderFfdStatsRowHTML(stats, inflowStats),
  };
}
