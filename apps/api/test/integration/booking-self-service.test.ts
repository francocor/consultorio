import type {
  Problem,
  PublicAvailabilityResponse,
  PublicConfirmationDto,
  PublicHoldDto,
  PublicManageDto,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
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
    slug: 'booking-self-service',
    app: { appointmentEvents },
  });
  links = await world.openLinks();
  const settings = await world.api.patch('/settings', world.owner, {
    onlineBooking: { horizonDays: 365 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

let week = 0;

interface Booked {
  visitor: Visitor;
  hold: PublicHoldDto;
  form: ReturnType<BookingWorld['form']>;
  confirmation: PublicConfirmationDto;
  token: string;
  appointmentId: string;
}

/** A booking made through the whole public flow, with the link the patient got. */
async function booked(time = '10:00'): Promise<Booked> {
  world.setNow(EARLY);
  week += 1;
  const visitor = world.visitor();
  const hold = await world.hold(visitor, links, { weeksAfter: week, time });
  const form = world.form();
  await visitor.post(`/public/${links.organization.slug}/booking/holds/${hold.id}/submission`, {
    ...form,
    challengeProof: await visitor.solve(),
  });
  await world.runJobs();
  const response = await visitor.post(
    `/public/${links.organization.slug}/booking/holds/${hold.id}/confirm`,
    { code: world.codeSentTo(form.email) },
  );
  expect(response.statusCode, response.body).toBe(200);
  await world.app.background.idle();
  const confirmation = response.json<PublicConfirmationDto>();
  const token = confirmation.managePath?.split('/').at(-1) ?? '';
  const [row] = await world.inTenant((tx) =>
    tx.select({ id: slotHold.appointmentId }).from(slotHold).where(eq(slotHold.id, hold.id)),
  );
  return { visitor, hold, form, confirmation, token, appointmentId: row?.id ?? '' };
}

const stored = async (id: string) => {
  const [row] = await world.inTenant((tx) =>
    tx.select().from(appointment).where(eq(appointment.id, id)),
  );
  return row;
};
const viewUrl = (token: string) => `/public/t/${token}/appointment`;
const slotsUrl = (token: string, from: string, to = from) =>
  `/public/t/${token}/slots?from=${from}&to=${to}`;
const reschedule = (who: Visitor, token: string, startsAt: string) =>
  who.post(`/public/t/${token}/reschedule`, { startsAt });
const cancel = (who: Visitor, token: string) => who.post(`/public/t/${token}/cancel`, {});

describe('the link of a booking', () => {
  it('shows when, where and with whom, and whether it can still change, and nothing of the patient', async () => {
    const mine = await booked();
    const stranger = world.visitor();

    const response = await stranger.get(viewUrl(mine.token));

    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<PublicManageDto>();
    expect(page).toMatchObject({
      appointment: {
        status: 'scheduled',
        startsAt: mine.hold.startsAt,
        endsAt: mine.hold.endsAt,
        locationName: 'Centro',
        typeName: 'Consulta',
      },
      canChange: true,
      // 12 hours before the start, the default deadline.
      changeDeadline: new Date(Date.parse(mine.hold.startsAt) - 12 * 3_600_000).toISOString(),
    });
    expect(response.body).not.toContain(mine.form.familyName);
    expect(response.body).not.toContain(mine.form.email);
  });

  it('answers a guessed, a malformed and a used link in exactly the same way', async () => {
    const mine = await booked();
    await cancel(mine.visitor, mine.token);
    const visitor = world.visitor();

    const answers = await Promise.all(
      [mine.token, 'x'.repeat(43), 'short', 'A'.repeat(43)].map((token) =>
        visitor.get(viewUrl(token)),
      ),
    );

    for (const answer of answers) {
      expect(answer.statusCode).toBe(404);
      expect({ ...answer.json<Problem>(), requestId: undefined }).toEqual({
        ...answers[0]?.json<Problem>(),
        requestId: undefined,
      });
    }
  });
});

describe('cancelling by the link', () => {
  it('cancels as the patient, frees the slot for the waitlist and the public, and ends the link', async () => {
    const mine = await booked();
    events.length = 0;

    const response = await cancel(world.visitor(), mine.token);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PublicManageDto>().appointment.status).toBe('cancelled');
    expect(await stored(mine.appointmentId)).toMatchObject({
      status: 'cancelled',
      cancelledByKind: 'patient',
    });
    // Scheduling tells the waitlist: a cancellation frees the slot.
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['cancelled', 'slot_freed']),
    );
    const audited = await world.inTenant((tx) =>
      tx
        .select({ action: auditEvent.action })
        .from(auditEvent)
        .where(eq(auditEvent.resourceId, mine.appointmentId)),
    );
    expect(audited.map((row) => row.action)).toContain('appointment.cancelled');
    // The slot is bookable again, and the link does nothing any more.
    const other = world.visitor();
    const free = await other.post(`/public/${links.organization.slug}/booking/holds`, {
      professional: links.professional.slug,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      startsAt: mine.hold.startsAt,
      challengeProof: await other.solve(),
    });
    expect(free.statusCode, free.body).toBe(201);
    expect((await world.visitor().get(viewUrl(mine.token))).statusCode).toBe(404);
    expect((await cancel(world.visitor(), mine.token)).statusCode).toBe(404);
  });

  it('tells the patient to contact the organization after the deadline, and changes nothing', async () => {
    const mine = await booked();
    world.setNow(new Date(Date.parse(mine.hold.startsAt) - 5 * 3_600_000));

    const view = await world.visitor().get(viewUrl(mine.token));
    const response = await cancel(world.visitor(), mine.token);

    expect(view.json<PublicManageDto>().canChange).toBe(false);
    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('booking_change_deadline_passed');
    expect((await stored(mine.appointmentId))?.status).toBe('scheduled');
    // The link is still good: it can still say so.
    expect((await world.visitor().get(viewUrl(mine.token))).statusCode).toBe(200);
    world.setNow(EARLY);
  });

  it('works while the organization is read-only, because it protects the patient', async () => {
    const mine = await booked();
    await world.inTenant((tx) =>
      tx.update(tenant).set({ status: 'read_only', readOnlySince: new Date() }),
    );
    try {
      const view = await world.visitor().get(viewUrl(mine.token));
      const response = await cancel(world.visitor(), mine.token);

      expect(view.statusCode).toBe(200);
      expect(response.statusCode, response.body).toBe(200);
      expect((await stored(mine.appointmentId))?.status).toBe('cancelled');
    } finally {
      await world.inTenant((tx) =>
        tx.update(tenant).set({ status: 'active', readOnlySince: null }),
      );
    }
  });

  it('shows an appointment that staff cancelled as cancelled, and cannot cancel it again', async () => {
    const mine = await booked();
    const cancelled = await world.act({ id: mine.appointmentId }, 'cancel', world.owner, {
      cancelledBy: 'organization',
      reasonCode: 'organization_closed',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const view = await world.visitor().get(viewUrl(mine.token));
    const again = await cancel(world.visitor(), mine.token);

    expect(view.json<PublicManageDto>()).toMatchObject({
      appointment: { status: 'cancelled' },
      canChange: false,
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('moving by the link', () => {
  const later = (booking: Booked, minutes: number) =>
    new Date(Date.parse(booking.hold.startsAt) + minutes * 60_000).toISOString();

  it('lists the free times of the same professional, type and place, never the current one', async () => {
    const mine = await booked();
    const date = world.monday(week);

    const response = await world.visitor().get(slotsUrl(mine.token, date));

    expect(response.statusCode, response.body).toBe(200);
    const slots = response.json<PublicAvailabilityResponse>().slots;
    expect(slots.length).toBeGreaterThan(5);
    expect(slots.map((slot) => slot.startsAt)).not.toContain(mine.hold.startsAt);
    expect(slots.every((slot) => slot.locationId === world.centro)).toBe(true);
  });

  it('moves to a free time, frees the old one only now, and replaces the link', async () => {
    const mine = await booked();
    events.length = 0;
    world.email.clear();
    const target = later(mine, 120);

    const response = await reschedule(world.visitor(), mine.token, target);

    expect(response.statusCode, response.body).toBe(200);
    const confirmation = response.json<PublicConfirmationDto>();
    expect(confirmation).toMatchObject({ status: 'scheduled', startsAt: target });
    expect(confirmation.managePath).toMatch(/^\/book\/manage\//);
    expect(confirmation.managePath).not.toContain(mine.token);
    const moved = await stored(mine.appointmentId);
    expect(moved?.startsAt.toISOString()).toBe(target);
    expect(moved?.version).toBeGreaterThan(1);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['rescheduled', 'slot_freed']),
    );
    // The old time is bookable by somebody else; the old link is dead; the new one works.
    expect((await world.visitor().get(viewUrl(mine.token))).statusCode).toBe(404);
    const newToken = confirmation.managePath?.split('/').at(-1) ?? '';
    expect((await world.visitor().get(viewUrl(newToken))).statusCode).toBe(200);
    // The patient is told the new time, at the address they verified.
    expect(world.email.sent.map((message) => message.to)).toEqual([mine.form.email]);
  });

  it('keeps the original when the new time was taken meanwhile, and the link keeps working', async () => {
    const mine = await booked();
    const target = later(mine, 60);
    const rival = world.visitor();
    const taken = await rival.post(`/public/${links.organization.slug}/booking/holds`, {
      professional: links.professional.slug,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      startsAt: target,
      challengeProof: await rival.solve(),
    });
    expect(taken.statusCode, taken.body).toBe(201);

    const response = await reschedule(world.visitor(), mine.token, target);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('slot_taken');
    expect((await stored(mine.appointmentId))?.startsAt.toISOString()).toBe(mine.hold.startsAt);
    expect((await world.visitor().get(viewUrl(mine.token))).statusCode).toBe(200);
  });

  it('applies the rules of a new booking: not too soon, not outside the working hours', async () => {
    const mine = await booked();
    const night = new Date(Date.parse(mine.hold.startsAt) - 7 * 3_600_000).toISOString();

    const outside = await reschedule(world.visitor(), mine.token, night);
    world.setNow(new Date(Date.parse(mine.hold.startsAt) - 13 * 3_600_000));
    const tooSoon = await reschedule(
      world.visitor(),
      mine.token,
      new Date(Date.parse(mine.hold.startsAt) - 12 * 3_600_000).toISOString(),
    );
    world.setNow(EARLY);

    for (const response of [outside, tooSoon]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<Problem>().code).toBe('slot_no_longer_available');
    }
    expect((await stored(mine.appointmentId))?.startsAt.toISOString()).toBe(mine.hold.startsAt);
  });

  it('is refused after the deadline, with the contact-us answer', async () => {
    const mine = await booked();
    world.setNow(new Date(Date.parse(mine.hold.startsAt) - 5 * 3_600_000));

    const response = await reschedule(world.visitor(), mine.token, later(mine, 60));
    world.setNow(EARLY);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('booking_change_deadline_passed');
  });

  it('is refused while the organization is read-only, but the patient can still cancel', async () => {
    const mine = await booked();
    await world.inTenant((tx) =>
      tx.update(tenant).set({ status: 'read_only', readOnlySince: new Date() }),
    );
    try {
      const response = await reschedule(world.visitor(), mine.token, later(mine, 60));

      expect(response.statusCode).toBe(402);
      expect(response.json<Problem>().code).toBe('tenant_read_only');
      expect((await stored(mine.appointmentId))?.startsAt.toISOString()).toBe(mine.hold.startsAt);
    } finally {
      await world.inTenant((tx) =>
        tx.update(tenant).set({ status: 'active', readOnlySince: null }),
      );
    }
  });

  it('keeps the status: a booking that waits for approval still waits after the move', async () => {
    await world.api.patch('/settings', world.owner, { onlineBooking: { requireApproval: true } });
    try {
      const mine = await booked();

      const response = await reschedule(world.visitor(), mine.token, later(mine, 90));

      expect(response.json<PublicConfirmationDto>().status).toBe('pending_approval');
      expect((await stored(mine.appointmentId))?.status).toBe('pending_approval');
    } finally {
      await world.api.patch('/settings', world.owner, {
        onlineBooking: { requireApproval: false },
      });
    }
  });
});
