import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { MIGRATIONS_FOLDER } from '../../src/db/migrate.js';
import { loadDocumentData } from '../../src/modules/invoicing/application/invoice-document.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Migration 0492 gives every invoice the issuer it was requested with. The invoices that exist when
 * it runs get the issuer of the fiscal profile of their organization (JD-S4 R1-C7). The block is the
 * one of the migration itself, run here against rows with no snapshot.
 */

let runtime: DbHandle;
let world: InvoicingWorld;
let backfill: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-issuer-backfill' });
  const file = await readFile(`${MIGRATIONS_FOLDER}/0492_invoice_issuer_snapshot.sql`, 'utf8');
  const block = file.split('--> statement-breakpoint').find((part) => part.includes('DO $$'));
  if (!block) throw new Error('the backfill block of 0492 is missing');
  backfill = block;
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function asRole<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

describe('the backfill of the issuer of the invoices (migration 0492)', () => {
  it('gives an invoice without a snapshot the issuer of the profile, and leaves the others alone', async () => {
    const issued = await world.issueInvoiceOf(await world.charge());
    const kept = await world.issueInvoiceOf(await world.charge());
    // An invoice of before the column: no snapshot (the superuser switches the guard off to say so).
    await asRole(inject('adminUrl'), async (admin) => {
      await admin.query('ALTER TABLE invoice DISABLE TRIGGER invoice_guard');
      await admin.query('UPDATE invoice SET issuer_snapshot = NULL WHERE id = $1', [issued.id]);
      await admin.query(
        `UPDATE invoice SET issuer_snapshot = jsonb_set(issuer_snapshot, '{businessName}', '"Otra"') WHERE id = $1`,
        [kept.id],
      );
      await admin.query('ALTER TABLE invoice ENABLE TRIGGER invoice_guard');
    });
    expect((await world.rowOf(issued.id)).issuerSnapshot).toBeNull();

    // The migration disables the guard around the block, as the owner.
    await asRole(inject('ownerUrl'), async (owner) => {
      await owner.query('BEGIN');
      await owner.query('ALTER TABLE invoice DISABLE TRIGGER invoice_guard');
      await owner.query(backfill);
      await owner.query('ALTER TABLE invoice ENABLE TRIGGER invoice_guard');
      await owner.query('COMMIT');
    });

    const row = await world.rowOf(issued.id);
    expect(row.issuerSnapshot).toEqual({
      cuit: '20123456786',
      businessName: 'Consultorio Aillu',
      taxCondition: 'monotributo',
      address: 'Av. Siempre Viva 123, CABA',
      activityStartedOn: '2020-03-01',
    });
    // What an invoice already had is not touched.
    expect((await world.rowOf(kept.id)).issuerSnapshot).toMatchObject({ businessName: 'Otra' });
    const data = await world.inTenant((tx) => loadDocumentData(tx, row));
    expect(data.issuer.businessName).toBe('Consultorio Aillu');
  });
});
