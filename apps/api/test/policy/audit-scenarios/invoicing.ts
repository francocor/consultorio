import type { INVOICING_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

/**
 * Where the audit actions of invoicing are proven. Track C (invoicing) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
export const INVOICING_SCENARIOS: Record<(typeof INVOICING_AUDIT_ACTIONS)[number], AuditScenario> =
  {
    'invoice.requested': t('invoice-create.test.ts'),
    'invoice.issued': t('afip-issue-job.test.ts'),
    'invoice.rejected': t('invoice-rejection.test.ts'),
    'invoice.retried': t('invoice-rejection.test.ts'),
    'invoice.manual': t('invoice-manual.test.ts'),
    'invoice.credit_note': t('credit-note.test.ts'),
    'invoice.attempted': t('invoice-reconciliation.test.ts'),
    'invoice.needs_attention': t('invoice-reconciliation.test.ts'),
    'invoice.voucher_orphaned': t('invoice-reconciliation.test.ts'),
    'invoicing.config.changed': t('fiscal-config.test.ts'),
    'invoicing.credential.changed': t('fiscal-config.test.ts'),
  };
