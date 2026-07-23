// Consolidated map icon registry — all raster/canvas icons that get
// registered on the Mapbox map via map.addImage().
//
// Four logical groups (preserved from the original per-domain modules):
//   1. Static asset icons (airport, school, settlement, weather-station)
//   2. EONET event badges (storms, wildfires, volcanoes, earthquakes, ice)
//   3. PMD weather icons (animated sun + rain)
//   4. USGS earthquake magnitude pulses (low/moderate/strong/major)
//
// Public API (unchanged from the pre-merge modules):
//   - map_icons                   (static asset map)
//   - EONET_ICON_IDS              (id dictionary)
//   - registerEonetIcons(map)     (idempotent register)
//   - PMD_SUN_ICON_ID             (string id)
//   - PMD_RAIN_ICON_ID            (string id)
//   - registerPMDWeatherIcons(map)
//   - USGS_ICON_IDS               (id dictionary)
//   - registerUsgsEarthquakeIcons(map)

import { NWFC_WEATHER_ICON_URLS } from "./nwfc-weather-icons.js";

import airportIcon from "@assets/images/map_icons/airplane.webp";
import schoolIcon from "@assets/images/map_icons/school.webp";
import settlementIcon from "@assets/images/map_icons/settlements.webp";
import weatherStationIcon from "@assets/images/map_icons/weather-station.webp";

// ===========================================================================
// 1. Static asset icons
// ===========================================================================
export const map_icons = {
    airportIcon,
    schoolIcon,
    settlementIcon,
    weatherStationIcon,
};

// ===========================================================================
// 2. EONET event badges (64x64 canvas-painted)
// ===========================================================================
const EONET_ICON_SIZE = 64;

export const EONET_ICON_IDS = {
  all: "eonet-icon-all",
  severeStorms: "eonet-icon-severe-storms",
  wildfires: "eonet-icon-wildfires",
  volcanoes: "eonet-icon-volcanoes",
  earthquakes: "eonet-icon-earthquakes",
  seaLakeIce: "eonet-icon-sea-lake-ice",
};

function eonetImageDataFromCanvas(drawFn) {
  const canvas = document.createElement("canvas");
  canvas.width = EONET_ICON_SIZE;
  canvas.height = EONET_ICON_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  drawFn(ctx);
  const imageData = ctx.getImageData(0, 0, EONET_ICON_SIZE, EONET_ICON_SIZE);
  return {
    width: EONET_ICON_SIZE,
    height: EONET_ICON_SIZE,
    data: imageData.data,
  };
}

function drawEonetBadge(ctx, fill, stroke) {
  ctx.clearRect(0, 0, EONET_ICON_SIZE, EONET_ICON_SIZE);
  ctx.beginPath();
  ctx.arc(EONET_ICON_SIZE / 2, EONET_ICON_SIZE / 2, 22, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawEonetAll(ctx) {
  drawEonetBadge(ctx, "#0f172a", "#38bdf8");
  ctx.strokeStyle = "#e0f2fe";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(32, 32, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(21, 32);
  ctx.lineTo(43, 32);
  ctx.moveTo(32, 21);
  ctx.lineTo(32, 43);
  ctx.moveTo(24, 24);
  ctx.lineTo(40, 40);
  ctx.moveTo(40, 24);
  ctx.lineTo(24, 40);
  ctx.stroke();
}

function drawEonetStorm(ctx) {
  drawEonetBadge(ctx, "#1e3a8a", "#60a5fa");
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(26, 31, 8, Math.PI * 0.9, Math.PI * 1.95);
  ctx.arc(35, 28, 10, Math.PI, 0);
  ctx.arc(43, 31, 7, Math.PI * 1.1, Math.PI * 1.95);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(31, 36);
  ctx.lineTo(27, 45);
  ctx.lineTo(33, 45);
  ctx.lineTo(29, 53);
  ctx.stroke();
}

function drawEonetFire(ctx) {
  drawEonetBadge(ctx, "#7f1d1d", "#fb923c");
  ctx.fillStyle = "#fde68a";
  ctx.beginPath();
  ctx.moveTo(32, 16);
  ctx.bezierCurveTo(42, 24, 45, 33, 39, 43);
  ctx.bezierCurveTo(35, 50, 29, 50, 25, 44);
  ctx.bezierCurveTo(20, 37, 21, 29, 32, 16);
  ctx.fill();
  ctx.fillStyle = "#f97316";
  ctx.beginPath();
  ctx.moveTo(32, 24);
  ctx.bezierCurveTo(38, 29, 39, 35, 35, 40);
  ctx.bezierCurveTo(33, 43, 30, 43, 28, 39);
  ctx.bezierCurveTo(25, 35, 26, 31, 32, 24);
  ctx.fill();
}

function drawEonetVolcano(ctx) {
  drawEonetBadge(ctx, "#581c87", "#c084fc");
  ctx.fillStyle = "#d1d5db";
  ctx.beginPath();
  ctx.moveTo(19, 46);
  ctx.lineTo(29, 26);
  ctx.lineTo(35, 26);
  ctx.lineTo(45, 46);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.moveTo(30, 24);
  ctx.lineTo(34, 16);
  ctx.lineTo(38, 24);
  ctx.closePath();
  ctx.fill();
}

function drawEonetQuake(ctx) {
  drawEonetBadge(ctx, "#78350f", "#facc15");
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(18, 37);
  ctx.lineTo(26, 30);
  ctx.lineTo(31, 36);
  ctx.lineTo(37, 25);
  ctx.lineTo(45, 33);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(20, 45);
  ctx.lineTo(44, 45);
  ctx.stroke();
}

function drawEonetIce(ctx) {
  drawEonetBadge(ctx, "#164e63", "#67e8f9");
  ctx.strokeStyle = "#ecfeff";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  const c = 32;
  ctx.beginPath();
  ctx.moveTo(c, 17);
  ctx.lineTo(c, 47);
  ctx.moveTo(17, c);
  ctx.lineTo(47, c);
  ctx.moveTo(22, 22);
  ctx.lineTo(42, 42);
  ctx.moveTo(42, 22);
  ctx.lineTo(22, 42);
  ctx.stroke();
}

export function registerEonetIcons(map) {
  if (!map) return;
  const defs = [
    [EONET_ICON_IDS.all, drawEonetAll],
    [EONET_ICON_IDS.severeStorms, drawEonetStorm],
    [EONET_ICON_IDS.wildfires, drawEonetFire],
    [EONET_ICON_IDS.volcanoes, drawEonetVolcano],
    [EONET_ICON_IDS.earthquakes, drawEonetQuake],
    [EONET_ICON_IDS.seaLakeIce, drawEonetIce],
  ];
  defs.forEach(([id, drawFn]) => {
    if (!map.hasImage(id)) {
      map.addImage(id, eonetImageDataFromCanvas(drawFn));
    }
  });
}

// ===========================================================================
// 3. PMD weather icons (96x96 canvas — sun is static, rain is animated)
// ===========================================================================
export const PMD_SUN_ICON_ID = "pmd-weather-sun-animated";
export const PMD_RAIN_ICON_ID = "pmd-weather-rain-animated";
const PMD_ICON_SIZE = 96;

function drawPMDSunIcon(ctx) {
  const center = PMD_ICON_SIZE / 2;
  const innerRadius = 18;
  const outerRadius = 32;

  ctx.clearRect(0, 0, PMD_ICON_SIZE, PMD_ICON_SIZE);

  const glow = ctx.createRadialGradient(center, center, 8, center, center, 38);
  glow.addColorStop(0, "rgba(250, 204, 21, 0.65)");
  glow.addColorStop(1, "rgba(250, 204, 21, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(center, center, 38, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  for (let i = 0; i < 8; i += 1) {
    const angle = (Math.PI * 2 * i) / 8;
    const x1 = center + Math.cos(angle) * 25;
    const y1 = center + Math.sin(angle) * 25;
    const x2 = center + Math.cos(angle) * outerRadius;
    const y2 = center + Math.sin(angle) * outerRadius;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  const sunGradient = ctx.createRadialGradient(center - 4, center - 6, 4, center, center, 22);
  sunGradient.addColorStop(0, "#fff7bf");
  sunGradient.addColorStop(0.6, "#facc15");
  sunGradient.addColorStop(1, "#f59e0b");
  ctx.fillStyle = sunGradient;
  ctx.beginPath();
  ctx.arc(center, center, innerRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(center, center, innerRadius, 0, Math.PI * 2);
  ctx.strokeStyle = "#b45309";
  ctx.lineWidth = 5;
  ctx.stroke();
}

function drawPMDRainIcon(ctx, time) {
  const centerX = PMD_ICON_SIZE / 2;
  const cloudY = 36;
  const cloudPulse = Math.sin(time * 2.4) * 1.5;

  ctx.clearRect(0, 0, PMD_ICON_SIZE, PMD_ICON_SIZE);

  ctx.fillStyle = "rgba(30, 41, 59, 0.15)";
  ctx.beginPath();
  ctx.ellipse(centerX, 70, 22, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#cbd5e1";
  ctx.beginPath();
  ctx.arc(centerX - 18, cloudY + 4 + cloudPulse, 14, Math.PI * 0.95, Math.PI * 1.95);
  ctx.arc(centerX, cloudY - 5 + cloudPulse, 18, Math.PI, 0);
  ctx.arc(centerX + 18, cloudY + 3 + cloudPulse, 13, Math.PI * 1.05, Math.PI * 1.95);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#94a3b8";
  ctx.beginPath();
  ctx.roundRect(centerX - 30, cloudY + 2 + cloudPulse, 60, 18, 9);
  ctx.fill();

  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";

  const dropOffsets = [-16, 0, 16];
  dropOffsets.forEach((offset, index) => {
    const fall = ((time * 28 + index * 9) % 18);
    const startY = 54 + fall;
    ctx.beginPath();
    ctx.moveTo(centerX + offset, startY);
    ctx.lineTo(centerX + offset - 4, startY + 10);
    ctx.stroke();
  });
}

function createPMDAnimatedImage(drawFrame) {
  return {
    width: PMD_ICON_SIZE,
    height: PMD_ICON_SIZE,
    data: new Uint8Array(PMD_ICON_SIZE * PMD_ICON_SIZE * 4),
    onAdd(map) {
      this.map = map;
      this.canvas = document.createElement("canvas");
      this.canvas.width = PMD_ICON_SIZE;
      this.canvas.height = PMD_ICON_SIZE;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    },
    render() {
      const time = performance.now() / 1000;
      drawFrame(this.ctx, time);
      this.data = this.ctx.getImageData(0, 0, PMD_ICON_SIZE, PMD_ICON_SIZE).data;
      this.map.triggerRepaint();
      return true;
    },
  };
}

function createPMDStaticSunCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = PMD_ICON_SIZE;
  canvas.height = PMD_ICON_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  drawPMDSunIcon(ctx);
  return ctx.getImageData(0, 0, PMD_ICON_SIZE, PMD_ICON_SIZE);
}

export function registerPMDWeatherIcons(map) {
  if (!map) return;

  if (!map.hasImage(PMD_SUN_ICON_ID)) {
    map.addImage(PMD_SUN_ICON_ID, createPMDStaticSunCanvas());
  }

  if (!map.hasImage(PMD_RAIN_ICON_ID)) {
    map.addImage(PMD_RAIN_ICON_ID, createPMDAnimatedImage(drawPMDRainIcon));
  }
}

// ===========================================================================
// NWFC weather emoji markers (per-condition emoji rendered onto a 72×72 halo
// canvas).  Each icon id is a stable string so the layer style can reference
// them via `["get", "wx_icon"]` after the normaliser stamps the right id
// onto every feature — see gcop-monitor-integration.js.
// ===========================================================================
export const NWFC_WX_ICON_IDS = {
  thunderstorm:  "nwfc-wx-thunderstorm",
  rain:          "nwfc-wx-rain",
  drizzle:       "nwfc-wx-drizzle",
  snow:          "nwfc-wx-snow",
  fog:           "nwfc-wx-fog",
  dust:          "nwfc-wx-dust",
  overcast:      "nwfc-wx-overcast",
  cloudy:        "nwfc-wx-cloudy",
  partly_cloudy: "nwfc-wx-partly-cloudy",
  clear:         "nwfc-wx-clear",
  windy:         "nwfc-wx-windy",
  hot:           "nwfc-wx-hot",
  cold:          "nwfc-wx-cold",
  default:       "nwfc-wx-default",
};

const NWFC_WX_SIZE = 96;

// ---------------------------------------------------------------------------
// Weather-icon drawing primitives.  Each `drawFrame(ctx, t)` is called
// every render tick by the StyleImageInterface below with `t` = seconds
// since page load, so any position/opacity/rotation derived from `t` will
// animate smoothly on the map.  All coordinates assume a NWFC_WX_SIZE ×
// NWFC_WX_SIZE canvas.
// ---------------------------------------------------------------------------

function nwfcDrawHalo(ctx) {
  // Soft white halo behind every icon — improves legibility on dark
  // and satellite basemaps without washing out on light ones.
  const cx = NWFC_WX_SIZE / 2;
  const cy = NWFC_WX_SIZE / 2;
  const g = ctx.createRadialGradient(cx, cy, 8, cx, cy, NWFC_WX_SIZE / 2);
  g.addColorStop(0, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, NWFC_WX_SIZE / 2, 0, Math.PI * 2);
  ctx.fill();
}

function nwfcDrawCloud(ctx, cx, cy, scale = 1, tone = "light") {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  const body = tone === "dark" ? "#64748b" : "#cbd5e1";
  const high = tone === "dark" ? "#94a3b8" : "#f1f5f9";
  const edge = tone === "dark" ? "#475569" : "#94a3b8";
  ctx.fillStyle = body;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(-16, 4, 12, 0, Math.PI * 2);
  ctx.arc(-4, -10, 15, 0, Math.PI * 2);
  ctx.arc(10, -6, 14, 0, Math.PI * 2);
  ctx.arc(16, 8, 12, 0, Math.PI * 2);
  ctx.arc(-6, 10, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = high;
  ctx.beginPath();
  ctx.arc(-8, -8, 6, 0, Math.PI * 2);
  ctx.arc(6, -4, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function nwfcDrawSun(ctx, cx, cy, t, size = 22) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.35);
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * 2 * i) / 8;
    const pulse = 1 + Math.sin(t * 2 + i * 0.7) * 0.08;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * (size + 4), Math.sin(angle) * (size + 4));
    ctx.lineTo(Math.cos(angle) * (size + 12) * pulse, Math.sin(angle) * (size + 12) * pulse);
    ctx.stroke();
  }
  ctx.restore();

  const g = ctx.createRadialGradient(cx - 4, cy - 4, 3, cx, cy, size);
  g.addColorStop(0, "#fef9c3");
  g.addColorStop(0.55, "#facc15");
  g.addColorStop(1, "#f59e0b");
  ctx.fillStyle = g;
  ctx.strokeStyle = "#b45309";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, size - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function nwfcDrawRainDrops(ctx, t, cfg) {
  const { count = 3, startY = 58, endY = 88, speed = 2.2, spread = 42, x0 = 27 } = cfg || {};
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const x = x0 + (spread / (count - 1 || 1)) * i;
    const cycle = ((t * speed + i * 0.42) % 1);
    const y = startY + cycle * (endY - startY);
    // Head-in / tail-out fade so drops don't pop.
    const opacity = cycle < 0.85 ? 1 : Math.max(0, 1 - (cycle - 0.85) * 6.7);
    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 3, y + 9);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function nwfcDrawSnowflake(ctx, x, y, size, rotation) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.strokeStyle = "rgba(255,255,255,0.98)";
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate((Math.PI * 2 * i) / 6);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, size);
    ctx.moveTo(0, size * 0.6);
    ctx.lineTo(-size * 0.28, size * 0.75);
    ctx.moveTo(0, size * 0.6);
    ctx.lineTo(size * 0.28, size * 0.75);
    ctx.stroke();
    ctx.restore();
  }
  // Little outline so flakes stay legible on white basemap
  ctx.strokeStyle = "rgba(30,58,138,0.35)";
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate((Math.PI * 2 * i) / 6);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, size);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

// Frame drawers keyed by icon slug — every `NWFC_WX_ICON_IDS` entry must
// have a matching drawer here.
const NWFC_DRAW_FRAMES = {
  clear(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    nwfcDrawSun(ctx, NWFC_WX_SIZE / 2, NWFC_WX_SIZE / 2, t, 24);
  },
  hot(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    nwfcDrawSun(ctx, NWFC_WX_SIZE / 2, NWFC_WX_SIZE / 2 - 6, t, 20);
    // Heat waves rippling below the sun
    ctx.strokeStyle = "rgba(239, 68, 68, 0.85)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (let i = 0; i < 3; i++) {
      const y = 66 + i * 8;
      const phase = t * 2 + i * 0.6;
      ctx.beginPath();
      ctx.moveTo(24, y);
      ctx.bezierCurveTo(
        38, y - 5 + Math.sin(phase) * 2,
        58, y + 5 + Math.cos(phase) * 2,
        72, y
      );
      ctx.stroke();
    }
  },
  cloudy(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    const drift = Math.sin(t * 0.5) * 3;
    nwfcDrawCloud(ctx, NWFC_WX_SIZE / 2 + drift, NWFC_WX_SIZE / 2, 1.4);
  },
  overcast(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    const drift = Math.sin(t * 0.35) * 2.5;
    // Two overlapping darker clouds for a heavy-overcast feel.
    nwfcDrawCloud(ctx, NWFC_WX_SIZE / 2 - 6 + drift, NWFC_WX_SIZE / 2 - 4, 1.15, "dark");
    nwfcDrawCloud(ctx, NWFC_WX_SIZE / 2 + 4 - drift, NWFC_WX_SIZE / 2 + 10, 1.2, "dark");
  },
  partly_cloudy(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    nwfcDrawSun(ctx, NWFC_WX_SIZE / 2 - 14, NWFC_WX_SIZE / 2 - 10, t, 16);
    const drift = Math.sin(t * 0.55) * 2;
    nwfcDrawCloud(ctx, NWFC_WX_SIZE / 2 + 10 + drift, NWFC_WX_SIZE / 2 + 10, 1);
  },
  rain(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    nwfcDrawCloud(ctx, NWFC_WX_SIZE / 2, 36, 1.25);
    nwfcDrawRainDrops(ctx, t, { count: 4, startY: 56, endY: 88, speed: 2.4, spread: 44, x0: 26 });
  },
  drizzle(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    nwfcDrawSun(ctx, NWFC_WX_SIZE - 22, 26, t, 12);
    nwfcDrawCloud(ctx, NWFC_WX_SIZE / 2 - 4, 42, 1.15);
    nwfcDrawRainDrops(ctx, t, { count: 2, startY: 60, endY: 82, speed: 1.6, spread: 24, x0: 34 });
  },
  thunderstorm(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    nwfcDrawCloud(ctx, NWFC_WX_SIZE / 2, 34, 1.3, "dark");
    // Rain drops behind the bolt.
    nwfcDrawRainDrops(ctx, t, { count: 3, startY: 60, endY: 88, speed: 2.6, spread: 44, x0: 26 });
    // Lightning that flashes rhythmically.
    const flashPhase = (t * 1.5) % 2;
    const flashing = flashPhase < 0.18;
    ctx.save();
    if (flashing) {
      ctx.shadowColor = "#fef08a";
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = flashing ? "#fef08a" : "#facc15";
    ctx.strokeStyle = "#b45309";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(54, 44);
    ctx.lineTo(40, 64);
    ctx.lineTo(48, 64);
    ctx.lineTo(36, 84);
    ctx.lineTo(58, 60);
    ctx.lineTo(48, 60);
    ctx.lineTo(54, 44);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  },
  snow(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    nwfcDrawCloud(ctx, NWFC_WX_SIZE / 2, 34, 1.2);
    // Falling flakes with slight sway
    const cfg = [
      { x: 30, offset: 0.0, size: 5 },
      { x: 46, offset: 0.35, size: 4 },
      { x: 62, offset: 0.7, size: 5 },
      { x: 38, offset: 0.55, size: 3 },
    ];
    for (const s of cfg) {
      const cycle = ((t * 0.85 + s.offset) % 1);
      const y = 58 + cycle * 30;
      const sway = Math.sin(t + s.offset * Math.PI * 2) * 3;
      nwfcDrawSnowflake(ctx, s.x + sway, y, s.size, t * (s.offset < 0.5 ? 1.2 : -1.2));
    }
  },
  cold(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    // Central flake
    nwfcDrawSnowflake(ctx, NWFC_WX_SIZE / 2, NWFC_WX_SIZE / 2, 16, t * 0.4);
    // Orbiting small flakes
    for (let i = 0; i < 4; i++) {
      const angle = (Math.PI * 2 * i) / 4 + t * 1.1;
      const r = 32;
      const x = NWFC_WX_SIZE / 2 + Math.cos(angle) * r;
      const y = NWFC_WX_SIZE / 2 + Math.sin(angle) * r;
      nwfcDrawSnowflake(ctx, x, y, 4, -t);
    }
  },
  fog(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      const y = 28 + i * 12;
      const drift = Math.sin(t * 0.4 + i * 0.7) * 10;
      const start = 12 + drift;
      const end = NWFC_WX_SIZE - 12 + drift;
      // Layered: dark stroke underneath, light stroke on top for depth.
      ctx.strokeStyle = "rgba(148, 163, 184, 0.85)";
      ctx.beginPath();
      ctx.moveTo(start, y);
      ctx.lineTo(end - 24, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(end - 14, y);
      ctx.lineTo(end, y);
      ctx.stroke();
      ctx.strokeStyle = "rgba(241, 245, 249, 0.75)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(start + 4, y);
      ctx.lineTo(end - 28, y);
      ctx.stroke();
      ctx.lineWidth = 7;
    }
  },
  windy(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.95)";
    ctx.lineWidth = 4.5;
    ctx.lineCap = "round";
    // Three wind streaks sweeping across
    for (let i = 0; i < 3; i++) {
      const y = 32 + i * 15;
      const period = NWFC_WX_SIZE + 40;
      const offset = ((t * 22 + i * 26) % period) - 20;
      ctx.beginPath();
      ctx.moveTo(offset, y);
      ctx.bezierCurveTo(offset + 18, y - 7, offset + 36, y + 7, offset + 54, y);
      ctx.stroke();
      // Arrow head
      ctx.beginPath();
      ctx.moveTo(offset + 54, y);
      ctx.lineTo(offset + 46, y - 4);
      ctx.moveTo(offset + 54, y);
      ctx.lineTo(offset + 46, y + 4);
      ctx.stroke();
    }
  },
  dust(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    // Base amber "haze" wash
    ctx.fillStyle = "rgba(202, 138, 4, 0.20)";
    ctx.beginPath();
    ctx.arc(NWFC_WX_SIZE / 2, NWFC_WX_SIZE / 2, 34, 0, Math.PI * 2);
    ctx.fill();
    // Swirling dust particles
    for (let i = 0; i < 16; i++) {
      const angle = (Math.PI * 2 * i) / 16 + t * 1.4;
      const r = 22 + Math.sin(t * 1.5 + i) * 8;
      const x = NWFC_WX_SIZE / 2 + Math.cos(angle) * r;
      const y = NWFC_WX_SIZE / 2 + Math.sin(angle) * r;
      const s = 2 + Math.sin(t * 3 + i * 0.4) * 1.2;
      ctx.fillStyle = `rgba(202, 138, 4, ${0.55 + Math.sin(t + i) * 0.25})`;
      ctx.beginPath();
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  default(ctx, t) {
    ctx.clearRect(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE);
    nwfcDrawHalo(ctx);
    const cx = NWFC_WX_SIZE / 2;
    const cy = NWFC_WX_SIZE / 2;
    ctx.save();
    ctx.translate(cx, cy);
    // Thermometer body
    ctx.fillStyle = "#f8fafc";
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-7, -28, 14, 44, 7);
    else { ctx.rect(-7, -28, 14, 44); }
    ctx.fill();
    ctx.stroke();
    // Pulsing bulb
    const pulse = 1 + Math.sin(t * 2.4) * 0.09;
    ctx.fillStyle = "#ef4444";
    ctx.strokeStyle = "#991b1b";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 22, 12 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Mercury column
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-3, -22, 6, 42, 3);
    else { ctx.rect(-3, -22, 6, 42); }
    ctx.fill();
    ctx.restore();
  },
};

// Wire each icon slug to a drawer.  When the slug lacks a bespoke drawer
// (shouldn't happen for the defined fleet, but defensive) fall back to
// the "default" thermometer.
NWFC_DRAW_FRAMES.thunderstorm = NWFC_DRAW_FRAMES.thunderstorm;
const NWFC_DRAWERS = {
  thunderstorm:  NWFC_DRAW_FRAMES.thunderstorm,
  rain:          NWFC_DRAW_FRAMES.rain,
  drizzle:       NWFC_DRAW_FRAMES.drizzle,
  snow:          NWFC_DRAW_FRAMES.snow,
  fog:           NWFC_DRAW_FRAMES.fog,
  dust:          NWFC_DRAW_FRAMES.dust,
  overcast:      NWFC_DRAW_FRAMES.overcast,
  cloudy:        NWFC_DRAW_FRAMES.cloudy,
  partly_cloudy: NWFC_DRAW_FRAMES.partly_cloudy,
  clear:         NWFC_DRAW_FRAMES.clear,
  windy:         NWFC_DRAW_FRAMES.windy,
  hot:           NWFC_DRAW_FRAMES.hot,
  cold:          NWFC_DRAW_FRAMES.cold,
  default:       NWFC_DRAW_FRAMES.default,
};

// StyleImageInterface — Mapbox calls render() every frame so time-based
// animations play back smoothly.  Same pattern as createPMDAnimatedImage.
function createNwfcAnimatedImage(drawFrame) {
  return {
    width: NWFC_WX_SIZE,
    height: NWFC_WX_SIZE,
    data: new Uint8Array(NWFC_WX_SIZE * NWFC_WX_SIZE * 4),
    onAdd(map) {
      this.map = map;
      this.canvas = document.createElement("canvas");
      this.canvas.width = NWFC_WX_SIZE;
      this.canvas.height = NWFC_WX_SIZE;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    },
    render() {
      const t = performance.now() / 1000;
      drawFrame(this.ctx, t);
      this.data = this.ctx.getImageData(0, 0, NWFC_WX_SIZE, NWFC_WX_SIZE).data;
      this.map.triggerRepaint();
      return true;
    },
  };
}

/**
 * Register every NWFC animated weather icon with the map.  Idempotent —
 * safe to call on every map load / style.load event because `hasImage`
 * short-circuits already-registered ids.  Uses NCOP's existing
 * StyleImageInterface pattern (see createPMDAnimatedImage) so every
 * frame is a live canvas repaint — no external image resources, no
 * CORS/CSP concerns, animates on every basemap.
 */
// ---------------------------------------------------------------------------
// NWFC weather sprite loader.
//
// Strategy: for every one of the 13 buckets that has a GIF/PNG asset,
// load it via fetch() → Blob → createImageBitmap → map.addImage.  This
// pipeline is completely CORS-safe:
//
//   - fetch(mode:'cors', cache:'reload') forces a fresh CORS-enforced
//     request, ignoring any prior cached copy the browser may have
//     stored without CORS approval.
//   - Blob has no origin association — pure bytes.
//   - createImageBitmap(blob) decodes those bytes into an ImageBitmap.
//     Per HTML spec, ImageBitmaps constructed from Blobs are ALWAYS
//     origin-clean, so Mapbox's internal getImageData() cannot throw
//     SecurityError.
//
// The DEFAULT bucket has no asset and keeps the hand-drawn thermometer
// canvas so any weather string the dispatcher can't classify still gets
// a visible icon.
// ---------------------------------------------------------------------------

const _NWFC_ICON_TO_BUCKET = Object.fromEntries(
  Object.entries(NWFC_WX_ICON_IDS).map(([bucket, id]) => [id, bucket])
);

// Session-scoped tag for the fetch() cache-buster.  A fresh tag per
// page load, but stable within the session so subsequent hits are
// served from the browser's HTTP cache normally.
const _NWFC_SESSION_TAG = Date.now();

function _nwfcLoadSprite(map, bucket, iconId, url, state) {
  const started = performance.now();
  const bustUrl = url + (url.includes("?") ? "&" : "?") + "_cors=" + _NWFC_SESSION_TAG;

  return fetch(bustUrl, {
    mode: "cors",
    credentials: "omit",
    cache: "reload",
    headers: { Accept: "image/*" },
  })
    .then((resp) => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return resp.blob();
    })
    .then((blob) => createImageBitmap(blob))
    .then((bitmap) => {
      if (map.hasImage(iconId)) return;
      try {
        map.addImage(iconId, bitmap);
        state.registered.push({ iconId, bucket, url, ms: Math.round(performance.now() - started) });
      } catch (err) {
        state.failed.push({ iconId, url, stage: "addImage", reason: err?.message || String(err) });
      }
    })
    .catch((err) => {
      state.failed.push({ iconId, url, stage: "fetch/bitmap", reason: err?.message || String(err) });
    });
}

export function registerNwfcWeatherIcons(map) {
  if (!map || typeof map.addImage !== "function") return;

  const state = {
    registered: [],
    failed: [],
    alreadyRegistered: [],
  };

  const pending = [];
  for (const [bucket, iconId] of Object.entries(NWFC_WX_ICON_IDS)) {
    if (map.hasImage(iconId)) {
      state.alreadyRegistered.push(iconId);
      continue;
    }
    const url = NWFC_WEATHER_ICON_URLS[bucket];
    if (url) {
      pending.push(_nwfcLoadSprite(map, bucket, iconId, url, state));
      continue;
    }
    // DEFAULT bucket — no asset, use canvas thermometer.
    try {
      const draw = NWFC_DRAWERS[bucket] || NWFC_DRAWERS.default;
      map.addImage(iconId, createNwfcAnimatedImage(draw));
      state.registered.push({ iconId, bucket, url: "(canvas fallback)", ms: 0 });
    } catch (err) {
      state.failed.push({ iconId, url: "(canvas fallback)", stage: "canvas", reason: err?.message || String(err) });
    }
  }

  Promise.allSettled(pending).then(() => {
    try { map.triggerRepaint(); } catch (_) {}
  });

  // Style-image-missing safety net — quietly re-registers any sprite
  // Mapbox asks for that isn't in the atlas yet (typically because a
  // basemap swap evicted it).
  if (!map.__nwfcMissingHandlerInstalled) {
    map.__nwfcMissingHandlerInstalled = true;
    map.on("styleimagemissing", (e) => {
      const id = e?.id;
      if (!id || !id.startsWith("nwfc-wx-")) return;
      const bucket = _NWFC_ICON_TO_BUCKET[id];
      if (!bucket) return;
      const url = NWFC_WEATHER_ICON_URLS[bucket];
      if (url) {
        _nwfcLoadSprite(map, bucket, id, url, state);
      } else {
        try {
          const draw = NWFC_DRAWERS[bucket] || NWFC_DRAWERS.default;
          map.addImage(id, createNwfcAnimatedImage(draw));
        } catch (_) {}
      }
    });
  }
}

/**
 * Map an upstream weather description (string like "Thunderstorm",
 * "Light Rain", "Partly Cloudy") to a bucket key
 * ("thunderstorm" | "rain" | "drizzle" | "snow" | "fog" | "dust" |
 * "overcast" | "cloudy" | "partly_cloudy" | "clear" | "windy" |
 * "hot" | "cold" | "default").  Returns "default" when the text is
 * empty / unrecognised.
 *
 * Consumer:
 *  - `nwfcWeatherIconId` below → maps to the Mapbox icon-id form.
 */
export function nwfcWeatherBucket(text) {
  if (text == null) return "default";
  const s = String(text).toLowerCase().trim();
  if (!s) return "default";
  if (/thunder|lightning/.test(s))            return "thunderstorm";
  if (/drizzle/.test(s))                      return "drizzle";
  if (/shower|rain/.test(s))                  return "rain";
  if (/snow|blizzard|sleet|hail/.test(s))     return "snow";
  if (/fog|mist|haze/.test(s))                return "fog";
  if (/dust|sandstorm/.test(s))               return "dust";
  if (/partl?y.*cloud|part.*cloud/.test(s))   return "partly_cloudy";
  if (/overcast/.test(s))                     return "overcast";
  // METAR aviation cloud-cover codes — PMD's NWFC scrape emits these
  // literally (e.g. "SCT at 4000 feet", "BKN at 3500 feet", "OVC …").
  // Checked BEFORE the generic "cloud" fallback and BEFORE "clear" so
  // "SCT at 4000 feet" lands in partly_cloudy instead of default.
  if (/\bovc\b/.test(s))                      return "overcast";
  if (/\bbkn\b/.test(s))                      return "cloudy";
  if (/\b(sct|few)\b/.test(s))                return "partly_cloudy";
  if (/\b(skc|clr|nsc|ncd)\b/.test(s))        return "clear";
  if (/cloud/.test(s))                        return "cloudy";
  if (/gust|wind/.test(s))                    return "windy";
  if (/hot|scorch/.test(s))                   return "hot";
  if (/cold|freez|chill/.test(s))             return "cold";
  if (/clear|sunny|fair|dry|bright/.test(s))  return "clear";
  return "default";
}

/**
 * Map an upstream weather description (string like "Thunderstorm",
 * "Light Rain", "Partly Cloudy") to the icon id registered above.
 * Returns the default icon id when the text is empty / unrecognised.
 */
export function nwfcWeatherIconId(text) {
  return NWFC_WX_ICON_IDS[nwfcWeatherBucket(text)];
}

// ===========================================================================
// 4. USGS earthquake magnitude pulses (128x128 animated canvas)
// ===========================================================================
const USGS_SIZE = 128;

export const USGS_ICON_IDS = {
  low: "usgs-eq-pulse-low",
  moderate: "usgs-eq-pulse-moderate",
  strong: "usgs-eq-pulse-strong",
  major: "usgs-eq-pulse-major",
};

function createUsgsPulsingDot(map, color, radiusScale) {
  return {
    width: USGS_SIZE,
    height: USGS_SIZE,
    data: new Uint8Array(USGS_SIZE * USGS_SIZE * 4),
    onAdd() {
      const canvas = document.createElement("canvas");
      canvas.width = this.width;
      canvas.height = this.height;
      this.context = canvas.getContext("2d", { willReadFrequently: true });
    },
    render() {
      const duration = 1400;
      const t = (performance.now() % duration) / duration;
      const radius = (USGS_SIZE / 2) * (0.16 + radiusScale);
      const outerRadius = (USGS_SIZE / 2) * (0.34 + radiusScale) * t + radius;
      const context = this.context;

      context.clearRect(0, 0, this.width, this.height);

      context.beginPath();
      context.arc(this.width / 2, this.height / 2, outerRadius, 0, Math.PI * 2);
      context.fillStyle = color.replace("__ALPHA__", `${0.35 * (1 - t)}`);
      context.fill();

      context.beginPath();
      context.arc(this.width / 2, this.height / 2, radius, 0, Math.PI * 2);
      context.fillStyle = color.replace("__ALPHA__", "1");
      context.strokeStyle = "rgba(255,255,255,0.95)";
      context.lineWidth = 2 + 3 * (1 - t);
      context.fill();
      context.stroke();

      this.data = context.getImageData(0, 0, this.width, this.height).data;
      map.triggerRepaint();
      return true;
    },
  };
}

export function registerUsgsEarthquakeIcons(map) {
  if (!map) return;

  const defs = [
    [USGS_ICON_IDS.low, "rgba(250, 204, 21, __ALPHA__)", 0.02],
    [USGS_ICON_IDS.moderate, "rgba(249, 115, 22, __ALPHA__)", 0.06],
    [USGS_ICON_IDS.strong, "rgba(239, 68, 68, __ALPHA__)", 0.1],
    [USGS_ICON_IDS.major, "rgba(127, 29, 29, __ALPHA__)", 0.14],
  ];

  defs.forEach(([id, color, scale]) => {
    if (!map.hasImage(id)) {
      map.addImage(id, createUsgsPulsingDot(map, color, scale), { pixelRatio: 2 });
    }
  });
}
