import { parseArgs } from 'node:util';

import { createFakeScanner } from '../src/adapters/fake-scanner/index.js';
import { createS3ObjectStorage } from '../src/adapters/s3/index.js';
import {
  DEMO_ACCOUNTS,
  DEMO_PASSWORD,
  DemoSeedError,
  consentTextFor,
  ensureDemoTenant,
  seedDemoTenant,
  useServerAddressPepper,
} from '../src/db/seed/demo/index.js';
import { seedPlatformCatalogs } from '../src/db/seed/platform.js';
import { loadConfig } from '../src/main/config.js';
import { createKeyManagement } from '../src/main/key-management.js';
import { createPasswordHasher } from '../src/modules/identity/index.js';
import { createTenantKeys } from '../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb } from '../src/platform/db/pool.js';
import { createWithTenant } from '../src/platform/db/tenant-context.js';

/**
 * Seeds the local demo organization ("Centro Médico Aillu"): staff of every role, locations,
 * professionals of different disciplines and patients with coverage, with the public development
 * password documented in docs/demo.md.
 *
 *   pnpm demo:seed                       # organization "aillu"
 *   pnpm demo:seed --slug clinica-demo   # another slug
 *
 * Development only: it refuses to run when NODE_ENV=production. Run `pnpm db:migrate` first.
 * It is safe to run twice: an organization that already has data is left alone.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { slug: { type: 'string', default: 'aillu' } } });
  const slug = values.slug;

  const config = loadConfig();
  // The message log of the demo is hashed with the pepper the server runs with.
  useServerAddressPepper(config);
  if (config.nodeEnv === 'production') {
    throw new DemoSeedError('The demo seed never runs in production.');
  }
  if (config.deploymentMode !== 'multi' || !config.baseDomain) {
    throw new DemoSeedError('The demo seed needs DEPLOYMENT_MODE=multi and BASE_DOMAIN.');
  }
  const ownerUrl = process.env['MIGRATION_DATABASE_URL'];
  if (!ownerUrl) throw new DemoSeedError('MIGRATION_DATABASE_URL is required (see .env.example).');

  const owner = createOwnerDb(ownerUrl);
  const runtime = createRuntimeDb(config.databaseUrl);
  // With a bucket configured (S3_BUCKET) the demo gets its files too, scanned by the fake scanner.
  const storage = config.storage ? createS3ObjectStorage(config.storage) : undefined;
  try {
    // The payers of the demo coverage live in the platform catalog.
    await seedPlatformCatalogs(owner.db);

    const withTenant = createWithTenant(runtime.db);
    const tenant = await ensureDemoTenant(runtime.db, withTenant, slug);
    const result = await seedDemoTenant(
      {
        withTenant,
        hasher: createPasswordHasher(),
        keys: createTenantKeys({ kms: createKeyManagement(config.kms) }),
        consentText: consentTextFor(runtime.db),
        clock: () => new Date(),
        environment: config.nodeEnv,
        ...(storage ? { documents: { storage, scanner: createFakeScanner() } } : {}),
      },
      tenant.id,
    ).catch((error: unknown) => {
      if (error instanceof DemoSeedError && /already has data/.test(error.message)) return null;
      throw error;
    });

    process.stdout.write(
      result === null
        ? `The demo organization "${slug}" already has data. Nothing was changed.\n`
        : `Demo organization "${slug}" ${tenant.created ? 'created and ' : ''}seeded.\n`,
    );
    const port = process.env['WEB_PORT'] ?? '5173';
    process.stdout.write(
      [
        '',
        `Open  http://${slug}.${config.baseDomain}:${port}   (the web app: pnpm dev)`,
        `Password for every account (public, development only): ${DEMO_PASSWORD}`,
        '',
        ...DEMO_ACCOUNTS.map((account) => `  ${account.email.padEnd(36)} ${account.label}`),
        '',
        'Full list and notes: docs/demo.md',
        '',
      ].join('\n'),
    );
  } finally {
    storage?.close();
    await Promise.all([owner.close(), runtime.close()]);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'The demo seed failed.'}\n`);
  process.exit(1);
});
