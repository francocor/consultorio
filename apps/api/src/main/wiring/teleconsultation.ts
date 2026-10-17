import {
  DEFAULT_TELECONSULTATION_SETTINGS,
  TeleconsultationSettings,
} from '@consultorio/contracts';

import { createFakeVideoLinkProvider } from '../../adapters/video-fake/index.js';
import {
  createLocalVideoLinkProvider,
  createUnavailableVideoLinkProvider,
} from '../../adapters/video-local/index.js';
import {
  createTeleconsultation,
  createVideoLinkCreateJob,
} from '../../modules/teleconsultation/index.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { fake, real, type AdapterRegistry } from '../adapter-resolver.js';
import type { ProviderConfig } from '../config-providers.js';

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
  const allowedDomains = providers?.videoAllowedDomains ?? [];
  return {
    real:
      providers?.video === 'local'
        ? // Neither the address builder nor the room reservation has any effect outside the process.
          fake(createLocalVideoLinkProvider({ allowedDomains }))
        : real(createUnavailableVideoLinkProvider({ allowedDomains })),
    demo: fake(createFakeVideoLinkProvider()),
  };
}

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
    },
  ],
  // A virtual appointment gets its room from a job, queued in the transaction that books it.
  needsJobs: true,
  create: (context) =>
    createTeleconsultation({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      events: context.appointmentEvents,
      ...(context.jobs ? { jobs: context.jobs } : {}),
      ...(context.adapters ? { adapters: context.adapters } : {}),
      ...(context.clock ? { clock: context.clock } : {}),
    }),
  worker: ({ adapters }) => ({ jobs: () => [createVideoLinkCreateJob({ adapters })] }),
};
