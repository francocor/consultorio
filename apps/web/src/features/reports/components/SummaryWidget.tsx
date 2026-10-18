import type { OperationalReportResponse } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { formatDuration, formatRate } from '../domain/report-format.js';

import { ReportWidget, type WidgetRequest } from './ReportWidget.js';

interface Tile {
  id: string;
  label: string;
  value: string;
  detail: string;
  hint?: string;
}

/** The numbers of the period, one tile each, each with the words that say how it was worked out. */
function tilesOf(
  report: OperationalReportResponse,
  t: (key: string, options?: Record<string, unknown>) => string,
): Tile[] {
  const { noShow, occupancy, sources, confirmations } = report;
  return [
    {
      id: 'appointments',
      label: t('kpi.appointments'),
      value: formatNumber(report.totalAppointments),
      detail: '',
    },
    {
      id: 'no-show',
      label: t('kpi.noShowRate'),
      value: formatRate(noShow.rateBp),
      detail:
        noShow.rateBp === null
          ? t('kpi.noShowRateNone')
          : t('kpi.noShowRateDetail', {
              noShow: formatNumber(noShow.noShow),
              total: formatNumber(noShow.attended + noShow.noShow),
            }),
      hint: t('kpi.noShowRateHint'),
    },
    {
      id: 'occupancy',
      label: t('kpi.occupancy'),
      value: formatRate(occupancy.rateBp),
      detail:
        occupancy.rateBp === null
          ? t('kpi.occupancyNone')
          : t('kpi.occupancyDetail', {
              booked: formatDuration(occupancy.bookedMinutes),
              available: formatDuration(occupancy.availableMinutes),
            }),
    },
    {
      id: 'online',
      label: t('kpi.online'),
      value: formatRate(sources.onlineShareBp),
      detail: t('kpi.onlineDetail', {
        online: formatNumber(sources.online),
        total: formatNumber(report.totalAppointments),
      }),
    },
    {
      id: 'recovered',
      label: t('kpi.recovered'),
      value: formatNumber(report.waitlist.recoveredSlots),
      detail: t('kpi.recoveredDetail'),
    },
    {
      id: 'rescheduled',
      label: t('kpi.rescheduled'),
      value: formatNumber(report.rescheduled),
      detail: t('kpi.rescheduledDetail'),
    },
    {
      id: 'new-patients',
      label: t('kpi.newPatients'),
      value: formatNumber(report.patients.new),
      detail: t('kpi.patientsDetail'),
    },
    {
      id: 'returning-patients',
      label: t('kpi.returningPatients'),
      value: formatNumber(report.patients.returning),
      detail: t('kpi.patientsDetail'),
    },
    {
      id: 'confirmed',
      label: t('kpi.confirmed'),
      value: formatNumber(confirmations.confirmedByPatient),
      detail:
        confirmations.rateBp === null
          ? t('kpi.confirmedNone')
          : t('kpi.confirmedDetail', { rate: formatRate(confirmations.rateBp) }),
    },
  ];
}

export function SummaryWidget({
  request,
  report,
}: {
  request: WidgetRequest;
  report: OperationalReportResponse | undefined;
}) {
  const { t } = useTranslation('reports');
  const tiles = report ? tilesOf(report, t) : [];
  return (
    <ReportWidget
      title={t('summary.title')}
      description={t('summary.description')}
      request={request}
      empty={report?.totalAppointments === 0}
    >
      {report ? (
        <div className="grid gap-4">
          <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
            {tiles.map((tile) => (
              <div key={tile.id} className="grid min-w-0 content-start gap-1 rounded-lg border p-3">
                <dt className="text-sm font-medium text-muted-foreground">{tile.label}</dt>
                <dd className="grid gap-1">
                  <span className="tabular font-display text-2xl font-semibold">{tile.value}</span>
                  {tile.detail ? (
                    <span className="text-xs text-muted-foreground">{tile.detail}</span>
                  ) : null}
                  {tile.hint ? (
                    <span className="text-xs text-muted-foreground">{tile.hint}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          <Alert tone="info">
            <AlertDescription>
              <p>
                {t('excluded.notice', {
                  cancelled: formatNumber(report.noShow.excluded.cancelled),
                  notFinal: formatNumber(report.noShow.excluded.notFinal),
                })}
              </p>
              {report.noShow.excluded.notFinalPast > 0 ? (
                <p>{t('excluded.past', { count: report.noShow.excluded.notFinalPast })}</p>
              ) : null}
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
    </ReportWidget>
  );
}
