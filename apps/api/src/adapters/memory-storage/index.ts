import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

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

export interface MemoryObjectStorage extends ObjectStorage {
  /** Every key stored, sorted. Tests use it to see where things ended up. */
  keys(): string[];
  /**
   * What the storage service does with the browser's POST: the same conditions the S3 policy
   * states (key, content type, size cap, expiry). Returns the HTTP status it would answer.
   */
  acceptUpload(post: PresignedPost, body: Buffer, contentType: string): number;
}

/** A refusal must be a rejected promise, like the real adapter's, never a synchronous throw. */
function settle<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(fn());
  });
}

interface Stored {
  bytes: Buffer;
  contentType: string;
}

/** Like an S3 ETag of a single-part upload: a quoted digest of the content. */
const etagOf = (bytes: Buffer) => `"${createHash('md5').update(bytes).digest('hex')}"`;

/**
 * In-memory ObjectStorage for tests and for a demo tenant (design section 6: the fake of the
 * `ObjectStorage` port). It enforces the same tenant-prefix rules as the real adapter, so a test
 * written against it exercises the same refusals.
 */
export function createMemoryObjectStorage(
  options: { clock?: () => Date } = {},
): MemoryObjectStorage {
  const clock = options.clock ?? (() => new Date());
  const objects = new Map<string, Stored>();
  const grants = new Map<
    string,
    { key: string; contentType: string; maxBytes: number; expiresAt: Date }
  >();

  return {
    async put(tenantId: string, key: string, input: PutObjectInput): Promise<void> {
      assertTenantKey(tenantId, key);
      const bytes = Buffer.isBuffer(input.body) ? input.body : await buffer(input.body);
      objects.set(key, { bytes: Buffer.from(bytes), contentType: input.contentType });
    },

    get(tenantId: string, key: string): Promise<StoredObject | null> {
      return settle(() => {
        assertTenantKey(tenantId, key);
        const found = objects.get(key);
        if (!found) return null;
        return {
          size: found.bytes.length,
          contentType: found.contentType,
          stream: Readable.from([found.bytes]),
          etag: etagOf(found.bytes),
        };
      });
    },

    head(tenantId: string, key: string): Promise<ObjectHead | null> {
      return settle(() => {
        assertTenantKey(tenantId, key);
        const found = objects.get(key);
        return found ? { size: found.bytes.length, contentType: found.contentType } : null;
      });
    },

    presignedPost(
      tenantId: string,
      key: string,
      input: PresignedPostInput,
    ): Promise<PresignedPost> {
      return settle(() => {
        assertTenantKey(tenantId, key);
        const token = `${String(grants.size + 1)}-${Math.random().toString(36).slice(2)}`;
        const expiresAt = new Date(clock().getTime() + input.expiresInSeconds * 1000);
        grants.set(token, {
          key,
          contentType: input.contentType,
          maxBytes: input.maxBytes,
          expiresAt,
        });
        return {
          url: `memory://upload/${token}`,
          fields: { key, 'Content-Type': input.contentType },
          expiresAt,
        };
      });
    },

    move(
      tenantId: string,
      fromKey: string,
      toKey: string,
      options: MoveOptions = {},
    ): Promise<boolean> {
      return settle(() => {
        assertTenantKey(tenantId, fromKey);
        assertTenantKey(tenantId, toKey);
        const found = objects.get(fromKey);
        if (!found) return false;
        if (options.ifMatch !== undefined && options.ifMatch !== etagOf(found.bytes)) {
          throw new ObjectChangedError();
        }
        objects.set(toKey, found);
        objects.delete(fromKey);
        return true;
      });
    },

    remove(tenantId: string, key: string): Promise<void> {
      return settle(() => {
        assertTenantKey(tenantId, key);
        objects.delete(key);
      });
    },

    keys: () => [...objects.keys()].sort(),

    acceptUpload(post, body, contentType) {
      const token = post.url.slice('memory://upload/'.length);
      const grant = grants.get(token);
      if (!grant || grant.expiresAt.getTime() <= clock().getTime()) return 403;
      if (contentType !== grant.contentType || body.length > grant.maxBytes) return 403;
      objects.set(grant.key, { bytes: Buffer.from(body), contentType });
      return 204;
    },
  };
}
