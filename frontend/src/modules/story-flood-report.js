// story-flood-report.js
// --------------------------------------------------------------------------
// Decision-support report for the National Flood Watch (sections for
// story-report-export.js), and the plain-language helpers the story shares
// with it. Pure: document in (/api/flood/watch/, flood_ews.py), sections out.
//
// FFD (Pakistan Meteorological Department) is the main source and always
// comes first. GloFAS and Google Flood Hub assist. A missing or old forecast
// is written as "not available" or "too old", never as "no flood".
// --------------------------------------------------------------------------
import { lineChart, columns } from "./story-food-security-report.js";

export const FLOOD_LEVELS = [
  { label: "Normal", color: "#22c55e", say: "no unusual river or rain danger in the data we have" },
  { label: "Elevated", color: "#17a2b8", say: "something to watch; check and tell the teams" },
  { label: "Alert", color: "#E7B416", say: "a flood may develop; get ready" },
  { label: "Warning", color: "#E2683C", say: "a serious flood is likely or here; protect people" },
  { label: "Severe", color: "#640000", say: "danger to life now or very soon" },
];
const UNKNOWN = { label: "Not known", color: "#94a3b8", say: "too few current FFD readings to judge; treat as unsafe until checked" };
const TIER_COLORS = ["#28a745", "#17a2b8", "#ffc107", "#fd7e14", "#dc3545", "#6f42c1"];
const TIER_SHORT = ["Normal", "Low flood", "Medium flood", "High flood", "Very high", "Exceptional"];

const SOURCES = {
  brief: "National Flood Intelligence and Disaster Early Warning System: technical recommendations (24 November 2026). The design brief behind this report.",
  ffdLive: "Pakistan Meteorological Department, Flood Forecasting Division (FFD): river flows and reservoir levels, through NCOP's FFD feed. ffd.pmd.gov.pk",
  ffdHist: "FFD river readings 2015–2026 held by NCOP (FFD history service).",
  ffdLimits: "FFD: Flood limits (danger levels) per station. ffd.pmd.gov.pk/flood-limits, read 24 November 2026.",
  ffdPeaks: "FFD: Historical flood peaks. ffd.pmd.gov.pk/historical-peaks, read 24 November 2026.",
  ffdNow: "FFD: river status (ffd.pmd.gov.pk) and daily flood report (ffd.pmd.gov.pk/notifications).",
  ffdBull: "FFD: Daily Flood Bulletin. ffd.pmd.gov.pk/bulletin",
  stn: "PMD weather stations and FFD automatic stations: rain in the last 24 hours, through NCOP.",
  ffdAdv: "FFD: Flood advisories. ffd.pmd.gov.pk/bulletin/advisory",
  ffdMaf: "FFD: MAF forecast, Tarbela and Mangla inflows. ffd.pmd.gov.pk/maf-forecast",
  glofas: "Copernicus Emergency Management Service, Global Flood Awareness System (GloFAS v4), newest run through Open-Meteo (CC BY 4.0) or IWMI; points and warning levels through IWMI. global-flood.emergency.copernicus.eu. Harrigan, S. et al. (2023), Hydrology and Earth System Sciences 27, 1–19.",
  fhub: "Google Flood Hub forecasts, through IWMI, CC BY 4.0. Nearing, G. et al. (2024), Nature 627, 559–563.",
  imerg: "NASA GPM IMERG V07 satellite rain, catchment means by NCOP on Google Earth Engine. gpm.nasa.gov/data/imerg",
  gfs: "NOAA Global Forecast System 0.25°, archived 00 UTC runs, on Google Earth Engine.",
  ecmwf: "ECMWF open forecast data (IFS), CC BY 4.0, on Google Earth Engine.",
  smap: "NASA SMAP Level-4 root-zone soil wetness (SPL4SMGP v8). smap.jpl.nasa.gov",
  snow: "NASA MODIS daily snow cover (MOD10A1 v6.1), NDSI 40 or more, clearest view in 8 days.",
  gefs: "NOAA GEFS v12 ensemble, district rain bias-corrected by NCOP against NASA POWER.",
  jrc: "European Commission JRC: global river flood hazard maps v2.1 (undefended). Dottori, F. et al. (2022), Earth System Science Data 14, 1549–1569.",
  extents: "NCOP flood-extent layers: SUPARCO 2010–2014, NDMA GIS 2015, 2022, 2023 and 2025 satellite extents (NCOP GeoServer).",
  pop: "European Commission JRC: GHSL population 2025, scaled to the 2023 census provincial totals (Pakistan Bureau of Statistics).",
  modis: "NASA MODIS land cover MCD12Q1 v6.1 (cropland).",
  places: "NCOP layers: schools, health facilities, bridges and settlements (NCOP GeoServer).",
  pmd: "PMD Monitor: weather warnings and glacier-lake (GLOF) stations, through NCOP.",
  nse: "Nash, J. E., Sutcliffe, J. V. (1970), Journal of Hydrology 10, 282–290 (NSE). Gupta, H. V. et al. (2009), Journal of Hydrology 377, 80–91 (KGE).",
  inertial: "Bates, P. D., Horritt, M. S., Fewtrell, T. J. (2010), Journal of Hydrology 387, 33–45; de Almeida, G. A. M. et al. (2012), Water Resources Research 48, W05528: the simplified shallow-water equations used by LISFLOOD-FP.",
  catalogue: "Dottori, F. et al. (2017), Natural Hazards and Earth System Sciences 17, 1111–1126: choosing a ready-made flood map from the forecast level.",
  fabdem: "Hawker, L. et al. (2022), Environmental Research Letters 17, 024016: FABDEM terrain without trees and buildings (CC BY-NC-SA 4.0).",
  gsw: "Pekel, J.-F. et al. (2016), Nature 540, 418–422: surface water 1984–2021.",
  ahp: "NCOP Flood Model panel: factor weights from published flood studies in Pakistan, among them Hunza-Nagar (2024), Frontiers in Environmental Science, doi 10.3389/fenvs.2024.1337081.",
  merit: "Yamazaki, D. et al. (2019), Water Resources Research 55, 5053–5073: MERIT Hydro (height above the nearest river).",
  chirps: "UC Santa Barbara Climate Hazards Center: CHIRPS v3 rain, June–September 2001–2020.",
  brier: "Brier, G. W. (1950), Monthly Weather Review 78, 1–3; WMO-No. 1173: guidelines on ensemble and probability verification.",
  rain: "FFD bulletin: rain classes (heavy 30–70, very heavy 70–150, extremely heavy over 150 mm in 24 hours).",
};

// ---- formatting ------------------------------------------------------------
const _n = (v, dp = 0) => (Number.isFinite(v) ? v.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : "n/a");
const _x = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const cusecs = (v) => (!Number.isFinite(v) ? "not available" : v >= 100000 ? `${_n(v / 100000, 2)} lakh` : _n(v));
const _m = (v) => (!Number.isFinite(v) ? "n/a" : v >= 1e6 ? `${_n(v / 1e6, 1)} million` : v >= 1000 ? `${_n(Math.round(v / 1000))} thousand` : _n(v));
const _pc = (v, dp = 0) => (Number.isFinite(v) ? `${_n(v * 100, dp)}%` : "n/a");
const _join = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const _cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const _plural = (n, one, many = `${one}s`) => `${_n(n)} ${n === 1 ? one : many}`;
function _date(iso, opt = { day: "numeric", month: "short", year: "numeric" }) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso || "n/a") : d.toLocaleDateString("en-GB", { ...opt, timeZone: "UTC" });
}
const _dm = (iso) => _date(iso, { day: "numeric", month: "short" });
export function pkt(iso) {
  const d = new Date(iso);
  return !iso || Number.isNaN(d.getTime()) ? "n/a" : `${d.toLocaleString("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })} PKT`;
}
const _lv = (i) => FLOOD_LEVELS[i] || FLOOD_LEVELS[0];
const _lcell = (i) => ({ t: _lv(i).label, bg: _lv(i).color });
const _tcell = (t) => (Number.isInteger(t) ? { t: TIER_SHORT[t], bg: TIER_COLORS[t] } : "no FFD level");

/** Everything page 1 and the story's opening need; null without the document. */
export function floodHeadline(e) {
  if (!e?.national) return null;
  const n = e.national, st = e.stations || [];
  const cur = st.filter((s) => s.state === "current");
  // Too few current readings and nothing raised: the honest word is "Not known", never "Normal".
  const known = n.level > 0 || (n.known ?? cur.length >= 0.6 * st.length);
  const lv = known ? _lv(n.level) : UNKNOWN;
  const above = cur.filter((s) => s.tier > 0).sort((a, b) => b.tier - a.tier);
  const closest = cur.filter((s) => Number.isFinite(s.of_low)).sort((a, b) => b.of_low - a.of_low)[0] || null;
  const raised = (e.districts || []).filter((d) => d.level > 0);
  const gl = e.glofas || {}, fh = e.floodhub || {};
  const glText = gl.status === "valid" ? (gl.above ? `GloFAS shows ${_plural(gl.above, "point")} above a warning level` : `GloFAS shows no warning level at its ${gl.counts?.valid ?? 0} usable points`)
    : gl.status === "stale" ? `the GloFAS forecast is ${gl.age_days} days old, too old to use` : "GloFAS is not available";
  const fhText = fh.status === "valid" ? (fh.flooding ? `Google Flood Hub forecasts flooding at ${_plural(fh.flooding, "gauge")}` : `Google Flood Hub forecasts no flooding at its ${fh.counts?.valid ?? 0} gauges`)
    : fh.status === "stale" ? "the Google Flood Hub forecast is too old to use" : "Google Flood Hub is not available";
  const line = `${above.length ? `${_plural(above.length, "FFD station")} of ${cur.length} ${above.length === 1 ? "is" : "are"} in flood: ${_join(above.slice(0, 4).map((s) => `${s.name} (${TIER_SHORT[s.tier].toLowerCase()})`))}` : cur.length ? `All ${cur.length} FFD stations with a current reading show normal flow` : "No FFD station has a current reading"}${st.length > cur.length ? `; ${_plural(st.length - cur.length, "station")} had no current reading` : ""}. ${raised.length ? `${_plural(raised.length, "district")} ${raised.length === 1 ? "is" : "are"} above Normal.` : "No district is above Normal."}`;
  return { e, n, lv, known, st, cur, above, closest, raised, glText, fhText, line };
}

// ---- charts ------------------------------------------------------------------
const W = 640;
const _chart = (svg, title, legend) => ({ chart: { svg, title, legend, bg: "#ffffff" } });

/** One bar per station: flow now against FFD's own flood levels, full bar = exceptional level. */
export function limitBars(rows) {
  const rowH = 22, left = 120, right = 150, top = 4, h = top + rows.length * rowH + 6, bw = W - left - right;
  const out = [`<rect width="${W}" height="${h}" fill="#ffffff"/>`];
  rows.forEach((s, i) => {
    const y = top + i * rowH, L = s.limits, cuts = ["low", "medium", "high", "very_high", "exceptional"].map((k) => L[k]).filter(Number.isFinite);
    const max = Math.max(cuts[cuts.length - 1] * 1.08, s.q || 0);
    let x0 = left;
    [...cuts, max].forEach((c, k) => {
      const x1 = left + (bw * c) / max;
      out.push(`<rect x="${x0}" y="${y + 4}" width="${Math.max(0, x1 - x0)}" height="${rowH - 9}" fill="${TIER_COLORS[k]}" opacity="0.25"/>`);
      x0 = x1;
    });
    const w = Math.max(2, (bw * (s.q || 0)) / max);
    out.push(`<text x="${left - 7}" y="${y + 15}" font-size="10.5" font-weight="600" fill="#111827" text-anchor="end">${_x(s.name)}</text>
      <rect x="${left}" y="${y + 7}" width="${w}" height="${rowH - 15}" fill="${TIER_COLORS[s.tier || 0]}"/>
      <text x="${W - right + 6}" y="${y + 15}" font-size="10" fill="#374151">${_x(`${cusecs(s.q)} · ${_pc(s.of_low)} of Low`)}</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Flow now against FFD flood levels">${out.join("")}</svg>`;
}

const _hrs = (h) => (!Number.isFinite(h) ? "n/a" : h < 48 ? `${_n(h)} hours` : `${_n(h / 24, 1)} days`);
const STATUS_COLOR = { open: "#e5e7eb", "in progress": "#fde68a", done: "#86efac" };
const TEST_OK = 0.5;
const TRUST_BG = { High: "#86efac", Medium: "#fef08a", Low: "#fecaca" };
const _trust = (t) => (t ? { t: `${t.grade}${Number.isFinite(t.csi) ? ` (${_n(t.csi, 2)})` : ""}`, bg: TRUST_BG[t.grade] || "#e5e7eb" } : "n/a");                      // a tested reach is "good" from this share of agreement (CSI)

/** Reliability diagram: said chance (x) against how often it happened (y); dot size = number of cases. */
export function reliabilityChart(rows) {
  const P = { l: 52, t: 10, r: 12, b: 38 }, h = 250, w = W, pw = 300, ph = h - P.t - P.b;
  const X = (v) => P.l + v * pw, Y = (v) => P.t + (1 - v) * ph, col = ["#1d4ed8", "#f97316", "#059669"];
  const out = [`<rect width="${w}" height="${h}" fill="#ffffff"/>`];
  for (const v of [0, 0.25, 0.5, 0.75, 1]) out.push(`<line x1="${X(0)}" x2="${X(1)}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e5e7eb"/><text x="${P.l - 6}" y="${Y(v) + 4}" font-size="10" text-anchor="end" fill="#374151">${v * 100}%</text><text x="${X(v)}" y="${h - P.b + 14}" font-size="10" text-anchor="middle" fill="#374151">${v * 100}%</text>`);
  out.push(`<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="#6b7280" stroke-dasharray="4 3"/>`,
    `<text x="${X(0.5)}" y="${h - 6}" font-size="10.5" text-anchor="middle" fill="#111827">chance given</text>`, `<text x="12" y="${P.t + ph / 2}" font-size="10.5" text-anchor="middle" fill="#111827" transform="rotate(-90 12 ${P.t + ph / 2})">really happened</text>`);
  rows.forEach((r, k) => {
    const pts = r.bins.filter((b) => b.n >= 10);
    out.push(`<polyline fill="none" stroke="${col[k]}" stroke-width="2" points="${pts.map((b) => `${X(b.said).toFixed(1)},${Y(b.seen).toFixed(1)}`).join(" ")}"/>`);
    for (const b of pts) out.push(`<circle cx="${X(b.said).toFixed(1)}" cy="${Y(b.seen).toFixed(1)}" r="4" fill="${col[k]}" stroke="#ffffff"/>`);
    const y = P.t + 16 + k * 62, x = P.l + pw + 34;
    out.push(`<circle cx="${x}" cy="${y - 4}" r="5" fill="${col[k]}"/><text x="${x + 12}" y="${y}" font-size="11.5" font-weight="700" fill="#111827">${r.lead} day${r.lead > 1 ? "s" : ""} ahead</text>`,
      `<text x="${x + 12}" y="${y + 15}" font-size="10" fill="#374151">${_x(`Brier score ${_n(r.brier, 3)} (0 is perfect)`)}</text>`, `<text x="${x + 12}" y="${y + 29}" font-size="10" fill="#374151">${_x(`usual frequency ${_n(r.brier_usual, 3)} · no change ${_n(r.brier_same, 3)}`)}</text>`);
  });
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Reliability of flood chances">${out.join("")}</svg>`;
}

/** The flood wave shown first: one that applies now, else the planning case with most people. */
export function leadWave(hyd) {
  if (!hyd) return null;
  const k = hyd.now?.[0] || (hyd.plan?.[0] ? { id: hyd.plan[0], scenario: hyd.reaches[hyd.plan[0]]?.scenarios?.very_high ? "very_high" : "high" } : null);
  const r = k && hyd.reaches[k.id], s = r?.scenarios?.[k.scenario];
  return s ? { ...k, reach: r, s, url: `/api/flood/watch/map/${s.map}` } : null;
}

// ---- report ------------------------------------------------------------------
export function floodReportMeta(e) {
  const newest = (e.stations || []).map((s) => s.time).filter(Boolean).sort().pop();
  return {
    title: "National Flood Watch",
    subtitle: "Early warning and decision support: rivers, rain, who could be affected, and what to do",
    strip: [
      { label: "Issued", value: new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) },
      { label: "FFD readings to", value: pkt(newest) },
      { label: "Flood season", value: e.season?.open ? "Open (15 Jun – 15 Oct)" : `Closed; ${e.season?.days_to_next} days to 15 June` },
      { label: "Reference", value: `NDMA/NCOP/NFW/${new Date().toISOString().slice(0, 10).replace(/-/g, "")} · issue ${e.issue?.number ?? 1}${e.issue?.revisions ? ` rev ${e.issue.revisions}` : ""} · ${e.issue?.id || ""}` },
    ],
    glossary: [
      { term: "FFD", def: "Flood Forecasting Division of the Pakistan Meteorological Department. Pakistan's official flood forecaster and the main source of this report." },
      { term: "Cusecs, lakh", def: "Cubic feet of water passing each second. 1 lakh = 100,000 cusecs, about 2,800 cubic metres a second." },
      { term: "Low, Medium, High, Very high, Exceptional", def: "FFD's five flood levels. Each station has its own limits." },
      { term: "Normal, Elevated, Alert, Warning, Severe", def: "NCOP's readiness levels for a place. They add rain and forecasts to FFD's readings. They are not official public warnings." },
      { term: "Inflow, outflow", def: "Water arriving at, and leaving, a dam or barrage." },
      { term: "Barrage", def: "A gated dam across a river that turns water into canals. In winter it may pass nothing downstream." },
      { term: "Catchment", def: "All the land whose rain drains to one river." },
      { term: "Soil wetness percentile", def: "Where the soil ranks among the same time of other years. Wet soil (high number) sends more rain straight into rivers." },
      { term: "Chance (probability)", def: "65% means: in 65 of 100 similar past cases the level was reached." },
      { term: "GloFAS, Google Flood Hub", def: "Two global computer forecasts of river floods. They help, but FFD comes first." },
      { term: "Land that has flooded", def: "Land that satellites mapped under water in at least one of the years NCOP holds maps for." },
      { term: "1-in-100-year flood", def: "A flood with a 1% chance of happening in any one year. It can happen twice in a row." },
      { term: "Hill torrent", def: "A dry stream bed at the foot of hills that fills within hours of heavy rain." },
      { term: "Glacier-lake flood (GLOF)", def: "A sudden flood when the ice or rock holding a mountain lake gives way." },
      { term: "Depth class", def: "How deep the water gets on average over a 500 m square. Low ground inside it is deeper." },
      { term: "Flood wave (simulated)", def: "The computer lets a chosen flood run down the valley and notes how deep it gets and when it arrives. It shows a kind of flood, not a given day." },
      { term: "Likely extent, outer limit", def: "Likely: simulated water on land that satellites have seen flooded before. Outer limit: all simulated water, as if every embankment were overtopped." },
      { term: "Susceptibility", def: "How easily a place floods because of its shape, rivers, rain and land cover. It does not say when." },
      { term: "Brier score", def: "How far the chances given were from what happened, squared and averaged. 0 is perfect; lower is better." },
      { term: "NSE, KGE", def: "Scores for a river forecast. 1 is perfect; 0 is no better than always saying the average." },
      { term: "False alarm, missed event", def: "A flood forecast with no flood; a flood with no forecast." },
    ],
    footer: "FFD is the official source for river flood warnings. NCOP levels support preparedness and do not replace FFD, PMD or provincial warnings. Emergency: NDMA 1700, Rescue 1122.",
  };
}

/**
 * e      document (/api/flood/watch/)
 * shots  {1: [{src, caption}], ...} the story's own map captures
 * pictures {susceptibility, wave}: JPEG data URLs of the ready-made maps
 */
export function floodReportSections(e, { shots = {}, pictures = {} } = {}) {
  const H = floodHeadline(e);
  if (!H) return null;
  const { n, lv, st, cur } = H;
  const order = [];
  const cite = (...keys) => `[${keys.map((k) => { if (!order.includes(k)) order.push(k); return order.indexOf(k) + 1; }).join(", ")}]`;
  const out = [];
  const season = e.season || {}, res = e.reservoirs || [], cat = e.catchments || {}, gl = e.glofas || {}, fh = e.floodhub || {}, plan = e.plan, b = e.bulletin, adv = e.advisory;

  // ------------------------------------------------------------------ page 1
  const ch = e.issue?.changes;
  const moves = ch ? [...(ch.up || []).map(([k, v]) => `${k} up ${v}%`), ...(ch.down || []).map(([k, v]) => `${k} down ${Math.abs(v)}%`)] : [];
  const tar = res.find((r) => r.name === "Tarbela");
  const old = (e.health || []).filter((h) => !["current", "none in force", "in force"].includes(h.state));
  out.push({ glance: {
    heading: "The situation in one page",
    banner: { unit: "HIGHEST LEVEL", value: lv.label, label: `${n.stations.current} of ${n.stations.total} stations read`, color: lv.color,
      title: `${lv.label}: ${lv.say}`, text: `${H.line} Assisting forecasts: ${H.glText}; ${H.fhText}. ${season.open ? "" : `The FFD flood season is closed; daily bulletins restart on ${_date(season.next)}.`}` },
    level: { label: lv.label, color: lv.color, steps: FLOOD_LEVELS.map((l, i) => ({ label: `${l.label} (${e.national.districts?.[["NORMAL", "ELEVATED", "ALERT", "WARNING", "SEVERE"][i]] ?? 0})`, color: l.color, on: H.known && i === n.level })) },
    levelLabel: "Highest level anywhere in Pakistan (number of districts in brackets)",
    levelNote: "The national word is the highest local level, so a danger in one district is never hidden. Levels are NCOP's, for readiness. They are not official public warnings.",
    kpis: [
      { value: `${H.above.length} of ${cur.length}`, label: "FFD stations in flood now [Observed]" },
      H.closest ? { value: `${H.closest.name} ${_pc(H.closest.of_low)}`, label: "flow as a share of its Low-flood limit, the highest of all stations [Observed]" } : null,
      tar && Number.isFinite(tar.range_pct) ? { value: `${tar.range_pct}%`, label: `Tarbela level, 0 lowest to 100 full; ${_n(tar.room_ft)} ft of room [Observed]` } : null,
      plan ? { value: _m(plan.people.once), label: `people live on land mapped as flooded at least once, ${plan.years[0]}–${plan.years[plan.years.length - 1]} [Observed]` } : null,
    ].filter(Boolean),
    advice: { tag: "WHAT CHANGED", text: ch ? `Since ${pkt(ch.since)}: ${moves.length ? _join(moves.slice(0, 5)) : "no large change in river flow"}${ch.new_districts?.length ? `; newly raised: ${_join(ch.new_districts)}` : ""}.` : "This is the first issue kept in the new log, so there is no earlier one to compare with." },
    howToRead: false,
  } });
  out.push({ subheading: "Priority actions", table: { head: ["#", "Action", "Why now (trigger)", "Who", "By when", "Status"], rows: (e.actions || []).map((a, i) => [String(i + 1), `${a.title}. ${a.text}`, a.trigger ? `${a.trigger}. Ends when: ${a.closes}.` : "n/a", a.owner, a.by,
    { t: `${_cap(a.status || "open")}${a.by_whom ? ` (${a.by_whom}, ${_dm(a.reported)})` : a.opened ? ` since ${_dm(a.opened)}` : ""}${a.note ? `: ${a.note}` : ""}`, bg: STATUS_COLOR[a.status] || "#e5e7eb" }]) } });
  out.push({ body: `"Open" means nobody has reported progress; it does not mean nothing was done. "In progress" and "done" appear only when an organisation reports them. ${e.closed_actions?.length ? `Closed lately: ${_join(e.closed_actions.slice(0, 3).map((c) => `${c.title} (${_dm(c.closed)}, ${c.status === "done" ? "done" : "trigger ended"})`))}.` : ""}` });
  out.push({ subheading: "How fresh is the data?", body: `${(e.health || []).length - old.length} of ${(e.health || []).length} sources are current. ${old.length ? `Not current: ${_join(old.map((h) => `${h.name} (${h.state}${h.period ? `, ${String(h.period).slice(0, 10)}` : ""})`))}. Old or missing sources never count as "no flood".` : ""}` });

  // --------------------------------------------------------------- chapter 1
  out.push({ chapter: { n: 1, name: "Rivers and Reservoirs Now (FFD)", flow: true } });
  out.push({ callout: { tag: "HOW TO READ", text: "Tags: [Observed] measured; [Forecast] about the future; [Modelled] worked out by a model or from satellite. Numbers such as [1] are references at the end. Flows are in cusecs; 1 lakh = 100,000." } });
  for (const s of shots[1] || []) out.push({ image: s });
  const fst = e.ffd_status, fdy = e.ffd_daily;
  if (fst) out.push({ callout: { tag: "FFD SAYS", text: `${fst.headline}. ${fst.stations ?? ""} stations at ${pkt(fst.at)}: ${Object.entries({ normal: "normal", low: "low flood", medium: "medium flood", high: "high flood", very_high: "very high flood", ex_high: "exceptionally high flood" }).filter(([k]) => fst.counts?.[k]).map(([k, t]) => `${fst.counts[k]} ${t}`).join(", ")}.${fdy ? ` Daily flood report of ${pkt(fdy.at)}: ${fdy.all_normal ? "flow is normal at every reporting site" : "see FFD for the sites above normal"}.` : ""} ${cite("ffdNow")}` } });
  if (b) out.push({ callout: { tag: "FFD BULLETIN", text: `${b.situation || ""} ${b.outlook || ""} (Daily Flood Bulletin ${b.number || ""}, ${_date(b.date)}) ${cite("ffdBull")}` } });
  if (adv) out.push({ body: adv.in_force ? `FLOOD ADVISORY IN FORCE: ${adv.title}${adv.river ? `, ${adv.river}` : ""}, issued ${pkt(adv.issued)}${adv.valid ? `, valid ${adv.valid.toLowerCase()}` : ""}. ${adv.what || ""} ${adv.impacts?.people || ""} ${cite("ffdAdv")}` : `No FFD flood advisory is in force (checked ${pkt(adv.checked)}) ${cite("ffdAdv")}.` });
  out.push({ subheading: "How close is each river to flooding?", body: `${H.closest ? `${H.closest.name} is the closest, at ${_pc(H.closest.of_low)} of its Low-flood limit (${cusecs(H.closest.q)} of ${cusecs(H.closest.limits.low)} cusecs).` : ""} Each bar is one station; the coloured bands are FFD's own flood levels ${cite("ffdLive", "ffdLimits")}.` });
  const bars = cur.filter((s) => s.limits && Number.isFinite(s.q)).sort((a, c) => (c.of_low || 0) - (a.of_low || 0)).slice(0, 14);
  if (bars.length) out.push(_chart(limitBars(bars), `Flow now against FFD flood levels, ${pkt(bars[0].time)} [Observed]`, "solid bar = flow now (larger of inflow and outflow) · pale bands = normal, low, medium, high, very high, exceptional"));
  for (const river of ["Indus", "Kabul", "Jhelum", "Chenab", "Ravi", "Sutlej"]) {
    const rows = st.filter((s) => s.river === river);
    if (!rows.length) continue;
    out.push({ table: { title: `${river} [Observed] ${cite("ffdLive", "ffdHist")}`, head: ["Station", "Inflow", "Outflow", "Trend", "Level", "Usual for the date", "Of Low-flood limit", "This year's highest", "Record"],
      rows: rows.map((s) => { const pk = (s.peaks || []).slice(-1)[0]; return [s.state === "current" ? s.name : `${s.name} (${s.state})`, cusecs(s.inflow), cusecs(s.outflow), s.trend || "n/a", s.state === "current" ? _tcell(s.tier) : "not known",
        Number.isFinite(s.normal) ? cusecs(s.normal) : "too few years", Number.isFinite(s.of_low) ? _pc(s.of_low) : "n/a", pk ? `${cusecs(pk.q)} (${_dm(pk.date)} ${pk.year})` : "n/a", s.record ? `${cusecs(s.record)} (${s.record_year})` : "n/a"]; }) } });
  }
  out.push({ body: `"Usual" is the middle value within a week of this date in earlier years, where at least 30 readings exist. Records: ${cite("ffdPeaks")}. "Not available" means no reading; it does not mean zero.` });
  if (res.length) {
    out.push({ subheading: "How much room is left in the dams?", table: { title: `Reservoirs, ${pkt(res.find((r) => r.time)?.time)} [Observed] ${cite("ffdLive", "ffdMaf")}`, head: ["Dam", "Level now", "Full at", "Room left", "Inflow / outflow", ...(res.some((r) => r.bulletin) ? ["Water in store"] : []), "Inflow outlook"],
      rows: res.map((r) => [r.name, r.level_ft ? `${_n(r.level_ft, 1)} ft (${r.range_pct}% of the range)` : "not available", `${_n(r.max_ft)} ft`, r.room_ft != null ? `${_n(r.room_ft)} ft` : "n/a", `${cusecs(r.inflow)} / ${cusecs(r.outflow)}`,
        ...(res.some((x) => x.bulletin) ? [r.bulletin ? `${_n(r.bulletin.live_pct, 0)}% (${_n(r.bulletin.live_maf, 2)} of ${_n(r.bulletin.live_max_maf, 2)} MAF) on ${_dm(r.bulletin.date)}` : "n/a"] : []),
        r.inflow_outlook ? `${_n(r.inflow_outlook.lo, 2)}–${_n(r.inflow_outlook.hi, 2)} MAF, ${r.inflow_outlook.pct}% of normal` : "n/a"]) } });
    out.push({ body: `${e.storage ? `FFD's inflow outlook covers ${_dm(e.storage.from)} to ${_date(e.storage.to)} [Forecast]. ` : ""}An empty dam can hold back flood water; a full one cannot. Level is not the same as volume.` });
  }

  // --------------------------------------------------------------- chapter 2
  out.push({ chapter: { n: 2, name: "Rain, Soil and Snow", flow: true } });
  const cr = cat.rows || [], sr = e.station_rain || {};
  out.push({ subheading: "Rain measured in the last 24 hours", body: sr.status === "valid" ? `${sr.wet ? `${_plural(sr.wet, "station")} of ${_n(sr.stations)} recorded rain; most: ${_join(sr.top.slice(0, 4).map((x) => `${x.name} ${_n(x.mm)} mm`))}. ${sr.heavy ? `${_plural(sr.heavy, "station")} had heavy rain (over 30 mm).` : "None had heavy rain (over 30 mm)."}` : `None of ${_n(sr.stations)} stations recorded rain.`} [Observed] ${cite("stn")}` : "Station rain is not available for this issue. This does not mean that no rain fell." });
  if (cr.length) {
    const v = (r, k) => (Number.isFinite(r[`r${k}`]) ? `${_n(r[`r${k}`])} mm${Number.isFinite(r[`p${k}`]) ? ` (${r[`p${k}`]})` : ""}` : "n/a");
    out.push({ table: { title: `Rain that has fallen on each river's catchment, to ${String(cat.rain_to).length > 10 ? pkt(cat.rain_to) : _date(cat.rain_to)} [Modelled, satellite] ${cite("imerg")}; soil wetness to ${_date(cat.soil_to)} ${cite("smap")}`, head: ["Catchment", "1 day", "7 days", "30 days", "Soil wetness percentile", "Snow cover (usual)"],
      rows: cr.map((r) => [r.name === "Tarbela" ? "Upper Indus (Tarbela)" : r.name === "Mangla" ? "Jhelum (Mangla)" : r.name, v(r, 1), v(r, 7), v(r, 30), Number.isFinite(r.soil_pct) ? _n(r.soil_pct) : "n/a", r.snow ? `${r.snow.share}% (${r.snow.normal ?? "n/a"}%)` : "-"]) } });
    out.push({ body: `Brackets: rank against the same time in earlier years, 0 driest to 100 wettest; shown only when enough years exist (mostly June–October). Snow ${cite("snow")} of the 8 days to ${_date(cat.snow_to || cr[0]?.snow?.to)}: more snow now means more melt water in spring.` });
    const f = (x) => (x ? `${_n(x.d1_3)} / ${_n(x.d4_7)} mm` : "not available");
    out.push({ table: { title: `Rain expected: next 3 days / days 4 to 7 [Forecast] ${cite("gfs", "ecmwf")}`, head: ["Catchment", `US model (GFS, run ${String(cat.gfs_run).length > 10 ? pkt(cat.gfs_run) : _dm(cat.gfs_run)})`, `European model (ECMWF${cat.ecmwf_run ? `, run ${pkt(cat.ecmwf_run)}` : ""})`, "Do they agree?"],
      rows: cr.map((r) => { const a = r.gfs?.d1_3, c = r.ecmwf?.d1_3; return [r.name, f(r.gfs), f(r.ecmwf), !Number.isFinite(a) || !Number.isFinite(c) ? "only one available" : Math.abs(a - c) <= Math.max(5, 0.5 * Math.max(a, c)) ? "Yes" : "No: treat with care"]; }) } });
  } else out.push({ body: "Catchment rain and soil data are not available for this issue. This does not mean that no rain fell." });
  const rn = e.rain;
  if (rn) {
    const most = rn.week_top?.[0];
    out.push({ body: `District outlook from NCOP's bias-corrected GEFS, ${_date(rn.from)} onwards${rn.status === "stale" ? " (too old to use for levels)" : ""} [Forecast] ${cite("gefs")}: ${rn.wet ? `${_plural(rn.wet, "district")} may reach a flash-flood rain level in the next three days.` : "no district reaches a flash-flood rain level in the next three days."} ${most && !(most.peak_mm >= 1) ? "Almost no rain is expected anywhere this week." : most ? `The heaviest day of the week is ${_n(most.peak_mm)} mm, in ${most.name} on ${_dm(most.peak_day)}.` : ""} Rain classes: ${cite("rain")}.` });
    if (rn.wet) out.push({ table: { title: "Wettest districts, next 3 days [Forecast]", head: ["District", "Heaviest day", "3-day total", "7-day total", "Type", "Level"], rows: rn.top.filter((r) => r.level).map((r) => [`${r.name} (${r.province})`, `${_n(r.max3)} mm`, `${_n(r.sum3)} mm`, `${_n(r.sum7)} mm`, { torrent: "hill torrents", city: "city", plain: "plain" }[r.kind], _lcell(r.level)]) } });
  }

  // --------------------------------------------------------------- chapter 3
  out.push({ chapter: { n: 3, name: "What May Come Next", flow: true } });
  for (const s of shots[2] || []) out.push({ image: s });
  out.push({ subheading: "The next three days, station by station", body: `NCOP's river outlook follows the water already measured upstream, using FFD's own travel times, and adds rain where it helps. FFD's 24-hour forecast, when it is published, comes first. "Not skilful" means our test showed the method is no better there than saying "no change", so no number is given ${cite("ffdHist", "gfs", "imerg")}.` });
  const ol = st.filter((s) => s.outlook?.leads?.some((x) => x.status === "ok"));
  const cell = (s, i) => { const x = s.outlook?.leads?.[i]; return !x ? "n/a" : x.status === "ok" ? `${cusecs(x.q)} (${cusecs(x.lo)}–${cusecs(x.hi)})` : x.status; };
  if (ol.length) out.push({ table: { title: `Flow expected, cusecs: middle value (likely range) [Forecast] from the reading of ${_dm(ol[0].outlook.from)}`, head: ["Station", "Now", "In 1 day", "In 2 days", "In 3 days", "Chance of Low flood or more", "FFD 24-hour forecast"],
    rows: ol.map((s) => { const p = Math.max(...s.outlook.leads.map((x) => x.prob?.low ?? -1)); return [s.name, cusecs(s.outlook.now), cell(s, 0), cell(s, 1), cell(s, 2), p >= 0 ? (p < 0.01 ? "below 1%" : _pc(p)) : "n/a", s.bulletin ? (s.bulletin.forecast_text || s.bulletin.forecast_level) : season.open ? "not available" : "season closed"]; }) } });
  const none = st.filter((s) => s.limits && !ol.includes(s));
  const waiting = none.filter((s) => s.outlook?.leads?.some((x) => x.status === "input missing")).map((s) => s.name);
  const unfit = none.filter((s) => !waiting.includes(s.name)).map((s) => s.name);
  if (unfit.length) out.push({ body: `No NCOP outlook for ${_join(unfit)}: too few past readings, or not skilful. For these, use FFD.` });
  if (waiting.length) out.push({ body: `No outlook today for ${_join(waiting)}: a needed reading or rain value had not arrived.` });
  out.push({ subheading: "What the two global systems say", table: { title: `Forecast status. "No flood" is written only when a valid forecast says so ${cite("glofas", "fhub")}`, head: ["System", "Run", "Usable", "Too old", "Unreliable", "No forecast", "Result"],
    rows: [
      [`GloFAS (15 days), via ${gl.via || "IWMI"}`, gl.run ? `${_date(gl.run)} (${gl.age_days} days old)` : "n/a", _n(gl.counts?.valid ?? 0), _n(gl.counts?.stale ?? 0), _n(gl.counts?.unreliable ?? 0), _n(gl.counts?.["no forecast"] ?? 0), gl.status === "valid" ? (gl.above ? `${gl.above} above a warning level` : "no warning level reached") : gl.status === "stale" ? `TOO OLD. At its run date it showed ${gl.above ? `${gl.above} points above` : "no point above"} a warning level for the ${gl.days_ahead} days still ahead` : "NOT AVAILABLE"],
      ["Google Flood Hub (7 days)", fh.issued ? pkt(fh.issued) : "n/a", _n(fh.counts?.valid ?? 0), _n(fh.counts?.stale ?? 0), "-", _n(fh.counts?.["no forecast"] ?? 0), fh.status === "valid" ? (fh.flooding ? `${fh.flooding} gauges flooding` : "no flooding forecast") : fh.status === "stale" ? "TOO OLD" : "NOT AVAILABLE"],
    ] } });
  out.push({ body: `${fh.status === "valid" ? `${_n(fh.verified)} of ${_n((fh.counts?.valid || 0))} Flood Hub gauges are checked by Google against real measurements. ` : ""}${e.inundation ? (e.inundation.count ? `Google maps ${_plural(e.inundation.count, "flooded area")}.` : "Google has no flood map for Pakistan today. It draws one only where its own gauges forecast a flood, so an empty map is not proof that nothing is flooded.") : ""}` });

  if (e.timing?.length) {
    out.push({ subheading: "When was each forecast made?", table: { title: "Forecast timing. A forecast past its limit is not used for any level", head: ["Product", "Made", "Received by NCOP", "Looks ahead to", "Too old after", "State"],
      rows: e.timing.map((t) => [t.name, t.made ? pkt(t.made) : "n/a", t.received ? pkt(t.received) : "n/a", t.covers_to ? _dm(t.covers_to) : "now", t.expires ? pkt(t.expires) : "n/a", { t: t.state, bg: t.state === "valid" ? "#86efac" : "#fca5a5" }]) } });
  }

  // --------------------------------------------------------------- chapter 4
  out.push({ chapter: { n: 4, name: "Who and What Could Be Affected", flow: true } });
  if (H.raised.length) {
    out.push({ table: { title: "Districts above Normal now", head: ["District", "Level", "Danger", "Why", "Confidence", "People in the flood zone used"], rows: H.raised.slice(0, 18).map((d) => [`${d.name} (${d.province || ""})`, _lcell(d.level), d.hazards[0].hazard, d.hazards[0].why, d.hazards[0].confidence, d.exposure?.river ? `${_m(d.exposure.people_zone)} (land flooded ${d.exposure.zone === "often" ? "in 3 or more mapped years" : "at least once"})` : "not estimated"]) } });
    const worst = H.raised.find((d) => d.exposure?.river);
    if (worst) out.push({ table: { title: `Planning scenarios for ${worst.name}: people living on land that could flood. Not a forecast of flooding.`, head: ["Scenario", "Land counted", "People"], rows: [["Most likely", "flooded in 3 or more mapped years [Observed]", _m(worst.exposure.often)], ["High impact", "flooded at least once in the mapped years [Observed]", _m(worst.exposure.once)], ["Extreme, for planning", "1-in-100-year flood with every embankment failing [Modelled]", _m(worst.exposure.rp100)]] } });
  } else out.push({ body: "No district is above Normal today, so the rest of this chapter is for planning: who would be in danger when the rivers rise." });
  if (plan) {
    out.push({ kpis: [
      { value: _m(plan.people.once), label: `people on land flooded at least once in ${plan.years.length} mapped years [Observed]` }, { value: _m(plan.people.often), label: "people on land flooded in 3 or more of them [Observed]" },
      { value: `${_n(plan.crop_km2)} km²`, label: "cropland flooded at least once [Observed]" }, { value: _m(plan.people.rp100), label: "upper limit: 1-in-100-year flood, no embankments [Modelled]" },
    ] });
    const pl = plan.places || {};
    out.push({ body: `The main measure is what satellites actually mapped as flooded (${plan.years.join(", ")}) ${cite("extents", "pop", "modis")}. ${Object.keys(pl).length ? `On that land stand about ${_join([pl.schools && `${_n(pl.schools[1])} schools`, pl.health && `${_n(pl.health[1])} health facilities`, pl.bridges && `${_n(pl.bridges[1])} of ${_n(pl.bridges[0])} listed bridges`, pl.settlements && `${_n(pl.settlements[1])} settlements`].filter(Boolean))} ${cite("places")}.` : ""} The modelled limit assumes every embankment fails; it covers ${_n(plan.km2.rp10)} km² even for a 1-in-10-year flood, against ${_n(plan.observed?.["2010"]?.km2)} km² mapped in 2010, so it is shown only as the outer limit ${cite("jrc")}.` });
    const row = (r) => [`${r.name} (${r.province})`, _m(r.once), _pc(r.people ? r.once / r.people : NaN), _m(r.often), `${_n(r.crop_km2)} km²`, r.places?.health ? _n(r.places.health[1]) : "n/a", r.places?.schools ? _n(r.places.schools[1]) : "n/a", `${r.years_flooded} of ${plan.years.length}`];
    const head = ["District", "People on flooded land", "Share of district", "On land flooded 3+ years", "Cropland", "Health posts", "Schools", "Years flooded"];
    out.push({ table: { title: "Where the MOST PEOPLE live on land that has flooded [Observed]", head, rows: plan.by_people.slice(0, 8).map(row) } });
    out.push({ table: { title: "Where the LARGEST SHARE of people live on land that has flooded [Observed]", head, rows: plan.by_share.slice(0, 6).map(row) } });
    out.push({ table: { title: "Flooded MOST OFTEN in the mapped years [Observed]", head, rows: plan.often.slice(0, 6).map(row) } });
    const ob = Object.entries(plan.observed || {});
    if (ob.length) out.push(_chart(columns(ob.map(([y, v]) => ({ label: y, v: v.km2 / 1000, color: Number(y) >= 2022 ? "#1d4ed8" : "#64748b" })), { unit: "thousand km² mapped as flooded", dp: 1, aria: "Mapped flood extent by year" }), `Land mapped as flooded, by year [Observed, satellite] ${cite("extents")}`, "maps come from different satellites and dates, so compare years with care"));
    out.push({ body: "These counts are people and places in reach, not damage. The grid is about 270 metres, so a school or home that close to water may be counted. A year counts as flooded when at least 2% of the district (or 25 km²) was mapped under water. Satellite maps come from different agencies and can mistake wet fields for floods, so real numbers may be lower." });
  } else out.push({ body: "The flood-plain atlas has not been built on this server yet, so exposure is not estimated." });

  const hy = e.hydraulic, lw = leadWave(hy);
  if (lw) {
    const now = hy.now?.length > 0, S = lw.s, R = lw.reach;
    out.push({ subheading: "How deep and how soon? Simulated flood waves", body: `${now ? `${R.station} is at or forecast to reach ${S.label.toLowerCase()} (${lw.why}), so the ready-made flood wave for that level is shown.` : "No station is at High flood, so this is for planning."} NCOP has run ${_n(Object.values(hy.reaches).reduce((a, r) => a + Object.keys(r.scenarios).length, 0))} flood waves, at FFD's own flood limits, down ${_plural(Object.keys(hy.reaches).length, "river stretch", "river stretches")} with the equations LISFLOOD-FP uses ${cite("inertial", "catalogue", "fabdem", "gsw")}. [Modelled]` });
    if (R.trust?.grade === "Low") out.push({ callout: { tag: "LOW TRUST", color: "#dc2626", text: `${R.river === "Indus" ? "On the Indus the model spreads water too far: the big embankments are not in the 500 m terrain. In tests it agreed with satellite maps only about a third of the time." : R.trust.why === "not tested on a real flood" ? "This stretch has not been tested on a real flood." : "Tests on real floods on this river agreed poorly."} Use the numbers as a rough upper guide, not a plan.` } });
    if (pictures.wave) out.push({ image: { src: pictures.wave, caption: `${S.label} at ${R.station} (${cusecs(S.flow)} cusecs), ${R.station} to ${R.to}: greatest depth reached [Modelled]. Blue to purple = likely extent by depth; pale orange = outer limit if every embankment is overtopped. Red dot: ${R.station}.` } });
    out.push({ kpis: [
      { value: _m(S.people), label: `people on the likely flooded land, ${R.station} to ${R.to}` }, { value: _m(S.deep_people), label: "of them where water is over 1.5 m deep" },
      { value: `${_n(S.km2)} km²`, label: "likely flooded land (river itself left out)" }, { value: _m(S.people_upper), label: "outer limit: every embankment overtopped" },
    ] });
    const dr = (S.districts || []).filter((d) => d.people > 0 || d.km2 > 0);
    if (dr.length) out.push({ table: { title: `${S.label} at ${R.station}: when the water arrives and how deep it gets, district by district (hours from the start of the rise at ${R.station}) [Modelled]`, head: ["District", "First water", "Half of it wet by", "Typical depth", "People, likely", "Over 1.5 m deep", "People, outer limit", "Cropland"],
      rows: dr.map((d) => [d.name, _hrs(d.first_h), _hrs(d.half_h), `${_n(d.depth_m, 1)} m`, _m(d.people), _m(d.deep_people), _m(d.people_upper), `${_n(d.crop_km2)} km²`]) } });
    const pl2 = (hy.plan || []).map((id) => [id, hy.reaches[id]?.scenarios?.very_high || hy.reaches[id]?.scenarios?.high]).filter(([, x]) => x);
    out.push({ table: { title: "Planning: a VERY HIGH flood on each stretch [Modelled]", head: ["Stretch", "Trust (test agreement)", "Flow at the top", "People, likely", "Over 1.5 m deep", "People, outer limit", "Land, likely", "Schools / health posts", "Reaches first"],
      rows: pl2.slice(0, 15).map(([id, x]) => { const r = hy.reaches[id], f = (x.districts || []).find((d) => d.km2 > 0); return [`${r.river}: ${r.station} to ${r.to}`, _trust(r.trust), cusecs(x.flow), _m(x.people), _m(x.deep_people), _m(x.people_upper), `${_n(x.km2)} km²`, x.places ? `${_n(x.places.schools ?? 0)} / ${_n(x.places.health ?? 0)}` : "n/a", f ? `${f.name}, ${_hrs(f.first_h)}` : "n/a"]; }) } });
    if (hy.tests?.length) {
      const good = hy.tests.filter((t) => t.likely.csi >= TEST_OK);
      out.push({ table: { title: "Test on real floods: FFD's measured flow was run through the model and compared with the satellite map of that flood (that map was not used to build 'likely') [tested on past data]", head: ["Flood", "Flooded land found", "Marked land that stayed dry", "Agreement (CSI), likely", "Agreement, outer limit", "Agreement of past floods alone"],
        rows: hy.tests.map((t) => [`${t.station} ${t.year}`, _pc(t.likely.found), _pc(t.likely.dry), { t: _n(t.likely.csi, 2), bg: t.likely.csi >= 0.6 ? "#86efac" : t.likely.csi >= TEST_OK ? "#fef08a" : "#fecaca" }, _n(t.upper.csi, 2), _n(t.past_floods_only.csi, 2)]) } });
      out.push({ body: `What counts as "likely" was chosen river by river from these tests: on the Chenab and Jhelum, simulated water on land that has flooded before; on the Ravi and Sutlej, all simulated water, because the 2025 floods covered new land; on the Indus, simulated water on land flooded in two or more mapped years. Trust: High from 0.6 agreement, Medium from 0.45, otherwise Low.` });
      out.push({ body: `Agreement (CSI) is the land both show as flooded, divided by the land either shows; 1 is perfect. ${good.length ? `It reaches ${_n(TEST_OK, 1)} or more at ${_join(good.map((t) => `${t.station} ${t.year}`))}.` : "No test reaches 0.5."} ${hy.tests.length > good.length ? `It is weaker at ${_join(hy.tests.filter((t) => !good.includes(t)).map((t) => `${t.station} ${t.year}`))}: use those stretches with extra care.` : ""} Embankments, breaches and rain falling on the plain are not in the model. Water meets FFD's readings on the way, so trust the readings over the simulated hour.` });
    }
    out.push({ body: `Flood wave used: it ${hy.wave}. Grid 500 m. Depth is over average ground: treat it as a band, not a survey. Real floods can rise faster, last longer or break an embankment in one place. Catalogue built ${_date(hy.built)}. ${hy.dropped?.length ? `Not included: ${_join(hy.dropped)} (narrow gorge, the 500 m grid cannot carry the water through).` : ""}` });
  }
  const su = e.susceptibility;
  if (su) {
    out.push({ subheading: "Where does the land flood easily? Susceptibility map", body: `This map uses the method of NCOP's Flood Model panel for the whole country: height above the nearest river, slope, distance to the river, wetness of the terrain, monsoon rain and land cover, weighted from published studies in Pakistan (AHP) and combined with how often each class really flooded ${cite("ahp", "merit", "chirps", "modis", "extents")}. [Modelled]` });
    if (pictures.susceptibility) out.push({ image: { src: pictures.susceptibility, caption: "Flood susceptibility, five classes [Modelled]. It says where, not when." } });
    out.push({ table: { title: "Does the map match real floods?", head: ["Class", "Share of the country", "Share of this land that flooded at least once", "Share of all flooded land found here"], rows: su.classes.map((c, i) => [{ t: c, bg: su.colors[i] }, _pc(su.shares[i]), _pc(su.flooded_share[i], 1), _pc(su.captured[i], 1)]) } });
    const A = Object.entries(su.auc), lo = A.reduce((a, b) => (b[1].ensemble < a[1].ensemble ? b : a)), hi = A.reduce((a, b) => (b[1].ensemble > a[1].ensemble ? b : a));
    out.push({ body: `Test: each flood year was predicted by a map that had not seen it. On average a flooded spot ranked above a dry one ${_pc(su.auc_mean.ensemble)} of the time (50% is a coin toss): best ${hi[0]} (${_pc(hi[1].ensemble)}), worst ${lo[0]} (${_pc(lo[1].ensemble)}). Weighted factors alone reach ${_pc(su.auc_mean.ahp)}; height above the river alone, ${_pc(su.auc_mean.hand)}. ${Number.isFinite(su.auc_mean.plains) ? `On the plains alone, where telling wet from dry is harder, it is ${_pc(su.auc_mean.plains)}, so use the map to compare districts, not streets. ` : ""}Embankments are not in the map.` });
    out.push({ table: { title: "Districts with the largest share of land in the two highest classes [Modelled]", head: ["District", "High or very high", "Very high"], rows: su.top.slice(0, 8).map((r) => [`${r.name} (${r.province})`, `${r.high_pct}%`, `${r.very_high_pct}%`]) } });
  }

  // --------------------------------------------------------------- chapter 5
  out.push({ chapter: { n: 5, name: "Other Flood Dangers, and What to Do", flow: true } });
  for (const s of shots[4] || []) out.push({ image: s });
  const gf = e.glof || {}, pw = e.pmd_rain || {};
  out.push({ cards: [
    { title: "Hill torrents and flash floods", text: rn ? (rn.wet ? `${_plural(rn.wet, "district")} may see dangerous short rain within three days; see chapter 2.` : "No district reaches the rain level used for flash floods in the next three days. Short local storms can still be missed.") : "The rain outlook is not available.", source: cite("gefs") },
    { title: "City flooding", text: rn ? (rn.top.some((r) => r.kind === "city" && r.level) ? `Heavy rain is possible in ${_join(rn.top.filter((r) => r.kind === "city" && r.level).map((r) => r.name))}.` : "No major city reaches 50 mm in a day in the next three days.") : "The rain outlook is not available.", source: "" },
    { title: "Glacier-lake floods", text: gf.status === "valid" ? (gf.alerts?.length ? `${gf.alerts.length} of ${gf.online} working stations report an alert.` : `${gf.online} stations work and none reports an alert.`) : gf.stations ? `NOT KNOWN. All ${gf.stations} PMD stations are offline. ${gf.offline_with_label} still show an old "warning" label, which is not used. ${gf.in_season ? "This is the danger season (May–September)." : "The danger season is May to September."}` : "NOT KNOWN: the station feed could not be read.", source: cite("pmd") },
    { title: "PMD rain warnings", text: pw.status === "valid" ? (pw.count ? `${pw.count} rain warnings are active.` : `None. PMD has ${pw.all} other warnings active (such as fog).`) : "NOT KNOWN: the warning feed could not be read.", source: cite("pmd") },
  ] });
  out.push({ body: "Not covered by any data here: embankment breaches, dam or gate failures, water released from across the border before it reaches a gauge, blocked drains, and cyclone surge on the coast." });
  out.push({ subheading: "What each level means for action", table: { title: `Proposed actions (to be agreed with provinces; follows ${cite("brief")})`, head: ["Level", "Time to act", "Actions", "Who"], rows: (e.matrix || []).map((m, i) => [_lcell(i), m[1], m[2], m[3]]) } });
  out.push({ table: { title: "Risk calendar", head: ["When", "Typical danger", "What to watch", ""], rows: (e.calendar || []).map((c) => [c.window, c.risk, c.watch, c.now ? { t: "NOW", bg: "#17a2b8" } : ""]) } });

  // --------------------------------------------------------------- chapter 6
  out.push({ chapter: { n: 6, name: "How Far to Trust This", flow: true } });
  const sk = (e.skill || []).filter((r) => r.leads.some((l) => l.days));
  if (sk.length) {
    out.push({ subheading: "How good is the river outlook?", body: `Each flood season since 2016 was forecast by a model trained without it. "Saying no change" is the simplest rival. Scores: ${cite("nse")}.` });
    const c = (l) => (!l?.days ? "n/a" : { t: `${_n(l.nse, 2)} (${_n(l.nse_same, 2)})${l.usable ? "" : " ✕"}`, bg: !l.usable ? "#fecaca" : l.nse >= 0.85 ? "#86efac" : "#fef08a" });
    out.push({ table: { title: "Skill (NSE) 1, 2 and 3 days ahead; in brackets, the skill of saying 'no change'. Red with ✕ = not used", head: ["Station", "1 day", "2 days", "3 days", "Typical error, 2 days", "Flood days caught, 2 days", "False alarms, 2 days", "May raise a level?"],
      rows: sk.map((r) => { const l = r.leads[1] || {}, f = l.flood; return [r.name, c(r.leads[0]), c(r.leads[1]), c(r.leads[2]), l.mae ? cusecs(l.mae) : "n/a", f?.events ? `${f.hits} of ${f.events}` : "no floods in test", f && f.hits + f.false ? `${f.false} of ${f.hits + f.false}` : "n/a", r.leads.some((x) => x.usable && x.warn) ? "yes" : "no"]; }) } });
    const on = sk.reduce((s, r) => s + (r.leads[1]?.usable ? r.leads[1]?.flood?.onsets || 0 : 0), 0), oc = sk.reduce((s, r) => s + (r.leads[1]?.usable ? r.leads[1]?.flood?.onsets_caught || 0 : 0), 0);
    out.push({ body: `In plain words: on the lower Indus the outlook is reliable two to three days ahead because the water is already measured upstream. Near the mountains (Marala, Khanki, Qadirabad, Mangla) floods arrive within hours, and it is not reliable beyond a day. Floods that were not already under way are the hardest: ${oc} of ${on} were seen two days ahead at stations where the outlook is used. Days in a flood are counted one by one.` });
  }
  const rl = (e.reliability || []).filter((r) => r.floods > 0);
  if (rl.length) {
    out.push({ subheading: "Can the chances be believed?", body: `When the outlook said about 60%, did it flood about 6 times in 10? Each season was scored with a model and error range that had not seen it: ${_n(rl[0].n)} forecasts a day ahead, ${_n(rl[0].floods)} of them on flood days ${cite("brier")}.` });
    out.push(_chart(reliabilityChart(rl), "Reliability of 'chance of Low flood or more', all stations where the outlook is used [tested on past data]", "dots on the dashed line = the chances were right; above it = floods came more often than said"));
    const mid = rl[0].bins.find((b) => b.from === 0.5), m3 = rl[rl.length - 1].bins.find((b) => b.from === 0.5);
    out.push({ body: `${mid?.n >= 10 ? `One day ahead, cases given about ${_pc(mid.said)} flooded ${_pc(mid.seen)} of the time${m3 && m3 !== mid && m3.n >= 10 ? `; ${rl[rl.length - 1].lead} days ahead, about ${_pc(m3.said)} became ${_pc(m3.seen)}` : ""}.` : ""} Two days ahead the Brier score is ${_n((rl[1] || rl[0]).brier, 3)}, against ${_n((rl[1] || rl[0]).brier_usual, 3)} for always giving the usual frequency and ${_n((rl[1] || rl[0]).brier_same, 3)} for saying "no change". Lower is better.` });
    const ps = sk.filter((r) => r.leads.some((l) => l.usable && l.prob?.floods >= 8));
    if (ps.length) out.push({ table: { title: "Brier skill against the usual frequency: 1 perfect, 0 no better (only where the test holds 8 or more flood days)", head: ["Station", "Flood days in the test", "1 day", "2 days", "3 days"], rows: ps.map((r) => [r.name, _n(Math.max(...r.leads.map((l) => l.prob?.floods || 0))), ...r.leads.map((l) => (l.usable && l.prob?.floods >= 8 && Number.isFinite(l.prob.bss) ? { t: _n(l.prob.bss, 2), bg: l.prob.bss >= 0.7 ? "#86efac" : l.prob.bss >= 0.4 ? "#fef08a" : "#fecaca" } : "not used"))]) } });
  }
  if (e.events?.length) out.push({ table: { title: "Past floods: what the outlook would have said about the peak day (trained without that year) [tested on past data]", head: ["Flood", "Peak day", "Real peak", "Said 3 days before", "Said 2 days before", "Said 1 day before"],
    rows: e.events.map((x) => { const s = (h) => { const q = x.said.find((y) => y.lead === h); return q?.q ? { t: `${cusecs(q.q)}`, bg: Number.isInteger(q.tier) ? TIER_COLORS[q.tier] : "#ffffff" } : "n/a"; }; return [x.label, _date(x.date), { t: cusecs(x.peak), bg: TIER_COLORS[x.tier ?? 0] }, s(3), s(2), s(1)]; }) } });
  if (e.events?.length) out.push({ body: "Colours are FFD flood levels. Where the early columns are paler than the real peak, the size of the flood was underestimated." });
  out.push({ subheading: "Data checks in this issue", table: { head: ["Check", "Finding", "What was done"], rows: (e.issues || []).map((i) => [_cap(i.kind), i.text, i.action]) } });
  const good = { current: "#86efac", "in force": "#fde68a", "none in force": "#86efac", "season closed": "#e5e7eb" };
  out.push({ table: { title: "Source health", head: ["Source", "Type", "Data to", "State", "Licence"], rows: (e.health || []).map((h) => [h.name, h.type, h.period ? (String(h.period).length > 12 ? pkt(h.period) : String(h.period)) : "n/a", { t: h.state, bg: good[h.state] || "#fca5a5" }, h.licence]) } });
  const rg = e.register;
  if (rg?.rows?.length) out.push({ table: { title: `Data-source register (reviewed ${_date(rg.reviewed)})`, head: ["Source", "Owner", "Licence", "How NCOP gets it", "Delay", "How often", "Detail", "Main limits"], rows: rg.rows.map((r) => [r.name, r.owner, r.licence, r.access, r.delay, r.frequency, r.detail, r.limits]) } });
  out.push({ subheading: "How the level is set", bullets: [
    "FFD comes first. A reading at Low, Medium, High or Very high flood sets Elevated, Alert, Warning or Severe. FFD's own forecast or advisory can set up to Warning.",
    "NCOP's outlook, GloFAS and Flood Hub can only raise a place to Elevated, or to Alert when two of them agree. Old or unreliable ones cannot raise anything.",
    `District rain can raise up to Alert: ${e.rain_cuts ? `${e.rain_cuts.torrent.join(" and ")} mm in a day in hill-torrent districts, ${e.rain_cuts.city.join(" and ")} mm in cities, ${e.rain_cuts.plain.join(" and ")} mm elsewhere` : "see method"}. These limits are starting values.`,
    `A source is too old after: FFD ${e.fresh_h?.ffd_season} hours in season (${e.fresh_h?.ffd} outside), GloFAS ${e.fresh_h?.glofas / 24} days, Flood Hub ${e.fresh_h?.floodhub} hours.`,
  ] });
  out.push({ subheading: "What we do not know (limits of NCOP)", bullets: [
    hy ? "The flood waves were run in advance for set flows. They do not follow today's river hour by hour, and embankments, gates and breaches are not in them." : "The depth and arrival catalogue has not been built on this server, so there is no forecast of flood depth or arrival time on the ground.",
    "wflow and LISFLOOD themselves are not installed: they need Julia or PCRaster and a licence NCOP does not accept in production. LISFLOOD-FP's equations are used instead for the flood waves. A rainfall-runoff model of the same kind (GR4J) was tested on daily data for Marala and Mangla: it scored slightly better at Marala (0.58 against 0.53 a day ahead) but caught only 56% of flood days with 44% false alarms, and it did not help at Mangla, so it is not used. Hourly rain and flow would be needed.",
    "FFD's live rainfall and telemetry service is protected; NCOP reads FFD's feed, public bulletins and forecasts. A written data agreement with FFD would add rainfall gauges, telemetry and archives.",
    "Reservoir operations, gate openings and water released across the border are not known in advance.",
    "Some bridges, schools and health posts are missing or misplaced in the base layers. Livestock is not counted.",
    "Levels, rain limits and actions have not been approved by FFD, PMD or the provinces.",
  ] });
  // ------------------------------------------------- annex: district briefs
  (e.briefs || []).forEach((d, i) => {
    if (!i) out.push({ chapter: { n: 7, name: "District Preparedness Briefs", kicker: "Annex: one page per district" } });
    const L = _lv(d.level), pl = d.places || {}, W1 = d.waves?.[0];
    out.push({ pageBreak: i > 0, subheading: `${d.name}, ${d.province}`, callout: { tag: L.label.toUpperCase(), color: L.color, text: d.hazards.length ? d.hazards.map((h) => `${h.hazard}: ${h.why}`).join("; ") : `No flood danger in the data now. ${_m(d.once)} of ${_m(d.people)} people live on land that has flooded since 2010.` } });
    out.push({ kpis: [{ value: _m(d.once), label: `people on land that has flooded (${_pc(d.once / Math.max(d.people, 1))} of the district) [Observed]` }, { value: _m(d.often), label: "on land flooded in 3 or more mapped years [Observed]" },
      { value: pl.schools ? `${_n(pl.schools[1])} / ${_n(pl.health?.[1] ?? 0)}` : "n/a", label: "schools / health posts on that land" }, d.sus ? { value: `${d.sus.high_pct}%`, label: "of the land floods easily (two highest classes) [Modelled]" } : { value: `${_n(d.crop_km2)} km²`, label: "cropland that has flooded [Observed]" }] });
    const f = [];
    if (d.worst.length) f.push(["Worst mapped floods", d.worst.map((x) => `${x.year}: ${_m(x.people)} people on ${_n(x.km2)} km²`).join("; ")]);
    for (const r of d.rivers) f.push([`${r.river} at ${r.station}`, `${r.state === "current" && Number.isFinite(r.q) ? `${cusecs(r.q)} cusecs now, ${_pc(r.of_low)} of its Low-flood limit (${cusecs(r.low)})` : `no current reading; Low flood starts at ${cusecs(r.low)}`}.${r.up.length ? ` Water takes about ${_join(r.up.map(([u, h]) => `${_hrs(h)} from ${u}`))}.` : ""}`]);
    if (W1) f.push([`If ${W1.station} reaches Very high (${cusecs(W1.flow)})`, `${W1.trust ? `Trust ${W1.trust.toLowerCase()}. ` : ""}First water after about ${_hrs(W1.first_h)}, half of the flooded land wet by ${_hrs(W1.half_h)}, typically ${_n(W1.depth_m, 1)} m deep; ${_m(W1.people)} people likely, ${_m(W1.people_upper)} at the outer limit [Modelled].`]);
    if (d.rain) f.push(["Rain in the next 7 days", `${_n(d.rain.sum7)} mm in total; heaviest day of the next three ${_n(d.rain.max3)} mm [Forecast].`]);
    out.push({ table: { head: ["What to know", ""], rows: f } });
    out.push({ table: { head: ["When", "What to do", "Done? (name, date)"], rows: d.ready.map((x) => [x.when, x.do, ""]) } });
  });
  if (e.briefs?.length) out.push({ body: "Briefs cover every district above Normal first, then those with most people on land that has flooded, eight in all. Emergency: NDMA 1700, Rescue 1122. Phone numbers of local teams must be added by each DDMA." });
  out.push({ heading: "References", refs: order.map((k) => SOURCES[k] || k) });
  return out;
}

export { lineChart };
export const _test = { SOURCES };
