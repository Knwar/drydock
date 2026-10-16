import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DAEMON = process.env.DAEMON_URL ?? 'http://127.0.0.1:7900';

// Dev: Vite serves the app on :5190 with live reload and proxies every
// non-/app request (API, board routes, /ws) to the daemon. Build: dist/web,
// served by the daemon at /app.
export default defineConfig({
  root: __dirname,
  base: '/app/',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: Number(process.env.BRAIN_WEB_PORT ?? 5190),
    strictPort: true,
    proxy: {
      '^/(?!app(/|$)|@|node_modules|src/).*': { target: DAEMON, changeOrigin: false, ws: true },
    },
  },
});
