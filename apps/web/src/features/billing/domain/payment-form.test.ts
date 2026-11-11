import { money, type Money } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { paymentDraft } from './payment-form.js';

const cents = (value: number): Money => money(value);

describe('what the payment form knows about the amount typed', () => {
  it('starts at what is owed', () => {
    const draft = paymentDraft({
      outstanding: cents(600_000),
      amount: cents(600_000),
      method: 'cash',
    });

    expect(draft).toMatchObject({ excess: 0, needsCreditConfirmation: false, canSubmit: true });
  });

  it('accepts a part of what is owed and shows what is left', () => {
    const draft = paymentDraft({
      outstanding: cents(1_000_000),
      amount: cents(400_000),
      method: 'debit',
    });

    expect(draft).toMatchObject({ remaining: 600_000, excess: 0, canSubmit: true });
  });

  it('asks to confirm a credit balance for what is above what is owed, and says how much', () => {
    const draft = paymentDraft({
      outstanding: cents(300_000),
      amount: cents(500_000),
      method: 'cash',
    });

    expect(draft).toMatchObject({ excess: 200_000, needsCreditConfirmation: true, remaining: 0 });
  });

  it('treats any payment on a charge that owes nothing as a credit', () => {
    const draft = paymentDraft({ outstanding: cents(0), amount: cents(1_000), method: 'cash' });

    expect(draft).toMatchObject({ excess: 1_000, needsCreditConfirmation: true });
  });

  it('cannot be submitted without an amount, or with a zero or a negative one', () => {
    expect(paymentDraft({ outstanding: cents(100), amount: null, method: 'cash' }).canSubmit).toBe(
      false,
    );
    expect(
      paymentDraft({ outstanding: cents(100), amount: cents(0), method: 'cash' }).canSubmit,
    ).toBe(false);
    expect(
      paymentDraft({ outstanding: cents(100), amount: cents(-5), method: 'cash' }).canSubmit,
    ).toBe(false);
  });

  it('asks for a voucher number only for the methods that have one', () => {
    expect(
      paymentDraft({ outstanding: cents(100), amount: cents(100), method: 'cash' }).asksReference,
    ).toBe(false);
    for (const method of ['debit', 'credit', 'transfer', 'wallet', 'payment_link'] as const) {
      expect(
        paymentDraft({ outstanding: cents(100), amount: cents(100), method }).asksReference,
        method,
      ).toBe(true);
    }
  });
});
