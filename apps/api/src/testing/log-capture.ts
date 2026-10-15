import { Writable } from 'node:stream';

export interface LogCapture {
  stream: Writable;
  /** Parsed JSON log lines written so far. */
  lines(): Record<string, unknown>[];
  /** Raw output, for asserting that a value never appears anywhere. */
  raw(): string;
}

/** Captures pino output in memory so tests can assert on what was (and was not) logged. */
export function captureLogs(): LogCapture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const raw = () => chunks.join('');
  return {
    stream,
    raw,
    lines: () =>
      raw()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
