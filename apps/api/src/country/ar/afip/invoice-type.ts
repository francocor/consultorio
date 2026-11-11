import {
  fail,
  ok,
  validateCuit,
  validateNationalId,
  type InvoiceType,
  type RecipientDocumentType,
  type RecipientTaxCondition,
  type Result,
  type TaxCondition,
} from '@consultorio/contracts';

/**
 * The invoice type rules of Argentina (e-invoicing-afip, "Invoice type selection" and "Recipient
 * identification"). Pure functions: no database, no clock. The rest of the application reaches
 * them only through the country pack (`CountryPack.invoiceRules`).
 */

/**
 * From this amount (in cents) a consumer must be identified with name and document (ARCA General
 * Resolution 5616). ARCA updates the figure from time to time; the value below is the one the
 * simulator uses and must be confirmed against the current resolution before the real adapter
 * goes live (the go-live runbook, S4.17).
 */
export const IDENTIFICATION_THRESHOLD_CENTS = 41_728_800;

const INVOICE_TYPE_FOR_CREDIT_NOTE = { FA: 'NCA', FB: 'NCB', FC: 'NCC' } as const;
type InvoiceOfCreditNote = keyof typeof INVOICE_TYPE_FOR_CREDIT_NOTE;
type CreditNoteOfInvoice = (typeof INVOICE_TYPE_FOR_CREDIT_NOTE)[InvoiceOfCreditNote];

export interface TypeSelectionInput {
  issuer: TaxCondition;
  recipient: RecipientTaxCondition;
  /** A type the user asked for: it is only checked, never trusted. */
  requested?: InvoiceType;
}

/**
 * The type of invoice the rules give. A monotributista issues C; a responsable inscripto issues A
 * to a responsable inscripto and B to anyone else. An exempt issuer does not itemize VAT, so it
 * issues C like a monotributista (the specification names no rule for it; recorded as a decision
 * of the invoicing track). A type that was asked for and differs from the rules is refused, so the
 * screens never offer a choice beyond them.
 */
export function resolveInvoiceType(input: TypeSelectionInput): Result<InvoiceType> {
  const given = rulesType(input.issuer, input.recipient);
  if (input.requested !== undefined && input.requested !== given) {
    return fail('country.ar.invoice.type_forbidden');
  }
  return ok(given);
}

function rulesType(issuer: TaxCondition, recipient: RecipientTaxCondition): 'FA' | 'FB' | 'FC' {
  if (issuer === 'responsable_inscripto') {
    return recipient === 'responsable_inscripto' ? 'FA' : 'FB';
  }
  return 'FC';
}

/** The credit note that cancels an invoice: the same letter. A credit note has no credit note. */
export function creditNoteTypeFor(invoice: InvoiceType): Result<CreditNoteOfInvoice> {
  if (invoice === 'FA' || invoice === 'FB' || invoice === 'FC') {
    return ok(INVOICE_TYPE_FOR_CREDIT_NOTE[invoice]);
  }
  return fail('country.ar.invoice.credit_note_of_credit_note');
}

export interface RecipientInput {
  taxCondition: RecipientTaxCondition;
  name?: string;
  document?: { type: RecipientDocumentType; number: string };
}

export interface CheckedRecipient {
  taxCondition: RecipientTaxCondition;
  name?: string;
  document?: { type: RecipientDocumentType; number: string };
}

export interface RecipientCheckInput {
  type: InvoiceType;
  totalCents: number;
  recipient: RecipientInput;
  /** Defaults to the current resolution's threshold. */
  thresholdCents?: number;
}

/** Validates and normalizes a document; the number keeps digits only. */
function normalizeDocument(document: {
  type: RecipientDocumentType;
  number: string;
}): Result<{ type: RecipientDocumentType; number: string }> {
  const checked =
    document.type === 'cuit' ? validateCuit(document.number) : validateNationalId(document.number);
  return checked.ok ? ok({ type: document.type, number: checked.value }) : checked;
}

function withoutBlankName(name: string | undefined): { name?: string } {
  const trimmed = name?.trim();
  return trimmed ? { name: trimmed } : {};
}

/**
 * What the voucher type needs to know about the recipient:
 *
 * - Factura A: a responsable inscripto identified by a valid CUIT.
 * - Factura B and C: anonymous below the threshold; from it, name and a valid document.
 *
 * A document that is given is always checked, even when the amount does not require it.
 */
export function checkRecipient(input: RecipientCheckInput): Result<CheckedRecipient> {
  const { recipient, type } = input;
  const name = withoutBlankName(recipient.name);

  if (type === 'FA') {
    if (recipient.taxCondition !== 'responsable_inscripto') {
      return fail('country.ar.invoice.recipient_condition_invalid');
    }
    if (recipient.document?.type !== 'cuit') {
      return fail('country.ar.invoice.recipient_cuit_required');
    }
    const document = normalizeDocument(recipient.document);
    if (!document.ok) return document;
    return ok({ taxCondition: recipient.taxCondition, ...name, document: document.value });
  }

  const document = recipient.document ? normalizeDocument(recipient.document) : undefined;
  if (document && !document.ok) return document;

  const threshold = input.thresholdCents ?? IDENTIFICATION_THRESHOLD_CENTS;
  if (input.totalCents >= threshold && (!document || name.name === undefined)) {
    return fail('country.ar.invoice.recipient_identification_required');
  }
  return ok({
    taxCondition: recipient.taxCondition,
    ...name,
    ...(document ? { document: document.value } : {}),
  });
}
