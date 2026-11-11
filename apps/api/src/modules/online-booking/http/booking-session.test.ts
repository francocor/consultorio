import { describe, expect, it } from 'vitest';

import {
  bookingCookieName,
  newBookingSessionId,
  readBookingSession,
  serializeBookingSession,
} from './booking-session.js';

describe('anonymous booking session cookie', () => {
  it('takes the __Host- prefix where cookies are secure, and not otherwise', () => {
    expect(bookingCookieName(true)).toBe('__Host-bsid');
    expect(bookingCookieName(false)).toBe('bsid');
  });

  it('is HttpOnly, SameSite=Lax, Path=/ with no Domain, and secure when asked', () => {
    const id = newBookingSessionId();

    const secure = serializeBookingSession(id, { secure: true, maxAgeSeconds: 600 });
    const plain = serializeBookingSession(id, { secure: false, maxAgeSeconds: 600 });

    expect(secure).toBe(`__Host-bsid=${id}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=600`);
    expect(plain).not.toContain('Secure');
    expect(secure).not.toContain('Domain');
  });

  it('reads the session back from a cookie header, and nothing else', () => {
    const id = newBookingSessionId();

    expect(readBookingSession(`a=b; __Host-bsid=${id}; c=d`, { secure: true })).toBe(id);
    expect(readBookingSession(`bsid=${id}`, { secure: true })).toBeNull();
    expect(readBookingSession(undefined, { secure: true })).toBeNull();
    expect(readBookingSession('__Host-bsid=short', { secure: true })).toBeNull();
    expect(readBookingSession(`__Host-bsid=${id}"; admin=1`, { secure: true })).toBeNull();
  });

  it('draws a different 256-bit id every time', () => {
    expect(newBookingSessionId()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newBookingSessionId()).not.toBe(newBookingSessionId());
  });

  it('refuses to write a value that is not an id (it could inject attributes)', () => {
    expect(() =>
      serializeBookingSession('x; Domain=evil.test', { secure: true, maxAgeSeconds: 1 }),
    ).toThrow();
  });
});
