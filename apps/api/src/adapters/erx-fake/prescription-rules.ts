import { createHash } from 'node:crypto';

import type { PrescriptionRequest } from '@consultorio/contracts';

/**
 * What the e-prescription simulators (the in-memory fake and, in Track A3, the local Postgres one)
 * know about a prescription: which requests the provider refuses, what an external id and a
 * document address look like. Pure, so both adapters behave the same and the contract suite can
 * hold both to it. The messages are in Spanish: they reach the professional's screen.
 */

export const SERVICE_DOWN_MESSAGE =
  'El servicio de recetas electrónicas no está disponible. Intente nuevamente más tarde.';
export const TIMEOUT_MESSAGE =
  'El servicio de recetas electrónicas no respondió a tiempo. Se verificará antes de reintentar.';
export const KEY_REUSED_MESSAGE = 'La clave de la operación ya se usó con otra receta.';
export const NO_MEDICATIONS_MESSAGE = 'La receta no tiene medicamentos.';
export const BLANK_MEDICATION_MESSAGE = 'Una línea de la receta está vacía.';
export const UNKNOWN_PRESCRIPTION_MESSAGE =
  'El proveedor no tiene una receta con ese identificador.';
export const NOT_CANCELLABLE_MESSAGE = 'La receta ya fue dispensada o venció y no se puede anular.';

/** The address scheme of a simulated document: nothing outside the process can resolve it. */
export const FAKE_DOCUMENT_SCHEME = 'fake-erx://prescription/';

/** The reason the provider would refuse the request, or null when it would issue it. */
export function rejectionFor(request: PrescriptionRequest): string | null {
  if (request.items.length === 0) return NO_MEDICATIONS_MESSAGE;
  if (request.items.some((item) => item.trim() === '')) return BLANK_MEDICATION_MESSAGE;
  return null;
}

/**
 * A digest of what a request says, to tell a retry of the same prescription from a key that came
 * back with another one. The digest never leaves the adapter: the content is clinical.
 */
export function requestFingerprint(request: PrescriptionRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.matricula.jurisdiction,
        request.matricula.number,
        request.patientDocument.type,
        request.patientDocument.number,
        request.items,
      ]),
    )
    .digest('hex');
}

/** Deterministic external id of a prescription: the same key always gets the same one. */
export function externalIdFor(idempotencyKey: string): string {
  const digest = createHash('sha256').update(`erx|${idempotencyKey}`).digest('hex');
  return `ERX-${digest.slice(0, 12).toUpperCase()}`;
}

/** The address of the document of a simulated prescription. */
export function documentUrlFor(externalId: string): string {
  return `${FAKE_DOCUMENT_SCHEME}${externalId}`;
}
