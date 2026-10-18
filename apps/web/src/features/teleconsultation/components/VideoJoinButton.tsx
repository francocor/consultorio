import { useMutation, useQuery } from '@tanstack/react-query';
import { Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import type { SlotProps } from '../../../app/registry.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Button } from '../../../shared/ui/button.js';
import { videoApi, videoKeys } from '../api/video-api.js';

/** The summary is read again each minute: the window opens while the screen is on. */
const REFRESH_MS = 60_000;

/**
 * The "join" button of the professional's day: for a virtual appointment, while the API says the
 * window is open and this person is its professional, it opens the video call in a new tab. Nothing
 * for an appointment in person (the feed already says so, so no request is made), for a read-only
 * organization, or for anybody the API does not let join.
 */
export function VideoJoinButton({ appointment, readOnly }: SlotProps['today-appointment']) {
  const { t } = useTranslation(['teleconsultation']);
  const api = useApi();
  const virtual = appointment.mode === 'virtual' && !readOnly;

  const summary = useQuery({
    queryKey: videoKeys.summary(appointment.id, appointment.version),
    queryFn: () => videoApi(api).summary(appointment.id),
    enabled: virtual,
    staleTime: 0,
    refetchInterval: REFRESH_MS,
    // A 403 or 404 means "not for you": asking again changes nothing.
    retry: false,
  });
  const join = useMutation({
    mutationFn: () => videoApi(api).join(appointment.id),
    onSuccess: ({ url }) => {
      // A new tab that cannot reach this one or learn where it came from.
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  });

  if (!virtual || !summary.data?.canJoin) return null;
  return (
    <div className="grid gap-1">
      <Button
        size="sm"
        loading={join.isPending}
        onClick={() => {
          join.mutate();
        }}
      >
        <Video aria-hidden="true" />
        {t('teleconsultation:join')}
      </Button>
      {join.isError ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {describeError(t, join.error).message}
        </p>
      ) : null}
    </div>
  );
}
