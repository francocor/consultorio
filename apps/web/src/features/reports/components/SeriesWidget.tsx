import type { OperationalReportResponse } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { formatCalendarDay, formatDayShort, formatNumber } from '../../../shared/lib/format.js';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';
import { groupDays, type SeriesRow } from '../domain/period.js';

import { ChartWithTable, LazySeriesChart } from './ChartWithTable.js';
import { ReportWidget, type WidgetRequest } from './ReportWidget.js';

const MONTH = new Intl.DateTimeFormat('es-AR', {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
});

/** The name of a row: `17 oct` for a day, `oct 26` for a month. */
function nameOf(row: SeriesRow, unit: 'day' | 'month'): string {
  return unit === 'day'
    ? formatDayShort(row.key)
    : MONTH.format(new Date(`${row.key}-01T00:00:00Z`)).replace('.', '');
}

/** The full name, for the table: the day with its year, or the month as written. */
function longNameOf(row: SeriesRow, unit: 'day' | 'month'): string {
  return unit === 'day' ? formatCalendarDay(row.key) : nameOf(row, unit);
}

/** Appointments per day (or per month for a long period), as a chart and as a table. */
export function SeriesWidget({
  request,
  report,
}: {
  request: WidgetRequest;
  report: OperationalReportResponse | undefined;
}) {
  const { t } = useTranslation('reports');
  const series = groupDays(report?.byDay ?? []);
  const title = t(series.unit === 'day' ? 'series.day.title' : 'series.month.title');
  const labels = {
    attended: t('series.attended'),
    noShow: t('series.noShow'),
    cancelled: t('series.cancelled'),
  };
  return (
    <ReportWidget
      title={title}
      description={t('series.description')}
      request={request}
      empty={report?.totalAppointments === 0}
    >
      <ChartWithTable
        title={title}
        chart={
          <LazySeriesChart
            data={series.rows.map((row) => ({
              label: nameOf(row, series.unit),
              attended: row.attended,
              noShow: row.noShow,
              cancelled: row.cancelled,
            }))}
            label={t('series.chartLabel')}
            labels={labels}
          />
        }
        table={
          <TableContainer aria-label={t('table.label', { title })}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('series.column.period')}</TableHead>
                  <TableHead className="text-right">{t('series.column.total')}</TableHead>
                  <TableHead className="text-right">{labels.attended}</TableHead>
                  <TableHead className="text-right">{labels.noShow}</TableHead>
                  <TableHead className="text-right">{labels.cancelled}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {series.rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>{longNameOf(row, series.unit)}</TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.total)}</TableCell>
                    <TableCell className="tabular text-right">
                      {formatNumber(row.attended)}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.noShow)}</TableCell>
                    <TableCell className="tabular text-right">
                      {formatNumber(row.cancelled)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        }
      />
    </ReportWidget>
  );
}
