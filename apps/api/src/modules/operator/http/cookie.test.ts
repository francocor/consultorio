import { describe, expect, it } from 'vitest';

import {
  clearOperatorCookie,
  operatorCookieName,
  readOperatorCookie,
  serializeOperatorCookie,
} from './cookie.js';

const TOKEN = 'O'.repeat(43);

describe('the operator session cookie (ASVS 3.4.4)', () => {
  it('takes the __Host- prefix where cookies are secure, and a plain name in local http', () => {
    expect(operatorCookieName(true)).toBe('__Host-osid');
    expect(operatorCookieName(false)).toBe('osid');
  });

  it('is Secure, Path=/, SameSite=Strict, without Domain, as the prefix demands', () => {
    const header = serializeOperatorCookie(TOKEN, { secure: true, maxAgeSeconds: 600 });

    expect(header.split('; ')).toEqual([
      `__Host-osid=${TOKEN}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Secure',
      'Max-Age=600',
    ]);
    expect(clearOperatorCookie({ secure: true })).toContain('__Host-osid=;');
  });

  it('reads only the name of its deployment', () => {
    expect(readOperatorCookie(`a=b; __Host-osid=${TOKEN}`, { secure: true })).toBe(TOKEN);
    expect(readOperatorCookie(`osid=${TOKEN}`, { secure: true })).toBeNull();
    expect(readOperatorCookie(`osid=${TOKEN}`, { secure: false })).toBe(TOKEN);
  });
});
