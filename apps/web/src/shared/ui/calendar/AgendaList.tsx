import { CalendarOff } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn.js';
import { formatDayLong, formatTime } from '../../lib/format.js';
import { Badge } from '../badge.js';

import { eventAccessibleName } from './EventCard.js';
import type { CalendarEvent } from './types.js';
import { localDateOf } from './zoned-time.js';

/**
 * The keyboard-first presentation of the calendar: appointments in time order, grouped by day,
 * each one a full-width button. It is what phones show, and what anybody can choose instead of the
 * grid. Everything the grid can do is reachable from here without a pointer.
 */
export function AgendaList({
  events,
  dates,
  timeZone,
  label,
  closedDays,
  showDayHeadings,
  onSelectEvent,
}: {
  events: readonly CalendarEvent[];
  /** The days the period covers (so closed days can be told even when empty). */
  dates: readonly string[];
  timeZone: string;
  label: string;
  closedDays: Readonly<Record<string, string>>;
  showDayHeadings: boolean;
  onSelectEvent: (id: string) => void;
}) {
  const { t } = useTranslation('scheduling');

  const groups = useMemo(() => {
    const byDay = new Map<string, CalendarEvent[]>();
    for (const event of [...events].sort((a, b) => a.start.localeCompare(b.start))) {
      const day = localDateOf(event.start, timeZone);
      byDay.set(day, [...(byDay.get(day) ?? []), event]);
    }
    const visible = new Set(dates);
    return [...byDay.entries()]
      .filter(([day]) => visible.has(day))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [events, dates, timeZone]);

  return (
    <div role="region" aria-label={label} className="grid gap-4">
      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-card px-4 py-10 text-center">
          <CalendarOff className="size-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('calendar.listEmpty')}</p>
        </div>
      ) : (
        groups.map(([day, items]) => (
          <section key={day} className="grid gap-2">
            {showDayHeadings ? (
              <h2 className="text-sm font-semibold first-letter:uppercase">
                {formatDayLong(day)}
                {closedDays[day] ? (
                  <span className="ml-2 font-normal text-warning-soft-foreground">
                    {t('calendar.closed', { name: closedDays[day] })}
                  </span>
                ) : null}
              </h2>
            ) : null}
            <ol className="grid gap-2">
              {items.map((event) => {
                const Icon = event.statusIcon;
                const time = t('calendar.eventTime', {
                  start: formatTime(event.start, { timeZone }),
                  end: formatTime(event.end, { timeZone }),
                });
                return (
                  <li key={event.id}>
                    <button
                      type="button"
                      aria-label={eventAccessibleName(event, time)}
                      onClick={() => {
                        onSelectEvent(event.id);
                      }}
                      className={cn(
                        'touch-target-md grid w-full grid-cols-[4.5rem_1fr] items-start gap-3 rounded-lg border bg-card p-3 text-left hover:bg-accent',
                        event.muted && 'border-dashed',
                      )}
                      style={{
                        borderLeftWidth: 4,
                        borderLeftColor: event.accent ?? 'var(--border)',
                      }}
                    >
                      <span className="tabular grid text-sm font-semibold" aria-hidden="true">
                        <span>{formatTime(event.start, { timeZone })}</span>
                        <span className="font-normal text-muted-foreground">
                          {formatTime(event.end, { timeZone })}
                        </span>
                      </span>
                      <span className="grid min-w-0 gap-1" aria-hidden="true">
                        <span className={cn('truncate font-medium', event.muted && 'line-through')}>
                          {event.title}
                        </span>
                        {event.subtitle ? (
                          <span className="truncate text-sm text-muted-foreground">
                            {event.subtitle}
                          </span>
                        ) : null}
                        {event.resourceLabel ? (
                          <span className="truncate text-sm text-muted-foreground">
                            {event.resourceLabel}
                          </span>
                        ) : null}
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={event.statusTone}>
                            <Icon aria-hidden="true" />
                            {event.statusLabel}
                          </Badge>
                          {event.marker ? (
                            <Badge tone="info">
                              <event.marker.icon aria-hidden="true" />
                              {event.marker.label}
                            </Badge>
                          ) : null}
                          {event.note ? (
                            <span className="text-xs text-muted-foreground">{event.note}</span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
    </div>
  );
}
