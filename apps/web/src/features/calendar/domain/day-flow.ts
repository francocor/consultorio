import type { CalendarEntryDto } from '@consultorio/contracts';

/** The day of a professional or of the front desk, as it flows. */
export interface DayFlow {
  /** A consultation is running. */
  inProgress: CalendarEntryDto[];
  /** In the waiting room, in the order they are due. */
  waiting: CalendarEntryDto[];
  /** Still to arrive (including a booking waiting to be approved). */
  upcoming: CalendarEntryDto[];
  /** Done, or missed. */
  closed: CalendarEntryDto[];
  /** Who is called next: the patient who has waited longest. */
  next: CalendarEntryDto | undefined;
}

const byStart = (a: CalendarEntryDto, b: CalendarEntryDto) => a.startsAt.localeCompare(b.startsAt);

/** Cancelled appointments are not part of the day: they free the time and the screen follows. */
export function groupByFlow(entries: readonly CalendarEntryDto[]): DayFlow {
  const sorted = entries.filter((item) => item.status !== 'cancelled').sort(byStart);
  const waiting = sorted.filter((item) => item.status === 'checked_in');
  return {
    inProgress: sorted.filter((item) => item.status === 'in_progress'),
    waiting,
    upcoming: sorted.filter(
      (item) =>
        item.status === 'scheduled' ||
        item.status === 'confirmed' ||
        item.status === 'pending_approval',
    ),
    closed: sorted.filter((item) => item.status === 'attended' || item.status === 'no_show'),
    next: waiting[0],
  };
}

const plain = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** The front desk's quick search: any part of the name, without caring for case or accents. */
export function filterByPatient(
  entries: readonly CalendarEntryDto[],
  query: string,
): CalendarEntryDto[] {
  const needle = plain(query.trim());
  if (needle === '') return [...entries];
  return entries.filter((item) => plain(item.patientName).includes(needle));
}
