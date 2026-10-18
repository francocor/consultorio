import type { ReportGroup } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { PageHeader } from '../../shared/ui/page-header.js';

import { reportKeys, reportsApi, type ReportQuery } from './api/reports-api.js';
import { BreakdownWidget } from './components/BreakdownWidget.js';
import { AppliedFilters, FilterBar } from './components/FilterBar.js';
import { RecordsWidget } from './components/RecordsWidget.js';
import { ReportNav } from './components/ReportNav.js';
import { SeriesWidget } from './components/SeriesWidget.js';
import { StatusWidget } from './components/StatusWidget.js';
import { SummaryWidget } from './components/SummaryWidget.js';
import { currentMonth } from './domain/period.js';

/** The reports dashboard. What each person sees is cut on the server by their role. */
export function ReportsPage() {
  return (
    <RequirePermission anyOf={['reports.read']}>
      <Reports />
    </RequirePermission>
  );
}

function Reports() {
  const { t } = useTranslation('reports');
  usePageTitle(t('title'));
  const api = useApi();
  const [query, setQuery] = useState<ReportQuery>(() => currentMonth(new Date()));
  const [group, setGroup] = useState<ReportGroup>('all');
  const [offset, setOffset] = useState(0);

  // Independent requests: the filters, the figures and the list each load, fail and retry on their own.
  const options = useQuery({
    queryKey: reportKeys.options,
    queryFn: () => reportsApi(api).options(),
    staleTime: 60_000,
  });
  const report = useQuery({
    queryKey: reportKeys.operational(query),
    queryFn: () => reportsApi(api).operational(query),
  });

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader title={t('title')} description={t('description')} className="mb-0" />
      <ReportNav canSeeCash={options.data?.canSeeCashReport ?? false} />
      <FilterBar
        // A fresh bar for each applied period, so its fields start from what is on screen.
        key={JSON.stringify(query)}
        query={query}
        options={options.data}
        onApply={(next) => {
          setQuery(next);
          setGroup('all');
          setOffset(0);
        }}
      />
      <AppliedFilters query={query} options={options.data} scope={report.data?.filters.scope} />
      <SummaryWidget request={report} report={report.data} />
      <StatusWidget
        request={report}
        report={report.data}
        onShow={(status) => {
          setGroup(status);
          setOffset(0);
        }}
      />
      <SeriesWidget request={report} report={report.data} />
      <BreakdownWidget request={report} report={report.data} />
      <RecordsWidget
        query={query}
        group={group}
        offset={offset}
        onGroupChange={(next) => {
          setGroup(next);
          setOffset(0);
        }}
        onOffsetChange={setOffset}
      />
    </div>
  );
}
