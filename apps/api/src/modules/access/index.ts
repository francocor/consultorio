/**
 * Public API of the access module: grantable permissions, role changes, organization settings,
 * locations and the locations of each member. Other modules and the composition root import from
 * here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportAccess } from './application/export-contributor.js';
import { createGrants, type Grants } from './application/grants.js';
import { createRoleService, type SessionRevoker } from './application/roles.js';
import { createSettingsService } from './application/settings.js';
import { memberRoutes } from './http/member-routes.js';
import { settingsRoutes } from './http/settings-routes.js';

/** Registers what access contributes to the cancellation export. */
export function registerAccessExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'access', exportAccess);
}

export { createGrants, createGrantsRepo } from './application/grants.js';
export type { Grants } from './application/grants.js';
export { countOtherActiveOwners, loadMember, lockOwnersAnd } from './application/members.js';
export type { MemberRecord } from './application/members.js';
export { AccessRefused } from './application/refusal.js';

export interface AccessOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Ends the sessions of a member whose roles changed. */
  sessions: SessionRevoker;
  grants?: Grants;
}

export interface Access {
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createAccess(options: AccessOptions): Access {
  const grants = options.grants ?? createGrants();
  const roles = createRoleService({ sessions: options.sessions });
  const members = memberRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    grants,
    roles,
  });

  const settings = settingsRoutes({
    withTenant: options.withTenant,
    settings: createSettingsService(),
  });

  return {
    routes: (app) => {
      members(app);
      settings(app);
    },
  };
}
