import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type ObjectVersion,
} from '@aws-sdk/client-s3';

import type {
  ArchiveGetResult,
  ArchiveHeadResult,
  ArchiveListResult,
  ArchiveObjectInfo,
  ArchivePutOptions,
  ArchivePutResult,
  ArchiveRemoveResult,
  ArchiveStore,
} from '../../modules/tenancy/archive/ports.js';

/**
 * The local archive store: a MinIO bucket created with Object Lock (`mc mb --with-lock`) whose
 * objects are written in GOVERNANCE mode with a retention date, by an identity (`archive-writer`)
 * that can write, read and list and nothing else (`policies.ts`). It is the development stand-in of
 * the S3 bucket of production, which is the same thing with a different endpoint (deferred slice
 * S6.D); both pass `adapters/archive-store.contract.ts`.
 *
 * - **Write once.** `PutObject` carries `If-None-Match: *`, so a key that exists is never replaced;
 *   the answer to a retry of the same bytes is told apart from a different payload by the SHA-256 the
 *   object was stored with. A bucket policy cannot demand that header on MinIO (it has no such
 *   condition key; S3 has `s3:if-none-match`, which the production bucket will use), so a credential
 *   that skips it CAN add a second version under a key. That never changes what the archive serves:
 *   every read goes to the ORIGINAL version, which Object Lock keeps untouched, and `versions` on
 *   the object info tells the verification that something wrote behind the port's back.
 * - **Integrity.** The checksum travels with the upload (`x-amz-checksum-sha256`) and the service
 *   refuses bytes that do not match it, besides the check here before sending.
 * - **No removal.** `remove` never calls the service: the routine role has no right to delete and the
 *   method only explains why (inside the retention, or simply not this role's).
 * - **Bounded.** Every call takes an `AbortSignal`, and an outcome that is not known (a timeout
 *   after the request was sent) is reported as `outcomeUnknown` so the caller looks before it resends.
 */

export interface LocalArchiveStoreConfig {
  bucket: string;
  region: string;
  endpoint: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

export interface LocalArchiveStore extends ArchiveStore {
  /** Closes the sockets of the client. */
  close(): void;
}

const abortError = () => new DOMException('The call was aborted.', 'AbortError');

function status(error: unknown): number | undefined {
  return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function isNotFound(error: unknown): boolean {
  return (
    status(error) === 404 ||
    (error instanceof S3ServiceException &&
      (error.name === 'NoSuchKey' || error.name === 'NotFound'))
  );
}

const UNAVAILABLE = 'El almacén de archivo no está disponible. Intente nuevamente más tarde.';

/** The original version of ONE key and how many versions the key has. */
interface Located {
  versionId: string;
  count: number;
}

function oldest(versions: readonly ObjectVersion[]): ObjectVersion | undefined {
  // S3 lists the newest first; the original is the oldest by time, and the last of equal times.
  let found: ObjectVersion | undefined;
  for (const version of versions) {
    if ((version.LastModified?.getTime() ?? 0) <= (found?.LastModified?.getTime() ?? Infinity)) {
      found = version;
    }
  }
  return found;
}

export function createLocalArchiveStore(
  config: LocalArchiveStoreConfig,
  options: { clock?: () => Date } = {},
): LocalArchiveStore {
  const clock = options.clock ?? (() => new Date());
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: config.credentials,
    // A few attempts, because a refusal before the body was read (the 412 of a key that exists) can
    // leave a socket the service closed. Every write is safe to repeat: the key is written once.
    maxAttempts: 3,
  });
  const Bucket = config.bucket;
  const sendOptions = (signal?: AbortSignal) => ({ ...(signal ? { abortSignal: signal } : {}) });

  /** Every version under the keys that start with `prefix`, grouped by key. */
  async function versionsUnder(
    prefix: string,
    signal?: AbortSignal,
  ): Promise<Map<string, ObjectVersion[]>> {
    const byKey = new Map<string, ObjectVersion[]>();
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await client.send(
        new ListObjectVersionsCommand({
          Bucket,
          Prefix: prefix,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionMarker ? { VersionIdMarker: versionMarker } : {}),
        }),
        sendOptions(signal),
      );
      for (const version of page.Versions ?? []) {
        if (!version.Key) continue;
        byKey.set(version.Key, [...(byKey.get(version.Key) ?? []), version]);
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker !== undefined);
    return byKey;
  }

  async function locate(key: string, signal?: AbortSignal): Promise<Located | null> {
    const exact = (await versionsUnder(key, signal)).get(key);
    const original = exact ? oldest(exact) : undefined;
    if (!exact || !original?.VersionId) return null;
    return { versionId: original.VersionId, count: exact.length };
  }

  async function infoOf(
    key: string,
    where: Located,
    signal?: AbortSignal,
  ): Promise<ArchiveObjectInfo> {
    const response = await client.send(
      new HeadObjectCommand({ Bucket, Key: key, VersionId: where.versionId }),
      sendOptions(signal),
    );
    return {
      key,
      sizeBytes: response.ContentLength ?? 0,
      sha256: response.Metadata?.['sha256'] ?? '',
      retainUntil: response.ObjectLockRetainUntilDate?.toISOString() ?? '',
      storedAt: (response.LastModified ?? clock()).toISOString(),
      versions: where.count,
    };
  }

  async function headInfo(key: string, signal?: AbortSignal): Promise<ArchiveObjectInfo | null> {
    const where = await locate(key, signal);
    return where ? infoOf(key, where, signal) : null;
  }

  return {
    close() {
      client.destroy();
    },

    async put(
      key: string,
      body: Uint8Array,
      put: ArchivePutOptions,
      signal?: AbortSignal,
    ): Promise<ArchivePutResult> {
      if (signal?.aborted) throw abortError();
      const digest = createHash('sha256').update(body).digest();
      if (digest.toString('hex') !== put.sha256) {
        return {
          status: 'rejected',
          message: 'Los datos no coinciden con la suma de verificación enviada.',
        };
      }
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key: key,
            Body: Buffer.from(body),
            ContentLength: body.byteLength,
            ContentType: 'application/octet-stream',
            ChecksumSHA256: digest.toString('base64'),
            // Write once: a key that exists answers 412 and nothing is replaced.
            IfNoneMatch: '*',
            ObjectLockMode: 'GOVERNANCE',
            ObjectLockRetainUntilDate: put.retainUntil,
            Metadata: { sha256: put.sha256 },
          }),
          sendOptions(signal),
        );
        return {
          status: 'stored',
          object: {
            key,
            sizeBytes: body.byteLength,
            sha256: put.sha256,
            retainUntil: put.retainUntil.toISOString(),
            storedAt: clock().toISOString(),
            versions: 1,
          },
        };
      } catch (error) {
        if (isAbort(error)) throw abortError();
        if (
          status(error) === 412 ||
          (error instanceof S3ServiceException && error.name === 'PreconditionFailed')
        ) {
          const known = await headInfo(key, signal).catch(() => null);
          if (known?.sha256 === put.sha256) return { status: 'already_stored', object: known };
          return {
            status: 'locked',
            message: 'El objeto ya existe con otro contenido y no se puede reemplazar.',
          };
        }
        if (error instanceof S3ServiceException && error.name === 'BadDigest') {
          return {
            status: 'rejected',
            message: 'Los datos no coinciden con la suma de verificación enviada.',
          };
        }
        const code = status(error);
        if (code !== undefined && code >= 400 && code < 500) {
          // The service refused the request itself (a policy, a malformed header): nothing was stored.
          return { status: 'rejected', message: 'El almacén de archivo rechazó el pedido.' };
        }
        // A timeout, a reset or a 5xx after the bytes were sent: the object may or may not be there.
        return { status: 'retryable', message: UNAVAILABLE, outcomeUnknown: true };
      }
    },

    async head(key: string, signal?: AbortSignal): Promise<ArchiveHeadResult> {
      if (signal?.aborted) throw abortError();
      try {
        const object = await headInfo(key, signal);
        return object ? { status: 'found', object } : { status: 'unknown' };
      } catch (error) {
        if (isAbort(error)) throw abortError();
        return { status: 'retryable', message: UNAVAILABLE };
      }
    },

    async get(key: string, signal?: AbortSignal): Promise<ArchiveGetResult> {
      if (signal?.aborted) throw abortError();
      try {
        const where = await locate(key, signal);
        if (!where) return { status: 'unknown' };
        const response = await client.send(
          new GetObjectCommand({ Bucket, Key: key, VersionId: where.versionId }),
          sendOptions(signal),
        );
        if (!response.Body) return { status: 'unknown' };
        const body = await response.Body.transformToByteArray();
        return {
          status: 'found',
          body,
          object: {
            key,
            sizeBytes: body.byteLength,
            sha256: response.Metadata?.['sha256'] ?? '',
            retainUntil: response.ObjectLockRetainUntilDate?.toISOString() ?? '',
            storedAt: (response.LastModified ?? clock()).toISOString(),
            versions: where.count,
          },
        };
      } catch (error) {
        if (isAbort(error)) throw abortError();
        if (isNotFound(error)) return { status: 'unknown' };
        return { status: 'retryable', message: UNAVAILABLE };
      }
    },

    async list(prefix: string, signal?: AbortSignal): Promise<ArchiveListResult> {
      if (signal?.aborted) throw abortError();
      try {
        const grouped = await versionsUnder(prefix, signal);
        const originals: { key: string; at: number; where: Located }[] = [];
        for (const [key, versions] of grouped) {
          const original = oldest(versions);
          if (original?.VersionId) {
            originals.push({
              key,
              at: original.LastModified?.getTime() ?? 0,
              where: { versionId: original.VersionId, count: versions.length },
            });
          }
        }
        // Oldest first, then by key: the order the objects were written in.
        originals.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        const objects: ArchiveObjectInfo[] = [];
        for (const { key, where } of originals) objects.push(await infoOf(key, where, signal));
        return { status: 'ok', objects };
      } catch (error) {
        if (isAbort(error)) throw abortError();
        return { status: 'retryable', message: UNAVAILABLE };
      }
    },

    async remove(key: string, signal?: AbortSignal): Promise<ArchiveRemoveResult> {
      if (signal?.aborted) throw abortError();
      // The routine role never deletes: this does not call the service. It says which wall it hits.
      try {
        const object = await headInfo(key, signal);
        if (!object) return { status: 'unknown' };
        const retained = Date.parse(object.retainUntil) > clock().getTime();
        return { status: 'refused', reason: retained ? 'retention' : 'not_permitted' };
      } catch (error) {
        if (isAbort(error)) throw abortError();
        return { status: 'retryable', message: UNAVAILABLE };
      }
    },
  };
}
