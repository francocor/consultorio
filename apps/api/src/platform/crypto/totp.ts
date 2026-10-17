import { randomBytes, timingSafeEqual } from 'node:crypto';

import { decodeBase32IgnorePadding, encodeBase32UpperCaseNoPadding } from '@oslojs/encoding';
import { generateHOTP } from '@oslojs/otp';

/** RFC 6238 with the parameters every authenticator app supports: SHA-1, 30 s, 6 digits. */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps of clock drift accepted on either side of the current one. */
export const TOTP_WINDOW = 1;
const SECRET_BYTES = 20;

/** The time step a moment falls in (RFC 6238 "T"). */
export function totpStepAt(moment: Date): number {
  return Math.floor(moment.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one time step. TOTP is HOTP whose counter is the step. */
export function codeAt(secret: Uint8Array, step: number, digits = TOTP_DIGITS): string {
  return generateHOTP(secret, BigInt(step), digits);
}

export type TotpVerdict = { ok: true; step: number } | { ok: false; reason: 'invalid' | 'replay' };

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks a submitted code against the steps around `now`. A step that was already accepted, or
 * any earlier one, is a replay (`lastUsedStep`): a code works once even inside its 90-second
 * window. The caller stores the returned step; it must do so atomically, so two simultaneous
 * submissions of one code cannot both succeed.
 */
export function verifyTotp(
  secret: Uint8Array,
  submitted: string,
  now: Date,
  lastUsedStep: number | null,
): TotpVerdict {
  const code = submitted.replace(/[\s-]/g, '');
  if (!/^[0-9]{6}$/.test(code)) return { ok: false, reason: 'invalid' };

  const current = totpStepAt(now);
  let sawReplay = false;
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = current + offset;
    if (!sameCode(codeAt(secret, step), code)) continue;
    if (lastUsedStep !== null && step <= lastUsedStep) {
      sawReplay = true;
      continue;
    }
    return { ok: true, step };
  }
  return { ok: false, reason: sawReplay ? 'replay' : 'invalid' };
}

export interface TotpSecret {
  bytes: Uint8Array;
  base32: string;
}

/** A fresh 160-bit secret, with the base32 form authenticator apps take. */
export function generateTotpSecret(): TotpSecret {
  const bytes = new Uint8Array(randomBytes(SECRET_BYTES));
  return { bytes, base32: encodeBase32UpperCaseNoPadding(bytes) };
}

export function decodeBase32Secret(base32: string): Uint8Array {
  return decodeBase32IgnorePadding(base32);
}

/** The `otpauth://` link that a QR code carries. */
export function buildOtpauthUri(input: {
  issuer: string;
  account: string;
  secretBase32: string;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
