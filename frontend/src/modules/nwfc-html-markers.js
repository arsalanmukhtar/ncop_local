// ===========================================================================
// nwfc-html-markers.js
// ---------------------------------------------------------------------------
// HTML mapboxgl.Marker driver for the NWFC Station Observations layer.
//
// Why HTML markers instead of Mapbox symbol icons?
//
//   The Mapbox v3 vector-tile encoder for GeoJSON sources silently drops
//   properties added by mutating features after fetch — even though
//   querySourceFeatures / queryRenderedFeatures both still show them.
//   Every attempt to compute the icon sprite from `["get", "wxIcon"]`
//   fell through to the fallback, and even `["get", "weather"]` (which
//   is on the *original* API response) had inconsistent behaviour in
//   layer expressions.  The label works because `temperature` happens
//   to survive, but the icon expression path is unreliable in this
//   Mapbox version for our data shape.
//
//   GCOP's own live NCOP shortcut around all of this by using
//   `new mapboxgl.Marker({element})` — a plain HTML div anchored at
//   each station.  Browser handles GIF playback natively, no JS
//   animation loop, no sprite-atlas dance.  This module ports that
//   exact pattern.
//
// Contract
//
//   - One HTML marker per feature in `nwfc_observations-source`.
//   - Icon = <img src="…/rain.gif"> etc. (native browser GIF anim).
//   - Label = <div>27°</div> sitting just under the icon.
//   - Fixed 36 CSS-px icon, doesn't scale with zoom (per user request).
//   - Marker click re-fires `map.fire("click", …)` at the station's
//     lng/lat, so the invisible click-target circle in map-layers.js
//     picks it up and the existing popup dispatcher runs the NWFC
//     Chart.js popup as before.
//   - Idempotent reconcile: adds new features, updates position on
//     existing, removes vanished ones.  Cleared on layer toggle-off
//     and on basemap swap (style.load).
// ===========================================================================

import mapboxgl from "mapbox-gl";
import { NWFC_WEATHER_ICON_URLS } from "./nwfc-weather-icons.js";
import { nwfcWeatherBucket } from "./map-icons.js";

const SOURCE_ID       = "nwfc_observations-source";
const CLICK_LAYER_ID  = "nwfc_observations-click";
const MARKER_ICON_PX  = 36;

class NwfcHtmlMarkerManager {
  #map = null;
  #markers = new Map();  // key → { marker, feature }
  #boundOnData = null;
  #boundStyleLoad = null;
  #pending = false;

  attach(map) {
    if (!map || this.#map === map) return;
    if (this.#map) this.detach();
    this.#map = map;
    this.#boundOnData = (e) => {
      if (!e || e.sourceId !== SOURCE_ID) return;
      if (!e.isSourceLoaded) return;
      this.#scheduleSync();
    };
    this.#boundStyleLoad = () => this.#scheduleSync();
    map.on("sourcedata", this.#boundOnData);
    map.on("data",       this.#boundOnData);
    map.on("style.load", this.#boundStyleLoad);
  }

  detach() {
    if (!this.#map) return;
    try { this.#map.off("sourcedata", this.#boundOnData); }    catch (_) {}
    try { this.#map.off("data",       this.#boundOnData); }    catch (_) {}
    try { this.#map.off("style.load", this.#boundStyleLoad); } catch (_) {}
    this.#clearAll();
    this.#map = null;
  }

  #scheduleSync() {
    if (this.#pending) return;
    this.#pending = true;
    requestAnimationFrame(() => {
      this.#pending = false;
      this.#sync();
    });
  }

  #sync() {
    const map = this.#map;
    if (!map) return;

    // Layer gone or hidden → tear down every marker.
    const layer = map.getLayer(CLICK_LAYER_ID);
    if (!layer) { this.#clearAll(); return; }
    const visible = map.getLayoutProperty(CLICK_LAYER_ID, "visibility") !== "none";
    if (!visible) { this.#clearAll(); return; }

    // Read features from the source's raw data.
    const src = map.getSource(SOURCE_ID);
    if (!src) { this.#clearAll(); return; }
    const data = src._data;
    const features = data && Array.isArray(data.features) ? data.features : [];
    this.#reconcile(features);
  }

  #reconcile(features) {
    const seen = new Set();
    features.forEach((f, i) => {
      if (!f || !f.geometry || f.geometry.type !== "Point") return;
      const coords = f.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      const key = this.#keyFor(f, i);
      seen.add(key);
      const existing = this.#markers.get(key);
      if (existing) {
        existing.marker.setLngLat(coords);
        existing.feature = f;
        return;
      }
      const created = this.#createMarker(f, coords);
      if (created) this.#markers.set(key, created);
    });
    for (const [key, obj] of this.#markers.entries()) {
      if (!seen.has(key)) {
        try { obj.marker.remove(); } catch (_) {}
        this.#markers.delete(key);
      }
    }
  }

  #keyFor(f, i) {
    const p = f.properties || {};
    return f.id ?? p.id ?? p.code ?? p.station_id ?? `${i}:${f.geometry.coordinates.join(",")}`;
  }

  #createMarker(feature, coords) {
    const map = this.#map;
    if (!map) return null;
    const p = feature.properties || {};
    const wxText = p.weather ?? p.wx ?? "";
    const bucket = nwfcWeatherBucket(wxText);
    const iconUrl = NWFC_WEATHER_ICON_URLS[bucket];

    const wrap = document.createElement("div");
    wrap.className = "nwfc-html-marker";
    wrap.style.cssText = [
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "cursor:pointer",
      "user-select:none",
      "pointer-events:auto",
    ].join(";");

    // Weather icon (native browser GIF playback — no JS anim loop).
    if (iconUrl) {
      const img = document.createElement("img");
      img.src = iconUrl;
      img.alt = String(wxText || "");
      img.loading = "lazy";
      img.decoding = "async";
      img.style.cssText = [
        `width:${MARKER_ICON_PX}px`,
        `height:${MARKER_ICON_PX}px`,
        "object-fit:contain",
        "pointer-events:none",
        "filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))",
      ].join(";");
      wrap.appendChild(img);
    } else {
      // DEFAULT bucket — no matching asset.  Use a thermometer emoji
      // so the marker still renders visibly.
      const emoji = document.createElement("div");
      emoji.textContent = "🌡";
      emoji.style.cssText = [
        `font-size:${Math.round(MARKER_ICON_PX * 0.85)}px`,
        "line-height:1",
        "pointer-events:none",
        "filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4))",
      ].join(";");
      wrap.appendChild(emoji);
    }

    // Temperature label (matches GCOP's format).
    const t = p.temperature;
    if (t !== null && t !== undefined && t !== "") {
      const label = document.createElement("div");
      const n = Number(t);
      label.textContent = Number.isFinite(n) ? `${Math.round(n)}°` : `${t}°`;
      label.style.cssText = [
        "font-size:11px",
        "font-weight:800",
        "color:#fff",
        "background:rgba(15,23,42,0.78)",
        "border-radius:4px",
        "padding:1px 6px",
        "margin-top:2px",
        "pointer-events:none",
        "letter-spacing:0.2px",
        "white-space:nowrap",
      ].join(";");
      wrap.appendChild(label);
    }

    // Route click through to the popup dispatcher — fire a synthetic
    // Mapbox click at the station's coordinates, which the invisible
    // `nwfc_observations-click` circle layer will pick up, so the
    // existing NWFC popup builder in layer-attribute-popup.js runs
    // unchanged.
    wrap.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const lngLat = mapboxgl.LngLat.convert(coords);
      const point  = map.project(lngLat);
      map.fire("click", { lngLat, point, originalEvent: evt, target: map });
    });

    const marker = new mapboxgl.Marker({
      element: wrap,
      anchor:  "center",
    })
      .setLngLat(coords)
      .addTo(map);

    return { marker, feature };
  }

  #clearAll() {
    for (const obj of this.#markers.values()) {
      try { obj.marker.remove(); } catch (_) {}
    }
    this.#markers.clear();
  }
}

const manager = new NwfcHtmlMarkerManager();

export function initNwfcHtmlMarkers(map) {
  manager.attach(map);
}
