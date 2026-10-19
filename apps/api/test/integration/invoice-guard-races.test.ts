import type { ChargeDto, InvoiceDto, Problem } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { backendPid, gate, waitForLockWaiters } from '../support/lock-waits.js';

/**
 * Judgment day, Stage 4, round 2: findings R2-4 (the environment of a point of sale against an
 * invoice in progress) and R2-5 (the order of the locks of the writers of invoices and the void of a
 * charge). Two real connections meet at the same point of sale, charge or charge line; each test fails
 * on the code before the fix.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-guard-races' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

let rawNumber = 0;

/** A pending invoice written straight into the table, as code that skipped the application would. */
async function rawInvoice(tx: Tx, input: { pointOfSale: number }): Promise<string> {
  rawNumber += 1;
  const patient = await world.freshPatient();
  const result = await tx.execute<{ id: string }>(
    sql`INSERT INTO invoice (tenant_id, type, point_of_sale, status, delivery_state, issue_date,
                             environment, idempotency_key, request_hash, recipient_kind, patient_id,
                             recipient_tax_condition, total_cents, net_cents, location_ids, created_by)
          VALUES (${world.tenant.id}, 'FC', ${input.pointOfSale}, 'pending', 'queued', '2031-05-20',
                  'homologation', ${submissionKey()}, ${'guard-' + String(rawNumber)}, 'patient',
                  ${patient}, 'consumidor_final', 100000, 100000, ARRAY[${world.centro}]::uuid[],
                  ${world.owner.user.id})
          RETURNING id`,
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no invoice');
  return id;
}

/** A point of sale of its own, inactive at once: the other tests invoice through the point of sale 1. */
async function extraPoint(number: number): Promise<string> {
  const created = await world.api.post('/invoicing/points-of-sale', world.owner, { number });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ id: string }>().id;
  const off = await world.api.patch(`/invoicing/points-of-sale/${id}`, world.owner, {
    active: false,
  });
  expect(off.statusCode, off.body).toBe(200);
  return id;
}

const environmentOf = (pointId: string) =>
  world.inTenant(async (tx) => {
    const result = await tx.execute<{ environment: string }>(
      sql`SELECT environment FROM point_of_sale WHERE id = ${pointId}`,
    );
    return result.rows[0]?.environment;
  });

describe('the environment of a point of sale and an invoice in progress (JD-S4 R2-4)', () => {
  it('refuses at the database the change that meets an invoice that was not committed when the application looked', async () => {
    const pointId = await extraPoint(8);
    const held = gate<number>();
    const release = gate();

    // An invoice of the point of sale is written and not committed yet: the application cannot see it.
    const writing = world.inTenant(async (tx) => {
      await rawInvoice(tx, { pointOfSale: 8 });
      held.open(await backendPid(tx));
      await release.opened;
    });
    const holder = await held.opened;
    const changing = world.api.patch(`/invoicing/points-of-sale/${pointId}`, world.owner, {
      environment: 'production',
    });
    try {
      await waitForLockWaiters(holder);
    } finally {
      release.open();
    }
    await writing;
    const response = await changing;

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<Problem>().code).toBe('point_of_sale_has_invoices');
    expect(await environmentOf(pointId)).toBe('homologation');
  });

  it('refuses at the database an update that skips the application, once an invoice went through the point of sale', async () => {
    const pointId = await extraPoint(9);
    await world.inTenant((tx) => rawInvoice(tx, { pointOfSale: 9 }));

    const attempt = world.inTenant((tx) =>
      tx.execute(sql`UPDATE point_of_sale SET environment = 'production' WHERE id = ${pointId}`),
    );

    await expect(attempt).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/environment of a point of sale/) as string },
    });
    expect(await environmentOf(pointId)).toBe('homologation');
  });

  it('changes the environment of a point of sale that no invoice went through', async () => {
    const pointId = await extraPoint(10);

    const response = await world.api.patch(`/invoicing/points-of-sale/${pointId}`, world.owner, {
      environment: 'production',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await environmentOf(pointId)).toBe('production');
  });
});

const lineLockedBy = (lineId: string) =>
  // From a connection of its own: is the charge line free right now?
  world
    .inTenant((tx) =>
      tx.execute(sql`SELECT id FROM charge_line WHERE id = ${lineId} FOR UPDATE NOWAIT`),
    )
    .then(
      () => 'free',
      (error: unknown) =>
        (error as { cause?: { code?: string } }).cause?.code === '55P03' ? 'locked' : 'failed',
    );

/** A void of the charge, as far as locks go: the charge is locked first and kept until `release`. */
async function holdCharge(chargeId: string, release: Promise<void>, held: (pid: number) => void) {
  await world.inTenant(async (tx) => {
    await tx.execute(sql`SELECT id FROM charge WHERE id = ${chargeId} FOR UPDATE`);
    held(await backendPid(tx));
    await release;
  });
}

describe('the order of the locks: charge, then lines (JD-S4 R2-5)', () => {
  it('makes the guard of an invoice line wait for the charge BEFORE it locks the line', async () => {
    const charge = await world.charge();
    const [line] = (await world.chargeOf(charge.id)).lines.filter(
      (candidate) => candidate.portion === 'patient',
    );
    const held = gate<number>();
    const release = gate();

    const voiding = holdCharge(charge.id, release.opened, held.open);
    const holder = await held.opened;
    const writing = world.inTenant(async (tx) => {
      const id = await rawInvoice(tx, { pointOfSale: 1 });
      await tx.execute(
        sql`INSERT INTO invoice_line (tenant_id, invoice_id, charge_line_id, charge_id, position,
                                      description, amount_cents)
              VALUES (${world.tenant.id}, ${id}, ${line?.id}, ${charge.id}, 1, 'Consulta', 100000)`,
      );
    });
    let lineState: string;
    try {
      await waitForLockWaiters(holder);
      // The guard waits for the charge. It must not be holding the line meanwhile: a void that locks
      // the charge and then the lines would wait for it and the two would deadlock.
      lineState = await lineLockedBy(line?.id ?? '');
    } finally {
      release.open();
    }
    await voiding;
    await writing;

    expect(lineState).toBe('free');
  });

  it('makes a credit note wait for the charge BEFORE it locks the lines, like an invoice does', async () => {
    const charge = await world.charge();
    const issued = await world.issueInvoiceOf(charge);
    const [line] = (await world.chargeOf(charge.id)).lines.filter(
      (candidate) => candidate.portion === 'patient',
    );
    const held = gate<number>();
    const release = gate();

    const voiding = holdCharge(charge.id, release.opened, held.open);
    const holder = await held.opened;
    const noting = world.creditNote(issued.id);
    let lineState: string;
    try {
      await waitForLockWaiters(holder);
      lineState = await lineLockedBy(line?.id ?? '');
    } finally {
      release.open();
    }
    await voiding;
    const response = await noting;

    expect(lineState).toBe('free');
    expect(response.statusCode, response.body).toBe(202);
  });

  it('answers a credit note and the void of the same charge one after the other, never with a deadlock (a regression guard of the order: it also passed before the fix)', async () => {
    const charge: ChargeDto = await world.charge();
    const issued: InvoiceDto = await world.issueInvoiceOf(charge);
    const held = gate<number>();
    const release = gate();

    // Somebody holds the invoice being cancelled: the credit note stops after it took its locks.
    const blocking = world.inTenant(async (tx) => {
      await tx.execute(sql`SELECT id FROM invoice WHERE id = ${issued.id} FOR UPDATE`);
      held.open(await backendPid(tx));
      await release.opened;
    });
    const blocker = await held.opened;
    const noting = world.creditNote(issued.id);
    const [notePid] = await waitForLockWaiters(blocker);
    const voiding = world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });
    // The void waits for the credit note, whichever lock the credit note holds.
    await waitForLockWaiters(notePid ?? 0);
    release.open();
    await blocking;
    const [noted, voided] = await Promise.all([noting, voiding]);

    expect(noted.statusCode, noted.body).toBe(202);
    expect(voided.statusCode, voided.body).toBe(409);
    expect(voided.json<Problem>().code).toBe('charge_has_invoice');
  });
});
