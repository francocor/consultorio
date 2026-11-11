import type { WaitlistEntryDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pause, PhoneCall, Play, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import {
  formatCalendarDay,
  formatDate,
  formatDateTime,
  formatTime,
} from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { waitlistApi, waitlistKeys } from '../api/waitlist-api.js';
import { describeDays, describeRanges } from '../domain/preferences.js';

import { CloseEntryDialog } from './CloseEntryDialog.js';
import { EditEntryDialog } from './EditEntryDialog.js';

const STATUS_TONE: Record<WaitlistEntryDto['status'], BadgeTone> = {
  active: 'info',
  offered: 'brand',
  paused: 'warning',
  closed: 'neutral',
};

/**
 * One entry of the waitlist: who waits for what, when they can come, where it stands, and what
 * reception can do with it. A closed entry only reads. Every state is said in words, never by
 * colour alone.
 */
export function EntryCard({ entry, readOnly }: { entry: WaitlistEntryDto; readOnly: boolean }) {
  const { t } = useTranslation(['waitlist', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'close' | null>(null);
  const closed = entry.status === 'closed';

  const refresh = () => queryClient.invalidateQueries({ queryKey: waitlistKeys.all });
  const toggle = useMutation({
    mutationFn: () =>
      entry.status === 'paused'
        ? waitlistApi(api).resume(entry.id)
        : waitlistApi(api).pause(entry.id),
    onSuccess: async () => {
      toast.success(
        entry.status === 'paused' ? t('waitlist:entry.resumed') : t('waitlist:entry.paused'),
      );
      await refresh();
    },
  });
  const priority = useMutation({
    mutationFn: (level: number) => waitlistApi(api).priority(entry.id, { priority: level }),
    onSuccess: async () => {
      toast.success(t('waitlist:entry.priorityChanged'));
      await refresh();
    },
  });

  const days = describeDays(entry.weekdays);
  const times = describeRanges(entry.timeRanges);
  const failure = toggle.error ?? priority.error;
  const disabled = readOnly;

  return (
    <li className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h3 className="font-display text-base font-semibold">{entry.patientName}</h3>
          <p className="text-sm text-muted-foreground">
            {t('waitlist:entry.what', {
              type: entry.appointmentTypeName,
              professional: entry.professionalName ?? t('waitlist:entry.anyProfessional'),
              location: entry.locationName ?? t('waitlist:entry.anyLocation'),
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATUS_TONE[entry.status]}>{t(`waitlist:status.${entry.status}`)}</Badge>
          {closed && entry.closeReason ? (
            <Badge tone="neutral">{t(`waitlist:closeReason.${entry.closeReason}`)}</Badge>
          ) : null}
          {entry.priority > 0 ? (
            <Badge tone="danger">{t(`waitlist:priority.badge.${String(entry.priority)}`)}</Badge>
          ) : null}
          {entry.manualContactOnly && entry.manualReason ? (
            <Badge tone="warning">
              <PhoneCall aria-hidden="true" />
              {t('waitlist:entry.manual')}
            </Badge>
          ) : null}
          {entry.unresponsive && !closed ? (
            <Badge tone="danger">
              <TriangleAlert aria-hidden="true" />
              {t('waitlist:entry.unresponsive', { count: entry.consecutiveExpired })}
            </Badge>
          ) : null}
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('waitlist:entry.days')}</dt>
          <dd>{days ?? t('waitlist:entry.anyDay')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('waitlist:entry.times')}</dt>
          <dd>{times ?? t('waitlist:entry.anyTime')}</dd>
        </div>
        {entry.earliestDate || entry.latestDate ? (
          <div className="flex gap-2">
            <dt className="text-muted-foreground">{t('waitlist:entry.dates')}</dt>
            <dd>
              {entry.earliestDate && entry.latestDate
                ? t('waitlist:entry.between', {
                    from: formatCalendarDay(entry.earliestDate),
                    to: formatCalendarDay(entry.latestDate),
                  })
                : entry.earliestDate
                  ? t('waitlist:entry.since', { date: formatCalendarDay(entry.earliestDate) })
                  : t('waitlist:entry.until', { date: formatCalendarDay(entry.latestDate) })}
            </dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('waitlist:entry.channels')}</dt>
          <dd>{entry.channels.map((channel) => t(`waitlist:channel.${channel}`)).join(', ')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('waitlist:entry.waitingSince')}</dt>
          <dd>{formatDate(entry.createdAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">{t('waitlist:entry.expires')}</dt>
          <dd>{formatDate(entry.expiresAt)}</dd>
        </div>
      </dl>

      {entry.manualContactOnly && entry.manualReason ? (
        <p className="text-sm text-muted-foreground">
          {t(`waitlist:manualReason.${entry.manualReason}`)}
        </p>
      ) : null}

      {entry.openOffer ? (
        <Alert tone="info">
          <AlertDescription>
            {t('waitlist:entry.offer', {
              when: formatDateTime(entry.openOffer.startsAt),
              until: formatTime(entry.openOffer.expiresAt),
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, failure).message}</AlertDescription>
        </Alert>
      ) : null}

      {closed ? null : (
        <div className="flex flex-wrap items-end gap-2 border-t pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            loading={toggle.isPending}
            onClick={() => {
              toggle.mutate();
            }}
          >
            {entry.status === 'paused' ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            {entry.status === 'paused' ? t('waitlist:entry.resume') : t('waitlist:entry.pause')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setDialog('edit');
            }}
          >
            <CalendarClock aria-hidden="true" />
            {t('waitlist:entry.edit')}
          </Button>
          <div className="grid gap-1">
            <Label htmlFor={`priority-${entry.id}`} className="text-xs">
              {t('waitlist:priority.label')}
            </Label>
            <Select
              id={`priority-${entry.id}`}
              value={String(entry.priority)}
              disabled={disabled || priority.isPending}
              className="w-44 md:min-h-9"
              onChange={(event) => {
                priority.mutate(Number(event.target.value));
              }}
            >
              {[0, 1, 2].map((level) => (
                <option key={level} value={String(level)}>
                  {t(`waitlist:priority.option.${String(level)}`)}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setDialog('close');
            }}
          >
            {t('waitlist:entry.close')}
          </Button>
        </div>
      )}

      {dialog === 'edit' ? (
        <EditEntryDialog
          entry={entry}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === 'close' ? (
        <CloseEntryDialog
          entry={entry}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
    </li>
  );
}
