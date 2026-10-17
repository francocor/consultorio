import { MeResponse, type Permission } from '@consultorio/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';

import type { ApiClient } from '../shared/lib/api-client.js';

import { useApi } from './providers.js';
import { SESSION_QUERY_KEY } from './services.js';

/** The signed-in user. `null` is the cached answer after the session ended. */
export function meQueryOptions(api: ApiClient) {
  return queryOptions({
    queryKey: SESSION_QUERY_KEY,
    queryFn: (): Promise<MeResponse | null> => api.get('/auth/me', { schema: MeResponse }),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * The profile of the signed-in user. Only call it below the authenticated layout, whose route
 * loads it first; reaching it without a session is a programming error, not a user situation.
 */
export function useMe(): MeResponse {
  const api = useApi();
  const { data } = useQuery(meQueryOptions(api));
  if (!data) throw new Error('useMe was used without a signed-in user');
  return data;
}

/** True when the user holds at least one of the permissions (or none are required). */
export function hasAnyPermission(
  held: readonly Permission[],
  required: readonly Permission[],
): boolean {
  return required.length === 0 || required.some((permission) => held.includes(permission));
}
