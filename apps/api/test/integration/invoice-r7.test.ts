import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { invoice as invoiceTable } from '../../src/db/schema/index.js';
import {
  DNI,
  MINUTE,
  after,
  auditRows,
  authorityLast,
  create,
  drain,
  issueOutOfBand,
  markAwaiting,
  openItems,
  realAuthority,
  strayRows,
  unpinnedAuthority,
  useWorld,
  vouchersOf,
} from '../support/invoice-series.js';

/**
 * Judgment day, Stage 4, round 7: a refusal the numbering does not explain (R7-1), the candidate of a
 * lookup under an authority that carries the pin (R7-2), the moment of the send (R7-3), a legacy row that
 * never settles (R7-4), a lookup that is refused for good (R7-5), and the suspects that reproduced.
 * The authority of these tests is not idempotent by key, like the real one.
 */

/** The requests of invoices that were sent: the ones pinned to a number (a voucher made out of band is not). */
const sentBy = (issue: { mock: { calls: unknown[][] } }) =>
  issue.mock.calls.filter(
    ([request]) => (request as { expectedNumber?: number }).expectedNumber !== undefined,
  ).length;

describe('a refusal that the numbering does not explain (JD-S4 R7-1)', () => {
  const ctx = useWorld('s4r7-refusal');

  it('parks the invoice after three refusals while the last number stays put, with a reason of its own', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    world.issuer.setIdempotent(false);
    // ARCA error 10016 also covers a date earlier than the last authorized voucher: nothing moves.
    world.issuer.setDateTrap(true);
    const t0 = Date.now();

    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    expect(issue).toHaveBeenCalledTimes(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'awaiting_reconciliation',
      refusedNotNext: 1,
    });

    // A minute later it is only asked about: the settle time has not passed, nothing is sent.
    await world.sweep(after(t0, 1));
    expect(issue).toHaveBeenCalledTimes(1);
    expect((await world.rowOf(b.created.id)).refusedNotNext).toBe(1);

    await world.sweep(after(t0, 11));
    expect(issue).toHaveBeenCalledTimes(2);
    expect((await world.rowOf(b.created.id)).refusedNotNext).toBe(2);

    const results = await world.sweep(after(t0, 22));

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    expect(issue).toHaveBeenCalledTimes(3);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'needs_attention',
      refusedNotNext: 0,
      expectedNumber: null,
    });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({
      reason: 'authority_refuses_number',
      outcomeUnknown: false,
    });
    expect(await openItems(world, b.created.id)).toMatchObject([
      { detail: { reason: 'authority_refuses_number' } },
    ]);
    expect(vouchersOf(world, b.created.id)).toHaveLength(0);

    // Parked: nothing is sent again.
    await world.sweep(after(t0, 60));
    expect(issue).toHaveBeenCalledTimes(3);
  });

  it('does not count a refusal that the numbering explains: another voucher took the number', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    // A foreign voucher takes the number after the caller asked for the last one.
    const original = world.issuer.lastAuthorized.bind(world.issuer);
    let asked = false;
    vi.spyOn(world.issuer, 'lastAuthorized').mockImplementation(async (series) => {
      const answer = await original(series);
      if (!asked) {
        asked = true;
        await issueOutOfBand(world, { invoiceId: b.created.id, totalCents: 777_00 }, 'foreign-1');
      }
      return answer;
    });
    const t0 = Date.now();

    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );

    expect(sentBy(issue)).toBe(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
      refusedNotNext: 0,
    });

    // After the settle time the pin follows the numbering: the invoice is issued above the foreign one.
    await world.sweep(after(t0, 11));
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'issued',
      number: floor + 2,
    });
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
  });

  it('opens the stall item of an invoice that holds nothing back, after two hours of an unknown outcome', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    world.issuer.setMode('down');

    await world.sweep(after(t0, 5));
    expect(await openItems(world, b.created.id)).toHaveLength(0);
    await world.sweep(after(t0, 125));
    await world.sweep(after(t0, 131));

    const items = await openItems(world, b.created.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toMatchObject({ reason: 'outcome_unknown' });
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'pending' });
  });
});

describe('the candidate of a lookup under an authority that carries the pin (JD-S4 R7-2)', () => {
  const ctx = useWorld('s4r7-pin');

  it('does not adopt a look-alike that sits above the pin: the invoice is sent again with a fresh pin', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    world.issuer.setIdempotent(false);
    // A foreign voucher sits at the pin, and a voucher with the very facts of the invoice sits above it.
    await issueOutOfBand(world, { invoiceId: b.created.id, totalCents: 777_00 }, 'foreign');
    await issueOutOfBand(world, { invoiceId: b.created.id, document: DNI }, 'look-alike');
    issue.mockClear();

    const results = await world.sweep(after(t0, 11));

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(issue.mock.calls[0]?.[0]).toMatchObject({ expectedNumber: floor + 3 });
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 3 });
    expect((await strayRows(world)).map((stray) => stray.number)).toContain(floor + 1);
  });

  it('is not parked by a busy foreign issuer: more than twenty vouchers after the mark', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    world.issuer.setIdempotent(false);
    for (let n = 1; n <= 25; n += 1) {
      await issueOutOfBand(
        world,
        { invoiceId: b.created.id, totalCents: 500_00 + n },
        `busy-${String(n)}`,
      );
    }
    issue.mockClear();

    const results = await world.sweep(after(t0, 11));

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'issued',
      number: floor + 26,
    });
  });

  it('adopts the voucher at the pin when it is the invoice own', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    world.issuer.setIdempotent(false);
    await issueOutOfBand(world, { invoiceId: b.created.id, document: DNI }, 'its-own');
    issue.mockClear();

    await world.sweep(after(t0, 11));

    expect(issue).not.toHaveBeenCalled();
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
  });

  it('still examines the whole window under an authority that does not carry the pin', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = unpinnedAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    world.issuer.setIdempotent(false);
    await issueOutOfBand(world, { invoiceId: b.created.id, totalCents: 777_00 }, 'foreign');
    await issueOutOfBand(world, { invoiceId: b.created.id, document: DNI }, 'its-own');
    issue.mockClear();

    await world.sweep(after(t0, 11));

    expect(issue).not.toHaveBeenCalled();
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 2 });
  });
});

describe('the settle time starts at the send (JD-S4 R7-3, R7-4)', () => {
  const ctx = useWorld('s4r7-settle');

  it('stamps the moment of the send, not the moment the attempt began', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    world.issuer.setIdempotent(false);
    const t0 = Date.now();
    let now = t0;
    // The question of the last number is slow: four minutes go by before the request is sent.
    const original = world.issuer.lastAuthorized.bind(world.issuer);
    vi.spyOn(world.issuer, 'lastAuthorized').mockImplementation(async (series) => {
      const answer = await original(series);
      now += 4 * MINUTE;
      return answer;
    });
    world.issuer.holdNext();

    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(now)),
    );

    const row = await world.rowOf(b.created.id);
    expect(row.lastSentAt).toEqual(new Date(t0 + 4 * MINUTE));
  });

  it('settles a legacy row without the moment of the send from the moment its wait began, not from its last look', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    // A row marked before the moment of the send was kept: the column is empty.
    await world.inTenant((tx) =>
      tx.update(invoiceTable).set({ lastSentAt: null }).where(eq(invoiceTable.id, b.created.id)),
    );

    // Every look rewrites the last attempt; none of them may restart the settle time.
    for (const minute of [1, 3, 7]) {
      await world.sweep(after(t0, minute));
    }
    expect(issue).not.toHaveBeenCalled();

    const results = await world.sweep(after(t0, 11));

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(issue).toHaveBeenCalledTimes(1);
  });
});

describe('a lookup that the authority refuses for good, at a voucher (JD-S4 R7-5)', () => {
  const ctx = useWorld('s4r7-lookup');

  it('opens the item of a refused lookup after two hours, not the generic one', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    vi.spyOn(world.issuer, 'lastAuthorized').mockResolvedValue({ status: 'ok', number: floor + 1 });
    vi.spyOn(world.issuer, 'findIssued').mockResolvedValue({
      status: 'rejected',
      message: 'token not valid',
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.sweep(after(t0, 5));
    expect(await openItems(world, b.created.id)).toHaveLength(0);
    await world.sweep(after(t0, 125));
    await world.sweep(after(t0, 131));

    const items = await openItems(world, b.created.id);
    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toMatchObject({ reason: 'authority_refuses_lookup' });
    expect(issue).not.toHaveBeenCalled();
  });
});

describe('a rejection of a request sent again (JD-S4 R7 suspect B-T4)', () => {
  const ctx = useWorld('s4r7-rejected');

  it('looks once more before it closes the invoice: the first request may have landed meanwhile', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    world.issuer.holdNext();
    const t0 = Date.now();
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    // The first request lands between the lookup of the sweeper and its own request, which is rejected.
    const original = world.issuer.lastAuthorized.bind(world.issuer);
    let looked = false;
    vi.spyOn(world.issuer, 'lastAuthorized').mockImplementation(async (series) => {
      const answer = await original(series);
      if (!looked) {
        looked = true;
        await world.issuer.releaseHeld();
        world.issuer.setMode('reject_next');
      }
      return answer;
    });
    issue.mockClear();

    const results = await world.sweep(after(t0, 11));

    expect(issue).toHaveBeenCalledTimes(1);
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
  });
});

describe('an answer at a number that was not asked for (JD-S4 R7 suspect B-S2)', () => {
  const ctx = useWorld('s4r7-pin-lie');

  it('parks the invoice when an authority that says it carries the pin answers another number', async () => {
    const { world } = ctx;
    await drain(world);
    const original = world.issuer.issue.bind(world.issuer);
    // It says it carries the pin and does not: a foreign voucher took the number in between.
    const issue = vi.spyOn(world.issuer, 'issue').mockImplementation(async (request, key) => {
      const asked = { ...request };
      delete asked.expectedNumber;
      return original(asked, key);
    });
    const b = await create(world, DNI);
    world.issuer.setIdempotent(false);
    const lastAuthorized = world.issuer.lastAuthorized.bind(world.issuer);
    let asked = false;
    vi.spyOn(world.issuer, 'lastAuthorized').mockImplementation(async (series) => {
      const answer = await lastAuthorized(series);
      if (!asked) {
        asked = true;
        await issueOutOfBand(world, { invoiceId: b.created.id, totalCents: 777_00 }, 'foreign');
      }
      return answer;
    });

    await world.runIssue();

    expect(sentBy(issue)).toBe(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'needs_attention',
    });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'pin_not_honoured' });
    // The voucher exists: nobody may take it for theirs.
    expect((await strayRows(world)).map((stray) => stray.invoiceId)).toContain(b.created.id);
  });
});

describe('a number the organization already holds (JD-S4 R7 suspects B-S3, A-S2)', () => {
  const ctx = useWorld('s4r7-taken');

  it('parks the invoice without sending when the authority would give a number that is recorded', async () => {
    const { world } = ctx;
    await drain(world);
    const issued = await world.issueInvoiceOf(await world.charge());
    expect(issued.number).toBeGreaterThan(0);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    // The numbering of the authority starts again (a reset of the simulator).
    world.issuer.reset();
    issue.mockClear();

    await world.runIssue();

    expect(issue).not.toHaveBeenCalled();
    expect(world.issuer.vouchers()).toHaveLength(0);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'needs_attention',
    });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'number_taken', outcomeUnknown: false });
  });
});

describe('the lookup misses in a row (JD-S4 R7 suspect A-S1)', () => {
  const ctx = useWorld('s4r7-misses');

  it('counts only the misses that follow each other: a clean answer in between starts the count again', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    const last = vi
      .spyOn(world.issuer, 'lastAuthorized')
      .mockResolvedValue({ status: 'ok', number: floor + 1 });
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.sweep(after(t0, 10));
    expect((await world.rowOf(b.created.id)).lookupMisses).toBe(1);
    // The authority does not answer once.
    last.mockResolvedValueOnce({ status: 'retryable', message: 'down', outcomeUnknown: false });
    await world.sweep(after(t0, 20));
    expect((await world.rowOf(b.created.id)).lookupMisses).toBe(0);
    for (const [round, minute] of [30, 40, 50].entries()) {
      const results = await world.sweep(after(t0, minute));
      expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'retry' });
      expect((await world.rowOf(b.created.id)).lookupMisses).toBe(round + 1);
    }

    const results = await world.sweep(after(t0, 60));
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    expect(issue).not.toHaveBeenCalled();
  });
});
