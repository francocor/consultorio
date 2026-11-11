import { useSearch } from '@tanstack/react-router';

import { safeRedirect } from '../../app/router-helpers.js';

export interface LoginSearch {
  /** The page the person was going to, when it is a path of this site. */
  redirect: string | undefined;
  /** The session ended while the app was open. */
  expired: boolean;
}

export function useLoginSearch(): LoginSearch {
  const search: unknown = useSearch({ strict: false });
  if (typeof search !== 'object' || search === null) return { redirect: undefined, expired: false };
  return {
    redirect: 'redirect' in search ? safeRedirect(search.redirect) : undefined,
    expired: 'reason' in search && search.reason === 'expired',
  };
}
