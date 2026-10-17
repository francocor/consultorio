import { effectivePermissions } from '@consultorio/contracts';

import type { Actor } from './actor.js';

/**
 * Whose calendar a staff member may work in (scheduling, "Calendar views" and "Scheduling
 * authorization"; authorization, "Grantable non-clinical permissions").
 *
 * - Owner, admin and reception run every calendar of the locations they work at (the location
 *   scope is checked separately).
 * - A professional works in their own calendar. They reach a colleague's only when an owner or
 *   admin delegated it: the grant `scheduling.delegated_calendar` carries the professionals it
 *   covers, and the scope counts only while the grant is live. A revoked grant opens nothing.
 * - A professional without a valid profile (the gate) has no calendar at all.
 */
export function calendarAccess(actor: Actor, professionalId: string): boolean {
  if (actor.kind !== 'staff') return false;
  if (actor.roles.some((role) => role === 'owner' || role === 'admin' || role === 'reception')) {
    return true;
  }
  if (!actor.roles.includes('professional')) return false;
  if (actor.professionalId !== null && actor.professionalId === professionalId) return true;
  const delegated = effectivePermissions(actor.roles, actor.grants).includes(
    'scheduling.delegated_calendar',
  );
  return delegated && (actor.delegatedProfessionalIds ?? []).includes(professionalId);
}
