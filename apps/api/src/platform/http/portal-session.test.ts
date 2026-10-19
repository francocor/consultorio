import { describe, expect, it } from 'vitest';

import {
  clearPortalCookie,
  portalCookieName,
  readPortalCookie,
  serializePortalCookie,
} from './portal-session.js';
import { sessionCookieName } from './session-cookie.js';

const TOKEN = 'P'.repeat(43);

describe('the name of the portal cookie', () => {
  it('carries the __Host- prefix wherever cookies are secure, and is plain in plain-http development', () => {
    expect(portalCookieName(true)).toBe('__Host-psid');
    expect(portalCookieName(false)).toBe('psid');
  });

  it('is never the name of the staff cookie, so neither door can read the other', () => {
    expect(portalCookieName(true)).not.toBe(sessionCookieName(true));
    expect(portalCookieName(false)).not.toBe(sessionCookieName(false));
  });
});

describe('serializing the portal cookie', () => {
  it('is HttpOnly, SameSite=Strict, site-wide, Secure and prefixed when the deployment is secure', () => {
    const header = serializePortalCookie(TOKEN, { secure: true, maxAgeSeconds: 43200 });

    expect(header.split('; ')).toEqual([
      `__Host-psid=${TOKEN}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Secure',
      'Max-Age=43200',
    ]);
    expect(header).not.toMatch(/domain/i);
  });

  it('omits Secure and the prefix in plain-http development, never HttpOnly or SameSite', () => {
    const header = serializePortalCookie(TOKEN, { secure: false, maxAgeSeconds: 60 });

    expect(header.startsWith(`psid=${TOKEN}`)).toBe(true);
    expect(header).not.toContain('Secure');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
  });

  it('refuses a value that is not a session token (no header injection)', () => {
    expect(() =>
      serializePortalCookie('a; Domain=evil.example', { secure: true, maxAgeSeconds: 1 }),
    ).toThrow();
    expect(() => serializePortalCookie('short', { secure: true, maxAgeSeconds: 1 })).toThrow();
  });

  it('expires the cookie with the same name and attributes', () => {
    const header = clearPortalCookie({ secure: true });

    expect(header).toContain('__Host-psid=;');
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(clearPortalCookie({ secure: false })).toContain('psid=;');
  });
});

describe('reading the portal cookie', () => {
  it('finds it among other cookies, under the name of the deployment', () => {
    expect(readPortalCookie(`theme=dark; __Host-psid=${TOKEN}; lang=es`, { secure: true })).toBe(
      TOKEN,
    );
    expect(readPortalCookie(`psid=${TOKEN}`, { secure: false })).toBe(TOKEN);
  });

  it('does not take the staff cookie for it, in either deployment', () => {
    expect(readPortalCookie(`__Host-sid=${TOKEN}`, { secure: true })).toBeNull();
    expect(readPortalCookie(`sid=${TOKEN}`, { secure: false })).toBeNull();
  });

  it('is null for no cookie, another name, a wrong name for the deployment or a malformed value', () => {
    expect(readPortalCookie(undefined, { secure: true })).toBeNull();
    expect(readPortalCookie('a=b', { secure: true })).toBeNull();
    expect(readPortalCookie(`psid=${TOKEN}`, { secure: true })).toBeNull();
    expect(readPortalCookie('__Host-psid=short', { secure: true })).toBeNull();
    expect(readPortalCookie(`__Host-psid=${TOKEN}x`, { secure: true })).toBeNull();
  });

  it('takes the first one if it is sent twice', () => {
    const other = 'Q'.repeat(43);

    expect(readPortalCookie(`__Host-psid=${TOKEN}; __Host-psid=${other}`, { secure: true })).toBe(
      TOKEN,
    );
  });
});
