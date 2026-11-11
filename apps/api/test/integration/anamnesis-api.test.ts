import {
  EMPTY_ANAMNESIS,
  type AnamnesisContent,
  type AnamnesisResponse,
  type AuditAction,
  type CreatePatientResponse,
  type PatientDto,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { anamnesis } from '../../src/db/schema/anamnesis.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { patient } from '../../src/db/schema/patients.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
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
let owner: TestSession;
let admin: TestSession;
let treating: TestSession;
let treatingId: string;
let colleague: TestSession;
let noProfile: TestSession;
let counter = 80_000;

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
      fullName: `Dra. ${String(counter)}`,
      specialties: ['Medicina general'],
      matricula: { jurisdiction: 'AR-B', number: String(counter) },
    },
  );
  return { ...made, professionalId: profile.json<{ id: string }>().id };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'anamnesis-api' });
  other = await createTestTenant(runtime, { slug: 'anamnesis-api-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'anamnesis-api');
  reception = (await member(['reception'])).session;
  owner = (await member(['owner'])).session;
  admin = (await member(['admin'])).session;
  const first = await professionalMember();
  treating = first.session;
  treatingId = first.professionalId;
  colleague = (await professionalMember()).session;
  noProfile = (await member(['professional'])).session;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const PENICILLIN: AnamnesisContent = {
  ...EMPTY_ANAMNESIS,
  allergies: [{ substance: 'Penicilina', reaction: 'urticaria', severity: 'severe' }],
  antecedents: 'Apendicectomía en 2010',
};

let patientCounter = 0;
/** A registered patient who is assigned to the treating professional. */
async function treatedPatient(): Promise<string> {
  patientCounter += 1;
  const response = await api.post('/patients', reception, {
    familyName: `Anamnesis${String(patientCounter)}`,
    givenNames: 'Paciente',
    birthDate: '1970-01-01',
    dataProcessingConsent: true,
  });
  const id = response.json<CreatePatientResponse>().patient.id;
  await asTenant(runtime, tenant.id, (tx) =>
    tx.insert(careAssignment).values({
      tenantId: tenant.id,
      patientId: id,
      professionalId: treatingId,
      assignedBy: owner.user.id,
    }),
  );
  return id;
}

const save = (id: string, by: TestSession, content: AnamnesisContent, expectedVersion?: number) =>
  api.put(`/patients/${id}/anamnesis`, by, {
    content,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
const read = (id: string, by: TestSession) => api.get(`/patients/${id}/anamnesis`, by);

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

const flagsOf = async (id: string) => {
  const [row] = await asTenant(runtime, tenant.id, (tx) =>
    tx.select({ flags: patient.safetyFlags }).from(patient).where(eq(patient.id, id)),
  );
  return row?.flags;
};

describe('a treating professional records the anamnesis', () => {
  it('saves a version, reads it back, and keeps every version', async () => {
    const id = await treatedPatient();

    const first = await save(id, treating, PENICILLIN, 0);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ version: 1, authorProfessionalId: treatingId });
    const second = await save(id, treating, { ...PENICILLIN, antecedents: 'Nuevo antecedente' }, 1);
    expect(second.json()).toMatchObject({ version: 2 });

    const current = (await read(id, treating)).json<AnamnesisResponse>().current;
    expect(current).toMatchObject({ version: 2, content: { antecedents: 'Nuevo antecedente' } });
    const stored = await createWithTenant(runtime.db)(
      { tenantId: tenant.id, userId: treating.user.id, actingProfessionalId: treatingId },
      (tx) =>
        tx
          .select({ version: anamnesis.version })
          .from(anamnesis)
          .where(eq(anamnesis.patientId, id)),
    );
    expect(stored.map((row) => row.version).sort()).toEqual([1, 2]);
  });

  it('stores the content encrypted: the database never holds the words', async () => {
    const id = await treatedPatient();
    await save(id, treating, PENICILLIN);

    const rows = await createWithTenant(runtime.db)(
      { tenantId: tenant.id, userId: treating.user.id, actingProfessionalId: treatingId },
      (tx) =>
        tx
          .select({ blob: anamnesis.contentEnc })
          .from(anamnesis)
          .where(eq(anamnesis.patientId, id)),
    );

    const blob = rows[0]?.blob.toString('latin1') ?? '';
    expect(blob.length).toBeGreaterThan(20);
    expect(blob).not.toContain('Penicilina');
    expect(blob).not.toContain('Apendicectom');
  });

  it('says nothing is recorded yet to the professional who treats a new patient', async () => {
    const id = await treatedPatient();

    const response = await read(id, treating);

    expect(response.statusCode).toBe(200);
    expect(response.json<AnamnesisResponse>()).toEqual({ current: null });
  });

  it('refuses a stale save, so two sessions do not overwrite each other', async () => {
    const id = await treatedPatient();
    await save(id, treating, PENICILLIN, 0);

    const stale = await save(id, treating, EMPTY_ANAMNESIS, 0);

    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('stale_revision');
  });

  it('rejects content that does not fit the structure', async () => {
    const id = await treatedPatient();

    for (const content of [
      { ...PENICILLIN, allergies: [{ substance: '' }] },
      { ...PENICILLIN, unknownField: 1 },
      { ...PENICILLIN, indicators: { pregnant: 'yes' } },
      { ...PENICILLIN, antecedents: 'x'.repeat(4001) },
    ]) {
      expect((await api.put(`/patients/${id}/anamnesis`, treating, { content })).statusCode).toBe(
        400,
      );
    }
  });

  it('audits the read and the write by patient and version, never by content', async () => {
    const id = await treatedPatient();
    await save(id, treating, PENICILLIN);
    await read(id, treating);

    const [written] = await auditRows(id, 'clinical.anamnesis.updated');
    const [seen] = await auditRows(id, 'clinical.anamnesis.read');

    expect(written).toMatchObject({
      outcome: 'allow',
      actorUserId: treating.user.id,
      metadata: { version: 1 },
    });
    expect(seen).toMatchObject({ outcome: 'allow', actorUserId: treating.user.id });
    expect(JSON.stringify([written, seen])).not.toMatch(/Penicilina|Apendicect|urticaria/);
  });
});

describe('everyone else is refused', () => {
  it.each([
    ['reception', () => reception],
    ['an owner', () => owner],
    ['an admin', () => admin],
  ])(
    '%s: 403 on read and write, with the same uniform body and a deny audit row',
    async (_name, who) => {
      const id = await treatedPatient();
      await save(id, treating, PENICILLIN);
      const session = who();

      const get = await read(id, session);
      const put = await save(id, session, EMPTY_ANAMNESIS);

      expect(get.statusCode).toBe(403);
      expect(put.statusCode).toBe(403);
      expect(get.body).not.toContain('Penicilina');
      expect(get.json()).toMatchObject({ code: 'forbidden', status: 403 });
      const denials = await asTenant(runtime, tenant.id, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.action, 'access.denied'),
              eq(auditEvent.actorUserId, session.user.id),
            ),
          ),
      );
      expect(denials.length).toBeGreaterThanOrEqual(2);
      expect(await auditRows(id, 'clinical.anamnesis.updated')).toHaveLength(1);
    },
  );

  it('refuses a professional with no valid profile at the gate', async () => {
    const id = await treatedPatient();

    expect((await read(id, noProfile)).statusCode).toBe(403);
    expect((await save(id, noProfile, EMPTY_ANAMNESIS)).statusCode).toBe(403);
  });

  it('refuses a professional who does not treat the patient, on read and write, and audits it', async () => {
    const id = await treatedPatient();
    await save(id, treating, PENICILLIN);

    const get = await read(id, colleague);
    const put = await save(id, colleague, EMPTY_ANAMNESIS);

    expect(get.statusCode).toBe(403);
    expect(put.statusCode).toBe(403);
    const rows = await auditRows(id, 'access.denied');
    expect(rows.map((row) => row.reason).sort()).toEqual([
      'anamnesis_not_readable',
      'anamnesis_not_treating',
    ]);
    expect(await auditRows(id, 'clinical.anamnesis.updated')).toHaveLength(1);
  });

  it('answers 404 for an unknown patient and for one of another organization', async () => {
    const elsewhere = await member(['reception'], other);
    const there = await clientFor(app, 'anamnesis-api-b').post('/patients', elsewhere.session, {
      familyName: 'Ajena',
      givenNames: 'Paciente',
      birthDate: '1990-01-01',
      dataProcessingConsent: true,
    });
    const foreignId = there.json<CreatePatientResponse>().patient.id;

    expect((await read(foreignId, treating)).statusCode).toBe(404);
    expect((await read('0190a000-0000-7000-8000-0000000000ff', treating)).statusCode).toBe(404);
  });
});

describe('sharing lets other professionals read, never write', () => {
  async function setSharing(on: boolean) {
    await asTenant(runtime, tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ settings: on ? { clinicalSharing: true, sharedTemplates: ['general'] } : {} })
        .where(eq(tenantTable.id, tenant.id)),
    );
  }

  it('shows a non-treating professional the anamnesis as a shared read, audited as such', async () => {
    const id = await treatedPatient();
    await save(id, treating, PENICILLIN);
    await setSharing(true);
    try {
      const get = await read(id, colleague);
      const put = await save(id, colleague, EMPTY_ANAMNESIS);

      expect(get.statusCode).toBe(200);
      expect(get.json<AnamnesisResponse>().current?.content.allergies[0]?.substance).toBe(
        'Penicilina',
      );
      expect(put.statusCode).toBe(403);
      const [seen] = await auditRows(id, 'clinical.anamnesis.read');
      expect(seen).toMatchObject({ reason: 'shared', actorUserId: colleague.user.id });
    } finally {
      await setSharing(false);
    }
    expect((await read(id, colleague)).statusCode).toBe(403);
  });
});

describe('the safety flag follows the anamnesis', () => {
  it('appears for reception as a flag and nothing more, and disappears when the allergy is removed', async () => {
    const id = await treatedPatient();
    expect((await api.get(`/patients/${id}`, reception)).json<PatientDto>().hasSafetyFlag).toBe(
      false,
    );

    await save(id, treating, PENICILLIN, 0);

    const seenByReception = await api.get(`/patients/${id}`, reception);
    expect(seenByReception.json<PatientDto>().hasSafetyFlag).toBe(true);
    expect(seenByReception.body).not.toMatch(/Penicilina|allergy|alergia|urticaria/i);
    expect(await flagsOf(id)).toEqual(['allergy_on_file']);

    await save(id, treating, { ...PENICILLIN, allergies: [] }, 1);

    expect((await api.get(`/patients/${id}`, reception)).json<PatientDto>().hasSafetyFlag).toBe(
      false,
    );
    expect(await flagsOf(id)).toEqual([]);
  });

  it('raises the other codes from the indicators and the medications', async () => {
    const id = await treatedPatient();

    await save(id, treating, {
      ...EMPTY_ANAMNESIS,
      medications: [{ name: 'Acenocumarol', anticoagulant: true }],
      indicators: { pregnant: true, implantedDevice: true, anticoagulated: false },
    });

    expect(await flagsOf(id)).toEqual(['anticoagulant_on_file', 'implanted_device', 'pregnancy']);
  });

  it('cannot be set or cleared through the patient routes', async () => {
    const id = await treatedPatient();
    await save(id, treating, PENICILLIN);

    for (const session of [reception, owner, treating]) {
      const response = await api.patch(`/patients/${id}`, session, {
        safetyFlags: [],
        hasSafetyFlag: false,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await flagsOf(id)).toEqual(['allergy_on_file']);
  });
});
