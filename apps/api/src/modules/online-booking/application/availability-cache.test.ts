import { describe, expect, it } from 'vitest';

import { createAvailabilityCache } from './availability-cache.js';

describe('availability cache', () => {
  function build() {
    let now = 1_000_000;
    const cache = createAvailabilityCache<string>({ ttlMs: 30_000, now: () => now });
    return {
      cache,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('answers from memory inside the window and computes again once it passed', async () => {
    const { cache, advance } = build();
    let computed = 0;
    const compute = () => {
      computed += 1;
      return Promise.resolve(`answer ${String(computed)}`);
    };

    expect(await cache.get('t1', 'k', compute)).toBe('answer 1');
    advance(29_999);
    expect(await cache.get('t1', 'k', compute)).toBe('answer 1');
    advance(2);
    expect(await cache.get('t1', 'k', compute)).toBe('answer 2');
  });

  it('keeps one answer per key', async () => {
    const { cache } = build();

    expect(await cache.get('t1', 'a', () => Promise.resolve('A'))).toBe('A');
    expect(await cache.get('t1', 'b', () => Promise.resolve('B'))).toBe('B');
  });

  it('forgets the answers of one organization when it is told something changed', async () => {
    const { cache } = build();
    await cache.get('t1', 'k', () => Promise.resolve('old'));
    await cache.get('t2', 'k', () => Promise.resolve('other'));

    cache.invalidate('t1');

    expect(await cache.get('t1', 'k', () => Promise.resolve('new'))).toBe('new');
    expect(await cache.get('t2', 'k', () => Promise.resolve('changed'))).toBe('other');
  });

  it('does not keep a failure', async () => {
    const { cache } = build();
    await expect(cache.get('t1', 'k', () => Promise.reject(new Error('boom')))).rejects.toThrow();

    expect(await cache.get('t1', 'k', () => Promise.resolve('fine'))).toBe('fine');
  });

  it('is bounded, dropping the oldest entries', async () => {
    const cache = createAvailabilityCache<number>({ ttlMs: 30_000, maxEntries: 2, now: () => 0 });
    await cache.get('t', 'a', () => Promise.resolve(1));
    await cache.get('t', 'b', () => Promise.resolve(2));
    await cache.get('t', 'c', () => Promise.resolve(3));

    let recomputed = false;
    await cache.get('t', 'a', () => {
      recomputed = true;
      return Promise.resolve(1);
    });

    expect(recomputed).toBe(true);
    expect(cache.size()).toBeLessThanOrEqual(2);
  });
});
