import { useMutation, useQuery } from '@tanstack/react-query';
import { Video } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import type { SlotProps } from '../../../app/registry.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../../shared/api/locations-api.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatTime } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { videoApi, videoKeys } from '../api/video-api.js';
import { pendingReasonKey } from '../domain/summary-text.js';

import { ManualLinkDialog } from './ManualLinkDialog.js';

/** While a room is being created the panel asks again every few seconds; otherwise once a minute. */
const CREATING_REFRESH_MS = 3_000;
const IDLE_REFRESH_MS = 60_000;

/** A person who may not see this appointment gets no panel, not an error. */
const NOT_FOR_THIS_PERSON = new Set([403, 404]);

/**
 * The video side of an appointment, inside the appointment drawer: that it is virtual (never the
 * link itself), whether it has a link, the "Join" action for the assigned professional while the
 * window is open, whether the patient opened the link, and the alert with the manual-link fallback
 * when the room could not be created. An appointment in person shows nothing.
 */
export function VideoSessionPanel({ appointment, readOnly }: SlotProps['appointment-drawer']) {
  const { t } = useTranslation(['teleconsultation']);
  const api = useApi();
  const [attaching, setAttaching] = useState(false);

  const summary = useQuery({
    queryKey: videoKeys.summary(appointment.id, appointment.version),
    queryFn: () => videoApi(api).summary(appointment.id),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.pendingReason === 'creating' ? CREATING_REFRESH_MS : IDLE_REFRESH_MS,
  });
  const locations = useQuery({
    queryKey: LOCATIONS_QUERY_KEY,
    queryFn: () => locationsApi(api).list(),
    staleTime: 5 * 60_000,
  });
  const timeZone = locations.data?.find((place) => place.id === appointment.locationId)?.timeZone;

  const join = useMutation({
    mutationFn: () => videoApi(api).join(appointment.id),
    onSuccess: ({ url }) => {
      // A new tab that cannot reach this one or learn where it came from.
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  });

  if (summary.isError) {
    if (isApiError(summary.error) && NOT_FOR_THIS_PERSON.has(summary.error.status)) return null;
    return (
      <Alert tone="danger">
        <AlertDescription>
          {t('teleconsultation:panel.error')}
          <Button
            variant="link"
            className="ml-2"
            onClick={() => {
              void summary.refetch();
            }}
          >
            {t('teleconsultation:panel.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const video = summary.data;
  if (!video?.virtual) return null;

  const at = (instant: string) => formatTime(instant, timeZone ? { timeZone } : {});
  const pending = video.status === 'link_pending';
  const closed = video.status === 'closed';
  const linkLabel = closed
    ? t('teleconsultation:link.closed')
    : pending
      ? t('teleconsultation:link.none')
      : video.manual
        ? t('teleconsultation:link.manual')
        : t('teleconsultation:link.ready');

  return (
    <section
      aria-labelledby="video-session-title"
      className="mt-4 grid gap-3 rounded-lg border bg-card p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="video-session-title" className="flex items-center gap-2 font-medium">
          <Video className="size-4" aria-hidden="true" />
          {t('teleconsultation:panel.title')}
        </h3>
        <Badge tone="info">{t('teleconsultation:panel.virtual')}</Badge>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">{t('teleconsultation:link.state')}</dt>
        <dd className="font-medium">{linkLabel}</dd>
      </dl>

      {closed ? (
        <p className="text-muted-foreground">{t('teleconsultation:closed')}</p>
      ) : (
        <>
          {video.window ? (
            <p className="text-muted-foreground">
              {t('teleconsultation:window', {
                opens: at(video.window.opensAt),
                closes: at(video.window.closesAt),
              })}
            </p>
          ) : null}

          {pending ? (
            <Alert tone="warning">
              <AlertTitle>{t('teleconsultation:pending.title')}</AlertTitle>
              <AlertDescription>{t(pendingReasonKey(video.pendingReason))}</AlertDescription>
            </Alert>
          ) : null}

          {video.canJoin && !readOnly ? (
            <div className="grid gap-2">
              <Button
                loading={join.isPending}
                onClick={() => {
                  join.mutate();
                }}
              >
                {t('teleconsultation:join')}
              </Button>
              {join.isError ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {describeError(t, join.error).message}
                </p>
              ) : null}
            </div>
          ) : null}

          <p className="text-muted-foreground">
            {video.patientOpenedLink && video.firstOpenedAt
              ? t('teleconsultation:opened.yes', { time: at(video.firstOpenedAt) })
              : t('teleconsultation:opened.no')}
          </p>
          {video.patientOpenedLink ? (
            <p className="text-xs text-muted-foreground">{t('teleconsultation:opened.note')}</p>
          ) : null}
          {video.noShowAllowedFrom ? (
            <p className="text-muted-foreground">
              {t('teleconsultation:noShow', { time: at(video.noShowAllowedFrom) })}
            </p>
          ) : null}

          {video.canAttachManualLink && !readOnly ? (
            <div>
              <Button
                variant={pending ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => {
                  setAttaching(true);
                }}
              >
                {video.manual
                  ? t('teleconsultation:manual.replace')
                  : t('teleconsultation:manual.open')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {attaching ? (
        <ManualLinkDialog
          appointmentId={appointment.id}
          onClose={() => {
            setAttaching(false);
          }}
        />
      ) : null}
    </section>
  );
}
