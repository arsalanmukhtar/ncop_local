// ===========================================================================
// nwfc-weather-icons.js
// ---------------------------------------------------------------------------
// NWFC Station Observations weather-icon assets — 13 GIF/PNG sprites at
// frontend/src/assets/images/nwfc_icons/.  Vite resolves each import to
// a hashed URL at build time, and the map registration in
// map-icons.js hands those URLs to map.loadImage()/map.addImage() using
// the standard Mapbox sprite pattern.  Replaces the previous Lottie
// pipeline that required a runtime player and per-icon offscreen canvas.
//
// Mapbox `loadImage` decodes the URL into an HTMLImageElement (via the
// browser's Image() constructor) and hands us back a raster — that's the
// same code path used by every other custom sprite in this project
// (airport, school, settlement, EONET badges).  Animated GIFs are
// decoded to their FIRST FRAME only (a Mapbox raster-atlas limitation);
// static PNGs render as-is.  Both are treated uniformly downstream.
// ===========================================================================

import cloudyUrl        from "../assets/images/nwfc_icons/cloudy.gif";
import coldUrl          from "../assets/images/nwfc_icons/cold.gif";
import drizzleUrl       from "../assets/images/nwfc_icons/drizzle.gif";
import dustUrl          from "../assets/images/nwfc_icons/dust.gif";
import fogUrl           from "../assets/images/nwfc_icons/fog.png";
import hotUrl           from "../assets/images/nwfc_icons/hot.gif";
import overcastUrl      from "../assets/images/nwfc_icons/overcast.png";
import partlyCloudyUrl  from "../assets/images/nwfc_icons/partly_cloudy.gif";
import rainUrl          from "../assets/images/nwfc_icons/rain.gif";
import snowUrl          from "../assets/images/nwfc_icons/snow.gif";
import sunnyUrl         from "../assets/images/nwfc_icons/sunny.gif";
import thunderstormUrl  from "../assets/images/nwfc_icons/thunderstorm.gif";
import windyUrl         from "../assets/images/nwfc_icons/windy.gif";

/**
 * Bucket key → hashed asset URL, keyed identically to NWFC_WX_ICON_IDS
 * in map-icons.js.  The `default` bucket is deliberately omitted so
 * map-icons.js keeps the pulsing-thermometer canvas fallback for any
 * unrecognised weather string.
 */
export const NWFC_WEATHER_ICON_URLS = {
  thunderstorm:  thunderstormUrl,
  rain:          rainUrl,
  drizzle:       drizzleUrl,
  snow:          snowUrl,
  fog:           fogUrl,
  dust:          dustUrl,
  overcast:      overcastUrl,
  cloudy:        cloudyUrl,
  partly_cloudy: partlyCloudyUrl,
  clear:         sunnyUrl,
  windy:         windyUrl,
  hot:           hotUrl,
  cold:          coldUrl,
};
