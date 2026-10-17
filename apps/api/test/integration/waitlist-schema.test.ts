import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import {
  insertLocation,
  insertPatient,
  insertProfessional,
  returningId,
  unique,
} from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'waitlist-schema-a' });
  b = await createTestTenant(runtime, { slug: 'waitlist-schema-b' });
});

afterAll(async () => {
  await runtime.close();
});

/** The SQLSTATE of a refused statement, run in a savepoint so the transaction stays usable. */
const refusal = (tx: Tx, work: (inner: Tx) => Promise<unknown>) =>
  tx.transaction(work).then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

const type = (tx: Tx, tenantId: string) =>
  returningId(
    tx,
    sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
          VALUES (${tenantId}, ${unique('Control')}, 30) RETURNING id`,
  );

interface EntryValues {
  patientId: string;
  typeId: string;
  professionalId?: string | null;
  locationId?: string | null;
  closed?: boolean;
}

function entry(tx: Tx, tenantId: string, values: EntryValues): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO waitlist_entry
          (tenant_id, patient_id, appointment_type_id, professional_id, location_id, expires_at,
           status, close_reason, closed_at)
          VALUES (${tenantId}, ${values.patientId}, ${values.typeId},
                  ${values.professionalId ?? null}, ${values.locationId ?? null},
                  now() + interval '60 days', ${values.closed ? 'closed' : 'active'},
                  ${values.closed ? 'cancelled' : null}, ${values.closed ? sql`now()` : null})
          RETURNING id`,
  );
}

describe('waitlist_entry', () => {
  it('starts active, open to any day and time, reachable by email, with no priority', async () => {
    const rows = await asTenant(runtime, a.id, async (tx) => {
      const id = await entry(tx, a.id, {
        patientId: await insertPatient(tx, a.id),
        typeId: await type(tx, a.id),
      });
      return (await tx.execute(sql`SELECT * FROM waitlist_entry WHERE id = ${id}`)).rows;
    });

    expect(rows[0]).toMatchObject({
      status: 'active',
      weekdays: [],
      time_ranges: [],
      channels: ['email'],
      priority: 0,
      manual_contact_only: false,
      consecutive_expired: 0,
      identity_unconfirmed: false,
    });
  });

  it('refuses a second entry in play for the same patient, type, professional and location', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const patientId = await insertPatient(tx, a.id);
      const typeId = await type(tx, a.id);
      const professionalId = await insertProfessional(tx, a.id);
      await entry(tx, a.id, { patientId, typeId, professionalId });
      return refusal(tx, (inner) => entry(inner, a.id, { patientId, typeId, professionalId }));
    });

    expect(code).toBe('23505');
  });

  it('keeps "any professional" apart from a specific one, and refuses it twice', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const patientId = await insertPatient(tx, a.id);
      const typeId = await type(tx, a.id);
      const professionalId = await insertProfessional(tx, a.id);
      await entry(tx, a.id, { patientId, typeId });
      // A specific professional is a different wait than "any professional".
      await entry(tx, a.id, { patientId, typeId, professionalId });
      return refusal(tx, (inner) => entry(inner, a.id, { patientId, typeId }));
    });

    expect(code).toBe('23505');
  });

  it('lets a patient wait again once the earlier entry is closed', async () => {
    const second = await asTenant(runtime, a.id, async (tx) => {
      const patientId = await insertPatient(tx, a.id);
      const typeId = await type(tx, a.id);
      await entry(tx, a.id, { patientId, typeId, closed: true });
      return entry(tx, a.id, { patientId, typeId });
    });

    expect(second).toEqual(expect.any(String));
  });

  it('keeps a closed entry self-describing: no reason with a live status, no closed one without', async () => {
    const { withReason, withoutReason } = await asTenant(runtime, a.id, async (tx) => {
      const patientId = await insertPatient(tx, a.id);
      const typeId = await type(tx, a.id);
      return {
        withReason: await refusal(tx, (inner) =>
          inner.execute(sql`INSERT INTO waitlist_entry
              (tenant_id, patient_id, appointment_type_id, expires_at, status, close_reason, closed_at)
              VALUES (${a.id}, ${patientId}, ${typeId}, now(), 'active', 'expired', now())`),
        ),
        withoutReason: await refusal(tx, (inner) =>
          inner.execute(sql`INSERT INTO waitlist_entry
              (tenant_id, patient_id, appointment_type_id, expires_at, status)
              VALUES (${a.id}, ${patientId}, ${typeId}, now(), 'closed')`),
        ),
      };
    });

    expect(withReason).toBe('23514');
    expect(withoutReason).toBe('23514');
  });

  it.each([
    ['a weekday outside 1 to 7', sql`weekdays = '{0}'`],
    ['a priority above 2', sql`priority = 3`],
    ['a channel that is not email or WhatsApp', sql`channels = '{sms}'`],
    ['no channel at all', sql`channels = '{}'`],
    ['time ranges that are not a list', sql`time_ranges = '{}'::jsonb`],
    ['dates in the wrong order', sql`earliest_date = '2031-06-10', latest_date = '2031-06-01'`],
    ['an opt-in time without its source', sql`offers_opt_in_at = now()`],
    ['manual contact without a reason', sql`manual_contact_only = true`],
  ])('refuses %s', async (_label, change) => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await entry(tx, a.id, {
        patientId: await insertPatient(tx, a.id),
        typeId: await type(tx, a.id),
      });
      return refusal(tx, (inner) =>
        inner.execute(sql`UPDATE waitlist_entry SET ${change} WHERE id = ${id}`),
      );
    });

    expect(code).toBe('23514');
  });

  it('wants the staff member who recorded a staff opt-in', async () => {
    const { anonymous, named } = await asTenant(runtime, a.id, async (tx) => {
      const id = await entry(tx, a.id, {
        patientId: await insertPatient(tx, a.id),
        typeId: await type(tx, a.id),
      });
      return {
        anonymous: await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE waitlist_entry SET offers_opt_in_at = now(), offers_opt_in_source = 'staff' WHERE id = ${id}`,
          ),
        ),
        named: await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE waitlist_entry SET offers_opt_in_at = now(), offers_opt_in_source = 'staff',
                  offers_opt_in_by = gen_random_uuid() WHERE id = ${id}`,
          ),
        ),
      };
    });

    expect(anonymous).toBe('23514');
    expect(named).toBeUndefined();
  });

  it("cannot point at another organization's patient, type, professional or location", async () => {
    const own = await asTenant(runtime, a.id, async (tx) => ({
      patientId: await insertPatient(tx, a.id),
      typeId: await type(tx, a.id),
    }));
    const foreign = await asTenant(runtime, b.id, async (tx) => ({
      patientId: await insertPatient(tx, b.id),
      typeId: await type(tx, b.id),
      professionalId: await insertProfessional(tx, b.id),
      locationId: await insertLocation(tx, b.id),
    }));

    const codes = await asTenant(runtime, a.id, async (tx) => {
      const attempt = (values: EntryValues) => refusal(tx, (inner) => entry(inner, a.id, values));
      return [
        await attempt({ patientId: foreign.patientId, typeId: own.typeId }),
        await attempt({ patientId: own.patientId, typeId: foreign.typeId }),
        await attempt({ ...own, professionalId: foreign.professionalId }),
        await attempt({ ...own, locationId: foreign.locationId }),
      ];
    });

    expect(codes).toEqual(['23503', '23503', '23503', '23503']);
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await entry(tx, a.id, {
        patientId: await insertPatient(tx, a.id),
        typeId: await type(tx, a.id),
      });
      return refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM waitlist_entry WHERE id = ${id}`),
      );
    });

    expect(code).toBe('42501');
  });
});

describe('waitlist_offer', () => {
  async function world(tx: Tx) {
    const patientId = await insertPatient(tx, a.id);
    const typeId = await type(tx, a.id);
    return {
      patientId,
      typeId,
      professionalId: await insertProfessional(tx, a.id),
      locationId: await insertLocation(tx, a.id),
      entryId: await entry(tx, a.id, { patientId, typeId }),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  function offer(
    tx: Tx,
    w: World,
    slotKey: string,
    options: { entryId?: string; patientId?: string; status?: string } = {},
  ) {
    const status = options.status ?? 'open';
    return tx.execute(sql`INSERT INTO waitlist_offer
        (tenant_id, entry_id, patient_id, slot_key, professional_id, location_id,
         appointment_type_id, starts_at, ends_at, freed_starts_at, freed_ends_at, send_at,
         expires_at, status, closed_at)
        VALUES (${a.id}, ${options.entryId ?? w.entryId}, ${options.patientId ?? w.patientId},
                ${slotKey}, ${w.professionalId}, ${w.locationId}, ${w.typeId},
                '2031-05-12T13:00:00Z', '2031-05-12T13:30:00Z',
                '2031-05-12T13:00:00Z', '2031-05-12T13:30:00Z', now(),
                now() + interval '30 minutes', ${status},
                ${status === 'open' ? null : sql`now()`})`);
  }

  it('refuses the same slot offered twice to the same entry', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const w = await world(tx);
      await offer(tx, w, 'slot-one', { status: 'declined' });
      return refusal(tx, (inner) => offer(inner, w, 'slot-one', { status: 'declined' }));
    });

    expect(code).toBe('23505');
  });

  it('refuses the same slot offered twice to a patient with two entries', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const w = await world(tx);
      const second = await entry(tx, a.id, {
        patientId: w.patientId,
        typeId: await type(tx, a.id),
      });
      await offer(tx, w, 'slot-two', { status: 'declined' });
      return refusal(tx, (inner) =>
        offer(inner, w, 'slot-two', { entryId: second, status: 'declined' }),
      );
    });

    expect(code).toBe('23505');
  });

  it('allows one open offer per slot, and another once the first closed', async () => {
    const { second, third } = await asTenant(runtime, a.id, async (tx) => {
      const w = await world(tx);
      const rivalPatient = await insertPatient(tx, a.id);
      const rival = await entry(tx, a.id, { patientId: rivalPatient, typeId: w.typeId });
      await offer(tx, w, 'slot-three');
      const refused = await refusal(tx, (inner) =>
        offer(inner, w, 'slot-three', { entryId: rival, patientId: rivalPatient }),
      );
      await tx.execute(
        sql`UPDATE waitlist_offer SET status = 'declined', closed_at = now() WHERE slot_key = 'slot-three'`,
      );
      return {
        second: refused,
        third: await refusal(tx, (inner) =>
          offer(inner, w, 'slot-three', { entryId: rival, patientId: rivalPatient }),
        ),
      };
    });

    expect(second).toBe('23505');
    expect(third).toBeUndefined();
  });

  it('keeps an open offer open and a closed one closed', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const w = await world(tx);
      await offer(tx, w, 'slot-four');
      return refusal(tx, (inner) =>
        inner.execute(
          sql`UPDATE waitlist_offer SET status = 'expired' WHERE slot_key = 'slot-four'`,
        ),
      );
    });

    expect(code).toBe('23514');
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const w = await world(tx);
      await offer(tx, w, 'slot-five');
      return refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM waitlist_offer WHERE slot_key = 'slot-five'`),
      );
    });

    expect(code).toBe('42501');
  });
});

describe('waitlist_call', () => {
  async function call(
    tx: Tx,
    values: { reason?: string; startsAt?: string; endsAt?: string } = {},
  ) {
    const patientId = await insertPatient(tx, a.id);
    const typeId = await type(tx, a.id);
    const professionalId = await insertProfessional(tx, a.id);
    const entryId = await entry(tx, a.id, { patientId, typeId });
    const locationId = await insertLocation(tx, a.id);
    const insert = (inner: Tx, overrides: { reason?: string } = {}) =>
      inner.execute(sql`INSERT INTO waitlist_call
          (tenant_id, entry_id, professional_id, location_id, appointment_type_id, starts_at, ends_at, reason)
          VALUES (${a.id}, ${entryId}, ${professionalId}, ${locationId}, ${typeId},
                  ${values.startsAt ?? '2031-05-12T13:00:00Z'}, ${values.endsAt ?? '2031-05-12T13:30:00Z'},
                  ${overrides.reason ?? values.reason ?? 'slot_too_close'})`);
    return { insert };
  }

  it('keeps one row per entry and slot, and only the reasons the spec names', async () => {
    const { duplicate, unknown, backwards } = await asTenant(runtime, a.id, async (tx) => {
      const first = await call(tx);
      await first.insert(tx);
      return {
        duplicate: await refusal(tx, (inner) => first.insert(inner)),
        unknown: await refusal(tx, async (inner) =>
          (await call(inner, { reason: 'because' })).insert(inner),
        ),
        backwards: await refusal(tx, async (inner) =>
          (await call(inner, { startsAt: '2031-05-12T14:00:00Z' })).insert(inner),
        ),
      };
    });

    expect(duplicate).toBe('23505');
    expect(unknown).toBe('23514');
    expect(backwards).toBe('23514');
  });

  it('can be neither changed nor deleted by the application role', async () => {
    const { update, remove } = await asTenant(runtime, a.id, async (tx) => {
      await (await call(tx)).insert(tx);
      return {
        update: await refusal(tx, (inner) =>
          inner.execute(sql`UPDATE waitlist_call SET reason = 'quiet_hours'`),
        ),
        remove: await refusal(tx, (inner) => inner.execute(sql`DELETE FROM waitlist_call`)),
      };
    });

    expect(update).toBe('42501');
    expect(remove).toBe('42501');
  });
});
