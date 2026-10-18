import {
  PAYMENT_METHODS,
  allocateProportional,
  applyBasisPoints,
  money,
  negateMoney,
  type CashCurrentResponse,
  type CashSessionDto,
  type ChargeDto,
  type InvoiceDto,
  type PaymentMethod,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  differenceOf,
  summarizeSession,
  type CashMovement,
} from '../../src/modules/billing/domain/cash-summary.js';
import { chargeStatusOf, summarizeCharge } from '../../src/modules/billing/domain/charge-status.js';
import {
  allocateCredit,
  planParts,
  type PartRequest,
} from '../../src/modules/invoicing/domain/invoice-amounts.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * The rules about money, held under random input (tasks 4.61; BIL-06, BIL-08, INV-05, INV-07):
 *
 * 1. a payment never takes a charge above the patient's portion unless somebody confirmed the credit;
 * 2. the refunds of a payment never add up to more than the payment;
 * 3. the invoices over a charge line never add up to more than the line;
 * 4. the credit notes of an invoice never add up to more than the invoice;
 * 5. the cash that should be in the drawer is the opening cash plus the cash taken minus the cash
 *    given back, and nothing else.
 *
 * Two layers. The first (always runs, no database) throws random amounts at the pure arithmetic the
 * rules are built from. The second (runs with the integration suite, which has a database) walks the
 * real application through random sequences of payments, refunds, invoices and credit notes, and
 * compares every answer with a model written from the specification: when the model says an amount
 * is allowed the application must accept it, when it says it is not the application must refuse it,
 * and after every step the database must hold the invariants.
 */

const cents = (max: number) => fc.integer({ min: 0, max });
const method = fc.constantFrom<PaymentMethod>(...PAYMENT_METHODS);

describe('the arithmetic of a charge (rule 1)', () => {
  const line = fc.record({
    portion: fc.constantFrom('patient', 'payer'),
    amountCents: cents(5_000_000),
  });

  it('never owes and credits at once, and the two add up to the distance from the patient portion', () => {
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 6 }),
        cents(10_000_000),
        (lines, paid) => {
          const summary = summarizeCharge(
            lines.map((entry) => ({ ...entry, invoicedCents: 0 })),
            paid,
          );

          expect(summary.outstandingCents * summary.creditCents).toBe(0);
          expect(summary.creditCents - summary.outstandingCents).toBe(paid - summary.patientCents);
          expect(summary.patientCents + summary.payerCents).toBe(summary.totalCents);
        },
      ),
    );
  });

  it('is settled exactly when the patient has paid their portion, whatever the payer owes', () => {
    fc.assert(
      fc.property(cents(5_000_000), cents(5_000_000), (patientCents, paidNetCents) => {
        const status = chargeStatusOf({ voided: false, patientCents, paidNetCents });

        expect(status === 'paid').toBe(paidNetCents >= patientCents);
        expect(status === 'pending').toBe(paidNetCents === 0 && patientCents > 0);
        expect(chargeStatusOf({ voided: true, patientCents, paidNetCents })).toBe('voided');
      }),
    );
  });

  it('counts a positive credit only when more was paid than the patient portion', () => {
    const summary = summarizeCharge(
      [
        { portion: 'patient', amountCents: 100_000, invoicedCents: 0 },
        { portion: 'payer', amountCents: 900_000, invoicedCents: 0 },
      ],
      100_001,
    );

    expect(summary).toMatchObject({ outstandingCents: 0, creditCents: 1, patientCents: 100_000 });
  });
});

describe('the arithmetic of an invoice (rules 3 and 4)', () => {
  const left = fc.array(cents(2_000_000), { minLength: 1, maxLength: 6 });

  it('plans parts that are positive, never above what is left of a line, and that add up', () => {
    fc.assert(
      fc.property(
        left,
        fc.array(fc.option(fc.integer({ min: -10, max: 2_500_000 }), { nil: undefined }), {
          maxLength: 8,
        }),
        (lefts, asked) => {
          const lines = lefts.map((uninvoicedCents, index) => ({
            id: `line-${String(index)}`,
            uninvoicedCents,
          }));
          const requests: PartRequest[] = asked.map((amountCents, index) => ({
            chargeLineId: `line-${String(index % (lefts.length + 1))}`,
            amountCents,
          }));

          const plan = planParts(lines, requests);

          if (plan.ok) {
            for (const part of plan.parts) {
              const available = lines.find((entry) => entry.id === part.chargeLineId);
              expect(part.amountCents).toBeGreaterThan(0);
              expect(part.amountCents).toBeLessThanOrEqual(available?.uninvoicedCents ?? -1);
            }
            expect(new Set(plan.parts.map((part) => part.chargeLineId)).size).toBe(
              plan.parts.length,
            );
            expect(plan.totalCents).toBe(
              plan.parts.reduce((sum, part) => sum + part.amountCents, 0),
            );
          } else {
            // A refusal always names a real fault: an unknown line, a repeated one, or too much.
            const named = requests.find((request) => request.chargeLineId === plan.chargeLineId);
            expect(named).toBeDefined();
          }
        },
      ),
    );
  });

  it('refuses an amount one cent above what is left, and accepts exactly what is left', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2_000_000 }), (available) => {
        const lines = [{ id: 'a', uninvoicedCents: available }];

        expect(planParts(lines, [{ chargeLineId: 'a', amountCents: available + 1 }])).toEqual({
          ok: false,
          reason: 'over_invoiced',
          chargeLineId: 'a',
        });
        expect(planParts(lines, [{ chargeLineId: 'a', amountCents: available }])).toMatchObject({
          ok: true,
          totalCents: available,
        });
      }),
    );
  });

  it('splits a credit note over the lines without giving one more than it can take back', () => {
    fc.assert(
      fc.property(left, fc.nat({ max: 100 }), (lefts, percent) => {
        const available = lefts.reduce((sum, entry) => sum + entry, 0);
        if (available === 0) return;
        const note = Math.floor((available * percent) / 100);

        const parts = allocateCredit(lefts, note);

        expect(parts.reduce((sum, part) => sum + part, 0)).toBe(note);
        parts.forEach((part, index) => {
          expect(part).toBeGreaterThanOrEqual(0);
          expect(part).toBeLessThanOrEqual(lefts[index] ?? 0);
        });
      }),
    );
  });

  it('refuses a credit note above what is left of the invoice', () => {
    fc.assert(
      fc.property(left, fc.integer({ min: 1, max: 1000 }), (lefts, extra) => {
        const available = lefts.reduce((sum, entry) => sum + entry, 0);

        expect(() => allocateCredit(lefts, available + extra)).toThrow(RangeError);
      }),
    );
  });

  it('never credits more than the invoice over any series of notes', () => {
    fc.assert(
      fc.property(left, fc.array(fc.nat({ max: 100 }), { maxLength: 8 }), (original, percents) => {
        let remaining = [...original];
        const total = original.reduce((sum, entry) => sum + entry, 0);
        let credited = 0;
        for (const percent of percents) {
          const available = remaining.reduce((sum, entry) => sum + entry, 0);
          const note = Math.floor((available * percent) / 100);
          if (note === 0) continue;
          const parts = allocateCredit(remaining, note);
          remaining = remaining.map((entry, index) => entry - (parts[index] ?? 0));
          credited += note;
        }

        expect(credited).toBeLessThanOrEqual(total);
        expect(remaining.every((entry) => entry >= 0)).toBe(true);
        expect(remaining.reduce((sum, entry) => sum + entry, 0)).toBe(total - credited);
      }),
    );
  });
});

describe('the arithmetic of the cash register (rule 5)', () => {
  const movement = fc.record({
    direction: fc.constantFrom<'in' | 'out'>('in', 'out'),
    method,
    amountCents: fc.integer({ min: 1, max: 3_000_000 }),
  });

  it('expects the opening cash plus the cash taken minus the cash given back, and no other method', () => {
    fc.assert(
      fc.property(cents(2_000_000), fc.array(movement, { maxLength: 30 }), (opening, movements) => {
        const cash = (direction: CashMovement['direction']) =>
          movements
            .filter((entry) => entry.method === 'cash' && entry.direction === direction)
            .reduce((sum, entry) => sum + entry.amountCents, 0);

        const summary = summarizeSession(opening, movements);

        expect(summary.cashInCents).toBe(cash('in'));
        expect(summary.cashOutCents).toBe(cash('out'));
        expect(summary.expectedCents).toBe(opening + cash('in') - cash('out'));
      }),
    );
  });

  it('adds up by method to everything that came in minus everything that went back', () => {
    fc.assert(
      fc.property(fc.array(movement, { maxLength: 30 }), (movements) => {
        const summary = summarizeSession(0, movements);

        const net = movements.reduce(
          (sum, entry) => sum + (entry.direction === 'in' ? entry.amountCents : -entry.amountCents),
          0,
        );
        expect(summary.byMethod.reduce((sum, entry) => sum + entry.netCents, 0)).toBe(net);
        expect(summary.byMethod.reduce((sum, entry) => sum + entry.count, 0)).toBe(
          movements.length,
        );
      }),
    );
  });

  it('reads the difference as counted minus expected, negative when cash is missing', () => {
    fc.assert(
      fc.property(cents(5_000_000), cents(5_000_000), (expected, counted) => {
        expect(differenceOf(expected, counted)).toBe(counted - expected);
      }),
    );
    expect(differenceOf(100_000, 99_000)).toBe(-1_000);
  });
});

describe('the one way money is counted', () => {
  it('splits a total over weights without losing or inventing a cent', () => {
    fc.assert(
      fc.property(
        cents(50_000_000),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 8 }),
        (total, weights) => {
          const parts = allocateProportional(money(total), weights);

          expect(parts.reduce((sum, part) => sum + part, 0)).toBe(total);
          expect(parts.every((part) => part >= 0)).toBe(true);
        },
      ),
    );
  });

  it('rounds a percentage the same way for a credit and for a debit', () => {
    fc.assert(
      fc.property(cents(50_000_000), fc.integer({ min: 0, max: 30_000 }), (amount, rate) => {
        expect(applyBasisPoints(money(-amount), rate)).toBe(
          negateMoney(applyBasisPoints(money(amount), rate)),
        );
      }),
    );
  });
});

// The application, walked through random sequences ------------------------------------------------

const hasDatabase = typeof inject('runtimeUrl') === 'string';

/** How an amount relates to the limit the model knows: right on it, one cent over, under, or any. */
type How = 'exact' | 'over' | 'under' | 'any';
const how = fc.constantFrom<How>('exact', 'over', 'under', 'any');
const anyAmount = fc.integer({ min: 1, max: 3_000_000 });

const Command = fc.oneof(
  fc.record({
    kind: fc.constant('pay' as const),
    method,
    how,
    any: anyAmount,
    confirm: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('refund' as const),
    which: fc.nat({ max: 9 }),
    how,
    any: anyAmount,
  }),
  fc.record({
    kind: fc.constant('invoice' as const),
    which: fc.nat({ max: 3 }),
    how,
    any: anyAmount,
  }),
  fc.record({
    kind: fc.constant('credit' as const),
    which: fc.nat({ max: 9 }),
    how,
    any: anyAmount,
  }),
);
type Command = typeof Command extends fc.Arbitrary<infer T> ? T : never;

function resolveAmount(limit: number, relation: How, any: number): number {
  switch (relation) {
    case 'exact':
      return Math.max(1, limit);
    case 'over':
      return limit + 1;
    case 'under':
      return Math.max(1, limit - 1);
    case 'any':
      return any;
  }
}

interface Model {
  lines: { id: string; amount: number; invoiced: number }[];
  payments: { id: string; method: PaymentMethod; amount: number; refunded: number }[];
  invoices: { id: string; lineIndex: number; total: number; credited: number }[];
  cashIn: number;
  cashOut: number;
}

const patientPortion = (model: Model) => model.lines.reduce((sum, entry) => sum + entry.amount, 0);
const paidNet = (model: Model) =>
  model.payments.reduce((sum, entry) => sum + entry.amount - entry.refunded, 0);
const outstanding = (model: Model) => Math.max(0, patientPortion(model) - paidNet(model));

describe.skipIf(!hasDatabase)('the application under random sequences (rules 1 to 5)', () => {
  let runtime: DbHandle;
  let world: InvoicingWorld;

  beforeAll(async () => {
    runtime = createRuntimeDb(inject('runtimeUrl'));
    world = await createInvoicingWorld(runtime, { slug: 'money-invariants' });
  }, 120_000);

  afterAll(async () => {
    await world.close();
    await runtime.close();
  });

  /** What the database itself holds true after every step, whatever the application answered. */
  async function databaseHolds(chargeId: string) {
    const rows = <T>(result: { rows: T[] }) => result.rows;
    return world.inTenant(async (tx) => {
      const refundsAbovePayment = rows(
        await tx.execute<{ id: string }>(sql`
          SELECT p.id FROM payment p
            LEFT JOIN payment_reversal r ON r.payment_id = p.id
           WHERE p.charge_id = ${chargeId}
           GROUP BY p.id, p.amount_cents
          HAVING coalesce(sum(r.amount_cents), 0) > p.amount_cents`),
      );
      const paidAbovePatientWithoutCredit = rows(
        await tx.execute<{ paid: string; allowed: string }>(sql`
          SELECT paid.net AS paid, coalesce(patient.total, 0) + paid.credit AS allowed
            FROM (SELECT coalesce(sum(p.amount_cents), 0)
                         - coalesce((SELECT sum(r.amount_cents) FROM payment_reversal r
                                      WHERE r.charge_id = ${chargeId}), 0) AS net,
                         coalesce(sum(p.credit_cents), 0) AS credit
                    FROM payment p WHERE p.charge_id = ${chargeId}) paid,
                 (SELECT sum(l.amount_cents) AS total FROM charge_line l
                   WHERE l.charge_id = ${chargeId} AND l.portion = 'patient') patient
           WHERE paid.net > coalesce(patient.total, 0) + paid.credit`),
      );
      const linesOutOfRange = rows(
        await tx.execute<{ id: string }>(sql`
          SELECT l.id FROM charge_line l
           WHERE l.charge_id = ${chargeId}
             AND (l.invoiced_cents < 0 OR l.invoiced_cents > l.amount_cents)`),
      );
      const creditAboveInvoice = rows(
        await tx.execute<{ id: string }>(sql`
          SELECT i.id FROM invoice i
            JOIN (SELECT n.credit_note_of_id AS original, sum(n.total_cents) AS credited
                    FROM invoice n WHERE n.status <> 'rejected' AND n.credit_note_of_id IS NOT NULL
                   GROUP BY n.credit_note_of_id) c ON c.original = i.id
           WHERE c.credited > i.total_cents`),
      );
      return {
        refundsAbovePayment,
        paidAbovePatientWithoutCredit,
        linesOutOfRange,
        creditAboveInvoice,
      };
    });
  }

  it('accepts what the model allows, refuses what it does not, and never breaks an invariant', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(cents(1_500_000), { maxLength: 2 }),
        cents(500_000),
        fc.array(Command, { minLength: 1, maxLength: 9 }),
        cents(5_000),
        async (extraLines, openingCents, commands, miscount) => {
          // A run that failed halfway leaves its register open; the next one starts clean.
          await closeLeftoverRegister();
          const register: CashSessionDto = await world.openRegister({ openingCents });
          try {
            const charge = await world.charge();
            const model: Model = {
              lines: charge.lines.map((entry) => ({
                id: entry.id,
                amount: entry.amountCents,
                invoiced: 0,
              })),
              payments: [],
              invoices: [],
              cashIn: 0,
              cashOut: 0,
            };
            for (const [index, amountCents] of extraLines.entries()) {
              if (amountCents === 0) continue;
              const added = await world.api.post(
                `/billing/charges/${charge.id}/lines`,
                world.owner,
                {
                  description: `Concepto ${String(index + 1)}`,
                  amountCents,
                },
              );
              expect(added.statusCode, added.body).toBe(201);
              const lines = added.json<ChargeDto>().lines;
              const fresh = lines.find(
                (entry) => !model.lines.some((known) => known.id === entry.id),
              );
              if (!fresh) throw new Error('the new line is not in the charge');
              model.lines.push({ id: fresh.id, amount: fresh.amountCents, invoiced: 0 });
            }
            expect(patientPortion(model)).toBe((await world.chargeOf(charge.id)).patientCents);

            for (const command of commands) {
              await run(model, charge.id, command);
              await agrees(model, charge.id);
              const held = await databaseHolds(charge.id);
              expect(held).toEqual({
                refundsAbovePayment: [],
                paidAbovePatientWithoutCredit: [],
                linesOutOfRange: [],
                creditAboveInvoice: [],
              });
            }

            // Rule 5, on the register of this run.
            const current = await world.api.get(
              `/billing/cash/current?locationId=${world.centro}`,
              world.owner,
            );
            const open = current.json<CashCurrentResponse>().session;
            const expected = openingCents + model.cashIn - model.cashOut;
            expect(open).toMatchObject({
              cashInCents: model.cashIn,
              cashOutCents: model.cashOut,
              expectedCents: expected,
            });
            const counted = Math.max(0, expected - miscount);
            const closed = await world.api.post(
              `/billing/cash/sessions/${register.id}/close`,
              world.owner,
              {
                countedCents: counted,
                ...(counted === expected ? {} : { differenceReason: 'Diferencia de la prueba' }),
              },
            );
            expect(closed.statusCode, closed.body).toBe(200);
            expect(closed.json<CashSessionDto>()).toMatchObject({
              expectedCents: expected,
              differenceCents: counted - expected,
            });
          } finally {
            await closeLeftoverRegister();
          }
        },
      ),
      { numRuns: 16 },
    );
  }, 280_000);

  /** Closes the register of the main location if one is open, counting what it expects. */
  async function closeLeftoverRegister(): Promise<void> {
    const current = await world.api.get(
      `/billing/cash/current?locationId=${world.centro}`,
      world.owner,
    );
    const open = current.statusCode === 200 ? current.json<CashCurrentResponse>().session : null;
    if (open && open.status === 'open') {
      await world.api.post(`/billing/cash/sessions/${open.id}/close`, world.owner, {
        countedCents: open.expectedCents,
      });
    }
  }

  /** Does the command against the application and checks its answer against the model. */
  async function run(model: Model, chargeId: string, command: Command): Promise<void> {
    switch (command.kind) {
      case 'pay': {
        const limit = outstanding(model);
        const amount = resolveAmount(limit, command.how, command.any);
        const allowed = amount <= limit || command.confirm;
        const response = await world.pay(
          chargeId,
          {
            method: command.method,
            amountCents: amount,
            ...(command.confirm ? { confirmCredit: true } : {}),
          },
          world.reception,
        );
        expect(response.statusCode, `pay ${String(amount)}: ${response.body}`).toBe(
          allowed ? 201 : 409,
        );
        if (allowed) {
          model.payments.push({
            id: response.json<{ payment: { id: string } }>().payment.id,
            method: command.method,
            amount,
            refunded: 0,
          });
          if (command.method === 'cash') model.cashIn += amount;
        } else {
          expect(response.json<{ code: string }>().code).toBe('payment_overpayment');
        }
        return;
      }
      case 'refund': {
        const target = model.payments[command.which % Math.max(1, model.payments.length)];
        if (!target) return;
        const limit = target.amount - target.refunded;
        const amount = resolveAmount(limit, command.how, command.any);
        const allowed = amount <= limit;
        const response = await world.api.post(
          `/billing/payments/${target.id}/refund`,
          world.owner,
          {
            amountCents: amount,
            reason: 'Devolución de la prueba',
            idempotencyKey: submissionKey(),
          },
        );
        expect(response.statusCode, `refund ${String(amount)}: ${response.body}`).toBe(
          allowed ? 201 : 409,
        );
        if (allowed) {
          target.refunded += amount;
          if (target.method === 'cash') model.cashOut += amount;
        } else {
          expect(response.json<{ code: string }>().code).toBe('payment_refund_exceeds');
        }
        return;
      }
      case 'invoice': {
        const lineIndex = command.which % model.lines.length;
        const target = model.lines[lineIndex];
        if (!target) return;
        const limit = target.amount - target.invoiced;
        const amount = resolveAmount(limit, command.how, command.any);
        const allowed = amount <= limit;
        const response = await world.invoice(
          {
            lines: [{ chargeLineId: target.id, amountCents: amount }],
            recipient: { kind: 'patient' },
          },
          world.reception,
        );
        expect(response.statusCode, `invoice ${String(amount)}: ${response.body}`).toBe(
          allowed ? 202 : 409,
        );
        if (allowed) {
          target.invoiced += amount;
          await world.runIssue();
          const issued = await world.getInvoice(response.json<InvoiceDto>().id);
          expect(issued.status).toBe('issued');
          model.invoices.push({ id: issued.id, lineIndex, total: amount, credited: 0 });
        } else {
          expect(response.json<{ code: string }>().code).toBe('invoice_line_over_invoiced');
        }
        return;
      }
      case 'credit': {
        const target = model.invoices[command.which % Math.max(1, model.invoices.length)];
        if (!target) return;
        const limit = target.total - target.credited;
        const amount = resolveAmount(limit, command.how, command.any);
        const allowed = limit > 0 && amount <= limit;
        const response = await world.creditNote(target.id, { amountCents: amount });
        expect(response.statusCode, `credit ${String(amount)}: ${response.body}`).toBe(
          allowed ? 202 : 409,
        );
        if (allowed) {
          target.credited += amount;
          await world.runIssue();
          const line = model.lines[target.lineIndex];
          if (line) line.invoiced -= amount;
        } else {
          expect(response.json<{ code: string }>().code).toBe('invoice_credit_note_exceeds');
        }
        return;
      }
    }
  }

  /** The charge as the application shows it equals the model. */
  async function agrees(model: Model, chargeId: string): Promise<void> {
    const shown = await world.chargeOf(chargeId);
    expect(shown.paidCents).toBe(paidNet(model));
    expect(shown.outstandingCents).toBe(outstanding(model));
    expect(shown.creditCents).toBe(Math.max(0, paidNet(model) - patientPortion(model)));
    expect(shown.lines.map((entry) => ({ id: entry.id, invoiced: entry.invoicedCents }))).toEqual(
      model.lines.map((entry) => ({ id: entry.id, invoiced: entry.invoiced })),
    );
  }
});
