import type { AuditAction, MeResponse, ProfessionalDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { membership } from '../../src/db/schema/identity.js';
import { professional } from '../../src/db/schema/staff.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD } from '../support/session.js';
import { asTenant, createTestTenant } from '../support/tenants.js';
import { createTestProfessional, createTestUser } from '../support/users.js';

/**
 * Decision D21, revised and confirmed by the owner of the product on 2026-10-17: an owner MAY act
 * as a health professional at any time, provided the professional profile is complete (name,
 * specialty, matricula and its jurisdiction). Completing it grants the professional role in the
 * same transaction. There is no one-time limit, no wizard closure and no 30-day window.
 */
let runtime: DbHandle;
let app: FastifyInstance;
let counter = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  app = buildTestApplication(runtime);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const REQUEST = {
  fullName: 'Dra. Ana Perez',
  specialties: ['Clinica medica'],
  matricula: { jurisdiction: 'AR-B', number: 'MP 12345' },
};

async function organization(options: { ageInDays?: number } = {}) {
  counter += 1;
  const slug = `owner-prof-${String(counter)}`;
  const tenant = await createTestTenant(runtime, {
    slug,
    ...(options.ageInDays === undefined
      ? {}
      : { createdAt: new Date(Date.now() - options.ageInDays * 86_400_000) }),
  });
  const api = clientFor(app, slug);
  const make = (roles: ('owner' | 'admin' | 'reception')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  const ownerUser = await make(['owner']);
  const owner = await signInAs(app, slug, ownerUser);
  const audits = (action: AuditAction) =>
    asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
        .orderBy(desc(auditEvent.occurredAt)),
    );
  const rolesOf = async (membershipId: string) => {
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ roles: membership.roles })
        .from(membership)
        .where(eq(membership.id, membershipId)),
    );
    return row?.roles.toSorted();
  };
  const profiles = (membershipId: string) =>
    asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(professional).where(eq(professional.membershipId, membershipId)),
    );
  return { tenant, slug, api, make, ownerUser, owner, audits, rolesOf, profiles };
}

describe('an owner completes the professional profile (D21)', () => {
  it('gets the professional role and an unverified matricula, and clinical work opens', async () => {
    const org = await organization();

    const response = await org.api.post('/staff/me/professional', org.owner, REQUEST);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ProfessionalDto>()).toMatchObject({
      membershipId: org.ownerUser.membershipId,
      fullName: 'Dra. Ana Perez',
      specialties: ['Clinica medica'],
      matricula: { jurisdiction: 'AR-B', number: '12345', status: 'unverified' },
      clinicalAccess: true,
    });
    expect(await org.rolesOf(org.ownerUser.membershipId)).toEqual(['owner', 'professional']);
    // The very next request carries the new role: roles are read from the membership.
    const me = (await org.api.get('/auth/me', org.owner)).json<MeResponse>();
    expect(me.roles.toSorted()).toEqual(['owner', 'professional']);
    expect(me.permissions).toContain('clinical.note.write');
  });

  it('audits the role change as owner_professional_profile, and the profile', async () => {
    const org = await organization();

    await org.api.post('/staff/me/professional', org.owner, REQUEST);

    const [change] = await org.audits('role.changed');
    expect(change).toMatchObject({
      outcome: 'allow',
      actorUserId: org.ownerUser.id,
      resourceType: 'membership',
      resourceId: org.ownerUser.membershipId,
      metadata: {
        previousRoles: ['owner'],
        newRoles: ['owner', 'professional'],
        via: 'owner_professional_profile',
        self: true,
      },
    });
    expect((await org.audits('staff.profile_updated')).length).toBe(1);
  });

  it('works at any time: a year-old organization with a finished wizard is no different', async () => {
    const org = await organization({ ageInDays: 365 });
    await org.api.post('/onboarding/fast-path', org.owner, {
      fullName: 'Lic. Mario Gomez',
      specialties: ['Psicologia'],
      matricula: { jurisdiction: 'AR-B', number: 'MP 777' },
    });
    // A second owner arrives later, long after the wizard is finished, and attends too.
    const second = await org.make(['owner']);
    const secondSession = await signInAs(app, org.slug, second);

    const response = await org.api.post('/staff/me/professional', secondSession, {
      ...REQUEST,
      matricula: { jurisdiction: 'AR-B', number: 'MP 888' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await org.rolesOf(second.membershipId)).toEqual(['owner', 'professional']);
  });

  it('can be repeated: it updates the profile and adds neither a second role nor a second audit entry', async () => {
    const org = await organization();
    await org.api.post('/staff/me/professional', org.owner, REQUEST);

    const again = await org.api.post('/staff/me/professional', org.owner, {
      ...REQUEST,
      specialties: ['Clinica medica', 'Geriatria'],
    });

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<ProfessionalDto>().specialties).toEqual(['Clinica medica', 'Geriatria']);
    expect(await org.rolesOf(org.ownerUser.membershipId)).toEqual(['owner', 'professional']);
    expect(await org.profiles(org.ownerUser.membershipId)).toHaveLength(1);
    expect((await org.audits('role.changed')).length).toBe(1);
  });

  it.each([
    ['no matricula', { matricula: null }],
    ['no jurisdiction', { matricula: { number: 'MP 12345' } }],
    ['no number', { matricula: { jurisdiction: 'AR-B' } }],
    ['no name', { fullName: ' ' }],
    ['no specialty', { specialties: [] }],
    ['a role in the body', { roles: ['admin'] }],
  ])('refuses %s and changes nothing', async (_name, change) => {
    const org = await organization();

    const response = await org.api.post('/staff/me/professional', org.owner, {
      ...REQUEST,
      ...change,
    });

    expect(response.statusCode).toBe(400);
    expect(await org.rolesOf(org.ownerUser.membershipId)).toEqual(['owner']);
    expect(await org.profiles(org.ownerUser.membershipId)).toEqual([]);
    expect(await org.audits('role.changed')).toEqual([]);
  });

  it('refuses a malformed matricula, in one transaction: no role, no profile, no audit entry', async () => {
    const org = await organization();

    const response = await org.api.post('/staff/me/professional', org.owner, {
      ...REQUEST,
      matricula: { jurisdiction: 'AR-B', number: '!!' },
    });

    expect(response.statusCode).toBe(400);
    expect(await org.rolesOf(org.ownerUser.membershipId)).toEqual(['owner']);
    expect(await org.profiles(org.ownerUser.membershipId)).toEqual([]);
    expect(await org.audits('role.changed')).toEqual([]);
    expect(await org.audits('staff.profile_updated')).toEqual([]);
  });

  it('refuses a matricula that another active professional already holds, without leaving the role behind', async () => {
    const org = await organization();
    await createTestProfessional(runtime, org.tenant.id, {
      matricula: '12345',
      jurisdiction: 'AR-B',
    });

    const response = await org.api.post('/staff/me/professional', org.owner, REQUEST);

    expect(response.statusCode, response.body).toBe(409);
    expect(await org.rolesOf(org.ownerUser.membershipId)).toEqual(['owner']);
    expect(await org.audits('role.changed')).toEqual([]);
  });
});

describe('nobody else self-assigns a role', () => {
  it('refuses an admin: the path is for owners only, and the denial is audited', async () => {
    const org = await organization();
    const adminUser = await org.make(['admin']);
    const admin = await signInAs(app, org.slug, adminUser);

    const response = await org.api.post('/staff/me/professional', admin, REQUEST);

    expect(response.statusCode).toBe(403);
    expect(await org.rolesOf(adminUser.membershipId)).toEqual(['admin']);
    expect(await org.profiles(adminUser.membershipId)).toEqual([]);
    const [denied] = await org.audits('access.denied');
    expect(denied).toMatchObject({ outcome: 'deny', actorUserId: adminUser.id });
  });

  it('refuses reception and an existing professional', async () => {
    const org = await organization();
    const desk = await signInAs(app, org.slug, await org.make(['reception']));
    const doctor = await signInAs(
      app,
      org.slug,
      await createTestProfessional(runtime, org.tenant.id, { password: TEST_PASSWORD }),
    );

    expect((await org.api.post('/staff/me/professional', desk, REQUEST)).statusCode).toBe(403);
    expect((await org.api.post('/staff/me/professional', doctor, REQUEST)).statusCode).toBe(403);
  });

  it('still refuses an owner who tries to change their own roles through the roles endpoint', async () => {
    const org = await organization();

    const response = await org.api.put(`/members/${org.ownerUser.membershipId}/roles`, org.owner, {
      roles: ['owner', 'professional'],
    });

    expect(response.statusCode).toBe(403);
    expect(await org.rolesOf(org.ownerUser.membershipId)).toEqual(['owner']);
  });

  it('requires a session', async () => {
    const org = await organization();

    const response = await org.api.post('/staff/me/professional', null, REQUEST);

    expect(response.statusCode).toBe(401);
  });
});
