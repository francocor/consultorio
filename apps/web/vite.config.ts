import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { themeBootPlugin } from './vite/theme-boot-plugin.js';

const apiTarget = process.env['API_PROXY_TARGET'] ?? 'http://localhost:3000';

/**
 * How the browser reaches the API (documented in docs/dev-setup.md, "Reverse proxy contract"):
 *
 * - `/api/*` goes to the API with the `/api` prefix removed (the API has no version prefix).
 * - `/manifest.webmanifest` and `/public/branding/logo` go to the API untouched: the per-host
 *   manifest points its icons at the logo route, and both are served by the API.
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
};

export default defineConfig({
  plugins: [
    themeBootPlugin(resolve(import.meta.dirname, 'src/app/theme-boot.ts')),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Gestión de consultorios',
        short_name: 'Consultorios',
        description: 'Gestión de turnos, pacientes y consultorios.',
        lang: 'es-AR',
        display: 'standalone',
        start_url: '/',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Only the app shell is precached. The API and file downloads are never cached, so no
        // clinical data is stored offline and these paths never fall back to index.html.
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        navigateFallbackDenylist: [/^\/api\//, /^\/files\//],
      },
    }),
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
