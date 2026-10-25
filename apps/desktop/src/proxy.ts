import { Agent, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The reverse proxy of docs/dev-setup.md ("Reverse proxy contract"), for the local server.
 *
 * - `/api/*` goes to the API with the `/api` prefix removed.
 * - `/manifest.webmanifest`, `/public/branding/logo`, `/public/t/*` and `/public/v/*` go untouched.
 * - The `Host` and `Origin` headers reach the API exactly as the browser sent them: the API rejects a
 *   state-changing request whose `Origin` host is not its `Host`.
 * - Bodies are piped in both directions, never buffered: uploads and downloads can be large.
 */

/** Hop-by-hop headers belong to one connection and are not forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const UNTOUCHED_EXACT = new Set(['/manifest.webmanifest', '/public/branding/logo']);
const UNTOUCHED_PREFIXES = ['/public/t/', '/public/v/'];

export type Route = { kind: 'api'; path: string } | { kind: 'untouched'; path: string } | null;

/** Where a request for `pathAndQuery` goes: the API (rewritten or not), or `null` for the web bundle. */
export function routeOf(pathAndQuery: string): Route {
  const queryStart = pathAndQuery.indexOf('?');
  const path = queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart);
  const query = queryStart === -1 ? '' : pathAndQuery.slice(queryStart);
  if (path === '/api' || path.startsWith('/api/')) {
    const rest = path.slice('/api'.length);
    return { kind: 'api', path: (rest === '' ? '/' : rest) + query };
  }
  if (UNTOUCHED_EXACT.has(path) || UNTOUCHED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return { kind: 'untouched', path: pathAndQuery };
  }
  return null;
}

/** The header that tells the API a request came through this server (see `desktop-guard.ts` in the API). */
export const PROXY_HEADER = 'x-consulvia-proxy';

export interface ProxyOptions {
  /** The port the API listens on now; `null` while it is not running. */
  apiPort: () => number | null;
  /** The secret of this run that the API demands; `null` while the API is not running. */
  proxySecret: () => string | null;
  /** Shown when the API is not reachable. */
  unavailable: (response: ServerResponse) => void;
  log?: (message: string) => void;
}

const agent = new Agent({ keepAlive: true, maxSockets: 64 });

export function forwardToApi(
  options: ProxyOptions,
  request: IncomingMessage,
  response: ServerResponse,
  route: NonNullable<Route>,
): void {
  const port = options.apiPort();
  const secret = options.proxySecret();
  if (port === null || secret === null) {
    options.unavailable(response);
    return;
  }
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    // A page cannot pass for this server: whatever it sent under our header is dropped.
    if (value === undefined || HOP_BY_HOP.has(name) || name === PROXY_HEADER) continue;
    headers[name] = value;
  }
  headers[PROXY_HEADER] = secret;
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      method: request.method,
      path: route.path,
      headers,
      agent,
    },
    (answer) => {
      const answerHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        answerHeaders[name] = value;
      }
      // Whatever the API did not mark cacheable is not kept: sessions, patients and documents are here.
      if (answerHeaders['cache-control'] === undefined) answerHeaders['cache-control'] = 'no-store';
      response.writeHead(answer.statusCode ?? 502, answerHeaders);
      answer.pipe(response);
      answer.on('error', () => {
        response.destroy();
      });
    },
  );
  upstream.on('error', (error) => {
    options.log?.(`proxy error: ${error.message}`);
    if (response.headersSent) response.destroy();
    else options.unavailable(response);
  });
  // The browser went away (a cancelled upload or download): end the upstream request too.
  response.on('close', () => {
    if (!response.writableEnded) upstream.destroy();
  });
  request.on('aborted', () => {
    upstream.destroy();
  });
  request.pipe(upstream);
}
