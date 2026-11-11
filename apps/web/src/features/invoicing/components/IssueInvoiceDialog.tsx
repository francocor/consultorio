import {
  money,
  type ChargeDto,
  type CreateInvoiceRequest,
  type InvoiceDto,
  type InvoiceType,
  type Money,
  type RecipientTaxCondition,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatMoney } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
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
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { MoneyInput } from '../../../shared/ui/money-input.js';
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';
import { Skeleton } from '../../../shared/ui/skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingKeys, ErrorAlert } from '../../billing/index.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';
import { issuableLines, type IssuableLine } from '../domain/invoice-display.js';
import { createSubmissionKeys } from '../domain/submission-key.js';

import { EMPTY_RECIPIENT, RecipientFields, type RecipientState } from './RecipientFields.js';

/** Where the lines of the invoice come from: a charge, or a rejected attempt that is retried. */
export type IssueSource =
  { kind: 'charge'; charge: ChargeDto } | { kind: 'retry'; invoice: InvoiceDto };

/** A line of the form: something left to invoice, whether it is in this invoice and for how much. */
interface FormLine extends IssuableLine {
  selected: boolean;
  amount: Money | null;
}

function startingLines(charge: ChargeDto, portion: 'patient' | 'payer'): FormLine[] {
  return issuableLines(charge, portion).map((line) => ({
    ...line,
    selected: true,
    amount: line.leftCents,
  }));
}

function retryRecipient(invoice: InvoiceDto): RecipientState {
  return {
    taxCondition: invoice.recipient.taxCondition,
    name: invoice.recipient.kind === 'patient' ? (invoice.recipient.name ?? '') : '',
    docType: invoice.recipient.document?.type ?? 'dni',
    docNumber: invoice.recipient.document?.number ?? '',
  };
}

/**
 * Asks for an invoice (e-invoicing-afip, "Issuing an invoice with CAE", "Invoice type selection"):
 * the lines to cover (all that is left of a line, or a part), who the invoice is addressed to (the
 * patient for their portion, the payer for its portion) and the data of the recipient. The type is
 * what the rules of the country give for that recipient, shown and never chosen; the server decides
 * again. The request carries a key that follows what is sent, so a double click is one invoice.
 *
 * A rejected attempt is retried with the same lines and the data corrected: a new attempt linked to
 * the old one.
 */
export function IssueInvoiceDialog({
  source,
  onClose,
}: {
  source: IssueSource;
  onClose: () => void;
}) {
  const { t } = useTranslation(['invoicing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const keys = useRef(createSubmissionKeys()).current;

  const charge = source.kind === 'charge' ? source.charge : null;
  const retryOf = source.kind === 'retry' ? source.invoice : null;
  const hasPayerLines = charge !== null && issuableLines(charge, 'payer').length > 0;
  const hasPatientLines = charge !== null && issuableLines(charge, 'patient').length > 0;

  const [kind, setKind] = useState<'patient' | 'payer'>(
    retryOf ? retryOf.recipient.kind : hasPatientLines ? 'patient' : 'payer',
  );
  const [lines, setLines] = useState<FormLine[]>(() =>
    charge ? startingLines(charge, hasPatientLines ? 'patient' : 'payer') : [],
  );
  const [recipient, setRecipient] = useState<RecipientState>(() =>
    retryOf
      ? retryRecipient(retryOf)
      : {
          ...EMPTY_RECIPIENT,
          taxCondition: hasPatientLines ? 'consumidor_final' : 'responsable_inscripto',
        },
  );
  const [pointOfSale, setPointOfSale] = useState<number | null>(null);

  const readiness = useQuery({
    queryKey: invoicingKeys.readiness,
    queryFn: () => invoicingApi(api).readiness(),
  });
  const options = useQuery({
    queryKey: invoicingKeys.options,
    queryFn: () => invoicingApi(api).options(),
  });

  const typeOf = (condition: RecipientTaxCondition): InvoiceType | undefined =>
    options.data?.types.find((entry) => entry.recipient === condition)?.type;
  const type = typeOf(recipient.taxCondition);
  const points = options.data?.pointsOfSale ?? [];
  const chosenPoint = pointOfSale ?? points[0]?.number ?? null;

  /** What the invoice would cover: the selected lines with a valid amount. */
  const parts = useMemo(() => {
    if (retryOf) {
      return retryOf.lines.map((line) => ({
        chargeLineId: line.chargeLineId,
        description: line.description,
        amountCents: money(line.amountCents),
      }));
    }
    return lines
      .filter((line) => line.selected && line.amount !== null && line.amount > 0)
      .map((line) => ({
        chargeLineId: line.id,
        description: line.description,
        amountCents: line.amount ?? money(0),
      }));
  }, [lines, retryOf]);
  const total = parts.reduce((sum, part) => sum + part.amountCents, 0);
  const lineErrors = retryOf
    ? false
    : lines.some(
        (line) =>
          line.selected &&
          (line.amount === null || line.amount <= 0 || line.amount > line.leftCents),
      );

  const document = recipient.docNumber.trim();
  const request = (): CreateInvoiceRequest => ({
    idempotencyKey: keys.keyFor(
      JSON.stringify([
        kind,
        parts.map((part) => [part.chargeLineId, part.amountCents]),
        recipient,
        chosenPoint,
        retryOf?.id ?? null,
      ]),
    ),
    lines: parts.map((part) => ({
      chargeLineId: part.chargeLineId,
      amountCents: part.amountCents,
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
    ...(chosenPoint !== null && points.length > 1 ? { pointOfSale: chosenPoint } : {}),
    ...(retryOf ? { previousAttemptId: retryOf.id } : {}),
  });

  const issue = useMutation({
    mutationFn: () => invoicingApi(api).createInvoice(request()),
    onSuccess: async () => {
      keys.done();
      toast.success(t('invoicing:issue.done'));
      await queryClient.invalidateQueries({ queryKey: invoicingKeys.all });
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
      onClose();
    },
  });

  const blockers = readiness.data && !readiness.data.available ? readiness.data.reasons : [];
  const blocked = blockers.length > 0;
  const ready = !blocked && type !== undefined && parts.length > 0 && !lineErrors && total > 0;
  const needsCuitNow =
    type === 'FA' && kind === 'patient' && recipient.docNumber.trim().length === 0;

  const choosePortion = (next: 'patient' | 'payer') => {
    if (!charge) return;
    setKind(next);
    setLines(startingLines(charge, next));
    setRecipient((current) => ({
      ...current,
      taxCondition: next === 'payer' ? 'responsable_inscripto' : 'consumidor_final',
    }));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {retryOf ? t('invoicing:issue.retryTitle') : t('invoicing:issue.title')}
          </DialogTitle>
          <DialogDescription>
            {charge
              ? t('invoicing:issue.description', {
                  patient: charge.patientName,
                  service: charge.appointmentTypeName,
                })
              : t('invoicing:issue.retryDescription', {
                  voucher: t(`invoicing:voucher.${retryOf?.type ?? 'FC'}`),
                })}
          </DialogDescription>
        </DialogHeader>

        {readiness.isPending || options.isPending ? <Skeleton className="h-20 w-full" /> : null}
        {blocked ? (
          <Alert tone="warning">
            <AlertDescription>
              <span className="block font-medium">{t('invoicing:issue.blocked')}</span>
              <ul className="mt-1 list-disc pl-5">
                {blockers.map((reason) => (
                  <li key={reason}>{t(`invoicing:readiness.reason.${reason}`)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!issue.isPending && ready) issue.mutate();
          }}
        >
          {hasPayerLines && hasPatientLines ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">
                {t('invoicing:issue.addressedTo')}
              </legend>
              <RadioGroup
                value={kind}
                onValueChange={(value) => {
                  choosePortion(value === 'payer' ? 'payer' : 'patient');
                }}
                aria-label={t('invoicing:issue.addressedTo')}
              >
                <RadioCard
                  value="patient"
                  title={t('invoicing:issue.toPatient')}
                  description={t('invoicing:issue.toPatientHelp')}
                />
                <RadioCard
                  value="payer"
                  title={t('invoicing:issue.toPayer', { payer: charge.payerName ?? '' })}
                  description={t('invoicing:issue.toPayerHelp')}
                />
              </RadioGroup>
            </fieldset>
          ) : null}

          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">{t('invoicing:issue.lines')}</legend>
            {retryOf ? (
              <ul className="grid gap-1 rounded-md border bg-card">
                {parts.map((part) => (
                  <li
                    key={part.chargeLineId}
                    className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span>{part.description}</span>
                    <span className="tabular-nums">{formatMoney(part.amountCents)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="grid gap-2">
                {lines.map((line, index) => (
                  <li key={line.id} className="grid gap-2 rounded-md border bg-card p-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id={`issue-line-${line.id}`}
                        checked={line.selected}
                        onCheckedChange={(next) => {
                          setLines((current) =>
                            current.map((entry, at) =>
                              at === index ? { ...entry, selected: next === true } : entry,
                            ),
                          );
                        }}
                      />
                      <Label htmlFor={`issue-line-${line.id}`} className="grid gap-0.5 font-normal">
                        <span className="font-medium">{line.description}</span>
                        <span className="text-sm text-muted-foreground">
                          {t('invoicing:issue.left', { amount: formatMoney(line.leftCents) })}
                        </span>
                      </Label>
                    </div>
                    {line.selected ? (
                      <div className="grid gap-1.5 pl-8">
                        <Label htmlFor={`issue-amount-${line.id}`}>
                          {t('invoicing:issue.amountOf', { description: line.description })}
                        </Label>
                        <MoneyInput
                          id={`issue-amount-${line.id}`}
                          value={line.amount}
                          max={line.leftCents}
                          onValueChange={(next) => {
                            setLines((current) =>
                              current.map((entry, at) =>
                                at === index ? { ...entry, amount: next } : entry,
                              ),
                            );
                          }}
                        />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <p className="flex items-baseline justify-between text-sm font-semibold">
              <span>{t('invoicing:issue.total')}</span>
              <span className="tabular-nums">{formatMoney(money(total))}</span>
            </p>
          </fieldset>

          {kind === 'payer' && charge ? (
            <p className="text-sm text-muted-foreground">
              {t('invoicing:issue.payerNote', { payer: charge.payerName ?? '' })}
            </p>
          ) : null}

          <RecipientFields
            idPrefix="issue"
            kind={kind}
            value={recipient}
            onChange={setRecipient}
            type={type}
          />

          {points.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="issue-pos">{t('invoicing:issue.pointOfSale')}</Label>
              <Select
                id="issue-pos"
                value={String(chosenPoint ?? '')}
                onChange={(event) => {
                  setPointOfSale(Number(event.target.value));
                }}
              >
                {points.map((point) => (
                  <option key={point.number} value={point.number}>
                    {t('invoicing:issue.pointOption', {
                      number: String(point.number).padStart(4, '0'),
                      environment: t(`invoicing:env.${point.environment}`),
                    })}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {type ? (
            <p className="rounded-md bg-secondary px-3 py-2 text-sm" aria-live="polite">
              {t('invoicing:issue.willBe', { voucher: t(`invoicing:voucher.${type}`) })}
            </p>
          ) : null}
          {needsCuitNow ? (
            <p className="text-sm text-warning-soft-foreground">
              {t('invoicing:issue.cuitNeeded')}
            </p>
          ) : null}

          <ErrorAlert error={issue.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={issue.isPending} disabled={!ready}>
              {t('invoicing:issue.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
