import type { PublicConfirmationDto, PublicManageDto, PublicSlotDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, MapPin, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { formatDate, formatTime } from '../../shared/lib/format.js';
import { describeError } from '../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { Skeleton } from '../../shared/ui/skeleton.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';

import { bookingKeys, publicBookingApi } from './api/booking-api.js';
import { ConfirmationScreen } from './components/ConfirmationScreen.js';
import { DetailRow } from './components/DetailRow.js';
import { SlotPicker } from './components/SlotPicker.js';
import { UnavailablePage } from './components/UnavailablePage.js';
import { longDayLabel, slotLabel, todayIn, zoneLabel } from './domain/slots.js';

type Mode = 'view' | 'change';

/**
 * `/book/manage/{token}`: the page behind the link in the confirmation. It shows the appointment
 * (when, where, with whom; nothing of the patient), and until the organization's deadline lets the
 * patient move it to another time or cancel it. After the deadline it says to contact the
 * organization. A link that does not work is the same generic page as any other.
 */
export function ManagePage({ token }: { token: string }) {
  const { t } = useTranslation(['booking', 'common']);
  usePageTitle(t('booking:manage.title'));
  const api = publicBookingApi(useApi());
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('view');
  const [candidate, setCandidate] = useState<PublicSlotDto | null>(null);
  const [moved, setMoved] = useState<PublicConfirmationDto | null>(null);
  const [cancelled, setCancelled] = useState<PublicManageDto | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);

  const view = useQuery({
    queryKey: bookingKeys.manage(token),
    queryFn: () => api.manage(token),
    retry: false,
  });

  const reschedule = useMutation({
    mutationFn: (slot: PublicSlotDto) => api.reschedule(token, slot.startsAt),
    onSuccess: (confirmation) => {
      setMoved(confirmation);
    },
    onError: (error) => {
      // The time was taken meanwhile: the appointment stays, and the times are shown again.
      if (
        isApiError(error) &&
        (error.code === 'slot_taken' || error.code === 'slot_no_longer_available')
      ) {
        setCandidate(null);
        void queryClient.invalidateQueries({ queryKey: bookingKeys.manageSlots(token) });
      }
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.cancel(token),
    onSuccess: (done) => {
      setCancelOpen(false);
      setCancelled(done);
    },
  });

  if (moved) return <ConfirmationScreen confirmation={moved} moved />;

  if (cancelled) {
    return (
      <section aria-labelledby="cancelled-title" className="grid gap-3">
        <PageHeader
          title={t('booking:manage.cancelledTitle')}
          description={t('booking:manage.cancelledDescription')}
        />
        <span id="cancelled-title" className="sr-only">
          {t('booking:manage.cancelledTitle')}
        </span>
      </section>
    );
  }

  if (view.isPending) {
    return (
      <div role="status" aria-busy="true" className="grid gap-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (view.isError) {
    if (isApiError(view.error) && view.error.status === 404) return <UnavailablePage />;
    return (
      <ErrorState
        error={view.error}
        onRetry={() => {
          void view.refetch();
        }}
      />
    );
  }

  const page = view.data;
  const appointment = page.appointment;
  const zone = zoneLabel(appointment.timeZone, new Date(appointment.startsAt));
  const localDate = todayIn(appointment.timeZone, new Date(appointment.startsAt));
  const deadline = `${formatDate(page.changeDeadline, { timeZone: appointment.timeZone })} ${formatTime(page.changeDeadline, { timeZone: appointment.timeZone })}`;
  const failure = reschedule.isError ? describeError(t, reschedule.error) : null;
  const slotLost =
    reschedule.isError &&
    isApiError(reschedule.error) &&
    (reschedule.error.code === 'slot_taken' ||
      reschedule.error.code === 'slot_no_longer_available');

  return (
    <div className="grid gap-6">
      <PageHeader title={t('booking:manage.title')} description={t('booking:manage.description')} />

      <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm">
        <dl className="grid gap-4">
          <DetailRow icon={CalendarClock} label={t('booking:done.when')}>
            {longDayLabel(localDate)}, {slotLabel(appointment.startsAt, appointment.timeZone)}
            <span className="block text-xs font-normal text-muted-foreground">{zone}</span>
          </DetailRow>
          <DetailRow icon={MapPin} label={t('booking:done.where')}>
            {appointment.locationName}
          </DetailRow>
          <DetailRow icon={UserRound} label={t('booking:done.who')}>
            {appointment.professionalName}
          </DetailRow>
        </dl>
        <p className="font-medium">{t(`booking:manage.status.${appointment.status}`)}</p>
      </div>

      {appointment.status === 'cancelled' ? (
        <Alert tone="info">
          <AlertDescription>{t('booking:manage.cancelledInfo')}</AlertDescription>
        </Alert>
      ) : page.canChange ? (
        <p className="text-sm text-muted-foreground">
          {t('booking:manage.deadline', { when: deadline })}
        </p>
      ) : (
        <Alert tone="warning">
          <AlertDescription>{t('booking:manage.closed')}</AlertDescription>
        </Alert>
      )}

      {failure && !slotLost ? (
        <Alert tone="danger">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}
      {slotLost ? (
        <Alert tone="warning">
          <AlertDescription>{t('booking:manage.newSlotTaken')}</AlertDescription>
        </Alert>
      ) : null}
      {cancel.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, cancel.error).message}</AlertDescription>
        </Alert>
      ) : null}

      {page.canChange && mode === 'view' ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            onClick={() => {
              setMode('change');
            }}
          >
            {t('booking:manage.change')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setCancelOpen(true);
            }}
          >
            {t('booking:manage.cancel')}
          </Button>
        </div>
      ) : null}

      {page.canChange && mode === 'change' ? (
        <div className="grid gap-4">
          <h2 className="font-display text-lg font-semibold">{t('booking:manage.changeTitle')}</h2>
          {candidate ? (
            <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm">
              <p className="font-medium">
                {t('booking:hold.summary', {
                  day: longDayLabel(candidate.date),
                  time: slotLabel(candidate.startsAt, appointment.timeZone),
                })}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  loading={reschedule.isPending}
                  onClick={() => {
                    reschedule.mutate(candidate);
                  }}
                >
                  {reschedule.isPending
                    ? t('booking:manage.moving')
                    : t('booking:manage.changeConfirm')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setCandidate(null);
                    reschedule.reset();
                  }}
                >
                  {t('booking:manage.changeKeep')}
                </Button>
              </div>
            </div>
          ) : (
            <SlotPicker
              queryKey={bookingKeys.manageSlots(token)}
              load={(range) => api.manageSlots(token, range)}
              timeZone={appointment.timeZone}
              onPick={(slot) => {
                reschedule.reset();
                setCandidate(slot);
              }}
            />
          )}
          {!candidate ? (
            <Button
              variant="ghost"
              className="justify-self-start"
              onClick={() => {
                setMode('view');
              }}
            >
              {t('booking:manage.changeKeep')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('booking:manage.cancelTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('booking:manage.cancelDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('booking:manage.cancelKeep')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              disabled={cancel.isPending}
              onClick={(event) => {
                event.preventDefault();
                cancel.mutate();
              }}
            >
              {cancel.isPending
                ? t('booking:manage.cancelling')
                : t('booking:manage.cancelConfirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
