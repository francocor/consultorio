/** Name of the staff session cookie. Patient portal sessions use a separate cookie (ADR-008). */
export const SESSION_COOKIE = 'sid';

/** A 256-bit token in unpadded base64url is always 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface CookieOptions {
  /** Adds `Secure`. True everywhere except plain-http local development. */
  secure: boolean;
}

/**
 * `Set-Cookie` value for a session token: `HttpOnly` (scripts cannot read it), `SameSite=Lax`
 * (not sent on cross-site POSTs; the Origin check covers the rest), `Path=/` and no `Domain`, so
 * the cookie belongs to the exact host of the tenant and is never shared with sibling tenants.
 * The value must look like a token: anything else could inject attributes into the header.
 */
export function serializeSessionCookie(
  token: string,
  options: CookieOptions & { maxAgeSeconds: number },
): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error('not a session token');
  return attributes(`${SESSION_COOKIE}=${token}`, options, options.maxAgeSeconds);
}

/** `Set-Cookie` value that removes the session cookie (same attributes, empty value). */
export function clearSessionCookie(options: CookieOptions): string {
  return attributes(`${SESSION_COOKIE}=`, options, 0);
}

function attributes(pair: string, options: CookieOptions, maxAgeSeconds: number): string {
  return [
    pair,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(options.secure ? ['Secure'] : []),
    `Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}`,
  ].join('; ');
}

/**
 * The session token from a `Cookie` header, or null when there is none or it is malformed. A
 * malformed value never reaches the database. If the cookie is sent twice the first one wins.
 */
export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}
