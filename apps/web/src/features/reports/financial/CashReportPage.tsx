import type { CashReportResponse } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../../app/guards.js';
import { useApi } from '../../../app/providers.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import {
  formatCalendarDay,
  formatDateTime,
  formatMoney,
  formatNumber,
} from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { buttonVariants } from '../../../shared/ui/button.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';
import { reportKeys, reportsApi, type ReportQuery } from '../api/reports-api.js';
import { AppliedFilters, FilterBar, appliedParts } from '../components/FilterBar.js';
import { ReportNav } from '../components/ReportNav.js';
import { ReportWidget, type WidgetRequest } from '../components/ReportWidget.js';
import { currentMonth } from '../domain/period.js';

import { ExportPanel } from './ExportPanel.js';

/** The cash report. The server refuses it to a role that has none; the page says so instead of failing. */
export function CashReportPage() {
  return (
    <RequirePermission anyOf={['reports.read']}>
      <Cash />
    </RequirePermission>
  );
}

function EmptyCash() {
  const { t } = useTranslation('reports');
  return (
    <EmptyState
      className="py-8"
      icon={Landmark}
      title={t('cash.days.empty.title')}
      description={t('cash.days.empty.description')}
      action={
        <Link to="/cash" className={buttonVariants({ variant: 'outline' })}>
          {t('cash.days.empty.action')}
        </Link>
      }
    />
  );
}

function SummaryTiles({ report }: { report: CashReportResponse }) {
  const { t } = useTranslation('reports');
  const { totals } = report;
  const tiles = [
    {
      id: 'opening',
      label: t('cash.kpi.opening'),
      value: formatMoney(totals.openingCents),
      detail: '',
    },
    {
      id: 'payments',
      label: t('cash.kpi.payments'),
      value: formatMoney(totals.paymentsCents),
      detail: '',
    },
    {
      id: 'refunds',
      label: t('cash.kpi.refunds'),
      value: formatMoney(totals.refundsCents),
      detail: '',
    },
    {
      id: 'expected',
      label: t('cash.kpi.expected'),
      value: formatMoney(totals.expectedCents),
      detail: '',
    },
    {
      id: 'counted',
      label: t('cash.kpi.counted'),
      value: totals.countedCents === null ? '–' : formatMoney(totals.countedCents),
      detail: totals.countedCents === null ? t('cash.kpi.countedNone') : '',
    },
    {
      id: 'difference',
      label: t('cash.kpi.difference'),
      value: totals.differenceCents === null ? '–' : formatMoney(totals.differenceCents),
      detail:
        totals.differenceCents === null
          ? t('cash.kpi.differenceNone')
          : t('cash.kpi.differenceDetail', { count: formatNumber(totals.daysWithDifference) }),
    },
  ];
  return (
    <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
      {tiles.map((tile) => (
        <div key={tile.id} className="grid min-w-0 content-start gap-1 rounded-lg border p-3">
          <dt className="text-sm font-medium text-muted-foreground">{tile.label}</dt>
          <dd className="grid gap-1">
            <span className="tabular font-display text-2xl font-semibold">{tile.value}</span>
            {tile.detail ? (
              <span className="text-xs text-muted-foreground">{tile.detail}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SummaryWidget({
  request,
  report,
}: {
  request: WidgetRequest;
  report: CashReportResponse | undefined;
}) {
  const { t } = useTranslation('reports');
  return (
    <ReportWidget
      title={t('cash.summary.title')}
      description={t('cash.basis')}
      request={request}
      empty={report?.days.length === 0}
      emptyState={<EmptyCash />}
    >
      {report ? <SummaryTiles report={report} /> : null}
    </ReportWidget>
  );
}

/** A register per location and day, with its difference and the reason that was written. */
function DaysWidget({
  request,
  report,
}: {
  request: WidgetRequest;
  report: CashReportResponse | undefined;
}) {
  const { t } = useTranslation('reports');
  const title = t('cash.days.title');
  return (
    <ReportWidget
      title={title}
      description={t('cash.days.description')}
      request={request}
      empty={report?.days.length === 0}
      emptyState={<EmptyCash />}
    >
      <TableContainer aria-label={t('table.label', { title })}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('cash.days.column.date')}</TableHead>
              <TableHead>{t('cash.days.column.location')}</TableHead>
              <TableHead className="text-right">{t('cash.days.column.opening')}</TableHead>
              <TableHead className="text-right">{t('cash.days.column.payments')}</TableHead>
              <TableHead className="text-right">{t('cash.days.column.refunds')}</TableHead>
              <TableHead className="text-right">{t('cash.days.column.expected')}</TableHead>
              <TableHead className="text-right">{t('cash.days.column.counted')}</TableHead>
              <TableHead className="text-right">{t('cash.days.column.difference')}</TableHead>
              <TableHead>{t('cash.days.column.status')}</TableHead>
              <TableHead>{t('cash.days.column.reason')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(report?.days ?? []).map((day) => {
              const reasons = day.sessions.flatMap((session) =>
                session.differenceCents !== null &&
                session.differenceCents !== 0 &&
                session.differenceReason
                  ? [session.differenceReason]
                  : [],
              );
              return (
                <TableRow key={`${day.date}-${day.locationId}`}>
                  <TableCell className="tabular whitespace-nowrap">
                    {formatCalendarDay(day.date)}
                  </TableCell>
                  <TableCell className="font-medium">{day.locationName}</TableCell>
                  <TableCell className="tabular text-right">
                    {formatMoney(day.openingCents)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatMoney(day.paymentsCents)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatMoney(day.refundsCents)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {formatMoney(day.expectedCents)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {day.countedCents === null ? '–' : formatMoney(day.countedCents)}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {day.differenceCents === null ? (
                      '–'
                    ) : day.differenceCents === 0 ? (
                      t('cash.days.exact')
                    ) : (
                      <span className="font-semibold text-destructive">
                        {formatMoney(day.differenceCents)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {day.openSessions > 0 && day.closedSessions === 0 ? (
                      <Badge tone="info">{t('cash.days.open')}</Badge>
                    ) : day.openSessions === 0 ? (
                      <Badge>{t('cash.days.closed')}</Badge>
                    ) : (
                      <Badge tone="warning">
                        {t('cash.days.mixed', {
                          open: day.openSessions,
                          closed: day.closedSessions,
                        })}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {reasons.length === 0 ? (
                      t('cash.days.noReason')
                    ) : (
                      <ul className="grid gap-1">
                        {reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </ReportWidget>
  );
}

/** What came in and went back by method of payment, for the whole period. */
function MethodsWidget({
  request,
  report,
}: {
  request: WidgetRequest;
  report: CashReportResponse | undefined;
}) {
  const { t } = useTranslation('reports');
  const title = t('cash.methods.title');
  const rows = report?.totals.byMethod ?? [];
  return (
    <ReportWidget
      title={title}
      request={request}
      empty={report?.days.length === 0}
      emptyState={<p className="text-sm text-muted-foreground">{t('cash.methods.empty')}</p>}
    >
      <TableContainer aria-label={t('table.label', { title })}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('cash.methods.column.method')}</TableHead>
              <TableHead className="text-right">{t('cash.methods.column.count')}</TableHead>
              <TableHead className="text-right">{t('cash.methods.column.payments')}</TableHead>
              <TableHead className="text-right">{t('cash.methods.column.refunds')}</TableHead>
              <TableHead className="text-right">{t('cash.methods.column.net')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.method}>
                <TableCell className="font-medium">
                  {t(`money.records.method.${row.method}`)}
                </TableCell>
                <TableCell className="tabular text-right">{formatNumber(row.count)}</TableCell>
                <TableCell className="tabular text-right">
                  {formatMoney(row.paymentsCents)}
                </TableCell>
                <TableCell className="tabular text-right">
                  {formatMoney(row.refundsCents)}
                </TableCell>
                <TableCell className="tabular text-right">{formatMoney(row.netCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </ReportWidget>
  );
}

function Cash() {
  const { t } = useTranslation('reports');
  usePageTitle(t('cash.title'));
  const api = useApi();
  const [query, setQuery] = useState<ReportQuery>(() => currentMonth(new Date()));

  const options = useQuery({
    queryKey: reportKeys.options,
    queryFn: () => reportsApi(api).options(),
    staleTime: 60_000,
  });
  // A role with no cash report never asks for it (the server would refuse it, and leave a denial
  // in the audit log): it waits to know what the viewer may read, and the page says why.
  const denied = options.data?.canSeeCashReport === false;
  const cash = useQuery({
    queryKey: reportKeys.cash(query),
    queryFn: () => reportsApi(api).cash(query),
    enabled: options.data?.canSeeCashReport === true,
  });
  // Without the options there is nothing to wait for: say so instead of loading forever.
  const report = options.isError ? options : cash;

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader title={t('cash.title')} description={t('cash.description')} className="mb-0" />
      <ReportNav canSeeCash={options.data?.canSeeCashReport ?? false} />
      {denied ? (
        <Alert tone="info">
          <AlertDescription>
            <strong className="block">{t('cash.denied.title')}</strong>
            {t('cash.denied.description')}
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <FilterBar
            key={JSON.stringify(query)}
            query={query}
            options={options.data}
            variant="cash"
            onApply={setQuery}
          />
          <AppliedFilters
            query={query}
            options={options.data}
            scope={cash.data?.filters.scope}
            scopeKey="cash.scope"
          />
          {cash.data ? (
            <p className="text-xs text-muted-foreground">
              {t('applied.generated', { when: formatDateTime(cash.data.generatedAt) })}
            </p>
          ) : null}
          <SummaryWidget request={report} report={cash.data} />
          <DaysWidget request={report} report={cash.data} />
          <MethodsWidget request={report} report={cash.data} />
          <ExportPanel
            kinds={['payments']}
            query={query}
            filtersText={appliedParts(query, options.data, t).join(' · ')}
          />
        </>
      )}
    </div>
  );
}
