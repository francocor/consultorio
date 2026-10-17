import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { cspPlugin } from './vite/csp-plugin.js';
import { pwaOptions } from './vite/pwa-config.js';
import { themeBootPlugin } from './vite/theme-boot-plugin.js';

const apiTarget = process.env['API_PROXY_TARGET'] ?? 'http://localhost:3000';

/**
 * How the browser reaches the API (documented in docs/dev-setup.md, "Reverse proxy contract"):
 *
 * - `/api/*` goes to the API with the `/api` prefix removed (the API has no version prefix).
 * - `/manifest.webmanifest` and `/public/branding/logo` go to the API untouched: the per-host
 *   manifest points its icons at the logo route, and both are served by the API.
 * - `/public/t/<token>` and `/public/v/<token>` (the links in reminders and offers, and the video
 *   join address) are pages the API renders itself, so they also go to the API untouched.
 *
 * The `Host` header is NOT rewritten (`changeOrigin: false`): the API picks the organization
 * from the host, so `norte.localhost:5173` must reach it as `norte.localhost:5173`.
 */
const proxy: Record<string, string | ProxyOptions> = {
  '/api': {
    target: apiTarget,
    changeOrigin: false,
    rewrite: (path) => path.replace(/^\/api/, ''),
  },
  '/manifest.webmanifest': { target: apiTarget, changeOrigin: false },
  '/public/branding/logo': { target: apiTarget, changeOrigin: false },
  '/public/t': { target: apiTarget, changeOrigin: false },
  '/public/v': { target: apiTarget, changeOrigin: false },
};

const themeBootSource = resolve(import.meta.dirname, 'src/shared/lib/theme-boot.ts');

export default defineConfig({
  plugins: [
    themeBootPlugin(themeBootSource),
    // The Content Security Policy of the bundle, sent by `vite dev` and `vite preview`.
    cspPlugin(themeBootSource),
    react(),
    tailwindcss(),
    VitePWA(pwaOptions),
  ],
  server: {
    // Organizations live at {slug}.localhost; the platform console at platform.localhost.
    allowedHosts: ['.localhost'],
    proxy,
  },
  preview: {
    allowedHosts: ['.localhost'],
    proxy,
  },
});
