/**
 * How a failed delivery is handled (spec "Delivery tracking, retries and fallback"). Pure rules:
 * the bound on attempts, the growing wait, the end of the road at the start of the appointment,
 * and what an email error means.
 */

/** Attempts per message and channel, the first one included. */
export const MAX_ATTEMPTS = 3;

/** The wait after the first, the second ... failed attempt. It grows, and it is not configurable. */
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;

/**
 * When to try again after attempt `attemptNo` (1-based) failed for a transient reason. Null means
 * "do not": the attempts are used up, or the next try would land at or after the start of the
 * appointment, when a reminder no longer has a purpose.
 */
export function nextRetryAt(now: Date, attemptNo: number, startsAt: Date | null): Date | null {
  if (attemptNo >= MAX_ATTEMPTS) return null;
  const delay = RETRY_DELAYS_MS[attemptNo - 1];
  if (delay === undefined) return null;
  const retryAt = new Date(now.getTime() + delay);
  return startsAt !== null && retryAt.getTime() >= startsAt.getTime() ? null : retryAt;
}

export type FailureKind = 'transient' | 'permanent';

/** SMTP answers that say the mailbox cannot receive mail: it does not exist or is not accepted. */
const MAILBOX_REFUSALS: ReadonlySet<number> = new Set([550, 551, 553]);

function responseCodeOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { responseCode?: unknown }).responseCode;
  return typeof code === 'number' ? code : undefined;
}

/**
 * What an email error means. Only a refusal that says the mailbox is bad is permanent; everything
 * else, including what we do not recognize, is transient, so a hiccup never marks a good address
 * as unreachable. A message that keeps failing ends as `retries_exhausted` anyway.
 */
export function classifyEmailFailure(error: unknown): FailureKind {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = responseCodeOf(cause) ?? responseCodeOf(error);
  return code !== undefined && MAILBOX_REFUSALS.has(code) ? 'permanent' : 'transient';
}
