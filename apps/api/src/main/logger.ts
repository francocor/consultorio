import type { LoggerOptions } from 'pino';

/**
 * Paths whose values are never written to logs: credentials, cookies and request or response
 * bodies (clinical routes carry health data, so bodies are never logged).
 */
export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
  'body',
  '*.body',
];

/** Returns the URL path without its query string or fragment. */
export function stripQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

interface LoggableRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
}

/**
 * Request serializer for log lines. The query string is dropped because action tokens (password
 * reset, invitations) and search terms travel there and must never reach the logs.
 */
export function serializeRequest(request: LoggableRequest) {
  return {
    method: request.method,
    url: stripQuery(request.url ?? ''),
    host: request.host,
    remoteAddress: request.ip,
  };
}

export function buildLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    serializers: { req: serializeRequest },
  };
}
