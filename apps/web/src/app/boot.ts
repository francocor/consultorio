import { BootPayload } from '@consultorio/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';

import type { ApiClient } from '../shared/lib/api-client.js';

import { useApi } from './providers.js';

export const BOOT_QUERY_KEY = ['boot'] as const;

/**
 * What the organization looks like: name, logo, theme. The inline script of `index.html` already
 * fetched it before the first paint, so the app reuses that answer instead of asking again.
 */
export function bootQueryOptions(api: ApiClient) {
  return queryOptions({
    queryKey: BOOT_QUERY_KEY,
    queryFn: async (): Promise<BootPayload> => {
      const early = await window.__CONSULTORIO_BOOT__;
      // Used once: later refreshes ask the server.
      window.__CONSULTORIO_BOOT__ = undefined;
      return early ?? api.get('/public/boot', { schema: BootPayload });
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useBoot(): BootPayload | undefined {
  const api = useApi();
  return useQuery(bootQueryOptions(api)).data;
}
