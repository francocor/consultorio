import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const apiTarget = process.env['API_PROXY_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [
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
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});
