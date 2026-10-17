import { randomBytes } from 'node:crypto';

import pino from 'pino';

import { createFakeEmailSender } from '../adapters/fake-email/index.js';
import { createFakeScanner } from '../adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../adapters/memory-storage/index.js';
import { createS3ObjectStorage } from '../adapters/s3/index.js';
import { consentTextFor, createDemoResetPort } from '../db/seed/demo/index.js';
import { createPasswordHasher } from '../modules/identity/index.js';
import { createOperatorSecrets } from '../modules/operator/index.js';
import { holdExpireJob } from '../modules/scheduling/index.js';
import { createTenantKeys } from '../platform/crypto/tenant-keys.js';
import { createOperatorDb, createRuntimeDb } from '../platform/db/pool.js';
import { createDbProbe } from '../platform/db/probe.js';
import { createWithTenant } from '../platform/db/tenant-context.js';
import { createBoss, createJobClient } from '../platform/jobs/boss.js';
import { startWorker } from '../platform/jobs/worker.js';

import { createAdapterResolver, createTenantRoutedEmail, fake, real } from './adapter-resolver.js';
import { createApplication } from './application.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { deploymentFromConfig } from './deployment.js';
import { documentWorker } from './document-jobs.js';
import { createConfiguredEmail } from './email.js';
import { createKeyManagement } from './key-management.js';
import { buildLoggerOptions } from './logger.js';
import { loadPasswordValidator } from './password-validator.js';
import { createConfiguredScanner } from './scanner.js';

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
  const kms = createKeyManagement(config.kms);
  const keys = createTenantKeys({ kms });
  const operatorDatabase = config.operatorDatabaseUrl
    ? createOperatorDb(config.operatorDatabaseUrl)
    : undefined;
  const email = createConfiguredEmail(config.mail);
  const storage = config.storage ? createS3ObjectStorage(config.storage) : undefined;
  // Confirming an upload queues its scan in the same transaction, so with a bucket the API also
  // holds a queue client (it only enqueues; the worker is the one that runs the jobs).
  const jobsBoss = storage ? createBoss(config.databaseUrl, 'api') : undefined;
  await jobsBoss?.start();
  // Which adapter serves which organization: a demo organization only ever gets the fakes. Email is
  // routed by organization today; storage and key management are registered so the registry is
  // complete, and join the routing when their call sites carry the organization.
  const adapters = createAdapterResolver({
    email: {
      real: email.kind === 'smtp' ? real(email.sender) : fake(email.sender),
      // Outside production the configured SMTP server is a development catcher (Mailpit): a demo
      // organization's invitations show up there. In production nothing is ever delivered.
      demo: fake(config.nodeEnv === 'production' ? createFakeEmailSender() : email.sender),
    },
    objectStorage: {
      real: storage ? real(storage) : undefined,
      demo: fake(createMemoryObjectStorage()),
    },
    keyManagement: {
      real: real(kms),
      demo: fake(createLocalKeyManagement(randomBytes(32).toString('base64'))),
    },
  });
  const passwordValidator = await loadPasswordValidator({
    breachCheck: config.passwordBreachCheck,
  });
  const app = createApplication({
    database,
    logLevel: config.logLevel,
    health: { checkDatabase: () => probe.check() },
    deployment: deploymentFromConfig(config),
    trustProxy: config.trustProxy,
    ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
    ...(config.publicPort === undefined ? {} : { publicPort: config.publicPort }),
    cookieSecure: config.cookieSecure,
    keys,
    email: createTenantRoutedEmail(adapters),
    passwordValidator,
    lockout: config.lockout,
    ...(storage ? { storage } : {}),
    ...(jobsBoss ? { jobs: createJobClient(jobsBoss) } : {}),
    ...(operatorDatabase
      ? {
          operator: {
            database: operatorDatabase,
            secrets: createOperatorSecrets(kms),
            // Resetting a demo organization needs both roles: the operator's to clear it, the
            // application's to fill it again.
            demoReset: createDemoResetPort({
              operatorDb: operatorDatabase.db,
              withTenant: createWithTenant(database.db),
              hasher: createPasswordHasher(),
              keys,
              consentText: consentTextFor(database.db),
              clock: () => new Date(),
              environment: config.nodeEnv,
              // The demo has files in the bucket when there is one; its content is fictitious, so the
              // fake scanner (EICAR only) is what checks it.
              ...(storage ? { documents: { storage, scanner: createFakeScanner() } } : {}),
              rotateCredentials: config.nodeEnv === 'production',
            }),
          },
        }
      : {}),
  });

  if (config.auditSealerDatabaseUrl !== undefined) {
    app.log.warn(
      'AUDIT_SEALER_DATABASE_URL is set on the API process: only the worker should hold the audit sealer login',
    );
  }
  if (!storage) {
    app.log.warn('S3_BUCKET is not set: logo upload is unavailable');
  }
  if (!operatorDatabase) {
    app.log.warn('OPERATOR_DATABASE_URL is not set: the operator console is disabled');
  }
  if (email.kind === 'fake') {
    app.log.warn('SMTP_HOST is not set: emails (password reset, invitations) are not delivered');
  }
  await app.listen({ host: config.host, port: config.port });
  await waitForShutdownSignal();

  app.log.info('shutting down');
  await app.close();
  await jobsBoss?.stop({ graceful: true, timeout: 10_000 });
  email.close();
  storage?.close();
  await database.close();
  await operatorDatabase?.close();
  await probe.close();
}

/**
 * The only process that registers job handlers and runs the scheduled work: it seals audit
 * events every few seconds and, every night, verifies every audit chain.
 */
async function runWorker(config: Config): Promise<void> {
  const log = pino(buildLoggerOptions(config.logLevel));
  if (config.auditSealerDatabaseUrl === undefined) {
    throw new ConfigError(
      'Invalid environment configuration. AUDIT_SEALER_DATABASE_URL: is required for the worker (the audit_sealer login seals and verifies the audit trails)',
    );
  }
  // Scanning documents needs the bucket, a scanner and a way to tell an uploader about a refusal.
  const storage = config.storage ? createS3ObjectStorage(config.storage) : undefined;
  const email = createConfiguredEmail(config.mail);
  const { scanner, kind } = createConfiguredScanner(config.scanner);
  if (storage && kind === 'fake') {
    log.warn('CLAMAV_HOST is not set: documents are scanned by the fake scanner (EICAR only)');
  }
  const worker = await startWorker({
    databaseUrl: config.databaseUrl,
    sealerDatabaseUrl: config.auditSealerDatabaseUrl,
    log,
    // Scheduling: the holds that ran out are ended every minute (they are also ended lazily).
    tenantJobs: [{ definition: holdExpireJob, everyMs: 60_000 }],
    ...(storage ? documentWorker({ storage, scanner, email: email.sender }) : {}),
  });
  log.info('worker started');
  await waitForShutdownSignal();
  await worker.stop();
  email.close();
  storage?.close();
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
