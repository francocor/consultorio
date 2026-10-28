import type { CalendarEntryDto, LocationDto, Permission } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { SlotOutlet } from '../../../app/slots.js';
import { formatDayLong, formatTime } from '../../../shared/lib/format.js';
import { useIsWideScreen } from '../../../shared/lib/use-media-query.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { localDateOf } from '../../../shared/ui/calendar/zoned-time.js';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../../shared/ui/sheet.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { DetailSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { calendarApi, calendarKeys, type SimpleTransition } from '../api/calendar-api.js';
import { useAppointmentAction } from '../containers/use-appointment-action.js';
import type { SchedulingProfessional } from '../containers/use-scheduling-people.js';
import { availableActions, type DrawerAction } from '../domain/appointment-actions.js';
import { STATUS_PRESENTATION, statusLabel } from '../domain/calendar-events.js';
import { consultationStep } from '../domain/consultation.js';

import { AppointmentHistory } from './drawer/AppointmentHistory.js';
import { CancelPanel } from './drawer/CancelPanel.js';
import { CheckInPanel } from './drawer/CheckInPanel.js';
import { CorrectPanel } from './drawer/CorrectPanel.js';
import { ErrorNotice } from './drawer/ErrorNotice.js';
import { ReschedulePanel } from './drawer/ReschedulePanel.js';
import { StartConsultation } from './StartConsultation.js';

type Panel = 'check_in' | 'cancel' | 'reschedule' | 'correct';

const SIMPLE: Partial<Record<DrawerAction, SimpleTransition>> = {
  approve: 'approve',
  confirm: 'confirm',
  start: 'start',
  attend: 'attend',
  no_show: 'no-show',
};

const OPENS_PANEL: Partial<Record<DrawerAction, Panel>> = {
  cancel: 'cancel',
  reschedule: 'reschedule',
  correct: 'correct',
};

export interface AppointmentDrawerProps {
  /** The appointment to show; `null` keeps the drawer closed. */
  appointmentId: string | null;
  onClose: () => void;
  locations: readonly LocationDto[];
  professionals: readonly SchedulingProfessional[];
  /** The professional the signed-in person is, if they are one. */
  ownProfessionalId: string | null;
  permissions: readonly Permission[];
  /** The organization is read-only: only cancelling stays possible. */
  readOnly: boolean;
  now?: Date;
  /** Open straight on a step (the front desk's "Registrar llegada" with the identity pending). */
  startWith?: 'check_in';
}

/**
 * One appointment, with what can be done to it. Only the actions the lifecycle allows from its
 * status (and the person's permissions cover) are offered; each one that needs more than a click
 * opens a step inside the drawer: arrival and identity, cancellation, a move, a correction.
 */
export function AppointmentDrawer(props: AppointmentDrawerProps) {
  const wide = useIsWideScreen();
  return (
    <Sheet
      open={props.appointmentId !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetContent
        side={wide ? 'right' : 'bottom'}
        className="overflow-y-auto sm:w-[30rem] sm:max-w-[90vw]"
        aria-describedby={undefined}
      >
        {props.appointmentId === null ? null : (
          <DrawerBody key={props.appointmentId} {...props} appointmentId={props.appointmentId} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function DrawerBody({
  appointmentId,
  locations,
  professionals,
  ownProfessionalId,
  permissions,
  readOnly,
  now,
  startWith,
}: AppointmentDrawerProps & { appointmentId: string }) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const [panel, setPanel] = useState<Panel | null>(startWith ?? null);
  const [notice, setNotice] = useState<string | null>(null);

  const appointment = useQuery({
    queryKey: calendarKeys.appointment(appointmentId),
    queryFn: () => calendarApi(api).get(appointmentId),
    staleTime: 0,
  });
  const history = useQuery({
    queryKey: calendarKeys.history(appointmentId),
    queryFn: () => calendarApi(api).history(appointmentId),
    staleTime: 0,
  });

  if (appointment.isPending) {
    return (
      <>
        <SheetTitle>{t('scheduling:drawer.loading')}</SheetTitle>
        <DetailSkeleton />
      </>
    );
  }
  if (appointment.isError) {
    return (
      <>
        <SheetTitle>{t('scheduling:drawer.title')}</SheetTitle>
        <ErrorState
          error={appointment.error}
          onRetry={() => {
            void appointment.refetch();
          }}
        />
      </>
    );
  }

  const entry = appointment.data;
  const location = locations.find((item) => item.id === entry.locationId);
  const timeZone = location?.timeZone ?? 'America/Argentina/Buenos_Aires';
  const professional = professionals.find((item) => item.id === entry.professionalId);
  const isOwnProfessional = ownProfessionalId === entry.professionalId;
  const { icon: StatusIcon, tone } = STATUS_PRESENTATION[entry.status];
  const actions = availableActions({
    status: entry.status,
    startsAt: entry.startsAt,
    now: now ?? new Date(),
    permissions,
    isOwnProfessional,
  });

  const finish = (message: string) => () => {
    toast.success(message);
    setPanel(null);
    setNotice(null);
  };

  return (
    <>
      <div className="grid gap-2 pr-8">
        <SheetTitle>{entry.patientName}</SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-2">
          <Badge tone={tone}>
            <StatusIcon aria-hidden="true" />
            {statusLabel(t, entry.status)}
          </Badge>
          <Link
            to="/patients/$patientId"
            params={{ patientId: entry.patientId }}
            className="link-target text-sm font-medium text-primary-ink underline-offset-4 hover:underline"
          >
            {t('scheduling:drawer.patientLink')}
          </Link>
        </SheetDescription>
      </div>

      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
        <Row label={t('scheduling:drawer.when')}>
          <span className="tabular">
            {`${formatDayLong(localDateOf(entry.startsAt, timeZone))}, ${t(
              'scheduling:calendar.eventTime',
              {
                start: formatTime(entry.startsAt, { timeZone }),
                end: formatTime(entry.endsAt, { timeZone }),
              },
            )}`}
          </span>
        </Row>
        <Row label={t('scheduling:booking.professional')}>{professional?.name ?? '-'}</Row>
        <Row label={t('scheduling:booking.location')}>{location?.name ?? '-'}</Row>
        <Row label={t('scheduling:booking.type')}>{entry.typeName}</Row>
        {entry.outOfHours ? (
          <Row label={t('scheduling:drawer.flags')}>{t('scheduling:event.outOfHours')}</Row>
        ) : null}
        {entry.seriesId !== null && entry.seriesIndex !== null ? (
          <Row label={t('scheduling:drawer.series')}>
            {t('scheduling:drawer.seriesSession', { index: entry.seriesIndex })}
          </Row>
        ) : null}
      </dl>

      {entry.identityConfirmed ? null : (
        <Alert tone="warning">
          <AlertDescription>{t('scheduling:drawer.identityPending')}</AlertDescription>
        </Alert>
      )}
      {notice ? (
        <Alert tone="info">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {panel === null ? (
        <ActionBar
          entry={entry}
          actions={actions}
          consultation={consultationStep({
            status: entry.status,
            identityConfirmed: entry.identityConfirmed,
            isOwnProfessional,
            permissions,
            readOnly,
          })}
          readOnly={readOnly}
          onPanel={setPanel}
          onDone={() => {
            setNotice(null);
          }}
        />
      ) : null}

      {panel === 'check_in' ? (
        <CheckInPanel
          entry={entry}
          isOwnProfessional={isOwnProfessional}
          onBack={() => {
            setPanel(null);
          }}
          onDone={(updated, asked) => {
            finish(t('scheduling:drawer.done.check_in'))();
            if (asked && !updated.identityConfirmed) {
              setNotice(t('scheduling:drawer.identityNotAccepted'));
            }
          }}
        />
      ) : null}
      {panel === 'cancel' ? (
        <CancelPanel
          entry={entry}
          readOnly={readOnly}
          onBack={() => {
            setPanel(null);
          }}
          onDone={finish(t('scheduling:drawer.done.cancel'))}
        />
      ) : null}
      {panel === 'reschedule' ? (
        <ReschedulePanel
          entry={entry}
          professionals={professionals}
          location={location}
          onBack={() => {
            setPanel(null);
          }}
          onDone={finish(t('scheduling:drawer.done.reschedule'))}
        />
      ) : null}
      {panel === 'correct' ? (
        <CorrectPanel
          entry={entry}
          isOwnProfessional={isOwnProfessional}
          onBack={() => {
            setPanel(null);
          }}
          onDone={finish(t('scheduling:drawer.done.correct'))}
        />
      ) : null}

      <SlotOutlet slot="appointment-drawer" appointment={entry} readOnly={readOnly} />

      {history.isSuccess ? (
        <AppointmentHistory history={history.data} timeZone={timeZone} />
      ) : history.isError ? (
        <ErrorNotice error={history.error} />
      ) : null}
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </>
  );
}

/** The buttons for what can be done now. A lifecycle step is one click; the rest open a panel. */
function ActionBar({
  entry,
  actions,
  consultation,
  readOnly,
  onPanel,
  onDone,
}: {
  entry: CalendarEntryDto;
  actions: readonly DrawerAction[];
  /** How the professional of the appointment reaches the clinical record from here, if they can. */
  consultation: 'start' | 'open' | null;
  readOnly: boolean;
  onPanel: (panel: Panel) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(['scheduling', 'common']);
  // One mutation for every step that is a single click: the lifecycle words and the plain check-in.
  const transition = useAppointmentAction(
    entry,
    (client, step: SimpleTransition | 'check-in') =>
      step === 'check-in'
        ? client.checkIn(entry.id, { expectedVersion: entry.version })
        : client.transition(entry.id, step, entry.version),
    () => {
      onDone();
    },
  );

  function run(action: DrawerAction) {
    const simple = SIMPLE[action];
    if (simple) {
      transition.mutate(simple, {
        onSuccess: () => {
          toast.success(t(`scheduling:drawer.done.${action}`));
        },
      });
      return;
    }
    if (action === 'check_in') {
      if (entry.identityConfirmed) {
        transition.mutate('check-in', {
          onSuccess: () => {
            toast.success(t('scheduling:drawer.done.check_in'));
          },
        });
      } else {
        onPanel('check_in');
      }
      return;
    }
    const panel = OPENS_PANEL[action];
    if (panel) onPanel(panel);
  }

  const busy = transition.isPending;
  const error = transition.error;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {consultation === 'open' ? <StartConsultation entry={entry} step="open" /> : null}
        {actions.map((action) => {
          // Calling the patient in is also the way into the encounter (decision D20).
          if (action === 'start' && consultation === 'start') {
            return <StartConsultation key={action} entry={entry} step="start" />;
          }
          // Cancelling is a patient-protective write: it stays possible when the organization is
          // read-only. Everything else is refused there, so it is shown off, with the reason.
          const blocked = readOnly && action !== 'cancel';
          return (
            <Button
              key={action}
              type="button"
              variant={action === 'cancel' ? 'outline' : 'secondary'}
              aria-disabled={blocked || busy ? true : undefined}
              aria-describedby={blocked ? 'drawer-read-only' : undefined}
              onClick={() => {
                if (!blocked && !busy) run(action);
              }}
            >
              {t(`scheduling:drawer.action.${action}`)}
            </Button>
          );
        })}
      </div>
      {readOnly ? (
        <span id="drawer-read-only" className="sr-only">
          {t('common:state.readOnly.disabledReason')}
        </span>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
