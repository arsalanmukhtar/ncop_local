const PMD_SUN_ICON_ID = "pmd-weather-sun-animated";
const PMD_RAIN_ICON_ID = "pmd-weather-rain-animated";
const ICON_SIZE = 96;

function drawSunIcon(ctx) {
  const center = ICON_SIZE / 2;
  const innerRadius = 18;
  const outerRadius = 32;

  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);

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

function drawRainIcon(ctx, time) {
  const centerX = ICON_SIZE / 2;
  const cloudY = 36;
  const cloudPulse = Math.sin(time * 2.4) * 1.5;

  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);

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

function createAnimatedWeatherImage(drawFrame) {
  return {
    width: ICON_SIZE,
    height: ICON_SIZE,
    data: new Uint8Array(ICON_SIZE * ICON_SIZE * 4),
    onAdd(map) {
      this.map = map;
      this.canvas = document.createElement("canvas");
      this.canvas.width = ICON_SIZE;
      this.canvas.height = ICON_SIZE;
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    },
    render() {
      const time = performance.now() / 1000;
      drawFrame(this.ctx, time);
      this.data = this.ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data;
      this.map.triggerRepaint();
      return true;
    },
  };
}

function createStaticSunCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  drawSunIcon(ctx);
  return ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
}

export function registerPMDWeatherIcons(map) {
  if (!map) return;

  if (!map.hasImage(PMD_SUN_ICON_ID)) {
    map.addImage(PMD_SUN_ICON_ID, createStaticSunCanvas());
  }

  if (!map.hasImage(PMD_RAIN_ICON_ID)) {
    map.addImage(PMD_RAIN_ICON_ID, createAnimatedWeatherImage(drawRainIcon));
  }
}

export { PMD_SUN_ICON_ID, PMD_RAIN_ICON_ID };
