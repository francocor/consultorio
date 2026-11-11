import { request as httpRequest } from 'node:http';

/**
 * Proves that whoever is at the PC knows the password (and, if there is one, the second factor) of an OWNER of the
 * organization, by signing in through the API's own endpoints: the same code, the same lockout and throttling, the
 * same trail as a sign-in from the browser. The shell has no verifier of its own to get wrong. The session that
 * results is used for one question (is this an owner?) and ended.
 *
 * It is what gates the one thing a Windows session alone must not be able to do: replace the recovery key.
 */
export interface OwnerCheckOptions {
  /** The port the API listens on this run. */
  apiPort: number;
  /** The secret of this run that the API demands (`x-consulvia-proxy`). */
  proxySecret: string;
  /** The address the program is served at: the API checks `Host` and `Origin` against it. */
  publicOrigin: string;
  email: string;
  password: string;
  /** The code of the second factor, when the owner has one. */
  code?: string | undefined;
}

export type OwnerCheck =
  | { ok: true }
  /** The password was right and the account has a second factor: the code is needed. */
  | { ok: false; reason: 'needs_code' }
  /** Any part was wrong, or the account is not an owner. Never says which. */
  | { ok: false; reason: 'refused' }
  | { ok: false; reason: 'unavailable' };

export interface OwnerCall {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  cookie?: string;
}

export interface OwnerAnswer {
  status: number;
  body: unknown;
  /** The `name=value` pairs of the `Set-Cookie` headers. */
  cookies: string[];
}

export type OwnerTransport = (call: OwnerCall) => Promise<OwnerAnswer>;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

function cookieHeader(cookies: readonly string[]): string {
  return cookies.join('; ');
}

/** The transport that talks to the API on the loopback, as the local server would. */
export function loopbackTransport(options: OwnerCheckOptions): OwnerTransport {
  const origin = new URL(options.publicOrigin);
  return (call) =>
    new Promise((resolve, reject) => {
      const payload = call.body === undefined ? undefined : Buffer.from(JSON.stringify(call.body));
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: options.apiPort,
          path: call.path,
          method: call.method,
          timeout: 20_000,
          headers: {
            host: origin.host,
            origin: origin.origin,
            'x-consulvia-proxy': options.proxySecret,
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
              : {}),
            ...(call.cookie ? { cookie: call.cookie } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
            } catch {
              body = null;
            }
            resolve({
              status: response.statusCode ?? 0,
              body,
              cookies: (response.headers['set-cookie'] ?? []).map(
                (cookie) => cookie.split(';')[0] ?? '',
              ),
            });
          });
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error('timeout'));
      });
      request.on('error', reject);
      request.end(payload);
    });
}

export async function verifyOwner(
  options: OwnerCheckOptions,
  transport: OwnerTransport = loopbackTransport(options),
): Promise<OwnerCheck> {
  let cookies: string[] = [];
  try {
    const login = await transport({
      method: 'POST',
      path: '/auth/login',
      body: { email: options.email, password: options.password },
    });
    if (login.status !== 200) return { ok: false, reason: 'refused' };
    cookies = login.cookies;
    const next = asRecord(login.body)['next'];
    if (next === 'totp') {
      const challenge = asRecord(login.body)['challenge'];
      if (options.code === undefined || options.code.trim() === '') {
        return { ok: false, reason: 'needs_code' };
      }
      const second = await transport({
        method: 'POST',
        path: '/auth/2fa',
        body: { challenge, code: options.code.trim() },
        ...(cookies.length > 0 ? { cookie: cookieHeader(cookies) } : {}),
      });
      if (second.status !== 200 || asRecord(second.body)['next'] !== 'authenticated') {
        return { ok: false, reason: 'refused' };
      }
      cookies = second.cookies;
    } else if (next !== 'authenticated' && next !== 'enrollment') {
      return { ok: false, reason: 'refused' };
    }
    if (cookies.length === 0) return { ok: false, reason: 'refused' };
    const me = await transport({
      method: 'GET',
      path: '/auth/me',
      cookie: cookieHeader(cookies),
    });
    const roles = asRecord(me.body)['roles'];
    const isOwner = me.status === 200 && Array.isArray(roles) && roles.includes('owner');
    return isOwner ? { ok: true } : { ok: false, reason: 'refused' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    // The session was for this one question.
    if (cookies.length > 0) {
      await transport({
        method: 'POST',
        path: '/auth/logout',
        cookie: cookieHeader(cookies),
      }).catch(() => undefined);
    }
  }
}
