import { describe, expect, it } from 'vitest';

import type { Tx } from '../../../platform/db/tenant-context.js';
import { createExportRegistry } from '../../tenancy/index.js';
import { registerSubscriptionsExportContributors } from '../index.js';

const tx = {} as Tx;
const TENANT = '0190a000-0000-7000-8000-0000000000e1';

// What the part delivers is proved against a real database by the subscriptions track (S6.05, S6.08).
describe('the subscriptions export contributor', () => {
  it('registers one administrative part (statements, no payment method) and no clinical one', () => {
    const registry = createExportRegistry();

    registerSubscriptionsExportContributors(registry);

    expect(registry.list().map((entry) => [entry.kind, entry.name])).toEqual([
      ['administrative', 'subscriptions'],
    ]);
  });

  it('has a part to hand over before the tables exist: the subscription and its statements, empty', async () => {
    const registry = createExportRegistry();
    registerSubscriptionsExportContributors(registry);

    const part = await registry.list()[0]?.contribute({ tx, tenantId: TENANT });

    expect(part).toEqual({ subscription: null, statements: [] });
  });
});
