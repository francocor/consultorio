import type { FinancialRecordKind } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../../app/guards.js';
import { useApi } from '../../../app/providers.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { reportKeys, reportsApi, type ReportQuery } from '../api/reports-api.js';
import { AppliedFilters, FilterBar, appliedParts } from '../components/FilterBar.js';
import { ReportNav } from '../components/ReportNav.js';
import { currentMonth } from '../domain/period.js';

import { ExportPanel } from './ExportPanel.js';
import { MoneyBreakdownWidget } from './MoneyBreakdownWidget.js';
import { MoneyRecordsWidget } from './MoneyRecordsWidget.js';
import { MoneySeriesWidget } from './MoneySeriesWidget.js';
import { MoneySummaryWidget } from './MoneySummaryWidget.js';

/** The money report. What each person sees is cut on the server by their role. */
export function FinancialReportPage() {
  return (
    <RequirePermission anyOf={['reports.read']}>
      <Financial />
    </RequirePermission>
  );
}

function Financial() {
  const { t } = useTranslation('reports');
  usePageTitle(t('money.title'));
  const api = useApi();
  const [query, setQuery] = useState<ReportQuery>(() => currentMonth(new Date()));
  const [kind, setKind] = useState<FinancialRecordKind>('charged');
  const [offset, setOffset] = useState(0);

  // Independent requests: the filters, the figures and the list each load, fail and retry on their own.
  const options = useQuery({
    queryKey: reportKeys.options,
    queryFn: () => reportsApi(api).options(),
    staleTime: 60_000,
  });
  const report = useQuery({
    queryKey: reportKeys.financial(query),
    queryFn: () => reportsApi(api).financial(query),
  });

  const open = (next: FinancialRecordKind) => {
    setKind(next);
    setOffset(0);
    // So the person sees the list change (a browser scrolls; the test environment has no layout).
    const list = document.getElementById('money-records');
    if (list && 'scrollIntoView' in list) list.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader title={t('money.title')} description={t('money.description')} className="mb-0" />
      <ReportNav canSeeCash={options.data?.canSeeCashReport ?? false} />
      <FilterBar
        // A fresh bar for each applied period, so its fields start from what is on screen.
        key={JSON.stringify(query)}
        query={query}
        options={options.data}
        variant="financial"
        onApply={(next) => {
          setQuery(next);
          setOffset(0);
        }}
      />
      <AppliedFilters
        query={query}
        options={options.data}
        scope={report.data?.filters.scope}
        scopeKey="money.scope"
      />
      {report.data ? (
        <p className="text-xs text-muted-foreground">
          {t('applied.generated', { when: formatDateTime(report.data.generatedAt) })}
        </p>
      ) : null}
      <MoneySummaryWidget request={report} report={report.data} onOpen={open} />
      <MoneySeriesWidget request={report} report={report.data} />
      <MoneyBreakdownWidget request={report} report={report.data} />
      <div id="money-records">
        <MoneyRecordsWidget
          query={query}
          kind={kind}
          offset={offset}
          showProfessional={options.data?.canSeeRevenueByProfessional ?? false}
          onKindChange={(next) => {
            setKind(next);
            setOffset(0);
          }}
          onOffsetChange={setOffset}
        />
      </div>
      <ExportPanel
        kinds={['charges', 'payments', 'payer_settlement']}
        query={query}
        filtersText={appliedParts(query, options.data, t).join(' · ')}
      />
    </div>
  );
}
