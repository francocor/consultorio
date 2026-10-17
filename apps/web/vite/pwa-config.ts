import type { VitePWAOptions } from 'vite-plugin-pwa';

type Workbox = NonNullable<VitePWAOptions['workbox']>;

/** Paths whose responses may hold protected data, or belong to one organization: network only. */
const NEVER_CACHED = /^\/(?:api|files|public)\//;
const MANIFEST = '/manifest.webmanifest';

/**
 * Workbox settings of the installable app (design, section 8 and the app-shell spec).
 *
 * - Only the app shell is precached: the HTML, the scripts and styles, the product icons and the
 *   Latin subset of the default font. Nothing the API returns is ever stored on the device.
 * - Page navigations get the shell (`/index.html`) so the app opens offline and shows its offline
 *   banner, but the API, downloads, the logo and the manifest never fall back to it.
 * - The runtime rule is `NetworkOnly` for those paths: an offline request fails instead of
 *   answering with an old copy, so no stale clinical data can appear without a valid session.
 */
export const workboxConfig: Workbox = {
  globPatterns: [
    'index.html',
    'assets/**/*.{js,css}',
    'assets/inter-latin-wght-normal-*.woff2',
    'icons/*.{png,svg}',
  ],
  navigateFallback: '/index.html',
  navigateFallbackDenylist: [/^\/api\//, /^\/files\//, /^\/public\//, /^\/manifest\.webmanifest$/],
  runtimeCaching: [
    {
      urlPattern: ({ url }) => NEVER_CACHED.test(url.pathname) || url.pathname === MANIFEST,
      handler: 'NetworkOnly',
    },
  ],
  cleanupOutdatedCaches: true,
  // The new version waits until the person accepts the update prompt.
  skipWaiting: false,
  clientsClaim: false,
};

/**
 * The plugin options. The manifest is NOT generated here: each organization has its own, served
 * by the API at `/manifest.webmanifest` (name, colors, logo). The service worker is registered
 * by the app (`app/pwa.ts`) so it can ask before updating.
 */
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: 'prompt',
  injectRegister: false,
  manifest: false,
  workbox: workboxConfig,
};
