import { describe, expect, it, vi } from 'vitest';

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
  replaceWithManual,
  strayRows,
  useWorld,
  vouchersOf,
} from '../support/invoice-series.js';

/**
 * Judgment day, Stage 4, rounds 4 and 5: findings R4-3 (a parked invoice does not leave its voucher
 * unknown) and the suspect B-T4 (a lock timeout that is not a finite number). R4-1 (an unconfirmed
 * stray opened a silent double issue) is gone with the inference that caused it: an invoice that waits
 * is reconciled with the last number the AUTHORITY says (`invoice-authority-count.test.ts`).
 *
 * The issuer of these tests is NOT idempotent by key, like the real authority: a request sent twice
 * shows as two vouchers.
 */

describe('a number remembered where nothing may have been issued (JD-S4 R4-1, R5-1)', () => {
  const ctx = useWorld('strays-r4-ghost');

  it('sends once for the next invoice when the voucher there is the one of the invoice that was replaced', async () => {
    const { world } = ctx;
    await drain(world);
    // The first invoice WAS issued (its answer was lost), then it was replaced by hand.
    const first = await create(world);
    const t0 = Date.now();
    world.issuer.setMode('timeout_after_authorize');
    await ctx.runIssueWith(
      first.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    const ghost = vouchersOf(world, first.created.id)[0];
    expect(ghost).toBeDefined();
    await replaceWithManual(world, first);
    // The second one is sent after it: the authority's count already includes the voucher of the first.
    const second = await create(world, DNI);
    world.issuer.setIdempotent(false);
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.runIssue(() => new Date(t0 + 10 * MINUTE));

    expect(issue).toHaveBeenCalledTimes(1);
    expect(vouchersOf(world, second.created.id).map((voucher) => voucher.number)).toEqual([
      (ghost?.number ?? 0) + 1,
    ]);
    expect(await world.rowOf(second.created.id)).toMatchObject({
      status: 'issued',
      number: (ghost?.number ?? 0) + 1,
    });
  });
});

describe('a parked invoice remembers the vouchers it knows of (JD-S4 R4-3, R5-1)', () => {
  const ctx = useWorld('strays-r4-parked');

  it('remembers the foreign voucher it passes while it looks for its own, so nobody takes it for theirs', async () => {
    const { world } = ctx;
    await drain(world);
    const first = await create(world);
    const floor = await authorityLast(world, first.created.id);
    const t0 = Date.now();
    await markAwaiting(world, first.created.id, floor, t0);
    // Somebody else issued a voucher at the number the first invoice expects, for another amount.
    const foreign = await issueOutOfBand(
      world,
      { invoiceId: first.created.id, totalCents: 99_000 },
      `foreign-${String(floor + 1)}`,
    );
    expect(foreign.number).toBe(floor + 1);
    world.issuer.setIdempotent(false);

    await world.sweep(after(t0, 11));

    // Its own request was not answered: it was sent, and it got the number after the foreign one.
    expect(await world.rowOf(first.created.id)).toMatchObject({
      status: 'issued',
      number: floor + 2,
    });
    const remembered = (await strayRows(world)).filter(
      (stray) => stray.invoiceId === first.created.id,
    );
    expect(remembered).toMatchObject([{ number: floor + 1, reason: 'unmatched' }]);
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
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'cae_taken' });
    const remembered = (await strayRows(world)).filter((stray) => stray.invoiceId === b.created.id);
    expect(remembered).toMatchObject([{ number, reason: 'unmatched' }]);
  });
});

describe('the lock timeout of the mark (JD-S4 R4-B-T4)', () => {
  const ctx = useWorld('strays-r4-timeout');

  it('uses the default for a value that is not a finite number, instead of failing the attempt', async () => {
    const { world } = ctx;
    await drain(world);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { created } = await create(world);

      await ctx.runIssueWith(created.id, { ...world.issueDeps(), markLockTimeoutMs: bad });

      expect(await world.rowOf(created.id), String(bad)).toMatchObject({ status: 'issued' });
    }
  });
});
