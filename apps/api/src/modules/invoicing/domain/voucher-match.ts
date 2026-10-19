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

/**
 * Whether a voucher the authority holds at a number is the one this invoice asked for. The type, the
 * point of sale and the number are the question that found it; the rest is compared here: the total
 * and the date, WHO issued it, WHOM it is addressed to, and for a credit note the voucher it cancels.
 * Two invoices of one series with the same total on the same day differ in the last ones (JD-S4 R2-1).
 *
 * A field the lookup does not state is a mismatch, never a match: an authority that does not say who
 * the voucher is for cannot be taken as saying it is for this recipient, and a wrong adoption is a
 * voucher recorded on the wrong invoice. (The one exception is `associatedVoucher` of something that is
 * not a credit note: silence is the same as "none".)
 */
export function voucherMatches(found: Issued, facts: VoucherFacts): boolean {
  if (found.totalCents !== facts.totalCents || found.issueDate !== facts.issueDate) return false;
  if (found.issuerCuit === undefined || found.issuerCuit !== facts.issuerCuit) return false;
  if (found.buyerDocument === undefined) return false;
  if (!sameDocument(found.buyerDocument, facts.buyerDocument)) return false;
  if (facts.associatedVoucher === null) {
    return found.associatedVoucher === undefined || found.associatedVoucher === null;
  }
  return (
    found.associatedVoucher !== undefined &&
    sameAssociated(found.associatedVoucher, facts.associatedVoucher)
  );
}
