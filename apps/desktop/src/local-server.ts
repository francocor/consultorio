import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { InternalPages } from './internal-pages.js';
import { forwardToApi, routeOf } from './proxy.js';
import { serveStatic } from './static-files.js';
import { presentsProof, type Credentials } from './window-proof.js';

/**
 * The Content Security Policy the web build wrote for the bundle (`dist/content-security-policy.txt`).
 * Returns `null` when the file is missing: the server then refuses to send the bundle without a policy.
 */
export function loadContentSecurityPolicy(webRoot: string): string | null {
  try {
    const text = readFileSync(join(webRoot, 'content-security-policy.txt'), 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

export interface LocalServerOptions {
  port: number;
  /** `apps/web/dist` */
  webRoot: string;
  /** The value of `Content-Security-Policy` for the bundle. */
  contentSecurityPolicy: string;
  /** The port of the API now, or `null` while it is not up. */
  apiPort: () => number | null;
  /** The secret of this run that the API demands of every request; `null` while the API is not up. */
  proxySecret: () => string | null;
  pages: InternalPages;
  /** What proves a request comes from a window of the shell (see `window-proof.ts`). */
  credentials: Credentials;
  log?: (message: string) => void;
}

const FORBIDDEN_BODY = JSON.stringify({
  title:
    'Solicitud no autorizada. Abra Consulvia desde su acceso directo o desde el icono de la bandeja.',
  status: 403,
});

const UNAVAILABLE_BODY = JSON.stringify({
  title: 'Consulvia se está iniciando. Espere unos segundos y vuelva a intentar.',
  status: 503,
});

/**
 * The server the window talks to, on `127.0.0.1` only: the web bundle with its policy, the reverse proxy
 * to the API, and the pages of the shell. A request is served only when its `Host` is this server's own
 * name and port, which stops a web page on the internet from reaching the clinic's data through the
 * victim's browser by pointing its own domain at 127.0.0.1 (DNS rebinding).
 */
export function createLocalServer(options: LocalServerOptions) {
  // `localhost` is accepted for whoever types it, but the window never uses it (see `window-proof.ts`).
  const hosts = new Set([`localhost:${String(options.port)}`, `127.0.0.1:${String(options.port)}`]);
  const bundleHeaders = { 'Content-Security-Policy': options.contentSecurityPolicy };

  function unavailable(response: ServerResponse): void {
    response.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '3',
      'Cache-Control': 'no-store',
    });
    response.end(UNAVAILABLE_BODY);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = (request.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) {
      response.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Host no permitido');
      return;
    }
    if (await options.pages.handle(request, response)) return;

    const target = request.url ?? '/';
    const route = routeOf(target);
    if (route) {
      // The API is reached only by a window of the shell, or by the browser the owner opened through it. The
      // public pages and the manifest go through without it: they are public by design.
      if (route.kind === 'api' && !presentsProof(request.headers, options.credentials)) {
        options.log?.('a request to the API without the proof of the window was refused');
        response.writeHead(403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(FORBIDDEN_BODY);
        return;
      }
      forwardToApi(
        {
          apiPort: options.apiPort,
          proxySecret: options.proxySecret,
          unavailable,
          ...(options.log ? { log: options.log } : {}),
        },
        request,
        response,
        route,
      );
      return;
    }
    const queryStart = target.indexOf('?');
    await serveStatic(
      { root: options.webRoot, headers: bundleHeaders },
      request,
      response,
      queryStart === -1 ? target : target.slice(0, queryStart),
    );
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      options.log?.(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Error interno');
      }
    });
  });
  // A document upload or download can take longer than the defaults allow, and the peer is this PC.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port: options.port, host: '127.0.0.1', exclusive: true }, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

export type LocalServer = ReturnType<typeof createLocalServer>;
