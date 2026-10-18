import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { insertAppointmentRow, returningId } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'billing-charges-a' });
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

interface ChargeValues {
  appointmentId?: string;
  status?: string;
  voidReason?: string | null;
}

const SNAPSHOT = '{"source":"private","totalCents":2000000}';

async function charge(
  tx: Tx,
  values: ChargeValues = {},
): Promise<{ id: string; appointmentId: string }> {
  const appointmentId = values.appointmentId ?? (await insertAppointmentRow(tx, a.id));
  const rows = await tx.execute<{
    patient_id: string;
    professional_id: string;
    location_id: string;
  }>(
    sql`SELECT patient_id, professional_id, location_id FROM appointment WHERE id = ${appointmentId}`,
  );
  const row = rows.rows[0];
  if (!row) throw new Error('appointment not found');
  const voided = values.status === 'voided';
  const id = await returningId(
    tx,
    sql`INSERT INTO charge (tenant_id, appointment_id, patient_id, professional_id, location_id,
                            status, snapshot, captured_by, void_reason, voided_at)
          VALUES (${a.id}, ${appointmentId}, ${row.patient_id}, ${row.professional_id}, ${row.location_id},
                  ${values.status ?? 'pending'}, ${SNAPSHOT}::jsonb, gen_random_uuid(),
                  ${values.voidReason === undefined ? (voided ? 'error' : null) : values.voidReason},
                  ${voided ? sql`now()` : null})
          RETURNING id`,
  );
  return { id, appointmentId };
}

const line = (tx: Tx, chargeId: string, amount = 2_000_000, invoiced = 0, position = 1) =>
  returningId(
    tx,
    sql`INSERT INTO charge_line (tenant_id, charge_id, position, kind, portion, description,
                                 amount_cents, invoiced_cents)
          VALUES (${a.id}, ${chargeId}, ${position}, 'service', 'patient', 'Consulta',
                  ${amount}, ${invoiced})
          RETURNING id`,
  );

describe('charge', () => {
  it('starts pending, for one appointment, with a snapshot of the price it applied', async () => {
    const row = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      return (
        await tx.execute(sql`SELECT status, needs_review, snapshot FROM charge WHERE id = ${id}`)
      ).rows[0];
    });

    expect(row).toMatchObject({
      status: 'pending',
      needs_review: false,
      snapshot: { source: 'private', totalCents: 2_000_000 },
    });
  });

  it('refuses a second charge that is not voided for the same appointment', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const first = await charge(tx);
      const second = await refusal(tx, (inner) =>
        charge(inner, { appointmentId: first.appointmentId }),
      );
      // Once the first is voided the appointment can be charged again.
      await tx.execute(
        sql`UPDATE charge SET status = 'voided', void_reason = 'cargado dos veces', voided_at = now(),
                              voided_by = gen_random_uuid() WHERE id = ${first.id}`,
      );
      const third = await refusal(tx, (inner) =>
        charge(inner, { appointmentId: first.appointmentId }),
      );
      return { second, third };
    });

    expect(result).toEqual({ second: '23505', third: undefined });
  });

  it('knows four statuses, and a voided charge says why and when', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => [
      await refusal(tx, (inner) => charge(inner, { status: 'refunded' })),
      await refusal(tx, (inner) => charge(inner, { status: 'voided', voidReason: null })),
      await refusal(tx, (inner) => charge(inner, { status: 'partially_paid' })),
      await refusal(tx, (inner) => charge(inner, { status: 'paid' })),
      await refusal(tx, (inner) => charge(inner, { status: 'voided' })),
    ]);

    expect(codes).toEqual(['23514', '23514', undefined, undefined, undefined]);
  });

  it('flags a charge for review for a no-show or a cancellation only', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      return [
        await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE charge SET needs_review = true, review_reason = 'no_show', flagged_at = now() WHERE id = ${id}`,
          ),
        ),
        await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE charge SET needs_review = true, review_reason = 'boredom', flagged_at = now() WHERE id = ${id}`,
          ),
        ),
        // The flag, its reason and the moment come together or not at all.
        await refusal(tx, async (inner) => {
          const fresh = await charge(inner);
          await inner.execute(
            sql`UPDATE charge SET needs_review = true, review_reason = 'no_show' WHERE id = ${fresh.id}`,
          );
        }),
      ];
    });

    expect(codes).toEqual([undefined, '23514', '23514']);
  });

  it('never leaves voided, and a voided charge keeps its reason', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx, { status: 'voided', voidReason: 'duplicado' });
      return [
        await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE charge SET status = 'pending', void_reason = null, voided_at = null WHERE id = ${id}`,
          ),
        ),
        await refusal(tx, (inner) =>
          inner.execute(sql`UPDATE charge SET void_reason = 'otro motivo' WHERE id = ${id}`),
        ),
      ];
    });

    expect(codes).toEqual(['42501', '42501']);
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      return refusal(tx, (inner) => inner.execute(sql`DELETE FROM charge WHERE id = ${id}`));
    });

    expect(code).toBe('42501');
  });
});

describe('charge_line', () => {
  it('keeps an amount in whole cents, above zero, and what has been invoiced of it', async () => {
    const row = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      const lineId = await line(tx, id, 2_000_050, 500_000);
      return (
        await tx.execute(
          sql`SELECT amount_cents, invoiced_cents FROM charge_line WHERE id = ${lineId}`,
        )
      ).rows[0];
    });

    expect(row).toMatchObject({ amount_cents: '2000050', invoiced_cents: '500000' });
  });

  it('refuses a zero or negative amount, and an invoiced amount above the line or below zero', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      return [
        await refusal(tx, (inner) => line(inner, id, 0)),
        await refusal(tx, (inner) => line(inner, id, -5)),
        await refusal(tx, (inner) => line(inner, id, 1_000, 1_001)),
        await refusal(tx, (inner) => line(inner, id, 1_000, -1)),
        await refusal(tx, (inner) => line(inner, id, 1_000, 1_000, 2)),
      ];
    });

    expect(codes).toEqual(['23514', '23514', '23514', '23514', undefined]);
  });

  it('refuses a kind or a portion the product does not know, and a blank description', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      let position = 0;
      const insert = (kind: string, portion: string, description: string) => {
        position += 1;
        return refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO charge_line (tenant_id, charge_id, position, kind, portion, description, amount_cents)
                  VALUES (${a.id}, ${id}, ${position}, ${kind}, ${portion}, ${description}, 100)`,
          ),
        );
      };
      return [
        await insert('discount', 'patient', 'x'),
        await insert('service', 'insurer', 'x'),
        await insert('service', 'patient', '   '),
        await insert('late_fee', 'patient', 'Cargo por ausencia'),
        await insert('payer_coverage', 'payer', 'Cobertura'),
      ];
    });

    expect(codes).toEqual(['23514', '23514', '23514', undefined, undefined]);
  });

  it('numbers its lines once per charge', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      await line(tx, id, 1_000, 0, 1);
      return refusal(tx, (inner) => line(inner, id, 1_000, 0, 1));
    });

    expect(code).toBe('23505');
  });

  it('changes only what has been invoiced of it: nothing else about a line can move', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      const lineId = await line(tx, id, 1_000);
      const invoiced = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE charge_line SET invoiced_cents = 400 WHERE id = ${lineId}`),
      );
      const amount = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE charge_line SET amount_cents = 9999 WHERE id = ${lineId}`),
      );
      const description = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE charge_line SET description = 'otra' WHERE id = ${lineId}`),
      );
      const portion = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE charge_line SET portion = 'payer' WHERE id = ${lineId}`),
      );
      return { invoiced, amount, description, portion };
    });

    expect(result).toEqual({
      invoiced: undefined,
      amount: '42501',
      description: '42501',
      portion: '42501',
    });
  });

  it('takes no new line once the charge is voided', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx, { status: 'voided' });
      return refusal(tx, (inner) => line(inner, id));
    });

    expect(code).toBe('42501');
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const { id } = await charge(tx);
      const lineId = await line(tx, id);
      return refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM charge_line WHERE id = ${lineId}`),
      );
    });

    expect(code).toBe('42501');
  });
});
