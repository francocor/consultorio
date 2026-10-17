import type { AppointmentTypeDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Plus, Power } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
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
import { Switch } from '../../../../shared/ui/checkbox.js';
import { Label } from '../../../../shared/ui/label.js';
import { EmptyState } from '../../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../../shared/ui/states/loading-skeleton.js';
import { StatusBadge } from '../../../../shared/ui/states/status-badge.js';
import { toast } from '../../../../shared/ui/toaster.js';
import { useSchedulingProfessionals } from '../../../calendar/containers/use-scheduling-people.js';
import { schedulingSettingsApi, schedulingSettingsKeys } from '../api/scheduling-settings-api.js';

import { AppointmentTypeDialog } from './AppointmentTypeDialog.js';

/** What can be booked: each type with its length, margin and who attends it. */
export function AppointmentTypesSection() {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const { professionals } = useSchedulingProfessionals();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<AppointmentTypeDto | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<AppointmentTypeDto | null>(null);

  const types = useQuery({
    queryKey: schedulingSettingsKeys.types(showInactive),
    queryFn: () => schedulingSettingsApi(api).types(showInactive),
  });

  const setActive = useMutation({
    mutationFn: ({ type, active }: { type: AppointmentTypeDto; active: boolean }) =>
      schedulingSettingsApi(api).setTypeActive(type.id, active),
    onSuccess: async (_result, { active }) => {
      toast.success(
        t(active ? 'scheduling:config.types.reactivated' : 'scheduling:config.types.deactivated'),
      );
      setDeactivating(null);
      await queryClient.invalidateQueries({ queryKey: schedulingSettingsKeys.all });
      await queryClient.invalidateQueries({ queryKey: ['calendar', 'types'] });
    },
  });

  const nameOf = (id: string) => professionals.find((person) => person.id === id)?.name;
  const items = types.data ?? [];
  const add = (
    <Button
      onClick={() => {
        setEditing('new');
      }}
    >
      <Plus aria-hidden="true" />
      {t('scheduling:config.types.add')}
    </Button>
  );

  return (
    <section aria-labelledby="types-title" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="types-title" className="font-display text-lg font-semibold">
            {t('scheduling:config.types.title')}
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('scheduling:config.types.description')}
          </p>
        </div>
        {add}
      </div>

      {setActive.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, setActive.error).message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-2">
        <Switch id="types-inactive" checked={showInactive} onCheckedChange={setShowInactive} />
        <Label htmlFor="types-inactive">{t('scheduling:config.types.showInactive')}</Label>
      </div>

      {types.isPending ? (
        <ListSkeleton rows={3} />
      ) : types.isError ? (
        <ErrorState
          error={types.error}
          onRetry={() => {
            void types.refetch();
          }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={t('scheduling:config.types.empty.title')}
          description={t('scheduling:config.types.empty.description')}
          action={add}
        />
      ) : (
        <ul className="grid gap-3">
          {items.map((type) => (
            <li
              key={type.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4"
            >
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full border"
                style={{ backgroundColor: type.color ?? 'transparent' }}
              />
              <div className="grid min-w-0 flex-1 basis-56 gap-1">
                <p className="font-medium">{type.name}</p>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span className="tabular">
                    {t('scheduling:config.types.minutes', { count: type.durationMinutes })}
                  </span>
                  {type.bufferMinutes > 0 ? (
                    <span className="tabular">
                      {t('scheduling:config.types.bufferAfter', { count: type.bufferMinutes })}
                    </span>
                  ) : null}
                  <span>{t(`scheduling:config.types.modeOption.${type.mode}`)}</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {type.professionalIds.length === 0
                    ? t('scheduling:config.types.everyone')
                    : type.professionalIds
                        .map((id) => nameOf(id) ?? '')
                        .filter(Boolean)
                        .join(', ')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <StatusBadge status={type.active ? 'active' : 'inactive'} />
                  {type.requiresApproval ? (
                    <Badge tone="warning">{t('scheduling:config.types.approvalBadge')}</Badge>
                  ) : null}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('scheduling:config.types.editNamed', { name: type.name })}
                  onClick={() => {
                    setEditing(type);
                  }}
                >
                  <Pencil aria-hidden="true" />
                  {t('common:action.edit')}
                </Button>
                {type.active ? (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('scheduling:config.types.deactivateNamed', { name: type.name })}
                    onClick={() => {
                      setDeactivating(type);
                    }}
                  >
                    <Power aria-hidden="true" />
                    {t('scheduling:config.types.deactivate')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('scheduling:config.types.reactivateNamed', { name: type.name })}
                    loading={setActive.isPending}
                    onClick={() => {
                      setActive.mutate({ type, active: true });
                    }}
                  >
                    <Power aria-hidden="true" />
                    {t('scheduling:config.types.reactivate')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing !== null ? (
        <AppointmentTypeDialog
          type={editing === 'new' ? null : editing}
          professionals={professionals}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}

      <AlertDialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('scheduling:config.types.deactivateDialog.title', {
                name: deactivating?.name ?? '',
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('scheduling:config.types.deactivateDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              onClick={() => {
                if (deactivating) setActive.mutate({ type: deactivating, active: false });
              }}
            >
              {t('scheduling:config.types.deactivateDialog.confirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
