import { randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { recoveryCode, userAccount } from '../../src/db/schema/identity.js';
import { createTwoFactor } from '../../src/modules/identity/application/two-factor.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { codeAt, decodeBase32Secret, totpStepAt } from '../../src/platform/crypto/totp.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';
import { createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser, type TestUser } from '../support/users.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;
let now = new Date('2026-10-16T10:00:00.000Z').getTime();

const keys = createTenantKeys({
  kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
});
const withTenant = () => createWithTenant(runtime.db);

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'twofactor-a' });
  b = await createTestTenant(runtime, { slug: 'twofactor-b' });
});

afterAll(async () => {
  await runtime.close();
});

function setup() {
  const twoFactor = createTwoFactor({ keys, withTenant: withTenant(), clock: () => new Date(now) });
  const act = <T>(user: TestUser, tenant: TestTenant, fn: (tx: Tx) => Promise<T>) =>
    withTenant()({ tenantId: tenant.id, userId: user.id }, fn);
  return { twoFactor, act };
}

const currentCode = (secretBase32: string, offset = 0) =>
  codeAt(decodeBase32Secret(secretBase32), totpStepAt(new Date(now)) + offset);

async function enroll(user: TestUser, tenant = a) {
  const { twoFactor, act } = setup();
  const begun = await act<Awaited<ReturnType<typeof twoFactor.beginEnrollment>>>(
    user,
    tenant,
    (tx) =>
      twoFactor.beginEnrollment(tx, {
        tenantId: tenant.id,
        userId: user.id,
        account: user.email,
        issuer: 'Clínica Test',
      }),
  );
  const confirmed = await act<Awaited<ReturnType<typeof twoFactor.confirmEnrollment>>>(
    user,
    tenant,
    (tx) =>
      twoFactor.confirmEnrollment(tx, {
        tenantId: tenant.id,
        userId: user.id,
        code: currentCode(begun.secretBase32),
      }),
  );
  if (!confirmed.ok) throw new Error('enrollment did not confirm');
  now += 30_000;
  return { begun, recoveryCodes: confirmed.recoveryCodes, twoFactor, act };
}

describe('enrollment', () => {
  it('stores the secret encrypted, not enrolled until a code proves it, and never in plaintext', async () => {
    const user = await createTestUser(runtime, a.id);
    const { twoFactor, act } = setup();

    const begun = await act<Awaited<ReturnType<typeof twoFactor.beginEnrollment>>>(user, a, (tx) =>
      twoFactor.beginEnrollment(tx, {
        tenantId: a.id,
        userId: user.id,
        account: user.email,
        issuer: 'Clínica Test',
      }),
    );

    expect(begun.secretBase32).toMatch(/^[A-Z2-7]{32}$/);
    expect(begun.otpauthUri).toContain(`secret=${begun.secretBase32}`);
    const status = await act<Awaited<ReturnType<typeof twoFactor.status>>>(user, a, (tx) =>
      twoFactor.status(tx, user.id),
    );
    expect(status).toEqual({ enrolled: false, pending: true });
    const [row] = await act<(typeof userAccount.$inferSelect)[]>(user, a, (tx) =>
      tx.select().from(userAccount).where(eq(userAccount.id, user.id)),
    );
    expect(row?.totpSecretEnc).toBeNull();
    const stored = row?.totpPendingEnc;
    expect(stored).toBeInstanceOf(Buffer);
    expect(stored?.toString('latin1')).not.toContain(begun.secretBase32);
    expect(stored?.includes(Buffer.from(decodeBase32Secret(begun.secretBase32)))).toBe(false);
  });

  it('confirms with a right code: enrolled, ten recovery codes, only hashes at rest', async () => {
    const user = await createTestUser(runtime, a.id);

    const { recoveryCodes, twoFactor, act } = await enroll(user);

    expect(recoveryCodes).toHaveLength(10);
    expect(
      await act<Awaited<ReturnType<typeof twoFactor.status>>>(user, a, (tx) =>
        twoFactor.status(tx, user.id),
      ),
    ).toEqual({ enrolled: true, pending: false });
    const rows = await act<(typeof recoveryCode.$inferSelect)[]>(user, a, (tx) =>
      tx.select().from(recoveryCode).where(eq(recoveryCode.userId, user.id)),
    );
    expect(rows).toHaveLength(10);
    for (const code of recoveryCodes) {
      expect(JSON.stringify(rows)).not.toContain(code.replaceAll('-', ''));
      expect(JSON.stringify(rows)).not.toContain(code);
    }
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.codeHash) && row.usedAt === null)).toBe(
      true,
    );
  });

  it('does not confirm with a wrong code, and leaves the user not enrolled', async () => {
    const user = await createTestUser(runtime, a.id);
    const { twoFactor, act } = setup();
    const begun = await act<Awaited<ReturnType<typeof twoFactor.beginEnrollment>>>(user, a, (tx) =>
      twoFactor.beginEnrollment(tx, {
        tenantId: a.id,
        userId: user.id,
        account: user.email,
        issuer: 'X',
      }),
    );
    const wrong = currentCode(begun.secretBase32) === '000000' ? '000001' : '000000';

    const result = await act<Awaited<ReturnType<typeof twoFactor.confirmEnrollment>>>(
      user,
      a,
      (tx) => twoFactor.confirmEnrollment(tx, { tenantId: a.id, userId: user.id, code: wrong }),
    );

    expect(result).toEqual({ ok: false });
    expect(
      await act<Awaited<ReturnType<typeof twoFactor.status>>>(user, a, (tx) =>
        twoFactor.status(tx, user.id),
      ),
    ).toEqual({ enrolled: false, pending: true });
  });

  it('cannot confirm without having started', async () => {
    const user = await createTestUser(runtime, a.id);
    const { twoFactor, act } = setup();

    const result = await act<Awaited<ReturnType<typeof twoFactor.confirmEnrollment>>>(
      user,
      a,
      (tx) => twoFactor.confirmEnrollment(tx, { tenantId: a.id, userId: user.id, code: '123456' }),
    );

    expect(result).toEqual({ ok: false });
  });
});

describe('verifying a second factor at sign-in', () => {
  it('accepts the current code, then refuses the same code again (replay)', async () => {
    const user = await createTestUser(runtime, a.id);
    const { begun, twoFactor, act } = await enroll(user);
    const code = currentCode(begun.secretBase32);

    const first = await act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(user, a, (tx) =>
      twoFactor.verifyCode(tx, { tenantId: a.id, userId: user.id, code }),
    );
    const second = await act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(user, a, (tx) =>
      twoFactor.verifyCode(tx, { tenantId: a.id, userId: user.id, code }),
    );

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: 'replay' });
  });

  it('lets only one of two simultaneous submissions of the same code through', async () => {
    const user = await createTestUser(runtime, a.id);
    const { begun, twoFactor, act } = await enroll(user);
    const code = currentCode(begun.secretBase32);

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(user, a, (tx) =>
          twoFactor.verifyCode(tx, { tenantId: a.id, userId: user.id, code }),
        ),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('accepts a code from the next step after one was used, and rejects a wrong one', async () => {
    const user = await createTestUser(runtime, a.id);
    const { begun, twoFactor, act } = await enroll(user);
    await act(user, a, (tx) =>
      twoFactor.verifyCode(tx, {
        tenantId: a.id,
        userId: user.id,
        code: currentCode(begun.secretBase32),
      }),
    );

    now += 30_000;
    const next = await act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(user, a, (tx) =>
      twoFactor.verifyCode(tx, {
        tenantId: a.id,
        userId: user.id,
        code: currentCode(begun.secretBase32),
      }),
    );
    now += 30_000;
    const wrongCode = currentCode(begun.secretBase32) === '111111' ? '222222' : '111111';
    const wrong = await act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(user, a, (tx) =>
      twoFactor.verifyCode(tx, { tenantId: a.id, userId: user.id, code: wrongCode }),
    );

    expect(next).toEqual({ ok: true });
    expect(wrong).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reads a secret enrolled on another organization (the account is shared)', async () => {
    const user = await createTestUser(runtime, a.id);
    const { addTestMembership } = await import('../support/users.js');
    await addTestMembership(runtime, b.id, user.id);
    const { begun, twoFactor, act } = await enroll(user, a);

    const result = await act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(user, b, (tx) =>
      twoFactor.verifyCode(tx, {
        tenantId: b.id,
        userId: user.id,
        code: currentCode(begun.secretBase32),
      }),
    );

    expect(result).toEqual({ ok: true });
  });
});

describe('recovery codes', () => {
  it('work once, in any typing style, and cannot be reused', async () => {
    const user = await createTestUser(runtime, a.id);
    const { recoveryCodes, twoFactor, act } = await enroll(user);
    const code = recoveryCodes[0] ?? '';

    const typed = await act<boolean>(user, a, (tx) =>
      twoFactor.useRecoveryCode(tx, user.id, ` ${code.toUpperCase().replaceAll('-', ' ')} `),
    );
    const again = await act<boolean>(user, a, (tx) => twoFactor.useRecoveryCode(tx, user.id, code));
    const other = await act<boolean>(user, a, (tx) =>
      twoFactor.useRecoveryCode(tx, user.id, recoveryCodes[1] ?? ''),
    );

    expect([typed, again, other]).toEqual([true, false, true]);
  });

  it('are refused for a code that was never issued, and for another user', async () => {
    const owner = await createTestUser(runtime, a.id);
    const stranger = await createTestUser(runtime, a.id);
    const { recoveryCodes, twoFactor, act } = await enroll(owner);

    const never = await act<boolean>(owner, a, (tx) =>
      twoFactor.useRecoveryCode(tx, owner.id, 'abcd-efgh-jkmn-pqrs'),
    );
    const theirs = await act<boolean>(stranger, a, (tx) =>
      twoFactor.useRecoveryCode(tx, stranger.id, recoveryCodes[0] ?? ''),
    );

    expect([never, theirs]).toEqual([false, false]);
  });

  it('regenerating invalidates the old set and issues ten new codes', async () => {
    const user = await createTestUser(runtime, a.id);
    const { recoveryCodes: oldCodes, twoFactor, act } = await enroll(user);

    const fresh = await act<string[]>(user, a, (tx) =>
      twoFactor.regenerateRecoveryCodes(tx, user.id),
    );

    expect(fresh).toHaveLength(10);
    expect(fresh.some((code) => oldCodes.includes(code))).toBe(false);
    expect(
      await act<boolean>(user, a, (tx) =>
        twoFactor.useRecoveryCode(tx, user.id, oldCodes[0] ?? ''),
      ),
    ).toBe(false);
    expect(
      await act<boolean>(user, a, (tx) => twoFactor.useRecoveryCode(tx, user.id, fresh[0] ?? '')),
    ).toBe(true);
  });
});

describe('replacing and disabling the factor', () => {
  it('keeps the old factor working until the new one is confirmed', async () => {
    const user = await createTestUser(runtime, a.id);
    const { begun: oldFactor, twoFactor, act } = await enroll(user);

    const replacement = await act<Awaited<ReturnType<typeof twoFactor.beginEnrollment>>>(
      user,
      a,
      (tx) =>
        twoFactor.beginEnrollment(tx, {
          tenantId: a.id,
          userId: user.id,
          account: user.email,
          issuer: 'X',
        }),
    );
    const oldStillWorks = await act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(
      user,
      a,
      (tx) =>
        twoFactor.verifyCode(tx, {
          tenantId: a.id,
          userId: user.id,
          code: currentCode(oldFactor.secretBase32),
        }),
    );
    now += 30_000;
    const confirmed = await act<Awaited<ReturnType<typeof twoFactor.confirmEnrollment>>>(
      user,
      a,
      (tx) =>
        twoFactor.confirmEnrollment(tx, {
          tenantId: a.id,
          userId: user.id,
          code: currentCode(replacement.secretBase32),
        }),
    );
    now += 30_000;
    const oldNow = await act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(user, a, (tx) =>
      twoFactor.verifyCode(tx, {
        tenantId: a.id,
        userId: user.id,
        code: currentCode(oldFactor.secretBase32),
      }),
    );
    const newNow = await act<Awaited<ReturnType<typeof twoFactor.verifyCode>>>(user, a, (tx) =>
      twoFactor.verifyCode(tx, {
        tenantId: a.id,
        userId: user.id,
        code: currentCode(replacement.secretBase32),
      }),
    );

    expect(oldStillWorks).toEqual({ ok: true });
    expect(confirmed.ok).toBe(true);
    expect(oldNow).toMatchObject({ ok: false });
    expect(newNow).toEqual({ ok: true });
  });

  it('disabling removes the factor and every recovery code', async () => {
    const user = await createTestUser(runtime, a.id);
    const { recoveryCodes, twoFactor, act } = await enroll(user);

    await act(user, a, (tx) => twoFactor.disable(tx, user.id));

    expect(
      await act<Awaited<ReturnType<typeof twoFactor.status>>>(user, a, (tx) =>
        twoFactor.status(tx, user.id),
      ),
    ).toEqual({ enrolled: false, pending: false });
    expect(
      await act<boolean>(user, a, (tx) =>
        twoFactor.useRecoveryCode(tx, user.id, recoveryCodes[0] ?? ''),
      ),
    ).toBe(false);
    const [row] = await act<(typeof userAccount.$inferSelect)[]>(user, a, (tx) =>
      tx.select().from(userAccount).where(eq(userAccount.id, user.id)),
    );
    expect(row).toMatchObject({ totpSecretEnc: null, totpConfirmedAt: null, totpLastStep: null });
  });
});
