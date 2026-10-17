/**
 * The operator session cookie. Tenant staff use `sid`; the two never mix (ADR-008). Like the staff
 * cookie it carries the `__Host-` prefix wherever cookies are secure (ASVS 3.4.4), and is plain
 * `osid` only in plain-http local development.
 */
export function operatorCookieName(secure: boolean): string {
  return secure ? '__Host-osid' : 'osid';
}

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
  return attributes(
    `${operatorCookieName(options.secure)}=${token}`,
    options,
    options.maxAgeSeconds,
  );
}

export function clearOperatorCookie(options: CookieOptions): string {
  return attributes(`${operatorCookieName(options.secure)}=`, options, 0);
}

/** The token in a `Cookie` header, or null when absent or malformed. The first one wins. */
export function readOperatorCookie(
  header: string | undefined,
  options: CookieOptions,
): string | null {
  if (header === undefined) return null;
  const name = operatorCookieName(options.secure);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}
