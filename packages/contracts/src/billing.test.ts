import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  BILLING_AUDIT_ACTIONS,
  BILLING_ERRORS,
  BillingSettings,
  CHARGE_LINE_PORTIONS,
  CHARGE_STATUSES,
  DEFAULT_BILLING_SETTINGS,
  EXPORT_FORMATS,
  PAYMENT_METHODS,
} from './billing.js';

describe('billing catalogues', () => {
  it('has the charge statuses, line portions and payment methods of the spec', () => {
    expect([...CHARGE_STATUSES]).toEqual(['pending', 'partially_paid', 'paid', 'voided']);
    expect([...CHARGE_LINE_PORTIONS]).toEqual(['patient', 'payer']);
    expect([...PAYMENT_METHODS]).toEqual([
      'cash',
      'debit',
      'credit',
      'transfer',
      'wallet',
      'payment_link',
    ]);
  });

  it('has the three export formats that the exports and the reports share', () => {
    expect([...EXPORT_FORMATS]).toEqual(['csv', 'xlsx', 'pdf']);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(BILLING_AUDIT_ACTIONS).toEqual([
      'billing.price.changed',
      'billing.price.override',
      'charge.captured',
      'charge.voided',
      'charge.flagged',
      'payment.recorded',
      'payment.override',
      'payment.refunded',
      'cash.opened',
      'cash.closed',
      'cash.adjusted',
      'export.requested',
    ]);
    for (const action of BILLING_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('starts with no error codes of its own: the track adds them to its catalog', () => {
    expect(Object.keys(BILLING_ERRORS)).toEqual([]);
  });
});

describe('billing settings', () => {
  it('defaults to no late fee, and an amount of zero', () => {
    expect(BillingSettings.parse(DEFAULT_BILLING_SETTINGS)).toEqual({
      lateFeeEnabled: false,
      lateFeeAmount: 0,
    });
  });

  it('keeps the fee in whole cents, never negative, and refuses unknown keys', () => {
    const base = DEFAULT_BILLING_SETTINGS;

    expect(BillingSettings.safeParse({ ...base, lateFeeAmount: 500_000 }).success).toBe(true);
    expect(BillingSettings.safeParse({ ...base, lateFeeAmount: -1 }).success).toBe(false);
    expect(BillingSettings.safeParse({ ...base, lateFeeAmount: 12.5 }).success).toBe(false);
    expect(BillingSettings.safeParse({ ...base, currency: 'USD' }).success).toBe(false);
  });
});
