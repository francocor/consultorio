import {
  EMPTY_ANAMNESIS,
  type AssignmentListResponse,
  type AuditAction,
  type CreatePatientResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { careAssignment, careRelationship } from '../../src/db/schema/care.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let owner: pg.Client;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let reception: TestSession;
let admin: TestSession;
let doctor: TestSession;
let doctorProfessionalId: string;
let colleague: TestSession;
let noProfile: TestSession;
let counter = 90_000;

type RoleName = 'owner' | 'admin' | 'professional' | 'reception';

async function member(roles: RoleName[], t: TestTenant = tenant) {
  const user = await createTestUser(runtime, t.id, { roles, password: TEST_PASSWORD });
  return { user, session: await signInAs(app, t.slug, user) };
}

async function professionalMember(roles: RoleName[] = ['professional']) {
  const made = await member(roles);
  counter += 1;
  const profile = await api.put(
    `/staff/${made.user.membershipId}/professional-profile`,
    made.session,
    {
      fullName: `Dr. ${String(counter)}`,
      specialties: ['Medicina general'],
      matricula: { jurisdiction: 'AR-B', number: String(counter) },
    },
  );
  return { ...made, professionalId: profile.json<{ id: string }>().id };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  tenant = await createTestTenant(runtime, { slug: 'care-assignment' });
  other = await createTestTenant(runtime, { slug: 'care-assignment-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'care-assignment');
  reception = (await member(['reception'])).session;
  admin = (await member(['admin'])).session;
  const first = await professionalMember();
  doctor = first.session;
  doctorProfessionalId = first.professionalId;
  colleague = (await professionalMember()).session;
  noProfile = (await member(['professional'])).session;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await owner.end();
  await runtime.close();
});

let patientCounter = 0;
async function patientId(): Promise<string> {
  patientCounter += 1;
  const response = await api.post('/patients', reception, {
    familyName: `Asignacion${String(patientCounter)}`,
    givenNames: 'Paciente',
    birthDate: '1960-06-06',
    dataProcessingConsent: true,
  });
  return response.json<CreatePatientResponse>().patient.id;
}

const assign = (id: string, professionalId: string, by: TestSession = reception) =>
  api.post(`/patients/${id}/assignments`, by, { professionalId });
const unassign = (id: string, professionalId: string, by: TestSession = reception) =>
  api.delete(`/patients/${id}/assignments/${professionalId}`, by);
const anamnesisOf = (id: string, by: TestSession) => api.get(`/patients/${id}/anamnesis`, by);
const saveAnamnesis = (id: string, by: TestSession) =>
  api.put(`/patients/${id}/anamnesis`, by, { content: EMPTY_ANAMNESIS });

async function auditRows(id: string, action: AuditAction) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.patientId === id);
}

/** What a Stage 2 trigger does when an appointment qualifies: only the database function can. */
async function countQualifyingAppointment(id: string, professionalId: string, by: number) {
  await owner.query('BEGIN');
  try {
    await owner.query(`select set_config('app.tenant_id', $1, true)`, [tenant.id]);
    await owner.query(`select app.care_adjust($1, $2, $3, $4, 0)`, [
      tenant.id,
      id,
      professionalId,
      by,
    ]);
  } finally {
    await owner.query('COMMIT');
  }
}

describe('assigning a patient to a professional', () => {
  it('lets reception assign a patient before any appointment, which opens the clinical record to them', async () => {
    const id = await patientId();
    expect((await anamnesisOf(id, doctor)).statusCode).toBe(403);
    expect((await saveAnamnesis(id, doctor)).statusCode).toBe(403);

    const response = await assign(id, doctorProfessionalId);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      professionalId: doctorProfessionalId,
      assignedBy: reception.user.id,
    });
    expect((await anamnesisOf(id, doctor)).statusCode).toBe(200);
    expect((await saveAnamnesis(id, doctor)).statusCode).toBe(200);
    const [row] = await auditRows(id, 'assignment.created');
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: reception.user.id,
      metadata: { professionalId: doctorProfessionalId },
    });
  });

  it('lists the live assignments with the name of each professional', async () => {
    const id = await patientId();
    await assign(id, doctorProfessionalId);

    const list = (
      await api.get(`/patients/${id}/assignments`, colleague)
    ).json<AssignmentListResponse>();

    expect(list.assignments).toHaveLength(1);
    expect(list.assignments[0]).toMatchObject({
      professionalId: doctorProfessionalId,
      professionalName: expect.stringContaining('Dr.') as unknown,
    });
  });

  it('is for those who administer patients: reception, admins, and a professional with the grant', async () => {
    const id = await patientId();

    expect((await assign(id, doctorProfessionalId, admin)).statusCode).toBe(201);
    expect((await assign(id, doctorProfessionalId, colleague)).statusCode).toBe(403);
    expect((await assign(id, doctorProfessionalId, noProfile)).statusCode).toBe(403);
  });

  it('refuses a professional who tries to assign the patient to themselves, even holding the grant', async () => {
    const solo = await professionalMember();
    const id = await patientId();
    await api.post(`/members/${solo.user.membershipId}/grants`, admin, {
      permission: 'patients.administer',
    });

    const response = await assign(id, solo.professionalId, solo.session);

    expect(response.statusCode).toBe(403);
    const [row] = await auditRows(id, 'access.denied');
    expect(row).toMatchObject({
      outcome: 'deny',
      reason: 'assignment_self',
      actorUserId: solo.user.id,
    });
    // The same professional can be assigned by someone else.
    expect((await assign(id, solo.professionalId, reception)).statusCode).toBe(201);
  });

  it('refuses an owner who is also the professional being assigned', async () => {
    const both = await professionalMember(['owner', 'professional']);
    const id = await patientId();

    const response = await assign(id, both.professionalId, both.session);

    expect(response.statusCode).toBe(403);
  });

  it('refuses a second live assignment of the same pair, an unknown professional, and an inactive one', async () => {
    const id = await patientId();
    await assign(id, doctorProfessionalId);
    const gone = await professionalMember();
    await api.post(`/staff/${gone.user.membershipId}/deactivate`, admin);

    expect((await assign(id, doctorProfessionalId)).statusCode).toBe(409);
    expect((await assign(id, '0190a000-0000-7000-8000-0000000000ee')).statusCode).toBe(404);
    expect((await assign(id, gone.professionalId)).statusCode).toBe(409);
  });

  it("answers 404 for another organization's patient and professional", async () => {
    const id = await patientId();
    const elsewhere = await member(['reception'], other);
    const otherDoctor = await createTestUser(runtime, other.id, {
      roles: ['professional'],
      password: TEST_PASSWORD,
    });
    const otherApi = clientFor(app, 'care-assignment-b');
    const otherSession = await signInAs(app, 'care-assignment-b', otherDoctor);
    const foreignProfile = await otherApi.put(
      `/staff/${otherDoctor.membershipId}/professional-profile`,
      otherSession,
      {
        fullName: 'Dra. Ajena',
        specialties: ['Medicina general'],
        matricula: { jurisdiction: 'AR-B', number: '99111' },
      },
    );

    expect(
      (
        await otherApi.post(`/patients/${id}/assignments`, elsewhere.session, {
          professionalId: foreignProfile.json<{ id: string }>().id,
        })
      ).statusCode,
    ).toBe(404);
    expect((await assign(id, foreignProfile.json<{ id: string }>().id)).statusCode).toBe(404);
  });

  it('is refused in a read-only organization, like any write', async () => {
    const id = await patientId();
    await asTenant(runtime, tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, tenant.id)),
    );
    try {
      expect((await assign(id, doctorProfessionalId)).statusCode).toBe(402);
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

describe('removing an assignment', () => {
  it('ends the access at once, keeps the history and the authorship, and audits it', async () => {
    const id = await patientId();
    await assign(id, doctorProfessionalId);
    expect((await saveAnamnesis(id, doctor)).statusCode).toBe(200);

    const response = await unassign(id, doctorProfessionalId);

    expect(response.statusCode).toBe(204);
    // No longer treating: the professional cannot write, and cannot record anything new.
    expect((await saveAnamnesis(id, doctor)).statusCode).toBe(403);
    // What they wrote stays attributed to them (the author rule of the sharing scope).
    const own = await anamnesisOf(id, doctor);
    expect(
      own.json<{ current: { authorProfessionalId: string } }>().current.authorProfessionalId,
    ).toBe(doctorProfessionalId);
    const history = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(careAssignment).where(eq(careAssignment.patientId, id)),
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.removedAt).toBeInstanceOf(Date);
    expect((await auditRows(id, 'assignment.removed'))[0]).toMatchObject({
      outcome: 'allow',
      metadata: { professionalId: doctorProfessionalId },
    });
  });

  it('keeps the relationship while another source supports it, and ends it when none is left', async () => {
    const id = await patientId();
    await assign(id, doctorProfessionalId);
    await countQualifyingAppointment(id, doctorProfessionalId, 1);

    await unassign(id, doctorProfessionalId);
    const afterAssignment = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(careRelationship).where(eq(careRelationship.patientId, id)),
    );
    expect(afterAssignment[0]).toMatchObject({
      assigned: false,
      qualifyingAppointments: 1,
      active: true,
    });
    // The appointment still supports the relationship: the professional still treats the patient.
    expect((await saveAnamnesis(id, doctor)).statusCode).toBe(200);

    await countQualifyingAppointment(id, doctorProfessionalId, -1);
    expect((await saveAnamnesis(id, doctor)).statusCode).toBe(403);
  });

  it('answers 404 when there is nothing to remove, and refuses a professional who is not authorized', async () => {
    const id = await patientId();

    expect((await unassign(id, doctorProfessionalId)).statusCode).toBe(404);
    await assign(id, doctorProfessionalId);
    expect((await unassign(id, doctorProfessionalId, doctor)).statusCode).toBe(403);
    expect((await unassign(id, doctorProfessionalId, colleague)).statusCode).toBe(403);
  });

  it('can assign again after a removal', async () => {
    const id = await patientId();
    await assign(id, doctorProfessionalId);
    await unassign(id, doctorProfessionalId);

    expect((await assign(id, doctorProfessionalId)).statusCode).toBe(201);
    expect((await saveAnamnesis(id, doctor)).statusCode).toBe(200);
  });
});
