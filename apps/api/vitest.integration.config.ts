import { defineConfig } from 'vitest/config';

/** Integration tests (real Postgres through Testcontainers) live in `test/integration/`. */
export default defineConfig({
  test: {
    name: 'api-integration',
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
