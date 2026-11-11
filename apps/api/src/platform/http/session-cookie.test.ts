import { describe, expect, it } from 'vitest';

import {
  clearSessionCookie,
  readSessionCookie,
  serializeSessionCookie,
  sessionCookieName,
} from './session-cookie.js';

const TOKEN = 'A'.repeat(43);

describe('the name of the session cookie (ASVS 3.4.4)', () => {
  it('carries the __Host- prefix wherever cookies are secure, so a browser refuses any other form of it', () => {
    expect(sessionCookieName(true)).toBe('__Host-sid');
  });

  it('is plain "sid" in plain-http development, where the prefix would make browsers reject it', () => {
    expect(sessionCookieName(false)).toBe('sid');
  });
});

describe('serializing the session cookie', () => {
  it('is HttpOnly, SameSite=Lax, site-wide, Secure and prefixed when the deployment is secure', () => {
    const header = serializeSessionCookie(TOKEN, { secure: true, maxAgeSeconds: 604800 });

    expect(header.split('; ')).toEqual([
      `__Host-sid=${TOKEN}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Secure',
      'Max-Age=604800',
    ]);
  });

  it('meets every condition of the __Host- prefix: Secure, Path=/ and no Domain', () => {
    const header = serializeSessionCookie(TOKEN, { secure: true, maxAgeSeconds: 60 });

    expect(header.startsWith('__Host-')).toBe(true);
    expect(header).toContain('; Secure');
    expect(header).toContain('; Path=/');
    expect(header).not.toMatch(/domain/i);
  });

  it('omits Secure and the prefix for plain-http local development, never HttpOnly or SameSite', () => {
    const header = serializeSessionCookie(TOKEN, { secure: false, maxAgeSeconds: 60 });

    expect(header.startsWith(`sid=${TOKEN}`)).toBe(true);
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

  it('expires the cookie on logout with the same name and attributes', () => {
    const header = clearSessionCookie({ secure: true });

    expect(header).toContain('__Host-sid=;');
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(clearSessionCookie({ secure: false })).toContain('sid=;');
  });
});

describe('reading the session cookie', () => {
  it('finds the session among other cookies, under the name of the deployment', () => {
    expect(readSessionCookie(`theme=dark; __Host-sid=${TOKEN}; lang=es`, { secure: true })).toBe(
      TOKEN,
    );
    expect(readSessionCookie(`sid=${TOKEN}`, { secure: false })).toBe(TOKEN);
  });

  it('ignores the other form of the name: a secure deployment does not accept a plain "sid"', () => {
    expect(readSessionCookie(`sid=${TOKEN}`, { secure: true })).toBeNull();
    expect(readSessionCookie(`__Host-sid=${TOKEN}`, { secure: false })).toBeNull();
  });

  it.each([
    ['no header', undefined],
    ['no session cookie', 'theme=dark'],
    ['an empty value', '__Host-sid='],
    ['a value of the wrong length', '__Host-sid=abc'],
    ['a value with characters outside base64url', `__Host-sid=${'!'.repeat(43)}`],
    ['a cookie that merely ends with the name', `x__Host-sid=${TOKEN}`],
  ])('returns null for %s', (_label, header) => {
    expect(readSessionCookie(header, { secure: true })).toBeNull();
  });

  it('uses the first session cookie when it is sent twice', () => {
    const other = 'B'.repeat(43);

    expect(readSessionCookie(`__Host-sid=${TOKEN}; __Host-sid=${other}`, { secure: true })).toBe(
      TOKEN,
    );
  });
});
