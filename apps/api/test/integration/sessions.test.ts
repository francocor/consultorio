import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { membership, session } from '../../src/db/schema/identity.js';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  createSessionService,
  hashSessionToken,
} from '../../src/modules/identity/application/sessions.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'sessions-a' });
  b = await createTestTenant(runtime, { slug: 'sessions-b' });
});

afterAll(async () => {
  await runtime.close();
});

const MINUTE = 60_000;

/** A clock the test moves by hand. */
function fakeClock(start = new Date('2026-10-16T08:00:00.000Z')) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

async function setup(tenant: TestTenant = a) {
  const clock = fakeClock();
  const sessions = createSessionService({ clock: clock.now });
  const user = await createTestUser(runtime, tenant.id);
  const issue = (over: { scope?: 'full' | 'two_factor_enrollment' } = {}) =>
    asTenant(runtime, tenant.id, (tx) =>
      sessions.issue(tx, {
        tenantId: tenant.id,
        userId: user.id,
        membershipId: user.membershipId,
        ip: '203.0.113.5',
        userAgent: 'vitest',
        ...over,
      }),
    );
  const resolve = (token: string, tenantId = tenant.id) =>
    asTenant(runtime, tenantId, (tx) => sessions.resolve(tx, token));
  return { clock, sessions, user, issue, resolve };
}

describe('issuing a session', () => {
  it('returns the raw token once and stores only its SHA-256', async () => {
    const { issue, user } = await setup();

    const issued = await issue();

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(session).where(eq(session.userId, user.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashSessionToken(issued.token));
    expect(JSON.stringify(rows[0])).not.toContain(issued.token);
    expect(rows[0]).toMatchObject({ scope: 'full', ip: '203.0.113.5', userAgent: 'vitest' });
    expect(issued.expiresAt.getTime() - issued.issuedAt.getTime()).toBe(SESSION_ABSOLUTE_MS);
  });

  it('gives two sign-ins two different tokens', async () => {
    const { issue } = await setup();

    const first = await issue();
    const second = await issue();

    expect(first.token).not.toBe(second.token);
    expect(first.sessionId).not.toBe(second.sessionId);
  });
});

describe('resolving a session', () => {
  it('finds the session, its user and the roles of the membership', async () => {
    const { issue, resolve, user } = await setup();
    const { token, sessionId } = await issue();

    const resolved = await resolve(token);

    expect(resolved).toMatchObject({
      sessionId,
      userId: user.id,
      membershipId: user.membershipId,
      tenantId: a.id,
      roles: ['reception'],
      scope: 'full',
    });
  });

  it('knows nothing about an unknown token', async () => {
    const { resolve } = await setup();

    expect(await resolve('A'.repeat(43))).toBeNull();
  });

  it('does not resolve on another tenant host (a cookie replayed elsewhere finds nothing)', async () => {
    const { issue, resolve } = await setup();
    const { token } = await issue();

    expect(await resolve(token, a.id)).not.toBeNull();
    expect(await resolve(token, b.id)).toBeNull();
  });

  it('expires after 30 minutes without use, with a fake clock', async () => {
    const { issue, resolve, clock } = await setup();
    const { token } = await issue();

    clock.advance(SESSION_IDLE_MS - 1);
    expect(await resolve(token)).not.toBeNull();

    // The use above moved the idle window; a full idle period after it the session is over.
    clock.advance(SESSION_IDLE_MS);
    expect(await resolve(token)).toBeNull();
  });

  it('expires after 7 days even when it is used all the time', async () => {
    const { issue, resolve, clock } = await setup();
    const { token } = await issue();

    // Used every 29 minutes (inside the idle window) until the last use is under 30 minutes
    // before the absolute limit.
    const STEP = SESSION_IDLE_MS - MINUTE;
    let elapsed = 0;
    while (SESSION_ABSOLUTE_MS - elapsed > SESSION_IDLE_MS) {
      clock.advance(STEP);
      elapsed += STEP;
      expect(await resolve(token)).not.toBeNull();
    }
    // Just before the absolute limit, minutes after the last use: still fine.
    clock.advance(SESSION_ABSOLUTE_MS - elapsed - 1);
    expect(await resolve(token)).not.toBeNull();
    // At the absolute limit, a moment after the last use: the limit ends it, not the idle time.
    clock.advance(2);

    expect(await resolve(token)).toBeNull();
  });

  it('stops working when the membership is deactivated', async () => {
    const { issue, resolve, user } = await setup();
    const { token } = await issue();

    await asTenant(runtime, a.id, (tx) =>
      tx.update(membership).set({ status: 'deactivated' }).where(eq(membership.userId, user.id)),
    );

    expect(await resolve(token)).toBeNull();
  });

  it('carries the enrollment scope of a session that may only enroll', async () => {
    const { issue, resolve } = await setup();
    const { token } = await issue({ scope: 'two_factor_enrollment' });

    expect((await resolve(token))?.scope).toBe('two_factor_enrollment');
  });
});

describe('revoking and rotating', () => {
  it('revoking a session makes it fail on its next use, and keeps the row with the reason', async () => {
    const { issue, resolve, sessions } = await setup();
    const { token, sessionId } = await issue();

    const changed = await asTenant(runtime, a.id, (tx) => sessions.revoke(tx, sessionId, 'logout'));

    expect(changed).toBe(true);
    expect(await resolve(token)).toBeNull();
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(session).where(eq(session.id, sessionId)),
    );
    expect(row).toMatchObject({ revokedReason: 'logout' });
    expect(row?.revokedAt).toBeInstanceOf(Date);
  });

  it('revoking twice is harmless and reports that nothing changed', async () => {
    const { issue, sessions } = await setup();
    const { sessionId } = await issue();

    const first = await asTenant(runtime, a.id, (tx) => sessions.revoke(tx, sessionId, 'logout'));
    const second = await asTenant(runtime, a.id, (tx) => sessions.revoke(tx, sessionId, 'logout'));

    expect([first, second]).toEqual([true, false]);
  });

  it('rotation gives a new token and kills the old one', async () => {
    const { issue, resolve, sessions } = await setup();
    const old = await issue();

    const rotated = await asTenant(runtime, a.id, (tx) =>
      sessions.rotate(tx, old.sessionId, 'privilege_changed'),
    );

    expect(rotated.token).not.toBe(old.token);
    expect(await resolve(old.token)).toBeNull();
    expect(await resolve(rotated.token)).toMatchObject({ roles: ['reception'] });
  });

  it('revokes every other session of a user and spares the one in use', async () => {
    const { issue, resolve, sessions, user } = await setup();
    const keep = await issue();
    const other1 = await issue();
    const other2 = await issue();

    const count = await asTenant(runtime, a.id, (tx) =>
      sessions.revokeAllForUser(tx, user.id, 'password_changed', keep.sessionId),
    );

    expect(count).toBe(2);
    expect(await resolve(keep.token)).not.toBeNull();
    expect(await resolve(other1.token)).toBeNull();
    expect(await resolve(other2.token)).toBeNull();
  });

  it('lists the sessions of a user, newest first, flagging the current one, hiding revoked ones', async () => {
    const { issue, sessions, user, clock } = await setup();
    const first = await issue();
    clock.advance(5 * MINUTE);
    const second = await issue();
    clock.advance(5 * MINUTE);
    const gone = await issue();
    await asTenant(runtime, a.id, (tx) => sessions.revoke(tx, gone.sessionId, 'revoked_by_user'));

    const list = await asTenant(runtime, a.id, (tx) =>
      sessions.listForUser(tx, user.id, second.sessionId),
    );

    expect(list.map((entry) => [entry.id, entry.current])).toEqual([
      [second.sessionId, true],
      [first.sessionId, false],
    ]);
    expect(list[0]).toMatchObject({ ip: '203.0.113.5', userAgent: 'vitest' });
  });
});

describe('revoking everywhere (a password change reaches every organization)', () => {
  it('revokes the sessions of the user in all tenants, only when acting as that user', async () => {
    const { issue, user } = await setup(a);
    const inA = await issue();
    const clock = fakeClock();
    const sessions = createSessionService({ clock: clock.now });

    // The same account also works in tenant B.
    const { addTestMembership } = await import('../support/users.js');
    const membershipB = await addTestMembership(runtime, b.id, user.id);
    const inB = await asTenant(runtime, b.id, (tx) =>
      sessions.issue(tx, { tenantId: b.id, userId: user.id, membershipId: membershipB }),
    );

    const { createWithTenant } = await import('../../src/platform/db/tenant-context.js');
    const otherUser = await createTestUser(runtime, a.id);
    const asStranger = await createWithTenant(runtime.db)(
      { tenantId: a.id, userId: otherUser.id },
      (tx) => sessions.revokeEverywhere(tx, user.id, 'password_changed'),
    ).catch((error: unknown) => error);
    const count = await createWithTenant(runtime.db)({ tenantId: a.id, userId: user.id }, (tx) =>
      sessions.revokeEverywhere(tx, user.id, 'password_changed'),
    );

    expect(asStranger).toBeInstanceOf(Error);
    expect(count).toBe(2);
    expect(await asTenant(runtime, a.id, (tx) => sessions.resolve(tx, inA.token))).toBeNull();
    expect(await asTenant(runtime, b.id, (tx) => sessions.resolve(tx, inB.token))).toBeNull();
  });
});
