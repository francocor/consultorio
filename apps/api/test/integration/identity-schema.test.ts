import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { membership, recoveryCode, userAccount } from '../../src/db/schema/identity.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { addTestMembership, createTestUser, FAKE_PASSWORD_HASH } from '../support/users.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'identity-a' });
  b = await createTestTenant(runtime, { slug: 'identity-b' });
});

afterAll(async () => {
  await runtime.close();
});

const emails = (tenantId: string, actingUser = uuidv7()) =>
  createWithTenant(runtime.db)({ tenantId, userId: actingUser }, (tx) =>
    tx.select({ email: userAccount.email }).from(userAccount).orderBy(userAccount.email),
  );

describe('user visibility (identity-access, tenancy isolation)', () => {
  it("tenant B cannot read tenant A's users, tenant A can", async () => {
    const user = await createTestUser(runtime, a.id, { email: 'only-in-a@example.test' });

    expect((await emails(a.id)).map((row) => row.email)).toContain('only-in-a@example.test');
    expect((await emails(b.id)).map((row) => row.email)).not.toContain('only-in-a@example.test');
    expect(user.id).toBeTruthy();
  });

  it('a user who works in two organizations is visible to both and to nobody else', async () => {
    const c = await createTestTenant(runtime, { slug: 'identity-c' });
    const user = await createTestUser(runtime, a.id, { email: 'both@example.test' });
    await addTestMembership(runtime, b.id, user.id);

    expect((await emails(a.id)).map((row) => row.email)).toContain('both@example.test');
    expect((await emails(b.id)).map((row) => row.email)).toContain('both@example.test');
    expect((await emails(c.id)).map((row) => row.email)).not.toContain('both@example.test');
  });

  it('a transaction acting as the user can always read the own row, even in a tenant without membership', async () => {
    const user = await createTestUser(runtime, a.id);

    const own = await createWithTenant(runtime.db)({ tenantId: b.id, userId: user.id }, (tx) =>
      tx.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.id, user.id)),
    );
    const other = await createWithTenant(runtime.db)({ tenantId: b.id, userId: uuidv7() }, (tx) =>
      tx.select({ id: userAccount.id }).from(userAccount).where(eq(userAccount.id, user.id)),
    );

    expect(own).toEqual([{ id: user.id }]);
    expect(other).toEqual([]);
  });

  it('a user of the tenant cannot change the account row of a colleague', async () => {
    const colleague = await createTestUser(runtime, a.id);
    const admin = await createTestUser(runtime, a.id, { roles: ['admin'] });

    const result = await createWithTenant(runtime.db)({ tenantId: a.id, userId: admin.id }, (tx) =>
      tx.execute(sql`UPDATE user_account SET failed_logins = 7 WHERE id = ${colleague.id}`),
    );

    expect(result.rowCount).toBe(0);
    const [row] = await createWithTenant(runtime.db)(
      { tenantId: a.id, userId: colleague.id },
      (tx) => tx.select().from(userAccount).where(eq(userAccount.id, colleague.id)),
    );
    expect(row?.failedLogins).toBe(0);
  });

  it('a user can update the own account row', async () => {
    const user = await createTestUser(runtime, a.id);

    await createWithTenant(runtime.db)({ tenantId: a.id, userId: user.id }, (tx) =>
      tx.update(userAccount).set({ failedLogins: 3 }).where(eq(userAccount.id, user.id)),
    );

    const [row] = await createWithTenant(runtime.db)({ tenantId: a.id, userId: user.id }, (tx) =>
      tx.select().from(userAccount).where(eq(userAccount.id, user.id)),
    );
    expect(row?.failedLogins).toBe(3);
  });

  it('accounts are never deleted by the runtime role', async () => {
    const user = await createTestUser(runtime, a.id);

    await expect(
      createWithTenant(runtime.db)({ tenantId: a.id, userId: user.id }, (tx) =>
        tx.execute(sql`DELETE FROM user_account WHERE id = ${user.id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('refuses a second account with the same email, whatever the case', async () => {
    await createTestUser(runtime, a.id, { email: 'Dupe@Example.test' });

    await expect(
      createTestUser(runtime, b.id, { email: 'dupe@example.TEST' }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

describe('login lookup function (identity-access, "Wrong password and unknown identifier")', () => {
  it('returns only the columns the login needs, matched case-insensitively', async () => {
    const user = await createTestUser(runtime, a.id, {
      email: 'lookup@example.test',
      passwordHash: FAKE_PASSWORD_HASH,
    });

    const result = await asTenant(runtime, b.id, (tx) =>
      tx.execute(sql`SELECT * FROM app.lookup_user_for_login('LOOKUP@example.test')`),
    );

    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0] ?? {}).sort()).toEqual([
      'failed_logins',
      'id',
      'last_failed_at',
      'locked_until',
      'password_hash',
    ]);
    expect(result.rows[0]).toMatchObject({ id: user.id, password_hash: FAKE_PASSWORD_HASH });
  });

  it('returns nothing for an unknown email', async () => {
    const result = await asTenant(runtime, a.id, (tx) =>
      tx.execute(sql`SELECT * FROM app.lookup_user_for_login('nobody@example.test')`),
    );

    expect(result.rows).toEqual([]);
  });

  it('is the only way to reach an account of another tenant', async () => {
    await createTestUser(runtime, a.id, { email: 'hidden@example.test' });

    const direct = await asTenant(runtime, b.id, (tx) =>
      tx.execute(sql`SELECT id FROM user_account WHERE email = 'hidden@example.test'`),
    );

    expect(direct.rows).toEqual([]);
  });
});

describe('membership', () => {
  it('stores the roles and refuses roles outside the staff set', async () => {
    const user = await createTestUser(runtime, a.id, { roles: ['owner', 'professional'] });

    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(membership).where(eq(membership.userId, user.id)),
    );
    expect(row?.roles).toEqual(['owner', 'professional']);

    for (const roles of [['patient'], ['superuser'], []]) {
      await expect(
        createWithTenant(runtime.db)({ tenantId: b.id, userId: user.id }, (tx) =>
          tx.insert(membership).values({ tenantId: b.id, userId: user.id, roles }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });

  it('allows one membership per user and tenant', async () => {
    const user = await createTestUser(runtime, a.id);

    await expect(addTestMembership(runtime, a.id, user.id)).rejects.toMatchObject({
      cause: { code: '23505' },
    });
  });

  it('only accepts the statuses active and deactivated', async () => {
    const user = await createTestUser(runtime, a.id);

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.update(membership).set({ status: 'banned' }).where(eq(membership.userId, user.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('recovery codes', () => {
  it('are only visible to the user they belong to', async () => {
    const owner = await createTestUser(runtime, a.id);
    const other = await createTestUser(runtime, a.id);
    await createWithTenant(runtime.db)({ tenantId: a.id, userId: owner.id }, (tx) =>
      tx.insert(recoveryCode).values({ userId: owner.id, codeHash: 'hash-1' }),
    );

    const mine = await createWithTenant(runtime.db)({ tenantId: a.id, userId: owner.id }, (tx) =>
      tx.select({ hash: recoveryCode.codeHash }).from(recoveryCode),
    );
    const theirs = await createWithTenant(runtime.db)({ tenantId: a.id, userId: other.id }, (tx) =>
      tx.select({ hash: recoveryCode.codeHash }).from(recoveryCode),
    );

    expect(mine).toEqual([{ hash: 'hash-1' }]);
    expect(theirs).toEqual([]);
  });
});
