import {
  DEFAULT_TELECONSULTATION_SETTINGS,
  TeleconsultationSettings,
} from '@consultorio/contracts';

import { createFakeVideoLinkProvider } from '../../adapters/video-fake/index.js';
import { createTeleconsultation } from '../../modules/teleconsultation/index.js';
import { fake } from '../adapter-resolver.js';

import type { ModuleWiring } from './types.js';

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
  // No customer adapter yet: no link is created for customers; demo organizations get the fake.
  adapters: () => ({ videoLink: { real: undefined, demo: fake(createFakeVideoLinkProvider()) } }),
  create: (context) =>
    createTeleconsultation({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};
