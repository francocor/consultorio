import { and, eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * What a prescription needs to know about the professional who writes it: the name, the
 * registration and whether the platform operator verified it. Only e-prescription reads the
 * verification (design D1: it never gates the rest of the clinical work).
 */
export interface PrescriberProfile {
  professionalId: string;
  status: 'active' | 'inactive';
  fullName: string;
  specialties: readonly string[];
  matricula: string | null;
  jurisdiction: string | null;
  matriculaStatus: 'verified' | 'unverified';
}

/** The profile of a professional of the organization of the transaction, or null when there is none. */
export async function readPrescriberProfile(
  tx: Tx,
  professionalId: string,
): Promise<PrescriberProfile | null> {
  const [row] = await tx
    .select({
      id: professional.id,
      status: professional.status,
      fullName: membership.displayName,
      specialties: professional.specialties,
      matricula: professional.matricula,
      jurisdiction: professional.matriculaJurisdiction,
      matriculaStatus: professional.matriculaStatus,
    })
    .from(professional)
    .innerJoin(
      membership,
      and(
        eq(membership.tenantId, professional.tenantId),
        eq(membership.id, professional.membershipId),
      ),
    )
    .where(eq(professional.id, professionalId));
  if (!row) return null;
  return {
    professionalId: row.id,
    status: row.status === 'active' ? 'active' : 'inactive',
    fullName: row.fullName ?? '',
    specialties: row.specialties,
    matricula: row.matricula,
    jurisdiction: row.jurisdiction,
    matriculaStatus: row.matriculaStatus === 'verified' ? 'verified' : 'unverified',
  };
}
