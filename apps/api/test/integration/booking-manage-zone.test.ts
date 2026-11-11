import type { PublicConfirmationDto, PublicHoldDto } from '@consultorio/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBookingWorld, type BookingWorld } from '../support/booking-world.js';

/**
 * Judgment day finding C5: moving an appointment by its link compared UTC dates to decide whether
 * the move stays in the same day, while the daily cap counts local days. For an appointment in the
 * evening (the next day in Greenwich) the move inside the same local day was refused as if it
 * added a booking to a full day.
 */

let runtime: DbHandle;
let world: BookingWorld;

const EARLY = new Date('2031-05-05T12:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBookingWorld(runtime, { slug: 'booking-zone' });
  const settings = await world.api.patch('/settings', world.owner, {
    onlineBooking: { horizonDays: 365, dailyCap: 1 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

/** 20:30 and 22:00 of a Monday in Buenos Aires (UTC-3): 23:30 of that Monday and 01:00 of Tuesday in UTC. */
const eveningMonday = (weeksAfter: number, time: '20:30' | '22:00') => {
  const monday = world.monday(weeksAfter);
  if (time === '20:30') return `${monday}T23:30:00.000Z`;
  const tuesday = new Date(Date.parse(`${monday}T00:00:00.000Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return `${tuesday}T01:00:00.000Z`;
};

describe('moving an appointment inside its local day by the link', () => {
  it('is allowed under a cap of one: the appointment does not count against the day it already holds', async () => {
    world.setNow(EARLY);
    const evening = await world.addProfessional();
    const hours = await world.api.put(`/professionals/${evening.professionalId}/hours`, evening, {
      hours: [{ locationId: world.centro, weekday: 1, start: '18:00', end: '23:30' }],
    });
    expect(hours.statusCode, hours.body).toBe(200);
    const links = await world.openLinks({ doctor: evening });
    const visitor = world.visitor();
    const held = await visitor.post(`/public/${links.organization.slug}/booking/holds`, {
      professional: links.professional.slug,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      startsAt: eveningMonday(40, '22:00'),
      challengeProof: await visitor.solve(),
    });
    expect(held.statusCode, held.body).toBe(201);
    const hold = held.json<PublicHoldDto>();
    const form = world.form();
    await visitor.post(`/public/${links.organization.slug}/booking/holds/${hold.id}/submission`, {
      ...form,
      challengeProof: await visitor.solve(),
    });
    await world.runJobs();
    const confirmed = await visitor.post(
      `/public/${links.organization.slug}/booking/holds/${hold.id}/confirm`,
      { code: world.codeSentTo(form.email) },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await world.app.background.idle();
    const token = confirmed.json<PublicConfirmationDto>().managePath?.split('/').at(-1) ?? '';

    const moved = await visitor.post(`/public/t/${token}/reschedule`, {
      startsAt: eveningMonday(40, '20:30'),
    });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<PublicConfirmationDto>().startsAt).toBe(eveningMonday(40, '20:30'));
  });
});
