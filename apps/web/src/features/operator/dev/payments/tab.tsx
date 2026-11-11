import type { DevTab } from '../tabs.js';

import { PaymentsSimulator } from './PaymentsSimulator.js';

/** The Mercado Pago simulator, as a tab of the provider console. */
export const tab: DevTab = {
  id: 'payments',
  labelKey: 'subscription:dev.tab',
  Component: PaymentsSimulator,
};
