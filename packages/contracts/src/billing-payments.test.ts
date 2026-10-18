import { describe, expect, it } from 'vitest';

import {
  CashCloseRequest,
  CashOpenRequest,
  CashSessionListQuery,
  CorrectPaymentRequest,
  RecordPaymentRequest,
  RefundPaymentRequest,
} from './billing.js';

const KEY = '0190a000-0000-7000-8000-0000000000e9';
const PLACE = '0190a000-0000-7000-8000-0000000000e1';

describe('the payment requests', () => {
  const valid = { method: 'cash', amountCents: 400_000, idempotencyKey: KEY };

  it('takes a method, an amount in whole cents and a key the client made for this submission', () => {
    expect(RecordPaymentRequest.parse(valid)).toEqual(valid);
    expect(
      RecordPaymentRequest.parse({
        ...valid,
        method: 'transfer',
        externalRef: ' 004512 ',
        confirmCredit: true,
      }),
    ).toMatchObject({ method: 'transfer', externalRef: '004512', confirmCredit: true });
  });

  it('refuses a float, a zero, a negative, an unknown method and a missing key', () => {
    for (const amountCents of [10.5, 0, -1, 2e10]) {
      expect(
        RecordPaymentRequest.safeParse({ ...valid, amountCents }).success,
        String(amountCents),
      ).toBe(false);
    }
    expect(RecordPaymentRequest.safeParse({ ...valid, method: 'crypto' }).success).toBe(false);
    expect(RecordPaymentRequest.safeParse({ ...valid, idempotencyKey: undefined }).success).toBe(
      false,
    );
    expect(RecordPaymentRequest.safeParse({ ...valid, idempotencyKey: 'abc' }).success).toBe(false);
  });

  it('refuses a reference that is only a card number, and a date or an author sent by the client', () => {
    for (const externalRef of ['4111111111111111', '4111 1111 1111 1111', '5400-0000-0000-0004']) {
      expect(RecordPaymentRequest.safeParse({ ...valid, externalRef }).success, externalRef).toBe(
        false,
      );
    }
    expect(
      RecordPaymentRequest.safeParse({ ...valid, externalRef: 'TRF-20310512-0045' }).success,
    ).toBe(true);
    expect(
      RecordPaymentRequest.safeParse({ ...valid, paidAt: '2031-05-12T10:00:00Z' }).success,
    ).toBe(false);
    expect(RecordPaymentRequest.safeParse({ ...valid, recordedBy: KEY }).success).toBe(false);
    expect(
      RecordPaymentRequest.safeParse({ ...valid, cardNumber: '4111111111111111' }).success,
    ).toBe(false);
  });

  it('refunds an amount with a reason, and corrects with a new amount and a reason', () => {
    expect(
      RefundPaymentRequest.parse({
        amountCents: 100,
        reason: 'Devolución parcial',
        idempotencyKey: KEY,
      }),
    ).toMatchObject({
      amountCents: 100,
    });
    expect(RefundPaymentRequest.safeParse({ amountCents: 100, idempotencyKey: KEY }).success).toBe(
      false,
    );
    expect(
      RefundPaymentRequest.safeParse({ amountCents: 100, reason: 'ok', idempotencyKey: KEY })
        .success,
    ).toBe(false);
    expect(
      CorrectPaymentRequest.parse({
        amountCents: 350_000,
        reason: 'Importe mal tipeado',
        idempotencyKey: KEY,
      }),
    ).toMatchObject({ amountCents: 350_000 });
    expect(
      CorrectPaymentRequest.safeParse({
        amountCents: 0,
        reason: 'Importe mal tipeado',
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
  });
});

describe('the cash register requests', () => {
  it('opens with an opening amount that may be zero, and closes with the counted cash', () => {
    expect(CashOpenRequest.parse({ locationId: PLACE, openingCents: 0 })).toEqual({
      locationId: PLACE,
      openingCents: 0,
    });
    expect(CashOpenRequest.safeParse({ locationId: PLACE, openingCents: -1 }).success).toBe(false);
    expect(CashOpenRequest.safeParse({ locationId: PLACE, openingCents: 1.5 }).success).toBe(false);
    expect(
      CashCloseRequest.parse({ countedCents: 3_400_000, differenceReason: ' Falta un billete ' }),
    ).toEqual({
      countedCents: 3_400_000,
      differenceReason: 'Falta un billete',
    });
    expect(CashCloseRequest.safeParse({ countedCents: -5 }).success).toBe(false);
    expect(CashCloseRequest.safeParse({}).success).toBe(false);
  });

  it('lists registers by place, state and day', () => {
    expect(
      CashSessionListQuery.parse({ locationId: PLACE, status: 'open', from: '2031-05-01' }),
    ).toMatchObject({
      status: 'open',
    });
    expect(CashSessionListQuery.safeParse({ status: 'half' }).success).toBe(false);
  });
});
