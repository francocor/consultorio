import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { actionToken } from '../../src/db/schema/action-token.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens, purgeExpiredTokens } from '../../src/platform/tokens/index.js';
import { TOKEN_KIND_REGISTRY } from '../../src/platform/tokens/kinds.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'tokens-a' });
  b = await createTestTenant(runtime, { slug: 'tokens-b' });
});

afterAll(async () => {
  await runtime.close();
});

const MINUTE = 60_000;

function fakeClock() {
  let now = new Date('2026-10-16T10:00:00.000Z').getTime();
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function setup() {
  const clock = fakeClock();
  const tokens = createActionTokens({ clock: clock.now });
  const subject = randomUUID();
  const issue = (
    kind: Parameters<typeof tokens.issue>[1]['kind'] = 'password_reset',
    extra: Partial<Parameters<typeof tokens.issue>[1]> = {},
  ) => asTenant(runtime, a.id, (tx) => tokens.issue(tx, { kind, subjectId: subject, ...extra }));
  const redeem = (
    token: string,
    kind: Parameters<typeof tokens.redeem>[1] = 'password_reset',
    tenant = a,
    sessionId?: string,
  ) =>
    asTenant(runtime, tenant.id, (tx) =>
      tokens.redeem(tx, kind, token, sessionId === undefined ? {} : { sessionId }),
    );
  return { clock, tokens, subject, issue, redeem };
}

describe('issuing a token', () => {
  it('returns a 256-bit random token once and stores only its SHA-256', async () => {
    const { issue, subject } = setup();

    const issued = await issue();

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(actionToken).where(eq(actionToken.subjectId, subject)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(issued.token);
    expect(rows[0]).toMatchObject({ kind: 'password_reset', maxUses: 1, uses: 0 });
  });

  it('expires after the lifetime of its kind: 30 minutes for a reset', async () => {
    const { issue, clock } = setup();

    const issued = await issue();

    expect(issued.expiresAt.getTime() - clock.now().getTime()).toBe(
      TOKEN_KIND_REGISTRY.password_reset.ttlMs,
    );
  });

  it('lets an issuer shorten the lifetime but never extend it', async () => {
    const { issue, clock } = setup();

    const shorter = await issue('password_reset', { ttlMs: 5 * MINUTE });
    const longer = await issue('password_reset', { ttlMs: 24 * 60 * MINUTE });

    expect(shorter.expiresAt.getTime() - clock.now().getTime()).toBe(5 * MINUTE);
    expect(longer.expiresAt.getTime() - clock.now().getTime()).toBe(30 * MINUTE);
  });

  it('refuses a kind whose capability does not exist yet', async () => {
    const { issue } = setup();

    // Every kind is switched on by now (the last ones by Stage 6), so one is switched off for the
    // length of the assertion: what is refused is a kind whose capability is not there.
    const spec = TOKEN_KIND_REGISTRY.archive_release;
    const enabled = spec.enabled;
    spec.enabled = false;
    try {
      await expect(issue('archive_release')).rejects.toThrow(/not enabled/);
    } finally {
      spec.enabled = enabled;
    }
  });

  it('refuses a session-bound kind without a session', async () => {
    const { tokens } = setup();

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tokens.issue(tx, { kind: 'document_download', subjectId: randomUUID() }),
      ),
    ).rejects.toThrow();
  });

  it('carries a small payload for the flow (the invited email and roles)', async () => {
    const { issue, redeem } = setup();
    const issued = await issue('staff_invitation', {
      payload: { email: 'nueva@clinica.example', roles: ['reception'] },
    });

    const redeemed = await redeem(issued.token, 'staff_invitation');

    expect(redeemed?.payload).toEqual({ email: 'nueva@clinica.example', roles: ['reception'] });
  });
});

describe('redeeming a token', () => {
  it('works once, returns the subject, and the second attempt fails', async () => {
    const { issue, redeem, subject } = setup();
    const { token } = await issue();

    const first = await redeem(token);
    const second = await redeem(token);

    expect(first).toMatchObject({ subjectId: subject, kind: 'password_reset' });
    expect(second).toBeNull();
  });

  it('is single use under concurrency: of 12 simultaneous redemptions exactly one wins', async () => {
    const { issue, redeem } = setup();
    const { token } = await issue();

    const results = await Promise.all(Array.from({ length: 12 }, () => redeem(token)));

    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });

  it('never lets an issuer raise the number of uses of its kind', async () => {
    const { issue, redeem, subject } = setup();
    const { token } = await issue('password_reset', { maxUses: 5 });

    const rows = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(actionToken).where(eq(actionToken.subjectId, subject)),
    );
    expect(rows[0]?.maxUses).toBe(1);
    expect(await redeem(token)).not.toBeNull();
    expect(await redeem(token)).toBeNull();
  });

  it('works up to the last moment before it expires and fails from the expiry instant', async () => {
    const { issue, redeem, clock } = setup();
    const early = await issue();
    const late = await issue();

    clock.advance(30 * MINUTE - 1);
    const beforeExpiry = await redeem(early.token);
    clock.advance(1);
    const atExpiry = await redeem(late.token);

    expect(beforeExpiry).not.toBeNull();
    expect(atExpiry).toBeNull();
  });

  it('fails for the wrong kind and does not consume the token', async () => {
    const { issue, redeem } = setup();
    const { token } = await issue('password_reset');

    expect(await redeem(token, 'staff_invitation')).toBeNull();
    expect(await redeem(token, 'password_reset')).not.toBeNull();
  });

  it('fails for an unknown token and for text that is not a token', async () => {
    const { redeem } = setup();

    expect(await redeem('A'.repeat(43))).toBeNull();
    expect(await redeem('not a token')).toBeNull();
  });

  it('cannot be redeemed on another tenant', async () => {
    const { issue, redeem } = setup();
    const { token } = await issue();

    expect(await redeem(token, 'password_reset', b)).toBeNull();
    expect(await redeem(token, 'password_reset', a)).not.toBeNull();
  });

  it('is revoked by revoking the tokens of its subject and kind', async () => {
    const { tokens, issue, redeem, subject } = setup();
    const first = await issue();
    const second = await issue();

    const revoked = await asTenant(runtime, a.id, (tx) =>
      tokens.revokeForSubject(tx, 'password_reset', subject),
    );

    expect(revoked).toBe(2);
    expect(await redeem(first.token)).toBeNull();
    expect(await redeem(second.token)).toBeNull();
  });

  it('can be inspected without being consumed', async () => {
    const { tokens, issue, redeem, subject } = setup();
    const { token } = await issue('staff_invitation', { payload: { email: 'x@y.example' } });

    const seen = await asTenant(runtime, a.id, (tx) =>
      tokens.inspect(tx, 'staff_invitation', token),
    );

    expect(seen).toMatchObject({ subjectId: subject, payload: { email: 'x@y.example' } });
    expect(await redeem(token, 'staff_invitation')).not.toBeNull();
    expect(
      await asTenant(runtime, a.id, (tx) => tokens.inspect(tx, 'staff_invitation', token)),
    ).toBeNull();
  });
});

describe('session binding', () => {
  it('a session-bound token only works for its session', async () => {
    // document_download is not enabled yet; bind a token of an enabled kind through the option.
    const { tokens, subject } = setup();
    const session = randomUUID();
    const issued = await asTenant(runtime, a.id, (tx) =>
      tokens.issue(tx, { kind: 'password_reset', subjectId: subject, sessionId: session }),
    );

    const wrong = await asTenant(runtime, a.id, (tx) =>
      tokens.redeem(tx, 'password_reset', issued.token, { sessionId: randomUUID() }),
    );
    const none = await asTenant(runtime, a.id, (tx) =>
      tokens.redeem(tx, 'password_reset', issued.token, {}),
    );
    const right = await asTenant(runtime, a.id, (tx) =>
      tokens.redeem(tx, 'password_reset', issued.token, { sessionId: session }),
    );

    expect(wrong).toBeNull();
    expect(none).toBeNull();
    expect(right).toMatchObject({ subjectId: subject });
  });
});

describe('purging the tokens that expired (JD-S3 B32)', () => {
  const DAY = 24 * 60 * MINUTE;

  it('deletes tokens a week after they expired, and keeps the live ones and the recent ones', async () => {
    const { clock, issue } = setup();
    const old = await issue('password_reset');
    clock.advance(TOKEN_KIND_REGISTRY.password_reset.ttlMs + 8 * DAY);
    const recent = await issue('password_reset', { ttlMs: MINUTE });
    clock.advance(2 * MINUTE);
    const live = await issue('password_reset');
    const rows = () =>
      asTenant(runtime, a.id, (tx) =>
        tx.select({ id: actionToken.id }).from(actionToken).where(eq(actionToken.tenantId, a.id)),
      );
    const before = (await rows()).map((row) => row.id);
    expect(before).toEqual(expect.arrayContaining([old.id, recent.id, live.id]));

    const purged = await asTenant(runtime, a.id, (tx) =>
      purgeExpiredTokens(tx, { now: clock.now() }),
    );

    const after = (await rows()).map((row) => row.id);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(after).not.toContain(old.id);
    expect(after).toEqual(expect.arrayContaining([recent.id, live.id]));
  });

  it('never touches the tokens of another organization', async () => {
    const { clock, tokens, subject } = setup();
    const other = await asTenant(runtime, b.id, (tx) =>
      tokens.issue(tx, { kind: 'password_reset', subjectId: subject }),
    );
    clock.advance(TOKEN_KIND_REGISTRY.password_reset.ttlMs + 30 * DAY);

    await asTenant(runtime, a.id, (tx) => purgeExpiredTokens(tx, { now: clock.now() }));

    const rows = await asTenant(runtime, b.id, (tx) =>
      tx.select({ id: actionToken.id }).from(actionToken).where(eq(actionToken.id, other.id)),
    );
    expect(rows).toHaveLength(1);
  });
});
