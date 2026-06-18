import "../styles/auth-base.css";
import "../styles/signup.css";

import { createIcons, icons } from "lucide";

import ndmaLogo from "@assets/images/bg_images/ndma-logo.png";
import { setAssets } from "../modules/set-assets.js";

import "../modules/auth-base.js";
import "../modules/signup.js";

// Shim the old global so existing inline code `lucide.createIcons()` still works.
window.lucide = {
  createIcons: (opts = {}) => createIcons({ icons, ...opts }),
  icons, // optional: expose icons too
};

document.addEventListener("DOMContentLoaded", () => {
  setAssets({ ndmaLogo });
  window.lucide.createIcons();
});
