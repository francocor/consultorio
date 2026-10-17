import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Search, SearchX, UserPlus, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { useMe, hasAnyPermission } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { cn } from '../../shared/lib/cn.js';
import { useDebouncedValue } from '../../shared/lib/use-debounced-value.js';
import { Button, buttonVariants } from '../../shared/ui/button.js';
import { Input, Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { patientKeys, patientsApi, type PatientStatusFilter } from './api/patients-api.js';
import { PatientRow } from './components/PatientRow.js';

const SEARCH_DELAY_MS = 300;
const STATUSES: readonly PatientStatusFilter[] = ['active', 'inactive', 'all'];

/** The registry: search by name, document or phone, and open a record. */
export function PatientsPage() {
  const { t } = useTranslation(['patients', 'common']);
  usePageTitle(t('patients:title'));
  const api = useApi();
  const me = useMe();
  const canCreate = hasAnyPermission(me.permissions, ['patients.write']);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<PatientStatusFilter>('active');
  const query = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);

  const patients = useInfiniteQuery({
    queryKey: patientKeys.search(query, status),
    queryFn: ({ pageParam }) => patientsApi(api).search({ q: query, status, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // While a new search is on its way the previous results stay on screen: no flicker.
    placeholderData: keepPreviousData,
  });

  const items = patients.data?.pages.flatMap((page) => page.patients) ?? [];
  const newButton = canCreate ? (
    <Link to="/patients/new" className={cn(buttonVariants())}>
      <UserPlus className="size-4" aria-hidden="true" />
      {t('patients:new')}
    </Link>
  ) : null;

  return (
    <div>
      <PageHeader
        title={t('patients:title')}
        description={t('patients:description')}
        actions={newButton}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="relative">
          <Label htmlFor="patient-search" className="sr-only">
            {t('patients:search.label')}
          </Label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="patient-search"
            type="search"
            role="searchbox"
            autoComplete="off"
            className="pl-9"
            placeholder={t('patients:search.placeholder')}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="patient-status" className="text-muted-foreground">
            {t('patients:status.label')}
          </Label>
          <Select
            id="patient-status"
            className="w-auto"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as PatientStatusFilter);
            }}
          >
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {t(`patients:status.${option}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {patients.isPending ? (
        <ListSkeleton rows={6} />
      ) : patients.isError ? (
        <ErrorState
          error={patients.error}
          onRetry={() => {
            void patients.refetch();
          }}
        />
      ) : items.length === 0 ? (
        query === '' ? (
          <EmptyState
            icon={UsersRound}
            title={t('patients:empty.title')}
            description={t('patients:empty.description')}
            action={newButton}
          />
        ) : (
          <EmptyState
            icon={SearchX}
            title={t('patients:noResults.title')}
            description={t('patients:noResults.description', { query })}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setText('');
                }}
              >
                {t('patients:noResults.clear')}
              </Button>
            }
          />
        )
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
            {t('patients:count', { count: items.length })}
          </p>
          <ul className="grid gap-2" aria-busy={patients.isPlaceholderData}>
            {items.map((patient) => (
              <PatientRow key={patient.id} patient={patient} />
            ))}
          </ul>
          {patients.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                loading={patients.isFetchingNextPage}
                onClick={() => {
                  void patients.fetchNextPage();
                }}
              >
                {t('patients:loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
