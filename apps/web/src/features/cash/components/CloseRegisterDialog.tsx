import { money, type CashSessionDto, type Money } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatMoney } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Textarea } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { MoneyInput } from '../../../shared/ui/money-input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingApi, billingKeys, ErrorAlert } from '../../billing/index.js';
import { closingDraft } from '../domain/closing.js';

/**
 * Closes the register with the cash that was counted. The expected cash is the opening cash plus
 * the cash taken minus the cash given back; a difference, short or over, needs a reason, and the
 * closed register never changes again.
 */
export function CloseRegisterDialog({
  session,
  onClose,
}: {
  session: CashSessionDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['cash', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [counted, setCounted] = useState<Money | null>(null);
  const [reason, setReason] = useState('');
  const draft = closingDraft({ expected: session.expectedCents, counted, reason });

  const close = useMutation({
    mutationFn: () => {
      if (counted === null) throw new Error('the count is missing');
      return billingApi(api).closeCash(session.id, {
        countedCents: counted,
        ...(draft.needsReason ? { differenceReason: reason.trim() } : {}),
      });
    },
    onSuccess: async () => {
      toast.success(t('cash:close.done'));
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('cash:close.title')}</DialogTitle>
          <DialogDescription>{t('cash:close.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!close.isPending && draft.canSubmit) close.mutate();
          }}
        >
          <p className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">{t('cash:close.expected')}</span>
            <span className="tabular-nums text-base font-semibold">
              {formatMoney(session.expectedCents)}
            </span>
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="close-counted">{t('cash:close.counted')}</Label>
            <MoneyInput id="close-counted" value={counted} onValueChange={setCounted} />
          </div>
          {counted !== null ? (
            <Alert tone={draft.kind === 'exact' ? 'success' : 'warning'}>
              <AlertDescription>
                {draft.kind === 'exact'
                  ? t('cash:close.exact')
                  : t(`cash:close.${draft.kind}`, {
                      amount: formatMoney(money(Math.abs(draft.difference))),
                    })}
              </AlertDescription>
            </Alert>
          ) : null}
          {draft.needsReason ? (
            <div className="grid gap-1.5">
              <Label htmlFor="close-reason">{t('cash:close.reason')}</Label>
              <Textarea
                id="close-reason"
                value={reason}
                maxLength={200}
                rows={3}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </div>
          ) : null}
          <ErrorAlert error={close.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={close.isPending} disabled={!draft.canSubmit}>
              {t('cash:close.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
