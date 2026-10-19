import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { generateDevCertificate } from '../../../testing/dev-afip-certificate.js';

import { credentialState, parseCredential } from './credential.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const CUIT = '20123456786';
const DAY = 86_400_000;

const dev = (options: { cuit?: string; validDays?: number; ageDays?: number } = {}) =>
  generateDevCertificate({ cuit: options.cuit ?? CUIT, now: NOW, algorithm: 'ec', ...options });

describe('reading an uploaded credential', () => {
  it('accepts a certificate whose key matches and whose subject holds the CUIT', () => {
    const made = dev();

    const parsed = parseCredential({
      certificate: made.certificate,
      privateKey: made.privateKey,
      expectedCuit: CUIT,
      now: NOW,
    });

    expect(parsed).toMatchObject({
      ok: true,
      value: { subjectCuit: CUIT, notAfter: made.notAfter, notBefore: made.notBefore },
    });
    if (parsed.ok) expect(parsed.value.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads a certificate whose random serial number starts with a zero byte (JD-S4 R2, flaky key check)', () => {
    // A serial of 16 random bytes starts with 0x00 once in 256 and, with a low second byte, must be
    // written without its leading zero (DER is minimal): the certificate was unreadable now and then.
    for (const serial of [
      Buffer.from('00010203040506070809101112131415', 'hex'),
      Buffer.from('00000000000000000000000000000001', 'hex'),
      Buffer.from('0080000000000000000000000000000f', 'hex'),
    ]) {
      const made = generateDevCertificate({ cuit: CUIT, now: NOW, algorithm: 'ec', serial });

      expect(
        parseCredential({
          certificate: made.certificate,
          privateKey: made.privateKey,
          expectedCuit: CUIT,
          now: NOW,
        }),
      ).toMatchObject({ ok: true });
    }
  });

  it('gives the same fingerprint for the same certificate and another for another', () => {
    const one = dev();
    const other = dev();
    const read = (made: ReturnType<typeof dev>) =>
      parseCredential({
        certificate: made.certificate,
        privateKey: made.privateKey,
        expectedCuit: CUIT,
        now: NOW,
      });

    const first = read(one);
    const again = read(one);
    const second = read(other);

    expect(first).toEqual(again);
    expect(first.ok && second.ok && first.value.fingerprint !== second.value.fingerprint).toBe(
      true,
    );
  });

  it('refuses text that is not a certificate, without echoing it', () => {
    const made = dev();

    const parsed = parseCredential({
      certificate: 'not a certificate at all',
      privateKey: made.privateKey,
      expectedCuit: CUIT,
      now: NOW,
    });

    expect(parsed).toEqual({
      ok: false,
      error: { i18nKey: 'invoicing.credential.certificate_unreadable' },
    });
    expect(JSON.stringify(parsed)).not.toContain('not a certificate');
  });

  it('refuses a key that is not a key, and a key protected by a passphrase', () => {
    const made = dev();
    const protectedKey = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    }).privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' });

    for (const privateKey of ['nonsense', String(protectedKey)]) {
      expect(
        parseCredential({
          certificate: made.certificate,
          privateKey,
          expectedCuit: CUIT,
          now: NOW,
        }),
      ).toEqual({ ok: false, error: { i18nKey: 'invoicing.credential.key_unreadable' } });
    }
  });

  it('refuses a key that belongs to another certificate', () => {
    const made = dev();
    const other = dev();

    expect(
      parseCredential({
        certificate: made.certificate,
        privateKey: other.privateKey,
        expectedCuit: CUIT,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'invoicing.credential.key_mismatch' } });
  });

  it('refuses a certificate issued to another CUIT', () => {
    const made = dev({ cuit: '30712345671' });

    expect(
      parseCredential({
        certificate: made.certificate,
        privateKey: made.privateKey,
        expectedCuit: CUIT,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'invoicing.credential.cuit_mismatch' } });
  });

  it('refuses a certificate that already expired or is not valid yet', () => {
    const expired = dev({ validDays: 30, ageDays: 60 });
    const future = generateDevCertificate({
      cuit: CUIT,
      now: new Date(NOW.getTime() + 10 * DAY),
      algorithm: 'ec',
    });

    expect(
      parseCredential({
        certificate: expired.certificate,
        privateKey: expired.privateKey,
        expectedCuit: CUIT,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'invoicing.credential.expired' } });
    expect(
      parseCredential({
        certificate: future.certificate,
        privateKey: future.privateKey,
        expectedCuit: CUIT,
        now: NOW,
      }),
    ).toEqual({ ok: false, error: { i18nKey: 'invoicing.credential.not_yet_valid' } });
  });
});

describe('the state of a credential', () => {
  const base = {
    subjectCuit: CUIT,
    profileCuit: CUIT,
    notBefore: new Date(NOW.getTime() - 100 * DAY),
  };

  it.each([
    ['400 days left', 400 * DAY, 'valid'],
    ['31 days left', 31 * DAY, 'valid'],
    ['exactly 30 days left', 30 * DAY, 'expiring'],
    ['20 days left', 20 * DAY, 'expiring'],
    ['1 millisecond left', 1, 'expiring'],
    ['expires right now', 0, 'expired'],
    ['expired yesterday', -DAY, 'expired'],
  ] as const)('%s is %s', (_name, remaining, expected) => {
    expect(
      credentialState({ ...base, notAfter: new Date(NOW.getTime() + remaining), now: NOW }),
    ).toBe(expected);
  });

  it('is invalid when the CUIT of the profile is no longer the one of the certificate', () => {
    expect(
      credentialState({
        ...base,
        profileCuit: '30712345671',
        notAfter: new Date(NOW.getTime() + 200 * DAY),
        now: NOW,
      }),
    ).toBe('invalid');
  });

  it('is invalid when the certificate is not valid yet, and is invalid even when it is also old (the CUIT decides first)', () => {
    expect(
      credentialState({
        ...base,
        notBefore: new Date(NOW.getTime() + DAY),
        notAfter: new Date(NOW.getTime() + 200 * DAY),
        now: NOW,
      }),
    ).toBe('invalid');
    expect(
      credentialState({
        ...base,
        profileCuit: '30712345671',
        notAfter: new Date(NOW.getTime() - DAY),
        now: NOW,
      }),
    ).toBe('invalid');
  });
});
