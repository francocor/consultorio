/**
 * The cookie of the patient portal (ADR-008). It is a door of its own: the staff cookie opens no
 * portal route and this one opens no staff route, because each guard reads only its own name.
 *
 * Wherever cookies are secure the name carries the `__Host-` prefix (ASVS 3.4.4): a browser then
 * accepts the cookie only if it is `Secure`, has `Path=/` and has no `Domain`. Plain-http local
 * development keeps `psid`.
 *
 * It is `SameSite=Strict`, not `Lax` like the staff cookie: the portal is never reached by a
 * cross-site POST, and a link from an email lands on a page that asks for the session with its own
 * requests, which are same-site.
 */
export function portalCookieName(secure: boolean): string {
  return secure ? '__Host-psid' : 'psid';
}

/** A 256-bit token in unpadded base64url is always 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface PortalCookieOptions {
  /** Adds `Secure`. True everywhere except plain-http local development. */
  secure: boolean;
}

function attributes(pair: string, options: PortalCookieOptions, maxAgeSeconds: number): string {
  return [
    pair,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(options.secure ? ['Secure'] : []),
    `Max-Age=${String(Math.max(0, Math.floor(maxAgeSeconds)))}`,
  ].join('; ');
}

/** `Set-Cookie` value for a portal session token. The value must look like a token. */
export function serializePortalCookie(
  token: string,
  options: PortalCookieOptions & { maxAgeSeconds: number },
): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error('not a session token');
  return attributes(`${portalCookieName(options.secure)}=${token}`, options, options.maxAgeSeconds);
}

/** `Set-Cookie` value that removes the portal cookie (same attributes, empty value). */
export function clearPortalCookie(options: PortalCookieOptions): string {
  return attributes(`${portalCookieName(options.secure)}=`, options, 0);
}

/**
 * The portal session token from a `Cookie` header, or null when there is none or it is malformed.
 * A malformed value never reaches the database. If the cookie is sent twice the first one wins.
 */
export function readPortalCookie(
  header: string | undefined,
  options: PortalCookieOptions,
): string | null {
  if (header === undefined) return null;
  const name = portalCookieName(options.secure);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}
