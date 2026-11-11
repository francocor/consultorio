import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn.js';
import { formatDayLong, formatTime, formatWeekdayShort } from '../../lib/format.js';

import type { CalendarEvent } from './types.js';
import { localDateOf, monthGridDates, weekDates } from './zoned-time.js';

const CHIPS_PER_DAY = 3;

/** The month as weeks of seven days. A day is one button: it opens that day. */
export function MonthGrid({
  date,
  timeZone,
  label,
  events,
  closedDays,
  now,
  onSelectDay,
}: {
  date: string;
  timeZone: string;
  label: string;
  events: readonly CalendarEvent[];
  closedDays: Readonly<Record<string, string>>;
  now: Date | undefined;
  onSelectDay: ((date: string) => void) | undefined;
}) {
  const { t } = useTranslation('scheduling');
  const days = monthGridDates(date);
  const month = date.slice(0, 7);
  const today = now ? localDateOf(now, timeZone) : null;

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
      const day = localDateOf(event.start, timeZone);
      map.set(day, [...(map.get(day) ?? []), event]);
    }
    return map;
  }, [events, timeZone]);

  return (
    <div role="region" aria-label={label} className="overflow-hidden rounded-lg border bg-card">
      <div className="grid grid-cols-7 border-b bg-muted text-center text-xs font-medium text-muted-foreground">
        {weekDates(days[0] ?? date).map((weekday) => (
          <span key={weekday} className="py-2">
            {formatWeekdayShort(weekday)}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const dayEvents = byDay.get(day) ?? [];
          const closed = closedDays[day];
          const inMonth = day.startsWith(month);
          const dayLabel = formatDayLong(day);
          const name =
            closed !== undefined
              ? dayEvents.length === 0
                ? t('calendar.dayClosedEmpty', { day: dayLabel, name: closed })
                : t('calendar.dayClosed', { day: dayLabel, count: dayEvents.length, name: closed })
              : dayEvents.length === 0
                ? t('calendar.dayEmpty', { day: dayLabel })
                : t('calendar.dayCount', { day: dayLabel, count: dayEvents.length });
          return (
            <button
              key={day}
              type="button"
              aria-label={name}
              aria-current={day === today ? 'date' : undefined}
              onClick={() => {
                onSelectDay?.(day);
              }}
              className={cn(
                'flex min-h-14 flex-col items-stretch gap-0.5 border-b border-r p-1 text-left hover:bg-accent sm:min-h-24 sm:p-1.5',
                !inMonth && 'bg-muted/60 text-muted-foreground',
                closed !== undefined && 'bg-warning-soft/50',
              )}
            >
              <span
                className={cn(
                  'tabular inline-grid size-6 place-content-center self-start rounded-full text-xs font-semibold',
                  day === today && 'bg-primary text-primary-foreground',
                )}
              >
                {Number(day.slice(8))}
              </span>
              {dayEvents.length > 0 ? (
                <span className="tabular inline-flex w-fit rounded-md bg-accent px-1.5 text-xs font-semibold text-accent-foreground sm:hidden">
                  {dayEvents.length}
                </span>
              ) : null}
              <span className="hidden min-w-0 flex-col gap-0.5 sm:flex">
                {closed !== undefined ? (
                  <span className="truncate text-xs font-medium text-warning-soft-foreground">
                    {closed}
                  </span>
                ) : null}
                {dayEvents.slice(0, CHIPS_PER_DAY).map((event) => (
                  <span
                    key={event.id}
                    className="truncate rounded-sm bg-secondary px-1 text-xs text-secondary-foreground"
                  >
                    <span className="tabular font-semibold">
                      {formatTime(event.start, { timeZone })}
                    </span>{' '}
                    {event.title}
                  </span>
                ))}
                {dayEvents.length > CHIPS_PER_DAY ? (
                  <span className="text-xs text-muted-foreground">
                    {t('calendar.moreEvents', { count: dayEvents.length - CHIPS_PER_DAY })}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
