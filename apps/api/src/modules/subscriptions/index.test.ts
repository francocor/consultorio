import { describe, expect, it } from 'vitest';

import { UNLIMITED_QUOTA } from '../notifications/index.js';

import {
  createQuotaPolicy,
  createSubscriptionPlanImpact,
  createSubscriptions,
  createTrialStarter,
} from './index.js';

// The doors other modules call exist and are built without a database. What they do against a real
// database is proven in `test/integration/subscription-state.test.ts` and its neighbours.
describe('the doors of the subscriptions module', () => {
  it('builds the three doors the other modules call', () => {
    expect(typeof createTrialStarter().startTrial).toBe('function');
    expect(typeof createSubscriptionPlanImpact().preview).toBe('function');
    expect(typeof createQuotaPolicy().limitFor).toBe('function');
  });

  it('keeps the Stage 3 policy of counting only until the plan supplies a quota', () => {
    // Replaced by the plan's quota in S6.06; this guards the rollback of that slice.
    expect(createQuotaPolicy()).toBe(UNLIMITED_QUOTA);
  });

  it('builds a module with the routes of the owner and keeps what it was given for the track', () => {
    const options = {
      withTenant: (() => undefined) as never,
      auditDeny: (() => undefined) as never,
      email: { send: () => Promise.resolve() } as never,
      origins: {} as never,
      tenantCancelled: { publishCancelled: () => Promise.resolve() },
    };

    const subscriptions = createSubscriptions(options);

    expect(subscriptions.options).toBe(options);
    expect(subscriptions.routes).toBeTypeOf('function');
  });
});
