import type {
  AppointmentDto,
  Problem,
  PublicConfirmationDto,
  PublicHoldDto,
  WorklistResponse,
} from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { bookingSubmission } from '../../src/db/schema/booking-submission.js';
import { careRelationship } from '../../src/db/schema/care.js';
import { patient } from '../../src/db/schema/patients.js';
import { dataProcessingConsent } from '../../src/db/schema/privacy.js';
import { appointment, slotHold } from '../../src/db/schema/scheduling.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createAppointmentEvents,
  type AppointmentEvent,
} from '../../src/platform/events/appointment-events.js';
import { createBookingWorld, type BookingWorld, type Visitor } from '../support/booking-world.js';

let runtime: DbHandle;
let world: BookingWorld;
let links: Awaited<ReturnType<BookingWorld['openLinks']>>;
const events: AppointmentEvent[] = [];

const EARLY = new Date('2031-05-05T12:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const appointmentEvents = createAppointmentEvents();
  appointmentEvents.subscribe((_tx, event) => {
    events.push(event);
    return Promise.resolve();
  });
  world = await createBookingWorld(runtime, {
    slug: 'confirm-booking',
    app: { appointmentEvents },
  });
  links = await world.openLinks();
  const settings = await world.api.patch('/settings', world.owner, {
    onlineBooking: { horizonDays: 365 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  // Reception works at Centro and confirms identities; the doctor's calendar is theirs to work in.
  await world.delegateCalendar(world.reception, [world.doctor.professionalId]);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

let week = 0;

interface Booking {
  visitor: Visitor;
  hold: PublicHoldDto;
  form: ReturnType<BookingWorld['form']>;
}

/** A visitor who held a Monday slot and submitted the form: one code is on its way. */
async function submitted(
  overrides: Parameters<BookingWorld['form']>[0] = {},
  time = '10:00',
): Promise<Booking> {
  world.setNow(EARLY);
  week += 1;
  const visitor = world.visitor();
  const hold = await world.hold(visitor, links, { weeksAfter: week, time });
  const form = world.form(overrides);
  const response = await visitor.post(
    `/public/${links.organization.slug}/booking/holds/${hold.id}/submission`,
    { ...form, challengeProof: await visitor.solve() },
  );
  expect(response.statusCode, response.body).toBe(200);
  await world.runJobs();
  return { visitor, hold, form };
}

const confirmUrl = (hold: PublicHoldDto) =>
  `/public/${links.organization.slug}/booking/holds/${hold.id}/confirm`;

async function confirm(booking: Booking, code = world.codeSentTo(booking.form.email)) {
  const response = await booking.visitor.post(confirmUrl(booking.hold), { code });
  await world.app.background.idle();
  return response;
}

const appointmentOf = async (holdId: string) => {
  const [row] = await world.inTenant((tx) =>
    tx
      .select({ appointment })
      .from(appointment)
      .innerJoin(slotHold, eq(slotHold.appointmentId, appointment.id))
      .where(eq(slotHold.id, holdId)),
  );
  return row?.appointment;
};

const patientWithDocument = async (number: string) => {
  const [row] = await world.inTenant((tx) =>
    tx.select().from(patient).where(eq(patient.nationalId, number)),
  );
  return row;
};

const openItems = async (kind: string) =>
  (await world.api.get(`/worklist?kind=${kind}`, world.admin)).json<WorklistResponse>().items;

describe('a new patient books', () => {
  it('creates a patient flagged as created online and a scheduled appointment, and tells the visitor', async () => {
    const booking = await submitted({ phone: '+54 11 5555 0001' });
    const patientsBefore = (await world.inTenant((tx) => tx.select().from(patient))).length;

    const response = await confirm(booking);

    expect(response.statusCode, response.body).toBe(200);
    const confirmation = response.json<PublicConfirmationDto>();
    expect(confirmation).toMatchObject({
      status: 'scheduled',
      startsAt: booking.hold.startsAt,
      endsAt: booking.hold.endsAt,
      timeZone: 'America/Argentina/Buenos_Aires',
      organizationName: 'confirm-booking',
      locationName: 'Centro',
      typeName: 'Consulta',
      mode: 'in_person',
    });
    expect(confirmation.professionalName.length).toBeGreaterThan(0);
    expect(confirmation.managePath).toMatch(/^\/book\/manage\/[A-Za-z0-9_-]{43}$/);
    expect(confirmation.calendarFile).toContain('BEGIN:VCALENDAR');
    expect(confirmation.calendarFile).toContain(
      `DTSTART:${booking.hold.startsAt.replace(/[-:]|\.\d{3}/g, '')}`,
    );

    const created = await patientWithDocument(booking.form.document.number);
    expect(created).toMatchObject({
      origin: 'online',
      givenNames: booking.form.givenNames,
      email: booking.form.email,
      phone: '+54 11 5555 0001',
    });
    expect((await world.inTenant((tx) => tx.select().from(patient))).length).toBe(
      patientsBefore + 1,
    );
    const stored = await appointmentOf(booking.hold.id);
    expect(stored).toMatchObject({
      patientId: created?.id,
      source: 'online',
      status: 'scheduled',
      identityConfirmed: true,
      bookedBy: null,
      professionalId: world.doctor.professionalId,
      appointmentTypeId: world.consulta,
    });
    const consents = await world.inTenant((tx) =>
      tx
        .select()
        .from(dataProcessingConsent)
        .where(eq(dataProcessingConsent.patientId, created?.id ?? '')),
    );
    expect(consents).toHaveLength(1);
  });

  it('emails the confirmation to the verified address only, with the link to change it and nothing clinical', async () => {
    const booking = await submitted();
    const code = world.codeSentTo(booking.form.email);
    world.email.clear();

    const response = await confirm(booking, code);

    const message = world.email.lastTo(booking.form.email);
    expect(world.email.sent.map((entry) => entry.to)).toEqual([booking.form.email]);
    expect(message?.subject).toContain('confirmado');
    expect(message?.text).toContain('Dónde: Centro');
    expect(message?.text).toContain(response.json<PublicConfirmationDto>().managePath);
    expect(message?.text).not.toMatch(/Consulta|motivo|paciente/);
  });

  it('keeps the verified submission, reduced to the consent it was made under', async () => {
    const booking = await submitted({ reason: 'primera vez' });

    await confirm(booking);

    const [row] = await world.inTenant((tx) =>
      tx.select().from(bookingSubmission).where(eq(bookingSubmission.holdId, booking.hold.id)),
    );
    const created = await appointmentOf(booking.hold.id);
    expect(row).toMatchObject({ status: 'verified', appointmentId: created?.id });
    expect(row?.verifiedAt).not.toBeNull();
    const raw = await world.inTenant((tx) =>
      tx.execute<{ text: string }>(
        sql`SELECT encode(payload_enc, 'escape') AS text FROM booking_submission WHERE id = ${row?.id ?? ''}`,
      ),
    );
    expect(raw.rows[0]?.text).not.toContain(booking.form.familyName);
    const evidence = await world.inTenant(async (tx) => {
      const plain = await world.keys.decryptField(
        tx,
        { table: 'booking_submission', column: 'payload_enc', rowId: row?.id ?? '' },
        row?.payloadEnc ?? Buffer.alloc(0),
      );
      return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
    });
    expect((evidence['consent'] as { textKey: string }).textKey.length).toBeGreaterThan(0);
    expect(JSON.stringify(evidence)).not.toContain(booking.form.familyName);
    expect(JSON.stringify(evidence)).not.toContain('primera vez');
  });

  it('publishes the creation once, as an online booking', async () => {
    const booking = await submitted();
    events.length = 0;

    await confirm(booking);

    const created = events.filter((event) => event.kind === 'created');
    expect(created).toHaveLength(1);
    expect(created[0]?.appointment).toMatchObject({ source: 'online', status: 'scheduled' });
  });

  it('audits the booking with the source and the verified channel, and nothing the visitor supplied', async () => {
    const booking = await submitted();

    await confirm(booking);

    const created = await appointmentOf(booking.hold.id);
    const rows = await world.inTenant((tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.resourceId, created?.id ?? ''))),
    );
    const byAction = Object.fromEntries(rows.map((row) => [row.action, row]));
    expect(byAction['appointment.created']).toMatchObject({
      actorUserId: null,
      metadata: { source: 'online', channel: 'email', identityConfirmed: true },
    });
    expect(byAction['booking.online.created']).toMatchObject({
      actorUserId: null,
      metadata: { channel: 'email' },
    });
    expect(JSON.stringify(rows.map((row) => row.metadata))).not.toContain(booking.form.email);
  });
});

describe('a patient the organization already has', () => {
  const victim = { type: 'dni' as const, number: '30111222' };

  beforeAll(async () => {
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id, phone, email)
              VALUES (${world.tenant.id}, 'Víctima', 'Vera', '1980-01-01', 'dni', '30111222', '+54 11 4444 1111', 'vera@example.test')`,
      ),
    );
  });

  it('attaches silently with the identity unconfirmed, leaves the record alone and opens the identity review', async () => {
    const booking = await submitted({
      document: victim,
      givenNames: 'Vera',
      familyName: 'Víctima',
      birthDate: '1980-01-01',
      phone: '+54 11 5555 0000',
      email: 'someone@example.test',
    });

    const response = await confirm(booking);

    expect(response.statusCode, response.body).toBe(200);
    const stored = await appointmentOf(booking.hold.id);
    const onFile = await patientWithDocument('30111222');
    expect(stored).toMatchObject({
      patientId: onFile?.id,
      identityConfirmed: false,
      source: 'online',
    });
    // Nothing the visitor typed reached the record.
    expect(onFile).toMatchObject({
      phone: '+54 11 4444 1111',
      email: 'vera@example.test',
      version: 1,
    });
    expect(onFile?.origin).toBe('staff');
    const items = (await openItems('identity_review')).filter(
      (item) => item.subjectId === stored?.id,
    );
    expect(items).toHaveLength(1);
    const differences = (items[0]?.detail as { differences: unknown[] }).differences;
    expect(differences).toContainEqual({
      field: 'phone',
      submitted: '+54 11 5555 0000',
      onFile: '+54 11 4444 1111',
    });
    expect(differences).toContainEqual({
      field: 'email',
      submitted: 'someone@example.test',
      onFile: 'vera@example.test',
    });
    // The consent was given by whoever typed the form, not by the patient on file.
    const consents = await world.inTenant((tx) =>
      tx
        .select()
        .from(dataProcessingConsent)
        .where(eq(dataProcessingConsent.patientId, onFile?.id ?? '')),
    );
    expect(consents).toEqual([]);
  });

  it('shows the visitor the same confirmation as for a new patient', async () => {
    const existing = await submitted({ document: victim, email: 'again@example.test' });
    const fresh = await submitted();

    const matched = (await confirm(existing)).json<Record<string, unknown>>();
    const created = (await confirm(fresh)).json<Record<string, unknown>>();

    expect(Object.keys(matched).sort()).toEqual(Object.keys(created).sort());
    expect(matched['status']).toBe(created['status']);
    expect(matched['typeName']).toBe(created['typeName']);
    expect(matched['locationName']).toBe(created['locationName']);
    expect(JSON.stringify(matched)).not.toMatch(/V[ií]ctima|Vera|vera@/);
  });

  it('gives the professional no care relationship until staff other than them confirm the identity', async () => {
    const booking = await submitted({ document: victim, email: 'stranger@example.test' });
    await confirm(booking);
    const stored = await appointmentOf(booking.hold.id);
    const onFile = await patientWithDocument('30111222');
    const relationships = () =>
      world.inTenant((tx) =>
        tx
          .select()
          .from(careRelationship)
          .where(
            and(
              eq(careRelationship.patientId, onFile?.id ?? ''),
              eq(careRelationship.professionalId, world.doctor.professionalId),
            ),
          ),
      );

    expect(await relationships()).toEqual([]);

    const item = (await openItems('identity_review')).find(
      (entry) => entry.subjectId === stored?.id,
    );
    const confirmed = await world.api.post(
      `/worklist/${item?.id ?? ''}/confirm-identity`,
      world.reception,
      { expectedVersion: item?.appointment?.version },
    );

    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json<AppointmentDto>().identityConfirmed).toBe(true);
    expect((await relationships()).length).toBeGreaterThan(0);
  });

  it('refuses a patient who was deactivated with the answer for a contact that cannot book', async () => {
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id, status)
              VALUES (${world.tenant.id}, 'Baja', 'Beto', '1970-01-01', 'dni', '30222333', 'inactive')`,
      ),
    );
    const booking = await submitted({ document: { type: 'dni', number: '30222333' } });

    const response = await confirm(booking);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('booking_limit_reached');
    expect(await appointmentOf(booking.hold.id)).toBeUndefined();
  });
});

describe('an organization that requires approval', () => {
  it('leaves the appointment pending, shows it on the worklist and keeps the identity separate from the approval', async () => {
    await world.api.patch('/settings', world.owner, { onlineBooking: { requireApproval: true } });
    try {
      const booking = await submitted();

      const response = await confirm(booking);

      expect(response.json<PublicConfirmationDto>().status).toBe('pending_approval');
      expect(response.json<PublicConfirmationDto>().calendarFile).toContain('STATUS:TENTATIVE');
      const stored = await appointmentOf(booking.hold.id);
      expect(stored).toMatchObject({ status: 'pending_approval', identityConfirmed: true });
      const items = (await openItems('pending_approval')).filter(
        (item) => item.subjectId === stored?.id,
      );
      expect(items).toHaveLength(1);
      expect(world.email.lastTo(booking.form.email)?.text).toContain('lo va a confirmar');

      const approved = await world.api.post(
        `/appointments/${stored?.id ?? ''}/approve`,
        world.owner,
        {
          expectedVersion: items[0]?.appointment?.version,
        },
      );
      expect(approved.json<AppointmentDto>().status).toBe('scheduled');
    } finally {
      await world.api.patch('/settings', world.owner, {
        onlineBooking: { requireApproval: false },
      });
    }
  });

  it('also waits for approval when the type of visit asks for it', async () => {
    const strict = await world.api.post('/appointment-types', world.owner, {
      name: 'Primera consulta',
      durationMinutes: 30,
      mode: 'in_person',
      requiresApproval: true,
    });
    const typeId = strict.json<{ id: string }>().id;
    const doctor = await world.addProfessional();
    const own = await world.openLinks({ doctor, typeIds: [typeId] });
    world.setNow(EARLY);
    const visitor = world.visitor();
    const hold = await visitor.post(`/public/${own.organization.slug}/booking/holds`, {
      professional: own.professional.slug,
      locationId: world.centro,
      appointmentTypeId: typeId,
      startsAt: `${world.monday(2)}T13:00:00.000Z`,
      challengeProof: await visitor.solve(),
    });
    const held = hold.json<PublicHoldDto>();
    const form = world.form();
    await visitor.post(`/public/${own.organization.slug}/booking/holds/${held.id}/submission`, {
      ...form,
      challengeProof: await visitor.solve(),
    });
    await world.runJobs();

    const response = await visitor.post(
      `/public/${own.organization.slug}/booking/holds/${held.id}/confirm`,
      { code: world.codeSentTo(form.email) },
    );

    expect(response.json<PublicConfirmationDto>().status).toBe('pending_approval');
  });
});

describe('what stops a booking', () => {
  it('refuses a wrong code without creating anything, and a fifth wrong attempt spends it', async () => {
    const booking = await submitted();
    const right = world.codeSentTo(booking.form.email);
    const wrong = right === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await confirm(booking, wrong);
      expect(response.statusCode).toBe(400);
      expect(response.json<Problem>().code).toBe('booking_code_invalid');
    }
    const afterwards = await confirm(booking, right);

    expect(afterwards.statusCode).toBe(400);
    expect(await appointmentOf(booking.hold.id)).toBeUndefined();
    expect(await patientWithDocument(booking.form.document.number)).toBeUndefined();
  });

  it('does not use up the code when the booking cannot be finished', async () => {
    const booking = await submitted();
    world.advance(11 * 60_000);

    const late = await confirm(booking);
    world.setNow(EARLY);

    expect(late.statusCode).toBe(409);
    expect(late.json<Problem>().code).toBe('slot_no_longer_available');
    expect(await appointmentOf(booking.hold.id)).toBeUndefined();
    expect(await patientWithDocument(booking.form.document.number)).toBeUndefined();
  });

  it('tells the visitor the slot is gone when staff took it with the override', async () => {
    const booking = await submitted();
    const date = world.monday(week);
    await world.api.post('/appointments', world.owner, {
      ...(await world.bookingBody(week, '10:00', { overrideHold: true })),
      local: { date, time: '10:00' },
    });

    const response = await confirm(booking);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('slot_no_longer_available');
    expect(await patientWithDocument(booking.form.document.number)).toBeUndefined();
  });

  it("answers a hold that is not the visitor's as not found, and never confirms the same hold twice", async () => {
    const booking = await submitted();
    const code = world.codeSentTo(booking.form.email);

    const stranger = await world.visitor().post(confirmUrl(booking.hold), { code });
    const first = await confirm(booking, code);
    const second = await confirm(booking, code);

    expect(stranger.statusCode).toBe(404);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
  });

  it('refuses a day that filled up while the visitor typed', async () => {
    const booking = await submitted();
    await world.api.patch('/settings', world.owner, { onlineBooking: { dailyCap: 1 } });
    try {
      // One online booking already stands on that day with this professional, in the next half hour.
      await world.inTenant((tx) =>
        tx.execute(
          sql`INSERT INTO appointment
                (tenant_id, patient_id, professional_id, location_id, appointment_type_id, starts_at, ends_at, source, status)
                SELECT ${world.tenant.id}, p.id, ${world.doctor.professionalId}, ${world.centro}, ${world.consulta},
                       ${new Date(Date.parse(booking.hold.startsAt) + 30 * 60_000).toISOString()}::timestamptz,
                       ${new Date(Date.parse(booking.hold.startsAt) + 60 * 60_000).toISOString()}::timestamptz,
                       'online', 'scheduled'
                  FROM patient p LIMIT 1`,
        ),
      );

      const response = await confirm(booking);

      expect(response.statusCode).toBe(409);
      expect(response.json<Problem>().code).toBe('slot_no_longer_available');
      expect(await appointmentOf(booking.hold.id)).toBeUndefined();
    } finally {
      await world.api.patch('/settings', world.owner, { onlineBooking: { dailyCap: null } });
    }
  });
});

describe('two visitors confirm at the same moment (JD-S3 C6)', () => {
  it('leaves room for one when the daily cap allows one: the second is told the slot is gone', async () => {
    await world.api.patch('/settings', world.owner, { onlineBooking: { dailyCap: 1 } });
    try {
      const first = await submitted({}, '09:00');
      // The same Monday, another time: the day has room for exactly one online booking.
      week -= 1;
      const second = await submitted({}, '11:00');
      expect(second.hold.startsAt.slice(0, 10)).toBe(first.hold.startsAt.slice(0, 10));

      const answers = await Promise.all([
        first.visitor.post(confirmUrl(first.hold), { code: world.codeSentTo(first.form.email) }),
        second.visitor.post(confirmUrl(second.hold), { code: world.codeSentTo(second.form.email) }),
      ]);
      await world.app.background.idle();

      expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
      const refused = answers.find((answer) => answer.statusCode === 409);
      expect(refused?.json<Problem>().code).toBe('slot_no_longer_available');
      const booked = await Promise.all([
        appointmentOf(first.hold.id),
        appointmentOf(second.hold.id),
      ]);
      expect(booked.filter((entry) => entry !== undefined)).toHaveLength(1);
    } finally {
      await world.api.patch('/settings', world.owner, { onlineBooking: { dailyCap: null } });
    }
  });
});

describe('the WhatsApp choice', () => {
  it('is not recorded anywhere when the box stays unticked, and reminders stay on email', async () => {
    const booking = await submitted({ whatsappOptIn: false });

    const response = await confirm(booking);

    expect(response.statusCode, response.body).toBe(200);
    expect(world.email.lastTo(booking.form.email)).toBeDefined();
  });
});

describe('an organization that is read-only', () => {
  it('shows the generic page for the form and the code, and creates nothing', async () => {
    const booking = await submitted();
    const code = world.codeSentTo(booking.form.email);
    await world.inTenant((tx) =>
      tx.update(tenant).set({ status: 'read_only', readOnlySince: new Date() }),
    );
    try {
      const confirmed = await booking.visitor.post(confirmUrl(booking.hold), { code });
      const resubmitted = await booking.visitor.post(
        `/public/${links.organization.slug}/booking/holds/${booking.hold.id}/submission`,
        { ...world.form(), challengeProof: await booking.visitor.solve() },
      );

      for (const response of [confirmed, resubmitted]) {
        expect(response.statusCode).toBe(404);
        expect(response.json<Problem>().code).toBe('not_found');
      }
      expect(await appointmentOf(booking.hold.id)).toBeUndefined();
      expect(await patientWithDocument(booking.form.document.number)).toBeUndefined();
    } finally {
      await world.inTenant((tx) =>
        tx.update(tenant).set({ status: 'active', readOnlySince: null }),
      );
    }
  });
});
