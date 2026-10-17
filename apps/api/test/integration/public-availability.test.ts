import type {
  AppointmentTypeDto,
  Problem,
  PublicAvailabilityResponse,
  PublicBookingPageDto,
  PublicHoldDto,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { slotHold } from '../../src/db/schema/scheduling.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createAppointmentEvents,
  type AppointmentEvent,
} from '../../src/platform/events/appointment-events.js';
import { createBookingWorld, type BookingWorld } from '../support/booking-world.js';

let runtime: DbHandle;
let world: BookingWorld;
let links: Awaited<ReturnType<BookingWorld['openLinks']>>;
const events: AppointmentEvent[] = [];

/** Monday 2031-05-12 09:00 in Buenos Aires: the first working day of the test calendar. */
const MONDAY_NINE = new Date('2031-05-12T12:00:00.000Z');
/** Before the first Monday, so the lead time never touches the test days. */
const EARLY = new Date('2031-05-05T12:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const appointmentEvents = createAppointmentEvents();
  appointmentEvents.subscribe((_tx, event) => {
    events.push(event);
    return Promise.resolve();
  });
  world = await createBookingWorld(runtime, {
    slug: 'public-avail',
    app: { appointmentEvents },
  });
  links = await world.openLinks();
  // A long horizon, so the test calendar can run weeks ahead; one test checks the edge of it.
  const settings = await world.api.patch('/settings', world.owner, {
    onlineBooking: { horizonDays: 120 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const availabilityUrl = (
  query: Record<string, string>,
  organization = links.organization.slug,
  professional = links.professional.slug,
) => {
  const params = new URLSearchParams({ professional, ...query });
  return `/public/${organization}/booking/availability?${params.toString()}`;
};

/** The slots of the doctor's Monday `weeksAfter` weeks after the first one, for the Consulta type. */
async function slotsOn(weeksAfter: number, visitor = world.visitor()) {
  const date = world.monday(weeksAfter);
  const response = await visitor.get(
    availabilityUrl({ typeId: world.consulta, from: date, to: date }),
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PublicAvailabilityResponse>();
}

const localTimes = (answer: PublicAvailabilityResponse) =>
  answer.slots.map((slot) =>
    new Date(Date.parse(slot.startsAt) - 3 * 3_600_000).toISOString().slice(11, 16),
  );

describe('the organization and professional pages', () => {
  it('lists the professionals whose own link is enabled, with what they offer, and no internal id', async () => {
    world.setNow(EARLY);

    const response = await world.visitor().get(`/public/${links.organization.slug}/booking`);

    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<PublicBookingPageDto>();
    expect(page.scope).toBe('organization');
    expect(page.professionals).toHaveLength(1);
    expect(page.professionals[0]).toMatchObject({
      slug: links.professional.slug,
      types: [{ id: world.consulta, name: 'Consulta', durationMinutes: 30, mode: 'in_person' }],
      locations: [{ id: world.centro, name: 'Centro', timeZone: 'America/Argentina/Buenos_Aires' }],
    });
    expect(page.requiresApproval).toBe(false);
    expect(page.horizonDays).toBe(120);
    // Nothing that identifies a row of the organization other than the type and location to book.
    expect(response.body).not.toContain(world.doctor.professionalId);
    expect(response.body).not.toContain(world.tenant.id);
  });

  it('does not list a professional who has no enabled link, and their slots cannot be asked for', async () => {
    const page = (
      await world.visitor().get(`/public/${links.organization.slug}/booking`)
    ).json<PublicBookingPageDto>();
    expect(page.professionals.map((p) => p.slug)).not.toContain(world.colleague.professionalId);

    // The internal id is not an address, and the colleague has no link to name them by.
    const byId = await world
      .visitor()
      .get(
        availabilityUrl(
          { typeId: world.consulta, from: world.monday(1), to: world.monday(1) },
          links.organization.slug,
          world.colleague.professionalId,
        ),
      );
    expect(byId.statusCode).toBe(404);
  });

  it('shows only that professional on their own page', async () => {
    const response = await world.visitor().get(world.pagePath(links));

    const page = response.json<PublicBookingPageDto>();
    expect(page.scope).toBe('professional');
    expect(page.professionals.map((p) => p.slug)).toEqual([links.professional.slug]);
  });

  it('names the organization the way its branding does', async () => {
    const page = (
      await world.visitor().get(`/public/${links.organization.slug}/booking`)
    ).json<PublicBookingPageDto>();

    expect(page.organizationName).toBe('public-avail');
  });

  it('answers a disabled organization link as an address that never existed, while a professional stays open', async () => {
    await world.api.patch(`/booking-links/${links.organization.id}`, world.owner, {
      enabled: false,
    });
    const visitor = world.visitor();

    const closed = await visitor.get(`/public/${links.organization.slug}/booking`);
    const never = await visitor.get('/public/zzzzzzzzzzzz/booking');
    const open = await visitor.get(world.pagePath(links));

    expect(closed.statusCode).toBe(404);
    expect({ ...closed.json<Problem>(), requestId: undefined }).toEqual({
      ...never.json<Problem>(),
      requestId: undefined,
    });
    expect(open.statusCode).toBe(200);
    await world.api.patch(`/booking-links/${links.organization.id}`, world.owner, {
      enabled: true,
    });
  });

  it('refuses the link of another organization on this host', async () => {
    const other = await createBookingWorld(runtime, { slug: 'public-avail-other' });
    try {
      const foreign = await other.openLinks();

      const response = await world.visitor().get(`/public/${foreign.organization.slug}/booking`);

      expect(response.statusCode).toBe(404);
    } finally {
      await other.close();
    }
  });

  it('says up front that a booking will wait for approval when the organization requires it', async () => {
    await world.api.patch('/settings', world.owner, { onlineBooking: { requireApproval: true } });

    const page = (
      await world.visitor().get(`/public/${links.organization.slug}/booking`)
    ).json<PublicBookingPageDto>();

    expect(page.requiresApproval).toBe(true);
    await world.api.patch('/settings', world.owner, { onlineBooking: { requireApproval: false } });
  });
});

describe('what a visitor may see of the schedule', () => {
  it('offers the free half-hours of the working day, labelled by the zone of the location', async () => {
    world.setNow(EARLY);

    const answer = await slotsOn(1);

    expect(localTimes(answer)).toEqual([
      '09:00',
      '09:15',
      '09:30',
      '09:45',
      '10:00',
      '10:15',
      '10:30',
      '10:45',
      '11:00',
      '11:15',
      '11:30',
      '11:45',
      '12:00',
      '12:15',
      '12:30',
    ]);
    expect(answer.slots.every((slot) => slot.locationId === world.centro)).toBe(true);
    expect(answer.nextAvailable).toBeNull();
    // No reason for an unavailable time: the answer has no closed days, holidays or counts.
    expect(Object.keys(answer).sort()).toEqual(['nextAvailable', 'slots']);
  });

  it('applies the minimum lead time of two hours', async () => {
    world.setNow(MONDAY_NINE);

    const answer = await slotsOn(0);

    expect(localTimes(answer)[0]).toBe('11:00');
    world.setNow(EARLY);
  });

  it('offers nothing beyond the horizon, and points at the next free time inside it', async () => {
    world.setNow(EARLY);
    const far = world.monday(20);

    const response = await world
      .visitor()
      .get(availabilityUrl({ typeId: world.consulta, from: far, to: far }));
    const answer = response.json<PublicAvailabilityResponse>();

    expect(answer.slots).toEqual([]);
    expect(answer.nextAvailable).toBeNull();
  });

  it('suggests the first free time after an empty range', async () => {
    world.setNow(EARLY);
    // A Tuesday: the doctor does not work, so the range is empty and Monday is the next time.
    const tuesday = new Date(Date.parse(`${world.monday(1)}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);

    const answer = (
      await world
        .visitor()
        .get(availabilityUrl({ typeId: world.consulta, from: tuesday, to: tuesday }))
    ).json<PublicAvailabilityResponse>();

    expect(answer.slots).toEqual([]);
    expect(answer.nextAvailable?.date).toBe(world.monday(2));
  });

  it('hides a time once an appointment or a hold takes any part of it', async () => {
    world.setNow(EARLY);
    await world.book(2, '10:00');

    const answer = await slotsOn(2);

    // 09:45 would run into the 10:00 visit; 10:30 is free again.
    expect(localTimes(answer)).not.toEqual(expect.arrayContaining(['09:45', '10:00', '10:15']));
    expect(localTimes(answer)).toEqual(expect.arrayContaining(['09:30', '10:30']));
  });

  it('treats a professional who allows two simultaneous visits as having room for one', async () => {
    world.setNow(EARLY);
    const crowded = await world.addProfessional({ maxSimultaneous: 2 });
    const crowdedLinks = await world.openLinks({ doctor: crowded });
    const date = world.monday(3);
    const booked = await world.api.post('/appointments', world.owner, {
      patientId: await world.freshPatient(),
      professionalId: crowded.professionalId,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      local: { date, time: '10:00' },
    });
    expect(booked.statusCode, booked.body).toBe(201);

    const asStaff = await world.api.get(
      `/availability?professionalId=${crowded.professionalId}&typeId=${world.consulta}&from=${date}&to=${date}`,
      world.owner,
    );
    const asPublic = await world
      .visitor()
      .get(
        availabilityUrl(
          { typeId: world.consulta, from: date, to: date },
          crowdedLinks.organization.slug,
          crowdedLinks.professional.slug,
        ),
      );

    const staffTimes = asStaff
      .json<{ slots: { startsAt: string }[] }>()
      .slots.map((slot) => slot.startsAt);
    const publicTimes = asPublic.json<PublicAvailabilityResponse>().slots.map((s) => s.startsAt);
    expect(staffTimes).toContain(`${date}T13:00:00.000Z`);
    expect(publicTimes).not.toContain(`${date}T13:00:00.000Z`);
  });

  it('closes a day once the daily cap of online bookings is used', async () => {
    world.setNow(EARLY);
    const capped = await world.addProfessional();
    const cappedLinks = await world.openLinks({ doctor: capped });
    const date = world.monday(4);
    await world.api.patch('/settings', world.owner, { onlineBooking: { dailyCap: 1 } });
    const staff = await world.api.post('/appointments', world.owner, {
      patientId: await world.freshPatient(),
      professionalId: capped.professionalId,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      local: { date, time: '09:00' },
    });
    const appointmentId = staff.json<{ id: string }>().id;
    const query = { typeId: world.consulta, from: date, to: date };
    const url = availabilityUrl(
      query,
      cappedLinks.organization.slug,
      cappedLinks.professional.slug,
    );

    // A staff booking does not count against the cap of online bookings.
    expect((await world.visitor().get(url)).json<PublicAvailabilityResponse>().slots.length).toBe(
      13,
    );
    await world.inTenant((tx) =>
      tx.execute(sql`UPDATE appointment SET source = 'online' WHERE id = ${appointmentId}`),
    );
    world.advance(31_000);
    const closed = (await world.visitor().get(url)).json<PublicAvailabilityResponse>();

    expect(closed.slots).toEqual([]);
    await world.api.patch('/settings', world.owner, { onlineBooking: { dailyCap: null } });
  });

  it('shows only the types the link exposes, and refuses the rest like an unknown address', async () => {
    world.setNow(EARLY);
    const date = world.monday(1);

    const hidden = await world
      .visitor()
      .get(availabilityUrl({ typeId: world.withBuffer, from: date, to: date }));
    const unknown = await world.visitor().get(
      availabilityUrl({
        typeId: '0190a000-0000-7000-8000-00000000dead',
        from: date,
        to: date,
      }),
    );

    expect(hidden.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
  });

  it('keeps virtual types out until the organization has a video provider', async () => {
    world.setNow(EARLY);
    const virtual = (
      await world.api.post('/appointment-types', world.owner, {
        name: 'Teleconsulta',
        durationMinutes: 30,
        mode: 'virtual',
      })
    ).json<AppointmentTypeDto>().id;
    const doctor = await world.addProfessional();
    const own = await world.openLinks({ doctor, typeIds: [world.consulta, virtual] });

    const page = (await world.visitor().get(world.pagePath(own))).json<PublicBookingPageDto>();

    expect(page.professionals[0]?.types.map((type) => type.name)).toEqual(['Consulta']);
  });

  it('offers virtual types once the organization has a video provider and its switch on', async () => {
    const withVideo = await createBookingWorld(runtime, {
      slug: 'public-avail-video',
      video: true,
    });
    try {
      const virtual = (
        await withVideo.api.post('/appointment-types', withVideo.owner, {
          name: 'Teleconsulta',
          durationMinutes: 30,
          mode: 'virtual',
        })
      ).json<AppointmentTypeDto>().id;
      const own = await withVideo.openLinks({ typeIds: [withVideo.consulta, virtual] });

      const on = (
        await withVideo.visitor().get(withVideo.pagePath(own))
      ).json<PublicBookingPageDto>();
      await withVideo.api.patch('/settings', withVideo.owner, { integrations: { video: false } });
      const off = (
        await withVideo.visitor().get(withVideo.pagePath(own))
      ).json<PublicBookingPageDto>();

      expect(on.professionals[0]?.types.map((type) => type.mode).sort()).toEqual([
        'in_person',
        'virtual',
      ]);
      expect(off.professionals[0]?.types.map((type) => type.mode)).toEqual(['in_person']);
    } finally {
      await withVideo.close();
    }
  });

  it('ignores a tenant field in the query: the organization comes from the host and the link', async () => {
    world.setNow(EARLY);
    const date = world.monday(1);

    const response = await world
      .visitor()
      .get(
        `${availabilityUrl({ typeId: world.consulta, from: date, to: date })}&tenantId=${world.tenant.id}`,
      );

    expect(response.statusCode).toBe(200);
  });

  it('keeps a range to 31 days', async () => {
    const response = await world
      .visitor()
      .get(availabilityUrl({ typeId: world.consulta, from: world.monday(0), to: world.monday(9) }));

    expect(response.statusCode).toBe(400);
  });

  it('remembers an answer for thirty seconds and no longer', async () => {
    world.setNow(EARLY);
    const first = await slotsOn(5);
    await world.book(5, '09:00');

    const remembered = await slotsOn(5);
    world.advance(31_000);
    const fresh = await slotsOn(5);

    expect(remembered.slots).toHaveLength(first.slots.length);
    expect(fresh.slots.length).toBeLessThan(first.slots.length);
  });

  it('stops answering the moment the link is disabled, whatever is remembered', async () => {
    world.setNow(EARLY);
    const doctor = await world.addProfessional();
    const own = await world.openLinks({ doctor });
    const date = world.monday(1);
    const url = availabilityUrl(
      { typeId: world.consulta, from: date, to: date },
      own.organization.slug,
      own.professional.slug,
    );
    expect((await world.visitor().get(url)).statusCode).toBe(200);

    await world.api.patch(`/booking-links/${own.professional.id}`, world.owner, {
      enabled: false,
    });

    expect((await world.visitor().get(url)).statusCode).toBe(404);
  });
});

describe('a read-only organization', () => {
  it('shows the generic page for the pages, the slots and the holds, and creates nothing', async () => {
    world.setNow(EARLY);
    const visitor = world.visitor();
    const date = world.monday(1);
    const proof = await visitor.solve();
    await world.inTenant((tx) =>
      tx.update(tenant).set({ status: 'read_only', readOnlySince: new Date() }),
    );
    try {
      const page = await visitor.get(`/public/${links.organization.slug}/booking`);
      const professionalPage = await visitor.get(world.pagePath(links));
      const slots = await visitor.get(
        availabilityUrl({ typeId: world.consulta, from: date, to: date }),
      );
      const hold = await visitor.post(`/public/${links.organization.slug}/booking/holds`, {
        professional: links.professional.slug,
        locationId: world.centro,
        appointmentTypeId: world.consulta,
        startsAt: `${date}T13:00:00.000Z`,
        challengeProof: proof,
      });

      for (const response of [page, professionalPage, slots, hold]) {
        expect(response.statusCode).toBe(404);
        expect(response.json<Problem>().code).toBe('not_found');
      }
    } finally {
      await world.inTenant((tx) =>
        tx.update(tenant).set({ status: 'active', readOnlySince: null }),
      );
    }
  });
});

describe('holding a slot', () => {
  const holdBody = async (
    visitor: ReturnType<BookingWorld['visitor']>,
    weeksAfter: number,
    time = '10:00',
    extra: Record<string, unknown> = {},
  ) => ({
    professional: links.professional.slug,
    locationId: world.centro,
    appointmentTypeId: world.consulta,
    // Buenos Aires is UTC-3.
    startsAt: `${world.monday(weeksAfter)}T${String(Number(time.slice(0, 2)) + 3).padStart(2, '0')}:${time.slice(3)}:00.000Z`,
    challengeProof: await visitor.solve(),
    ...extra,
  });
  const holdUrl = () => `/public/${links.organization.slug}/booking/holds`;

  async function hold(
    visitor: ReturnType<BookingWorld['visitor']>,
    weeksAfter: number,
    time = '10:00',
  ) {
    return visitor.post(holdUrl(), await holdBody(visitor, weeksAfter, time));
  }

  it('reserves the slot for ten minutes, answers with no patient or professional data and sets the session cookie', async () => {
    world.setNow(EARLY);
    const visitor = world.visitor();

    const response = await hold(visitor, 6);

    expect(response.statusCode, response.body).toBe(201);
    const held = response.json<PublicHoldDto>();
    expect(held).toMatchObject({
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      startsAt: `${world.monday(6)}T13:00:00.000Z`,
      endsAt: `${world.monday(6)}T13:30:00.000Z`,
      expiresAt: new Date(EARLY.getTime() + 10 * 60_000).toISOString(),
    });
    expect(Object.keys(held).sort()).toEqual([
      'appointmentTypeId',
      'endsAt',
      'expiresAt',
      'id',
      'locationId',
      'startsAt',
    ]);
    expect(String(response.headers['set-cookie'])).toMatch(
      /^__Host-bsid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=\d+$/,
    );
    const [row] = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.id, held.id)),
    );
    expect(row).toMatchObject({ origin: 'public', status: 'active', createdBy: null, lane: 1 });
    // The cookie itself is not stored: the hold carries its hash only.
    expect(row?.sourceKey).toMatch(/^public:[0-9a-f]{64}$/);
    expect(row?.sourceKey).not.toContain(visitor.cookie().split('=')[1] ?? 'x');
  });

  it('lets exactly one of two visitors have the slot and offers the loser other times', async () => {
    world.setNow(EARLY);
    const first = world.visitor();
    const second = world.visitor();

    const winner = await hold(first, 7);
    const loser = await hold(second, 7);

    expect(winner.statusCode, winner.body).toBe(201);
    expect(loser.statusCode).toBe(409);
    const problem = loser.json<Problem & { nextSlots: { startsAt: string; endsAt: string }[] }>();
    expect(problem.code).toBe('slot_taken');
    expect(problem.nextSlots.length).toBeGreaterThan(0);
    // No range of anybody's appointment: only free times, start and end.
    expect(Object.keys(problem)).not.toContain('conflict');
    for (const next of problem.nextSlots)
      expect(Object.keys(next).sort()).toEqual(['endsAt', 'startsAt']);
  });

  it('releases the first slot when the same visitor holds another one', async () => {
    world.setNow(EARLY);
    const visitor = world.visitor();
    const first = (await hold(visitor, 8, '09:00')).json<PublicHoldDto>();

    const second = await hold(visitor, 8, '11:00');

    expect(second.statusCode, second.body).toBe(201);
    const [firstRow] = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.id, first.id)),
    );
    expect(firstRow?.status).toBe('released');
    // The released slot is free for somebody else at once.
    expect((await hold(world.visitor(), 8, '09:00')).statusCode).toBe(201);
  });

  it('frees the slot when the ten minutes pass, and does not tell the waitlist', async () => {
    world.setNow(EARLY);
    const abandoned = (await hold(world.visitor(), 9, '09:00')).json<PublicHoldDto>();
    events.length = 0;

    world.advance(11 * 60_000);
    const another = await hold(world.visitor(), 9, '09:00');

    expect(another.statusCode, another.body).toBe(201);
    const [row] = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.id, abandoned.id)),
    );
    expect(row?.status).toBe('expired');
    expect(events.filter((event) => event.kind === 'slot_freed')).toEqual([]);
    world.setNow(EARLY);
  });

  it('is invalidated by a staff booking with the override, never the other way round', async () => {
    world.setNow(EARLY);
    const held = (await hold(world.visitor(), 10, '09:00')).json<PublicHoldDto>();

    const plain = await world.api.post(
      '/appointments',
      world.owner,
      await world.bookingBody(10, '09:00'),
    );
    const override = await world.api.post(
      '/appointments',
      world.owner,
      await world.bookingBody(10, '09:00', { overrideHold: true }),
    );

    expect(plain.statusCode).toBe(409);
    expect(override.statusCode, override.body).toBe(201);
    const [row] = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.id, held.id)),
    );
    expect(row?.status).toBe('invalidated');
  });

  it('refuses a missing, wrong or used bot challenge before anything else, and creates no hold', async () => {
    world.setNow(EARLY);
    const visitor = world.visitor();
    const before = await world.inTenant((tx) => tx.select().from(slotHold));

    const missing = await visitor.post(holdUrl(), {
      ...(await holdBody(visitor, 11)),
      challengeProof: 'nope',
    });
    const body = await holdBody(visitor, 11);
    const first = await visitor.post(holdUrl(), body);
    const replay = await world.visitor().post(holdUrl(), body);

    expect(missing.statusCode).toBe(400);
    expect(missing.json<Problem>().code).toBe('booking_challenge_failed');
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode).toBe(400);
    expect(replay.json<Problem>().code).toBe('booking_challenge_failed');
    const after = await world.inTenant((tx) => tx.select().from(slotHold));
    expect(after.length - before.length).toBe(1);
  });

  it('answers a time that is too soon, too far or outside working hours as no longer available, without a reason', async () => {
    world.setNow(MONDAY_NINE);
    const visitor = world.visitor();
    const tooSoon = await visitor.post(holdUrl(), {
      ...(await holdBody(visitor, 0, '10:00')),
    });
    world.setNow(EARLY);
    const tooFar = await visitor.post(holdUrl(), await holdBody(visitor, 20, '10:00'));
    const night = await visitor.post(holdUrl(), await holdBody(visitor, 1, '03:00'));

    for (const response of [tooSoon, tooFar, night]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<Problem>().code).toBe('slot_no_longer_available');
      expect(response.body).not.toMatch(/hours|horario|lead|horizon/i);
    }
  });

  it('stops an address that keeps taking holds by opening a new session each time', async () => {
    world.setNow(EARLY);
    const greedy = world.visitor({ ip: '10.66.0.1' });
    const answers: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      // A browser that forgets its cookie asks as a new session every time.
      greedy.forget();
      const response = await greedy.post(holdUrl(), await holdBody(greedy, 1 + attempt, '12:00'));
      answers.push(response.statusCode);
    }

    expect(answers.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(answers.slice(10)).toEqual([429, 429]);
    // Another address is not affected.
    expect((await hold(world.visitor(), 13, '12:00')).statusCode).toBe(201);
  });

  it('refuses a location or type the link does not expose, and a professional it does not name', async () => {
    world.setNow(EARLY);
    const visitor = world.visitor();

    const elsewhere = await visitor.post(holdUrl(), {
      ...(await holdBody(visitor, 12)),
      locationId: world.norte,
    });
    const otherType = await visitor.post(holdUrl(), {
      ...(await holdBody(visitor, 12)),
      appointmentTypeId: world.withBuffer,
    });
    const stranger = await visitor.post(holdUrl(), {
      ...(await holdBody(visitor, 12)),
      professional: 'zzzzzzzzzzzz',
    });

    for (const response of [elsewhere, otherType, stranger]) {
      expect(response.statusCode, response.body).toBe(404);
    }
  });

  it('ignores an organization, role or patient identifier sent in the body', async () => {
    world.setNow(EARLY);
    const visitor = world.visitor();

    const response = await visitor.post(
      holdUrl(),
      await holdBody(visitor, 12, '10:00', {
        tenantId: '0190a000-0000-7000-8000-00000000dead',
        role: 'owner',
        patientId: await world.freshPatient(),
        professionalId: world.colleague.professionalId,
      }),
    );

    expect(response.statusCode, response.body).toBe(201);
    const held = response.json<PublicHoldDto>();
    const [row] = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.id, held.id)),
    );
    expect(row?.professionalId).toBe(world.doctor.professionalId);
  });

  it('works without the challenge adapter only when none is configured: the form stays closed', async () => {
    const closed = await createBookingWorld(runtime, {
      slug: 'public-avail-closed',
      app: { adapters: { forTenant: () => undefined } },
    });
    try {
      const own = await closed.openLinks();

      const challenge = await closed.visitor().get('/public/challenge');
      const hold = await closed.visitor().post(`/public/${own.organization.slug}/booking/holds`, {
        professional: own.professional.slug,
        locationId: closed.centro,
        appointmentTypeId: closed.consulta,
        startsAt: `${closed.monday(1)}T13:00:00.000Z`,
        challengeProof: 'anything',
      });

      expect(challenge.statusCode).toBe(503);
      expect(hold.statusCode).toBe(503);
    } finally {
      await closed.close();
    }
  });
});
