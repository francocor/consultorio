/**
 * Phone numbers for WhatsApp. A patient's phone is typed by a person, in any form; WhatsApp needs
 * E.164 (`+5491144445555`). This reads the forms people write in Argentina (the default country of
 * v1) and returns null when the text cannot be a mobile number, so the channel is simply left out
 * and the reminder goes by email. The country-specific part lives here until a second country
 * exists and the country pack takes it.
 *
 * Numbers that start with the reserved prefix `+999` belong to no country: the local WhatsApp
 * simulator treats them as "not on WhatsApp", so a test or a demo can show a failing number.
 */

const MIN_DIGITS = 8;
const MAX_DIGITS = 15;
const COUNTRY_CODE = '54';

/** An Argentine area code is 11 (Buenos Aires) or two to four digits starting with 2 or 3. */
const NATIONAL_NUMBER = /^(?:11\d{8}|[23]\d{9})$/;

function digitsOf(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Removes the mobile "15" that people write after the area code (`0351 15 512-3456`). */
function withoutMobilePrefix(national: string): string {
  if (national.length !== 12) return national;
  for (const areaLength of [2, 3, 4]) {
    if (national.slice(areaLength, areaLength + 2) === '15') {
      return national.slice(0, areaLength) + national.slice(areaLength + 2);
    }
  }
  return national;
}

function international(digits: string): string | null {
  return digits.length >= MIN_DIGITS && digits.length <= MAX_DIGITS ? `+${digits}` : null;
}

export function normalizeWhatsAppNumber(raw: string): string | null {
  const digits = digitsOf(raw);
  if (digits === '') return null;

  const written = raw.trim();
  if (written.startsWith('+')) return international(digits);
  if (digits.startsWith('00')) return international(digits.slice(2).replace(/^54(?!9)/, '549'));

  // Written with the country code but no "+": `54 11 4444 5555` or `54 9 11 4444 5555`.
  if (digits.startsWith('549') && digits.length === 13) return `+${digits}`;
  if (digits.startsWith(COUNTRY_CODE) && digits.length === 12) {
    return NATIONAL_NUMBER.test(digits.slice(2)) ? `+549${digits.slice(2)}` : null;
  }

  // A national number, with or without the trunk "0" and the mobile "15".
  const national = withoutMobilePrefix(digits.replace(/^0/, ''));
  return NATIONAL_NUMBER.test(national) ? `+549${national}` : null;
}

/**
 * The sender of a reply, as the provider gives it: always the full international number, written
 * as digits with no "+" (`14155550100`), so a number from any country is a number. Argentine forms
 * (`541144445555`, which lacks the mobile 9) are completed by `normalizeWhatsAppNumber`; a number
 * that is not Argentine is never read as an Argentine national form, which would invent a number
 * nobody has. Null only when the text cannot be a phone number at all.
 */
export function normalizeInboundNumber(raw: string): string | null {
  const digits = digitsOf(raw);
  if (digits === '') return null;
  if (raw.trim().startsWith('+') || digits.startsWith(COUNTRY_CODE)) {
    const known = normalizeWhatsAppNumber(raw);
    if (known !== null) return known;
  }
  return international(digits);
}
