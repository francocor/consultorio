import type {
  CreateCreditNoteRequest,
  InvoiceDto,
  InvoiceType,
  Money,
} from '@consultorio/contracts';
import { money } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatMoney } from '../../../shared/lib/format.js';
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
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingKeys, ErrorAlert } from '../../billing/index.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';
import { creditableCents, voucherNumber } from '../domain/invoice-display.js';
import { createSubmissionKeys } from '../domain/submission-key.js';

const NOTE_OF: Record<string, InvoiceType> = { FA: 'NCA', FB: 'NCB', FC: 'NCC' };

/**
 * Cancels an invoice with a credit note (e-invoicing-afip, "Credit notes"), for the owner and the
 * administration: all that is left of the invoice or part of it, with a reason that is required. The
 * note has the letter of the invoice and its own CAE; the invoice itself is never touched. The
 * limit shown is what earlier notes left; the server keeps it whatever this form says.
 */
export function CreditNoteDialog({
  invoice,
  onClose,
}: {
  invoice: InvoiceDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['invoicing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useRef(createSubmissionKeys()).current;
  const left = creditableCents(invoice);
  const [mode, setMode] = useState<'total' | 'partial'>('total');
  const [amount, setAmount] = useState<Money | null>(null);
  const [reason, setReason] = useState('');

  const reasonText = reason.trim();
  const valid =
    reasonText.length >= 3 &&
    (mode === 'total' ? left > 0 : amount !== null && amount > 0 && amount <= left);
  const noteType = NOTE_OF[invoice.type];

  const submit = useMutation({
    mutationFn: () => {
      const body: CreateCreditNoteRequest = {
        idempotencyKey: keys.keyFor(`${mode}|${String(amount)}|${reasonText}`),
        reason: reasonText,
        ...(mode === 'partial' && amount !== null ? { amountCents: amount } : {}),
      };
      return invoicingApi(api).createCreditNote(invoice.id, body);
    },
    onSuccess: async () => {
      keys.done();
      toast.success(t('invoicing:creditNote.done'));
      await queryClient.invalidateQueries({ queryKey: invoicingKeys.all });
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
          <DialogTitle>{t('invoicing:creditNote.title')}</DialogTitle>
          <DialogDescription>
            {t('invoicing:creditNote.description', {
              voucher: t(`invoicing:voucher.${invoice.type}`),
              number: voucherNumber(invoice.pointOfSale, invoice.number),
              left: formatMoney(money(left)),
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!submit.isPending && valid) submit.mutate();
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('invoicing:creditNote.how')}</legend>
            <RadioGroup
              value={mode}
              onValueChange={(value) => {
                setMode(value === 'partial' ? 'partial' : 'total');
              }}
              aria-label={t('invoicing:creditNote.how')}
            >
              <RadioCard
                value="total"
                title={t('invoicing:creditNote.total', { amount: formatMoney(money(left)) })}
                description={t('invoicing:creditNote.totalHelp')}
              />
              <RadioCard
                value="partial"
                title={t('invoicing:creditNote.partial')}
                description={t('invoicing:creditNote.partialHelp')}
              />
            </RadioGroup>
          </fieldset>

          {mode === 'partial' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="credit-note-amount">{t('invoicing:creditNote.amount')}</Label>
              <MoneyInput
                id="credit-note-amount"
                value={amount}
                max={money(left)}
                onValueChange={setAmount}
              />
            </div>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="credit-note-reason">{t('invoicing:creditNote.reason')}</Label>
            <Textarea
              id="credit-note-reason"
              value={reason}
              maxLength={200}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <p className="text-sm text-muted-foreground">{t('invoicing:creditNote.reasonHelp')}</p>
          </div>

          {noteType ? (
            <p className="rounded-md bg-secondary px-3 py-2 text-sm">
              {t('invoicing:creditNote.willBe', { voucher: t(`invoicing:voucher.${noteType}`) })}
            </p>
          ) : null}
          <ErrorAlert error={submit.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={submit.isPending}
              disabled={!valid}
            >
              {t('invoicing:creditNote.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
