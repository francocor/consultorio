import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { actionToken } from '../../src/db/schema/action-token.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { channelPreference } from '../../src/db/schema/channel-preference.js';
import { appointment, appointmentEvent } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * The links of a reminder, through the public token router, against the real application. The
 * links are the ones the sending job wrote into the email.
 */

const SLUG = 'notif-tokens';
let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
/** An application of the same organization whose clock a test moves (links are public: no sessions). */
let clockApp: FastifyInstance;
let routerNow = new Date('2031-05-05T12:00:00.000Z');
let slot = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: SLUG });
  notes = createNotificationsWorld(scheduling);
  await createTestTenant(runtime, { slug: 'notif-tokens-other' });
  await scheduling.inTenant((tx) =>
    tx.execute(
      sql`UPDATE membership SET display_name = 'Dra. Ríos' WHERE id = ${scheduling.doctor.membershipId}`,
    ),
  );
  clockApp = buildTestApplication(runtime, { clock: () => routerNow, keys: scheduling.keys });
  await clockApp.ready();
});

afterAll(async () => {
  await clockApp.close();
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.email.reset();
  notes.jobs.jobs.length = 0;
  routerNow = new Date('2031-05-05T12:00:00.000Z');
  await notes.setTenant({ status: 'active' });
  const settings = await scheduling.api.patch('/settings', scheduling.owner, {
    notifications: { reminderLeadHours: [24], hideProfessional: false, hideAppointmentType: false },
    onlineBooking: { rescheduleDeadlineHours: 12 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
});

const view = (app: FastifyInstance, method: 'GET' | 'POST', url: string, slug = SLUG) =>
  app.inject({ method, url, headers: browserHeaders(slug) });

const pathOf = (link: string) => new URL(link).pathname;

/** A booked appointment with its reminder sent: the three links of the email. */
async function reminded(contact: { email?: string; phone?: string } = {}) {
  slot += 1;
  const time = `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
  const patientId = await notes.patient({
    email: contact.email ?? `paciente${String(slot)}@example.test`,
    ...contact,
  });
  const booked = await notes.book(patientId, 1 + Math.floor(slot / 8), time);
  const id = await notes.queue({
    kind: 'reminder',
    patientId,
    appointmentId: booked.id,
    plannedStartsAt: new Date(booked.startsAt),
    appointmentVersion: booked.version,
    dedupeKey: `tokens:${booked.id}:email`,
  });
  await notes.runAllJobs();
  const mail = notes.email.sent.at(-1);
  const links = mail?.text.match(/https?:\/\/\S+/g) ?? [];
  expect(links, mail?.text).toHaveLength(3);
  return {
    patientId,
    appointment: booked,
    messageId: id,
    confirm: pathOf(links[0] ?? ''),
    cancel: pathOf(links[1] ?? ''),
    optOut: pathOf(links[2] ?? ''),
  };
}

const statusOf = async (appointmentId: string) =>
  (
    await scheduling.inTenant((tx) =>
      tx
        .select({
          status: appointment.status,
          cancelledBy: appointment.cancelledByKind,
          reason: appointment.cancelReason,
          late: appointment.lateCancellation,
        })
        .from(appointment)
        .where(eq(appointment.id, appointmentId)),
    )
  )[0];

describe('the page of a link', () => {
  it('shows the date, the time, the place and the professional, and a button; it does not spend the link', async () => {
    const r = await reminded();

    const first = await view(scheduling.app, 'GET', r.confirm);
    const second = await view(scheduling.app, 'GET', r.confirm);

    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/html');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['content-security-policy']).toContain("default-src 'none'");
    // A browser sends `Origin: null` on the form POST under `no-referrer`: the origin check would
    // refuse every click. The token only travels to the page's own origin.
    expect(first.headers['referrer-policy']).toBe('same-origin');
    expect(first.body).toContain('Confirme su asistencia');
    expect(first.body).toContain('<dd>lunes');
    expect(first.body).toMatch(/<dt>Hora<\/dt>\s*<dd>\d\d:\d\d<\/dd>/);
    expect(first.body).toContain('Lugar');
    expect(first.body).toContain('<dd>Dra. Ríos</dd>');
    expect(first.body).toContain('Confirmar asistencia</button>');
    expect(second.statusCode).toBe(200);
    expect((await statusOf(r.appointment.id))?.status).toBe('scheduled');
  });

  it('shows nothing else about the patient: no name, no address, no phone, no ids', async () => {
    const r = await reminded({ email: 'secreto@example.test', phone: '1144445555' });

    const body = (await view(scheduling.app, 'GET', r.confirm)).body;

    for (const leaked of [
      'secreto',
      '1144445555',
      'Prueba',
      'Ana',
      r.patientId,
      r.appointment.id,
    ]) {
      expect(body, leaked).not.toContain(leaked);
    }
  });

  it('leaves the professional out when the organization uses neutral wording', async () => {
    const response = await scheduling.api.patch('/settings', scheduling.owner, {
      notifications: { hideProfessional: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    const r = await reminded();

    const body = (await view(scheduling.app, 'GET', r.confirm)).body;

    expect(body).toContain('Lugar');
    expect(body).not.toContain('Profesional');
  });

  it('answers a guessed, a tampered, a spent and an expired link with one identical page', async () => {
    const r = await reminded();
    const tampered = `${r.confirm.slice(0, -1)}${r.confirm.endsWith('A') ? 'B' : 'A'}`;
    const spent = await reminded();
    expect((await view(scheduling.app, 'POST', spent.confirm)).statusCode).toBe(200);
    const expired = await reminded();
    await scheduling.inTenant((tx) =>
      tx
        .update(actionToken)
        .set({ expiresAt: new Date('2000-01-01T00:00:00Z') })
        .where(eq(actionToken.subjectId, expired.appointment.id)),
    );
    const random = '/public/t/' + 'x'.repeat(43);

    const answers = await Promise.all(
      [
        tampered,
        spent.confirm,
        expired.confirm,
        expired.cancel,
        random,
        '/public/t/not-a-token',
      ].map((path) => view(scheduling.app, 'GET', path)),
    );

    expect(answers.map((answer) => answer.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
    const [reference] = answers;
    expect(reference?.body).toContain('Este enlace no es válido');
    for (const answer of answers) expect(answer.body).toBe(reference?.body);
    const posted = await view(scheduling.app, 'POST', tampered);
    expect(posted.statusCode).toBe(404);
    expect(posted.body).toBe(reference?.body);
  });

  it('does not open a link of one organization on the address of another', async () => {
    const r = await reminded();

    const other = await view(scheduling.app, 'GET', r.confirm, 'notif-tokens-other');
    const own = await view(
      scheduling.app,
      'GET',
      '/public/t/' + 'y'.repeat(43),
      'notif-tokens-other',
    );

    expect(other.statusCode).toBe(404);
    expect(other.body).toBe(own.body);
    expect(other.body).not.toContain('Confirme su asistencia');
  });

  it('is rate limited per client', async () => {
    const results = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      results.push(
        (
          await scheduling.app.inject({
            method: 'GET',
            url: '/public/t/' + 'z'.repeat(43),
            headers: browserHeaders(SLUG),
            remoteAddress: '10.77.0.9',
          })
        ).statusCode,
      );
    }

    expect(results.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(results[30]).toBe(429);
  });
});

describe('confirming', () => {
  it('confirms the appointment, records when, and audits it; a second tap finds a spent link', async () => {
    const r = await reminded();

    const confirmed = await view(scheduling.app, 'POST', r.confirm);

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.body).toContain('Asistencia confirmada');
    expect((await statusOf(r.appointment.id))?.status).toBe('confirmed');
    const history = await scheduling.inTenant((tx) =>
      tx
        .select({
          kind: appointmentEvent.kind,
          to: appointmentEvent.toStatus,
          at: appointmentEvent.createdAt,
        })
        .from(appointmentEvent)
        .where(
          and(
            eq(appointmentEvent.appointmentId, r.appointment.id),
            eq(appointmentEvent.kind, 'status_changed'),
          ),
        ),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ to: 'confirmed' });
    expect(history[0]?.at).toBeInstanceOf(Date);
    const audits = await scheduling.inTenant((tx) =>
      tx
        .select({ action: auditEvent.action, userId: auditEvent.actorUserId })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.resourceId, r.appointment.id),
            eq(auditEvent.action, 'appointment.status_changed'),
          ),
        ),
    );
    expect(audits).toHaveLength(1);

    expect((await view(scheduling.app, 'POST', r.confirm)).statusCode).toBe(404);
  });

  it('says so, and changes nothing, when reception already confirmed it', async () => {
    const r = await reminded();
    const staff = await scheduling.act(r.appointment, 'confirm', scheduling.reception);
    expect(staff.statusCode, staff.body).toBe(200);

    const page = await view(scheduling.app, 'POST', r.confirm);

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Su asistencia ya está confirmada');
    expect(page.body).not.toContain('Confirmar asistencia</button>');
  });

  it('is a link that no longer works once the appointment was cancelled', async () => {
    const r = await reminded();
    const cancelled = await scheduling.act(r.appointment, 'cancel', scheduling.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    expect((await view(scheduling.app, 'GET', r.confirm)).statusCode).toBe(404);
    expect((await view(scheduling.app, 'POST', r.confirm)).statusCode).toBe(404);
  });

  it('says the link is no longer valid after the appointment started, and changes nothing', async () => {
    const r = await reminded();
    // The link expires at the start of the appointment; the clock of the router passes it.
    routerNow = new Date(new Date(r.appointment.startsAt).getTime() + 60_000);

    const late = await view(clockApp, 'POST', r.confirm);

    expect(late.statusCode).toBe(404);
    expect(late.body).toContain('Este enlace no es válido');
    expect((await statusOf(r.appointment.id))?.status).toBe('scheduled');
  });
});

describe('cancelling', () => {
  it('cancels the appointment as cancelled by the patient, on time', async () => {
    const r = await reminded();
    routerNow = new Date(new Date(r.appointment.startsAt).getTime() - 30 * 3_600_000);

    const cancelled = await view(clockApp, 'POST', r.cancel);

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body).toContain('Turno cancelado');
    expect(await statusOf(r.appointment.id)).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'patient',
      reason: 'patient_request',
      late: false,
    });
    const audits = await scheduling.inTenant((tx) =>
      tx
        .select({ action: auditEvent.action })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.resourceId, r.appointment.id),
            eq(auditEvent.action, 'appointment.cancelled'),
          ),
        ),
    );
    expect(audits).toHaveLength(1);
  });

  it('asks the patient to contact the organization once the deadline has passed', async () => {
    const r = await reminded();
    // Five hours before the start; the deadline of this organization is twelve.
    routerNow = new Date(new Date(r.appointment.startsAt).getTime() - 5 * 3_600_000);

    const asked = await view(clockApp, 'GET', r.cancel);
    const tried = await view(clockApp, 'POST', r.cancel);

    for (const page of [asked, tried]) {
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('Comuníquese con la organización');
      expect(page.body).not.toContain('Cancelar el turno</button>');
    }
    expect((await statusOf(r.appointment.id))?.status).toBe('scheduled');
  });

  it('flags the cancellation as late when the organization has a late window and it is inside it', async () => {
    const response = await scheduling.api.patch('/settings', scheduling.owner, {
      onlineBooking: { rescheduleDeadlineHours: 0 },
    });
    expect(response.statusCode, response.body).toBe(200);
    const r = await reminded();
    routerNow = new Date(new Date(r.appointment.startsAt).getTime() - 60 * 60_000);

    const cancelled = await view(clockApp, 'POST', r.cancel);

    expect(cancelled.statusCode).toBe(200);
    expect((await statusOf(r.appointment.id))?.late).toBe(true);
  });
});

describe('opting out', () => {
  it('records the opt-out of the channel in the link, for that patient only, and audits it', async () => {
    const r = await reminded();
    const other = await reminded();

    const page = await view(scheduling.app, 'GET', r.optOut);
    const done = await view(scheduling.app, 'POST', r.optOut);

    expect(page.body).toContain('Dejar de recibir mensajes por email');
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('no recibirá más mensajes');
    const rows = await scheduling.inTenant((tx) =>
      tx
        .select({
          patientId: channelPreference.patientId,
          channel: channelPreference.channel,
          source: channelPreference.source,
        })
        .from(channelPreference)
        .where(sql`${channelPreference.patientId} in (${r.patientId}, ${other.patientId})`),
    );
    expect(rows).toEqual([{ patientId: r.patientId, channel: 'email', source: 'email_link' }]);
    const audits = await scheduling.inTenant((tx) =>
      tx
        .select({ metadata: auditEvent.metadata })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.patientId, r.patientId),
            eq(auditEvent.action, 'notification.optout.recorded'),
          ),
        ),
    );
    expect(audits).toEqual([{ metadata: { channel: 'email', source: 'email_link' } }]);
    expect((await view(scheduling.app, 'POST', r.optOut)).statusCode).toBe(404);
  });

  it('cancels what was still queued for that patient on that channel', async () => {
    const r = await reminded();
    const next = await notes.queue({
      kind: 'reminder',
      patientId: r.patientId,
      appointmentId: r.appointment.id,
      plannedStartsAt: new Date(r.appointment.startsAt),
      appointmentVersion: r.appointment.version,
      dedupeKey: `tokens:${r.appointment.id}:second:email`,
    });

    await view(scheduling.app, 'POST', r.optOut);

    expect(await notes.message(next)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
  });
});

describe('links die with the appointment they were written for', () => {
  it('stops the confirm and cancel links after a reschedule', async () => {
    const r = await reminded();
    const moved = await scheduling.act(r.appointment, 'reschedule', scheduling.reception, {
      local: { date: scheduling.monday(60), time: '10:00' },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    expect((await view(scheduling.app, 'GET', r.confirm)).statusCode).toBe(404);
    expect((await view(scheduling.app, 'POST', r.cancel)).statusCode).toBe(404);
    expect((await statusOf(r.appointment.id))?.status).toBe('scheduled');
  });

  it('stops working after the appointment is cancelled by reception', async () => {
    const r = await reminded();
    const cancelled = await scheduling.act(r.appointment, 'cancel', scheduling.reception, {
      cancelledBy: 'organization',
      reasonCode: 'professional_unavailable',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const dead = await scheduling.inTenant((tx) =>
      tx
        .select({ revoked: actionToken.revokedAt })
        .from(actionToken)
        .where(and(eq(actionToken.subjectId, r.appointment.id))),
    );
    expect(dead.length).toBeGreaterThanOrEqual(2);
    expect(dead.every((token) => token.revoked !== null)).toBe(true);
  });

  it('does not revoke the opt-out link: it belongs to the patient, not to an appointment', async () => {
    const r = await reminded();
    await scheduling.act(r.appointment, 'reschedule', scheduling.reception, {
      local: { date: scheduling.monday(61), time: '10:00' },
    });

    expect((await view(scheduling.app, 'GET', r.optOut)).statusCode).toBe(200);
  });
});

describe('in a read-only organization', () => {
  it('refuses to confirm, and lets the patient cancel and opt out', async () => {
    const r = await reminded();
    const second = await reminded();
    await notes.setTenant({ status: 'read_only' });

    const confirmView = await view(scheduling.app, 'GET', r.confirm);
    const confirm = await view(scheduling.app, 'POST', r.confirm);
    const cancel = await view(scheduling.app, 'POST', second.cancel);
    const optOut = await view(scheduling.app, 'POST', r.optOut);

    expect([confirmView.statusCode, confirm.statusCode]).toEqual([402, 402]);
    expect(confirm.body).toContain('No es posible realizar esta acción ahora');
    expect((await statusOf(r.appointment.id))?.status).toBe('scheduled');
    expect(cancel.statusCode).toBe(200);
    expect((await statusOf(second.appointment.id))?.status).toBe('cancelled');
    expect(optOut.statusCode).toBe(200);
    // The refused link was not spent: it works once the organization is back.
    await notes.setTenant({ status: 'active' });
    expect((await view(scheduling.app, 'POST', r.confirm)).statusCode).toBe(200);
  });
});
