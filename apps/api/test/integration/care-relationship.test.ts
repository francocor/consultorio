import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { careAssignment, careRelationship } from '../../src/db/schema/care.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { ensureTestPatient } from '../support/patients.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { ensureTestProfessional } from '../support/users.js';

let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'care-a' });
  b = await createTestTenant(runtime, { slug: 'care-b' });
});

afterAll(async () => {
  await owner.query('DROP TABLE IF EXISTS test_care_appointment');
  await owner.end();
  await runtime.close();
});

const ADMIN = '0190a000-0000-7000-8000-0000000000c1';

/** A patient id and a professional that really exists (the care tables key on the profile). */
async function pair(tenant: TestTenant = a) {
  const professionalId = randomUUID();
  const patientId = randomUUID();
  await ensureTestProfessional(runtime, tenant.id, professionalId);
  await ensureTestPatient(runtime, tenant.id, patientId);
  return { patientId, professionalId };
}

const assign = (tenant: TestTenant, ids: { patientId: string; professionalId: string }) =>
  asTenant(runtime, tenant.id, (tx) =>
    tx
      .insert(careAssignment)
      .values({ tenantId: tenant.id, ...ids, assignedBy: ADMIN })
      .returning({ id: careAssignment.id }),
  ).then(([row]) => row?.id ?? '');

const relationship = (tenant: TestTenant, ids: { patientId: string; professionalId: string }) =>
  asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(careRelationship)
      .where(
        and(
          eq(careRelationship.patientId, ids.patientId),
          eq(careRelationship.professionalId, ids.professionalId),
        ),
      ),
  ).then(([row]) => row);

describe('an explicit assignment (authorization, "Explicit patient assignment")', () => {
  it('makes the relationship active: the professional now treats the patient', async () => {
    const ids = await pair();
    expect(await relationship(a, ids)).toBeUndefined();

    await assign(a, ids);

    expect(await relationship(a, ids)).toMatchObject({
      assigned: true,
      active: true,
      qualifyingAppointments: 0,
      encounters: 0,
    });
  });

  it('ending the assignment ends the relationship at once, and keeps the history', async () => {
    const ids = await pair();
    const id = await assign(a, ids);

    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(careAssignment)
        .set({ removedAt: new Date(), removedBy: ADMIN })
        .where(eq(careAssignment.id, id)),
    );

    expect(await relationship(a, ids)).toMatchObject({ assigned: false, active: false });
    const history = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(careAssignment).where(eq(careAssignment.id, id)),
    );
    expect(history[0]?.removedAt).toBeInstanceOf(Date);
  });

  it('can be assigned again after it was removed', async () => {
    const ids = await pair();
    const first = await assign(a, ids);
    await asTenant(runtime, a.id, (tx) =>
      tx.update(careAssignment).set({ removedAt: new Date() }).where(eq(careAssignment.id, first)),
    );

    await assign(a, ids);

    expect(await relationship(a, ids)).toMatchObject({ assigned: true, active: true });
  });

  it('allows one live assignment per pair', async () => {
    const ids = await pair();
    await assign(a, ids);

    await expect(assign(a, ids)).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('keeps assignments of different professionals for one patient apart', async () => {
    const patientId = (await pair()).patientId;
    const first = { patientId, professionalId: (await pair()).professionalId };
    const second = { patientId, professionalId: (await pair()).professionalId };
    await assign(a, first);

    expect((await relationship(a, first))?.active).toBe(true);
    expect(await relationship(a, second)).toBeUndefined();
  });

  it('is invisible to another organization', async () => {
    const ids = await pair();
    await assign(a, ids);

    expect(await relationship(b, ids)).toBeUndefined();
  });
});

describe('only the database functions write the relationship', () => {
  it('refuses a direct insert, update or delete by the runtime role', async () => {
    const ids = await pair();
    await assign(a, ids);
    const another = await pair();

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(careRelationship).values({ tenantId: a.id, ...another, assigned: true }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx
          .update(careRelationship)
          .set({ encounters: 5 })
          .where(eq(careRelationship.patientId, ids.patientId)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.delete(careRelationship).where(eq(careRelationship.patientId, ids.patientId)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    expect((await relationship(a, ids))?.active).toBe(true);
  });

  it('refuses to call the maintenance functions directly', async () => {
    const ids = await pair();

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.execute(
          sql.raw(
            `select app.care_set_assigned('${a.id}', '${ids.patientId}', '${ids.professionalId}', true)`,
          ),
        ),
      ),
    ).rejects.toBeDefined();
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.execute(
          sql.raw(
            `select app.care_adjust('${a.id}', '${ids.patientId}', '${ids.professionalId}', 1, 0)`,
          ),
        ),
      ),
    ).rejects.toBeDefined();
    expect(await relationship(a, ids)).toBeUndefined();
  });

  it('refuses to delete an assignment: it is ended, not erased', async () => {
    const id = await assign(a, await pair());

    await expect(
      asTenant(runtime, a.id, (tx) => tx.delete(careAssignment).where(eq(careAssignment.id, id))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('the counters Stage 2 triggers will maintain (appointments and encounters)', () => {
  /** A stand-in for the appointment table: its trigger drives care_adjust like Stage 2 will. */
  async function createStandIn() {
    await owner.query(`
      CREATE TABLE IF NOT EXISTS test_care_appointment (
        id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
        tenant_id uuid NOT NULL REFERENCES tenant (id),
        patient_id uuid NOT NULL,
        professional_id uuid NOT NULL
      );
      ALTER TABLE test_care_appointment ENABLE ROW LEVEL SECURITY;
      ALTER TABLE test_care_appointment FORCE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS tenant_isolation ON test_care_appointment;
      CREATE POLICY tenant_isolation ON test_care_appointment
        USING (tenant_id = current_setting('app.tenant_id')::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
      GRANT SELECT, INSERT, DELETE ON test_care_appointment TO app_rw;
      CREATE OR REPLACE FUNCTION test_care_appointment_sync() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $f$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          PERFORM app.care_adjust(NEW.tenant_id, NEW.patient_id, NEW.professional_id, 1, 0);
        ELSE
          PERFORM app.care_adjust(OLD.tenant_id, OLD.patient_id, OLD.professional_id, -1, 0);
        END IF;
        RETURN NULL;
      END $f$;
      DROP TRIGGER IF EXISTS sync ON test_care_appointment;
      CREATE TRIGGER sync AFTER INSERT OR DELETE ON test_care_appointment
        FOR EACH ROW EXECUTE FUNCTION test_care_appointment_sync();
    `);
  }

  it('counts qualifying appointments, and the relationship is active while any exists', async () => {
    await createStandIn();
    const ids = await pair();
    const book = () =>
      asTenant(runtime, a.id, (tx) =>
        tx.execute(
          sql.raw(
            `insert into test_care_appointment (tenant_id, patient_id, professional_id) values ('${a.id}', '${ids.patientId}', '${ids.professionalId}') returning id`,
          ),
        ),
      );

    await book();
    await book();
    expect(await relationship(a, ids)).toMatchObject({ qualifyingAppointments: 2, active: true });

    await asTenant(runtime, a.id, (tx) =>
      tx.execute(
        sql.raw(`delete from test_care_appointment where patient_id = '${ids.patientId}'`),
      ),
    );
    expect(await relationship(a, ids)).toMatchObject({ qualifyingAppointments: 0, active: false });
  });

  it('stays active through an assignment even when the appointments are gone, and never goes below zero', async () => {
    await createStandIn();
    const ids = await pair();
    await assign(a, ids);
    await asTenant(runtime, a.id, (tx) =>
      tx.execute(
        sql.raw(
          `insert into test_care_appointment (tenant_id, patient_id, professional_id) values ('${a.id}', '${ids.patientId}', '${ids.professionalId}')`,
        ),
      ),
    );
    await asTenant(runtime, a.id, (tx) =>
      tx.execute(
        sql.raw(`delete from test_care_appointment where patient_id = '${ids.patientId}'`),
      ),
    );

    expect(await relationship(a, ids)).toMatchObject({
      qualifyingAppointments: 0,
      assigned: true,
      active: true,
    });
  });

  it('refuses to adjust the relationship of another tenant', async () => {
    const ids = await pair();

    await expect(
      owner.query('BEGIN').then(async () => {
        try {
          await owner.query(`select set_config('app.tenant_id', '${a.id}', true)`);
          await owner.query(
            `select app.care_adjust('${b.id}', '${ids.patientId}', '${ids.professionalId}', 1, 0)`,
          );
        } finally {
          await owner.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
