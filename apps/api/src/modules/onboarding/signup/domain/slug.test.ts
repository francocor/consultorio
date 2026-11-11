import { describe, expect, it } from 'vitest';

import { RESERVED_SLUGS, SIGNUP_RESERVED_SLUGS, isReservedSlug, signupSlugBase } from './slug.js';

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

describe('the address of a self-service organization', () => {
  it('comes from the name: lowercase, without accents, words joined by hyphens', () => {
    expect(signupSlugBase('Centro Médico Norte')).toBe('centro-medico-norte');
    expect(signupSlugBase('  Clínica   del Sur!! ')).toBe('clinica-del-sur');
  });

  it('is always a valid subdomain, whatever the name', () => {
    for (const name of [
      '',
      '   ',
      '!!!',
      'a',
      '日本語',
      '-x-',
      'x'.repeat(200),
      '9',
      '--',
      '<script>',
    ]) {
      expect(signupSlugBase(name)).toMatch(SLUG_PATTERN);
    }
  });

  it('never is a word the platform or the deployment keeps for itself', () => {
    for (const word of [...RESERVED_SLUGS, ...SIGNUP_RESERVED_SLUGS]) {
      const slug = signupSlugBase(word);

      expect(isReservedSlug(slug), word).toBe(false);
      expect(slug, word).toMatch(SLUG_PATTERN);
    }
    expect(signupSlugBase('Mailpit')).toBe('mailpit-org');
    expect(signupSlugBase('PLATFORM')).toBe('platform-org');
  });

  it('keeps the reserved words free of hyphens, so a generated address with a suffix can never be one', () => {
    for (const word of [...RESERVED_SLUGS, ...SIGNUP_RESERVED_SLUGS]) {
      expect(word, word).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('keeps the list of the signup apart from the one of the console, with no word in both', () => {
    expect(SIGNUP_RESERVED_SLUGS.filter((word) => RESERVED_SLUGS.includes(word))).toEqual([]);
  });
});
