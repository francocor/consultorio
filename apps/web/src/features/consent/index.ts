/**
 * What other features may use of consent. The patient portal signs a consent with the same screen
 * the staff use at reception, so the signing pieces are exported here: it only has to hand them the
 * view of the request and send the body they produce to its own endpoint.
 *
 * - `ConsentSigningForm`: the full text of the version, the explicit acceptance, the representative
 *   of a minor and the mark. `onSubmit` gets the body of the signature, bound to `view.version.id`.
 * - `SignaturePad`: the drawing canvas with the typed-name alternative that a keyboard can use.
 * - `ConsentStatusBadge`: the state of a consent with its icon and word.
 */
export { ConsentSigningForm } from './components/ConsentSigningForm.js';
export type { ConsentSigningFormProps } from './components/ConsentSigningForm.js';
export { ConsentStatusBadge } from './components/ConsentStatusBadge.js';
export { SignaturePad } from './components/SignaturePad.js';
export type { SignaturePadProps } from './components/SignaturePad.js';
