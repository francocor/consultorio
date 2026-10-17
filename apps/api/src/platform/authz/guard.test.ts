import { Problem, type Permission, type Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import { testTenancy } from '../../testing/tenancy.js';
import type { AuditDenyEvent } from '../audit/deny.js';
import type { AuthenticatedSession } from '../http/auth-guard.js';
import { sessionCookieName } from '../http/session-cookie.js';

import { createActorLoader, noGrants, type GrantsRepo, type ActorLoader } from './guard.js';
import type { ProfessionalRepo } from './professional-gate.js';

/** Every app in this file runs with secure cookies, so the session cookie has its prefix. */
const SESSION_COOKIE = sessionCookieName(true);

const TENANT = '0190a000-0000-7000-8000-0000000000e1';
const COOKIE = `${SESSION_COOKIE}=${'G'.repeat(43)}`;

function session(roles: Role[]): AuthenticatedSession {
  return {
    sessionId: '0190a000-0000-7000-8000-0000000000b1',
    userId: '0190a000-0000-7000-8000-0000000000b2',
    membershipId: '0190a000-0000-7000-8000-0000000000b3',
    tenantId: TENANT,
    roles,
    scope: 'full',
  };
}

const validProfile: ProfessionalRepo = {
  findByMembership: () =>
    Promise.resolve({
      id: '0190a000-0000-7000-8000-0000000000f1',
      status: 'active',
      matricula: 'MP 123',
      matriculaJurisdiction: 'AR-B',
    }),
};
const matricula = (_jurisdiction: string, value: string) => value === 'MP 123';

function server(
  roles: Role[],
  options: { professionals?: ProfessionalRepo; grants?: GrantsRepo; denyRecords?: boolean } = {},
) {
  const denials: { tenantId: string; event: AuditDenyEvent }[] = [];
  const loadActor: ActorLoader = createActorLoader({
    professionals: options.professionals ?? { findByMembership: () => Promise.resolve(null) },
    grants: options.grants ?? noGrants,
    validateMatricula: matricula,
  });
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    ...testTenancy(),
    auth: {
      cookieSecure: true,
      authenticate: () => Promise.resolve(session(roles)),
      authz: {
        loadActor,
        auditDeny: (tenantId, event) => {
          denials.push({ tenantId, event });
          return Promise.resolve({ recorded: options.denyRecords ?? true });
        },
      },
    },
    routes: [
      (scope) => {
        scope.get(
          '/patients',
          { config: { readOnly: 'read', permission: 'patients.read' } },
          (r) => ({
            ok: true,
            actor: r.actor,
          }),
        );
        scope.get(
          '/clinical/notes',
          { config: { readOnly: 'read', permission: 'clinical.note.read' } },
          (r) => ({ ok: true, professionalId: r.actor?.professionalId }),
        );
        scope.get('/staff', { config: { readOnly: 'read', permission: 'staff.manage' } }, () => ({
          ok: true,
        }));
        scope.get(
          '/hours',
          { config: { readOnly: 'read', permission: 'scheduling.override_hours' } },
          () => ({ ok: true }),
        );
        scope.get('/auth/self', { config: { readOnly: 'read', auth: 'session' } }, () => ({
          ok: true,
        }));
      },
    ],
  });
  return { app, denials };
}

const get = (app: ReturnType<typeof server>['app'], url: string) =>
  app.inject({ url, headers: { cookie: COOKIE } });

describe('permission guard', () => {
  it('lets a request through when the role allows the permission, and hands the handler the actor', async () => {
    const { app, denials } = server(['reception']);

    const response = await get(app, '/patients');

    expect(response.statusCode).toBe(200);
    expect(response.json<{ actor: Record<string, unknown> }>().actor).toMatchObject({
      kind: 'staff',
      tenantId: TENANT,
      roles: ['reception'],
      professionalId: null,
    });
    expect(denials).toEqual([]);
    await app.close();
  });

  it('answers a denied request with the uniform 403, naming nothing', async () => {
    const { app } = server(['reception']);

    const response = await get(app, '/staff');

    expect(response.statusCode).toBe(403);
    const body = Problem.parse(response.json());
    expect(body).toMatchObject({ code: 'forbidden', status: 403 });
    expect(response.body).not.toContain('staff.manage');
    expect(response.body).not.toContain('reception');
    await app.close();
  });

  it('audits the denial through the independent writer, with the reason and the permission', async () => {
    const { app, denials } = server(['reception']);

    await get(app, '/staff');

    expect(denials).toHaveLength(1);
    expect(denials[0]?.tenantId).toBe(TENANT);
    expect(denials[0]?.event).toMatchObject({
      action: 'access.denied',
      reason: 'not_permitted',
      resourceType: 'route',
      metadata: { permission: 'staff.manage', method: 'GET' },
      actor: { userId: '0190a000-0000-7000-8000-0000000000b2', actingRole: 'reception' },
    });
    await app.close();
  });

  it('still denies when the denial itself could not be recorded', async () => {
    const { app } = server(['reception'], { denyRecords: false });

    const response = await get(app, '/staff');

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('denies owner and admin on every clinical route and audits it', async () => {
    for (const role of ['owner', 'admin'] as Role[]) {
      const { app, denials } = server([role]);

      const response = await get(app, '/clinical/notes');

      expect(response.statusCode, role).toBe(403);
      expect(denials[0]?.event.reason, role).toBe('not_permitted');
      await app.close();
    }
  });

  it('denies a professional who has no valid profile, as the professional gate', async () => {
    const { app, denials } = server(['professional']);

    const response = await get(app, '/clinical/notes');

    expect(response.statusCode).toBe(403);
    expect(denials[0]?.event.reason).toBe('professional_gate');
    await app.close();
  });

  it('opens clinical routes to a professional who passed the gate, and exposes the profile id', async () => {
    const { app } = server(['professional'], { professionals: validProfile });

    const response = await get(app, '/clinical/notes');

    expect(response.statusCode).toBe(200);
    expect(response.json<{ professionalId: string }>().professionalId).toBe(
      '0190a000-0000-7000-8000-0000000000f1',
    );
    await app.close();
  });

  it('adds the grants of the user to what the role allows', async () => {
    const granted = server(['reception'], {
      grants: { grantsFor: () => Promise.resolve(['scheduling.override_hours']) },
    });
    const plain = server(['reception']);

    expect((await get(granted.app, '/hours')).statusCode).toBe(200);
    expect((await get(plain.app, '/hours')).statusCode).toBe(403);
    await granted.app.close();
    await plain.app.close();
  });

  it('denies a patient session on a staff route by default', async () => {
    const { app, denials } = server(['patient']);

    const response = await get(app, '/patients');

    expect(response.statusCode).toBe(403);
    expect(denials[0]?.event.reason).toBe('patient_on_staff_route');
    await app.close();
  });

  it('serves a self-service route to any signed-in user without a permission', async () => {
    const { app } = server(['reception']);

    expect((await get(app, '/auth/self')).statusCode).toBe(200);
    await app.close();
  });

  it('records the permission of every route, for the policy tests', async () => {
    const { app } = server(['reception']);
    await app.ready();

    expect(app.routePermissions.get('GET /staff')).toBe('staff.manage');
    expect(app.routePermissions.get('GET /clinical/notes')).toBe('clinical.note.read');
    expect(app.routePermissions.has('GET /auth/self')).toBe(false);
    await app.close();
  });
});

describe('a route must say who may call it', () => {
  const { app } = server(['reception']);

  it('refuses at boot a route with neither a permission nor public', () => {
    expect(() => app.get('/orphan', { config: { readOnly: 'read' } }, () => ({}))).toThrow(
      /orphan/,
    );
  });

  it('refuses at boot a "signed-in is enough" route outside the self-service prefix', () => {
    expect(() =>
      app.get('/patients/export', { config: { readOnly: 'read', auth: 'session' } }, () => ({})),
    ).toThrow(/patients\/export/);
  });

  it('refuses at boot a permission that is not in the catalog', () => {
    expect(() =>
      app.get(
        '/invented',
        { config: { readOnly: 'read', permission: 'patients.delete' as Permission } },
        () => ({}),
      ),
    ).toThrow(/invented/);
  });

  it('accepts a permission route anywhere', () => {
    expect(() =>
      app.get(
        '/reports/day',
        { config: { readOnly: 'read', permission: 'reports.read' } },
        () => ({}),
      ),
    ).not.toThrow();
  });
});
