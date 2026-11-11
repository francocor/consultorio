import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createArchiveWriter,
  discard,
  readArchive,
  readArchiveHeader,
  type ArchiveLimits,
} from './backup-archive.js';
import {
  BackupCryptoError,
  keyIdOf,
  newBackupKey,
  wrapBackupKey,
  type BackupHeader,
} from './backup-crypto.js';
import { generateRecoveryKey } from './recovery-key.js';

let folder: string;
const key = newBackupKey();

function header(): BackupHeader {
  return {
    format: 2,
    createdAt: '2026-10-25T12:00:00.000Z',
    appVersion: '0.1.0',
    migrationCount: 80,
    kind: 'manual',
    keyId: keyIdOf(key),
    fileSalt: randomBytes(32).toString('base64'),
    wrap: wrapBackupKey(key, generateRecoveryKey()),
  };
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-archive-'));
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

async function readAll(file: string, limits?: ArchiveLimits) {
  const entries = new Map<string, Buffer>();
  await readArchive(
    file,
    key,
    async (entry) => {
      const parts: Buffer[] = [];
      for await (const part of entry.data) parts.push(part);
      entries.set(entry.name, Buffer.concat(parts));
    },
    limits ? { limits } : {},
  );
  return entries;
}

async function build(target: string, chunkBytes = 4096) {
  const big = randomBytes(3 * 1024 * 1024 + 123);
  writeFileSync(join(folder, 'big.bin'), big);
  const writer = createArchiveWriter(target, key, header(), { chunkBytes });
  await writer.addBuffer('meta.json', '{"hola":"mundo ñ"}');
  await writer.addFile('files/t/Historia clínica.obj', join(folder, 'big.bin'));
  const streamed = await writer.addStream(
    'db.dump',
    Readable.from([Buffer.from('PGDMP'), Buffer.from('-bytes')]),
  );
  await writer.addBuffer('empty', Buffer.alloc(0));
  await writer.finish();
  return { big, streamed };
}

describe('writing and reading a backup', () => {
  it('round-trips buffers, a large file and a stream, in order, with their hash', async () => {
    const target = join(folder, 'a.cvb');

    const { big, streamed } = await build(target);

    const entries = await readAll(target);
    expect([...entries.keys()]).toEqual([
      'meta.json',
      'files/t/Historia clínica.obj',
      'db.dump',
      'empty',
    ]);
    expect(entries.get('meta.json')?.toString()).toBe('{"hola":"mundo ñ"}');
    expect(entries.get('files/t/Historia clínica.obj')?.equals(big)).toBe(true);
    expect(entries.get('db.dump')?.toString()).toBe('PGDMP-bytes');
    expect(entries.get('empty')?.length).toBe(0);
    expect(streamed).toEqual({
      bytes: 11,
      sha256: createHash('sha256').update('PGDMP-bytes').digest('hex'),
    });
  });

  it('is complete or absent: no partial file is left, and the header says what it is', async () => {
    const target = join(folder, 'a.cvb');
    await build(target);

    expect(readdirSync(folder).filter((name) => name.endsWith('.partial'))).toEqual([]);
    const { header: read } = await readArchiveHeader(target);
    expect(read).toMatchObject({ format: 2, kind: 'manual', migrationCount: 80 });
  });

  it('does not show what is inside', async () => {
    const target = join(folder, 'a.cvb');
    const writer = createArchiveWriter(target, key, header());
    await writer.addBuffer(
      'files/historia.obj',
      'Diagnóstico: hipertensión de María Luisa Pérez '.repeat(50),
    );
    await writer.finish();

    const bytes = readFileSync(target);

    expect(bytes.includes(Buffer.from('hipertensión'))).toBe(false);
    expect(bytes.includes(Buffer.from('historia.obj'))).toBe(false);
  });

  it('gives up cleanly when aborted', async () => {
    const target = join(folder, 'a.cvb');
    const writer = createArchiveWriter(target, key, header());
    await writer.addBuffer('x', 'x');

    await writer.abort();

    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.partial`)).toBe(false);
  });
});

describe('a backup that is not what it says', () => {
  async function damaged(change: (bytes: Buffer) => Buffer) {
    const target = join(folder, 'a.cvb');
    await build(target);
    const bad = join(folder, 'bad.cvb');
    writeFileSync(bad, change(readFileSync(target)));
    return bad;
  }

  it('is refused before anything is handed over: a changed byte in the middle of a large backup', async () => {
    const bad = await damaged((bytes) => {
      const copy = Buffer.from(bytes);
      copy[Math.floor(copy.length / 2)] = (copy[Math.floor(copy.length / 2)] ?? 0) ^ 0xff;
      return copy;
    });
    let handed = 0;

    const failure = await readArchive(bad, key, async (entry) => {
      handed += 1;
      await discard(entry.data);
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(handed).toBe(0);
  });

  it('is refused when it was cut short', async () => {
    const bad = await damaged((bytes) => bytes.subarray(0, bytes.length - 100));
    let handed = 0;

    const failure = await readArchive(bad, key, async (entry) => {
      handed += 1;
      await discard(entry.data);
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackupCryptoError);
    expect((failure as BackupCryptoError).code).toBe('truncated');
    expect(handed).toBe(0);
  });

  it('is refused with another key', async () => {
    const target = join(folder, 'a.cvb');
    await build(target);

    const failure = await readArchive(target, newBackupKey(), () => Promise.resolve()).catch(
      (error: unknown) => error,
    );

    expect((failure as BackupCryptoError).code).toBe('tampered');
  });

  it('is refused when it is not a backup at all (a zip, a text file, an empty file)', async () => {
    for (const content of [
      Buffer.from('PK\u0003\u0004zipzipzip'),
      Buffer.from('hola'),
      Buffer.alloc(0),
    ]) {
      const file = join(folder, 'other');
      writeFileSync(file, content);

      await expect(readArchiveHeader(file)).rejects.toBeInstanceOf(BackupCryptoError);
    }
  });
});

describe('the limits', () => {
  const generous = { maxEntries: 100, maxBytes: 100 * 1024 * 1024, maxNameBytes: 1024 };

  it('refuse too many entries', async () => {
    const target = join(folder, 'a.cvb');
    await build(target);

    await expect(readAll(target, { ...generous, maxEntries: 2 })).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('refuse more bytes than allowed', async () => {
    const target = join(folder, 'a.cvb');
    await build(target);

    await expect(readAll(target, { ...generous, maxBytes: 1024 * 1024 })).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('refuse a name that is too long, when writing', async () => {
    const writer = createArchiveWriter(join(folder, 'a.cvb'), key, header(), {
      limits: { ...generous, maxNameBytes: 10 },
    });

    await expect(writer.addBuffer('a-name-that-is-too-long', 'x')).rejects.toThrow(/too long/);
    await writer.abort();
  });
});

describe('an entry the handler does not read', () => {
  it('is skipped and the next one is read correctly', async () => {
    const target = join(folder, 'a.cvb');
    await build(target);
    const names: string[] = [];

    await readArchive(target, key, async (entry) => {
      names.push(entry.name);
      if (entry.name === 'files/t/Historia clínica.obj') return;
      await discard(entry.data);
    });

    expect(names).toEqual(['meta.json', 'files/t/Historia clínica.obj', 'db.dump', 'empty']);
  });
});
