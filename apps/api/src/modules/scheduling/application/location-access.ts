import type { Actor } from '../../../platform/authz/actor.js';
import {
  locationScopeOf,
  mayOperateAt,
  type LocationScope,
} from '../../../platform/authz/location-scope.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { visibleLocationIds } from '../../access/index.js';

/**
 * Which locations a staff member operates on the schedule, resolved once per request in its
 * transaction (authorization, "Membership in locations"). It is the one place that turns the
 * location scope and the membership into answers, so the calendar, booking, the lifecycle and
 * availability cannot disagree.
 */
export interface LocationAccess {
  scope: LocationScope;
  /** The locations of the membership; meaningful when the scope is not every location. */
  assigned: readonly string[];
  /** Whether work in this professional's calendar at this location is inside the scope. */
  may(target: { locationId: string; professionalId: string }): boolean;
  /** The locations to look at in this professional's calendar: every one, or only these. */
  forProfessional(professionalId: string): 'all' | readonly string[];
}

export async function locationAccessOf(tx: Tx, actor: Actor): Promise<LocationAccess> {
  const scope = locationScopeOf(actor);
  const visible =
    scope.kind === 'all'
      ? 'all'
      : await visibleLocationIds(tx, { roles: actor.roles, membershipId: actor.membershipId });
  const assigned = visible === 'all' ? [] : visible;
  const effective: LocationScope = visible === 'all' ? { kind: 'all' } : scope;
  return {
    scope: effective,
    assigned,
    may: (target) => mayOperateAt(effective, assigned, target),
    forProfessional: (professionalId) =>
      effective.kind === 'all' || effective.ownProfessionalId === professionalId ? 'all' : assigned,
  };
}
