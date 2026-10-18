import { createHash } from 'node:crypto';

import { INVOICE_TYPES, validateCuit, type InvoiceRequest } from '@consultorio/contracts';

/**
 * What the AFIP simulators (the in-memory fake and the local Postgres one) know about a voucher:
 * which requests the authority refuses, what a CAE looks like and when it ends. Pure, so the two
 * adapters behave the same and the contract suite can hold both to it. The messages mimic the
 * authority's own (a code in parentheses and a sentence in Spanish).
 */

/** A CAE is valid for 10 days from the date of the voucher. */
export const CAE_VALIDITY_DAYS = 10;

/** How long the `slow` mode keeps a request waiting. */
export const DEFAULT_SLOW_MS = 1500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The reason AFIP would refuse the request, or null when it would authorize it. */
export function rejectionFor(request: InvoiceRequest): string | null {
  if (!request.issuerCuit || !validateCuit(request.issuerCuit).ok) {
    return '(10000) El CUIT del emisor no es válido.';
  }
  if (!(INVOICE_TYPES as readonly string[]).includes(request.type)) {
    return '(10002) El tipo de comprobante no es válido.';
  }
  if (request.currency !== 'ARS') {
    return '(10003) La moneda del comprobante no es válida.';
  }
  if (!ISO_DATE.test(request.issueDate) || Number.isNaN(Date.parse(request.issueDate))) {
    return '(10016) La fecha del comprobante no es válida.';
  }
  if (!Number.isInteger(request.totalCents) || request.totalCents <= 0) {
    return '(10001) El importe total debe ser mayor a cero.';
  }
  if (
    request.netCents !== undefined ||
    request.vatCents !== undefined ||
    request.exemptCents !== undefined
  ) {
    const sum = (request.netCents ?? 0) + (request.vatCents ?? 0) + (request.exemptCents ?? 0);
    if (sum !== request.totalCents) {
      return '(10048) El importe total no coincide con la suma de neto, IVA y exento.';
    }
  }
  const document = request.buyerDocument;
  if (document?.type === 'cuit' && !validateCuit(document.number).ok) {
    return '(10015) El número de documento del receptor no es un CUIT válido.';
  }
  if ((request.type === 'FA' || request.type === 'NCA') && document?.type !== 'cuit') {
    return '(10013) Para comprobantes clase A el receptor debe estar identificado con CUIT.';
  }
  return null;
}

/** Deterministic 14 digit CAE of a voucher: the same voucher always gets the same one. */
export function caeFor(voucher: {
  issuerCuit: string;
  pointOfSale: number;
  type: string;
  number: number;
}): string {
  const hash = createHash('sha256')
    .update(
      `${voucher.issuerCuit}|${String(voucher.pointOfSale)}|${voucher.type}|${String(voucher.number)}`,
    )
    .digest();
  let digits = '';
  for (const byte of hash) {
    digits += String(byte % 10);
    if (digits.length === 14) break;
  }
  // The first digit is never 0, so the CAE keeps 14 digits when read as a number.
  return `${String(1 + (Number(digits.charAt(0)) % 9))}${digits.slice(1)}`;
}

/** The date a CAE ends: ten days after the date of the voucher. */
export function caeExpiresOn(issueDate: string): string {
  const date = new Date(`${issueDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + CAE_VALIDITY_DAYS);
  return date.toISOString().slice(0, 10);
}

/** A fingerprint of everything the authority looks at, to tell a retry from a different request. */
export function requestFingerprint(request: InvoiceRequest): string {
  const ordered = Object.fromEntries(
    Object.entries(request)
      // The hint of the numbering is not what the authority is asked to authorize.
      .filter(([key, value]) => value !== undefined && key !== 'lastKnownNumber')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

export const KEY_REUSED_MESSAGE =
  '(10099) La clave de idempotencia ya se usó para un comprobante distinto.';
export const SERVICE_DOWN_MESSAGE = 'El servicio de facturación no responde. Se reintentará.';
export const TIMEOUT_MESSAGE =
  'El servicio de facturación no respondió a tiempo. Resultado desconocido.';
export const SIMULATED_REJECTION_MESSAGE =
  '(10016) Rechazo simulado: el comprobante fue rechazado a pedido del simulador.';
