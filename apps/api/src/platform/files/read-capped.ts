import type { Readable } from 'node:stream';

export type CappedRead = { ok: true; bytes: Buffer } | { ok: false };

/**
 * Reads a stream into memory, up to `maxBytes`. Past the cap it stops reading at once and reports
 * `{ ok: false }`, so a huge object is refused after `maxBytes + 1` bytes, not after all of them.
 * A failure of the stream itself rejects.
 */
export async function readCapped(stream: Readable, maxBytes: number): Promise<CappedRead> {
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for await (const part of stream) {
      const bytes = typeof part === 'string' ? Buffer.from(part) : (part as Buffer);
      total += bytes.length;
      if (total > maxBytes) return { ok: false };
      parts.push(bytes);
    }
  } finally {
    stream.destroy();
  }
  return { ok: true, bytes: Buffer.concat(parts, total) };
}
