import type { CashEntryDto } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { hasAnyPermission, useMe } from '../../../app/session.js';
import { formatMoney, formatTime } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import { billingApi, CorrectPaymentDialog } from '../../billing/index.js';

/** Loads the payment behind an entry and offers the correction dialog for it. */
function CorrectEntry({ entry, onClose }: { entry: CashEntryDto; onClose: () => void }) {
  const api = useApi();
  const charge = useQuery({
    queryKey: ['billing', 'charge', entry.chargeId],
    queryFn: () => billingApi(api).charge(entry.chargeId),
  });
  const payment = charge.data?.payments.find((candidate) => candidate.id === entry.paymentId);
  if (!payment) return null;
  return <CorrectPaymentDialog payment={payment} onClose={onClose} />;
}

/**
 * The entries of a register, in order: payments taken and money given back, with the patient, the
 * method and the amount. A payment can be corrected from here (reversal plus a new entry in the open
 * register), also when its own register is closed.
 */
export function EntriesList({
  entries,
  canCorrect,
}: {
  entries: readonly CashEntryDto[];
  canCorrect: boolean;
}) {
  const { t } = useTranslation('cash');
  const me = useMe();
  const [correcting, setCorrecting] = useState<CashEntryDto | null>(null);
  const mayCorrect = canCorrect && hasAnyPermission(me.permissions, ['payments.refund']);

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('entries.empty')}</p>;
  }
  return (
    <>
      <ul aria-label={t('entries.caption')} className="grid gap-1 rounded-md border bg-card">
        {entries.map((entry) => (
          <li
            key={`${entry.kind}-${entry.id}`}
            className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-b-0"
          >
            <span className="min-w-0">
              <span className="block truncate">
                {t(`entries.kind.${entry.kind}`)} · {entry.patientName}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatTime(entry.at)} · {t(`method.${entry.method}`)}
                {entry.reason ? ` · ${entry.reason}` : ''}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums font-medium">
                {entry.kind === 'payment' ? '' : '-'}
                {formatMoney(entry.amountCents)}
              </span>
              {mayCorrect && entry.kind === 'payment' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCorrecting(entry);
                  }}
                >
                  {t('entries.correct', { patient: entry.patientName })}
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {correcting ? (
        <CorrectEntry
          entry={correcting}
          onClose={() => {
            setCorrecting(null);
          }}
        />
      ) : null}
    </>
  );
}
