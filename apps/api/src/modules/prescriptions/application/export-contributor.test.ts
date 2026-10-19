import { describe, expect, it } from 'vitest';

import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { createExportRegistry } from '../../tenancy/index.js';
import { registerPrescriptionsExportContributors } from '../index.js';

const keys = {} as TenantKeys;
const tx = {} as Tx;
const TENANT = '0190a000-0000-7000-8000-0000000000e1';
const PROFESSIONAL = '0190a000-0000-7000-8000-0000000000f1';

function contributors(deps?: { keys?: TenantKeys }) {
  const registry = createExportRegistry();
  registerPrescriptionsExportContributors(registry, deps);
  return registry.list();
}

describe('the prescriptions export contributor (seam skeleton)', () => {
  it('is clinical only: each professional receives their own prescriptions', () => {
    expect(contributors().map((entry) => [entry.kind, entry.name])).toEqual([
      ['clinical', 'prescriptions'],
    ]);
  });

  it('hands a professional the prescriptions they issued', async () => {
    const [clinical] = contributors({ keys });

    await expect(
      clinical?.contribute({ tx, tenantId: TENANT, professionalId: PROFESSIONAL }),
    ).resolves.toEqual({ prescriptions: [] });
  });

  it('refuses to deliver a part it cannot decrypt, or one that is not for a professional', async () => {
    const [withoutKeys] = contributors();
    const [withKeys] = contributors({ keys });

    await expect(
      withoutKeys?.contribute({ tx, tenantId: TENANT, professionalId: PROFESSIONAL }),
    ).rejects.toThrow(/key service/);
    await expect(withKeys?.contribute({ tx, tenantId: TENANT })).rejects.toThrow(
      /one professional/,
    );
  });
});
