// story-air-quality-report.js
// --------------------------------------------------------------------------
// AQI-first report for the National Air Quality Watch (sections for
// story-report-export.js). Pure: digest in, sections out. No AQI arithmetic
// here: every index comes from the backend (project/ncop_internal/
// aqi_engine.py, aqi_watch.py); this file only words and draws them.
//
// Order of every page: how bad is it (AQI, category) -> what is behind it
// (pollutant, concentration, weather, sources) -> what to do.
// Observed, current (NowCast), forecast and modelled values are never mixed
// in one ranking, and concentrations keep their own unit and averaging time.
// --------------------------------------------------------------------------

const WHO_24H = 15, NEQS_24H = 35;
const PAST_HOTSPOTS = 5, FORECAST_FOCUS = 4;
const METROS = ["Lahore", "Karachi", "Islamabad", "Rawalpindi", "Faisalabad", "Multan", "Peshawar", "Quetta",
  "Gujranwala", "Hyderabad", "Sialkot", "Bahawalpur"];
const POLLUTANTS = [["pm25", "PM2.5"], ["pm10", "PM10"], ["o3", "Ozone (O₃)"], ["no2", "NO₂"], ["so2", "SO₂"], ["co", "CO"]];
const POL_NAME = Object.fromEntries(POLLUTANTS);

// Numbered references; cite("x") -> "[n]". An entry says so where the original
// document was not available and a secondary source was used.
const REFS = [
  ["tad", "US EPA (May 2026). Technical Assistance Document for the Reporting of Daily Air Quality: the Air Quality Index. EPA-403/B-26-003. Method, rounding, NowCast, health statements. document.airnow.gov"],
  ["cfr58", "40 CFR Part 58, Appendix G: Uniform Air Quality Index. 89 FR 16403, 6 March 2024. Breakpoints. law.cornell.edu/cfr/text/40/appendix-G_to_part_58"],
  ["cfr50", "40 CFR Part 50, Appendix N, section on 24-hour averages: valid with at least 75% of hours (18 hourly values). law.cornell.edu/cfr/text/40/appendix-N_to_part_50"],
  ["punjab", "EPA Punjab (1 October 2025). Order No. 355/PA to DG/EPA/2025: calculation and dissemination of the AQI from 8-hourly averages, in force 3 October 2025. epd.punjab.gov.pk"],
  ["neqs", "Government of Pakistan. S.R.O. 1062(I)/2010, National Environmental Quality Standards for Ambient Air. Gazette of Pakistan Extraordinary, 26 November 2010, pp. 3205–3206: PM2.5 24-hour 35 µg/m³ and annual 15 µg/m³ from 1 January 2013; 24-hour values to be met 98% of the year, not exceeded on two consecutive days."],
  ["who", "World Health Organization (2021). WHO global air quality guidelines. ISBN 978-92-4-003422-8. PM2.5 24-hour guideline 15 µg/m³."],
  ["paqidata", "Pakistan Air Quality Initiative (PAQI), Hawanama. Station readings, station daily means, daily PM2.5 estimate and gridded PM2.5 forecast (beta). hawanama.org, CC BY 4.0."],
  ["cams", "Copernicus Atmosphere Monitoring Service global atmospheric composition forecasts, 45 km, via the Open-Meteo Air Quality API. open-meteo.com/en/docs/air-quality-api, CC BY 4.0."],
  ["kang", "Kang, D., Mathur, R., Trivikrama Rao, S. (2010). Assessment of bias-adjusted PM2.5 air quality forecasts over the continental United States during 2007. Geoscientific Model Development 3, 309–320. doi:10.5194/gmd-3-309-2010. Precedent for adjusting a model with recent station data; this report's own formula is simpler and was tested separately."],
  ["barkjohn", "Barkjohn, K. K., Gantt, B., Clements, A. L. (2021). Development and application of a United States-wide correction for PM2.5 data collected with the PurpleAir sensor. Atmospheric Measurement Techniques 14, 4617–4637. doi:10.5194/amt-14-4617-2021. Uncorrected sensors read about 40% high in the US; humidity is a main factor. Not a Pakistani study."],
  ["urban", "Urban Unit, Lahore emissions inventory (2023, 2020–21 data), as reported by Gabol, I., Dawn, 5 November 2026 (dawn.com/news/2042329). The inventory itself was not available to check."],
  ["paqi25", "PAQI (27 November 2025). Unveiling Pakistan's Air Pollution: A National Landscape Report on Health Risks, Sources and Solutions. doi:10.5281/zenodo.17629179."],
  ["dawn25", "Gabol, I. (10 December 2025). Transport sector emerges as key cause of air pollution. Dawn (dawn.com/news/1960268): Punjab EPA's rejection of the PAQI findings."],
  ["majeed", "Majeed, R., Anjum, M. S., Imad-ud-din, M., Malik, S., Anwar, M. N., Anwar, B., Khokhar, M. F. (2024). Solving the mysteries of Lahore smog: the fifth season in the country. Frontiers in Sustainable Cities 5, 1314426. doi:10.3389/frsc.2023.1314426 (abstract and introduction read)."],
  ["met", "Open-Meteo weather forecast API: 10 m wind, boundary-layer height and rain, hourly, averaged over the named cities. open-meteo.com, CC BY 4.0."],
  ["viirs", "NASA VIIRS active-fire detections, crop-fire season counts as published by Hawanama."],
  ["waqi", "World Air Quality Index project (WAQI), live station AQI as published by WAQI. waqi.info"],
];
const cite = (...keys) => `[${keys.map((k) => REFS.findIndex((r) => r[0] === k) + 1).join(", ")}]`;

// ---- formatting ------------------------------------------------------------
const _x = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const _int = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-GB") : "n/a");
const _pm = (v) => (Number.isFinite(v) ? `${Math.round(v)} µg/m³` : "n/a");
export const aqiText = (v) => (!Number.isFinite(v) ? "n/a" : v > 500 ? "500+" : String(Math.round(v)));
const _pc = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
function _date(iso, opt = { weekday: "short", day: "numeric", month: "short" }) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso || "n/a") : d.toLocaleDateString("en-GB", { ...opt, timeZone: "UTC" });
}
const _short = (iso) => _date(iso, { day: "numeric", month: "short" });
function _pkt(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "n/a" : `${d.toLocaleString("en-GB", { timeZone: "Asia/Karachi", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })} PKT`;
}
const _join = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const _cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const _plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Category helpers bound to the digest's own standard. */
export function aqiScale(std) {
  const cats = std?.categories || [];
  const of = (v) => (Number.isFinite(v) ? cats.find((c) => c.hi == null || v <= c.hi) || cats[cats.length - 1] : null);
  return {
    cats, of,
    label: (v) => of(v)?.label || "No data",
    color: (v) => of(v)?.color || "#9ca3af",
    cell: (v) => (Number.isFinite(v) ? { t: `${aqiText(v)} ${of(v).label}`, bg: of(v).color } : "Insufficient data"),
    advice: (v) => { const c = of(v); return c ? [c.advice_sensitive, c.advice_everyone].filter(Boolean).join(" ") : ""; },
    atLeast: (counts, key) => { const i = cats.findIndex((c) => c.key === key); return cats.slice(i).reduce((s, c) => s + (counts?.[c.key] || 0), 0); },
    total: (counts) => cats.reduce((s, c) => s + (counts?.[c.key] || 0), 0),
  };
}

// ---- charts (light, drawn once as SVG) ---------------------------------------
const W = 640, PL = 46, PR = 128;
function _bands(S, ymax, y) {
  const out = [];
  for (const c of S.cats) {
    const lo = Math.max(0, c.lo === 0 ? 0 : c.lo - 1), hi = Math.min(c.hi ?? ymax, ymax);
    if (lo >= ymax) break;
    out.push(`<rect x="${PL}" y="${y(hi)}" width="${W - PL - PR}" height="${y(lo) - y(hi)}" fill="${c.color}" opacity="0.2"/>`);
    if (y(lo) - y(hi) >= 11) out.push(`<text x="${W - PR + 32}" y="${(y(lo) + y(hi)) / 2 + 3}" font-size="9" fill="#374151">${_x(c.label === "Unhealthy for Sensitive Groups" ? "Unhealthy (sensitive)" : c.label)}</text>`);
    if (c.lo > 0) out.push(`<text x="${PL - 6}" y="${y(lo) + 3}" font-size="9" fill="#6b7280" text-anchor="end">${c.lo - 1}</text>`);
  }
  return out.join("");
}
/** AQI columns over category bands; `lo`/`hi` draw a range whisker. */
function aqiColumns(S, rows, { title, h = 210 } = {}) {
  const top = 16, base = top + h;
  const peak = Math.max(150, ...rows.flatMap((r) => [r.v, r.hi]).filter(Number.isFinite));
  const ymax = Math.min(520, Math.max(200, Math.ceil((peak * 1.06) / 50) * 50));
  const y = (v) => base - (Math.min(v, ymax) / ymax) * h;
  const cw = (W - PL - PR) / Math.max(rows.length, 1);
  const out = [`<rect x="0" y="0" width="${W}" height="${base + 34}" fill="#ffffff"/>`, _bands(S, ymax, y),
    `<line x1="${PL}" x2="${W - PR}" y1="${base}" y2="${base}" stroke="#111827"/><text x="${PL - 6}" y="${top - 5}" font-size="9" font-weight="700" fill="#374151" text-anchor="end">AQI</text>`];
  rows.forEach((r, i) => {
    const cx = PL + i * cw + cw / 2, w = Math.min(46, cw * 0.56);
    out.push(`<text x="${cx}" y="${base + 14}" font-size="10" font-weight="600" fill="#111827" text-anchor="middle">${_x(r.label)}</text>`);
    if (r.sub) out.push(`<text x="${cx}" y="${base + 27}" font-size="9" fill="#6b7280" text-anchor="middle">${_x(r.sub)}</text>`);
    if (!Number.isFinite(r.v)) { out.push(`<text x="${cx}" y="${base - 6}" font-size="9" fill="#6b7280" text-anchor="middle">no data</text>`); return; }
    const t = y(r.v);
    out.push(`<rect x="${cx - w / 2}" y="${t}" width="${w}" height="${Math.max(1.5, base - t)}" rx="2" fill="${S.color(r.v)}" stroke="#111827" stroke-width="0.8"/>`);
    let ly = t - 5;
    if (Number.isFinite(r.hi) && r.hi > r.v) {
      const hy = y(r.hi), by = Number.isFinite(r.lo) ? y(r.lo) : t;
      out.push(`<line x1="${cx}" x2="${cx}" y1="${by}" y2="${hy}" stroke="#111827" stroke-width="1.3"/><line x1="${cx - 6}" x2="${cx + 6}" y1="${hy}" y2="${hy}" stroke="#111827" stroke-width="1.3"/>`);
      if (Number.isFinite(r.lo)) out.push(`<line x1="${cx - 6}" x2="${cx + 6}" y1="${by}" y2="${by}" stroke="#111827" stroke-width="1.3"/>`);
      ly = Math.max(top + 8, Math.min(hy - 4, t - 5));
    }
    out.push(Number.isFinite(r.hi)
      ? `<text x="${cx + w / 2 + 3}" y="${t + 4}" font-size="11" font-weight="800" fill="#111827">${aqiText(r.v)}</text>`
      : `<text x="${cx}" y="${ly}" font-size="11.5" font-weight="800" fill="#111827" text-anchor="middle">${aqiText(r.v)}</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${base + 34}" role="img" aria-label="${_x(title || "AQI")}">${out.join("")}</svg>`;
}
/** One stacked column per day: share of stations (or cities) in each category. */
function categoryStacks(S, rows, { title, h = 150, unit = "stations" } = {}) {
  const top = 18, base = top + h;
  const cw = (W - PL - PR) / Math.max(rows.length, 1);
  const out = [`<rect x="0" y="0" width="${W}" height="${base + 34}" fill="#ffffff"/>`,
    `<line x1="${PL}" x2="${W - PR}" y1="${base}" y2="${base}" stroke="#111827"/>`];
  rows.forEach((r, i) => {
    const tot = S.total(r.counts), cx = PL + i * cw + cw / 2, w = Math.min(58, cw * 0.68);
    let acc = 0;
    if (tot) for (const c of S.cats) {
      const n = r.counts[c.key] || 0;
      if (!n) continue;
      const bh = (n / tot) * h, yy = base - acc - bh;
      const [R, G, B] = [1, 3, 5].map((k) => parseInt(c.color.slice(k, k + 2), 16));
      out.push(`<rect x="${cx - w / 2}" y="${yy}" width="${w}" height="${bh}" fill="${c.color}" stroke="#111827" stroke-width="0.6"/>`);
      if (bh >= 11) out.push(`<text x="${cx}" y="${yy + bh / 2 + 3.5}" font-size="9.5" font-weight="700" fill="${0.2126 * R + 0.7152 * G + 0.0722 * B > 140 ? "#111827" : "#ffffff"}" text-anchor="middle">${n}</text>`);
      acc += bh;
    }
    out.push(`<text x="${cx}" y="${top - 6}" font-size="8.5" fill="#6b7280" text-anchor="middle">${tot} ${_x(unit)}</text>
      <text x="${cx}" y="${base + 14}" font-size="10" font-weight="600" fill="#111827" text-anchor="middle">${_x(r.label)}</text>
      <text x="${cx}" y="${base + 27}" font-size="9" fill="#6b7280" text-anchor="middle">${_x(r.sub || "")}</text>`);
  });
  [...S.cats].reverse().forEach((c, i) => out.push(`<rect x="${W - PR + 6}" y="${top + i * 18}" width="11" height="11" fill="${c.color}" stroke="#111827" stroke-width="0.6"/><text x="${W - PR + 22}" y="${top + i * 18 + 9.5}" font-size="9" fill="#111827">${_x(c.label === "Unhealthy for Sensitive Groups" ? "Unhealthy (sensitive)" : c.label)}</text>`));
  return `<svg viewBox="0 0 ${W} ${base + 34}" role="img" aria-label="${_x(title || "Categories")}">${out.join("")}</svg>`;
}
const _chart = (svg, title, legend) => ({ chart: { svg, title, legend, bg: "#ffffff" } });

// ---- shared facts ------------------------------------------------------------
const _isMetro = (n) => METROS.some((m) => m.toLowerCase() === String(n || "").toLowerCase());
/** Cities reliable enough to rank: two or more valid stations, or a metro. */
export function rankedCities(aqi) {
  return (aqi?.observed?.cities || []).filter((c) => c.n_stations >= 2 || _isMetro(c.city));
}
const TREND_TXT = { worsening: "getting worse", improving: "improving", stable: "broadly steady", "insufficient data": "not enough data for a trend" };
const TREND_ICON = { worsening: "▲ Worsening", improving: "▼ Improving", stable: "■ Steady", "insufficient data": "Insufficient data" };

/** Plain-language lines shared by the report's page 1 and the briefing. */
export function aqiHeadline(d) {
  const a = d?.aqi;
  if (!a) return null;
  const S = aqiScale(a.standard);
  const o = a.observed, days = o.days, last = days[days.length - 1], first = days[0];
  const worst = days.reduce((x, y) => (y.median_aqi > x.median_aqi ? y : x));
  const now = a.now?.n_valid ? a.now : null;
  const ref = now ? { aqi: now.median_aqi, counts: now.category_counts, n: now.n_valid } : { aqi: last.median_aqi, counts: last.category_counts, n: last.n_valid };
  const bad = S.atLeast(ref.counts, "unhealthy"), vbad = S.atLeast(ref.counts, "very_unhealthy");
  const when = now ? `Right now (${_pkt(now.data_time)})` : `On ${_date(last.date)}`;
  const fc = a.forecast;
  const tom = fc?.days?.find((x) => x.date === fc.targets[1]);
  const fWorst = fc?.days?.length ? fc.days.reduce((x, y) => (y.median_aqi > x.median_aqi ? y : x)) : null;
  const weekLine = `Over the week the middle station's daily AQI went from ${first.median_aqi} (${S.label(first.median_aqi)}) to ${last.median_aqi} (${S.label(last.median_aqi)}), ${TREND_TXT[o.trend]}; the worst day was ${_date(worst.date)} at ${worst.median_aqi}.`;
  const nowLine = `${when}, ${bad} of ${ref.n} stations with valid data are Unhealthy or worse, and ${vbad} are Very Unhealthy or Hazardous. The middle station reads AQI ${aqiText(ref.aqi)}, ${S.label(ref.aqi)}.`;
  const fcLine = tom
    ? `Tomorrow (${_date(tom.date)}), ${S.atLeast(tom.category_counts, "unhealthy")} of ${tom.n_cities} forecast cities are expected to be Unhealthy or worse${fWorst && fWorst.date !== tom.date && fWorst.median_aqi > tom.median_aqi ? `; ${_date(fWorst.date)} looks worse still` : ""}.`
    : "The AQI forecast could not be made for this issue.";
  return { S, o, days, first, last, worst, now, ref, bad, vbad, when, fc, tom, fWorst, weekLine, nowLine, fcLine };
}

function _confidenceLine(c) {
  return `Data confidence: ${_cap(c.confidence)} (${_plural(c.last_n, "station")} on the latest day, ${c.days_valid} of ${c.n_days} days valid).`;
}

// ---- report ------------------------------------------------------------------
export function airQualityReportMeta(d) {
  const a = d?.aqi, o = a?.observed;
  return {
    title: "National Air Quality Watch",
    subtitle: "AQI and Health Outlook: the past week, right now, and the next days",
    strip: [
      { label: "Issued", value: new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
      { label: "Past week (observed)", value: o?.dates?.length ? `${_date(o.dates[0])} to ${_date(o.dates[o.dates.length - 1])}` : "n/a" },
      { label: "Outlook (forecast)", value: a?.forecast?.targets ? `${_date(a.forecast.targets[0])} to ${_date(a.forecast.targets[a.forecast.targets.length - 1])}` : "n/a" },
      { label: "Reference", value: `NDMA/NCOP/AQW/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${a?.snapshot_id ? ` · ${a.snapshot_id}` : ""}` },
    ],
    howToRead: "AQI says how unhealthy the air is; concentrations (µg/m³) are the evidence behind it. OBSERVED = ground stations. FORECAST and MODELLED = computer models. They are never mixed in one ranking. Terms are explained at the end.",
    glossary: [
      { term: "AQI", def: "Air Quality Index: one number, 0 to 500, that says how unhealthy the air is. Higher is worse. This report uses the US EPA index." },
      { term: "Sub-index", def: "The index worked out for one pollutant. The overall AQI is the highest sub-index, never the average." },
      { term: "PM2.5 sub-index", def: "The AQI for fine particles only. It is what Pakistan's available stations can support, because PM2.5 is the only pollutant they report." },
      { term: "Dominant pollutant", def: "The pollutant with the highest sub-index." },
      { term: "Daily (24-hour) AQI", def: "Worked out from a full day's average. At least 18 of the 24 hours must be valid." },
      { term: "NowCast (current AQI)", def: "US EPA's method for the latest hours. It weights recent hours more when the air is changing fast. It is not the same as a daily AQI." },
      { term: "Forecast AQI", def: "A 24-hour AQI expected for a coming day, from a model adjusted with the city's own stations." },
      { term: "Middle (median) station", def: "Half the stations read higher and half read lower. One faulty sensor cannot move it much." },
      { term: "90th percentile", def: "The level that only the worst 10% of stations exceed." },
      { term: "PM2.5 / PM10", def: "Particles smaller than 2.5 and 10 micrometres. PM2.5 reaches deep into the lungs." },
      { term: "O₃, NO₂, SO₂, CO", def: "Ozone near the ground, nitrogen dioxide, sulphur dioxide and carbon monoxide: gases that also have an AQI." },
      { term: "µg/m³, ppb, ppm", def: "Concentration units: millionths of a gram per cubic metre; parts per billion; parts per million." },
      { term: "Mixing height", def: "How high the air can mix and dilute pollution. A low mixing height traps it near the ground." },
      { term: "Temperature inversion", def: "Warmer air sitting on cooler air like a lid, common on winter nights." },
      { term: "Grid cell", def: "One square of a model map. It is an estimate for the square, not a station reading." },
      { term: "CAMS", def: "Copernicus Atmosphere Monitoring Service: the European global model of air pollution." },
      { term: "Middle city", def: "The middle value when every city counts once, however many stations it has." },
      { term: "WHO guideline, Pak-NEQS", def: "Health guideline and national limit for PM2.5 (15 and 35 µg/m³ over 24 hours). They are limits on concentration, not AQI values." },
    ],
    footer: "Sources: station data, PM2.5 estimate and PM2.5 forecast map: Pakistan Air Quality Initiative (Hawanama), CC BY 4.0. Modelled pollutants: Copernicus CAMS via Open-Meteo, CC BY 4.0. Live reference AQI: World Air Quality Index project (WAQI). Weather: Open-Meteo. Fires: NASA VIIRS via Hawanama. AQI method: US EPA.",
  };
}

/**
 * d        digest (/api/hawanama/watch/)
 * shots    {1: [{src, caption}], 2: [...]} the story's own map captures
 * waqiNear (lon, lat) -> [{name, aqi, km, time}]
 * null when the digest has no AQI block (the caller falls back).
 */
export function airQualityReportSections(d, { shots = {}, waqiNear = () => [] } = {}) {
  const H = aqiHeadline(d);
  if (!H) return null;
  const { S, o, days, last, worst, now, ref, fc, tom } = H;
  const a = d.aqi, std = a.standard;
  const out = [];
  const ranked = rankedCities(a);
  const top = ranked[0];
  const nowBy = new Map((now?.cities || []).map((c) => [c.city, c]));
  const fcBy = new Map((fc?.cities || []).map((c) => [c.city, c]));
  const pending = std.advice_approved ? "" : " (US EPA wording, awaiting approval for Pakistan)";
  const stdNote = std.approved ? `${std.name}` : `${std.name}, used as a reference: not yet adopted for Pakistan`;

  // ---------------------------------------------------------------- page 1
  const affected = (now?.cities || []).filter((c) => c.n >= 2 && c.aqi > 200).map((c) => c.city);
  out.push({ glance: {
    heading: "The national air quality situation",
    banner: { value: aqiText(ref.aqi), label: S.label(ref.aqi), color: S.color(ref.aqi),
      title: `Unhealthy or worse at ${H.bad} of ${ref.n} monitoring stations`,
      text: `${S.of(ref.aqi)?.meaning || ""} The number is the middle station ${now ? `over the last hours, to ${_pkt(now.data_time)} (observed, NowCast)` : `on ${_date(last.date)} (observed, 24-hour)`}, for fine particles (PM2.5). Counting each of ${now ? now.n_cities : last.n_cities} cities once, the middle city reads ${aqiText(now ? now.median_city_aqi : last.median_city_aqi)}. Stations cluster in cities, so neither is a population average.` },
    level: { label: S.label(ref.aqi), color: S.color(ref.aqi), steps: S.cats.map((c) => ({ label: `${c.label} ${c.hi == null ? `${c.lo}+` : `${c.lo}–${c.hi}`}`, color: c.color, on: c === S.of(ref.aqi) })) },
    levelLabel: "Where the middle station stands now",
    levelNote: `Scale: ${stdNote}.`,
    kpis: [
      { value: `${H.vbad} of ${ref.n}`, label: "stations Very Unhealthy or Hazardous" },
      { value: top ? `${top.city} ${aqiText(top.median_aqi)}` : "n/a", label: "worst city of the week (middle daily AQI)" },
      { value: "PM2.5", label: "dominant pollutant (only one measured)" },
      { value: TREND_ICON[o.trend], label: `this week: ${days[0].median_aqi} to ${last.median_aqi} (middle station)` },
      { value: `${worst.median_aqi} · ${_short(worst.date)}`, label: "worst day of the week (middle station)" },
      { value: tom ? `${aqiText(tom.median_aqi)} ${S.label(tom.median_aqi)}` : "n/a", label: "forecast for tomorrow, middle city" },
    ],
    advice: { tag: "WHAT TO DO", text: `${S.advice(ref.aqi)}${pending}. Applies ${affected.length ? `first to ${_join(affected.slice(0, 4))}${affected.length > 4 ? ` and ${affected.length - 4} more cities` : ""}` : "where stations show this category"}, from now until the next issue of this report.` },
    howToRead: false, // placed at the start of chapter 1, so page 1 stays one page
    chapters: [
      { n: 1, name: "The Past Week and Now", text: H.weekLine },
      { n: 2, name: "The Outlook", text: H.fcLine },
    ],
  } });

  // ---------------------------------------------------------------- chapter 1
  out.push({ chapter: { n: 1, name: "The Past Week and Now" } });
  out.push({ callout: { tag: "HOW TO READ", text: airQualityReportMeta(d).howToRead } });
  for (const s of shots[1] || []) out.push({ image: s });
  out.push({ subheading: "Reading this map", body: "OBSERVED: each dot is a ground station; its number and colour are the US AQI Hawanama publishes from the latest hourly reading, so it can differ from the NowCast and 24-hour values in this report. MODELLED: the colour surface is the satellite-supported PM2.5 estimate in µg/m³ (blue low, red high). It fills the gaps between stations with an estimate, so do not read it as measured AQI." });

  out.push({ subheading: "How bad was each day?", body: H.weekLine });
  out.push(_chart(aqiColumns(S, days.map((x) => ({ v: x.median_aqi, hi: x.p90_aqi, label: _short(x.date), sub: _date(x.date, { weekday: "short" }) })), { title: "Daily AQI", h: 165 }),
    "Observed daily AQI (PM2.5, 24-hour), middle station; the line reaches the worst 10% of stations", "bar colour and background band = AQI category"));
  out.push(_chart(categoryStacks(S, days.map((x) => ({ counts: x.category_counts, label: _short(x.date), sub: _date(x.date, { weekday: "short" }) })), { title: "Stations by category", h: 125 }),
    "How many stations were in each AQI category, day by day", "only stations with at least 18 valid hours that day"));
  out.push({ table: { title: "Day by day (observed, 24-hour). PM2.5 is shown as supporting evidence.", head: ["Day", "Middle station AQI", "Middle city", "Worst 10% from", "Most affected city*", "Valid / reporting", "PM2.5 (middle)"],
    rows: days.map((x) => [_date(x.date), S.cell(x.median_aqi), aqiText(x.median_city_aqi), aqiText(x.p90_aqi), x.worst_city ? `${x.worst_city} ${aqiText(x.worst_city_aqi)} (${_plural(x.worst_city_n, "station")})` : "n/a", `${x.n_valid} / ${x.n_reporting}`, _pm(x.median_pm25)]) } });
  out.push({ body: `* Cities with two or more valid stations are preferred, so one faulty sensor cannot top the list. City value = the sub-index of its middle station. US EPA's own rule takes the highest monitor in an area ${cite("tad")}; this report uses the middle one because many sensors are low-cost, and shows the highest beside it.` });

  // Right now
  out.push({ subheading: "Right now", body: now ? H.nowLine : "Current readings could not be turned into a NowCast for this issue, so this section is left empty rather than estimated." });
  if (now) {
    out.push({ table: { title: `Stations in each category now (observed, NowCast; ${now.n_valid} stations)`, head: S.cats.map((c) => c.label), rows: [S.cats.map((c) => ({ t: String(now.category_counts[c.key] || 0), bg: c.color }))] } });
    const list = now.cities.filter((c) => c.n >= 2 || _isMetro(c.city)).slice(0, 9);
    out.push({ cards3: list.map((c) => {
      const f = fcBy.get(c.city), f1 = f?.days?.[1], ob = o.cities.find((x) => x.city === c.city);
      return { title: c.city, value: `AQI ${aqiText(c.aqi)}`, label: S.label(c.aqi), color: S.color(c.aqi), lines: [
        `Dominant: PM2.5 (only one measured)`, `This week: ${TREND_ICON[ob?.trend] || "Insufficient data"}`,
        `${_plural(c.n, "station")}${c.n > 1 ? `, AQI ${aqiText(c.min)} to ${aqiText(c.max)}` : ""}; to ${_pkt(c.time)}`,
        f1 ? `Tomorrow: ${aqiText(f1.aqi)} ${S.label(f1.aqi)}` : "Tomorrow: no forecast",
        `Data confidence: ${ob ? _cap(ob.confidence) : "Low"}`] };
    }) });
    out.push({ body: "Cards: the nine worst cities right now with two or more reporting stations, or major cities. Observed, NowCast." });
  }

  // Pollutants
  out.push({ subheading: "Which pollutant is behind it?", body: `Pakistan's available stations measure PM2.5 only, so every OBSERVED AQI in this report is a PM2.5 sub-index, not a full multi-pollutant AQI. The other five pollutants below are MODELLED by CAMS on squares of about 45 km ${cite("cams")} and have not been checked against stations here. They show whether another pollutant could matter; they are not readings.` });
  const pol = a.pollutants;
  if (pol?.cities?.length) {
    const rows = pol.cities.filter((c) => c.last).slice(0, 14);
    const day = rows[0]?.last?.date;
    out.push({ table: { title: `Pollutant sub-indices on ${_date(day)}: PM2.5 from stations (observed), others modelled (CAMS)`, head: ["City", "PM2.5 (observed)", "PM10", "Ozone", "NO₂", "SO₂", "CO", "Highest"],
      rows: rows.map((c) => [c.city, S.cell(c.last.pm25_station_aqi), ...["pm10", "o3", "no2", "so2", "co"].map((p) => { const v = c.last.sub?.[p]?.aqi; return Number.isFinite(v) ? { t: aqiText(v), bg: S.color(v) } : "no data"; }),
        c.last.dominant ? POL_NAME[c.last.dominant] : "n/a"]) } });
    const notPm = rows.filter((c) => c.last.dominant && c.last.dominant !== "pm25");
    const second = rows.filter((c) => c.last.sub?.o3?.aqi > 100).map((c) => c.city);
    out.push({ body: `${notPm.length ? `A modelled pollutant is higher than measured PM2.5 in ${_join(notPm.map((c) => `${c.city} (${POL_NAME[c.last.dominant]})`))}.` : "PM2.5 is the highest sub-index in every city listed."}${second.length ? ` Modelled ozone is above 100 in ${_join(second)}: sunshine can make ozone even when particles dominate.` : ""} Averaging: PM10 24-hour, ozone and CO highest 8 hours, NO₂ and SO₂ highest hour.` });
  } else out.push({ body: "The modelled pollutants could not be fetched for this issue." });

  // Regulatory panel, kept apart from AQI
  const vd = days[days.length - 1];
  out.push({ subheading: "Against the legal and health limits", body: "Limits are on PM2.5 concentration. They are separate from AQI categories and must not be read as AQI values." });
  out.push({ table: { title: `PM2.5 on ${_date(vd.date)}: middle station ${_pm(vd.median_pm25)} (24-hour mean)`, head: ["Limit", "Value (24-hour)", "Middle station is", "Valid stations above it, average day"],
    rows: [[`WHO Air Quality Guideline (2021) ${cite("who")}`, `${WHO_24H} µg/m³`, `${(vd.median_pm25 / WHO_24H).toFixed(1)} times`, _share(d, "share_above_who24")],
      [`Pakistan NEQS for ambient air, S.R.O. 1062(I)/2010 ${cite("neqs")}`, `${NEQS_24H} µg/m³`, `${(vd.median_pm25 / NEQS_24H).toFixed(1)} times`, _share(d, "share_above_neqs24")]] } });

  // Why
  out.push({ subheading: "Why is the air unhealthy?", body: "These factors are supported by context. None of them proves how much each source added to a given day." });
  out.push({ cards: _why(d, worst, days) });
  const ctx = _contextTable(d, o.dates);
  if (ctx) out.push({ table: ctx });

  // Hotspots
  const hot = spreadCities(ranked).slice(0, PAST_HOTSPOTS);
  hot.forEach((c, i) => {
    const n = nowBy.get(c.city);
    out.push({ subheading: `Hotspot ${i + 1}: ${c.city}`,
      banner: { value: aqiText(c.median_aqi), label: S.label(c.median_aqi), color: S.color(c.median_aqi), unit: "Middle daily AQI",
        title: `${c.city}: ${S.label(c.median_aqi)} on a typical day this week`,
        text: `Worst day ${_date(c.peak_date)} at AQI ${aqiText(c.peak)} (${S.label(c.peak)}). ${S.cats.filter((k) => c.days_by_category[k.key]).map((k) => `${_plural(c.days_by_category[k.key], "day")} ${k.label}`).join(", ")}. The week is ${TREND_TXT[c.trend]}.${n ? ` Right now: ${aqiText(n.aqi)}, ${S.label(n.aqi)}.` : ""}` } });
    out.push(_chart(aqiColumns(S, c.series.map((x, k) => ({ v: x?.aqi, lo: x && x.n > 1 ? x.min : undefined, hi: x && x.n > 1 ? x.max : undefined, label: _short(o.dates[k]), sub: x ? `${x.n} stn` : "" })), { title: c.city, h: 105 }),
      `${c.city}: observed daily AQI (PM2.5, 24-hour), middle station`, "line = lowest to highest station; stn = stations with valid data"));
    out.push({ bullets: [
      `Evidence (station-observed): PM2.5 averaged ${_pm(c.mean_pm25)} over the valid days, and ${_pm(c.peak_pm25)} over 24 hours on the worst day. Limits for comparison: WHO ${WHO_24H}, Pak-NEQS ${NEQS_24H} µg/m³ (24-hour).`,
      _confidenceLine(c),
    ] });
    out.push({ callout: { tag: "WHAT THIS MEANS FOR YOU", color: S.color(c.last ?? c.median_aqi), text: `${S.advice(c.last ?? c.median_aqi)}${pending}. For ${c.city}, based on ${c.last != null ? `${_date(o.dates[o.dates.length - 1])}` : "the week's typical day"}.` } });
  });

  // Cities
  const metro = METROS.map((m) => o.cities.find((c) => c.city.toLowerCase() === m.toLowerCase()) || { city: m, missing: true });
  out.push({ subheading: "Major cities compared", body: "Current values are NowCast; the week and peak are 24-hour values. They are in separate columns because they are not the same measure." });
  out.push({ table: { title: "Major cities (observed). Worst first by the middle daily AQI.", head: ["City", "Now (NowCast)", "Highest station now", "Middle day of week", "Trend", "Peak day", "Stations / valid days", "Newest hour", "PM2.5, week mean", "Confidence"],
    rows: metro.sort((x, y) => (y.median_aqi ?? -1) - (x.median_aqi ?? -1)).map((c) => {
      const n = nowBy.get(c.city);
      if (c.missing) return [c.city, n ? S.cell(n.aqi) : "Insufficient data", n ? aqiText(n.max) : "", "Insufficient data", "", "", "", n ? _pkt(n.time) : "", "", "Low"];
      return [c.city, n ? S.cell(n.aqi) : "Insufficient data", n ? aqiText(n.max) : "n/a", S.cell(c.median_aqi), { t: TREND_ICON[c.trend], nw: true }, { t: `${aqiText(c.peak)}, ${_short(c.peak_date)}`, nw: true }, { t: `${c.n_stations} / ${c.days_valid}`, nw: true }, n ? { t: _pkt(n.time).slice(-9), nw: true } : "n/a", { t: _pm(c.mean_pm25), nw: true }, _cap(c.confidence)];
    }) } });

  // ---------------------------------------------------------------- chapter 2
  out.push({ chapter: { n: 2, name: "The Outlook" } });
  for (const s of shots[2] || []) out.push({ image: s });
  out.push({ subheading: "Reading this map", body: `MODELLED: the surface is Hawanama's PM2.5 forecast in µg/m³ for one hour${d.forecast?.init_time ? `, issued ${_pkt(d.forecast.init_time)}` : ""} (0.1°, about 10 km, ${d.forecast?.beta ? "beta product" : "operational"}). OBSERVED: dots are live WAQI stations coloured by US AQI. A map hour is not a daily AQI; the AQI outlook below uses 24-hour values.` });
  if (fc?.days?.length) {
    out.push({ subheading: "National AQI outlook", body: `${H.fcLine} FORECAST, not observed: each value is the expected 24-hour AQI for a city, from CAMS adjusted with that city's stations ${cite("cams", "paqidata")}.` });
    out.push({ banner: { value: aqiText(tom?.median_aqi ?? fc.days[0].median_aqi), label: S.label(tom?.median_aqi ?? fc.days[0].median_aqi), color: S.color(tom?.median_aqi ?? fc.days[0].median_aqi), unit: "Forecast, middle city",
      title: `${tom ? "Tomorrow" : _date(fc.days[0].date)}: ${S.label(tom?.median_aqi ?? fc.days[0].median_aqi)} in the middle forecast city`,
      text: `Expected worst: ${_date(H.fWorst.date)} (middle city ${aqiText(H.fWorst.median_aqi)}). Expected best: ${_date(_best(fc).date)} (${aqiText(_best(fc).median_aqi)}). ${_relief(fc, S)}` } });
    out.push(_chart(categoryStacks(S, fc.days.map((x) => ({ counts: x.category_counts, label: _short(x.date), sub: x.date === fc.today ? "today" : `day +${fc.targets.indexOf(x.date)}` })), { title: "Forecast categories", unit: "cities", h: 115 }),
      "Forecast: how many cities are expected in each AQI category", "24-hour AQI (PM2.5), station-adjusted CAMS"));
    out.push({ table: { title: "National outlook by day (forecast)", head: ["Valid for", "Middle city", "Cities Unhealthy or worse", "Cities Very Unhealthy or worse", "Highest city", "Past hit rate*"],
      rows: fc.days.map((x) => [`${_date(x.date)}${x.date === fc.today ? " (today)" : ""}`, S.cell(x.median_aqi), `${S.atLeast(x.category_counts, "unhealthy")} of ${x.n_cities}`, `${S.atLeast(x.category_counts, "very_unhealthy")} of ${x.n_cities}`, aqiText(x.max_aqi), `${x.skill.hit}% exact, ${x.skill.within1}% within one category`]) } });
    out.push({ body: `* ${fc.skill_note}` });
    const order = [...fc.cities].sort((x, y) => (Number(_isMetro(y.city)) - Number(_isMetro(x.city))) || y.peak - x.peak);
    out.push({ table: { title: "City outlook: forecast 24-hour AQI (likely range in brackets)", head: ["City", ...fc.targets.map((t) => (t === fc.today ? "Today" : _date(t))), "Trend", "Models agree?"],
      rows: order.map((c) => [c.city, ...c.days.map((x) => (x ? { t: `${aqiText(x.aqi)} (${aqiText(x.lo)}–${aqiText(x.hi)})`, bg: S.color(x.aqi), nw: true } : "no forecast")), { t: TREND_ICON[c.trend], nw: true }, _agree(d, fc, c).short]) } });
    out.push({ body: "The range is where 8 of 10 past outcomes fell. Cell colour = category of the forecast value. Values above 500 are beyond the scale and shown as 500+. \"Models agree?\" compares the PM2.5 behind the forecast with Hawanama's separate forecast over the days both cover: yes = within 1.5 times." });

    const focus = spreadCities(fc.cities.filter((c) => ranked.some((r) => r.city === c.city))).slice(0, FORECAST_FOCUS);
    for (const c of focus) {
      const n = nowBy.get(c.city), wq = waqiNear(c.lon, c.lat);
      const peak = c.days.filter(Boolean).reduce((x, y) => (y.aqi > x.aqi ? y : x));
      const haw = (d.forecast?.cities || []).find((x) => x.city === c.city);
      const ag = _agree(d, fc, c);
      out.push({ subheading: `Forecast focus: ${c.city}`,
        banner: { value: aqiText(c.peak), label: S.label(c.peak), color: S.color(c.peak), unit: "Forecast peak",
          title: `${c.city}: ${S.label(c.peak)} expected at its worst, ${_date(c.peak_date)}`,
          text: `Likely range ${aqiText(peak.lo)} to ${aqiText(peak.hi)} (24-hour AQI). Best day: ${_date(c.best_date)} at ${aqiText(c.best)} (${S.label(c.best)}). ${n ? `Observed now: ${aqiText(n.aqi)}, ${S.label(n.aqi)}.` : ""}${ag.ok === false ? " The two forecast models disagree here: treat this with caution." : ""}` } });
      out.push(_chart(aqiColumns(S, c.days.map((x, k) => ({ v: x?.aqi, lo: x?.lo, hi: x?.hi, label: fc.targets[k] === fc.today ? "Today" : _short(fc.targets[k]), sub: x ? `day +${k}` : "" })), { title: c.city, h: 105 }),
        `${c.city}: forecast 24-hour AQI (PM2.5)`, "line = likely range (8 of 10 past outcomes)"));
      const bullets = [`Evidence: expected PM2.5 of ${c.days.map((x) => (x ? String(Math.round(x.pm25)) : "n/a")).join(", ")} µg/m³ (24-hour). Model adjusted ×${c.ratio} from ${c.n_ratio_days} days of the city's own stations.`];
      if (haw?.series?.length && d.forecast?.leads?.length) bullets.push(`Second model (Hawanama, single hours, not daily values): ${d.forecast.leads.map((l, k) => (Number.isFinite(haw.series[k]) ? `+${l.lead_h} h ${Math.round(haw.series[k])}` : null)).filter(Boolean).join(", ")} µg/m³ over the city's grid square. ${ag.text}`);
      out.push({ bullets });
      if (wq.length) out.push({ table: { title: `Observed reference near ${c.city}: WAQI stations (US AQI as published by WAQI, its own method)`, head: ["Station", "Distance", "AQI now"], rows: wq.map((x) => [x.name || `Station ${x.uid}`, `${Math.round(x.km)} km`, S.cell(x.aqi)]) } });
      out.push({ callout: { tag: "WHAT THIS MEANS FOR YOU", color: S.color(c.peak), text: `${S.advice(c.peak)}${pending}. For ${c.city}, around ${_date(c.peak_date)}. Check the newest issue before acting on a forecast.` } });
    }
  } else out.push({ body: "The AQI forecast could not be made for this issue (model or recent station data unavailable). It is left out rather than estimated." });

  // ---------------------------------------------------------------- chapter 3
  out.push({ chapter: { n: 3, name: "Health, Action and Data Quality" } });
  out.push({ subheading: "What each category means", body: `Fine-particle (PM2.5) advice from the US EPA ${cite("tad")}${std.advice_approved ? "" : ". It is shown for review and must be approved by Pakistan's health and environment authorities before public release"}.` });
  out.push({ table: { title: `AQI categories (${stdNote})`, head: ["Category", "In plain words", "Sensitive groups", "Everyone else"],
    rows: S.cats.map((c) => [{ t: `${c.label} (${c.hi == null ? `${c.lo}+` : `${c.lo}–${c.hi}`})`, bg: c.color }, c.meaning, c.advice_sensitive || "No special precaution.", c.advice_everyone || "No special precaution."]) } });
  out.push({ body: `Sensitive groups for particle pollution: ${std.sensitive_groups_pm} During smoke, the US EPA also lists pregnant people.` });
  out.push({ subheading: "Planning notes (draft, for approval)", bullets: [
    "Schools: check the day's category before outdoor assembly, sport and travel; move activity indoors from Unhealthy upwards.",
    "Outdoor workers: shorten and rotate heavy work, and shift it away from the late-night and early-morning peak where possible.",
    "Hospitals and clinics: expect more breathing and heart complaints when a district stays Very Unhealthy or worse for several days.",
    "Events: review strenuous outdoor events when the forecast is Unhealthy or worse, and re-check on the day.",
  ] });

  out.push({ subheading: "From AQI to action: options for authorities (draft)", body: "Options to consider, not instructions. A person must review the data before any public warning, and no restriction should rest on a model forecast alone." });
  out.push({ table: { title: "AQI-to-action options", head: ["When the observed AQI is", "Consider"], rows: [
    [{ t: "Moderate", bg: S.cats[1].color }, "Routine monitoring; check stations that stopped reporting."],
    [{ t: "Unhealthy for Sensitive Groups", bg: S.cats[2].color }, "Advise sensitive groups; alert schools and clinics in the area; check the next-day forecast."],
    [{ t: "Unhealthy", bg: S.cats[3].color }, "Public advisory for the area; coordinate with the provincial environment and health departments; review strenuous outdoor events."],
    [{ t: "Very Unhealthy", bg: S.cats[4].color }, "As above, plus hospital readiness, and targeted inspection of sources where evidence supports it."],
    [{ t: "Hazardous", bg: S.cats[5].color }, "As above, plus escalation to the provincial and national level for a decision on protective measures, with human review."],
  ] } });
  const priority = (fc?.cities || []).map((c) => ({ c: c.city, n: c.days.filter((x) => x && x.aqi > 200).length, t: c.days.filter(Boolean).length, peak: c.peak, date: c.peak_date })).filter((x) => x.n >= 2).sort((x, y) => y.n - x.n || y.peak - x.peak);
  out.push({ subheading: "Cities to watch next", body: priority.length ? "FORECAST: cities expected to be Very Unhealthy or worse on two or more of the coming days." : "No city is forecast Very Unhealthy or worse on two or more of the coming days." });
  if (priority.length) out.push({ table: { title: "Cities to watch (forecast)", head: ["City", "Days Very Unhealthy or worse", "Forecast peak", "On"], rows: priority.slice(0, 15).map((x) => [x.c, `${x.n} of ${x.t}`, S.cell(x.peak), _date(x.date)]) } });

  // Data quality
  out.push({ subheading: "How good are the data?" });
  out.push({ table: { title: "Data quality at the time of this report", head: ["Check", "Result"], rows: [
    ["Stations listed in Pakistan", now ? String(now.n_listed) : "n/a"],
    ["Reporting within the last 3 hours", now ? `${now.n_recent} (${_pc(now.n_recent, now.n_listed)})` : "n/a"],
    ["Enough hours for a current AQI (NowCast)", now ? `${now.n_valid} (${_pc(now.n_valid, now.n_listed)})` : "n/a"],
    ["Valid 24-hour values on the latest day", `${last.n_valid} of ${last.n_reporting} reporting (18 of 24 hours needed)`],
    ["Where the stations are", now?.cities?.length ? `${[...now.cities].sort((x, y) => y.n - x.n).slice(0, 3).map((c) => `${c.city} ${c.n}`).join(", ")} of ${now.n_valid}; ${now.n_cities} cities in all` : "n/a"],
    ["Newest reading used", now ? _pkt(now.data_time) : "n/a"],
    ["Networks (current AQI)", now ? Object.entries(now.networks).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ") : "n/a"],
    ["Readings dropped for a provider quality flag", now ? String(now.n_flagged_readings) : "n/a"],
    ["Station data requests that failed", now ? String(now.failed_requests) : "n/a"],
    ["Pollutants measured", "PM2.5 only. PM10, ozone, NO₂, SO₂ and CO are modelled."],
    ["Pollutant model", a.pollutants ? `${a.pollutants.model.name}, ${a.pollutants.model.resolution}` : "unavailable for this issue"],
    ["Parts missing from this issue", Object.keys(a.errors || {}).length ? Object.keys(a.errors).join(", ") : "none"],
    ["Data built at", _pkt(a.generated_at)],
    ["Data snapshot", a.snapshot_id || "not stored"],
  ] } });
  out.push({ subheading: "Confidence labels", body: "Set by fixed rules, not judgement. They rate the observations only; forecast skill is stated separately.", bullets: ["high", "medium", "low"].map((k) => `${_cap(k)}: ${a.confidence_rules?.[k] || ""}.`) });

  // Methods
  out.push({ subheading: "Method and limits", bullets: [
    `Standard: ${std.name}, ${std.version} ${cite("tad", "cfr58")}. ${std.approved ? "Adopted for this report." : "It is used as a reference until NDMA and the authorities choose a standard for Pakistan."}`,
    `EPA Punjab computes its own index from 8-hour averages (Order 355/PA, in force 3 October 2025) ${cite("punjab")}. Its numbers differ from these for the same air, so the two must not be compared or mixed.`,
    `Sub-index: the concentration is truncated as the standard prescribes, placed between its two breakpoints, and interpolated. Overall AQI = the highest valid sub-index ${cite("tad", "cfr58")}.`,
    `Daily AQI: 24-hour mean PM2.5 per station, valid with at least 18 of 24 hours ${cite("cfr50")}. No station, or too few hours, means no value.`,
    `Departure from the standard: US EPA reports the highest monitor in an area ${cite("tad")}. This report uses the middle station for a city, so that one faulty sensor cannot set its level, and prints the highest station next to it. A city's official US-style AQI would be at or above the value shown.`,
    `Current AQI: US EPA NowCast from up to 12 hourly values, with at least 2 of the latest 3 ${cite("tad")}; stations whose newest hour is over 3 hours old are left out.`,
    `Forecast AQI: CAMS 24-hour PM2.5, multiplied by the city's average observed-to-model ratio over the last 7 days (limits 0.5 to 4, at least 5 days), then blended with the last observed day (70% on day 1, 50% on day 2, 30% after), and held to at most 1.5 times the highest day of the last week. Adjusting models with recent observations is established practice ${cite("kang")}; the skill printed here comes from NCOP's own backtest.`,
    "Trend: a change of 15 AQI points or more between the first and last valid day. Weekly averages are never turned into an AQI.",
    `Many stations are low-cost sensors, which can read high, especially in humid air ${cite("barkjohn")}. Readings are as published by the networks and are not corrected by NCOP, so true levels may be lower or higher than shown.`,
    "Checks on the calculator: it reproduces the US EPA worked examples and every breakpoint edge; on 24 November 2026 it matched Hawanama's published AQI exactly at 1,116 of 1,182 stations, and Open-Meteo's published sub-indices to within 0.3 to 3.7 points on average for all six pollutants.",
    "Population exposure is not estimated: the station network is too sparse outside the main cities to support it.",
  ] });
  out.push({ heading: "References", refs: REFS.map((r) => r[1]) });
  return out;
}

// ---- pieces ------------------------------------------------------------------
/** Does Hawanama's forecast support this city's outlook? Mean of its map hours
 *  on each forecast day against the 24-h PM2.5 behind the AQI. */
function _agree(d, fc, c) {
  const h = (d.forecast?.cities || []).find((x) => x.city === c.city), leads = d.forecast?.leads || [];
  const ratios = [];
  if (h?.series) fc.targets.forEach((day, i) => {
    const v = leads.map((l, k) => (new Date(new Date(l.valid_time).getTime() + 5 * 3600e3).toISOString().slice(0, 10) === day ? h.series[k] : null)).filter(Number.isFinite);
    if (v.length && c.days[i]?.pm25) ratios.push(c.days[i].pm25 / (v.reduce((s, x) => s + x, 0) / v.length));
  });
  if (!ratios.length) return { ok: null, short: "not comparable", text: "It could not be compared with the AQI forecast." };
  const r = Math.exp(ratios.reduce((s, x) => s + Math.log(x), 0) / ratios.length);
  const ok = r <= 1.5 && r >= 1 / 1.5;
  return { ok, short: ok ? "yes" : r > 1 ? `no, ${r.toFixed(1)}× higher` : `no, ${(1 / r).toFixed(1)}× lower`,
    text: ok ? "It supports the forecast above (within 1.5 times)." : `The forecast above is ${r > 1 ? `${r.toFixed(1)} times higher` : `${(1 / r).toFixed(1)} times lower`} than this model, so confidence is lower.` };
}
const _best = (fc) => fc.days.reduce((x, y) => (y.median_aqi < x.median_aqi ? y : x));
function _relief(fc, S) {
  const f = fc.days[0], l = fc.days[fc.days.length - 1];
  const i = fc.days.findIndex((x) => x.median_aqi <= 150);
  if (i >= 0) return `The middle city is expected to drop below Unhealthy on ${_date(fc.days[i].date)}.`;
  return l.median_aqi < f.median_aqi - 15 ? `Some easing is expected by ${_date(l.date)}, but the middle city stays ${S.label(l.median_aqi)}.` : "No clear relief is expected in this window.";
}
function _share(d, key) {
  const x = (d.aqi?.observed?.days || []).map((r) => r[key]).filter(Number.isFinite); // valid station-days only
  return x.length ? `${Math.round((100 * x.reduce((s, v) => s + v, 0)) / x.length)}%` : "n/a";
}
function _km(p, q) {
  const r = Math.PI / 180, s = Math.sin(((q.lat - p.lat) * r) / 2) ** 2 + Math.cos(p.lat * r) * Math.cos(q.lat * r) * Math.sin(((q.lon - p.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(s));
}
/** Neighbouring towns share the same air: keep the first of any pair within 30 km. */
export function spreadCities(list) {
  const kept = [];
  for (const c of list) if (!kept.some((k) => _km(k, c) < 30)) kept.push(c);
  return kept;
}
function _mean(a) { const f = a.filter(Number.isFinite); return f.length ? f.reduce((s, v) => s + v, 0) / f.length : null; }
function _fires(d, date) {
  const i = (d.drivers?.dates || []).indexOf(date);
  const v = Object.values(d.drivers?.fires?.regions || {}).map((x) => x[i]).filter(Number.isFinite);
  return i >= 0 && v.length ? v.reduce((s, x) => s + x, 0) : null;
}
function _met(d, date) { const i = (d.drivers?.dates || []).indexOf(date); return i >= 0 ? d.drivers?.met?.[i] || null : null; }

function _why(d, worst, days) {
  const dates = days.map((x) => x.date);
  const met = dates.map((x) => _met(d, x) || {});
  const wind = _mean(met.map((m) => m.wind_kmh)), hi = _mean(met.map((m) => m.blh_max_m)), lo = _mean(met.map((m) => m.blh_min_m));
  const best = days.reduce((x, y) => (y.median_aqi < x.median_aqi ? y : x));
  const mw = _met(d, worst.date), mb = _met(d, best.date);
  const cards = [];
  if (Number.isFinite(wind)) {
    const cmp = mw && mb && worst.date !== best.date && Number.isFinite(mw.wind_kmh) && Number.isFinite(mb.wind_kmh)
      ? ` On the worst day (${_short(worst.date)}) wind averaged ${mw.wind_kmh.toFixed(1)} km/h; on the cleanest (${_short(best.date)}), ${mb.wind_kmh.toFixed(1)} km/h${mw.wind_kmh >= mb.wind_kmh ? ", so wind alone does not explain the difference between those two days" : ""}.` : "";
    cards.push({ title: "Still air and a low lid [supported by context]", text: `Polluted air was not carried away well: wind averaged ${wind.toFixed(1)} km/h over ${_join(d.drivers?.met_points || ["the Punjab plain"])}. The air could mix up to about ${_int(hi)} m at the day's highest hour, but only about ${_int(lo)} m at its lowest, so pollution stayed near the ground.${cmp} These are model values averaged over the week.`, source: `Weather: ${cite("met")}. A shallow winter mixing layer and stagnant air as causes of Lahore's smog: ${cite("urban", "majeed")}.` });
  }
  const f = dates.map((x) => _fires(d, x)).filter(Number.isFinite);
  if (f.length) {
    const fw = _fires(d, worst.date), fb = _fires(d, best.date);
    const fireCmp = Number.isFinite(fw) && Number.isFinite(fb) && worst.date !== best.date
      ? ` On the worst day ${_int(fw)} fires were detected; on the cleanest, ${_int(fb)}${fw <= fb ? ", so the fire count alone does not explain it either (smoke travels, and cloud or haze can hide fires)" : ""}.` : "";
    const season = Object.entries(d.drivers?.fires?.season || {}).filter(([, v]) => v?.fires).map(([k, v]) => `${k === "punjab" ? "Pakistani" : "Indian"} Punjab ${_int(v.fires)}${Number.isFinite(v.pct_change) ? ` (${v.pct_change >= 0 ? "+" : ""}${v.pct_change}% on ${v.last_year})` : ""}`);
    cards.push({ title: "Crop-residue burning [supported by context]", text: `Satellites detected ${_int(f.reduce((s, v) => s + v, 0))} crop fires in the two Punjabs this week.${season.length ? ` Season so far: ${_join(season)}.` : ""}${fireCmp} A detected fire shows burning; it does not measure how much of a city's pollution came from it.`, source: `Fire counts: ${cite("viirs", "paqidata")}. Share of Lahore's PM2.5 emissions: about 33% in the 2020–21 inventory ${cite("urban")}; one ranking study puts cross-border open burning above vehicles ${cite("majeed")}.` });
  }
  cards.push({ title: "Traffic, waste burning, industry and kilns [published source studies]", text: "Year-round local emissions set the base level; winter weather lifts it to extremes. The studies disagree, and the shares below are for Lahore's emissions over a year, not for this week's air.", source: `Urban Unit inventory, 2020–21 data: transport 35%, crop burning 33%, waste burning 29%, industry 3% ${cite("urban")}. PAQI 2025: transport 35%, industry 28%, brick kilns 17% ${cite("paqi25")}, which Punjab EPA rejects ${cite("dawn25")}.` });
  cards.push({ title: "A basin that holds the air [geography]", text: "The plain is walled by mountains to the north, and slow winter winds tend to keep smoke over it. Dust and transport across the border are possible contributors; they were not measured here.", source: `Meteorology and cross-border transport: ${cite("majeed")}.` });
  return cards;
}
function _contextTable(d, dates) {
  const rows = dates.map((x) => {
    const m = _met(d, x) || {}, f = _fires(d, x);
    return [_date(x), Number.isFinite(m.wind_kmh) ? `${m.wind_kmh.toFixed(1)} km/h` : "n/a", Number.isFinite(m.blh_max_m) ? `${_int(m.blh_max_m)} m` : "n/a", Number.isFinite(m.blh_min_m) ? `${_int(m.blh_min_m)} m` : "n/a", Number.isFinite(m.precip_mm) ? `${m.precip_mm.toFixed(1)} mm` : "n/a", Number.isFinite(f) ? _int(f) : "n/a"];
  });
  if (!rows.some((r) => r.slice(1).some((c) => c !== "n/a"))) return null;
  return { title: `Context by day: weather (model, Punjab plain cities) ${cite("met")} and crop fires (satellite) ${cite("viirs")}. Low wind and low mixing trap pollution.`, head: ["Day", "Wind, mean", "Mixing, highest hour", "Mixing, lowest hour", "Rain", "Crop fires"], rows };
}
