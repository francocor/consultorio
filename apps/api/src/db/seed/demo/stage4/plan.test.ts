import { describe, expect, it } from 'vitest';

import { SCENARIOS, SERVICE_CYCLE, planFor, scenarioFor, type Scenario } from './plan.js';

const sum = (steps: readonly { amountCents: number }[]) =>
  steps.reduce((total, step) => total + step.amountCents, 0);

describe('the payment plan of a seeded charge', () => {
  const patientCents = 1_234_500;

  it('pays a full charge in one payment of the method it is named for', () => {
    expect(planFor('cash_full', { patientCents, serial: 1 }).payments).toEqual([
      { method: 'cash', amountCents: patientCents },
    ]);
    const card = planFor('credit_full', { patientCents, serial: 7 }).payments;
    expect(card).toHaveLength(1);
    expect(card[0]).toMatchObject({ method: 'credit', amountCents: patientCents });
    expect(card[0]?.reference).toMatch(/^CUPON-\d{6}$/);
    expect(planFor('transfer_full', { patientCents, serial: 9 }).payments[0]?.reference).toBe(
      'TRF-000009',
    );
  });

  it('leaves a partial payment strictly between nothing and the whole', () => {
    const plan = planFor('cash_partial', { patientCents, serial: 3 });

    expect(plan.payments).toHaveLength(1);
    expect(sum(plan.payments)).toBeGreaterThan(0);
    expect(sum(plan.payments)).toBeLessThan(patientCents);
    // Whole cents, and a round number of pesos: a person counted it.
    expect(sum(plan.payments) % 100).toBe(0);
  });

  it('splits one card voucher into two payments that add up to the charge, the second saying why it repeats it', () => {
    const plan = planFor('split', { patientCents, serial: 4 });

    expect(plan.payments).toHaveLength(2);
    expect(sum(plan.payments)).toBe(patientCents);
    expect(plan.payments.map((step) => step.method)).toEqual(['debit', 'debit']);
    expect(plan.payments[0]?.reference).toBe('CUPON-000004');
    expect(plan.payments[1]?.reference).toBe(plan.payments[0]?.reference);
    expect(plan.payments[0]?.overrideReason).toBeUndefined();
    expect(plan.payments[1]?.overrideReason).toMatch(/\S/);
  });

  it('falls back to one payment when the charge is too small to split', () => {
    const plan = planFor('split', { patientCents: 100, serial: 4 });

    expect(plan.payments).toEqual([
      { method: 'debit', amountCents: 100, reference: 'CUPON-000004' },
    ]);
  });

  it('pays a whole peso above the charge and confirms the credit for an overpayment', () => {
    const plan = planFor('overpay', { patientCents, serial: 5 });

    expect(sum(plan.payments)).toBeGreaterThan(patientCents);
    expect(plan.payments[0]?.confirmCredit).toBe(true);
  });

  it('refunds less than the payment it came from, in cash', () => {
    const plan = planFor('refund', { patientCents, serial: 6 });

    expect(plan.payments).toHaveLength(1);
    expect(plan.refunds).toHaveLength(1);
    expect(plan.refunds[0]?.paymentIndex).toBe(0);
    expect(plan.refunds[0]?.amountCents).toBeGreaterThan(0);
    expect(plan.refunds[0]?.amountCents).toBeLessThan(sum(plan.payments));
  });

  it('leaves a pending charge unpaid, and a voided one with the reason', () => {
    expect(planFor('pending', { patientCents, serial: 1 })).toEqual({ payments: [], refunds: [] });
    const voided = planFor('void', { patientCents, serial: 1 });
    expect(voided.payments).toEqual([]);
    expect(voided.void).toMatch(/\S/);
  });

  it('never plans a payment above 10,000,000 pesos nor a reference a card number could be mistaken for', () => {
    for (const scenario of SCENARIOS) {
      const plan = planFor(scenario, { patientCents: 5_000_000, serial: 123_456 });
      for (const step of plan.payments) {
        expect(step.amountCents).toBeGreaterThan(0);
        expect(step.amountCents).toBeLessThanOrEqual(1_000_000_000);
        expect(step.reference ?? '').not.toMatch(/^(\d[ -]?){13,19}$/);
      }
    }
  });
});

describe('the scenario of a seeded charge', () => {
  it('goes through the list in order, so the same day gives the same story', () => {
    const first = Array.from({ length: SERVICE_CYCLE.length }, (_, index) =>
      scenarioFor(index, 'service'),
    );

    expect(new Set(first)).toEqual(
      new Set(SCENARIOS.filter((scenario) => scenario !== 'forgiven')),
    );
    expect(scenarioFor(SERVICE_CYCLE.length, 'service')).toBe(scenarioFor(0, 'service'));
  });

  it('treats a fee for a visit that did not happen apart: mostly owed, some paid, some forgiven', () => {
    const fees = Array.from({ length: 12 }, (_, index) => scenarioFor(index, 'late_fee'));
    const owed: Scenario[] = ['pending'];

    expect(fees.filter((scenario) => owed.includes(scenario)).length).toBeGreaterThanOrEqual(6);
    expect(fees).toContain('cash_full');
    expect(fees).toContain('forgiven');
    expect(fees).not.toContain('refund');
  });
});
