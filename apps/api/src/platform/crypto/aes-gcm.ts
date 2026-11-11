import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Format byte at the start of every blob. Bump it if the layout below ever changes. */
export const FORMAT_VERSION = 1;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** format (1) + key version (2) */
const HEADER_BYTES = 3;

/**
 * What a ciphertext is bound to. It is authenticated but not stored: decrypting with a different
 * tenant, table, column or row fails, so a blob copied into another row, column or tenant is
 * useless to whoever copied it.
 */
export interface Aad {
  tenantId: string;
  table: string;
  column: string;
  rowId: string;
}

/** Raised for any failure to decrypt. The message never carries data, keys or identifiers. */
export class DecryptionError extends Error {
  constructor() {
    super('Unable to decrypt the value');
    this.name = 'DecryptionError';
  }
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${String(KEY_BYTES)} bytes`);
  }
}

function aadBytes(aad: Aad): Buffer {
  // A JSON array is unambiguous: no field can bleed into its neighbour.
  return Buffer.from(JSON.stringify(['v1', aad.tenantId, aad.table, aad.column, aad.rowId]));
}

/**
 * Encrypts with AES-256-GCM and a fresh random 96-bit nonce.
 *
 * Layout: `[format:1][keyVersion:2 BE][nonce:12][ciphertext][tag:16]`. The header is authenticated
 * together with the AAD, so neither the key version nor the format can be altered unnoticed.
 *
 * A random 96-bit nonce is safe for up to about 2^32 messages per key; the per-tenant key is
 * rotated (new `keyVersion`) long before a tenant gets near that.
 */
export function encrypt(key: Buffer, plaintext: Buffer | string, aad: Aad, keyVersion = 1): Buffer {
  assertKey(key);
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = FORMAT_VERSION;
  header.writeUInt16BE(keyVersion, 1);
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([header, aadBytes(aad)]));
  const body = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final(),
  ]);
  return Buffer.concat([header, nonce, body, cipher.getAuthTag()]);
}

/** The key version a blob was encrypted with, so the right data key can be chosen to decrypt it. */
export function readKeyVersion(blob: Buffer): number {
  if (blob.length < HEADER_BYTES || blob[0] !== FORMAT_VERSION) throw new DecryptionError();
  return blob.readUInt16BE(1);
}

/** Decrypts a blob made by `encrypt`. Throws `DecryptionError` for ANY failure. */
export function decrypt(key: Buffer, blob: Buffer, aad: Aad): Buffer {
  assertKey(key);
  if (blob.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES || blob[0] !== FORMAT_VERSION) {
    throw new DecryptionError();
  }
  const header = blob.subarray(0, HEADER_BYTES);
  const nonce = blob.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const body = blob.subarray(HEADER_BYTES + NONCE_BYTES, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.concat([header, aadBytes(aad)]));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}
