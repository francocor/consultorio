import type { Role } from '@consultorio/contracts';

import type { Tx } from '../../../platform/db/tenant-context.js';
import { visibleLocationIds } from '../../access/index.js';

/**
 * Whose charges and payments a viewer may see (billing-payments, "Billing access control"):
 * owners and administrators see every one; reception sees the ones of the locations it is assigned
 * to; a professional sees the ones of their own appointments, and nothing of a colleague's
 * revenue. Decided on the server for every read and every write, so a screen that hides a
 * colleague's charge is only a courtesy.
 */
export type BillingScope =
  | { kind: 'all' }
  | {
      kind: 'limited';
      /** The locations reception works at; empty for a viewer who is not reception. */
      locationIds: readonly string[];
      /** The viewer's own professional profile, whose appointments they see; null without one. */
      professionalId: string | null;
    };

export interface ScopeViewer {
  roles: readonly Role[];
  membershipId: string;
  professionalId: string | null;
  ownProfessionalId?: string | null | undefined;
}

export async function billingScopeOf(tx: Tx, viewer: ScopeViewer): Promise<BillingScope> {
  if (viewer.roles.includes('owner') || viewer.roles.includes('admin')) return { kind: 'all' };
  const locations = viewer.roles.includes('reception') ? await visibleLocationIds(tx, viewer) : [];
  return {
    kind: 'limited',
    locationIds: locations === 'all' ? [] : locations,
    professionalId: viewer.roles.includes('professional')
      ? (viewer.ownProfessionalId ?? viewer.professionalId)
      : null,
  };
}

/** Whether a charge (or the appointment behind it) is inside the scope. */
export function canSee(
  scope: BillingScope,
  target: { locationId: string; professionalId: string },
): boolean {
  if (scope.kind === 'all') return true;
  return (
    scope.locationIds.includes(target.locationId) ||
    (scope.professionalId !== null && scope.professionalId === target.professionalId)
  );
}
