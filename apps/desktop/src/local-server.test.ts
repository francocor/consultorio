import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInternalPages, PURPOSE, type PageActions } from './internal-pages.js';
import { createLocalServer, loadContentSecurityPolicy, type LocalServer } from './local-server.js';
import { findFreePort } from './ports.js';
import { routeOf } from './proxy.js';
import { resolveInside } from './static-files.js';
import { TokenVault } from './tokens.js';

/** The secret of the run that the API checks on every request. */
const PROXY_SECRET = 'run-secret-0123456789-abcdefghijklmnopqrstuvwxyz';

const CSP =
  "default-src 'self'; script-src 'self' 'sha256-abc'; upgrade-insecure-requests; frame-ancestors 'none'";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let folder: string;
let web: string;
let api: Server;
let apiPort: number;
let seen: Seen[];
let apiAvailable = true;
let server: LocalServer;
let port: number;
let vault: TokenVault;
let provisioned = false;
let keyShown = true;
let setupCalls: unknown[];
let setupGate: Promise<void> | null = null;

const actions: PageActions = {
  isProvisioned: () => provisioned,
  commonPasswords: () => new Set(['password1234']),
  setup: async (values) => {
    setupCalls.push(values);
    if (setupGate) await setupGate;
    return { ok: true, recoveryKey: 'ABCDE-FGHJK', ackToken: 'ack-token-for-the-page' };
  },
  resetPassword: (input) =>
    Promise.resolve({
      ok: true,
      email: 'ana@clinica.example',
      secondFactorCleared: input.clearSecondFactor,
    }),
  recoveryKeyToShow: () => (keyShown ? 'ABCDE-FGHJK-LMNPQ' : null),
  confirmRecoveryKey: (lastFour) =>
    Promise.resolve(
      lastFour.toUpperCase() === 'NPQ'.padStart(4, 'M')
        ? { ok: true }
        : { ok: false, errors: { recoveryKeyLast4: 'No coincide.' } },
    ),
  checkRecoveryKey: (typed) =>
    Promise.resolve(
      typed === 'ABCDE-FGHJK-LMNPQ' ? { ok: true } : { ok: false, errors: { recoveryKey: 'No.' } },
    ),
  submitRecoveryKey: (key) =>
    Promise.resolve(
      key === 'ABCDE'
        ? { ok: true }
        : { ok: false, message: 'La clave de recuperación no es correcta.' },
    ),
};

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-server-'));
  web = join(folder, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Consulvia</title>');
  writeFileSync(join(web, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
  writeFileSync(join(web, 'content-security-policy.txt'), `${CSP}\n`);
  writeFileSync(join(web, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(folder, 'secret.txt'), 'outside the bundle');

  seen = [];
  api = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ok"}');
      } else if (request.url === '/echo') {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
        });
        response.end(body);
      } else if (request.url === '/cached') {
        response.writeHead(200, { 'cache-control': 'public, max-age=60' });
        response.end('x');
      } else if (request.url === '/set-cookie') {
        response.writeHead(204, {
          'set-cookie': ['sid=abc; Path=/; HttpOnly; SameSite=Lax', 'x=1'],
        });
        response.end();
      } else if (request.url === '/manifest.webmanifest') {
        response.writeHead(200, { 'content-type': 'application/manifest+json' });
        response.end('{"name":"Clínica Prueba"}');
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const address = api.address();
  apiPort = typeof address === 'object' && address ? address.port : 0;

  port = await findFreePort();
  vault = new TokenVault();
  setupCalls = [];
  server = createLocalServer({
    port,
    webRoot: web,
    contentSecurityPolicy: CSP,
    apiPort: () => (apiAvailable ? apiPort : null),
    proxySecret: () => (apiAvailable ? PROXY_SECRET : null),
    pages: createInternalPages(vault, actions),
  });
  await server.listen();
});

afterAll(async () => {
  await server.close();
  await new Promise((resolve) => api.close(resolve));
  rmSync(folder, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A raw request, so the `Host` and `Origin` headers are exactly what the test says. */
function call(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string | Readable;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: `localhost:${String(port)}`, ...options.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on('error', reject);
    if (options.body instanceof Readable) options.body.pipe(request);
    else request.end(options.body);
  });
}

describe('which requests go to the API', () => {
  it('strips /api and keeps the query string', () => {
    expect(routeOf('/api/health')).toEqual({ kind: 'api', path: '/health' });
    expect(routeOf('/api/patients?limit=20&q=a%20b')).toEqual({
      kind: 'api',
      path: '/patients?limit=20&q=a%20b',
    });
    expect(routeOf('/api')).toEqual({ kind: 'api', path: '/' });
    expect(routeOf('/api/files/uploads/tok')).toEqual({ kind: 'api', path: '/files/uploads/tok' });
  });

  it('forwards the manifest, the logo and the public pages untouched', () => {
    for (const path of [
      '/manifest.webmanifest',
      '/public/branding/logo',
      '/public/t/abc123',
      '/public/v/room?x=1',
    ]) {
      expect(routeOf(path)).toEqual({ kind: 'untouched', path });
    }
  });

  it('leaves everything else to the web bundle, including lookalikes', () => {
    for (const path of [
      '/',
      '/patients',
      '/apix',
      '/api-docs',
      '/public',
      '/public/other',
      '/assets/x.js',
    ]) {
      expect(routeOf(path)).toBeNull();
    }
  });
});

describe('the paths under the web bundle', () => {
  it('stay inside the folder', () => {
    expect(resolveInside('C:\\web', '/assets/app.js')).toMatch(/assets[\\/]app\.js$/);
    for (const bad of [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/a\\b',
      '/a%00b',
      '/%E0%A4%A',
    ]) {
      expect(resolveInside('C:\\web', bad), bad).toBeNull();
    }
  });
});

describe('the web bundle', () => {
  it('sends the Content Security Policy with every response, the page and the 404 included', async () => {
    for (const path of [
      '/',
      '/patients/123',
      '/assets/app-abc123.js',
      '/assets/missing.js',
      '/sw.js',
    ]) {
      const reply = await call(path);
      expect(reply.headers['content-security-policy'], path).toBe(CSP);
    }
  });

  it('answers the page for a route of the app, and a 404 for a missing file', async () => {
    const route = await call('/agenda/semana');
    const missing = await call('/assets/missing.js');
    const missingIcon = await call('/icons/nope.png');

    expect(route.status).toBe(200);
    expect(route.body.toString()).toContain('<title>Consulvia</title>');
    expect(route.headers['content-type']).toContain('text/html');
    expect(missing.status).toBe(404);
    expect(missingIcon.status).toBe(404);
  });

  it('checks the page and the service worker on every use, and keeps hashed assets for good', async () => {
    expect((await call('/')).headers['cache-control']).toBe('no-cache');
    expect((await call('/sw.js')).headers['cache-control']).toBe('no-cache');
    expect((await call('/assets/app-abc123.js')).headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  it('answers 304 to a repeated request with the ETag it was given', async () => {
    const first = await call('/assets/app-abc123.js');
    const again = await call('/assets/app-abc123.js', {
      headers: { 'if-none-match': String(first.headers.etag) },
    });

    expect(again.status).toBe(304);
  });

  it('does not serve a file outside the folder', async () => {
    const reply = await call('/..%2fsecret.txt');
    const encoded = await call('/%2e%2e/secret.txt');

    expect(reply.body.toString()).not.toContain('outside the bundle');
    expect(encoded.body.toString()).not.toContain('outside the bundle');
  });

  it('only reads: other methods are refused', async () => {
    expect((await call('/', { method: 'DELETE' })).status).toBe(405);
  });

  it('reads the policy the web build wrote', () => {
    expect(loadContentSecurityPolicy(web)).toBe(CSP);
    expect(loadContentSecurityPolicy(join(folder, 'nowhere'))).toBeNull();
  });
});

describe('the proxy to the API', () => {
  it('strips /api, keeps the Host and the Origin, and passes the cookie and the body', async () => {
    seen.length = 0;
    const origin = `http://localhost:${String(port)}`;

    const reply = await call('/api/echo', {
      method: 'POST',
      headers: { origin, cookie: 'sid=abc', 'content-type': 'application/json' },
      body: '{"hola":"mundo"}',
    });

    expect(reply.status).toBe(200);
    expect(reply.body.toString()).toBe('{"hola":"mundo"}');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/echo');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers.host).toBe(`localhost:${String(port)}`);
    expect(seen[0]?.headers.origin).toBe(origin);
    expect(seen[0]?.headers.cookie).toBe('sid=abc');
  });

  it('adds the secret of the run to what it forwards, and replaces one the browser sent', async () => {
    seen.length = 0;

    await call('/api/echo', {
      method: 'POST',
      headers: { 'x-consulvia-proxy': 'forged-by-the-page', 'content-type': 'application/json' },
      body: '{}',
    });
    await call('/manifest.webmanifest');

    expect(seen).toHaveLength(2);
    expect(seen[0]?.headers['x-consulvia-proxy']).toBe(PROXY_SECRET);
    expect(seen[1]?.headers['x-consulvia-proxy']).toBe(PROXY_SECRET);
  });

  it('answers /api/health from the API', async () => {
    const reply = await call('/api/health');

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body.toString())).toEqual({ status: 'ok' });
  });

  it('forwards the manifest untouched, with no CSP of the bundle added', async () => {
    seen.length = 0;

    const reply = await call('/manifest.webmanifest');

    expect(reply.status).toBe(200);
    expect(seen[0]?.url).toBe('/manifest.webmanifest');
    expect(reply.body.toString()).toContain('Clínica Prueba');
  });

  it('streams a large upload and a large download without a limit', async () => {
    const size = 24 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 7);
    let sent = 0;
    const body = new Readable({
      read() {
        if (sent >= size) this.push(null);
        else {
          sent += chunk.length;
          this.push(chunk);
        }
      },
    });

    const reply = await call('/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
      body,
    });

    expect(reply.status).toBe(200);
    expect(reply.body.length).toBe(size);
    expect(reply.body.every((byte) => byte === 7)).toBe(true);
  });

  it('adds no-store when the API did not say how to cache, and respects it when it did', async () => {
    expect((await call('/api/health')).headers['cache-control']).toBe('no-store');
    expect((await call('/api/cached')).headers['cache-control']).toBe('public, max-age=60');
  });

  it('passes several Set-Cookie headers through', async () => {
    const reply = await call('/api/set-cookie');

    expect(reply.headers['set-cookie']).toEqual(['sid=abc; Path=/; HttpOnly; SameSite=Lax', 'x=1']);
  });

  it('answers 503 in Spanish while the API is not up', async () => {
    apiAvailable = false;
    try {
      const reply = await call('/api/health');

      expect(reply.status).toBe(503);
      expect(reply.headers['retry-after']).toBe('3');
      expect(reply.body.toString()).toContain('se está iniciando');
    } finally {
      apiAvailable = true;
    }
  });
});

describe('who may talk to the server', () => {
  it('refuses a request whose Host is not this server (DNS rebinding)', async () => {
    for (const host of [
      'evil.example',
      `evil.example:${String(port)}`,
      'localhost',
      `localhost:${String(port + 1)}`,
    ]) {
      const reply = await call('/api/health', { headers: { host } });
      expect(reply.status, host).toBe(421);
    }
  });

  it('accepts both names of the loopback', async () => {
    expect((await call('/', { headers: { host: `127.0.0.1:${String(port)}` } })).status).toBe(200);
    expect((await call('/', { headers: { host: `LOCALHOST:${String(port)}` } })).status).toBe(200);
  });
});

describe('the pages of the shell', () => {
  const json = { 'content-type': 'application/json' };
  const form = {
    organizationName: 'Clínica Prueba',
    ownerName: 'Dra. Ana Gómez',
    ownerEmail: 'ana@clinica.example',
    password: 'una frase larga y privada del consultorio',
    passwordConfirmation: 'una frase larga y privada del consultorio',
    timeZone: 'America/Argentina/Buenos_Aires',
  };

  it('are 404 without the token, with a wrong one, or for another purpose', async () => {
    const setup = vault.issue(PURPOSE.setup);
    vault.issue(PURPOSE.reset);

    expect((await call('/__setup')).status).toBe(404);
    expect((await call('/__setup?t=nope')).status).toBe(404);
    expect((await call(`/__reset?t=${setup}`)).status).toBe(404);
    expect((await call(`/__setup?t=${setup}`)).status).toBe(200);
  });

  it('serve the setup form in Spanish with their own strict policy and no caching', async () => {
    const token = vault.issue(PURPOSE.setup);

    const reply = await call(`/__setup?t=${token}`);

    expect(reply.status).toBe(200);
    const html = reply.body.toString();
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('Nombre del consultorio');
    expect(html).toContain('Zona horaria');
    expect(html).toContain('America/Argentina/Buenos_Aires');
    expect(html).not.toMatch(/<script>|onclick=/);
    expect(reply.headers['content-security-policy']).toContain("script-src 'self'");
    expect(reply.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect((await call('/__assets/page.js')).status).toBe(200);
    expect((await call('/__assets/page.css')).headers['content-type']).toContain('text/css');
  });

  it('run the setup only with the token in the header, as JSON, from their own origin', async () => {
    const token = vault.issue(PURPOSE.setup);
    setupCalls.length = 0;
    const own = `http://localhost:${String(port)}`;

    const noToken = await call('/__setup', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(form),
    });
    const wrongToken = await call('/__setup', {
      method: 'POST',
      headers: { ...json, 'x-consulvia-token': 'wrong' },
      body: JSON.stringify(form),
    });
    const otherSite = await call('/__setup', {
      method: 'POST',
      headers: { ...json, 'x-consulvia-token': token, origin: 'https://evil.example' },
      body: JSON.stringify(form),
    });
    const notJson = await call('/__setup', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-consulvia-token': token },
      body: JSON.stringify(form),
    });
    const good = await call('/__setup', {
      method: 'POST',
      headers: { ...json, 'x-consulvia-token': token, origin: own },
      body: JSON.stringify(form),
    });

    expect([noToken.status, wrongToken.status, otherSite.status]).toEqual([404, 404, 404]);
    expect(notJson.status).toBe(415);
    expect(good.status).toBe(200);
    expect(JSON.parse(good.body.toString())).toEqual({
      ok: true,
      recoveryKey: 'ABCDE-FGHJK',
      ackToken: 'ack-token-for-the-page',
    });
    expect(setupCalls).toHaveLength(1);
    expect(setupCalls[0]).toMatchObject({
      ownerEmail: 'ana@clinica.example',
      timeZone: form.timeZone,
    });
  });

  it('answer the fields that are wrong without calling the action', async () => {
    const token = vault.issue(PURPOSE.setup);
    setupCalls.length = 0;

    const reply = await call('/__setup', {
      method: 'POST',
      headers: { ...json, 'x-consulvia-token': token },
      body: JSON.stringify({
        ...form,
        password: 'password1234',
        passwordConfirmation: 'password1234',
      }),
    });

    expect(reply.status).toBe(422);
    expect(JSON.parse(reply.body.toString())).toMatchObject({
      ok: false,
      errors: { password: expect.stringContaining('muy común') as string },
    });
    expect(setupCalls).toHaveLength(0);
  });

  it('turn the setup page into a 404 for good once the organization exists', async () => {
    const token = vault.issue(PURPOSE.setup);
    provisioned = true;
    try {
      expect((await call(`/__setup?t=${token}`)).status).toBe(404);
      const post = await call('/__setup', {
        method: 'POST',
        headers: { ...json, 'x-consulvia-token': token },
        body: JSON.stringify(form),
      });
      expect(post.status).toBe(404);
    } finally {
      provisioned = false;
    }
  });

  it('refuse a second setup while the first is still running', async () => {
    const token = vault.issue(PURPOSE.setup);
    const headers = { ...json, 'x-consulvia-token': token };
    let release: () => void = () => undefined;
    setupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setupCalls.length = 0;
    try {
      const first = call('/__setup', { method: 'POST', headers, body: JSON.stringify(form) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const second = await call('/__setup', {
        method: 'POST',
        headers,
        body: JSON.stringify(form),
      });
      release();

      expect(second.status).toBe(409);
      expect((await first).status).toBe(200);
      expect(setupCalls).toHaveLength(1);
    } finally {
      setupGate = null;
      release();
    }
  });

  it('reject an oversized or malformed body', async () => {
    const token = vault.issue(PURPOSE.setup);
    const headers = { ...json, 'x-consulvia-token': token };

    expect((await call('/__setup', { method: 'POST', headers, body: '{ not json' })).status).toBe(
      400,
    );
    expect(
      (await call('/__setup', { method: 'POST', headers, body: 'x'.repeat(100_000) })).status,
    ).toBe(400);
  });

  it('reset the password through the reset page, passing the choice about the second factor', async () => {
    const token = vault.issue(PURPOSE.reset);
    const headers = { ...json, 'x-consulvia-token': token };

    const page = await call(`/__reset?t=${token}`);
    const withoutKey = await call('/__reset', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        password: 'otra frase larga para entrar',
        passwordConfirmation: 'otra frase larga para entrar',
      }),
    });
    const cleared = await call('/__reset', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        password: 'otra frase larga para entrar',
        passwordConfirmation: 'otra frase larga para entrar',
        recoveryKey: 'ABCDE-FGHJK',
        clearSecondFactor: true,
      }),
    });
    const mismatch = await call('/__reset', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        password: 'otra frase larga para entrar',
        passwordConfirmation: 'otra',
        recoveryKey: 'ABCDE-FGHJK',
      }),
    });

    expect(page.body.toString()).toContain('Quitar también la verificación en dos pasos');
    expect(page.body.toString()).toContain('name="recoveryKey"');
    expect(withoutKey.status).toBe(422);
    expect(JSON.parse(withoutKey.body.toString())).toMatchObject({
      errors: { recoveryKey: expect.any(String) as string },
    });
    expect(JSON.parse(cleared.body.toString())).toMatchObject({
      ok: true,
      email: 'ana@clinica.example',
      secondFactorCleared: true,
      secondFactorNote: expect.stringContaining('verificación en dos pasos') as string,
    });
    expect(mismatch.status).toBe(422);
  });

  it('shows the recovery key with the box that confirms it, only while it is not confirmed', async () => {
    const token = vault.issue(PURPOSE.ack);
    keyShown = true;

    const page = await call(`/__ack?t=${token}`);
    keyShown = false;
    const confirmed = await call(`/__ack?t=${vault.issue(PURPOSE.ack)}`);
    keyShown = true;

    expect(page.status).toBe(200);
    expect(page.body.toString()).toContain('ABCDE-FGHJK-LMNPQ');
    expect(page.body.toString()).toContain('name="recoveryKeyLast4"');
    expect(confirmed.status).toBe(404);
  });

  it('confirms the key with its last four characters, and refuses fewer or a wrong tail', async () => {
    const token = vault.issue(PURPOSE.ack);
    const headers = { ...json, 'x-consulvia-token': token };
    const post = (value: unknown) =>
      call('/__ack', {
        method: 'POST',
        headers,
        body: JSON.stringify({ recoveryKeyLast4: value }),
      });

    expect((await post('MNPQ')).status).toBe(200);
    expect((await post('ZZZZ')).status).toBe(422);
    expect((await post('MN')).status).toBe(422);
    expect((await post(42)).status).toBe(422);
  });

  it('accepts the confirmation with the token the setup handed over, and not with the one of another page', async () => {
    const ack = vault.issue(PURPOSE.ack);
    const reset = vault.issue(PURPOSE.reset);
    const body = JSON.stringify({ recoveryKeyLast4: 'MNPQ' });

    const withReset = await call('/__ack', {
      method: 'POST',
      headers: { ...json, 'x-consulvia-token': reset },
      body,
    });
    const withAck = await call('/__ack', {
      method: 'POST',
      headers: { ...json, 'x-consulvia-token': ack },
      body,
    });

    expect(withReset.status).toBe(404);
    expect(withAck.status).toBe(200);
  });

  it('checks a typed key without showing anything', async () => {
    const token = vault.issue(PURPOSE.check);
    const headers = { ...json, 'x-consulvia-token': token };
    const page = await call(`/__check?t=${token}`);

    const right = await call('/__check', {
      method: 'POST',
      headers,
      body: JSON.stringify({ recoveryKey: 'ABCDE-FGHJK-LMNPQ' }),
    });
    const wrong = await call('/__check', {
      method: 'POST',
      headers,
      body: JSON.stringify({ recoveryKey: 'AAAAA' }),
    });

    expect(page.status).toBe(200);
    expect(page.body.toString()).not.toContain('ABCDE-FGHJK-LMNPQ');
    expect(right.status).toBe(200);
    expect(wrong.status).toBe(422);
  });

  it('take the recovery key of a backup from another installation', async () => {
    const token = vault.issue(PURPOSE.key);
    const headers = { ...json, 'x-consulvia-token': token };

    const wrong = await call('/__key', {
      method: 'POST',
      headers,
      body: JSON.stringify({ recoveryKey: 'ZZZZZ' }),
    });
    const empty = await call('/__key', {
      method: 'POST',
      headers,
      body: JSON.stringify({ recoveryKey: '  ' }),
    });
    const right = await call('/__key', {
      method: 'POST',
      headers,
      body: JSON.stringify({ recoveryKey: 'ABCDE' }),
    });

    expect(wrong.status).toBe(422);
    expect(JSON.parse(wrong.body.toString())).toMatchObject({
      errors: { recoveryKey: 'La clave de recuperación no es correcta.' },
    });
    expect(empty.status).toBe(422);
    expect(right.status).toBe(200);
  });
});
