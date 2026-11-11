import type { LocationDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Clock, MapPinPlus, Pencil, Power } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../shared/api/locations-api.js';
import { describeError } from '../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogDestructiveAction,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../shared/ui/alert-dialog.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Badge } from '../../shared/ui/badge.js';
import { Button } from '../../shared/ui/button.js';
import { Switch } from '../../shared/ui/checkbox.js';
import { Label } from '../../shared/ui/label.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';

import { describeTimeZone } from './components/location-form.js';
import { LocationDialog } from './components/LocationDialog.js';

/** Settings > Sedes: where the organization attends, each with its own time zone. */
export function LocationsPage() {
  return (
    <RequirePermission anyOf={['locations.manage']}>
      <Locations />
    </RequirePermission>
  );
}

function Locations() {
  const { t } = useTranslation(['settings', 'common']);
  usePageTitle(t('settings:tab.locations'));
  const api = useApi();
  const queryClient = useQueryClient();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<LocationDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deactivating, setDeactivating] = useState<LocationDto | null>(null);

  const locations = useQuery({
    queryKey: [...LOCATIONS_QUERY_KEY, { showInactive }],
    queryFn: () => locationsApi(api).list(showInactive),
  });

  const setActive = useMutation({
    mutationFn: ({ location, active }: { location: LocationDto; active: boolean }) =>
      active
        ? locationsApi(api).reactivate(location.id)
        : locationsApi(api).deactivate(location.id),
    onSuccess: async (_result, { active }) => {
      toast.success(
        active ? t('settings:locations.reactivated') : t('settings:locations.deactivated'),
      );
      setDeactivating(null);
      await queryClient.invalidateQueries({ queryKey: LOCATIONS_QUERY_KEY });
    },
  });

  const items = locations.data ?? [];
  const addButton = (
    <Button
      onClick={() => {
        setCreating(true);
      }}
    >
      <MapPinPlus aria-hidden="true" />
      {t('settings:locations.add')}
    </Button>
  );

  return (
    <section aria-labelledby="locations-title" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="locations-title" className="font-display text-lg font-semibold">
            {t('settings:locations.title')}
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t('settings:locations.description')}
          </p>
        </div>
        {addButton}
      </div>

      {setActive.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, setActive.error).message}</AlertDescription>
        </Alert>
      ) : null}

      {locations.isPending ? (
        <ListSkeleton rows={3} />
      ) : locations.isError ? (
        <ErrorState
          error={locations.error}
          onRetry={() => {
            void locations.refetch();
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t('settings:locations.count', { count: items.length })}
            </p>
            <div className="flex items-center gap-2">
              <Switch id="show-inactive" checked={showInactive} onCheckedChange={setShowInactive} />
              <Label htmlFor="show-inactive">{t('settings:locations.showInactive')}</Label>
            </div>
          </div>
          {items.length === 0 ? (
            <EmptyState
              icon={Building2}
              title={t('settings:locations.empty.title')}
              description={t('settings:locations.empty.description')}
              action={addButton}
            />
          ) : (
            <ul className="grid gap-3">
              {items.map((location) => (
                <li
                  key={location.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4"
                >
                  <span className="grid size-10 shrink-0 place-content-center rounded-md bg-primary-soft text-primary-ink">
                    <Building2 className="size-5" aria-hidden="true" />
                  </span>
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span>{location.name}</span>
                      {location.active ? null : (
                        <Badge tone="neutral">{t('settings:locations.inactive')}</Badge>
                      )}
                    </p>
                    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Clock className="size-3.5" aria-hidden="true" />
                      {describeTimeZone(location.timeZone)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t('settings:locations.editLabel', { name: location.name })}
                      onClick={() => {
                        setEditing(location);
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      <span className="hidden sm:inline">{t('settings:locations.edit')}</span>
                    </Button>
                    {location.active ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('settings:locations.deactivateLabel', {
                          name: location.name,
                        })}
                        onClick={() => {
                          setDeactivating(location);
                        }}
                      >
                        <Power aria-hidden="true" />
                        <span className="hidden sm:inline">
                          {t('settings:locations.deactivate')}
                        </span>
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t('settings:locations.reactivateLabel', {
                          name: location.name,
                        })}
                        onClick={() => {
                          setActive.mutate({ location, active: true });
                        }}
                      >
                        <Power aria-hidden="true" />
                        <span className="hidden sm:inline">
                          {t('settings:locations.reactivate')}
                        </span>
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <LocationDialog open={creating} onOpenChange={setCreating} location={null} />
      <LocationDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        location={editing}
      />
      <AlertDialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings:locations.deactivate.title', { name: deactivating?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings:locations.deactivate.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogDestructiveAction
              onClick={(event) => {
                event.preventDefault();
                if (deactivating) setActive.mutate({ location: deactivating, active: false });
              }}
            >
              {t('settings:locations.deactivate.confirm')}
            </AlertDialogDestructiveAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
