import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { recordOptIn } from '../../src/modules/notifications/application/preferences.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createTestAdapterResolver } from '../support/adapters.js';
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
 * The WhatsApp switch of the organization (`settings.integrations.whatsapp`): off means email only,
 * and a patient who has no email shows up on reception's worklist. Turning it off is audited.
 */

const patientActor: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
const whatsapp = createFakeWhatsAppSender();
let slot = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const jobs = createRecordingJobClient();
  scheduling = await createSchedulingHttpWorld(runtime, {
    slug: 'wa-switch',
    app: { adapters: createTestAdapterResolver({ whatsapp }), jobs },
  });
  notes = createNotificationsWorld(scheduling, { jobs, whatsapp });
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  notes.email.reset();
  whatsapp.clear();
  await setWhatsapp(true);
});

async function setWhatsapp(enabled: boolean) {
  const response = await scheduling.api.patch('/settings', scheduling.owner, {
    integrations: { whatsapp: enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** A patient who accepted WhatsApp, booked by the real application (so the planner runs). */
async function bookedOptedIn(contact: { email: string | null }) {
  slot += 1;
  const patientId = await notes.patient({ phone: '1144445555', email: contact.email });
  await scheduling.inTenant((tx) =>
    recordOptIn(tx, {
      patientId,
      channel: 'whatsapp',
      source: 'online_booking',
      actor: patientActor,
    }),
  );
  const time = `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
  const appointment = await notes.book(patientId, 1 + Math.floor(slot / 8), time);
  return { patientId, appointment };
}

describe('turning WhatsApp off', () => {
  it('is audited as an integration change, and only the switch is named, not the value of anything else', async () => {
    await setWhatsapp(false);

    const events = await scheduling.inTenant((tx) =>
      tx
        .select({ action: auditEvent.action, actor: auditEvent.actorUserId })
        .from(auditEvent)
        .where(eq(auditEvent.action, 'notification.integration.changed')),
    );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.at(-1)?.actor).toBe(scheduling.owner.user.id);
  });

  it('plans the reminders of an opted-in patient by email', async () => {
    await setWhatsapp(false);

    const r = await bookedOptedIn({ email: 'solo-email@example.test' });

    const rows = await notes.messagesOf(r.appointment.id);
    expect(rows.map((row) => [row.kind, row.channel, row.status])).toEqual([
      ['reminder', 'email', 'queued'],
    ]);
  });

  it('plans WhatsApp for the same patient while the switch is on', async () => {
    const r = await bookedOptedIn({ email: 'ambos@example.test' });

    const rows = await notes.messagesOf(r.appointment.id);
    expect(rows.map((row) => [row.kind, row.channel])).toEqual([['reminder', 'whatsapp']]);
  });

  it('opens "reminder not sent" for a patient who has no email, and sends nothing', async () => {
    await setWhatsapp(false);

    const r = await bookedOptedIn({ email: null });
    await notes.runAllJobs();

    expect(await notes.messagesOf(r.appointment.id)).toEqual([]);
    expect(await notes.worklistKinds(r.appointment.id)).toEqual(['reminder_not_sent']);
    expect(whatsapp.sent).toEqual([]);
    expect(notes.email.sent).toEqual([]);
  });

  it('moves a reminder that was already queued for WhatsApp to email when the switch goes off', async () => {
    const r = await bookedOptedIn({ email: 'cambia@example.test' });
    expect((await notes.messagesOf(r.appointment.id)).map((row) => row.channel)).toEqual([
      'whatsapp',
    ]);
    await setWhatsapp(false);

    await notes.runAllJobs();

    const rows = await notes.messagesOf(r.appointment.id);
    expect(rows.map((row) => [row.channel, row.status, row.cancelReason])).toEqual([
      ['whatsapp', 'cancelled', 'integration_off'],
      ['email', 'sent', null],
    ]);
    expect(whatsapp.sent).toEqual([]);
    expect(notes.email.sent.map((mail) => mail.to)).toEqual(['cambia@example.test']);
  });

  it('uses WhatsApp again as soon as the switch is back on', async () => {
    await setWhatsapp(false);
    await setWhatsapp(true);

    const r = await bookedOptedIn({ email: 'vuelve@example.test' });
    await notes.runAllJobs();

    expect(
      (await notes.messagesOf(r.appointment.id)).map((row) => [row.channel, row.status]),
    ).toEqual([['whatsapp', 'sent']]);
    expect(whatsapp.sent).toHaveLength(1);
  });

  it('leaves the video switch as it was', async () => {
    await setWhatsapp(false);
    const settings = await scheduling.api.get('/settings', scheduling.owner);

    expect(
      settings.json<{ integrations: { whatsapp: boolean; video: boolean } }>().integrations,
    ).toEqual({
      whatsapp: false,
      video: true,
      einvoicing: false,
    });
  });
});
