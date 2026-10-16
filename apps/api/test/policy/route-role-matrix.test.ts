import { randomBytes } from 'node:crypto';

import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  isClinicalPermission,
  type Permission,
  type Role,
} from '@consultorio/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createApplication } from '../../src/main/application.js';
import { buildServer } from '../../src/main/server.js';
import {
  createPasswordPolicy,
  createPasswordValidator,
} from '../../src/modules/identity/domain/password-policy.js';
import { createActorLoader, noGrants } from '../../src/platform/authz/guard.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb } from '../../src/platform/db/pool.js';
import type { AuthenticatedSession } from '../../src/platform/http/auth-guard.js';
import { SESSION_COOKIE } from '../../src/platform/http/session-cookie.js';
import { testTenancy } from '../../src/testing/tenancy.js';

/**
 * The role x route matrix, generated from the permission catalog (authorization, "Server-side
 * enforcement on every request"). Two layers:
 *
 * 1. Every permission of the catalog gets a fixture route, and every role is sent to every one of
 *    them over HTTP: the answer must be the one the catalog gives, 200 or the uniform 403.
 * 2. Every permission declared by a route of the REAL application is read back from its registry
 *    and checked against the catalog. A route cannot pick a permission that gives the wrong role
 *    access, and a new route is covered the moment it is registered.
 */
const TENANT = '0190a000-0000-7000-8000-0000000000e1';
const COOKIE = `${SESSION_COOKIE}=${'M'.repeat(43)}`;
const PROFESSIONAL_ID = '0190a000-0000-7000-8000-0000000000f1';

const ROUTE_ROLES = ROLES.filter((role) => role !== 'patient');

function sessionFor(role: Role): AuthenticatedSession {
  return {
    sessionId: '0190a000-0000-7000-8000-0000000000b1',
    userId: '0190a000-0000-7000-8000-0000000000b2',
    membershipId: '0190a000-0000-7000-8000-0000000000b3',
    tenantId: TENANT,
    roles: [role],
    scope: 'full',
  };
}

/** A fixture application where `role` is signed in and every permission has a route. */
function fixtureApplication(role: Role, professional: boolean) {
  return buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    ...testTenancy(),
    auth: {
      cookieSecure: true,
      authenticate: () => Promise.resolve(sessionFor(role)),
      authz: {
        loadActor: createActorLoader({
          // A professional with a valid profile, so the matrix tests the role and not the gate.
          professionals: {
            findByMembership: () =>
              Promise.resolve(
                professional
                  ? {
                      id: PROFESSIONAL_ID,
                      status: 'active',
                      matricula: 'MP 1',
                      matriculaJurisdiction: 'AR-B',
                    }
                  : null,
              ),
          },
          grants: noGrants,
          validateMatricula: () => true,
        }),
        auditDeny: () => Promise.resolve({ recorded: true }),
      },
    },
    routes: [
      (scope) => {
        for (const permission of PERMISSIONS) {
          scope.get(
            `/fixtures/${permission}`,
            { config: { readOnly: 'read', permission } },
            () => ({ ok: true }),
          );
        }
      },
    ],
  });
}

describe('every role against every permission, over HTTP', () => {
  describe.each(ROUTE_ROLES)('%s', (role) => {
    it('gets exactly the answer the catalog gives for every permission', async () => {
      const app = fixtureApplication(role, role === 'professional');
      const wrong: string[] = [];

      for (const permission of PERMISSIONS) {
        const response = await app.inject({
          url: `/fixtures/${permission}`,
          headers: { cookie: COOKIE },
        });
        const expected = ROLE_PERMISSIONS[role].includes(permission) ? 200 : 403;
        if (response.statusCode !== expected) {
          wrong.push(
            `${permission}: expected ${String(expected)}, got ${String(response.statusCode)}`,
          );
        }
      }

      expect(wrong).toEqual([]);
      await app.close();
    });
  });

  it('finds the permissions to test (the generator is not silently empty)', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(30);
    expect(PERMISSIONS.filter(isClinicalPermission).length).toBeGreaterThan(5);
  });

  it('gives nothing clinical to anyone but the professional, in the matrix as in the catalog', async () => {
    for (const role of ROUTE_ROLES.filter((r) => r !== 'professional')) {
      const app = fixtureApplication(role, false);
      for (const permission of PERMISSIONS.filter(isClinicalPermission)) {
        const response = await app.inject({
          url: `/fixtures/${permission}`,
          headers: { cookie: COOKIE },
        });
        expect(response.statusCode, `${role} ${permission}`).toBe(403);
      }
      await app.close();
    }
  });

  it('keeps even a professional out of clinical routes when the gate gives no profile', async () => {
    const app = fixtureApplication('professional', false);

    for (const permission of PERMISSIONS.filter(isClinicalPermission)) {
      const response = await app.inject({
        url: `/fixtures/${permission}`,
        headers: { cookie: COOKIE },
      });
      expect(response.statusCode, permission).toBe(403);
    }
    await app.close();
  });
});

describe('the routes of the real application', () => {
  const database = createRuntimeDb('postgres://app_rw:unused@127.0.0.1:1/unused');
  const app = createApplication({
    database,
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    deployment: {
      mode: 'multi',
      baseDomain: 'consultorio.test',
      platformHost: 'platform.consultorio.test',
    },
    cookieSecure: true,
    trustProxy: false,
    email: createFakeEmailSender(),
    passwordValidator: createPasswordValidator(createPasswordPolicy(new Set<string>())),
    keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('enumerates the routes that declare a permission', async () => {
    await app.ready();

    expect([...app.routePermissions.keys()]).toContain('POST /users/:id/password-reset');
  });

  it('declares only permissions that exist, and only roles that hold them can pass', async () => {
    await app.ready();

    for (const [route, permission] of app.routePermissions) {
      expect(PERMISSIONS, route).toContain(permission);
      const holders = ROUTE_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission));
      // A route nobody can call is a mistake in the catalog or in the route.
      expect(holders.length, `${route} (${permission}) can be called by no role`).toBeGreaterThan(
        0,
      );
    }
  });

  it('has a permission or an explicit public/self-service declaration on every route', async () => {
    await app.ready();

    for (const route of app.routeAuth.keys()) {
      const auth = app.routeAuth.get(route);
      const permission: Permission | undefined = app.routePermissions.get(route);
      const url = route.slice(route.indexOf(' ') + 1);
      expect(
        auth === 'public' || permission !== undefined || url.startsWith('/auth/'),
        `${route} has no permission and is neither public nor self-service`,
      ).toBe(true);
    }
  });
});
