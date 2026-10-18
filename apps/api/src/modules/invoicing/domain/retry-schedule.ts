import type { InvoiceStatus } from '@consultorio/contracts';

/**
 * When a pending invoice is tried again, and when it counts as stuck (e-invoicing-afip, "AFIP
 * outage handling and no duplicate issuance"). Pure: no clock, no database.
 */

const MINUTE_MS = 60_000;

/** The first retry waits one minute. */
export const MIN_BACKOFF_MS = MINUTE_MS;
/** However long the outage lasts, the invoice is tried at least every six hours. */
export const MAX_BACKOFF_MS = 6 * 60 * MINUTE_MS;

/** The wait after the `attempts`-th attempt failed: one minute, doubling, up to six hours. */
export function backoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  // 2^9 minutes is already above the cap; clamping the exponent keeps the number small.
  const wait = MIN_BACKOFF_MS * 2 ** Math.min(exponent, 20);
  return Math.min(wait, MAX_BACKOFF_MS);
}

/** Whole minutes since the invoice was requested; never negative. */
export function ageInMinutes(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / MINUTE_MS));
}

/**
 * A pending invoice older than the organization's threshold is flagged as a prolonged outage. It is
 * computed from the age: the invoice never gets a state of its own for it.
 */
export function isOutageFlagged(
  status: InvoiceStatus,
  ageMinutes: number,
  thresholdHours: number,
): boolean {
  return status === 'pending' && ageMinutes >= thresholdHours * 60;
}
