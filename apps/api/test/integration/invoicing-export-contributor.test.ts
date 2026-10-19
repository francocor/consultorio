import type { ChargeDto } from '@consultorio/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { registerAllExportContributors } from '../../src/main/export-contributors.js';
import { exportInvoicing } from '../../src/modules/invoicing/application/export-contributor.js';
import { createExportRegistry } from '../../src/modules/tenancy/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { generateDevCertificate } from '../../src/testing/dev-afip-certificate.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * What invoicing contributes to the administrative export of an organization that leaves (tenancy,
 * the cancellation export; JD-S4 R1-C5): its fiscal profile, points of sale, invoices with their
 * lines and the metadata of their documents, and of nobody else; never the certificate, its key or
 * the internal hash of a request.
 */

let runtime: DbHandle;
let mine: InvoicingWorld;
let theirs: InvoicingWorld;
let charge: ChargeDto;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  mine = await createInvoicingWorld(runtime, { slug: 'invoicing-contributor' });
  theirs = await createInvoicingWorld(runtime, { slug: 'invoicing-contributor-b' });
  const made = generateDevCertificate({ cuit: '20123456786', validDays: 365, algorithm: 'ec' });
  const uploaded = await mine.api.put('/invoicing/credentials', mine.owner, {
    certificate: made.certificate,
    privateKey: made.privateKey,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  charge = await mine.charge();
  await mine.issueInvoiceOf(charge);
  await mine.runDocuments();
  await theirs.issueInvoiceOf(await theirs.charge());
  await theirs.issueInvoiceOf(await theirs.charge());
});

afterAll(async () => {
  await mine.close();
  await theirs.close();
  await runtime.close();
});

interface Part {
  fiscalProfiles: Record<string, unknown>[];
  pointsOfSale: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  invoiceLines: Record<string, unknown>[];
  invoiceDocuments: Record<string, unknown>[];
}

const contribute = (world: InvoicingWorld) =>
  asTenant(runtime, world.tenant.id, (tx) =>
    exportInvoicing({ tx, tenantId: world.tenant.id }),
  ) as Promise<Part>;

describe('the administrative export of invoicing', () => {
  it('lists the profile, the points of sale, the invoices with their lines and the document metadata', async () => {
    const part = await contribute(mine);

    expect(part.fiscalProfiles).toHaveLength(1);
    expect(part.fiscalProfiles[0]).toMatchObject({ cuit: '20123456786' });
    expect(part.pointsOfSale).toEqual([expect.objectContaining({ number: 1 })]);
    expect(part.invoices).toHaveLength(1);
    expect(part.invoices[0]).toMatchObject({ status: 'issued', type: 'FC', totalCents: 2_000_000 });
    expect(part.invoiceLines).toEqual([
      expect.objectContaining({ chargeId: charge.id, amountCents: 2_000_000 }),
    ]);
    expect(part.invoiceDocuments).toHaveLength(1);
    expect(part.invoiceDocuments[0]).toMatchObject({ invoiceId: part.invoices[0]?.['id'] });
  });

  it('carries nothing of another organization', async () => {
    const part = await contribute(mine);
    const other = await contribute(theirs);

    expect(part.invoices.every((entry) => entry['tenantId'] === mine.tenant.id)).toBe(true);
    expect(other.invoices).toHaveLength(2);
    expect(other.invoices.every((entry) => entry['tenantId'] === theirs.tenant.id)).toBe(true);
  });

  it('never carries the certificate or its key, nor the internal hash of a request', async () => {
    const part = await contribute(mine);
    const text = JSON.stringify(part);

    expect(Object.keys(part)).not.toContain('fiscalCredentials');
    expect(text).not.toMatch(/certificateEnc|privateKeyEnc|certificate_enc|private_key_enc|BEGIN/);
    expect(text).not.toMatch(/subjectCuit|fingerprint/);
    expect(part.invoices[0]).not.toHaveProperty('requestHash');
  });

  it('is registered with the administrative contributors of the application', () => {
    const registry = createExportRegistry();
    registerAllExportContributors(registry);

    expect(registry.list('administrative').map((entry) => entry.name)).toContain('invoicing');
  });
});
