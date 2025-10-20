import "../styles/auth-base.css";
import "../styles/login.css";

import { createIcons, icons } from "lucide";

import ndmaLogo from "@assets/images/bg_images/ndma-logo.png";
import { setAssets } from "../modules/set-assets.js";

import "../modules/auth-base.js";
import "../modules/login.js";

// Shim the old global so existing inline code `lucide.createIcons()` still works.
window.lucide = {
  createIcons: (opts = {}) => createIcons({ icons, ...opts }),
  icons, // optional: expose icons too
};

// Then in your DOMContentLoaded (if you were calling createIcons there), you can keep:
document.addEventListener("DOMContentLoaded", () => {
  setAssets({ ndmaLogo });
  window.lucide.createIcons(); // works now without changing templates
});
