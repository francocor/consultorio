import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { createWaitlistWorld, type WaitlistWorld } from '../support/waitlist-world.js';

let runtime: DbHandle;
let world: WaitlistWorld;

const START = new Date('2031-05-05T12:00:00.000Z');
const MINUTE = 60_000;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createWaitlistWorld(runtime, { slug: 'waitlist-offers', now: START });
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

async function waiting(count: number, extra: Record<string, unknown> = {}) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    await world.advance(MINUTE);
    entries.push(await world.join(await world.patient(), extra));
  }
  return entries;
}

/** An appointment is cancelled and the offer for its slot is made (not yet delivered). */
async function offered(count = 1) {
  const weeks = nextWeek();
  const entries = await waiting(count);
  const booked = await world.book(weeks, '10:00');
  await world.cancel(booked);
  await world.run('waitlist.match');
  return { weeks, entries, booked };
}

const at = (iso: string) => new Date(iso).getTime();
const asMs = (value: unknown) => new Date(value as string).getTime();

describe('delivering an offer', () => {
  it('hands the offer to the delivery once, with the slot and a link that opens its page', async () => {
    const { entries, booked } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    const [offer] = await world.offersOf(entry.id);

    const results = await world.run('waitlist.offer');

    expect(results.map((row) => row.result)).toEqual([{ status: 'completed' }]);
    expect(world.deliveries).toHaveLength(1);
    const delivery = world.deliveries[0];
    expect(delivery).toMatchObject({
      offerId: offer?.['id'],
      patientId: entry.patientId,
      professionalId: world.doctor.professionalId,
      locationId: world.centro,
    });
    expect(delivery?.startsAt.toISOString()).toBe(booked.startsAt);
    expect(delivery?.endsAt.toISOString()).toBe(booked.endsAt);
    expect(delivery?.expiresAt.getTime()).toBe(asMs(offer?.['expires_at']));
    // The link is the platform's single-use address and carries nothing but the token.
    expect(delivery?.offerTokenUrl).toMatch(
      /^https:\/\/waitlist-offers\.consultorio\.test\/public\/t\/[A-Za-z0-9_-]{43}$/,
    );
    const [after] = await world.offersOf(entry.id);
    expect(after).toMatchObject({ status: 'open', channel: 'email' });
    expect(after?.['delivered_at']).not.toBeNull();
    expect(after?.['message_id']).toBe('message-1');
  });

  it('issues a token of the kind waitlist_offer for that offer, alive past the offer to say it ended', async () => {
    const { entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    const [offer] = await world.offersOf(entry.id);
    await world.run('waitlist.offer');

    const tokens = createActionTokens({ clock: () => world.now() });
    const live = await world.inTenant((tx) =>
      tokens.inspect(tx, 'waitlist_offer', world.tokenOf(String(offer?.['id']))),
    );
    expect(live).toMatchObject({ subjectId: offer?.['id'] });

    // Half a day later the offer is long over, and the link still answers (to say so).
    await world.advance(12 * 60 * MINUTE);
    const later = await world.inTenant((tx) =>
      tokens.inspect(tx, 'waitlist_offer', world.tokenOf(String(offer?.['id']))),
    );
    expect(later).not.toBeNull();
  });

  it('delivers an offer once however many times its job runs', async () => {
    await offered();
    await world.run('waitlist.offer');
    const [first] = world.jobs.jobs.filter((job) => job.name === 'waitlist.offer');
    if (!first) throw new Error('no job');
    world.jobs.jobs.push({ ...first, id: crypto.randomUUID(), done: false });

    await world.run('waitlist.offer');

    expect(world.deliveries).toHaveLength(1);
  });

  it('rolls back when the delivery fails, so a retry delivers the offer', async () => {
    const { entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    world.deliveryFails.current = true;

    await expect(world.run('waitlist.offer')).rejects.toThrow('the provider is down');
    expect((await world.offersOf(entry.id))[0]).toMatchObject({
      channel: null,
      delivered_at: null,
    });

    world.deliveryFails.current = false;
    const [job] = world.jobs.jobs.filter((row) => row.name === 'waitlist.offer');
    if (!job) throw new Error('no job');
    world.jobs.jobs.push({ ...job, id: crypto.randomUUID(), done: false });
    await world.run('waitlist.offer');

    expect(world.deliveries).toHaveLength(1);
    expect((await world.offersOf(entry.id))[0]).toMatchObject({ channel: 'email' });
  });

  it('sends nothing for an offer that ended before its delivery', async () => {
    const { weeks, entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    // Reception books the slot directly before the delivery job runs.
    await world.book(weeks, '10:00');

    await world.run('waitlist.offer');

    expect(world.deliveries).toEqual([]);
    expect((await world.offersOf(entry.id))[0]).toMatchObject({ status: 'invalidated' });
  });

  it('ends the offer when the slot stopped being bookable (a block was put over it)', async () => {
    const { weeks, entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    const date = world.monday(weeks);
    const block = await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.doctor.professionalId,
      startsAt: `${date}T12:00:00.000Z`,
      endsAt: `${date}T16:00:00.000Z`,
      reason: 'Capacitación',
    });
    expect(block.statusCode, block.body).toBe(201);

    await world.run('waitlist.offer');

    expect(world.deliveries).toEqual([]);
    expect((await world.offersOf(entry.id))[0]).toMatchObject({
      status: 'invalidated',
      end_reason: 'slot_unavailable',
    });
    expect(await world.entryRow(entry.id)).toMatchObject({ status: 'active' });
  });

  it('puts the entry in front of reception when the patient cannot be reached, and offers the slot on', async () => {
    const weeks = nextWeek();
    const [unreachable, next] = await waiting(2);
    if (!unreachable || !next) throw new Error('entries missing');
    const booked = await world.book(weeks, '10:00');
    await world.cancel(booked);
    await world.run('waitlist.match');
    world.deliveryChannel.current = 'none';

    await world.run('waitlist.offer');

    expect((await world.offersOf(unreachable.id))[0]).toMatchObject({
      status: 'invalidated',
      end_reason: 'undeliverable',
      channel: null,
    });
    expect(await world.entryRow(unreachable.id)).toMatchObject({
      status: 'active',
      manual_contact_only: true,
      manual_reason: 'undeliverable',
    });
    expect((await world.callsOf(unreachable.id))[0]).toMatchObject({ reason: 'undeliverable' });

    // The next entry in line is offered the slot.
    world.deliveryChannel.current = 'email';
    await world.run('waitlist.match');
    expect(await world.offersOf(next.id)).toHaveLength(1);
    await world.run('waitlist.offer');
    // The unreachable patient was tried first; the next entry got the offer after.
    expect(world.deliveries.map((row) => row.patientId)).toEqual([
      unreachable.patientId,
      next.patientId,
    ]);
  });
});

describe('when an offer expires', () => {
  it('lasts the window of the organization, then passes to the next entry', async () => {
    const { entries } = await offered(2);
    const [first, second] = entries;
    if (!first || !second) throw new Error('entries missing');
    await world.run('waitlist.offer');
    const [offer] = await world.offersOf(first.id);
    expect(asMs(offer?.['expires_at']) - asMs(offer?.['created_at'])).toBe(30 * MINUTE);

    // An answer is awaited for 30 minutes; at 31 the offer is over.
    await world.advance(31 * MINUTE);
    await world.run('waitlist.expire');

    expect((await world.offersOf(first.id))[0]).toMatchObject({ status: 'expired' });
    expect((await world.offersOf(first.id))[0]?.['closed_at']).not.toBeNull();
    expect(await world.entryRow(first.id)).toMatchObject({
      status: 'active',
      consecutive_expired: 1,
    });
    // The next matching entry receives its offer at once.
    await world.run('waitlist.match');
    expect(await world.offersOf(second.id)).toHaveLength(1);
    expect(await world.entryRow(second.id)).toMatchObject({ status: 'offered' });
  });

  it('audits the expiry as the system', async () => {
    const { entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    const [offer] = await world.offersOf(entry.id);
    await world.run('waitlist.offer');
    await world.advance(31 * MINUTE);

    await world.run('waitlist.expire');

    const rows = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ action: string; actor_user_id: string | null }>(
            sql`SELECT action, actor_user_id FROM audit_event
                  WHERE resource_id = ${String(offer?.['id'])} ORDER BY occurred_at, id`,
          )
        ).rows,
    );
    expect(rows).toEqual([
      { action: 'waitlist.offer.created', actor_user_id: null },
      { action: 'waitlist.offer.expired', actor_user_id: null },
    ]);
  });

  it('does not expire an offer before its time', async () => {
    const { entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    await world.run('waitlist.offer');
    await world.advance(10 * MINUTE);

    await world.run('waitlist.expire');

    expect((await world.offersOf(entry.id))[0]).toMatchObject({ status: 'open' });
  });

  it('leaves the slot free for normal booking when nobody accepts', async () => {
    const { weeks, entries } = await offered(2);
    const [first, second] = entries;
    if (!first || !second) throw new Error('entries missing');
    await world.run('waitlist.offer');
    await world.advance(31 * MINUTE);
    await world.run('waitlist.expire');
    await world.run('waitlist.match');
    await world.run('waitlist.offer');
    await world.advance(31 * MINUTE);
    await world.run('waitlist.expire');
    // Nobody is left to offer the slot to.
    await world.run('waitlist.match');

    expect((await world.offersOf(first.id))[0]).toMatchObject({ status: 'expired' });
    expect((await world.offersOf(second.id))[0]).toMatchObject({ status: 'expired' });
    // No third offer is made for the slot, and it can be booked.
    expect(world.jobs.pending('waitlist.offer')).toEqual([]);
    const booked = await world.book(weeks, '10:00');
    expect(booked.status).toBe('scheduled');
  });

  it('flags an entry that let three offers in a row expire', async () => {
    await world.advance(MINUTE);
    const entry = await world.join(await world.patient());
    for (let round = 1; round <= 3; round += 1) {
      const weeks = nextWeek();
      await world.cancel(await world.book(weeks, '10:00'));
      await world.run('waitlist.match', 'waitlist.offer');
      await world.advance(31 * MINUTE);
      await world.run('waitlist.expire');
      const row = await world.entryRow(entry.id);
      expect(row['consecutive_expired']).toBe(round);
      expect(row['flagged_at'] !== null).toBe(round === 3);
    }

    const flagged = await world.api.get('/waitlist?unresponsive=true', world.reception);
    expect(flagged.json<{ entries: { id: string; unresponsive: boolean }[] }>().entries).toEqual([
      expect.objectContaining({ id: entry.id, unresponsive: true }),
    ]);
  });

  it('expires the offers that are due when the minutely sweep runs, and closes entries that ran out', async () => {
    const { entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    await world.run('waitlist.offer');
    const stale = await world.join(await world.patient());
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE waitlist_entry SET expires_at = ${START.toISOString()}::timestamptz WHERE id = ${stale.id}`,
      ),
    );
    await world.advance(45 * MINUTE);
    // The sweep carries no offer: it looks at everything that is due.
    world.jobs.jobs.length = 0;
    await world.inTenant((tx) =>
      world.jobs.enqueue(tx, 'waitlist.expire', { tenantId: world.tenant.id }),
    );

    await world.run('waitlist.expire');

    expect((await world.offersOf(entry.id))[0]).toMatchObject({ status: 'expired' });
    expect(await world.entryRow(stale.id)).toMatchObject({
      status: 'closed',
      close_reason: 'expired',
    });
  });
});

describe('when the slot is close', () => {
  /** Cancels an appointment `minutes` before it starts, as the receptionist signing in then. */
  async function cancelWhenClose(minutes: number) {
    const weeks = nextWeek();
    const entries = await waiting(1);
    const booked = await world.book(weeks, '10:00');
    const before = world.now();
    await world.setNow(new Date(at(booked.startsAt) - minutes * MINUTE));
    await world.cancel(booked, await world.signIn(world.reception.user));
    await world.run('waitlist.match');
    return { entries, booked, restore: () => world.setNow(before) };
  }

  it('shortens the offer so that an hour is left before the start', async () => {
    const { entries, restore } = await cancelWhenClose(75);
    try {
      const [offer] = await world.offersOf(entries[0]?.id ?? '');

      // 75 minutes away: the last moment to answer is 15 minutes from now.
      expect(asMs(offer?.['expires_at']) - asMs(offer?.['created_at'])).toBe(15 * MINUTE);
    } finally {
      await restore();
    }
  });

  it('keeps the whole window when the slot is 90 minutes away', async () => {
    const { entries, restore } = await cancelWhenClose(90);
    try {
      const [offer] = await world.offersOf(entries[0]?.id ?? '');

      expect(asMs(offer?.['expires_at']) - asMs(offer?.['created_at'])).toBe(30 * MINUTE);
    } finally {
      await restore();
    }
  });
});

describe('quiet hours', () => {
  it('defers an offer that falls at night to 08:00 and gives it a window that keeps the lead time', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    // A visit at 12:00 on Monday; it is cancelled at 22:00 the night before (Buenos Aires).
    const booked = await world.book(weeks, '12:00');
    const before = world.now();
    const night = new Date(`${world.monday(weeks)}T01:00:00.000Z`);
    await world.setNow(night);
    try {
      await world.cancel(booked, await world.signIn(world.reception.user));
      await world.run('waitlist.match');

      const [offer] = await world.offersOf(entry.id);
      // 08:00 local is 11:00 UTC; the offer then lasts the 30 minutes.
      expect(asMs(offer?.['send_at'])).toBe(at(`${world.monday(weeks)}T11:00:00.000Z`));
      expect(asMs(offer?.['expires_at'])).toBe(at(`${world.monday(weeks)}T11:30:00.000Z`));
      const queued = world.jobs.pending('waitlist.offer')[0];
      expect(new Date(queued?.options.startAfter as Date).getTime()).toBe(
        at(`${world.monday(weeks)}T11:00:00.000Z`),
      );
    } finally {
      await world.setNow(before);
    }
  });

  it('does not send an offer that cannot be deferred without breaking the lead time', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    // A visit at 09:00 on Monday, cancelled at 22:00 the night before: 08:00 leaves one hour.
    const booked = await world.book(weeks, '09:00');
    const before = world.now();
    await world.setNow(new Date(`${world.monday(weeks)}T01:00:00.000Z`));
    try {
      await world.cancel(booked, await world.signIn(world.reception.user));
      await world.run('waitlist.match');

      expect(await world.offersOf(entry.id)).toEqual([]);
      expect((await world.callsOf(entry.id))[0]).toMatchObject({ reason: 'quiet_hours' });
    } finally {
      await world.setNow(before);
    }
  });
});

describe('quiet hours decided by the notifications module', () => {
  it('queues the offer again for the end of quiet hours and sends nothing meanwhile', async () => {
    const { entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    const end = new Date(world.now().getTime() + 10 * MINUTE);
    world.quietHoursEnd.current = end;

    await world.run('waitlist.offer');

    expect(world.deliveries).toEqual([]);
    const queued = world.jobs.pending('waitlist.offer');
    expect(queued.map((job) => new Date(job.options.startAfter as Date).getTime())).toEqual([
      end.getTime(),
    ]);
    expect((await world.offersOf(entry.id))[0]).toMatchObject({
      status: 'open',
      delivered_at: null,
    });
    expect(await world.entryRow(entry.id)).toMatchObject({ manual_contact_only: false });

    // Quiet hours are over: the same offer is delivered.
    world.quietHoursEnd.current = null;
    await world.setNow(end);
    await world.run('waitlist.offer');
    expect(world.deliveries).toHaveLength(1);
  });

  it('does not count a none that came with quiet hours as an unreachable patient', async () => {
    const { entries } = await offered();
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    // Not in quiet hours when asked, in them when the message is handed over.
    const end = new Date(world.now().getTime() + 10 * MINUTE);
    world.quietHoursEnd.script.push(null, end);
    world.deliveryChannel.current = 'none';

    await world.run('waitlist.offer');

    expect((await world.offersOf(entry.id))[0]).toMatchObject({
      status: 'open',
      delivered_at: null,
    });
    expect(await world.entryRow(entry.id)).toMatchObject({
      manual_contact_only: false,
      manual_reason: null,
    });
    expect(await world.callsOf(entry.id)).toEqual([]);
    expect(world.jobs.pending('waitlist.offer')).toHaveLength(1);
  });

  it('ends the offer for reception and offers the slot on when quiet hours outlast it', async () => {
    const weeks = nextWeek();
    const [late, next] = await waiting(2);
    if (!late || !next) throw new Error('entries missing');
    const booked = await world.book(weeks, '10:00');
    await world.cancel(booked);
    await world.run('waitlist.match');
    world.quietHoursEnd.script.push(new Date(world.now().getTime() + 6 * 60 * MINUTE));

    await world.run('waitlist.offer');

    expect(world.deliveries).toEqual([]);
    expect((await world.offersOf(late.id))[0]).toMatchObject({
      status: 'invalidated',
      end_reason: 'undeliverable',
    });
    // The patient is reachable: the entry is not made manual-contact-only.
    expect(await world.entryRow(late.id)).toMatchObject({ manual_contact_only: false });
    expect((await world.callsOf(late.id))[0]).toMatchObject({ reason: 'quiet_hours' });
    expect(world.jobs.pending('waitlist.match').length).toBeGreaterThan(0);
  });
});
