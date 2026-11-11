import type { LocationDto } from '@consultorio/contracts';

import { DEFAULT_TIME_ZONE } from '../../../shared/lib/format.js';

/**
 * The zone the calendar is drawn in: that of the location being looked at, otherwise the zone the
 * active locations share, otherwise the first active location's, otherwise the country default.
 * Appointments are absolute instants, so the choice changes how they are labelled, never when they
 * happen.
 */
export function resolveTimeZone(
  locations: readonly LocationDto[],
  locationId: string | undefined,
): string {
  const chosen = locations.find((location) => location.id === locationId);
  if (chosen) return chosen.timeZone;
  const active = locations.filter((location) => location.active);
  return active[0]?.timeZone ?? locations[0]?.timeZone ?? DEFAULT_TIME_ZONE;
}
