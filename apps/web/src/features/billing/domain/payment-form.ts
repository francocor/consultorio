import { money, type Money, type PaymentMethod } from '@consultorio/contracts';

export interface PaymentDraft {
  /** What would still be owed after this payment (never below zero). */
  remaining: Money;
  /** What the amount exceeds what is owed by: it can only be kept as a confirmed credit balance. */
  excess: Money;
  needsCreditConfirmation: boolean;
  /** Cash has no voucher; a card, a transfer, a wallet and a payment link do. */
  asksReference: boolean;
  canSubmit: boolean;
}

/**
 * What the payment form shows and asks while a person types (billing-payments, "Payment recording",
 * "Overpayment"). The server decides again; this only tells the person in time. Whole cents only.
 */
export function paymentDraft(input: {
  outstanding: Money;
  amount: Money | null;
  method: PaymentMethod;
}): PaymentDraft {
  const amount = input.amount ?? 0;
  const excess = money(Math.max(0, amount - input.outstanding));
  return {
    remaining: money(Math.max(0, input.outstanding - amount)),
    excess,
    needsCreditConfirmation: excess > 0,
    asksReference: input.method !== 'cash',
    canSubmit: input.amount !== null && input.amount > 0,
  };
}
