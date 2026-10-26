import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { findFreePort } from './ports.js';
import { PostgresCluster, DATABASE_NAME } from './postgres.js';
import { parameterizeRolesScript } from './roles.js';
import { spawnRunner } from './runner.js';
import { generateSecrets, type InstallSecrets } from './secrets.js';

/**
 * A real PostgreSQL for the tests that must not be answered by a fake: what a dump can do to a cluster is a
 * property of PostgreSQL, not of our code. It is the server of the build (`stage/postgres`), started on a free
 * port in a temporary folder. The tests that use it skip themselves when the build has not been staged.
 */
const stage = fileURLToPath(new URL('../stage/', import.meta.url));

export const STAGE_TOOLS = join(stage, 'tools');
export const stageAvailable = (): boolean =>
  [
    'postgres/bin/initdb.exe',
    'postgres/bin/pg_ctl.exe',
    'tools/pg_restore.exe',
    'tools/pg_dump.exe',
    'sql/01-roles.sql',
  ].every((file) => existsSync(join(stage, file)));

export interface TestCluster {
  cluster: PostgresCluster;
  secrets: InstallSecrets;
  folder: string;
  port: number;
  /** A client of `database` as `user`, connected. */
  connect(user: string, password: string, database: string): Promise<pg.Client>;
  /** Runs SQL as the superuser, in `database`. */
  asSuperuser(database: string, sql: string): Promise<void>;
  /** Runs SQL as `app_owner` in the database of the product. */
  asOwner(sql: string): Promise<void>;
  stop(): Promise<void>;
}

/** The roles of the product, the database, and a schema with the grants the migrations give. */
export async function startTestCluster(schema: string): Promise<TestCluster> {
  const folder = mkdtempSync(join(tmpdir(), 'consulvia-pg-'));
  const secrets = generateSecrets();
  const cluster = new PostgresCluster({
    binDir: join(stage, 'postgres', 'bin'),
    pgdata: join(folder, 'pgdata'),
    logFile: join(folder, 'postgres.log'),
    superuserPassword: secrets.pgSuperuserPassword,
    ownerPassword: secrets.appOwnerPassword,
    runner: spawnRunner,
    connect: (target) => new pg.Client(target),
    freePort: () => findFreePort(),
    isPostgresProcess: () => Promise.resolve(true),
    scratchDir: join(folder, 'tmp'),
  });
  mkdirSync(folder, { recursive: true });
  const stop = async () => {
    await cluster.stop().catch(() => undefined);
    if (existsSync(folder)) rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  };
  try {
    return await prepare();
  } catch (error) {
    // A server left running by a setup that failed would be left running for good: nobody holds it to stop it.
    await stop();
    throw error;
  }

  async function prepare(): Promise<TestCluster> {
    await cluster.initCluster();
    const port = await cluster.start();
    await cluster.ensureDatabase();
    await cluster.runScript(
      parameterizeRolesScript(readFileSync(join(stage, 'sql', '01-roles.sql'), 'utf8'), {
        appOwner: secrets.appOwnerPassword,
        appRw: secrets.appRwPassword,
        auditSealer: secrets.auditSealerPassword,
      }),
    );
    // Plain sessions: the schema is created with the default search path, as the migrations do.
    const connect = async (user: string, password: string, database: string) => {
      const client = new pg.Client({ host: '127.0.0.1', port, user, password, database });
      await client.connect();
      return client;
    };
    const asOwner = async (sql: string) => {
      const client = await connect('app_owner', secrets.appOwnerPassword, DATABASE_NAME);
      try {
        await client.query(sql);
      } finally {
        await client.end();
      }
    };
    await asOwner(schema);
    return {
      cluster,
      secrets,
      folder,
      port,
      connect,
      async asSuperuser(database, sql) {
        await cluster.asSuperuser(
          database,
          async (client) => {
            await client.query(sql);
          },
          false,
        );
      },
      asOwner,
      stop,
    };
  }
}
