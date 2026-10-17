import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readCapped } from './read-capped.js';

describe('readCapped: read a stream into memory, but never more than the cap', () => {
  it('returns every byte of a stream within the cap, in order', async () => {
    const result = await readCapped(Readable.from([Buffer.from('abc'), Buffer.from('def')]), 10);

    expect(result).toEqual({ ok: true, bytes: Buffer.from('abcdef') });
  });

  it('accepts a stream of exactly the cap', async () => {
    const result = await readCapped(Readable.from([Buffer.alloc(5, 1), Buffer.alloc(5, 2)]), 10);

    expect(result.ok && result.bytes.length).toBe(10);
  });

  it('stops at the first byte over the cap and does not read the rest', async () => {
    let produced = 0;
    async function* endless() {
      for (;;) {
        produced += 1;
        await Promise.resolve();
        yield Buffer.alloc(1000, 0x41);
      }
    }

    const result = await readCapped(Readable.from(endless()), 5_000);

    expect(result).toEqual({ ok: false });
    expect(produced).toBeLessThan(20);
  });

  it('treats an empty stream as empty bytes, not as a failure', async () => {
    const result = await readCapped(Readable.from([]), 10);

    expect(result).toEqual({ ok: true, bytes: Buffer.alloc(0) });
  });

  it('rejects when the stream itself fails', async () => {
    async function* broken() {
      await Promise.resolve();
      yield Buffer.from('x');
      throw new Error('socket closed');
    }

    await expect(readCapped(Readable.from(broken()), 10)).rejects.toThrow('socket closed');
  });
});
