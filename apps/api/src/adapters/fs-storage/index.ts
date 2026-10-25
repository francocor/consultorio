import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  assertTenantKey,
  ObjectChangedError,
  type MoveOptions,
  type ObjectHead,
  type ObjectStorage,
  type PresignedPost,
  type PresignedPostInput,
  type PutObjectInput,
  type StoredObject,
} from '../../platform/storage/object-storage.js';
import type {
  UploadGrant,
  UploadOutcome,
  UploadReceiver,
} from '../../platform/storage/upload-receiver.js';

import { dataPathOf, metaPathOf } from './paths.js';
import { signUploadToken, verifyUploadToken } from './upload-token.js';

export interface FsStorageConfig {
  /** The folder every object lives under. Created on demand. */
  dir: string;
  /** Signs the upload links (HMAC). Random per install. */
  uploadSecret: string;
  clock?: () => Date;
}

export interface FsObjectStorage extends ObjectStorage {
  /** The half that receives the browser's POST: the route calls it. */
  uploads: UploadReceiver;
  close(): void;
}

/** Where the upload links point. The reverse proxy of the desktop shell strips `/api`. */
export const UPLOAD_URL_PREFIX = '/api/files/uploads/';

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const CHUNK_BYTES = 256 * 1024;
/** Windows lets a virus scanner or an indexer hold a file for a moment: a rename is tried again. */
const RENAME_ATTEMPTS = 5;
const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const isMissing = (error: unknown) => errorCode(error) === 'ENOENT';

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const retryable = RENAME_RETRYABLE.has(errorCode(error) ?? '');
      if (!retryable || attempt === RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** The content of a file in pieces: opened when the first piece is asked for, closed after the last. */
async function* chunksOf(path: string): AsyncGenerator<Buffer> {
  const handle = await open(path, 'r');
  try {
    for (let position = 0; ;) {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/**
 * A stream of a file that holds nothing open until somebody reads it. On Windows an open file cannot
 * be replaced, so a caller that takes the etag of an object and drops the stream must not leave a
 * handle behind.
 */
const streamOf = (path: string): Readable => Readable.from(chunksOf(path), { objectMode: false });

/**
 * The size and the etag of a file: its length and a digest of its content, like the S3 ETag of a
 * single-part upload. The file is open only while it is hashed.
 */
async function measure(path: string): Promise<{ size: number; etag: string }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of chunksOf(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, etag: `"${hash.digest('hex')}"` };
}

/** Counts the bytes that pass, so a stream can be checked against the length it announced. */
function counter(): { stream: Transform; bytes: () => number } {
  let total = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, bytes: () => total };
}

/**
 * Returns a claimed object to its place, unless an object is there already (somebody uploaded a new
 * one while it was claimed): that one is the newer, and the claimed one is dropped.
 */
async function putBack(claimed: string, place: string): Promise<void> {
  try {
    await link(claimed, place);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') {
      // A file system without hard links: copy, and still refuse to overwrite.
      try {
        await copyFile(claimed, place, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if (errorCode(copyError) !== 'EEXIST') throw copyError;
      }
    }
  }
  await removeQuietly(claimed);
}

/**
 * ObjectStorage on the disk (the desktop profile: one clinic, one PC, no bucket). The tenant prefix is
 * checked before every call, like the S3 adapter does, and then the key is mapped to a path that
 * cannot leave the root (`paths.ts`).
 *
 * - An object is `<key>.obj` and its content type `<key>.meta`. A write goes to a temporary file in
 *   the same folder and is renamed, so a reader sees the old object or the new one, never half of it.
 *   The content type is renamed first and the bytes last: the object exists when its bytes do.
 * - The etag is the SHA-256 of the content. `get` hashes the object and then returns a stream that
 *   opens it on the first read, so nothing stays open for a caller that only wants the etag.
 * - A conditional move claims the source by renaming it to a private name, which no other writer can
 *   see, and only then compares its etag. A mismatch puts the object back unless somebody uploaded a
 *   new one in the meantime. That is the atomicity S3 gives `CopySourceIfMatch`.
 * - The upload link is `/api/files/uploads/<token>`: the policy S3 would sign, signed with an HMAC.
 */
export function createFsObjectStorage(config: FsStorageConfig): FsObjectStorage {
  const clock = config.clock ?? (() => new Date());
  const { dir } = config;

  async function readContentType(key: string): Promise<string> {
    try {
      const meta = JSON.parse(await readFile(metaPathOf(dir, key), 'utf8')) as {
        contentType?: unknown;
      };
      return typeof meta.contentType === 'string' ? meta.contentType : DEFAULT_CONTENT_TYPE;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return DEFAULT_CONTENT_TYPE;
      throw error;
    }
  }

  /** Writes the content type, then the bytes, each through a temporary file and a rename. */
  async function write(
    key: string,
    contentType: string,
    writeBytes: (temporary: string) => Promise<void>,
  ): Promise<void> {
    const data = dataPathOf(dir, key);
    const meta = metaPathOf(dir, key);
    await mkdir(dirname(data), { recursive: true });
    const id = randomUUID();
    const temporaryData = `${data}.${id}.tmp`;
    const temporaryMeta = `${meta}.${id}.tmp`;
    try {
      await writeBytes(temporaryData);
      await writeFile(temporaryMeta, JSON.stringify({ contentType }), { flag: 'wx' });
      await renameWithRetry(temporaryMeta, meta);
      await renameWithRetry(temporaryData, data);
    } catch (error) {
      await removeQuietly(temporaryData);
      await removeQuietly(temporaryMeta);
      throw error;
    }
  }

  const storage: FsObjectStorage = {
    async put(tenantId: string, key: string, input: PutObjectInput): Promise<void> {
      assertTenantKey(tenantId, key);
      await write(key, input.contentType, async (temporary) => {
        if (Buffer.isBuffer(input.body)) {
          await writeFile(temporary, input.body, { flag: 'wx' });
          return;
        }
        const written = counter();
        await pipeline(input.body, written.stream, createWriteStream(temporary, { flags: 'wx' }));
        // S3 refuses a body that is not as long as it said; so does this.
        if (input.contentLength !== undefined && written.bytes() !== input.contentLength) {
          throw new Error('the body is not as long as its content length');
        }
      });
    },

    async get(tenantId: string, key: string): Promise<StoredObject | null> {
      assertTenantKey(tenantId, key);
      const path = dataPathOf(dir, key);
      // Hash first, open the stream after. Objects only move forward (an upload replaces one), so
      // the stream is never older than the etag: if the object is replaced in between, the etag is
      // the stale one, and a conditional move with it is refused, which is the safe side.
      let measured;
      try {
        measured = await measure(path);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      return { ...measured, contentType: await readContentType(key), stream: streamOf(path) };
    },

    async head(tenantId: string, key: string): Promise<ObjectHead | null> {
      assertTenantKey(tenantId, key);
      try {
        const { size } = await stat(dataPathOf(dir, key));
        return { size, contentType: await readContentType(key) };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    presignedPost(
      tenantId: string,
      key: string,
      input: PresignedPostInput,
    ): Promise<PresignedPost> {
      // A refusal is a rejected promise, like the other adapters', never a synchronous throw.
      return new Promise((resolve) => {
        assertTenantKey(tenantId, key);
        const expiresAt = new Date(clock().getTime() + input.expiresInSeconds * 1000);
        const token = signUploadToken(config.uploadSecret, {
          tenantId,
          key,
          contentType: input.contentType,
          maxBytes: input.maxBytes,
          expiresAt,
        });
        resolve({
          url: `${UPLOAD_URL_PREFIX}${token}`,
          // The browser repeats this field, and the route checks it against the signed policy.
          fields: { 'Content-Type': input.contentType },
          expiresAt,
        });
      });
    },

    async move(
      tenantId: string,
      fromKey: string,
      toKey: string,
      options: MoveOptions = {},
    ): Promise<boolean> {
      assertTenantKey(tenantId, fromKey);
      assertTenantKey(tenantId, toKey);
      const from = dataPathOf(dir, fromKey);
      const to = dataPathOf(dir, toKey);
      if (from === to) return (await storage.head(tenantId, fromKey)) !== null;

      // Claim the source under a name nobody else uses: from here on it cannot be swapped.
      const claimed = `${from}.${randomUUID()}.moving`;
      try {
        await renameWithRetry(from, claimed);
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
      try {
        if (options.ifMatch !== undefined && (await measure(claimed)).etag !== options.ifMatch) {
          await putBack(claimed, from);
          throw new ObjectChangedError();
        }
        const contentType = await readContentType(fromKey);
        await mkdir(dirname(to), { recursive: true });
        await writeFile(metaPathOf(dir, toKey), JSON.stringify({ contentType }));
        await renameWithRetry(claimed, to);
      } catch (error) {
        // Whatever failed, do not lose the object: put it back if its place is still free.
        if (!(error instanceof ObjectChangedError))
          await putBack(claimed, from).catch(() => undefined);
        throw error;
      }
      await removeQuietly(metaPathOf(dir, fromKey));
      return true;
    },

    async remove(tenantId: string, key: string): Promise<void> {
      assertTenantKey(tenantId, key);
      // The bytes first: an object without its content type is still an object, but not the reverse.
      await removeQuietly(dataPathOf(dir, key));
      await removeQuietly(metaPathOf(dir, key));
    },

    uploads: {
      verify: (token) => verifyUploadToken(config.uploadSecret, token, clock()),

      async accept(grant: UploadGrant, upload): Promise<UploadOutcome> {
        if (upload.contentType !== grant.contentType) return 'wrong_type';
        if (upload.bytes.length > grant.maxBytes) return 'too_large';
        if (upload.bytes.length === 0) return 'empty';
        await storage.put(grant.tenantId, grant.key, {
          body: upload.bytes,
          contentType: grant.contentType,
        });
        return 'stored';
      },
    },

    close() {
      // Nothing is held open between calls.
    },
  };
  return storage;
}
