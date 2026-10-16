import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { clinicalPolicies, tenantPolicies } from '../../src/db/schema/_helpers.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { tenant } from '../../src/db/schema/tenant.js';
import {
  readableBasis,
  sqlTemplateKind,
  type ClinicalEntry,
} from '../../src/platform/authz/sharing-scope.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

/**
 * The SQL backstop of clinical access (ADR-002, ADR-003), exercised on test-only tables that carry
 * the same policies a real clinical table will. Everything runs as `app_rw`, so the policies are
 * really enforced.
 */
let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;

const ME = randomUUID();
const COLLEAGUE = randomUUID();
const OTHER = randomUUID();
const ADMIN_USER = randomUUID();

const run = createWithTenant;

/** Statements of a migration helper, one by one. */
const statements = (text: string) => text.split('\n--> statement-breakpoint\n');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'backstop-a' });
  b = await createTestTenant(runtime, { slug: 'backstop-b' });
  // Real profiles behind the ids the tests use (the care tables key on the profile).
  for (const id of [ME, COLLEAGUE, OTHER]) await createTestProfessional(runtime, a.id, { id });

  const tables = [
    // A note: carries its template.
    { name: 'test_clinical_item', policies: clinicalPolicies('test_clinical_item') },
    // Anamnesis, documents, consent: follow the general ceiling.
    {
      name: 'test_clinical_general',
      policies: clinicalPolicies('test_clinical_general', { templateKind: null }),
    },
    // Prescriptions: never follow sharing (D17).
    {
      name: 'test_clinical_prescription',
      policies: clinicalPolicies('test_clinical_prescription', {
        templateKind: { constant: 'prescription' },
      }),
    },
  ];
  for (const table of tables) {
    await owner.query(`
      CREATE TABLE ${table.name} (
        id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
        tenant_id uuid NOT NULL REFERENCES tenant (id),
        patient_id uuid NOT NULL,
        author_professional_id uuid NOT NULL,
        visibility text NOT NULL DEFAULT 'default',
        template_kind text,
        body text NOT NULL DEFAULT 'clinical content'
      )`);
    for (const statement of [
      ...statements(tenantPolicies(table.name)),
      ...statements(table.policies),
    ]) {
      await owner.query(statement);
    }
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table.name} TO app_rw`);
  }
});

afterAll(async () => {
  await owner.query(
    'DROP TABLE IF EXISTS test_clinical_item, test_clinical_general, test_clinical_prescription',
  );
  await owner.end();
  await runtime.close();
});

async function setSharing(tenantOf: TestTenant, settings: Record<string, unknown>) {
  await asTenant(runtime, tenantOf.id, (tx) =>
    tx.update(tenant).set({ settings }).where(eq(tenant.id, tenantOf.id)),
  );
}

/** Inserts rows the way the author would, in their own professional transaction. */
async function insertItem(
  table: string,
  tenantOf: TestTenant,
  row: { patient: string; author: string; visibility?: string; template?: string | null },
) {
  await run(runtime.db)(
    { tenantId: tenantOf.id, userId: randomUUID(), actingProfessionalId: row.author },
    (tx) =>
      tx.execute(
        sql`insert into ${sql.identifier(table)} (tenant_id, patient_id, author_professional_id, visibility, template_kind)
            values (${tenantOf.id}, ${row.patient}, ${row.author}, ${row.visibility ?? 'default'}, ${row.template ?? null})`,
      ),
  );
}

async function treat(tenantOf: TestTenant, patient: string, professional: string) {
  await asTenant(runtime, tenantOf.id, (tx) =>
    tx.insert(careAssignment).values({
      tenantId: tenantOf.id,
      patientId: patient,
      professionalId: professional,
      assignedBy: ADMIN_USER,
    }),
  );
}

async function visible(
  table: string,
  tenantOf: TestTenant,
  actor: { professional?: string },
  patient?: string,
): Promise<number> {
  const result = await run(runtime.db)(
    {
      tenantId: tenantOf.id,
      userId: randomUUID(),
      ...(actor.professional === undefined ? {} : { actingProfessionalId: actor.professional }),
    },
    (tx) =>
      tx.execute<{ n: number }>(
        patient === undefined
          ? sql`select count(*)::int as n from ${sql.identifier(table)}`
          : sql`select count(*)::int as n from ${sql.identifier(table)} where patient_id = ${patient}`,
      ),
  );
  return result.rows[0]?.n ?? -1;
}

describe('administrators and reception see no clinical rows at all', () => {
  it('returns 0 rows to a transaction without a professional id, whatever is stored', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, { patient, author: ME, template: 'general' });

    expect(await visible('test_clinical_item', a, {}, patient)).toBe(0);
    expect(await visible('test_clinical_item', a, {})).toBe(0);
    // The author, as a professional, does see it: the rows are there.
    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(1);
  });

  it('applies to every table that carries the policies', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_general', a, { patient, author: ME });
    await insertItem('test_clinical_prescription', a, { patient, author: ME });

    for (const table of ['test_clinical_general', 'test_clinical_prescription']) {
      expect(await visible(table, a, {}, patient), table).toBe(0);
      expect(await visible(table, a, { professional: ME }, patient), table).toBe(1);
    }
  });

  it('cannot be written to either: an insert without a professional id is refused', async () => {
    await expect(
      run(runtime.db)({ tenantId: a.id, userId: ADMIN_USER }, (tx) =>
        tx.execute(
          sql`insert into test_clinical_item (tenant_id, patient_id, author_professional_id) values (${a.id}, ${randomUUID()}, ${ME})`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('professionals and the care relationship', () => {
  it('a professional who does not treat the patient sees 0 rows', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, { patient, author: COLLEAGUE, template: 'general' });

    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(0);
  });

  it('a treating professional sees the entry, and stops seeing it when the assignment ends', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, { patient, author: COLLEAGUE, template: 'general' });
    await treat(a, patient, ME);

    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(1);

    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(careAssignment)
        .set({ removedAt: new Date() })
        .where(and(eq(careAssignment.patientId, patient), eq(careAssignment.professionalId, ME))),
    );
    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(0);
  });

  it('treating one patient opens nothing of another patient', async () => {
    const treated = randomUUID();
    const stranger = randomUUID();
    await insertItem('test_clinical_item', a, {
      patient: treated,
      author: COLLEAGUE,
      template: 'general',
    });
    await insertItem('test_clinical_item', a, {
      patient: stranger,
      author: COLLEAGUE,
      template: 'general',
    });
    await treat(a, treated, ME);

    expect(await visible('test_clinical_item', a, { professional: ME }, treated)).toBe(1);
    expect(await visible('test_clinical_item', a, { professional: ME }, stranger)).toBe(0);
  });

  it('the treating professional of tenant A sees nothing in tenant B', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', b, { patient, author: COLLEAGUE, template: 'general' });
    await treat(a, patient, ME);

    expect(await visible('test_clinical_item', b, { professional: ME }, patient)).toBe(0);
  });
});

describe('author_only', () => {
  it('hides the entry from a treating professional and from sharing, and shows it to the author', async () => {
    const patient = randomUUID();
    await setSharing(a, { clinicalSharing: true, sharedTemplates: ['general'] });
    await insertItem('test_clinical_item', a, {
      patient,
      author: COLLEAGUE,
      visibility: 'author_only',
      template: 'general',
    });
    await treat(a, patient, ME);

    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(0);
    expect(await visible('test_clinical_item', a, { professional: OTHER }, patient)).toBe(0);
    expect(await visible('test_clinical_item', a, { professional: COLLEAGUE }, patient)).toBe(1);
  });
});

describe('sharing on and off, and the shared scope', () => {
  const shared = (templates: string[]) => ({ clinicalSharing: true, sharedTemplates: templates });

  it('shares a listed template with a non-treating professional only while sharing is on', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, { patient, author: COLLEAGUE, template: 'general' });

    await setSharing(a, shared(['general']));
    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(1);

    await setSharing(a, { clinicalSharing: false, sharedTemplates: ['general'] });
    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(0);
  });

  it('takes effect immediately: the very next transaction sees the new setting', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, { patient, author: COLLEAGUE, template: 'general' });
    await setSharing(a, shared(['general']));
    const before = await visible('test_clinical_item', a, { professional: ME }, patient);
    await setSharing(a, shared([]));
    const after = await visible('test_clinical_item', a, { professional: ME }, patient);

    expect([before, after]).toEqual([1, 0]);
  });

  it('excludes psychology unless it was added, and templates that were never listed', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, {
      patient,
      author: COLLEAGUE,
      template: 'psychology',
    });
    await insertItem('test_clinical_item', a, {
      patient,
      author: COLLEAGUE,
      template: 'dermatology',
    });

    await setSharing(a, shared(['general', 'odontology', 'physiotherapy', 'nutrition']));
    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(0);

    await setSharing(a, shared(['general', 'psychology']));
    expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(1);
  });

  it('shares anamnesis-like entries under the general ceiling when sharing is on', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_general', a, { patient, author: COLLEAGUE });

    await setSharing(a, shared([]));
    expect(await visible('test_clinical_general', a, { professional: ME }, patient)).toBe(1);
    await setSharing(a, { clinicalSharing: false, sharedTemplates: [] });
    expect(await visible('test_clinical_general', a, { professional: ME }, patient)).toBe(0);
  });

  it('never shares a prescription (D17), even if "prescription" is on the list', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_prescription', a, { patient, author: COLLEAGUE });
    await setSharing(a, shared(['general', 'prescription']));

    expect(await visible('test_clinical_prescription', a, { professional: ME }, patient)).toBe(0);
    // The prescriber and the treating professionals still read it.
    expect(
      await visible('test_clinical_prescription', a, { professional: COLLEAGUE }, patient),
    ).toBe(1);
    await treat(a, patient, ME);
    expect(await visible('test_clinical_prescription', a, { professional: ME }, patient)).toBe(1);
  });

  it('does not share with a non-professional, however the sharing is set', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, { patient, author: COLLEAGUE, template: 'general' });
    await setSharing(a, shared(['general']));

    expect(await visible('test_clinical_item', a, {}, patient)).toBe(0);
  });

  it('shares nothing from a transaction that never loaded the settings (sharing defaults to off)', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, { patient, author: COLLEAGUE, template: 'general' });
    await setSharing(a, shared(['general']));

    // A raw transaction that sets the professional but not the sharing settings.
    const result = await run(runtime.db)({ tenantId: a.id, userId: randomUUID() }, async (tx) => {
      await tx.execute(sql`select set_config('app.professional_id', ${ME}, true)`);
      return tx.execute<{ n: number }>(
        sql`select count(*)::int as n from test_clinical_item where patient_id = ${patient}`,
      );
    });

    expect(result.rows[0]?.n).toBe(0);
  });

  it('tolerates a damaged settings document: sharing off, nothing shared', async () => {
    const patient = randomUUID();
    await insertItem('test_clinical_item', a, { patient, author: COLLEAGUE, template: 'general' });

    for (const settings of [
      { clinicalSharing: 'yes', sharedTemplates: ['general'] },
      { clinicalSharing: true, sharedTemplates: 'general' },
      { clinicalSharing: true },
      {},
    ]) {
      await setSharing(a, settings);
      expect(await visible('test_clinical_item', a, { professional: ME }, patient)).toBe(0);
    }
  });
});

describe('writing', () => {
  it("lets a professional create their own entry and refuses one written in someone else's name", async () => {
    const patient = randomUUID();

    await insertItem('test_clinical_item', a, { patient, author: ME, template: 'general' });
    await expect(
      run(runtime.db)({ tenantId: a.id, userId: randomUUID(), actingProfessionalId: ME }, (tx) =>
        tx.execute(
          sql`insert into test_clinical_item (tenant_id, patient_id, author_professional_id) values (${a.id}, ${patient}, ${COLLEAGUE})`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('the SQL function and the TypeScript predicate agree', () => {
  const PATIENTS = { treated: randomUUID(), untreated: randomUUID() };

  beforeAll(async () => {
    await treat(a, PATIENTS.treated, ME);
  });

  const templates = [
    'general',
    'odontology',
    'physiotherapy',
    'nutrition',
    'psychology',
    'newcomer',
  ];
  const kinds = ['note', 'anamnesis', 'document', 'consent', 'prescription'] as const;

  const scenarioArb = fc.record({
    treating: fc.boolean(),
    entry: fc.record({
      kind: fc.constantFrom(...kinds),
      authorProfessionalId: fc.constantFrom(ME, COLLEAGUE, OTHER),
      visibility: fc.constantFrom('default', 'author_only'),
      templateKind: fc.option(fc.constantFrom(...templates), { nil: null }),
    }),
    settings: fc.record({
      clinicalSharing: fc.boolean(),
      sharedTemplates: fc.subarray([...templates, 'prescription']),
    }),
  });

  it('give the same answer on random actor and entry combinations', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ treating, entry, settings }) => {
        const patientId = treating ? PATIENTS.treated : PATIENTS.untreated;
        const full: ClinicalEntry = {
          ...entry,
          patientId,
          visibility: entry.visibility,
        };
        const expected = readableBasis({
          entry: full,
          professionalId: ME,
          treating,
          settings: settings,
        }).readable;

        const answer = await run(runtime.db)(
          { tenantId: a.id, userId: randomUUID(), actingProfessionalId: ME },
          async (tx) => {
            // The settings under test, as withTenant would have loaded them.
            await tx.execute(
              sql`select set_config('app.clinical_sharing', ${String(settings.clinicalSharing)}, true),
                         set_config('app.shared_templates', ${settings.sharedTemplates.join(',')}, true)`,
            );
            const result = await tx.execute<{ allowed: boolean }>(
              sql`select app.clinical_readable(${patientId}, ${full.authorProfessionalId}, ${full.visibility}, ${sqlTemplateKind(full)}) as allowed`,
            );
            return result.rows[0]?.allowed;
          },
        );

        expect(answer).toBe(expected);
      }),
      { numRuns: 150 },
    );
  }, 120_000);
});
