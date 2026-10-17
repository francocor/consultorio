import type { AppointmentDto, BookAppointmentRequest } from '@consultorio/contracts';
import { asc, eq, inArray, sql } from 'drizzle-orm';

import {
  bookAppointment,
  SlotNoLongerAvailableError,
  SlotTakenError,
} from '../../../../modules/scheduling/application/book-appointment.js';
import { createSchedulingPorts } from '../../../../modules/scheduling/application/drizzle-ports.js';
import { createHolidayService } from '../../../../modules/scheduling/application/holidays.js';
import type { BookActor } from '../../../../modules/scheduling/application/placement.js';
import type { SchedulingPorts } from '../../../../modules/scheduling/application/ports.js';
import { instantAtLocalMinute, localParts } from '../../../../modules/scheduling/domain/time.js';
import type { AuditActor } from '../../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID, type Tx } from '../../../../platform/db/tenant-context.js';
import { AppError } from '../../../../platform/http/problem.js';
import type { JobClient } from '../../../../platform/jobs/boss.js';
import { patient } from '../../../schema/patients.js';
import { professionalHours } from '../../../schema/staff.js';
import { location } from '../../../schema/tenant.js';
import type { DemoContributorContext } from '../contributors.js';

/**
 * Pieces the Stage 3 demo seeds share. Nothing here talks to the outside world: a demonstration
 * organization never sends a message, and the seed puts nothing on a queue (`noJobs`), so no
 * reminder, code or offer leaves the process because of it.
 */

export type Stage3Context = DemoContributorContext;

/** The queue of a seed: it accepts everything and runs nothing. */
export const noJobs: JobClient = { enqueue: () => Promise.resolve(null) };

/** The zone of the organization's main city: "today" and the weeks are read in it. */
const HOME_ZONE = 'America/Argentina/Buenos_Aires';
const DAY_MS = 86_400_000;

export const TOOLS = [
  'scheduling.book',
  'scheduling.checkin',
  'scheduling.register_past',
  'scheduling.override_hours',
] as const;

export function systemOf(tenantId: string) {
  return { tenantId, userId: SYSTEM_USER_ID };
}

export function anonymous(): AuditActor {
  return { userId: null, actingRole: null, ip: null, userAgent: 'demo-seed', requestId: null };
}

export function actorOf(userId: string, role: AuditActor['actingRole']) {
  return { userId, actingRole: role, ip: null, userAgent: 'demo-seed', requestId: null };
}

export function bookerOf(userId: string, professionalId: string | null = null): BookActor {
  return { userId, permissions: new Set(TOOLS), professionalId };
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The Monday of the week that holds `now`, read in the main city. */
export function mondayOf(now: Date): string {
  const today = localParts(HOME_ZONE, now).date;
  return addDays(today, -(weekdayOf(today) - 1));
}

export interface FreeSlot {
  locationId: string;
  timeZone: string;
  date: string;
  startMinute: number;
  startsAt: Date;
}

/**
 * The times at which a professional works, from the third week ahead on: the agenda of the demo
 * only fills the weeks around today, so these are free. One candidate per working block and week,
 * in order, so two seeds of the same day pick the same times. Days the calendar marks as closed (a
 * national holiday, a day off of the organization) are left out: nothing can be booked on them, so
 * a seed that chose one would silently build nothing. `taken` keeps the callers from choosing one
 * time twice.
 */
export async function candidateSlots(
  tx: Tx,
  input: {
    professionalId: string;
    now: Date;
    taken: Set<string>;
    /** How many candidates to return at most. */
    count: number;
    /** Where to start in the working blocks of the professional, so two callers do not collide. */
    firstWeek?: number;
  },
): Promise<FreeSlot[]> {
  const blocks = await tx
    .select({
      locationId: professionalHours.locationId,
      timeZone: location.timeZone,
      weekday: professionalHours.weekday,
      startMinute: professionalHours.startMinute,
      endMinute: professionalHours.endMinute,
    })
    .from(professionalHours)
    .innerJoin(location, eq(location.id, professionalHours.locationId))
    .where(eq(professionalHours.professionalId, input.professionalId))
    .orderBy(
      asc(professionalHours.weekday),
      asc(professionalHours.startMinute),
      asc(professionalHours.locationId),
    );
  const monday = mondayOf(input.now);
  const closed = await createHolidayService().holidaysBetween(tx, monday, addDays(monday, 14 * 7));
  const isClosed = (date: string, locationId: string) =>
    closed.some(
      (holiday) =>
        holiday.day === date && (!holiday.locationId || holiday.locationId === locationId),
    );
  const found: FreeSlot[] = [];
  for (let week = input.firstWeek ?? 3; week < 14 && found.length < input.count; week += 1) {
    for (const block of blocks) {
      // The second hour of the block: away from the edge, where a lead time or a buffer may bite.
      const startMinute = block.startMinute + 60;
      if (startMinute + 60 > block.endMinute) continue;
      const date = addDays(monday, week * 7 + block.weekday - 1);
      if (isClosed(date, block.locationId)) continue;
      const startsAt = instantAtLocalMinute(block.timeZone, date, startMinute);
      const key = `${input.professionalId}|${String(startsAt.getTime())}`;
      if (input.taken.has(key)) continue;
      found.push({
        locationId: block.locationId,
        timeZone: block.timeZone,
        date,
        startMinute,
        startsAt,
      });
      if (found.length >= input.count) break;
    }
  }
  return found;
}

export function claim(taken: Set<string>, professionalId: string, slot: FreeSlot): void {
  taken.add(`${professionalId}|${String(slot.startsAt.getTime())}`);
}

export interface BookFirstFreeInput {
  keys: TenantKeys;
  now: Date;
  patientId: string;
  professionalId: string;
  appointmentTypeId: string;
  candidates: readonly FreeSlot[];
  actor: BookActor;
  auditActor: AuditActor;
  /** Changes how the appointment is written (an online booking is not a staff one). */
  through?: (ports: SchedulingPorts) => SchedulingPorts;
}

/**
 * Books the first candidate time the rules accept (a holiday, a block or a changed hour makes the
 * next one the choice). Each try is a savepoint, so a refusal leaves nothing behind.
 */
export async function bookFirstFree(
  tx: Tx,
  input: BookFirstFreeInput,
): Promise<{ appointment: AppointmentDto; slot: FreeSlot }> {
  for (const slot of input.candidates) {
    const request: BookAppointmentRequest = {
      patientId: input.patientId,
      professionalId: input.professionalId,
      locationId: slot.locationId,
      appointmentTypeId: input.appointmentTypeId,
      startsAt: slot.startsAt.toISOString(),
    };
    try {
      const appointment = await tx.transaction(async (inner) => {
        const base = createSchedulingPorts(inner, { keys: input.keys });
        return bookAppointment(input.through ? input.through(base) : base, {
          request,
          actor: input.actor,
          auditActor: input.auditActor,
          // Booked a couple of days ahead of the visit, never backdated.
          now: input.now,
        });
      });
      return { appointment, slot };
    } catch (error) {
      // A refusal of the booking rules means "not this time"; anything else is a bug to surface.
      if (
        error instanceof AppError ||
        error instanceof SlotNoLongerAvailableError ||
        error instanceof SlotTakenError
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('The demo seed found no free time to book.');
}

/** The adult patients with an email address and a phone, in a stable order. */
export function reachablePatients(tx: Tx, limit: number) {
  return tx
    .select({
      id: patient.id,
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      email: patient.email,
      phone: patient.phone,
    })
    .from(patient)
    .where(sql`${patient.email} is not null and ${patient.phone} is not null`)
    .orderBy(asc(patient.familyName), asc(patient.givenNames))
    .limit(limit);
}

export async function locationIdsByName(tx: Tx, names: readonly string[]) {
  const rows = await tx
    .select({ id: location.id, name: location.name })
    .from(location)
    .where(inArray(location.name, [...names]));
  return new Map(rows.map((row) => [row.name, row.id]));
}
