import type { WAITLIST_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of the waitlist are proven. Track C (waitlist) replaces each `pending`
 * with the integration test that names the action, in this file only.
 */
export const WAITLIST_SCENARIOS: Record<(typeof WAITLIST_AUDIT_ACTIONS)[number], AuditScenario> = {
  'waitlist.entry.created': { pending: 'S3.11 (task 3.52): waitlist entries' },
  'waitlist.entry.updated': { pending: 'S3.11 (task 3.52): waitlist entries' },
  'waitlist.entry.closed': { pending: 'S3.11 (task 3.52): waitlist entries' },
  'waitlist.offer.created': { pending: 'S3.12 (task 3.55): waitlist offers' },
  'waitlist.offer.accepted': { pending: 'S3.12 (task 3.56): acceptance of an offer' },
  'waitlist.offer.declined': { pending: 'S3.12 (task 3.56): decline of an offer' },
  'waitlist.offer.expired': { pending: 'S3.12 (task 3.55): expiry of an offer' },
  'waitlist.priority.overridden': { pending: 'S3.12 (task 3.58): audited priority overrides' },
};
