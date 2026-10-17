import { useMemo, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn.js';
import { formatDayShort, formatTime, formatWeekdayShort } from '../../lib/format.js';

import { layoutOverlaps, minutesFromOffset, visibleHours } from './calendar-layout.js';
import { EventCard } from './EventCard.js';
import type { CalendarBackground, CalendarEvent, EventMove, SlotSelection } from './types.js';
import { useEventDrag } from './use-event-drag.js';
import { localDateOf, minutesOfDay, zonedInstant } from './zoned-time.js';

/** One hour of the grid, in pixels: tall enough that a 30-minute visit shows two lines. */
export const HOUR_PX = 72;
const PX_PER_MINUTE = HOUR_PX / 60;
/** Time is picked and moved in quarters of an hour. */
export const SLOT_MINUTES = 15;
const DEFAULT_HOURS = { start: 7, end: 21 };
const MIN_EVENT_PX = 20;
const DAY_MINUTES = 24 * 60;

export interface GridColumn {
  key: string;
  /** The local day this column shows. */
  date: string;
  /** The professional of the column; `null` when the columns are days. */
  resourceId: string | null;
  /** Accessible name of the column. */
  name: string;
  heading: string;
  subheading?: string;
  closedName?: string;
  /** Opens this day (week view). */
  onSelect?: () => void;
}

interface Clipped {
  start: number;
  end: number;
}

/** The part of an event or band that falls on the local day of a column, in minutes. */
function clipToDay(
  startIso: string,
  endIso: string,
  date: string,
  timeZone: string,
): Clipped | null {
  const startDate = localDateOf(startIso, timeZone);
  const endDate = localDateOf(endIso, timeZone);
  if (date < startDate || date > endDate) return null;
  const start = date === startDate ? minutesOfDay(startIso, timeZone) : 0;
  const end = date === endDate ? minutesOfDay(endIso, timeZone) : DAY_MINUTES;
  return end > start ? { start, end } : null;
}

export interface TimeGridProps {
  columns: readonly GridColumn[];
  events: readonly CalendarEvent[];
  backgrounds: readonly CalendarBackground[];
  timeZone: string;
  label: string;
  hours?: { start: number; end: number } | undefined;
  now?: Date | undefined;
  onSelectEvent: (id: string) => void;
  onSelectSlot?: ((slot: SlotSelection) => void) | undefined;
  onMoveEvent?: ((move: EventMove) => void) | undefined;
}

/** The time grid of the day and week views: a column per professional, or per day. */
export function TimeGrid({
  columns,
  events,
  backgrounds,
  timeZone,
  label,
  hours,
  now,
  onSelectEvent,
  onSelectSlot,
  onMoveEvent,
}: TimeGridProps) {
  const { t } = useTranslation('scheduling');
  const columnsArea = useRef<HTMLDivElement>(null);

  const placed = useMemo(
    () =>
      columns.map((column) => {
        const items = events.flatMap((event) => {
          if (column.resourceId !== null && event.resourceId !== column.resourceId) return [];
          const clipped = clipToDay(event.start, event.end, column.date, timeZone);
          return clipped ? [{ event, ...clipped }] : [];
        });
        const bands = backgrounds.flatMap((band) => {
          if (
            column.resourceId !== null &&
            band.resourceId !== null &&
            band.resourceId !== column.resourceId
          ) {
            return [];
          }
          const clipped = clipToDay(band.start, band.end, column.date, timeZone);
          return clipped ? [{ band, ...clipped }] : [];
        });
        const lanes = layoutOverlaps(items.map((item) => ({ id: item.event.id, ...item })));
        return { column, items, bands, lanes };
      }),
    [columns, events, backgrounds, timeZone],
  );

  const range = visibleHours(
    placed.flatMap((entry) => entry.items),
    hours ?? DEFAULT_HOURS,
  );
  const startMinute = range.start * 60;
  const hourMarks = Array.from(
    { length: range.end - range.start },
    (_, index) => range.start + index,
  );
  const bodyHeight = (range.end - range.start) * HOUR_PX;

  const eventColumn = useMemo(() => {
    const map = new Map<string, number>();
    placed.forEach((entry, index) => {
      for (const item of entry.items) map.set(item.event.id, index);
    });
    return map;
  }, [placed]);

  const drag = useEventDrag({
    columnsArea: () => columnsArea.current,
    columns: columns.length,
    pxPerMinute: PX_PER_MINUTE,
    step: SLOT_MINUTES,
    startColumnIndex: (id) => eventColumn.get(id) ?? 0,
    onDrop: ({ id, deltaMinutes, columnIndex, moved }) => {
      if (!moved || !onMoveEvent) return;
      const event = events.find((item) => item.id === id);
      const target = columns[columnIndex];
      if (!event || !target || event.movable !== true) return;
      const originalStart = new Date(event.start).getTime();
      const shifted = new Date(originalStart + deltaMinutes * 60_000);
      const column = columns[eventColumn.get(id) ?? columnIndex];
      // Moving to another day keeps the time of the day; moving within one keeps the day.
      const start =
        column && target.date !== column.date
          ? zonedInstant(target.date, minutesOfDay(shifted, timeZone), timeZone)
          : shifted;
      onMoveEvent({ id, resourceId: target.resourceId ?? event.resourceId, start });
    },
  });

  function moveWithKeyboard(event: CalendarEvent, key: string, columnIndex: number) {
    if (!onMoveEvent || event.movable !== true) return false;
    const column = columns[columnIndex];
    if (!column) return false;
    const start = new Date(event.start);
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const delta = (key === 'ArrowDown' ? 1 : -1) * SLOT_MINUTES * 60_000;
      onMoveEvent({
        id: event.id,
        resourceId: event.resourceId,
        start: new Date(start.getTime() + delta),
      });
      return true;
    }
    const target = columns[columnIndex + (key === 'ArrowRight' ? 1 : -1)];
    if (!target) return true;
    const sameTime =
      target.date === column.date
        ? start
        : zonedInstant(target.date, minutesOfDay(start, timeZone), timeZone);
    onMoveEvent({
      id: event.id,
      resourceId: target.resourceId ?? event.resourceId,
      start: sameTime,
    });
    return true;
  }

  function onBodyClick(column: GridColumn, click: MouseEvent<HTMLDivElement>) {
    if (!onSelectSlot || click.target !== click.currentTarget) return;
    const rect = click.currentTarget.getBoundingClientRect();
    const minutes = minutesFromOffset({
      offsetY: click.clientY - rect.top,
      pxPerMinute: PX_PER_MINUTE,
      startMinute,
      step: SLOT_MINUTES,
    });
    onSelectSlot({
      resourceId: column.resourceId,
      start: zonedInstant(column.date, Math.min(minutes, DAY_MINUTES - SLOT_MINUTES), timeZone),
    });
  }

  const today = now ? localDateOf(now, timeZone) : null;
  const nowMinute = now ? minutesOfDay(now, timeZone) : null;
  const template = {
    gridTemplateColumns: `3.25rem repeat(${String(columns.length)}, minmax(9.5rem, 1fr))`,
  };

  return (
    <div
      role="region"
      aria-label={label}
      // The scrollable region must be focusable so keyboard users can scroll it (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="max-h-[calc(100dvh-14rem)] min-h-96 overflow-auto rounded-lg border bg-card"
    >
      <div className="grid min-w-fit" style={template}>
        {/* Header row, fixed while the day scrolls. */}
        <div className="sticky top-0 z-30 border-b bg-card" aria-hidden="true" />
        {columns.map((column) => {
          const isToday = column.date === today;
          return (
            <div
              key={column.key}
              className="sticky top-0 z-20 grid content-center gap-0.5 border-b border-l bg-card px-2 py-2 text-center"
            >
              {column.onSelect ? (
                <button
                  type="button"
                  onClick={column.onSelect}
                  className={cn(
                    'touch-target-md mx-auto rounded-md px-2 text-sm font-semibold hover:bg-accent',
                    isToday && 'text-primary-ink',
                  )}
                >
                  {column.heading}
                </button>
              ) : (
                <span className="text-sm font-semibold">{column.heading}</span>
              )}
              {column.subheading ? (
                <span className="text-xs text-muted-foreground">{column.subheading}</span>
              ) : null}
              {column.closedName ? (
                <span className="text-xs font-medium text-warning-soft-foreground">
                  {t('calendar.closed', { name: column.closedName })}
                </span>
              ) : null}
            </div>
          );
        })}

        {/* The hour labels. */}
        <div className="relative" style={{ height: bodyHeight }} aria-hidden="true">
          {hourMarks.map((hour) => (
            <span
              key={hour}
              data-hour-label
              className={cn(
                'tabular absolute right-1.5 text-xs text-muted-foreground',
                hour === range.start ? 'translate-y-0.5' : '-translate-y-2',
              )}
              style={{ top: (hour - range.start) * HOUR_PX }}
            >
              {String(hour).padStart(2, '0')}:00
            </span>
          ))}
        </div>

        <div
          ref={columnsArea}
          data-testid="time-grid-columns"
          className="grid"
          style={{ gridColumn: '2 / -1', gridRow: 2, gridTemplateColumns: 'subgrid' }}
        >
          {placed.map(({ column, items, bands, lanes }) => (
            <div
              key={column.key}
              role="group"
              aria-label={column.name}
              className="relative border-l"
              style={{ height: bodyHeight }}
            >
              <div
                data-column-body
                {...(onSelectSlot ? { 'data-selectable': '' } : {})}
                onClick={(click) => {
                  onBodyClick(column, click);
                }}
                onKeyDown={noopKey}
                role="presentation"
                className={cn(
                  'absolute inset-0 bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_calc(var(--hour)-1px),var(--border)_calc(var(--hour)-1px),var(--border)_var(--hour))]',
                  column.closedName && 'bg-warning-soft/40',
                  onSelectSlot && 'cursor-cell',
                )}
                style={{ '--hour': `${String(HOUR_PX)}px` } as CSSProperties}
              />
              {bands.map(({ band, start, end }) => (
                <div
                  key={band.id}
                  className="pointer-events-none absolute inset-x-0 overflow-hidden border-y border-dashed border-input bg-muted/80 px-1.5 py-1 text-xs text-muted-foreground"
                  style={{
                    top: (start - startMinute) * PX_PER_MINUTE,
                    height: Math.max((end - start) * PX_PER_MINUTE, MIN_EVENT_PX),
                  }}
                >
                  {t('calendar.blocked', { reason: band.label })}
                </div>
              ))}
              {items.map(({ event, start, end }) => {
                const lane = lanes[event.id] ?? { lane: 0, lanes: 1 };
                const columnIndex = eventColumn.get(event.id) ?? 0;
                const preview = drag.preview?.id === event.id ? drag.preview : null;
                return (
                  <EventCard
                    key={event.id}
                    event={event}
                    onSelect={() => {
                      if (!drag.consumeClickSuppression()) onSelectEvent(event.id);
                    }}
                    onPointerDown={(down) => {
                      if (event.movable === true && onMoveEvent) drag.begin(down, event.id);
                    }}
                    onKeyDown={(key: KeyboardEvent<HTMLButtonElement>) => {
                      if (!key.altKey || !key.key.startsWith('Arrow')) return;
                      if (moveWithKeyboard(event, key.key, columnIndex)) key.preventDefault();
                    }}
                    dragging={preview !== null}
                    style={{
                      top: (start - startMinute) * PX_PER_MINUTE,
                      height: Math.max((end - start) * PX_PER_MINUTE, MIN_EVENT_PX),
                      left: `calc(${String((lane.lane / lane.lanes) * 100)}% + 2px)`,
                      width: `calc(${String(100 / lane.lanes)}% - 4px)`,
                      ...(preview
                        ? {
                            transform: `translate(${String((preview.columnIndex - columnIndex) * 100)}%, ${String(preview.deltaMinutes * PX_PER_MINUTE)}px)`,
                          }
                        : {}),
                    }}
                    timeLabel={t('calendar.eventTime', {
                      start: formatTime(event.start, { timeZone }),
                      end: formatTime(event.end, { timeZone }),
                    })}
                    startLabel={formatTime(event.start, { timeZone })}
                    movable={event.movable === true && onMoveEvent !== undefined}
                  />
                );
              })}
              {column.date === today &&
              nowMinute !== null &&
              nowMinute >= startMinute &&
              nowMinute < range.end * 60 ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-destructive"
                  style={{ top: (nowMinute - startMinute) * PX_PER_MINUTE }}
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function noopKey() {
  /* The slot is a pointer convenience; keyboard users book from "Nueva cita" or the list. */
}

/** Short heading of a day column: `sáb 17 oct`. */
export function dayHeading(date: string): string {
  return `${formatWeekdayShort(date)} ${formatDayShort(date)}`;
}
