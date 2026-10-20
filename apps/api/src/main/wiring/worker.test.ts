import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { JobPayload } from '../../platform/jobs/boss.js';
import { defineJob, type JobContext, type JobDefinition } from '../../platform/jobs/define-job.js';
import type { WorkerJobContext } from '../../platform/jobs/worker.js';

import { combineWorkerContributions, mergeJobsByName } from './worker.js';

const TENANT = '0190a000-0000-7000-8000-000000000001';

function jobNamed(
  name: string,
  shape: z.ZodRawShape,
  handler: (context: JobContext<JobPayload>) => Promise<void>,
  category: JobDefinition['category'] = 'export',
): JobDefinition {
  return defineJob({
    name,
    category,
    payload: JobPayload.extend(shape) as unknown as JobDefinition['payload'],
    handler,
  });
}

function contextOf(payload: Record<string, unknown>): JobContext<JobPayload> {
  return {
    tx: {} as never,
    tenantId: TENANT,
    payload: { tenantId: TENANT, ...payload },
    job: { id: 'job-1', name: 'export.build', enqueuedAt: new Date(), retryCount: 0 },
  };
}

describe('jobs that share a queue', () => {
  it('leaves definitions with different names as they are, in order', () => {
    const a = jobNamed('a', {}, vi.fn());
    const b = jobNamed('b', {}, vi.fn());

    expect(mergeJobsByName([a, b])).toEqual([a, b]);
  });

  it('merges two definitions of one queue into one that hands each payload to the handler that accepts it', async () => {
    const billing = vi.fn<(context: JobContext<JobPayload>) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const cancellation = vi.fn<(context: JobContext<JobPayload>) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const merged = mergeJobsByName([
      jobNamed('export.build', { exportId: z.uuid() }, billing),
      jobNamed('export.build', { reason: z.literal('cancellation') }, cancellation),
    ]);

    expect(merged).toHaveLength(1);
    const [job] = merged;
    const exportId = '0190a000-0000-7000-8000-0000000000aa';
    await job?.handler(contextOf(job.payload.parse({ tenantId: TENANT, exportId })));
    await job?.handler(contextOf(job.payload.parse({ tenantId: TENANT, reason: 'cancellation' })));

    expect(billing).toHaveBeenCalledTimes(1);
    expect(cancellation).toHaveBeenCalledTimes(1);
    expect(billing.mock.calls[0]?.[0]).toMatchObject({ payload: { exportId } });
    expect(cancellation.mock.calls[0]?.[0]).toMatchObject({ payload: { reason: 'cancellation' } });
  });

  it('validates the payload against either shape and refuses one that fits neither', () => {
    const [job] = mergeJobsByName([
      jobNamed('export.build', { exportId: z.uuid() }, vi.fn()),
      jobNamed('export.build', { reason: z.literal('cancellation') }, vi.fn()),
    ]);

    expect(job?.payload.safeParse({ tenantId: TENANT, reason: 'cancellation' }).success).toBe(true);
    expect(job?.payload.safeParse({ tenantId: TENANT, reason: 'otra' }).success).toBe(false);
    expect(job?.payload.safeParse({ tenantId: TENANT }).success).toBe(false);
  });

  it('refuses to merge jobs of one queue that disagree on whether they run for a read-only organization', () => {
    expect(() =>
      mergeJobsByName([
        jobNamed('export.build', { exportId: z.uuid() }, vi.fn(), 'export'),
        jobNamed('export.build', { reason: z.literal('cancellation') }, vi.fn(), 'write'),
      ]),
    ).toThrow(/category/);
  });

  it('is what the worker registers: the jobs of two modules for one queue come out as one', () => {
    const parts = combineWorkerContributions([
      { jobs: () => [jobNamed('export.build', { exportId: z.uuid() }, vi.fn())] },
      { jobs: () => [jobNamed('export.build', { reason: z.literal('cancellation') }, vi.fn())] },
      { jobs: () => [jobNamed('other', {}, vi.fn())] },
    ]);

    const jobs = parts.jobs({} as WorkerJobContext);

    expect(jobs.map((job) => job.name)).toEqual(['export.build', 'other']);
  });
});
