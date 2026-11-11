import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildUploadApp, postToUploadRoute } from '../../../test/support/fs-upload.js';
import { describeObjectStorage } from '../../../test/support/storage-contract.js';
import { StorageKeyError, tenantKey } from '../../platform/storage/object-storage.js';

import { createFsObjectStorage, type FsObjectStorage } from './index.js';

const SECRET = 'placeholder-upload-secret-0123456789-abcdef';
const A = '0190a000-0000-7000-8000-0000000000a1';

describeObjectStorage('filesystem adapter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'consulvia-fs-contract-'));
  const storage = createFsObjectStorage({ dir, uploadSecret: SECRET });
  const app = await buildUploadApp(storage.uploads);
  return {
    storage,
    upload: (post, body, contentType) =>
      postToUploadRoute(app, post, body, contentType, { 'Content-Type': contentType }),
    async close() {
      await app.close();
      storage.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

/** Every file under a folder, relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(folder, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  };
  await walk(root, '');
  return found.sort();
}

describe('the filesystem storage', () => {
  let dir: string;
  let storage: FsObjectStorage;
  let app: FastifyInstance;
  let now = new Date('2026-10-20T12:00:00Z');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'consulvia-fs-'));
    storage = createFsObjectStorage({ dir, uploadSecret: SECRET, clock: () => now });
    app = await buildUploadApp(storage.uploads);
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const fresh = () => tenantKey(A, 'docs', randomUUID());

  it('keeps every object under the root and nothing else there', async () => {
    const key = fresh();

    await storage.put(A, key, { body: Buffer.from('contenido'), contentType: 'text/plain' });

    const files = await filesUnder(dir);
    expect(files.filter((file) => file.includes(key.slice(`t/${A}/`.length)))).toHaveLength(2);
    expect(files.every((file) => file.startsWith(`t/${A}/`))).toBe(true);
    expect(files.some((file) => /\.(tmp|moving)$/.test(file))).toBe(false);
  });

  it('writes in one piece: a stream that fails halfway leaves the old object and no debris', async () => {
    const key = fresh();
    await storage.put(A, key, { body: Buffer.from('version uno'), contentType: 'text/plain' });
    const before = await filesUnder(dir);
    const broken = new Readable({
      read() {
        this.push(Buffer.from('media version'));
        this.destroy(new Error('the connection dropped'));
      },
    });

    await expect(
      storage.put(A, key, { body: broken, contentType: 'text/plain', contentLength: 100 }),
    ).rejects.toThrow('the connection dropped');

    const kept = await storage.get(A, key);
    expect(await buffer(kept?.stream ?? Readable.from([]))).toEqual(Buffer.from('version uno'));
    expect(await filesUnder(dir)).toEqual(before);
  });

  it('refuses a stream that is not as long as it said', async () => {
    const key = fresh();

    await expect(
      storage.put(A, key, {
        body: Readable.from([Buffer.from('corto')]),
        contentType: 'text/plain',
        contentLength: 99,
      }),
    ).rejects.toThrow();

    expect(await storage.head(A, key)).toBeNull();
  });

  it('refuses a key that climbs out of the tenant prefix, and creates nothing', async () => {
    const before = await filesUnder(dir);

    await expect(
      storage.put(A, `t/${A}/docs/../../escape`, {
        body: Buffer.from('x'),
        contentType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(StorageKeyError);
    await expect(
      storage.put(A, `t/${A}/docs/C:evil`, { body: Buffer.from('x'), contentType: 'text/plain' }),
    ).rejects.toBeInstanceOf(StorageKeyError);
    await expect(
      storage.put(A, `t/${A}/docs\\evil`, { body: Buffer.from('x'), contentType: 'text/plain' }),
    ).rejects.toBeInstanceOf(StorageKeyError);

    expect(await filesUnder(dir)).toEqual(before);
    await expect(stat(join(dir, '..', 'escape.obj'))).rejects.toThrow();
  });

  it('gives the same etag to the same content and another one to other content', async () => {
    const one = fresh();
    const two = fresh();
    await storage.put(A, one, { body: Buffer.from('igual'), contentType: 'text/plain' });
    await storage.put(A, two, { body: Buffer.from('igual'), contentType: 'application/pdf' });

    expect((await storage.get(A, one))?.etag).toBe((await storage.get(A, two))?.etag);

    await storage.put(A, two, { body: Buffer.from('distinto'), contentType: 'application/pdf' });
    expect((await storage.get(A, one))?.etag).not.toBe((await storage.get(A, two))?.etag);
  });

  it('puts the object back when a conditional move finds another one, and moves nothing', async () => {
    const from = tenantKey(A, 'quarantine', randomUUID());
    const to = tenantKey(A, 'docs', randomUUID());
    await storage.put(A, from, { body: Buffer.from('escaneado'), contentType: 'text/plain' });
    const etag = (await storage.get(A, from))?.etag ?? '';
    await storage.put(A, from, { body: Buffer.from('cambiado'), contentType: 'text/plain' });

    await expect(storage.move(A, from, to, { ifMatch: etag })).rejects.toThrow(
      'the object changed after it was inspected',
    );

    const kept = await storage.get(A, from);
    expect(await buffer(kept?.stream ?? Readable.from([]))).toEqual(Buffer.from('cambiado'));
    expect(kept?.contentType).toBe('text/plain');
    expect(await storage.head(A, to)).toBeNull();
    expect((await filesUnder(dir)).some((file) => file.endsWith('.moving'))).toBe(false);
  });

  it('moves the content type with the object', async () => {
    const from = tenantKey(A, 'quarantine', randomUUID());
    const to = tenantKey(A, 'docs', randomUUID());
    await storage.put(A, from, { body: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' });

    await storage.move(A, from, to);

    expect(await storage.head(A, to)).toEqual({ size: 8, contentType: 'application/pdf' });
    const files = await filesUnder(dir);
    expect(files.some((file) => file.includes(from.slice(`t/${A}/`.length)))).toBe(false);
  });

  describe('the upload link', () => {
    const grantFor = (key: string) =>
      storage.presignedPost(A, key, {
        contentType: 'application/pdf',
        maxBytes: 1024,
        expiresInSeconds: 600,
      });

    it('points at the same-origin route, carries a signed policy, and says when it expires', async () => {
      const key = fresh();

      const post = await grantFor(key);

      expect(post.url).toMatch(/^\/api\/files\/uploads\/[A-Za-z0-9_.-]+$/);
      expect(post.fields).toEqual({ 'Content-Type': 'application/pdf' });
      expect(post.expiresAt).toEqual(new Date(now.getTime() + 600_000));
      expect(JSON.stringify(post)).not.toContain(SECRET);
    });

    it('writes the object under the key it was made for, with the type it was made for', async () => {
      const key = fresh();
      const post = await grantFor(key);

      const status = await postToUploadRoute(app, post, Buffer.alloc(300, 9), 'application/pdf');

      expect(status).toBe(204);
      expect(await storage.head(A, key)).toEqual({ size: 300, contentType: 'application/pdf' });
    });

    it('is refused after it expired', async () => {
      const key = fresh();
      const post = await grantFor(key);
      now = new Date(now.getTime() + 601_000);

      const status = await postToUploadRoute(app, post, Buffer.alloc(300, 9), 'application/pdf');
      now = new Date(now.getTime() - 601_000);

      expect(status).toBe(403);
      expect(await storage.head(A, key)).toBeNull();
    });

    it('is refused when it was altered, or signed by another install', async () => {
      const key = fresh();
      const post = await grantFor(key);
      const altered = { ...post, url: `${post.url.slice(0, -3)}AAA` };
      const other = createFsObjectStorage({ dir, uploadSecret: `${SECRET}-other` });
      const foreign = await other.presignedPost(A, key, {
        contentType: 'application/pdf',
        maxBytes: 1024,
        expiresInSeconds: 600,
      });

      expect(await postToUploadRoute(app, altered, Buffer.alloc(10), 'application/pdf')).toBe(403);
      expect(await postToUploadRoute(app, foreign, Buffer.alloc(10), 'application/pdf')).toBe(403);
      expect(await storage.head(A, key)).toBeNull();
    });

    it('is refused for a file bigger than the cap it carries', async () => {
      const key = fresh();
      const post = await grantFor(key);

      const status = await postToUploadRoute(app, post, Buffer.alloc(1025), 'application/pdf');

      expect(status).toBe(413);
      expect(await storage.head(A, key)).toBeNull();
    });
  });
});
