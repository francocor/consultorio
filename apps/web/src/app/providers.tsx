import { QueryClientProvider } from '@tanstack/react-query';
import type { i18n as I18n } from 'i18next';
import { createContext, use, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import type { ApiClient } from '../shared/lib/api-client.js';
import { Toaster } from '../shared/ui/toaster.js';

import type { AppServices, AppStatus } from './services.js';

const ServicesContext = createContext<AppServices | null>(null);

export interface AppProvidersProps {
  services: AppServices;
  i18n: I18n;
  children: ReactNode;
}

/** The providers every screen needs: services (API, cache, status), translations, queries. */
export function AppProviders({ services, i18n, children }: AppProvidersProps) {
  useEffect(() => services.watchConnectivity(window), [services]);

  return (
    <ServicesContext value={services}>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={services.queryClient}>
          {children}
          <Toaster />
        </QueryClientProvider>
      </I18nextProvider>
    </ServicesContext>
  );
}

export function useServices(): AppServices {
  const services = use(ServicesContext);
  if (!services) throw new Error('useServices must be used inside AppProviders');
  return services;
}

export function useApi(): ApiClient {
  return useServices().api;
}

/** The read-only / enrollment / online flags, re-rendering the caller when one changes. */
export function useAppStatus(): AppStatus {
  const { status } = useServices();
  return useSyncExternalStore(status.subscribe, status.get, status.get);
}
