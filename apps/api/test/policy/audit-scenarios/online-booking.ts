import type { ONLINE_BOOKING_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of online booking are proven. Track B (public booking) replaces each
 * `pending` with the integration test that names the action, in this file only.
 */
export const ONLINE_BOOKING_SCENARIOS: Record<
  (typeof ONLINE_BOOKING_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  'booking.link.enabled': { pending: 'S3.07 (task 3.35): booking links' },
  'booking.link.disabled': { pending: 'S3.07 (task 3.35): booking links' },
  'booking.link.regenerated': { pending: 'S3.07 (task 3.35): booking links' },
  'booking.online.created': { pending: 'S3.09 (task 3.46): audit of an online booking' },
  'booking.suspicious': { pending: 'S3.08 (task 3.41): abuse controls of the public flow' },
};
