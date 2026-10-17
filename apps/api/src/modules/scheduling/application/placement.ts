import type { LocalStart, OverrideHours } from '@consultorio/contracts';

import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { assignLane, overlaps, relane, type LaneMove } from '../domain/lanes.js';
import { chooseOccurrence, resolveLocal } from '../domain/time.js';
import type { TimeRange } from '../domain/working-hours.js';

import { isExclusionViolation } from './db-errors.js';
import type {
  ActiveOccupancy,
  LaneMoveCommand,
  LocationRecord,
  ProfessionalRecord,
  SchedulingPorts,
  TypeRecord,
} from './ports.js';
import { freeSlots, scheduleFacts } from './schedule-facts.js';

/** Who acts, as the use cases need to know: what they may do, never what they claim. */
export interface BookActor {
  userId: string;
  /** Effective permissions (role plus grants). */
  permissions: ReadonlySet<string>;
  /** The actor's own professional profile, when the gate lets them have one. */
  professionalId: string | null;
  /**
   * Whether the actor may work in this professional's calendar (a professional works in their own,
   * or in one that was delegated). Absent means every calendar, as for tests.
   */
  mayUseCalendar?: (professionalId: string) => boolean;
  /**
   * Whether the actor may operate this location in this professional's calendar (reception works at
   * its assigned locations, except in its own calendar when it is also a professional). Absent
   * means any.
   */
  mayUseLocation?: (locationId: string, professionalId: string) => boolean;
}

/**
 * Called once the location is known to exist, with the professional whose calendar is worked in, so
 * a location the actor may not operate there is refused as a denial.
 */
export type LocationAuthorizer = (
  location: LocationRecord,
  professionalId: string,
) => Promise<void>;

/** Refuses a calendar the actor was not given. The reason goes to the audit trail only. */
export function assertCalendar(actor: BookActor, professionalId: string): void {
  if (actor.mayUseCalendar && !actor.mayUseCalendar(professionalId)) {
    throw new AccessRefused('not_own_calendar');
  }
}

/** Refuses a location the actor does not work at, for the calendar of this professional. */
export function assertLocation(actor: BookActor, locationId: string, professionalId: string): void {
  if (actor.mayUseLocation && !actor.mayUseLocation(locationId, professionalId)) {
    throw new AccessRefused('location_not_assigned');
  }
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

/**
 * The hold a booking tried to finish is gone: it ran out, its holder released it, it was already
 * converted, or staff booked over it with an override. The holder is told the slot is no longer
 * available (a 409 `slot_no_longer_available`).
 */
export class SlotNoLongerAvailableError extends Error {
  constructor() {
    super('slot_no_longer_available');
    this.name = 'SlotNoLongerAvailableError';
  }
}

/** The professional offers this type (restricted by professional or specialty, or open to all). */
export function typeOffered(type: TypeRecord, professional: ProfessionalRecord): boolean {
  if (type.professionalIds.length > 0 && !type.professionalIds.includes(professional.id)) {
    return false;
  }
  return (
    type.specialties.length === 0 ||
    type.specialties.some((specialty) => professional.specialties.includes(specialty))
  );
}

export function invalid(path: string, i18nKey: string): AppError {
  return new AppError('validation_failed', [{ path, i18nKey }]);
}

/** How many local days ahead the "next free slots" of a conflict look, and how many they return. */
const NEXT_SLOTS_DAYS = 14;
const NEXT_SLOTS_LIMIT = 5;

export type OverrideKind = 'past' | 'out_of_hours' | 'block' | 'holiday' | 'hold';

/** The instant a request means: an instant as sent, or a local time read in the location's zone. */
export function resolveStart(
  start: { startsAt?: string | undefined; local?: LocalStart | undefined },
  location: LocationRecord,
): Date {
  if (start.startsAt !== undefined) return new Date(start.startsAt);
  const local = start.local;
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

interface Placement {
  lane: number;
  moves: LaneMove[];
}

/**
 * The lowest free lane, re-laning when capacity allows it. Never two locations at once. With
 * `capacityOne` (public flows) the professional's capacity does not matter: ANY overlapping
 * occupancy refuses the range and the lane is always 1.
 *
 * `occupancies` are the ones that overlap the range. Re-laning may have to move occupancies that
 * only touch those (a chain of overlaps), so `connected` is the whole chain around the range; it
 * defaults to `occupancies`, which is right whenever nothing can be moved.
 */
export function place(
  occupancies: readonly ActiveOccupancy[],
  range: TimeRange,
  locationId: string,
  capacity: number,
  capacityOne = false,
  connected: readonly ActiveOccupancy[] = occupancies,
): Placement | null {
  if (occupancies.some((other) => other.locationId !== locationId)) return null;
  if (capacityOne) {
    return occupancies.some((other) => overlaps(other, range)) ? null : { lane: 1, moves: [] };
  }
  const lane = assignLane(occupancies, range, capacity);
  if (lane !== null) return { lane, moves: [] };
  const rearranged = relane(connected, range, capacity);
  return rearranged ? { lane: rearranged.lane, moves: rearranged.moves } : null;
}

export interface PlanInput {
  professional: ProfessionalRecord;
  location: LocationRecord;
  durationMinutes: number;
  bufferMinutes: number;
  startsAt: Date;
  actor: BookActor;
  now: Date;
  overrideHours?: OverrideHours | undefined;
  overrideHold?: boolean | undefined;
  /** An appointment whose own occupancy must not count (it is the one being moved or corrected). */
  ignoreAppointmentId?: string;
  /** A hold whose own occupancy must not count (it is the one being converted). */
  ignoreHoldId?: string;
  /**
   * Public flows (online booking, waitlist offers) use capacity 1 and never an overbooked lane:
   * any active occupancy that overlaps the range refuses it, whatever the professional allows.
   */
  capacityOne?: boolean;
  /** Check a start in the past (a booking), or leave it alone (a correction of the past). */
  checkPast: boolean;
  /** Check hours, blocks and holidays (a booking or a move), or only capacity (a correction). */
  checkHours: boolean;
}

export interface Plan {
  range: TimeRange;
  occupied: TimeRange;
  lane: number;
  moves: LaneMoveCommand[];
  invalidatedHolds: string[];
  overrides: OverrideKind[];
  outOfHours: boolean;
  overrideReason: string | null;
}

/**
 * The professional's occupancies that are connected to `range` through overlaps: the ones that
 * overlap it, the ones that overlap those, and so on. Re-laning needs the whole chain, because
 * moving one occupancy to another lane can collide with the next one in that lane.
 */
async function occupanciesAround(
  ports: SchedulingPorts,
  professionalId: string,
  range: TimeRange,
  ignore: (occupancy: ActiveOccupancy) => boolean,
): Promise<ActiveOccupancy[]> {
  let window = range;
  for (;;) {
    const found = (await ports.occupancies(professionalId, window)).filter(
      (other) => !ignore(other),
    );
    const reach: TimeRange = {
      start: Math.min(window.start, ...found.map((other) => other.start)),
      end: Math.max(window.end, ...found.map((other) => other.end)),
    };
    if (reach.start === window.start && reach.end === window.end) return found;
    window = reach;
  }
}

async function conflictOf(
  ports: SchedulingPorts,
  input: PlanInput,
  range: TimeRange,
  occupied: TimeRange,
): Promise<SlotTakenError> {
  const taken = (await ports.occupancies(input.professional.id, occupied)).find(
    (other) => other.id !== input.ignoreAppointmentId && other.id !== input.ignoreHoldId,
  );
  const nextSlots = await freeSlots(ports, {
    professionalId: input.professional.id,
    maxSimultaneous: input.professional.maxSimultaneous,
    location: input.location,
    durationMinutes: input.durationMinutes,
    bufferMinutes: input.bufferMinutes,
    from: range.start,
    days: NEXT_SLOTS_DAYS,
    limit: NEXT_SLOTS_LIMIT,
  });
  return new SlotTakenError(taken ? { start: taken.start, end: taken.end } : range, nextSlots);
}

/**
 * Decides whether a range can be given to a professional and where: the rules every booking, move,
 * correction and series occurrence share. It reads and refuses; it writes nothing (`applyPlan`
 * does), so a dry run can use it. Call it under the professional's row lock.
 *
 * 1. A start in the past needs `scheduling.register_past`.
 * 2. Working hours, blocks and holidays: refused unless an authorized user overrides with a reason.
 * 3. Capacity: the lowest free lane, re-laning when capacity allows it, never two locations at
 *    once, and an active hold only gives way to an explicit override.
 */
export async function planSlot(ports: SchedulingPorts, input: PlanInput): Promise<Plan> {
  const range: TimeRange = {
    start: input.startsAt.getTime(),
    end: input.startsAt.getTime() + input.durationMinutes * 60_000,
  };
  const occupied: TimeRange = { start: range.start, end: range.end + input.bufferMinutes * 60_000 };
  const overrides: OverrideKind[] = [];

  if (input.checkPast && range.start < input.now.getTime()) {
    if (!input.actor.permissions.has('scheduling.register_past')) {
      throw invalid('startsAt', 'scheduling.booking.in_past');
    }
    overrides.push('past');
  }

  let outOfHours = false;
  let overrideReason: string | null = null;
  if (input.checkHours) {
    const facts = await scheduleFacts(ports, {
      professionalId: input.professional.id,
      location: input.location,
      range,
    });
    const violations: { kind: OverrideKind; key: string }[] = [
      ...(facts.holiday ? [{ kind: 'holiday' as const, key: 'scheduling.booking.holiday' }] : []),
      ...(facts.blocked ? [{ kind: 'block' as const, key: 'scheduling.booking.blocked' }] : []),
      ...(!facts.insideHours
        ? [{ kind: 'out_of_hours' as const, key: 'scheduling.booking.outside_working_hours' }]
        : []),
    ];
    const [first] = violations;
    if (first) {
      if (input.overrideHours === undefined) throw invalid('startsAt', first.key);
      if (!input.actor.permissions.has('scheduling.override_hours')) {
        throw new AccessRefused('override_hours_not_permitted');
      }
      outOfHours = true;
      overrideReason = input.overrideHours.reason;
      overrides.push(...violations.map((violation) => violation.kind));
    }
  }

  // Holds that ran out stop counting; then look at what is really occupied.
  await ports.expireHolds(input.professional.id, input.now);
  const ignored = (other: ActiveOccupancy) =>
    other.id === input.ignoreAppointmentId || other.id === input.ignoreHoldId;
  const capacity = input.professional.maxSimultaneous;
  const capacityOne = input.capacityOne === true;
  // Only an overbooking professional can have anything to re-lane, and then it needs the whole chain.
  const connected =
    capacity > 1 && !capacityOne
      ? await occupanciesAround(ports, input.professional.id, occupied, ignored)
      : (await ports.occupancies(input.professional.id, occupied)).filter(
          (other) => !ignored(other),
        );
  const occupancies = connected.filter((other) => overlaps(other, occupied));
  let placement = place(occupancies, occupied, input.location.id, capacity, capacityOne, connected);
  let invalidatedHolds: string[] = [];
  let basis = connected;
  if (placement === null && input.overrideHold === true) {
    const holds = occupancies.filter((other) => other.kind === 'hold');
    // Taking a slot from somebody who is completing a booking is for those who were given the right.
    if (holds.length > 0 && !input.actor.permissions.has('scheduling.override_hold')) {
      throw new AccessRefused('override_hold_not_permitted');
    }
    const gone = new Set(holds.map((hold) => hold.id));
    basis = connected.filter((other) => !gone.has(other.id));
    placement =
      holds.length > 0
        ? place(
            occupancies.filter((other) => !gone.has(other.id)),
            occupied,
            input.location.id,
            capacity,
            capacityOne,
            basis,
          )
        : null;
    if (placement !== null) {
      invalidatedHolds = holds.map((hold) => hold.id);
      overrides.push('hold');
    } else {
      basis = connected;
    }
  }
  if (placement === null) throw await conflictOf(ports, input, range, occupied);

  const moves: LaneMoveCommand[] = placement.moves.map((move) => ({
    kind: basis.find((other) => other.id === move.id)?.kind ?? 'appointment',
    id: move.id,
    lane: move.lane,
  }));
  return {
    range,
    occupied,
    lane: placement.lane,
    moves,
    invalidatedHolds,
    overrides,
    outOfHours,
    overrideReason,
  };
}

/**
 * Runs a write that follows a plan. An overlap the database still refuses (a race that slipped
 * through the row lock and the checks) becomes the same conflict answer as any other, with the
 * taken range and the next free times. The ports run each such write in a savepoint, so the
 * transaction can still read the free slots after the refusal.
 */
export async function guardRace<T>(
  ports: SchedulingPorts,
  input: PlanInput,
  plan: Plan,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isExclusionViolation(error)) throw await conflictAfterRace(ports, input, plan);
    throw error;
  }
}

/** Makes the plan real: invalidates the holds it gives way over and moves the lanes it re-lanes. */
export function applyPlan(ports: SchedulingPorts, input: PlanInput, plan: Plan): Promise<void> {
  return guardRace(ports, input, plan, async () => {
    if (plan.invalidatedHolds.length > 0) await ports.invalidateHolds(plan.invalidatedHolds);
    if (plan.moves.length > 0) await ports.applyLaneMoves(plan.moves);
  });
}

/** The conflict answer for an overlap the database caught after the checks passed (a race). */
export function conflictAfterRace(
  ports: SchedulingPorts,
  input: PlanInput,
  plan: Plan,
): Promise<SlotTakenError> {
  return conflictOf(ports, input, plan.range, plan.occupied);
}

/**
 * For public flows (online booking, reschedule links, waitlist offers): refuses the range when ANY
 * active occupancy overlaps it, whatever the professional's capacity, and takes lane 1. The lanes
 * above 1 stay reachable only to staff (design 4.6).
 */
export function requireNoActiveOverlap(
  ports: SchedulingPorts,
  input: Omit<PlanInput, 'capacityOne'>,
): Promise<Plan> {
  return planSlot(ports, { ...input, capacityOne: true });
}
