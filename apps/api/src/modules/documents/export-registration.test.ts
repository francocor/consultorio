import { describe, expect, it } from 'vitest';

import { registerAllExportContributors } from '../../main/export-contributors.js';
import { createExportRegistry } from '../tenancy/index.js';

describe('documents in the cancellation export', () => {
  it('registers one part for each classification, so every document leaves with the right owner', () => {
    const registry = createExportRegistry();

    registerAllExportContributors(registry);

    expect(registry.list('administrative').map((entry) => entry.name)).toContain('documents');
    expect(registry.list('clinical').map((entry) => entry.name)).toContain('documents');
  });
});
