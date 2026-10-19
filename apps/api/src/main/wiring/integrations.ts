import { DEFAULT_INTEGRATION_SETTINGS, IntegrationSettings } from '@consultorio/contracts';

import { demoOutboxDevProvider } from '../../adapters/demo-outbox/dev-routes.js';
import { createDemoOutboxReader, purgeDemoOutbox } from '../../adapters/demo-outbox/index.js';
import { createRuntimeDb, type DbHandle } from '../../platform/db/pool.js';

import type { ModuleWiring } from './types.js';

/** How often the worker removes what the demo outbox kept for more than a day. */
const PURGE_EVERY_MS = 3_600_000;

/**
 * The `integrations` section of the organization settings: which optional channels an
 * organization uses (WhatsApp, video, electronic invoicing). It belongs to the platform, not to one
 * module: the notifications track reads the WhatsApp switch, the teleconsultation track the video
 * one and the invoicing track the e-invoicing one, and none of them registers the section.
 * Switching WhatsApp off is audited under its own action, and so is the e-invoicing switch
 * (`invoicing.config.changed`).
 */
export const integrationsWiring: ModuleWiring = {
  name: 'integrations',
  settingsSections: [
    {
      key: 'integrations',
      schema: IntegrationSettings,
      defaults: DEFAULT_INTEGRATION_SETTINGS,
      fieldAudits: {
        whatsapp: 'notification.integration.changed',
        einvoicing: 'invoicing.config.changed',
      },
    },
  ],
  // The email of the demo organizations is kept, not sent (task 5.48): the provider console lists it.
  // The connection to read it opens on the first listing, so a process with the console off never
  // opens one.
  devProviders: ({ config }) => {
    let handle: DbHandle | undefined;
    return [
      demoOutboxDevProvider({
        list: (options) => {
          handle ??= createRuntimeDb(config.databaseUrl);
          return createDemoOutboxReader(handle.db).list(options);
        },
      }),
    ];
  },
  // What a demo organization "sent" is kept for a day: the worker removes the rest every hour.
  worker: ({ clock }) => ({
    schedules: ({ db }) => [
      {
        name: 'demo outbox purge',
        intervalMs: PURGE_EVERY_MS,
        run: async () => {
          await purgeDemoOutbox(db, (clock ?? (() => new Date()))());
        },
      },
    ],
  }),
  create: () => ({}),
};
