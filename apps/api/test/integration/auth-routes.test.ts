import {
  LoginResponse,
  MeResponse,
  Problem,
  SessionList,
  type AuditAction,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { membership, userAccount } from '../../src/db/schema/identity.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { browserHeaders, buildTestApplication, hostOf, sessionCookieOf } from '../support/app.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser, type TestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let a: TestTenant;
let ana: TestUser;

const PASSWORD = 'una frase larga para ana 2026';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  app = buildTestApplication(runtime);
  a = await createTestTenant(runtime, { slug: 'auth-a' });
  await createTestTenant(runtime, { slug: 'auth-b' });
  ana = await createTestUser(runtime, a.id, {
    email: 'ana@clinica-a.example',
    roles: ['owner', 'professional'],
    password: PASSWORD,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const login = (slug: string, email: string, password: string, cookie?: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: browserHeaders(slug, cookie),
    payload: { email, password },
  });

const me = (slug: string, cookie: string) =>
  app.inject({ method: 'GET', url: '/auth/me', headers: { host: hostOf(slug), cookie } });

async function signIn(slug = 'auth-a', email = ana.email) {
  const response = await login(slug, email, PASSWORD);
  expect(response.statusCode).toBe(200);
  return sessionCookieOf(response.headers['set-cookie']);
}

async function auditRows(tenant: TestTenant, action: AuditAction) {
  return asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('POST /auth/login', () => {
  it('signs in with the right credentials: an HttpOnly cookie and no token in the body', async () => {
    const response = await login('auth-a', ana.email, PASSWORD);

    expect(response.statusCode).toBe(200);
    expect(LoginResponse.parse(response.json())).toEqual({ next: 'authenticated' });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800$/,
    );
    const token = sessionCookieOf(setCookie).slice('sid='.length);
    expect(response.body).not.toContain(token);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('accepts the email in any case', async () => {
    const response = await login('auth-a', 'ANA@Clinica-A.example', PASSWORD);

    expect(response.statusCode).toBe(200);
  });

  it('gives a wrong password and an unknown email the same status, body and headers', async () => {
    const wrong = await login('auth-a', ana.email, 'not the password at all');
    const unknown = await login('auth-a', 'nobody@clinica-a.example', 'not the password at all');

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    const strip = (body: unknown) => ({ ...Problem.parse(body), requestId: 'x' });
    expect(strip(wrong.json())).toEqual(strip(unknown.json()));
    expect(strip(wrong.json())).toMatchObject({ code: 'unauthenticated' });
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(unknown.headers['set-cookie']).toBeUndefined();
    expect(wrong.headers['content-type']).toBe(unknown.headers['content-type']);
  });

  it('refuses a deactivated user even with the right password, with the same generic answer', async () => {
    const gone = await createTestUser(runtime, a.id, {
      email: 'gone@clinica-a.example',
      password: PASSWORD,
    });
    await asTenant(runtime, a.id, (tx) =>
      tx.update(membership).set({ status: 'deactivated' }).where(eq(membership.userId, gone.id)),
    );

    const response = await login('auth-a', gone.email, PASSWORD);

    expect(response.statusCode).toBe(401);
    expect(Problem.parse(response.json()).code).toBe('unauthenticated');
    const failures = await auditRows(a, 'auth.login.failed');
    expect(
      failures.some((row) => row.actorUserId === gone.id && row.reason === 'inactive_membership'),
    ).toBe(true);
  });

  it('does not sign a user in on the host of an organization they do not belong to', async () => {
    const response = await login('auth-b', ana.email, PASSWORD);

    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a malformed body with a validation error that echoes nothing back', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: browserHeaders('auth-a'),
      payload: { email: 'not-an-email', password: 'secret-value-123' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('secret-value-123');
    expect(Problem.parse(response.json()).code).toBe('validation_failed');
  });

  it('refuses a cross-origin login with 403', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { host: hostOf('auth-a'), origin: 'https://evil.example' },
      payload: { email: ana.email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });

  it('starts the 7-day two-factor grace at the first sign-in only', async () => {
    const fresh = await createTestUser(runtime, a.id, { password: PASSWORD });
    const firstSignIn = () =>
      createWithTenant(runtime.db)({ tenantId: a.id, userId: fresh.id }, async (tx) => {
        const [row] = await tx
          .select({ at: userAccount.firstSignInAt })
          .from(userAccount)
          .where(eq(userAccount.id, fresh.id));
        return row?.at ?? null;
      });
    expect(await firstSignIn()).toBeNull();

    await login('auth-a', fresh.email, PASSWORD);
    const first = await firstSignIn();
    await login('auth-a', fresh.email, PASSWORD);

    expect(first).toBeInstanceOf(Date);
    expect((await firstSignIn())?.getTime()).toBe(first?.getTime());
  });

  it('replaces the session of the cookie it was called with (rotation on login)', async () => {
    const first = await signIn();

    const second = await login('auth-a', ana.email, PASSWORD, first);
    const secondCookie = sessionCookieOf(second.headers['set-cookie']);

    expect(secondCookie).not.toBe(first);
    expect((await me('auth-a', first)).statusCode).toBe(401);
    expect((await me('auth-a', secondCookie)).statusCode).toBe(200);
  });
});

describe('GET /auth/me', () => {
  it('describes the user of the session: roles and the permissions they give', async () => {
    const cookie = await signIn();

    const response = await me('auth-a', cookie);

    expect(response.statusCode).toBe(200);
    const profile = MeResponse.parse(response.json());
    expect(profile).toMatchObject({
      user: { id: ana.id, email: ana.email },
      roles: ['owner', 'professional'],
      scope: 'full',
    });
    expect(profile.permissions).toContain('clinical.note.read');
    expect(profile.permissions).toContain('staff.manage');
    expect(response.body).not.toContain('argon2');
  });

  it('answers 401 without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { host: hostOf('auth-a') },
    });

    expect(response.statusCode).toBe(401);
    expect(Problem.parse(response.json()).code).toBe('unauthenticated');
  });

  it('answers 401 when the cookie of one organization is replayed on another organization', async () => {
    const cookie = await signIn('auth-a');

    const replay = await me('auth-b', cookie);

    expect(replay.statusCode).toBe(401);
    expect((await me('auth-a', cookie)).statusCode).toBe(200);
  });

  it('answers 401 once the membership is deactivated', async () => {
    const temp = await createTestUser(runtime, a.id, { password: PASSWORD });
    const cookie = sessionCookieOf(
      (await login('auth-a', temp.email, PASSWORD)).headers['set-cookie'],
    );
    expect((await me('auth-a', cookie)).statusCode).toBe(200);

    await asTenant(runtime, a.id, (tx) =>
      tx.update(membership).set({ status: 'deactivated' }).where(eq(membership.userId, temp.id)),
    );

    expect((await me('auth-a', cookie)).statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('ends the session on the server, clears the cookie and is audited', async () => {
    const cookie = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: browserHeaders('auth-a', cookie),
    });

    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await me('auth-a', cookie)).statusCode).toBe(401);
    const rows = await auditRows(a, 'auth.logout');
    expect(rows[0]).toMatchObject({ actorUserId: ana.id, outcome: 'allow', actingRole: 'owner' });
  });

  it('refuses a logout without Origin when a cookie is sent', async () => {
    const cookie = await signIn();

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { host: hostOf('auth-a'), cookie },
    });

    expect(response.statusCode).toBe(403);
    expect((await me('auth-a', cookie)).statusCode).toBe(200);
  });
});

describe('GET and DELETE /auth/sessions', () => {
  it('lists the sessions of the user, marking the one in use', async () => {
    const mobile = await signIn();
    const desktop = await signIn();

    const response = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { host: hostOf('auth-a'), cookie: desktop },
    });

    expect(response.statusCode).toBe(200);
    const { sessions } = SessionList.parse(response.json());
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((entry) => entry.current)).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ current: true, userAgent: 'vitest-browser' });
    expect(response.body).not.toContain(mobile.slice('sid='.length));
  });

  it('revokes another session: it fails on its next request, and the revocation is audited', async () => {
    const mobile = await signIn();
    const desktop = await signIn();
    const list = await app.inject({
      method: 'GET',
      url: '/auth/sessions',
      headers: { host: hostOf('auth-a'), cookie: desktop },
    });
    const other = SessionList.parse(list.json()).sessions.find((entry) => !entry.current);
    expect(other).toBeDefined();

    // Revoke every non-current session one by one; the mobile one must be among them.
    for (const entry of SessionList.parse(list.json()).sessions.filter((s) => !s.current)) {
      const revoked = await app.inject({
        method: 'DELETE',
        url: `/auth/sessions/${entry.id}`,
        headers: browserHeaders('auth-a', desktop),
      });
      expect(revoked.statusCode).toBe(204);
    }

    expect((await me('auth-a', mobile)).statusCode).toBe(401);
    expect((await me('auth-a', desktop)).statusCode).toBe(200);
    const rows = await auditRows(a, 'auth.session.revoked');
    expect(rows[0]).toMatchObject({ actorUserId: ana.id, resourceType: 'session' });
  });

  it('answers 404 for a session id that does not exist or belongs to someone else', async () => {
    const other = await createTestUser(runtime, a.id, { password: PASSWORD });
    const theirs = sessionCookieOf(
      (await login('auth-a', other.email, PASSWORD)).headers['set-cookie'],
    );
    const theirList = SessionList.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/auth/sessions',
          headers: { host: hostOf('auth-a'), cookie: theirs },
        })
      ).json(),
    );
    const mine = await signIn();

    const stranger = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${theirList.sessions[0]?.id ?? ''}`,
      headers: browserHeaders('auth-a', mine),
    });
    const missing = await app.inject({
      method: 'DELETE',
      url: '/auth/sessions/0190a000-0000-7000-8000-00000000dead',
      headers: browserHeaders('auth-a', mine),
    });

    expect(stranger.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect((await me('auth-a', theirs)).statusCode).toBe(200);
  });
});

describe('audit of authentication events (identity-access, "Authentication events audited")', () => {
  it('records a successful login with actor, role, origin and request id', async () => {
    const response = await login('auth-a', ana.email, PASSWORD);

    const [row] = await auditRows(a, 'auth.login.success');

    expect(row).toMatchObject({
      tenantId: a.id,
      actorUserId: ana.id,
      actingRole: 'owner',
      outcome: 'allow',
      userAgent: 'vitest-browser',
      requestId: response.headers['x-request-id'],
    });
    expect(row?.ip).toBeTruthy();
  });

  it('records a failed login without the attempted password or the account email', async () => {
    const attempt = 'a-secret-attempt-that-must-not-leak';
    await login('auth-a', ana.email, attempt);

    const [row] = await auditRows(a, 'auth.login.failed');

    expect(row).toMatchObject({ outcome: 'deny', reason: 'bad_credentials', actorUserId: ana.id });
    expect(JSON.stringify(row)).not.toContain(attempt);
    expect(JSON.stringify(row)).not.toContain(ana.email);
  });

  it('records a failure for an unknown identifier with no actor', async () => {
    await login('auth-a', 'ghost@clinica-a.example', 'whatever-password-here');

    const [row] = await auditRows(a, 'auth.login.failed');

    expect(row).toMatchObject({ outcome: 'deny', reason: 'bad_credentials', actorUserId: null });
    expect(JSON.stringify(row)).not.toContain('ghost@');
  });
});
