import { QueryClient } from '@tanstack/react-query';

import { createApiClient, isApiError, type ApiClient } from '../shared/lib/api-client.js';

export const SESSION_QUERY_KEY = ['session'] as const;

/** Signals the whole shell reacts to: they come from the API, never from a guess. */
export interface AppStatus {
  /** The organization refused a write with 402. */
  readOnly: boolean;
  /** The session can only enroll the second factor. */
  enrollmentRequired: boolean;
  /** The device has a network connection (a hint: requests can still fail). */
  online: boolean;
}

type Listener = () => void;

/** A tiny observable value, readable with `useSyncExternalStore`. */
export interface StatusStore {
  get: () => AppStatus;
  set: (patch: Partial<AppStatus>) => void;
  subscribe: (listener: Listener) => () => void;
}

function createStatusStore(initial: AppStatus): StatusStore {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...patch };
      if (
        next.readOnly === state.readOnly &&
        next.enrollmentRequired === state.enrollmentRequired &&
        next.online === state.online
      ) {
        return;
      }
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface AppServices {
  api: ApiClient;
  queryClient: QueryClient;
  status: StatusStore;
  /** The router registers how to leave when the session ends (a 401 on a normal call). */
  onSessionEnded: (handler: () => void) => void;
  /** Forgets everything of the session: query cache and status flags. Used on sign-out. */
  clearSession: () => void;
  /** Follows online/offline events of the window; returns the function that stops listening. */
  watchConnectivity: (target: EventTarget) => () => void;
}

export interface AppServicesOptions {
  fetch?: typeof fetch;
  isOnline?: () => boolean;
}

/** Client errors (4xx) are answers, not outages: retrying them only delays the message. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * Everything the app shares: the API client, the query cache and the status flags. Built once per
 * page load (and per test), so no module-level state leaks between tenants or tests.
 *
 * The cache is memory only and short-lived: data is considered stale after 30 seconds and dropped
 * 5 minutes after nobody watches it. Nothing is ever written to browser storage (SHL-09).
 */
export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
      },
    },
  });
  const status = createStatusStore({
    readOnly: false,
    enrollmentRequired: false,
    online: options.isOnline ? options.isOnline() : true,
  });
  let sessionEnded: () => void = () => undefined;

  const api = createApiClient({
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onReadOnly: () => {
      status.set({ readOnly: true });
    },
    onEnrollmentRequired: () => {
      status.set({ enrollmentRequired: true });
    },
    onUnauthorized: () => {
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      sessionEnded();
    },
  });

  return {
    api,
    queryClient,
    status,
    onSessionEnded(handler) {
      sessionEnded = handler;
    },
    clearSession() {
      queryClient.clear();
      status.set({ readOnly: false, enrollmentRequired: false });
    },
    watchConnectivity(target) {
      const goOnline = () => {
        status.set({ online: true });
      };
      const goOffline = () => {
        status.set({ online: false });
      };
      target.addEventListener('online', goOnline);
      target.addEventListener('offline', goOffline);
      return () => {
        target.removeEventListener('online', goOnline);
        target.removeEventListener('offline', goOffline);
      };
    },
  };
}
