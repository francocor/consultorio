import type { HolidayDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarHeart, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { formatCalendarDay } from '../../../../shared/lib/format.js';
import { describeError } from '../../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Badge, type BadgeTone } from '../../../../shared/ui/badge.js';
import { Button } from '../../../../shared/ui/button.js';
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
import { EmptyState } from '../../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../../shared/ui/toaster.js';
import { useSchedulingLocations } from '../../../calendar/containers/use-scheduling-people.js';
import { schedulingSettingsApi, schedulingSettingsKeys } from '../api/scheduling-settings-api.js';

const SOURCE_TONE: Record<HolidayDto['source'], BadgeTone> = {
  national: 'info',
  bridge: 'info',
  organization: 'brand',
};

/**
 * The days the agenda is closed: the country's holidays (read-only here; the platform maintains
 * them) and the organization's own days off, which this screen adds and removes.
 */
export function HolidaysSection() {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const { locations } = useSchedulingLocations();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<HolidayDto | null>(null);

  const holidays = useQuery({
    queryKey: schedulingSettingsKeys.holidays(year),
    queryFn: () => schedulingSettingsApi(api).holidays(year),
  });

  const remove = useMutation({
    mutationFn: (dayOffId: string) => schedulingSettingsApi(api).removeDayOff(dayOffId),
    onSuccess: async () => {
      toast.success(t('scheduling:config.holidays.removed'));
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: schedulingSettingsKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'feed'] });
    },
  });

  const items = [...(holidays.data ?? [])].sort((a, b) => a.day.localeCompare(b.day));

  return (
    <section aria-labelledby="holidays-title" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="holidays-title" className="font-display text-lg font-semibold">
            {t('scheduling:config.holidays.title')}
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('scheduling:config.holidays.description')}
          </p>
        </div>
        <Button
          onClick={() => {
            setAdding(true);
          }}
        >
          <Plus aria-hidden="true" />
          {t('scheduling:config.holidays.add')}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label={t('scheduling:config.holidays.previousYear')}
          onClick={() => {
            setYear((value) => value - 1);
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <p
          aria-live="polite"
          className="tabular min-w-16 text-center font-display text-lg font-semibold"
        >
          {year}
        </p>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('scheduling:config.holidays.nextYear')}
          onClick={() => {
            setYear((value) => value + 1);
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>

      {remove.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, remove.error).message}</AlertDescription>
        </Alert>
      ) : null}

      {holidays.isPending ? (
        <ListSkeleton rows={4} />
      ) : holidays.isError ? (
        <ErrorState
          error={holidays.error}
          onRetry={() => {
            void holidays.refetch();
          }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CalendarHeart}
          title={t('scheduling:config.holidays.empty.title', { year })}
          description={t('scheduling:config.holidays.empty.description')}
        />
      ) : (
        <ul className="grid gap-2">
          {items.map((holiday) => (
            <li
              key={`${holiday.day}-${holiday.name}`}
              className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3"
            >
              <div className="grid min-w-0 flex-1 basis-56 gap-1">
                <p className="font-medium">{holiday.name}</p>
                <p className="tabular text-sm text-muted-foreground">
                  <time dateTime={holiday.day}>{formatCalendarDay(holiday.day)}</time>
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={SOURCE_TONE[holiday.source]}>
                    {t(`scheduling:config.holidays.source.${holiday.source}`)}
                  </Badge>
                  {holiday.source === 'organization' ? (
                    <span className="text-sm text-muted-foreground">
                      {holiday.locationId === null
                        ? t('scheduling:filter.allLocations')
                        : (locations.find((item) => item.id === holiday.locationId)?.name ?? '')}
                    </span>
                  ) : null}
                </div>
              </div>
              {holiday.dayOffId !== null ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('scheduling:config.holidays.removeNamed', { name: holiday.name })}
                  onClick={() => {
                    setRemoving(holiday);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  {t('scheduling:config.holidays.remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <DayOffDialog
          year={year}
          locations={locations}
          onClose={() => {
            setAdding(false);
          }}
        />
      ) : null}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('scheduling:config.holidays.removeDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('scheduling:config.holidays.removeDialog.description', {
                name: removing?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              onClick={() => {
                if (removing?.dayOffId) remove.mutate(removing.dayOffId);
              }}
            >
              {t('scheduling:config.holidays.removeDialog.confirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function DayOffDialog({
  year,
  locations,
  onClose,
}: {
  year: number;
  locations: readonly { id: string; name: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [day, setDay] = useState('');
  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState('');

  const create = useMutation({
    mutationFn: () =>
      schedulingSettingsApi(api).createDayOff({
        day,
        name: name.trim(),
        ...(locationId === '' ? {} : { locationId }),
      }),
    onSuccess: async () => {
      toast.success(t('scheduling:config.holidays.created'));
      await queryClient.invalidateQueries({ queryKey: schedulingSettingsKeys.holidays(year) });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'feed'] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('scheduling:config.holidays.add')}</DialogTitle>
          <DialogDescription>{t('scheduling:config.holidays.formHelp')}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (day !== '' && name.trim() !== '') create.mutate();
          }}
        >
          {create.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, create.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="dayoff-day">{t('scheduling:config.holidays.day')}</Label>
            <Input
              id="dayoff-day"
              type="date"
              value={day}
              onChange={(event) => {
                setDay(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dayoff-name">{t('scheduling:config.types.name')}</Label>
            <Input
              id="dayoff-name"
              autoComplete="off"
              maxLength={80}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          {locations.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="dayoff-location">{t('scheduling:filter.location')}</Label>
              <Select
                id="dayoff-location"
                value={locationId}
                onChange={(event) => {
                  setLocationId(event.target.value);
                }}
              >
                <option value="">{t('scheduling:filter.allLocations')}</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={day === '' || name.trim() === ''}
              loading={create.isPending}
            >
              {t('scheduling:config.holidays.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
