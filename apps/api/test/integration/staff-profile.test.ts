import type { AuditAction, ProfessionalDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { membership } from '../../src/db/schema/identity.js';
import { professional } from '../../src/db/schema/staff.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let admin: pg.Client;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  tenant = await createTestTenant(runtime, { slug: 'staff-profile' });
  other = await createTestTenant(runtime, { slug: 'staff-profile-b' });
  // The real staff module provides the professional gate; one fixture route needs it.
  app = buildTestApplication(runtime, {
    modules: [
      (scope) => {
        scope.get(
          '/fixtures/clinical',
          { config: { readOnly: 'read', permission: 'clinical.note.read' } },
          () => ({ ok: true }),
        );
      },
    ],
  });
  api = clientFor(app, 'staff-profile');
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await admin.end();
  await runtime.close();
});

type RoleName = 'owner' | 'admin' | 'professional' | 'reception';

async function person(roles: RoleName[], t: TestTenant = tenant) {
  const user = await createTestUser(runtime, t.id, { roles, password: TEST_PASSWORD });
  return { user, session: await signInAs(app, t.slug, user) };
}

const profileUrl = (membershipId: string) => `/staff/${membershipId}/professional-profile`;

const REQUEST = {
  fullName: 'Ana Pérez',
  specialties: ['Medicina general', 'Nutrición'],
  matricula: { jurisdiction: 'AR-B', number: 'MP 12.345' },
};
let numberCounter = 40_000;
const freshNumber = () => String((numberCounter += 1));

async function save(
  target: { membershipId: string },
  by: TestSession,
  body: Record<string, unknown> = {},
) {
  return api.put(profileUrl(target.membershipId), by, {
    ...REQUEST,
    matricula: { jurisdiction: 'AR-B', number: freshNumber() },
    ...body,
  });
}

async function auditRows(action: AuditAction, resourceId?: string) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return resourceId === undefined ? rows : rows.filter((row) => row.resourceId === resourceId);
}

async function verifyAsOperator(professionalId: string) {
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL ROLE app_operator');
    await admin.query(`select set_config('app.tenant_id', $1, true)`, [tenant.id]);
    await admin.query(
      `update professional set matricula_status = 'verified', verified_by_operator = $1, verified_at = now() where id = $2`,
      [uuidv7(), professionalId],
    );
  } finally {
    await admin.query('COMMIT');
  }
}

describe('recording the professional profile', () => {
  it('validates through the country pack, stores the normalized number as unverified and keeps both specialties', async () => {
    const { user, session } = await person(['professional']);

    const response = await api.put(profileUrl(user.membershipId), session, {
      ...REQUEST,
      matricula: { jurisdiction: 'AR-B', number: 'MP 12.345' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ProfessionalDto>()).toMatchObject({
      membershipId: user.membershipId,
      fullName: 'Ana Pérez',
      status: 'active',
      specialties: ['Medicina general', 'Nutrición'],
      matricula: { jurisdiction: 'AR-B', number: '12345', status: 'unverified' },
      maxSimultaneous: 1,
      clinicalAccess: true,
    });
  });

  it('opens the clinical gate once the registration is recorded, verified or not', async () => {
    const { user, session } = await person(['professional']);
    expect((await api.get('/fixtures/clinical', session)).statusCode).toBe(403);

    await save(user, session);

    expect((await api.get('/fixtures/clinical', session)).statusCode).toBe(200);
  });

  it('closes the gate again when the registration is cleared, and the profile is incomplete', async () => {
    const { user, session } = await person(['professional']);
    await save(user, session);

    const cleared = await save(user, session, { matricula: null });

    expect(cleared.json<ProfessionalDto>()).toMatchObject({
      matricula: null,
      clinicalAccess: false,
    });
    expect((await api.get('/fixtures/clinical', session)).statusCode).toBe(403);
  });

  it('gives an owner who is also a professional the gate through the profile only', async () => {
    const { user, session } = await person(['owner', 'professional']);
    expect((await api.get('/fixtures/clinical', session)).statusCode).toBe(403);

    await save(user, session);

    expect((await api.get('/fixtures/clinical', session)).statusCode).toBe(200);
  });

  it.each([
    [
      'letters instead of digits',
      { jurisdiction: 'AR-B', number: 'abc' },
      'country.ar.matricula.invalid',
    ],
    [
      'an unknown jurisdiction',
      { jurisdiction: 'ES-MD', number: '12345' },
      'country.ar.matricula.unknown_jurisdiction',
    ],
    [
      'a provincial prefix on the national registry',
      { jurisdiction: 'NATIONAL', number: 'MP 123' },
      'country.ar.matricula.invalid',
    ],
  ])('rejects %s with a translated field error', async (_name, matricula, i18nKey) => {
    const { user, session } = await person(['professional']);

    const response = await save(user, session, { matricula });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([{ path: 'matricula', i18nKey }]);
  });

  it('rejects the same registration for a second active professional', async () => {
    const first = await person(['professional']);
    const second = await person(['professional']);
    const matricula = { jurisdiction: 'AR-X', number: '777001' };
    expect((await save(first.user, first.session, { matricula })).statusCode).toBe(200);

    const response = await save(second.user, second.session, { matricula });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'matricula', i18nKey: 'staff.matricula.duplicate' },
    ]);
  });

  it('lets a professional save their own profile again without clashing with themselves', async () => {
    const { user, session } = await person(['professional']);
    const matricula = { jurisdiction: 'AR-X', number: '777002' };
    await save(user, session, { matricula });

    const again = await save(user, session, { matricula, specialties: ['Nutrición'] });

    expect(again.statusCode).toBe(200);
    expect(again.json<ProfessionalDto>().specialties).toEqual(['Nutrición']);
  });

  it('rejects a body that tries to set the verification', async () => {
    const { user, session } = await person(['professional']);

    const response = await save(user, session, { matriculaStatus: 'verified' });

    expect(response.statusCode).toBe(400);
  });
});

describe('editing a verified registration', () => {
  it('puts it back to unverified when the number changes, and keeps it when only specialties change', async () => {
    const { user, session } = await person(['professional']);
    const matricula = { jurisdiction: 'AR-B', number: freshNumber() };
    const created = await save(user, session, { matricula });
    await verifyAsOperator(created.json<ProfessionalDto>().id);
    const verified = await api.get(profileUrl(user.membershipId), session);
    expect(verified.json<ProfessionalDto>().matricula?.status).toBe('verified');

    const sameNumber = await save(user, session, { matricula, specialties: ['Nutrición'] });
    expect(sameNumber.json<ProfessionalDto>().matricula?.status).toBe('verified');

    const edited = await save(user, session);
    expect(edited.json<ProfessionalDto>().matricula?.status).toBe('unverified');
    const [row] = await auditRows('staff.profile_updated', created.json<ProfessionalDto>().id);
    expect(row).toMatchObject({
      outcome: 'allow',
      metadata: { fields: expect.arrayContaining(['matricula']) as unknown, matriculaReset: true },
    });
  });
});

describe('who may edit a profile', () => {
  it('lets an owner edit it, including the simultaneous appointments limit', async () => {
    const owner = await person(['owner']);
    const { user } = await person(['professional']);

    const response = await save(user, owner.session, { maxSimultaneous: 3 });

    expect(response.statusCode).toBe(200);
    expect(response.json<ProfessionalDto>().maxSimultaneous).toBe(3);
  });

  it('keeps the limit out of the professional hands, with a deny audit row', async () => {
    const { user, session } = await person(['professional']);

    const response = await save(user, session, { maxSimultaneous: 4 });

    expect(response.statusCode).toBe(403);
    const [row] = await auditRows('access.denied', user.membershipId);
    expect(row).toMatchObject({ outcome: 'deny', reason: 'profile_max_simultaneous' });
  });

  it("refuses a colleague, reception and the other organization's owner, and audits it", async () => {
    const { user } = await person(['professional']);
    const colleague = await person(['professional']);
    const desk = await person(['reception']);
    const stranger = await person(['owner'], other);

    for (const by of [colleague.session, desk.session]) {
      expect((await save(user, by)).statusCode).toBe(403);
    }
    expect(
      (
        await clientFor(app, 'staff-profile-b').put(
          profileUrl(user.membershipId),
          stranger.session,
          {
            ...REQUEST,
          },
        )
      ).statusCode,
    ).toBe(404);
    const rows = await auditRows('access.denied', user.membershipId);
    expect(rows.map((row) => row.reason)).toEqual(['profile_not_self', 'profile_not_self']);
  });

  it('answers 409 for a member who is not a professional and for a deactivated one', async () => {
    const owner = await person(['owner']);
    const desk = await person(['reception']);
    const gone = await person(['professional']);
    await asTenant(runtime, tenant.id, (tx) =>
      tx
        .update(membership)
        .set({ status: 'deactivated' })
        .where(eq(membership.id, gone.user.membershipId)),
    );

    expect((await save(desk.user, owner.session)).statusCode).toBe(409);
    expect((await save(gone.user, owner.session)).statusCode).toBe(409);
  });

  it('shows the profile to the person and to those who manage staff, not to colleagues', async () => {
    const owner = await person(['owner']);
    const { user, session } = await person(['professional']);
    const colleague = await person(['professional']);
    await save(user, session);

    expect((await api.get(profileUrl(user.membershipId), session)).statusCode).toBe(200);
    expect((await api.get(profileUrl(user.membershipId), owner.session)).statusCode).toBe(200);
    expect((await api.get(profileUrl(user.membershipId), colleague.session)).statusCode).toBe(403);
  });
});

describe('what the audit trail keeps', () => {
  it('records which fields changed, never the registration number', async () => {
    const { user, session } = await person(['professional']);
    const matricula = { jurisdiction: 'AR-B', number: '91919' };

    const response = await save(user, session, { matricula });

    const [row] = await auditRows('staff.profile_updated', response.json<ProfessionalDto>().id);
    expect(row?.metadata['fields']).toEqual(
      expect.arrayContaining(['fullName', 'specialties', 'matricula']),
    );
    expect(JSON.stringify(row?.metadata)).not.toContain('91919');
    expect(row).toMatchObject({ actorUserId: user.id, resourceType: 'professional' });
  });

  it('stores the display name on the membership', async () => {
    const { user, session } = await person(['professional']);

    await save(user, session, { fullName: 'Dra. Ana Pérez' });

    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ name: membership.displayName })
        .from(membership)
        .where(eq(membership.id, user.membershipId)),
    );
    expect(row?.name).toBe('Dra. Ana Pérez');
    const profiles = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(professional).where(eq(professional.membershipId, user.membershipId)),
    );
    expect(profiles).toHaveLength(1);
  });
});
