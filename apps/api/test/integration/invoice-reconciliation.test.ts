import type { ChargeDto, InvoiceDto, Problem } from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { nextCuit } from '../../src/adapters/invoice-issuer.contract.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { invoice as invoiceTable } from '../../src/db/schema/index.js';
import { worklistItem } from '../../src/db/schema/worklist.js';
import { loadDocumentData } from '../../src/modules/invoicing/application/invoice-document.js';
import { issuerKeyOf } from '../../src/modules/invoicing/application/issue-attempt.js';
import { createAfipIssueJob } from '../../src/modules/invoicing/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { JobClient } from '../../src/platform/jobs/boss.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { submissionKey } from '../support/billing-world.js';
import {
  authorityLast,
  issueOutOfBand,
  markAwaiting,
  strayRows,
} from '../support/invoice-series.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * Judgment day, Stage 4, round 1: findings C3, C4, C7, C8 and the audit of the attempts (A-W6). What
 * the issue attempt does around the call to the authority: the mark it commits BEFORE the call, the
 * voucher it adopts instead of issuing twice, the issuer it keeps, the number it cannot record, the
 * invoice that is closed while the call is in flight.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoice-reconciliation' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const problem = (response: LightMyRequestResponse) => response.json<Problem>();

const auditRows = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action as never)))
      .orderBy(desc(auditEvent.occurredAt)),
  );

const attentionItems = (invoiceId: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(worklistItem)
      .where(
        and(eq(worklistItem.kind, 'invoice_attention'), eq(worklistItem.subjectId, invoiceId)),
      ),
  );

/** Asks for an invoice of a new charge, after the invoices other tests left were submitted. */
async function requested() {
  await world.runIssue();
  world.issuer.setMode('ok');
  const charge = await world.charge();
  const response = await world.invoiceCharge(charge);
  expect(response.statusCode, response.body).toBe(202);
  const created = response.json<InvoiceDto>();
  return { charge, created, t0: Date.now() };
}

const sweepOf = async (invoiceId: string, clock: () => Date) =>
  (await world.sweep(clock)).filter((result) => result.invoiceId === invoiceId);

const after = (base: number, minutes: number) => () => new Date(base + minutes * 60_000);

const vouchersOf = (invoiceId: string) =>
  world.issuer
    .vouchers()
    .filter((voucher) => voucher.idempotencyKey === issuerKeyOf(world.tenant.id, invoiceId));

/** Runs the pending `afip.issue` job of an invoice by hand, with the deps the test chooses. */
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

describe('the mark written before the call (JD-S4 R1-C4)', () => {
  it('is committed, with the number to expect, before the authority is called', async () => {
    const { created } = await requested();
    let seen: Awaited<ReturnType<typeof world.rowOf>> | undefined;
    const original = world.issuer.issue.bind(world.issuer);
    const issue = vi.spyOn(world.issuer, 'issue').mockImplementationOnce(async (request, key) => {
      // Another connection reads the row while the call is in flight: only a committed mark shows.
      seen = await world.rowOf(created.id);
      return original(request, key);
    });

    try {
      await world.runIssue();
    } finally {
      issue.mockRestore();
    }

    expect(seen).toMatchObject({ status: 'pending', deliveryState: 'awaiting_reconciliation' });
    expect(seen?.expectedNumber).toBeGreaterThan(0);
    // The mark holds the last number the AUTHORITY had authorized, and expects the one after it.
    expect(seen?.authorityLastAtMark).toBe((seen?.expectedNumber ?? 0) - 1);
    expect(await world.rowOf(created.id)).toMatchObject({
      status: 'issued',
      deliveryState: null,
      expectedNumber: null,
      authorityLastAtMark: null,
    });
  });

  it('survives a crash after the authority answered: the retry adopts the voucher and issues nothing', async () => {
    const { created, t0 } = await requested();
    // The attempt dies after the authority issued the voucher: queuing the PDF fails, the whole
    // attempt rolls back, and only what was committed before the call is left.
    const failing: JobClient = { enqueue: () => Promise.reject(new Error('the process died')) };

    await expect(
      runIssueWith(created.id, { ...world.issueDeps(() => new Date(t0)), jobs: failing }),
    ).rejects.toBeDefined();

    expect(vouchersOf(created.id)).toHaveLength(1);
    const left = await world.rowOf(created.id);
    expect(left).toMatchObject({
      status: 'pending',
      deliveryState: 'awaiting_reconciliation',
      attempts: 0,
    });
    const authorized = vouchersOf(created.id)[0];
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      const outcome = await sweepOf(created.id, after(t0, 1));

      expect(outcome).toEqual([{ invoiceId: created.id, outcome: 'issued' }]);
      // The voucher was found by asking for its number: the authority was not asked to issue.
      expect(issue).not.toHaveBeenCalled();
    } finally {
      issue.mockRestore();
    }
    expect(vouchersOf(created.id)).toHaveLength(1);
    expect(await world.getInvoice(created.id)).toMatchObject({
      status: 'issued',
      number: authorized?.number,
      cae: authorized?.cae,
    });
  });

  it('goes on, remembering the voucher, when the one after the mark is not its own, and sends once (JD-S4 R5-1)', async () => {
    const { created, t0 } = await requested();
    const floor = await authorityLast(world, created.id);
    await markAwaiting(world, created.id, floor, t0);
    // The authority issued something else after the mark (another amount): it is not this invoice's.
    const foreign = await issueOutOfBand(
      world,
      { invoiceId: created.id, totalCents: 1 },
      `r5-${String(t0)}`,
    );
    expect(foreign.number).toBe(floor + 1);
    world.issuer.setIdempotent(false);
    const issue = vi.spyOn(world.issuer, 'issue');

    try {
      issue.mockClear();
      const outcome = await sweepOf(created.id, after(t0, 11));

      expect(outcome).toEqual([{ invoiceId: created.id, outcome: 'issued' }]);
      expect(issue).toHaveBeenCalledTimes(1);
    } finally {
      issue.mockRestore();
      world.issuer.setIdempotent(true);
    }
    expect(vouchersOf(created.id).map((voucher) => voucher.number)).toEqual([floor + 2]);
    expect(await world.rowOf(created.id)).toMatchObject({ status: 'issued', number: floor + 2 });
    expect(
      (await strayRows(world)).filter((stray) => stray.number === foreign.number),
    ).toMatchObject([{ reason: 'unmatched', invoiceId: created.id }]);
  });
});

describe('the issuer an invoice keeps (JD-S4 R1-C7)', () => {
  it('reconciles with the CUIT it was requested with after the profile changed, instead of a rejection and a second voucher', async () => {
    const { created, t0 } = await requested();
    const profile = (await world.api.get('/invoicing/config', world.owner)).json<{
      profile: { cuit: string; businessName: string; address: string; activityStartedOn: string };
    }>().profile;
    world.issuer.setMode('timeout_after_authorize');
    await world.runIssue(after(t0, 0));
    expect(vouchersOf(created.id)).toHaveLength(1);

    // The owner corrects the CUIT of the profile while the invoice waits for reconciliation.
    const edited = await world.api.put('/invoicing/profile', world.owner, {
      cuit: nextCuit(),
      taxCondition: 'monotributo',
      businessName: 'Otra razon social SRL',
      address: profile.address,
      activityStartedOn: profile.activityStartedOn,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const issue = vi.spyOn(world.issuer, 'issue');
    const probe = vi.spyOn(world.issuer, 'findIssued');

    try {
      const outcome = await sweepOf(created.id, after(t0, 1));

      expect(outcome).toEqual([{ invoiceId: created.id, outcome: 'issued' }]);
      expect(issue).not.toHaveBeenCalled();
      // The authority was asked with the issuer of the request.
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({ issuerCuit: vouchersOf(created.id)[0]?.issuerCuit }),
      );
    } finally {
      issue.mockRestore();
      probe.mockRestore();
      await world.api.put('/invoicing/profile', world.owner, {
        cuit: profile.cuit,
        taxCondition: 'monotributo',
        businessName: profile.businessName,
        address: profile.address,
        activityStartedOn: profile.activityStartedOn,
      });
    }
    expect(vouchersOf(created.id)).toHaveLength(1);
  });

  it('prints the issuer the invoice was requested with, whatever the profile says later', async () => {
    const charge = await world.charge();
    const issued = await world.issueInvoiceOf(charge);
    const before = (await world.api.get('/invoicing/config', world.owner)).json<{
      profile: { cuit: string; businessName: string; address: string; activityStartedOn: string };
    }>().profile;
    const edited = await world.api.put('/invoicing/profile', world.owner, {
      ...before,
      taxCondition: 'monotributo',
      businessName: 'Razon social nueva SRL',
      address: 'Calle Nueva 456, CABA',
    });
    expect(edited.statusCode, edited.body).toBe(200);

    try {
      const row = await world.rowOf(issued.id);
      const data = await world.inTenant((tx) => loadDocumentData(tx, row));

      expect(data.issuer).toMatchObject({
        businessName: 'Consultorio Aillu',
        address: 'Av. Siempre Viva 123, CABA',
        cuit: before.cuit,
      });
    } finally {
      await world.api.put('/invoicing/profile', world.owner, {
        ...before,
        taxCondition: 'monotributo',
        businessName: before.businessName,
        address: before.address,
      });
    }
  });
});

describe('a voucher whose number is already ours (JD-S4 R1-C8)', () => {
  it('parks the invoice instead of retrying forever, tells the worklist, and no attempt touches it again', async () => {
    // A voucher of ours holds a number; the authority now answers with that same number.
    const takenBy = await world.issueInvoiceOf(await world.charge());
    const { created, t0 } = await requested();
    const issue = vi.spyOn(world.issuer, 'issue').mockResolvedValueOnce({
      status: 'issued',
      number: takenBy.number ?? 0,
      cae: '70888888888888',
      caeExpiresOn: '2031-06-01',
    });

    try {
      const results = await world.runIssue(after(t0, 0));

      expect(results).toContainEqual({ name: 'afip.issue', result: { status: 'completed' } });
    } finally {
      issue.mockRestore();
    }
    expect(await world.rowOf(created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'needs_attention',
      nextAttemptAt: null,
      expectedNumber: null,
      attempts: 1,
    });
    const [item] = await attentionItems(created.id);
    expect(item).toMatchObject({ subjectType: 'invoice', status: 'open', locationId: null });
    const [entry] = (await auditRows('invoice.needs_attention')).filter(
      (row) => row.resourceId === created.id,
    );
    expect(entry?.metadata).toMatchObject({ number: takenBy.number, reason: 'number_taken' });

    const again = vi.spyOn(world.issuer, 'issue');
    try {
      expect(await sweepOf(created.id, after(t0, 600))).toEqual([]);
      expect(again).not.toHaveBeenCalled();
    } finally {
      again.mockRestore();
    }
  });

  it('can still be replaced by the voucher registered by hand', async () => {
    const takenBy = await world.issueInvoiceOf(await world.charge());
    const { charge, created, t0 } = await requested();
    const issue = vi.spyOn(world.issuer, 'issue').mockResolvedValueOnce({
      status: 'issued',
      number: takenBy.number ?? 0,
      cae: '70777777777777',
      caeExpiresOn: '2031-06-01',
    });
    try {
      await world.runIssue(after(t0, 0));
    } finally {
      issue.mockRestore();
    }
    const lines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'patient');

    const response = await world.api.post('/invoices/manual', world.admin, {
      idempotencyKey: submissionKey(),
      type: 'FC',
      pointOfSale: 1,
      number: (takenBy.number ?? 0) + 500,
      cae: '70666666666666',
      issueDate: '2031-05-20',
      caeExpiresOn: '2031-05-30',
      totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
      lines: lines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
      replacesInvoiceId: created.id,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(await world.rowOf(created.id)).toMatchObject({ status: 'rejected' });
  });
});

describe('the environment of a point of sale (JD-S4 R1-C8)', () => {
  it('cannot change once invoices went through it, and can before', async () => {
    await world.issueInvoiceOf(await world.charge());
    const config = (await world.api.get('/invoicing/config', world.owner)).json<{
      pointsOfSale: { id: string; number: number }[];
    }>();
    const used = config.pointsOfSale.find((point) => point.number === 1);

    const refused = await world.api.patch(
      `/invoicing/points-of-sale/${used?.id ?? ''}`,
      world.owner,
      {
        environment: 'production',
      },
    );
    const created = await world.api.post('/invoicing/points-of-sale', world.owner, { number: 7 });
    const changed = await world.api.patch(
      `/invoicing/points-of-sale/${created.json<{ id: string }>().id}`,
      world.owner,
      // Inactive again at once: the other tests invoice through the point of sale 1.
      { environment: 'production', active: false },
    );

    expect(refused.statusCode, refused.body).toBe(409);
    expect(problem(refused).code).toBe('point_of_sale_has_invoices');
    expect(changed.statusCode, changed.body).toBe(200);
  });
});

describe('replacing a pending invoice with a manual voucher (JD-S4 R1-C3)', () => {
  async function replaceBody(charge: ChargeDto, replaces: string, extra = {}) {
    const lines = (await world.linesOf(charge.id)).filter((line) => line.portion === 'patient');
    return {
      idempotencyKey: submissionKey(),
      type: 'FC',
      pointOfSale: 1,
      number: 90_000 + Math.floor(Math.random() * 1e5),
      cae: String(71_000_000_000_000 + Math.floor(Math.random() * 1e9)),
      issueDate: '2031-05-20',
      caeExpiresOn: '2031-05-30',
      totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
      lines: lines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
      replacesInvoiceId: replaces,
      ...extra,
    };
  }

  it('answers conflict while an attempt is working on the invoice, and changes nothing', async () => {
    const { charge, created } = await requested();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const attempt = world.inTenant(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${'afip-invoice|' + created.id}, 0))`,
      );
      held();
      await released;
    });
    await holding;

    const response = await world.api.post(
      '/invoices/manual',
      world.admin,
      await replaceBody(charge, created.id),
    );
    release();
    await attempt;

    expect(response.statusCode, response.body).toBe(409);
    expect(problem(response).code).toBe('conflict');
    expect((await world.rowOf(created.id)).status).toBe('pending');
  });

  it('is refused while the request may have been answered, until the authority is reconciled', async () => {
    const { charge, created, t0 } = await requested();
    world.issuer.setMode('timeout_after_authorize');
    await world.runIssue(after(t0, 0));
    expect(await world.rowOf(created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
    });

    const response = await world.api.post(
      '/invoices/manual',
      world.admin,
      await replaceBody(charge, created.id),
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(problem(response).code).toBe('invoice_awaiting_reconciliation');
    expect((await world.rowOf(created.id)).status).toBe('pending');
    await sweepOf(created.id, after(t0, 1));
  });

  it('is refused when the voucher does not cover the lines of the invoice it replaces', async () => {
    const first = await requested();
    const other = await world.charge();

    const response = await world.api.post(
      '/invoices/manual',
      world.admin,
      await replaceBody(other, first.created.id),
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(problem(response).code).toBe('invoice_replacement_mismatch');
    expect((await world.rowOf(first.created.id)).status).toBe('pending');
  });

  it('records a voucher that arrives for an invoice somebody closed meanwhile, instead of saying it was issued', async () => {
    const { created, t0 } = await requested();
    const original = world.issuer.issue.bind(world.issuer);
    const errors: Record<string, unknown>[] = [];
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
          .where(eq(invoiceTable.id, created.id)),
      );
      return original(request, key);
    });

    try {
      const job = createAfipIssueJob({
        ...world.issueDeps(after(t0, 0)),
        log: { error: (object) => errors.push(object) },
      });
      const queued = world.recorded.jobs.find(
        (entry) => entry.name === 'afip.issue' && entry.payload['invoiceId'] === created.id,
      );
      if (!queued) throw new Error('no job');
      queued.done = true;
      await runJob(runtime.db, job, {
        id: queued.id,
        name: queued.name,
        data: queued.payload,
        enqueuedAt: new Date(),
        retryCount: 0,
      });
    } finally {
      issue.mockRestore();
    }

    const authorized = vouchersOf(created.id)[0];
    expect(authorized).toBeDefined();
    expect((await world.rowOf(created.id)).status).toBe('rejected');
    const [entry] = (await auditRows('invoice.voucher_orphaned')).filter(
      (row) => row.resourceId === created.id,
    );
    expect(entry?.metadata).toMatchObject({ number: authorized?.number, cae: authorized?.cae });
    expect(await attentionItems(created.id)).toHaveLength(1);
    expect(errors).toEqual([
      expect.objectContaining({ number: authorized?.number, cae: authorized?.cae }),
    ]);
    // The log line carries the voucher and never a message.
    expect(Object.keys(errors[0] ?? {})).not.toContain('message');
  });
});

describe('the audit of the attempts (JD-S4 R1-A-W6)', () => {
  it('records each attempt that ended without an answer, with its number and whether the outcome is unknown, and the charges of the invoice', async () => {
    const { charge, created, t0 } = await requested();
    world.issuer.setMode('down');
    await world.runIssue(after(t0, 0));
    world.issuer.setMode('timeout_after_authorize');
    await sweepOf(created.id, after(t0, 5));
    world.issuer.setMode('ok');
    await sweepOf(created.id, after(t0, 20));

    const attempts = (await auditRows('invoice.attempted'))
      .filter((row) => row.resourceId === created.id)
      .reverse();
    const issuedEntry = (await auditRows('invoice.issued')).find(
      (row) => row.resourceId === created.id,
    );
    const requestedEntry = (await auditRows('invoice.requested')).find(
      (row) => row.resourceId === created.id,
    );

    expect(attempts.map((row) => row.metadata)).toEqual([
      expect.objectContaining({ attempt: 1, unknown: false, chargeIds: [charge.id] }),
      expect.objectContaining({ attempt: 2, unknown: true, chargeIds: [charge.id] }),
    ]);
    expect(JSON.stringify(attempts.map((row) => row.metadata))).not.toMatch(/message/i);
    expect(issuedEntry?.metadata).toMatchObject({ chargeIds: [charge.id] });
    expect(requestedEntry?.metadata).toMatchObject({ chargeIds: [charge.id] });
  });
});
