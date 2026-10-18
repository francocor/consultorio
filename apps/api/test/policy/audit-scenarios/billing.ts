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
  'charge.voided': { pending: 'S4.02 (task 4.14): voiding a charge' },
  'charge.flagged': {
    pending: 'S4.02 (task 4.13): a no-show or cancelled appointment flags its charge',
  },
  'payment.recorded': { pending: 'S4.03 (task 4.17): recording a payment' },
  'payment.override': { pending: 'S4.03 (task 4.17): a repeated voucher number with a reason' },
  'payment.refunded': { pending: 'S4.03 (task 4.18): refunds' },
  'cash.opened': { pending: 'S4.03 (task 4.19): opening the cash register' },
  'cash.closed': { pending: 'S4.03 (task 4.19): closing the cash register' },
  'cash.adjusted': { pending: 'S4.03 (task 4.18): a correction after the register closed' },
  'export.requested': { pending: 'S4.05 (task 4.24): the export job' },
};
