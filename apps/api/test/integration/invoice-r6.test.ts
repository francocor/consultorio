import type { WorklistResponse } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { nextCuit } from '../../src/adapters/invoice-issuer.contract.js';
import { invoice as invoiceTable } from '../../src/db/schema/index.js';
import { recordStrayVoucher } from '../../src/modules/invoicing/application/stray-vouchers.js';
import { createWorklistService } from '../../src/modules/scheduling/index.js';
import {
  DNI,
  after,
  auditRows,
  authorityLast,
  create,
  drain,
  issueOutOfBand,
  markAwaiting,
  openItems,
  realAuthority,
  replaceWithManual,
  strayRows,
  useWorld,
} from '../support/invoice-series.js';

/**
 * Judgment day, Stage 4, round 6: the bookkeeping around the pin and the settle time (R6-2, R6-3) and
 * the suspects that reproduced (A-S1, B-S, B-W2, B-T2). The authority of these tests is not idempotent
 * by key, like the real one.
 */

describe('the wait does not restart at every resend (JD-S4 R6-2)', () => {
  const ctx = useWorld('s4r6-since');

  it('keeps the moment the wait began across resend cycles, so two hours open the stall item', async () => {
    const { world } = ctx;
    await drain(world);
    const blocker = await create(world, DNI);
    const held = await create(world);
    world.issuer.setIdempotent(false);
    const t0 = Date.now();
    // The request is lost on the way each time: it is sent, and the authority never issues it.
    world.issuer.holdNext();
    await ctx.runIssueWith(
      blocker.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.dropHeld();
    expect(await world.rowOf(blocker.created.id)).toMatchObject({ awaitingSince: new Date(t0) });

    // Past the settle time each pass nothing is found and the request goes out again.
    for (const minute of [12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132]) {
      world.issuer.holdNext();
      await world.sweep(after(t0, minute));
      world.issuer.dropHeld();
      expect(await world.rowOf(blocker.created.id)).toMatchObject({
        awaitingSince: new Date(t0),
        lastSentAt: new Date(t0 + minute * 60_000),
      });
    }

    const items = await openItems(world, blocker.created.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toMatchObject({ reason: 'outcome_unknown' });
    expect((await world.rowOf(held.created.id)).status).toBe('pending');
  });
});

describe('a voucher that sits at a number remembered for another invoice (JD-S4 R6-3, B-W2)', () => {
  const ctx = useWorld('s4r6-stray');

  it('closes the item of the replaced invoice when another one is issued there directly', async () => {
    const { world } = ctx;
    await drain(world);
    realAuthority(world);
    const a = await create(world);
    const floor = await authorityLast(world, a.created.id);
    await markAwaiting(world, a.created.id, floor, Date.now());
    await replaceWithManual(world, a);
    expect(await openItems(world, a.created.id)).toMatchObject([
      { detail: { reason: 'replaced_unresolved' } },
    ]);
    // B is sent fresh, with nothing to reconcile, and the authority gives it that very number.
    const b = await create(world, DNI);
    world.issuer.setIdempotent(false);

    await world.runIssue();

    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
    expect(await openItems(world, a.created.id)).toEqual([]);
    const [adopted] = await auditRows(world, b.created.id, 'invoice.voucher_adopted');
    expect(adopted?.metadata).toMatchObject({ number: floor + 1, strayInvoiceId: a.created.id });
  });

  it('keeps the item of an invoice that is still parked, and tells it the voucher belongs to the other one', async () => {
    const { world } = ctx;
    await drain(world);
    realAuthority(world);
    const a = await create(world);
    const floor = await authorityLast(world, a.created.id);
    // A is parked with its outcome unknown at the number it expected.
    await world.inTenant(async (tx) => {
      await tx
        .update(invoiceTable)
        .set({
          deliveryState: 'needs_attention',
          expectedNumber: floor + 1,
          authorityLastAtMark: floor,
          nextAttemptAt: null,
        })
        .where(eq(invoiceTable.id, a.created.id));
      const [row] = await tx.select().from(invoiceTable).where(eq(invoiceTable.id, a.created.id));
      if (!row) throw new Error('no invoice');
      await recordStrayVoucher(tx, a.created.id, row, floor + 1, 'parked_unknown');
      await createWorklistService({ keys: world.keys }).openItem(tx, {
        kind: 'invoice_attention',
        subjectType: 'invoice',
        subjectId: a.created.id,
        detail: { reason: 'voucher_ambiguous', outcomeUnknown: true, candidates: [floor + 1] },
      });
    });
    const b = await create(world, DNI);
    world.issuer.setIdempotent(false);

    await world.runIssue();

    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
    // A still needs a person, and its item now says why the number is not its own.
    expect(await world.rowOf(a.created.id)).toMatchObject({ deliveryState: 'needs_attention' });
    expect(await openItems(world, a.created.id)).toMatchObject([
      {
        status: 'open',
        detail: {
          reason: 'voucher_taken_by_other',
          number: floor + 1,
          otherInvoiceId: b.created.id,
          outcomeUnknown: true,
        },
      },
    ]);
    expect(
      (await strayRows(world)).filter((stray) => stray.invoiceId === a.created.id),
    ).toHaveLength(1);
  });
});

describe('a lookup that lags, answers about another number or refuses (JD-S4 R6-A-S1, B-S)', () => {
  const ctx = useWorld('s4r6-lookup');

  /** An invoice that waits, with an authority that says it issued one more number than it holds. */
  async function waitingWithAGhostNumber() {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    vi.spyOn(world.issuer, 'lastAuthorized').mockResolvedValue({ status: 'ok', number: floor + 1 });
    const issue = vi.spyOn(world.issuer, 'issue');
    return { world, b, floor, t0, issue };
  }

  it('asks again three times before it takes a missing voucher for an answer that does not add up', async () => {
    const { world, b, t0, issue } = await waitingWithAGhostNumber();

    for (const [round, minute] of [10, 20, 30].entries()) {
      const results = await world.sweep(after(t0, minute));
      expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'retry' });
      expect(await world.rowOf(b.created.id)).toMatchObject({
        deliveryState: 'awaiting_reconciliation',
        lookupMisses: round + 1,
      });
    }
    const results = await world.sweep(after(t0, 40));

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    expect(issue).not.toHaveBeenCalled();
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'voucher_ambiguous', outcomeUnknown: true });
    expect(await world.rowOf(b.created.id)).toMatchObject({ lookupMisses: 0 });
  });

  it('parks, and sends nothing, when the answer is about another number than the one asked', async () => {
    const { world, b, floor, t0, issue } = await waitingWithAGhostNumber();
    vi.spyOn(world.issuer, 'findIssued').mockResolvedValue({
      status: 'issued',
      number: floor + 7,
      cae: '71111111111111',
      caeExpiresOn: '2031-06-01',
      totalCents: 2_000_000,
      issueDate: '2031-05-20',
    });

    const results = await world.sweep(after(t0, 10));

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    expect(issue).not.toHaveBeenCalled();
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({
      reason: 'voucher_ambiguous',
      candidates: [floor + 1],
    });
  });
});

describe('an authority that refuses the question for good (JD-S4 R6-B-S)', () => {
  const ctx = useWorld('s4r6-refuses');

  const refusal = { status: 'rejected', message: 'token not valid' } as const;
  const items = async (invoiceId: string) => {
    const { world } = ctx;
    return (await world.api.get('/worklist?kind=invoice_attention&status=open', world.admin))
      .json<WorklistResponse>()
      .items.filter((item) => item.subjectId === invoiceId);
  };

  it('opens one item after two hours of waiting, with its own reason, though nothing is held behind it', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    vi.spyOn(world.issuer, 'lastAuthorized').mockResolvedValue(refusal);

    await world.sweep(after(t0, 5));
    expect(await items(b.created.id)).toHaveLength(0);
    await world.sweep(after(t0, 125));
    await world.sweep(after(t0, 131));

    const [item] = await items(b.created.id);
    expect(item?.detail).toMatchObject({ reason: 'authority_refuses_lookup' });
    expect(await items(b.created.id)).toHaveLength(1);
  });

  it('opens one item after eight attempts of an invoice that was never sent, because the question cannot be asked', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    vi.spyOn(world.issuer, 'lastAuthorized').mockResolvedValue(refusal);
    const issue = vi.spyOn(world.issuer, 'issue');
    const t0 = Date.now();

    for (let attempt = 1; attempt <= 7; attempt += 1) {
      await world.sweep(after(t0, attempt * 400));
    }
    expect(await items(b.created.id)).toHaveLength(0);
    await world.sweep(after(t0, 8 * 400));

    const [item] = await items(b.created.id);
    expect(item?.detail).toMatchObject({ reason: 'authority_refuses_lookup' });
    expect(issue).not.toHaveBeenCalled();
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'pending' });
  });
});

describe('a series whose numbering went back (JD-S4 R6 cosmetic)', () => {
  const ctx = useWorld('s4r6-behind');

  it('says the two numbers instead of an empty range', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, 500, t0);

    await world.sweep(after(t0, 1));

    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({
      reason: 'voucher_ambiguous',
      lastAtMark: 500,
      lastNow: expect.any(Number) as number,
    });
    expect(parked?.metadata).not.toHaveProperty('candidatesFrom');
    expect(parked?.metadata).not.toHaveProperty('candidatesTo');
  });
});

describe('the window of an invoice replaced without knowing (JD-S4 R6-B-T2)', () => {
  const ctx = useWorld('s4r6-window');

  it('names, in the item, where the authority was when the request went out', async () => {
    const { world } = ctx;
    await drain(world);
    const a = await create(world);
    const floor = await authorityLast(world, a.created.id);
    await markAwaiting(world, a.created.id, floor, Date.now());

    await replaceWithManual(world, a);

    const [item] = await openItems(world, a.created.id);
    expect(item?.detail).toMatchObject({
      reason: 'replaced_unresolved',
      expectedNumber: floor + 1,
      candidatesFrom: floor + 1,
    });
  });
});

describe('a voucher whose recipient reads differently (JD-S4 R6-6)', () => {
  const ctx = useWorld('s4r6-buyer');

  it('parks the invoice instead of taking its own voucher for a foreign one and sending it again', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    // The authority holds a voucher with the total, the date and the issuer of the invoice, and a buyer
    // document where the invoice has none: only the recipient is not the same.
    await issueOutOfBand(world, { invoiceId: b.created.id, document: DNI }, 'reads-differently');
    issue.mockClear();

    const results = await world.sweep(after(t0, 11));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({
      reason: 'voucher_ambiguous',
      outcomeUnknown: true,
      candidates: [floor + 1],
    });
    expect((await strayRows(world)).filter((stray) => stray.invoiceId === b.created.id)).toEqual(
      [],
    );
  });
});

describe('a CUIT changed once invoices went through the point of sale (JD-S4 R6-B-T1)', () => {
  const ctx = useWorld('s4r6-cuit');

  it('is not blocked, and a number the authority repeats for the new CUIT parks the invoice with a person alerted: nothing is recorded twice', async () => {
    const { world } = ctx;
    await drain(world);
    const profile = (await world.api.get('/invoicing/config', world.owner)).json<{
      profile: { cuit: string; businessName: string; address: string; activityStartedOn: string };
    }>().profile;
    const put = (cuit: string) =>
      world.api.put('/invoicing/profile', world.owner, {
        cuit,
        taxCondition: 'monotributo',
        businessName: profile.businessName,
        address: profile.address,
        activityStartedOn: profile.activityStartedOn,
      });
    const first = await world.issueInvoiceOf(await world.charge());
    try {
      // The change is accepted: the invoices keep the issuer they were requested with (JD-S4 R1-C7), and
      // a point of sale belongs to one CUIT only on the website of the authority, not here.
      expect((await put(nextCuit())).statusCode).toBe(200);
      const other = await create(world);

      // The authority numbers the new CUIT from 1, a number the organization already holds.
      await world.runIssue();

      expect(await world.rowOf(other.created.id)).toMatchObject({
        status: 'pending',
        deliveryState: 'needs_attention',
      });
      const [parked] = await auditRows(world, other.created.id, 'invoice.needs_attention');
      expect(parked?.metadata).toMatchObject({ reason: 'number_taken', number: 1 });
      expect(await world.rowOf(first.id)).toMatchObject({ status: 'issued', number: first.number });
    } finally {
      await put(profile.cuit);
    }
  });
});

describe('a manual credit note always names the invoice it cancels (JD-S4 R6-A-S3)', () => {
  const ctx = useWorld('s4r6-note-check');

  it('has no way to be stored without it: the check ties the two for every status', async () => {
    const { world } = ctx;
    const [definition] = (
      await world.inTenant((tx) =>
        tx.execute<{ definition: string }>(
          sql`select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'invoice_credit_note_check'`,
        ),
      )
    ).rows;
    // Both directions, whatever the status: a note has an invoice, and an invoice has no note.
    expect(definition?.definition).toMatch(
      /type.*NCA.*NCB.*NCC.*= \(credit_note_of_id IS NOT NULL\)/,
    );
  });
});
