/**
 * Public API of the staff module: invitations, the directory, professional profiles and weekly
 * hours. Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { ProfessionalRepo } from '../../platform/authz/professional-gate.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportProfessionals } from './application/export-contributor.js';
import { createProfessionalRepo } from './application/professional-repo.js';
import { createProfileService, type MatriculaRules } from './application/profile.js';
import { profileRoutes } from './http/profile-routes.js';

/** Registers what staff contributes to the cancellation export. */
export function registerStaffExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'staff', exportProfessionals);
}

export type { MatriculaRules } from './application/profile.js';

export interface StaffOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Format rules for a registration, from the country pack of the organization. */
  matriculaRules: MatriculaRules;
}

export interface Staff {
  /** Profiles for the professional gate of the authorization engine. */
  professionals: ProfessionalRepo;
  routes: (app: FastifyInstance) => void;
}

export function createStaff(options: StaffOptions): Staff {
  const profiles = createProfileService({ rules: options.matriculaRules });
  const profile = profileRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    profiles,
  });

  return {
    professionals: createProfessionalRepo(options.withTenant),
    routes: (app) => {
      profile(app);
    },
  };
}
