import type {
  OnlineBookingSettings,
  PublicAvailabilityQuery,
  PublicAvailabilityResponse,
  PublicSlotDto,
} from '@consultorio/contracts';
import { and, gte, lt, ne, eq } from 'drizzle-orm';

import { appointment } from '../../../db/schema/scheduling.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { availability } from '../../scheduling/index.js';
import type { SchedulingPorts } from '../../scheduling/index.js';
import { dailyCapReached, filterBookableSlots, localDateOf } from '../domain/booking-rules.js';

import type { ProfessionalOffer } from './public-offer.js';
import { publicCapacityPorts } from './public-ports.js';

const DAY_MS = 86_400_000;

export interface PublicAvailabilityInput {
  offer: ProfessionalOffer;
  query: Omit<PublicAvailabilityQuery, 'professional'>;
  settings: OnlineBookingSettings;
  now: Date;
  ports: SchedulingPorts;
}

/** `YYYY-MM-DD` shifted by whole days. */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * How many online bookings the professional already has on each local day, per time zone. A
 * cancelled booking gives its place back.
 */
async function onlineBookingsByDay(
  tx: Tx,
  input: { professionalId: string; from: string; to: string },
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      startsAt: appointment.startsAt,
      timeZone: location.timeZone,
    })
    .from(appointment)
    .innerJoin(location, eq(location.id, appointment.locationId))
    .where(
      and(
        eq(appointment.professionalId, input.professionalId),
        eq(appointment.source, 'online'),
        ne(appointment.status, 'cancelled'),
        // A day of margin on both sides covers every time zone; the exact date is read below.
        gte(appointment.startsAt, new Date(Date.parse(`${input.from}T00:00:00Z`) - DAY_MS)),
        lt(appointment.startsAt, new Date(Date.parse(`${input.to}T00:00:00Z`) + 2 * DAY_MS)),
      ),
    );
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = localDateOf(row.timeZone, row.startsAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Free slots as a visitor may see them: what scheduling considers free for a single-capacity
 * professional (working hours, blocks, holidays, appointments and holds), minus what the
 * organization's online rules take away (lead time, horizon, the optional daily cap). Nothing here
 * says why a time is missing, and nobody else's appointment is visible.
 *
 * The slot types and locations were already narrowed by the link (`offer`). A type or location the
 * link does not expose gets `null`, which the caller answers like any unknown address.
 */
export async function publicAvailability(
  tx: Tx,
  input: PublicAvailabilityInput,
): Promise<PublicAvailabilityResponse | null> {
  const { offer, query, settings, now } = input;
  const type = offer.types.find((candidate) => candidate.id === query.typeId);
  if (!type) return null;
  if (query.locationId !== undefined && !offer.locations.some((l) => l.id === query.locationId)) {
    return null;
  }
  const typeId = type.id;
  const ports = publicCapacityPorts(input.ports);
  const exposed = offer.locations.map((entry) => entry.id);
  const horizonEnd = new Date(now.getTime() + settings.horizonDays * DAY_MS);

  async function slotsBetween(from: string, to: string): Promise<PublicSlotDto[]> {
    const free = await availability(ports, {
      query: {
        professionalId: offer.professionalId,
        typeId,
        from,
        to,
        ...(query.locationId === undefined ? {} : { locationId: query.locationId }),
      },
      now,
      visibleLocations: exposed,
    });
    let slots: PublicSlotDto[] = free.slots.map((slot) => ({
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      locationId: slot.locationId,
      date: slot.date,
    }));
    slots = filterBookableSlots(slots, {
      now,
      minLeadHours: settings.minLeadHours,
      horizonDays: settings.horizonDays,
    });
    if (settings.dailyCap !== null) {
      const counts = await onlineBookingsByDay(tx, {
        professionalId: offer.professionalId,
        from,
        to,
      });
      const zones = new Map(offer.locations.map((entry) => [entry.id, entry.timeZone]));
      slots = slots.filter((slot) => {
        const zone = zones.get(slot.locationId) ?? 'UTC';
        return !dailyCapReached(
          settings.dailyCap,
          counts.get(localDateOf(zone, new Date(slot.startsAt))) ?? 0,
        );
      });
    }
    return slots;
  }

  const slots = await slotsBetween(query.from, query.to);
  if (slots.length > 0) return { slots, nextAvailable: null };

  // Nothing in the range: point at the first free time after it, inside the horizon.
  const horizonDate = horizonEnd.toISOString().slice(0, 10);
  let from = shiftDate(query.to, 1);
  for (let window = 0; window < 3 && from <= horizonDate; window += 1) {
    const to = shiftDate(from, 30);
    const later = await slotsBetween(from, to > horizonDate ? horizonDate : to);
    const first = later[0];
    if (first) return { slots, nextAvailable: first };
    from = shiftDate(to, 1);
  }
  return { slots, nextAvailable: null };
}
