/**
 * satellite-tracker.js
 *
 * Self-contained satellite tracker that renders live SGP4-propagated orbits
 * as SVG trail paths and emoji icons directly on the Mapbox map canvas.
 *
 * Usage:
 *   import { SatelliteTracker } from "./satellite-tracker.js";
 *   const tracker = new SatelliteTracker(map);
 *   await tracker.init("stations", (msg) => console.log(msg));
 *   tracker.togglePause();
 *   tracker.clearTrails();
 *   tracker.destroy();
 *
 * Core SGP4 propagation logic is unchanged from the original implementation.
 */

// ─── Configuration ─────────────────────────────────────────────────────────
const SAT_CFG = {
  UPDATE_MS:      250,
  TRAIL_MAX:      120,
  MAX_SATS:       100,
  SAT_FONT_SIZE:  20,
  ALT_OFFSET_MIN: 6,
  ALT_OFFSET_MAX: 28,
  ALT_RANGE_KM:   [200, 2000],
  TRAIL_COLOR:    "#5bb8ff",
  TRAIL_WIDTH:    "1.8",
  CELESTRAK_URL:  "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",
  TLE_API_URL:    "https://tle.ivanstanojevic.me/api/tle/",
  EO_IDS: [25544, 43013, 40697, 39084, 49260, 25994, 27424, 37849, 46984, 33591],
  SAT_CDN: [
    "https://cdn.jsdelivr.net/npm/satellite.js@6.0.1/dist/satellite.min.js",
    "https://unpkg.com/satellite.js@6.0.1/dist/satellite.min.js",
  ],
};

export class SatelliteTracker {
  // ── private state ──────────────────────────────────────────────────────────
  #map;
  #active       = false;
  #paused       = false;
  #sats         = [];
  #svgEl        = null;
  #iconContainer = null;
  #rafId        = null;
  #lastTick     = 0;
  #satLib       = null;
  #moveHandler  = null;
  #resizeObs    = null;

  constructor(map) {
    this.#map = map;
  }

  // ── public getters ─────────────────────────────────────────────────────────
  get isActive()  { return this.#active; }
  get isPaused()  { return this.#paused; }
  get satCount()  { return this.#sats.length; }

  // ── satellite.js CDN loader ───────────────────────────────────────────────
  async #loadLib() {
    if (this.#satLib) return;
    if (window.satellite) { this.#satLib = window.satellite; return; }
    for (const url of SAT_CFG.SAT_CDN) {
      try {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = url; s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
        if (window.satellite) { this.#satLib = window.satellite; return; }
      } catch (_) { /* try next CDN */ }
    }
    throw new Error("satellite.js could not be loaded from CDN");
  }

  // ── TLE fetch ──────────────────────────────────────────────────────────────
  async #fetchTLEText(group) {
    if (group === "eo") {
      const results = await Promise.allSettled(
        SAT_CFG.EO_IDS.map(id =>
          fetch(SAT_CFG.TLE_API_URL + id).then(r => r.json())
        )
      );
      return results
        .filter(r => r.status === "fulfilled")
        .map(r => {
          const { name = "", line1 = "", line2 = "" } = r.value;
          const n  = String(name).trim();
          const l1 = String(line1).trim();
          const l2 = String(line2).trim();
          return (n && l1.startsWith("1") && l2.startsWith("2"))
            ? `${n}\n${l1}\n${l2}`
            : null;
        })
        .filter(Boolean)
        .join("\n");
    }
    const res = await fetch(SAT_CFG.CELESTRAK_URL);
    if (!res.ok) throw new Error(`CelesTrak error ${res.status}`);
    return res.text();
  }

  // ── TLE parser ─────────────────────────────────────────────────────────────
  #parseTLE(txt) {
    const sat   = this.#satLib;
    const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);
    const out   = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
      if (!lines[i + 1].startsWith("1") || !lines[i + 2].startsWith("2")) continue;
      try {
        out.push({
          name:       lines[i],
          satrec:     sat.twoline2satrec(lines[i + 1], lines[i + 2]),
          trail:      [],
          curr:       null,
          trailDirty: false,
          iconEl:     null,
          pathEl:     null,
          nameEl:     null,
          altEl:      null,
        });
      } catch (_) { /* skip malformed records */ }
      if (out.length >= SAT_CFG.MAX_SATS) break;
    }
    return out;
  }

  // ── Overlay containers ─────────────────────────────────────────────────────
  #createOverlays() {
    let svg = document.getElementById("ncop-sat-svg");
    if (!svg) {
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.id = "ncop-sat-svg";
      Object.assign(svg.style, {
        position: "absolute", inset: "0", zIndex: "4",
        pointerEvents: "none", overflow: "visible",
      });
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.id = "ncop-sat-trails";
      svg.appendChild(g);
      this.#map.getContainer().appendChild(svg);
    }

    let iconContainer = document.getElementById("ncop-sat-icons");
    if (!iconContainer) {
      iconContainer = document.createElement("div");
      iconContainer.id = "ncop-sat-icons";
      Object.assign(iconContainer.style, {
        position: "absolute", inset: "0", zIndex: "5",
        pointerEvents: "none", overflow: "hidden",
      });
      this.#map.getContainer().appendChild(iconContainer);
    }

    return { svg, iconContainer };
  }

  #resizeSVG() {
    if (!this.#svgEl) return;
    const c = this.#map.getCanvas();
    this.#svgEl.setAttribute("width",  c.clientWidth);
    this.#svgEl.setAttribute("height", c.clientHeight);
  }

  // ── Math helpers ───────────────────────────────────────────────────────────
  #project(lon, lat) {
    const p = this.#map.project([lon, lat]);
    return [p.x, p.y];
  }

  #altOffset(alt) {
    const [lo, hi] = SAT_CFG.ALT_RANGE_KM;
    const t = Math.min(Math.max((alt - lo) / (hi - lo), 0), 1);
    return SAT_CFG.ALT_OFFSET_MIN + t * (SAT_CFG.ALT_OFFSET_MAX - SAT_CFG.ALT_OFFSET_MIN);
  }

  #buildTrail(trail) {
    if (trail.length < 2) return "";
    const pts  = trail.map(p => this.#project(p.lon, p.lat));
    const wMax = (+( this.#svgEl?.getAttribute("width") || window.innerWidth)) * 0.45;
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      d += Math.abs(pts[i][0] - pts[i - 1][0]) > wMax
        ? ` M${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`
        : ` L${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
    }
    return d;
  }

  // ── SGP4 propagation (core logic unchanged) ────────────────────────────────
  #propagate(satrec, date) {
    const sat = this.#satLib;
    const pv  = sat.propagate(satrec, date);
    if (!pv?.position) return null;
    const gst = sat.gstime
      ? sat.gstime(date)
      : sat.gstimeFromDate(
          date.getUTCFullYear(),  date.getUTCMonth() + 1,
          date.getUTCDate(),      date.getUTCHours(),
          date.getUTCMinutes(),   date.getUTCSeconds()
        );
    const gd  = sat.eciToGeodetic(pv.position, gst);
    const lon = ((gd.longitude * 180 / Math.PI + 540) % 360) - 180;
    const lat = gd.latitude  * 180 / Math.PI;
    const alt = gd.height;
    if (!isFinite(lon) || !isFinite(lat) || alt < 0) return null;
    const v = pv.velocity;
    return {
      lon, lat, alt,
      speed: v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : null,
    };
  }

  // ── Popup HTML ─────────────────────────────────────────────────────────────
  #popupHTML(s) {
    const c = s.curr;
    if (!c) return "";
    const lonStr = `${Math.abs(c.lon).toFixed(4)}° ${c.lon >= 0 ? "E" : "W"}`;
    const latStr = `${Math.abs(c.lat).toFixed(4)}° ${c.lat >= 0 ? "N" : "S"}`;
    const a      = 6371 + c.alt;
    const period = (2 * Math.PI * Math.sqrt((a * a * a) / 398600.4418) / 60).toFixed(1);
    const speed  = (c.speed != null && isFinite(c.speed)) ? `${c.speed.toFixed(3)} km/s` : "N/A";
    const utc    = new Date().toUTCString().slice(17, 25);

    return `
      <div style="
        font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
        color:var(--modal-text-color,#ffffff);
        background:var(--ncop-primary,rgba(0,0,0,0.35));
        backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
        border:1px solid rgba(255,255,255,0.18);border-radius:12px;
        overflow:hidden;box-shadow:0 10px 28px rgba(0,0,0,0.35);min-width:240px;">
        <div style="
          padding:10px 12px;display:flex;align-items:center;
          justify-content:space-between;gap:10px;
          background:linear-gradient(135deg,#258bd4,#46b2ff);color:#fff;">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <div style="font-size:16px;">🛰️</div>
            <div style="font-weight:800;font-size:13px;white-space:nowrap;
              overflow:hidden;text-overflow:ellipsis;max-width:210px;">${s.name}</div>
          </div>
          <div style="font-size:11px;font-weight:700;padding:3px 8px;
            border-radius:999px;background:rgba(255,255,255,0.18);
            border:1px solid rgba(255,255,255,0.22);white-space:nowrap;">
            ${c.alt.toFixed(0)} km</div>
        </div>
        <div style="padding:10px 12px;">
          <div style="display:grid;grid-template-columns:1fr auto;
            gap:6px 10px;font-size:12px;line-height:1.35;">
            <div style="opacity:.85">Speed</div><div style="font-weight:800">${speed}</div>
            <div style="opacity:.85">Latitude</div><div style="font-weight:800">${latStr}</div>
            <div style="opacity:.85">Longitude</div><div style="font-weight:800">${lonStr}</div>
            <div style="opacity:.85">Orbit period</div><div style="font-weight:800">~${period} min</div>
            <div style="opacity:.85">Time (UTC)</div><div style="font-weight:800">${utc}</div>
          </div>
          <div style="margin-top:10px;height:1px;background:rgba(255,255,255,.14)"></div>
          <div style="margin-top:8px;font-size:11px;opacity:.85">
            Tip: click other satellites to compare altitude and ground track.
          </div>
        </div>
      </div>`;
  }

  // ── Render pass ────────────────────────────────────────────────────────────
  #render() {
    const trailG = document.getElementById("ncop-sat-trails");
    if (!trailG || !this.#iconContainer) return;
    this.#resizeSVG();

    for (const s of this.#sats) {
      // ── trail path ──
      if (!s.pathEl) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("fill",            "none");
        path.setAttribute("stroke",          SAT_CFG.TRAIL_COLOR);
        path.setAttribute("stroke-width",    SAT_CFG.TRAIL_WIDTH);
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("stroke-linecap",  "round");
        trailG.appendChild(path);
        s.pathEl = path;
      }
      if (s.trailDirty) {
        s.pathEl.setAttribute("d", this.#buildTrail(s.trail));
        s.trailDirty = false;
      }

      // ── icon ──
      if (!s.iconEl) {
        const btn = document.createElement("div");
        btn.title = s.name;
        Object.assign(btn.style, {
          position: "absolute", pointerEvents: "auto", cursor: "pointer",
          userSelect: "none", transform: "translate(-50%,-50%)",
          zIndex: "6", display: "none", willChange: "transform,left,top",
        });

        const wrap = document.createElement("div");
        Object.assign(wrap.style, { position: "relative", pointerEvents: "auto" });

        const icon = document.createElement("div");
        icon.textContent = "🛰️";
        Object.assign(icon.style, {
          fontSize: `${SAT_CFG.SAT_FONT_SIZE}px`, lineHeight: "1",
          filter: "drop-shadow(0 1px 3px rgba(0,0,0,.7))",
        });

        const label = document.createElement("div");
        Object.assign(label.style, {
          position: "absolute", left: "50%", top: "100%",
          transform: "translate(-50%,6px)",
          display: "flex", flexDirection: "column", gap: "2px",
          alignItems: "center", pointerEvents: "none", whiteSpace: "nowrap",
        });

        const nameEl = document.createElement("div");
        Object.assign(nameEl.style, {
          fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif",
          fontSize: "11px", fontWeight: "800",
          color: "var(--modal-text-color,#ffffff)",
          textShadow: "0 1px 3px rgba(0,0,0,.85)",
          padding: "2px 7px", borderRadius: "999px",
          background: "rgba(0,0,0,.35)", border: "1px solid rgba(255,255,255,.18)",
          maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis",
          backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
        });

        const altEl = document.createElement("div");
        Object.assign(altEl.style, {
          fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif",
          fontSize: "10px", fontWeight: "700",
          color: "var(--modal-text-color,#ffffff)",
          textShadow: "0 1px 3px rgba(0,0,0,.85)",
          padding: "1px 7px", borderRadius: "999px",
          background: "rgba(0,0,0,.25)", border: "1px solid rgba(255,255,255,.14)",
          backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
        });

        nameEl.textContent = s.name || "Satellite";
        altEl.textContent  = "";
        label.appendChild(nameEl);
        label.appendChild(altEl);
        wrap.appendChild(icon);
        wrap.appendChild(label);
        btn.appendChild(wrap);

        btn.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
        btn.addEventListener("pointerup", (e) => {
          e.preventDefault(); e.stopPropagation();
          if (!s.curr) return;
          new window.mapboxgl.Popup({ closeButton: true, maxWidth: "320px" })
            .setLngLat([s.curr.lon, s.curr.lat])
            .setHTML(this.#popupHTML(s))
            .addTo(this.#map);
        });

        this.#iconContainer.appendChild(btn);
        s.iconEl = btn;
        s.nameEl = nameEl;
        s.altEl  = altEl;
      }

      if (s.curr) {
        const [x, y] = this.#project(s.curr.lon, s.curr.lat);
        if (s.nameEl) s.nameEl.textContent = s.name || "Satellite";
        if (s.altEl)  s.altEl.textContent  = `${s.curr.alt.toFixed(0)} km`;
        s.iconEl.style.left    = `${x}px`;
        s.iconEl.style.top     = `${y - this.#altOffset(s.curr.alt)}px`;
        s.iconEl.style.display = "block";
      } else {
        if (s.iconEl) s.iconEl.style.display = "none";
      }
    }
  }

  // ── RAF tick ───────────────────────────────────────────────────────────────
  #tick(now) {
    if (!this.#active) return;
    this.#rafId = requestAnimationFrame(this.#tick.bind(this));
    if (now - this.#lastTick < SAT_CFG.UPDATE_MS) return;
    this.#lastTick = now;
    if (this.#paused) return;

    const date = new Date();
    for (const s of this.#sats) {
      const p = this.#propagate(s.satrec, date);
      s.curr = p;
      if (p) {
        s.trail.push({ lon: p.lon, lat: p.lat });
        if (s.trail.length > SAT_CFG.TRAIL_MAX) s.trail.shift();
        s.trailDirty = true;
      }
    }
    this.#render();
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  #cleanup() {
    this.#active = false;
    if (this.#rafId)     { cancelAnimationFrame(this.#rafId); this.#rafId = null; }
    if (this.#moveHandler)  { this.#map.off("render", this.#moveHandler); this.#moveHandler = null; }
    if (this.#resizeObs) { this.#resizeObs.disconnect(); this.#resizeObs = null; }

    document.getElementById("ncop-sat-svg")?.remove();
    document.getElementById("ncop-sat-icons")?.remove();

    this.#svgEl         = null;
    this.#iconContainer = null;
    this.#sats          = [];
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load TLEs for the given group and start the animation loop.
   * @param {"stations"|"eo"} group
   * @param {(msg: string) => void} [onStatus]
   */
  async init(group, onStatus) {
    const set = (msg) => { if (onStatus) onStatus(msg); };
    try {
      set("Loading satellite.js…");
      await this.#loadLib();

      set(`Fetching ${group === "eo" ? "EO/Weather" : "ISS/Stations"} TLE data…`);
      const txt = await this.#fetchTLEText(group);

      const parsed = this.#parseTLE(txt);
      if (!parsed.length) throw new Error("No valid TLE records — try again shortly");

      this.#cleanup();
      this.#sats = parsed;

      const { svg, iconContainer } = this.#createOverlays();
      this.#svgEl         = svg;
      this.#iconContainer = iconContainer;

      // Re-render on every map render event so overlays track camera moves.
      this.#moveHandler = () => { if (this.#active) this.#render(); };
      this.#map.on("render", this.#moveHandler);

      this.#resizeObs = new ResizeObserver(() => this.#resizeSVG());
      this.#resizeObs.observe(this.#map.getCanvas());

      this.#active = true;
      this.#paused = false;
      this.#rafId  = requestAnimationFrame(this.#tick.bind(this));

      set(`${this.#sats.length} satellites active`);
    } catch (err) {
      set(`⚠ ${err.message}`);
      console.error("[SatelliteTracker]", err);
    }
  }

  /** Stop tracking and remove all overlays. */
  destroy(onStatus) {
    this.#cleanup();
    if (onStatus) onStatus("Ready — click a load button above.");
  }

  /** Toggle pause/resume. Returns new paused state. */
  togglePause() {
    this.#paused = !this.#paused;
    return this.#paused;
  }

  /** Erase all trail history (keeps satellites active). */
  clearTrails() {
    this.#sats.forEach(s => { s.trail = []; s.trailDirty = true; });
    this.#render();
  }
}
