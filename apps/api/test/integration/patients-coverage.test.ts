import type {
  AuditAction,
  CoverageDto,
  CoverageListResponse,
  CreatePatientResponse,
  PayerCatalogResponse,
  PayerPlanDto,
  PayerPlanListResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { patientCoverage } from '../../src/db/schema/coverage.js';
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
let obraSocialId: string;
let particularId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  const upsert = async (code: string, name: string, kind: string) =>
    (
      await owner.query<{ id: string }>(
        `insert into payer (country, code, name, kind) values ('AR', $1, $2, $3)
         on conflict (country, code) do update set name = excluded.name returning id`,
        [code, name, kind],
      )
    ).rows[0]?.id ?? '';
  obraSocialId = await upsert('coverage-api-os', 'Obra Social Test', 'obra_social');
  particularId = await upsert('coverage-api-particular', 'Particular', 'private');
  await owner.end();

  tenant = await createTestTenant(runtime, { slug: 'patients-coverage' });
  other = await createTestTenant(runtime, { slug: 'patients-coverage-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'patients-coverage');
  const make = (roles: ('reception' | 'professional')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  reception = await signInAs(app, 'patients-coverage', await make(['reception']));
  doctor = await signInAs(app, 'patients-coverage', await make(['professional']));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

let counter = 0;
async function patientId(): Promise<string> {
  counter += 1;
  const response = await api.post('/patients', reception, {
    familyName: `Cobertura${String(counter)}`,
    givenNames: 'Paciente',
    birthDate: '1980-02-02',
    dataProcessingConsent: true,
  });
  return response.json<CreatePatientResponse>().patient.id;
}

async function enable(
  body: Record<string, unknown>,
  by: TestSession = reception,
): Promise<PayerPlanDto> {
  const response = await api.post('/payer-plans', by, body);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<PayerPlanDto>();
}

const coveragesOf = async (id: string) =>
  (await api.get(`/patients/${id}/coverages`, reception)).json<CoverageListResponse>();

async function auditRows(patient: string, action: AuditAction = 'patient.coverage.changed') {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.patientId === patient);
}

describe('payers and plans of an organization', () => {
  it('offers the platform catalog, including Particular', async () => {
    const response = await api.get('/payer-catalog', reception);

    expect(response.statusCode).toBe(200);
    const payers = response.json<PayerCatalogResponse>().payers;
    expect(payers.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['Obra Social Test', 'Particular']),
    );
    expect(payers.find((entry) => entry.name === 'Particular')?.kind).toBe('private');
  });

  it('enables a catalog payer, with or without a plan, and adds a custom entry', async () => {
    const catalog = await enable({ payerId: obraSocialId, planName: 'Plan 310' });
    const custom = await enable({ customName: 'Mutual del Pueblo' });

    expect(catalog).toMatchObject({
      payerId: obraSocialId,
      name: 'Obra Social Test',
      kind: 'obra_social',
      planName: 'Plan 310',
      active: true,
    });
    expect(custom).toMatchObject({ payerId: null, name: 'Mutual del Pueblo', kind: 'custom' });
    const list = (await api.get('/payer-plans', reception)).json<PayerPlanListResponse>();
    expect(list.plans.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([catalog.id, custom.id]),
    );
  });

  it('refuses the same payer and plan twice, an unknown catalog payer, and both or neither source', async () => {
    await enable({ payerId: obraSocialId, planName: 'Plan único' });

    expect(
      (await api.post('/payer-plans', reception, { payerId: obraSocialId, planName: 'Plan único' }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await api.post('/payer-plans', reception, {
          payerId: '0190a000-0000-7000-8000-0000000000ee',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await api.post('/payer-plans', reception, { payerId: obraSocialId, customName: 'Ambas' }))
        .statusCode,
    ).toBe(400);
    expect((await api.post('/payer-plans', reception, {})).statusCode).toBe(400);
  });

  it('keeps custom entries to the organization that made them', async () => {
    await enable({ customName: 'Entrada privada' });
    const elsewhere = await signInAs(
      app,
      'patients-coverage-b',
      await createTestUser(runtime, other.id, { roles: ['reception'], password: TEST_PASSWORD }),
    );

    const list = (
      await clientFor(app, 'patients-coverage-b').get('/payer-plans', elsewhere)
    ).json<PayerPlanListResponse>();

    expect(list.plans.map((entry) => entry.name)).not.toContain('Entrada privada');
  });

  it('deactivates a plan without touching the coverages that use it, and reactivates it', async () => {
    const id = await patientId();
    const plan = await enable({ customName: 'Para desactivar' });
    await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: plan.id,
      memberNumber: '1',
    });

    const off = await api.post(`/payer-plans/${plan.id}/deactivate`, reception);

    expect(off.json<PayerPlanDto>().active).toBe(false);
    expect((await coveragesOf(id)).coverages).toHaveLength(1);
    const newPatient = await patientId();
    expect(
      (
        await api.post(`/patients/${newPatient}/coverages`, reception, {
          payerPlanId: plan.id,
          memberNumber: '2',
        })
      ).statusCode,
    ).toBe(409);
    await api.post(`/payer-plans/${plan.id}/reactivate`, reception);
    expect(
      (
        await api.post(`/patients/${newPatient}/coverages`, reception, {
          payerPlanId: plan.id,
          memberNumber: '2',
        })
      ).statusCode,
    ).toBe(201);
  });
});

describe('a patient coverage', () => {
  it('marks the first coverage primary and not the second, and audits each change', async () => {
    const id = await patientId();
    const first = await enable({ customName: `Primera ${String(counter)}` });
    const second = await enable({ customName: `Segunda ${String(counter)}` });

    const one = await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: first.id,
      memberNumber: 'A-1',
      validFrom: '2026-01-01',
    });
    const two = await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: second.id,
      memberNumber: 'B-2',
    });

    expect(one.statusCode).toBe(201);
    expect(one.json<CoverageDto>()).toMatchObject({
      primary: true,
      memberNumber: 'A-1',
      validFrom: '2026-01-01',
    });
    expect(two.json<CoverageDto>().primary).toBe(false);
    const rows = await auditRows(id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ metadata: { change: 'added', primary: false } });
    expect(JSON.stringify(rows)).not.toContain('A-1');
  });

  it('demotes the old primary when another one is made primary, keeping the old values', async () => {
    const id = await patientId();
    const first = await enable({ customName: `Vieja ${String(counter)}` });
    const second = await enable({ customName: `Nueva ${String(counter)}` });
    await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: first.id,
      memberNumber: 'OLD',
    });

    const made = await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: second.id,
      memberNumber: 'NEW',
      primary: true,
    });

    expect(made.statusCode).toBe(201);
    const list = await coveragesOf(id);
    expect(list.coverages.filter((entry) => entry.primary)).toHaveLength(1);
    expect(list.coverages.find((entry) => entry.primary)?.memberNumber).toBe('NEW');
    expect(list.defaultCoverageId).toBe(made.json<CoverageDto>().id);
    // The old primary row was ended and a copy took its place: nothing was overwritten.
    const stored = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(patientCoverage).where(eq(patientCoverage.patientId, id)),
    );
    expect(stored.filter((row) => row.endedAt !== null).map((row) => row.endReason)).toEqual([
      'replaced',
    ]);
    expect(stored.find((row) => row.endedAt !== null)?.isPrimary).toBe(true);
  });

  it('asks for a member number, except for Particular', async () => {
    const id = await patientId();
    const obra = await enable({ payerId: obraSocialId, planName: `Sin número ${String(counter)}` });
    const particular = await enable({ payerId: particularId });

    const missing = await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: obra.id,
    });
    const self = await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: particular.id,
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'memberNumber', i18nKey: 'patients.coverage.member_number_required' },
    ]);
    expect(self.statusCode).toBe(201);
    expect(self.json<CoverageDto>()).toMatchObject({ payerKind: 'private', memberNumber: null });
  });

  it('rejects an end date before the start date', async () => {
    const id = await patientId();
    const plan = await enable({ customName: `Fechas ${String(counter)}` });

    const response = await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: plan.id,
      memberNumber: '1',
      validFrom: '2026-06-01',
      validTo: '2026-05-31',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'validTo', i18nKey: 'patients.coverage.dates_invalid' },
    ]);
  });

  it('flags an expired coverage and never offers it as the default', async () => {
    const id = await patientId();
    const plan = await enable({ customName: `Vencida ${String(counter)}` });
    await api.post(`/patients/${id}/coverages`, reception, {
      payerPlanId: plan.id,
      memberNumber: '1',
      validFrom: '2020-01-01',
      validTo: '2021-01-01',
    });

    const list = await coveragesOf(id);

    expect(list.coverages[0]).toMatchObject({ primary: true, expired: true });
    expect(list.defaultCoverageId).toBeNull();
  });

  it('keeps the previous values when a coverage is edited', async () => {
    const id = await patientId();
    const plan = await enable({ customName: `Editable ${String(counter)}` });
    const created = (
      await api.post(`/patients/${id}/coverages`, reception, {
        payerPlanId: plan.id,
        memberNumber: 'ANTES',
      })
    ).json<CoverageDto>();

    const edited = await api.patch(`/patients/${id}/coverages/${created.id}`, reception, {
      memberNumber: 'DESPUES',
    });

    expect(edited.statusCode).toBe(200);
    expect(edited.json<CoverageDto>()).toMatchObject({ memberNumber: 'DESPUES', primary: true });
    expect((await coveragesOf(id)).coverages).toHaveLength(1);
    const stored = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(patientCoverage).where(eq(patientCoverage.patientId, id)),
    );
    expect(stored.map((row) => row.memberNumber).sort()).toEqual(['ANTES', 'DESPUES']);
    const [row] = await auditRows(id);
    expect(row).toMatchObject({ metadata: { change: 'updated', fields: ['memberNumber'] } });
    expect(JSON.stringify(row)).not.toContain('DESPUES');
  });

  it('removes a coverage from the patient without deleting it', async () => {
    const id = await patientId();
    const plan = await enable({ customName: `Quitar ${String(counter)}` });
    const created = (
      await api.post(`/patients/${id}/coverages`, reception, {
        payerPlanId: plan.id,
        memberNumber: '9',
      })
    ).json<CoverageDto>();

    const removed = await api.delete(`/patients/${id}/coverages/${created.id}`, reception);

    expect(removed.statusCode).toBe(204);
    expect((await coveragesOf(id)).coverages).toEqual([]);
    const stored = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(patientCoverage).where(eq(patientCoverage.patientId, id)),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.endReason).toBe('removed');
    expect((await auditRows(id))[0]).toMatchObject({ metadata: { change: 'removed' } });
  });

  it('is readable by any staff member, and writable by a professional only for patients they treat', async () => {
    const id = await patientId();
    const plan = await enable({ customName: `Permisos ${String(counter)}` });

    expect((await api.get(`/patients/${id}/coverages`, doctor)).statusCode).toBe(200);
    const stranger = await api.post(`/patients/${id}/coverages`, doctor, {
      payerPlanId: plan.id,
      memberNumber: '1',
    });

    expect(stranger.statusCode).toBe(403);
  });

  it("answers 404 for another organization's patient and plan", async () => {
    const id = await patientId();
    const elsewhere = await signInAs(
      app,
      'patients-coverage-b',
      await createTestUser(runtime, other.id, { roles: ['reception'], password: TEST_PASSWORD }),
    );
    const otherApi = clientFor(app, 'patients-coverage-b');
    const foreignPlan = (
      await otherApi.post('/payer-plans', elsewhere, { customName: 'Ajena' })
    ).json<PayerPlanDto>();

    expect((await otherApi.get(`/patients/${id}/coverages`, elsewhere)).statusCode).toBe(404);
    expect(
      (
        await api.post(`/patients/${id}/coverages`, reception, {
          payerPlanId: foreignPlan.id,
          memberNumber: '1',
        })
      ).statusCode,
    ).toBe(404);
  });
});
