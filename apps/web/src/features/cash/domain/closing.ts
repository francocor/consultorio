import { money, type Money } from '@consultorio/contracts';

export interface ClosingDraft {
  /** Counted minus expected, in cents: negative when cash is missing. */
  difference: Money;
  needsReason: boolean;
  kind: 'exact' | 'short' | 'over';
  canSubmit: boolean;
}

/**
 * What closing the register shows while the cash is counted (billing-payments, "Closing with a
 * difference"). The server computes the expected cash again and decides; this only shows the
 * difference in time and asks for the reason.
 */
export function closingDraft(input: {
  expected: Money;
  counted: Money | null;
  reason?: string;
}): ClosingDraft {
  const difference = money((input.counted ?? input.expected) - input.expected);
  const needsReason = input.counted !== null && difference !== 0;
  return {
    difference,
    needsReason,
    kind: difference === 0 ? 'exact' : difference < 0 ? 'short' : 'over',
    canSubmit: input.counted !== null && (!needsReason || (input.reason ?? '').trim().length >= 3),
  };
}
