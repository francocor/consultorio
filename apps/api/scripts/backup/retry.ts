/**
 * A small, bounded retry for the calls of the backup tools to the object store. A connection that
 * the store resets under load is not an answer about the bucket: asking again is. Only errors that
 * say "the network failed" are retried; every other error (a refusal, a missing bucket, a guard of
 * our own) is thrown at once, so a check that depends on the answer still fails closed.
 */

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
]);

const MAX_DEPTH = 4;

export function isTransientNetworkError(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > MAX_DEPTH) return false;
  const { code } = error as { code?: unknown };
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  if (/socket hang up/i.test(error.message)) return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status !== undefined && status >= 500) return true;
  return isTransientNetworkError((error as { cause?: unknown }).cause, depth + 1);
}

export interface RetryOptions {
  /** Calls made in total, the first one included. */
  attempts?: number;
  /** First wait in milliseconds; each wait doubles. */
  baseDelayMs?: number;
  /** Replaced in tests, so they do not sleep. */
  wait?: (ms: number) => Promise<void>;
}

export async function withTransientRetry<T>(
  call: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  const base = options.baseDelayMs ?? 250;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
      await wait(base * 2 ** (attempt - 1));
    }
  }
}
