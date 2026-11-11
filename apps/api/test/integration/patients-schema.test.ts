import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { patient, patientRepresentative, patientVersion } from '../../src/db/schema/patients.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createTestPatient } from '../support/patients.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'patients-schema-a' });
  b = await createTestTenant(runtime, { slug: 'patients-schema-b' });
});

afterAll(async () => {
  await runtime.close();
});

describe('patient document uniqueness', () => {
  it('allows any number of patients without a document', async () => {
    await createTestPatient(runtime, a.id);
    await createTestPatient(runtime, a.id);
    await createTestPatient(runtime, a.id, { givenNames: 'Recién Nacido' });
  });

  it('rejects the same document twice in one organization', async () => {
    await createTestPatient(runtime, a.id, { nationalIdType: 'dni', nationalId: '30123456' });

    await expect(
      createTestPatient(runtime, a.id, { nationalIdType: 'dni', nationalId: '30123456' }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('treats another document type with the same number as another person', async () => {
    await createTestPatient(runtime, a.id, { nationalIdType: 'dni', nationalId: '40123456' });

    await createTestPatient(runtime, a.id, { nationalIdType: 'passport', nationalId: '40123456' });
  });

  it('lets another organization register the same document, and leaks nothing about it', async () => {
    await createTestPatient(runtime, a.id, { nationalIdType: 'dni', nationalId: '50123456' });

    await createTestPatient(runtime, b.id, { nationalIdType: 'dni', nationalId: '50123456' });
  });

  it('refuses a document type without a number, and a number without a type', async () => {
    await expect(createTestPatient(runtime, a.id, { nationalIdType: 'dni' })).rejects.toMatchObject(
      {
        cause: { code: '23514' },
      },
    );
    await expect(createTestPatient(runtime, a.id, { nationalId: '123456' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
  });
});

describe('patient columns', () => {
  it('derives the search name without accents and in lower case', async () => {
    const id = await createTestPatient(runtime, a.id, {
      familyName: 'Pérez Ñandú',
      givenNames: 'María José',
    });

    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select({ searchName: patient.searchName }).from(patient).where(eq(patient.id, id)),
    );

    expect(row?.searchName).toBe('perez nandu maria jose');
  });

  it('derives the digits of the phone however it was typed', async () => {
    const id = await createTestPatient(runtime, a.id, { phone: '+54 (11) 5555-1234' });

    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select({ digits: patient.phoneDigits }).from(patient).where(eq(patient.id, id)),
    );

    expect(row?.digits).toBe('541155551234');
  });

  it('starts at version 1, active, from the staff, with no safety flag', async () => {
    const id = await createTestPatient(runtime, a.id);

    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(patient).where(eq(patient.id, id)),
    );

    expect(row).toMatchObject({ version: 1, status: 'active', origin: 'staff', safetyFlags: [] });
  });

  it.each([
    ['an unknown sex', { sex: 'robot' }],
    ['an unknown status', { status: 'gone' }],
    ['an unknown origin', { origin: 'fax' }],
  ])('refuses %s', async (_name, values) => {
    await expect(createTestPatient(runtime, a.id, values)).rejects.toMatchObject({
      cause: { code: '23514' },
    });
  });

  it('cannot be deleted by the runtime role: patients are deactivated', async () => {
    const id = await createTestPatient(runtime, a.id);

    await expect(
      asTenant(runtime, a.id, (tx) => tx.delete(patient).where(eq(patient.id, id))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('patient history and representatives', () => {
  it('keeps versions append-only: no update, no delete', async () => {
    const id = await createTestPatient(runtime, a.id);
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(patientVersion).values({
        tenantId: a.id,
        patientId: id,
        version: 1,
        snapshot: { familyName: 'Antes' },
      }),
    );

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx
          .update(patientVersion)
          .set({ snapshot: { familyName: 'Después' } })
          .where(eq(patientVersion.patientId, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.delete(patientVersion).where(eq(patientVersion.patientId, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('has one row per patient and version', async () => {
    const id = await createTestPatient(runtime, a.id);
    const row = { tenantId: a.id, patientId: id, version: 1, snapshot: {} };
    await asTenant(runtime, a.id, (tx) => tx.insert(patientVersion).values(row));

    await expect(
      asTenant(runtime, a.id, (tx) => tx.insert(patientVersion).values(row)),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('needs a way to reach a representative', async () => {
    const id = await createTestPatient(runtime, a.id);

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(patientRepresentative).values({
          tenantId: a.id,
          patientId: id,
          fullName: 'Rosa',
          relation: 'mother',
          majorityReviewOn: '2040-01-01',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('trusts the unaccent wrapper: it is immutable and callable by the runtime role', async () => {
    const result = await asTenant(runtime, a.id, (tx) =>
      tx.execute<{ value: string }>(sql`select app.f_unaccent('Ñandú') as value`),
    );

    expect(result.rows[0]?.value).toBe('Nandu');
  });
});
