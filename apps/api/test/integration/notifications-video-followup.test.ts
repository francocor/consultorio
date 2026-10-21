import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { message } from '../../src/db/schema/notifications.js';
import { loadConfig } from '../../src/main/config.js';
import { notificationsWiring } from '../../src/main/wiring/notifications.js';
import { teleconsultationWiring } from '../../src/main/wiring/teleconsultation.js';
import { recordOptIn } from '../../src/modules/notifications/application/preferences.js';
import { createVideoJoinRegistry } from '../../src/modules/notifications/index.js';
import { createTenantLifecycle } from '../../src/modules/tenancy/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { JobDefinition } from '../../src/platform/jobs/define-job.js';
import { runPending } from '../support/jobs.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import { createVideoWorld, type VideoWorld } from '../support/video-world.js';

/**
 * A reminder of a virtual appointment that went out while the video link did not exist said "we
 * will send the link separately". These tests hold that promise: when the link appears (the room
 * is created, or a person attaches a manual link) the patient gets one follow-up message through
 * notifications, on the same channel rules as any other message, once, and not in quiet hours.
 * The jobs are the ones the worker process registers (`main/wiring`), joined the way `main.ts`
 * joins them.
 */

const MINUTE = 60_000;
const actor = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };
const NOON = new Date('2031-05-06T15:00:00.000Z');

let runtime: DbHandle;
let video: VideoWorld;
let notes: NotificationsWorld;
let now = NOON;
let definitions: JobDefinition[];
let week = 700;
const nextWeek = () => ++week;
const registry = createVideoJoinRegistry();

const env = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  video = await createVideoWorld(runtime, { slug: 'notif-video-followup' });
  notes = createNotificationsWorld(video, { jobs: video.jobs });
  const adapters = {
    forTenant: (_tenant: unknown, port: string) =>
      port === 'videoLink'
        ? video.provider
        : port === 'email'
          ? notes.email
          : port === 'whatsapp'
            ? notes.whatsapp
            : undefined,
  };
  const context = {
    config: loadConfig(env),
    adapters: adapters as never,
    email: notes.email,
    clock: () => now,
    videoJoin: registry,
    tenantLifecycle: createTenantLifecycle(),
  };
  const job = { client: video.jobs, db: runtime.db, metrics: {} as never, log: {} as never };
  definitions = [
    ...(teleconsultationWiring.worker?.(context).jobs?.(job) ?? []),
    ...(notificationsWiring.worker?.(context).jobs?.(job) ?? []),
  ];
});

afterAll(async () => {
  await video.close();
  await runtime.close();
});

beforeEach(() => {
  video.forgetPastWork();
  video.useProvider(video.provider);
  now = NOON;
  notes.email.reset();
  video.jobs.jobs.length = 0;
});

const roomJobs = () => definitions.filter((definition) => definition.name === 'video.link.create');
const sendJobs = () => definitions.filter((definition) => definition.name !== 'video.link.create');
const createRooms = () => runPending(runtime.db, video.jobs, roomJobs());
/** Runs the messages that are due now, the way the queue would: one that waits is left alone. */
const sendMessages = async () => {
  for (let round = 0; round < 4; round += 1) {
    const waiting = video.jobs.jobs.filter(
      (job) =>
        !job.done &&
        job.options.startAfter !== undefined &&
        new Date(job.options.startAfter).getTime() > now.getTime(),
    );
    for (const job of waiting) job.done = true;
    const due = video.jobs.pending('reminder.send').length;
    if (due > 0) await runPending(runtime.db, video.jobs, sendJobs());
    for (const job of waiting) job.done = false;
    if (due === 0) return;
  }
};

/** A virtual appointment whose reminder is queued, and whose room does not exist yet. */
async function pendingReminder(options: { whatsapp?: boolean } = {}) {
  const phone = options.whatsapp ? '+5491155550123' : null;
  const patientId = await notes.patient({ email: 'ana@example.test', phone });
  if (options.whatsapp) {
    await video.inTenant((tx) =>
      recordOptIn(tx, { patientId, channel: 'whatsapp', source: 'patient_email_link', actor }),
    );
  }
  const appointment = await video.bookVirtual(nextWeek(), '10:00');
  await video.inTenant((tx) =>
    tx.execute(sql`UPDATE appointment SET patient_id = ${patientId} WHERE id = ${appointment.id}`),
  );
  await notes.queue({
    kind: 'reminder',
    channel: options.whatsapp ? 'whatsapp' : 'email',
    patientId,
    appointmentId: appointment.id,
    plannedStartsAt: new Date(appointment.startsAt),
    appointmentVersion: appointment.version,
    dedupeKey: `reminder:${appointment.id}:24:${options.whatsapp ? 'whatsapp' : 'email'}`,
  });
  await sendMessages();
  return { patientId, appointment };
}

const messagesOf = (appointmentId: string) =>
  video.inTenant((tx) =>
    tx
      .select({
        kind: message.kind,
        channel: message.channel,
        status: message.status,
        videoPending: message.videoPending,
        sendAt: message.sendAt,
      })
      .from(message)
      .where(eq(message.appointmentId, appointmentId))
      .orderBy(message.createdAt),
  );

describe('the reminder that promised the link', () => {
  it('is remembered as having gone out without it', async () => {
    const { appointment } = await pendingReminder();

    expect(notes.email.sent.at(-1)?.text).toContain('le enviaremos el enlace por separado');
    expect(await messagesOf(appointment.id)).toEqual([
      expect.objectContaining({ kind: 'reminder', status: 'sent', videoPending: true }),
    ]);
  });

  it('is not remembered that way when it already carried the link', async () => {
    const patientId = await notes.patient({ email: 'ana@example.test' });
    const appointment = await video.bookVirtual(nextWeek(), '10:00');
    await video.inTenant((tx) =>
      tx.execute(
        sql`UPDATE appointment SET patient_id = ${patientId} WHERE id = ${appointment.id}`,
      ),
    );
    await createRooms();
    await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `reminder:${appointment.id}:24:email`,
    });

    await sendMessages();

    expect(notes.email.sent.at(-1)?.text).toContain('/public/v/');
    expect(await messagesOf(appointment.id)).toEqual([
      expect.objectContaining({ kind: 'reminder', videoPending: false }),
    ]);
  });
});

describe('the follow-up with the video link', () => {
  it('is sent when the room is created, with the address, after the reminder that promised it', async () => {
    const { appointment } = await pendingReminder();

    await createRooms();
    await sendMessages();

    const followUp = notes.email.sent.at(-1);
    expect(followUp?.subject).toMatch(/^El enlace de su videoconsulta en /);
    expect(followUp?.to).toBe('ana@example.test');
    expect(followUp?.text).toMatch(/\/public\/v\/[A-Za-z0-9_-]{43}/);
    expect(notes.email.sent).toHaveLength(2);
    expect(await messagesOf(appointment.id)).toEqual([
      expect.objectContaining({ kind: 'reminder', status: 'sent' }),
      expect.objectContaining({ kind: 'video_link', channel: 'email', status: 'sent' }),
    ]);
  });

  it('is sent although the appointment changed state after the reminder (the patient confirmed)', async () => {
    const { appointment } = await pendingReminder();
    const confirmed = await video.act(appointment, 'confirm', video.reception);
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    await createRooms();
    await sendMessages();

    expect(notes.email.sent.at(-1)?.subject).toMatch(/^El enlace de su videoconsulta/);
    const rows = await messagesOf(appointment.id);
    expect(rows.filter((row) => row.kind === 'video_link')).toHaveLength(1);
  });

  it('is sent once, however many times the link is announced', async () => {
    const { appointment } = await pendingReminder();
    await createRooms();

    for (let times = 0; times < 3; times += 1) {
      await video.inTenant((tx) => registry.linkReady(tx, appointment.id));
    }
    await sendMessages();

    expect(notes.email.sent).toHaveLength(2);
    const followUps = (await messagesOf(appointment.id)).filter((row) => row.kind === 'video_link');
    expect(followUps).toHaveLength(1);
  });

  it('is not sent when the reminder already carried the link', async () => {
    const patientId = await notes.patient({ email: 'ana@example.test' });
    const appointment = await video.bookVirtual(nextWeek(), '10:00');
    await video.inTenant((tx) =>
      tx.execute(
        sql`UPDATE appointment SET patient_id = ${patientId} WHERE id = ${appointment.id}`,
      ),
    );
    await createRooms();
    await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `reminder:${appointment.id}:24:email`,
    });
    await sendMessages();

    await video.inTenant((tx) => registry.linkReady(tx, appointment.id));
    await sendMessages();

    expect(notes.email.sent).toHaveLength(1);
  });

  it('is not sent when no reminder went out yet: the first reminder will carry the link', async () => {
    const patientId = await notes.patient({ email: 'ana@example.test' });
    const appointment = await video.bookVirtual(nextWeek(), '10:00');
    await video.inTenant((tx) =>
      tx.execute(
        sql`UPDATE appointment SET patient_id = ${patientId} WHERE id = ${appointment.id}`,
      ),
    );

    await createRooms();
    await sendMessages();

    expect(notes.email.sent).toHaveLength(0);
    expect(await messagesOf(appointment.id)).toEqual([]);
  });

  it('is not sent for an appointment that was cancelled in the meantime', async () => {
    const { appointment } = await pendingReminder();
    await video.act(appointment, 'cancel', video.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });

    await video.inTenant((tx) => registry.linkReady(tx, appointment.id));
    await sendMessages();

    expect(notes.email.sent).toHaveLength(1);
  });

  it('is sent by WhatsApp, with its own template, to a patient who opted in', async () => {
    const { appointment } = await pendingReminder({ whatsapp: true });
    const sentBefore = (notes.whatsapp as unknown as { sent: unknown[] }).sent.length;

    await createRooms();
    await sendMessages();

    const sent = (
      notes.whatsapp as unknown as {
        sent: { templateKey: string; vars: Record<string, string> }[];
      }
    ).sent;
    expect(sent).toHaveLength(sentBefore + 1);
    expect(sent.at(-1)?.templateKey).toBe('video_link');
    expect(sent.at(-1)?.vars['joinUrl']).toMatch(/\/public\/v\//);
    expect(notes.email.sent).toHaveLength(0);
    expect(await messagesOf(appointment.id)).toEqual([
      expect.objectContaining({ kind: 'reminder', channel: 'whatsapp' }),
      expect.objectContaining({ kind: 'video_link', channel: 'whatsapp', status: 'sent' }),
    ]);
  });

  it('goes by email when the patient opted out of WhatsApp after the reminder', async () => {
    const { appointment, patientId } = await pendingReminder({ whatsapp: true });
    await video.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO channel_preference (tenant_id, patient_id, channel, state, source)
              VALUES (${video.tenant.id}, ${patientId}, 'whatsapp', 'opted_out', 'whatsapp_keyword')`,
      ),
    );

    await createRooms();
    await sendMessages();

    const rows = await messagesOf(appointment.id);
    expect(rows.at(-1)).toMatchObject({ kind: 'video_link', channel: 'email', status: 'sent' });
    expect(notes.email.sent.at(-1)?.subject).toMatch(/^El enlace de su videoconsulta/);
  });

  it('waits for the end of quiet hours and is then sent', async () => {
    const { appointment } = await pendingReminder();
    // 22:00 in Buenos Aires.
    now = new Date('2031-05-07T01:00:00.000Z');

    await createRooms();
    await sendMessages();

    expect(notes.email.sent).toHaveLength(1);
    const followUp = (await messagesOf(appointment.id)).find((row) => row.kind === 'video_link');
    expect(followUp).toMatchObject({ kind: 'video_link', status: 'queued' });
    // 08:00 in Buenos Aires.
    expect(followUp?.sendAt.toISOString()).toBe('2031-05-07T11:00:00.000Z');
    const queued = video.jobs.jobs.find(
      (job) => job.name === 'reminder.send' && !job.done && job.options.startAfter !== undefined,
    );
    expect(new Date(queued?.options.startAfter ?? 0).toISOString()).toBe(
      '2031-05-07T11:00:00.000Z',
    );

    now = new Date('2031-05-07T11:00:00.000Z');
    await sendMessages();

    expect(notes.email.sent).toHaveLength(2);
    expect(notes.email.sent.at(-1)?.subject).toMatch(/^El enlace de su videoconsulta/);
  });

  it('is sent when a person attaches a manual link, which is the other way a link comes to exist', async () => {
    const { appointment } = await pendingReminder();

    const response = await video.api.put(
      `/appointments/${appointment.id}/video/manual-link`,
      video.reception,
      { url: 'https://meet.google.com/abc-defg-hij' },
    );
    expect(response.statusCode, response.body).toBe(200);
    await sendMessages();

    expect(notes.email.sent).toHaveLength(2);
    expect(notes.email.sent.at(-1)?.text).toMatch(/\/public\/v\/[A-Za-z0-9_-]{43}/);
    expect(notes.email.sent.at(-1)?.text).not.toContain('meet.google.com');
  });

  it('cancels a follow-up whose link no longer exists when its turn comes', async () => {
    const { appointment } = await pendingReminder();
    now = new Date('2031-05-07T01:00:00.000Z');
    await createRooms();
    // The appointment moves while the follow-up waits for the morning: its room is replaced.
    const moved = await video.act(appointment, 'reschedule', video.reception, {
      startsAt: new Date(new Date(appointment.startsAt).getTime() + 60 * MINUTE).toISOString(),
    });
    expect(moved.statusCode, moved.body).toBe(200);

    now = new Date('2031-05-07T11:00:00.000Z');
    await sendMessages();

    const [followUp] = await video.inTenant((tx) =>
      tx
        .select({ status: message.status, cancelReason: message.cancelReason })
        .from(message)
        .where(and(eq(message.appointmentId, appointment.id), eq(message.kind, 'video_link'))),
    );
    // A move of the appointment replaces everything that was queued for the old time.
    expect(followUp).toMatchObject({ status: 'cancelled', cancelReason: 'appointment_changed' });
    expect(notes.email.sent.map((sent) => sent.subject)).not.toContainEqual(
      expect.stringMatching(/^El enlace de su videoconsulta/),
    );
  });

  it('cancels a follow-up that finds no link when its turn comes, and says so', async () => {
    const { appointment } = await pendingReminder();
    now = new Date('2031-05-07T01:00:00.000Z');
    await createRooms();
    // The link goes away while the follow-up waits for the morning (the session is pending again).
    await video.inTenant((tx) =>
      tx.execute(
        sql`UPDATE video_session SET status = 'link_pending', pending_reason = 'creating'
              WHERE appointment_id = ${appointment.id}`,
      ),
    );

    now = new Date('2031-05-07T11:00:00.000Z');
    await sendMessages();

    const [followUp] = await video.inTenant((tx) =>
      tx
        .select({ status: message.status, cancelReason: message.cancelReason })
        .from(message)
        .where(and(eq(message.appointmentId, appointment.id), eq(message.kind, 'video_link'))),
    );
    expect(followUp).toMatchObject({ status: 'cancelled', cancelReason: 'video_link_unavailable' });
    expect(notes.email.sent).toHaveLength(1);
  });
});

describe('a follow-up that cannot reach the patient before the call (JD-S3 R2-B11)', () => {
  it('is cancelled and reception is told, as for any other message that was promised', async () => {
    const { appointment } = await pendingReminder();
    const startsAt = new Date(appointment.startsAt);
    // 20:30 the evening before: outside quiet hours, the link comes to exist and the follow-up is queued.
    now = new Date(startsAt.getTime() - 13.5 * 3_600_000);
    await createRooms();
    // The organization widens its quiet hours to cover the morning of the call.
    const widened = await video.api.patch('/settings', video.owner, {
      quietHours: { start: '21:00', end: '10:30' },
    });
    expect(widened.statusCode, widened.body).toBe(200);

    // Whatever reception was told until now is settled, so what follows is the follow-up's own.
    await video.inTenant((tx) =>
      tx.execute(
        sql`UPDATE worklist_item SET status = 'resolved', resolved_at = now(), resolved_by = ${video.owner.user.id},
                resolution = 'test'
              WHERE subject_id = ${appointment.id} AND status = 'open'`,
      ),
    );
    expect(await notes.worklistKinds(appointment.id)).toEqual([]);

    // 21:30: its turn comes inside quiet hours that end after the call starts.
    now = new Date(startsAt.getTime() - 12.5 * 3_600_000);
    await sendMessages();

    const [followUp] = await video.inTenant((tx) =>
      tx
        .select({ status: message.status, cancelReason: message.cancelReason })
        .from(message)
        .where(and(eq(message.appointmentId, appointment.id), eq(message.kind, 'video_link'))),
    );
    expect(followUp).toMatchObject({ status: 'cancelled', cancelReason: 'no_channel' });
    expect(await notes.worklistKinds(appointment.id)).toContain('reminder_not_sent');
  });
});
