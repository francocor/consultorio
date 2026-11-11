import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { exportNotifications } from '../../src/modules/notifications/application/export-contributor.js';
import { exportTeleconsultation } from '../../src/modules/teleconsultation/application/export-contributor.js';
import { exportWaitlist } from '../../src/modules/waitlist/application/export-contributor.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { settled } from '../support/export-sections.js';
import { createRecordingJobClient } from '../support/jobs.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * Judgment day finding B11: the Stage 3 modules registered export contributors that returned
 * nothing. The cancellation export now carries their administrative parts, and no secret.
 */

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let strangerId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const jobs = createRecordingJobClient();
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'stage3-export', app: { jobs } });
  notes = createNotificationsWorld(scheduling, { jobs });
  strangerId = (await createTestTenant(runtime, { slug: 'stage3-export-other' })).id;
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

const part = <T>(
  contribute: (context: { tx: never; tenantId: string }) => Promise<unknown>,
  tenantId = scheduling.tenant.id,
) =>
  asTenant(runtime, tenantId, (tx) =>
    settled(contribute({ tx: tx as never, tenantId })),
  ) as Promise<T>;

describe('the administrative export of Stage 3', () => {
  it('carries the choices and the log of messages of the organization, as metadata, and nothing of another', async () => {
    const patientId = await notes.patient({ email: 'export@example.test', phone: '1144445555' });
    const booked = await notes.book(patientId, 3, '10:00');
    await scheduling.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO channel_preference (tenant_id, patient_id, channel, state, source)
              VALUES (${scheduling.tenant.id}, ${patientId}, 'email', 'opted_out', 'email_link')`,
      ),
    );
    await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: booked.id,
      plannedStartsAt: new Date(booked.startsAt),
      appointmentVersion: booked.version,
      dedupeKey: `export:${booked.id}:email`,
    });

    const exported = await part<{
      channelPreferences: { patientId: string; state: string }[];
      messages: { patientId: string; kind: string }[];
    }>(exportNotifications);
    const others = await part<{ channelPreferences: unknown[]; messages: unknown[] }>(
      exportNotifications,
      strangerId,
    );

    expect(exported.channelPreferences).toEqual(
      expect.arrayContaining([expect.objectContaining({ patientId, state: 'opted_out' })]),
    );
    expect(exported.messages.some((row) => row.patientId === patientId)).toBe(true);
    expect(others.channelPreferences).toEqual([]);
    expect(others.messages).toEqual([]);
    const text = JSON.stringify(exported);
    expect(text).not.toContain('export@example.test');
    expect(text).not.toMatch(/address_hash|addressHash|dedupeKey|url/);
  });

  it('carries the entries and the offers of the waitlist', async () => {
    const patientId = await notes.patient({ email: 'espera@example.test' });
    const made = await scheduling.api.post('/waitlist', scheduling.owner, {
      patientId,
      appointmentTypeId: scheduling.consulta,
      offersOptIn: true,
    });
    expect(made.statusCode, made.body).toBe(201);

    const exported = await part<{
      entries: { patientId: string; status: string }[];
      offers: unknown[];
    }>(exportWaitlist);

    expect(exported.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ patientId, status: 'active' })]),
    );
    expect(Array.isArray(exported.offers)).toBe(true);
    expect((await part<{ entries: unknown[] }>(exportWaitlist, strangerId)).entries).toEqual([]);
  });

  it('carries the video sessions without any link', async () => {
    const patientId = await notes.patient({ email: 'video@example.test' });
    const type = await scheduling.api.post('/appointment-types', scheduling.owner, {
      name: 'Consulta virtual export',
      durationMinutes: 30,
      mode: 'virtual',
    });
    const booked = await scheduling.book(4, '11:00', {
      patientId,
      appointmentTypeId: type.json<{ id: string }>().id,
    });
    await scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE video_session SET manual_link = 'https://zoom.us/j/123?pwd=SECRETPASSCODE'
              WHERE appointment_id = ${booked.id}`,
      ),
    );

    const exported = await part<{
      videoSessions: { appointmentId: string; manualLink: boolean }[];
    }>(exportTeleconsultation);

    const row = exported.videoSessions.find((entry) => entry.appointmentId === booked.id);
    expect(row).toMatchObject({ manualLink: true });
    expect(JSON.stringify(exported)).not.toMatch(/SECRETPASSCODE|zoom\.us/);
    expect(
      (await part<{ videoSessions: unknown[] }>(exportTeleconsultation, strangerId)).videoSessions,
    ).toEqual([]);
  });
});
