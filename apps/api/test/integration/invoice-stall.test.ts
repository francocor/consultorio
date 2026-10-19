import type {
  ChargeDto,
  InvoiceDto,
  Problem,
  WorklistItemDto,
  WorklistResponse,
} from '@consultorio/contracts';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { chargeLine } from '../../src/db/schema/billing-charges.js';
import { invoice as invoiceTable } from '../../src/db/schema/index.js';
import { issuerKeyOf } from '../../src/modules/invoicing/application/issue-attempt.js';
import { createAfipIssueJob } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { gate } from '../support/lock-waits.js';

/**
 * Judgment day, Stage 4, round 3: findings R3-1 (a held series must not wait for the long backoff of
 * the invoice that holds it) and R3-2 (a stalled series is surfaced: a worklist item on the blocker,
 * and who holds whom on the invoices), and R3-6 (the older of two waiting invoices goes first).
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-stall' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const MINUTE = 60_000;
const after = (base: number, minutes: number) => () => new Date(base + minutes * MINUTE);

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

/** Settles what other tests left, so the series holds only what the test creates. */
async function drain() {
  world.issuer.setMode('ok');
  await world.runIssue();
  const base = Date.now();
  for (let round = 1; round <= 6; round += 1) {
    const results = await world.sweep(after(base, round * 600));
    if (results.length === 0) return;
  }
}

/** The first invoice's answer is lost: it holds the series. The second one is only requested. */
async function blockedSeries() {
  await drain();
  const blocker = await create();
  const held = await create();
  const t0 = Date.now();
  world.issuer.setMode('timeout_after_authorize');
  await runIssueWith(
    blocker.created.id,
    world.issueDeps(() => new Date(t0)),
  );
  expect(await world.rowOf(blocker.created.id)).toMatchObject({
    deliveryState: 'awaiting_reconciliation',
  });
  return { blocker, held, t0 };
}

const attentionItems = async (status: 'open' | 'resolved' = 'open') =>
  (
    await world.api.get(`/worklist?kind=invoice_attention&status=${status}`, world.admin)
  ).json<WorklistResponse>().items;

const itemOf = async (invoiceId: string, status: 'open' | 'resolved' = 'open') =>
  (await attentionItems(status)).filter((item) => item.subjectId === invoiceId);

describe('a held series does not wait for the long backoff of its blocker (JD-S4 R3-1)', () => {
  it('moves within minutes once an outage ends, even after hours of failed probes', async () => {
    const { blocker, held, t0 } = await blockedSeries();

    // A long outage: the probes of the blocker fail for five hours.
    world.issuer.setMode('down');
    for (const minute of [2, 10, 30, 70, 140, 220, 300]) {
      await world.sweep(after(t0, minute));
    }
    expect((await world.rowOf(blocker.created.id)).attempts).toBeGreaterThanOrEqual(6);
    expect((await world.rowOf(held.created.id)).status).toBe('pending');

    // The outage ends. The series moves within minutes, not when the 6 hour backoff runs out.
    world.issuer.setMode('ok');
    let issuedAt: number | undefined;
    for (let minute = 301; minute <= 315; minute += 1) {
      await world.sweep(after(t0, minute));
      const a = await world.rowOf(blocker.created.id);
      const b = await world.rowOf(held.created.id);
      if (a.status === 'issued' && b.status === 'issued') {
        issuedAt = minute;
        break;
      }
    }

    expect(issuedAt).toBeDefined();
    expect(vouchersOf(blocker.created.id)).toHaveLength(1);
    expect(vouchersOf(held.created.id)).toHaveLength(1);
  });

  it('keeps the backoff of an invoice that waits for reconciliation at a few minutes', async () => {
    const { blocker, t0 } = await blockedSeries();
    world.issuer.setMode('down');
    await world.inTenant((tx) =>
      tx.update(invoiceTable).set({ attempts: 12 }).where(eq(invoiceTable.id, blocker.created.id)),
    );

    await world.sweep(after(t0, 2));

    const row = await world.rowOf(blocker.created.id);
    expect(row.deliveryState).toBe('awaiting_reconciliation');
    expect(row.nextAttemptAt?.getTime()).toBeLessThanOrEqual(t0 + 2 * MINUTE + 5 * MINUTE);
    world.issuer.setMode('ok');
    await world.sweep(after(t0, 20));
  });

  it('brings the blocker forward when an invoice is held back, at most once per wait', async () => {
    const { blocker, held, t0 } = await blockedSeries();
    const far = new Date(t0 + 6 * 60 * MINUTE);
    const set = (patch: Partial<typeof invoiceTable.$inferInsert>) =>
      world.inTenant((tx) =>
        tx.update(invoiceTable).set(patch).where(eq(invoiceTable.id, blocker.created.id)),
      );

    // The blocker tried a few seconds ago: it is not pulled again so soon.
    await set({ nextAttemptAt: far, lastAttemptAt: new Date(t0 + 4 * MINUTE - 10_000) });
    const early = await runIssueWith(
      held.created.id,
      world.issueDeps(() => new Date(t0 + 4 * MINUTE)),
    );
    expect(early).toEqual({ status: 'completed' });
    expect((await world.rowOf(blocker.created.id)).nextAttemptAt).toEqual(far);

    // It tried long ago: the held invoice makes it due now.
    await set({ nextAttemptAt: far, lastAttemptAt: new Date(t0 + 1 * MINUTE) });
    await world.inTenant((tx) =>
      tx
        .update(invoiceTable)
        .set({ nextAttemptAt: new Date(t0) })
        .where(eq(invoiceTable.id, held.created.id)),
    );
    await world.sweep(after(t0, 6));

    const pulled = await world.rowOf(blocker.created.id);
    expect(pulled.nextAttemptAt?.getTime()).toBeLessThanOrEqual(t0 + 6 * MINUTE);
    // And the held invoice itself waits a minute, nothing more.
    const heldRow = await world.rowOf(held.created.id);
    expect(heldRow.status === 'issued' || heldRow.deliveryState === 'queued').toBe(true);
    world.issuer.setMode('ok');
    await world.sweep(after(t0, 30));
    await world.sweep(after(t0, 40));
  });

  it('writes only its own wait when it is held back: it does not lock its charge lines', async () => {
    const { held, t0 } = await blockedSeries();
    const lineIds = (await world.linesOf(held.charge.id)).map((line) => line.id);
    const locked = gate();
    const release = gate();
    const holding = world.inTenant(async (tx) => {
      await tx.select().from(chargeLine).where(inArray(chargeLine.id, lineIds)).for('update');
      locked.open();
      await release.opened;
    });
    await locked.opened;
    const timer = new Promise<'waited'>((resolve) => {
      setTimeout(() => {
        resolve('waited');
      }, 4000);
    });

    let outcome: unknown;
    try {
      const attempt = runIssueWith(
        held.created.id,
        world.issueDeps(() => new Date(t0 + MINUTE)),
      );
      outcome = await Promise.race([attempt, timer]);
      release.open();
      await attempt;
    } finally {
      release.open();
      await holding;
    }

    expect(outcome).toEqual({ status: 'completed' });
    world.issuer.setMode('ok');
    await world.sweep(after(t0, 30));
    await world.sweep(after(t0, 40));
  }, 30_000);
});

describe('the older of two invoices that wait goes first (JD-S4 R3-6)', () => {
  it('holds the younger one back while the older one may have been answered', async () => {
    await drain();
    const older = await create();
    const younger = await create();
    const t0 = Date.now();
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      older.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    const olderNumber = vouchersOf(older.created.id)[0]?.number ?? 0;
    // The younger one waits too (a lost answer of its own), and it is due first.
    await world.inTenant(async (tx) => {
      await tx
        .update(invoiceTable)
        .set({
          deliveryState: 'awaiting_reconciliation',
          expectedNumber: olderNumber + 1,
          nextAttemptAt: new Date(t0 - 2000),
        })
        .where(eq(invoiceTable.id, younger.created.id));
      await tx
        .update(invoiceTable)
        .set({ nextAttemptAt: new Date(t0 + MINUTE) })
        .where(eq(invoiceTable.id, older.created.id));
    });
    const probe = vi.spyOn(world.issuer, 'findIssued');
    try {
      const results = await world.sweep(after(t0, 0));

      expect(results.filter((result) => result.invoiceId === younger.created.id)).toEqual([
        { invoiceId: younger.created.id, outcome: 'skipped' },
      ]);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
    await world.sweep(after(t0, 10));
    await world.sweep(after(t0, 20));
    expect((await world.rowOf(older.created.id)).status).toBe('issued');
    expect((await world.rowOf(younger.created.id)).status).toBe('issued');
  });
});

describe('a stalled series is surfaced (JD-S4 R3-2)', () => {
  it('opens one worklist item on the blocker, with the number of invoices it holds, and shows who holds whom', async () => {
    const { blocker, held, t0 } = await blockedSeries();
    world.issuer.setMode('down');
    // Before the threshold nothing is opened.
    await world.sweep(after(t0, 2));
    expect(await itemOf(blocker.created.id)).toHaveLength(0);
    await world.inTenant((tx) =>
      tx.update(invoiceTable).set({ attempts: 6 }).where(eq(invoiceTable.id, blocker.created.id)),
    );

    await world.sweep(after(t0, 10));
    await world.sweep(after(t0, 20));

    const items: WorklistItemDto[] = await itemOf(blocker.created.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toMatchObject({ reason: 'outcome_unknown', held: 1 });
    expect(items[0]?.subjectType).toBe('invoice');
    // The invoices say it: the held one points at the blocker, the blocker counts what it holds.
    const heldDto = await world.getInvoice(held.created.id);
    const blockerDto = await world.getInvoice(blocker.created.id);
    expect(heldDto.heldBy).toMatchObject({ id: blocker.created.id });
    expect(heldDto.blocksSeries).toBe(0);
    expect(blockerDto.heldBy).toBeNull();
    expect(blockerDto.blocksSeries).toBe(1);

    // The authority answers again: the blocker is settled, the item closes, the series moves.
    world.issuer.setMode('ok');
    await world.sweep(after(t0, 30));
    await world.sweep(after(t0, 40));
    expect((await world.rowOf(blocker.created.id)).status).toBe('issued');
    expect((await world.rowOf(held.created.id)).status).toBe('issued');
    expect(await itemOf(blocker.created.id)).toHaveLength(0);
    expect(await itemOf(blocker.created.id, 'resolved')).toHaveLength(1);
    const settled = await world.getInvoice(held.created.id);
    expect(settled.heldBy).toBeNull();
  });

  it('is released by an acknowledged replacement of the blocker, and the held invoice then issues', async () => {
    const { blocker, held, t0 } = await blockedSeries();
    world.issuer.setMode('down');
    await world.inTenant((tx) =>
      tx.update(invoiceTable).set({ attempts: 6 }).where(eq(invoiceTable.id, blocker.created.id)),
    );
    await world.sweep(after(t0, 10));
    expect(await itemOf(blocker.created.id)).toHaveLength(1);

    const lines = (await world.linesOf(blocker.charge.id)).filter(
      (line) => line.portion === 'patient',
    );
    const response = await world.api.post('/invoices/manual', world.admin, {
      idempotencyKey: submissionKey(),
      type: 'FC',
      pointOfSale: 2,
      number: 1000 + Math.floor(Math.random() * 1e5),
      cae: String(74_000_000_000_000 + Math.floor(Math.random() * 1e9)),
      issueDate: '2031-05-20',
      caeExpiresOn: '2031-05-30',
      totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
      lines: lines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
      replacesInvoiceId: blocker.created.id,
      acknowledgeUnknownOutcome: true,
    });
    expect(response.statusCode, response.body).toBe(201);

    world.issuer.setMode('ok');
    await world.sweep(after(t0, 20));
    await world.sweep(after(t0, 30));

    expect((await world.rowOf(blocker.created.id)).status).toBe('rejected');
    expect((await world.rowOf(held.created.id)).status).toBe('issued');
    expect(vouchersOf(held.created.id)).toHaveLength(1);
    // The item that asked about the unknown outcome is closed; the replacement opened its own.
    const open = await itemOf(blocker.created.id);
    expect(open).toHaveLength(1);
    expect(open[0]?.detail).toMatchObject({ reason: 'replaced_unresolved' });
  });

  it('does not tell the replacement problem of a series that nobody holds', async () => {
    await drain();
    const lone = await create();
    const dto = await world.getInvoice(lone.created.id);
    expect(dto.heldBy).toBeNull();
    expect(dto.blocksSeries).toBe(0);
    const response = await world.api.post(
      `/invoices/${lone.created.id}/credit-notes`,
      world.owner,
      {
        idempotencyKey: submissionKey(),
        reason: 'Error en la carga del importe',
      },
    );
    expect(response.json<Problem>().code).toBeDefined();
  });
});
