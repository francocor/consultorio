import { defineConfig, devices } from '@playwright/test';

/**
 * The ports of the preview server and the API of the stack. Several worktrees can run the suite on
 * one machine: each one sets its own `E2E_WEB_PORT` and `E2E_API_PORT` and starts the stack by hand.
 */
const WEB_PORT = Number(process.env['E2E_WEB_PORT'] ?? '4173');
const API_PORT = Number(process.env['E2E_API_PORT'] ?? '3100');
/**
 * The object storage of the stack (MinIO). A browser uploads documents straight to it, so the preview
 * server allows that origin in its Content Security Policy: the port is fixed here, not random.
 */
const STORAGE_PORT = Number(process.env['E2E_MINIO_PORT'] ?? '9190');

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
    // A toast fades in and out. Axe blends the color of a half-transparent element with what is behind
    // it, so a page checked while a toast is mid-fade reports a contrast failure that nobody sees
    // (it shows up when the machine is busy). Without the motion the check always reads the final
    // colors, and a toast that is still on screen is checked at full opacity.
    reducedMotion: 'reduce',
    timezoneId: 'America/Argentina/Buenos_Aires',
  },
  projects: [
    {
      // Signs in the platform operator once (second-factor codes cannot be replayed), so the
      // console specs of both projects share that session.
      name: 'operator-setup',
      testMatch: '**/operator.setup.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'desktop',
      dependencies: ['operator-setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile-360',
      dependencies: ['operator-setup'],
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
      // The port is repeated after the script's own default; the last one wins.
      command: `pnpm --filter @consultorio/api e2e:stack --port ${String(API_PORT)} --minio-port ${String(STORAGE_PORT)}`,
      url: `http://127.0.0.1:${String(API_PORT)}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 240_000,
      stdout: 'pipe',
    },
    {
      command: `vite preview --port ${String(WEB_PORT)} --strictPort`,
      url: `http://localhost:${String(WEB_PORT)}`,
      reuseExistingServer: !process.env['CI'],
      env: {
        API_PROXY_TARGET: `http://127.0.0.1:${String(API_PORT)}`,
        CSP_CONNECT_SOURCES: `http://localhost:${String(STORAGE_PORT)}`,
      },
    },
  ],
});
