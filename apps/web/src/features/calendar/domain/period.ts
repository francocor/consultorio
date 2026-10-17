import { formatDayLong, formatDayShort, formatMonthYear } from '../../../shared/lib/format.js';
import {
  addDays,
  addMonths,
  weekDates,
  type CalendarViewMode,
} from '../../../shared/ui/calendar/zoned-time.js';

/** The anchor day after moving one period back (-1) or forward (+1). */
export function movePeriod(view: CalendarViewMode, date: string, direction: -1 | 1): string {
  if (view === 'day') return addDays(date, direction);
  if (view === 'week') return addDays(date, 7 * direction);
  return addMonths(date, direction);
}

/** What the person reads above the calendar: the day, the week or the month. */
export function periodLabel(view: CalendarViewMode, date: string): string {
  if (view === 'day') return formatDayLong(date);
  if (view === 'month') return formatMonthYear(date);
  const days = weekDates(date);
  return `${formatDayShort(days[0] ?? date)} al ${formatDayShort(days[6] ?? date)}`;
}

export function regionLabelKey(
  view: CalendarViewMode,
): 'calendar.regionDay' | 'calendar.regionWeek' | 'calendar.regionMonth' {
  if (view === 'day') return 'calendar.regionDay';
  return view === 'week' ? 'calendar.regionWeek' : 'calendar.regionMonth';
}
