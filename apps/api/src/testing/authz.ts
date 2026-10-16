import type { AuthzOptions } from '../platform/authz/guard.js';

/**
 * Authorization options for tests that are not about authorization: every actor is a plain staff
 * member of the session's tenant and denials are recorded nowhere. Tests of authorization build
 * the real thing (`createActorLoader`) instead.
 */
export const stubAuthz: AuthzOptions = {
  loadActor: (session) =>
    Promise.resolve({
      kind: 'staff',
      userId: session.userId,
      tenantId: session.tenantId,
      membershipId: session.membershipId,
      roles: session.roles,
      grants: [],
      professionalId: null,
    }),
  auditDeny: () => Promise.resolve({ recorded: true }),
};
