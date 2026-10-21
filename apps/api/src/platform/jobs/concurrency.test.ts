import { describe, expect, it } from 'vitest';

import { JOB_CATEGORIES } from '../read-only/jobs.js';

import { CONNECTION_HOLDING_JOBS, PENDING_CONNECTION_HOLDING_JOBS } from './concurrency.js';
import { QUEUES } from './queues.js';

describe('the job families that wait for an outside service', () => {
  const queueNames = QUEUES.map((queue) => queue.name);

  it('names only queues that exist and are classified, in both lists', () => {
    for (const name of [...CONNECTION_HOLDING_JOBS, ...PENDING_CONNECTION_HOLDING_JOBS]) {
      expect(queueNames, name).toContain(name);
      expect(JOB_CATEGORIES[name], name).toBeDefined();
    }
  });

  it('never counts a family twice: a pending one is not yet in the list that sets the pool floor', () => {
    for (const name of PENDING_CONNECTION_HOLDING_JOBS) {
      expect(CONNECTION_HOLDING_JOBS as readonly string[], name).not.toContain(name);
    }
    expect(new Set(PENDING_CONNECTION_HOLDING_JOBS).size).toBe(
      PENDING_CONNECTION_HOLDING_JOBS.length,
    );
  });

  it('lists the Stage 6 jobs that call the payments gateway or the archive store, so a track cannot forget them', () => {
    // Every Stage 6 job that waits on the payments gateway or the archive store is in one of the two
    // lists, so a track cannot forget the pool: the worker families set the floor, the releaser has its own.
    expect([...PENDING_CONNECTION_HOLDING_JOBS, ...CONNECTION_HOLDING_JOBS].sort()).toEqual(
      expect.arrayContaining([
        'archive.release',
        'archive.verify',
        'archive.write',
        'dunning.step',
        'export.build',
        'subscription.reconcile',
      ]),
    );
    expect([...PENDING_CONNECTION_HOLDING_JOBS]).toEqual(['archive.release']);
  });
});
