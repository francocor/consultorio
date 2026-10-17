import { createScanJob, type ScanJobDeps } from './scan-job.js';

export type DocumentJobsDeps = ScanJobDeps;

export type DocumentJobs = ReturnType<typeof createDocumentJobs>;

/** The background jobs of the documents module. Only the worker registers them. */
export function createDocumentJobs(deps: DocumentJobsDeps) {
  const scan = createScanJob(deps);
  return { scan, all: [scan] as const };
}
