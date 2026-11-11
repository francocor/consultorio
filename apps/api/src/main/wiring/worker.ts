import { z } from 'zod';

import type { JobPayload } from '../../platform/jobs/boss.js';
import type { JobDefinition } from '../../platform/jobs/define-job.js';

import type { WorkerContribution } from './types.js';

export type { WorkerContribution };

/**
 * One queue, one handler: the worker attaches a consumer per definition, and two consumers of the
 * same queue take each other's jobs (a job that one of them cannot read is cancelled for good). Two
 * modules can legitimately share a queue (`export.build` carries billing's exports and the
 * cancellation export), so the definitions that carry one name are merged into one. Its payload is
 * "any of the payloads", and its handler hands the job to the first member whose payload accepts it,
 * so each module keeps its own shape and its own handler and none reads the other's job.
 *
 * Members must agree on the category: a queue is allowed or refused for a read-only organization as
 * a whole.
 */
export function mergeJobsByName(definitions: readonly JobDefinition[]): JobDefinition[] {
  const groups = new Map<string, JobDefinition[]>();
  for (const definition of definitions) {
    groups.set(definition.name, [...(groups.get(definition.name) ?? []), definition]);
  }
  return [...groups.values()].map((members) => {
    const [first, ...rest] = members;
    if (!first || rest.length === 0) return first as JobDefinition;
    for (const member of rest) {
      if (member.category !== first.category) {
        throw new Error(
          `The jobs of the queue "${first.name}" disagree on their category (${first.category} and ${member.category})`,
        );
      }
    }
    const payloads = members.map((member) => member.payload) as unknown as [
      z.ZodType<JobPayload>,
      z.ZodType<JobPayload>,
      ...z.ZodType<JobPayload>[],
    ];
    return {
      name: first.name,
      category: first.category,
      payload: z.union(payloads),
      handler: (context) => {
        for (const member of members) {
          const parsed = member.payload.safeParse(context.payload);
          if (parsed.success) return member.handler({ ...context, payload: parsed.data });
        }
        // Unreachable: the merged payload only passes what a member accepts.
        return Promise.reject(
          new Error(`No job of the queue "${first.name}" accepts this payload`),
        );
      },
    } satisfies JobDefinition;
  });
}

/**
 * Joins what each module adds to the worker into the three hooks `startWorker` takes. The
 * platform worker knows no module: the composition root passes it this.
 */
export function combineWorkerContributions(
  parts: readonly WorkerContribution[],
): Required<WorkerContribution> {
  return {
    tenantJobs: parts.flatMap((part) => part.tenantJobs ?? []),
    jobs: (context) => mergeJobsByName(parts.flatMap((part) => part.jobs?.(context) ?? [])),
    schedules: (context) => parts.flatMap((part) => part.schedules?.(context) ?? []),
  };
}
