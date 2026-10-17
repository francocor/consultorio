import {
  WAITLIST_CALL_REASONS,
  type WaitlistCallItemDto,
  type WaitlistCallListResponse,
} from '@consultorio/contracts';
import { and, asc, eq, gt, inArray, isNotNull, ne, sql } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import { waitlistCall, waitlistEntry, waitlistOffer } from '../../../db/schema/waitlist.js';
import { worklistItem } from '../../../db/schema/worklist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { visibleLocationIds, type LocationViewer } from '../../access/index.js';
import { readPatientContacts } from '../../patients/index.js';

import { loadEntries } from './entry-view.js';

/** The most slots the panel lists. */
const LIMIT = 100;

function reasonOf(value: string): WaitlistCallItemDto['reason'] {
  const found = WAITLIST_CALL_REASONS.find((reason) => reason === value);
  if (found === undefined) throw new Error(`Unexpected call reason "${value}"`);
  return found;
}

/**
 * The panel of reception for the waitlist (waitlist, "Matching freed slots"): the slots that are
 * still free and still ahead with the entries to call for them, and the entries that let three
 * offers expire in a row. A slot is listed while:
 *
 * - it has not started, and nobody holds it (no appointment over it, no offer open for it);
 * - the entry still waits (not closed, not paused);
 * - the item of the reception worklist that points at the entry is still open, so settling it
 *   there takes the slot off this panel too;
 * - the viewer works at its place: reception sees the slots of the places it is assigned to.
 */
export async function listCalls(
  tx: Tx,
  input: { now: Date; viewer: LocationViewer },
): Promise<WaitlistCallListResponse> {
  const visible = await visibleLocationIds(tx, input.viewer);
  const rows = await tx
    .select({ call: waitlistCall, worklistItemId: worklistItem.id })
    .from(waitlistCall)
    .innerJoin(waitlistEntry, eq(waitlistEntry.id, waitlistCall.entryId))
    .innerJoin(
      worklistItem,
      and(
        eq(worklistItem.subjectId, waitlistCall.entryId),
        eq(worklistItem.subjectType, 'waitlist_entry'),
        eq(worklistItem.kind, 'waitlist_manual_contact'),
        eq(worklistItem.status, 'open'),
      ),
    )
    .where(
      and(
        gt(waitlistCall.startsAt, input.now),
        inArray(waitlistEntry.status, ['active', 'offered']),
        sql`not exists (select 1 from ${appointment}
              where ${appointment.professionalId} = ${waitlistCall.professionalId}
                and ${appointment.status} not in ('cancelled', 'no_show')
                and ${appointment.startsAt} < ${waitlistCall.endsAt}
                and ${appointment.endsAt} > ${waitlistCall.startsAt})`,
        sql`not exists (select 1 from ${waitlistOffer}
              where ${waitlistOffer.professionalId} = ${waitlistCall.professionalId}
                and ${waitlistOffer.status} = 'open'
                and ${waitlistOffer.startsAt} < ${waitlistCall.endsAt}
                and ${waitlistOffer.endsAt} > ${waitlistCall.startsAt})`,
      ),
    )
    .orderBy(asc(waitlistCall.startsAt), asc(waitlistCall.createdAt), asc(waitlistCall.id))
    .limit(LIMIT);
  const shown = rows.filter((row) => visible === 'all' || visible.includes(row.call.locationId));

  const unresponsive = await loadEntries(
    tx,
    and(ne(waitlistEntry.status, 'closed'), isNotNull(waitlistEntry.flaggedAt)),
  );
  if (shown.length === 0) return { items: [], unresponsive };

  const entries = new Map(
    (
      await loadEntries(
        tx,
        inArray(waitlistEntry.id, [...new Set(shown.map((row) => row.call.entryId))]),
      )
    ).map((entry) => [entry.id, entry]),
  );
  const contacts = new Map(
    (
      await readPatientContacts(tx, [...new Set([...entries.values()].map((e) => e.patientId))])
    ).map((contact) => [contact.id, contact]),
  );
  const professionals = new Map(
    (
      await tx
        .select({ id: professional.id, name: membership.displayName })
        .from(professional)
        .innerJoin(membership, eq(membership.id, professional.membershipId))
        .where(inArray(professional.id, [...new Set(shown.map((row) => row.call.professionalId))]))
    ).map((row) => [row.id, row.name?.trim() || 'Profesional']),
  );
  const places = new Map(
    (
      await tx
        .select({ id: location.id, name: location.name, timeZone: location.timeZone })
        .from(location)
        .where(inArray(location.id, [...new Set(shown.map((row) => row.call.locationId))]))
    ).map((row) => [row.id, row]),
  );

  const items: WaitlistCallItemDto[] = [];
  for (const row of shown) {
    const entry = entries.get(row.call.entryId);
    const place = places.get(row.call.locationId);
    if (!entry || !place) continue;
    const contact = contacts.get(entry.patientId);
    items.push({
      worklistItemId: row.worklistItemId,
      reason: reasonOf(row.call.reason),
      entry,
      contact: { phone: contact?.phone ?? null, email: contact?.email ?? null },
      slot: {
        startsAt: row.call.startsAt.toISOString(),
        endsAt: row.call.endsAt.toISOString(),
        professionalId: row.call.professionalId,
        professionalName: professionals.get(row.call.professionalId) ?? 'Profesional',
        locationId: place.id,
        locationName: place.name,
        timeZone: place.timeZone,
      },
    });
  }
  return { items, unresponsive };
}
