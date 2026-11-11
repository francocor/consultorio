import { AUDIT_ACTIONS, AUDIT_OUTCOMES, type PatientSummaryDto } from '@consultorio/contracts';
import { keepPreviousData, useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Download, ScrollText, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { hasAnyPermission, useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { downloadBlob } from '../../shared/lib/download.js';
import { DEFAULT_TIME_ZONE } from '../../shared/lib/format.js';
import { describeError } from '../../shared/lib/translate.js';
import { Button } from '../../shared/ui/button.js';
import { Input, Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';
import { fullNameOf } from '../patients/components/PatientHeader.js';
import { PatientPicker } from '../patients/components/PatientPicker.js';

import { auditApi, auditKeys, type AuditFilters } from './api/audit-api.js';
import { AuditEventsTable } from './components/AuditEventsTable.js';
import { endOfDayIso, startOfDayIso } from './domain/period.js';

interface FilterState {
  action: string;
  outcome: string;
  from: string;
  to: string;
  patient: PatientSummaryDto | null;
}

const NO_FILTERS: FilterState = { action: '', outcome: '', from: '', to: '', patient: null };

function toApiFilters(state: FilterState): AuditFilters {
  return {
    action: state.action || undefined,
    outcome: state.outcome || undefined,
    patientId: state.patient?.id,
    from: state.from ? startOfDayIso(state.from, DEFAULT_TIME_ZONE) : undefined,
    to: state.to ? endOfDayIso(state.to, DEFAULT_TIME_ZONE) : undefined,
  };
}

/** Who did what and when, with filters, and the export. Owners and administrators only. */
export function AuditPage() {
  const { t, i18n } = useTranslation(['audit', 'common']);
  usePageTitle(t('audit:title'));
  const api = useApi();
  const me = useMe();
  const canExport = hasAnyPermission(me.permissions, ['audit.export']);
  const [state, setState] = useState<FilterState>(NO_FILTERS);
  const filters = toApiFilters(state);
  const active = Boolean(state.action || state.outcome || state.from || state.to || state.patient);

  const events = useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    queryFn: ({ pageParam }) => auditApi(api).list(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

  const exporting = useMutation({
    mutationFn: async (format: 'csv' | 'json') => {
      const file = await auditApi(api).export(format, filters);
      downloadBlob(file.blob, file.filename ?? `audit.${format}`);
    },
    onSuccess: () => {
      toast.success(t('audit:export.ready'));
    },
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });

  const items = events.data?.pages.flatMap((page) => page.events) ?? [];
  const patch = (change: Partial<FilterState>) => {
    setState((previous) => ({ ...previous, ...change }));
  };
  const actionOptions = AUDIT_ACTIONS.map((action) => ({
    action,
    label: i18n.exists(`audit:action.${action}`) ? t(`audit:action.${action}`) : action,
  })).sort((a, b) => a.label.localeCompare(b.label, 'es'));

  return (
    <div>
      <PageHeader
        title={t('audit:title')}
        description={t('audit:description')}
        actions={
          canExport ? (
            <>
              <Button
                variant="outline"
                loading={exporting.isPending && exporting.variables === 'csv'}
                onClick={() => {
                  exporting.mutate('csv');
                }}
              >
                <Download aria-hidden="true" />
                {t('audit:export.csv')}
              </Button>
              <Button
                variant="outline"
                loading={exporting.isPending && exporting.variables === 'json'}
                onClick={() => {
                  exporting.mutate('json');
                }}
              >
                <Download aria-hidden="true" />
                {t('audit:export.json')}
              </Button>
            </>
          ) : null
        }
      />

      <section
        aria-label={t('audit:filters.label')}
        className="mb-5 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="audit-action">{t('audit:filter.action')}</Label>
          <Select
            id="audit-action"
            value={state.action}
            onChange={(event) => {
              patch({ action: event.target.value });
            }}
          >
            <option value="">{t('audit:filter.action.all')}</option>
            {actionOptions.map((option) => (
              <option key={option.action} value={option.action}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-outcome">{t('audit:filter.outcome')}</Label>
          <Select
            id="audit-outcome"
            value={state.outcome}
            onChange={(event) => {
              patch({ outcome: event.target.value });
            }}
          >
            <option value="">{t('audit:filter.outcome.all')}</option>
            {AUDIT_OUTCOMES.map((outcome) => (
              <option key={outcome} value={outcome}>
                {t(`audit:outcome.${outcome}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-from">{t('audit:filter.from')}</Label>
          <Input
            id="audit-from"
            type="date"
            value={state.from}
            onChange={(event) => {
              patch({ from: event.target.value });
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="audit-to">{t('audit:filter.to')}</Label>
          <Input
            id="audit-to"
            type="date"
            value={state.to}
            onChange={(event) => {
              patch({ to: event.target.value });
            }}
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-2 lg:col-span-3">
          {state.patient ? (
            <>
              <span className="text-sm font-medium">{t('audit:filter.patient')}</span>
              <span className="inline-flex w-fit items-center gap-1 rounded-md bg-secondary py-1 pl-3 pr-1 text-sm font-medium">
                {t('audit:filter.patient.active', { name: fullNameOf(state.patient) })}
                <button
                  type="button"
                  aria-label={t('audit:filter.patient.remove')}
                  onClick={() => {
                    patch({ patient: null });
                  }}
                  className="grid size-7 cursor-pointer place-content-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </span>
            </>
          ) : (
            <PatientPicker
              label={t('audit:filter.patient')}
              onSelect={(patient) => {
                patch({ patient });
              }}
            />
          )}
        </div>
        {active ? (
          <div className="flex items-end">
            <Button
              variant="ghost"
              onClick={() => {
                setState(NO_FILTERS);
              }}
            >
              {t('audit:filter.clear')}
            </Button>
          </div>
        ) : null}
      </section>

      {events.isPending ? (
        <ListSkeleton rows={6} />
      ) : events.isError ? (
        <ErrorState
          error={events.error}
          onRetry={() => {
            void events.refetch();
          }}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={t('audit:empty.title')}
          description={t('audit:empty.description')}
        />
      ) : (
        <div className="grid gap-4" aria-busy={events.isPlaceholderData}>
          <AuditEventsTable events={items} />
          {events.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                loading={events.isFetchingNextPage}
                onClick={() => {
                  void events.fetchNextPage();
                }}
              >
                {t('audit:loadMore')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
