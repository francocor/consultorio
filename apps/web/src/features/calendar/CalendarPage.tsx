import { useNavigate, useSearch } from '@tanstack/react-router';
import { CalendarPlus, UserRoundPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppStatus } from '../../app/providers.js';
import { useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { useIsWideScreen } from '../../shared/lib/use-media-query.js';
import { useNow } from '../../shared/lib/use-now.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { CalendarView } from '../../shared/ui/calendar/CalendarView.js';
import { localDateOf } from '../../shared/ui/calendar/zoned-time.js';
import { Switch } from '../../shared/ui/checkbox.js';
import { Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { BookingDialog, type BookingInitial } from './components/BookingDialog.js';
import { CalendarToolbar } from './components/CalendarToolbar.js';
import { ProfessionalFilter } from './components/ProfessionalFilter.js';
import { StatusLegend } from './components/StatusLegend.js';
import { useCalendar } from './containers/use-calendar.js';
import { useMoveAppointment } from './containers/use-move-appointment.js';
import {
  useSchedulingLocations,
  useSchedulingProfessionals,
  type SchedulingProfessional,
} from './containers/use-scheduling-people.js';
import { backgroundsOf, closedDaysOf, toCalendarEvent } from './domain/calendar-events.js';
import { movePeriod, periodLabel, regionLabelKey } from './domain/period.js';
import { resolveTimeZone } from './domain/time-zone.js';
import { prosOf, validateCalendarSearch, type CalendarSearch } from './search.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Roles that work in every calendar of their locations; a professional works in their own. */
function worksInEveryCalendar(roles: readonly string[]): boolean {
  return roles.some((role) => role === 'owner' || role === 'admin' || role === 'reception');
}

/**
 * The professionals the person may put on screen: everybody for reception and administration, and
 * for a professional their own agenda plus the colleagues whose calendar was delegated to them.
 */
function visibleProfessionals(input: {
  professionals: readonly SchedulingProfessional[];
  ownProfessionalId: string | null;
  everyCalendar: boolean;
  delegated: boolean;
  locationId: string | undefined;
}): SchedulingProfessional[] {
  const byLocation = input.professionals.filter(
    (professional) =>
      input.locationId === undefined ||
      professional.locationIds.length === 0 ||
      professional.locationIds.includes(input.locationId),
  );
  if (input.everyCalendar || input.delegated) return byLocation;
  return byLocation.filter((professional) => professional.id === input.ownProfessionalId);
}

/** The agenda: day, week or month, with a column per professional. */
export function CalendarPage() {
  const { t } = useTranslation(['scheduling', 'common']);
  usePageTitle(t('scheduling:title'));
  const me = useMe();
  const wide = useIsWideScreen();
  const now = useNow();
  const navigate = useNavigate();
  const rawSearch: unknown = useSearch({ strict: false });
  const search = validateCalendarSearch(isRecord(rawSearch) ? rawSearch : {});

  const appStatus = useAppStatus();
  const [booking, setBooking] = useState<{ initial: BookingInitial } | null>(null);

  const { locations } = useSchedulingLocations();
  const { professionals, ownProfessionalId, query: peopleQuery } = useSchedulingProfessionals();

  const timeZone = resolveTimeZone(locations, search.location);
  const date = search.date ?? localDateOf(now, timeZone);
  const everyCalendar = worksInEveryCalendar(me.roles);
  const delegated = me.permissions.includes('scheduling.delegated_calendar');
  const people = visibleProfessionals({
    professionals,
    ownProfessionalId,
    everyCalendar,
    delegated,
    locationId: search.location,
  });

  const chosen = prosOf(search).filter((id) => people.some((person) => person.id === id));
  const columns =
    chosen.length > 0 ? people.filter((person) => chosen.includes(person.id)) : people;
  // A professional is always asked for by name, so the answer is exactly their own agenda.
  const mustNameThem = !everyCalendar && !delegated;
  const requested = mustNameThem ? (ownProfessionalId === null ? [] : [ownProfessionalId]) : chosen;

  const { feed } = useCalendar({
    view: search.view,
    date,
    timeZone,
    professionalIds: requested,
    locationId: search.location,
    enabled: !mustNameThem || ownProfessionalId !== null || peopleQuery.isError,
  });

  function update(patch: Partial<CalendarSearch>, options: { push?: boolean } = {}) {
    void navigate({
      to: '/calendar',
      search: (previous: Record<string, unknown>) => {
        const next = { ...validateCalendarSearch(previous), ...patch };
        return {
          view: next.view,
          date: next.date,
          location: next.location,
          pros: next.pros,
          cancelled: next.cancelled,
          list: next.list,
          appointment: next.appointment,
        };
      },
      replace: options.push !== true,
    });
  }

  const nameOf = new Map(professionals.map((person) => [person.id, person.name]));
  const canBook = me.permissions.includes('scheduling.book');
  const readOnly = appStatus.readOnly || me.tenantStatus === 'read_only';
  const canMove = canBook && !readOnly;
  const mover = useMoveAppointment({ timeZone });
  const feedData = feed.data;
  const events = (feedData?.appointments ?? [])
    .filter((entry) => search.cancelled === true || entry.status !== 'cancelled')
    .map((entry) =>
      toCalendarEvent(entry, {
        resourceLabel:
          nameOf.get(entry.professionalId) ?? t('scheduling:event.professionalFallback'),
        t,
        canMove,
      }),
    );
  const backgrounds = backgroundsOf(feedData?.blocks ?? [], search.location);
  const closedDays = closedDaysOf(feedData?.holidays ?? [], search.location);

  const period = periodLabel(search.view, date);
  const presentation = !wide || search.list === true ? 'list' : 'grid';
  const resources = columns.map((person) => ({
    id: person.id,
    label: person.name,
    ...(person.specialties[0] ? { description: person.specialties[0] } : {}),
  }));

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader
        title={t('scheduling:title')}
        description={t('scheduling:description')}
        className="mb-0"
        actions={
          canBook ? (
            <>
              <Button
                aria-disabled={readOnly}
                aria-describedby={readOnly ? 'booking-read-only' : undefined}
                onClick={() => {
                  if (readOnly) return;
                  const only = columns.length === 1 ? columns[0] : undefined;
                  setBooking({
                    initial: {
                      date,
                      ...(only ? { professionalId: only.id } : {}),
                      ...(search.location ? { locationId: search.location } : {}),
                    },
                  });
                }}
              >
                <CalendarPlus aria-hidden="true" />
                {t('scheduling:booking.open')}
              </Button>
              {readOnly ? (
                <span id="booking-read-only" className="sr-only">
                  {t('common:state.readOnly.disabledReason')}
                </span>
              ) : null}
            </>
          ) : null
        }
      />

      <CalendarToolbar
        view={search.view}
        period={period}
        wide={wide}
        list={search.list === true}
        onView={(view) => {
          update({ view });
        }}
        onList={(list) => {
          update({ list: list ? true : undefined });
        }}
        onPrevious={() => {
          update({ date: movePeriod(search.view, date, -1) });
        }}
        onNext={() => {
          update({ date: movePeriod(search.view, date, 1) });
        }}
        onToday={() => {
          update({ date: undefined });
        }}
      />

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        {locations.length > 1 ? (
          <div className="grid gap-1.5">
            <Label htmlFor="calendar-location">{t('scheduling:filter.location')}</Label>
            <Select
              id="calendar-location"
              value={search.location ?? ''}
              onChange={(event) => {
                update({
                  location: event.target.value === '' ? undefined : event.target.value,
                  pros: undefined,
                });
              }}
            >
              <option value="">{t('scheduling:filter.allLocations')}</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {people.length > 1 ? (
          <div className="min-w-0 flex-1 basis-64">
            <ProfessionalFilter
              professionals={people}
              selected={chosen}
              onChange={(ids) => {
                update({ pros: ids.length > 0 ? ids.join(',') : undefined });
              }}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id="calendar-cancelled"
            checked={search.cancelled === true}
            onCheckedChange={(checked) => {
              update({ cancelled: checked ? true : undefined });
            }}
          />
          <Label htmlFor="calendar-cancelled">{t('scheduling:filter.showCancelled')}</Label>
        </div>
      </div>

      <StatusLegend open={wide} />

      {feedData?.truncated === true ? (
        <Alert tone="warning">
          <AlertDescription>{t('scheduling:calendar.truncated')}</AlertDescription>
        </Alert>
      ) : null}

      {feed.isError && !feedData ? (
        <ErrorState
          error={feed.error}
          onRetry={() => {
            void feed.refetch();
          }}
        />
      ) : feed.isPending || (peopleQuery.isPending && search.view === 'day') ? (
        <ListSkeleton rows={6} />
      ) : search.view === 'day' && resources.length === 0 ? (
        <EmptyState
          icon={UserRoundPlus}
          title={t('scheduling:noProfessionals.title')}
          description={t('scheduling:noProfessionals.description')}
        />
      ) : (
        <CalendarView
          view={search.view}
          date={date}
          timeZone={timeZone}
          label={t(`scheduling:${regionLabelKey(search.view)}`, { period })}
          resources={resources}
          events={events}
          backgrounds={backgrounds}
          closedDays={closedDays}
          presentation={presentation}
          now={now}
          onSelectEvent={(id) => {
            update({ appointment: id }, { push: true });
          }}
          onSelectDay={(day) => {
            update({ view: 'day', date: day });
          }}
          {...(canMove
            ? {
                onSelectSlot: ({ resourceId, start }) => {
                  setBooking({
                    initial: {
                      start,
                      ...(resourceId === null
                        ? chosen.length === 1
                          ? { professionalId: chosen[0] }
                          : {}
                        : { professionalId: resourceId }),
                      ...(search.location ? { locationId: search.location } : {}),
                    },
                  });
                },
                onMoveEvent: ({ id, resourceId, start }) => {
                  const entry = feedData?.appointments.find((item) => item.id === id);
                  if (entry) mover.move(entry, { start, professionalId: resourceId });
                },
              }
            : {})}
        />
      )}

      {canBook ? (
        <BookingDialog
          open={booking !== null}
          onOpenChange={(open) => {
            if (!open) setBooking(null);
          }}
          professionals={people}
          locations={locations}
          initial={booking?.initial}
          canOverrideHours={me.permissions.includes('scheduling.override_hours')}
        />
      ) : null}
    </div>
  );
}
