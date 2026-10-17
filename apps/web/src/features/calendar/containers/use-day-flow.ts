import { useNow } from '../../../shared/lib/use-now.js';
import { localDateOf } from '../../../shared/ui/calendar/zoned-time.js';
import { groupByFlow } from '../domain/day-flow.js';
import { resolveTimeZone } from '../domain/time-zone.js';

import { useCalendar } from './use-calendar.js';
import { useSchedulingLocations, useSchedulingProfessionals } from './use-scheduling-people.js';

/**
 * Today at a location, as it flows (who is in a consultation, who waits, who is still to arrive).
 * The day is the LOCAL day of the location; the screen refreshes on its own while it is open.
 */
export function useDayFlow(options: {
  /** Only the signed-in professional's own appointments (the professional's "Hoy"). */
  own: boolean;
  locationId?: string | undefined;
}) {
  const now = useNow(30_000);
  const { locations } = useSchedulingLocations();
  const { professionals, ownProfessionalId, query: people } = useSchedulingProfessionals();
  const timeZone = resolveTimeZone(locations, options.locationId);
  const date = localDateOf(now, timeZone);
  const { feed } = useCalendar({
    view: 'day',
    date,
    timeZone,
    // Asked for by name, so the answer is exactly their own day; nothing is asked until it is known.
    professionalIds: options.own && ownProfessionalId !== null ? [ownProfessionalId] : [],
    locationId: options.locationId,
    enabled: !options.own || ownProfessionalId !== null,
  });
  const flow = groupByFlow(feed.data?.appointments ?? []);
  return { feed, flow, timeZone, date, now, locations, professionals, ownProfessionalId, people };
}
