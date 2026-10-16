/**
 * Public API of the staff module: invitations, the directory, professional profiles and weekly
 * hours. Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { ProfessionalRepo } from '../../platform/authz/professional-gate.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import type { SessionRevoker } from '../access/index.js';
import type { Invitations } from '../identity/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createDirectoryService } from './application/directory.js';
import { exportProfessionals } from './application/export-contributor.js';
import { createHoursService } from './application/hours.js';
import { createLifecycleService } from './application/lifecycle.js';
import { createProfessionalRepo } from './application/professional-repo.js';
import { createProfileService, type MatriculaRules } from './application/profile.js';
import { hoursRoutes } from './http/hours-routes.js';
import { lifecycleRoutes } from './http/lifecycle-routes.js';
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
  /** Issues the single-use invitation links (identity). */
  invitations: Invitations;
  /** Ends the sessions of a member who is deactivated. */
  sessions: SessionRevoker;
  /** Sends the invitation emails. */
  email: EmailSender;
  /** Where the emailed links point. From configuration, never from the request. */
  origins: PublicOrigins;
  clock?: () => Date;
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

  const lifecycle = lifecycleRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    lifecycle: createLifecycleService({
      invitations: options.invitations,
      sessions: options.sessions,
    }),
    directory: createDirectoryService(),
    email: options.email,
    origins: options.origins,
  });

  const hours = hoursRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    hours: createHoursService(options.clock ? { clock: options.clock } : {}),
  });

  return {
    professionals: createProfessionalRepo(options.withTenant),
    routes: (app) => {
      profile(app);
      lifecycle(app);
      hours(app);
    },
  };
}
