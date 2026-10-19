import type { WorklistItemDto, LocationDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { formatDateTime, formatDayLong, formatTime } from '../../../shared/lib/format.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../shared/ui/alert-dialog.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { localDateOf } from '../../../shared/ui/calendar/zoned-time.js';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';
import { toast } from '../../../shared/ui/toaster.js';
import { calendarApi } from '../../calendar/api/calendar-api.js';
import { ErrorNotice } from '../../calendar/components/drawer/ErrorNotice.js';
import { STATUS_PRESENTATION, statusLabel } from '../../calendar/domain/calendar-events.js';
import { worklistApi, worklistKeys } from '../api/worklist-api.js';
import { identityDifferences } from '../domain/worklist-items.js';

import { ConfirmIdentityDialog } from './ConfirmIdentityDialog.js';
import { DetachPatientDialog } from './DetachPatientDialog.js';
import { KIND_ICONS } from './kinds.js';

const INVOICE_REASONS = new Set([
  'number_taken',
  'cae_taken',
  'voucher_mismatch',
  'orphaned_voucher',
  'replaced_unresolved',
  'issuer_mismatch',
  'voucher_ambiguous',
  'outcome_unknown',
  'authority_refuses_lookup',
  'voucher_taken_by_other',
  'authority_refuses_number',
  'pin_not_honoured',
]);

/** Reasons whose own text already says what is known about the outcome: the generic note would contradict it. */
const REASONS_WITHOUT_OUTCOME_NOTE = new Set(['outcome_unknown', 'voucher_taken_by_other']);

/** Why an invoice needs a person, in words (the reason travels in the administrative detail). */
function invoiceAttentionText(
  t: (key: string, options?: Record<string, unknown>) => string,
  detail: Record<string, unknown> | null,
): string {
  const reason = detail?.['reason'];
  if (typeof reason !== 'string' || !INVOICE_REASONS.has(reason)) {
    return t('scheduling:worklist.invoiceAttention.generic');
  }
  // Some texts name the number of the voucher (the one of another invoice, for instance).
  const number = typeof detail?.['number'] === 'number' ? detail['number'] : undefined;
  const text = t(`scheduling:worklist.invoiceAttention.${reason}`, { number });
  // A parked invoice whose request may have been answered says so: the voucher may already exist.
  const withNote =
    detail?.['outcomeUnknown'] === true && !REASONS_WITHOUT_OUTCOME_NOTE.has(reason)
      ? `${text} ${t('scheduling:worklist.invoiceAttention.outcomeUnknownNote')}`
      : text;
  // The numbers in doubt: where a person looks for the voucher in ARCA (JD-S4 R5-A-F4).
  const candidates = detail?.['candidates'];
  if (Array.isArray(candidates) && candidates.length > 0 && candidates.every(Number.isInteger)) {
    const numbers = candidates.join(', ');
    return `${withNote} ${t('scheduling:worklist.invoiceAttention.candidatesNote', { numbers })}`;
  }
  const from = detail?.['candidatesFrom'];
  const to = detail?.['candidatesTo'];
  if (Number.isInteger(from) && Number.isInteger(to)) {
    return `${withNote} ${t('scheduling:worklist.invoiceAttention.candidatesRangeNote', { from, to })}`;
  }
  // A range with no end yet: the invoice was replaced before anybody could ask where the authority is.
  if (Number.isInteger(from)) {
    return `${withNote} ${t('scheduling:worklist.invoiceAttention.candidatesOpenNote', { from })}`;
  }
  // The numbering of the authority went back: the two numbers, not a range that is empty.
  const lastNow = detail?.['lastNow'];
  const lastAtMark = detail?.['lastAtMark'];
  if (Number.isInteger(lastNow) && Number.isInteger(lastAtMark)) {
    return `${withNote} ${t('scheduling:worklist.invoiceAttention.numberingWentBackNote', { now: lastNow, atMark: lastAtMark })}`;
  }
  return withNote;
}

/** One thing that needs a person: what it is about, what differs, and the ways to settle it. */
export function WorklistItemCard({
  item,
  locations,
  professionalName,
}: {
  item: WorklistItemDto;
  locations: readonly LocationDto[];
  professionalName: string | undefined;
}) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [dialog, setDialog] = useState<'identity' | 'detach' | 'dismiss' | null>(null);

  const location = locations.find((entry) => entry.id === item.locationId);
  const timeZone = location?.timeZone ?? locations[0]?.timeZone ?? 'America/Argentina/Buenos_Aires';
  const KindIcon = KIND_ICONS[item.kind];
  const appointment = item.appointment;
  const differences = identityDifferences(item.detail);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: worklistKeys.all });
    await queryClient.invalidateQueries({ queryKey: ['calendar'] });
  };

  const close = useMutation({
    mutationFn: (how: 'resolve' | 'dismiss') =>
      how === 'resolve' ? worklistApi(api).resolve(item.id) : worklistApi(api).dismiss(item.id),
    onSuccess: async (_result, how) => {
      toast.success(t(`scheduling:worklist.done.${how}`));
      setDialog(null);
      await refresh();
    },
  });

  const approve = useMutation({
    mutationFn: async () => {
      if (!appointment) throw new Error('only an appointment can be approved');
      return calendarApi(api).transition(appointment.id, 'approve', appointment.version);
    },
    onSuccess: async () => {
      toast.success(t('scheduling:drawer.done.approve'));
      await refresh();
    },
    onError: async (failure) => {
      if (isApiError(failure) && failure.code === 'stale_revision') await refresh();
    },
  });

  const error = close.error ?? approve.error;
  const status = appointment ? STATUS_PRESENTATION[appointment.status] : null;

  return (
    <li aria-labelledby={headingId} className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-2 font-display text-base font-semibold">
          <KindIcon className="size-4 shrink-0 text-primary-ink" aria-hidden="true" />
          {t(`scheduling:worklist.kind.${item.kind}`)}
        </h2>
        <span className="text-xs text-muted-foreground">
          <time dateTime={item.createdAt}>{formatDateTime(item.createdAt, { timeZone })}</time>
        </span>
      </div>

      {appointment ? (
        <div className="grid gap-1 text-sm">
          <p className="font-medium">{appointment.patientName}</p>
          <p className="tabular text-muted-foreground">
            {`${formatDayLong(localDateOf(appointment.startsAt, timeZone))}, ${t(
              'scheduling:calendar.eventTime',
              {
                start: formatTime(appointment.startsAt, { timeZone }),
                end: formatTime(appointment.endsAt, { timeZone }),
              },
            )}`}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
            {professionalName ? <span>{professionalName}</span> : null}
            {status ? (
              <Badge tone={status.tone}>
                <status.icon aria-hidden="true" />
                {statusLabel(t, appointment.status)}
              </Badge>
            ) : null}
          </p>
        </div>
      ) : item.subjectType === 'invoice' ? (
        <p className="text-sm">{invoiceAttentionText(t, item.detail)}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{t('scheduling:worklist.noAppointment')}</p>
      )}

      <p className="text-sm text-muted-foreground">
        {location?.name ?? t('scheduling:worklist.wholeOrganization')}
      </p>

      {differences.length > 0 ? (
        <TableContainer aria-label={t('scheduling:worklist.differences.region')}>
          <Table>
            <caption className="sr-only">{t('scheduling:worklist.differences.table')}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('scheduling:worklist.differences.field')}</TableHead>
                <TableHead>{t('scheduling:worklist.differences.submitted')}</TableHead>
                <TableHead>{t('scheduling:worklist.differences.onFile')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {differences.map((difference) => (
                <TableRow key={difference.field}>
                  <TableCell>
                    {t(`scheduling:worklist.differences.fields.${difference.field}`, {
                      defaultValue: t('scheduling:worklist.differences.fields.other'),
                    })}
                  </TableCell>
                  <TableCell>{difference.submitted ?? '-'}</TableCell>
                  <TableCell>{difference.onFile ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : null}

      {error ? <ErrorNotice error={error} /> : null}

      {item.actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {item.actions.map((action) => {
            switch (action) {
              case 'open_appointment':
                return appointment ? (
                  <Button key={action} asChild variant="outline">
                    <Link
                      to="/calendar"
                      search={{
                        view: 'day',
                        date: localDateOf(appointment.startsAt, timeZone),
                        appointment: appointment.id,
                      }}
                    >
                      {t('scheduling:worklist.action.open_appointment')}
                    </Link>
                  </Button>
                ) : null;
              case 'open_invoice':
                return (
                  <Button key={action} asChild variant="outline">
                    <Link to="/invoices">{t('scheduling:worklist.action.open_invoice')}</Link>
                  </Button>
                );
              case 'approve':
                return (
                  <Button
                    key={action}
                    loading={approve.isPending}
                    onClick={() => {
                      approve.mutate();
                    }}
                  >
                    {t('scheduling:drawer.action.approve')}
                  </Button>
                );
              case 'confirm_identity':
                return (
                  <Button
                    key={action}
                    onClick={() => {
                      setDialog('identity');
                    }}
                  >
                    {t('scheduling:worklist.action.confirm_identity')}
                  </Button>
                );
              case 'detach_patient':
                return (
                  <Button
                    key={action}
                    variant="outline"
                    onClick={() => {
                      setDialog('detach');
                    }}
                  >
                    {t('scheduling:worklist.action.detach_patient')}
                  </Button>
                );
              case 'resolve':
                return (
                  <Button
                    key={action}
                    variant="secondary"
                    loading={close.isPending}
                    onClick={() => {
                      close.mutate('resolve');
                    }}
                  >
                    {t('scheduling:worklist.action.resolve')}
                  </Button>
                );
              case 'dismiss':
                return (
                  <Button
                    key={action}
                    variant="outline"
                    onClick={() => {
                      setDialog('dismiss');
                    }}
                  >
                    {t('scheduling:worklist.action.dismiss')}
                  </Button>
                );
            }
          })}
        </div>
      ) : null}

      {dialog === 'identity' ? (
        <ConfirmIdentityDialog
          item={item}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'detach' ? (
        <DetachPatientDialog
          item={item}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      <AlertDialog
        open={dialog === 'dismiss'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('scheduling:worklist.dismissDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('scheduling:worklist.dismissDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              onClick={() => {
                close.mutate('dismiss');
              }}
            >
              {t('scheduling:worklist.dismissDialog.confirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
