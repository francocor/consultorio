import type { AppointmentDto } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { hostOf } from '../support/app.js';
import { createWaitlistWorld, type WaitlistWorld } from '../support/waitlist-world.js';

/**
 * The page behind the link of an offer, through the public token router of the real application.
 * The link is the one the delivery job handed to the (fake) delivery.
 */

const SLUG = 'waitlist-link';
const START = new Date('2031-05-05T12:00:00.000Z');
const MINUTE = 60_000;

let runtime: DbHandle;
let world: WaitlistWorld;
let visits = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createWaitlistWorld(runtime, { slug: SLUG, now: START });
  const settings = await world.api.patch('/settings', world.owner, {
    waitlist: { entryExpiryDays: 365 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
});

beforeEach(async () => {
  await world.reset();
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

let week = 0;
const nextWeek = () => {
  week += 1;
  return week;
};

function request(method: 'GET' | 'POST', token: string, payload?: string) {
  visits += 1;
  return world.app.inject({
    method,
    url: `/public/t/${token}`,
    headers: {
      host: hostOf(SLUG),
      origin: `https://${hostOf(SLUG)}`,
      'user-agent': 'vitest-visitor',
      ...(payload === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
    },
    // Every visit comes from an address of its own, so the rate limit of the route stays out of it.
    remoteAddress: `10.66.${String(Math.floor(visits / 250))}.${String(visits % 250)}`,
    ...(payload === undefined ? {} : { payload }),
  });
}

const open = (token: string) => request('GET', token);
const press = (token: string, choice: string) => request('POST', token, `choice=${choice}`);

async function waiting(count: number, extra: Record<string, unknown> = {}) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    await world.advance(MINUTE);
    entries.push(await world.join(await world.patient(), extra));
  }
  return entries;
}

/** A slot is freed, the offer is made and delivered: what the patient finds in the email. */
async function delivered(count = 1, options: { time?: string } = {}) {
  const weeks = nextWeek();
  const entries = await waiting(count);
  const booked = await world.book(weeks, options.time ?? '10:00');
  await world.cancel(booked);
  await world.run('waitlist.match');
  await world.run('waitlist.offer');
  const [entry] = entries;
  if (!entry) throw new Error('entry missing');
  const [offer] = await world.offersOf(entry.id);
  const offerId = String(offer?.['id']);
  return { weeks, entries, entry, booked, offerId, token: world.tokenOf(offerId) };
}

const countAt = (professionalId: string, startsAt: string) =>
  world.inTenant(async (tx) => {
    const rows = (
      await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM appointment
              WHERE professional_id = ${professionalId}
                AND starts_at = ${startsAt}::timestamptz AND status <> 'cancelled'`,
      )
    ).rows;
    return rows[0]?.n ?? 0;
  });

const auditRows = (resourceId: string) =>
  world.inTenant(
    async (tx) =>
      (
        await tx.execute<{ action: string; actor_user_id: string | null; metadata: unknown }>(
          sql`SELECT action, actor_user_id, metadata FROM audit_event
                WHERE resource_id = ${resourceId} ORDER BY occurred_at, id`,
        )
      ).rows,
  );

describe('looking at an offer', () => {
  it('shows the slot and the two choices, spends nothing and tells the browser to keep the referrer', async () => {
    const { token, weeks } = await delivered();

    const first = await open(token);
    const second = await open(token);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.headers['referrer-policy']).toBe('same-origin');
    expect(first.headers['content-type']).toContain('text/html');
    expect(first.body).toContain('Hay un turno disponible');
    expect(first.body).toContain('<dt>Fecha</dt>');
    expect(first.body).toContain(
      `lunes, ${String(Number(world.monday(weeks).slice(8)))} de mayo de 2031`,
    );
    expect(first.body).toContain('<dd>10:00</dd>');
    expect(first.body).toContain('<dt>Lugar</dt>\n<dd>Centro</dd>');
    expect(first.body).toContain('<dt>Profesional</dt>');
    expect(first.body).toContain('name="choice" value="accept">Aceptar el turno</button>');
    expect(first.body).toContain('name="choice" value="decline">No me sirve</button>');
    // The offer was made at 09:01 local and lasts the 30 minutes of the window.
    expect(first.body).toContain('Esta oferta vale hasta las 09:31.');
  });

  it('says nothing about the patient, the type of visit or anybody else on the list', async () => {
    const { token, entry } = await delivered(2);

    const page = await open(token);

    expect(page.body).not.toContain(entry.patientName);
    expect(page.body).not.toContain('Paciente');
    expect(page.body).not.toContain('Consulta');
    expect(page.body).not.toContain('lista de espera de');
  });

  it('leaves the professional out when the organization hides it', async () => {
    const { token } = await delivered();
    await world.api.patch('/settings', world.owner, { notifications: { hideProfessional: true } });
    try {
      const page = await open(token);

      expect(page.statusCode).toBe(200);
      expect(page.body).not.toContain('<dt>Profesional</dt>');
    } finally {
      await world.api.patch('/settings', world.owner, {
        notifications: { hideProfessional: false },
      });
    }
  });

  it('answers a guessed link like any other dead link', async () => {
    const { token } = await delivered();
    const dead = await open('x'.repeat(43));
    const tampered = await open(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);

    expect(dead.statusCode).toBe(404);
    expect(tampered.statusCode).toBe(404);
    expect(tampered.body).toBe(dead.body);
  });
});

describe('accepting an offer', () => {
  it('books the slot, closes the entry as fulfilled and says so', async () => {
    const { token, entry, booked, offerId } = await delivered();
    await world.advance(10 * MINUTE);

    const response = await press(token, 'accept');

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('Turno confirmado');
    expect(response.body).toContain('<dd>10:00</dd>');
    expect(await countAt(world.doctor.professionalId, booked.startsAt)).toBe(1);
    const [appointment] = await world.inTenant(
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT * FROM appointment
                  WHERE professional_id = ${world.doctor.professionalId}
                    AND starts_at = ${booked.startsAt}::timestamptz AND status <> 'cancelled'`,
          )
        ).rows,
    );
    expect(appointment).toMatchObject({
      patient_id: entry.patientId,
      appointment_type_id: world.consulta,
      location_id: world.centro,
      status: 'scheduled',
      source: 'waitlist_offer',
      booked_by: null,
      identity_confirmed: true,
    });
    expect((await world.offersOf(entry.id))[0]).toMatchObject({
      status: 'accepted',
      appointment_id: appointment?.['id'],
    });
    expect((await world.offersOf(entry.id))[0]?.['closed_at']).not.toBeNull();
    expect(await world.entryRow(entry.id)).toMatchObject({
      status: 'closed',
      close_reason: 'fulfilled',
    });
    // The trail: the acceptance, by a visitor with no account, and the closing of the entry.
    const trail = await auditRows(offerId);
    expect(trail.map((row) => row.action)).toEqual([
      'waitlist.offer.created',
      'waitlist.offer.accepted',
    ]);
    expect(trail[1]?.actor_user_id).toBeNull();
    expect(trail[1]?.metadata).toMatchObject({
      entryId: entry.id,
      appointmentId: appointment?.['id'],
      channel: 'email',
    });
    expect((await auditRows(entry.id)).map((row) => row.action)).toContain('waitlist.entry.closed');
    const created = await auditRows(String(appointment?.['id']));
    expect(created.map((row) => row.action)).toContain('appointment.created');
    expect(created.find((row) => row.action === 'appointment.created')?.metadata).toMatchObject({
      source: 'waitlist_offer',
    });
  });

  it('spends the link: a second press finds a link that is no longer valid', async () => {
    const { token } = await delivered();
    const first = await press(token, 'accept');
    expect(first.statusCode).toBe(200);

    const second = await press(token, 'accept');
    const looking = await open(token);

    expect(second.statusCode).toBe(404);
    expect(looking.statusCode).toBe(404);
  });

  it('tells the patient the offer expired, rejects the acceptance and keeps them on the list', async () => {
    const { token, entry, booked } = await delivered();
    await world.advance(31 * MINUTE);

    const response = await press(token, 'accept');

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('La oferta venció');
    expect(response.body).toContain('Sigue en la lista de espera');
    expect(await countAt(world.doctor.professionalId, booked.startsAt)).toBe(0);
    // The patient still waits.
    // The offer is closed right there, as expired, and the entry waits for the next slot.
    expect((await world.offersOf(entry.id))[0]).toMatchObject({ status: 'expired' });
    expect(await world.entryRow(entry.id)).toMatchObject({
      status: 'active',
      consecutive_expired: 1,
    });
    // The link still opens, to say the same.
    const looking = await open(token);
    expect(looking.statusCode).toBe(200);
    expect(looking.body).toContain('La oferta venció');
    expect(looking.body).not.toContain('<button');
  });

  it('says the same once the sweep has closed the offer', async () => {
    const { token, entry } = await delivered();
    await world.advance(31 * MINUTE);
    await world.run('waitlist.expire');

    const response = await press(token, 'accept');

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('La oferta venció');
    expect(await world.entryRow(entry.id)).toMatchObject({ status: 'active' });
  });

  it('refuses a slot that reception booked first, closes the offer and keeps the patient waiting', async () => {
    const { token, entry, weeks, booked } = await delivered();
    const taken = await world.book(weeks, '10:00');

    const response = await press(token, 'accept');

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('El turno ya no está disponible');
    expect(await countAt(world.doctor.professionalId, booked.startsAt)).toBe(1);
    expect(taken.patientId).not.toBe(entry.patientId);
    expect((await world.offersOf(entry.id))[0]).toMatchObject({
      status: 'invalidated',
      end_reason: 'slot_taken',
    });
    expect(await world.entryRow(entry.id)).toMatchObject({ status: 'active' });
  });

  it('closes the offer and says so when the slot stopped being bookable after the acceptance began', async () => {
    const { token, entry, weeks, booked } = await delivered();
    const date = world.monday(weeks);
    const block = await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.doctor.professionalId,
      startsAt: `${date}T12:00:00.000Z`,
      endsAt: `${date}T16:00:00.000Z`,
      reason: 'Capacitación',
    });
    expect(block.statusCode, block.body).toBe(201);

    const response = await press(token, 'accept');

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('El turno ya no está disponible');
    expect(await countAt(world.doctor.professionalId, booked.startsAt)).toBe(0);
    expect((await world.offersOf(entry.id))[0]).toMatchObject({
      status: 'invalidated',
      end_reason: 'slot_unavailable',
    });
    expect(await world.entryRow(entry.id)).toMatchObject({ status: 'active' });
  });

  it('produces exactly one appointment when reception and the patient take the slot at once', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { token, weeks, booked, entry } = await delivered();
      const body = await world.bookingBody(weeks, '10:00');

      const [staff, patient] = await Promise.all([
        world.api.post('/appointments', world.reception, body),
        press(token, 'accept'),
      ]);

      // Whoever got there first has the slot; the other is told it is gone.
      expect(
        await countAt(world.doctor.professionalId, booked.startsAt),
        `round ${String(round)}`,
      ).toBe(1);
      const staffWon = staff.statusCode === 201;
      expect(staff.statusCode).toBe(staffWon ? 201 : 409);
      expect(patient.statusCode).toBe(staffWon ? 409 : 200);
      expect((await world.offersOf(entry.id))[0]?.['status']).toBe(
        staffWon ? 'invalidated' : 'accepted',
      );
    }
  });

  it('starts the appointment with an unconfirmed identity, and a review for reception, when the self-join matched an existing patient', async () => {
    const { token, entry, booked } = await delivered();
    await world.inTenant((tx) =>
      tx.execute(sql`UPDATE waitlist_entry SET identity_unconfirmed = true WHERE id = ${entry.id}`),
    );

    const response = await press(token, 'accept');

    expect(response.statusCode, response.body).toBe(200);
    const [row] = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ id: string; identity_confirmed: boolean }>(
            sql`SELECT id, identity_confirmed FROM appointment
                  WHERE professional_id = ${world.doctor.professionalId}
                    AND starts_at = ${booked.startsAt}::timestamptz AND status <> 'cancelled'`,
          )
        ).rows,
    );
    expect(row?.identity_confirmed).toBe(false);
    const items = await world.inTenant(
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT kind, status FROM worklist_item WHERE subject_id = ${String(row?.id)}`,
          )
        ).rows,
    );
    expect(items).toEqual([{ kind: 'identity_review', status: 'open' }]);
  });

  it('is refused while the organization is read-only, and the offer stays as it was', async () => {
    const { token, entry } = await delivered();
    const set = (status: 'active' | 'read_only') =>
      world.inTenant((tx) =>
        tx
          .update(tenant)
          .set({ status, readOnlySince: status === 'read_only' ? new Date() : null })
          .where(eq(tenant.id, world.tenant.id)),
      );
    await set('read_only');
    try {
      const response = await press(token, 'accept');

      expect(response.statusCode).toBe(402);
      expect((await world.offersOf(entry.id))[0]).toMatchObject({ status: 'open' });
    } finally {
      await set('active');
    }
  });

  it('does nothing when the press carries no valid choice, and shows the offer again', async () => {
    const { token, entry } = await delivered();

    const none = await request('POST', token, 'other=1');
    const odd = await press(token, 'Accept<script>');

    for (const response of [none, odd]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Aceptar el turno');
    }
    expect((await world.offersOf(entry.id))[0]).toMatchObject({ status: 'open' });
    expect((await open(token)).statusCode).toBe(200);
  });
});

describe('declining an offer', () => {
  it('keeps the entry on the list, records the answer and offers the slot to the next entry', async () => {
    const { token, entries, offerId } = await delivered(2);
    const [first, second] = entries;
    if (!first || !second) throw new Error('entries missing');
    // The patient had let an offer pass before: declining shows they are there.
    await world.inTenant((tx) =>
      tx.execute(sql`UPDATE waitlist_entry SET consecutive_expired = 2 WHERE id = ${first.id}`),
    );

    const response = await press(token, 'decline');

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('Gracias por avisarnos');
    expect(response.body).toContain('Sigue en la lista de espera');
    expect((await world.offersOf(first.id))[0]).toMatchObject({ status: 'declined' });
    expect((await world.offersOf(first.id))[0]?.['closed_at']).not.toBeNull();
    expect(await world.entryRow(first.id)).toMatchObject({
      status: 'active',
      consecutive_expired: 0,
    });
    expect((await auditRows(offerId)).map((row) => row.action)).toEqual([
      'waitlist.offer.created',
      'waitlist.offer.declined',
    ]);

    // The next entry in line is offered the same slot, and the patient who declined is not again.
    await world.run('waitlist.match');
    expect(await world.offersOf(second.id)).toHaveLength(1);
    expect(await world.offersOf(first.id)).toHaveLength(1);
    await world.run('waitlist.match');
    expect(await world.offersOf(first.id)).toHaveLength(1);
  });

  it('spends the link, and a declined offer cannot be accepted afterwards', async () => {
    const { token, booked } = await delivered();
    await press(token, 'decline');

    const again = await press(token, 'accept');

    expect(again.statusCode).toBe(404);
    expect(await countAt(world.doctor.professionalId, booked.startsAt)).toBe(0);
  });

  it('closes the offer for the last entry too: the slot stays free', async () => {
    const { token, weeks, booked } = await delivered();

    await press(token, 'decline');
    await world.run('waitlist.match');

    expect(world.jobs.pending('waitlist.offer')).toEqual([]);
    const free: AppointmentDto = await world.book(weeks, '10:00');
    expect(free.startsAt).toBe(booked.startsAt);
  });
});

describe('an offer that is over', () => {
  it('says so when the slot was taken before anybody answered', async () => {
    const { token, weeks } = await delivered();
    await world.book(weeks, '10:00');

    const looking = await open(token);

    expect(looking.statusCode).toBe(200);
    expect(looking.body).toContain('El turno ya no está disponible');
    expect(looking.body).not.toContain('<button');
  });

  it('keeps the link alive past the offer, but not forever', async () => {
    const { token } = await delivered();

    await world.advance(6 * 60 * MINUTE);
    const sameDay = await open(token);
    await world.advance(18 * 60 * MINUTE);
    const nextDay = await open(token);

    expect(sameDay.statusCode).toBe(200);
    expect(sameDay.body).toContain('La oferta venció');
    expect(nextDay.statusCode).toBe(404);
  });
});
