import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The listener that exposes the metrics of a process (`GET /metrics`, Prometheus text format). It is a
 * port of its own, not a route of the application: it has no tenants, no sessions and no host rules,
 * it can be bound to an internal interface, and a process answers it even when its application is
 * busy. It knows one path and one method; with a token it answers nothing to a request that does not
 * carry it, and it never says why a measurement failed.
 */

export interface MetricsServerOptions {
  host: string;
  /** 0 asks the system for a free port (tests). */
  port: number;
  /** The exposition, measured when asked. */
  render(): string | Promise<string>;
  /** A bearer token the scraper must send. Absent: the port itself is the protection. */
  token?: string;
  /** Told when a measurement fails, with nothing the requester could use. */
  onError?: (error: unknown) => void;
}

export interface MetricsServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Compares through a hash of each side, so neither the length nor the content shows in the time taken. */
function sameToken(given: string, expected: string): boolean {
  const left = createHash('sha256').update(given).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function bearerOf(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1] ?? null;
}

function send(
  response: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body = '',
) {
  response.writeHead(status, { 'cache-control': 'no-store', ...headers });
  response.end(body);
}

export function createMetricsServer(options: MetricsServerOptions): MetricsServer {
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== '/metrics') {
      send(response, 404, {});
      return;
    }
    if (request.method !== 'GET') {
      send(response, 405, { allow: 'GET' });
      return;
    }
    if (options.token !== undefined) {
      const given = bearerOf(request);
      if (given === null || !sameToken(given, options.token)) {
        send(response, 401, { 'www-authenticate': 'Bearer' });
        return;
      }
    }
    void (async () => {
      try {
        send(response, 200, { 'content-type': CONTENT_TYPE }, await options.render());
      } catch (error) {
        options.onError?.(error);
        send(
          response,
          500,
          { 'content-type': 'text/plain; charset=utf-8' },
          'metrics unavailable\n',
        );
      }
    })();
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
          server.off('error', reject);
          const address = server.address() as AddressInfo;
          resolve({ host: address.address, port: address.port });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
