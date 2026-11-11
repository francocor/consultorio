import { money, type ChargeInvoicingPosition, type ChargeStatus } from '@consultorio/contracts';

/**
 * The state and the amounts of a charge, derived and never typed (billing-payments, "Charge
 * lifecycle and voiding"). Pure: the same lines and payments always give the same answer. Amounts
 * are whole cents; `money()` refuses anything that is not.
 */

export interface LineAmounts {
  /** `patient` or `payer` (the database refuses anything else). */
  portion: string;
  amountCents: number;
  invoicedCents: number;
}

/**
 * `paidNetCents` is what the patient paid minus what was refunded. The payer portion is a
 * receivable and never part of it. A charge whose patient portion is zero (the payer covers it all)
 * has nothing to collect, so it is settled.
 */
export function chargeStatusOf(input: {
  voided: boolean;
  patientCents: number;
  paidNetCents: number;
}): ChargeStatus {
  if (input.voided) return 'voided';
  if (input.paidNetCents >= input.patientCents) return 'paid';
  if (input.paidNetCents > 0) return 'partially_paid';
  return 'pending';
}

export interface ChargeSummary {
  totalCents: number;
  patientCents: number;
  payerCents: number;
  paidCents: number;
  outstandingCents: number;
  creditCents: number;
  invoicedCents: number;
}

export function summarizeCharge(
  lines: readonly LineAmounts[],
  paidNetCents: number,
): ChargeSummary {
  let patientCents = 0;
  let payerCents = 0;
  let invoicedCents = 0;
  for (const line of lines) {
    if (line.portion === 'patient') patientCents += money(line.amountCents);
    else payerCents += money(line.amountCents);
    invoicedCents += money(line.invoicedCents);
  }
  const paid = money(paidNetCents);
  return {
    totalCents: money(patientCents + payerCents),
    patientCents: money(patientCents),
    payerCents: money(payerCents),
    paidCents: paid,
    outstandingCents: money(Math.max(0, patientCents - paid)),
    creditCents: money(Math.max(0, paid - patientCents)),
    invoicedCents: money(invoicedCents),
  };
}

/** Not invoiced, partly invoiced or invoiced, from the lines. It is not one of the states. */
export function invoicingPositionOf(lines: readonly LineAmounts[]): ChargeInvoicingPosition {
  const invoiced = lines.reduce((sum, line) => sum + line.invoicedCents, 0);
  if (invoiced <= 0) return 'not_invoiced';
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return invoiced >= total ? 'invoiced' : 'partly_invoiced';
}
