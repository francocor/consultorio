import { useQuery } from '@tanstack/react-query';

import { worklistApi, worklistKeys } from '../../features/worklist/api/worklist-api.js';
import { useApi } from '../providers.js';

/**
 * The number on a navigation entry. Today only the worklist has one: the open items the person
 * can see, refreshed every minute while the app is open. Other entries ask nothing.
 */
export function useNavBadge(id: string): number {
  const api = useApi();
  const query = useQuery({
    queryKey: worklistKeys.badge,
    queryFn: () => worklistApi(api).openCount(),
    enabled: id === 'worklist',
    refetchInterval: 60_000,
  });
  return id === 'worklist' ? (query.data ?? 0) : 0;
}
