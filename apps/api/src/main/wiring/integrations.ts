import { DEFAULT_INTEGRATION_SETTINGS, IntegrationSettings } from '@consultorio/contracts';

import type { ModuleWiring } from './types.js';

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
  create: () => ({}),
};
