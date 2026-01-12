// frontend/vite.config.js
import { defineConfig } from "vite";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

import tailwindcss from "@tailwindcss/vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HMR_HOST = process.env.VITE_HMR_HOST || "localhost";

export default defineConfig(({ command }) => ({
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
}));