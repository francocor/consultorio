import { and, eq, inArray, isNull } from 'drizzle-orm';

import { bookingLink } from '../../../db/schema/online-booking.js';
import {
  appointmentType,
  professionalHoursException,
} from '../../../db/schema/scheduling-config.js';
import { professional, professionalHours } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { typeOffered } from './entries.js';

/** What a visitor may wait for: one professional, one type and, if they name it, one place. */
export interface JoinTarget {
  professionalId: string;
  appointmentTypeId: string;
  locationId: string | null;
  /** The booking link the visitor came through. */
  linkId: string;
}

/**
 * Whether the waitlist can be joined for this professional, type and place through the public
 * address. The waitlist offers exactly what online booking exposes (waitlist, "Joining the
 * waitlist"; online-booking, "Public booking links"): the organization's address has to exist, the
 * professional's own link has to be enabled, and the type and the place have to be among the ones
 * that link was given. Anything else looks like an address that is not live: null, with no reason.
 *
 * It reads the booking links, which belong to online booking, and writes nothing.
 */
export async function findJoinTarget(
  tx: Tx,
  input: {
    organizationSlug: string;
    professionalSlug: string;
    appointmentTypeId: string;
    locationId: string | undefined;
  },
): Promise<JoinTarget | null> {
  const links = await tx
    .select()
    .from(bookingLink)
    .where(inArray(bookingLink.slug, [input.organizationSlug, input.professionalSlug]));
  const organization = links.find(
    (row) => row.slug === input.organizationSlug && row.professionalId === null,
  );
  const link = links.find(
    (row) => row.slug === input.professionalSlug && row.professionalId !== null && row.enabled,
  );
  if (!organization || !link?.professionalId) return null;
  if (!link.typeIds.includes(input.appointmentTypeId)) return null;

  const [who] = await tx
    .select({
      id: professional.id,
      status: professional.status,
      specialties: professional.specialties,
    })
    .from(professional)
    .where(eq(professional.id, link.professionalId));
  const [type] = await tx
    .select()
    .from(appointmentType)
    .where(and(eq(appointmentType.id, input.appointmentTypeId), eq(appointmentType.active, true)));
  if (who?.status !== 'active' || !type || !typeOffered(type, who)) return null;

  if (input.locationId !== undefined) {
    if (link.locationIds.length > 0 && !link.locationIds.includes(input.locationId)) return null;
    const [place] = await tx
      .select({ id: location.id })
      .from(location)
      .where(and(eq(location.id, input.locationId), eq(location.active, true)));
    if (!place) return null;
    // Only a place where the professional works: a link with no list exposes those, no others.
    const [weekly] = await tx
      .select({ id: professionalHours.id })
      .from(professionalHours)
      .where(
        and(
          eq(professionalHours.professionalId, who.id),
          eq(professionalHours.locationId, input.locationId),
          isNull(professionalHours.removedAt),
        ),
      )
      .limit(1);
    const [dated] = weekly
      ? []
      : await tx
          .select({ id: professionalHoursException.id })
          .from(professionalHoursException)
          .where(
            and(
              eq(professionalHoursException.professionalId, who.id),
              eq(professionalHoursException.locationId, input.locationId),
              isNull(professionalHoursException.removedAt),
            ),
          )
          .limit(1);
    if (!weekly && !dated) return null;
  }
  return {
    professionalId: who.id,
    appointmentTypeId: type.id,
    locationId: input.locationId ?? null,
    linkId: link.id,
  };
}
