/**
 * Public API of the access module: grantable permissions, role changes, organization settings,
 * locations and the locations of each member. Other modules and the composition root import from
 * here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import type { SettingsSectionRegistry } from '../../platform/settings-sections.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportAccess } from './application/export-contributor.js';
import { createGrants, type Grants } from './application/grants.js';
import { createLocationService } from './application/locations.js';
import { createRoleService, type SeatLimit, type SessionRevoker } from './application/roles.js';
import { createSettingsService } from './application/settings.js';
import { locationRoutes } from './http/location-routes.js';
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
export { seesEveryLocation, visibleLocationIds } from './application/locations.js';
export type { LocationViewer } from './application/locations.js';
export { AccessRefused } from './application/refusal.js';
export { createLocationService } from './application/locations.js';
export type { LocationService } from './application/locations.js';
export { addProfessionalRoleToOwner } from './application/owner-professional.js';
export {
  prepareProfessionalAddedNotice,
  sendProfessionalAddedNotice,
} from './application/professional-notice.js';
export type { ProfessionalAddedNotice } from './application/professional-notice.js';
export type { SeatLimit, SessionRevoker } from './application/roles.js';

export interface AccessOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Ends the sessions of a member whose roles changed. */
  sessions: SessionRevoker;
  /** The limit of professionals of the plan, asked when a role that takes a seat is given back. */
  seats?: SeatLimit;
  grants?: Grants;
  /** Time zone of a new location without one, from the country of the organization. */
  defaultTimeZone: (country: string) => string;
  /** The sections of the organization settings that the capability modules registered. */
  settingsSections: SettingsSectionRegistry;
  /** Tells the owners when an admin adds a professional (decision D19). */
  email: EmailSender;
  /** Where the emailed links point. From configuration, never from the request. */
  origins: PublicOrigins;
}

export interface Access {
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createAccess(options: AccessOptions): Access {
  const grants = options.grants ?? createGrants();
  const roles = createRoleService({
    sessions: options.sessions,
    ...(options.seats ? { seats: options.seats } : {}),
  });
  const members = memberRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    grants,
    roles,
    email: options.email,
    origins: options.origins,
  });

  const settings = settingsRoutes({
    withTenant: options.withTenant,
    settings: createSettingsService({ sections: options.settingsSections }),
  });

  const places = locationRoutes({
    withTenant: options.withTenant,
    locations: createLocationService(),
    defaultTimeZone: options.defaultTimeZone,
  });

  return {
    routes: (app) => {
      members(app);
      places(app);
      settings(app);
    },
  };
}
