import { describe, expect, it } from 'vitest';

import {
  AddChargeLineRequest,
  CaptureChargeRequest,
  CHARGE_LINE_KINDS,
  CHARGE_REVIEW_REASONS,
  ChargeListQuery,
  VoidChargeRequest,
} from './billing.js';

const APPOINTMENT_ID = '0190a000-0000-7000-8000-0000000000c1';

describe('the kinds of a charge line and the reasons to review a charge', () => {
  it('knows the lines the price makes, the late fee and the lines added by hand', () => {
    expect([...CHARGE_LINE_KINDS]).toEqual([
      'service',
      'payer_coverage',
      'copago',
      'plus',
      'late_fee',
      'manual',
    ]);
    expect([...CHARGE_REVIEW_REASONS]).toEqual(['no_show', 'cancelled']);
  });
});

describe('the charge requests', () => {
  it('captures a charge for an appointment, optionally for a payer or with an amount typed by a person', () => {
    expect(CaptureChargeRequest.parse({ appointmentId: APPOINTMENT_ID })).toEqual({
      appointmentId: APPOINTMENT_ID,
    });
    expect(
      CaptureChargeRequest.parse({
        appointmentId: APPOINTMENT_ID,
        payer: 'private',
        explicitAmountCents: 123_450,
      }),
    ).toMatchObject({ payer: 'private', explicitAmountCents: 123_450 });
    for (const explicitAmountCents of [0, -5, 10.5, 2e10]) {
      expect(
        CaptureChargeRequest.safeParse({ appointmentId: APPOINTMENT_ID, explicitAmountCents })
          .success,
        String(explicitAmountCents),
      ).toBe(false);
    }
  });

  it('adds a line with a description and an amount to the patient or to the payer', () => {
    expect(
      AddChargeLineRequest.parse({ description: ' Material descartable ', amountCents: 150_000 }),
    ).toEqual({ description: 'Material descartable', amountCents: 150_000 });
    expect(
      AddChargeLineRequest.parse({ description: 'Estudio', amountCents: 100, portion: 'payer' }),
    ).toMatchObject({ portion: 'payer' });
    expect(AddChargeLineRequest.safeParse({ description: '', amountCents: 100 }).success).toBe(
      false,
    );
    expect(AddChargeLineRequest.safeParse({ description: 'x', amountCents: 0 }).success).toBe(
      false,
    );
    expect(
      AddChargeLineRequest.safeParse({ description: 'x', amountCents: 5, portion: 'insurer' })
        .success,
    ).toBe(false);
  });

  it('voids with a reason that says something', () => {
    expect(VoidChargeRequest.parse({ reason: ' Cargado dos veces ' })).toEqual({
      reason: 'Cargado dos veces',
    });
    expect(VoidChargeRequest.safeParse({ reason: 'ok' }).success).toBe(false);
    expect(VoidChargeRequest.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
    expect(VoidChargeRequest.safeParse({}).success).toBe(false);
  });

  it('lists charges by status, person, place and the day of the service', () => {
    expect(
      ChargeListQuery.parse({
        status: 'pending',
        from: '2031-05-01',
        to: '2031-05-31',
        needsReview: 'true',
      }),
    ).toMatchObject({ status: 'pending', needsReview: true });
    expect(ChargeListQuery.safeParse({ needsReview: 'false' }).success).toBe(true);
    expect(ChargeListQuery.safeParse({ status: 'refunded' }).success).toBe(false);
    expect(ChargeListQuery.safeParse({ from: 'yesterday' }).success).toBe(false);
  });
});
