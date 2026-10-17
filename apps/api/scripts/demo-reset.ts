import { parseArgs } from 'node:util';

import { createFakeScanner } from '../src/adapters/fake-scanner/index.js';
import { createS3ObjectStorage } from '../src/adapters/s3/index.js';
import {
  DEMO_ACCOUNTS,
  DemoSeedError,
  consentTextFor,
  resetDemoTenant,
} from '../src/db/seed/demo/index.js';
import { loadConfig } from '../src/main/config.js';
import { createKeyManagement } from '../src/main/key-management.js';
import { createPasswordHasher } from '../src/modules/identity/index.js';
import { createTenantLookup } from '../src/modules/tenancy/index.js';
import { createTenantKeys } from '../src/platform/crypto/tenant-keys.js';
import { createOperatorDb, createRuntimeDb } from '../src/platform/db/pool.js';
import { createWithTenant } from '../src/platform/db/tenant-context.js';

/**
 * Puts a demo organization back to its starting content: everything it holds (the audit trail
 * included) is removed and the demo data is generated again.
 *
 *   pnpm demo:reset                    # organization "aillu", documented password
 *   pnpm demo:reset --slug norte
 *   pnpm demo:reset --rotate           # new random passwords, printed once
 *
 * Needs OPERATOR_DATABASE_URL (the operator role is the only one allowed to clear a demo).
 * It refuses organizations that are not demo ones.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { slug: { type: 'string', default: 'aillu' }, rotate: { type: 'boolean' } },
  });
  const config = loadConfig();
  if (!config.operatorDatabaseUrl) {
    throw new DemoSeedError('OPERATOR_DATABASE_URL is required (see .env.example).');
  }
  const runtime = createRuntimeDb(config.databaseUrl);
  const operator = createOperatorDb(config.operatorDatabaseUrl);
  const storage = config.storage ? createS3ObjectStorage(config.storage) : undefined;
  try {
    const found = await createTenantLookup(runtime.db)(values.slug);
    if (!found) throw new DemoSeedError(`There is no organization "${values.slug}".`);

    const result = await resetDemoTenant(
      {
        operatorDb: operator.db,
        withTenant: createWithTenant(runtime.db),
        hasher: createPasswordHasher(),
        keys: createTenantKeys({ kms: createKeyManagement(config.kms) }),
        consentText: consentTextFor(runtime.db),
        clock: () => new Date(),
        environment: config.nodeEnv,
        rotateCredentials: values.rotate === true,
        ...(storage ? { documents: { storage, scanner: createFakeScanner() } } : {}),
      },
      found.id,
      { operatorId: null },
    );

    process.stdout.write(
      [
        `Demo organization "${values.slug}" reset: ${String(result.deletedRows)} rows removed and the demo data generated again.`,
        result.chain.lastHash
          ? `The removed audit chain ended at #${String(result.chain.lastSeq)} (${result.chain.lastHash}); it is recorded in the platform trail.`
          : 'The removed audit trail was empty.',
        '',
        ...result.credentials.map(
          (credential) =>
            `  ${credential.email.padEnd(36)} ${credential.password}  ${
              DEMO_ACCOUNTS.find((account) => account.key === credential.key)?.label ?? ''
            }`,
        ),
        '',
      ].join('\n'),
    );
  } finally {
    storage?.close();
    await Promise.all([runtime.close(), operator.close()]);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'The demo reset failed.'}\n`);
  process.exit(1);
});
