import { randomBytes } from 'node:crypto';

import { count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { membership, session, userAccount } from '../../src/db/schema/identity.js';
import { tenantKey } from '../../src/db/schema/tenant-key.js';
import { location, tenant } from '../../src/db/schema/tenant.js';
import {
  LocalProvisionError,
  provisionLocalOrganization,
  type LocalProvisionDeps,
  type LocalProvisionInput,
} from '../../src/db/seed/local/provision.js';
import { resetOwnerPassword } from '../../src/db/seed/local/reset-password.js';
import { findAsset } from '../../src/main/assets.js';
import {
  createPasswordPolicy,
  createPasswordValidator,
  loadCommonPasswords,
} from '../../src/modules/identity/domain/password-policy.js';
import { createPasswordHasher } from '../../src/modules/identity/index.js';
import { createTenantLookup } from '../../src/modules/tenancy/index.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import { buildTestApplication } from '../support/app.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * Provisioning of the one organization of a desktop install: what the setup screen of Consulvia
 * Desktop asks for becomes a real, active organization with an owner who can sign in. Every test
 * uses its own slug, because the organizations of a database are global to the test file.
 */
let runtime: DbHandle;
let deps: LocalProvisionDeps;
let slugCounter = 0;

const PASSWORD = 'una frase larga y privada del consultorio';
const ORIGIN = 'http://127.0.0.1:41234';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  deps = {
    db: runtime.db,
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({
      kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
    }),
    validator: createPasswordValidator(
      createPasswordPolicy(await loadCommonPasswords(findAsset('common-passwords-100k.txt'))),
    ),
    clock: () => new Date(),
  };
});

afterAll(async () => {
  await runtime.close();
});

function input(overrides: Partial<LocalProvisionInput> = {}): LocalProvisionInput {
  slugCounter += 1;
  const n = String(slugCounter);
  return {
    organizationName: `Clínica Norte ${n}`,
    slug: `clinica-norte-${n}`,
    ownerName: 'Dra. Ana Gómez',
    ownerEmail: `ana.${n}@clinica.example`,
    ownerPassword: PASSWORD,
    timeZone: 'America/Argentina/Buenos_Aires',
    ...overrides,
  };
}

/** The application of a desktop install: single mode for this slug, a plain-http cookie. */
async function desktopApp(slug: string): Promise<FastifyInstance> {
  const app = buildTestApplication(runtime, {
    deployment: { mode: 'single', slug },
    cookieSecure: false,
    publicUrl: ORIGIN,
    wiring: [],
  });
  await app.ready();
  return app;
}

const headers = { host: '127.0.0.1:41234', origin: ORIGIN, 'user-agent': 'vitest-browser' };

async function signIn(app: FastifyInstance, email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    headers,
    remoteAddress: '127.0.0.1',
    payload: { email, password },
  });
}

const sidOf = (setCookie: string | string[] | undefined) =>
  (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';

async function rowsOf(tenantId: string) {
  return createWithTenant(runtime.db)({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => ({
    tenants: await tx.select().from(tenant),
    locations: await tx.select().from(location),
    memberships: await tx.select().from(membership),
    keys: await tx.select({ n: count() }).from(tenantKey),
  }));
}

describe('provisioning the organization of a desktop install', () => {
  it('creates an active, billing-exempt, real organization with a key, a location and an owner', async () => {
    const wanted = input({
      organizationName: '  Clínica Norte  ',
      ownerEmail: 'Ana@Clinica.Example',
    });

    const result = await provisionLocalOrganization(deps, wanted);

    expect(result).toMatchObject({ status: 'created', slug: wanted.slug });
    const rows = await rowsOf(result.tenantId);
    expect(rows.tenants).toHaveLength(1);
    expect(rows.tenants[0]).toMatchObject({
      slug: wanted.slug,
      status: 'active',
      isDemo: false,
      billingExempt: true,
      country: 'AR',
      theme: { displayName: 'Clínica Norte' },
    });
    expect(rows.keys[0]?.n).toBe(1);
    expect(rows.locations).toHaveLength(1);
    expect(rows.locations[0]).toMatchObject({
      name: 'Consultorio',
      timeZone: 'America/Argentina/Buenos_Aires',
      active: true,
    });
    expect(rows.memberships).toHaveLength(1);
    expect(rows.memberships[0]).toMatchObject({
      roles: ['owner'],
      status: 'active',
      displayName: 'Dra. Ana Gómez',
    });
    const audits = await createWithTenant(runtime.db)(
      { tenantId: result.tenantId, userId: SYSTEM_USER_ID },
      (tx) => tx.select({ action: auditEvent.action }).from(auditEvent),
    );
    expect(audits.map((row) => row.action)).toContain('location.created');
  });

  it('lets the owner sign in with the chosen password, through the API, in single mode', async () => {
    const wanted = input();
    await provisionLocalOrganization(deps, wanted);
    const app = await desktopApp(wanted.slug);

    const wrong = await signIn(app, wanted.ownerEmail, 'otra frase larga y privada de prueba');
    const right = await signIn(app, wanted.ownerEmail.toUpperCase(), PASSWORD);
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { ...headers, cookie: sidOf(right.headers['set-cookie']) },
    });
    await app.close();

    expect(wrong.statusCode).toBe(401);
    expect(right.statusCode).toBe(200);
    expect(me.statusCode).toBe(200);
    expect(me.json<{ roles: string[]; tenantStatus: string }>()).toMatchObject({
      roles: ['owner'],
      tenantStatus: 'active',
    });
  });

  it('changes nothing the second time, and says the organization exists', async () => {
    const wanted = input();
    const first = await provisionLocalOrganization(deps, wanted);
    const before = await rowsOf(first.tenantId);
    const [account] = await createWithTenant(runtime.db)(
      { tenantId: first.tenantId, userId: SYSTEM_USER_ID },
      (tx) => tx.select().from(userAccount).where(eq(userAccount.email, wanted.ownerEmail)),
    );

    const second = await provisionLocalOrganization(deps, {
      ...wanted,
      organizationName: 'Otro nombre',
      ownerName: 'Otra persona',
      ownerEmail: 'otra@clinica.example',
      ownerPassword: 'una frase completamente distinta y larga',
    });

    expect(second).toEqual({ status: 'exists', tenantId: first.tenantId, slug: wanted.slug });
    expect(await rowsOf(first.tenantId)).toEqual(before);
    const [after] = await createWithTenant(runtime.db)(
      { tenantId: first.tenantId, userId: SYSTEM_USER_ID },
      (tx) => tx.select().from(userAccount).where(eq(userAccount.email, wanted.ownerEmail)),
    );
    expect(after?.passwordHash).toBe(account?.passwordHash);
    const app = await desktopApp(wanted.slug);
    expect((await signIn(app, wanted.ownerEmail, PASSWORD)).statusCode).toBe(200);
    await app.close();
  });

  it('creates it once when two installs race for the same slug', async () => {
    const wanted = input();

    const results = await Promise.all([
      provisionLocalOrganization(deps, wanted),
      provisionLocalOrganization(deps, wanted),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['created', 'exists']);
    expect(results[0].tenantId).toBe(results[1].tenantId);
    const rows = await rowsOf(results[0].tenantId);
    expect(rows.memberships).toHaveLength(1);
    expect(rows.locations).toHaveLength(1);
  });

  it('refuses a weak password, and leaves nothing behind', async () => {
    const wanted = input({ ownerPassword: 'password123' });

    await expect(provisionLocalOrganization(deps, wanted)).rejects.toMatchObject({
      name: 'LocalProvisionError',
      code: 'password_rejected',
    });

    expect(await createTenantLookup(runtime.db)(wanted.slug)).toBeNull();
    await expect(
      provisionLocalOrganization(deps, { ...wanted, ownerPassword: PASSWORD }),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('refuses a password that contains the owner address', async () => {
    const ownerEmail = 'consultorio.privado@clinica.example';
    const wanted = input({ ownerEmail, ownerPassword: `${ownerEmail.split('@')[0] ?? ''}-2026` });

    await expect(provisionLocalOrganization(deps, wanted)).rejects.toBeInstanceOf(
      LocalProvisionError,
    );
  });

  it('never turns a demo organization into a real one', async () => {
    const wanted = input();
    await createTestTenant(runtime, { slug: wanted.slug, isDemo: true });

    await expect(provisionLocalOrganization(deps, wanted)).rejects.toMatchObject({
      code: 'demo_organization',
    });
  });

  it('refuses an owner address that already belongs to another account', async () => {
    const first = input();
    await provisionLocalOrganization(deps, first);
    const wanted = input({ ownerEmail: first.ownerEmail });

    await expect(provisionLocalOrganization(deps, wanted)).rejects.toMatchObject({
      code: 'email_in_use',
    });
    // The refusal left no half-made organization behind.
    expect(await createTenantLookup(runtime.db)(wanted.slug)).toBeNull();
  });
});

describe('resetting the password of the owner', () => {
  async function provisioned() {
    const wanted = input();
    const result = await provisionLocalOrganization(deps, wanted);
    return { wanted, tenantId: result.tenantId };
  }
  const NEW_PASSWORD = 'otra frase larga para entrar de nuevo';

  it('lets the owner sign in with the new password and not the old one', async () => {
    const { wanted, tenantId } = await provisioned();

    const result = await resetOwnerPassword(deps, { tenantId, newPassword: NEW_PASSWORD });

    expect(result).toMatchObject({ email: wanted.ownerEmail });
    const app = await desktopApp(wanted.slug);
    expect((await signIn(app, wanted.ownerEmail, PASSWORD)).statusCode).toBe(401);
    expect((await signIn(app, wanted.ownerEmail, NEW_PASSWORD)).statusCode).toBe(200);
    await app.close();
  });

  it('ends the sessions that were open and lifts a lock, as a reset by email does', async () => {
    const { wanted, tenantId } = await provisioned();
    const app = await desktopApp(wanted.slug);
    const open = await signIn(app, wanted.ownerEmail, PASSWORD);
    expect(open.statusCode).toBe(200);
    const [owner] = (await rowsOf(tenantId)).memberships;
    await createWithTenant(runtime.db)({ tenantId, userId: owner?.userId ?? '' }, (tx) =>
      tx
        .update(userAccount)
        .set({
          failedLogins: 10,
          lastFailedAt: new Date(),
          lockedUntil: new Date(Date.now() + 900_000),
        })
        .where(eq(userAccount.email, wanted.ownerEmail)),
    );

    await resetOwnerPassword(deps, { tenantId, newPassword: NEW_PASSWORD });

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { ...headers, cookie: sidOf(open.headers['set-cookie']) },
    });
    expect(me.statusCode).toBe(401);
    const reentered = await signIn(app, wanted.ownerEmail, NEW_PASSWORD);
    await app.close();
    expect(reentered.statusCode).toBe(200);
    const sessions = await createWithTenant(runtime.db)(
      { tenantId, userId: SYSTEM_USER_ID },
      (tx) =>
        tx.select({ n: count() }).from(session).where(eq(session.revokedReason, 'password_reset')),
    );
    expect(sessions[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('applies the password rules of the product', async () => {
    const { tenantId } = await provisioned();

    await expect(
      resetOwnerPassword(deps, { tenantId, newPassword: 'corta' }),
    ).rejects.toMatchObject({
      code: 'password_rejected',
    });
  });

  it('needs the address when there is more than one owner, and finds the one it names', async () => {
    const { wanted, tenantId } = await provisioned();
    const { createTestUser } = await import('../support/users.js');
    const second = await createTestUser(runtime, tenantId, {
      roles: ['owner'],
      password: PASSWORD,
    });

    await expect(
      resetOwnerPassword(deps, { tenantId, newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({
      code: 'owner_ambiguous',
    });
    await expect(
      resetOwnerPassword(deps, {
        tenantId,
        newPassword: NEW_PASSWORD,
        ownerEmail: 'nadie@clinica.example',
      }),
    ).rejects.toMatchObject({ code: 'owner_not_found' });
    await expect(
      resetOwnerPassword(deps, {
        tenantId,
        newPassword: NEW_PASSWORD,
        ownerEmail: second.email.toUpperCase(),
      }),
    ).resolves.toMatchObject({ email: second.email });
    const app = await desktopApp(wanted.slug);
    expect((await signIn(app, wanted.ownerEmail, PASSWORD)).statusCode).toBe(200);
    await app.close();
  });

  it('says so when the organization has no owner', async () => {
    const empty = await createTestTenant(runtime, { slug: 'sin-propietario' });

    await expect(
      resetOwnerPassword(deps, { tenantId: empty.id, newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: 'owner_not_found' });
  });
});
