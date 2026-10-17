import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { patient, patientVersion } from '../../src/db/schema/patients.js';
import { dataProcessingConsent } from '../../src/db/schema/privacy.js';
import { createOnlinePatient, findPatientByDocument } from '../../src/modules/patients/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'online-registry-a' });
  b = await createTestTenant(runtime, { slug: 'online-registry-b' });
});

afterAll(async () => {
  await runtime.close();
});

const actor = {
  userId: null,
  actingRole: null,
  ip: '203.0.113.9',
  userAgent: 'vitest',
  requestId: 'req-1',
};
const document = { type: 'dni', number: '30111222' };
const input = {
  givenNames: 'Lucía',
  familyName: 'Fernández',
  birthDate: '1990-04-02',
  document,
  phone: '+54 11 5555 0000',
  email: 'lucia@example.test',
  consent: { textKey: 'consent.data_processing', version: '1' },
};

describe('registering a patient from the public booking', () => {
  it('creates a patient flagged as created online, with its first version and consent', async () => {
    const created = await asTenant(runtime, a.id, (tx) =>
      createOnlinePatient(tx, { actor, ...input }),
    );

    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(patient).where(eq(patient.id, created.id)),
    );
    expect(row).toMatchObject({
      origin: 'online',
      status: 'active',
      familyName: 'Fernández',
      givenNames: 'Lucía',
      nationalIdType: 'dni',
      nationalId: '30111222',
      phone: '+54 11 5555 0000',
      email: 'lucia@example.test',
      version: 1,
    });
    const versions = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(patientVersion).where(eq(patientVersion.patientId, created.id)),
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, changedBy: null });
    const consents = await asTenant(runtime, a.id, (tx) =>
      tx
        .select()
        .from(dataProcessingConsent)
        .where(eq(dataProcessingConsent.patientId, created.id)),
    );
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      textKey: 'consent.data_processing',
      textVersion: '1',
      revokedAt: null,
    });
  });

  it('audits the creation with the origin and no value of the form', async () => {
    const [created] = await asTenant(runtime, a.id, (tx) =>
      tx.select({ id: patient.id }).from(patient).where(eq(patient.nationalId, '30111222')),
    );

    const events = await asTenant(runtime, a.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, 'patient.created'),
            eq(auditEvent.resourceId, created?.id ?? ''),
          ),
        ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ origin: 'online', hasDocument: true });
    expect(events[0]?.actorUserId).toBeNull();
    expect(JSON.stringify(events[0]?.metadata)).not.toContain('Fern');
  });

  it('creates the patient without a consent record when none was given', async () => {
    const created = await asTenant(runtime, b.id, (tx) =>
      createOnlinePatient(tx, {
        actor,
        ...input,
        document: { type: 'dni', number: '30999888' },
        consent: null,
      }),
    );

    const consents = await asTenant(runtime, b.id, (tx) =>
      tx
        .select()
        .from(dataProcessingConsent)
        .where(eq(dataProcessingConsent.patientId, created.id)),
    );
    expect(consents).toEqual([]);
  });

  it('refuses a second patient with the same document (the unique key holds)', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) => createOnlinePatient(tx, { actor, ...input })),
    ).rejects.toThrow();
  });
});

describe('finding a patient by document', () => {
  it('returns the identity on file and nothing else', async () => {
    const found = await asTenant(runtime, a.id, (tx) => findPatientByDocument(tx, document));

    expect(found).toMatchObject({
      givenNames: 'Lucía',
      familyName: 'Fernández',
      birthDate: '1990-04-02',
      phone: '+54 11 5555 0000',
      email: 'lucia@example.test',
      status: 'active',
    });
    expect(Object.keys(found ?? {}).sort()).toEqual([
      'birthDate',
      'email',
      'familyName',
      'givenNames',
      'id',
      'phone',
      'status',
    ]);
  });

  it('finds nobody for a document that nobody has, or that belongs to another organization', async () => {
    const nobody = await asTenant(runtime, a.id, (tx) =>
      findPatientByDocument(tx, { type: 'dni', number: '11222333' }),
    );
    const elsewhere = await asTenant(runtime, b.id, (tx) => findPatientByDocument(tx, document));

    expect(nobody).toBeNull();
    expect(elsewhere).toBeNull();
  });
});
