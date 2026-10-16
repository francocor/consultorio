import { Problem } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../../main/server.js';
import { stubAuthz } from '../../testing/authz.js';
import { testTenancy } from '../../testing/tenancy.js';

import {
  PUBLIC_ROUTE_PREFIXES,
  isAllowedPublicPath,
  type AuthenticatedSession,
} from './auth-guard.js';
import { sessionCookieName } from './session-cookie.js';

/** Every app in this file runs with secure cookies, so the session cookie has its prefix. */
const SESSION_COOKIE = sessionCookieName(true);

const TOKEN = 'T'.repeat(43);
const COOKIE = `${SESSION_COOKIE}=${TOKEN}`;
const SESSION: AuthenticatedSession = {
  sessionId: '0190a000-0000-7000-8000-0000000000b1',
  userId: '0190a000-0000-7000-8000-0000000000b2',
  membershipId: '0190a000-0000-7000-8000-0000000000b3',
  tenantId: '0190a000-0000-7000-8000-0000000000e1',
  roles: ['owner', 'professional'],
  scope: 'full',
};

function server(options: { known?: string[] } = {}) {
  const calls: { token: string; tenantId: string }[] = [];
  const app = buildServer({
    logLevel: 'silent',
    health: { checkDatabase: () => Promise.resolve({ ok: true }) },
    ...testTenancy(),
    auth: {
      authz: stubAuthz,
      cookieSecure: true,
      authenticate: (token, tenantId) => {
        calls.push({ token, tenantId });
        return Promise.resolve((options.known ?? [TOKEN]).includes(token) ? SESSION : null);
      },
    },
    routes: [
      (scope) => {
        scope.get('/auth/open', { config: { readOnly: 'read', auth: 'public' } }, () => ({
          open: true,
        }));
        scope.get(
          '/auth/private/who',
          { config: { readOnly: 'read', auth: 'session' } },
          (request) => ({
            user: request.session?.userId ?? null,
            actor: request.auditActor,
          }),
        );
      },
    ],
  });
  return { app, calls };
}

describe('authentication guard', () => {
  it('lets a public route answer without a session', async () => {
    const { app, calls } = server();

    const response = await app.inject({ url: '/auth/open' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ open: true });
    expect(calls).toEqual([]);
    await app.close();
  });

  it('answers 401 unauthenticated to a protected route with no cookie, and discloses nothing', async () => {
    const { app } = server();

    const response = await app.inject({ url: '/auth/private/who' });

    expect(response.statusCode).toBe(401);
    expect(Problem.parse(response.json())).toMatchObject({ code: 'unauthenticated' });
    expect(response.body).not.toContain('user');
    await app.close();
  });

  it('answers 401 to a cookie that is not a valid session and clears it', async () => {
    const { app, calls } = server({ known: [] });

    const response = await app.inject({ url: '/auth/private/who', headers: { cookie: COOKIE } });

    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect(calls).toEqual([{ token: TOKEN, tenantId: '0190a000-0000-7000-8000-0000000000e1' }]);
    await app.close();
  });

  it('never asks the database about a malformed cookie', async () => {
    const { app, calls } = server();

    const response = await app.inject({
      url: '/auth/private/who',
      headers: { cookie: `${SESSION_COOKIE}=short` },
    });

    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
    await app.close();
  });

  it('attaches the session to the request and fills the audit actor', async () => {
    const { app } = server();

    const response = await app.inject({ url: '/auth/private/who', headers: { cookie: COOKIE } });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: string; actor: Record<string, unknown> }>()).toMatchObject({
      user: SESSION.userId,
      actor: { userId: SESSION.userId, actingRole: 'owner' },
    });
    await app.close();
  });

  it('keeps the generic 404 for a route that does not exist, with or without a session', async () => {
    const { app } = server();

    const anonymous = await app.inject({ url: '/nothing-here' });
    const signedIn = await app.inject({ url: '/nothing-here', headers: { cookie: COOKIE } });

    expect(anonymous.statusCode).toBe(404);
    expect(signedIn.statusCode).toBe(404);
    await app.close();
  });

  it('refuses at boot a route that declares neither public nor session', () => {
    const { app } = server();

    expect(() => app.get('/forgotten', { config: { readOnly: 'read' } }, () => ({}))).toThrow(
      /forgotten/,
    );
  });
});

describe('the public allowlist (design 4.5)', () => {
  it.each([
    '/auth/login',
    '/auth/password-reset/request',
    '/public/clinica/booking/availability',
    '/public/t/abc',
    '/files/abc',
    '/webhooks/mercadopago',
    '/health',
    '/ready',
  ])('allows %s', (path) => {
    expect(isAllowedPublicPath(path)).toBe(true);
  });

  it.each([
    '/patients',
    '/users/1',
    '/authors',
    '/healthcheck',
    '/ready/extra',
    '/publicity',
    '/files',
    '//auth/login',
    '/AUTH/login',
  ])('does not allow %s', (path) => {
    expect(isAllowedPublicPath(path)).toBe(false);
  });

  it('lists the prefixes in one place', () => {
    expect(PUBLIC_ROUTE_PREFIXES).toContain('/auth/');
  });
});
