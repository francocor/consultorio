import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * Makes a self-signed X.509 certificate and its private key for LOCAL development and tests of the
 * AFIP credential flow (`pnpm dev:afip-cert`). Node has no certificate writer, so the DER is built
 * here: a v3 certificate with the subject AFIP puts in its own (`serialNumber=CUIT <digits>`) and
 * no extensions. The subject says "DEV ONLY" so a development certificate is never mistaken for one
 * issued by the tax authority, and AFIP itself would never accept it.
 *
 * Nothing here is secret-bearing in a way that matters: the key is generated fresh for each call
 * and the files are for a developer's machine. Never commit its output.
 */

export interface DevCertificateOptions {
  /** CUIT the certificate is issued to: 11 digits. */
  cuit: string;
  /** Organization name written in the subject. */
  organization?: string;
  /** The moment the certificate is made; its validity starts `ageDays` before it. */
  now?: Date;
  /** How long it stays valid. Defaults to 365 days. */
  validDays?: number;
  /** How old the certificate is already, to test one that is about to expire. Defaults to 0. */
  ageDays?: number;
  /** `rsa` (2048 bits, like AFIP's) or `ec` (P-256, much faster, for tests). Defaults to `rsa`. */
  algorithm?: 'rsa' | 'ec';
  /** The serial number as bytes, to test an edge of its encoding. Defaults to 16 random bytes. */
  serial?: Buffer;
}

export interface DevCertificate {
  /** PEM, `-----BEGIN CERTIFICATE-----`. */
  certificate: string;
  /** PEM, PKCS#8, not protected by a passphrase. */
  privateKey: string;
  notBefore: Date;
  notAfter: Date;
}

const DAY_MS = 86_400_000;

// ASN.1 / DER ------------------------------------------------------------------------------------

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes: number[] = [first * 40 + second];
  for (const part of rest) {
    const chunk: number[] = [part % 128];
    for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) {
      chunk.unshift((value % 128) | 0x80);
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function integer(bytes: Buffer): Buffer {
  // DER integers are minimal: leading zero bytes are dropped (one byte stays), and then a leading
  // zero is added back only when the high bit would read as a sign. A serial that began with a zero
  // byte used to be written as it was, and the parser refused that certificate now and then.
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const minimal = bytes.subarray(start);
  const padded = (minimal[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal;
  return tlv(0x02, padded);
}

const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const printable = (text: string) => tlv(0x13, Buffer.from(text, 'ascii'));

function time(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-10-17T12:00:00.000Z
  const digits = iso.replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const year = date.getUTCFullYear();
  // RFC 5280: UTCTime until 2049, GeneralizedTime from 2050.
  return year < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}

function attribute(type: string, value: Buffer): Buffer {
  return set(sequence(oid(type), value));
}

const OID = {
  country: '2.5.4.6',
  organization: '2.5.4.10',
  commonName: '2.5.4.3',
  serialNumber: '2.5.4.5',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
} as const;

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** Makes a certificate and key for a CUIT. Throws if the CUIT is not eleven digits. */
export function generateDevCertificate(options: DevCertificateOptions): DevCertificate {
  if (!/^\d{11}$/.test(options.cuit)) {
    throw new Error('The CUIT of the development certificate must be 11 digits.');
  }
  // A certificate keeps whole seconds: the dates returned are the ones it carries.
  const now = new Date(Math.floor((options.now ?? new Date()).getTime() / 1000) * 1000);
  const notBefore = new Date(now.getTime() - (options.ageDays ?? 0) * DAY_MS);
  const notAfter = new Date(notBefore.getTime() + (options.validDays ?? 365) * DAY_MS);
  const algorithm = options.algorithm ?? 'rsa';

  const keys =
    algorithm === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });

  const name = sequence(
    attribute(OID.country, printable('AR')),
    attribute(OID.organization, utf8(options.organization ?? 'DEV ONLY - not issued by AFIP')),
    attribute(OID.commonName, utf8('DEV ONLY dev-afip-cert')),
    attribute(OID.serialNumber, printable(`CUIT ${options.cuit}`)),
  );
  const signatureAlgorithm =
    algorithm === 'rsa'
      ? sequence(oid(OID.sha256WithRsa), tlv(0x05))
      : sequence(oid(OID.ecdsaWithSha256));

  const toBeSigned = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // version 3
    integer(options.serial ?? randomBytes(16)),
    signatureAlgorithm,
    name, // issuer: self-signed
    sequence(time(notBefore), time(notAfter)),
    name, // subject
    Buffer.from(keys.publicKey.export({ type: 'spki', format: 'der' })),
  );

  const signer = createSign('sha256');
  signer.update(toBeSigned);
  const signature = signer.sign(keys.privateKey);
  const certificate = sequence(
    toBeSigned,
    signatureAlgorithm,
    tlv(0x03, Buffer.from([0]), signature),
  );

  return {
    certificate: pem('CERTIFICATE', certificate),
    privateKey: String(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    notBefore,
    notAfter,
  };
}
