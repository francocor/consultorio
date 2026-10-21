import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { registerAllExportContributors } from '../../src/main/export-contributors.js';
import { exportBilling } from '../../src/modules/billing/application/export-contributor.js';
import { createExportRegistry } from '../../src/modules/tenancy/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { settled } from '../support/export-sections.js';
import { asTenant } from '../support/tenants.js';

/**
 * What billing contributes to the administrative export of an organization that leaves
 * (billing-payments, "Exports"; tenancy, the cancellation export): all the money data of that
 * organization and of nobody else, without clinical content.
 */

let runtime: DbHandle;
let mine: BillingWorld;
let theirs: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  mine = await createBillingWorld(runtime, { slug: 'billing-contributor' });
  theirs = await createBillingWorld(runtime, { slug: 'billing-contributor-b' });
  for (const world of [mine, theirs]) {
    await world.setPrice(1_000_000);
    await world.openRegister();
    const charge = await world.charge();
    await world.pay(charge.id, { method: 'cash', amountCents: 400_000 });
  }
  await theirs.charge();
});

afterAll(async () => {
  await mine.close();
  await theirs.close();
  await runtime.close();
});

interface Part {
  prices: unknown[];
  charges: { tenantId: string }[];
  chargeLines: unknown[];
  payments: Record<string, unknown>[];
  paymentReversals: unknown[];
  cashSessions: unknown[];
}

const contribute = (world: BillingWorld) =>
  asTenant(runtime, world.tenant.id, (tx) =>
    settled(exportBilling({ tx, tenantId: world.tenant.id })),
  ) as Promise<Part>;

describe('the administrative export of billing', () => {
  it('lists the prices, charges with their lines, payments and registers of the organization', async () => {
    const part = await contribute(mine);

    expect(part.prices).toHaveLength(1);
    expect(part.charges).toHaveLength(1);
    expect(part.chargeLines).toHaveLength(1);
    expect(part.payments).toHaveLength(1);
    expect(part.cashSessions).toHaveLength(1);
    expect(part.payments[0]).toMatchObject({ method: 'cash', amountCents: 400_000 });
  });

  it('carries nothing of another organization', async () => {
    const part = await contribute(mine);
    const other = await contribute(theirs);

    expect(part.charges.every((entry) => entry.tenantId === mine.tenant.id)).toBe(true);
    expect(other.charges).toHaveLength(2);
    expect(other.charges.every((entry) => entry.tenantId === theirs.tenant.id)).toBe(true);
  });

  it('has no clinical content and no card data, and leaves out the internal hash of a request', async () => {
    const part = await contribute(mine);
    const text = JSON.stringify(part);

    expect(text).not.toMatch(/diagnos|prescri|anamnes|clinical_note|content_enc|cardNumber|"pan"/i);
    expect(part.payments[0]).not.toHaveProperty('requestHash');
  });

  it('is registered with the administrative contributors of the application', () => {
    const registry = createExportRegistry();
    registerAllExportContributors(registry);

    expect(registry.list('administrative').map((entry) => entry.name)).toContain('billing');
    expect(registry.list('clinical').map((entry) => entry.name)).not.toContain('billing');
  });
});
