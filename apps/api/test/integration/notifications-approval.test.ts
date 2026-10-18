import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { message } from '../../src/db/schema/notifications.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createRecordingJobClient } from '../support/jobs.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * Judgment day suggestion: an online booking that waits for approval was told "we will confirm it
 * and tell you". When reception approves it, the patient is told, whatever the lead times of the
 * reminders say (a booking approved close to its start may have no reminder left to carry the news).
 */

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let week = 400;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const jobs = createRecordingJobClient();
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'notif-approval', app: { jobs } });
  notes = createNotificationsWorld(scheduling, { jobs });
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

/** An online booking that waits for approval, for a patient with an email. */
async function waitingForApproval() {
  week += 1;
  const patientId = await notes.patient({ email: `aprobar${String(week)}@example.test` });
  const booked = await notes.book(patientId, week, '10:00');
  await scheduling.inTenant((tx) =>
    tx.execute(
      sql`UPDATE appointment SET source = 'online', status = 'pending_approval' WHERE id = ${booked.id}`,
    ),
  );
  return { patientId, id: booked.id };
}

const confirmationsOf = (appointmentId: string) =>
  scheduling.inTenant((tx) =>
    tx
      .select({ kind: message.kind, channel: message.channel, status: message.status })
      .from(message)
      .where(eq(message.appointmentId, appointmentId)),
  );

describe('approving an online booking', () => {
  it('tells the patient, by the channel they allow, even when no reminder is left to say it', async () => {
    const { id } = await waitingForApproval();
    const [current] = await scheduling
      .inTenant((tx) =>
        tx.execute<{ version: number }>(sql`SELECT version FROM appointment WHERE id = ${id}`),
      )
      .then((result) => result.rows);

    const response = await scheduling.api.post(`/appointments/${id}/approve`, scheduling.owner, {
      expectedVersion: current?.version,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect((await confirmationsOf(id)).filter((row) => row.kind === 'confirmation')).toEqual([
      { kind: 'confirmation', channel: 'email', status: 'queued' },
    ]);
  });
});
