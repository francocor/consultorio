import {
  MAX_MANUAL_RESENDS,
  type CalendarEntryDto,
  type MessageChannel,
  type MessageLogEntryDto,
  type MessageStatus,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCheck,
  CheckCircle2,
  Clock,
  Mail,
  MessageCircle,
  OctagonAlert,
  Send,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { formatDateTime } from '../../../../shared/lib/format.js';
import { describeError } from '../../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Badge, type BadgeTone } from '../../../../shared/ui/badge.js';
import { Button } from '../../../../shared/ui/button.js';
import { Skeleton } from '../../../../shared/ui/skeleton.js';
import { toast } from '../../../../shared/ui/toaster.js';
import { messagingApi, messagingKeys } from '../api/messaging-api.js';

const STATUS: Record<MessageStatus, { tone: BadgeTone; icon: LucideIcon }> = {
  queued: { tone: 'info', icon: Clock },
  sent: { tone: 'neutral', icon: Send },
  delivered: { tone: 'success', icon: CheckCircle2 },
  read: { tone: 'success', icon: CheckCheck },
  failed: { tone: 'danger', icon: OctagonAlert },
  cancelled: { tone: 'neutral', icon: XCircle },
};

const CHANNEL_ICON: Record<MessageChannel, LucideIcon> = { email: Mail, whatsapp: MessageCircle };

/** The statuses in which a reminder may still be sent for the appointment. */
const LIVE = new Set(['scheduled', 'confirmed']);

function whenOf(entry: MessageLogEntryDto): string {
  return formatDateTime(entry.deliveredAt ?? entry.sentAt ?? entry.sendAt);
}

/**
 * The messages sent to the patient about an appointment, in the appointment drawer: what was sent
 * on which channel, whether it arrived and why not, and a resend limited to three per appointment
 * that the server refuses for a channel the patient switched off. Metadata only: no text.
 */
export function MessageLog({
  appointment,
  readOnly,
}: {
  appointment: CalendarEntryDto;
  readOnly: boolean;
}) {
  const { t } = useTranslation(['messaging', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const key = messagingKeys.messages(appointment.id);
  const log = useQuery({
    queryKey: key,
    queryFn: () => messagingApi(api).messages(appointment.id),
  });

  const resend = useMutation({
    mutationFn: (channel: MessageChannel) => messagingApi(api).resend(appointment.id, channel),
    onSuccess: (updated) => {
      toast.success(t('messaging:log.resend.done'));
      queryClient.setQueryData(key, updated);
    },
  });

  const canResend = !readOnly && LIVE.has(appointment.status);

  return (
    <section aria-labelledby="message-log-title" className="mt-4 grid gap-3 border-t pt-4">
      <h3 id="message-log-title" className="font-display text-base font-semibold">
        {t('messaging:log.title')}
      </h3>

      {log.isPending ? <Skeleton className="h-16 w-full" /> : null}
      {log.isError ? (
        <Alert tone="danger">
          <AlertDescription>{t('messaging:log.loadError')}</AlertDescription>
        </Alert>
      ) : null}

      {log.data ? (
        <>
          {log.data.noAutomatedReminders ? (
            <Alert tone="warning">
              <AlertDescription>{t('messaging:log.noAutomated')}</AlertDescription>
            </Alert>
          ) : null}

          {log.data.messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('messaging:log.empty')}</p>
          ) : (
            <ul aria-label={t('messaging:log.caption')} className="grid gap-2">
              {log.data.messages.map((entry) => {
                const { tone, icon: Icon } = STATUS[entry.status];
                const ChannelIcon = CHANNEL_ICON[entry.channel];
                const reason = entry.failureReason ?? entry.cancelReason;
                return (
                  <li key={entry.id} className="grid gap-1 rounded-md border bg-card p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <ChannelIcon className="size-4" aria-hidden="true" />
                        {t(`messaging:log.kind.${entry.kind}`)}
                        <span className="sr-only"> · </span>
                        <span className="font-normal text-muted-foreground">
                          {t(`messaging:log.channel.${entry.channel}`)}
                        </span>
                      </span>
                      <Badge tone={tone}>
                        <Icon aria-hidden="true" />
                        {t(`messaging:log.status.${entry.status}`)}
                      </Badge>
                      {entry.trigger === 'manual' ? (
                        <Badge tone="brand">{t('messaging:log.trigger.manual')}</Badge>
                      ) : null}
                    </div>
                    <p className="tabular text-xs text-muted-foreground">{whenOf(entry)}</p>
                    {reason ? (
                      <p className="text-xs text-muted-foreground">
                        {t(`messaging:log.reason.${reason}`)}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {canResend ? (
            <div className="grid gap-2">
              <h4 className="text-sm font-medium">{t('messaging:log.resend.title')}</h4>
              <div className="flex flex-wrap gap-2">
                {(['email', 'whatsapp'] as const).map((channel) => (
                  <Button
                    key={channel}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={log.data.resendsLeft === 0}
                    loading={resend.isPending && resend.variables === channel}
                    onClick={() => {
                      resend.mutate(channel);
                    }}
                  >
                    {t(`messaging:log.resend.${channel}`)}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {log.data.resendsLeft === 0
                  ? t('messaging:log.resend.none')
                  : t('messaging:log.resend.left', {
                      count: log.data.resendsLeft,
                      max: MAX_MANUAL_RESENDS,
                    })}
              </p>
            </div>
          ) : null}

          {resend.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, resend.error).message}</AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
