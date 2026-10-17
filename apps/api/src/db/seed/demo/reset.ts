import { randomInt } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { createOperatorRun } from '../../../modules/operator/application/context.js';
import type { DemoResetPort } from '../../../modules/operator/application/tenants.js';
import { writePlatformAudit } from '../../../platform/audit/platform-audit.js';
import type { Db } from '../../../platform/db/pool.js';
import { SYSTEM_USER_ID } from '../../../platform/db/tenant-context.js';
import { document } from '../../schema/documents.js';

import type { DemoStaff } from './dataset.js';
import { DemoSeedError, seedDemoTenant, type DemoSeedDeps, type SeededCredential } from './seed.js';

/** How one demo organization differs from the standard one, and must stay different after a reset. */
export interface DemoVariant {
  emailFor?: (account: DemoStaff) => string;
  /** Runs after the content is back (for example a second look for a second organization). */
  afterSeed?: () => Promise<void>;
}

export interface DemoResetDeps extends Omit<DemoSeedDeps, 'passwordFor'> {
  /** The connection of the operator console's role: the only one that may run `app.demo_reset`. */
  operatorDb: Db;
  /**
   * Fresh random passwords on every reset (a deployed demo, where the documented password would
   * be public). Off by default: a local demo keeps the password documented in docs/demo.md.
   */
  rotateCredentials?: boolean;
  /** The variant of an organization, if it has one. */
  variantOf?: (tenantId: string) => DemoVariant | undefined;
}

export interface DemoResetResult {
  /** Where the removed audit chain ended: the platform trail keeps it as the proof of the cut. */
  chain: { lastSeq: number | null; lastHash: string | null };
  deletedRows: number;
  credentials: SeededCredential[];
}

// Letters and digits without the look-alikes (no 0/o, 1/l/i), written in parts so a scanner does
// not mistake the alphabet for a key.
const PASSWORD_ALPHABET = ['abcdefghjk', 'mnpqrstuvw', 'xyz', '23456789'].join('');

/** A password nobody can guess and everybody can type: three groups of six, 25 characters. */
export function generateDemoPassword(): string {
  const group = () =>
    Array.from({ length: 6 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join(
      '',
    );
  return `${group()}-${group()}-${group()}-${group()}`;
}

interface PrivilegedOutcome {
  lastSeq: string | number | null;
  lastHash: string | null;
  deleted: Record<string, number>;
}

/**
 * Puts a demo organization back to its starting content: the privileged function removes
 * everything it holds (the audit trail included), the seed fills it again, and the platform trail
 * records where the removed chain ended. Refuses anything that is not a demo organization, and any
 * production environment, before it deletes a row.
 */
export async function resetDemoTenant(
  deps: DemoResetDeps,
  tenantId: string,
  actor: { operatorId: string | null },
): Promise<DemoResetResult> {
  if (deps.environment === 'production' && deps.rotateCredentials !== true) {
    throw new DemoSeedError(
      'The demo reset never runs in production with the public password: rotate the credentials.',
    );
  }
  const run = createOperatorRun(deps.operatorDb);

  // The files of the demo are listed BEFORE their rows go; they leave the bucket after the reset has
  // succeeded, so a refused or failed reset never costs a download.
  const files = deps.documents
    ? await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
        tx.select({ key: document.objectKey }).from(document),
      )
    : [];

  const outcome = await run({ tenantId, operatorId: actor.operatorId }, async (tx) => {
    const result = await tx.execute<{ outcome: PrivilegedOutcome }>(
      sql`SELECT app.demo_reset(${tenantId}::uuid) AS outcome`,
    );
    const row = result.rows[0]?.outcome;
    if (!row) throw new DemoSeedError('The reset returned nothing.');
    return row;
  });
  const chain = {
    lastSeq: outcome.lastSeq === null ? null : Number(outcome.lastSeq),
    lastHash: outcome.lastHash,
  };
  const storage = deps.documents?.storage;
  if (storage) {
    for (const file of files) await storage.remove(tenantId, file.key).catch(() => undefined);
  }
  const deletedRows = Object.values(outcome.deleted).reduce((sum, count) => sum + count, 0);

  const rotate = deps.rotateCredentials === true;
  const variant = deps.variantOf?.(tenantId);
  const seedDeps: DemoSeedDeps = {
    withTenant: deps.withTenant,
    hasher: deps.hasher,
    keys: deps.keys,
    consentText: deps.consentText,
    clock: deps.clock,
    environment: deps.environment,
    ...(deps.emailFor ? { emailFor: deps.emailFor } : {}),
    ...(deps.documents ? { documents: deps.documents } : {}),
  };
  const seeded = await seedDemoTenant(
    {
      ...seedDeps,
      ...(variant?.emailFor ? { emailFor: variant.emailFor } : {}),
      ...(rotate
        ? {
            passwordFor: () => generateDemoPassword(),
          }
        : {}),
    },
    tenantId,
  );

  await variant?.afterSeed?.();

  await run({ tenantId, operatorId: actor.operatorId }, (tx) =>
    writePlatformAudit(tx, {
      action: 'demo.chain_reset',
      outcome: 'allow',
      actor: { operatorId: actor.operatorId, ip: null, userAgent: 'demo-reset', requestId: null },
      targetTenantId: tenantId,
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: {
        lastHash: chain.lastHash,
        lastSeq: chain.lastSeq,
        deletedRows,
        credentialsRotated: rotate,
      },
    }),
  );

  return { chain, deletedRows, credentials: seeded.credentials };
}

/**
 * The seam the operator console calls (`operator.demoReset`). The credentials of a rotated reset
 * are not returned to the browser: a deployed demo hands them over by the channel the deployment
 * chooses, and the command `pnpm demo:reset` prints them for a local one.
 */
export function createDemoResetPort(deps: DemoResetDeps): DemoResetPort {
  return {
    async reset({ tenantId, operatorId }) {
      await resetDemoTenant(deps, tenantId, { operatorId });
    },
  };
}
