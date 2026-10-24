import { billingWiring } from './billing.js';
import { consentWiring } from './consent.js';
import { integrationsWiring } from './integrations.js';
import { invoicingWiring } from './invoicing.js';
import { notificationsWiring } from './notifications.js';
import { onlineBookingWiring } from './online-booking.js';
import { portalWiring } from './portal.js';
import { prescriptionsWiring } from './prescriptions.js';
import { reportsWiring } from './reports.js';
import { teleconsultationWiring } from './teleconsultation.js';
import type { ModuleWiring } from './types.js';
import { waitlistWiring } from './waitlist.js';

export type {
  AdapterWiringContext,
  ModuleWiring,
  WiringContext,
  WorkerContribution,
  WorkerWiringContext,
} from './types.js';
export { combineWorkerContributions } from './worker.js';

/**
 * Every capability module the composition root wires, in registration order. `main` and the test
 * application both pass this list, so a test exercises the very composition production runs. A new
 * module is added here once; after that its track only edits its own wiring file.
 */
export const MODULE_WIRINGS: readonly ModuleWiring[] = [
  integrationsWiring,
  notificationsWiring,
  onlineBookingWiring,
  waitlistWiring,
  teleconsultationWiring,
  billingWiring,
  invoicingWiring,
  reportsWiring,
  consentWiring,
  prescriptionsWiring,
  portalWiring,
];
