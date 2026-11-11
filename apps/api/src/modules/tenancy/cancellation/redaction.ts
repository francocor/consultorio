/**
 * What may never leave in a package of the cancellation export, decided by the NAME of a field so it
 * holds whatever module produced it.
 *
 * - A secret (a credential, a token or its hash, a private key, a fiscal certificate) is dropped from
 *   every package, and the exporter reports that it did: a contributor that emits one is a defect to
 *   fix at the source, but the package must not carry it in the meantime (the export is data the
 *   organization takes with it, not the platform's keys).
 * - A clinical field in the ADMINISTRATIVE package is not dropped but refused: the administrative
 *   package goes to the owner, who may not be a health professional, so a clinical key in it means a
 *   contributor is in the wrong part, and delivering anything of that package would be the leak
 *   (tenancy, "Owner who is not a professional"). The build fails closed with a code.
 */

/** A field name reduced to lowercase letters and digits, so `password_hash` and `passwordHash` meet. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

/** Pieces of a (normalized) name that mean a secret. */
const SECRET_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'tokenhash',
  'privatekey',
  'wrappedkey',
  'wrappeddek',
  'credential',
  'certificate',
  'totp',
  'recoverycode',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'bearer',
  'keypem',
  'certpem',
  'pfx',
] as const;

/** Names that mean a secret only when they are the whole name (`tokenKind` is not one). */
const SECRET_EXACT = new Set(['token', 'otp', 'pin', 'kek', 'dek']);

export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === '') return false;
  return SECRET_EXACT.has(normalized) || SECRET_FRAGMENTS.some((part) => normalized.includes(part));
}

/**
 * The names that belong to the clinical parts: what the clinical contributors emit (the addenda and
 * the content of an entry, anamnesis, prescriptions, signed consents). A name only counts when it is
 * the whole name, so `contentType` of a document is not a clinical field. Two generic names are
 * deliberately absent: `documents` (administrative and clinical documents share it) and `entries`
 * (the waitlist has entries too); an entry of a clinical record carries `content` and `addenda`, which
 * are caught wherever they are. Which package a row goes to is decided by the contributor's kind and,
 * underneath, by the clinical policies of the database.
 */
export const CLINICAL_KEYS: ReadonlySet<string> = new Set(
  [
    'addenda',
    'excludedEnteredInError',
    'anamnesis',
    'prescriptions',
    'consents',
    'content',
    'reasonForConsultation',
    'diagnoses',
    'medications',
  ].map(normalizeKey),
);

export function isClinicalKey(key: string): boolean {
  return CLINICAL_KEYS.has(normalizeKey(key));
}

/** A contributor of the administrative part emitted a clinical field. */
export class ClinicalKeyInAdministrativePartError extends Error {
  constructor(
    readonly contributor: string,
    readonly key: string,
  ) {
    super(`The administrative part of "${contributor}" carries a clinical field.`);
    this.name = 'ClinicalKeyInAdministrativePartError';
  }
}
