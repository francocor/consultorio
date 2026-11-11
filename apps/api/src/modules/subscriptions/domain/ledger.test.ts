import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PaymentDescription } from '../application/ports.js';

import {
  movesForward,
  planLedger as planWithOwnership,
  purposeOf,
  type LedgerOwnership,
  type RecordedPayment,
} from './ledger.js';

const payment = (
  id: string,
  at: string,
  overrides: Partial<PaymentDescription> = {},
): PaymentDescription => ({
  paymentId: id,
  externalReference: 'sub:abc:1',
  preapprovalId: 'PRE-1',
  amountCents: 3_600_000,
  currency: 'ARS',
  status: 'approved',
  refundedCents: 0,
  refunds: [],
  approvedAt: at,
  createdAt: at,
  ...overrides,
});

/** What the platform owns in these tests: the preapproval PRE-1 and the two links the payments name. */
const OWNED: LedgerOwnership = {
  preapprovalId: 'PRE-1',
  earlierPreapprovalIds: new Set(['PRE-0']),
  links: [
    { externalReference: 'due:abc:1', amountCents: 3_600_000, linkId: 'LNK-1' },
    { externalReference: 'stmt:abc:1', amountCents: 3_600_000, linkId: 'LNK-2' },
  ],
};

const planLedger = (
  input: Omit<Parameters<typeof planWithOwnership>[0], 'ownership'> & {
    ownership?: LedgerOwnership;
  },
) => planWithOwnership({ ownership: OWNED, ...input });

const MARCH_5 = '2026-03-05T15:00:00.000Z';
const MARCH_20 = '2026-03-20T15:00:00.000Z';
const APRIL_5 = '2026-04-05T15:00:00.000Z';

const none = new Map<string, RecordedPayment>();

function recordedOf(...entries: Partial<RecordedPayment>[]): Map<string, RecordedPayment> {
  return new Map(
    entries.map((entry, index) => [
      entry.providerPaymentId ?? `PAY-${String(index)}`,
      {
        providerPaymentId: `PAY-${String(index)}`,
        status: 'approved' as const,
        refundedCents: 0,
        purpose: 'charge' as const,
        period: '2026-03',
        surplus: false,
        credited: true,
        ...entry,
      },
    ]),
  );
}

describe('the ledger credits a billing period once', () => {
  it('credits the first approved payment of a period and moves paid through to the end of that month', () => {
    const plan = planLedger({
      payments: [payment('PAY-1', MARCH_5)],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: 'insert',
        period: '2026-03',
        surplus: false,
        credited: true,
      }),
    ]);
    expect(plan.effects.approvedCounted).toBe(true);
    expect(plan.effects.approvedCountedAt?.toISOString()).toBe(MARCH_5);
    expect(plan.effects.paidThrough?.toISOString()).toBe('2026-04-01T03:00:00.000Z');
    expect(plan.effects.surplusPaymentIds).toEqual([]);
  });

  it('records a second approved payment for March as a surplus: flagged, and paid through does not move twice', () => {
    const plan = planLedger({
      payments: [payment('PAY-1', MARCH_5), payment('PAY-2', MARCH_20)],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(
      plan.operations.map((operation) => operation.type === 'insert' && operation.surplus),
    ).toEqual([false, true]);
    expect(plan.effects.surplusPaymentIds).toEqual(['PAY-2']);
    expect(plan.effects.paidThrough?.toISOString()).toBe('2026-04-01T03:00:00.000Z');
  });

  it('flags a payment that arrives after March was already recorded as paid', () => {
    const plan = planLedger({
      payments: [payment('PAY-1', MARCH_5), payment('PAY-2', MARCH_20)],
      recorded: recordedOf({ providerPaymentId: 'PAY-1' }),
      lastPaidPeriod: '2026-03',
      paidThrough: new Date('2026-04-01T03:00:00.000Z'),
    });

    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({ type: 'insert', surplus: true });
    expect(plan.effects.paidThrough).toBeNull();
    expect(plan.effects.approvedCounted).toBe(false);
  });

  it('credits the next month and moves paid through again', () => {
    const plan = planLedger({
      payments: [payment('PAY-1', MARCH_5), payment('PAY-3', APRIL_5)],
      recorded: recordedOf({ providerPaymentId: 'PAY-1' }),
      lastPaidPeriod: '2026-03',
      paidThrough: new Date('2026-04-01T03:00:00.000Z'),
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({ type: 'insert', period: '2026-04', surplus: false }),
    ]);
    expect(plan.effects.paidThrough?.toISOString()).toBe('2026-05-01T03:00:00.000Z');
  });

  it('a payment seen twice is one: nothing is written for what is already recorded', () => {
    const plan = planLedger({
      payments: [payment('PAY-1', MARCH_5)],
      recorded: recordedOf({ providerPaymentId: 'PAY-1' }),
      lastPaidPeriod: '2026-03',
      paidThrough: new Date('2026-04-01T03:00:00.000Z'),
    });

    expect(plan.operations).toEqual([]);
    expect(plan.effects).toEqual({
      approvedCounted: false,
      approvedCountedAt: null,
      rejectedChargeAt: null,
      surplusPaymentIds: [],
      flagged: [],
      skipped: [],
      paidThrough: null,
    });
  });

  it('works the payments in the order the provider made them, whatever order they are listed in', () => {
    const forward = planLedger({
      payments: [payment('PAY-1', MARCH_5), payment('PAY-2', MARCH_20)],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });
    const backward = planLedger({
      payments: [payment('PAY-2', MARCH_20), payment('PAY-1', MARCH_5)],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(backward).toEqual(forward);
  });

  it('property: however many approvals a month has, it is credited once and the rest are surplus', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 28 }), { minLength: 1, maxLength: 8 }),
        (days) => {
          const payments = days.map((day, index) =>
            payment(
              `PAY-${String(index).padStart(2, '0')}`,
              `2026-03-${String(day).padStart(2, '0')}T15:00:00.000Z`,
            ),
          );

          const plan = planLedger({
            payments,
            recorded: none,
            lastPaidPeriod: null,
            paidThrough: null,
          });

          const credited = plan.operations.filter((op) => op.type === 'insert' && !op.surplus);
          expect(credited).toHaveLength(1);
          expect(plan.effects.surplusPaymentIds).toHaveLength(days.length - 1);
        },
      ),
    );
  });
});

describe('the ledger follows what the provider says now, never an older state', () => {
  it('ignores an older "pending" read after an "approved" one: nothing changes', () => {
    const plan = planLedger({
      payments: [payment('PAY-1', MARCH_5, { status: 'pending', approvedAt: undefined })],
      recorded: recordedOf({ providerPaymentId: 'PAY-1', status: 'approved' }),
      lastPaidPeriod: '2026-03',
      paidThrough: new Date('2026-04-01T03:00:00.000Z'),
    });

    expect(plan.operations).toEqual([]);
    expect(plan.effects.approvedCounted).toBe(false);
  });

  it('credits a payment that was pending and is now approved, once', () => {
    const plan = planLedger({
      payments: [payment('PAY-1', MARCH_5)],
      recorded: recordedOf({
        providerPaymentId: 'PAY-1',
        status: 'pending',
        period: null,
        credited: false,
      }),
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({ type: 'update', credit: { period: '2026-03', surplus: false } }),
    ]);
    expect(plan.effects.paidThrough?.toISOString()).toBe('2026-04-01T03:00:00.000Z');
  });

  it('records a refund as a step forward, and a larger refunded amount of the same status', () => {
    const refunded = payment('PAY-1', MARCH_5, {
      status: 'partially_refunded',
      refundedCents: 300_000,
    });
    const first = planLedger({
      payments: [refunded],
      recorded: recordedOf({ providerPaymentId: 'PAY-1' }),
      lastPaidPeriod: '2026-03',
      paidThrough: null,
    });
    const more = planLedger({
      payments: [{ ...refunded, refundedCents: 500_000 }],
      recorded: recordedOf({
        providerPaymentId: 'PAY-1',
        status: 'partially_refunded',
        refundedCents: 300_000,
      }),
      lastPaidPeriod: '2026-03',
      paidThrough: null,
    });

    expect(first.operations).toEqual([expect.objectContaining({ type: 'update', credit: null })]);
    expect(more.operations).toEqual([expect.objectContaining({ type: 'update', credit: null })]);
    expect(movesForward('approved', 'refunded')).toBe(true);
    expect(movesForward('refunded', 'approved')).toBe(false);
    expect(movesForward('approved', 'approved')).toBe(false);
  });

  it('notes a rejected charge, with the instant of the newest one, and not a rejected link', () => {
    const rejected = payment('PAY-1', MARCH_5, { status: 'rejected', approvedAt: undefined });
    const later = payment('PAY-2', MARCH_20, { status: 'rejected', approvedAt: undefined });
    const link = payment('PAY-3', APRIL_5, {
      status: 'rejected',
      approvedAt: undefined,
      preapprovalId: undefined,
      linkId: 'LNK-1',
      externalReference: 'due:abc:1',
    });

    const plan = planLedger({
      payments: [rejected, later, link],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(plan.effects.rejectedChargeAt?.toISOString()).toBe(MARCH_20);
    expect(plan.effects.approvedCounted).toBe(false);
  });

  it('notes a charge that was pending and the provider now says it was rejected', () => {
    const plan = planLedger({
      payments: [payment('PAY-1', MARCH_5, { status: 'rejected', approvedAt: undefined })],
      recorded: recordedOf({
        providerPaymentId: 'PAY-1',
        status: 'pending',
        period: null,
        credited: false,
      }),
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(plan.effects.rejectedChargeAt?.toISOString()).toBe(MARCH_5);
  });
});

describe('what a payment is for is read from the reference the server gave it', () => {
  it('tells the charge of a preapproval from the links for an overdue period and for a statement', () => {
    expect(purposeOf({ externalReference: 'sub:abc:1' })).toBe('charge');
    expect(purposeOf({ externalReference: 'due:abc:1', linkId: 'LNK-1' })).toBe('overdue');
    expect(purposeOf({ externalReference: 'stmt:abc:1', linkId: 'LNK-2' })).toBe('statement');
  });

  it('credits no period for the link of a statement', () => {
    const plan = planLedger({
      payments: [
        payment('PAY-1', MARCH_5, {
          preapprovalId: undefined,
          linkId: 'LNK-2',
          externalReference: 'stmt:abc:1',
        }),
      ],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: 'insert',
        purpose: 'statement',
        period: null,
        surplus: false,
      }),
    ]);
    expect(plan.effects.paidThrough).toBeNull();
  });
});

describe('the ledger credits only what is ours (JD-S6 R1, A-W10)', () => {
  const plan = (
    payments: PaymentDescription[],
    recorded = none,
    lastPaidPeriod: string | null = null,
  ) => planLedger({ payments, recorded, lastPaidPeriod, paidThrough: null });

  it('credits a charge of the preapproval the subscription holds', () => {
    const result = plan([payment('PAY-1', MARCH_5)]);

    expect(result.effects.approvedCounted).toBe(true);
    expect(result.effects.flagged).toEqual([]);
  });

  it('flags a charge of a preapproval that was superseded as a surplus and credits nothing', () => {
    const result = plan([payment('PAY-1', MARCH_5, { preapprovalId: 'PRE-0' })]);

    expect(result.operations).toEqual([
      expect.objectContaining({ type: 'insert', surplus: true, credited: true, period: null }),
    ]);
    expect(result.effects.flagged).toEqual([
      { paymentId: 'PAY-1', reason: 'superseded_preapproval' },
    ]);
    expect(result.effects.approvedCounted).toBe(false);
    expect(result.effects.paidThrough).toBeNull();
  });

  it('flags a charge of a preapproval nobody made for this subscription, and credits nothing', () => {
    const result = plan([payment('PAY-1', MARCH_5, { preapprovalId: 'PRE-STRANGER' })]);

    expect(result.effects.flagged).toEqual([{ paymentId: 'PAY-1', reason: 'foreign_preapproval' }]);
    expect(result.effects.approvedCounted).toBe(false);
  });

  it('flags a payment that carries no preapproval and no link', () => {
    const result = plan([payment('PAY-1', MARCH_5, { preapprovalId: undefined })]);

    expect(result.effects.flagged).toEqual([{ paymentId: 'PAY-1', reason: 'foreign_preapproval' }]);
  });

  it('credits the payment of a link the platform made, and flags one for another amount or another link', () => {
    const link = (id: string, overrides: Partial<PaymentDescription>) =>
      payment(id, MARCH_5, {
        preapprovalId: undefined,
        linkId: 'LNK-1',
        externalReference: 'due:abc:1',
        ...overrides,
      });

    expect(plan([link('PAY-1', {})]).effects.approvedCounted).toBe(true);
    expect(plan([link('PAY-2', { amountCents: 1 })]).effects.flagged).toEqual([
      { paymentId: 'PAY-2', reason: 'foreign_link' },
    ]);
    expect(plan([link('PAY-3', { linkId: 'LNK-OTHER' })]).effects.flagged).toEqual([
      { paymentId: 'PAY-3', reason: 'foreign_link' },
    ]);
    expect(plan([link('PAY-4', { externalReference: 'due:zzz:9' })]).effects.flagged).toEqual([
      { paymentId: 'PAY-4', reason: 'foreign_link' },
    ]);
  });

  it('flags a payment that is not in pesos, whatever the type says', () => {
    const result = plan([payment('PAY-1', MARCH_5, { currency: 'USD' as 'ARS' })]);

    expect(result.effects.flagged).toEqual([{ paymentId: 'PAY-1', reason: 'foreign_currency' }]);
    expect(result.effects.approvedCounted).toBe(false);
  });

  it('skips a payment with no amount instead of wedging the pass: nothing is recorded, the operator is told', () => {
    const result = plan([
      payment('PAY-0', MARCH_5, { amountCents: 0 }),
      payment('PAY-1', MARCH_20),
    ]);

    expect(result.effects.skipped).toEqual([{ paymentId: 'PAY-0', reason: 'no_amount' }]);
    expect(result.operations).toHaveLength(1);
    expect(result.effects.approvedCounted).toBe(true);
  });

  it('does not record what never became money from a door that is not ours', () => {
    const result = plan([
      payment('PAY-1', MARCH_5, { preapprovalId: 'PRE-STRANGER', status: 'pending' }),
      payment('PAY-2', MARCH_5, { preapprovalId: 'PRE-0', status: 'rejected' }),
    ]);

    expect(result.operations).toEqual([]);
    expect(result.effects.rejectedChargeAt).toBeNull();
  });
});

describe('a payment first seen as given back credits nothing (JD-S6 R1, B-T2)', () => {
  it.each(['refunded', 'charged_back'] as const)(
    'records a payment first seen as %s without crediting its period or moving paid through',
    (status) => {
      const result = planLedger({
        payments: [payment('PAY-1', MARCH_5, { status, refundedCents: 3_600_000 })],
        recorded: none,
        lastPaidPeriod: null,
        paidThrough: null,
      });

      expect(result.operations).toEqual([
        expect.objectContaining({ type: 'insert', period: null, surplus: false, credited: true }),
      ]);
      expect(result.effects.approvedCounted).toBe(false);
      expect(result.effects.paidThrough).toBeNull();
    },
  );

  it('does not credit a payment that was pending and is now already refunded', () => {
    const result = planLedger({
      payments: [payment('PAY-1', MARCH_5, { status: 'refunded', refundedCents: 3_600_000 })],
      recorded: recordedOf({
        providerPaymentId: 'PAY-1',
        status: 'pending',
        period: null,
        credited: false,
      }),
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(result.operations).toEqual([expect.objectContaining({ type: 'update', credit: null })]);
    expect(result.effects.paidThrough).toBeNull();
  });

  it('still credits a payment that is approved and partially refunded', () => {
    const result = planLedger({
      payments: [
        payment('PAY-1', MARCH_5, { status: 'partially_refunded', refundedCents: 100_000 }),
      ],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(result.effects.approvedCounted).toBe(true);
  });
});

describe('a rejected charge is history when the month is already paid (JD-S6 R1, B-T2)', () => {
  const rejected = (id: string, at: string) =>
    payment(id, at, { status: 'rejected', approvedAt: undefined });

  it('ignores a rejected charge of a month that a payment recorded in an earlier pass covers', () => {
    // March was paid in an earlier pass; this pass sees, for the first time, a March charge that failed.
    const result = planLedger({
      payments: [rejected('PAY-2', MARCH_5)],
      recorded: recordedOf({ providerPaymentId: 'PAY-1', period: '2026-03' }),
      lastPaidPeriod: '2026-03',
      paidThrough: new Date('2026-04-01T03:00:00.000Z'),
    });

    expect(result.effects.rejectedChargeAt).toBeNull();
  });

  it('still counts a rejected charge of a month nobody paid', () => {
    const result = planLedger({
      payments: [rejected('PAY-2', APRIL_5)],
      recorded: recordedOf({ providerPaymentId: 'PAY-1', period: '2026-03' }),
      lastPaidPeriod: '2026-03',
      paidThrough: new Date('2026-04-01T03:00:00.000Z'),
    });

    expect(result.effects.rejectedChargeAt?.toISOString()).toBe(APRIL_5);
  });
});

describe('a recurring charge for a month an overdue link paid is flagged as such (JD-S6 R1, S6-6)', () => {
  it('names the duplicate of an overdue link payment, so it can be given back', () => {
    const link = payment('PAY-LINK', MARCH_5, {
      preapprovalId: undefined,
      linkId: 'LNK-1',
      externalReference: 'due:abc:1',
    });
    const result = planLedger({
      payments: [link, payment('PAY-CHARGE', MARCH_20)],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(result.effects.flagged).toEqual([
      { paymentId: 'PAY-CHARGE', reason: 'duplicate_of_overdue_link' },
    ]);
  });

  it('names it too when the link was paid in an earlier pass', () => {
    const result = planLedger({
      payments: [payment('PAY-CHARGE', MARCH_20)],
      recorded: recordedOf({
        providerPaymentId: 'PAY-LINK',
        purpose: 'overdue',
        period: '2026-03',
      }),
      lastPaidPeriod: '2026-03',
      paidThrough: new Date('2026-04-01T03:00:00.000Z'),
    });

    expect(result.effects.flagged).toEqual([
      { paymentId: 'PAY-CHARGE', reason: 'duplicate_of_overdue_link' },
    ]);
  });

  it('keeps the plain reason for two recurring charges', () => {
    const result = planLedger({
      payments: [payment('PAY-1', MARCH_5), payment('PAY-2', MARCH_20)],
      recorded: none,
      lastPaidPeriod: null,
      paidThrough: null,
    });

    expect(result.effects.flagged).toEqual([{ paymentId: 'PAY-2', reason: 'duplicate_period' }]);
  });
});
