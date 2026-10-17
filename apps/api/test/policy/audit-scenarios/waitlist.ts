import type { WAITLIST_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

/**
 * Where the audit actions of the waitlist are proven. Track C (waitlist) replaces each `pending`
 * with the integration test that names the action, in this file only.
 */
export const WAITLIST_SCENARIOS: Record<(typeof WAITLIST_AUDIT_ACTIONS)[number], AuditScenario> = {
  'waitlist.entry.created': t('waitlist-entries.test.ts'),
  'waitlist.entry.updated': t('waitlist-entries.test.ts'),
  'waitlist.entry.closed': t('waitlist-entries.test.ts'),
  'waitlist.offer.created': t('waitlist-matching.test.ts'),
  'waitlist.offer.accepted': t('waitlist-offer-link.test.ts'),
  'waitlist.offer.declined': t('waitlist-offer-link.test.ts'),
  'waitlist.offer.expired': t('waitlist-offers.test.ts'),
  'waitlist.priority.overridden': t('waitlist-entries.test.ts'),
};
