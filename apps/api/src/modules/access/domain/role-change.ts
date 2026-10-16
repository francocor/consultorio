import { STAFF_ROLES, canGrantRoles, type Role } from '@consultorio/contracts';

export interface RoleChangeInput {
  actor: { membershipId: string; roles: readonly Role[] };
  target: { membershipId: string; roles: readonly Role[]; status: 'active' | 'deactivated' };
  newRoles: readonly Role[];
  /** Active owners other than the target. */
  otherActiveOwners: number;
}

export type RoleChangeVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: 'self' | 'above_ceiling' | 'last_owner' | 'invalid_roles' | 'inactive_target';
    };

function isStaffRole(role: Role): boolean {
  return STAFF_ROLES.some((staffRole) => staffRole === role);
}

/**
 * The rules for changing the roles of a member (authorization, "No self-assignment or silent
 * escalation of roles"). Pure, so the whole table can be tested without a database.
 *
 * - Nobody changes their own roles, up or down.
 * - The new roles must be inside the actor's ceiling, and so must the target's current roles: an
 *   admin cannot touch an owner, not even to demote them.
 * - An organization always keeps at least one active owner.
 */
export function evaluateRoleChange(input: RoleChangeInput): RoleChangeVerdict {
  const { actor, target, newRoles } = input;
  if (actor.membershipId === target.membershipId) return { ok: false, reason: 'self' };
  if (newRoles.length === 0 || !newRoles.every(isStaffRole)) {
    return { ok: false, reason: 'invalid_roles' };
  }
  if (!canGrantRoles(actor.roles, newRoles) || !canGrantRoles(actor.roles, target.roles)) {
    return { ok: false, reason: 'above_ceiling' };
  }
  if (target.status !== 'active') return { ok: false, reason: 'inactive_target' };
  if (
    target.roles.includes('owner') &&
    !newRoles.includes('owner') &&
    input.otherActiveOwners === 0
  ) {
    return { ok: false, reason: 'last_owner' };
  }
  return { ok: true };
}
