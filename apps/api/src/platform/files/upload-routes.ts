import { Readable, Transform } from 'node:stream';

import type { FastifyInstance } from 'fastify';

import { AppError } from '../http/problem.js';
import type { UploadReceiver } from '../storage/upload-receiver.js';

/** The most a multipart request may weigh before its policy is even read: the largest file plus its framing. */
export const DEFAULT_UPLOAD_BODY_BYTES = 32 * 1024 * 1024;
/** The form around the file (field names, boundaries, headers) weighs a few hundred bytes. */
const FORM_OVERHEAD_BYTES = 16 * 1024;

const tooLarge = () => Object.assign(new Error('upload too large'), { statusCode: 413 });

/** Reads a multipart body into a form, giving up once it passes `cap` bytes. */
async function readForm(body: Readable, contentType: string, cap: number): Promise<FormData> {
  let received = 0;
  const state = { exceeded: false };
  const limited = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > cap) {
        state.exceeded = true;
        callback(new Error('upload too large'));
        return;
      }
      callback(null, chunk);
    },
  });
  body.on('error', (error) => {
    limited.destroy(error);
  });
  body.pipe(limited);
  const response = new Response(Readable.toWeb(limited) as ReadableStream<Uint8Array>, {
    headers: { 'content-type': contentType },
  });
  try {
    // The body is capped above, so reading it whole is bounded; `formData` is flagged for servers
    // because it buffers, which is the very thing the cap makes safe.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    return await response.formData();
  } catch {
    if (state.exceeded) throw tooLarge();
    throw new AppError('bad_request');
  }
}

/**
 * `POST /files/uploads/<token>`: the receiving half of the upload link of a storage that has no
 * server of its own (the filesystem of the desktop profile). The browser posts the same multipart
 * form it posts to S3, without anything new on its side: the fields the API handed out, then the
 * file.
 *
 * The token IS the authorization, as the signed policy of a presigned POST is: it names the object, the
 * content type, the size cap and the expiry, and it is signed with the secret of the install. The
 * route has no session (the browser sends none to a bucket either), refuses a token of another
 * organization's host, and answers one uniform 403 for a forged, altered or expired token.
 *
 * Only mounted when the filesystem storage is active. The body is read up to the cap of the token
 * (plus the framing of the form) and no further.
 */
export function uploadReceiverRoutes(deps: { receiver: UploadReceiver; maxBodyBytes?: number }) {
  const bodyLimit = deps.maxBodyBytes ?? DEFAULT_UPLOAD_BODY_BYTES;
  return (app: FastifyInstance): void => {
    // The raw stream of the request: the route reads it itself, with its own cap.
    app.addContentTypeParser('multipart/form-data', (_request, payload, done) => {
      done(null, payload);
    });

    // A wildcard, not `:token`: a path parameter is cut at 100 characters and a token is longer.
    app.post(
      '/files/uploads/*',
      { config: { auth: 'public', readOnly: 'write', audits: 'none' } },
      async (request, reply) => {
        const token = (request.params as { '*': string })['*'];
        const grant = deps.receiver.verify(token);
        const host = request.hostContext;
        if (!grant || (host && (host.kind !== 'tenant' || host.tenant.id !== grant.tenantId))) {
          throw new AppError('forbidden');
        }

        const contentType = request.headers['content-type'];
        if (typeof contentType !== 'string' || !contentType.startsWith('multipart/form-data')) {
          throw Object.assign(new Error('unsupported media type'), { statusCode: 415 });
        }
        const cap = Math.min(grant.maxBytes + FORM_OVERHEAD_BYTES, bodyLimit);
        // A body that says it is too big is refused before a byte of it is read.
        if (Number(request.headers['content-length']) > cap) {
          void reply.header('connection', 'close');
          throw tooLarge();
        }
        if (!(request.body instanceof Readable)) throw new AppError('bad_request');
        let form: FormData;
        try {
          form = await readForm(request.body, contentType, cap);
        } catch (error) {
          // The client may still be sending: do not wait for it on this connection.
          void reply.header('connection', 'close');
          throw error;
        }

        const declared = form.get('Content-Type');
        const files = form.getAll('file');
        const file = files[0];
        if (typeof declared !== 'string') throw new AppError('forbidden');
        if (files.length !== 1 || typeof file === 'string' || file === undefined) {
          throw new AppError('bad_request');
        }

        const outcome = await deps.receiver.accept(grant, {
          contentType: declared,
          bytes: Buffer.from(await file.arrayBuffer()),
        });
        if (outcome === 'wrong_type') throw new AppError('forbidden');
        if (outcome === 'too_large') throw tooLarge();
        if (outcome === 'empty') throw new AppError('bad_request');

        return reply.code(204).header('cache-control', 'no-store').send();
      },
    );
  };
}
