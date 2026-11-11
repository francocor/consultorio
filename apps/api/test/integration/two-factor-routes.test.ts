import { randomBytes } from 'node:crypto';

import {
  LoginResponse,
  MeResponse,
  Problem,
  RecoveryCodesResponse,
  TwoFactorEnrollStartResponse,
  type AuditAction,
  type Role,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { codeAt, decodeBase32Secret, totpStepAt } from '../../src/platform/crypto/totp.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication, hostOf, sessionCookieOf } from '../support/app.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser, type TestUser } from '../support/users.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const PASSWORD = 'la contraseña de las pruebas 2fa';

let runtime: DbHandle;
let app: FastifyInstance;
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
  testIp = `10.30.${String(Math.floor(ipCounter / 250))}.${String((ipCounter % 250) + 1)}`;
});

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  app = buildTestApplication(runtime, {
    clock: () => new Date(now),
    keys: createTenantKeys({
      kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
      now: () => now,
    }),
  });
  a = await createTestTenant(runtime, { slug: 'twofa-a' });
  b = await createTestTenant(runtime, { slug: 'twofa-b' });
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
const get = (slug: string, url: string, cookie?: string) =>
  app.inject({
    method: 'GET',
    url,
    headers: { host: hostOf(slug), ...(cookie === undefined ? {} : { cookie }) },
    remoteAddress: testIp,
  });

const login = (email: string, slug = 'twofa-a') =>
  post(slug, '/auth/login', { email, password: PASSWORD });
const codeNow = (secretBase32: string) =>
  codeAt(decodeBase32Secret(secretBase32), totpStepAt(new Date(now)));

const strip = (body: unknown) => ({ ...Problem.parse(body), requestId: 'x' });

async function newUser(
  roles: Role[] = ['professional'],
  firstSignInDaysAgo: number | null = 1,
  tenantOf: TestTenant = a,
): Promise<TestUser> {
  return createTestUser(runtime, tenantOf.id, {
    roles,
    password: PASSWORD,
    firstSignInAt: firstSignInDaysAgo === null ? null : new Date(now - firstSignInDaysAgo * DAY),
  });
}

/** Signs in and enrolls the second factor through the API, as a user would. */
async function enrolledUser(roles: Role[] = ['professional']) {
  const user = await newUser(roles);
  const first = await login(user.email);
  const cookie = sessionCookieOf(first.headers['set-cookie']);
  const started = TwoFactorEnrollStartResponse.parse(
    (await post('twofa-a', '/auth/2fa/enroll/start', {}, cookie)).json(),
  );
  const confirmed = await post(
    'twofa-a',
    '/auth/2fa/enroll/confirm',
    { code: codeNow(started.secret) },
    cookie,
  );
  expect(confirmed.statusCode).toBe(200);
  const { recoveryCodes } = RecoveryCodesResponse.parse(confirmed.json());
  advance(31 * SECOND);
  const upgraded = confirmed.headers['set-cookie'];
  return {
    user,
    secret: started.secret,
    recoveryCodes,
    // A full session keeps its cookie; an enrollment-only one comes back upgraded.
    cookie: upgraded === undefined ? cookie : sessionCookieOf(upgraded),
  };
}

async function startChallenge(email: string, slug = 'twofa-a'): Promise<string> {
  const response = await login(email, slug);
  const body = LoginResponse.parse(response.json());
  if (body.next !== 'totp') throw new Error(`expected a challenge, got ${body.next}`);
  return body.challenge;
}

async function auditRows(action: AuditAction, tenantOf: TestTenant = a) {
  return asTenant(runtime, tenantOf.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenantOf.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('who must have a second factor, by role and grace period', () => {
  it.each([['owner'], ['admin'], ['professional']] as [Role][])(
    '%s inside the grace period gets a full session and is told to enroll',
    async (role) => {
      const user = await newUser([role], 3);

      const response = await login(user.email);

      expect(LoginResponse.parse(response.json())).toEqual({ next: 'authenticated' });
      const cookie = sessionCookieOf(response.headers['set-cookie']);
      const me = MeResponse.parse((await get('twofa-a', '/auth/me', cookie)).json());
      expect(me.scope).toBe('full');
      expect(me.twoFactor).toEqual({
        enrolled: false,
        required: true,
        graceEndsAt: new Date(now - 3 * DAY + 7 * DAY).toISOString(),
      });
    },
  );

  it.each([['owner'], ['admin'], ['professional']] as [Role][])(
    '%s after the grace period only reaches the enrollment endpoints',
    async (role) => {
      const user = await newUser([role], 8);

      const response = await login(user.email);

      expect(LoginResponse.parse(response.json())).toEqual({ next: 'enrollment' });
      const cookie = sessionCookieOf(response.headers['set-cookie']);
      const me = MeResponse.parse((await get('twofa-a', '/auth/me', cookie)).json());
      expect(me.scope).toBe('two_factor_enrollment');
    },
  );

  it('starts the grace period at the first sign-in', async () => {
    const user = await newUser(['owner'], null);

    const response = await login(user.email);
    const cookie = sessionCookieOf(response.headers['set-cookie']);

    expect(LoginResponse.parse(response.json())).toEqual({ next: 'authenticated' });
    const me = MeResponse.parse((await get('twofa-a', '/auth/me', cookie)).json());
    expect(me.twoFactor.graceEndsAt).toBe(new Date(now + 7 * DAY).toISOString());
  });

  it('does not ask reception for a second factor unless the organization requires it', async () => {
    const user = await newUser(['reception'], 40);

    const response = await login(user.email);

    expect(LoginResponse.parse(response.json())).toEqual({ next: 'authenticated' });
    const cookie = sessionCookieOf(response.headers['set-cookie']);
    expect(MeResponse.parse((await get('twofa-a', '/auth/me', cookie)).json()).twoFactor).toEqual({
      enrolled: false,
      required: false,
      graceEndsAt: null,
    });
  });

  it('applies the same grace to reception when the organization requires 2FA', async () => {
    const strict = await createTestTenant(runtime, { slug: 'twofa-strict' });
    await asTenant(runtime, strict.id, (tx) =>
      tx
        .update(tenant)
        .set({ settings: { require_2fa: true } })
        .where(eq(tenant.id, strict.id)),
    );
    const fresh = await newUser(['reception'], 2, strict);
    const old = await newUser(['reception'], 10, strict);

    const inGrace = await login(fresh.email, 'twofa-strict');
    const afterGrace = await login(old.email, 'twofa-strict');

    expect(LoginResponse.parse(inGrace.json())).toEqual({ next: 'authenticated' });
    expect(LoginResponse.parse(afterGrace.json())).toEqual({ next: 'enrollment' });
  });

  it('an enrollment-scoped session gets 403 two_factor_enrollment_required everywhere else', async () => {
    const user = await newUser(['owner'], 9);
    const cookie = sessionCookieOf((await login(user.email)).headers['set-cookie']);

    const sessions = await get('twofa-a', '/auth/sessions', cookie);
    const revoke = await app.inject({
      method: 'DELETE',
      url: '/auth/sessions/0190a000-0000-7000-8000-00000000dead',
      headers: browserHeaders('twofa-a', cookie),
    });

    for (const response of [sessions, revoke]) {
      expect(response.statusCode).toBe(403);
      expect(Problem.parse(response.json()).code).toBe('two_factor_enrollment_required');
    }
    expect((await get('twofa-a', '/auth/me', cookie)).statusCode).toBe(200);
    expect((await post('twofa-a', '/auth/logout', {}, cookie)).statusCode).toBe(204);
    expect((await get('twofa-a', '/health')).statusCode).toBe(200);
  });
});

describe('enrolling', () => {
  it('starts with a secret and a link, and confirming with a right code returns recovery codes', async () => {
    const user = await newUser(['professional'], 1);
    const cookie = sessionCookieOf((await login(user.email)).headers['set-cookie']);

    const started = await post('twofa-a', '/auth/2fa/enroll/start', {}, cookie);
    const body = TwoFactorEnrollStartResponse.parse(started.json());
    const confirmed = await post(
      'twofa-a',
      '/auth/2fa/enroll/confirm',
      { code: codeNow(body.secret) },
      cookie,
    );

    expect(started.headers['cache-control']).toBe('no-store');
    expect(body.otpauthUri).toContain(`secret=${body.secret}`);
    expect(RecoveryCodesResponse.parse(confirmed.json()).recoveryCodes).toHaveLength(10);
    const events = await auditRows('auth.2fa.enrolled');
    expect(events[0]).toMatchObject({ actorUserId: user.id, outcome: 'allow' });
    expect(JSON.stringify(events[0])).not.toContain(body.secret);
  });

  it('refuses a wrong confirmation code and leaves the user not enrolled', async () => {
    const user = await newUser(['professional'], 1);
    const cookie = sessionCookieOf((await login(user.email)).headers['set-cookie']);
    const started = TwoFactorEnrollStartResponse.parse(
      (await post('twofa-a', '/auth/2fa/enroll/start', {}, cookie)).json(),
    );
    const real = codeNow(started.secret);

    const wrong = await post(
      'twofa-a',
      '/auth/2fa/enroll/confirm',
      { code: real === '000000' ? '000001' : '000000' },
      cookie,
    );

    expect(wrong.statusCode).toBe(400);
    const me = MeResponse.parse((await get('twofa-a', '/auth/me', cookie)).json());
    expect(me.twoFactor.enrolled).toBe(false);
  });

  it('upgrades an enrollment-only session to a full one, with a new cookie', async () => {
    const user = await newUser(['owner'], 9);
    const restricted = sessionCookieOf((await login(user.email)).headers['set-cookie']);
    const started = TwoFactorEnrollStartResponse.parse(
      (await post('twofa-a', '/auth/2fa/enroll/start', {}, restricted)).json(),
    );

    const confirmed = await post(
      'twofa-a',
      '/auth/2fa/enroll/confirm',
      { code: codeNow(started.secret) },
      restricted,
    );
    const full = sessionCookieOf(confirmed.headers['set-cookie']);

    expect(confirmed.statusCode).toBe(200);
    expect(full).not.toBe(restricted);
    expect((await get('twofa-a', '/auth/me', restricted)).statusCode).toBe(401);
    const me = MeResponse.parse((await get('twofa-a', '/auth/me', full)).json());
    expect(me).toMatchObject({ scope: 'full', twoFactor: { enrolled: true } });
    expect((await get('twofa-a', '/auth/sessions', full)).statusCode).toBe(200);
  });
});

describe('signing in with a second factor', () => {
  it('asks for a code after the password, grants no session, and a right code completes the sign-in', async () => {
    const { user, secret } = await enrolledUser();

    const first = await login(user.email);
    const body = LoginResponse.parse(first.json());

    expect(body.next).toBe('totp');
    expect(first.headers['set-cookie']).toBeUndefined();
    const challenge = body.next === 'totp' ? body.challenge : '';
    const done = await post('twofa-a', '/auth/2fa', { challenge, code: codeNow(secret) });
    expect(done.statusCode).toBe(200);
    expect(LoginResponse.parse(done.json())).toEqual({ next: 'authenticated' });
    const cookie = sessionCookieOf(done.headers['set-cookie']);
    expect(
      MeResponse.parse((await get('twofa-a', '/auth/me', cookie)).json()).twoFactor.enrolled,
    ).toBe(true);
    expect((await auditRows('auth.2fa.verified'))[0]).toMatchObject({ actorUserId: user.id });
    expect((await auditRows('auth.login.success'))[0]).toMatchObject({ actorUserId: user.id });
  });

  it('does not make a user wait after earlier typos: the code is accepted right after the password', async () => {
    const { user, secret } = await enrolledUser();
    for (let i = 0; i < 4; i += 1) {
      advance(2 * MINUTE);
      await post('twofa-a', '/auth/login', {
        email: user.email,
        password: 'a typo in the password',
      });
    }
    advance(2 * MINUTE);

    const challenge = await startChallenge(user.email);
    const done = await post('twofa-a', '/auth/2fa', { challenge, code: codeNow(secret) });

    expect(done.statusCode).toBe(200);
  });

  it('refuses a wrong code with the generic 401 and audits the failure', async () => {
    const { user, secret } = await enrolledUser();
    const challenge = await startChallenge(user.email);
    const wrong = codeNow(secret) === '123456' ? '654321' : '123456';

    const response = await post('twofa-a', '/auth/2fa', { challenge, code: wrong });

    expect(response.statusCode).toBe(401);
    expect(Problem.parse(response.json()).code).toBe('unauthenticated');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await auditRows('auth.2fa.failed'))[0]).toMatchObject({
      actorUserId: user.id,
      outcome: 'deny',
    });
  });

  it('refuses a code that was already used, even for a new challenge', async () => {
    const { user, secret } = await enrolledUser();
    const code = codeNow(secret);
    const first = await post('twofa-a', '/auth/2fa', {
      challenge: await startChallenge(user.email),
      code,
    });
    advance(3 * SECOND);

    const replay = await post('twofa-a', '/auth/2fa', {
      challenge: await startChallenge(user.email),
      code,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
  });

  it('uses a challenge once', async () => {
    const { user, secret } = await enrolledUser();
    const challenge = await startChallenge(user.email);
    const first = await post('twofa-a', '/auth/2fa', { challenge, code: codeNow(secret) });
    advance(31 * SECOND);

    const again = await post('twofa-a', '/auth/2fa', { challenge, code: codeNow(secret) });

    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(401);
  });

  it('lets a challenge live five minutes', async () => {
    const { user, secret } = await enrolledUser();
    const challenge = await startChallenge(user.email);

    advance(5 * MINUTE);

    const response = await post('twofa-a', '/auth/2fa', { challenge, code: codeNow(secret) });
    expect(response.statusCode).toBe(401);
  });

  it('allows five attempts per challenge: the sixth fails even with the right code', async () => {
    const { user, secret } = await enrolledUser();
    const challenge = await startChallenge(user.email);
    const wrong = codeNow(secret) === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i += 1) {
      advance(10 * SECOND);
      expect((await post('twofa-a', '/auth/2fa', { challenge, code: wrong })).statusCode).toBe(401);
    }

    const response = await post('twofa-a', '/auth/2fa', { challenge, code: codeNow(secret) });

    expect(response.statusCode).toBe(401);
  });

  it('answers an unknown challenge and a wrong code in exactly the same way', async () => {
    const { user, secret } = await enrolledUser();
    const challenge = await startChallenge(user.email);
    const wrongCode = codeNow(secret) === '123456' ? '654321' : '123456';

    const wrong = await post('twofa-a', '/auth/2fa', { challenge, code: wrongCode });
    const unknown = await post('twofa-a', '/auth/2fa', {
      challenge: 'x'.repeat(43),
      code: '123456',
    });

    expect(strip(wrong.json())).toEqual(strip(unknown.json()));
    expect(unknown.statusCode).toBe(wrong.statusCode);
  });

  it('does not accept a challenge on another organization', async () => {
    const { user, secret } = await enrolledUser();
    const challenge = await startChallenge(user.email);

    const response = await post('twofa-b', '/auth/2fa', { challenge, code: codeNow(secret) });

    expect(response.statusCode).toBe(401);
    expect(b.id).toBeTruthy();
  });

  it('counts wrong codes toward the same lock as wrong passwords: ten lock the account', async () => {
    const { user, secret } = await enrolledUser();
    const wrong = codeNow(secret) === '111111' ? '222222' : '111111';
    for (let i = 0; i < 10; i += 1) {
      // Long enough for the backoff to have passed, short enough for the challenge to be alive.
      advance(70 * SECOND);
      const challenge = await startChallenge(user.email);
      expect((await post('twofa-a', '/auth/2fa', { challenge, code: wrong })).statusCode).toBe(401);
    }

    advance(70 * SECOND);
    const withPassword = await login(user.email);

    expect(withPassword.statusCode).toBe(401);
    const locked = (await auditRows('auth.account.locked')).filter(
      (row) => row.actorUserId === user.id,
    );
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ reason: 'second_factor_failures' });
  });

  it('signs in with a recovery code once, and refuses it afterwards', async () => {
    const { user, recoveryCodes } = await enrolledUser();
    const code = recoveryCodes[3] ?? '';

    const first = await post('twofa-a', '/auth/2fa', {
      challenge: await startChallenge(user.email),
      recoveryCode: code,
    });
    advance(3 * SECOND);
    const second = await post('twofa-a', '/auth/2fa', {
      challenge: await startChallenge(user.email),
      recoveryCode: code,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(401);
    expect((await auditRows('auth.2fa.recovery_used'))[0]).toMatchObject({ actorUserId: user.id });
  });

  it('a sign-in with a password never succeeds without the second factor, whatever the role mix', async () => {
    const { user } = await enrolledUser(['reception']);

    const response = await login(user.email);

    expect(LoginResponse.parse(response.json()).next).toBe('totp');
  });
});

describe('managing the factor', () => {
  it('needs the password again to replace it', async () => {
    const { user, cookie } = await enrolledUser();

    const without = await post('twofa-a', '/auth/2fa/enroll/start', {}, cookie);
    const wrong = await post(
      'twofa-a',
      '/auth/2fa/enroll/start',
      { password: 'not the password' },
      cookie,
    );
    advance(5 * SECOND);
    const right = await post('twofa-a', '/auth/2fa/enroll/start', { password: PASSWORD }, cookie);

    expect(without.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(right.statusCode).toBe(200);
    expect(user.id).toBeTruthy();
  });

  it('issues new recovery codes on request, with the password, and the old ones stop working', async () => {
    const { user, cookie, recoveryCodes } = await enrolledUser();

    const wrong = await post('twofa-a', '/auth/2fa/recovery-codes', { password: 'nope' }, cookie);
    advance(5 * SECOND);
    const fresh = await post('twofa-a', '/auth/2fa/recovery-codes', { password: PASSWORD }, cookie);
    advance(3 * SECOND);
    const oldCode = await post('twofa-a', '/auth/2fa', {
      challenge: await startChallenge(user.email),
      recoveryCode: recoveryCodes[0] ?? '',
    });
    advance(3 * SECOND);
    const newCode = await post('twofa-a', '/auth/2fa', {
      challenge: await startChallenge(user.email),
      recoveryCode: RecoveryCodesResponse.parse(fresh.json()).recoveryCodes[0] ?? '',
    });

    expect(wrong.statusCode).toBe(401);
    expect(fresh.statusCode).toBe(200);
    expect(oldCode.statusCode).toBe(401);
    expect(newCode.statusCode).toBe(200);
    expect((await auditRows('auth.2fa.recovery_regenerated'))[0]).toMatchObject({
      actorUserId: user.id,
    });
  });

  it('does not let a user in a mandatory role turn the factor off', async () => {
    const { user, cookie } = await enrolledUser(['professional']);

    const response = await post('twofa-a', '/auth/2fa/disable', { password: PASSWORD }, cookie);

    expect(response.statusCode).toBe(403);
    expect(Problem.parse(response.json()).code).toBe('forbidden');
    expect(LoginResponse.parse((await login(user.email)).json()).next).toBe('totp');
  });

  it('lets reception turn it off with the password, audits it, and stops asking for a code', async () => {
    const { user, cookie } = await enrolledUser(['reception']);

    const response = await post('twofa-a', '/auth/2fa/disable', { password: PASSWORD }, cookie);
    advance(5 * SECOND);

    expect(response.statusCode).toBe(204);
    expect((await auditRows('auth.2fa.disabled'))[0]).toMatchObject({ actorUserId: user.id });
    expect(LoginResponse.parse((await login(user.email)).json()).next).toBe('authenticated');
  });
});
