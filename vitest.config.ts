import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. Each package owns its runner settings in its own `vitest.config.ts`
 * (api and contracts run in Node, web runs in jsdom); this file only lists them and sets coverage.
 *
 * Coverage uses the v8 provider and reports without a threshold on purpose: thresholds are
 * decided once there is enough code for them to mean something.
 */
export default defineConfig({
  test: {
    projects: ['apps/api', 'apps/web', 'packages/contracts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/testing/**', '**/shared/test/**'],
    },
  },
});
