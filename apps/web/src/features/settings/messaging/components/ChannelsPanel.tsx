import type {
  ChannelStateDto,
  MessageChannel,
  PatientChannelsResponse,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { hasAnyPermission, useMe } from '../../../../app/session.js';
import { formatDate } from '../../../../shared/lib/format.js';
import { describeError } from '../../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Badge, type BadgeTone } from '../../../../shared/ui/badge.js';
import { Button } from '../../../../shared/ui/button.js';
import { ErrorState } from '../../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../../shared/ui/toaster.js';
import { messagingApi, messagingKeys } from '../api/messaging-api.js';

/** The labels are long sentences: on a phone they wrap instead of pushing the page sideways. */
const WRAP = 'h-auto max-w-full whitespace-normal py-2 text-center';

const TONE: Record<ChannelStateDto['state'], BadgeTone> = {
  default: 'success',
  none: 'neutral',
  opted_in: 'success',
  opted_out: 'danger',
};

/**
 * The channels of a patient, as a tab of the patient record. It shows what the patient chose and
 * where it was recorded; reception can record what the patient says in person, send the WhatsApp
 * request by email, and record a baja. The control to switch a channel back on is disabled, with
 * the reason, when the patient opted out: only the patient can do that.
 */
export function ChannelsPanel({ patientId }: { patientId: string }) {
  const { t } = useTranslation(['messaging', 'common']);
  const api = useApi();
  const me = useMe();
  const queryClient = useQueryClient();
  const key = messagingKeys.channels(patientId);
  const canWrite = hasAnyPermission(me.permissions, ['patients.write']);
  const [leaving, setLeaving] = useState<MessageChannel | null>(null);

  const channels = useQuery({
    queryKey: key,
    queryFn: () => messagingApi(api).channels(patientId),
  });

  const onRecorded = (updated: PatientChannelsResponse) => {
    toast.success(t('messaging:channels.recorded'));
    queryClient.setQueryData(key, updated);
  };
  const optIn = useMutation({
    mutationFn: (channel: MessageChannel) => messagingApi(api).optIn(patientId, channel),
    onSuccess: onRecorded,
  });
  const optOut = useMutation({
    mutationFn: (channel: MessageChannel) => messagingApi(api).optOut(patientId, channel),
    onSuccess: (updated) => {
      setLeaving(null);
      onRecorded(updated);
    },
    onError: () => {
      setLeaving(null);
    },
  });
  const request = useMutation({
    mutationFn: () => messagingApi(api).requestOptIn(patientId),
    onSuccess: () => {
      toast.success(t('messaging:channels.requestSent'));
    },
  });

  if (channels.isPending) return <FormSkeleton fields={2} />;
  if (channels.isError) {
    return (
      <ErrorState
        error={channels.error}
        onRetry={() => {
          void channels.refetch();
        }}
      />
    );
  }
  const data = channels.data;
  const failure = optIn.error ?? optOut.error ?? request.error;

  return (
    <section aria-labelledby="channels-title" className="grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <h2 id="channels-title" className="font-display text-lg font-semibold">
          {t('messaging:channels.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('messaging:channels.description')}</p>
      </div>

      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, failure).message}</AlertDescription>
        </Alert>
      ) : null}

      <ChannelCard
        channel="email"
        state={data.email}
        warning={data.hasEmail ? null : t('messaging:channels.noEmail')}
      >
        {canWrite && data.email.state !== 'opted_out' ? (
          <Button
            type="button"
            variant="outline"
            className={WRAP}
            onClick={() => {
              setLeaving('email');
            }}
          >
            {t('messaging:channels.recordOptOut')}
          </Button>
        ) : null}
      </ChannelCard>

      <ChannelCard
        channel="whatsapp"
        state={data.whatsapp}
        warning={data.hasMobile ? null : t('messaging:channels.noMobile')}
      >
        {canWrite ? (
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className={WRAP}
                disabled={!data.hasMobile || data.whatsapp.state !== 'none'}
                aria-describedby={
                  data.whatsapp.state === 'opted_out' ? 'channels-opted-out-help' : undefined
                }
                loading={optIn.isPending}
                onClick={() => {
                  optIn.mutate('whatsapp');
                }}
              >
                {t('messaging:channels.recordOptIn')}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={WRAP}
                disabled={!data.hasEmail || !data.hasMobile || data.whatsapp.state === 'opted_in'}
                loading={request.isPending}
                onClick={() => {
                  request.mutate();
                }}
              >
                {t('messaging:channels.sendRequest')}
              </Button>
              {data.whatsapp.state !== 'opted_out' ? (
                <Button
                  type="button"
                  variant="outline"
                  className={WRAP}
                  onClick={() => {
                    setLeaving('whatsapp');
                  }}
                >
                  {t('messaging:channels.recordOptOut')}
                </Button>
              ) : null}
            </div>
            {data.whatsapp.state === 'opted_out' ? (
              <p id="channels-opted-out-help" className="text-sm text-muted-foreground">
                {t('messaging:channels.optedOutHelp')}
              </p>
            ) : null}
          </div>
        ) : null}
      </ChannelCard>

      <AlertDialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('messaging:channels.confirmOut.title', {
                channel: leaving ? t(`messaging:channels.${leaving}`) : '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('messaging:channels.confirmOut.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('messaging:channels.confirmOut.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (leaving) optOut.mutate(leaving);
              }}
            >
              {t('messaging:channels.confirmOut.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function ChannelCard({
  channel,
  state,
  warning,
  children,
}: {
  channel: MessageChannel;
  state: ChannelStateDto;
  warning: string | null;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation('messaging');
  const Icon = channel === 'email' ? Mail : MessageCircle;
  const since =
    state.source && state.recordedAt
      ? t('channels.since', {
          source: t(`channels.source.${state.source}`),
          date: formatDate(state.recordedAt),
        })
      : null;
  return (
    <section
      aria-labelledby={`channel-${channel}`}
      className="grid gap-3 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`channel-${channel}`} className="inline-flex items-center gap-2 font-medium">
          <Icon className="size-4" aria-hidden="true" />
          {t(`channels.${channel}`)}
        </h3>
        <Badge tone={TONE[state.state]}>{t(`channels.state.${state.state}`)}</Badge>
      </div>
      {since ? <p className="text-sm text-muted-foreground">{since}</p> : null}
      {warning ? <p className="text-sm text-muted-foreground">{warning}</p> : null}
      {children}
    </section>
  );
}
