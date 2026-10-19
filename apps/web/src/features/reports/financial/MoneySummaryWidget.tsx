import type { FinancialRecordKind, FinancialReportResponse } from '@consultorio/contracts';
import { Link } from '@tanstack/react-router';
import { Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatMoney, formatNumber } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { buttonVariants, Button } from '../../../shared/ui/button.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ReportWidget, type WidgetRequest } from '../components/ReportWidget.js';

/** True when the period has no charge, payment, refund or voucher at all. */
export function isEmptyMoney(report: FinancialReportResponse | undefined): boolean {
  if (!report) return false;
  const { charged, voided, collected, invoiced } = report.totals;
  return (
    charged.count === 0 &&
    voided.count === 0 &&
    collected.paymentCount === 0 &&
    collected.refundCount === 0 &&
    invoiced.documents === 0
  );
}

export function EmptyMoney() {
  const { t } = useTranslation('reports');
  return (
    <EmptyState
      className="py-8"
      icon={Receipt}
      title={t('money.empty.title')}
      description={t('money.empty.description')}
      action={
        <Link to="/charges" className={buttonVariants({ variant: 'outline' })}>
          {t('money.empty.action')}
        </Link>
      }
    />
  );
}

interface Tile {
  id: FinancialRecordKind;
  label: string;
  value: string;
  detail: string;
}

function tilesOf(
  report: FinancialReportResponse,
  t: (key: string, options?: Record<string, unknown>) => string,
): Tile[] {
  const { charged, voided, collected, outstanding, receivable, invoiced } = report.totals;
  return [
    {
      id: 'charged',
      label: t('money.kpi.charged'),
      value: formatMoney(charged.totalCents),
      detail: t('money.kpi.chargedDetail', {
        count: formatNumber(charged.count),
        patient: formatMoney(charged.patientCents),
        payer: formatMoney(charged.payerCents),
      }),
    },
    {
      id: 'voided',
      label: t('money.kpi.voided'),
      value: formatMoney(voided.totalCents),
      detail: t('money.kpi.voidedDetail', { count: formatNumber(voided.count) }),
    },
    {
      id: 'collected',
      label: t('money.kpi.collected'),
      value: formatMoney(collected.netCents),
      detail: t('money.kpi.collectedDetail', {
        payments: formatMoney(collected.paymentsCents),
        refunds: formatMoney(collected.refundsCents),
      }),
    },
    {
      id: 'outstanding',
      label: t('money.kpi.outstanding'),
      value: formatMoney(outstanding.cents),
      detail: t('money.kpi.outstandingDetail', { count: formatNumber(outstanding.chargeCount) }),
    },
    {
      id: 'receivable',
      label: t('money.kpi.receivable'),
      value: formatMoney(receivable.cents),
      detail: t('money.kpi.receivableDetail'),
    },
    {
      id: 'invoiced',
      label: t('money.kpi.invoiced'),
      value: formatMoney(invoiced.netCents),
      detail: t('money.kpi.invoicedDetail', {
        invoiced: formatMoney(invoiced.invoicedCents),
        credited: formatMoney(invoiced.creditedCents),
        documents: formatNumber(invoiced.documents),
      }),
    },
  ];
}

/** The money of the period, one tile each, each opening into the records that compose it. */
export function MoneySummaryWidget({
  request,
  report,
  onOpen,
}: {
  request: WidgetRequest;
  report: FinancialReportResponse | undefined;
  onOpen: (kind: FinancialRecordKind) => void;
}) {
  const { t } = useTranslation('reports');
  const tiles = report ? tilesOf(report, t) : [];
  return (
    <ReportWidget
      title={t('money.summary.title')}
      description={t('money.summary.description')}
      request={request}
      empty={isEmptyMoney(report)}
      emptyState={<EmptyMoney />}
    >
      <div className="grid grid-cols-1 gap-4">
        <dl className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.id} className="grid min-w-0 content-start gap-1 rounded-lg border p-3">
              <dt className="text-sm font-medium text-muted-foreground">{tile.label}</dt>
              <dd className="grid gap-1">
                <span className="tabular font-display text-2xl font-semibold">{tile.value}</span>
                <span className="text-xs text-muted-foreground">{tile.detail}</span>
                <span>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0"
                    aria-label={t('money.kpi.seeRecords', { name: tile.label })}
                    onClick={() => {
                      onOpen(tile.id);
                    }}
                  >
                    {t('money.kpi.open')}
                  </Button>
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <Alert tone="info">
          <AlertDescription>{t('money.basis')}</AlertDescription>
        </Alert>
      </div>
    </ReportWidget>
  );
}
