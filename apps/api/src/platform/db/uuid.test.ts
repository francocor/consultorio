import { describe, expect, it } from 'vitest';

import { createUuidV7Generator, uuidv7 } from './uuid.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('has the version 7 and RFC 9562 variant bits', () => {
    expect(uuidv7()).toMatch(UUID_V7);
  });

  it('starts with the millisecond timestamp it was given', () => {
    const at = Date.UTC(2026, 9, 15, 12, 0, 0);

    const id = createUuidV7Generator()(at);

    // First 48 bits = 12 hex digits, split by the first hyphen.
    expect(Number.parseInt(id.replace('-', '').slice(0, 12), 16)).toBe(at);
  });

  it('orders by time: a later timestamp sorts after an earlier one', () => {
    const next = createUuidV7Generator();

    expect(next(1_800_000_000_000) < next(1_800_000_000_001)).toBe(true);
    expect(next(1_800_000_000_001) < next(1_900_000_000_000)).toBe(true);
  });

  it('stays strictly increasing and unique within the same millisecond', () => {
    const next = createUuidV7Generator();
    const at = 1_800_000_100_000;
    const ids = Array.from({ length: 5000 }, () => next(at));

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
  });

  it('keeps ordering when the clock goes backwards', () => {
    const next = createUuidV7Generator();
    const first = next(1_800_000_200_000);
    const second = next(1_800_000_100_000);

    expect(second > first).toBe(true);
  });
});
