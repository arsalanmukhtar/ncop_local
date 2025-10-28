import "mapbox-gl/dist/mapbox-gl.css";
import "../styles/dashboard.css";

import { createIcons, icons } from "lucide";
import mapboxgl from "mapbox-gl";
window.mapboxgl = mapboxgl;

import ndmaLogo from "@assets/images/bg_images/ndma-logo.png";
import socialMediaIcon from "@assets/images/misc_icons/social-media1.webp";
import newsIcon from "@assets/images/misc_icons/newspaper1.webp";
import { setAssets } from "../modules/set-assets.js";

// Load supporting modules (DashboardManager lives in ../modules/dashboard.js)
import "../modules/dashboard.js";
import "../modules/local-storage-manager.js";
import "../modules/utility-manager.js";

// ---- Lucide shim (so existing `lucide.createIcons()` keeps working) ----
window.lucide = {
  createIcons: (opts = {}) => createIcons({ icons, ...opts }),
  icons,
};

// ---- Mapbox token: read from Django-injected global, fallback to Vite env ----
const token =
  (typeof window !== "undefined" && window.MAPBOX_ACCESS_TOKEN) ||
  import.meta.env?.VITE_MAPBOX_ACCESS_TOKEN ||
  "";

if (token && !mapboxgl.accessToken) {
  mapboxgl.accessToken = token;
} else if (!token) {
  console.error(
    "Mapbox access token not found. Ensure the template injects window.MAPBOX_ACCESS_TOKEN or define VITE_MAPBOX_ACCESS_TOKEN in frontend/.env.development"
  );
}

// ---- Lightweight DOM setup for assets & icons ----
document.addEventListener("DOMContentLoaded", () => {
  setAssets({ ndmaLogo, socialMediaIcon, newsIcon });
  window.lucide.createIcons();
});
