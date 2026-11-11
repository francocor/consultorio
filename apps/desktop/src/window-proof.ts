import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * What lets the local server tell the window of Consulvia from any other program on the PC.
 *
 * The loopback port is open to every program of the machine, and the local server adds the secret that the API
 * demands to whatever it forwards. Without a proof, any process of any Windows user (or a script running as the
 * same user) could call `127.0.0.1:<port>/api/...` and be served as if it were the window. The proof is a random
 * value of this run:
 *
 * - the shell adds it as a header to every request its own windows make to the local server (it is added below
 *   the page, in the network layer of the session, so a page can neither read nor forge it);
 * - the browser of the PC, when the owner opens the program there, gets it as an `HttpOnly` cookie from an address
 *   that works once (`/__browser`), which is a different value, so one leaking does not give the other.
 *
 * It keeps out programs that do not know it. It does not defend against a program that can read the memory of the
 * shell or of its window: that one already is the user.
 */
export const WINDOW_HEADER = 'x-consulvia-window';
export const BROWSER_COOKIE = 'consulvia_session';

export interface Credentials {
  /** The value the windows of the shell send in `WINDOW_HEADER`. */
  window: string;
  /** The value the browser keeps in `BROWSER_COOKIE`. */
  browser: string;
}

/** Equality of two secrets that does not depend on where they differ. */
export function secretsMatch(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || expected === '') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The value of cookie `name` in a `Cookie` header, or `null`. */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/** The `Cookie` header without the cookie of this module: the API has no business seeing it. */
export function withoutBrowserCookie(header: string): string {
  return header
    .split(';')
    .filter((part) => part.slice(0, part.indexOf('=')).trim() !== BROWSER_COOKIE)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('; ');
}

/** True when the request comes from a window of the shell or from the browser the owner opened through it. */
export function presentsProof(headers: IncomingHttpHeaders, credentials: Credentials): boolean {
  const header = headers[WINDOW_HEADER];
  if (secretsMatch(Array.isArray(header) ? header[0] : header, credentials.window)) return true;
  return secretsMatch(cookieValue(headers.cookie, BROWSER_COOKIE), credentials.browser);
}

/**
 * True for the address of the local server of this run, spelled as a number. A name (`localhost`) is not: it can
 * resolve to `::1`, and a program listening there on the same port would be handed the proof.
 */
export function isLocalServerUrl(url: string, port: number): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && Number(parsed.port) === port
    );
  } catch {
    return false;
  }
}

/**
 * The headers a request of a window must carry: for the local server, they are the page's own plus the proof
 * (and any header of that name the page set is gone); any other address gets them untouched.
 */
export function headersWithProof(
  headers: Record<string, string>,
  url: string,
  port: number,
  proof: string,
): Record<string, string> {
  if (!isLocalServerUrl(url, port)) return headers;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== WINDOW_HEADER) result[name] = value;
  }
  result['X-Consulvia-Window'] = proof;
  return result;
}
