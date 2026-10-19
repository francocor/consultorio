import type { DevTab } from '../tabs.js';

import { ErxSimulator } from './ErxSimulator.js';

/** The e-prescription simulator, as a tab of the provider console. */
export const tab: DevTab = {
  id: 'erx',
  labelKey: 'prescriptions:dev.tab',
  Component: ErxSimulator,
};
