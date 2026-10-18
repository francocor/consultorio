import type { UsageResponse } from '@consultorio/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createLocalWhatsAppSender } from '../../src/adapters/whatsapp-local/index.js';
import { whatsappUsageAlert, whatsappUsageEvent } from '../../src/db/schema/usage-event.js';
import {
  failAcceptedMessage,
  prepareDelivery,
} from '../../src/modules/notifications/application/delivery.js';
import { createReminderPlanner } from '../../src/modules/notifications/application/plan-reminders.js';
import {
  recordOptIn,
  recordOptOut,
} from '../../src/modules/notifications/application/preferences.js';
import { createReminderSweepJob } from '../../src/modules/notifications/application/sweep.js';
import {
  recordWhatsappUsage,
  UNLIMITED_QUOTA,
  usageCount,
  type QuotaPolicy,
} from '../../src/modules/notifications/application/usage.js';
import { usageReport } from '../../src/modules/notifications/http/usage-routes.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * WhatsApp usage: counted when the provider accepts a message, once, against the professional of
 * the appointment; email and refusals are not counted; the owner is warned at 80% and 100%, once
 * per professional and month; a spent quota without overage sends the reminder by email.
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
let slot = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'usage-metering' });
  notes = createNotificationsWorld(scheduling, {
    whatsapp: createLocalWhatsAppSender({ db: runtime.db, appSecret: 'usage-metering-secret' }),
  });
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(() => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  notes.email.reset();
  notes.deps.quota = UNLIMITED_QUOTA;
});

const WEEK_MS = 7 * 86_400_000;
const FIRST_MONDAY = new Date('2031-05-12T00:00:00.000Z');

/** A distinct mobile number each time (the local simulator refuses a number it already refused). */
let numbers = 0;
const mobile = () => {
  numbers += 1;
  return `11${String(40_000_000 + numbers)}`;
};

/** An opted-in patient with a mobile and an email, and an appointment of the first doctor. */
async function whatsappReminder(options: { phone?: string; email?: string | null } = {}) {
  slot += 1;
  const patientId = await notes.patient({
    phone: options.phone ?? mobile(),
    email: options.email === undefined ? 'respaldo@example.test' : options.email,
  });
  await scheduling.inTenant((tx) =>
    recordOptIn(tx, {
      patientId,
      channel: 'whatsapp',
      source: 'online_booking',
      actor: patientActor,
    }),
  );
  const time = `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
  // An appointment after the clock of the test, whatever month the test lives in.
  const weeksAhead = Math.max(
    0,
    Math.ceil((notes.now().getTime() - FIRST_MONDAY.getTime()) / WEEK_MS),
  );
  const booked = await notes.book(patientId, weeksAhead + 1 + Math.floor(slot / 8), time);
  const id = await notes.queue({
    kind: 'reminder',
    channel: 'whatsapp',
    patientId,
    appointmentId: booked.id,
    professionalId: scheduling.doctor.professionalId,
    plannedStartsAt: new Date(booked.startsAt),
    appointmentVersion: booked.version,
    dedupeKey: `usage:${booked.id}:whatsapp`,
  });
  await notes.runAllJobs();
  return { id, patientId, appointment: booked };
}

/** The WhatsApp messages counted for a professional in the month of the test clock. */
const usageOf = async (professionalId: string) => {
  const [row] = await scheduling.inTenant((tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(whatsappUsageEvent)
      .where(
        and(
          eq(whatsappUsageEvent.professionalId, professionalId),
          eq(whatsappUsageEvent.period, notes.now().toISOString().slice(0, 7)),
          isNull(whatsappUsageEvent.releasedAt),
        ),
      ),
  );
  return row?.n ?? 0;
};

const ownerMails = () => notes.email.sent.filter((mail) => mail.to === scheduling.owner.user.email);

describe('counting', () => {
  it('counts an accepted WhatsApp message once, against the professional of the appointment', async () => {
    const before = await usageOf(scheduling.doctor.professionalId);
    const colleagueBefore = await usageOf(scheduling.colleague.professionalId);

    const r = await whatsappReminder();

    expect(await notes.message(r.id)).toMatchObject({ status: 'sent', channel: 'whatsapp' });
    expect(await usageOf(scheduling.doctor.professionalId)).toBe(before + 1);
    expect(await usageOf(scheduling.colleague.professionalId)).toBe(colleagueBefore);
  });

  it('counts a message once however many times its acceptance is processed', async () => {
    const r = await whatsappReminder();
    const before = await usageOf(scheduling.doctor.professionalId);

    const again = await scheduling.inTenant((tx) =>
      recordWhatsappUsage({ quota: UNLIMITED_QUOTA, channels: notes.deps.channels }, tx, {
        messageId: r.id,
        professionalId: scheduling.doctor.professionalId,
        now: notes.now(),
        tenant: { id: scheduling.tenant.id, isDemo: false },
      }),
    );

    expect(again).toEqual({ counted: false });
    expect(await usageOf(scheduling.doctor.professionalId)).toBe(before);
  });

  it('does not count a message the provider refused, nor the email that replaces it', async () => {
    const before = await usageOf(scheduling.doctor.professionalId);

    // The reserved +999 prefix is "not on WhatsApp" for the simulator.
    const r = await whatsappReminder({ phone: '+99910012000' });

    expect(await notes.message(r.id)).toMatchObject({
      status: 'failed',
      failureReason: 'not_on_whatsapp',
    });
    expect(notes.email.sent.map((mail) => mail.to)).toContain('respaldo@example.test');
    expect(await usageOf(scheduling.doctor.professionalId)).toBe(before);
  });

  it('does not count email', async () => {
    const before = await usageOf(scheduling.doctor.professionalId);
    const patientId = await notes.patient({ email: 'solo-email@example.test' });
    const booked = await notes.book(patientId, 30, '09:00');
    await notes.queue({
      kind: 'reminder',
      channel: 'email',
      patientId,
      appointmentId: booked.id,
      professionalId: scheduling.doctor.professionalId,
      plannedStartsAt: new Date(booked.startsAt),
      appointmentVersion: booked.version,
      dedupeKey: `usage:${booked.id}:email`,
    });

    await notes.runAllJobs();

    expect(await usageOf(scheduling.doctor.professionalId)).toBe(before);
  });
});

describe('the quota', () => {
  const quotaOf = (limit: number | null, overageAllowed: boolean): QuotaPolicy => ({
    limitFor: () => Promise.resolve({ limit, overageAllowed }),
  });

  it('warns the owner at 80% and at 100%, once each, and not again in the same month', async () => {
    notes.setNow(new Date('2031-07-07T12:00:00.000Z'));
    notes.deps.quota = quotaOf(5, true);

    for (let sent = 1; sent <= 3; sent += 1) await whatsappReminder();
    expect(ownerMails()).toEqual([]);

    await whatsappReminder();
    expect(ownerMails().map((mail) => mail.subject)).toEqual([
      expect.stringContaining('llegó al 80% del cupo mensual') as string,
    ]);

    await whatsappReminder();
    expect(ownerMails().map((mail) => mail.subject)).toEqual([
      expect.stringContaining('llegó al 80%') as string,
      expect.stringContaining('agotó el cupo mensual') as string,
    ]);

    await whatsappReminder();
    await whatsappReminder();
    expect(ownerMails()).toHaveLength(2);
    const alerts = await scheduling.inTenant((tx) =>
      tx
        .select({ threshold: whatsappUsageAlert.threshold, period: whatsappUsageAlert.period })
        .from(whatsappUsageAlert),
    );
    expect(
      alerts
        .filter((alert) => alert.period === '2031-07')
        .map((alert) => alert.threshold)
        .sort((a, b) => a - b),
    ).toEqual([80, 100]);
  });

  it('names the professional and the counts, and nobody else, in the email to the owner', async () => {
    notes.setNow(new Date('2031-08-04T12:00:00.000Z'));
    await scheduling.inTenant((tx) =>
      tx.execute(
        sql`UPDATE membership SET display_name = 'Dra. Ríos' WHERE id = ${scheduling.doctor.membershipId}`,
      ),
    );
    notes.deps.quota = quotaOf(1, true);

    await whatsappReminder();

    const mail = ownerMails().at(-1);
    expect(mail?.subject).toContain('Dra. Ríos');
    expect(mail?.text).toContain('1 de 1');
    expect(mail?.text).not.toContain('respaldo@example.test');
  });

  it('sends the reminder by email when the quota is spent and the plan has no overage', async () => {
    notes.setNow(new Date('2031-09-01T12:00:00.000Z'));
    notes.deps.quota = quotaOf(2, false);
    await whatsappReminder();
    await whatsappReminder();
    notes.email.reset();

    const spent = await whatsappReminder();

    expect(await notes.message(spent.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'quota_exhausted',
    });
    expect(notes.email.sent.map((mail) => mail.to)).toContain('respaldo@example.test');
    expect(await usageOf(scheduling.doctor.professionalId)).toBe(2);
  });

  it('keeps sending over the quota as billable overage when the plan allows it', async () => {
    notes.setNow(new Date('2031-10-06T12:00:00.000Z'));
    notes.deps.quota = quotaOf(1, true);
    await whatsappReminder();

    const over = await whatsappReminder();

    expect(await notes.message(over.id)).toMatchObject({ status: 'sent', channel: 'whatsapp' });
    expect(await usageOf(scheduling.doctor.professionalId)).toBe(2);
  });

  it('starts a new month from zero and warns again', async () => {
    notes.deps.quota = quotaOf(1, true);
    notes.setNow(new Date('2031-11-03T12:00:00.000Z'));
    await whatsappReminder();
    notes.setNow(new Date('2031-12-01T12:00:00.000Z'));
    notes.email.reset();

    await whatsappReminder();

    expect(await usageOf(scheduling.doctor.professionalId)).toBe(1);
    expect(ownerMails().map((mail) => mail.subject)).toEqual([
      expect.stringContaining('agotó el cupo mensual') as string,
    ]);
  });
});

describe('the quota under concurrency and across the month boundary (JD-S3 C7)', () => {
  const quotaOf = (limit: number | null, overageAllowed: boolean): QuotaPolicy => ({
    limitFor: () => Promise.resolve({ limit, overageAllowed }),
  });

  /** An opted-in patient whose WhatsApp reminder is queued, not yet sent. */
  async function queuedReminder() {
    slot += 1;
    const patientId = await notes.patient({ phone: mobile(), email: 'respaldo@example.test' });
    await scheduling.inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'online_booking',
        actor: patientActor,
      }),
    );
    const time = `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
    const booked = await notes.book(patientId, 60 + Math.floor(slot / 8), time);
    return notes.queue({
      kind: 'reminder',
      channel: 'whatsapp',
      patientId,
      appointmentId: booked.id,
      professionalId: scheduling.doctor.professionalId,
      plannedStartsAt: new Date(booked.startsAt),
      appointmentVersion: booked.version,
      dedupeKey: `race:${booked.id}:whatsapp`,
    });
  }

  it('lets exactly one of two messages prepared at the same moment take the last place of the quota', async () => {
    notes.setNow(new Date('2032-03-02T12:00:00.000Z'));
    notes.deps.quota = quotaOf(1, false);
    const first = await queuedReminder();
    const second = await queuedReminder();

    const prepared = await Promise.all([
      prepareDelivery(notes.deps, scheduling.tenant.id, first),
      prepareDelivery(notes.deps, scheduling.tenant.id, second),
    ]);

    expect(prepared.map((entry) => entry.kind).sort()).toEqual(['send', 'settled']);
    const rows = await Promise.all([notes.message(first), notes.message(second)]);
    expect(rows.map((row) => row.cancelReason).sort()).toEqual([null, 'quota_exhausted']);
    expect(await usageOf(scheduling.doctor.professionalId)).toBe(1);
  });

  it('gives the place back when the provider refuses the message', async () => {
    notes.setNow(new Date('2032-04-06T12:00:00.000Z'));
    notes.deps.quota = quotaOf(1, false);
    const refused = await whatsappReminder({ phone: '+99910012001' });
    expect(await notes.message(refused.id)).toMatchObject({ status: 'failed' });
    expect(await usageOf(scheduling.doctor.professionalId)).toBe(0);

    const next = await whatsappReminder();

    expect(await notes.message(next.id)).toMatchObject({ status: 'sent', channel: 'whatsapp' });
    expect(await usageOf(scheduling.doctor.professionalId)).toBe(1);
  });

  it('counts a message accepted in the last night of the month in that month, in the zone of the organization', async () => {
    // 22:00 of 31 May in Buenos Aires is 01:00 UTC of 1 June (quiet hours, so the delivery itself
    // would wait for the morning: the acceptance is processed directly).
    const accepted = new Date('2032-06-01T01:00:00.000Z');
    const id = await queuedReminder();

    await scheduling.inTenant((tx) =>
      recordWhatsappUsage({ quota: UNLIMITED_QUOTA, channels: notes.deps.channels }, tx, {
        messageId: id,
        professionalId: scheduling.doctor.professionalId,
        now: accepted,
        tenant: { id: scheduling.tenant.id, isDemo: false },
      }),
    );

    const [event] = await scheduling.inTenant((tx) =>
      tx.select().from(whatsappUsageEvent).where(eq(whatsappUsageEvent.messageId, id)),
    );
    expect(event?.period).toBe('2032-05');
    const report = await scheduling.inTenant((tx) =>
      usageReport(tx, UNLIMITED_QUOTA, new Date('2032-06-01T01:00:00.000Z')),
    );
    expect(report.period).toBe('2032-05');
  });
});

describe('the usage report', () => {
  it('lists every active professional with the count and the state of the quota', async () => {
    const report = await scheduling.inTenant((tx) =>
      usageReport(tx, quotaOfFor(scheduling.doctor.professionalId, 10_000), notes.now()),
    );

    const doctor = report.professionals.find(
      (entry) => entry.professionalId === scheduling.doctor.professionalId,
    );
    const colleague = report.professionals.find(
      (entry) => entry.professionalId === scheduling.colleague.professionalId,
    );
    expect(report.period).toBe('2031-05');
    expect(doctor).toMatchObject({ limit: 10_000, state: 'ok' });
    expect(doctor?.count).toBeGreaterThan(0);
    expect(colleague).toMatchObject({ count: 0, limit: null, state: 'unlimited' });
  });

  it('reads as exhausted when the count reaches the quota and as ok well below it', async () => {
    const count = await usageOf(scheduling.doctor.professionalId);
    const spent = await scheduling.inTenant((tx) =>
      usageReport(tx, quotaOfFor(scheduling.doctor.professionalId, count), notes.now()),
    );
    const roomy = await scheduling.inTenant((tx) =>
      usageReport(tx, quotaOfFor(scheduling.doctor.professionalId, count + 1_000), notes.now()),
    );

    expect(count).toBeGreaterThan(0);
    expect(
      spent.professionals.find((entry) => entry.professionalId === scheduling.doctor.professionalId)
        ?.state,
    ).toBe('exhausted');
    expect(
      roomy.professionals.find((entry) => entry.professionalId === scheduling.doctor.professionalId)
        ?.state,
    ).toBe('ok');
  });

  it('is shown to administration and not to reception', async () => {
    const admin = await scheduling.api.get('/notifications/usage', scheduling.admin);
    const reception = await scheduling.api.get('/notifications/usage', scheduling.reception);

    expect(admin.statusCode, admin.body).toBe(200);
    const body = admin.json<UsageResponse>();
    expect(body.professionals.map((entry) => entry.professionalId)).toEqual(
      expect.arrayContaining([
        scheduling.doctor.professionalId,
        scheduling.colleague.professionalId,
      ]),
    );
    expect(reception.statusCode).toBe(403);
  });

  it('shows counts only: no patient, no number, no text', async () => {
    const admin = await scheduling.api.get('/notifications/usage', scheduling.admin);

    expect(admin.body).not.toContain('respaldo@example.test');
    expect(admin.body).not.toMatch(/\+549|recordamos/);
  });
});

function quotaOfFor(professionalId: string, limit: number): QuotaPolicy {
  return {
    limitFor: (_tx, id) =>
      Promise.resolve(
        id === professionalId
          ? { limit, overageAllowed: true }
          : { limit: null, overageAllowed: true },
      ),
  };
}

describe('a place of the quota is given back when the message never goes (JD-S3 R2-C2, A5)', () => {
  const quotaOf = (limit: number): QuotaPolicy => ({
    limitFor: () => Promise.resolve({ limit, overageAllowed: false }),
  });
  // Each test lives in a month of its own, so the places one holds never reach another.
  let month = 0;
  let period = '';

  /** A WhatsApp reminder that was prepared (so it holds a place) and is still queued. */
  async function reserved() {
    slot += 1;
    const patientId = await notes.patient({ phone: mobile(), email: 'respaldo@example.test' });
    await scheduling.inTenant((tx) =>
      recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'online_booking',
        actor: patientActor,
      }),
    );
    const time = `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
    const booked = await notes.book(patientId, 120 + Math.floor(slot / 8), time);
    const id = await notes.queue({
      kind: 'reminder',
      channel: 'whatsapp',
      patientId,
      appointmentId: booked.id,
      professionalId: scheduling.doctor.professionalId,
      plannedStartsAt: new Date(booked.startsAt),
      appointmentVersion: booked.version,
      dedupeKey: `release:${booked.id}:whatsapp`,
    });
    const prepared = await prepareDelivery(notes.deps, scheduling.tenant.id, id);
    expect(prepared.kind).toBe('send');
    return { id, patientId, appointment: booked };
  }

  const held = () =>
    scheduling.inTenant((tx) => usageCount(tx, scheduling.doctor.professionalId, period));

  beforeEach(() => {
    month += 1;
    period = `2033-${String(month).padStart(2, '0')}`;
    notes.setNow(new Date(`${period}-03T12:00:00.000Z`));
    notes.deps.quota = quotaOf(1);
  });

  const expectPlaceFree = async () => {
    expect(await held()).toBe(0);
    const next = await reserved();
    expect(await held()).toBe(1);
    expect(next.id).toBeTruthy();
  };

  it('keeps the place of a retried message instead of sending it by email (A5)', async () => {
    const first = await reserved();
    expect(await held()).toBe(1);

    // The provider was down, the job runs again: the message counts its own place only once.
    const again = await prepareDelivery(notes.deps, scheduling.tenant.id, first.id);

    expect(again.kind).toBe('send');
    expect(await notes.message(first.id)).toMatchObject({ status: 'queued', channel: 'whatsapp' });
    expect(await held()).toBe(1);
  });

  it('gives it back when the appointment is cancelled', async () => {
    const r = await reserved();
    const planner = createReminderPlanner({
      jobs: notes.jobs,
      clock: () => notes.now(),
      worklist: notes.deps.worklist,
      whatsappAvailable: () => true,
    });

    await scheduling.inTenant((tx) =>
      planner.handle(tx, {
        kind: 'cancelled',
        tenantId: scheduling.tenant.id,
        appointment: {
          appointmentId: r.appointment.id,
          patientId: r.patientId,
          professionalId: scheduling.doctor.professionalId,
          locationId: scheduling.centro,
          appointmentTypeId: scheduling.consulta,
          startsAt: new Date(r.appointment.startsAt),
          endsAt: new Date(new Date(r.appointment.startsAt).getTime() + 1_800_000),
          status: 'cancelled',
          source: 'staff',
          version: r.appointment.version + 1,
        },
        fromStatus: 'scheduled',
        cancelledBy: 'patient',
      }),
    );

    expect(await notes.message(r.id)).toMatchObject({ status: 'cancelled' });
    await expectPlaceFree();
  });

  it('gives it back when the patient opts out of WhatsApp', async () => {
    const r = await reserved();

    await scheduling.inTenant((tx) =>
      recordOptOut(tx, {
        patientId: r.patientId,
        channel: 'whatsapp',
        source: 'email_link',
        actor: patientActor,
      }),
    );

    expect(await notes.message(r.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
    await expectPlaceFree();
  });

  it('gives it back when the sweep closes a message left behind', async () => {
    const r = await reserved();
    notes.setNow(new Date(`${period}-03T16:00:00.000Z`));

    await runJob(runtime.db, createReminderSweepJob({ ...notes.deps }), {
      id: crypto.randomUUID(),
      name: 'reminder.sweep',
      data: { tenantId: scheduling.tenant.id },
      enqueuedAt: notes.now(),
      retryCount: 0,
    });

    expect(await notes.message(r.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'tenant_read_only',
    });
    await expectPlaceFree();
  });

  it('gives it back when the provider reports the message failed', async () => {
    const r = await reserved();

    await scheduling.inTenant((tx) => failAcceptedMessage(notes.deps, tx, r.id, 'delivery_failed'));

    expect(await notes.message(r.id)).toMatchObject({ status: 'failed' });
    await expectPlaceFree();
  });
});
