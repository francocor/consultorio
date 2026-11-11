import type { WaitlistCallListResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWaitlistWorld, type WaitlistWorld } from '../support/waitlist-world.js';

/** The slots reception can fill by phone, with the entries to call. */

const START = new Date('2031-05-05T12:00:00.000Z');
const MINUTE = 60_000;

let runtime: DbHandle;
let world: WaitlistWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createWaitlistWorld(runtime, { slug: 'waitlist-calls', now: START });
  const settings = await world.api.patch('/settings', world.owner, {
    waitlist: { entryExpiryDays: 365 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  await world.inTenant((tx) =>
    tx.execute(
      sql`UPDATE membership SET display_name = 'Dra. Ríos' WHERE id = ${world.doctor.membershipId}`,
    ),
  );
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

const toCall = async (by = world.reception) => {
  const response = await world.api.get('/waitlist/to-call', by);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<WaitlistCallListResponse>();
};

/** A manual contact entry waits and a slot comes free: reception is shown the slot. */
async function shown() {
  const weeks = nextWeek();
  await world.advance(MINUTE);
  const entry = await world.join(await world.patient(), { offersOptIn: false });
  const booked = await world.book(weeks, '10:00');
  await world.cancel(booked);
  await world.run('waitlist.match');
  return { weeks, entry, booked };
}

describe('the slots to call', () => {
  it('lists a freed slot with the entry to call, how to reach the patient and where the slot is', async () => {
    const { entry, booked } = await shown();

    const { items } = await toCall();

    const mine = items.find((item) => item.entry.id === entry.id);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      reason: 'manual_contact_only',
      entry: { id: entry.id, manualContactOnly: true, manualReason: 'no_offers_opt_in' },
      slot: {
        startsAt: booked.startsAt,
        endsAt: booked.endsAt,
        professionalId: world.doctor.professionalId,
        professionalName: 'Dra. Ríos',
        locationId: world.centro,
        locationName: 'Centro',
        timeZone: 'America/Argentina/Buenos_Aires',
      },
    });
    const [item] = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`SELECT id FROM worklist_item WHERE subject_id = ${entry.id} AND status = 'open'`,
          )
        ).rows,
    );
    expect(mine?.contact.phone).toBe('+54 11 5555 0000');
    expect(mine?.contact.email).toMatch(/@example\.test$/);
    expect(mine?.worklistItemId).toBe(item?.id);
  });

  it('lists the soonest slot first', async () => {
    const first = await shown();
    const second = await shown();

    const { items } = await toCall();

    const ids = items.map((item) => item.entry.id);
    expect(ids.indexOf(first.entry.id)).toBeLessThan(ids.indexOf(second.entry.id));
  });

  it('stops listing a slot somebody booked', async () => {
    const { entry, weeks } = await shown();
    expect((await toCall()).items.map((item) => item.entry.id)).toContain(entry.id);

    await world.book(weeks, '10:00');

    expect((await toCall()).items.map((item) => item.entry.id)).not.toContain(entry.id);
  });

  it('stops listing a slot that already started', async () => {
    const { entry, booked } = await shown();

    await world.setNow(new Date(new Date(booked.startsAt).getTime() + MINUTE));

    expect((await toCall()).items.map((item) => item.entry.id)).not.toContain(entry.id);
  });

  it('stops listing it once reception settled the item of the worklist', async () => {
    const { entry } = await shown();
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE worklist_item SET status = 'resolved', resolution = 'handled', resolved_at = now(), resolved_by = gen_random_uuid()
              WHERE subject_id = ${entry.id}`,
      ),
    );

    expect((await toCall()).items.map((item) => item.entry.id)).not.toContain(entry.id);
  });

  it('stops listing the entries that are closed or paused', async () => {
    const closed = await shown();
    const paused = await shown();
    await world.api.post(`/waitlist/${closed.entry.id}/close`, world.reception, {
      reason: 'fulfilled',
    });
    await world.api.post(`/waitlist/${paused.entry.id}/pause`, world.reception, {});

    const ids = (await toCall()).items.map((item) => item.entry.id);

    expect(ids).not.toContain(closed.entry.id);
    expect(ids).not.toContain(paused.entry.id);
  });

  it('shows reception only the slots of the places it works at', async () => {
    const { entry } = await shown();
    const elsewhere = await world.inTenant(async (tx) => {
      const rows = (
        await tx.execute<{ id: string }>(
          sql`INSERT INTO waitlist_entry (tenant_id, patient_id, appointment_type_id, expires_at,
                                          offers_opt_in_at, offers_opt_in_source, offers_opt_in_by)
                VALUES (${world.tenant.id},
                        (SELECT id FROM patient WHERE tenant_id = ${world.tenant.id} LIMIT 1),
                        ${world.withBuffer}, now() + interval '30 days', NULL, NULL, NULL)
                RETURNING id`,
        )
      ).rows;
      const id = rows[0]?.id ?? '';
      await tx.execute(
        sql`UPDATE waitlist_entry SET manual_contact_only = true, manual_reason = 'no_offers_opt_in'
              WHERE id = ${id}`,
      );
      await tx.execute(
        sql`INSERT INTO waitlist_call (tenant_id, entry_id, professional_id, location_id,
                                       appointment_type_id, starts_at, ends_at, reason)
              VALUES (${world.tenant.id}, ${id}, ${world.doctor.professionalId}, ${world.norte},
                      ${world.withBuffer}, '2031-12-01T13:00:00Z', '2031-12-01T13:30:00Z',
                      'manual_contact_only')`,
      );
      await tx.execute(
        sql`INSERT INTO worklist_item (tenant_id, kind, subject_type, subject_id, location_id)
              VALUES (${world.tenant.id}, 'waitlist_manual_contact', 'waitlist_entry', ${id},
                      ${world.norte})`,
      );
      return id;
    });

    const forReception = (await toCall(world.reception)).items.map((item) => item.entry.id);
    const forOwner = (await toCall(world.owner)).items.map((item) => item.entry.id);

    expect(forReception).toContain(entry.id);
    expect(forReception).not.toContain(elsewhere);
    expect(forOwner).toContain(elsewhere);
  });

  it('lists the entries that let three offers expire, apart from the slots', async () => {
    await world.advance(MINUTE);
    const entry = await world.join(await world.patient());
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE waitlist_entry SET consecutive_expired = 3, flagged_at = now() WHERE id = ${entry.id}`,
      ),
    );

    const { unresponsive, items } = await toCall();

    expect(unresponsive.map((row) => row.id)).toContain(entry.id);
    expect(unresponsive.find((row) => row.id === entry.id)).toMatchObject({
      unresponsive: true,
      consecutiveExpired: 3,
    });
    expect(items.map((row) => row.entry.id)).not.toContain(entry.id);
  });

  it('is open to the professionals too, who manage the waitlist like reception', async () => {
    const response = await world.api.get('/waitlist/to-call', world.doctor);

    expect(response.statusCode).toBe(200);
  });
});
