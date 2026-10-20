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
      // Stage 6: the break-glass release requests (record, verify the identity, approve). The operator
      // reads the requester's identity to verify it and writes none of the delivery: never content.
      'archive_release_request',
      'audit_event',
      // Stage 6: the operator asks for the administrative package of the organization it cancels
      // (one row, queued) and reads the state of the packages. No file name, no key, no clinical one.
      'export_package',
      // The country holiday catalog is platform data the operator maintains.
      'holiday_catalog',
      // Administrative configuration, readable only under a support grant.
      'location',
      // The operator's working note on a registration (the application role has no privilege on it).
      'matricula_operator_note',
      // The operator's own accounts, sessions and trail.
      'operator_session',
      'operator_user',
      'platform_audit_event',
      // Matricula verification: the one write the operator makes on a professional.
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
        /^(patient|anamnesis|care_|coverage|payer|data_processing|membership|user_account|session|login_|recovery_|permission_grant|professional_hours|encounter|appointment|slot_|schedule_|tenant_day_off|worklist|clinical|document|prescription|payment|invoice)/.test(
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

describe('the operator role reaches no more than it needs (security review, finding 7)', () => {
  const asOperatorOf = (tenantId: string, statement: ReturnType<typeof sql>) =>
    harness.db.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${tenantId}, true)`,
      );
      return tx.execute(statement);
    });

  const insertKey = (tenantId: string, version: number) =>
    sql`INSERT INTO tenant_key (tenant_id, purpose, version, kek_id, dek_wrapped, status)
          VALUES (${tenantId}, 'tenant-dek', ${version}, 'local-v1', decode('00ff', 'hex'),
                  ${version === 1 ? 'active' : 'retired'})`;

  it('cannot add a data key to an organization that already has members', async () => {
    const claimed = await createTestTenant(runtime, { slug: 'op-priv-claimed' });
    await createTestProfessional(runtime, claimed.id);

    await expectPrivilegeError(asOperatorOf(claimed.id, insertKey(claimed.id, 1)), 'claimed');
  });

  it('can add only the first key of a new organization, never a later version', async () => {
    const fresh = await createTestTenant(runtime, { slug: 'op-priv-fresh' });

    await expectPrivilegeError(asOperatorOf(fresh.id, insertKey(fresh.id, 2)), 'version two');
    const first = await asOperatorOf(fresh.id, insertKey(fresh.id, 1));
    expect(first.rowCount).toBe(1);
    await expect(asOperatorOf(fresh.id, insertKey(fresh.id, 1))).rejects.toThrow();
  });

  it('writes into the trail of an organization only the entries its own work produces', async () => {
    const audited = await createTestTenant(runtime, { slug: 'op-priv-audit' });
    const entry = (action: string) =>
      sql`INSERT INTO audit_event (tenant_id, action, outcome) VALUES (${audited.id}, ${action}, 'allow')`;

    for (const action of [
      'tenant.created',
      'support.access',
      'matricula.verified',
      'matricula.unverified',
    ]) {
      expect((await asOperatorOf(audited.id, entry(action))).rowCount, action).toBe(1);
    }
    for (const action of ['patient.created', 'matricula.revoked', 'staff.profile_updated']) {
      await expectPrivilegeError(asOperatorOf(audited.id, entry(action)), action);
    }
  });

  it('reads the registration of a professional, but not the rest of the profile', async () => {
    const created = await createTestProfessional(runtime, tenant.id, {
      matricula: '888111',
      specialties: ['cardiologia'],
    });

    const registration = await asOperatorOf(
      tenant.id,
      sql`SELECT matricula, matricula_jurisdiction, matricula_status
            FROM professional WHERE id = ${created.professionalId}`,
    );
    expect(registration.rows[0]).toMatchObject({ matricula: '888111' });

    for (const column of ['specialties', 'max_simultaneous']) {
      await expectPrivilegeError(
        asOperatorOf(
          tenant.id,
          sql`SELECT ${sql.identifier(column)} FROM professional WHERE id = ${created.professionalId}`,
        ),
        column,
      );
    }
    await expectPrivilegeError(
      asOperatorOf(tenant.id, sql`SELECT * FROM professional LIMIT 1`),
      'select *',
    );
  });
});
