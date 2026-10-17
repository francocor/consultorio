import type { Role } from '@consultorio/contracts';

/**
 * Which locations a staff member may operate on the schedule (authorization, "Membership in
 * locations"; scheduling, "Scheduling authorization and audit").
 *
 * - Owner and admin work at every location.
 * - A professional who is only a professional is held to calendars (their own and the delegated
 *   ones), not to places, so no location filter applies to them.
 * - Reception works at the locations it is assigned to. A reception user who is also a
 *   professional keeps that limit for every calendar but their own: the professional role does not
 *   widen what reception may do for somebody else's calendar.
 */
export type LocationScope =
  | { kind: 'all' }
  | {
      kind: 'assigned';
      /** The viewer's own professional calendar, which is not limited by location. */
      ownProfessionalId: string | null;
    };

export function locationScopeOf(actor: {
  roles: readonly Role[];
  professionalId: string | null;
}): LocationScope {
  const has = (role: Role) => actor.roles.includes(role);
  if (has('owner') || has('admin')) return { kind: 'all' };
  if (has('professional') && !has('reception')) return { kind: 'all' };
  return {
    kind: 'assigned',
    ownProfessionalId: has('professional') ? actor.professionalId : null,
  };
}

/** Whether work in this professional's calendar at this location is inside the scope. */
export function mayOperateAt(
  scope: LocationScope,
  assignedLocationIds: readonly string[],
  target: { locationId: string; professionalId: string },
): boolean {
  if (scope.kind === 'all') return true;
  if (scope.ownProfessionalId !== null && scope.ownProfessionalId === target.professionalId) {
    return true;
  }
  return assignedLocationIds.includes(target.locationId);
}
