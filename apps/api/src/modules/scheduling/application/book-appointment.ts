import type { AppointmentDto, BookAppointmentRequest } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { assignLane, relane, type LaneMove } from '../domain/lanes.js';
import { chooseOccurrence, resolveLocal } from '../domain/time.js';
import type { TimeRange } from '../domain/working-hours.js';

import type {
  ActiveOccupancy,
  LaneMoveCommand,
  LocationRecord,
  ProfessionalRecord,
  SchedulingPorts,
  TypeRecord,
} from './ports.js';
import { freeSlots, scheduleFacts } from './schedule-facts.js';

/** Who books, as the use case needs to know: what they may do, never what they claim. */
export interface BookActor {
  userId: string;
  /** Effective permissions (role plus grants). */
  permissions: ReadonlySet<string>;
  /** The booking actor's own professional profile, when the gate lets them have one. */
  professionalId: string | null;
}

export interface BookInput {
  request: BookAppointmentRequest;
  actor: BookActor;
  auditActor: AuditActor;
  now: Date;
  /**
   * Called once the location is known to exist, so a location the actor may not operate is refused
   * as a denial, and one that does not exist (or belongs to another organization) as not found.
   */
  authorizeLocation?: (location: LocationRecord) => Promise<void>;
}

/**
 * The time is taken (another appointment, a hold, the capacity, or the professional is at another
 * location). It carries what the 409 answers with: the taken range, which is administrative data
 * only, and the next free times.
 */
export class SlotTakenError extends Error {
  constructor(
    readonly conflict: TimeRange,
    readonly nextSlots: TimeRange[],
  ) {
    super('slot_taken');
    this.name = 'SlotTakenError';
  }
}

export function invalid(path: string, i18nKey: string): AppError {
  return new AppError('validation_failed', [{ path, i18nKey }]);
}

/** How many local days ahead the "next free slots" of a conflict look, and how many they return. */
const NEXT_SLOTS_DAYS = 14;
const NEXT_SLOTS_LIMIT = 5;

type OverrideKind = 'past' | 'out_of_hours' | 'block' | 'holiday' | 'hold';

/** A place for the appointment: its lane, and the lanes other occupancies must change to make room. */
interface Placement {
  lane: number;
  moves: LaneMove[];
}

function place(
  occupancies: readonly ActiveOccupancy[],
  range: TimeRange,
  locationId: string,
  capacity: number,
): Placement | null {
  // Never at two locations at once, whatever the capacity.
  if (occupancies.some((other) => other.locationId !== locationId)) return null;
  const lane = assignLane(occupancies, range, capacity);
  if (lane !== null) return { lane, moves: [] };
  const rearranged = relane(occupancies, range, capacity);
  return rearranged ? { lane: rearranged.lane, moves: rearranged.moves } : null;
}

function startOf(request: BookAppointmentRequest, location: LocationRecord): Date {
  if (request.startsAt !== undefined) return new Date(request.startsAt);
  const local = request.local;
  if (local === undefined) throw invalid('startsAt', 'scheduling.booking.start_required');
  const choice = chooseOccurrence(
    resolveLocal(location.timeZone, { date: local.date, time: local.time }),
    local.occurrence,
  );
  if (choice.ok) return choice.instant;
  throw choice.reason === 'nonexistent'
    ? invalid('local.time', 'scheduling.booking.local_time_nonexistent')
    : invalid('local.occurrence', 'scheduling.booking.local_time_ambiguous');
}

/** The professional offers this type (restricted by professional or specialty, or open to all). */
function offers(type: TypeRecord, professional: ProfessionalRecord): boolean {
  if (type.professionalIds.length > 0 && !type.professionalIds.includes(professional.id)) {
    return false;
  }
  return (
    type.specialties.length === 0 ||
    type.specialties.some((specialty) => professional.specialties.includes(specialty))
  );
}

async function conflictOf(
  ports: SchedulingPorts,
  context: {
    professional: ProfessionalRecord;
    location: LocationRecord;
    type: TypeRecord;
    range: TimeRange;
    occupied: TimeRange;
  },
): Promise<SlotTakenError> {
  const taken = (await ports.occupancies(context.professional.id, context.occupied))[0];
  const nextSlots = await freeSlots(ports, {
    professionalId: context.professional.id,
    maxSimultaneous: context.professional.maxSimultaneous,
    location: context.location,
    durationMinutes: context.type.durationMinutes,
    bufferMinutes: context.type.bufferMinutes,
    from: context.range.start,
    days: NEXT_SLOTS_DAYS,
    limit: NEXT_SLOTS_LIMIT,
  });
  return new SlotTakenError(
    taken ? { start: taken.start, end: taken.end } : context.range,
    nextSlots,
  );
}

/**
 * Books an appointment for an existing patient (scheduling, "Booking an appointment"). Everything
 * runs in the caller's transaction, after the row lock on the professional that serializes their
 * writes (design 4.6). The rules, in order:
 *
 * 1. the professional, location, type and patient exist in the organization (another
 *    organization's ids look like missing ones) and are active;
 * 2. the type is offered by the professional;
 * 3. a past start needs `scheduling.register_past`;
 * 4. working hours, blocks and holidays: rejected unless an authorized user overrides with a reason;
 * 5. capacity: the lowest free lane, re-laning when capacity allows it, never two locations at
 *    once, and an active hold only gives way to an explicit override;
 * 6. the insert; if the database still refuses an overlap (a race that slipped through), the same
 *    conflict answer is produced.
 */
export async function bookAppointment(
  ports: SchedulingPorts,
  input: BookInput,
): Promise<AppointmentDto> {
  const { request, actor, now } = input;

  const professional = await ports.lockProfessional(request.professionalId);
  // One after the other: a transaction has one connection, and it runs one query at a time.
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
  if (input.authorizeLocation) await input.authorizeLocation(location);
  if (!offers(type, professional)) {
    throw invalid('appointmentTypeId', 'scheduling.booking.type_not_offered');
  }

  const startsAt = startOf(request, location);
  const range: TimeRange = {
    start: startsAt.getTime(),
    end: startsAt.getTime() + type.durationMinutes * 60_000,
  };
  const occupied: TimeRange = { start: range.start, end: range.end + type.bufferMinutes * 60_000 };
  const overrides: OverrideKind[] = [];

  if (range.start < now.getTime()) {
    if (!actor.permissions.has('scheduling.register_past')) {
      throw invalid('startsAt', 'scheduling.booking.in_past');
    }
    overrides.push('past');
  }

  const facts = await scheduleFacts(ports, { professionalId: professional.id, location, range });
  const violations: { kind: OverrideKind; key: string }[] = [
    ...(facts.holiday ? [{ kind: 'holiday' as const, key: 'scheduling.booking.holiday' }] : []),
    ...(facts.blocked ? [{ kind: 'block' as const, key: 'scheduling.booking.blocked' }] : []),
    ...(!facts.insideHours
      ? [{ kind: 'out_of_hours' as const, key: 'scheduling.booking.outside_working_hours' }]
      : []),
  ];
  let outOfHours = false;
  let overrideReason: string | null = null;
  const [firstViolation] = violations;
  if (firstViolation) {
    if (request.overrideHours === undefined) throw invalid('startsAt', firstViolation.key);
    if (!actor.permissions.has('scheduling.override_hours')) {
      throw new AccessRefused('override_hours_not_permitted');
    }
    outOfHours = true;
    overrideReason = request.overrideHours.reason;
    overrides.push(...violations.map((violation) => violation.kind));
  }

  // Holds that ran out stop counting; then look at what is really occupied.
  await ports.expireHolds(professional.id, now);
  const occupancies = await ports.occupancies(professional.id, occupied);
  let placement = place(occupancies, occupied, location.id, professional.maxSimultaneous);
  let invalidatedHolds: string[] = [];
  if (placement === null && request.overrideHold === true) {
    const holds = occupancies.filter((other) => other.kind === 'hold');
    const withoutHolds = occupancies.filter((other) => other.kind !== 'hold');
    placement =
      holds.length > 0
        ? place(withoutHolds, occupied, location.id, professional.maxSimultaneous)
        : null;
    if (placement !== null) {
      invalidatedHolds = holds.map((hold) => hold.id);
      overrides.push('hold');
    }
  }
  const conflictContext = { professional, location, type, range, occupied };
  if (placement === null) throw await conflictOf(ports, conflictContext);

  if (invalidatedHolds.length > 0) await ports.invalidateHolds(invalidatedHolds);
  if (placement.moves.length > 0) {
    const moves: LaneMoveCommand[] = placement.moves.map((move) => ({
      kind: occupancies.find((other) => other.id === move.id)?.kind ?? 'appointment',
      id: move.id,
      lane: move.lane,
    }));
    await ports.applyLaneMoves(moves);
  }

  const inserted = await ports.insertAppointment({
    patientId: patient.id,
    professionalId: professional.id,
    locationId: location.id,
    appointmentTypeId: type.id,
    startsAt,
    endsAt: new Date(range.end),
    bufferMinutes: type.bufferMinutes,
    lane: placement.lane,
    status: 'scheduled',
    source: 'staff',
    bookedBy: actor.userId,
    identityConfirmed: true,
    outOfHours,
    overrideReason,
  });
  if (!inserted.ok) throw await conflictOf(ports, conflictContext);
  const { appointment } = inserted;

  await ports.insertEvent({
    appointmentId: appointment.id,
    kind: 'created',
    toStatus: appointment.status,
    actorUserId: actor.userId,
    actorKind: 'staff',
    details: overrides.length > 0 ? { overrides } : {},
  });
  await ports.audit({
    action: 'appointment.created',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: 'appointment',
    resourceId: appointment.id,
    patientId: patient.id,
    metadata: {
      professionalId: professional.id,
      locationId: location.id,
      startsAt: appointment.startsAt,
    },
  });
  if (overrides.length > 0) {
    await ports.audit({
      action: 'appointment.overridden',
      outcome: 'allow',
      actor: input.auditActor,
      resourceType: 'appointment',
      resourceId: appointment.id,
      patientId: patient.id,
      metadata: {
        kinds: overrides,
        ...(overrideReason === null ? {} : { overrideReason }),
      },
    });
  }
  return appointment;
}
