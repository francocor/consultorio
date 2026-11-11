import {
  canRescheduleStatus,
  type AppointmentStatus,
  type BlockDto,
  type CalendarEntryDto,
  type HolidayDto,
} from '@consultorio/contracts';
import type { TFunction } from 'i18next';
import {
  BadgeCheck,
  CalendarClock,
  CircleCheck,
  CircleX,
  Hourglass,
  Stethoscope,
  UserRoundCheck,
  UserRoundX,
  Video,
  type LucideIcon,
} from 'lucide-react';

import type { BadgeTone } from '../../../shared/ui/badge.js';
import type { CalendarBackground, CalendarEvent } from '../../../shared/ui/calendar/types.js';

/** Each status is an icon, a tone AND a word (the word comes from the catalog): never color alone. */
export const STATUS_PRESENTATION: Record<AppointmentStatus, { icon: LucideIcon; tone: BadgeTone }> =
  {
    pending_approval: { icon: Hourglass, tone: 'warning' },
    scheduled: { icon: CalendarClock, tone: 'neutral' },
    confirmed: { icon: CircleCheck, tone: 'info' },
    checked_in: { icon: UserRoundCheck, tone: 'brand' },
    in_progress: { icon: Stethoscope, tone: 'info' },
    attended: { icon: BadgeCheck, tone: 'success' },
    no_show: { icon: UserRoundX, tone: 'danger' },
    cancelled: { icon: CircleX, tone: 'neutral' },
  };

export function statusLabel(t: TFunction, status: AppointmentStatus): string {
  return t(`scheduling:status.${status}`);
}

export interface EventOptions {
  /** The name of the professional the appointment is with. */
  resourceLabel: string;
  t: TFunction;
  /** Whether the person may move appointments (they hold the booking permission). */
  canMove: boolean;
}

/** An entry of the calendar feed as the presentational grid understands it. */
export function toCalendarEvent(entry: CalendarEntryDto, options: EventOptions): CalendarEvent {
  const { t } = options;
  const presentation = STATUS_PRESENTATION[entry.status];
  const notes = [
    entry.identityConfirmed ? null : t('scheduling:event.identityPending'),
    entry.outOfHours ? t('scheduling:event.outOfHours') : null,
  ].filter((note): note is string => note !== null);

  return {
    id: entry.id,
    resourceId: entry.professionalId,
    start: entry.startsAt,
    end: entry.endsAt,
    title: entry.patientName,
    subtitle: entry.typeName,
    resourceLabel: options.resourceLabel,
    statusLabel: statusLabel(t, entry.status),
    statusTone: presentation.tone,
    statusIcon: presentation.icon,
    accent: entry.typeColor,
    muted: entry.status === 'cancelled' || entry.status === 'no_show',
    ...(notes.length > 0 ? { note: notes.join('. ') } : {}),
    // A video visit is marked with an icon and the word, so nobody walks to a room for it.
    ...(entry.mode === 'virtual'
      ? { marker: { icon: Video, label: t('scheduling:event.virtual') } }
      : {}),
    movable: options.canMove && canRescheduleStatus(entry.status),
  };
}

/**
 * Blocks as bands behind the events. A block of a professional belongs to their column; a block of
 * a whole location to every column, and only of the location being looked at.
 */
export function backgroundsOf(
  blocks: readonly BlockDto[],
  locationId: string | undefined,
): CalendarBackground[] {
  return blocks
    .filter(
      (block) =>
        block.professionalId !== null ||
        locationId === undefined ||
        block.locationId === null ||
        block.locationId === locationId,
    )
    .map((block) => ({
      id: block.id,
      resourceId: block.professionalId,
      start: block.startsAt,
      end: block.endsAt,
      label: block.reason,
    }));
}

/** Holidays of the country, and the organization's days off for the location being looked at. */
export function closedDaysOf(
  holidays: readonly HolidayDto[],
  locationId: string | undefined,
): Record<string, string> {
  const closed: Record<string, string> = {};
  for (const holiday of holidays) {
    if (holiday.locationId === null || holiday.locationId === locationId) {
      closed[holiday.day] = holiday.name;
    }
  }
  return closed;
}
