import { X509Certificate, createPrivateKey } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { generateDevCertificate } from './dev-afip-certificate.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');

describe('the development certificate generator', () => {
  it('makes a self-signed X.509 certificate whose key matches, valid for the days asked', () => {
    const made = generateDevCertificate({ cuit: '20123456786', now: NOW, validDays: 365 });

    const certificate = new X509Certificate(made.certificate);
    expect(certificate.checkPrivateKey(createPrivateKey(made.privateKey))).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(made.notBefore).toEqual(NOW);
    expect(made.notAfter).toEqual(new Date('2027-10-17T12:00:00.000Z'));
    expect(new Date(certificate.validFrom).getTime()).toBe(NOW.getTime());
    expect(new Date(certificate.validTo).getTime()).toBe(made.notAfter.getTime());
  });

  it('puts the CUIT in the subject and says in plain words that it is only for development', () => {
    const made = generateDevCertificate({ cuit: '30712345671', now: NOW });

    const { subject } = new X509Certificate(made.certificate);
    expect(subject).toContain('CUIT 30712345671');
    expect(subject).toMatch(/DEV ONLY/);
    expect(subject).toMatch(/C=AR/);
  });

  it('can make a certificate that is already inside its last 20 days (a window in the past)', () => {
    const made = generateDevCertificate({
      cuit: '20123456786',
      now: NOW,
      validDays: 365,
      ageDays: 345,
    });

    expect(made.notBefore).toEqual(new Date('2025-11-06T12:00:00.000Z'));
    expect(made.notAfter).toEqual(new Date('2026-11-06T12:00:00.000Z'));
  });

  it('makes a different key every time, and supports an elliptic curve key for quick tests', () => {
    const first = generateDevCertificate({ cuit: '20123456786', now: NOW, algorithm: 'ec' });
    const second = generateDevCertificate({ cuit: '20123456786', now: NOW, algorithm: 'ec' });

    expect(first.privateKey).not.toBe(second.privateKey);
    const certificate = new X509Certificate(first.certificate);
    expect(certificate.publicKey.asymmetricKeyType).toBe('ec');
    expect(certificate.checkPrivateKey(createPrivateKey(first.privateKey))).toBe(true);
  });

  it('refuses a CUIT that is not eleven digits', () => {
    expect(() => generateDevCertificate({ cuit: '123', now: NOW })).toThrow(/CUIT/);
  });
});
