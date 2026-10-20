import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

import { createLocalArchiveStore } from '../../src/adapters/archive-local/index.js';
import {
  ARCHIVE_WRITER_USER,
  archiveWriterPolicy,
} from '../../src/adapters/archive-local/policies.js';
import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createS3ObjectStorage } from '../../src/adapters/s3/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { tenant } from '../../src/db/schema/tenant.js';
import {
  consentTextFor,
  createDemoResetPort,
  DEMO_PASSWORD,
  ensureDemoTenant,
  seedDemoTenant,
} from '../../src/db/seed/demo/index.js';
import { PLATFORM_DEMO_TENANTS, seedPlatformDemo } from '../../src/db/seed/demo/stage6/index.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createAdapterResolver } from '../../src/main/adapter-resolver.js';
import { buildAdapterRegistry } from '../../src/main/adapters.js';
import { createApplication } from '../../src/main/application.js';
import { loadConfig } from '../../src/main/config.js';
import { documentWorker } from '../../src/main/document-jobs.js';
import { createConfiguredEmail } from '../../src/main/email.js';
import { loadPasswordValidator } from '../../src/main/password-validator.js';
import { MODULE_WIRINGS, combineWorkerContributions } from '../../src/main/wiring/index.js';
import { originsFromConfig } from '../../src/main/wiring/origins.js';
import { demoPrescriptionProviderOf } from '../../src/main/wiring/prescriptions.js';
import { createPasswordHasher } from '../../src/modules/identity/index.js';
import { createVideoJoinRegistry } from '../../src/modules/notifications/index.js';
import { createOperatorAdminFor, createOperatorSecrets } from '../../src/modules/operator/index.js';
import { holdExpireJob } from '../../src/modules/scheduling/index.js';
import { generateReleaserKeys } from '../../src/modules/tenancy/archive/archive-crypto.js';
import {
  createReleaser,
  createTenantLifecycle,
  enqueueDueArchives,
  enqueuePendingExports,
} from '../../src/modules/tenancy/index.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOperatorDb, createOwnerDb, createRuntimeDb } from '../../src/platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createBoss, createJobClient } from '../../src/platform/jobs/boss.js';
import { startWorker } from '../../src/platform/jobs/worker.js';

const DATABASE = 'consultorio_stack';
const ROLES_SQL = new URL('../../../../infra/postgres/init/01-roles.sql', import.meta.url);

/** The object storage of the stack: the same MinIO image the local environment runs. */
const MINIO_IMAGE = 'bitnamilegacy/minio:2025.7.23-debian-12-r5';
const MINIO_USER = 'minio_stack';
const MINIO_PASSWORD = 'minio_stack_only_secret';
const BUCKET = 'consultorio-files';

/**
 * The retention archive of the stack: a bucket with Object Lock and the writer identity of the local
 * environment (the policies of `adapters/archive-local`), in the same MinIO as the files. The
 * archive is written the moment a cancelled organization is found (`ARCHIVE_AFTER_DAYS=0`).
 */
const ARCHIVE_BUCKET = 'consultorio-archive';
const ARCHIVE_WRITER_SECRET = 'archive_stack_writer_secret';

/** How often the stack looks for work that production looks for in minutes. */
const STACK_SWEEP_MS = 2000;

/** The operator of the throwaway stack. Public development values, like the demo passwords. */
const OPERATOR = {
  email: 'operador@demo.invalid',
  displayName: 'Operadora de la plataforma',
  password: 'Operador-Demo-2026-clave',
} as const;

/**
 * A second operator. Releasing archived records takes two people (one verifies the identity of the
 * requester, a different one approves), so the journeys that release need a pair.
 */
const OPERATOR_TWO = {
  email: 'operador.dos@demo.invalid',
  displayName: 'Segundo operador de la plataforma',
  password: 'Operador-Demo-2026-clave-dos',
} as const;

export interface StackOptions {
  /** Port of the API. */
  apiPort: number;
  /** Where to write the connection details (a JSON file the tests read). */
  infoFile?: string;
  baseDomain?: string;
  platformHost?: string;
  /** The port of the web app in emailed links (`pnpm demo:stack` serves it on 5173). */
  publicPort?: number;
  /** Run the worker (audit sealing, scans, hold expiry) in the same process. */
  withWorker?: boolean;
  /**
   * Also create the four billed organizations of `pnpm demo:platform` (a trial, an active
   * subscription, a charge that failed, a read-only organization). On by default: the browser
   * journeys of the subscription use them as their starting points.
   */
  platformDemo?: boolean;
  /**
   * Host port of the object storage. A browser uploads documents straight to it, so the web app must
   * allow that origin (`CSP_CONNECT_SOURCES=http://localhost:<port>` when it is built or served).
   * Random when absent.
   */
  minioPort?: number;
  log?: (line: string) => void;
}

export interface StackInfo {
  apiUrl: string;
  mailpitUrl: string;
  /** Where browsers upload documents (the S3 API of MinIO). */
  storageUrl: string;
  baseDomain: string;
  platformHost: string;
  demoPassword: string;
  tenants: Record<string, { id: string; slug: string; name: string; emailSuffix: string }>;
  operator: { email: string; password: string; totpSecret: string };
  /** The second person of the four-eyes steps of the archive release. */
  operatorTwo: { email: string; password: string; totpSecret: string };
  /** The billed organizations of the platform demo, by state (empty when the stack was told not to make them). */
  platformDemo: Record<
    string,
    {
      slug: string;
      name: string;
      ownerEmail: string;
      receptionEmail: string;
      professionalEmail: string | null;
    }
  >;
}

export interface Stack {
  info: StackInfo;
  stop(): Promise<void>;
}

/** The look of the second organization, so two hosts show two different themes. */
const NORTE_THEME = {
  displayName: 'Clínica Norte',
  shortName: 'Norte',
  primaryRequested: '#1e40af',
  radius: 'sm',
  headingFont: 'source_sans',
};

/**
 * A complete local stack with nothing installed on the machine except Docker: Postgres 17
 * (migrated, roles as in production), Mailpit, the API (and optionally the worker), two seeded
 * demo organizations and one platform operator. It backs the Playwright suite and `pnpm demo:stack`.
 * Everything is thrown away when it stops.
 */
export async function startStack(options: StackOptions): Promise<Stack> {
  const log = options.log ?? (() => undefined);
  const baseDomain = options.baseDomain ?? 'localhost';
  const platformHost = options.platformHost ?? `platform.${baseDomain}`;

  log('Starting Postgres, MinIO and Mailpit containers');
  const [postgres, mailpit, minio] = await Promise.all([
    new PostgreSqlContainer('postgres:17').withDatabase(DATABASE).start(),
    new GenericContainer('axllent/mailpit:v1.31.6')
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/livez', 8025))
      .start(),
    new GenericContainer(MINIO_IMAGE)
      .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
      .withExposedPorts(
        options.minioPort === undefined ? 9000 : { container: 9000, host: options.minioPort },
      )
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000).forStatusCode(200))
      .withStartupTimeout(120_000)
      .start(),
  ]);
  const closers: (() => Promise<unknown>)[] = [
    () => postgres.stop(),
    () => mailpit.stop(),
    () => minio.stop(),
  ];

  try {
    const { Client } = await import('pg');
    const admin = new Client({ connectionString: postgres.getConnectionUri() });
    await admin.connect();
    try {
      await admin.query(await readFile(ROLES_SQL, 'utf8'));
    } finally {
      await admin.end();
    }
    const url = (user: string, password: string) =>
      `postgres://${user}:${password}@${postgres.getHost()}:${String(postgres.getPort())}/${DATABASE}`;
    const ownerUrl = url('app_owner', 'app_owner_dev_only');
    const runtimeUrl = url('app_rw', 'app_rw_dev_only');
    const operatorUrl = url('app_operator', 'app_operator_dev_only');
    const sealerUrl = url('audit_sealer', 'audit_sealer_dev_only');

    log('Migrating');
    await runMigrations(ownerUrl);
    const owner = createOwnerDb(ownerUrl);
    await seedPlatformCatalogs(owner.db);
    await owner.close();

    const runtime = createRuntimeDb(runtimeUrl);
    const operatorDb = createOperatorDb(operatorUrl);
    closers.push(
      () => runtime.close(),
      () => operatorDb.close(),
    );

    log('Preparing the archive bucket');
    await prepareArchiveBucket(minio);

    // The browser sends files to this address, so it is the one it can reach: `localhost`.
    const storageUrl = `http://localhost:${String(minio.getMappedPort(9000))}`;
    const credentials = { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD };
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: storageUrl,
      forcePathStyle: true,
      credentials,
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    s3.destroy();
    const storage = createS3ObjectStorage({
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint: storageUrl,
      forcePathStyle: true,
      credentials,
    });
    closers.push(() => {
      storage.close();
      return Promise.resolve();
    });
    // The files of the demo are checked by the fake scanner, like in any development environment.
    const scanner = createFakeScanner();

    // One key-encryption key for the whole stack, like in production, where the API and the worker
    // share it: the worker wiring builds its own key service from the configuration below.
    const kek = randomBytes(32).toString('base64');
    const releaserKeys = generateReleaserKeys();
    const kms = createLocalKeyManagement(kek);
    const keys = createTenantKeys({ kms });
    const email = createConfiguredEmail({
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
      security: 'none',
      from: 'Consultorio <no-responder@localhost>',
    });
    closers.push(() => {
      email.close();
      return Promise.resolve();
    });
    const hasher = createPasswordHasher();
    const withTenant = createWithTenant(runtime.db);

    // The same composition as `main`: the modules, their adapters (the local simulators), the
    // provider console and the jobs of the worker, so a browser journey runs the real thing.
    const config = loadConfig({
      DATABASE_URL: runtimeUrl,
      BASE_DOMAIN: baseDomain,
      PLATFORM_HOST: platformHost,
      KMS_LOCAL_KEK_BASE64: kek,
      LOCAL_PROVIDERS_CONSOLE: 'true',
      // The worker wiring (exports, invoice PDFs) builds its storage from this configuration, the
      // same bucket and credentials the API got above.
      S3_BUCKET: BUCKET,
      S3_REGION: 'us-east-1',
      S3_ENDPOINT: storageUrl,
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: MINIO_USER,
      S3_SECRET_ACCESS_KEY: MINIO_PASSWORD,
      // The archive of the cancelled organizations. The API and the worker hold only the PUBLIC half of
      // the key of the releaser; the private half goes to the releaser below and nowhere else.
      ARCHIVE_S3_BUCKET: ARCHIVE_BUCKET,
      ARCHIVE_S3_ENDPOINT: storageUrl,
      ARCHIVE_S3_ACCESS_KEY_ID: ARCHIVE_WRITER_USER,
      ARCHIVE_S3_SECRET_ACCESS_KEY: ARCHIVE_WRITER_SECRET,
      ARCHIVE_RELEASER_PUBLIC_KEY: releaserKeys.publicKey,
      ARCHIVE_AFTER_DAYS: '0',
    });

    // Two demo organizations with different looks.
    log('Seeding demo organizations');
    const deps = {
      withTenant,
      hasher,
      keys,
      consentText: consentTextFor(runtime.db),
      clock: () => new Date(),
      documents: { storage, scanner },
      // The platform operator verifies the matricula of the cardiologist of each demo organization
      // (the only professional who may prescribe, like an organization that went through the
      // operator's queue); the other professionals stay unverified. Only the operator's role can.
      operatorDb: operatorDb.db,
      // What the demo issues is held by the fake the application serves the demo with, so the
      // provider console knows it.
      prescriptionProvider: demoPrescriptionProviderOf(config),
    };
    const aillu = await ensureDemoTenant(runtime.db, withTenant, 'aillu');
    await seedDemoTenant(deps, aillu.id);
    const norte = await ensureDemoTenant(runtime.db, withTenant, 'norte');
    await seedDemoTenant(
      { ...deps, emailFor: (staff) => staff.email.replace('@', '+norte@') },
      norte.id,
    );
    const applyNorteTheme = () =>
      withTenant({ tenantId: norte.id, userId: SYSTEM_USER_ID }, (tx) =>
        tx.update(tenant).set({ theme: NORTE_THEME }).where(eq(tenant.id, norte.id)),
      );
    await applyNorteTheme();

    // The organizations with a subscription: each state of it, built by the services of the module.
    if (options.platformDemo !== false) {
      log('Seeding the platform demo organizations');
      await seedPlatformDemo({
        db: runtime.db,
        withTenant,
        hasher,
        origins: originsFromConfig(config),
        webhookSecret: randomBytes(24).toString('hex'),
        publicBaseUrl: `http://${platformHost}/api`,
        environment: 'development',
      });
    }

    const operatorAdmin = createOperatorAdminFor({
      db: operatorDb.db,
      hasher,
      secrets: createOperatorSecrets(kms),
    });
    const operator = await operatorAdmin.create({
      email: OPERATOR.email,
      displayName: OPERATOR.displayName,
      password: OPERATOR.password,
    });

    const operatorTwo = await operatorAdmin.create({
      email: OPERATOR_TWO.email,
      displayName: OPERATOR_TWO.displayName,
      password: OPERATOR_TWO.password,
    });

    const jobsBoss = createBoss(runtimeUrl, 'api');
    await jobsBoss.start();
    closers.unshift(() => jobsBoss.stop({ graceful: false }));

    const passwordValidator = await loadPasswordValidator({ breachCheck: false });
    const adapters = createAdapterResolver(
      buildAdapterRegistry({
        config,
        email,
        storage,
        kms,
        db: runtime.db,
        wiring: MODULE_WIRINGS,
      }),
    );
    const app = createApplication({
      database: runtime,
      logLevel: 'warn',
      health: { checkDatabase: () => Promise.resolve({ ok: true }) },
      deployment: { mode: 'multi', baseDomain, platformHost },
      trustProxy: false,
      cookieSecure: false,
      ...(options.publicPort === undefined ? {} : { publicPort: options.publicPort }),
      keys,
      email: email.sender,
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
      storage,
      // Confirming an upload queues its scan; the worker below runs it.
      jobs: createJobClient(jobsBoss),
      // A browser suite signs in all day from one address: the limits have their own tests.
      limits: {
        perClient: { max: 100_000, windowMs: 60_000 },
        perTenant: { max: 100_000, windowMs: 60_000 },
        login: { max: 100_000, timeWindow: 60_000 },
      },
      operator: {
        database: operatorDb,
        secrets: createOperatorSecrets(kms),
        // The console's "reset demo" button works in the local stack too; the second organization
        // keeps its own addresses and look through a reset.
        demoReset: createDemoResetPort({
          ...deps,
          operatorDb: operatorDb.db,
          variantOf: (tenantId) =>
            tenantId === norte.id
              ? {
                  emailFor: (staff) => staff.email.replace('@', '+norte@'),
                  afterSeed: async () => {
                    await applyNorteTheme();
                  },
                }
              : undefined,
        }),
      },
    });
    await app.listen({ host: '127.0.0.1', port: options.apiPort });
    closers.unshift(() => app.close());

    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    if (options.withWorker !== false) {
      const videoJoin = createVideoJoinRegistry();
      // One bus for the worker: the billing jobs publish the end of an organization, retention subscribes.
      const tenantLifecycle = createTenantLifecycle();
      worker = await startWorker({
        databaseUrl: runtimeUrl,
        sealerDatabaseUrl: sealerUrl,
        log: pino({ level: 'warn' }),
        sealGraceMs: 500,
        sealIntervalMs: 1500,
        ...combineWorkerContributions([
          { tenantJobs: [{ definition: holdExpireJob, everyMs: 60_000 }] },
          documentWorker({ storage, scanner, email: email.sender }),
          ...MODULE_WIRINGS.map(
            (module) =>
              module.worker?.({
                config,
                adapters,
                email: email.sender,
                videoJoin,
                tenantLifecycle,
              }) ?? {},
          ),
        ]),
      });
      closers.unshift(() => worker?.stop() ?? Promise.resolve());
    }

    // The releaser: the one process with the private key of the archive. In the stack it runs in this
    // process, with its own pool, and looks for approved requests every couple of seconds. The sweeps of
    // the worker that production runs every few minutes are brought forward too, so a journey that
    // cancels an organization sees its export and its archive within seconds.
    const archiveSettings = config.providers.archive;
    if (archiveSettings && options.withWorker !== false) {
      const releaser = await createReleaser({
        databaseUrl: runtimeUrl,
        kek: releaserKeys.kek,
        store: createLocalArchiveStore(archiveSettings.storage),
        storage,
        email: email.sender,
        origins: originsFromConfig(config),
        log: pino({ level: 'warn' }),
        sweepEveryMs: STACK_SWEEP_MS,
        pollingIntervalSeconds: 1,
      });
      closers.unshift(() => releaser.stop());
      const client = createJobClient(jobsBoss);
      let sweeping = false;
      const sweep = setInterval(() => {
        if (sweeping) return;
        sweeping = true;
        void (async () => {
          try {
            await enqueuePendingExports(runtime.db, client);
            await enqueueDueArchives(runtime.db, client, { afterDays: archiveSettings.afterDays });
          } catch {
            // The next tick tries again; a stack that is stopping closes the pool under this.
          } finally {
            sweeping = false;
          }
        })();
      }, STACK_SWEEP_MS);
      closers.unshift(() => {
        clearInterval(sweep);
        return Promise.resolve();
      });
    }

    const info: StackInfo = {
      apiUrl: `http://127.0.0.1:${String(options.apiPort)}`,
      mailpitUrl: `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`,
      storageUrl,
      baseDomain,
      platformHost,
      demoPassword: DEMO_PASSWORD,
      tenants: {
        aillu: { id: aillu.id, slug: 'aillu', name: 'Centro Médico Aillu', emailSuffix: '' },
        norte: { id: norte.id, slug: 'norte', name: 'Clínica Norte', emailSuffix: '+norte' },
      },
      operator: {
        email: OPERATOR.email,
        password: OPERATOR.password,
        totpSecret: operator.totpSecretBase32,
      },
      operatorTwo: {
        email: OPERATOR_TWO.email,
        password: OPERATOR_TWO.password,
        totpSecret: operatorTwo.totpSecretBase32,
      },
      platformDemo:
        options.platformDemo === false
          ? {}
          : Object.fromEntries(
              PLATFORM_DEMO_TENANTS.map((entry) => [
                entry.state,
                {
                  slug: entry.slug,
                  name: entry.displayName,
                  ownerEmail: entry.ownerEmail,
                  receptionEmail: entry.receptionEmail,
                  professionalEmail: entry.professionalEmail ?? null,
                },
              ]),
            ),
    };
    if (options.infoFile) {
      await mkdir(dirname(options.infoFile), { recursive: true });
      await writeFile(options.infoFile, JSON.stringify(info, null, 2));
    }
    log('Stack ready');

    return {
      info,
      async stop() {
        for (const close of closers) await close().catch(() => undefined);
      },
    };
  } catch (error) {
    for (const close of closers) await close().catch(() => undefined);
    throw error;
  }
}

/**
 * Creates the archive bucket with Object Lock (governance mode, a default retention) and the writer
 * identity, the way `infra/docker-compose.yml` does for the local environment.
 */
async function prepareArchiveBucket(minio: StartedTestContainer): Promise<void> {
  // The Docker daemon can drop the connection of an exec while the container is still settling (a
  // "socket hang up" that is thrown, not an exit code): it counts as a server that is not ready.
  const run = async (command: string[]): Promise<{ exitCode: number; output: string }> => {
    try {
      return await minio.exec(command);
    } catch (error) {
      return { exitCode: -1, output: `not ready: ${String(error)}` };
    }
  };
  // MinIO can restart under the first commands (the image does it once while it starts), so a command
  // that finds the server down is tried again.
  const mc = async (...args: string[]) => {
    for (let attempt = 1; ; attempt += 1) {
      const result = await run(['mc', ...args]);
      if (result.exitCode === 0) return;
      const down = /connection refused|EOF|reset by peer|not ready/i.test(result.output);
      if (!down || attempt >= 20) {
        throw new Error(`mc ${args.slice(0, 3).join(' ')} failed: ${result.output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  // The image restarts MinIO once while it starts: the alias is retried.
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
    const set = await run([
      'mc',
      'alias',
      'set',
      'local',
      'http://127.0.0.1:9000',
      MINIO_USER,
      MINIO_PASSWORD,
    ]);
    ready = set.exitCode === 0;
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('the MinIO of the stack did not accept the alias');
  await mc('mb', '--with-lock', `local/${ARCHIVE_BUCKET}`);
  await mc('retention', 'set', '--default', 'GOVERNANCE', '3650d', `local/${ARCHIVE_BUCKET}`);
  await minio.copyContentToContainer([
    { content: archiveWriterPolicy(ARCHIVE_BUCKET), target: '/tmp/archive-writer.json' },
  ]);
  await mc('admin', 'policy', 'create', 'local', 'archive-writer', '/tmp/archive-writer.json');
  await mc('admin', 'user', 'add', 'local', ARCHIVE_WRITER_USER, ARCHIVE_WRITER_SECRET);
  await mc('admin', 'policy', 'attach', 'local', 'archive-writer', '--user', ARCHIVE_WRITER_USER);
}
