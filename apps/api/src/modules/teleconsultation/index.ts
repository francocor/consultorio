/**
 * Public API of the teleconsultation module (video links for virtual appointments).
 * Other modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 3: the module is wired and registered, and does nothing yet.
 * The teleconsultation track (track D, S3.14 and S3.15) adds files under this folder and edits this one.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportTeleconsultation } from './application/export-contributor.js';

export type { VideoLinkProvider, VideoRoom } from './application/ports.js';

/** Registers what teleconsultation takes with an organization that leaves (the cancellation export). */
export function registerTeleconsultationExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'teleconsultation', exportTeleconsultation);
}

export interface TeleconsultationOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  clock?: () => Date;
}

export interface Teleconsultation {
  /** What the module was built with; the track builds its services from it. */
  readonly options: TeleconsultationOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createTeleconsultation(options: TeleconsultationOptions): Teleconsultation {
  return { options, routes: () => undefined };
}
