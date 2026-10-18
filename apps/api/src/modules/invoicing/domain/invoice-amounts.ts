import {
  allocateProportional,
  money,
  type ChargeLineKind,
  type InvoiceType,
} from '@consultorio/contracts';

/**
 * The arithmetic of invoices, pure: how a total is broken down for the voucher, how an invoice
 * covers charge lines (in parts, never above what is left of a line) and how a credit note takes
 * back the lines of an invoice. Money is whole cents everywhere; the splits are the largest
 * remainder ones of `allocateProportional`, so the parts always add up.
 */

export interface Breakdown {
  netCents: number;
  vatCents: number;
  exemptCents: number;
}

const CREDIT_NOTES: readonly InvoiceType[] = ['NCA', 'NCB', 'NCC'];
const LETTER_C: readonly InvoiceType[] = ['FC', 'NCC'];

/**
 * How the total of a voucher is declared to the authority (net + VAT + exempt = total).
 *
 * - A letter C does not itemize VAT (the issuer is a monotributista or exempt): all of it is net.
 * - A letter A or B comes from a responsable inscripto. The services of health assistance are
 *   exempt from VAT, so all of it is declared exempt, with no VAT. If an organization ever bills a
 *   service that is taxed, this is the one place to change (and a decision for its accountant).
 */
export function breakdownFor(type: InvoiceType, totalCents: number): Breakdown {
  if (LETTER_C.includes(type)) return { netCents: totalCents, vatCents: 0, exemptCents: 0 };
  return { netCents: 0, vatCents: 0, exemptCents: totalCents };
}

export function isCreditNoteType(type: InvoiceType): boolean {
  return CREDIT_NOTES.includes(type);
}

export interface PartRequest {
  chargeLineId: string;
  amountCents?: number | undefined;
}

export interface Part {
  chargeLineId: string;
  amountCents: number;
}

export type PartsPlan =
  | { ok: true; parts: Part[]; totalCents: number }
  | { ok: false; reason: 'over_invoiced' | 'duplicate' | 'unknown'; chargeLineId: string };

/**
 * What an invoice covers of each line it names: the amount asked for, or all that is not yet
 * invoiced. An amount above what is left (or a line with nothing left) is refused, and so is a line
 * named twice or one that was not read.
 */
export function planParts(
  lines: readonly { id: string; uninvoicedCents: number }[],
  requested: readonly PartRequest[],
): PartsPlan {
  const left = new Map(lines.map((line) => [line.id, line.uninvoicedCents]));
  const seen = new Set<string>();
  const parts: Part[] = [];
  for (const request of requested) {
    const available = left.get(request.chargeLineId);
    if (available === undefined) {
      return { ok: false, reason: 'unknown', chargeLineId: request.chargeLineId };
    }
    if (seen.has(request.chargeLineId)) {
      return { ok: false, reason: 'duplicate', chargeLineId: request.chargeLineId };
    }
    seen.add(request.chargeLineId);
    const amountCents = request.amountCents ?? available;
    if (amountCents <= 0 || amountCents > available) {
      return { ok: false, reason: 'over_invoiced', chargeLineId: request.chargeLineId };
    }
    parts.push({ chargeLineId: request.chargeLineId, amountCents });
  }
  return { ok: true, parts, totalCents: parts.reduce((sum, part) => sum + part.amountCents, 0) };
}

/**
 * Splits a credit note over the lines of the invoice in proportion to what each line can still
 * take back (its amount minus what earlier notes took). A total note (the whole of what is left)
 * gets exactly what is left of every line. The note can never be above the sum of what is left.
 */
export function allocateCredit(leftCents: readonly number[], noteCents: number): number[] {
  const available = leftCents.reduce((sum, left) => sum + left, 0);
  if (noteCents > available) {
    throw new RangeError('A credit note cannot take back more than what is left of the invoice.');
  }
  return allocateProportional(money(noteCents), leftCents);
}

export interface LineWordingInput {
  kind: ChargeLineKind;
  /** The generic wording of the service (the appointment type's invoice description or its name). */
  serviceName: string;
}

/**
 * The words an invoice line carries. They come from the kind of the charge line and the generic
 * wording of the service, never from the free text of a charge line (a person may have typed
 * anything there). The wording is a snapshot: it is stored on the invoice line.
 */
export function lineWording(input: LineWordingInput): string {
  const service = input.serviceName.trim() === '' ? 'Servicios de salud' : input.serviceName.trim();
  switch (input.kind) {
    case 'copago':
      return 'Copago';
    case 'plus':
      return 'Plus';
    case 'late_fee':
      return 'Cargo por turno no cancelado';
    case 'manual':
      return 'Otros conceptos';
    case 'service':
    case 'payer_coverage':
      return service;
  }
}
