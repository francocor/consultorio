import {
  LoginResponse,
  Problem,
  RecoveryCodesResponse,
  TwoFactorEnrollStartResponse,
  type AuditAction,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { userAccount } from '../../src/db/schema/identity.js';
import { codeAt, decodeBase32Secret, totpStepAt } from '../../src/platform/crypto/totp.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { browserHeaders, buildTestApplication, hostOf, sessionCookieOf } from '../support/app.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { addTestMembership, createTestUser, type TestUser } from '../support/users.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PASSWORD = 'la contraseña vieja de las pruebas';
const NEW_PASSWORD = 'otra frase larga y nueva para entrar';

let runtime: DbHandle;
let app: FastifyInstance;
let email: FakeEmailSender;
let a: TestTenant;
let b: TestTenant;
let now = new Date('2026-10-16T09:00:00.000Z').getTime();
const advance = (ms: number) => {
  now += ms;
};

let testIp = '';
let ipCounter = 0;
beforeEach(() => {
  ipCounter += 1;
  testIp = `10.40.${String(Math.floor(ipCounter / 250))}.${String((ipCounter % 250) + 1)}`;
  email.clear();
});

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  email = createFakeEmailSender();
  app = buildTestApplication(runtime, { clock: () => new Date(now), email });
  a = await createTestTenant(runtime, { slug: 'reset-a' });
  b = await createTestTenant(runtime, { slug: 'reset-b' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const post = (slug: string, url: string, payload: unknown, cookie?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: browserHeaders(slug, cookie),
    remoteAddress: testIp,
    payload: payload as object,
  });

const requestReset = async (address: string, slug = 'reset-a') => {
  const response = await post(slug, '/auth/password-reset/request', { email: address });
  await app.background.idle();
  return response;
};
const complete = (token: string, password = NEW_PASSWORD, slug = 'reset-a') =>
  post(slug, '/auth/password-reset/complete', { token, password });
const login = (address: string, password: string, slug = 'reset-a') =>
  post(slug, '/auth/login', { email: address, password });

const tokenFrom = (address: string): string => {
  const link = email.linkIn(email.lastTo(address));
  const token = link ? new URL(link).searchParams.get('token') : null;
  if (!token) throw new Error('no reset link was sent');
  return token;
};

const strip = (body: unknown) => ({ ...Problem.parse(body), requestId: 'x' });

async function newUser(tenant = a, address?: string): Promise<TestUser> {
  return createTestUser(runtime, tenant.id, {
    roles: ['reception'],
    password: PASSWORD,
    ...(address === undefined ? {} : { email: address }),
  });
}

async function auditRows(action: AuditAction, tenant = a) {
  return asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('requesting a reset (identity-access, "Audited, non-enumerating password reset")', () => {
  it('gives an existing and an unknown account the same neutral answer', async () => {
    const user = await newUser();

    const known = await requestReset(user.email);
    const unknown = await requestReset('nobody-at-all@example.test');

    expect(known.statusCode).toBe(204);
    expect(unknown.statusCode).toBe(204);
    expect(known.body).toBe(unknown.body);
    expect(Object.keys(known.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
  });

  it('names the organization as people know it, not by its slug', async () => {
    const branded = await createTestTenant(runtime, {
      slug: 'reset-branded',
      theme: { displayName: 'Clínica Ñandú' },
    });
    const user = await newUser(branded);

    await requestReset(user.email, 'reset-branded');

    const message = email.lastTo(user.email);
    expect(message?.subject).toBe('Restablezca su contraseña de Clínica Ñandú');
    expect(message?.subject).not.toContain('reset-branded');
  });

  it('emails only the account holder, in es-AR, with a single-use link on the tenant host', async () => {
    const user = await newUser();

    await requestReset(user.email);
    await requestReset('nobody-at-all@example.test');

    expect(email.sent).toHaveLength(1);
    const message = email.lastTo(user.email);
    expect(message?.subject).toContain('Restablezca su contraseña');
    expect(message?.text).toContain('30 minutos');
    const link = new URL(email.linkIn(message) ?? '');
    expect(link.host).toBe(hostOf('reset-a'));
    expect(link.pathname).toBe('/reset-password');
    expect(link.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sends nothing for an account that belongs to another organization', async () => {
    const user = await newUser(b);

    const response = await requestReset(user.email, 'reset-a');

    expect(response.statusCode).toBe(204);
    expect(email.sent).toEqual([]);
  });

  it('audits the issue of the link without the link, the token or the address', async () => {
    const user = await newUser();

    await requestReset(user.email);
    const token = tokenFrom(user.email);

    const [row] = await auditRows('auth.password.reset_requested');
    expect(row).toMatchObject({ actorUserId: user.id, outcome: 'allow' });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(user.email);
  });

  it('sends at most three links per account per hour, still answering the same', async () => {
    const user = await newUser();

    const answers: number[] = [];
    for (let i = 0; i < 5; i += 1) answers.push((await requestReset(user.email)).statusCode);

    expect(answers).toEqual([204, 204, 204, 204, 204]);
    expect(email.sent).toHaveLength(3);
  });

  it('cancels the older links when a new one is requested', async () => {
    const user = await newUser();
    await requestReset(user.email);
    const first = tokenFrom(user.email);
    await requestReset(user.email);
    const second = tokenFrom(user.email);

    expect((await complete(first)).statusCode).toBe(400);
    expect((await complete(second)).statusCode).toBe(204);
  });

  it('rejects a malformed address without sending anything', async () => {
    const response = await post('reset-a', '/auth/password-reset/request', { email: 'nope' });

    expect(response.statusCode).toBe(400);
    expect(email.sent).toEqual([]);
  });
});

describe('completing a reset', () => {
  it('sets the new password: the old one stops working and the new one signs in', async () => {
    const user = await newUser();
    await requestReset(user.email);

    const response = await complete(tokenFrom(user.email));

    expect(response.statusCode).toBe(204);
    expect((await login(user.email, PASSWORD)).statusCode).toBe(401);
    advance(2 * MINUTE);
    expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('works once: the second use of the same link fails and the password stays', async () => {
    const user = await newUser();
    await requestReset(user.email);
    const token = tokenFrom(user.email);
    await complete(token);

    const again = await complete(token, 'yet another long phrase to use');

    expect(again.statusCode).toBe(400);
    expect(Problem.parse(again.json()).code).toBe('bad_request');
    advance(2 * MINUTE);
    expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('fails after 30 minutes and leaves the password unchanged', async () => {
    const user = await newUser();
    await requestReset(user.email);
    const token = tokenFrom(user.email);

    advance(30 * MINUTE);
    const response = await complete(token);

    expect(response.statusCode).toBe(400);
    expect((await login(user.email, PASSWORD)).statusCode).toBe(200);
  });

  it('answers an invented token and an expired one the same way', async () => {
    const user = await newUser();
    await requestReset(user.email);
    const token = tokenFrom(user.email);
    advance(31 * MINUTE);

    const expired = await complete(token);
    const invented = await complete('x'.repeat(43));

    expect(strip(expired.json())).toEqual(strip(invented.json()));
  });

  it('refuses a weak password with the reasons, and does not use up the link', async () => {
    const user = await newUser();
    await requestReset(user.email);
    const token = tokenFrom(user.email);

    const weak = await complete(token, '1234');
    const common = await complete(token, 'password1234');
    const good = await complete(token);

    expect(weak.statusCode).toBe(400);
    expect(Problem.parse(weak.json())).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'password', i18nKey: 'auth.password.too_short' }],
    });
    expect(Problem.parse(common.json()).errors).toEqual([
      { path: 'password', i18nKey: 'auth.password.common' },
    ]);
    expect(good.statusCode).toBe(204);
  });

  it('refuses a password built from the account email', async () => {
    const user = await newUser(a, 'carolina.fernandez@clinica.example');
    await requestReset(user.email);

    const response = await complete(tokenFrom(user.email), 'carolina.fernandez-2026!');

    expect(Problem.parse(response.json()).errors).toEqual([
      { path: 'password', i18nKey: 'auth.password.contains_email' },
    ]);
  });

  it('ends every session of the user, in every organization', async () => {
    const user = await newUser(a);
    await addTestMembership(runtime, b.id, user.id);
    const inA = sessionCookieOf(
      (await login(user.email, PASSWORD, 'reset-a')).headers['set-cookie'],
    );
    const inB = sessionCookieOf(
      (await login(user.email, PASSWORD, 'reset-b')).headers['set-cookie'],
    );
    await requestReset(user.email);

    await complete(tokenFrom(user.email));

    for (const [slug, cookie] of [
      ['reset-a', inA],
      ['reset-b', inB],
    ] as const) {
      const me = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { host: hostOf(slug), cookie },
      });
      expect(me.statusCode).toBe(401);
    }
  });

  it('does not sign anyone in, and does not bypass the second factor', async () => {
    const user = await createTestUser(runtime, a.id, {
      roles: ['professional'],
      password: PASSWORD,
      firstSignInAt: new Date(now),
    });
    const cookie = sessionCookieOf((await login(user.email, PASSWORD)).headers['set-cookie']);
    const started = TwoFactorEnrollStartResponse.parse(
      (await post('reset-a', '/auth/2fa/enroll/start', {}, cookie)).json(),
    );
    const code = codeAt(decodeBase32Secret(started.secret), totpStepAt(new Date(now)));
    const confirmed = await post('reset-a', '/auth/2fa/enroll/confirm', { code }, cookie);
    expect(RecoveryCodesResponse.parse(confirmed.json()).recoveryCodes).toHaveLength(10);
    await requestReset(user.email);

    const done = await complete(tokenFrom(user.email));
    advance(2 * MINUTE);
    const next = await login(user.email, NEW_PASSWORD);

    expect(done.headers['set-cookie']).toBeUndefined();
    expect(LoginResponse.parse(next.json()).next).toBe('totp');
    expect(next.headers['set-cookie']).toBeUndefined();
  });

  it('lifts a lock: recovering the account is an authorized way back in, and is audited', async () => {
    const user = await newUser();
    for (let i = 0; i < 10; i += 1) {
      advance(2 * MINUTE);
      await login(user.email, 'wrong password number ' + String(i));
    }
    advance(MINUTE);
    expect((await login(user.email, PASSWORD)).statusCode).toBe(401);
    await requestReset(user.email);

    await complete(tokenFrom(user.email));

    advance(SECOND);
    expect((await login(user.email, NEW_PASSWORD)).statusCode).toBe(200);
    const [unlocked] = await auditRows('auth.account.unlocked');
    expect(unlocked).toMatchObject({ actorUserId: user.id, reason: 'password_reset' });
  });

  it('audits the completion without the token or any password', async () => {
    const user = await newUser();
    await requestReset(user.email);
    const token = tokenFrom(user.email);

    await complete(token);

    const [row] = await auditRows('auth.password.reset_completed');
    expect(row).toMatchObject({ actorUserId: user.id, outcome: 'allow' });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(NEW_PASSWORD);
  });

  it('stores only a hash of the new password', async () => {
    const user = await newUser();
    await requestReset(user.email);
    await complete(tokenFrom(user.email));

    const [row] = await createWithTenant(runtime.db)({ tenantId: a.id, userId: user.id }, (tx) =>
      tx.select().from(userAccount).where(eq(userAccount.id, user.id)),
    );

    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(NEW_PASSWORD);
    expect(row?.passwordChangedAt).toBeInstanceOf(Date);
  });
});

describe('a reset link is a bearer secret and is never logged', () => {
  it('does not appear in the response or its headers', async () => {
    const user = await newUser();

    const response = await requestReset(user.email);
    const token = tokenFrom(user.email);

    expect(response.body).not.toContain(token);
    expect(JSON.stringify(response.headers)).not.toContain(token);
  });
});

describe('POST /users/:id/password-reset (an administrator can only trigger the email)', () => {
  async function admin(roles: ('owner' | 'admin' | 'reception')[] = ['owner']) {
    const user = await createTestUser(runtime, a.id, { roles, password: PASSWORD });
    const cookie = sessionCookieOf((await login(user.email, PASSWORD)).headers['set-cookie']);
    return { user, cookie };
  }

  it('sends the target the reset email and answers 204, audited as triggered by the admin', async () => {
    const { user: boss, cookie } = await admin(['owner']);
    const target = await newUser();

    const response = await post('reset-a', `/users/${target.id}/password-reset`, {}, cookie);
    await app.background.idle();

    expect(response.statusCode).toBe(204);
    expect(email.lastTo(target.email)?.subject).toContain('Restablezca su contraseña');
    expect(email.lastTo(boss.email)).toBeUndefined();
    const [row] = await auditRows('auth.password.reset_requested');
    expect(row).toMatchObject({
      actorUserId: boss.id,
      resourceType: 'user',
      resourceId: target.id,
      metadata: { triggeredBy: 'admin' },
    });
  });

  it('never changes the password: the target still signs in with the old one until they complete the reset', async () => {
    const { cookie } = await admin(['admin']);
    const target = await newUser();

    await post('reset-a', `/users/${target.id}/password-reset`, {}, cookie);
    await app.background.idle();

    expect((await login(target.email, PASSWORD)).statusCode).toBe(200);
  });

  it('rejects a body that tries to carry a password', async () => {
    const { cookie } = await admin(['owner']);
    const target = await newUser();

    const response = await post(
      'reset-a',
      `/users/${target.id}/password-reset`,
      { password: 'set-by-the-admin-123' },
      cookie,
    );
    await app.background.idle();

    expect(response.statusCode).toBe(400);
    expect(email.sent).toEqual([]);
    expect((await login(target.email, 'set-by-the-admin-123')).statusCode).toBe(401);
  });

  it('is refused to reception, who cannot manage staff', async () => {
    const { cookie } = await admin(['reception']);
    const target = await newUser();

    const response = await post('reset-a', `/users/${target.id}/password-reset`, {}, cookie);
    await app.background.idle();

    expect(response.statusCode).toBe(403);
    expect(email.sent).toEqual([]);
  });

  it('answers 404 for a user who is not in this organization', async () => {
    const { cookie } = await admin(['owner']);
    const stranger = await newUser(b);

    const response = await post('reset-a', `/users/${stranger.id}/password-reset`, {}, cookie);
    await app.background.idle();

    expect(response.statusCode).toBe(404);
    expect(email.sent).toEqual([]);
  });

  it('needs a signed-in user', async () => {
    const target = await newUser();

    const response = await post('reset-a', `/users/${target.id}/password-reset`, {});

    expect(response.statusCode).toBe(401);
  });
});
