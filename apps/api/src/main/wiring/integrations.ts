import { DEFAULT_INTEGRATION_SETTINGS, IntegrationSettings } from '@consultorio/contracts';

import type { ModuleWiring } from './types.js';

/**
 * The `integrations` section of the organization settings: which optional channels an
 * organization uses (WhatsApp, video). It belongs to the platform, not to one module: the
 * notifications track reads the WhatsApp switch and the teleconsultation track reads the video
 * one, and neither registers the section. Switching WhatsApp off is audited under its own action.
 */
export const integrationsWiring: ModuleWiring = {
  name: 'integrations',
  settingsSections: [
    {
      key: 'integrations',
      schema: IntegrationSettings,
      defaults: DEFAULT_INTEGRATION_SETTINGS,
      fieldAudits: { whatsapp: 'notification.integration.changed' },
    },
  ],
  create: () => ({}),
};
