import { defineConfig } from 'vitest/config';

// The checks that read the output of `vite build` (dist/). They are not part of the unit run: they
// need a build, and they fail when there is none. Run them with `pnpm --filter @consultorio/web test:build`.
export default defineConfig({
  test: {
    name: 'web-build',
    environment: 'node',
    include: ['vite/**/*.build-test.ts'],
    testTimeout: 30_000,
  },
});
