const ICON_SIZE = 64;

export const EONET_ICON_IDS = {
  all: "eonet-icon-all",
  severeStorms: "eonet-icon-severe-storms",
  wildfires: "eonet-icon-wildfires",
  volcanoes: "eonet-icon-volcanoes",
  earthquakes: "eonet-icon-earthquakes",
  seaLakeIce: "eonet-icon-sea-lake-ice",
};

function imageDataFromCanvas(drawFn) {
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  drawFn(ctx);
  const imageData = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
  return {
    width: ICON_SIZE,
    height: ICON_SIZE,
    data: imageData.data,
  };
}

function drawBadge(ctx, fill, stroke) {
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  ctx.beginPath();
  ctx.arc(ICON_SIZE / 2, ICON_SIZE / 2, 22, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawAll(ctx) {
  drawBadge(ctx, "#0f172a", "#38bdf8");
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

function drawStorm(ctx) {
  drawBadge(ctx, "#1e3a8a", "#60a5fa");
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

function drawFire(ctx) {
  drawBadge(ctx, "#7f1d1d", "#fb923c");
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

function drawVolcano(ctx) {
  drawBadge(ctx, "#581c87", "#c084fc");
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

function drawQuake(ctx) {
  drawBadge(ctx, "#78350f", "#facc15");
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

function drawIce(ctx) {
  drawBadge(ctx, "#164e63", "#67e8f9");
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
    [EONET_ICON_IDS.all, drawAll],
    [EONET_ICON_IDS.severeStorms, drawStorm],
    [EONET_ICON_IDS.wildfires, drawFire],
    [EONET_ICON_IDS.volcanoes, drawVolcano],
    [EONET_ICON_IDS.earthquakes, drawQuake],
    [EONET_ICON_IDS.seaLakeIce, drawIce],
  ];
  defs.forEach(([id, drawFn]) => {
    if (!map.hasImage(id)) {
      map.addImage(id, imageDataFromCanvas(drawFn));
    }
  });
}
