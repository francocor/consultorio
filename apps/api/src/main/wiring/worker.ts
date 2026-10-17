import type { WorkerContribution } from './types.js';

export type { WorkerContribution };

/**
 * Joins what each module adds to the worker into the three hooks `startWorker` takes. The
 * platform worker knows no module: the composition root passes it this.
 */
export function combineWorkerContributions(
  parts: readonly WorkerContribution[],
): Required<WorkerContribution> {
  return {
    tenantJobs: parts.flatMap((part) => part.tenantJobs ?? []),
    jobs: (context) => parts.flatMap((part) => part.jobs?.(context) ?? []),
    schedules: (context) => parts.flatMap((part) => part.schedules?.(context) ?? []),
  };
}
