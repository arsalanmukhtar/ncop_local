// frontend/vite.config.js
import { defineConfig } from "vite";
import { copyFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig(() => ({
  // IMPORTANT:
  // Leave URL prefixing to Django (STATIC_URL + django-vite).
  // If you keep "/static/" here, django-vite + Vite can become "/static/static/...".
  base: '/static/',

  plugins: [
    tailwindcss(),
    {
      name: "copy-service-worker",
      closeBundle() {
        // Copy service worker to dist
        copyFileSync(
          resolve(__dirname, "public/serviceworker.js"),
          resolve(__dirname, "dist/serviceworker.js")
        );
        console.log("✓ Service worker copied to dist");
      },
    },
  ],
  resolve: {
    alias: {
      "@assets": resolve(__dirname, "src/assets"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 150,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    },
  },
  build: {
    outDir: "dist",
    manifest: true,
    rollupOptions: {
      input: {
        auth_login: resolve(__dirname, "src/entries/auth_login.js"),
        auth_signup: resolve(__dirname, "src/entries/auth_signup.js"),
        auth_reset: resolve(__dirname, "src/entries/auth_reset.js"),
        auth_reset_confirm: resolve(__dirname, "src/entries/auth_reset_confirm.js"),
        dashboard_main: resolve(__dirname, "src/entries/dashboard_main.js"),
      },
    },
  },
}));
