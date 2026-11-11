import { describe, expect, it } from 'vitest';

import { maskEmail } from './mask.js';

describe('masking an address', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('madre.gomez@example.test')).toBe('m***@example.test');
    expect(maskEmail('a@b.co')).toBe('a***@b.co');
  });

  it('hides everything of something that is not an address', () => {
    expect(maskEmail('')).toBe('***');
    expect(maskEmail('sin-arroba')).toBe('***');
    expect(maskEmail('@dominio.test')).toBe('***');
  });
});
