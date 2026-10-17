import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useApi } from '../../../app/providers.js';
import { rangeInstants, type CalendarViewMode } from '../../../shared/ui/calendar/zoned-time.js';
import { calendarApi, calendarKeys, type FeedQuery } from '../api/calendar-api.js';

export interface CalendarFilters {
  view: CalendarViewMode;
  /** The anchor day (`YYYY-MM-DD`) in the time zone of the location. */
  date: string;
  timeZone: string;
  /** Empty means "everybody the person may see": the server decides, not the screen. */
  professionalIds: readonly string[];
  locationId?: string | undefined;
  /** Hold the request until what it depends on (for example who "me" is) is known. */
  enabled?: boolean;
}

/**
 * The appointments, blocks and holidays of the window the view needs. The window is computed in
 * the zone of the location, so a day is that location's day whatever the device says. While the
 * next window loads, the previous one stays on screen (no flash of an empty agenda).
 */
export function useCalendar(filters: CalendarFilters) {
  const api = useApi();
  const range = useMemo(
    () => rangeInstants(filters.view, filters.date, filters.timeZone),
    [filters.view, filters.date, filters.timeZone],
  );
  const professionalIds = useMemo(
    () => [...filters.professionalIds].sort(),
    [filters.professionalIds],
  );
  const query: FeedQuery = {
    from: range.from,
    to: range.to,
    professionalIds,
    locationId: filters.locationId,
  };

  const feed = useQuery({
    queryKey: calendarKeys.feed(query),
    queryFn: () => calendarApi(api).feed(query),
    placeholderData: keepPreviousData,
    // A reception desk leaves this screen open all day: refresh it while it is visible.
    refetchInterval: 60_000,
    enabled: filters.enabled ?? true,
  });

  return { range, feed };
}
