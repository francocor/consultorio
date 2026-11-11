import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { appointment } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  at,
  createSchedulingWorld,
  insertAppointment,
  type SchedulingWorld,
} from '../support/scheduling.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

/**
 * Moving an appointment from one professional to another recomputes two care relationships (the old
 * pair and the new one), each behind an advisory lock. Two opposite moves (A to B and B to A) that
 * took those locks in the order "old, then new" could each hold one and wait for the other: a
 * deadlock. The locks are taken in the order of their keys instead, whatever the move.
 */

let runtime: DbHandle;
let admin: pg.Client;
let tenant: TestTenant;
let world: SchedulingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  tenant = await createTestTenant(runtime, { slug: 'sched-care-locks' });
  world = await createSchedulingWorld(runtime, tenant.id);
});

afterAll(async () => {
  await admin.end();
  await runtime.close();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The advisory lock key of the care relationship of one pair, as the function computes it. */
async function careKey(patientId: string, professionalId: string): Promise<bigint> {
  const result = await admin.query<{ key: string }>(
    `SELECT hashtextextended('care:' || $1::text || $2::text || $3::text, 0)::text AS key`,
    [tenant.id, patientId, professionalId],
  );
  return BigInt(result.rows[0]?.key ?? '0');
}

/** Whether some session holds (granted) or waits for (not granted) this advisory key. */
async function advisoryState(key: bigint): Promise<{ granted: number; waiting: number }> {
  const result = await admin.query<{ granted: boolean; n: number }>(
    `SELECT granted, count(*)::int AS n
       FROM pg_locks
      WHERE locktype = 'advisory'
        AND ((classid::bigint << 32) | objid::bigint) = $1::bigint
      GROUP BY granted`,
    [key.toString()],
  );
  const count = (granted: boolean) => result.rows.find((row) => row.granted === granted)?.n ?? 0;
  return { granted: count(true), waiting: count(false) };
}

async function until(condition: () => Promise<boolean>, what: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('the care relationship of the appointments', () => {
  it('takes the locks of the two pairs of a reassignment in key order, not in the order old then new', async () => {
    const other = (await createTestProfessional(runtime, tenant.id)).professionalId;
    const patientId = world.patientId;
    const keyOfWorld = await careKey(patientId, world.professionalId);
    const keyOfOther = await careKey(patientId, other);
    // Move from the professional whose key is the higher one: "old, then new" would take it first.
    const [from, to, high, low] =
      keyOfWorld > keyOfOther
        ? [world.professionalId, other, keyOfWorld, keyOfOther]
        : [other, world.professionalId, keyOfOther, keyOfWorld];
    const created = await asTenant(runtime, tenant.id, (tx) =>
      insertAppointment(tx, world, { professionalId: from, start: at(0, '2031-06-02') }),
    );

    // Somebody else holds the high key, so the reassignment has to wait for it.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: () => void = () => undefined;
    const isHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = asTenant(runtime, tenant.id, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${high.toString()}::bigint)`);
      held();
      await released;
    });
    await isHeld;
    const reassignment = asTenant(runtime, tenant.id, (tx) =>
      tx.execute(sql`UPDATE appointment SET professional_id = ${to} WHERE id = ${created.id}`),
    );

    // While it waits for the high key it already holds the low one: key order.
    await until(async () => (await advisoryState(high)).waiting > 0, 'the reassignment to wait');
    const lowState = await advisoryState(low);
    release();
    await Promise.all([holder, reassignment]);

    expect(lowState.granted).toBeGreaterThan(0);
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ professionalId: appointment.professionalId })
        .from(appointment)
        .where(eq(appointment.id, created.id)),
    );
    expect(row?.professionalId).toBe(to);
  });

  it('still counts the old and the new pair after a reassignment', async () => {
    const other = (await createTestProfessional(runtime, tenant.id)).professionalId;
    const patientId = await asTenant(runtime, tenant.id, async (tx) => {
      const result = await tx.execute<{ id: string }>(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date)
              VALUES (${tenant.id}, 'Pair', 'Counter', '1990-01-01') RETURNING id`,
      );
      return result.rows[0]?.id ?? '';
    });
    const created = await asTenant(runtime, tenant.id, (tx) =>
      insertAppointment(tx, world, { patientId, start: at(0, '2031-06-09') }),
    );

    await asTenant(runtime, tenant.id, (tx) =>
      tx.execute(sql`UPDATE appointment SET professional_id = ${other} WHERE id = ${created.id}`),
    );

    const counters = await asTenant(runtime, tenant.id, (tx) =>
      tx.execute<{ professional_id: string; qualifying_appointments: number; active: boolean }>(
        sql`SELECT professional_id, qualifying_appointments, active
              FROM care_relationship WHERE patient_id = ${patientId}`,
      ),
    );
    const byProfessional = new Map(counters.rows.map((row) => [row.professional_id, row]));
    expect(byProfessional.get(world.professionalId)).toMatchObject({
      qualifying_appointments: 0,
      active: false,
    });
    expect(byProfessional.get(other)).toMatchObject({ qualifying_appointments: 1, active: true });
  });
});
