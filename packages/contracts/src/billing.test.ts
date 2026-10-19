import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  BILLING_AUDIT_ACTIONS,
  BILLING_ERRORS,
  BillingSettings,
  CHARGE_LINE_PORTIONS,
  CHARGE_STATUSES,
  CreatePayerPriceRequest,
  CreatePriceRequest,
  CreateTenantPayerRequest,
  DEFAULT_BILLING_SETTINGS,
  EXPORT_FORMATS,
  PAYMENT_METHODS,
  PriceQuoteQuery,
  UpdatePriceRequest,
} from './billing.js';
import { ERROR_CATALOG } from './errors.js';

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

  it('keeps every error code of billing in the shared catalog, with its status and message key', () => {
    for (const [code, entry] of Object.entries(BILLING_ERRORS)) {
      expect(entry.i18nKey, code).toBe(`errors.${code}`);
      expect(ERROR_CATALOG[code as keyof typeof ERROR_CATALOG], code).toEqual(entry);
    }
    expect(Object.keys(BILLING_ERRORS)).toContain('billing_price_duplicate');
  });
});

const TYPE_ID = '0190a000-0000-7000-8000-0000000000c1';
const PROFESSIONAL_ID = '0190a000-0000-7000-8000-0000000000d1';
const LOCATION_ID = '0190a000-0000-7000-8000-0000000000e1';

describe('the price list requests', () => {
  const valid = {
    appointmentTypeId: TYPE_ID,
    amountCents: 2_000_050,
    effectiveFrom: '2031-05-12',
  };

  it('takes an amount in whole cents, from a day, for a type and optionally a narrower scope', () => {
    expect(CreatePriceRequest.parse(valid)).toEqual(valid);
    expect(
      CreatePriceRequest.parse({
        ...valid,
        professionalId: PROFESSIONAL_ID,
        locationId: LOCATION_ID,
        specialty: ' pediatría ',
      }),
    ).toMatchObject({
      professionalId: PROFESSIONAL_ID,
      locationId: LOCATION_ID,
      specialty: 'pediatría',
    });
  });

  it('refuses a float, a zero, a negative, a huge amount and a date that is not a day', () => {
    for (const amountCents of [1234.5, 0, -100, 1e12, '2000']) {
      expect(
        CreatePriceRequest.safeParse({ ...valid, amountCents }).success,
        String(amountCents),
      ).toBe(false);
    }
    expect(CreatePriceRequest.safeParse({ ...valid, effectiveFrom: '12/05/2031' }).success).toBe(
      false,
    );
    expect(CreatePriceRequest.safeParse({ ...valid, tenantId: TYPE_ID }).success).toBe(false);
  });

  it('changes the amount or the active flag of a price, and nothing else', () => {
    expect(UpdatePriceRequest.parse({ amountCents: 2_500_000 })).toEqual({
      amountCents: 2_500_000,
    });
    expect(UpdatePriceRequest.parse({ active: false })).toEqual({ active: false });
    expect(UpdatePriceRequest.safeParse({}).success).toBe(false);
    expect(UpdatePriceRequest.safeParse({ effectiveFrom: '2031-06-01' }).success).toBe(false);
  });
});

describe('the payer requests', () => {
  it('copies a payer of the catalog or names a custom one, exactly one of the two', () => {
    expect(CreateTenantPayerRequest.parse({ payerId: TYPE_ID })).toEqual({ payerId: TYPE_ID });
    expect(CreateTenantPayerRequest.parse({ customName: '  Mutual del barrio ' })).toEqual({
      customName: 'Mutual del barrio',
    });
    expect(CreateTenantPayerRequest.safeParse({}).success).toBe(false);
    expect(
      CreateTenantPayerRequest.safeParse({ payerId: TYPE_ID, customName: 'Ambos' }).success,
    ).toBe(false);
  });

  it('keeps the covered amount, the copago and the plus apart, never negative', () => {
    const valid = {
      tenantPayerId: TYPE_ID,
      appointmentTypeId: PROFESSIONAL_ID,
      planName: '210',
      payerAmountCents: 1_500_000,
      copagoCents: 300_000,
      plusCents: 0,
      effectiveFrom: '2031-05-12',
    };

    expect(CreatePayerPriceRequest.parse(valid)).toEqual(valid);
    expect(CreatePayerPriceRequest.safeParse({ ...valid, copagoCents: -1 }).success).toBe(false);
    expect(
      CreatePayerPriceRequest.safeParse({
        ...valid,
        payerAmountCents: 0,
        copagoCents: 0,
        plusCents: 0,
      }).success,
    ).toBe(false);
    expect(CreatePayerPriceRequest.safeParse({ ...valid, plusCents: 10.5 }).success).toBe(false);
  });
});

describe('the price quote', () => {
  it('asks for an appointment, optionally for a payer chosen by hand or the private price', () => {
    expect(PriceQuoteQuery.parse({ appointmentId: TYPE_ID })).toEqual({ appointmentId: TYPE_ID });
    expect(PriceQuoteQuery.parse({ appointmentId: TYPE_ID, payer: 'private' })).toMatchObject({
      payer: 'private',
    });
    expect(
      PriceQuoteQuery.parse({ appointmentId: TYPE_ID, payer: PROFESSIONAL_ID, planName: '210' }),
    ).toMatchObject({ payer: PROFESSIONAL_ID, planName: '210' });
    expect(PriceQuoteQuery.safeParse({ appointmentId: TYPE_ID, payer: 'osde' }).success).toBe(
      false,
    );
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
