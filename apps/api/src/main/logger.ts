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

export function buildLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
}
