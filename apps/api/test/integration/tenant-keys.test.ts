import { randomBytes } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { tenantKey } from '../../src/db/schema/tenant-key.js';
import { DecryptionError } from '../../src/platform/crypto/aes-gcm.js';
import {
  KeyManagementError,
  type KeyContext,
  type KeyManagement,
} from '../../src/platform/crypto/key-management.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

const kek = randomBytes(32).toString('base64');
const REF = {
  table: 'clinical_note',
  column: 'draft_content_enc',
  rowId: '0190a000-0000-7000-8000-0000000000d1',
};

/** Local KMS that counts how often it is asked to unwrap or generate. */
function countingKms() {
  const inner = createLocalKeyManagement(kek);
  const calls = { generate: 0, unwrap: 0 };
  const kms: KeyManagement = {
    generateDataKey: (context: KeyContext) => {
      calls.generate += 1;
      return inner.generateDataKey(context);
    },
    unwrapDataKey: (wrapped, context) => {
      calls.unwrap += 1;
      return inner.unwrapDataKey(wrapped, context);
    },
  };
  return { kms, calls };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'keys-a' });
  b = await createTestTenant(runtime, { slug: 'keys-b' });
});

afterAll(async () => {
  await runtime.close();
});

async function keyRows(tenant: TestTenant) {
  return asTenant(runtime, tenant.id, (tx) =>
    tx.select().from(tenantKey).where(eq(tenantKey.tenantId, tenant.id)).orderBy(tenantKey.version),
  );
}

describe('creating the tenant data key', () => {
  it('stores one active, wrapped data key at version 1 and never the plaintext key', async () => {
    const { kms } = countingKms();
    const keys = createTenantKeys({ kms });

    const result = await asTenant(runtime, a.id, (tx) => keys.ensureTenantKey(tx));

    expect(result).toEqual({ version: 1, created: true });
    const rows = await keyRows(a);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: 1,
      status: 'active',
      kekId: 'local-v1',
      purpose: 'tenant-dek',
    });
    expect(rows[0]?.dekWrapped.length).toBeGreaterThan(32);
  });

  it('is idempotent: asking again changes nothing and generates no new key', async () => {
    const { kms, calls } = countingKms();
    const keys = createTenantKeys({ kms });
    const before = await keyRows(a);

    const result = await asTenant(runtime, a.id, (tx) => keys.ensureTenantKey(tx));

    expect(result).toEqual({ version: 1, created: false });
    expect(calls.generate).toBe(0);
    expect(await keyRows(a)).toEqual(before);
  });

  it('survives concurrent creation: one winner, one row', async () => {
    const racing = await createTestTenant(runtime, { slug: 'keys-race' });
    const { kms } = countingKms();
    const keys = createTenantKeys({ kms });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        asTenant(runtime, racing.id, (tx) => keys.ensureTenantKey(tx)),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await keyRows(racing)).toHaveLength(1);
  });
});

describe('field encryption with the tenant key', () => {
  it('round-trips a value, storing something other than the plaintext', async () => {
    const keys = createTenantKeys({ kms: countingKms().kms });

    const blob = await asTenant(runtime, a.id, (tx) =>
      keys.encryptField(tx, REF, 'Paciente refiere cefalea'),
    );
    const plain = await asTenant(runtime, a.id, (tx) => keys.decryptField(tx, REF, blob));

    expect(plain.toString('utf8')).toBe('Paciente refiere cefalea');
    expect(blob.includes(Buffer.from('cefalea'))).toBe(false);
  });

  it('creates the tenant key on first use when none exists yet', async () => {
    const fresh = await createTestTenant(runtime, { slug: 'keys-lazy' });
    const keys = createTenantKeys({ kms: countingKms().kms });

    const blob = await asTenant(runtime, fresh.id, (tx) => keys.encryptField(tx, REF, 'x'));

    expect(blob.length).toBeGreaterThan(0);
    expect(await keyRows(fresh)).toHaveLength(1);
  });

  it('keeps tenants apart: tenant A cannot decrypt what tenant B encrypted', async () => {
    const keys = createTenantKeys({ kms: countingKms().kms });
    const blobOfB = await asTenant(runtime, b.id, (tx) => keys.encryptField(tx, REF, 'b-secret'));

    // As tenant A, with A's key: the blob is bound to B's key and tenant.
    await expect(
      asTenant(runtime, a.id, (tx) => keys.decryptField(tx, REF, blobOfB)),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('keeps a ciphertext bound to its row: a copy in another row does not decrypt', async () => {
    const keys = createTenantKeys({ kms: countingKms().kms });
    const blob = await asTenant(runtime, a.id, (tx) => keys.encryptField(tx, REF, 'row-bound'));

    await expect(
      asTenant(runtime, a.id, (tx) =>
        keys.decryptField(tx, { ...REF, rowId: '0190a000-0000-7000-8000-0000000000d9' }, blob),
      ),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('will not decrypt when the database holds a key of another tenant for the same version', async () => {
    const keys = createTenantKeys({ kms: countingKms().kms });
    const blobOfA = await asTenant(runtime, a.id, (tx) => keys.encryptField(tx, REF, 'a-secret'));

    await expect(
      asTenant(runtime, b.id, (tx) => keys.decryptField(tx, REF, blobOfA)),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('fails with a generic key error when the wrapped key cannot be unwrapped', async () => {
    const broken = createTenantKeys({
      kms: {
        generateDataKey: () => Promise.reject(new KeyManagementError()),
        unwrapDataKey: () => Promise.reject(new KeyManagementError()),
      },
    });
    const keys = createTenantKeys({ kms: countingKms().kms });
    const blob = await asTenant(runtime, a.id, (tx) => keys.encryptField(tx, REF, 'x'));

    await expect(
      asTenant(runtime, a.id, (tx) => broken.decryptField(tx, REF, blob)),
    ).rejects.toBeInstanceOf(KeyManagementError);
  });
});

describe('unwrapped key cache', () => {
  it('unwraps once while the entry is fresh and again after the TTL', async () => {
    const { kms, calls } = countingKms();
    let now = 1_000_000;
    const keys = createTenantKeys({ kms, ttlMs: 60_000, now: () => now });

    const blob = await asTenant(runtime, a.id, (tx) => keys.encryptField(tx, REF, 'cached'));
    const unwrapsAfterFirstUse = calls.unwrap;
    await asTenant(runtime, a.id, (tx) => keys.decryptField(tx, REF, blob));
    await asTenant(runtime, a.id, (tx) => keys.decryptField(tx, REF, blob));
    const withinTtl = calls.unwrap;

    now += 59_000;
    await asTenant(runtime, a.id, (tx) => keys.decryptField(tx, REF, blob));
    const justBeforeExpiry = calls.unwrap;

    now += 2_000;
    await asTenant(runtime, a.id, (tx) => keys.decryptField(tx, REF, blob));
    const afterExpiry = calls.unwrap;

    expect(unwrapsAfterFirstUse).toBe(1);
    expect(withinTtl).toBe(1);
    expect(justBeforeExpiry).toBe(1);
    expect(afterExpiry).toBe(2);
  });

  it('keeps separate entries per tenant', async () => {
    const { kms, calls } = countingKms();
    const keys = createTenantKeys({ kms });

    await asTenant(runtime, a.id, (tx) => keys.encryptField(tx, REF, 'x'));
    await asTenant(runtime, b.id, (tx) => keys.encryptField(tx, REF, 'x'));
    await asTenant(runtime, a.id, (tx) => keys.encryptField(tx, REF, 'y'));

    expect(calls.unwrap).toBe(2);
  });

  it('evicts the oldest entry beyond its size limit', async () => {
    const { kms, calls } = countingKms();
    const keys = createTenantKeys({ kms, maxEntries: 1 });

    await asTenant(runtime, a.id, (tx) => keys.encryptField(tx, REF, 'x'));
    await asTenant(runtime, b.id, (tx) => keys.encryptField(tx, REF, 'x'));
    await asTenant(runtime, a.id, (tx) => keys.encryptField(tx, REF, 'x'));

    expect(calls.unwrap).toBe(3);
  });
});

describe('key rotation readiness', () => {
  it('encrypts new data with the new version and still decrypts old data with the old one', async () => {
    const rotating = await createTestTenant(runtime, { slug: 'keys-rotate' });
    const { kms } = countingKms();
    const keys = createTenantKeys({ kms });
    const oldBlob = await asTenant(runtime, rotating.id, (tx) =>
      keys.encryptField(tx, REF, 'written before rotation'),
    );

    const rotated = await asTenant(runtime, rotating.id, (tx) => keys.rotateTenantKey(tx));
    const newBlob = await asTenant(runtime, rotating.id, (tx) =>
      keys.encryptField(tx, REF, 'written after rotation'),
    );

    expect(rotated).toEqual({ version: 2 });
    const rows = await keyRows(rotating);
    expect(rows.map((row) => [row.version, row.status])).toEqual([
      [1, 'retired'],
      [2, 'active'],
    ]);
    expect(oldBlob.readUInt16BE(1)).toBe(1);
    expect(newBlob.readUInt16BE(1)).toBe(2);
    const readOld = await asTenant(runtime, rotating.id, (tx) =>
      keys.decryptField(tx, REF, oldBlob),
    );
    const readNew = await asTenant(runtime, rotating.id, (tx) =>
      keys.decryptField(tx, REF, newBlob),
    );
    expect(readOld.toString()).toBe('written before rotation');
    expect(readNew.toString()).toBe('written after rotation');
  });
});

describe('a key that was never committed is never used (security review, finding 6)', () => {
  const ROLLED_BACK = new Error('rolled back on purpose');

  /** Runs the callback in a transaction that is rolled back by throwing at the end. */
  async function rolledBack(tenant: TestTenant, fn: (tx: Tx) => Promise<unknown>): Promise<void> {
    await expect(
      asTenant(runtime, tenant.id, async (tx) => {
        await fn(tx);
        throw ROLLED_BACK;
      }),
    ).rejects.toBe(ROLLED_BACK);
  }

  it('does not remember a first key whose transaction rolled back: data written afterwards stays readable', async () => {
    const fresh = await createTestTenant(runtime, { slug: 'keys-rollback-create' });
    const { kms } = countingKms();
    const keys = createTenantKeys({ kms });

    await rolledBack(fresh, (tx) => keys.ensureTenantKey(tx));
    expect(await keyRows(fresh)).toHaveLength(0);
    const blob = await asTenant(runtime, fresh.id, (tx) => keys.encryptField(tx, REF, 'kept'));

    // A process that starts cold knows only what the database holds.
    const cold = createTenantKeys({ kms });
    const read = await asTenant(runtime, fresh.id, (tx) => cold.decryptField(tx, REF, blob));
    expect(read.toString()).toBe('kept');
    expect(await keyRows(fresh)).toHaveLength(1);
  });

  it('does not remember a rotation that rolled back: new data keeps using the committed version', async () => {
    const rotating = await createTestTenant(runtime, { slug: 'keys-rollback-rotate' });
    const { kms } = countingKms();
    const keys = createTenantKeys({ kms });
    await asTenant(runtime, rotating.id, (tx) => keys.ensureTenantKey(tx));

    await rolledBack(rotating, (tx) => keys.rotateTenantKey(tx));
    const blob = await asTenant(runtime, rotating.id, (tx) =>
      keys.encryptField(tx, REF, 'still on version one'),
    );

    expect(blob.readUInt16BE(1)).toBe(1);
    const cold = createTenantKeys({ kms });
    const read = await asTenant(runtime, rotating.id, (tx) => cold.decryptField(tx, REF, blob));
    expect(read.toString()).toBe('still on version one');
    expect((await keyRows(rotating)).map((row) => [row.version, row.status])).toEqual([
      [1, 'active'],
    ]);
  });

  it('still uses a key it created itself inside the same transaction', async () => {
    const same = await createTestTenant(runtime, { slug: 'keys-same-tx' });
    const { kms } = countingKms();
    const keys = createTenantKeys({ kms });

    const blob = await asTenant(runtime, same.id, async (tx) => {
      await keys.ensureTenantKey(tx);
      return keys.encryptField(tx, REF, 'in one transaction');
    });

    const cold = createTenantKeys({ kms });
    const read = await asTenant(runtime, same.id, (tx) => cold.decryptField(tx, REF, blob));
    expect(read.toString()).toBe('in one transaction');
  });

  it('uses the new key right after a committed rotation, in the same process', async () => {
    const committed = await createTestTenant(runtime, { slug: 'keys-commit-rotate' });
    const { kms } = countingKms();
    const keys = createTenantKeys({ kms });
    await asTenant(runtime, committed.id, (tx) => keys.ensureTenantKey(tx));

    await asTenant(runtime, committed.id, (tx) => keys.rotateTenantKey(tx));
    const blob = await asTenant(runtime, committed.id, (tx) => keys.encryptField(tx, REF, 'v2'));

    expect(blob.readUInt16BE(1)).toBe(2);
  });
});

describe('tenant_key table', () => {
  it('allows only one active key per tenant', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(tenantKey).values({
          tenantId: a.id,
          version: 99,
          kekId: 'local-v1',
          dekWrapped: Buffer.from('x'),
          status: 'active',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('never lets the runtime role delete a key (that would destroy the data it protects)', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.delete(tenantKey).where(and(eq(tenantKey.tenantId, a.id))),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
