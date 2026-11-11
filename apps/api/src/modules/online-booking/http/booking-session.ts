import { randomBytes } from 'node:crypto';

/**
 * The anonymous booking session: a random id the browser keeps while a visitor holds a slot and
 * completes the form. It identifies no person (the server keeps only its hash, on the hold) and
 * is not a login. It has the attributes of the session cookie of the staff app: `HttpOnly`,
 * `SameSite=Lax`, `Path=/`, no `Domain`, and the `__Host-` prefix wherever cookies are secure.
 */
export function bookingCookieName(secure: boolean): string {
  return secure ? '__Host-bsid' : 'bsid';
}

const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newBookingSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function serializeBookingSession(
  id: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  if (!ID_PATTERN.test(id)) throw new Error('not a booking session id');
  return [
    `${bookingCookieName(options.secure)}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
  ].join('; ');
}

/** The id from a `Cookie` header, or null when there is none or it is malformed. */
export function readBookingSession(
  header: string | undefined,
  options: { secure: boolean },
): string | null {
  if (header === undefined) return null;
  const name = bookingCookieName(options.secure);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return ID_PATTERN.test(value) ? value : null;
  }
  return null;
}
