import type { FinancialReportResponse } from '@consultorio/contracts';
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { formatCalendarDay, formatDayShort, formatMoney } from '../../../shared/lib/format.js';
import { Skeleton } from '../../../shared/ui/skeleton.js';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../shared/ui/tabs.js';
import { ReportWidget, type WidgetRequest } from '../components/ReportWidget.js';

import { groupPeriods, type PeriodRow } from './domain/money-series.js';
import { EmptyMoney, isEmptyMoney } from './MoneySummaryWidget.js';

// Recharts is large: it is loaded only when somebody opens the chart, never with the entry chunk.
const MoneyChart = lazy(() => import('./charts/MoneyChart.js'));

const MONTH = new Intl.DateTimeFormat('es-AR', {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
});

/** The name of a row: `17 oct` for a day, `oct 26` for a month. */
function nameOf(row: PeriodRow, unit: 'day' | 'month'): string {
  return unit === 'day'
    ? formatDayShort(row.key)
    : MONTH.format(new Date(`${row.key}-01T00:00:00Z`)).replace('.', '');
}

/** The full name, for the table: the day with its year, or the month as written. */
function longNameOf(row: PeriodRow, unit: 'day' | 'month'): string {
  return unit === 'day' ? formatCalendarDay(row.key) : nameOf(row, unit);
}

/** Charged and collected per day (or per month for a long period), as a chart and as a table. */
export function MoneySeriesWidget({
  request,
  report,
}: {
  request: WidgetRequest;
  report: FinancialReportResponse | undefined;
}) {
  const { t } = useTranslation('reports');
  const series = groupPeriods(report?.byPeriod ?? []);
  const title = t(series.unit === 'day' ? 'money.series.title.day' : 'money.series.title.month');
  const labels = {
    charged: t('money.series.charged'),
    collected: t('money.series.collected'),
  };
  return (
    <ReportWidget
      title={title}
      description={t('money.series.description')}
      request={request}
      empty={isEmptyMoney(report)}
      emptyState={<EmptyMoney />}
    >
      <Tabs defaultValue="chart">
        <TabsList aria-label={t('view.label', { title })}>
          <TabsTrigger value="chart">{t('view.chart')}</TabsTrigger>
          <TabsTrigger value="table">{t('view.table')}</TabsTrigger>
        </TabsList>
        <TabsContent value="chart">
          <Suspense fallback={<Skeleton className="w-full" style={{ height: 260 }} />}>
            <MoneyChart
              data={series.rows.map((row) => ({
                label: nameOf(row, series.unit),
                charged: row.chargedCents / 100,
                collected: row.collectedCents / 100,
              }))}
              label={t('money.series.chartLabel')}
              labels={labels}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="table">
          <TableContainer aria-label={t('table.label', { title })}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('money.series.column.period')}</TableHead>
                  <TableHead className="text-right">{t('money.series.column.charged')}</TableHead>
                  <TableHead className="text-right">{t('money.series.column.collected')}</TableHead>
                  <TableHead className="text-right">{t('money.series.column.refunds')}</TableHead>
                  <TableHead className="text-right">
                    {t('money.series.column.outstanding')}
                  </TableHead>
                  <TableHead className="text-right">{t('money.series.column.invoiced')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {series.rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>{longNameOf(row, series.unit)}</TableCell>
                    <TableCell className="tabular text-right">
                      {formatMoney(row.chargedCents)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatMoney(row.collectedCents)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatMoney(row.refundsCents)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatMoney(row.outstandingCents)}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {row.invoicedNetCents === null ? '–' : formatMoney(row.invoicedNetCents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </TabsContent>
      </Tabs>
    </ReportWidget>
  );
}
