import { asc, eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { professional, professionalHours } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by staff: the professional profiles (discipline, registration
 * and whether it was verified) and their weekly hours, history included.
 */
export const exportProfessionals: ExportContributor = async ({ tx }) => {
  const professionals = await tx
    .select({
      name: membership.displayName,
      status: professional.status,
      specialties: professional.specialties,
      matricula: professional.matricula,
      matriculaJurisdiction: professional.matriculaJurisdiction,
      matriculaStatus: professional.matriculaStatus,
      maxSimultaneous: professional.maxSimultaneous,
    })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .orderBy(asc(professional.createdAt));

  const hours = await tx
    .select({
      professional: membership.displayName,
      location: location.name,
      weekday: professionalHours.weekday,
      startMinute: professionalHours.startMinute,
      endMinute: professionalHours.endMinute,
      removedAt: professionalHours.removedAt,
    })
    .from(professionalHours)
    .innerJoin(professional, eq(professional.id, professionalHours.professionalId))
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .innerJoin(location, eq(location.id, professionalHours.locationId))
    .orderBy(asc(professionalHours.createdAt));

  return { professionals, weeklyHours: hours };
};
