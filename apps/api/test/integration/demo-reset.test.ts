import { randomBytes } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { membership } from '../../src/db/schema/identity.js';
import { platformAuditEvent } from '../../src/db/schema/operator.js';
import { patient } from '../../src/db/schema/patients.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../src/db/seed/demo/credentials.js';
import { buildDemoDataset } from '../../src/db/seed/demo/dataset.js';
import { resetDemoTenant } from '../../src/db/seed/demo/reset.js';
import { seedDemoTenant, type DemoSeedDeps } from '../../src/db/seed/demo/seed.js';
import { snapshotDemoTenant } from '../../src/db/seed/demo/snapshot.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { sealTenant } from '../../src/platform/audit/sealer.js';
import { verifyTenantChain } from '../../src/platform/audit/verify.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createOperatorHarness, type OperatorHarness } from '../support/operator.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let operator: OperatorHarness;
let deps: DemoSeedDeps;
const clock = () => new Date('2026-03-02T12:00:00Z');
const SYSTEM = '00000000-0000-0000-0000-000000000000';

async function demoTenant(slug: string) {
  return (await createTestTenant(runtime, { slug, isDemo: true, billingExempt: true })).id;
}

/** What a rejection says, including the database's own message that the driver wrapper hides. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message ?? '';
    return `${error instanceof Error ? error.message : String(error)} ${cause}`;
  }
  return 'did not fail';
}

/** Calls the privileged function the way the operator console does: as the operator role. */
async function callReset(tenantId: string) {
  const result = await operator.db.db.execute<{ outcome: unknown }>(
    sql`SELECT app.demo_reset(${tenantId}::uuid) AS outcome`,
  );
  return result.rows[0]?.outcome as {
    lastSeq: number | null;
    lastHash: string | null;
    deleted: Record<string, number>;
  };
}

beforeAll(async () => {
  const owner = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(owner.db);
  await owner.close();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operator = createOperatorHarness();
  deps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock,
  };
}, 120_000);

afterAll(async () => {
  await operator.close();
  await runtime.close();
});

describe('app.demo_reset', () => {
  it('refuses an organization that is not a demo one, and leaves its data alone', async () => {
    const real = await createTestTenant(runtime, { slug: 'reset-real' });
    await asTenant(runtime, real.id, (tx) =>
      tx.insert(patient).values({
        tenantId: real.id,
        familyName: 'Real',
        givenNames: 'Person',
        birthDate: '1990-01-01',
      }),
    );

    await expect(failureOf(callReset(real.id))).resolves.toMatch(/not a demo/i);

    const rows = await asTenant(runtime, real.id, (tx) => tx.select().from(patient));
    expect(rows).toHaveLength(1);
  });

  it('refuses an organization that does not exist', async () => {
    await expect(failureOf(callReset('0190a000-0000-7000-8000-00000000dead'))).resolves.toMatch(
      /not found/i,
    );
  });

  it('cannot be called by the tenant role (the API and the worker)', async () => {
    const id = await demoTenant('reset-tenant-role');

    await expect(
      failureOf(runtime.db.execute(sql`SELECT app.demo_reset(${id}::uuid)`)),
    ).resolves.toMatch(/permission denied/i);
  });

  it('removes everything the organization holds, the audit trail included, and says how much', async () => {
    const id = await demoTenant('reset-everything');
    const data = buildDemoDataset();
    await seedDemoTenant(deps, id);

    const outcome = await callReset(id);

    expect(outcome.deleted['patient']).toBe(data.patients.length);
    expect(outcome.deleted['membership']).toBe(data.staff.length);
    expect(outcome.deleted['anamnesis']).toBe(data.care.filter((entry) => entry.anamnesis).length);
    expect(outcome.deleted['care_assignment']).toBe(data.care.length);
    expect(outcome.deleted['audit_event']).toBeGreaterThan(30);
    const left = await deps.withTenant({ tenantId: id, userId: SYSTEM }, async (tx) => ({
      patients: await tx.select().from(patient),
      members: await tx.select().from(membership),
      events: await tx.select().from(auditEvent),
    }));
    expect(left).toEqual({ patients: [], members: [], events: [] });
  }, 120_000);

  it('keeps the organization, its key and its feature flags, so it can be filled again', async () => {
    const id = await demoTenant('reset-keeps');
    await seedDemoTenant(deps, id);

    await callReset(id);

    const [row] = await deps.withTenant({ tenantId: id, userId: SYSTEM }, (tx) =>
      tx.select({ isDemo: tenant.isDemo }).from(tenant).where(eq(tenant.id, id)),
    );
    expect(row?.isDemo).toBe(true);
    await expect(seedDemoTenant(deps, id)).resolves.toBeDefined();
  }, 180_000);

  it('returns the last sealed hash of the trail it removed', async () => {
    const id = await demoTenant('reset-last-hash');
    await seedDemoTenant(deps, id);
    await asTenant(runtime, id, (tx) => sealTenant(tx, { graceMs: 0 }));

    const outcome = await callReset(id);

    expect(outcome.lastSeq).toBeGreaterThan(30);
    expect(outcome.lastHash).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it('does not touch the trail or the data of any other organization, and their chains still verify', async () => {
    const wiped = await demoTenant('reset-wiped');
    const other = await demoTenant('reset-other');
    await seedDemoTenant(deps, wiped);
    await seedDemoTenant(deps, other);
    await asTenant(runtime, other, (tx) => sealTenant(tx, { graceMs: 0 }));
    await asTenant(runtime, wiped, (tx) => sealTenant(tx, { graceMs: 0 }));
    const before = await snapshotDemoTenant(deps.withTenant, other);

    await callReset(wiped);

    expect(await snapshotDemoTenant(deps.withTenant, other)).toEqual(before);
    const chain = await asTenant(runtime, other, (tx) => verifyTenantChain(tx));
    expect(chain.ok).toBe(true);
  }, 240_000);

  it('a reseeded organization has a fresh trail that verifies from the start', async () => {
    const id = await demoTenant('reset-reseeded');
    await seedDemoTenant(deps, id);
    await asTenant(runtime, id, (tx) => sealTenant(tx, { graceMs: 0 }));
    await callReset(id);

    await seedDemoTenant(deps, id);
    await asTenant(runtime, id, (tx) => sealTenant(tx, { graceMs: 0 }));

    const chain = await asTenant(runtime, id, (tx) => verifyTenantChain(tx));
    expect(chain.ok).toBe(true);
  }, 240_000);

  it('the audit trail is still append-only for everyone else: nobody can delete an event by hand', async () => {
    const id = await demoTenant('reset-append-only');
    await seedDemoTenant(deps, id);

    await expect(
      asTenant(runtime, id, (tx) => tx.delete(auditEvent).where(eq(auditEvent.tenantId, id))),
    ).rejects.toThrow();
    // Not even by naming the reset flag: only the function, running as the owner, may delete.
    await expect(
      asTenant(runtime, id, async (tx) => {
        await tx.execute(sql`SELECT set_config('app.demo_reset', ${id}, true)`);
        await tx.delete(auditEvent).where(eq(auditEvent.tenantId, id));
      }),
    ).rejects.toThrow();
  }, 120_000);
});

describe('resetDemoTenant', () => {
  const port = () => ({ ...deps, operatorDb: operator.db.db });

  it('puts the organization back to the same logical content as a first seed', async () => {
    const id = await demoTenant('reset-same-content');
    await seedDemoTenant(deps, id);
    const first = await snapshotDemoTenant(deps.withTenant, id);

    await resetDemoTenant(port(), id, { operatorId: null });

    expect(await snapshotDemoTenant(deps.withTenant, id)).toEqual(first);
  }, 240_000);

  it('records the discontinuity of the trail in the platform trail, with the last hash', async () => {
    const id = await demoTenant('reset-platform-audit');
    await seedDemoTenant(deps, id);
    await asTenant(runtime, id, (tx) => sealTenant(tx, { graceMs: 0 }));

    const result = await resetDemoTenant(port(), id, { operatorId: null });

    const events = await operator.db.db
      .select()
      .from(platformAuditEvent)
      .where(eq(platformAuditEvent.targetTenantId, id));
    const entry = events.find((event) => event.action === 'demo.chain_reset');
    expect(entry).toBeDefined();
    expect(entry?.metadata).toMatchObject({ lastHash: result.chain.lastHash });
    expect(result.chain.lastHash).toMatch(/^[0-9a-f]{64}$/);
  }, 240_000);

  it('keeps the documented password when it is not asked to rotate', async () => {
    const id = await demoTenant('reset-documented');
    await seedDemoTenant(deps, id);

    const result = await resetDemoTenant(port(), id, { operatorId: null });

    expect(result.credentials.map((credential) => credential.password)).toEqual(
      DEMO_ACCOUNTS.map(() => DEMO_PASSWORD),
    );
  }, 240_000);

  it('rotates every password when asked: new, different and never the documented one', async () => {
    const id = await demoTenant('reset-rotated');
    await seedDemoTenant(deps, id);

    const first = await resetDemoTenant({ ...port(), rotateCredentials: true }, id, {
      operatorId: null,
    });
    const second = await resetDemoTenant({ ...port(), rotateCredentials: true }, id, {
      operatorId: null,
    });

    const passwords = [...first.credentials, ...second.credentials].map(
      (credential) => credential.password,
    );
    expect(new Set(passwords).size).toBe(passwords.length);
    for (const password of passwords) {
      expect(password).not.toBe(DEMO_PASSWORD);
      expect(password.length).toBeGreaterThanOrEqual(20);
    }
  }, 300_000);

  it('keeps what makes an organization different through a reset: its addresses and what runs after', async () => {
    const id = await demoTenant('reset-variant');
    const suffix = (account: { email: string }) => account.email.replace('@', '+variant@');
    await seedDemoTenant({ ...deps, emailFor: suffix }, id);
    let afterSeed = 0;

    const result = await resetDemoTenant(
      {
        ...port(),
        variantOf: () => ({
          emailFor: suffix,
          afterSeed: () => {
            afterSeed += 1;
            return Promise.resolve();
          },
        }),
      },
      id,
      { operatorId: null },
    );

    expect(afterSeed).toBe(1);
    expect(result.credentials.every((credential) => credential.email.includes('+variant@'))).toBe(
      true,
    );
  }, 240_000);

  it('refuses a real organization before touching anything', async () => {
    const real = await createTestTenant(runtime, { slug: 'reset-service-real' });

    await expect(
      failureOf(resetDemoTenant(port(), real.id, { operatorId: null })),
    ).resolves.toMatch(/not a demo/i);
  });

  it('never runs in production, because the seed would use public passwords', async () => {
    const id = await demoTenant('reset-service-production');

    await expect(
      resetDemoTenant({ ...port(), environment: 'production' }, id, { operatorId: null }),
    ).rejects.toThrow(/production/);
  });
});
