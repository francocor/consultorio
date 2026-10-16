import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE,
  clearSessionCookie,
  readSessionCookie,
  serializeSessionCookie,
} from './session-cookie.js';

const TOKEN = 'A'.repeat(43);

describe('serializing the session cookie', () => {
  it('is HttpOnly, SameSite=Lax, site-wide and Secure when the deployment is secure', () => {
    const header = serializeSessionCookie(TOKEN, { secure: true, maxAgeSeconds: 604800 });

    expect(header.split('; ')).toEqual([
      `${SESSION_COOKIE}=${TOKEN}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Secure',
      'Max-Age=604800',
    ]);
  });

  it('omits Secure for plain-http local development, never HttpOnly or SameSite', () => {
    const header = serializeSessionCookie(TOKEN, { secure: false, maxAgeSeconds: 60 });

    expect(header).not.toContain('Secure');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Domain');
  });

  it('refuses a value that is not a session token (no header injection)', () => {
    expect(() =>
      serializeSessionCookie('a; Domain=evil.example', { secure: true, maxAgeSeconds: 1 }),
    ).toThrow();
    expect(() => serializeSessionCookie('short', { secure: true, maxAgeSeconds: 1 })).toThrow();
  });

  it('expires the cookie on logout with the same attributes', () => {
    const header = clearSessionCookie({ secure: true });

    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
  });
});

describe('reading the session cookie', () => {
  it('finds the session among other cookies', () => {
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE}=${TOKEN}; lang=es`)).toBe(TOKEN);
    expect(readSessionCookie(`${SESSION_COOKIE}=${TOKEN}`)).toBe(TOKEN);
  });

  it.each([
    ['no header', undefined],
    ['no session cookie', 'theme=dark'],
    ['an empty value', `${SESSION_COOKIE}=`],
    ['a value of the wrong length', `${SESSION_COOKIE}=abc`],
    ['a value with characters outside base64url', `${SESSION_COOKIE}=${'!'.repeat(43)}`],
    ['a cookie that merely ends with the name', `x${SESSION_COOKIE}=${TOKEN}`],
  ])('returns null for %s', (_label, header) => {
    expect(readSessionCookie(header)).toBeNull();
  });

  it('uses the first session cookie when it is sent twice', () => {
    const other = 'B'.repeat(43);

    expect(readSessionCookie(`${SESSION_COOKIE}=${TOKEN}; ${SESSION_COOKIE}=${other}`)).toBe(TOKEN);
  });
});
