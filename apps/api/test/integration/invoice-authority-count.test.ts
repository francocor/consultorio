import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { nextCuit } from '../../src/adapters/invoice-issuer.contract.js';
import { invoice as invoiceTable } from '../../src/db/schema/index.js';
import { invoiceNumbersHeldBy } from '../../src/main/wiring/invoicing.js';
import {
  DNI,
  after,
  auditRows,
  authorityLast,
  create,
  cuitOf,
  drain,
  issueOutOfBand,
  markAwaiting,
  openItems,
  realAuthority,
  registerManualVoucher,
  replaceWithManual,
  strayRows,
  useWorld,
  withoutPin,
  vouchersOf,
} from '../support/invoice-series.js';

/**
 * Judgment day, Stage 4, round 5: finding R5-1 (the number the authority was at was INFERRED from the
 * vouchers recorded here, so a manual voucher registered out of band, or a mistyped high number, made
 * an invoice send again) and R5-2 (the number expected was asked about before the lower ones).
 *
 * The invoice that waits is reconciled with the AUTHORITY's own count: the last number it had
 * authorized when the invoice was marked, and the last one it has now. Every number in between is
 * examined, lowest first, before anything is sent.
 */

describe('a voucher registered by hand in the same series while an invoice waits (JD-S4 R5-1)', () => {
  const ctx = useWorld('s4r5-manual');

  it('adopts its own voucher instead of sending again', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    // An invoice replaced by hand without knowing: its number is remembered, and nothing was ever issued.
    const a = await create(world);
    const floor = await authorityLast(world, a.created.id);
    await markAwaiting(world, a.created.id, floor, Date.now());
    await replaceWithManual(world, a);
    // B is sent and the authority gives it that very number, but the answer is lost.
    const b = await create(world, DNI);
    const t0 = Date.now();
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    expect(vouchersOf(world, b.created.id).map((voucher) => voucher.number)).toEqual([floor + 1]);
    // Staff register a voucher they made on the website of the authority, the next number of the SAME
    // point of sale and type.
    const theirs = await issueOutOfBand(world, { invoiceId: a.created.id }, 'by-hand-1');
    expect(theirs.number).toBe(floor + 2);
    await registerManualVoucher(world, { number: theirs.number, cae: theirs.cae });
    issue.mockClear();

    await world.sweep(after(t0, 10));

    expect(issue).not.toHaveBeenCalled();
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
  });

  it('is not misled by a mistyped high number', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    await registerManualVoucher(world, { number: floor + 1000 });
    const t0 = Date.now();
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    expect(vouchersOf(world, b.created.id).map((voucher) => voucher.number)).toEqual([floor + 1]);
    issue.mockClear();

    await world.sweep(after(t0, 10));

    expect(issue).not.toHaveBeenCalled();
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
  });

  it('does not take for recorded a number whose manual record names another voucher: it parks instead of sending', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    // The voucher of B sits at floor + 1. Somebody typed the number of ANOTHER voucher as that one.
    await issueOutOfBand(world, { invoiceId: b.created.id, document: DNI }, 'own-voucher');
    await registerManualVoucher(world, { number: floor + 1 });
    issue.mockClear();

    const results = await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'voucher_ambiguous', outcomeUnknown: true });
  });
});

describe('the lowest number goes first (JD-S4 R5-2)', () => {
  const ctx = useWorld('s4r5-order');

  it('parks, and sends nothing, when a look-alike above its own voucher fits as well (JD-S4 R6-4)', async () => {
    const { world } = ctx;
    await drain(world);
    // An issuer that does not carry the pin: the whole window is examined (JD-S4 R7-2).
    withoutPin(world);
    const issue = realAuthority(world);
    const a = await create(world);
    const floor = await authorityLast(world, a.created.id);
    await markAwaiting(world, a.created.id, floor, Date.now());
    await replaceWithManual(world, a);
    const b = await create(world, DNI);
    const t0 = Date.now();
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    // Somebody else issues a voucher with the facts of B right after its own.
    const lookAlike = await issueOutOfBand(
      world,
      { invoiceId: b.created.id, document: DNI },
      'look-alike',
    );
    expect(lookAlike.number).toBe(floor + 2);
    issue.mockClear();

    const results = await world.sweep(after(t0, 10));

    // Two vouchers fit: the lowest does not win just because it is the lowest. A person decides.
    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'needs_attention',
    });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({
      reason: 'voucher_ambiguous',
      outcomeUnknown: true,
      candidates: [floor + 1, floor + 2],
    });
  });

  it('remembers the foreign vouchers it passes on the way, and then adopts its own', async () => {
    const { world } = ctx;
    await drain(world);
    // An issuer that does not carry the pin: the whole window is examined (JD-S4 R7-2).
    withoutPin(world);
    const issue = realAuthority(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    // The authority serves somebody else first, then B's request.
    const foreign = await issueOutOfBand(
      world,
      { invoiceId: b.created.id, totalCents: 99_000 },
      'foreign',
    );
    const own = await issueOutOfBand(
      world,
      { invoiceId: b.created.id, document: DNI },
      'own-voucher',
    );
    expect([foreign.number, own.number]).toEqual([floor + 1, floor + 2]);
    issue.mockClear();

    await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 2 });
    expect(
      (await strayRows(world)).filter((stray) => stray.number === foreign.number),
    ).toMatchObject([{ reason: 'unmatched', invoiceId: b.created.id }]);
  });

  it('parks, and sends nothing, when the voucher fits both the invoice and one replaced without knowing', async () => {
    const { world } = ctx;
    await drain(world);
    const issue = realAuthority(world);
    const a = await create(world);
    const floor = await authorityLast(world, a.created.id);
    await markAwaiting(world, a.created.id, floor, Date.now());
    await replaceWithManual(world, a);
    // The same anonymous consumer with the same fee on the same day: the voucher cannot be told apart.
    const b = await create(world);
    const t0 = Date.now();
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');
    issue.mockClear();

    const results = await world.sweep(after(t0, 10));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'needs_attention',
    });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({
      reason: 'voucher_ambiguous',
      outcomeUnknown: true,
      candidates: [floor + 1],
    });
    const [item] = await openItems(world, b.created.id);
    expect(item?.detail).toMatchObject({
      reason: 'voucher_ambiguous',
      outcomeUnknown: true,
      candidates: [floor + 1],
    });
  });
});

describe('what the authority says decides whether to send (JD-S4 R5-1)', () => {
  const ctx = useWorld('s4r5-send');

  it('sends once, with a new mark, when the authority has issued nothing since the mark', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    world.issuer.setIdempotent(false);
    const issue = vi.spyOn(world.issuer, 'issue');

    // Sent only once the settle time since the mark has passed (JD-S4 R6-1).
    await world.sweep(after(t0, 11));

    expect(issue).toHaveBeenCalledTimes(1);
    expect(vouchersOf(world, b.created.id)).toHaveLength(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'issued',
      number: floor + 1,
      authorityLastAtMark: null,
      expectedNumber: null,
    });
  });

  it('writes the last number of the authority with the mark, before it sends', async () => {
    const { world } = ctx;
    await drain(world);
    const issued = await world.issueInvoiceOf(await world.charge());
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    expect(floor).toBeGreaterThanOrEqual(issued.number ?? 1);
    world.issuer.setMode('timeout_after_authorize');
    const t0 = Date.now();
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');

    expect(await world.rowOf(b.created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
      authorityLastAtMark: floor,
      expectedNumber: floor + 1,
      awaitingSince: new Date(t0),
    });
  });

  it('keeps the first last number of the wait while the authority cannot be reached', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    await issueOutOfBand(world, { invoiceId: b.created.id }, 'foreign-1');
    world.issuer.setMode('down');

    await world.sweep(after(t0, 1));
    world.issuer.setMode('ok');

    expect(await world.rowOf(b.created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
      authorityLastAtMark: floor,
      expectedNumber: floor + 1,
    });
  });

  it('does not send while the authority cannot say its last number', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    vi.spyOn(world.issuer, 'lastAuthorized').mockResolvedValue({
      status: 'retryable',
      message: 'unreachable',
      outcomeUnknown: true,
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    const results = await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'retry' });
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'awaiting_reconciliation',
      authorityLastAtMark: floor,
    });
  });

  it('does not send either when the authority refuses the question', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    vi.spyOn(world.issuer, 'lastAuthorized').mockResolvedValue({
      status: 'rejected',
      message: 'token',
    });
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(await world.rowOf(b.created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
    });
  });

  it('does not send a first request when the authority cannot say its last number, and marks nothing', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    vi.spyOn(world.issuer, 'lastAuthorized').mockRejectedValue(new Error('socket hang up'));
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.runIssue(after(Date.now(), 0));

    expect(issue).not.toHaveBeenCalled();
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'pending',
      deliveryState: 'retrying',
      expectedNumber: null,
      authorityLastAtMark: null,
    });
  });

  it('does not send while a voucher in between cannot be looked up', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    await issueOutOfBand(world, { invoiceId: b.created.id, totalCents: 99_000 }, 'foreign-a');
    await issueOutOfBand(world, { invoiceId: b.created.id, totalCents: 98_000 }, 'foreign-b');
    const original = world.issuer.findIssued.bind(world.issuer);
    vi.spyOn(world.issuer, 'findIssued').mockImplementation((ref) =>
      ref.number === floor + 2
        ? Promise.resolve({ status: 'retryable', message: 'down', outcomeUnknown: true })
        : original(ref),
    );
    const issue = vi.spyOn(world.issuer, 'issue');

    const results = await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'retry' });
    expect(await world.rowOf(b.created.id)).toMatchObject({
      deliveryState: 'awaiting_reconciliation',
      authorityLastAtMark: floor,
    });
  });

  it('parks an invoice marked before the column existed, and sends nothing', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    await world.inTenant((tx) =>
      tx
        .update(invoiceTable)
        .set({ authorityLastAtMark: null })
        .where(eq(invoiceTable.id, b.created.id)),
    );
    const issue = vi.spyOn(world.issuer, 'issue');

    const results = await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({ reason: 'voucher_ambiguous', outcomeUnknown: true });
  });

  it('parks when the authority is behind the number it had at the mark', async () => {
    const { world } = ctx;
    await drain(world);
    const b = await create(world, DNI);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, 500, t0);
    const issue = vi.spyOn(world.issuer, 'issue');

    const results = await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
  });
});

describe('how many numbers are examined (JD-S4 R5-1)', () => {
  const ctx = useWorld('s4r5-bound');

  async function foreignVouchers(count: number, invoiceId: string) {
    for (let at = 0; at < count; at += 1) {
      await issueOutOfBand(
        ctx.world,
        { invoiceId, totalCents: 10_000 + at },
        `foreign-${String(at)}-${String(Date.now())}`,
      );
    }
  }

  it('parks an invoice when more than 20 numbers could be its own, and sends nothing', async () => {
    const { world } = ctx;
    await drain(world);
    // An issuer that does not carry the pin: the whole window is examined (JD-S4 R7-2).
    withoutPin(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    await foreignVouchers(21, b.created.id);
    const probe = vi.spyOn(world.issuer, 'findIssued');
    const issue = vi.spyOn(world.issuer, 'issue');

    const results = await world.sweep(after(t0, 1));

    expect(issue).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(results).toContainEqual({ invoiceId: b.created.id, outcome: 'attention' });
    const [parked] = await auditRows(world, b.created.id, 'invoice.needs_attention');
    expect(parked?.metadata).toMatchObject({
      reason: 'voucher_ambiguous',
      outcomeUnknown: true,
      candidatesFrom: floor + 1,
      candidatesTo: floor + 21,
    });
  });

  it('examines 20 numbers, and sends once when none is its own', async () => {
    const { world } = ctx;
    await drain(world);
    // An issuer that does not carry the pin: the whole window is examined (JD-S4 R7-2).
    withoutPin(world);
    const b = await create(world, DNI);
    const floor = await authorityLast(world, b.created.id);
    const t0 = Date.now();
    await markAwaiting(world, b.created.id, floor, t0);
    await foreignVouchers(20, b.created.id);
    world.issuer.setIdempotent(false);
    const probe = vi.spyOn(world.issuer, 'findIssued');
    const issue = vi.spyOn(world.issuer, 'issue');

    await world.sweep(after(t0, 11));

    expect(probe).toHaveBeenCalledTimes(20);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(await world.rowOf(b.created.id)).toMatchObject({
      status: 'issued',
      number: floor + 21,
    });
  });
});

describe('a voucher adopted at a number remembered for another invoice (JD-S4 R5-A-F5)', () => {
  const ctx = useWorld('s4r5-adopted');

  it('closes the item that told a person to cancel it, and audits both invoices', async () => {
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
    const b = await create(world, DNI);
    const t0 = Date.now();
    world.issuer.setIdempotent(false);
    world.issuer.setMode('timeout_after_authorize');
    await ctx.runIssueWith(
      b.created.id,
      world.issueDeps(() => new Date(t0)),
    );
    world.issuer.setMode('ok');

    await world.sweep(after(t0, 10));

    expect(await world.rowOf(b.created.id)).toMatchObject({ status: 'issued', number: floor + 1 });
    expect(await openItems(world, a.created.id)).toEqual([]);
    const [adopted] = await auditRows(world, b.created.id, 'invoice.voucher_adopted');
    expect(adopted?.metadata).toMatchObject({
      number: floor + 1,
      strayInvoiceId: a.created.id,
    });
  });
});

describe('the series of the authority is the one of the issuer (JD-S4 R5-B-T2)', () => {
  const ctx = useWorld('s4r5-issuer');

  it('lets a simulator that rebuilds its memory number past every number recorded for the point of sale and type, whatever the CUIT: the unique index does not know it', async () => {
    const { world } = ctx;
    await drain(world);
    // Another CUIT is another series for the authority, which starts again at 1: the in-memory simulator
    // learns from the invoices what the organization holds (the real authority has no such need).
    world.issuer.rememberFrom(invoiceNumbersHeldBy(ctx.db));
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
    // Two vouchers are recorded under the CUIT of the profile.
    const first = await world.issueInvoiceOf(await world.charge());
    const second = await world.issueInvoiceOf(await world.charge());
    expect(second.number).toBe((first.number ?? 0) + 1);
    try {
      expect((await put(nextCuit())).statusCode).toBe(200);
      const other = await create(world);

      await world.sweep(after(Date.now(), 1));

      expect(await world.rowOf(other.created.id)).toMatchObject({ status: 'issued' });
      expect((await world.rowOf(other.created.id)).number).toBeGreaterThan(second.number ?? 0);
    } finally {
      world.issuer.rememberFrom(undefined);
      await put(profile.cuit);
    }
  });

  it('does not hold back an invoice of another issuer CUIT behind one that waits', async () => {
    const { world } = ctx;
    await drain(world);
    world.issuer.rememberFrom(invoiceNumbersHeldBy(ctx.db));
    const waiting = await create(world, DNI);
    const t0 = Date.now();
    await markAwaiting(
      world,
      waiting.created.id,
      await authorityLast(world, waiting.created.id),
      t0,
    );
    const cuit = await cuitOf(world, waiting.created.id);
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
    const original = {
      lastAuthorized: world.issuer.lastAuthorized.bind(world.issuer),
      findIssued: world.issuer.findIssued.bind(world.issuer),
    };
    try {
      expect((await put(nextCuit())).statusCode).toBe(200);
      const other = await create(world);
      world.issuer.setIdempotent(false);
      // The authority cannot be asked about the series of the first CUIT, and only about it.
      vi.spyOn(world.issuer, 'lastAuthorized').mockImplementation((ref) =>
        ref.issuerCuit === cuit
          ? Promise.resolve({ status: 'retryable', message: 'down', outcomeUnknown: true })
          : original.lastAuthorized(ref),
      );
      vi.spyOn(world.issuer, 'findIssued').mockImplementation((ref) =>
        ref.issuerCuit === cuit
          ? Promise.resolve({ status: 'retryable', message: 'down', outcomeUnknown: true })
          : original.findIssued(ref),
      );

      const results = await world.sweep(after(t0, 1));

      expect(results).toContainEqual({ invoiceId: other.created.id, outcome: 'issued' });
      expect(await world.rowOf(waiting.created.id)).toMatchObject({
        deliveryState: 'awaiting_reconciliation',
      });
    } finally {
      world.issuer.rememberFrom(undefined);
      await put(profile.cuit);
    }
  });
});
