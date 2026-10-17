import {
  DEFAULT_TELECONSULTATION_SETTINGS,
  TeleconsultationSettings,
} from '@consultorio/contracts';

import { createFakeVideoLinkProvider } from '../../adapters/video-fake/index.js';
import {
  DEFAULT_MANUAL_LINK_DOMAINS,
  createLocalVideoLinkProvider,
  createUnavailableVideoLinkProvider,
} from '../../adapters/video-local/index.js';
import {
  createJoinUrlResolver,
  createTeleconsultation,
  createVideoLinkCreateJob,
  devVideoRoutes,
  type DevVideoControls,
} from '../../modules/teleconsultation/index.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import { fake, real, type AdapterRegistry } from '../adapter-resolver.js';
import type { ProviderConfig } from '../config-providers.js';

import { originsFromConfig } from './origins.js';
import type { ModuleWiring } from './types.js';

/**
 * Who serves customers (design section 6). The local provider builds addresses on a Jitsi server;
 * a platform with video off, or one that selected Jitsi as a Service before its adapter exists
 * (deferred task 3.82), gets a provider that cannot make a room: every virtual appointment waits
 * for a manual link, and the hosts a manual link may use still come from the platform setting.
 * `providers` is read through a parameter that may be absent: the registry tests build the slots
 * from an empty configuration.
 */
function videoSlot(providers: ProviderConfig | undefined): AdapterRegistry['videoLink'] {
  const listed = providers?.videoAllowedDomains ?? [];
  const simulated = providers === undefined || providers.video === 'local';
  // While the simulators run, an empty list means "the usual services"; otherwise it allows nothing.
  const simulatorDomains = listed.length > 0 ? listed : DEFAULT_MANUAL_LINK_DOMAINS;
  return {
    real: simulated
      ? // Neither the address builder nor the room reservation has any effect outside the process.
        fake(
          createLocalVideoLinkProvider({
            allowedDomains: simulatorDomains,
            ...(providers?.videoLocalBaseUrl === undefined
              ? {}
              : { baseUrl: providers.videoLocalBaseUrl }),
          }),
        )
      : real(createUnavailableVideoLinkProvider({ allowedDomains: listed })),
    // Demo organizations never reach a real service, but they attach manual links like anyone.
    demo: fake(createFakeVideoLinkProvider({ manualLinkDomains: simulatorDomains })),
  };
}

/**
 * The simulator controls live in routes that are registered when the console is built, before the
 * module exists. They are given the module's controls once it is: a late binding, used only while
 * `LOCAL_PROVIDERS_CONSOLE` is on.
 */
function lateBound<T>(missing: string) {
  let value: T | undefined;
  return {
    bind(next: T) {
      value = next;
    },
    get(): T {
      if (value === undefined) throw new Error(missing);
      return value;
    },
  };
}
const consoleControls = lateBound<DevVideoControls>(
  'The video simulator controls need the application to be built first.',
);

/**
 * Everything the teleconsultation module registers with the composition root (track D). The track
 * edits this file, `modules/teleconsultation/` and nothing shared: it fills the customer slot of
 * the `videoLink` port when its local provider exists, subscribes to the appointment events, and
 * adds its jobs to the worker.
 */
export const teleconsultationWiring: ModuleWiring = {
  settingsSections: [
    {
      key: 'teleconsultation',
      schema: TeleconsultationSettings,
      defaults: DEFAULT_TELECONSULTATION_SETTINGS,
    },
  ],
  name: 'teleconsultation',
  adapters: ({ config }) => ({ videoLink: videoSlot(config.providers) }),
  devProviders: ({ config }) => [
    {
      id: 'video',
      label: 'Video',
      // The simulators add their mode (an outage, rejected templates) when they exist.
      status: () =>
        Promise.resolve({ adapter: adapterOfSetting(config.providers.video), mode: null }),
      routes: devVideoRoutes(() => consoleControls.get()),
    },
  ],
  // A virtual appointment gets its room from a job, queued in the transaction that books it.
  needsJobs: true,
  create: (context) => {
    const module = createTeleconsultation({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      events: context.appointmentEvents,
      origins: context.origins,
      ...(context.jobs ? { jobs: context.jobs } : {}),
      ...(context.adapters ? { adapters: context.adapters } : {}),
      ...(context.clock ? { clock: context.clock } : {}),
    });
    consoleControls.bind(module.devControls);
    // Reminders of a virtual appointment carry this address (notifications asks for it).
    context.videoJoin.register(module.joinUrlResolver);
    return module;
  },
  worker: ({ config, adapters, clock, videoJoin }) => {
    const now = clock ?? (() => new Date());
    // The worker renders the reminders, so it needs the resolver too (it has no module instance).
    videoJoin.register(
      createJoinUrlResolver({
        tokens: createActionTokens({ clock: now }),
        origins: originsFromConfig(config),
        clock: now,
      }),
    );
    return { jobs: () => [createVideoLinkCreateJob({ adapters })] };
  },
};
