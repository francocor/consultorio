import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { careAssignment } from '../../src/db/schema/care.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID, type Tx } from '../../src/platform/db/tenant-context.js';
import { asProfessional } from '../support/clinical.js';
import { createTestPatient } from '../support/patients.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional, createTestUser } from '../support/users.js';

/**
 * The prescription table (e-prescription, "Immutability and cancellation", "Clinical access rules",
 * decision D17). Every check runs as `app_rw`, the role the API uses, so row level security, the
 * privileges and the triggers are the real ones. The rows hold placeholder bytes: the service that
 * encrypts a real prescription has its own tests.
 */

let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;
let author: string;
let treating: string;
let stranger: string;
let patientId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'prescription-schema-a' });
  b = await createTestTenant(runtime, { slug: 'prescription-schema-b' });
  author = (await createTestProfessional(runtime, a.id)).professionalId;
  treating = (await createTestProfessional(runtime, a.id)).professionalId;
  stranger = (await createTestProfessional(runtime, a.id)).professionalId;
  patientId = await createTestPatient(runtime, a.id);
  // The professionals who treat the patient: the care relationship comes from an assignment.
  for (const professionalId of [author, treating]) {
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(careAssignment).values({
        tenantId: a.id,
        patientId,
        professionalId,
        assignedBy: randomUUID(),
      }),
    );
  }
});

afterAll(async () => {
  await owner.end();
  await runtime.close();
});

/** A prescription as its author writes it, waiting for the provider. */
async function insertPending(
  tx: Tx,
  input: { tenantId?: string; patient?: string; by?: string; status?: string } = {},
): Promise<string> {
  const result = await tx.execute<{ id: string }>(
    sql`INSERT INTO prescription (tenant_id, patient_id, author_professional_id, client_key,
                                  content_enc, prescription_date, idempotency_key, status)
          VALUES (${input.tenantId ?? a.id}, ${input.patient ?? patientId}, ${input.by ?? author},
                  ${randomUUID()}, ${Buffer.from([1, 2, 3])}, date '2031-01-02',
                  ${'key-' + randomUUID()}, ${input.status ?? 'pending_submission'})
          RETURNING id`,
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no row');
  return id;
}

const asAuthor = <T>(fn: (tx: Tx) => Promise<T>) => asProfessional(runtime, a.id, author, fn);

async function issue(id: string, externalId = `EXT-${randomUUID().slice(0, 8)}`) {
  await asAuthor((tx) =>
    tx.execute(
      sql`UPDATE prescription SET status = 'issued', external_id = ${externalId}, issued_at = now() WHERE id = ${id}`,
    ),
  );
  return externalId;
}

const setSettings = (settings: Record<string, unknown>) =>
  asTenant(runtime, a.id, (tx) =>
    tx.update(tenantTable).set({ settings }).where(eq(tenantTable.id, a.id)),
  );

async function statusOf(id: string): Promise<string | undefined> {
  const rows = await asAuthor((tx) =>
    tx.execute<{ status: string }>(sql`SELECT status FROM prescription WHERE id = ${id}`),
  );
  return rows.rows[0]?.status;
}

describe('the prescription tables are protected by the database', () => {
  it.each(['prescription', 'erx_connection'])(
    '%s has row level security enabled and forced',
    async (table) => {
      const result = await owner.query<{ enabled: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE relname = $1`,
        [table],
      );

      expect(result.rows).toEqual([{ enabled: true, forced: true }]);
    },
  );

  it('carries the tenant policy and the two restrictive clinical policies', async () => {
    const result = await owner.query<{ policyname: string; permissive: string }>(
      `SELECT policyname, permissive FROM pg_policies WHERE tablename = 'prescription' ORDER BY policyname`,
    );
    const restrictive = result.rows
      .filter((row) => row.permissive === 'RESTRICTIVE')
      .map((row) => row.policyname);

    expect(result.rows.map((row) => row.policyname)).toContain('tenant_isolation');
    expect(restrictive).toEqual(['clinical_professionals_only', 'clinical_scope']);
  });

  it.each(['prescription', 'erx_connection'])(
    '%s: the runtime role can never delete or truncate',
    async (table) => {
      const result = await owner.query<{ del: boolean; trunc: boolean }>(
        `SELECT has_table_privilege('app_rw', $1, 'DELETE') AS del,
                has_table_privilege('app_rw', $1, 'TRUNCATE') AS trunc`,
        [table],
      );

      expect(result.rows).toEqual([{ del: false, trunc: false }]);
    },
  );

  it('refuses a DELETE from the runtime role with insufficient_privilege', async () => {
    const id = await asAuthor((tx) => insertPending(tx));

    await expect(
      asAuthor((tx) => tx.execute(sql`DELETE FROM prescription WHERE id = ${id}`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('stops the owner too: a prescription is never deleted, trigger included', async () => {
    const id = await asAuthor((tx) => insertPending(tx));

    await owner.query('BEGIN');
    try {
      await owner.query(`select set_config('app.tenant_id', $1, true)`, [a.id]);
      await expect(owner.query('DELETE FROM prescription WHERE id = $1', [id])).rejects.toThrow(
        /never deleted/,
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('who sees a prescription (decision D17)', () => {
  let id: string;

  beforeAll(async () => {
    id = await asAuthor((tx) => insertPending(tx));
  });

  const count = (tx: Tx) =>
    tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM prescription WHERE id = ${id}`);

  it('shows it to its author and to a professional who treats the patient', async () => {
    const own = await asAuthor(count);
    const colleague = await asProfessional(runtime, a.id, treating, count);

    expect(own.rows[0]?.n).toBe(1);
    expect(colleague.rows[0]?.n).toBe(1);
  });

  it('shows nothing to a transaction that is not a professional (owner, admin, reception)', async () => {
    const result = await asTenant(runtime, a.id, count);

    expect(result.rows[0]?.n).toBe(0);
  });

  it('shows nothing to a professional with no care relationship, with the sharing scope OFF', async () => {
    const result = await asProfessional(runtime, a.id, stranger, count);

    expect(result.rows[0]?.n).toBe(0);
  });

  it('shows nothing to a professional with no care relationship either with the sharing scope ON and every template shared', async () => {
    await setSettings({ clinicalSharing: true, sharedTemplates: ['general', 'prescription'] });
    try {
      const result = await asProfessional(runtime, a.id, stranger, count);

      expect(result.rows[0]?.n).toBe(0);
    } finally {
      await setSettings({});
    }
  });

  it('shows nothing of another organization, not even to its own professionals', async () => {
    const other = (await createTestProfessional(runtime, b.id)).professionalId;

    const result = await asProfessional(runtime, b.id, other, count);

    expect(result.rows[0]?.n).toBe(0);
  });

  it('lets the worker (the system user) read it, because the jobs that settle prescriptions run for every professional', async () => {
    const result = await createWithTenant(runtime.db)(
      { tenantId: a.id, userId: SYSTEM_USER_ID },
      count,
    );

    expect(result.rows[0]?.n).toBe(1);
  });
});

describe('who writes a prescription', () => {
  it('lets a professional write only their own', async () => {
    await expect(
      asProfessional(runtime, a.id, treating, (tx) => insertPending(tx, { by: author })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('refuses a transaction that is not a professional', async () => {
    await expect(asTenant(runtime, a.id, (tx) => insertPending(tx))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('starts every prescription waiting for the provider: one born issued is refused', async () => {
    await expect(asAuthor((tx) => insertPending(tx, { status: 'issued' }))).rejects.toMatchObject({
      cause: { code: '23000' },
    });
  });

  it('refuses a patient of another organization (composite foreign key)', async () => {
    const foreign = await createTestPatient(runtime, b.id);

    await expect(asAuthor((tx) => insertPending(tx, { patient: foreign }))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });

  it('refuses the same client key twice in an organization, so a double submit makes one prescription', async () => {
    const clientKey = randomUUID();
    const insert = (tx: Tx) =>
      tx.execute(
        sql`INSERT INTO prescription (tenant_id, patient_id, author_professional_id, client_key,
                                      content_enc, prescription_date, idempotency_key)
              VALUES (${a.id}, ${patientId}, ${author}, ${clientKey}, ${Buffer.from([1])},
                      date '2031-01-02', ${'key-' + randomUUID()})`,
      );
    await asAuthor(insert);

    await expect(asAuthor(insert)).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

describe('what a prescription may become', () => {
  it('moves from waiting to issued with the identifier the provider gave', async () => {
    const id = await asAuthor((tx) => insertPending(tx));

    const externalId = await issue(id);

    expect(await statusOf(id)).toBe('issued');
    const row = await asAuthor((tx) =>
      tx.execute<{ external_id: string }>(
        sql`SELECT external_id FROM prescription WHERE id = ${id}`,
      ),
    );
    expect(row.rows[0]?.external_id).toBe(externalId);
  });

  it('refuses an issued prescription without an identifier (the shape of each status)', async () => {
    const id = await asAuthor((tx) => insertPending(tx));

    await expect(
      asAuthor((tx) =>
        tx.execute(
          sql`UPDATE prescription SET status = 'issued', issued_at = now() WHERE id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('never lets the content of an issued prescription change', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await issue(id);

    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET content_enc = ${Buffer.from([9])} WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('never lets the identifier of an issued prescription change', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await issue(id);

    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET external_id = 'OTHER' WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('refuses to swap the content of a prescription that is waiting for the provider', async () => {
    const id = await asAuthor((tx) => insertPending(tx));

    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET content_enc = ${Buffer.from([9])} WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('lets a refused draft be corrected and sent again', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await asAuthor((tx) =>
      tx.execute(
        sql`UPDATE prescription SET status = 'draft', rejection_message = 'Una línea está vacía' WHERE id = ${id}`,
      ),
    );

    await asAuthor((tx) =>
      tx.execute(
        sql`UPDATE prescription SET content_enc = ${Buffer.from([7])}, status = 'pending_submission', rejection_message = NULL WHERE id = ${id}`,
      ),
    );

    expect(await statusOf(id)).toBe('pending_submission');
  });

  it('cancels an issued prescription with its reason, and keeps the reason', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await issue(id);

    await asAuthor((tx) =>
      tx.execute(
        sql`UPDATE prescription SET status = 'cancelled', cancel_reason_enc = ${Buffer.from([5])}, cancelled_at = now() WHERE id = ${id}`,
      ),
    );

    expect(await statusOf(id)).toBe('cancelled');
    await expect(
      asAuthor((tx) =>
        tx.execute(
          sql`UPDATE prescription SET cancel_reason_enc = ${Buffer.from([6])} WHERE id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('refuses a cancellation without a reason (the shape of each status)', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await issue(id);

    await expect(
      asAuthor((tx) =>
        tx.execute(
          sql`UPDATE prescription SET status = 'cancelled', cancelled_at = now() WHERE id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it.each(['dispensed', 'expired'])(
    'ends at %s: nothing leaves a prescription the provider settled',
    async (final) => {
      const id = await asAuthor((tx) => insertPending(tx));
      await issue(id);
      await asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET status = ${final} WHERE id = ${id}`),
      );

      await expect(
        asAuthor((tx) =>
          tx.execute(
            sql`UPDATE prescription SET status = 'cancelled', cancel_reason_enc = ${Buffer.from([5])}, cancelled_at = now() WHERE id = ${id}`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: '23000' } });
    },
  );

  it('refuses to go back from issued to waiting for the provider', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await issue(id);

    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET status = 'pending_submission' WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('never changes who or for whom it was written', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    const other = await createTestPatient(runtime, a.id);

    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET patient_id = ${other} WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('lets only the prescriber (or the system) change it: a treating colleague is refused', async () => {
    const id = await asAuthor((tx) => insertPending(tx));

    await expect(
      asProfessional(runtime, a.id, treating, (tx) =>
        tx.execute(sql`UPDATE prescription SET attempts = 1 WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('lets the worker settle what the provider reports', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    const externalId = await issue(id);

    await createWithTenant(runtime.db)({ tenantId: a.id, userId: SYSTEM_USER_ID }, (tx) =>
      tx.execute(sql`UPDATE prescription SET status = 'dispensed' WHERE id = ${id}`),
    );

    expect(await statusOf(id)).toBe('dispensed');
    expect(externalId).toMatch(/^EXT-/);
  });
});

describe('what the two definer functions give away', () => {
  it('finds the organization, the prescription and the prescriber of a provider identifier, and nothing else', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    const externalId = await issue(id);

    const found = await createWithTenant(runtime.db)(
      { tenantId: '00000000-0000-0000-0000-000000000000', userId: SYSTEM_USER_ID },
      (tx) =>
        tx.execute<Record<string, string>>(
          sql`SELECT * FROM app.erx_prescription_by_external_id(${externalId}::text)`,
        ),
    );

    expect(found.rows).toEqual([{ tenant_id: a.id, prescription_id: id, professional_id: author }]);
  });

  it('finds nothing for an identifier nobody holds', async () => {
    const found = await createWithTenant(runtime.db)(
      { tenantId: '00000000-0000-0000-0000-000000000000', userId: SYSTEM_USER_ID },
      (tx) => tx.execute(sql`SELECT * FROM app.erx_prescription_by_external_id('NOT-AN-ID'::text)`),
    );

    expect(found.rows).toEqual([]);
  });

  describe('reception sees that a prescription exists, only when the organization allows it', () => {
    let receptionist: string;
    let admin: string;
    let issuedId: string;

    beforeAll(async () => {
      receptionist = (await createTestUser(runtime, a.id, { roles: ['reception'] })).id;
      admin = (await createTestUser(runtime, a.id, { roles: ['admin'] })).id;
      issuedId = await asAuthor((tx) => insertPending(tx));
      await issue(issuedId);
    });

    const existence = (userId: string) =>
      createWithTenant(runtime.db)({ tenantId: a.id, userId }, async (tx) => {
        const result = await tx.execute<{ id: string; status: string }>(
          sql`SELECT id, status FROM app.reception_prescription_existence(${patientId}::uuid)`,
        );
        return result.rows;
      });

    const setting = (on: boolean) =>
      setSettings(on ? { reception_sees_clinical_metadata: true } : {});

    it('says nothing while the setting is off', async () => {
      await setting(false);

      expect(await existence(receptionist)).toEqual([]);
    });

    it('lists the confirmed prescriptions, with their status and nothing more, once the setting is on', async () => {
      await setting(true);
      try {
        const rows = await existence(receptionist);

        expect(rows.map((row) => row.id)).toContain(issuedId);
        expect(rows.every((row) => Object.keys(row).sort().join() === 'id,status')).toBe(true);
      } finally {
        await setting(false);
      }
    });

    it('never says anything to an admin, whatever the setting says', async () => {
      await setting(true);
      try {
        expect(await existence(admin)).toEqual([]);
      } finally {
        await setting(false);
      }
    });

    it('does not tell reception about a prescription the provider has not confirmed', async () => {
      const pendingId = await asAuthor((tx) => insertPending(tx));
      await setting(true);
      try {
        const rows = await existence(receptionist);

        expect(rows.map((row) => row.id)).not.toContain(pendingId);
      } finally {
        await setting(false);
      }
    });

    it('does not tell reception about a prescription cancelled before the provider confirmed it (JD-S5 R1-A-T6)', async () => {
      const cancelledId = await asAuthor((tx) => insertPending(tx));
      await asAuthor((tx) =>
        tx.execute(
          sql`UPDATE prescription SET status = 'cancelled', cancel_reason_enc = ${Buffer.from([7])},
                     cancelled_at = now() WHERE id = ${cancelledId}`,
        ),
      );
      await setting(true);
      try {
        const rows = await existence(receptionist);

        expect(rows.map((row) => row.id)).toContain(issuedId);
        expect(rows.map((row) => row.id)).not.toContain(cancelledId);
      } finally {
        await setting(false);
      }
    });
  });
});

describe('JD-S5 R1: the guard of the table after the first review', () => {
  const asDraft = async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await asAuthor((tx) =>
      tx.execute(sql`UPDATE prescription SET status = 'draft' WHERE id = ${id}`),
    );
    return id;
  };
  const asTreating = <T>(fn: (tx: Tx) => Promise<T>) => asProfessional(runtime, a.id, treating, fn);

  it('moves the provider key only when a refused draft is sent again, one version up (S5-4)', async () => {
    const id = await asDraft();

    // A draft cannot change its key without being sent again.
    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET idempotency_key = 'k2' WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    // Sent again with the version skipping one, or with the same key: refused.
    await expect(
      asAuthor((tx) =>
        tx.execute(
          sql`UPDATE prescription SET status = 'pending_submission', submission_version = 3,
                     idempotency_key = 'k2' WHERE id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      asAuthor((tx) =>
        tx.execute(
          sql`UPDATE prescription SET status = 'pending_submission', submission_version = 2 WHERE id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    // The correction: pending again, version 2, a new key.
    await asAuthor((tx) =>
      tx.execute(
        sql`UPDATE prescription SET status = 'pending_submission', submission_version = 2,
                   idempotency_key = ${'key-' + randomUUID()} WHERE id = ${id}`,
      ),
    );
    // Once waiting, the key is fixed again.
    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET idempotency_key = 'k3' WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET submission_version = 3 WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('never forgets that the provider may hold the prescription (S5-3)', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await asAuthor((tx) =>
      tx.execute(sql`UPDATE prescription SET provider_contacted_at = now() WHERE id = ${id}`),
    );

    await expect(
      asAuthor((tx) =>
        tx.execute(sql`UPDATE prescription SET provider_contacted_at = NULL WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      asAuthor((tx) =>
        tx.execute(
          sql`UPDATE prescription SET provider_contacted_at = now() + interval '1 hour' WHERE id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('lets a colleague who treats the patient record the document once, and nothing else (S5-1)', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await issue(id);
    const prefix = `t/${a.id}/prescriptions`;

    await asTreating((tx) =>
      tx.execute(
        sql`UPDATE prescription SET document_key = ${`${prefix}/${id}.pdf`} WHERE id = ${id}`,
      ),
    );

    await expect(
      asTreating((tx) =>
        tx.execute(
          sql`UPDATE prescription SET document_key = ${prefix + '/b.pdf'} WHERE id = ${id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTreating((tx) =>
        tx.execute(sql`UPDATE prescription SET status = 'cancelled' WHERE id = ${id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const stored = await asAuthor((tx) =>
      tx.execute<{ document_key: string }>(
        sql`SELECT document_key FROM prescription WHERE id = ${id}`,
      ),
    );
    expect(stored.rows[0]?.document_key).toBe(`${prefix}/${id}.pdf`);
  });

  it('records a document only for an issued prescription, under the prefix of its own organization (R2-9)', async () => {
    const pending = await asAuthor((tx) => insertPending(tx));
    const issued = await asAuthor((tx) => insertPending(tx));
    await issue(issued);

    // Not issued yet: it has no document to record.
    await expect(
      asTreating((tx) =>
        tx.execute(
          sql`UPDATE prescription SET document_key = ${`t/${a.id}/prescriptions/${pending}.pdf`} WHERE id = ${pending}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // Issued, but a key that points anywhere else (another organization, another folder, nothing).
    for (const key of [
      `t/${b.id}/prescriptions/${issued}.pdf`,
      `t/${a.id}/docs/${issued}.pdf`,
      `t/x/prescriptions/${issued}.pdf`,
      '../../etc/passwd',
      // The key of ANOTHER prescription of the same organization (JD-S5 R3): its PDF is not this one's.
      `t/${a.id}/prescriptions/${pending}.pdf`,
      `t/${a.id}/prescriptions/x.pdf`,
      `t/${a.id}/prescriptions/${issued}.pdf/../${pending}.pdf`,
      `t/${a.id}/prescriptions/${issued}.html`,
    ]) {
      await expect(
        asTreating((tx) =>
          tx.execute(sql`UPDATE prescription SET document_key = ${key} WHERE id = ${issued}`),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
    const stored = await asAuthor((tx) =>
      tx.execute<{ document_key: string | null }>(
        sql`SELECT document_key FROM prescription WHERE id = ${issued}`,
      ),
    );
    expect(stored.rows[0]?.document_key).toBeNull();
  });

  it('has the check of the submission version validated (R2-11)', async () => {
    const result = await owner.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'prescription_submission_version_check'`,
    );
    expect(result.rows).toEqual([{ convalidated: true }]);
  });

  it('is not the system for a transaction marked as the portal (S5-2)', async () => {
    const id = await asAuthor((tx) => insertPending(tx));
    await issue(id);
    const portal = (work: (tx: Tx) => Promise<unknown>) =>
      createWithTenant(runtime.db)({ tenantId: a.id, userId: SYSTEM_USER_ID }, async (tx) => {
        await tx.execute(sql`select set_config('app.actor_kind', 'portal', true)`);
        return work(tx);
      });

    const read = (await portal((tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM prescription`),
    )) as { rows: { n: number }[] };
    const system = await createWithTenant(runtime.db)(
      { tenantId: a.id, userId: SYSTEM_USER_ID },
      (tx) => tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM prescription`),
    );

    expect(read.rows[0]?.n).toBe(0);
    expect(system.rows[0]?.n).toBeGreaterThan(0);
    const written = (await portal((tx) =>
      tx.execute(sql`UPDATE prescription SET status = 'expired' WHERE id = ${id}`),
    )) as { rowCount: number | null };
    expect(written.rowCount).toBe(0);
    expect(await statusOf(id)).toBe('issued');
  });
});
