import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { channelPreference } from '../../src/db/schema/channel-preference.js';
import { message } from '../../src/db/schema/notifications.js';
import {
  bindOptOutListener,
  optOutPatient,
} from '../../src/modules/notifications/application/opt-out.js';
import {
  loadPreferences,
  recordOptIn,
  recordOptOut as recordOptOutOnly,
} from '../../src/modules/notifications/application/preferences.js';
import { bindOfferDelivery } from '../../src/modules/notifications/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * Owner decision B7: when a patient opts out on any channel (a keyword on WhatsApp, the link of an
 * email, or reception at the patient's request) every messaging channel is opted out. What was
 * queued on either channel is cancelled and nothing takes its place: the reminder of an opted-out
 * patient is not "moved" to the other channel any more (it was, under decision D10).
 */

const actor = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let whatsapp: ReturnType<typeof createFakeWhatsAppSender>;
let week = 800;
let mobiles = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'notif-global-optout' });
  whatsapp = createFakeWhatsAppSender();
  notes = createNotificationsWorld(scheduling, { whatsapp });
});

afterAll(async () => {
  bindOptOutListener(undefined);
  await scheduling.close();
  await runtime.close();
});

afterEach(() => {
  bindOptOutListener(undefined);
});

beforeEach(() => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  notes.email.reset();
  whatsapp.clear();
  bindOfferDelivery({
    jobs: notes.jobs,
    clock: () => notes.now(),
    whatsappAvailable: () => true,
    keys: scheduling.keys,
  });
});

const mobile = () => `+54911555${String(10_000 + ++mobiles).slice(1)}`;

/** A patient who opted in to WhatsApp, with a reminder queued on each channel for tomorrow. */
async function withReminderOnBothChannels(contact: { email: string | null }) {
  week += 1;
  const patientId = await notes.patient({ email: contact.email, phone: mobile() });
  await scheduling.inTenant((tx) =>
    recordOptIn(tx, { patientId, channel: 'whatsapp', source: 'online_booking', actor }),
  );
  const appointment = await notes.book(patientId, week);
  const sendAt = new Date(new Date(appointment.startsAt).getTime() - 24 * 3_600_000);
  const groupKey = `reminder:${appointment.id}:v${String(appointment.version)}:l24`;
  const queue = (channel: 'email' | 'whatsapp', kind: 'reminder' | 'confirmation' = 'reminder') =>
    notes.queue({
      kind,
      channel,
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      sendAt,
      dedupeKey: `${groupKey}:${kind}:${channel}`,
    });
  return {
    patientId,
    appointment,
    sendAt,
    emailReminder: await queue('email'),
    whatsappReminder: await queue('whatsapp'),
    queue,
  };
}

const optOut = (
  patientId: string,
  source: 'whatsapp_keyword' | 'email_link' = 'whatsapp_keyword',
) => scheduling.inTenant((tx) => optOutPatient(tx, { patientId, source, actor }));

const choices = (patientId: string) =>
  scheduling.inTenant((tx) =>
    tx
      .select({
        channel: channelPreference.channel,
        state: channelPreference.state,
        source: channelPreference.source,
        recordedBy: channelPreference.recordedBy,
      })
      .from(channelPreference)
      .where(eq(channelPreference.patientId, patientId))
      .orderBy(channelPreference.channel, channelPreference.createdAt, channelPreference.id),
  );

const log = (appointmentId: string) =>
  scheduling.inTenant((tx) =>
    tx.select().from(message).where(eq(message.appointmentId, appointmentId)),
  );

describe('an opt-out on WhatsApp (B7)', () => {
  it('opts the patient out of email as well, and cancels what was queued on both channels', async () => {
    const r = await withReminderOnBothChannels({ email: 'ambos@example.test' });

    const result = await optOut(r.patientId, 'whatsapp_keyword');

    expect(result).toEqual({ recorded: true, cancelled: 2 });
    expect(await choices(r.patientId)).toEqual([
      { channel: 'email', state: 'opted_out', source: 'whatsapp_keyword', recordedBy: null },
      { channel: 'whatsapp', state: 'opted_in', source: 'online_booking', recordedBy: null },
      { channel: 'whatsapp', state: 'opted_out', source: 'whatsapp_keyword', recordedBy: null },
    ]);
    expect(await scheduling.inTenant((tx) => loadPreferences(tx, r.patientId))).toEqual({
      email: 'opted_out',
      whatsapp: 'opted_out',
    });
    expect(
      (await log(r.appointment.id)).map(
        (row) => `${row.channel}:${row.status}:${row.cancelReason ?? ''}`,
      ),
    ).toEqual(
      expect.arrayContaining(['email:cancelled:opted_out', 'whatsapp:cancelled:opted_out']),
    );
  });

  it('puts nothing in place of what was cancelled: the other channel does not take over', async () => {
    const r = await withReminderOnBothChannels({ email: 'nada@example.test' });
    const confirmation = await r.queue('whatsapp', 'confirmation');

    await optOut(r.patientId);

    const rows = await log(r.appointment.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'cancelled')).toBe(true);
    expect(rows.find((row) => row.id === confirmation)?.status).toBe('cancelled');
  });

  it('sends no reminder on any channel when the time comes', async () => {
    const r = await withReminderOnBothChannels({ email: 'silencio@example.test' });
    await optOut(r.patientId);
    notes.setNow(new Date(r.sendAt.getTime() + 60_000));

    await notes.runAllJobs();

    expect(notes.email.sent).toEqual([]);
    expect(whatsapp.sent).toEqual([]);
  });

  it('cancels the offers and the video follow-ups that were queued too', async () => {
    const r = await withReminderOnBothChannels({ email: 'ofertas@example.test' });
    const offer = await notes.queue({
      kind: 'waitlist_offer',
      channel: 'email',
      patientId: r.patientId,
      dedupeKey: `offer:${r.patientId}:email`,
    });
    const followUp = await notes.queue({
      kind: 'video_link',
      channel: 'whatsapp',
      patientId: r.patientId,
      appointmentId: r.appointment.id,
      plannedStartsAt: new Date(r.appointment.startsAt),
      appointmentVersion: r.appointment.version,
      dedupeKey: `video:${r.appointment.id}:whatsapp`,
    });

    await optOut(r.patientId);

    expect(await notes.message(offer)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
    expect(await notes.message(followUp)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
  });

  it('does not touch another patient', async () => {
    const leaving = await withReminderOnBothChannels({ email: 'sale@example.test' });
    const staying = await withReminderOnBothChannels({ email: 'queda@example.test' });

    await optOut(leaving.patientId);

    expect((await notes.message(staying.emailReminder)).status).toBe('queued');
    expect((await notes.message(staying.whatsappReminder)).status).toBe('queued');
    expect(await choices(staying.patientId)).toEqual([
      { channel: 'whatsapp', state: 'opted_in', source: 'online_booking', recordedBy: null },
    ]);
  });
});

describe('an opt-out by the link of an email (B7)', () => {
  it('opts the patient out of WhatsApp as well', async () => {
    const r = await withReminderOnBothChannels({ email: 'enlace@example.test' });

    const result = await optOut(r.patientId, 'email_link');

    expect(result).toEqual({ recorded: true, cancelled: 2 });
    expect(await scheduling.inTenant((tx) => loadPreferences(tx, r.patientId))).toEqual({
      email: 'opted_out',
      whatsapp: 'opted_out',
    });
    expect((await notes.message(r.whatsappReminder)).cancelReason).toBe('opted_out');
  });

  it('records WhatsApp as opted out even when the patient never opted in to it', async () => {
    const patientId = await notes.patient({ email: 'sin-wa@example.test' });

    await optOut(patientId, 'email_link');

    expect(await scheduling.inTenant((tx) => loadPreferences(tx, patientId))).toEqual({
      email: 'opted_out',
      whatsapp: 'opted_out',
    });
  });
});

describe('an opt-out recorded by reception (B7)', () => {
  it('opts out every channel, names the staff member on each, and audits each', async () => {
    const patientId = await notes.patient({ email: 'recepcion@example.test', phone: mobile() });
    const staff = {
      ...actor,
      userId: scheduling.reception.user.id,
      actingRole: 'reception' as const,
    };

    await scheduling.inTenant((tx) =>
      optOutPatient(tx, {
        patientId,
        source: 'staff',
        recordedBy: scheduling.reception.user.id,
        actor: staff,
      }),
    );

    expect(await choices(patientId)).toEqual([
      {
        channel: 'email',
        state: 'opted_out',
        source: 'staff',
        recordedBy: scheduling.reception.user.id,
      },
      {
        channel: 'whatsapp',
        state: 'opted_out',
        source: 'staff',
        recordedBy: scheduling.reception.user.id,
      },
    ]);
    const audits = await scheduling.inTenant((tx) =>
      tx
        .select({ metadata: auditEvent.metadata })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.patientId, patientId),
            eq(auditEvent.action, 'notification.optout.recorded'),
          ),
        ),
    );
    expect(audits).toHaveLength(2);
    expect(audits.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        { channel: 'email', source: 'staff' },
        { channel: 'whatsapp', source: 'staff' },
      ]),
    );
  });
});

describe('opting out twice, or after a single channel was opted out before B7', () => {
  it('is idempotent: asking again changes nothing', async () => {
    const r = await withReminderOnBothChannels({ email: 'dos@example.test' });
    await optOut(r.patientId);
    const before = await choices(r.patientId);

    const again = await optOut(r.patientId, 'email_link');

    expect(again).toEqual({ recorded: false, cancelled: 0 });
    expect(await choices(r.patientId)).toEqual(before);
  });

  it('completes a patient who had opted out of one channel only', async () => {
    const patientId = await notes.patient({ email: 'viejo@example.test', phone: mobile() });
    await scheduling.inTenant((tx) =>
      recordOptOutOnly(tx, { patientId, channel: 'email', source: 'email_link', actor }),
    );

    const result = await optOut(patientId, 'whatsapp_keyword');

    expect(result.recorded).toBe(true);
    expect(await scheduling.inTenant((tx) => loadPreferences(tx, patientId))).toEqual({
      email: 'opted_out',
      whatsapp: 'opted_out',
    });
    // The email choice keeps its first source: it is recorded once.
    expect((await choices(patientId)).filter((choice) => choice.channel === 'email')).toEqual([
      { channel: 'email', state: 'opted_out', source: 'email_link', recordedBy: null },
    ]);
  });
});

describe('who is told of an opt-out (B7)', () => {
  it('tells the listener once per opt-out, after every channel was recorded', async () => {
    const patientId = await notes.patient({ email: 'oyente@example.test', phone: mobile() });
    const told: { patientId: string; whatsapp: string; email: string }[] = [];
    bindOptOutListener(async (tx, event) => {
      const preferences = await loadPreferences(tx, event.patientId);
      told.push({ patientId: event.patientId, ...preferences });
    });

    await optOut(patientId);
    await optOut(patientId, 'email_link');

    expect(told).toEqual([{ patientId, email: 'opted_out', whatsapp: 'opted_out' }]);
  });
});

describe('a link to accept WhatsApp that was still pending (decision D22 stays as designed)', () => {
  it('is revoked by the opt-out, so following it later does not opt the patient back in', async () => {
    const patientId = await notes.patient({ email: 'pend@example.test', phone: mobile() });
    const tokens = createActionTokens({ clock: () => notes.now() });
    const staffLink = await scheduling.inTenant((tx) =>
      tokens.issue(tx, { kind: 'whatsapp_opt_in', subjectId: patientId }),
    );
    const formLink = await scheduling.inTenant((tx) =>
      tokens.issue(tx, {
        kind: 'whatsapp_opt_in',
        subjectId: crypto.randomUUID(),
        payload: { patientId, created: true },
      }),
    );

    await optOut(patientId);

    for (const link of [staffLink, formLink]) {
      expect(
        await scheduling.inTenant((tx) => tokens.inspect(tx, 'whatsapp_opt_in', link.token)),
      ).toBeNull();
    }
  });

  it('is revoked even when WhatsApp was already opted out and a new link was asked for', async () => {
    const patientId = await notes.patient({ email: 'nuevo@example.test', phone: mobile() });
    await scheduling.inTenant((tx) =>
      recordOptOutOnly(tx, { patientId, channel: 'whatsapp', source: 'whatsapp_keyword', actor }),
    );
    const tokens = createActionTokens({ clock: () => notes.now() });
    const newLink = await scheduling.inTenant((tx) =>
      tokens.issue(tx, { kind: 'whatsapp_opt_in', subjectId: patientId }),
    );
    expect(
      await scheduling.inTenant((tx) => tokens.inspect(tx, 'whatsapp_opt_in', newLink.token)),
    ).not.toBeNull();

    await optOut(patientId);

    expect(
      await scheduling.inTenant((tx) => tokens.inspect(tx, 'whatsapp_opt_in', newLink.token)),
    ).toBeNull();
  });

  it('leaves the links of another patient alone', async () => {
    const leaving = await notes.patient({ email: 'a@example.test', phone: mobile() });
    const staying = await notes.patient({ email: 'b@example.test', phone: mobile() });
    const tokens = createActionTokens({ clock: () => notes.now() });
    const link = await scheduling.inTenant((tx) =>
      tokens.issue(tx, { kind: 'whatsapp_opt_in', subjectId: staying }),
    );

    await optOut(leaving);

    expect(
      await scheduling.inTenant((tx) => tokens.inspect(tx, 'whatsapp_opt_in', link.token)),
    ).not.toBeNull();
  });
});
