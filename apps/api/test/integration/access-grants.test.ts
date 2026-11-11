import { Problem, type AuditAction } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { membership } from '../../src/db/schema/identity.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser, type TestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let tenant: TestTenant;
let other: TestTenant;
let api: ReturnType<typeof clientFor>;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'access-grants' });
  other = await createTestTenant(runtime, { slug: 'access-grants-b' });
  app = buildTestApplication(runtime, {
    modules: [
      (scope) => {
        scope.get(
          '/fixtures/cash',
          { config: { readOnly: 'read', permission: 'cash.operate' } },
          () => ({
            ok: true,
          }),
        );
      },
    ],
  });
  api = clientFor(app, 'access-grants');
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

async function member(roles: ('owner' | 'admin' | 'professional' | 'reception')[], t = tenant) {
  return createTestUser(runtime, t.id, { roles, password: TEST_PASSWORD });
}

async function session(user: TestUser): Promise<TestSession> {
  return signInAs(app, 'access-grants', user);
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

const grantsOf = (target: TestUser, by: TestSession) =>
  api.get(`/members/${target.membershipId}/grants`, by);

describe('granting and revoking a permission', () => {
  it('lets an owner grant a non-clinical permission, which then opens the route at once', async () => {
    const owner = await session(await member(['owner']));
    const nurse = await member(['professional']);
    const nurseSession = await session(nurse);
    expect((await api.get('/fixtures/cash', nurseSession)).statusCode).toBe(403);

    const response = await api.post(`/members/${nurse.membershipId}/grants`, owner, {
      permission: 'cash.operate',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ permission: 'cash.operate', grantedBy: owner.user.id });
    // The very next request of the grantee is allowed: no cache, no re-login.
    expect((await api.get('/fixtures/cash', nurseSession)).statusCode).toBe(200);
  });

  it('shows the grant in the profile of the grantee and in the list of the member', async () => {
    const admin = await session(await member(['admin']));
    const user = await member(['professional']);
    const userSession = await session(user);
    await api.post(`/members/${user.membershipId}/grants`, admin, { permission: 'cash.operate' });

    const me = await api.get('/auth/me', userSession);
    const list = await grantsOf(user, admin);

    expect(me.json<{ permissions: string[] }>().permissions).toContain('cash.operate');
    const body = list.json<{ grants: { permission: string }[]; grantable: string[] }>();
    expect(body.grants.map((grant) => grant.permission)).toEqual(['cash.operate']);
    expect(body.grantable).toEqual(expect.arrayContaining(['cash.operate', 'patients.administer']));
  });

  it('audits the grant with who, to whom and what', async () => {
    const owner = await session(await member(['owner']));
    const user = await member(['reception']);

    await api.post(`/members/${user.membershipId}/grants`, owner, {
      permission: 'scheduling.register_past',
    });

    const [row] = await auditRows('permission.granted', user.membershipId);
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: owner.user.id,
      resourceType: 'membership',
      metadata: { permission: 'scheduling.register_past' },
    });
  });

  it('keeps a delegated calendar narrowed to the professionals it names', async () => {
    const owner = await session(await member(['owner']));
    const user = await member(['reception']);
    const professionalId = '0190a000-0000-7000-8000-0000000000aa';

    const ok = await api.post(`/members/${user.membershipId}/grants`, owner, {
      permission: 'scheduling.delegated_calendar',
      scope: { professionalIds: [professionalId] },
    });
    const withoutScope = await api.post(`/members/${user.membershipId}/grants`, owner, {
      permission: 'scheduling.delegated_calendar',
    });
    const strayScope = await api.post(`/members/${user.membershipId}/grants`, owner, {
      permission: 'cash.operate',
      scope: { professionalIds: [professionalId] },
    });

    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ scope: { professionalIds: [professionalId] } });
    expect(withoutScope.statusCode).toBe(400);
    expect(strayScope.statusCode).toBe(400);
  });

  it('refuses the same grant twice', async () => {
    const owner = await session(await member(['owner']));
    const user = await member(['reception']);
    await api.post(`/members/${user.membershipId}/grants`, owner, { permission: 'cash.operate' });

    const again = await api.post(`/members/${user.membershipId}/grants`, owner, {
      permission: 'cash.operate',
    });

    expect(again.statusCode).toBe(409);
  });

  it('revokes at once, audits it, and allows the grant again later', async () => {
    const owner = await session(await member(['owner']));
    const user = await member(['professional']);
    const userSession = await session(user);
    await api.post(`/members/${user.membershipId}/grants`, owner, { permission: 'cash.operate' });
    expect((await api.get('/fixtures/cash', userSession)).statusCode).toBe(200);

    const revoked = await api.delete(`/members/${user.membershipId}/grants/cash.operate`, owner);

    expect(revoked.statusCode).toBe(204);
    expect((await api.get('/fixtures/cash', userSession)).statusCode).toBe(403);
    const [row] = await auditRows('permission.revoked', user.membershipId);
    expect(row).toMatchObject({ outcome: 'allow', metadata: { permission: 'cash.operate' } });
    expect(
      (
        await api.post(`/members/${user.membershipId}/grants`, owner, {
          permission: 'cash.operate',
        })
      ).statusCode,
    ).toBe(201);
  });

  it('answers 404 when there is nothing to revoke', async () => {
    const owner = await session(await member(['owner']));
    const user = await member(['reception']);

    const response = await api.delete(`/members/${user.membershipId}/grants/cash.operate`, owner);

    expect(response.statusCode).toBe(404);
  });
});

describe('prohibited grants answer 403 and leave a deny audit row', () => {
  it.each(['clinical.note.read', 'clinical.anamnesis.write', 'patients.read', 'billing.manage'])(
    'refuses %s',
    async (permission) => {
      const owner = await session(await member(['owner']));
      const user = await member(['reception']);

      const response = await api.post(`/members/${user.membershipId}/grants`, owner, {
        permission,
      });

      expect(response.statusCode).toBe(403);
      expect(Problem.parse(response.json()).code).toBe('forbidden');
      expect(JSON.stringify(response.json())).not.toContain(permission);
      const [row] = await auditRows('access.denied', user.membershipId);
      expect(row).toMatchObject({
        outcome: 'deny',
        actorUserId: owner.user.id,
        reason: permission.startsWith('clinical.') ? 'grant_clinical' : 'grant_not_grantable',
      });
      expect((await grantsOf(user, owner)).json<{ grants: unknown[] }>().grants).toEqual([]);
    },
  );

  it('refuses a grant to oneself', async () => {
    const ownerUser = await member(['owner']);
    const owner = await session(ownerUser);

    const response = await api.post(`/members/${ownerUser.membershipId}/grants`, owner, {
      permission: 'cash.operate',
    });

    expect(response.statusCode).toBe(403);
    const [row] = await auditRows('access.denied', ownerUser.membershipId);
    expect(row).toMatchObject({ reason: 'grant_self' });
  });

  it('refuses reception and professionals: only an owner or an admin hands out permissions', async () => {
    const user = await member(['reception']);
    for (const roles of [['reception'], ['professional']] as const) {
      const caller = await session(await member([...roles]));

      const post = await api.post(`/members/${user.membershipId}/grants`, caller, {
        permission: 'cash.operate',
      });
      const del = await api.delete(`/members/${user.membershipId}/grants/cash.operate`, caller);

      expect(post.statusCode).toBe(403);
      expect(del.statusCode).toBe(403);
    }
  });

  it('answers 404 for a member of another organization, and 409 for a deactivated one', async () => {
    const owner = await session(await member(['owner']));
    const stranger = await member(['reception'], other);
    const gone = await member(['reception']);
    await asTenant(runtime, tenant.id, (tx) =>
      tx
        .update(membership)
        .set({ status: 'deactivated' })
        .where(eq(membership.id, gone.membershipId)),
    );

    const foreign = await api.post(`/members/${stranger.membershipId}/grants`, owner, {
      permission: 'cash.operate',
    });
    const deactivated = await api.post(`/members/${gone.membershipId}/grants`, owner, {
      permission: 'cash.operate',
    });

    expect(foreign.statusCode).toBe(404);
    expect(deactivated.statusCode).toBe(409);
  });
});

describe('changing the roles of a member', () => {
  const rolesOf = async (user: TestUser) => {
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ roles: membership.roles })
        .from(membership)
        .where(eq(membership.id, user.membershipId)),
    );
    return row?.roles;
  };

  it('changes the roles, ends the sessions of the member and audits previous and new roles', async () => {
    const owner = await session(await member(['owner']));
    const user = await member(['reception']);
    const userSession = await session(user);
    expect((await api.get('/auth/me', userSession)).statusCode).toBe(200);

    const response = await api.put(`/members/${user.membershipId}/roles`, owner, {
      roles: ['professional', 'reception'],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      membershipId: user.membershipId,
      roles: ['professional', 'reception'],
    });
    expect(await rolesOf(user)).toEqual(['professional', 'reception']);
    // The old session is gone: the member signs in again and gets the new roles.
    expect((await api.get('/auth/me', userSession)).statusCode).toBe(401);
    const [row] = await auditRows('role.changed', user.membershipId);
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: owner.user.id,
      metadata: { previousRoles: ['reception'], newRoles: ['professional', 'reception'] },
    });
  });

  it('does not end the sessions of the person who made the change', async () => {
    const owner = await session(await member(['owner']));
    const user = await member(['reception']);

    await api.put(`/members/${user.membershipId}/roles`, owner, { roles: ['admin'] });

    expect((await api.get('/auth/me', owner)).statusCode).toBe(200);
  });

  it('refuses a self-promotion, with a deny audit row', async () => {
    const desk = await member(['reception']);
    const adminUser = await member(['admin']);
    const admin = await session(adminUser);

    const response = await api.put(`/members/${adminUser.membershipId}/roles`, admin, {
      roles: ['owner'],
    });

    expect(response.statusCode).toBe(403);
    expect(await rolesOf(adminUser)).toEqual(['admin']);
    const [row] = await auditRows('access.denied', adminUser.membershipId);
    expect(row).toMatchObject({
      outcome: 'deny',
      actorUserId: adminUser.id,
      reason: 'role_change_self',
    });
    expect(desk.id).not.toBe(adminUser.id);
  });

  it('refuses a profile update that sets a role: the profile route does not take roles', async () => {
    const desk = await session(await member(['reception']));

    const response = await api.put(`/members/${desk.user.membershipId}/roles`, desk, {
      roles: ['owner'],
    });

    expect(response.statusCode).toBe(403);
  });

  it('keeps an admin below the owner ceiling, in both directions', async () => {
    const admin = await session(await member(['admin']));
    const user = await member(['reception']);
    const ownerUser = await member(['owner']);

    const promote = await api.put(`/members/${user.membershipId}/roles`, admin, {
      roles: ['owner'],
    });
    const demoteOwner = await api.put(`/members/${ownerUser.membershipId}/roles`, admin, {
      roles: ['reception'],
    });

    expect(promote.statusCode).toBe(403);
    expect(demoteOwner.statusCode).toBe(403);
    expect(await rolesOf(user)).toEqual(['reception']);
    expect(await rolesOf(ownerUser)).toEqual(['owner']);
    expect(await auditRows('access.denied', user.membershipId)).toHaveLength(1);
    expect(await auditRows('access.denied', ownerUser.membershipId)).toHaveLength(1);
  });

  it('lets an admin grant the professional role (D19, revised): audited, and the owners are told', async () => {
    const admin = await session(await member(['admin']));
    const colleague = await member(['reception']);

    const response = await api.put(`/members/${colleague.membershipId}/roles`, admin, {
      roles: ['reception', 'professional'],
    });

    expect(response.statusCode).toBe(200);
    expect(await rolesOf(colleague)).toEqual(['reception', 'professional']);
    expect(await auditRows('professional.added_by_admin', colleague.membershipId)).toHaveLength(1);
  });

  it('still lets an admin manage the roles of a professional who already is one', async () => {
    const admin = await session(await member(['admin']));
    const doctor = await member(['professional']);

    const keep = await api.put(`/members/${doctor.membershipId}/roles`, admin, {
      roles: ['professional', 'admin'],
    });
    const stepDown = await api.put(`/members/${doctor.membershipId}/roles`, admin, {
      roles: ['reception'],
    });

    expect(keep.statusCode).toBe(200);
    expect(stepDown.statusCode).toBe(200);
    expect(await rolesOf(doctor)).toEqual(['reception']);
  });

  it('lets an owner grant the professional role', async () => {
    const owner = await session(await member(['owner']));
    const colleague = await member(['reception']);

    const response = await api.put(`/members/${colleague.membershipId}/roles`, owner, {
      roles: ['reception', 'professional'],
    });

    expect(response.statusCode).toBe(200);
    expect(await rolesOf(colleague)).toEqual(['reception', 'professional']);
  });

  it('lets an owner step another owner down while two exist', async () => {
    const owner = await session(await member(['owner']));
    const second = await member(['owner']);

    const response = await api.put(`/members/${second.membershipId}/roles`, owner, {
      roles: ['admin'],
    });

    expect(response.statusCode).toBe(200);
  });

  it('never leaves an organization without an owner when two owners demote each other at once', async () => {
    const solo = await createTestTenant(runtime, { slug: 'access-grants-race' });
    const one = await member(['owner'], solo);
    const two = await member(['owner'], solo);
    const raceApi = clientFor(app, 'access-grants-race');
    const first = await signInAs(app, 'access-grants-race', one);
    const second = await signInAs(app, 'access-grants-race', two);

    const [a, b] = await Promise.all([
      raceApi.put(`/members/${two.membershipId}/roles`, first, { roles: ['admin'] }),
      raceApi.put(`/members/${one.membershipId}/roles`, second, { roles: ['admin'] }),
    ]);

    // One wins. The other is refused (403) or, when the winner already ended its session, 401.
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(200);
    expect([401, 403]).toContain(codes[1]);
    const owners = await asTenant(runtime, solo.id, (tx) =>
      tx.select({ id: membership.id, roles: membership.roles }).from(membership),
    );
    expect(owners.filter((row) => row.roles.includes('owner'))).toHaveLength(1);
  });

  it('answers 404 for a member of another organization and 409 for a deactivated member', async () => {
    const owner = await session(await member(['owner']));
    const stranger = await member(['reception'], other);
    const gone = await member(['reception']);
    await asTenant(runtime, tenant.id, (tx) =>
      tx
        .update(membership)
        .set({ status: 'deactivated' })
        .where(eq(membership.id, gone.membershipId)),
    );

    expect(
      (await api.put(`/members/${stranger.membershipId}/roles`, owner, { roles: ['reception'] }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.put(`/members/${gone.membershipId}/roles`, owner, { roles: ['admin'] }))
        .statusCode,
    ).toBe(409);
  });

  it('refuses a body with the patient role or a role claim of the caller', async () => {
    const owner = await session(await member(['owner']));
    const user = await member(['reception']);

    expect(
      (await api.put(`/members/${user.membershipId}/roles`, owner, { roles: ['patient'] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await api.put(`/members/${user.membershipId}/roles`, owner, {
          roles: ['admin'],
          role: 'owner',
        })
      ).statusCode,
    ).toBe(400);
  });
});
