import type { Role } from '@consultorio/contracts';

/** Roles that exist inside an organization's staff. `patient` is never granted by an invitation. */
const STAFF_ROLES: readonly Role[] = ['owner', 'admin', 'professional', 'reception'];

const CEILING: Partial<Record<Role, readonly Role[]>> = {
  owner: ['owner', 'admin', 'professional', 'reception'],
  // An admin cannot create an owner: that would be a way to escalate above themselves.
  admin: ['admin', 'professional', 'reception'],
};

/** The roles a person holding `inviterRoles` may hand out in an invitation. */
export function rolesInviterMayGrant(inviterRoles: readonly Role[]): Role[] {
  const allowed = new Set<Role>();
  for (const role of inviterRoles) {
    for (const granted of CEILING[role] ?? []) allowed.add(granted);
  }
  return STAFF_ROLES.filter((role) => allowed.has(role));
}

/** True when every role in `roles` is inside the inviter's ceiling, and there is at least one. */
export function canGrantRoles(inviterRoles: readonly Role[], roles: readonly Role[]): boolean {
  if (roles.length === 0) return false;
  const allowed = rolesInviterMayGrant(inviterRoles);
  return roles.every((role) => allowed.includes(role));
}
