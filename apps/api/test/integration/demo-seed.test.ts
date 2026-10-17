import { randomBytes } from 'node:crypto';

import { effectivePermissions, type MeResponse } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
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
let storage: MemoryObjectStorage;
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
  storage = createMemoryObjectStorage();
  deps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({
      kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
    }),
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock,
    documents: { storage, scanner: createFakeScanner() },
  };
  // The application reads what the seed encrypted, so both share the same key service.
  app = buildTestApplication(runtime, { clock, keys: deps.keys });
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
        assignments: await count('care_assignment'),
        flagged: (
          await tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM patient WHERE cardinality(safety_flags) > 0`,
          )
        ).rows[0]?.n,
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
    expect(counts.assignments).toBe(data.care.length);
    // Only the structured facts of the anamnesis raise an alert: allergy, anticoagulant, pregnancy, device.
    expect(counts.flagged).toBe(
      data.care.filter(
        (entry) =>
          entry.anamnesis &&
          (entry.anamnesis.allergies.length > 0 ||
            entry.anamnesis.indicators.anticoagulated ||
            entry.anamnesis.medications.some((medication) => medication.anticoagulant) ||
            entry.anamnesis.indicators.pregnant ||
            entry.anamnesis.indicators.implantedDevice),
      ).length,
    );
  }, 120_000);

  it('fills the agenda: today, last week and next week, with every status and the identity review', async () => {
    const id = await newDemoTenant('seed-agenda');

    await seedDemoTenant(deps, id);

    const rows = await deps.withTenant({ tenantId: id, userId: SYSTEM }, async (tx) => {
      const statuses = await tx.execute<{ status: string; n: number }>(
        sql`SELECT status, count(*)::int AS n FROM appointment GROUP BY status`,
      );
      const days = await tx.execute<{ n: number }>(
        sql`SELECT count(DISTINCT (starts_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::int AS n FROM appointment`,
      );
      const professionals = await tx.execute<{ n: number }>(
        sql`SELECT count(DISTINCT professional_id)::int AS n FROM appointment`,
      );
      const review = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM worklist_item WHERE kind = 'identity_review' AND status = 'open'`,
      );
      const occupancy = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM slot_occupancy`,
      );
      const setup = await tx.execute<{ types: number; blocks: number; daysOff: number }>(
        sql`SELECT (SELECT count(*) FROM appointment_type)::int AS types,
                   (SELECT count(*) FROM schedule_block)::int AS blocks,
                   (SELECT count(*) FROM tenant_day_off)::int AS "daysOff"`,
      );
      return {
        statuses: new Map(statuses.rows.map((row) => [row.status, row.n])),
        days: days.rows[0]?.n ?? 0,
        professionals: professionals.rows[0]?.n ?? 0,
        review: review.rows[0]?.n ?? 0,
        occupancy: occupancy.rows[0]?.n ?? 0,
        setup: setup.rows[0],
      };
    });

    for (const status of [
      'scheduled',
      'confirmed',
      'in_progress',
      'attended',
      'no_show',
      'cancelled',
    ]) {
      expect(rows.statuses.get(status) ?? 0, status).toBeGreaterThan(0);
    }
    expect(rows.days).toBeGreaterThanOrEqual(8);
    expect(rows.professionals).toBe(3);
    expect(rows.review).toBeGreaterThanOrEqual(1);
    // A cancelled visit frees its time; the rest keep theirs.
    expect(rows.occupancy).toBeGreaterThan(20);
    expect(rows.setup?.types).toBeGreaterThanOrEqual(3);
    expect(rows.setup?.blocks).toBe(1);
    expect(rows.setup?.daysOff).toBe(1);
  }, 120_000);

  it('records the clinical story: notes per specialty, a draft, an addendum, an entry in error, one restricted', async () => {
    const id = await newDemoTenant('seed-clinical');
    const data = buildDemoDataset();

    await seedDemoTenant(deps, id);

    const snapshot = await snapshotDemoTenant(deps.withTenant, id);
    // The story of the day (consultations opened from appointments) adds its own notes on top.
    expect(snapshot.notes.filter((note) => !note.fromAppointment)).toHaveLength(data.notes.length);
    const byAuthor = (specialty: string) =>
      snapshot.notes.filter((note) => note.specialties.includes(specialty));
    expect(
      byAuthor('Cardiología').filter((note) => note.status === 'signed').length,
    ).toBeGreaterThanOrEqual(3);
    expect(byAuthor('Pediatría').every((note) => note.template === 'general')).toBe(true);
    expect(byAuthor('Psicología').every((note) => note.template === 'psychology')).toBe(true);
    expect(
      snapshot.notes.filter((note) => note.status === 'draft' && !note.fromAppointment),
    ).toHaveLength(data.notes.filter((note) => note.state === 'draft').length);
    expect(snapshot.notes.some((note) => note.addenda > 0)).toBe(true);
    expect(snapshot.notes.some((note) => note.status === 'entered_in_error')).toBe(true);
    expect(snapshot.notes.some((note) => note.visibility === 'author_only')).toBe(true);
  }, 120_000);

  it('tells the Stage 2 story of the day: consultations opened from appointments, an addendum, scanned documents and a refusal', async () => {
    const id = await newDemoTenant('seed-stage2');

    await seedDemoTenant(deps, id);

    const snapshot = await snapshotDemoTenant(deps.withTenant, id);
    // Consultations opened from an appointment (D20): signed ones, and the visit in progress as a draft.
    const fromAppointment = snapshot.notes.filter((note) => note.fromAppointment);
    expect(fromAppointment.length).toBeGreaterThanOrEqual(3);
    expect(fromAppointment.some((note) => note.status === 'signed')).toBe(true);
    expect(fromAppointment.some((note) => note.status === 'signed' && note.addenda > 0)).toBe(true);
    // Documents: both classifications, the verdict of the scan, and the links to the visit.
    expect(snapshot.documents.length).toBeGreaterThanOrEqual(6);
    expect(new Set(snapshot.documents.map((file) => file.classification))).toEqual(
      new Set(['administrative', 'clinical']),
    );
    const available = snapshot.documents.filter((file) => file.status === 'available');
    expect(available.length).toBeGreaterThanOrEqual(5);
    expect(available.every((file) => file.scanResult === 'clean')).toBe(true);
    expect(snapshot.documents.some((file) => file.linkedTo.includes('encounter'))).toBe(true);
    expect(snapshot.documents.some((file) => file.linkedTo.includes('appointment'))).toBe(true);
    const refused = snapshot.documents.filter((file) => file.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ scanResult: 'infected', name: 'Archivo sospechoso.txt' });
  }, 120_000);

  it('stores every available document in the bucket, released from quarantine, and nothing of the refused one', async () => {
    const id = await newDemoTenant('seed-stage2-objects');

    await seedDemoTenant(deps, id);

    const keys = storage.keys().filter((key) => key.startsWith(`t/${id}/`));
    const snapshot = await snapshotDemoTenant(deps.withTenant, id);
    expect(keys.filter((key) => key.includes('/docs/'))).toHaveLength(
      snapshot.documents.filter((file) => file.status === 'available').length,
    );
    expect(keys.filter((key) => key.includes('/quarantine/'))).toEqual([]);
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

  it('the assigned professional reads the anamnesis that was recorded, and reception cannot', async () => {
    const cardiology = await signIn('cardiologia@demo.invalid');
    const reception = await signIn('recepcion@demo.invalid');
    const found = await app.inject({
      method: 'GET',
      url: '/patients?q=99000001',
      headers: { host: `${slug}.consultorio.test`, cookie: cardiology },
    });
    const patientId = found.json<{ patients: { id: string; hasSafetyFlag: boolean }[] }>()
      .patients[0];
    expect(patientId?.hasSafetyFlag).toBe(true);

    const own = await app.inject({
      method: 'GET',
      url: `/patients/${patientId?.id ?? ''}/anamnesis`,
      headers: { host: `${slug}.consultorio.test`, cookie: cardiology },
    });
    const refused = await app.inject({
      method: 'GET',
      url: `/patients/${patientId?.id ?? ''}/anamnesis`,
      headers: { host: `${slug}.consultorio.test`, cookie: reception },
    });

    expect(own.statusCode).toBe(200);
    expect(
      own.json<{ current: { content: { allergies: { substance: string }[] } } }>().current.content
        .allergies[0]?.substance,
    ).toBe('Penicilina');
    expect(refused.statusCode).toBe(403);
  }, 60_000);

  it('a professional gets the clinical permissions of the role', async () => {
    const me = await meOf('cardiologia@demo.invalid');

    expect(me.permissions).toContain('clinical.anamnesis.write');
  });
});
