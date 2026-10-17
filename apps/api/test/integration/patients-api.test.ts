import type {
  AuditAction,
  CreatePatientResponse,
  DuplicatePatientProblem,
  PatientDto,
  PatientHistoryResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { patient, patientVersion } from '../../src/db/schema/patients.js';
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
let owner: TestSession;
let reception: TestSession;
let doctor: TestSession;
let doctorProfessionalId: string;
let colleague: TestSession;
let colleagueProfessionalId: string;
let counter = 0;

type RoleName = 'owner' | 'admin' | 'professional' | 'reception';

async function member(roles: RoleName[], t: TestTenant = tenant) {
  const user = await createTestUser(runtime, t.id, { roles, password: TEST_PASSWORD });
  return { user, session: await signInAs(app, t.slug, user) };
}

async function professionalMember() {
  const made = await member(['professional']);
  counter += 1;
  const profile = await api.put(
    `/staff/${made.user.membershipId}/professional-profile`,
    made.session,
    {
      fullName: `Dr. ${String(counter)}`,
      specialties: ['Medicina general'],
      matricula: { jurisdiction: 'AR-B', number: String(70_000 + counter) },
    },
  );
  return { ...made, professionalId: profile.json<{ id: string }>().id };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'patients-api' });
  other = await createTestTenant(runtime, { slug: 'patients-api-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'patients-api');
  owner = (await member(['owner'])).session;
  reception = (await member(['reception'])).session;
  const first = await professionalMember();
  doctor = first.session;
  doctorProfessionalId = first.professionalId;
  const second = await professionalMember();
  colleague = second.session;
  colleagueProfessionalId = second.professionalId;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const PERSON = {
  familyName: 'Pérez',
  givenNames: 'Ana María',
  birthDate: '1990-05-17',
  dataProcessingConsent: true,
};
let dniCounter = 31_000_000;
const nextDni = () => String((dniCounter += 1));

async function create(by: TestSession, body: Record<string, unknown> = {}) {
  return api.post('/patients', by, { ...PERSON, ...body });
}

async function created(body: Record<string, unknown> = {}, by: TestSession = reception) {
  const response = await create(by, body);
  expect(response.statusCode).toBe(201);
  return response.json<CreatePatientResponse>();
}

async function auditRows(action: AuditAction, patientId?: string) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return patientId === undefined ? rows : rows.filter((row) => row.patientId === patientId);
}

describe('registering a patient', () => {
  it('stores a normalized document, starts the history, and audits without any value', async () => {
    const { patient: made } = await created({
      document: { type: 'dni', number: '31.500.001' },
      phone: '11 5555-1234',
      email: 'ana@example.test',
    });

    expect(made).toMatchObject({
      familyName: 'Pérez',
      givenNames: 'Ana María',
      birthDate: '1990-05-17',
      document: { type: 'dni', number: '31500001' },
      noDocument: false,
      status: 'active',
      origin: 'staff',
      hasSafetyFlag: false,
      version: 1,
    });
    const versions = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(patientVersion).where(eq(patientVersion.patientId, made.id)),
    );
    expect(versions).toHaveLength(1);
    const [row] = await auditRows('patient.created', made.id);
    expect(row).toMatchObject({
      outcome: 'allow',
      resourceType: 'patient',
      metadata: { hasDocument: true },
    });
    expect(JSON.stringify(row)).not.toContain('31500001');
    expect(JSON.stringify(row)).not.toContain('5555');
  });

  it('registers a newborn with no document, flagged as such, and it never blocks', async () => {
    const first = await created({ givenNames: 'Recién', familyName: 'Nacido' });
    const second = await created({ givenNames: 'Recién', familyName: 'Nacido' });

    expect(first.patient).toMatchObject({ document: null, noDocument: true });
    expect(first.possibleDuplicates).toEqual([]);
    // Same name and birth date, no document: a warning with the existing patient, not a refusal.
    expect(second.possibleDuplicates.map((summary) => summary.id)).toEqual([first.patient.id]);
  });

  it('blocks a duplicate document and shows the existing patient, however it was typed', async () => {
    const number = nextDni();
    const { patient: existing } = await created({ document: { type: 'dni', number } });

    const response = await create(reception, {
      familyName: 'Otro',
      document: {
        type: 'dni',
        number: `${number.slice(0, 2)}.${number.slice(2, 5)}.${number.slice(5)}`,
      },
    });

    expect(response.statusCode).toBe(409);
    const problem = response.json<DuplicatePatientProblem>();
    expect(problem).toMatchObject({
      code: 'conflict',
      status: 409,
      existingPatient: {
        id: existing.id,
        familyName: 'Pérez',
        document: { type: 'dni', number },
      },
    });
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('knows nothing of a document registered in another organization', async () => {
    const number = nextDni();
    const elsewhere = await member(['reception'], other);
    const otherApi = clientFor(app, 'patients-api-b');
    const there = await otherApi.post('/patients', elsewhere.session, {
      ...PERSON,
      document: { type: 'dni', number },
    });
    expect(there.statusCode).toBe(201);

    const here = await create(reception, { document: { type: 'dni', number } });

    expect(here.statusCode).toBe(201);
    expect(here.body).not.toContain(there.json<CreatePatientResponse>().patient.id);
  });

  it('rejects an invalid document with a translated field error, and accepts a passport', async () => {
    const invalid = await create(reception, { document: { type: 'dni', number: '12AB' } });
    const passport = await create(reception, {
      document: { type: 'passport', number: 'ab-123456' },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'document', i18nKey: 'country.ar.national_id.invalid' },
    ]);
    expect(passport.json<CreatePatientResponse>().patient.document).toEqual({
      type: 'passport',
      number: 'AB123456',
    });
  });

  it('lists the missing fields', async () => {
    const response = await api.post('/patients', reception, { givenNames: 'Sin Apellido' });

    expect(response.statusCode).toBe(400);
    const paths = response.json<{ errors: { path: string }[] }>().errors.map((error) => error.path);
    expect(paths).toEqual(expect.arrayContaining(['familyName', 'birthDate']));
  });

  it('refuses a birth date in the future', async () => {
    const response = await create(reception, { birthDate: '2999-01-01' });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'birthDate', i18nKey: 'patients.birth_date_future' },
    ]);
  });

  it('is open to reception, professionals and owners, and closed without a session', async () => {
    for (const session of [reception, doctor, owner]) {
      expect((await create(session, { givenNames: 'Quien Sea' })).statusCode).toBe(201);
    }
    expect((await api.post('/patients', null, PERSON)).statusCode).toBe(401);
  });

  it('cannot set the safety flag, the status, the version or the tenant', async () => {
    for (const extra of [
      { safetyFlags: ['allergy_on_file'] },
      { status: 'inactive' },
      { version: 9 },
      { tenantId: other.id },
    ]) {
      expect((await create(reception, extra)).statusCode).toBe(400);
    }
  });
});

describe('reading a patient', () => {
  it('returns the demographics to any staff member, and audits the read', async () => {
    const { patient: made } = await created();

    const response = await api.get(`/patients/${made.id}`, doctor);

    expect(response.statusCode).toBe(200);
    expect(response.json<PatientDto>()).toMatchObject({ id: made.id, familyName: 'Pérez' });
    const [row] = await auditRows('patient.read', made.id);
    expect(row).toMatchObject({ outcome: 'allow', actorUserId: doctor.user.id });
  });

  it("answers 404 for another organization's patient and for an id that does not exist", async () => {
    const elsewhere = await member(['reception'], other);
    const there = await clientFor(app, 'patients-api-b').post(
      '/patients',
      elsewhere.session,
      PERSON,
    );
    const id = there.json<CreatePatientResponse>().patient.id;

    expect((await api.get(`/patients/${id}`, reception)).statusCode).toBe(404);
    expect(
      (await api.get('/patients/0190a000-0000-7000-8000-0000000000ff', reception)).statusCode,
    ).toBe(404);
  });
});

describe('editing a patient', () => {
  it('writes a new version, keeps both in the history and audits the field names only', async () => {
    const { patient: made } = await created({ phone: '11 4444-0000' });

    const response = await api.patch(`/patients/${made.id}`, reception, { phone: '11 5555-9999' });

    expect(response.statusCode).toBe(200);
    expect(response.json<PatientDto>()).toMatchObject({ phone: '11 5555-9999', version: 2 });
    const history = (
      await api.get(`/patients/${made.id}/history`, owner)
    ).json<PatientHistoryResponse>();
    expect(history.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(history.versions[0]?.snapshot['phone']).toBe('11 4444-0000');
    expect(history.versions[1]?.snapshot['phone']).toBe('11 5555-9999');
    expect(history.versions[1]).toMatchObject({
      changedFields: ['phone'],
      changedBy: reception.user.id,
    });
    const [row] = await auditRows('patient.updated', made.id);
    expect(row).toMatchObject({ metadata: { fields: ['phone'], version: 2 } });
    expect(JSON.stringify(row)).not.toContain('5555');
  });

  it('clears a value with null and keeps the rest', async () => {
    const { patient: made } = await created({ phone: '11 4444-0000', address: 'Calle 1' });

    const response = await api.patch(`/patients/${made.id}`, reception, { phone: null });

    expect(response.json<PatientDto>()).toMatchObject({
      phone: null,
      address: 'Calle 1',
      version: 2,
    });
  });

  it('does nothing, and writes no version, when the values did not change', async () => {
    const { patient: made } = await created({ phone: '11 4444-0000' });

    const response = await api.patch(`/patients/${made.id}`, reception, { phone: '11 4444-0000' });

    expect(response.json<PatientDto>().version).toBe(1);
    expect(await auditRows('patient.updated', made.id)).toHaveLength(0);
  });

  it('answers a stale edit with 409, so two editors do not overwrite each other', async () => {
    const { patient: made } = await created();
    await api.patch(`/patients/${made.id}`, reception, { phone: '11 1111-1111' });

    const stale = await api.patch(`/patients/${made.id}`, owner, {
      phone: '11 2222-2222',
      expectedVersion: 1,
    });
    const fresh = await api.patch(`/patients/${made.id}`, owner, {
      phone: '11 2222-2222',
      expectedVersion: 2,
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('stale_revision');
    expect(fresh.statusCode).toBe(200);
  });

  it('adds a document later, and refuses to take one that another patient holds', async () => {
    const number = nextDni();
    const { patient: holder } = await created({ document: { type: 'dni', number } });
    const { patient: newborn } = await created({ givenNames: 'Sin Documento' });

    const taken = await api.patch(`/patients/${newborn.id}`, reception, {
      document: { type: 'dni', number },
    });
    const free = await api.patch(`/patients/${newborn.id}`, reception, {
      document: { type: 'dni', number: nextDni() },
    });

    expect(taken.statusCode).toBe(409);
    expect(taken.json<DuplicatePatientProblem>().existingPatient.id).toBe(holder.id);
    expect(free.json<PatientDto>()).toMatchObject({ noDocument: false, version: 2 });
  });

  it('lets a patient keep their own document in an edit that repeats it', async () => {
    const number = nextDni();
    const { patient: made } = await created({ document: { type: 'dni', number } });

    const response = await api.patch(`/patients/${made.id}`, reception, {
      document: { type: 'dni', number },
      phone: '11 3333-3333',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<PatientDto>().version).toBe(2);
  });

  it('lets a professional edit only patients they treat, unless they administer patients', async () => {
    const { patient: made } = await created();
    const edit = (by: TestSession) => api.patch(`/patients/${made.id}`, by, { address: 'Calle 9' });

    const stranger = await edit(doctor);
    expect(stranger.statusCode).toBe(403);
    expect((await asTenantDenials(made.id))[0]).toMatchObject({
      reason: 'patient_edit_not_treating',
    });

    await asTenant(runtime, tenant.id, (tx) =>
      tx.insert(careAssignment).values({
        tenantId: tenant.id,
        patientId: made.id,
        professionalId: doctorProfessionalId,
        assignedBy: owner.user.id,
      }),
    );
    expect((await edit(doctor)).statusCode).toBe(200);
    // The colleague still does not treat this patient.
    expect((await edit(colleague)).statusCode).toBe(403);
    // A grant of patient administration lets a professional edit any patient.
    await api.post(`/members/${colleague.user.membershipId}/grants`, owner, {
      permission: 'patients.administer',
    });
    expect((await edit(colleague)).statusCode).toBe(200);
    expect(colleagueProfessionalId).toBeDefined();
  });

  async function asTenantDenials(patientId: string) {
    const rows = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'access.denied')))
        .orderBy(desc(auditEvent.occurredAt)),
    );
    return rows.filter((row) => row.patientId === patientId);
  }

  it('answers 404 for another organization and 400 for a body that changes nothing', async () => {
    const { patient: made } = await created();
    const stranger = await member(['owner'], other);

    expect(
      (
        await clientFor(app, 'patients-api-b').patch(`/patients/${made.id}`, stranger.session, {
          phone: '1',
        })
      ).statusCode,
    ).toBe(404);
    expect((await api.patch(`/patients/${made.id}`, reception, {})).statusCode).toBe(400);
  });
});

describe('deactivating a patient', () => {
  it('hides them from the default list, keeps everything, and reactivates', async () => {
    const { patient: made } = await created({ givenNames: 'Desactivable' });

    const off = await api.post(`/patients/${made.id}/deactivate`, reception);

    expect(off.statusCode).toBe(200);
    expect(off.json<PatientDto>().status).toBe('inactive');
    const [row] = await auditRows('patient.deactivated', made.id);
    expect(row).toMatchObject({ outcome: 'allow' });
    const stored = await asTenant(runtime, tenant.id, (tx) =>
      tx.select({ id: patient.id }).from(patient).where(eq(patient.id, made.id)),
    );
    expect(stored).toHaveLength(1);

    const on = await api.post(`/patients/${made.id}/reactivate`, reception);
    expect(on.json<PatientDto>().status).toBe('active');
    expect(await auditRows('patient.reactivated', made.id)).toHaveLength(1);
    const history = (
      await api.get(`/patients/${made.id}/history`, reception)
    ).json<PatientHistoryResponse>();
    expect(history.versions.map((version) => version.changedFields)).toEqual([
      [],
      ['status'],
      ['status'],
    ]);
  });

  it('is closed to a professional who does not administer patients', async () => {
    const { patient: made } = await created();

    expect((await api.post(`/patients/${made.id}/deactivate`, doctor)).statusCode).toBe(403);
  });

  it('refuses a deletion and offers deactivation instead', async () => {
    const { patient: made } = await created();

    const response = await api.delete(`/patients/${made.id}`, reception);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: '(root)', i18nKey: 'patients.deletion_not_allowed' },
    ]);
    expect((await api.get(`/patients/${made.id}`, reception)).statusCode).toBe(200);
  });
});
