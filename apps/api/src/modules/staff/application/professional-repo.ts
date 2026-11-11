import { eq } from 'drizzle-orm';

import { professional } from '../../../db/schema/staff.js';
import type { ProfessionalRepo } from '../../../platform/authz/professional-gate.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';

/**
 * Where the professional gate finds profiles (ADR-003, point 3). Read fresh on every request, so
 * deactivating a professional or clearing a registration closes the clinical door with the very
 * next call. A failure here counts as "no profile" (the gate catches it): fail closed.
 */
export function createProfessionalRepo(withTenant: WithTenant): ProfessionalRepo {
  return {
    findByMembership: (tenantId, membershipId) =>
      withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
        const [row] = await tx
          .select({
            id: professional.id,
            status: professional.status,
            matricula: professional.matricula,
            matriculaJurisdiction: professional.matriculaJurisdiction,
          })
          .from(professional)
          .where(eq(professional.membershipId, membershipId));
        if (!row) return null;
        return {
          ...row,
          status: row.status === 'active' ? ('active' as const) : ('inactive' as const),
        };
      }),
  };
}
