import pino from 'pino';

import { createLocalArchiveStore } from '../adapters/archive-local/index.js';
import { createFakeScanner } from '../adapters/fake-scanner/index.js';
import { consentTextFor, createDemoResetPort } from '../db/seed/demo/index.js';
import { createPasswordHasher } from '../modules/identity/index.js';
import { configureAddressHash, createVideoJoinRegistry } from '../modules/notifications/index.js';
import { createOperatorSecrets } from '../modules/operator/index.js';
import { holdExpireJob } from '../modules/scheduling/index.js';
import { createReleaser, createTenantLifecycle } from '../modules/tenancy/index.js';
import { createTenantKeys } from '../platform/crypto/tenant-keys.js';
import { createOperatorDb, createRuntimeDb } from '../platform/db/pool.js';
import { createDbProbe } from '../platform/db/probe.js';
import { createWithTenant } from '../platform/db/tenant-context.js';
import { createBoss, createLazyJobs } from '../platform/jobs/boss.js';
import { startWorker } from '../platform/jobs/worker.js';
import { METRIC_DESCRIPTIONS } from '../platform/metrics-catalog.js';
import { createMetrics } from '../platform/metrics.js';
import { createTokenPurgeJob } from '../platform/tokens/purge-job.js';

import { createAdapterResolver, createTenantRoutedEmail } from './adapter-resolver.js';
import { buildAdapterRegistry } from './adapters.js';
import { createApplication } from './application.js';
import { COMMAND_NAMES, isCommandName, runCommand } from './commands/index.js';
import { processIo } from './commands/process-io.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { deploymentFromConfig } from './deployment.js';
import { documentWorker } from './document-jobs.js';
import { createConfiguredEmail } from './email.js';
import { createKeyManagement } from './key-management.js';
import { buildLoggerOptions } from './logger.js';
import { startMetricsListener } from './metrics-listener.js';
import { loadPasswordValidator } from './password-validator.js';
import { collectPlatformMetrics } from './platform-metrics.js';
import { createConfiguredScanner } from './scanner.js';
import { createConfiguredStorage } from './storage.js';
import { MODULE_WIRINGS, combineWorkerContributions } from './wiring/index.js';
import { onlineBookingMetrics } from './wiring/online-booking.js';
import { originsFromConfig } from './wiring/origins.js';
import { demoPrescriptionProviderOf } from './wiring/prescriptions.js';

/** How often the worker measures the counts of the platform (one query per organization). */
const METRICS_EVERY_MS = 60_000;

const ROLES = ['api', 'worker', 'releaser'] as const;
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

/**
 * `ARCHIVE_RELEASER_KEK` opens the archive of every cancelled organization, so it lives in ONE process:
 * the releaser. The API and the worker refuse to start with it, so a leak of their environment (or a
 * deployment that copies the same variables everywhere) never hands the key over.
 */
function assertNoReleaserKey(config: Config): void {
  if (config.providers.archive?.releaserKek !== undefined) {
    throw new ConfigError(
      'Invalid environment configuration. ARCHIVE_RELEASER_KEK: only the releaser process may hold it (the API and the worker are given ARCHIVE_RELEASER_PUBLIC_KEY)',
    );
  }
}

/**
 * The login of the releaser (`RELEASER_DATABASE_URL`, role `app_releaser`) is the one that may mark a
 * release request released and write the entries of a release (migration 0688). Like the key, it lives
 * in ONE process (JD-S6 R1-S6-12).
 */
function assertNoReleaserLogin(config: Config): void {
  if (config.releaserDatabaseUrl !== undefined) {
    throw new ConfigError(
      'Invalid environment configuration. RELEASER_DATABASE_URL: only the releaser process may hold it',
    );
  }
}

/**
 * The API serves the single-use link of a release and nothing else of the archive: it never reads or
 * writes the archive bucket, so it does not need the identity that writes it. Production refuses to
 * start with it; elsewhere (one shared `.env` on a developer's machine) the API simply does not use it:
 * the archive store is left out of its adapters (JD-S6 R1-S6-12).
 */
function withoutArchiveWriter(config: Config): Config {
  if (config.providers.archive === undefined) return config;
  if (config.nodeEnv === 'production') {
    throw new ConfigError(
      'Invalid environment configuration. ARCHIVE_S3_ACCESS_KEY_ID: the API does not write the archive and must not hold the identity that does (set ARCHIVE_S3_* for the worker only)',
    );
  }
  // The archive settings are the one thing left out of the providers the API runs on.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { archive: _archive, ...providers } = config.providers;
  return { ...config, providers };
}

async function runApi(rawConfig: Config): Promise<void> {
  assertNoReleaserKey(rawConfig);
  assertNoReleaserLogin(rawConfig);
  const config = withoutArchiveWriter(rawConfig);
  const probe = createDbProbe(config.databaseUrl);
  const database = createRuntimeDb(config.databaseUrl, { max: config.dbPoolMax });
  const kms = createKeyManagement(config.kms);
  const keys = createTenantKeys({ kms });
  const operatorDatabase = config.operatorDatabaseUrl
    ? createOperatorDb(config.operatorDatabaseUrl)
    : undefined;
  const email = createConfiguredEmail(config.mail, config.outbox);
  const storage = createConfiguredStorage(config);
  // Confirming an upload queues its scan in the same transaction, so with a bucket the API also
  // holds a queue client (it only enqueues; the worker is the one that runs the jobs). So does a
  // module that enqueues from a request (reminders, codes).
  const needsQueue = storage !== undefined || MODULE_WIRINGS.some((module) => module.needsJobs);
  // The queue connects on the first enqueue: the process starts, and answers /health, without it.
  const jobs = needsQueue ? createLazyJobs(createBoss(config.databaseUrl, 'api')) : undefined;
  // Which adapter serves which organization: a demo organization only ever gets the fakes. Email is
  // routed by organization today; the other ports are registered so the registry is complete, and
  // join the routing when their call sites carry the organization.
  const adapters = createAdapterResolver(
    buildAdapterRegistry({
      config,
      email,
      storage,
      kms,
      db: database.db,
      wiring: MODULE_WIRINGS,
    }),
  );
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
    adapters,
    wiring: MODULE_WIRINGS,
    localProviders: {
      console: config.providers.localProvidersConsole,
      providers: MODULE_WIRINGS.flatMap((module) => module.devProviders?.({ config }) ?? []),
      simulated: {
        afip: config.providers.afip === 'local',
        erx: config.providers.erx === 'local',
        payments: config.providers.payments === 'local',
      },
    },
    passwordValidator,
    lockout: config.lockout,
    ...(storage ? { storage } : {}),
    // A storage without a server of its own (the disk) takes the browser's upload through the API.
    ...(storage?.uploads ? { uploadReceiver: storage.uploads } : {}),
    ...(jobs ? { jobs: jobs.client } : {}),
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
              // The prescriptions of the demo are issued by the fake the demo organizations use, so the
              // provider console knows them; the operator's role verifies the demo's matricula.
              prescriptionProvider: demoPrescriptionProviderOf(config),
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
    app.log.warn('S3_BUCKET and STORAGE_DIR are not set: logo upload is unavailable');
  }
  if (!operatorDatabase) {
    app.log.warn('OPERATOR_DATABASE_URL is not set: the operator console is disabled');
  }
  if (email.kind === 'fake') {
    app.log.warn('SMTP_HOST is not set: emails (password reset, invitations) are not delivered');
  }
  if (email.kind === 'outbox') {
    app.log.info(
      'SMTP_HOST is not set: emails (password reset, invitations) are written to OUTBOX_DIR',
    );
  }
  await app.listen({ host: config.host, port: config.port });
  // The numbers this process keeps (the public booking counters), on a port of its own when asked.
  const stopMetrics = await startMetricsListener(config.metrics, {
    render: () => onlineBookingMetrics.render(),
    log: app.log,
  });
  await waitForShutdownSignal();

  app.log.info('shutting down');
  await stopMetrics();
  await app.close();
  await jobs?.stop({ graceful: true, timeout: 10_000 });
  email.close();
  storage?.close();
  await database.close();
  await operatorDatabase?.close();
  await probe.close();
}

/**
 * The only process that holds the key of the archive: it carries out the release requests an operator
 * approved (decrypts the scope, builds the package, emails a single-use link) and does nothing else.
 */
async function runReleaser(config: Config): Promise<void> {
  const log = pino(buildLoggerOptions(config.logLevel));
  const archive = config.providers.archive;
  if (archive?.releaserKek === undefined) {
    throw new ConfigError(
      'Invalid environment configuration. ARCHIVE_RELEASER_KEK: is required for the releaser, together with the archive bucket (ARCHIVE_S3_*)',
    );
  }
  if (config.releaserDatabaseUrl === undefined) {
    throw new ConfigError(
      'Invalid environment configuration. RELEASER_DATABASE_URL: is required for the releaser (the app_releaser login; the API and the worker role is not enough)',
    );
  }
  // The archive is hosted only: the storage is a bucket, never the disk of the desktop profile.
  const storage = config.storage ? createConfiguredStorage(config) : undefined;
  if (!storage) {
    throw new ConfigError(
      'Invalid environment configuration. S3_BUCKET: is required for the releaser (the package waits there for its link)',
    );
  }
  const email = createConfiguredEmail(config.mail, config.outbox);
  const releaser = await createReleaser({
    databaseUrl: config.releaserDatabaseUrl,
    kek: archive.releaserKek,
    store: createLocalArchiveStore(archive.storage),
    storage,
    email: email.sender,
    origins: originsFromConfig(config),
    log,
  });
  log.info('releaser started');
  await waitForShutdownSignal();
  await releaser.stop();
  email.close();
  storage.close();
  log.info('releaser stopped');
}

/**
 * The only process that registers job handlers and runs the scheduled work: it seals audit
 * events every few seconds and, every night, verifies every audit chain.
 */
async function runWorker(config: Config): Promise<void> {
  assertNoReleaserKey(config);
  assertNoReleaserLogin(config);
  const log = pino(buildLoggerOptions(config.logLevel));
  if (config.auditSealerDatabaseUrl === undefined) {
    throw new ConfigError(
      'Invalid environment configuration. AUDIT_SEALER_DATABASE_URL: is required for the worker (the audit_sealer login seals and verifies the audit trails)',
    );
  }
  // Scanning documents needs the bucket, a scanner and a way to tell an uploader about a refusal.
  const storage = createConfiguredStorage(config);
  const email = createConfiguredEmail(config.mail, config.outbox);
  const { scanner, kind } = createConfiguredScanner(config.scanner);
  if (storage && kind === 'fake') {
    log.warn(
      { profile: config.profile },
      'CLAMAV_HOST is not set: documents are scanned by the fake scanner (EICAR only)',
    );
  }
  // The same adapter registry as the API: a module's jobs resolve their providers through it.
  const runtime = createRuntimeDb(config.databaseUrl, { max: config.dbPoolMax });
  const adapters = createAdapterResolver(
    buildAdapterRegistry({
      config,
      email,
      storage,
      kms: createKeyManagement(config.kms),
      db: runtime.db,
      wiring: MODULE_WIRINGS,
    }),
  );
  // One registry for the process: teleconsultation fills it, notifications asks it.
  const videoJoin = createVideoJoinRegistry();
  // One bus for the process: the billing jobs publish the end of an organization, retention subscribes.
  const tenantLifecycle = createTenantLifecycle();
  // The numbers this process keeps and the ones it measures about the platform, described by the catalog.
  const metrics = createMetrics({ catalog: METRIC_DESCRIPTIONS });
  const worker = await startWorker({
    databaseUrl: config.databaseUrl,
    dbPoolMax: config.dbPoolMax,
    sealerDatabaseUrl: config.auditSealerDatabaseUrl,
    log,
    metrics,
    ...combineWorkerContributions([
      // Scheduling: the holds that ran out are ended every minute (they are also ended lazily).
      { tenantJobs: [{ definition: holdExpireJob, everyMs: 60_000 }] },
      // The links that expired a week ago are deleted once a day.
      { tenantJobs: [{ definition: createTokenPurgeJob(), everyMs: 86_400_000 }] },
      // The counts of the platform for the alert rules: measured every minute, nothing but numbers.
      {
        schedules: ({ db, metrics: registry }) => [
          {
            name: 'platform metrics',
            intervalMs: METRICS_EVERY_MS,
            run: () => collectPlatformMetrics({ db, metrics: registry }),
          },
        ],
      },
      ...(storage ? [documentWorker({ storage, scanner, email: email.sender })] : []),
      ...MODULE_WIRINGS.map(
        (module) =>
          module.worker?.({ config, adapters, email: email.sender, videoJoin, tenantLifecycle }) ??
          {},
      ),
    ]),
  });
  const stopMetrics = await startMetricsListener(config.metrics, {
    render: () => metrics.render(),
    log,
  });
  log.info('worker started');
  await waitForShutdownSignal();
  await stopMetrics();
  await worker.stop();
  await runtime.close();
  email.close();
  storage?.close();
  log.info('worker stopped');
}

async function main(): Promise<void> {
  const role = process.argv[2];
  // The one-shot commands (provision, reset-password, migrate) are not processes of the application.
  // The exit code is the answer, and the process ends by itself once the streams have drained, so
  // nothing written is cut short.
  if (isCommandName(role)) {
    process.exitCode = await runCommand(role, processIo(process.argv.slice(3)));
    return;
  }
  if (!isRole(role)) {
    process.stderr.write(`Usage: main.js <${[...ROLES, ...COMMAND_NAMES].join('|')}>\n`);
    process.exit(2);
  }

  // The releaser holds no key service: its own key opens the archive, and nothing else.
  const config = loadConfig(process.env, { role });
  configureAddressHash(config.providers.addressHashPepper ?? null);
  if (role === 'api') {
    await runApi(config);
  } else if (role === 'releaser') {
    await runReleaser(config);
  } else {
    await runWorker(config);
  }
}

main().catch((error: unknown) => {
  // Configuration errors never include secret values (see loadConfig).
  process.stderr.write(`${error instanceof Error ? error.message : 'Fatal error'}\n`);
  process.exit(1);
});
