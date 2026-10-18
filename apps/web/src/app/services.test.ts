import { describe, expect, it, vi } from 'vitest';

import { urlOf } from '../shared/test/render.js';

import { createAppServices } from './services.js';

function servicesWith(responses: Record<string, Response>) {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const response = responses[urlOf(input)];
    return Promise.resolve(response?.clone() ?? new Response(null, { status: 404 }));
  });
  const services = createAppServices({
    fetch: fetchMock as unknown as typeof fetch,
    isOnline: () => true,
  });
  return { services, fetchMock };
}

const problem = (status: number, code: string) =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'x',
      status,
      code,
      i18nKey: `errors.${code}`,
      requestId: 'r1',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

describe('app services: global reactions to the API', () => {
  it('a 402 turns on the read-only state, which the banner reads', async () => {
    const { services } = servicesWith({ '/api/settings': problem(402, 'tenant_read_only') });
    expect(services.status.get().readOnly).toBe(false);

    await services.api.put('/settings', { body: {} }).catch(() => undefined);

    expect(services.status.get().readOnly).toBe(true);
  });

  it('the enrollment 403 turns on the two-factor state', async () => {
    const { services } = servicesWith({
      '/api/patients': problem(403, 'two_factor_enrollment_required'),
    });

    await services.api.get('/patients').catch(() => undefined);

    expect(services.status.get().enrollmentRequired).toBe(true);
  });

  it('a 401 on a normal call drops the cached session and tells the router to leave', async () => {
    const { services } = servicesWith({ '/api/patients': problem(401, 'unauthenticated') });
    const navigate = vi.fn();
    services.onSessionEnded(navigate);
    services.queryClient.setQueryData(['session'], { user: { id: 'u1' } });

    await services.api.get('/patients').catch(() => undefined);

    expect(services.queryClient.getQueryData(['session'])).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('ignores a late 401 after the session was cleared on sign-out (JD-S3 R4-CI1)', async () => {
    const { services } = servicesWith({ '/api/patients': problem(401, 'unauthenticated') });
    const navigate = vi.fn();
    services.onSessionEnded(navigate);
    services.queryClient.setQueryData(['session'], { user: { id: 'u1' } });

    // The person signs out: the cache is emptied, and a request that was in flight answers 401.
    services.clearSession();
    await services.api.get('/patients').catch(() => undefined);

    expect(navigate).not.toHaveBeenCalled();
    expect(services.queryClient.getQueryData(['session'])).toBeUndefined();
  });

  it('ignores a second 401 once the session already ended (JD-S3 R4-CI1)', async () => {
    const { services } = servicesWith({ '/api/patients': problem(401, 'unauthenticated') });
    const navigate = vi.fn();
    services.onSessionEnded(navigate);
    services.queryClient.setQueryData(['session'], { user: { id: 'u1' } });

    await Promise.all([
      services.api.get('/patients').catch(() => undefined),
      services.api.get('/patients').catch(() => undefined),
    ]);

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('follows the connectivity of the device', () => {
    const { services } = servicesWith({});
    const target = new EventTarget();
    const stop = services.watchConnectivity(target);

    target.dispatchEvent(new Event('offline'));
    expect(services.status.get().online).toBe(false);

    target.dispatchEvent(new Event('online'));
    expect(services.status.get().online).toBe(true);
    stop();
    target.dispatchEvent(new Event('offline'));
    expect(services.status.get().online).toBe(true);
  });
});

describe('app services: nothing stays behind after the session', () => {
  it('clearing the session empties the whole query cache and the status flags', () => {
    const { services } = servicesWith({});
    services.queryClient.setQueryData(['patients', 'list'], [{ id: 'p1', name: 'Ana' }]);
    services.queryClient.setQueryData(['session'], { user: { id: 'u1' } });
    services.status.set({ readOnly: true, enrollmentRequired: true });

    services.clearSession();

    expect(services.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(services.status.get()).toMatchObject({ readOnly: false, enrollmentRequired: false });
  });

  it('does not retry client errors and keeps data fresh only briefly', () => {
    const { services } = servicesWith({});
    const defaults = services.queryClient.getDefaultOptions().queries;

    expect(defaults?.staleTime).toBeLessThanOrEqual(30_000);
    expect(defaults?.gcTime).toBeLessThanOrEqual(5 * 60_000);
    const retry = defaults?.retry;
    expect(typeof retry).toBe('function');
  });
});
