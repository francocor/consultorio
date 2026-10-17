import type { CalendarEntryDto } from '@consultorio/contracts';
import { Stethoscope } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useAppStatus } from '../../app/providers.js';
import { useMe } from '../../app/session.js';
import { SlotOutlet } from '../../app/slots.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { formatDayLong, formatTime } from '../../shared/lib/format.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { AppointmentDrawer } from '../calendar/components/AppointmentDrawer.js';
import { FlowAction } from '../calendar/components/FlowAction.js';
import { FlowRow } from '../calendar/components/FlowRow.js';
import { StartConsultation } from '../calendar/components/StartConsultation.js';
import { useDayFlow } from '../calendar/containers/use-day-flow.js';
import { consultationStep } from '../calendar/domain/consultation.js';

/**
 * The professional's day, made for a phone between patients: who is in the room, who is next
 * (one button to call them in), who is still to arrive and what is already done.
 */
export function TodayPage() {
  const { t } = useTranslation(['scheduling', 'common']);
  usePageTitle(t('scheduling:today.title'));
  const me = useMe();
  const status = useAppStatus();
  const { feed, flow, timeZone, date, now, locations, professionals, ownProfessionalId, people } =
    useDayFlow({ own: true });
  const [openId, setOpenId] = useState<string | null>(null);

  const readOnly = status.readOnly || me.tenantStatus === 'read_only';
  const isProfessional = ownProfessionalId !== null;
  /** What other features put beside an appointment of the day (joining a video call). */
  const slotActions = (item: CalendarEntryDto) => (
    <SlotOutlet slot="today-appointment" appointment={item} readOnly={readOnly} />
  );
  const stepOf = (item: CalendarEntryDto) =>
    consultationStep({
      status: item.status,
      identityConfirmed: item.identityConfirmed,
      isOwnProfessional: ownProfessionalId === item.professionalId,
      permissions: me.permissions,
      readOnly,
    });

  let body: ReactNode;
  if (people.isSuccess && !isProfessional) {
    body = (
      <EmptyState
        icon={Stethoscope}
        title={t('scheduling:today.professionalsOnly')}
        description={t('scheduling:today.professionalsOnlyHelp')}
      />
    );
  } else if (feed.isError && !feed.data) {
    body = (
      <ErrorState
        error={feed.error}
        onRetry={() => {
          void feed.refetch();
        }}
      />
    );
  } else if (!feed.data) {
    body = <ListSkeleton rows={4} />;
  } else if (
    flow.inProgress.length + flow.waiting.length + flow.upcoming.length + flow.closed.length ===
    0
  ) {
    body = (
      <EmptyState
        icon={Stethoscope}
        title={t('scheduling:today.empty')}
        description={t('scheduling:today.emptyHelp')}
      />
    );
  } else {
    body = (
      <>
        <ul aria-label={t('scheduling:today.summary')} className="flex flex-wrap gap-2 text-sm">
          {(
            [
              ['waiting', flow.waiting.length],
              ['upcoming', flow.upcoming.length],
              ['closed', flow.closed.length],
            ] as const
          ).map(([key, count]) => (
            <li key={key} className="tabular rounded-full border bg-card px-3 py-1 font-medium">
              {t(`scheduling:today.summaryItem.${key}`, { count })}
            </li>
          ))}
        </ul>

        {flow.next ? (
          <section
            aria-label={t('scheduling:today.next')}
            className="grid gap-3 rounded-lg border-2 border-primary bg-card p-4"
          >
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-primary-ink">
              {t('scheduling:today.next')}
            </h2>
            <div className="grid gap-1">
              <p className="font-display text-xl font-semibold">{flow.next.patientName}</p>
              <p className="text-sm text-muted-foreground">
                {t('scheduling:today.waitingSince', {
                  time: formatTime(flow.next.startsAt, { timeZone }),
                  type: flow.next.typeName,
                })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {readOnly ? null : stepOf(flow.next) === 'start' ? (
                <StartConsultation entry={flow.next} step="start" size="lg" />
              ) : (
                <FlowAction
                  entry={flow.next}
                  step="start"
                  size="lg"
                  label={t('scheduling:drawer.action.start')}
                />
              )}
              {slotActions(flow.next)}
            </div>
          </section>
        ) : null}

        <Section title={t('scheduling:today.inProgress')} show={flow.inProgress.length > 0}>
          {flow.inProgress.map((item) => (
            <FlowRow
              key={item.id}
              entry={item}
              timeZone={timeZone}
              onOpen={() => {
                setOpenId(item.id);
              }}
              action={
                readOnly ? (
                  slotActions(item)
                ) : (
                  <>
                    {slotActions(item)}
                    {stepOf(item) === 'open' ? (
                      <StartConsultation entry={item} step="open" />
                    ) : null}
                    <FlowAction
                      entry={item}
                      step="attend"
                      variant={stepOf(item) === 'open' ? 'outline' : 'default'}
                      label={t('scheduling:drawer.action.attend')}
                    />
                  </>
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
              action={slotActions(item)}
              onOpen={() => {
                setOpenId(item.id);
              }}
            />
          ))}
        </Section>
        <Section title={t('scheduling:today.upcoming')} show={flow.upcoming.length > 0}>
          {flow.upcoming.map((item) => (
            <FlowRow
              key={item.id}
              entry={item}
              timeZone={timeZone}
              action={slotActions(item)}
              onOpen={() => {
                setOpenId(item.id);
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
              onOpen={() => {
                setOpenId(item.id);
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
        title={t('scheduling:today.title')}
        description={formatDayLong(date)}
        className="mb-0"
      />
      {body}
      <AppointmentDrawer
        appointmentId={openId}
        onClose={() => {
          setOpenId(null);
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
