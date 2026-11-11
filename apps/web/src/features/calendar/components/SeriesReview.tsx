import type { SeriesOccurrenceDto } from '@consultorio/contracts';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { formatDayLong, formatTime } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { localDateOf } from '../../../shared/ui/calendar/zoned-time.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';

/** How many sessions would be created: those that are free and not skipped. */
export function creatableCount(
  occurrences: readonly SeriesOccurrenceDto[],
  skip: readonly number[],
): number {
  return occurrences.filter((item) => item.status === 'ok' && !skip.includes(item.index)).length;
}

/** Sessions that conflict and that the person has not skipped: the series cannot go ahead. */
export function unresolvedCount(
  occurrences: readonly SeriesOccurrenceDto[],
  skip: readonly number[],
): number {
  return occurrences.filter((item) => item.status === 'conflict' && !skip.includes(item.index))
    .length;
}

/**
 * The review of a weekly series before anything exists: every session with its day and time, free
 * or not, and why not. A session that cannot be created has to be skipped on purpose; the person
 * can also go back and change the series, in which case nothing was created.
 */
export function SeriesReview({
  occurrences,
  skip,
  timeZone,
  committing,
  error,
  onToggleSkip,
  onCommit,
  onBack,
}: {
  occurrences: readonly SeriesOccurrenceDto[];
  skip: readonly number[];
  timeZone: string;
  committing: boolean;
  error: ReactNode;
  onToggleSkip: (index: number) => void;
  onCommit: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('scheduling');
  const creatable = creatableCount(occurrences, skip);
  const unresolved = unresolvedCount(occurrences, skip);

  return (
    <div className="grid gap-3">
      <TableContainer aria-label={t('series.region')}>
        <Table>
          <TableCaption className="sr-only">{t('series.table')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('series.session')}</TableHead>
              <TableHead>{t('series.when')}</TableHead>
              <TableHead>{t('series.state')}</TableHead>
              <TableHead>{t('series.skip')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {occurrences.map((item) => {
              const skipped = skip.includes(item.index);
              return (
                <TableRow key={item.index}>
                  <TableCell className="tabular">{item.index}</TableCell>
                  <TableCell className="tabular">
                    {item.startsAt === null
                      ? '-'
                      : `${formatDayLong(localDateOf(item.startsAt, timeZone))}, ${formatTime(item.startsAt, { timeZone })}`}
                  </TableCell>
                  <TableCell>
                    {skipped
                      ? t('series.skipped')
                      : item.status === 'ok'
                        ? t('series.free')
                        : t('series.conflict', {
                            reason: t(`series.reason.${item.reason ?? 'slot_taken'}`),
                          })}
                  </TableCell>
                  <TableCell>
                    <Checkbox
                      checked={skipped}
                      aria-label={t('series.skipSession', { index: item.index })}
                      onCheckedChange={() => {
                        onToggleSkip(item.index);
                      }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {unresolved > 0 ? (
        <Alert tone="warning">
          <AlertDescription>{t('series.unresolved', { count: unresolved })}</AlertDescription>
        </Alert>
      ) : null}
      {error}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onBack}>
          {t('series.back')}
        </Button>
        <Button
          type="button"
          disabled={unresolved > 0 || creatable === 0}
          loading={committing}
          onClick={onCommit}
        >
          {t('series.create', { count: creatable })}
        </Button>
      </div>
    </div>
  );
}
