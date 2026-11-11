import { useTranslation } from 'react-i18next';

import { formatDayLong } from '../../lib/format.js';

import { AgendaList } from './AgendaList.js';
import { MonthGrid } from './MonthGrid.js';
import { dayHeading, TimeGrid, type GridColumn } from './TimeGrid.js';
import type { CalendarViewProps } from './types.js';
import { viewDates, weekDates } from './zoned-time.js';

/**
 * The calendar: day (a column per professional), week (a column per day), month, and the list
 * presentation of the first two. Presentational only: it receives events and reports what the
 * person chose; it fetches nothing and knows nothing about appointments, so it can be swapped for
 * another grid without changing a screen (see `docs/adr/calendar.md`).
 *
 * Every instant is shown in `timeZone`, the zone of the location, whatever the device says.
 */
export function CalendarView({
  view,
  date,
  timeZone,
  label,
  resources,
  events,
  backgrounds = [],
  closedDays = {},
  presentation = 'grid',
  hours,
  now,
  onSelectEvent,
  onSelectSlot,
  onMoveEvent,
  onSelectDay,
}: CalendarViewProps) {
  const { t } = useTranslation('scheduling');

  if (view === 'month') {
    return (
      <MonthGrid
        date={date}
        timeZone={timeZone}
        label={label}
        events={events}
        closedDays={closedDays}
        now={now}
        onSelectDay={onSelectDay}
      />
    );
  }

  if (presentation === 'list') {
    return (
      <AgendaList
        events={events}
        dates={viewDates(view, date)}
        timeZone={timeZone}
        label={label}
        closedDays={closedDays}
        showDayHeadings={view === 'week'}
        onSelectEvent={onSelectEvent}
      />
    );
  }

  const columns: GridColumn[] =
    view === 'day'
      ? (resources.length > 0 ? resources : [{ id: '', label: formatDayLong(date) }]).map(
          (resource) => ({
            key: resource.id,
            date,
            resourceId: resource.id === '' ? null : resource.id,
            name: t('calendar.column', { name: resource.label }),
            heading: resource.label,
            ...(resource.description ? { subheading: resource.description } : {}),
            ...(closedDays[date] ? { closedName: closedDays[date] } : {}),
          }),
        )
      : weekDates(date).map((day) => ({
          key: day,
          date: day,
          resourceId: null,
          name: t('calendar.dayColumn', { day: formatDayLong(day) }),
          heading: dayHeading(day),
          ...(closedDays[day] ? { closedName: closedDays[day] } : {}),
          ...(onSelectDay
            ? {
                onSelect: () => {
                  onSelectDay(day);
                },
              }
            : {}),
        }));

  return (
    <TimeGrid
      columns={columns}
      events={events}
      backgrounds={backgrounds}
      timeZone={timeZone}
      label={label}
      hours={hours}
      now={now}
      onSelectEvent={onSelectEvent}
      onSelectSlot={onSelectSlot}
      onMoveEvent={onMoveEvent}
    />
  );
}
