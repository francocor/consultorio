import { readFile } from 'node:fs/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

import { runMigrations } from '../../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Connection string for `app_owner` (owns the schema, runs migrations). */
    ownerUrl: string;
    /** Connection string for `app_rw`, the role the application runs as. */
    runtimeUrl: string;
    /** Connection string for `app_operator`, the role of the operator console. */
    operatorUrl: string;
    /** Connection string for `audit_sealer`, the login only the worker uses. */
    sealerUrl: string;
    /** Connection string for `app_releaser`, the login only the releaser uses (member of `app_rw`). */
    releaserUrl: string;
    /** Container superuser: only for tests that act as a role the application cannot become. */
    adminUrl: string;
  }
}

const DATABASE = 'consultorio_test';
/** Queues that only tests use. */
const TEST_QUEUES = [
  { name: 'test.echo', options: { retryLimit: 0 } },
  { name: 'test.write', options: { retryLimit: 0 } },
  { name: 'test.fail', options: { retryLimit: 0 } },
  { name: 'test.afip', options: { retryLimit: 0 } },
  { name: 'test.backlog', options: { retryLimit: 0 } },
  { name: 'test.flaky', options: { retryLimit: 0 } },
];
const ROLES_SQL = new URL('../../../../infra/postgres/init/01-roles.sql', import.meta.url);

/**
 * Vitest global setup for integration tests: starts one Postgres 17 container, bootstraps the
 * roles as the container superuser, runs every migration as `app_owner`, and hands two connection
 * strings to the tests. Tests connect as `app_rw`, so row level security is really exercised.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgres:17').withDatabase(DATABASE).start();

  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  try {
    await admin.query(await readFile(ROLES_SQL, 'utf8'));
  } finally {
    await admin.end();
  }

  const url = (user: string, password: string) =>
    `postgres://${user}:${password}@${container.getHost()}:${String(container.getPort())}/${DATABASE}`;
  const ownerUrl = url('app_owner', 'app_owner_dev_only');
  const runtimeUrl = url('app_rw', 'app_rw_dev_only');
  const operatorUrl = url('app_operator', 'app_operator_dev_only');
  const sealerUrl = url('audit_sealer', 'audit_sealer_dev_only');
  const releaserUrl = url('app_releaser', 'app_releaser_dev_only');

  await runMigrations(ownerUrl, TEST_QUEUES);

  project.provide('ownerUrl', ownerUrl);
  project.provide('runtimeUrl', runtimeUrl);
  project.provide('operatorUrl', operatorUrl);
  project.provide('sealerUrl', sealerUrl);
  project.provide('releaserUrl', releaserUrl);
  project.provide('adminUrl', container.getConnectionUri());

  return async () => {
    await container.stop();
  };
}
