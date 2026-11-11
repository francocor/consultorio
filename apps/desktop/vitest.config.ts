import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // The controller starts a local server, writes files and encrypts backups: a second or two when the PC is
    // quiet, much more when the whole monorepo is being tested at once. Like the web package, a generous cap.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
