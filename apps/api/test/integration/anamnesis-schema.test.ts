import { randomUUID } from 'node:crypto';

import { SAFETY_FLAG_CODES } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { anamnesis } from '../../src/db/schema/anamnesis.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { patient } from '../../src/db/schema/patients.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createTestPatient } from '../support/patients.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;
let author: string;
let colleague: string;
let stranger: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'anamnesis-a' });
  b = await createTestTenant(runtime, { slug: 'anamnesis-b' });
  author = (await createTestProfessional(runtime, a.id)).professionalId;
  colleague = (await createTestProfessional(runtime, a.id)).professionalId;
  stranger = (await createTestProfessional(runtime, b.id)).professionalId;
});

afterAll(async () => {
  await runtime.close();
});

const run = createWithTenant;

describe('the safety flag is maintained by one database function', () => {
  const setFlags = (
    tenantId: string,
    patientId: string,
    codes: string[],
    professionalId: string | undefined,
    asTenantId: string = tenantId,
  ) =>
    run(runtime.db)(
      {
        tenantId,
        userId: randomUUID(),
        ...(professionalId === undefined ? {} : { actingProfessionalId: professionalId }),
      },
      (tx) =>
        tx.execute(
          sql`select app.set_patient_safety_flags(${asTenantId}::uuid, ${patientId}::uuid, array[${sql.join(
            codes.map((code) => sql`${code}`),
            sql`, `,
          )}]::text[])`,
        ),
    );

  const flagsOf = async (patientId: string) => {
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select({ flags: patient.safetyFlags }).from(patient).where(eq(patient.id, patientId)),
    );
    return row?.flags;
  };

  it('sets sorted, distinct codes when a professional calls it, and clears them with an empty list', async () => {
    const id = await createTestPatient(runtime, a.id);

    await setFlags(a.id, id, ['pregnancy', 'allergy_on_file', 'pregnancy'], author);
    expect(await flagsOf(id)).toEqual(['allergy_on_file', 'pregnancy']);

    await setFlags(a.id, id, [], author);
    expect(await flagsOf(id)).toEqual([]);
  });

  it('knows exactly the codes the contracts list', async () => {
    const id = await createTestPatient(runtime, a.id);

    await setFlags(a.id, id, [...SAFETY_FLAG_CODES], author);

    expect(await flagsOf(id)).toEqual([...SAFETY_FLAG_CODES].sort());
    await expect(setFlags(a.id, id, ['made_up'], author)).rejects.toMatchObject({
      cause: { code: '22023' },
    });
  });

  it('refuses a caller who is not acting as a health professional', async () => {
    const id = await createTestPatient(runtime, a.id);

    await expect(setFlags(a.id, id, ['pregnancy'], undefined)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    expect(await flagsOf(id)).toEqual([]);
  });

  it('refuses another tenant, and a patient that does not exist', async () => {
    const id = await createTestPatient(runtime, a.id);

    await expect(setFlags(b.id, id, ['pregnancy'], stranger, a.id)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(setFlags(a.id, randomUUID(), ['pregnancy'], author)).rejects.toMatchObject({
      cause: { code: 'P0002' },
    });
  });

  it('refuses every other way of writing the flag, even for a professional', async () => {
    const id = await createTestPatient(runtime, a.id);

    await expect(
      run(runtime.db)(
        { tenantId: a.id, userId: randomUUID(), actingProfessionalId: author },
        (tx) =>
          tx
            .update(patient)
            .set({ safetyFlags: ['allergy_on_file'] })
            .where(eq(patient.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      createTestPatient(runtime, a.id, { safetyFlags: ['pregnancy'] }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await flagsOf(id)).toEqual([]);
  });

  it('lets a flag survive the ordinary edits of the demographics', async () => {
    const id = await createTestPatient(runtime, a.id);
    await setFlags(a.id, id, ['allergy_on_file'], author);

    await asTenant(runtime, a.id, (tx) =>
      tx.update(patient).set({ phone: '11 5555-0000' }).where(eq(patient.id, id)),
    );

    expect(await flagsOf(id)).toEqual(['allergy_on_file']);
  });
});

describe('the anamnesis table and the clinical backstop', () => {
  async function insertVersion(patientId: string, authorId: string, version = 1) {
    await run(runtime.db)(
      { tenantId: a.id, userId: randomUUID(), actingProfessionalId: authorId },
      (tx) =>
        tx.insert(anamnesis).values({
          tenantId: a.id,
          patientId,
          version,
          authorProfessionalId: authorId,
          contentEnc: Buffer.from([1, 2, 3]),
        }),
    );
  }

  const visible = async (
    patientId: string,
    professionalId: string | undefined,
    tenantId = a.id,
  ) => {
    const rows = await run(runtime.db)(
      {
        tenantId,
        userId: randomUUID(),
        ...(professionalId === undefined ? {} : { actingProfessionalId: professionalId }),
      },
      (tx) =>
        tx.select({ id: anamnesis.id }).from(anamnesis).where(eq(anamnesis.patientId, patientId)),
    );
    return rows.length;
  };

  it('shows nothing to a transaction that is not a professional, however it was authorized', async () => {
    const id = await createTestPatient(runtime, a.id);
    await insertVersion(id, author);

    expect(await visible(id, undefined)).toBe(0);
    expect(await visible(id, author)).toBe(1);
  });

  it('shows a colleague nothing until they treat the patient, then everything', async () => {
    const id = await createTestPatient(runtime, a.id);
    await insertVersion(id, author);
    expect(await visible(id, colleague)).toBe(0);

    await asTenant(runtime, a.id, (tx) =>
      tx.insert(careAssignment).values({
        tenantId: a.id,
        patientId: id,
        professionalId: colleague,
        assignedBy: randomUUID(),
      }),
    );

    expect(await visible(id, colleague)).toBe(1);
  });

  it('follows the general ceiling of the sharing scope, read only by the setting', async () => {
    const id = await createTestPatient(runtime, a.id);
    await insertVersion(id, author);
    const other = (await createTestProfessional(runtime, a.id)).professionalId;
    expect(await visible(id, other)).toBe(0);

    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ settings: { clinicalSharing: true } })
        .where(eq(tenantTable.id, a.id)),
    );
    try {
      expect(await visible(id, other)).toBe(1);
    } finally {
      await asTenant(runtime, a.id, (tx) =>
        tx.update(tenantTable).set({ settings: {} }).where(eq(tenantTable.id, a.id)),
      );
    }
    expect(await visible(id, other)).toBe(0);
  });

  it('cannot be written by someone who is not the author of the row', async () => {
    const id = await createTestPatient(runtime, a.id);

    await expect(
      run(runtime.db)(
        { tenantId: a.id, userId: randomUUID(), actingProfessionalId: colleague },
        (tx) =>
          tx.insert(anamnesis).values({
            tenantId: a.id,
            patientId: id,
            version: 1,
            authorProfessionalId: author,
            contentEnc: Buffer.from([1]),
          }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('keeps versions immutable and numbered once per patient', async () => {
    const id = await createTestPatient(runtime, a.id);
    await insertVersion(id, author, 1);
    await insertVersion(id, author, 2);

    await expect(insertVersion(id, author, 2)).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      run(runtime.db)(
        { tenantId: a.id, userId: randomUUID(), actingProfessionalId: author },
        (tx) => tx.update(anamnesis).set({ version: 9 }).where(eq(anamnesis.patientId, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      run(runtime.db)(
        { tenantId: a.id, userId: randomUUID(), actingProfessionalId: author },
        (tx) => tx.delete(anamnesis).where(eq(anamnesis.patientId, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
