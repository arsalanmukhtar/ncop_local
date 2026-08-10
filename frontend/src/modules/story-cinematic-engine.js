// ==========================================================================
// story-cinematic-engine.js
// --------------------------------------------------------------------------
// Reusable Mapbox GL JS camera/atmosphere/opacity choreography primitives,
// shared by any story that wants a "broadcast operations center" feel
// instead of raw layer toggling. No story-specific data or DOM lives here
// — this is purely a small motion-and-timing toolkit.
//
// Every camera helper returns a Promise that resolves once the movement
// actually finishes (via Mapbox's own "moveend"/"idle" events), so callers
// can `await` a fly-in before starting narration instead of guessing a
// timeout that may race the real animation.
// ==========================================================================

/** Simple delay helper — used to hold a scene before the next transition. */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cubic ease-in-out — the same curve used across NCOP's other cinematic
 * camera work (story-provincial-forecast.js), kept here as the shared
 * default so every story's motion reads as one consistent system. */
export const EASE_IN_OUT_CUBIC = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Sine ease-in-out — gentler, used for slow atmospheric moves (orbits,
 * bearing drifts) where a cubic curve would feel too snappy. */
export const EASE_SINE = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

function _onceMoveEnd(map, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { map.off("moveend", finish); } catch (_) {}
      resolve();
    };
    map.once("moveend", finish);
    // Safety net — flyTo/easeTo always fire moveend on completion, but a
    // cancelled/interrupted animation (operator navigates away mid-flight)
    // might not; never let a scene hang forever waiting on it.
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Cinematic flyTo — same semantics as map.flyTo(), but awaitable and with
 * NCOP's house camera defaults (curve, easing) pre-filled so every scene's
 * motion reads consistently. Pass any flyTo option to override.
 */
export function cinematicFlyTo(map, opts = {}) {
  if (!map || typeof map.flyTo !== "function") return Promise.resolve();
  const duration = opts.duration ?? 2800;
  map.flyTo({
    curve: 1.7,
    easing: EASE_IN_OUT_CUBIC,
    essential: true,
    ...opts,
    duration,
  });
  return _onceMoveEnd(map, duration + 500);
}

/** Cinematic easeTo — for smaller/subtler adjustments (bearing drift,
 * pitch tweak) where flyTo's parabolic arc would be overkill. */
export function cinematicEaseTo(map, opts = {}) {
  if (!map || typeof map.easeTo !== "function") return Promise.resolve();
  const duration = opts.duration ?? 1800;
  map.easeTo({
    easing: EASE_SINE,
    essential: true,
    ...opts,
    duration,
  });
  return _onceMoveEnd(map, duration + 500);
}

/**
 * Cinematic fitBounds — for "show all of these locations at once"
 * moments (returning to national view, comparing multiple provinces).
 * bounds: [[minX,minY],[maxX,maxY]].
 */
export function cinematicFitBounds(map, bounds, opts = {}) {
  if (!map || typeof map.fitBounds !== "function") return Promise.resolve();
  const duration = opts.duration ?? 2600;
  map.fitBounds(bounds, {
    padding: 80,
    easing: EASE_IN_OUT_CUBIC,
    essential: true,
    ...opts,
    duration,
  });
  return _onceMoveEnd(map, duration + 500);
}

/**
 * Animate a single paint-property opacity from `from` to `to` over
 * `durationMs`, via requestAnimationFrame. Resolves when done. This is
 * how every raster/vector layer in Story Mode fades in/out instead of
 * snapping — jumpTo-style abrupt visibility flips are never used here.
 */
export function fadeLayerOpacity(map, layerId, opacityProp, from, to, durationMs = 2000) {
  return new Promise((resolve) => {
    if (!map || typeof map.getLayer !== "function" || !map.getLayer(layerId)) {
      resolve();
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = EASE_SINE(t);
      const value = from + (to - from) * eased;
      try { map.setPaintProperty(layerId, opacityProp, value); } catch (_) { resolve(); return; }
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

/**
 * Fade opacity across MULTIPLE layer/property pairs in lockstep — used
 * when a "layer" is really a handful of Mapbox layers sharing one
 * conceptual fade (e.g. a raster's tile layer + its own legend overlay).
 * pairs: [{ layerId, prop, from, to }]
 */
export function fadeLayers(map, pairs, durationMs = 2000) {
  return Promise.all(
    (pairs || []).map((p) => fadeLayerOpacity(map, p.layerId, p.prop, p.from, p.to, durationMs))
  );
}

/**
 * One-time atmosphere setup for the cinematic opening — 3D terrain
 * exaggeration + fog, giving the fly-in a sense of depth. Safe to call
 * more than once (no-ops if the DEM source already exists).
 */
export function enableCinematicAtmosphere(map, opts = {}) {
  if (!map) return;
  try {
    const DEM_ID = "mapbox-dem";
    if (!map.getSource(DEM_ID)) {
      map.addSource(DEM_ID, {
        type: "raster-dem",
        url: "mapbox://mapbox.mapbox-terrain-dem-v1",
        tileSize: 512,
        maxzoom: 14,
      });
    }
    if (typeof map.setTerrain === "function") {
      map.setTerrain({ source: DEM_ID, exaggeration: opts.exaggeration ?? 1.4 });
    }
    if (typeof map.setFog === "function") {
      map.setFog(opts.fog ?? {
        range: [0.5, 10],
        color: "rgba(200, 210, 225, 0.9)",
        "horizon-blend": 0.3,
        "high-color": "rgba(36, 92, 223, 0.6)",
        "space-color": "rgba(11, 11, 25, 1)",
        "star-intensity": 0.15,
      });
    }
  } catch (_) { /* best-effort — older basemap styles may not support terrain/fog */ }
}

/** Reverses enableCinematicAtmosphere's visual effect for a clean return
 * to a flat operational map — does not remove the DEM source (cheap to
 * leave loaded; re-enabling later is then instant). */
export function disableCinematicAtmosphere(map) {
  if (!map) return;
  try {
    if (typeof map.setTerrain === "function") map.setTerrain(null);
    if (typeof map.setFog === "function") map.setFog(null);
  } catch (_) { /* best-effort */ }
}

/**
 * Briefly pulses a DOM element (marker, badge) via a CSS class toggle —
 * caller supplies the class (so each story can theme its own pulse
 * animation); this just handles the timed add/remove.
 */
export function pulseElement(el, className = "is-pulsing", durationMs = 1200) {
  if (!el) return Promise.resolve();
  el.classList.add(className);
  return wait(durationMs).then(() => el.classList.remove(className));
}

/**
 * Free-camera orbit around a point — same technique as Mapbox's own
 * "Animate camera around a point" / "Free camera path" examples
 * (map.setFreeCameraOptions + MercatorCoordinate), reused here as a
 * generic cinematic flourish rather than reimplemented per story. A
 * short, partial sweep (not a full dizzying spin) around `center`,
 * looking down at it the whole time — pairs well with 3D terrain
 * (enableCinematicAtmosphere) for a "drone flyover" feel.
 *
 * `center`: [lng, lat]. Resolves once the sweep completes; no-ops
 * safely (resolves immediately) if the installed mapbox-gl build or
 * map instance doesn't expose the free-camera API.
 */
export function orbitAroundPoint(map, center, opts = {}) {
  return new Promise((resolve) => {
    const MercatorCoordinate = window.mapboxgl?.MercatorCoordinate;
    if (!map || typeof map.setFreeCameraOptions !== "function" || typeof map.getFreeCameraOptions !== "function" || !MercatorCoordinate) {
      resolve();
      return;
    }
    const {
      durationMs = 3200,
      radiusMeters = 1200,
      altitudeMeters = 900,
      revolutions = 0.3, // fraction of a full turn — a sweep, not a spin
      startBearing = (map.getBearing?.() || 0) * (Math.PI / 180),
    } = opts;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const safety = setTimeout(finish, durationMs + 1500);
    const start = performance.now();

    // Small-angle equirectangular offset — plenty accurate at the
    // city-block radii a station-tour orbit uses; matches the precision
    // Mapbox's own example gets away with.
    function pointOnCircle(centerLngLat, radiusM, angleRad) {
      const metersPerDegLat = 111320;
      const metersPerDegLng = 111320 * Math.cos((centerLngLat[1] * Math.PI) / 180) || 1;
      const dx = (radiusM * Math.sin(angleRad)) / metersPerDegLng;
      const dy = (radiusM * Math.cos(angleRad)) / metersPerDegLat;
      return [centerLngLat[0] + dx, centerLngLat[1] + dy];
    }

    function frame(now) {
      if (done) return;
      const t = Math.min(1, (now - start) / durationMs);
      const angle = startBearing + EASE_SINE(t) * revolutions * Math.PI * 2;
      try {
        const camera = map.getFreeCameraOptions();
        const point = pointOnCircle(center, radiusMeters, angle);
        camera.position = MercatorCoordinate.fromLngLat(point, altitudeMeters);
        camera.lookAtPoint({ lng: center[0], lat: center[1] });
        map.setFreeCameraOptions(camera);
      } catch (_) {
        clearTimeout(safety);
        finish();
        return;
      }
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        clearTimeout(safety);
        finish();
      }
    }
    requestAnimationFrame(frame);
  });
}

/**
 * Free-camera flythrough along a path of waypoints — the same technique
 * as Mapbox's own "Animate camera along a path" example
 * (https://docs.mapbox.com/mapbox-gl-js/example/free-camera-path/):
 * map.setFreeCameraOptions + MercatorCoordinate, stepped by elapsed
 * DISTANCE along the path rather than by waypoint index, so pacing stays
 * roughly constant even when waypoints are unevenly spaced — real
 * north-to-south barrage spacing varies a lot along the Indus. The
 * camera looks a little ahead of its own position (ground-level target,
 * `lookAheadFrac` of the path further on) rather than straight down,
 * which is what actually reads as "flying along a route" instead of
 * hovering in place.
 *
 * `waypoints`: [{ center: [lng,lat], altitude? }] — altitude in meters,
 * falls back to opts.altitudeMeters per-point when omitted so callers
 * can rise/dip over specific stops without setting it on every point.
 * Resolves once the flythrough completes; no-ops safely (resolves
 * immediately) if the free-camera API isn't available or fewer than 2
 * waypoints are given.
 */
export function flyAlongPath(map, waypoints, opts = {}) {
  return new Promise((resolve) => {
    const MercatorCoordinate = window.mapboxgl?.MercatorCoordinate;
    if (!map || typeof map.setFreeCameraOptions !== "function" || typeof map.getFreeCameraOptions !== "function" || !MercatorCoordinate || !Array.isArray(waypoints) || waypoints.length < 2) {
      resolve();
      return;
    }
    const {
      durationMs = 6000,
      altitudeMeters = 3500,
      // Fraction of the TOTAL path length the camera looks ahead of its
      // own position. Smaller = steeper/more downward pitch; larger =
      // shallower, more horizon-facing.
      lookAheadFrac = 0.08,
    } = opts;

    // Segment distances via the same small-angle equirectangular approx
    // orbitAroundPoint uses above — fine at the country-scale spacing
    // between barrages; no turf dependency needed for this.
    const segLens = [];
    let total = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const [lng1, lat1] = waypoints[i].center;
      const [lng2, lat2] = waypoints[i + 1].center;
      const metersPerDegLat = 111320;
      const metersPerDegLng = 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180)) || 1;
      const dx = (lng2 - lng1) * metersPerDegLng;
      const dy = (lat2 - lat1) * metersPerDegLat;
      segLens.push(Math.sqrt(dx * dx + dy * dy) || 1);
      total += segLens[segLens.length - 1];
    }
    if (total <= 0) { resolve(); return; }

    function pointAtDistance(dist) {
      let d = Math.max(0, Math.min(total, dist));
      let i = 0;
      while (i < segLens.length - 1 && d > segLens[i]) { d -= segLens[i]; i++; }
      const a = waypoints[i];
      const b = waypoints[i + 1] || a;
      const segLen = segLens[i] || 1;
      const t = segLen ? d / segLen : 0;
      return {
        lng: a.center[0] + (b.center[0] - a.center[0]) * t,
        lat: a.center[1] + (b.center[1] - a.center[1]) * t,
        alt: (a.altitude ?? altitudeMeters) + ((b.altitude ?? altitudeMeters) - (a.altitude ?? altitudeMeters)) * t,
      };
    }

    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    const safety = setTimeout(finish, durationMs + 2000);
    const start = performance.now();

    function frame(now) {
      if (done) return;
      const t = Math.min(1, (now - start) / durationMs);
      const dist = EASE_IN_OUT_CUBIC(t) * total;
      const here  = pointAtDistance(dist);
      const ahead = pointAtDistance(Math.min(total, dist + total * lookAheadFrac));
      try {
        const camera = map.getFreeCameraOptions();
        camera.position = MercatorCoordinate.fromLngLat([here.lng, here.lat], here.alt);
        camera.lookAtPoint({ lng: ahead.lng, lat: ahead.lat });
        map.setFreeCameraOptions(camera);
      } catch (_) {
        clearTimeout(safety);
        finish();
        return;
      }
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        clearTimeout(safety);
        finish();
      }
    }
    requestAnimationFrame(frame);
  });
}

/**
 * Fades in Mapbox GL's built-in precipitation rain effect (map.setRain),
 * gated to zoom 11-13 exactly like Mapbox's own "Add 3D rain" example —
 * an expression on density/vignette ramps it in over that zoom range, so
 * calling this is safe at any zoom; the effect simply isn't visible until
 * the camera is close enough. Best-effort: older mapbox-gl builds / basemap
 * styles without precipitation support just no-op.
 */
export function enableRainEffect(map, opts = {}) {
  if (!map || typeof map.setRain !== "function") return;
  // Mapbox's own rain example gates density/vignette to zoom 11-13, but
  // that range assumes a close-in camera. Callers can supply zoomStart/
  // zoomEnd to match whatever "reveal" zoom their scene actually holds at
  // (e.g. the drone-height station shots in this app never reach 11) —
  // so the effect can be made visible WITHOUT an extra zoom-in step.
  const z0 = opts.zoomStart ?? 11;
  const z1 = opts.zoomEnd ?? 13;
  try {
    map.setRain({
      density: ["interpolate", ["linear"], ["zoom"], z0, 0, z1, opts.density ?? 0.5],
      intensity: opts.intensity ?? 1.0,
      color: opts.color ?? "#b8c4d9",
      opacity: opts.opacity ?? 0.7,
      vignette: ["interpolate", ["linear"], ["zoom"], z0, 0, z1, opts.vignette ?? 0.7],
      "vignette-color": opts.vignetteColor ?? "#3a3a3a",
      direction: opts.direction ?? [0, 80],
      "droplet-size": opts.dropletSize ?? [2.6, 18.2],
      "distortion-strength": opts.distortionStrength ?? 0.7,
      "center-thinning": 0,
    });
  } catch (_) { /* best-effort — precipitation effects are a visual nicety */ }
}

/** Reverses enableRainEffect — clears the precipitation effect entirely. */
export function disableRainEffect(map) {
  if (!map || typeof map.setRain !== "function") return;
  try { map.setRain(null); } catch (_) { /* best-effort */ }
}
