// frontend/vite.config.js
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load repo-root .env so we share one source of truth with Django.
// Vite's own .env loader only scans `envDir` (defaults to this config's
// directory) and only exposes VITE_* to client code — not to config-time
// process.env. loadEnv() with the repo root gives us both Node-level access
// and keeps the values aligned with what django-environ reads.
const REPO_ROOT = resolve(__dirname, "..");

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, REPO_ROOT, "");
  const HMR_HOST = env.VITE_HMR_HOST || "localhost";
  return {
  // CRITICAL FIX: Use "/" in dev, "/static/" in production
  base: command === "serve" ? "/" : "/static/",

  plugins: [
    tailwindcss(),
  ],

  resolve: {
    alias: {
      "@assets": resolve(__dirname, "src/assets"),
    },
  },

  server: {
    host: "0.0.0.0", // bind on all interfaces
    port: 5173,
    strictPort: true,
    hmr: {
      host: HMR_HOST, // what the browser should connect to
      port: 5173,
    },
    origin: `http://${HMR_HOST}:5173`,
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
        auth_reset_confirm: resolve(
          __dirname,
          "src/entries/auth_reset_confirm.js"
        ),
        dashboard_main: resolve(__dirname, "src/entries/dashboard_main.js"),
      },
    },
  },
  };
});