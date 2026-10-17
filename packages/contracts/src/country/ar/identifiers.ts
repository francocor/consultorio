import { fail, ok, type Result } from '../../result.js';

/** Normalized national identity number (digits only). */
export type NationalId = string;
/** Normalized CUIT/CUIL (11 digits, no separators). */
export type TaxId = string;

const NATIONAL_ID_MIN_DIGITS = 6;
const NATIONAL_ID_MAX_DIGITS = 8;
const PASSPORT_PATTERN = /^[A-Z0-9]{6,20}$/;
/** Characters people type between the groups of a number. */
const SEPARATORS = /[\s.-]/g;
/** Prefixes AFIP assigns to people (20, 23, 24, 27) and companies (30, 33, 34). */
const CUIT_PREFIXES = new Set(['20', '23', '24', '27', '30', '33', '34']);
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const;

/** Keeps only the digits. Idempotent. */
export function normalizeDigits(input: string): string {
  return input.replace(/\D/g, '');
}

/** Strips typing separators and returns null when anything other than digits is left. */
function digitsOnly(input: string): string | null {
  const stripped = input.replace(SEPARATORS, '');
  return /^\d+$/.test(stripped) ? stripped : null;
}

/**
 * DNI: a number of 6 to 8 digits, typed with or without dots, spaces or hyphens. The normalized
 * value (no separators) is the identity key used for deduplication inside an organization.
 */
export function validateNationalId(input: string): Result<NationalId> {
  const digits = digitsOnly(input);
  if (
    digits === null ||
    digits.length < NATIONAL_ID_MIN_DIGITS ||
    digits.length > NATIONAL_ID_MAX_DIGITS ||
    Number(digits) === 0
  ) {
    return fail('country.ar.national_id.invalid');
  }
  return ok(digits);
}

/** Alternative document for non-residents. Stored together with its explicit type (`passport`). */
export function validatePassport(input: string): Result<string> {
  const value = input.replace(SEPARATORS, '').toUpperCase();
  return PASSPORT_PATTERN.test(value) ? ok(value) : fail('country.ar.passport.invalid');
}

function cuitCheckDigit(firstTen: string): number {
  const sum = CUIT_WEIGHTS.reduce(
    (total, weight, index) => total + Number(firstTen.charAt(index)) * weight,
    0,
  );
  const check = 11 - (sum % 11);
  // 11 maps to 0. 10 has no valid digit for this prefix (AFIP reassigns the prefix), so it never matches.
  return check === 11 ? 0 : check;
}

/** CUIT/CUIL: 11 digits, an assigned prefix and a correct modulo-11 check digit. */
export function validateCuit(input: string): Result<TaxId> {
  const digits = digitsOnly(input);
  if (
    digits?.length !== 11 ||
    !CUIT_PREFIXES.has(digits.slice(0, 2)) ||
    cuitCheckDigit(digits.slice(0, 10)) !== Number(digits.slice(10))
  ) {
    return fail('country.ar.tax_id.invalid');
  }
  return ok(digits);
}

/** `20123456786` becomes `20-12345678-6`. Expects a value that already passed `validateCuit`. */
export function formatCuit(normalized: TaxId): string {
  return `${normalized.slice(0, 2)}-${normalized.slice(2, 10)}-${normalized.slice(10)}`;
}
