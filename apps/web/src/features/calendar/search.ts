import { z } from 'zod';

import type { CalendarViewMode } from '../../shared/ui/calendar/zoned-time.js';

/** What the address of the agenda says. Everything is optional and checked: it comes from a URL. */
export interface CalendarSearch {
  view: CalendarViewMode;
  /** The anchor day; today when absent. */
  date: string | undefined;
  location: string | undefined;
  /** Professionals chosen, comma separated (absent means everybody the person may see). */
  pros: string | undefined;
  /** Absent rather than `false`, so the address stays short. */
  cancelled: true | undefined;
  /** Prefer the list presentation on a wide screen. */
  list: true | undefined;
  /** The appointment whose drawer is open. */
  appointment: string | undefined;
}

const Id = z.uuid();
const Day = z.iso.date();

function pick<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function validateCalendarSearch(search: Record<string, unknown>): CalendarSearch {
  const view = pick(z.enum(['day', 'week', 'month']), search['view']) ?? 'day';
  const chosen =
    typeof search['pros'] === 'string'
      ? search['pros'].split(',').flatMap((part) => pick(Id, part) ?? [])
      : [];
  return {
    view,
    date: pick(Day, search['date']),
    location: pick(Id, search['location']),
    pros: chosen.length > 0 ? chosen.join(',') : undefined,
    cancelled: search['cancelled'] === true || search['cancelled'] === 'true' ? true : undefined,
    list: search['list'] === true || search['list'] === 'true' ? true : undefined,
    appointment: pick(Id, search['appointment']),
  };
}

/** The professionals named in the address, as a list. */
export function prosOf(search: Pick<CalendarSearch, 'pros'>): string[] {
  return search.pros === undefined ? [] : search.pros.split(',');
}
