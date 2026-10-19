import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { channelPreference } from '../../src/db/schema/channel-preference.js';
import {
  bindOptOutListener,
  optOutPatient,
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
      optOutPatient(tx, { patientId, source: 'email_link', actor }),
    );

    expect(result.recorded).toBe(true);
    const choices = await scheduling.inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    // Every channel is recorded (owner decision B7), and the listener is told once afterwards.
    expect(choices.map((choice) => choice.state)).toEqual(['opted_out', 'opted_out']);
    expect(failures).toHaveLength(1);
  });

  it('is reported by default on stderr with the class of the error and its database code, never the message (S4.15, 4.62)', async () => {
    const patientId = await notes.patient({ email: 'listener3@example.test' });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      bindOptOutListener(() =>
        Promise.reject(
          Object.assign(new Error('patient 600123456 exploded (ana@example.test)'), {
            code: '23505',
          }),
        ),
      );

      await scheduling.inTenant((tx) =>
        optOutPatient(tx, { patientId, source: 'email_link', actor }),
      );

      const lines = write.mock.calls.map(([chunk]) => String(chunk));
      const line = lines.find((entry) => entry.includes('opt_out_listener_failed'));
      expect(line).toBeDefined();
      expect(JSON.parse(line ?? '')).toEqual({
        level: 'error',
        msg: 'opt_out_listener_failed',
        name: 'Error',
        code: '23505',
      });
      expect(line).not.toContain('600123456');
      expect(line).not.toContain('ana@example.test');
    } finally {
      write.mockRestore();
    }
  });

  it('still runs when it works', async () => {
    const patientId = await notes.patient({ email: 'listener2@example.test' });
    const told: string[] = [];
    bindOptOutListener((_tx, event) => {
      told.push(event.patientId);
      return Promise.resolve();
    });

    await scheduling.inTenant((tx) =>
      optOutPatient(tx, { patientId, source: 'email_link', actor }),
    );

    expect(told).toEqual([patientId]);
  });
});
