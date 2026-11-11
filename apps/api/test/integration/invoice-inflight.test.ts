import { describe, expect, it } from 'vitest';

import {
  DNI,
  after,
  authorityLast,
  create,
  drain,
  realAuthority,
  unpinnedAuthority,
  useWorld,
  vouchersOf,
} from '../support/invoice-series.js';

/**
 * Judgment day, Stage 4, round 6: finding R6-1. A request that the caller gave up on (a timeout, a
 * process that died) may still be being processed by the authority, and finish AFTER the lookup. Sending
 * again then issues two vouchers for one invoice. Two guards stand against it:
 *
 * - the pin: a request is for ONE number (`expectedNumber`) and the authority refuses it when that is
 *   not the next one, so of two requests for the same number only one can win;
 * - the settle time: "nothing was issued" is believed only after enough time has passed since the
 *   request was sent (defence in depth for an authority that does not pin).
 *
 * The authority of these tests is NOT idempotent by key, like the real one.
 */

const SETTLE_MINUTES = 10;

describe('a request that finishes after the lookup (JD-S4 R6-1)', () => {
  const ctx = useWorld('s4r6-inflight');

  it('is not sent again before the settle time, whatever the authority says, and is adopted once it appears', async () => {
    const { world } = ctx;
    await drain(world);
    // An authority that does not pin: only the settle time protects the invoice.
    const issue = unpinnedAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    world.issuer.holdNext();
    const t0 = Date.now();
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    expect(issue).toHaveBeenCalledTimes(1);
    expect(vouchersOf(world, b.created.id)).toHaveLength(0);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
      authorityLastAtMark: floor,
      expectedNumber: floor + 1,
      lastSentAt: new Date(t0),
    });

    // The sweeper looks a minute later: the voucher is not there yet, and nothing is sent.
    expect(await world.sweep(after(t0, 1))).toEqual([
      { invoiceId: b.created.id, outcome: 'retry' },
    ]);
    expect(issue).toHaveBeenCalledTimes(1);
    issue.mockClear();

    // The request finishes at the authority after the caller looked.
    await world.issuer.releaseHeld();
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);

    const results = await world.sweep(after(t0, SETTLE_MINUTES + 1));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
  });

  it('keeps asking, and sends nothing, for as long as the settle time lasts; then sends once', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = unpinnedAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    // The request never reaches the authority (it was lost on the way).
    world.issuer.holdNext();
    const t0 = Date.now();
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.dropHeld();
    issue.mockClear();

    for (const minute of [1, 3, 7]) {
      const results = await world.sweep(after(t0, minute));
      expect(results).toEqual([{ invoiceId: b.created.id, outcome: 'retry' }]);
    }
    expect(issue).not.toHaveBeenCalled();
    expect(await world.rowOf(b.created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
      lastSentAt: new Date(t0),
    });

    const results = await world.sweep(after(t0, SETTLE_MINUTES + 3));

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
  });

  it('cannot create a second voucher when it is sent again and the first request finishes late (the pin)', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    world.issuer.holdNext();
    const t0 = Date.now();
    await ctx.runIssueWith(b.created.id, {
      ...world.issueDeps(() => new Date(t0)),
      settleMs: 0,
    });
    expect(vouchersOf(world, b.created.id)).toHaveLength(0);
    issue.mockClear();

    // A setting without a settle time: the invoice is sent again at once, the first request still in flight.
    const results = await world.sweep(after(t0, 1), { settleMs: 0 });
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(issue.mock.calls[0]?.[0]).toMatchObject({ expectedNumber: floor + 1 });
    // The late request reaches the authority: the number is taken, it is refused and issues nothing.
    const late = await world.issuer.releaseHeld();

    expect(late).toEqual([expect.objectContaining({ status: 'not_next' })]);
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
  });

  it('adopts the voucher of the first request when the second one is refused, instead of sending a third (the pin)', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    world.issuer.holdNext();
    const t0 = Date.now();
    await ctx.runIssueWith(b.created.id, {
      ...world.issueDeps(() => new Date(t0)),
      settleMs: 0,
    });
    // The first request finishes between the lookup of the sweeper and its own request: the lookup
    // found nothing, the number is taken when the second request arrives.
    const original = world.issuer.lastAuthorized.bind(world.issuer);
    let looked = false;
    world.issuer.lastAuthorized = async (series) => {
      const answer = await original(series);
      if (!looked) {
        looked = true;
        await world.issuer.releaseHeld();
      }
      return answer;
    };
    issue.mockClear();

    const results = await world.sweep(after(t0, 1), { settleMs: 0 });

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
    // The second request was sent (the lookup had found nothing), refused, and the lookup that followed
    // found the voucher of the first one.
    expect(issue).toHaveBeenCalledTimes(1);
  });
});

describe('a crash between the mark and the call (JD-S4 R6-1)', () => {
  const ctx = useWorld('s4r6-crash');

  it('leaves the mark with the time it was sent, and the invoice is only asked about, never sent, before the settle time', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    // The process dies after the mark was committed and before the request goes out.
    issue.mockImplementation(() => {
      throw new Error('the process died');
    });
    const t0 = Date.now();
    await expect(
      ctx.runIssueWith(
        b.created.id,
        world.issueDeps(() => new Date(t0)),
      ),
    ).rejects.toThrow();
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'awaiting_reconciliation',
      authorityLastAtMark: floor,
      expectedNumber: floor + 1,
      lastSentAt: new Date(t0),
    });
    expect((await world.rowOf(b.created.id)).nextAttemptAt?.getTime()).toBe(t0 + 60_000);
    issue.mockRestore();
    const resumed = realAuthority(world);

    // The sweeper that runs a minute later only asks: it finds nothing, and nothing is sent.
    expect(await world.sweep(after(t0, 1))).toEqual([
      { invoiceId: b.created.id, outcome: 'retry' },
    ]);
    expect(resumed).not.toHaveBeenCalled();
    expect(vouchersOf(world, b.created.id)).toHaveLength(0);

    // After the settle time the authority has been asked, found nothing, and the invoice is sent once.
    const results = await world.sweep(after(t0, SETTLE_MINUTES + 1));

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
  });
});
