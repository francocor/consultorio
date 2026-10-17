import { createCleanupJob } from './cleanup-job.js';
import { createScanJob, type ScanJobDeps } from './scan-job.js';

export type DocumentJobsDeps = ScanJobDeps;

export type DocumentJobs = ReturnType<typeof createDocumentJobs>;

/** The background jobs of the documents module. Only the worker registers them. */
export function createDocumentJobs(deps: DocumentJobsDeps) {
  const scan = createScanJob(deps);
  const cleanup = createCleanupJob({ storage: deps.storage, jobs: deps.jobs, clock: deps.clock });
  return { scan, cleanup, all: [scan, cleanup] as const };
}
