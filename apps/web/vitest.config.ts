import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so unit tests do not load the PWA and Tailwind plugins.
export default defineConfig({
  resolve: {
    // The service worker registration is a virtual module only the Vite PWA plugin provides.
    alias: {
      'virtual:pwa-register': resolve(import.meta.dirname, 'src/shared/test/pwa-register-stub.ts'),
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'vite/**/*.test.ts'],
    setupFiles: ['./src/shared/test/setup.ts'],
    testTimeout: 30_000,
  },
});
