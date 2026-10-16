/** The operator session cookie. Tenant staff use `sid`; the two never mix (ADR-008). */
export const OPERATOR_COOKIE = 'osid';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface CookieOptions {
  secure: boolean;
}

function attributes(pair: string, options: CookieOptions, maxAgeSeconds: number): string {
  // SameSite=Strict: the console is only ever used from its own page, so no cross-site request
  // carries the cookie at all. HttpOnly keeps scripts away from it and there is no Domain, so it
  // belongs to the exact platform host.
  return [
    pair,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
    `Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}`,
  ].join('; ');
}

export function serializeOperatorCookie(
  token: string,
  options: CookieOptions & { maxAgeSeconds: number },
): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error('not a session token');
  return attributes(`${OPERATOR_COOKIE}=${token}`, options, options.maxAgeSeconds);
}

export function clearOperatorCookie(options: CookieOptions): string {
  return attributes(`${OPERATOR_COOKIE}=`, options, 0);
}

/** The token in a `Cookie` header, or null when absent or malformed. The first one wins. */
export function readOperatorCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== OPERATOR_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}
