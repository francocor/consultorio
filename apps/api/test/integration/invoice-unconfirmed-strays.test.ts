import type { ChargeDto, InvoiceDto, WorklistResponse } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { invoice as invoiceTable, invoiceStrayVoucher } from '../../src/db/schema/index.js';
import { CURRENT_TENANT } from '../../src/modules/invoicing/application/common.js';
import { issuerKeyOf } from '../../src/modules/invoicing/application/issue-attempt.js';
import { createAfipIssueJob } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { submissionKey } from '../support/billing-world.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Judgment day, Stage 4, round 4: findings R4-1 (an unconfirmed stray opened a silent double issue
 * with an authority that does not take our key), R4-3 (a parked invoice does not leave its voucher
 * unknown) and the suspects B-T2 (a lookup that ends with every number taken is still an unknown
 * outcome) and B-T4 (a lock timeout that is not a finite number).
 *
 * The issuer of these tests is NOT idempotent by key, like the real authority: a request sent twice
 * shows as two vouchers.
 */

let runtime: DbHandle;

beforeAll(() => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
});

afterAll(async () => {
  await runtime.close();
});

const MINUTE = 60_000;
const after = (base: number, minutes: number) => () => new Date(base + minutes * MINUTE);
const DNI = { type: 'dni', number: '30111222' } as const;

/** One organization per group of scenarios, so what one leaves in the series never reaches another. */
function useWorld(slug: string): { readonly world: InvoicingWorld } {
  const state: { world?: InvoicingWorld } = {};
  beforeAll(async () => {
    state.world = await createInvoicingWorld(runtime, { slug });
  });
  afterEach(() => {
    state.world?.issuer.setIdempotent(true);
    state.world?.issuer.setMode('ok');
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await state.world?.close();
  });
  return {
    get world() {
      if (!state.world) throw new Error('the world is not ready');
      return state.world;
    },
  };
}

const vouchersOf = (world: InvoicingWorld, invoiceId: string) =>
  world.issuer
    .vouchers()
    .filter((voucher) => voucher.idempotencyKey === issuerKeyOf(world.tenant.id, invoiceId));

/** An invoice of a new charge. Anonymous, or addressed to a DNI (then its facts differ from the other). */
async function create(world: InvoicingWorld, document?: typeof DNI) {
  const charge: ChargeDto = await world.charge();
  const response = await world.invoiceCharge(
    charge,
    document ? { recipient: { kind: 'patient', document } } : {},
  );
  expect(response.statusCode, response.body).toBe(202);
  return { charge, created: response.json<InvoiceDto>() };
}

async function runIssueWith(
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
async function drain(world: InvoicingWorld) {
  world.issuer.setMode('ok');
  await world.runIssue();
  const base = Date.now();
  for (let round = 1; round <= 6; round += 1) {
    const results = await world.sweep(after(base, round * 600));
    if (results.length === 0) return;
  }
}

/** The number the authority will give to the next voucher of the series (point of sale 1, type FC). */
async function nextArcaNumber(world: InvoicingWorld): Promise<number> {
  const [recorded] = await world.inTenant((tx) =>
    tx
      .select({ highest: sql<number>`coalesce(max(${invoiceTable.number}), 0)::int` })
      .from(invoiceTable)
      .where(and(eq(invoiceTable.pointOfSale, 1), eq(invoiceTable.type, 'FC'))),
  );
  const issued = world.issuer
    .vouchers()
    .filter(
      (voucher) =>
        voucher.tenantRef === world.tenant.id && voucher.pointOfSale === 1 && voucher.type === 'FC',
    )
    .map((voucher) => voucher.number);
  return Math.max(recorded?.highest ?? 0, ...issued) + 1;
}

/** The invoice waits for reconciliation with this number, as if its request had been sent. */
const markAwaiting = (
  world: InvoicingWorld,
  invoiceId: string,
  expectedNumber: number,
  t0: number,
) =>
  world.inTenant((tx) =>
    tx
      .update(invoiceTable)
      .set({
        deliveryState: 'awaiting_reconciliation',
        expectedNumber,
        awaitingSince: new Date(t0),
        nextAttemptAt: new Date(t0),
      })
      .where(eq(invoiceTable.id, invoiceId)),
  );

/** Replaces a pending invoice with a voucher made by hand at another point of sale, acknowledging the doubt. */
async function replaceWithManual(
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

/**
 * An invoice that was marked as waiting, with the number the authority was expected to give it, and
 * that was replaced by hand without knowing: the number is remembered, and nothing was EVER issued
 * there. The authority's next number is that very one.
 */
async function replacedAndNeverIssued(world: InvoicingWorld) {
  await drain(world);
  const owner = await create(world);
  const number = await nextArcaNumber(world);
  await markAwaiting(world, owner.created.id, number, Date.now());
  await replaceWithManual(world, owner);
  return { owner, number };
}

const strayRows = (world: InvoicingWorld) =>
  world.inTenant((tx) => tx.select().from(invoiceStrayVoucher));

const auditOf = (world: InvoicingWorld, invoiceId: string, action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.resourceId, invoiceId), eq(auditEvent.action, action as never))),
  );

const openItems = async (world: InvoicingWorld, invoiceId: string) =>
  (await world.api.get('/worklist?kind=invoice_attention&status=open', world.admin))
    .json<WorklistResponse>()
    .items.filter((item) => item.subjectId === invoiceId);

describe('a remembered number where nothing was issued (JD-S4 R4-1)', () => {
  const ctx = useWorld('strays-r4-ghost');

  it('adopts the voucher it finds at that number instead of sending again', async () => {
    const { world } = ctx;
    const { number } = await replacedAndNeverIssued(world);
    const b = await create(world, DNI);
    const t0 = Date.now();
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      world,
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    // The authority gave it the number that nobody took, and the answer was lost. The mark counted the
    // remembered number as taken, so it expects the one after it.
    expect(vouchersOf(world, b.created.id).map((voucher) => voucher.number)).toEqual([number]);
    expect((await world.rowOf(b.created.id)).expectedNumber).toBe(number + 1);
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.sweep(after(t0, 10));

    expect(issue).not.toHaveBeenCalled();
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number });
  });

  it('adopts it also when the mark still expects the remembered number, and the lookup skipped it', async () => {
    const { world } = ctx;
    const { number } = await replacedAndNeverIssued(world);
    const b = await create(world, DNI);
    const t0 = Date.now();
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      world,
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    // A mark written before the number was remembered expects the number itself.
    await world.inTenant((tx) =>
      tx
        .update(invoiceTable)
        .set({ expectedNumber: number })
        .where(eq(invoiceTable.id, b.created.id)),
    );
    const probed: number[] = [];
    const original = world.issuer.findIssued.bind(world.issuer);
    vi.spyOn(world.issuer, 'findIssued').mockImplementation((ref) => {
      probed.push(ref.number);
      return original(ref);
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.sweep(after(t0, 10));

    expect(issue).not.toHaveBeenCalled();
    expect(probed).toEqual([number, number + 1, number]);
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number });
  });

  it('does not send when the voucher there fits both the invoice and the one that was replaced: it parks with the doubt', async () => {
    const { world } = ctx;
    const { number } = await replacedAndNeverIssued(world);
    // The same anonymous consumer with the same fee on the same day: the voucher cannot be told apart.
    const b = await create(world);
    const t0 = Date.now();
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      world,
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    const issue = vi.spyOn(world.issuer, 'issue');

    const results = await world.sweep(after(t0, 10));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'needs_attention',
      expectedNumber: number + 1,
    });
    const [parked] = await auditOf(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'voucher_ambiguous', outcomeUnknown: true });
    const [item] = await openItems(world, b.created.id);
    expect(item?.detail).toMatchObject({ reason: 'voucher_ambiguous', outcomeUnknown: true });
  });

  it('sends when the voucher there is the one of the invoice that was replaced and not this one', async () => {
    const { world } = ctx;
    await drain(world);
    // The first invoice WAS issued (its answer was lost), then it was replaced by hand.
    const first = await create(world);
    const t0 = Date.now();
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      world,
      first.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    const ghost = vouchersOf(world, first.created.id)[0];
    expect(ghost).toBeDefined();
    await replaceWithManual(world, first);
    // The second one was marked and never sent: it expects the number after the remembered one.
    const second = await create(world, DNI);
    await markAwaiting(world, second.created.id, (ghost?.number ?? 0) + 1, t0);
    world.issuer.setIdempotent(false);
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.sweep(after(t0, 10));

    expect(issue).toHaveBeenCalledTimes(1);
    expect(vouchersOf(world, second.created.id).map((voucher) => voucher.number)).toEqual([
      (ghost?.number ?? 0) + 1,
    ]);
    expect(await world.rowOf(second.created.id)).toMatchObject({
      status: 'issued',
      number: (ghost?.number ?? 0) + 1,
    });
  });

  it('does not send while the authority cannot say what is at that number', async () => {
    const { world } = ctx;
    const { number } = await replacedAndNeverIssued(world);
    const b = await create(world, DNI);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, number + 1, t0);
    vi.spyOn(world.issuer, 'findIssued').mockImplementation((ref) =>
      Promise.resolve(
        ref.number === number
          ? { status: 'retryable', message: 'down', outcomeUnknown: true }
          : null,
      ),
    );
    const issue = vi.spyOn(world.issuer, 'issue');

    const results = await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'retry' });
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'awaiting_reconciliation',
      expectedNumber: number + 1,
    });
  });
});

describe('too many numbers where a voucher may sit (JD-S4 R4-1)', () => {
  const ctx = useWorld('strays-r4-bound');

  it('parks the invoice instead of asking about all of them or sending blind', async () => {
    const { world } = ctx;
    await drain(world);
    const owner = await create(world);
    await markAwaiting(world, owner.created.id, 40, Date.now());
    await replaceWithManual(world, owner);
    // Five more numbers below the one the next invoice expects, each one possibly holding a voucher.
    await world.inTenant((tx) =>
      tx.insert(invoiceStrayVoucher).values(
        [11, 12, 13, 14, 15].map((number) => ({
          tenantId: CURRENT_TENANT,
          invoiceId: owner.created.id,
          pointOfSale: 1,
          type: 'FC',
          number,
          reason: 'replaced_unresolved',
        })),
      ),
    );
    const b = await create(world, DNI);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, 41, t0);
    const probed: number[] = [];
    vi.spyOn(world.issuer, 'findIssued').mockImplementation((ref) => {
      probed.push(ref.number);
      return Promise.resolve(null);
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    const results = await world.sweep(after(t0, 1));

    // Six remembered numbers (the five above and the one of the replaced invoice): more than it asks
    // about. It asks about the number it expects and nothing else.
    expect(probed).toEqual([41]);
    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    const [parked] = await auditOf(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'voucher_ambiguous', outcomeUnknown: true });
  });
});

describe('a parked invoice remembers the vouchers it knows of (JD-S4 R4-3)', () => {
  const ctx = useWorld('strays-r4-parked');

  it('remembers the foreign voucher found where the invoice was expected, so a later invoice with the same facts does not adopt it', async () => {
    const { world } = ctx;
    await drain(world);
    const first = await create(world);
    // The second one has a document: its facts are not the ones of the first.
    const second = await create(world, DNI);
    const row = await world.rowOf(second.created.id);
    const number = await nextArcaNumber(world);
    // Somebody else issued a voucher at the number the first invoice expects, with the facts of the second.
    const foreign = await world.issuer.issue(
      {
        issuerCuit: row.issuerSnapshot?.cuit ?? '',
        tenantRef: world.tenant.id,
        pointOfSale: 1,
        type: 'FC',
        issueDate: row.issueDate,
        currency: 'ARS',
        totalCents: row.totalCents,
        buyerDocument: DNI,
        lastKnownNumber: number - 1,
      },
      `foreign-${String(number)}`,
    );
    expect(foreign).toMatchObject({ status: 'issued', number });
    const t0 = Date.now();
    await markAwaiting(world, first.created.id, number, t0);

    await world.sweep(after(t0, 1));

    expect(await world.rowOf(first.created.id)).toMatchObject({ deliveryState: 'needs_attention' });
    const remembered = (await strayRows(world)).filter(
      (stray) => stray.invoiceId === first.created.id,
    );
    expect(remembered).toMatchObject([{ number, reason: 'unmatched' }]);

    // The second invoice is sent, its answer is lost: it must find its own voucher, not the foreign one.
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      world,
      second.created.id,
      world.issueDeps(() => new Date(t0 + 2 * MINUTE)),
    );
    world.issuer.setMode('ok');
    const own = vouchersOf(world, second.created.id)[0];
    expect(own?.number).toBe(number + 1);
    expect((await world.rowOf(second.created.id)).expectedNumber).toBe(number + 1);

    await world.sweep(after(t0, 12));

    expect(await world.rowOf(second.created.id)).toMatchObject({
      status: 'issued',
      number: number + 1,
      cae: own?.cae,
    });
    expect(vouchersOf(world, second.created.id)).toHaveLength(1);
  });
});

describe('a voucher that collides with one of ours (JD-S4 R4-3)', () => {
  const ctx = useWorld('strays-r4-collision');

  it('remembers the number of the voucher that collided with a number we hold', async () => {
    const { world } = ctx;
    await drain(world);
    const taken = await world.issueInvoiceOf(await world.charge());
    const b = await create(world);
    const t0 = Date.now();
    vi.spyOn(world.issuer, 'issue').mockResolvedValueOnce({
      status: 'issued',
      number: taken.number ?? 0,
      cae: '70888888888888',
      caeExpiresOn: '2031-06-01',
    });

    await world.runIssue(after(t0, 0));

    expect(await world.rowOf(b.created.id)).toMatchObject({ deliveryState: 'needs_attention' });
    const remembered = (await strayRows(world)).filter((stray) => stray.invoiceId === b.created.id);
    expect(remembered).toMatchObject([{ number: taken.number, reason: 'unmatched' }]);
  });

  it('remembers the number of the voucher that collided with a CAE we hold', async () => {
    const { world } = ctx;
    await drain(world);
    const taken = await world.issueInvoiceOf(await world.charge());
    const b = await create(world);
    const t0 = Date.now();
    const number = (taken.number ?? 0) + 1;
    vi.spyOn(world.issuer, 'issue').mockResolvedValueOnce({
      status: 'issued',
      number,
      cae: taken.cae ?? '',
      caeExpiresOn: '2031-06-01',
    });

    await world.runIssue(after(t0, 0));

    expect(await world.rowOf(b.created.id)).toMatchObject({ deliveryState: 'needs_attention' });
    const [parked] = await auditOf(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'cae_taken' });
    const remembered = (await strayRows(world)).filter((stray) => stray.invoiceId === b.created.id);
    expect(remembered).toMatchObject([{ number, reason: 'unmatched' }]);
  });
});

describe('a lookup that ends with every number taken is still an unknown outcome (JD-S4 R4-B-T2)', () => {
  const ctx = useWorld('strays-r4-taken');

  it('parks the invoice with the doubt, keeping the number it expected', async () => {
    const { world } = ctx;
    await drain(world);
    const taken = await world.issueInvoiceOf(await world.charge());
    const takenNumber = taken.number ?? 0;
    const waiting = await create(world);
    const t0 = Date.now();
    await markAwaiting(world, waiting.created.id, takenNumber, t0);
    const row = await world.rowOf(waiting.created.id);
    const voucher = (number: number, cae: string) => ({
      status: 'issued' as const,
      number,
      cae,
      caeExpiresOn: '2031-06-01',
      totalCents: row.totalCents,
      issueDate: row.issueDate,
      issuerCuit: row.issuerSnapshot?.cuit ?? '',
      buyerDocument: null,
      associatedVoucher: null,
    });
    vi.spyOn(world.issuer, 'findIssued').mockImplementation(async (ref) => {
      if (ref.number === takenNumber) return voucher(takenNumber, '71000000000000');
      // While the lookup runs, a voucher is registered at the number after it.
      await world.inTenant((tx) =>
        tx.insert(invoiceStrayVoucher).values({
          tenantId: CURRENT_TENANT,
          invoiceId: taken.id,
          pointOfSale: 1,
          type: 'FC',
          number: ref.number,
          reason: 'orphaned',
        }),
      );
      return voucher(ref.number, '71000000000001');
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(await world.rowOf(waiting.created.id)).toMatchObject({
      deliveryState: 'needs_attention',
      expectedNumber: takenNumber,
    });
    const [parked] = await auditOf(world, waiting.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'number_taken', outcomeUnknown: true });
    const [item] = await openItems(world, waiting.created.id);
    expect(item?.detail).toMatchObject({ reason: 'number_taken', outcomeUnknown: true });
  });
});

describe('the lock timeout of the mark (JD-S4 R4-B-T4)', () => {
  const ctx = useWorld('strays-r4-timeout');

  it('uses the default for a value that is not a finite number, instead of failing the attempt', async () => {
    const { world } = ctx;
    await drain(world);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { created } = await create(world);

      await runIssueWith(world, created.id, { ...world.issueDeps(), markLockTimeoutMs: bad });

      expect(await world.rowOf(created.id), String(bad)).toMatchObject({ status: 'issued' });
    }
  });
});
