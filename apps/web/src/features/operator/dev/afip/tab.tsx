import type { DevTab } from '../tabs.js';

import { AfipSimulator } from './AfipSimulator.js';

/** The AFIP simulator, as a tab of the provider console. */
export const tab: DevTab = {
  id: 'afip',
  labelKey: 'invoicing:dev.tab',
  Component: AfipSimulator,
};
