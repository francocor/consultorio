import { Problem, isClinicalPermission, type Permission, type Role } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import type { ProfessionalRepo } from '../../src/platform/authz/professional-gate.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication, hostOf, sessionCookieOf } from '../support/app.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser, type TestUser } from '../support/users.js';

/**
 * The "admin denied" harness (authorization, "Clinical notes readable by health professionals
 * only"). It iterates EVERY registered route whose permission is `clinical.*` and proves, against
 * the real application and a real database, that an owner, an admin and reception get the
 * uniform 403 and that the denial is written to the audit log. It is proven now with fixture
 * routes; from Stage 2 it covers the real clinical routes the moment they are registered.
 */
const PASSWORD = 'la contraseña de la prueba de acceso clínico';

let runtime: DbHandle;
let app: FastifyInstance;
let tenant: TestTenant;
let professional: TestUser;
let professionalWithoutProfile: TestUser;

const CLINICAL_FIXTURES: Permission[] = [
  'clinical.note.read',
  'clinical.note.write',
  'clinical.anamnesis.read',
  'clinical.document.read',
  'clinical.search',
];

let testIp = '';
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `10.60.${String(Math.floor(ipCounter / 250))}.${String((ipCounter % 250) + 1)}`;
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'admin-denied' });
  professional = await createTestUser(runtime, tenant.id, {
    roles: ['professional'],
    password: PASSWORD,
  });
  professionalWithoutProfile = await createTestUser(runtime, tenant.id, {
    roles: ['professional'],
    password: PASSWORD,
  });
  const professionals: ProfessionalRepo = {
    findByMembership: (_tenantId, membershipId) =>
      Promise.resolve(
        membershipId === professional.membershipId
          ? {
              id: '0190a000-0000-7000-8000-0000000000f1',
              status: 'active' as const,
              matricula: 'MP 12345',
              matriculaJurisdiction: 'AR-B',
            }
          : null,
      ),
  };
  app = buildTestApplication(runtime, {
    professionals,
    modules: [
      (scope) => {
        for (const permission of CLINICAL_FIXTURES) {
          scope.get(
            `/fixtures/${permission}`,
            { config: { readOnly: 'read', permission } },
            () => ({ secret: 'clinical content' }),
          );
        }
      },
    ],
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

async function signedIn(user: TestUser): Promise<string> {
  testIp = nextIp();
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: browserHeaders('admin-denied'),
    remoteAddress: testIp,
    payload: { email: user.email, password: PASSWORD },
  });
  return sessionCookieOf(response.headers['set-cookie']);
}

/** A path of a real route, with its parameters filled in by an id nothing owns. */
const concrete = (url: string) =>
  url.replace(/:[A-Za-z]+/g, '0190a000-0000-7000-8000-0000000000aa');

/** The request a browser would send, so a mutating route reaches the permission check. */
const call = (url: string, cookie: string, method = 'GET') =>
  app.inject({
    method: method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: concrete(url),
    headers: browserHeaders('admin-denied', cookie),
    remoteAddress: testIp,
    ...(method === 'GET' || method === 'HEAD' || method === 'DELETE' ? {} : { payload: {} }),
  });

const clinicalRoutes = () =>
  [...app.routePermissions].filter(([, permission]) => isClinicalPermission(permission));

async function denialsOf(userId: string, permission: Permission) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.tenantId, tenant.id),
          eq(auditEvent.action, 'access.denied'),
          eq(auditEvent.actorUserId, userId),
        ),
      ),
  );
  return rows.filter((row) => row.metadata['permission'] === permission);
}

describe('clinical routes refuse everyone who is not a health professional', () => {
  it('finds the clinical routes to test (the harness is not silently empty)', () => {
    expect(clinicalRoutes().map(([route]) => route)).toEqual(
      expect.arrayContaining([
        'GET /fixtures/clinical.note.read',
        'GET /fixtures/clinical.note.write',
        'GET /fixtures/clinical.search',
      ]),
    );
  });

  for (const role of ['owner', 'admin', 'reception'] as Role[]) {
    it(`${role}: 403 on every clinical route, uniform body, and a deny audit row for each`, async () => {
      const user = await createTestUser(runtime, tenant.id, { roles: [role], password: PASSWORD });
      const cookie = await signedIn(user);
      const bodies = new Set<string>();

      for (const [route, permission] of clinicalRoutes()) {
        const space = route.indexOf(' ');
        const method = route.slice(0, space);
        const url = route.slice(space + 1);
        const before = (await denialsOf(user.id, permission)).length;

        const response = await call(url, cookie, method);

        expect(response.statusCode, `${role} ${route}`).toBe(403);
        expect(response.body, `${role} ${route}`).not.toContain('clinical content');
        if (method !== 'HEAD') {
          const problem = Problem.parse(response.json());
          bodies.add(JSON.stringify({ ...problem, requestId: '' }));
        }
        // The denial survived: written on its own connection, with who and why.
        const rows = await denialsOf(user.id, permission);
        expect(rows, `${role} ${route}`).toHaveLength(before + 1);
        expect(rows[0]).toMatchObject({
          outcome: 'deny',
          reason: 'not_permitted',
          resourceType: 'route',
          actingRole: role,
        });
      }

      // The answer never differs between routes: it names no permission, no role, no resource.
      expect(bodies.size).toBe(1);
    });
  }

  it('also refuses an owner who is a professional only through the owner role', async () => {
    const owner = await createTestUser(runtime, tenant.id, {
      roles: ['owner'],
      password: PASSWORD,
    });
    const cookie = await signedIn(owner);

    const response = await call('/fixtures/clinical.note.read', cookie);

    expect(response.statusCode).toBe(403);
  });

  it('refuses a professional with no valid profile, as the gate, and audits it', async () => {
    const cookie = await signedIn(professionalWithoutProfile);

    const response = await call('/fixtures/clinical.note.read', cookie);

    expect(response.statusCode).toBe(403);
    const rows = await denialsOf(professionalWithoutProfile.id, 'clinical.note.read');
    expect(rows[0]).toMatchObject({ reason: 'professional_gate' });
  });

  it('serves a professional with an active profile and a valid matricula (the positive control)', async () => {
    const cookie = await signedIn(professional);

    for (const [route] of clinicalRoutes()) {
      const space = route.indexOf(' ');
      const response = await call(route.slice(space + 1), cookie, route.slice(0, space));
      if (route.includes(' /fixtures/')) {
        expect(response.statusCode, route).toBe(200);
      } else {
        // A real route: the professional is let in (what happens next is the route's business,
        // such as a missing patient or an empty body), never turned away at the door.
        expect([401, 403], route).not.toContain(response.statusCode);
      }
    }
    expect(await denialsOf(professional.id, 'clinical.note.read')).toEqual([]);
  });

  it('denies without a session at all as an authentication failure, not a permission one', async () => {
    const response = await app.inject({
      url: '/fixtures/clinical.note.read',
      headers: { host: hostOf('admin-denied') },
    });

    expect(response.statusCode).toBe(401);
  });
});
