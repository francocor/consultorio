import { GRANTABLE, isClinicalPermission, type GrantablePermission } from '@consultorio/contracts';

export interface GrantInput {
  actorMembershipId: string;
  targetMembershipId: string;
  permission: string;
}

export type GrantVerdict =
  { ok: true } | { ok: false; reason: 'self' | 'clinical' | 'not_grantable' };

/** Narrows a string to the fixed set of permissions an owner or admin can hand out. */
export function isGrantable(permission: string): permission is GrantablePermission {
  return GRANTABLE.some((grantable) => grantable === permission);
}

/**
 * Whether a grant may be made (authorization, "Grantable non-clinical permissions"). A clinical
 * permission is refused first and by name, so the audit entry says what was attempted; anything
 * else outside the fixed set is refused the same way. Nobody grants themselves anything.
 */
export function evaluateGrant(input: GrantInput): GrantVerdict {
  if (input.actorMembershipId === input.targetMembershipId) return { ok: false, reason: 'self' };
  if (isClinicalPermission(input.permission.toLowerCase())) {
    return { ok: false, reason: 'clinical' };
  }
  if (!isGrantable(input.permission)) return { ok: false, reason: 'not_grantable' };
  return { ok: true };
}

/** Only a delegated calendar has a scope (the professionals it reaches), and it must have one. */
export function scopeAllowedFor(permission: GrantablePermission, scope: unknown): boolean {
  return permission === 'scheduling.delegated_calendar' ? scope !== undefined : scope === undefined;
}
