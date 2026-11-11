import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import { stubAuthz } from '../../testing/authz.js';
import { testTenancy } from '../../testing/tenancy.js';

import { registerPortalGuard, type PortalSessionInfo } from './portal-guard.js';
import { portalCookieName } from './portal-session.js';
import { sessionCookieName } from './session-cookie.js';

const TENANT = '0190a000-0000-7000-8000-0000000000e1';
const TOKEN = 'P'.repeat(43);
const PORTAL_COOKIE = `${portalCookieName(true)}=${TOKEN}`;
const STAFF_COOKIE = `${sessionCookieName(true)}=${'T'.repeat(43)}`;
const SESSION: PortalSessionInfo = {
  sessionId: '0190a000-0000-7000-8000-0000000000c1',
  identityId: '0190a000-0000-7000-8000-0000000000c2',
  tenantId: TENANT,
  linkId: '0190a000-0000-7000-8000-0000000000c3',
};

/** What `testTenancy()` answers for: a host `testco.consultorio.test` of the tenant above. */
const HOST = 'testco.consultorio.test';

function server(options: { session?: PortalSessionInfo | null } = {}) {
  const asked: { token: string; tenantId: string }[] = [];
  const denials: unknown[] = [];
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    ...testTenancy(),
    auth: {
      authz: stubAuthz,
      cookieSecure: true,
      authenticate: () => Promise.resolve(null),
    },
    routes: [
      (scope) => {
        registerPortalGuard(scope, {
          cookieSecure: true,
          authenticate: (token, tenantId) => {
            asked.push({ token, tenantId });
            return Promise.resolve(options.session === undefined ? SESSION : options.session);
          },
          auditDeny: (_tenantId, event) => {
            denials.push(event);
            return Promise.resolve({ recorded: true });
          },
        });
        scope.get(
          '/portal/who',
          { config: { readOnly: 'read', auth: 'portal', portalPermission: 'portal.self.read' } },
          (request) => ({
            actor: request.portalActor,
            audit: request.auditActor,
            session: request.portalSession?.sessionId ?? null,
          }),
        );
        scope.post(
          '/portal/act',
          {
            config: {
              readOnly: 'write',
              auth: 'portal',
              portalPermission: 'portal.consent.sign',
            },
          },
          () => ({ done: true }),
        );
        scope.get('/auth/staff-only', { config: { readOnly: 'read', auth: 'session' } }, () => ({
          staff: true,
        }));
      },
    ],
  });
  return { app, asked, denials };
}

const headers = (extra: Record<string, string> = {}) => ({
  host: HOST,
  cookie: PORTAL_COOKIE,
  ...extra,
});

describe('the guard of the patient portal', () => {
  it('answers 401 to a portal route without a cookie, and never reaches the handler', async () => {
    const { app, asked } = server();

    const response = await app.inject({ url: '/portal/who', headers: { host: HOST } });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
    expect(response.body).not.toContain('actor');
    expect(asked).toEqual([]);
    await app.close();
  });

  it('does not take a staff cookie for a portal one: a staff session on a portal route is denied', async () => {
    const { app, asked } = server();

    const response = await app.inject({
      url: '/portal/who',
      headers: { host: HOST, cookie: STAFF_COOKIE },
    });

    expect(response.statusCode).toBe(401);
    expect(asked).toEqual([]);
    await app.close();
  });

  it('does not take a portal cookie for a staff one: a patient session on a staff route is denied', async () => {
    const { app } = server();

    const response = await app.inject({ url: '/auth/staff-only', headers: headers() });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('builds the portal actor from the session, with the tenant of the host and a patient audit actor', async () => {
    const { app, asked } = server();

    const response = await app.inject({ url: '/portal/who', headers: headers() });

    expect(response.statusCode).toBe(200);
    expect(asked).toEqual([{ token: TOKEN, tenantId: TENANT }]);
    expect(response.json()).toMatchObject({
      actor: {
        kind: 'portal',
        tenantId: TENANT,
        identityId: SESSION.identityId,
        linkId: SESSION.linkId,
      },
      audit: { userId: null, actingRole: 'patient' },
      session: SESSION.sessionId,
    });
    await app.close();
  });

  it('answers 401 to a cookie that is no live session and clears it', async () => {
    const { app } = server({ session: null });

    const response = await app.inject({ url: '/portal/who', headers: headers() });

    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toContain('__Host-psid=;');
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    await app.close();
  });

  it('never asks the database about a malformed cookie', async () => {
    const { app, asked } = server();

    const response = await app.inject({
      url: '/portal/who',
      headers: { host: HOST, cookie: `${portalCookieName(true)}=short` },
    });

    expect(response.statusCode).toBe(401);
    expect(asked).toEqual([]);
    await app.close();
  });

  it('refuses a session of another organization, even if the lookup returned it', async () => {
    const { app } = server({
      session: { ...SESSION, tenantId: '0190a000-0000-7000-8000-0000000000e2' },
    });

    const response = await app.inject({ url: '/portal/who', headers: headers() });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('checks the origin of a write: the same host passes, a foreign one and none are refused', async () => {
    const { app } = server();
    const post = (extra: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/portal/act', headers: headers(extra), payload: {} });

    expect((await post({ origin: `https://${HOST}` })).statusCode).toBe(200);
    expect((await post({ origin: 'https://evil.example' })).statusCode).toBe(403);
    // A browser always sends the origin of a cross-site POST; a cookie without one is no browser.
    expect((await post({})).statusCode).toBe(403);
    await app.close();
  });

  it('lets a read through without an origin', async () => {
    const { app } = server();

    const response = await app.inject({ url: '/portal/who', headers: headers() });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
