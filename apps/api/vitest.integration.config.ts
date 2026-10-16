import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real Postgres 17 (Testcontainers) as the restricted `app_rw`
 * role, so row level security is exercised. Needs a running Docker daemon.
 * Layout: `test/integration/` (repositories, triggers, jobs), `test/tenancy/` and `test/policy/`
 * (generated isolation and policy suites).
 */
export default defineConfig({
  test: {
    name: 'api-integration',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/support/postgres.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
