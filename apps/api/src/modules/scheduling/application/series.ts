import { randomUUID } from 'node:crypto';

import {
  SERIES_MAX_OCCURRENCES,
  type AppointmentDto,
  type BookSeriesRequest,
  type SeriesConflictReason,
  type SeriesOccurrenceDto,
} from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import { AppError } from '../../../platform/http/problem.js';
import { chooseOccurrence, localParts, resolveLocal } from '../domain/time.js';

import { persistAppointment } from './book-appointment.js';
import {
  applyPlan,
  assertCalendar,
  invalid,
  planSlot,
  resolveStart,
  SlotTakenError,
  typeOffered,
  type BookActor,
  type Plan,
  type PlanInput,
} from './placement.js';
import type { LocationRecord, SchedulingPorts } from './ports.js';

const DAY_MS = 86_400_000;

/** A commit was refused because sessions that were not skipped conflict. Nothing was created. */
export class SeriesConflictError extends Error {
  constructor(readonly occurrences: SeriesOccurrenceDto[]) {
    super('series_conflict');
    this.name = 'SeriesConflictError';
  }
}

export type SeriesResult =
  | { mode: 'dry_run'; occurrences: SeriesOccurrenceDto[]; canCommit: boolean }
  | { mode: 'commit'; seriesId: string; appointments: AppointmentDto[]; skipped: number[] };

export interface SeriesInput {
  request: BookSeriesRequest;
  actor: BookActor;
  auditActor: AuditActor & { userId: string };
  now: Date;
  authorizeLocation?: (location: LocationRecord) => Promise<void>;
}

const REASON_BY_KEY: Record<string, SeriesConflictReason> = {
  'scheduling.booking.in_past': 'in_past',
  'scheduling.booking.outside_working_hours': 'outside_working_hours',
  'scheduling.booking.blocked': 'blocked',
  'scheduling.booking.holiday': 'holiday',
};

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

interface Session {
  index: number;
  startsAt: Date | null;
  reason: SeriesConflictReason | null;
}

/**
 * The sessions of a series. Each one is the same LOCAL time as the first, so a clock change moves
 * the instant and not the hour on the wall. A session whose local time does not exist that day
 * (the skipped hour) or exists twice (the repeated hour) cannot be booked unattended: it is
 * reported so the user skips it or books it by hand.
 */
function sessionsOf(request: BookSeriesRequest, zone: string, first: Date): Session[] {
  const start = localParts(zone, first);
  const time = `${String(Math.floor(start.minuteOfDay / 60)).padStart(2, '0')}:${String(start.minuteOfDay % 60).padStart(2, '0')}`;
  const sessions: Session[] = [];
  const { recurrence } = request;
  const limit = Math.min(recurrence.count ?? SERIES_MAX_OCCURRENCES, SERIES_MAX_OCCURRENCES);
  for (let index = 1; index <= limit; index += 1) {
    const date = addDays(start.date, 7 * recurrence.everyWeeks * (index - 1));
    if (recurrence.until !== undefined && date > recurrence.until) break;
    if (index === 1) {
      sessions.push({ index, startsAt: first, reason: null });
      continue;
    }
    const resolution = resolveLocal(zone, { date, time });
    const choice = chooseOccurrence(resolution);
    sessions.push(
      choice.ok
        ? { index, startsAt: choice.instant, reason: null }
        : {
            index,
            startsAt: null,
            reason:
              choice.reason === 'nonexistent' ? 'local_time_nonexistent' : 'local_time_ambiguous',
          },
    );
  }
  return sessions;
}

/**
 * Books (or previews) a series of appointments (scheduling, "Recurring appointments"). Every
 * session is validated on its own with the rules of a single booking. A dry run reports which
 * sessions conflict and why and creates nothing; a commit creates all the sessions that are not
 * skipped, in one transaction, and creates nothing at all if any of them conflicts. Each session is
 * an ordinary appointment afterwards: it can be moved or cancelled without touching the others.
 */
export async function bookSeries(
  ports: SchedulingPorts,
  input: SeriesInput,
): Promise<SeriesResult> {
  const { request, actor, now } = input;

  const professional = await ports.lockProfessional(request.professionalId);
  const location = await ports.findLocation(request.locationId);
  const type = await ports.findType(request.appointmentTypeId);
  const patient = await ports.findPatient(request.patientId);
  if (!professional || !location || !type || !patient) throw new AppError('not_found');
  if (
    professional.status !== 'active' ||
    !location.active ||
    !type.active ||
    patient.status !== 'active'
  ) {
    throw new AppError('conflict');
  }
  assertCalendar(actor, professional.id);
  if (input.authorizeLocation) await input.authorizeLocation(location);
  if (!typeOffered(type, professional)) {
    throw invalid('appointmentTypeId', 'scheduling.booking.type_not_offered');
  }

  const first = resolveStart(request, location);
  const sessions = sessionsOf(request, location.timeZone, first);
  const skip = new Set(request.skip);

  const planned = new Map<number, { plan: Plan; planInput: PlanInput }>();
  const occurrences: SeriesOccurrenceDto[] = [];
  for (const session of sessions) {
    const base = { index: session.index, reason: null as SeriesConflictReason | null };
    if (skip.has(session.index)) {
      occurrences.push({
        ...base,
        startsAt: session.startsAt?.toISOString() ?? null,
        endsAt: session.startsAt
          ? new Date(session.startsAt.getTime() + type.durationMinutes * 60_000).toISOString()
          : null,
        status: 'skipped',
      });
      continue;
    }
    if (session.startsAt === null) {
      occurrences.push({
        ...base,
        startsAt: null,
        endsAt: null,
        status: 'conflict',
        reason: session.reason,
      });
      continue;
    }
    const planInput: PlanInput = {
      professional,
      location,
      durationMinutes: type.durationMinutes,
      bufferMinutes: type.bufferMinutes,
      startsAt: session.startsAt,
      actor,
      now,
      overrideHours: request.overrideHours,
      checkPast: true,
      checkHours: true,
    };
    const startsAt = session.startsAt.toISOString();
    const endsAt = new Date(
      session.startsAt.getTime() + type.durationMinutes * 60_000,
    ).toISOString();
    try {
      const plan = await planSlot(ports, planInput);
      planned.set(session.index, { plan, planInput });
      occurrences.push({ ...base, startsAt, endsAt, status: 'ok' });
    } catch (error) {
      // Only the refusals of this one session are reported; anything else is a real failure.
      const key = error instanceof AppError ? error.fieldErrors[0]?.i18nKey : undefined;
      const reason: SeriesConflictReason | null =
        error instanceof SlotTakenError
          ? 'slot_taken'
          : ((key ? REASON_BY_KEY[key] : undefined) ?? null);
      if (reason === null) throw error;
      occurrences.push({ ...base, startsAt, endsAt, status: 'conflict', reason });
    }
  }

  const conflicts = occurrences.some((occurrence) => occurrence.status === 'conflict');
  if (request.mode === 'dry_run') {
    return { mode: 'dry_run', occurrences, canCommit: !conflicts };
  }
  if (conflicts) throw new SeriesConflictError(occurrences);
  if (planned.size === 0) throw invalid('skip', 'scheduling.series.nothing_to_create');

  const seriesId = randomUUID();
  const appointments: AppointmentDto[] = [];
  for (const occurrence of occurrences) {
    const entry = planned.get(occurrence.index);
    if (occurrence.status !== 'ok' || !entry) continue;
    await applyPlan(ports, entry.plan);
    appointments.push(
      await persistAppointment(ports, {
        professional,
        location,
        type,
        patient,
        actor,
        auditActor: input.auditActor,
        now,
        plan: entry.plan,
        planInput: entry.planInput,
        series: { seriesId, index: occurrence.index },
      }),
    );
  }
  const skipped = occurrences.filter((o) => o.status === 'skipped').map((o) => o.index);
  return { mode: 'commit', seriesId, appointments, skipped };
}
