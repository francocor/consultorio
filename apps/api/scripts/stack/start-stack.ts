import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { GenericContainer, Wait } from 'testcontainers';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
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
import { createApplication } from '../../src/main/application.js';
import { createConfiguredEmail } from '../../src/main/email.js';
import { loadPasswordValidator } from '../../src/main/password-validator.js';
import { createPasswordHasher } from '../../src/modules/identity/index.js';
import { createOperatorAdminFor, createOperatorSecrets } from '../../src/modules/operator/index.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOperatorDb, createOwnerDb, createRuntimeDb } from '../../src/platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../../src/platform/db/tenant-context.js';
import { startWorker } from '../../src/platform/jobs/worker.js';

const DATABASE = 'consultorio_stack';
const ROLES_SQL = new URL('../../../../infra/postgres/init/01-roles.sql', import.meta.url);

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
  /** Run the worker (audit sealing, nightly verification) in the same process. */
  withWorker?: boolean;
  log?: (line: string) => void;
}

export interface StackInfo {
  apiUrl: string;
  mailpitUrl: string;
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

  log('Starting Postgres and Mailpit containers');
  const [postgres, mailpit] = await Promise.all([
    new PostgreSqlContainer('postgres:17').withDatabase(DATABASE).start(),
    new GenericContainer('axllent/mailpit:v1.31.6')
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/livez', 8025))
      .start(),
  ]);
  const closers: (() => Promise<unknown>)[] = [() => postgres.stop(), () => mailpit.stop()];

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

    const kms = createLocalKeyManagement(randomBytes(32).toString('base64'));
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

    const passwordValidator = await loadPasswordValidator({ breachCheck: false });
    const app = createApplication({
      database: runtime,
      logLevel: 'warn',
      health: { checkDatabase: () => Promise.resolve({ ok: true }) },
      deployment: { mode: 'multi', baseDomain, platformHost },
      trustProxy: false,
      cookieSecure: false,
      keys,
      email: email.sender,
      passwordValidator,
      storage: createMemoryObjectStorage(),
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
      worker = await startWorker({
        databaseUrl: runtimeUrl,
        log: pino({ level: 'warn' }),
        sealGraceMs: 500,
        sealIntervalMs: 1500,
      });
      closers.unshift(() => worker?.stop() ?? Promise.resolve());
    }

    const info: StackInfo = {
      apiUrl: `http://127.0.0.1:${String(options.apiPort)}`,
      mailpitUrl: `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}`,
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
