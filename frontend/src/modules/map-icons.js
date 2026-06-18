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
