import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { channelPreference } from '../../src/db/schema/channel-preference.js';
import {
  bindOptOutListener,
  optOutChannel,
} from '../../src/modules/notifications/application/opt-out.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * Judgment day round 2, finding A7. Other modules are told of an opt-out inside the transaction of
 * the opt-out. The patient's choice must not depend on them: a listener that fails (a statement the
 * database refuses poisons a plain transaction) is run in a savepoint, reported, and the opt-out
 * stands.
 */

const actor = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'optout-listener' });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  bindOptOutListener(undefined);
  await scheduling.close();
  await runtime.close();
});

afterEach(() => {
  bindOptOutListener(undefined);
});

describe('a listener of the opt-out that fails', () => {
  it('does not undo the opt-out of the patient, and is reported', async () => {
    const patientId = await notes.patient({ email: 'listener@example.test' });
    const failures: unknown[] = [];
    bindOptOutListener(
      async (tx) => {
        // The database refuses this statement: the transaction would be unusable without a savepoint.
        await tx.execute(sql`SELECT 1 / 0`);
      },
      { onFailure: (error) => failures.push(error) },
    );

    const result = await scheduling.inTenant((tx) =>
      optOutChannel(tx, { patientId, channel: 'email', source: 'email_link', actor }),
    );

    expect(result.recorded).toBe(true);
    const choices = await scheduling.inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    expect(choices.map((choice) => choice.state)).toEqual(['opted_out']);
    expect(failures).toHaveLength(1);
  });

  it('still runs when it works', async () => {
    const patientId = await notes.patient({ email: 'listener2@example.test' });
    const told: string[] = [];
    bindOptOutListener((_tx, event) => {
      told.push(event.patientId);
      return Promise.resolve();
    });

    await scheduling.inTenant((tx) =>
      optOutChannel(tx, { patientId, channel: 'email', source: 'email_link', actor }),
    );

    expect(told).toEqual([patientId]);
  });
});
