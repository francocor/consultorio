import type {
  AuditAction,
  CreatePatientResponse,
  PatientDto,
  RepresentativeListResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { patientRepresentative } from '../../src/db/schema/patients.js';
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

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'patients-minors' });
  other = await createTestTenant(runtime, { slug: 'patients-minors-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'patients-minors');
  reception = await signInAs(
    app,
    'patients-minors',
    await createTestUser(runtime, tenant.id, { roles: ['reception'], password: TEST_PASSWORD }),
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

/** A birth date this many years (and days) before today. */
function bornYearsAgo(years: number, extraDays = 0): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  date.setUTCDate(date.getUTCDate() - extraDays);
  return date.toISOString().slice(0, 10);
}

const MOTHER = { fullName: 'Rosa Gómez', relation: 'mother', phone: '11 4444-5555' };

const register = (body: Record<string, unknown>, by: TestSession = reception) =>
  api.post('/patients', by, {
    familyName: 'Gómez',
    givenNames: 'Tomás',
    dataProcessingConsent: true,
    ...body,
  });

async function auditRows(
  patientId: string,
  action: AuditAction = 'patient.representative.changed',
) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.patientId === patientId);
}

describe('registering a minor', () => {
  it('needs a representative, and says so with a translated field error', async () => {
    const response = await register({ birthDate: bornYearsAgo(8) });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'representative', i18nKey: 'patients.minor_needs_representative' },
    ]);
  });

  it('stores the representative as an administrative contact and computes the review date', async () => {
    const birthDate = '2015-09-30';

    const response = await register({ birthDate, representative: MOTHER });

    expect(response.statusCode).toBe(201);
    const id = response.json<CreatePatientResponse>().patient.id;
    const list = (
      await api.get(`/patients/${id}/representatives`, reception)
    ).json<RepresentativeListResponse>();
    expect(list.minor).toBe(true);
    expect(list.representatives).toEqual([
      expect.objectContaining({
        fullName: 'Rosa Gómez',
        relation: 'mother',
        phone: '11 4444-5555',
        email: null,
        // Age of majority 18 from the country pack of the organization.
        majorityReviewOn: '2033-09-30',
      }),
    ]);
    expect((await auditRows(id))[0]).toMatchObject({
      metadata: { change: 'added', relation: 'mother' },
    });
  });

  it('does not ask an adult for one, and treats the day of the 18th birthday as adult', async () => {
    const adult = await register({ birthDate: bornYearsAgo(40) });
    const justAdult = await register({ birthDate: bornYearsAgo(18) });
    const dayBefore = await register({ birthDate: bornYearsAgo(18, -1), representative: MOTHER });

    expect(adult.statusCode).toBe(201);
    expect(justAdult.statusCode).toBe(201);
    expect(dayBefore.statusCode).toBe(201);
  });

  it('refuses a representative with no way to reach them', async () => {
    const response = await register({
      birthDate: bornYearsAgo(5),
      representative: { fullName: 'Rosa', relation: 'mother' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('representatives of an existing patient', () => {
  async function minor() {
    const response = await register({ birthDate: bornYearsAgo(6), representative: MOTHER });
    return response.json<CreatePatientResponse>().patient;
  }

  it('adds a second representative and ends one, never deleting the row', async () => {
    const child = await minor();

    const added = await api.post(`/patients/${child.id}/representatives`, reception, {
      fullName: 'Carlos Gómez',
      relation: 'father',
      email: 'carlos@example.test',
    });
    expect(added.statusCode).toBe(201);
    const fatherId = added.json<{ id: string }>().id;
    const both = (
      await api.get(`/patients/${child.id}/representatives`, reception)
    ).json<RepresentativeListResponse>();
    expect(both.representatives).toHaveLength(2);

    const ended = await api.delete(`/patients/${child.id}/representatives/${fatherId}`, reception);

    expect(ended.statusCode).toBe(204);
    const left = (
      await api.get(`/patients/${child.id}/representatives`, reception)
    ).json<RepresentativeListResponse>();
    expect(left.representatives.map((entry) => entry.fullName)).toEqual(['Rosa Gómez']);
    const rows = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(patientRepresentative).where(eq(patientRepresentative.patientId, child.id)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === fatherId)?.endedAt).toBeInstanceOf(Date);
    expect((await auditRows(child.id)).map((row) => row.metadata['change'])).toEqual([
      'ended',
      'added',
      'added',
    ]);
  });

  it('keeps at least one representative for a minor', async () => {
    const child = await minor();
    const [only] = (
      await api.get(`/patients/${child.id}/representatives`, reception)
    ).json<RepresentativeListResponse>().representatives;

    const response = await api.delete(
      `/patients/${child.id}/representatives/${only?.id ?? ''}`,
      reception,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'representative', i18nKey: 'patients.minor_needs_representative' },
    ]);
  });

  it('lets an adult have none', async () => {
    const adult = (
      await register({ birthDate: bornYearsAgo(30), representative: MOTHER })
    ).json<CreatePatientResponse>().patient;
    const [only] = (
      await api.get(`/patients/${adult.id}/representatives`, reception)
    ).json<RepresentativeListResponse>().representatives;

    const response = await api.delete(
      `/patients/${adult.id}/representatives/${only?.id ?? ''}`,
      reception,
    );

    expect(response.statusCode).toBe(204);
    expect(
      (
        await api.get(`/patients/${adult.id}/representatives`, reception)
      ).json<RepresentativeListResponse>(),
    ).toMatchObject({ minor: false, representatives: [] });
  });

  it('recomputes the review date when the birth date is corrected, and the minor flag with it', async () => {
    const child = await minor();

    await api.patch(`/patients/${child.id}`, reception, { birthDate: '2001-01-15' });

    const list = (
      await api.get(`/patients/${child.id}/representatives`, reception)
    ).json<RepresentativeListResponse>();
    expect(list.minor).toBe(false);
    expect(list.representatives[0]?.majorityReviewOn).toBe('2019-01-15');
  });

  it('refuses to make a patient a minor again without a representative', async () => {
    const adult = (await register({ birthDate: bornYearsAgo(30) })).json<CreatePatientResponse>()
      .patient;

    const response = await api.patch(`/patients/${adult.id}`, reception, {
      birthDate: bornYearsAgo(3),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'representative', i18nKey: 'patients.minor_needs_representative' },
    ]);
    expect((await api.get(`/patients/${adult.id}`, reception)).json<PatientDto>().birthDate).toBe(
      bornYearsAgo(30),
    );
  });

  it('gives the representative no access: it is a contact, and no route shows it with the patient', async () => {
    const child = await minor();

    const patientBody = (await api.get(`/patients/${child.id}`, reception)).body;
    const searchBody = (await api.get('/patients?q=gomez', reception)).body;

    expect(patientBody).not.toContain('Rosa');
    expect(searchBody).not.toContain('Rosa');
  });

  it("answers 404 for another organization's patient and representative", async () => {
    const child = await minor();
    const elsewhere = await signInAs(
      app,
      'patients-minors-b',
      await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const otherApi = clientFor(app, 'patients-minors-b');

    expect(
      (await otherApi.get(`/patients/${child.id}/representatives`, elsewhere)).statusCode,
    ).toBe(404);
    expect(
      (await otherApi.post(`/patients/${child.id}/representatives`, elsewhere, MOTHER)).statusCode,
    ).toBe(404);
  });
});
