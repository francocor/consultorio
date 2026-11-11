import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { healthProof, registerDesktopGuard } from './desktop-guard.js';
import { registerProblemHandlers, registerRequestId } from './problem.js';

const SECRET = 'a-per-run-secret-0123456789-abcdefghijklmnop';
/** Sixteen or more of the characters a nonce may have. */
const NONCE = 'n'.repeat(20);
const HOSTS = ['localhost:47800', '127.0.0.1:47800'];

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(): Promise<FastifyInstance> {
  const instance = Fastify();
  registerRequestId(instance);
  registerProblemHandlers(instance);
  registerDesktopGuard(instance, { secret: SECRET, hosts: HOSTS });
  instance.get('/health', () => ({ status: 'ok' }));
  instance.get('/patients', () => ({ secret: 'clinical data' }));
  instance.post('/auth/login', () => ({ ok: true }));
  await instance.ready();
  app = instance;
  return instance;
}

const proxied = { 'x-consulvia-proxy': SECRET, host: 'localhost:47800' };

describe('the guard of the desktop profile', () => {
  it('serves a request that carries the secret of the run and the host of the app', async () => {
    const server = await build();

    const answer = await server.inject({ method: 'GET', url: '/patients', headers: proxied });

    expect(answer.statusCode).toBe(200);
  });

  it('accepts both names of the loopback address', async () => {
    const server = await build();

    const answer = await server.inject({
      method: 'GET',
      url: '/patients',
      headers: { ...proxied, host: '127.0.0.1:47800' },
    });

    expect(answer.statusCode).toBe(200);
  });

  it('refuses with 403 every request without the secret, on any route, and never runs the route', async () => {
    const server = await build();

    for (const [method, url] of [
      ['GET', '/patients'],
      ['GET', '/health'],
      ['POST', '/auth/login'],
      ['GET', '/does-not-exist'],
    ] as const) {
      const answer = await server.inject({ method, url, headers: { host: 'localhost:47800' } });
      expect(answer.statusCode, `${method} ${url}`).toBe(403);
      expect(answer.body).not.toContain('clinical data');
    }
  });

  it('refuses a wrong secret, a secret of another length and an empty one', async () => {
    const server = await build();

    for (const wrong of [SECRET.slice(0, -1) + 'X', SECRET.slice(1), `${SECRET}x`, '']) {
      const answer = await server.inject({
        method: 'GET',
        url: '/patients',
        headers: { 'x-consulvia-proxy': wrong, host: 'localhost:47800' },
      });
      expect(answer.statusCode, wrong).toBe(403);
    }
  });

  it('refuses a host that is not the address of the app, even with the secret (DNS rebinding)', async () => {
    const server = await build();

    for (const host of ['evil.example', 'evil.example:47800', 'localhost:47801', 'localhost', '']) {
      const answer = await server.inject({
        method: 'GET',
        url: '/patients',
        headers: { 'x-consulvia-proxy': SECRET, host },
      });
      expect(answer.statusCode, host).toBe(403);
    }
  });

  it('proves it holds the secret when asked about a nonce, without the secret being sent', async () => {
    const server = await build();

    const answer = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-consulvia-nonce': NONCE, host: '127.0.0.1:54000' },
    });

    expect(answer.statusCode).toBe(200);
    expect(answer.headers['x-consulvia-proof']).toBe(healthProof(SECRET, NONCE));
    expect(answer.headers['x-consulvia-proof']).not.toBe(healthProof(SECRET, 'another-nonce'));
  });

  it('proves nothing on any other route, and nothing for a nonce that is too short to be one', async () => {
    const server = await build();

    const elsewhere = await server.inject({
      method: 'GET',
      url: '/patients',
      headers: { 'x-consulvia-nonce': NONCE, host: 'localhost:47800' },
    });
    const short = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-consulvia-nonce': 'abc', host: 'localhost:47800' },
    });

    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.headers['x-consulvia-proof']).toBeUndefined();
    expect(short.statusCode).toBe(403);
    expect(short.headers['x-consulvia-proof']).toBeUndefined();
  });

  it('computes a proof that the shell can recompute: HMAC-SHA256 of the nonce, in hex', () => {
    expect(healthProof(SECRET, 'n')).toMatch(/^[0-9a-f]{64}$/);
    expect(healthProof(SECRET, 'n')).toBe(healthProof(SECRET, 'n'));
    expect(healthProof(SECRET, 'n')).not.toBe(healthProof(`${SECRET}x`, 'n'));
  });
});
