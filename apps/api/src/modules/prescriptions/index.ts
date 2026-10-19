/**
 * Public API of the prescriptions module (e-prescription under Ley 27.553). Other modules and the
 * composition root import from here only.
 *
 * This is the seam skeleton of Stage 5: the module is wired and registered, and does nothing yet.
 * The e-Rx track (Track A3, S5.04 and S5.05) adds files under this folder and edits this one. The
 * provider is the `prescriptionProvider` port of the adapter resolver; a prescription is read by
 * another module (the portal) only through the list function this file exports.
 */
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { FileResourceRegistry } from '../../platform/files/file-resources.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportPrescriptions } from './application/export-contributor.js';

/** Registers what prescriptions takes with an organization that leaves: each professional's own. */
export function registerPrescriptionsExportContributors(
  registry: ExportRegistry,
  deps: { keys?: TenantKeys } = {},
): void {
  registry.registerExportContributor('clinical', 'prescriptions', exportPrescriptions(deps.keys));
}

export interface PrescriptionsOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Encrypts the items of a prescription with the data key of the organization. */
  keys: TenantKeys;
  /** Which provider serves which organization (the simulator, the real one, or none). */
  adapters?: AdapterResolver | undefined;
  /** Queues the submission of a prescription the provider did not confirm. */
  jobs?: JobClient | undefined;
  /** Where `GET /files/:token` finds the resource of a prescription document. */
  fileResources?: FileResourceRegistry | undefined;
  clock?: () => Date;
}

export interface Prescriptions {
  /** What the module was built with; the track builds its services from it. */
  readonly options: PrescriptionsOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createPrescriptions(options: PrescriptionsOptions): Prescriptions {
  return { options, routes: () => undefined };
}
