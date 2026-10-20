import { randomBytes } from 'node:crypto';

import { DEMO_PASSWORD, DemoSeedError } from '../src/db/seed/demo/index.js';
import { platformDemoRefusal } from '../src/db/seed/demo/stage6/guard.js';
import { PLATFORM_DEMO_TENANTS, seedPlatformDemo } from '../src/db/seed/demo/stage6/index.js';
import { seedPlatformCatalogs } from '../src/db/seed/platform.js';
import { loadConfig } from '../src/main/config.js';
import { originsFromConfig } from '../src/main/wiring/origins.js';
import { createPasswordHasher } from '../src/modules/identity/index.js';
import { createOwnerDb, createRuntimeDb } from '../src/platform/db/pool.js';
import { createWithTenant } from '../src/platform/db/tenant-context.js';

/**
 * Seeds the four fictional organizations of the platform demo: a trial, an active subscription, a
 * charge that failed and a read-only organization, built by the real services of the subscription
 * against the local Mercado Pago (no account, no network). They exist for the operator's views of the
 * subscriptions; the demo organization itself is exempt and has no subscription.
 *
 *   pnpm demo:platform
 *
 * Development only: it refuses to run when NODE_ENV=production (the organizations use the public
 * password of the demo). It is safe to run twice: an organization that exists is left as it is.
 * Run `pnpm db:migrate` first.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const refusal = platformDemoRefusal(config);
  if (refusal !== null) throw new DemoSeedError(refusal);
  const ownerUrl = process.env['MIGRATION_DATABASE_URL'];
  if (!ownerUrl) throw new DemoSeedError('MIGRATION_DATABASE_URL is required (see .env.example).');

  const owner = createOwnerDb(ownerUrl);
  const runtime = createRuntimeDb(config.databaseUrl);
  try {
    // The plans of the platform: a trial starts on one of them.
    await seedPlatformCatalogs(owner.db);

    const results = await seedPlatformDemo({
      db: runtime.db,
      withTenant: createWithTenant(runtime.db),
      hasher: createPasswordHasher(),
      origins: originsFromConfig(config),
      // No notice is posted while the seed walks; the secret only has to exist.
      webhookSecret: config.providers.mpWebhookSecret ?? randomBytes(24).toString('hex'),
      publicBaseUrl:
        config.providers.mpPublicBaseUrl ?? `http://platform.${config.baseDomain ?? 'localhost'}`,
      environment: config.nodeEnv,
    });

    const port = process.env['WEB_PORT'] ?? '5173';
    process.stdout.write(
      [
        ...results.map(
          (result) =>
            `${result.created ? 'Created' : 'Already there'}: ${result.slug} (${result.state})`,
        ),
        '',
        `Open  http://<slug>.${config.baseDomain ?? 'localhost'}:${port}   as the owner:`,
        ...PLATFORM_DEMO_TENANTS.map((entry) => `  ${entry.ownerEmail.padEnd(40)} ${entry.slug}`),
        `Password for every account (public, development only): ${DEMO_PASSWORD}`,
        '',
        'They show in the operator console, tab "Suscripciones". Full notes: docs/demo.md',
        '',
      ].join('\n'),
    );
  } finally {
    await Promise.all([owner.close(), runtime.close()]);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'The platform demo seed failed.'}\n`,
  );
  process.exit(1);
});
