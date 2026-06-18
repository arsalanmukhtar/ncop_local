const SIZE = 128;

export const USGS_ICON_IDS = {
  low: "usgs-eq-pulse-low",
  moderate: "usgs-eq-pulse-moderate",
  strong: "usgs-eq-pulse-strong",
  major: "usgs-eq-pulse-major",
};

function createPulsingDot(map, color, radiusScale) {
  return {
    width: SIZE,
    height: SIZE,
    data: new Uint8Array(SIZE * SIZE * 4),
    onAdd() {
      const canvas = document.createElement("canvas");
      canvas.width = this.width;
      canvas.height = this.height;
      this.context = canvas.getContext("2d", { willReadFrequently: true });
    },
    render() {
      const duration = 1400;
      const t = (performance.now() % duration) / duration;
      const radius = (SIZE / 2) * (0.16 + radiusScale);
      const outerRadius = (SIZE / 2) * (0.34 + radiusScale) * t + radius;
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
      map.addImage(id, createPulsingDot(map, color, scale), { pixelRatio: 2 });
    }
  });
}
