import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildUploadApp,
  multipartBody,
  postToUploadRoute,
} from '../../../test/support/fs-upload.js';
import { createFsObjectStorage, type FsObjectStorage } from '../../adapters/fs-storage/index.js';
import { registerProblemHandlers } from '../http/problem.js';
import { tenantKey } from '../storage/object-storage.js';

import { uploadReceiverRoutes } from './upload-routes.js';

const SECRET = 'placeholder-upload-secret-0123456789-abcdef';
const A = '0190a000-0000-7000-8000-0000000000a1';
const B = '0190a000-0000-7000-8000-0000000000b2';
const PDF = 'application/pdf';

describe('POST /files/uploads/<token>', () => {
  let dir: string;
  let storage: FsObjectStorage;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'consulvia-upload-route-'));
    storage = createFsObjectStorage({ dir, uploadSecret: SECRET });
    app = await buildUploadApp(storage.uploads, { maxBodyBytes: 64 * 1024 });
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const grant = async (maxBytes = 1024, contentType = PDF) => {
    const key = tenantKey(A, 'quarantine', randomUUID());
    const post = await storage.presignedPost(A, key, {
      contentType,
      maxBytes,
      expiresInSeconds: 600,
    });
    return { key, post };
  };
  const path = (url: string) => url.replace(/^\/api/, '');

  it('stores the file and answers 204 with nothing to read', async () => {
    const { key, post } = await grant();
    const form = await multipartBody(Object.entries(post.fields), [
      { bytes: Buffer.from('%PDF-1.4 hola'), type: PDF },
    ]);

    const response = await app.inject({ method: 'POST', url: path(post.url), ...form });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await storage.head(A, key)).toEqual({ size: 13, contentType: PDF });
  });

  it('takes a token longer than the default limit of a path parameter', async () => {
    const { post } = await grant();

    expect(post.url.length).toBeGreaterThan(200);
    expect(await postToUploadRoute(app, post, Buffer.alloc(10), PDF)).toBe(204);
  });

  it('refuses another content type than the one in the policy', async () => {
    const { key, post } = await grant(1024, 'image/png');

    const status = await postToUploadRoute(app, post, Buffer.alloc(10), 'text/html', {
      'Content-Type': 'text/html',
    });

    expect(status).toBe(403);
    expect(await storage.head(A, key)).toBeNull();
  });

  it('refuses a request that leaves out the Content-Type field', async () => {
    const { key, post } = await grant();
    const form = await multipartBody([], [{ bytes: Buffer.alloc(10), type: PDF }]);

    const response = await app.inject({ method: 'POST', url: path(post.url), ...form });

    expect(response.statusCode).toBe(403);
    expect(await storage.head(A, key)).toBeNull();
  });

  it('refuses a file over the cap, by the size it carries and not by what it claims', async () => {
    const { key, post } = await grant(100);

    expect(await postToUploadRoute(app, post, Buffer.alloc(101), PDF)).toBe(413);
    expect(await postToUploadRoute(app, post, Buffer.alloc(100), PDF)).toBe(204);
    expect((await storage.head(A, key))?.size).toBe(100);
  });

  it('stops reading a body that is far over the cap', async () => {
    const { key, post } = await grant(100);
    const form = await multipartBody(Object.entries(post.fields), [
      { bytes: Buffer.alloc(40 * 1024, 1), type: PDF },
    ]);

    const response = await app.inject({ method: 'POST', url: path(post.url), ...form });

    expect(response.statusCode).toBe(413);
    expect(await storage.head(A, key)).toBeNull();
  });

  it('refuses a body over the limit of the route before reading it', async () => {
    const { post } = await grant(1024 * 1024);
    const form = await multipartBody(Object.entries(post.fields), [
      { bytes: Buffer.alloc(80 * 1024, 1), type: PDF },
    ]);

    const response = await app.inject({ method: 'POST', url: path(post.url), ...form });

    expect(response.statusCode).toBe(413);
  });

  it('refuses an empty file', async () => {
    const { key, post } = await grant();

    expect(await postToUploadRoute(app, post, Buffer.alloc(0), PDF)).toBe(400);
    expect(await storage.head(A, key)).toBeNull();
  });

  it('refuses a request without a file, and one with two', async () => {
    const { key, post } = await grant();
    const none = await multipartBody(Object.entries(post.fields), []);
    const two = await multipartBody(Object.entries(post.fields), [
      { bytes: Buffer.alloc(5), type: PDF },
      { bytes: Buffer.alloc(5), type: PDF },
    ]);

    for (const form of [none, two]) {
      const response = await app.inject({ method: 'POST', url: path(post.url), ...form });
      expect(response.statusCode).toBe(400);
    }
    expect(await storage.head(A, key)).toBeNull();
  });

  it('refuses a body that is not multipart, and one that is not well formed', async () => {
    const { post } = await grant();

    const json = await app.inject({
      method: 'POST',
      url: path(post.url),
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    const broken = await app.inject({
      method: 'POST',
      url: path(post.url),
      headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
      payload: '--xyz\r\nContent-Disposition: form-data; name="file"\r\n\r\ntruncated',
    });

    expect(json.statusCode).toBe(415);
    expect(broken.statusCode).toBe(400);
  });

  it('answers the same 403 to a forged token, a missing one and garbage', async () => {
    const forged = createFsObjectStorage({ dir, uploadSecret: `${SECRET}-other` });
    const post = await forged.presignedPost(A, tenantKey(A, 'docs', randomUUID()), {
      contentType: PDF,
      maxBytes: 10,
      expiresInSeconds: 60,
    });
    const form = await multipartBody(
      [['Content-Type', PDF]],
      [{ bytes: Buffer.alloc(5), type: PDF }],
    );

    for (const url of [path(post.url), '/files/uploads/', '/files/uploads/garbage']) {
      const response = await app.inject({ method: 'POST', url, ...form });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('refuses a token on the host of another organization', async () => {
    const guarded = Fastify({ logger: false });
    registerProblemHandlers(guarded);
    guarded.decorateRequest('hostContext', null);
    guarded.addHook('onRequest', (request, _reply, done) => {
      const slug = request.headers.host === 'a.test' ? A : B;
      request.hostContext = {
        kind: 'tenant',
        tenant: {
          id: slug,
          slug: 'x',
          status: 'active',
          readOnlySince: null,
          isDemo: false,
          country: 'AR',
        },
      };
      done();
    });
    await guarded.register(async (scope) => {
      uploadReceiverRoutes({ receiver: storage.uploads })(scope);
      await Promise.resolve();
    });
    const { key, post } = await grant();
    const form = await multipartBody(Object.entries(post.fields), [
      { bytes: Buffer.alloc(5), type: PDF },
    ]);

    const wrong = await guarded.inject({
      method: 'POST',
      url: path(post.url),
      headers: { ...form.headers, host: 'b.test' },
      payload: form.payload,
    });
    expect(wrong.statusCode).toBe(403);
    expect(await storage.head(A, key)).toBeNull();

    const right = await guarded.inject({
      method: 'POST',
      url: path(post.url),
      headers: { ...form.headers, host: 'a.test' },
      payload: form.payload,
    });
    expect(right.statusCode).toBe(204);
    await guarded.close();
  });
});
