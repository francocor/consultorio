import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

import { normalizeRecoveryKey } from './recovery-key.js';

/**
 * The cryptography of a backup. A backup holds the whole clinical record, so the file is encrypted AND
 * authenticated from the first byte of its payload to the last: nothing in it is read, extracted or restored
 * before every chunk has proved it was written by someone who holds the backup key.
 *
 * - The **backup key** is 32 random bytes made once per install. It lives in `config.json` (encrypted by the
 *   Windows account), so the daily backup needs nobody to type anything.
 * - The header of every backup carries that key **wrapped** by the recovery key (scrypt + AES-256-GCM), so a
 *   backup can be opened on another PC by whoever has the recovery key, and by nobody else.
 * - Each backup has its own key (HKDF of the backup key and a random salt in the header), so the counter
 *   that numbers its chunks can never repeat a nonce under the same key.
 * - Every chunk is AES-256-GCM. What it authenticates besides its bytes: the header (so the date, the version
 *   and the wrapped key cannot be edited), its position, and whether it is the last (so a backup cut short, or
 *   chunks dropped or reordered, are refused).
 */

export const MAGIC = Buffer.from('CVB2');
export const FORMAT = 2;
export const MAX_HEADER_BYTES = 64 * 1024;
export const CHUNK_BYTES = 1024 * 1024;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
let scryptCost = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

/**
 * The tests derive hundreds of keys, and the real cost (about a tenth of a second and 32 MiB each) makes
 * them crawl on a busy PC. They call this once; the program never does.
 */
export function useCheapKeyDerivationInTests(): void {
  scryptCost = { N: 1 << 8, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
}

export type BackupKind = 'daily' | 'manual' | 'safety' | 'upgrade';

/** The recovery key wrapping the backup key. Safe to store anywhere: it opens only with the recovery key. */
export interface KeyWrap {
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/** What the header of a backup says. The header is in the clear, and authenticated by every chunk. */
export interface BackupHeader {
  format: number;
  createdAt: string;
  appVersion: string;
  /** How many migrations the database had: a newer backup cannot be restored by an older program. */
  migrationCount: number;
  kind: BackupKind;
  /** Which backup key made it: the same install, or another one that needs the recovery key. */
  keyId: string;
  fileSalt: string;
  wrap: KeyWrap;
}

export class BackupCryptoError extends Error {
  constructor(
    readonly code: 'wrong_key' | 'tampered' | 'truncated' | 'invalid_header' | 'too_large',
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'BackupCryptoError';
  }
}

export function newBackupKey(random: (size: number) => Buffer = randomBytes): Buffer {
  return random(KEY_BYTES);
}

/** A short public name of a backup key, to tell whose backup a file is. It reveals nothing about the key. */
export function keyIdOf(backupKey: Buffer): string {
  return createHash('sha256')
    .update('consulvia-backup-key-id:')
    .update(backupKey)
    .digest('hex')
    .slice(0, 16);
}

function wrapKeyFor(recoveryKey: string, salt: Buffer): Buffer {
  return scryptSync(normalizeRecoveryKey(recoveryKey), salt, KEY_BYTES, scryptCost);
}

export function wrapBackupKey(backupKey: Buffer, recoveryKey: string): KeyWrap {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrapKeyFor(recoveryKey, salt), iv);
  cipher.setAAD(Buffer.from('consulvia-backup-key-wrap'));
  const data = Buffer.concat([cipher.update(backupKey), cipher.final()]);
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** The backup key a wrap holds, or a `wrong_key` error when the recovery key is not the one that wrapped it. */
export function unwrapBackupKey(wrap: KeyWrap, recoveryKey: string): Buffer {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      wrapKeyFor(recoveryKey, Buffer.from(wrap.salt, 'base64')),
      Buffer.from(wrap.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from('consulvia-backup-key-wrap'));
    decipher.setAuthTag(Buffer.from(wrap.tag, 'base64'));
    const key = Buffer.concat([
      decipher.update(Buffer.from(wrap.data, 'base64')),
      decipher.final(),
    ]);
    if (key.length !== KEY_BYTES) throw new Error('bad length');
    return key;
  } catch {
    throw new BackupCryptoError('wrong_key');
  }
}

/** What is stored to check, later, that someone typed the right recovery key: a scrypt hash, not the key. */
export function hashRecoveryKey(recoveryKey: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(normalizeRecoveryKey(recoveryKey), salt, 32, scryptCost);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyRecoveryKey(recoveryKey: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64');
  const given = scryptSync(
    normalizeRecoveryKey(recoveryKey),
    Buffer.from(salt, 'base64'),
    expected.length,
    scryptCost,
  );
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function fileKey(backupKey: Buffer, fileSalt: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', backupKey, fileSalt, 'consulvia/backup/file-key/v2', KEY_BYTES),
  );
}

function chunkNonce(index: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
}

function chunkAad(headerDigest: Buffer, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(9);
  tail.writeBigUInt64BE(BigInt(index), 0);
  tail.writeUInt8(final ? 1 : 0, 8);
  return Buffer.concat([headerDigest, tail]);
}

/** The bytes at the start of a backup file: the magic, the length of the header and the header. */
export function encodeHeader(header: BackupHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  if (json.length > MAX_HEADER_BYTES) throw new BackupCryptoError('invalid_header');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json]);
}

/** Reads a header from the start of `bytes` (at least the first 8 + header bytes of the file). */
export function decodeHeader(bytes: Buffer): {
  header: BackupHeader;
  headerBytes: Buffer;
  bodyOffset: number;
} {
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(MAGIC)) {
    throw new BackupCryptoError('invalid_header', 'not a Consulvia backup');
  }
  const length = bytes.readUInt32BE(4);
  if (length > MAX_HEADER_BYTES) throw new BackupCryptoError('invalid_header', 'header too large');
  if (bytes.length < 8 + length) throw new BackupCryptoError('truncated');
  const headerBytes = bytes.subarray(8, 8 + length);
  let parsed: Partial<BackupHeader>;
  try {
    parsed = JSON.parse(headerBytes.toString('utf8')) as Partial<BackupHeader>;
  } catch {
    throw new BackupCryptoError('invalid_header');
  }
  const wrap = parsed.wrap;
  if (
    parsed.format !== FORMAT ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.appVersion !== 'string' ||
    typeof parsed.migrationCount !== 'number' ||
    typeof parsed.kind !== 'string' ||
    typeof parsed.keyId !== 'string' ||
    typeof parsed.fileSalt !== 'string' ||
    typeof wrap?.salt !== 'string' ||
    typeof wrap.iv !== 'string' ||
    typeof wrap.tag !== 'string' ||
    typeof wrap.data !== 'string'
  ) {
    throw new BackupCryptoError('invalid_header');
  }
  return {
    header: parsed as BackupHeader,
    headerBytes: Buffer.from(headerBytes),
    bodyOffset: 8 + length,
  };
}

/** Cuts the payload into chunks and seals each one. The header goes out first. */
export class ChunkEncryptor extends Transform {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private index = 0;
  private readonly key: Buffer;
  private readonly digest: Buffer;

  constructor(
    backupKey: Buffer,
    private readonly header: BackupHeader,
    private readonly chunkBytes = CHUNK_BYTES,
  ) {
    super();
    this.key = fileKey(backupKey, Buffer.from(header.fileSalt, 'base64'));
    const encoded = encodeHeader(header);
    this.digest = createHash('sha256').update(encoded.subarray(8)).digest();
    this.push(encoded);
  }

  private seal(plain: Buffer, final: boolean): void {
    const cipher = createCipheriv('aes-256-gcm', this.key, chunkNonce(this.index));
    cipher.setAAD(chunkAad(this.digest, this.index, final));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    const frame = Buffer.alloc(5);
    frame.writeUInt8(final ? 1 : 0, 0);
    frame.writeUInt32BE(data.length, 1);
    this.push(Buffer.concat([frame, data, cipher.getAuthTag()]));
    this.index += 1;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    while (this.pendingBytes > this.chunkBytes) {
      const all = Buffer.concat(this.pending);
      this.seal(all.subarray(0, this.chunkBytes), false);
      const rest = all.subarray(this.chunkBytes);
      this.pending = rest.length > 0 ? [rest] : [];
      this.pendingBytes = rest.length;
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.seal(Buffer.concat(this.pending), true);
    callback();
  }
}

/**
 * Opens the chunks that follow a header. It emits the plaintext of a chunk only after the chunk
 * authenticated, fails with `tampered` on the first one that does not, and with `truncated` when the
 * stream ends before the last chunk.
 */
export class ChunkDecryptor extends Transform {
  private buffer = Buffer.alloc(0);
  private index = 0;
  private finished = false;
  private readonly key: Buffer;
  private readonly digest: Buffer;

  constructor(backupKey: Buffer, header: BackupHeader, headerBytes: Buffer) {
    super();
    this.key = fileKey(backupKey, Buffer.from(header.fileSalt, 'base64'));
    this.digest = createHash('sha256').update(headerBytes).digest();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        if (this.finished) {
          if (this.buffer.length > 0)
            throw new BackupCryptoError('tampered', 'data after the last chunk');
          break;
        }
        if (this.buffer.length < 5) break;
        const flag = this.buffer.readUInt8(0);
        const length = this.buffer.readUInt32BE(1);
        if ((flag !== 0 && flag !== 1) || length > CHUNK_BYTES)
          throw new BackupCryptoError('tampered');
        const total = 5 + length + TAG_BYTES;
        if (this.buffer.length < total) break;
        const data = this.buffer.subarray(5, 5 + length);
        const tag = this.buffer.subarray(5 + length, total);
        const decipher = createDecipheriv('aes-256-gcm', this.key, chunkNonce(this.index));
        decipher.setAAD(chunkAad(this.digest, this.index, flag === 1));
        decipher.setAuthTag(tag);
        let plain: Buffer;
        try {
          plain = Buffer.concat([decipher.update(data), decipher.final()]);
        } catch {
          throw new BackupCryptoError('tampered');
        }
        this.buffer = this.buffer.subarray(total);
        this.index += 1;
        if (flag === 1) this.finished = true;
        if (plain.length > 0) this.push(plain);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback): void {
    if (!this.finished) callback(new BackupCryptoError('truncated'));
    else callback();
  }
}
