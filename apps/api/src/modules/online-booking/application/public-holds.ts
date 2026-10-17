import { createHash } from 'node:crypto';

import type { OnlineBookingSettings, PublicHoldDto } from '@consultorio/contracts';
import { and, eq, gte, lt, ne, sql } from 'drizzle-orm';

import { publicHold } from '../../../db/schema/online-booking.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { location } from '../../../db/schema/tenant.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { createHold, SlotNoLongerAvailableError } from '../../scheduling/index.js';
import type { BookActor, SchedulingPorts } from '../../scheduling/index.js';
import { dailyCapReached, filterBookableSlots, localDateOf } from '../domain/booking-rules.js';

import type { ProfessionalOffer } from './public-offer.js';

/**
 * Nobody is signed in on the public pages: holds are made as the system, with no permission and no
 * calendar of their own. The visitor is identified only by their anonymous booking session.
 */
export const PUBLIC_ACTOR: BookActor = {
  userId: SYSTEM_USER_ID,
  permissions: new Set<string>(),
  professionalId: null,
};

/** The key a hold carries for the anonymous session that made it. The cookie itself is never stored. */
export function sourceKeyOf(sessionId: string): string {
  return `public:${createHash('sha256').update(sessionId).digest('hex')}`;
}

export interface PublicHoldInput {
  offer: ProfessionalOffer;
  request: { locationId: string; appointmentTypeId: string; startsAt: string };
  settings: OnlineBookingSettings;
  now: Date;
  sourceKey: string;
  ports: SchedulingPorts;
}

/**
 * Online bookings the professional already has on the local day of `startsAt` (a cancelled one
 * gives its place back).
 */
export async function onlineBookingsOnDay(
  tx: Tx,
  input: { professionalId: string; startsAt: Date; timeZone: string },
): Promise<number> {
  const day = localDateOf(input.timeZone, input.startsAt);
  const rows = await tx
    .select({ startsAt: appointment.startsAt, timeZone: location.timeZone })
    .from(appointment)
    .innerJoin(location, eq(location.id, appointment.locationId))
    .where(
      and(
        eq(appointment.professionalId, input.professionalId),
        eq(appointment.source, 'online'),
        ne(appointment.status, 'cancelled'),
        gte(appointment.startsAt, new Date(input.startsAt.getTime() - 36 * 3_600_000)),
        lt(appointment.startsAt, new Date(input.startsAt.getTime() + 36 * 3_600_000)),
      ),
    );
  return rows.filter((row) => localDateOf(row.timeZone, row.startsAt) === day).length;
}

/**
 * Holds a slot for a visitor (online-booking, "Slot hold"). The slot must be one the link exposes,
 * inside the lead time and the horizon, and on a day that still has room under the cap. Anything
 * else answers as a slot that is no longer available, without saying which rule it broke. The hold
 * itself is scheduling's: ten minutes, capacity one, never an overbooked lane, and the visitor's
 * older hold is released first.
 */
export async function createPublicHold(tx: Tx, input: PublicHoldInput): Promise<PublicHoldDto> {
  const { offer, request, settings, now } = input;
  const type = offer.types.find((candidate) => candidate.id === request.appointmentTypeId);
  const place = offer.locations.find((candidate) => candidate.id === request.locationId);
  if (!type || !place) throw new AppError('not_found');

  const bookable = filterBookableSlots([{ startsAt: request.startsAt }], {
    now,
    minLeadHours: settings.minLeadHours,
    horizonDays: settings.horizonDays,
  });
  if (bookable.length === 0) throw new SlotNoLongerAvailableError();
  if (settings.dailyCap !== null) {
    const booked = await onlineBookingsOnDay(tx, {
      professionalId: offer.professionalId,
      startsAt: new Date(request.startsAt),
      timeZone: place.timeZone,
    });
    if (dailyCapReached(settings.dailyCap, booked)) throw new SlotNoLongerAvailableError();
  }

  try {
    const hold = await createHold(input.ports, {
      request: {
        professionalId: offer.professionalId,
        locationId: place.id,
        appointmentTypeId: type.id,
        startsAt: request.startsAt,
      },
      actor: PUBLIC_ACTOR,
      now,
      origin: 'public',
      sourceKey: input.sourceKey,
    });
    // What the hold was made for: the booking that finishes it needs the type and remembers the link.
    await tx.insert(publicHold).values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      holdId: hold.id,
      appointmentTypeId: type.id,
      bookingLinkId: offer.link.id,
    });
    return {
      id: hold.id,
      startsAt: hold.startsAt,
      endsAt: hold.endsAt,
      expiresAt: hold.expiresAt,
      locationId: hold.locationId,
      appointmentTypeId: type.id,
    };
  } catch (error) {
    // A range that fails an hours, block or holiday rule is simply not available: the visitor is
    // never told which rule it was.
    if (error instanceof AppError && error.code === 'validation_failed') {
      throw new SlotNoLongerAvailableError();
    }
    throw error;
  }
}
