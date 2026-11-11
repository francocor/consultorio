import { DevProvidersResponse, type DevProviderDto } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/**
 * The provider console (Stages 3 to 6, "Simulator controls"). Every external provider has a local
 * simulator whose behavior a developer or a demo operator changes by hand: an outage, a delivery
 * receipt, an inbound reply. Those controls are routes under `/operator/dev/`, and they exist ONLY
 * when `LOCAL_PROVIDERS_CONSOLE=true`: with it off the paths are not registered at all, so a request
 * gets the 404 of any unknown path. When on, they live inside the operator console, so they answer
 * only on the platform host, behind the operator session and its origin check.
 */

export interface DevProviderStatus {
  /** Which adapter serves customers: the local simulator, the real provider, or nothing. */
  adapter: DevProviderDto['adapter'];
  /** The mode the simulator is in (`ok`, `down`, ...); null when it has none. */
  mode: string | null;
}

/** What a `*_PROVIDER` setting means for the console: the simulator, the real provider or nothing. */
export function adapterOfSetting(value: string): DevProviderStatus['adapter'] {
  if (value === 'local') return 'local';
  if (value === 'off') return 'off';
  return 'real';
}

export interface DevProvider {
  /** Lowercase words joined by hyphens; it is the path segment of the provider's own routes. */
  id: string;
  label: string;
  status(): Promise<DevProviderStatus>;
  /**
   * The provider's own controls (`/operator/dev/<id>/*`). Each route declares
   * `config.operatorAuth: 'session'` like the rest of the console, which the console enforces.
   */
  routes?: (app: FastifyInstance) => void;
}

export interface DevConsoleOptions {
  /** `LOCAL_PROVIDERS_CONSOLE`. */
  enabled: boolean;
  providers: readonly DevProvider[];
}

/** The routes to register inside the operator console, or `undefined` when the console is off. */
export function createDevRoutes(
  options: DevConsoleOptions,
): ((app: FastifyInstance) => void) | undefined {
  if (!options.enabled) return undefined;
  return (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/operator/dev/providers',
      {
        config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' },
        schema: { response: { 200: DevProvidersResponse } },
      },
      async () => ({
        providers: await Promise.all(
          options.providers.map(async (provider) => ({
            id: provider.id,
            label: provider.label,
            ...(await provider.status()),
          })),
        ),
      }),
    );

    for (const provider of options.providers) provider.routes?.(app);
  };
}
