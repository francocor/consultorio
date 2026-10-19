import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { chargeStatusOf, invoicingPositionOf, summarizeCharge } from './charge-status.js';

describe('the state of a charge follows what the patient paid, net of refunds', () => {
  it('is pending until something is paid', () => {
    expect(chargeStatusOf({ voided: false, patientCents: 1_000_000, paidNetCents: 0 })).toBe(
      'pending',
    );
  });

  it('is partially paid between nothing and the whole patient portion', () => {
    expect(chargeStatusOf({ voided: false, patientCents: 1_000_000, paidNetCents: 400_000 })).toBe(
      'partially_paid',
    );
    expect(chargeStatusOf({ voided: false, patientCents: 1_000_000, paidNetCents: 999_999 })).toBe(
      'partially_paid',
    );
  });

  it('is paid once the patient portion is covered, and a confirmed credit does not change it', () => {
    expect(
      chargeStatusOf({ voided: false, patientCents: 1_000_000, paidNetCents: 1_000_000 }),
    ).toBe('paid');
    expect(
      chargeStatusOf({ voided: false, patientCents: 1_000_000, paidNetCents: 1_200_000 }),
    ).toBe('paid');
  });

  it('goes back when a refund takes the net below the portion', () => {
    expect(chargeStatusOf({ voided: false, patientCents: 1_000_000, paidNetCents: 600_000 })).toBe(
      'partially_paid',
    );
    expect(chargeStatusOf({ voided: false, patientCents: 1_000_000, paidNetCents: 0 })).toBe(
      'pending',
    );
  });

  it('is settled when the payer covers everything and the patient owes nothing', () => {
    expect(chargeStatusOf({ voided: false, patientCents: 0, paidNetCents: 0 })).toBe('paid');
  });

  it('is voided whatever was paid', () => {
    expect(chargeStatusOf({ voided: true, patientCents: 1_000_000, paidNetCents: 0 })).toBe(
      'voided',
    );
    expect(chargeStatusOf({ voided: true, patientCents: 1_000_000, paidNetCents: 500_000 })).toBe(
      'voided',
    );
  });
});

const line = (
  portion: 'patient' | 'payer',
  amountCents: number,
  invoicedCents = 0,
): { portion: 'patient' | 'payer'; amountCents: number; invoicedCents: number } => ({
  portion,
  amountCents,
  invoicedCents,
});

describe('the amounts of a charge', () => {
  it('splits the lines between the patient and the payer', () => {
    const summary = summarizeCharge(
      [line('payer', 1_500_000), line('patient', 300_000), line('patient', 500_000)],
      200_000,
    );

    expect(summary).toEqual({
      totalCents: 2_300_000,
      patientCents: 800_000,
      payerCents: 1_500_000,
      paidCents: 200_000,
      outstandingCents: 600_000,
      creditCents: 0,
      invoicedCents: 0,
    });
  });

  it('shows what was paid above the patient portion as a credit, and nothing outstanding', () => {
    const summary = summarizeCharge([line('patient', 300_000)], 500_000);

    expect(summary).toMatchObject({
      outstandingCents: 0,
      creditCents: 200_000,
      paidCents: 500_000,
    });
  });

  it('adds up what the lines have been invoiced for', () => {
    const summary = summarizeCharge(
      [line('patient', 300_000, 300_000), line('patient', 500_000, 100_000)],
      0,
    );

    expect(summary.invoicedCents).toBe(400_000);
  });

  it('keeps the patient and payer portions equal to the total, for any lines', () => {
    const amount = fc.integer({ min: 1, max: 10_000_000 });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('patient', 'payer'), amount), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.integer({ min: 0, max: 50_000_000 }),
        (rows, paid) => {
          const summary = summarizeCharge(
            rows.map(([portion, value]) => line(portion, value)),
            paid,
          );

          expect(summary.patientCents + summary.payerCents).toBe(summary.totalCents);
          expect(summary.outstandingCents).toBeGreaterThanOrEqual(0);
          expect(summary.creditCents).toBeGreaterThanOrEqual(0);
          expect(summary.paidCents - summary.creditCents + summary.outstandingCents).toBe(
            summary.patientCents,
          );
        },
      ),
    );
  });
});

describe('the invoicing position is derived from the lines', () => {
  it('is not invoiced, partly invoiced or invoiced', () => {
    expect(invoicingPositionOf([line('patient', 100, 0), line('patient', 50, 0)])).toBe(
      'not_invoiced',
    );
    expect(invoicingPositionOf([line('patient', 100, 100), line('patient', 50, 0)])).toBe(
      'partly_invoiced',
    );
    expect(invoicingPositionOf([line('patient', 100, 60), line('patient', 50, 0)])).toBe(
      'partly_invoiced',
    );
    expect(invoicingPositionOf([line('patient', 100, 100), line('payer', 50, 50)])).toBe(
      'invoiced',
    );
  });

  it('is not invoiced for a charge without lines', () => {
    expect(invoicingPositionOf([])).toBe('not_invoiced');
  });
});
