import type { PortalAppointmentDto, PortalLinkDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, MapPin, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../../../shared/ui/alert-dialog.js';
import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { toast } from '../../../shared/ui/toaster.js';
import { portalApi, portalKeys } from '../api/portal-api.js';
import { QueryState } from '../components/QueryState.js';

const TONES: Record<string, BadgeTone> = {
  scheduled: 'info',
  confirmed: 'success',
  pending_approval: 'warning',
  checked_in: 'info',
  in_progress: 'info',
  attended: 'neutral',
  no_show: 'danger',
  cancelled: 'neutral',
};

function AppointmentCard({
  appointment,
  link,
}: {
  appointment: PortalAppointmentDto;
  link: PortalLinkDto;
}) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: portalKeys.section(link.id, 'appointments') });
  const confirm = useMutation({
    mutationFn: () => api.confirmAppointment(appointment.id),
    onSuccess: async () => {
      toast.success(t('appointments.confirmed'));
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelAppointment(appointment.id),
    onSuccess: async () => {
      toast.success(t('appointments.cancelled'));
      await refresh();
    },
  });
  const error = confirm.error ?? cancel.error;
  const when = formatDateTime(appointment.startsAt, { timeZone: appointment.timeZone });
  const open =
    appointment.status === 'scheduled' ||
    appointment.status === 'confirmed' ||
    appointment.status === 'pending_approval';
  const pastDeadline = open && !appointment.canCancel && appointment.cancelDeadline !== null;

  return (
    <li className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <CalendarClock className="size-4 shrink-0 text-primary-ink" aria-hidden="true" />
          <time dateTime={appointment.startsAt}>{when}</time>
        </p>
        <Badge tone={TONES[appointment.status] ?? 'neutral'}>
          {t(`appointments.status.${appointment.status}`)}
        </Badge>
      </div>
      <dl className="grid gap-1 text-sm">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('appointments.type')}</dt>
          <dd>{appointment.typeName}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('appointments.professional')}</dt>
          <dd>{appointment.professionalName}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">
            <MapPin className="size-4" aria-hidden="true" />
            <span className="sr-only">{t('appointments.place')}</span>
          </dt>
          <dd>{appointment.locationName}</dd>
        </div>
      </dl>

      {appointment.mode === 'virtual' ? (
        <div className="text-sm">
          {appointment.joinUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={appointment.joinUrl} target="_blank" rel="noreferrer noopener">
                <Video aria-hidden="true" />
                {t('appointments.join')}
              </a>
            </Button>
          ) : appointment.joinPending ? (
            <p className="text-muted-foreground">{t('appointments.joinPending')}</p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {describeError(t, error).message}
        </p>
      ) : null}

      {appointment.canConfirm || appointment.canCancel ? (
        <div className="flex flex-wrap gap-2">
          {appointment.canConfirm ? (
            <Button
              size="sm"
              loading={confirm.isPending}
              onClick={() => {
                confirm.mutate();
              }}
            >
              {t('appointments.confirm')}
            </Button>
          ) : null}
          {appointment.canCancel ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm">
                  {t('appointments.cancel')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('appointments.cancelDialog.title')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('appointments.cancelDialog.description', { when })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('appointments.cancelDialog.keep')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      cancel.mutate();
                    }}
                  >
                    {t('appointments.cancelDialog.confirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      ) : null}
      {pastDeadline ? (
        <p className="text-sm text-muted-foreground">{t('appointments.pastDeadline')}</p>
      ) : null}
    </li>
  );
}

/** Upcoming appointments, with what the patient can do about each, and the recent past ones. */
export function AppointmentsSection({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const query = useQuery({
    queryKey: portalKeys.section(link.id, 'appointments'),
    queryFn: () => api.appointments(),
  });
  return (
    <section>
      <PageHeader title={t('appointments.title')} description={t('appointments.description')} />
      <QueryState
        query={query}
        isEmpty={(data) => data.upcoming.length === 0 && data.past.length === 0}
        empty={
          <EmptyState
            icon={CalendarClock}
            title={t('appointments.empty.title')}
            description={t('appointments.empty.description')}
          />
        }
      >
        {(data) => (
          <div className="grid gap-6">
            <div className="grid gap-3">
              <h2 className="font-display text-lg font-semibold">{t('appointments.upcoming')}</h2>
              {data.upcoming.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('appointments.noUpcoming')}</p>
              ) : (
                <ul className="grid gap-3">
                  {data.upcoming.map((appointment) => (
                    <AppointmentCard key={appointment.id} appointment={appointment} link={link} />
                  ))}
                </ul>
              )}
            </div>
            {data.past.length > 0 ? (
              <div className="grid gap-3">
                <h2 className="font-display text-lg font-semibold">{t('appointments.past')}</h2>
                <ul className="grid gap-3">
                  {data.past.map((appointment) => (
                    <AppointmentCard key={appointment.id} appointment={appointment} link={link} />
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </QueryState>
    </section>
  );
}
