import { money, type PortalLinkDto } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatCalendarDay, formatMoney } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { portalApi, portalKeys } from '../api/portal-api.js';
import { DownloadButton } from '../components/DownloadButton.js';
import { QueryState } from '../components/QueryState.js';

const pad = (value: number, length: number) => String(value).padStart(length, '0');

/** The invoices and receipts addressed to the patient. What a payer owes is not here. */
export function InvoicesSection({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const query = useQuery({
    queryKey: portalKeys.section(link.id, 'invoices'),
    queryFn: () => api.invoices(),
  });
  return (
    <section>
      <PageHeader title={t('invoices.title')} description={t('invoices.description')} />
      <QueryState
        query={query}
        isEmpty={(data) => data.invoices.length === 0}
        empty={
          <EmptyState
            icon={Receipt}
            title={t('invoices.empty.title')}
            description={t('invoices.empty.description')}
          />
        }
      >
        {(data) => (
          <ul className="grid gap-3">
            {data.invoices.map((invoice) => {
              const name = t(`invoices.kind.${invoice.kind}`);
              const number =
                invoice.number === null
                  ? ''
                  : `${pad(invoice.pointOfSale, 4)}-${pad(invoice.number, 8)}`;
              return (
                <li
                  key={invoice.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <p className="font-medium">
                      {name} <span className="tabular">{number}</span>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {formatCalendarDay(invoice.issueDate)}
                      {' · '}
                      <span className="tabular">{formatMoney(money(invoice.totalCents))}</span>
                    </p>
                    {invoice.testDocument ? (
                      <Badge tone="warning" className="mt-1 justify-self-start">
                        {t('invoices.testDocument')}
                      </Badge>
                    ) : null}
                  </div>
                  {invoice.hasPdf ? (
                    <DownloadButton
                      kind="invoices"
                      id={invoice.id}
                      fileName={`${name}-${number}.pdf`}
                      label={t('invoices.downloadLabel', { name: `${name} ${number}` })}
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">{t('invoices.preparing')}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
