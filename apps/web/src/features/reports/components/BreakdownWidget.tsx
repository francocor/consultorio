import type { OperationalReportResponse } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../../../shared/lib/format.js';
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
import { formatRate } from '../domain/report-format.js';

import { ReportWidget, type WidgetRequest } from './ReportWidget.js';

interface Row {
  key: string;
  name: string;
  total: number;
  attended: number;
  noShow: number;
  cancelled: number;
  noShowRateBp: number | null;
}

function BreakdownTable({ label, rows }: { label: string; rows: readonly Row[] }) {
  const { t } = useTranslation('reports');
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('breakdown.empty')}</p>;
  }
  return (
    <TableContainer aria-label={t('table.label', { title: label })}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('breakdown.column.name')}</TableHead>
            <TableHead className="text-right">{t('breakdown.column.total')}</TableHead>
            <TableHead className="text-right">{t('breakdown.column.attended')}</TableHead>
            <TableHead className="text-right">{t('breakdown.column.noShow')}</TableHead>
            <TableHead className="text-right">{t('breakdown.column.cancelled')}</TableHead>
            <TableHead className="text-right">{t('breakdown.column.rate')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="tabular text-right">{formatNumber(row.total)}</TableCell>
              <TableCell className="tabular text-right">{formatNumber(row.attended)}</TableCell>
              <TableCell className="tabular text-right">{formatNumber(row.noShow)}</TableCell>
              <TableCell className="tabular text-right">{formatNumber(row.cancelled)}</TableCell>
              <TableCell className="tabular text-right">{formatRate(row.noShowRateBp)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/** The same figures cut by place, by professional and by specialty. */
export function BreakdownWidget({
  request,
  report,
}: {
  request: WidgetRequest;
  report: OperationalReportResponse | undefined;
}) {
  const { t } = useTranslation('reports');
  const unnamed = t('breakdown.unnamed');
  const groups = [
    {
      id: 'location',
      label: t('breakdown.location'),
      rows: (report?.byLocation ?? []).map(({ locationId, name, ...rest }) => ({
        key: locationId,
        name,
        ...rest,
      })),
    },
    {
      id: 'professional',
      label: t('breakdown.professional'),
      rows: (report?.byProfessional ?? []).map(({ professionalId, name, ...rest }) => ({
        key: professionalId,
        name: name ?? unnamed,
        ...rest,
      })),
    },
    {
      id: 'specialty',
      label: t('breakdown.specialty'),
      rows: (report?.bySpecialty ?? []).map(({ specialty, ...rest }) => ({
        key: specialty,
        name: specialty,
        ...rest,
      })),
    },
  ];
  return (
    <ReportWidget
      title={t('breakdown.title')}
      description={t('breakdown.description')}
      request={request}
      empty={report?.totalAppointments === 0}
    >
      <Tabs defaultValue="location">
        <TabsList aria-label={t('breakdown.title')}>
          {groups.map((group) => (
            <TabsTrigger key={group.id} value={group.id}>
              {group.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {groups.map((group) => (
          <TabsContent key={group.id} value={group.id}>
            <BreakdownTable label={group.label} rows={group.rows} />
          </TabsContent>
        ))}
      </Tabs>
    </ReportWidget>
  );
}
