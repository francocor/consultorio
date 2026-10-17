import type {
  CreateWaitlistEntryRequest,
  UpdateWaitlistEntryRequest,
  WaitlistChannel,
  WaitlistCloseReason,
  WaitlistEntryDto,
  WaitlistEntrySource,
  WaitlistListQuery,
  WaitlistOptInSource,
  WaitlistTimeRange,
} from '@consultorio/contracts';
import { and, count, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';

import {
  waitlistEntry,
  waitlistOffer,
  type WaitlistEntryRow,
} from '../../../db/schema/waitlist.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { SchedulingPorts } from '../../scheduling/index.js';
import { manualContactReason } from '../domain/manual-contact.js';

import { loadEntries, loadEntry } from './entry-view.js';
import { invalidateOpenOffers } from './offer-state.js';
import { reachOf } from './reachability.js';
import { loadWaitlistConfig } from './settings.js';

const DAY_MS = 86_400_000;

/** A staff member (or the system) acting, for the audit trail. */
export type EntryActor = AuditActor & { userId: string | null };

/** The patient already waits for the same thing: the caller shows the entry that exists. */
export class DuplicateEntryError extends Error {
  constructor(readonly existingEntryId: string) {
    super('duplicate waitlist entry');
    this.name = 'DuplicateEntryError';
  }
}

export interface EntryDeps {
  /** Scheduling's view of the professionals, types, places and patients of the organization. */
  portsOf(tx: Tx): SchedulingPorts;
}

/** Entries that still wait, are paused or have an offer open. */
const IN_PLAY = ne(waitlistEntry.status, 'closed');

function notAvailable(): AppError {
  return new AppError('waitlist_not_available');
}

/** The type is offered by the professional (an empty list means everyone), as scheduling decides. */
export function typeOffered(
  type: { professionalIds: string[]; specialties: string[] },
  who: { id: string; specialties: string[] },
): boolean {
  if (type.professionalIds.length > 0 && !type.professionalIds.includes(who.id)) return false;
  return (
    type.specialties.length === 0 ||
    type.specialties.some((specialty) => who.specialties.includes(specialty))
  );
}

/**
 * What an entry may wait for: a patient who can be booked, a type that is on offer, and, when
 * named, a professional who offers it and a place that is open. Another organization's ids look
 * like missing ones.
 */
async function assertWaitable(
  ports: SchedulingPorts,
  input: {
    patientId: string;
    appointmentTypeId: string;
    professionalId: string | null;
    locationId: string | null;
  },
): Promise<void> {
  const patient = await ports.findPatient(input.patientId);
  const type = await ports.findType(input.appointmentTypeId);
  if (!patient || !type) throw new AppError('not_found');
  if (patient.status !== 'active' || !type.active) throw notAvailable();
  if (input.professionalId !== null) {
    const who = await ports.findProfessional(input.professionalId);
    if (!who) throw new AppError('not_found');
    if (who.status !== 'active' || !typeOffered(type, who)) throw notAvailable();
  }
  if (input.locationId !== null) {
    const place = await ports.findLocation(input.locationId);
    if (!place) throw new AppError('not_found');
    if (!place.active) throw notAvailable();
  }
}

function sameWait(input: {
  patientId: string;
  appointmentTypeId: string;
  professionalId: string | null;
  locationId: string | null;
}): SQL {
  return and(
    eq(waitlistEntry.patientId, input.patientId),
    eq(waitlistEntry.appointmentTypeId, input.appointmentTypeId),
    input.professionalId === null
      ? isNull(waitlistEntry.professionalId)
      : eq(waitlistEntry.professionalId, input.professionalId),
    input.locationId === null
      ? isNull(waitlistEntry.locationId)
      : eq(waitlistEntry.locationId, input.locationId),
    IN_PLAY,
  ) as SQL;
}

/** Serializes the entries of one patient, so the limit and the duplicate rule hold under a race. */
async function lockPatientWaits(tx: Tx, patientId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${patientId}, 360))`);
}

export interface NewEntry {
  patientId: string;
  appointmentTypeId: string;
  professionalId: string | null;
  locationId: string | null;
  weekdays: number[];
  timeRanges: WaitlistTimeRange[];
  earliestDate: string | null;
  latestDate: string | null;
  channels: WaitlistChannel[];
  /** Who recorded the patient's agreement to receive offers; null: no agreement. */
  optIn: { source: WaitlistOptInSource; recordedBy: string | null } | null;
  source: WaitlistEntrySource;
  createdBy: string | null;
  /** A public join attached to a patient who already existed (D14). */
  identityUnconfirmed?: boolean;
}

/**
 * Puts a patient on the waitlist. Everything the spec asks of an entry happens here, for staff and
 * for a verified self-join alike: the patient and what they wait for must be valid, a duplicate is
 * refused and shown, the number of entries in play is bounded, an entry without the agreement to
 * receive offers or without a channel that reaches the patient is manual contact only, and the
 * entry expires after the organization's number of days.
 */
export async function createEntryRecord(
  tx: Tx,
  deps: EntryDeps,
  input: { entry: NewEntry; actor: EntryActor; now: Date },
): Promise<WaitlistEntryDto> {
  const { entry } = input;
  await lockPatientWaits(tx, entry.patientId);
  await assertWaitable(deps.portsOf(tx), entry);

  const [existing] = await tx
    .select({ id: waitlistEntry.id })
    .from(waitlistEntry)
    .where(sameWait(entry));
  if (existing) throw new DuplicateEntryError(existing.id);

  const config = await loadWaitlistConfig(tx);
  const [inPlay] = await tx
    .select({ n: count() })
    .from(waitlistEntry)
    .where(and(eq(waitlistEntry.patientId, entry.patientId), IN_PLAY));
  if ((inPlay?.n ?? 0) >= config.waitlist.maxActiveEntries) {
    throw new AppError('waitlist_entry_limit');
  }

  const reason = manualContactReason({
    offersOptIn: entry.optIn !== null,
    channels: entry.channels,
    reach: await reachOf(tx, entry.patientId),
  });
  const [row] = await tx
    .insert(waitlistEntry)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      patientId: entry.patientId,
      appointmentTypeId: entry.appointmentTypeId,
      professionalId: entry.professionalId,
      locationId: entry.locationId,
      weekdays: entry.weekdays,
      timeRanges: entry.timeRanges,
      earliestDate: entry.earliestDate,
      latestDate: entry.latestDate,
      expiresAt: new Date(input.now.getTime() + config.waitlist.entryExpiryDays * DAY_MS),
      manualContactOnly: reason !== null,
      manualReason: reason,
      offersOptInAt: entry.optIn ? input.now : null,
      offersOptInSource: entry.optIn?.source ?? null,
      offersOptInBy: entry.optIn?.recordedBy ?? null,
      channels: entry.channels,
      source: entry.source,
      createdBy: entry.createdBy,
      identityUnconfirmed: entry.identityUnconfirmed ?? false,
      createdAt: input.now,
    })
    .returning({ id: waitlistEntry.id });
  if (!row) throw new Error('waitlist entry insert returned no row');

  await audit(tx, {
    action: 'waitlist.entry.created',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'waitlist_entry',
    resourceId: row.id,
    patientId: entry.patientId,
    metadata: {
      source: entry.source,
      manualContactOnly: reason !== null,
      ...(reason === null ? {} : { manualReason: reason }),
    },
  });
  const created = await loadEntry(tx, row.id);
  if (!created) throw new Error('waitlist entry vanished');
  return created;
}

/** Reception, a professional or an administrator adds a patient. */
export function createEntry(
  tx: Tx,
  deps: EntryDeps,
  input: { request: CreateWaitlistEntryRequest; actor: EntryActor & { userId: string }; now: Date },
): Promise<WaitlistEntryDto> {
  const { request, actor } = input;
  return createEntryRecord(tx, deps, {
    actor,
    now: input.now,
    entry: {
      patientId: request.patientId,
      appointmentTypeId: request.appointmentTypeId,
      professionalId: request.professionalId ?? null,
      locationId: request.locationId ?? null,
      weekdays: request.weekdays,
      timeRanges: request.timeRanges,
      earliestDate: request.earliestDate ?? null,
      latestDate: request.latestDate ?? null,
      channels: request.channels,
      // The staff member records what the patient told them.
      optIn: request.offersOptIn ? { source: 'staff', recordedBy: actor.userId } : null,
      source: 'staff',
      createdBy: actor.userId,
    },
  });
}

/** The entries still in play unless a status is asked for, filtered as staff asked. */
export function listEntries(tx: Tx, query: WaitlistListQuery): Promise<WaitlistEntryDto[]> {
  const conditions: SQL[] = [];
  if (query.status !== undefined) conditions.push(eq(waitlistEntry.status, query.status));
  else conditions.push(IN_PLAY);
  if (query.patientId !== undefined) conditions.push(eq(waitlistEntry.patientId, query.patientId));
  if (query.appointmentTypeId !== undefined) {
    conditions.push(eq(waitlistEntry.appointmentTypeId, query.appointmentTypeId));
  }
  if (query.professionalId !== undefined) {
    // An entry for any professional would also be fulfilled by this one.
    conditions.push(
      sql`(${waitlistEntry.professionalId} is null or ${waitlistEntry.professionalId} = ${query.professionalId})`,
    );
  }
  if (query.unresponsive === true) conditions.push(sql`${waitlistEntry.flaggedAt} is not null`);
  return loadEntries(tx, and(...conditions), { limit: query.limit ?? 100 });
}

async function lockEntry(tx: Tx, id: string): Promise<WaitlistEntryRow> {
  const [row] = await tx.select().from(waitlistEntry).where(eq(waitlistEntry.id, id)).for('update');
  if (!row) throw new AppError('not_found');
  return row;
}

function assertOpen(row: WaitlistEntryRow): void {
  if (row.status === 'closed') throw new AppError('waitlist_entry_closed');
}

async function present(tx: Tx, id: string): Promise<WaitlistEntryDto> {
  const found = await loadEntry(tx, id);
  if (!found) throw new AppError('not_found');
  return found;
}

/** Changes the preferences of an entry, or records the agreement the patient gave later. */
export async function updateEntry(
  tx: Tx,
  deps: EntryDeps,
  input: {
    id: string;
    request: UpdateWaitlistEntryRequest;
    actor: EntryActor & { userId: string };
    now: Date;
  },
): Promise<WaitlistEntryDto> {
  const row = await lockEntry(tx, input.id);
  assertOpen(row);
  const { request } = input;

  const professionalId =
    request.professionalId === undefined ? row.professionalId : request.professionalId;
  const locationId = request.locationId === undefined ? row.locationId : request.locationId;
  if (professionalId !== row.professionalId || locationId !== row.locationId) {
    await assertWaitable(deps.portsOf(tx), {
      patientId: row.patientId,
      appointmentTypeId: row.appointmentTypeId,
      professionalId,
      locationId,
    });
  }
  const earliestDate = request.earliestDate === undefined ? row.earliestDate : request.earliestDate;
  const latestDate = request.latestDate === undefined ? row.latestDate : request.latestDate;
  if (earliestDate !== null && latestDate !== null && earliestDate > latestDate) {
    throw new AppError('validation_failed', [
      { path: 'latestDate', i18nKey: 'errors.field_invalid' },
    ]);
  }

  const optedIn = row.offersOptInAt !== null || request.offersOptIn === true;
  const channels = request.channels ?? row.channels.filter(isChannel);
  const reason = manualContactReason({
    offersOptIn: optedIn,
    channels,
    reach: await reachOf(tx, row.patientId),
  });

  try {
    await tx.transaction(async (inner) => {
      await inner
        .update(waitlistEntry)
        .set({
          professionalId,
          locationId,
          weekdays: request.weekdays ?? row.weekdays,
          timeRanges: request.timeRanges ?? row.timeRanges,
          earliestDate,
          latestDate,
          channels,
          manualContactOnly: reason !== null,
          manualReason: reason,
          ...(request.offersOptIn === true && row.offersOptInAt === null
            ? {
                offersOptInAt: input.now,
                offersOptInSource: 'staff',
                offersOptInBy: input.actor.userId,
              }
            : {}),
        })
        .where(eq(waitlistEntry.id, row.id));
    });
  } catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === '23505') {
      const [other] = await tx
        .select({ id: waitlistEntry.id })
        .from(waitlistEntry)
        .where(
          and(
            sameWait({
              patientId: row.patientId,
              appointmentTypeId: row.appointmentTypeId,
              professionalId,
              locationId,
            }),
            ne(waitlistEntry.id, row.id),
          ),
        );
      if (other) throw new DuplicateEntryError(other.id);
    }
    throw error;
  }

  await audit(tx, {
    action: 'waitlist.entry.updated',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'waitlist_entry',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { fields: Object.keys(request).sort() },
  });
  return present(tx, row.id);
}

function isChannel(value: string): value is WaitlistChannel {
  return value === 'email' || value === 'whatsapp';
}

/** Stops automated offers for an entry until it is resumed. */
export async function pauseEntry(
  tx: Tx,
  input: { id: string; actor: EntryActor; now: Date },
): Promise<WaitlistEntryDto> {
  const row = await lockEntry(tx, input.id);
  assertOpen(row);
  if (row.status === 'paused') throw new AppError('conflict');
  // An offer in flight no longer stands: the patient asked not to be offered anything.
  await invalidateOpenOffers(tx, eq(waitlistOffer.entryId, row.id), {
    reason: 'entry_closed',
    now: input.now,
  });
  await tx.update(waitlistEntry).set({ status: 'paused' }).where(eq(waitlistEntry.id, row.id));
  await audit(tx, {
    action: 'waitlist.entry.updated',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'waitlist_entry',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { fields: ['status'], status: 'paused' },
  });
  return present(tx, row.id);
}

export async function resumeEntry(
  tx: Tx,
  input: { id: string; actor: EntryActor; now: Date },
): Promise<WaitlistEntryDto> {
  const row = await lockEntry(tx, input.id);
  assertOpen(row);
  if (row.status !== 'paused') throw new AppError('conflict');
  await tx.update(waitlistEntry).set({ status: 'active' }).where(eq(waitlistEntry.id, row.id));
  await audit(tx, {
    action: 'waitlist.entry.updated',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'waitlist_entry',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { fields: ['status'], status: 'active' },
  });
  return present(tx, row.id);
}

/**
 * Closes an entry with the reason, ends the offer in flight and keeps the row for the reports. It
 * is the one place an entry closes, whoever closes it: staff, the acceptance of an offer, the
 * nightly expiry or the patient opting out.
 */
export async function closeEntryRow(
  tx: Tx,
  row: WaitlistEntryRow,
  input: { reason: WaitlistCloseReason; actor: EntryActor; now: Date },
): Promise<void> {
  await invalidateOpenOffers(tx, eq(waitlistOffer.entryId, row.id), {
    reason: input.reason === 'patient_opted_out' ? 'patient_opted_out' : 'entry_closed',
    now: input.now,
  });
  await tx
    .update(waitlistEntry)
    .set({ status: 'closed', closeReason: input.reason, closedAt: input.now })
    .where(eq(waitlistEntry.id, row.id));
  await audit(tx, {
    action: 'waitlist.entry.closed',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'waitlist_entry',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { reason: input.reason },
  });
}

/** A staff member closes an entry: the patient was booked elsewhere, or no longer wants a turn. */
export async function closeEntry(
  tx: Tx,
  input: { id: string; reason: 'fulfilled' | 'cancelled'; actor: EntryActor; now: Date },
): Promise<WaitlistEntryDto> {
  const row = await lockEntry(tx, input.id);
  assertOpen(row);
  await closeEntryRow(tx, row, input);
  return present(tx, row.id);
}

/** The organization moves an entry ahead of (or back among) the others. Audited. */
export async function setPriority(
  tx: Tx,
  input: { id: string; priority: number; actor: EntryActor & { userId: string }; now: Date },
): Promise<WaitlistEntryDto> {
  const row = await lockEntry(tx, input.id);
  assertOpen(row);
  if (row.priority === input.priority) return present(tx, row.id);
  await tx
    .update(waitlistEntry)
    .set({ priority: input.priority, prioritySetAt: input.now, prioritySetBy: input.actor.userId })
    .where(eq(waitlistEntry.id, row.id));
  await audit(tx, {
    action: 'waitlist.priority.overridden',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'waitlist_entry',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { from: row.priority, to: input.priority },
  });
  return present(tx, row.id);
}

export async function getEntry(tx: Tx, id: string): Promise<WaitlistEntryDto> {
  return present(tx, id);
}

const SYSTEM_ACTOR: EntryActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

/**
 * Closes the entries whose time ran out, as `expired`, and keeps them (waitlist, "Entry expiry").
 * Returns how many it closed.
 */
export async function closeExpiredEntries(tx: Tx, input: { now: Date }): Promise<number> {
  const due = await tx
    .select()
    .from(waitlistEntry)
    .where(
      and(
        inArray(waitlistEntry.status, ['active', 'paused', 'offered']),
        sql`${waitlistEntry.expiresAt} <= ${input.now.toISOString()}::timestamptz`,
      ),
    )
    .for('update');
  for (const row of due) {
    await closeEntryRow(tx, row, { reason: 'expired', actor: SYSTEM_ACTOR, now: input.now });
  }
  return due.length;
}

/**
 * The patient asked to stop: every entry of theirs that is still in play closes as
 * `patient_opted_out` and its offer ends (waitlist, "Opt-out and consent in offers"). Returns how
 * many entries it closed.
 */
export async function closeEntriesOfOptedOutPatient(
  tx: Tx,
  input: { patientId: string; now: Date },
): Promise<number> {
  const rows = await tx
    .select()
    .from(waitlistEntry)
    .where(and(eq(waitlistEntry.patientId, input.patientId), IN_PLAY))
    .for('update');
  for (const row of rows) {
    await closeEntryRow(tx, row, {
      reason: 'patient_opted_out',
      actor: SYSTEM_ACTOR,
      now: input.now,
    });
  }
  return rows.length;
}
