import { createHash } from 'node:crypto';

import type {
  PaymentLinkRequest,
  PreapprovalRequest,
} from '../../modules/subscriptions/application/ports.js';

/**
 * What the Mercado Pago simulators (the in-memory fake and, in Track A, the local one that keeps its
 * state in Postgres) know: which requests the provider refuses, what an identifier and a hosted page
 * look like. Pure, so both adapters behave the same and the contract suite can hold both to it. The
 * messages are in Spanish: they reach the owner's screen.
 */

export const SERVICE_DOWN_MESSAGE =
  'El servicio de pagos no está disponible. Intente nuevamente más tarde.';
export const TIMEOUT_MESSAGE =
  'El servicio de pagos no respondió a tiempo. Se verificará antes de reintentar.';
export const KEY_REUSED_MESSAGE = 'La clave de la operación ya se usó con otra solicitud.';
export const INVALID_AMOUNT_MESSAGE =
  'El importe debe ser un número entero de centavos mayor a cero.';
export const INVALID_PAYER_MESSAGE = 'El correo del pagador no es válido.';
export const INVALID_REFERENCE_MESSAGE =
  'La referencia de la operación está vacía o es demasiado larga.';
export const INVALID_URL_MESSAGE = 'La dirección de retorno no es válida.';
export const EXPIRED_LINK_MESSAGE = 'El enlace de pago ya venció.';
export const UNKNOWN_PREAPPROVAL_MESSAGE =
  'El proveedor no tiene una suscripción con ese identificador.';
export const UNKNOWN_PAYMENT_MESSAGE = 'El proveedor no tiene un pago con ese identificador.';
export const NOT_REFUNDABLE_MESSAGE = 'El pago no fue aprobado, por lo que no se puede reembolsar.';
export const REFUND_EXCEEDS_MESSAGE = 'El reembolso supera lo que queda del pago.';
export const AMOUNT_CHANGE_REFUSED_MESSAGE =
  'El proveedor no permite cambiar el importe de una autorización vigente.';
export const NOT_AUTHORIZED_MESSAGE =
  'La suscripción no está autorizada, por lo que no se puede modificar.';

const MAX_REFERENCE_LENGTH = 256;
/** The most a single operation may carry: ARS 100,000,000.00. */
export const MAX_AMOUNT_CENTS = 10_000_000_000;

/** The hosted pages of a simulated provider: a host that never resolves. */
export const FAKE_CHECKOUT_ORIGIN = 'https://checkout.fake-mercadopago.invalid';

export function isValidAmount(amountCents: number): boolean {
  return Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= MAX_AMOUNT_CENTS;
}

function isValidAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function referenceProblem(reference: string): string | null {
  const trimmed = reference.trim();
  return trimmed === '' || trimmed.length > MAX_REFERENCE_LENGTH ? INVALID_REFERENCE_MESSAGE : null;
}

function payerProblem(email: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? null : INVALID_PAYER_MESSAGE;
}

/** The reason the provider would refuse the preapproval, or null when it would create it. */
export function preapprovalProblem(request: PreapprovalRequest): string | null {
  // The type says ARS; a caller that is not typed may not.
  if ((request.currency as string) !== 'ARS') return INVALID_AMOUNT_MESSAGE;
  if (!isValidAmount(request.amountCents)) return INVALID_AMOUNT_MESSAGE;
  return (
    referenceProblem(request.externalReference) ??
    payerProblem(request.payerEmail) ??
    (isValidAddress(request.backUrl) ? null : INVALID_URL_MESSAGE)
  );
}

/** The reason the provider would refuse the payment link, or null when it would create it. */
export function paymentLinkProblem(request: PaymentLinkRequest, now: Date): string | null {
  // The type says ARS; a caller that is not typed may not.
  if ((request.currency as string) !== 'ARS') return INVALID_AMOUNT_MESSAGE;
  if (!isValidAmount(request.amountCents)) return INVALID_AMOUNT_MESSAGE;
  const problem =
    referenceProblem(request.externalReference) ??
    payerProblem(request.payerEmail) ??
    (isValidAddress(request.backUrl) ? null : INVALID_URL_MESSAGE);
  if (problem !== null) return problem;
  const expires = Date.parse(request.expiresAt);
  return Number.isNaN(expires) || expires <= now.getTime() ? EXPIRED_LINK_MESSAGE : null;
}

/**
 * A digest of what a request says, to tell a retry of the same operation from a key that came back
 * with another one. It names every identifying field, so two requests that differ in any of them
 * never share a digest.
 */
export function requestFingerprint(
  kind: 'preapproval' | 'link' | 'amount' | 'refund' | 'cancel',
  parts: readonly (string | number)[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([kind, ...parts]))
    .digest('hex');
}

/** Deterministic, readable identifier of a simulated resource. */
export function identifierFor(prefix: 'PRE' | 'PAY' | 'LNK' | 'RFD', sequence: number): string {
  return `${prefix}-${String(sequence).padStart(6, '0')}`;
}

/** The hosted page of a simulated resource. */
export function checkoutUrlFor(kind: 'preapproval' | 'link', id: string): string {
  return `${FAKE_CHECKOUT_ORIGIN}/${kind}/${id}`;
}

/** The label the provider shows for the payment method of a simulated authorization. */
export const FAKE_PAYMENT_METHOD_LABEL = 'Visa terminada en 4242';
