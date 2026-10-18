import type { BILLING_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

/**
 * Where the audit actions of billing are proven. Track A (billing) replaces each `pending` with the
 * integration test that names the action, in this file only.
 */
export const BILLING_SCENARIOS: Record<(typeof BILLING_AUDIT_ACTIONS)[number], AuditScenario> = {
  'billing.price.changed': t('billing-pricing-api.test.ts'),
  'billing.price.override': t('capture-charge.test.ts'),
  'charge.captured': t('capture-charge.test.ts'),
  'charge.voided': t('void-charge.test.ts'),
  'charge.flagged': t('charge-review.test.ts'),
  'payment.recorded': t('record-payment.test.ts'),
  'payment.override': t('record-payment.test.ts'),
  'payment.refunded': t('refund-payment.test.ts'),
  'cash.opened': t('cash-register.test.ts'),
  'cash.closed': t('cash-register.test.ts'),
  'cash.adjusted': t('refund-payment.test.ts'),
  'export.requested': t('billing-exports.test.ts'),
};
