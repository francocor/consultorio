import { describe, expect, it } from 'vitest';

import { CONNECTION_HOLDING_JOBS } from '../../../platform/jobs/concurrency.js';
import type { SubscriptionDeps } from '../application/provider.js';

import { createSubscriptionJobs } from './subscription-jobs.js';

/**
 * The floor of the connection pool is computed from `CONNECTION_HOLDING_JOBS`: a job that keeps the
 * transaction the framework opened for it idle while it works through short transactions of its own
 * (`deps.withTenant`), or while it waits for the payments provider, holds TWO connections, and the pool
 * must have room for every one that runs at once. A list written by hand forgot three of them
 * (JD-S6 R1, A-W4), so this one is DERIVED: every handler of the module is run against probes, and a
 * handler that reaches `deps.withTenant` or the provider is in the list, or the test fails.
 */

const TENANT = '0192f3a0-6b2c-7000-8000-000000000001';

describe('the jobs of the subscriptions that hold a second connection are all counted in the pool floor', () => {
  it('lists every handler that works through short transactions of its own or asks the provider', async () => {
    const touched = { withTenant: 0, adapters: 0 };
    const deps: SubscriptionDeps = {
      withTenant: () => {
        touched.withTenant += 1;
        return Promise.reject(new Error('probe'));
      },
      adapters: {
        forTenant: () => {
          touched.adapters += 1;
          return undefined;
        },
      },
      clock: () => new Date('2026-10-20T15:00:00.000Z'),
    };
    const jobs = createSubscriptionJobs(deps).definitions;
    expect(jobs.length).toBeGreaterThanOrEqual(5);

    const holders: string[] = [];
    for (const definition of jobs) {
      touched.withTenant = 0;
      touched.adapters = 0;
      await definition
        .handler({
          // The transaction of the framework: if a handler used it instead, it would throw here, not
          // reach `deps.withTenant`, and need no second connection.
          tx: {} as never,
          tenantId: TENANT,
          payload: { tenantId: TENANT },
          job: { id: 'probe', name: definition.name, enqueuedAt: new Date(), retryCount: 0 },
        })
        .catch(() => undefined);
      if (touched.withTenant > 0 || touched.adapters > 0) holders.push(definition.name);
    }

    expect(holders.sort()).toEqual(
      [
        'dunning.step',
        'statement.generate',
        'subscription.reconcile',
        'trial.end',
        'usage.snapshot',
      ].sort(),
    );
    for (const name of holders) {
      expect(CONNECTION_HOLDING_JOBS as readonly string[], name).toContain(name);
    }
  });
});
