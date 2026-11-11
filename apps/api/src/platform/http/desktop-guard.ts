import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { forbidden } from './problem.js';

/** The header the shell's local server adds to every request it forwards to the API. */
export const PROXY_HEADER = 'x-consulvia-proxy';
/** The header the shell's health probe sends: a random value the API must prove it can sign. */
export const NONCE_HEADER = 'x-consulvia-nonce';
/** The header the API answers the probe with: the proof for the nonce. */
export const PROOF_HEADER = 'x-consulvia-proof';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export interface DesktopGuardOptions {
  /** Random per run of the shell; the API gets it in `DESKTOP_PROXY_SECRET`. */
  secret: string;
  /** The `Host` values the app is served under (`localhost:<port>` and `127.0.0.1:<port>`), lower case. */
  hosts: readonly string[];
}

/**
 * The proof that a process holds the secret of the run: HMAC-SHA256 of the nonce, in hex. The shell
 * computes the same value and compares, so a program that grabbed the API's port cannot pass for the API.
 */
export function healthProof(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(`consulvia-health:${nonce}`).digest('hex');
}

/** Constant-time equality for values of any length: both sides are hashed first. */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function headerValue(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The guard of the desktop profile. The API listens on the loopback, but any program of the PC (and any
 * other user of a shared PC) can connect to a loopback port, so a request is served only when it comes
 * through the shell's local server: it carries the secret that server was given for this run, and the
 * `Host` is the app's own address (which stops a web page from reaching the API by rebinding its own
 * name to 127.0.0.1). Everything else is a 403 before any route, hook or database work runs.
 *
 * The one exception is the health probe with a nonce: it answers with the proof for it and nothing else,
 * so the shell can tell its own API from an impostor on the same port without handing the secret over.
 */
export function registerDesktopGuard(app: FastifyInstance, options: DesktopGuardOptions): void {
  const hosts = new Set(options.hosts.map((host) => host.toLowerCase()));

  app.addHook('onRequest', (request, reply, done) => {
    const path = request.url.split('?')[0] ?? request.url;
    const nonce = headerValue(request.headers[NONCE_HEADER]);
    if (request.method === 'GET' && path === '/health' && NONCE_PATTERN.test(nonce)) {
      void reply.header(PROOF_HEADER, healthProof(options.secret, nonce));
      done();
      return;
    }
    const secret = headerValue(request.headers[PROXY_HEADER]);
    const host = (request.headers.host ?? '').toLowerCase();
    if (secret === '' || !sameSecret(secret, options.secret) || !hosts.has(host)) {
      void forbidden(request, reply);
      return;
    }
    done();
  });
}
