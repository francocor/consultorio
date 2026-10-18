import type { FinancialReportResponse, FinancialRow, Money } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { formatMoney } from '../../../shared/lib/format.js';
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

import { sumRows } from './domain/money-series.js';
import { EmptyMoney, isEmptyMoney } from './MoneySummaryWidget.js';

function BreakdownTable({
  label,
  rows,
  nameOf,
}: {
  label: string;
  rows: readonly FinancialRow[];
  nameOf: (row: FinancialRow) => string;
}) {
  const { t } = useTranslation('reports');
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('money.breakdown.empty')}</p>;
  }
  const total = sumRows(rows);
  const invoiced = (cents: Money | null) =>
    cents === null ? t('money.breakdown.noInvoiced') : formatMoney(cents);
  return (
    <TableContainer aria-label={t('table.label', { title: label })}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('money.breakdown.column.name')}</TableHead>
            <TableHead className="text-right">{t('money.breakdown.column.charged')}</TableHead>
            <TableHead className="text-right">{t('money.breakdown.column.voided')}</TableHead>
            <TableHead className="text-right">{t('money.breakdown.column.collected')}</TableHead>
            <TableHead className="text-right">{t('money.breakdown.column.outstanding')}</TableHead>
            <TableHead className="text-right">{t('money.breakdown.column.receivable')}</TableHead>
            <TableHead className="text-right">{t('money.breakdown.column.invoiced')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="font-medium">{nameOf(row)}</TableCell>
              <TableCell className="tabular text-right">{formatMoney(row.chargedCents)}</TableCell>
              <TableCell className="tabular text-right">{formatMoney(row.voidedCents)}</TableCell>
              <TableCell className="tabular text-right">
                {formatMoney(row.collectedCents)}
              </TableCell>
              <TableCell className="tabular text-right">
                {formatMoney(row.outstandingCents)}
              </TableCell>
              <TableCell className="tabular text-right">
                {formatMoney(row.receivableCents)}
              </TableCell>
              <TableCell className="tabular text-right">{invoiced(row.invoicedNetCents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <tfoot>
          <TableRow>
            <TableCell className="font-medium">{t('money.breakdown.total')}</TableCell>
            <TableCell className="tabular text-right">{formatMoney(total.chargedCents)}</TableCell>
            <TableCell className="tabular text-right">{formatMoney(total.voidedCents)}</TableCell>
            <TableCell className="tabular text-right">
              {formatMoney(total.collectedCents)}
            </TableCell>
            <TableCell className="tabular text-right">
              {formatMoney(total.outstandingCents)}
            </TableCell>
            <TableCell className="tabular text-right">
              {formatMoney(total.receivableCents)}
            </TableCell>
            <TableCell className="tabular text-right">{invoiced(total.invoicedNetCents)}</TableCell>
          </TableRow>
        </tfoot>
      </Table>
    </TableContainer>
  );
}

/** The same money cut by place, by professional (when the viewer may), by payer and by type of appointment. */
export function MoneyBreakdownWidget({
  request,
  report,
}: {
  request: WidgetRequest;
  report: FinancialReportResponse | undefined;
}) {
  const { t } = useTranslation('reports');
  const unnamed = t('money.breakdown.unnamed');
  const groups = [
    {
      id: 'location',
      label: t('money.breakdown.location'),
      rows: report?.byLocation ?? [],
      nameOf: (row: FinancialRow) => row.label ?? unnamed,
    },
    ...(report?.byProfessional === null
      ? []
      : [
          {
            id: 'professional',
            label: t('money.breakdown.professional'),
            rows: report?.byProfessional ?? [],
            nameOf: (row: FinancialRow) => row.label ?? unnamed,
          },
        ]),
    {
      id: 'payer',
      label: t('money.breakdown.payer'),
      rows: report?.byPayer ?? [],
      nameOf: (row: FinancialRow) =>
        row.key === 'private' ? t('money.breakdown.private') : (row.label ?? unnamed),
    },
    {
      id: 'type',
      label: t('money.breakdown.type'),
      rows: report?.byType ?? [],
      nameOf: (row: FinancialRow) => row.key || unnamed,
    },
  ];
  return (
    <ReportWidget
      title={t('money.breakdown.title')}
      description={t('money.breakdown.description')}
      request={request}
      empty={isEmptyMoney(report)}
      emptyState={<EmptyMoney />}
    >
      <div className="grid gap-3">
        {report?.byProfessional === null ? (
          <p className="text-sm text-muted-foreground">{t('money.breakdown.professionalDenied')}</p>
        ) : null}
        <Tabs defaultValue="location">
          <TabsList aria-label={t('money.breakdown.title')}>
            {groups.map((group) => (
              <TabsTrigger key={group.id} value={group.id}>
                {group.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {groups.map((group) => (
            <TabsContent key={group.id} value={group.id}>
              <BreakdownTable label={group.label} rows={group.rows} nameOf={group.nameOf} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </ReportWidget>
  );
}
