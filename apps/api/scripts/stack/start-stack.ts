import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { GenericContainer, Wait } from 'testcontainers';

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
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createAdapterResolver } from '../../src/main/adapter-resolver.js';
import { buildAdapterRegistry } from '../../src/main/adapters.js';
import { createApplication } from '../../src/main/application.js';
import { loadConfig } from '../../src/main/config.js';
import { documentWorker } from '../../src/main/document-jobs.js';
import { createConfiguredEmail } from '../../src/main/email.js';
import { loadPasswordValidator } from '../../src/main/password-validator.js';
import { MODULE_WIRINGS, combineWorkerContributions } from '../../src/main/wiring/index.js';
import { createPasswordHasher } from '../../src/modules/identity/index.js';
import { createVideoJoinRegistry } from '../../src/modules/notifications/index.js';
import { createOperatorAdminFor, createOperatorSecrets } from '../../src/modules/operator/index.js';
import { holdExpireJob } from '../../src/modules/scheduling/index.js';
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

/** The operator of the throwaway stack. Public development values, like the demo passwords. */
const OPERATOR = {
  email: 'operador@demo.invalid',
  displayName: 'Operadora de la plataforma',
  password: 'Operador-Demo-2026-clave',
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

    // Two demo organizations with different looks.
    log('Seeding demo organizations');
    const deps = {
      withTenant,
      hasher,
      keys,
      consentText: consentTextFor(runtime.db),
      clock: () => new Date(),
      documents: { storage, scanner },
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

    // One professional of each demo organization has a matricula the platform operator verified, like
    // an organization that went through the operator's queue: the cardiologist. Only e-prescription
    // reads the verification, so the journey of a prescription has someone who may prescribe while
    // the other professionals stay unverified (and are refused). Done as the operator, the only role
    // the database lets verify.
    for (const tenantId of [aillu.id, norte.id]) {
      await createWithTenant(operatorDb.db)({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
        tx.execute(
          sql`UPDATE professional
                 SET matricula_status = 'verified', verified_by_operator = ${operator.id}, verified_at = now()
               WHERE matricula = '41258' AND matricula_jurisdiction = 'AR-C'`,
        ),
      );
    }

    const jobsBoss = createBoss(runtimeUrl, 'api');
    await jobsBoss.start();
    closers.unshift(() => jobsBoss.stop({ graceful: false }));

    const passwordValidator = await loadPasswordValidator({ breachCheck: false });
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
    });
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
            (module) => module.worker?.({ config, adapters, email: email.sender, videoJoin }) ?? {},
          ),
        ]),
      });
      closers.unshift(() => worker?.stop() ?? Promise.resolve());
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
