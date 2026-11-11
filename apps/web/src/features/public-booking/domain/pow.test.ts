import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { leadingZeroBits, parsePuzzle, sha256, solvePuzzle } from './pow.js';

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('sha256', () => {
  it.each([
    '',
    'abc',
    'The quick brown fox jumps over the lazy dog',
    // The edges of one block: 55 bytes fit with the padding, 56 need a second block.
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'a'.repeat(120),
    'id-with-base64url_-chars.123456',
    'ñandú.0',
  ])('agrees with the platform for %j', (text) => {
    expect(hex(sha256(encoder.encode(text)))).toBe(createHash('sha256').update(text).digest('hex'));
  });
});

describe('leadingZeroBits', () => {
  it.each([
    [[0x80], 0],
    [[0x40], 1],
    [[0x01], 7],
    [[0x00, 0x80], 8],
    [[0x00, 0x00, 0x0f], 20],
    [[0x00, 0x00], 16],
  ])('counts the zero bits at the start of %j', (bytes, expected) => {
    expect(leadingZeroBits(Uint8Array.from(bytes))).toBe(expected);
  });
});

describe('parsePuzzle', () => {
  const payload = {
    algorithm: 'sha256-leading-zero-bits',
    id: 'abc',
    difficulty: 12,
    expiresAt: 1_700_000_000_000,
    signature: 'sig',
  };

  it('reads the puzzle the server issues', () => {
    expect(parsePuzzle({ kind: 'pow', payload })).toEqual({
      id: 'abc',
      difficulty: 12,
      expiresAt: 1_700_000_000_000,
      signature: 'sig',
    });
  });

  it('knows the challenges that need nothing to solve', () => {
    expect(parsePuzzle({ kind: 'fake', payload: {} })).toBeNull();
  });

  it('refuses a puzzle it cannot read, or one that would cost too much', () => {
    expect(() => parsePuzzle({ kind: 'pow', payload: { ...payload, id: 7 } })).toThrow();
    expect(() => parsePuzzle({ kind: 'pow', payload: { ...payload, difficulty: 40 } })).toThrow();
    expect(() => parsePuzzle({ kind: 'turnstile', payload: {} })).toThrow();
  });
});

describe('solvePuzzle', () => {
  it('finds a nonce whose hash has the zero bits, and answers in the format the server reads', () => {
    const puzzle = {
      id: 'AbCdEf-12_xyz',
      difficulty: 10,
      expiresAt: 1_900_000_000_000,
      signature: 'sig',
    };

    const proof = solvePuzzle(puzzle);

    const [id, difficulty, expiresAt, signature, nonce] = proof.split('.');
    expect([id, difficulty, expiresAt, signature]).toEqual([
      'AbCdEf-12_xyz',
      '10',
      '1900000000000',
      'sig',
    ]);
    const digest = createHash('sha256')
      .update(`${id ?? ''}.${nonce ?? ''}`)
      .digest();
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(10);
  });

  it('is quick at the difficulty the server asks for in production (16 bits)', () => {
    const started = performance.now();

    solvePuzzle({ id: 'speed-test', difficulty: 16, expiresAt: 1, signature: 's' });

    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
