import type { PublicHoldDto } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { slotHold } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { hostOf } from '../support/app.js';
import { createBookingWorld, type BookingWorld, type Visitor } from '../support/booking-world.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * What a hostile visitor can do with the public forms, and what stops them (online-booking, "Abuse
 * protection"; design 4.5): the bot challenge in front of every form, the bounds on slots and
 * forms per address, the life and the attempts of a one-time code, fields the form does not have,
 * bodies that are too big or not what they claim to be, and the organization that is named by the
 * host and by nothing else the visitor writes.
 */

let runtime: DbHandle;
let world: BookingWorld;
let links: Awaited<ReturnType<BookingWorld['openLinks']>>;
let otherTenantId: string;

const EARLY = new Date('2031-05-05T12:00:00.000Z');
let slots = 0;

/** A time nobody holds yet: eight half hours a week, one week after another. */
function nextSlot(): { weeksAfter: number; time: string } {
  slots += 1;
  const half = (slots - 1) % 8;
  return {
    weeksAfter: 1 + Math.floor((slots - 1) / 8),
    time: `${String(9 + Math.floor(half / 2)).padStart(2, '0')}:${half % 2 === 0 ? '00' : '30'}`,
  };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBookingWorld(runtime, { slug: 'sec-abuse' });
  links = await world.openLinks();
  otherTenantId = (await createTestTenant(runtime, { slug: 'sec-abuse-other' })).id;
  const settings = await world.api.patch('/settings', world.owner, {
    onlineBooking: { horizonDays: 365 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
}, 120_000);

afterAll(async () => {
  await world.close();
  await runtime.close();
});

beforeEach(() => {
  world.setNow(EARLY);
});

const holdsPath = () => `/public/${links.organization.slug}/booking/holds`;

/** The body of a hold request for a free Monday of its own. */
async function holdBody(visitor: Visitor, overrides: Record<string, unknown> = {}) {
  const { weeksAfter, time } = nextSlot();
  const hour = String(Number(time.slice(0, 2)) + 3).padStart(2, '0');
  return {
    professional: links.professional.slug,
    locationId: world.centro,
    appointmentTypeId: world.consulta,
    startsAt: `${world.monday(weeksAfter)}T${hour}:${time.slice(3)}:00.000Z`,
    challengeProof: await visitor.solve(),
    ...overrides,
  };
}

const holdsInDatabase = () => world.inTenant((tx) => tx.select().from(slotHold));

describe('the bot challenge', () => {
  it('stands in front of the hold: no proof, a made-up proof or a proof of the wrong kind hold nothing', async () => {
    const visitor = world.visitor();
    const before = (await holdsInDatabase()).length;

    const none = await visitor.post(holdsPath(), {
      ...(await holdBody(visitor)),
      challengeProof: undefined,
    });
    const invented = await visitor.post(
      holdsPath(),
      await holdBody(visitor, { challengeProof: 'x'.repeat(40) }),
    );
    const truncated = await visitor.post(holdsPath(), {
      ...(await holdBody(visitor)),
      challengeProof: (await visitor.solve()).slice(0, 20),
    });

    expect(none.statusCode).toBe(400);
    for (const refused of [invented, truncated]) {
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json<{ code: string }>().code).toBe('booking_challenge_failed');
    }
    expect((await holdsInDatabase()).length).toBe(before);
  });

  it('is worth one use: a solved puzzle cannot be replayed', async () => {
    const visitor = world.visitor();
    const proof = await visitor.solve();

    const first = await visitor.post(
      holdsPath(),
      await holdBody(visitor, { challengeProof: proof }),
    );
    const replay = await visitor.post(
      holdsPath(),
      await holdBody(visitor, { challengeProof: proof }),
    );

    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode).toBe(400);
    expect(replay.json<{ code: string }>().code).toBe('booking_challenge_failed');
  });

  it('is asked for before the form is read: a form with a proof that fails costs a code nobody sends', async () => {
    const visitor = world.visitor();
    const hold = await world.hold(visitor, links, nextSlot());
    world.email.clear();

    const response = await visitor.post(
      `/public/${links.organization.slug}/booking/holds/${hold.id}/submission`,
      { ...world.form(), challengeProof: 'y'.repeat(40) },
    );

    expect(response.statusCode).toBe(400);
    await world.runJobs();
    expect(world.email.sent).toEqual([]);
  });

  it('is itself limited: the puzzle endpoint answers a flood with a plain 429', async () => {
    const visitor = world.visitor({ ip: '10.99.0.1' });
    const statuses: number[] = [];

    for (let request = 0; request < 70; request += 1) {
      statuses.push((await visitor.get('/public/challenge')).statusCode);
    }

    expect(statuses.slice(0, 50).every((status) => status === 200)).toBe(true);
    expect(statuses).toContain(429);
    const limited = await visitor.get('/public/challenge');
    expect(limited.statusCode).toBe(429);
    expect(limited.body).not.toMatch(/token|challenge|proof|10\.99\.0\.1/i);
  });
});

describe('the bounds on slots and forms', () => {
  it('stops an address that opens a new session for every slot, and tells the administrator without naming it', async () => {
    const ip = '10.99.1.1';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const visitor = world.visitor({ ip });
      statuses.push((await visitor.post(holdsPath(), await holdBody(visitor))).statusCode);
    }

    expect(statuses.filter((status) => status === 201).length).toBeLessThanOrEqual(10);
    expect(statuses).toContain(429);
    const entries = await world.inTenant((tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'booking.suspicious')),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries.map((entry) => entry.metadata))).not.toContain(ip);
  });

  it('answers the limit the way it answers every refusal: a problem document with no detail', async () => {
    const ip = '10.99.1.2';
    let limited: Awaited<ReturnType<Visitor['post']>> | undefined;
    for (let attempt = 0; attempt < 12 && limited?.statusCode !== 429; attempt += 1) {
      const visitor = world.visitor({ ip });
      const response = await visitor.post(holdsPath(), await holdBody(visitor));
      if (response.statusCode === 429) limited = response;
    }

    expect(limited?.statusCode).toBe(429);
    expect(Object.keys(limited?.json() ?? {}).sort()).toEqual(
      ['code', 'i18nKey', 'requestId', 'status', 'title', 'type'].sort(),
    );
  });

  it('counts a form per address too: the eleventh in an hour is refused', async () => {
    const ip = '10.99.1.3';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      // The slot is held from another address; every form arrives from the same one.
      const holder = world.visitor({ ip: `10.99.2.${String(attempt + 1)}` });
      const hold = await world.hold(holder, links, nextSlot());
      const response = await world.app.inject({
        method: 'POST',
        url: `/public/${links.organization.slug}/booking/holds/${hold.id}/submission`,
        headers: {
          host: hostOf('sec-abuse'),
          origin: `https://${hostOf('sec-abuse')}`,
          cookie: holder.cookie(),
          'content-type': 'application/json',
        },
        remoteAddress: ip,
        payload: { ...world.form(), challengeProof: await holder.solve() },
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('the one-time code', () => {
  async function submitted() {
    const visitor = world.visitor();
    const hold = await world.hold(visitor, links, nextSlot());
    const form = world.form();
    const response = await visitor.post(
      `/public/${links.organization.slug}/booking/holds/${hold.id}/submission`,
      { ...form, challengeProof: await visitor.solve() },
    );
    expect(response.statusCode, response.body).toBe(200);
    await world.runJobs();
    return { visitor, hold, form };
  }

  const confirm = (booking: Awaited<ReturnType<typeof submitted>>, code: string) =>
    booking.visitor.post(
      `/public/${links.organization.slug}/booking/holds/${booking.hold.id}/confirm`,
      { code },
    );

  it('gives up after five wrong guesses, even for the right code afterwards', async () => {
    const booking = await submitted();
    const right = world.codeSentTo(booking.form.email);
    const wrong = right === '000000' ? '111111' : '000000';

    const guesses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      guesses.push((await confirm(booking, wrong)).statusCode);
    }
    const after = await confirm(booking, right);

    expect(guesses.every((status) => status >= 400 && status < 500)).toBe(true);
    expect(after.statusCode).toBeGreaterThanOrEqual(400);
    expect(after.statusCode).toBeLessThan(500);
    const [row] = await world
      .inTenant((tx) =>
        tx.execute<{ appointment_id: string | null }>(
          sql`SELECT appointment_id FROM booking_submission WHERE hold_id = ${booking.hold.id}`,
        ),
      )
      .then((result) => result.rows);
    expect(row?.appointment_id).toBeNull();
  });

  it('answers a wrong code, an expired hold and an unknown hold alike, so the answer says nothing about which', async () => {
    const booking = await submitted();
    const wrong = await confirm(booking, '000000');
    const unknown = await booking.visitor.post(
      `/public/${links.organization.slug}/booking/holds/0190a000-0000-7000-8000-000000000001/confirm`,
      { code: '000000' },
    );

    expect([wrong.statusCode, unknown.statusCode].every((status) => status >= 400)).toBe(true);
    expect(Object.keys(wrong.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
  });

  it('is of no use on another hold: the code of one form does not confirm another', async () => {
    const first = await submitted();
    const second = await submitted();

    const crossed = await confirm(second, world.codeSentTo(first.form.email));

    expect(crossed.statusCode).toBeGreaterThanOrEqual(400);
    expect(crossed.statusCode).toBeLessThan(500);
  });

  it('is spent when it is used: the same code cannot book twice', async () => {
    const booking = await submitted();
    const code = world.codeSentTo(booking.form.email);

    const first = await confirm(booking, code);
    const replay = await confirm(booking, code);

    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode).toBeGreaterThanOrEqual(400);
    expect(replay.statusCode).toBeLessThan(500);
  });

  it('does not live past its ten minutes', async () => {
    const booking = await submitted();
    const code = world.codeSentTo(booking.form.email);

    world.advance(11 * 60_000);
    const late = await confirm(booking, code);

    expect(late.statusCode).toBeGreaterThanOrEqual(400);
    expect(late.statusCode).toBeLessThan(500);
  });

  it('is sent at most three times an hour to one address', async () => {
    const booking = await submitted();
    world.email.clear();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await booking.visitor.post(
        `/public/${links.organization.slug}/booking/holds/${booking.hold.id}/code`,
        { challengeProof: await booking.visitor.solve() },
      );
      statuses.push(response.statusCode);
      await world.runJobs();
    }

    expect(
      world.email.sent.filter((message) => message.to === booking.form.email).length,
    ).toBeLessThanOrEqual(3);
    expect(statuses).toContain(429);
  });
});

describe('fields the forms do not have', () => {
  it('ignores a hold that names an organization, a status, a source or a role', async () => {
    const visitor = world.visitor();

    for (const forged of [
      { tenantId: otherTenantId },
      { tenant_id: otherTenantId },
      { status: 'converted' },
      { source: 'staff' },
      { role: 'owner' },
      { sourceKey: 'someone-else' },
      { expiresAt: '2099-01-01T00:00:00.000Z' },
    ]) {
      const response = await visitor.post(holdsPath(), await holdBody(visitor, forged));
      expect(response.statusCode, JSON.stringify(forged)).toBe(201);
      const [row] = await world.inTenant((tx) =>
        tx.select().from(slotHold).where(eq(slotHold.id, response.json<PublicHoldDto>().id)),
      );
      // Whatever the visitor wrote, the hold is the ordinary one of this organization.
      expect(row?.tenantId, JSON.stringify(forged)).toBe(world.tenant.id);
      expect(row?.status, JSON.stringify(forged)).toBe('active');
      expect(row?.sourceKey, JSON.stringify(forged)).not.toBe('someone-else');
      expect(row?.expiresAt.getTime(), JSON.stringify(forged)).toBeLessThan(
        EARLY.getTime() + 11 * 60_000,
      );
    }
    const other = await world.inTenant((tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM slot_hold WHERE tenant_id = ${otherTenantId}`,
      ),
    );
    expect(other.rows[0]?.n ?? 0).toBe(0);
  });

  it('ignores a form that names a patient, an identity decision, an origin or an appointment', async () => {
    const victim = await world.inTenant(async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id)
              VALUES (${world.tenant.id}, 'Ajeno', 'Pedro', '1970-01-01', 'dni', '30777001')
              RETURNING id`,
      );
      return rows.rows[0]?.id ?? '';
    });
    const visitor = world.visitor();
    const hold = await world.hold(visitor, links, nextSlot());
    const form = world.form();

    const submitted = await visitor.post(
      `/public/${links.organization.slug}/booking/holds/${hold.id}/submission`,
      {
        ...form,
        patientId: victim,
        identityConfirmed: true,
        origin: 'staff',
        status: 'verified',
        appointmentId: victim,
        tenantId: otherTenantId,
        challengeProof: await visitor.solve(),
      },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    await world.runJobs();
    const confirmed = await visitor.post(
      `/public/${links.organization.slug}/booking/holds/${hold.id}/confirm`,
      { code: world.codeSentTo(form.email) },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const rows = await world.inTenant((tx) =>
      tx.execute<{ patient_id: string; source: string; origin: string; tenant_id: string }>(
        sql`SELECT a.patient_id, a.source, p.origin, a.tenant_id
              FROM appointment a JOIN patient p ON p.id = a.patient_id
             WHERE a.id = (SELECT appointment_id FROM slot_hold WHERE id = ${hold.id})`,
      ),
    );
    // A new person registered by the booking, not the patient the visitor named.
    expect(rows.rows[0]).toMatchObject({
      source: 'online',
      origin: 'online',
      tenant_id: world.tenant.id,
    });
    expect(rows.rows[0]?.patient_id).not.toBe(victim);
  });

  it('takes the organization from the host and from nothing the visitor writes', async () => {
    const visitor = world.visitor();
    const body = await holdBody(visitor);

    const response = await world.app.inject({
      method: 'POST',
      url: `${holdsPath()}?tenant=${otherTenantId}&tenantId=${otherTenantId}`,
      headers: {
        host: hostOf('sec-abuse'),
        origin: `https://${hostOf('sec-abuse')}`,
        'x-tenant-id': otherTenantId,
        'x-forwarded-host': hostOf('sec-abuse-other'),
        'content-type': 'application/json',
      },
      payload: body,
      remoteAddress: '10.99.3.1',
    });

    expect(response.statusCode, response.body).toBe(201);
    const hold = response.json<PublicHoldDto>();
    const [row] = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.id, hold.id)),
    );
    expect(row?.tenantId).toBe(world.tenant.id);
  });

  it('does not find the pages of one organization on the host of another', async () => {
    const visitor = world.visitor();
    const response = await world.app.inject({
      method: 'GET',
      url: `/public/${links.organization.slug}/booking`,
      headers: { host: hostOf('sec-abuse-other') },
      remoteAddress: visitor.ip,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('sec-abuse');
  });
});

describe('bodies that are too big or not what they claim', () => {
  const send = (payload: string | Buffer, contentType: string) =>
    world.app.inject({
      method: 'POST',
      url: holdsPath(),
      headers: {
        host: hostOf('sec-abuse'),
        origin: `https://${hostOf('sec-abuse')}`,
        'content-type': contentType,
      },
      payload,
      remoteAddress: '10.99.4.1',
    });

  it('refuses a body of several megabytes before reading it', async () => {
    const response = await send(
      JSON.stringify({ padding: 'x'.repeat(3_000_000) }),
      'application/json',
    );

    expect(response.statusCode).toBe(413);
  });

  it('refuses what is not JSON, what is broken JSON and what is not an object', async () => {
    for (const [payload, type] of [
      ['professional=a&locationId=b', 'application/x-www-form-urlencoded'],
      ['{"professional":', 'application/json'],
      ['[]', 'application/json'],
      ['null', 'application/json'],
      ['"text"', 'application/json'],
      ['<xml/>', 'text/xml'],
    ] as const) {
      const response = await send(payload, type);
      expect(response.statusCode, `${type} ${payload}`).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, `${type} ${payload}`).toBeLessThan(500);
    }
  });

  it('does not answer a verb the route does not have', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const response = await world.app.inject({
        method,
        url: holdsPath(),
        headers: { host: hostOf('sec-abuse'), origin: `https://${hostOf('sec-abuse')}` },
        remoteAddress: '10.99.4.2',
      });
      expect(response.statusCode, method).toBe(404);
    }
  });

  it('does not echo what it was sent in the answer to a refused body', async () => {
    const response = await send(
      JSON.stringify({ professional: '<script>alert(1)</script>' }),
      'application/json',
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('<script>');
  });
});
