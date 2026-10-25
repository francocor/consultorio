import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { describe, expect, it } from 'vitest';

import {
  BackupCryptoError,
  ChunkDecryptor,
  ChunkEncryptor,
  decodeHeader,
  encodeHeader,
  hashRecoveryKey,
  keyIdOf,
  newBackupKey,
  unwrapBackupKey,
  verifyRecoveryKey,
  wrapBackupKey,
  type BackupHeader,
} from './backup-crypto.js';
import { generateRecoveryKey } from './recovery-key.js';

const recoveryKey = generateRecoveryKey();

function headerFor(backupKey: Buffer): BackupHeader {
  return {
    format: 2,
    createdAt: '2026-10-25T12:00:00.000Z',
    appVersion: '0.1.0',
    migrationCount: 80,
    kind: 'manual',
    keyId: keyIdOf(backupKey),
    fileSalt: randomBytes(32).toString('base64'),
    wrap: wrapBackupKey(backupKey, recoveryKey),
  };
}

async function collect(stream: Readable | ChunkDecryptor | ChunkEncryptor): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** The bytes of a sealed payload, header included. */
async function seal(backupKey: Buffer, header: BackupHeader, payload: Buffer, chunkBytes: number) {
  const encryptor = new ChunkEncryptor(backupKey, header, chunkBytes);
  const sealed: Buffer[] = [];
  encryptor.on('data', (part: Buffer) => sealed.push(part));
  await pipeline(Readable.from([payload]), encryptor);
  return Buffer.concat(sealed);
}

async function open(sealed: Buffer, backupKey: Buffer): Promise<Buffer> {
  const { header, headerBytes, bodyOffset } = decodeHeader(sealed);
  const decryptor = new ChunkDecryptor(backupKey, header, headerBytes);
  const reading = collect(decryptor);
  decryptor.end(sealed.subarray(bodyOffset));
  return reading;
}

const rejectsWith = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BackupCryptoError);
  expect((error as BackupCryptoError).code).toBe(code);
};

describe('the backup key and the recovery key', () => {
  it('wraps the backup key so only the recovery key unwraps it, however it is typed', () => {
    const key = newBackupKey();
    const wrap = wrapBackupKey(key, recoveryKey);

    expect(unwrapBackupKey(wrap, recoveryKey).equals(key)).toBe(true);
    expect(unwrapBackupKey(wrap, recoveryKey.toLowerCase().replaceAll('-', ' ')).equals(key)).toBe(
      true,
    );
    expect(wrap.data).not.toContain(key.toString('base64'));
  });

  it('says the recovery key is wrong, for another key and for a damaged wrap', () => {
    const wrap = wrapBackupKey(newBackupKey(), recoveryKey);

    expect(() => unwrapBackupKey(wrap, generateRecoveryKey())).toThrow(BackupCryptoError);
    expect(() =>
      unwrapBackupKey({ ...wrap, tag: Buffer.alloc(16).toString('base64') }, recoveryKey),
    ).toThrow(BackupCryptoError);
  });

  it('wraps differently every time', () => {
    const key = newBackupKey();

    expect(wrapBackupKey(key, recoveryKey).data).not.toBe(wrapBackupKey(key, recoveryKey).data);
  });

  it('names a key without revealing it', () => {
    const key = newBackupKey();

    expect(keyIdOf(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdOf(key)).toBe(keyIdOf(Buffer.from(key)));
    expect(keyIdOf(key)).not.toBe(keyIdOf(newBackupKey()));
    expect(key.toString('hex')).not.toContain(keyIdOf(key));
  });

  it('stores a hash of the recovery key that checks what is typed and is not the key', () => {
    const stored = hashRecoveryKey(recoveryKey);

    expect(verifyRecoveryKey(recoveryKey, stored)).toBe(true);
    expect(verifyRecoveryKey(recoveryKey.toLowerCase().replaceAll('-', ''), stored)).toBe(true);
    expect(verifyRecoveryKey(generateRecoveryKey(), stored)).toBe(false);
    expect(verifyRecoveryKey(recoveryKey, 'not a hash')).toBe(false);
    expect(stored).not.toContain(recoveryKey.replaceAll('-', ''));
  });
});

describe('the header of a backup', () => {
  it('round-trips', () => {
    const header = headerFor(newBackupKey());

    const decoded = decodeHeader(encodeHeader(header));

    expect(decoded.header).toEqual(header);
    expect(decoded.bodyOffset).toBe(encodeHeader(header).length);
  });

  it('refuses what is not a header: other files, other versions, missing fields, a huge length', () => {
    const header = headerFor(newBackupKey());
    const good = encodeHeader(header);
    const bigLength = Buffer.from(good);
    bigLength.writeUInt32BE(10 * 1024 * 1024, 4);

    for (const bad of [
      Buffer.from('PK\u0003\u0004 this is a zip'),
      Buffer.from('CVB2'),
      bigLength,
      encodeHeader({ ...header, format: 1 }),
      Buffer.concat([Buffer.from('CVB2'), Buffer.from([0, 0, 0, 2]), Buffer.from('{}')]),
    ]) {
      expect(() => decodeHeader(bad)).toThrow(BackupCryptoError);
    }
  });
});

describe('the sealed chunks', () => {
  const key = newBackupKey();

  it('round-trip a payload of many chunks, and one that is empty', async () => {
    const payload = randomBytes(10_000);

    expect((await open(await seal(key, headerFor(key), payload, 1024), key)).equals(payload)).toBe(
      true,
    );
    expect((await open(await seal(key, headerFor(key), Buffer.alloc(0), 1024), key)).length).toBe(
      0,
    );
  });

  it('do not show the payload', async () => {
    const payload = Buffer.from('historia clínica de María Luisa Pérez '.repeat(100));

    const sealed = await seal(key, headerFor(key), payload, 1024);

    expect(sealed.includes(Buffer.from('María Luisa'))).toBe(false);
  });

  it('refuse another key', async () => {
    const sealed = await seal(key, headerFor(key), randomBytes(5000), 1024);

    await rejectsWith(open(sealed, newBackupKey()), 'tampered');
  });

  it('refuse any changed byte of the body, and any changed byte of the header', async () => {
    const header = headerFor(key);
    const sealed = await seal(key, header, randomBytes(5000), 1024);
    const bodyOffset = decodeHeader(sealed).bodyOffset;

    for (const position of [bodyOffset + 10, bodyOffset + 700, sealed.length - 3, bodyOffset]) {
      const damaged = Buffer.from(sealed);
      damaged[position] = (damaged[position] ?? 0) ^ 0x01;
      await rejectsWith(open(damaged, key), 'tampered');
    }
    // The header is in the clear but authenticated: another date or another wrapped key is refused.
    const edited = Buffer.from(sealed);
    const at = edited.indexOf(Buffer.from('2026-10-25'));
    edited[at + 9] = '6'.charCodeAt(0);
    await rejectsWith(open(edited, key), 'tampered');
  });

  it('refuse a backup that was cut short, at a chunk boundary or inside one', async () => {
    const sealed = await seal(key, headerFor(key), randomBytes(5000), 1024);

    await rejectsWith(open(sealed.subarray(0, sealed.length - 20), key), 'truncated');
    // Dropping the last chunk entirely leaves only chunks marked "not last".
    const lastFrame = 5 + 5000 - 4 * 1024 + 16;
    await rejectsWith(open(sealed.subarray(0, sealed.length - lastFrame), key), 'truncated');
  });

  it('refuse chunks that were swapped or repeated', async () => {
    const header = headerFor(key);
    const sealed = await seal(key, header, randomBytes(3000), 1024);
    const body = decodeHeader(sealed).bodyOffset;
    const frame = 5 + 1024 + 16;
    const swapped = Buffer.concat([
      sealed.subarray(0, body),
      sealed.subarray(body + frame, body + 2 * frame),
      sealed.subarray(body, body + frame),
      sealed.subarray(body + 2 * frame),
    ]);

    await rejectsWith(open(swapped, key), 'tampered');
  });

  it('refuse data after the last chunk', async () => {
    const sealed = await seal(key, headerFor(key), randomBytes(100), 1024);

    await rejectsWith(open(Buffer.concat([sealed, Buffer.from('extra')]), key), 'tampered');
  });

  it('never use a nonce twice under one key: two backups of the same data differ', async () => {
    const payload = randomBytes(100);
    const first = await seal(key, headerFor(key), payload, 1024);
    const second = await seal(key, headerFor(key), payload, 1024);

    expect(first.equals(second)).toBe(false);
  });
});
