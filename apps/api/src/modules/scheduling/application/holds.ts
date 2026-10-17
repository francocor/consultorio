import type { CreateHoldRequest, HoldDto } from '@consultorio/contracts';

import { AppError } from '../../../platform/http/problem.js';

import {
  applyPlan,
  assertCalendar,
  invalid,
  planSlot,
  resolveStart,
  typeOffered,
  type BookActor,
  type PlanInput,
} from './placement.js';
import type { HoldRecord, LocationRecord, SchedulingPorts } from './ports.js';

export { SlotNoLongerAvailableError } from './placement.js';

/** How long a hold keeps a range before it runs out (scheduling, "Slot holds"). */
export const HOLD_MINUTES = 10;

function toDto(record: HoldRecord): HoldDto {
  return {
    id: record.id,
    professionalId: record.professionalId,
    locationId: record.locationId,
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    status: record.status,
    origin: record.origin,
  };
}

export interface CreateHoldInput {
  request: CreateHoldRequest;
  actor: BookActor;
  now: Date;
  /** `staff` from the calendar now; `public` from the online booking in Stage 3. */
  origin: 'public' | 'staff';
  /** The user id (staff) or the hash of the anonymous booking session (public). */
  sourceKey: string;
  /** Holds one source may have at a time. Defaults to 1. */
  bound?: number;
  authorizeLocation?: (location: LocationRecord) => Promise<void>;
}

/**
 * Reserves a range for a professional for a short time while someone completes a booking. A hold
 * is not an appointment: no patient, no status among the eight, no history, no audit entry. While
 * active it occupies the range exactly like an appointment (capacity and buffer), under the same
 * row lock and the same hours, blocks and holiday rules; a public hold uses capacity 1 and never an
 * overbooked lane. A source has at most `bound` active holds: a new one releases the oldest.
 */
export async function createHold(ports: SchedulingPorts, input: CreateHoldInput): Promise<HoldDto> {
  const { request, actor, now } = input;
  const professional = await ports.lockProfessional(request.professionalId);
  const location = await ports.findLocation(request.locationId);
  const type = await ports.findType(request.appointmentTypeId);
  if (!professional || !location || !type) throw new AppError('not_found');
  if (professional.status !== 'active' || !location.active || !type.active) {
    throw new AppError('conflict');
  }
  assertCalendar(actor, professional.id);
  if (input.authorizeLocation) await input.authorizeLocation(location);
  if (!typeOffered(type, professional)) {
    throw invalid('appointmentTypeId', 'scheduling.booking.type_not_offered');
  }

  // The source's older hold goes first, so holding the same range again is not a conflict with
  // oneself. (If the new hold cannot be made, the whole transaction rolls back.)
  await ports.releaseOldestHolds(input.sourceKey, Math.max(0, (input.bound ?? 1) - 1));

  const planInput: PlanInput = {
    professional,
    location,
    durationMinutes: type.durationMinutes,
    bufferMinutes: type.bufferMinutes,
    startsAt: resolveStart(request, location),
    actor,
    now,
    checkPast: true,
    checkHours: true,
    capacityOne: input.origin === 'public',
  };
  const plan = await planSlot(ports, planInput);
  await applyPlan(ports, plan);

  const created = await ports.insertHold({
    professionalId: professional.id,
    locationId: location.id,
    startsAt: new Date(plan.range.start),
    endsAt: new Date(plan.range.end),
    bufferMinutes: type.bufferMinutes,
    lane: plan.lane,
    expiresAt: new Date(now.getTime() + HOLD_MINUTES * 60_000),
    origin: input.origin,
    sourceKey: input.sourceKey,
    createdBy: input.origin === 'staff' ? actor.userId : null,
  });
  return toDto(created);
}

export interface ReleaseHoldInput {
  holdId: string;
  sourceKey: string;
  now: Date;
}

/** The holder gives the range back. The hold ends as `released`. */
export async function releaseHold(
  ports: SchedulingPorts,
  input: ReleaseHoldInput,
): Promise<HoldDto> {
  const peek = await ports.findHold(input.holdId);
  // Another source's hold looks like one that does not exist.
  if (peek?.sourceKey !== input.sourceKey) throw new AppError('not_found');
  await ports.lockProfessional(peek.professionalId);
  await ports.expireHolds(peek.professionalId, input.now);
  const hold = await ports.findHold(input.holdId, { lock: true });
  if (hold?.sourceKey !== input.sourceKey) throw new AppError('not_found');
  if (hold.status !== 'active') throw new AppError('conflict');
  await ports.updateHold(hold.id, { status: 'released' });
  return toDto({ ...hold, status: 'released' });
}
