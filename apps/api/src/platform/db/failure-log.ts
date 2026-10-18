/**
 * The only parts of a failure that may be written to a log: the class of the error and its database
 * code (`23505`, `22012`, ...). Never the message: a Postgres or Drizzle message can carry the
 * statement, its parameters and the values of a row (JD-S3 follow-up).
 *
 * Drizzle wraps the driver error, so the code is on `cause` for a query and on the error itself for
 * a bare driver error.
 */
export function describeFailure(error: unknown): { name: string; code: string } {
  const carrier = (error ?? {}) as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
  const code = [carrier.cause?.code, carrier.code].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
  );
  return {
    name: typeof carrier.name === 'string' && carrier.name !== '' ? carrier.name : 'unknown',
    code: code ?? 'unknown',
  };
}
