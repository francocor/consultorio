import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { recordOptIn } from '../../src/modules/notifications/application/preferences.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { hostOf } from '../support/app.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import { createVideoWorld, type VideoWorld } from '../support/video-world.js';

/**
 * The reminders of a virtual appointment carry the platform join address that teleconsultation
 * registered with notifications; when the link does not exist yet the text says it follows.
 */

let runtime: DbHandle;
let video: VideoWorld;
let notes: NotificationsWorld;
let week = 500;
const nextWeek = () => ++week;

const patientActor = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  video = await createVideoWorld(runtime, { slug: 'notif-video' });
  notes = createNotificationsWorld(video, { jobs: video.jobs });
  notes.deps.videoJoin = {
    resolve: (tx, appointmentId) => video.joinUrlResolver().resolve(tx, appointmentId),
  };
});

afterAll(async () => {
  await video.close();
  await runtime.close();
});

beforeEach(() => {
  video.forgetPastWork();
  video.useProvider(video.provider);
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  video.setVideoNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.email.reset();
  notes.jobs.jobs.length = 0;
});

/** A virtual appointment of that patient on a Monday of its own. */
const bookVirtualFor = (patientId: string) =>
  video.book(nextWeek(), '10:00', { patientId, appointmentTypeId: video.virtual });

/** A virtual appointment with its reminder queued by email; `ready` runs the room creation first. */
async function virtualReminder(options: { ready: boolean; email?: string }) {
  const patientId = await notes.patient({ email: options.email ?? 'ana@example.test' });
  const appointment = await bookVirtualFor(patientId);
  if (options.ready) await video.runVideoJobs();
  const id = await notes.queue({
    kind: 'reminder',
    channel: 'email',
    patientId,
    appointmentId: appointment.id,
    plannedStartsAt: new Date(appointment.startsAt),
    appointmentVersion: appointment.version,
    dedupeKey: `reminder:${appointment.id}:24:email`,
  });
  return { id, appointment, patientId };
}

describe('the reminder of a virtual appointment', () => {
  it('carries the join address and names the mode, and the address opens', async () => {
    const { appointment } = await virtualReminder({ ready: true });

    await notes.runAllJobs();

    const sent = notes.email.sent.at(-1);
    expect(sent?.text).toContain('Modalidad: Videollamada');
    const joinUrl = /https?:\/\/\S+\/public\/v\/[A-Za-z0-9_-]{43}/.exec(sent?.text ?? '')?.[0];
    expect(joinUrl).toBeDefined();
    expect(new URL(joinUrl ?? '').host).toBe(hostOf(video.slug));
    expect(sent?.html).toContain('Unirse a la videollamada');
    // The address is the platform one: the provider room never reaches the message.
    const room = (await video.roomOf(appointment.id)) ?? '';
    expect(sent?.text).not.toContain(room);
    expect(sent?.text).not.toContain('jit.si');
    // Early, the page answers (the notice and the time the call opens), never an error.
    const page = await video.app.inject({
      method: 'GET',
      url: new URL(joinUrl ?? '').pathname,
      headers: { host: hostOf(video.slug) },
    });
    expect(page.statusCode).toBe(200);
  });

  it('says the link will be sent separately when the room does not exist yet', async () => {
    await virtualReminder({ ready: false });

    await notes.runAllJobs();

    const sent = notes.email.sent.at(-1);
    expect(sent?.text).toContain('Modalidad: Videollamada');
    expect(sent?.text).toContain('le enviaremos el enlace por separado');
    expect(sent?.text).not.toContain('/public/v/');
  });

  it('says the link follows when teleconsultation registered nothing', async () => {
    await virtualReminder({ ready: true });
    const registered = notes.deps.videoJoin;
    delete notes.deps.videoJoin;
    try {
      await notes.runAllJobs();
    } finally {
      if (registered) notes.deps.videoJoin = registered;
    }

    const sent = notes.email.sent.at(-1);
    expect(sent?.text).toContain('le enviaremos el enlace por separado');
    expect(sent?.text).not.toContain('/public/v/');
  });

  it('writes nothing about video for an appointment in person', async () => {
    const patientId = await notes.patient();
    const appointment = await notes.book(patientId, nextWeek());
    await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `reminder:${appointment.id}:24:email`,
    });

    await notes.runAllJobs();

    const sent = notes.email.sent.at(-1);
    expect(sent?.text).toContain('Hora: 10:00');
    expect(sent?.text).not.toContain('Modalidad');
    expect(sent?.text).not.toContain('videollamada');
  });

  it('is not left without its address when the reminder goes out 14 days ahead', async () => {
    const { appointment } = await virtualReminder({ ready: true });
    const start = new Date(appointment.startsAt).getTime();
    video.setVideoNow(new Date(start - 14 * 24 * 3_600_000));
    notes.setNow(new Date(start - 14 * 24 * 3_600_000));

    await notes.runAllJobs();

    const joinPath = /\/public\/v\/[A-Za-z0-9_-]{43}/.exec(
      notes.email.sent.at(-1)?.text ?? '',
    )?.[0];
    expect(joinPath).toBeDefined();
    // Still valid at the start of the window, two weeks later.
    video.setVideoNow(new Date(start - 10 * 60_000));
    const opened = await video.app.inject({
      method: 'GET',
      url: joinPath ?? '',
      headers: { host: hostOf(video.slug) },
    });
    expect(opened.statusCode).toBe(302);
  });

  it('puts the address in the WhatsApp message of a patient who opted in', async () => {
    const patientId = await notes.patient({ email: null, phone: '+5491155550101' });
    await video.inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'patient_email_link',
        actor: patientActor,
      }),
    );
    const appointment = await bookVirtualFor(patientId);
    await video.runVideoJobs();
    await notes.queue({
      kind: 'reminder',
      channel: 'whatsapp',
      patientId,
      appointmentId: appointment.id,
      plannedStartsAt: new Date(appointment.startsAt),
      appointmentVersion: appointment.version,
      dedupeKey: `reminder:${appointment.id}:24:whatsapp`,
    });

    await notes.runAllJobs();

    const fake = notes.whatsapp as unknown as {
      sent: { vars: Record<string, string> }[];
    };
    const last = fake.sent.at(-1);
    expect(last?.vars['mode']).toBe('Videollamada');
    expect(last?.vars['joinUrl']).toMatch(/\/public\/v\//);
  });
});

describe('the token behind the address', () => {
  it('is a video_join token that can be inspected', async () => {
    const { appointment } = await virtualReminder({ ready: true });
    await notes.runAllJobs();
    const text = notes.email.sent.at(-1)?.text ?? '';
    const token = /\/public\/v\/([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? '';

    const inspected = await video.inTenant((tx) =>
      createActionTokens().inspect(tx, 'video_join', token),
    );

    expect(inspected?.subjectId).toBe(appointment.id);
  });
});
