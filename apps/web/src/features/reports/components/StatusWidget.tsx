import { APPOINTMENT_STATUSES, type OperationalReportResponse } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';

import { ChartWithTable, LazyStatusChart } from './ChartWithTable.js';
import { ReportWidget, type WidgetRequest } from './ReportWidget.js';

export function StatusWidget({
  request,
  report,
  onShow,
}: {
  request: WidgetRequest;
  report: OperationalReportResponse | undefined;
  /** Opens the list of appointments in that status below. */
  onShow: (status: (typeof APPOINTMENT_STATUSES)[number]) => void;
}) {
  const { t } = useTranslation(['reports', 'scheduling']);
  const title = t('reports:status.title');
  const data = report
    ? APPOINTMENT_STATUSES.map((status) => ({
        status,
        label: t(`scheduling:status.${status}`),
        count: report.byStatus[status],
      }))
    : [];
  return (
    <ReportWidget
      title={title}
      description={t('reports:status.description')}
      request={request}
      empty={report?.totalAppointments === 0}
    >
      <ChartWithTable
        title={title}
        chart={<LazyStatusChart data={data} label={t('reports:status.chartLabel')} />}
        table={
          <TableContainer aria-label={t('reports:table.label', { title })}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reports:status.column.status')}</TableHead>
                  <TableHead className="text-right">{t('reports:status.column.count')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('reports:status.column.action')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row) => (
                  <TableRow key={row.status}>
                    <TableCell>{row.label}</TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.count)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="link"
                        disabled={row.count === 0}
                        aria-label={t('reports:status.showFor', { status: row.label })}
                        onClick={() => {
                          onShow(row.status);
                        }}
                      >
                        {t('reports:status.show')}
                      </Button>
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
