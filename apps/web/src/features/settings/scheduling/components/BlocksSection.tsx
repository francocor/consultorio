import type { BlockDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { formatCalendarDay, formatDateTime, formatTime } from '../../../../shared/lib/format.js';
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
import { Badge } from '../../../../shared/ui/badge.js';
import { Button } from '../../../../shared/ui/button.js';
import { localDateOf, minutesOfDay } from '../../../../shared/ui/calendar/zoned-time.js';
import { EmptyState } from '../../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../../shared/ui/toaster.js';
import {
  useSchedulingLocations,
  useSchedulingProfessionals,
} from '../../../calendar/containers/use-scheduling-people.js';
import { resolveTimeZone } from '../../../calendar/domain/time-zone.js';
import { schedulingSettingsApi, schedulingSettingsKeys } from '../api/scheduling-settings-api.js';

import { BlockDialog } from './BlockDialog.js';

/** Closed time: blocks of a professional or of a location, once or repeating. */
export function BlocksSection() {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const { professionals } = useSchedulingProfessionals();
  const { locations } = useSchedulingLocations();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<BlockDto | null>(null);
  const [scope, setScope] = useState<'occurrence' | 'series'>('occurrence');
  const [now] = useState(() => new Date().toISOString());

  const blocks = useQuery({
    queryKey: schedulingSettingsKeys.blocks(now),
    queryFn: () => schedulingSettingsApi(api).blocks(now),
  });

  const remove = useMutation({
    mutationFn: ({ block, how }: { block: BlockDto; how: 'occurrence' | 'series' }) =>
      schedulingSettingsApi(api).removeBlock(block.id, how),
    onSuccess: async () => {
      toast.success(t('scheduling:config.blocks.removed'));
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: schedulingSettingsKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'feed'] });
    },
  });

  const items = blocks.data ?? [];
  const add = (
    <Button
      onClick={() => {
        setCreating(true);
      }}
    >
      <Plus aria-hidden="true" />
      {t('scheduling:config.blocks.add')}
    </Button>
  );

  /** `20/12/2026 al 31/12/2026` for whole days, or the hours for a part of a day. */
  function when(block: BlockDto): string {
    const zone = resolveTimeZone(
      locations,
      block.locationId ??
        professionals.find((item) => item.id === block.professionalId)?.locationIds[0],
    );
    const wholeDays =
      minutesOfDay(block.startsAt, zone) === 0 && minutesOfDay(block.endsAt, zone) === 0;
    if (wholeDays) {
      const first = localDateOf(block.startsAt, zone);
      const last = localDateOf(new Date(Date.parse(block.endsAt) - 1), zone);
      return first === last
        ? t('scheduling:config.blocks.oneDay', { day: formatCalendarDay(first) })
        : t('scheduling:config.blocks.days', {
            from: formatCalendarDay(first),
            to: formatCalendarDay(last),
          });
    }
    const sameDay = localDateOf(block.startsAt, zone) === localDateOf(block.endsAt, zone);
    return sameDay
      ? `${formatDateTime(block.startsAt, { timeZone: zone })} a ${formatTime(block.endsAt, { timeZone: zone })}`
      : `${formatDateTime(block.startsAt, { timeZone: zone })} a ${formatDateTime(block.endsAt, { timeZone: zone })}`;
  }

  function whoFor(block: BlockDto): string {
    if (block.professionalId !== null) {
      return professionals.find((item) => item.id === block.professionalId)?.name ?? '-';
    }
    if (block.locationId !== null) {
      return locations.find((item) => item.id === block.locationId)?.name ?? '-';
    }
    return t('scheduling:worklist.wholeOrganization');
  }

  return (
    <section aria-labelledby="blocks-title" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="blocks-title" className="font-display text-lg font-semibold">
            {t('scheduling:config.blocks.title')}
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('scheduling:config.blocks.description')}
          </p>
        </div>
        {add}
      </div>

      {remove.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, remove.error).message}</AlertDescription>
        </Alert>
      ) : null}

      {blocks.isPending ? (
        <ListSkeleton rows={3} />
      ) : blocks.isError ? (
        <ErrorState
          error={blocks.error}
          onRetry={() => {
            void blocks.refetch();
          }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          title={t('scheduling:config.blocks.empty.title')}
          description={t('scheduling:config.blocks.empty.description')}
          action={add}
        />
      ) : (
        <ul className="grid gap-3">
          {items.map((block) => (
            <li
              key={block.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4"
            >
              <div className="grid min-w-0 flex-1 basis-56 gap-1">
                <p className="font-medium">{block.reason}</p>
                <p className="text-sm text-muted-foreground">{whoFor(block)}</p>
                <p className="tabular text-sm text-muted-foreground">{when(block)}</p>
                {block.seriesId !== null ? (
                  <div>
                    <Badge tone="info">{t('scheduling:config.blocks.repeats')}</Badge>
                  </div>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                aria-label={t('scheduling:config.blocks.removeNamed', { reason: block.reason })}
                onClick={() => {
                  setScope('occurrence');
                  setRemoving(block);
                }}
              >
                <Trash2 aria-hidden="true" />
                {t('scheduling:config.blocks.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <BlockDialog
          professionals={professionals}
          locations={locations}
          onClose={() => {
            setCreating(false);
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
            <AlertDialogTitle>{t('scheduling:config.blocks.removeDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('scheduling:config.blocks.removeDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removing?.seriesId ? (
            <div
              role="radiogroup"
              aria-label={t('scheduling:config.blocks.removeDialog.scope')}
              className="grid gap-2"
            >
              {(['occurrence', 'series'] as const).map((option) => (
                <label
                  key={option}
                  className="flex cursor-pointer items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm"
                >
                  <input
                    type="radio"
                    name="remove-scope"
                    checked={scope === option}
                    onChange={() => {
                      setScope(option);
                    }}
                    className="size-4"
                  />
                  {t(`scheduling:config.blocks.removeDialog.${option}`)}
                </label>
              ))}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              onClick={() => {
                if (removing)
                  remove.mutate({ block: removing, how: removing.seriesId ? scope : 'occurrence' });
              }}
            >
              {t('scheduling:config.blocks.removeDialog.confirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
