import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  base: '/static/',                 // should match Django STATIC_URL
  server: {
    host: true, // Allows access via 127.0.0.1 and local IP
    port: Number(process.env.VITE_DEV_SERVER_PORT || 5173),
    strictPort: true,
    hmr: true,
  },
  build: {
    outDir: 'dist',
    manifest: true,                 // emits dist/.vite/manifest.json on Vite 5
    rollupOptions: {
      input: '/src/main.js',
    }
  }
}))
