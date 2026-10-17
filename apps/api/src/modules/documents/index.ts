/**
 * Public API of the documents module: patient attachments (upload, scan, download, lifecycle).
 * Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import type { ExportRegistry } from '../tenancy/index.js';

import {
  exportAdministrativeDocuments,
  exportClinicalDocuments,
} from './application/export-contributor.js';
import { createUploadService } from './application/uploads.js';
import { uploadRoutes } from './http/document-routes.js';

export { createDocumentJobs } from './application/jobs.js';
export type { DocumentJobs, DocumentJobsDeps } from './application/jobs.js';
export type { RejectionNotice, ScanAlert } from './application/scan-job.js';
export { SCAN_JOB } from './application/uploads.js';

/** Registers what documents contributes to the cancellation export: one part per classification. */
export function registerDocumentsExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'documents', exportAdministrativeDocuments);
  registry.registerExportContributor('clinical', 'documents', exportClinicalDocuments);
}

export interface DocumentsOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Absent when no bucket is configured: the routes then answer "unavailable". */
  storage: ObjectStorage | undefined;
  /** Enqueues the scan of a confirmed upload. */
  jobs: JobClient | undefined;
  clock?: () => Date;
}

export interface Documents {
  routes: (app: FastifyInstance) => void;
}

export function createDocuments(options: DocumentsOptions): Documents {
  const clock = options.clock ?? (() => new Date());
  const uploads = createUploadService({ storage: options.storage, jobs: options.jobs, clock });
  const upload = uploadRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    uploads,
  });

  return {
    routes: (app) => {
      upload(app);
    },
  };
}
