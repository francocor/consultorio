import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 4173;
const API_PORT = 3100;

/**
 * End-to-end tests run against the REAL stack: the built web app served by `vite preview` (with
 * the same /api proxy a reverse proxy applies), the API and worker, Postgres 17 and Mailpit,
 * all started by `pnpm --filter @consultorio/api e2e:stack` (Docker is the only requirement).
 * Two demo organizations (`aillu` and `norte`) and one platform operator are seeded.
 *
 * Browsers resolve `*.localhost` to the loopback address, so each organization has its own origin
 * (`http://aillu.localhost:4173`) and its own cookie jar, like in production.
 *
 * Projects:
 * - `desktop` runs every spec, including the journeys that change data.
 * - `mobile-360` (the narrowest supported phone) runs only `*.responsive.spec.ts`: read-only
 *   checks of layout and accessibility, so both projects can run side by side.
 */
export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/.stack/**'],
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'on-first-retry',
    // The service worker has its own spec; keep it out of the way of the page tests.
    serviceWorkers: 'block',
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile-360',
      testMatch: '**/*.responsive.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @consultorio/api e2e:stack',
      url: `http://127.0.0.1:${String(API_PORT)}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 240_000,
      stdout: 'pipe',
    },
    {
      command: `vite preview --port ${String(WEB_PORT)} --strictPort`,
      url: `http://localhost:${String(WEB_PORT)}`,
      reuseExistingServer: !process.env['CI'],
      env: { API_PROXY_TARGET: `http://127.0.0.1:${String(API_PORT)}` },
    },
  ],
});
