import type { InvoiceDto, TenantPayerDto } from '@consultorio/contracts';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { readInvoicedLines, summarizeInvoiced } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * What the reports read of the invoices (S4.14 reads these functions of the index of invoicing):
 * the lines of the issued and registered vouchers of a period, with the location, the professional
 * and the payer of the charge they cover, credit notes as reductions. Pending invoices and rejected
 * attempts never appear.
 */

let runtime: DbHandle;
let world: InvoicingWorld;
let osdeCatalogId: string;
let osde: TenantPayerDto;

// The date printed on a voucher is the one of Buenos Aires, not the UTC one (they differ from 21:00 on).
const TODAY = DateTime.now().setZone('America/Argentina/Buenos_Aires').toISODate() ?? '';
const PERIOD = { from: '2000-01-01', to: '2100-01-01' };

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-reads' });
  osdeCatalogId = await world.catalogPayer('invoice-reads-osde', 'OSDE Reportes');
  osde = (
    await world.api.post('/billing/payers', world.owner, {
      payerId: osdeCatalogId,
      cuit: '30-70857833-5',
    })
  ).json<TenantPayerDto>();
  await world.api.post('/billing/payer-prices', world.owner, {
    tenantPayerId: osde.id,
    appointmentTypeId: world.consulta,
    payerAmountCents: 1_500_000,
    copagoCents: 300_000,
    plusCents: 0,
    effectiveFrom: '2031-01-01',
  });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const read = (filter = PERIOD) => world.inTenant((tx) => readInvoicedLines(tx, filter));

/** What was added to the vouchers since `before` was read. */
async function since(before: readonly { invoiceId: string }[]) {
  const known = new Set(before.map((row) => row.invoiceId));
  return (await read()).filter((row) => !known.has(row.invoiceId));
}

describe('the invoiced lines of a period', () => {
  it('give invoices of 100000 with a credit note of 20000 a net of 80000, by location, professional and type', async () => {
    await world.runIssue();
    const before = await read();
    const charge = await world.charge();
    // The consultation of 20000 and a line of 80000: the charge is 100000.
    await world.api.post(`/billing/charges/${charge.id}/lines`, world.reception, {
      description: 'Material',
      amountCents: 8_000_000,
    });
    const issued = await world.issueInvoiceOf(charge);
    expect(issued.totalCents).toBe(10_000_000);
    const note = (await world.creditNote(issued.id, { amountCents: 2_000_000 })).json<InvoiceDto>();
    await world.runIssue();

    const rows = await since(before);

    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.invoiceId === issued.id).map((row) => row.netCents)).toEqual([
      2_000_000, 8_000_000,
    ]);
    expect(rows.filter((row) => row.invoiceId === note.id).map((row) => row.netCents)).toEqual([
      -400_000, -1_600_000,
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'invoice',
      type: 'FC',
      status: 'issued',
      locationId: world.centro,
      professionalId: world.doctor.professionalId,
      patientId: charge.patientId,
      payerId: null,
      payerName: null,
      issueDate: TODAY,
    });
    expect(summarizeInvoiced(rows, 'total')[0]).toMatchObject({
      invoicedCents: 10_000_000,
      creditedCents: 2_000_000,
      netCents: 8_000_000,
      documents: 2,
    });
    expect(summarizeInvoiced(rows, 'location')).toEqual([
      expect.objectContaining({ key: world.centro, netCents: 8_000_000 }),
    ]);
    expect(summarizeInvoiced(rows, 'professional')).toEqual([
      expect.objectContaining({ key: world.doctor.professionalId, netCents: 8_000_000 }),
    ]);
    expect(summarizeInvoiced(rows, 'type').map((entry) => [entry.key, entry.netCents])).toEqual([
      ['FC', 10_000_000],
      ['NCC', -2_000_000],
    ]);
    expect(summarizeInvoiced(rows, 'payer')).toEqual([
      expect.objectContaining({ key: 'private', netCents: 8_000_000 }),
    ]);
  });

  it('attributes a payer invoice to the payer, and every grouping adds up to the same total', async () => {
    await world.runIssue();
    const before = await read();
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId });
    const charge = await world.charge({ patientId });
    const lines = await world.linesOf(charge.id);
    const toPayer = await world.invoice({
      lines: lines
        .filter((line) => line.portion === 'payer')
        .map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'payer' },
    });
    const toPatient = await world.invoice({
      lines: lines
        .filter((line) => line.portion === 'patient')
        .map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
    });
    expect(toPayer.statusCode, toPayer.body).toBe(202);
    expect(toPatient.statusCode, toPatient.body).toBe(202);
    await world.runIssue();

    const rows = await since(before);

    // The payer portion and the copago both belong to the charge made for the payer.
    expect(summarizeInvoiced(rows, 'payer')).toEqual([
      expect.objectContaining({ key: osde.id, label: 'OSDE Reportes', netCents: 1_800_000 }),
    ]);
    const total = summarizeInvoiced(rows, 'total')[0]?.netCents;
    expect(total).toBe(1_800_000);
    for (const dimension of ['location', 'professional', 'type', 'day', 'month'] as const) {
      expect(
        summarizeInvoiced(rows, dimension).reduce((sum, entry) => sum + entry.netCents, 0),
        dimension,
      ).toBe(total);
    }
  });

  it('leaves out a pending invoice and a rejected attempt', async () => {
    await world.runIssue();
    const before = await read();
    const waiting = await world.charge();
    await world.invoiceCharge(waiting);
    const rejected = await world.charge();
    await world.invoiceCharge(rejected);
    world.issuer.setMode('down');
    await world.runIssue();

    expect(await since(before)).toEqual([]);

    world.issuer.setMode('reject_next');
    await world.sweep(() => new Date(Date.now() + 3_600_000));
    // One of them was rejected by the authority, the other is issued now: only the issued one counts.
    const rows = await since(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('issued');
  });

  it('keeps to the period asked for, by the date the voucher prints', async () => {
    const charge = await world.charge();
    const lines = await world.linesOf(charge.id);
    const manual = await world.api.post('/invoices/manual', world.admin, {
      idempotencyKey: '0190a000-0000-7000-8000-00000000e001',
      type: 'FC',
      pointOfSale: 9,
      number: 4321,
      cae: '70123456789012',
      issueDate: '2031-04-15',
      totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
      lines: lines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
    });
    expect(manual.statusCode, manual.body).toBe(201);

    const april = await read({ from: '2031-04-01', to: '2031-04-30' });
    const may = await read({ from: '2031-05-01', to: '2031-05-31' });
    const onTheDay = await read({ from: '2031-04-15', to: '2031-04-15' });

    expect(april.map((row) => row.status)).toEqual(['manual']);
    expect(april[0]).toMatchObject({ issueDate: '2031-04-15', netCents: 2_000_000 });
    expect(may).toEqual([]);
    expect(onTheDay).toHaveLength(1);
  });

  it('shows an organization only its own vouchers', async () => {
    const other = await createTestTenant(runtime, { slug: 'invoice-reads-other' });

    const seen = await asTenant(runtime, other.id, (tx) => readInvoicedLines(tx, PERIOD));

    expect((await read()).length).toBeGreaterThan(0);
    expect(seen).toEqual([]);
  });
});
