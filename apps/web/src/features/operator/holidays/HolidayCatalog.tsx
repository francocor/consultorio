import type { OperatorHolidayDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarHeart, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatCalendarDay } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
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
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
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
import { toast } from '../../../shared/ui/toaster.js';
import { operatorApi, operatorKeys } from '../api/operator-api.js';

/** The catalog is per country; Argentina is the only one the product knows today. */
const COUNTRY = 'AR';
const KINDS = ['national', 'bridge'] as const;

/**
 * The holiday catalog of the country, kept by the platform. A change here reaches every
 * organization the next time its agenda is opened: it is data, not a release.
 */
export function HolidayCatalog() {
  const { t } = useTranslation(['operator', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<OperatorHolidayDto | null>(null);

  const holidays = useQuery({
    queryKey: operatorKeys.holidays(COUNTRY, year),
    queryFn: () => operatorApi(api).holidays(COUNTRY, year),
  });

  const remove = useMutation({
    mutationFn: (holiday: OperatorHolidayDto) => operatorApi(api).removeHoliday(holiday.id),
    onSuccess: async () => {
      toast.success(t('operator:holidays.removed'));
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: operatorKeys.holidaysAll });
    },
  });

  const items = [...(holidays.data ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const add = (
    <Button
      onClick={() => {
        setAdding(true);
      }}
    >
      <Plus aria-hidden="true" />
      {t('operator:holidays.add')}
    </Button>
  );

  return (
    <div className="grid gap-4">
      <PageHeader
        title={t('operator:holidays.title')}
        description={t('operator:holidays.description')}
        actions={add}
        className="mb-0"
      />

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label={t('operator:holidays.previousYear')}
          onClick={() => {
            setYear((value) => value - 1);
          }}
        >
          <ChevronLeft aria-hidden="true" />
        </Button>
        <p
          aria-live="polite"
          className="tabular min-w-24 text-center font-display text-lg font-semibold"
        >
          {t('operator:holidays.yearOf', { country: COUNTRY, year })}
        </p>
        <Button
          variant="outline"
          size="icon"
          aria-label={t('operator:holidays.nextYear')}
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
        <ListSkeleton rows={5} />
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
          title={t('operator:holidays.empty.title', { year })}
          description={t('operator:holidays.empty.description')}
          action={add}
        />
      ) : (
        <TableContainer aria-label={t('operator:holidays.table')}>
          <Table>
            <TableCaption>{t('operator:holidays.table')}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('operator:holidays.col.date')}</TableHead>
                <TableHead>{t('operator:holidays.col.name')}</TableHead>
                <TableHead>{t('operator:holidays.col.kind')}</TableHead>
                <TableHead>{t('operator:holidays.col.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((holiday) => (
                <TableRow key={holiday.id}>
                  <TableCell className="tabular whitespace-nowrap">
                    <time dateTime={holiday.date}>{formatCalendarDay(holiday.date)}</time>
                  </TableCell>
                  <TableCell className="font-medium">{holiday.name}</TableCell>
                  <TableCell>
                    <Badge tone="info">{t(`operator:holidays.kind.${holiday.kind}`)}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t('operator:holidays.removeNamed', { name: holiday.name })}
                      onClick={() => {
                        setRemoving(holiday);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      {t('operator:holidays.remove')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {adding ? (
        <AddHolidayDialog
          year={year}
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
            <AlertDialogTitle>{t('operator:holidays.removeDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('operator:holidays.removeDialog.description', { name: removing?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              onClick={() => {
                if (removing) remove.mutate(removing);
              }}
            >
              {t('operator:holidays.removeDialog.confirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddHolidayDialog({ year, onClose }: { year: number; onClose: () => void }) {
  const { t } = useTranslation(['operator', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('national');

  const create = useMutation({
    mutationFn: () =>
      operatorApi(api).addHoliday({ country: COUNTRY, date, name: name.trim(), kind }),
    onSuccess: async () => {
      toast.success(t('operator:holidays.added'));
      await queryClient.invalidateQueries({ queryKey: operatorKeys.holidaysAll });
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
          <DialogTitle>{t('operator:holidays.add')}</DialogTitle>
          <DialogDescription>{t('operator:holidays.formHelp', { year })}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (date !== '' && name.trim() !== '') create.mutate();
          }}
        >
          {create.isError ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, create.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="holiday-date">{t('operator:holidays.col.date')}</Label>
            <Input
              id="holiday-date"
              type="date"
              value={date}
              onChange={(event) => {
                setDate(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="holiday-name">{t('operator:holidays.col.name')}</Label>
            <Input
              id="holiday-name"
              autoComplete="off"
              maxLength={120}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="holiday-kind">{t('operator:holidays.col.kind')}</Label>
            <Select
              id="holiday-kind"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value === 'bridge' ? 'bridge' : 'national');
              }}
            >
              {KINDS.map((option) => (
                <option key={option} value={option}>
                  {t(`operator:holidays.kind.${option}`)}
                </option>
              ))}
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={date === '' || name.trim() === ''}
              loading={create.isPending}
            >
              {t('operator:holidays.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
