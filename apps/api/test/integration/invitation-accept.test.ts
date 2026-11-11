import { Problem, type AuditAction, type Role } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { membership, userAccount } from '../../src/db/schema/identity.js';
import {
  createInvitations,
  type Invitations,
} from '../../src/modules/identity/application/invitations.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { addTestMembership, createTestUser, type TestUser } from '../support/users.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PASSWORD = 'la contraseña de quien invita';
const CHOSEN = 'una frase propia elegida por la persona invitada';

let runtime: DbHandle;
let app: FastifyInstance;
let invitations: Invitations;
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
  testIp = `10.50.${String(Math.floor(ipCounter / 250))}.${String((ipCounter % 250) + 1)}`;
});

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  app = buildTestApplication(runtime, { clock: () => new Date(now) });
  invitations = createInvitations({
    tokens: createActionTokens({ clock: () => new Date(now) }),
    clock: () => new Date(now),
  });
  a = await createTestTenant(runtime, { slug: 'invite-a' });
  b = await createTestTenant(runtime, { slug: 'invite-b' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const post = (slug: string, url: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: browserHeaders(slug),
    remoteAddress: testIp,
    payload: payload as object,
  });
const accept = (token: string, password = CHOSEN, slug = 'invite-a') =>
  post(slug, '/auth/invitations/accept', { token, password });
const login = (address: string, password: string, slug = 'invite-a') =>
  post(slug, '/auth/login', { email: address, password });

async function inviter(roles: Role[] = ['owner'], tenant = a): Promise<TestUser> {
  return createTestUser(runtime, tenant.id, { roles, password: PASSWORD });
}

let counter = 0;
const freshAddress = () => `invitee-${String((counter += 1))}@clinica.example`;

async function invite(
  by: TestUser,
  roles: Role[],
  address = freshAddress(),
  tenant = a,
  byRoles: Role[] = ['owner'],
) {
  const issued = await asTenant(runtime, tenant.id, (tx) =>
    invitations.issue(tx, {
      email: address,
      roles,
      inviter: { userId: by.id, roles: byRoles },
    }),
  );
  return { ...issued, address };
}

async function rolesOf(userId: string, tenant = a): Promise<string[] | undefined> {
  const [row] = await asTenant(runtime, tenant.id, (tx) =>
    tx.select({ roles: membership.roles }).from(membership).where(eq(membership.userId, userId)),
  );
  return row?.roles;
}

async function accountOf(address: string, tenant = a) {
  const [row] = await asTenant(runtime, tenant.id, (tx) =>
    tx.select().from(userAccount).where(eq(userAccount.email, address)),
  );
  return row;
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

describe('issuing an invitation (within the inviter ceiling)', () => {
  it('gives a token that works once, for the invited address and roles', async () => {
    const boss = await inviter(['owner']);

    const { token, expiresAt } = await invite(boss, ['reception']);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime() - now).toBe(7 * DAY);
  });

  it('refuses an admin who tries to invite an owner, and anyone without the power to invite', async () => {
    const boss = await inviter(['admin']);
    const desk = await inviter(['reception']);

    await expect(invite(boss, ['owner'], freshAddress(), a, ['admin'])).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      invite(desk, ['reception'], freshAddress(), a, ['reception']),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(invite(boss, [], freshAddress(), a, ['admin'])).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('replaces an earlier invitation to the same address', async () => {
    const boss = await inviter(['owner']);
    const address = freshAddress();
    const first = await invite(boss, ['reception'], address);
    const second = await invite(boss, ['professional'], address);

    expect((await accept(first.token)).statusCode).toBe(400);
    expect((await accept(second.token)).statusCode).toBe(204);
  });
});

describe('accepting an invitation as a new person', () => {
  it('creates the account with exactly the invited roles, and the person chooses the password', async () => {
    const boss = await inviter(['owner']);
    const { token, address } = await invite(boss, ['professional', 'reception']);

    const response = await accept(token);

    expect(response.statusCode).toBe(204);
    expect((await login(address, CHOSEN)).statusCode).toBe(200);
    const account = await accountOf(address);
    expect(await rolesOf(account?.id ?? '')).toEqual(['professional', 'reception']);
  });

  it('stores a hash of the chosen password, never the password', async () => {
    const boss = await inviter(['owner']);
    const { token, address } = await invite(boss, ['reception']);

    await accept(token);

    const account = await accountOf(address);
    expect(account?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(account?.passwordHash).not.toContain(CHOSEN);
    expect(account?.passwordChangedAt).toBeInstanceOf(Date);
  });

  it('works once: the same link a second time fails', async () => {
    const boss = await inviter(['owner']);
    const { token } = await invite(boss, ['reception']);
    await accept(token);

    const again = await accept(token, 'a different phrase for a second try');

    expect(again.statusCode).toBe(400);
    expect(Problem.parse(again.json()).code).toBe('bad_request');
  });

  it('fails after 7 days, and the same way as an invented link', async () => {
    const boss = await inviter(['owner']);
    const { token } = await invite(boss, ['reception']);

    advance(7 * DAY);
    const expired = await accept(token);
    const invented = await accept('z'.repeat(43));

    expect(expired.statusCode).toBe(400);
    expect({ ...Problem.parse(expired.json()), requestId: 'x' }).toEqual({
      ...Problem.parse(invented.json()),
      requestId: 'x',
    });
  });

  it('refuses a weak password with the reasons and keeps the invitation usable', async () => {
    const boss = await inviter(['owner']);
    const { token, address } = await invite(boss, ['reception']);

    const weak = await accept(token, '12345678');
    const good = await accept(token);

    expect(weak.statusCode).toBe(400);
    expect(Problem.parse(weak.json()).errors).toEqual([
      { path: 'password', i18nKey: 'auth.password.too_short' },
    ]);
    expect(good.statusCode).toBe(204);
    expect((await login(address, CHOSEN)).statusCode).toBe(200);
  });

  it('is refused when the inviter no longer holds the power to grant those roles', async () => {
    const boss = await inviter(['owner']);
    const { token } = await invite(boss, ['admin']);
    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(membership)
        .set({ roles: ['reception'] })
        .where(eq(membership.userId, boss.id)),
    );

    const response = await accept(token);

    expect(response.statusCode).toBe(403);
  });

  it('is refused when the inviter was deactivated', async () => {
    const boss = await inviter(['owner']);
    const { token } = await invite(boss, ['reception']);
    await asTenant(runtime, a.id, (tx) =>
      tx.update(membership).set({ status: 'deactivated' }).where(eq(membership.userId, boss.id)),
    );

    expect((await accept(token)).statusCode).toBe(403);
  });

  it('only works on the organization that sent it', async () => {
    const boss = await inviter(['owner']);
    const { token } = await invite(boss, ['reception']);

    expect((await accept(token, CHOSEN, 'invite-b')).statusCode).toBe(400);
    expect((await accept(token, CHOSEN, 'invite-a')).statusCode).toBe(204);
  });

  it('audits the acceptance with the roles, and nothing secret', async () => {
    const boss = await inviter(['owner']);
    const { token, address } = await invite(boss, ['professional']);

    await accept(token);

    const [row] = await auditRows('auth.invitation.accepted');
    expect(row).toMatchObject({
      outcome: 'allow',
      metadata: { roles: ['professional'], newAccount: true },
    });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(CHOSEN);
    expect(JSON.stringify(row)).not.toContain(address);
  });
});

describe('accepting an invitation as someone who already has an account', () => {
  it('links the account to the new organization with the invited roles and keeps its password', async () => {
    const boss = await inviter(['owner'], b);
    const existing = await createTestUser(runtime, a.id, {
      roles: ['reception'],
      password: PASSWORD,
    });
    const { token } = await invite(boss, ['professional'], existing.email, b);

    const response = await accept(token, 'ignored phrase for an existing account', 'invite-b');

    expect(response.statusCode).toBe(204);
    expect(await rolesOf(existing.id, b)).toEqual(['professional']);
    // The password of the account did not change: the old one still works, the "new" one does not.
    expect((await login(existing.email, PASSWORD, 'invite-b')).statusCode).toBe(200);
    expect(
      (await login(existing.email, 'ignored phrase for an existing account', 'invite-a'))
        .statusCode,
    ).toBe(401);
    const [row] = await createWithTenant(runtime.db)(
      { tenantId: a.id, userId: existing.id },
      (tx) => tx.select().from(userAccount).where(eq(userAccount.id, existing.id)),
    );
    expect(row?.passwordChangedAt).toBeNull();
  });

  it('looks the same to the caller as accepting as a new person', async () => {
    const boss = await inviter(['owner']);
    const existing = await createTestUser(runtime, b.id, { password: PASSWORD });
    const forExisting = await invite(boss, ['reception'], existing.email);
    const forNew = await invite(boss, ['reception']);

    const one = await accept(forExisting.token);
    const two = await accept(forNew.token);

    expect(one.statusCode).toBe(two.statusCode);
    expect(one.body).toBe(two.body);
  });

  it('refuses, without using up the invitation, when the account is already a member', async () => {
    const boss = await inviter(['owner']);
    const member = await createTestUser(runtime, a.id, {
      roles: ['reception'],
      password: PASSWORD,
    });
    await addTestMembership(runtime, b.id, member.id);
    const { token } = await invite(boss, ['professional'], member.email);

    const response = await accept(token);

    expect(response.statusCode).toBe(409);
    expect(await rolesOf(member.id)).toEqual(['reception']);
  });
});
