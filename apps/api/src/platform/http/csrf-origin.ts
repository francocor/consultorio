import type { FastifyInstance } from 'fastify';

import { AppError } from './problem.js';
import { readSessionCookie } from './session-cookie.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Providers cannot send our Origin; their calls are authenticated by signature instead. */
const EXEMPT = /^\/webhooks\//;

function hostOfOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * CSRF defence in depth (ADR-004): the session cookie is `SameSite=Lax`, and on top of that every
 * request that changes state must come from the page of the same host.
 *
 * - With an `Origin` header, its host must equal the `Host` of the request.
 * - Without one, the request is refused if it carries a session cookie (a browser always sends
 *   `Origin` on a cross-site POST, so a cookie without it is not a normal browser request) and
 *   allowed otherwise, since there is no ambient credential to abuse.
 */
export function registerOriginCheck(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (SAFE_METHODS.has(request.method) || EXEMPT.test(path)) {
      done();
      return;
    }

    const origin = request.headers.origin;
    const allowed =
      origin === undefined
        ? readSessionCookie(request.headers.cookie) === null
        : hostOfOrigin(origin) === request.headers.host;

    done(allowed ? undefined : new AppError('forbidden'));
  });
}
