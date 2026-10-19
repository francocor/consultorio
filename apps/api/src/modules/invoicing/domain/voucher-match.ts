import type { IssueResult } from '@consultorio/contracts';

type Issued = Extract<IssueResult, { status: 'issued' }>;

type Document = { type: 'cuit' | 'dni'; number: string };
type Associated = { type: string; pointOfSale: number; number: number };

/** What our invoice says about the voucher it asked for. */
export interface VoucherFacts {
  issuerCuit: string;
  totalCents: number;
  issueDate: string;
  /** The document of the recipient; `null` when the invoice has none. */
  buyerDocument: Document | null;
  /** The voucher a credit note cancels; `null` for anything else. */
  associatedVoucher: Associated | null;
}

const sameDocument = (a: Document | null, b: Document | null): boolean =>
  a === null || b === null ? a === b : a.type === b.type && a.number === b.number;

const sameAssociated = (a: Associated | null, b: Associated | null): boolean =>
  a === null || b === null
    ? a === b
    : a.type === b.type && a.pointOfSale === b.pointOfSale && a.number === b.number;

/** What comparing a voucher with the facts of an invoice says. */
export type VoucherComparison =
  /** Every field is stated and the same. */
  | 'match'
  /** A field the authority states is not the one of the invoice: it is another voucher. */
  | 'differs'
  /** Nothing stated contradicts the invoice, but a field is missing: it cannot be told. */
  | 'unclear';

type Field = 'same' | 'differs' | 'unstated';

/**
 * Compares a voucher the authority holds at a number with the invoice that asked for it. The type, the
 * point of sale and the number are the question that found it; the rest is compared here: the total
 * and the date, WHO issued it, WHOM it is addressed to, and for a credit note the voucher it cancels.
 * Two invoices of one series with the same total on the same day differ in the last ones (JD-S4 R2-1).
 *
 * A field the lookup does not state is never taken as the same: an authority that does not say who the
 * voucher is for cannot be taken as saying it is for this recipient. But it is not taken as different
 * either: a voucher that states nothing against the invoice and leaves a field out MAY be the invoice's
 * (`unclear`), and an invoice that looks past it could issue a second one (JD-S4 R5-1). (The one
 * exception is `associatedVoucher` of something that is not a credit note: silence is the same as "none".)
 */
export function compareVoucher(found: Issued, facts: VoucherFacts): VoucherComparison {
  const stated = <T>(value: T | undefined, same: (value: T) => boolean): Field =>
    value === undefined ? 'unstated' : same(value) ? 'same' : 'differs';
  const fields: Field[] = [
    stated(found.totalCents, (total) => total === facts.totalCents),
    stated(found.issueDate, (date) => date === facts.issueDate),
    stated(found.issuerCuit, (cuit) => cuit === facts.issuerCuit),
    stated(found.buyerDocument, (document) => sameDocument(document, facts.buyerDocument)),
    facts.associatedVoucher === null
      ? found.associatedVoucher === undefined || found.associatedVoucher === null
        ? 'same'
        : 'differs'
      : stated(found.associatedVoucher, (voucher) =>
          sameAssociated(voucher, facts.associatedVoucher),
        ),
  ];
  if (fields.includes('differs')) return 'differs';
  return fields.includes('unstated') ? 'unclear' : 'match';
}

/** Whether a voucher the authority holds at a number is the one this invoice asked for. */
export function voucherMatches(found: Issued, facts: VoucherFacts): boolean {
  return compareVoucher(found, facts) === 'match';
}
