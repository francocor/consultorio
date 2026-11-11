import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { close, createReadStream, createWriteStream, fsync, openSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import {
  BackupCryptoError,
  ChunkDecryptor,
  ChunkEncryptor,
  CHUNK_BYTES,
  MAX_HEADER_BYTES,
  decodeHeader,
  type BackupHeader,
} from './backup-crypto.js';

/**
 * The container of a backup: a sequence of named entries (the database dump, the documents, the secrets,
 * a manifest) written as one gzip stream and sealed chunk by chunk (`backup-crypto.ts`). It never holds a
 * file in memory, and the reader enforces limits on the number of entries, their names and the bytes they
 * add up to, so a damaged or hostile file cannot fill the disk.
 *
 * Inside the encryption, an entry is `01 | name length (u16) | name | frames | 00000000`, a frame is
 * `length (u32) | bytes`, and the stream ends with a single `00` byte.
 */

export interface ArchiveLimits {
  maxEntries: number;
  maxBytes: number;
  maxNameBytes: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 2_000_000,
  maxBytes: 512 * 1024 ** 3,
  maxNameBytes: 1024,
};

const FRAME_BYTES = CHUNK_BYTES;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface ArchiveWriter {
  addBuffer(name: string, content: Buffer | string): Promise<void>;
  addFile(name: string, path: string): Promise<void>;
  /** Writes a stream of unknown length; says how many bytes it had and their SHA-256. */
  addStream(name: string, source: Readable): Promise<{ bytes: number; sha256: string }>;
  /** Ends the archive, makes it durable and moves it to its name. */
  finish(): Promise<{ bytes: number }>;
  /** Gives up: nothing is left behind. */
  abort(): Promise<void>;
}

/** Windows refuses to rename over a name an antivirus or an indexer has open for a moment. */
export async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/**
 * Makes what was written survive a power cut: the data is on the disk, not only in the cache. It is done on the
 * descriptor that wrote the file (kept open by `autoClose: false`) and not by opening the file again, which an
 * antivirus that is scanning a file that has just been written can refuse.
 */
async function syncAndClose(fd: number): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      fsync(fd, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    await new Promise<void>((resolve) => {
      close(fd, () => {
        resolve();
      });
    });
  }
}

export function createArchiveWriter(
  target: string,
  backupKey: Buffer,
  header: BackupHeader,
  options: { chunkBytes?: number; limits?: ArchiveLimits } = {},
): ArchiveWriter {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const partial = `${target}.partial`;
  const source = new PassThrough();
  // Opened here and handed to the stream, so the same descriptor can be synced when the stream is done.
  const fd = openSync(partial, 'w');
  const out = createWriteStream(partial, { fd, autoClose: false });
  const done = pipeline(
    source,
    createGzip(),
    new ChunkEncryptor(backupKey, header, options.chunkBytes),
    out,
  );
  // A failure is reported by the next write or by `finish`; this keeps it from being "unhandled" meanwhile.
  done.catch(() => undefined);
  let entries = 0;

  async function write(buffer: Buffer): Promise<void> {
    if (source.write(buffer)) return;
    await Promise.race([once(source, 'drain'), done]);
  }

  async function begin(name: string): Promise<void> {
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length === 0 || nameBytes.length > limits.maxNameBytes) {
      throw new Error(`The name of an entry is too long or empty: ${name.slice(0, 40)}`);
    }
    entries += 1;
    if (entries > limits.maxEntries) throw new Error('Too many entries in the backup');
    const head = Buffer.alloc(3);
    head.writeUInt8(1, 0);
    head.writeUInt16BE(nameBytes.length, 1);
    await write(Buffer.concat([head, nameBytes]));
  }

  async function frame(bytes: Buffer): Promise<void> {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    await write(Buffer.concat([length, bytes]));
  }

  async function addStream(name: string, stream: Readable) {
    await begin(name);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      for (let offset = 0; offset < buffer.length; offset += FRAME_BYTES) {
        const part = buffer.subarray(offset, offset + FRAME_BYTES);
        hash.update(part);
        bytes += part.length;
        await frame(part);
      }
    }
    await write(Buffer.alloc(4));
    return { bytes, sha256: hash.digest('hex') };
  }

  async function discard(): Promise<void> {
    source.destroy();
    out.destroy();
    await done.catch(() => undefined);
    await rm(partial, { force: true });
  }

  return {
    async addBuffer(name, content) {
      const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      await addStream(name, Readable.from([buffer]));
    },
    async addFile(name, path) {
      await addStream(name, createReadStream(path));
    },
    addStream,
    async finish() {
      try {
        await write(Buffer.from([0]));
        source.end();
        await done;
        await syncAndClose(fd);
        await renameWithRetry(partial, target);
        return { bytes: out.bytesWritten };
      } catch (error) {
        await discard();
        throw error;
      }
    },
    abort: discard,
  };
}

/** The header of a backup file, from its first bytes. Fails with `invalid_header` on anything else. */
export async function readArchiveHeader(
  file: string,
): Promise<{ header: BackupHeader; headerBytes: Buffer; bodyOffset: number }> {
  const handle = await open(file, 'r');
  try {
    const first = Buffer.alloc(8);
    const { bytesRead } = await handle.read(first, 0, 8, 0);
    if (bytesRead < 8) throw new BackupCryptoError('invalid_header', 'not a Consulvia backup');
    const length = first.readUInt32BE(4);
    if (!first.subarray(0, 4).equals(Buffer.from('CVB2')) || length > MAX_HEADER_BYTES) {
      throw new BackupCryptoError('invalid_header', 'not a Consulvia backup');
    }
    const all = Buffer.alloc(8 + length);
    const read = await handle.read(all, 0, 8 + length, 0);
    return decodeHeader(all.subarray(0, read.bytesRead));
  } finally {
    await handle.close();
  }
}

/** Takes exact numbers of bytes from a stream of buffers. */
class ByteReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async take(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      const next = await this.iterator.next();
      if (next.done === true) throw new BackupCryptoError('truncated');
      this.buffer = Buffer.concat([this.buffer, next.value]);
    }
    const taken = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return Buffer.from(taken);
  }

  /** True when nothing more comes. */
  async atEnd(): Promise<boolean> {
    while (this.buffer.length === 0) {
      const next = await this.iterator.next();
      if (next.done === true) return true;
      this.buffer = next.value;
    }
    return false;
  }
}

/** Reads an entry to its end and throws the bytes away; says how many there were. */
export async function discard(data: AsyncIterable<Buffer>): Promise<number> {
  let bytes = 0;
  for await (const part of data) bytes += part.length;
  return bytes;
}

export interface ArchiveEntry {
  name: string;
  /** Must be read to its end before the handler returns. */
  data: AsyncIterable<Buffer>;
}

/**
 * Authenticates the whole file, then reads its entries one at a time, in order. Nothing is handed to
 * `handler` until every chunk of the file has authenticated: pass 1 reads the file only to prove it, and
 * pass 2 (this function again, with a handler) does the work.
 */
export async function readArchive(
  file: string,
  backupKey: Buffer,
  handler: (entry: ArchiveEntry) => Promise<void>,
  options: { limits?: ArchiveLimits; verifiedFirst?: boolean } = {},
): Promise<{ entries: number; bytes: number }> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const { header, headerBytes, bodyOffset } = await readArchiveHeader(file);

  const consume = async (work: (entry: ArchiveEntry) => Promise<void>) => {
    const plain = new PassThrough();
    const flow = pipeline(
      createReadStream(file, { start: bodyOffset }),
      new ChunkDecryptor(backupKey, header, headerBytes),
      createGunzip(),
      plain,
    );
    // Whatever goes wrong on the way (a chunk that does not authenticate, a cut file, bad gzip) reaches the
    // reader below as the error of its next read.
    flow.catch((error: unknown) => {
      plain.destroy(error instanceof Error ? error : new Error(String(error)));
    });
    const reader = new ByteReader(plain);
    let entries = 0;
    let bytes = 0;
    try {
      for (;;) {
        const tag = (await reader.take(1)).readUInt8(0);
        if (tag === 0) break;
        if (tag !== 1) throw new BackupCryptoError('tampered', 'bad record');
        const nameLength = (await reader.take(2)).readUInt16BE(0);
        if (nameLength === 0 || nameLength > limits.maxNameBytes) {
          throw new BackupCryptoError('too_large', 'entry name');
        }
        const name = (await reader.take(nameLength)).toString('utf8');
        entries += 1;
        if (entries > limits.maxEntries) throw new BackupCryptoError('too_large', 'entries');
        const state = { finished: false };
        const data = (async function* () {
          for (;;) {
            const length = (await reader.take(4)).readUInt32BE(0);
            if (length === 0) {
              state.finished = true;
              return;
            }
            if (length > MAX_FRAME_BYTES) throw new BackupCryptoError('too_large', 'frame');
            bytes += length;
            if (bytes > limits.maxBytes) throw new BackupCryptoError('too_large', 'bytes');
            yield await reader.take(length);
          }
        })();
        await work({ name, data });
        // An entry the handler left unread is skipped, so the next record starts where it should.
        while (!state.finished) await data.next();
      }
      if (!(await reader.atEnd())) throw new BackupCryptoError('tampered', 'data after the end');
      await flow;
      return { entries, bytes };
    } finally {
      plain.destroy();
      await flow.catch(() => undefined);
    }
  };

  if (options.verifiedFirst !== true) {
    await consume(async (entry) => {
      await discard(entry.data);
    });
  }
  return consume(handler);
}
