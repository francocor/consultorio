/**
 * Public API of the prescriptions module (e-prescription under Ley 27.553). Other modules and the
 * composition root import from here only.
 *
 * A prescription is clinical: only the prescriber and the professionals who treat the patient read
 * it, and the sharing scope of the organization never opens one (design D17). It is valid only when
 * the provider (the `prescriptionProvider` port of the adapter resolver) confirmed it. The patient
 * portal reads the list of a patient's prescriptions and opens their documents through the
 * functions exported here, and nothing else.
 */
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { FileResourceRegistry } from '../../platform/files/file-resources.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import type { AttemptLog, PrescriptionDeps } from './application/common.js';
import { createPrescriptionFileResource } from './application/document.js';
import { exportPrescriptions } from './application/export-contributor.js';
import { connectionRoutes } from './http/connection-routes.js';
import { prescriptionRoutes, type GenericNameCatalog } from './http/prescription-routes.js';
import { webhookRoutes, type WebhookVerifier } from './http/webhook-routes.js';

export { createErxJobs, ERX_RECONCILE_JOB, ERX_SUBMIT_JOB } from './jobs/erx-jobs.js';
export type { ErxJobs } from './jobs/erx-jobs.js';
export { asWebhookVerifier } from './http/webhook-routes.js';
export type { WebhookVerifier } from './http/webhook-routes.js';
export type { GenericNameCatalog } from './http/prescription-routes.js';
export type { AttemptLog, PrescriptionDeps } from './application/common.js';
// The patient portal (Stage 5): the prescriptions of one patient, and the document of one of them.
export { listPrescriptionsForPatient } from './application/portal.js';
export { openPortalDocument } from './application/document.js';
export type { PortalDocumentInput } from './application/document.js';
export { reconcileOrganization } from './application/settle.js';

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
  /** Where the PDF of a prescription is stored. Without a bucket a prescription has no document. */
  storage?: ObjectStorage | undefined;
  /** Checks the signature of a provider notice. Absent: no provider signs one, no webhook. */
  webhookVerifier?: WebhookVerifier | undefined;
  /** The generic names the form of a prescription suggests. */
  catalog?: GenericNameCatalog | undefined;
  log?: AttemptLog | undefined;
  clock?: () => Date;
}

export interface Prescriptions {
  /** What the module was built with; the track builds its services from it. */
  readonly options: PrescriptionsOptions;
  /** What the services of the module run with (the jobs and the tests build on it). */
  readonly services: PrescriptionDeps;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

const NO_NAMES: GenericNameCatalog = { search: () => [] };

export function createPrescriptions(options: PrescriptionsOptions): Prescriptions {
  const clock = options.clock ?? (() => new Date());
  const services: PrescriptionDeps = {
    keys: options.keys,
    adapters: options.adapters,
    clock,
    jobs: options.jobs,
    withTenant: options.withTenant,
    storage: options.storage,
    log: options.log,
  };
  const tokens = createActionTokens({ clock });
  const prescriptions = prescriptionRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    services,
    tokens,
    catalog: options.catalog ?? NO_NAMES,
  });
  const connection = connectionRoutes({ withTenant: options.withTenant, services });
  const webhook = webhookRoutes({
    withTenant: options.withTenant,
    verifier: options.webhookVerifier,
    jobs: options.jobs,
  });
  // The PDFs of the prescriptions open through the one door of the platform, with their own rules.
  options.fileResources?.register(createPrescriptionFileResource(tokens));
  return {
    options,
    services,
    routes: (app) => {
      prescriptions(app);
      connection(app);
      webhook(app);
    },
  };
}
