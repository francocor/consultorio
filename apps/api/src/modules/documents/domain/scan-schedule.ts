/** First wait after a scan could not be done, in seconds. */
const BASE_BACKOFF_SECONDS = 30;
/** The longest wait between two attempts. */
const MAX_BACKOFF_SECONDS = 15 * 60;

/** A document that has waited this long for its scan raises an alert (design section 7). */
export const OVERDUE_AFTER_MINUTES = 60;

/**
 * Seconds to wait before the next try, after `attempts` tries that found the scanner unavailable:
 * 30 s, then doubling, never more than 15 minutes. A document is released only by a real scan, so
 * the outage can last as long as it likes; this only keeps the retries from hammering a scanner
 * that is starting up.
 */
export function scanBackoffSeconds(attempts: number): number {
  const tries = Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
  // Past 6 tries the cap is reached anyway; the guard keeps the power from overflowing.
  const doubled = BASE_BACKOFF_SECONDS * 2 ** Math.min(tries - 1, 20);
  return Math.min(doubled, MAX_BACKOFF_SECONDS);
}

/** True when the upload was confirmed at least an hour before `now` and is still waiting. */
export function isOverdue(confirmedAt: Date, now: Date): boolean {
  return now.getTime() - confirmedAt.getTime() >= OVERDUE_AFTER_MINUTES * 60_000;
}
