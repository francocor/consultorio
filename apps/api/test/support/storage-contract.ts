import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ObjectChangedError,
  StorageKeyError,
  tenantKey,
  type ObjectStorage,
  type PresignedPost,
} from '../../src/platform/storage/object-storage.js';

export interface StorageUnderTest {
  storage: ObjectStorage;
  /**
   * Performs the browser's upload with a presigned POST and returns the HTTP status the storage
   * service answered. The in-memory fake does not run a server, so it applies the same conditions.
   */
  upload(post: PresignedPost, body: Buffer, contentType: string): Promise<number>;
  close(): Promise<void>;
}

const A = '0190a000-0000-7000-8000-0000000000a1';
const B = '0190a000-0000-7000-8000-0000000000b2';

/**
 * The behavior every ObjectStorage adapter must have. It runs against the in-memory fake in the
 * unit tests and against MinIO (S3 API) in the integration tests, so the fake cannot drift from
 * the real thing.
 */
export function describeObjectStorage(label: string, make: () => Promise<StorageUnderTest>): void {
  describe(`ObjectStorage contract: ${label}`, () => {
    let under: StorageUnderTest;
    let storage: ObjectStorage;

    beforeAll(async () => {
      under = await make();
      storage = under.storage;
    });

    afterAll(async () => {
      await under.close();
    });

    const fresh = (tenant = A, ...parts: string[]) =>
      tenantKey(tenant, ...(parts.length > 0 ? parts : ['docs', randomUUID()]));

    it('stores a buffer and reads it back with its size and content type', async () => {
      const key = fresh();
      const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252]);

      await storage.put(A, key, { body: bytes, contentType: 'application/pdf' });

      expect(await storage.head(A, key)).toEqual({ size: 7, contentType: 'application/pdf' });
      const object = await storage.get(A, key);
      expect(object).not.toBeNull();
      expect(await buffer(object?.stream ?? Readable.from([]))).toEqual(bytes);
      expect(object).toMatchObject({ size: 7, contentType: 'application/pdf' });
    });

    it('stores a stream when its length is given', async () => {
      const key = fresh();
      const bytes = Buffer.from('un archivo que llega en partes');

      await storage.put(A, key, {
        body: Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]),
        contentType: 'text/plain',
        contentLength: bytes.length,
      });

      const object = await storage.get(A, key);
      expect(await buffer(object?.stream ?? Readable.from([]))).toEqual(bytes);
    });

    it('replaces an object written twice under the same key', async () => {
      const key = fresh();
      await storage.put(A, key, { body: Buffer.from('uno'), contentType: 'text/plain' });

      await storage.put(A, key, { body: Buffer.from('dos!'), contentType: 'text/plain' });

      expect((await storage.head(A, key))?.size).toBe(4);
    });

    it('answers null, not an error, for an object that does not exist', async () => {
      const key = fresh();

      expect(await storage.head(A, key)).toBeNull();
      expect(await storage.get(A, key)).toBeNull();
    });

    it("never lets one tenant name another tenant's object, even if it exists", async () => {
      const theirs = fresh(B);
      await storage.put(B, theirs, { body: Buffer.from('ajeno'), contentType: 'text/plain' });

      await expect(storage.get(A, theirs)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.head(A, theirs)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(
        storage.put(A, theirs, { body: Buffer.from('x'), contentType: 'text/plain' }),
      ).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.remove(A, theirs)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.move(A, theirs, fresh(A))).rejects.toBeInstanceOf(StorageKeyError);
      expect((await storage.head(B, theirs))?.size).toBe(5);
    });

    it.each([
      ['no prefix', 'docs/a.pdf'],
      ['a parent segment', `t/${A}/docs/../../t/${B}/a.pdf`],
      ['a bare prefix', `t/${A}/`],
    ])('refuses a key with %s on every operation', async (_name, key) => {
      await expect(
        storage.put(A, key, { body: Buffer.from('x'), contentType: 'text/plain' }),
      ).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.get(A, key)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.head(A, key)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.remove(A, key)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(
        storage.presignedPost(A, key, {
          contentType: 'image/png',
          maxBytes: 10,
          expiresInSeconds: 60,
        }),
      ).rejects.toBeInstanceOf(StorageKeyError);
    });

    it('moves an object inside the tenant prefix, keeping its content type', async () => {
      const from = fresh(A, 'quarantine', randomUUID());
      const to = fresh(A, 'docs', randomUUID());
      await storage.put(A, from, { body: Buffer.from('limpio'), contentType: 'application/pdf' });

      const moved = await storage.move(A, from, to);

      expect(moved).toBe(true);
      expect(await storage.head(A, from)).toBeNull();
      expect(await storage.head(A, to)).toEqual({ size: 6, contentType: 'application/pdf' });
    });

    it('says false when the source of a move does not exist, and refuses a destination outside the prefix', async () => {
      const missing = fresh();

      expect(await storage.move(A, missing, fresh())).toBe(false);
      const present = fresh();
      await storage.put(A, present, { body: Buffer.from('x'), contentType: 'text/plain' });
      await expect(storage.move(A, present, fresh(B))).rejects.toBeInstanceOf(StorageKeyError);
      expect(await storage.head(A, present)).not.toBeNull();
    });

    describe('moving only what was inspected (JD-S2 C5)', () => {
      const put = (key: string, text: string) =>
        storage.put(A, key, { body: Buffer.from(text), contentType: 'text/plain' });

      it('gives every object an etag that changes with its content', async () => {
        const key = fresh();
        await put(key, 'uno');
        const first = (await storage.get(A, key))?.etag;

        await put(key, 'dos');
        const second = (await storage.get(A, key))?.etag;

        expect(first).toEqual(expect.any(String));
        expect(first).not.toBe('');
        expect(second).not.toBe(first);
        expect((await storage.get(A, key))?.etag).toBe(second);
      });

      it('moves the object when it is still the one that was inspected', async () => {
        const from = fresh(A, 'quarantine', randomUUID());
        const to = fresh(A, 'docs', randomUUID());
        await put(from, 'inspeccionado');
        const etag = (await storage.get(A, from))?.etag;

        const moved = await storage.move(A, from, to, { ifMatch: etag ?? '' });

        expect(moved).toBe(true);
        expect(await storage.head(A, from)).toBeNull();
        expect((await storage.head(A, to))?.size).toBe('inspeccionado'.length);
      });

      it('refuses to move an object that was overwritten after it was inspected, and leaves both keys as they were', async () => {
        const from = fresh(A, 'quarantine', randomUUID());
        const to = fresh(A, 'docs', randomUUID());
        await put(from, 'inspeccionado');
        const etag = (await storage.get(A, from))?.etag;
        await put(from, 'reemplazado despues del escaneo');

        await expect(storage.move(A, from, to, { ifMatch: etag ?? '' })).rejects.toBeInstanceOf(
          ObjectChangedError,
        );

        expect((await storage.head(A, from))?.size).toBe('reemplazado despues del escaneo'.length);
        expect(await storage.head(A, to)).toBeNull();
      });
    });

    it('removes an object, and removing it again is fine', async () => {
      const key = fresh();
      await storage.put(A, key, { body: Buffer.from('x'), contentType: 'text/plain' });

      await storage.remove(A, key);
      await storage.remove(A, key);

      expect(await storage.head(A, key)).toBeNull();
    });

    describe('presigned upload', () => {
      it('accepts the object it was made for', async () => {
        const key = fresh();
        const post = await storage.presignedPost(A, key, {
          contentType: 'image/png',
          maxBytes: 1024,
          expiresInSeconds: 300,
        });

        const status = await under.upload(post, Buffer.alloc(100, 7), 'image/png');

        expect(status).toBeLessThan(300);
        expect(await storage.head(A, key)).toEqual({ size: 100, contentType: 'image/png' });
        expect(post.expiresAt.getTime()).toBeGreaterThan(Date.now());
      });

      it('refuses a file over the size cap', async () => {
        const key = fresh();
        const post = await storage.presignedPost(A, key, {
          contentType: 'image/png',
          maxBytes: 1024,
          expiresInSeconds: 300,
        });

        const status = await under.upload(post, Buffer.alloc(2048, 1), 'image/png');

        expect(status).toBeGreaterThanOrEqual(400);
        expect(await storage.head(A, key)).toBeNull();
      });

      it('refuses another content type than the one it was made for', async () => {
        const key = fresh();
        const post = await storage.presignedPost(A, key, {
          contentType: 'image/png',
          maxBytes: 1024,
          expiresInSeconds: 300,
        });

        const status = await under.upload(post, Buffer.alloc(10, 1), 'text/html');

        expect(status).toBeGreaterThanOrEqual(400);
        expect(await storage.head(A, key)).toBeNull();
      });
    });
  });
}
