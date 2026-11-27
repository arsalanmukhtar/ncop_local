// story-food-security-report.js
// --------------------------------------------------------------------------
// Decision-support report for the National Food Security & Agriculture Watch
// (sections for story-report-export.js), and the plain-language helpers the
// story shares with it. Pure: digest in, sections out. Every level and number
// comes from the backend (project/ncop_internal/foodsec_ews.py); this file
// only words and draws them.
//
// Every figure carries one tag: [Observed], [Survey], [Modelled] or
// [Forecast], with its period. Outcomes (what has happened to people) and
// drivers (what may happen next) are kept in separate sections.
// --------------------------------------------------------------------------

export const LEVELS = [
  { label: "Normal", color: "#3FA34D", say: "no unusual pressure" },
  { label: "Watch", color: "#E7B416", say: "early signs; check and prepare" },
  { label: "Warning", color: "#E67800", say: "several pressures at once; get ready to act" },
  { label: "Alert", color: "#C80100", say: "severe pressure; act now" },
];
const PHASES = { 1: ["Minimal", "#CDFACD"], 2: ["Stressed", "#FAE61E"], 3: ["Crisis", "#E67800"], 4: ["Emergency", "#C80100"], 5: ["Famine", "#640000"] };
const WHY = {
  fews_phase: ["families stretched", "hunger at Crisis level", "hunger at Emergency level"],
  flour_m3: ["flour price rising", "flour price up sharply", "flour price jumped"],
  kg_wage: ["a day's wage buys less flour", "a day's wage buys much less flour", "a day's wage buys far less flour"],
  spread: "flour dear against wheat", spi: "too little rain", soil: "dry soil", vci: "weak crops", canal: "canal-water shortage", wet: "very heavy rain", displaced: "people displaced",
};
export const PILLAR = { hunger: "Hunger", market: "Food prices and wages", water: "Water and crops", shocks: "Shocks" };
const MODEL_NAME = { no_change: "No change (same price)", seasonal: "Usual seasonal pattern (the old method)", momentum: "Recent momentum",
  drivers: "Price drivers (recent prices, wheat, diesel)", blend: "Average of the last three", chosen: "Method used: best of the past 3 years" };

const SOURCES = {
  guide: "NCOP implementation guide (24 November 2026): Turning the Food Security Watch into a Decision-Support and Early-Warning System. Starting thresholds, marked there as illustrative.",
  ipcDec: "IPC (18 February 2026). Pakistan: Acute Food Insecurity, 1 December 2025 to 30 March 2026 and projection 1 April to 30 September 2026 (45 districts of Balochistan, Khyber Pakhtunkhwa and Sindh). ipcinfo.org, details-map 1161020.",
  ipcPun: "IPC analysis platform (2026). IPC AFI Analysis March 2026, Punjab: six districts added to the analysis above; current 1 to 31 March 2026, projection 1 April to 30 September 2026. Read from the IPC data service.",
  ipcManual: "IPC Global Partners. Integrated Food Security Phase Classification Technical Manual, version 3.1. Phases, and population shares assigned in steps of 5%. ipcinfo.org",
  ipcAmn: "Save the Children (20 April 2026), reporting the IPC acute-malnutrition analysis October 2025 to September 2026, 45 districts. savethechildren.net. The IPC report itself is listed at ipcinfo.org, details-map 1161574.",
  fewsData: "FEWS NET Data Warehouse: food-insecurity area classification for Pakistan, IPC-compatible, October 2026 outlook (by district). fdw.fews.net",
  fewsOct: "FEWS NET (October 2026). Pakistan Food Security Outlook: persistent high prices constrain food access, sustaining Crisis outcomes. Information as of 31 October 2026. fews.net/asia/pakistan/food-security-outlook/october-2026",
  fewsElnino: "FEWS NET (6 October 2026). Special report on El Niño. fews.net/global/special-report/october-2026",
  hies: "Pakistan Bureau of Statistics (2026). Household Integrated Economic Survey 2024–25, food-insecurity experience, Tables 7.1 and 7.2. pbs.gov.pk",
  diet: "World Bank and FAO, Food Prices for Nutrition 5.0 (July 2026): cost and affordability of a healthy diet. CC BY 4.0. api.worldbank.org, source 88",
  sofi: "FAO, prevalence of undernourishment (three-year average), through World Bank indicator SN.ITK.DEFC.ZS. CC BY 4.0.",
  ophi: "OPHI Multidimensional Poverty Index, 2017–18 survey, through OCHA HDX HAPI (hdx-hapi-pak). data.humdata.org",
  wfp: "World Food Programme VAM: Pakistan food prices, monthly retail prices and daily wage in Karachi, Lahore, Multan, Peshawar and Quetta. CC BY-IGO. data.humdata.org/dataset/wfp-food-prices-for-pakistan",
  pbs: "Pakistan Bureau of Statistics, Crop Reporting Services: area, production and yield by crop year, through NCOP's crop layer.",
  cereal: "Cereal Association of Pakistan estimate, as reported by AgriInsite (2026): actual wheat crop may be nearly 4 million tonnes below official estimate. agriinsite.com. Read as a search summary only; treat with care.",
  ipcAll: "IPC data service: every acute food insecurity analysis of Pakistan, 2017 to 2026, with its districts and dates.",
  psd: "USDA Foreign Agricultural Service: Production, Supply and Distribution database (grains). Marketing years. apps.fas.usda.gov/psdonline",
  fca: "Profit, Pakistan Today (15 April 2026): wheat output estimated at 29.31 million tonnes by the Federal Committee on Agriculture. profit.pakistantoday.com.pk",
  pink: "World Bank: Commodity Price Data (Pink Sheet), monthly. CC BY 4.0. worldbank.org/commodities",
  fx: "Open currency data: rupees per US dollar (currency-api). Public domain.",
  khaleej: "Khaleej Times (20 November 2026): Why is food becoming unaffordable for millions of households in Pakistan? Quotes PBS prices, imports, Sindh release price, DAP price. khaleejtimes.com",
  nationMonsoon: "The Nation (30 September 2026): Pakistan's 2026 monsoon rainfall falls 19.3 percent below normal, quoting the Pakistan Meteorological Department. nation.com.pk",
  dawnIrsa: "Dawn (7 October 2026): IRSA okays 22pc lower water share for Rabi. dawn.com/news/2035296",
  chirps: "Climate Hazards Center, UC Santa Barbara: CHIRPS v3 rainfall, 1981 to now, district means by NCOP on Google Earth Engine.",
  fldas: "NASA: FLDAS Noah land-surface model, soil moisture 10–40 cm, 1982 to now. McNally, A. et al. (2017), Scientific Data 4, 170012.",
  modis: "NASA: MODIS MOD13A2 v6.1 vegetation index over MCD12Q1 cropland, 2001 to now.",
  spi: "McKee, T. B., Doesken, N. J., Kleist, J. (1993). The relationship of drought frequency and duration to time scales. 8th Conference on Applied Climatology. Computed without a fitted curve, after Farahmand, A., AghaKouchak, A. (2015), Advances in Water Resources 76, 140–145.",
  vcipaper: "Kogan, F. N. (1995). Application of vegetation index and brightness temperature for drought detection. Advances in Space Research 15(11), 91–100.",
  enso: "NOAA Climate Prediction Center: Oceanic Niño Index and weekly Niño 3.4; diagnostic discussion of 12 November 2026. cpc.ncep.noaa.gov",
  ffd: "Pakistan Meteorological Department, Flood Forecasting Division: daily reservoir levels, through NCOP.",
  gefs: "NOAA GEFS v12 35-day ensemble outlook, bias-corrected by NCOP against NASA POWER.",
  giews: "FAO GIEWS: crop calendar, Pakistan.",
  acled: "ACLED, monthly conflict events for Pakistan, through OCHA HDX HAPI (hdx-hapi-pak). acleddata.com terms apply.",
  idmc: "Internal Displacement Monitoring Centre: internal displacement updates. CC BY-IGO. data.humdata.org/dataset/pak-idmc-idu-events",
  w3: "OCHA: operational presence (3W) by district, January to July 2025, through HDX HAPI.",
  census: "Pakistan Bureau of Statistics: 7th Population and Housing Census 2023 (provincial totals); district split from the European Commission JRC Global Human Settlement Layer, 2025.",
};

// ---- formatting ------------------------------------------------------------
const _x = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const _n = (v, dp = 0) => (Number.isFinite(v) ? v.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : "n/a");
export const millions = (v, dp = 1) => (Number.isFinite(v) ? (v >= 1e6 ? `${_n(v / 1e6, dp)} million` : v ? `${_n(Math.round(v / 1000))} thousand` : "0") : "n/a");
const _sg = (v, dp = 0) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${_n(Math.abs(v), dp)}%` : "n/a");
const _pc = (v, dp = 0) => (Number.isFinite(v) ? `${_n(v * 100, dp)}%` : "n/a");
const _join = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const _cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const _plural = (n, one, many = `${one}s`) => `${_n(n)} ${n === 1 ? one : many}`;
function _date(iso, opt = { day: "numeric", month: "short", year: "numeric" }) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso || "n/a") : d.toLocaleDateString("en-GB", { ...opt, timeZone: "UTC" });
}
const _month = (ym) => (ym ? _date(`${ym}-01`, { month: "long", year: "numeric" }) : "n/a");
const _mon = (ym) => (ym ? _date(`${ym}-01`, { month: "short", year: "2-digit" }) : "n/a");
const _lv = (i) => LEVELS[i] || LEVELS[0];
const _cell = (i) => ({ t: _lv(i).label, bg: _lv(i).color });
const _phase = (p) => (PHASES[p] ? { t: `${p} ${PHASES[p][0]}`, bg: PHASES[p][1] } : "no data");
export const prettyProvince = (p) => ({ "Federal Capital": "Islamabad" }[p] || String(p || "").replace(/_/g, " "));

const _why = (w, score) => (Array.isArray(WHY[w]) ? WHY[w][Math.max(0, Math.min(2, (score || 1) - 1))] : WHY[w]);

/** Plain reason a district is at its level. */
export function districtReason(r) {
  if (r.held) return `Easing: last month ${_join((r.held_why || []).map((w) => _why(w, 1)).filter(Boolean)) || "higher"}; kept one more month as a safeguard`;
  const out = [];
  for (const k of r.by || []) {
    const p = r.pillars?.[k];
    for (const w of p?.[1] || []) { const t = _why(w, p[0]); if (t && !out.includes(t)) out.push(t); }
  }
  return out.length ? _cap(out.join("; ")) : "No unusual pressure";
}
const KARACHI = /karachi|^korangi$|^malir$|^keamari$/i;
/** Districts of most concern; Karachi's city districts share one market and are one row. */
export function concernList(e, max = 10) {
  const by = new Map((e.districts || []).map((r) => [r.name, r]));
  const out = [];
  let city = null;
  for (const k of e.rankings?.level || []) {
    const r = by.get(k);
    if (!r) continue;
    if (!KARACHI.test(r.name)) { out.push(r); continue; }
    if (!city) { city = { ...r, members: 0 }; out.push(city); }
    city.members += 1;
    city.name = city.members > 1 ? `Karachi (${city.members} districts)` : r.name;
  }
  return out.slice(0, max);
}

/** Everything page 1 and the story's opening need; null without the early-warning block. */
export function ewsHeadline(d) {
  const e = d?.ews;
  if (!e?.national) return null;
  const n = e.national, lv = _lv(n.level), wp = n.warning_plus;
  const pk = e.market?.Pakistan || {};
  const rows = e.districts || [];
  const alert = rows.filter((r) => r.level === 3);
  const provs = (lvl) => {
    const c = new Map();
    for (const r of rows) if (r.level === lvl) c.set(r.province, (c.get(r.province) || 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1]).map(([p, k]) => `${prettyProvince(p)} ${k}`);
  };
  const karachiOnly = alert.length && alert.filter((r) => KARACHI.test(r.name)).length;
  const crisisNow = rows.filter((r) => (r.fews?.[0] || 0) >= 3).length;
  const crisisNext = rows.filter((r) => (r.fews?.[1] || 0) >= 3).length;
  const why = Object.entries(n.why || {}).slice(0, 2).map(([k]) => PILLAR[k].toLowerCase());
  return {
    e, n, lv, wp, pk, rows, alert, crisisNow, crisisNext, why,
    warnText: provs(2), alertText: provs(3), karachiOnly,
    line: `${_plural(wp.districts, "district")} of ${n.districts} are at Warning or Alert. About ${millions(wp.people)} people live in them (${_pc(wp.share_people)} of the population).${why.length ? ` Main pressures: ${_join(why)}.` : ""}`,
  };
}

// ---- charts (light, drawn once as SVG) ---------------------------------------
const W = 640;
function _chart(svg, title, legend) { return { chart: { svg, title, legend, bg: "#ffffff" } }; }

function levelBars(provinces) {
  const rowH = 26, left = 130, right = 60, top = 4, h = top + provinces.length * rowH + 6;
  const out = [`<rect width="${W}" height="${h}" fill="#ffffff"/>`];
  provinces.forEach((p, i) => {
    const y = top + i * rowH, tot = p.districts || 1;
    let x = left;
    out.push(`<text x="${left - 8}" y="${y + 16}" font-size="11" font-weight="600" fill="#111827" text-anchor="end">${_x(prettyProvince(p.province))}</text>`);
    p.count.forEach((c, k) => {
      if (!c) return;
      const w = ((W - left - right) * c) / tot;
      out.push(`<rect x="${x}" y="${y + 3}" width="${w}" height="${rowH - 8}" fill="${LEVELS[k].color}" stroke="#ffffff"/>`);
      if (w > 16) out.push(`<text x="${x + w / 2}" y="${y + 16}" font-size="10.5" font-weight="700" fill="${k === 1 ? "#111827" : "#ffffff"}" text-anchor="middle">${c}</text>`);
      x += w;
    });
    out.push(`<text x="${W - right + 6}" y="${y + 16}" font-size="10" fill="#6b7280">of ${p.districts}</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Districts by level and province">${out.join("")}</svg>`;
}

/** Line chart with optional forecast band and reference lines. */
export function lineChart({ series, labels, refs = [], band = null, unit = "", zero = false, dp = 0, h = 150, aria = "chart" }) {
  const padL = 44, padR = 14, top = 18, base = top + h, H = base + 20;
  const vals = [...series.flatMap((s) => s.values), ...(band || []).flatMap((b) => [b.lo, b.hi]), ...refs.map((r) => r.v)].filter(Number.isFinite);
  if (vals.length < 2) return "";
  let lo = zero ? Math.min(0, ...vals) : Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 1;
  if (!zero) lo -= pad;
  hi += pad;
  const n = Math.max(labels.length, 2);
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR), y = (v) => base - ((v - lo) / (hi - lo)) * h;
  const out = [`<rect width="${W}" height="${H}" fill="#ffffff"/>`];
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    out.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/><text x="${padL - 5}" y="${y(v) + 3}" font-size="9" fill="#6b7280" text-anchor="end">${_n(v, dp)}</text>`);
  }
  out.push(`<text x="4" y="${top - 7}" font-size="9" font-weight="700" fill="#374151">${_x(unit)}</text>`);
  if (band?.length) {
    out.push(`<polygon points="${band.map((b) => `${x(b.i).toFixed(1)},${y(b.hi).toFixed(1)}`).join(" ")} ${band.slice().reverse().map((b) => `${x(b.i).toFixed(1)},${y(b.lo).toFixed(1)}`).join(" ")}" fill="#f59e0b" opacity="0.25"/>`);
    out.push(`<line x1="${x(band[0].i)}" x2="${x(band[0].i)}" y1="${top}" y2="${base}" stroke="#9ca3af" stroke-dasharray="3 3"/><text x="${x(band[0].i) - 4}" y="${top + 9}" font-size="9" fill="#6b7280" text-anchor="end">forecast starts</text>`);
  }
  for (const r of refs) if (Number.isFinite(r.v)) out.push(`<line x1="${padL}" x2="${W - padR}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="${r.color}" stroke-dasharray="5 3" stroke-width="1.4"/><text x="${padL + 4}" y="${y(r.v) - 3}" font-size="9" font-weight="700" fill="${r.color}">${_x(r.label)}</text>`);
  for (const s of series) {
    const pts = s.values.map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : null)).filter(Boolean);
    out.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.2"${s.dashed ? ' stroke-dasharray="5 3"' : ""}/>`);
  }
  const every = Math.max(1, Math.ceil(labels.length / 9));
  labels.forEach((l, i) => {
    if (i % every && i !== labels.length - 1) return;
    if (i !== labels.length - 1 && labels.length - 1 - i < every * 0.7) return;
    out.push(`<text x="${x(i)}" y="${base + 13}" font-size="9" fill="#374151" text-anchor="${i === labels.length - 1 ? "end" : i === 0 ? "start" : "middle"}">${_x(l)}</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${_x(aria)}">${out.join("")}</svg>`;
}

export function columns(rows, { unit = "", color = "#2563eb", h = 130, dp = 0, aria = "chart" } = {}) {
  const padL = 40, top = 20, base = top + h, H = base + 20;
  const max = Math.max(...rows.map((r) => r.v).filter(Number.isFinite), 1) * 1.1;
  const cw = (W - padL - 8) / Math.max(rows.length, 1);
  const out = [`<rect width="${W}" height="${H}" fill="#ffffff"/><line x1="${padL}" x2="${W - 8}" y1="${base}" y2="${base}" stroke="#111827"/><text x="4" y="11" font-size="9" font-weight="700" fill="#374151">${_x(unit)}</text>`];
  rows.forEach((r, i) => {
    const cx = padL + (i + 0.5) * cw, w = Math.min(44, cw * 0.62);
    out.push(`<text x="${cx}" y="${base + 13}" font-size="9" fill="#374151" text-anchor="middle">${_x(r.label)}</text>`);
    if (!Number.isFinite(r.v)) return;
    const t = base - (r.v / max) * h;
    out.push(`<rect x="${cx - w / 2}" y="${t}" width="${w}" height="${Math.max(1, base - t)}" rx="2" fill="${r.color || color}"/><text x="${cx}" y="${t - 4}" font-size="9.5" font-weight="700" fill="#111827" text-anchor="middle">${_n(r.v, dp)}</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${_x(aria)}">${out.join("")}</svg>`;
}

// ---- report ------------------------------------------------------------------
export function foodReportMeta(d) {
  const e = d.ews;
  return {
    title: "National Food Security & Agriculture Watch",
    subtitle: "Early warning and decision support: where pressure is building, why, and what to do",
    strip: [
      { label: "Issued", value: new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
      { label: "Prices to", value: _month(e.periods?.prices) },
      { label: "Rain, soil, crops to", value: _month(e.periods?.eo?.rain) },
      { label: "Reference", value: `NDMA/NCOP/FSW/${new Date().toISOString().slice(0, 10).replace(/-/g, "")} · issue ${e.issue?.number ?? 1}${e.issue?.revisions ? ` rev ${e.issue.revisions}` : ""} · ${e.issue?.id || ""}` },
    ],
    glossary: [
      { term: "Watch, Warning, Alert", def: "The warning levels of this report. Watch: early signs. Warning: several pressures at once. Alert: severe pressure. They are NCOP's own overlay, not an IPC classification." },
      { term: "IPC", def: "Integrated Food Security Phase Classification: the international hunger scale, from Phase 1 (Minimal) to Phase 5 (Famine)." },
      { term: "Phase 3 or worse (Crisis+)", def: "People who can only eat enough by skipping meals or selling what they own, or who already go short. They need help." },
      { term: "FEWS NET", def: "Famine Early Warning Systems Network. It classifies whole districts on the same 1 to 5 scale. This is a forecast by analysts, not a head count." },
      { term: "Observed, Survey, Modelled, Forecast", def: "Observed: measured or recorded. Survey: asked of a sample of families. Modelled: worked out by a model or by satellite. Forecast: about the future." },
      { term: "SPI (rain index)", def: "Compares rain with the same months of other years. 0 is usual. Below −1 is dry, below −1.5 very dry, below −2 extremely dry." },
      { term: "Soil-moisture percentile", def: "Where this month ranks among the same month of other years. 5 means drier than about 95 years in 100." },
      { term: "VCI (crop greenness)", def: "0 is the weakest and 100 the greenest the crops have looked in this month over the last 15 years." },
      { term: "Canal water (IRSA)", def: "Share of river water released for farming. Most of Punjab and Sindh depend on it more than on local rain." },
      { term: "Flour for a day's wage", def: "Kilograms of wheat flour an unskilled worker's daily pay can buy. When it falls, families can afford less food." },
      { term: "Stock cover", def: "How many days the wheat left in store at the end of the season would feed the country." },
      { term: "Harvest year, marketing year", def: "Harvest year: when the crop was cut. USDA's marketing year 2026/27 is the wheat cut in spring 2026. PBS calls the same crop 2025–26." },
      { term: "Rabi, Kharif", def: "Winter crops (wheat, cut April–May) and summer crops (rice, cotton, maize)." },
      { term: "Acute malnutrition", def: "A child is too thin for their height. The severe form can be deadly." },
      { term: "El Niño", def: "Unusually warm water in the Pacific that changes weather around the world." },
      { term: "False alarm, missed event", def: "A warning with nothing after it; an event with no warning before it." },
    ],
    footer: "Sources are numbered in the text and listed in full at the end. Warning levels are an analytical overlay by NCOP, not an IPC classification.",
  };
}

/**
 * d      digest (/api/foodsec/watch/)
 * shots  {1: [{src, caption}], 2: [...]} the story's own map captures
 * null when the digest has no early-warning block (the caller falls back).
 */
export function foodReportSections(d, { shots = {} } = {}) {
  const H = ewsHeadline(d);
  if (!H) return null;
  const { e, n, lv, wp, pk, rows } = H;
  const order = [];
  const cite = (...keys) => `[${keys.map((k) => { if (!order.includes(k)) order.push(k); return order.indexOf(k) + 1; }).join(", ")}]`;
  const news = (id) => (e.register || []).find((r) => r.id === id);
  const told = (id) => { const r = news(id); return r ? `${r.text} [${r.type}, as of ${_date(r.as_of)}${r.state === "current" ? "" : "; out of date"}] ${cite(...[].concat(r.ref))}` : ""; };
  const out = [];
  const eoM = _month(e.periods?.eo?.rain), prM = _month(e.periods?.prices);
  const ipc = e.ipc, po = e.price_outlook, bt = e.backtest;
  const byName = new Map(rows.map((r) => [r.name, r]));
  const hies = e.household?.hies;

  // ------------------------------------------------------------------ page 1
  const ch = e.changes || {};
  const changed = [
    ch.raised_n ? `${_plural(ch.raised_n, "district")} moved up a level (${_join(ch.raised.slice(0, 4))}${ch.raised_n > 4 ? " and others" : ""})` : "no district moved up a level",
    ch.lowered_n ? `${_plural(ch.lowered_n, "district")} moved down` : "none moved down",
    Number.isFinite(ch.flour_m1_pct) ? `flour ${ch.flour_m1_pct >= 0 ? "rose" : "fell"} ${_n(Math.abs(ch.flour_m1_pct), 1)}% in the month` : null,
  ].filter(Boolean);
  const stale = (e.health || []).filter((h) => h.state !== "current");
  out.push({ glance: {
    heading: "The situation in one page",
    banner: { unit: "DISTRICTS", value: String(wp.districts), label: "Warning or Alert", color: lv.color,
      title: `National level: ${lv.label} (${lv.say})`,
      text: `${H.line} ${H.alert.length ? `Alert: ${_join(H.alertText)}. ` : ""}${H.warnText.length ? `Warning: ${_join(H.warnText)}. ` : ""}Modelled from prices to ${prM}, satellite data to ${eoM} and the FEWS NET outlook.` },
    level: { label: lv.label, color: lv.color, steps: LEVELS.map((l, i) => ({ label: `${l.label} (${n.count[i] ?? 0})`, color: l.color, on: i === n.level })) },
    levelLabel: "National level today (number of districts in brackets)",
    levelNote: `The national word is only a headline: Warning when a quarter of people live in Warning or Alert districts. Thresholds are starting values, not yet agreed with provinces. Not an IPC classification.`,
    kpis: [
      { value: millions(wp.people), label: "people live in Warning or Alert districts [Modelled]" },
      { value: `${H.crisisNow} → ${H.crisisNext}`, label: "districts in Crisis: now → to January 2027 (FEWS NET) [Modelled, Forecast]" },
      Number.isFinite(pk.kg) ? { value: `${_n(pk.kg, 1)} kg`, label: `flour a day's wage buys; 5-year average ${_n(pk.kg_avg5, 1)} kg [Observed, ${_mon(e.periods?.prices)}]` } : null,
      Number.isFinite(pk.flour_y1) ? { value: _sg(pk.flour_y1), label: `wheat flour price in one year (Rs ${_n(pk.flour)} a kg) [Observed]` } : null,
    ].filter(Boolean),
    advice: { tag: "WHAT CHANGED", text: `Since last month: ${changed.join("; ")}.${e.issue?.previous ? ` Previous issue ${_date(e.issue.previous.at)}.` : ""}` },
    howToRead: false,
  } });
  out.push({ subheading: "Priority actions", table: { head: ["#", "Action", "Who", "By when"], rows: (e.actions || []).slice(0, 4).map((a, i) => [String(i + 1), `${a.title}. ${a.text}`, a.owner, a.by]) } });
  out.push({ subheading: "How fresh is the data?", body: `${(e.health || []).length - stale.length} of ${(e.health || []).length} sources are current.${stale.length ? ` Not current: ${_join(stale.map((h) => `${h.name.split(":")[0]} (${h.state}${h.period ? `, ${h.period}` : ""})`))}. They are shown with their date and not used for today's level.` : ""} Full list in chapter 5.` });

  const rk = e.rankings || {};
  if (rk.burden?.length) {
    const now = (a) => { const r = byName.get(a.name) || [...byName.values()].find((v) => v.name.toLowerCase() === a.name.toLowerCase()); return r ? _cell(r.level) : "-"; };
    out.push({ subheading: "Two rankings: where most people are, and where hunger is most intense" });
    const row = (a, i) => [String(i + 1), `${a.name} (${a.group})`, _n(a.p3plus), _pc(a.p3plus_pct), _phase(a.phase), now(a)];
    const head = ["#", "District", "People in Crisis+", "Share", "Phase", "Level today"];
    out.push({ table: { title: `Where the MOST PEOPLE are in Crisis or worse (IPC projection to ${_date(ipc?.valid_to)}) [Modelled]`, head, rows: rk.burden.slice(0, 6).map(row) } });
    out.push({ table: { title: `Where the SHARE of people is HIGHEST (same projection) [Modelled]`, head, rows: rk.prevalence.slice(0, 6).map(row) } });
    out.push({ body: "The first list shows where the largest programmes are needed; the second shows where hunger is most intense, often in small, remote districts. Both matter." });
  }
  // --------------------------------------------------------------- chapter 1
  out.push({ chapter: { n: 1, name: "Warning Level and Hunger", flow: true } });
  out.push({ callout: { tag: "HOW TO READ", text: "Tags in square brackets say what kind of number it is: [Observed] measured, [Survey] asked of families, [Modelled] estimated, [Forecast] about the future. Numbers in brackets such as [1] are references at the end." } });
  for (const s of shots[1] || []) out.push({ image: s });
  out.push({ subheading: "Where pressure is building", body: `Each district is scored from 0 (normal) to 3 (alert) on four things: hunger, food prices and wages, water and crops, and shocks. Warning needs two of them at 2 or more. Alert needs one at 3 with at least medium confidence, or two at 3. A level only comes down after two calm months. Thresholds come from the NCOP guide ${cite("guide")}.` });
  out.push(_chart(levelBars(e.provinces || []), "Districts at each level, by province [Modelled]", "green Normal · yellow Watch · orange Warning · red Alert"));
  const concern = concernList(e, 10);
  if (concern.length) {
    out.push({ table: { title: "Districts of most concern. 0 normal, 1 watch, 2 warning, 3 alert; \"-\" no data.", head: ["District", "Level", "Hunger", "Prices", "Water", "Shocks", "Main reasons", "Confidence"],
      rows: concern.map((r) => [r.members > 1 ? r.name : `${r.name} (${prettyProvince(r.province)})`, _cell(r.level), ...["hunger", "market", "water", "shocks"].map((k) => { const p = r.pillars[k]; return p ? { t: String(p[0]), bg: _lv(p[0]).color } : "-"; }), districtReason(r), r.confidence]) } });
  }
  const nConf = n.confidence || {};
  out.push({ body: `${H.karachiOnly ? `Karachi's districts are at Alert because of prices alone: flour there rose ${_n(e.market?.Sindh?.flour_m3, 0)}% in three months, and hunger itself is classed low. ` : ""}Confidence is Low for ${nConf.Low || 0} of the ${wp.districts} Warning and Alert districts. The main reason is that only five cities report prices, so one city stands for a whole province. Confirm on the ground before acting.` });

  // hunger: outcomes
  out.push({ subheading: "Outcome: how many people are hungry?", body: !ipc?.lines?.length ? "The IPC data could not be read for this issue." : `The last official count for Pakistan (IPC) has two parts with different dates. They should not be merged into one headline. Both projections ended on ${_date(ipc?.valid_to)}, and no newer IPC analysis has been published, so treat them as the last known count, not as today's.` });
  if (ipc?.lines?.length) {
    const per = (p) => (p ? `${_date(p.from, { day: "numeric", month: "short" })} – ${_date(p.to)}` : "n/a");
    out.push({ table: { title: "People in Crisis or worse (IPC Phase 3+) [Modelled]", head: ["Analysis", "People analysed", "Then (current)", "Period", "Projected", "Period", "Of which Emergency"],
      rows: ipc.lines.map((l, i) => [`${l.label} ${cite(i ? "ipcPun" : "ipcDec")}`, millions(l.current?.pop), `${millions(l.current?.p3plus, 2)} (${_pc(l.current?.p3plus_pct)})`, per(l.periods.current), `${millions(l.projected?.p3plus, 2)} (${_pc(l.projected?.p3plus_pct)})`, per(l.periods.projected), millions(l.projected?.p4, 2)]) } });
    if (ipc.lines.length > 1) out.push({ body: `The earlier report's single figure of ${millions(ipc.sum_projected)} is these two projections added together. The IPC platform stores that sum, but the parts come from two separate analyses. Coverage is ${ipc.districts} districts, not the whole country. IPC gives each district's shares in steps of 5%, so many districts show exactly 20% or 25%: that is the method, not an error ${cite("ipcManual")}.` });
  }
  const fp = e.periods?.fews || {};
  out.push({ body: `The newest independent view is FEWS NET's October 2026 outlook. It classes whole districts and does not count people. ${H.crisisNow} districts are in Crisis now; ${H.crisisNext} are expected to be in Crisis ${fp.next ? `between ${_date(fp.next[0], { month: "long", year: "numeric" })} and ${_date(fp.next[1], { month: "long", year: "numeric" })}` : "in the next months"} [Modelled, Forecast] ${cite("fewsData")}. ${told("needs2026")} This is a different measure from the IPC count (people who will need help, whole country), so the two numbers should not be compared directly.` });
  const hist = (ipc?.history || []).filter((x) => x.kind === "current").slice().reverse();
  if (hist.length > 3) {
    out.push(_chart(columns(hist.map((x) => ({ label: `${x.from.slice(0, 7)} (${x.areas})`, v: 100 * x.p3plus_pct })).slice(-8), { unit: "% of people analysed", color: "#E67800", aria: "IPC share" }),
      `Share of people in Crisis or worse in each IPC analysis (number of districts in brackets) [Modelled] ${cite("ipcAll")}`, "Each analysis covers different districts, so the bars show broad change only."));
  }

  // nutrition & households
  out.push({ subheading: "Nutrition and household vulnerability" });
  const diet = e.household?.diet || {}, dy = Object.keys(diet).sort().pop(), dv = diet[dy] || {};
  const und = e.household?.undernourished || {}, uy = Object.keys(und).sort().pop();
  out.push({ kpis: [
    hies ? { value: `${_n(hies.moderate_or_severe, 1)}%`, label: `of households were moderately or severely food insecure, ${hies.year} (${_n(hies.prev_moderate_or_severe, 1)}% in ${hies.prev_year}) [Survey]` } : null,
    hies ? { value: `${_n(hies.severe, 1)}%`, label: `severely food insecure (${_n(hies.prev_severe, 1)}% in ${hies.prev_year}) [Survey]` } : null,
    dy ? { value: `${_n(dv.cannot_afford_pct)}%`, label: `could not afford a healthy diet, ${dy} (Rs ${_n(dv.cost_pkr_day)} a person a day) [Modelled]` } : null,
    uy ? { value: `${_n(und[uy], 1)}%`, label: `undernourished, ${uy} (3-year average) [Modelled]` } : null,
  ].filter(Boolean) });
  if (hies) {
    const pov = e.household?.poverty || {};
    out.push({ table: { title: `Who is struggling? Households food insecure (PBS survey ${hies.year}) and poor (2017–18) [Survey]`, head: ["Province", "Food insecure", "Poor (many-sided poverty)"],
      rows: Object.entries(hies.provinces).map(([p, v]) => [p, `${_n(v, 1)}%`, pov[p] ? `${_n(pov[p].mpi_poor_pct)}%` : "n/a"]) } });
    out.push({ body: `Poorest fifth of families: ${_n(hies.poorest, 0)}% food insecure; richest fifth: ${_n(hies.richest, 0)}%. Villages ${_n(hies.rural, 0)}%, towns ${_n(hies.urban, 0)}% ${cite("hies", "ophi")}. Healthy-diet cost and undernourishment: ${cite("diet", "sofi")}. These change slowly, so they show who is vulnerable but do not set today's level.` });
  }
  out.push({ body: `Child malnutrition: ${told("malnutrition2026")} No open district data on child malnutrition are available now, so nutrition is NOT scored. This is the biggest gap in the picture.` });

  // --------------------------------------------------------------- chapter 2
  out.push({ chapter: { n: 2, name: "Harvests and Supply", flow: true } });
  for (const s of shots[2] || []) out.push({ image: s });
  const wr = e.supply?.wheat?.rows || [], wl = wr[wr.length - 1];
  if (wl) {
    const best = wr.reduce((a, b) => (b.cover_days > a.cover_days ? b : a));
    out.push({ subheading: "Is there enough wheat?", body: `For the crop cut in spring ${wl.harvest_year} (USDA year ${wl.marketing_year}), USDA puts production at ${_n(wl.production / 1000, 1)} million tonnes against use of ${_n(wl.use / 1000, 1)}. With imports of ${_n((wl.imports || 0) / 1000, 1)}, stores would end the season at ${_n(wl.end_stocks / 1000, 1)} million tonnes: about ${wl.cover_days} days of food, against ${best.cover_days} days at the best point of the last ${wr.length} years (${best.marketing_year}) [Modelled, ${_month(e.supply.wheat.release)}] ${cite("psd")}.` });
    out.push(_chart(columns(wr.map((r) => ({ label: r.marketing_year, v: r.cover_days, color: r === wl ? "#E67800" : "#64748b" })), { unit: "days of use in store at season end", aria: "Wheat stock cover" }),
      "Wheat stock cover [Modelled, USDA]", "season label = USDA marketing year; orange = current season"));
    out.push({ body: `The 2026 harvest is disputed. ${told("harvest2026")} Read it as a range of about 26 to 29 million tonnes until PBS publishes a final count.` });
  }
  const st = d.crops?.staples || [];
  if (st.length) {
    out.push({ table: { title: `Official harvests: the latest crop year published by PBS is ${d.crops.latest_year} [Observed] ${cite("pbs")}`, head: ["Crop", "PBS crop year", "Cut in", "Production", "On the year before", "Against 5-year average"],
      rows: st.map((s) => [s.name, s.source_crop_label || s.latest.year, s.harvest || "n/a", `${_n(s.latest.production / 1000, 2)} million ${s.unit === "000 bales" ? "bales" : "tonnes"}`, _sg(s.change_pct, 1), _sg(s.vs_avg5_pct, 1)]) } });
    out.push({ body: `These are last season's crops. The wheat in this table was cut in ${st.find((s) => s.name === "Wheat")?.harvest || "spring 2025"}, not in spring 2026.` });
  }
  const wd = e.supply?.world;
  if (wd) {
    const nm = { wheat_hrw: "Wheat (US hard winter)", rice_thai5: "Rice (Thai 5%)", palm_oil: "Palm oil", urea: "Urea", dap: "DAP fertiliser" };
    out.push({ table: { title: `World prices, US dollars a tonne, ${_month(wd.palm_oil?.month)} [Observed] ${cite("pink")}`, head: ["Item", "Price", "3 months", "1 year"],
      rows: Object.entries(nm).filter(([k]) => wd[k]).map(([k, v]) => [v, _n(wd[k].value), _sg(wd[k].m3_pct), _sg(wd[k].y1_pct)]) } });
    if (Number.isFinite(e.supply.world_wheat_pkr_kg)) out.push({ body: `At Rs ${_n(e.supply.pkr_per_usd, 0)} to the dollar ${cite("fx")}, US wheat costs about Rs ${_n(e.supply.world_wheat_pkr_kg)} a kg at the port of origin, before shipping, insurance, duty and handling. Wheat in Pakistan's five cities averages Rs ${_n(d.prices?.items?.find((i) => i.commodity === "Wheat")?.latest)} a kg. The gap shows room for imports, but it is not a landed price. ${told("imports2026")}` });
  }

  // --------------------------------------------------------------- chapter 3
  out.push({ chapter: { n: 3, name: "Prices and What Wages Buy", flow: true } });
  const ms = d.prices?.terms_of_trade;
  if (!Number.isFinite(pk.kg)) out.push({ body: "Market prices could not be read for this issue, so this chapter is left short rather than estimated." });
  else out.push({ subheading: "Can families afford flour?", body: `A day's unskilled wage now buys ${_n(pk.kg, 1)} kg of flour, against a five-year average of ${_n(pk.kg_avg5, 1)} kg for this month (${_sg(pk.kg_wage)}) [Observed, five cities, ${prM}] ${cite("wfp")}.` });
  if (ms?.series?.length) out.push(_chart(lineChart({ series: [{ color: "#2563eb", values: ms.series.map((s) => s.kg) }], labels: ms.series.map((s) => _mon(s.month)), refs: [{ v: ms.avg5_same_month, label: "5-year average for this month", color: "#16a34a" }], unit: "kg of flour for a day's wage", dp: 1, aria: "Flour per daily wage" }), "How much flour a day's wage buys [Observed]", "average of five cities"));
  const mp = Object.entries(e.market || {}).filter(([k]) => k !== "Pakistan");
  if (mp.length) {
    const tone = (ind, v) => { const t = e.thresholds?.[ind]; if (!t || !Number.isFinite(v)) return "n/a"; const s = t.cuts.filter((c) => (t.way === "up" ? v >= c : v <= c)).length; return { t: _sg(v, ind === "spread" ? 0 : 1), bg: s ? _lv(s).color : "#ffffff" }; };
    out.push({ table: { title: `By province, from its WFP city market(s), ${prM} [Observed]`, head: ["Province (city)", "Flour, Rs/kg", "3 months", "1 year", "kg for a day's wage", "Against 5-yr average", "Level (0–3)"],
      rows: mp.map(([p, m]) => { const s = e.market_scores?.[p]; return [`${p} (${{ Punjab: "Lahore, Multan", Sindh: "Karachi", "Khyber Pakhtunkhwa": "Peshawar", Balochistan: "Quetta" }[p] || ""})`, _n(m.flour), tone("flour_m3", m.flour_m3), _sg(m.flour_y1, 1), _n(m.kg, 1), tone("kg_wage", m.kg_wage), s ? { t: `${s.score}${s.stale_wage ? "*" : ""}`, bg: _lv(s.score).color } : "-"]; }) } });
    out.push({ body: "Colours follow the thresholds in chapter 5. * The reported daily wage in this province's city has not changed for a year or more, so the wage result there is uncertain." });
  }
  const up = (d.prices?.items || []).filter((i) => Number.isFinite(i.yoy_pct) && !/^Wage/.test(i.commodity)).sort((a, b) => b.yoy_pct - a.yoy_pct);
  if (up.length) out.push({ table: { title: `What else changed in one year, ${prM} [Observed]`, head: ["Item", "Price now", "1 year", "3 months"], rows: up.slice(0, 9).map((i) => [i.commodity, `Rs ${_n(i.latest)} / ${String(i.unit).split("/")[1]}`, _sg(i.yoy_pct, 1), _sg(i.m3_pct, 1)]) } });
  if (po) {
    const hs = (d.prices?.items?.find((i) => i.commodity === po.item)?.series || []).slice(-18);
    const lab = [...hs.map((s) => _mon(s.month)), ...po.path.map((p) => _mon(p.month))];
    const i0 = hs.length - 1;
    const last = po.path[po.path.length - 1], used = po.skill.find((s) => s.model === "chosen"), old = po.skill.find((s) => s.model === "seasonal");
    out.push({ subheading: "Where could the flour price go?", body: `The central estimate is Rs ${_n(po.path[0].mid)} a kg in ${_month(po.path[0].month)} and Rs ${_n(last.mid)} by ${_month(last.month)}. The likely range for ${_month(last.month)} is Rs ${_n(last.lo)} to Rs ${_n(last.hi)} [Forecast]. It is a possible range, not a guaranteed price. A stock release, new imports or a bad sowing season would change it.` });
    out.push(_chart(lineChart({ series: [{ color: "#111827", values: [...hs.map((s) => s.price), ...po.path.map(() => NaN)] }, { color: "#b45309", dashed: true, values: [...hs.map((s, i) => (i === i0 ? s.price : NaN)), ...po.path.map((p) => p.mid)] }],
      labels: lab, band: [{ i: i0, lo: hs[i0]?.price, hi: hs[i0]?.price }, ...po.path.map((p, k) => ({ i: i0 + 1 + k, lo: p.lo, hi: p.hi }))], unit: "Rs per kg", aria: "Flour outlook" }), "Wheat flour: prices and outlook [Observed, then Forecast]", "black = observed five-city mean · dashed = central estimate · shaded = likely range"));
    out.push({ table: { title: `How good is this forecast? Tested on ${po.origins} months since ${_month(po.test_from)}, using only what was known at the time`, head: ["Method", "Typical error", "1 month ahead", "3 months ahead", "Real price fell inside the range (aim 80%)", "Range error (pinball)"],
      rows: po.skill.map((s) => [MODEL_NAME[s.model] + (s.used ? " (picked now)" : ""), `${_n(s.mape, 1)}%`, `${_n(s.by_horizon?.["1"], 1)}%`, `${_n(s.by_horizon?.["3"], 1)}%`, `${_n(s.coverage80)}%`, _n(s.pinball, 2)]) } });
    out.push({ body: `In plain words: one month ahead the forecast has typically been about ${_n(used?.by_horizon?.["1"])}% off, three months ahead about ${_n(used?.by_horizon?.["3"])}%. The old seasonal method was ${_n(old?.by_horizon?.["3"])}% off at three months. Real prices landed inside the range ${_n(used?.coverage80)}% of the time, less often than the 80% intended, so surprises are more common than the range suggests.` });
  }
  if (d.prices) out.push({ body: "Other items (rice, oil, sugar, milk) keep the simple seasonal guide in the briefing and have not been tested in the same way." });

  // --------------------------------------------------------------- chapter 4
  out.push({ chapter: { n: 4, name: "Weather, Water and Shocks: the Months Ahead", flow: true } });
  const w = e.water || {};
  const wp0 = (w.provinces || []).filter((p) => p.province !== "Federal Capital");
  if (wp0.length) {
    out.push({ subheading: "Was there enough rain, and is there water?", body: `${told("monsoon2026")} The table below is an independent satellite check.` });
    out.push({ table: { title: `Monsoon ${wp0[0].monsoon_year} (June–September) and conditions in ${eoM} [Modelled, satellite] ${cite("chirps", "fldas", "modis")}`, head: ["Province", "Monsoon rain", "Against 1991–2020", "Rank (1 = driest)", "Rain index, 6 months", "Soil moisture percentile", "Crop greenness (0–100)"],
      rows: wp0.map((p) => [prettyProvince(p.province), `${_n(p.monsoon_mm)} mm`, _sg(p.monsoon_pct), `${p.dry_rank} of ${p.years}`, _n(p.spi6, 1), _n(p.soil_pct), _n(p.vci)]) } });
    const si = wp0.find((p) => p.province === "Sindh"), ba = wp0.find((p) => p.province === "Balochistan");
    if (si) out.push({ body: `Satellites agree with the rain gauges that Sindh was dry (${_sg(si.monsoon_pct)}; gauges −51%)${ba ? ` and Balochistan too (${_sg(ba.monsoon_pct)}; gauges −34%)` : ""}. But such dry monsoons are not rare there: for Sindh it ranks ${si.dry_rank} of ${si.years}, and the rain index (${_n(si.spi6, 1)}) is "dry", not "extreme". Soil and crops do not yet show severe stress in most districts. The bigger risk for wheat is canal water. Rain index method: ${cite("spi")}; greenness: ${cite("vcipaper")}.` });
  }
  const res = w.reservoirs;
  if (w.canal_pct != null) out.push({ callout: { tag: "CANAL WATER", text: `${told("irsa2026")}${res ? ` Reservoirs on ${res.recorded}: ${_join(res.dams.map((x) => `${x.name} ${_n(x.level_ft, 0)} ft, ${x.range_pct}% of the way from its lowest to its full level`))} [Observed] ${cite("ffd")}. Level is not the same as volume.` : ""}` } });
  if (w.enso) out.push({ body: `El Niño: the index for ${w.enso.season} is ${w.enso.oni > 0 ? "+" : ""}${_n(w.enso.oni, 2)} °C, a ${w.enso.strength || ""} ${w.enso.state} [Observed] ${cite("enso")}. For Pakistan, El Niño does not mean a dry winter: FEWS NET notes that it tends to bring above-average October–April rain and snow ${cite("fewsElnino")}. ${told("winter2026")}` });
  const ow = d.outlook?.weather;
  if (ow?.provinces?.length) {
    const main = ow.provinces.filter((p) => ["Punjab", "Sindh", "Khyber Pakhtunkhwa", "Balochistan"].includes(p.province));
    out.push({ table: { title: `Next ${ow.days} days, ${_date(ow.from)} to ${_date(ow.to)} [Forecast] ${cite("gefs")}`, head: ["Province", "Rain expected", "Usual for these days", "Temperature", "Usual"],
      rows: main.map((p) => [p.province, `${_n(p.rain_mm)} mm`, `${_n(p.rain_normal_mm)} mm`, `${_n(p.temp_c, 1)} °C`, `${_n(p.temp_normal_c, 1)} °C`]) } });
  }
  const cal = d.outlook?.calendar;
  if (cal) out.push({ table: { title: `In the fields: usual crop stages, ${d.outlook.months.join(", ")} ${cite("giews")}`, head: ["Crop", ...d.outlook.months], rows: cal.map((c) => [c.crop, ...c.stages.map((s) => s || "-")]) } });

  out.push({ subheading: "Shocks and trade" });
  const cf = e.shocks?.conflict, dp = e.shocks?.displacement;
  out.push({ cards: [
    cf ? { title: "Conflict [Observed]", text: `${_n(cf.events)} political-violence events and ${_n(cf.fatalities)} deaths were recorded in ${_month(cf.month)}; the average of the 12 months before was ${_n(cf.avg12)} events. Open data are national only, so districts are not scored on conflict.`, source: cite("acled") } : null,
    dp ? { title: "People forced to move [Modelled]", text: `${Object.entries(dp.by_year).map(([y, v]) => `${y}: ${_join(Object.entries(v).map(([k, c]) => `${_n(c)} by ${k.toLowerCase()}`))}`).join("; ")}. Data to ${_date(dp.through)}; years may be partial.`, source: cite("idmc") }
       : { title: "People forced to move", text: "The displacement feed could not be read for this issue, so this is left empty.", source: "" },
    news("border2026") ? { title: "Closed border", text: told("border2026"), source: "" } : null,
    news("fertiliser2026") ? { title: "Dearer fertiliser", text: told("fertiliser2026"), source: "" } : null,
  ].filter(Boolean) });
  out.push({ table: { title: "How one problem leads to another: what to watch on each path", head: ["Path", "Early signs", "Result", "Where it stands"], rows: [
    ["Weak monsoon → less canal water → smaller wheat crop", "Rain index, soil, reservoirs, canal share", "Harvest, flour price", w.canal_pct != null ? `ACTIVE: canal water ${_sg(w.canal_pct)}` : "Watch"],
    ["Low stocks → dearer flour → fewer meals → malnutrition", "Stock cover, imports, flour against wheat", "Wage buys less flour, hunger", wl ? `ACTIVE: ${wl.cover_days} days in store; flour ${_sg(pk.flour_y1)} in a year` : "Watch"],
    ["Flood → lost crops and stored grain → local price jump", "River flow, heavy rain", "Local prices, displacement", `${rows.filter((r) => (r.spi1 ?? -9) >= 1.5).length} districts with unusually heavy rain last month`],
    ["Closed border or conflict → lost work and trade", "Events, crossings", "Prices in KP and Balochistan", "ACTIVE: border closed"],
    ["Weaker rupee or dearer fuel → higher food costs", "Rupee rate, diesel, fertiliser", "Prices, area sown", (() => { const ds = d.prices?.items?.find((i) => i.commodity === "Fuel (diesel)"); return ds ? `Diesel ${_sg(ds.yoy_pct)} in a year` : "Watch"; })()],
  ] } });

  // --------------------------------------------------------------- chapter 5
  out.push({ chapter: { n: 5, name: "What to Do, and How Far to Trust This", flow: true } });
  const MX = [["Normal", "Routine", "Watch monthly.", "NCOP analysts"], ["Watch", "8 to 12 weeks", "Check the data; brief provincial food and agriculture departments; update plans.", "NCOP, PDMAs"],
    ["Warning", "4 to 8 weeks", "Joint field check; get food and cash ready; act on prices and markets; screen children for malnutrition.", "PDMAs, provincial food departments, BISP, WFP, UNICEF, FAO"],
    ["Alert", "0 to 4 weeks", "Release public stocks; scale up cash or food aid; emergency nutrition care; follow daily.", "NDMA/NEOC, provincial governments, partners"]];
  out.push({ subheading: "What each level means for action", table: { title: `Proposed actions and owners (to be agreed with provinces and the Finance Division) ${cite("guide")}`, head: ["Level", "Time to act", "Actions", "Who"], rows: MX.map((r, i) => [_cell(i), ...r.slice(1)]) } });
  const pres = rows.filter((r) => r.level >= 2 && r.presence);
  out.push({ body: `Help already on the ground: in ${pres.length} of the ${wp.districts} Warning and Alert districts, at least one organisation reported food or nutrition work in January–July 2025 [Observed, out of date] ${cite("w3")}. No open data were found on public wheat stocks by province or on BISP coverage by district.` });
  out.push({ table: { title: "Risk calendar", head: ["When", "Typical risk", "What to watch", ""], rows: (e.calendar || []).map((c) => [c.window, c.risk, c.watch, c.now ? { t: "NOW", bg: "#E7B416" } : ""]) } });

  if (bt) {
    const m = bt.market, kinds = { wet: "Heavy rain", dry: "Dry conditions", market: "Prices", quiet: "Prices" };
    out.push({ subheading: "Would this system have warned us before?", body: `The rules were replayed month by month from ${_month(bt.from)} to ${_month(bt.to)}. Honest result: it helps, but it misses things and raises false alarms.` });
    out.push({ table: { title: "Six past events [tested on past data]", head: ["Event", "Signal used", "First Warning signal", "Result"], rows: bt.episodes.map((x) => {
      const L = x.known_lead_months;
      let t;
      if (x.kind === "quiet") t = x.first_signal ? "FALSE ALARM: prices were falling, but wages still bought less than the 5-year average" : "Correctly quiet";
      else if (!x.first_signal) t = x.watch_share != null ? `No Warning. ${_pc(x.watch_share)} of districts reached Watch` : "MISSED";
      else if (x.kind === "wet") t = "Seen only as it happened (monthly rain is known after the month ends); a river-flow forecast is needed to warn earlier";
      else t = L > 0 ? `Warned at least ${L} months before the peak` : "Seen only once prices had already jumped";
      return [x.label, kinds[x.kind], x.first_signal ? _month(x.first_signal) : "none", t];
    }) } });
    out.push({ table: { title: `Did flour rise 10% or more within 3 months? (${m.warning.months} months; it did after ${m.warning.surges}, or ${_pc(m.warning.base_rate)})`, head: ["Signal", "Times raised", "Followed by a surge", "False alarms", "Surges missed", "Right when raised"],
      rows: [["Watch or higher", m.watch], ["Warning or higher", m.warning], ["Alert", m.alert], ["Flour 3-month rise alone, 10%+", m.flour_m3_only]].map(([k, v]) => [k, _n(v.warned), _n(v.hits), _n(v.false_alarms), `${v.missed} of ${v.surges}`, _pc(v.precision)]) } });
    out.push({ body: `In plain words: after a price Warning, a surge followed about ${Math.round((m.warning.precision || 0) * 10)} times in 10, against ${_n((m.warning.base_rate || 0) * 10, 1)} in 10 in any month. It missed ${m.warning.missed} of ${m.warning.surges} surges. One indicator in the guide, the price z-score, was above its Watch line in ${_pc(m.z_on_share)} of months because general inflation lifts it, so it is calculated but not used. The thresholds have not been tuned on these events.` });
  }
  const issues = e.issues || [];
  out.push({ subheading: "Data checks in this issue", table: { head: ["Check", "Finding", "What was done"], rows: issues.map((i) => [{ stale: "Unchanged value", outlier: "Unusual value", cross: "Second source", expired: "Expired", missing: "Missing", failed: "Download failed", sum: "Totals", unit: "Units" }[i.kind] || i.kind, i.text, i.action]) } });
  out.push({ table: { title: "Source health", head: ["Source", "Type", "Period", "Read on", "State", "Licence"], rows: (e.health || []).map((h) => [h.name, h.type, h.period || "n/a", h.retrieved ? _date(h.retrieved) : "n/a", { t: h.state, bg: { current: "#86efac", "out of date": "#fde68a", failed: "#fca5a5", missing: "#fca5a5" }[h.state] || "#ffffff" }, h.licence]) } });
  out.push({ subheading: "What we do not know (data gaps)", bullets: [
    "No current IPC count: the last projections have expired.",
    "No open, current district data on child malnutrition, public wheat stocks or BISP coverage.",
    "Prices and wages come from five cities only. None are in AJK, Gilgit-Baltistan or Islamabad, so those areas are not scored on prices.",
    "Canal water is one planned figure for Punjab and Sindh, taken from a news report; IRSA's own site could not be read.",
    "Conflict is national only in the open data. Flooded cropland is not measured here; the Flood Watch covers rivers.",
    "News-based facts are entered by hand with an expiry date and are marked out of date after it.",
  ] });
  out.push({ table: { title: `Thresholds used (starting values from the guide ${cite("guide")}; FEWS NET, heavy-rain and displacement lines are NCOP's own)`, head: ["Indicator", "Watch", "Warning", "Alert"],
    rows: Object.entries(e.thresholds || {}).map(([k, t]) => [t.label, ...t.cuts.map((c) => (c === 99 ? "-" : `${t.way === "up" ? "≥" : k === "soil" || k === "vci" ? "<" : "≤"} ${_n(c, Number.isInteger(c) ? 0 : 1)}`))]) } });
  out.push({ body: `Population: ${cite("census")}. Market background and regional comparison: figures for Afghanistan and Bangladesh were removed because their analyses cover different areas and dates.` });
  out.push({ heading: "References", refs: order.map((k) => SOURCES[k] || k) });
  return out;
}

export const _test = { SOURCES, WHY, MODEL_NAME };
