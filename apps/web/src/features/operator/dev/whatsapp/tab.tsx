import type { DevTab } from '../tabs.js';

import { WhatsAppSimulator } from './WhatsAppSimulator.js';

/** The WhatsApp simulator, as a tab of the provider console. */
export const tab: DevTab = {
  id: 'whatsapp',
  labelKey: 'messaging:dev.tab',
  Component: WhatsAppSimulator,
};
