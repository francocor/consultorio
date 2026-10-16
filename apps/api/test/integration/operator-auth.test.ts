import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { operatorUser, platformAuditEvent } from '../../src/db/schema/operator.js';
import {
  OPERATOR_LOCK_MS,
  OPERATOR_MAX_FAILURES,
  OPERATOR_SESSION_IDLE_MS,
} from '../../src/modules/operator/application/auth.js';
import { sealPlatformAudit, verifyPlatformChain } from '../../src/platform/audit/platform-audit.js';
import { createRuntimeDb, createSealerDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import {
  codeFor,
  createOperatorHarness,
  createTestClock,
  loginOperator,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
  type TestOperator,
} from '../support/operator.js';
import { clientFor, signInAs, TEST_PASSWORD } from '../support/session.js';
import { createTestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let sealer: DbHandle;
let harness: OperatorHarness;
let app: FastifyInstance;
let clock: TestClock;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  sealer = createSealerDb(inject('sealerUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  app = buildTestApplication(runtime, {
    operator: { database: harness.db, secrets: harness.secrets },
    clock: clock.read,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await harness.close();
  await runtime.close();
  await sealer.close();
});

const events = (operator: TestOperator) =>
  harness.db.db
    .select()
    .from(platformAuditEvent)
    .where(eq(platformAuditEvent.operatorId, operator.id))
    .orderBy(asc(platformAuditEvent.occurredAt), asc(platformAuditEvent.id));

describe('the console answers only on the platform host', () => {
  it('is a 404 on a tenant host, even for a signed-in tenant owner', async () => {
    const tenant = await createTestTenant(runtime, { slug: 'op-auth-a' });
    const owner = await signInAs(
      app,
      'op-auth-a',
      await createTestUser(runtime, tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const tenantApi = clientFor(app, 'op-auth-a');

    for (const [method, url] of [
      ['POST', '/operator/auth/login'],
      ['GET', '/operator/me'],
      ['GET', '/operator/tenants'],
      ['POST', '/operator/tenants'],
    ] as const) {
      const response =
        method === 'GET' ? await tenantApi.get(url, owner) : await tenantApi.post(url, owner, {});
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json<{ code: string }>().code).toBe('not_found');
    }
  });

  it('is a 404 on an unknown host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/operator/me',
      headers: { host: 'nobody.consultorio.test', 'user-agent': 'vitest' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('does not exist at all when no operator database is configured', async () => {
    const bare = buildTestApplication(runtime);
    await bare.ready();
    const response = await bare.inject({
      method: 'GET',
      url: '/operator/me',
      headers: platformHeaders(),
    });
    await bare.close();

    expect(response.statusCode).toBe(404);
  });

  it('is not served by tenant routes: a tenant session does not sign anyone in on the platform host', async () => {
    const tenant = await createTestTenant(runtime, { slug: 'op-auth-b' });
    const owner = await signInAs(
      app,
      'op-auth-b',
      await createTestUser(runtime, tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );

    const response = await app.inject({
      method: 'GET',
      url: '/operator/me',
      headers: platformHeaders(owner.cookie),
      remoteAddress: '10.97.0.2',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /operator/auth/login', () => {
  it('signs in with the password and the authenticator code, and sets a hardened cookie', async () => {
    const operator = await harness.addOperator();

    const { response, cookie } = await loginOperator(app, operator, clock);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: operator.id,
      email: operator.email,
      displayName: expect.stringContaining('Operator') as unknown,
    });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/^osid=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Domain');
    expect(cookie).toBeDefined();
  });

  it('requires the code: a correct password alone is not enough', async () => {
    const operator = await harness.addOperator();

    const noCode = await app.inject({
      method: 'POST',
      url: '/operator/auth/login',
      headers: platformHeaders(),
      remoteAddress: '10.97.0.3',
      payload: { email: operator.email, password: operator.password },
    });
    const wrongCode = await loginOperator(app, operator, clock, { code: '000000' });

    expect(noCode.statusCode).toBe(400);
    expect(wrongCode.response.statusCode).toBe(401);
    expect(wrongCode.cookie).toBeUndefined();
  });

  it('answers every kind of failure the same way', async () => {
    const operator = await harness.addOperator();
    const other = await harness.addOperator();

    const wrongPassword = await loginOperator(app, operator, clock, { password: 'incorrecta' });
    const wrongCode = await loginOperator(app, operator, clock, { code: '123456' });
    const unknown = await loginOperator(app, { ...operator, email: 'nadie@platform.test' }, clock);
    // The right code of ANOTHER operator.
    const foreignCode = await loginOperator(app, operator, clock, {
      code: codeFor(other, clock.now),
    });

    const shape = (result: { response: { statusCode: number; json: () => unknown } }) => {
      const problem = result.response.json() as Record<string, unknown>;
      // The request id differs on every response; everything else must be identical.
      return [result.response.statusCode, { ...problem, requestId: undefined }];
    };
    expect(shape(wrongPassword)).toEqual(shape(unknown));
    expect(shape(wrongCode)).toEqual(shape(unknown));
    expect(shape(foreignCode)).toEqual(shape(unknown));
    expect(unknown.response.statusCode).toBe(401);
  });

  it('accepts a code only once, even inside its window', async () => {
    const operator = await harness.addOperator();
    clock.advance(31_000);
    const code = codeFor(operator, clock.now);
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/operator/auth/login',
        headers: platformHeaders(),
        remoteAddress: '10.97.0.4',
        payload: { email: operator.email, password: operator.password, code },
      });

    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(401);
  });

  it('locks the account after repeated failures, and unlocks it when the time is up', async () => {
    const operator = await harness.addOperator();
    for (let attempt = 0; attempt < OPERATOR_MAX_FAILURES; attempt += 1) {
      expect(
        (await loginOperator(app, operator, clock, { password: 'incorrecta' })).response.statusCode,
      ).toBe(401);
    }

    // Now even the right credentials are refused.
    expect((await loginOperator(app, operator, clock)).response.statusCode).toBe(401);
    const actions = (await events(operator)).map((event) => event.action);
    expect(actions).toContain('operator.login.locked');

    clock.advance(OPERATOR_LOCK_MS + 1000);
    expect((await loginOperator(app, operator, clock)).response.statusCode).toBe(200);
  });

  it('records every attempt on the platform trail, without secrets', async () => {
    const operator = await harness.addOperator();
    await loginOperator(app, operator, clock, { password: 'incorrecta' });
    await loginOperator(app, operator, clock);

    const rows = await events(operator);

    expect(rows.map((row) => [row.action, row.outcome])).toEqual([
      ['operator.login.failed', 'deny'],
      ['operator.login.success', 'allow'],
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(operator.password);
    expect(text).not.toContain('incorrecta');
  });
});

describe('the operator session', () => {
  it('identifies the operator, and ends on logout', async () => {
    const operator = await harness.addOperator();
    const cookie = await operatorSession(app, operator, clock);

    const me = await app.inject({
      method: 'GET',
      url: '/operator/me',
      headers: platformHeaders(cookie),
      remoteAddress: '10.97.0.5',
    });
    const out = await app.inject({
      method: 'POST',
      url: '/operator/auth/logout',
      headers: platformHeaders(cookie),
      remoteAddress: '10.97.0.5',
    });
    const after = await app.inject({
      method: 'GET',
      url: '/operator/me',
      headers: platformHeaders(cookie),
      remoteAddress: '10.97.0.5',
    });

    expect(me.statusCode).toBe(200);
    expect(me.json<{ email: string }>().email).toBe(operator.email);
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect(after.statusCode).toBe(401);
  });

  it('needs a cookie for every route but the sign-in', async () => {
    for (const [method, url] of [
      ['GET', '/operator/me'],
      ['GET', '/operator/tenants'],
      ['POST', '/operator/tenants'],
      ['POST', '/operator/auth/logout'],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: platformHeaders(),
        remoteAddress: '10.97.0.6',
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('ends after 30 minutes without use', async () => {
    const operator = await harness.addOperator();
    const cookie = await operatorSession(app, operator, clock);

    clock.advance(OPERATOR_SESSION_IDLE_MS + 1000);
    const response = await app.inject({
      method: 'GET',
      url: '/operator/me',
      headers: platformHeaders(cookie),
      remoteAddress: '10.97.0.7',
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a change that does not come from the console page (CSRF)', async () => {
    const operator = await harness.addOperator();
    const cookie = await operatorSession(app, operator, clock);

    const noOrigin = await app.inject({
      method: 'POST',
      url: '/operator/auth/logout',
      headers: { host: platformHeaders().host, cookie },
      remoteAddress: '10.97.0.8',
    });
    const foreign = await app.inject({
      method: 'POST',
      url: '/operator/auth/logout',
      headers: { ...platformHeaders(cookie), origin: 'https://evil.example' },
      remoteAddress: '10.97.0.8',
    });

    expect(noOrigin.statusCode).toBe(403);
    expect(foreign.statusCode).toBe(403);
  });

  it('is not a tenant session: the operator cookie opens nothing on a tenant host', async () => {
    const tenant = await createTestTenant(runtime, { slug: 'op-auth-c' });
    const operator = await harness.addOperator();
    const cookie = await operatorSession(app, operator, clock);

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: browserHeaders(tenant.slug, cookie),
      remoteAddress: '10.97.0.9',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('operator credentials at rest', () => {
  it('stores the authenticator secret encrypted, bound to its own row', async () => {
    const first = await harness.addOperator();
    const second = await harness.addOperator();

    const [row] = await harness.db.db
      .select()
      .from(operatorUser)
      .where(eq(operatorUser.id, first.id));
    const [other] = await harness.db.db
      .select()
      .from(operatorUser)
      .where(eq(operatorUser.id, second.id));

    expect(row).toBeDefined();
    expect(Buffer.from(row?.totpSecretEnc ?? []).includes(Buffer.from(first.secret))).toBe(false);
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    // The blob of one operator does not open as another's.
    await expect(
      harness.secrets.open(second.id, {
        dekWrapped: row?.totpDekWrapped ?? Buffer.alloc(0),
        encrypted: row?.totpSecretEnc ?? Buffer.alloc(0),
      }),
    ).rejects.toThrow();
    expect(other?.totpDekWrapped.equals(row?.totpDekWrapped ?? Buffer.alloc(0))).toBe(false);
  });

  it('is invisible to the application role', async () => {
    await expect(runtime.db.select().from(operatorUser)).rejects.toThrow();
    await expect(runtime.db.select().from(platformAuditEvent)).rejects.toThrow();
  });
});

describe('the platform trail is append-only and sealed', () => {
  it('seals in order, verifies, and notices tampering and deletion', async () => {
    const operator = await harness.addOperator();
    await loginOperator(app, operator, clock, { password: 'incorrecta' });
    await loginOperator(app, operator, clock);

    const sealed = await sealer.db.transaction((tx) => sealPlatformAudit(tx, { graceMs: 0 }));
    expect(sealed.sealed).toBeGreaterThan(0);
    expect(await sealer.db.transaction((tx) => verifyPlatformChain(tx))).toMatchObject({
      ok: true,
    });

    // The operator role itself cannot edit or remove an entry.
    await expect(
      harness.db.db
        .update(platformAuditEvent)
        .set({ reason: 'edited' })
        .where(eq(platformAuditEvent.operatorId, operator.id)),
    ).rejects.toThrow();
    await expect(
      harness.db.db
        .delete(platformAuditEvent)
        .where(eq(platformAuditEvent.operatorId, operator.id)),
    ).rejects.toThrow();

    // Even the superuser changing a sealed row is caught by the chain. The row is put back right
    // after, because the chain is shared by every test file of this run.
    const setReason = async (value: string | null) => {
      const admin = new pg.Client({ connectionString: inject('adminUrl') });
      await admin.connect();
      try {
        await admin.query(
          'ALTER TABLE platform_audit_event DISABLE TRIGGER platform_audit_event_guard',
        );
        await admin.query(
          `UPDATE platform_audit_event SET reason = $2
            WHERE operator_id = $1 AND action = 'operator.login.success'`,
          [operator.id, value],
        );
        await admin.query(
          'ALTER TABLE platform_audit_event ENABLE TRIGGER platform_audit_event_guard',
        );
      } finally {
        await admin.end();
      }
    };
    await setReason('tampered');
    let broken;
    try {
      broken = await sealer.db.transaction((tx) => verifyPlatformChain(tx));
    } finally {
      await setReason(null);
    }
    expect(broken).toMatchObject({ ok: false, reason: 'hash_mismatch' });
  });
});

describe('sanity of the harness', () => {
  it('counts events per operator through the operator connection', async () => {
    const operator = await harness.addOperator();
    await loginOperator(app, operator, clock);

    const [count] = await harness.db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(platformAuditEvent)
      .where(
        and(
          eq(platformAuditEvent.operatorId, operator.id),
          eq(platformAuditEvent.action, 'operator.login.success'),
        ),
      );

    expect(count?.n).toBe(1);
  });
});
