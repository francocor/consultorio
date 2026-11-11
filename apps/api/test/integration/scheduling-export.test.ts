import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { exportScheduling } from '../../src/modules/scheduling/application/export-contributor.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { settled } from '../support/export-sections.js';
import {
  at,
  createSchedulingWorld,
  insertAppointment,
  type SchedulingWorld,
} from '../support/scheduling.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: SchedulingWorld;
let b: SchedulingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const tenantA = await createTestTenant(runtime, { slug: 'export-sched-a' });
  const tenantB = await createTestTenant(runtime, { slug: 'export-sched-b' });
  a = await createSchedulingWorld(runtime, tenantA.id);
  b = await createSchedulingWorld(runtime, tenantB.id);
});

afterAll(async () => {
  await runtime.close();
});

describe('administrative export of the scheduling', () => {
  it('lists the appointments, their history and the types of the exporting organization, and nobody else', async () => {
    await asTenant(runtime, a.tenantId, async (tx) => {
      await insertAppointment(tx, a, { start: at(0) });
      await insertAppointment(tx, a, { start: at(60), status: 'cancelled' });
    });
    await asTenant(runtime, b.tenantId, async (tx) => {
      await insertAppointment(tx, b, { start: at(0) });
    });

    const part = (await asTenant(runtime, a.tenantId, (tx) =>
      settled(exportScheduling({ tx, tenantId: a.tenantId })),
    )) as {
      appointmentTypes: { name: string }[];
      appointments: { patientId: string; status: string; startsAt: Date }[];
    };

    expect(part.appointmentTypes.map((type) => type.name)).toEqual(['Consulta']);
    expect(part.appointments.map((entry) => entry.status)).toEqual(['scheduled', 'cancelled']);
    expect(part.appointments.every((entry) => entry.patientId === a.patientId)).toBe(true);
  });

  it('carries no clinical or encrypted content', async () => {
    const part = await asTenant(runtime, a.tenantId, (tx) =>
      settled(exportScheduling({ tx, tenantId: a.tenantId })),
    );

    expect(JSON.stringify(part)).not.toMatch(/_enc|detailEnc|reason_for|diagnos/i);
  });
});
