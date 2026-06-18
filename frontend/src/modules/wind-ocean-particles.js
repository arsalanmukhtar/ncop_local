// Wind & Ocean Particle Layer (Open-Meteo via Django proxy)
// Optimized for smooth animation with low GC pressure.

const _WOP_WIND_N = 800;
const _WOP_OCEAN_N = 200;
const _WOP_TRAIL = 16;
const _WOP_WIND_PX = 0.28;
const _WOP_OCEAN_PX = 1.1;
const _WOP_OCEAN_MAX_D = 4.2;
const _WOP_FADE = 0.055;
const _WOP_FPS = 30;
const _WOP_MS_PER_FR = 1000 / _WOP_FPS;
const _VGRID_W = 64;
const _VGRID_H = 64;
const _WOP_FETCH_DEBOUNCE = 700;
const _WOP_IDW_CAP2 = 20 * 20;
const _WOP_BLUR_PASSES = 2;
const _WOP_TILE_PX = 512;
const _WOP_OMASK_W = 180;
const _WOP_OMASK_H = 90;

// Extended regional domain:
// South-East Asia + Pakistan + India + Bangladesh + Iran + China
const _WOP_SEA_BOUNDS = {
  s: -15.0,
  n: 50.0,
  w: 45.0,
  e: 150.0,
};
const _WOP_SEA_CENTER = { lat: 22.0, lon: 95.0, zoom: 3.8 };

const _WOP_W_PAL = [
  [2, 210, 230, 252],
  [5, 70, 185, 255],
  [8, 25, 210, 75],
  [11, 245, 220, 10],
  [14, 255, 140, 0],
  [17, 255, 50, 0],
  [21, 210, 0, 0],
  [Infinity, 170, 0, 255],
];
const _WOP_O_PAL = [
  [0.3, 15, 110, 155],
  [0.6, 0, 155, 185],
  [1.0, 0, 195, 200],
  [1.5, 0, 225, 210],
  [Infinity, 140, 255, 238],
];

const _wopWPalStr = _WOP_W_PAL.map(([, r, g, b]) => `rgb(${r},${g},${b})`);
const _wopOPalStr = _WOP_O_PAL.map(([, r, g, b]) => `rgb(${r},${g},${b})`);

function _wopMap() {
  return window.ncop_map || window.map || null;
}

function _wopPalIdx(spd, pal) {
  for (let i = 0; i < pal.length - 1; i++) if (spd <= pal[i][0]) return i;
  return pal.length - 1;
}

let _wopReady = false;
let _wopWindOn = false;
let _wopOceanOn = false;
let _wopFetching = false;
let _wopStyleReloading = false;
let _wopMoving = false;
let _wopRefGeo = null;
let _wopRefPx0 = null;
let _wopSpinning = false;
let _wopMoveTimer = null;
let _wopFetchSeq = 0;
let _wopLastFrame = 0;

let _wopWCnv;
let _wopWCtx;
let _wopOCnv;
let _wopOCtx;
let _wopWParts = [];
let _wopOParts = [];
let _wopOceanPts = [];
let _wopVisOcean = [];

let _wopMapRect = { left: 0, top: 0, width: 0, height: 0 };
let _wopGridBounds = null;

const _wopWGrid = new Float32Array(_VGRID_W * _VGRID_H * 2);
const _wopOGrid = new Float32Array(_VGRID_W * _VGRID_H * 2);
const _wopBlurTmp = new Float32Array(_VGRID_W * _VGRID_H * 2);
const _wopOMask = new Uint8Array(_WOP_OMASK_W * _WOP_OMASK_H);
const _wopProjOut = new Float64Array(2);
const _wopWBuckets = Array.from({ length: _WOP_W_PAL.length }, () => []);
const _wopOBuckets = Array.from({ length: _WOP_O_PAL.length }, () => []);

function _wopClamp(v, mn, mx) {
  return v < mn ? mn : v > mx ? mx : v;
}

function _wopNormLon(lon) {
  while (lon < -180) lon += 360;
  while (lon > 180) lon -= 360;
  return lon;
}

function _wopReadMapRect() {
  const el = document.getElementById("map");
  if (!el) return;
  const r = el.getBoundingClientRect();
  _wopMapRect = { left: r.left, top: r.top, width: r.width, height: r.height };
}

function _wopIntersectBounds(a, b) {
  const s = Math.max(a.s, b.s);
  const n = Math.min(a.n, b.n);
  const w = Math.max(a.w, b.w);
  const e = Math.min(a.e, b.e);
  if (s >= n || w >= e) return null;
  return { s, n, w, e };
}

function _wopMapViewIntersectsSea() {
  const m = _wopMap();
  if (!m) return false;
  const b = m.getBounds();
  const view = {
    s: Math.max(b.getSouth(), -85),
    n: Math.min(b.getNorth(), 85),
    w: b.getWest(),
    e: b.getEast(),
  };
  return Boolean(_wopIntersectBounds(view, _WOP_SEA_BOUNDS));
}

function _wopEnsureSeaInView() {
  const m = _wopMap();
  if (!m) return;
  if (_wopMapViewIntersectsSea()) return;
  m.easeTo({
    center: [_WOP_SEA_CENTER.lon, _WOP_SEA_CENTER.lat],
    zoom: Math.max(m.getZoom(), _WOP_SEA_CENTER.zoom),
    duration: 900,
    essential: true,
  });
}

function _wopBounds() {
  const m = _wopMap();
  if (!m) return { ..._WOP_SEA_BOUNDS };

  let raw;
  if (_wopIsGlobe()) {
    const z = m.getZoom();
    const c = m.getCenter();
    const half = _wopClamp(80 / Math.pow(2, Math.max(0, z - 1.5)), 15, 80);
    raw = {
      s: _wopClamp(c.lat - half, -80, 80),
      n: _wopClamp(c.lat + half, -80, 80),
      w: _wopNormLon(c.lng - half),
      e: _wopNormLon(c.lng + half),
    };
  } else {
    const b = m.getBounds();
    raw = {
      s: Math.max(b.getSouth(), -85),
      n: Math.min(b.getNorth(), 85),
      w: b.getWest(),
      e: b.getEast(),
    };
  }

  // SEA-only: if viewport is elsewhere, keep using fixed SEA domain.
  const intersect = _wopIntersectBounds(raw, _WOP_SEA_BOUNDS);
  return intersect || { ..._WOP_SEA_BOUNDS };
}

function _wopBoundsPadContains(b, lat, lon, pad) {
  const s = b.s - pad;
  const n = b.n + pad;
  const w = b.w - pad;
  const e = b.e + pad;
  if (lat < s || lat > n) return false;
  if (w <= e) return lon >= w && lon <= e;
  return lon >= w || lon <= e;
}

class _WopField {
  constructor() {
    this.pts = [];
    this.ok = false;
  }

  load(pts) {
    this.pts = (pts || []).filter(
      (p) =>
        p &&
        isFinite(p.lat) &&
        isFinite(p.lon) &&
        isFinite(p.u) &&
        isFinite(p.v),
    );
    this.ok = this.pts.length >= 2;
  }

  at(lat, lon) {
    if (!this.ok) return { u: 0, v: 0 };
    let su = 0;
    let sv = 0;
    let sw = 0;

    for (const p of this.pts) {
      let dl = Math.abs(lon - p.lon);
      if (dl > 180) dl = 360 - dl;
      const d2 = (lat - p.lat) ** 2 + dl * dl + 1e-8;
      if (d2 > _WOP_IDW_CAP2) continue;
      const w = 1 / (d2 * Math.sqrt(d2));
      su += p.u * w;
      sv += p.v * w;
      sw += w;
    }

    if (sw === 0) {
      for (const p of this.pts) {
        let dl = Math.abs(lon - p.lon);
        if (dl > 180) dl = 360 - dl;
        const d2 = (lat - p.lat) ** 2 + dl * dl + 1e-8;
        const w = 1 / d2;
        su += p.u * w;
        sv += p.v * w;
        sw += w;
      }
    }
    return { u: su / sw, v: sv / sw };
  }
}

const _wopWF = new _WopField();
const _wopOF = new _WopField();

function _wopBakeGrid(field, grid, b) {
  const lonSpan = b.w <= b.e ? b.e - b.w : 360 - b.w + b.e;
  for (let row = 0; row < _VGRID_H; row++) {
    const lat = b.s + ((b.n - b.s) * row) / (_VGRID_H - 1);
    for (let col = 0; col < _VGRID_W; col++) {
      const lon = _wopNormLon(b.w + (lonSpan * col) / (_VGRID_W - 1));
      const { u, v } = field.at(lat, lon);
      const i = (row * _VGRID_W + col) * 2;
      grid[i] = u;
      grid[i + 1] = v;
    }
  }
  _wopBlurGrid(grid, _VGRID_W, _VGRID_H, _WOP_BLUR_PASSES);
}

function _wopBlurGrid(grid, w, h, passes) {
  for (let p = 0; p < passes; p++) {
    _wopBlurTmp.set(grid);
    for (let row = 1; row < h - 1; row++) {
      for (let col = 1; col < w - 1; col++) {
        let su = 0;
        let sv = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const j = ((row + dr) * w + (col + dc)) * 2;
            su += _wopBlurTmp[j];
            sv += _wopBlurTmp[j + 1];
          }
        }
        const i = (row * w + col) * 2;
        grid[i] = su / 9;
        grid[i + 1] = sv / 9;
      }
    }
  }
}

function _wopRebuildOceanMask() {
  _wopOMask.fill(0);
  const cW = 360 / _WOP_OMASK_W;
  const cH = 180 / _WOP_OMASK_H;
  for (const op of _wopOceanPts) {
    const maxD = _WOP_OCEAN_MAX_D;
    const colMin = Math.max(0, Math.floor((op.lon + 180 - maxD) / cW));
    const colMax = Math.min(
      _WOP_OMASK_W - 1,
      Math.ceil((op.lon + 180 + maxD) / cW),
    );
    const rowMin = Math.max(0, Math.floor((op.lat + 90 - maxD) / cH));
    const rowMax = Math.min(
      _WOP_OMASK_H - 1,
      Math.ceil((op.lat + 90 + maxD) / cH),
    );
    for (let r = rowMin; r <= rowMax; r++) {
      for (let c = colMin; c <= colMax; c++) {
        const clat = r * cH - 90 + cH / 2;
        const clon = c * cW - 180 + cW / 2;
        let dl = Math.abs(clon - op.lon);
        if (dl > 180) dl = 360 - dl;
        if (Math.abs(clat - op.lat) + dl <= maxD) {
          _wopOMask[r * _WOP_OMASK_W + c] = 1;
        }
      }
    }
  }
}

function _wopInOcean(lat, lon) {
  const col = _wopClamp(
    (((lon + 180) / 360) * _WOP_OMASK_W) | 0,
    0,
    _WOP_OMASK_W - 1,
  );
  const row = _wopClamp(
    (((lat + 90) / 180) * _WOP_OMASK_H) | 0,
    0,
    _WOP_OMASK_H - 1,
  );
  return _wopOMask[row * _WOP_OMASK_W + col] === 1;
}

function _wopBakeAll() {
  const b = _wopBounds();
  _wopGridBounds = b;
  if (_wopWF.ok) _wopBakeGrid(_wopWF, _wopWGrid, b);
  if (_wopOF.ok) _wopBakeGrid(_wopOF, _wopOGrid, b);

  _wopRebuildOceanMask();
  _wopVisOcean = _wopOceanPts.filter((p) => _wopProject(p.lon, p.lat));
  if (!_wopVisOcean.length) _wopVisOcean = _wopOceanPts.slice();
}

function _wopGridAt(lat, lon, grid, b) {
  const lonSpan = b.w <= b.e ? b.e - b.w : 360 - b.w + b.e;
  let relLon = lon - b.w;
  if (relLon < 0) relLon += 360;
  if (relLon > lonSpan) relLon = lonSpan;

  const fx = _wopClamp((relLon / lonSpan) * (_VGRID_W - 1), 0, _VGRID_W - 1);
  const fy = _wopClamp(
    ((lat - b.s) / Math.max(1e-8, b.n - b.s)) * (_VGRID_H - 1),
    0,
    _VGRID_H - 1,
  );

  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = Math.min(x0 + 1, _VGRID_W - 1);
  const y1 = Math.min(y0 + 1, _VGRID_H - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const omx = 1 - tx;
  const omy = 1 - ty;

  const i00 = (y0 * _VGRID_W + x0) * 2;
  const i10 = (y0 * _VGRID_W + x1) * 2;
  const i01 = (y1 * _VGRID_W + x0) * 2;
  const i11 = (y1 * _VGRID_W + x1) * 2;

  return {
    u:
      omx * omy * grid[i00] +
      tx * omy * grid[i10] +
      omx * ty * grid[i01] +
      tx * ty * grid[i11],
    v:
      omx * omy * grid[i00 + 1] +
      tx * omy * grid[i10 + 1] +
      omx * ty * grid[i01 + 1] +
      tx * ty * grid[i11 + 1],
  };
}

function _wopIsGlobe() {
  const m = _wopMap();
  if (!m) return false;
  try {
    const p = m.getProjection?.();
    if (p) return p.type === "globe" || p.name === "globe";
    return m.transform?.projection?.name === "globe";
  } catch {
    return false;
  }
}

function _wopAngDeg(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a1 = lat1 * r;
  const b1 = lon1 * r;
  const a2 = lat2 * r;
  const b2 = lon2 * r;
  const c =
    Math.sin(a1) * Math.sin(a2) +
    Math.cos(a1) * Math.cos(a2) * Math.cos(b2 - b1);
  return (Math.acos(_wopClamp(c, -1, 1)) * 180) / Math.PI;
}

function _wopProject(lon, lat) {
  const m = _wopMap();
  if (!m) return false;

  let pt;
  try {
    pt = m.project([lon, lat]);
  } catch {
    return false;
  }
  if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) return false;

  const { width: w, height: h } = _wopMapRect;
  if (!w || !h) return false;

  if (_wopIsGlobe()) {
    const c = m.getCenter();
    if (_wopAngDeg(c.lat, c.lng, lat, lon) > 85) return false;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const rr = Math.min(w, h) * 0.465;
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    if (dx * dx + dy * dy > rr * rr) return false;
  }

  if (pt.x < 0 || pt.x > w || pt.y < 0 || pt.y > h) return false;
  _wopProjOut[0] = pt.x;
  _wopProjOut[1] = pt.y;
  return true;
}

function _wopNewPart(lat, lon, jitter) {
  return {
    lat,
    lon,
    age: jitter ? (Math.random() * 70) | 0 : 0,
    life: 70 + ((Math.random() * 90) | 0),
    trail: new Float32Array(_WOP_TRAIL * 2),
    th: 0,
    tl: 0,
    spd: 0,
  };
}

function _wopMkPart(b, jitter) {
  const m = _wopMap();
  if (!m) return _wopNewPart(0, 0, jitter);

  for (let i = 0; i < 25; i++) {
    const lat = b.s + Math.random() * (b.n - b.s);
    const lon = _wopNormLon(
      b.w <= b.e
        ? b.w + Math.random() * (b.e - b.w)
        : b.w + Math.random() * (360 - b.w + b.e),
    );
    if (_wopProject(lon, lat)) return _wopNewPart(lat, lon, jitter);
  }
  const c = m.getCenter();
  return _wopNewPart(c.lat, c.lng, jitter);
}

function _wopMkOceanPart(b) {
  if (!_wopVisOcean.length) return _wopMkPart(b, false);
  for (let i = 0; i < 25; i++) {
    const a = _wopVisOcean[(_wopVisOcean.length * Math.random()) | 0];
    const lat = a.lat + (Math.random() - 0.5) * 1.25;
    const lon = _wopNormLon(a.lon + (Math.random() - 0.5) * 1.25);
    if (_wopProject(lon, lat)) return _wopNewPart(lat, lon, false);
  }
  return _wopMkPart(b, false);
}

function _wopReset(p, b, isOcean) {
  const m = _wopMap();
  let src;
  if (isOcean && _wopVisOcean.length) {
    for (let i = 0; i < 25; i++) {
      const a = _wopVisOcean[(_wopVisOcean.length * Math.random()) | 0];
      const lat = a.lat + (Math.random() - 0.5) * 1.25;
      const lon = _wopNormLon(a.lon + (Math.random() - 0.5) * 1.25);
      if (_wopProject(lon, lat)) {
        src = { lat, lon };
        break;
      }
    }
  }
  if (!src) {
    for (let i = 0; i < 25; i++) {
      const lat = b.s + Math.random() * (b.n - b.s);
      const lon = _wopNormLon(
        b.w <= b.e
          ? b.w + Math.random() * (b.e - b.w)
          : b.w + Math.random() * (360 - b.w + b.e),
      );
      if (_wopProject(lon, lat)) {
        src = { lat, lon };
        break;
      }
    }
  }
  if (src) {
    p.lat = src.lat;
    p.lon = src.lon;
  } else if (m) {
    const c = m.getCenter();
    p.lat = c.lat;
    p.lon = c.lng;
  }

  p.age = 0;
  p.life = 70 + ((Math.random() * 90) | 0);
  p.spd = 0;
  p.th = 0;
  p.tl = 0;
}

function _wopSpawnAll() {
  const b = _wopBounds();
  _wopWParts = Array.from({ length: _WOP_WIND_N }, () => _wopMkPart(b, true));
  _wopOParts = _wopVisOcean.length
    ? Array.from({ length: _WOP_OCEAN_N }, () => _wopMkOceanPart(b))
    : [];
}

function _wopCreateCanvases() {
  const mk = (id, z) => {
    const c = document.createElement("canvas");
    c.id = id;
    c.style.cssText = `position:fixed;pointer-events:none;z-index:${z};left:0;top:0;`;
    document.body.appendChild(c);
    return c;
  };
  // Keep particle canvases above map imagery/layers but below UI chrome
  // (sidebar, nav, sliders, dialogs, controls).
  _wopOCnv = mk("wop-ocean-canvas", 4);
  _wopWCnv = mk("wop-wind-canvas", 5);
  _wopWCtx = _wopWCnv.getContext("2d", { alpha: true });
  _wopOCtx = _wopOCnv.getContext("2d", { alpha: true });
  _wopSyncCanvasToMap();

  window.addEventListener("resize", () => {
    _wopSyncCanvasToMap();
    if (_wopWindOn || _wopOceanOn) {
      _wopBakeAll();
      _wopSpawnAll();
    }
  });

  const mapEl = document.getElementById("map");
  if (mapEl && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      _wopSyncCanvasToMap();
      if (_wopWindOn || _wopOceanOn) {
        _wopBakeAll();
        _wopSpawnAll();
      }
    }).observe(mapEl);
  }
}

function _wopSyncCanvasToMap() {
  _wopReadMapRect();
  const { left, top, width, height } = _wopMapRect;
  const ratio = window.devicePixelRatio || 1;
  [_wopWCnv, _wopOCnv].forEach((c) => {
    if (!c) return;
    c.style.left = `${left}px`;
    c.style.top = `${top}px`;
    c.style.width = `${width}px`;
    c.style.height = `${height}px`;
    c.width = Math.max(1, Math.round(width * ratio));
    c.height = Math.max(1, Math.round(height * ratio));
    const ctx = c === _wopWCnv ? _wopWCtx : _wopOCtx;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(ratio, ratio);
    }
  });
}

function _wopStep(parts, grid, pxRate, ctx, cnv, pal, palStr, buckets, isOcean) {
  const m = _wopMap();
  if (!m) return;

  const b = _wopGridBounds || _wopBounds();
  const cssW = _wopMapRect.width;
  const cssH = _wopMapRect.height;
  if (!cssW || !cssH || !ctx || !cnv) return;

  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = `rgba(0,0,0,${_WOP_FADE})`;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.globalCompositeOperation = "source-over";

  for (let i = 0; i < buckets.length; i++) buckets[i].length = 0;

  const pxPerDeg = (_WOP_TILE_PX * Math.pow(2, m.getZoom())) / 360;

  for (const p of parts) {
    const { u, v } = _wopGridAt(p.lat, p.lon, grid, b);
    const spd = Math.sqrt(u * u + v * v);
    p.spd = spd;

    const cosLat = Math.max(0.208, Math.cos(p.lat * (Math.PI / 180)));
    p.lat = _wopClamp(p.lat + (v * pxRate) / pxPerDeg, -89, 89);
    p.lon = _wopNormLon(p.lon + (u * pxRate) / (pxPerDeg * cosLat));
    p.age++;

    if (
      !isFinite(p.lat) ||
      !isFinite(p.lon) ||
      p.age >= p.life ||
      !_wopBoundsPadContains(b, p.lat, p.lon, 2)
    ) {
      _wopReset(p, b, isOcean);
      continue;
    }

    if (isOcean && !_wopInOcean(p.lat, p.lon)) {
      _wopReset(p, b, isOcean);
      continue;
    }

    if (!_wopProject(p.lon, p.lat)) {
      _wopReset(p, b, isOcean);
      continue;
    }
    const sx = _wopProjOut[0];
    const sy = _wopProjOut[1];

    const writeIdx = ((p.th + p.tl) % _WOP_TRAIL) * 2;
    p.trail[writeIdx] = sx;
    p.trail[writeIdx + 1] = sy;
    if (p.tl < _WOP_TRAIL) p.tl++;
    else p.th = (p.th + 1) % _WOP_TRAIL;

    if (p.tl < 2) continue;
    buckets[_wopPalIdx(spd, pal)].push(p);
  }

  ctx.lineWidth = isOcean ? 1.15 : 1.0;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let ci = 0; ci < buckets.length; ci++) {
    const bucket = buckets[ci];
    if (!bucket.length) continue;
    ctx.strokeStyle = palStr[ci];
    ctx.beginPath();
    for (const p of bucket) {
      const i0 = (p.th % _WOP_TRAIL) * 2;
      ctx.moveTo(p.trail[i0], p.trail[i0 + 1]);
      for (let k = 1; k < p.tl; k++) {
        const idx = ((p.th + k) % _WOP_TRAIL) * 2;
        ctx.lineTo(p.trail[idx], p.trail[idx + 1]);
      }
    }
    ctx.stroke();
  }
}

function _wopLoop(ts) {
  requestAnimationFrame(_wopLoop);
  if (ts - _wopLastFrame < _WOP_MS_PER_FR) return;
  _wopLastFrame = ts;
  if (_wopSpinning || _wopMoving || !_wopGridBounds) return;

  if (_wopWindOn && _wopWF.ok) {
    _wopStep(
      _wopWParts,
      _wopWGrid,
      _WOP_WIND_PX,
      _wopWCtx,
      _wopWCnv,
      _WOP_W_PAL,
      _wopWPalStr,
      _wopWBuckets,
      false,
    );
  }

  if (_wopOceanOn && _wopOF.ok) {
    _wopStep(
      _wopOParts,
      _wopOGrid,
      _WOP_OCEAN_PX,
      _wopOCtx,
      _wopOCnv,
      _WOP_O_PAL,
      _wopOPalStr,
      _wopOBuckets,
      true,
    );
  }
}

export async function wopFetchData() {
  if (_wopFetching) return;
  const seq = ++_wopFetchSeq;
  _wopFetching = true;
  const b = _wopBounds();

  try {
    const baseUrl = window.baseUrl || window.location.origin;
    const url =
      `${baseUrl}/api/wind-ocean-particles/` +
      `?sw_lat=${b.s.toFixed(3)}&sw_lng=${b.w.toFixed(3)}` +
      `&ne_lat=${b.n.toFixed(3)}&ne_lng=${b.e.toFixed(3)}`;

    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== _wopFetchSeq) return;

    if (Array.isArray(data.wind)) _wopWF.load(data.wind);
    if (Array.isArray(data.ocean)) {
      _wopOceanPts = data.ocean.filter(Boolean);
      _wopOF.load(_wopOceanPts);
    } else {
      _wopOceanPts = [];
      _wopOF.load([]);
    }

    _wopBakeAll();
    _wopSpawnAll();
  } catch (e) {
    console.warn("[WOP] fetch failed:", e);
  } finally {
    if (seq === _wopFetchSeq) _wopFetching = false;
  }
}

export function wopSetSpinning(spinning) {
  _wopSpinning = spinning;
  if (spinning) {
    const { width, height } = _wopMapRect;
    _wopWCtx?.clearRect(0, 0, width, height);
    _wopOCtx?.clearRect(0, 0, width, height);
    for (const p of _wopWParts) {
      p.th = 0;
      p.tl = 0;
    }
    for (const p of _wopOParts) {
      p.th = 0;
      p.tl = 0;
    }
  } else if (_wopWindOn || _wopOceanOn) {
    clearTimeout(_wopMoveTimer);
    _wopMoveTimer = setTimeout(() => {
      _wopSyncCanvasToMap();
      _wopBakeAll();
      _wopSpawnAll();
      wopFetchData();
    }, 400);
  }
}

export function toggleWindParticleLayer() {
  if (!_wopReady) _wopInit();
  _wopWindOn = !_wopWindOn;
  if (!_wopWindOn) {
    _wopWCtx?.clearRect(0, 0, _wopMapRect.width, _wopMapRect.height);
  } else {
    _wopEnsureSeaInView();
    _wopSyncCanvasToMap();
    wopFetchData();
  }
  return _wopWindOn;
}

export function toggleOceanParticleLayer() {
  if (!_wopReady) _wopInit();
  _wopOceanOn = !_wopOceanOn;
  if (!_wopOceanOn) {
    _wopOCtx?.clearRect(0, 0, _wopMapRect.width, _wopMapRect.height);
  } else {
    _wopEnsureSeaInView();
    _wopSyncCanvasToMap();
    wopFetchData();
  }
  return _wopOceanOn;
}

function _wopInit() {
  if (_wopReady) return;
  const m = _wopMap();
  if (!m) return;

  _wopReady = true;
  _wopCreateCanvases();
  requestAnimationFrame(_wopLoop);

  m.on("movestart", () => {
    if (_wopSpinning) return;
    _wopMoving = true;
    if (!_wopStyleReloading) {
      const c = m.getCenter();
      _wopRefGeo = { lat: c.lat, lon: c.lng };
      const px = m.project([c.lng, c.lat]);
      _wopRefPx0 = { x: px.x, y: px.y };
    }
  });

  m.on("move", () => {
    if (_wopSpinning || _wopStyleReloading) return;
    _wopSyncCanvasToMap();
    if (_wopRefGeo && _wopRefPx0) {
      const px = m.project([_wopRefGeo.lon, _wopRefGeo.lat]);
      const dx = px.x - _wopRefPx0.x;
      const dy = px.y - _wopRefPx0.y;
      if (_wopWCnv) _wopWCnv.style.transform = `translate(${dx}px,${dy}px)`;
      if (_wopOCnv) _wopOCnv.style.transform = `translate(${dx}px,${dy}px)`;
    }
  });

  m.on("moveend", () => {
    if (_wopSpinning) return;
    if (_wopStyleReloading) {
      _wopMoving = false;
      _wopRefGeo = null;
      _wopRefPx0 = null;
      if (_wopWCnv) _wopWCnv.style.transform = "";
      if (_wopOCnv) _wopOCnv.style.transform = "";
      return;
    }
    _wopMoving = false;
    _wopRefGeo = null;
    _wopRefPx0 = null;
    if (_wopWCnv) _wopWCnv.style.transform = "";
    if (_wopOCnv) _wopOCnv.style.transform = "";
    _wopSyncCanvasToMap();
    _wopWCtx?.clearRect(0, 0, _wopMapRect.width, _wopMapRect.height);
    _wopOCtx?.clearRect(0, 0, _wopMapRect.width, _wopMapRect.height);
    if (_wopWindOn || _wopOceanOn) {
      clearTimeout(_wopMoveTimer);
      _wopBakeAll();
      _wopSpawnAll();
      _wopMoveTimer = setTimeout(wopFetchData, _WOP_FETCH_DEBOUNCE);
    }
  });

  m.on("zoomstart", () => {
    if (!_wopSpinning) _wopMoving = true;
  });

  m.on("zoomend", () => {
    if (_wopSpinning) return;
    _wopMoving = false;
    _wopSyncCanvasToMap();
    if (_wopWindOn || _wopOceanOn) {
      clearTimeout(_wopMoveTimer);
      _wopBakeAll();
      _wopSpawnAll();
      _wopMoveTimer = setTimeout(wopFetchData, _WOP_FETCH_DEBOUNCE);
    }
  });

  m.on("resize", () => {
    _wopSyncCanvasToMap();
    if (_wopWindOn || _wopOceanOn) {
      _wopBakeAll();
      _wopSpawnAll();
    }
  });
}
