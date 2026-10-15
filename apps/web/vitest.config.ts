import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so unit tests do not load the PWA and Tailwind plugins.
export default defineConfig({
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/shared/test/setup.ts'],
  },
});
