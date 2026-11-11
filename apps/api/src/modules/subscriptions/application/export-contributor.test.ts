import { describe, expect, it } from 'vitest';

import { createExportRegistry } from '../../tenancy/index.js';
import { registerSubscriptionsExportContributors } from '../index.js';

// What the part delivers is proved against a real database in `test/integration/statement.test.ts`.
describe('the subscriptions export contributor', () => {
  it('registers one administrative part (statements, no payment method) and no clinical one', () => {
    const registry = createExportRegistry();

    registerSubscriptionsExportContributors(registry);

    expect(registry.list().map((entry) => [entry.kind, entry.name])).toEqual([
      ['administrative', 'subscriptions'],
    ]);
  });
});
