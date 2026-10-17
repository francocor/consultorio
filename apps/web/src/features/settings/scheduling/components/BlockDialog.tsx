import type { CreateBlockRequest, LocationDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { isApiError } from '../../../../shared/lib/api-client.js';
import { formatDateTime } from '../../../../shared/lib/format.js';
import { describeError, translateApiKey } from '../../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Button } from '../../../../shared/ui/button.js';
import { Checkbox } from '../../../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../shared/ui/dialog.js';
import { Input, Select } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { toast } from '../../../../shared/ui/toaster.js';
import { calendarApi, calendarKeys } from '../../../calendar/api/calendar-api.js';
import type { SchedulingProfessional } from '../../../calendar/containers/use-scheduling-people.js';
import { resolveTimeZone } from '../../../calendar/domain/time-zone.js';
import { schedulingSettingsApi, schedulingSettingsKeys } from '../api/scheduling-settings-api.js';
import { blockRange, overlapsRange } from '../domain/block-form.js';

type Scope = 'professional' | 'location';

/** The longest window the calendar feed answers for; a longer block is checked on its first part. */
const FEED_DAYS = 60;
const DAY_MS = 86_400_000;

/**
 * Closing time for a professional or a whole location, once or every week. Before it is created
 * the dialog lists the appointments that fall inside it: they are NOT changed by the block, and the
 * person confirms they know, then resolves them (keep, move or cancel) from the agenda.
 */
export function BlockDialog({
  professionals,
  locations,
  onClose,
}: {
  professionals: readonly SchedulingProfessional[];
  locations: readonly LocationDto[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();

  const [scope, setScope] = useState<Scope>('professional');
  const [professionalId, setProfessionalId] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [allDay, setAllDay] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [repetitions, setRepetitions] = useState('4');
  const [acknowledged, setAcknowledged] = useState(false);

  const professional = professionals.find((item) => item.id === professionalId);
  const zoneLocationId =
    scope === 'location' ? locationId : (professional?.locationIds[0] ?? locations[0]?.id);
  const timeZone = resolveTimeZone(locations, zoneLocationId);

  const range = blockRange({ startDate, startTime, endDate, endTime, allDay }, timeZone);
  const who = scope === 'professional' ? professionalId !== '' : locationId !== '';
  const ready = range.ok && who && reason.trim() !== '';

  // The appointments inside the block, read from the same feed the agenda uses.
  const feedWindow =
    range.ok && who
      ? {
          from: range.startsAt,
          to: new Date(
            Math.min(Date.parse(range.endsAt), Date.parse(range.startsAt) + FEED_DAYS * DAY_MS),
          ).toISOString(),
          professionalIds: scope === 'professional' ? [professionalId] : [],
          locationId: scope === 'location' ? locationId : undefined,
        }
      : null;
  const affected = useQuery({
    queryKey: feedWindow ? calendarKeys.feed(feedWindow) : calendarKeys.all,
    queryFn: () => {
      if (!feedWindow) throw new Error('a window is needed');
      return calendarApi(api).feed(feedWindow);
    },
    enabled: feedWindow !== null,
  });
  const inside =
    range.ok && affected.data
      ? affected.data.appointments.filter(
          (item) => item.status !== 'cancelled' && overlapsRange(item, range),
        )
      : [];
  const needsAcknowledgement = inside.length > 0;

  const repetitionCount = /^\d+$/.test(repetitions) ? Number(repetitions) : 0;
  const repeatOk = !repeat || (repetitionCount >= 2 && repetitionCount <= 104);

  const create = useMutation({
    mutationFn: () => {
      if (!range.ok) throw new Error('the block has no valid range');
      const body: CreateBlockRequest = {
        ...(scope === 'professional' ? { professionalId } : { locationId }),
        startsAt: range.startsAt,
        endsAt: range.endsAt,
        reason: reason.trim(),
        ...(repeat ? { recurrence: { frequency: 'weekly' as const, count: repetitionCount } } : {}),
      };
      return schedulingSettingsApi(api).createBlock(body);
    },
    onSuccess: async () => {
      toast.success(t('scheduling:config.blocks.created'));
      await queryClient.invalidateQueries({ queryKey: schedulingSettingsKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'feed'] });
      onClose();
    },
  });

  const refusals =
    isApiError(create.error) && create.error.fieldErrors.length > 0
      ? create.error.fieldErrors.map((field) => translateApiKey(t, field.i18nKey))
      : [];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('scheduling:config.blocks.newTitle')}</DialogTitle>
          <DialogDescription>{t('scheduling:config.blocks.formHelp')}</DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && repeatOk && (!needsAcknowledgement || acknowledged)) create.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="block-scope">{t('scheduling:config.blocks.for')}</Label>
              <Select
                id="block-scope"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value === 'location' ? 'location' : 'professional');
                }}
              >
                <option value="professional">
                  {t('scheduling:config.blocks.forProfessional')}
                </option>
                <option value="location">{t('scheduling:config.blocks.forLocation')}</option>
              </Select>
            </div>
            {scope === 'professional' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="block-professional">{t('scheduling:booking.professional')}</Label>
                <Select
                  id="block-professional"
                  value={professionalId}
                  onChange={(event) => {
                    setProfessionalId(event.target.value);
                    setAcknowledged(false);
                  }}
                >
                  <option value="" />
                  {professionals.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="block-location">{t('scheduling:filter.location')}</Label>
                <Select
                  id="block-location"
                  value={locationId}
                  onChange={(event) => {
                    setLocationId(event.target.value);
                    setAcknowledged(false);
                  }}
                >
                  {locations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="block-all-day"
              checked={allDay}
              onCheckedChange={(checked) => {
                setAllDay(checked === true);
              }}
            />
            <Label htmlFor="block-all-day" className="font-normal">
              {t('scheduling:config.blocks.allDay')}
            </Label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="block-start-date">{t('scheduling:config.blocks.startDate')}</Label>
              <Input
                id="block-start-date"
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setAcknowledged(false);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="block-end-date">{t('scheduling:config.blocks.endDate')}</Label>
              <Input
                id="block-end-date"
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setAcknowledged(false);
                }}
              />
            </div>
            {allDay ? null : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="block-start-time">
                    {t('scheduling:config.blocks.startTime')}
                  </Label>
                  <Input
                    id="block-start-time"
                    type="time"
                    value={startTime}
                    onChange={(event) => {
                      setStartTime(event.target.value);
                    }}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="block-end-time">{t('scheduling:config.blocks.endTime')}</Label>
                  <Input
                    id="block-end-time"
                    type="time"
                    value={endTime}
                    onChange={(event) => {
                      setEndTime(event.target.value);
                    }}
                  />
                </div>
              </>
            )}
          </div>
          {range.ok ? null : startDate !== '' && range.error === 'order' ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t('scheduling:config.blocks.errors.order')}
            </p>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="block-reason">{t('scheduling:config.blocks.reason')}</Label>
            <Input
              id="block-reason"
              autoComplete="off"
              maxLength={200}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="block-repeat"
                checked={repeat}
                onCheckedChange={(checked) => {
                  setRepeat(checked === true);
                }}
              />
              <Label htmlFor="block-repeat" className="font-normal">
                {t('scheduling:series.repeat')}
              </Label>
            </div>
            {repeat ? (
              <div className="grid max-w-48 gap-1.5">
                <Label htmlFor="block-repetitions">
                  {t('scheduling:config.blocks.repetitions')}
                </Label>
                <Input
                  id="block-repetitions"
                  type="number"
                  min={2}
                  max={104}
                  value={repetitions}
                  onChange={(event) => {
                    setRepetitions(event.target.value);
                  }}
                />
              </div>
            ) : null}
          </div>

          {needsAcknowledgement ? (
            <Alert tone="warning">
              <AlertDescription>
                <span className="block font-medium">
                  {t('scheduling:config.blocks.affected.title', { count: inside.length })}
                </span>
                <ul
                  aria-label={t('scheduling:config.blocks.affected.list')}
                  className="mt-2 grid gap-1 text-sm"
                >
                  {inside.slice(0, 8).map((item) => (
                    <li key={item.id} className="tabular">
                      {`${formatDateTime(item.startsAt, { timeZone })}, ${item.patientName}`}
                    </li>
                  ))}
                  {inside.length > 8 ? (
                    <li>{t('scheduling:calendar.moreEvents', { count: inside.length - 8 })}</li>
                  ) : null}
                </ul>
                <span className="mt-2 flex items-start gap-2">
                  <Checkbox
                    id="block-acknowledge"
                    checked={acknowledged}
                    onCheckedChange={(checked) => {
                      setAcknowledged(checked === true);
                    }}
                  />
                  <Label htmlFor="block-acknowledge" className="font-normal leading-snug">
                    {t('scheduling:config.blocks.affected.acknowledge')}
                  </Label>
                </span>
              </AlertDescription>
            </Alert>
          ) : null}

          {refusals.length > 0 ? (
            <Alert tone="danger">
              <AlertDescription>
                {refusals.map((message) => (
                  <span key={message} className="block">
                    {message}
                  </span>
                ))}
              </AlertDescription>
            </Alert>
          ) : create.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, create.error).message}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={!ready || !repeatOk || (needsAcknowledgement && !acknowledged)}
              loading={create.isPending}
            >
              {t('scheduling:config.blocks.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
