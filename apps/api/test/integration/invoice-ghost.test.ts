import type { ChargeDto, InvoiceDto } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { invoice as invoiceTable, invoiceStrayVoucher } from '../../src/db/schema/index.js';
import { issuerKeyOf } from '../../src/modules/invoicing/application/issue-attempt.js';
import { createAfipIssueJob } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Judgment day, Stage 4, round 3, finding R3-3: the voucher of an invoice that was replaced without
 * knowing whether it had been issued, and the voucher that arrived for an invoice somebody had closed,
 * stay in the series. Nothing may adopt them as its own (an anonymous consumer with the same fee on
 * the same day looks exactly like them), and the next number expected is counted after them.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-ghost' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const after = (base: number, minutes: number) => () => new Date(base + minutes * 60_000);

const vouchersOf = (invoiceId: string) =>
  world.issuer
    .vouchers()
    .filter((voucher) => voucher.idempotencyKey === issuerKeyOf(world.tenant.id, invoiceId));

async function create() {
  const charge: ChargeDto = await world.charge();
  const response = await world.invoiceCharge(charge);
  expect(response.statusCode, response.body).toBe(202);
  return { charge, created: response.json<InvoiceDto>() };
}

async function runIssueWith(invoiceId: string, deps: Parameters<typeof createAfipIssueJob>[0]) {
  const queued = world.recorded.jobs.find(
    (job) => job.name === 'afip.issue' && job.payload['invoiceId'] === invoiceId && !job.done,
  );
  if (!queued) throw new Error('the invoice has no pending job');
  queued.done = true;
  return runJob(runtime.db, createAfipIssueJob(deps), {
    id: queued.id,
    name: queued.name,
    data: queued.payload,
    enqueuedAt: new Date(),
    retryCount: 0,
  });
}

async function drain() {
  world.issuer.setMode('ok');
  await world.runIssue();
  const base = Date.now();
  for (let round = 1; round <= 6; round += 1) {
    const results = await world.sweep(after(base, round * 600));
    if (results.length === 0) return;
  }
}

const strayRows = () => world.inTenant((tx) => tx.select().from(invoiceStrayVoucher));

/**
 * The first invoice is sent and its answer is lost (the authority holds its voucher, the ghost), and it
 * is replaced by a voucher made by hand at ANOTHER point of sale (the web tool of the authority has its
 * own), acknowledging the unknown outcome. The series of the first invoice does not record the ghost.
 */
async function replacedWithAGhost() {
  await drain();
  const ghostOwner = await create();
  const t0 = Date.now();
  world.issuer.setMode('timeout_after_authorize');
  await runIssueWith(
    ghostOwner.created.id,
    world.issueDeps(() => new Date(t0)),
  );
  const ghost = vouchersOf(ghostOwner.created.id)[0];
  expect(ghost).toBeDefined();
  const lines = (await world.linesOf(ghostOwner.charge.id)).filter(
    (line) => line.portion === 'patient',
  );
  const response = await world.api.post('/invoices/manual', world.admin, {
    idempotencyKey: submissionKey(),
    type: 'FC',
    pointOfSale: 2,
    number: 2000 + Math.floor(Math.random() * 1e5),
    cae: String(75_000_000_000_000 + Math.floor(Math.random() * 1e9)),
    issueDate: '2031-05-20',
    caeExpiresOn: '2031-05-30',
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    lines: lines.map((line) => ({ chargeLineId: line.id })),
    recipient: { kind: 'patient' },
    replacesInvoiceId: ghostOwner.created.id,
    acknowledgeUnknownOutcome: true,
  });
  expect(response.statusCode, response.body).toBe(201);
  return { ghostOwner, ghostNumber: ghost?.number ?? 0, t0 };
}

describe('the voucher of an invoice replaced without knowing (JD-S4 R3-3)', () => {
  it('remembers the number the replaced invoice expected', async () => {
    const { ghostOwner, ghostNumber } = await replacedWithAGhost();

    const rows = (await strayRows()).filter((row) => row.invoiceId === ghostOwner.created.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      number: ghostNumber,
      pointOfSale: 1,
      type: 'FC',
      reason: 'replaced_unresolved',
    });
  });

  it('does not let the next anonymous invoice with the same fee adopt it when its answer is lost', async () => {
    const { ghostNumber, t0 } = await replacedWithAGhost();
    const next = await create();
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      next.created.id,
      world.issueDeps(() => new Date(t0 + 1000)),
    );
    const own = vouchersOf(next.created.id)[0];
    expect(own?.number).toBeGreaterThan(ghostNumber);
    // The number it expects is after the ghost: the lookup asks about its own voucher.
    expect((await world.rowOf(next.created.id)).expectedNumber).toBe(ghostNumber + 1);
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      await world.sweep(after(t0, 10));

      expect(issue).not.toHaveBeenCalled();
    } finally {
      issue.mockRestore();
    }
    expect(await world.rowOf(next.created.id)).toMatchObject({
      status: 'issued',
      number: own?.number,
      cae: own?.cae,
    });
  });

  it('moves past a remembered number that a stale mark still expects, and never takes the voucher there', async () => {
    const { ghostNumber, t0 } = await replacedWithAGhost();
    const next = await create();
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      next.created.id,
      world.issueDeps(() => new Date(t0 + 1000)),
    );
    const own = vouchersOf(next.created.id)[0];
    // A mark written before the ghost was known would expect the ghost's number.
    await world.inTenant((tx) =>
      tx
        .update(invoiceTable)
        .set({ expectedNumber: ghostNumber })
        .where(eq(invoiceTable.id, next.created.id)),
    );
    const probed: number[] = [];
    const original = world.issuer.findIssued.bind(world.issuer);
    const probe = vi.spyOn(world.issuer, 'findIssued').mockImplementation((ref) => {
      probed.push(ref.number);
      return original(ref);
    });

    try {
      await world.sweep(after(t0, 10));
    } finally {
      probe.mockRestore();
    }

    expect(probed).toEqual([ghostNumber, ghostNumber + 1]);
    expect(await world.rowOf(next.created.id)).toMatchObject({
      status: 'issued',
      number: own?.number,
    });
  });
});

describe('the voucher that arrived for an invoice somebody had closed (JD-S4 R3-3)', () => {
  it('is remembered, and the next anonymous invoice does not adopt it', async () => {
    await drain();
    const orphaned = await create();
    const t0 = Date.now();
    const original = world.issuer.issue.bind(world.issuer);
    const issue = vi.spyOn(world.issuer, 'issue').mockImplementationOnce(async (request, key) => {
      // While the authority is being asked, the invoice is closed by someone else.
      await world.inTenant((tx) =>
        tx
          .update(invoiceTable)
          .set({
            status: 'rejected',
            deliveryState: null,
            rejectionMessage: 'Cerrada a mano',
            nextAttemptAt: null,
          })
          .where(eq(invoiceTable.id, orphaned.created.id)),
      );
      return original(request, key);
    });
    try {
      await runIssueWith(
        orphaned.created.id,
        world.issueDeps(() => new Date(t0)),
      );
    } finally {
      issue.mockRestore();
    }
    const orphan = vouchersOf(orphaned.created.id)[0];
    expect(orphan).toBeDefined();
    expect(
      (await strayRows()).filter((row) => row.invoiceId === orphaned.created.id),
    ).toMatchObject([{ number: orphan?.number, reason: 'orphaned' }]);

    const next = await create();
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      next.created.id,
      world.issueDeps(() => new Date(t0 + 1000)),
    );
    const own = vouchersOf(next.created.id)[0];
    await world.sweep(after(t0, 10));

    expect(own?.number).not.toBe(orphan?.number);
    expect(await world.rowOf(next.created.id)).toMatchObject({
      status: 'issued',
      number: own?.number,
      cae: own?.cae,
    });
  });
});
