/**
 * Public API of the online-booking module (public booking links, holds and verified submissions).
 * Other modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 3: the module is wired and registered, and does nothing yet.
 * The public booking track (track B, S3.07 to S3.10) adds files under this folder and edits this one.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportOnlineBooking } from './application/export-contributor.js';

/** Registers what online-booking takes with an organization that leaves (the cancellation export). */
export function registerOnlineBookingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'online-booking', exportOnlineBooking);
}

export interface OnlineBookingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  clock?: () => Date;
}

export interface OnlineBooking {
  /** What the module was built with; the track builds its services from it. */
  readonly options: OnlineBookingOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createOnlineBooking(options: OnlineBookingOptions): OnlineBooking {
  return { options, routes: () => undefined };
}
