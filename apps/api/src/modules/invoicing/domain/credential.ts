import { X509Certificate, createPrivateKey } from 'node:crypto';

import { fail, ok, type CredentialState, type Result } from '@consultorio/contracts';

/**
 * Reading and judging the certificate an organization uploads for the tax authority
 * (e-invoicing-afip, "Fiscal credentials lifecycle"). Pure: Node's `crypto` and the clock that is
 * passed in, no database. Nothing in a result or an error carries the certificate or the key; the
 * failures are translation keys.
 */

/** From this many days before it expires a certificate is `expiring`, and the owner is warned. */
export const EXPIRY_WARNING_DAYS = 30;

const DAY_MS = 86_400_000;

export interface ParsedCredential {
  /** Normalized PEM of the certificate. Secret-bearing: only ever encrypted or compared. */
  certificatePem: string;
  /** PKCS#8 PEM of the private key. Secret: only ever encrypted. */
  privateKeyPem: string;
  notBefore: Date;
  notAfter: Date;
  /** The CUIT of the subject: the expected one, which the subject contains. */
  subjectCuit: string;
  /** SHA-256 of the DER form of the certificate, hex. Identifies it without revealing it. */
  fingerprint: string;
}

export interface ParseCredentialInput {
  certificate: string;
  privateKey: string;
  /** The CUIT of the fiscal profile: the subject of the certificate must hold it. */
  expectedCuit: string;
  now: Date;
}

/** A CUIT written in the subject, labelled (`CUIT 20123456786`) or as an 11 digit run. */
function cuitsInSubject(subject: string): string[] {
  return [...subject.matchAll(/(?<!\d)\d{11}(?!\d)/g)].map((match) => match[0]);
}

function readCertificate(text: string): X509Certificate | null {
  try {
    return new X509Certificate(text);
  } catch {
    return null;
  }
}

function readKey(text: string) {
  try {
    return createPrivateKey(text);
  } catch {
    // A passphrase protected key lands here too: we never ask for the passphrase.
    return null;
  }
}

/**
 * Checks an upload the way the specification asks: the text is a certificate, the key is a key and
 * matches it, the CUIT of the organization is in the subject, and the certificate is valid now.
 */
export function parseCredential(input: ParseCredentialInput): Result<ParsedCredential> {
  const certificate = readCertificate(input.certificate);
  if (!certificate) return fail('invoicing.credential.certificate_unreadable');

  const key = readKey(input.privateKey);
  if (!key) return fail('invoicing.credential.key_unreadable');
  if (!certificate.checkPrivateKey(key)) return fail('invoicing.credential.key_mismatch');

  if (!cuitsInSubject(certificate.subject).includes(input.expectedCuit)) {
    return fail('invoicing.credential.cuit_mismatch');
  }

  const notBefore = new Date(certificate.validFrom);
  const notAfter = new Date(certificate.validTo);
  if (notAfter.getTime() <= input.now.getTime()) return fail('invoicing.credential.expired');
  if (notBefore.getTime() > input.now.getTime()) return fail('invoicing.credential.not_yet_valid');

  return ok({
    certificatePem: certificate.toString(),
    privateKeyPem: String(key.export({ type: 'pkcs8', format: 'pem' })),
    notBefore,
    notAfter,
    subjectCuit: input.expectedCuit,
    fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
  });
}

export interface CredentialStateInput {
  notBefore: Date;
  notAfter: Date;
  subjectCuit: string;
  /** The CUIT of the fiscal profile today. */
  profileCuit: string;
  now: Date;
}

/**
 * `invalid` when the certificate is not for the CUIT of the profile (it was changed after the
 * upload) or is not valid yet; `expired` from the instant it ends; `expiring` in its last
 * {@link EXPIRY_WARNING_DAYS} days (the day counted); `valid` otherwise.
 */
export function credentialState(input: CredentialStateInput): CredentialState {
  const now = input.now.getTime();
  if (input.subjectCuit !== input.profileCuit || input.notBefore.getTime() > now) return 'invalid';
  const remaining = input.notAfter.getTime() - now;
  if (remaining <= 0) return 'expired';
  return remaining <= EXPIRY_WARNING_DAYS * DAY_MS ? 'expiring' : 'valid';
}
