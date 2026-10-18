import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { prepareDelivery } from '../../src/modules/notifications/application/delivery.js';
import {
  reserveWhatsappUsage,
  UNLIMITED_QUOTA,
} from '../../src/modules/notifications/application/usage.js';
import { createSchedulingPorts } from '../../src/modules/scheduling/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * Judgment day round 2, finding B5. The preparation of a WhatsApp message holds the row of the
 * message and then inserts a row that points at the professional (its place in the quota); a change
 * of the agenda holds the row of the professional and then cancels the messages of its
 * appointments. With `FOR UPDATE` on the professional the two wait for each other: a deadlock. The
 * lock on the professional is `FOR NO KEY UPDATE`, which still serializes the bookings of one
 * professional but lets a row that only REFERENCES them through.
 */

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'lock-ordering' });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('the lock on a professional and the messages of their appointments (JD-S3 R2-B5)', () => {
  it('does not deadlock a message being prepared against a change of the agenda', async () => {
    const patientId = await notes.patient({ phone: '+5491155550777' });
    const booked = await notes.book(patientId, 40, '09:00');
    const messageId = await notes.queue({
      kind: 'reminder',
      channel: 'whatsapp',
      patientId,
      appointmentId: booked.id,
      professionalId: scheduling.doctor.professionalId,
      plannedStartsAt: new Date(booked.startsAt),
      appointmentVersion: booked.version,
      dedupeKey: `lock-order:${booked.id}:whatsapp`,
    });
    const withTenant = createWithTenant(runtime.db);
    const tenant = { tenantId: scheduling.tenant.id, userId: SYSTEM_USER_ID };
    const messageLocked = gate();
    const professionalLocked = gate();

    // The preparation: the message first, then its place in the quota (which points at the professional).
    const preparing = withTenant(tenant, async (tx) => {
      await tx.execute(sql`SELECT id FROM message WHERE id = ${messageId} FOR UPDATE`);
      messageLocked.open();
      await professionalLocked.opened;
      await reserveWhatsappUsage(UNLIMITED_QUOTA, tx, {
        messageId,
        professionalId: scheduling.doctor.professionalId,
        now: notes.now(),
      });
    });
    // The change: the professional first, then the messages of the appointment.
    const changing = withTenant(tenant, async (tx) => {
      await messageLocked.opened;
      await createSchedulingPorts(tx, { keys: scheduling.keys }).lockProfessional(
        scheduling.doctor.professionalId,
      );
      professionalLocked.open();
      await tx.execute(
        sql`UPDATE message SET status = 'cancelled', cancel_reason = 'appointment_changed'
              WHERE appointment_id = ${booked.id} AND status = 'queued'`,
      );
    });

    const results = await Promise.allSettled([preparing, changing]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  }, 30_000);
});

describe('a preparation chosen as the victim of a deadlock (JD-S3 R2-B5)', () => {
  it('runs again, and gives up after a few attempts', async () => {
    const patientId = await notes.patient({ email: 'victima@example.test' });
    const booked = await notes.book(patientId, 41, '09:00');
    const id = await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: booked.id,
      plannedStartsAt: new Date(booked.startsAt),
      appointmentVersion: booked.version,
      dedupeKey: `deadlock-retry:${booked.id}:email`,
    });
    let failures = 2;
    const victim: typeof notes.deps.withTenant = (context, work) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(
          Object.assign(new Error('deadlock detected'), { cause: { code: '40P01' } }),
        );
      }
      return notes.deps.withTenant(context, work);
    };

    const prepared = await prepareDelivery(
      { ...notes.deps, withTenant: victim },
      scheduling.tenant.id,
      id,
    );

    expect(prepared.kind).toBe('send');
    failures = 3;
    await expect(
      prepareDelivery({ ...notes.deps, withTenant: victim }, scheduling.tenant.id, id),
    ).rejects.toThrow('deadlock detected');
  });
});
