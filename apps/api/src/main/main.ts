import pino from 'pino';

import { createTenantKeys } from '../platform/crypto/tenant-keys.js';
import { createRuntimeDb } from '../platform/db/pool.js';
import { createDbProbe } from '../platform/db/probe.js';
import { startWorker } from '../platform/jobs/worker.js';

import { createApplication } from './application.js';
import { loadConfig, type Config } from './config.js';
import { deploymentFromConfig } from './deployment.js';
import { createConfiguredEmail } from './email.js';
import { createKeyManagement } from './key-management.js';
import { buildLoggerOptions } from './logger.js';
import { loadPasswordValidator } from './password-validator.js';

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
  const email = createConfiguredEmail(config.mail);
  const passwordValidator = await loadPasswordValidator({
    breachCheck: config.passwordBreachCheck,
  });
  const app = createApplication({
    database,
    logLevel: config.logLevel,
    health: { checkDatabase: () => probe.check() },
    deployment: deploymentFromConfig(config),
    trustProxy: config.trustProxy,
    cookieSecure: config.cookieSecure,
    keys: createTenantKeys({ kms: createKeyManagement(config.kms) }),
    email: email.sender,
    passwordValidator,
    lockout: config.lockout,
  });

  if (email.kind === 'fake') {
    app.log.warn('SMTP_HOST is not set: emails (password reset, invitations) are not delivered');
  }
  await app.listen({ host: config.host, port: config.port });
  await waitForShutdownSignal();

  app.log.info('shutting down');
  await app.close();
  email.close();
  await database.close();
  await probe.close();
}

/**
 * The only process that registers job handlers and runs the scheduled work: it seals audit
 * events every few seconds and, every night, verifies every audit chain.
 */
async function runWorker(config: Config): Promise<void> {
  const log = pino(buildLoggerOptions(config.logLevel));
  const worker = await startWorker({ databaseUrl: config.databaseUrl, log });
  log.info('worker started');
  await waitForShutdownSignal();
  await worker.stop();
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
