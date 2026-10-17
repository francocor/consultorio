import type { WaitlistCallReason } from '@consultorio/contracts';
import { and, asc, desc, eq, gt, inArray, lt, notInArray, sql } from 'drizzle-orm';

import { appointment } from '../../../db/schema/scheduling.js';
import { professional } from '../../../db/schema/staff.js';
import {
  waitlistCall,
  waitlistEntry,
  waitlistOffer,
  type WaitlistEntryRow,
} from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { SchedulingPorts } from '../../scheduling/index.js';
import { manualContactReason } from '../domain/manual-contact.js';
import {
  entriesForSlot,
  offerTiming,
  orderEntries,
  tileStarts,
  type FreedSlot,
  type WaitingEntry,
} from '../domain/matching.js';

import { typeOffered } from './entries.js';
import { createOffer, slotKeyOf, SYSTEM_ACTOR } from './offers.js';
import { reachOf } from './reachability.js';
import { loadWaitlistConfig } from './settings.js';
import { canBookSlot } from './slot-booking.js';
import type { FreedRange } from './trigger.js';

/** The most waiting entries one match looks at. */
const MAX_ENTRIES = 300;
/** The most slots shown to reception for one freed range. */
const MAX_CALLS = 10;
/** The most dry runs of a booking one match makes. */
const MAX_CHECKS = 40;

type TypeRecord = NonNullable<Awaited<ReturnType<SchedulingPorts['findType']>>>;

export interface MatchDeps {
  portsOf(tx: Tx): SchedulingPorts;
  jobs: JobClient;
}

export interface MatchResult {
  /** The offer that was made, if one was. */
  offerId: string | null;
  /** The entries put in front of reception to call. */
  calls: number;
}

interface Candidate {
  professionalId: string;
  locationId: string;
  timeZone: string;
  typeId: string;
  startsAt: Date;
  endsAt: Date;
}

const toWaiting = (row: WaitlistEntryRow): WaitingEntry => ({
  id: row.id,
  patientId: row.patientId,
  professionalId: row.professionalId,
  locationId: row.locationId,
  weekdays: row.weekdays,
  timeRanges: row.timeRanges,
  earliestDate: row.earliestDate,
  latestDate: row.latestDate,
  priority: row.priority,
  waitingSince: row.createdAt,
});

/** Patients among these who have another appointment overlapping the range. */
async function busyPatients(
  tx: Tx,
  patientIds: readonly string[],
  range: { startsAt: Date; endsAt: Date },
): Promise<Set<string>> {
  if (patientIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ patientId: appointment.patientId })
    .from(appointment)
    .where(
      and(
        inArray(appointment.patientId, [...patientIds]),
        notInArray(appointment.status, ['cancelled', 'no_show']),
        lt(appointment.startsAt, range.endsAt),
        gt(appointment.endsAt, range.startsAt),
      ),
    );
  return new Set(rows.map((row) => row.patientId));
}

/** Patients who were already offered this slot, through any of their entries. */
async function patientsOffered(tx: Tx, slotKey: string): Promise<Set<string>> {
  const rows = await tx
    .select({ patientId: waitlistOffer.patientId })
    .from(waitlistOffer)
    .where(eq(waitlistOffer.slotKey, slotKey));
  return new Set(rows.map((row) => row.patientId));
}

/** The places a professional works at on the days of a range. */
async function workedLocations(
  ports: SchedulingPorts,
  professionalId: string,
  range: { startsAt: Date; endsAt: Date },
): Promise<string[]> {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const hours = await ports.hours(
    professionalId,
    '',
    day(new Date(range.startsAt.getTime() - 86_400_000)),
    day(new Date(range.endsAt.getTime() + 86_400_000)),
  );
  return [
    ...new Set([
      ...hours.weekly.map((row) => row.locationId),
      ...hours.periods.flatMap((period) => period.rows.map((row) => row.locationId)),
    ]),
  ];
}

/** Shows reception a slot to fill by phone, with the entry to call. */
async function recordCall(
  tx: Tx,
  ports: SchedulingPorts,
  row: WaitlistEntryRow,
  candidate: Candidate,
  reason: WaitlistCallReason,
): Promise<void> {
  await tx
    .insert(waitlistCall)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      entryId: row.id,
      professionalId: candidate.professionalId,
      locationId: candidate.locationId,
      appointmentTypeId: candidate.typeId,
      startsAt: candidate.startsAt,
      endsAt: candidate.endsAt,
      reason,
    })
    .onConflictDoNothing();
  await ports.openWorklistItem({
    kind: 'waitlist_manual_contact',
    subjectType: 'waitlist_entry',
    subjectId: row.id,
    locationId: candidate.locationId,
  });
}

/**
 * Finds who a freed range of time can be offered to (waitlist, "Matching freed slots"). For every
 * place and professional the range touches it lays out the visits that fit, and for each start, in
 * time order, it takes the entries whose preferences fit in the order they are offered: the
 * organization's override, then the longest wait. Each candidate is checked against every rule
 * scheduling applies to a booking, without writing anything. Then, for the first one that passes:
 *
 * - an entry that is manual contact only, or whose patient can no longer be reached, is put in
 *   front of reception;
 * - when the slot starts too soon (or quiet hours use up the time) nobody is sent anything, and
 *   the entries are put in front of reception;
 * - otherwise ONE offer is made and the search stops. The next entry gets its turn when this offer
 *   is declined, expires or ends.
 *
 * Whoever the range was already offered to is not offered it again, and neither is a patient who
 * has another appointment then.
 */
export async function matchFreedSlot(
  tx: Tx,
  deps: MatchDeps,
  input: FreedRange & { now: Date },
): Promise<MatchResult> {
  const ports = deps.portsOf(tx);
  const { now } = input;
  // Two matches of the same professional never run side by side.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.professionalId ?? 'any'}, 361))`,
  );

  // One offer at a time for a freed range.
  const [inFlight] = await tx
    .select({ id: waitlistOffer.id })
    .from(waitlistOffer)
    .where(
      and(
        eq(waitlistOffer.status, 'open'),
        input.professionalId === null
          ? undefined
          : eq(waitlistOffer.professionalId, input.professionalId),
        lt(waitlistOffer.startsAt, input.endsAt),
        gt(waitlistOffer.endsAt, input.startsAt),
      ),
    )
    .limit(1);
  if (inFlight) return { offerId: null, calls: 0 };

  const waiting = await tx
    .select()
    .from(waitlistEntry)
    .where(and(eq(waitlistEntry.status, 'active'), gt(waitlistEntry.expiresAt, now)))
    .orderBy(desc(waitlistEntry.priority), asc(waitlistEntry.createdAt), asc(waitlistEntry.id))
    .limit(MAX_ENTRIES);
  if (waiting.length === 0) return { offerId: null, calls: 0 };
  const config = await loadWaitlistConfig(tx);

  const types = new Map<string, TypeRecord>();
  for (const typeId of new Set(waiting.map((row) => row.appointmentTypeId))) {
    const type = await ports.findType(typeId);
    if (type?.active) types.set(typeId, type);
  }
  const professionalIds =
    input.professionalId === null
      ? (
          await tx
            .select({ id: professional.id })
            .from(professional)
            .where(eq(professional.status, 'active'))
        ).map((row) => row.id)
      : [input.professionalId];

  // Every visit that fits in the range, for each place, professional and type somebody waits for.
  const candidates: Candidate[] = [];
  for (const professionalId of professionalIds) {
    const who = await ports.findProfessional(professionalId);
    if (who?.status !== 'active') continue;
    const locationIds =
      input.locationId === null ? await workedLocations(ports, who.id, input) : [input.locationId];
    for (const locationId of locationIds) {
      const place = await ports.findLocation(locationId);
      if (!place?.active) continue;
      for (const [typeId, type] of types) {
        if (!typeOffered(type, who)) continue;
        const wanted = waiting.some(
          (row) =>
            row.appointmentTypeId === typeId &&
            (row.professionalId === null || row.professionalId === who.id) &&
            (row.locationId === null || row.locationId === place.id),
        );
        if (!wanted) continue;
        for (const startsAt of tileStarts(input, type.durationMinutes)) {
          candidates.push({
            professionalId: who.id,
            locationId: place.id,
            timeZone: place.timeZone,
            typeId,
            startsAt,
            endsAt: new Date(startsAt.getTime() + type.durationMinutes * 60_000),
          });
        }
      }
    }
  }
  candidates.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  const starts = [...new Set(candidates.map((candidate) => candidate.startsAt.getTime()))];
  const rowOf = new Map(waiting.map((row) => [row.id, row]));
  const handled = new Set<string>();
  let checks = 0;
  let calls = 0;
  let offerId: string | null = null;

  search: for (const start of starts) {
    // The entries each visit that starts now can be offered to, in the order they are offered.
    const pool: { entry: WaitingEntry; candidate: Candidate }[] = [];
    for (const candidate of candidates.filter((item) => item.startsAt.getTime() === start)) {
      const slot: FreedSlot = {
        professionalId: candidate.professionalId,
        locationId: candidate.locationId,
        startsAt: candidate.startsAt,
        endsAt: candidate.endsAt,
        timeZone: candidate.timeZone,
      };
      const same = waiting
        .filter((row) => row.appointmentTypeId === candidate.typeId)
        .map(toWaiting);
      const fits = entriesForSlot({
        entries: same,
        slot,
        busyPatients: await busyPatients(
          tx,
          same.map((entry) => entry.patientId),
          candidate,
        ),
        offeredPatients: await patientsOffered(tx, slotKeyOf(slot)),
      });
      for (const entry of fits) pool.push({ entry, candidate });
    }
    const ranked = orderEntries(pool.map((item) => item.entry));
    for (const entry of ranked) {
      if (handled.has(entry.patientId)) continue;
      let row = rowOf.get(entry.id);
      const candidate = pool.find((item) => item.entry.id === entry.id)?.candidate;
      if (!row || !candidate) continue;

      if (checks >= MAX_CHECKS) break search;
      checks += 1;
      const booking = await canBookSlot(ports, {
        patientId: row.patientId,
        professionalId: candidate.professionalId,
        locationId: candidate.locationId,
        appointmentTypeId: candidate.typeId,
        startsAt: candidate.startsAt,
        identityConfirmed: true,
        auditActor: SYSTEM_ACTOR,
        now,
      });
      if (!booking.ok) continue;

      // A patient who opted out since the entry was made can no longer be offered anything.
      if (!row.manualContactOnly) {
        const reason = manualContactReason({
          offersOptIn: row.offersOptInAt !== null,
          channels: row.channels.filter(
            (c): c is 'email' | 'whatsapp' => c === 'email' || c === 'whatsapp',
          ),
          reach: await reachOf(tx, row.patientId),
        });
        if (reason !== null) {
          await tx
            .update(waitlistEntry)
            .set({ manualContactOnly: true, manualReason: reason })
            .where(eq(waitlistEntry.id, row.id));
          row = { ...row, manualContactOnly: true, manualReason: reason };
        }
      }

      if (row.manualContactOnly) {
        if (calls < MAX_CALLS) {
          await recordCall(tx, ports, row, candidate, 'manual_contact_only');
          calls += 1;
        }
        handled.add(row.patientId);
        continue;
      }

      const timing = offerTiming({
        now,
        startsAt: candidate.startsAt,
        minLeadMinutes: config.waitlist.minOfferLeadMinutes,
        offerWindowMinutes: config.waitlist.offerWindowMinutes,
        quiet: config.quietHours,
        timeZone: candidate.timeZone,
      });
      if (timing.kind === 'manual') {
        if (calls < MAX_CALLS) {
          await recordCall(tx, ports, row, candidate, timing.reason);
          calls += 1;
        }
        handled.add(row.patientId);
        continue;
      }

      const offer = await createOffer(
        tx,
        { jobs: deps.jobs },
        {
          entry: row,
          professionalId: candidate.professionalId,
          locationId: candidate.locationId,
          startsAt: candidate.startsAt,
          endsAt: candidate.endsAt,
          freed: { startsAt: input.startsAt, endsAt: input.endsAt },
          sendAt: timing.sendAt,
          expiresAt: timing.expiresAt,
          now,
        },
      );
      if (offer) {
        offerId = offer.id;
        break search;
      }
      handled.add(row.patientId);
    }
  }
  return { offerId, calls };
}
