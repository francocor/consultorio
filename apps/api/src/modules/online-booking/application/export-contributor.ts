import { asc } from 'drizzle-orm';

import { bookingLink } from '../../../db/schema/online-booking.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by online-booking: the public booking links, which professional
 * each belongs to and what it exposes. The unverified submissions and their one-time codes are not
 * exported: they are encrypted, transient (deleted after 24 hours) and about people who are not
 * patients of the organization.
 */
export const exportOnlineBooking: ExportContributor = async ({ tx }) => {
  const links = await tx
    .select({
      id: bookingLink.id,
      professionalId: bookingLink.professionalId,
      slug: bookingLink.slug,
      enabled: bookingLink.enabled,
      locationIds: bookingLink.locationIds,
      typeIds: bookingLink.typeIds,
      regeneratedAt: bookingLink.regeneratedAt,
      createdAt: bookingLink.createdAt,
    })
    .from(bookingLink)
    .orderBy(asc(bookingLink.createdAt), asc(bookingLink.id));
  return { bookingLinks: links };
};
