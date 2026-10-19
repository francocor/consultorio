import type { ChargeDto, InvoiceDto, Problem } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { invoice as invoiceTable } from '../../src/db/schema/index.js';
import { issuerKeyOf } from '../../src/modules/invoicing/application/issue-attempt.js';
import { createAfipIssueJob } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { submissionKey } from '../support/billing-world.js';
import { issueOutOfBand } from '../support/invoice-series.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';
import { gate } from '../support/lock-waits.js';

/**
 * Judgment day, Stage 4, round 2: finding R2-1 (a lost answer must never be taken for the voucher of
 * ANOTHER invoice of the same series, and a number that moved is probed before anything is sent), the
 * attempt-side findings R2-3 (the mark that is written before the call) and R2-7 (a crash before the
 * call, a real attempt against a manual replacement), and the suspect A-W4 (an authority that refuses
 * the question is not "nothing there").
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-series' });
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

/** Asks for an invoice of a new charge; its `afip.issue` job is queued and NOT run. */
async function create() {
  const charge: ChargeDto = await world.charge();
  const response = await world.invoiceCharge(charge);
  expect(response.statusCode, response.body).toBe(202);
  return { charge, created: response.json<InvoiceDto>() };
}

/** Runs the pending `afip.issue` job of one invoice by hand, with the deps the test chooses. */
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

/** Runs every sweep until nothing of this organization is pending (the invoices of other tests). */
async function drain() {
  world.issuer.setMode('ok');
  await world.runIssue();
  const base = Date.now();
  for (let round = 1; round <= 6; round += 1) {
    const results = await world.sweep(after(base, round * 600));
    if (results.length === 0) return;
  }
}

describe('two invoices of one series with the same total on the same day (JD-S4 R2-1)', () => {
  it('holds the second invoice back while the answer of the first is lost, and issues each service once with its own voucher', async () => {
    await drain();
    const first = await create();
    const second = await create();
    const t0 = Date.now();

    // The answer for the first is lost; the authority holds its voucher.
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      first.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    expect(await world.rowOf(first.created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
    });
    // The second one is not sent while the first may have been answered: it cannot lose an answer.
    const issue = vi.spyOn(world.issuer, 'issue');
    try {
      await runIssueWith(
        second.created.id,
        world.issueDeps(() => new Date(t0)),
      );
      expect(issue).not.toHaveBeenCalled();
    } finally {
      issue.mockRestore();
    }
    expect(vouchersOf(second.created.id)).toHaveLength(0);
    // The second one is due now.
    await world.inTenant((tx) =>
      tx
        .update(invoiceTable)
        .set({ nextAttemptAt: new Date(t0 - 1000) })
        .where(eq(invoiceTable.id, second.created.id)),
    );

    const outcomes: string[] = [];
    for (let round = 1; round <= 8; round += 1) {
      const results = await world.sweep(after(t0, round * 10));
      outcomes.push(...results.map((result) => result.outcome));
      const a = await world.rowOf(first.created.id);
      const b = await world.rowOf(second.created.id);
      if (a.status === 'issued' && b.status === 'issued') break;
    }

    const a = await world.rowOf(first.created.id);
    const b = await world.rowOf(second.created.id);
    expect([a.status, b.status]).toEqual(['issued', 'issued']);
    // One voucher per service, and each invoice holds its own.
    expect(vouchersOf(first.created.id)).toHaveLength(1);
    expect(vouchersOf(second.created.id)).toHaveLength(1);
    expect(a.number).toBe(vouchersOf(first.created.id)[0]?.number);
    expect(b.number).toBe(vouchersOf(second.created.id)[0]?.number);
    expect(a.number).not.toBe(b.number);
    expect(outcomes).not.toContain('attention');
  });

  it('does not send the second invoice while the first one may have been answered', async () => {
    await drain();
    const first = await create();
    const second = await create();
    const t0 = Date.now();
    world.issuer.setMode('timeout_after_authorize');
    await runIssueWith(
      first.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      const outcome = await runIssueWith(
        second.created.id,
        world.issueDeps(() => new Date(t0)),
      );

      expect(outcome).toEqual({ status: 'completed' });
      expect(issue).not.toHaveBeenCalled();
    } finally {
      issue.mockRestore();
    }
    expect(await world.rowOf(second.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'queued',
    });
    // The first one is reconciled, and then the second goes out.
    world.issuer.setMode('ok');
    await world.sweep(after(t0, 10));
    await world.sweep(after(t0, 20));
    expect((await world.rowOf(first.created.id)).status).toBe('issued');
    expect((await world.rowOf(second.created.id)).status).toBe('issued');
    expect(vouchersOf(second.created.id)).toHaveLength(1);
  });

  it('skips an invoice of the series while another one is being sent, and sends it afterwards', async () => {
    await drain();
    const first = await create();
    const second = await create();
    const t0 = Date.now();
    const entered = gate();
    const answer = gate();
    const original = world.issuer.issue.bind(world.issuer);
    const issue = vi.spyOn(world.issuer, 'issue').mockImplementationOnce(async (request, key) => {
      entered.open();
      await answer.opened;
      return original(request, key);
    });

    try {
      const running = runIssueWith(
        first.created.id,
        world.issueDeps(() => new Date(t0)),
      );
      await entered.opened;
      const during = (await world.sweep(after(t0, 0))).filter(
        (result) => result.invoiceId === second.created.id,
      );

      expect(during).toEqual([{ invoiceId: second.created.id, outcome: 'skipped' }]);
      expect(issue).toHaveBeenCalledTimes(1);
      answer.open();
      await running;
    } finally {
      answer.open();
      issue.mockRestore();
    }
    const results = await world.sweep(after(t0, 1));

    expect(results).toContainEqual({ invoiceId: second.created.id, outcome: 'issued' });
  });
});

/** An invoice that waits for reconciliation with a number that is no longer free. */
async function staleMark() {
  await drain();
  const taken = await world.issueInvoiceOf(await world.charge());
  const waiting = await create();
  const t0 = Date.now();
  const takenNumber = taken.number ?? 0;
  await world.inTenant((tx) =>
    tx
      .update(invoiceTable)
      .set({
        deliveryState: 'awaiting_reconciliation',
        expectedNumber: takenNumber,
        authorityLastAtMark: takenNumber - 1,
        awaitingSince: new Date(t0),
      })
      .where(eq(invoiceTable.id, waiting.created.id)),
  );
  const row = await world.rowOf(waiting.created.id);
  return { waiting: waiting.created, row, takenNumber, t0 };
}

describe('a number that moved while the invoice waited (JD-S4 R2-1)', () => {
  it('does not ask about a number one of our invoices records, and adopts the voucher it finds after it, instead of issuing again', async () => {
    const { waiting, takenNumber, t0 } = await staleMark();
    // The authority holds the voucher of the waiting invoice right after the one that is taken.
    const own = await issueOutOfBand(world, { invoiceId: waiting.id }, `series-own-${String(t0)}`);
    expect(own.number).toBe(takenNumber + 1);
    const probe = vi.spyOn(world.issuer, 'findIssued');
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      const results = await world.sweep(after(t0, 1));

      expect(results).toContainEqual({ invoiceId: waiting.id, outcome: 'issued' });
      expect(issue).not.toHaveBeenCalled();
      expect(probe.mock.calls.map(([ref]) => ref.number)).toEqual([takenNumber + 1]);
    } finally {
      probe.mockRestore();
      issue.mockRestore();
    }
    expect(await world.rowOf(waiting.id)).toMatchObject({
      status: 'issued',
      number: takenNumber + 1,
      cae: own.cae,
    });
  });

  it('sends once, asking about nothing, when the only number after the mark is one of ours', async () => {
    const { waiting, t0 } = await staleMark();
    const probe = vi.spyOn(world.issuer, 'findIssued');
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      const results = await world.sweep(after(t0, 1));

      expect(results).toContainEqual({ invoiceId: waiting.id, outcome: 'issued' });
      expect(issue).toHaveBeenCalledTimes(1);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
      issue.mockRestore();
    }
    expect(vouchersOf(waiting.id)).toHaveLength(1);
  });

  it('does not take for its own a voucher of another recipient, or one that does not say whom it is for', async () => {
    await drain();
    const { created } = await create();
    const t0 = Date.now();
    world.issuer.setMode('timeout_after_authorize');
    await world.runIssue(after(t0, 0));
    const authorized = vouchersOf(created.id)[0];
    const row = await world.rowOf(created.id);
    const probe = vi.spyOn(world.issuer, 'findIssued').mockResolvedValueOnce({
      status: 'issued',
      number: authorized?.number ?? 0,
      cae: authorized?.cae ?? '',
      caeExpiresOn: '2031-06-01',
      totalCents: row.totalCents,
      issueDate: row.issueDate,
      // The same total, the same day, the same issuer, and nothing about the recipient.
      issuerCuit: row.issuerSnapshot?.cuit ?? '',
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      const results = await world.sweep(after(t0, 1));

      expect(results).toContainEqual({ invoiceId: created.id, outcome: 'attention' });
      expect(issue).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
      issue.mockRestore();
    }
    expect(await world.rowOf(created.id)).toMatchObject({ deliveryState: 'needs_attention' });
    // The voucher is real, and it is the person's turn to say whose it is.
    await world.inTenant((tx) =>
      tx
        .update(invoiceTable)
        .set({ status: 'rejected', deliveryState: null, rejectionMessage: 'Cerrada a mano' })
        .where(eq(invoiceTable.id, created.id)),
    );
  });
});

describe('an authority that refuses the question (JD-S4 R2-A-W4)', () => {
  it('does not take a rejected lookup for "nothing there": nothing is sent and the mark stays', async () => {
    await drain();
    const { created } = await create();
    const t0 = Date.now();
    world.issuer.setMode('timeout_after_authorize');
    await world.runIssue(after(t0, 0));
    const probe = vi.spyOn(world.issuer, 'findIssued').mockResolvedValueOnce({
      status: 'rejected',
      message: '(600) El token de acceso no es válido.',
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      const results = await world.sweep(after(t0, 1));

      expect(results).toContainEqual({ invoiceId: created.id, outcome: 'retry' });
      expect(issue).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
      issue.mockRestore();
    }
    expect(await world.rowOf(created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'awaiting_reconciliation',
    });
    await world.sweep(after(t0, 600));
    expect((await world.rowOf(created.id)).status).toBe('issued');
  });
});

describe('the mark written before the call (JD-S4 R2-3)', () => {
  it('does not call the authority when the invoice was closed before the mark was written', async () => {
    await drain();
    const { created } = await create();
    // The invoice is closed by someone else right before the attempt writes its mark.
    const closing = new Proxy(runtime.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (...args: Parameters<typeof target.transaction>) => {
            await world.inTenant((tx) =>
              tx
                .update(invoiceTable)
                .set({
                  status: 'rejected',
                  deliveryState: null,
                  rejectionMessage: 'Cerrada a mano',
                  nextAttemptAt: null,
                })
                .where(eq(invoiceTable.id, created.id)),
            );
            return target.transaction(...args);
          };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      const outcome = await runIssueWith(created.id, {
        ...world.issueDeps(() => new Date()),
        db: closing,
      });

      expect(outcome).toEqual({ status: 'completed' });
      expect(issue).not.toHaveBeenCalled();
    } finally {
      issue.mockRestore();
    }
    expect(vouchersOf(created.id)).toHaveLength(0);
    expect((await world.rowOf(created.id)).status).toBe('rejected');
  });

  /** Runs an attempt whose mark has to wait for a row that somebody else keeps locked. */
  async function attemptWhileLocked(markLockTimeoutMs: number) {
    await drain();
    const { created } = await create();
    const t0 = Date.now();
    const held = gate();
    const release = gate();
    const holding = world.inTenant(async (tx) => {
      await tx
        .select({ id: invoiceTable.id })
        .from(invoiceTable)
        .where(eq(invoiceTable.id, created.id))
        .for('update');
      held.open();
      await release.opened;
    });
    await held.opened;
    const issue = vi.spyOn(world.issuer, 'issue');
    const errors: Record<string, unknown>[] = [];
    const started = Date.now();
    let outcome: unknown;
    let called: number;

    try {
      outcome = await runIssueWith(created.id, {
        ...world.issueDeps(() => new Date(t0)),
        markLockTimeoutMs,
        log: { error: (object) => errors.push(object) },
      });
      called = issue.mock.calls.length;
    } finally {
      release.open();
      await holding;
      issue.mockRestore();
    }
    return { created, t0, outcome, called, errors, waited: Date.now() - started };
  }

  it('gives up the attempt instead of hanging when the mark waits for a row lock, says so, and goes on once it is free', async () => {
    const { created, t0, outcome, called, errors, waited } = await attemptWhileLocked(300);

    // It does not wait for the lock for ever: the mark gives up and the sweeper tries again.
    expect(waited).toBeLessThan(15_000);
    expect(outcome).toEqual({ status: 'completed' });
    expect(called).toBe(0);
    // A lock that is kept is not silent (JD-S4 R3-A-W4).
    expect(errors).toEqual([expect.objectContaining({ invoiceId: created.id })]);
    const again = await world.sweep(after(t0, 1));

    expect(again).toContainEqual({ invoiceId: created.id, outcome: 'issued' });
  }, 40_000);

  it('treats a timeout of zero as the shortest one, not as no timeout at all (JD-S4 R3-B-S4)', async () => {
    const { created, t0, outcome, called, waited } = await attemptWhileLocked(0);

    expect(waited).toBeLessThan(15_000);
    expect(outcome).toEqual({ status: 'completed' });
    expect(called).toBe(0);
    const again = await world.sweep(after(t0, 1));

    expect(again).toContainEqual({ invoiceId: created.id, outcome: 'issued' });
  }, 40_000);

  it('opens the pools of the application with a timeout to get a connection, so a full pool fails instead of hanging', () => {
    const handle = createRuntimeDb(inject('runtimeUrl'));
    const sized = createRuntimeDb(inject('runtimeUrl'), { max: 4 });
    try {
      expect(handle.pool.options.connectionTimeoutMillis).toBe(10_000);
      // Ten connections unless the configuration says otherwise (`DB_POOL_MAX`).
      expect(handle.pool.options.max).toBe(10);
      expect(sized.pool.options.max).toBe(4);
    } finally {
      void handle.close();
      void sized.close();
    }
  });
});

describe('a crash and a race around the call (JD-S4 R2-7)', () => {
  it('asks for the last number of the authority, finds nothing new and sends once when the process died after the mark and before the authority answered', async () => {
    await drain();
    const { created } = await create();
    const t0 = Date.now();
    const issue = vi.spyOn(world.issuer, 'issue').mockImplementationOnce(() => {
      // The process dies before the request goes out: nothing returns, nothing is caught.
      throw new Error('the process died');
    });

    try {
      await expect(
        runIssueWith(
          created.id,
          world.issueDeps(() => new Date(t0)),
        ),
      ).rejects.toBeDefined();
    } finally {
      issue.mockRestore();
    }
    // What was committed before the call is all that is left: the mark, with the number to expect.
    const left = await world.rowOf(created.id);
    expect(left).toMatchObject({
      status: 'pending',
      deliveryState: 'awaiting_reconciliation',
      attempts: 0,
    });
    expect(left.expectedNumber).toBeGreaterThan(0);
    // The mark holds the last number the authority had authorized, and expects the one after it.
    expect(left.authorityLastAtMark).toBe((left.expectedNumber ?? 0) - 1);
    expect(vouchersOf(created.id)).toHaveLength(0);
    const probe = vi.spyOn(world.issuer, 'findIssued');
    const sent = vi.spyOn(world.issuer, 'issue');

    try {
      const results = await world.sweep(after(t0, 1));

      expect(results).toContainEqual({ invoiceId: created.id, outcome: 'issued' });
      // The authority has issued nothing since the mark: there is no number to ask about.
      expect(probe).not.toHaveBeenCalled();
      expect(sent).toHaveBeenCalledTimes(1);
    } finally {
      probe.mockRestore();
      sent.mockRestore();
    }
    expect(vouchersOf(created.id)).toHaveLength(1);
  });

  it('answers conflict to a manual replacement while a real attempt is waiting for the authority, and the attempt issues the invoice', async () => {
    await drain();
    const { charge, created } = await create();
    const t0 = Date.now();
    const entered = gate();
    const answer = gate();
    const original = world.issuer.issue.bind(world.issuer);
    const issue = vi.spyOn(world.issuer, 'issue').mockImplementationOnce(async (request, key) => {
      entered.open();
      await answer.opened;
      return original(request, key);
    });
    const lines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'patient');

    let response!: Awaited<ReturnType<typeof world.api.post>>;
    let running: Promise<unknown> | undefined;
    try {
      running = runIssueWith(
        created.id,
        world.issueDeps(() => new Date(t0)),
      );
      await entered.opened;
      response = await world.api.post('/invoices/manual', world.admin, {
        idempotencyKey: submissionKey(),
        type: 'FC',
        pointOfSale: 1,
        number: 700_000 + Math.floor(Math.random() * 1e4),
        cae: String(72_000_000_000_000 + Math.floor(Math.random() * 1e9)),
        issueDate: '2031-05-20',
        totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
        lines: lines.map((line) => ({ chargeLineId: line.id })),
        recipient: { kind: 'patient' },
        replacesInvoiceId: created.id,
      });
    } finally {
      answer.open();
      await running;
      issue.mockRestore();
    }

    // The replacement could not take the invoice from under the attempt.
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<Problem>().code).toBe('conflict');
    expect(await world.rowOf(created.id)).toMatchObject({ status: 'issued' });
    expect(vouchersOf(created.id)).toHaveLength(1);
  });
});
