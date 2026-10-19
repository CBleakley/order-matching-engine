import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Where `npm run dev` forwards API and WebSocket traffic. The gateway's PORT
// (P1-07) should default to the same port.
const GATEWAY_DEV_URL = 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep fonts as files: inlined data: URIs bloat the CSS with subsets the
    // browser may never need, and would need `font-src data:` in a CSP.
    assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined),
  },
  server: {
    proxy: {
      '/api': { target: GATEWAY_DEV_URL, changeOrigin: true },
      '/ws': { target: GATEWAY_DEV_URL, changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
  },
});
