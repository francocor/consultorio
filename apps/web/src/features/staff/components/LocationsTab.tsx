import type { StaffMemberDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../../shared/api/locations-api.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { staffApi, staffKeys } from '../api/staff-api.js';

import { WeeklyHours } from './WeeklyHours.js';

/** Where the person works, and (for professionals) the weekly hours at each of those places. */
export function LocationsTab({ member }: { member: StaffMemberDto }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const professionalId = member.professional?.id;

  const places = useQuery({
    queryKey: LOCATIONS_QUERY_KEY,
    queryFn: () => locationsApi(api).list(),
  });
  const assigned = useQuery({
    queryKey: staffKeys.locations(member.membershipId),
    queryFn: () => staffApi(api).memberLocations(member.membershipId),
  });

  if (places.isPending || assigned.isPending) return <FormSkeleton fields={3} />;
  if (places.isError || assigned.isError) {
    return (
      <ErrorState
        error={places.error ?? assigned.error}
        onRetry={() => {
          void places.refetch();
          void assigned.refetch();
        }}
      />
    );
  }

  const saved = assigned.data.locationIds;
  const assignedPlaces = places.data.filter((place) => saved.includes(place.id));

  return (
    <div className="grid gap-8">
      <AssignmentForm
        key={saved.join(',')}
        member={member}
        locations={places.data}
        saved={saved}
        onSaved={async () => {
          await queryClient.invalidateQueries({ queryKey: staffKeys.all });
        }}
      />
      {professionalId ? (
        <HoursSection professionalId={professionalId} locations={assignedPlaces} />
      ) : null}
    </div>
  );
}

function AssignmentForm({
  member,
  locations,
  saved,
  onSaved,
}: {
  member: StaffMemberDto;
  locations: { id: string; name: string }[];
  saved: readonly string[];
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation('staff');
  const api = useApi();
  const [selected, setSelected] = useState<string[]>([...saved]);
  const save = useMutation({
    mutationFn: () => staffApi(api).setMemberLocations(member.membershipId, selected),
    onSuccess: async () => {
      toast.success(t('locations.saved'));
      await onSaved();
    },
  });
  const changed = selected.length !== saved.length || selected.some((id) => !saved.includes(id));

  return (
    <section className="grid gap-3" aria-labelledby="member-locations-title">
      <div className="grid gap-1">
        <h3 id="member-locations-title" className="font-display text-base font-semibold">
          {t('locations.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('locations.description')}</p>
      </div>
      {save.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}
      {locations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('locations.empty')}</p>
      ) : (
        <ul className="grid gap-2">
          {locations.map((place) => (
            <li key={place.id}>
              <CheckboxCard
                checked={selected.includes(place.id)}
                onCheckedChange={(checked) => {
                  setSelected((current) =>
                    checked ? [...current, place.id] : current.filter((id) => id !== place.id),
                  );
                }}
                title={place.name}
              />
            </li>
          ))}
        </ul>
      )}
      <Button
        className="justify-self-start"
        loading={save.isPending}
        disabled={!changed}
        onClick={() => {
          save.mutate();
        }}
      >
        {t('locations.save')}
      </Button>
    </section>
  );
}

function HoursSection({
  professionalId,
  locations,
}: {
  professionalId: string;
  locations: { id: string; name: string; timeZone: string; active: boolean }[];
}) {
  const { t } = useTranslation('staff');
  const api = useApi();
  const queryClient = useQueryClient();
  const hours = useQuery({
    queryKey: staffKeys.hours(professionalId),
    queryFn: () => staffApi(api).hours(professionalId),
  });
  const save = useMutation({
    mutationFn: (rows: Parameters<ReturnType<typeof staffApi>['setHours']>[1]) =>
      staffApi(api).setHours(professionalId, rows),
    onSuccess: async () => {
      toast.success(t('hours.saved'));
      await queryClient.invalidateQueries({ queryKey: staffKeys.hours(professionalId) });
    },
  });

  return (
    <section className="grid gap-3 border-t pt-6" aria-labelledby="hours-title">
      <div className="grid gap-1">
        <h3 id="hours-title" className="font-display text-base font-semibold">
          {t('hours.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('hours.description')}</p>
      </div>
      {locations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('hours.noLocations')}</p>
      ) : hours.isPending ? (
        <FormSkeleton fields={3} />
      ) : hours.isError ? (
        <ErrorState
          error={hours.error}
          onRetry={() => {
            void hours.refetch();
          }}
        />
      ) : (
        <>
          {save.isError ? (
            <Alert tone="danger">
              <AlertDescription>
                {isApiError(save.error) && save.error.status === 400
                  ? t('hours.error.crossLocation')
                  : describeError(t, save.error).message}
              </AlertDescription>
            </Alert>
          ) : null}
          <WeeklyHours
            key={JSON.stringify(hours.data.hours)}
            locations={locations}
            rows={hours.data.hours}
            saving={save.isPending}
            onSave={(rows) => {
              save.mutate(rows);
            }}
          />
        </>
      )}
    </section>
  );
}
