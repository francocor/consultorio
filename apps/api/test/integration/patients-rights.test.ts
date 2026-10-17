import type {
  AuditAction,
  CreatePatientResponse,
  FulfillRightsResponse,
  PatientDto,
  PatientHistoryResponse,
  RightsRequestDto,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
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
  tenant = await createTestTenant(runtime, { slug: 'patients-rights' });
  other = await createTestTenant(runtime, { slug: 'patients-rights-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'patients-rights');
  const make = (roles: ('reception' | 'professional')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  reception = await signInAs(app, 'patients-rights', await make(['reception']));
  doctor = await signInAs(app, 'patients-rights', await make(['professional']));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

let counter = 0;
async function patientId(extra: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const response = await api.post('/patients', reception, {
    familyName: `Derechos${String(counter)}`,
    givenNames: 'Paciente',
    birthDate: '1982-04-04',
    dataProcessingConsent: true,
    address: 'Calle equivocada 1',
    ...extra,
  });
  return response.json<CreatePatientResponse>().patient.id;
}

const open = async (id: string, kind: 'access' | 'rectification', by: TestSession = reception) =>
  api.post(`/patients/${id}/rights-requests`, by, { kind, note: 'Pedido en mostrador' });

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

describe('logging a request', () => {
  it('records an access or rectification request, open, and audits who logged it', async () => {
    const id = await patientId();

    const response = await open(id, 'access');

    expect(response.statusCode).toBe(201);
    expect(response.json<RightsRequestDto>()).toMatchObject({
      kind: 'access',
      status: 'open',
      requestedBy: reception.user.id,
      note: 'Pedido en mostrador',
      fulfilledAt: null,
    });
    const [row] = await auditRows(id, 'patient.rights_request.created');
    expect(row).toMatchObject({ outcome: 'allow', metadata: { kind: 'access' } });
    const list = await api.get(`/patients/${id}/rights-requests`, reception);
    expect(list.json<{ requests: RightsRequestDto[] }>().requests).toHaveLength(1);
  });

  it('refuses another kind, such as deletion, which the product does not offer', async () => {
    const id = await patientId();

    expect(
      (await api.post(`/patients/${id}/rights-requests`, reception, { kind: 'deletion' }))
        .statusCode,
    ).toBe(400);
  });

  it("answers 404 for another organization's patient", async () => {
    const id = await patientId();
    const elsewhere = await signInAs(
      app,
      'patients-rights-b',
      await createTestUser(runtime, other.id, { roles: ['reception'], password: TEST_PASSWORD }),
    );

    const response = await clientFor(app, 'patients-rights-b').post(
      `/patients/${id}/rights-requests`,
      elsewhere,
      {
        kind: 'access',
      },
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('fulfilling an access request', () => {
  it('produces the patient data in a readable form, without any clinical content, and audits it', async () => {
    const id = await patientId({ phone: '11 4000-1111' });
    await api.patch(`/patients/${id}`, reception, { phone: '11 4000-2222' });
    const request = (await open(id, 'access')).json<RightsRequestDto>();

    const response = await api.post(
      `/patients/${id}/rights-requests/${request.id}/fulfill`,
      doctor,
      {},
    );

    expect(response.statusCode).toBe(200);
    const result = response.json<FulfillRightsResponse>();
    expect(result.request).toMatchObject({ status: 'fulfilled', fulfilledBy: doctor.user.id });
    expect(result.copy).toMatchObject({
      patient: { id, phone: '11 4000-2222' },
      consent: { status: 'granted' },
      clinicalCopy: 'requires_professional',
    });
    expect(result.copy?.history.map((version) => version.version)).toEqual([1, 2]);
    expect(Object.keys(result.copy ?? {})).not.toContain('anamnesis');
    expect(JSON.stringify(result.copy)).not.toMatch(/anamnesis|diagnos/i);
    const [row] = await auditRows(id, 'patient.rights_request.fulfilled');
    expect(row).toMatchObject({ outcome: 'allow', metadata: { kind: 'access' } });
  });

  it('refuses a body with changes on an access request, and a second fulfilment', async () => {
    const id = await patientId();
    const request = (await open(id, 'access')).json<RightsRequestDto>();
    const url = `/patients/${id}/rights-requests/${request.id}/fulfill`;

    expect((await api.post(url, reception, { changes: { phone: '1' } })).statusCode).toBe(400);
    expect((await api.post(url, reception, {})).statusCode).toBe(200);
    expect((await api.post(url, reception, {})).statusCode).toBe(409);
  });
});

describe('fulfilling a rectification request', () => {
  it('goes through the versioned update: the previous value stays in the history', async () => {
    const id = await patientId();
    const request = (await open(id, 'rectification')).json<RightsRequestDto>();

    const response = await api.post(
      `/patients/${id}/rights-requests/${request.id}/fulfill`,
      reception,
      {
        changes: { address: 'Calle correcta 99' },
      },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<FulfillRightsResponse>()).toMatchObject({
      request: { status: 'fulfilled' },
      copy: null,
    });
    const patient = (await api.get(`/patients/${id}`, reception)).json<PatientDto>();
    expect(patient).toMatchObject({ address: 'Calle correcta 99', version: 2 });
    const history = (
      await api.get(`/patients/${id}/history`, reception)
    ).json<PatientHistoryResponse>();
    expect(history.versions[0]?.snapshot['address']).toBe('Calle equivocada 1');
    expect(history.versions[1]?.snapshot['address']).toBe('Calle correcta 99');
    expect(history.versions[1]?.changedFields).toEqual(['address']);
  });

  it('needs the changes, and does not close the request when the change is refused', async () => {
    const id = await patientId();
    const request = (await open(id, 'rectification')).json<RightsRequestDto>();
    const url = `/patients/${id}/rights-requests/${request.id}/fulfill`;

    expect((await api.post(url, reception, {})).statusCode).toBe(400);
    // A professional who does not treat the patient cannot rectify through the update either.
    expect((await api.post(url, doctor, { changes: { address: 'Otra calle 5' } })).statusCode).toBe(
      403,
    );
    const list = (await api.get(`/patients/${id}/rights-requests`, reception)).json<{
      requests: RightsRequestDto[];
    }>();
    expect(list.requests[0]?.status).toBe('open');
  });
});

describe('requests in a read-only organization (patient-protective)', () => {
  it('can be logged and fulfilled, while an ordinary edit is refused', async () => {
    const id = await patientId();
    const pending = (await open(id, 'rectification')).json<RightsRequestDto>();
    await asTenant(runtime, tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, tenant.id)),
    );
    try {
      const logged = await open(id, 'access');
      const fulfilled = await api.post(
        `/patients/${id}/rights-requests/${pending.id}/fulfill`,
        reception,
        {
          changes: { address: 'Calle correcta 100' },
        },
      );
      const ordinary = await api.patch(`/patients/${id}`, reception, { phone: '11 0000-0000' });

      expect(logged.statusCode).toBe(201);
      expect(fulfilled.statusCode).toBe(200);
      expect(ordinary.statusCode).toBe(402);
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
