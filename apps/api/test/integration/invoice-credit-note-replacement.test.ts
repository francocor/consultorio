import type { InvoiceDto, Problem } from '@consultorio/contracts';
import { describe, expect, it, vi } from 'vitest';

import { auditRows, drain, useWorld } from '../support/invoice-series.js';

/**
 * Judgment day, Stage 4, round 5, suspect B-W2: a credit note that was parked for a person had no way
 * out. The manual voucher could not be a credit note, and the guard of the notes counts every note that
 * is not rejected, so the invoice could neither be credited again nor released. The owner or an admin
 * can now register the credit note made outside the system IN PLACE OF the parked one: the same type,
 * the same voucher it cancels and the same total.
 */

describe('a credit note that needs a person (JD-S4 R5-B-W2)', () => {
  const ctx = useWorld('s4r5-note');
  let numbers = 8000;

  /** An issued invoice and a credit note over it that the authority answered with a number we hold. */
  async function parkedNote() {
    const { world } = ctx;
    await drain(world);
    // A credit note of ours that the authority numbered: the next one is answered with its number.
    const earlier = await world.issueInvoiceOf(await world.charge());
    expect((await world.creditNote(earlier.id)).statusCode).toBe(202);
    await world.runIssue();
    const taken = world.issuer.vouchers().filter((voucher) => voucher.type === 'NCC')[0];
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);
    const noteResponse = await world.creditNote(original.id, { reason: 'Error en la carga' });
    expect(noteResponse.statusCode, noteResponse.body).toBe(202);
    const note = noteResponse.json<InvoiceDto>();
    vi.spyOn(world.issuer, 'issue').mockResolvedValueOnce({
      status: 'issued',
      number: taken?.number ?? 0,
      cae: '70888888888801',
      caeExpiresOn: '2031-06-01',
    });
    await world.runIssue(() => new Date());
    vi.restoreAllMocks();
    expect(await world.rowOf(note.id)).toMatchObject({ deliveryState: 'needs_attention' });
    return { charge, original, note };
  }

  /** The body of a credit note made by hand in place of the parked one. */
  async function bodyFor(
    parked: Awaited<ReturnType<typeof parkedNote>>,
    extra: Record<string, unknown> = {},
  ) {
    const { world } = ctx;
    const lines = (await world.linesOf(parked.charge.id)).filter(
      (line) => line.portion === 'patient',
    );
    numbers += 1;
    return {
      idempotencyKey: `0190b000-0000-7000-8000-${String(numbers).padStart(12, '0')}`,
      type: 'NCC',
      pointOfSale: parked.original.pointOfSale,
      number: numbers,
      cae: String(77_000_000_000_000 + numbers),
      issueDate: '2031-05-20',
      caeExpiresOn: '2031-05-30',
      totalCents: parked.note.totalCents,
      lines: lines.map((line) => ({ chargeLineId: line.id })),
      recipient: { kind: 'patient' },
      replacesInvoiceId: parked.note.id,
      associatedVoucher: {
        type: parked.original.type,
        pointOfSale: parked.original.pointOfSale,
        number: parked.original.number,
      },
      ...extra,
    };
  }

  it('is replaced by a credit note made by hand, which cancels the invoice and releases the lines', async () => {
    const { world } = ctx;
    const parked = await parkedNote();

    const response = await world.api.post('/invoices/manual', world.admin, await bodyFor(parked));

    expect(response.statusCode, response.body).toBe(201);
    const saved = response.json<InvoiceDto>();
    expect(saved).toMatchObject({
      kind: 'credit_note',
      type: 'NCC',
      status: 'manual',
      creditNoteOfId: parked.original.id,
      reason: 'Error en la carga',
      totalCents: parked.note.totalCents,
    });
    expect(await world.rowOf(parked.note.id)).toMatchObject({
      status: 'rejected',
      deliveryState: null,
    });
    // The invoice is credited by the note that exists, and the charge is no longer invoiced.
    expect(await world.getInvoice(parked.original.id)).toMatchObject({
      creditedCents: parked.note.totalCents,
    });
    expect((await world.chargeOf(parked.charge.id)).invoicedCents).toBe(0);
    const [entry] = await auditRows(world, saved.id, 'invoice.manual');
    expect(entry?.metadata).toMatchObject({ type: 'NCC', replacedInvoiceId: parked.note.id });
  });

  it('refuses a credit note of another total, of another voucher, or of another type', async () => {
    const { world } = ctx;
    const parked = await parkedNote();
    const post = async (extra: Record<string, unknown>) =>
      world.api.post('/invoices/manual', world.admin, await bodyFor(parked, extra));

    const total = await post({ totalCents: parked.note.totalCents - 100 });
    const voucher = await post({
      associatedVoucher: {
        type: parked.original.type,
        pointOfSale: parked.original.pointOfSale,
        number: (parked.original.number ?? 0) + 1,
      },
    });
    const type = await post({ type: 'NCA' });

    for (const response of [total, voucher, type]) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json<Problem>().code).toBe('invoice_replacement_mismatch');
    }
    expect(await world.rowOf(parked.note.id)).toMatchObject({ deliveryState: 'needs_attention' });
  });

  it('refuses a credit note that does not replace one, and a voucher that cancels nothing', async () => {
    const { world } = ctx;
    const parked = await parkedNote();
    const body = await bodyFor(parked);
    const without = (key: string) =>
      Object.fromEntries(Object.entries(body).filter(([name]) => name !== key));

    const withoutReplaced = await world.api.post(
      '/invoices/manual',
      world.admin,
      without('replacesInvoiceId'),
    );
    const withoutVoucher = await world.api.post(
      '/invoices/manual',
      world.admin,
      without('associatedVoucher'),
    );
    const invoiceWithVoucher = await world.api.post(
      '/invoices/manual',
      world.admin,
      await bodyFor(parked, { type: 'FC' }),
    );

    for (const response of [withoutReplaced, withoutVoucher, invoiceWithVoucher]) {
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(await world.rowOf(parked.note.id)).toMatchObject({ deliveryState: 'needs_attention' });
  });

  it('does not let reception register it, and does not replace a note that is not parked', async () => {
    const { world } = ctx;
    const parked = await parkedNote();
    const forbidden = await world.api.post(
      '/invoices/manual',
      world.reception,
      await bodyFor(parked),
    );
    expect(forbidden.statusCode, forbidden.body).toBe(403);

    // A note that is still waiting for its turn is not parked: the authority may yet issue it.
    const charge = await world.charge();
    const original = await world.issueInvoiceOf(charge);
    const pending = (await world.creditNote(original.id)).json<InvoiceDto>();
    const other = { charge, original, note: pending };

    const refused = await world.api.post('/invoices/manual', world.admin, await bodyFor(other));

    expect(refused.statusCode, refused.body).toBe(409);
    expect(await world.rowOf(pending.id)).toMatchObject({ status: 'pending' });
  });
});
