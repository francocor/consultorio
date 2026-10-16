import { describe, expect, it } from 'vitest';

import {
  TOTP_STEP_SECONDS,
  buildOtpauthUri,
  codeAt,
  decodeBase32Secret,
  generateTotpSecret,
  totpStepAt,
  verifyTotp,
} from './totp.js';

// RFC 6238, appendix B: the SHA-1 secret is the ASCII text "12345678901234567890".
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('RFC 6238 test vectors (SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('at Unix time %i the code is %s', (seconds, expected) => {
    const step = totpStepAt(new Date(seconds * 1000));

    expect(codeAt(RFC_SECRET, step, 8)).toBe(expected);
  });

  it('counts 30-second steps from the Unix epoch', () => {
    expect(TOTP_STEP_SECONDS).toBe(30);
    expect(totpStepAt(new Date(0))).toBe(0);
    expect(totpStepAt(new Date(29_999))).toBe(0);
    expect(totpStepAt(new Date(30_000))).toBe(1);
    expect(totpStepAt(new Date(59_000))).toBe(1);
  });
});

describe('verifying a code', () => {
  const now = new Date(1111111111 * 1000);
  const step = totpStepAt(now);
  const six = (offset: number) => codeAt(RFC_SECRET, step + offset, 6);

  it('accepts the code of the current step and reports the step', () => {
    expect(verifyTotp(RFC_SECRET, six(0), now, null)).toEqual({ ok: true, step });
  });

  it('accepts one step of clock drift either way, and no more', () => {
    expect(verifyTotp(RFC_SECRET, six(-1), now, null)).toEqual({ ok: true, step: step - 1 });
    expect(verifyTotp(RFC_SECRET, six(1), now, null)).toEqual({ ok: true, step: step + 1 });
    expect(verifyTotp(RFC_SECRET, six(-2), now, null)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyTotp(RFC_SECRET, six(2), now, null)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a wrong code', () => {
    const wrong = six(0) === '000000' ? '000001' : '000000';

    expect(verifyTotp(RFC_SECRET, wrong, now, null)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('blocks replay: a step already used, or an earlier one, is refused', () => {
    expect(verifyTotp(RFC_SECRET, six(0), now, step)).toEqual({ ok: false, reason: 'replay' });
    expect(verifyTotp(RFC_SECRET, six(-1), now, step)).toEqual({ ok: false, reason: 'replay' });
    expect(verifyTotp(RFC_SECRET, six(0), now, step + 1)).toEqual({ ok: false, reason: 'replay' });
  });

  it('still accepts a later step after an earlier one was used', () => {
    expect(verifyTotp(RFC_SECRET, six(1), now, step)).toEqual({ ok: true, step: step + 1 });
    expect(verifyTotp(RFC_SECRET, six(0), now, step - 1)).toEqual({ ok: true, step });
  });

  it('ignores the spaces and hyphens authenticator apps show', () => {
    const code = six(0);
    const grouped = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(verifyTotp(RFC_SECRET, grouped, now, null)).toEqual({ ok: true, step });
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)}-${code.slice(3)}`, now, null).ok).toBe(true);
  });

  it.each(['', '12345', '1234567', 'abcdef', '12345a', '１２３４５６', '12 34'])(
    'rejects the malformed code %j',
    (code) => {
      expect(verifyTotp(RFC_SECRET, code, now, null)).toEqual({ ok: false, reason: 'invalid' });
    },
  );
});

describe('secrets and enrollment link', () => {
  it('generates 160-bit secrets, in base32, that never repeat', () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();

    expect(first.bytes).toHaveLength(20);
    expect(first.base32).toMatch(/^[A-Z2-7]{32}$/);
    expect(first.base32).not.toBe(second.base32);
    expect(decodeBase32Secret(first.base32)).toEqual(first.bytes);
  });

  it('builds the otpauth link authenticator apps scan', () => {
    const uri = buildOtpauthUri({
      issuer: 'Clínica Sur',
      account: 'ana@clinica-sur.example',
      secretBase32: 'JBSWY3DPEHPK3PXP',
    });

    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Clínica Sur:ana@clinica-sur.example');
    expect(url.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(url.searchParams.get('issuer')).toBe('Clínica Sur');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
  });
});
