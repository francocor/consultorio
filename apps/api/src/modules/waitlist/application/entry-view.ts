import {
  WAITLIST_CHANNELS,
  WAITLIST_CLOSE_REASONS,
  WAITLIST_ENTRY_SOURCES,
  WAITLIST_ENTRY_STATUSES,
  WAITLIST_MANUAL_REASONS,
  WAITLIST_OFFER_END_REASONS,
  WAITLIST_OFFER_STATUSES,
  WAITLIST_OPT_IN_SOURCES,
  type WaitlistEntryDto,
  type WaitlistOfferDto,
} from '@consultorio/contracts';
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { patient } from '../../../db/schema/patients.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import {
  waitlistEntry,
  waitlistOffer,
  type WaitlistEntryRow,
  type WaitlistOfferRow,
} from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/** The value if it is one of the allowed ones; the database checks them, so this only narrows. */
function oneOf<T extends string>(allowed: readonly T[], value: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`Unexpected value "${value}"`);
  return found;
}

function maybeOneOf<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return value === null ? null : oneOf(allowed, value);
}

const iso = (date: Date | null) => (date ? date.toISOString() : null);

export function toOfferDto(row: WaitlistOfferRow): WaitlistOfferDto {
  return {
    id: row.id,
    status: oneOf(WAITLIST_OFFER_STATUSES, row.status),
    endReason: maybeOneOf(WAITLIST_OFFER_END_REASONS, row.endReason),
    professionalId: row.professionalId,
    locationId: row.locationId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    closedAt: iso(row.closedAt),
    channel: maybeOneOf(WAITLIST_CHANNELS, row.channel),
    appointmentId: row.appointmentId,
  };
}

interface EntryNames {
  givenNames: string;
  familyName: string;
  typeName: string;
  professionalName: string | null;
  locationName: string | null;
}

export function toEntryDto(
  row: WaitlistEntryRow,
  names: EntryNames,
  openOffer: WaitlistOfferRow | null,
): WaitlistEntryDto {
  return {
    id: row.id,
    patientId: row.patientId,
    patientName: `${names.givenNames} ${names.familyName}`.trim(),
    appointmentTypeId: row.appointmentTypeId,
    appointmentTypeName: names.typeName,
    professionalId: row.professionalId,
    professionalName:
      row.professionalId === null ? null : (names.professionalName ?? 'Profesional'),
    locationId: row.locationId,
    locationName: names.locationName,
    weekdays: row.weekdays,
    timeRanges: row.timeRanges,
    earliestDate: row.earliestDate,
    latestDate: row.latestDate,
    status: oneOf(WAITLIST_ENTRY_STATUSES, row.status),
    closeReason: maybeOneOf(WAITLIST_CLOSE_REASONS, row.closeReason),
    closedAt: iso(row.closedAt),
    expiresAt: row.expiresAt.toISOString(),
    manualContactOnly: row.manualContactOnly,
    manualReason: maybeOneOf(WAITLIST_MANUAL_REASONS, row.manualReason),
    offersOptInAt: iso(row.offersOptInAt),
    offersOptInSource: maybeOneOf(WAITLIST_OPT_IN_SOURCES, row.offersOptInSource),
    channels: row.channels.map((channel) => oneOf(WAITLIST_CHANNELS, channel)),
    priority: row.priority,
    unresponsive: row.flaggedAt !== null,
    consecutiveExpired: row.consecutiveExpired,
    source: oneOf(WAITLIST_ENTRY_SOURCES, row.source),
    createdAt: row.createdAt.toISOString(),
    openOffer: openOffer ? toOfferDto(openOffer) : null,
  };
}

/**
 * Entries as staff read them: the patient's name, what is waited for and the offer in flight.
 * Longest wait first within a priority, so the list reads in the order offers go out.
 */
export async function loadEntries(
  tx: Tx,
  where: SQL | undefined,
  options: { limit?: number } = {},
): Promise<WaitlistEntryDto[]> {
  const rows = await tx
    .select({
      entry: waitlistEntry,
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      typeName: appointmentType.name,
      professionalName: membership.displayName,
      locationName: location.name,
    })
    .from(waitlistEntry)
    .innerJoin(patient, eq(patient.id, waitlistEntry.patientId))
    .innerJoin(appointmentType, eq(appointmentType.id, waitlistEntry.appointmentTypeId))
    .leftJoin(professional, eq(professional.id, waitlistEntry.professionalId))
    .leftJoin(membership, eq(membership.id, professional.membershipId))
    .leftJoin(location, eq(location.id, waitlistEntry.locationId))
    .where(where)
    .orderBy(desc(waitlistEntry.priority), asc(waitlistEntry.createdAt), asc(waitlistEntry.id))
    .limit(options.limit ?? 200);
  if (rows.length === 0) return [];

  const open = await tx
    .select()
    .from(waitlistOffer)
    .where(
      and(
        inArray(
          waitlistOffer.entryId,
          rows.map((row) => row.entry.id),
        ),
        eq(waitlistOffer.status, 'open'),
      ),
    );
  const offerOf = new Map(open.map((offer) => [offer.entryId, offer]));
  return rows.map((row) =>
    toEntryDto(
      row.entry,
      {
        givenNames: row.givenNames,
        familyName: row.familyName,
        typeName: row.typeName,
        professionalName: row.professionalName,
        locationName: row.locationName,
      },
      offerOf.get(row.entry.id) ?? null,
    ),
  );
}

export async function loadEntry(tx: Tx, id: string): Promise<WaitlistEntryDto | null> {
  const [found] = await loadEntries(tx, eq(waitlistEntry.id, id), { limit: 1 });
  return found ?? null;
}

/** The offers an entry received, newest first. */
export async function loadOffers(tx: Tx, entryId: string): Promise<WaitlistOfferDto[]> {
  const rows = await tx
    .select()
    .from(waitlistOffer)
    .where(eq(waitlistOffer.entryId, entryId))
    .orderBy(desc(waitlistOffer.createdAt), desc(waitlistOffer.id))
    .limit(50);
  return rows.map(toOfferDto);
}
