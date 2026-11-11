import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalJson, contentHash } from './canonical.js';

describe('canonicalJson', () => {
  it('writes object keys in sorted order, whatever order they came in', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested objects and keeps the order of arrays', () => {
    expect(canonicalJson({ z: [{ y: 1, x: 2 }, 3], a: { d: 1, c: 2 } })).toBe(
      '{"a":{"c":2,"d":1},"z":[{"x":2,"y":1},3]}',
    );
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('drops members that are undefined, like JSON, and keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('keeps accents and symbols as they are', () => {
    expect(canonicalJson({ nota: 'Hipertensión – “leve”' })).toBe(
      '{"nota":"Hipertensión – “leve”"}',
    );
  });

  it('is the same text for the same content (property)', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer())), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        return canonicalJson(record) === canonicalJson(reversed);
      }),
    );
  });
});

describe('contentHash', () => {
  it('is the SHA-256 in hex of the canonical text', () => {
    const expected = createHash('sha256').update('{"a":1}', 'utf8').digest('hex');

    expect(contentHash({ a: 1 })).toBe(expected);
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order, and changes with any change of content', () => {
    expect(contentHash({ a: 1, b: 'x' })).toBe(contentHash({ b: 'x', a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: 'Dx A' })).not.toBe(contentHash({ a: 'Dx B' }));
  });
});
