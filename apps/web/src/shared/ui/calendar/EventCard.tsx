import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/cn.js';

import { TONE_SURFACE } from './tone-classes.js';
import type { CalendarEvent } from './types.js';

/** Below this height (px) there is room for one line only. */
const TWO_LINES_PX = 34;

/** The words a screen reader gets for an event: time, who, what, with whom, and the status. */
export function eventAccessibleName(event: CalendarEvent, timeLabel: string): string {
  return [
    timeLabel,
    event.title,
    event.subtitle,
    event.resourceLabel,
    event.statusLabel,
    event.marker?.label,
    event.note,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ');
}

/**
 * An appointment on the time grid. A real button, so it takes focus and opens with Enter or Space;
 * the status is an icon and a word on the card, not only a color.
 */
export function EventCard({
  event,
  timeLabel,
  startLabel,
  style,
  movable,
  dragging,
  onSelect,
  onPointerDown,
  onKeyDown,
}: {
  event: CalendarEvent;
  timeLabel: string;
  startLabel: string;
  style: CSSProperties;
  movable: boolean;
  dragging: boolean;
  onSelect: () => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useTranslation('scheduling');
  const Icon = event.statusIcon;
  const Marker = event.marker?.icon;
  const height = typeof style.height === 'number' ? style.height : 0;
  const roomy = height >= TWO_LINES_PX;

  return (
    <button
      type="button"
      aria-label={eventAccessibleName(event, timeLabel)}
      {...(movable ? { 'aria-description': t('calendar.moveHint') } : {})}
      onClick={onSelect}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute z-[5] flex touch-manipulation flex-col justify-start gap-0 overflow-hidden rounded-md border border-l-4 px-1.5 py-0.5 text-left text-xs leading-4 shadow-sm outline-offset-0',
        'hover:z-10 hover:brightness-95 focus-visible:z-10',
        TONE_SURFACE[event.statusTone],
        movable && 'cursor-grab',
        dragging && 'z-20 cursor-grabbing opacity-80 shadow-lg',
        event.muted && 'border-dashed',
      )}
      style={{
        ...style,
        borderLeftColor: event.accent ?? 'currentColor',
      }}
    >
      <span className="flex min-w-0 items-baseline gap-1">
        <span className="tabular shrink-0 font-semibold">{startLabel}</span>
        {Marker ? (
          <Marker
            data-testid="event-marker"
            className="size-3 shrink-0 self-center"
            aria-hidden="true"
          />
        ) : null}
        <span className={cn('truncate font-semibold', event.muted && 'line-through')}>
          {event.title}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <Icon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{event.statusLabel}</span>
        {roomy && event.subtitle ? (
          <span className="truncate opacity-80">· {event.subtitle}</span>
        ) : null}
      </span>
    </button>
  );
}
