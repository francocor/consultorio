/**
 * Public API of the waitlist module (waiting entries and the offers of freed slots).
 * Other modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 3: the module is wired and registered, and does nothing yet.
 * The waitlist track (track C, S3.11 to S3.13) adds files under this folder and edits this one.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportWaitlist } from './application/export-contributor.js';

/** Registers what waitlist takes with an organization that leaves (the cancellation export). */
export function registerWaitlistExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'waitlist', exportWaitlist);
}

export interface WaitlistOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  clock?: () => Date;
}

export interface Waitlist {
  /** What the module was built with; the track builds its services from it. */
  readonly options: WaitlistOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createWaitlist(options: WaitlistOptions): Waitlist {
  return { options, routes: () => undefined };
}
