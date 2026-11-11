import type { ChargeDto, Problem } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { AdapterResolver } from '../../src/main/adapter-resolver.js';
import { voidCharge } from '../../src/modules/billing/application/void-charge.js';
import { createInvoice } from '../../src/modules/invoicing/application/create-invoice.js';
import { invoiceLookup } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { backendPid, gate, waitForLockWaiters } from '../support/lock-waits.js';

/**
 * Judgment day, Stage 4, round 1: findings C2, C6 and the idempotency half of C10 for invoices. Two
 * connections meet at the same charge, charge line or invoice; each test fails on the code before
 * the fix.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-races' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const owner = () => ({
  userId: world.owner.user.id,
  actingRole: 'owner' as const,
  ip: null,
  userAgent: null,
  requestId: null,
});
const viewer = () => ({ roles: ['owner' as const], membershipId: world.owner.membershipId });

/** Voids a charge in a transaction of its own and keeps it open until `release`. */
async function voidAndHold(chargeId: string, release: Promise<void>, held: (pid: number) => void) {
  await world.inTenant(async (tx) => {
    await voidCharge(tx, {
      chargeId,
      request: { reason: 'Cargado por error' },
      actor: owner(),
      viewer: { ...viewer(), professionalId: null },
      invoices: invoiceLookup,
    });
    held(await backendPid(tx));
    await release;
  });
}

/** Creates an invoice over the charge in a transaction of its own and keeps it open until `release`. */
async function createAndHold(
  charge: ChargeDto,
  release: Promise<void>,
  held: (pid: number) => void,
) {
  const lines = (await world.chargeOf(charge.id)).lines.filter(
    (line) => line.portion === 'patient',
  );
  const adapters: AdapterResolver = { forTenant: () => world.issuer as never };
  await world.inTenant(async (tx) => {
    await createInvoice(
      tx,
      { adapters, clock: () => new Date(), jobs: world.recorded },
      {
        request: {
          idempotencyKey: submissionKey(),
          lines: lines.map((line) => ({ chargeLineId: line.id })),
          recipient: { kind: 'patient' },
        },
        actor: owner(),
        viewer: viewer(),
        tenantId: world.tenant.id,
      },
    );
    held(await backendPid(tx));
    await release;
  });
}

const invoicesOf = (chargeId: string) =>
  world.inTenant((tx) =>
    tx.execute<{ status: string }>(
      sql`SELECT i.status FROM invoice i JOIN invoice_line il ON il.invoice_id = i.id
           WHERE il.charge_id = ${chargeId}`,
    ),
  );

describe('voiding a charge and invoicing it at the same time (JD-S4 R1-C2)', () => {
  it('refuses the invoice of a charge whose void is in progress, instead of invoicing a voided charge', async () => {
    const charge = await world.charge();
    const held = gate<number>();
    const release = gate();

    const voiding = voidAndHold(charge.id, release.opened, held.open);
    const holder = await held.opened;
    const invoicing = world.invoiceCharge(charge);
    await waitForLockWaiters(holder);
    release.open();
    await voiding;
    const response = await invoicing;

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<Problem>().code).toBe('invoice_charge_voided');
    expect((await invoicesOf(charge.id)).rows).toHaveLength(0);
  });

  it('refuses the void of a charge whose invoice is in progress, instead of voiding an invoiced charge', async () => {
    const charge = await world.charge();
    const held = gate<number>();
    const release = gate();

    const invoicing = createAndHold(charge, release.opened, held.open);
    const holder = await held.opened;
    const voiding = world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });
    await waitForLockWaiters(holder);
    release.open();
    await invoicing;
    const response = await voiding;

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<Problem>().code).toBe('charge_has_invoice');
    expect((await world.chargeOf(charge.id)).status).not.toBe('voided');
  });

  it('keeps a line of a voided charge out of any invoice at the database', async () => {
    const charge = await world.charge();
    const [line] = (await world.chargeOf(charge.id)).lines;
    const voided = await world.api.post(`/billing/charges/${charge.id}/void`, world.owner, {
      reason: 'Cargado por error',
    });
    expect(voided.statusCode, voided.body).toBe(200);

    const attempt = world.inTenant(async (tx) => {
      const id = await rawInvoice(tx, { status: 'pending', totalCents: 2_000_000 });
      await tx.execute(
        sql`INSERT INTO invoice_line (tenant_id, invoice_id, charge_line_id, charge_id, position,
                                      description, amount_cents)
              VALUES (${world.tenant.id}, ${id}, ${line?.id}, ${charge.id}, 1, 'Consulta', 2000000)`,
      );
    });

    await expect(attempt).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/voided charge/) as string },
    });
  });
});

let rawNumber = 0;

/** An invoice row written straight into the table, for the tests that meet the triggers directly. */
async function rawInvoice(
  tx: Tx,
  input: {
    status: 'pending' | 'issued';
    totalCents: number;
    creditNoteOf?: string;
    type?: string;
  },
): Promise<string> {
  rawNumber += 1;
  const issued = input.status === 'issued';
  const patient = await world.freshPatient();
  const result = await tx.execute<{ id: string }>(
    sql`INSERT INTO invoice (tenant_id, type, point_of_sale, status, delivery_state, number, cae,
                             cae_expires_on, issued_at, issue_date, environment, idempotency_key,
                             request_hash, recipient_kind, patient_id, recipient_tax_condition,
                             total_cents, net_cents, location_ids, credit_note_of_id, reason, created_by)
          VALUES (${world.tenant.id}, ${input.type ?? 'FC'}, 1, ${input.status},
                  ${issued ? null : 'queued'},
                  ${issued ? 9_000_000 + rawNumber : null},
                  ${issued ? String(70_000_000_000_000 + rawNumber) : null},
                  ${issued ? '2031-06-01' : null}, ${issued ? new Date() : null}, '2031-05-20',
                  'homologation', ${submissionKey()}, 'race', 'patient', ${patient},
                  'consumidor_final', ${input.totalCents}, ${input.totalCents},
                  ARRAY[${world.centro}]::uuid[], ${input.creditNoteOf ?? null},
                  ${input.creditNoteOf ? 'Error de carga' : null}, ${world.owner.user.id})
          RETURNING id`,
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no invoice');
  return id;
}

describe('two invoices that cover the same charge line (JD-S4 R1-C6)', () => {
  it('adds up what both cover, however their transactions interleave (no lost update)', async () => {
    const charge = await world.charge();
    const [line] = (await world.chargeOf(charge.id)).lines;
    const held = gate<number>();
    const release = gate();
    const cover = (tx: Tx, invoiceId: string, cents: number) =>
      tx.execute(
        sql`INSERT INTO invoice_line (tenant_id, invoice_id, charge_line_id, charge_id, position,
                                      description, amount_cents)
              VALUES (${world.tenant.id}, ${invoiceId}, ${line?.id}, ${charge.id}, 1, 'Consulta', ${cents})`,
      );

    const first = world.inTenant(async (tx) => {
      await cover(tx, await rawInvoice(tx, { status: 'pending', totalCents: 600_000 }), 600_000);
      held.open(await backendPid(tx));
      await release.opened;
    });
    const holder = await held.opened;
    const second = world.inTenant(async (tx) => {
      await cover(tx, await rawInvoice(tx, { status: 'pending', totalCents: 400_000 }), 400_000);
    });
    await waitForLockWaiters(holder);
    release.open();
    await Promise.all([first, second]);

    expect((await world.chargeOf(charge.id)).lines[0]?.invoicedCents).toBe(1_000_000);
  });
});

describe('two credit notes of the same invoice (JD-S4 R1-C6)', () => {
  it('make the second wait for the first, so together they never exceed the invoice', async () => {
    const issued = await world.issueInvoiceOf(await world.charge());
    const held = gate<number>();
    const release = gate();

    const first = world.inTenant(async (tx) => {
      await rawInvoice(tx, {
        status: 'pending',
        totalCents: 1_500_000,
        creditNoteOf: issued.id,
        type: 'NCC',
      });
      held.open(await backendPid(tx));
      await release.opened;
    });
    const holder = await held.opened;
    const second = world
      .inTenant((tx) =>
        rawInvoice(tx, {
          status: 'pending',
          totalCents: 1_500_000,
          creditNoteOf: issued.id,
          type: 'NCC',
        }),
      )
      .then(
        () => 'written',
        (error: unknown) => (error as { cause?: { message?: string } }).cause?.message ?? 'refused',
      );
    await waitForLockWaiters(holder);
    release.open();
    await first;

    expect(await second).toMatch(/cannot add up to more than the invoice/);
  });
});

describe('two submissions with the same idempotency key (JD-S4 R1-C10)', () => {
  it('answers a key used for another invoice with idempotency_key_reused when they meet at the index', async () => {
    const first = await world.charge();
    const second = await world.charge();
    const key = submissionKey();
    const held = gate<number>();
    const release = gate();

    const writing = world.inTenant(async (tx) => {
      await tx.execute(
        sql`INSERT INTO invoice (tenant_id, type, point_of_sale, status, delivery_state,
                                 issue_date, environment, idempotency_key, request_hash,
                                 recipient_kind, patient_id, recipient_tax_condition, total_cents,
                                 net_cents, location_ids, created_by)
              VALUES (${world.tenant.id}, 'FC', 1, 'pending', 'queued', '2031-05-20',
                      'homologation', ${key}, 'other', 'patient', ${first.patientId},
                      'consumidor_final', 100000, 100000, ARRAY[${world.centro}]::uuid[],
                      ${world.owner.user.id})`,
      );
      held.open(await backendPid(tx));
      await release.opened;
    });
    const holder = await held.opened;
    const asking = world.invoiceCharge(second, { idempotencyKey: key });
    await waitForLockWaiters(holder);
    release.open();
    await writing;
    const response = await asking;

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<Problem>().code).toBe('idempotency_key_reused');
  });
});
