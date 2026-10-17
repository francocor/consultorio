import { cn } from '../../../shared/lib/cn.js';
import { formatDayShort, formatTime, formatWeekdayShort } from '../../../shared/lib/format.js';
import { localDateOf } from '../../../shared/ui/calendar/zoned-time.js';

export interface SlotOption {
  startsAt: string;
  endsAt: string;
}

/**
 * Free times as buttons: one tap picks one. Times are shown in the zone of the location, and a
 * time on another day than `referenceDate` carries its day, so a list of "next free times" reads
 * correctly. The group is labelled for assistive technology and the choice is `aria-pressed`.
 */
export function SlotGrid({
  slots,
  selected,
  timeZone,
  referenceDate,
  label,
  onSelect,
  className,
}: {
  slots: readonly SlotOption[];
  /** The `startsAt` of the chosen slot. */
  selected: string | null;
  timeZone: string;
  /** The day the screen is about; slots on this day show only the time. */
  referenceDate: string;
  label?: string;
  onSelect: (slot: SlotOption) => void;
  className?: string;
}) {
  const chosen = selected === null ? null : new Date(selected).getTime();

  return (
    <div
      {...(label ? { role: 'group', 'aria-label': label } : {})}
      className={cn('flex flex-wrap gap-2', className)}
    >
      {slots.map((slot) => {
        const day = localDateOf(slot.startsAt, timeZone);
        const time = formatTime(slot.startsAt, { timeZone });
        const text =
          day === referenceDate
            ? time
            : `${formatWeekdayShort(day)} ${formatDayShort(day)} ${time}`;
        const pressed = chosen === new Date(slot.startsAt).getTime();
        return (
          <button
            key={slot.startsAt}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              onSelect(slot);
            }}
            className={cn(
              'tabular touch-target-md inline-flex min-w-16 cursor-pointer items-center justify-center rounded-md border px-3 text-sm font-medium',
              pressed
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card hover:bg-accent',
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
