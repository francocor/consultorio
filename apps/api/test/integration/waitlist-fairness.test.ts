import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { tenant } from '../../src/db/schema/tenant.js';
import {
  closeEntriesOfOptedOutPatient,
  waitlistOutcomes,
} from '../../src/modules/waitlist/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWaitlistWorld, type WaitlistWorld } from '../support/waitlist-world.js';

/**
 * Opting out, fairness and what is kept for the reports: the rules that protect the patients on the
 * list from being offered a slot twice, from being written to against their will, and from losing
 * their place without a trace.
 */

const START = new Date('2031-05-05T12:00:00.000Z');
const MINUTE = 60_000;

let runtime: DbHandle;
let world: WaitlistWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createWaitlistWorld(runtime, { slug: 'waitlist-fairness', now: START });
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

/** A slot is freed and offered to the first entry in line (match done, not delivered yet). */
async function offered(count: number) {
  const weeks = nextWeek();
  const entries = await waiting(count);
  const booked = await world.book(weeks, '10:00');
  await world.cancel(booked);
  await world.run('waitlist.match');
  return { weeks, entries, booked };
}

const auditOf = (resourceId: string) =>
  world.inTenant(
    async (tx) =>
      (
        await tx.execute<{ action: string; metadata: Record<string, unknown> }>(
          sql`SELECT action, metadata FROM audit_event
                WHERE resource_id = ${resourceId} ORDER BY occurred_at, id`,
        )
      ).rows,
  );

describe('a patient who asks to stop', () => {
  it('leaves every entry of theirs at once, ends the offer in flight and passes the slot on', async () => {
    const weeks = nextWeek();
    const patientId = await world.patient();
    await world.advance(MINUTE);
    const first = await world.join(patientId);
    await world.advance(MINUTE);
    const second = await world.join(patientId, { professionalId: world.doctor.professionalId });
    await world.advance(MINUTE);
    const next = await world.join(await world.patient());
    const booked = await world.book(weeks, '10:00');
    await world.cancel(booked);
    await world.run('waitlist.match');
    expect((await world.offersOf(first.id)).length + (await world.offersOf(second.id)).length).toBe(
      1,
    );

    // The patient replies "BAJA": messaging records the opt-out and tells the waitlist.
    const closed = await world.inTenant((tx) =>
      closeEntriesOfOptedOutPatient(tx, { patientId, now: world.now(), jobs: world.jobs }),
    );

    expect(closed).toBe(2);
    for (const entry of [first, second]) {
      expect(await world.entryRow(entry.id)).toMatchObject({
        status: 'closed',
        close_reason: 'patient_opted_out',
      });
      const trail = await auditOf(entry.id);
      expect(trail.find((row) => row.action === 'waitlist.entry.closed')?.metadata).toMatchObject({
        reason: 'patient_opted_out',
      });
    }
    const offers = [...(await world.offersOf(first.id)), ...(await world.offersOf(second.id))];
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ status: 'invalidated', end_reason: 'patient_opted_out' });
    // The next entry is offered the slot, and the patient who left is not offered anything again.
    await world.run('waitlist.match');
    expect(await world.offersOf(next.id)).toHaveLength(1);
    const anotherWeek = nextWeek();
    await world.cancel(await world.book(anotherWeek, '10:00'));
    await world.run('waitlist.match');
    expect(await world.offersOf(first.id)).toHaveLength(1);
    expect(await world.offersOf(second.id)).toHaveLength(0);
  });

  it('leaves entries of other patients alone, and an entry that was already closed', async () => {
    const [stays] = await waiting(1);
    const patientId = await world.patient();
    await world.advance(MINUTE);
    const gone = await world.join(patientId);
    await world.api.post(`/waitlist/${gone.id}/close`, world.reception, { reason: 'cancelled' });

    const closed = await world.inTenant((tx) =>
      closeEntriesOfOptedOutPatient(tx, { patientId, now: world.now() }),
    );

    expect(closed).toBe(0);
    expect(await world.entryRow(stays?.id ?? '')).toMatchObject({ status: 'active' });
    expect(await world.entryRow(gone.id)).toMatchObject({ close_reason: 'cancelled' });
  });
});

describe('while the organization is read-only', () => {
  it('sends no offer: the match and the delivery are cancelled', async () => {
    const weeks = nextWeek();
    const [entry] = await waiting(1);
    if (!entry) throw new Error('entry missing');
    await world.cancel(await world.book(weeks, '10:00'));
    const set = (status: 'active' | 'read_only') =>
      world.inTenant((tx) =>
        tx
          .update(tenant)
          .set({ status, readOnlySince: status === 'read_only' ? new Date() : null })
          .where(eq(tenant.id, world.tenant.id)),
      );
    await set('read_only');
    try {
      const results = await world.run('waitlist.match');

      expect(results.map((row) => row.result)).toEqual([
        { status: 'cancelled', reason: 'tenant_read_only' },
      ]);
      expect(await world.offersOf(entry.id)).toEqual([]);
    } finally {
      await set('active');
    }
  });

  it('does not deliver an offer that was made before the organization became read-only', async () => {
    const { entries } = await offered(1);
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    const set = (status: 'active' | 'read_only') =>
      world.inTenant((tx) =>
        tx
          .update(tenant)
          .set({ status, readOnlySince: status === 'read_only' ? new Date() : null })
          .where(eq(tenant.id, world.tenant.id)),
      );
    // The offer job was queued before the organization stopped being active.
    await world.advance(MINUTE);
    await set('read_only');
    try {
      const results = await world.run('waitlist.offer');

      expect(results.map((row) => row.result)).toEqual([
        { status: 'cancelled', reason: 'tenant_read_only' },
      ]);
      expect(world.deliveries).toEqual([]);
    } finally {
      await set('active');
    }
  });
});

describe('no second offer for the same patient and slot', () => {
  it('offers a patient with two fitting entries the slot once', async () => {
    const weeks = nextWeek();
    const patientId = await world.patient();
    await world.advance(MINUTE);
    const anyDoctor = await world.join(patientId);
    await world.advance(MINUTE);
    const thisDoctor = await world.join(patientId, {
      professionalId: world.doctor.professionalId,
    });
    await world.advance(MINUTE);
    const other = await world.join(await world.patient());

    await world.cancel(await world.book(weeks, '10:00'));
    await world.run('waitlist.match');

    // One offer, through the entry that has waited longer; the other entry of the patient waits.
    expect(await world.offersOf(anyDoctor.id)).toHaveLength(1);
    expect(await world.offersOf(thisDoctor.id)).toEqual([]);
    expect(await world.offersOf(other.id)).toEqual([]);

    // The patient declines: not the other entry, and not the same slot again.
    await world.run('waitlist.offer');
    const [offer] = await world.offersOf(anyDoctor.id);
    const declined = await world.press(world.tokenOf(String(offer?.['id'])), 'decline');
    expect(declined.statusCode, declined.body).toBe(200);
    await world.run('waitlist.match');
    expect(await world.offersOf(thisDoctor.id)).toEqual([]);
    expect(await world.offersOf(other.id)).toHaveLength(1);
  });

  it('offers nothing again for a slot freed once more by a move, to the patient who declined it', async () => {
    const { entries, booked, weeks } = await offered(2);
    const [first, second] = entries;
    if (!first || !second) throw new Error('entries missing');
    await world.run('waitlist.offer');
    const [offer] = await world.offersOf(first.id);
    await world.press(world.tokenOf(String(offer?.['id'])), 'decline');
    await world.run('waitlist.match');
    expect(await world.offersOf(second.id)).toHaveLength(1);

    // The same range is freed again (the appointment taken by the second patient is moved away).
    await world.run('waitlist.offer');
    const [secondOffer] = await world.offersOf(second.id);
    await world.press(world.tokenOf(String(secondOffer?.['id'])), 'decline');
    await world.inTenant((tx) =>
      world.jobs.enqueue(tx, 'waitlist.match', {
        tenantId: world.tenant.id,
        professionalId: world.doctor.professionalId,
        locationId: world.centro,
        startsAt: booked.startsAt,
        endsAt: booked.endsAt,
        cause: 'rescheduled',
      }),
    );
    await world.run('waitlist.match');

    expect(await world.offersOf(first.id)).toHaveLength(1);
    expect(await world.offersOf(second.id)).toHaveLength(1);
    expect(weeks).toBeGreaterThan(0);
  });
});

describe('an entry that stops waiting while its offer is open', () => {
  it('ends the offer and offers the slot to the next entry when reception pauses it', async () => {
    const { entries } = await offered(2);
    const [first, second] = entries;
    if (!first || !second) throw new Error('entries missing');

    const paused = await world.api.post(`/waitlist/${first.id}/pause`, world.reception, {});
    expect(paused.statusCode, paused.body).toBe(200);
    await world.run('waitlist.match');

    expect((await world.offersOf(first.id))[0]).toMatchObject({
      status: 'invalidated',
      end_reason: 'entry_closed',
    });
    expect(await world.offersOf(second.id)).toHaveLength(1);
  });

  it('ends the offer and offers the slot on when reception closes the entry', async () => {
    const { entries } = await offered(2);
    const [first, second] = entries;
    if (!first || !second) throw new Error('entries missing');

    await world.api.post(`/waitlist/${first.id}/close`, world.reception, { reason: 'fulfilled' });
    await world.run('waitlist.match');

    expect((await world.offersOf(first.id))[0]).toMatchObject({ status: 'invalidated' });
    expect(await world.offersOf(second.id)).toHaveLength(1);
  });

  it('ends the offer and offers the slot on when the entry itself runs out of time', async () => {
    const { entries } = await offered(2);
    const [first, second] = entries;
    if (!first || !second) throw new Error('entries missing');
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE waitlist_entry SET expires_at = ${START.toISOString()}::timestamptz WHERE id = ${first.id}`,
      ),
    );
    await world.inTenant((tx) =>
      world.jobs.enqueue(tx, 'waitlist.expire', { tenantId: world.tenant.id }),
    );

    await world.run('waitlist.expire');
    await world.run('waitlist.match');

    expect(await world.entryRow(first.id)).toMatchObject({
      status: 'closed',
      close_reason: 'expired',
    });
    expect((await world.offersOf(first.id))[0]).toMatchObject({ status: 'invalidated' });
    expect(await world.offersOf(second.id)).toHaveLength(1);
  });
});

describe('what is kept for the reports', () => {
  it('counts the offers by outcome, the slots recovered and how long patients take to answer', async () => {
    const before = await world.inTenant((tx) =>
      waitlistOutcomes(tx, {
        from: new Date(START.getTime() - 86_400_000),
        to: new Date(START.getTime() + 400 * 86_400_000),
      }),
    );
    // Three offers: one accepted after 4 minutes, one declined after 10, one that expires.
    const weeks = nextWeek();
    const [a, b, c] = await waiting(3);
    if (!a || !b || !c) throw new Error('entries missing');
    const booked = await world.book(weeks, '10:00');
    await world.cancel(booked);
    await world.run('waitlist.match');
    await world.run('waitlist.offer');
    await world.advance(10 * MINUTE);
    const [declinedOffer] = await world.offersOf(a.id);
    await world.press(world.tokenOf(String(declinedOffer?.['id'])), 'decline');
    await world.run('waitlist.match');
    await world.run('waitlist.offer');
    await world.advance(4 * MINUTE);
    const [acceptedOffer] = await world.offersOf(b.id);
    const accepted = await world.press(world.tokenOf(String(acceptedOffer?.['id'])), 'accept');
    expect(accepted.statusCode, accepted.body).toBe(200);

    // A third slot: its offer expires.
    const other = nextWeek();
    await world.cancel(await world.book(other, '10:00'));
    await world.run('waitlist.match');
    await world.run('waitlist.offer');
    await world.advance(31 * MINUTE);
    await world.run('waitlist.expire');

    const after = await world.inTenant((tx) =>
      waitlistOutcomes(tx, {
        from: new Date(START.getTime() - 86_400_000),
        to: new Date(START.getTime() + 400 * 86_400_000),
      }),
    );
    expect(after.offers - before.offers).toBe(3);
    expect(after.accepted - before.accepted).toBe(1);
    expect(after.declined - before.declined).toBe(1);
    expect(after.expired - before.expired).toBe(1);
    // A slot recovered is an offer accepted that became an appointment.
    expect(after.recoveredSlots - before.recoveredSlots).toBe(1);
    expect(after.answeredOffers).toBeGreaterThanOrEqual(2);
    expect(after.averageResponseSeconds).toBeGreaterThan(0);
    expect(c.id).toBeDefined();
  });

  it('stores when each offer closed, so the response time is there for any report', async () => {
    const { entries } = await offered(1);
    const [entry] = entries;
    if (!entry) throw new Error('entry missing');
    await world.run('waitlist.offer');
    await world.advance(7 * MINUTE);
    const [offer] = await world.offersOf(entry.id);
    await world.press(world.tokenOf(String(offer?.['id'])), 'accept');

    const [row] = await world.offersOf(entry.id);

    expect(row).toMatchObject({ status: 'accepted' });
    expect(row?.['appointment_id']).not.toBeNull();
    const seconds =
      (new Date(row?.['closed_at'] as string).getTime() -
        new Date(row?.['created_at'] as string).getTime()) /
      1000;
    expect(seconds).toBe(7 * 60);
  });

  it('closes the entries of a patient who opts out through the channels of the patient, without anybody calling the waitlist (JD-S3 B3)', async () => {
    const patientId = await world.patient();
    await world.advance(MINUTE);
    const entry = await world.join(patientId);

    const response = await world.api.post(
      `/patients/${patientId}/channels/email/opt-out`,
      world.owner,
      {},
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(await world.entryRow(entry.id)).toMatchObject({
      status: 'closed',
      close_reason: 'patient_opted_out',
    });
  });
});
