import type { FastifyInstance, InjectOptions } from 'fastify';

import { browserHeaders, sessionCookieOf } from './app.js';
import type { TestUser } from './users.js';

/** Password every `createTestUser(..., { password })` of the HTTP tests uses. */
export const TEST_PASSWORD = 'una frase larga para las pruebas del acceso';

export interface TestSession {
  user: TestUser;
  cookie: string;
}

/** Signs a test user in on a tenant's host and returns the session cookie. */
export async function signInAs(
  app: FastifyInstance,
  slug: string,
  user: TestUser,
  password = TEST_PASSWORD,
): Promise<TestSession> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: browserHeaders(slug),
    remoteAddress: '10.99.0.1',
    payload: { email: user.email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`test sign-in failed with status ${String(response.statusCode)}`);
  }
  return { user, cookie: sessionCookieOf(response.headers['set-cookie']) };
}

/** A small HTTP client for one tenant host: every request carries the browser headers. */
export function clientFor(app: FastifyInstance, slug: string) {
  const send = (
    method: NonNullable<InjectOptions['method']>,
    url: string,
    session: TestSession | null,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: browserHeaders(slug, session?.cookie),
      remoteAddress: '10.99.0.1',
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  return {
    get: (url: string, session: TestSession | null) => send('GET', url, session),
    post: (url: string, session: TestSession | null, payload?: unknown) =>
      send('POST', url, session, payload),
    put: (url: string, session: TestSession | null, payload?: unknown) =>
      send('PUT', url, session, payload),
    patch: (url: string, session: TestSession | null, payload?: unknown) =>
      send('PATCH', url, session, payload),
    delete: (url: string, session: TestSession | null) => send('DELETE', url, session),
  };
}
