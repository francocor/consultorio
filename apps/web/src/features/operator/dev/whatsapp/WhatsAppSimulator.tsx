import {
  WHATSAPP_SIMULATOR_MODES,
  type SimulatorMessageDto,
  type WhatsAppSimulatorMode,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { formatDateTime } from '../../../../shared/lib/format.js';
import { describeError } from '../../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Badge } from '../../../../shared/ui/badge.js';
import { Button } from '../../../../shared/ui/button.js';
import { Input, Select } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { ErrorState } from '../../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../../shared/ui/toaster.js';

import { simulatorApi, simulatorKeys } from './simulator-api.js';

/** The phone shows new messages by itself: a reminder sent by the worker appears here. */
const REFRESH_MS = 3000;

/**
 * The phone of the local WhatsApp simulator: the messages the platform handed to it (as the
 * patient reads them), buttons to report them delivered, read or failed, a box to reply as the
 * patient, and the controls of the simulated provider (an outage, rejected templates, numbers that
 * are not on WhatsApp). Receipts and replies are signed and sent to the application's real webhook.
 */
export function WhatsAppSimulator() {
  const { t } = useTranslation('messaging');
  const api = useApi();
  const state = useQuery({
    queryKey: simulatorKeys.state,
    queryFn: () => simulatorApi(api).state(),
    refetchInterval: REFRESH_MS,
  });

  if (state.isPending) return <FormSkeleton fields={3} />;
  if (state.isError) {
    return (
      <ErrorState
        error={state.error}
        onRetry={() => {
          void state.refetch();
        }}
      />
    );
  }
  const { messages, mode, unreachableNumbers } = state.data;

  return (
    <div className="grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('dev.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('dev.description')}</p>
      </div>
      <Controls mode={mode} unreachableNumbers={unreachableNumbers} />
      <Phone messages={messages} />
      <Reply />
    </div>
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: simulatorKeys.state });
}

function Controls({
  mode,
  unreachableNumbers,
}: {
  mode: WhatsAppSimulatorMode;
  unreachableNumbers: readonly string[];
}) {
  const { t } = useTranslation('messaging');
  const api = useApi();
  const refresh = useRefresh();
  const [number, setNumber] = useState('');

  const setMode = useMutation({
    mutationFn: (next: WhatsAppSimulatorMode) => simulatorApi(api).setMode(next),
    onSuccess: refresh,
  });
  const mark = useMutation({
    mutationFn: (input: { number: string; unreachable: boolean }) =>
      simulatorApi(api).setUnreachable(input.number, input.unreachable),
    onSuccess: async () => {
      setNumber('');
      await refresh();
    },
  });
  const failure = setMode.error ?? mark.error;

  return (
    <section aria-labelledby="dev-mode-title" className="grid gap-3 rounded-lg border bg-card p-4">
      <h3 id="dev-mode-title" className="font-medium">
        {t('dev.mode.title')}
      </h3>
      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, failure).message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="dev-mode">{t('dev.mode.label')}</Label>
        <Select
          id="dev-mode"
          value={mode}
          onChange={(event) => {
            setMode.mutate(event.target.value as WhatsAppSimulatorMode);
          }}
        >
          {WHATSAPP_SIMULATOR_MODES.map((option) => (
            <option key={option} value={option}>
              {t(`dev.mode.${option}`)}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-2">
        <h4 className="text-sm font-medium">{t('dev.unreachable.title')}</h4>
        <p className="text-sm text-muted-foreground">{t('dev.unreachable.description')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="dev-unreachable">{t('dev.unreachable.number')}</Label>
            <Input
              id="dev-unreachable"
              value={number}
              inputMode="tel"
              onChange={(event) => {
                setNumber(event.target.value);
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={number.trim() === ''}
            loading={mark.isPending}
            onClick={() => {
              mark.mutate({ number: number.trim(), unreachable: true });
            }}
          >
            {t('dev.unreachable.mark')}
          </Button>
        </div>
        {unreachableNumbers.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {unreachableNumbers.map((entry) => (
              <li key={entry}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    mark.mutate({ number: entry, unreachable: false });
                  }}
                >
                  {t('dev.unreachable.unmark', { number: entry })}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

const CAN_REPORT: Record<'delivered' | 'read' | 'failed', ReadonlySet<string>> = {
  delivered: new Set(['accepted', 'sent']),
  read: new Set(['accepted', 'sent', 'delivered']),
  failed: new Set(['accepted', 'sent', 'delivered']),
};

function Phone({ messages }: { messages: readonly SimulatorMessageDto[] }) {
  const { t } = useTranslation('messaging');
  const api = useApi();
  const refresh = useRefresh();
  const report = useMutation({
    mutationFn: (input: { providerMessageId: string; status: 'delivered' | 'read' | 'failed' }) =>
      simulatorApi(api).setStatus(input.providerMessageId, {
        status: input.status,
        ...(input.status === 'failed' ? { errorCode: 'not_on_whatsapp' } : {}),
      }),
    onSuccess: refresh,
  });

  return (
    <section aria-labelledby="dev-phone-title" className="grid gap-3 rounded-lg border bg-card p-4">
      <h3 id="dev-phone-title" className="font-medium">
        {t('dev.phone.title')}
      </h3>
      {report.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, report.error).message}</AlertDescription>
        </Alert>
      ) : null}
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('dev.phone.empty')}</p>
      ) : (
        <ul aria-label={t('dev.phone.caption')} className="grid gap-3">
          {messages.map((entry) => {
            const inbound = entry.direction === 'inbound';
            return (
              <li
                key={entry.id}
                className={`grid max-w-full gap-2 rounded-lg border p-3 text-sm sm:max-w-[85%] ${
                  inbound ? 'justify-self-end bg-accent' : 'justify-self-start bg-background'
                }`}
              >
                <p className="text-xs font-medium text-muted-foreground">
                  {inbound
                    ? t('dev.phone.inbound', { number: entry.number })
                    : t('dev.phone.outbound', { number: entry.number })}
                </p>
                <p className="whitespace-pre-wrap break-words">{entry.body}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={entry.status === 'failed' ? 'danger' : 'neutral'}>
                    {t('dev.phone.status', { status: t(`dev.status.${entry.status}`) })}
                  </Badge>
                  <span className="tabular text-xs text-muted-foreground">
                    {formatDateTime(entry.createdAt)}
                  </span>
                </div>
                {!inbound ? (
                  <div className="flex flex-wrap gap-2">
                    {(['delivered', 'read', 'failed'] as const).map((status) => (
                      <Button
                        key={status}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!CAN_REPORT[status].has(entry.status)}
                        loading={
                          report.isPending &&
                          report.variables.providerMessageId === entry.providerMessageId &&
                          report.variables.status === status
                        }
                        onClick={() => {
                          report.mutate({ providerMessageId: entry.providerMessageId, status });
                        }}
                      >
                        {t(`dev.action.${status}`)}
                        <span className="sr-only"> {entry.number}</span>
                      </Button>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Reply() {
  const { t } = useTranslation('messaging');
  const api = useApi();
  const refresh = useRefresh();
  const [from, setFrom] = useState('');
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => simulatorApi(api).reply(from.trim(), text),
    onSuccess: async (result) => {
      if (result.delivered) {
        toast.success(t('dev.reply.sent'));
        setText('');
      } else {
        toast.error(t('dev.reply.notDelivered'));
      }
      await refresh();
    },
  });

  return (
    <section aria-labelledby="dev-reply-title" className="grid gap-3 rounded-lg border bg-card p-4">
      <h3 id="dev-reply-title" className="font-medium">
        {t('dev.reply.title')}
      </h3>
      {send.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, send.error).message}</AlertDescription>
        </Alert>
      ) : null}
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (from.trim() !== '') send.mutate();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="dev-reply-from">{t('dev.reply.from')}</Label>
          <Input
            id="dev-reply-from"
            value={from}
            inputMode="tel"
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="dev-reply-text">{t('dev.reply.text')}</Label>
          <Input
            id="dev-reply-text"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </div>
        <div>
          <Button type="submit" disabled={from.trim() === ''} loading={send.isPending}>
            {t('dev.reply.send')}
          </Button>
        </div>
      </form>
    </section>
  );
}
