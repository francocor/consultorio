import { type Money, type StatementDto } from '@consultorio/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { formatDate, formatMoney, formatMonthYear } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button, WRAPPING_LABEL } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { subscriptionApi, subscriptionKeys } from '../api/subscription-api.js';
import { goToProviderPage } from '../domain/provider-page.js';

import { ErrorNotice } from './ErrorNotice.js';

const money = (cents: number) => formatMoney(cents as Money);

/** What a statement bills, line by line: the days of each professional and the overage. */
function StatementLines({ statement }: { statement: StatementDto }) {
  const { t } = useTranslation('subscription');
  return (
    <div className="grid min-w-0 gap-2 text-sm">
      <ul className="grid min-w-0 gap-1">
        {statement.lines.map((line) => (
          <li
            key={`${line.kind}-${line.professionalId}`}
            className="flex min-w-0 flex-wrap justify-between gap-x-4"
          >
            <span className="min-w-0 break-words">
              {line.kind === 'professional'
                ? t('statements.line.professional', {
                    name: line.name ?? t('usage.unnamed'),
                    days: line.days,
                    daysInPeriod: line.daysInPeriod,
                  })
                : t('statements.line.overage', {
                    name: line.name ?? t('usage.unnamed'),
                    units: line.units,
                    used: line.used,
                    quota: line.quota,
                    price: money(line.unitPriceCents),
                  })}
            </span>
            <span className="tabular">{money(line.amountCents)}</span>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap justify-between gap-x-4 border-t pt-2">
        <span>{t('statements.base')}</span>
        <span className="tabular">{money(statement.baseCents)}</span>
      </p>
      <p className="flex flex-wrap justify-between gap-x-4">
        <span>{t('statements.overage')}</span>
        <span className="tabular">{money(statement.overageCents)}</span>
      </p>
    </div>
  );
}

function StatementItem({ statement }: { statement: StatementDto }) {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const [open, setOpen] = useState(false);
  const period = formatMonthYear(`${statement.period}-01`);
  const paid = statement.collectedCents >= statement.totalCents;
  const download = useMutation({
    mutationFn: () => subscriptionApi(api).downloadStatement(statement.id),
    onSuccess: ({ blob, filename }) => {
      downloadBlob(blob, filename ?? `resumen-${statement.period}.pdf`);
    },
  });

  return (
    <li className="grid min-w-0 gap-3 rounded-lg border p-4">
      <article aria-labelledby={`statement-${statement.id}`} className="grid min-w-0 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`statement-${statement.id}`} className="font-medium">
            {t('statements.period', { period })}
          </h3>
          <Badge tone={paid ? 'success' : 'warning'}>
            {paid ? t('statements.paid') : t('statements.pending')}
          </Badge>
        </div>
        <p className="text-sm">
          <span className="tabular font-medium">
            {t('statements.total', { amount: money(statement.totalCents) })}
          </span>
          {' · '}
          {t('statements.professionals', { count: statement.professionalsCounted })}
        </p>
        <p className="text-sm text-muted-foreground">
          {t('statements.published', { date: formatDate(statement.publishedAt) })}
          {' · '}
          {t('statements.collectAfter', { date: formatDate(statement.collectAfter) })}
          {statement.collectedCents > 0 && !paid
            ? ` · ${t('statements.collected', {
                amount: money(statement.collectedCents),
                total: money(statement.totalCents),
              })}`
            : ''}
        </p>

        {statement.paymentUrl !== null ? (
          <Alert tone="warning">
            <AlertDescription>
              <p>{t('statements.payDifferenceHelp')}</p>
              <p className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  className={WRAPPING_LABEL}
                  onClick={() => {
                    goToProviderPage(statement.paymentUrl ?? '');
                  }}
                >
                  {t('statements.payDifference')}
                </Button>
              </p>
            </AlertDescription>
          </Alert>
        ) : null}
        {statement.reauthorizationUrl !== null ? (
          <Alert tone="warning">
            <AlertDescription>
              <p>{t('statements.reauthorizeHelp')}</p>
              <p className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  className={WRAPPING_LABEL}
                  onClick={() => {
                    goToProviderPage(statement.reauthorizationUrl ?? '');
                  }}
                >
                  {t('statements.reauthorize')}
                </Button>
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {open ? <StatementLines statement={statement} /> : null}
        <ErrorNotice error={download.error} />

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={open}
            onClick={() => {
              setOpen((current) => !current);
            }}
          >
            {open ? t('statements.hideDetails') : t('statements.details')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={WRAPPING_LABEL}
            loading={download.isPending}
            aria-label={t('statements.downloadLabel', { period })}
            onClick={() => {
              download.mutate();
            }}
          >
            {t('statements.download')}
          </Button>
        </div>
      </article>
    </li>
  );
}

/** The statements of the organization, the newest first, each one viewable and downloadable. */
export function StatementsCard() {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const statements = useQuery({
    queryKey: subscriptionKeys.statements,
    queryFn: () => subscriptionApi(api).statements(),
  });

  return (
    <Card aria-labelledby="statements-title" className="min-w-0">
      <CardHeader>
        <CardTitle id="statements-title">{t('statements.title')}</CardTitle>
        <CardDescription>{t('statements.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-3">
        {statements.isPending ? <ListSkeleton rows={2} /> : null}
        {statements.isError ? (
          <ErrorState
            error={statements.error}
            onRetry={() => {
              void statements.refetch();
            }}
          />
        ) : null}
        {statements.isSuccess && statements.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('statements.none')}</p>
        ) : null}
        {statements.isSuccess && statements.data.length > 0 ? (
          <ul className="grid min-w-0 gap-3">
            {statements.data.map((statement) => (
              <StatementItem key={statement.id} statement={statement} />
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
