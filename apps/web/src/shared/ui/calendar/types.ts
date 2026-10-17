import type { LucideIcon } from 'lucide-react';

import type { BadgeTone } from '../badge.js';

import type { CalendarViewMode } from './zoned-time.js';

export type { CalendarViewMode };

/**
 * The vocabulary of `CalendarView`. It knows nothing about appointments: a screen maps its data to
 * these shapes, so the grid can be swapped for another one without touching a single screen.
 */

/** A column of the day view (a professional). */
export interface CalendarResource {
  id: string;
  label: string;
  /** A second line under the label, for example the discipline. */
  description?: string;
}

export interface CalendarEvent {
  id: string;
  /** The column it belongs to in the day view. */
  resourceId: string;
  /** Instants, with an offset (ISO 8601). */
  start: string;
  end: string;
  /** The main line (the patient). */
  title: string;
  /** The second line (the type of appointment). */
  subtitle?: string;
  /** The person it is with, shown where columns do not say it (week, month and list). */
  resourceLabel?: string;
  /** The status as an icon AND a word: never color alone. */
  statusLabel: string;
  statusTone: BadgeTone;
  statusIcon: LucideIcon;
  /** A decorative stripe (the color of the type of appointment). */
  accent?: string | null;
  /** Shown but not active: cancelled or not attended. */
  muted?: boolean;
  /** Extra words for the accessible name, such as "identidad sin confirmar". */
  note?: string;
  /** Whether it may be dragged to another time or column. */
  movable?: boolean;
}

/** A band behind the events: a block of time that cannot be booked. */
export interface CalendarBackground {
  id: string;
  /** `null` means every column. */
  resourceId: string | null;
  start: string;
  end: string;
  label: string;
}

export interface SlotSelection {
  /** The professional of the column, or `null` in a view whose columns are days. */
  resourceId: string | null;
  start: Date;
}

export interface EventMove {
  id: string;
  resourceId: string;
  start: Date;
}

export interface CalendarViewProps {
  view: CalendarViewMode;
  /** The anchor day (`YYYY-MM-DD`) in the time zone of the location. */
  date: string;
  timeZone: string;
  /** The accessible name of the whole calendar. */
  label: string;
  resources: readonly CalendarResource[];
  events: readonly CalendarEvent[];
  backgrounds?: readonly CalendarBackground[];
  /** Days nobody works, by date, with the name of the holiday. */
  closedDays?: Readonly<Record<string, string>>;
  /** `grid` is the time grid; `list` is the keyboard-first agenda (always used on a phone). */
  presentation?: 'grid' | 'list';
  /** The hours shown when nothing falls outside them. */
  hours?: { start: number; end: number };
  /** The current instant, to draw the "now" line. */
  now?: Date;
  onSelectEvent: (id: string) => void;
  /** An empty stretch of a column was chosen (pointer). Omit to make the grid read-only. */
  onSelectSlot?: (slot: SlotSelection) => void;
  /** An event was dragged (or moved with the keyboard) to another time or column. */
  onMoveEvent?: (move: EventMove) => void;
  /** A day of the month or week header was chosen. */
  onSelectDay?: (date: string) => void;
}
