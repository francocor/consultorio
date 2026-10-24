import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';

import { isApiError } from '../../../shared/lib/api-client.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { portalKeys } from '../api/portal-api.js';

/**
 * The three states every section has besides its data: loading, empty and failed. A session that
 * ended while the page was open (a 401) sends the frame back to the sign-in instead of showing an
 * error the person cannot do anything about.
 */
export function QueryState<T>({
  query,
  isEmpty,
  empty,
  children,
  rows = 3,
}: {
  query: UseQueryResult<T>;
  isEmpty: (data: T) => boolean;
  empty: ReactNode;
  children: (data: T) => ReactNode;
  rows?: number;
}) {
  const queryClient = useQueryClient();
  const ended = query.isError && isApiError(query.error) && query.error.status === 401;
  useEffect(() => {
    if (ended) void queryClient.invalidateQueries({ queryKey: portalKeys.me });
  }, [ended, queryClient]);

  if (query.isPending || ended) return <ListSkeleton rows={rows} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return isEmpty(query.data) ? empty : children(query.data);
}
