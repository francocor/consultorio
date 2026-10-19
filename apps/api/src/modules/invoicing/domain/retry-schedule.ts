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

/**
 * An invoice that waits for reconciliation is only ASKED about (a lookup never sends anything), so it
 * is tried again soon however long the outage lasts: the whole series behind it waits for it
 * (JD-S4 R3-1). The wait never goes over five minutes.
 */
export const MAX_AWAITING_BACKOFF_MS = 5 * MINUTE_MS;

export function awaitingBackoffMs(attempts: number): number {
  return Math.min(backoffMs(attempts), MAX_AWAITING_BACKOFF_MS);
}

/** After this many attempts, or this long, an unknown outcome is no longer something to wait out. */
export const STALL_ATTEMPTS = 6;
export const STALL_AFTER_MS = 2 * 60 * MINUTE_MS;

/**
 * Whether an invoice that waits for reconciliation has waited long enough to tell a person: it was
 * tried at least `STALL_ATTEMPTS` times, or it was requested at least two hours ago.
 */
export function isStalled(input: { attempts: number; createdAt: Date; now: Date }): boolean {
  return (
    input.attempts >= STALL_ATTEMPTS ||
    input.now.getTime() - input.createdAt.getTime() >= STALL_AFTER_MS
  );
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
