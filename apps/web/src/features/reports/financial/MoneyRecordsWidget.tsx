import {
  FINANCIAL_RECORD_KINDS,
  type FinancialRecordDto,
  type FinancialRecordKind,
} from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatCalendarDay, formatMoney, formatNumber } from '../../../shared/lib/format.js';
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
import { ReportWidget } from '../components/ReportWidget.js';

export const MONEY_RECORDS_PAGE_SIZE = 20;

/** The state of a record in words: the charge state, the movement and its method, or the voucher. */
function statusText(
  record: FinancialRecordDto,
  kind: FinancialRecordKind,
  t: (key: string) => string,
): string {
  if (kind === 'invoiced') return t(`money.records.voucher.${record.status}`);
  if (kind === 'collected') {
    const movement = t(`money.records.status.${record.status}`);
    return record.method ? `${movement} · ${t(`money.records.method.${record.method}`)}` : movement;
  }
  return t(`money.records.status.${record.status}`);
}

/** The charges, payments and vouchers behind a figure, with the sum of the whole list. */
export function MoneyRecordsWidget({
  query,
  kind,
  offset,
  showProfessional,
  onKindChange,
  onOffsetChange,
}: {
  query: ReportQuery;
  kind: FinancialRecordKind;
  offset: number;
  /** False for reception, which reads no revenue by professional. */
  showProfessional: boolean;
  onKindChange: (kind: FinancialRecordKind) => void;
  onOffsetChange: (offset: number) => void;
}) {
  const { t } = useTranslation('reports');
  const api = useApi();
  const selectId = useId();
  const records = useQuery({
    queryKey: reportKeys.financialRecords(query, kind, offset),
    queryFn: () => reportsApi(api).financialRecords(query, kind, MONEY_RECORDS_PAGE_SIZE, offset),
  });
  const data = records.data;
  const title = t('money.records.title');

  return (
    <ReportWidget
      title={title}
      description={t('money.records.description')}
      request={records}
      empty={false}
      actions={
        <div className="grid gap-1.5">
          <Label htmlFor={selectId}>{t('money.records.kind')}</Label>
          <Select
            id={selectId}
            value={kind}
            className="w-full sm:w-72"
            onChange={(event) => {
              onKindChange(event.target.value as FinancialRecordKind);
            }}
          >
            {FINANCIAL_RECORD_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`money.records.kind.${value}`)}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {data && data.total === 0 ? (
        <EmptyState
          className="py-8"
          title={t('money.records.empty.title')}
          description={t('money.records.empty.description')}
        />
      ) : null}
      {data && data.total > 0 ? (
        <div className="grid grid-cols-1 gap-3">
          <TableContainer aria-label={t('table.label', { title })}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('money.records.column.date')}</TableHead>
                  <TableHead>{t('money.records.column.patient')}</TableHead>
                  {showProfessional ? (
                    <TableHead>{t('money.records.column.professional')}</TableHead>
                  ) : null}
                  <TableHead>{t('money.records.column.location')}</TableHead>
                  <TableHead>{t('money.records.column.payer')}</TableHead>
                  <TableHead>{t('money.records.column.status')}</TableHead>
                  <TableHead className="text-right">{t('money.records.column.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.records.map((record, index) => (
                  <TableRow key={`${record.id}-${String(offset + index)}`}>
                    <TableCell className="tabular whitespace-nowrap">
                      {formatCalendarDay(record.date)}
                    </TableCell>
                    <TableCell className="font-medium">{record.patientName ?? '–'}</TableCell>
                    {showProfessional ? (
                      <TableCell>{record.professionalName ?? '–'}</TableCell>
                    ) : null}
                    <TableCell>{record.locationName}</TableCell>
                    <TableCell>{record.payerName ?? t('money.records.privateOnly')}</TableCell>
                    <TableCell>{statusText(record, kind, t)}</TableCell>
                    <TableCell className="tabular whitespace-nowrap text-right">
                      {formatMoney(record.amountCents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <p className="tabular text-sm font-medium" aria-live="polite">
            {t('money.records.sum', {
              count: formatNumber(data.total),
              sum: formatMoney(data.sumCents),
            })}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t('money.records.range', {
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
                  onOffsetChange(Math.max(0, offset - MONEY_RECORDS_PAGE_SIZE));
                }}
              >
                {t('records.previous')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={offset + data.records.length >= data.total}
                onClick={() => {
                  onOffsetChange(offset + MONEY_RECORDS_PAGE_SIZE);
                }}
              >
                {t('records.next')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ReportWidget>
  );
}
