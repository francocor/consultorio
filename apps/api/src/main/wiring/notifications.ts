import { DEFAULT_NOTIFICATION_SETTINGS, NotificationSettings } from '@consultorio/contracts';

import { createFakeWhatsAppSender } from '../../adapters/whatsapp-fake/index.js';
import { createNotifications } from '../../modules/notifications/index.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { fake } from '../adapter-resolver.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the notifications module registers with the composition root (track A). The track
 * edits this file, `modules/notifications/` and nothing shared: it fills the customer slot of the
 * `whatsapp` port when its local simulator exists, subscribes to the appointment events, and adds
 * its jobs to the worker.
 */
export const notificationsWiring: ModuleWiring = {
  settingsSections: [
    {
      key: 'notifications',
      schema: NotificationSettings,
      defaults: DEFAULT_NOTIFICATION_SETTINGS,
    },
  ],
  name: 'notifications',
  // No customer adapter yet: WhatsApp stays unavailable for customers; demo organizations get the fake.
  adapters: () => ({ whatsapp: { real: undefined, demo: fake(createFakeWhatsAppSender()) } }),
  devProviders: ({ config }) => [
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      // The simulators add their mode (an outage, rejected templates) when they exist.
      status: () =>
        Promise.resolve({ adapter: adapterOfSetting(config.providers.whatsapp), mode: null }),
    },
  ],
  create: (context) =>
    createNotifications({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};
