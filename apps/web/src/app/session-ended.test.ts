import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';

import { createAppRouter } from './router.js';
import { createAppServices } from './services.js';

/**
 * A 401 in the middle of a session sends the person to sign-in. A 401 that arrives when they are
 * already there (a request still in flight when they signed out) must not send them to the page
 * they are on again with an "expired" notice (JD-S3 R4-CI1).
 */
const unauthenticated = () =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'x',
      status: 401,
      code: 'unauthenticated',
      i18nKey: 'errors.unauthenticated',
      requestId: 'r1',
    }),
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );

async function endSessionAt(path: string) {
  const services = createAppServices({
    fetch: (() => Promise.resolve(unauthenticated())) as unknown as typeof fetch,
    isOnline: () => true,
    retry: () => false,
  });
  const router = createAppRouter({
    services,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(undefined);
  services.queryClient.setQueryData(['session'], { user: { id: 'u1' } });

  await services.api.get('/patients').catch(() => undefined);
  return navigate;
}

describe('the router when the session ends', () => {
  it('goes to sign-in, remembering where the person was', async () => {
    const navigate = await endSessionAt('/patients');

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/login',
        search: expect.objectContaining({ reason: 'expired' }) as unknown,
      }),
    );
  });

  it('does nothing when the person is already at sign-in', async () => {
    const navigate = await endSessionAt('/login');

    expect(navigate).not.toHaveBeenCalled();
  });
});
