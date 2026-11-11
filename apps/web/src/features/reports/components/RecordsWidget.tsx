import { REPORT_GROUPS, type ReportGroup } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatCalendarDay, formatNumber } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
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

import { ReportWidget } from './ReportWidget.js';

export const RECORDS_PAGE_SIZE = 20;

/** The appointments behind a number: who, when, with whom and in what state. */
export function RecordsWidget({
  query,
  group,
  offset,
  onGroupChange,
  onOffsetChange,
}: {
  query: ReportQuery;
  group: ReportGroup;
  offset: number;
  onGroupChange: (group: ReportGroup) => void;
  onOffsetChange: (offset: number) => void;
}) {
  const { t } = useTranslation(['reports', 'scheduling']);
  const api = useApi();
  const selectId = useId();
  const records = useQuery({
    queryKey: reportKeys.records(query, group, offset),
    queryFn: () => reportsApi(api).records(query, group, RECORDS_PAGE_SIZE, offset),
  });
  const data = records.data;
  const label = (value: ReportGroup) =>
    value === 'all' || value === 'rescheduled' || value === 'online' || value === 'recovered'
      ? t(`reports:records.group.${value}`)
      : t(`scheduling:status.${value}`);
  const title = t('reports:records.title');

  return (
    <ReportWidget
      title={title}
      description={t('reports:records.description')}
      request={records}
      empty={data?.total === 0 && group === 'all'}
      actions={
        <div className="grid gap-1.5">
          <Label htmlFor={selectId}>{t('reports:records.group')}</Label>
          <Select
            id={selectId}
            value={group}
            className="w-full sm:w-64"
            onChange={(event) => {
              onGroupChange(event.target.value as ReportGroup);
            }}
          >
            {REPORT_GROUPS.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {data && data.total === 0 ? (
        <EmptyState
          className="py-8"
          title={t('reports:records.empty.title')}
          description={t('reports:records.empty.description')}
        />
      ) : null}
      {data && data.total > 0 ? (
        <div className="grid grid-cols-1 gap-3">
          <TableContainer aria-label={t('reports:table.label', { title })}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('reports:records.column.when')}</TableHead>
                  <TableHead>{t('reports:records.column.patient')}</TableHead>
                  <TableHead>{t('reports:records.column.professional')}</TableHead>
                  <TableHead>{t('reports:records.column.location')}</TableHead>
                  <TableHead>{t('reports:records.column.type')}</TableHead>
                  <TableHead>{t('reports:records.column.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.records.map((record) => (
                  <TableRow key={record.appointmentId}>
                    <TableCell className="tabular whitespace-nowrap">
                      {formatCalendarDay(record.localDate)} {record.localTime}
                    </TableCell>
                    <TableCell className="font-medium">{record.patientName}</TableCell>
                    <TableCell>{record.professionalName ?? '–'}</TableCell>
                    <TableCell>{record.locationName}</TableCell>
                    <TableCell>{record.appointmentTypeName}</TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1">
                        <span>{t(`scheduling:status.${record.status}`)}</span>
                        {record.rescheduled ? (
                          <Badge tone="info">{t('reports:records.rescheduled')}</Badge>
                        ) : null}
                        {record.source === 'staff' ? null : (
                          <Badge>{t(`reports:source.${record.source}`)}</Badge>
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t('reports:records.range', {
                from: formatNumber(offset + 1),
                to: formatNumber(offset + data.records.length),
                total: formatNumber(data.total),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={offset === 0}
                onClick={() => {
                  onOffsetChange(Math.max(0, offset - RECORDS_PAGE_SIZE));
                }}
              >
                {t('reports:records.previous')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={offset + data.records.length >= data.total}
                onClick={() => {
                  onOffsetChange(offset + RECORDS_PAGE_SIZE);
                }}
              >
                {t('reports:records.next')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ReportWidget>
  );
}
