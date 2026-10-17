import type {
  AuditAction,
  ConsentResponse,
  CreatePatientResponse,
  PatientDto,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { dataProcessingConsent } from '../../src/db/schema/privacy.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let reception: TestSession;
let doctor: TestSession;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'patients-consent' });
  other = await createTestTenant(runtime, { slug: 'patients-consent-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'patients-consent');
  const make = (roles: ('reception' | 'professional')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  reception = await signInAs(app, 'patients-consent', await make(['reception']));
  doctor = await signInAs(app, 'patients-consent', await make(['professional']));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

let counter = 0;
async function register(consent: boolean | undefined, by: TestSession = reception) {
  counter += 1;
  return api.post('/patients', by, {
    familyName: `Consentimiento${String(counter)}`,
    givenNames: 'Paciente',
    birthDate: '1975-07-07',
    ...(consent === undefined ? {} : { dataProcessingConsent: consent }),
  });
}

async function registered(consent: boolean) {
  const response = await register(consent);
  expect(response.statusCode).toBe(201);
  return response.json<CreatePatientResponse>().patient;
}

const consentOf = async (patientId: string, by: TestSession = reception) =>
  (await api.get(`/patients/${patientId}/consent`, by)).json<ConsentResponse>();

async function auditRows(patientId: string, action: AuditAction) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.patientId === patientId);
}

describe('the consent prompt at registration', () => {
  it('has to be answered: a registration without the answer is refused', async () => {
    const response = await register(undefined);

    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ errors: { path: string }[] }>().errors.map((error) => error.path),
    ).toContain('dataProcessingConsent');
  });

  it('records the consent with its time, who recorded it and the text version', async () => {
    const before = Date.now();
    const patient = await registered(true);

    const consent = await consentOf(patient.id);

    expect(patient.consentStatus).toBe('granted');
    expect(consent.status).toBe('granted');
    expect(consent.current).toMatchObject({
      textKey: 'consent.data_processing.ar',
      textVersion: '1',
      recordedBy: reception.user.id,
      revokedAt: null,
    });
    expect(new Date(consent.current?.grantedAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    const [row] = await auditRows(patient.id, 'patient.consent.recorded');
    expect(row).toMatchObject({ outcome: 'allow', metadata: { textVersion: '1' } });
  });

  it('saves a patient who did not consent, flagged as missing, so staff are warned', async () => {
    const patient = await registered(false);

    expect(patient.consentStatus).toBe('missing');
    expect((await consentOf(patient.id)).status).toBe('missing');
    expect(
      (await api.get(`/patients/${patient.id}`, reception)).json<PatientDto>().consentStatus,
    ).toBe('missing');
    expect(await auditRows(patient.id, 'patient.consent.recorded')).toHaveLength(0);
  });
});

describe('recording and revoking consent later', () => {
  it('records the consent of a patient who had none, and refuses to record it twice', async () => {
    const patient = await registered(false);

    const first = await api.post(`/patients/${patient.id}/consent`, reception);
    const second = await api.post(`/patients/${patient.id}/consent`, reception);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect((await consentOf(patient.id)).status).toBe('granted');
  });

  it('revokes with the date, keeps the history, and allows a new consent afterwards', async () => {
    const patient = await registered(true);

    const revoked = await api.post(`/patients/${patient.id}/consent/revoke`, reception);

    expect(revoked.statusCode).toBe(204);
    const after = await consentOf(patient.id);
    expect(after.status).toBe('revoked');
    expect(after.current).toMatchObject({ revokedBy: reception.user.id });
    expect(after.current?.revokedAt).not.toBeNull();
    expect(after.history).toHaveLength(1);
    expect((await auditRows(patient.id, 'patient.consent.revoked'))[0]).toMatchObject({
      outcome: 'allow',
      actorUserId: reception.user.id,
    });

    await api.post(`/patients/${patient.id}/consent`, doctor);
    const again = await consentOf(patient.id);
    expect(again.status).toBe('granted');
    expect(again.history).toHaveLength(2);
    const rows = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(dataProcessingConsent)
        .where(eq(dataProcessingConsent.patientId, patient.id)),
    );
    expect(rows).toHaveLength(2);
  });

  it('refuses to revoke a consent that does not exist', async () => {
    const patient = await registered(false);

    expect((await api.post(`/patients/${patient.id}/consent/revoke`, reception)).statusCode).toBe(
      409,
    );
  });

  it('is open to any staff member who writes patients, not only to those who treat the patient', async () => {
    const patient = await registered(false);

    expect((await api.post(`/patients/${patient.id}/consent`, doctor)).statusCode).toBe(201);
  });

  it("answers 404 for another organization's patient", async () => {
    const patient = await registered(true);
    const elsewhere = await signInAs(
      app,
      'patients-consent-b',
      await createTestUser(runtime, other.id, { roles: ['reception'], password: TEST_PASSWORD }),
    );
    const otherApi = clientFor(app, 'patients-consent-b');

    expect((await otherApi.get(`/patients/${patient.id}/consent`, elsewhere)).statusCode).toBe(404);
    expect(
      (await otherApi.post(`/patients/${patient.id}/consent/revoke`, elsewhere)).statusCode,
    ).toBe(404);
  });
});

describe('consent in a read-only organization', () => {
  it('lets the patient revoke, as a patient-protective action, and refuses to record a new one', async () => {
    const patient = await registered(true);
    const lapsed = await registered(false);
    await asTenant(runtime, tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, tenant.id)),
    );
    try {
      const revoke = await api.post(`/patients/${patient.id}/consent/revoke`, reception);
      const record = await api.post(`/patients/${lapsed.id}/consent`, reception);

      expect(revoke.statusCode).toBe(204);
      expect(record.statusCode).toBe(402);
    } finally {
      await asTenant(runtime, tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, tenant.id)),
      );
    }
  });
});
