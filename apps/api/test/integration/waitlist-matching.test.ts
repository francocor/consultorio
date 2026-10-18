import { randomUUID } from 'node:crypto';

import type { BlockDto } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { slotHold } from '../../src/db/schema/scheduling.js';
import { waitlistEntry } from '../../src/db/schema/waitlist.js';
import { createSchedulingPorts, createHold } from '../../src/modules/scheduling/index.js';
import { matchFreedSlot } from '../../src/modules/waitlist/application/match.js';
import { createOffer } from '../../src/modules/waitlist/application/offers.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWaitlistWorld, type WaitlistWorld } from '../support/waitlist-world.js';

let runtime: DbHandle;
let world: WaitlistWorld;

const START = new Date('2031-05-05T12:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createWaitlistWorld(runtime, { slug: 'waitlist-matching', now: START });
  // Each test books a week of its own, so entries have to outlive the weeks the file goes through.
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
/** A week of its own for each test, so the slots of one never touch another's. */
const nextWeek = () => {
  week += 1;
  return week;
};

/** Three patients join the waitlist, a minute apart, oldest first. */
async function waiting(count: number, extra: Record<string, unknown> = {}) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    await world.advance(60_000);
    entries.push(await world.join(await world.patient(), extra));
  }
  return entries;
}

describe('a cancellation frees a slot', () => {
  it('offers it to the entry that has waited longest, one offer at a time', async () => {
    const weeks = nextWeek();
    const [oldest, middle, newest] = await waiting(3);
    if (!oldest || !middle || !newest) throw new Error('entries missing');
    const booked = await world.book(weeks, '10:00');

    await world.cancel(booked);

    const queued = world.jobs.pending('waitlist.match');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload).toMatchObject({
      tenantId: world.tenant.id,
      professionalId: world.doctor.professionalId,
      locationId: world.centro,
      startsAt: booked.startsAt,
      endsAt: booked.endsAt,
      cause: 'cancelled',
    });

    await world.run('waitlist.match');

    const offered = await world.offersOf(oldest.id);
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({
      status: 'open',
      professional_id: world.doctor.professionalId,
      location_id: world.centro,
      appointment_type_id: world.consulta,
    });
    expect(new Date(offered[0]?.['starts_at'] as string).toISOString()).toBe(booked.startsAt);
    expect(await world.entryRow(oldest.id)).toMatchObject({ status: 'offered' });
    expect(await world.offersOf(middle.id)).toEqual([]);
    expect(await world.offersOf(newest.id)).toEqual([]);
    expect(await world.entryRow(middle.id)).toMatchObject({ status: 'active' });
    // The offer then goes out by its own job.
    expect(world.jobs.pending('waitlist.offer')).toHaveLength(1);
  });

  it('puts the organization override before the wait, and audits that it was offered first', async () => {
    const weeks = nextWeek();
    const [waited, urgent] = await waiting(2);
    if (!waited || !urgent) throw new Error('entries missing');
    const set = await world.api.post(`/waitlist/${urgent.id}/priority`, world.reception, {
      priority: 1,
    });
    expect(set.statusCode, set.body).toBe(200);

    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');

    expect(await world.offersOf(urgent.id)).toHaveLength(1);
    expect(await world.offersOf(waited.id)).toEqual([]);
  });

  it('does not offer a morning slot to an entry that accepts only afternoons', async () => {
    const weeks = nextWeek();
    await world.advance(60_000);
    const afternoon = await world.join(await world.patient(), {
      timeRanges: [{ from: '14:00', to: '18:00' }],
    });
    await world.advance(60_000);
    const anyTime = await world.join(await world.patient());

    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');

    expect(await world.offersOf(afternoon.id)).toEqual([]);
    expect(await world.offersOf(anyTime.id)).toHaveLength(1);
  });

  it('does not offer a slot to an entry that wants another professional', async () => {
    const weeks = nextWeek();
    await world.advance(60_000);
    const wantsColleague = await world.join(await world.patient(), {
      professionalId: world.colleague.professionalId,
    });
    await world.advance(60_000);
    const wantsDoctor = await world.join(await world.patient(), {
      professionalId: world.doctor.professionalId,
    });

    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');

    expect(await world.offersOf(wantsColleague.id)).toEqual([]);
    expect(await world.offersOf(wantsDoctor.id)).toHaveLength(1);
  });

  it('skips a patient who has another appointment at that time', async () => {
    const weeks = nextWeek();
    const busyPatient = await world.patient();
    await world.advance(60_000);
    const busy = await world.join(busyPatient);
    await world.advance(60_000);
    const free = await world.join(await world.patient());
    const response = await world.api.post(
      '/appointments',
      world.reception,
      await world.bookingBody(weeks, '10:00', {
        patientId: busyPatient,
        professionalId: world.colleague.professionalId,
      }),
    );
    expect(response.statusCode, response.body).toBe(201);

    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');

    expect(await world.offersOf(busy.id)).toEqual([]);
    expect(await world.offersOf(free.id)).toHaveLength(1);
  });

  it('offers nothing when no entry matches, and does not offer a paused or expired entry', async () => {
    const weeks = nextWeek();
    await world.advance(60_000);
    const paused = await world.join(await world.patient());
    await world.api.post(`/waitlist/${paused.id}/pause`, world.reception, {});
    await world.advance(60_000);
    const expired = await world.join(await world.patient());
    await world.inTenant(async (tx) => {
      await tx.execute(
        sql`UPDATE waitlist_entry SET expires_at = ${START.toISOString()}::timestamptz WHERE id = ${expired.id}`,
      );
    });

    await world.cancel(await world.book(weeks, '10:00'));
    const results = await world.run('waitlist.match');

    expect(results).toHaveLength(1);
    expect(await world.offersOf(paused.id)).toEqual([]);
    expect(await world.offersOf(expired.id)).toEqual([]);
  });

  it('keeps a single open offer for a slot however many times it is matched', async () => {
    const weeks = nextWeek();
    const [first, second] = await waiting(2);
    if (!first || !second) throw new Error('entries missing');
    const booked = await world.book(weeks, '10:00');
    await world.cancel(booked);
    await world.run('waitlist.match');

    // The same event arrives again (a retry, a second cancellation of the same range).
    const [again] = world.jobs.jobs.filter((job) => job.name === 'waitlist.match');
    if (!again) throw new Error('no job');
    world.jobs.jobs.push({ ...again, id: randomUUID(), done: false });
    await world.run('waitlist.match');

    expect(await world.offersOf(first.id)).toHaveLength(1);
    expect(await world.offersOf(second.id)).toEqual([]);
  });

  it('audits the offer it creates with the system as the actor', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');

    const [offer] = await world.offersOf(entry.id);
    const rows = await world.inTenant(async (tx) => {
      return (
        await tx.execute<{ action: string; actor_user_id: string | null }>(
          sql`SELECT action, actor_user_id FROM audit_event WHERE resource_id = ${String(offer?.['id'])}`,
        )
      ).rows;
    });
    expect(rows).toEqual([{ action: 'waitlist.offer.created', actor_user_id: null }]);
  });
});

describe('other ways a slot comes free', () => {
  it('matches a slot left by an appointment that was moved away', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    const booked = await world.book(weeks, '10:00');

    const moved = await world.act(booked, 'reschedule', world.reception, {
      local: { date: world.monday(weeks), time: '11:00' },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    expect(world.jobs.pending('waitlist.match')[0]?.payload).toMatchObject({
      cause: 'rescheduled',
      startsAt: booked.startsAt,
    });
    await world.run('waitlist.match');
    const [offer] = await world.offersOf(entry.id);
    expect(new Date(offer?.['starts_at'] as string).toISOString()).toBe(booked.startsAt);
  });

  it('matches the time under a block that was removed', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    const date = world.monday(weeks);
    const block = await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.doctor.professionalId,
      startsAt: `${date}T13:00:00.000Z`,
      endsAt: `${date}T14:00:00.000Z`,
      reason: 'Curso',
    });
    expect(block.statusCode, block.body).toBe(201);
    const [created] = block.json<{ blocks: BlockDto[] }>().blocks;

    const removed = await world.api.delete(`/schedule-blocks/${created?.id ?? ''}`, world.owner);
    expect(removed.statusCode, removed.body).toBe(204);

    expect(world.jobs.pending('waitlist.match')[0]?.payload).toMatchObject({
      cause: 'block_removed',
      professionalId: world.doctor.professionalId,
      locationId: null,
    });
    await world.run('waitlist.match');
    const [offer] = await world.offersOf(entry.id);
    // A 30 minute visit fits twice in the hour; the first free time is offered.
    expect(new Date(offer?.['starts_at'] as string).toISOString()).toBe(`${date}T13:00:00.000Z`);
    expect(new Date(offer?.['ends_at'] as string).toISOString()).toBe(`${date}T13:30:00.000Z`);
  });

  it('does not match a hold that ran out: nobody gave that time back', async () => {
    const weeks = nextWeek();
    await waiting(1);
    const hold = await world.inTenant((tx) =>
      createHold(createSchedulingPorts(tx, { keys: world.keys, events: world.events }), {
        request: {
          professionalId: world.doctor.professionalId,
          locationId: world.centro,
          appointmentTypeId: world.consulta,
          local: { date: world.monday(weeks), time: '10:00' },
        },
        actor: { userId: world.reception.user.id, permissions: new Set(), professionalId: null },
        now: world.now(),
        origin: 'public',
        sourceKey: 'waitlist-matching-session',
      }),
    );
    await world.inTenant((tx) =>
      tx
        .update(slotHold)
        .set({ expiresAt: new Date('2020-01-01T00:00:00.000Z') })
        .where(eq(slotHold.id, hold.id)),
    );

    // Somebody books the same time: the lazy expiry of the hold runs, and publishes nothing.
    await world.book(weeks, '10:00');

    expect(world.jobs.pending('waitlist.match')).toEqual([]);
  });
});

describe('a slot that is taken before anybody answers', () => {
  it('invalidates the open offer when reception books the slot directly', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    const booked = await world.book(weeks, '10:00');
    await world.cancel(booked);
    await world.run('waitlist.match');
    expect(await world.entryRow(entry.id)).toMatchObject({ status: 'offered' });

    // Reception books somebody else into the same time.
    const taken = await world.book(weeks, '10:00');

    const [offer] = await world.offersOf(entry.id);
    expect(offer).toMatchObject({ status: 'invalidated', end_reason: 'slot_taken' });
    expect(offer?.['closed_at']).not.toBeNull();
    // The patient goes on waiting for the next slot.
    expect(await world.entryRow(entry.id)).toMatchObject({ status: 'active' });
    expect(taken.id).not.toBe(booked.id);
  });

  it('leaves an offer for another time alone', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');

    await world.book(weeks, '11:30');

    const [offer] = await world.offersOf(entry.id);
    expect(offer).toMatchObject({ status: 'open', end_reason: null });
  });

  it('invalidates the offer when an appointment is moved into the slot', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');
    const other = await world.book(weeks, '12:00');

    const moved = await world.act(other, 'reschedule', world.reception, {
      local: { date: world.monday(weeks), time: '10:00' },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const [offer] = await world.offersOf(entry.id);
    expect(offer).toMatchObject({ status: 'invalidated', end_reason: 'slot_taken' });
  });
});

describe('entries that reception has to call', () => {
  it('shows a manual contact only entry the slot instead of offering it', async () => {
    const weeks = nextWeek();
    await world.advance(60_000);
    const manual = await world.join(await world.patient(), { offersOptIn: false });
    await world.advance(60_000);
    const automatic = await world.join(await world.patient());
    const booked = await world.book(weeks, '10:00');

    await world.cancel(booked);
    await world.run('waitlist.match');

    expect(await world.offersOf(manual.id)).toEqual([]);
    expect(await world.offersOf(automatic.id)).toHaveLength(1);
    const calls = await world.callsOf(manual.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      reason: 'manual_contact_only',
      professional_id: world.doctor.professionalId,
      location_id: world.centro,
    });
    expect(new Date(calls[0]?.['starts_at'] as string).toISOString()).toBe(booked.startsAt);
    // And the reception worklist gets its pointer.
    const items = await world.inTenant(async (tx) => {
      return (
        await tx.execute(
          sql`SELECT kind, subject_type, status FROM worklist_item WHERE subject_id = ${manual.id}`,
        )
      ).rows;
    });
    expect(items).toEqual([
      { kind: 'waitlist_manual_contact', subject_type: 'waitlist_entry', status: 'open' },
    ]);
  });

  it('shows the matching entries a slot that starts too soon for an automated offer', async () => {
    const weeks = nextWeek();
    const [first, second] = await waiting(2);
    if (!first || !second) throw new Error('entries missing');
    const booked = await world.book(weeks, '10:00');
    const before = world.now();
    try {
      // Thirty minutes before the start; the organization wants an hour.
      await world.setNow(new Date(new Date(booked.startsAt).getTime() - 30 * 60_000));

      // The clock moved days: a new session, as the receptionist signing in that morning.
      await world.cancel(booked, await world.signIn(world.reception.user));
      await world.run('waitlist.match');

      expect(await world.offersOf(first.id)).toEqual([]);
      expect(await world.offersOf(second.id)).toEqual([]);
      expect((await world.callsOf(first.id))[0]).toMatchObject({ reason: 'slot_too_close' });
      expect((await world.callsOf(second.id))[0]).toMatchObject({ reason: 'slot_too_close' });
      expect(await world.entryRow(first.id)).toMatchObject({ status: 'active' });
    } finally {
      await world.setNow(before);
    }
  });

  it('turns an entry whose patient opted out since into manual contact only, and shows it', async () => {
    const weeks = nextWeek();
    const patientId = await world.patient();
    await world.advance(60_000);
    const entry = await world.join(patientId);
    await world.inTenant(async (tx) => {
      await tx.execute(
        sql`INSERT INTO channel_preference (tenant_id, patient_id, channel, state, source)
              VALUES (${world.tenant.id}, ${patientId}, 'email', 'opted_out', 'email_link')`,
      );
    });

    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');

    expect(await world.offersOf(entry.id)).toEqual([]);
    expect(await world.entryRow(entry.id)).toMatchObject({
      manual_contact_only: true,
      manual_reason: 'patient_opted_out',
      status: 'active',
    });
    expect(await world.callsOf(entry.id)).toHaveLength(1);
  });
});

describe('matches that do not run side by side (JD-S3 B28)', () => {
  const lockOf = (professionalId: string) =>
    sql`select pg_advisory_xact_lock(hashtextextended(${professionalId}, 361))`;

  it('makes a match of every professional wait for the match of one of them', async () => {
    const weeks = nextWeek();
    await waiting(1);
    const booked = await world.book(weeks, '10:00');
    await world.cancel(booked);
    const range = {
      professionalId: null,
      locationId: null,
      startsAt: new Date(booked.startsAt),
      endsAt: new Date(booked.endsAt),
    };
    let released!: () => void;
    const hold = new Promise<void>((resolve) => {
      released = resolve;
    });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    // A match of one professional is in the middle of its work: it holds that professional's lock.
    const first = world.inTenant(async (tx) => {
      await tx.execute(lockOf(world.doctor.professionalId));
      holding();
      await hold;
    });
    await held;

    let finished = false;
    const second = world
      .inTenant((tx) =>
        matchFreedSlot(
          tx,
          {
            portsOf: (inner) => createSchedulingPorts(inner, { keys: world.keys }),
            jobs: world.jobs,
          },
          { ...range, now: world.now() },
        ),
      )
      .then(() => {
        finished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const waitedForTheLock = !finished;
    released();
    await Promise.all([first, second]);

    expect(waitedForTheLock).toBe(true);
  });
});

describe('an offer for an entry that stopped waiting (JD-S3 B20)', () => {
  it('is not made: the entry was closed between the match reading it and offering it', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    const booked = await world.book(weeks, '10:00');
    const read = await world.inTenant(
      async (tx) =>
        (await tx.select().from(waitlistEntry).where(eq(waitlistEntry.id, entry.id)))[0],
    );
    if (!read) throw new Error('entry row missing');
    // Reception closes the entry after the match read it.
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE waitlist_entry SET status = 'closed', close_reason = 'cancelled', closed_at = now() WHERE id = ${entry.id}`,
      ),
    );

    const offer = await world.inTenant((tx) =>
      createOffer(
        tx,
        { jobs: world.jobs },
        {
          entry: read,
          professionalId: world.doctor.professionalId,
          locationId: world.centro,
          startsAt: new Date(booked.startsAt),
          endsAt: new Date(booked.endsAt),
          freed: { startsAt: new Date(booked.startsAt), endsAt: new Date(booked.endsAt) },
          sendAt: world.now(),
          expiresAt: new Date(world.now().getTime() + 30 * 60_000),
          now: world.now(),
        },
      ),
    );

    expect(offer).toBeNull();
    expect(await world.offersOf(entry.id)).toEqual([]);
    expect(world.jobs.pending('waitlist.offer')).toEqual([]);
  });
});

describe('a booking made and cancelled at once does not stir the waitlist (JD-S3 A8)', () => {
  /** An appointment that came from the public booking page, created `minutesAgo` before now. */
  async function onlineBooking(minutesAgo: number) {
    const weeks = nextWeek();
    await waiting(1);
    const booked = await world.book(weeks, '10:00');
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE appointment SET source = 'online',
                   created_at = ${new Date(world.now().getTime() - minutesAgo * 60_000).toISOString()}::timestamptz
             WHERE id = ${booked.id}`,
      ),
    );
    world.jobs.jobs.length = 0;
    return booked;
  }

  it('queues no match when an online booking is cancelled within 30 minutes of being made', async () => {
    const booked = await onlineBooking(10);

    await world.cancel(booked);

    expect(world.jobs.pending('waitlist.match')).toEqual([]);
  });

  it('queues the match when the online booking had stood for longer, and for a booking of staff at any time', async () => {
    const later = await onlineBooking(31);
    await world.cancel(later);
    expect(world.jobs.pending('waitlist.match')).toHaveLength(1);

    const weeks = nextWeek();
    const staff = await world.book(weeks, '11:00');
    world.jobs.jobs.length = 0;
    await world.cancel(staff);
    expect(world.jobs.pending('waitlist.match')).toHaveLength(1);
  });

  it('stops offering the same slot after five offers that were not taken', async () => {
    const weeks = nextWeek();
    const entries = await waiting(7);
    const booked = await world.book(weeks, '10:00');
    await world.cancel(booked);

    for (let round = 0; round < 7; round += 1) {
      await world.run('waitlist.match');
      await world.run('waitlist.offer');
      const open = (
        await Promise.all(
          entries.map(async (entry) => ({ entry, offers: await world.offersOf(entry.id) })),
        )
      ).flatMap(({ offers }) => offers.filter((offer) => offer['status'] === 'open'));
      const offer = open[0];
      if (!offer) break;
      await world.press(world.tokenOf(String(offer['id'])), 'decline');
    }

    const made = (await Promise.all(entries.map((entry) => world.offersOf(entry.id)))).flat();
    expect(made).toHaveLength(5);
  });
});
