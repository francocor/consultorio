import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { fiscalCredential, fiscalProfile, pointOfSale } from '../../src/db/schema/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

/**
 * The fiscal configuration tables (migration 0440): the rules the database itself keeps, whatever
 * the application does.
 */

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'fiscal-schema-a' });
  b = await createTestTenant(runtime, { slug: 'fiscal-schema-b' });
});

afterAll(async () => {
  await runtime.close();
});

const dbError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

const profile = (tenantId: string, overrides: Partial<typeof fiscalProfile.$inferInsert> = {}) => ({
  tenantId,
  cuit: '20123456786',
  taxCondition: 'monotributo',
  businessName: 'Consultorio Aillu',
  address: 'Av. Siempre Viva 123, CABA',
  activityStartedOn: '2020-03-01',
  ...overrides,
});

const credential = (
  tenantId: string,
  overrides: Partial<typeof fiscalCredential.$inferInsert> = {},
) => ({
  tenantId,
  certificateEnc: Buffer.from('ciphertext-certificate'),
  privateKeyEnc: Buffer.from('ciphertext-key'),
  notBefore: new Date('2026-01-01T00:00:00Z'),
  notAfter: new Date('2027-01-01T00:00:00Z'),
  subjectCuit: '20123456786',
  fingerprint: 'a'.repeat(64),
  ...overrides,
});

describe('fiscal_profile', () => {
  it('stores the fiscal identity, one per organization', async () => {
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.insert(fiscalProfile).values(profile(a.id)).returning(),
    );

    expect(row).toMatchObject({
      cuit: '20123456786',
      taxCondition: 'monotributo',
      businessName: 'Consultorio Aillu',
      activityStartedOn: '2020-03-01',
    });
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) => tx.insert(fiscalProfile).values(profile(a.id))),
      ),
    ).toBe('23505');
    // Another organization has its own.
    expect(
      await dbError(
        asTenant(runtime, b.id, (tx) => tx.insert(fiscalProfile).values(profile(b.id))),
      ),
    ).toBeUndefined();
  });

  it('refuses a CUIT that is not 11 digits, and a tax condition outside the three', async () => {
    const c = await createTestTenant(runtime, { slug: 'fiscal-schema-c' });

    expect(
      await dbError(
        asTenant(runtime, c.id, (tx) =>
          tx.insert(fiscalProfile).values(profile(c.id, { cuit: '20-12345678-6' })),
        ),
      ),
    ).toBe('23514');
    expect(
      await dbError(
        asTenant(runtime, c.id, (tx) =>
          tx.insert(fiscalProfile).values(profile(c.id, { taxCondition: 'consumidor_final' })),
        ),
      ),
    ).toBe('23514');
    expect(
      await dbError(
        asTenant(runtime, c.id, (tx) =>
          tx.insert(fiscalProfile).values(profile(c.id, { businessName: '  ' })),
        ),
      ),
    ).toBe('23514');
  });

  it('cannot be deleted by the application role', async () => {
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.execute(sql`DELETE FROM fiscal_profile WHERE tenant_id = ${a.id}`),
        ),
      ),
    ).toBe('42501');
  });
});

describe('point_of_sale', () => {
  it('defaults to homologation and active, with a number unique per organization', async () => {
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.insert(pointOfSale).values({ tenantId: a.id, number: 1 }).returning(),
    );

    expect(row).toMatchObject({ number: 1, environment: 'homologation', active: true });
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) =>
          tx.insert(pointOfSale).values({ tenantId: a.id, number: 1 }),
        ),
      ),
    ).toBe('23505');
    expect(
      await dbError(
        asTenant(runtime, b.id, (tx) =>
          tx.insert(pointOfSale).values({ tenantId: b.id, number: 1 }),
        ),
      ),
    ).toBeUndefined();
  });

  it('keeps an environment of its own, so two points of sale can differ', async () => {
    const c = await createTestTenant(runtime, { slug: 'fiscal-schema-pos' });

    const rows = await asTenant(runtime, c.id, (tx) =>
      tx
        .insert(pointOfSale)
        .values([
          { tenantId: c.id, number: 1, environment: 'production' },
          { tenantId: c.id, number: 2, environment: 'homologation' },
        ])
        .returning(),
    );

    expect(rows.map((row) => [row.number, row.environment])).toEqual([
      [1, 'production'],
      [2, 'homologation'],
    ]);
  });

  it('refuses a number outside 1 to 99999 and an unknown environment', async () => {
    const c = await createTestTenant(runtime, { slug: 'fiscal-schema-pos-bad' });
    const insert = (values: Partial<typeof pointOfSale.$inferInsert>) =>
      dbError(
        asTenant(runtime, c.id, (tx) =>
          tx.insert(pointOfSale).values({ tenantId: c.id, number: 7, ...values }),
        ),
      );

    expect(await insert({ number: 0 })).toBe('23514');
    expect(await insert({ number: 100000 })).toBe('23514');
    expect(await insert({ environment: 'staging' })).toBe('23514');
    expect(await insert({ number: 99999 })).toBeUndefined();
  });
});

describe('fiscal_credential', () => {
  it('keeps one active credential per organization; a replaced one stays as history', async () => {
    const c = await createTestTenant(runtime, { slug: 'fiscal-schema-cred' });
    await asTenant(runtime, c.id, (tx) => tx.insert(fiscalCredential).values(credential(c.id)));

    expect(
      await dbError(
        asTenant(runtime, c.id, (tx) => tx.insert(fiscalCredential).values(credential(c.id))),
      ),
    ).toBe('23505');

    await asTenant(runtime, c.id, async (tx) => {
      await tx.execute(
        sql`UPDATE fiscal_credential SET active = false, replaced_at = now() WHERE tenant_id = ${c.id}`,
      );
      await tx.insert(fiscalCredential).values(credential(c.id, { fingerprint: 'b'.repeat(64) }));
    });
    const rows = await asTenant(runtime, c.id, (tx) => tx.select().from(fiscalCredential));
    expect(rows.map((row) => row.active).sort()).toEqual([false, true]);
  });

  it('ties "active" to "not replaced", and refuses a malformed CUIT, fingerprint or window', async () => {
    const c = await createTestTenant(runtime, { slug: 'fiscal-schema-cred-bad' });
    const insert = (values: Partial<typeof fiscalCredential.$inferInsert>) =>
      dbError(
        asTenant(runtime, c.id, (tx) =>
          tx.insert(fiscalCredential).values(credential(c.id, values)),
        ),
      );

    expect(await insert({ active: false })).toBe('23514');
    expect(await insert({ replacedAt: new Date() })).toBe('23514');
    expect(await insert({ subjectCuit: '123' })).toBe('23514');
    expect(await insert({ fingerprint: 'XYZ' })).toBe('23514');
    expect(
      await insert({
        notBefore: new Date('2027-01-01T00:00:00Z'),
        notAfter: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toBe('23514');
  });

  it('cannot be deleted or truncated by the application role', async () => {
    expect(
      await dbError(
        asTenant(runtime, a.id, (tx) => tx.execute(sql`DELETE FROM fiscal_credential`)),
      ),
    ).toBe('42501');
    expect(
      await dbError(asTenant(runtime, a.id, (tx) => tx.execute(sql`DELETE FROM point_of_sale`))),
    ).toBe('42501');
  });
});
