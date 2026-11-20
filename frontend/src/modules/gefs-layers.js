// gefs-layers.js
// NOAA GEFS 35-day outlook over South & Southeast Asia (Iran to the
// Philippines, Nepal to Indonesia) — two temporal layers for the Weather Systems
// accordion, played on the shared temp-slider1:
//   gefs_precip_35d   daily precipitation (mm/day), days 1-35
//   gefs_t2m_35d      daily-mean 2 m temperature (°C), days 1-35
// Frames are small transparent PNGs rendered once per GEFS run by the
// backend (gefs_client.py) and loaded as Mapbox image sources. Days 1-10 use
// GEFS's 0.25 deg product, days 11-35 its 0.5 deg product (each frame has
// its own corner coordinates). Days 15-35 are extended-range guidance.

const API = `${window.location.origin}/api/gefs`;
const ATTRIBUTION = "NOAA GEFS v12 ensemble mean (NOAA Open Data on Azure)";
const MAX_BUILD_WAIT_MS = 150000;   // first-ever build on a cold server takes ~30-60 s
const CACHE_MS = 15 * 60 * 1000;
const LABEL_TARGET = 8;
// Frames are banded and near-opaque in the PNG; 0.9 keeps roads/borders faintly visible.
const FRAME_OPACITY = 0.9;

function pickLabelIndices(total, target = LABEL_TARGET) {
  if (total <= target) return null;
  const picks = new Set();
  for (let i = 0; i < target; i++) picks.add(Math.round((i * (total - 1)) / (target - 1)));
  return picks;
}

function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// GET frames; while the backend builds its first run it answers 202 —
// wait and retry instead of failing, bounded so a dead upstream ends in an
// empty layer rather than a hung slider.
async function fetchFrames(variable) {
  const started = Date.now();
  for (;;) {
    const r = await fetch(`${API}/frames/?var=${variable}`, { credentials: "same-origin" });
    if (r.status === 200) return r.json();
    if (r.status !== 202 || Date.now() - started > MAX_BUILD_WAIT_MS) throw new Error(`HTTP ${r.status}`);
    const after = Number(r.headers.get("Retry-After")) || 15;
    await wait(Math.min(after, 20) * 1000);
  }
}

// The temporal slider reads `source.id` to name the source and passes the
// object to map.addSource. Mapbox validates image sources strictly and warns
// "unknown property id", so the id is kept readable but non-enumerable: the
// slider still sees it, Mapbox's validator (which walks enumerable keys)
// does not.
function imageSource(id, url, coordinates) {
  const src = { type: "image", url, coordinates };
  Object.defineProperty(src, "id", { value: id, enumerable: false });
  return src;
}

export function gefsLayerId(variable, run, day) {
  return `gefs_${variable}_${run}_d${day}`;
}

export function generateGefsLoader(variable) {
  let cache = null;
  let cachedAt = 0;
  return async function loadGefs() {
    if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
    let data;
    try {
      data = await fetchFrames(variable);
    } catch (e) {
      console.warn(`[gefs] ${variable} outlook unavailable:`, e);
      return [];
    }
    const list = data.frames || [];
    const showAt = pickLabelIndices(list.length);
    const frames = list.map((f, i) => {
      const id = gefsLayerId(variable, data.run, f.day);
      return {
        source: imageSource(id, f.url, f.coordinates || data.coordinates),
        layers: [{
          id, type: "raster", source: id, layout: { visibility: "visible" }, metadata: { "ncop:opacity": FRAME_OPACITY },
          paint: { "raster-opacity": i === 0 ? FRAME_OPACITY : 0, "raster-fade-duration": 250, "raster-resampling": "linear" },
        }],
        date: showAt === null || showAt.has(i) ? `D${f.day}` : "",
        dateFull: `Day ${f.day} · ${dayLabel(f.valid_start)}${f.resolution_deg ? ` · ${f.resolution_deg}°` : ""}${f.extended ? " · extended range" : ""} (run ${String(data.run).slice(0, 8)})`,
        gefsDay: f.day,
      };
    });
    frames.initialIndex = 0;
    cache = frames;
    cachedAt = Date.now();
    return frames;
  };
}

export const gefsTemporalItems = {
  gefs_precip_35d: {
    label: "GEFS Precipitation — 35-Day Outlook",
    thumbnail: "gefs_precip_35d.webp",
    type: "raster",
    theme: "slider",
    title: "GEFS daily precipitation (mm/day) — 35 days",
    information:
      "NOAA GEFS v12 ensemble-mean daily precipitation for the next 35 days across South & Southeast Asia — Iran, Afghanistan, Pakistan, India, Nepal, Bhutan, Bangladesh, Sri Lanka, the Maldives, Myanmar, Thailand, Indochina, Malaysia, Indonesia and the Philippines (00Z run). Days 1-10 at 0.25° (~27 km), days 11-35 at 0.5°. Days 1-14 are medium-range forecasts; days 15-35 are extended-range guidance — read them as weekly tendencies, not exact daily amounts. Click the map for the value and the 7-day total. Data: NOAA GEFS via NOAA Open Data on Azure (Microsoft Planetary Computer).",
  },
  gefs_t2m_35d: {
    label: "GEFS 2m Temperature — 35-Day Outlook",
    thumbnail: "gefs_t2m_35d.webp",
    type: "raster",
    theme: "slider",
    title: "GEFS daily-mean 2 m temperature (°C) — 35 days",
    information:
      "NOAA GEFS v12 ensemble-mean daily-mean 2 m temperature for the next 35 days across South & Southeast Asia, from Iran to the Philippines and Nepal to Indonesia (00Z run). Days 1-10 at 0.25° (~27 km), days 11-35 at 0.5°. Days 15-35 are extended-range guidance. Click the map for the value at a point. Data: NOAA GEFS via NOAA Open Data on Azure (Microsoft Planetary Computer).",
  },
};

export function registerGefsTemporalLoaders() {
  window.gefs_precip_35d = generateGefsLoader("precip");
  window.gefs_t2m_35d = generateGefsLoader("t2m");
}

// ---------------------------------------------------------------------------
// Click on a GEFS frame → value at that point for the shown day
// ---------------------------------------------------------------------------
const ID_RE = /^gefs_(precip|t2m)_\d{10}_d(\d{1,2})$/;

function activeGefsFrame(map) {
  for (const l of map.getStyle()?.layers || []) {
    const m = ID_RE.exec(l.id);
    if (!m) continue;
    const op = map.getPaintProperty(l.id, "raster-opacity");
    if (typeof op === "number" && op > 0.01) return { variable: m[1], day: Number(m[2]) };
  }
  return null;
}

let _clickInstalled = false;
export function installGefsClick(map, mapboxgl) {
  if (_clickInstalled || !map || !mapboxgl) return;
  _clickInstalled = true;
  let popup = null;
  map.on("click", async (e) => {
    const frame = activeGefsFrame(map);
    if (!frame) return;
    // Vector features (stations, gauges ...) keep their own popups.
    if (map.queryRenderedFeatures(e.point).some((f) => f.layer?.type !== "raster" && !f.layer?.id?.startsWith("mapbox"))) return;
    const { lng, lat } = e.lngLat;
    try {
      const r = await fetch(`${API}/point/?var=${frame.variable}&day=${frame.day}&lat=${lat.toFixed(3)}&lon=${lng.toFixed(3)}`, { credentials: "same-origin" });
      if (!r.ok) return;
      const d = await r.json();
      const name = frame.variable === "precip" ? "Precipitation" : "2 m temperature (daily mean)";
      const value = d.value == null ? "outside the GEFS window" : `${d.value} ${d.unit}`;
      const week = frame.variable === "precip" && d.week_total != null ? `<div class="ncop-popup__status-note" style="display:block;">7-day total (week of day ${frame.day}): <b>${d.week_total} mm</b></div>` : "";
      if (popup) popup.remove();
      popup = new mapboxgl.Popup({ closeButton: true, className: "ncop-popup-host", maxWidth: "260px" })
        .setLngLat(e.lngLat)
        .setHTML(`<div class="ncop-popup"><div class="ncop-popup__title">GEFS ${name} — day ${frame.day}</div>
          <div class="ncop-popup__subtitle" style="font-size:15px;font-weight:700;margin:4px 0;">${value}</div>${week}
          <div class="ncop-popup__status-note" style="display:block;">${d.extended ? "Extended-range guidance (low daily skill). " : ""}Ensemble mean, ${d.resolution_deg ?? 0.5}° grid · ${ATTRIBUTION}</div></div>`)
        .addTo(map);
    } catch (err) {
      console.warn("[gefs] point value failed", err);
    }
  });
}
