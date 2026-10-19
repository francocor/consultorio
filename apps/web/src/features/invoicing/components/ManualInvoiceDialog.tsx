import {
  INVOICE_ONLY_TYPES,
  money,
  type CreateManualInvoiceRequest,
  type InvoiceOnlyType,
  type InvoiceType,
} from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { DEFAULT_TIME_ZONE, formatMoney } from '../../../shared/lib/format.js';
import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingKeys, ErrorAlert } from '../../billing/index.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';
import { createSubmissionKeys } from '../domain/submission-key.js';

import { EMPTY_RECIPIENT, RecipientFields, type RecipientState } from './RecipientFields.js';

export interface ManualLine {
  chargeLineId: string;
  description: string;
  amountCents: number;
}

/** Today in the time zone of the organization, as `YYYY-MM-DD`. */
function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: DEFAULT_TIME_ZONE });
}

/**
 * Registers an invoice that was issued outside the system, in the web tool of AFIP (e-invoicing-afip,
 * "Manual invoice entry fallback"), for the owner and the administration: type, point of sale,
 * number, CAE, date, recipient and amount. It is saved as a manual invoice linked to the charge
 * lines and cannot be changed afterwards. When it stands in for an invoice that is still pending (an
 * outage), that one is closed, so the same service is never invoiced twice.
 */
export function ManualInvoiceDialog({
  lines,
  kind,
  recipient: initial,
  replacesInvoiceId,
  defaultType,
  onClose,
}: {
  lines: readonly ManualLine[];
  kind: 'patient' | 'payer';
  recipient?: RecipientState | undefined;
  replacesInvoiceId?: string | undefined;
  defaultType?: InvoiceType | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation(['invoicing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useRef(createSubmissionKeys()).current;
  const startType = (INVOICE_ONLY_TYPES as readonly string[]).includes(defaultType ?? '')
    ? (defaultType as InvoiceOnlyType)
    : 'FC';
  const [type, setType] = useState<InvoiceOnlyType>(startType);
  const [pointOfSale, setPointOfSale] = useState('');
  const [number, setNumber] = useState('');
  const [cae, setCae] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [caeExpiresOn, setCaeExpiresOn] = useState('');
  const [recipient, setRecipient] = useState<RecipientState>(initial ?? EMPTY_RECIPIENT);
  // The invoice this one replaces was sent to ARCA and nobody knows if it was issued: the server
  // says so (409), and then the person has to accept that outcome before the voucher is registered.
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const posNumber = Number(pointOfSale);
  const voucherNumber = Number(number);
  const valid =
    Number.isInteger(posNumber) &&
    posNumber >= 1 &&
    posNumber <= 99_999 &&
    Number.isInteger(voucherNumber) &&
    voucherNumber >= 1 &&
    /^[0-9]{14}$/.test(cae) &&
    issueDate !== '' &&
    total > 0;

  const document = recipient.docNumber.trim();
  const register = useMutation({
    mutationFn: () => {
      const body: CreateManualInvoiceRequest = {
        idempotencyKey: keys.keyFor(
          JSON.stringify([
            type,
            posNumber,
            voucherNumber,
            cae,
            issueDate,
            replacesInvoiceId ?? null,
            acknowledged,
          ]),
        ),
        type,
        pointOfSale: posNumber,
        number: voucherNumber,
        cae,
        issueDate,
        ...(caeExpiresOn === '' ? {} : { caeExpiresOn }),
        totalCents: total,
        lines: lines.map((line) => ({
          chargeLineId: line.chargeLineId,
          amountCents: line.amountCents,
        })),
        recipient: {
          kind,
          taxCondition: recipient.taxCondition,
          ...(kind === 'patient' && recipient.name.trim() !== ''
            ? { name: recipient.name.trim() }
            : {}),
          ...(kind === 'patient' && document !== ''
            ? {
                document: {
                  type: type === 'FA' ? ('cuit' as const) : recipient.docType,
                  number: document,
                },
              }
            : {}),
        },
        ...(replacesInvoiceId ? { replacesInvoiceId } : {}),
        ...(outcomeUnknown && acknowledged ? { acknowledgeUnknownOutcome: true } : {}),
      };
      return invoicingApi(api).registerManual(body);
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'invoice_awaiting_reconciliation') {
        setOutcomeUnknown(true);
      }
    },
    onSuccess: async () => {
      keys.done();
      toast.success(t('invoicing:manual.done'));
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
          <DialogTitle>{t('invoicing:manual.title')}</DialogTitle>
          <DialogDescription>{t('invoicing:manual.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!register.isPending && valid) register.mutate();
          }}
        >
          <ul
            aria-label={t('invoicing:manual.lines')}
            className="grid gap-1 rounded-md border bg-card"
          >
            {lines.map((line) => (
              <li
                key={line.chargeLineId}
                className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
              >
                <span>{line.description}</span>
                <span className="tabular-nums">{formatMoney(money(line.amountCents))}</span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm font-semibold">
              <span>{t('invoicing:manual.total')}</span>
              <span className="tabular-nums">{formatMoney(money(total))}</span>
            </li>
          </ul>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="manual-type">{t('invoicing:manual.type')}</Label>
              <Select
                id="manual-type"
                value={type}
                onChange={(event) => {
                  setType(event.target.value as InvoiceOnlyType);
                }}
              >
                {INVOICE_ONLY_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {t(`invoicing:voucher.${option}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="manual-pos">{t('invoicing:manual.pointOfSale')}</Label>
              <Input
                id="manual-pos"
                value={pointOfSale}
                inputMode="numeric"
                maxLength={5}
                onChange={(event) => {
                  setPointOfSale(event.target.value.replace(/\D/g, ''));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="manual-number">{t('invoicing:manual.number')}</Label>
              <Input
                id="manual-number"
                value={number}
                inputMode="numeric"
                maxLength={8}
                onChange={(event) => {
                  setNumber(event.target.value.replace(/\D/g, ''));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="manual-cae">{t('invoicing:manual.cae')}</Label>
              <Input
                id="manual-cae"
                value={cae}
                inputMode="numeric"
                maxLength={14}
                autoComplete="off"
                onChange={(event) => {
                  setCae(event.target.value.replace(/\D/g, ''));
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="manual-date">{t('invoicing:manual.issueDate')}</Label>
              <Input
                id="manual-date"
                type="date"
                value={issueDate}
                onChange={(event) => {
                  setIssueDate(event.target.value);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="manual-expires">{t('invoicing:manual.caeExpiresOn')}</Label>
              <Input
                id="manual-expires"
                type="date"
                value={caeExpiresOn}
                onChange={(event) => {
                  setCaeExpiresOn(event.target.value);
                }}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{t('invoicing:manual.caeHelp')}</p>

          <RecipientFields
            idPrefix="manual"
            kind={kind}
            value={recipient}
            onChange={setRecipient}
            type={type}
          />

          {outcomeUnknown ? (
            <Alert tone="warning">
              <AlertTitle>{t('invoicing:manual.unknownOutcome.title')}</AlertTitle>
              <AlertDescription>{t('invoicing:manual.unknownOutcome.body')}</AlertDescription>
              <div className="mt-2 flex items-start gap-2">
                <Checkbox
                  id="manual-acknowledge"
                  checked={acknowledged}
                  onCheckedChange={(next) => {
                    setAcknowledged(next === true);
                  }}
                />
                <Label htmlFor="manual-acknowledge" className="font-normal">
                  {t('invoicing:manual.unknownOutcome.confirm')}
                </Label>
              </div>
            </Alert>
          ) : null}
          <ErrorAlert error={register.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button
              type="submit"
              loading={register.isPending}
              disabled={!valid || (outcomeUnknown && !acknowledged)}
            >
              {t('invoicing:manual.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
