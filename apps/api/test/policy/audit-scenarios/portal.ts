import type { PORTAL_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

/**
 * Where the audit actions of the portal are proven. Track B (portal) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
export const PORTAL_SCENARIOS: Record<(typeof PORTAL_AUDIT_ACTIONS)[number], AuditScenario> = {
  'portal.identity.created': t('portal-identity.test.ts'),
  'portal.identity.linked': t('portal-identity.test.ts'),
  'portal.identity.deactivated': t('portal-identity.test.ts'),
  'portal.signin.success': t('portal-signin.test.ts'),
  'portal.signin.failure': t('portal-signin.test.ts'),
  'portal.read': { pending: 'S5.08 (task 5.31): a portal read' },
  'portal.download': { pending: 'S5.09 (task 5.35): a session-bound download' },
  'portal.profile.changed': { pending: 'S5.08 (task 5.34): contact data changed' },
  'portal.denied': { pending: 'S5.08 (task 5.31): another patient answers 404 and is audited' },
};
