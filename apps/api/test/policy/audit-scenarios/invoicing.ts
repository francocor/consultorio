import type { INVOICING_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of invoicing are proven. Track C (invoicing) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
export const INVOICING_SCENARIOS: Record<(typeof INVOICING_AUDIT_ACTIONS)[number], AuditScenario> =
  {
    'invoice.requested': { pending: 'S4.10 (task 4.44): creating an invoice over charge lines' },
    'invoice.issued': { pending: 'S4.11 (task 4.47): the issue job' },
    'invoice.rejected': { pending: 'S4.10 (task 4.46): a rejected attempt' },
    'invoice.retried': { pending: 'S4.10 (task 4.46): a retry linked to the rejected attempt' },
    'invoice.manual': { pending: 'S4.11 (task 4.49): manual entry of an invoice' },
    'invoice.credit_note': { pending: 'S4.10 (task 4.45): credit notes' },
    'invoicing.config.changed': { pending: 'S4.08 (task 4.36): fiscal configuration' },
    'invoicing.credential.changed': { pending: 'S4.08 (task 4.37): certificate upload' },
  };
