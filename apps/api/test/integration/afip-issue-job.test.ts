import { randomUUID } from 'node:crypto';

import type { InvoiceDto, InvoiceListResponse, Problem } from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { fiscalCredential } from '../../src/db/schema/index.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { issuerKeyOf } from '../../src/modules/invoicing/application/issue-attempt.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { generateDevCertificate } from '../../src/testing/dev-afip-certificate.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * The issue job against every simulator mode (S4.11, tasks 4.47, 4.48 and 4.50; design 5.5; spec
 * "AFIP outage handling and no duplicate issuance" and "Read-only tenant and feature control"): an
 * invoice survives an outage and a timeout without ever being issued twice, a pending invoice is
 * flagged by its age and never given a new state, and an invoice requested before a freeze is still
 * submitted.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'afip-issue-job' });
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

/** Asks for an invoice of a new charge, after the invoices other tests left were submitted. */
async function requested() {
  await world.runIssue();
  world.issuer.setMode('ok');
  const charge = await world.charge();
  const created = (await world.invoiceCharge(charge)).json<InvoiceDto>();
  return { charge, created, t0: Date.now() };
}

/**
 * One pass of the sweeper, looking at what happened to one invoice: the invoices other tests of this
 * file left waiting are due too, and the sweeper rightly takes them.
 */
const sweepOf = async (invoiceId: string, clock: () => Date) =>
  (await world.sweep(clock)).filter((result) => result.invoiceId === invoiceId);

/** A clock `minutes` after `base`. */
const after = (base: number, minutes: number) => () => new Date(base + minutes * 60_000);

/** The key the authority sees for an invoice: derived from the organization and the invoice. */
const keyOf = (row: { id: string }) => issuerKeyOf(world.tenant.id, row.id);

const vouchersOf = (key: string) =>
  world.issuer.vouchers().filter((voucher) => voucher.idempotencyKey === key);

describe('an invoice the authority authorizes', () => {
  it('becomes issued with the number, the CAE and its expiry, and the PDF is queued', async () => {
    const { charge, created } = await requested();

    const results = await world.runIssue();

    expect(results).toContainEqual({ name: 'afip.issue', result: { status: 'completed' } });
    const issued = await world.getInvoice(created.id);
    expect(issued).toMatchObject({
      status: 'issued',
      ageMinutes: null,
      outageFlag: false,
      testDocument: true,
    });
    expect(issued.cae).toMatch(/^\d{14}$/);
    expect(issued.number).toBeGreaterThan(0);
    expect(issued.caeExpiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(issued.issuedAt).not.toBeNull();
    const row = await world.rowOf(created.id);
    expect(row).toMatchObject({ deliveryState: null, attempts: 1, nextAttemptAt: null });
    expect(vouchersOf(keyOf(row))).toEqual([
      expect.objectContaining({
        issuerCuit: '20123456786',
        pointOfSale: 1,
        type: 'FC',
        totalCents: 2_000_000,
        number: issued.number,
      }),
    ]);
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(2_000_000);
    expect(await auditRows('invoice.issued')).toEqual(
      expect.arrayContaining([expect.objectContaining({ resourceId: created.id })]),
    );
    expect(
      world.recorded.jobs.filter(
        (job) => job.name === 'invoice.pdf' && job.payload['invoiceId'] === created.id,
      ),
    ).toHaveLength(1);
  });

  it('numbers the invoices in sequence for the point of sale and the type', async () => {
    const first = await world.issueInvoiceOf(await world.charge());
    const second = await world.issueInvoiceOf(await world.charge());

    expect(second.number).toBe((first.number ?? 0) + 1);
  });

  it('continues after the vouchers the organization holds when the issuer lost its memory (a restart of the demo fake)', async () => {
    const before = await world.issueInvoiceOf(await world.charge());
    const held = await world.inTenant((tx) =>
      tx.execute<{ highest: number }>(
        sql`SELECT max(number)::int AS highest FROM invoice WHERE type = 'FC' AND point_of_sale = 1`,
      ),
    );

    // The in-memory fake forgets its numbering, as it does when the process restarts.
    world.issuer.reset();
    const after = await world.issueInvoiceOf(await world.charge());

    expect(held.rows[0]?.highest).toBe(before.number);
    expect(after.status).toBe('issued');
    expect(after.number).toBe((before.number ?? 0) + 1);
  });

  it('is asked once however many times the job is delivered, even at the same moment', async () => {
    const { created } = await requested();
    const job = world.issueJob();
    const data = { tenantId: world.tenant.id, invoiceId: created.id };
    const delivery = () =>
      runJob(runtime.db, job, {
        id: randomUUID(),
        name: 'afip.issue',
        data,
        enqueuedAt: new Date(),
        retryCount: 0,
      });

    await Promise.all([delivery(), delivery(), delivery()]);

    const row = await world.rowOf(created.id);
    expect(row.status).toBe('issued');
    expect(vouchersOf(keyOf(row))).toHaveLength(1);
    expect(row.attempts).toBe(1);
    // Delivered again later, nothing happens.
    await delivery();
    expect(vouchersOf(keyOf(row))).toHaveLength(1);
  });
});

describe('an outage of the authority (mode down)', () => {
  it('keeps the invoice pending, shows only its age, and issues it once the service recovers', async () => {
    const { charge, created, t0 } = await requested();
    world.issuer.setMode('down');

    await world.runIssue(after(t0, 0));

    const waiting = await world.getInvoice(created.id);
    expect(waiting).toMatchObject({
      status: 'pending',
      cae: null,
      number: null,
      outageFlag: false,
    });
    expect(waiting.ageMinutes).toBeGreaterThanOrEqual(0);
    expect(Object.keys(waiting)).not.toContain('deliveryState');
    const waitingRow = await world.rowOf(created.id);
    expect(vouchersOf(keyOf(waitingRow))).toHaveLength(0);
    expect(waitingRow).toMatchObject({ status: 'pending', deliveryState: 'retrying', attempts: 1 });
    // The charge is not released, and nothing about money is blocked.
    expect((await world.chargeOf(charge.id)).invoicedCents).toBe(2_000_000);

    // Not due yet: nothing is tried before the minute is up.
    expect(await sweepOf(created.id, after(t0, 0.5))).toEqual([]);
    // Due, still down: pending again, with a longer wait.
    expect(await sweepOf(created.id, after(t0, 1))).toEqual([
      { invoiceId: created.id, outcome: 'retry' },
    ]);
    expect(await world.rowOf(created.id)).toMatchObject({ attempts: 2, deliveryState: 'retrying' });
    expect(await sweepOf(created.id, after(t0, 2))).toEqual([]);

    // The service is back: the next due attempt issues it.
    world.issuer.setMode('ok');
    expect(await sweepOf(created.id, after(t0, 3))).toEqual([
      { invoiceId: created.id, outcome: 'issued' },
    ]);
    const issued = await world.getInvoice(created.id);
    expect(issued.status).toBe('issued');
    expect(vouchersOf(keyOf(await world.rowOf(created.id)))).toHaveLength(1);
  });

  it('waits 1 minute, then doubles up to 6 hours, and never longer', async () => {
    const { created, t0 } = await requested();
    world.issuer.setMode('down');
    await world.runIssue(after(t0, 0));
    const waits: number[] = [];
    let now = t0;
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const row = await world.rowOf(created.id);
      const due = row.nextAttemptAt?.getTime() ?? 0;
      waits.push(Math.round((due - (row.lastAttemptAt?.getTime() ?? 0)) / 60_000));
      now = due;
      await sweepOf(created.id, () => new Date(now));
    }

    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 360, 360, 360]);
    world.issuer.setMode('ok');
  });

  it('does not block a payment or the cash register while the invoice waits', async () => {
    await world.runIssue();
    const register = await world.openRegister({ locationId: world.norte, by: world.owner });
    const charge = await world.charge();
    await world.invoiceCharge(charge);
    world.issuer.setMode('down');
    await world.runIssue();

    const paid = await world.pay(charge.id, { method: 'transfer', amountCents: 500_000 });

    expect(paid.statusCode, paid.body).toBe(201);
    world.issuer.setMode('ok');
    expect(register.id).toBeTruthy();
  });
});

describe('a timeout after the authority authorized (mode timeout_after_authorize)', () => {
  it('reconciles instead of issuing again: exactly one voucher, adopted by the invoice', async () => {
    const { created, t0 } = await requested();
    world.issuer.setMode('timeout_after_authorize');

    await world.runIssue(after(t0, 0));

    const row = await world.rowOf(created.id);
    expect(row).toMatchObject({
      status: 'pending',
      deliveryState: 'awaiting_reconciliation',
      attempts: 1,
    });
    expect(row.expectedNumber).toBeGreaterThan(0);
    expect(vouchersOf(keyOf(row))).toHaveLength(1);
    const authorized = vouchersOf(keyOf(row))[0];

    const outcome = await sweepOf(created.id, after(t0, 1));

    expect(outcome).toEqual([{ invoiceId: created.id, outcome: 'issued' }]);
    const issued = await world.getInvoice(created.id);
    expect(issued).toMatchObject({
      status: 'issued',
      number: authorized?.number,
      cae: authorized?.cae,
    });
    expect(vouchersOf(keyOf(row))).toHaveLength(1);
  });

  it('asks the authority first and sends nothing while it does not answer', async () => {
    const { created, t0 } = await requested();
    world.issuer.setMode('timeout_after_authorize');
    await world.runIssue(after(t0, 0));
    const key = keyOf(await world.rowOf(created.id));
    const issue = vi.spyOn(world.issuer, 'issue');
    world.issuer.setMode('down');

    try {
      const outcome = await sweepOf(created.id, after(t0, 1));

      expect(outcome).toEqual([{ invoiceId: created.id, outcome: 'retry' }]);
      expect(issue).not.toHaveBeenCalled();
      expect(await world.rowOf(created.id)).toMatchObject({
        status: 'pending',
        deliveryState: 'awaiting_reconciliation',
        attempts: 2,
      });

      world.issuer.setMode('ok');
      const recovered = await sweepOf(created.id, after(t0, 4));
      expect(recovered).toEqual([{ invoiceId: created.id, outcome: 'issued' }]);
      expect(vouchersOf(key)).toHaveLength(1);
    } finally {
      issue.mockRestore();
    }
  });
});

describe('a rejection (mode reject_next)', () => {
  it('ends the invoice as rejected with the message, and nobody tries it again', async () => {
    const { created, t0 } = await requested();
    world.issuer.setMode('reject_next');

    await world.runIssue(after(t0, 0));

    expect(await world.getInvoice(created.id)).toMatchObject({ status: 'rejected', cae: null });
    expect(await world.rowOf(created.id)).toMatchObject({
      status: 'rejected',
      deliveryState: null,
      nextAttemptAt: null,
    });
    expect(await sweepOf(created.id, after(t0, 600))).toEqual([]);
  });
});

describe('what keeps an invoice waiting without sending it', () => {
  it('waits while the certificate is expired, and sends once it is renewed', async () => {
    const { created, t0 } = await requested();
    const made = generateDevCertificate({
      cuit: '20123456786',
      validDays: 365,
      algorithm: 'ec',
    });
    const uploaded = await world.api.put('/invoicing/credentials', world.owner, {
      certificate: made.certificate,
      privateKey: made.privateKey,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const expire = (expired: boolean) =>
      world.inTenant((tx) =>
        tx.execute(
          expired
            ? sql`UPDATE fiscal_credential SET not_after = now() - interval '1 day', not_before = now() - interval '400 days' WHERE active`
            : sql`UPDATE fiscal_credential SET not_after = now() + interval '300 days', not_before = now() - interval '60 days' WHERE active`,
        ),
      );
    await expire(true);
    try {
      await world.runIssue(after(t0, 0));

      const waiting = await world.rowOf(created.id);
      expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
      expect(vouchersOf(keyOf(waiting))).toHaveLength(0);
    } finally {
      await expire(false);
    }

    expect(await sweepOf(created.id, after(t0, 1))).toEqual([
      { invoiceId: created.id, outcome: 'issued' },
    ]);
    await world.inTenant((tx) =>
      tx.update(fiscalCredential).set({ active: false, replacedAt: new Date() }),
    );
  });

  it('still submits what was requested when e-invoicing is switched off afterwards', async () => {
    const { created } = await requested();
    await world.switchEinvoicing(false);
    try {
      await world.runIssue();
    } finally {
      await world.switchEinvoicing(true);
    }

    expect((await world.getInvoice(created.id)).status).toBe('issued');
  });
});

describe('a prolonged outage (task 4.48)', () => {
  const admin = () => {
    const client = new pg.Client({ connectionString: inject('adminUrl') });
    return client;
  };

  /** Makes the invoice older, the way waiting does: no screen and no route can do it. */
  async function makeOlder(invoiceId: string, hours: number) {
    const client = admin();
    await client.connect();
    try {
      await client.query("SET session_replication_role = 'replica'");
      await client.query(
        `UPDATE invoice SET created_at = created_at - make_interval(hours => $2) WHERE id = $1`,
        [invoiceId, hours],
      );
    } finally {
      await client.end();
    }
  }

  const pendingList = async (query = 'status=pending') =>
    (await world.api.get(`/invoices?${query}`, world.owner)).json<InvoiceListResponse>();

  it('flags a pending invoice from the threshold on, by its age, without giving it a state', async () => {
    const { created } = await requested();
    world.issuer.setMode('down');
    await world.runIssue();
    world.issuer.setMode('ok');

    await makeOlder(created.id, 23);
    const before = (await pendingList()).invoices.find((entry) => entry.id === created.id);
    await makeOlder(created.id, 2);
    const flagged = (await pendingList()).invoices.find((entry) => entry.id === created.id);

    expect(before).toMatchObject({ status: 'pending', outageFlag: false });
    expect(before?.ageMinutes).toBeGreaterThanOrEqual(23 * 60);
    expect(flagged).toMatchObject({ status: 'pending', outageFlag: true });
    expect(flagged?.ageMinutes).toBeGreaterThanOrEqual(25 * 60);
    const prolonged = (await pendingList('status=pending&prolonged=true')).invoices;
    expect(prolonged.map((entry) => entry.id)).toContain(created.id);
    expect(prolonged.every((entry) => entry.outageFlag)).toBe(true);
    const fresh = (await pendingList('status=pending&prolonged=false')).invoices;
    expect(fresh.map((entry) => entry.id)).not.toContain(created.id);
  });

  it('lists the pending ones oldest first, with the threshold of the organization', async () => {
    await world.runIssue();
    world.issuer.setMode('down');
    const olderCharge = await world.charge();
    const older = (await world.invoiceCharge(olderCharge)).json<InvoiceDto>();
    const newerCharge = await world.charge();
    const newer = (await world.invoiceCharge(newerCharge)).json<InvoiceDto>();
    await makeOlder(older.id, 3);

    const list = await pendingList();

    const ids = list.invoices.map((entry) => entry.id);
    expect(ids.indexOf(older.id)).toBeLessThan(ids.indexOf(newer.id));
    expect(list.outageThresholdHours).toBe(24);
    world.issuer.setMode('ok');
    await world.runIssue();
  });

  it('follows the threshold the organization sets', async () => {
    const { created } = await requested();
    world.issuer.setMode('down');
    await world.runIssue();
    world.issuer.setMode('ok');
    await makeOlder(created.id, 3);
    const set = await world.api.patch('/settings', world.owner, {
      invoicing: { outageThresholdHours: 2 },
    });
    expect(set.statusCode, set.body).toBe(200);
    try {
      const list = await pendingList();

      expect(list.outageThresholdHours).toBe(2);
      expect(list.invoices.find((entry) => entry.id === created.id)?.outageFlag).toBe(true);
    } finally {
      await world.api.patch('/settings', world.owner, { invoicing: { outageThresholdHours: 24 } });
    }
  });
});

describe('an organization that is read-only (task 4.50, tenancy "Read-only tenant and its allowlist")', () => {
  const setStatus = (status: 'active' | 'read_only') =>
    world.inTenant((tx) =>
      tx
        .update(tenantTable)
        .set(
          status === 'read_only'
            ? { status, readOnlySince: new Date() }
            : { status, readOnlySince: null },
        )
        .where(eq(tenantTable.id, world.tenant.id)),
    );

  it('still submits an invoice that was queued before the freeze, to issued', async () => {
    const { created } = await requested();
    const queuedAt = new Date(Date.now() - 60_000);
    await setStatus('read_only');
    try {
      const result = await runJob(runtime.db, world.issueJob(), {
        id: randomUUID(),
        name: 'afip.issue',
        data: { tenantId: world.tenant.id, invoiceId: created.id },
        enqueuedAt: queuedAt,
        retryCount: 0,
      });

      expect(result).toEqual({ status: 'completed' });
      expect((await world.getInvoice(created.id)).status).toBe('issued');
    } finally {
      await setStatus('active');
    }
  });

  it('still ends a queued invoice as rejected when the authority rejects it', async () => {
    const { created } = await requested();
    world.issuer.setMode('reject_next');
    await setStatus('read_only');
    try {
      await runJob(runtime.db, world.issueJob(), {
        id: randomUUID(),
        name: 'afip.issue',
        data: { tenantId: world.tenant.id, invoiceId: created.id },
        enqueuedAt: new Date(Date.now() - 60_000),
        retryCount: 0,
      });

      expect((await world.getInvoice(created.id)).status).toBe('rejected');
    } finally {
      await setStatus('active');
    }
  });

  it('does not run a job queued after the freeze', async () => {
    const { created } = await requested();
    await setStatus('read_only');
    try {
      const result = await runJob(runtime.db, world.issueJob(), {
        id: randomUUID(),
        name: 'afip.issue',
        data: { tenantId: world.tenant.id, invoiceId: created.id },
        enqueuedAt: new Date(Date.now() + 60_000),
        retryCount: 0,
      });

      expect(result).toEqual({ status: 'cancelled', reason: 'tenant_read_only' });
      expect((await world.getInvoice(created.id)).status).toBe('pending');
    } finally {
      await setStatus('active');
    }
  });

  it('keeps retrying an invoice requested before the freeze, through the sweeper, across the freeze', async () => {
    const { created, t0 } = await requested();
    world.issuer.setMode('down');
    await world.runIssue(after(t0, 0));
    await setStatus('read_only');
    try {
      world.issuer.setMode('ok');
      const outcome = await sweepOf(created.id, after(t0, 1));

      expect(outcome).toEqual([{ invoiceId: created.id, outcome: 'issued' }]);
    } finally {
      await setStatus('active');
    }
  });

  it('refuses a new invoice and a new credit note with 402, and keeps existing invoices readable', async () => {
    const issued = await world.issueInvoiceOf(await world.charge());
    const charge = await world.charge();
    await setStatus('read_only');
    try {
      const created = await world.invoiceCharge(charge);
      const note = await world.creditNote(issued.id);
      const read = await world.api.get(`/invoices/${issued.id}`, world.reception);
      const list = await world.api.get('/invoices', world.reception);

      expect(created.statusCode).toBe(402);
      expect(problem(created).code).toBe('tenant_read_only');
      expect(note.statusCode).toBe(402);
      expect(problem(note).code).toBe('tenant_read_only');
      expect(read.statusCode).toBe(200);
      expect(list.statusCode).toBe(200);
    } finally {
      await setStatus('active');
    }
    expect((await world.invoiceCharge(charge)).statusCode).toBe(202);
  });
});
