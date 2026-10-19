import type { ChargeDto, InvoiceDto, WorklistResponse } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, inject, vi, type MockInstance } from 'vitest';

import type { FakeInvoiceIssuer } from '../../src/adapters/afip-fake/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { invoice as invoiceTable, invoiceStrayVoucher } from '../../src/db/schema/index.js';
import { issuerKeyOf } from '../../src/modules/invoicing/application/issue-attempt.js';
import { createAfipIssueJob } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';

import { submissionKey } from './billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from './invoicing-world.js';

/**
 * The scenarios of the numbering of a series (judgment day, Stage 4, rounds 4 and 5): an invoice that
 * waits for reconciliation, the vouchers the authority holds around it, the manual vouchers staff
 * register by hand. The issuer of these tests is NOT idempotent by key, like the real authority: a
 * request sent twice shows as two vouchers.
 */

export const MINUTE = 60_000;
export const after = (base: number, minutes: number) => () => new Date(base + minutes * MINUTE);
export const DNI = { type: 'dni', number: '30111222' } as const;

/** One organization per group of scenarios, so what one leaves in the series never reaches another. */
export function useWorld(slug: string): {
  readonly world: InvoicingWorld;
  /** Runs the pending `afip.issue` job of an invoice by hand, with the deps the test chooses. */
  runIssueWith(invoiceId: string, deps: Parameters<typeof createAfipIssueJob>[0]): Promise<unknown>;
} {
  const state: { world?: InvoicingWorld; runtime?: DbHandle } = {};
  beforeAll(async () => {
    state.runtime = createRuntimeDb(inject('runtimeUrl'));
    state.world = await createInvoicingWorld(state.runtime, { slug });
  });
  afterEach(() => {
    state.world?.issuer.setIdempotent(true);
    state.world?.issuer.setMode('ok');
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await state.world?.close();
    await state.runtime?.close();
  });
  return {
    get world() {
      if (!state.world) throw new Error('the world is not ready');
      return state.world;
    },
    runIssueWith: (invoiceId, deps) => {
      if (!state.world || !state.runtime) throw new Error('the world is not ready');
      return runIssueWith(state.runtime, state.world, invoiceId, deps);
    },
  };
}

export const vouchersOf = (world: InvoicingWorld, invoiceId: string) =>
  world.issuer
    .vouchers()
    .filter((voucher) => voucher.idempotencyKey === issuerKeyOf(world.tenant.id, invoiceId));

/** An invoice of a new charge. Anonymous, or addressed to a DNI (then its facts differ from the other). */
export async function create(world: InvoicingWorld, document?: typeof DNI) {
  const charge: ChargeDto = await world.charge();
  const response = await world.invoiceCharge(
    charge,
    document ? { recipient: { kind: 'patient', document } } : {},
  );
  expect(response.statusCode, response.body).toBe(202);
  return { charge, created: response.json<InvoiceDto>() };
}

async function runIssueWith(
  runtime: DbHandle,
  world: InvoicingWorld,
  invoiceId: string,
  deps: Parameters<typeof createAfipIssueJob>[0],
) {
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
export async function drain(world: InvoicingWorld) {
  world.issuer.setMode('ok');
  await world.runIssue();
  const base = Date.now();
  for (let round = 1; round <= 6; round += 1) {
    const results = await world.sweep(after(base, round * 600));
    if (results.length === 0) return;
  }
}

/** The issuer CUIT of the invoices of this world, as the vouchers carry it. */
export async function cuitOf(world: InvoicingWorld, invoiceId: string): Promise<string> {
  return (await world.rowOf(invoiceId)).issuerSnapshot?.cuit ?? '';
}

/** What the authority says is the last number of the series (point of sale 1, type FC). */
export async function authorityLast(world: InvoicingWorld, invoiceId: string): Promise<number> {
  const answer = await world.issuer.lastAuthorized({
    issuerCuit: await cuitOf(world, invoiceId),
    tenantRef: world.tenant.id,
    pointOfSale: 1,
    type: 'FC',
  });
  if (answer.status !== 'ok') throw new Error('the authority does not answer');
  return answer.number;
}

/**
 * The invoice waits for reconciliation as if its request had been sent when the authority's last
 * number was `authorityLast` (a mark written, an answer lost).
 */
export const markAwaiting = (
  world: InvoicingWorld,
  invoiceId: string,
  authorityLastNumber: number,
  t0: number,
) =>
  world.inTenant((tx) =>
    tx
      .update(invoiceTable)
      .set({
        deliveryState: 'awaiting_reconciliation',
        expectedNumber: authorityLastNumber + 1,
        authorityLastAtMark: authorityLastNumber,
        awaitingSince: new Date(t0),
        nextAttemptAt: new Date(t0),
      })
      .where(eq(invoiceTable.id, invoiceId)),
  );

/**
 * The authority as it really is: it ignores the hint of the highest number we hold, and numbers after
 * what it holds itself. Returns the spy on `issue`, to count what was sent.
 */
export function realAuthority(world: InvoicingWorld): MockInstance<FakeInvoiceIssuer['issue']> {
  const original = world.issuer.issue.bind(world.issuer);
  return vi.spyOn(world.issuer, 'issue').mockImplementation((request, key) => {
    const asked = { ...request };
    delete asked.lastKnownNumber;
    return original(asked, key);
  });
}

/** Issues a voucher at the authority outside the system, with the facts of an invoice (or others). */
export async function issueOutOfBand(
  world: InvoicingWorld,
  like: { invoiceId: string; document?: typeof DNI; totalCents?: number },
  keyName: string,
) {
  const row = await world.rowOf(like.invoiceId);
  const result = await world.issuer.issue(
    {
      issuerCuit: row.issuerSnapshot?.cuit ?? '',
      tenantRef: world.tenant.id,
      pointOfSale: 1,
      type: 'FC',
      issueDate: row.issueDate,
      currency: 'ARS',
      totalCents: like.totalCents ?? row.totalCents,
      ...(like.document ? { buyerDocument: like.document } : {}),
    },
    keyName,
  );
  if (result.status !== 'issued') throw new Error('the out of band voucher was not issued');
  return result;
}

/** Replaces a pending invoice with a voucher made by hand at another point of sale, acknowledging the doubt. */
export async function replaceWithManual(
  world: InvoicingWorld,
  owner: { charge: ChargeDto; created: InvoiceDto },
) {
  const lines = (await world.linesOf(owner.charge.id)).filter((line) => line.portion === 'patient');
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
    replacesInvoiceId: owner.created.id,
    acknowledgeUnknownOutcome: true,
  });
  expect(response.statusCode, response.body).toBe(201);
}

/** Registers a voucher made outside the system in point of sale 1, type FC, over a charge of its own. */
export async function registerManualVoucher(
  world: InvoicingWorld,
  voucher: { number: number; cae?: string },
) {
  const charge = await world.charge();
  const lines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'patient');
  const response = await world.api.post('/invoices/manual', world.admin, {
    idempotencyKey: submissionKey(),
    type: 'FC',
    pointOfSale: 1,
    number: voucher.number,
    cae: voucher.cae ?? String(76_000_000_000_000 + Math.floor(Math.random() * 1e9)),
    issueDate: '2031-05-20',
    caeExpiresOn: '2031-05-30',
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    lines: lines.map((line) => ({ chargeLineId: line.id })),
    recipient: { kind: 'patient' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<InvoiceDto>();
}

export const strayRows = (world: InvoicingWorld) =>
  world.inTenant((tx) => tx.select().from(invoiceStrayVoucher));

export const auditRows = (world: InvoicingWorld, invoiceId: string, action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.resourceId, invoiceId), eq(auditEvent.action, action as never))),
  );

export const openItems = async (world: InvoicingWorld, invoiceId: string) =>
  (await world.api.get('/worklist?kind=invoice_attention&status=open', world.admin))
    .json<WorklistResponse>()
    .items.filter((item) => item.subjectId === invoiceId);
