import { randomUUID } from 'node:crypto';

import type { Db } from '../../src/platform/db/pool.js';
import { JobPayload, type EnqueueOptions, type JobClient } from '../../src/platform/jobs/boss.js';
import {
  runJob,
  type JobDefinition,
  type JobRunResult,
} from '../../src/platform/jobs/define-job.js';

export interface RecordedJob {
  id: string;
  name: string;
  payload: JobPayload;
  options: EnqueueOptions;
  done: boolean;
}

export interface RecordingJobClient extends JobClient {
  jobs: RecordedJob[];
  /** Jobs of this queue that have not been run yet. */
  pending(name: string): RecordedJob[];
}

/**
 * A `JobClient` for tests that keeps what was enqueued instead of sending it to pg-boss, so a
 * test can look at it and run it with `runPending`. It does not join the caller's transaction;
 * tests that need that behaviour use the real client.
 */
export function createRecordingJobClient(): RecordingJobClient {
  const jobs: RecordedJob[] = [];
  return {
    jobs,
    pending: (name) => jobs.filter((job) => job.name === name && !job.done),
    enqueue(_tx, name, payload, options = {}) {
      const id = randomUUID();
      jobs.push({ id, name, payload: JobPayload.parse(payload), options, done: false });
      return Promise.resolve(id);
    },
  };
}

/**
 * Runs the jobs of these definitions that are pending NOW, the way the worker would. Jobs that
 * running them enqueues (a retry after a delay) wait for the next call, so a test controls how
 * many rounds happen.
 */
export async function runPending(
  db: Db,
  client: RecordingJobClient,
  definitions: readonly JobDefinition[],
): Promise<{ name: string; result: JobRunResult }[]> {
  const batch = client.jobs.filter(
    (job) => !job.done && definitions.some((definition) => definition.name === job.name),
  );
  const results: { name: string; result: JobRunResult }[] = [];
  for (const next of batch) {
    next.done = true;
    const definition = definitions.find((candidate) => candidate.name === next.name);
    if (!definition) continue;
    const result = await runJob(db, definition, {
      id: next.id,
      name: next.name,
      data: next.payload,
      enqueuedAt: new Date(),
      retryCount: 0,
    });
    results.push({ name: next.name, result });
  }
  return results;
}
