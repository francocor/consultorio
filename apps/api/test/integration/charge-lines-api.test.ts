import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ChargeDto, TenantPayerDto } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  readChargeLines,
  readChargeLinesOfCharges,
  readChargesForInvoicing,
} from '../../src/modules/billing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * What the invoicing module (track C) reads of the charge lines, only through the index of billing:
 * the lines with their charge and their payer, locked while an invoice is built. Billing never
 * writes the amount invoiced: the trigger of the invoices does, and the database keeps it between
 * zero and the amount of the line.
 */

let runtime: DbHandle;
let world: BillingWorld;
let osde: TenantPayerDto;
let osdeCatalogId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'charge-lines-api' });
  await world.setPrice(1_000_000);
  osdeCatalogId = await world.catalogPayer('charge-lines-osde', 'OSDE Facturable');
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

const inTenant = <T>(work: Parameters<typeof asTenant<T>>[2]) =>
  asTenant(runtime, world.tenant.id, work);

async function chargeWithLines() {
  const charge = await world.charge();
  await world.api.post(`/billing/charges/${charge.id}/lines`, world.reception, {
    description: 'Material',
    amountCents: 200_000,
  });
  const lines = await inTenant((tx) => readChargeLinesOfCharges(tx, [charge.id]));
  return { charge, lines };
}

describe('reading the lines', () => {
  it('gives each line with its charge, what is invoiced and what is not', async () => {
    const { charge, lines } = await chargeWithLines();

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      chargeId: charge.id,
      chargeStatus: 'pending',
      patientId: charge.patientId,
      appointmentId: charge.appointmentId,
      locationId: charge.locationId,
      professionalId: charge.professionalId,
      payer: null,
      position: 1,
      kind: 'service',
      portion: 'patient',
      description: 'Consulta',
      amountCents: 1_000_000,
      invoicedCents: 0,
      uninvoicedCents: 1_000_000,
    });
    expect(lines[1]).toMatchObject({
      position: 2,
      kind: 'manual',
      description: 'Material',
      uninvoicedCents: 200_000,
    });
  });

  it('names the payer of the charge with its name and CUIT on every line, payer lines included', async () => {
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId });
    const charge = await world.charge({ patientId });

    const lines = await inTenant((tx) => readChargeLinesOfCharges(tx, [charge.id]));

    expect(lines.map((line) => [line.kind, line.portion])).toEqual([
      ['payer_coverage', 'payer'],
      ['copago', 'patient'],
    ]);
    for (const line of lines) {
      expect(line.payer).toEqual({ id: osde.id, name: 'OSDE Facturable', cuit: '30708578335' });
    }
  });

  it('reads some lines by id, in one order whatever the order asked, locking them when told to', async () => {
    const { lines } = await chargeWithLines();
    const [first, second] = lines;
    if (!first || !second) throw new Error('two lines expected');

    const asked = await inTenant((tx) =>
      readChargeLines(tx, [second.id, first.id], { lock: true }),
    );
    const plain = await inTenant((tx) => readChargeLines(tx, [first.id, second.id]));

    expect(asked.map((line) => line.id)).toEqual(plain.map((line) => line.id));
    expect(asked.map((line) => line.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('locks the lines for the transaction of the caller: another invoice waits for them', async () => {
    const { lines } = await chargeWithLines();
    const ids = lines.map((line) => line.id);
    let second: unknown;

    await inTenant(async (holder) => {
      await readChargeLines(holder, ids, { lock: true });
      // Another transaction asks for the same lines and gives up quickly: they are held.
      second = await inTenant(async (waiter) => {
        await waiter.execute(sql`SET LOCAL lock_timeout = '300ms'`);
        return readChargeLines(waiter, ids, { lock: true });
      }).then(
        () => 'got them',
        (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
      );
    });

    // 55P03: lock_not_available.
    expect(second).toBe('55P03');
    const free = await inTenant((tx) => readChargeLines(tx, ids, { lock: true }));
    expect(free).toHaveLength(ids.length);
  });

  it('flags the lines of a voided charge, which no invoice may cover', async () => {
    const { charge } = await chargeWithLines();
    await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });

    const lines = await inTenant((tx) => readChargeLinesOfCharges(tx, [charge.id]));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.chargeStatus === 'voided')).toBe(true);
  });

  it('summarizes charges for invoicing: who, what for, the payer and the amounts', async () => {
    const { charge } = await chargeWithLines();
    const patientId = await world.freshPatient();
    await world.cover(patientId, { payerId: osdeCatalogId });
    const covered = await world.charge({ patientId });

    const summaries = await inTenant((tx) => readChargesForInvoicing(tx, [charge.id, covered.id]));

    const own = summaries.find((entry) => entry.id === charge.id);
    const insured = summaries.find((entry) => entry.id === covered.id);
    expect(own).toMatchObject({
      status: 'pending',
      patientId: charge.patientId,
      appointmentTypeName: 'Consulta',
      payer: null,
      totalCents: 1_200_000,
      patientCents: 1_200_000,
      payerCents: 0,
      invoicedCents: 0,
    });
    expect(own?.serviceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(insured).toMatchObject({
      payer: { id: osde.id, name: 'OSDE Facturable', cuit: '30708578335' },
      payerCents: 1_500_000,
      patientCents: 300_000,
    });
  });

  it('does not see the lines of another organization', async () => {
    const { lines } = await chargeWithLines();
    const other = await createTestTenant(runtime, { slug: 'charge-lines-api-b' });

    const seen = await asTenant(runtime, other.id, (tx) =>
      readChargeLines(
        tx,
        lines.map((line) => line.id),
      ),
    );

    expect(seen).toEqual([]);
  });
});

describe('the amount invoiced of a line belongs to the invoices', () => {
  it('starts at zero, can be moved by the trigger of the invoices as the application role, and shows in the charge', async () => {
    const { charge, lines } = await chargeWithLines();
    const [first, second] = lines;
    if (!first || !second) throw new Error('two lines expected');

    // What the trigger of migration 0444 does: it updates only `invoiced_cents`.
    const move = (lineId: string, cents: number) =>
      inTenant((tx) =>
        tx.execute(sql`UPDATE charge_line SET invoiced_cents = ${cents} WHERE id = ${lineId}`),
      );
    await move(first.id, 1_000_000);
    const partly = (
      await world.api.get(`/billing/charges/${charge.id}`, world.owner)
    ).json<ChargeDto>();
    await move(second.id, 200_000);
    const fully = (
      await world.api.get(`/billing/charges/${charge.id}`, world.owner)
    ).json<ChargeDto>();
    const read = await inTenant((tx) => readChargeLines(tx, [first.id]));

    expect(lines.every((line) => line.invoicedCents === 0)).toBe(true);
    expect(partly).toMatchObject({ invoicing: 'partly_invoiced', invoicedCents: 1_000_000 });
    expect(fully).toMatchObject({ invoicing: 'invoiced', invoicedCents: 1_200_000 });
    expect(read[0]).toMatchObject({ invoicedCents: 1_000_000, uninvoicedCents: 0 });
  });

  it('is refused above the amount of the line or below zero by the database, and nothing else of the line may move', async () => {
    const { lines } = await chargeWithLines();
    const line = lines[1];
    if (!line) throw new Error('a line is expected');
    const code = (work: (tx: Parameters<Parameters<typeof inTenant>[0]>[0]) => Promise<unknown>) =>
      inTenant((tx) => tx.transaction(work)).then(
        () => undefined,
        (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
      );

    const above = await code((tx) =>
      tx.execute(sql`UPDATE charge_line SET invoiced_cents = 200001 WHERE id = ${line.id}`),
    );
    const below = await code((tx) =>
      tx.execute(sql`UPDATE charge_line SET invoiced_cents = -1 WHERE id = ${line.id}`),
    );
    const amount = await code((tx) =>
      tx.execute(sql`UPDATE charge_line SET amount_cents = 1 WHERE id = ${line.id}`),
    );

    expect([above, below, amount]).toEqual(['23514', '23514', '42501']);
  });

  it('is never written by the code of billing', () => {
    const root = fileURLToPath(new URL('../../src/modules/billing/', import.meta.url));
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) sources.push(path);
      }
    };
    walk(root);

    expect(sources.length).toBeGreaterThan(10);
    for (const path of sources) {
      const text = readFileSync(path, 'utf8');
      // No update of a charge line, and no write that names the invoiced column.
      expect(text, path).not.toMatch(/\.update\(\s*chargeLine\s*\)/);
      expect(text, path).not.toMatch(/invoiced_cents\s*=/);
      expect(text, path).not.toMatch(/\.set\(\s*\{[^}]*invoicedCents/);
    }
  });
});
