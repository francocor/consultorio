import { randomBytes } from 'node:crypto';

import { effectivePermissions, type MeResponse } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { membership, userAccount } from '../../src/db/schema/identity.js';
import { patient } from '../../src/db/schema/patients.js';
import { professional } from '../../src/db/schema/staff.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '../../src/db/seed/demo/credentials.js';
import { buildDemoDataset } from '../../src/db/seed/demo/dataset.js';
import { DemoSeedError, seedDemoTenant, type DemoSeedDeps } from '../../src/db/seed/demo/seed.js';
import { snapshotDemoTenant } from '../../src/db/seed/demo/snapshot.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { browserHeaders, buildTestApplication, sessionCookieOf } from '../support/app.js';
import { createTestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let app: FastifyInstance;
let deps: DemoSeedDeps;
const clock = () => new Date('2026-03-02T12:00:00Z');
const SYSTEM = '00000000-0000-0000-0000-000000000000';

async function newDemoTenant(slug: string, isDemo = true) {
  const created = await createTestTenant(runtime, { slug, isDemo, billingExempt: isDemo });
  return created.id;
}

beforeAll(async () => {
  const owner = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(owner.db);
  await owner.close();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  deps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({
      kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
    }),
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock,
  };
  app = buildTestApplication(runtime, { clock });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await runtime.close();
});

describe('seedDemoTenant', () => {
  it('fills a demo organization with the whole Stage 1 content', async () => {
    const id = await newDemoTenant('seed-full');
    const data = buildDemoDataset();

    await seedDemoTenant(deps, id);

    const counts = await deps.withTenant({ tenantId: id, userId: SYSTEM }, async (tx) => {
      const count = async (table: string) =>
        (
          await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
          )
        ).rows[0]?.n;
      return {
        members: await count('membership'),
        professionals: await count('professional'),
        hours: await count('professional_hours'),
        locations: await count('location'),
        patients: await count('patient'),
        coverages: await count('patient_coverage'),
        consents: await count('data_processing_consent'),
        representatives: await count('patient_representative'),
        audit: await count('audit_event'),
      };
    });
    expect(counts.members).toBe(data.staff.length);
    expect(counts.professionals).toBe(3);
    expect(counts.hours).toBeGreaterThan(8);
    expect(counts.locations).toBe(data.locations.length);
    expect(counts.patients).toBe(data.patients.length);
    expect(counts.coverages).toBe(data.patients.filter((p) => p.coverage).length);
    expect(counts.consents).toBe(data.patients.filter((p) => p.consent).length);
    expect(counts.representatives).toBe(data.patients.filter((p) => p.representative).length);
    expect(counts.audit).toBeGreaterThan(30);
  }, 120_000);

  it('applies the Aillu look and keeps the organization out of billing', async () => {
    const id = await newDemoTenant('seed-look');

    await seedDemoTenant(deps, id);

    const [row] = await deps.withTenant({ tenantId: id, userId: SYSTEM }, (tx) =>
      tx
        .select({ theme: tenant.theme, isDemo: tenant.isDemo, exempt: tenant.billingExempt })
        .from(tenant),
    );
    expect(row?.theme).toMatchObject({
      displayName: 'Centro Médico Aillu',
      primaryRequested: '#03a550',
      headingFont: 'poppins',
    });
    expect(row?.isDemo).toBe(true);
    expect(row?.exempt).toBe(true);
  }, 120_000);

  it('two runs produce the same logical content (ids, hashes and timestamps aside)', async () => {
    const first = await newDemoTenant('seed-same-a');
    const second = await newDemoTenant('seed-same-b');

    await seedDemoTenant(deps, first);
    await seedDemoTenant(deps, second);

    const a = await snapshotDemoTenant(deps.withTenant, first);
    const b = await snapshotDemoTenant(deps.withTenant, second);
    expect(a.patients.length).toBeGreaterThan(20);
    expect(a).toEqual(b);
  }, 180_000);

  it('refuses an organization that is not a demo one, and leaves it untouched', async () => {
    const id = await newDemoTenant('seed-real', false);

    await expect(seedDemoTenant(deps, id)).rejects.toThrow(DemoSeedError);

    const rows = await deps.withTenant({ tenantId: id, userId: SYSTEM }, (tx) =>
      tx.select().from(patient),
    );
    expect(rows).toEqual([]);
  });

  it('never runs in production, because its passwords are public', async () => {
    const id = await newDemoTenant('seed-production');

    await expect(seedDemoTenant({ ...deps, environment: 'production' }, id)).rejects.toThrow(
      /production/,
    );

    const rows = await deps.withTenant({ tenantId: id, userId: SYSTEM }, (tx) =>
      tx.select().from(membership),
    );
    expect(rows).toEqual([]);
  });

  it('refuses to seed over data that is already there', async () => {
    const id = await newDemoTenant('seed-twice');
    await seedDemoTenant(deps, id);

    await expect(seedDemoTenant(deps, id)).rejects.toThrow(/already/i);
  }, 120_000);

  it('a different tenant never sees the demo people', async () => {
    const demo = await newDemoTenant('seed-isolated');
    const other = await newDemoTenant('seed-other', false);
    await seedDemoTenant(deps, demo);

    const visible = await deps.withTenant({ tenantId: other, userId: SYSTEM }, async (tx) => ({
      patients: await tx.select().from(patient),
      members: await tx.select().from(membership),
      professionals: await tx.select().from(professional),
      audit: await tx.select().from(auditEvent).where(eq(auditEvent.action, 'patient.created')),
    }));
    expect(visible).toEqual({ patients: [], members: [], professionals: [], audit: [] });
  }, 120_000);

  it('uses the password policy and a rotated password when asked', async () => {
    const id = await newDemoTenant('seed-rotated');
    const passwords = new Map<string, string>();

    await seedDemoTenant(
      {
        ...deps,
        passwordFor: (key) => {
          passwords.set(key, `rotated-${key}-passphrase`);
          return `rotated-${key}-passphrase`;
        },
        emailFor: (account) => account.email.replace('@', '+rotated@'),
      },
      id,
    );

    expect(passwords.size).toBe(DEMO_ACCOUNTS.length);
    const [row] = await deps.withTenant({ tenantId: id, userId: SYSTEM }, (tx) =>
      tx.select({ hash: userAccount.passwordHash }).from(userAccount).limit(1),
    );
    expect(row?.hash).toMatch(/^\$argon2id\$/);
  }, 120_000);
});

describe('signing in to the seeded demo as each role', () => {
  let slug: string;

  beforeAll(async () => {
    slug = 'seed-login';
    const id = await newDemoTenant(slug);
    await seedDemoTenant(deps, id);
  }, 120_000);

  async function signIn(email: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: browserHeaders(slug),
      payload: { email, password: DEMO_PASSWORD },
    });
    expect(response.statusCode, email).toBe(200);
    return sessionCookieOf(response.headers['set-cookie']);
  }

  async function meOf(email: string): Promise<MeResponse> {
    const cookie = await signIn(email);
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { host: `${slug}.consultorio.test`, cookie },
    });
    return response.json<MeResponse>();
  }

  it.each(DEMO_ACCOUNTS.map((account) => [account.label, account] as const))(
    '%s signs in with the documented password and gets the permissions of the role',
    async (_label, account) => {
      const me = await meOf(account.email);

      expect(me.roles).toEqual([...account.roles]);
      expect(me.permissions.sort()).toEqual(effectivePermissions(account.roles, []).sort());
      expect(me.tenantStatus).toBe('active');
    },
    60_000,
  );

  it('a professional gets the clinical permissions of the role', async () => {
    const me = await meOf('cardiologia@demo.invalid');

    expect(me.permissions).toContain('clinical.anamnesis.write');
  });
});
