import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { professional } from '../../src/db/schema/staff.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createOperatorHarness, type OperatorHarness } from '../support/operator.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

let owner: pg.Client;
let runtime: DbHandle;
let harness: OperatorHarness;
let tenant: TestTenant;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  tenant = await createTestTenant(runtime, { slug: 'op-priv' });
});

afterAll(async () => {
  await owner.end();
  await harness.close();
  await runtime.close();
});

/** Every table of the schema on which the operator role has ANY privilege, table or column. */
async function tablesTouchedByOperator(): Promise<string[]> {
  const result = await owner.query<{ relname: string }>(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND (
          has_table_privilege('app_operator', c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege('app_operator', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
        )
      ORDER BY c.relname`,
  );
  return result.rows.map((row) => row.relname);
}

const allTables = async () =>
  (
    await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        ORDER BY c.relname`,
    )
  ).rows.map((row) => row.relname);

/** Drizzle wraps the driver error: the SQLSTATE 42501 (insufficient privilege) is on its cause. */
async function expectPrivilegeError(promise: Promise<unknown>, label: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, label).not.toBeNull();
  const code =
    (error as { cause?: { code?: string }; code?: string }).cause?.code ??
    (error as { code?: string }).code;
  expect(code, label).toBe('42501');
}

describe('the operator database role is an allowlist', () => {
  it('touches only the tenant row, the platform tables and a few administrative tables', async () => {
    expect(await tablesTouchedByOperator()).toEqual([
      // Creating an organization: its row, data key, owner invitation and first audit entry.
      'action_token',
      'audit_event',
      // Administrative configuration, readable only under a support grant.
      'location',
      // The operator's own accounts, sessions and trail.
      'operator_session',
      'operator_user',
      'platform_audit_event',
      // Matricula verification (the one write the operator makes on a professional).
      'professional',
      'tenant',
      'tenant_feature',
      'tenant_key',
    ]);
  });

  it('has no privilege at all on any clinical, patient, staff-account or scheduling table', async () => {
    const touched = new Set(await tablesTouchedByOperator());
    const forbidden = (await allTables()).filter(
      (table) =>
        /^(patient|anamnesis|care_|coverage|payer|data_processing|membership|user_account|session|login_|recovery_|permission_grant|professional_hours|encounter|appointment|clinical|document|prescription|payment|invoice)/.test(
          table,
        ) || ['patient', 'anamnesis', 'membership', 'user_account', 'session'].includes(table),
    );

    expect(forbidden.length).toBeGreaterThan(8);
    for (const table of forbidden) {
      expect(touched.has(table), `app_operator must not touch ${table}`).toBe(false);
    }
  });

  it('is refused when it tries to read a patient or clinical table for real', async () => {
    for (const table of ['patient', 'anamnesis', 'patient_version', 'membership', 'user_account']) {
      await expectPrivilegeError(
        harness.db.db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${tenant.id}, true), set_config('app.user_id', ${tenant.id}, true)`,
          );
          return tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`);
        }),
        table,
      );
    }
  });

  it('cannot create, drop or alter anything', async () => {
    await expect(harness.db.db.execute(sql`CREATE TABLE public.oops (id int)`)).rejects.toThrow();
    await expect(harness.db.db.execute(sql`DROP TABLE public.tenant`)).rejects.toThrow();
    await expect(
      harness.db.db.execute(sql`TRUNCATE public.platform_audit_event`),
    ).rejects.toThrow();
  });

  it('is not a way around isolation: no tenant context, no tenant rows', async () => {
    await expect(harness.db.db.execute(sql`SELECT id FROM tenant_feature`)).rejects.toThrow();
  });
});

describe('matricula verification through the operator role', () => {
  it('lets the operator verify a matricula, and nothing else about the profile', async () => {
    const created = await createTestProfessional(runtime, tenant.id, { matricula: '654321' });
    const operatorId = created.id;

    await harness.db.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
      await tx
        .update(professional)
        .set({
          matriculaStatus: 'verified',
          verifiedByOperator: operatorId,
          verifiedAt: new Date(),
        })
        .where(eq(professional.id, created.professionalId));
    });
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(professional).where(eq(professional.id, created.professionalId)),
    );
    expect(row).toMatchObject({ matriculaStatus: 'verified', matricula: '654321' });

    // The profile itself stays the organization's: the operator cannot rewrite it.
    await expect(
      harness.db.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
        await tx
          .update(professional)
          .set({ matricula: '999999' })
          .where(eq(professional.id, created.professionalId));
      }),
    ).rejects.toThrow();
  });

  it('is the only role that can: the application role cannot mark a matricula verified', async () => {
    const created = await createTestProfessional(runtime, tenant.id, { matricula: '777001' });

    await expect(
      asTenant(runtime, tenant.id, (tx) =>
        tx
          .update(professional)
          .set({ matriculaStatus: 'verified' })
          .where(eq(professional.id, created.professionalId)),
      ),
    ).rejects.toThrow();
  });
});
