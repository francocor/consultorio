import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

import { uploadReceiverRoutes } from '../../src/platform/files/upload-routes.js';
import { registerProblemHandlers } from '../../src/platform/http/problem.js';
import type { PresignedPost } from '../../src/platform/storage/object-storage.js';
import type { UploadReceiver } from '../../src/platform/storage/upload-receiver.js';

/** The URL prefix the reverse proxy strips before the API sees the request. */
const PROXY_PREFIX = '/api';

/** A multipart body as a browser builds it: the fields in order, then the file part. */
export async function multipartBody(
  fields: readonly (readonly [string, string])[],
  files: readonly { bytes: Buffer; type: string; name?: string }[],
): Promise<{ payload: Buffer; headers: { 'content-type': string } }> {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  for (const file of files) {
    form.append(
      'file',
      new Blob([new Uint8Array(file.bytes)], { type: file.type }),
      file.name ?? 'upload',
    );
  }
  const response = new Response(form);
  return {
    payload: Buffer.from(await response.arrayBuffer()),
    headers: { 'content-type': response.headers.get('content-type') ?? '' },
  };
}

/** A bare application with only the upload route (and the problem handlers its errors need). */
export async function buildUploadApp(
  receiver: UploadReceiver,
  options: { maxBodyBytes?: number } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerProblemHandlers(app);
  await app.register(async (scope) => {
    uploadReceiverRoutes({ receiver, ...options })(scope);
    await Promise.resolve();
  });
  await app.ready();
  return app;
}

/**
 * The browser's side of an upload: POST the fields the API handed out and then the file, to the
 * URL the API handed out (without the `/api` the proxy strips). Returns the HTTP status.
 */
export async function postToUploadRoute(
  app: FastifyInstance,
  post: Pick<PresignedPost, 'url' | 'fields'>,
  body: Buffer,
  contentType: string,
  overrides: Record<string, string> = {},
): Promise<number> {
  const fields = { ...post.fields, ...overrides };
  const form = await multipartBody(Object.entries(fields), [{ bytes: body, type: contentType }]);
  const response = await app.inject({
    method: 'POST',
    url: post.url.startsWith(PROXY_PREFIX) ? post.url.slice(PROXY_PREFIX.length) : post.url,
    ...form,
  });
  return response.statusCode;
}
