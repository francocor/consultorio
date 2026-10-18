import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { channelPreference } from '../../src/db/schema/channel-preference.js';
import {
  loadPreferences,
  OptInRefused,
  recordOptIn,
  recordOptOut,
} from '../../src/modules/notifications/application/preferences.js';
import { loadRecipient } from '../../src/modules/notifications/application/recipients.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let slot = 0;

const patientActor: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};
const staffActor = (): AuditActor => ({
  userId: scheduling.reception.user.id,
  actingRole: 'reception',
  ip: null,
  userAgent: null,
  requestId: null,
});

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'notif-preferences' });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(() => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
});

const inTenant = <T>(fn: Parameters<typeof scheduling.inTenant<T>>[0]) => scheduling.inTenant(fn);

async function reminderFor(patientId: string, channel: 'email' | 'whatsapp') {
  slot += 1;
  const time = `${String(9 + Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
  const appointment = await notes.book(patientId, 1 + Math.floor(slot / 8), time);
  const id = await notes.queue({
    kind: 'reminder',
    channel,
    patientId,
    appointmentId: appointment.id,
    plannedStartsAt: new Date(appointment.startsAt),
    appointmentVersion: appointment.version,
    dedupeKey: `pref:${appointment.id}:${channel}`,
  });
  return { id, appointment };
}

describe('the choices of a patient', () => {
  it('start as "email works, WhatsApp is off"', async () => {
    const patientId = await notes.patient();

    expect(await inTenant((tx) => loadPreferences(tx, patientId))).toEqual({
      email: 'default',
      whatsapp: 'none',
    });
  });

  it('record a WhatsApp opt-in with its time and source, and the staff member who recorded it', async () => {
    const patientId = await notes.patient({ phone: '1144445555' });

    await inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'staff',
        recordedBy: scheduling.reception.user.id,
        actor: staffActor(),
      }),
    );

    const [row] = await inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    expect(row).toMatchObject({
      channel: 'whatsapp',
      state: 'opted_in',
      source: 'staff',
      recordedBy: scheduling.reception.user.id,
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(await inTenant((tx) => loadPreferences(tx, patientId))).toEqual({
      email: 'default',
      whatsapp: 'opted_in',
    });
  });

  it('record the opt-in a patient gives on the booking form or by their own email link without a staff member', async () => {
    const online = await notes.patient();
    const byLink = await notes.patient();

    for (const [patientId, source] of [
      [online, 'online_booking'],
      [byLink, 'patient_email_link'],
    ] as const) {
      await inTenant((tx) =>
        recordOptIn(tx, { patientId, channel: 'whatsapp', source, actor: patientActor }),
      );
    }

    const rows = await inTenant((tx) =>
      tx
        .select({ source: channelPreference.source, recordedBy: channelPreference.recordedBy })
        .from(channelPreference)
        .where(and(eq(channelPreference.channel, 'whatsapp'))),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { source: 'online_booking', recordedBy: null },
        { source: 'patient_email_link', recordedBy: null },
      ]),
    );
  });

  it('feed the channel policy: the recipient shows the opt-in and the opt-out', async () => {
    const patientId = await notes.patient({ phone: '1144445555' });
    await inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'online_booking',
        actor: patientActor,
      }),
    );
    expect((await inTenant((tx) => loadRecipient(tx, patientId)))?.facts).toMatchObject({
      whatsappPreference: 'opted_in',
      emailPreference: 'default',
    });

    await inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor: patientActor }),
    );
    expect((await inTenant((tx) => loadRecipient(tx, patientId)))?.facts).toMatchObject({
      whatsappPreference: 'opted_in',
      emailPreference: 'opted_out',
    });
  });
});

describe('an opt-out', () => {
  it('takes effect at once: the queued messages of that channel are cancelled, the others stay', async () => {
    const patientId = await notes.patient({ phone: '1144445555' });
    const email = await reminderFor(patientId, 'email');
    const sms = await reminderFor(patientId, 'whatsapp');

    const result = await inTenant((tx) =>
      recordOptOut(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'whatsapp_keyword',
        actor: patientActor,
      }),
    );

    expect(result).toEqual({ recorded: true, cancelled: 1 });
    expect(await notes.message(sms.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
    expect((await notes.message(email.id)).status).toBe('queued');
  });

  it('only cancels what is still queued: a message already sent keeps its status', async () => {
    const patientId = await notes.patient({ email: 'enviado@example.test' });
    const { id } = await reminderFor(patientId, 'email');
    await notes.runAllJobs();
    expect((await notes.message(id)).status).toBe('sent');

    const result = await inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor: patientActor }),
    );

    expect(result.cancelled).toBe(0);
    expect((await notes.message(id)).status).toBe('sent');
  });

  it('does not touch the messages of another patient', async () => {
    const leaving = await notes.patient();
    const staying = await notes.patient();
    await reminderFor(leaving, 'email');
    const other = await reminderFor(staying, 'email');

    await inTenant((tx) =>
      recordOptOut(tx, {
        patientId: leaving,
        channel: 'email',
        source: 'email_link',
        actor: patientActor,
      }),
    );

    expect((await notes.message(other.id)).status).toBe('queued');
  });

  it('is recorded once: asking again changes nothing and keeps the first time and source', async () => {
    const patientId = await notes.patient();
    const first = await inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor: patientActor }),
    );
    const again = await inTenant((tx) =>
      recordOptOut(tx, {
        patientId,
        channel: 'email',
        source: 'staff',
        recordedBy: scheduling.reception.user.id,
        actor: staffActor(),
      }),
    );

    expect(first.recorded).toBe(true);
    expect(again).toEqual({ recorded: false, cancelled: 0 });
    const rows = await inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'email_link', recordedBy: null });
  });

  it('can be recorded by reception, with the staff member named', async () => {
    const patientId = await notes.patient();

    await inTenant((tx) =>
      recordOptOut(tx, {
        patientId,
        channel: 'email',
        source: 'staff',
        recordedBy: scheduling.reception.user.id,
        actor: staffActor(),
      }),
    );

    const [row] = await inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    expect(row).toMatchObject({
      state: 'opted_out',
      source: 'staff',
      recordedBy: scheduling.reception.user.id,
    });
  });

  it('is audited with the channel and the source, never the address', async () => {
    const patientId = await notes.patient({ email: 'auditado@example.test' });

    await inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor: patientActor }),
    );

    const events = await inTenant((tx) =>
      tx
        .select({
          action: auditEvent.action,
          resourceId: auditEvent.resourceId,
          metadata: auditEvent.metadata,
          patientId: auditEvent.patientId,
        })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, 'notification.optout.recorded'),
            eq(auditEvent.patientId, patientId),
          ),
        ),
    );
    expect(events).toEqual([
      {
        action: 'notification.optout.recorded',
        resourceId: patientId,
        metadata: { channel: 'email', source: 'email_link' },
        patientId,
      },
    ]);
  });
});

describe('an opt-in', () => {
  it('cannot be recorded by staff for a patient who opted out of the channel', async () => {
    const patientId = await notes.patient({ phone: '1144445555' });
    await inTenant((tx) =>
      recordOptOut(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'whatsapp_keyword',
        actor: patientActor,
      }),
    );

    await expect(
      inTenant((tx) =>
        recordOptIn(tx, {
          patientId,
          channel: 'whatsapp',
          source: 'staff',
          recordedBy: scheduling.reception.user.id,
          actor: staffActor(),
        }),
      ),
    ).rejects.toBeInstanceOf(OptInRefused);
    expect((await inTenant((tx) => loadPreferences(tx, patientId))).whatsapp).toBe('opted_out');
  });

  it('can be given again by the patient, by their own email link', async () => {
    const patientId = await notes.patient({ phone: '1144445555' });
    await inTenant((tx) =>
      recordOptOut(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'whatsapp_keyword',
        actor: patientActor,
      }),
    );

    await inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'patient_email_link',
        actor: patientActor,
      }),
    );

    expect((await inTenant((tx) => loadPreferences(tx, patientId))).whatsapp).toBe('opted_in');
  });

  it('is audited with the channel and the source', async () => {
    const patientId = await notes.patient({ phone: '1144445555' });

    await inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'staff',
        recordedBy: scheduling.reception.user.id,
        actor: staffActor(),
      }),
    );

    const events = await inTenant((tx) =>
      tx
        .select({ metadata: auditEvent.metadata, actor: auditEvent.actorUserId })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, 'notification.optin.recorded'),
            eq(auditEvent.patientId, patientId),
          ),
        ),
    );
    expect(events).toEqual([
      {
        metadata: { channel: 'whatsapp', source: 'staff' },
        actor: scheduling.reception.user.id,
      },
    ]);
  });

  it('is not repeated when the patient is already opted in', async () => {
    const patientId = await notes.patient({ phone: '1144445555' });
    const first = await inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'online_booking',
        actor: patientActor,
      }),
    );
    const again = await inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'patient_email_link',
        actor: patientActor,
      }),
    );

    expect([first.recorded, again.recorded]).toEqual([true, false]);
  });
});
