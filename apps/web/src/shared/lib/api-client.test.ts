import { MeResponse } from '@consultorio/contracts';
import { describe, expect, it, vi } from 'vitest';

import { urlOf } from '../test/render.js';

import { ApiError, createApiClient, isApiError } from './api-client.js';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Problem',
      status,
      code,
      i18nKey: `errors.${code}`,
      requestId: 'req-123',
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function clientWith(handler: Handler, hooks: Parameters<typeof createApiClient>[0] = {}) {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(urlOf(input), init ?? {})),
  );
  const client = createApiClient({ ...hooks, fetch: fetchMock as unknown as typeof fetch });
  return { client, fetchMock };
}

describe('api client: successful responses', () => {
  it('prefixes /api, sends cookies and parses the JSON body with the schema', async () => {
    const me = {
      user: { id: '0190a000-0000-7000-8000-000000000001', email: 'ana@example.test' },
      roles: ['reception'],
      permissions: ['patients.read'],
      scope: 'full',
      twoFactor: { enrolled: false, required: false, graceEndsAt: null },
      tenantStatus: 'active',
    };
    const { client, fetchMock } = clientWith(() => json(me));

    const result = await client.get('/auth/me', { schema: MeResponse });

    expect(result.user.email).toBe('ana@example.test');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/me');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.method).toBe('GET');
  });

  it('sends a JSON body with its content type and builds the query string without empty values', async () => {
    const { client, fetchMock } = clientWith(() => json({ ok: true }));

    await client.post('/patients', { body: { name: 'Ana' } });
    await client.get('/patients', { query: { q: 'ana lópez', limit: 20, cursor: undefined } });

    const [, postInit] = fetchMock.mock.calls[0] ?? [];
    expect(postInit?.body).toBe('{"name":"Ana"}');
    expect(new Headers(postInit?.headers).get('content-type')).toBe('application/json');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/patients?q=ana+l%C3%B3pez&limit=20');
  });

  it('returns undefined for 204 without trying to parse a body', async () => {
    const { client } = clientWith(() => new Response(null, { status: 204 }));

    expect(await client.post('/auth/logout')).toBeUndefined();
  });

  it('rejects a body that does not match the schema as an unexpected response', async () => {
    const { client } = clientWith(() => json({ user: 'nope' }));

    const failure = await client.get('/auth/me', { schema: MeResponse }).catch((e: unknown) => e);

    expect(isApiError(failure)).toBe(true);
    expect((failure as ApiError).code).toBeNull();
    expect((failure as ApiError).i18nKey).toBe('errors.unexpected_response');
  });
});

describe('api client: error responses', () => {
  it('parses problem+json into a typed error with the request id and field errors', async () => {
    const { client } = clientWith(() =>
      problem(400, 'validation_failed', {
        errors: [{ path: 'password', i18nKey: 'password.too_short' }],
      }),
    );

    const failure = (await client.post('/x').catch((e: unknown) => e)) as ApiError;

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(400);
    expect(failure.code).toBe('validation_failed');
    expect(failure.requestId).toBe('req-123');
    expect(failure.fieldErrors).toEqual([{ path: 'password', i18nKey: 'password.too_short' }]);
  });

  it('falls back to the status when the body is not a problem document', async () => {
    const { client } = clientWith(() => new Response('<html>bad gateway</html>', { status: 502 }));

    const failure = (await client.get('/x').catch((e: unknown) => e)) as ApiError;

    expect(failure.status).toBe(502);
    expect(failure.code).toBe('internal_error');
    expect(failure.i18nKey).toBe('errors.internal_error');
    expect(failure.requestId).toBeNull();
  });

  it('takes the request id from the response header when the body has none', async () => {
    const { client } = clientWith(
      () => new Response('nope', { status: 500, headers: { 'x-request-id': 'hdr-9' } }),
    );

    const failure = (await client.get('/x').catch((e: unknown) => e)) as ApiError;

    expect(failure.requestId).toBe('hdr-9');
  });

  it('reads Retry-After on 429', async () => {
    const { client } = clientWith(
      () => new Response(null, { status: 429, headers: { 'retry-after': '37' } }),
    );

    const failure = (await client.get('/x').catch((e: unknown) => e)) as ApiError;

    expect(failure.code).toBe('rate_limited');
    expect(failure.retryAfterSeconds).toBe(37);
  });

  it('turns a network failure into an error with status 0 and its own message key', async () => {
    const client = createApiClient({
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
    });

    const failure = (await client.get('/x').catch((e: unknown) => e)) as ApiError;

    expect(failure.status).toBe(0);
    expect(failure.kind).toBe('network');
    expect(failure.i18nKey).toBe('errors.network');
  });
});

describe('api client: status class side effects', () => {
  it('401 on a normal call asks the app to send the user to sign in', async () => {
    const onUnauthorized = vi.fn();
    const { client } = clientWith(() => problem(401, 'unauthenticated'), { onUnauthorized });

    await client.get('/patients').catch(() => undefined);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it.each(['/auth/login', '/auth/2fa', '/auth/password-reset/complete', '/auth/me'])(
    '401 on %s is a result to show, not a session that expired',
    async (path) => {
      const onUnauthorized = vi.fn();
      const { client } = clientWith(() => problem(401, 'unauthenticated'), { onUnauthorized });

      const failure = (await client.post(path).catch((e: unknown) => e)) as ApiError;

      expect(failure.status).toBe(401);
      expect(onUnauthorized).not.toHaveBeenCalled();
    },
  );

  it('402 marks the organization as read only', async () => {
    const onReadOnly = vi.fn();
    const { client } = clientWith(() => problem(402, 'tenant_read_only'), { onReadOnly });

    const failure = (await client
      .put('/settings', { body: {} })
      .catch((e: unknown) => e)) as ApiError;

    expect(failure.code).toBe('tenant_read_only');
    expect(onReadOnly).toHaveBeenCalledTimes(1);
  });

  it('403 two_factor_enrollment_required tells the app to show the enrollment state', async () => {
    const onEnrollmentRequired = vi.fn();
    const { client } = clientWith(() => problem(403, 'two_factor_enrollment_required'), {
      onEnrollmentRequired,
    });

    await client.get('/patients').catch(() => undefined);

    expect(onEnrollmentRequired).toHaveBeenCalledTimes(1);
  });

  it('an ordinary 403 triggers no global side effect', async () => {
    const hooks = {
      onUnauthorized: vi.fn(),
      onReadOnly: vi.fn(),
      onEnrollmentRequired: vi.fn(),
    };
    const { client } = clientWith(() => problem(403, 'forbidden'), hooks);

    const failure = (await client.get('/staff').catch((e: unknown) => e)) as ApiError;

    expect(failure.code).toBe('forbidden');
    expect(hooks.onUnauthorized).not.toHaveBeenCalled();
    expect(hooks.onReadOnly).not.toHaveBeenCalled();
    expect(hooks.onEnrollmentRequired).not.toHaveBeenCalled();
  });
});

describe('api client: downloads', () => {
  it('returns the blob and the file name of a download', async () => {
    const { client } = clientWith(
      () =>
        new Response('a,b\n1,2\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv',
            'content-disposition': 'attachment; filename="audit.csv"',
          },
        }),
    );

    const file = await client.download('/audit-events/export', { query: { format: 'csv' } });

    expect(file.filename).toBe('audit.csv');
    expect(await file.blob.text()).toBe('a,b\n1,2\n');
  });
});
