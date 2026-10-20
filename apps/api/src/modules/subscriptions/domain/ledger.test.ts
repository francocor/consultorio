import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PaymentDescription } from '../application/ports.js';

import { movesForward, planLedger, purposeOf, type RecordedPayment } from './ledger.js';

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
