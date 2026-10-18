import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  ChargeLineAdjustmentError,
  adjustInvoicedCents,
  readChargeLines,
  readChargeLinesOfCharges,
  readChargesForInvoicing,
} from '../../src/modules/billing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * What the invoicing module (track C) reads and writes of the charge lines, only through the index
 * of billing: the lines with their charge, locked while an invoice is built, and the amount already
 * invoiced, which can never go above the line or below zero.
 */

let runtime: DbHandle;
let world: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'charge-lines-api' });
  await world.setPrice(1_000_000);
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

const attempt = (work: () => Promise<unknown>) =>
  work().then(
    () => undefined,
    (error: unknown) => error,
  );

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
      tenantPayerId: null,
      position: 1,
      kind: 'service',
      portion: 'patient',
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

  it('flags the lines of a voided charge, which no invoice may cover', async () => {
    const { charge } = await chargeWithLines();
    await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });

    const lines = await inTenant((tx) => readChargeLinesOfCharges(tx, [charge.id]));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.chargeStatus === 'voided')).toBe(true);
  });

  it('summarizes charges for invoicing: who, what for, and the amounts', async () => {
    const { charge } = await chargeWithLines();

    const [summary] = await inTenant((tx) => readChargesForInvoicing(tx, [charge.id]));

    expect(summary).toMatchObject({
      id: charge.id,
      status: 'pending',
      patientId: charge.patientId,
      appointmentTypeName: 'Consulta',
      totalCents: 1_200_000,
      patientCents: 1_200_000,
      payerCents: 0,
      invoicedCents: 0,
    });
    expect(summary?.serviceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

describe('the amount invoiced of a line', () => {
  it('goes up and down in cents, within the line', async () => {
    const { lines } = await chargeWithLines();
    const line = lines[0];
    if (!line) throw new Error('a line is expected');

    const up = await inTenant((tx) => adjustInvoicedCents(tx, line.id, 400_000));
    const more = await inTenant((tx) => adjustInvoicedCents(tx, line.id, 600_000));
    const down = await inTenant((tx) => adjustInvoicedCents(tx, line.id, -1_000_000));

    expect(up).toMatchObject({ invoicedCents: 400_000, uninvoicedCents: 600_000 });
    expect(more).toMatchObject({ invoicedCents: 1_000_000, uninvoicedCents: 0 });
    expect(down).toMatchObject({ invoicedCents: 0, uninvoicedCents: 1_000_000 });
  });

  it('refuses to go above the amount of the line or below zero, and a fraction', async () => {
    const { lines } = await chargeWithLines();
    const line = lines[1];
    if (!line) throw new Error('a line is expected');

    const above = await inTenant((tx) => attempt(() => adjustInvoicedCents(tx, line.id, 200_001)));
    const below = await inTenant((tx) => attempt(() => adjustInvoicedCents(tx, line.id, -1)));
    const fraction = await inTenant((tx) => attempt(() => adjustInvoicedCents(tx, line.id, 10.5)));

    expect(above).toBeInstanceOf(ChargeLineAdjustmentError);
    expect(above).toMatchObject({ reason: 'exceeds_amount' });
    expect(below).toMatchObject({ reason: 'below_zero' });
    expect(fraction).toBeInstanceOf(RangeError);
    const [after] = await inTenant((tx) => readChargeLines(tx, [line.id]));
    expect(after?.invoicedCents).toBe(0);
  });

  it('never lets two invoices over the same line add up to more than the line', async () => {
    const { lines } = await chargeWithLines();
    const line = lines[0];
    if (!line) throw new Error('a line is expected');

    const [one, two] = await Promise.all([
      attempt(() => inTenant((tx) => adjustInvoicedCents(tx, line.id, 600_000))),
      attempt(() => inTenant((tx) => adjustInvoicedCents(tx, line.id, 600_000))),
    ]);

    const failures = [one, two].filter((outcome) => outcome instanceof ChargeLineAdjustmentError);
    expect(failures).toHaveLength(1);
    const [after] = await inTenant((tx) => readChargeLines(tx, [line.id]));
    expect(after?.invoicedCents).toBe(600_000);
  });

  it('refuses to invoice more of a voided charge, and answers not found for a line that is not there', async () => {
    const { charge, lines } = await chargeWithLines();
    await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });
    const line = lines[0];
    if (!line) throw new Error('a line is expected');

    const voided = await inTenant((tx) => attempt(() => adjustInvoicedCents(tx, line.id, 1)));
    const missing = await inTenant((tx) =>
      attempt(() => adjustInvoicedCents(tx, '0190a000-0000-7000-8000-0000000000aa', 1)),
    );

    expect(voided).toMatchObject({ reason: 'charge_voided' });
    expect(missing).toMatchObject({ reason: 'not_found' });
  });

  it('moves the invoiced position of the charge that the API shows', async () => {
    const { charge, lines } = await chargeWithLines();
    const [first, second] = lines;
    if (!first || !second) throw new Error('two lines expected');

    await inTenant((tx) => adjustInvoicedCents(tx, first.id, 1_000_000));
    const partly = (await world.api.get(`/billing/charges/${charge.id}`, world.owner)).json<{
      invoicing: string;
      invoicedCents: number;
    }>();
    await inTenant((tx) => adjustInvoicedCents(tx, second.id, 200_000));
    const fully = (await world.api.get(`/billing/charges/${charge.id}`, world.owner)).json<{
      invoicing: string;
      invoicedCents: number;
    }>();

    expect(partly).toMatchObject({ invoicing: 'partly_invoiced', invoicedCents: 1_000_000 });
    expect(fully).toMatchObject({ invoicing: 'invoiced', invoicedCents: 1_200_000 });
    // The row the guard protects: the amount of the line itself did not move.
    const [row] = await inTenant(
      async (tx) =>
        (
          await tx.execute<{ amount_cents: string }>(
            sql`SELECT amount_cents FROM charge_line WHERE id = ${first.id}`,
          )
        ).rows,
    );
    expect(row?.amount_cents).toBe('1000000');
  });
});
