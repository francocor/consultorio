import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  at,
  createSchedulingWorld,
  insertAppointment,
  occupancyOf,
  type SchedulingWorld,
} from '../support/scheduling.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

/**
 * The database, not the application, is what makes a double booking impossible (design 4.6). These
 * tests book straight into the tables from several connections at once: no service, no lock on the
 * professional, nothing between the statements and the exclusion constraint.
 */

let runtime: DbHandle;
let tenant: TestTenant;
let world: SchedulingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'sched-concurrency' });
  world = await createSchedulingWorld(runtime, tenant.id);
});

afterAll(async () => {
  await runtime.close();
});

const sqlState = (reason: unknown) =>
  (reason as { cause?: { code?: string } } | undefined)?.cause?.code;

async function race(count: number, attempt: (index: number) => Promise<unknown>) {
  const results = await Promise.allSettled(Array.from({ length: count }, (_, i) => attempt(i)));
  const won = results.filter((result) => result.status === 'fulfilled').length;
  const codes = results.flatMap((result) =>
    result.status === 'rejected' ? [sqlState(result.reason)] : [],
  );
  return { won, codes };
}

describe('two or more connections book the same slot', () => {
  it.each([2, 8, 10])('lets exactly one of %i win and gives the rest 23P01', async (count) => {
    const doctor = (await createTestProfessional(runtime, tenant.id)).professionalId;

    const { won, codes } = await race(count, () =>
      asTenant(runtime, tenant.id, (tx) =>
        insertAppointment(tx, world, { professionalId: doctor, start: at(0) }),
      ),
    );

    expect(won).toBe(1);
    expect(codes).toHaveLength(count - 1);
    expect(new Set(codes)).toEqual(new Set(['23P01']));
    const rows = await asTenant(runtime, tenant.id, (tx) => occupancyOf(tx, doctor));
    expect(rows.filter((row) => row.active)).toHaveLength(1);
  });

  it('lets exactly one win when the ranges only partly overlap', async () => {
    const doctor = (await createTestProfessional(runtime, tenant.id)).professionalId;

    const { won, codes } = await race(6, (index) =>
      asTenant(runtime, tenant.id, (tx) =>
        // 10:00, 10:05, 10:10 ... each 30 minutes long: every pair overlaps.
        insertAppointment(tx, world, { professionalId: doctor, start: at(index * 5) }),
      ),
    );

    expect(won).toBe(1);
    expect(new Set(codes)).toEqual(new Set(['23P01']));
  });

  it('lets every one win when they are back to back (no overlap)', async () => {
    const doctor = (await createTestProfessional(runtime, tenant.id)).professionalId;

    const { won, codes } = await race(8, (index) =>
      asTenant(runtime, tenant.id, (tx) =>
        insertAppointment(tx, world, { professionalId: doctor, start: at(index * 30) }),
      ),
    );

    expect(won).toBe(8);
    expect(codes).toEqual([]);
  });

  it('counts the buffer inside the range when the attempts race', async () => {
    const doctor = (await createTestProfessional(runtime, tenant.id)).professionalId;

    // Every start is 30 minutes after the previous one, but a 10 minute buffer makes the
    // appointments 40 minutes long as far as the professional is concerned: they collide pairwise
    // only with their neighbours, so half of them lose.
    const { won } = await race(2, (index) =>
      asTenant(runtime, tenant.id, (tx) =>
        insertAppointment(tx, world, {
          professionalId: doctor,
          start: at(index * 30),
          bufferMinutes: 10,
        }),
      ),
    );

    expect(won).toBe(1);
  });

  it('does not stop two different professionals from booking the same time', async () => {
    const first = (await createTestProfessional(runtime, tenant.id)).professionalId;
    const second = (await createTestProfessional(runtime, tenant.id)).professionalId;

    const { won } = await race(2, (index) =>
      asTenant(runtime, tenant.id, (tx) =>
        insertAppointment(tx, world, {
          professionalId: index === 0 ? first : second,
          start: at(0),
        }),
      ),
    );

    expect(won).toBe(2);
  });
});
