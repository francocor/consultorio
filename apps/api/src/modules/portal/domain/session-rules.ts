/**
 * A portal session ends after 30 minutes without use and after 12 hours whatever the use (design
 * ADR-008, spec "Patient authentication"). A patient is not a worker with a shift, so the staff
 * limits (7 days) do not apply: a phone left on a table must stop being a way into a health file.
 */
export const PORTAL_SESSION_IDLE_MS = 30 * 60_000;
export const PORTAL_SESSION_ABSOLUTE_MS = 12 * 3_600_000;

export type PortalSessionVerdict = 'active' | 'revoked' | 'idle_expired' | 'absolute_expired';

/** Whether a session may still be used at `now`. Pure: the clock is a parameter. */
export function portalSessionVerdict(
  state: { revokedAt: Date | null; lastSeenAt: Date; expiresAt: Date },
  now: Date,
): PortalSessionVerdict {
  if (state.revokedAt !== null) return 'revoked';
  if (now.getTime() >= state.expiresAt.getTime()) return 'absolute_expired';
  if (now.getTime() - state.lastSeenAt.getTime() >= PORTAL_SESSION_IDLE_MS) return 'idle_expired';
  return 'active';
}
