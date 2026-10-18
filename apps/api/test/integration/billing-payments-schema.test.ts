import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { insertAppointmentRow, insertLocation, returningId } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'billing-payments-a' });
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

async function chargeAt(tx: Tx, status = 'pending'): Promise<{ id: string; locationId: string }> {
  const appointmentId = await insertAppointmentRow(tx, a.id);
  const rows = await tx.execute<{
    patient_id: string;
    professional_id: string;
    location_id: string;
  }>(
    sql`SELECT patient_id, professional_id, location_id FROM appointment WHERE id = ${appointmentId}`,
  );
  const row = rows.rows[0];
  if (!row) throw new Error('appointment not found');
  const voided = status === 'voided';
  const id = await returningId(
    tx,
    sql`INSERT INTO charge (tenant_id, appointment_id, patient_id, professional_id, location_id,
                            status, snapshot, captured_by, void_reason, voided_at)
          VALUES (${a.id}, ${appointmentId}, ${row.patient_id}, ${row.professional_id}, ${row.location_id},
                  ${status}, '{"quote":null}'::jsonb, gen_random_uuid(),
                  ${voided ? 'error' : null}, ${voided ? sql`now()` : null})
          RETURNING id`,
  );
  return { id, locationId: row.location_id };
}

const session = (tx: Tx, locationId: string, opening = 500_000) =>
  returningId(
    tx,
    sql`INSERT INTO cash_session (tenant_id, location_id, opened_by, opening_cents)
          VALUES (${a.id}, ${locationId}, gen_random_uuid(), ${opening}) RETURNING id`,
  );

const close = (
  tx: Tx,
  id: string,
  values: { expected: number; counted: number; reason?: string | null },
) =>
  tx.execute(
    sql`UPDATE cash_session
           SET status = 'closed', closed_at = now(), closed_by = gen_random_uuid(),
               expected_cents = ${values.expected}, counted_cents = ${values.counted},
               difference_cents = ${values.counted - values.expected},
               difference_reason = ${values.reason ?? null}
         WHERE id = ${id}`,
  );

interface PaymentValues {
  chargeId: string;
  locationId: string;
  method?: string;
  amount?: number;
  credit?: number;
  sessionId?: string | null;
  key?: string;
  externalRef?: string | null;
  overrideReason?: string | null;
}

const payment = (tx: Tx, values: PaymentValues) =>
  returningId(
    tx,
    sql`INSERT INTO payment (tenant_id, charge_id, location_id, cash_session_id, method, amount_cents,
                             credit_cents, recorded_by, idempotency_key, request_hash, external_ref,
                             override_reason)
          VALUES (${a.id}, ${values.chargeId}, ${values.locationId}, ${values.sessionId ?? null},
                  ${values.method ?? 'debit'}, ${values.amount ?? 1_000_000}, ${values.credit ?? 0},
                  gen_random_uuid(), ${values.key ?? randomUUID()}, 'hash',
                  ${values.externalRef ?? null}, ${values.overrideReason ?? null})
          RETURNING id`,
  );

describe('cash_session', () => {
  it('opens with an opening amount, for a location, and is open until it is closed', async () => {
    const row = await asTenant(runtime, a.id, async (tx) => {
      const id = await session(tx, await insertLocation(tx, a.id), 500_000);
      return (
        await tx.execute(
          sql`SELECT status, opening_cents, closed_at, expected_cents FROM cash_session WHERE id = ${id}`,
        )
      ).rows[0];
    });

    expect(row).toMatchObject({
      status: 'open',
      opening_cents: '500000',
      closed_at: null,
      expected_cents: null,
    });
  });

  it('refuses a negative opening amount', async () => {
    const code = await asTenant(runtime, a.id, async (tx) =>
      refusal(tx, async (inner) => session(inner, await insertLocation(inner, a.id), -1)),
    );

    expect(code).toBe('23514');
  });

  it('refuses a second open register at the same location, and allows it elsewhere or after closing', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const centro = await insertLocation(tx, a.id);
      const norte = await insertLocation(tx, a.id);
      const first = await session(tx, centro);
      const second = await refusal(tx, (inner) => session(inner, centro));
      const elsewhere = await refusal(tx, (inner) => session(inner, norte));
      await close(tx, first, { expected: 500_000, counted: 500_000 });
      const afterClosing = await refusal(tx, (inner) => session(inner, centro));
      return { second, elsewhere, afterClosing };
    });

    expect(result).toEqual({ second: '23505', elsewhere: undefined, afterClosing: undefined });
  });

  it('closes with the counted cash, and a difference needs a reason', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const equal = await session(tx, await insertLocation(tx, a.id));
      const short = await session(tx, await insertLocation(tx, a.id));
      const noReason = await refusal(tx, (inner) =>
        close(inner, short, { expected: 3_500_000, counted: 3_400_000 }),
      );
      const withReason = await refusal(tx, (inner) =>
        close(inner, short, {
          expected: 3_500_000,
          counted: 3_400_000,
          reason: 'Falta un billete de 1000',
        }),
      );
      const exact = await refusal(tx, (inner) =>
        close(inner, equal, { expected: 3_500_000, counted: 3_500_000 }),
      );
      const stored = (
        await tx.execute(sql`SELECT difference_cents FROM cash_session WHERE id = ${short}`)
      ).rows[0];
      return { noReason, withReason, exact, stored };
    });

    expect(result).toEqual({
      noReason: '23514',
      withReason: undefined,
      exact: undefined,
      stored: { difference_cents: '-100000' },
    });
  });

  it('refuses a closing whose difference is not counted minus expected', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await session(tx, await insertLocation(tx, a.id));
      return refusal(tx, (inner) =>
        inner.execute(
          sql`UPDATE cash_session SET status = 'closed', closed_at = now(), closed_by = gen_random_uuid(),
                 expected_cents = 100, counted_cents = 100, difference_cents = 5, difference_reason = 'x y z'
               WHERE id = ${id}`,
        ),
      );
    });

    expect(code).toBe('23514');
  });

  it('cannot change once closed, and an open one keeps its place and its opening', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const place = await insertLocation(tx, a.id);
      const id = await session(tx, place);
      const moves = await refusal(tx, async (inner) =>
        inner.execute(
          sql`UPDATE cash_session SET location_id = ${await insertLocation(inner, a.id)} WHERE id = ${id}`,
        ),
      );
      const reopens = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE cash_session SET opening_cents = 1 WHERE id = ${id}`),
      );
      await close(tx, id, { expected: 500_000, counted: 500_000 });
      const reopened = await refusal(tx, (inner) =>
        inner.execute(
          sql`UPDATE cash_session SET status = 'open', closed_at = null WHERE id = ${id}`,
        ),
      );
      const recount = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE cash_session SET counted_cents = 1 WHERE id = ${id}`),
      );
      return { moves, reopens, reopened, recount };
    });

    expect(result).toEqual({
      moves: '42501',
      reopens: '42501',
      reopened: '42501',
      recount: '42501',
    });
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await session(tx, await insertLocation(tx, a.id));
      return refusal(tx, (inner) => inner.execute(sql`DELETE FROM cash_session WHERE id = ${id}`));
    });

    expect(code).toBe('42501');
  });
});

describe('payment', () => {
  it('keeps an amount in whole cents above zero, with its credit within it', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      return [
        await refusal(tx, (inner) => payment(inner, { chargeId: id, locationId, amount: 0 })),
        await refusal(tx, (inner) => payment(inner, { chargeId: id, locationId, amount: -5 })),
        await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, amount: 100, credit: 101 }),
        ),
        await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, amount: 100, credit: -1 }),
        ),
        await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, amount: 100, credit: 100 }),
        ),
      ];
    });

    expect(codes).toEqual(['23514', '23514', '23514', '23514', undefined]);
  });

  it('knows six methods, and cash needs the register it went into', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      const open = await session(tx, locationId);
      const methods = [];
      for (const method of ['debit', 'credit', 'transfer', 'wallet', 'payment_link']) {
        methods.push(
          await refusal(tx, (inner) => payment(inner, { chargeId: id, locationId, method })),
        );
      }
      return {
        methods,
        unknown: await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, method: 'crypto' }),
        ),
        cashWithout: await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, method: 'cash' }),
        ),
        cashWith: await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, method: 'cash', sessionId: open }),
        ),
      };
    });

    expect(result).toEqual({
      methods: [undefined, undefined, undefined, undefined, undefined],
      unknown: '23514',
      cashWithout: '23514',
      cashWith: undefined,
    });
  });

  it('is recorded once per idempotency key', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      const key = randomUUID();
      await payment(tx, { chargeId: id, locationId, key });
      return refusal(tx, (inner) => payment(inner, { chargeId: id, locationId, key }));
    });

    expect(code).toBe('23505');
  });

  it('refuses the same voucher twice unless an override reason came with it', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      await payment(tx, { chargeId: id, locationId, externalRef: 'V-004512' });
      const again = await refusal(tx, (inner) =>
        payment(inner, { chargeId: id, locationId, externalRef: 'V-004512' }),
      );
      const overridden = await refusal(tx, (inner) =>
        payment(inner, {
          chargeId: id,
          locationId,
          externalRef: 'V-004512',
          overrideReason: 'El cliente pagó dos cuotas con el mismo comprobante',
        }),
      );
      const other = await refusal(tx, (inner) =>
        payment(inner, { chargeId: id, locationId, externalRef: 'V-004513' }),
      );
      return { again, overridden, other };
    });

    expect(result).toEqual({ again: '23505', overridden: undefined, other: undefined });
  });

  it('cannot hold a card number in the reference of a payment', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      return [
        await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, externalRef: '4111111111111111' }),
        ),
        await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, externalRef: '4111 1111 1111 1111' }),
        ),
        await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, externalRef: '5400-0000-0000-0004' }),
        ),
        await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, externalRef: '004512' }),
        ),
        await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, externalRef: 'TRF-20310512-0045' }),
        ),
      ];
    });

    expect(codes).toEqual(['23514', '23514', '23514', undefined, undefined]);
  });

  it("cannot go into a closed register, another location's register, or a voided charge", async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      const closed = await session(tx, locationId);
      await close(tx, closed, { expected: 500_000, counted: 500_000 });
      const elsewhere = await session(tx, await insertLocation(tx, a.id));
      const voided = await chargeAt(tx, 'voided');
      return {
        closed: await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, method: 'cash', sessionId: closed }),
        ),
        elsewhere: await refusal(tx, (inner) =>
          payment(inner, { chargeId: id, locationId, method: 'cash', sessionId: elsewhere }),
        ),
        voided: await refusal(tx, (inner) =>
          payment(inner, { chargeId: voided.id, locationId: voided.locationId }),
        ),
      };
    });

    expect(result).toEqual({ closed: '42501', elsewhere: '42501', voided: '42501' });
  });

  it('is append-only for the application role: no update, no delete', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      const paid = await payment(tx, { chargeId: id, locationId });
      return [
        await refusal(tx, (inner) =>
          inner.execute(sql`UPDATE payment SET amount_cents = 1 WHERE id = ${paid}`),
        ),
        await refusal(tx, (inner) => inner.execute(sql`DELETE FROM payment WHERE id = ${paid}`)),
      ];
    });

    expect(codes).toEqual(['42501', '42501']);
  });
});

describe('payment_reversal', () => {
  const reversal = (
    tx: Tx,
    values: {
      paymentId: string;
      chargeId: string;
      locationId: string;
      amount: number;
      sessionId?: string | null;
      reason?: string;
      kind?: string;
    },
  ) =>
    returningId(
      tx,
      sql`INSERT INTO payment_reversal (tenant_id, payment_id, charge_id, location_id, cash_session_id,
                                        amount_cents, reason, kind, reversed_by, idempotency_key, request_hash)
            VALUES (${a.id}, ${values.paymentId}, ${values.chargeId}, ${values.locationId},
                    ${values.sessionId ?? null}, ${values.amount}, ${values.reason ?? 'Devolución al paciente'},
                    ${values.kind ?? 'refund'}, gen_random_uuid(), ${randomUUID()}, 'hash')
            RETURNING id`,
    );

  it('refunds part of a payment, linked to it, and never more than what is left', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      const paid = await payment(tx, { chargeId: id, locationId, amount: 1_000_000 });
      const base = { paymentId: paid, chargeId: id, locationId };
      return {
        partial: await refusal(tx, (inner) => reversal(inner, { ...base, amount: 400_000 })),
        rest: await refusal(tx, (inner) => reversal(inner, { ...base, amount: 600_000 })),
        over: await refusal(tx, (inner) => reversal(inner, { ...base, amount: 1 })),
      };
    });

    expect(result).toEqual({ partial: undefined, rest: undefined, over: '23514' });
  });

  it('refuses a refund above the payment at once, a zero amount and a missing reason', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      const paid = await payment(tx, { chargeId: id, locationId, amount: 1_000_000 });
      const base = { paymentId: paid, chargeId: id, locationId };
      return [
        await refusal(tx, (inner) => reversal(inner, { ...base, amount: 1_000_001 })),
        await refusal(tx, (inner) => reversal(inner, { ...base, amount: 0 })),
        await refusal(tx, (inner) => reversal(inner, { ...base, amount: 5, reason: '  ' })),
        await refusal(tx, (inner) => reversal(inner, { ...base, amount: 5, kind: 'discount' })),
      ];
    });

    expect(codes).toEqual(['23514', '23514', '23514', '23514']);
  });

  it('puts the cash of a cash refund in an open register of the place, never a closed one', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      const first = await session(tx, locationId);
      const cash = await payment(tx, {
        chargeId: id,
        locationId,
        method: 'cash',
        sessionId: first,
        amount: 800_000,
      });
      await close(tx, first, { expected: 1_300_000, counted: 1_300_000 });
      const base = { paymentId: cash, chargeId: id, locationId, kind: 'correction' };
      const none = await refusal(tx, (inner) => reversal(inner, { ...base, amount: 100_000 }));
      const intoClosed = await refusal(tx, (inner) =>
        reversal(inner, { ...base, amount: 100_000, sessionId: first }),
      );
      const next = await session(tx, locationId);
      const intoOpen = await refusal(tx, (inner) =>
        reversal(inner, { ...base, amount: 100_000, sessionId: next }),
      );
      return { none, intoClosed, intoOpen };
    });

    expect(result).toEqual({ none: '23514', intoClosed: '42501', intoOpen: undefined });
  });

  it('is append-only for the application role', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id, locationId } = await chargeAt(tx);
      const paid = await payment(tx, { chargeId: id, locationId });
      const back = await reversal(tx, { paymentId: paid, chargeId: id, locationId, amount: 100 });
      return [
        await refusal(tx, (inner) =>
          inner.execute(sql`UPDATE payment_reversal SET amount_cents = 1 WHERE id = ${back}`),
        ),
        await refusal(tx, (inner) =>
          inner.execute(sql`DELETE FROM payment_reversal WHERE id = ${back}`),
        ),
      ];
    });

    expect(codes).toEqual(['42501', '42501']);
  });
});

describe('export_request', () => {
  const request = (
    tx: Tx,
    values: { kind?: string; format?: string; status?: string; key?: string | null },
  ) =>
    returningId(
      tx,
      sql`INSERT INTO export_request (tenant_id, kind, format, filters, status, requested_by, object_key)
            VALUES (${a.id}, ${values.kind ?? 'charges'}, ${values.format ?? 'csv'}, '{}'::jsonb,
                    ${values.status ?? 'queued'}, gen_random_uuid(), ${values.key ?? null})
            RETURNING id`,
    );

  it('knows its kinds, formats and states, and a ready export names its file', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => [
      await refusal(tx, (inner) => request(inner, { kind: 'payer_settlement', format: 'xlsx' })),
      await refusal(tx, (inner) => request(inner, { kind: 'clinical' })),
      await refusal(tx, (inner) => request(inner, { format: 'docx' })),
      await refusal(tx, (inner) => request(inner, { status: 'done' })),
      await refusal(tx, (inner) => request(inner, { status: 'ready', key: null })),
      await refusal(tx, (inner) => request(inner, { status: 'ready', key: 't/x/exports/abc' })),
    ]);

    expect(codes).toEqual([undefined, '23514', '23514', '23514', '23514', undefined]);
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await request(tx, {});
      return refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM export_request WHERE id = ${id}`),
      );
    });

    expect(code).toBe('42501');
  });
});
