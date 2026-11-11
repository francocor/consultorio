import type { DevTab } from '../tabs.js';

import { DemoOutbox } from './DemoOutbox.js';

/** The email the demo organizations "sent", as a tab of the provider console. */
export const tab: DevTab = {
  id: 'demo-outbox',
  labelKey: 'operator:demoOutbox.tab',
  Component: DemoOutbox,
};
