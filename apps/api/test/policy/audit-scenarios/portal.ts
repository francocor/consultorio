import type { PORTAL_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of the portal are proven. Track B (portal) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
export const PORTAL_SCENARIOS: Record<(typeof PORTAL_AUDIT_ACTIONS)[number], AuditScenario> = {
  'portal.identity.created': { pending: 'S5.06 (task 5.25): activation creates the identity' },
  'portal.identity.linked': { pending: 'S5.06 (task 5.25): a link to a patient' },
  'portal.identity.deactivated': { pending: 'S5.06 (task 5.26): staff deactivate an identity' },
  'portal.signin.success': { pending: 'S5.07 (task 5.30): sign-in by emailed code' },
  'portal.signin.failure': { pending: 'S5.07 (task 5.28): a wrong code' },
  'portal.read': { pending: 'S5.08 (task 5.31): a portal read' },
  'portal.download': { pending: 'S5.09 (task 5.35): a session-bound download' },
  'portal.profile.changed': { pending: 'S5.08 (task 5.34): contact data changed' },
  'portal.denied': { pending: 'S5.08 (task 5.31): another patient answers 404 and is audited' },
};
