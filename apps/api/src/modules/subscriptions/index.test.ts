import { describe, expect, it } from 'vitest';

import type { Tx } from '../../platform/db/tenant-context.js';
import { UNLIMITED_QUOTA } from '../notifications/index.js';
import { noPlanImpact } from '../onboarding/index.js';

import {
  createQuotaPolicy,
  createSubscriptionPlanImpact,
  createSubscriptions,
  createTrialStarter,
} from './index.js';

const tx = {} as Tx;

// Seam skeleton of Stage 6: the doors other modules call exist and answer "no effect" until the
// subscriptions track (A) fills them in. They are what keeps a single-tenant deployment unchanged.
describe('the doors of the subscriptions module', () => {
  it('lets every invitation through unchanged until subscriptions exist: the plan is not affected', async () => {
    const impact = createSubscriptionPlanImpact();

    expect(await impact.preview(tx, { roles: ['professional'] })).toEqual(
      await noPlanImpact.preview(tx, { roles: ['professional'] }),
    );
    expect(await impact.preview(tx, { roles: ['reception', 'admin'] })).toEqual({
      affectsPlan: false,
    });
  });

  it('applies no quota until the plan supplies one: the Stage 3 policy of counting only', () => {
    expect(createQuotaPolicy()).toBe(UNLIMITED_QUOTA);
  });

  it('refuses to start a trial it cannot start, instead of activating an organization with no plan', async () => {
    await expect(createTrialStarter().startTrial(tx, { tenantId: 'org-1' })).rejects.toThrow(
      /S6\.01/,
    );
  });

  it('builds a module that serves no route yet and keeps what it was given for the track', () => {
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
