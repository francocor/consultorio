import {
  WORKLIST_KINDS,
  WORKLIST_STATUSES,
  type WorklistKind,
  type WorklistStatus,
} from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { cn } from '../../shared/lib/cn.js';
import { Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { Segment } from '../calendar/components/CalendarToolbar.js';
import {
  useSchedulingLocations,
  useSchedulingProfessionals,
} from '../calendar/containers/use-scheduling-people.js';

import { worklistApi, worklistKeys } from './api/worklist-api.js';
import { WorklistItemCard } from './components/WorklistItemCard.js';
import { countByKind, filterItems } from './domain/worklist-items.js';

/** The reception worklist: one queue for everything that needs a person. */
export function WorklistPage() {
  return (
    <RequirePermission anyOf={['worklist.manage']}>
      <Worklist />
    </RequirePermission>
  );
}

function Worklist() {
  const { t } = useTranslation(['scheduling', 'common']);
  usePageTitle(t('scheduling:worklist.title'));
  const api = useApi();
  const { locations } = useSchedulingLocations();
  const { professionals } = useSchedulingProfessionals();
  const [status, setStatus] = useState<WorklistStatus>('open');
  const [kind, setKind] = useState<WorklistKind | undefined>(undefined);
  const [locationId, setLocationId] = useState<string | undefined>(undefined);

  // The whole list is fetched and filtered here: counts per kind need every kind anyway.
  const list = useQuery({
    queryKey: worklistKeys.list(status, undefined),
    queryFn: () => worklistApi(api).list(status),
    refetchInterval: 60_000,
  });

  const all = list.data?.items ?? [];
  const counts = countByKind(filterItems(all, { locationId }));
  const visible = filterItems(all, { kind, locationId });
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const nameOf = new Map(professionals.map((person) => [person.id, person.name]));

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader
        title={t('scheduling:worklist.title')}
        description={t('scheduling:worklist.description')}
        className="mb-0"
      />

      <div className="flex flex-wrap items-end gap-3">
        <div
          role="group"
          aria-label={t('scheduling:worklist.statusGroup')}
          className="inline-flex divide-x overflow-hidden rounded-md border border-input"
        >
          {WORKLIST_STATUSES.map((option) => (
            <Segment
              key={option}
              pressed={status === option}
              onClick={() => {
                setStatus(option);
              }}
            >
              {t(`scheduling:worklist.status.${option}`)}
            </Segment>
          ))}
        </div>
        {locations.length > 1 ? (
          <div className="grid gap-1.5">
            <Label htmlFor="worklist-location">{t('scheduling:filter.location')}</Label>
            <Select
              id="worklist-location"
              value={locationId ?? ''}
              onChange={(event) => {
                setLocationId(event.target.value === '' ? undefined : event.target.value);
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
      </div>

      {total > 0 ? (
        <div
          role="group"
          aria-label={t('scheduling:worklist.kindGroup')}
          className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap"
        >
          <KindChip
            pressed={kind === undefined}
            onClick={() => {
              setKind(undefined);
            }}
          >
            {t('scheduling:worklist.kindAll', { count: total })}
          </KindChip>
          {WORKLIST_KINDS.filter((option) => counts[option] > 0).map((option) => (
            <KindChip
              key={option}
              pressed={kind === option}
              onClick={() => {
                setKind(option);
              }}
            >
              {t('scheduling:worklist.kindCount', {
                kind: t(`scheduling:worklist.kind.${option}`),
                count: counts[option],
              })}
            </KindChip>
          ))}
        </div>
      ) : null}

      {list.isPending ? (
        <ListSkeleton rows={4} />
      ) : list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title={t(`scheduling:worklist.empty.${status}`)}
          description={t('scheduling:worklist.empty.description')}
        />
      ) : (
        <ul className="grid gap-3">
          {visible.map((item) => (
            <WorklistItemCard
              key={item.id}
              item={item}
              locations={locations}
              professionalName={
                item.appointment ? nameOf.get(item.appointment.professionalId) : undefined
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function KindChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'touch-target-md inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full border px-3.5 text-sm font-medium',
        pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-card hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}
