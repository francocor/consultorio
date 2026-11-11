import { UserRoundCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useAppStatus } from '../../app/providers.js';
import { useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { formatDayLong } from '../../shared/lib/format.js';
import { Input, Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { AppointmentDrawer } from '../calendar/components/AppointmentDrawer.js';
import { FlowAction } from '../calendar/components/FlowAction.js';
import { FlowRow } from '../calendar/components/FlowRow.js';
import { useDayFlow } from '../calendar/containers/use-day-flow.js';
import { filterByPatient, groupByFlow } from '../calendar/domain/day-flow.js';

/** The front desk: who is still to arrive, who waits, who is in a consultation. */
export function CheckInPage() {
  return (
    <RequirePermission anyOf={['scheduling.checkin']}>
      <CheckIn />
    </RequirePermission>
  );
}

function CheckIn() {
  const { t } = useTranslation(['scheduling', 'common']);
  usePageTitle(t('scheduling:checkin.title'));
  const me = useMe();
  const status = useAppStatus();
  const [locationId, setLocationId] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<{ id: string; startWith?: 'check_in' } | null>(null);

  const { feed, timeZone, date, now, locations, professionals, ownProfessionalId } = useDayFlow({
    own: false,
    locationId,
  });
  const readOnly = status.readOnly || me.tenantStatus === 'read_only';
  const nameOf = (id: string) => professionals.find((person) => person.id === id)?.name;

  const all = feed.data?.appointments ?? [];
  const matches = filterByPatient(all, query);
  const flow = groupByFlow(matches);
  const total = groupByFlow(all);
  const dayIsEmpty =
    total.inProgress.length + total.waiting.length + total.upcoming.length + total.closed.length ===
    0;

  let body: ReactNode;
  if (feed.isError && !feed.data) {
    body = (
      <ErrorState
        error={feed.error}
        onRetry={() => {
          void feed.refetch();
        }}
      />
    );
  } else if (!feed.data) {
    body = <ListSkeleton rows={5} />;
  } else if (dayIsEmpty) {
    body = (
      <EmptyState
        icon={UserRoundCheck}
        title={t('scheduling:checkin.empty')}
        description={t('scheduling:checkin.emptyHelp')}
      />
    );
  } else if (
    flow.inProgress.length + flow.waiting.length + flow.upcoming.length + flow.closed.length ===
    0
  ) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {t('scheduling:checkin.noMatch')}
      </p>
    );
  } else {
    body = (
      <>
        <Section title={t('scheduling:today.upcoming')} show={flow.upcoming.length > 0}>
          {flow.upcoming.map((item) => (
            <FlowRow
              key={item.id}
              entry={item}
              timeZone={timeZone}
              professionalName={nameOf(item.professionalId)}
              onOpen={() => {
                setOpen({ id: item.id });
              }}
              action={
                readOnly || item.status === 'pending_approval' ? null : (
                  <FlowAction
                    entry={item}
                    step="check-in"
                    label={t('scheduling:drawer.action.check_in')}
                    // With the identity pending the step needs the ID document: open it instead.
                    beforeRun={() => {
                      if (item.identityConfirmed) return true;
                      setOpen({ id: item.id, startWith: 'check_in' });
                      return false;
                    }}
                  />
                )
              }
            />
          ))}
        </Section>
        <Section title={t('scheduling:today.waiting')} show={flow.waiting.length > 0}>
          {flow.waiting.map((item) => (
            <FlowRow
              key={item.id}
              entry={item}
              timeZone={timeZone}
              professionalName={nameOf(item.professionalId)}
              onOpen={() => {
                setOpen({ id: item.id });
              }}
            />
          ))}
        </Section>
        <Section title={t('scheduling:today.inProgress')} show={flow.inProgress.length > 0}>
          {flow.inProgress.map((item) => (
            <FlowRow
              key={item.id}
              entry={item}
              timeZone={timeZone}
              professionalName={nameOf(item.professionalId)}
              onOpen={() => {
                setOpen({ id: item.id });
              }}
            />
          ))}
        </Section>
        <Section title={t('scheduling:today.closed')} show={flow.closed.length > 0}>
          {flow.closed.map((item) => (
            <FlowRow
              key={item.id}
              entry={item}
              timeZone={timeZone}
              professionalName={nameOf(item.professionalId)}
              onOpen={() => {
                setOpen({ id: item.id });
              }}
            />
          ))}
        </Section>
      </>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader
        title={t('scheduling:checkin.title')}
        description={`${formatDayLong(date)}. ${t('scheduling:checkin.description')}`}
        className="mb-0"
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-0 flex-1 basis-56 gap-1.5">
          <Label htmlFor="checkin-search">{t('scheduling:checkin.search')}</Label>
          <Input
            id="checkin-search"
            type="search"
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        {locations.length > 1 ? (
          <div className="grid gap-1.5">
            <Label htmlFor="checkin-location">{t('scheduling:filter.location')}</Label>
            <Select
              id="checkin-location"
              value={locationId ?? ''}
              onChange={(event) => {
                setLocationId(event.target.value === '' ? undefined : event.target.value);
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
      </div>

      {body}

      <AppointmentDrawer
        key={open ? `${open.id}-${open.startWith ?? ''}` : 'closed'}
        appointmentId={open?.id ?? null}
        {...(open?.startWith ? { startWith: open.startWith } : {})}
        onClose={() => {
          setOpen(null);
        }}
        locations={locations}
        professionals={professionals}
        ownProfessionalId={ownProfessionalId}
        permissions={me.permissions}
        readOnly={readOnly}
        now={now}
      />
    </div>
  );
}

function Section({ title, show, children }: { title: string; show: boolean; children: ReactNode }) {
  if (!show) return null;
  return (
    <section aria-label={title} className="grid gap-2">
      <h2 className="font-display text-base font-semibold">{title}</h2>
      <ul className="grid gap-2">{children}</ul>
    </section>
  );
}
