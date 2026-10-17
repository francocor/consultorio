import {
  EMPTY_ANAMNESIS,
  type AuditEventDto,
  type AuditListResponse,
  type CreatePatientResponse,
} from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { sealTenant } from '../../src/platform/audit/sealer.js';
import { createRuntimeDb, createSealerDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let sealer: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let owner: TestSession;
let admin: TestSession;
let reception: TestSession;
let doctor: TestSession;
let doctorProfessionalId: string;
let counter = 95_000;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  sealer = createSealerDb(inject('sealerUrl'));
  tenant = await createTestTenant(runtime, { slug: 'audit-viewer' });
  other = await createTestTenant(runtime, { slug: 'audit-viewer-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'audit-viewer');
  const make = async (roles: ('owner' | 'admin' | 'reception' | 'professional')[]) => {
    const user = await createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
    return signInAs(app, 'audit-viewer', user);
  };
  owner = await make(['owner']);
  admin = await make(['admin']);
  reception = await make(['reception']);
  doctor = await make(['professional']);
  counter += 1;
  const profile = await api.put(`/staff/${doctor.user.membershipId}/professional-profile`, doctor, {
    fullName: 'Dra. Auditada',
    specialties: ['Medicina general'],
    matricula: { jurisdiction: 'AR-B', number: String(counter) },
  });
  doctorProfessionalId = profile.json<{ id: string }>().id;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
  await sealer.close();
});

let patientCounter = 0;
async function registered(): Promise<string> {
  patientCounter += 1;
  const response = await api.post('/patients', reception, {
    familyName: `Auditado${String(patientCounter)}`,
    givenNames: 'Paciente',
    birthDate: '1990-01-01',
    dataProcessingConsent: true,
  });
  return response.json<CreatePatientResponse>().patient.id;
}

const events = async (query: string, by: TestSession = owner) => {
  const response = await api.get(`/audit-events${query}`, by);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AuditListResponse>();
};

describe('GET /audit-events', () => {
  it('lists the newest first, with who did what, and marks entries not yet sealed', async () => {
    const id = await registered();
    await api.patch(`/patients/${id}`, reception, { phone: '11 5555-0000' });

    const page = await events(`?patientId=${id}`);

    expect(page.events.map((event) => event.action)).toEqual([
      'patient.updated',
      'patient.consent.recorded',
      'patient.created',
    ]);
    expect(page.events[0]).toMatchObject({
      actorUserId: reception.user.id,
      actingRole: 'reception',
      resourceType: 'patient',
      patientId: id,
      outcome: 'allow',
      sealed: false,
    });
    const times = page.events.map((event) => event.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('marks an entry sealed once the sealer has chained it', async () => {
    const sealed = await createTestTenant(runtime, { slug: 'audit-viewer-seal' });
    const owner2 = await signInAs(
      app,
      'audit-viewer-seal',
      await createTestUser(runtime, sealed.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const sealedApi = clientFor(app, 'audit-viewer-seal');
    await sealedApi.patch('/settings', owner2, { require2fa: true });

    const before = (
      await sealedApi.get('/audit-events?action=setting.changed', owner2)
    ).json<AuditListResponse>();
    await asTenant(sealer, sealed.id, (tx) => sealTenant(tx, { graceMs: 0 }));
    const after = (
      await sealedApi.get('/audit-events?action=setting.changed', owner2)
    ).json<AuditListResponse>();

    expect(before.events[0]?.sealed).toBe(false);
    expect(after.events[0]?.sealed).toBe(true);
  });

  it('filters by action, outcome, actor, resource and period', async () => {
    const id = await registered();
    await api.get(`/patients/${id}`, doctor);
    await api.get('/settings', reception);

    const reads = await events(`?action=patient.read&patientId=${id}`);
    const denials = await events('?outcome=deny');
    const byActor = await events(`?actorUserId=${doctor.user.id}&patientId=${id}`);
    const byResource = await events(`?resourceType=patient&resourceId=${id}`);
    const future = await events(`?from=${encodeURIComponent('2999-01-01T00:00:00Z')}`);
    const past = await events(`?to=${encodeURIComponent('2000-01-01T00:00:00Z')}`);

    expect(reads.events.map((event) => event.actorUserId)).toEqual([doctor.user.id]);
    expect(denials.events.length).toBeGreaterThan(0);
    expect(denials.events.every((event) => event.outcome === 'deny')).toBe(true);
    expect(byActor.events.map((event) => event.action)).toEqual(['patient.read']);
    expect(byResource.events.length).toBeGreaterThanOrEqual(2);
    expect(future.events).toEqual([]);
    expect(past.events).toEqual([]);
  });

  it('shows the display name of the actor', async () => {
    const id = await registered();
    await api.get(`/patients/${id}`, doctor);

    const [read] = (await events(`?action=patient.read&patientId=${id}`)).events;

    expect(read?.actorName).toBe('Dra. Auditada');
  });

  it('pages with a cursor, in a stable order, without repeating or skipping an entry', async () => {
    const paged = await createTestTenant(runtime, { slug: 'audit-viewer-pages' });
    const ownerSession = await signInAs(
      app,
      'audit-viewer-pages',
      await createTestUser(runtime, paged.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const pagedApi = clientFor(app, 'audit-viewer-pages');
    for (let index = 0; index < 7; index += 1) {
      await pagedApi.patch('/settings', ownerSession, { require2fa: index % 2 === 0 });
    }
    const total = (
      await pagedApi.get('/audit-events?limit=200&action=setting.changed', ownerSession)
    ).json<AuditListResponse>().events;

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await pagedApi.get(
        `/audit-events?limit=3&action=setting.changed${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ownerSession,
      );
      const page: AuditListResponse = response.json<AuditListResponse>();
      seen.push(...page.events.map((event) => event.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    expect(total.length).toBeGreaterThanOrEqual(6);
    expect(seen).toEqual(total.map((event) => event.id));
  });

  it('refuses a malformed query: unknown action, bad date, bad cursor, limit out of range', async () => {
    for (const query of [
      '?action=made.up',
      '?from=yesterday',
      '?cursor=zzz',
      '?limit=0',
      '?limit=500',
      '?tenantId=x',
    ]) {
      expect((await api.get(`/audit-events${query}`, owner)).statusCode, query).toBe(400);
    }
  });

  it('is for owners and admins only', async () => {
    expect((await api.get('/audit-events', admin)).statusCode).toBe(200);
    expect((await api.get('/audit-events', reception)).statusCode).toBe(403);
    expect((await api.get('/audit-events', doctor)).statusCode).toBe(403);
    expect((await api.get('/audit-events', null)).statusCode).toBe(401);
  });

  it('shows each organization only its own trail', async () => {
    const elsewhere = await signInAs(
      app,
      'audit-viewer-b',
      await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const otherApi = clientFor(app, 'audit-viewer-b');
    await otherApi.patch('/settings', elsewhere, { require2fa: true });
    const id = await registered();

    const theirs = (
      await otherApi.get('/audit-events?limit=200', elsewhere)
    ).json<AuditListResponse>();
    const ours = await events('?limit=200');

    expect(theirs.events.some((event) => event.patientId === id)).toBe(false);
    expect(ours.events.some((event) => event.actorUserId === elsewhere.user.id)).toBe(false);
    expect(
      theirs.events.every(
        (event) => event.actorUserId === elsewhere.user.id || event.actorUserId === null,
      ),
    ).toBe(true);
  });

  it('shows the activity around clinical records but never their content', async () => {
    const id = await registered();
    await api.post(`/patients/${id}/assignments`, reception, {
      professionalId: doctorProfessionalId,
    });
    await api.put(`/patients/${id}/anamnesis`, doctor, {
      content: {
        ...EMPTY_ANAMNESIS,
        allergies: [{ substance: 'Penicilina secreta' }],
        antecedents: 'Dato muy reservado',
      },
    });
    await api.get(`/patients/${id}/anamnesis`, doctor);

    const response = await api.get(`/audit-events?patientId=${id}&limit=200`, admin);

    const page = response.json<AuditListResponse>();
    expect(page.events.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'clinical.anamnesis.updated',
        'clinical.anamnesis.read',
        'assignment.created',
      ]),
    );
    expect(response.body).not.toMatch(/Penicilina|reservado/);
  });

  it('has a fixed shape: no user agent, no hashes, no tenant', async () => {
    const [event] = (await events('?limit=1')).events;

    expect(Object.keys(event ?? {}).sort()).toEqual(
      [
        'action',
        'actingRole',
        'actorName',
        'actorUserId',
        'id',
        'ip',
        'metadata',
        'occurredAt',
        'outcome',
        'patientId',
        'reason',
        'requestId',
        'resourceId',
        'resourceType',
        'sealed',
      ].sort(),
    );
  });
});

describe('GET /patients/:id/access-report', () => {
  it('lists every read and write for the patient in time order, and nothing about other patients', async () => {
    const id = await registered();
    const otherPatient = await registered();
    await api.get(`/patients/${id}`, doctor);
    await api.patch(`/patients/${id}`, reception, { phone: '11 7777-0000' });
    await api.get(`/patients/${otherPatient}`, doctor);

    const response = await api.get(`/patients/${id}/access-report`, owner);

    expect(response.statusCode).toBe(200);
    const report = response.json<AuditListResponse>();
    expect(report.events.map((event) => event.action)).toEqual([
      'patient.created',
      'patient.consent.recorded',
      'patient.read',
      'patient.updated',
    ]);
    expect(report.events.every((event) => event.patientId === id)).toBe(true);
    const times = report.events.map((event) => event.occurredAt);
    expect([...times].sort()).toEqual(times);
  });

  it('is for owners and admins, and 404 for a patient of another organization', async () => {
    const id = await registered();
    const elsewhere = await signInAs(
      app,
      'audit-viewer-b',
      await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );

    expect((await api.get(`/patients/${id}/access-report`, admin)).statusCode).toBe(200);
    expect((await api.get(`/patients/${id}/access-report`, doctor)).statusCode).toBe(403);
    expect(
      (await clientFor(app, 'audit-viewer-b').get(`/patients/${id}/access-report`, elsewhere))
        .statusCode,
    ).toBe(404);
  });
});

describe('GET /audit-events/export', () => {
  async function exportedRows(query: string, by: TestSession = owner) {
    return asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(
          and(eq(auditEvent.action, 'audit.exported'), eq(auditEvent.actorUserId, by.user.id)),
        ),
    ).then((rows) => ({ rows, query }));
  }

  it('streams a CSV of the filtered set, and the export itself is audited', async () => {
    const id = await registered();
    await api.get(`/patients/${id}`, doctor);

    const response = await api.get(`/audit-events/export?format=csv&patientId=${id}`, owner);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="audit-.*\.csv"/);
    expect(response.headers['cache-control']).toBe('no-store');
    const lines = response.body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'occurred_at,actor_user_id,actor_name,acting_role,action,resource_type,resource_id,patient_id,outcome,reason,ip,request_id,sealed,metadata',
    );
    // The export lists itself: its entry was written before the first byte.
    expect(lines.slice(1).map((line) => line.split(',')[4])).toEqual([
      'audit.exported',
      'patient.read',
      'patient.consent.recorded',
      'patient.created',
    ]);
    const { rows } = await exportedRows('csv');
    expect(rows.at(-1)).toMatchObject({ outcome: 'allow', metadata: { format: 'csv' } });
  });

  it('streams JSON too, with the same entries as the list', async () => {
    const id = await registered();

    const response = await api.get(`/audit-events/export?format=json&patientId=${id}`, admin);

    expect(response.headers['content-type']).toContain('application/json');
    const body = JSON.parse(response.body) as { events: AuditEventDto[] };
    const listed = await events(`?patientId=${id}`);
    expect(body.events.map((event) => event.id)).toEqual(listed.events.map((event) => event.id));
  });

  it('writes the audit entry before the first byte, so an export cannot happen unrecorded', async () => {
    const before = (await exportedRows('x', admin)).rows.length;

    await api.get('/audit-events/export?format=json', admin);

    expect((await exportedRows('x', admin)).rows.length).toBe(before + 1);
  });

  it('goes through every page of a large set, not only the first', async () => {
    const big = await createTestTenant(runtime, { slug: 'audit-viewer-big' });
    const bigOwner = await signInAs(
      app,
      'audit-viewer-big',
      await createTestUser(runtime, big.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    await asTenant(runtime, big.id, (tx) =>
      // 1,200 events written the way the audit writer would, in one statement.
      tx.execute(
        sql`insert into audit_event (tenant_id, action, outcome, actor_user_id)
              select ${big.id}::uuid, 'access.denied', 'deny', ${bigOwner.user.id}::uuid
                from generate_series(1, 1200)`,
      ),
    );

    const response = await clientFor(app, 'audit-viewer-big').get(
      '/audit-events/export?format=csv&action=access.denied',
      bigOwner,
    );

    expect(response.body.trim().split('\r\n')).toHaveLength(1201);
  });

  it('keeps a spreadsheet from running a cell as a formula', async () => {
    // The reason of a denial can carry text a caller chose; here an entry whose reason starts with "=".
    const injected = await createTestTenant(runtime, { slug: 'audit-viewer-csv' });
    const injectedOwner = await signInAs(
      app,
      'audit-viewer-csv',
      await createTestUser(runtime, injected.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    await asTenant(runtime, injected.id, (tx) =>
      tx.execute(
        sql`insert into audit_event (tenant_id, action, outcome, reason)
              values (${injected.id}::uuid, 'access.denied', 'deny', '=HYPERLINK("http://evil.example","x")')`,
      ),
    );

    const response = await clientFor(app, 'audit-viewer-csv').get(
      '/audit-events/export?format=csv&action=access.denied',
      injectedOwner,
    );

    expect(response.body).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(response.body).not.toMatch(/,=HYPERLINK/);
  });

  it('is for owners and admins, and rejects an unknown format', async () => {
    expect((await api.get('/audit-events/export', reception)).statusCode).toBe(403);
    expect((await api.get('/audit-events/export', doctor)).statusCode).toBe(403);
    expect((await api.get('/audit-events/export?format=xml', owner)).statusCode).toBe(400);
  });
});
