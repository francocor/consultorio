import { Problem, type AuditAction } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createPasswordHasher, type PasswordHasher } from '../../src/modules/identity/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser, type TestUser } from '../support/users.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PASSWORD = 'la contraseña correcta de la prueba';
const WRONG = 'una contraseña equivocada';

let runtime: DbHandle;
let app: FastifyInstance;
let tenant: TestTenant;
let now = new Date('2026-10-16T09:00:00.000Z').getTime();
const advance = (ms: number) => {
  now += ms;
};

/** Counts how often a password is verified and whether a real account hash was involved. */
const verifications = { real: 0, dummy: 0 };
function countingHasher(): PasswordHasher {
  const inner = createPasswordHasher();
  return {
    hash: (password) => inner.hash(password),
    verify: (hash, password) => inner.verify(hash, password),
    verifyOrDummy(storedHash, password) {
      if (storedHash) verifications.real += 1;
      else verifications.dummy += 1;
      return inner.verifyOrDummy(storedHash, password);
    },
  };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  app = buildTestApplication(runtime, { clock: () => new Date(now), hasher: countingHasher() });
  tenant = await createTestTenant(runtime, { slug: 'lockout-a' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

/** Every test signs in from its own address, so the per-address delays of one test never reach another. */
let testIp = '';
let ipCounter = 0;
beforeEach(() => {
  ipCounter += 1;
  testIp = `10.20.${String(Math.floor(ipCounter / 250))}.${String((ipCounter % 250) + 1)}`;
});

const login = (email: string, password: string, ip = testIp) =>
  app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: browserHeaders('lockout-a'),
    remoteAddress: ip,
    payload: { email, password },
  });

const newUser = (): Promise<TestUser> => createTestUser(runtime, tenant.id, { password: PASSWORD });

/** Wrong passwords, with enough time between them to stay clear of the backoff. */
async function failTimes(email: string, times: number, ip?: string) {
  for (let i = 0; i < times; i += 1) {
    advance(2 * MINUTE);
    expect((await login(email, WRONG, ip)).statusCode).toBe(401);
  }
}

async function auditRows(action: AuditAction, userId?: string) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return userId === undefined ? rows : rows.filter((row) => row.actorUserId === userId);
}

const strip = (body: unknown) => ({ ...Problem.parse(body), requestId: 'x' });

describe('account lockout (identity-access, "Account lockout and throttling")', () => {
  it('locks after 10 consecutive failures; the 11th attempt with the right password is still a generic 401', async () => {
    const user = await newUser();
    await failTimes(user.email, 10);
    const before = { ...verifications };

    advance(2 * MINUTE);
    const response = await login(user.email, PASSWORD);

    expect(response.statusCode).toBe(401);
    expect(Problem.parse(response.json()).code).toBe('unauthenticated');
    expect(response.headers['set-cookie']).toBeUndefined();
    // The credentials were not checked against the account: only a dummy verification ran.
    expect(verifications.real).toBe(before.real);
    expect(verifications.dummy).toBe(before.dummy + 1);
  });

  it('audits the lock once, with the number of failures, and each refused attempt', async () => {
    const user = await newUser();
    await failTimes(user.email, 10);
    advance(2 * MINUTE);
    await login(user.email, PASSWORD);

    const locked = await auditRows('auth.account.locked', user.id);
    const refused = await auditRows('auth.login.locked', user.id);

    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({
      outcome: 'deny',
      reason: 'password_failures',
      metadata: { failures: 10, lockMinutes: 15 },
    });
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0]).toMatchObject({ outcome: 'deny', reason: 'account_locked' });
  });

  it('unlocks when the window has passed, audits the unlock and starts a fresh count', async () => {
    const user = await newUser();
    await failTimes(user.email, 10);

    advance(15 * MINUTE);
    const response = await login(user.email, PASSWORD);

    expect(response.statusCode).toBe(200);
    const unlocked = await auditRows('auth.account.unlocked', user.id);
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0]).toMatchObject({ outcome: 'allow', reason: 'lock_expired' });
    // A fresh budget: nine more failures do not lock again.
    await failTimes(user.email, 9);
    advance(2 * MINUTE);
    expect((await login(user.email, PASSWORD)).statusCode).toBe(200);
  });

  it('still refuses on the last second of the lock', async () => {
    const user = await newUser();
    await failTimes(user.email, 10);

    advance(15 * MINUTE - 1);

    expect((await login(user.email, PASSWORD)).statusCode).toBe(401);
  });

  it('a successful sign-in forgets earlier failures', async () => {
    const user = await newUser();
    await failTimes(user.email, 6);
    advance(2 * MINUTE);
    expect((await login(user.email, PASSWORD)).statusCode).toBe(200);

    await failTimes(user.email, 9);

    advance(2 * MINUTE);
    expect((await login(user.email, PASSWORD)).statusCode).toBe(200);
  });
});

describe('backoff before the lock', () => {
  it('refuses an immediate attempt after three failures, even with the right password, and allows it a second later', async () => {
    const user = await newUser();
    await failTimes(user.email, 3);

    const immediate = await login(user.email, PASSWORD);
    advance(SECOND);
    const later = await login(user.email, PASSWORD);

    expect(immediate.statusCode).toBe(401);
    expect(later.statusCode).toBe(200);
  });

  it('does not delay the first two failures', async () => {
    const user = await newUser();
    advance(2 * MINUTE);
    await login(user.email, WRONG);

    const second = await login(user.email, WRONG);
    const third = await login(user.email, PASSWORD);

    expect(second.statusCode).toBe(401);
    expect(third.statusCode).toBe(200);
  });

  it('lengthens the wait as failures pile up', async () => {
    const user = await newUser();
    await failTimes(user.email, 5);

    advance(3 * SECOND);
    expect((await login(user.email, PASSWORD)).statusCode).toBe(401);
    advance(SECOND);
    expect((await login(user.email, PASSWORD)).statusCode).toBe(200);
  });
});

describe('unknown identifiers cannot be told apart from real accounts', () => {
  it('answers a locked account and an unknown email with the same body, status and headers', async () => {
    const user = await newUser();
    await failTimes(user.email, 10);
    advance(SECOND);
    const lockedAnswer = await login(user.email, PASSWORD);

    const ghost = 'ghost-lockout@example.test';
    await failTimes(ghost, 10);
    advance(SECOND);
    const ghostAnswer = await login(ghost, PASSWORD);

    expect(lockedAnswer.statusCode).toBe(401);
    expect(ghostAnswer.statusCode).toBe(401);
    expect(strip(lockedAnswer.json())).toEqual(strip(ghostAnswer.json()));
    expect(Object.keys(lockedAnswer.headers).sort()).toEqual(
      Object.keys(ghostAnswer.headers).sort(),
    );
    expect(lockedAnswer.headers['content-type']).toBe(ghostAnswer.headers['content-type']);
  });

  it('throttles an unknown email after repeated guesses just like a real one', async () => {
    const ghost = 'ghost-backoff@example.test';
    await failTimes(ghost, 3);

    // Within the backoff window nothing is verified for real; after it the attempt is judged again.
    const real = verifications.real;
    const refused = await login(ghost, WRONG);
    advance(SECOND);
    const judged = await login(ghost, WRONG);

    expect(refused.statusCode).toBe(401);
    expect(judged.statusCode).toBe(401);
    expect(verifications.real).toBe(real);
  });

  it('runs exactly one password verification on every path: wrong, unknown, locked and throttled', async () => {
    const user = await newUser();
    const attempts = async (email: string, password: string) => {
      const before = verifications.real + verifications.dummy;
      await login(email, password);
      return verifications.real + verifications.dummy - before;
    };

    advance(2 * MINUTE);
    const wrongPassword = await attempts(user.email, WRONG);
    const unknownEmail = await attempts('nobody-here@example.test', WRONG);
    await failTimes(user.email, 2);
    const throttled = await attempts(user.email, PASSWORD);
    await failTimes(user.email, 9);
    advance(SECOND);
    const locked = await attempts(user.email, PASSWORD);

    expect([wrongPassword, unknownEmail, throttled, locked]).toEqual([1, 1, 1, 1]);
  });

  it('records a failure for an unknown email with no actor', async () => {
    const ghost = 'ghost-audit@example.test';
    advance(2 * MINUTE);
    await login(ghost, WRONG);

    const [row] = await auditRows('auth.login.failed');

    expect(row).toMatchObject({ outcome: 'deny', actorUserId: null });
  });
});

describe('parallel guessing', () => {
  it('cannot test more passwords than the limit allows', async () => {
    const user = await newUser();
    advance(2 * MINUTE);
    const real = verifications.real;

    const answers = await Promise.all(Array.from({ length: 25 }, () => login(user.email, WRONG)));

    expect(answers.every((answer) => answer.statusCode === 401)).toBe(true);
    const tested = verifications.real - real;
    expect(tested).toBeGreaterThanOrEqual(1);
    expect(tested).toBeLessThanOrEqual(10);
  });
});

describe('throttling per client address', () => {
  it('delays a client that keeps failing against many accounts, without touching other clients', async () => {
    const victim = await newUser();
    const attacker = '203.0.113.200';
    for (let i = 0; i < 11; i += 1) {
      await login(`guess-${String(i)}@example.test`, WRONG, attacker);
    }

    const fromAttacker = await login(victim.email, PASSWORD, attacker);
    const fromElsewhere = await login(victim.email, PASSWORD, '203.0.113.201');

    expect(fromAttacker.statusCode).toBe(401);
    expect(fromElsewhere.statusCode).toBe(200);
  });

  it('lets the client back in after the delay', async () => {
    const victim = await newUser();
    const noisy = '203.0.113.210';
    for (let i = 0; i < 11; i += 1) {
      await login(`noise-${String(i)}@example.test`, WRONG, noisy);
    }

    advance(2 * SECOND);

    expect((await login(victim.email, PASSWORD, noisy)).statusCode).toBe(200);
  });
});
