import pg from 'pg';

/**
 * Counts the statements the application sends to Postgres while `work` runs. It wraps the query
 * method of the driver, so it sees everything: the pooled connections of the request, the
 * transaction statements and the session settings. Two code paths that must be indistinguishable to
 * a visitor have to send the same number of them.
 */
export async function countQueries(work: () => Promise<unknown>): Promise<number> {
  const prototype = pg.Client.prototype as unknown as {
    query: (this: unknown, ...args: unknown[]) => unknown;
  };
  const original = prototype.query;
  let count = 0;
  prototype.query = function (this: unknown, ...args: unknown[]) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    await work();
  } finally {
    prototype.query = original;
  }
  return count;
}

/**
 * The parts of an answer a visitor can compare: the status, the headers that vary by route, and the
 * body with the values that differ by request (ids, times, tokens) taken out.
 */
export function shapeOf(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
}): string {
  const body = response.body
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
    .replace(/[A-Za-z0-9_-]{43}/g, '<token>');
  const header = (name: string) => {
    const value = response.headers[name];
    return typeof value === 'string' ? value : '';
  };
  return JSON.stringify({
    status: response.statusCode,
    type: header('content-type').split(';')[0],
    csp: header('content-security-policy'),
    referrer: header('referrer-policy'),
    body,
  });
}
