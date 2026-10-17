/**
 * Public API of the documents module: patient attachments (upload, scan, download, lifecycle).
 * Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { FileResourceRegistry } from '../../platform/files/file-resources.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createDownloadService } from './application/downloads.js';
import {
  exportAdministrativeDocuments,
  exportClinicalDocuments,
} from './application/export-contributor.js';
import { createDocumentFileResource } from './application/file-resource.js';
import { createLifecycleService } from './application/lifecycle.js';
import { createListingService } from './application/listing.js';
import { createUploadService } from './application/uploads.js';
import { accessRoutes } from './http/access-routes.js';
import { uploadRoutes } from './http/document-routes.js';

export {
  CLEANUP_JOB,
  createCleanupJob as createDocumentCleanup,
} from './application/cleanup-job.js';
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
  /** Where the links of `/files/:token` are served: the module registers its own kind here. */
  fileResources: FileResourceRegistry;
  clock?: () => Date;
}

export interface Documents {
  routes: (app: FastifyInstance) => void;
}

export function createDocuments(options: DocumentsOptions): Documents {
  const clock = options.clock ?? (() => new Date());
  const common = { withTenant: options.withTenant, auditDeny: options.auditDeny };
  const upload = uploadRoutes({
    ...common,
    uploads: createUploadService({ storage: options.storage, jobs: options.jobs, clock }),
  });
  // The five minutes of a link are counted on the same clock as the rest of the module.
  const downloads = createDownloadService({ tokens: createActionTokens({ clock }) });
  options.fileResources.register(createDocumentFileResource(downloads));
  const access = accessRoutes({
    ...common,
    listing: createListingService(),
    downloads,
    lifecycle: createLifecycleService({ clock }),
  });

  return {
    routes: (app) => {
      upload(app);
      access(app);
    },
  };
}
