// gefs-outlook-export.js
// "35-Day District Weather Outlook" — a bulletin-style report of the NOAA
// GEFS 35-day outlook (rain + temperature) for every district of Pakistan,
// exported from the Weather Report panel's GEFS view.
//
//   exportGefsOutlook("word" | "pdf" | "csv")
//
// Data: /api/gefs/districts/?var=precip|t2m (area-weighted GEFS ensemble
// mean per district polygon, days 1-35) — the same documents the panel
// shows; nothing is sampled from the map.
//
// Layout (written for non-specialists first, detail after):
//   Cover band + headline tiles
//   1. The next five weeks at a glance  — week cards: icon, rain, temperature, confidence
//   2. What to expect                   — plain-language summary + things to consider
//   3. Rain outlook                     — charts: rainy districts per day, rain by province,
//                                         wettest districts by week
//   4. Temperature outlook              — charts: national temperature band, province ranges
//   5. Province by province             — plain-language summary, mini charts, district tables
//   Annex A/B daily matrices · Glossary · Method and sources
//
// Charts are inline SVG (crisp in print/PDF). For Word they are rasterised to
// PNG and packaged with the HTML as a single-file web archive (MHTML), which
// Word opens as a normal document with the pictures in place.

const API = `${window.location.origin}/api/gefs/districts/`;
// Weeks from today; set per document (the outlook starts today, so it has
// 35 days once today's run is published and 34 before that).
let WEEKS = [[1, 7], [8, 14], [15, 21], [22, 28], [29, 35]];
let NDAYS = 35;
function setPeriod(days) {
  NDAYS = days;
  WEEKS = [0, 1, 2, 3, 4].map((i) => [i * 7 + 1, Math.min(days, i * 7 + 7)]).filter(([a, b]) => a <= b);
  if (days > 35) WEEKS[WEEKS.length - 1][1] = days;
}
// Daily rainfall categories (IMD scale, also used in PMD bulletins).
const RAIN_DAY = 2.5, MODERATE = 15.6, HEAVY = 64.5;
// Fixed colours (light print surface). Rain = blue, temperature = orange;
// the two never share a chart. Week shades: one blue ramp, light → dark.
const C = {
  ink: "#16202c", ink2: "#4a5563", muted: "#7b8594", rule: "#d5dbe3", panel: "#f4f7fb",
  navy: "#0b3d6e", navy2: "#1b5c99", rain: "#2a78d6", temp: "#eb6834", tempSoft: "#fbd9c9",
  ext: "#eef0f3", weeks: ["#c6dcf7", "#93bdf0", "#5a98e3", "#2a78d6", "#1a4f99"],
};
const CONF = [
  { label: "High", note: "reliable day-to-day", color: "#1e8a4c" },
  { label: "Good", note: "reliable for planning", color: "#3c9a5f" },
  { label: "Moderate", note: "trends, not exact days", color: "#b97800" },
  { label: "Low", note: "broad tendency only", color: "#c4561a" },
  { label: "Low", note: "broad tendency only", color: "#c4561a" },
];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f1 = (v) => (v == null || !Number.isFinite(v) ? "–" : v.toFixed(1));
const f0 = (v) => (v == null || !Number.isFinite(v) ? "–" : Math.round(v).toString());
const sum = (a) => a.reduce((s, v) => s + (v ?? 0), 0);
const fin = (a) => a.filter((v) => v != null && Number.isFinite(v));
const mean = (a) => { const f = fin(a); return f.length ? sum(f) / f.length : null; };
const slice = (s, [a, b]) => s.slice(a - 1, b);
const pct = (a, q) => { const s = fin(a).sort((x, y) => x - y); if (!s.length) return null; const i = (s.length - 1) * q; const lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
const clean = (s) => String(s ?? "").replace(/_/g, " ").trim();

// --------------------------------------------------------------------- data
async function getJson(variable) {
  const started = Date.now();
  for (;;) {
    const r = await fetch(`${API}?var=${variable}`, { credentials: "same-origin" });
    if (r.status === 200) return r.json();
    if (r.status !== 202 || Date.now() - started > 120000) throw new Error(`district values unavailable (HTTP ${r.status})`);
    await new Promise((res) => setTimeout(res, 10000));
  }
}

export async function loadBoth() {
  let [p, t] = await Promise.all([getJson("precip"), getJson("t2m")]);
  if (p.run !== t.run) [p, t] = await Promise.all([getJson("precip"), getJson("t2m")]);   // a new run landed in between
  if (p.run !== t.run) throw new Error("GEFS run changed during export — please retry");
  setPeriod(p.days);
  const tByKey = new Map(t.districts.map((d) => [`${d.province}|${d.name}`, d]));
  const rows = p.districts.map((d) => {
    const td = tByKey.get(`${d.province}|${d.name}`) || {};
    return { name: clean(d.name), province: clean(d.province) || "—", division: clean(d.division), precip: d.precip || [], precipMax: d.precip_max || [],
             t2m: td.t2m || [], t2mMin: td.t2m_min || [], t2mMax: td.t2m_max || [] };
  });
  rows.forEach(analyse);
  return { p, t, rows };
}

function analyse(r) {
  const P = r.precip, T = r.t2m;
  r.total = sum(P);
  r.weekRain = WEEKS.map((w) => sum(slice(P, w)));
  r.weekTemp = WEEKS.map((w) => mean(slice(T, w)));
  r.rainDays = P.filter((v) => v >= RAIN_DAY).length;
  r.modDays = P.filter((v) => v >= MODERATE).length;
  r.heavyDays = P.filter((v) => v >= HEAVY).length;
  let wd = 0;
  P.forEach((v, i) => { if ((v ?? 0) > (P[wd] ?? 0)) wd = i; });
  r.wettestDay = wd + 1; r.wettestVal = P[wd] ?? 0;
  r.firstRain = P.findIndex((v) => v >= RAIN_DAY) + 1;            // 0 = none
  const tf = fin(T);
  r.tMean = mean(T); r.tLo = tf.length ? Math.min(...tf) : null; r.tHi = tf.length ? Math.max(...tf) : null;
  r.coldSpot = fin(r.t2mMin).length ? Math.min(...fin(r.t2mMin)) : null;
  r.warmSpot = fin(r.t2mMax).length ? Math.max(...fin(r.t2mMax)) : null;
  r.subZeroDays = r.t2mMin.filter((v) => v != null && v < 0).length;
  r.tTrend = r.weekTemp[4] != null && r.weekTemp[0] != null ? r.weekTemp[4] - r.weekTemp[0] : null;
}

function provinceStats(rows, days) {
  const by = new Map();
  rows.forEach((r) => { if (!by.has(r.province)) by.set(r.province, []); by.get(r.province).push(r); });
  return [...by.entries()].map(([name, rs]) => ({
    name, rows: rs.slice().sort((a, b) => a.name.localeCompare(b.name)), n: rs.length,
    total: mean(rs.map((r) => r.total)), weekRain: WEEKS.map((_, i) => mean(rs.map((r) => r.weekRain[i]))),
    weekTemp: WEEKS.map((_, i) => mean(rs.map((r) => r.weekTemp[i]))),
    dailyRain: Array.from({ length: days }, (_, d) => mean(rs.map((r) => r.precip[d]))),
    dailyTemp: Array.from({ length: days }, (_, d) => mean(rs.map((r) => r.t2m[d]))),
    tCold: Math.min(...fin(rs.map((r) => r.tMean))), tWarm: Math.max(...fin(rs.map((r) => r.tMean))), tMean: mean(rs.map((r) => r.tMean)),
    wettest: rs.reduce((a, b) => (b.total > a.total ? b : a)),
    subZero: rs.filter((r) => r.subZeroDays > 0).length,
  })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ plain words
function rainWords(total, rainDays) {
  if (total < RAIN_DAY) return "Dry";
  if (total < 10) return "Mostly dry, a passing shower";
  if (total < 25) return rainDays >= 5 ? "Light rain on several days" : "A few light showers";
  if (total < 50) return "Several rainy days";
  return "Wet spell(s), rain on many days";
}
function dayRainWord(v) {
  if (v == null || v < 0.5) return "dry";
  if (v < RAIN_DAY) return "drizzle";
  if (v < MODERATE) return "light rain";
  if (v < HEAVY) return "moderate rain";
  return "heavy rain";
}
function tempWord(t) {
  if (t == null) return "–";
  if (t < -10) return "Severe cold";
  if (t < 0) return "Freezing";
  if (t < 5) return "Very cold";
  if (t < 10) return "Cold";
  if (t < 15) return "Cool";
  if (t < 20) return "Mild";
  if (t < 25) return "Warm";
  if (t < 30) return "Hot";
  return "Very hot";
}
function trendWord(dt) {
  if (dt == null) return "";
  if (dt <= -3) return "getting much colder";
  if (dt <= -1) return "getting colder";
  if (dt >= 3) return "getting much warmer";
  if (dt >= 1) return "getting warmer";
  return "little change";
}
const arrow = (dt) => (dt == null ? "" : dt <= -1 ? "↓" : dt >= 1 ? "↑" : "→");

// --------------------------------------------------------------- colours
function classColor(v, scale) {
  if (v == null) return null;
  let i = 0;
  while (i < scale.bounds.length && v >= scale.bounds[i]) i++;
  return scale.colors[i] || null;
}
function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6 ? "#111" : "#fff";
}
function cell(v, scale, txt, cls = "m") {
  const c = classColor(v, scale);
  return c ? `<td class="${cls}" style="background:${c};color:${textOn(c)}">${txt}</td>` : `<td class="${cls}">${txt}</td>`;
}
const dDate = (doc, d, opts = { day: "2-digit", month: "short" }) => {
  const iso = doc.dates?.[d - 1];
  if (!iso) return `day ${d}`;
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
};
const weekRange = (doc, i) => `${dDate(doc, WEEKS[i][0])} – ${dDate(doc, WEEKS[i][1])}`;

// ----------------------------------------------------------------- icons
// Simple weather glyphs (inline SVG; rasterised for Word like the charts).
function icon(kind, size = 44) {
  const sun = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#f7b500"/>${Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4, x1 = cx + Math.cos(a) * (r + 3), y1 = cy + Math.sin(a) * (r + 3), x2 = cx + Math.cos(a) * (r + 7), y2 = cy + Math.sin(a) * (r + 7);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#f7b500" stroke-width="2.4" stroke-linecap="round"/>`; }).join("")}`;
  const cloud = (dx, dy, fill) => `<path transform="translate(${dx},${dy})" d="M12 30 h22 a8 8 0 0 0 0-16 a11 11 0 0 0-21-2 a7.5 7.5 0 0 0-1 18z" fill="${fill}" stroke="#8796a8" stroke-width="1.2"/>`;
  const drops = (dx, dy) => [0, 9, 18].map((x) => `<line x1="${dx + x + 4}" y1="${dy}" x2="${dx + x}" y2="${dy + 8}" stroke="${C.rain}" stroke-width="2.6" stroke-linecap="round"/>`).join("");
  const flake = (cx, cy, r, col = "#4a90d9") => [0, 60, 120].map((a) => `<line x1="${cx - r}" y1="${cy}" x2="${cx + r}" y2="${cy}" stroke="${col}" stroke-width="2" stroke-linecap="round" transform="rotate(${a} ${cx} ${cy})"/>`).join("");
  const body = {
    sun: sun(22, 22, 9),
    suncloud: sun(16, 15, 7) + cloud(4, 8, "#ffffff"),
    cloudrain: sun(16, 13, 6) + cloud(2, 4, "#eef2f7") + drops(12, 36),
    rain: cloud(2, 2, "#dfe6ef") + drops(11, 34),
    cold: flake(22, 22, 13),
    rainsnow: cloud(2, 2, "#dfe6ef") + drops(8, 34) + flake(36, 38, 5),
  }[kind] || "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 44 44">${body}</svg>`;
}

// ---------------------------------------------------------------- charts
const FONT = "Segoe UI, Arial, sans-serif";
function svg(w, h, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" font-family="${FONT}" style="max-width:100%;height:auto">${body}</svg>`;
}
const txt = (x, y, s, o = {}) => `<text x="${typeof x === "number" ? x.toFixed(1) : x}" y="${typeof y === "number" ? y.toFixed(1) : y}" font-size="${o.size || 11}" fill="${o.fill || C.ink2}" text-anchor="${o.anchor || "start"}"${o.weight ? ` font-weight="${o.weight}"` : ""}>${esc(s)}</text>`;
const niceMax = (v) => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 2.5, 5, 10]) if (v <= k * p) return k * p;
  return 10 * p;
};

// Shared time frame for day-axis charts: week labels, extended-range shade.
function dayFrame(doc, W, H, m, yTicks, yFmt, yMax, yMin = 0) {
  const n = doc.days, pw = W - m.l - m.r, ph = H - m.t - m.b, bw = pw / n;
  const y = (v) => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;
  const ext = doc.daily_skill_days;
  let g = `<rect x="${(m.l + ext * bw).toFixed(1)}" y="${m.t}" width="${((n - ext) * bw).toFixed(1)}" height="${ph}" fill="${C.ext}"/>`;
  g += txt(m.l + ext * bw + 6, m.t + 13, "Lower confidence: read as a tendency", { size: 10, fill: C.muted });
  yTicks.forEach((v) => { g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${C.rule}" stroke-width="1"/>` + txt(m.l - 6, y(v) + 4, yFmt(v), { anchor: "end", size: 10, fill: C.muted }); });
  WEEKS.forEach(([a, b], i) => {
    if (i) g += `<line x1="${(m.l + (a - 1) * bw).toFixed(1)}" x2="${(m.l + (a - 1) * bw).toFixed(1)}" y1="${m.t}" y2="${m.t + ph + 6}" stroke="${C.rule}" stroke-dasharray="3 3"/>`;
    g += txt(m.l + ((a - 1 + b) / 2) * bw, H - m.b + 18, `Week ${i + 1}`, { anchor: "middle", size: 11, fill: C.ink, weight: 600 });
    g += txt(m.l + ((a - 1 + b) / 2) * bw, H - m.b + 32, weekRange(doc, i), { anchor: "middle", size: 9.5, fill: C.muted });
  });
  return { g, x: (d) => m.l + (d - 1) * bw, bw, y, ph };
}

function chartRainyDistricts(doc, rows) {
  const n = doc.days, counts = Array.from({ length: n }, (_, d) => rows.filter((r) => (r.precip[d] ?? 0) >= RAIN_DAY).length);
  const W = 1000, H = 250, m = { l: 44, r: 14, t: 18, b: 44 };
  const yMax = Math.max(10, niceMax(Math.max(...counts) * 1.12));
  const f = dayFrame(doc, W, H, m, [0, yMax / 2, yMax], (v) => f0(v), yMax);
  let g = f.g;
  counts.forEach((c, d) => {
    if (!c) return;
    const x = f.x(d + 1) + 2, w = f.bw - 4, top = f.y(c), h = f.y(0) - top, r = Math.min(3, h / 2);
    g += `<path d="M${x.toFixed(1)},${f.y(0).toFixed(1)} v${(-(h - r)).toFixed(1)} q0,${-r} ${r},${-r} h${(w - 2 * r).toFixed(1)} q${r},0 ${r},${r} v${(h - r).toFixed(1)}z" fill="${C.rain}"/>`;
  });
  const peak = counts.indexOf(Math.max(...counts));
  if (counts[peak] > 0) g += txt(Math.min(f.x(peak + 1) + f.bw / 2, W - 90), f.y(counts[peak]) - 6, `${counts[peak]} districts · ${dDate(doc, peak + 1)}`, { anchor: "middle", size: 10.5, fill: C.ink, weight: 600 });
  g += `<line x1="${m.l}" x2="${W - m.r}" y1="${f.y(0)}" y2="${f.y(0)}" stroke="${C.ink2}"/>`;
  return svg(W, H, g, "Number of districts expecting rain each day");
}

function chartTempBand(doc, rows) {
  const n = doc.days, W = 1000, H = 270, m = { l: 44, r: 104, t: 18, b: 44 };
  const lo = [], hi = [], md = [], cold = [], warm = [];
  for (let d = 0; d < n; d++) {
    const v = rows.map((r) => r.t2m[d]);
    lo.push(pct(v, 0.1)); hi.push(pct(v, 0.9)); md.push(pct(v, 0.5)); cold.push(pct(v, 0)); warm.push(pct(v, 1));
  }
  const yMin = Math.floor(Math.min(...fin(cold)) / 10) * 10, yMax = Math.ceil(Math.max(...fin(warm)) / 10) * 10;
  const ticks = []; for (let v = yMin; v <= yMax; v += 10) ticks.push(v);
  const f = dayFrame(doc, W, H, m, ticks, (v) => `${v}°`, yMax, yMin);
  const cx = (d) => f.x(d + 1) + f.bw / 2;
  const line = (a) => a.map((v, d) => `${d ? "L" : "M"}${cx(d).toFixed(1)},${f.y(v).toFixed(1)}`).join("");
  let g = f.g;
  if (yMin < 0 && yMax > 0) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${f.y(0)}" y2="${f.y(0)}" stroke="#7aa7d8" stroke-width="1.2"/>`;
  g += `<path d="${line(hi)}${lo.map((_, k) => `L${cx(n - 1 - k).toFixed(1)},${f.y(lo[n - 1 - k]).toFixed(1)}`).join("")}Z" fill="${C.tempSoft}"/>`;
  g += `<path d="${line(warm)}" fill="none" stroke="${C.temp}" stroke-width="1.3" stroke-dasharray="4 3"/>`;
  g += `<path d="${line(cold)}" fill="none" stroke="#4a90d9" stroke-width="1.3" stroke-dasharray="4 3"/>`;
  g += `<path d="${line(md)}" fill="none" stroke="${C.temp}" stroke-width="2.6" stroke-linejoin="round"/>`;
  const e = n - 1, lx = W - m.r + 8;
  g += txt(lx, f.y(warm[e]) + 4, `warmest ${f0(warm[e])} °C`, { size: 10, fill: C.ink2 });
  g += txt(lx, f.y(md[e]) + 4, `typical ${f0(md[e])} °C`, { size: 10.5, fill: C.ink, weight: 600 });
  g += txt(lx, f.y(cold[e]) + 4, `coldest ${f0(cold[e])} °C`, { size: 10, fill: C.ink2 });
  if (yMin < 0 && yMax > 0) g += txt(m.l + 6, f.y(0) - 4, "0 °C (freezing)", { size: 9.5, fill: "#3b6ea5" });
  g += txt(cx(0) + 4, f.y(md[0]) - 8, `${f0(md[0])} °C`, { size: 10.5, fill: C.ink, weight: 600 });
  return svg(W, H, g, "Daily average temperature across districts");
}

function chartProvinceRain(provinces) {
  const ps = provinces.slice().sort((a, b) => b.total - a.total);
  const W = 480, rowH = 27, m = { l: 160, r: 62, t: 6, b: 8 }, H = m.t + m.b + ps.length * rowH;
  const max = niceMax(Math.max(...ps.map((p) => p.total), 1)), pw = W - m.l - m.r;
  let g = "";
  ps.forEach((p, i) => {
    const y = m.t + i * rowH, w = Math.max(2, (p.total / max) * pw);
    g += txt(m.l - 8, y + 17, p.name.length > 24 ? `${p.name.slice(0, 23)}…` : p.name, { anchor: "end", size: 11, fill: C.ink });
    g += `<rect x="${m.l}" y="${y + 6}" width="${pw}" height="${rowH - 12}" rx="4" fill="${C.panel}"/>`;
    g += `<rect x="${m.l}" y="${y + 6}" width="${w.toFixed(1)}" height="${rowH - 12}" rx="4" fill="${C.rain}"/>`;
    g += txt(m.l + w + 6, y + 17, `${f0(p.total)} mm`, { size: 10.5, fill: C.ink, weight: 600 });
  });
  return svg(W, H, g, `Average ${NDAYS}-day rainfall per district, by province`);
}

function chartWettestByWeek(rows) {
  const top = rows.slice().sort((a, b) => b.total - a.total).slice(0, 12).filter((r) => r.total >= 1);
  if (!top.length) return `<p class="note">No district expects measurable rain in this outlook.</p>`;
  const W = 480, rowH = 24, m = { l: 128, r: 52, t: 30, b: 6 }, H = m.t + m.b + top.length * rowH;
  const max = niceMax(top[0].total), pw = W - m.l - m.r;
  let g = WEEKS.map((_, i) => `<rect x="${m.l - 120 + i * 70}" y="4" width="12" height="12" rx="2" fill="${C.weeks[i]}"/>` + txt(m.l - 120 + i * 70 + 16, 14, `Week ${i + 1}`, { size: 10 })).join("");
  top.forEach((r, i) => {
    const y = m.t + i * rowH;
    g += txt(m.l - 8, y + 15, r.name.length > 19 ? `${r.name.slice(0, 18)}…` : r.name, { anchor: "end", size: 11, fill: C.ink });
    let x = m.l;
    r.weekRain.forEach((v, k) => {
      const w = (v / max) * pw;
      if (w >= 1) g += `<rect x="${x.toFixed(1)}" y="${y + 4}" width="${Math.max(0.5, w - 2).toFixed(1)}" height="${rowH - 8}" rx="2" fill="${C.weeks[k]}"/>`;
      x += w;
    });
    g += txt(x + 5, y + 15, `${f0(r.total)} mm`, { size: 10.5, fill: C.ink, weight: 600 });
  });
  return svg(W, H, g, "Wettest districts: rain per week");
}

function chartProvinceTemp(provinces, scale) {
  const ps = provinces.slice().sort((a, b) => b.tMean - a.tMean);
  const W = 1000, rowH = 30, m = { l: 230, r: 30, t: 26, b: 10 }, H = m.t + m.b + ps.length * rowH;
  const lo = Math.floor(Math.min(...ps.map((p) => p.tCold)) / 5) * 5, hi = Math.ceil(Math.max(...ps.map((p) => p.tWarm)) / 5) * 5 + 10;
  const pw = W - m.l - m.r, x = (v) => m.l + ((v - lo) / Math.max(hi - lo, 1)) * pw;
  let g = "";
  for (let v = lo; v <= hi - 10; v += 5) g += `<line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="${m.t - 4}" y2="${H - m.b}" stroke="${v === 0 ? "#7aa7d8" : C.rule}"/>` + txt(x(v), m.t - 9, `${v} °C`, { anchor: "middle", size: 10, fill: C.muted });
  ps.forEach((p, i) => {
    const y = m.t + i * rowH + rowH / 2;
    g += txt(m.l - 12, y + 4, p.name, { anchor: "end", size: 11, fill: C.ink });
    g += `<line x1="${x(p.tCold).toFixed(1)}" x2="${Math.max(x(p.tWarm), x(p.tCold) + 1).toFixed(1)}" y1="${y}" y2="${y}" stroke="#c3ccd7" stroke-width="7" stroke-linecap="round"/>`;
    const col = classColor(p.tMean, scale) || C.temp;
    g += `<circle cx="${x(p.tMean).toFixed(1)}" cy="${y}" r="7.5" fill="${col}" stroke="#fff" stroke-width="2"/>`;
    g += txt(x(p.tWarm) + 12, y + 4, `${f1(p.tMean)} °C avg. · ${f0(p.tCold)} to ${f0(p.tWarm)} °C`, { size: 10, fill: C.ink2 });
  });
  return svg(W, H, g, "Temperature by province: coldest to warmest district");
}

function miniFrame(doc, W, H, m, title) {
  const n = doc.days, pw = W - m.l - m.r, ph = H - m.t - m.b, bw = pw / n;
  let g = `<rect x="${(m.l + doc.daily_skill_days * bw).toFixed(1)}" y="${m.t}" width="${((n - doc.daily_skill_days) * bw).toFixed(1)}" height="${ph}" fill="${C.ext}"/>`;
  g += txt(m.l, 12, title, { size: 10.5, fill: C.ink, weight: 600 });
  WEEKS.forEach(([a], i) => { g += txt(m.l + (a - 1 + 3.5) * bw, H - 6, `Week ${i + 1}`, { anchor: "middle", size: 9.5, fill: C.muted }); });
  return { g, bw, ph };
}

function miniRain(doc, p) {
  const W = 470, H = 124, m = { l: 32, r: 8, t: 20, b: 22 };
  const max = Math.max(2, niceMax(Math.max(...fin(p.dailyRain), 0.1)));
  const f = miniFrame(doc, W, H, m, "Average daily rain (mm)");
  const y = (v) => m.t + f.ph - (v / max) * f.ph;
  let g = f.g;
  [0, max].forEach((v) => { g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${C.rule}"/>` + txt(m.l - 4, y(v) + 4, f1(v), { anchor: "end", size: 9, fill: C.muted }); });
  p.dailyRain.forEach((v, d) => { if (v >= 0.05) g += `<rect x="${(m.l + d * f.bw + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(f.bw - 2).toFixed(1)}" height="${(y(0) - y(v)).toFixed(1)}" rx="1.5" fill="${C.rain}"/>`; });
  if (!p.dailyRain.some((v) => v >= 0.05)) g += txt(W / 2, m.t + f.ph / 2 + 4, "No rain expected", { anchor: "middle", size: 11, fill: C.muted });
  return svg(W, H, g, `${p.name}: average daily rain`);
}

function miniTemp(doc, p) {
  const W = 470, H = 124, m = { l: 32, r: 40, t: 20, b: 22 };
  const v = fin(p.dailyTemp), lo = Math.floor(Math.min(...v) - 1), hi = Math.ceil(Math.max(...v) + 1);
  const f = miniFrame(doc, W, H, m, "Average daily temperature (°C)");
  const y = (t) => m.t + f.ph - ((t - lo) / Math.max(hi - lo, 1)) * f.ph;
  let g = f.g;
  [lo, hi].forEach((t) => { g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${C.rule}"/>` + txt(m.l - 4, y(t) + 4, f0(t), { anchor: "end", size: 9, fill: C.muted }); });
  if (lo < 0 && hi > 0) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#7aa7d8"/>`;
  const cx = (d) => m.l + d * f.bw + f.bw / 2;
  g += `<path d="${p.dailyTemp.map((t, d) => `${d ? "L" : "M"}${cx(d).toFixed(1)},${y(t).toFixed(1)}`).join("")}" fill="none" stroke="${C.temp}" stroke-width="2.2" stroke-linejoin="round"/>`;
  const e = p.dailyTemp.length - 1;
  g += `<circle cx="${cx(0).toFixed(1)}" cy="${y(p.dailyTemp[0]).toFixed(1)}" r="3.5" fill="${C.temp}"/><circle cx="${cx(e).toFixed(1)}" cy="${y(p.dailyTemp[e]).toFixed(1)}" r="3.5" fill="${C.temp}"/>`;
  g += txt(cx(e) + 6, y(p.dailyTemp[e]) + 4, `${f0(p.dailyTemp[e])}°`, { size: 10, fill: C.ink, weight: 600 });
  return svg(W, H, g, `${p.name}: average daily temperature`);
}

// --------------------------------------------------------------- sections
function weekIcon(rain, temp, frostShare) {
  if (rain >= 5) return frostShare > 0.15 ? "rainsnow" : "rain";
  if (rain >= 2) return "cloudrain";
  if (rain >= 0.5) return "suncloud";
  if (temp != null && temp < 3) return "cold";
  return "sun";
}

function weekCards(doc, rows) {
  const cards = WEEKS.map((w, i) => {
    const rain = mean(rows.map((r) => r.weekRain[i])), temp = mean(rows.map((r) => r.weekTemp[i]));
    const wet = rows.filter((r) => r.weekRain[i] >= 10).length;
    const frost = rows.filter((r) => slice(r.t2mMin, w).some((v) => v != null && v < 0)).length / rows.length;
    const conf = CONF[i];
    return `<td class="wk">
      <div class="wk-h">Week ${i + 1}</div><div class="wk-d">${esc(weekRange(doc, i))}</div>
      <div class="wk-i">${icon(weekIcon(rain, temp, frost), 52)}</div>
      <div class="wk-v"><span class="rainc">${f1(rain)} mm</span> <span class="sub">avg. rain</span></div>
      <div class="wk-v"><span class="tempc">${f1(temp)} °C</span> <span class="sub">avg. temperature</span></div>
      <div class="wk-s">${wet ? `<b>${wet}</b> districts get 10 mm or more` : "No district gets 10 mm"}</div>
      <div class="conf" style="background:${conf.color}">Confidence: ${conf.label}</div><div class="sub">${conf.note}</div></td>`;
  }).join("");
  return `<table class="wks"><tr>${cards}</tr></table>`;
}

function heroTiles(rows) {
  const meaningful = rows.filter((r) => r.total >= 10).length;
  const wettest = rows.reduce((a, b) => (b.total > a.total ? b : a));
  const w1 = mean(rows.map((r) => r.weekTemp[0])), w5 = mean(rows.map((r) => r.weekTemp[4])), dt = w5 - w1;
  const coldest = rows.filter((r) => r.tMean != null).reduce((a, b) => (b.tMean < a.tMean ? b : a));
  const tile = (k, v, s, col) => `<td class="hero" style="border-top-color:${col}"><div class="hero-k">${k}</div><div class="hero-v">${v}</div><div class="hero-s">${s}</div></td>`;
  return `<table class="heros"><tr>
    ${tile("Districts with meaningful rain", `${meaningful}<small> of ${rows.length}</small>`, `10 mm or more over the ${NDAYS} days`, C.rain)}
    ${tile("Wettest district", esc(wettest.name), `${f0(wettest.total)} mm in ${NDAYS} days · ${esc(wettest.province)}`, C.rain)}
    ${tile("Temperature trend", `${arrow(dt)} ${dt >= 0 ? "+" : ""}${f1(dt)} °C`, `average from ${f1(w1)} °C (week 1) to ${f1(w5)} °C (week 5)`, C.temp)}
    ${tile("Coldest district", esc(coldest.name), `${f1(coldest.tMean)} °C average · ${esc(coldest.province)}`, "#3b7bc4")}
  </tr></table>`;
}

function whatToExpect(doc, rows, provinces) {
  const natWeek = WEEKS.map((_, i) => mean(rows.map((r) => r.weekRain[i])));
  const wetWeek = natWeek.indexOf(Math.max(...natWeek));
  const dry = rows.filter((r) => r.total < RAIN_DAY).length;
  const wetProv = provinces.slice().sort((a, b) => b.total - a.total);
  const dryProv = wetProv.filter((p) => p.total < 5).map((p) => p.name);
  const top = rows.slice().sort((a, b) => b.total - a.total).slice(0, 4);
  const w1 = mean(rows.map((r) => r.weekTemp[0])), w5 = mean(rows.map((r) => r.weekTemp[4]));
  const firstRainDay = Math.min(...rows.map((r) => r.firstRain).filter((d) => d > 0));
  const frost = rows.filter((r) => r.subZeroDays > 0);
  const frostProv = [...new Set(frost.map((r) => r.province))];
  const p1 = Number.isFinite(firstRainDay)
    ? `<b class="rainc">Rain.</b> ${firstRainDay > 3 ? `The first ${firstRainDay - 1} days look <b>dry almost everywhere</b>. The first real rain (at least ${RAIN_DAY} mm in a district) is expected around <b>${esc(dDate(doc, firstRainDay, { weekday: "long", day: "numeric", month: "long" }))}</b>.` : "Some districts can expect rain within the first few days."}
       The rainiest stretch is <b>week ${wetWeek + 1} (${esc(weekRange(doc, wetWeek))})</b>. Most rain falls in <b>${esc(wetProv.slice(0, 3).map((p) => p.name).join(", "))}</b>,
       with the highest totals in ${top.map((r) => `<b>${esc(r.name)}</b> (${f0(r.total)} mm)`).join(", ")}.
       ${dryProv.length ? `<b>${esc(dryProv.join(", "))}</b> stay${dryProv.length === 1 ? "s" : ""} mostly dry. ` : ""}Altogether <b>${dry} of ${rows.length}</b> districts are expected to get almost no rain.`
    : `<b class="rainc">Rain.</b> The whole country is expected to stay <b>dry</b> for the next five weeks.`;
  const p2 = `<b class="tempc">Temperature.</b> The average across districts goes from <b>${f1(w1)} °C</b> in week 1 to <b>${f1(w5)} °C</b> in week 5, ${trendWord(w5 - w1)}.
     ${frost.length ? `In <b>${frost.length} districts</b> (mainly ${esc(frostProv.slice(0, 3).join(", "))}) parts of the district stay <b>below freezing</b> on at least one day.` : "No district is expected to stay below freezing."}`;
  // Things to consider — only what the numbers support.
  const tips = [];
  if (frost.length) tips.push(["cold", `<b>Freezing conditions</b> in ${frost.length} districts: protect water pipes and livestock, expect ice on roads and passes, and use gas heaters only with ventilation.`]);
  const northWet = rows.filter((r) => /gilgit|khyber|kashmir/i.test(r.province) && r.modDays > 0);
  if (northWet.length) tips.push(["rainsnow", `<b>Rain or snow spells in the north</b> (${northWet.length} districts with at least one day of ${MODERATE} mm or more): mountain roads may become slippery or blocked; snow is likely where temperatures are near or below 0 °C.`]);
  const plainsDry = provinces.filter((p) => /punjab|sindh/i.test(p.name) && p.total < 5);
  const month = Number((doc.dates?.[0] || "").slice(5, 7));
  if (plainsDry.length) tips.push(["sun", `<b>Long dry spell over the plains</b> (${esc(plainsDry.map((p) => p.name).join(", "))}): plan irrigation for standing crops${month >= 10 || month <= 2 ? "; calm, dry winter air also favours fog and smog, so check the NCOP air-quality layers" : ""}.`]);
  if (rows.some((r) => r.heavyDays > 0)) tips.push(["rain", `<b>Heavy rain possible</b> in ${rows.filter((r) => r.heavyDays > 0).length} districts: watch for flash floods and landslides in hilly areas.`]);
  if (rows.some((r) => (r.tHi ?? 0) >= 30)) tips.push(["sun", `<b>Hot days</b> (daily average 30 °C or more) in ${rows.filter((r) => r.tHi >= 30).length} districts: drink water and avoid the midday sun.`]);
  tips.push(["suncloud", `This is a <b>planning outlook</b>, not a warning. For the days ahead always follow PMD forecasts and NDMA / PDMA advisories.`]);
  return `<div class="expect"><p>${p1}</p><p>${p2}</p></div>
    <h3>Things to consider</h3><table class="tips">${tips.map(([ic, t]) => `<tr><td class="ti">${icon(ic, 30)}</td><td>${t}</td></tr>`).join("")}</table>`;
}

function provinceSentence(doc, p) {
  const wk = p.weekRain.indexOf(Math.max(...p.weekRain));
  const firstRain = Math.min(...p.rows.map((r) => r.firstRain).filter((d) => d > 0));
  const rain = p.total < RAIN_DAY ? "<b class=\"rainc\">Rain:</b> expected to stay <b>dry</b> for the whole period."
    : `<b class="rainc">Rain:</b> ${Number.isFinite(firstRain) && firstRain > 3 ? `dry until about <b>${esc(dDate(doc, firstRain))}</b>, then ` : ""}${rainWords(p.total, 0).toLowerCase()}, mostly in <b>week ${wk + 1}</b> (${esc(weekRange(doc, wk))}). A district gets <b>${f0(p.total)} mm</b> on average over ${NDAYS} days; the wettest is <b>${esc(p.wettest.name)}</b> (${f0(p.wettest.total)} mm).`;
  const dt = p.weekTemp[4] - p.weekTemp[0];
  const temp = `<b class="tempc">Temperature:</b> ${tempWord(p.weekTemp[0]).toLowerCase()} at about ${f1(p.weekTemp[0])} °C in week 1, ${trendWord(dt)} to ${f1(p.weekTemp[4])} °C by week 5.${p.subZero ? ` <b>${p.subZero}</b> district${p.subZero > 1 ? "s have" : " has"} areas below freezing.` : ""}`;
  return `${rain}<br>${temp}`;
}

function districtTable(doc, p, pScale, tScale) {
  return `<table class="t dt"><thead><tr><th class="l" rowspan="2">District</th><th class="l" rowspan="2">Rain, in words</th><th colspan="5">Rain per week (mm)</th><th rowspan="2">${NDAYS} days (mm)</th><th rowspan="2">Wettest day</th>
    <th class="l" rowspan="2">Temperature, in words</th><th colspan="5">Average temperature per week (°C)</th><th rowspan="2">Coldest / warmest spot (°C)</th></tr>
    <tr>${WEEKS.map((_, i) => `<th>W${i + 1}</th>`).join("")}${WEEKS.map((_, i) => `<th>W${i + 1}</th>`).join("")}</tr></thead><tbody>
    ${p.rows.map((r) => `<tr><th class="l">${esc(r.name)}${r.division ? `<br><span class="sub">${esc(r.division)}</span>` : ""}</th>
      <td class="l words">${esc(rainWords(r.total, r.rainDays))}${r.rainDays ? `<br><span class="sub">${r.rainDays} rain day${r.rainDays > 1 ? "s" : ""}</span>` : ""}</td>
      ${r.weekRain.map((v) => cell(v / 7, pScale, v < 0.5 ? "–" : f1(v))).join("")}<td><b>${f0(r.total)}</b></td>
      <td>${r.wettestVal >= 0.5 ? `${esc(dDate(doc, r.wettestDay))}<br><span class="sub">${f1(r.wettestVal)} mm, ${dayRainWord(r.wettestVal)}</span>` : "–"}</td>
      <td class="l words">${esc(tempWord(r.tMean))}, ${esc(trendWord(r.tTrend))} ${arrow(r.tTrend)}</td>
      ${r.weekTemp.map((v) => cell(v, tScale, f1(v))).join("")}
      <td>${f0(r.coldSpot)} / ${f0(r.warmSpot)}</td></tr>`).join("")}
    </tbody></table>`;
}

function dailyMatrix(doc, provinces, key, scale, fmt) {
  const head = `<tr><th class="l">District</th>${Array.from({ length: doc.days }, (_, i) =>
    `<th class="m${i + 1 > doc.daily_skill_days ? " ext" : ""}">${i + 1}<br><span class="sub">${esc(dDate(doc, i + 1).split(" ")[0])}</span></th>`).join("")}</tr>`;
  return provinces.map((p) => `<h4>${esc(p.name)}</h4><table class="t mx"><thead>${head}</thead><tbody>
    ${p.rows.map((r) => `<tr><th class="l">${esc(r.name)}</th>${r[key].map((v) => cell(v, scale, fmt(v))).join("")}</tr>`).join("")}
  </tbody></table>`).join("");
}

function legendRow(scale, unit, skipFirst) {
  const items = scale.colors.map((c, i) => {
    if (!c && skipFirst) return "";
    const lo = i === 0 ? null : scale.bounds[i - 1], hi = scale.bounds[i];
    const lbl = lo == null ? `&lt; ${hi}` : hi == null ? `≥ ${lo}` : `${lo}–${hi}`;
    return `<td class="m" style="background:${c || "#fff"};color:${c ? textOn(c) : "#111"}">${lbl}</td>`;
  }).join("");
  return `<table class="t lg"><tr><th class="l">${esc(unit)}</th>${items}</tr></table>`;
}

const GLOSSARY = [
  ["mm of rain", "1 mm of rain = 1 litre of water on every square metre. 2.5 mm wets the ground; 15 mm or more in a day is a proper rainy day; 65 mm or more is heavy rain that can cause flooding."],
  ["Rain day", `A day on which the district average is at least ${RAIN_DAY} mm.`],
  ["Average (daily mean) temperature", "The average of the day and night temperatures. Afternoons are warmer and nights colder than this number, often by 5 to 10 °C."],
  ["Coldest / warmest spot", "The lowest / highest daily average found anywhere inside the district. Mountain districts can differ a lot from their valleys."],
  ["Ensemble mean", "The model is run 31 times with slightly different starting conditions; this report uses the average of all runs. Averages smooth out extremes, so a local downpour can be heavier than shown."],
  ["Confidence", "Weeks 1–2 are reliable for planning. Weeks 3–5 show whether it is likely to be wetter or drier, warmer or colder, not what happens on a specific day."],
];

const CSS = `
  @page { size: A4 landscape; margin: 11mm; }
  @page WordSection1 { size: 841.9pt 595.3pt; mso-page-orientation: landscape; margin: 30pt; }
  div.WordSection1 { page: WordSection1; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 9.5pt; color: ${C.ink}; margin: 0; line-height: 1.4; background: #fff; }
  .cover { background: ${C.navy}; color: #fff; padding: 14pt 18pt 12pt; }
  .cover .kicker { font-size: 8.5pt; letter-spacing: 1.5pt; text-transform: uppercase; color: #a9c8ea; }
  .cover h1 { font-size: 22pt; margin: 2pt 0; color: #fff; font-weight: 700; }
  .cover .meta { font-size: 9pt; color: #d6e4f3; }
  table.stripe { width: 100%; border-collapse: collapse; } table.stripe td { height: 5pt; padding: 0; font-size: 1pt; }
  h2 { font-size: 14pt; margin: 16pt 0 6pt; color: ${C.navy}; }
  h2 .num { background: ${C.navy}; color: #fff; padding: 0 6pt; margin-right: 6pt; }
  h3 { font-size: 11pt; margin: 10pt 0 4pt; color: ${C.navy2}; }
  h4 { font-size: 10pt; margin: 8pt 0 3pt; color: ${C.ink}; }
  .sub { color: ${C.muted}; font-size: 7.8pt; font-weight: normal; }
  .note { color: ${C.ink2}; font-size: 8.3pt; margin: 2pt 0 4pt; }
  .lead { font-size: 10pt; color: ${C.ink2}; margin: 0 0 6pt; }
  .rainc { color: ${C.rain}; font-weight: 700; } .tempc { color: ${C.temp}; font-weight: 700; }
  table.heros, table.wks, table.two { width: 100%; border-collapse: separate; border-spacing: 6pt 0; }
  table.heros { margin-top: 10pt; }
  td.hero { background: ${C.panel}; border-top: 3pt solid ${C.navy2}; padding: 7pt 9pt; vertical-align: top; width: 25%; }
  .hero-k { font-size: 8pt; text-transform: uppercase; letter-spacing: .6pt; color: ${C.ink2}; }
  .hero-v { font-size: 16pt; font-weight: 700; margin: 2pt 0 1pt; color: ${C.ink}; } .hero-v small { font-size: 10pt; color: ${C.muted}; font-weight: 400; }
  .hero-s { font-size: 8.3pt; color: ${C.ink2}; }
  td.wk { background: ${C.panel}; border: 1pt solid ${C.rule}; padding: 7pt 6pt; text-align: center; vertical-align: top; width: 20%; }
  .wk-h { font-weight: 700; font-size: 11pt; color: ${C.navy}; } .wk-d { font-size: 8pt; color: ${C.muted}; }
  .wk-i { margin: 4pt 0 2pt; } .wk-v { font-size: 10pt; } .wk-s { font-size: 8.3pt; color: ${C.ink2}; margin: 3pt 0 4pt; }
  .conf { display: inline-block; color: #fff; font-size: 8pt; font-weight: 700; padding: 1.5pt 7pt; border-radius: 8pt; }
  .expect { background: #f8fafd; border-left: 4pt solid ${C.navy2}; padding: 4pt 10pt; }
  .expect p { margin: 5pt 0; font-size: 10pt; }
  table.tips { width: 100%; border-collapse: collapse; }
  table.tips td { padding: 4pt 4pt; vertical-align: middle; font-size: 9.3pt; border-bottom: 1pt solid ${C.rule}; }
  table.tips td.ti { width: 34pt; text-align: center; }
  .card { border: 1pt solid ${C.rule}; padding: 7pt 9pt; margin: 6pt 0; background: #fff; }
  .card h3 { margin-top: 0; }
  table.two td { vertical-align: top; width: 50%; padding: 0; }
  .prov { background: ${C.navy}; color: #fff; padding: 5pt 10pt; margin: 14pt 0 0; font-size: 12pt; font-weight: 700; }
  .prov .sub { color: #bcd3ec; font-size: 9pt; }
  .provsum { background: ${C.panel}; padding: 6pt 10pt; font-size: 9.6pt; margin: 0 0 4pt; line-height: 1.55; }
  table.t { border-collapse: collapse; width: 100%; margin: 4pt 0; }
  table.t th, table.t td { border: 0.5pt solid ${C.rule}; padding: 2.5pt 3pt; text-align: center; vertical-align: middle; }
  table.t thead th { background: #e7eef7; color: ${C.navy}; font-weight: 600; font-size: 8pt; }
  table.t th.l, table.t td.l { text-align: left; }
  table.dt { font-size: 8pt; } td.words { font-size: 8pt; color: ${C.ink2}; }
  table.mx { font-size: 6.4pt; table-layout: fixed; } table.mx th.l { width: 92pt; }
  table.mx td.m, table.mx th.m { padding: 1pt 0; } table.mx th.ext { background: #f3e9d6; }
  table.lg { width: auto; font-size: 7.5pt; margin: 2pt 0; }
  table.gl td { text-align: left; vertical-align: top; font-size: 9pt; } table.gl td:first-child { font-weight: 700; width: 150pt; color: ${C.navy}; }
  .brk { page-break-before: always; }
  .keep, tr, .card, td.wk, td.hero { page-break-inside: avoid; }
  .foot { margin-top: 14pt; border-top: 1pt solid ${C.rule}; padding-top: 4pt; font-size: 8pt; color: ${C.muted}; }
`;

export function buildGefsOutlookHtml({ p, t, rows }) {
  const pScale = p.colorscale, tScale = t.colorscale;
  const provinces = provinceStats(rows, p.days);
  const init = p.init_time ? new Date(p.init_time) : null;
  const year = p.dates?.[p.days - 1]?.slice(0, 4) || "";
  const long = { weekday: "short", day: "numeric", month: "long" };
  const period = `${dDate(p, 1, long)} – ${dDate(p, p.days, long)} ${year}`;
  const issued = new Date().toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const sec = (n, title) => `<h2><span class="num">${n}</span> ${title}</h2>`;
  return `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">
  <title>NCOP 35-Day District Weather Outlook — ${esc(p.run)}</title><style>${CSS}</style></head>
  <body><div class="WordSection1">
  <div class="cover"><div class="kicker">National Common Operating Picture · Weather outlook</div>
    <h1>35-Day District Weather Outlook: Rain &amp; Temperature</h1>
    <div class="meta">Pakistan · all ${rows.length} districts · <b>${esc(period)}</b> · issued ${esc(issued)} · model run ${esc(init ? init.toUTCString().slice(5, 16) : p.run)}, 00 UTC</div></div>
  <table class="stripe"><tr><td style="background:${C.rain}">&nbsp;</td><td style="background:${C.temp}">&nbsp;</td></tr></table>
  ${heroTiles(rows)}

  ${sec(1, "The next five weeks at a glance")}
  <p class="lead">Each card shows the average across all districts. Confidence falls with time: plan firmly on weeks 1–2 and use weeks 3–5 as an early heads-up.</p>
  ${weekCards(p, rows)}

  ${sec(2, "What to expect")}
  ${whatToExpect(p, rows, provinces)}

  <div class="brk"></div>
  ${sec(3, "Rain outlook")}
  <div class="card keep"><h3>How many districts get rain each day?</h3>
    <p class="note">Each bar counts the districts expecting at least ${RAIN_DAY} mm that day (enough to wet the ground). Grey area = lower-confidence weeks.</p>
    ${chartRainyDistricts(p, rows)}</div>
  <table class="two keep"><tr>
    <td><div class="card"><h3>Which provinces get the most rain?</h3><p class="note">Average ${NDAYS}-day total for a district in each province.</p>${chartProvinceRain(provinces)}</div></td>
    <td><div class="card"><h3>Wettest districts, and when the rain falls</h3><p class="note">${NDAYS}-day total split by week (lighter = earlier).</p>${chartWettestByWeek(rows)}</div></td>
  </tr></table>

  ${sec(4, "Temperature outlook")}
  <div class="card keep"><h3>How warm or cold will it be?</h3>
    <p class="note">The thick line is the typical district; the shaded band covers 8 out of 10 districts; dashed lines are the warmest and the coldest district. Values are daily averages (day and night together).</p>
    ${chartTempBand(p, rows)}</div>
  <div class="card keep"><h3>Temperature by province</h3>
    <p class="note">The grey bar runs from the coldest to the warmest district (${NDAYS}-day average); the dot is the province average, coloured as on the map.</p>
    ${chartProvinceTemp(provinces, tScale)}</div>

  <div class="brk"></div>
  ${sec(5, "Province by province")}
  <p class="lead">For each district: the outlook in words, then the numbers. Coloured cells use the same colours as the NCOP map layers
    (weekly rain cells are coloured by the average daily amount in that week).</p>
  ${legendRow(pScale, "Rain mm/day", true)}${legendRow(tScale, "Temp. °C", false)}
  ${provinces.map((pv) => `<div class="keep"><div class="prov">${esc(pv.name)} <span class="sub">· ${pv.n} district${pv.n > 1 ? "s" : ""}</span></div>
    <div class="provsum">${provinceSentence(p, pv)}</div>
    <table class="two"><tr><td>${miniRain(p, pv)}</td><td>${miniTemp(p, pv)}</td></tr></table></div>
    ${districtTable(p, pv, pScale, tScale)}`).join("")}

  <div class="brk"></div>
  ${sec("A", "Annex: daily rain for every district (mm)")}
  <p class="note">Blank = less than 0.5 mm. Shaded day numbers = lower-confidence days (${p.daily_skill_days + 1} onwards).</p>${legendRow(pScale, "mm/day", true)}
  ${dailyMatrix(p, provinces, "precip", pScale, (v) => (v == null || v < 0.5 ? "" : v < 10 ? v.toFixed(1) : f0(v)))}

  <div class="brk"></div>
  ${sec("B", "Annex: daily average temperature for every district (°C)")}
  ${legendRow(tScale, "°C", false)}
  ${dailyMatrix(p, provinces, "t2m", tScale, (v) => f0(v))}

  <div class="brk"></div>
  ${sec("C", "Words used in this report")}
  <table class="t gl">${GLOSSARY.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
  ${sec("D", "How this outlook is made")}
  <ul>
    <li><b>Source:</b> NOAA Global Ensemble Forecast System (GEFS v12), average of 31 runs, model run ${esc(p.run)} (00 UTC). Days 1–${p.hr_days} use the 0.25° (~27 km) grid, days ${p.hr_days + 1}–${p.days} the 0.5° (~55 km) grid.</li>
    <li><b>Rain</b> is the total for each day (UTC). <b>Temperature</b> is the daily average 2 m air temperature (average of four 6-hourly values).</li>
    <li><b>District values</b> are averages over each district's area: ${esc(p.method || "area-weighted mean over the district polygon")}.</li>
    <li><b>Rain words</b> follow the daily scale used by IMD and PMD: drizzle under ${RAIN_DAY} mm, light ${RAIN_DAY}–15.5 mm, moderate ${MODERATE}–64.4 mm, heavy ${HEAVY} mm or more.</li>
    <li><b>Limitations:</b> forecast skill drops after about two weeks; averages hide local extremes; mountain valleys and peaks inside one district can differ strongly. Use with PMD forecasts and NDMA / PDMA advisories.</li>
    <li><b>Data:</b> ${esc(p.attribution || "NOAA GEFS")}. District boundaries: NCOP district boundary layer.</li>
  </ul>
  <div class="foot">NCOP · National Common Operating Picture · 35-Day District Weather Outlook · run ${esc(p.run)} · generated automatically from NOAA GEFS data.</div>
  </div></body></html>`;
}

export function buildGefsOutlookCsv({ p, rows }) {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = ["province,division,district,day,date,extended_range,precip_mm,precip_max_cell_mm,t2m_mean_c,t2m_min_cell_c,t2m_max_cell_c"];
  rows.slice().sort((a, b) => a.province.localeCompare(b.province) || a.name.localeCompare(b.name)).forEach((r) => {
    for (let d = 1; d <= p.days; d++) {
      const v = (a) => (a[d - 1] == null ? "" : a[d - 1]);
      lines.push([q(r.province), q(r.division), q(r.name), d, p.dates?.[d - 1] || "", d > p.daily_skill_days ? 1 : 0,
        v(r.precip), v(r.precipMax), v(r.t2m), v(r.t2mMin), v(r.t2mMax)].join(","));
    }
  });
  return lines.join("\r\n");
}

// ----------------------------------------------------- Word (MHTML) packing
function svgToPng(svgText, scale = 2) {
  return new Promise((resolve, reject) => {
    const w = Number(/width="([\d.]+)"/.exec(svgText)?.[1] || 600), h = Number(/height="([\d.]+)"/.exec(svgText)?.[1] || 300);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve({ w, h, b64: c.toDataURL("image/png").split(",")[1] });
    };
    img.onerror = () => reject(new Error("chart rasterisation failed"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  });
}

function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap76 = (b64) => b64.replace(/.{76}/g, "$&\r\n");

// Charts → PNG parts; the HTML references them by Content-Location. Word
// opens this single-file web archive (.doc) with the pictures embedded.
export async function buildWordMhtml(html) {
  const uniq = [...new Set(html.match(/<svg[\s\S]*?<\/svg>/g) || [])];
  const pngs = new Map();
  for (let i = 0; i < uniq.length; i += 8) {              // bounded concurrency
    const part = await Promise.all(uniq.slice(i, i + 8).map((s) => svgToPng(s)));
    part.forEach((r, k) => pngs.set(uniq[i + k], { ...r, loc: `file:///C:/ncop-outlook/img${String(i + k + 1).padStart(3, "0")}.png` }));
  }
  const body = html.replace(/<svg[\s\S]*?<\/svg>/g, (s) => {
    const r = pngs.get(s);
    return `<img src="${r.loc}" width="${Math.round(r.w)}" height="${Math.round(r.h)}" alt="">`;
  });
  const B = "----=_NCOP_OUTLOOK_PART";
  let out = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${B}"; type="text/html"\r\n\r\n`;
  out += `--${B}\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\nContent-Location: file:///C:/ncop-outlook/report.htm\r\n\r\n${wrap76(b64utf8(body))}\r\n`;
  for (const r of pngs.values()) out += `--${B}\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${r.loc}\r\n\r\n${wrap76(r.b64)}\r\n`;
  return `${out}--${B}--\r\n`;
}

function download(content, type, filename, bom = true) {
  const url = URL.createObjectURL(new Blob([bom ? "\ufeff" + content : content], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener"; a.style.display = "none";
  document.body.appendChild(a);
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
}

function printHtml(html, win) {
  if (win && !win.closed) {
    win.document.open(); win.document.write(html); win.document.close();
    const go = () => { try { win.focus(); win.print(); } catch { /* closed */ } };
    if (win.document.readyState === "complete") setTimeout(go, 250); else win.addEventListener("load", () => setTimeout(go, 250), { once: true });
    return;
  }
  // Popup blocked → hidden iframe.
  const frame = document.createElement("iframe");
  Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "-10000px", width: "0", height: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { /* ignore */ } setTimeout(() => frame.remove(), 1500); }, 400);
}

/** Export the full 35-day outlook. format: "word" | "pdf" | "csv". */
export async function exportGefsOutlook(format) {
  // Open the print window inside the click's user activation, before any await.
  let win = null;
  if (format === "pdf") {
    win = window.open("", "_blank", "width=1150,height=820");
    if (win) win.document.write(`<p style="font:14px Segoe UI,Arial;padding:24px">Preparing the 35-day district outlook…</p>`);
  }
  try {
    const data = await loadBoth();
    const name = `ncop-35day-district-outlook-${data.p.run}`;
    if (format === "csv") download(buildGefsOutlookCsv(data), "text/csv;charset=utf-8", `${name}.csv`);
    else if (format === "word") download(await buildWordMhtml(buildGefsOutlookHtml(data)), "application/msword", `${name}.doc`, false);
    else printHtml(buildGefsOutlookHtml(data), win);
  } catch (e) {
    if (win && !win.closed) win.close();
    throw e;
  }
}
