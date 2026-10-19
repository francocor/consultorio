import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { insertAppointmentRow, insertPatient, returningId } from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

/**
 * The invoice tables (migration 0444, tasks 4.43 and 4.46): the rules the database itself keeps
 * whatever the application does. An invoice over charge lines can never over-invoice, an issued or
 * manual invoice cannot change, a rejected attempt releases its lines, a credit note cannot go
 * beyond its invoice, and the amount invoiced of a line follows the invoices by itself.
 */

let runtime: DbHandle;
let a: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'invoice-invariants-a' });
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

interface Line {
  id: string;
  chargeId: string;
  amount: number;
}

let position = 0;
/** A charge with one patient line of `amount` cents, for a patient and a location of its own. */
async function chargeLine(tx: Tx, amount = 2_000_000): Promise<Line> {
  const appointmentId = await insertAppointmentRow(tx, a.id);
  const [row] = (
    await tx.execute<{ patient_id: string; professional_id: string; location_id: string }>(
      sql`SELECT patient_id, professional_id, location_id FROM appointment WHERE id = ${appointmentId}`,
    )
  ).rows;
  if (!row) throw new Error('appointment not found');
  const chargeId = await returningId(
    tx,
    sql`INSERT INTO charge (tenant_id, appointment_id, patient_id, professional_id, location_id,
                            snapshot, captured_by)
          VALUES (${a.id}, ${appointmentId}, ${row.patient_id}, ${row.professional_id},
                  ${row.location_id}, '{"source":"private"}'::jsonb, gen_random_uuid())
          RETURNING id`,
  );
  position += 1;
  const id = await returningId(
    tx,
    sql`INSERT INTO charge_line (tenant_id, charge_id, position, kind, portion, description, amount_cents)
          VALUES (${a.id}, ${chargeId}, ${position}, 'service', 'patient', 'Consulta', ${amount})
          RETURNING id`,
  );
  return { id, chargeId, amount };
}

const invoicedOf = async (tx: Tx, lineId: string) =>
  Number(
    (
      await tx.execute<{ invoiced_cents: string }>(
        sql`SELECT invoiced_cents FROM charge_line WHERE id = ${lineId}`,
      )
    ).rows[0]?.invoiced_cents,
  );

let numbering = 0;

interface NewInvoice {
  type?: string;
  status?: string;
  number?: number | null;
  cae?: string | null;
  pointOfSale?: number;
  patientId?: string;
  creditNoteOf?: string;
  reason?: string | null;
  rejection?: string | null;
  deliveryState?: string | null;
  net?: number;
  vat?: number;
  exempt?: number;
}

/** An invoice over `parts` (a line and the cents it covers), with the lines inserted with it. */
async function invoice(
  tx: Tx,
  parts: readonly { line: Line; cents: number }[],
  settings: NewInvoice = {},
): Promise<string> {
  const total = parts.reduce((sum, part) => sum + part.cents, 0);
  const status = settings.status ?? 'pending';
  const type = settings.type ?? 'FC';
  const issued = status === 'issued' || status === 'manual';
  numbering += 1;
  const patientId = settings.patientId ?? (await insertPatient(tx, a.id));
  const id = await returningId(
    tx,
    sql`INSERT INTO invoice (tenant_id, type, point_of_sale, number, status, delivery_state, cae,
                             cae_expires_on, issue_date, environment, simulated, idempotency_key,
                             request_hash, recipient_kind, patient_id, recipient_name,
                             recipient_tax_condition, total_cents, net_cents, vat_cents, exempt_cents,
                             location_ids, credit_note_of_id, reason, rejection_message, created_by)
          VALUES (${a.id}, ${type}, ${settings.pointOfSale ?? 1},
                  ${settings.number === undefined ? (issued ? numbering : null) : settings.number},
                  ${status},
                  ${settings.deliveryState === undefined ? (status === 'pending' ? 'queued' : null) : settings.deliveryState},
                  ${settings.cae === undefined ? (issued ? String(70_000_000_100_000 + numbering) : null) : settings.cae},
                  ${status === 'issued' ? sql`date '2031-02-01'` : null},
                  date '2031-01-02', 'homologation', true, ${randomUUID()}, 'hash', 'patient',
                  ${patientId}, 'Paciente de prueba', 'consumidor_final', ${total},
                  ${settings.net ?? total}, ${settings.vat ?? 0}, ${settings.exempt ?? 0},
                  ARRAY[]::uuid[], ${settings.creditNoteOf ?? null}, ${settings.reason ?? null},
                  ${settings.rejection ?? null}, gen_random_uuid())
          RETURNING id`,
  );
  let order = 0;
  for (const part of parts) {
    order += 1;
    await tx.execute(
      sql`INSERT INTO invoice_line (tenant_id, invoice_id, charge_line_id, charge_id, position,
                                    description, amount_cents)
            VALUES (${a.id}, ${id}, ${part.line.id}, ${part.line.chargeId}, ${order}, 'Consulta',
                    ${part.cents})`,
    );
  }
  return id;
}

describe('the invoice record', () => {
  it('starts pending with a queued sub-state, no number and no CAE', async () => {
    const row = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx);
      const id = await invoice(tx, [{ line, cents: 500_000 }]);
      return (
        await tx.execute(
          sql`SELECT status, delivery_state, number, cae, total_cents, attempts FROM invoice WHERE id = ${id}`,
        )
      ).rows[0];
    });

    expect(row).toMatchObject({
      status: 'pending',
      delivery_state: 'queued',
      number: null,
      cae: null,
      total_cents: '500000',
      attempts: 0,
    });
  });

  it('knows four statuses and six types, and keeps a sub-state only while pending', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx);
      const parts = [{ line, cents: 100 }];
      return [
        await refusal(tx, (inner) => invoice(inner, parts, { status: 'voided' })),
        await refusal(tx, (inner) => invoice(inner, parts, { type: 'FD' })),
        await refusal(tx, (inner) => invoice(inner, parts, { deliveryState: 'sleeping' })),
        await refusal(tx, (inner) => invoice(inner, parts, { deliveryState: null })),
        await refusal(tx, (inner) =>
          invoice(inner, parts, { status: 'issued', deliveryState: 'queued' }),
        ),
        await refusal(tx, (inner) => invoice(inner, parts, { type: 'FA' })),
      ];
    });

    // A pending invoice of each type is fine; the sub-state belongs to pending alone.
    expect(codes).toEqual(['23514', '23514', '23514', '23514', '23514', undefined]);
  });

  it('carries a number and a CAE of 14 digits only once issued or registered by hand', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx);
      const parts = [{ line, cents: 100 }];
      return [
        await refusal(tx, (inner) => invoice(inner, parts, { cae: '70000000000001' })),
        await refusal(tx, (inner) => invoice(inner, parts, { number: 1 })),
        await refusal(tx, (inner) => invoice(inner, parts, { status: 'issued', cae: null })),
        await refusal(tx, (inner) => invoice(inner, parts, { status: 'issued', number: null })),
        await refusal(tx, (inner) => invoice(inner, parts, { status: 'issued', cae: '1234' })),
        await refusal(tx, (inner) => invoice(inner, parts, { status: 'manual' })),
      ];
    });

    expect(codes).toEqual(['23514', '23514', '23514', '23514', '23514', undefined]);
  });

  it('says why a rejected attempt was rejected, and only a rejected one', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx);
      const parts = [{ line, cents: 100 }];
      return [
        await refusal(tx, (inner) =>
          invoice(inner, parts, { status: 'rejected', deliveryState: null }),
        ),
        await refusal(tx, (inner) =>
          invoice(inner, parts, { rejection: 'El CUIT no es válido', deliveryState: 'queued' }),
        ),
        await refusal(tx, (inner) =>
          invoice(inner, parts, {
            status: 'rejected',
            deliveryState: null,
            rejection: 'El CUIT no es válido',
          }),
        ),
      ];
    });

    expect(codes).toEqual(['23514', '23514', undefined]);
  });

  it('keeps net, VAT and exempt amounts adding up to the total', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx);
      const parts = [{ line, cents: 1000 }];
      return [
        await refusal(tx, (inner) => invoice(inner, parts, { net: 900, vat: 0, exempt: 0 })),
        await refusal(tx, (inner) => invoice(inner, parts, { net: 0, vat: 0, exempt: 1000 })),
        await refusal(tx, (inner) => invoice(inner, parts, { net: 826, vat: 174, exempt: 0 })),
      ];
    });

    expect(codes).toEqual(['23514', undefined, undefined]);
  });

  it('numbers an invoice once per point of sale and type, and never reuses a submission key', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 10_000);
      const parts = [{ line, cents: 100 }];
      await invoice(tx, parts, { status: 'issued', number: 4001, pointOfSale: 7 });
      const same = await refusal(tx, (inner) =>
        invoice(inner, parts, { status: 'issued', number: 4001, pointOfSale: 7 }),
      );
      const otherPos = await refusal(tx, (inner) =>
        invoice(inner, parts, { status: 'issued', number: 4001, pointOfSale: 8 }),
      );
      const otherType = await refusal(tx, (inner) =>
        invoice(inner, parts, { status: 'issued', number: 4001, pointOfSale: 7, type: 'FB' }),
      );
      const key = randomUUID();
      const insertKey = (inner: Tx) =>
        inner.execute(
          sql`INSERT INTO invoice (tenant_id, type, point_of_sale, status, delivery_state, issue_date,
                                   environment, idempotency_key, request_hash, recipient_kind,
                                   recipient_tax_condition, total_cents, net_cents, location_ids,
                                   created_by)
                VALUES (${a.id}, 'FC', 1, 'pending', 'queued', date '2031-01-02', 'homologation',
                        ${key}, 'hash', 'patient', 'consumidor_final', 100, 100,
                        ARRAY[]::uuid[], gen_random_uuid())`,
        );
      // A patient recipient needs the patient: the key test uses a payer-less, patient-less row on purpose.
      const firstKey = await refusal(tx, insertKey);
      return { same, otherPos, otherType, firstKey };
    });

    expect(result.same).toBe('23505');
    expect(result.otherPos).toBeUndefined();
    expect(result.otherType).toBeUndefined();
    // No patient on a patient invoice is itself a violation: the recipient rules hold first.
    expect(result.firstKey).toBe('23514');
  });

  it('names the patient of a patient invoice and the payer of a payer invoice', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const attempt = (kind: string, patient: boolean, payer: boolean) =>
        refusal(tx, async (inner) => {
          const patientId = patient ? await insertPatient(inner, a.id) : null;
          const payerId = payer
            ? await returningId(
                inner,
                sql`INSERT INTO tenant_payer (tenant_id, custom_name) VALUES (${a.id}, ${'Prepaga ' + randomUUID()}) RETURNING id`,
              )
            : null;
          await inner.execute(
            sql`INSERT INTO invoice (tenant_id, type, point_of_sale, status, delivery_state, issue_date,
                                     environment, idempotency_key, request_hash, recipient_kind,
                                     patient_id, tenant_payer_id, recipient_tax_condition,
                                     total_cents, net_cents, location_ids, created_by)
                  VALUES (${a.id}, 'FC', 1, 'pending', 'queued', date '2031-01-02', 'homologation',
                          ${randomUUID()}, 'hash', ${kind}, ${patientId}, ${payerId},
                          'consumidor_final', 100, 100, ARRAY[]::uuid[], gen_random_uuid())`,
          );
        });
      return [
        await attempt('patient', true, false),
        await attempt('payer', false, true),
        await attempt('patient', false, false),
        await attempt('payer', true, false),
        await attempt('patient', true, true),
      ];
    });

    expect(codes).toEqual([undefined, undefined, '23514', '23514', '23514']);
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx);
      await invoice(tx, [{ line, cents: 100 }]);
      return refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM invoice WHERE tenant_id = ${a.id}`),
      );
    });

    expect(code).toBe('42501');
  });
});

describe('an issued or registered invoice never changes', () => {
  /** Commits an invoice of the status, then tries to change it from a transaction of its own. */
  async function committed(status: 'issued' | 'manual' | 'rejected' | 'pending') {
    return asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx);
      return invoice(tx, [{ line, cents: 1000 }], {
        status,
        ...(status === 'rejected' ? { rejection: 'Rechazada', deliveryState: null } : {}),
      });
    });
  }
  const change = (id: string, set: ReturnType<typeof sql>) =>
    asTenant(runtime, a.id, (tx) =>
      refusal(tx, (inner) => inner.execute(sql`UPDATE invoice SET ${set} WHERE id = ${id}`)),
    );

  it('refuses any update of an issued invoice, even to the same value', async () => {
    const id = await committed('issued');

    expect(await change(id, sql`recipient_name = 'Otra persona'`)).toBe('42501');
    expect(await change(id, sql`total_cents = 1, net_cents = 1`)).toBe('42501');
    expect(await change(id, sql`cae = '70000000009999'`)).toBe('42501');
    expect(
      await change(
        id,
        sql`status = 'pending', cae = null, number = null, delivery_state = 'queued'`,
      ),
    ).toBe('42501');
    expect(await change(id, sql`attempts = attempts`)).toBe('42501');
  });

  it('refuses any update of a manual invoice and of a rejected attempt', async () => {
    const manual = await committed('manual');
    const rejected = await committed('rejected');

    expect(await change(manual, sql`recipient_name = 'Otra persona'`)).toBe('42501');
    expect(await change(rejected, sql`rejection_message = 'Otra'`)).toBe('42501');
    expect(
      await change(
        rejected,
        sql`status = 'pending', delivery_state = 'queued', rejection_message = null`,
      ),
    ).toBe('42501');
  });

  it('lets a pending invoice move only its retry bookkeeping, then become issued or rejected', async () => {
    const id = await committed('pending');

    expect(
      await change(id, sql`attempts = 1, delivery_state = 'retrying', next_attempt_at = now()`),
    ).toBeUndefined();
    // What was asked for never changes while the invoice waits.
    expect(await change(id, sql`total_cents = 5, net_cents = 5`)).toBe('42501');
    expect(await change(id, sql`recipient_name = 'Otra persona'`)).toBe('42501');
    expect(await change(id, sql`idempotency_key = ${randomUUID()}`)).toBe('42501');
    expect(await change(id, sql`type = 'FB'`)).toBe('42501');
    // A pending invoice cannot become a manual one.
    expect(
      await change(
        id,
        sql`status = 'manual', delivery_state = null, number = 99, cae = '70000000000009'`,
      ),
    ).toBe('42501');
    expect(
      await change(
        id,
        sql`status = 'issued', delivery_state = null, number = 4242, cae = '70000000000042', cae_expires_on = date '2031-02-01', issued_at = now()`,
      ),
    ).toBeUndefined();
    // And once issued it is closed.
    expect(await change(id, sql`recipient_name = 'Otra persona'`)).toBe('42501');
  });
});

describe('the amount invoiced of a charge line', () => {
  it('follows the invoices that cover it, parts included', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 20_000);
      const none = await invoicedOf(tx, line.id);
      await invoice(tx, [{ line, cents: 12_000 }]);
      const first = await invoicedOf(tx, line.id);
      await invoice(tx, [{ line, cents: 8_000 }]);
      const second = await invoicedOf(tx, line.id);
      return { none, first, second };
    });

    expect(result).toEqual({ none: 0, first: 12_000, second: 20_000 });
  });

  it('refuses an invoice beyond the line, the third part of the example', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 20_000);
      await invoice(tx, [{ line, cents: 12_000 }]);
      await invoice(tx, [{ line, cents: 8_000 }]);
      const third = await refusal(tx, (inner) => invoice(inner, [{ line, cents: 1 }]));
      return { third, invoiced: await invoicedOf(tx, line.id) };
    });

    expect(result).toEqual({ third: '23514', invoiced: 20_000 });
  });

  it('sums one invoice over lines of two charges', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const one = await chargeLine(tx, 10_000);
      const two = await chargeLine(tx, 10_000);
      await invoice(tx, [
        { line: one, cents: 10_000 },
        { line: two, cents: 10_000 },
      ]);
      return [await invoicedOf(tx, one.id), await invoicedOf(tx, two.id)];
    });

    expect(result).toEqual([10_000, 10_000]);
  });

  it('is released when the attempt is rejected, and stays when it is issued', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 10_000);
      const rejected = await invoice(tx, [{ line, cents: 10_000 }]);
      const held = await invoicedOf(tx, line.id);
      await tx.execute(
        sql`UPDATE invoice SET status = 'rejected', delivery_state = NULL,
                               rejection_message = 'El CUIT del receptor no es válido'
             WHERE id = ${rejected}`,
      );
      const released = await invoicedOf(tx, line.id);
      // The line can be invoiced again, and the new attempt is issued.
      const retry = await invoice(tx, [{ line, cents: 10_000 }]);
      await tx.execute(
        sql`UPDATE invoice SET status = 'issued', delivery_state = NULL, number = 5100,
                               cae = '70000000000051', cae_expires_on = date '2031-02-01',
                               issued_at = now()
             WHERE id = ${retry}`,
      );
      return { held, released, issued: await invoicedOf(tx, line.id) };
    });

    expect(result).toEqual({ held: 10_000, released: 0, issued: 10_000 });
  });

  it('adds lines only while the invoice is being created, never afterwards', async () => {
    const id = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 10_000);
      return invoice(tx, [{ line, cents: 1_000 }]);
    });

    const code = await asTenant(runtime, a.id, async (tx) => {
      const other = await chargeLine(tx, 10_000);
      return refusal(tx, (inner) =>
        inner.execute(
          sql`INSERT INTO invoice_line (tenant_id, invoice_id, charge_line_id, charge_id, position,
                                        description, amount_cents)
                VALUES (${a.id}, ${id}, ${other.id}, ${other.chargeId}, 9, 'Consulta', 100)`,
        ),
      );
    });

    expect(code).toBe('42501');
  });

  it('refuses to change or delete an invoice line', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 10_000);
      const id = await invoice(tx, [{ line, cents: 1_000 }]);
      return [
        await refusal(tx, (inner) =>
          inner.execute(sql`UPDATE invoice_line SET amount_cents = 1 WHERE invoice_id = ${id}`),
        ),
        await refusal(tx, (inner) =>
          inner.execute(sql`DELETE FROM invoice_line WHERE invoice_id = ${id}`),
        ),
      ];
    });

    expect(codes).toEqual(['42501', '42501']);
  });

  it('names the charge a line belongs to, and refuses another one', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 10_000);
      const other = await chargeLine(tx, 10_000);
      return refusal(tx, (inner) =>
        invoice(inner, [{ line: { ...line, chargeId: other.chargeId }, cents: 100 }]),
      );
    });

    expect(code).toBe('23514');
  });
});

describe('credit notes', () => {
  /** An issued invoice of `cents` over a line, committed. */
  async function issuedInvoice(tx: Tx, line: Line, cents: number, type = 'FC') {
    return invoice(tx, [{ line, cents }], { status: 'issued', type });
  }

  it('reduces the amount invoiced only once the note is issued', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 20_000);
      const original = await issuedInvoice(tx, line, 20_000);
      const note = await invoice(tx, [{ line, cents: 20_000 }], {
        type: 'NCC',
        creditNoteOf: original,
        reason: 'Error de carga',
      });
      const pending = await invoicedOf(tx, line.id);
      await tx.execute(
        sql`UPDATE invoice SET status = 'issued', delivery_state = NULL, number = 8100,
                               cae = '70000000000081', cae_expires_on = date '2031-02-01',
                               issued_at = now()
             WHERE id = ${note}`,
      );
      return { pending, issued: await invoicedOf(tx, line.id) };
    });

    expect(result).toEqual({ pending: 20_000, issued: 0 });
  });

  it('needs a reason, an original invoice and the matching letter', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 20_000);
      const original = await issuedInvoice(tx, line, 20_000);
      const parts = [{ line, cents: 5_000 }];
      return [
        await refusal(tx, (inner) =>
          invoice(inner, parts, { type: 'NCC', creditNoteOf: original, reason: null }),
        ),
        await refusal(tx, (inner) => invoice(inner, parts, { type: 'NCC', reason: 'Error' })),
        await refusal(tx, (inner) =>
          invoice(inner, parts, { type: 'FC', creditNoteOf: original, reason: 'Error' }),
        ),
        await refusal(tx, (inner) =>
          invoice(inner, parts, { type: 'NCB', creditNoteOf: original, reason: 'Error' }),
        ),
        await refusal(tx, (inner) =>
          invoice(inner, parts, { type: 'NCC', creditNoteOf: original, reason: 'Error' }),
        ),
      ];
    });

    expect(codes).toEqual(['23514', '23514', '23514', '23514', undefined]);
  });

  it('never credits more than the invoice, counting the notes still pending', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 20_000);
      const original = await issuedInvoice(tx, line, 20_000);
      const note = (cents: number) => (inner: Tx) =>
        invoice(inner, [{ line, cents }], { type: 'NCC', creditNoteOf: original, reason: 'Error' });
      await note(15_000)(tx);
      const over = await refusal(tx, note(8_000));
      const exact = await refusal(tx, note(5_000));
      const nothingLeft = await refusal(tx, note(1));
      return { over, exact, nothingLeft };
    });

    expect(result).toEqual({ over: '23514', exact: undefined, nothingLeft: '23514' });
  });

  it('does not count a rejected note against the invoice', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 20_000);
      const original = await issuedInvoice(tx, line, 20_000);
      const first = await invoice(tx, [{ line, cents: 20_000 }], {
        type: 'NCC',
        creditNoteOf: original,
        reason: 'Error',
      });
      await tx.execute(
        sql`UPDATE invoice SET status = 'rejected', delivery_state = NULL,
                               rejection_message = 'Rechazada' WHERE id = ${first}`,
      );
      const again = await refusal(tx, (inner) =>
        invoice(inner, [{ line, cents: 20_000 }], {
          type: 'NCC',
          creditNoteOf: original,
          reason: 'Error',
        }),
      );
      return { again, invoiced: await invoicedOf(tx, line.id) };
    });

    expect(result).toEqual({ again: undefined, invoiced: 20_000 });
  });

  it('covers only lines of the invoice it cancels', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const line = await chargeLine(tx, 20_000);
      const stranger = await chargeLine(tx, 20_000);
      const original = await issuedInvoice(tx, line, 20_000);
      return refusal(tx, (inner) =>
        invoice(inner, [{ line: stranger, cents: 1_000 }], {
          type: 'NCC',
          creditNoteOf: original,
          reason: 'Error',
        }),
      );
    });

    expect(code).toBe('23514');
  });
});
