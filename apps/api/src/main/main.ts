import pino from 'pino';

import { createTenantLookup } from '../modules/tenancy/index.js';
import { createRuntimeDb } from '../platform/db/pool.js';
import { createDbProbe } from '../platform/db/probe.js';

import { loadConfig, type Config } from './config.js';
import { deploymentFromConfig } from './deployment.js';
import { buildLoggerOptions } from './logger.js';
import { buildServer } from './server.js';

const ROLES = ['api', 'worker'] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string | undefined): value is Role {
  return ROLES.some((role) => role === value);
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once('SIGINT', () => {
      resolve();
    });
    process.once('SIGTERM', () => {
      resolve();
    });
  });
}

async function runApi(config: Config): Promise<void> {
  const probe = createDbProbe(config.databaseUrl);
  const database = createRuntimeDb(config.databaseUrl);
  const app = buildServer({
    logLevel: config.logLevel,
    health: { checkDatabase: () => probe.check() },
    deployment: deploymentFromConfig(config),
    trustProxy: config.trustProxy,
    lookupTenant: createTenantLookup(database.db),
  });

  await app.listen({ host: config.host, port: config.port });
  await waitForShutdownSignal();

  app.log.info('shutting down');
  await app.close();
  await database.close();
  await probe.close();
}

/** Idle stub: the job handlers arrive with pg-boss in a later stage. */
async function runWorker(config: Config): Promise<void> {
  const log = pino(buildLoggerOptions(config.logLevel));
  log.info('worker started (idle, no handlers registered)');
  await waitForShutdownSignal();
  log.info('worker stopped');
}

async function main(): Promise<void> {
  const role = process.argv[2];
  if (!isRole(role)) {
    process.stderr.write(`Usage: main.js <${ROLES.join('|')}>\n`);
    process.exit(2);
  }

  const config = loadConfig();
  if (role === 'api') {
    await runApi(config);
  } else {
    await runWorker(config);
  }
}

main().catch((error: unknown) => {
  // Configuration errors never include secret values (see loadConfig).
  process.stderr.write(`${error instanceof Error ? error.message : 'Fatal error'}\n`);
  process.exit(1);
});
