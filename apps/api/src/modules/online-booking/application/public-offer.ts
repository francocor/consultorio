import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { bookingLink, type BookingLinkRow } from '../../../db/schema/online-booking.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { SchedulingPorts } from '../../scheduling/index.js';

/** What a visitor may book with one professional, as the link of that professional exposes it. */
export interface ProfessionalOffer {
  link: BookingLinkRow;
  professionalId: string;
  name: string;
  specialties: string[];
  maxSimultaneous: number;
  types: {
    id: string;
    name: string;
    durationMinutes: number;
    bufferMinutes: number;
    mode: 'in_person' | 'virtual';
    requiresApproval: boolean;
  }[];
  locations: { id: string; name: string; timeZone: string }[];
}

export interface OfferContext {
  now: Date;
  /** The organization can hold video appointments (its switch is on and a provider is configured). */
  videoAvailable: boolean;
  /** For the locations the professional works at: how far ahead hours are looked up. */
  horizonDays: number;
  portsOf: (tx: Tx) => SchedulingPorts;
}

/** The enabled link of the organization with this slug, or null (it looks like any unknown one). */
export async function findOrganizationLink(tx: Tx, slug: string): Promise<BookingLinkRow | null> {
  const [row] = await tx.select().from(bookingLink).where(eq(bookingLink.slug, slug));
  return row && row.professionalId === null && row.enabled ? row : null;
}

/**
 * The enabled link of a professional, reached through the organization address it lives under. The
 * organization row only has to exist for the address to be a real one (a regenerated organization
 * link ends the addresses under it); it does not have to be enabled, so a professional can be open
 * while the organization page is closed.
 */
async function findProfessionalLink(
  tx: Tx,
  organizationSlug: string,
  professionalSlug: string,
): Promise<BookingLinkRow | null> {
  const rows = await tx
    .select()
    .from(bookingLink)
    .where(inArray(bookingLink.slug, [organizationSlug, professionalSlug]));
  const organization = rows.find((row) => row.slug === organizationSlug);
  const link = rows.find((row) => row.slug === professionalSlug);
  if (!organization || organization.professionalId !== null) return null;
  if (!link || link.professionalId === null || !link.enabled) return null;
  return link;
}

function typeOffered(
  type: { professionalIds: string[]; specialties: string[] },
  who: { id: string; specialties: string[] },
): boolean {
  if (type.professionalIds.length > 0 && !type.professionalIds.includes(who.id)) return false;
  return (
    type.specialties.length === 0 ||
    type.specialties.some((specialty) => who.specialties.includes(specialty))
  );
}

async function offerOf(
  tx: Tx,
  link: BookingLinkRow,
  context: OfferContext,
): Promise<ProfessionalOffer | null> {
  if (link.professionalId === null) return null;
  const [who] = await tx
    .select({
      id: professional.id,
      status: professional.status,
      maxSimultaneous: professional.maxSimultaneous,
      specialties: professional.specialties,
      name: membership.displayName,
    })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .where(eq(professional.id, link.professionalId));
  if (!who || who.status !== 'active') return null;

  const typeRows =
    link.typeIds.length === 0
      ? []
      : await tx
          .select()
          .from(appointmentType)
          .where(and(inArray(appointmentType.id, link.typeIds), eq(appointmentType.active, true)))
          .orderBy(asc(appointmentType.name), asc(appointmentType.id));
  const types = typeRows
    .filter((type) => typeOffered(type, who))
    .filter((type) => type.mode === 'in_person' || context.videoAvailable)
    .map((type) => ({
      id: type.id,
      name: type.name,
      durationMinutes: type.durationMinutes,
      bufferMinutes: type.bufferMinutes,
      mode: type.mode === 'virtual' ? ('virtual' as const) : ('in_person' as const),
      requiresApproval: type.requiresApproval,
    }));

  // The locations where the professional has hours, narrowed to the ones the link exposes.
  const from = context.now.toISOString().slice(0, 10);
  const to = new Date(context.now.getTime() + context.horizonDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const hours = await context.portsOf(tx).hours(who.id, '', from, to);
  const worked = new Set([
    ...hours.weekly.map((row) => row.locationId),
    ...hours.periods.flatMap((period) => period.rows.map((row) => row.locationId)),
  ]);
  const wanted = (link.locationIds.length > 0 ? link.locationIds : [...worked]).filter((id) =>
    worked.has(id),
  );
  const locationRows =
    wanted.length === 0
      ? []
      : await tx
          .select({ id: location.id, name: location.name, timeZone: location.timeZone })
          .from(location)
          .where(and(inArray(location.id, wanted), eq(location.active, true)))
          .orderBy(asc(location.name), asc(location.id));

  return {
    link,
    professionalId: who.id,
    name: who.name?.trim() || 'Profesional',
    specialties: who.specialties,
    maxSimultaneous: who.maxSimultaneous,
    types,
    locations: locationRows,
  };
}

/** The offer of the professional behind `professionalSlug`, or null when the address is not live. */
export async function findProfessionalOffer(
  tx: Tx,
  input: { organizationSlug: string; professionalSlug: string },
  context: OfferContext,
): Promise<ProfessionalOffer | null> {
  const link = await findProfessionalLink(tx, input.organizationSlug, input.professionalSlug);
  return link ? offerOf(tx, link, context) : null;
}

/** The professionals an organization page lists: those whose own link is enabled and has something to book. */
export async function listOrganizationOffers(
  tx: Tx,
  context: OfferContext,
): Promise<ProfessionalOffer[]> {
  const links = await tx
    .select()
    .from(bookingLink)
    .where(eq(bookingLink.enabled, true))
    .orderBy(asc(bookingLink.createdAt), asc(bookingLink.id));
  const offers: ProfessionalOffer[] = [];
  for (const link of links) {
    if (link.professionalId === null) continue;
    const offer = await offerOf(tx, link, context);
    if (offer && offer.types.length > 0 && offer.locations.length > 0) offers.push(offer);
  }
  return offers;
}

/**
 * The offer of a professional named by their internal id, as long as their link is enabled and sits
 * under the organization address in the URL. Used once a visitor already holds a slot of theirs (the
 * hold names the professional); the id is never read from a request.
 */
export async function findOfferByProfessional(
  tx: Tx,
  input: { organizationSlug: string; professionalId: string },
  context: OfferContext,
): Promise<ProfessionalOffer | null> {
  const [link] = await tx
    .select()
    .from(bookingLink)
    .where(
      and(eq(bookingLink.professionalId, input.professionalId), eq(bookingLink.enabled, true)),
    );
  if (!link) return null;
  const [organization] = await tx
    .select({ id: bookingLink.id })
    .from(bookingLink)
    .where(and(eq(bookingLink.slug, input.organizationSlug), isNull(bookingLink.professionalId)));
  if (!organization) return null;
  return offerOf(tx, link, context);
}
