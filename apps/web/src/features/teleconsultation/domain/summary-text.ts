import type { VideoPendingReason } from '@consultorio/contracts';

/** The message that explains why a session has no link yet. */
export function pendingReasonKey(
  reason: VideoPendingReason | null,
): `teleconsultation:pending.${VideoPendingReason}` {
  return `teleconsultation:pending.${reason ?? 'creating'}`;
}
