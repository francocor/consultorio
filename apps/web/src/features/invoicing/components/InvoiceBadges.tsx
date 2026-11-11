import type { FiscalEnvironment, InvoiceDto } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../../shared/ui/badge.js';
import { StatusBadge, type Status } from '../../../shared/ui/states/status-badge.js';

const STATUS_OF: Record<InvoiceDto['status'], Status> = {
  pending: 'pending',
  issued: 'ok',
  rejected: 'error',
  manual: 'verified',
};

/**
 * The state of an invoice: one of four, as an icon and a word. The retry progress of a pending
 * invoice is never shown; past the threshold a flag says it has waited too long.
 */
export function InvoiceStateBadge({
  invoice,
}: {
  invoice: Pick<InvoiceDto, 'status' | 'outageFlag'>;
}) {
  const { t } = useTranslation('invoicing');
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge status={STATUS_OF[invoice.status]}>{t(`status.${invoice.status}`)}</StatusBadge>
      {invoice.outageFlag ? <Badge tone="danger">{t('outage.badge')}</Badge> : null}
    </span>
  );
}

/**
 * The environment of the voucher, explicit on every invoice screen (e-invoicing-afip, "Fiscal
 * configuration per organization"): a test document says so in words next to it, because nobody
 * should be able to present it as a valid fiscal document.
 */
export function EnvironmentBadge({
  environment,
  testDocument,
}: {
  environment: FiscalEnvironment;
  testDocument: boolean;
}) {
  const { t } = useTranslation('invoicing');
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={environment === 'production' ? 'neutral' : 'warning'}>
        {t(`env.${environment}`)}
      </Badge>
      {testDocument ? <Badge tone="warning">{t('test.mark')}</Badge> : null}
    </span>
  );
}
