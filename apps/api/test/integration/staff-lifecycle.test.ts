import type { AuditAction, StaffMemberDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { membership } from '../../src/db/schema/identity.js';
import { professional } from '../../src/db/schema/staff.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let mail: FakeEmailSender;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'staff-life' });
  other = await createTestTenant(runtime, { slug: 'staff-life-b' });
  mail = createFakeEmailSender();
  app = buildTestApplication(runtime, {
    email: mail,
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
  api = clientFor(app, 'staff-life');
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

type RoleName = 'owner' | 'admin' | 'professional' | 'reception';

async function person(roles: RoleName[], t: TestTenant = tenant) {
  const user = await createTestUser(runtime, t.id, { roles, password: TEST_PASSWORD });
  return { user, session: await signInAs(app, t.slug, user) };
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

let counter = 0;
const address = () => `nueva-${String((counter += 1))}@clinica.example`;

function tokenFrom(to: string): string {
  const message = mail.lastTo(to);
  const match = /accept-invitation\?token=([A-Za-z0-9_-]+)/.exec(message?.text ?? '');
  if (!match?.[1]) throw new Error('no invitation link in the email');
  return match[1];
}

describe('inviting staff', () => {
  it('emails a single-use link, and the invitee sets their own password and gets exactly the role', async () => {
    const owner = await person(['owner']);
    const to = address();

    const response = await api.post('/staff/invitations', owner.session, {
      email: to,
      roles: ['reception'],
      displayName: 'Lucía Gómez',
    });

    expect(response.statusCode).toBe(201);
    expect(Object.keys(response.json<object>())).toEqual(['expiresAt']);
    expect(response.body).not.toContain('token');
    const email = mail.lastTo(to);
    expect(email?.subject).toContain('staff-life');
    expect(email?.text).toContain('https://staff-life.consultorio.test/accept-invitation?token=');

    const token = tokenFrom(to);
    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      headers: browserHeaders('staff-life'),
      remoteAddress: '10.99.0.2',
      payload: { token, password: 'una frase propia y larga para entrar' },
    });
    expect(accepted.statusCode).toBe(204);
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ roles: membership.roles, name: membership.displayName })
        .from(membership)
        .where(eq(membership.displayName, 'Lucía Gómez')),
    );
    expect(row).toEqual({ roles: ['reception'], name: 'Lucía Gómez' });
    // The same link a second time fails.
    const again = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      headers: browserHeaders('staff-life'),
      remoteAddress: '10.99.0.2',
      payload: { token, password: 'otra frase propia y larga para entrar' },
    });
    expect(again.statusCode).toBe(400);
  });

  it('audits who invited with which roles, and nothing that identifies the address or the link', async () => {
    const owner = await person(['owner']);
    const to = address();

    await api.post('/staff/invitations', owner.session, { email: to, roles: ['professional'] });

    const [row] = await auditRows('staff.invited');
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: owner.user.id,
      metadata: { roles: ['professional'] },
    });
    expect(JSON.stringify(row)).not.toContain(to);
    expect(JSON.stringify(row)).not.toContain(tokenFrom(to));
  });

  it('keeps an admin below the owner ceiling, with a deny audit row', async () => {
    const admin = await person(['admin']);
    const to = address();

    const response = await api.post('/staff/invitations', admin.session, {
      email: to,
      roles: ['owner'],
    });

    expect(response.statusCode).toBe(403);
    expect(mail.lastTo(to)).toBeUndefined();
    const [row] = await auditRows('access.denied');
    expect(row).toMatchObject({ outcome: 'deny', reason: 'invite_above_ceiling' });
  });

  it('lets an admin invite a professional (D19, revised): the invitation goes out and the owners are told', async () => {
    const admin = await person(['admin']);
    const to = address();

    const response = await api.post('/staff/invitations', admin.session, {
      email: to,
      roles: ['professional'],
    });

    expect(response.statusCode).toBe(201);
    expect(mail.lastTo(to)).toBeDefined();
    const [row] = await auditRows('professional.added_by_admin');
    expect(row).toMatchObject({ outcome: 'allow', actorUserId: admin.user.id });
  });

  it('lets an admin invite administration and reception, and an owner invite a professional', async () => {
    const admin = await person(['admin']);
    const owner = await person(['owner']);
    const forReception = address();
    const forDoctor = address();

    const byAdmin = await api.post('/staff/invitations', admin.session, {
      email: forReception,
      roles: ['reception', 'admin'],
    });
    const byOwner = await api.post('/staff/invitations', owner.session, {
      email: forDoctor,
      roles: ['professional'],
    });

    expect(byAdmin.statusCode).toBe(201);
    expect(byOwner.statusCode).toBe(201);
  });

  it('is closed to reception and professionals', async () => {
    const desk = await person(['reception']);
    const doctor = await person(['professional']);

    for (const by of [desk.session, doctor.session]) {
      const response = await api.post('/staff/invitations', by, {
        email: address(),
        roles: ['reception'],
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('refuses an address that already works in the organization', async () => {
    const owner = await person(['owner']);
    const member = await person(['reception']);

    const response = await api.post('/staff/invitations', owner.session, {
      email: member.user.email,
      roles: ['reception'],
    });

    expect(response.statusCode).toBe(409);
    expect(mail.lastTo(member.user.email)).toBeUndefined();
  });

  it('invites an address that belongs to another organization: the memberships stay separate', async () => {
    const owner = await person(['owner']);
    const elsewhere = await person(['reception'], other);

    const response = await api.post('/staff/invitations', owner.session, {
      email: elsewhere.user.email,
      roles: ['professional'],
    });

    expect(response.statusCode).toBe(201);
    expect(mail.lastTo(elsewhere.user.email)).toBeDefined();
  });

  it('replaces the earlier link when the same address is invited again', async () => {
    const owner = await person(['owner']);
    const to = address();
    await api.post('/staff/invitations', owner.session, { email: to, roles: ['reception'] });
    const first = tokenFrom(to);
    await api.post('/staff/invitations', owner.session, { email: to, roles: ['admin'] });

    const old = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      headers: browserHeaders('staff-life'),
      remoteAddress: '10.99.0.3',
      payload: { token: first, password: 'una frase propia y larga para entrar' },
    });

    expect(old.statusCode).toBe(400);
  });

  it('rejects a body with a password, a tenant or the patient role', async () => {
    const owner = await person(['owner']);

    for (const body of [
      { email: address(), roles: ['reception'], password: 'x' },
      { email: address(), roles: ['reception'], tenantId: other.id },
      { email: address(), roles: ['patient'] },
      { email: 'not-an-address', roles: ['reception'] },
    ]) {
      expect((await api.post('/staff/invitations', owner.session, body)).statusCode).toBe(400);
    }
  });
});

describe('the staff directory', () => {
  it('shows contact details and registrations to those who manage staff, and names only to others', async () => {
    const owner = await person(['owner']);
    const doctor = await person(['professional']);
    await api.put(`/staff/${doctor.user.membershipId}/professional-profile`, doctor.session, {
      fullName: 'Dr. Pablo Ruiz',
      specialties: ['Odontología', 'Medicina general'],
      matricula: { jurisdiction: 'AR-B', number: '555111' },
    });
    const desk = await person(['reception']);

    const asOwner = (await api.get('/staff', owner.session)).json<{ staff: StaffMemberDto[] }>();
    const asDesk = (await api.get('/staff', desk.session)).json<{ staff: StaffMemberDto[] }>();

    const ownerView = asOwner.staff.find((row) => row.membershipId === doctor.user.membershipId);
    expect(ownerView).toMatchObject({
      displayName: 'Dr. Pablo Ruiz',
      email: doctor.user.email,
      professional: {
        specialties: ['Odontología', 'Medicina general'],
        matricula: { number: '555111' },
      },
    });
    const deskView = asDesk.staff.find((row) => row.membershipId === doctor.user.membershipId);
    expect(deskView).toMatchObject({
      displayName: 'Dr. Pablo Ruiz',
      roles: ['professional'],
      email: null,
      professional: { specialties: ['Odontología', 'Medicina general'], matricula: null },
    });
    expect(JSON.stringify(asDesk)).not.toContain('555111');
    expect(JSON.stringify(asDesk)).not.toContain(doctor.user.email);
  });

  it('shows a person their own email and registration even without managing staff', async () => {
    const doctor = await person(['professional']);
    const colleague = await person(['professional']);
    await api.put(`/staff/${doctor.user.membershipId}/professional-profile`, doctor.session, {
      fullName: 'Dra. Mora',
      specialties: ['Psicología'],
      matricula: { jurisdiction: 'AR-B', number: '555222' },
    });

    const mine = (
      await api.get(`/staff/${doctor.user.membershipId}`, doctor.session)
    ).json<StaffMemberDto>();
    const theirs = (
      await api.get(`/staff/${doctor.user.membershipId}`, colleague.session)
    ).json<StaffMemberDto>();

    expect(mine).toMatchObject({
      email: doctor.user.email,
      professional: { matricula: { number: '555222' } },
    });
    expect(theirs).toMatchObject({ email: null, professional: { matricula: null } });
  });

  it('lists the locations each person works at by name', async () => {
    const owner = await person(['owner']);
    const desk = await person(['reception']);
    const place = await api.post('/locations', owner.session, { name: 'Sede Directorio' });
    await api.put(`/members/${desk.user.membershipId}/locations`, owner.session, {
      locationIds: [place.json<{ id: string }>().id],
    });

    const row = (
      await api.get(`/staff/${desk.user.membershipId}`, desk.session)
    ).json<StaffMemberDto>();

    expect(row.locations.map((location) => location.name)).toEqual(['Sede Directorio']);
  });

  it('hides deactivated staff unless a manager asks for them', async () => {
    const owner = await person(['owner']);
    const desk = await person(['reception']);
    await api.post(`/staff/${desk.user.membershipId}/deactivate`, owner.session);

    const normal = (await api.get('/staff', owner.session)).json<{ staff: StaffMemberDto[] }>();
    const all = (await api.get('/staff?includeDeactivated=true', owner.session)).json<{
      staff: StaffMemberDto[];
    }>();
    const peek = (await api.get('/staff?includeDeactivated=true', owner.session)).statusCode;

    expect(normal.staff.some((row) => row.membershipId === desk.user.membershipId)).toBe(false);
    expect(all.staff.find((row) => row.membershipId === desk.user.membershipId)?.status).toBe(
      'deactivated',
    );
    expect(peek).toBe(200);
  });

  it("answers 404 for another organization's member, and 401 without a session", async () => {
    const owner = await person(['owner']);
    const stranger = await person(['reception'], other);

    expect((await api.get(`/staff/${stranger.user.membershipId}`, owner.session)).statusCode).toBe(
      404,
    );
    expect((await api.get('/staff', null)).statusCode).toBe(401);
  });

  it('lets a person rename themselves and an owner rename anyone, but not a colleague', async () => {
    const owner = await person(['owner']);
    const desk = await person(['reception']);
    const colleague = await person(['reception']);
    const url = `/staff/${desk.user.membershipId}/profile`;

    expect((await api.patch(url, desk.session, { displayName: 'Marta' })).statusCode).toBe(204);
    expect((await api.patch(url, owner.session, { displayName: 'Marta R.' })).statusCode).toBe(204);
    expect((await api.patch(url, colleague.session, { displayName: 'Intrusa' })).statusCode).toBe(
      403,
    );
    expect(
      (await api.patch(url, desk.session, { displayName: 'Marta', roles: ['owner'] })).statusCode,
    ).toBe(400);
    const row = (
      await api.get(`/staff/${desk.user.membershipId}`, desk.session)
    ).json<StaffMemberDto>();
    expect(row.displayName).toBe('Marta R.');
  });
});

describe('deactivating and reactivating staff', () => {
  it('ends the sessions at once, refuses a new sign-in, keeps the history and audits it', async () => {
    const owner = await person(['owner']);
    const desk = await person(['reception']);
    expect((await api.get('/auth/me', desk.session)).statusCode).toBe(200);

    const response = await api.post(`/staff/${desk.user.membershipId}/deactivate`, owner.session);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      membershipId: desk.user.membershipId,
      status: 'deactivated',
    });
    expect((await api.get('/auth/me', desk.session)).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: browserHeaders('staff-life'),
      remoteAddress: '10.99.0.4',
      payload: { email: desk.user.email, password: TEST_PASSWORD },
    });
    expect(login.statusCode).toBe(401);
    // The membership row stays: nothing is deleted.
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ status: membership.status })
        .from(membership)
        .where(eq(membership.id, desk.user.membershipId)),
    );
    expect(row?.status).toBe('deactivated');
    const [entry] = await auditRows('staff.deactivated', desk.user.membershipId);
    expect(entry).toMatchObject({
      outcome: 'allow',
      actorUserId: owner.user.id,
      resourceType: 'membership',
    });
  });

  it('closes the clinical door of a deactivated professional and keeps the profile', async () => {
    const owner = await person(['owner']);
    const doctor = await person(['professional']);
    await api.put(`/staff/${doctor.user.membershipId}/professional-profile`, doctor.session, {
      fullName: 'Dr. Quirós',
      specialties: ['Medicina general'],
      matricula: { jurisdiction: 'AR-B', number: '556001' },
    });
    expect((await api.get('/fixtures/clinical', doctor.session)).statusCode).toBe(200);

    await api.post(`/staff/${doctor.user.membershipId}/deactivate`, owner.session);

    const [profile] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ status: professional.status })
        .from(professional)
        .where(eq(professional.membershipId, doctor.user.membershipId)),
    );
    expect(profile?.status).toBe('inactive');
    expect((await api.get('/fixtures/clinical', doctor.session)).statusCode).toBe(401);
  });

  it('reactivates: the person signs in again and the profile is active', async () => {
    const owner = await person(['owner']);
    const doctor = await person(['professional']);
    await api.put(`/staff/${doctor.user.membershipId}/professional-profile`, doctor.session, {
      fullName: 'Dr. Vera',
      specialties: ['Medicina general'],
      matricula: { jurisdiction: 'AR-B', number: '556002' },
    });
    await api.post(`/staff/${doctor.user.membershipId}/deactivate`, owner.session);

    const response = await api.post(`/staff/${doctor.user.membershipId}/reactivate`, owner.session);

    expect(response.json()).toEqual({ membershipId: doctor.user.membershipId, status: 'active' });
    const again = await signInAs(app, 'staff-life', doctor.user);
    expect((await api.get('/fixtures/clinical', again)).statusCode).toBe(200);
    expect(await auditRows('staff.reactivated', doctor.user.membershipId)).toHaveLength(1);
  });

  it('refuses to reactivate a professional whose registration another active professional now holds', async () => {
    const owner = await person(['owner']);
    const first = await person(['professional']);
    const second = await person(['professional']);
    const matricula = { jurisdiction: 'AR-B', number: '556003' };
    const profile = (name: string) => ({
      fullName: name,
      specialties: ['Medicina general'],
      matricula,
    });
    await api.put(
      `/staff/${first.user.membershipId}/professional-profile`,
      first.session,
      profile('Uno'),
    );
    await api.post(`/staff/${first.user.membershipId}/deactivate`, owner.session);
    expect(
      (
        await api.put(
          `/staff/${second.user.membershipId}/professional-profile`,
          second.session,
          profile('Dos'),
        )
      ).statusCode,
    ).toBe(200);

    const response = await api.post(`/staff/${first.user.membershipId}/reactivate`, owner.session);

    expect(response.statusCode).toBe(409);
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ status: membership.status })
        .from(membership)
        .where(eq(membership.id, first.user.membershipId)),
    );
    expect(row?.status).toBe('deactivated');
  });

  it('is idempotent: a second deactivation changes and audits nothing', async () => {
    const owner = await person(['owner']);
    const desk = await person(['reception']);
    await api.post(`/staff/${desk.user.membershipId}/deactivate`, owner.session);

    const again = await api.post(`/staff/${desk.user.membershipId}/deactivate`, owner.session);

    expect(again.statusCode).toBe(200);
    expect(await auditRows('staff.deactivated', desk.user.membershipId)).toHaveLength(1);
  });

  it('refuses deactivating oneself, with a deny audit row', async () => {
    const ownerUser = await person(['owner']);
    await person(['owner']);

    const response = await api.post(
      `/staff/${ownerUser.user.membershipId}/deactivate`,
      ownerUser.session,
    );

    expect(response.statusCode).toBe(403);
    const [row] = await auditRows('access.denied', ownerUser.user.membershipId);
    expect(row).toMatchObject({ reason: 'staff_status_self' });
    expect((await api.get('/auth/me', ownerUser.session)).statusCode).toBe(200);
  });

  it('keeps an admin from deactivating an owner', async () => {
    const admin = await person(['admin']);
    const owner = await person(['owner']);

    const response = await api.post(`/staff/${owner.user.membershipId}/deactivate`, admin.session);

    expect(response.statusCode).toBe(403);
    expect((await auditRows('access.denied', owner.user.membershipId))[0]).toMatchObject({
      reason: 'staff_status_above_ceiling',
    });
  });

  it('still lets an admin deactivate a professional who leaves (the ceiling is for handing roles out)', async () => {
    const admin = await person(['admin']);
    const doctor = await person(['professional']);

    const response = await api.post(`/staff/${doctor.user.membershipId}/deactivate`, admin.session);

    expect(response.statusCode).toBe(200);
  });

  it('never deactivates the last owner, even when two owners deactivate each other at once', async () => {
    const solo = await createTestTenant(runtime, { slug: 'staff-life-race' });
    const first = await person(['owner'], solo);
    const second = await person(['owner'], solo);
    const raceApi = clientFor(app, 'staff-life-race');

    const [a, b] = await Promise.all([
      raceApi.post(`/staff/${second.user.membershipId}/deactivate`, first.session),
      raceApi.post(`/staff/${first.user.membershipId}/deactivate`, second.session),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([401, 403]).toContain(codes[1]);
    const members = await asTenant(runtime, solo.id, (tx) =>
      tx.select({ status: membership.status }).from(membership),
    );
    expect(members.filter((row) => row.status === 'active')).toHaveLength(1);
  });

  it("is closed to reception, and 404 for another organization's member", async () => {
    const desk = await person(['reception']);
    const owner = await person(['owner']);
    const stranger = await person(['reception'], other);

    expect(
      (await api.post(`/staff/${owner.user.membershipId}/deactivate`, desk.session)).statusCode,
    ).toBe(403);
    expect(
      (await api.post(`/staff/${stranger.user.membershipId}/deactivate`, owner.session)).statusCode,
    ).toBe(404);
  });
});
