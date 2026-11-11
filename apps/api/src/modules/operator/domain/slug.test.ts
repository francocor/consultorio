import { describe, expect, it } from 'vitest';

import { RESERVED_SLUGS, slugBase, slugWithSuffix } from './slug.js';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

describe('slugBase', () => {
  it('lowercases, drops accents and joins words with hyphens', () => {
    expect(slugBase('Centro Médico Norte')).toBe('centro-medico-norte');
    expect(slugBase('  Clínica   del Sur!! ')).toBe('clinica-del-sur');
    expect(slugBase('Ñandú & Hijos S.R.L.')).toBe('nandu-hijos-s-r-l');
  });

  it('always yields a valid slug, whatever the name', () => {
    for (const name of ['', '   ', '!!!', 'a', '日本語', '-x-', 'x'.repeat(200), '9', '--']) {
      expect(slugBase(name)).toMatch(SLUG_PATTERN);
    }
  });

  it('keeps room for a collision suffix', () => {
    expect(slugBase('x'.repeat(200)).length).toBeLessThanOrEqual(40);
  });

  it('never returns a reserved word, which would shadow a platform address', () => {
    for (const word of RESERVED_SLUGS) {
      expect(RESERVED_SLUGS).not.toContain(slugBase(word));
      expect(slugBase(word)).toMatch(SLUG_PATTERN);
    }
  });
});

describe('slugWithSuffix', () => {
  it('appends the suffix and stays a valid slug within 63 characters', () => {
    const slug = slugWithSuffix('x'.repeat(40), 'a1b2');

    expect(slug).toBe(`${'x'.repeat(40)}-a1b2`);
    expect(slug).toMatch(SLUG_PATTERN);
    expect(slug.length).toBeLessThanOrEqual(63);
  });
});
