import { eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import { location, tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { readOrganizationName } from '../../tenancy/index.js';

/** The words a message or a page uses for a slot: the organization, the place and the person. */
export interface SlotNames {
  organizationName: string;
  /** Null when the organization does not name the professional in messages. */
  professionalName: string | null;
  locationName: string;
  timeZone: string;
}

/** The `hideProfessional` wording of the organization (the messaging settings). */
async function hidesProfessional(tx: Tx): Promise<boolean> {
  const [row] = await tx.select({ settings: tenant.settings }).from(tenant);
  const section = row?.settings['notifications'];
  return (
    typeof section === 'object' &&
    section !== null &&
    (section as Record<string, unknown>)['hideProfessional'] === true
  );
}

/**
 * What an offer says about its slot (waitlist, "Privacy": offers reveal only date, time, location
 * and, per the organization's wording, the professional). Null when the place does not exist.
 */
export async function loadSlotNames(
  tx: Tx,
  slot: { professionalId: string; locationId: string },
): Promise<SlotNames | null> {
  const [place] = await tx
    .select({ name: location.name, timeZone: location.timeZone })
    .from(location)
    .where(eq(location.id, slot.locationId));
  if (!place) return null;
  const [who] = await tx
    .select({ name: membership.displayName })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .where(eq(professional.id, slot.professionalId));
  return {
    organizationName: await readOrganizationName(tx),
    professionalName: (await hidesProfessional(tx)) ? null : (who?.name?.trim() ?? 'Profesional'),
    locationName: place.name,
    timeZone: place.timeZone,
  };
}
