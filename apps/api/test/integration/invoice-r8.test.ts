import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { invoice as invoiceTable } from '../../src/db/schema/index.js';
import {
  DNI,
  MINUTE,
  authorityLast,
  create,
  drain,
  issueOutOfBand,
  markAwaiting,
  realAuthority,
  replaceWithManual,
  useWorld,
  vouchersOf,
} from '../support/invoice-series.js';

/**
 * Judgment day, Stage 4, round 8: the last look before a rejected re-send is closed does not wait for the
 * settle time of the request it just made (R8-1); a voucher found after a refused FIRST send is foreign
 * (A-2); a manual replacement ends the streak of refusals as well. The clocks of the first tests move, as
 * a real one does: since R7-3 the send is stamped later than the start of the attempt.
 */

describe('the last look before a rejection closes the invoice (JD-S4 R8-1)', () => {
  const ctx = useWorld('s4r8-last-look');

  it.each([
    { name: 'a clock that stands still', step: 0 },
    { name: 'a clock that moves between the start of the attempt and the send', step: 1000 },
  ])('closes an invoice whose re-send is rejected: $name', async ({ step }) => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    const t0 = Date.now();
    // Awaiting, with nothing issued: the request of the mark was lost for good.
    await markAwaiting(world, b.created.id, floor, t0);
    issue.mockClear();
    world.issuer.setMode('reject_next');
    // Every read of the clock is a little later than the one before, like a real clock.
    let ticks = 0;
    const clock = () => new Date(t0 + 11 * MINUTE + ticks++ * step);

    const results = await world.sweep(clock);

    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'rejected' });
    expect(issue).toHaveBeenCalledTimes(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'rejected',
      deliveryState: null,
      nextAttemptAt: null,
      expectedNumber: null,
      lastSentAt: null,
    });
    expect(vouchersOf(world, b.created.id)).toHaveLength(0);
    // Its lines are free: another invoice can be asked for the same charge.
    const again = await world.invoiceCharge(b.charge, { recipient: { kind: 'patient' } });
    expect(again.statusCode, again.body).toBe(202);
  });

  it('still adopts the voucher of the first request that landed meanwhile, with a moving clock', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    world.issuer.setIdempotent(false);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    // The first request lands after the lookup of the sweeper, before its own request, which is rejected.
    const original = world.issuer.lastAuthorized.bind(world.issuer);
    let looked = false;
    const asked = vi.spyOn(world.issuer, 'lastAuthorized').mockImplementation(async (series) => {
      const answer = await original(series);
      if (!looked) {
        looked = true;
        await issueOutOfBand(world, { invoiceId: b.created.id, document: DNI }, 'its-own');
        world.issuer.setMode('reject_next');
      }
      return answer;
    });
    issue.mockClear();
    let ticks = 0;

    const results = await world.sweep(() => new Date(t0 + 11 * MINUTE + ticks++ * 1000));

    expect(asked).toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'issued' });
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
  });
});

describe('a voucher found after a refused first send (JD-S4 R8 A-2)', () => {
  const ctx = useWorld('s4r8-first-send');

  it('is foreign by construction: the invoice is parked, never given a voucher that looks like it', async () => {
    const { world } = ctx;
    await drain(world);
    realAuthority(world);
    const b = await create(world, DNI);
    world.issuer.setIdempotent(false);
    // A voucher with the very facts of the invoice takes the number after the caller asked for the last one.
    const original = world.issuer.lastAuthorized.bind(world.issuer);
    let asked = false;
    vi.spyOn(world.issuer, 'lastAuthorized').mockImplementation(async (series) => {
      const answer = await original(series);
      if (!asked) {
        asked = true;
        await issueOutOfBand(world, { invoiceId: b.created.id, document: DNI }, 'look-alike');
      }
      return answer;
    });
    const t0 = Date.now();

    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );

    const row = await world.rowOf(b.created.id);
    expect(row).toMatchObject({ status: 'pending', deliveryState: 'needs_attention' });
    expect(row.number).toBeNull();
    expect(vouchersOf(world, b.created.id)).toHaveLength(0);
  });
});

describe('a manual replacement of an invoice that was refused a number (JD-S4 R8 hygiene)', () => {
  const ctx = useWorld('s4r8-replacement');

  it('ends the streak of refusals together with the rest of the wait', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world);
    const floor = await authorityLast(world, b.created.id);
    await markAwaiting(world, b.created.id, floor, Date.now());
    await world.inTenant((tx) =>
      tx.update(invoiceTable).set({ refusedNotNext: 2 }).where(eq(invoiceTable.id, b.created.id)),
    );

    await replaceWithManual(world, b);

    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'rejected',
      refusedNotNext: 0,
    });
  });
});
