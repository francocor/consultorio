import { describe, expect, it } from 'vitest';

import { formatFileSize } from './file-size.js';

describe('formatFileSize: a size a person reads at a glance, with the decimal comma of es-AR', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [999, '999 B'],
    [1024, '1 KB'],
    [1536, '1,5 KB'],
    [102_400, '100 KB'],
    [1_048_576, '1 MB'],
    [2_000_000, '1,9 MB'],
    [20 * 1024 * 1024, '20 MB'],
  ])('shows %i bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });

  it('never shows a negative or a broken number', () => {
    expect(formatFileSize(-5)).toBe('0 B');
    expect(formatFileSize(Number.NaN)).toBe('0 B');
  });
});
