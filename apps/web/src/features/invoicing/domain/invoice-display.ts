import type { ChargeDto, InvoiceDto, InvoiceType, Money } from '@consultorio/contracts';
import { money } from '@consultorio/contracts';

/**
 * The small decisions the invoicing screens make, apart from React: how a voucher number is written,
 * how long ago an invoice was asked for, which lines of a charge an invoice can still cover and how
 * much of an invoice a credit note can take back. The rules themselves (the type, the limits) are the
 * server's; these only decide what to show and offer.
 */

/** `0001-00000077`, as AFIP prints it; empty while the voucher has no number. */
export function voucherNumber(pointOfSale: number, number: number | null): string {
  if (number === null) return '';
  return `${String(pointOfSale).padStart(4, '0')}-${String(number).padStart(8, '0')}`;
}

export interface AgeParts {
  unit: 'minutes' | 'hours' | 'days';
  count: number;
}

const HOUR = 60;
const DAY = 24 * HOUR;
const TWO_DAYS = 2 * DAY;

/** The age of a pending invoice in the biggest unit that reads well: minutes, hours, days. */
export function ageParts(ageMinutes: number): AgeParts {
  if (ageMinutes < HOUR) return { unit: 'minutes', count: ageMinutes };
  if (ageMinutes < TWO_DAYS) return { unit: 'hours', count: Math.floor(ageMinutes / HOUR) };
  return { unit: 'days', count: Math.floor(ageMinutes / DAY) };
}

export interface IssuableLine {
  id: string;
  description: string;
  kind: ChargeDto['lines'][number]['kind'];
  /** What an invoice can still cover of the line. */
  leftCents: Money;
  amountCents: Money;
}

type ChargeFacts = Pick<ChargeDto, 'lines' | 'status'>;

/** The lines of one portion with something left to invoice. A voided charge is final: none. */
export function issuableLines(charge: ChargeFacts, portion: 'patient' | 'payer'): IssuableLine[] {
  if (charge.status === 'voided') return [];
  return charge.lines
    .filter((line) => line.portion === portion && line.invoicedCents < line.amountCents)
    .map((line) => ({
      id: line.id,
      description: line.description,
      kind: line.kind,
      leftCents: money(line.amountCents - line.invoicedCents),
      amountCents: line.amountCents,
    }));
}

/** Whether some line of the charge can still be invoiced. */
export function canInvoiceCharge(charge: ChargeFacts): boolean {
  return issuableLines(charge, 'patient').length + issuableLines(charge, 'payer').length > 0;
}

/** A Factura A is addressed with the CUIT of the recipient. */
export function needsCuit(type: InvoiceType | undefined): boolean {
  return type === 'FA';
}

type InvoiceFacts = Pick<InvoiceDto, 'kind' | 'totalCents' | 'creditedCents' | 'status'>;

export function isCreditNote(invoice: Pick<InvoiceDto, 'kind'>): boolean {
  return invoice.kind === 'credit_note';
}

/** What a credit note can still take back of an invoice: nothing unless it is issued or registered. */
export function creditableCents(invoice: InvoiceFacts): number {
  if (invoice.kind === 'credit_note') return 0;
  if (invoice.status !== 'issued' && invoice.status !== 'manual') return 0;
  return Math.max(0, invoice.totalCents - invoice.creditedCents);
}
