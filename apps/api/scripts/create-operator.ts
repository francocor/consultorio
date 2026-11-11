import { parseArgs } from 'node:util';

import { loadConfig } from '../src/main/config.js';
import { createKeyManagement } from '../src/main/key-management.js';
import { createPasswordHasher } from '../src/modules/identity/index.js';
import { createOperatorAdminFor, createOperatorSecrets } from '../src/modules/operator/index.js';
import { createOperatorDb } from '../src/platform/db/pool.js';

/**
 * Creates a platform operator, the only way to get one (there is no endpoint). The password comes
 * from the environment so it never lands in a shell history or a process list:
 *
 *   OPERATOR_PASSWORD='a long passphrase' pnpm --filter @consultorio/api operator:create \
 *     --email you@example.com --name "Your Name"
 *
 * It prints the authenticator secret ONCE: add it to an authenticator app before closing the
 * terminal. The second factor is mandatory for operators; there is no grace period.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  const password = process.env['OPERATOR_PASSWORD'];
  if (!values.email || !values.name || !password) {
    process.stderr.write(
      'Usage: OPERATOR_PASSWORD=... operator:create --email <address> --name <display name>\n',
    );
    process.exit(2);
  }

  const config = loadConfig();
  if (!config.operatorDatabaseUrl) {
    process.stderr.write(
      'OPERATOR_DATABASE_URL is not set (and the operator console needs multi-tenant mode).\n',
    );
    process.exit(2);
  }

  const db = createOperatorDb(config.operatorDatabaseUrl);
  try {
    const admin = createOperatorAdminFor({
      db: db.db,
      hasher: createPasswordHasher(),
      secrets: createOperatorSecrets(createKeyManagement(config.kms)),
    });
    const created = await admin.create({
      email: values.email,
      displayName: values.name,
      password,
    });
    process.stdout.write(
      [
        `Operator created: ${values.email}`,
        '',
        'Add this to an authenticator app now. It is shown once and is not stored in clear:',
        `  secret: ${created.totpSecretBase32}`,
        `  link:   ${created.otpauthUri}`,
        '',
      ].join('\n'),
    );
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Failed to create the operator'}\n`,
  );
  process.exit(1);
});
