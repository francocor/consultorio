import { describe, expect, it } from 'vitest';

import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { createExportRegistry } from '../../tenancy/index.js';
import { registerConsentExportContributors } from '../index.js';

const keys = {} as TenantKeys;
const tx = {} as Tx;
const TENANT = '0190a000-0000-7000-8000-0000000000e1';
const PROFESSIONAL = '0190a000-0000-7000-8000-0000000000f1';

function contributors(deps?: { keys?: TenantKeys }) {
  const registry = createExportRegistry();
  registerConsentExportContributors(registry, deps);
  return registry.list();
}

// What each part delivers is proved against a real database in test/integration/consent-signing.test.ts.
describe('the consent export contributors', () => {
  it('registers an administrative part for the owner and a clinical part per professional', () => {
    expect(contributors().map((entry) => [entry.kind, entry.name])).toEqual([
      ['administrative', 'consent'],
      ['clinical', 'consent'],
    ]);
  });

  it('refuses to deliver a clinical part it cannot decrypt, or one that is not for a professional', async () => {
    const withoutKeys = contributors()[1];
    const withKeys = contributors({ keys })[1];

    await expect(
      withoutKeys?.contribute({ tx, tenantId: TENANT, professionalId: PROFESSIONAL }),
    ).rejects.toThrow(/key service/);
    await expect(withKeys?.contribute({ tx, tenantId: TENANT })).rejects.toThrow(
      /one professional/,
    );
  });
});
