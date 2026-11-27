// ffd-flood-limits.js
// Official FFD flood limits per river station: design capacity and the
// five discharge thresholds (Low / Medium / High / Very High / Exceptional
// flood), from the Flood Forecasting Division's "Flood Danger Levels"
// table — https://ffd.pmd.gov.pk/flood-limits (retrieved 2026-11-20).
// Published in lacs of cusecs; stored here in cusecs (1 lac = 100,000).
// null = not published by FFD for that station.
//
// A flow at or above a station's design capacity is beyond what the
// structure was built to pass: spill-over / overtopping risk.

export const FFD_FLOOD_LIMITS_SOURCE = "FFD Flood Danger Levels — ffd.pmd.gov.pk/flood-limits (retrieved 20 Nov 2026)";
const LAC = 100000;

// [river, station, design, low, medium, high, veryHigh, exceptional] in lacs
const TABLE = [
  ["Indus River", "Tarbela", 15, 2.5, 3.75, 5, 6.5, 8],
  ["Indus River", "Attock", null, 2.5, 3.75, 5, 6.5, 8],
  ["Indus River", "Kalabagh", 9.5, 2.5, 3.75, 5, 6.5, 8],
  ["Indus River", "Chashma", 9.5, 2.5, 3.75, 5, 6.5, 8],
  ["Indus River", "Taunsa", 10, 2.5, 3.75, 5, 6.5, 8],
  ["Indus River", "Guddu", 12, 2, 3.5, 5, 7, 9],
  ["Indus River", "Sukkur", 9, 2, 3.5, 5, 7, 9],
  ["Indus River", "Kotri", 8.75, 2, 3, 4.5, 6.5, 8],
  ["Kabul River", "Warsak", 5.4, 0.4, 0.6, 1, 1.5, null],
  ["Kabul River", "Nowshera", null, 0.6, 0.9, 1.4, 2, null],
  ["Jhelum River", "Kohala", null, 1, 1.5, 2, 3, 4],
  ["Jhelum River", "Mangla", 10.6, 0.75, 1.1, 1.5, 2.25, 3],
  ["Jhelum River", "Rasul", 8.5, 0.75, 1.1, 1.5, 2.25, 3],
  ["Chenab River", "Jammu Tawi", null, 0.2, 0.7, 0.83, 1.7, null],
  ["Chenab River", "Akhnur", null, 0.75, 1.97, 2.97, 3.5, null],
  ["Chenab River", "Marala", 11, 1, 1.5, 2, 4, 6],
  ["Chenab River", "Khanki", 11, 1, 1.5, 2, 4, 6],
  ["Chenab River", "Qadirabad", 9, 1, 1.5, 2, 4, 6],
  ["Chenab River", "Chiniot Bridge", 8.07, 1, 1.5, 2, 4, 6],
  ["Chenab River", "Trimmu", 8.75, 1.5, 2, 3, 4.5, 6],
  ["Chenab River", "Panjnad", 8.65, 1.5, 2.5, 4, 5.5, 7],
  ["Ravi River", "Jassar", 2.75, 0.5, 0.75, 1, 1.5, 2],
  ["Ravi River", "Syphon", 4.5, 0.4, 0.65, 0.9, 1.35, 1.8],
  ["Ravi River", "Shahdara", 2.5, 0.4, 0.65, 0.9, 1.35, 1.8],
  ["Ravi River", "Balloki", 3.8, 0.4, 0.65, 0.9, 1.35, 1.8],
  ["Ravi River", "Sidhnai", 1.5, 0.3, 0.46, 0.6, 0.9, 1.3],
  ["Sutlej River", "Suleimanki", 3.25, 0.5, 0.8, 1.2, 1.75, 2.25],
  ["Sutlej River", "Islam", 3, 0.5, 0.8, 1.2, 1.75, 2.25],
  ["Sutlej River", "G.S. Wala", null, 0.5, 0.8, 1.2, 1.75, 2.25],
];

// Same six tiers/colours as the ffd_data map layer (map-layers.js).
export const FFD_LIMIT_TIERS = [
  { key: "low", label: "Low flood", color: "#17a2b8" },
  { key: "medium", label: "Medium flood", color: "#ffc107" },
  { key: "high", label: "High flood", color: "#fd7e14" },
  { key: "very_high", label: "Very high flood", color: "#dc3545" },
  { key: "exceptional", label: "Exceptionally high flood", color: "#6f42c1" },
];
export const FFD_NORMAL_TIER = { key: "normal", label: "Normal flow", color: "#28a745" };

const toCusecs = (lacs) => (lacs == null ? null : Math.round(lacs * LAC));

function _norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
}
// Feed / history spellings that differ from FFD's table.
const ALIASES = {
  tarbeladam: "tarbela",
  mangladam: "mangla",
  newrasul: "rasul",
  sulemanki: "suleimanki",
  gandasinghwala: "gswala",
  chinotbridge: "chiniotbridge",
  chiniot: "chiniotbridge",
  akhnoor: "akhnur",
};

const BY_KEY = new Map(TABLE.map(([river, station, design, low, medium, high, veryHigh, exceptional]) => [
  _norm(station),
  {
    river, station,
    design: toCusecs(design),
    thresholds: {
      low: toCusecs(low), medium: toCusecs(medium), high: toCusecs(high),
      very_high: toCusecs(veryHigh), exceptional: toCusecs(exceptional),
    },
  },
]));

/** Limits for a station name as written in the FFD feed or history
 *  payload ("Kala Bagh", "Mangla Dam", "TARBELA"...), or null. */
export function ffdFloodLimitsFor(name) {
  const k = _norm(name);
  return BY_KEY.get(ALIASES[k] || k) || null;
}

/** FFD flood tier a discharge (cusecs) falls in, by these limits. */
export function ffdLimitTier(value, limits) {
  if (!limits || !Number.isFinite(value)) return null;
  let tier = FFD_NORMAL_TIER;
  for (const t of FFD_LIMIT_TIERS) {
    const v = limits.thresholds[t.key];
    if (v != null && value >= v) tier = t;
  }
  return tier;
}

/** Lowest threshold above `value` (the next flood tier), or null. */
export function ffdNextThreshold(value, limits) {
  if (!limits || !Number.isFinite(value)) return null;
  for (const t of FFD_LIMIT_TIERS) {
    const v = limits.thresholds[t.key];
    if (v != null && v > value) return { ...t, value: v };
  }
  return null;
}

/** Spill-over state vs design capacity: "over" (>= 100%), "near" (>= 90%),
 *  "ok", or "unknown" when FFD publishes no design capacity. */
export function ffdSpillState(value, limits) {
  if (!limits?.design || !Number.isFinite(value)) return { state: "unknown", share: null };
  const share = value / limits.design;
  return { state: share >= 1 ? "over" : share >= 0.9 ? "near" : "ok", share };
}
