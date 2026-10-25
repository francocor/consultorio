import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { normalizeRecoveryKey } from './secrets.js';

/**
 * What a backup needs to be readable on another PC. The database dump holds the clinical data encrypted
 * with `KMS_LOCAL_KEK_BASE64`, and that key lives only in `config.json`, locked to one Windows account. So
 * every backup carries these values sealed with the recovery key that the owner was shown at the first
 * run. Without the key the backup is useless to whoever finds it.
 */
export interface RecoveryPayload {
  slug: string;
  kmsLocalKekBase64: string;
  addressHashPepper: string;
  storageUploadSecret: string;
}

export type RecoveryErrorCode = 'wrong_key' | 'corrupt';

export class RecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode) {
    super(code);
    this.name = 'RecoveryError';
  }
}

interface SealedDocument {
  version: 1;
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const KEY_BYTES = 32;
// 2^15 blocks of 8: about 32 MiB and a tenth of a second. A backup is sealed once a day.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

function deriveKey(recoveryKey: string, salt: Buffer): Buffer {
  return scryptSync(normalizeRecoveryKey(recoveryKey), salt, KEY_BYTES, SCRYPT);
}

/** The sealed document as text, ready for a file in the backup. */
export function sealRecovery(payload: RecoveryPayload, recoveryKey: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(recoveryKey, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const document: SealedDocument = {
    version: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

function parseDocument(text: string): SealedDocument {
  try {
    const value = JSON.parse(text) as Partial<SealedDocument>;
    if (
      value.version !== 1 ||
      value.kdf !== 'scrypt' ||
      typeof value.salt !== 'string' ||
      typeof value.iv !== 'string' ||
      typeof value.tag !== 'string' ||
      typeof value.data !== 'string'
    ) {
      throw new RecoveryError('corrupt');
    }
    return value as SealedDocument;
  } catch (error) {
    throw error instanceof RecoveryError ? error : new RecoveryError('corrupt');
  }
}

/** Opens a sealed document. A wrong key and a damaged file are told apart: the first can be retried. */
export function openRecovery(text: string, recoveryKey: string): RecoveryPayload {
  const document = parseDocument(text);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveKey(recoveryKey, Buffer.from(document.salt, 'base64')),
    Buffer.from(document.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(document.tag, 'base64'));
  let plain: string;
  try {
    plain = Buffer.concat([
      decipher.update(Buffer.from(document.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new RecoveryError('wrong_key');
  }
  try {
    const payload = JSON.parse(plain) as Partial<RecoveryPayload>;
    if (
      typeof payload.slug !== 'string' ||
      typeof payload.kmsLocalKekBase64 !== 'string' ||
      typeof payload.addressHashPepper !== 'string' ||
      typeof payload.storageUploadSecret !== 'string'
    ) {
      throw new RecoveryError('corrupt');
    }
    return payload as RecoveryPayload;
  } catch (error) {
    throw error instanceof RecoveryError ? error : new RecoveryError('corrupt');
  }
}
